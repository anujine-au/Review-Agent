'use strict';
/*
  Review-ийн үр дүнг Claude Docs руу илгээхэд бэлтгэнэ (зөвхөн локал, юу ч илгээхгүй).
    node server/docs_prep.js <jobId>
  Гаралт: jobs/<id>/docs/payload.json, jobs/<id>/docs/payload.md, jobs/<id>/docs/leak_check.json

  Хамгаалалт:
    1) Зөвхөн token-той (далдалсан) sandbox/output-ийг ашиглана — restoreTokens ХИЙХГҮЙ.
    2) Нэмэлт хэв маягаар дахин далдална: РД, имэйл, утас, 10+ оронтой данс/дугаар.
    3) mask_map.json-ийн жинхэнэ утга бүрийг гаралтад хайж, олдвол token-оор солиод дахин шалгана.
       Үлдсэн бол ok=false — Docs руу илгээхгүй.
  Хэрэглэх: /publish-docs <jobId> (Claude Code) нь payload.json-ийг уншиж Doc үүсгэнэ.
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');

const STATUS_OPTIONS = ['Нээлттэй', 'Аудитор засварласан', 'Хянагч баталгаажуулсан', 'Хүлээн зөвшөөрөөгүй'];

// Нэмэлт хэв маяг. Данс/утсыг түлхүүр үгийн ард эсвэл тусгаарлагчтай хэлбэрээр л авна — 10+ оронтой мөнгөн дүнг далдлахгүй.
const EXTRA_RULES = [
  ['ID', /(?<![\p{L}\p{N}])[А-ЯӨҮЁ]{2}\s?\d{8}(?!\d)/gu, 0],
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 0],
  ['PHONE', /(?<!\d)(?<!\d[.,])(?:\+?976[\s-]?)?[6-9]\d{3}[\s-]\d{4}(?!\d)(?![.,]\d)/g, 0],
  ['ACCT', /(данс|дансны дугаар|account|iban)([^\d\r\n]{0,15})(\d{8,16})(?!\d)/giu, 3],
];

/** Текстийг Docs-д аюулгүй болгоно. stats-д тоог нэмнэ. */
function scrub(text, map, stats, allowText) {
  for (const [cat, re, grp] of EXTRA_RULES) {
    text = text.replace(re, (...m) => {
      stats.pattern[cat] = (stats.pattern[cat] || 0) + 1;
      return grp ? m[1] + m[2] + `[${cat}-НУУЦ]` : `[${cat}-НУУЦ]`;
    });
  }
  // Жинхэнэ утга үлдсэн бол token-оор солих (урт нь эхэндээ, том жижиг үсэг ялгахгүй); залгавар хэвээр үлдэнэ
  const pairs = C.sensitivePairs(map, allowText);
  for (let k = 0; k < pairs.length; k += 300) {
    const chunk = pairs.slice(k, k + 300);
    const re = new RegExp(`${C.WB}(${chunk.map(([, v]) => C.stemRe(v)).join('|')})(?=${C.MN_SUFFIX}${C.WE})`, 'giu');
    text = text.replace(re, m => {
      stats.restored_leaks++;
      const l = m.toLowerCase();
      const hit = chunk.find(([, v]) => v.toLowerCase() === l) || chunk.find(([, v]) => C.endsVowel(v) && v.toLowerCase().slice(0, -1) === l);
      return hit ? hit[0] : '[НУУЦ]';
    });
  }
  return text;
}
const findLeaks = C.findLeaks;

const cell = s => String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim() || '—';

