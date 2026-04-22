chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!chrome.sidePanel?.open || !tab?.windowId) {
    return;
  }

  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

const pendingFilenames = new Map();
const pendingExtensionDownloads = new Map();
const nativeDownloadWatches = new Map();
const IMAGE_PAYLOAD_PREFIX = "grokVideoAutoImage:";
const BACKGROUND_VERSION = "2026-04-22-direct-image-v4";

async function pruneImagePayloads() {
  const stored = await chrome.storage.local.get(null);
  const now = Date.now();
  const expired = Object.entries(stored)
    .filter(([key, item]) => key.startsWith(IMAGE_PAYLOAD_PREFIX) && now - (item?.createdAt || 0) > 6 * 60 * 60 * 1000)
    .map(([key]) => key);
  if (expired.length) await chrome.storage.local.remove(expired);
}

function validFilename(value) {
  return typeof value === "string" && value.trim() && value.trim() !== "()";
}

function mapSet(map, key, value) {
  if (key && value) map.set(key, value);
}

function mapDelete(map, key) {
  if (key) map.delete(key);
}

function looksLikeGrokDownload(item = {}) {
  const values = [item.url, item.finalUrl, item.referrer].filter(Boolean).join(" ");
  return /grok\.com|assets\.grok\.com|imagine-public\.x\.ai/i.test(values);
}

function findNativeWatch(item = {}) {
  if (!looksLikeGrokDownload(item)) return null;
  const createdAt = item.startTime ? Date.parse(item.startTime) : Date.now();
  return [...nativeDownloadWatches.entries()].find(([, watch]) => {
    if (watch.downloadId) return false;
    return createdAt >= watch.startedAt - 1000 && createdAt <= watch.expiresAt;
  });
}

function findPendingExtensionDownload(item = {}) {
  const createdAt = item.startTime ? Date.parse(item.startTime) : Date.now();
  return [...pendingExtensionDownloads.entries()].find(([, pending]) => {
    if (pending.downloadId) return false;
    return createdAt >= pending.startedAt - 1000 && createdAt <= pending.expiresAt;
  });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }

  let filename =
    pendingFilenames.get(item.id) ||
    pendingFilenames.get(item.url) ||
    pendingFilenames.get(item.finalUrl);

  if (!filename && item.byExtensionId === chrome.runtime.id) {
    const pendingDownload = findPendingExtensionDownload(item);
    if (pendingDownload) {
      const [token, pending] = pendingDownload;
      filename = pending.filename;
      pending.downloadId = item.id;
      mapSet(pendingFilenames, item.id, filename);
      mapSet(pendingFilenames, item.url, filename);
      mapSet(pendingFilenames, item.finalUrl, filename);
      pendingExtensionDownloads.set(token, pending);
    }
  }

  if (!filename && !item.byExtensionId) {
    const nativeWatch = findNativeWatch(item);
    if (nativeWatch) {
      const [token, watch] = nativeWatch;
      filename = watch.filename;
      watch.downloadId = item.id;
      mapSet(pendingFilenames, item.id, filename);
      mapSet(pendingFilenames, item.url, filename);
      mapSet(pendingFilenames, item.finalUrl, filename);
      nativeDownloadWatches.set(token, watch);
    }
  }

  if (validFilename(filename)) {
    suggest({ filename, conflictAction: "uniquify" });
    return;
  }

  suggest();
});

