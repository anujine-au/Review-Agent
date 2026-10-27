# Аудитын тайлан хянагч агент — Hefesto spec

| | |
|---|---|
| `agent_id` | `review-agent` (repo-гийн нэр; `agent.json`, Company Brain-тэй ижил) |
| Төрөл | Гадаад агент (EXTERNAL) — өөрийн сервер дээр systemd `--user` сервисээр ажиллана |
| Хариуцагч | Дотоод аудитын газар |
| Оролтын цэг | `server/server.js` (HTTPS вэб сервер, `--lan`, port 8443) |
| Хэрэгжүүлэлтийн дараалал | `plan.md` |

Энэ баримт **ЮУ**-г заана; **ЯАЖ** нь `plan.md`-д. Шаардлага бүрийг нотлох файл, мөрийг заасан.
Дэлгэрэнгүй бизнесийн дүрэм (SP-118-04 шалгуур, зэрэглэл) нь `config/decision_rules.md`,
`config/writing_standard.md`, `prompts/system_prompt.md`-д — энэ spec тэдгээрийн агуулгад батламж өгөхгүй.

## 1. Зорилго, хэрэглэгч, оролт / гаралт

- **Зорилго:** салбарын аудитын тайланг Reporting шатанд ДАГ-ын захирлын өнцгөөс хянаж, засварын санал гаргана.
  Шинэ илэрц, дүгнэлт, шалгуур, management response **зохиохгүй**; эцсийн шийдвэр хүнийх.
- **Хэрэглэгч (role):** `admin`, `cae` (ДАГ-ын захирал), `lead_auditor`, `auditor`, `viewer` — `server/users.js:24-30`.
- **Оролт:** вэбээр оруулсан `.docx` тайлан, `.xlsx` хавсралт, аудитын хөтөлбөр, нотлох баримт; эсвэл https линк
  (`server/fetch_url.js`). IAD RPT-175 зөвлөмжийн статус (`server/followup.js`).
- **Гаралт:** `review_findings.json` / `review_report.md` (санал, R1–R4, verdict), аудиторт царцаасан feedback,
  засварын төсөл `.docx` (Track Changes), эцсийн батлагдсан тайлан. Бүгд серверийн локал дискэнд (`jobs/`).

## 2. Заавал хангах шаардлага ба нотолгоо