function splitSections(md) {
  const out = [];
  let cur = null;
  for (const line of md.replace(/\r/g, '').split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { cur = { heading: h[1].trim(), body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push(line);
  }
  return out.map(s => ({ heading: s.heading, markdown: s.body.join('\n').trim() }));
}

function prepare(jobId) {
  if (!/^[\w-]+$/.test(jobId)) throw new Error('Буруу job id');
  const dir = path.join(C.PATHS.jobs, jobId);
  const outDir = path.join(dir, 'sandbox', 'output');
  const mdFile = path.join(outDir, 'review_report.md'), fjFile = path.join(outDir, 'review_findings.json');
  if (!fs.existsSync(mdFile) || !fs.existsSync(fjFile)) throw new Error('Review дуусаагүй эсвэл үр дүн алга');
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  if (job.mask === false) throw new Error('Энэ review далдлалтгүй хийгдсэн — Docs руу илгээх боломжгүй');
  const map = C.readJson(path.join(dir, 'mask_map.json')) || {};
  const findings = C.readJson(fjFile);
  if (!findings) throw new Error('review_findings.json уншигдсангүй');

  const stats = { pattern: {}, restored_leaks: 0 };
  const audit = findings.audit || {};
  const allowText = [audit.name, audit.code, audit.branch].join(' ');
  const S = t => scrub(String(t ?? ''), map, stats, allowText);

  const review = findings.review || {};
  const name = S(`Review — ${[audit.code, audit.branch].filter(Boolean).join(' ') || jobId}`);
  // SP-118-04: R1–R4 (хуучин v2: MAJOR→R1, MODERATE→R2, MINOR→R3; v1: CRITICAL→R1, MAJOR→R2)
  const ver = Number(findings.schema_version) || 0;
  const sevN = s => { s = String(s || '').toUpperCase(); const r = s.match(/^R([1-4])/); if (r) return 'R' + r[1];
    return ver >= 2 ? (s.startsWith('MAJ') || s.startsWith('CRIT') ? 'R1' : s.startsWith('MOD') ? 'R2' : 'R3') : (s.startsWith('CRIT') ? 'R1' : s.startsWith('MAJ') ? 'R2' : 'R3'); };
  const SEV_L = { R1: 'R1 Ноцтой', R2: 'R2 Томоохон', R3: 'R3 Бага', R4: 'R4 Санал' };
  const VERDICT = { READY: 'Батлахад бэлэн', READY_WITH_FIXES: 'Засвартайгаар батлах боломжтой', NOT_READY: 'Батлахад бэлэн биш — засварлуулах', ESCALATE: 'Захиралд нэн даруй мэдэгдэх', RUN_REJECTED: 'Хяналт эхлэх боломжгүй' };
  const vRaw = String(review.verdict || '').toUpperCase(), d0 = String(review.decision || '');
  const verdict = VERDICT[vRaw] || (d0.startsWith('Батлахад бэлэн') ? VERDICT.READY : /^(Бага засвартай|Засвартай)/.test(d0) ? VERDICT.READY_WITH_FIXES
    : d0.startsWith('Буцааж') ? VERDICT.NOT_READY : /CANNOT/i.test(d0) ? VERDICT.RUN_REJECTED : d0 || 'Тодорхойгүй');
  // Захирлын шийдвэр: татгалзсан санал аудиторт очихгүй; засаж зөвшөөрсөн бол засварласан текст
  const decs = C.readJson(path.join(dir, 'decisions.json')) || {};
  const decOf = id => { const v = String(decs[id]?.decision || '').toUpperCase(); return v === 'ACCEPTED' ? 'APPROVED' : v; };
  const issues = (findings.issues || []).map(it => ({ ...it, severity: sevN(it.severity) })).filter(it => decOf(it.id) !== 'REJECTED');
  const cnt = ['R1', 'R2', 'R3', 'R4'].map(k => issues.filter(i => i.severity === k).length);
  const lead = S(`Эцсийн санал: **${verdict}** — R1 ${cnt[0]} / R2 ${cnt[1]} / R3 ${cnt[2]} / R4 ${cnt[3]}. ${findings.headline || ''}`.trim())
    + '\n\n> Internal Audit – Restricted. Reviewer decision support — эцсийн шийдвэрийг ДАГ-ын захирал гаргана. Хувийн мэдээллийг `[PERSON-0001]` зэрэг token-оор далдалсан.';

  // Саналын хүснэгт — Төлөв баганад dropdown chip
  const rows = ['| ID | Зэрэглэл | Байршил | Асуудал | Засах | Аудиторын хариу | Төлөв |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const blocks = {};
  issues.forEach((it, i) => {
    const key = `st${i + 1}`;
    blocks[key] = { type: 'dropdown', enum: '$lid:s', index: 0 };
    const fix = decOf(it.id) === 'EDITED' && decs[it.id].edited_text ? decs[it.id].edited_text : it.required_action;
    rows.push(`| ${cell(it.id)} | ${cell(SEV_L[it.severity])} | ${cell(S(it.anchor))} | ${cell(S(it.title || it.issue))} | ${cell(S(fix))} |  | <?claude block ${key}?> |`);
  });
  const tracker = {
    heading: 'Тэмдэглэлүүд ба засварын явц',
    markdown: `Аудитор «Аудиторын хариу» баганыг бөглөж, Төлөвийг өөрчилнө; хянагч баталгаажуулна. Тэмдэглэл бүрийн дэлгэрэнгүйг доорх хэсгүүдээс харна.\n\n${rows.join('\n')}`,
    blocks,
  };

  const sections = [];
  for (const s of splitSections(fs.readFileSync(mdFile, 'utf8'))) {
    const h = s.heading.replace(/^\d+\.\s*/, '');
    if (/^(Тэмдэглэлүүд|Саналууд)/i.test(h)) { sections.push({ key: 'tracker', ...tracker }); continue; }
    if (!s.markdown) continue;
    sections.push({ key: `s${sections.length + 1}`, heading: S(h), markdown: S(s.markdown) });
  }
  if (!sections.some(s => s.key === 'tracker')) sections.splice(1, 0, { key: 'tracker', ...tracker });
  sections.push({
    key: 'roles', heading: 'Эрх ба ажлын урсгал',
    markdown: [
      'Эрхийг Doc-ийн дээд талын **Share** товчоор эзэмшигч олгоно (зөвхөн байгууллагын хүрээнд).',
      '',
      '| Role | Docs эрх | Үүрэг |',
      '| --- | --- | --- |',
      '| Салбарын аудитор | Edit | «Аудиторын хариу» бөглөх, Төлөв → Аудитор засварласан |',
      '| Хянагч (reviewer) | Edit | Хариуг шалгах, Төлөв → Хянагч баталгаажуулсан / Хүлээн зөвшөөрөөгүй |',
      '| Удирдлага (ДАГ-ын дарга, CAE) | View | Явцыг харах |',
      '',
      '1. Аудитор засвар хийгээд мөрөнд comment бичиж **Claude руу илгээнэ** — Claude дүрмийн дагуу шалгаж thread-д хариулна.',
      '2. Хянагч Claude Code-д `/sync-docs ' + jobId + '` гэж бичихэд сүүлийн өөрчлөлтүүдийг уншиж, бүх шинэ хариуг шалгана.',
      '3. Засварласан тайлангийн шинэ хувилбарыг вэб хэрэглүүрээр дахин review хийлгэнэ.',
    ].join('\n'),
  });

  // Эцсийн шалгалт
  const all = [name, lead, ...sections.map(s => `${s.heading}\n${s.markdown}`)].join('\n');
  const leaks = findLeaks(all, map, allowText);
  const tokens = new Set(all.match(C.TOKEN_RE) || []);
  const leak = {
    ok: leaks.length === 0,
    checked_at: C.nowIso(),
    mask_values_checked: Object.keys(map).length,
    remaining_leak_tokens: leaks,
    auto_fixed_leaks: stats.restored_leaks,
    pattern_redactions: stats.pattern,
    tokens_in_payload: tokens.size,
    issues: issues.length,
  };

  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const payload = { job_id: jobId, name, lead, status_options: STATUS_OPTIONS, sections, leak_check: leak };
  C.writeJson(path.join(docsDir, 'payload.json'), payload);
  C.writeJson(path.join(docsDir, 'leak_check.json'), leak);
  fs.writeFileSync(path.join(docsDir, 'payload.md'),
    `# ${name}\n\n${lead}\n\n${sections.map(s => `## ${s.heading}\n\n${s.markdown}`).join('\n\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(docsDir, 'payload.google.html'), toGoogleHtml(payload), 'utf8');
  return { ...leak, name, sections: sections.length, docs_state: C.readJson(path.join(docsDir, 'state.json')) };
}

/* ---------- Google Docs (Drive-аар HTML → Google Doc хөрвүүлнэ) ---------- */
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<i>$2</i>');
function mdToHtml(md) {
  const out = [], lines = md.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const body = rows.filter(r => !/^\s*\|?\s*:?-{3,}/.test(r)).map(cells);
      out.push('<table border="1" cellpadding="4" style="border-collapse:collapse">' + body.map((r, k) =>
        '<tr>' + r.map(c => k === 0 ? `<th style="background:#eeeeee">${inline(c)}</th>` : `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</table>');
      continue;
    }
    const ul = /^\s*[-*]\s+/, ol = /^\s*\d+\.\s+/;
    if (ul.test(l) || ol.test(l)) {
      const re = ul.test(l) ? ul : ol, tag = re === ul ? 'ul' : 'ol', items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(l)) { out.push(`<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`); i++; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  return out.join('\n');
}
function googleSections(p) {
  return p.sections.map(s => {
    let md = s.markdown.replace(/<\?claude block st\d+\?>/g, p.status_options[0]);
    if (s.key === 'tracker') md = md.replace(/Аудитор «Аудиторын хариу».*?\n/, `Аудитор «Аудиторын хариу» баганыг бөглөж, Төлөвийг дараах утгуудын нэгээр бичнэ: ${p.status_options.join(' / ')}. Тэмдэглэл бүрийн дэлгэрэнгүйг доорх хэсгүүдээс харна.\n`);
    if (s.key === 'roles') md = [
      'Эрхийг Doc-ийн **Share** товчоор (эсвэл Claude Code-оор) зөвхөн байгууллагын имэйлд олгоно.',
      '',
      '| Role | Google эрх | Үүрэг |',
      '| --- | --- | --- |',
      '| Салбарын аудитор | Editor | «Аудиторын хариу» бөглөх, Төлөв → Аудитор засварласан |',
      '| Хянагч (reviewer) | Editor | Хариуг шалгах, Төлөв → Хянагч баталгаажуулсан / Хүлээн зөвшөөрөөгүй |',
      '| Удирдлага (ДАГ-ын дарга, CAE) | Viewer | Явцыг харах |',
      '',
      '1. Аудитор засвар хийгээд асуулт, тайлбараа тухайн мөрөнд comment-оор бичнэ.',
      `2. Хянагч Claude Code-д \`/sync-docs ${p.job_id}\` гэж бичихэд хариу, comment-уудыг уншиж, мөр бүрт дүгнэлт гаргана.`,
      '3. Засварласан тайлангийн шинэ хувилбарыг вэб хэрэглүүрээр дахин review хийлгэнэ.',
    ].join('\n');
    return { heading: s.heading, markdown: md };
  });
}
/** Google-д оруулах масктай Markdown (Word экспортод ашиглана) */
function googleMarkdown(p) {
  return `# ${p.name}\n\n${p.lead}\n\n${googleSections(p).map(s => `## ${s.heading}\n\n${s.markdown}`).join('\n\n')}\n`;
}
function toGoogleHtml(p) {
  const secs = googleSections(p).map(s => `<h2>${inline(s.heading)}</h2>\n${mdToHtml(s.markdown)}`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(p.name)}</title></head><body>\n<h1>${escHtml(p.name)}</h1>\n${mdToHtml(p.lead)}\n${secs.join('\n')}\n</body></html>\n`;
}

module.exports = { prepare, scrub, findLeaks, toGoogleHtml, googleMarkdown, STATUS_OPTIONS };

if (require.main === module) {
  try {
    const r = prepare(process.argv[2] || '');
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 2);
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}
