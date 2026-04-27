(() => {
  const SCRIPT_VERSION = "2026-04-23-single-click-v53";
  const DEBUG = false;
  const OVERLAY_PROGRESS_HIDE_MS = 2500;
  const OVERLAY_SUCCESS_HIDE_MS = 4000;
  const OVERLAY_FADE_MS = 250;

  if (window.__grokImagineVideoAutomatorVersion === SCRIPT_VERSION) {
    return;
  }
  window.__grokImagineVideoAutomatorVersion = SCRIPT_VERSION;
  window.__grokImagineVideoAutomatorLoaded = true;

  if (!window.GrokAutoShared) {
    throw new Error("GrokAutoShared was not loaded before content.js.");
  }
  if (!window.GrokAutoMediaUtils) {
    throw new Error("GrokAutoMediaUtils was not loaded before content.js.");
  }
  if (!window.GrokAutoDomUtils) {
    throw new Error("GrokAutoDomUtils was not loaded before content.js.");
  }

  const {
    SESSION_KEY,
    DOWNLOADS_KEY,
    SEEN_RESULT_CARD_ATTR,
    IMAGINE_URL,
    DEFAULT_GENERATION,
    WAIT,
    sleep,
    storageGet,
    storageSet,
    storageRemove,
    normalize,
    visible,
    fire,
    previousUrlSet,
    mediaUrlKey
  } = window.GrokAutoShared;
  const {
    downloadableImageUrl,
    imageUrlLooksLikeAsset,
    cssBackgroundUrl,
    firstSrcsetUrl,
    imageLikeUrlFromElement,
    ignoredImageContext,
    imageUrlLooksPreviewOnly,
    cardLooksLargeEnoughForDirectPreview,
    imageUrlLooksGenerated,
    inlineImageUrlLooksResult,
    imageItemLooksFinal,
    imageExtensionForUrl,
    filenameWithImageExtension,
    blobUrlToDataUrl,
    safeFilePart
  } = window.GrokAutoMediaUtils;
  const {
    click,
    clickAt,
    closeOpenMenus,
    findClickableByTextOrLabel,
    findVisibleTextElement,
    findOpenMoreButton,
    chooseRadio,
    findOptionButton
  } = window.GrokAutoDomUtils;

  let stopRequested = false;
  let running = false;
  let startRequested = false;
  let activeRunId = "";
  let lastDebugSnapshot = null;
  let overlayHideTimeout = null;
  let overlayFadeTimeout = null;
  const downloadedUrls = new Set();

  function sessionPayload(payload) {
    return {
      ...payload,
      scenes: (payload.scenes || []).map((scene) => ({
        ...scene,
        image: scene.image
          ? { id: scene.image.id, name: scene.image.name, type: scene.image.type }
          : undefined
      }))
    };
  }

  async function saveSession(payload, nextIndex, active = true, extra = {}) {
    await storageSet(SESSION_KEY, {
      active,
      nextIndex,
      payload: sessionPayload(payload),
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

  function status(text, options = {}) {
    console.log(`[Grok Auto] ${text}`);
    const statusRunning = running && !/^(All done:|Stopped:|Stop requested\.|완료:|중지됨:|중지 요청됨)/.test(text);
    chrome.runtime.sendMessage({ type: "GROK_AUTO_STATUS", text, running: statusRunning }).catch(() => {});
    const toastMarkers = [
      "완료:",
      "· 완료되었습니다",
      "프롬프트를 입력하고 생성을 시작합니다",
      "720p 비디오가 바로 생성되었습니다",
      "업스케일 시작",
      "업스케일 처리 중",
      "업스케일 완료",
      "업스케일 실패",
      "이어서 진행할 작업이 있습니다",
      "중지됨:",
      "중지 요청됨",
      "건너뛰었습니다",
      "기록을 삭제했습니다",
      "찾지 못했습니다",
      "문제가 생겼습니다"
    ];
    const shouldToast = options.toast ?? toastMarkers.some((marker) => text.includes(marker));
    if (!shouldToast) return;
    renderOverlay(text, {
      autoHideMs: options.toastDurationMs ?? (statusRunning ? OVERLAY_PROGRESS_HIDE_MS : OVERLAY_SUCCESS_HIDE_MS)
    });
  }

  function debug(label, data = {}) {
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
    if (DEBUG) console.log(`[Grok Auto Debug] ${label}: ${JSON.stringify(safeData)}`);
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
      `currentImages: ${snapshot.currentImages}`,
      snapshot.detailCandidates ? `detailCandidates: ${JSON.stringify(snapshot.detailCandidates).slice(0, 1200)}` : ""
    ].join("\n");
  }

  function clearOverlayTimers() {
    if (overlayHideTimeout) {
      clearTimeout(overlayHideTimeout);
      overlayHideTimeout = null;
    }
    if (overlayFadeTimeout) {
      clearTimeout(overlayFadeTimeout);
      overlayFadeTimeout = null;
    }
  }

  function renderOverlay(text, { autoHideMs = 0 } = {}) {
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
        boxShadow: "0 8px 24px rgba(0,0,0,.28)",
        opacity: "1",
        transform: "translateY(0)",
        transition: `opacity ${OVERLAY_FADE_MS}ms ease, transform ${OVERLAY_FADE_MS}ms ease`,
        pointerEvents: "none"
      });
      document.documentElement.appendChild(box);
    }

    clearOverlayTimers();
    box.textContent = text;
    box.style.opacity = "1";
    box.style.transform = "translateY(0)";

    if (autoHideMs > 0) {
      overlayHideTimeout = window.setTimeout(() => {
        box.style.opacity = "0";
        box.style.transform = "translateY(-6px)";
        overlayFadeTimeout = window.setTimeout(() => {
          if (box.isConnected) box.remove();
          overlayFadeTimeout = null;
        }, OVERLAY_FADE_MS);
        overlayHideTimeout = null;
      }, autoHideMs);
    }
  }

  function assertNotStopped() {
    if (stopRequested) {
      throw new Error("사용자가 작업을 중지했습니다.");
    }
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
        [
          ".query-bar button[type='submit'][aria-label='\uC81C\uCD9C']",
          ".query-bar button[type='submit'][aria-label='Submit']",
          ".query-bar button[type='submit']",
          ".query-bar button[aria-label='\uC81C\uCD9C']",
          ".query-bar button[aria-label='Submit']",
          ".query-bar button[aria-label='Send']",
          "button[type='submit'][aria-label='\uC81C\uCD9C']",
          "button[type='submit'][aria-label='Submit']"
        ].join(", ")
      )
    ]
      .filter(visible)
      .filter((button) => {
        if (!enabledOnly) return true;
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        const label = normalize(button.getAttribute("aria-label"));
        const text = normalize(button.innerText || button.textContent);
        if (button.type === "submit" || /제출|submit|send/i.test(`${label} ${text}`)) return true;
        if (button.closest("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]")) return false;
        return false;
      });

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
    const expected = normalize(prompt).slice(0, 60);
    const latestEditor = findPromptEditor();
    const latestText = promptEditorText(latestEditor);
    if (onImagineHome() && expected && latestText.includes(expected)) return false;
    if (!editor?.isConnected) {
      return latestEditor && promptIsEmpty(latestEditor);
    }
    const text = promptEditorText(editor);
    return !text;
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

  async function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      assertNotStopped();
      const result = await predicate();
      if (result) return result;
      await sleep(500);
    }
    throw new Error(`${label} 대기 시간이 초과되었습니다.`);
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

  async function chooseAspectRatio(aspectRatio) {
    const wanted = [aspectRatio];
    const queryBar = document.querySelector(".query-bar") || document;
    const trigger =
      queryBar.querySelector("button[aria-label='\uC885\uD6A1\uBE44'], button[aria-label='Aspect ratio']") ||
      [...queryBar.querySelectorAll("button")]
        .filter(visible)
        .find((button) => /(?:^|\s)(?:16:9|9:16|2:3|3:2|1:1)(?:\s|$)/.test(normalize(button.innerText || button.textContent)));
    if (trigger) {
      click(trigger);
      await sleep(300);
      const menuOption = findOptionButton(wanted);
      if (menuOption) {
        click(menuOption);
        await sleep(300);
      }
      await closeOpenMenus();
      return;
    }

    await chooseRadio(
      ["\uBE44\uC728", "\uD654\uBA74 \uBE44\uC728", "\uAC00\uB85C\uC138\uB85C \uBE44\uC728", "aspect ratio"],
      wanted,
      400
    );
    await closeOpenMenus();
  }

  async function ensureGenerationSettings(settings = DEFAULT_GENERATION) {
    const generation = { ...DEFAULT_GENERATION, ...(settings || {}) };

    await chooseRadio(
      ["\uC0DD\uC131 \uBAA8\uB4DC", "generation mode"],
      generation.mode === "image" ? ["\uC774\uBBF8\uC9C0", "image"] : ["\uBE44\uB514\uC624", "video"],
      500
    );

    await chooseAspectRatio(generation.aspectRatio);

    if (generation.mode !== "video") {
      await chooseRadio(
        ["\uC774\uBBF8\uC9C0", "\uC774\uBBF8\uC9C0 \uBC29\uC2DD", "\uBC29\uC2DD", "image", "quality"],
        generation.imageQuality === "quality"
          ? ["\uD488\uC9C8", "quality"]
          : ["\uC18D\uB3C4", "speed"],
        400
      );
      await closeOpenMenus();
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
    await closeOpenMenus();
  }

  async function ensureDefaultSettings() {
    await ensureGenerationSettings(DEFAULT_GENERATION);
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
        if (ignoredImageContext(item.img) || ignoredImageContext(item.card)) return false;
        if (!item.url) return false;
        if (imageUrlLooksPreviewOnly(item.url)) return false;
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        if (/profile-picture|pfp/i.test(item.url)) return false;
        if (item.area < 10_000 && !/generated image/i.test(item.alt)) return false;
        return (
          /generated image/i.test(item.alt) ||
          imageUrlLooksGenerated(item.url) ||
          inlineImageUrlLooksResult(item.url)
        ) && imageItemLooksFinal(item);
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

  function elementHasSeenMarker(el, marker) {
    if (!el || !marker || typeof el.getAttribute !== "function") return false;
    return el.getAttribute(SEEN_RESULT_CARD_ATTR) === marker;
  }

  function resultCardHasSeenMarker(card, marker) {
    if (!card || !marker) return false;
    return [card.root, card.card, card.img, card.media, card.clickTarget].some((el) => elementHasSeenMarker(el, marker));
  }

  function markResultCard(card, marker) {
    if (!card || !marker) return;
    [card.root, card.card, card.img, card.media, card.clickTarget]
      .filter(Boolean)
      .forEach((el) => {
        if (typeof el.setAttribute === "function") el.setAttribute(SEEN_RESULT_CARD_ATTR, marker);
      });
  }

  function markExistingImageResultCards(marker) {
    const cards = resultImageCards();
    cards.forEach((card) => markResultCard(card, marker));
    debug("marked existing image result cards", { marker, count: cards.length });
    return marker;
  }

  function unmarkedResultImageCards(marker = "") {
    const cards = resultImageCards();
    return marker ? cards.filter((card) => !resultCardHasSeenMarker(card, marker)) : cards;
  }

  function currentNewImageItems(previousUrls = "", seenMarker = "") {
    const previous = previousUrlSet(previousUrls);
    return currentImageItems().filter(
      (item) => !previous.has(item.key) && !previous.has(item.url) && !resultCardHasSeenMarker(item, seenMarker)
    );
  }

  function currentImageUrls() {
    return [...new Set(currentImageItems().map((item) => item.key))];
  }

  function currentImageUrl(previousUrls = "") {
    const images = currentNewImageItems(previousUrls);
    return images[0]?.url || "";
  }

  function directImageItemFromCard(card, index = 0, previousUrls = "") {
    const url = card?.url || imageLikeUrlFromElement(card?.img || card?.media);
    if (!url || /^detail:/i.test(url)) return null;
    if (imageUrlLooksPreviewOnly(url) && !cardLooksLargeEnoughForDirectPreview(card)) return null;
    if (!downloadableImageUrl(url) && !inlineImageUrlLooksResult(url)) return null;
    if (card.naturalWidth && card.naturalHeight) {
      if (inlineImageUrlLooksResult(url)) {
        const renderedArea = (card.renderedWidth || 0) * (card.renderedHeight || 0);
        const naturalArea = card.naturalWidth * card.naturalHeight;
        const largeEnough =
          Math.min(card.naturalWidth, card.naturalHeight) >= 300 ||
          card.renderedWidth >= 480 ||
          card.renderedHeight >= 270 ||
          naturalArea >= 150_000 ||
          renderedArea >= 120_000;
        if (!largeEnough) return null;
      } else {
        const isLargePreview = imageUrlLooksPreviewOnly(url) && cardLooksLargeEnoughForDirectPreview(card);
        if (!isLargePreview && Math.min(card.naturalWidth, card.naturalHeight) < 512) return null;
        if (!isLargePreview && card.naturalWidth * card.naturalHeight < 500_000) return null;
      }
    }
    const previous = previousUrlSet(previousUrls);
    if (previous.has(url) || previous.has(mediaUrlKey(url))) return null;
    return {
      ...card,
      index,
      url,
      key: mediaUrlKey(url),
      detailOnly: false
    };
  }

  function detailImageItemFromGeneratedItem(item, index = 0) {
    return {
      ...item,
      detailOnly: true,
      index,
      sourceUrl: item.url,
      root: item.card || item.root,
      media: item.img || item.media,
      clickTarget: item.card || item.img || item.media || item.root
    };
  }

  function detailCardKey(card = {}) {
    const url = card.url || imageLikeUrlFromElement(card.img || card.media);
    if (url) return `url:${mediaUrlKey(url)}`;
    return [
      "box",
      Math.round(card.left || 0),
      Math.round(card.top || 0),
      Math.round(card.renderedWidth || 0),
      Math.round(card.renderedHeight || 0),
      Math.round(card.naturalWidth || 0),
      Math.round(card.naturalHeight || 0)
    ].join(":");
  }

  function currentDetailCardKeys() {
    return resultImageCards().map(detailCardKey);
  }

  async function waitForGeneratedImages(previousUrl, settings = DEFAULT_GENERATION, previousDetailKeys = [], seenMarker = "") {
    const started = Date.now();
    let lastReport = 0;
    let lastSignature = "";
    let stableSince = 0;
    let lastItems = [];
    let firstSeenItems = [];
    let firstSeenAt = 0;
    const previousDetailSet = new Set(previousDetailKeys);

    while (Date.now() - started < WAIT.generate) {
      assertNotStopped();

      const items = currentNewImageItems(previousUrl, seenMarker);
      const detailCards = resultImageCards();
      const candidateDetailCards = unmarkedResultImageCards(seenMarker);
      const newDetailCards = candidateDetailCards.filter((card) => !previousDetailSet.has(detailCardKey(card)));
      const signature = [
        ...items.map((item) => item.key),
        ...newDetailCards.map((card) => detailCardKey(card))
      ].join("|");

      if (items.length && !firstSeenItems.length) {
        firstSeenItems = items.filter((item) => {
          if (imageUrlLooksPreviewOnly(item.url) && !cardLooksLargeEnoughForDirectPreview(item)) return false;
          const width = item.naturalWidth || item.renderedWidth || 0;
          const height = item.naturalHeight || item.renderedHeight || 0;
          return Math.min(width, height) >= 240 && width * height >= 180_000;
        });
        if (!firstSeenItems.length) continue;
        firstSeenAt = Date.now();
      }

      if (firstSeenItems.length && Date.now() - firstSeenAt >= 2_000) {
        const selected = firstSeenItems.slice(0, 1).map((item, index) => detailImageItemFromGeneratedItem(item, index));
        const item = selected[0];
        status(
          `이미지 결과를 찾았습니다.\n첫 번째 이미지만 자동 저장합니다.\n감지된 이미지: ${firstSeenItems.length}개 · 저장 크기: ${item.naturalWidth || Math.round(item.renderedWidth)}x${item.naturalHeight || Math.round(item.renderedHeight)}`
        );
        return selected;
      }

      if (signature && signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
        lastItems = items;
      }

      const requiredStable = 12_000;
      if (lastSignature && Date.now() - stableSince >= requiredStable) {
        await sleep(WAIT.afterGenerate);
        const latestItems = currentNewImageItems(previousUrl, seenMarker);
        const latestDetailCards = unmarkedResultImageCards(seenMarker).filter(
          (card) => !previousDetailSet.has(detailCardKey(card))
        );
        const directSelected = (latestItems.length ? latestItems : lastItems).slice(0, 1);
        const selected =
          directSelected.length && detailCards.length
            ? directSelected.map((item, index) => detailImageItemFromGeneratedItem(item, index))
            : directSelected.length
              ? directSelected.map((item, index) => detailImageItemFromGeneratedItem(item, index))
              : latestDetailCards.slice(0, 1).map((card, index) => detailImageItemFromGeneratedItem(card, index));
        if (!selected.length) {
          lastSignature = "";
          lastItems = [];
          continue;
        }
        const savedItem = directSelected[0] || selected[0];
        const method = "detail page";
        status(
          `이미지 결과가 준비되었습니다.\n첫 번째 이미지만 자동 저장합니다.\n나머지 결과는 Grok 화면에서 직접 저장할 수 있습니다.\n저장 크기: ${savedItem.naturalWidth || Math.round(savedItem.renderedWidth)}x${savedItem.naturalHeight || Math.round(savedItem.renderedHeight)}`
        );
        return selected;
      }

        if (!items.length && newDetailCards.length && Date.now() - started > 4_000) {
        const selected = [{ detailOnly: true, index: 0, url: "detail:0" }];
        status(
          `이미지 결과 카드가 보입니다.\n첫 번째 결과를 자동 저장합니다. (1/${newDetailCards.length})\n나머지는 Grok 화면에서 직접 저장할 수 있습니다.`
        );
        debug("using detail download fallback", {
          cards: detailCards.length,
          newCards: newDetailCards.length,
          first: {
            url: newDetailCards[0].url,
            naturalWidth: newDetailCards[0].naturalWidth,
            naturalHeight: newDetailCards[0].naturalHeight,
            renderedWidth: Math.round(newDetailCards[0].renderedWidth || 0),
            renderedHeight: Math.round(newDetailCards[0].renderedHeight || 0)
          }
        });
        await sleep(WAIT.afterGenerate);
        return [detailImageItemFromGeneratedItem(newDetailCards[0], 0)];
      }

      if (Date.now() - lastReport > 10_000) {
        const previousCount = previousUrlSet(previousUrl).size;
        if (!items.length && newDetailCards.length) {
          const selected = [{ detailOnly: true, index: 0, url: "detail:0" }];
          status(
            `이미지 결과 카드가 보입니다.\n첫 번째 결과를 자동 저장합니다. (1/${newDetailCards.length})\n나머지는 Grok 화면에서 직접 저장할 수 있습니다.`
          );
          debug("using detail download fallback", {
            cards: detailCards.length,
            newCards: newDetailCards.length,
            first: {
              url: newDetailCards[0].url,
              naturalWidth: newDetailCards[0].naturalWidth,
              naturalHeight: newDetailCards[0].naturalHeight
            }
          });
          await sleep(WAIT.afterGenerate);
          return [detailImageItemFromGeneratedItem(newDetailCards[0], 0)];
        }
        status(
          `이미지 생성 결과를 기다리는 중입니다.\n새 이미지: ${items.length}개 · 결과 카드: ${newDetailCards.length}개`
        );
        debug("image wait check", {
          detected: currentImageItems().length,
          previous: previousCount,
          newItems: items.length,
          detailCards: detailCards.length,
          newDetailCards: newDetailCards.length,
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
      .filter((img) => !ignoredImageContext(img))
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
        if (ignoredImageContext(item.img) || ignoredImageContext(item.root) || ignoredImageContext(item.clickTarget)) {
          return false;
        }
        if (/profile-picture|pfp/i.test(item.url)) return false;
        if (imageUrlLooksPreviewOnly(item.url) && !cardLooksLargeEnoughForDirectPreview(item)) return false;
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
      .filter((el) => !ignoredImageContext(el))
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
        if (item.renderedWidth > 760 || item.renderedHeight > 760) return false;
        if (aspect < 0.42 || aspect > 4.2) return false;
        if (text.length > 80) return false;
        if (el.matches("button, a, svg, input, textarea, [contenteditable='true']")) return false;
        if (ignoredImageContext(el)) return false;
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

  function clickableResultTarget(card = {}) {
    const start = card.img || card.media || card.clickTarget || card.root;
    let el = start;
    while (el && el !== document.body) {
      if (ignoredImageContext(el)) return start;
      const style = getComputedStyle(el);
      const className = String(el.className || "");
      if (
        el.matches?.("a, button, [role='button'], [tabindex]") ||
        style.cursor === "pointer" ||
        /cursor-pointer|media-post-masonry-card|group\/media|group/i.test(className)
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return card.root || start;
  }

  function findUpscaleChoiceCards() {
    const cards = resultImageCards()
      .filter((item) => {
        if (!item?.root || !item?.clickTarget) return false;
        if (ignoredImageContext(item.root) || ignoredImageContext(item.clickTarget)) return false;
        if (item.renderedWidth < 180 || item.renderedHeight < 120) return false;
        if (item.renderedWidth > window.innerWidth * 0.45) return false;
        if (item.renderedHeight > window.innerHeight * 0.65) return false;
        if (item.top < 80 || item.top > window.innerHeight - 120) return false;
        if (item.left < 120 || item.left > window.innerWidth - 120) return false;
        if (item.root.closest("nav, aside, .query-bar, form, [contenteditable='true'], #grok-auto-overlay")) return false;
        return true;
      })
      .sort((a, b) => {
        const rowDelta = a.top - b.top;
        if (Math.abs(rowDelta) > 32) return rowDelta;
        return a.left - b.left;
      });

    if (cards.length < 2) return [];
    const firstRowTop = cards[0].top;
    const firstRow = cards.filter((card) => Math.abs(card.top - firstRowTop) <= 32);
    return firstRow.length >= 2 ? firstRow : cards.slice(0, 2);
  }

  async function chooseUpscaleCandidate(prefer = "left") {
    const cards = await waitFor(() => {
      const found = findUpscaleChoiceCards();
      return found.length >= 2 ? found : null;
    }, 8_000, "upscale choice cards").catch(() => null);

    if (!cards?.length) return false;

    const sorted = [...cards].sort((a, b) => a.left - b.left);
    const target = prefer === "right" ? sorted[sorted.length - 1] : sorted[0];
    debug("upscale candidate auto-select", {
      prefer,
      candidates: sorted.map((item) => ({
        left: Math.round(item.left || 0),
        top: Math.round(item.top || 0),
        renderedWidth: Math.round(item.renderedWidth || 0),
        renderedHeight: Math.round(item.renderedHeight || 0),
        naturalWidth: item.naturalWidth || 0,
        naturalHeight: item.naturalHeight || 0,
        url: item.url
      }))
    });
    click(clickableResultTarget(target));
    await sleep(800);
    return true;
  }

  function findDetailDownloadButton() {
    const buttons = [...document.querySelectorAll("button[aria-label='\uB2E4\uC6B4\uB85C\uB4DC'], button[aria-label='Download']")]
      .filter(visible)
      .filter((button) => !button.disabled)
      .filter((button) => !button.closest(".query-bar, form, [contenteditable='true'], #grok-auto-overlay"));

    return buttons.find((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width >= 24 && rect.height >= 24 && rect.left > window.innerWidth * 0.45;
    }) || buttons.at(-1) || null;
  }

  function detailImageFromElement(el) {
    if (!el || !visible(el) || ignoredImageContext(el)) return null;
    const rect = el.getBoundingClientRect();
    let url = imageLikeUrlFromElement(el);
    if (!url && el.tagName?.toLowerCase() === "canvas") {
      try {
        url = el.toDataURL("image/png");
      } catch {
        url = "";
      }
    }
    if (!url || /^data:image\/svg/i.test(url)) return null;
    if (!/^https?:|^blob:|^data:image\//i.test(url)) return null;
    if (imageUrlLooksPreviewOnly(url) && rect.width * rect.height < 120_000) return null;
    if (rect.width < 240 || rect.height < 160 || rect.width * rect.height < 120_000) return null;
    return {
      el,
      tag: el.tagName?.toLowerCase() || "",
      url,
      naturalWidth: el.naturalWidth || 0,
      naturalHeight: el.naturalHeight || 0,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      area: rect.width * rect.height
    };
  }

  function isImaginePostDetailPage() {
    return /\/imagine\/post\//.test(location.pathname);
  }

  function findDetailArticleImage() {
    if (!isImaginePostDetailPage()) return null;
    const article = document.querySelector("article");
    const images = [...(article || document).querySelectorAll("img[src^='data:image/'], img[class*='object-cover']")]
      .map(detailImageFromElement)
      .filter(Boolean)
      .sort((a, b) => b.area - a.area);
    return images[0] || null;
  }

  function findDetailMainImage() {
    const articleImage = findDetailArticleImage();
    if (articleImage) return articleImage;

    const backgroundCandidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => cssBackgroundUrl(el));
    const candidates = [
      ...document.querySelectorAll("img, picture, source[srcset], a[href], canvas"),
      ...backgroundCandidates
    ];

    const seen = new Set();
    return candidates
      .filter((el) => !ignoredImageContext(el))
      .map((el) => {
        const media =
          el.tagName?.toLowerCase() === "source"
            ? el.closest("picture")?.querySelector("img") || el.closest("picture") || el
            : el;
        const rect = (visible(media) ? media : el.parentElement || el).getBoundingClientRect();
        let url = imageLikeUrlFromElement(el);
        if (!url && el.tagName?.toLowerCase() === "canvas") {
          try {
            url = el.toDataURL("image/png");
          } catch {
            url = "";
          }
        }
        return {
          el,
          tag: el.tagName?.toLowerCase() || "",
          url,
          naturalWidth: el.naturalWidth || media.naturalWidth || 0,
          naturalHeight: el.naturalHeight || media.naturalHeight || 0,
          renderedWidth: rect.width,
          renderedHeight: rect.height,
          area: rect.width * rect.height
        };
      })
      .filter((item) => {
        if (ignoredImageContext(item.el)) return false;
        const key = mediaUrlKey(item.url);
        if (seen.has(key)) return false;
        seen.add(key);
        if (!item.url || /^data:image\/svg/i.test(item.url)) return false;
        if (imageUrlLooksPreviewOnly(item.url) && !cardLooksLargeEnoughForDirectPreview(item)) return false;
        if (/profile-picture|pfp/i.test(item.url)) return false;
        if (!/^https?:|^blob:|^data:image\//i.test(item.url)) return false;
        if (item.renderedWidth < 240 || item.renderedHeight < 160) return false;
        if (item.area < 120_000) return false;
        if (item.el.closest("button, nav, aside, [role='navigation']")) return false;
        if (item.el.getBoundingClientRect().left < 220 && item.el.getBoundingClientRect().top < 120) return false;
        if (item.naturalWidth && item.naturalHeight) {
          if (Math.min(item.naturalWidth, item.naturalHeight) < 180) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const score = (item) => {
          const generated = imageUrlLooksGenerated(item.url) || /^data:image\//i.test(item.url) || /^blob:/i.test(item.url) ? 1_000_000 : 0;
          const naturalArea = item.naturalWidth * item.naturalHeight;
          return generated + Math.max(item.area, naturalArea);
        };
        return score(b) - score(a);
      })[0] || null;
  }

  async function openDetailDownloadButton(card) {
    if (isImaginePostDetailPage()) {
      const existingDetailImage = findDetailMainImage();
      if (existingDetailImage) return existingDetailImage;
    }

    const openTarget = clickableResultTarget(card);
    if (ignoredImageContext(openTarget)) {
      throw new Error("The selected image target is inside the prompt bar or sidebar, so it is not a generated result card.");
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const beforeUrl = location.href;
      debug("detail open attempt", {
        attempt,
        target: openTarget,
        targetTag: openTarget?.tagName?.toLowerCase(),
        targetClass: String(openTarget?.className || "").slice(0, 120),
        location: location.href
      });
      const targets = [
        { el: openTarget, x: 0.5, y: 0.5 },
        { el: card.root, x: 0.5, y: 0.5 },
        { el: card.img || card.media, x: 0.5, y: 0.5 },
        { el: openTarget, x: 0.9, y: 0.5 },
        { el: openTarget, x: 0.92, y: 0.18 }
      ].filter((target) => target.el);
      const target = targets[Math.min(attempt - 1, targets.length - 1)];
      clickAt(target.el, target.x, target.y);
      if (/\/imagine\/saved(?:$|[/?#])/.test(location.href)) {
        history.back();
        await sleep(1000);
        throw new Error("The selected target opened Grok Saved instead of the generated image detail. Retrying with stricter card filtering is required.");
      }
      const opened = await waitFor(
        () => {
          const onDetailPage = isImaginePostDetailPage();
          const movedToDetail = onDetailPage || (location.href !== beforeUrl && /\/imagine\/(?!$|\?)/.test(location.pathname));
          const detailImage = movedToDetail ? findDetailMainImage() : null;
          const detailButton = movedToDetail ? findDetailDownloadButton() : null;
          return detailImage || detailButton || null;
        },
        attempt === 4 ? WAIT.page : 3_000,
        "detail image or download button"
      ).catch(
        () => null
      );
      if (opened) return opened;
      await sleep(400);
    }

    throw new Error("detail image timed out.");
  }

  async function downloadImageViaDetail(itemOrIndex, filename) {
    const index = typeof itemOrIndex === "number" ? itemOrIndex : itemOrIndex?.index || 0;
    if (isImaginePostDetailPage()) {
      const existingDetailImage = await waitFor(() => findDetailMainImage(), 8_000, "current detail image").catch(() => null);
      if (existingDetailImage?.url) {
        const directFilename = filenameWithImageExtension(filename, existingDetailImage.url);
        status(`이미지를 저장하는 중입니다.\n${directFilename}`);
        await downloadMedia(existingDetailImage.url, directFilename);
        return;
      }
    }

    const card = typeof itemOrIndex === "object" && (itemOrIndex.root || itemOrIndex.clickTarget)
      ? itemOrIndex
      : await waitFor(() => {
          const found = resultImageCards();
          return found.length ? found[Math.min(index, found.length - 1)] : null;
        }, WAIT.generate, "image result cards");
    if (!card) throw new Error("Could not find an image result card to open.");

    status(`저장할 이미지 화면을 여는 중입니다. (${index + 1}번째 결과)`);
    debug("detail download opening card", {
      index,
      filename,
      card: card.root,
      clickTarget: card.clickTarget || card.img || card.media || card.root,
      imageUrl: card.sourceUrl || card.url,
      naturalWidth: card.naturalWidth,
      naturalHeight: card.naturalHeight
    });

    const opened = await openDetailDownloadButton(card);
    const button = opened instanceof Element ? opened : findDetailDownloadButton();
    const detailImage = opened?.url
      ? opened
      : await waitFor(() => findDetailMainImage(), 8_000, "detail image for direct download").catch(() => null);
    if (detailImage?.url) {
      const directFilename = filenameWithImageExtension(filename, detailImage.url);
      status(`이미지를 저장하는 중입니다.\n${directFilename}`);
      await downloadMedia(detailImage.url, directFilename);
      return;
    }

    debug("detail image source not found", {
      button,
      detailCandidates: rawImageCandidateSummary(10)
    });

    if (button) {
      throw new Error(
        "The Grok detail image was opened, but the displayed image source could not be read. " +
        "Automation intentionally did not click Grok's download button because Chrome treats that as an untrusted synthetic click and may block it as a pop-up.\n" +
        debugSummary()
      );
    }

    throw new Error(`Could not find the detail download button or the displayed detail image.\n${debugSummary()}`);
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

  async function resolveImagePayload(image) {
    if (image?.dataUrl) return image;
    if (!image?.id) throw new Error("장면 이미지가 없습니다. 사이드 패널에서 다시 시작해 주세요.");
    const response = await chrome.runtime.sendMessage({
      type: "GROK_AUTO_GET_IMAGE_PAYLOAD",
      imageId: image.id
    });
    if (!response?.ok) throw new Error(response?.error || "장면 이미지를 불러오지 못했습니다.");
    return response.image;
  }

  async function releaseImagePayload(image) {
    if (!image?.id) return;
    await chrome.runtime.sendMessage({
      type: "GROK_AUTO_DELETE_IMAGE_PAYLOAD",
      imageId: image.id
    }).catch(() => {});
  }

  async function releasePayloadImages(payload, startIndex = 0) {
    await Promise.all((payload?.scenes || []).slice(startIndex).map((scene) => releaseImagePayload(scene.image)));
  }

  async function uploadImage(image) {
    image = await resolveImagePayload(image);
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
    status(`프롬프트 입력이 준비되었습니다.\n입력 길이: ${promptEditorText(editor).length}자`);
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

    status("프롬프트를 제출하는 중입니다.");
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
            findSubmitButton(true, document)
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
    status("프롬프트 제출이 완료되었습니다.");
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
    status("비디오 결과가 준비되었습니다. 저장 준비 중입니다.");
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
        status("업스케일 버튼 확인 중");
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
      status("업스케일 버튼 없음, 현재 화질로 저장");
      return before;
    }

    status("업스케일 시작");
    click(button);
    await chooseUpscaleCandidate("left").catch(() => false);
    status("업스케일 처리 중");

    try {
      const url = await waitForStableVideo(true, before, WAIT.upscale, "upscale");
      status("업스케일 완료");
      await sleep(WAIT.afterUpscale);
      return url;
    } catch (error) {
      status(`업스케일 실패\n현재 화질로 저장\n${error.message}`);
      return currentVideoUrl(false) || before;
    }
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

    const requestedFolder = filename.includes("/") ? filename.split("/")[0] : "";
    if (requestedFolder && response.actualFilename) {
      const actual = response.actualFilename.replace(/\\/g, "/");
      if (!actual.includes(`/${requestedFolder}/`)) {
        throw new Error(
          `Chrome saved the file outside the requested folder.\nRequested: ${filename}\nActual: ${response.actualFilename}`
        );
      }
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
    let currentPreviousDetailKeys = resumeState?.previousDetailKeys || [];

    try {
      for (let i = startAt; i < scenes.length; i += 1) {
        currentIndex = i;
        assertNotStopped();
        const state =
          i === startAt && resumeState && resumeState.nextIndex === i
            ? resumeState
            : null;
        let previousUrl = state?.previousUrl || "";
        let previousDetailKeys = state?.previousDetailKeys || [];
        let phase = state?.phase || "start";
        let finalMediaUrl = state?.finalMediaUrl || "";
        let previousDetailMarker = "";
        currentPhase = phase;
        currentPreviousUrl = previousUrl;
        currentPreviousDetailKeys = previousDetailKeys;
        currentFinalMediaUrl = finalMediaUrl;

        await saveSession(payload, i, true, { phase, previousUrl, finalMediaUrl });

        const scene = scenes[i];
        const number = startIndex + i;
        const padded = String(number).padStart(2, "0");
        const total = scenes.length;
        const sceneLabel = `장면 ${i + 1}/${total}`;

        if (phase === "submitted") {
          status(`${sceneLabel} · 이미 제출된 작업입니다.\n생성 결과를 기다리는 중입니다.`);
        } else if (phase === "downloading" && finalMediaUrl) {
          status(`${sceneLabel} · 결과를 찾았습니다.\n저장을 다시 시도하는 중입니다.`);
        } else {
          status(`${sceneLabel} · Grok Imagine 화면을 준비하는 중입니다.`);
          await ensureImagineHome();
          await ensureGenerationSettings(generation);

          previousUrl = generation.mode === "video" ? currentVideoUrl(false) : currentImageUrls();
          previousDetailKeys = generation.mode === "image" ? currentDetailCardKeys() : [];
          previousDetailMarker =
            generation.mode === "image" ? markExistingImageResultCards(`${payload.runId}:${i}:${Date.now()}`) : "";
          currentPreviousUrl = previousUrl;
          currentPreviousDetailKeys = previousDetailKeys;
          await saveSession(payload, i, true, { phase: "editing", previousUrl, previousDetailKeys });
          currentPhase = "editing";

          if (scene.image) {
            status(`${sceneLabel} · 이미지를 업로드하는 중입니다.`);
            await uploadImage(scene.image);
            await ensureGenerationSettings(generation);
          } else {
            status(`${sceneLabel} · 프롬프트만 사용합니다.\n이미지 업로드는 건너뜁니다.`);
          }

          status(`${sceneLabel} · 프롬프트를 입력하고 생성을 시작합니다.`);
          const promptEditor = await setPrompt(scene.prompt);
          phase = "submitting";
          currentPhase = phase;
          await saveSession(payload, i, true, { phase, previousUrl, previousDetailKeys });
          await submitPrompt(promptEditor, {
            prompt: scene.prompt,
            requirePromptEcho: generation.mode !== "video"
          });
          phase = "submitted";
          currentPhase = phase;
          await saveSession(payload, i, true, { phase, previousUrl, previousDetailKeys });
        }

        const isVideo = generation.mode === "video";
        const retryingPendingDownload = phase === "downloading" && finalMediaUrl;
        let imageItems = [];
        if (retryingPendingDownload) {
          status(`${sceneLabel} · 저장이 끝나지 않은 작업을 다시 확인합니다.`);
          if (!isVideo) {
            imageItems = await waitForGeneratedImages(previousUrl, generation, previousDetailKeys, previousDetailMarker);
            finalMediaUrl = imageItems[0]?.url || "";
            currentFinalMediaUrl = mediaUrlKey(finalMediaUrl);
          }
        } else {
          status(`${sceneLabel} · ${isVideo ? "비디오" : "이미지"} 생성 결과를 기다리는 중입니다.`);

          if (isVideo) {
            finalMediaUrl = await waitForGeneratedVideo(previousUrl);
            currentFinalMediaUrl = finalMediaUrl;
            if (upscale && generation.resolution !== "720p") {
              finalMediaUrl = await tryUpscale();
              currentFinalMediaUrl = finalMediaUrl;
            } else if (generation.resolution === "720p") {
              status("720p 비디오가 바로 생성되었습니다. 고화질 변환 없이 저장합니다.");
            }
          } else {
            imageItems = await waitForGeneratedImages(previousUrl, generation, previousDetailKeys, previousDetailMarker);
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
          previousDetailKeys,
          finalMediaUrl: currentFinalMediaUrl
        });
        await loadDownloadedUrls();

        if (isVideo) {
          const filename = `${baseFilename}.mp4`;
          status(`${sceneLabel} · 비디오를 저장하는 중입니다.\n${filename}`);
          if (retryingPendingDownload && downloadedUrls.has(mediaUrlKey(finalMediaUrl))) {
            status(`${sceneLabel} · 이미 저장된 파일입니다.\n다음 장면으로 넘어갑니다.`);
          } else {
            await downloadMedia(finalMediaUrl, filename);
          }
        } else {
          if (!imageItems.length) {
            imageItems = await waitForGeneratedImages(previousUrl, generation, previousDetailKeys, previousDetailMarker);
          }
          for (let imageIndex = 0; imageIndex < imageItems.length; imageIndex += 1) {
            const item = imageItems[imageIndex];
            const suffix = imageItems.length > 1 ? `_${String(imageIndex + 1).padStart(2, "0")}` : "";
            const filename = `${baseFilename}${suffix}.${item.detailOnly ? "png" : imageExtensionForUrl(item.url)}`;
            status(`${sceneLabel} · 첫 번째 이미지 결과를 저장하는 중입니다.\n${filename}`);
            const itemDownloadKey = mediaUrlKey(item.sourceUrl || item.url);
            if (retryingPendingDownload && downloadedUrls.has(itemDownloadKey)) {
              status(`${sceneLabel} · 이미지 ${imageIndex + 1}은 이미 저장되어 있습니다.`);
            } else {
              await downloadImageViaDetail(item, filename);
            }
          }
        }

        await releaseImagePayload(scene.image);
        await saveSession(payload, i + 1, true, { phase: "ready", previousUrl: "" });
        status(`${sceneLabel} · 완료되었습니다.`);

        if (i < scenes.length - 1) {
          await goBackToImagine();
        }
      }

      await clearSession();
      status(`완료: ${scenes.length}개 ${generation.mode === "video" ? "비디오" : "이미지"} 작업이 끝났습니다.`);
    } catch (error) {
      const summary = debugSummary();
      console.warn(`[Grok Auto Debug Summary]\n${summary}`);
      if (stopRequested) {
        await releasePayloadImages(payload, currentIndex);
        await clearSession();
      } else {
        await saveSession(payload, currentIndex, true, {
          phase: currentPhase,
          previousUrl: currentPreviousUrl,
          previousDetailKeys: currentPreviousDetailKeys,
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
      status(`중지됨: ${error.message}\n문제가 계속되면 콘솔의 디버그 정보를 확인해 주세요.`);
      throw error;
    } finally {
      running = false;
    }
  }

  async function resumeIfNeeded() {
    const session = await storageGet(SESSION_KEY).catch(() => null);
    if (!session?.active || !session.payload?.scenes?.length) return;
    if (session.nextIndex >= session.payload.scenes.length) {
      await clearSession();
      return;
    }
    status("이어서 진행할 작업이 있습니다. 사이드 패널에서 이어하기, 다시 시도, 기록 삭제를 선택해 주세요.");
  }

  async function recoverableSession() {
    const session = await storageGet(SESSION_KEY).catch(() => null);
    if (!session?.active || !session.payload?.scenes?.length) {
      throw new Error("저장된 진행 기록을 찾지 못했습니다.");
    }
    if (session.nextIndex >= session.payload.scenes.length) {
      await clearSession();
      throw new Error("저장된 진행 기록은 이미 완료되었습니다.");
    }
    return session;
  }

  async function startFromSession(session) {
    if (running || startRequested) {
      throw new Error("이미 자동화가 실행 중입니다.");
    }
    startRequested = true;
    runQueue(session.payload, session.nextIndex, session).catch(() => {
      startRequested = false;
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GROK_AUTO_PING_V2") {
      sendResponse({ ok: true, version: SCRIPT_VERSION, running: running || startRequested });
      return false;
    }

    if (message?.type === "GROK_AUTO_STOP_V2") {
      stopRequested = true;
      recoverableSession().then((session) => releasePayloadImages(session.payload, session.nextIndex)).catch(() => {}).then(() => clearSession());
      status("중지 요청됨. 현재 단계가 정리되면 멈춥니다.");
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
          await releaseImagePayload(session.payload.scenes[session.nextIndex]?.image);
          const nextIndex = session.nextIndex + 1;
          if (nextIndex >= session.payload.scenes.length) {
            await clearSession();
            status("마지막 장면을 건너뛰었습니다. 더 실행할 장면이 없습니다.");
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
      recoverableSession()
        .then((session) => releasePayloadImages(session.payload))
        .catch(() => {})
        .then(() => clearSession())
        .then(() => {
          stopRequested = true;
          status("저장된 진행 기록을 삭제했습니다.");
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "GROK_AUTO_START_V2") {
      if (running || startRequested) {
        sendResponse({ ok: false, error: "이미 자동화가 실행 중입니다." });
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