| ID | Шаардлага | Нотлох газар |
|---|---|---|
| S-01 | Ажлын урсгал: `DRAFT → SUBMITTED → CAE_REVIEW → RETURNED → RESUBMITTED → CAE_REVIEW … → APPROVED_FINAL`; зөвхөн зөвшөөрөгдсөн шилжилт | `server/workflow.js:22`, `:28`, `transition()` `:92` |
| S-02 | Тайлан илгээхэд AI автоматаар **ажиллахгүй** (`awaiting_ai = true`); захирал / админ «AI хянуулах» дарж эхлүүлнэ | `server/server.js:1004`, `:1022-1023`; эрх `server/users.js:41` |
| S-03 | Аудитор, ахлах аудитор AI-ийн дотоод санал, алдааны дэлгэрэнгүйг **харахгүй** — зөвхөн release хийсэн feedback | `server/workflow.js:220-234` (`seesInternals`, `restrictJob`); `server/server.js:711` |
| S-04 | Feedback-ийг аудиторт илгээх (release) нь зөвхөн `cae`; эцэслэн батлах нь `cae`/`admin`; тайланг бэлтгэсэн багийн гишүүн өөрийн тайланг батлахгүй | `server/users.js:40`, `:42`; `server/server.js:243`, `:851`, `:1155`, `:1343` |
| S-05 | AI-ийн код (`runner.js`, `autofix.js`, `suggest.js`, `edits.js`) ажлын урсгалын төлөвийг `APPROVED_FINAL` болгодоггүй | эдгээр файлд `transition(` / `APPROVED_FINAL` байхгүй (§5-ын команд) |
| S-06 | Verdict (READY / READY_WITH_FIXES / NOT_READY / ESCALATE) механикаар тооцогдоно; LLM-ийн verdict-ийг шууд хэрэглэхгүй | `server/standard.js:5`, `computeVerdict()` `:67` |
| S-07 | Хувийн мэдээлэл: **анхдагчаар** Claude-д очихоос өмнө token-оор далдлана (`mask_map.json` Claude-д хүрэхгүй). Үл хамаарал: оруулахдаа `mask: false` илгээвэл тухайн job далдлалтгүй | `server/server.js:801`; `server/runner.js:7`, `:341`, `:374` |
| S-08 | Claude Code хязгаарлагдмал горимоор: `--permission-mode dontAsk`, `--setting-sources project`, `--strict-mcp-config`, `--no-session-persistence`, MCP унтраалттай; review-д зөвхөн `Read,Glob,Grep,Write,Edit`, бичих нь `./output/**`; ишлэл засварт `Read,Glob,Grep`; найруулгын саналд хэрэгсэлгүй (`--tools ""`) | `server/runner.js:285-286`, `:291`, `:316`, `:473-479`; `server/suggest.js:95-98` |
| S-09 | AI-ийн найруулгын хариунд жинхэнэ хувийн мэдээлэл илэрвэл хэрэглэхгүй | `server/suggest.js:168-170`; `server/common.js:101` (`findLeaks`) |
| S-10 | Саналын ишлэл (`quote`) бүрийг тайлангийн бичвэртэй тулгана | `server/verify.js:3`, `:109-110`, `:141` |
| S-11 | Эх файл хэзээ ч өөрчлөгдөхгүй — засвар нь `edits/v<n>/working.docx`-д, буцаах боломжтой | `server/edits.js:5-9`; `server/originals.js:4` |
| S-12 | AI-ийн ноорог тэмдэглэгээ `[АУДИТОР БАТАЛГААЖУУЛАХ: …]` үлдсэн тайланг дахин илгээхгүй (409) | `server/server.js:979-981`; `server/autofix.js:5` |
| S-13 | Нэг удаад **нэг** AI хяналт (ганц ажиглагч дараалал, 3 сек тутам) | `server/server.js:408` (`if (active …) return`), `:1569` |
| S-14 | AI ажиллагаа, шийдвэрийг append-only hash-chain логт бүртгэнэ (тайлангийн текстгүй) | `server/ailog.js:3-9` |
| S-15 | Нууц (хэрэглэгч, SMTP, Drive, TLS, `deploy/env`) болон өгөгдөл (`jobs/`, `input/`, `logs/` …) git-д орохгүй | `.gitignore:1-21`, `:29` |

## 3. Гадагш чиглэсэн холболт (бүрэн жагсаалт)

Ажиллагааны код = `server/*.js`. Гадагш HTTP/сокет **зөвхөн** доорх газраас гарна:

| Хаана | Хаашаа | Унших / бичих |
|---|---|---|
| `server/hefesto.js:30` | Hefesto `/bot-api/heartbeat`, `/bot-api/events` | Телеметр илгээнэ (§4) |
| `server/gdrive.js:23`, `:83`, `:99`, `:110` | Google OAuth (`oauth2.googleapis.com`), Drive API (`www.googleapis.com/drive/v3`) | **Зөвхөн унших** — scope `drive.readonly` (`:21`, `:88`). POST нь зөвхөн token солих / цуцлах |
| `server/fetch_url.js:91` | Хэрэглэгчийн өгсөн https линк | Зөвхөн татна; `https:` л (`:30`), дотоод сүлжээний IP хориглоно (`:50-65`) |
| `server/notify.js:62`, `:87` | Байгууллагын SMTP (`web/smtp.json`, анхдагчаар унтраалттай) | Имэйл мэдэгдэл — тайлангийн агуулгагүй (`:9`) |
| `server/runner.js:64`, `server/suggest.js:98` | `claude` CLI (Anthropic) дэд процесс | Далдалсан бичвэр илгээж, санал авна (S-07, S-08) |

