// AutoCut content script v2.2
console.log("AutoCut v2.2 ready");

// ══════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════
let controlMode = null;
let selectedTiles = new Set();
let floatingBar = null;
let observer = null;

// ══════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════
function isExtensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildFilename(prefix, num, desc, version = null) {
  const n = String(num).padStart(3, "0");
  const d = (desc || "")
    .replace(/,/g, " ")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const v = version ? `_x${version}` : "";
  return d ? `${prefix}${n}_${d}${v}.png` : `${prefix}${n}${v}.png`;
}

// ══════════════════════════════════════════════════
//  CLICK HELPER — pointer events كاملة لـ Radix UI
// ══════════════════════════════════════════════════
function clickElement(el) {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new PointerEvent("pointerup",  { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup",  { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click",    { bubbles: true }));
}

// ══════════════════════════════════════════════════
//  TILE RESOLUTION
// ══════════════════════════════════════════════════
function getImageTile(el) {
  const nested = el.querySelector("[data-tile-id]");
  if (nested) return getImageTile(nested);
  return el.querySelector('img[alt="صورة تم إنشاؤها"]') ? el : null;
}

function getInnerTiles() {
  const seen = new Set();
  const result = [];
  const scope =
    document.querySelector('[data-testid="virtuoso-item-list"]') ||
    document.body;

  for (const el of scope.querySelectorAll("[data-tile-id]")) {
    const inner = getImageTile(el);
    if (!inner) continue;
    const id = inner.getAttribute("data-tile-id");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(inner);
  }
  return result;
}

function getTileById(tileId) {
  const all = document.querySelectorAll(
    `[data-tile-id="${CSS.escape(tileId)}"]`,
  );
  for (const el of all) {
    const inner = getImageTile(el);
    if (inner) return inner;
  }
  return null;
}

// ══════════════════════════════════════════════════
//  FLOW SETTINGS — FIND MAIN BTN
// ══════════════════════════════════════════════════
function findMainSettingsBtn() {
  const allBtns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
  console.log('[AutoCut] findMainSettingsBtn → total candidates:', allBtns.length);

  const result = allBtns.find(btn => {
    const inMenu     = !!btn.closest('[role="menu"]');
    const inDropdown = !!btn.closest('.DropdownMenuContent');
    const arrowText  = btn.querySelector('i.google-symbols')?.textContent.trim();
    const txt        = btn.textContent.trim();
    console.log('[AutoCut]   btn:', txt.slice(0, 40),
      '| inMenu:', inMenu, '| inDropdown:', inDropdown,
      '| arrowText:', arrowText);

    if (inMenu || inDropdown) return false;

    // الزرار الصح: icon بتاعه crop_16_9 أو crop_9_16
    const validIcons = ['crop_16_9', 'crop_9_16', 'arrow_drop_down'];
    return validIcons.includes(arrowText);
  });

  console.log('[AutoCut] findMainSettingsBtn → found:',
    result ? result.textContent.trim().slice(0, 40) : 'NULL');
  return result;
}

