'use strict';
/*
  Review-ийн үр дүнг татаж авах форматууд (гадны сангүй):
    html  — бие даасан, хэвлэхэд бэлэн хуудас
    docx  — Word (A4 хэвтээ, хүснэгт, хуудасны дугаар)
    pdf   — html-ийг Microsoft Edge / Chrome headless-ээр хэвлэнэ
    xlsx  — Excel (тэмдэглэл бүр мөр, шүүлтүүр, аудиторын хариу бөглөх багана)
    zip   — дээрх бүгд + эх md/json
  Бүх гаралт хувийн мэдээллийн token-ийг буцааж тавьсан текстээс үүснэ (restoreTokens).
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./common');

/* ---------- Оролт ---------- */
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', ө: 'u',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = s => String(s || '').replace(/[А-яЁёӨөҮү]/g, ch => {
  const l = ch.toLowerCase(), t = TR[l] ?? '';
  return ch === l ? t : t.charAt(0).toUpperCase() + t.slice(1);
});
function loadReview(dir) {
  const out = path.join(dir, 'sandbox', 'output');
  const read = (f, asJson) => {
    const p = path.join(out, f);
    return fs.existsSync(p) ? C.restoreTokens(dir, fs.readFileSync(p, 'utf8'), asJson) : null;
  };
  const md = read('review_report.md', false) || '';
  const findingsText = read('review_findings.json', true);
  const summaryText = read('review_summary.json', true);
  let findings = null;
  try { findings = findingsText ? JSON.parse(findingsText) : null; } catch { findings = null; }
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  const state = C.readJson(path.join(dir, 'state.json')) || {};
  const audit = { ...(job.audit || {}), ...Object.fromEntries(Object.entries((findings && findings.audit) || {}).filter(([, v]) => v)) };
  const date = String(state.finished || job.created || C.nowIso()).slice(0, 10);
  // Файлын нэр латинаар (ZIP, имэйл, хуучин программд кирилл нэр эвдэрдэг)
  const safe = s => translit(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const base = ['Review', safe(audit.code), safe(audit.branch), date].filter(Boolean).join('_');
  // Хуучин (v1/v2) review-г R1–R4 болгоно
  const ver = Number(findings && findings.schema_version) || 0;
  if (findings && Array.isArray(findings.issues)) findings.issues = findings.issues.map(it => ({ ...it, severity: sevNorm(it.severity, ver) }))
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const rv = (findings && findings.review) || {};
  const verdict = verdictOf(rv);
  const decisions = normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {});
  const cycle = Number(rv.cycle_no) || (job.parent_id ? (Number(job.round) || 1) + 1 : 1);
  const engId = String(audit.code || '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || path.basename(dir);
  return { id: path.basename(dir), md, findings, findingsText, summaryText, audit, date, base, ver, verdict, decisions, cycle, engId };
}

/* ---------- SP-118-04: R1–R4, verdict ---------- */
const SEV_LABEL = { R1: 'R1 · Ноцтой', R2: 'R2 · Томоохон', R3: 'R3 · Бага', R4: 'R4 · Санал' };
const SEV_RANK = { R1: 0, R2: 1, R3: 2, R4: 3 };
const VERDICT_MN = { READY: 'Батлахад бэлэн', READY_WITH_FIXES: 'Засвартайгаар батлах боломжтой', NOT_READY: 'Батлахад бэлэн биш — засварлуулах', ESCALATE: 'Захиралд нэн даруй мэдэгдэх', RUN_REJECTED: 'Хяналт эхлэх боломжгүй' };
const CONF_MN = { High: 'Өндөр', Medium: 'Дунд', Low: 'Бага — аудитороос тодруулах' };
const MODULES = { G0: 'Оролтын бүрэн байдал', M01: 'Бүтэц ба бүрдэл', M02: 'Зорилго ба хамрах хүрээ', M03: '5C бүрэн байдал', M04: 'Зэрэглэлийн калибровк', M05: 'Тоон нийцэл', M06: 'Нотолгоо ба мөшгөх чадвар', M07: 'Нийцлийн эрсдэл', M08: 'Зөвлөмжийн чанар', M09: 'Удирдлагын хариу', M10: 'Follow-up ба хамаарал', M11: 'Хэл найруулга, формат', M12: 'Кодчлол, хувилбар, нууцлал', M13: 'Нэмэлт логик (AI-INSIGHT)', M14: 'Хувилбарын харьцуулалт' };
const SC_MN = { PASS: 'Хэвийн', FAIL: 'Ноцтой асуудалтай', PARTIAL: 'Хэсэгчлэн', 'N/A': 'Хамаарахгүй' };
const DEC_MN = { APPROVED: 'Зөвшөөрсөн', EDITED: 'Засаж зөвшөөрсөн', REJECTED: 'Татгалзсан' };
// v3: R1–R4; v2: MAJOR→R1, MODERATE→R2, MINOR→R3; v1: CRITICAL→R1, MAJOR→R2, MINOR→R3
function sevNorm(s, ver) {
  s = String(s || '').toUpperCase().trim();
  const r = s.match(/^R([1-4])/); if (r) return 'R' + r[1];
  if (s.startsWith('SUG')) return 'R4';
  if (ver >= 2) return s.startsWith('MAJ') || s.startsWith('CRIT') ? 'R1' : s.startsWith('MOD') ? 'R2' : 'R3';
  return s.startsWith('CRIT') ? 'R1' : s.startsWith('MAJ') ? 'R2' : 'R3';
}
function verdictOf(rv) {
  const v = String(rv.verdict || '').toUpperCase();
  if (VERDICT_MN[v]) return v;
  const d = String(rv.decision || '').trim(), u = d.toUpperCase();
  if (!d) return null;
  if (u.includes('CANNOT')) return 'RUN_REJECTED';
  if (d.startsWith('Батлахад бэлэн')) return 'READY';
  if (d.startsWith('Бага засвартай') || d.startsWith('Засвартай')) return 'READY_WITH_FIXES';
  if (d.startsWith('Буцааж')) return 'NOT_READY';
  return null;
}
const decNorm = v => { v = String(v || '').toUpperCase(); return v === 'ACCEPTED' ? 'APPROVED' : ['APPROVED', 'EDITED', 'REJECTED'].includes(v) ? v : null; };
function normDecisions(all) {
  const out = {};
  for (const [k, d] of Object.entries(all || {})) { const v = decNorm(d && d.decision); if (v) out[k] = { ...d, decision: v }; }
  return out;
}
const moduleOf = it => { const m = String(it.module || it.rule || '').toUpperCase().match(/^(G0|M\d{2})/); return m ? m[1] : ''; };
const sevCounts = issues => Object.fromEntries(Object.keys(SEV_RANK).map(k => [k, issues.filter(i => i.severity === k).length]));
// Системийн тооцоолсон хураангуй (verdict, тоо, scorecard) — html/docx-ийн эхэнд
function summaryRows(R) {
  const F = R.findings || {}, rv = F.review || {}, issues = Array.isArray(F.issues) ? F.issues : [];
  const c = sevCounts(issues), n = k => rv[k.toLowerCase() + '_count'] ?? c[k];
  const d = Object.values(R.decisions);
  const dn = k => d.filter(x => x.decision === k).length;
  return [
    ['Эцсийн санал (verdict)', R.verdict ? VERDICT_MN[R.verdict] : (rv.decision || '—')],
    ['Санал', Object.keys(SEV_RANK).map(k => `${SEV_LABEL[k]}: ${n(k)}`).join(' · ')],
    ['Давталт (cycle)', 'C' + R.cycle],
    d.length ? ['Захирлын шийдвэр', `${dn('APPROVED')} зөвшөөрсөн · ${dn('EDITED')} зассан · ${dn('REJECTED')} татгалзсан · ${issues.length - d.length} шийдээгүй`] : null,
    F.gate0 && F.gate0.status ? ['Оролт (Gate-0)', F.gate0.status + (Array.isArray(F.gate0.notes) && F.gate0.notes.length ? ' — ' + F.gate0.notes.join('; ') : '')] : null,
    Array.isArray(F.insufficient_inputs) && F.insufficient_inputs.length ? ['Дутуу оролт', F.insufficient_inputs] : null,
  ].filter(Boolean);
}
function scorecardRows(F) {
  const sc = F && F.scorecard && !Array.isArray(F.scorecard) && typeof F.scorecard === 'object' ? F.scorecard : null;
  if (!sc) return null;
  const keys = Object.keys(MODULES).filter(k => sc[k]);
  if (!keys.length) return null;
  return [['Модуль', 'Нэр', 'Төлөв', 'R1', 'R2', 'R3', 'R4'],
    ...keys.map(k => { const s = sc[k] || {}, st = String(s.status || 'N/A').toUpperCase(); return [k, MODULES[k], SC_MN[st] || st, s.r1 ?? 0, s.r2 ?? 0, s.r3 ?? 0, s.r4 ?? 0].map(String); })];
}
function aiRunLine(F) {
  const a = F && F.ai_run; if (!a) return '';
  return 'AI ажиллагаа: ' + [a.ai_run_id, a.model, a.prompt_template_id, a.rulepack, a.retry_count != null ? `давталт ${a.retry_count}` : '', a.source_doc_id ? `эх баримт ${a.source_doc_id}` : ''].filter(x => x !== '' && x != null).join(' · ');
}

/* ---------- Markdown → блок ---------- */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}
function parseMd(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); blocks.push({ t: 'h', level: m[1].length, text: m[2].trim() }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      blocks.push({ t: 'table', rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      i--;
      blocks.push({ t: 'quote', text: q.join(' ') });
      continue;
    }
    if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
      flush();
      const ordered = /\d/.test(m[1]);
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (mm && /\d/.test(mm[1]) === ordered) items.push(mm[2]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ' ' + lines[i].trim();
        else break;
        i++;
      }
      i--;
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
// **тод**, *налуу*, `код` → [{text, b, i, code}]
function parseInline(s) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*?)\*)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[2] !== undefined) runs.push({ text: m[2], b: true });
    else if (m[3] !== undefined) runs.push({ text: m[3], code: true });
    else runs.push({ text: m[4], i: true });
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.map(r => ({ ...r, text: r.text.replace(/\\([|*_`])/g, '$1') }));
}

// Хүснэгтийн нүдэнд бичигдсэн зэрэглэлийг өнгөөр (MD-д хуучин нэршил ч байж болно)
const SEV = { R1: 'r1', R2: 'r2', R3: 'r3', R4: 'r4', 'R1 · НОЦТОЙ': 'r1', 'R2 · ТОМООХОН': 'r2', 'R3 · БАГА': 'r3', 'R4 · САНАЛ': 'r4', MAJOR: 'r1', MODERATE: 'r2', MINOR: 'r3', CRITICAL: 'r1' };
const STATUS_OK = /^(Matched|Таарсан|Complete|Байгаа)$/i;
const STATUS_BAD = /^(Difference|Зөрүүтэй|Incomplete|Хэтэрсэн|Тэмдэглэгдээгүй)$/i;

/* ---------- Тэмдэглэлийн дэлгэрэнгүй (хавсралт) ---------- */
const ISSUE_FIELDS = [
  ['anchor', 'Байршил'], ['module', 'Модуль'], ['rule', 'Шалгуур'], ['confidence', 'Итгэл'], ['category', 'Ангилал'], ['source', 'Эх баримт / шаардлага'],
  ['quote', 'Тайлангаас ишлэл'], ['issue', 'Асуудал'], ['why_it_matters', 'Яагаад чухал'],
  ['evidence', 'Нотолгоо'], ['required_action', 'Засах арга'], ['suggested_text', 'Санал болгох текст'],
  ['impacts', 'Хамаарах, дахин шалгах хэсэг'], ['resolution_check', 'Засагдсаныг шалгах'], ['origin', 'Шалгасан'],
];
const fmtEvidence = ev => (Array.isArray(ev) ? ev : ev ? [ev] : []).map(e =>
  typeof e === 'string' ? e : [e.source || [e.file, e.anchor].filter(Boolean).join(' › '), e.detail].filter(Boolean).join(' — '));
const fmtImpacts = im => (Array.isArray(im) ? im : []).filter(i => i && (i.element || i.action)).map(i => [i.element, i.action].filter(Boolean).join(' → ') + (i.anchor ? ` (${i.anchor})` : ''));
// Ишлэлийн шалгалтын төлөв (server/verify.js)
function qcLabel(it) {
  const c = it.quote_check; if (!c) return '';
  const moved = c.original_anchor !== undefined && c.original_anchor !== it.anchor ? ` (байршил автоматаар зассан: ${c.original_anchor || '—'} → ${it.anchor || '—'})` : '';
  const re = c.retried ? ' — агент дахин зассан' : '';
  return { exact: 'Таарсан', relocated: 'Таарсан', partial: `Хэсэгчлэн таарсан (${c.ratio ?? ''}%) — шалгана уу`, not_found: '⚠ Тайлангаас олдсонгүй — шалгана уу', no_quote: '' }[c.status] + (c.status === 'no_quote' ? '' : moved + re);
}
function issueRows(it, dec) {
  const rows = [];
  for (const [k, label] of ISSUE_FIELDS) {
    if (k === 'evidence') { const ev = fmtEvidence(it.evidence); if (ev.length) rows.push([label, ev]); continue; }
    if (k === 'impacts') { const im = fmtImpacts(it.impacts); if (im.length) rows.push([label, im]); continue; }
    let v = it[k];
    if (k === 'module') v = moduleOf(it) ? `${moduleOf(it)} ${MODULES[moduleOf(it)] || ''}`.trim() : '';
    if (k === 'confidence' && v) v = CONF_MN[v] || v;
    if (k === 'origin') v = v === 'rule_engine' ? 'Систем (кодоор, AI-гүй)' : '';
    if (v === undefined || v === null || v === '') continue;
    if (k === 'source' && it.draft_source) v += ' (төсөл баримт)';
    rows.push([label, String(v)]);
    if (k === 'quote' && qcLabel(it)) rows.push(['Ишлэлийн шалгалт', qcLabel(it)]);
  }
  if (dec) rows.push(['Захирлын шийдвэр', DEC_MN[dec.decision] + (dec.decision === 'EDITED' && dec.edited_text ? `: ${dec.edited_text}` : '') + (dec.note ? ` — ${dec.note}` : '')]);
  return rows;
}

/* ---------- HTML ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inlineHtml = s => parseInline(s).map(r => r.b ? `<strong>${esc(r.text)}</strong>` : r.i ? `<em>${esc(r.text)}</em>` : r.code ? `<code>${esc(r.text)}</code>` : esc(r.text)).join('');
function cellHtml(text, tag) {
  const t = text.trim(), sev = SEV[t.toUpperCase()];
  if (tag === 'td' && sev) return `<td><span class="sev ${sev}">${esc(t)}</span></td>`;
  const cls = tag === 'td' && STATUS_OK.test(t) ? ' class="ok"' : tag === 'td' && STATUS_BAD.test(t) ? ' class="bad"' : '';
  return `<${tag}${cls}>${inlineHtml(text)}</${tag}>`;
}
function blocksHtml(blocks) {
  return blocks.map(b => {
    if (b.t === 'h') return `<h${b.level}>${inlineHtml(b.text)}</h${b.level}>`;
    if (b.t === 'p') return `<p>${inlineHtml(b.text)}</p>`;
    if (b.t === 'hr') return '<hr>';
    if (b.t === 'quote') return `<blockquote>${inlineHtml(b.text)}</blockquote>`;
    if (b.t === 'list') { const tag = b.ordered ? 'ol' : 'ul'; return `<${tag}>${b.items.map(x => `<li>${inlineHtml(x)}</li>`).join('')}</${tag}>`; }
    if (b.t === 'table') {
      const [head, ...body] = b.rows;
      return `<table><thead><tr>${head.map(c => cellHtml(c, 'th')).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => cellHtml(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
    }
    return '';
  }).join('\n');
}
// MD-ийн эхний гарчиг (+ дагалдах ишлэл)-ийн дараах байрлал — системийн хураангуйг тэнд оруулна
function headEnd(blocks) {
  let i = blocks.findIndex(b => b.t === 'h');
  if (i < 0) return 0;
  i++;
  while (i < blocks.length && blocks[i].t === 'quote') i++;
  return i;
}
function toHtml(R) {
  const blocks = parseMd(R.md);
  const issues = (R.findings && Array.isArray(R.findings.issues)) ? R.findings.issues : [];
  const kvHtml = rows => `<table class="kv">${rows.map(([l, v]) => `<tr><th>${esc(l)}</th><td>${Array.isArray(v) ? `<ul>${v.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>`;
  const scr = scorecardRows(R.findings);
  const sysSummary = R.findings ? `<section class="sys">
<h2>Шийдвэрийн хуудас (системийн тооцоо)</h2>
${kvHtml(summaryRows(R))}
${scr ? `<table><thead><tr>${scr[0].map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${scr.slice(1).map(r => `<tr>${r.map(c => cellHtml(c, 'td')).join('')}</tr>`).join('')}</tbody></table>` : ''}
</section>` : '';
  const appendix = issues.length ? `
<section class="appendix">
<h2>Хавсралт. Саналын дэлгэрэнгүй</h2>
${issues.map(it => {
    const sev = SEV[it.severity] || 'r3';
    return `<div class="issue">
<h3><span class="sev ${sev}">${esc(SEV_LABEL[it.severity] || it.severity || '')}</span> ${esc(it.id || '')}${it.title ? ' — ' + esc(it.title) : ''}</h3>
${kvHtml(issueRows(it, R.decisions[it.id]))}
</div>`;
  }).join('\n')}
</section>` : '';
  const ai = aiRunLine(R.findings);
  const title = [R.audit.branch, R.audit.code].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="mn"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Аудитын тайлангийн review${title ? ' — ' + esc(title) : ''}</title>
<style>
@page { size: A4 landscape; margin: 14mm 12mm 16mm; }
:root { --ink:#1b2430; --muted:#5b6675; --line:#cfd6df; --head:#1f4e79; --headbg:#e8eef6;
  --major:#b42318; --majorbg:#fde2e1; --mod:#9a5b00; --modbg:#fff1d6; --min:#1d4ed8; --minbg:#e3ecfd; --sug:#4f6b5f; --sugbg:#e6efea; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 10.5pt/1.45 "Segoe UI", Arial, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 20px 40px; }
h1 { font-size: 19pt; color: var(--head); margin: 0 0 6px; border-bottom: 3px solid var(--head); padding-bottom: 6px; }
h2 { font-size: 13.5pt; color: var(--head); margin: 22px 0 8px; padding-bottom: 3px; border-bottom: 1px solid var(--line); break-after: avoid; }
h3 { font-size: 11.5pt; margin: 16px 0 6px; break-after: avoid; }
p { margin: 6px 0; }
blockquote { margin: 8px 0 14px; padding: 8px 12px; background: #f4f6f9; border-left: 4px solid var(--head); color: var(--muted); }
ul, ol { margin: 6px 0; padding-left: 22px; } li { margin: 2px 0; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 9pt; }
th, td { border: 1px solid var(--line); padding: 4px 6px; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
thead th { background: var(--head); color: #fff; font-weight: 600; }
thead { display: table-header-group; } tr { break-inside: avoid; }
tbody tr:nth-child(even) td { background: #f8fafc; }
table:not(.kv) td:first-child { white-space: nowrap; }
td.ok { color: #067647; font-weight: 600; } td.bad { color: var(--major); font-weight: 600; }
.sev { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 8.5pt; font-weight: 700; letter-spacing: .02em; white-space: nowrap; }
.sev.r1 { background: var(--majorbg); color: var(--major); } .sev.r2 { background: var(--modbg); color: var(--mod); } .sev.r3 { background: var(--minbg); color: var(--min); } .sev.r4 { background: var(--sugbg); color: var(--sug); }
.sys { margin-bottom: 18px; }
code { font-family: Consolas, monospace; font-size: 9pt; background: #f1f3f6; padding: 0 3px; border-radius: 3px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.appendix { break-before: page; }
.issue { break-inside: avoid; margin-bottom: 10px; }
table.kv th { width: 190px; background: var(--headbg); color: var(--ink); font-weight: 600; }
table.kv tbody tr td, table.kv tr td { background: #fff; }
table.kv ul { margin: 0; padding-left: 18px; }
footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: 8.5pt; }
@media print { main { max-width: none; padding: 0; } }
</style></head>
<body><main>
${blocksHtml(blocks.slice(0, headEnd(blocks)))}
${sysSummary}
${blocksHtml(blocks.slice(headEnd(blocks)))}
${appendix}
<footer>Internal Audit – Restricted · Reviewer decision support — эцсийн шийдвэрийг ДАГ-ын захирал гаргана (DOC-1917 §8–9). Review ID: ${esc(R.id)} · Огноо: ${esc(R.date)}${ai ? '<br>' + esc(ai) : ''}</footer>
</main></body></html>`;
}

/* ---------- ZIP (deflate, UTF-8 нэр) ---------- */
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of entries) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(buf, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(buf) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(buf.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(buf.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, comp);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

/* ---------- DOCX ---------- */
const xesc = s => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SEV_DOCX = { r1: ['B42318', 'FDE2E1'], r2: ['9A5B00', 'FFF1D6'], r3: ['1D4ED8', 'E3ECFD'], r4: ['4F6B5F', 'E6EFEA'] };
function wRuns(text, base = {}) {
  return parseInline(text).map(r => {
    const o = { ...base, ...r };
    const pr = [o.b && '<w:b/>', o.i && '<w:i/>', o.code && '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>',
      o.color && `<w:color w:val="${o.color}"/>`, o.sz && `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`].filter(Boolean).join('');
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xesc(o.text)}</w:t></w:r>`;
  }).join('');
}
const wP = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
function wCell(text, { header, width, fill, color, bold } = {}) {
  const t = String(text).trim(), sev = !header && SEV[t.toUpperCase()];
  let f = fill, c = color, b = bold;
  if (header) { f = '1F4E79'; c = 'FFFFFF'; b = true; }
  else if (sev) { [c, f] = SEV_DOCX[sev]; b = true; }
  else if (STATUS_OK.test(t)) { c = '067647'; b = true; }
  else if (STATUS_BAD.test(t)) { c = 'B42318'; b = true; }
  const lines = Array.isArray(text) ? text : [String(text)];
  const paras = lines.map(l => wP(wRuns(Array.isArray(text) ? '• ' + l : l, { sz: 18, color: c, b }), '<w:spacing w:before="0" w:after="0"/>')).join('') || wP('');
  return `<w:tc><w:tcPr>${width ? `<w:tcW w:w="${width}" w:type="pct"/>` : ''}${f ? `<w:shd w:val="clear" w:color="auto" w:fill="${f}"/>` : ''}</w:tcPr>${paras}</w:tc>`;
}
function wTable(rows, { kv } = {}) {
  const cols = Math.max(...rows.map(r => r.length));
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFC8D3"/>`).join('');
  const grid = Array.from({ length: cols }, () => '<w:gridCol/>').join('');
  const body = rows.map((r, ri) => {
    const header = !kv && ri === 0;
    const cells = Array.from({ length: cols }, (_, ci) => kv && ci === 0
      ? wCell(r[ci] ?? '', { width: 900, fill: 'E8EEF6', bold: true })
      : wCell(r[ci] ?? '', { header, width: kv ? 4100 : undefined }));
    return `<w:tr>${header ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${cells.join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>${wP('', '<w:spacing w:after="60"/>')}`;
}
function mdBody(blocks, body) {
  for (const b of blocks) {
    if (b.t === 'h') body.push(wP(wRuns(b.text), `<w:pStyle w:val="${b.level === 1 ? 'Title' : 'Heading' + Math.min(b.level - 1, 3)}"/>`));
    else if (b.t === 'p') body.push(wP(wRuns(b.text)));
    else if (b.t === 'quote') body.push(wP(wRuns(b.text), '<w:pStyle w:val="Quote"/>'));
    else if (b.t === 'hr') body.push(wP('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFC8D3"/></w:pBdr>'));
    else if (b.t === 'list') b.items.forEach((it, k) => body.push(wP(wRuns(`${b.ordered ? (k + 1) + '.' : '•'}\t${it}`), '<w:pStyle w:val="ListParagraph"/><w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="360"/>')));
    else if (b.t === 'table' && b.rows.length) body.push(wTable(b.rows));
  }
}
function toDocx(R) {
  const body = [];
  const blocks = parseMd(R.md), he = headEnd(blocks);
  mdBody(blocks.slice(0, he), body);
  if (R.findings) {
    body.push(wP(wRuns('Шийдвэрийн хуудас (системийн тооцоо)'), '<w:pStyle w:val="Heading1"/>'));
    body.push(wTable(summaryRows(R), { kv: true }));
    const scr = scorecardRows(R.findings);
    if (scr) body.push(wTable(scr));
  }
  mdBody(blocks.slice(he), body);
  const issues = (R.findings && Array.isArray(R.findings.issues)) ? R.findings.issues : [];
  if (issues.length) {
    body.push(wP('<w:r><w:br w:type="page"/></w:r>'));
    body.push(wP(wRuns('Хавсралт. Саналын дэлгэрэнгүй'), '<w:pStyle w:val="Heading1"/>'));
    for (const it of issues) {
      const [c] = SEV_DOCX[SEV[it.severity] || 'r3'];
      body.push(wP(`<w:r><w:rPr><w:b/><w:color w:val="${c}"/></w:rPr><w:t xml:space="preserve">${xesc(SEV_LABEL[it.severity] || it.severity || '')}  </w:t></w:r>` + wRuns(`${it.id || ''}${it.title ? ' — ' + it.title : ''}`), '<w:pStyle w:val="Heading3"/><w:keepNext/>'));
      body.push(wTable(issueRows(it, R.decisions[it.id]), { kv: true }));
    }
  }
  body.push(wP(wRuns(`Internal Audit – Restricted · Reviewer decision support — эцсийн шийдвэрийг ДАГ-ын захирал гаргана (DOC-1917 §8–9). Review ID: ${R.id} · Огноо: ${R.date}`, { sz: 16, color: '5B6675' }), '<w:spacing w:before="240"/>'));
  const ai = aiRunLine(R.findings);
  if (ai) body.push(wP(wRuns(ai, { sz: 16, color: '5B6675' })));
  return docxPackage(body, 'Аудитын тайлангийн review ' + [R.audit.branch, R.audit.code].filter(Boolean).join(' '),
    ['Аудитын тайлангийн review', R.audit.branch, R.audit.code].filter(Boolean).join(' · '));
}
function docxPackage(body, title, footerText) {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${body.join('')}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const font = '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Segoe UI" w:cs="Segoe UI"/>';
  const hstyle = (id, name, sz, color, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/>${extra}</w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="mn-MN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${hstyle('Title', 'Title', 36, '1F4E79', '<w:pBdr><w:bottom w:val="single" w:sz="18" w:space="4" w:color="1F4E79"/></w:pBdr>')}
${hstyle('Heading1', 'heading 1', 28, '1F4E79', '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="BFC8D3"/></w:pBdr><w:outlineLvl w:val="0"/>')}
${hstyle('Heading2', 'heading 2', 24, '1F4E79', '<w:outlineLvl w:val="1"/>')}
${hstyle('Heading3', 'heading 3', 22, '1B2430', '<w:outlineLvl w:val="2"/>')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="1F4E79"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F4F6F9"/><w:ind w:left="200"/></w:pPr><w:rPr><w:color w:val="5B6675"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="5B6675"/><w:sz w:val="16"/></w:rPr></w:style>
</w:styles>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="15138"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${xesc(footerText)}</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">Хуудас </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> / </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xesc(title)}</dc:title><dc:creator>Audit Report Reviewer</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/footer1.xml', data: footer },
  ]);
}

/* ---------- XLSX ---------- */
const LABELS = {
  type: 'Төрөл', anchor: 'Байршил', requirement: 'Шаардлага', status_in_report: 'Тайланд',
  finding: 'Олдвор', criteria: 'Шалгуур (C1)', condition: 'Нөхцөл (C2)', cause: 'Шалтгаан (C3)', consequence: 'Үр дагавар (C4)',
  corrective_action: 'Засах арга хэмжээ (C5)', status: 'Төлөв', rating: 'Зэрэглэл', assessment: 'Үнэлгээ', completeness: 'Бүрэн байдал',
  metric: 'Үзүүлэлт', report: 'Тайланд', evidence: 'Excel / нотолгоо', reviewer: 'Хянагчийн тооцоо', source: 'Эх сурвалж', ref: 'Холбоос',
  priority: 'Дараалал', action: 'Хийх засвар', issue_ids: 'Холбогдох санал', note: 'Тайлбар', method: 'Арга',
  deadline: 'Хугацаа', rule: 'Шалгуур', iss_id: 'Зөрчлийн ID', title: 'Гарчиг', due_date: 'Дуусах хугацаа', overdue_days: 'Хэтэрсэн хоног',
  in_report: 'Тайланд', report_anchor: 'Тайлан дахь байршил', repeat: 'Давтагдсан', id: 'ID', topic: 'Сэдэв', doc_a: 'Баримт A', doc_b: 'Баримт B',
  effect_on_report: 'Тайланд нөлөө', affects_conclusion: 'Дүгнэлтэд нөлөөлсөн', decision: 'Шийдвэр',
};
function cellStr(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(cellStr).join('; ');
  if (typeof v === 'object') {
    if (v.file || v.anchor || v.source || v.detail) return [v.source || [v.file, v.anchor].filter(Boolean).join(' › '), v.detail].filter(Boolean).join(' — ');
    return Object.entries(v).map(([k, x]) => `${LABELS[k] || k}: ${cellStr(x)}`).join('; ');
  }
  if (typeof v === 'boolean') return v ? 'Тийм' : 'Үгүй';
  return String(v);
}
function objectsSheet(name, arr, preferred = []) {
  if (!Array.isArray(arr) || !arr.length) return null;
  if (typeof arr[0] !== 'object') return { name, cols: [{ h: name, w: 120 }], rows: arr.map(x => [cellStr(x)]) };
  const keys = [...new Set([...preferred.filter(k => arr.some(o => o && o[k] !== undefined)), ...arr.flatMap(o => Object.keys(o || {}))])];
  return {
    name,
    cols: keys.map(k => ({ h: LABELS[k] || k, w: ['finding', 'metric', 'requirement', 'action'].includes(k) ? 40 : 26 })),
    rows: arr.map(o => keys.map(k => typeof (o || {})[k] === 'number' ? o[k] : cellStr((o || {})[k]))),
  };
}
function xlsxSheets(R) {
  const F = R.findings || {}, rv = F.review || {}, a = R.audit || {};
  const sheets = [];
  const summary = [
    ['Аудит', a.name], ['Салбар', a.branch], ['Аудитын код', a.code], ['Тайлангийн дугаар', a.report_no],
    ...summaryRows(R).map(([k, v]) => [k, Array.isArray(v) ? v.join('; ') : v]),
    ['Core question', rv.core_question], ['Тайлангийн ерөнхий үнэлгээ', rv.report_rating],
    ['Headline', F.headline], ['Гол дүгнэлт', F.executive_summary], ['Захирлын шийдэх асуудал', F.decision_points], ['Эцсийн заавар', F.final_instruction],
    ['AI ажиллагаа', aiRunLine(F).replace(/^AI ажиллагаа: /, '')], ['Нууцлал', 'Internal Audit – Restricted'],
    ['Ишлэлийн шалгалт', F.quote_verification && F.quote_verification.checked ? `${(F.quote_verification.exact || 0) + (F.quote_verification.relocated || 0)}/${F.quote_verification.checked} таарсан${F.quote_verification.relocated ? `, ${F.quote_verification.relocated} байршил зассан` : ''}${F.quote_verification.partial ? `, ${F.quote_verification.partial} хэсэгчлэн` : ''}${F.quote_verification.not_found ? `, ${F.quote_verification.not_found} олдоогүй` : ''}` : ''],
    ['Review ID', R.id], ['Огноо', R.date],
  ].filter(r => r[1] !== undefined && r[1] !== null && r[1] !== '');
  sheets.push({ name: 'Хураангуй', cols: [{ h: 'Үзүүлэлт', w: 28 }, { h: 'Утга', w: 120 }], rows: summary.map(([k, v]) => [k, typeof v === 'number' ? v : cellStr(v)]) });
  const issues = Array.isArray(F.issues) ? F.issues : [];
  if (issues.length) sheets.push({
    name: 'Саналууд', sevCol: 1,
    cols: [['ID', 22], ['Зэрэглэл', 14], ['Модуль', 10], ['Шалгуур', 10], ['Итгэл', 10], ['Ангилал', 14], ['Байршил', 11], ['Гарчиг', 36], ['Асуудал', 60], ['Яагаад чухал', 40],
      ['Тайлангаас ишлэл', 36], ['Ишлэлийн шалгалт', 20], ['Нотолгоо', 45], ['Засах арга', 45], ['Санал болгох текст', 40], ['Хамаарах хэсэг', 36], ['Эх баримт / шаардлага', 26], ['Төсөл баримт', 10],
      ['Шалгасан', 12], ['Захирлын шийдвэр', 16], ['Захирлын засвар / тайлбар', 36], ['Аудиторын хариу', 36]].map(([h, w]) => ({ h, w })),
    rows: issues.map(it => { const d = R.decisions[it.id];
      return [it.id, SEV_LABEL[it.severity] || it.severity, moduleOf(it), it.rule, CONF_MN[it.confidence] || it.confidence, it.category, it.anchor, it.title, it.issue, it.why_it_matters, it.quote, qcLabel(it),
        fmtEvidence(it.evidence).join('\n'), it.required_action, it.suggested_text, fmtImpacts(it.impacts).join('\n'), it.source, it.draft_source ? 'Тийм' : '',
        it.origin === 'rule_engine' ? 'Систем' : 'AI', d ? DEC_MN[d.decision] : '', d ? [d.edited_text, d.note].filter(Boolean).join(' — ') : '', ''].map(cellStr); }),
  });
  const push = s => { if (s) sheets.push(s); };
  const scr = scorecardRows(F);
  if (scr) sheets.push({ name: 'Scorecard', cols: scr[0].map((h, i) => ({ h, w: i === 1 ? 32 : i === 2 ? 18 : 8 })), rows: scr.slice(1).map(r => r.map((c, i) => i >= 3 ? Number(c) : c)) });
  push(objectsSheet('Эскалаци', F.escalations, ['type', 'anchor', 'requirement', 'deadline', 'status_in_report', 'rule']));
  push(objectsSheet('Follow-up', F.followup_check, ['iss_id', 'title', 'rating', 'status', 'due_date', 'overdue_days', 'in_report', 'report_anchor', 'repeat', 'issue_ids']));
  // M08-08…12 — зөвлөмж бүрийн шаардлагын шалгалт (RPT175 нөлөөллийн матриц)
  const rqc = Array.isArray(F.recommendation_check) ? F.recommendation_check.map(r => ({ ...r,
    owner: r.elements?.owner, deadline: r.elements?.deadline, evidence: r.elements?.evidence, gate_or_threshold: r.elements?.gate_or_threshold, segment: r.elements?.segment,
    missing: (r.missing || []).join('; ') })) : [];
  push(objectsSheet('Зөвлөмжийн шаардлага', rqc, ['finding', 'anchor', 'kind', 'target_doc', 'catalog_match', 'owner', 'deadline', 'evidence', 'gate_or_threshold', 'segment',
    'owner_is_doc_owner', 'precedent', 'precedent_consistent', 'missing', 'issue_ids']));
  push(objectsSheet('Дүрмийн зөрчил', F.kb_conflicts, ['id', 'topic', 'doc_a', 'doc_b', 'effect_on_report', 'affects_conclusion', 'decision']));
  push(objectsSheet('Дутуу оролт', F.insufficient_inputs));
  push(objectsSheet('5C', F.five_c, ['finding', 'anchor', 'criteria', 'condition', 'cause', 'consequence', 'corrective_action']));
  push(objectsSheet('Тоон тулгалт', F.numerical_validation, ['metric', 'report', 'evidence', 'reviewer', 'status', 'source']));
  if (F.recommendation_deadlines && typeof F.recommendation_deadlines === 'object')
    sheets.push({ name: 'Зөвлөмжийн хугацаа', cols: [{ h: 'Үзүүлэлт', w: 30 }, { h: 'Утга', w: 100 }], rows: Object.entries(F.recommendation_deadlines).map(([k, v]) => [k, typeof v === 'number' ? v : cellStr(v)]) });
  push(objectsSheet('Засварууд', F.required_actions, ['priority', 'action', 'issue_ids']));
  push(objectsSheet('Дутуу элементүүд', F.missing_elements));
  push(objectsSheet('Буруу ангилал', F.observations_misclassified));
  return sheets;
}
const colName = n => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
function toXlsx(R) { return xlsxFromSheets(xlsxSheets(R)); }
/** Sheet-үүдээс .xlsx (feedback экспортод ч ашиглана) */
function xlsxFromSheets(sheets) {
  const SEV_STYLE = { r1: 3, r2: 4, r3: 5, r4: 2 };
  const sheetXml = s => {
    const rows = [[...s.cols.map(c => c.h)], ...s.rows];
    const lastCol = colName(s.cols.length - 1);
    const xmlRows = rows.map((r, ri) => `<row r="${ri + 1}">${s.cols.map((_, ci) => {
      const v = r[ci], ref = colName(ci) + (ri + 1);
      let st = ri === 0 ? 1 : 2;
      if (ri > 0 && ci === s.sevCol) st = SEV_STYLE[SEV[String(v).toUpperCase()]] || 2;
      if (ri > 0 && STATUS_OK.test(String(v))) st = 6;
      if (ri > 0 && STATUS_BAD.test(String(v))) st = 7;
      if (typeof v === 'number') return `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${xesc(v ?? '')}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${s.cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`).join('')}</cols><sheetData>${xmlRows}</sheetData>${s.rows.length ? `<autoFilter ref="A1:${lastCol}${s.rows.length + 1}"/>` : ''}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  };
  const names = new Set();
  const sheetName = n => { let s = n.replace(/[[\]:*?/\\]/g, '').slice(0, 31) || 'Sheet'; let k = 2; while (names.has(s)) s = s.slice(0, 28) + ' ' + k++; names.add(s); return s; };
  const named = sheets.map(s => ({ ...s, name: sheetName(s.name) }));
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="10"/><name val="Segoe UI"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Segoe UI"/></font><font><b/><sz val="10"/><name val="Segoe UI"/></font><font><b/><sz val="10"/><color rgb="FFB42318"/><name val="Segoe UI"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFDE2E1"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF1D6"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3ECFD"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFBFC8D3"/></left><right style="thin"><color rgb="FFBFC8D3"/></right><top style="thin"><color rgb="FFBFC8D3"/></top><bottom style="thin"><color rgb="FFBFC8D3"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const filters = named.map((s, i) => s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name.replace(/'/g, "''")}'!$A$1:$${colName(s.cols.length - 1)}$${s.rows.length + 1}</definedName>` : '').join('');
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${named.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

/* ---------- PDF (Edge / Chrome headless) ---------- */
function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of pf) for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
    const f = path.join(base, rel);
    if (fs.existsSync(f)) return f;
  }
  return C.findExecutable(['msedge.exe', 'chrome.exe', 'microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
}
function toPdf(R, dir) { return htmlToPdf(toHtml(R), dir); }
/** HTML → PDF (Edge/Chrome headless). Эцсийн тайланд ч ашиглана (final.js) */
function htmlToPdf(html, dir) {
  const browser = findBrowser();
  if (!browser) return Promise.reject(new Error('PDF үүсгэхэд Microsoft Edge эсвэл Google Chrome олдсонгүй'));
  // Түр файлууд job хавтаст (EFS шифрлэлттэй) үүсэж, дуусмагц устна
  const tmp = path.join(dir, 'export-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(tmp, { recursive: true });
  const htmlFile = path.join(tmp, 'review.html'), pdfFile = path.join(tmp, 'review.pdf');
  fs.writeFileSync(htmlFile, html, 'utf8');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-proxy-server', '--mute-audio',
    `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-pdf-header-footer', '--print-to-pdf-no-header',
    `--print-to-pdf=${pdfFile}`, require('url').pathToFileURL(htmlFile).href];
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ } };
  return new Promise((resolve, reject) => {
    const ch = spawn(browser, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { ch.kill(); } catch { /* ignore */ } }, 90000);
    ch.on('error', e => { clearTimeout(timer); cleanup(); reject(e); });
    ch.on('exit', () => {
      clearTimeout(timer);
      let buf = null;
      try { if (fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 0) buf = fs.readFileSync(pdfFile); } catch { /* ignore */ }
      setTimeout(cleanup, 500);
      buf ? resolve(buf) : reject(new Error('PDF үүсгэж чадсангүй'));
    });
  });
}

/* ---------- Аудиторт илгээх засварын даалгавар (S6) ---------- */
// Зөвхөн захирлын APPROVED / EDITED саналууд; татгалзсан санал хэзээ ч орохгүй (DOC-1917 §8)
function toTask(R) {
  const issues = ((R.findings && R.findings.issues) || []).filter(it => ['APPROVED', 'EDITED'].includes(R.decisions[it.id]?.decision))
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  if (!issues.length) throw new Error('Захирал зөвшөөрсөн санал алга — эхлээд саналуудыг шийдвэрлэнэ үү');
  const today = C.nowIso().slice(0, 10), a = R.audit;
  const body = [];
  body.push(wP(wRuns('Аудиторт илгээх засварын даалгавар'), '<w:pStyle w:val="Title"/>'));
  body.push(wTable([
    ['Аудит', a.name || '—'], ['Аудитын код', a.code || '—'], ['Салбар / нэгж', a.branch || '—'],
    ['Хяналтын давталт', `C${R.cycle} → дараагийн хувилбар v${R.cycle + 1}.0`], ['Огноо', today],
    ['Саналын тоо', Object.keys(SEV_RANK).map(k => `${SEV_LABEL[k]}: ${issues.filter(i => i.severity === k).length}`).join(' · ')],
    ['Нууцлал', 'Internal Audit – Restricted'],
  ], { kv: true }));
  body.push(wP(wRuns('Зөвхөн ДАГ-ын захирлын зөвшөөрсөн саналуудыг оруулсан. Засварласан тайлангаа оруулахад систем санал бүр хаана, хэрхэн засагдсаныг өөрөө тулгаж шалгана.', { color: '5B6675' })));
  const rows = [['№', 'Санал (RV ID)', 'Зэрэглэл', 'Байршил', 'Юу засах', 'Дүрэм / эх сурвалж']];
  issues.forEach((it, i) => {
    const d = R.decisions[it.id];
    const fix = d.decision === 'EDITED' && d.edited_text ? d.edited_text : it.required_action || it.issue || '';
    const where = [it.anchor, it.quote ? `“${it.quote}”` : ''].filter(Boolean).join(' — ') || 'Тайлан бүхэлдээ';
    rows.push([String(i + 1), it.id || '', SEV_LABEL[it.severity] || it.severity, where,
      // Гараар нэмсэн тэмдэглэлийн гарчиг нь засах зүйлийн эхний өгүүлбэр тул давхардуулахгүй
      it.origin === 'manual' ? fix : [it.title, fix].filter(Boolean).join(': ') + (d.note ? ` (Захирлын тайлбар: ${d.note})` : ''),
      it.origin === 'manual' ? `Хянагч гараар нэмсэн${it.author ? ' — ' + it.author : ''}` : [it.rule, it.source].filter(Boolean).join(' · ')]);
  });
  body.push(wTable(rows));
  body.push(wP(wRuns(`Reviewer decision support — саналыг ДАГ-ын захирал баталсан. Review ID: ${R.id}`, { sz: 16, color: '5B6675' }), '<w:spacing w:before="240"/>'));
  const filename = `IAD_RPT174_${R.engId}_Review_C${R.cycle}_${today}_v${R.cycle + 1}.0.docx`;
  return { data: docxPackage(body, 'Аудиторт илгээх засварын даалгавар ' + (a.code || ''), ['Засварын даалгавар', a.code, `C${R.cycle}`, 'Internal Audit – Restricted'].filter(Boolean).join(' · ')), filename };
}

/* ---------- Нийт ---------- */
const TYPES = {
  task: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gdocx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
async function buildExport(dir, format) {
  const R = loadReview(dir);
  let data;
  if (format === 'gdocx') {
    // Google Docs-д оруулах: зөвхөн далдалсан, алдагдал шалгасан агуулга (жинхэнэ утга буцааж тавихгүй)
    const { prepare, googleMarkdown } = require('./docs_prep');
    const r = prepare(path.basename(dir));
    if (!r.ok) throw new Error(`Далдлаагүй хувийн мэдээлэл ${r.remaining_leak_tokens.length} үлдсэн тул татах боломжгүй`);
    const p = C.readJson(path.join(dir, 'docs', 'payload.json'));
    data = toDocx({ ...R, md: googleMarkdown(p), findings: null });
    return { data, type: TYPES.gdocx, filename: `${R.base}_Google_masked.docx` };
  }
  if (format === 'task') { const t = toTask(R); return { data: t.data, type: TYPES.task, filename: t.filename }; }
  if (format === 'html') data = Buffer.from(toHtml(R), 'utf8');
  else if (format === 'docx') data = toDocx(R);
  else if (format === 'xlsx') data = toXlsx(R);
  else if (format === 'pdf') data = await toPdf(R, dir);
  else if (format === 'zip') {
    const entries = [
      { name: `${R.base}.docx`, data: toDocx(R) },
      { name: `${R.base}.xlsx`, data: toXlsx(R) },
      { name: `${R.base}.html`, data: toHtml(R) },
    ];
    try { entries.unshift({ name: `${R.base}.pdf`, data: await toPdf(R, dir) }); } catch { /* PDF боломжгүй бол бусдыг нь өгнө */ }
    if (R.md) entries.push({ name: `${R.base}.md`, data: R.md });
    if (R.findingsText) entries.push({ name: `${R.base}_findings.json`, data: R.findingsText });
    if (R.summaryText) entries.push({ name: `${R.base}_summary.json`, data: R.summaryText });
    data = zip(entries);
  } else throw new Error('Unknown format');
  return { data, type: TYPES[format], filename: `${R.base}.${format}` };
}

/* ---------- Захирлын буцаасан санал (feedback_v{n}) — аудиторт татах ----------
   fb: царцсан feedback (жинхэнэ утга сэргээсэн), audit: аудитын мэдээлэл. Аудиторт зөвхөн илгээсэн саналууд л орно. */
const RC_MN = { NOT_RESOLVED: 'Засагдаагүй', PARTIAL: 'Хэсэгчлэн засагдсан', REGRESSED: 'Засах явцад шинэ алдаа', UNABLE: 'Шалгах боломжгүй' };
function feedbackExport(fb, audit, format) {
  const a = audit || {}, draft = !!fb.draft;
  // Төсөл (захирал илгээгээгүй): шийдвэрлээгүй саналыг гарчигт нь тэмдэглэнэ
  const items = (fb.items || []).map(it => it.undecided ? { ...it, title: `(шийдвэрлээгүй) ${it.title || ''}`.trim() } : it);
  const when = String(fb.released_at || fb.drafted_at || '');
  const base = `${draft ? 'TOSOL_' : ''}Zasvar_${String(a.code || 'tailan').replace(/[^\w-]+/g, '_')}_v${fb.version}_${when.slice(0, 10)}`;
  const title = draft ? 'ТӨСӨЛ — захирал илгээгээгүй засварууд' : 'Захирлын буцаасан засварууд';
  const whenRow = draft ? ['Төлөв', `Төсөл — аудиторт илгээгээгүй (${when.slice(0, 16).replace('T', ' ')} байдлаар; шийдвэрлээгүй ${items.filter(i => i.undecided).length})`]
    : ['Илгээсэн огноо', when.slice(0, 16).replace('T', ' ')];
  const where = it => [it.anchor, it.quote ? `“${it.quote}”` : ''].filter(Boolean).join(' — ') || 'Тайлан бүхэлдээ';
  if (format === 'xlsx') {
    const cols = ['№', 'Санал ID', 'Зэрэглэл', 'Байршил', 'Гарчиг', 'Тайлбар', 'Юу засах вэ', 'Яагаад', 'Дахин шалгалтын төлөв', 'Дахин шалгалтын тэмдэглэл', 'Модуль / дүрэм', 'Эх сурвалж', 'Аудиторын хариу (бөглөнө)']
      .map((h, i) => ({ h, w: [5, 22, 14, 34, 34, 50, 60, 40, 18, 40, 16, 30, 40][i] }));
    const rows = items.map((it, i) => [i + 1, it.id, SEV_LABEL[it.severity] || it.severity, where(it), it.title, it.issue, it.required_action, it.why_it_matters,
      RC_MN[it.recheck_status] || it.recheck_status || '', it.recheck_note || '', [it.module, it.rule].filter(Boolean).join(' · '), it.source, '']);
    const info = [['Аудит', a.name || ''], ['Аудитын код', a.code || ''], ['Салбар', a.branch || ''], ['Хувилбар', `v${fb.version}`], whenRow,
      ['Саналын тоо', items.length], ['Нууцлал', 'Internal Audit – Restricted']];
    return { data: xlsxFromSheets([{ name: 'Засах зүйлс', cols, rows, sevCol: 2 }, { name: 'Мэдээлэл', cols: [{ h: 'Талбар', w: 22 }, { h: 'Утга', w: 60 }], rows: info }]),
      type: TYPES.xlsx, filename: base + '.xlsx' };
  }
  const body = [];
  body.push(wP(wRuns(title), '<w:pStyle w:val="Title"/>'));
  body.push(wTable([['Аудит', a.name || '—'], ['Аудитын код', a.code || '—'], ['Салбар / нэгж', a.branch || '—'], ['Хувилбар', `v${fb.version} → засаад v${fb.version + 1} илгээнэ`],
    whenRow,
    ['Саналын тоо', Object.keys(SEV_RANK).map(k => `${SEV_LABEL[k]}: ${items.filter(i => i.severity === k).length}`).join(' · ')], ['Нууцлал', 'Internal Audit – Restricted']], { kv: true }));
  body.push(wP(wRuns('Засвараа өөрийн эх тайланд хийгээд системд «Засвар оруулах» дарж шинэ хувилбараа илгээнэ. Агент санал бүр засагдсан эсэхийг тулгаж шалгана.', { color: '5B6675' })));
  const rows = [['№', 'Зэрэглэл', 'Байршил', 'Юу засах вэ', 'Тайлбар / яагаад']];
  items.forEach((it, i) => rows.push([String(i + 1), SEV_LABEL[it.severity] || it.severity, where(it),
    [it.title, it.required_action].filter(Boolean).join(': ') + (it.recheck_status ? ` [${RC_MN[it.recheck_status] || it.recheck_status}${it.recheck_note ? ': ' + it.recheck_note : ''}]` : ''),
    [it.issue, it.why_it_matters].filter(Boolean).join(' — ') + (it.source ? ` (${it.source})` : '')]));
  body.push(wTable(rows));
  return { data: docxPackage(body, title + ' ' + (a.code || ''), [draft ? 'ТӨСӨЛ' : 'Засварууд', a.code, `v${fb.version}`, 'Internal Audit – Restricted'].filter(Boolean).join(' · ')),
    type: TYPES.docx, filename: base + '.docx' };
}

module.exports = { feedbackExport, buildExport, EXPORT_FORMATS: Object.keys(TYPES), zip, htmlToPdf };
