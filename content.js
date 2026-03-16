// AutoCut content script v1.0.0
console.log("AutoCut v1.0.0 ready");

// ══════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════
let controlMode = null;
let selectedTiles = new Set();
let floatingBar = null;
let observer = null;

// ══════════════════════════════════════════════════
//  HELPER — context check
// ══════════════════════════════════════════════════
function isExtensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════
//  MESSAGE LISTENER
// ══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isExtensionAlive()) return;

  if (msg.type === "CAPTURE_IMAGES") {
    const images = captureImagesFromDOM();
    sendResponse({ images });
  }
  if (msg.type === "INJECT_CONTROL") {
    injectFloatingBar();
    sendResponse({ ok: true });
  }
  return true;
});

// ══════════════════════════════════════════════════
//  FLOATING BAR — INJECT
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
    .ac-mode-btn.active-dl { background: rgba(34,197,94,.15); color: #22c55e; border-color: #22c55e; }
    .ac-mode-btn.active-del { background: rgba(239,68,68,.15); color: #ef4444; border-color: #ef4444; }
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
    [data-tile-id].ac-sel-del::after { background: rgba(239,68,68,.25); border: 2.5px solid #ef4444; }
    [data-tile-id].ac-sel-dl .ac-check, [data-tile-id].ac-sel-del .ac-check { display: flex !important; }
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
      <button class="ac-cancel-btn"  id="ac-cancel-btn">✕ إلغاء</button>
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

  const dlBtn     = document.getElementById("ac-dl-btn");
  const delBtn    = document.getElementById("ac-del-btn");
  const selAllBtn = document.getElementById("ac-selall-btn");

  dlBtn.className  = "ac-mode-btn" + (mode === "download" ? " active-dl" : "");
  delBtn.className = "ac-mode-btn" + (mode === "delete"   ? " active-del" : "");

  selAllBtn.style.display = "inline-block";
  selAllBtn.className = "ac-mode-btn" + (mode === "download" ? " active-dl" : " active-del");

  const execBtn = document.getElementById("ac-exec-btn");
  if (mode === "download") {
    execBtn.textContent = "📥 تحميل";
    execBtn.className   = "ac-exec-btn dl";
  } else {
    execBtn.textContent = "🗑️ حذف";
    execBtn.className   = "ac-exec-btn del";
  }

  attachTileListeners();
  updateActionBar();
}

// ══════════════════════════════════════════════════
//  TILE LISTENERS
// ══════════════════════════════════════════════════
// ✅ Helper: جيب فقط الـ inner tiles
// الـ DOM فيه outer + inner لكل صورة بنفس data-tile-id
// الـ inner هو اللي مباشرة فيه img، والـ outer هو parent له
function getInnerTiles() {
  const scope = document.querySelector('[data-testid="virtuoso-item-list"]') || document;
  const seen = new Set();

  return Array.from(scope.querySelectorAll('[data-tile-id]')).filter((tile) => {
    const img = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    if (!img) return false;

    // لو فيه child تاني data-tile-id يبقى ده outer مش inner
    const nestedTile = Array.from(tile.children).some(
      (child) => child.hasAttribute && child.hasAttribute('data-tile-id')
    );
    if (nestedTile) return false;

    const tileId = tile.getAttribute('data-tile-id');
    if (!tileId || seen.has(tileId)) return false;
    seen.add(tileId);
    return true;
  });
}

function findInnerTileById(tileId) {
  return getInnerTiles().find(
    (tile) => tile.getAttribute('data-tile-id') === tileId
  ) || null;
}

function attachTileListeners() {
  const tiles = getInnerTiles();
  tiles.forEach((tile, index) => {
    if (tile.dataset.acListened === "1") return;
    tile.dataset.acListened = "1";
    tile.dataset.acIndex = index + 1;

    let bestDesc = '';

    // ✅ 1. دور على text nodes مباشرة جوا الـ tile (مش img أو button)
    const skipTags = new Set(['IMG', 'BUTTON', 'INPUT', 'I', 'SVG']);
    const allElements = tile.querySelectorAll('*');
    for (const el of allElements) {
      if (skipTags.has(el.tagName)) continue; // ✅ تجاهل img وbuttons
      
      // جرب textContent
      const text = el.textContent?.trim() || '';
      if (text.length > 15 && !text.includes('صورة تم') && !text.includes('more_vert') && !text.includes('delete')) {
        bestDesc = text;
        break;
      }
    }

    // ✅ 2. جرب aria-label بس مش على img أو button
    if (!bestDesc) {
      const ariaEls = tile.querySelectorAll('[aria-label]');
      for (const el of ariaEls) {
        if (skipTags.has(el.tagName)) continue; // ✅ تجاهل img
        const text = el.getAttribute('aria-label')?.trim() || '';
        if (text.length > 15 && !text.includes('صورة تم')) {
          bestDesc = text;
          break;
        }
      }
    }

    // ✅ 3. Fallback: capturedImages من storage (هيتحط لو لقيناه)
    tile.dataset.acDesc = bestDesc;
    tile.dataset.acSceneNum = index + 1; // دايما index fallback

    if (!tile.querySelector(".ac-check")) {
      const check = document.createElement("div");
      check.className = "ac-check";
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
    tile.classList.remove("ac-sel-dl", "ac-sel-del");
    tile.classList.add(controlMode === "download" ? "ac-sel-dl" : "ac-sel-del");
  }
  updateActionBar();
}

// ══════════════════════════════════════════════════
//  ACTION BAR UPDATE
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
//  EXECUTE ACTION — ✅ نسخة واحدة فقط
// ══════════════════════════════════════════════════
async function executeAction() {
  if (!selectedTiles.size || !controlMode) return;
  if (!isExtensionAlive()) { showContextInvalidatedWarning(); return; }

  // ✅ جيب scenes وcapturedImages من storage
  let allScenes = [];
  let capturedImages = [];
  try {
    const storageData = await new Promise((resolve, reject) => {
      try { chrome.storage.local.get(["capturedImages", "scenes"], resolve); }
      catch (e) { reject(e); }
    });
    capturedImages = storageData.capturedImages || [];
    allScenes      = storageData.scenes         || [];
  } catch {
    capturedImages = [];
    allScenes = [];
  }

  // ✅ جيب فقط الـ inner tiles المرتبة (مش الـ outer wrappers)
  const allTilesInOrder = getInnerTiles();

  const selectedData = [];
  const seen = new Set();
  const storagePrefix = await new Promise(resolve => {
    try { chrome.storage.local.get(['prefix'], r => resolve(r.prefix || 'scene_')); }
    catch { resolve('scene_'); }
  });

  for (const tileId of selectedTiles) {
    const tile = findInnerTileById(tileId);
    if (!tile) continue;
    if (seen.has(tileId)) continue;
    seen.add(tileId);

    const img = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    if (!img) continue;

    const rawSrc  = img.getAttribute('src') || img.src;
    const fullUrl = rawSrc.startsWith('http') ? rawSrc : `${location.origin}${rawSrc}`;

    // ✅ IMPORTANT: ماينفعش نطابق بعد قص query string
    // لأن كل الصور عندها نفس base path تقريبًا: /fx/api/trpc/media.getMediaUrlRedirect
    // فكان كل Tile بيماتش أول captured image => نفس الاسم scene_001...
    const captured = capturedImages.find(c => (c.url || '') === fullUrl);

    // ✅ 2. لو مفيش match — استخدم position الـ tile في الـ DOM كـ scene index
    let sceneNumber = 1;
    let sceneDesc   = '';
    let filename    = '';

    if (captured) {
      // الأفضل — بيانات كاملة من الـ Queue
      sceneNumber = captured.scene_number;
      sceneDesc   = captured.scene_description;
      filename    = captured.filename;
    } else {
      // ✅ position الـ tile = index في allTilesInOrder (0-based → +1)
      const domIndex = allTilesInOrder.indexOf(tile); // 0-based
      const sceneIdx = domIndex >= 0 ? domIndex : 0;  // fallback 0

      // ✅ جيب الـ scene المناظر من allScenes (بالـ index مش بالـ scene_number)
      const matchedScene = (allScenes.length > sceneIdx) ? allScenes[sceneIdx] : null;

      if (matchedScene) {
        sceneNumber = matchedScene.scene_number;
        sceneDesc   = matchedScene.scene_description;
      } else {
        sceneNumber = sceneIdx + 1;
        sceneDesc   = tile.dataset.acDesc || '';
      }
    }

    // ✅ ابني الـ filename هنا في content.js عشان كل صورة تاخد اسم فريد
    if (!filename) {
      const num  = String(sceneNumber).padStart(3, '0');
      const desc = (sceneDesc || '')
        .replace(/,/g, ' ')
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      filename = desc ? `${storagePrefix}${num}_${desc}.png` : `${storagePrefix}${num}.png`;
    }

    selectedData.push({
      id:                tileId,
      url:               fullUrl,
      scene_number:      sceneNumber,
      scene_description: sceneDesc,
      filename:          filename,
    });
  }

  if (!selectedData.length) { cancelSelection(); return; }

  if (controlMode === 'download') {
    try {
      chrome.runtime.sendMessage({
        type: 'EXECUTE_SELECTION', action: 'download', images: selectedData
      });
    } catch { showContextInvalidatedWarning(); return; }
    cancelSelection();
  } else {
    try {
      await deleteSelectedTiles(selectedData.map(d => d.id));
    } catch { showContextInvalidatedWarning(); return; }
    cancelSelection();
  }
}

// ══════════════════════════════════════════════════
//  CONTEXT INVALIDATED WARNING
// ══════════════════════════════════════════════════
function showContextInvalidatedWarning() {
  if (floatingBar) { floatingBar.remove(); floatingBar = null; }

  const warn = document.createElement('div');
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
    const tile = findInnerTileById(tileIds[i]);
    if (!tile) { showDeleteProgress(i + 1, tileIds.length); continue; }
    const success = await deleteSingleTile(tile);
    if (!success) console.warn(`AutoCut: فشل حذف tile ${tileIds[i]}`);
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

    moreBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles:true, cancelable:true, pointerId:1, isPrimary:true, button:0, buttons:1 }));
    moreBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    moreBtn.dispatchEvent(new PointerEvent("pointerup",  { bubbles:true, cancelable:true, pointerId:1, isPrimary:true, button:0, buttons:0 }));
    moreBtn.dispatchEvent(new MouseEvent("mouseup",  { bubbles: true }));
    moreBtn.dispatchEvent(new MouseEvent("click",    { bubbles: true }));
    await sleep(400);

    const deleteBtn = findDeleteBtn();
    if (!deleteBtn) { console.warn("AutoCut: مش لاقي زرار الحذف"); return false; }

    deleteBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    deleteBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    deleteBtn.dispatchEvent(new PointerEvent("pointerup",  { bubbles: true }));
    deleteBtn.dispatchEvent(new MouseEvent("mouseup",  { bubbles: true }));
    deleteBtn.dispatchEvent(new MouseEvent("click",    { bubbles: true }));
    await sleep(250);

    return true;
  } catch (e) {
    console.error("AutoCut delete error:", e);
    return false;
  }
}

