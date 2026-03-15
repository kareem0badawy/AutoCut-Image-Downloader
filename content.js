// AutoCut content script v1.0.0
console.log('AutoCut v1.0.0 ready');

// ══════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════
let controlMode   = null;   // null | 'download' | 'delete'
let selectedTiles = new Set();
let floatingBar   = null;
let observer      = null;

// ══════════════════════════════════════════════════
//  MESSAGE LISTENER
// ══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_IMAGES') {
    const images = captureImagesFromDOM();
    sendResponse({ images });
  }
  if (msg.type === 'INJECT_CONTROL') {
    injectFloatingBar();
    sendResponse({ ok: true });
  }
  return true;
});

// ══════════════════════════════════════════════════
//  FLOATING BAR — INJECT
// ══════════════════════════════════════════════════
function injectFloatingBar() {
  if (floatingBar) return; // already injected

  // ── Styles ──────────────────────────────────────
  const style = document.createElement('style');
  style.id = 'autocut-style';
  style.textContent = `
    #autocut-bar {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
      font-family: 'Segoe UI', system-ui, sans-serif;
      direction: rtl;
    }

    /* ── Main pill ── */
    #autocut-pill {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 999px;
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45);
      transition: all .2s;
      cursor: default;
      user-select: none;
    }

    #autocut-logo {
      font-size: 13px;
      font-weight: 700;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    #autocut-logo span { color: #6366f1; }

    .ac-divider {
      width: 1px; height: 16px;
      background: #334155;
    }

    /* ── Mode buttons ── */
    .ac-mode-btn {
      border: 1px solid #334155;
      border-radius: 999px;
      background: #273549;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 11px;
      cursor: pointer;
      transition: all .15s;
      white-space: nowrap;
    }
    .ac-mode-btn:hover { background: #334155; color: #f1f5f9; }
    .ac-mode-btn.active-dl {
      background: rgba(34,197,94,.15);
      color: #22c55e;
      border-color: #22c55e;
    }
    .ac-mode-btn.active-del {
      background: rgba(239,68,68,.15);
      color: #ef4444;
      border-color: #ef4444;
    }

    /* ── Action bar (يظهر لما يكون فيه تحديد) ── */
    #autocut-action-bar {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 999px;
      padding: 7px 14px;
      display: none;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.45);
      animation: acSlideUp .2s ease;
    }
    #autocut-action-bar.visible { display: flex; }
    @keyframes acSlideUp {
      from { opacity:0; transform:translateY(8px); }
      to   { opacity:1; transform:translateY(0); }
    }

    #autocut-count {
      font-size: 12px;
      font-weight: 700;
      color: #f1f5f9;
      min-width: 60px;
    }

    .ac-exec-btn {
      border: none;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      padding: 5px 14px;
      cursor: pointer;
      transition: all .15s;
    }
    .ac-exec-btn.dl  { background: #22c55e; color: #000; }
    .ac-exec-btn.del { background: #ef4444; color: #fff; }
    .ac-exec-btn:hover { opacity: .85; transform: scale(1.03); }

    .ac-cancel-btn {
      background: transparent;
      border: 1px solid #334155;
      border-radius: 999px;
      color: #64748b;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 11px;
      cursor: pointer;
      transition: all .15s;
    }
    .ac-cancel-btn:hover { border-color: #94a3b8; color: #f1f5f9; }

    /* ── Tile selection overlay ── */
    [data-tile-id] {
      position: relative;
    }
    [data-tile-id].ac-sel-dl::after,
    [data-tile-id].ac-sel-del::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 6px;
      pointer-events: none;
      transition: all .15s;
      z-index: 10;
    }
    [data-tile-id].ac-sel-dl::after {
      background: rgba(34,197,94,.25);
      border: 2.5px solid #22c55e;
    }
    [data-tile-id].ac-sel-del::after {
      background: rgba(239,68,68,.25);
      border: 2.5px solid #ef4444;
    }

    /* ── Checkmark badge ── */
    [data-tile-id].ac-sel-dl .ac-check,
    [data-tile-id].ac-sel-del .ac-check {
      display: flex !important;
    }
    .ac-check {
      display: none;
      position: absolute;
      top: 6px;
      right: 6px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      z-index: 11;
      pointer-events: none;
    }
    [data-tile-id].ac-sel-dl .ac-check  { background: #22c55e; color: #000; }
    [data-tile-id].ac-sel-del .ac-check { background: #ef4444; color: #fff; }
  `;
  document.head.appendChild(style);

  // ── Build bar HTML ───────────────────────────────
  floatingBar = document.createElement('div');
  floatingBar.id = 'autocut-bar';
  floatingBar.innerHTML = `
    <div id="autocut-action-bar">
      <span id="autocut-count">0 محدد</span>
      <div class="ac-divider"></div>
      <button class="ac-exec-btn dl"  id="ac-exec-btn">📥 تحميل</button>
      <button class="ac-cancel-btn"   id="ac-cancel-btn">✕ إلغاء</button>
    </div>

    <div id="autocut-pill">
      <div id="autocut-logo">✂️ Auto<span>Cut</span></div>
      <div class="ac-divider"></div>
      <button class="ac-mode-btn" id="ac-dl-btn">📥 تحميل</button>
      <button class="ac-mode-btn" id="ac-del-btn">🗑️ حذف</button>
    </div>
  `;
  document.body.appendChild(floatingBar);

  // ── Listeners ────────────────────────────────────
  document.getElementById('ac-dl-btn').addEventListener('click',  () => toggleMode('download'));
  document.getElementById('ac-del-btn').addEventListener('click', () => toggleMode('delete'));
  document.getElementById('ac-cancel-btn').addEventListener('click', cancelSelection);
  document.getElementById('ac-exec-btn').addEventListener('click', executeAction);

  // ── Watch for new tiles (virtual scroll) ─────────
  startObserver();
}

