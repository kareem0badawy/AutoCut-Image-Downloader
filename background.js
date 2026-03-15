// ═══════════════════════════════════════════════════
//  AutoCut v2 — background.js (Service Worker)
// ═══════════════════════════════════════════════════

const MAX_RETRIES = 3;
const RETRY_DELAYS = [10000, 30000, 60000];

// ── Keep-Alive: يمنع الـ service worker من الموت ──
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ── Message Listener ──────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_QUEUE') {
    runQueue(msg.scenes, msg.prefix, msg.tabId, false);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'RETRY_FAILED') {
    runQueue(msg.scenes, msg.prefix, msg.tabId, true);
    sendResponse({ ok: true });
    return true;
  }
});

// ── Main Queue Runner ─────────────────────────────
async function runQueue(scenes, prefix, tabId, retryFailedOnly) {
  startKeepAlive();

  const sessionStart = Date.now();
  const timings = [];

  let startFrom = 0;
  if (!retryFailedOnly) {
    startFrom = await getStorage('doneCount') || 0;
  }

  const scenesToRun = retryFailedOnly
    ? scenes.filter(s => s._failed)
    : scenes;

  await setStorage({
    isRunning: true,
    stopFlag: false,
    ...(retryFailedOnly ? {} : { doneCount: startFrom, failCount: 0 })
  });

  for (let i = 0; i < scenesToRun.length; i++) {
    const stopped = await getStorage('stopFlag');
    if (stopped) break;

    const scene = scenesToRun[i];
    const num = String(scene.scene_number).padStart(3, '0');
    const fname = prefix + num + '.png';

    sendLog('info', `[${i + 1}/${scenesToRun.length}] ${fname}`);
    sendProgress(i, scenesToRun.length, scene);

    const avgTimeout = calcSmartTimeout(timings);

    await setStorage({
      lastProgress: {
        i, total: scenesToRun.length, scene,
        done: await getStorage('doneCount') || 0,
        fail: await getStorage('failCount') || 0
      }
    });

    // ── Retry Loop ────────────────────────────────
    let ok = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        sendLog('info', `↻ Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay / 1000}s...`);
        await sleep(delay);
      }
      const t0 = Date.now();
      ok = await processScene(scene, fname, tabId, avgTimeout);
      if (ok) {
        timings.push(Date.now() - t0);
        if (timings.length > 20) timings.shift();
        break;
      }
    }

    let done = await getStorage('doneCount') || 0;
    let fail = await getStorage('failCount') || 0;

    if (ok) {
      done++;
      await setStorage({ doneCount: done });
      sendLog('ok', `✓ Saved: ${fname}`);
      // Mark scene as done
      scene._done = true;
      scene._failed = false;
    } else {
      fail++;
      await setStorage({ failCount: fail });
      sendLog('err', `✗ Failed after ${MAX_RETRIES} retries: ${fname}`);
      scene._failed = true;
      scene._done = false;
    }

    // Update scene list with statuses
    const allScenes = await getStorage('scenes') || scenes;
    const idx = allScenes.findIndex(s => s.scene_number === scene.scene_number);
    if (idx !== -1) {
      allScenes[idx] = scene;
      await setStorage({ scenes: allScenes });
    }

    sendStats(done, fail);
    await setStorage({
      lastProgress: { i, total: scenesToRun.length, scene, done, fail }
    });
    await sleep(2000);
  }

  // ── Session complete ──────────────────────────
  const finalDone = await getStorage('doneCount') || 0;
  const finalFail = await getStorage('failCount') || 0;
  const duration = Math.round((Date.now() - sessionStart) / 1000);

  // Save session to history
  await saveSessionHistory(scenesToRun.length, finalDone, finalFail, duration);

  // Desktop notification
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'AutoCut — اكتمل!',
    message: `✓ ${finalDone} صورة تمت | ✗ ${finalFail} فشل | ${duration}s`
  });

  sendLog('ok', `🎉 All done! ${finalDone} ✓  ${finalFail} ✗  (${duration}s)`);
  chrome.runtime.sendMessage({ type: 'DONE', done: finalDone, fail: finalFail }).catch(() => {});

  stopKeepAlive();
  await setStorage({ isRunning: false });
}

// ── Smart Timeout Calculator ──────────────────────
function calcSmartTimeout(timings) {
  if (!timings.length) return 90000;
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  return Math.max(45000, Math.min(120000, avg * 1.5));
}

