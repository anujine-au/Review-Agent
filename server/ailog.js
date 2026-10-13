'use strict';
/*
  Append-only, hash-chain лог (SP-118-04/01 §6, /03 §6; DOC-1917 Хав. А.2).
    logs/ai_runs.jsonl   — AI Run Log: агентын ажиллагаа бүр (AI_Run_ID AIR-YYYY-NNNN, Source_Doc_ID, Model, Prompt_Template_ID, Rulepack, Retry_Count, токен, хугацаа, verdict, Reviewer)
    logs/audit.jsonl     — Decision / Submission / Escalation лог: захирлын шийдвэр, review эхлүүлсэн, даалгавар илгээсэн г.м.
  Мөр бүр: { seq, ts, ...payload, prev_hash, hash },  hash = sha256(prev_hash + JSON(payload мөр hash-гүйгээр)).
  Мөрийг гараар засвал verifyChain() алдаа өгнө. Файлын агуулга (тайлангийн текст) бичихгүй — зөвхөн hash, лавлагаа.
  Prompt архив: logs/prompt_archive/<Prompt_Template_ID>-<sha8>/ — ажилласан заавар, дүрмийн яг хуулбар.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./common');

const logDir = () => process.env.AR_LOGS_DIR || C.PATHS.logs;
const FILES = { ai: 'ai_runs.jsonl', audit: 'audit.jsonl' };
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function lastEntry(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

/** Мөр нэмэх (синхрон — нэг процесс тул уралдаангүй) */
function append(kind, payload) {
  const file = path.join(logDir(), FILES[kind]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const last = lastEntry(file);
  const entry = { seq: (last?.seq || 0) + 1, ts: new Date().toISOString(), ...payload };
  const prev_hash = last?.hash || 'GENESIS';
  const hash = sha256(prev_hash + JSON.stringify(entry));
  fs.appendFileSync(file, JSON.stringify({ ...entry, prev_hash, hash }) + '\n', 'utf8');
  return { ...entry, prev_hash, hash };
}

/** Гинжийг шалгах: { ok, entries, broken_at, reason } */
function verifyChain(kind) {
  const file = path.join(logDir(), FILES[kind]);
  if (!fs.existsSync(file)) return { ok: true, entries: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let prev = 'GENESIS';
  for (let i = 0; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { return { ok: false, entries: lines.length, broken_at: i + 1, reason: 'JSON эвдэрсэн' }; }
    const { prev_hash, hash, ...entry } = row;
    if (prev_hash !== prev) return { ok: false, entries: lines.length, broken_at: i + 1, reason: 'prev_hash таарахгүй (мөр устсан/нэмэгдсэн)' };
    if (sha256(prev + JSON.stringify(entry)) !== hash) return { ok: false, entries: lines.length, broken_at: i + 1, reason: 'hash таарахгүй (мөр өөрчлөгдсөн)' };
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}

/** AI_Run_ID: AIR-YYYY-NNNN (жил бүр 0001-ээс) — ai_runs.jsonl болон нөөцлөгдсөн дугаараас */
function nextRunId() {
  const year = new Date().getFullYear();
  const counter = path.join(logDir(), 'ai_run_counter.json');
  const c = C.readJson(counter) || {};
  const n = (c[year] || 0) + 1;
  c[year] = n;
  fs.mkdirSync(logDir(), { recursive: true });
  C.writeJson(counter, c);
  return `AIR-${year}-${String(n).padStart(4, '0')}`;
}

/** Ажилласан prompt, дүрмийн хуулбарыг архивлана (DOC-1917 — prompt архив). Буцаах: { dir, sha } */
function archivePrompts(templateId, files) {
  const h = crypto.createHash('sha256');
  const items = files.filter(f => fs.existsSync(f)).sort();
  for (const f of items) h.update(path.basename(f) + '\0' + fs.readFileSync(f));
  const sha = h.digest('hex');
  const dir = path.join(logDir(), 'prompt_archive', `${templateId}-${sha.slice(0, 8)}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of items) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
  return { dir, sha };
}

function fileSha256(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

function readAll(kind, { limit = 500 } = {}) {
  const file = path.join(logDir(), FILES[kind]);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = { append, verifyChain, nextRunId, archivePrompts, fileSha256, readAll, sha256 };

if (require.main === module) {
  for (const k of Object.keys(FILES)) console.log(k, JSON.stringify(verifyChain(k)));
}
