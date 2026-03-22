// ═══════════════════════════════════════════════════
//  AutoCut v2.2 — background.js
// ═══════════════════════════════════════════════════

const MAX_RETRIES = 3;
const RETRY_DELAYS = [10000, 30000, 60000]; // ms between retry attempts

// ══════════════════════════════════════════════════
//  KEEP-ALIVE  (prevents MV3 service worker from dying mid-queue)
// ══════════════════════════════════════════════════
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(
    () => chrome.runtime.getPlatformInfo(() => {}),
    20000,
  );
}

function stopKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// ══════════════════════════════════════════════════
//  MESSAGE ROUTER
// ══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    console.log('[AutoCut bg] message received:', msg.type, msg.action || '');
  if (msg.type === "MANUAL_DOWNLOAD") {
    doDownload(msg.url, msg.filename, msg.folder)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "EXECUTE_SELECTION" && msg.action === "download") {
    handleManualDownload(msg.images || []).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  if (msg.type === "START_QUEUE") {
    runQueue(msg.scenes, msg.prefix, msg.folder, msg.tabId, false);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "RETRY_FAILED") {
    runQueue(msg.scenes, msg.prefix, msg.folder, msg.tabId, true);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "WHISK_START_QUEUE") {
    runWhiskQueue(msg.scenes, msg.prefix, msg.folder, msg.tabId, false);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "WHISK_RETRY_FAILED") {
    runWhiskQueue(msg.scenes, msg.prefix, msg.folder, msg.tabId, true);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "WHISK_DOWNLOAD_BASE64") {
    const savePath = (msg.folder || 'AutoCut/Whisk').replace(/[<>:"|?*]/g, '').replace(/\\/g, '/').trim();
    const safeFile = (msg.filename || 'whisk_image.jpg').replace(/[\\/:*?"<>|]/g, '_');
    chrome.downloads.download(
      { url: msg.base64, filename: `${savePath}/${safeFile}`, saveAs: false },
      (id) => sendResponse({ ok: true, id })
    );
    return true;
  }

  if (msg.type === "DELETE_DOWNLOAD") {
    chrome.downloads.removeFile(msg.downloadId, () => {});
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ══════════════════════════════════════════════════
//  AUTO-RESET ON INSTALL / UPDATE
// ══════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.storage.local.get(['flowSettings', 'dark'], (keep) => {
      chrome.storage.local.clear(() => {
        chrome.storage.local.set({
          ...(keep.flowSettings ? { flowSettings: keep.flowSettings } : {}),
          ...(keep.dark !== undefined ? { dark: keep.dark } : {}),
        });
      });
    });
  }
});


// ══════════════════════════════════════════════════
//  MANUAL DOWNLOAD HANDLER
//  content.js already built the correct filename —
//  background just needs to call doDownload.
// ══════════════════════════════════════════════════
async function handleManualDownload(images) {
  const r = await getStorageMulti(["saveProject", "prefix"]);
  const folder = r.saveProject ? `AutoCut/${r.saveProject}` : "AutoCut";
  const prefix = r.prefix || "scene_";

  console.log('[AutoCut] handleManualDownload → folder:', folder, '| images:', images.length);
  console.log('[AutoCut] storage r:', JSON.stringify(r));

  const seen = new Set();
  for (const img of images) {
    if (seen.has(img.id)) continue;
    seen.add(img.id);

    const filename =
      img.filename ||
      buildFilename(prefix, img.scene_number || 1, img.scene_description || "");
    
    console.log('[AutoCut] downloading → filename:', filename, '| folder:', folder, '| url:', img.url.slice(0, 60));
    await doDownload(img.url, filename, folder);
  }
}

// ══════════════════════════════════════════════════
//  QUEUE RUNNER
// ══════════════════════════════════════════════════
async function runQueue(scenes, prefix, folder, tabId, retryFailedOnly) {
  startKeepAlive();

  const sessionStart = Date.now();
  const timings = [];
  const savePath = (folder || "AutoCut").replace(/[<>:"|?*]/g, "").trim();
  const scenesToRun = retryFailedOnly ? scenes.filter((s) => s._failed) : scenes;

  await setStorage({
    isRunning: true,
    stopFlag: false,
    ...(retryFailedOnly ? {} : { doneCount: 0, failCount: 0 }),
  });

  // ── تطبيق إعدادات Flow مرة واحدة في البداية ──
  const flowSettings = await getStorage("flowSettings");
  if (flowSettings?.enabled === true) {
    sendLog("info", "⚙️ تطبيق إعدادات Flow...");
    await chrome.tabs.sendMessage(tabId, { type: "APPLY_SETTINGS", settings: flowSettings }).catch(() => {});
    await sleep(1000);
    sendLog("ok", `⚙️ تم: ${flowSettings.mediaType} | ${flowSettings.orientation} | x${flowSettings.count} | ${flowSettings.model || 'default'}`);
  }

  for (let i = 0; i < scenesToRun.length; i++) {
    if (await getStorage("stopFlag")) break;

    const scene = scenesToRun[i];
    const fname = buildFilename(
      prefix,
      scene.scene_number,
      scene.scene_description,
    );

    sendLog("info", `[${i + 1}/${scenesToRun.length}] ${fname}`);
    sendProgress(i, scenesToRun.length, scene);
    await setStorage({
      lastProgress: {
        i,
        total: scenesToRun.length,
        scene,
        done: (await getStorage("doneCount")) || 0,
        fail: (await getStorage("failCount")) || 0,
      },
    });

    const timeout = calcSmartTimeout(timings);
    const shouldDl = (await getStorage("autoDownload")) !== false;

    let ok = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        sendLog(
          "info",
          `↻ Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay / 1000}s…`,
        );
        await sleep(delay);
      }
      const t0 = Date.now();
      ok = await processScene(scene, fname, tabId, timeout, savePath, shouldDl);
      if (ok) {
        timings.push(Date.now() - t0);
        if (timings.length > 20) timings.shift();
        break;
      }
    }

    let done = (await getStorage("doneCount")) || 0;
    let fail = (await getStorage("failCount")) || 0;

    if (ok) {
      done++;
      await setStorage({ doneCount: done });
      sendLog("ok", `✓ ${fname}`);
      scene._done = true;
      scene._failed = false;
    } else {
      fail++;
      await setStorage({ failCount: fail });
      sendLog("err", `✗ Failed: ${fname}`);
      scene._done = false;
      scene._failed = true;
    }

    // Persist scene status
    const allScenes = (await getStorage("scenes")) || scenes;
    const idx = allScenes.findIndex(
      (s) => s.scene_number === scene.scene_number,
    );
    if (idx !== -1) {
      allScenes[idx] = scene;
      await setStorage({ scenes: allScenes });
    }

    sendStats(done, fail);
    await setStorage({
      lastProgress: { i, total: scenesToRun.length, scene, done, fail },
    });

    // Smart cooldown — scales with imgsPerScene and failure count
    const imgsPerScene = flowSettings?.count || 1;
    const cooldown = calcCooldown(imgsPerScene, fail);
    sendLog("info", `⏱ Cooldown: ${cooldown / 1000}s (x${imgsPerScene} imgs, ${fail} fails)`);
    await sleep(cooldown);
  }

  const finalDone = (await getStorage("doneCount")) || 0;
  const finalFail = (await getStorage("failCount")) || 0;
  const duration = Math.round((Date.now() - sessionStart) / 1000);

  await saveSessionHistory(scenesToRun.length, finalDone, finalFail, duration);

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "AutoCut — اكتمل!",
    message: `✓ ${finalDone} صورة | ✗ ${finalFail} فشل | ${duration}s`,
  });

  sendLog("ok", `🎉 All done! ${finalDone} ✓  ${finalFail} ✗  (${duration}s)`);
  chrome.runtime
    .sendMessage({ type: "DONE", done: finalDone, fail: finalFail })
    .catch(() => {});

  stopKeepAlive();
  await setStorage({ isRunning: false });
}