// ── Process Single Scene ──────────────────────────
async function processScene(scene, fname, tabId, timeout = 90000) {
  let debuggerAttached = false;
  const debuggee = { tabId };

  const dbg = {
    attach: () => new Promise((res, rej) => {
      chrome.debugger.attach(debuggee, '1.3', () => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res();
      });
    }),
    detach: () => new Promise(res => {
      chrome.debugger.detach(debuggee, () => res());
    }),
    send: (method, params = {}) => new Promise((res, rej) => {
      chrome.debugger.sendCommand(debuggee, method, params, result => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(result);
      });
    })
  };

  try {
    // 1. Focus editor
    const prepared = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const box = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
        if (!box) return false;
        box.click(); box.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges(); sel.addRange(range);
        return true;
      }
    });
    if (!prepared?.[0]?.result) { sendLog('err', 'Editor not found'); return false; }
    await sleep(200);

    // 2. CDP insertText
    await dbg.attach();
    debuggerAttached = true;
    await dbg.send('Input.insertText', { text: scene.main_prompt });
    await sleep(400);

    // 3. Verify
    const verified = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const box = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
        return box ? (box.innerText || box.textContent || '').trim().length > 0 : false;
      }
    });
    if (!verified?.[0]?.result) { sendLog('err', 'Inject failed'); return false; }
    sendLog('ok', 'Prompt injected');

    // 4. Click send
    const clicked = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const i = b.querySelector('i');
          return i && i.textContent.trim() === 'arrow_forward' && !b.disabled;
        });
        if (btn) { btn.click(); return true; }
        return false;
      }
    });
    if (!clicked?.[0]?.result) { sendLog('err', 'Send button not found'); return false; }

    // 5. Poll for image
    sendLog('info', `Waiting for image (timeout: ${Math.round(timeout / 1000)}s)...`);
    const imgUrl = await pollForImage(tabId, timeout);
    if (!imgUrl) { sendLog('err', `Image not found after ${Math.round(timeout / 1000)}s`); return false; }
    sendLog('ok', 'Image found');

    // 6. Download
    const dlFilename = 'AutoCut/' + fname;
    await new Promise((res, rej) => {
      chrome.downloads.download({ url: imgUrl, filename: dlFilename, saveAs: false }, id => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(id);
      });
    });

    sendLog('ok', 'Saved: ' + dlFilename);
    return true;

  } catch (e) {
    sendLog('err', e.message?.slice(0, 100) || 'Unknown error');
    return false;
  } finally {
    if (debuggerAttached) { try { await dbg.detach(); } catch (_) {} }
  }
}

// ── Poll for new image ────────────────────────────
async function pollForImage(tabId, timeout = 90000) {
  const selector = 'img[src*="media.getMediaUrlRedirect"]';
  const beforeRes = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => Array.from(document.querySelectorAll(sel)).map(i => i.src),
    args: [selector]
  });
  const beforeUrls = new Set(beforeRes?.[0]?.result || []);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await sleep(3000);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, before) => {
        for (const img of document.querySelectorAll(sel)) {
          if (!before.includes(img.src)) return img.src;
        }
        return null;
      },
      args: [selector, Array.from(beforeUrls)]
    });
    const url = res?.[0]?.result;
    if (url) return url;
  }
  return null;
}

// ── Session History ───────────────────────────────
async function saveSessionHistory(total, done, fail, duration) {
  const history = await getStorage('sessionHistory') || [];
  history.unshift({
    date: new Date().toISOString(),
    total, done, fail, duration
  });
  if (history.length > 20) history.splice(20);
  await setStorage({ sessionHistory: history });
  chrome.runtime.sendMessage({ type: 'HISTORY_UPDATE' }).catch(() => {});
}

// ── Helpers ───────────────────────────────────────
function sendLog(type, msg) {
  chrome.runtime.sendMessage({ type: 'LOG', logType: type, msg }).catch(() => {});
}
function sendProgress(i, total, scene) {
  chrome.runtime.sendMessage({ type: 'PROGRESS', i, total, scene }).catch(() => {});
}
function sendStats(done, fail) {
  chrome.runtime.sendMessage({ type: 'STATS', done, fail }).catch(() => {});
}
function getStorage(key) {
  return new Promise(res => chrome.storage.local.get([key], r => res(r[key])));
}
function setStorage(obj) {
  return new Promise(res => chrome.storage.local.set(obj, res));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
