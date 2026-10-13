---
description: Дууссан review-ийн үр дүнг далдалж шалгаад Google Docs руу (анхдагч) эсвэл Claude Docs руу илгээнэ
argument-hint: "<jobId> [claude]"
---

Review-ийн үр дүнг илгээ. Аргумент: `$ARGUMENTS` (2 дахь үг `claude` бол Claude Docs, үгүй бол **Google Docs**).

## Хатуу дүрэм (мэдээллийн хамгаалалт)
- **Зөвхөн** `jobs/<jobId>/docs/payload.google.html` (Google) эсвэл `payload.json` (Claude Docs)-ийн агуулгыг илгээнэ. `mask_map.json`, `sandbox/`, `sources/`, `doc.json`, эх файлыг уншихгүй, илгээхгүй. Token-ийг жинхэнэ утгаар хэзээ ч солихгүй.
- Агуулгыг өөрчлөхгүй, нэмж зохиохгүй. Илгээхийн өмнө хэрэглэгчээс заавал зөвшөөрөл авна.
- Эрх зөвхөн байгууллагын (`@example.mn`) имэйлд. H2/H3 (AML, залилан) агуулсан бол аудитлагдсан салбарын ажилтанд хэзээ ч олгохгүй.

## Алхам
1. `node server/docs_prep.js <jobId>` → exit ≠ 0 эсвэл `"ok": false` бол **зогс** («илгээх боломжгүй» + үлдсэн token-ийн тоо).
2. `jobs/<jobId>/docs/state.json` байвал холбоосыг өгөөд `/sync-docs <jobId>` санал болго; «шинээр илгээ» гэж тодорхой хэлээгүй бол зогс.
3. Товч харуул (нэр, хэсэг, тэмдэглэлийн тоо, `leak_check`) → AskUserQuestion «илгээх үү?». Татгалзвал зогс.
4. **Google Docs** (анхдагч): google-workspace skill-ийг ачаал → Drive `create_file` (`title` = payload.name, `contentMimeType: text/html`, `textContent` = `payload.google.html` бүтнээр нь өөрчлөлтгүй). Дараа нь `read_file_content`-оор уншиж, 39 мөр ба хэсгүүд бүрэн эсэхийг шалга; `get_file_permissions`-ээр эзэмшигчийг тэмдэглэ.
   **Claude Docs** (`claude`) — **тайлан дээрх тэмдэглэл** горим, эх сурвалж нь зөвхөн `jobs/<jobId>/docs/annotated.json` (`node server/docs_annot.js <jobId>` → `ok: false` эсвэл алдаа бол зогсож шалтгааныг хэл; захирал зөвшөөрөөгүй бол «вэб дээр ✓ Зөвшөөрөх» гэж хэл):
   1. Birth batch: нэр = `name`; markdown = гарчиг, byline, `lead`, `chunks` тус бүрт нэг pending блок, `general_markdown` байвал түүнд нэг pending (тайлангийн ДАРАА). Мөн ижил birth-д 2 дахь tab «Тэмдэглэлүүд» (topic.tabs) — enum `Төлөв` (`status_options`) + `tracker.markdown` + `tracker.blocks` (dropdown).
   2. Pending бүрийг дарааллаар `chunks[i]`-ээр солино (агуулгыг өөрчлөхгүй, нэг update = нэг chunk).
   3. Comment: `comments[]` бүрт тайлангийн tab-ын body дээр `create utterance` — `body` = `comments[i].body`, anchor `{"kind":"find","text": anchor, "nth": nth}`. Аль болох `batch`-аар 20-иор. `find_none` бол `search` read-ээр `block_hint`-ийг олж, тэр блокийн эхний 3–6 үгэнд холбо; тэгээд ч болохгүй бол «Тайлан бүхэлд» хэсэгт холбож тэмдэглэ.
   4. Анхаар: comment-ыг `to: claude` болгохгүй; thread-ийг resolve хийхгүй.
5. `state.json` бич: `{"platform","url","google":{"file_id","owner","shared_with":[]}` эсвэл `"claude_docs":{"mode":"annotated","doc_id","report_tab","report_body","tracker_tab","tracker_body","rev","last_comment_seq","threads":{"<RV-ID>":"<root utterance id>"}}`, `"published_at","last_sync","reviewed":{}}`. Claude Docs-д илгээж чадаагүй comment-ыг `failed_comments`-д бич.
6. Хэрэглэгчээс role бүрийн имэйлийг асуу (AskUserQuestion эсвэл чатаар) → Google бол `share_file` (аудитор/хянагч = `writer`, удирдлага = `reader`, зөвхөн тайлбар бичих бол `commenter`), `shared_with`-д `{email, role}` нэм, `get_file_permissions`-ээр баталгаажуул. Claude Docs бол эрхийг хэрэглэгч Share товчоор өөрөө өгнө.
7. Чатад: файлын холбоос + хэнд ямар эрх өгсөн.
