# ГАРЧИЛТЫН БҮТЭЦ (schema v3 · SP-118-04)

Гурван файл бичнэ: `output/review_findings.json` (үндсэн), `output/review_summary.json`, `output/review_report.md`.

> `gate0`, `scorecard`, `review.verdict`, `review.r1_count…r4_count`, `ai_run` талбаруудыг **систем** (детерминист код) таны гаралтын дараа дахин тооцож бичнэ. Та өөрийн тооцоогоор бөглөнө, гэхдээ эцсийн утга системийнх.

---

## 1. `review_findings.json` — үндсэн өгөгдөл

Хэрэглэгч review-г **өөрийн тайлан дээрээ** харна: санал бүр `anchor` догол мөрийн хажууд тэмдэглэл болж, `quote` тодорно. Эхлээд зөвхөн `title` харагдана; сонирхвол `issue` → `required_action` → `evidence` → `impacts` дэлгэнэ.

```json
{
  "schema_version": 3,
  "audit": { "name": "", "branch": "", "code": "", "report_no": "" },
  "review": {
    "verdict": "READY | READY_WITH_FIXES | NOT_READY | ESCALATE | RUN_REJECTED",
    "r1_count": 0, "r2_count": 0, "r3_count": 0, "r4_count": 0,
    "cycle_no": 1,
    "review_depth": "FULL",
    "core_question": "YES | PARTIALLY | NO",
    "report_rating": "Тайланд бичигдсэн ерөнхий үнэлгээ (Хангалттай сайн / Сайн / Дунд / Хангалтгүй / Муу) эсвэл 'Тодорхойгүй'",
    "report_rating_consistent": "YES | NO | UNKNOWN"
  },
  "headline": "НЭГ өгүүлбэр (≤ 20 үг): хамгийн гол асуудал.",
  "executive_summary": "≤ 3 өгүүлбэр.",
  "decision_points": ["Захирал шийдэх асуудал — 1 өгүүлбэр (≤ 5 ширхэг)"],
  "issues": [
    {
      "id": "REV-001",
      "severity": "R1 | R2 | R3 | R4",
      "module": "M05",
      "rule": "M05-01",
      "source": "DOC-1912 Хав. B",
      "draft_source": true,
      "confidence": "High | Medium | Low",
      "category": "NUMERIC_MISMATCH | 5C_MISSING | RATING | SCOPE | EVIDENCE | COMPLIANCE | RECOMMENDATION | MGMT_RESPONSE | FOLLOWUP | LANGUAGE | CODING | STRUCTURE | PROGRAM | INPUT | AI_INSIGHT | KB_CONFLICT",
      "anchor": "P8",
      "quote": "тайлангаас ҮГ ҮСГИЙГ НЬ ӨӨРЧЛӨХГҮЙ хуулсан хэсэг (≤ 25 үг)",
      "title": "≤ 8 үг, ойлгомжтой",
      "issue": "≤ 2 богино өгүүлбэр, гол тоотой. Тоон зөрүү бол: байршил A = утга A, байршил B = утга B, зөрүү.",
      "why_it_matters": "1 өгүүлбэр — захирлын нүдээр эрсдэл.",
      "evidence": [
        { "file": "loans.xlsx", "sheet": "Зээл", "rows": "R6,R7", "cols": "A", "source": "loans.xlsx › Зээл › R6–R7", "detail": "L-003 давхардсан" },
        { "file": "Журам.docx", "anchor": "P14", "source": "Журам.docx › P14", "detail": "4.2-т заасан баримтын жагсаалт" }
      ],
      "required_action": "1 өгүүлбэр, үйл үгээр эхэлсэн — аудитор юу хийх.",
      "suggested_text": "Боломжтой бол quote-ыг ШУУД ОРЛОХ засварласан текст (эсвэл хоосон).",
      "impacts": [ { "element": "Гүйцэтгэх хураангуй — олдворын тоо", "anchor": "P5", "action": "дахин тулгах" } ],
      "resolution_check": "Дараагийн хувилбарт засагдсан эсэхийг юугаар шалгах — 1 өгүүлбэр."
    }
  ],
  "escalations": [
    { "type": "AML_24H | CYBER_1H | FRAUD_AC | MATERIAL_5D | CRITICAL_24H | COI | KB_CONFLICT",
      "anchor": "P12", "requirement": "Хэнд, хэдэн цагт", "status_in_report": "Тэмдэглэгдсэн | Тэмдэглэгдээгүй", "rule": "M07-03" }
  ],
  "kb_conflicts": [
    { "id": "KB-CONFLICT-01", "topic": "", "doc_a": "", "doc_b": "", "effect_on_report": "", "affects_conclusion": false, "decision": "Шийдвэрлэсэн: … | Шийдвэр хүлээгдэж байна" }
  ],
  "insufficient_inputs": ["Дутуу оролт, нөлөөлсөн модуль: 'Follow-up extract (RPT-175) ирээгүй — M10 PARTIAL'"],
  "observations_misclassified": ["5C дутуу атлаа олдвор гэж орсон олдворын нэр (M03-01) — байхгүй бол хоосон"],
  "missing_elements": ["Тайланд огт байхгүй заавал элемент (M01), жишээ: 'Бүртгэлийн дугаар талбар'"],
  "five_c": [
    { "finding": "Олдворын нэр", "anchor": "P7", "criteria": "Байгаа/Дутуу — товч", "condition": "", "cause": "RC-ангилал эсвэл Дутуу", "consequence": "учирсан/болзошгүй", "corrective_action": "3 давхарга байгаа эсэх", "status": "Complete | Partially Complete | Incomplete", "rating_in_report": "Critical | Өндөр | Дунд | Бага | Байхгүй", "rating_assessment": "Дүйцсэн | Хэтэрсэн | Дутуу | Үндэслэлгүй", "suggested_rating": "Зөвхөн санал — эсвэл хоосон" }
  ],
  "numerical_validation": [
    { "metric": "", "report": "", "evidence": "", "reviewer": "", "status": "Matched | Difference | Unable to validate", "source": "loans.xlsx › Зээл › R4–R8", "ref": { "file": "loans.xlsx", "sheet": "Зээл", "rows": "R4-R8" } }
  ],
  "recommendation_deadlines": {
    "report_rating": "", "recommendation_count": 0, "unit_type": "Салбар | Төвийн газар",
    "max_days_by_matrix": 0, "doc1912_days": "Зэрэглэлээр: Critical 90 / Өндөр 90 / Дунд 180 / Бага 365 — лавлагаа",
    "stated_days": "", "status": "Нийцсэн | Хэтэрсэн | Шалгах боломжгүй"
  },
  "program_coverage": [
    { "step": "Хөтөлбөр дэх дугаар", "procedure": "≤ 15 үг", "area": "Эрсдэлийн талбар", "status": "finding | no_exception | scope_limitation | not_reported",
      "report_anchor": "P45 | T9R3 | null", "issue_ids": ["REV-007"], "note": "1 өгүүлбэр",
      "program_ref": { "file": "Хөтөлбөр.xlsx", "sheet": "Хөтөлбөр", "rows": "R12" }, "source": "Хөтөлбөр.xlsx › Хөтөлбөр › R12" }
  ],
  "followup_check": [
    { "iss_id": "ISS-…", "title": "≤ 10 үг", "rating": "", "status": "S1..S7", "due_date": "YYYY-MM-DD", "overdue_days": 0,
      "in_report": "YES | NO", "report_anchor": "P30 | null", "repeat": "YES | NO", "issue_ids": ["REV-012"],
      "ref": { "file": "RPT175.xlsx", "sheet": "", "rows": "R8" } }
  ],
  "recommendation_check": [
    { "finding": "≤ 10 үг", "anchor": "P41", "kind": "DOC_CHANGE | ONE_OFF | UNCLEAR",
      "target_doc": "баримтын нэр (газар) | null", "catalog_match": "MATCH | AMBIGUOUS | NOT_IN_CATALOG | NOT_CHECKED | N/A",
      "elements": { "owner": "YES | NO", "deadline": "YES | NO", "evidence": "YES | NO", "gate_or_threshold": "YES | NO | N/A", "segment": "YES | NO | N/A" },
      "owner_is_doc_owner": "YES | NO | UNKNOWN", "precedent": "REQ-03 / АО-2026-24 | null", "precedent_consistent": "YES | WEAKER | DIFFERENT | N/A",
      "missing": ["ХУГАЦАА / SLA"], "issue_ids": ["REV-007"] }
  ],
  "required_actions": [ { "priority": 1, "action": "≤ 12 үг, үйл үгээр эхэлсэн", "issue_ids": ["REV-001"] } ],
  "final_instruction": "Дараагийн алхам — 1–2 өгүүлбэр (эскалацийн шаардлага энд)."
}
```