// ══════════════════════════════════════════════════
//  MODE TOGGLE
// ══════════════════════════════════════════════════
function toggleMode(mode) {
  if (controlMode === mode) {
    // نفس الزرار → إيقاف الوضع
    cancelSelection();
    return;
  }

  controlMode = mode;
  selectedTiles.clear();

  // Update mode buttons style
  const dlBtn  = document.getElementById('ac-dl-btn');
  const delBtn = document.getElementById('ac-del-btn');
  dlBtn.className  = 'ac-mode-btn' + (mode === 'download' ? ' active-dl' : '');
  delBtn.className = 'ac-mode-btn' + (mode === 'delete'   ? ' active-del' : '');

  // Update exec button
  const execBtn = document.getElementById('ac-exec-btn');
  if (mode === 'download') {
    execBtn.textContent = '📥 تحميل';
    execBtn.className   = 'ac-exec-btn dl';
  } else {
    execBtn.textContent = '🗑️ حذف';
    execBtn.className   = 'ac-exec-btn del';
  }

  // Attach click handlers to all tiles
  attachTileListeners();
  updateActionBar();
}



// ══════════════════════════════════════════════════
//  TILE LISTENERS — إصلاح الـ duplicate
// ══════════════════════════════════════════════════
function attachTileListeners() {
  const tiles = document.querySelectorAll('[data-tile-id]');
  tiles.forEach((tile, index) => {
    if (tile.dataset.acListened === '1') return; // ✅ مش بيتمسح تاني

    tile.dataset.acListened = '1';

    // ✅ خزّن الـ index والـ description في data attributes
    tile.dataset.acIndex = index + 1;

    // استخرج الـ description من الـ href أو أي نص متاح
    const anchor = tile.querySelector('a[href]');
    const href   = anchor?.getAttribute('href') || '';
    // ✅ بنحاول نجيب الوصف من الـ aria-label أو أي data attribute
    const descEl = tile.querySelector('[aria-label]');
    tile.dataset.acDesc = descEl?.getAttribute('aria-label') || '';

    // أضف checkmark
    if (!tile.querySelector('.ac-check')) {
      const check = document.createElement('div');
      check.className = 'ac-check';
      check.textContent = '✓';
      tile.appendChild(check);
    }

    tile.addEventListener('click', onTileClick, true);
  });
}

function onTileClick(e) {
  if (!controlMode) return; // الوضع مش مفعّل — اتصرف بشكل عادي

  e.preventDefault();
  e.stopPropagation();

  const tile   = e.currentTarget;
  const tileId = tile.getAttribute('data-tile-id');

  if (selectedTiles.has(tileId)) {
    // deselect
    selectedTiles.delete(tileId);
    tile.classList.remove('ac-sel-dl', 'ac-sel-del');
  } else {
    // select
    selectedTiles.add(tileId);
    tile.classList.remove('ac-sel-dl', 'ac-sel-del');
    tile.classList.add(controlMode === 'download' ? 'ac-sel-dl' : 'ac-sel-del');
  }

  updateActionBar();
}

