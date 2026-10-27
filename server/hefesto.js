'use strict';
/*
  Hefesto телеметр (гадаад агент, 2026-09-24 заавар §2.1, §2.4): heartbeat + activity, event тайлан.
  - Идэвхжих нөхцөл: HEFESTO_BOT_TOKEN орчинд байх (systemd drop-in). HEFESTO_API анхдагч нь https://hefesto.netcapital.mn/api/v1.
  - Token-ийг ачаалахдаа process.env-ээс хасна — Claude CLI зэрэг дэд процесст (AI sandbox) дамжихгүй.
  - Ажиглагч: Hefesto унтарсан, сүлжээ тасарсан ч хяналт тасрахгүй — бүх алдааг энд залгина.
  - Оффис бүх ажилтанд харагддаг тул activity / event-д тайлангийн нэр, салбар, агуулга, хэрэглэгчийн нэр ОРУУЛАХГҮЙ —
    зөвхөн юу болсон, job-ийн дугаар.
  - Даалгавар (tasks/claim) авдаггүй: хэрэгсэл нь Hefesto pipeline-д холбогддоггүй, аудиторууд вэбээр ажиллуулдаг.
  - heartbeat-ийн хариу active=false (админ зогсоосон) үед paused() = true — шинэ AI хяналт эхлүүлэхгүй.
*/

const API = (process.env.HEFESTO_API || 'https://hefesto.netcapital.mn/api/v1').replace(/\/+$/, '');
const TOKEN = process.env.HEFESTO_BOT_TOKEN || '';
delete process.env.HEFESTO_BOT_TOKEN;
delete process.env.HEFESTO_API;

const HEARTBEAT_MS = 60000, TIMEOUT_MS = 10000;
let activity = '', isPaused = false, timer = null;

const enabled = () => !!TOKEN;
const paused = () => isPaused;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Алдааны мессежээс баримтын файлын нэр, замыг (тайлан, салбарын нэр агуулж болно) хасна; кодын зам (stack) үлдэнэ
const scrub = s => String(s || '').replace(/[^\s'"`()<>]+\.(?:docx?|xlsx?|pdf|txt|csv|png|jpe?g)\b/gi, '<file>');

async function post(p, body) {
  if (!enabled()) return null;
  try {
    const r = await fetch(API + p, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'X-Bot-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) { console.error(`hefesto ${p}: HTTP ${r.status}`); return null; }
    return r.status === 204 ? {} : await r.json().catch(() => ({}));
  } catch (e) { console.error(`hefesto ${p}: ${e.message}`); return null; }
}

async function heartbeat() {
  const r = await post('/bot-api/heartbeat', { activity });
  if (r && typeof r.active === 'boolean' && r.active === isPaused) {
    isPaused = !r.active;
    console.log(`hefesto: ${isPaused ? 'админ агентыг түр зогсоосон — шинэ AI хяналт эхлүүлэхгүй' : 'агент дахин идэвхжлээ'}`);
  }
  return r;
}

/** Серверийг асаахад нэг удаа: 60 сек тутмын heartbeat (үндсэн ажиллагаанаас тусдаа таймер) */
function start() {
  if (!enabled() || timer) return;
  timer = setInterval(() => { heartbeat(); }, HEARTBEAT_MS);
  timer.unref();
  heartbeat();
}

/** «Яг одоо юу хийж байна» — хоосон мөр = ажил дууссан. Тэр дороо heartbeat илгээнэ. */
function setActivity(text) {
  const a = clip(text, 200);
  if (a === activity) return;
  activity = a;
  heartbeat();
}

/** type: POST | REPLY | ANALYSIS | FIX | ERROR | INFO. summary — нэг өгүүлбэр (ижил алдаанд ижил хэллэг). */
function report(type, summary, detail) {
  const body = { type, summary: clip(summary, 1000) };
  if (detail) body.detail = scrub(detail).slice(0, 4000);   // мөр хадгална (stacktrace)
  return post('/bot-api/events', body);
}

module.exports = { enabled, paused, start, setActivity, report, _scrub: scrub };
