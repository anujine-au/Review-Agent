# Аудитын тайлан хянагч агент — хэрэгжүүлэлтийн төлөвлөгөө

`hefesto-spec.md` нь **ЮУ**-г (шаардлага, нотолгоо), энэ баримт **ЯАЖ**-ыг заана. Шаардлагын дэлгэрэнгүйг
энд давхардуулахгүй — `S-xx` дугаараар заана.

## 1. Процесс асах дараалал (`server/server.js`)

1. Модулиуд ачаална; `server/hefesto.js` ачаалахдаа `HEFESTO_BOT_TOKEN`-ийг орчноос аваад `process.env`-ээс хасна.
2. Хуучин job-уудыг шалгаж, ишлэлийн шалгалтгүй review-г нэг удаа шалгана.
3. `--lan` бол TLS сертификат ачаалж HTTPS (TLS ≥ 1.2), эс бөгөөс зөвхөн localhost (`127.0.0.1`, `::1`) дээр HTTP-ээр сонсоно.
4. `banner()`: access log-д `SERVER_START`, Hefesto идэвхтэй бол heartbeat таймер + `INFO` event (spec §4).
5. Таймер: 3 сек тутам `startNext()` (AI дараалал, S-13), 10 мин тутам `housekeeping()` (хадгалах хугацаа).

## 2. Ажил гүйцэтгэгдэх урсгал

1. **Оруулах** — аудитор вэбээр файл / линк оруулна (`POST /api/jobs`) → job `DRAFT`, илгээхэд `SUBMITTED`,
   `awaiting_ai = true` (S-01, S-02). «Өөрөө шалгах» (`precheck`) нь тусдаа job, урсгалд ордоггүй.
2. **AI эхлүүлэх** — захирал «AI хянуулах» (`POST /api/jobs/<id>/ai-review`) → `queued`.
3. **Гүйцэтгэх** (`server/runner.js` `runJob`):
   1. `server/extract.js` файлуудыг текст болгож, хувийн мэдээллийг token-оор далдална (S-07) → `sandbox/extracted/`.
   2. `server/rules.js` детерминист шалгуур (Gate 0 + D шалгуур) → `sandbox/facts/`.
   3. Өмнөх feedback (дахин хяналт), захирлын сургамж (`server/lessons.js`), RPT-175 (`server/followup.js`)-ыг хавсаргана.
   4. `claude` CLI-г хязгаарлагдмал горимоор `sandbox/`-д ажиллуулна (S-08) → `sandbox/output/`.
   5. Ишлэлийн шалгалт (`server/verify.js`, S-10), verdict / scorecard-ийг `server/standard.js`-ээр дахин тооцно (S-06).
   6. AI Run Log (`server/ailog.js`, S-14); эх файлыг `originals/`-д шилжүүлнэ.
4. **Захирлын хяналт** — `CAE_REVIEW`: санал бүрийг шийдвэрлэнэ; «Батлаад илгээх» (release) → feedback царцаж,
   `RETURNED` (S-03, S-04). Release үед `server/autofix.js` засварын төслийг бэлтгэнэ (S-11, S-12).
5. **Засвар** — аудитор `working.docx`-оор засаад дахин илгээнэ → `RESUBMITTED` → 2-р алхам (M14 дахин хяналт).
6. **Эцэслэх** — захирал `APPROVED_FINAL` болгоно; эцсийн тайлан `server/final.js`.

Ажиллаж дуусахад Hefesto-д `ANALYSIS` эсвэл `ERROR` event илгээнэ (spec §4).

## 3. Шинэ шалгуур / ажил нэмэх алхам

1. Детерминист шалгуур бол `server/rules.js`-д, AI шалгуур бол `prompts/system_prompt.md` / `config/*.md`-д нэмнэ.
2. Зэрэглэл, verdict-д нөлөөлөх бол `server/standard.js`.
3. Шинэ гадагш холболт, бичих газар нэмбэл **`hefesto-spec.md` §3-ыг заавал шинэчилнэ**.
4. Тест нэмж, spec §6-ийн командуудыг ажиллуулна.

## 4. Деплой

- Сервер: Linux, systemd `--user` сервис `review-agent` (`deploy/review-agent.service`), port 8443, `--lan`.
- Нууц утга: `deploy/env` (git-гүй) ба systemd drop-in (`review-agent.service.d/*.conf`) — `HEFESTO_BOT_TOKEN`,
  Claude-ийн нэвтрэлт.
- Шинэчлэх: `git push` → сервер дээр `./update.sh` (ажиллаж буй review байвал зогсоно, health check, `--rollback`).
- Hefesto: push хийсний дараа агентын хуудсанд **Redeploy** (commit царцаана) → «Дахин шалгуулах».
