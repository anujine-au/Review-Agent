'use strict';
/*
  Ажлын урсгал (бизнесийн төлөв) — state.status (AI-ийн гүйцэтгэл)-ээс тусдаа.
    DRAFT ─хянуулах→ SUBMITTED ─захирал «AI хянуулах»→ AI дуусав→ CAE_REVIEW ─батлаад илгээх→ RETURNED ─засаад дахин→ RESUBMITTED ─AI→ CAE_REVIEW …
    CAE_REVIEW ─эцэслэн батлах→ APPROVED_FINAL (түгжинэ);  аль ч (эцсийнхээс бусад) → CANCELLED
  Төлөв зөвхөн ROOT job-ийн job.json.workflow-д хадгалагдана; дахин хяналтын job-ууд (parent_id) нь хувилбар v2, v3…
  Хувилбар v{n} = C{n} = гинжийн n дэх job (root = v1).
  Илгээхэд AI шууд ажиллахгүй: job.json.awaiting_ai = true (AI төлөв «pending»); захирал «AI хянуулах» дарахад queued болно (2026-10-13).

  Хуучин job (workflow талбаргүй): уншихдаа тооцоолно — finalized → APPROVED_FINAL, сүүлийн хувилбар done → CAE_REVIEW,
  ажиллаж байгаа → SUBMITTED / RESUBMITTED, эс бөгөөс DRAFT. Файлыг өөрчлөхгүй (эхний шилжилтээр бичигдэнэ).

  Feedback: release хийх агшинд jobs/<root>/feedback/feedback_v{n}.json-д ЦАРЦААНА (token-той хэлбэрээр).
  Түүнээс хойших шийдвэрийн өөрчлөлт тухайн feedback-д нөлөөлөхгүй.
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const S = require('./standard');

const STATES = ['DRAFT', 'SUBMITTED', 'CAE_REVIEW', 'RETURNED', 'RESUBMITTED', 'APPROVED_FINAL', 'CANCELLED'];
const LABEL = {
  DRAFT: 'Ноорог', SUBMITTED: 'Захирлын хяналтад', CAE_REVIEW: 'Захирлын хяналтад', RETURNED: 'Засварт буцаасан',
  RESUBMITTED: 'Захирлын хяналтад (засвар)', APPROVED_FINAL: 'Эцэслэн батлагдсан', CANCELLED: 'Цуцалсан',
};
// Зөвшөөрөгдсөн шилжилт (CANCELLED-ийг тусад нь)
const EDGES = { DRAFT: ['SUBMITTED'], SUBMITTED: ['CAE_REVIEW'], CAE_REVIEW: ['RETURNED', 'APPROVED_FINAL'], RETURNED: ['RESUBMITTED'], RESUBMITTED: ['CAE_REVIEW'] };
const AI_RUNNING = ['queued', 'extracting', 'running'];
// AI-г захирал эхлүүлэх боломжтой төлөв: илгээгдээд хүлээж буй, эсвэл тасарсан
const AI_STARTABLE = ['pending', 'failed', 'cancelled'];

const jobsDir = () => C.PATHS.jobs;
const jdir = id => path.join(jobsDir(), id);
const meta = id => C.readJson(path.join(jdir(id), 'job.json')) || {};
const isJobId = id => /^\d{8}-\d{6}-[a-z0-9]{6}$/.test(id);

/** AI-ийн гүйцэтгэлийн төлөв (server.jobStatus-тэй ижил дүрэм) */
function aiStatus(id) {
  const st = C.readJson(path.join(jdir(id), 'state.json'));
  if (st && st.status) return st.status;
  const j = meta(id);
  return j.queued ? 'queued' : j.awaiting_ai ? 'pending' : 'draft';
}
const rootOf = id => meta(id).parent_id || id;
/** Гинж: [root, дахин хяналт 1, 2, …] — round-оор эрэмбэлсэн */
function chain(rootId) {
  const kids = fs.readdirSync(jobsDir()).filter(x => isJobId(x) && x !== rootId && meta(x).parent_id === rootId)
    .sort((a, b) => (meta(a).round || 0) - (meta(b).round || 0));
  return [rootId, ...kids];
}
/** Илгээгдсэн (draft биш) хувилбарууд */
const versions = rootId => chain(rootId).filter(id => aiStatus(id) !== 'draft');

