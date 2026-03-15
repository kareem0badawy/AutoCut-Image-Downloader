let scenes = [], doneCount = 0, failCount = 0, stopFlag = false;
let selectedDirHandle = null;

const get = id => document.getElementById(id);

// ── THEME ──────────────────────────────────────────
let dark = true;
chrome.storage.local.get(['dark'], r => {
  dark = r.dark !== false;
  document.body.className = dark ? '' : 'light';
  get('theme-btn').textContent = dark ? '🌙' : '☀️';
});
get('theme-btn').addEventListener('click', () => {
  dark = !dark;
  document.body.className = dark ? '' : 'light';
  get('theme-btn').textContent = dark ? '🌙' : '☀️';
  chrome.storage.local.set({ dark });
});

// ── RESTORE STATE ──────────────────────────────────
chrome.storage.local.get(['scenes','doneCount','failCount','prefix'], r => {
  if (r.scenes && r.scenes.length) {
    scenes = r.scenes;
    get('upload-area').classList.add('loaded');
    get('upload-count').textContent = scenes.length + ' مشهد جاهز ✓';
    get('stat-total').textContent = scenes.length;
    checkReady();
  }
  if (r.doneCount) { doneCount = r.doneCount; get('stat-done').textContent = doneCount; }
  if (r.failCount) { failCount = r.failCount; get('stat-fail').textContent = failCount; }
  if (r.prefix)    { get('save-prefix').value = r.prefix; }

  chrome.storage.local.get(['lastProgress'], r => {
    if (r.lastProgress) {
      const { i, total, scene, done, fail } = r.lastProgress;
      const pct = Math.round((i / total) * 100);
      get('progress-bar').style.width = pct + '%';
      get('progress-pct').textContent = pct + '%';
      get('progress-scene').textContent = 'Scene ' + scene.scene_number + ': ' + (scene.scene_description||'').slice(0,55);
      get('progress-wrap').style.display = 'flex';
    }
  });

});

// ── LOG RESTORE ────────────────────────────────────
chrome.storage.local.get(['logs'], r => {
  if (r.logs && r.logs.length) {
    get('log').style.display = 'block';
    r.logs.forEach(l => _addLogDOM(l.type, l.msg));
  }
});

// ── LISTEN FROM BACKGROUND ─────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') {
    addLog(msg.logType, msg.msg);
  } else if (msg.type === 'PROGRESS') {
    const pct = Math.round((msg.i / msg.total) * 100);
    get('progress-bar').style.width = pct + '%';
    get('progress-pct').textContent = pct + '%';
    get('progress-scene').textContent = 'Scene ' + msg.scene.scene_number + ': ' + (msg.scene.scene_description||'').slice(0,55);
    get('progress-wrap').style.display = 'flex';
  } else if (msg.type === 'STATS') {
    doneCount = msg.done;
    failCount = msg.fail;
    get('stat-done').textContent = msg.done;
    get('stat-fail').textContent = msg.fail;
  } else if (msg.type === 'DONE') {
    get('start-btn').style.display = 'block';
    get('stop-btn').style.display  = 'none';
    get('progress-bar').style.width = '100%';
    get('progress-pct').textContent = '100%';
    get('progress-scene').textContent = '🎉 اكتمل!';
  }
});

// ── JSON UPLOAD ────────────────────────────────────
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
      checkReady();
      addLog('info', 'تم تحميل ' + scenes.length + ' مشهد');
    } catch(e) { addLog('err', 'خطأ: ' + e.message); }
  };
  reader.readAsText(file, 'utf-8');
});

// ── BROWSE FOLDER ──────────────────────────────────
get('browse-btn').addEventListener('click', async () => {
  try {
    selectedDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    get('save-folder').value = selectedDirHandle.name;
    get('path-display').textContent = '📁 ' + selectedDirHandle.name + ' — جاهز ✓';
    checkReady();
    addLog('info', 'تم اختيار: ' + selectedDirHandle.name);
  } catch(e) {
    if (e.name !== 'AbortError') addLog('err', 'فشل اختيار الفولدر');
  }
});

function checkReady() {
  get('start-btn').disabled = !scenes.length;
}

// ── START ──────────────────────────────────────────
get('start-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { addLog('err', 'افتح Google Flow الأول'); return; }

  const prefix = get('save-prefix').value || 'scene_';
  chrome.storage.local.set({ prefix, stopFlag: false });

  get('start-btn').style.display = 'none';
  get('stop-btn').style.display  = 'block';
  get('progress-wrap').style.display = 'flex';
  get('log').style.display = 'block';

  // ابعت للـ background عشان يشتغل حتى لو البوب اب اتقفلت
  chrome.runtime.sendMessage({
    type: 'START_QUEUE',
    scenes,
    prefix,
    tabId: tab.id
  });

  addLog('info', 'بدأ التشغيل في الخلفية ✓ — تقدر تقفل البوب اب');
});

// ── STOP ───────────────────────────────────────────
get('stop-btn').addEventListener('click', () => {
  chrome.storage.local.set({ stopFlag: true });
  addLog('info', '⏸ طلب إيقاف...');
  get('start-btn').style.display = 'block';
  get('stop-btn').style.display  = 'none';
});

// ── LOG HELPERS ────────────────────────────────────
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
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CLEAR ALL ──────────────────────────────────────
get('clear-btn').addEventListener('click', () => {
  get('confirm-overlay').classList.add('show');
});
get('confirm-no').addEventListener('click', () => {
  get('confirm-overlay').classList.remove('show');
});
get('confirm-yes').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    scenes = []; doneCount = 0; failCount = 0;
    get('upload-area').classList.remove('loaded');
    get('upload-count').textContent = '';
    get('stat-total').textContent = '0';
    get('stat-done').textContent  = '0';
    get('stat-fail').textContent  = '0';
    get('log').innerHTML = '';
    get('log').style.display = 'none';
    get('progress-wrap').style.display = 'none';
    get('progress-bar').style.width = '0%';
    get('save-folder').value = '';
    get('path-display').textContent = 'الصور: scene_001.png, scene_002.png ...';
    get('start-btn').disabled = true;
    get('start-btn').style.display = 'block';
    get('stop-btn').style.display = 'none';
    selectedDirHandle = null;
    get('confirm-overlay').classList.remove('show');
    addLog('info', 'تم التفريغ');
  });
});