// ══════════════════════════════════════════════════
//  PROCESS SINGLE SCENE
// ══════════════════════════════════════════════════
async function processScene(
  scene,
  fname,
  tabId,
  timeout = 90000,
  savePath = "AutoCut",
  shouldDownload = true,
) {
  let debuggerAttached = false;
  const debuggee = { tabId };

  // CDP wrapper
  const dbg = {
    attach: () =>
      new Promise((res, rej) =>
        chrome.debugger.attach(debuggee, "1.3", () =>
          chrome.runtime.lastError
            ? rej(new Error(chrome.runtime.lastError.message))
            : res(),
        ),
      ),
    detach: () =>
      new Promise((res) => chrome.debugger.detach(debuggee, () => res())),
    send: (method, params = {}) =>
      new Promise((res, rej) =>
        chrome.debugger.sendCommand(debuggee, method, params, (result) =>
          chrome.runtime.lastError
            ? rej(new Error(chrome.runtime.lastError.message))
            : res(result),
        ),
      ),
  };

  try {
    // ── Step 1: Get editor coordinates via scripting ──
    const info = await getEditorInfo(tabId);
    if (!info) {
      sendLog("err", "Editor not found");
      return false;
    }

    // // ── Step 2: Apply Flow settings FIRST — قبل أي حاجة ──
    // // لازم يحصل قبل attach الـ debugger عشان الـ dropdown مش يتعارض مع الـ CDP
    // const flowSettings = await getStorage("flowSettings");
    // if (flowSettings?.enabled === true) {
    //   await chrome.tabs.sendMessage(tabId, { type: "APPLY_SETTINGS", settings: flowSettings }).catch(() => {});
    //   await sleep(800);
    // }

    // ── Step 3: Attach CDP ──
    await dbg.attach();
    debuggerAttached = true;

    // ── Step 4: Focus editor via CDP mouse click (trusted, not scripting) ──
    await cdpMouseClick(dbg, info.x, info.y);
    await sleep(150);

    // ── Step 5: Select all + delete + insert (all via CDP so Slate.js accepts them) ──
    await cdpSelectAll(dbg);
    await sleep(60);
    await cdpKey(dbg, "Backspace", 8);
    await sleep(60);
    await dbg.send("Input.insertText", { text: scene.main_prompt || "" });
    await sleep(300);

    // ── Step 6: Verify injection ──
    let verified = await isEditorFilled(tabId);
    if (!verified) {
      // One retry with fresh focus
      await cdpMouseClick(dbg, info.x, info.y);
      await sleep(150);
      await cdpSelectAll(dbg);
      await sleep(60);
      await cdpKey(dbg, "Backspace", 8);
      await sleep(60);
      await dbg.send("Input.insertText", { text: scene.main_prompt || "" });
      await sleep(350);
      verified = await isEditorFilled(tabId);
    }
    if (!verified) {
      sendLog("err", "Inject failed");
      return false;
    }
    sendLog("ok", "Prompt injected");

    // ── Step 7: Click send button ──
    const clicked = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => {
            const i = b.querySelector("i");
            return i && i.textContent.trim() === "arrow_forward" && !b.disabled;
          },
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      },
    });
    if (!clicked?.[0]?.result) {
      sendLog("err", "Send button not found");
      return false;
    }

    // ── Step 8: Poll for new image ──
    sendLog(
      "info",
      `Waiting for image (timeout: ${Math.round(timeout / 1000)}s)…`,
    );
    const imgUrl = await pollForImage(tabId, timeout);
    if (!imgUrl) {
      sendLog("err", `Image not found after ${Math.round(timeout / 1000)}s`);
      return false;
    }
    sendLog("ok", "Image found");

    // ── Step 9: Save to capturedImages in storage ──
    const captured = (await getStorage("capturedImages")) || [];
    captured.push({
      id: Date.now(),
      url: imgUrl,
      filename: fname,
      scene_number: scene.scene_number,
      scene_description: scene.scene_description,
      downloaded: false,
      timestamp: new Date().toISOString(),
    });
    await setStorage({ capturedImages: captured });
    chrome.runtime
      .sendMessage({ type: "IMAGE_CAPTURED", capturedImages: captured })
      .catch(() => {});

    // ── Step 10: Download ──
    if (shouldDownload) {
      await doDownload(imgUrl, fname, savePath);
      sendLog("ok", `Saved: ${savePath}/${fname}`);
      const imgs = (await getStorage("capturedImages")) || [];
      const idx = imgs.findIndex((img) => img.filename === fname);
      if (idx !== -1) {
        imgs[idx].downloaded = true;
        await setStorage({ capturedImages: imgs });
      }
    } else {
      sendLog("info", `📋 Captured (auto-download OFF): ${fname}`);
    }

    return true;
  } catch (e) {
    sendLog("err", e.message?.slice(0, 150) || "Unknown error");
    return false;
  } finally {
    if (debuggerAttached) {
      try {
        await dbg.detach();
      } catch (_) {}
    }
  }
}
// ══════════════════════════════════════════════════
//  CDP HELPERS
// ══════════════════════════════════════════════════

