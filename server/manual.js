'use strict';
/*
  Хянагчийн гараар нэмсэн тэмдэглэл (origin: "manual").
  review_findings.json-ийн issues[]-д шууд бичнэ — ингэснээр вэб, татах (PDF/Word/Excel), Docs, дахин хяналт бүгд
  AI-ийн тэмдэглэлийн адил харна. Нэмсэн хүн өөрөө зохиосон тул шийдвэр нь автоматаар APPROVED.
  Хувийн мэдээлэл: хэрэглэгчийн бичсэн жинхэнэ нэр, дугаарыг mask_map-аар token болгож хадгална
  (файл далдлагдсан хэвээр; уншихад restoreTokens буцааж харуулна).
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const S = require('./standard');

const SEVS = ['R1', 'R2', 'R3', 'R4'];
const LIMITS = { title: 120, issue: 2000, required_action: 2000, quote: 400, why_it_matters: 1000 };

// Жинхэнэ утгыг token болгох (docs_prep.scrub-ийн token хэсэгтэй ижил дүрэм)
function tokenize(text, map, allowText) {
  const pairs = C.sensitivePairs(map, allowText);
  for (let k = 0; k < pairs.length; k += 300) {
    const chunk = pairs.slice(k, k + 300);
    const re = new RegExp(`${C.WB}(${chunk.map(([, v]) => C.stemRe(v)).join('|')})(?=${C.MN_SUFFIX}${C.WE})`, 'giu');
    text = text.replace(re, m => {
      const l = m.toLowerCase();
      const hit = chunk.find(([, v]) => v.toLowerCase() === l) || chunk.find(([, v]) => C.endsVowel(v) && v.toLowerCase().slice(0, -1) === l);
      return hit ? hit[0] : m;
    });
  }
  return text;
}

function paths(dir) {
  const out = path.join(dir, 'sandbox', 'output');
  return { f: path.join(out, 'review_findings.json'), sum: path.join(out, 'review_summary.json'), dec: path.join(dir, 'decisions.json') };
}

// Ишлэл нь тухайн догол мөрөнд (эсвэл тайланд) үгчлэн байгаа эсэх — doc.json далдлагдсан тул token-той харьцуулна
function quoteCheck(dir, anchor, quote) {
  if (!quote) return null;
  const doc = C.readJson(path.join(dir, 'doc.json'));
  if (!doc) return null;
  const norm = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const q = norm(quote);
  const textOf = b => b.kind === 'table' ? (b.rows || []).map(r => (r || []).join(' | ')).join('\n') : (b.text || '');
  const blk = String(anchor || '').toUpperCase().match(/^(P\d+|T\d+)/);
  const own = blk && (doc.blocks || []).find(b => b.id === blk[1]);
  if (own && norm(textOf(own)).includes(q)) return { status: 'exact', checked_by: 'manual' };
  return { status: 'not_found', checked_by: 'manual' };
}

/** Verdict, тоо, scorecard-ийг дахин тооцно (runner.finalizeFindings-ийн дүрмээр) */
function recompute(f, sumPath) {
  // Засварласан хувилбар (дахин хяналт): дүгнэлт нь recheck.json-оос — зөвхөн тоог шинэчилнэ, summary-г өөрчлөхгүй
  if (fs.existsSync(path.join(path.dirname(sumPath), 'recheck.json'))) {
    const c0 = S.countSev((f.issues || []).map(it => ({ severity: S.normSeverity(it.severity, f.schema_version) })));
    f.review = { ...(f.review || {}), manual_r1: c0.r1, manual_r2: c0.r2, manual_r3: c0.r3, manual_r4: c0.r4 };
    return;
  }
  // Хуучин (v1/v2) review-ийн MAJOR/MODERATE-г R1–R4 болгож тоолно (хадгалсан утгыг өөрчлөхгүй)
  const issues = (f.issues || []).map(it => ({ ...it, severity: S.normSeverity(it.severity, f.schema_version) }));
  const verdict = S.computeVerdict({ issues, escalations: Array.isArray(f.escalations) ? f.escalations : [], kbConflicts: Array.isArray(f.kb_conflicts) ? f.kb_conflicts : [],
    runRejected: f.gate0?.status === 'REJECTED' });
  const c = S.countSev(issues);
  f.review = { ...(f.review || {}), verdict, r1_count: c.r1, r2_count: c.r2, r3_count: c.r3, r4_count: c.r4 };
  if (f.scorecard) {
    // Оролт дутуугаас PARTIAL болсон модулийг хадгална
    const partial = Object.entries(f.scorecard).filter(([, v]) => v && v.status === 'PARTIAL' && !v.r1 && !v.r2).map(([k]) => k);
    const na = Object.entries(f.scorecard).filter(([, v]) => v && v.status === 'N/A').map(([k]) => k);
    f.scorecard = S.computeScorecard(issues, { partial, na, gate0Status: f.gate0?.status });
  }
  const sum = C.readJson(sumPath) || {};
  C.writeJson(sumPath, { audit: sum.audit || f.audit || {}, review: { verdict, r1_count: c.r1, r2_count: c.r2, r3_count: c.r3, r4_count: c.r4 } });
}

