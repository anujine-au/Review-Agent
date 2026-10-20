# Branch Audit Report Reviewer Agent

Энэ workspace нь ББСБ-ын Дотоод аудитын салбарын аудитын тайланг **Reporting** шатанд дээд шатны хянагчийн байр сууринаас review хийх агент юм.

## Аудитын тайлан review хийх хүсэлт ирэхэд

1. `prompts/system_prompt.md`-ийг бүтнээр уншиж, дүрээ (Senior Internal Audit Report Reviewer) болон бүх дүрмийг мөрд.
2. `config/decision_rules.md` (зэрэглэл, эцсийн санал), `config/writing_standard.md` (ДАГ-ын бичгийн стандарт, зөвлөмжийн хугацааны матриц)-ийг унш.
3. Файлуудыг задал: `node server/extract.js --in input --out work/extracted` → `work/extracted/*.txt` ба `*.profile.txt`.
   - `.docx` → `[P#]` догол мөр (`[№ 1.]` жагсаалтын дугаар), `T#R#` хүснэгтийн мөр (`↑` / `←` нэгтгэсэн нүд); header/footer/зүүлт, `[CH#]` Word-ийн диаграм, `[DG#]` SmartArt, `[TB#]` текст хайрцаг, `[IMG#]` зураг (`--images-out` өгвөл зургийг бичнэ — зөвхөн хэрэглэгч зураг илгээхийг зөвшөөрсөн үед), `COLOR-MARKED` хэсэг.
   - `.xlsx` → `SHEET: <нэр>`, мөр бүр `R<Excel мөрийн дугаар>` + tab-аар тусгаарлагдсан утга, томьёо `{=...}`, огноо `YYYY-MM-DD`.
   - `*.profile.txt` → мөрийн тоо, нийлбэр, давхардал, ангиллаар бүлэглэсэн дүн.
   - `.doc` / `.xls` дэмжигдэхгүй — хэрэглэгчээс `.docx` / `.xlsx` болгож хадгалахыг хүс. Зураг (screenshot)-ийг Read tool-оор шууд уншина.
4. Тооцоолол (нийлбэр, unique count, хувь)-ыг толгойгоор биш, profile эсвэл Node.js / PowerShell скриптээр гүйцэтгэж, ашигласан sheet / range / шүүлтүүрийг тайланд дурд.
5. Гаралтыг `prompts/output_template.md`-ийн бүтцээр гарга:
   - `output/review_report.md`
   - `output/review_findings.json`
   - `output/review_summary.json`
6. SP-118-04 стандарт (2026-10-09): саналыг G0, M01–M14 модуль, шалгуурын ID-тай, R1 / R2 / R3 / R4 зэрэглэл, confidence-тэй гарга; verdict (READY / READY_WITH_FIXES / NOT_READY / ESCALATE)-ийг `config/decision_rules.md` §2-ын дагуу механикаар (оноо хэрэглэхгүй). Вэб хэрэгсэлд детерминист шалгуурыг `server/rules.js`, verdict/scorecard-ийг `server/standard.js` тооцно.

## Docs цикл (Google Docs анхдагч, Claude Docs сонголтоор)

- Илгээх: `/publish-docs <jobId>` (Google Docs) эсвэл `/publish-docs <jobId> claude`. Зөвхөн `server/docs_prep.js`-ийн далдалж, `mask_map`-тай тулгаж шалгасан `payload.google.html` / `payload.json`-ийг илгээнэ. Google-д эрхийг `share_file`-аар (аудитор/хянагч = writer, удирдлага = reader) зөвхөн `@netgroup.mn` имэйлд олгоно.
- Дахин шалгах: `/sync-docs <jobId>` — аудиторын хариу, comment-ийг уншиж, мөр бүрт дүгнэлт comment бичнэ. Төлөвийг «Хянагч баталгаажуулсан» болгох нь зөвхөн хүний эрх.
- Ийм Doc-оос `[Artifact comment sent to Claude]` ирвэл: `jobs/*/docs/state.json`-оос `project_id`-аар job-оо олж, `/sync-docs`-ийн дүрмээр тухайн thread-д л хариул.
- Docs дээр token-ийг жинхэнэ утгаар хэзээ ч солихгүй.

## Вэб хэрэгслийн ажлын урсгал

- Төлөв: `DRAFT → SUBMITTED → CAE_REVIEW → RETURNED → RESUBMITTED → … → APPROVED_FINAL` (`server/workflow.js`). Аудитор release хүртэл AI-ийн санал харахгүй; зөвхөн `jobs/<root>/feedback/feedback_v{n}.json` (царцсан).
- Хянуулах хүсэлт (SUBMITTED / RESUBMITTED) илгээхэд AI шууд ажиллахгүй (AI төлөв `pending`); захирал тайлан бүр дээр «AI хянуулах» (`POST /api/jobs/<id>/ai-review`, эрх `job.runAI`) дарж эхлүүлнэ. AI нэг удаад нэг тайлан шалгах хооронд захирал бусад дууссан тайлангийн саналыг шийдвэрлэж болно.
- Засварын дахин хяналт (M14) нь сүүлийн release хийсэн feedback-ийн эсрэг шалгана (`runner.previousIssues`).
- Тайлан дээр шууд засах (`server/edits.js`): RETURNED үед багийн гишүүн санал бүрийн `quote`-ыг `suggested_text` (эсвэл өөрийн текст)-ээр урьдчилан харж зөвшөөрнө → `jobs/<root>/edits/v<n>/working.docx` (эх файл өөрчлөгдөхгүй, засвар бүрийг буцааж болно). «Засвар оруулах» маягтаас энэ файлыг засварласан тайлан болгон илгээнэ. «✨ AI-аар найруулга» (`server/suggest.js`): нэг саналд далдалсан бичвэрээр, хэрэгсэлгүй Claude дуудаж солих хэсэг + шинэ текст эсвэл «текстээр засагдахгүй» гэсэн хариу авна; шинэ тоо бүрийн эх сурвалжийг тулгана; `logs/ai_runs.jsonl`-д AI_SUGGEST.
- Тест: `node --test tests/workflow.test.js tests/edits.test.js`.

## Хатуу хязгаарлалт

- Файлд байхгүй мэдээллийг зохиохгүй; тодорхойгүй бол **Not enough evidence** / **Нотолгоо хангалтгүй**.
- Finding, шалгуур, management response, conclusion шинээр зохиохгүй — зөвхөн засварын санал.
- Эцсийн шийдвэр нь **Reviewer decision support**; батлах эрх хүнд.
- Review-ийн хэл: Монгол (template-ийн англи гарчиг, шошгыг хэвээр хадгална).
- `input/` дахь эх файлуудыг өөрчлөхгүй.
