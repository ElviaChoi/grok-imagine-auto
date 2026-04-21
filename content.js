(() => {
  const SCRIPT_VERSION = "2026-04-22-single-click-v23";
  const DEBUG = true;

  if (window.__grokImagineVideoAutomatorVersion === SCRIPT_VERSION) {
    return;
  }
  window.__grokImagineVideoAutomatorVersion = SCRIPT_VERSION;
  window.__grokImagineVideoAutomatorLoaded = true;

  const SESSION_KEY = "grokVideoAutoSession";
  const DOWNLOADS_KEY = "grokVideoAutoDownloadedUrls";
  const IMAGINE_URL = "https://grok.com/imagine";
  const DEFAULT_GENERATION = {
    sourceType: "imagePrompt",
    mode: "video",
    imageQuality: "speed",
    imageDownloadScope: "first",
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
  let activeRunId = "";
  let lastDebugSnapshot = null;
  const downloadedUrls = new Set();

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

  async function loadDownloadedUrls() {
    const stored = await storageGet(DOWNLOADS_KEY).catch(() => []);
    downloadedUrls.clear();
    (Array.isArray(stored) ? stored : [])
      .filter((item) => !activeRunId || !item?.runId || item.runId === activeRunId)
      .forEach((item) => {
        if (item?.url) downloadedUrls.add(mediaUrlKey(item.url));
        if (typeof item === "string") downloadedUrls.add(mediaUrlKey(item));
      });
  }

  async function recordDownloadedUrl(url, filename) {
    const stored = await storageGet(DOWNLOADS_KEY).catch(() => []);
    const key = mediaUrlKey(url);
    const records = Array.isArray(stored) ? stored.filter((item) => item?.url !== key) : [];
    records.push({ url: key, filename, runId: activeRunId, downloadedAt: Date.now() });
    await storageSet(DOWNLOADS_KEY, records.slice(-300));
    downloadedUrls.add(key);
  }

  function status(text) {
    console.log(`[Grok Auto] ${text}`);
    chrome.runtime.sendMessage({ type: "GROK_AUTO_STATUS", text }).catch(() => {});
    renderOverlay(text);
  }

  function debug(label, data = {}) {
    if (!DEBUG) return;
    const safeData = { ...data };
    if (safeData.prompt) safeData.prompt = String(safeData.prompt).slice(0, 120);
    if (safeData.text) safeData.text = String(safeData.text).slice(0, 160);
    for (const key of Object.keys(safeData)) {
      if (safeData[key] instanceof Element) {
        const el = safeData[key];
        safeData[key] = {
          tag: el.tagName,
          className: String(el.className || "").slice(0, 160),
          ariaLabel: el.getAttribute("aria-label"),
          type: el.getAttribute("type"),
          disabled: Boolean(el.disabled),
          text: normalize(el.innerText || el.textContent).slice(0, 160)
        };
      }
    }
    lastDebugSnapshot = {
      label,
      at: new Date().toISOString(),
      url: location.href,
      ...safeData
    };
    console.log(`[Grok Auto Debug] ${label}: ${JSON.stringify(safeData)}`);
  }

  function debugSummary() {
    if (!lastDebugSnapshot) return "No debug snapshot captured.";
    const snapshot = lastDebugSnapshot;
    return [
      `Debug: ${snapshot.label}`,
      `URL: ${snapshot.url}`,
      `onImagineHome: ${snapshot.onImagineHome}`,
      `editorText: ${String(snapshot.editorText || snapshot.latestEditorText || "").slice(0, 180)}`,
      `submit: ${JSON.stringify(snapshot.submitButton || { disabled: snapshot.submitDisabled, aria: snapshot.submitAria })}`,
      `promptEcho: ${snapshot.promptEcho}`,
      `currentImages: ${snapshot.currentImages}`
    ].join("\n");
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

  function findPromptEditor() {
    return [
      ...document.querySelectorAll(
        ".query-bar .tiptap.ProseMirror[contenteditable='true'], .query-bar .ProseMirror[contenteditable='true'], .ProseMirror[contenteditable='true'], [contenteditable='true']"
      )
    ]
      .filter(visible)
      .sort((a, b) => {
        const aInQuery = a.closest(".query-bar") ? 1 : 0;
        const bInQuery = b.closest(".query-bar") ? 1 : 0;
        if (aInQuery !== bInQuery) return bInQuery - aInQuery;

        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.bottom - aRect.bottom;
      })[0] || null;
  }

  function editorRoot(editor = findPromptEditor()) {
    return editor?.closest(".query-bar") || editor?.closest("form") || document;
  }

  function onImagineHome() {
    return location.href.startsWith(IMAGINE_URL) && !/\/imagine\/(?!$|\?)/.test(location.pathname);
  }

  function findSubmitButton(enabledOnly = true, root = document) {
    const searchRoot = root?.isConnected || root === document ? root : document;
    const candidates = [
      ...searchRoot.querySelectorAll(
        ".query-bar button[type='submit'][aria-label='\uC81C\uCD9C'], .query-bar button[type='submit'][aria-label='Submit'], .query-bar button[type='submit'], button[type='submit'][aria-label='\uC81C\uCD9C'], button[type='submit'][aria-label='Submit']"
      )
    ]
      .filter(visible)
      .filter((button) => !enabledOnly || !button.disabled);

    return candidates[0] || null;
  }

  function promptAppearsOutsideEditor(prompt) {
    const expected = normalize(prompt).slice(0, 60);
    if (!expected) return false;

    const matches = [...document.querySelectorAll("main *, [role='main'] *, body > div *")]
      .filter(visible)
      .filter((el) => {
        if (el.matches("input, textarea, [contenteditable='true']")) return false;
        if (el.closest("form, .query-bar, [contenteditable='true']")) return false;
        if (el.closest("#grok-auto-overlay")) return false;
        return true;
      })
      .filter((el) => normalize(el.innerText || el.textContent).includes(expected));
    if (matches.length) {
      debug("prompt echo matched", {
        count: matches.length,
        tag: matches[0].tagName,
        className: matches[0].className,
        text: matches[0].innerText || matches[0].textContent
      });
    }
    return matches.length > 0;
  }

  function promptWasSubmitted(prompt, editor, requirePromptEcho = false) {
    if (promptAppearsOutsideEditor(prompt)) return true;
    if (requirePromptEcho) return false;
    if (!editor?.isConnected) {
      const latestEditor = findPromptEditor();
      return latestEditor && promptIsEmpty(latestEditor);
    }
    const text = promptEditorText(editor);
    return !text || text !== normalize(prompt);
  }

  function promptIsEmpty(editor = findPromptEditor()) {
    if (!editor) return true;
    const text = promptEditorText(editor);
    if (text) return false;
    return Boolean(editor.querySelector(".is-empty, .is-editor-empty") || normalize(editor.getAttribute("data-placeholder")));
  }

  function promptEditorText(editor) {
    return normalize(editor?.innerText || editor?.textContent || "");
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function focusEditor(editor) {
    editor.scrollIntoView({ block: "center", inline: "center" });
    editor.focus();
    selectEditorContents(editor);
  }

  function keyboard(editor, type, key, options = {}) {
    editor.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code:
          key === "Enter"
            ? "Enter"
            : key === "Backspace"
              ? "Backspace"
              : `Key${String(key).toUpperCase()}`,
        bubbles: true,
        cancelable: true,
        ...options
      })
    );
  }

  function input(editor, inputType, data = null) {
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType,
      data
    });
    const proceed = editor.dispatchEvent(before);
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType,
        data
      })
    );
    return !proceed || before.defaultPrevented;
  }

  function clearPromptEditor(editor) {
    focusEditor(editor);
    keyboard(editor, "keydown", "a", { ctrlKey: true });
    keyboard(editor, "keyup", "a", { ctrlKey: true });
    selectEditorContents(editor);
    input(editor, "deleteContentBackward");
    document.execCommand("delete", false, null);
    keyboard(editor, "keydown", "Backspace");
    keyboard(editor, "keyup", "Backspace");
    fire(editor, "input");
  }

  function insertPromptWithTyping(editor, prompt) {
    clearPromptEditor(editor);
    const chunks = String(prompt).match(/.{1,24}/gs) || [prompt];
    for (const chunk of chunks) {
      const handled = input(editor, "insertText", chunk);
      if (!handled) document.execCommand("insertText", false, chunk);
    }
    fire(editor, "input");
  }

  function insertPromptWithExecCommand(editor, prompt) {
    clearPromptEditor(editor);
    document.execCommand("insertText", false, prompt);
    fire(editor, "input");
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: prompt
      })
    );
  }

  function insertPromptWithPaste(editor, prompt) {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", prompt);
    focusEditor(editor);
    document.execCommand("delete", false, null);
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      })
    );
    fire(editor, "input");
  }

  function insertPromptWithDom(editor, prompt) {
    focusEditor(editor);
    document.execCommand("delete", false, null);
    editor.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = prompt;
    editor.appendChild(paragraph);
    fire(editor, "input");
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  }

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    const pointTarget = document.elementFromPoint(x, y);
    const target = pointTarget && (pointTarget === el || el.contains(pointTarget)) ? pointTarget : el;

    target.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerenter", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mouseover", common));
    target.dispatchEvent(new MouseEvent("mouseenter", common));
    target.dispatchEvent(new MouseEvent("mousedown", common));
    target.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", common));
    if (typeof target.click === "function") {
      target.click();
    } else if (target !== el && typeof el.click === "function") {
      el.click();
    } else {
      target.dispatchEvent(new MouseEvent("click", common));
    }
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
      () => findPromptEditor(),
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
      await chooseRadio(
        ["\uC774\uBBF8\uC9C0", "\uC774\uBBF8\uC9C0 \uBC29\uC2DD", "\uBC29\uC2DD", "image", "quality"],
        generation.imageQuality === "quality"
          ? ["\uD488\uC9C8", "quality"]
          : ["\uC18D\uB3C4", "speed"],
        400
      );
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

  function previousUrlSet(previousUrls = "") {
    if (Array.isArray(previousUrls)) return new Set(previousUrls.filter(Boolean).map(mediaUrlKey));
    if (!previousUrls) return new Set();
    return new Set([mediaUrlKey(previousUrls)]);
  }

  function mediaUrlKey(url = "") {
    if (/^data:image\//i.test(url)) {
      return `data-url:${url.length}:${url.slice(0, 80)}:${url.slice(-80)}`;
    }
    if (/^https?:/i.test(url)) {
      try {
        const parsed = new URL(url, location.href);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return url.split(/[?#]/)[0];
      }
    }
    return url;
  }

  function downloadableImageUrl(url = "") {
    return /^https?:/i.test(url) && /\/generated\/|preview_image|assets\.grok\.com\/users|imagine-public\.x\.ai/i.test(url);
  }

  function imageUrlLooksLikeAsset(url = "") {
    return /^https?:/i.test(url) && /\.(png|jpe?g|webp)(?:[?#]|$)/i.test(url);
  }

  function cssBackgroundUrl(el) {
    const value = getComputedStyle(el).backgroundImage || "";
    const match = /url\((["']?)(.*?)\1\)/i.exec(value);
    return match?.[2] || "";
  }

  function imageLikeUrlFromElement(el) {
    if (!el) return "";
    const tag = el.tagName?.toLowerCase();
    if (tag === "img") return el.currentSrc || el.src || "";
    if (tag === "source") return el.srcset?.split(/\s+/)[0] || el.src || "";
    if (tag === "a") return el.href || "";
    return cssBackgroundUrl(el);
  }

  function imageUrlLooksGenerated(url = "") {
    return /\/generated\/|preview_image|assets\.grok\.com\/users|imagine-public\.x\.ai|twimg\.com|xai|grok/i.test(url);
  }

  function imageItemLooksFinal(item) {
    if (!item?.url) return false;
    if (/^blob:|^data:image\//i.test(item.url)) return false;
    if (item.tag === "video") return false;
    if (/loading|skeleton|placeholder|shimmer/i.test(`${item.className} ${item.cardClass}`)) return false;

    if (item.tag === "img") {
      if (!item.complete) return false;
      if (item.naturalWidth && item.naturalHeight) {
        if (Math.min(item.naturalWidth, item.naturalHeight) < 256) return false;
        if (item.naturalWidth * item.naturalHeight < 180_000) return false;
      }
    } else if (Math.min(item.renderedWidth || 0, item.renderedHeight || 0) < 180) {
      return false;
    }

    return imageUrlLooksGenerated(item.url) || (item.tag === "img" && imageUrlLooksLikeAsset(item.url));
  }

  function currentImageItems() {
    const backgroundCandidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => cssBackgroundUrl(el));
    const candidates = [
      ...document.querySelectorAll(
        [
          "img",
          "source[srcset]",
          "a[href*='/generated/']",
          "a[href*='preview_image']",
          "a[href$='.png']",
          "a[href$='.jpg']",
          "a[href$='.jpeg']",
          "a[href$='.webp']"
        ].join(", ")
      ),
      ...backgroundCandidates
    ];

    const seen = new Set();
    const images = candidates
      .filter(visible)
      .map((el) => {
        const root =
          el.closest("[role='listitem']") ||
          el.closest("[class*='media-post-masonry-card']") ||
          el.closest("[class*='media']") ||
          el.closest("article") ||
          el;
        const rect = root.getBoundingClientRect();
        const mediaRect = el.getBoundingClientRect();
        const url = imageLikeUrlFromElement(el);
        const tag = el.tagName?.toLowerCase() || "";
        return {
          card: root,
          img: el,
          tag,
          url,
          key: mediaUrlKey(url),
          alt: el.alt || el.getAttribute("aria-label") || "",
          className: String(el.className || ""),
          cardClass: String(root.className || ""),
          complete: tag === "img" ? el.complete : true,
          naturalWidth: tag === "img" ? el.naturalWidth || 0 : 0,
          naturalHeight: tag === "img" ? el.naturalHeight || 0 : 0,
          renderedWidth: mediaRect.width,
          renderedHeight: mediaRect.height,
          top: rect.top,
          left: rect.left,
          area: Math.max(rect.width * rect.height, mediaRect.width * mediaRect.height)
        };
      })
      .filter((item) => {
        if (!item.url) return false;
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        if (/profile-picture|pfp/i.test(item.url)) return false;
        if (item.area < 10_000 && !/generated image/i.test(item.alt)) return false;
        return (/generated image/i.test(item.alt) || imageUrlLooksGenerated(item.url)) && imageItemLooksFinal(item);
      })
      .sort((a, b) => {
        const aDownloadable = downloadableImageUrl(a.url) ? 1 : 0;
        const bDownloadable = downloadableImageUrl(b.url) ? 1 : 0;
        if (aDownloadable !== bDownloadable) return bDownloadable - aDownloadable;
        const rowDelta = a.top - b.top;
        if (Math.abs(rowDelta) > 16) return rowDelta;
        return a.left - b.left;
      });

    return images;
  }

  function rawImageCandidateSummary(limit = 6) {
    const backgroundCandidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => cssBackgroundUrl(el));
    return [...document.querySelectorAll("img, video, canvas, picture, a[href]"), ...backgroundCandidates]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, rect, area: rect.width * rect.height };
      })
      .sort((a, b) => b.area - a.area)
      .slice(0, limit)
      .map(({ el, rect }) => {
        const url = imageLikeUrlFromElement(el);
        return {
          tag: el.tagName?.toLowerCase(),
          url: String(url || "").slice(0, 180),
          alt: String(el.alt || el.getAttribute("aria-label") || "").slice(0, 80),
          naturalWidth: el.naturalWidth || 0,
          naturalHeight: el.naturalHeight || 0,
          renderedWidth: Math.round(rect.width),
          renderedHeight: Math.round(rect.height),
          className: String(el.className || "").slice(0, 80)
        };
      });
  }

  function resultImageCardSummary(limit = 8) {
    return resultImageCards()
      .slice(0, limit)
      .map((item) => ({
        tag: item.root.tagName?.toLowerCase(),
        top: Math.round(item.top),
        left: Math.round(item.left),
        renderedWidth: Math.round(item.renderedWidth || 0),
        renderedHeight: Math.round(item.renderedHeight || 0),
        hasMedia: Boolean(item.media || item.img),
        hasUrl: Boolean(item.url),
        className: String(item.root.className || "").slice(0, 80)
      }));
  }

  function currentNewImageItems(previousUrls = "") {
    const previous = previousUrlSet(previousUrls);
    return currentImageItems().filter((item) => !previous.has(item.key) && !previous.has(item.url));
  }

  function currentImageUrls() {
    return [...new Set(currentImageItems().map((item) => item.key))];
  }

  function currentImageUrl(previousUrls = "") {
    const images = currentNewImageItems(previousUrls);
    return images[0]?.url || "";
  }

  function imageExtensionForUrl(url = "") {
    const mimeMatch = /^data:image\/([^;,]+)/i.exec(url);
    if (mimeMatch) {
      const mime = mimeMatch[1].toLowerCase();
      if (mime === "jpeg" || mime === "jpg") return "jpg";
      if (mime === "svg+xml") return "svg";
      return mime.replace(/[^a-z0-9]/g, "") || "jpg";
    }

    const extMatch = /\.(png|jpe?g|webp)(?:[?#]|$)/i.exec(url);
    if (!extMatch) return "jpg";
    return extMatch[1].toLowerCase() === "jpeg" ? "jpg" : extMatch[1].toLowerCase();
  }

  function filenameWithImageExtension(filename, url) {
    const extension = imageExtensionForUrl(url);
    return String(filename || "").replace(/\.(png|jpe?g|webp)$/i, `.${extension}`);
  }

  async function blobUrlToDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not read generated blob image (${response.status}).`);
    }
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not convert generated blob image."));
      reader.readAsDataURL(blob);
    });
  }

  async function waitForGeneratedImages(previousUrl, settings = DEFAULT_GENERATION) {
    const started = Date.now();
    let lastReport = 0;
    let lastSignature = "";
    let stableSince = 0;
    let lastItems = [];

    while (Date.now() - started < WAIT.generate) {
      assertNotStopped();

      const items = currentNewImageItems(previousUrl);
      const detailCards = resultImageCards();
      const signature = items.map((item) => item.key).join("|");

      if (signature && signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
        lastItems = items;
      }

      const requiredStable = settings.imageDownloadScope === "all" ? 10_000 : 8_000;
      if (lastSignature && Date.now() - stableSince >= requiredStable) {
        await sleep(WAIT.afterGenerate);
        const latestItems = currentNewImageItems(previousUrl);
        const maxImages =
          settings.imageDownloadScope === "all" && settings.imageQuality === "speed" ? 4 : Infinity;
        const directSelected =
          settings.imageDownloadScope === "all"
            ? latestItems.slice(0, maxImages)
            : latestItems.slice(0, 1);
        const selected =
          detailCards.length
            ? directSelected.map((item, index) => ({ ...item, detailOnly: true, index, url: `detail:${index}` }))
            : directSelected;
        if (!selected.length) {
          lastSignature = "";
          lastItems = [];
          continue;
        }
        status(
          `Image results are ready.\nDetected images: ${latestItems.length}, downloading: ${selected.length}${Number.isFinite(maxImages) ? ` (speed cap: ${maxImages})` : ""}\nDownload method: ${detailCards.length ? "detail button" : "direct URL"}\nFirst image: ${directSelected[0].naturalWidth || Math.round(directSelected[0].renderedWidth)}x${directSelected[0].naturalHeight || Math.round(directSelected[0].renderedHeight)}`
        );
        return selected;
      }

      if (!items.length && detailCards.length && Date.now() - started > 4_000) {
        const maxImages =
          settings.imageDownloadScope === "all" && settings.imageQuality === "speed" ? 4 : Infinity;
        const selected =
          settings.imageDownloadScope === "all"
            ? detailCards.slice(0, maxImages).map((_, index) => ({ detailOnly: true, index, url: `detail:${index}` }))
            : [{ detailOnly: true, index: 0, url: "detail:0" }];
        status(
          `Image result cards are visible. Using detail download fallback.\nDetected cards: ${detailCards.length}, downloading: ${selected.length}${Number.isFinite(maxImages) ? ` (speed cap: ${maxImages})` : ""}`
        );
        debug("using detail download fallback", {
          cards: detailCards.length,
          first: {
            url: detailCards[0].url,
            naturalWidth: detailCards[0].naturalWidth,
            naturalHeight: detailCards[0].naturalHeight,
            renderedWidth: Math.round(detailCards[0].renderedWidth || 0),
            renderedHeight: Math.round(detailCards[0].renderedHeight || 0)
          }
        });
        await sleep(WAIT.afterGenerate);
        return selected;
      }

      if (Date.now() - lastReport > 10_000) {
        const previousCount = previousUrlSet(previousUrl).size;
        if (!items.length && detailCards.length) {
          const maxImages =
            settings.imageDownloadScope === "all" && settings.imageQuality === "speed" ? 4 : Infinity;
          const selected =
            settings.imageDownloadScope === "all"
              ? detailCards.slice(0, maxImages).map((_, index) => ({ detailOnly: true, index, url: `detail:${index}` }))
              : [{ detailOnly: true, index: 0, url: "detail:0" }];
          status(
            `Image result cards are visible. Using detail download fallback.\nDetected cards: ${detailCards.length}, downloading: ${selected.length}${Number.isFinite(maxImages) ? ` (speed cap: ${maxImages})` : ""}`
          );
          debug("using detail download fallback", {
            cards: detailCards.length,
            first: {
              url: detailCards[0].url,
              naturalWidth: detailCards[0].naturalWidth,
              naturalHeight: detailCards[0].naturalHeight
            }
          });
          await sleep(WAIT.afterGenerate);
          return selected;
        }
        status(
          `Waiting for image generation...\nDetected images: ${currentImageItems().length}, previous images: ${previousCount}, new images: ${items.length}`
        );
        debug("image wait check", {
          detected: currentImageItems().length,
          previous: previousCount,
          newItems: items.length,
          detailCards: detailCards.length,
          detailCardSummary: detailCards.length ? resultImageCardSummary() : undefined,
          raw: items.length ? undefined : rawImageCandidateSummary(),
          first: items[0]
            ? {
                url: items[0].url,
                tag: items[0].tag,
                naturalWidth: items[0].naturalWidth,
                naturalHeight: items[0].naturalHeight,
                renderedWidth: Math.round(items[0].renderedWidth),
                renderedHeight: Math.round(items[0].renderedHeight)
              }
            : null
        });
        lastReport = Date.now();
      }

      await sleep(500);
    }

    throw new Error("image generation timed out. No new image appeared after submit.");
  }

  function resultImageCards() {
    const imageCards = [...document.querySelectorAll("img")]
      .filter(visible)
      .map((img) => {
        const root =
          img.closest("[role='listitem']") ||
          img.closest("[class*='media-post-masonry-card']") ||
          img.closest("[class*='media']") ||
          img.closest("article") ||
          img.closest("a") ||
          img;
        const clickTarget =
          img.closest("[class*='media-post-masonry-card']") ||
          img.closest(".cursor-pointer") ||
          img.closest("a") ||
          img;
        const rect = root.getBoundingClientRect();
        const imageRect = img.getBoundingClientRect();
        return {
          root,
          img,
          clickTarget,
          top: rect.top,
          left: rect.left,
          area: Math.max(rect.width * rect.height, imageRect.width * imageRect.height),
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
          renderedWidth: imageRect.width,
          renderedHeight: imageRect.height,
          url: img.currentSrc || img.src || ""
        };
      })
      .filter((item) => {
        if (/profile-picture|pfp/i.test(item.url)) return false;
        if (item.area < 30_000) return false;
        if (item.naturalWidth && item.naturalHeight && Math.min(item.naturalWidth, item.naturalHeight) < 180) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const rowDelta = a.top - b.top;
        if (Math.abs(rowDelta) > 16) return rowDelta;
        return a.left - b.left;
      });

    const visualCards = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const media = el.matches("img, video, canvas, picture")
          ? el
          : el.querySelector("img, video, canvas, picture");
        return {
          root: el,
          img: media?.tagName?.toLowerCase() === "img" ? media : el.querySelector("img"),
          media,
          clickTarget:
            media ||
            el.querySelector("[class*='media-post-masonry-card']") ||
            el.querySelector(".cursor-pointer") ||
            el,
          top: rect.top,
          left: rect.left,
          area: rect.width * rect.height,
          renderedWidth: rect.width,
          renderedHeight: rect.height,
          naturalWidth: el.querySelector("img")?.naturalWidth || 0,
          naturalHeight: el.querySelector("img")?.naturalHeight || 0,
          url: imageLikeUrlFromElement(media) || cssBackgroundUrl(el) || ""
        };
      })
      .filter((item) => {
        const el = item.root;
        const text = normalize(el.innerText || el.textContent);
        const aspect = item.renderedWidth / Math.max(item.renderedHeight, 1);
        if (item.left < 220 || item.top < 70) return false;
        if (item.renderedWidth < 160 || item.renderedHeight < 80) return false;
        if (item.renderedWidth > 760 || item.renderedHeight > 430) return false;
        if (aspect < 1.1 || aspect > 4.2) return false;
        if (text.length > 80) return false;
        if (el.matches("button, a, svg, input, textarea, [contenteditable='true']")) return false;
        if (el.closest(".query-bar, #grok-auto-overlay, [contenteditable='true']")) return false;
        if (/sidebar|menu-button|radix|toolbar/i.test(String(el.className || ""))) return false;
        return Boolean(item.media || item.img || item.url || el.querySelector("button, svg"));
      });

    const seen = new Set();
    return [...imageCards, ...visualCards]
      .sort((a, b) => {
        const rowDelta = a.top - b.top;
        if (Math.abs(rowDelta) > 16) return rowDelta;
        return a.left - b.left;
      })
      .filter((item) => {
        const key = `${Math.round(item.left)}:${Math.round(item.top)}:${Math.round(item.renderedWidth || 0)}:${Math.round(item.renderedHeight || 0)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function findDetailDownloadButton() {
    return [...document.querySelectorAll("button[aria-label='\uB2E4\uC6B4\uB85C\uB4DC'], button[aria-label='Download']")]
      .filter(visible)
      .find((button) => !button.disabled);
  }

  async function openDetailDownloadButton(card) {
    let button = findDetailDownloadButton();
    if (button) return button;

    const openTarget = card.clickTarget || card.img || card.media || card.root;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      debug("detail open attempt", {
        attempt,
        target: openTarget,
        targetTag: openTarget?.tagName?.toLowerCase(),
        targetClass: String(openTarget?.className || "").slice(0, 120),
        location: location.href
      });
      click(openTarget);
      button = await waitFor(() => findDetailDownloadButton(), attempt === 4 ? WAIT.page : 3_000, "detail download button").catch(
        () => null
      );
      if (button) return button;
      await sleep(400);
    }

    throw new Error("detail download button timed out.");
  }

  async function downloadImageViaDetail(index, filename) {
    const cards = await waitFor(() => {
      const found = resultImageCards();
      return found.length ? found : null;
    }, WAIT.generate, "image result cards");
    const card = cards[Math.min(index, cards.length - 1)];
    if (!card) throw new Error("Could not find an image result card to open.");

    status(`Opening image ${index + 1} detail for download...`);
    debug("detail download opening card", {
      index,
      filename,
      card: card.root,
      clickTarget: card.clickTarget || card.img || card.media || card.root,
      imageUrl: card.url,
      naturalWidth: card.naturalWidth,
      naturalHeight: card.naturalHeight
    });

    const button = await openDetailDownloadButton(card).catch(async (error) => {
      const fallbackUrl = card.url || imageLikeUrlFromElement(card.img || card.media);
      if (/^data:image\//i.test(fallbackUrl) || downloadableImageUrl(fallbackUrl)) {
        const fallbackFilename = filenameWithImageExtension(filename, fallbackUrl);
        status(`Detail did not open. Downloading image source directly...\n${fallbackFilename}`);
        debug("detail open failed; falling back to direct image source", {
          error: error.message,
          filename: fallbackFilename,
          url: fallbackUrl,
          urlType: /^data:image\//i.test(fallbackUrl) ? "data-image" : "remote-image"
        });
        await downloadMedia(fallbackUrl, fallbackFilename);
        return null;
      }
      throw error;
    });
    if (!button) return;
    const watch = await chrome.runtime.sendMessage({
      type: "GROK_AUTO_EXPECT_NATIVE_DOWNLOAD",
      filename
    });
    if (!watch?.ok) throw new Error(watch?.error || "Could not start native download watch.");

    status(`Clicking detail download...\n${filename}`);
    click(button);
    const response = await chrome.runtime.sendMessage({
      type: "GROK_AUTO_WAIT_NATIVE_DOWNLOAD",
      token: watch.token
    });
    if (!response?.ok) throw new Error(response?.error || "Native image download failed.");

    await recordDownloadedUrl(`native:${filename}:${Date.now()}`, filename);
  }

  async function waitForGeneratedImage(previousUrl) {
    const images = await waitForGeneratedImages(previousUrl, DEFAULT_GENERATION);
    return images[0]?.url || "";
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
    const editor = await waitFor(() => findPromptEditor(), WAIT.page, "prompt editor");
    const expected = normalize(prompt);
    let method = "typing";

    debug("setPrompt start", {
      url: location.href,
      editorClass: editor.className,
      editorTextBefore: promptEditorText(editor),
      submitFound: Boolean(findSubmitButton(false, editorRoot(editor))),
      submitEnabled: Boolean(findSubmitButton(true, editorRoot(editor)))
    });

    insertPromptWithTyping(editor, prompt);
    await sleep(700);
    debug("after typing insert", {
      editorText: promptEditorText(editor),
      submitEnabled: Boolean(findSubmitButton(true, editorRoot(editor)))
    });

    if (!promptEditorText(editor).includes(expected)) {
      method = "execCommand";
      insertPromptWithExecCommand(editor, prompt);
      await sleep(500);
      debug("after execCommand insert", {
        editorText: promptEditorText(editor),
        submitEnabled: Boolean(findSubmitButton(true, editorRoot(editor)))
      });
    }

    if (!promptEditorText(editor).includes(expected)) {
      method = "paste";
      insertPromptWithPaste(editor, prompt);
      await sleep(700);
      debug("after paste insert", {
        editorText: promptEditorText(editor),
        submitEnabled: Boolean(findSubmitButton(true, editorRoot(editor)))
      });
    }

    await waitFor(
      () => promptEditorText(editor).includes(expected),
      5_000,
      "prompt text insertion"
    );

    await sleep(900);
    const submit = await waitFor(
      () => {
        const latestEditor = editor?.isConnected ? editor : findPromptEditor();
        return (
          latestEditor &&
          promptEditorText(latestEditor).includes(expected) &&
          findSubmitButton(true, editorRoot(latestEditor))
        );
      },
      5_000,
      "prompt submit readiness"
    );
    status(
      `Prompt is ready (${method}).\nEditor chars: ${promptEditorText(editor).length}, submit disabled: ${submit.disabled}`
    );
    debug("setPrompt ready", {
      method,
      url: location.href,
      editorText: promptEditorText(editor),
      submitDisabled: submit.disabled,
      submitAria: submit.getAttribute("aria-label"),
      submitClass: submit.className,
      submitButton: submit,
      formText: normalize(editorRoot(editor)?.innerText || editorRoot(editor)?.textContent).slice(0, 240)
    });

    return editor;
  }

  async function submitPrompt(editor = findPromptEditor(), options = {}) {
    const rawPrompt = options.prompt || promptEditorText(editor);
    const prompt = normalize(rawPrompt);
    const requirePromptEcho = Boolean(options.requirePromptEcho);
    if (!prompt) {
      throw new Error("Prompt editor is empty before submit.");
    }

    status("Submitting prompt...");
    debug("submitPrompt start", {
      url: location.href,
      onImagineHome: onImagineHome(),
      requirePromptEcho,
      prompt,
      editorConnected: Boolean(editor?.isConnected),
      editorText: promptEditorText(editor),
      submitEnabled: Boolean(findSubmitButton(true, editorRoot(editor)))
    });
    const maxAttempts = requirePromptEcho ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const currentEditor = editor?.isConnected ? editor : findPromptEditor();
      if (currentEditor && onImagineHome() && !promptEditorText(currentEditor)) {
        insertPromptWithExecCommand(currentEditor, rawPrompt);
        await sleep(700);
      }

      if (requirePromptEcho) {
        focusEditor(currentEditor);
        debug("before image enter submit", {
          attempt: attempt + 1,
          url: location.href,
          editorText: promptEditorText(currentEditor),
          submitEnabled: Boolean(findSubmitButton(true, editorRoot(currentEditor))),
          activeElement: document.activeElement
        });
        keyboard(currentEditor, "keydown", "Enter");
        keyboard(currentEditor, "keypress", "Enter");
        keyboard(currentEditor, "keyup", "Enter");
        await sleep(2500);
        debug("after image enter submit", {
          attempt: attempt + 1,
          url: location.href,
          onImagineHome: onImagineHome(),
          editorConnected: Boolean(currentEditor?.isConnected),
          editorText: promptEditorText(currentEditor),
          promptEcho: promptAppearsOutsideEditor(prompt),
          latestEditorText: promptEditorText(findPromptEditor())
        });
        if (promptWasSubmitted(prompt, currentEditor, requirePromptEcho)) break;
        if (!onImagineHome()) break;
      }

      const root = editorRoot(currentEditor);
      const submit = await waitFor(
        () => {
          const latestEditor = currentEditor?.isConnected ? currentEditor : findPromptEditor();
          const latestRoot = editorRoot(latestEditor);
          return (
            findSubmitButton(true, latestRoot) ||
            (!requirePromptEcho ? findSubmitButton(true, document) : null)
          );
        },
        WAIT.upload,
        "enabled submit button"
      );

      debug("before submit click", {
        attempt: attempt + 1,
        url: location.href,
        editorText: promptEditorText(currentEditor),
        submitDisabled: submit.disabled,
        submitAria: submit.getAttribute("aria-label"),
        submitClass: submit.className,
        submitButton: submit,
        rootClass: root?.className,
        rootText: normalize(root?.innerText || root?.textContent).slice(0, 240),
        activeElement: document.activeElement
      });
      click(submit);
      await sleep(requirePromptEcho ? 2500 : 1200);
      debug("after submit click", {
        attempt: attempt + 1,
        url: location.href,
        onImagineHome: onImagineHome(),
        editorConnected: Boolean(currentEditor?.isConnected),
        editorText: promptEditorText(currentEditor),
        promptEcho: promptAppearsOutsideEditor(prompt),
        currentImages: currentImageItems().length,
        latestEditorText: promptEditorText(findPromptEditor()),
        pageTextStart: normalize(document.body?.innerText || document.body?.textContent).slice(0, 500)
      });

      if (promptWasSubmitted(prompt, currentEditor, requirePromptEcho)) break;
      if (requirePromptEcho) break;

      currentEditor?.focus();
      keyboard(currentEditor, "keydown", "Enter");
      keyboard(currentEditor, "keypress", "Enter");
      keyboard(currentEditor, "keyup", "Enter");
      await sleep(1200);

      if (promptWasSubmitted(prompt, currentEditor, requirePromptEcho)) break;
    }

    await waitFor(
      () => {
        const submitted = promptWasSubmitted(prompt, editor, requirePromptEcho);
        debug("submit wait check", {
          url: location.href,
          onImagineHome: onImagineHome(),
          submitted,
          requirePromptEcho,
          editorConnected: Boolean(editor?.isConnected),
          editorText: promptEditorText(editor),
          latestEditorText: promptEditorText(findPromptEditor()),
          promptEcho: promptAppearsOutsideEditor(prompt),
          currentImages: currentImageItems().length
        });
        return submitted;
      },
      15_000,
      "generation submit"
    );
    status("Prompt was submitted.");
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
    status("Video is playable. Waiting briefly before next step.");
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

  async function downloadMedia(url, filename) {
    if (!url) {
      throw new Error("Could not find a media URL to download.");
    }
    if (/^blob:/i.test(url)) {
      url = await blobUrlToDataUrl(url);
    }
    if (!/^https?:|^data:image\//i.test(url)) {
      throw new Error("Generated media is still a temporary preview URL. Please retry this scene after the final URL appears.");
    }
    await loadDownloadedUrls();
    const downloadKey = mediaUrlKey(url);
    if (downloadedUrls.has(downloadKey)) {
      throw new Error("This media URL was already downloaded in this run. Stopping to avoid downloading a cached previous result.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "GROK_AUTO_DOWNLOAD",
      url,
      filename
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Chrome download request failed.");
    }

    await recordDownloadedUrl(url, filename);
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
      () => findPromptEditor(),
      WAIT.page,
      "next Imagine page"
    );
    await sleep(WAIT.settle);
  }

  async function runQueue(payload, startAt = 0, resumeState = null) {
    running = true;
    startRequested = false;
    stopRequested = false;
    payload.runId = payload.runId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeRunId = payload.runId;
    await loadDownloadedUrls();

    const { scenes, prefix, startIndex, upscale } = payload;
    const generation = { ...DEFAULT_GENERATION, ...(payload.generation || {}) };
    let currentIndex = startAt;
    let currentPhase = resumeState?.phase || "start";
    let currentPreviousUrl = resumeState?.previousUrl || "";
    let currentFinalMediaUrl = resumeState?.finalMediaUrl || "";

    try {
      for (let i = startAt; i < scenes.length; i += 1) {
        currentIndex = i;
        assertNotStopped();
        const state =
          i === startAt && resumeState && resumeState.nextIndex === i
            ? resumeState
            : null;
        let previousUrl = state?.previousUrl || "";
        let phase = state?.phase || "start";
        let finalMediaUrl = state?.finalMediaUrl || "";
        currentPhase = phase;
        currentPreviousUrl = previousUrl;
        currentFinalMediaUrl = finalMediaUrl;

        await saveSession(payload, i, true, { phase, previousUrl, finalMediaUrl });

        const scene = scenes[i];
        const number = startIndex + i;
        const padded = String(number).padStart(2, "0");
        const total = scenes.length;

        if (phase === "submitted") {
          status(`[${i + 1}/${total}] Generation was already submitted. Waiting for result...`);
        } else if (phase === "downloading" && finalMediaUrl) {
          status(`[${i + 1}/${total}] Result was already found. Preparing to retry download...`);
        } else {
          status(`[${i + 1}/${total}] Preparing Imagine page...`);
          await ensureImagineHome();
          await ensureGenerationSettings(generation);

          previousUrl = generation.mode === "video" ? currentVideoUrl(false) : currentImageUrls();
          currentPreviousUrl = previousUrl;
          await saveSession(payload, i, true, { phase: "editing", previousUrl });
          currentPhase = "editing";

          if (scene.image) {
            status(`[${i + 1}/${total}] Uploading scene image...`);
            await uploadImage(scene.image);
            await ensureGenerationSettings(generation);
          } else {
            status(`[${i + 1}/${total}] Using prompt only. Skipping image upload.`);
          }

          status(`[${i + 1}/${total}] Entering prompt and generating...`);
          const promptEditor = await setPrompt(scene.prompt);
          phase = "submitting";
          currentPhase = phase;
          await saveSession(payload, i, true, { phase, previousUrl });
          await submitPrompt(promptEditor, {
            prompt: scene.prompt,
            requirePromptEcho: generation.mode !== "video"
          });
          phase = "submitted";
          currentPhase = phase;
          await saveSession(payload, i, true, { phase, previousUrl });
        }

        const isVideo = generation.mode === "video";
        const retryingPendingDownload = phase === "downloading" && finalMediaUrl;
        let imageItems = [];
        if (retryingPendingDownload) {
          status(`[${i + 1}/${total}] Download was pending. Retrying download...`);
          if (!isVideo) imageItems = [{ detailOnly: true, index: 0, url: "detail:0" }];
        } else {
          status(`[${i + 1}/${total}] Waiting for ${isVideo ? "video" : "image"} generation...`);

          if (isVideo) {
            finalMediaUrl = await waitForGeneratedVideo(previousUrl);
            currentFinalMediaUrl = finalMediaUrl;
            if (upscale && generation.resolution !== "720p") {
              finalMediaUrl = await tryUpscale();
              currentFinalMediaUrl = finalMediaUrl;
            } else if (generation.resolution === "720p") {
              status("720p video was generated directly. Skipping upscale and downloading.");
            }
          } else {
            imageItems = await waitForGeneratedImages(previousUrl, generation);
            finalMediaUrl = imageItems[0]?.url || "";
            currentFinalMediaUrl = mediaUrlKey(finalMediaUrl);
          }
        }

        const folder = isVideo ? "Grok Videos" : "Grok Images";
        const baseFilename = `${folder}/${padded}_${safeFilePart(`${prefix}_${scene.prompt}`)}`;
        currentPhase = "downloading";
        currentFinalMediaUrl = isVideo ? finalMediaUrl : mediaUrlKey(finalMediaUrl);
        await saveSession(payload, i, true, {
          phase: currentPhase,
          previousUrl,
          finalMediaUrl: currentFinalMediaUrl
        });
        await loadDownloadedUrls();

        if (isVideo) {
          const filename = `${baseFilename}.mp4`;
          status(`[${i + 1}/${total}] Downloading...\n${filename}`);
          if (retryingPendingDownload && downloadedUrls.has(mediaUrlKey(finalMediaUrl))) {
            status(`[${i + 1}/${total}] Download already completed. Moving to the next scene.`);
          } else {
            await downloadMedia(finalMediaUrl, filename);
          }
        } else {
          if (!imageItems.length) imageItems = await waitForGeneratedImages(previousUrl, generation);
          for (let imageIndex = 0; imageIndex < imageItems.length; imageIndex += 1) {
            const item = imageItems[imageIndex];
            const suffix = imageItems.length > 1 ? `_${String(imageIndex + 1).padStart(2, "0")}` : "";
            const filename = `${baseFilename}${suffix}.${item.detailOnly ? "png" : imageExtensionForUrl(item.url)}`;
            status(`[${i + 1}/${total}] Downloading image ${imageIndex + 1}/${imageItems.length}...\n${filename}`);
            if (retryingPendingDownload && downloadedUrls.has(mediaUrlKey(item.url))) {
              status(`[${i + 1}/${total}] Image ${imageIndex + 1} was already downloaded.`);
            } else if (item.detailOnly) {
              await downloadImageViaDetail(item.index || imageIndex, filename);
            } else {
              await downloadMedia(item.url, filename);
            }
          }
        }

        await saveSession(payload, i + 1, true, { phase: "ready", previousUrl: "" });
        status(`[${i + 1}/${total}] Done.`);

        if (i < scenes.length - 1) {
          await goBackToImagine();
        }
      }

      await clearSession();
      status(`All done: ${scenes.length} ${generation.mode === "video" ? "videos" : "images"}.`);
    } catch (error) {
      const summary = debugSummary();
      console.warn(`[Grok Auto Debug Summary]\n${summary}`);
      if (stopRequested) {
        await clearSession();
      } else {
        await saveSession(payload, currentIndex, true, {
          phase: currentPhase,
          previousUrl: currentPreviousUrl,
          finalMediaUrl: currentFinalMediaUrl,
          error: {
            message: error.message,
            phase: currentPhase,
            sceneIndex: currentIndex,
            debug: summary,
            happenedAt: Date.now()
          }
        }).catch(() => {});
      }
      status(`Stopped: ${error.message}\n${summary}`);
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

  async function recoverableSession() {
    const session = await storageGet(SESSION_KEY).catch(() => null);
    if (!session?.active || !session.payload?.scenes?.length) {
      throw new Error("No saved session was found.");
    }
    if (session.nextIndex >= session.payload.scenes.length) {
      await clearSession();
      throw new Error("The saved session is already complete.");
    }
    return session;
  }

  async function startFromSession(session) {
    if (running || startRequested) {
      throw new Error("Automation is already running.");
    }
    startRequested = true;
    runQueue(session.payload, session.nextIndex, session).catch(() => {
      startRequested = false;
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GROK_AUTO_PING_V2") {
      sendResponse({ ok: true, version: SCRIPT_VERSION });
      return false;
    }

    if (message?.type === "GROK_AUTO_STOP_V2") {
      stopRequested = true;
      clearSession().catch(() => {});
      status("Stop requested. The current step will stop shortly.");
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "GROK_AUTO_RESUME_V2") {
      recoverableSession()
        .then((session) => startFromSession(session))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "GROK_AUTO_RETRY_SCENE_V2") {
      recoverableSession()
        .then(async (session) => {
          await saveSession(session.payload, session.nextIndex, true, { phase: "start", previousUrl: "" });
          return recoverableSession();
        })
        .then((session) => startFromSession(session))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "GROK_AUTO_SKIP_SCENE_V2") {
      recoverableSession()
        .then(async (session) => {
          const nextIndex = session.nextIndex + 1;
          if (nextIndex >= session.payload.scenes.length) {
            await clearSession();
            status("Skipped the last scene. No more scenes to run.");
            return null;
          }
          await saveSession(session.payload, nextIndex, true, { phase: "start", previousUrl: "" });
          return recoverableSession();
        })
        .then((session) => {
          if (session) return startFromSession(session);
          return null;
        })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "GROK_AUTO_CLEAR_SESSION_V2") {
      clearSession()
        .then(() => {
          stopRequested = true;
          status("Saved session was cleared.");
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "GROK_AUTO_START_V2") {
      if (running || startRequested) {
        sendResponse({ ok: false, error: "Automation is already running." });
        return false;
      }

      startRequested = true;
      message.payload.runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
