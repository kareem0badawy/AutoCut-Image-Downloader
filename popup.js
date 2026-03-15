// ═══════════════════════════════════════════════════
//  AutoCut v2.1 — popup.js
// ═══════════════════════════════════════════════════

let scenes = [], doneCount = 0, failCount = 0;
let galleryMode = 'download';
let selectedImages = new Set();

const get = id => document.getElementById(id);

// ── Version ────────────────────────────────────────
fetch(chrome.runtime.getURL('version.json'))
  .then(r => r.json())
  .then(d => { get('version-badge').textContent = 'v' + d.version; })
  .catch(() => {});

// ── Tabs ───────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    get('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'queue')   renderSceneList();
    if (tab.dataset.tab === 'images')  renderGallery();
    if (tab.dataset.tab === 'history') renderHistory();
  });
});

// ── Theme ──────────────────────────────────────────
let dark = true;
chrome.storage.local.get(['dark'], r => { dark = r.dark !== false; applyTheme(); });
get('theme-btn').addEventListener('click', () => { dark = !dark; applyTheme(); chrome.storage.local.set({ dark }); });
function applyTheme() {
  document.body.className = dark ? '' : 'light';
  get('theme-btn').textContent = dark ? '🌙' : '☀️';
}

// ── Path preview ───────────────────────────────────
function updatePathPreview() {
  const prefix  = get('save-prefix').value  || 'scene_';
  const project = get('save-project').value.trim();
  const projEl  = get('preview-project');
  const fileEl  = get('preview-file');
  projEl.textContent = project || '—';
  projEl.style.color = project ? 'var(--accent)' : 'var(--muted2)';
  fileEl.textContent = `${prefix}001_description.png`;
}
get('save-prefix').addEventListener('input',  updatePathPreview);
get('save-project').addEventListener('input', updatePathPreview);

// ── Helper: build folder path ──────────────────────
function buildFolder() {
  const project = get('save-project').value.trim();
  return project ? `AutoCut/${project}` : 'AutoCut';
}

// ── Auto-download toggle ───────────────────────────
get('auto-download-toggle').addEventListener('change', e => {
  const on = e.target.checked;
  chrome.storage.local.set({ autoDownload: on });
  get('auto-dl-hint').textContent = on
    ? 'مفعّل — الصور بتتحمل تلقائياً وبتتحفظ في تاب الصور'
    : 'موقف — الصور بتتجمع في تاب الصور فقط، تحميل يدوي';
});

// ── Restore state ──────────────────────────────────
chrome.storage.local.get(['scenes','doneCount','failCount','prefix','saveProject','autoDownload','isRunning'], r => {
  if (r.scenes?.length) {
    scenes = r.scenes;
    get('upload-area').classList.add('loaded');
    get('upload-count').textContent = scenes.length + ' مشهد جاهز ✓';
    get('stat-total').textContent = scenes.length;
    checkReady();
  }
  if (r.doneCount) { doneCount = r.doneCount; get('stat-done').textContent = doneCount; }
  if (r.failCount) { failCount = r.failCount; get('stat-fail').textContent = failCount; }
  if (r.prefix)      get('save-prefix').value  = r.prefix;
  if (r.saveProject) get('save-project').value = r.saveProject;
  updatePathPreview();

  if (r.autoDownload === false) {
    get('auto-download-toggle').checked = false;
    get('auto-dl-hint').textContent = 'موقف — الصور بتتجمع في تاب الصور فقط، تحميل يدوي';
  }
  if (r.isRunning) { get('start-btn').style.display = 'none'; get('stop-btn').style.display = 'block'; }
  updateRetryBtn();

  chrome.storage.local.get(['lastProgress'], r2 => {
    if (r2.lastProgress) {
      const { i, total, scene } = r2.lastProgress;
      const pct = Math.round((i / total) * 100);
      get('progress-bar').style.width = pct + '%';
      get('progress-pct').textContent = pct + '%';
      get('progress-scene').textContent = `Scene ${scene.scene_number}: ${(scene.scene_description||'').slice(0,55)}`;
      get('progress-wrap').style.display = 'flex';
    }
  });
});

