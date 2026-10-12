'use strict';
/*
  Claude Docs-д «тайлан дээрх тэмдэглэл» хувилбар бэлтгэнэ (зөвхөн локал, юу ч илгээхгүй).
    node server/docs_annot.js <jobId>
  Гаралт: jobs/<id>/docs/annotated.json (+ annotated.md — урьдчилан харах)

  Агуулга:
    - Тайлангийн бичвэр (doc.json — аль хэдийн далдлагдсан) → markdown хэсгүүд (Doc-д дарааллаар бөглөнө)
    - Тэмдэглэл бүр → тухайн догол мөрийн үгэнд холбох comment (anchor 3–6 үг + nth)
    - «Тэмдэглэлүүд» tracker хүснэгт (Төлөв dropdown)
  Хамгаалалт: docs_prep-тэй ижил — restoreTokens хийхгүй, нэмэлт хэв маягаар далдална, mask_map-ын жинхэнэ утга
  үлдсэн бол ok=false. Аудиторт зөвхөн ДАГ-ын захирлын зөвшөөрсөн (APPROVED / EDITED) тэмдэглэл очно (SP-118-04/01 §5).
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const { scrub, findLeaks, STATUS_OPTIONS } = require('./docs_prep');

const SEV_L = { R1: 'R1 Ноцтой', R2: 'R2 Томоохон', R3: 'R3 Бага', R4: 'R4 Санал' };
const CHUNK = 12000;   // нэг update-д илгээх markdown-ын дээд хэмжээ (тэмдэгт)

const clean = s => String(s ?? '').replace(/\t+/g, ' ').replace(/[  ]+/g, ' ').trim();
const cell = s => clean(s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|') || ' ';
// Догол мөрийн эхэнд markdown болж хувирах тэмдэгтийг саармагжуулна (бичвэр өөрчлөгдөхгүй)
const para = s => clean(s).replace(/^([#>*+-]|\d+[.)])(\s)/, '\\$1$2');

/** Нэг блокыг markdown болгоно; `plain` нь Doc-д харагдах бичвэр (anchor хайхад) */
function blockMd(b) {
  if (b.kind === 'table') {
    const rows = (b.rows || []).map(r => (r || []).map(c => clean(c))).filter(r => r.some(Boolean));
    if (!rows.length) return null;
    const cols = Math.max(...rows.map(r => r.length));
    if (cols === 1 || rows.length === 1 && rows[0].filter(Boolean).length === 1) {
      const t = rows.map(r => r.filter(Boolean).join(' ')).join(' ');
      return { md: `**${para(t)}**`, plain: t };
    }
    const pad = r => [...r, ...Array(cols - r.length).fill('')];
    const lines = [`| ${pad(rows[0]).map(cell).join(' | ')} |`, `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map(r => `| ${pad(r).map(cell).join(' | ')} |`)];
    // Comment-ыг нүдний хил давуулахгүйн тулд anchor-ыг нэг нүднээс авна
    return { md: lines.join('\n'), plain: rows.map(r => r.join(' ')).join(' '), cells: rows.flat().filter(c => c.split(/\s+/).length >= 2) };
  }
  const t = clean(b.text);
  if (!t) return null;
  if (b.kind === 'title' || b.kind === 'h1') return { md: `## ${t}`, plain: t, head: true };
  if (b.kind === 'h2') return { md: `### ${t}`, plain: t, head: true };
  if (b.kind === 'h3') return { md: `#### ${t}`, plain: t, head: true };
  if (b.kind === 'li') return { md: `- ${t}`, plain: t };
  return { md: para(t), plain: t };
}

// Тэмдэглэлийг холбох 3–6 үг: ишлэл блокт байвал түүний эхнээс, үгүй бол блокийн эхний үгс
function anchorWords(plain, quote) {
  const words = s => s.split(/\s+/).filter(Boolean);
  const norm = s => clean(s).toLowerCase();
  let from = plain;
  const q = clean(quote).replace(/^["“'«]+|["”'»]+$/g, '').replace(/…$|\.\.\.$/, '').trim();
  if (q.length >= 8) {
    const i = norm(plain).indexOf(norm(q).slice(0, 40));
    if (i >= 0) from = plain.slice(i);
  }
  // Doc дээрх бичвэртэй яг таарахын тулд markdown тэмдэгт, хүснэгтийн хил агуулсан үгийг алгасна
  const w = words(from).filter(x => !/[|*_`#\\]/.test(x));
  return w.slice(0, Math.min(6, Math.max(3, w.length))).join(' ');
}

function build(jobId) {
  if (!/^[\w-]+$/.test(jobId)) throw new Error('Буруу job id');
  const dir = path.join(C.PATHS.jobs, jobId);
  const fjFile = path.join(dir, 'sandbox', 'output', 'review_findings.json');
  const doc = C.readJson(path.join(dir, 'doc.json'));
  const findings = C.readJson(fjFile);
  if (!findings) throw new Error('Review дуусаагүй эсвэл үр дүн алга');
  if (!doc || !Array.isArray(doc.blocks)) throw new Error('Тайлангийн бичвэр (doc.json) хадгалагдаагүй — энэ хувилбарыг бэлтгэх боломжгүй');
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  if (job.mask === false) throw new Error('Энэ review далдлалтгүй хийгдсэн — Docs руу илгээх боломжгүй');
  const map = C.readJson(path.join(dir, 'mask_map.json')) || {};
  const stats = { pattern: {}, restored_leaks: 0 };
  const audit = findings.audit || job.audit || {};
  const allowText = [audit.name, audit.code, audit.branch].join(' ');
  const S = t => scrub(String(t ?? ''), map, stats, allowText);

  // Зөвхөн захирлын зөвшөөрсөн тэмдэглэл
  const decs = C.readJson(path.join(dir, 'decisions.json')) || {};
  const decOf = id => { const v = String(decs[id]?.decision || '').toUpperCase(); return v === 'ACCEPTED' ? 'APPROVED' : v; };
  const ver = Number(findings.schema_version) || 0;
  const sevN = s => { s = String(s || '').toUpperCase(); const r = s.match(/^R([1-4])/); if (r) return 'R' + r[1];
    return ver >= 2 ? (s.startsWith('MAJ') || s.startsWith('CRIT') ? 'R1' : s.startsWith('MOD') ? 'R2' : 'R3') : (s.startsWith('CRIT') ? 'R1' : s.startsWith('MAJ') ? 'R2' : 'R3'); };
  const issues = (findings.issues || []).filter(it => ['APPROVED', 'EDITED'].includes(decOf(it.id))).map(it => ({ ...it, severity: sevN(it.severity),
    fix: decOf(it.id) === 'EDITED' && decs[it.id].edited_text ? decs[it.id].edited_text : (it.required_action || '') }));
  if (!issues.length) throw new Error('ДАГ-ын захирал нэг ч тэмдэглэл зөвшөөрөөгүй байна — аудиторт илгээх зүйл алга (вэб дээр «✓ Зөвшөөрөх»)');

  // Тайлангийн бичвэр → markdown, блок бүрийн байрлал
  const parts = [], pos = new Map();
  let offset = 0;
  for (const b of doc.blocks) {
    const r = blockMd(b);
    if (!r) continue;
    const md = S(r.md), plain = S(r.plain);
    pos.set(b.id, { start: offset, plain, cells: r.cells ? r.cells.map(S) : null, head: !!r.head, idx: parts.length });
    parts.push({ id: b.id, md, head: !!r.head });
    offset += md.length + 2;
  }
  const fullMd = parts.map(p => p.md).join('\n\n');

  // Тэмдэглэл бүрийн anchor
  const general = [], comments = [];
  const countBefore = (needle, end) => { let n = 0, i = -1; while ((i = fullMd.indexOf(needle, i + 1)) >= 0 && i < end) n++; return n; };
  for (const it of issues) {
    const m = String(it.anchor || '').toUpperCase().match(/^(P\d+|T\d+)/);
    const p = m && pos.get(m[1]);
    const body = S([`${SEV_L[it.severity] || it.severity} · ${it.id}`, it.title, it.fix ? `Засах: ${it.fix}` : '', it.why_it_matters ? `Яагаад: ${it.why_it_matters}` : '',
      it.origin === 'manual' ? 'Хянагч гараар нэмсэн' : ''].filter(Boolean).join('\n')).slice(0, 1800);
    if (!p) { general.push({ it, body }); continue; }
    const q = S(it.quote), qn = clean(q).toLowerCase().slice(0, 30);
    const src = p.cells ? (p.cells.find(c => qn.length >= 8 && c.toLowerCase().includes(qn)) || p.cells.find(c => qn.length >= 8 && qn.includes(c.toLowerCase().slice(0, 20))) || p.cells[0] || p.plain) : p.plain;
    const words = anchorWords(src, q);
    const at = fullMd.indexOf(words, p.start);
    comments.push({ id: it.id, severity: it.severity, anchor: words, nth: at >= 0 ? countBefore(words, at) + 1 : 1, block: m[1], block_hint: p.plain.slice(0, 80), body });
  }
  // Тайлан бүхэлд хамаарах тэмдэглэл — тусдаа хэсэгт мөр болгон, comment-ыг тэр мөрт холбоно
  let generalMd = '';
  if (general.length) {
    generalMd = ['## Тайлан бүхэлд хамаарах тэмдэглэл', '', ...general.map(g => `- ${g.it.id}: ${S(g.it.title || g.it.issue || '').replace(/\s+/g, ' ').slice(0, 120)}`)].join('\n');
    for (const g of general) comments.push({ id: g.it.id, severity: g.it.severity, anchor: `${g.it.id}:`, nth: 1, block: null, block_hint: 'Тайлан бүхэлд хамаарах тэмдэглэл', body: g.body });
  }

  // Хэсгүүдэд хуваах (гарчгаар, ≤ CHUNK тэмдэгт)
  const chunks = [];
  let cur = [], size = 0;
  for (const p of parts) {
    if (cur.length && (size + p.md.length > CHUNK || (p.head && size > CHUNK * 2 / 3))) { chunks.push(cur.join('\n\n')); cur = []; size = 0; }
    cur.push(p.md); size += p.md.length + 2;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));

  // Tracker
  const blocks = {};
  const rows = ['| ID | Зэрэглэл | Байршил | Засах | Аудиторын хариу | Төлөв |', '| --- | --- | --- | --- | --- | --- |'];
  issues.forEach((it, i) => {
    const key = `st${i + 1}`;
    blocks[key] = { type: 'dropdown', enum: '$lid:s', index: 0 };
    rows.push(`| ${cell(it.id)} | ${cell(SEV_L[it.severity])} | ${cell(it.anchor || 'Тайлан бүхэлд')} | ${cell(S(it.fix || it.title))} |   | <?claude block ${key}?> |`);
  });

  const name = S(`Тэмдэглэлтэй тайлан — ${[audit.code, audit.branch].filter(Boolean).join(' ') || jobId}`);
  const c = ['R1', 'R2', 'R3', 'R4'].map(k => issues.filter(i => i.severity === k).length);
  const lead = `Тайлан дээр ${issues.length} тэмдэглэл (R1 ${c[0]} / R2 ${c[1]} / R3 ${c[2]} / R4 ${c[3]}) — тус бүр холбогдох догол мөрийн хажууд comment-оор. `
    + 'Засварыг өөрийн эх тайлан (Google Doc)-д хийж, хариугаа comment-ын thread-д бичнэ. Хувийн мэдээллийг [PERSON-0001] зэрэг token-оор далдалсан. Internal Audit – Restricted.';

  // Doc-д тайлангийн өмнө гарчиг, lead байрлах тул тэдгээрт таарсан тоог nth-д нэмнэ
  const pre = `${name}\n${lead}`;
  for (const x of comments) if (x.block) { let i = -1; while ((i = pre.indexOf(x.anchor, i + 1)) >= 0) x.nth++; }
  const all = [name, lead, generalMd, fullMd, rows.join('\n'), ...comments.map(x => x.body)].join('\n');
  const leaks = findLeaks(all, map, allowText);
  const missing = comments.filter(x => !all.includes(x.anchor)).map(x => x.id);
  const leak = { ok: leaks.length === 0, checked_at: C.nowIso(), mask_values_checked: Object.keys(map).length, remaining_leak_tokens: leaks,
    auto_fixed_leaks: stats.restored_leaks, pattern_redactions: stats.pattern, tokens_in_payload: new Set(all.match(C.TOKEN_RE) || []).size };

  const out = { job_id: jobId, mode: 'annotated', name, lead, status_options: STATUS_OPTIONS, general_markdown: generalMd, chunks, comments,
    tracker: { heading: 'Тэмдэглэлүүд ба засварын явц', markdown: rows.join('\n'), blocks }, anchors_not_in_text: missing, leak_check: leak,
    counts: { issues: issues.length, general: general.length, anchored: comments.length - general.length, chunks: chunks.length, report_chars: fullMd.length } };
  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  C.writeJson(path.join(docsDir, 'annotated.json'), out);
  // Дараалал (nth зөв байхын тулд): гарчиг, lead → тайлангийн хэсгүүд → «Тайлан бүхэлд…» хэсэг; tracker тусдаа tab-д
  fs.writeFileSync(path.join(docsDir, 'annotated.md'), `# ${name}\n\n${lead}\n\n${chunks.join('\n\n')}\n\n${generalMd ? generalMd + '\n\n' : ''}---\n\n## ${out.tracker.heading} (тусдаа tab)\n\n${rows.join('\n')}\n`, 'utf8');
  return { ok: leak.ok, name, ...out.counts, anchors_not_in_text: missing.length, remaining_leaks: leaks.length, auto_fixed_leaks: stats.restored_leaks };
}

module.exports = { build };

if (require.main === module) {
  try {
    const r = build(process.argv[2] || '');
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 2);
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}
