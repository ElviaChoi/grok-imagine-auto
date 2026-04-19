const $ = (selector) => document.querySelector(selector);

const STORAGE_KEY = "grokVideoAutoSettings";
const DEFAULT_SCENE_COUNT = 3;
const TARGET_SCENE_COUNT = 20;
const DEFAULT_SETTINGS = {
  mode: "video",
  resolution: "480p",
  duration: "6s",
  aspectRatio: "16:9"
};

const sceneList = $("#sceneList");
const statusEl = $("#status");
const startButton = $("#start");
const stopButton = $("#stop");

let saveTimer = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 250);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createSceneRow(index, prompt = "") {
  const row = document.createElement("article");
  row.className = "scene";
  row.dataset.scene = String(index);
  row.innerHTML = `
    <div class="scene-head">
      <strong>장면 ${index + 1}</strong>
      <button type="button" class="remove-scene" title="장면 삭제">삭제</button>
    </div>
    <label class="field">
      <span>이미지</span>
      <input class="scene-image" type="file" accept="image/*">
      <small class="file-name">선택된 이미지 없음</small>
    </label>
    <label class="field">
      <span>프롬프트</span>
      <textarea class="scene-prompt" rows="3" placeholder="이 장면에 사용할 프롬프트">${escapeHtml(prompt)}</textarea>
    </label>
  `;

  row.querySelector(".scene-prompt").addEventListener("input", scheduleSave);
  row.querySelector(".scene-image").addEventListener("change", (event) => {
    const file = event.target.files[0];
    row.querySelector(".file-name").textContent = file ? file.name : "선택된 이미지 없음";
  });
  row.querySelector(".remove-scene").addEventListener("click", () => {
    row.remove();
    renumberScenes();
    scheduleSave();
  });

  return row;
}

