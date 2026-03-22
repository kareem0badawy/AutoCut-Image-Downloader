// AutoCut — content_whisk.js v1.1
console.log('[AutoCut Whisk] content script ready');

// ══════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════
let whiskControlMode   = null;
let whiskSelectedTiles = new Set();
let whiskFloatingBar   = null;
let whiskObserver      = null;
let whiskAllSeenTiles  = []; // كل الـ tiles اللي اتشافوا من أول ما فعّلنا الكنترول
const whiskSelectedData = new Map(); // id → { id, src, savedIdx }
let whiskSelectionOrder = 0; // counter تصاعدي لترتيب التحديد

// ══════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isExtensionAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// ══════════════════════════════════════════════════
//  CLICK HELPER
// ══════════════════════════════════════════════════
function clickElement(el) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click',         { bubbles: true }));
}

// ══════════════════════════════════════════════════
//  INJECT PROMPT
// ══════════════════════════════════════════════════
async function injectWhiskPrompt(text) {
  const textarea = document.querySelector(
    'textarea[placeholder="Describe your idea or roll the dice for prompt ideas"]'
  );
  if (!textarea) return false;

  textarea.focus();
  await sleep(100);

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  ).set;
  nativeSetter.call(textarea, text);
  textarea.dispatchEvent(new Event('input',  { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);

  return (textarea.value || '').trim().length > 0;
}

// ══════════════════════════════════════════════════
//  CLICK GENERATE
// ══════════════════════════════════════════════════
async function clickWhiskGenerate() {
  const btn = document.querySelector('button[aria-label="Submit prompt"]');
  if (!btn || btn.disabled) return false;
  clickElement(btn);
  return true;
}

// ══════════════════════════════════════════════════
//  GET TILES — اللي في الـ DOM دلوقتي
// ══════════════════════════════════════════════════
function getWhiskTiles() {
  const seen   = new Set();
  const result = [];
  for (const img of document.querySelectorAll('img')) {
    if (!img.src?.startsWith('blob:https://labs.google')) continue;
    if (seen.has(img.src)) continue;
    seen.add(img.src);
    const wrapper = img.closest('[class*="sc-12e568c9"]');
    if (wrapper) result.push(wrapper);
  }
  return result;
}

// ══════════════════════════════════════════════════
//  POLL FOR NEW IMAGES
// ══════════════════════════════════════════════════
async function pollWhiskForNewImages(beforeSrcs, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(3000);
    const current = getWhiskTiles().map(w => w.querySelector('img')?.src).filter(Boolean);
    const newSrcs = current.filter(s => !beforeSrcs.includes(s));
    if (newSrcs.length > 0) return newSrcs;
  }
  return [];
}

// ══════════════════════════════════════════════════
//  DOWNLOAD TILE — fetch blob → base64 → background
// ══════════════════════════════════════════════════
async function downloadWhiskTile(wrapper, filename, folder) {
  const img = wrapper.querySelector('img');
  if (!img?.src) return false;
  return downloadWhiskTileFromSrc(img.src, filename, folder);
}

async function downloadWhiskTileFromSrc(src, filename, folder) {
  try {
    const response = await fetch(src);
    const blob     = await response.blob();
    const reader   = new FileReader();
    return new Promise(resolve => {
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          type:     'WHISK_DOWNLOAD_BASE64',
          base64:   reader.result,
          filename: filename || 'whisk_image.jpg',
          folder:   folder   || 'AutoCut/Whisk',
        }, () => resolve(true));
      };
      reader.onerror = () => resolve(false);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error('[AutoCut Whisk] fetch failed:', e);
    return false;
  }
}

