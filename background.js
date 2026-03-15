chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_QUEUE') {
    runQueue(msg.scenes, msg.prefix, msg.tabId);
    sendResponse({ ok: true });
  }
  return true;
});

async function runQueue(scenes, prefix, tabId) {
  const startFrom = await getStorage('doneCount') || 0;

  for (let i = startFrom; i < scenes.length; i++) {
    const stopped = await getStorage('stopFlag');
    if (stopped) break;

    const scene = scenes[i];
    const num   = String(scene.scene_number).padStart(3, '0');
    const fname = prefix + num + '.png';

    sendLog('info', '[' + (i+1) + '/' + scenes.length + '] ' + fname);
    sendProgress(i, scenes.length, scene);

    // حفظ البروجرس في storage عشان يرجع لو البوب اب اتفتحت
    await setStorage({
      lastProgress: {
        i, total: scenes.length, scene,
        done: await getStorage('doneCount') || 0,
        fail: await getStorage('failCount') || 0
      }
    });

    const ok = await processScene(scene, fname, tabId);

    let done = await getStorage('doneCount') || 0;
    let fail = await getStorage('failCount') || 0;

    if (ok) {
      done++;
      await setStorage({ doneCount: done });
      sendLog('ok', 'Done: ' + fname);
    } else {
      fail++;
      await setStorage({ failCount: fail });
      sendLog('err', 'Failed: ' + fname);
    }

    sendStats(done, fail);
    await setStorage({ lastProgress: { i, total: scenes.length, scene, done, fail } });
    await sleep(2000);
  }

  sendLog('ok', 'All done!');
  chrome.runtime.sendMessage({ type: 'DONE' }).catch(() => {});
}

async function processScene(scene, fname, tabId) {
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
    // 1. Focus وحدد كل المحتوى
    const prepared = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const box = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
        if (!box) return false;
        box.click();
        box.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
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

    // 3. تحقق
    const verified = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const box = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
        return box ? (box.innerText || box.textContent || '').trim().length > 0 : false;
      }
    });
    if (!verified?.[0]?.result) { sendLog('err', 'Inject failed'); return false; }
    sendLog('ok', 'Prompt injected');

    // 4. ضغط زرار الإرسال
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

    // 5. Polling لحد ما الصورة الجديدة تظهر
    sendLog('info', 'Waiting for image...');
    const imgUrl = await pollForImage(tabId, 90000);
    if (!imgUrl) { sendLog('err', 'Image not found after 90s'); return false; }
    sendLog('ok', 'Image found: ' + imgUrl.slice(0, 60));

    // 6. تنزيل الصورة
    const dlFilename = 'AutoCut/' + fname;
    await new Promise((res, rej) => {
      chrome.downloads.download({
        url: imgUrl,
        filename: dlFilename,
        saveAs: false
      }, id => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(id);
      });
    });

    sendLog('ok', 'Saved: ' + dlFilename);
    return true;

  } catch(e) {
    sendLog('err', e.message?.slice(0, 100) || 'Unknown error');
    return false;
  } finally {
    if (debuggerAttached) {
      try { await dbg.detach(); } catch(_) {}
    }
  }
}

async function pollForImage(tabId, timeout = 90000) {
  // الـ selector الصح لـ Google Flow
  const selector = 'img[src*="media.getMediaUrlRedirect"]';

  // احفظ الـ URLs الموجودة قبل الإرسال
  const beforeRes = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const imgs = document.querySelectorAll(sel);
      return Array.from(imgs).map(i => i.src);
    },
    args: [selector]
  });
  const beforeUrls = new Set(beforeRes?.[0]?.result || []);

  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(3000);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, before) => {
        const imgs = document.querySelectorAll(sel);
        for (const img of imgs) {
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
