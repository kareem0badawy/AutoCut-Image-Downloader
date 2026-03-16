// ═══════════════════════════════════════════════════
//  AutoCut v2.1 — background.js (fixed v2)
// ═══════════════════════════════════════════════════

const MAX_RETRIES = 3;
const RETRY_DELAYS = [10000, 30000, 60000];

let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MANUAL_DOWNLOAD") {
    doDownload(msg.url, msg.filename, msg.folder)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "EXECUTE_SELECTION") {
    if (msg.action === "download") {
      chrome.storage.local.get(["saveProject", "prefix", "scenes"], async (r) => {
        const project = r.saveProject || "";
        const prefix = r.prefix || "scene_";
        const folder = project ? `AutoCut/${project}` : "AutoCut";
        const allScenes = r.scenes || [];

        const seen = new Set();
        for (const img of (msg.images || [])) {
          if (seen.has(img.id)) continue;
          seen.add(img.id);

          let filename;
          if (img.filename) {
            filename = img.filename;
          } else {
            let targetScene = allScenes.find((s) => s.scene_number === img.scene_number);
            if (!targetScene && img.scene_description) {
              targetScene = allScenes.find((s) =>
                (s.scene_description || "").toLowerCase().includes(
                  img.scene_description.toLowerCase().slice(0, 20),
                ),
              );
            }
            const finalScene = targetScene || {
              scene_number: img.scene_number || 1,
              scene_description: img.scene_description || "",
            };
            const num = String(finalScene.scene_number).padStart(3, "0");
            const desc = (finalScene.scene_description || "")
              .replace(/,/g, " ")
              .replace(/[<>:"/\\|?*]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80);
            filename = desc ? `${prefix}${num}_${desc}.png` : `${prefix}${num}.png`;
          }

          await doDownload(img.url, filename, folder);
        }
        sendResponse({ ok: true });
      });
      return true;
    }
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
  if (msg.type === "DELETE_DOWNLOAD") {
    chrome.downloads.removeFile(msg.downloadId, () => {});
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function runQueue(scenes, prefix, folder, tabId, retryFailedOnly) {
  startKeepAlive();
  const sessionStart = Date.now();
  const timings = [];
  const savePath = (folder || "AutoCut").replace(/[<>:"|?*]/g, "").trim();

  const startFrom = retryFailedOnly ? 0 : (await getStorage("doneCount")) || 0;
  const scenesToRun = retryFailedOnly ? scenes.filter((s) => s._failed) : scenes;

  await setStorage({
    isRunning: true,
    stopFlag: false,
    ...(retryFailedOnly ? {} : { doneCount: startFrom, failCount: 0 }),
  });

  for (let i = 0; i < scenesToRun.length; i++) {
    const stopped = await getStorage("stopFlag");
    if (stopped) break;

    const scene = scenesToRun[i];
    const fname = buildFilename(prefix, scene);

    sendLog("info", `[${i + 1}/${scenesToRun.length}] ${fname}`);
    sendProgress(i, scenesToRun.length, scene);

    const avgTimeout = calcSmartTimeout(timings);

    await setStorage({
      lastProgress: {
        i,
        total: scenesToRun.length,
        scene,
        done: (await getStorage("doneCount")) || 0,
        fail: (await getStorage("failCount")) || 0,
      },
    });

    const autoDownload = await getStorage("autoDownload");
    const shouldDownload = autoDownload !== false;

    let ok = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        sendLog("info", `↻ Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay / 1000}s...`);
        await sleep(delay);
      }
      const t0 = Date.now();
      ok = await processScene(scene, fname, tabId, avgTimeout, savePath, shouldDownload);
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
      scene._failed = true;
      scene._done = false;
    }

    const allScenes = (await getStorage("scenes")) || scenes;
    const idx = allScenes.findIndex((s) => s.scene_number === scene.scene_number);
    if (idx !== -1) {
      allScenes[idx] = scene;
      await setStorage({ scenes: allScenes });
    }

    sendStats(done, fail);
    await setStorage({ lastProgress: { i, total: scenesToRun.length, scene, done, fail } });
    await sleep(2000);
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
  chrome.runtime.sendMessage({ type: "DONE", done: finalDone, fail: finalFail }).catch(() => {});

  stopKeepAlive();
  await setStorage({ isRunning: false });
}

function buildFilename(prefix, scene) {
  const num = String(scene.scene_number).padStart(3, "0");
  const desc = (scene.scene_description || "")
    .replace(/,/g, " ")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return desc ? `${prefix}${num}_${desc}.png` : `${prefix}${num}.png`;
}

function doDownload(url, filename, folder) {
  const fullUrl = url.startsWith("http") ? url : `https://labs.google.com${url}`;
  const savePath = (folder || "AutoCut").replace(/[<>:"|?*]/g, "").trim();
  const safeFile = (filename || "image.png").replace(/[\\/:*?"<>|]/g, "_");

  return new Promise((res, rej) => {
    chrome.downloads.download({ url: fullUrl, filename: `${savePath}/${safeFile}`, saveAs: false }, (id) => {
      if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
      else res(id);
    });
  });
}

async function processScene(scene, fname, tabId, timeout = 90000, savePath = "AutoCut", shouldDownload = true) {
  let debuggerAttached = false;
  const debuggee = { tabId };

  const dbg = {
    attach: () => new Promise((res, rej) => {
      chrome.debugger.attach(debuggee, "1.3", () => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res();
      });
    }),
    detach: () => new Promise((res) => chrome.debugger.detach(debuggee, () => res())),
    send: (method, params = {}) => new Promise((res, rej) => {
      chrome.debugger.sendCommand(debuggee, method, params, (result) => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(result);
      });
    }),
  };

  try {
    const info = await getPromptEditorInfo(tabId);
    if (!info) {
      sendLog("err", "Editor not found");
      return false;
    }

    await dbg.attach();
    debuggerAttached = true;

    await focusPromptEditorViaCDP(dbg, info);
    await sleep(120);
    await replaceEditorTextViaCDP(dbg, scene.main_prompt || "");
    await sleep(250);

    let verified = await isPromptEditorFilled(tabId, scene.main_prompt || "");
    if (!verified) {
      await focusPromptEditorViaCDP(dbg, info);
      await sleep(120);
      await replaceEditorTextViaCDP(dbg, scene.main_prompt || "");
      await sleep(300);
      verified = await isPromptEditorFilled(tabId, scene.main_prompt || "");
    }

    if (!verified) {
      sendLog("err", "Inject failed");
      return false;
    }
    sendLog("ok", "Prompt injected");

    const clicked = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => {
          const i = b.querySelector("i");
          return i && i.textContent.trim() === "arrow_forward" && !b.disabled;
        });
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

    sendLog("info", `Waiting for image (timeout: ${Math.round(timeout / 1000)}s)...`);
    const imgUrl = await pollForImage(tabId, timeout);
    if (!imgUrl) {
      sendLog("err", `Image not found after ${Math.round(timeout / 1000)}s`);
      return false;
    }
    sendLog("ok", "Image found");

    const capturedImages = (await getStorage("capturedImages")) || [];
    capturedImages.push({
      id: Date.now(),
      url: imgUrl,
      filename: fname,
      scene_number: scene.scene_number,
      scene_description: scene.scene_description,
      downloaded: false,
      timestamp: new Date().toISOString(),
    });
    await setStorage({ capturedImages });
    chrome.runtime.sendMessage({ type: "IMAGE_CAPTURED", capturedImages }).catch(() => {});

    if (shouldDownload) {
      await doDownload(imgUrl, fname, savePath);
      sendLog("ok", `Saved: ${savePath}/${fname}`);
      const imgs = (await getStorage("capturedImages")) || [];
      const imgIdx = imgs.findIndex((img) => img.filename === fname);
      if (imgIdx !== -1) {
        imgs[imgIdx].downloaded = true;
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
      try { await dbg.detach(); } catch (_) {}
    }
  }
}

async function getPromptEditorInfo(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const editor = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
      if (!editor) return null;
      const rect = editor.getBoundingClientRect();
      return {
        x: Math.round(rect.left + Math.min(rect.width / 2, 40)),
        y: Math.round(rect.top + Math.min(rect.height / 2, 20)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    },
  });
  return res?.[0]?.result || null;
}

async function focusPromptEditorViaCDP(dbg, info) {
  await dbg.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: info.x,
    y: info.y,
    button: "none",
    buttons: 0,
  });
  await dbg.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: info.x,
    y: info.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await dbg.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: info.x,
    y: info.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function dispatchCtrlA(dbg) {
  await dbg.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    code: "ControlLeft",
    key: "Control",
    modifiers: 2,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    code: "KeyA",
    key: "a",
    text: "a",
    unmodifiedText: "a",
    modifiers: 2,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    code: "KeyA",
    key: "a",
    modifiers: 2,
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    code: "ControlLeft",
    key: "Control",
    modifiers: 0,
  });
}

async function dispatchBackspace(dbg) {
  await dbg.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    code: "Backspace",
    key: "Backspace",
  });
  await dbg.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    code: "Backspace",
    key: "Backspace",
  });
}

