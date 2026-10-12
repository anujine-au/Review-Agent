'use strict';
/*
  Ишлэлийн шалгалт: review_findings.json-ийн тэмдэглэл бүрийн "quote"-ийг тайлангийн эх бичвэр (doc.json)-ээс хайна.
  Хоёулаа далдлагдсан (token) хэлбэртэй тул шууд харьцуулна.

  Төлөв (issue.quote_check.status):
    exact      — заасан байршилд таарсан (хашилт, зураас, зай, том/жижиг үсгийн ялгааг үл тооцно)
    relocated  — өөр догол мөрөөс яг таарсан → anchor-ийг автоматаар зассан (original_anchor-д хуучныг нь хадгална)
    partial    — заасан байршилд хэсэгчлэн таарсан (matched_text = таарсан хэсэг)
    not_found  — тайлангаас олдсонгүй
    no_quote   — ишлэл байхгүй (тайланд огт байхгүй зүйлийн тухай тэмдэглэл)

  CLI:  node server/verify.js <jobDir>   (хуучин review-д дахин шалгалт хийх)
*/

const fs = require('fs');
const path = require('path');

// Cyrillic ↔ Latin ижил хэлбэртэй үсгүүд (хоёр талд ижил хөрвүүлэх тул аюулгүй)
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i' };

