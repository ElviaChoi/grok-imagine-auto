(() => {
  if (window.GrokAutoShared) return;

  const SESSION_KEY = "grokVideoAutoSession";
  const DOWNLOADS_KEY = "grokVideoAutoDownloadedUrls";
  const SEEN_RESULT_CARD_ATTR = "data-grok-auto-seen-result";
  const IMAGINE_URL = "https://grok.com/imagine";
  const DEFAULT_GENERATION = {
    sourceType: "imagePrompt",
    mode: "video",
    imageQuality: "speed",
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

  window.GrokAutoShared = Object.freeze({
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
  });
})();