function sortBySev(f, list) {
  const rank = it => S.SEV_RANK[S.normSeverity(it.severity, f.schema_version)] ?? 9;
  return list.map((it, i) => [it, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

function clean(body, map, allow) {
  const v = {};
  for (const k of Object.keys(LIMITS)) if (body[k] !== undefined) v[k] = tokenize(String(body[k] || '').trim().slice(0, LIMITS[k]), map, allow);
  if (body.severity !== undefined) {
    const s = String(body.severity).toUpperCase();
    if (!SEVS.includes(s)) throw Object.assign(new Error('Зэрэглэл R1 | R2 | R3 | R4 байна'), { code: 400 });
    v.severity = s;
  }
  if (body.module !== undefined) {
    const m = String(body.module || '').toUpperCase();
    if (m && !S.MODULES.includes(m)) throw Object.assign(new Error('Модуль буруу'), { code: 400 });
    v.module = m || null;
  }
  if (body.anchor !== undefined) {
    const a = body.anchor ? String(body.anchor).toUpperCase().replace(/\s/g, '') : null;
    if (a && !/^(P\d{1,5}|T\d{1,4}(R\d{1,5})?)$/.test(a)) throw Object.assign(new Error('Байршил буруу'), { code: 400 });
    v.anchor = a;
  }
  return v;
}

// Гарчиг тусдаа оруулахгүй — «засах зүйл»-ийн эхний өгүүлбэрээс (≤ 8 үг) үүсгэнэ
function autoTitle(text) {
  const first = String(text || '').trim().split(/(?<=[.!?])\s|\n/)[0].trim();
  const w = first.split(/\s+/).filter(Boolean);
  return (w.length > 8 ? w.slice(0, 8).join(' ') + '…' : first).replace(/[.!?]$/, '').slice(0, 120);
}
// Татаж авах файлын «Засварууд» жагсаалт (required_actions)-д гараар нэмсэн тэмдэглэлийг синхрон байлгана
function syncActions(f, it, del) {
  const list = (Array.isArray(f.required_actions) ? f.required_actions : []).filter(a => !(a && a.manual_id === (it.id || it)));
  if (!del && it.required_action) {
    const pr = list.reduce((m, a) => Math.max(m, Number(a.priority) || 0), 0) + 1;
    list.push({ priority: pr, action: it.required_action, issue_ids: [it.id], manual_id: it.id, author: it.author || '' });
  }
  f.required_actions = list;
}

/** Нэмэх: { anchor, quote, severity, module, title, issue, required_action } */
function add(dir, body, who) {
  const p = paths(dir);
  // Засварласан хувилбарт review_findings.json байхгүй — гараар нэмсэн тэмдэглэлд зориулж үүсгэнэ
  const f = C.readJson(p.f) || (fs.existsSync(path.join(path.dirname(p.f), 'recheck.json')) ? { schema_version: S.SCHEMA_VERSION, manual_only: true, issues: [] } : null);
  if (!f) throw Object.assign(new Error('Review-ийн үр дүн алга'), { code: 409 });
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  const map = C.readJson(path.join(dir, 'mask_map.json')) || {};
  const allow = [job.audit?.name, job.audit?.code, job.audit?.branch].join(' ');
  const v = clean({ severity: 'R3', ...body }, map, allow);
  if (!v.required_action && !v.issue && !v.title) throw Object.assign(new Error('Засах зүйлээ бичнэ үү'), { code: 400 });
  if (!v.title) v.title = autoTitle(v.required_action || v.issue);
  f.issues = Array.isArray(f.issues) ? f.issues : [];
  const n = f.issues.filter(x => /^MAN-\d+$/.test(x.id)).map(x => +x.id.slice(4)).reduce((a, b) => Math.max(a, b), 0) + 1;
  const it = {
    id: `MAN-${String(n).padStart(3, '0')}`, origin: 'manual', severity: v.severity, module: v.module || null, rule: '', confidence: 'High', category: 'MANUAL',
    anchor: v.anchor || null, quote: v.quote || '', title: v.title, issue: v.issue || '', why_it_matters: v.why_it_matters || '', required_action: v.required_action || '',
    evidence: [], impacts: [], resolution_check: '', source: '', author: who, created_at: C.nowIso(),
  };
  it.quote_check = quoteCheck(dir, it.anchor, it.quote) || undefined;
  f.issues = sortBySev(f, [...f.issues, it]);
  syncActions(f, it);
  recompute(f, p.sum);
  C.writeJson(p.f, f);
  const dec = S.normDecisions(C.readJson(p.dec) || {});
  dec[it.id] = { decision: 'APPROVED', note: 'Хянагч гараар нэмсэн', by: who, at: C.nowIso() };
  C.writeJson(p.dec, dec);
  return { issue: it, decisions: dec };
}

function edit(dir, id, body, who) {
  const p = paths(dir), f = C.readJson(p.f);
  const it = (f?.issues || []).find(x => x.id === id && x.origin === 'manual');
  if (!it) throw Object.assign(new Error('Гараар нэмсэн тэмдэглэл олдсонгүй'), { code: 404 });
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  const v = clean(body, C.readJson(path.join(dir, 'mask_map.json')) || {}, [job.audit?.name, job.audit?.code, job.audit?.branch].join(' '));
  if (v.required_action !== undefined && !v.title) {
    if (!v.required_action && !(v.issue ?? it.issue)) throw Object.assign(new Error('Засах зүйлээ бичнэ үү'), { code: 400 });
    v.title = autoTitle(v.required_action || v.issue || it.issue);
  }
  if (v.title === '') delete v.title;
  Object.assign(it, v, { edited_by: who, edited_at: C.nowIso() });
  syncActions(f, it);
  if (v.quote !== undefined || v.anchor !== undefined) it.quote_check = quoteCheck(dir, it.anchor, it.quote) || undefined;
  f.issues = sortBySev(f, f.issues);
  recompute(f, p.sum);
  C.writeJson(p.f, f);
  return { issue: it };
}

function remove(dir, id) {
  const p = paths(dir), f = C.readJson(p.f);
  const i = (f?.issues || []).findIndex(x => x.id === id && x.origin === 'manual');
  if (i < 0) throw Object.assign(new Error('Гараар нэмсэн тэмдэглэл олдсонгүй'), { code: 404 });
  f.issues.splice(i, 1);
  syncActions(f, id, true);
  recompute(f, p.sum);
  C.writeJson(p.f, f);
  const dec = S.normDecisions(C.readJson(p.dec) || {});
  delete dec[id];
  C.writeJson(p.dec, dec);
  return { decisions: dec };
}

module.exports = { add, edit, remove, tokenize };
