# ✂️ AutoCut Image Downloader

Chrome Extension to automatically generate and download images from **Google Flow Labs** using a JSON prompts file.

---

## 📋 Features

### v1.0 — Core Features
- Upload a `prompts.json` file with all scene prompts
- Auto-inject prompts into Google Flow editor using **Chrome DevTools Protocol (CDP)**
- Auto-click the generate button
- Poll for the generated image automatically
- Download images in order with custom naming (`scene_001.png`, `scene_002.png` ...)
- Runs in the **background** — works even if the popup is closed
- Progress, stats, and logs are saved and restored when popup reopens
- Dark mode / Light mode toggle
- Stop button to pause at any time
- Clear all button with confirmation dialog

### v2.0 — New Features
- **Keep-Alive** — Service Worker ping every 20s, prevents MV3 worker from dying mid-queue
- **Smart Retry** — 3 automatic retries per scene with backoff delays (10s → 30s → 60s)
- **Smart Timeout** — dynamically calculates timeout based on average generation time per session
- **Retry Failed Only** — re-run only failed scenes without restarting the whole queue
- **Skip Scene** — skip any individual scene from the Queue tab before or during a run
- **Scene Status Badges** — live badges per scene: ✓ Done / ✗ Failed / ⚡ Running / ⏳ Pending / ⏭ Skipped
- **Session History** — full log of past sessions with timestamps, total/done/fail counts, and duration
- **Desktop Notifications** — system notification on queue completion
- **Export Report** — download `report.json` with per-scene status and session history
- **Tabs UI** — Main / Queue / History tabs with clean Tailwind-inspired design

---

## 🗂️ File Structure

```
AutoCut/
├── manifest.json       # Extension config and permissions
├── version.json        # Current version number (loaded dynamically)
├── popup.html          # Extension UI
├── popup.js            # UI logic, sends tasks to background
├── background.js       # Service worker — runs the full automation loop
├── content.js          # Injected into Google Flow page
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 📦 `prompts.json` Format

```json
[
  {
    "scene_number": 1,
    "scene_description": "A German banker in 1923 sitting at a small table",
    "main_prompt": "STYLE: In the style of a Norman Rockwell vintage illustration...",
    "label_text": "ECONOMY",
    "secondary_labels": ["HISTORY"],
    "negative_prompt": "pure black background, overly dark scene..."
  },
  {
    "scene_number": 2,
    "scene_description": "...",
    "main_prompt": "...",
    "label_text": "...",
    "secondary_labels": [],
    "negative_prompt": "..."
  }
]
```

---

## 🚀 How to Install

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the folder: `J:\Coding\Extensions\AutoCut`

---

## 🎮 How to Use

1. Open Google Flow → [https://labs.google/fx/ar/tools/flow/project/](https://labs.google/fx/ar/tools/flow/project/)
2. Click the AutoCut extension icon
3. Upload your `prompts.json` file
4. Set the filename prefix (default: `scene_`)
5. Click **▶ Start**
6. Images will be saved to `Downloads/AutoCut/`

> ✅ You can close the popup — the background keeps running!

---

## ⚙️ How It Works

### Prompt Injection
Uses **Chrome DevTools Protocol (CDP)** — `Input.insertText` method.

This is the only reliable way to inject text into a Slate.js editor because:

| Method | Result |
|---|---|
| `execCommand` | crashes React DOM |
| `ClipboardEvent` | not trusted by Slate |
| `InputEvent` | updates DOM but not Slate internal state |
| **CDP `Input.insertText`** | ✅ browser-level trusted input |

### Image Detection
Polls every **3 seconds** for new images matching:
```
img[src*="media.getMediaUrlRedirect"]
```
Compares against images that existed before generation started.
Dynamic timeout based on session average (min 45s, max 120s).

### Background Processing
Uses a **Manifest V3 Service Worker** (`background.js`) so the loop continues even when the popup is closed. Progress is stored in `chrome.storage.local` and restored when popup reopens.

A **Keep-Alive** interval pings `chrome.runtime.getPlatformInfo()` every 20 seconds to prevent the service worker from being terminated during long queues.

### Smart Retry
Each scene is attempted up to **3 times** before being marked as failed:
- Attempt 1: immediate
- Attempt 2: wait 10s
- Attempt 3: wait 30s
- Attempt 4: wait 60s — then mark as ✗ Failed

---

## 🔑 Permissions Used

| Permission | Why |
|---|---|
| `scripting` | Inject code into Google Flow page |
| `debugger` | CDP `Input.insertText` for trusted text injection |
| `downloads` | Save images to Downloads folder |
| `storage` | Save progress, logs, scenes between sessions |
| `activeTab` | Access the current Google Flow tab |
| `tabs` | Query the active tab ID |
| `notifications` | Desktop notification on queue completion |

---

## ⚠️ Known Limitations

- Must keep Google Flow tab open and active during generation
- Generation time varies — polling waits dynamically per session average
- Images saved to `Downloads/AutoCut/` (Chrome downloads folder)
- CDP debugger shows a banner **"Chrome is being debugged"** — this is normal

---

## 🛑 How to Stop

Click **⏹ Stop** button in the popup.

OR open `chrome://extensions` → AutoCut → click service worker → in console run:
```javascript
chrome.storage.local.set({ stopFlag: true })
```

---

## 🗑️ How to Clear All Data

Click the **🗑️** button in the top right of the popup → confirm.

This clears: scenes, progress, stats, logs.

> ⚠️ Session history is stored separately and survives a Clear All. Use the **History tab → مسح السجل** to clear it.

---

## 🔧 Troubleshooting

| Problem | Solution |
|---|---|
| "Editor not found" | Refresh Google Flow page and try again |
| "Send button not found" | Make sure you're on the project page, not the home page |
| "Image not found" | Scene will auto-retry up to 3 times |
| Popup data disappears | Data is in storage — reopen popup to restore |
| CDP debugger banner | Normal behavior — ignore it |
| Service worker stops mid-queue | Fixed in v2.0 with Keep-Alive mechanism |

---

## 📁 Output

Images are saved as:

```
Downloads/
└── AutoCut/
    ├── scene_001.png
    ├── scene_002.png
    ├── scene_003.png
    └── ...
```

Named and ordered to match your video editing timeline.

A `report.json` can be exported from the popup containing:
```json
{
  "generated_at": "2026-03-15T...",
  "summary": { "total": 25, "done": 23, "failed": 2 },
  "scenes": [...],
  "failed_scenes": [4, 17],
  "session_history": [...]
}
```

---

## 📜 Changelog

### v2.0
- Added Keep-Alive for MV3 service worker
- Smart Retry (3 attempts with backoff)
- Smart Timeout (adaptive per session)
- Retry Failed Only button
- Skip Scene per item
- Scene Status Badges (live)
- Session History tab
- Desktop Notifications
- Export Report (report.json)
- Tabs UI: Main / Queue / History
- Version loaded dynamically from `version.json`

### v1.0
- Initial release
- Core CDP injection + polling + download loop
- Background service worker with storage persistence
- Dark/Light mode
- Stop / Clear All
