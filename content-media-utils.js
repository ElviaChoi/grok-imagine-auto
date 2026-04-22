(() => {
  if (window.GrokAutoMediaUtils) return;

  function downloadableImageUrl(url = "") {
    return /^https?:/i.test(url) && /\/generated\/|assets\.grok\.com\/users|imagine-public\.x\.ai/i.test(url);
  }

  function imageUrlLooksLikeAsset(url = "") {
    return /^https?:/i.test(url) && /\.(png|jpe?g|webp)(?:[?#]|$)/i.test(url);
  }

  function cssBackgroundUrl(el) {
    const value = getComputedStyle(el).backgroundImage || "";
    const match = /url\((["']?)(.*?)\1\)/i.exec(value);
    return match?.[2] || "";
  }

  function firstSrcsetUrl(value = "") {
    return String(value || "")
      .split(",")
      .map((entry) => entry.trim().split(/\s+/)[0])
      .find(Boolean) || "";
  }

  function imageLikeUrlFromElement(el) {
    if (!el) return "";
    const tag = el.tagName?.toLowerCase();
    if (tag === "img") return el.currentSrc || el.src || "";
    if (tag === "source") return firstSrcsetUrl(el.srcset) || el.src || "";
    if (tag === "picture") {
      const img = el.querySelector("img");
      const source = el.querySelector("source[srcset]");
      return imageLikeUrlFromElement(img) || imageLikeUrlFromElement(source);
    }
    if (tag === "a") return el.href || "";
    return cssBackgroundUrl(el);
  }

  function ignoredImageContext(el) {
    if (!el) return false;
    if (el.closest(".query-bar, form, [contenteditable='true'], #grok-auto-overlay")) return true;
    if (el.closest("nav, aside, [role='navigation'], [aria-label='Sidebar']")) return true;
    if (el.closest("button[aria-label='\uC800\uC7A5\uB428'], button[aria-label='Saved']")) return true;
    return false;
  }

  function imageUrlLooksPreviewOnly(url = "") {
    return /\/preview_image\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(url) || /[?&]cache=1(?:&|$)/i.test(url);
  }

  function cardLooksLargeEnoughForDirectPreview(card = {}) {
    const width = card.naturalWidth || card.renderedWidth || 0;
    const height = card.naturalHeight || card.renderedHeight || 0;
    return Math.min(width, height) >= 180 && width * height >= 120_000;
  }

  function imageUrlLooksGenerated(url = "") {
    return /\/generated\/|assets\.grok\.com\/users|imagine-public\.x\.ai/i.test(url);
  }

  function inlineImageUrlLooksResult(url = "") {
    return /^data:image\/(?:png|jpe?g|webp)[;,]/i.test(url);
  }

  function imageItemLooksFinal(item) {
    if (!item?.url) return false;
    if (imageUrlLooksPreviewOnly(item.url)) return false;
    const isInlineResult = inlineImageUrlLooksResult(item.url);
    if (/^blob:/i.test(item.url)) return false;
    if (/^data:image\//i.test(item.url) && !isInlineResult) return false;
    if (item.tag === "video") return false;
    if (/loading|skeleton|placeholder|shimmer/i.test(`${item.className} ${item.cardClass}`)) return false;

    if (item.tag === "img") {
      if (!item.complete) return false;
      if (item.naturalWidth && item.naturalHeight) {
        if (isInlineResult) {
          const renderedArea = (item.renderedWidth || 0) * (item.renderedHeight || 0);
          const naturalArea = item.naturalWidth * item.naturalHeight;
          const largeEnough =
            Math.min(item.naturalWidth, item.naturalHeight) >= 300 ||
            item.renderedWidth >= 480 ||
            item.renderedHeight >= 270 ||
            naturalArea >= 150_000 ||
            renderedArea >= 120_000;
          if (!largeEnough) return false;
        } else {
          if (Math.min(item.naturalWidth, item.naturalHeight) < 512) return false;
          if (item.naturalWidth * item.naturalHeight < 500_000) return false;
        }
      }
      if ((item.renderedWidth || 0) < 240 || (item.renderedHeight || 0) < 160) return false;
    } else if (Math.min(item.renderedWidth || 0, item.renderedHeight || 0) < 512) {
      return false;
    }

    return isInlineResult || imageUrlLooksGenerated(item.url) || (item.tag === "img" && imageUrlLooksLikeAsset(item.url));
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

  function safeFilePart(value) {
    return (value || "grok-video")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  window.GrokAutoMediaUtils = Object.freeze({
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
  });
})();
