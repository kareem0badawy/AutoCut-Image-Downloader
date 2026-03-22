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

// ══════════════════════════════════════════════════
//  COLLAPSE LOGIC
// ══════════════════════════════════════════════════

// Flow Settings — مفتوح بالـ default
let flowCollapsed = false;
document.getElementById('flow-settings-header').addEventListener('click', () => {
  flowCollapsed = !flowCollapsed;
  const body = document.getElementById('flow-settings-collapse');
  const icon = document.getElementById('flow-collapse-icon');
  body.style.maxHeight = flowCollapsed ? '0' : '600px';
  icon.style.transform = flowCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
});

// Save Settings — مقفول بالـ default
let saveCollapsed = true;
document.getElementById('save-settings-header').addEventListener('click', () => {
  saveCollapsed = !saveCollapsed;
  const body = document.getElementById('save-settings-collapse');
  const icon = document.getElementById('save-collapse-icon');
  body.style.maxHeight = saveCollapsed ? '0' : '400px';
  icon.style.transform = saveCollapsed ? 'rotate(0deg)' : 'rotate(90deg)';
});

document.getElementById('flow-toggle-wrap')
  .addEventListener('click', e => e.stopPropagation());

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

  if (r.autoDownload !== true) {
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

// ── Inject Control ─────────────────────────────────
get('inject-control-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'INJECT_CONTROL' });
  addLog('info', '🎯 تم تفعيل الكنترول في الصفحة');
});