/** Баг: тайланг үүсгэсэн хүн + сонгосон гишүүд (root дээр) */
function teamOf(rootId) {
  const j = meta(rootId);
  return [...new Set([j.created_by, ...(Array.isArray(j.team) ? j.team : [])].filter(Boolean))];
}
const isTeam = (rootId, user) => !!user && teamOf(rootId).includes(user);

/** Тооцоолсон төлөв: { state, version, history, stored } */
function stateOf(rootId) {
  const j = meta(rootId);
  const vs = versions(rootId);
  const latest = vs[vs.length - 1];
  const wf = j.workflow;
  let state;
  if (wf && STATES.includes(wf.state)) {
    state = wf.state;
    // AI дууссан бол SUBMITTED / RESUBMITTED → CAE_REVIEW (persist-ийг sync() хийнэ)
    if ((state === 'SUBMITTED' || state === 'RESUBMITTED') && latest && aiStatus(latest) === 'done') state = 'CAE_REVIEW';
  } else if (j.finalized) state = 'APPROVED_FINAL';
  else if (!latest) state = 'DRAFT';
  else if (AI_RUNNING.includes(aiStatus(latest))) state = latest === rootId ? 'SUBMITTED' : 'RESUBMITTED';
  else if (aiStatus(latest) === 'done') state = 'CAE_REVIEW';
  else state = latest === rootId ? 'SUBMITTED' : 'RESUBMITTED';   // failed / cancelled — AI дахин ажиллуулах хүлээгдэж байна
  return { state, label: LABEL[state], version: vs.length, history: (wf && wf.history) || [], stored: !!wf, latest: latest || null,
    latest_ai: latest ? aiStatus(latest) : null, released: releasedVersions(rootId) };
}

let auditHook = () => {};
/** server.js-ээс audit log-ийг холбоно */
function setAudit(fn) { auditHook = fn; }

function write(rootId, wf) {
  const f = path.join(jdir(rootId), 'job.json');
  C.writeJson(f, { ...(C.readJson(f) || {}), workflow: wf });
}

/** Шилжилт — буруу бол { error, code: 409 } */
function transition(rootId, to, { by = 'system', role = 'system', note = '', version } = {}) {
  const cur = stateOf(rootId);
  const from = cur.state;
  const ok = to === 'CANCELLED' ? !['APPROVED_FINAL', 'CANCELLED'].includes(from) : (EDGES[from] || []).includes(to);
  if (!ok) return { error: `«${LABEL[from]}» төлөвөөс «${LABEL[to]}» руу шилжих боломжгүй`, code: 409, from };
  const hist = [...cur.history];
  // Хуучин (workflow-гүй) job-ийн эхний бичилт: тооцоолсон төлөвийг түүхэнд тэмдэглэнэ
  if (!cur.stored) hist.push({ from: null, to: from, by: 'system', role: 'system', at: C.nowIso(), note: 'анхны төлөв' });
  const v = version ?? (to === 'RETURNED' ? cur.version : to === 'RESUBMITTED' || to === 'SUBMITTED' ? cur.version + 1 : cur.version);
  const ev = { from, to, by, role, at: C.nowIso(), version: v, ...(note ? { note: String(note).slice(0, 2000) } : {}) };
  hist.push(ev);
  write(rootId, { state: to, version: v, history: hist });
  auditHook('workflow.transition', { job: rootId, from, to, version: v, user: by, role, ...(note ? { note: String(note).slice(0, 300) } : {}) });
  return { ok: true, from, to, version: v };
}

/** AI дууссаныг (SUBMITTED/RESUBMITTED → CAE_REVIEW) хадгална. Шилжсэн бол true */
function sync(rootId) {
  const j = meta(rootId), wf = j.workflow;
  if (!wf || !['SUBMITTED', 'RESUBMITTED'].includes(wf.state)) return false;
  const st = stateOf(rootId);
  if (st.state !== 'CAE_REVIEW') return false;
  return !!transition(rootId, 'CAE_REVIEW', { by: 'system', role: 'system', version: st.version }).ok;
}