// ══════════════════════════════════════════════════
//  FLOW SETTINGS — GET MODELS
// ══════════════════════════════════════════════════
async function openMainDropdownAndGetModels() {
  const mainBtn = findMainSettingsBtn();
  if (!mainBtn) return { models: [], current: '', settings: null };

  clickElement(mainBtn);
  await sleep(500);

  const dropdown = document.querySelector('.DropdownMenuContent');
  if (!dropdown) return { models: [], current: '', settings: null };

  // اقرأ الـ tabs الحالية
  const settings = { mediaType: 'IMAGE', orientation: 'LANDSCAPE', count: 1 };
  dropdown.querySelectorAll('[role="tab"]').forEach(tab => {
    if (tab.getAttribute('aria-selected') !== 'true') return;
    const icon = tab.querySelector('i')?.textContent.trim();
    const txt  = tab.textContent.trim();
    if (icon === 'image')     settings.mediaType   = 'IMAGE';
    if (icon === 'videocam')  settings.mediaType   = 'VIDEO';
    if (icon === 'crop_16_9') settings.orientation = 'LANDSCAPE';
    if (icon === 'crop_9_16') settings.orientation = 'PORTRAIT';
    if (/^x(\d)$/.test(txt))  settings.count       = parseInt(txt[1]);
  });

  // الموديل الحالي
  const modelTrigger = dropdown.querySelector('button[aria-haspopup="menu"][data-state="closed"]');
  const currentModel = modelTrigger
    ? modelTrigger.textContent.replace(/arrow_drop_down/g, '').trim()
    : '';

  // افتح dropdown الموديلات
  let models = [];
  if (modelTrigger) {
    clickElement(modelTrigger);
    await sleep(500);

    document.querySelectorAll('.sc-a0dcecfb-8').forEach(el => {
      const name = el.textContent.trim();
      if (name && !models.includes(name)) models.push(name);
    });
    console.log('[AutoCut] models found:', models);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(300);
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(300);

  return { models, current: currentModel, settings };
}

// ══════════════════════════════════════════════════
//  FLOW SETTINGS — APPLY
// ══════════════════════════════════════════════════
async function applyFlowSettings(s) {
  console.log('[AutoCut] applyFlowSettings called with:', s);

  const mainBtn = findMainSettingsBtn();
  if (!mainBtn) { console.error('[AutoCut] mainBtn not found — aborting'); return false; }

  clickElement(mainBtn);
  console.log('[AutoCut] mainBtn clicked, waiting for dropdown...');
  await sleep(500);

  const dropdown = document.querySelector('.DropdownMenuContent');
  if (!dropdown) { console.error('[AutoCut] .DropdownMenuContent not found after click'); return false; }
  console.log('[AutoCut] dropdown found ✓');

  // ── نوع الميديا ──
  if (s.mediaType) {
    const iconName = s.mediaType === 'IMAGE' ? 'image' : 'videocam';
    const tab = Array.from(dropdown.querySelectorAll('[role="tab"]'))
      .find(t => t.querySelector('i')?.textContent.trim() === iconName);
    console.log('[AutoCut] mediaType tab found:', !!tab, '| active:', tab?.getAttribute('aria-selected'));
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      clickElement(tab); await sleep(300);
    }
  }

  // ── الاتجاه ──
  if (s.orientation) {
    const iconName = s.orientation === 'LANDSCAPE' ? 'crop_16_9' : 'crop_9_16';
    const tab = Array.from(dropdown.querySelectorAll('[role="tab"]'))
      .find(t => t.querySelector('i')?.textContent.trim() === iconName);
    console.log('[AutoCut] orientation tab found:', !!tab, '| active:', tab?.getAttribute('aria-selected'));
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      clickElement(tab); await sleep(300);
    }
  }

  // ── العدد ──
  if (s.count) {
    const allTabs = Array.from(dropdown.querySelectorAll('[role="tab"]'));
    const tab = allTabs.find(t => t.textContent.trim() === `x${s.count}`);
    console.log('[AutoCut] count tab "x' + s.count + '" found:', !!tab,
      '| all:', allTabs.filter(t => /^x\d$/.test(t.textContent.trim())).map(t => t.textContent.trim()));
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      clickElement(tab); await sleep(300);
    }
  }

  // ── الموديل ──
  if (s.model) {
    const modelTrigger = dropdown.querySelector('button[aria-haspopup="menu"][data-state="closed"]');
    console.log('[AutoCut] modelTrigger found:', !!modelTrigger);
    if (modelTrigger) {
      clickElement(modelTrigger);
      await sleep(500);

      const modelEls = document.querySelectorAll('.sc-a0dcecfb-8');
      console.log('[AutoCut] models:', Array.from(modelEls).map(e => e.textContent.trim()));

      let found = false;
      for (const el of modelEls) {
        if (el.textContent.trim() === s.model) {
          const menuItem = el.closest('[role="menuitem"]');
          console.log('[AutoCut] target model found, menuItem:', !!menuItem);
          if (menuItem) { clickElement(menuItem); found = true; await sleep(200); break; }
        }
      }
      if (!found) {
        console.warn('[AutoCut] model not found in list, pressing Escape');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);
      }
    }
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(300);
  console.log('[AutoCut] applyFlowSettings done ✓');
  return true;
}

// ══════════════════════════════════════════════════
//  MESSAGE LISTENER
// ══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isExtensionAlive()) return;

  if (msg.type === "CAPTURE_IMAGES") {
    sendResponse({ images: captureImagesFromDOM() });
    return true;
  }

  if (msg.type === "INJECT_CONTROL") {
    injectFloatingBar();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_FLOW_MODELS") {
    openMainDropdownAndGetModels()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ models: [], current: "", settings: null }));
    return true;
  }

  if (msg.type === "APPLY_SETTINGS") {
    applyFlowSettings(msg.settings)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return true;
});