function setSceneImage(row, file) {
  if (!file) return;
  const input = row.querySelector(".scene-image");
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function addScene(prompt = "") {
  sceneList.appendChild(createSceneRow(sceneList.children.length, prompt));
}

function renumberScenes() {
  [...sceneList.children].forEach((row, index) => {
    row.dataset.scene = String(index);
    row.querySelector("strong").textContent = `장면 ${index + 1}`;
  });
}

function ensureSceneCount(count) {
  while (sceneList.children.length < count) {
    addScene("");
  }
  while (sceneList.children.length > count) {
    sceneList.lastElementChild.remove();
  }
  renumberScenes();
  scheduleSave();
}

function getPromptValues() {
  return [...sceneList.querySelectorAll(".scene-prompt")].map((input) => input.value);
}

function clearPromptValues() {
  sceneList.querySelectorAll(".scene-prompt").forEach((input) => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  setStatus("프롬프트를 모두 지웠습니다. 이미지 선택은 유지됩니다.");
}

function setSegmentedValue(name, value) {
  const group = document.querySelector(`.segmented[data-setting="${name}"]`);
  if (!group) return;
  group.querySelectorAll("button[data-value]").forEach((button) => {
    button.classList.toggle("active", button.dataset.value === value);
  });
}

function getSegmentedValue(name) {
  return (
    document.querySelector(`.segmented[data-setting="${name}"] button.active`)?.dataset.value ||
    DEFAULT_SETTINGS[name]
  );
}

function getGenerationSettings() {
  return {
    mode: getSegmentedValue("mode"),
    resolution: getSegmentedValue("resolution"),
    duration: getSegmentedValue("duration"),
    aspectRatio: getSegmentedValue("aspectRatio")
  };
}

function splitLegacyPrompts(value) {
  if (!value) return [];
  return String(value).split(/\r?\n/);
}

function baseFileName(value) {
  return String(value || "")
    .trim()
    .split(/[\\/]/)
    .pop()
    .trim();
}

function stripExtension(value) {
  return baseFileName(value).replace(/\.[^.]+$/, "");
}

function fileKey(value) {
  return baseFileName(value).toLowerCase();
}

function fileStemKey(value) {
  return stripExtension(value).toLowerCase();
}

function parseDelimitedRows(text) {
  const normalized = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const delimiter = normalized.split("\n", 1)[0].includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!quoted && char === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function tableRowsToScenes(rows) {
  if (!rows.length) return [];

  const header = rows[0].map((value) => value.trim().toLowerCase());
  const hasHeader = header.some((value) =>
    ["image", "imagefile", "file", "filename", "이미지", "파일명", "prompt", "프롬프트"].includes(value)
  );
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const imageIndex = hasHeader
    ? header.findIndex((value) => ["image", "imagefile", "file", "filename", "이미지", "파일명"].includes(value))
    : 0;
  const promptIndex = hasHeader
    ? header.findIndex((value) => ["prompt", "프롬프트"].includes(value))
    : 1;

  return dataRows
    .map((row) => ({
      imageName: (row[imageIndex] || "").trim(),
      prompt: (row[promptIndex >= 0 ? promptIndex : 0] || "").trim()
    }))
    .filter((item) => item.prompt || item.imageName);
}

async function importScenesFromTable() {
  const tableFile = $("#tableFile").files[0];
  if (!tableFile) {
    throw new Error("CSV 또는 TSV 파일을 선택해 주세요.");
  }
  if (/\.(xlsx|xls)$/i.test(tableFile.name)) {
    throw new Error("엑셀 .xlsx 파일은 직접 읽을 수 없습니다. 엑셀에서 'CSV UTF-8'로 저장한 파일을 선택해 주세요.");
  }

  const text = await readFileAsText(tableFile);
  const imported = tableRowsToScenes(parseDelimitedRows(text));
  if (!imported.length) {
    throw new Error("가져올 장면이 없습니다. image,prompt 형식인지 확인해 주세요.");
  }

  const imageFiles = [...$("#bulkImages").files];
  const imageMap = new Map();
  imageFiles.forEach((file) => {
    if (!imageMap.has(fileKey(file.name))) imageMap.set(fileKey(file.name), file);
    if (!imageMap.has(fileStemKey(file.name))) imageMap.set(fileStemKey(file.name), file);
  });

  sceneList.innerHTML = "";
  imported.forEach((item, index) => {
    addScene(item.prompt);
    const row = sceneList.lastElementChild;
    const matchedFile = item.imageName
      ? imageMap.get(fileKey(item.imageName)) || imageMap.get(fileStemKey(item.imageName))
      : imageFiles[index];
    setSceneImage(row, matchedFile);
  });

  renumberScenes();
  await saveSettings();

  const matchedCount = [...sceneList.querySelectorAll(".scene-image")].filter((input) => input.files[0]).length;
  const unmatchedCount = imported.length - matchedCount;
  setStatus(
    `${imported.length}개 장면을 불러왔습니다. 이미지 매칭: ${matchedCount}/${imported.length}` +
      (unmatchedCount ? `\n매칭되지 않은 이미지 ${unmatchedCount}개가 있습니다. image 열의 파일명을 확인해 주세요.` : "")
  );
}

async function loadSettings() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const settings = saved[STORAGE_KEY] || {};
  const prompts = Array.isArray(settings.prompts) ? settings.prompts : splitLegacyPrompts(settings.prompts);
  const count = Math.max(DEFAULT_SCENE_COUNT, prompts.length || DEFAULT_SCENE_COUNT);

  sceneList.innerHTML = "";
  for (let i = 0; i < count; i += 1) {
    addScene(prompts[i] || "");
  }

  $("#prefix").value = settings.prefix || "grok-video";
  $("#startIndex").value = settings.startIndex || 1;
  $("#upscale").checked = settings.upscale !== false;

  const generation = { ...DEFAULT_SETTINGS, ...(settings.generation || {}) };
  Object.entries(generation).forEach(([name, value]) => setSegmentedValue(name, value));
}

async function saveSettings() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      prompts: getPromptValues(),
      prefix: $("#prefix").value,
      startIndex: $("#startIndex").value,
      upscale: $("#upscale").checked,
      generation: getGenerationSettings()
    }
  });
}