Локал дэд процесс (сүлжээгүй): `server/export.js:631` (headless Edge/Chrome → PDF), `server/final.js:58`
(Windows дээр MS Word COM → PDF).

**Бичдэг газрууд:** өгөгдлийн сан, NetCore, NetBase зэрэг системд **хандахгүй**; Hefesto connector ашиглахгүй
(`agent.json` → `hefesto.connectors: []`, код `INPUT_*` / `CONN_*` хувьсагч уншдаггүй). Бичилт нь серверийн локал
диск (`jobs/`, `logs/`, `web/` тохиргоо), Hefesto event, SMTP имэйл гэсэн гурав л.

## 4. Hefesto телеметр

Хэрэгжүүлэлт: `server/hefesto.js` (бүхэлдээ).

- `HEFESTO_BOT_TOKEN` орчинд байвал л идэвхжинэ; ачаалахдаа `process.env`-ээс хасна — Claude CLI зэрэг дэд процесст
  дамжихгүй (`:14-16`, `:21`). Token-ийг systemd drop-in-д хадгална, код / git-д хэзээ ч үгүй.
- Heartbeat 60 сек тутам тусдаа таймераар, `activity`-тэй (`:18`, `:40-55`, `:58-63`). Hefesto-ийн алдаа үндсэн
  ажиллагааг зогсоохгүй (`:29-37`).
- Heartbeat-ийн хариу `active=false` бол шинэ AI хяналт эхлүүлэхгүй (`:42-45`; `server/server.js:408`).
- Event: `INFO` (сервер эхэлсэн, `server/server.js:1553`), `ANALYSIS` / `ERROR` (AI хяналт дууссан / амжилтгүй,
  `:422-423`), `FIX` / `ERROR` (автомат засвар, `:358-359`), `ERROR` (HTTP 500, `:1512`). Ижил алдаанд ижил `summary`.
- Activity / event-д тайлангийн нэр, салбар, агуулга, хэрэглэгчийн нэр оруулахгүй; `detail`-ээс баримтын файлын
  нэрийг хасна (`:7-8`, `:25`, `:68`).
- **Даалгавар авдаггүй** (`tasks/claim` дууддаггүй) — хэрэгсэл нь Hefesto pipeline-д холбогдохгүй, хэрэглэгчид вэбээр
  ажиллуулна. Тиймээс `RESULT:` гэрээ хамаарахгүй.

## 5. Company Brain

- `agent_id = review-agent` нь 2026-10-27-нд Company Brain-д бүртгэгдсэн (`GET /agent_knowledge?agent_id=review-agent`
  → HTTP 200, `reason=certificate`).
- Агент ажиллах явцдаа Company Brain-ийг **лавладаггүй** (`context_used = false`): AI хяналтын агуулга нь зөвхөн
  оруулсан тайлан, `config/`, `prompts/`-оос бүрдэнэ. `server/`-д Company Brain руу хийх дуудлага байхгүй.

## 6. Өөрөө шалгах команд

```bash
# S-05: AI-ийн модуль ажлын урсгалыг батлахгүй — хоосон гарах ёстой
git grep -n -E "transition\(|APPROVED_FINAL" -- server/runner.js server/autofix.js server/suggest.js server/edits.js
# §3: гадагш дуудлагын газрууд — дээрх хүснэгттэй ижил байх ёстой
git grep -n -E "\bfetch\(|https?\.(request|get)\(|net\.connect|tls\.connect" -- server
# §3: Hefesto connector-ын хувьсагч — хоосон гарах ёстой
git grep -n -E "(INPUT|CONN)_[A-Z0-9_]+" -- '*.js' '*.sh'
# Тест
node --test tests/workflow.test.js tests/edits.test.js tests/autofix.test.js tests/hefesto.test.js
```

## 7. Repo-гийн хэмжээ

Repo ~1.3 MB. Хамгийн том нь `web/index.html` (~430 KB, зөвхөн хэрэглэгчийн интерфейс) — энэ spec түүнд батламж
өгөхгүй. Дээрх шаардлагууд `server/*.js`, `.gitignore`, `agent.json`-оор нотлогдоно.