// Returns { x, y } of the center of the Slate.js prompt editor.
async function getEditorInfo(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const ed = document.querySelector(
        '[data-slate-editor="true"][contenteditable="true"]',
      );
      if (!ed) return null;
      const r = ed.getBoundingClientRect();
      return {
        x: Math.round(r.left + Math.min(r.width / 2, 40)),
        y: Math.round(r.top + Math.min(r.height / 2, 20)),
      };
    },
  });
  return res?.[0]?.result || null;
}

// Trusted mouse click via CDP — Slate.js responds to this correctly.
async function cdpMouseClick(dbg, x, y) {
  await dbg.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  await dbg.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await dbg.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

// Ctrl+A via CDP to select all content in the focused element.
async function cdpSelectAll(dbg) {
  await dbg.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    text: "a",
    unmodifiedText: "a",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 0,
  });
}

// Generic single key press via CDP.
async function cdpKey(dbg, key, vkCode) {
  await dbg.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code: key,
    windowsVirtualKeyCode: vkCode,
    nativeVirtualKeyCode: vkCode,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: key,
    windowsVirtualKeyCode: vkCode,
    nativeVirtualKeyCode: vkCode,
  });
}

// Checks that the editor has any non-empty text (no exact match — avoids whitespace issues).
async function isEditorFilled(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const ed = document.querySelector(
        '[data-slate-editor="true"][contenteditable="true"]',
      );
      return !!ed && (ed.innerText || ed.textContent || "").trim().length > 0;
    },
  });
  return !!res?.[0]?.result;
}

