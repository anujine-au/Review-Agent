'use strict';
/*
  Тайлан дээр шууд засах (аудитор / ахлах аудитор, 2026-10-16).
  Захирлын буцаасан санал бүрийн ишлэлийг (quote) санал болгосон эсвэл аудиторын бичсэн текстээр .docx дотор солино.
  Эх файл (originals/) хэзээ ч өөрчлөгдөхгүй:
    jobs/<root>/edits/v<n>/log.json     — засвар бүр: хуучин / шинэ текст, хэн, хэзээ, төлөв (applied | reverted)
    jobs/<root>/edits/v<n>/working.docx — эх файл дээр «applied» засваруудыг дарааллаар нь дахин хэрэглэж үүсгэсэн хувилбар
  Буцаах = тухайн засварыг «reverted» болгоод эх файлаас дахин үүсгэнэ — давхцсан засвар байсан ч зөв буцна.
  Зөвхөн нэг догол мөр (эсвэл хүснэгтийн нүд) доторх текстийг солино; хэлбэржүүлэлт нь эхний run-ийнхаар үлдэнэ.
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const WF = require('./workflow');
const ORIG = require('./originals');
const { readZip } = require('./extract');
const { zip } = require('./export');
const { normMap, cleanQuote } = require('./verify');
const SUG = require('./suggest');

const jdir = id => path.join(C.PATHS.jobs, id);
const edDir = (rootId, n) => path.join(jdir(rootId), 'edits', `v${n}`);
const logFile = (rootId, n) => path.join(edDir(rootId, n), 'log.json');
const MAX_TEXT = 4000;

/* ---------- document.xml: догол мөр, текстийн хэсгүүд (байрлалтай) ---------- */
const TAG_RE = /<(\/?)w:(p|t|tbl|tr|tab|br|cr)(?=[\s>/])([^>]*?)(\/?)>/g;
const decode = s => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (m, e) => {
  const l = e.toLowerCase();
  if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
  try { return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10)); } catch { return m; }
});
const encode = s => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Догол мөр бүр: { id: 'P12' | 'T3R2' | null, text, chars: [{ seg, off }] , segs: [{ open, cStart, cEnd, attrs, text }] }
 * Дугаарлалт extract.js-тэй ижил: биеийн хоосон биш догол мөр P1…, дээд түвшний хүснэгт T1…, мөр R1…
 */
function scan(xml) {
  const paras = [], stack = [];
  let tbl = 0, tNo = 0, row = 0, pNo = 0, m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(xml))) {
    const [, close, name, attrs, self] = m;
    if (name === 'p') {
      if (self) continue;
      if (!close) { stack.push({ segs: [], chars: [], text: '', tbl, tNo, row, nested: stack.length > 0, start: m.index, openEnd: TAG_RE.lastIndex }); continue; }
      const p = stack.pop();
      if (!p) continue;
      p.end = m.index;   // </w:p>-ийн байрлал (comment-ийн тэмдэглэгээнд)
      if (!p.text.trim()) continue;
      if (!p.nested && !p.tbl) p.id = `P${++pNo}`;
      else if (p.tbl) p.id = `T${p.tNo}R${p.row}`;
      paras.push(p);
    } else if (name === 'tbl') {
      if (self) continue;
      if (close) tbl = Math.max(0, tbl - 1); else if (++tbl === 1) { tNo++; row = 0; }
    } else if (name === 'tr') {
      if (!close && !self && tbl === 1) row++;
    } else if (name === 't') {
      if (close || self) continue;
      const top = stack[stack.length - 1];
      const end = xml.indexOf('</w:t>', TAG_RE.lastIndex);
      if (end < 0) break;
      if (top) {
        const text = decode(xml.slice(TAG_RE.lastIndex, end));
        const seg = { open: m.index, cStart: TAG_RE.lastIndex, cEnd: end, attrs, text };
        const si = top.segs.push(seg) - 1;
        for (let k = 0; k < text.length; k++) top.chars.push({ seg: si, off: k });
        top.text += text;
      }
      TAG_RE.lastIndex = end + 6;
    } else if (!close) {   // tab / br / cr — зай (засахгүй, зөвхөн хайлтад)
      const top = stack[stack.length - 1];
      if (top) { top.chars.push({ seg: -1, el: self ? [m.index, TAG_RE.lastIndex] : null }); top.text += ' '; }
    }
  }
  return paras;
}