### Дүрэм
- **id:** `REV-001`, `REV-002` … гэж дугаарла. Систем дараа нь `RV-<EngID>-C<cycle>-NNN` болгож бүх лавлагааг (`issue_ids`) хамт солино.
- **anchor:** догол мөр `P12`, хүснэгт `T2`, хүснэгтийн мөр `T2R3`. Тайланд огт байхгүй зүйл → тухайн хэсгийн гарчгийн anchor, гарчиг ч байхгүй бол `null`.
- **quote:** anchor-ын текстээс **яг хуулсан** (token-уудыг хэвээр), ≤ 25 үг. Таарахгүй бол хоосон. Систем ишлэл бүрийг тайлантай тулгана; олдоогүй ишлэлтэй санал хасагдаж болно.
- **suggested_text:** аудитор «Зөвшөөрөх» дарахад тайланд `quote`-ын оронд яг энэ текст орно. Тиймээс `quote`-той ижил хүрээтэй (тэр хэсгийг бүхэлд нь орлох), token-уудыг хэвээр бичнэ; тайлбар, хашилт, «...» нэмэхгүй. Шинэ баримт, тоо, олдвор зохиохгүй — зөвхөн найруулга, бүтэц, дутуу элементийн байрлалыг засна. Тодорхой бус бол хоосон.
- **module / rule:** system_prompt §3-ын модуль (G0, M01…M14) ба шалгуурын ID (`M03-05`). **source:** эх баримт + заалт (DOC-1912 §7.3.1). Дүрэмгүй санал → `rule: "AI-INSIGHT"`, `module: "M13"`, `severity` ≤ R2. **draft_source:** эх баримт PENDING APPROVAL бол `true`.
- **severity:** config/decision_rules.md §1. Шалгуурын каталогт заасан түвшнээс бууруулахгүй; ахиулбал `issue`-д үндэслэлийг бич.
- **confidence:** High = тайлан/файлаас шууд нотлогдсон; Medium = мэргэжлийн шүүлт; Low = «Аудитороос тодруулах» (`title`-ийн эхэнд «Тодруулах:» гэж бич).
- **impacts:** M10 хамаарлын гинжээр нөлөөлөх элементүүд (decision_rules §4). Нөлөөгүй бол `[]`.
- **evidence (дарж нээгдэнэ):** `file` = эх файлын **анхны нэр** (`# SOURCE:` мөрөөр); Excel → `sheet` + `rows` (+ `cols`); Word/PDF → `anchor`.
- **escalations:** M07-03/04/05, M04-05 болон H-төрлийн шинж бүрт нэг мөр. Байхгүй бол `[]`.
- **kb_conflicts:** зөвхөн **энэ тайланд нөлөөлсөн** зөрчил (decision_rules §5).
- **program_coverage:** хөтөлбөрийн файл оруулсан бол алхам бүрт нэг мөр (M02-04); оруулаагүй бол `[]`.
- **followup_check:** follow-up extract (`followup__*`) оруулсан бол тухайн нэгжийн нээлттэй (S1–S4, S6) мөр бүрт нэг мөр (M10); оруулаагүй бол `[]`.
- **recommendation_check:** тайлангийн зөвлөмж бүрт нэг мөр (M08-08…M08-12). `missing` хоосон биш эсвэл `precedent_consistent` = WEAKER/DIFFERENT бол холбогдох санал (issue)-ын ID-г `issue_ids`-д. Ижил дутагдалтай олон зөвлөмжийг НЭГ санал болгон бүлэглэ. Тайланд зөвлөмж алга бол `[]`.
- Нэг асуудлыг давхардуулахгүй; ижил төрлийн хэл найруулгын алдааг **бүлэглэ** (төрөл × тоо × жишээ байршил). Issues-ийг R1 → R2 → R3 → R4, дараа нь байрлалаар эрэмбэлнэ.
- **Систем шалгасан баримт:** `facts/rule_engine.json`-д байгаа саналыг давтан бичихгүй — систем өөрөө нэмнэ. Тэдгээрийн тоог дахин тоолохгүй.
- **Товч:** title ≤ 8 үг; issue ≤ 2 өгүүлбэр; required_action 1 өгүүлбэр; headline 1 өгүүлбэр; executive_summary ≤ 3 өгүүлбэр.