// ══════════════════════════════════════════════════
//  FLOATING BAR
// ══════════════════════════════════════════════════
function injectFloatingBar() {
  if (floatingBar) return;

  const style = document.createElement("style");
  style.id = "autocut-style";
  style.textContent = `
    #autocut-bar {
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      font-family: 'Segoe UI', system-ui, sans-serif; direction: rtl;
    }
    #autocut-pill {
      background: #1e293b; border: 1px solid #334155; border-radius: 999px;
      padding: 8px 14px; display: flex; align-items: center; gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45); transition: all .2s;
      cursor: default; user-select: none;
    }
    #autocut-logo { font-size: 13px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 5px; }
    #autocut-logo span { color: #6366f1; }
    .ac-divider { width: 1px; height: 16px; background: #334155; }
    .ac-mode-btn {
      border: 1px solid #334155; border-radius: 999px; background: #273549;
      color: #94a3b8; font-size: 11px; font-weight: 600; padding: 4px 11px;
      cursor: pointer; transition: all .15s; white-space: nowrap;
    }
    .ac-mode-btn:hover { background: #334155; color: #f1f5f9; }
    .ac-mode-btn.active-dl  { background: rgba(34,197,94,.15); color: #22c55e; border-color: #22c55e; }
    .ac-mode-btn.active-del { background: rgba(239,68,68,.15);  color: #ef4444; border-color: #ef4444; }
    #autocut-action-bar {
      background: #1e293b; border: 1px solid #334155; border-radius: 999px;
      padding: 7px 14px; display: none; align-items: center; gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45); animation: acSlideUp .2s ease;
    }
    #autocut-action-bar.visible { display: flex; }
    @keyframes acSlideUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    #autocut-count { font-size: 12px; font-weight: 700; color: #f1f5f9; min-width: 60px; }
    .ac-exec-btn { border: none; border-radius: 999px; font-size: 11px; font-weight: 700; padding: 5px 14px; cursor: pointer; transition: all .15s; }
    .ac-exec-btn.dl  { background: #22c55e; color: #000; }
    .ac-exec-btn.del { background: #ef4444; color: #fff; }
    .ac-exec-btn:hover { opacity: .85; transform: scale(1.03); }
    .ac-cancel-btn {
      background: transparent; border: 1px solid #334155; border-radius: 999px;
      color: #64748b; font-size: 11px; font-weight: 600; padding: 5px 11px;
      cursor: pointer; transition: all .15s;
    }
    .ac-cancel-btn:hover { border-color: #94a3b8; color: #f1f5f9; }
    [data-tile-id] { position: relative; }
    [data-tile-id].ac-sel-dl::after, [data-tile-id].ac-sel-del::after {
      content: ''; position: absolute; inset: 0; border-radius: 6px;
      pointer-events: none; transition: all .15s; z-index: 10;
    }
    [data-tile-id].ac-sel-dl::after  { background: rgba(34,197,94,.25); border: 2.5px solid #22c55e; }
    [data-tile-id].ac-sel-del::after { background: rgba(239,68,68,.25);  border: 2.5px solid #ef4444; }
    [data-tile-id].ac-sel-dl .ac-check,
    [data-tile-id].ac-sel-del .ac-check { display: flex !important; }
    .ac-check {
      display: none; position: absolute; top: 6px; right: 6px;
      width: 20px; height: 20px; border-radius: 50%;
      align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; z-index: 11; pointer-events: none;
    }
    [data-tile-id].ac-sel-dl .ac-check  { background: #22c55e; color: #000; }
    [data-tile-id].ac-sel-del .ac-check { background: #ef4444; color: #fff; }
  `;
  document.head.appendChild(style);

  floatingBar = document.createElement("div");
  floatingBar.id = "autocut-bar";
  floatingBar.innerHTML = `
    <div id="autocut-action-bar">
      <span id="autocut-count">0 محدد</span>
      <div class="ac-divider"></div>
      <button class="ac-exec-btn dl" id="ac-exec-btn">📥 تحميل</button>
      <button class="ac-cancel-btn" id="ac-cancel-btn">✕ إلغاء</button>
    </div>
    <div id="autocut-pill">
      <div id="autocut-logo">✂️ Auto<span>Cut</span></div>
      <div class="ac-divider"></div>
      <button class="ac-mode-btn" id="ac-dl-btn">📥 تحميل</button>
      <button class="ac-mode-btn" id="ac-del-btn">🗑️ حذف</button>
      <div class="ac-divider"></div>
      <button class="ac-mode-btn" id="ac-selall-btn" style="display:none">☑ الكل</button>
    </div>
  `;
  document.body.appendChild(floatingBar);

  document.getElementById("ac-dl-btn").addEventListener("click", () => toggleMode("download"));
  document.getElementById("ac-del-btn").addEventListener("click", () => toggleMode("delete"));
  document.getElementById("ac-cancel-btn").addEventListener("click", cancelSelection);
  document.getElementById("ac-exec-btn").addEventListener("click", executeAction);

  startObserver();
}

