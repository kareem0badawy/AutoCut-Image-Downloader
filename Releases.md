✂️ AutoCut v2.4 — Multi-Image Per Scene Support

🆕 New Features
- Multi-image naming: when Flow generates x2/x3/x4 images per scene,
  each image is now saved with the correct _x1/_x2/_x3/_x4 suffix
  e.g. scene_001_description_x1.png / scene_001_description_x2.png

🐛 Bug Fixes
- Fixed incorrect filenames when downloading multiple images per scene
  * DOM index is now divided by imgsPerScene to find the correct scene
  * Version number calculated as (domIndex % imgsPerScene) + 1
- Fixed _x1 suffix missing from first image of each scene
- Fixed images downloading with wrong scene name when capturedImages
  storage contained stale data from a previous queue run
- Fixed scene_NNN.jpg (no description) appearing for tiles beyond
  the scene count — caused by wrong sceneIndex calculation
- Fixed CSP violation in popup.html — removed inline onclick handler
  and moved it to popup.js as a proper event listener

⚙️ Technical Changes

content.js
- executeAction() now reads flowSettings.count from storage to get
  imgsPerScene — used to calculate sceneIndex and version per tile
- Removed dependency on captured.filename and captured.scene_description
  for filename building — always derives from DOM index + scenes JSON
- buildFilename() now accepts optional version param → appends _xN suffix
- Added console debug log per tile showing index → scene → version → filename

background.js
- buildFilename() updated to accept optional version param (matching content.js)

popup.js
- dl-selected-btn handler now uses img.filename directly from capturedImages
  instead of rebuilding the filename without version info
- Removed inline onclick from flow-toggle-wrap div (CSP fix)
- Added flow-toggle-wrap click listener in popup.js

📦 Installation
1. Download source code below
2. Open Chrome → chrome://extensions
3. Enable Developer Mode
4. Click Load unpacked → select the folder

***********************************************

## ✂️ AutoCut v1.0.8

### 🐛 Bug Fixes

**Manual download — all images were saving with the same filename**
- Flow's DOM renders each image inside nested elements sharing the same
  `data-tile-id`. This caused every image to map to `scene_001_...`
  and Chrome would append `(1)(2)(3)(4)` suffixes.
- Fixed by `getImageTile()` — a recursive resolver that always finds
  the real inner tile regardless of DOM wrapper depth.

**First image in Flow lost its title after Queue runs**
- CDP `Input.insertText` was writing to whatever element had
  browser-level focus, sometimes landing in the image title field
  instead of the prompt editor.
- Fixed by focusing the editor via CDP mouse events (trusted)
  instead of `scripting.executeScript`.

---

### ⚙️ Technical Changes

**content.js**
- `getImageTile()` — recursive inner tile resolver
- `getInnerTiles()` — stable, ordered, deduplicated tile list
- `getTileById()` — always resolves to the correct inner tile
- Single storage call in `executeAction()` instead of multiple
- Shared `buildFilename()` utility

**background.js**
- `handleManualDownload()` — dedicated clean handler
- `cdpMouseClick()` / `cdpSelectAll()` / `cdpKey()` — named CDP helpers
- `isEditorFilled()` — non-exact check, no whitespace false negatives
- `getStorageMulti()` — fetch multiple storage keys in one call
- Injection retry on failure before marking scene as failed

---

### 📦 Installation
1. Download the source code below
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode**
4. Click **Load unpacked** → select the folder