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
const nativeDownloadWatches = new Map();

function findNativeWatch(item) {
  const createdAt = item.startTime ? Date.parse(item.startTime) : Date.now();
  return [...nativeDownloadWatches.entries()].find(([, watch]) => {
    if (watch.downloadId) return false;
    return createdAt >= watch.startedAt - 2000;
  });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let filename = pendingFilenames.get(item.id) || pendingFilenames.get(item.url) || pendingFilenames.get(item.finalUrl);
  if (!filename) {
    const nativeWatch = findNativeWatch(item);
    if (nativeWatch) {
      const [token, watch] = nativeWatch;
      filename = watch.filename;
      watch.downloadId = item.id;
      pendingFilenames.set(item.id, filename);
      pendingFilenames.set(item.url, filename);
      if (item.finalUrl) pendingFilenames.set(item.finalUrl, filename);
      nativeDownloadWatches.set(token, watch);
    }
  }

  if (filename) {
    suggest({ filename, conflictAction: "uniquify" });
    return;
  }

  suggest();
});

chrome.downloads.onCreated.addListener((item) => {
  const nativeWatch = findNativeWatch(item);
  if (!nativeWatch) return;
  const [token, watch] = nativeWatch;
  watch.downloadId = item.id;
  pendingFilenames.set(item.id, watch.filename);
  if (item.url) pendingFilenames.set(item.url, watch.filename);
  if (item.finalUrl) pendingFilenames.set(item.finalUrl, watch.filename);
  nativeDownloadWatches.set(token, watch);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GROK_AUTO_EXPECT_NATIVE_DOWNLOAD") {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    nativeDownloadWatches.set(token, {
      token,
      filename: message.filename,
      startedAt: Date.now(),
      downloadId: null
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

    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      nativeDownloadWatches.delete(message.token);
      sendResponse({ ok: false, error: "Native download completion timed out." });
    }, 10 * 60 * 1000);
    let done = false;

    function finish(ok, payload = {}) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      nativeDownloadWatches.delete(message.token);
      if (watch.downloadId) pendingFilenames.delete(watch.downloadId);
      sendResponse({ ok, downloadId: watch.downloadId, ...payload });
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

  pendingFilenames.set(message.url, message.filename);

  chrome.downloads.download(
    {
      url: message.url,
      filename: message.filename,
      saveAs: false,
      conflictAction: "uniquify"
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        pendingFilenames.delete(message.url);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      pendingFilenames.set(downloadId, message.filename);

      const timeout = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChanged);
        pendingFilenames.delete(downloadId);
        pendingFilenames.delete(message.url);
        sendResponse({ ok: false, error: "Download completion timed out.", downloadId });
      }, 10 * 60 * 1000);

      function onChanged(delta) {
        if (delta.id !== downloadId || !delta.state?.current) {
          return;
        }

        if (delta.state.current === "complete") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(onChanged);
          pendingFilenames.delete(downloadId);
          pendingFilenames.delete(message.url);
          sendResponse({ ok: true, downloadId });
        }

        if (delta.state.current === "interrupted") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(onChanged);
          pendingFilenames.delete(downloadId);
          pendingFilenames.delete(message.url);
          sendResponse({ ok: false, error: "Download was interrupted.", downloadId });
        }
      }

      chrome.downloads.onChanged.addListener(onChanged);
    }
  );

  return true;
});