// ✅ نسخة واحدة فقط من findDeleteBtn
function findDeleteBtn() {
  const menu = document.querySelector('[role="menu"][data-state="open"]');
  if (!menu) return null;
  const items = menu.querySelectorAll('[role="menuitem"]');
  for (const item of items) {
    const icon = item.querySelector("i");
    const text = item.textContent || "";
    if (icon && icon.textContent.trim() === "delete" && text.includes("حذف")) return item;
  }
  return null;
}

function findMoreVertBtn(tile) {
  const btns = tile.querySelectorAll("button");
  for (const btn of btns) {
    const icon = btn.querySelector("i");
    if (icon && icon.textContent.trim() === "more_vert") return btn;
  }
  return tile.querySelector('[aria-label="خيارات إضافية"]') || null;
}

function waitForDeleteButton(timeout = 800) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const btns = document.querySelectorAll('[role="menuitem"]');
      for (const btn of btns) {
        const icon = btn.querySelector("i");
        const text = btn.textContent || "";
        if ((icon && icon.textContent.trim() === "delete") || text.includes("حذف")) {
          resolve(btn); return;
        }
      }
      if (Date.now() - start < timeout) requestAnimationFrame(check);
      else resolve(null);
    };
    check();
  });
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════
//  CANCEL
// ══════════════════════════════════════════════════
function cancelSelection() {
  controlMode = null;
  selectedTiles.clear();
  document.querySelectorAll("[data-tile-id]").forEach(tile => {
    tile.classList.remove("ac-sel-dl", "ac-sel-del");
  });
  const dlBtn     = document.getElementById("ac-dl-btn");
  const delBtn    = document.getElementById("ac-del-btn");
  const selAllBtn = document.getElementById("ac-selall-btn");
  if (dlBtn)     dlBtn.className = "ac-mode-btn";
  if (delBtn)    delBtn.className = "ac-mode-btn";
  if (selAllBtn) selAllBtn.style.display = "none";
  updateActionBar();
}