// Хэвийн болгох + эх текстийн байрлалын зураглал (map[i] = эх текстэд байрлал)
function normMap(s) {
  s = String(s || '');
  let n = '';
  const map = [];
  let space = true;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (/[\s   |]/.test(ch)) {
      if (!space) { n += ' '; map.push(i); space = true; }
      continue;
    }
    space = false;
    if (ch === '…') { for (let k = 0; k < 3; k++) { n += '.'; map.push(i); } continue; }
    if (/[“”„«»"″]/.test(ch)) ch = '"';
    else if (/[‘’ʼ`´']/.test(ch)) ch = "'";
    else if (/[–—−‐‑-]/.test(ch)) ch = '-';
    ch = ch.toLowerCase();
    ch = LOOKALIKE[ch] || ch;
    n += ch; map.push(i);
  }
  if (n.endsWith(' ')) { n = n.slice(0, -1); map.pop(); }
  return { n, map };
}
const norm = s => normMap(s).n;
const cleanQuote = q => norm(q).replace(/^["'\s]+|["'\s]+$/g, '').replace(/(\.\.\.|\s)+$/, '').replace(/^(\.\.\.|\s)+/, '').trim();

/* ---------- Баримтын блокууд ---------- */
function blockUnits(doc) {
  // Хайх нэгж: догол мөр бүр, хүснэгтийн мөр бүр
  const units = [];
  (doc.blocks || []).forEach((b, bi) => {
    if (b.kind === 'table') (b.rows || []).forEach((r, ri) => units.push({ id: `${b.id}R${ri + 1}`, block: b.id, bi, text: (r || []).join(' | ') }));
    else units.push({ id: b.id, block: b.id, bi, text: b.text || '' });
  });
  return units;
}
// "P22", "T9R12", "T9", "P459–P460", "T41R29–R30" → тохирох нэгжүүд
function anchorUnits(anchor, units) {
  const a = String(anchor || '').replace(/\s/g, '');
  const m = a.match(/^(P|T)(\d+)(?:R(\d+))?(?:[–—-](?:(P|T)?(\d+)?R?(\d+)?))?/i);
  if (!m) return [];
  const kind = m[1].toUpperCase(), num = Number(m[2]), row = m[3] ? Number(m[3]) : null;
  if (kind === 'P') {
    const to = m[5] && (!m[4] || m[4].toUpperCase() === 'P') ? Number(m[5]) : num;
    return units.filter(u => { const k = u.id.match(/^P(\d+)$/); return k && Number(k[1]) >= num && Number(k[1]) <= Math.max(num, to); });
  }
  const tUnits = units.filter(u => u.block === `T${num}`);
  if (!row) return tUnits;
  const rowTo = m[6] ? Number(m[6]) : m[5] && !m[4] ? Number(m[5]) : row;
  return tUnits.filter(u => { const r = Number(u.id.split('R')[1]); return r >= row && r <= Math.max(row, rowTo); });
}

/* ---------- Хайлт ---------- */
// "A … B" хэлбэрийн ишлэл: хэсэг бүр дарааллаараа таарвал болно
function findIn(text, q) {
  const { n, map } = normMap(text);
  const parts = q.split(/\s*\.\.\.\s*/).filter(p => p.length >= 3);
  if (!parts.length) return null;
  let pos = 0, start = -1, end = -1;
  for (const p of parts) {
    const i = n.indexOf(p, pos);
    if (i < 0) return null;
    if (start < 0) start = i;
    end = i + p.length; pos = end;
  }
  return text.slice(map[start], map[end - 1] + 1);
}
// Хамгийн урт нийтлэг дэд мөр (тэмдэгтээр)
function longestCommon(text, q) {
  const { n, map } = normMap(text);
  if (!n || !q) return null;
  let best = 0, bestEnd = 0;
  let prev = new Uint16Array(q.length + 1), cur = new Uint16Array(q.length + 1);
  for (let i = 1; i <= n.length; i++) {
    for (let j = 1; j <= q.length; j++) {
      cur[j] = n[i - 1] === q[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) { best = cur[j]; bestEnd = i; }
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  if (!best) return null;
  return { len: best, text: text.slice(map[bestEnd - best], map[bestEnd - 1] + 1) };
}

function checkIssue(issue, units) {
  const q = cleanQuote(issue.quote);
  if (!q || q.length < 3) return { status: 'no_quote' };
  const own = anchorUnits(issue.anchor, units);
  for (const u of own) { const t = findIn(u.text, q); if (t) return { status: 'exact', matched_text: t }; }
  // Өөр газраас яг таарвал — anchor-т хамгийн ойрыг сонгоно
  const hits = [];
  for (const u of units) { const t = findIn(u.text, q); if (t) hits.push({ u, t }); }
  if (hits.length) {
    const ref = own.length ? own[0].bi : -1;
    hits.sort((x, y) => (ref < 0 ? 0 : Math.abs(x.u.bi - ref) - Math.abs(y.u.bi - ref)));
    const h = hits[0];
    const unitsOfBlock = units.filter(u => u.block === h.u.block).length;
    const newAnchor = h.u.id.startsWith('T') && unitsOfBlock > 0 ? h.u.id : h.u.block;
    return { status: 'relocated', matched_text: h.t, original_anchor: issue.anchor ?? null, anchor: newAnchor };
  }
  // Хэсэгчилсэн таарц — зөвхөн заасан байршилд
  let best = null;
  for (const u of own) { const lc = longestCommon(u.text, q); if (lc && (!best || lc.len > best.len)) best = lc; }
  if (best && best.len >= Math.max(12, Math.round(q.length * 0.5))) return { status: 'partial', matched_text: best.text, ratio: Math.round(100 * best.len / q.length) };
  return { status: 'not_found' };
}

/* ---------- Нийт ---------- */
function verifyFindings(jobDir) {
  const fPath = path.join(jobDir, 'sandbox', 'output', 'review_findings.json');
  const dPath = path.join(jobDir, 'doc.json');
  if (!fs.existsSync(fPath) || !fs.existsSync(dPath)) return null;
  let findings;
  try { findings = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch { return null; }
  const doc = JSON.parse(fs.readFileSync(dPath, 'utf8'));
  const units = blockUnits(doc);
  const issues = Array.isArray(findings.issues) ? findings.issues : [];
  const stats = { checked: 0, exact: 0, relocated: 0, partial: 0, not_found: 0, no_quote: 0 };
  for (const it of issues) {
    const prev = it.quote_check || {};
    const res = checkIssue(it, units);
    if (res.status === 'relocated') { it.anchor = res.anchor; delete res.anchor; }
    // Өмнө нь зассан байршлыг хадгална
    if (prev.original_anchor !== undefined && res.original_anchor === undefined && prev.original_anchor !== it.anchor) res.original_anchor = prev.original_anchor;
    if (prev.retried) res.retried = true;
    if (prev.original_quote !== undefined) res.original_quote = prev.original_quote;
    it.quote_check = res;
    stats[res.status]++;
    if (res.status !== 'no_quote') stats.checked++;
  }
  findings.quote_verification = { ...stats, verified_at: new Date().toISOString().slice(0, 19) };
  fs.writeFileSync(fPath, JSON.stringify(findings, null, 2), 'utf8');
  return { stats, failed: issues.filter(it => ['partial', 'not_found'].includes(it.quote_check.status)), units };
}

// Агентын засварын саналыг (зөвхөн quote, anchor) хэрэгжүүлнэ
function applyQuoteFixes(jobDir, fixes) {
  const fPath = path.join(jobDir, 'sandbox', 'output', 'review_findings.json');
  const findings = JSON.parse(fs.readFileSync(fPath, 'utf8'));
  const byId = new Map((findings.issues || []).map(it => [it.id, it]));
  let n = 0;
  for (const fx of Array.isArray(fixes) ? fixes : []) {
    const it = fx && byId.get(fx.id);
    if (!it || typeof fx.quote !== 'string') continue;
    const qc = it.quote_check || {};
    if (qc.original_quote === undefined) qc.original_quote = it.quote ?? '';
    if (qc.original_anchor === undefined && fx.anchor !== undefined && fx.anchor !== it.anchor) qc.original_anchor = it.anchor ?? null;
    qc.retried = true;
    it.quote = fx.quote.slice(0, 1000);
    if (fx.anchor === null || (typeof fx.anchor === 'string' && /^(P|T)\d+/.test(fx.anchor))) it.anchor = fx.anchor;
    it.quote_check = qc;
    n++;
  }
  fs.writeFileSync(fPath, JSON.stringify(findings, null, 2), 'utf8');
  return n;
}

// Агентад өгөх засварын даалгавар
function buildFixPrompt(failed, units) {
  const items = failed.map(it => {
    const own = anchorUnits(it.anchor, units);
    const text = own.map(u => `[${u.id}] ${u.text}`).join('\n').slice(0, 1500);
    return { id: it.id, anchor: it.anchor ?? null, title: it.title || '', quote: it.quote || '', anchor_text: text || '(anchor not found in report)' };
  });
  return `You previously wrote an internal audit report review. A server-side check found that the "quote" of the issues below is NOT a verbatim substring of the report paragraph given in "anchor".

The main report text is in extracted/report__*.txt: each paragraph starts with [P#], table rows start with T#R#. Use Grep/Read on that file to find the exact text each issue refers to.

For every issue below, return the correct anchor and a quote copied CHARACTER-FOR-CHARACTER from that paragraph/row (keep tokens such as [PERSON-0001] exactly; 5–25 words; no added quotation marks, no ellipsis, no paraphrase, no translation).
If the issue is about something that is absent from the report so no text can be quoted, return quote "" and the anchor of the place where it should be (or null).
Do not change anything else. Do not write any files.

Issues:
${JSON.stringify(items, null, 2)}

Reply with ONLY a JSON array, no other text:
[{"id":"REV-001","anchor":"P22","quote":"..."}]`;
}
function parseFixReply(text) {
  const s = String(text || '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { const arr = JSON.parse(s.slice(a, b + 1)); return Array.isArray(arr) ? arr : null; } catch { return null; }
}

// Дахин шалгалт (recheck.json): засварласан тайлангаас иш татсан ишлэлийг шинэ doc.json-оос хайна.
// Агентаар засуулахгүй — зөвхөн тэмдэглэнэ (олдоогүй бол хянагч гараар шалгана).
function verifyRecheck(jobDir) {
  const fPath = path.join(jobDir, 'sandbox', 'output', 'recheck.json');
  const dPath = path.join(jobDir, 'doc.json');
  if (!fs.existsSync(fPath) || !fs.existsSync(dPath)) return null;
  let rc;
  try { rc = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch { return null; }
  const units = blockUnits(JSON.parse(fs.readFileSync(dPath, 'utf8')));
  const stats = { checked: 0, exact: 0, relocated: 0, partial: 0, not_found: 0, no_quote: 0 };
  for (const it of [...(Array.isArray(rc.items) ? rc.items : []), ...(Array.isArray(rc.new_issues) ? rc.new_issues : [])]) {
    const res = checkIssue(it, units);
    if (res.status === 'relocated') { it.anchor = res.anchor; delete res.anchor; }
    it.quote_check = res;
    stats[res.status]++;
    if (res.status !== 'no_quote') stats.checked++;
  }
  rc.quote_verification = { ...stats, verified_at: new Date().toISOString().slice(0, 19) };
  fs.writeFileSync(fPath, JSON.stringify(rc, null, 2), 'utf8');
  return { stats };
}

module.exports = { verifyFindings, verifyRecheck, applyQuoteFixes, buildFixPrompt, parseFixReply };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || '');
  const r = verifyFindings(dir);
  if (!r) { console.error('review_findings.json эсвэл doc.json олдсонгүй'); process.exit(1); }
  console.log(JSON.stringify(r.stats));
  for (const it of r.failed) console.log(`${it.id}\t${it.quote_check.status}\t${it.anchor}\t${String(it.quote).slice(0, 80)}`);
}