// ══════════════════════════════════════════════════
//  MODE TOGGLE
// ══════════════════════════════════════════════════
function toggleMode(mode) {
  if (controlMode === mode) { cancelSelection(); return; }

  controlMode = mode;
  selectedTiles.clear();

  document.getElementById("ac-dl-btn").className =
    "ac-mode-btn" + (mode === "download" ? " active-dl" : "");
  document.getElementById("ac-del-btn").className =
    "ac-mode-btn" + (mode === "delete" ? " active-del" : "");

  const selAllBtn = document.getElementById("ac-selall-btn");
  selAllBtn.style.display = "inline-block";
  selAllBtn.className = "ac-mode-btn" + (mode === "download" ? " active-dl" : " active-del");

  const execBtn = document.getElementById("ac-exec-btn");
  execBtn.textContent = mode === "download" ? "📥 تحميل" : "🗑️ حذف";
  execBtn.className   = mode === "download" ? "ac-exec-btn dl" : "ac-exec-btn del";

  attachTileListeners();
  updateActionBar();
}

// ══════════════════════════════════════════════════
//  TILE LISTENERS
// ══════════════════════════════════════════════════
function attachTileListeners() {
  getInnerTiles().forEach((tile, index) => {
    if (tile.dataset.acListened === "1") return;
    tile.dataset.acListened = "1";
    tile.dataset.acIndex = String(index);

    if (!tile.querySelector(".ac-check")) {
      const check = document.createElement("div");
      check.className  = "ac-check";
      check.textContent = "✓";
      tile.appendChild(check);
    }

    tile.addEventListener("click", onTileClick, true);
  });
}

function onTileClick(e) {
  if (!controlMode) return;
  e.preventDefault();
  e.stopPropagation();

  const tile   = e.currentTarget;
  const tileId = tile.getAttribute("data-tile-id");

  if (selectedTiles.has(tileId)) {
    selectedTiles.delete(tileId);
    tile.classList.remove("ac-sel-dl", "ac-sel-del");
  } else {
    selectedTiles.add(tileId);
    tile.classList.add(controlMode === "download" ? "ac-sel-dl" : "ac-sel-del");
  }
  updateActionBar();
}

// ══════════════════════════════════════════════════
//  ACTION BAR
// ══════════════════════════════════════════════════
function updateActionBar() {
  const bar   = document.getElementById("autocut-action-bar");
  const count = document.getElementById("autocut-count");
  if (!bar || !count) return;
  if (selectedTiles.size > 0) {
    bar.classList.add("visible");
    count.textContent = `${selectedTiles.size} محدد`;
  } else {
    bar.classList.remove("visible");
  }
}

