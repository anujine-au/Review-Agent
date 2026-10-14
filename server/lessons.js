'use strict';
/*
  Захирлын өмнөх шийдвэрээс суралцах (сургамжийн сан).
  Бусад тайлангийн review дээр захирлын хийсэн:
    REJECTED — AI-ийн саналыг татгалзсан  → ийм санал дахин бүү гарга
    EDITED   — засварыг өөрөөр бичсэн      → захирлын бичсэн хэв маягаар бич
    MANUAL   — AI-ийн алгассаныг гараар нэмсэн → энэ тайланд ийм асуудал байгаа эсэхийг шалга
  гэсэн дохиог review бүрийн өмнө шууд цуглуулна (тусдаа хадгалалтгүй — шийдвэр өөрчлөгдвөл дараагийн review-д шууд тусна).
  Хувийн мэдээлэл: token ([PERSON-0001] …) нь тайлан бүрт өөр утгатай тул бүрэн хасна; ишлэл (quote) огт дамжуулахгүй.
  Сургамж нь нотолгоо биш — AI энэ тайлангийн нотолгоо, ишлэлгүйгээр санал гаргахгүй; захирал review дээр өөрөө хянана.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./common');
const S = require('./standard');

const MAX_PER_KIND = 30;
const LIM = 300;

const clean = s => String(s || '').replace(C.TOKEN_RE, '[…]').replace(/\s+/g, ' ').trim().slice(0, LIM);
const keyOf = (kind, rule, title) => `${kind}|${rule || ''}|${C.normTitle(title).toLowerCase()}`;
const idOf = key => 'L-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 6).toUpperCase();

function jobIssues(dir) {
  const out = path.join(dir, 'sandbox', 'output');
  const f = C.readJson(path.join(out, 'review_findings.json'));
  const rc = C.readJson(path.join(out, 'recheck.json'));
  return [...(Array.isArray(f?.issues) ? f.issues : []), ...(Array.isArray(rc?.new_issues) ? rc.new_issues : [])];
}

/**
 * Бүх job-оос сургамж цуглуулна. excludeDir — одоо шалгаж буй job (өөрөөсөө суралцахгүй).
 * Буцаах: [{ id, kind, rule, module, title, issue?, before?, after?, times, last_at }]
 */
function collect({ jobsDir = C.PATHS.jobs, excludeDir = null } = {}) {
  const byKey = new Map();
  const add = (kind, it, extra, at) => {
    const title = clean(it.title || it.issue);
    if (!title) return;
    const k = keyOf(kind, it.rule, title);
    const cur = byKey.get(k);
    if (cur) { cur.times++; if (String(at || '') > String(cur.last_at || '')) Object.assign(cur, extra, { last_at: at || cur.last_at }); return; }
    byKey.set(k, { id: idOf(k), kind, rule: it.rule || '', module: S.moduleOf(it) || '', title, ...extra, times: 1, last_at: at || '' });
  };
  let names = [];
  try { names = fs.readdirSync(jobsDir); } catch { return []; }
  const skip = excludeDir ? path.resolve(excludeDir) : null;
  for (const name of names) {
    if (name.startsWith('_')) continue;
    const dir = path.join(jobsDir, name);
    if (skip && path.resolve(dir) === skip) continue;
    if (!fs.existsSync(path.join(dir, 'job.json'))) continue;
    const issues = jobIssues(dir);
    if (!issues.length) continue;
    const dec = S.normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {});
    for (const it of issues) {
      if (it.origin === 'manual') {
        add('MANUAL', it, { issue: clean(it.issue), required_action: clean(it.required_action) }, it.created_at);
        continue;
      }
      if (it.origin === 'rule_engine') continue;   // кодоор шалгадаг — AI-д сургамж болохгүй
      const d = dec[it.id];
      if (!d) continue;
      if (d.decision === 'REJECTED') add('REJECTED', it, { issue: clean(it.issue) }, d.at);
      else if (d.decision === 'EDITED' && d.edited_text) {
        const before = clean(it.required_action), after = clean(d.edited_text);
        if (before !== after) add('EDITED', it, { before, after }, d.at);
      }
    }
  }
  const all = [...byKey.values()];
  const out = [];
  for (const kind of ['REJECTED', 'EDITED', 'MANUAL']) {
    out.push(...all.filter(l => l.kind === kind)
      .sort((a, b) => b.times - a.times || String(b.last_at).localeCompare(String(a.last_at))).slice(0, MAX_PER_KIND));
  }
  return out;
}

/** Агентын бичсэн lesson_refs / lessons_applied-ийг өгөгдсөн сургамжаар шүүж, дэлгэцэнд харуулах дэлгэрэнгүйг хавсаргана */
function attach(f, lessons) {
  const byId = new Map((lessons || []).map(l => [l.id, l]));
  const used = new Set();
  for (const it of f.issues || []) {
    if (!Array.isArray(it.lesson_refs)) { delete it.lesson_refs; continue; }
    it.lesson_refs = [...new Set(it.lesson_refs.map(String))].filter(id => byId.has(id));
    if (!it.lesson_refs.length) delete it.lesson_refs; else it.lesson_refs.forEach(id => used.add(id));
  }
  const EFFECTS = ['suppressed', 'raised', 'reworded'];
  const applied = (Array.isArray(f.lessons_applied) ? f.lessons_applied : [])
    .filter(a => a && byId.has(String(a.lesson_id)))
    .map(a => ({ lesson_id: String(a.lesson_id), effect: EFFECTS.includes(a.effect) ? a.effect : 'raised', note: String(a.note || '').slice(0, 300) }));
  for (const id of used) if (!applied.some(a => a.lesson_id === id)) applied.push({ lesson_id: id, effect: 'raised', note: '' });
  applied.forEach(a => used.add(a.lesson_id));
  f.lessons_applied = applied.map(a => ({ ...a, issue_ids: (f.issues || []).filter(it => (it.lesson_refs || []).includes(a.lesson_id)).map(it => it.id) }));
  f.lessons_used = [...used].map(id => byId.get(id));
  f.lessons_available = (lessons || []).length;
  return { available: f.lessons_available, applied: f.lessons_applied.length };
}

module.exports = { collect, attach };
