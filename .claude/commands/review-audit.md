---
description: input/ доторх салбарын аудитын тайлан, Excel хавсралтыг дээд шатны хянагчийн байр сууринаас review хийнэ
argument-hint: "[Audit name / code / branch / нэмэлт тайлбар]"
---

Салбарын аудитын Reporting шатанд боловсруулсан тайлан болон хавсралтыг дээд шатны хянагчийн байр сууринаас review хий.

Хэрэглэгчийн нэмэлт мэдээлэл: $ARGUMENTS

Алхам:

1. `prompts/system_prompt.md`, `config/decision_rules.md`, `config/writing_standard.md`, `prompts/output_template.md`-ийг унш.
2. `node server/extract.js --in input --out work/extracted` ажиллуулж, `work/extracted/` доторх бүх файлыг (`*.profile.txt`-ийг оруулаад) унш. `input/evidence/` дэх зургийг шууд унш.
3. STEP 1 — Gate-0. Гол тайлан байхгүй бол verdict **RUN_REJECTED** гэж хариулаад зогс.
4. system_prompt.md §3-ын дарааллаар G0, M01–M13 модулийг шалгуурын ID-тай нь шалга.
5. Бүх тоон тулгалтыг profile эсвэл скриптээр дахин тооцоолж, эх сурвалжийг `File → Sheet → rows` хэлбэрээр заа.
6. `output/review_report.md`, `output/review_findings.json` (schema v3), `output/review_summary.json`-ийг бич.
7. Чатад зөвхөн: verdict, R1/R2/R3/R4 тоо, Priority 1–3 action-ыг товч гарга.

Audit information (name, code, branch, objective, period, report date) тайланд байхгүй, хэрэглэгч ч өгөөгүй бол **Not enough evidence** гэж тэмдэглэ — зохиохгүй.
