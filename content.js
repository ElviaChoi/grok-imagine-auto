(() => {
  if (window.__grokImagineVideoAutomatorLoaded) {
    return;
  }
  window.__grokImagineVideoAutomatorLoaded = true;

  const SESSION_KEY = "grokVideoAutoSession";
  const IMAGINE_URL = "https://grok.com/imagine";
  const DEFAULT_GENERATION = {
    mode: "video",
    resolution: "480p",
    duration: "6s",
    aspectRatio: "16:9"
  };

  const WAIT = {
    page: 90_000,
    upload: 60_000,
    generate: 15 * 60_000,
    upscale: 15 * 60_000,
    afterGenerate: 8_000,
    afterUpscale: 8_000,
    settle: 1_500
  };

  let stopRequested = false;
  let running = false;
  let startRequested = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function storageGet(key) {
    return chrome.storage.local.get(key).then((result) => result[key]);
  }

  function storageSet(key, value) {
    return chrome.storage.local.set({ [key]: value });
  }

  function storageRemove(key) {
    return chrome.storage.local.remove(key);
  }

  async function saveSession(payload, nextIndex, active = true, extra = {}) {
    await storageSet(SESSION_KEY, {
      active,
      nextIndex,
      payload,
      ...extra,
      updatedAt: Date.now()
    });
  }

  async function clearSession() {
    await storageRemove(SESSION_KEY);
  }

  function status(text) {
    console.log(`[Grok Auto] ${text}`);
    chrome.runtime.sendMessage({ type: "GROK_AUTO_STATUS", text }).catch(() => {});
    renderOverlay(text);
  }

  function renderOverlay(text) {
    let box = document.getElementById("grok-auto-overlay");
    if (!box) {
      box = document.createElement("div");
      box.id = "grok-auto-overlay";
      Object.assign(box.style, {
        position: "fixed",
        right: "16px",
        top: "16px",
        zIndex: "2147483647",
        maxWidth: "360px",
        padding: "12px 14px",
        border: "1px solid rgba(255,255,255,.18)",
        borderRadius: "8px",
        color: "#e8ffe8",
        background: "rgba(0, 0, 0, .82)",
        font: "12px/1.45 system-ui, sans-serif",
        whiteSpace: "pre-wrap",
        boxShadow: "0 8px 24px rgba(0,0,0,.28)"
      });
      document.documentElement.appendChild(box);
    }
    box.textContent = text;
  }

  function assertNotStopped() {
    if (stopRequested) {
      throw new Error("User stopped the automation.");
    }
  }

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || 1) !== 0
    );
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y };

    el.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...common, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mouseover", common));
    el.dispatchEvent(new MouseEvent("mouseenter", common));
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.click();
    el.dispatchEvent(new MouseEvent("mouseup", common));
    el.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    return true;
  }

  async function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      assertNotStopped();
      const result = await predicate();
      if (result) return result;
      await sleep(500);
    }
    throw new Error(`${label} timed out.`);
  }

  function allClickables() {
    return [
      ...document.querySelectorAll(
        "button, [role='button'], [role='menuitem'], [data-radix-collection-item], a"
      )
    ].filter(visible);
  }

  function findClickableByTextOrLabel(patterns) {
    const lowered = patterns.map((p) => p.toLowerCase());
    return allClickables().find((button) => {
      const text = normalize(button.innerText || button.textContent);
      const label = normalize(button.getAttribute("aria-label"));
      const title = normalize(button.getAttribute("title"));
      return lowered.some((pattern) => text.includes(pattern) || label.includes(pattern) || title.includes(pattern));
    });
  }

  function findVisibleTextElement(patterns) {
    const lowered = patterns.map((p) => p.toLowerCase());
    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => {
        const text = normalize(el.innerText || el.textContent);
        if (!text) return false;
        return lowered.some((pattern) => text === pattern || text.includes(pattern));
      });

    const leaf = candidates.find((el) => {
      const text = normalize(el.innerText || el.textContent);
      return ![...el.children].some((child) => visible(child) && normalize(child.innerText || child.textContent) === text);
    });
    const el = leaf || candidates[0];
    if (!el) return null;

    return (
      el.closest("button, [role='button'], [role='menuitem'], [data-radix-collection-item], [cmdk-item], a") ||
      el
    );
  }

  function findOpenMoreButton() {
    const exact = [
      ...document.querySelectorAll(
        "button[aria-label='\uCD94\uAC00 \uC635\uC158'], button[aria-label='More options'], button[aria-label='More']"
      )
    ]
      .filter(visible)
      .at(-1);
    if (exact) return exact;

    return findClickableByTextOrLabel(["\uCD94\uAC00 \uC635\uC158", "more options"]);
  }

  function findRadio(groupLabel, optionText) {
    const groups = [...document.querySelectorAll("[role='radiogroup']")];
    const group = groups.find((item) => normalize(item.getAttribute("aria-label")).includes(normalize(groupLabel)));
    if (!group) return null;
    return [...group.querySelectorAll("button, [role='radio']")].find((button) =>
      normalize(button.innerText || button.textContent).includes(normalize(optionText))
    );
  }

  async function ensureImagineHome() {
    if (!location.href.startsWith(IMAGINE_URL)) {
      location.href = IMAGINE_URL;
      await sleep(1500);
    }

    if (/\/imagine\/(?!$|\?)/.test(location.pathname)) {
      location.href = IMAGINE_URL;
      await sleep(1500);
    }

    await waitFor(
      () => document.querySelector("form .ProseMirror[contenteditable='true']"),
      WAIT.page,
      "Imagine input"
    );
  }

  function findRadioAny(groupLabels, optionTexts) {
    const labels = groupLabels.map(normalize);
    const options = optionTexts.map(normalize);
    const groups = [...document.querySelectorAll("form [role='radiogroup'], [role='radiogroup']")];

    for (const group of groups) {
      const groupText = normalize(`${group.getAttribute("aria-label") || ""} ${group.innerText || group.textContent}`);
      const labelMatches = labels.some((label) => groupText.includes(label));
      const radios = [...group.querySelectorAll("button, [role='radio']")];
      const radio = radios.find((button) => {
        const text = normalize(button.innerText || button.textContent);
        return options.some((option) => text.includes(option));
      });

      if (labelMatches && radio) return radio;
    }

    for (const group of groups) {
      const radios = [...group.querySelectorAll("button, [role='radio']")];
      const radio = radios.find((button) => {
        const text = normalize(button.innerText || button.textContent);
        return options.some((option) => text.includes(option));
      });
      if (radio) return radio;
    }

    return null;
  }

  async function chooseRadio(groupLabels, optionTexts, delay = 400) {
    const radio = findRadioAny(groupLabels, optionTexts);
    if (radio && radio.getAttribute("aria-checked") !== "true") {
      click(radio);
      await sleep(delay);
    }
  }

  async function ensureGenerationSettings(settings = DEFAULT_GENERATION) {
    const generation = { ...DEFAULT_GENERATION, ...(settings || {}) };

    await chooseRadio(
      ["\uC0DD\uC131 \uBAA8\uB4DC", "generation mode"],
      generation.mode === "image" ? ["\uC774\uBBF8\uC9C0", "image"] : ["\uBE44\uB514\uC624", "video"],
      500
    );

    await chooseRadio(
      ["\uBE44\uC728", "\uD654\uBA74 \uBE44\uC728", "\uAC00\uB85C\uC138\uB85C \uBE44\uC728", "aspect ratio"],
      [generation.aspectRatio],
      400
    );

    if (generation.mode !== "video") {
      return;
    }

    await chooseRadio(
      ["\uBE44\uB514\uC624 \uD574\uC0C1\uB3C4", "\uD574\uC0C1\uB3C4", "video resolution", "resolution"],
      [generation.resolution],
      400
    );

    await chooseRadio(
      ["\uB3D9\uC601\uC0C1 \uAE38\uC774", "\uBE44\uB514\uC624 \uAE38\uC774", "\uAE38\uC774", "video length", "duration"],
      [generation.duration],
      400
    );
  }

  async function ensureDefaultSettings() {
    await ensureGenerationSettings(DEFAULT_GENERATION);
  }

  function currentImageUrl(previousUrl = "") {
    const images = [...document.querySelectorAll("main img, article img, img")]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          img,
          url: img.currentSrc || img.src || "",
          area: rect.width * rect.height
        };
      })
      .filter((item) => {
        if (!item.url || item.url === previousUrl) return false;
        if (/profile-picture|pfp/i.test(item.url)) return false;
        return /\/generated\/|preview_image|assets\.grok\.com\/users/i.test(item.url);
      })
      .sort((a, b) => b.area - a.area);

    return images[0]?.url || "";
  }

  async function waitForGeneratedImage(previousUrl) {
    const firstUrl = await waitFor(() => currentImageUrl(previousUrl), WAIT.generate, "image generation");
    await sleep(2500);
    await waitFor(() => currentImageUrl(previousUrl) === firstUrl, 30_000, "image stable check");
    status("Image is ready. Waiting briefly before download.");
    await sleep(WAIT.afterGenerate);
    return firstUrl;
  }

  function dataUrlToFile(image) {
    const [meta, base64] = image.dataUrl.split(",");
    const mime = /data:([^;]+)/.exec(meta)?.[1] || image.type || "image/png";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], image.name || "reference.png", { type: mime });
  }

  async function uploadImage(image) {
    const input = await waitFor(
      () =>
        document.querySelector("form input[type='file'][accept*='image']") ||
        document.querySelector("input[type='file'][accept*='image']"),
      WAIT.upload,
      "image upload input"
    );

    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(image));
    input.files = dt.files;
    fire(input, "input");
    fire(input, "change");

    await sleep(1800);
  }

  async function setPrompt(prompt) {
    const editor = await waitFor(
      () => document.querySelector("form .ProseMirror[contenteditable='true']"),
      WAIT.page,
      "prompt editor"
    );
    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, prompt);
    fire(editor, "input");
    await sleep(500);
  }

  async function submitPrompt() {
    const form = document.querySelector("form");
    let submit = form?.querySelector("button[type='submit']:not([disabled])");

    if (!submit) {
      submit = await waitFor(
        () => form?.querySelector("button[type='submit']:not([disabled])"),
        WAIT.upload,
        "enabled submit button"
      );
    }

    click(submit);
  }

  function videoUrl(video) {
    return video?.currentSrc || video?.src || "";
  }

  function playable(video, previousUrl = "") {
    const url = videoUrl(video);
    if (!url || url === previousUrl) return false;
    if (!/generated_video\.mp4|\/generated\/[^/]+\/.*\.mp4/i.test(url)) return false;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;

    const duration = Number(video.duration);
    if (Number.isFinite(duration) && duration > 0 && duration < 5.5) return false;
    return true;
  }

  function currentVideoElement(preferHd = true) {
    const hd = document.querySelector("#hd-video");
    const sd = document.querySelector("#sd-video");
    const hdStyle = hd ? getComputedStyle(hd) : null;

    if (preferHd && hd && videoUrl(hd) && hdStyle?.visibility !== "hidden") return hd;
    if (!preferHd && sd && videoUrl(sd)) return sd;
    if (preferHd && hd && videoUrl(hd)) return hd;
    if (sd && videoUrl(sd)) return sd;

    return [...document.querySelectorAll("video")].find((video) => visible(video) && videoUrl(video)) || null;
  }

  function currentVideoUrl(preferHd = true) {
    return videoUrl(currentVideoElement(preferHd));
  }

  async function waitForStableVideo(preferHd, previousUrl, timeoutMs, label) {
    const video = await waitFor(() => {
      const candidate = currentVideoElement(preferHd);
      return playable(candidate, previousUrl) ? candidate : null;
    }, timeoutMs, label);

    const firstUrl = videoUrl(video);
    await sleep(2500);
    await waitFor(() => {
      const latest = currentVideoElement(preferHd);
      return playable(latest, previousUrl) && videoUrl(latest) === firstUrl ? latest : null;
    }, 30_000, `${label} stable check`);

    return firstUrl;
  }

  async function waitForGeneratedVideo(previousUrl) {
    const url = await waitForStableVideo(false, previousUrl, WAIT.generate, "video generation");
    status("Video is playable. Waiting briefly before upscale.");
    await sleep(WAIT.afterGenerate);
    return url;
  }

  async function tryUpscale() {
    const before = currentVideoUrl(false);
    let button =
      findClickableByTextOrLabel(["\uC5C5\uC2A4\uCF00\uC77C", "upscale", "\uACE0\uD654\uC9C8"]) ||
      findVisibleTextElement(["\uC5C5\uC2A4\uCF00\uC77C", "upscale", "\uACE0\uD654\uC9C8"]);

    if (!button) {
      const more = findOpenMoreButton();
      if (more) {
        status("Opening more options and looking for Upscale...");
        click(more);
        button = await waitFor(
          () =>
            findClickableByTextOrLabel(["\uC5C5\uC2A4\uCF00\uC77C", "upscale", "\uACE0\uD654\uC9C8"]) ||
            findVisibleTextElement(["\uC5C5\uC2A4\uCF00\uC77C", "upscale", "\uACE0\uD654\uC9C8"]),
          10_000,
          "upscale menu item"
        ).catch(() => null);
      }
    }

    if (!button) {
      status("Upscale button was not found. Downloading current SD video.");
      return before;
    }

    status("Clicking Upscale...");
    click(button);
    status("Upscale requested. Waiting for HD video.");

    try {
      const url = await waitForStableVideo(true, before, WAIT.upscale, "upscale");
      status("HD video is ready. Waiting briefly before download.");
      await sleep(WAIT.afterUpscale);
      return url;
    } catch (error) {
      status(`Upscale wait failed: ${error.message}\nDownloading current video.`);
      return currentVideoUrl(false) || before;
    }
  }

  function safeFilePart(value) {
    return (value || "grok-video")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  async function downloadVideo(url, filename) {
    if (!url) {
      throw new Error("Could not find a video URL to download.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "GROK_AUTO_DOWNLOAD",
      url,
      filename
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Chrome download request failed.");
    }
  }

  async function goBackToImagine() {
    const homeLink =
      [...document.querySelectorAll("a[href='/imagine'], a[href='https://grok.com/imagine']")]
        .filter(visible)
        .at(-1) || null;

    if (homeLink) {
      click(homeLink);
    } else {
      location.href = IMAGINE_URL;
    }

    await waitFor(
      () => document.querySelector("form .ProseMirror[contenteditable='true']"),
      WAIT.page,
      "next Imagine page"
    );
    await sleep(WAIT.settle);
  }

  async function runQueue(payload, startAt = 0, resumeState = null) {
    running = true;
    startRequested = false;
    stopRequested = false;

    const { scenes, prefix, startIndex, upscale } = payload;
    const generation = { ...DEFAULT_GENERATION, ...(payload.generation || {}) };

    try {
      for (let i = startAt; i < scenes.length; i += 1) {
        assertNotStopped();
        const state =
          i === startAt && resumeState && resumeState.nextIndex === i
            ? resumeState
            : null;
        let previousUrl = state?.previousUrl || "";
        let phase = state?.phase || "start";

        await saveSession(payload, i, true, { phase, previousUrl });

        const scene = scenes[i];
        const number = startIndex + i;
        const padded = String(number).padStart(2, "0");
        const total = scenes.length;

        if (phase === "submitted") {
          status(`[${i + 1}/${total}] Generation was already submitted. Waiting for result...`);
        } else {
          status(`[${i + 1}/${total}] Preparing Imagine page...`);
          await ensureImagineHome();
          await ensureGenerationSettings(generation);

          previousUrl = generation.mode === "video" ? currentVideoUrl(false) : currentImageUrl();
          await saveSession(payload, i, true, { phase: "editing", previousUrl });

          status(`[${i + 1}/${total}] Uploading scene image...`);
          await uploadImage(scene.image);
          await ensureGenerationSettings(generation);

          status(`[${i + 1}/${total}] Entering prompt and generating...`);
          await setPrompt(scene.prompt);
          phase = "submitted";
          await saveSession(payload, i, true, { phase, previousUrl });
          await submitPrompt();
        }

        const isVideo = generation.mode === "video";
        status(`[${i + 1}/${total}] Waiting for ${isVideo ? "video" : "image"} generation...`);

        let finalMediaUrl = "";
        if (isVideo) {
          await waitForGeneratedVideo(previousUrl);
          finalMediaUrl = currentVideoUrl(false);
          if (upscale && generation.resolution !== "720p") {
            finalMediaUrl = await tryUpscale();
          } else if (generation.resolution === "720p") {
            status("720p video was generated directly. Skipping upscale and downloading.");
          }
        } else {
          finalMediaUrl = await waitForGeneratedImage(previousUrl);
        }

        const extension = isVideo ? "mp4" : "jpg";
        const folder = isVideo ? "Grok Videos" : "Grok Images";
        const filename = `${folder}/${padded}_${safeFilePart(`${prefix}_${scene.prompt}`)}.${extension}`;
        status(`[${i + 1}/${total}] Downloading...\n${filename}`);
        await downloadVideo(finalMediaUrl, filename);

        await saveSession(payload, i + 1, true, { phase: "ready", previousUrl: "" });
        status(`[${i + 1}/${total}] Done.`);

        if (i < scenes.length - 1) {
          await goBackToImagine();
        }
      }

      await clearSession();
      status(`All done: ${scenes.length} ${generation.mode === "video" ? "videos" : "images"}.`);
    } catch (error) {
      if (stopRequested) {
        await clearSession();
      }
      status(`Stopped: ${error.message}`);
      throw error;
    } finally {
      running = false;
    }
  }

  async function resumeIfNeeded() {
    if (running || startRequested) return;
    const session = await storageGet(SESSION_KEY).catch(() => null);
    if (!session?.active || !session.payload?.scenes?.length) return;
    if (session.nextIndex >= session.payload.scenes.length) {
      await clearSession();
      return;
    }

    status(`Resuming queue from scene ${session.nextIndex + 1}/${session.payload.scenes.length}...`);
    runQueue(session.payload, session.nextIndex, session).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GROK_AUTO_PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "GROK_AUTO_STOP") {
      stopRequested = true;
      clearSession().catch(() => {});
      status("Stop requested. The current step will stop shortly.");
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "GROK_AUTO_START") {
      if (running || startRequested) {
        sendResponse({ ok: false, error: "Automation is already running." });
        return false;
      }

      startRequested = true;
      saveSession(message.payload, 0, true)
        .then(() => runQueue(message.payload, 0))
        .catch(() => {
          startRequested = false;
        });
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  setTimeout(() => {
    resumeIfNeeded().catch(() => {});
  }, 1000);
})();