// ══════════════════════════════════════════════════
//  IMAGE POLLING
// ══════════════════════════════════════════════════
async function pollForImage(tabId, timeout = 90000) {
  const SEL = 'img[src*="media.getMediaUrlRedirect"]';

  const beforeRes = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => Array.from(document.querySelectorAll(sel)).map((i) => i.src),
    args: [SEL],
  });
  const before = new Set(beforeRes?.[0]?.result || []);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await sleep(3000);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, before) => {
        for (const img of document.querySelectorAll(sel))
          if (!before.includes(img.src)) return img.src;
        return null;
      },
      args: [SEL, Array.from(before)],
    });
    const url = res?.[0]?.result;
    if (url) return url;
  }
  return null;
}

// ══════════════════════════════════════════════════
//  DOWNLOAD
// ══════════════════════════════════════════════════
function doDownload(url, filename, folder) {
  const fullUrl = url.startsWith("http")
    ? url
    : `https://labs.google.com${url}`;
  const savePath = (folder || "AutoCut").replace(/[<>:"|?*]/g, "").trim();
  const safeFile = (filename || "image.png").replace(/[\\/:*?"<>|]/g, "_");
  return new Promise((res, rej) =>
    chrome.downloads.download(
      { url: fullUrl, filename: `${savePath}/${safeFile}`, saveAs: false },
      (id) =>
        chrome.runtime.lastError
          ? rej(new Error(chrome.runtime.lastError.message))
          : res(id),
    ),
  );
}

// ══════════════════════════════════════════════════
//  FILENAME BUILDER  (shared with content.js logic)
// ══════════════════════════════════════════════════
function buildFilename(prefix, num, desc, version = null) {
  const n = String(num || 1).padStart(3, "0");
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
//  SESSION HISTORY
// ══════════════════════════════════════════════════
async function saveSessionHistory(total, done, fail, duration) {
  const history = (await getStorage("sessionHistory")) || [];
  history.unshift({
    date: new Date().toISOString(),
    total,
    done,
    fail,
    duration,
  });
  if (history.length > 20) history.splice(20);
  await setStorage({ sessionHistory: history });
  chrome.runtime.sendMessage({ type: "HISTORY_UPDATE" }).catch(() => {});
}

// ══════════════════════════════════════════════════
//  SMART COOLDOWN  (delay between scenes based on imgsPerScene + failures)
// ══════════════════════════════════════════════════
function calcCooldown(imgsPerScene, failCount) {
  // base delay per image count: x1=2s, x2=5s, x3=8s, x4=12s
  const base = [2000, 5000, 8000, 12000];
  let delay = base[Math.min((imgsPerScene || 1) - 1, 3)];
  // if there are failures in this session, add 3s per failure (max +15s)
  if (failCount > 0) delay += Math.min(failCount * 3000, 15000);
  return Math.min(delay, 30000);
}

// ══════════════════════════════════════════════════
//  SMART TIMEOUT  (adapts to session average)
// ══════════════════════════════════════════════════
function calcSmartTimeout(timings) {
  if (!timings.length) return 90000;
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  return Math.max(45000, Math.min(120000, avg * 1.5));
}

// ══════════════════════════════════════════════════
//  MESSAGING HELPERS
// ══════════════════════════════════════════════════
function sendLog(type, msg) {
  chrome.runtime
    .sendMessage({ type: "LOG", logType: type, msg })
    .catch(() => {});
}
function sendProgress(i, total, scene) {
  chrome.runtime
    .sendMessage({ type: "PROGRESS", i, total, scene })
    .catch(() => {});
}
function sendStats(done, fail) {
  chrome.runtime.sendMessage({ type: "STATS", done, fail }).catch(() => {});
}

// ══════════════════════════════════════════════════
//  STORAGE HELPERS
// ══════════════════════════════════════════════════
function getStorage(key) {
  return new Promise((res) =>
    chrome.storage.local.get([key], (r) => res(r[key])),
  );
}
function getStorageMulti(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, res));
}
function setStorage(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
// ══════════════════════════════════════════════════
//  WHISK QUEUE RUNNER
// ══════════════════════════════════════════════════
async function runWhiskQueue(scenes, prefix, folder, tabId, retryFailedOnly) {
  startKeepAlive();

  const sessionStart  = Date.now();
  const savePath      = (folder || 'AutoCut').replace(/[<>:"|?*]/g, '').trim();
  const scenesToRun   = retryFailedOnly ? scenes.filter(s => s._failed) : scenes;

  await setStorage({
    whiskIsRunning: true,
    whiskStopFlag:  false,
    ...(retryFailedOnly ? {} : { whiskDoneCount: 0, whiskFailCount: 0 }),
  });

  for (let i = 0; i < scenesToRun.length; i++) {
    if (await getStorage('whiskStopFlag')) break;

    const scene = scenesToRun[i];
    const fname = buildFilename(prefix, scene.scene_number, scene.scene_description);

    whiskSendLog('info', `[${i + 1}/${scenesToRun.length}] ${fname}`);
    whiskSendProgress(i, scenesToRun.length, scene);

    let ok = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        whiskSendLog('info', `↻ Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay / 1000}s…`);
        await sleep(delay);
      }
      ok = await processWhiskScene(scene, fname, tabId, savePath);
      if (ok) break;
    }

    let done = (await getStorage('whiskDoneCount')) || 0;
    let fail = (await getStorage('whiskFailCount')) || 0;

    if (ok) {
      done++;
      await setStorage({ whiskDoneCount: done });
      whiskSendLog('ok', `✓ ${fname}`);
      scene._done   = true;
      scene._failed = false;
    } else {
      fail++;
      await setStorage({ whiskFailCount: fail });
      whiskSendLog('err', `✗ Failed: ${fname}`);
      scene._done   = false;
      scene._failed = true;
    }

    // persist scene status
    const allScenes = (await getStorage('whiskScenes')) || scenes;
    const idx = allScenes.findIndex(s => s.scene_number === scene.scene_number);
    if (idx !== -1) { allScenes[idx] = scene; await setStorage({ whiskScenes: allScenes }); }

    whiskSendStats(done, fail);

    // cooldown بين المشاهد
    await sleep(3000);
  }

  const finalDone = (await getStorage('whiskDoneCount')) || 0;
  const finalFail = (await getStorage('whiskFailCount')) || 0;
  const duration  = Math.round((Date.now() - sessionStart) / 1000);

  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon128.png',
    title: 'AutoCut Whisk — اكتمل!',
    message: `✓ ${finalDone} صورة | ✗ ${finalFail} فشل | ${duration}s`,
  });

  whiskSendLog('ok', `🎉 Whisk done! ${finalDone} ✓  ${finalFail} ✗  (${duration}s)`);
  chrome.runtime.sendMessage({ type: 'WHISK_DONE', done: finalDone, fail: finalFail }).catch(() => {});

  stopKeepAlive();
  await setStorage({ whiskIsRunning: false });
}

// ══════════════════════════════════════════════════
//  PROCESS SINGLE WHISK SCENE
// ══════════════════════════════════════════════════
async function processWhiskScene(scene, fname, tabId, savePath) {
  try {
    // Step 1: بعت البرومبت وضغط Generate
    const sendRes = await chrome.tabs.sendMessage(tabId, {
      type:   'WHISK_SEND_PROMPT',
      prompt: scene.main_prompt || '',
    }).catch(e => ({ ok: false, error: e.message }));

    if (!sendRes?.ok) {
      whiskSendLog('err', sendRes?.error || 'Send failed');
      return false;
    }
    whiskSendLog('ok', 'Prompt sent ✓');

    // Step 2: poll للصور الجديدة
    whiskSendLog('info', 'Waiting for image…');
    const pollRes = await chrome.tabs.sendMessage(tabId, {
      type:       'WHISK_POLL_IMAGES',
      beforeSrcs: sendRes.beforeSrcs || [],
      timeout:    90000,
    }).catch(e => ({ ok: false, newSrcs: [] }));

    if (!pollRes?.newSrcs?.length) {
      whiskSendLog('err', 'Image not found after timeout');
      return false;
    }
    whiskSendLog('ok', `Image found (${pollRes.newSrcs.length} new)`);

    // Step 3: تحميل تلقائي لو مفعّل
    const shouldDl = (await getStorage('whiskAutoDownload')) === true;
    if (shouldDl) {
      // نستخدم hover+click download بتاع Whisk
      for (let vi = 0; vi < pollRes.newSrcs.length; vi++) {
        const version  = pollRes.newSrcs.length > 1 ? vi + 1 : null;
        const dlFname  = buildFilename(prefix, scene.scene_number, scene.scene_description, version);
        const dlFolder = savePath + '/Whisk';
        await chrome.tabs.sendMessage(tabId, {
          type:     'WHISK_DOWNLOAD_IMAGES_BY_SRC',
          srcs:     [pollRes.newSrcs[vi]],
          filename: dlFname,
          folder:   dlFolder,
        }).catch(() => {});
        await sleep(500);
      }
      whiskSendLog('ok', `Saved: ${fname}`);
    } else {
      whiskSendLog('info', `📋 Captured (auto-download OFF): ${fname}`);
    }

    return true;
  } catch (e) {
    whiskSendLog('err', e.message?.slice(0, 150) || 'Unknown error');
    return false;
  }
}

// ══════════════════════════════════════════════════
//  WHISK MESSAGING HELPERS
// ══════════════════════════════════════════════════
function whiskSendLog(type, msg) {
  chrome.runtime.sendMessage({ type: 'WHISK_LOG', logType: type, msg }).catch(() => {});
}
function whiskSendProgress(i, total, scene) {
  chrome.runtime.sendMessage({ type: 'WHISK_PROGRESS', i, total, scene }).catch(() => {});
}
function whiskSendStats(done, fail) {
  chrome.runtime.sendMessage({ type: 'WHISK_STATS', done, fail }).catch(() => {});
}