// ══════════════════════════════════════════════════
//  ACTION BAR UPDATE
// ══════════════════════════════════════════════════
function updateActionBar() {
  const bar   = document.getElementById('autocut-action-bar');
  const count = document.getElementById('autocut-count');
  if (!bar || !count) return;

  if (selectedTiles.size > 0) {
    bar.classList.add('visible');
    count.textContent = `${selectedTiles.size} محدد`;
  } else {
    bar.classList.remove('visible');
  }
}

// ══════════════════════════════════════════════════
//  EXECUTE ACTION
// ══════════════════════════════════════════════════
async function executeAction() {
  if (!selectedTiles.size || !controlMode) return;

  const selectedData = [];

  // ✅ بنلف على المحدد بس مش على كل الـ tiles
  for (const tileId of selectedTiles) {
    const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
    if (!tile) continue;

    const img = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    if (!img) continue;

    // ✅ بنجيب الـ src من الـ attribute مش من img.src عشان يكون relative
    const rawSrc  = img.getAttribute('src') || img.src;
    const fullUrl = rawSrc.startsWith('http') ? rawSrc : `${location.origin}${rawSrc}`;

    // ✅ deduplication — متحملش نفس الـ URL مرتين
    if (selectedData.some(d => d.url === fullUrl)) continue;

    const desc = tile.dataset.acDesc || '';

    selectedData.push({
      id:               tileId,
      url:              fullUrl,
      scene_number:     parseInt(tile.dataset.acIndex || '1'),
      scene_description: desc,
    });
  }

  if (!selectedData.length) { cancelSelection(); return; }

  if (controlMode === 'download') {
    chrome.runtime.sendMessage({
      type:   'EXECUTE_SELECTION',
      action: 'download',
      images: selectedData,
    });
  } else {
    chrome.runtime.sendMessage({
      type:    'EXECUTE_SELECTION',
      action:  'delete',
      tileIds: Array.from(selectedTiles), // ✅ بنبعت tileIds
      urls:    selectedData.map(d => d.url),
    });
  }

  cancelSelection();
}


// ══════════════════════════════════════════════════
//  CANCEL
// ══════════════════════════════════════════════════
function cancelSelection() {
  controlMode = null;
  selectedTiles.clear();

  // Remove selection classes from all tiles
  document.querySelectorAll('[data-tile-id]').forEach(tile => {
    tile.classList.remove('ac-sel-dl', 'ac-sel-del');
  });

  // Reset mode buttons
  const dlBtn  = document.getElementById('ac-dl-btn');
  const delBtn = document.getElementById('ac-del-btn');
  if (dlBtn)  dlBtn.className  = 'ac-mode-btn';
  if (delBtn) delBtn.className = 'ac-mode-btn';

  updateActionBar();
}

// ══════════════════════════════════════════════════
//  MUTATION OBSERVER (virtual scroll)
// ══════════════════════════════════════════════════
function startObserver() {
  const target = document.querySelector('[data-testid="virtuoso-item-list"]') || document.body;
  observer = new MutationObserver(() => {
    if (controlMode) attachTileListeners(); // أضف listeners للـ tiles الجديدة
  });
  observer.observe(target, { childList: true, subtree: true });
}

// ══════════════════════════════════════════════════
//  CAPTURE IMAGES FROM DOM
// ══════════════════════════════════════════════════
function captureImagesFromDOM() {
  const items = document.querySelectorAll('[data-testid="virtuoso-item-list"] [data-tile-id]');
  const images = [];

  items.forEach((tile, index) => {
    const img    = tile.querySelector('img[alt="صورة تم إنشاؤها"]');
    const anchor = tile.querySelector('a[href]');
    if (!img) return;

    const rawSrc  = img.getAttribute('src') || img.src;
    const fullUrl = rawSrc.startsWith('http') ? rawSrc : `${location.origin}${rawSrc}`;
    const tileId  = tile.getAttribute('data-tile-id') || `img_${index}`;
    const href    = anchor?.getAttribute('href') || '';
    const hrefParts   = href.split('/');
    const sceneUuid   = hrefParts[hrefParts.length - 1] || tileId;

    images.push({
      id:                tileId,
      url:               fullUrl,
      filename:          `image_${String(index + 1).padStart(3, '0')}.png`,
      scene_number:      index + 1,
      scene_description: sceneUuid,
      downloaded:        false,
    });
  });

  return images;
}