/* ---------- Feedback (release) ---------- */
const fbDir = rootId => path.join(jdir(rootId), 'feedback');
const fbFile = (rootId, n) => path.join(fbDir(rootId), `feedback_v${n}.json`);
function releasedVersions(rootId) {
  const d = fbDir(rootId);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map(f => (f.match(/^feedback_v(\d+)\.json$/) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}
const readFeedback = (rootId, n) => C.readJson(fbFile(rootId, n));
const latestFeedback = rootId => { const r = releasedVersions(rootId); return r.length ? readFeedback(rootId, r[r.length - 1]) : null; };

const decOf = d => { const v = String(d?.decision || '').toUpperCase(); return v === 'ACCEPTED' ? 'APPROVED' : v; };
// Аудиторт очих талбарууд (хэрэглэгчийн шийдвэр 2026-10-12: rule ID, модуль, confidence-ийг ч харуулна)
function fbItem(it, sv, dec) {
  const edited = decOf(dec) === 'EDITED' && dec.edited_text;
  return { id: it.id, severity: S.normSeverity(it.severity, sv), module: S.moduleOf(it), rule: it.rule || '', confidence: it.confidence || '',
    title: it.title || '', issue: it.issue || '', why_it_matters: it.why_it_matters || '', required_action: edited ? dec.edited_text : (it.required_action || ''),
    edited: !!edited, anchor: it.anchor ?? null, quote: it.quote || '', suggested_text: it.suggested_text || '', source: it.source || '', origin: it.origin || 'llm', resolution_check: it.resolution_check || '' };
}

/**
 * Release-д бэлтгэх: { items, excluded, undecided, version, job }
 * v1: анхны review-ийн APPROVED / EDITED санал (MAN-xxx автоматаар APPROVED).
 * v≥2: өмнөх feedback-ийн засагдаагүй (RESOLVED / NOT_APPLICABLE-аас бусад) мөр + шинэ саналын APPROVED / EDITED;
 *      захирал засагдаагүй мөрийг REJECTED болговол энэ удаа буцаахгүй.
 */
function draftFeedback(rootId) {
  const vs = versions(rootId), n = vs.length, jobId = vs[n - 1];
  if (!jobId) return { error: 'Илгээсэн хувилбар алга' };
  const out = path.join(jdir(jobId), 'sandbox', 'output');
  const dec = S.normDecisions(C.readJson(path.join(jdir(jobId), 'decisions.json')) || {});
  const items = [], excluded = [], undecided = [];
  const take = (it, sv, required) => {
    const d = dec[it.id], v = decOf(d);
    if (v === 'APPROVED' || v === 'EDITED') items.push(fbItem(it, sv, d));
    else if (v === 'REJECTED') excluded.push(it.id);
    else if (required) undecided.push(it.id);
    else items.push(fbItem(it, sv, null));
  };
  if (n === 1) {
    const f = C.readJson(path.join(out, 'review_findings.json'));
    if (!f) return { error: 'Review-ийн үр дүн алга' };
    for (const it of f.issues || []) take(it, f.schema_version, true);
  } else {
    const rc = C.readJson(path.join(out, 'recheck.json'));
    if (!rc) return { error: 'Дахин хяналтын үр дүн алга' };
    const prev = new Map(((latestFeedback(rootId) || {}).items || []).map(x => [x.id, x]));
    for (const r of rc.items || []) {
      const st = S.normRecheckStatus(r.status);
      if (st === 'RESOLVED' || st === 'NOT_APPLICABLE') continue;
      const p = prev.get(r.id) || { id: r.id, severity: 'R3', title: r.id };
      take({ ...p, anchor: r.anchor ?? p.anchor, quote: r.quote || p.quote }, 3, false);
      const last = items[items.length - 1];
      if (last && last.id === r.id) Object.assign(last, { recheck_status: st, recheck_note: r.note || '' });
    }
    for (const it of rc.new_issues || []) take({ ...it, is_new: true }, 3, true);
    const f = C.readJson(path.join(out, 'review_findings.json'));   // гараар нэмсэн тэмдэглэл (байвал)
    for (const it of (f?.issues || []).filter(x => x.origin === 'manual')) take(it, f.schema_version, true);
  }
  items.sort((a, b) => (S.SEV_RANK[a.severity] ?? 9) - (S.SEV_RANK[b.severity] ?? 9));
  return { version: n, job: jobId, items, excluded, undecided };
}

/** Feedback-ийг царцааж хадгална (буцааж бичихгүй — давхардвал алдаа) */
function freezeFeedback(rootId, draft, { by, role }) {
  const f = fbFile(rootId, draft.version);
  if (fs.existsSync(f)) return { error: `v${draft.version}-ийн feedback аль хэдийн илгээгдсэн`, code: 409 };
  fs.mkdirSync(fbDir(rootId), { recursive: true });
  const doc = { version: draft.version, job: draft.job, released_at: C.nowIso(), released_by: by, role, counts: { sent: draft.items.length, excluded: draft.excluded.length },
    items: draft.items };
  C.writeJson(f, doc);
  return { ok: true, file: path.basename(f), doc };
}

/* ---------- Харагдах байдал ---------- */
/**
 * Хэрэглэгч энэ job-ийн AI-ийн дотоод үр дүн (санал, verdict, R-тоо, шийдвэр, events, review_report, экспорт)-ийг харах эсэх.
 * Захирал / хянагч / админ / удирдлага — тийм; аудитор, ахлах аудитор — ҮГҮЙ (зөвхөн release хийсэн feedback-ийг харна).
 */
function seesInternals(session, can) { return can(session.role, 'issue.viewAll'); }
/** Багийн гишүүнд харуулах job-ийн товч (AI-ийн мэдээлэлгүй) */
function restrictJob(o) {
  const keep = ['id', 'created', 'created_by', 'audit', 'status', 'mask', 'cycle_no', 'parent_id', 'round', 'finalized', 'files', 'started', 'finished',
    'inputs_purged', 'originals', 'has_document', 'workflow', 'team', 'rechecks', 'parent', 'error', 'can', 'root_id'];
  const r = {};
  for (const k of keep) if (o[k] !== undefined) r[k] = o[k];
  if (r.finalized) r.finalized = { reg_no: o.finalized.reg_no, approved_at: o.finalized.approved_at };
  if (Array.isArray(r.rechecks)) r.rechecks = r.rechecks.map(restrictJob);
  // AI алдааны дотоод мэдээлэл биш, ерөнхий тайлбар л
  if (r.error) r.error = 'Хяналт тасалдсан — захиралд хандана уу';
  r.restricted = true;
  return r;
}

/* ---------- Хувилбар хоорондын ялгаа (догол мөрийн түвшинд, зөвхөн захиралд) ---------- */
function blocksText(jobId) {
  const d = C.readJson(path.join(jdir(jobId), 'doc.json'));
  if (!d) return null;
  return (d.blocks || []).map(b => ({ id: b.id, t: (b.kind === 'table' ? (b.rows || []).map(r => (r || []).join(' | ')).join('\n') : (b.text || '')).replace(/\s+/g, ' ').trim() }))
    .filter(b => b.t);
}
function diff(fromJob, toJob) {
  const a = blocksText(fromJob), b = blocksText(toJob);
  if (!a || !b) return { error: 'Тайлангийн бичвэр (doc.json) хадгалагдаагүй хувилбар байна' };
  const n = a.length, m = b.length;
  if (n * m > 4e6) return { error: 'Тайлан хэт урт — ялгааг тооцох боломжгүй' };
  // LCS (догол мөрөөр)
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i].t === b[j].t ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0, same = 0;
  const flush = () => { if (same) { ops.push({ op: 'same', n: same }); same = 0; } };
  while (i < n && j < m) {
    if (a[i].t === b[j].t) { same++; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { flush(); ops.push({ op: 'del', from: a[i].id, text: a[i].t }); i++; }
    else { flush(); ops.push({ op: 'add', to: b[j].id, text: b[j].t }); j++; }
  }
  while (i < n) { flush(); ops.push({ op: 'del', from: a[i].id, text: a[i].t }); i++; }
  while (j < m) { flush(); ops.push({ op: 'add', to: b[j].id, text: b[j].t }); j++; }
  flush();
  return { ops, added: ops.filter(o => o.op === 'add').length, removed: ops.filter(o => o.op === 'del').length };
}

module.exports = {
  STATES, LABEL, AI_STARTABLE, rootOf, chain, versions, teamOf, isTeam, stateOf, transition, sync, setAudit, aiStatus,
  draftFeedback, freezeFeedback, readFeedback, latestFeedback, releasedVersions, seesInternals, restrictJob, diff,
};
