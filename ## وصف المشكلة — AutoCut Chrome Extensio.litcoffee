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
    tile.querySelector('img[src*="getMediaUrlRedirect"], img[alt="صورة تم إنشاؤها"], img[alt="Generated image"]') !== null &&
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
//  AutoCut v1.1.1 — background.js
// ═══════════════════════════════════════════════════


-**********************
<div style="height: 281.812px; width: 501px; transform: none; transform-origin: 50% 50% 0px; opacity: 1;"><div style="height: 100%"><div data-tile-id="fe_id_cc3f9b29-ec2e-41d3-b6b2-6d5f3d394e39" class="sc-b04ce3b3-0 jqnRiF"><span data-state="closed"><div class="sc-7a78fdd8-0 ffAjch sc-3af37164-0 gamxBN"><div class="sc-7a78fdd8-1 dEOwMG"><div role="button" tabindex="0" aria-disabled="false" aria-roledescription="draggable" aria-describedby="DndDescribedBy-1" class="sc-bf04f0d9-0 bpSgXK"><span data-state="closed"><div data-tile-id="fe_id_cc3f9b29-ec2e-41d3-b6b2-6d5f3d394e39" class="sc-9a984650-0 ZqgEc"><div class="sc-9a984650-4 foCtss"><i class="sc-95c4f607-0 grsLJu google-symbols undefined" font-size="1rem" color="currentColor">warning</i><div><div class="sc-9a984650-1 dEfdsQ">تعذَّر إكمال المعالجة</div><div class="sc-9a984650-2 hYJKbh">يتم حاليًا إجراء الكثير من طلبات إنشاء المحتوى. يرجى الانتظار قليلاً ثم إعادة المحاولة مرة أخرى.</div></div></div><div class="sc-9a984650-5 hoIBMT"><button data-state="closed" class="sc-16c4830a-1 ehipYG sc-e7a64add-0 sc-e7a64add-2 gdoOJp fUilPO"><i class="sc-95c4f607-0 fMVsQH google-symbols undefined" font-size="1.25rem" color="currentColor">refresh</i><span style="position: absolute; border: 0px; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; overflow-wrap: normal;">إعادة المحاولة</span><div data-type="button-overlay" class="sc-16c4830a-0 iSFgQn"></div></button><button data-state="closed" class="sc-16c4830a-1 ehipYG sc-e7a64add-0 sc-e7a64add-2 gdoOJp fUilPO"><i class="sc-95c4f607-0 fMVsQH google-symbols undefined" font-size="1.25rem" color="currentColor">undo</i><span style="position: absolute; border: 0px; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; overflow-wrap: normal;">إعادة استخدام الطلب</span><div data-type="button-overlay" class="sc-16c4830a-0 iSFgQn"></div></button><button data-state="closed" class="sc-16c4830a-1 ehipYG sc-e7a64add-0 sc-e7a64add-2 gdoOJp fUilPO"><i class="sc-95c4f607-0 fMVsQH google-symbols undefined" font-size="1.25rem" color="currentColor">delete_forever</i><span style="position: absolute; border: 0px; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; overflow-wrap: normal;">حذف</span><div data-type="button-overlay" class="sc-16c4830a-0 iSFgQn"></div></button></div></div></span></div></div></div></span></div></div></div>