chrome.storage.local.get(['logs'], r => {
  if (r.logs?.length) {
    get('log').style.display = 'block';
    r.logs.forEach(l => _addLogDOM(l.type, l.msg));
  }
});

// ── Messages from background ───────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') {
    addLog(msg.logType, msg.msg);
  } else if (msg.type === 'PROGRESS') {
    const pct = Math.round((msg.i / msg.total) * 100);
    get('progress-bar').style.width = pct + '%';
    get('progress-pct').textContent = pct + '%';
    get('progress-scene').textContent = `Scene ${msg.scene.scene_number}: ${(msg.scene.scene_description||'').slice(0,55)}`;
    get('progress-wrap').style.display = 'flex';
    updateSceneBadge(msg.scene.scene_number, 'running');
  } else if (msg.type === 'STATS') {
    doneCount = msg.done; failCount = msg.fail;
    get('stat-done').textContent = msg.done;
    get('stat-fail').textContent = msg.fail;
    updateRetryBtn();
  } else if (msg.type === 'DONE') {
    get('start-btn').style.display = 'block';
    get('stop-btn').style.display = 'none';
    get('progress-bar').style.width = '100%';
    get('progress-pct').textContent = '100%';
    get('progress-scene').textContent = '🎉 اكتمل!';
    get('export-btn').disabled = false;
    chrome.storage.local.get(['scenes'], r => {
      if (r.scenes) { scenes = r.scenes; renderSceneList(); }
    });
    updateRetryBtn();
  } else if (msg.type === 'IMAGE_CAPTURED') {
    const imgTab = document.querySelector('[data-tab="images"]');
    if (imgTab?.classList.contains('active')) renderGallery();
    get('gallery-count').textContent = (msg.capturedImages?.length || 0) + ' صورة';
  } else if (msg.type === 'HISTORY_UPDATE') {
    const histTab = document.querySelector('[data-tab="history"]');
    if (histTab?.classList.contains('active')) renderHistory();
  }
});

// ── Upload ─────────────────────────────────────────
get('upload-area').addEventListener('click', () => get('json-input').click());
get('json-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      scenes = JSON.parse(ev.target.result);
      chrome.storage.local.set({ scenes, doneCount: 0, failCount: 0, logs: [] });
      get('upload-area').classList.add('loaded');
      get('upload-count').textContent = scenes.length + ' مشهد جاهز ✓';
      get('stat-total').textContent = scenes.length;
      get('stat-done').textContent = '0';
      get('stat-fail').textContent = '0';
      get('log').innerHTML = '';
      doneCount = 0; failCount = 0;
      checkReady(); renderSceneList();
      addLog('info', `تم تحميل ${scenes.length} مشهد`);
    } catch (e) { addLog('err', 'خطأ: ' + e.message); }
  };
  reader.readAsText(file, 'utf-8');
});

// ── Helpers ────────────────────────────────────────
function checkReady() {
  get('start-btn').disabled = !scenes.length;
  get('export-btn').disabled = !(doneCount > 0 || failCount > 0);
  updateRetryBtn();
}
function updateRetryBtn() {
  get('retry-btn').disabled = !scenes.some(s => s._failed);
}

// ── Start ──────────────────────────────────────────
get('start-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }
  const prefix = get('save-prefix').value || 'scene_';
  const project = get('save-project').value.trim();
  const folder  = buildFolder();
  chrome.storage.local.set({ prefix, saveProject: project, stopFlag: false });
  get('start-btn').style.display = 'none';
  get('stop-btn').style.display = 'block';
  get('progress-wrap').style.display = 'flex';
  get('log').style.display = 'block';
  chrome.runtime.sendMessage({ type: 'START_QUEUE', scenes, prefix, folder, tabId: tab.id });
  addLog('info', `بدأ التشغيل ✓ → Downloads/${folder}/`);
});

