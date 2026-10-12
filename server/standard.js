'use strict';
/*
  SP-118-04 стандартын тогтмол ба детерминист логик (SP-118-04/02 §7, /03 §8.6):
  зэрэглэл R1–R4, verdict, scorecard, санал ID (RV-<EngID>-C<n>-NNN), хуучин (v1/v2) review-г хөрвүүлэх.
  LLM verdict-ийг шууд хэрэглэхгүй — үргэлж энд дахин тооцно.
*/

const API_VERSION = 'v1';
const RULEPACK = 'RP-SP11804-v1.0';
const PROMPT_TEMPLATE_ID = 'PT-SP11804-SYS-v1.0';
const RECHECK_TEMPLATE_ID = 'PT-SP11804-M14-v1.0';
const SCHEMA_VERSION = 3;

const SEVERITIES = ['R1', 'R2', 'R3', 'R4'];
const SEV_RANK = { R1: 0, R2: 1, R3: 2, R4: 3 };
const MODULES = ['G0', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'M13', 'M14'];
const MODULE_NAMES = {
  G0: 'Оролтын бүрэн байдал', M01: 'Бүтэц ба бүрдэл', M02: 'Зорилго ба хамрах хүрээ', M03: '5C бүрэн байдал',
  M04: 'Зэрэглэлийн калибровк', M05: 'Тоон нийцэл', M06: 'Нотолгоо ба мөшгөх чадвар', M07: 'Нийцлийн эрсдэл',
  M08: 'Зөвлөмжийн чанар', M09: 'Удирдлагын хариу', M10: 'Follow-up ба хамаарал', M11: 'Хэл найруулга, формат',
  M12: 'Кодчлол, хувилбар, нууцлал', M13: 'Нэмэлт логик (AI-INSIGHT)', M14: 'Хувилбарын харьцуулалт',
};
const VERDICTS = ['READY', 'READY_WITH_FIXES', 'NOT_READY', 'ESCALATE', 'RUN_REJECTED'];
const ESCALATE_TYPES = new Set(['AML_24H', 'CYBER_1H', 'COI']);
const ESCALATE_RULES = new Set(['M07-03', 'M07-04', 'M07-05']);

/** Хуучин зэрэглэлийг R1–R4 болгох. v2: MAJOR→R1, MODERATE→R2, MINOR→R3; v1: CRITICAL→R1, MAJOR→R2, MINOR→R3 */
function normSeverity(s, schemaVersion) {
  const v = String(s || '').toUpperCase().trim();
  if (/^R[1-4]/.test(v)) return v.slice(0, 2);
  if (v.startsWith('BLOCK')) return 'R1';
  if (v.startsWith('SUGG')) return 'R4';
  if (Number(schemaVersion) >= 2) return v.startsWith('MAJ') ? 'R1' : v.startsWith('MOD') ? 'R2' : 'R3';
  return v.startsWith('CRIT') ? 'R1' : v.startsWith('MAJ') ? 'R2' : 'R3';
}

const LEGACY_DECISION = {
  'Батлахад бэлэн': 'READY', 'Бага засвартай батлах': 'READY_WITH_FIXES', 'Засвартай батлах': 'READY_WITH_FIXES', 'Буцааж засварлуулах': 'NOT_READY',
};
function legacyVerdict(decision) {
  const d = String(decision || '').trim();
  if (VERDICTS.includes(d)) return d;
  if (/^REVIEW CANNOT START/i.test(d)) return 'RUN_REJECTED';
  return LEGACY_DECISION[d] || null;
}

/** Модулийг rule ID-аас гаргах ("M05-01" → "M05", "AI-INSIGHT" → "M13", хуучин блок кодууд → ойролцоо модуль) */
const LEGACY_BLOCK_MODULE = { A: 'M01', B: 'M03', C: 'M04', D: 'M06', E: 'M05', F: 'M09', G: 'M08', H: 'M07', I: 'M13', J: 'M11', K: 'M12', L: 'M02' };
function moduleOf(issue) {
  const m = String(issue.module || '').toUpperCase().match(/^(G0|M\d{2})$/);
  if (m) return m[1];
  const r = String(issue.rule || '').toUpperCase();
  const k = r.match(/^(G0|M\d{2})-/);
  if (k) return k[1];
  if (/AI-?INSIGHT/.test(r)) return 'M13';
  const b = r.match(/^([A-L])\d/);
  return b ? LEGACY_BLOCK_MODULE[b[1]] : 'M13';
}

function countSev(issues) {
  const c = { r1: 0, r2: 0, r3: 0, r4: 0 };
  for (const it of issues || []) { const k = String(it.severity || '').toLowerCase(); if (c[k] !== undefined) c[k]++; }
  return c;
}