// ══════════════════════════════════════════════════
//  MUTATION OBSERVER
// ══════════════════════════════════════════════════
function startObserver() {
  const target = document.querySelector('[data-testid="virtuoso-item-list"]') || document.body;
  observer = new MutationObserver(() => {
    if (controlMode) attachTileListeners();
  });
  observer.observe(target, { childList: true, subtree: true });
}

// ══════════════════════════════════════════════════
//  CAPTURE IMAGES FROM DOM
// ══════════════════════════════════════════════════
function captureImagesFromDOM() {
  const items = getInnerTiles();
  const images = [];

  items.forEach((tile, index) => {
    const img    = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    const anchor = tile.querySelector("a[href]");
    if (!img) return;

    const rawSrc  = img.getAttribute("src") || img.src;
    const fullUrl = rawSrc.startsWith("http") ? rawSrc : `${location.origin}${rawSrc}`;
    const tileId  = tile.getAttribute("data-tile-id") || `img_${index}`;
    const href    = anchor?.getAttribute("href") || "";
    const hrefParts  = href.split("/");
    const sceneUuid  = hrefParts[hrefParts.length - 1] || tileId;

    images.push({
      id:                tileId,
      url:               fullUrl,
      filename:          `image_${String(index + 1).padStart(3, "0")}.png`,
      scene_number:      index + 1,
      scene_description: sceneUuid,
      downloaded:        false,
    });
  });

  return images;
}