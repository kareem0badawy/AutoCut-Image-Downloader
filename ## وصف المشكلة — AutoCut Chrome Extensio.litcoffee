## وصف المشكلة — AutoCut Chrome Extension

---

### المشكلة 1: Manual Selection — كل الصور بتنزل بنفس الاسم

**السياق:**
Chrome Extension بتشتغل على موقع `labs.google/fx/tools/flow`. الـ extension عندها وضعين:
- **Queue mode** (تلقائي) — يشتغل صح، كل صورة بتاخد اسمها الصح
- **Manual selection** (floating bar) — كل الصور بتنزل بنفس اسم أول صورة

**الـ DOM الفعلي للموقع:**

كل صورة في الموقع عندها **nested structure** — نفس الـ `data-tile-id` بيتكرر مرتين:

```html
<!-- outer tile -->
<div data-tile-id="fe_id_abc123" data-ac-listened="1" data-ac-index="1">
  <!-- inner tile — نفس الـ ID -->
  <div data-tile-id="fe_id_abc123" data-ac-listened="1" data-ac-index="2">
    <img alt="صورة تم إنشاؤها" src="/fx/api/trpc/media.getMediaUrlRedirect?...">
  </div>
</div>
```

**سبب المشكلة:**

`querySelectorAll('[data-tile-id]')` بترجع **10 عناصر بدل 5** (كل صورة = outer + inner).

في `executeAction()` في `content.js`:
```js
const allTilesInOrder = Array.from(
  document.querySelectorAll('[data-testid="virtuoso-item-list"] [data-tile-id]')
);
// ...
const domIndex = allTilesInOrder.indexOf(tile); // بيرجع index خاطئ
const matchedScene = allScenes[domIndex];        // دايماً allScenes[0] أو خاطئ
```

لأن الـ `tile` الـ clicked هو الـ inner (index 1, 3, 5, 7, 9 في القائمة)، الـ `indexOf` بيرجع أرقام فردية فيبقى الـ `allScenes[1]`, `allScenes[3]`... بدل `allScenes[0]`, `allScenes[1]`...

والأخطر: لو `allScenes` فارضة (مفيش Queue run قبل كده)، كل الصور بتاخد `scene_number = 1` وكل الأسماء بتبقى `scene_001_...` فـ Chrome يضيف `(1)(2)(3)(4)` تلقائياً.

**النتيجة المرصودة:**
```
scene_001_Friedrich Hecker... (4).jpg
scene_001_Friedrich Hecker... (3).jpg
scene_001_Friedrich Hecker... (2).jpg
scene_001_Friedrich Hecker... (1).jpg
scene_001_Friedrich Hecker....jpg
```

---

### المشكلة 2: أول صورة في Flow بتبقى بدون عنوان بعد كل Queue run

**السياق:**
الـ extension بتستخدم Chrome DevTools Protocol (CDP) لحقن الـ prompt في Slate.js editor في الموقع.

**الـ flow الحالي في `processScene()` في `background.js`:**
1. `chrome.scripting.executeScript` — يعمل `box.click()` + `box.focus()` + `selectNodeContents`
2. `dbg.send("Input.insertText", { text: prompt })`

**سبب المشكلة:**

الموقع عنده **عنصرين** قابلين للـ focus على نفس الصفحة:
- **Prompt editor** — `[data-slate-editor="true"][contenteditable="true"]`
- **Image title/name field** — input تاني في الـ UI

لما `scripting.executeScript` بيعمل `focus()` على الـ prompt editor، Slate.js بيقبل الـ focus — لكن لما `Input.insertText` بييجي من CDP، الـ browser أحياناً بيكتبه في **آخر element اتعمله focus** من خلال trusted browser events، مش من خلال scripting. النتيجة إن الـ CDP `insertText` بيكتب في الـ **title field** بدل الـ prompt editor — فالـ title بيتبقى فاضي (أو بيتكتب فيه الـ prompt).

ده بيحصل تحديداً مع **أول صورة فقط** لأن بعدها الـ Slate editor بيكون already focused من الـ interaction السابقة.

---

### ملفات المعنية

| الملف | المشكلة |
|---|---|
| `content.js` — `attachTileListeners()` | بيعمل listen على outer + inner tiles معاً |
| `content.js` — `executeAction()` | `allTilesInOrder` بيحسب double count |
| `content.js` — `captureImagesFromDOM()` | نفس الـ double count |
| `background.js` — `processScene()` | CDP `insertText` بيكتب في غلط element |

---

### الحل المطلوب

**للمشكلة 1:**
دالة `getInnerTiles()` تفلتر وتجيب بس الـ tiles اللي:
- فيها `img[alt="صورة تم إنشاؤها"]` مباشرة
- ومفيهاش `[data-tile-id]` nested جوّاها (يعني مش outer wrapper)

```js
function getInnerTiles() {
  return Array.from(document.querySelectorAll('[data-tile-id]')).filter(tile =>
    tile.querySelector('img[alt="صورة تم إنشاؤها"]') !== null &&
    tile.querySelector('[data-tile-id]') === null
  );
}
```

