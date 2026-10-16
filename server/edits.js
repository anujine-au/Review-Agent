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
      if (!close) { stack.push({ segs: [], chars: [], text: '', tbl, tNo, row, nested: stack.length > 0 }); continue; }
      const p = stack.pop();
      if (!p) continue;
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

/** Нэг засвар хэрэглэх: { xml, before, after, id } эсвэл { error } */
function applyOne(xml, e) {
  const paras = scan(xml);
  const hit = locate(paras, e.old, e.anchor);
  if (hit.error) return hit;
  const next = replaceRange(xml, hit.p, hit.a, hit.b, e.new);
  if (next == null) return { error: 'not_found' };
  const before = hit.p.text;
  return { xml: next, id: hit.p.id, before, after: before.slice(0, hit.a) + e.new + before.slice(hit.b) };
}

/** Эх .docx + засварууд → { buf, results: { seq: 'ok' | error } } */
function build(baseBuf, edits) {
  const z = readZip(baseBuf);
  let xml = z.get('word/document.xml');
  if (!xml) throw new Error('word/document.xml олдсонгүй');
  xml = xml.toString('utf8');
  const results = {};
  for (const e of edits) {
    if (e.status !== 'applied') continue;
    const r = applyOne(xml, e);
    if (r.error) results[e.seq] = r.error; else { xml = r.xml; results[e.seq] = 'ok'; }
  }
  const entries = z.names.filter(n => !n.endsWith('/')).map(n => ({ name: n, data: n === 'word/document.xml' ? Buffer.from(xml, 'utf8') : z.get(n) }));
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

function save(rootId, n, log, base) {
  const { buf, results } = build(fs.readFileSync(base.file), log.edits);
  for (const e of log.edits) e.result = e.status === 'applied' ? results[e.seq] : undefined;
  fs.mkdirSync(edDir(rootId, n), { recursive: true });
  fs.writeFileSync(path.join(edDir(rootId, n), 'working.docx'), buf);
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
  return { version: n, available: !base.reason, reason: base.reason || '', base_name: base.name || '', items, ai: SUG.list(rootId, n), edits: log.edits,
    applied: applied.length, conflicts: applied.filter(e => e.result && e.result !== 'ok').length, updated_at: log.updated_at || null };
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

/** Засварласан файл (засвар хийгээгүй бол null) */
function working(rootId, n) {
  const log = C.readJson(logFile(rootId, n));
  const f = path.join(edDir(rootId, n), 'working.docx');
  if (!log || !fs.existsSync(f) || !log.edits.some(e => e.status === 'applied')) return null;
  return { path: f, name: log.base?.name || 'report.docx', applied: log.edits.filter(e => e.status === 'applied').length, version: n };
}
/** Сүүлийн release хийсэн feedback-ийн засварласан файл — засварласан хувилбар илгээхэд */
function latestWorking(rootId) {
  const rel = WF.releasedVersions(rootId);
  return rel.length ? working(rootId, rel[rel.length - 1]) : null;
}

module.exports = { state, preview, apply, revert, working, latestWorking, scan, locate, build, applyOne };
