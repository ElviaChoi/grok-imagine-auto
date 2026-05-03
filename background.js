importScripts("placeholder-guard.js");

const {
  imageUrlLooksLikeBlackDotPlaceholder
} = globalThis.GrokAutoPlaceholderGuard;

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
const BACKGROUND_VERSION = "2026-05-04-placeholder-mime-v9";
let filenameListenerReleaseTimer = null;

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

function handleDeterminingFilename(item, suggest) {
  pruneExpiredDownloadTrackers();

  if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) {
    suggest();
    scheduleFilenameListenerRelease();
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
    scheduleFilenameListenerRelease();
    return;
  }

  suggest();
  scheduleFilenameListenerRelease();
}

function ensureFilenameListener() {
  if (filenameListenerReleaseTimer) {
    clearTimeout(filenameListenerReleaseTimer);
    filenameListenerReleaseTimer = null;
  }
  if (!chrome.downloads.onDeterminingFilename.hasListener(handleDeterminingFilename)) {
    chrome.downloads.onDeterminingFilename.addListener(handleDeterminingFilename);
  }
}

function scheduleFilenameListenerRelease() {
  if (filenameListenerReleaseTimer) clearTimeout(filenameListenerReleaseTimer);
  filenameListenerReleaseTimer = setTimeout(() => {
    pruneExpiredDownloadTrackers();
    if (pendingExtensionDownloads.size || nativeDownloadWatches.size) {
      scheduleFilenameListenerRelease();
      return;
    }
    if (chrome.downloads.onDeterminingFilename.hasListener(handleDeterminingFilename)) {
      chrome.downloads.onDeterminingFilename.removeListener(handleDeterminingFilename);
    }
  }, 1000);
}

function pruneExpiredDownloadTrackers() {
  const now = Date.now();
  for (const [token, pending] of pendingExtensionDownloads.entries()) {
    if (pending.expiresAt <= now && !pending.downloadId) {
      pendingExtensionDownloads.delete(token);
    }
  }
  for (const [token, watch] of nativeDownloadWatches.entries()) {
    if (watch.expiresAt <= now && !watch.downloadId) {
      nativeDownloadWatches.delete(token);
    }
  }
}

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

  if (message?.type === "GROK_AUTO_CLICK_VIDEO_CHOICE_MAIN") {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: "No active Grok tab was found." });
      return false;
    }

    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const buttons = [...document.querySelectorAll("button")]
          .filter(visible)
          .filter((button) => {
            const text = normalize(`${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`);
            return text.includes("선호") || text.includes("prefer");
          })
          .map((button) => {
            const card = button.closest(".group") || button.closest("article") || button;
            const rect = card.getBoundingClientRect();
            return { button, card, left: rect.left, top: rect.top, area: rect.width * rect.height };
          })
          .filter((item) => item.area > 20_000)
          .sort((a, b) => {
            const rowDelta = a.top - b.top;
            if (Math.abs(rowDelta) > 32) return rowDelta;
            return a.left - b.left;
          });

        const target = buttons[0];
        if (!target?.button) return { clicked: false, reason: "button-not-found" };

        const event = {
          currentTarget: target.button,
          target: target.button,
          nativeEvent: {
            currentTarget: target.button,
            target: target.button,
            composedPath: () => [target.button, target.card, document.body, document]
          },
          preventDefault() {},
          stopPropagation() {},
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
          closest: (...args) => target.button.closest(...args),
          getAttribute: (...args) => target.button.getAttribute(...args),
          matches: (...args) => target.button.matches(...args)
        };
        const callReactHandlers = (el) => {
          let calls = 0;
          let errors = 0;
          for (const key of Object.keys(el || {})) {
            if (!key.startsWith("__reactProps$")) continue;
            const props = el[key];
            for (const name of ["onPointerDown", "onMouseDown", "onClick", "onMouseUp", "onPointerUp"]) {
              if (typeof props?.[name] === "function") {
                try {
                  props[name](event);
                  calls += 1;
                } catch {
                  errors += 1;
                  try {
                    props[name](target.button);
                    calls += 1;
                  } catch {
                    errors += 1;
                  }
                }
              }
            }
          }
          return { calls, errors };
        };

        target.button.scrollIntoView({ block: "center", inline: "center" });
        target.button.focus?.();
        target.button.click?.();
        const buttonResult = callReactHandlers(target.button);
        const cardResult = callReactHandlers(target.card);
        return {
          clicked: true,
          reactCalls: buttonResult.calls + cardResult.calls,
          reactErrors: buttonResult.errors + cardResult.errors
        };
      }
    })
      .then((results) => sendResponse({ ok: true, result: results?.[0]?.result || null }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
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
          sendResponse({ ok: false, error: "이미지 임시 데이터가 만료되었습니다. 사이드 패널에서 다시 시작해 주세요." });
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
      sendResponse({ ok: false, error: "저장 파일명이 올바르지 않습니다." });
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
    ensureFilenameListener();
    scheduleFilenameListenerRelease();
    sendResponse({ ok: true, token });
    return false;
  }

  if (message?.type === "GROK_AUTO_WAIT_NATIVE_DOWNLOAD") {
    const watch = nativeDownloadWatches.get(message.token);
    if (!watch) {
      sendResponse({ ok: false, error: "브라우저 다운로드 상태를 찾지 못했습니다." });
      return false;
    }

    const noDownloadTimeout = setTimeout(() => {
      if (!watch.downloadId) finish(false, { error: "다운로드가 시작되지 않았습니다. Chrome 팝업 차단에 막혔을 수 있습니다." });
    }, 8_000);
    const timeout = setTimeout(() => finish(false, { error: "다운로드 완료 대기 시간이 초과되었습니다." }), 10 * 60 * 1000);
    let done = false;

    function finish(ok, payload = {}) {
      if (done) return;
      done = true;
      clearTimeout(noDownloadTimeout);
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      nativeDownloadWatches.delete(message.token);
      scheduleFilenameListenerRelease();
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
      if (delta.state.current === "interrupted") finish(false, { error: "다운로드가 중단되었습니다." });
    }

    chrome.downloads.onChanged.addListener(onChanged);
    if (watch.downloadId) {
      chrome.downloads.search({ id: watch.downloadId }, (items) => {
        const item = items?.[0];
        if (item?.state === "complete") finish(true);
        if (item?.state === "interrupted") finish(false, { error: "다운로드가 중단되었습니다." });
      });
    }
    return true;
  }

  if (!message || message.type !== "GROK_AUTO_DOWNLOAD") {
    return false;
  }

  if (!validFilename(message.filename)) {
    sendResponse({ ok: false, error: "저장 파일명이 올바르지 않습니다." });
    return false;
  }

  imageUrlLooksLikeBlackDotPlaceholder(message.url, { filename: message.filename })
    .then((looksLikePlaceholder) => {
      if (looksLikePlaceholder) {
        sendResponse({
          ok: false,
          error: "Grok returned a loading placeholder image instead of the generated result, so the file was not downloaded. Please retry this scene after the final image appears."
        });
        return;
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
  ensureFilenameListener();
  scheduleFilenameListenerRelease();

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
        scheduleFilenameListenerRelease();
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
        sendResponse({ ok: false, error: "다운로드 완료 대기 시간이 초과되었습니다.", downloadId });
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
          scheduleFilenameListenerRelease();
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
          finish(false, { error: "다운로드가 중단되었습니다." });
        }
      }

      chrome.downloads.onChanged.addListener(onChanged);
    }
  );
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