// ── Stop ───────────────────────────────────────────
get('stop-btn').addEventListener('click', () => {
  chrome.storage.local.set({ stopFlag: true });
  addLog('info', '⏸ طلب إيقاف...');
  get('start-btn').style.display = 'block';
  get('stop-btn').style.display = 'none';
});

// ── Retry Failed ───────────────────────────────────
get('retry-btn').addEventListener('click', async () => {
  const failed = scenes.filter(s => s._failed);
  if (!failed.length) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }
  const prefix = get('save-prefix').value || 'scene_';
  const folder = buildFolder(); // ✅ مش save-folder
  get('start-btn').style.display = 'none';
  get('stop-btn').style.display = 'block';
  chrome.runtime.sendMessage({ type: 'RETRY_FAILED', scenes: failed, prefix, folder, tabId: tab.id });
  addLog('info', `↻ إعادة ${failed.length} مشاهد فاشلة`);
});

// ── Export Report ──────────────────────────────────
get('export-btn').addEventListener('click', () => {
  chrome.storage.local.get(['scenes','doneCount','failCount','sessionHistory'], r => {
    const report = {
      generated_at: new Date().toISOString(),
      summary: { total: scenes.length, done: r.doneCount||0, failed: r.failCount||0 },
      scenes: (r.scenes||[]).map(s => ({
        scene_number: s.scene_number,
        scene_description: s.scene_description,
        status: s._done ? 'done' : s._failed ? 'failed' : 'pending'
      })),
      failed_scenes: (r.scenes||[]).filter(s => s._failed).map(s => s.scene_number),
      session_history: r.sessionHistory||[]
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const folder = buildFolder(); // ✅ مش save-folder
    chrome.downloads.download({ url, filename: `${folder}/report_${Date.now()}.json`, saveAs: false });
    addLog('ok', 'تم تصدير التقرير ✓');
  });
});

// ══════════════════════════════════════════════════
//  GALLERY TAB
// ══════════════════════════════════════════════════

get('mode-dl-btn').addEventListener('click', () => setGalleryMode('download'));
get('mode-del-btn').addEventListener('click', () => setGalleryMode('delete'));

function setGalleryMode(mode) {
  galleryMode = mode;
  selectedImages.clear();
  get('mode-dl-btn').className  = 'btn btn-secondary mode-btn' + (mode === 'download' ? ' active-dl' : '');
  get('mode-del-btn').className = 'btn btn-secondary mode-btn' + (mode === 'delete'   ? ' active-del' : '');
  get('dl-selected-btn').disabled  = true;
  get('del-selected-btn').disabled = true;
  renderGallery();
}

get('sel-all-btn').addEventListener('click', () => {
  chrome.storage.local.get(['capturedImages'], r => {
    const imgs = r.capturedImages || [];
    imgs.forEach(img => selectedImages.add(img.id));
    updateSelectionButtons();
    renderGallery();
  });
});
get('desel-all-btn').addEventListener('click', () => {
  selectedImages.clear();
  updateSelectionButtons();
  renderGallery();
});

get('dl-selected-btn').addEventListener('click', () => {
  if (!selectedImages.size) return;
  const folder = buildFolder(); // ✅ مش save-folder
  chrome.storage.local.get(['capturedImages'], r => {
    const imgs = (r.capturedImages || []).filter(img => selectedImages.has(img.id));
    imgs.forEach(img => {
      chrome.runtime.sendMessage({ type: 'MANUAL_DOWNLOAD', url: img.url, filename: img.filename, folder });
    });
    addLog('ok', `📥 تحميل ${imgs.length} صورة...`);
    chrome.storage.local.get(['capturedImages'], r2 => {
      const all = r2.capturedImages || [];
      all.forEach(img => { if (selectedImages.has(img.id)) img.downloaded = true; });
      chrome.storage.local.set({ capturedImages: all }, () => {
        selectedImages.clear();
        renderGallery();
        updateSelectionButtons();
      });
    });
  });
});

get('del-selected-btn').addEventListener('click', () => {
  if (!selectedImages.size) return;
  chrome.storage.local.get(['capturedImages'], r => {
    const remaining = (r.capturedImages || []).filter(img => !selectedImages.has(img.id));
    chrome.storage.local.set({ capturedImages: remaining }, () => {
      addLog('info', `🗑️ حُذف ${selectedImages.size} صورة من القائمة`);
      selectedImages.clear();
      renderGallery();
      updateSelectionButtons();
    });
  });
});

function updateSelectionButtons() {
  const has = selectedImages.size > 0;
  get('dl-selected-btn').disabled  = !has;
  get('del-selected-btn').disabled = !has;
  if (has) {
    get('dl-selected-btn').textContent  = `📥 تحميل (${selectedImages.size})`;
    get('del-selected-btn').textContent = `🗑️ حذف (${selectedImages.size})`;
  } else {
    get('dl-selected-btn').textContent  = '📥 تحميل المحدد';
    get('del-selected-btn').textContent = '🗑️ حذف المحدد';
  }
}

function renderGallery() {
  chrome.storage.local.get(['capturedImages'], r => {
    const imgs = r.capturedImages || [];
    const grid = get('gallery-grid');
    get('gallery-count').textContent = imgs.length + ' صورة';
    if (!imgs.length) {
      grid.innerHTML = '<div class="gallery-empty" style="grid-column:1/-1">الصور ستظهر هنا بعد التوليد</div>';
      return;
    }
    grid.innerHTML = '';
    imgs.forEach(img => {
      const isSelected = selectedImages.has(img.id);
      const selClass = isSelected ? (galleryMode === 'download' ? 'sel-download' : 'sel-delete') : '';
      const overlayIcon = galleryMode === 'download' ? '📥' : '🗑️';
      const item = document.createElement('div');
      item.className = `gallery-item ${selClass}`;
      item.dataset.id = img.id;
      item.innerHTML = `
        <img src="${img.url}" alt="Scene ${img.scene_number}" loading="lazy">
        <div class="overlay">${overlayIcon}</div>
        ${img.downloaded ? '<div class="downloaded-badge">✓ تم</div>' : ''}
        <div class="scene-label">#${String(img.scene_number).padStart(3,'0')} ${img.scene_description || ''}</div>
      `;
      item.addEventListener('click', () => {
        if (selectedImages.has(img.id)) {
          selectedImages.delete(img.id);
          item.className = 'gallery-item';
        } else {
          selectedImages.add(img.id);
          item.className = `gallery-item ${galleryMode === 'download' ? 'sel-download' : 'sel-delete'}`;
        }
        updateSelectionButtons();
      });
      grid.appendChild(item);
    });
  });
}

// ══════════════════════════════════════════════════
//  QUEUE TAB
// ══════════════════════════════════════════════════
function renderSceneList() {
  const list = get('scene-list');
  get('queue-count').textContent = scenes.length + ' مشهد';
  if (!scenes.length) {
    list.innerHTML = '<div class="empty-state">ارفع prompts.json الأول</div>';
    return;
  }
  list.innerHTML = '';
  scenes.forEach(scene => {
    const status = scene._done ? 'done' : scene._failed ? 'failed' : scene._skipped ? 'skipped' : 'pending';
    const badgeMap = { done:'badge-done', failed:'badge-failed', pending:'badge-pending', skipped:'badge-skipped', running:'badge-running' };
    const labelMap = { done:'✓ تم', failed:'✗ فشل', pending:'⏳', skipped:'⏭', running:'⚡' };
    const item = document.createElement('div');
    item.className = `scene-item ${scene._done ? 'done' : scene._failed ? 'failed' : ''}`;
    item.id = 'scene-item-' + scene.scene_number;
    item.innerHTML = `
      <span class="scene-num">#${String(scene.scene_number).padStart(3,'0')}</span>
      <span class="scene-desc">${(scene.scene_description||'بدون وصف').slice(0,50)}</span>
      <span class="scene-badge ${badgeMap[status]}">${labelMap[status]}</span>
      <button class="sm-btn skip-btn" data-num="${scene.scene_number}" ${scene._done||scene._skipped?'style="display:none"':''}>⏭</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll('.skip-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const num = parseInt(btn.dataset.num);
      const idx = scenes.findIndex(s => s.scene_number === num);
      if (idx !== -1) {
        scenes[idx]._skipped = true; scenes[idx]._failed = false;
        chrome.storage.local.set({ scenes });
        renderSceneList();
        addLog('info', `⏭ تخطي Scene #${String(num).padStart(3,'0')}`);
      }
    });
  });
}