/** SP-118-04/02 §7 — дарааллаар: RUN_REJECTED → ESCALATE → NOT_READY → READY_WITH_FIXES → READY */
function computeVerdict({ issues = [], escalations = [], kbConflicts = [], runRejected = false }) {
  if (runRejected) return 'RUN_REJECTED';
  const esc = issues.some(it => ESCALATE_RULES.has(String(it.rule || '').toUpperCase()))
    || escalations.some(e => ESCALATE_TYPES.has(String(e.type || '').toUpperCase()))
    || kbConflicts.some(k => k && k.affects_conclusion === true);
  if (esc) return 'ESCALATE';
  const c = countSev(issues);
  if (c.r1 >= 1 || c.r2 > 3) return 'NOT_READY';
  if (c.r2 >= 1) return 'READY_WITH_FIXES';
  return 'READY';
}

/** Модуль тус бүрийн төлөв: FAIL (R1) / PARTIAL (R2 эсвэл оролт дутуу) / PASS / N/A */
function computeScorecard(issues, { partial = [], na = [], gate0Status } = {}) {
  const sc = {};
  for (const mod of MODULES) {
    const mine = issues.filter(it => moduleOf(it) === mod);
    const c = countSev(mine);
    let status = c.r1 ? 'FAIL' : (c.r2 || partial.includes(mod)) ? 'PARTIAL' : 'PASS';
    if (na.includes(mod) && !mine.length) status = 'N/A';
    if (mod === 'G0' && gate0Status === 'REJECTED') status = 'FAIL';
    else if (mod === 'G0' && gate0Status === 'PARTIAL' && status === 'PASS') status = 'PARTIAL';
    sc[mod] = { status, ...c };
  }
  return sc;
}

/** Engagement ID-г санал ID-д хэрэглэх хэлбэрт (латин том үсэг, тоо, зураас) */
function engKey(audit, jobId) {
  const raw = String(audit?.code || '').toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (raw && raw.length <= 22 ? raw : String(jobId || 'X').replace(/^(\d{8})-\d{6}-/, '$1-').toUpperCase()).slice(0, 22);
}
const rvId = (eng, cycle, n) => `RV-${eng}-C${cycle}-${String(n).padStart(3, '0')}`;

/** Бүх саналд RV ID өгч, бусад талбар дахь лавлагааг (issue_ids г.м.) хамт солино */
function assignIds(findings, eng, cycle, { start = 1, list = 'issues' } = {}) {
  const map = new Map();
  let n = start;
  for (const it of findings[list] || []) {
    const old = it.id;
    it.id = rvId(eng, cycle, n++);
    if (old && !map.has(old)) map.set(old, it.id);
  }
  const fix = arr => Array.isArray(arr) ? arr.map(x => map.get(x) || x) : arr;
  for (const key of ['required_actions', 'program_coverage', 'followup_check']) {
    for (const row of findings[key] || []) if (row && row.issue_ids) row.issue_ids = fix(row.issue_ids);
  }
  return n;
}

function sortIssues(issues) {
  return issues.map((it, i) => [it, i]).sort((a, b) => (SEV_RANK[a[0].severity] ?? 9) - (SEV_RANK[b[0].severity] ?? 9) || a[1] - b[1]).map(x => x[0]);
}

/** Захирлын шийдвэр: хуучин accepted/rejected-ийг APPROVED/REJECTED болгоно */
const DECISIONS = ['APPROVED', 'EDITED', 'REJECTED'];
function normDecision(d) {
  if (!d) return null;
  const v = String(d.decision || '').toUpperCase();
  const decision = v === 'ACCEPTED' ? 'APPROVED' : DECISIONS.includes(v) ? v : null;
  return decision ? { ...d, decision } : null;
}
function normDecisions(all) {
  const out = {};
  for (const [k, v] of Object.entries(all || {})) { const d = normDecision(v); if (d) out[k] = d; }
  return out;
}

/** M14 төлөв: хуучин recheck-1 → recheck-2 */
const RECHECK_STATUSES = ['RESOLVED', 'PARTIAL', 'NOT_RESOLVED', 'REGRESSED', 'NOT_APPLICABLE', 'UNABLE'];
const LEGACY_RECHECK = { fixed: 'RESOLVED', partial: 'PARTIAL', not_fixed: 'NOT_RESOLVED', unable: 'UNABLE' };
function normRecheckStatus(s) {
  const v = String(s || '');
  if (RECHECK_STATUSES.includes(v.toUpperCase())) return v.toUpperCase();
  return LEGACY_RECHECK[v.toLowerCase()] || 'UNABLE';
}

module.exports = {
  API_VERSION, RULEPACK, PROMPT_TEMPLATE_ID, RECHECK_TEMPLATE_ID, SCHEMA_VERSION,
  SEVERITIES, SEV_RANK, MODULES, MODULE_NAMES, VERDICTS, DECISIONS, RECHECK_STATUSES,
  normSeverity, legacyVerdict, moduleOf, countSev, computeVerdict, computeScorecard,
  engKey, rvId, assignIds, sortIssues, normDecision, normDecisions, normRecheckStatus,
};