const anchorId = a => { const k = String(a || '').toUpperCase().replace(/[[\]\s]/g, '').match(/^(P\d+|T\d+)(R\d+)?/); return k ? k[1] + (k[2] || '') : null; };

/** Ишлэлийг баримтаас олох: { p, a, b } (p.text доторх байрлал) эсвэл { error } */
function locate(paras, oldText, anchor) {
  const q = cleanQuote(oldText);
  if (!q) return { error: 'empty' };
  const hits = [];
  for (const p of paras) {
    const { n, map } = normMap(p.text);
    for (let i = n.indexOf(q); i >= 0; i = n.indexOf(q, i + 1)) hits.push({ p, a: map[i], b: map[i + q.length - 1] + 1 });
  }
  if (!hits.length) return { error: 'not_found' };
  const k = anchorId(anchor);
  const near = k ? hits.filter(h => h.p.id === k || (h.p.id || '').startsWith(k + 'R')) : [];
  if (near.length) return near[0];
  if (hits.length === 1) return hits[0];
  return { error: 'ambiguous', count: hits.length };
}

/** p.text-ийн [a, b) хэсгийг шинэ текстээр солино — xml-ийг буцаана */
function replaceRange(xml, p, a, b, newText) {
  const touched = new Map();   // seg → [from, to)
  const ops = [];              // [эхлэл, төгсгөл, орлуулах] — xml-д ардаас нь хэрэглэнэ
  for (let i = a; i < b; i++) {
    const c = p.chars[i];
    if (c && c.el) ops.push([c.el[0], c.el[1], '']);   // солих хэсэг доторх таб / мөр шилжүүлэг хамт солигдоно
    if (!c || c.seg < 0) continue;
    const r = touched.get(c.seg);
    if (r) r[1] = c.off + 1; else touched.set(c.seg, [c.off, c.off + 1]);
  }
  if (!touched.size) {
    // Сонгосон хэсэг бүхэлдээ зай/таб — дараагийн текстийн хэсгийн эхэнд оруулна
    const c = p.chars.slice(a).find(x => x.seg >= 0) || [...p.chars].reverse().find(x => x.seg >= 0);
    if (!c) return null;
    touched.set(c.seg, [c.off, c.off]);
  }
  const segs = [...touched.keys()].sort((x, y) => x - y);
  const out = segs.map((si, idx) => {
    const s = p.segs[si], [f, t] = touched.get(si);
    return { s, text: s.text.slice(0, f) + (idx === 0 ? newText : '') + s.text.slice(t) };
  });
  for (const { s, text } of out) {
    const attrs = /xml:space\s*=/.test(s.attrs) ? s.attrs : `${s.attrs} xml:space="preserve"`;
    ops.push([s.open, s.cEnd, `<w:t${attrs}>` + encode(text)]);
  }
  for (const [st, en, rep] of ops.sort((x, y) => y[0] - x[0])) xml = xml.slice(0, st) + rep + xml.slice(en);
  return xml;
}