async function replaceEditorTextViaCDP(dbg, text) {
  await dispatchCtrlA(dbg);
  await sleep(60);
  await dispatchBackspace(dbg);
  await sleep(60);
  await dbg.send("Input.insertText", { text });
}

async function isPromptEditorFilled(tabId, expectedText = "") {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expected) => {
      const editor = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
      if (!editor) return false;
      const text = (editor.innerText || editor.textContent || "").trim();
      if (!text) return false;
      if (!expected) return true;
      return text === expected.trim();
    },
    args: [expectedText],
  });
  return !!res?.[0]?.result;
}

async function pollForImage(tabId, timeout = 90000) {
  const selector = 'img[src*="media.getMediaUrlRedirect"]';
  const beforeRes = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => Array.from(document.querySelectorAll(sel)).map((i) => i.src),
    args: [selector],
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
      args: [selector, Array.from(beforeUrls)],
    });
    const url = res?.[0]?.result;
    if (url) return url;
  }
  return null;
}

async function saveSessionHistory(total, done, fail, duration) {
  const history = (await getStorage("sessionHistory")) || [];
  history.unshift({ date: new Date().toISOString(), total, done, fail, duration });
  if (history.length > 20) history.splice(20);
  await setStorage({ sessionHistory: history });
  chrome.runtime.sendMessage({ type: "HISTORY_UPDATE" }).catch(() => {});
}

function calcSmartTimeout(timings) {
  if (!timings.length) return 90000;
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  return Math.max(45000, Math.min(120000, avg * 1.5));
}

function sendLog(type, msg) {
  chrome.runtime.sendMessage({ type: "LOG", logType: type, msg }).catch(() => {});
}
function sendProgress(i, total, scene) {
  chrome.runtime.sendMessage({ type: "PROGRESS", i, total, scene }).catch(() => {});
}
function sendStats(done, fail) {
  chrome.runtime.sendMessage({ type: "STATS", done, fail }).catch(() => {});
}
function getStorage(key) {
  return new Promise((res) => chrome.storage.local.get([key], (r) => res(r[key])));
}
function setStorage(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
