// ═══════════════════════════════════════════════════
//  AutoCut v2.1 — background.js
// ═══════════════════════════════════════════════════

const MAX_RETRIES = 3;
const RETRY_DELAYS = [10000, 30000, 60000];

// ── Keep-Alive ─────────────────────────────────────
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(
    () => chrome.runtime.getPlatformInfo(() => {}),
    20000,
  );
}
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ── Message Listener ───────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ✅ MANUAL_DOWNLOAD مرة واحدة بس — بتستخدم doDownload المتكاملة
  if (msg.type === "MANUAL_DOWNLOAD") {
    doDownload(msg.url, msg.filename, msg.folder)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async
  }

  if (msg.type === "EXECUTE_SELECTION") {
    if (msg.action === "download") {
      // ✅ بنجيب الـ folder مرة واحدة قبل الـ loop
      chrome.storage.local.get(["saveProject", "prefix"], async (r) => {
        const project = r.saveProject || "";
        const prefix = r.prefix || "scene_";
        const folder = project ? `AutoCut/${project}` : "AutoCut";

        // ✅ deduplication بالـ URL قبل ما نبدأ نحمّل
        const seen = new Set();
        const uniqueImages = msg.images.filter((img) => {
          // استخرج الـ base URL بدون الـ query params (GoogleAccessId etc.)
          const baseUrl = img.url.split("?")[0];
          if (seen.has(baseUrl)) return false;
          seen.add(baseUrl);
          return true;
        });

        for (const img of uniqueImages) {
          const num = String(img.scene_number || 1).padStart(3, "0");
          const desc = (img.scene_description || "")
            .replace(/,/g, " ")
            .replace(/[<>:"/\\|?*]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          const filename = desc
            ? `${prefix}${num}_${desc}.png`
            : `${prefix}${num}.png`;

          await doDownload(img.url, filename, folder);
        }
      });
    } else if (msg.action === "delete") {
      // ✅ المطابقة بالـ tileId في الـ capturedImages
      // لأن capturedImages.id = Date.now() والـ tileId مختلف
      // فبنستخدم base URL للمطابقة
      const baseUrlsToDelete = new Set(
        (msg.urls || []).map((u) => u.split("?")[0]),
      );

      chrome.storage.local.get(["capturedImages"], (r) => {
        const remaining = (r.capturedImages || []).filter((img) => {
          const base = (img.url || "").split("?")[0];
          return !baseUrlsToDelete.has(base);
        });
        chrome.storage.local.set({ capturedImages: remaining }, () => {
          chrome.runtime
            .sendMessage({ type: "IMAGE_CAPTURED", capturedImages: remaining })
            .catch(() => {});
        });
      });
    }

    sendResponse({ ok: true });
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
  if (msg.type === "DELETE_DOWNLOAD") {
    chrome.downloads.removeFile(msg.downloadId, () => {});
    sendResponse({ ok: true });
    return true;
  }
});

// ── Main Queue Runner ──────────────────────────────
async function runQueue(scenes, prefix, folder, tabId, retryFailedOnly) {
  startKeepAlive();
  const sessionStart = Date.now();
  const timings = [];
  const savePath = (folder || "AutoCut").replace(/[<>:"|?*]/g, "").trim();

  let startFrom = retryFailedOnly ? 0 : (await getStorage("doneCount")) || 0;
  const scenesToRun = retryFailedOnly
    ? scenes.filter((s) => s._failed)
    : scenes;

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
        sendLog(
          "info",
          `↻ Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay / 1000}s...`,
        );
        await sleep(delay);
      }
      const t0 = Date.now();
      ok = await processScene(
        scene,
        fname,
        tabId,
        avgTimeout,
        savePath,
        shouldDownload,
      );
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
  chrome.runtime
    .sendMessage({ type: "DONE", done: finalDone, fail: finalFail })
    .catch(() => {});

  stopKeepAlive();
  await setStorage({ isRunning: false });
}

// ── Build Filename ─────────────────────────────────
function buildFilename(prefix, scene) {
  const num = String(scene.scene_number).padStart(3, "0");
  const desc = (scene.scene_description || "")
    .replace(/,/g, " ")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  // ✅ لو desc فاضي — مفيش _ زيادة
  return desc ? `${prefix}${num}_${desc}.png` : `${prefix}${num}.png`;
}

// ── Download Helper ────────────────────────────────
function doDownload(url, filename, folder) {
  // ✅ حوّل الـ relative URL لـ absolute
  const fullUrl = url.startsWith("http")
    ? url
    : `https://labs.google.com${url}`;
  const savePath = (folder || "AutoCut").replace(/[<>:"|?*]/g, "").trim();
  const safeFile = (filename || "image.png").replace(/[\\/:*?"<>|]/g, "_");

  return new Promise((res, rej) => {
    chrome.downloads.download(
      { url: fullUrl, filename: `${savePath}/${safeFile}`, saveAs: false },
      (id) => {
        if (chrome.runtime.lastError)
          rej(new Error(chrome.runtime.lastError.message));
        else res(id);
      },
    );
  });
}

// ── Process Single Scene ───────────────────────────
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

  const dbg = {
    attach: () =>
      new Promise((res, rej) => {
        chrome.debugger.attach(debuggee, "1.3", () => {
          if (chrome.runtime.lastError)
            rej(new Error(chrome.runtime.lastError.message));
          else res();
        });
      }),
    detach: () =>
      new Promise((res) => chrome.debugger.detach(debuggee, () => res())),
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        chrome.debugger.sendCommand(debuggee, method, params, (result) => {
          if (chrome.runtime.lastError)
            rej(new Error(chrome.runtime.lastError.message));
          else res(result);
        });
      }),
  };

  try {
    // 1. Focus editor
    const prepared = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const box = document.querySelector(
          '[data-slate-editor="true"][contenteditable="true"]',
        );
        if (!box) return false;
        box.click();
        box.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      },
    });
    if (!prepared?.[0]?.result) {
      sendLog("err", "Editor not found");
      return false;
    }
    await sleep(200);

    // 2. CDP insertText
    await dbg.attach();
    debuggerAttached = true;
    await dbg.send("Input.insertText", { text: scene.main_prompt });
    await sleep(400);

    // 3. Verify
    const verified = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const box = document.querySelector(
          '[data-slate-editor="true"][contenteditable="true"]',
        );
        return box
          ? (box.innerText || box.textContent || "").trim().length > 0
          : false;
      },
    });
    if (!verified?.[0]?.result) {
      sendLog("err", "Inject failed");
      return false;
    }
    sendLog("ok", "Prompt injected");

    // 4. Click send
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

    // 5. Poll for image
    sendLog(
      "info",
      `Waiting for image (timeout: ${Math.round(timeout / 1000)}s)...`,
    );
    const imgUrl = await pollForImage(tabId, timeout);
    if (!imgUrl) {
      sendLog("err", `Image not found after ${Math.round(timeout / 1000)}s`);
      return false;
    }
    sendLog("ok", "Image found");

    // 6. Save to capturedImages
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
    chrome.runtime
      .sendMessage({ type: "IMAGE_CAPTURED", capturedImages })
      .catch(() => {});

    // 7. Auto-download
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
    sendLog("err", e.message?.slice(0, 100) || "Unknown error");
    return false;
  } finally {
    if (debuggerAttached) {
      try {
        await dbg.detach();
      } catch (_) {}
    }
  }
}

// ── Poll for new image ─────────────────────────────
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

// ── Session History ────────────────────────────────
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

// ── Smart Timeout ──────────────────────────────────
function calcSmartTimeout(timings) {
  if (!timings.length) return 90000;
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  return Math.max(45000, Math.min(120000, avg * 1.5));
}

// ── Helpers ────────────────────────────────────────
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
function getStorage(key) {
  return new Promise((res) =>
    chrome.storage.local.get([key], (r) => res(r[key])),
  );
}
function setStorage(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