// ══════════════════════════════════════════════════
//  EXECUTE ACTION
// ══════════════════════════════════════════════════
async function executeAction() {
  if (!selectedTiles.size || !controlMode) return;
  if (!isExtensionAlive()) { showContextInvalidatedWarning(); return; }

  const storage = await new Promise((resolve) =>
    chrome.storage.local.get(["capturedImages", "scenes", "prefix", "flowSettings"], resolve),
  ).catch(() => ({}));

  const capturedImages = storage.capturedImages || [];
  const allScenes      = storage.scenes         || [];
  const prefix         = storage.prefix         || "scene_";
    // لو flowSettings مش موجودة في storage، اقرأ الـ count من Flow DOM مباشرة
  let imgsPerScene = storage.flowSettings?.count || 1;
  if (!storage.flowSettings) {
    const mainBtn = findMainSettingsBtn();
    if (mainBtn) {
      const countMatch = mainBtn.textContent.match(/x(\d)/);
      if (countMatch) {
        imgsPerScene = parseInt(countMatch[1]);
        console.log('[AutoCut] flowSettings missing — read count from DOM:', imgsPerScene);
      }
    }
  }
  console.log('[AutoCut] executeAction → imgsPerScene:', imgsPerScene, '| flowSettings:', JSON.stringify(storage.flowSettings));
  const orderedTiles   = getInnerTiles();
  const selectedData   = [];
  const seen           = new Set();

  for (const tileId of selectedTiles) {
    if (seen.has(tileId)) continue;
    seen.add(tileId);

    const tile = getTileById(tileId);
    if (!tile) continue;

    const img = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    if (!img) continue;

    const rawSrc = img.getAttribute("src") || img.src;
    const url    = rawSrc.startsWith("http") ? rawSrc : `${location.origin}${rawSrc}`;
    const captured = capturedImages.find((c) => c.url === url);

    let sceneNumber, sceneDesc, filename;

    const domIndex   = orderedTiles.indexOf(tile);
    const idx        = domIndex >= 0 ? domIndex : 0;
    const sceneIndex = Math.floor(idx / imgsPerScene);
    const version    = (idx % imgsPerScene) + 1;

    // if (captured) {
    //   // خد رقم الـ scene والـ desc من الـ captured
    //   // لكن احسب الاسم دايماً من الـ DOM index الحالي
    //   sceneNumber = captured.scene_number;
    //   sceneDesc   = captured.scene_description;
    // } else {
    //   const scene = allScenes[sceneIndex];
    //   sceneNumber = scene ? scene.scene_number      : sceneIndex + 1;
    //   sceneDesc   = scene ? scene.scene_description : "";
    // }

    const scene = allScenes[sceneIndex];
    if (!scene) {
      console.warn(`[AutoCut] tile ${idx} → sceneIndex ${sceneIndex} خارج نطاق الـ JSON (${allScenes.length} مشاهد) — skip`);
      continue;
    }
    sceneNumber = scene.scene_number;
    sceneDesc   = scene.scene_description;

    // الاسم دايماً من الـ DOM — مش من المخزن
    filename = buildFilename(prefix, sceneNumber, sceneDesc, imgsPerScene > 1 ? version : null);
    console.log(`[AutoCut] tile ${idx} → scene ${sceneIndex} → x${version} → ${filename}`);

    selectedData.push({ id: tileId, url, scene_number: sceneNumber, scene_description: sceneDesc, filename });
  }

  if (!selectedData.length) { cancelSelection(); return; }

  if (controlMode === "download") {
    try {
      console.log('[AutoCut] sending EXECUTE_SELECTION:', JSON.stringify(selectedData.map(d => d.filename)));
      chrome.runtime.sendMessage({ type: "EXECUTE_SELECTION", action: "download", images: selectedData });
    } catch (e) {
      console.error('[AutoCut] sendMessage failed:', e.message);
      showContextInvalidatedWarning();
      return;
    }
  } else {
    await deleteSelectedTiles(selectedData.map((d) => d.id));
  }

  cancelSelection();
}

// ══════════════════════════════════════════════════
//  CANCEL
// ══════════════════════════════════════════════════
function cancelSelection() {
  controlMode = null;
  selectedTiles.clear();
  document.querySelectorAll("[data-tile-id]").forEach((t) => t.classList.remove("ac-sel-dl", "ac-sel-del"));
  const dlBtn     = document.getElementById("ac-dl-btn");
  const delBtn    = document.getElementById("ac-del-btn");
  const selAllBtn = document.getElementById("ac-selall-btn");
  if (dlBtn)     dlBtn.className         = "ac-mode-btn";
  if (delBtn)    delBtn.className        = "ac-mode-btn";
  if (selAllBtn) selAllBtn.style.display = "none";
  updateActionBar();
}