function bindAutosave() {
  ["prefix", "startIndex", "upscale"].forEach((id) => {
    const el = $(`#${id}`);
    el.addEventListener("input", scheduleSave);
    el.addEventListener("change", scheduleSave);
  });

  $("#addScene").addEventListener("click", () => {
    addScene("");
    scheduleSave();
  });

  $("#make20").addEventListener("click", () => {
    ensureSceneCount(TARGET_SCENE_COUNT);
  });

  $("#importScenes").addEventListener("click", async () => {
    try {
      await importScenesFromTable();
    } catch (error) {
      setStatus(`오류: ${error.message}`);
    }
  });

  document.querySelectorAll(".segmented button[data-value]").forEach((button) => {
    button.addEventListener("click", () => {
      setSegmentedValue(button.closest(".segmented").dataset.setting, button.dataset.value);
      scheduleSave();
    });
  });

  $("#clearPrompts").addEventListener("click", () => {
    if (!confirm("모든 장면의 프롬프트를 지울까요? 이미지 선택은 유지됩니다.")) {
      return;
    }
    clearPromptValues();
    scheduleSave();
  });
}

async function getActiveGrokTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith("https://grok.com/imagine")) {
    throw new Error("https://grok.com/imagine 탭을 열고 그 탭에서 실행해 주세요.");
  }
  return tab;
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function ensureContentScript(tabId) {
  try {
    await sendToTab(tabId, { type: "GROK_AUTO_PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await sendToTab(tabId, { type: "GROK_AUTO_PING" });
  }
}

async function buildScenes() {
  const rows = [...sceneList.querySelectorAll(".scene")];
  const scenes = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const file = row.querySelector(".scene-image").files[0];
    const prompt = row.querySelector(".scene-prompt").value.trim();

    if (!file && !prompt) {
      continue;
    }
    if (!file) {
      throw new Error(`장면 ${index + 1}에 이미지가 없습니다.`);
    }
    if (!prompt) {
      throw new Error(`장면 ${index + 1}에 프롬프트가 없습니다.`);
    }

    scenes.push({
      prompt,
      image: {
        name: file.name,
        type: file.type || "image/png",
        dataUrl: await readFileAsDataUrl(file)
      }
    });
  }

  if (!scenes.length) {
    throw new Error("실행할 장면이 없습니다. 이미지와 프롬프트를 넣어 주세요.");
  }

  return scenes;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "GROK_AUTO_STATUS") {
    setStatus(message.text);
  }
});

startButton.addEventListener("click", async () => {
  try {
    startButton.disabled = true;
    setStatus("준비 중...");
    await saveSettings();

    const tab = await getActiveGrokTab();
    await ensureContentScript(tab.id);

    const scenes = await buildScenes();
    const payload = {
      scenes,
      prefix: $("#prefix").value.trim() || "grok-video",
      startIndex: Math.max(1, Number($("#startIndex").value || 1)),
      upscale: $("#upscale").checked,
      generation: getGenerationSettings()
    };

    await sendToTab(tab.id, { type: "GROK_AUTO_START", payload });
    setStatus(`시작됨: ${scenes.length}개 장면`);
  } catch (error) {
    setStatus(`오류: ${error.message}`);
  } finally {
    startButton.disabled = false;
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const tab = await getActiveGrokTab();
    await ensureContentScript(tab.id);
    await sendToTab(tab.id, { type: "GROK_AUTO_STOP" });
    setStatus("중지 요청됨");
  } catch (error) {
    setStatus(`오류: ${error.message}`);
  }
});

loadSettings()
  .then(bindAutosave)
  .catch((error) => {
    setStatus(`저장값 불러오기 실패: ${error.message}`);
  });