/* ---------- Track Changes (AI-ийн автомат засвар): хуучныг <w:del>, шинийг <w:ins> болгоно ---------- */
const AI_AUTHOR = 'AI засвар (захирал баталсан санал)';
const wDate = () => new Date().toISOString().slice(0, 19) + 'Z';
const attrEnc = s => encode(s).replace(/"/g, '&quot;');
// w:t-г агуулсан run-ийн хил: <w:r …>, rPr, w:t-ийн өмнөх / дараах хүүхдүүд
function runOf(xml, s) {
  const start = Math.max(xml.lastIndexOf('<w:r>', s.open), xml.lastIndexOf('<w:r ', s.open));
  const close = xml.indexOf('</w:r>', s.cEnd);
  if (start < 0 || close < 0) return null;
  const tagEnd = xml.indexOf('>', start) + 1;
  let body = tagEnd, rPr = '';
  if (xml.startsWith('<w:rPr', tagEnd)) { const e = xml.indexOf('</w:rPr>', tagEnd); if (e < 0 || e > s.open) return null; body = e + 8; rPr = xml.slice(tagEnd, body); }
  if (xml.slice(body, s.open).includes('<w:t') || xml.slice(s.cEnd + 6, close).includes('<w:t')) return null;   // нэг run-д олон w:t — энгийн солилт
  return { start, end: close + 6, tag: xml.slice(start, tagEnd), rPr, before: xml.slice(body, s.open), after: xml.slice(s.cEnd + 6, close) };
}
function trackRange(xml, p, a, b, newText, ids) {
  const touched = new Map();
  for (let i = a; i < b; i++) { const c = p.chars[i]; if (!c || c.seg < 0) continue; const r = touched.get(c.seg); if (r) r[1] = c.off + 1; else touched.set(c.seg, [c.off, c.off + 1]); }
  if (!touched.size) return null;
  const segs = [...touched.keys()].sort((x, y) => x - y), runs = segs.map(si => runOf(xml, p.segs[si]));
  if (runs.some(r => !r) || new Set(runs.map(r => r.start)).size !== runs.length) return null;
  const T = t => `<w:t xml:space="preserve">${encode(t)}</w:t>`, D = wDate(), A = attrEnc(AI_AUTHOR);
  const ops = segs.map((si, idx) => {
    const s = p.segs[si], [f, t] = touched.get(si), r = runs[idx];
    const pre = s.text.slice(0, f), del = s.text.slice(f, t), post = s.text.slice(t);
    let out = '';
    if (pre || r.before) out += r.tag + r.rPr + r.before + (pre ? T(pre) : '') + '</w:r>';
    if (del) out += `<w:del w:id="${ids.next()}" w:author="${A}" w:date="${D}"><w:r>${r.rPr}<w:delText xml:space="preserve">${encode(del)}</w:delText></w:r></w:del>`;
    if (idx === 0 && newText) out += `<w:ins w:id="${ids.next()}" w:author="${A}" w:date="${D}"><w:r>${r.rPr}${T(newText)}</w:r></w:ins>`;
    if (post || r.after) out += r.tag + r.rPr + (post ? T(post) : '') + r.after + '</w:r>';
    return [r.start, r.end, out];
  });
  for (const [st, en, rep] of ops.sort((x, y) => y[0] - x[0])) xml = xml.slice(0, st) + rep + xml.slice(en);
  return xml;
}
const idGen = start => { let k = start; return { next: () => k++ }; };

/** Нэг засвар хэрэглэх: { xml, before, after, id } эсвэл { error }. ids өгвөл (AI-ийн засвар) Track Changes-ээр */
function applyOne(xml, e, ids) {
  const paras = scan(xml);
  const hit = locate(paras, e.old, e.anchor);
  if (hit.error) return hit;
  const next = (ids && trackRange(xml, hit.p, hit.a, hit.b, e.new, ids)) || replaceRange(xml, hit.p, hit.a, hit.b, e.new);
  if (next == null) return { error: 'not_found' };
  const before = hit.p.text;
  return { xml: next, id: hit.p.id, before, after: before.slice(0, hit.a) + e.new + before.slice(hit.b) };
}

/* ---------- Word comment: догол мөр (эсвэл хүснэгтийн мөрийн эхний нүд)-ийг бүхэлд нь тэмдэглэнэ ---------- */
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function addComments(entries, xml, comments, ids) {
  if (!comments.length) return xml;
  const paras = scan(xml), first = paras.find(p => p.id);
  const ops = [], parts = [], D = wDate();
  for (const c of comments) {
    const p = paras.find(x => x.id === c.block) || paras.find(x => c.block && (x.id || '').startsWith(c.block + 'R')) || first;
    if (!p) continue;
    const k = ids.next();
    let at = p.openEnd;
    if (xml.startsWith('<w:pPr', at)) { const e = xml.indexOf('</w:pPr>', at); if (e > 0 && e < p.end) at = e + 8; }
    ops.push([at, `<w:commentRangeStart w:id="${k}"/>`], [p.end, `<w:commentRangeEnd w:id="${k}"/><w:r><w:commentReference w:id="${k}"/></w:r>`]);
    parts.push(`<w:comment w:id="${k}" w:author="${attrEnc(c.author || AI_AUTHOR)}" w:date="${D}" w:initials="AI">${String(c.text).split(/\n+/).map(l => `<w:p><w:r><w:t xml:space="preserve">${encode(l)}</w:t></w:r></w:p>`).join('')}</w:comment>`);
  }
  for (const [pos, ins] of ops.sort((x, y) => y[0] - x[0])) xml = xml.slice(0, pos) + ins + xml.slice(pos);
  const get = n => entries.find(e => e.name === n);
  const cm = get('word/comments.xml');
  if (cm) cm.data = Buffer.from(cm.data.toString('utf8').replace(/<\/w:comments>\s*$/, parts.join('') + '</w:comments>'), 'utf8');
  else {
    entries.push({ name: 'word/comments.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W_NS}">${parts.join('')}</w:comments>`, 'utf8') });
    const rels = get('word/_rels/document.xml.rels');
    if (rels) rels.data = Buffer.from(rels.data.toString('utf8').replace('</Relationships>', '<Relationship Id="rIdAiComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>'), 'utf8');
    const ct = get('[Content_Types].xml');
    if (ct && !ct.data.toString('utf8').includes('/word/comments.xml')) ct.data = Buffer.from(ct.data.toString('utf8').replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'), 'utf8');
  }
  return xml;
}

/**
 * Эх .docx + засварууд → { buf, results: { seq: 'ok' | error } }
 * opts.track: AI-ийн (auto) засварыг Track Changes-ээр; opts.comments: [{ block, text }] — Word comment
 */
function build(baseBuf, edits, opts = {}) {
  const z = readZip(baseBuf);
  let xml = z.get('word/document.xml');
  if (!xml) throw new Error('word/document.xml олдсонгүй');
  xml = xml.toString('utf8');
  const results = {}, ids = idGen(880000);
  for (const e of edits) {
    if (e.status !== 'applied') continue;
    const r = applyOne(xml, e, opts.track && e.auto ? ids : null);
    if (r.error) results[e.seq] = r.error; else { xml = r.xml; results[e.seq] = 'ok'; }
  }
  const entries = z.names.filter(n => !n.endsWith('/')).map(n => ({ name: n, data: z.get(n) }));
  xml = addComments(entries, xml, opts.comments || [], ids);
  entries.find(e => e.name === 'word/document.xml').data = Buffer.from(xml, 'utf8');
  return { buf: zip(entries), xml, results };
}

/* ---------- Feedback, эх файл ---------- */
function feedback(rootId, n) {
  const raw = WF.releasedVersions(rootId).includes(n) ? fs.readFileSync(path.join(jdir(rootId), 'feedback', `feedback_v${n}.json`), 'utf8') : null;
  return raw ? JSON.parse(C.restoreTokens(jdir(rootId), raw, true)) : null;
}
/** Санал болгох найруулга: feedback-д байхгүй (хуучин) бол тухайн хувилбарын review / дахин хяналтаас хайна */
function suggestionOf(rootId, fb, item) {
  if (item.suggested_text) return item.suggested_text;
  for (const job of [fb.job, ...WF.chain(rootId).slice().reverse()]) {
    const out = path.join(jdir(job), 'sandbox', 'output');
    const f = C.readJson(path.join(out, 'review_findings.json')), rc = C.readJson(path.join(out, 'recheck.json'));
    const hit = [...(f?.issues || []), ...(rc?.new_issues || [])].find(x => x.id === item.id && x.suggested_text);
    if (hit) return C.restoreTokens(jdir(job), String(hit.suggested_text));
  }
  return '';
}
function baseOf(fb) {
  const list = ORIG.list(jdir(fb.job)).filter(x => x.cat === 'report');
  const docx = list.find(x => /\.docx$/i.test(x.name));
  if (!docx) return { reason: list.length ? 'Тайлан .docx биш (PDF г.м.) — шууд засах боломжгүй. Засвараа эх файлдаа хийнэ үү.' : 'Энэ хувилбарын тайлангийн эх файл хадгалагдаагүй байна.' };
  const f = ORIG.fileOf(jdir(fb.job), docx.cat, docx.name);
  return f ? { file: f.path, name: docx.name, sha256: docx.sha256, job: fb.job } : { reason: 'Тайлангийн эх файл олдсонгүй.' };
}
const readLog = (rootId, n) => C.readJson(logFile(rootId, n)) || { version: n, edits: [] };

/* ---------- AI-ийн автомат засвар (server/autofix.js): төлөв, Word comment ---------- */
const afFile = (rootId, n) => path.join(edDir(rootId, n), 'autofix.json');
const autofixOf = (rootId, n) => C.readJson(afFile(rootId, n));
const DRAFT_TAG = 'АУДИТОР БАТАЛГААЖУУЛАХ';
// Track Changes-тэй хувилбарын comment: AI-ийн засвар бүрийн шалтгаан, ноорог, AI засаж чадаагүй санал (аудитор юу хийх)
function commentsOf(rootId, n, log) {
  const af = autofixOf(rootId, n), fb = af && feedback(rootId, n);
  if (!fb) return [];
  const real = s => C.restoreTokens(jdir(rootId), String(s || ''));
  const out = [];
  for (const it of fb.items || []) {
    const st = af.items?.[it.id]; if (!st) continue;
    const head = `${it.id} · ${it.title || ''}`.trim();
    const ed = log.edits.find(e => e.auto && e.rv_id === it.id && e.status === 'applied' && (!e.result || e.result === 'ok'));
    if (ed) {
      const lines = [`AI засвар — ${head}`];
      if (ed.note) lines.push(real(ed.note));
      if (ed.draft) lines.push(`⚠ Ноорог: «[${DRAFT_TAG}: …]» гэсэн хэсгийг нотолгоотой тулгаж бөглөөд тэмдэглэгээг арилгана уу.`);
      const none = (ed.numbers || []).filter(x => x.src === 'none').map(x => x.n);
      if (none.length) lines.push(`⚠ Шинэ тоо (${none.join(', ')}) тайлан, саналд алга — эх сурвалжтай тулгана уу.`);
      out.push({ block: ed.block, text: lines.join('\n') });
    } else if (st.status !== 'pending') {
      const k = String(it.anchor || '').toUpperCase().replace(/[[\]\s]/g, '').match(/^(P\d+|T\d+)(R\d+)?/);
      out.push({ block: k ? k[1] + (k[2] || '') : null, text: [`Гараар засах — ${head}`, it.required_action ? `Хийх: ${it.required_action}` : '', st.reason ? `AI: ${real(st.reason)}` : ''].filter(Boolean).join('\n') });
    }
  }
  return out;
}

function save(rootId, n, log, base) {
  const src = fs.readFileSync(base.file);
  const { buf, results } = build(src, log.edits);
  for (const e of log.edits) e.result = e.status === 'applied' ? results[e.seq] : undefined;
  fs.mkdirSync(edDir(rootId, n), { recursive: true });
  fs.writeFileSync(path.join(edDir(rootId, n), 'working.docx'), buf);
  // Word-оор хянах хувилбар: AI-ийн засвар Track Changes-ээр, тайлбар comment-оор
  const comments = commentsOf(rootId, n, log), tracked = path.join(edDir(rootId, n), 'working_tracked.docx');
  if (comments.length || log.edits.some(e => e.auto && e.status === 'applied')) fs.writeFileSync(tracked, build(src, log.edits, { track: true, comments }).buf);
  else fs.rmSync(tracked, { force: true });
  C.writeJson(logFile(rootId, n), { ...log, base: { job: base.job, name: base.name, sha256: base.sha256 }, updated_at: C.nowIso() });
  return results;
}

/* ---------- Нээлттэй функцүүд ---------- */
/** Төлөв: санал бүрийн хуучин / санал болгох текст, хийсэн засварууд */
function state(rootId, n) {
  const fb = feedback(rootId, n);
  if (!fb) return { error: 'Энэ хувилбарт feedback илгээгдээгүй байна', code: 404 };
  const base = baseOf(fb), log = readLog(rootId, n);
  // Ишлэлгүй ч байршилтай санал — AI-аар засах хэсгийг сонгуулж болно
  const items = (fb.items || []).filter(x => x.quote || x.anchor).map(x => ({ id: x.id, old: x.quote || '', suggested: x.quote ? suggestionOf(rootId, fb, x) : '' }));
  const applied = log.edits.filter(e => e.status === 'applied');
  const af = autofixOf(rootId, n);
  const afSum = af ? { state: af.state, total: af.total || 0, done: af.done || 0, error: af.error || '', started: af.started, finished: af.finished || null,
    fixed: Object.values(af.items || {}).filter(x => x.status === 'applied').length, manual: Object.values(af.items || {}).filter(x => !['applied', 'pending'].includes(x.status)).length,
    drafts: applied.filter(e => e.auto && e.draft).length } : null;
  return { version: n, available: !base.reason, reason: base.reason || '', base_name: base.name || '', items, ai: SUG.list(rootId, n), edits: log.edits,
    applied: applied.length, conflicts: applied.filter(e => e.result && e.result !== 'ok').length, updated_at: log.updated_at || null,
    autofix: afSum, tracked: fs.existsSync(path.join(edDir(rootId, n), 'working_tracked.docx')) };
}

function prepare(rootId, n, rvId, newText, oldText) {
  const fb = feedback(rootId, n);
  if (!fb) return { error: 'Энэ хувилбарт feedback илгээгдээгүй байна', code: 404 };
  const item = (fb.items || []).find(x => x.id === rvId);
  if (!item) return { error: 'Санал олдсонгүй', code: 404 };
  // Солих хэсэг: AI-ийн сонгосон (эсвэл аудиторын заасан) хэсэг, үгүй бол ишлэл
  const old = String(oldText || item.quote || '').replace(/\s+/g, ' ').trim();
  if (!old) return { error: 'Энэ саналд тайлангаас иш татсан хэсэг алга — «✨ AI-аар найруулга» дарж солих хэсгийг сонгуулна уу', code: 409 };
  if (old.length > MAX_TEXT) return { error: `Солих хэсэг хэт урт (${MAX_TEXT} тэмдэгтээс ихгүй)`, code: 400 };
  const base = baseOf(fb);
  if (base.reason) return { error: base.reason, code: 409 };
  const text = String(newText ?? '').replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');
  if (text.length > MAX_TEXT) return { error: `Текст хэт урт (${MAX_TEXT} тэмдэгтээс ихгүй)`, code: 400 };
  return { fb, item, base, text, old, log: readLog(rootId, n) };
}
const ERR = {
  not_found: 'Иш татсан хэсэг одоогийн тайлангаас олдсонгүй (өмнөх засвараар өөрчлөгдсөн эсвэл ишлэл тайлантай яг таарахгүй байна). Эх файлдаа гараар засна уу.',
  ambiguous: 'Иш татсан хэсэг тайланд олон газар давтагдаж байна — аль нь болохыг тодорхойлох боломжгүй. Эх файлдаа гараар засна уу.',
  empty: 'Иш татсан хэсэг хоосон байна.',
};

/** Урьдчилан харах: тухайн догол мөр засварын өмнө / дараа */
function preview(rootId, n, rvId, newText, oldText) {
  const p = prepare(rootId, n, rvId, newText, oldText);
  if (p.error) return p;
  const cur = build(fs.readFileSync(p.base.file), p.log.edits);
  const r = applyOne(cur.xml, { old: p.old, new: p.text, anchor: p.item.anchor });
  if (r.error) return { error: ERR[r.error] || r.error, code: 409 };
  return { ok: true, block: r.id, before: r.before, after: r.after };
}

/** Засвар хэрэглэх (зөвшөөрөх) */
function apply(rootId, n, rvId, newText, by, oldText) {
  const p = prepare(rootId, n, rvId, newText, oldText);
  if (p.error) return p;
  if (cleanQuote(p.text) === cleanQuote(p.old)) return { error: 'Шинэ текст хуучинтайгаа ижил байна', code: 400 };
  const seq = (p.log.edits.reduce((s, e) => Math.max(s, e.seq), 0) || 0) + 1;
  const edit = { seq, rv_id: rvId, old: p.old, new: p.text, anchor: p.item.anchor || null, by, at: C.nowIso(), status: 'applied' };
  // Эхлээд одоогийн хувилбар дээр хэрэгжих эсэхийг шалгана
  const cur = build(fs.readFileSync(p.base.file), p.log.edits);
  const r = applyOne(cur.xml, edit);
  if (r.error) return { error: ERR[r.error] || r.error, code: 409 };
  p.log.edits.push({ ...edit, block: r.id, before: r.before, after: r.after });
  save(rootId, n, p.log, p.base);
  return { ok: true, edit: p.log.edits[p.log.edits.length - 1] };
}

/**
 * AI-ийн автомат засвар (server/autofix.js): SUG-ийн санал (жинхэнэ утгаар) — { ok, edit } эсвэл { error }.
 * Аудиторын засвартай ижил log-д «auto» тэмдэгтэй орно — вэб дээр харагдаж, нэг бүрчлэн буцаагдана.
 */
function applyAuto(rootId, n, rvId, sug) {
  const fb = feedback(rootId, n);
  if (!fb) return { error: 'feedback алга' };
  const item = (fb.items || []).find(x => x.id === rvId);
  const base = baseOf(fb);
  if (!item || base.reason) return { error: base.reason || 'Санал олдсонгүй' };
  const log = readLog(rootId, n);
  if (log.edits.some(e => e.rv_id === rvId && e.status === 'applied')) return { error: 'Аудитор аль хэдийн зассан' };
  const text = String(sug.new || '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!text || text.length > MAX_TEXT) return { error: 'Шинэ текст хоосон эсвэл хэт урт' };
  const seq = (log.edits.reduce((m, e) => Math.max(m, e.seq), 0) || 0) + 1;
  const edit = { seq, rv_id: rvId, old: sug.old, new: text, anchor: sug.block || item.anchor || null, by: 'AI (автомат)', at: C.nowIso(), status: 'applied', auto: true,
    note: sug.note || '', ai_run_id: sug.ai_run_id || null, numbers: sug.numbers || [], draft: text.includes(DRAFT_TAG) || (sug.numbers || []).some(x => x.src === 'none') };
  const cur = build(fs.readFileSync(base.file), log.edits);
  const r = applyOne(cur.xml, edit);
  if (r.error) return { error: ERR[r.error] || r.error };
  log.edits.push({ ...edit, block: r.id, before: r.before, after: r.after });
  save(rootId, n, log, base);
  return { ok: true, edit: log.edits[log.edits.length - 1] };
}
/** autofix.json өөрчлөгдсөний дараа (comment) Word файлуудыг дахин үүсгэнэ */
function rebuild(rootId, n) {
  const fb = feedback(rootId, n); if (!fb) return;
  const base = baseOf(fb); if (base.reason) return;
  save(rootId, n, readLog(rootId, n), base);
}

/** Буцаах: нэг засвар (seq) эсвэл бүгдийг ('all') */
function revert(rootId, n, which, by) {
  const fb = feedback(rootId, n);
  if (!fb) return { error: 'Энэ хувилбарт feedback илгээгдээгүй байна', code: 404 };
  const base = baseOf(fb);
  if (base.reason) return { error: base.reason, code: 409 };
  const log = readLog(rootId, n);
  const targets = log.edits.filter(e => e.status === 'applied' && (which === 'all' || e.seq === Number(which)));
  if (!targets.length) return { error: 'Буцаах засвар алга', code: 404 };
  const at = C.nowIso();
  for (const e of targets) Object.assign(e, { status: 'reverted', reverted_by: by, reverted_at: at });
  const results = save(rootId, n, log, base);
  return { ok: true, reverted: targets.map(e => ({ seq: e.seq, rv_id: e.rv_id })), conflicts: Object.values(results).filter(x => x !== 'ok').length, edits: log.edits };
}

/** Засварласан файл (засвар хийгээгүй бол null). tracked: Track Changes, comment-той хувилбар (Word-оор хянах) */
function working(rootId, n, tracked) {
  const log = C.readJson(logFile(rootId, n));
  const f = path.join(edDir(rootId, n), tracked ? 'working_tracked.docx' : 'working.docx');
  if (!log || !fs.existsSync(f) || (!tracked && !log.edits.some(e => e.status === 'applied'))) return null;
  const name = log.base?.name || 'report.docx';
  return { path: f, name: tracked ? name.replace(/(\.docx)?$/i, '_AI-засвар.docx') : name, applied: log.edits.filter(e => e.status === 'applied').length, version: n };
}
/** Сүүлийн release хийсэн feedback-ийн засварласан файл — засварласан хувилбар илгээхэд */
function latestWorking(rootId) {
  const rel = WF.releasedVersions(rootId);
  return rel.length ? working(rootId, rel[rel.length - 1]) : null;
}

module.exports = { state, preview, apply, applyAuto, rebuild, revert, working, latestWorking, scan, locate, build, applyOne, feedback, edDir, DRAFT_TAG };