---

## 2. `review_summary.json`

```json
{ "audit": { "name": "", "branch": "", "code": "" },
  "review": { "verdict": "", "r1_count": 0, "r2_count": 0, "r3_count": 0, "r4_count": 0 } }
```

---

## 3. `review_report.md` — захиралд (архивын хувилбар)

```
# АУДИТЫН ТАЙЛАНГИЙН ЭЦСИЙН ХЯНАЛТ (SP-118-04)
> Reviewer decision support — эцсийн шийдвэрийг ДАГ-ын захирал гаргана (DOC-1917 §8–9). Internal Audit – Restricted.

## 1. Шийдвэрийн хуудас
Verdict · R1 / R2 / R3 / R4 тоо · headline · 3–5 гол эрсдэл · захирлын шийдэх асуудал · эскалаци
## 2. Scorecard (G0, M01–M14)
## 3. Саналууд — R1 → R2 → R3 → R4 (байршил · юу · яагаад · дүрэм · засвар)
## 4. 5C ба зэрэглэлийн хяналт
## 5. Тоон тулгалт
## 6. Зөвлөмжийн хугацаа (ДАГ матриц; DOC-1912 Хав. Б лавлагаа) ба шаардлагын шалгалт (M08-08…12: зөвлөмж → зорилтот баримт → дутуу шаардлага, өмнөх RPT-175 зөвлөмжтэй нийцэл)
## 7. Аудитын хөтөлбөрийн хэрэгжилт
## 8. Follow-up ба хамаарлын зураглал
## 9. Нэмэлт санал (AI-INSIGHT)
## 10. Дутуу оролт ба мэдлэгийн сангийн зөрчил
```