// ══════════════════════════════════════════════════
//  CONTEXT INVALIDATED WARNING
// ══════════════════════════════════════════════════
function showContextInvalidatedWarning() {
  if (floatingBar) { floatingBar.remove(); floatingBar = null; }
  const warn = document.createElement("div");
  warn.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999999;
    background: #7f1d1d; border: 1px solid #ef4444; border-radius: 12px;
    padding: 12px 20px; font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px; font-weight: 700; color: #fca5a5;
    box-shadow: 0 8px 32px rgba(0,0,0,.6); direction: rtl;
    max-width: 300px; line-height: 1.6;
  `;
  warn.innerHTML = `
    ⚠️ <strong>AutoCut اتحدّث!</strong><br>
    <span style="font-weight:400;font-size:12px">ريفريش الصفحة عشان يشتغل تاني 🔄</span>
    <br><button onclick="location.reload()" style="
      margin-top:8px; background:#ef4444; border:none; border-radius:8px;
      color:#fff; font-weight:700; padding:5px 14px; cursor:pointer; font-size:12px;
    ">🔄 Refresh دلوقتي</button>
  `;
  document.body.appendChild(warn);
  setTimeout(() => warn.remove(), 10000);
}

// ══════════════════════════════════════════════════
//  DELETE TILES
// ══════════════════════════════════════════════════
async function deleteSelectedTiles(tileIds) {
  showDeleteProgress(0, tileIds.length);
  for (let i = 0; i < tileIds.length; i++) {
    const tile = getTileById(tileIds[i]);
    if (!tile) { showDeleteProgress(i + 1, tileIds.length); continue; }
    await deleteSingleTile(tile);
    showDeleteProgress(i + 1, tileIds.length);
    await sleep(600);
  }
  hideDeleteProgress();
}

async function deleteSingleTile(tile) {
  try {
    tile.scrollIntoView({ block: "center", inline: "center" });
    await sleep(200);

    const moreBtn = tile.querySelector('button[aria-haspopup="menu"]');
    if (!moreBtn) { console.warn("AutoCut: مش لاقي زرار الـ 3 نقط"); return false; }

    clickElement(moreBtn);
    await sleep(400);

    const deleteBtn = findDeleteBtn();
    if (!deleteBtn) { console.warn("AutoCut: مش لاقي زرار الحذف"); return false; }

    clickElement(deleteBtn);
    await sleep(250);
    return true;
  } catch (e) {
    console.error("AutoCut delete error:", e);
    return false;
  }
}

function findDeleteBtn() {
  const menu = document.querySelector('[role="menu"][data-state="open"]');
  if (!menu) return null;
  for (const item of menu.querySelectorAll('[role="menuitem"]')) {
    const icon = item.querySelector("i");
    if (icon && icon.textContent.trim() === "delete" && item.textContent.includes("حذف"))
      return item;
  }
  return null;
}

function showDeleteProgress(done, total) {
  let bar = document.getElementById("autocut-del-progress");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "autocut-del-progress";
    bar.style.cssText = `
      position: fixed; bottom: 90px; right: 24px; z-index: 999999;
      background: #1e293b; border: 1px solid #ef4444; border-radius: 999px;
      padding: 7px 16px; font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 12px; font-weight: 700; color: #ef4444;
      box-shadow: 0 8px 32px rgba(0,0,0,.45); direction: rtl;
    `;
    document.body.appendChild(bar);
  }
  bar.textContent = `🗑️ جاري الحذف ${done}/${total}...`;
}

function hideDeleteProgress() {
  const bar = document.getElementById("autocut-del-progress");
  if (bar) { bar.textContent = "✓ تم الحذف"; setTimeout(() => bar.remove(), 1500); }
}

// ══════════════════════════════════════════════════
//  MUTATION OBSERVER
// ══════════════════════════════════════════════════
function startObserver() {
  const target =
    document.querySelector('[data-testid="virtuoso-item-list"]') || document.body;
  observer = new MutationObserver(() => { if (controlMode) attachTileListeners(); });
  observer.observe(target, { childList: true, subtree: true });
}

// ══════════════════════════════════════════════════
//  CAPTURE IMAGES FROM DOM
// ══════════════════════════════════════════════════
function captureImagesFromDOM() {
  return getInnerTiles().map((tile, index) => {
    const img    = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    const anchor = tile.querySelector("a[href]");
    const rawSrc = img.getAttribute("src") || img.src;
    const url    = rawSrc.startsWith("http") ? rawSrc : `${location.origin}${rawSrc}`;
    const href   = anchor?.getAttribute("href") || "";
    const uuid   = href.split("/").pop() || tile.getAttribute("data-tile-id") || `img_${index}`;

    return {
      id:                tile.getAttribute("data-tile-id") || `img_${index}`,
      url,
      filename:          `image_${String(index + 1).padStart(3, "0")}.png`,
      scene_number:      index + 1,
      scene_description: uuid,
      downloaded:        false,
    };
  });
}