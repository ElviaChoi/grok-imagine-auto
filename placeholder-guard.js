(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.GrokAutoPlaceholderGuard) return;

  const DEFAULT_MAX_BLOB_SIZE = 220_000;

  function imageDownloadFilename(filename = "") {
    return /\.(png|jpe?g|webp)$/i.test(String(filename || ""));
  }

  async function decodedImageFromBlob(blob) {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.()
      };
    }

    if (!root.document || typeof root.Image !== "function") return null;

    const objectUrl = URL.createObjectURL(blob);
    const image = new root.Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    return {
      image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      close: () => URL.revokeObjectURL(objectUrl)
    };
  }

  function createSampleCanvas(width, height) {
    if (typeof OffscreenCanvas === "function") {
      return new OffscreenCanvas(width, height);
    }
    if (root.document) {
      const canvas = root.document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    return null;
  }

  async function imageBlobLooksLikeBlackDotPlaceholder(blob, options = {}) {
    const maxBlobSize = options.maxBlobSize || DEFAULT_MAX_BLOB_SIZE;
    if (!blob || blob.size > maxBlobSize) return false;
    if (!/^image\/(?:png|jpe?g|webp)$/i.test(blob.type || "image/png")) return false;

    let decoded;
    try {
      decoded = await decodedImageFromBlob(blob);
    } catch {
      return false;
    }
    if (!decoded) return false;

    try {
      if (decoded.width < 300 || decoded.height < 180) return false;

      const canvas = createSampleCanvas(96, 64);
      const ctx = canvas?.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;

      ctx.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      let lightNeutral = 0;
      let saturated = 0;
      let mid = 0;
      let total = 0;

      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 16) continue;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        total += 1;
        if (lum < 35 && max - min < 30) {
          dark += 1;
        } else if (lum > 180 && max - min < 45) {
          lightNeutral += 1;
        } else if (max - min > 60 && lum > 40) {
          saturated += 1;
        } else {
          mid += 1;
        }
      }

      if (!total) return false;
      const darkRatio = dark / total;
      const lightRatio = lightNeutral / total;
      const saturatedRatio = saturated / total;
      const midRatio = mid / total;

      return darkRatio > 0.82 && lightRatio > 0.04 && lightRatio < 0.18 && saturatedRatio < 0.01 && midRatio < 0.05;
    } finally {
      decoded.close();
    }
  }

  async function imageUrlLooksLikeBlackDotPlaceholder(url, options = {}) {
    if (options.filename && !imageDownloadFilename(options.filename)) return false;
    if (!/^https?:|^data:image\/|^blob:/i.test(url || "")) return false;

    try {
      const response = await fetch(url, /^https?:/i.test(url) ? { cache: "no-store" } : undefined);
      if (!response.ok) return false;
      return imageBlobLooksLikeBlackDotPlaceholder(await response.blob(), options);
    } catch {
      return false;
    }
  }

  root.GrokAutoPlaceholderGuard = Object.freeze({
    imageDownloadFilename,
    imageBlobLooksLikeBlackDotPlaceholder,
    imageUrlLooksLikeBlackDotPlaceholder
  });
})();