chrome.downloads.onCreated.addListener((item) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const pendingDownload = findPendingExtensionDownload(item);
    if (pendingDownload) {
      const [token, pending] = pendingDownload;
      pending.downloadId = item.id;
      mapSet(pendingFilenames, item.id, pending.filename);
      mapSet(pendingFilenames, item.url, pending.filename);
      mapSet(pendingFilenames, item.finalUrl, pending.filename);
      pendingExtensionDownloads.set(token, pending);
    }
  }

  const nativeWatch = findNativeWatch(item);
  if (!nativeWatch) return;
  const [token, watch] = nativeWatch;
  watch.downloadId = item.id;
  mapSet(pendingFilenames, item.id, watch.filename);
  mapSet(pendingFilenames, item.url, watch.filename);
  mapSet(pendingFilenames, item.finalUrl, watch.filename);
  nativeDownloadWatches.set(token, watch);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GROK_AUTO_BACKGROUND_INFO") {
    sendResponse({
      ok: true,
      version: BACKGROUND_VERSION,
      manifestVersion: chrome.runtime.getManifest().version
    });
    return false;
  }

  if (message?.type === "GROK_AUTO_STORE_IMAGE_PAYLOAD") {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pruneImagePayloads()
      .then(() => chrome.storage.local.set({
        [`${IMAGE_PAYLOAD_PREFIX}${id}`]: {
          id,
          name: message.image?.name || "reference.png",
          type: message.image?.type || "image/png",
          dataUrl: message.image?.dataUrl || "",
          createdAt: Date.now()
        }
      }))
      .then(() => sendResponse({ ok: true, imageId: id }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GROK_AUTO_GET_IMAGE_PAYLOAD") {
    chrome.storage.local.get(`${IMAGE_PAYLOAD_PREFIX}${message.imageId}`)
      .then((result) => {
        const image = result[`${IMAGE_PAYLOAD_PREFIX}${message.imageId}`];
        if (!image?.dataUrl) {
          sendResponse({ ok: false, error: "Image payload is no longer available. Please restart from the side panel." });
          return;
        }
        sendResponse({ ok: true, image });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GROK_AUTO_DELETE_IMAGE_PAYLOAD") {
    chrome.storage.local.remove(`${IMAGE_PAYLOAD_PREFIX}${message.imageId}`)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GROK_AUTO_EXPECT_NATIVE_DOWNLOAD") {
    if (!validFilename(message.filename)) {
      sendResponse({ ok: false, error: "Invalid native download filename." });
      return false;
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    nativeDownloadWatches.set(token, {
      token,
      filename: message.filename,
      startedAt: Date.now(),
      downloadId: null,
      expiresAt: Date.now() + 45_000
    });
    sendResponse({ ok: true, token });
    return false;
  }

  if (message?.type === "GROK_AUTO_WAIT_NATIVE_DOWNLOAD") {
    const watch = nativeDownloadWatches.get(message.token);
    if (!watch) {
      sendResponse({ ok: false, error: "Native download watch was not found." });
      return false;
    }

    const noDownloadTimeout = setTimeout(() => {
      if (!watch.downloadId) finish(false, { error: "Native download was not created. It may have been blocked by Chrome pop-up protection." });
    }, 8_000);
    const timeout = setTimeout(() => finish(false, { error: "Native download completion timed out." }), 10 * 60 * 1000);
    let done = false;

    function finish(ok, payload = {}) {
      if (done) return;
      done = true;
      clearTimeout(noDownloadTimeout);
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      nativeDownloadWatches.delete(message.token);
      if (watch.downloadId) mapDelete(pendingFilenames, watch.downloadId);
      if (!watch.downloadId) {
        sendResponse({
          ok,
          downloadId: null,
          requestedFilename: watch.filename,
          actualFilename: "",
          ...payload
        });
        return;
      }
      chrome.downloads.search({ id: watch.downloadId }, (items) => {
        const item = items?.[0];
        sendResponse({
          ok,
          downloadId: watch.downloadId,
          requestedFilename: watch.filename,
          actualFilename: item?.filename || "",
          ...payload
        });
      });
    }

    function onChanged(delta) {
      if (!watch.downloadId || delta.id !== watch.downloadId || !delta.state?.current) return;
      if (delta.state.current === "complete") finish(true);
      if (delta.state.current === "interrupted") finish(false, { error: "Native download was interrupted." });
    }

    chrome.downloads.onChanged.addListener(onChanged);
    if (watch.downloadId) {
      chrome.downloads.search({ id: watch.downloadId }, (items) => {
        const item = items?.[0];
        if (item?.state === "complete") finish(true);
        if (item?.state === "interrupted") finish(false, { error: "Native download was interrupted." });
      });
    }
    return true;
  }

  if (!message || message.type !== "GROK_AUTO_DOWNLOAD") {
    return false;
  }

  if (!validFilename(message.filename)) {
    sendResponse({ ok: false, error: "Invalid download filename." });
    return false;
  }

  const pendingToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingExtensionDownloads.set(pendingToken, {
    token: pendingToken,
    filename: message.filename,
    startedAt: Date.now(),
    expiresAt: Date.now() + 45_000,
    downloadId: null
  });
  mapSet(pendingFilenames, message.url, message.filename);

  chrome.downloads.download(
    {
      url: message.url,
      filename: message.filename,
      saveAs: false,
      conflictAction: "uniquify"
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        pendingExtensionDownloads.delete(pendingToken);
        mapDelete(pendingFilenames, message.url);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      const pending = pendingExtensionDownloads.get(pendingToken);
      if (pending) {
        pending.downloadId = downloadId;
        pendingExtensionDownloads.set(pendingToken, pending);
      }
      mapSet(pendingFilenames, downloadId, message.filename);

      const timeout = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChanged);
        pendingExtensionDownloads.delete(pendingToken);
        mapDelete(pendingFilenames, downloadId);
        mapDelete(pendingFilenames, message.url);
        sendResponse({ ok: false, error: "Download completion timed out.", downloadId });
      }, 10 * 60 * 1000);

      function onChanged(delta) {
        if (delta.id !== downloadId || !delta.state?.current) {
          return;
        }

        function finish(ok, payload = {}) {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(onChanged);
          pendingExtensionDownloads.delete(pendingToken);
          mapDelete(pendingFilenames, downloadId);
          mapDelete(pendingFilenames, message.url);
          chrome.downloads.search({ id: downloadId }, (items) => {
            const item = items?.[0];
            sendResponse({
              ok,
              downloadId,
              requestedFilename: message.filename,
              actualFilename: item?.filename || "",
              ...payload
            });
          });
        }

        if (delta.state.current === "complete") {
          finish(true);
        }

        if (delta.state.current === "interrupted") {
          finish(false, { error: "Download was interrupted." });
        }
      }

      chrome.downloads.onChanged.addListener(onChanged);
    }
  );

  return true;
});