5154620022016024|04|33|532
5154620022690935|07|33|344
5154620022023186|07|28|220
5154620022139453|11|30|691
5154620022087785|12|32|796
5154620022268047|08|27|857
5154620022768004|08|32|374
5154620022123218|03|31|522
5154620022773970|01|33|648
5154620022957649|07|30|859
5154620022357873|03|28|783
5154620022097867|10|32|431
5154620022737819|08|30|805
5154620022245110|09|34|255
5154620022030066|08|32|330
5154620022042962|02|30|336
5154620022834947|02|31|160
5154620022971137|04|34|958
5154620022229197|07|31|383
5154620022987570|01|29|107
5154620022778185|03|29|780
5154620022455040|11|34|470
5154620022770661|12|34|986
5154620022599003|05|27|155
5154620022526303|06|34|712
5154620022054397|02|27|814
5154620022161382|09|34|389
5154620022562621|08|30|665
5154620022245987|11|30|643
5154620022052243|11|33|465
5154620022728412|07|33|564
5154620022541179|05|34|385
5154620022035495|10|28|887
5154620022097537|03|32|788
5154620022391286|11|33|821
5154620022959702|06|29|853
5154620022431454|12|28|951
5154620022010746|03|30|596
5154620022710295|01|30|888
5154620022000747|09|32|520
5154620022681603|09|30|402
5154620022667131|09|30|537
5154620022821704|11|34|885
5154620022416729|01|27|824
5154620022096505|10|34|381
5154620022034209|03|31|591
5154620022878134|03|31|489
5154620022560500|08|34|856
5154620022707101|08|30|154
5154620022394926|09|34|754
5154620022927121|01|29|398
5154620022231201|06|27|207
5154620022126898|11|28|403
5154620022765182|02|32|233
5154620022367351|08|33|104
5154620022927592|06|34|272
5154620022852832|07|28|338
5154620022664468|08|27|791
5154620022071656|06|32|165
5154620022621641|10|32|988

Live | 5154620022723736|03|28|701 | [BIN: 🇺🇸 - mastercard - prepaid] | Charge OK. [GATE_01@chkr.cc]

Live | 5154620022415606|12|32|769 | [BIN: 🇺🇸 - mastercard - prepaid] | Charge OK. [GATE_01@chkr.cc]

Live | 5154620022281438|05|29|504 | [BIN: 🇺🇸 - mastercard - prepaid] | Charge OK. [GATE_01@chkr.cc]

Live | 5154620022263329|12|30|984 | [BIN: 🇺🇸 - mastercard - prepaid] | Charge OK. [GATE_01@chkr.cc]

Live | 5154620022674970|06|28|471 | [BIN: 🇺🇸 - mastercard - prepaid] | Charge OK. [GATE_01@chkr.cc]

Live | 5154620022860793|02|31|516 | [BIN: 🇺🇸 - mastercard - prepaid] | Charge OK. [GATE_01@chkr.cc]




5154620022723736
5154620022415606
5154620022281438
5154620022263329
5154620022674970
5154620022860793


Live | 6258142602333300|01|2033|232 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602127033|01|2033|845 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602784650|01|2033|527 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602278273|01|2033|198 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602280402|01|2033|627 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602867323|01|2033|955 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602513281|01|2033|224 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602415016|01|2033|320 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602363117|01|2033|486 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602078558|01|2033|883 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602517134|01|2033|424 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]
Live | 6258142602754000|01|2033|126 | [BIN: 🇰🇷 - china union pay - credit] | Charge OK. [GATE_01@chkr.cc]



𝗕i𝗡 : 𝟱𝟭𝟱𝟰𝟲𝟮𝟬𝟬𝟮𝟮
 Vpn : بنغلاديش 🇧🇩 BD
 𝗔𝗱𝗱𝗿𝗲𝘀𝘀 : 𝗜𝗡𝗗,𝟬𝟬𝟲𝟮 
𝗣𝗼𝘀𝘁𝗰𝗼𝗱𝗲 : 𝟬𝟮𝟬𝟭𝟬𝟭 
𝗣𝗿𝗼𝘃𝗶𝗻𝗰𝗲 : 𝗔𝗹𝗺𝗮𝘁𝘆 
𝗖𝗶𝘁𝘆 : 𝗦𝗲𝗺𝗶𝗽𝗮𝗹𝗮𝘁𝗶𝗻𝘀𝗸 
𝗖𝗼𝘂𝗻𝘁𝗿𝘆 : 𝗞𝗮𝘇𝗮𝗸𝗵𝘀𝘁𝗮𝗻