// ── Retry Failed ───────────────────────────────────
get('retry-btn').addEventListener('click', async () => {
  const failed = scenes.filter(s => s._failed);
  if (!failed.length) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }
  const prefix = get('save-prefix').value || 'scene_';
  const folder = buildFolder();
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
    const folder = buildFolder();
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

  const folder = buildFolder();

  chrome.storage.local.get(['capturedImages'], r => {
    const imgs = (r.capturedImages || []).filter(img => selectedImages.has(img.id));

    if (!imgs.length) {
      addLog('err', 'مفيش صور محددة للتحميل');
      return;
    }

   let count = 0;
    imgs.forEach((img) => {
      // استخدم الاسم المخزن في capturedImages مباشرة
      const filename = img.filename || (() => {
        const prefix = get('save-prefix').value || 'scene_';
        const num  = String(img.scene_number || 1).padStart(3, '0');
        const desc = (img.scene_description || '')
          .replace(/,/g, ' ')
          .replace(/[\\/:*?"<>|]/g, '')
          .trim()
          .slice(0, 80);
        return desc ? `${prefix}${num}_${desc}.png` : `${prefix}${num}.png`;
      })();

      chrome.runtime.sendMessage({
        type:     'MANUAL_DOWNLOAD',
        url:      img.url,
        filename: filename,
        folder:   folder
      });
      count++;
    });

    addLog('ok', `📥 بدأ تحميل ${count} صورة → Downloads/${folder}/`);

    const all = r.capturedImages || [];
    all.forEach(img => {
      if (selectedImages.has(img.id)) img.downloaded = true;
    });
    chrome.storage.local.set({ capturedImages: all }, () => {
      selectedImages.clear();
      renderGallery();
      updateSelectionButtons();
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
      const isSelected  = selectedImages.has(img.id);
      const selClass    = isSelected ? (galleryMode === 'download' ? 'sel-download' : 'sel-delete') : '';
      const overlayIcon = galleryMode === 'download' ? '📥' : '🗑️';
      const item = document.createElement('div');
      item.className  = `gallery-item ${selClass}`;
      item.dataset.id = img.id;
      item.innerHTML  = `
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
    const status   = scene._done ? 'done' : scene._failed ? 'failed' : scene._skipped ? 'skipped' : 'pending';
    const badgeMap = { done:'badge-done', failed:'badge-failed', pending:'badge-pending', skipped:'badge-skipped', running:'badge-running' };
    const labelMap = { done:'✓ تم', failed:'✗ فشل', pending:'⏳', skipped:'⏭', running:'⚡' };
    const item = document.createElement('div');
    item.className = `scene-item ${scene._done ? 'done' : scene._failed ? 'failed' : ''}`;
    item.id        = 'scene-item-' + scene.scene_number;
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
    badge.className   = 'scene-badge ' + bMap[status];
    badge.textContent = lMap[status];
  }
}

// ══════════════════════════════════════════════════
//  HISTORY TAB
// ══════════════════════════════════════════════════
function renderHistory() {
  chrome.storage.local.get(['sessionHistory'], r => {
    const list    = get('history-list');
    const history = r.sessionHistory || [];
    if (!history.length) {
      list.innerHTML = '<div class="history-empty">مفيش جلسات سابقة</div>';
      return;
    }
    list.innerHTML = '';
    history.forEach(h => {
      const d       = new Date(h.date);
      const dateStr = d.toLocaleDateString('ar-EG', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const item    = document.createElement('div');
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
  d.className   = type;
  d.textContent = msg;
  get('log').appendChild(d);
  get('log').scrollTop = get('log').scrollHeight;
  get('log').style.display = 'block';
}

// ── Clear All ──────────────────────────────────────
get('clear-btn').addEventListener('click', () => get('confirm-overlay').classList.add('show'));
get('confirm-no').addEventListener('click',  () => get('confirm-overlay').classList.remove('show'));
get('confirm-yes').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    scenes = []; doneCount = 0; failCount = 0;
    get('upload-area').classList.remove('loaded');
    get('upload-count').textContent  = '';
    get('stat-total').textContent    = '0';
    get('stat-done').textContent     = '0';
    get('stat-fail').textContent     = '0';
    get('log').innerHTML             = '';
    get('log').style.display         = 'none';
    get('progress-wrap').style.display = 'none';
    get('progress-bar').style.width    = '0%';
    get('start-btn').disabled          = true;
    get('start-btn').style.display     = 'block';
    get('stop-btn').style.display      = 'none';
    get('retry-btn').disabled          = true;
    get('export-btn').disabled         = true;
    get('gallery-grid').innerHTML      = '<div class="gallery-empty" style="grid-column:1/-1">الصور ستظهر هنا بعد التوليد</div>';
    get('scene-list').innerHTML        = '<div class="empty-state">ارفع prompts.json الأول</div>';
    get('confirm-overlay').classList.remove('show');
    selectedImages.clear();
    get('save-project').value = '';
    updatePathPreview();
    applyTheme();
    flowSettings = { mediaType: 'IMAGE', orientation: 'LANDSCAPE', count: 1, model: '', enabled: false };
    _cachedModels = [];
    get('model-btns').innerHTML = '<span style="font-size:11px;color:var(--muted2)">اضغط "تحديث" لجلب الموديلات من Flow</span>';
    updateSettingsBtns();
    updateFlowToggleUI();
    // reset Whisk tab
    whiskScenes = []; whiskDoneCount = 0; whiskFailCount = 0;
    get('whisk-upload-area').classList.remove('loaded');
    get('whisk-upload-count').textContent   = '';
    get('whisk-stat-total').textContent     = '0';
    get('whisk-stat-done').textContent      = '0';
    get('whisk-stat-fail').textContent      = '0';
    get('whisk-log').innerHTML              = '';
    get('whisk-log').style.display          = 'none';
    get('whisk-progress-wrap').style.display = 'none';
    get('whisk-progress-bar').style.width   = '0%';
    get('whisk-start-btn').disabled         = true;
    get('whisk-start-btn').style.display    = 'block';
    get('whisk-stop-btn').style.display     = 'none';
    get('whisk-retry-btn').disabled         = true;
    get('whisk-prefix').value               = 'scene_';
    get('whisk-project').value              = '';
    get('whisk-auto-download').checked      = false;
    get('whisk-auto-dl-hint').textContent   = 'موقف — استخدم الكنترول في الصفحة للتحميل اليدوي';
    updateWhiskPathPreview();
  });
});

// ══════════════════════════════════════════════════
//  FLOW SETTINGS
// ══════════════════════════════════════════════════
let flowSettings = { mediaType: 'IMAGE', orientation: 'LANDSCAPE', count: 1, model: '', enabled: false };

chrome.storage.local.get(['flowSettings'], r => {
  if (r.flowSettings) {
    flowSettings = { ...flowSettings, ...r.flowSettings };
  }
  if (r.flowSettings?.enabled === undefined) {
    flowSettings.enabled = false;
  }
  console.log('[AutoCut] flowSettings loaded:', flowSettings);
  updateSettingsBtns();
  updateFlowToggleUI();
});

function saveFlowSettings() {
  chrome.storage.local.set({ flowSettings });
  console.log('[AutoCut] flowSettings saved:', flowSettings);
  updateSettingsBtns();
}

get('flow-settings-toggle').addEventListener('change', e => {
  flowSettings.enabled = e.target.checked;
  console.log('[AutoCut] toggle changed → enabled:', flowSettings.enabled);
  saveFlowSettings();
  updateFlowToggleUI();
});

function updateFlowToggleUI() {
  const enabled = flowSettings.enabled === true;
  get('flow-settings-toggle').checked             = enabled;
  get('flow-settings-body').style.opacity         = enabled ? '1'    : '0.4';
  get('flow-settings-body').style.pointerEvents   = enabled ? ''     : 'none';
  get('flow-settings-body').style.display         = 'block';
  get('flow-settings-disabled-msg').style.display = enabled ? 'none' : 'block';
  console.log('[AutoCut] UI updated → enabled:', enabled);
}

function updateSettingsBtns() {
  get('type-image-btn').className       = 'btn ' + (flowSettings.mediaType   === 'IMAGE'     ? 'btn-primary' : 'btn-secondary');
  get('type-video-btn').className       = 'btn ' + (flowSettings.mediaType   === 'VIDEO'     ? 'btn-primary' : 'btn-secondary');
  get('orient-landscape-btn').className = 'btn ' + (flowSettings.orientation === 'LANDSCAPE' ? 'btn-primary' : 'btn-secondary');
  get('orient-portrait-btn').className  = 'btn ' + (flowSettings.orientation === 'PORTRAIT'  ? 'btn-primary' : 'btn-secondary');

  document.querySelectorAll('[data-count]').forEach(btn => {
    btn.className = 'btn ' + (parseInt(btn.dataset.count) === flowSettings.count ? 'btn-primary' : 'btn-secondary');
  });

  // الموديل — بس بنحدث الأزرار الموجودة بدون إعادة رسم
  document.querySelectorAll('.model-btn').forEach(btn => {
    const isActive    = btn.dataset.model === flowSettings.model;
    btn.className     = 'sm-btn model-btn' + (isActive ? ' active-model' : '');
    btn.style.cssText = isActive
      ? 'background:var(--accent-s);color:var(--accent);border-color:var(--accent);font-size:11px;padding:5px 10px'
      : 'font-size:11px;padding:5px 10px';
  });
}

// ── Count buttons
// document-level capture listener — يشتغل حتى لو الـ body عنده opacity:0.4
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-count]');
  if (!btn) return;
  const newCount = parseInt(btn.dataset.count);
  if (isNaN(newCount)) return;
  console.log('[AutoCut] count clicked → new:', newCount, '| old:', flowSettings.count);
  flowSettings.count = newCount;
  saveFlowSettings();
}, true);

get('type-image-btn').addEventListener('click',       () => { flowSettings.mediaType   = 'IMAGE';     console.log('[AutoCut] mediaType → IMAGE');      saveFlowSettings(); });
get('type-video-btn').addEventListener('click',       () => { flowSettings.mediaType   = 'VIDEO';     console.log('[AutoCut] mediaType → VIDEO');      saveFlowSettings(); });
get('orient-landscape-btn').addEventListener('click', () => { flowSettings.orientation = 'LANDSCAPE'; console.log('[AutoCut] orientation → LANDSCAPE'); saveFlowSettings(); });
get('orient-portrait-btn').addEventListener('click',  () => { flowSettings.orientation = 'PORTRAIT';  console.log('[AutoCut] orientation → PORTRAIT');  saveFlowSettings(); });

let _cachedModels = [];

function renderModelBtns(models, currentModel) {
  const container = get('model-btns');
  if (!models.length) {
    container.innerHTML = '<span style="font-size:11px;color:var(--red)">⚠️ مش لاقي موديلات — تأكد إن Flow مفتوح</span>';
    return;
  }
  _cachedModels = models;
  if (!flowSettings.model && currentModel) flowSettings.model = currentModel;

  container.innerHTML = '';
  models.forEach(model => {
    const btn      = document.createElement('button');
    // هنا بنقرأ flowSettings.model الحالي مش currentModel
    const isActive = model === flowSettings.model;
    btn.className     = 'sm-btn model-btn' + (isActive ? ' active-model' : '');
    btn.dataset.model = model;
    btn.textContent   = model;
    btn.style.cssText = isActive
      ? 'background:var(--accent-s);color:var(--accent);border-color:var(--accent);font-size:11px;padding:5px 10px'
      : 'font-size:11px;padding:5px 10px';
    btn.addEventListener('click', () => {
      console.log('[AutoCut] model selected:', model);
      flowSettings.model = model;
      saveFlowSettings();
    });
    container.appendChild(btn);
  });
}

// ── زرار تحديث ──
get('refresh-settings-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }

  console.log('[AutoCut] refresh clicked → tabId:', tab.id);
  get('model-loading').style.display   = 'inline';
  get('refresh-settings-btn').disabled = true;

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_FLOW_MODELS' }, response => {
        if (chrome.runtime.lastError) {
          console.error('[AutoCut] GET_FLOW_MODELS error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          console.log('[AutoCut] GET_FLOW_MODELS result:', response);
          resolve(response);
        }
      });
    });

    if (result?.models?.length) {
      renderModelBtns(result.models, result.current);
      if (result.settings) {
        flowSettings = {
          ...flowSettings,
          mediaType:   result.settings.mediaType   || flowSettings.mediaType,
          orientation: result.settings.orientation || flowSettings.orientation,
          count:       result.settings.count       || flowSettings.count,
          model:       result.current              || flowSettings.model,
        };
        saveFlowSettings();
      }
      addLog('ok', `✓ ${result.models.length} موديلات — الحالي: ${result.current}`);
    } else {
      console.warn('[AutoCut] no models found, result:', result);
      get('model-btns').innerHTML = '<span style="font-size:11px;color:var(--red)">⚠️ مش لاقي موديلات</span>';
      addLog('err', 'مش لاقي موديلات في Flow');
    }
  }  catch (e) {
    console.error('[AutoCut] refresh error:', e.message);
    const msg = e.message?.includes('Receiving end')
      ? 'افتح صفحة Flow الأول ثم اضغط تحديث'
      : 'خطأ: ' + e.message;
    get('model-btns').innerHTML = `<span style="font-size:11px;color:var(--amber)">⚠️ ${msg}</span>`;
    addLog('err', msg);
  } finally {
    get('model-loading').style.display   = 'none';
    get('refresh-settings-btn').disabled = false;
  }
});

// ── زرار Apply ──
get('apply-settings-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }

  console.log('[AutoCut] apply clicked → settings:', flowSettings, '→ tabId:', tab.id);

  const btn    = get('apply-settings-btn');
  const status = get('settings-status');
  btn.disabled    = true;
  btn.textContent = '⏳ جاري التطبيق...';
  status.style.display = 'block';
  status.style.color   = 'var(--muted2)';
  status.textContent   = '';

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { type: 'APPLY_SETTINGS', settings: flowSettings }, response => {
        if (chrome.runtime.lastError) {
          console.error('[AutoCut] APPLY_SETTINGS error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          console.log('[AutoCut] APPLY_SETTINGS result:', response);
          resolve(response);
        }
      });
    });

    if (result?.ok) {
      status.textContent = '✅ تم التطبيق بنجاح';
      status.style.color = 'var(--green)';
      addLog('ok', `⚙️ ${flowSettings.mediaType} | ${flowSettings.orientation} | x${flowSettings.count} | ${flowSettings.model}`);
    } else {
      status.textContent = '⚠️ تعذر التطبيق';
      status.style.color = 'var(--amber)';
      console.warn('[AutoCut] apply returned ok:false');
      addLog('err', 'تعذر التطبيق — شوف الـ console في صفحة Flow');
    }
  } catch (e) {
    console.error('[AutoCut] apply exception:', e.message);
    status.textContent = '❌ خطأ — تأكد إن Flow مفتوح';
    status.style.color = 'var(--red)';
    addLog('err', 'خطأ: ' + e.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = '✅ تطبيق على Flow';
    setTimeout(() => { status.style.display = 'none'; }, 3000);
  }
});
// ══════════════════════════════════════════════════
//  WHISK TAB LOGIC
// ══════════════════════════════════════════════════

let whiskScenes = [], whiskDoneCount = 0, whiskFailCount = 0;

// ── Path preview ──
function updateWhiskPathPreview() {
  const prefix  = get('whisk-prefix').value  || 'scene_';
  const project = get('whisk-project').value.trim();
  get('whisk-preview-project').textContent = project || '—';
  get('whisk-preview-project').style.color = project ? 'var(--accent)' : 'var(--muted2)';
  get('whisk-preview-file').textContent    = `${prefix}001_description.png`;
}
get('whisk-prefix').addEventListener('input',  updateWhiskPathPreview);
get('whisk-project').addEventListener('input', updateWhiskPathPreview);

// ── Save settings collapse ──
let whiskSaveCollapsed = true;
get('whisk-save-header').addEventListener('click', () => {
  whiskSaveCollapsed = !whiskSaveCollapsed;
  get('whisk-save-collapse').style.maxHeight = whiskSaveCollapsed ? '0' : '400px';
  get('whisk-save-icon').style.transform     = whiskSaveCollapsed ? 'rotate(0deg)' : 'rotate(90deg)';
});

// ── Auto-download toggle ──
get('whisk-auto-download').addEventListener('change', e => {
  const on = e.target.checked;
  chrome.storage.local.set({ whiskAutoDownload: on });
  get('whisk-auto-dl-hint').textContent = on
    ? 'مفعّل — الصور بتتحمل تلقائياً بعد كل مشهد'
    : 'موقف — استخدم الكنترول في الصفحة للتحميل اليدوي';
});

// ── Restore state ──
chrome.storage.local.get([
  'whiskScenes','whiskDoneCount','whiskFailCount',
  'whiskPrefix','whiskProject','whiskAutoDownload','whiskIsRunning'
], r => {
  if (r.whiskScenes?.length) {
    whiskScenes = r.whiskScenes;
    get('whisk-upload-area').classList.add('loaded');
    get('whisk-upload-count').textContent = whiskScenes.length + ' مشهد جاهز ✓';
    get('whisk-stat-total').textContent   = whiskScenes.length;
    whiskCheckReady();
  }
  if (r.whiskDoneCount) { whiskDoneCount = r.whiskDoneCount; get('whisk-stat-done').textContent = whiskDoneCount; }
  if (r.whiskFailCount) { whiskFailCount = r.whiskFailCount; get('whisk-stat-fail').textContent = whiskFailCount; }
  if (r.whiskPrefix)  get('whisk-prefix').value  = r.whiskPrefix;
  if (r.whiskProject) get('whisk-project').value = r.whiskProject;
  updateWhiskPathPreview();

  if (r.whiskAutoDownload === true) {
    get('whisk-auto-download').checked     = true;
    get('whisk-auto-dl-hint').textContent  = 'مفعّل — الصور بتتحمل تلقائياً بعد كل مشهد';
  }
  if (r.whiskIsRunning) {
    get('whisk-start-btn').style.display = 'none';
    get('whisk-stop-btn').style.display  = 'block';
  }
  whiskUpdateRetryBtn();
});

// ── Upload ──
get('whisk-upload-area').addEventListener('click', () => get('whisk-json-input').click());
get('whisk-json-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      whiskScenes = JSON.parse(ev.target.result);
      chrome.storage.local.set({ whiskScenes, whiskDoneCount: 0, whiskFailCount: 0 });
      get('whisk-upload-area').classList.add('loaded');
      get('whisk-upload-count').textContent = whiskScenes.length + ' مشهد جاهز ✓';
      get('whisk-stat-total').textContent   = whiskScenes.length;
      get('whisk-stat-done').textContent    = '0';
      get('whisk-stat-fail').textContent    = '0';
      whiskDoneCount = 0; whiskFailCount = 0;
      whiskCheckReady();
      whiskAddLog('info', `تم تحميل ${whiskScenes.length} مشهد`);
    } catch (e) { whiskAddLog('err', 'خطأ: ' + e.message); }
  };
  reader.readAsText(file, 'utf-8');
});

// ── Helpers ──
function whiskCheckReady() {
  get('whisk-start-btn').disabled = !whiskScenes.length;
  whiskUpdateRetryBtn();
}
function whiskUpdateRetryBtn() {
  get('whisk-retry-btn').disabled = !whiskScenes.some(s => s._failed);
}
function whiskBuildFolder() {
  const project = get('whisk-project').value.trim();
  return project ? `AutoCut/${project}` : 'AutoCut';
}

// ── Start ──
get('whisk-start-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/tools/whisk/*' });
  const tab  = tabs[0];
  if (!tab?.id) { whiskAddLog('err', 'افتح صفحة Whisk الأول'); return; }

  const prefix  = get('whisk-prefix').value  || 'scene_';
  const folder  = whiskBuildFolder();
  chrome.storage.local.set({ whiskPrefix: prefix, whiskProject: get('whisk-project').value.trim(), whiskStopFlag: false });

  get('whisk-start-btn').style.display  = 'none';
  get('whisk-stop-btn').style.display   = 'block';
  get('whisk-progress-wrap').style.display = 'flex';
  get('whisk-log').style.display        = 'block';

  chrome.runtime.sendMessage({ type: 'WHISK_START_QUEUE', scenes: whiskScenes, prefix, folder, tabId: tab.id });
  whiskAddLog('info', `بدأ التشغيل ✓ → Downloads/${folder}/`);
});

// ── Stop ──
get('whisk-stop-btn').addEventListener('click', () => {
  chrome.storage.local.set({ whiskStopFlag: true });
  whiskAddLog('info', '⏸ طلب إيقاف...');
  get('whisk-start-btn').style.display = 'block';
  get('whisk-stop-btn').style.display  = 'none';
});

// ── Inject Control ──
get('whisk-inject-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/tools/whisk/*' });
  const tab  = tabs[0];
  if (!tab?.id) { whiskAddLog('err', 'افتح صفحة Whisk الأول'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'WHISK_INJECT_CONTROL' });
  whiskAddLog('info', '🎯 تم تفعيل الكنترول في Whisk');
});

// ── Retry Failed ──
get('whisk-retry-btn').addEventListener('click', async () => {
  const failed = whiskScenes.filter(s => s._failed);
  if (!failed.length) return;
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/tools/whisk/*' });
  const tab  = tabs[0];
  if (!tab?.id) { whiskAddLog('err', 'افتح صفحة Whisk الأول'); return; }
  const prefix = get('whisk-prefix').value || 'scene_';
  const folder = whiskBuildFolder();
  get('whisk-start-btn').style.display = 'none';
  get('whisk-stop-btn').style.display  = 'block';
  chrome.runtime.sendMessage({ type: 'WHISK_RETRY_FAILED', scenes: failed, prefix, folder, tabId: tab.id });
  whiskAddLog('info', `↻ إعادة ${failed.length} مشاهد فاشلة`);
});

// ── Messages from background ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WHISK_LOG') {
    whiskAddLog(msg.logType, msg.msg);
  } else if (msg.type === 'WHISK_PROGRESS') {
    const pct = Math.round((msg.i / msg.total) * 100);
    get('whisk-progress-bar').style.width    = pct + '%';
    get('whisk-progress-pct').textContent    = pct + '%';
    get('whisk-progress-scene').textContent  = `Scene ${msg.scene.scene_number}: ${(msg.scene.scene_description||'').slice(0,55)}`;
    get('whisk-progress-wrap').style.display = 'flex';
  } else if (msg.type === 'WHISK_STATS') {
    whiskDoneCount = msg.done; whiskFailCount = msg.fail;
    get('whisk-stat-done').textContent = msg.done;
    get('whisk-stat-fail').textContent = msg.fail;
    whiskUpdateRetryBtn();
  } else if (msg.type === 'WHISK_DONE') {
    get('whisk-start-btn').style.display  = 'block';
    get('whisk-stop-btn').style.display   = 'none';
    get('whisk-progress-bar').style.width = '100%';
    get('whisk-progress-pct').textContent = '100%';
    get('whisk-progress-scene').textContent = '🎉 اكتمل!';
    chrome.storage.local.get(['whiskScenes'], r => {
      if (r.whiskScenes) { whiskScenes = r.whiskScenes; }
    });
    whiskUpdateRetryBtn();
  }
});

// ── Log helper ──
function whiskAddLog(type, msg) {
  const log = get('whisk-log');
  log.style.display = 'block';
  const d = document.createElement('div');
  d.className   = type;
  d.textContent = msg;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}