**للمشكلة 2:**
بدل `scripting.executeScript` للـ focus، نستخدم CDP `dispatchMouseEvent` مباشرةً على إحداثيات الـ prompt editor — ده بيضمن إن الـ CDP events كلها (click + Ctrl+A + insertText) بتروح لنفس الـ element.


مشكلة التحميل الحالية باختصار:
بيحمّل عدد صور أقل أو أكتر من المحدد
الـ content script أحياناً بيكوّن selectedData غلط (dedup زيادة أو فقدان عناصر)، فيوصل للـ background عدد صور غير اللي اخترتهم فعلاً.
كمان الـ dedup بالـ URL (بعد قص الـ query string) ممكن يجمع صورتين مختلفتين تحت نفس الـ base URL في حالات نادرة.
أسماء الملفات مش مرتبطة بالمشهد صح
مش كل Tile عنده scene_number وscene_description متقرين صح من الـ DOM، فبعض الصور بتوصل للـ background بـ scene_number = 1 أو وصف فاضي.
EXECUTE_SELECTION في background.js بيبني الاسم من البيانات اللي جاية، فلو الرقم/الوصف ناقص، الاسم يطلع scene_007 فقط.
التحميل من الكنترول العايم منفصل عن منطق الـ Queue
الـ Queue عندها منطق filename مضبوط (buildFilename مع الوصف)، لكن الكنترول العايم بيعيد اختراع نفس المنطق، وفيه اختلافات بينهم.
مفيش ربط واضح بين الصورة اللي في Flow وبين المشهد الأصلي في scenes[]، فصعب نستخدم نفس scene_description الأكيدة.
المطلوب:
في content.js:
التأكد إن executeAction يبعت لكل صورة محددة object فيه:
url، scene_number مضبوط، scene_description متقري صح من الـ DOM (label/aria-label) بدون dedup غلط.
في background.js:
2. توحيد بناء الاسم بحيث يعتمد نفس منطق buildFilename، ويشتغل على الصور اللي جاية من الكنترول العايم بنفس الشكل، بدون تجاهل أي عنصر.

المفروض الاكستنشن بيترفعلها ملف جييسون زي كده 
[
  {
    "scene_number": 1,
    "scene_description": "Friedrich Hecker sitting at a table with a cup of coffee, looking worried",
    "main_prompt": "STYLE: In the style of a Norman Rockwell vintage illustration, painted with oil and ink, warm amber interior lighting, rich warm brown tones throughout, well-lit scene with soft warm glow, background is aged dark brown texture NOT black, torn aged paper edges with tape marks on corners, heavy film grain and age spots, desaturated warm amber palette, cinematic 16:9 composition, a German banker in 1923, sitting at a small table with a single cup of coffee in front of him, looking worried and disappointed",
    "label_text": "HISTORICAL",
    "secondary_labels": [
      "DEPRESSION"
    ],
    "negative_prompt": "pure black background, overly dark scene, white background, clean border, hyperrealistic skin, photographic face, CGI, anime, flat design, oversaturated, watermark, modern style"
  },
  {
    "scene_number": 2,
    "scene_description": "Wheat farmer standing in a field of wheat, smiling",
    "main_prompt": "STYLE: In the style of a Norman Rockwell vintage illustration, painted with oil and ink, warm amber interior lighting, rich warm brown tones throughout, well-lit scene with soft warm glow, background is aged dark brown texture NOT black, torn aged paper edges with tape marks on corners, heavy film grain and age spots, desaturated warm amber palette, cinematic 16:9 composition, a wheat farmer in 1923, standing in a field of wheat, smiling and looking content",
    "label_text": "PROSPERITY",
    "secondary_labels": [
      "FARMER"
    ],
    "negative_prompt": "pure black background, overly dark scene, white background, clean border, hyperrealistic skin, photographic face, CGI, anime, flat design, oversaturated, watermark, modern style"
  },
  {
    "scene_number": 3,
    "scene_description": "People trading goods for bags of flour",
    "main_prompt": "STYLE: In the style of a Norman Rockwell vintage illustration, painted with oil and ink, warm amber interior lighting, rich warm brown tones throughout, well-lit scene with soft warm glow, background is aged dark brown texture NOT black, torn aged paper edges with tape marks on corners, heavy film grain and age spots, desaturated warm amber palette, cinematic 16:9 composition, people in 1923, trading goods such as pianos, fur coats, and family silver for bags of flour",
    "label_text": "BARTER",
    "secondary_labels": [
      "TRADE"
    ],
    "negative_prompt": "pure black background, overly dark scene, white background, clean border, hyperrealistic skin, photographic face, CGI, anime, flat design, oversaturated, watermark, modern style"
  },
انا عايز الصور تنزل بالاسماء دي اللى ف scene_description 
زي كده مثلا
scene_001_Friedrich Hecker sitting at a table with a cup of coffee looking worried

لما بعملها تحميل تلقائي بتنزل  كده تمام اما لما بستخدم التحميل اليدوي اللى هو التحديد وكده بيحملهم بالاسم ده 
 scene_005
*******
// ═══════════════════════════════════════════════════
//  AutoCut v2.1 — background.js
// ═══════════════════════════════════════════════════