function updateSceneBadge(sceneNumber, status) {
  const item = get('scene-item-' + sceneNumber);
  if (!item) return;
  item.className = 'scene-item' + (status === 'running' ? ' running' : '');
  const badge = item.querySelector('.scene-badge');
  if (badge) {
    const bMap = { running:'badge-running', done:'badge-done', failed:'badge-failed' };
    const lMap = { running:'⚡', done:'✓ تم', failed:'✗ فشل' };
    badge.className = 'scene-badge ' + bMap[status];
    badge.textContent = lMap[status];
  }
}

// ══════════════════════════════════════════════════
//  HISTORY TAB
// ══════════════════════════════════════════════════
function renderHistory() {
  chrome.storage.local.get(['sessionHistory'], r => {
    const list = get('history-list');
    const history = r.sessionHistory || [];
    if (!history.length) {
      list.innerHTML = '<div class="history-empty">مفيش جلسات سابقة</div>';
      return;
    }
    list.innerHTML = '';
    history.forEach(h => {
      const d = new Date(h.date);
      const dateStr = d.toLocaleDateString('ar-EG', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-date">${dateStr}</div>
        <div class="history-stats">
          <span class="h-stat blue">${h.total} 📋</span>
          <span class="h-stat green">${h.done} ✓</span>
          <span class="h-stat red">${h.fail} ✗</span>
          <span class="h-stat" style="color:var(--muted2);margin-right:auto;font-weight:400">${h.duration}s</span>
        </div>
      `;
      list.appendChild(item);
    });
  });
}
get('clear-history-btn').addEventListener('click', () => {
  chrome.storage.local.set({ sessionHistory: [] });
  renderHistory();
});

// ══════════════════════════════════════════════════
//  LOG HELPERS
// ══════════════════════════════════════════════════
function addLog(type, msg) {
  _addLogDOM(type, msg);
  chrome.storage.local.get(['logs'], r => {
    const logs = r.logs || [];
    logs.push({ type, msg });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    chrome.storage.local.set({ logs });
  });
}
function _addLogDOM(type, msg) {
  const d = document.createElement('div');
  d.className = type; d.textContent = msg;
  get('log').appendChild(d);
  get('log').scrollTop = get('log').scrollHeight;
  get('log').style.display = 'block';
}

// ── Clear All ──────────────────────────────────────
get('clear-btn').addEventListener('click', () => get('confirm-overlay').classList.add('show'));
get('confirm-no').addEventListener('click', () => get('confirm-overlay').classList.remove('show'));
get('confirm-yes').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    scenes = []; doneCount = 0; failCount = 0;
    get('upload-area').classList.remove('loaded');
    get('upload-count').textContent = '';
    get('stat-total').textContent = '0';
    get('stat-done').textContent = '0';
    get('stat-fail').textContent = '0';
    get('log').innerHTML = ''; get('log').style.display = 'none';
    get('progress-wrap').style.display = 'none';
    get('progress-bar').style.width = '0%';
    get('start-btn').disabled = true;
    get('start-btn').style.display = 'block';
    get('stop-btn').style.display = 'none';
    get('retry-btn').disabled = true;
    get('export-btn').disabled = true;
    get('gallery-grid').innerHTML = '<div class="gallery-empty" style="grid-column:1/-1">الصور ستظهر هنا بعد التوليد</div>';
    get('scene-list').innerHTML = '<div class="empty-state">ارفع prompts.json الأول</div>';
    get('confirm-overlay').classList.remove('show');
    selectedImages.clear();
    get('save-project').value = '';
    updatePathPreview();
    applyTheme();
  });
});