// ══════════════════════════════════════════════════
//  FILENAME BUILDER
// ══════════════════════════════════════════════════
function buildWhiskFilename(prefix, num, desc, version) {
  const n = String(num || 1).padStart(3, '0');
  const d = (desc || '')
    .replace(/,/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const v = version ? `_x${version}` : '';
  return d ? `${prefix}${n}_${d}${v}.jpg` : `${prefix}${n}${v}.jpg`;
}

// ══════════════════════════════════════════════════
//  DELETE TILE
// ══════════════════════════════════════════════════
async function deleteWhiskTile(wrapper) {
  wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  wrapper.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
  await sleep(500);

  const btn = wrapper.querySelector('button[aria-label="Delete image"]');
  if (!btn) { console.warn('[AutoCut Whisk] delete btn not found'); return false; }

  clickElement(btn);
  await sleep(400);
  return true;
}

// ══════════════════════════════════════════════════
//  FLOATING BAR
// ══════════════════════════════════════════════════
function injectWhiskFloatingBar() {
  if (whiskFloatingBar) return;

  const style = document.createElement('style');
  style.id = 'autocut-whisk-style';
  style.textContent = `
    #autocut-whisk-bar {
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      font-family: 'Segoe UI', system-ui, sans-serif; direction: rtl;
    }
    #autocut-whisk-pill {
      background: #1e293b; border: 1px solid #334155; border-radius: 999px;
      padding: 8px 14px; display: flex; align-items: center; gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45); cursor: default; user-select: none;
    }
    #autocut-whisk-logo { font-size: 13px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 5px; }
    #autocut-whisk-logo span { color: #a78bfa; }
    .acw-divider { width: 1px; height: 16px; background: #334155; }
    .acw-mode-btn {
      border: 1px solid #334155; border-radius: 999px; background: #273549;
      color: #94a3b8; font-size: 11px; font-weight: 600; padding: 4px 11px;
      cursor: pointer; transition: all .15s; white-space: nowrap;
    }
    .acw-mode-btn:hover { background: #334155; color: #f1f5f9; }
    .acw-mode-btn.active-dl  { background: rgba(34,197,94,.15); color: #22c55e; border-color: #22c55e; }
    .acw-mode-btn.active-del { background: rgba(239,68,68,.15);  color: #ef4444; border-color: #ef4444; }
    #autocut-whisk-action-bar {
      background: #1e293b; border: 1px solid #334155; border-radius: 999px;
      padding: 7px 14px; display: none; align-items: center; gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45);
    }
    #autocut-whisk-action-bar.visible { display: flex; }
    #autocut-whisk-count { font-size: 12px; font-weight: 700; color: #f1f5f9; min-width: 60px; }
    .acw-exec-btn { border: none; border-radius: 999px; font-size: 11px; font-weight: 700; padding: 5px 14px; cursor: pointer; }
    .acw-exec-btn.dl  { background: #22c55e; color: #000; }
    .acw-exec-btn.del { background: #ef4444; color: #fff; }
    .acw-cancel-btn {
      background: transparent; border: 1px solid #334155; border-radius: 999px;
      color: #64748b; font-size: 11px; font-weight: 600; padding: 5px 11px; cursor: pointer;
    }
    .acw-cancel-btn:hover { border-color: #94a3b8; color: #f1f5f9; }
    [data-acw-tile] { position: relative; }
    [data-acw-tile].acw-sel-dl::after, [data-acw-tile].acw-sel-del::after {
      content: ''; position: absolute; inset: 0; border-radius: 6px;
      pointer-events: none; z-index: 10;
    }
    [data-acw-tile].acw-sel-dl::after  { background: rgba(34,197,94,.25); border: 2.5px solid #22c55e; }
    [data-acw-tile].acw-sel-del::after { background: rgba(239,68,68,.25);  border: 2.5px solid #ef4444; }
  `;
  document.head.appendChild(style);

  whiskFloatingBar = document.createElement('div');
  whiskFloatingBar.id = 'autocut-whisk-bar';
  whiskFloatingBar.innerHTML = `
    <div id="autocut-whisk-action-bar">
      <span id="autocut-whisk-count">0 محدد</span>
      <div class="acw-divider"></div>
      <button class="acw-exec-btn dl" id="acw-exec-btn">📥 تحميل</button>
      <button class="acw-cancel-btn"  id="acw-cancel-btn">✕ إلغاء</button>
    </div>
    <div id="autocut-whisk-pill">
      <div id="autocut-whisk-logo">✂️ Auto<span>Cut ✨</span></div>
      <div class="acw-divider"></div>
      <button class="acw-mode-btn" id="acw-dl-btn">📥 تحميل</button>
      <button class="acw-mode-btn" id="acw-del-btn">🗑️ حذف</button>
      <div class="acw-divider"></div>
      <button class="acw-mode-btn" id="acw-selall-btn" style="display:none">☑ الكل</button>
    </div>
  `;
  document.body.appendChild(whiskFloatingBar);

  document.getElementById('acw-dl-btn').addEventListener('click',     () => whiskToggleMode('download'));
  document.getElementById('acw-del-btn').addEventListener('click',    () => whiskToggleMode('delete'));
  document.getElementById('acw-cancel-btn').addEventListener('click', whiskCancelSelection);
  document.getElementById('acw-exec-btn').addEventListener('click',   whiskExecuteAction);
  document.getElementById('acw-selall-btn').addEventListener('click', whiskSelectAll);

  startWhiskObserver();
}

// ══════════════════════════════════════════════════
//  MODE TOGGLE
// ══════════════════════════════════════════════════
function whiskToggleMode(mode) {
  if (whiskControlMode === mode) { whiskCancelSelection(); return; }
  whiskControlMode = mode;
  whiskSelectedTiles.clear();
  whiskSelectedData.clear();
  whiskAllSeenTiles = [];

  document.getElementById('acw-dl-btn').className  = 'acw-mode-btn' + (mode === 'download' ? ' active-dl' : '');
  document.getElementById('acw-del-btn').className = 'acw-mode-btn' + (mode === 'delete'   ? ' active-del' : '');

  const selAllBtn = document.getElementById('acw-selall-btn');
  selAllBtn.style.display = 'inline-block';
  selAllBtn.className = 'acw-mode-btn' + (mode === 'download' ? ' active-dl' : ' active-del');

  const execBtn = document.getElementById('acw-exec-btn');
  execBtn.textContent = mode === 'download' ? '📥 تحميل' : '🗑️ حذف';
  execBtn.className   = mode === 'download' ? 'acw-exec-btn dl' : 'acw-exec-btn del';

  attachWhiskTileListeners();
  updateWhiskActionBar();
}

// ══════════════════════════════════════════════════
//  SELECT ALL
// ══════════════════════════════════════════════════
function whiskSelectAll() {
  const reversedSeen = [...whiskAllSeenTiles].reverse();
  getWhiskTiles().forEach(wrapper => {
    const id  = getWhiskTileId(wrapper);
    const src = wrapper.querySelector('img')?.src || '';
    whiskSelectedTiles.add(id);
    const currentIdx = reversedSeen.findIndex(t => t.id === id);
    whiskSelectedData.set(id, { id, src, savedIdx: currentIdx >= 0 ? currentIdx : 0 });
    wrapper.classList.add(whiskControlMode === 'download' ? 'acw-sel-dl' : 'acw-sel-del');
  });
  updateWhiskActionBar();
}

// ══════════════════════════════════════════════════
//  TILE HELPERS
// ══════════════════════════════════════════════════
function getWhiskTileId(wrapper) {
  if (!wrapper.dataset.acwId) {
    wrapper.dataset.acwId = 'acw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }
  return wrapper.dataset.acwId;
}

function attachWhiskTileListeners() {
  const tiles = getWhiskTiles();
  console.log('[AutoCut Whisk] attachTileListeners → total tiles found:', tiles.length);
  tiles.forEach((wrapper, i) => {
    wrapper.setAttribute('data-acw-tile', '1');
    const alreadyListened = wrapper.dataset.acwListened === '1';
    if (!alreadyListened) {
      wrapper.dataset.acwListened = '1';
      getWhiskTileId(wrapper);
      wrapper.addEventListener('click', onWhiskTileClick, true);
    }
    // أضف للقائمة الكاملة لو مش موجود
    // أضف للقائمة الكاملة بناءً على الـ src — مش الـ id
    const acwId  = wrapper.dataset.acwId;
    const tSrc   = wrapper.querySelector('img')?.src || '';
    if (tSrc && !whiskAllSeenTiles.find(t => t.src === tSrc)) {
      whiskAllSeenTiles.push({ id: acwId, src: tSrc });
    }
    console.log('[AutoCut Whisk] tile', i, '| id:', acwId, '| listened:', alreadyListened, '| selected:', whiskSelectedTiles.has(acwId));
  });
}

function onWhiskTileClick(e) {
  if (!whiskControlMode) return;
  e.preventDefault();
  e.stopPropagation();
  const wrapper = e.currentTarget;
  const id      = getWhiskTileId(wrapper);
  const src     = wrapper.querySelector('img')?.src || '';

  if (whiskSelectedTiles.has(id)) {
    whiskSelectedTiles.delete(id);
    whiskSelectedData.delete(id);
    wrapper.classList.remove('acw-sel-dl', 'acw-sel-del');
  } else {
    whiskSelectedTiles.add(id);
     // نحفظ الـ index من whiskAllSeenTiles في لحظة الضغط
    // whiskAllSeenTiles مرتبة من الأحدث للأقدم (Whisk بتضيف الجديد في الأول)
    // نعكسها عشان الأقدم يبقى index 0
    whiskSelectedData.set(id, { id, src, savedIdx: whiskSelectionOrder++ });
    wrapper.classList.add(whiskControlMode === 'download' ? 'acw-sel-dl' : 'acw-sel-del');
  }
  updateWhiskActionBar();
}

// ══════════════════════════════════════════════════
//  ACTION BAR
// ══════════════════════════════════════════════════
function updateWhiskActionBar() {
  const bar   = document.getElementById('autocut-whisk-action-bar');
  const count = document.getElementById('autocut-whisk-count');
  if (!bar || !count) return;
  if (whiskSelectedTiles.size > 0) {
    bar.classList.add('visible');
    count.textContent = `${whiskSelectedTiles.size} محدد`;
  } else {
    bar.classList.remove('visible');
  }
}

// ══════════════════════════════════════════════════
//  EXECUTE ACTION
// ══════════════════════════════════════════════════
async function whiskExecuteAction() {
  if (!whiskSelectedTiles.size || !whiskControlMode) return;
  if (!isExtensionAlive()) return;

  const selectedEntries = Array.from(whiskSelectedData.values());
  console.log('[AutoCut Whisk] selectedEntries:', selectedEntries.length,
    selectedEntries.map(e => e.src.slice(0, 40)));

  if (whiskControlMode === 'download') {
    const storage = await new Promise(r =>
      chrome.storage.local.get(['whiskScenes', 'whiskPrefix', 'whiskProject'], r)
    );
    const allScenes  = storage.whiskScenes  || [];
    const prefix     = storage.whiskPrefix  || 'scene_';
    const project    = storage.whiskProject || '';
    const folder     = project ? `AutoCut/Whisk/${project}` : 'AutoCut/Whisk';
    const totalScenes = allScenes.length || 1;

    // نستخدم عدد كل الـ tiles اللي اتشافوا مش بس اللي في الـ DOM دلوقتي
    const totalSeenTiles = whiskAllSeenTiles.length || getWhiskTiles().length;
    const imgsPerScene   = Math.max(1, Math.round(totalSeenTiles / totalScenes));

    // الـ orderedTiles اللي في الـ DOM دلوقتي (معكوسة — الأقدم أول)
    const orderedTiles = getWhiskTiles().reverse();

    console.log('[AutoCut Whisk] execute download → seenTiles:', totalSeenTiles,
      '| domTiles:', orderedTiles.length,
      '| scenes:', totalScenes,
      '| imgsPerScene:', imgsPerScene,
      '| selected:', selectedEntries.length);

    for (let si = 0; si < selectedEntries.length; si++) {
      const entry   = selectedEntries[si];
      // جرب تلاقي الـ wrapper في الـ DOM الحالي
      const wrapper = orderedTiles.find(w => w.querySelector('img')?.src === entry.src);
      // استخدم الـ savedIdx المحفوظ في وقت التحديد
      const idx     = entry.savedIdx ?? si;

      const sceneIndex = Math.floor(idx / imgsPerScene);
      const version    = (idx % imgsPerScene) + 1;
      const scene      = allScenes[sceneIndex] || null;
      const fname      = scene
        ? buildWhiskFilename(prefix, scene.scene_number, scene.scene_description, imgsPerScene > 1 ? version : null)
        : `${prefix}image_${String(idx + 1).padStart(3, '0')}.jpg`;

      console.log('[AutoCut Whisk] entry', si,
        '→ savedIdx:', idx,
        '| scene:', sceneIndex,
        '| version:', version,
        '| inDOM:', !!wrapper,
        '| fname:', fname);

      if (wrapper) {
        await downloadWhiskTile(wrapper, fname, folder);
      } else {
        await downloadWhiskTileFromSrc(entry.src, fname, folder);
      }
      await sleep(500);
    }

  } else {
    // حذف — بس اللي في الـ DOM
    const tiles    = getWhiskTiles();
    const selected = tiles.filter(w => whiskSelectedTiles.has(getWhiskTileId(w)));
    for (const wrapper of selected) {
      await deleteWhiskTile(wrapper);
      await sleep(600);
    }
  }

  whiskCancelSelection();
}

// ══════════════════════════════════════════════════
//  CANCEL
// ══════════════════════════════════════════════════
function whiskCancelSelection() {
  whiskControlMode = null;
  whiskSelectedTiles.clear();
  whiskSelectedData.clear();
  whiskAllSeenTiles = [];

  document.querySelectorAll('[data-acw-tile]').forEach(t =>
    t.classList.remove('acw-sel-dl', 'acw-sel-del')
  );
  const dlBtn     = document.getElementById('acw-dl-btn');
  const delBtn    = document.getElementById('acw-del-btn');
  const selAllBtn = document.getElementById('acw-selall-btn');
  if (dlBtn)     dlBtn.className         = 'acw-mode-btn';
  if (delBtn)    delBtn.className        = 'acw-mode-btn';
  if (selAllBtn) selAllBtn.style.display = 'none';
  updateWhiskActionBar();
}

// ══════════════════════════════════════════════════
//  OBSERVER
// ══════════════════════════════════════════════════
function startWhiskObserver() {
  if (whiskObserver) return;
  whiskObserver = new MutationObserver(() => {
    if (whiskControlMode) attachWhiskTileListeners();
  });
  whiskObserver.observe(document.body, { childList: true, subtree: true });
}

// ══════════════════════════════════════════════════
//  MESSAGE LISTENER
// ══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isExtensionAlive()) return;

  if (msg.type === 'WHISK_INJECT_CONTROL') {
    injectWhiskFloatingBar();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'WHISK_SEND_PROMPT') {
    (async () => {
      const before   = getWhiskTiles().map(w => w.querySelector('img')?.src).filter(Boolean);
      const injected = await injectWhiskPrompt(msg.prompt);
      if (!injected) { sendResponse({ ok: false, error: 'Textarea not found' }); return; }
      const clicked  = await clickWhiskGenerate();
      if (!clicked)  { sendResponse({ ok: false, error: 'Generate button not found' }); return; }
      sendResponse({ ok: true, beforeSrcs: before });
    })();
    return true;
  }

  if (msg.type === 'WHISK_POLL_IMAGES') {
    (async () => {
      const newSrcs = await pollWhiskForNewImages(msg.beforeSrcs || [], msg.timeout || 90000);
      sendResponse({ ok: true, newSrcs });
    })();
    return true;
  }

  if (msg.type === 'WHISK_GET_IMAGES') {
    const images = getWhiskTiles().map((w, i) => ({
      id:    getWhiskTileId(w),
      src:   w.querySelector('img')?.src || '',
      index: i,
    })).filter(x => x.src);
    sendResponse({ images });
    return true;
  }

  if (msg.type === 'WHISK_DOWNLOAD_IMAGES_BY_SRC') {
    (async () => {
      const tiles = getWhiskTiles();
      let count = 0;
      for (const wrapper of tiles) {
        const src = wrapper.querySelector('img')?.src;
        if (!src || !msg.srcs.includes(src)) continue;
        const ok = await downloadWhiskTile(wrapper, msg.filename, msg.folder);
        if (ok) count++;
        await sleep(500);
      }
      sendResponse({ ok: true, count });
    })();
    return true;
  }

  return true;
});