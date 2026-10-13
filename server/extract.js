'use strict';
/*
  input/ доторх .docx, .xlsx, .csv, .pdf, .txt файлуудыг review хийхэд зориулж текст болгон задална.
  Гадны сан ашиглахгүй (зөвхөн Node.js-ийн zlib).

  - Word:  [P#] догол мөр, T#R# хүснэгтийн мөр
  - Excel: SHEET блок, мөр бүр Excel-ийн жинхэнэ мөрийн дугаар R#-ээр эхэлнэ; огноог YYYY-MM-DD болгоно
  - *.profile.txt: мөрийн тоо, нийлбэр, давхардал, ангиллаар бүлэглэсэн дүн
  - Хувийн мэдээллийг [PERSON-0001] зэрэг token-оор солих (pseudonymization)

  CLI:
    node server/extract.js --in input --out work/extracted
    node server/extract.js --in <dir> --out <dir> --mask-map map.json --mask-summary sum.json --doc-json doc.json --sources <dir>
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { spawnSync } = require('child_process');
const { PATHS, findExecutable, MN_SUFFIX, WB, WE, NAME_STOPWORDS, endsVowel, stemRe, findLeaks } = require('./common');

const MAX_ENTRY_BYTES = 300 * 1024 * 1024; // zip bomb хамгаалалт

/* ======================= ZIP ======================= */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP бүтэц олдсонгүй (эвдэрсэн эсвэл буруу формат)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/');
    entries.set(name, { method, compSize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    get(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lnLen = buf.readUInt16LE(e.local + 26), exLen = buf.readUInt16LE(e.local + 28);
      const start = e.local + 30 + lnLen + exLen;
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`ZIP шахалтын арга ${e.method} дэмжигдэхгүй`);
    },
    text(name) { const b = this.get(name); return b ? b.toString('utf8').replace(/^\uFEFF/, '') : null; },
  };
}

/* ======================= XML ======================= */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&';
    if (l === 'quot') return '"'; if (l === 'apos') return "'";
    const cp = l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return m; }
  });
}
function parseAttrs(s) {
  const a = {};
  for (const m of s.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return a;
}
// Энгийн, найдвартай XML задлагч (OOXML-д хангалттай). DOCTYPE/entity тэлэлт хийхгүй.
function parseXml(xml) {
  const root = { n: '#root', a: {}, c: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s>/!?]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.c.push({ t: m[1] });
    else if (m[2] !== undefined) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].n === m[2]) { stack.length = i; break; } }
    else if (m[3] !== undefined) { const node = { n: m[3], a: parseAttrs(m[4]), c: [] }; top.c.push(node); if (!m[5]) stack.push(node); }
    else if (m[6] !== undefined) top.c.push({ t: decodeEntities(m[6]) });
  }
  return root;
}
const ln = n => (n || '').split(':').pop();
const kids = (node, local) => (node?.c || []).filter(x => x.n && ln(x.n) === local);
const kid = (node, local) => kids(node, local)[0];
function desc(node, local, out = []) { for (const x of node?.c || []) if (x.n) { if (ln(x.n) === local) out.push(x); desc(x, local, out); } return out; }
function textOf(node) { let s = ''; for (const x of node?.c || []) s += x.t !== undefined ? x.t : textOf(x); return s; }
const attr = (node, local) => { if (!node) return undefined; for (const k of Object.keys(node.a)) if (ln(k) === local) return node.a[k]; return undefined; };

/* ======================= DOCX ======================= */
function paragraphText(p) {
  let s = '';
  (function walk(node) {
    for (const x of node.c || []) {
      if (!x.n) continue;
      const l = ln(x.n);
      if (l === 't') s += textOf(x);
      else if (l === 'tab') s += '\t';
      else if (l === 'br' || l === 'cr') s += ' ';
      else if (l === 'delText' || l === 'instrText') continue;
      else walk(x);
    }
  })(p);
  return s;
}
function paragraphKind(p, text) {
  const pPr = kid(p, 'pPr');
  const style = attr(kid(pPr, 'pStyle'), 'val') || '';
  if (/^title$|Гарчиг\s*$/i.test(style)) return 'title';
  const h = style.match(/heading\s*(\d)|^(\d)$|Гарчиг\s*(\d)/i);
  if (h) return 'h' + (h[1] || h[2] || h[3]);
  if (/list|жагсаалт/i.test(style) || kid(pPr, 'numPr')) return 'li';
  // Бүх run нь bold, богино мөр → дэд гарчиг
  const runs = kids(p, 'r').filter(r => kid(r, 't'));
  if (runs.length && text.length <= 120 && runs.every(r => { const b = kid(kid(r, 'rPr'), 'b'); const v = attr(b, 'val'); return b && v !== '0' && v !== 'false'; })) return 'h3';
  return 'p';
}
function convertDocx(buf) {
  const zip = readZip(buf);
  const xml = zip.text('word/document.xml');
  if (!xml) throw new Error('word/document.xml олдсонгүй');
  const body = desc(parseXml(xml), 'body')[0];
  const lines = [], blocks = [];
  let pNo = 0, tNo = 0;
  (function walk(nodes) {
    for (const x of nodes) {
      if (!x.n) continue;
      const l = ln(x.n);
      if (l === 'p') {
        const text = paragraphText(x);
        if (!text.trim()) continue;
        pNo++;
        const kind = paragraphKind(x, text);
        lines.push(`[P${pNo}]` + (kind !== 'p' && kind !== 'li' ? `[${kind}]` : '') + ' ' + text);
        blocks.push({ id: `P${pNo}`, kind, text });
      } else if (l === 'tbl') {
        tNo++;
        lines.push('', `=== TABLE ${tNo} ===`);
        const rows = [];
        kids(x, 'tr').forEach((tr, i) => {
          const cells = kids(tr, 'tc').map(tc => desc(tc, 'p').map(paragraphText).filter(t => t.trim()).join(' / ').trim());
          lines.push(`T${tNo}R${i + 1} | ` + cells.join(' | '));
          rows.push(cells);
        });
        lines.push(`=== END TABLE ${tNo} ===`, '');
        blocks.push({ id: `T${tNo}`, kind: 'table', rows });
      } else if (l === 'sdt') {
        const c = kid(x, 'sdtContent'); if (c) walk(c.c);
      }
    }
  })(body ? body.c : []);
  return { lines, blocks };
}

/* ======================= XLSX ======================= */
function colToIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function indexToCol(i) { let s = ''; let n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000); // 1970-01-01 = 25569
  const d = new Date(ms);
  if (isNaN(d)) return String(serial);
  const p = n => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const secs = Math.round((serial % 1) * 86400);
  return secs ? `${date} ${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}` : date;
}
function dateStyleSet(stylesXml) {
  const set = new Set();
  if (!stylesXml) return set;
  const doc = parseXml(stylesXml);
  const custom = {};
  for (const nf of desc(doc, 'numFmt')) custom[attr(nf, 'numFmtId')] = attr(nf, 'formatCode') || '';
  const xfs = kids(desc(doc, 'cellXfs')[0], 'xf');
  xfs.forEach((xf, i) => {
    const id = Number(attr(xf, 'numFmtId') || 0);
    const code = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom[id] !== undefined && /[dmyhs]/i.test(code) && !/^[#0.,%\s]*$/.test(code))) set.add(i);
  });
  return set;
}
function convertXlsx(buf) {
  const zip = readZip(buf);
  const shared = [];
  const ss = zip.text('xl/sharedStrings.xml');
  if (ss) for (const si of desc(parseXml(ss), 'si')) {
    let s = '';
    (function walk(n) { for (const x of n.c || []) { if (!x.n) continue; const l = ln(x.n); if (l === 'rPh') continue; if (l === 't') s += textOf(x); else walk(x); } })(si);
    shared.push(s);
  }
  const dates = dateStyleSet(zip.text('xl/styles.xml'));
  const wb = parseXml(zip.text('xl/workbook.xml') || '');
  const rels = {};
  for (const r of desc(parseXml(zip.text('xl/_rels/workbook.xml.rels') || ''), 'Relationship')) rels[r.a.Id] = r.a.Target;
  const lines = [], sheets = [];
  for (const sh of desc(wb, 'sheet')) {
    const name = sh.a.name;
    let target = rels[attr(sh, 'id')] || '';
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = zip.text('xl/' + target);
    lines.push('', `=== SHEET: ${name} ===`);
    if (!xml) { lines.push('(sheet not readable)'); continue; }
    const rows = [];
    let autoRow = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = parseAttrs(rm[1]);
      const r = ra.r ? Number(ra.r) : autoRow + 1;
      autoRow = r;
      const vals = []; let maxCol = 0, autoCol = 0;
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = parseAttrs(cm[1]);
        const col = ca.r ? colToIndex(ca.r.replace(/\d+/g, '')) : autoCol + 1;
        autoCol = col;
        const inner = cm[2] || '';
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        let v = vm ? decodeEntities(vm[1]) : '';
        if (ca.t === 's' && v !== '') v = shared[Number(v)] ?? '';
        else if (ca.t === 'inlineStr') v = decodeEntities((inner.match(/<is>([\s\S]*?)<\/is>/) || ['', ''])[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, ''));
        else if (ca.t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if ((!ca.t || ca.t === 'n') && v !== '' && ca.s && dates.has(Number(ca.s)) && isFinite(Number(v))) v = excelDate(Number(v));
        const fm = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
        if (fm && fm[1]) v = `${v} {=${decodeEntities(fm[1])}}`;
        if (v === '' && !fm) continue;
        vals[col - 1] = String(v).replace(/[\r\n\t]/g, ' ');
        if (col > maxCol) maxCol = col;
      }
      if (!maxCol) continue;
      const cells = Array.from({ length: maxCol }, (_, i) => vals[i] ?? '');
      lines.push(`R${r}\t` + cells.join('\t'));
      rows.push({ r, cells });
    }
    lines.push(`=== END SHEET: ${name} (${rows.length} non-empty rows) ===`);
    sheets.push({ name, rows });
  }
  return { lines, sheets };
}

/* ======================= CSV ======================= */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function convertCsv(buf) {
  const lines = [], rows = [];
  parseCsv(buf.toString('utf8')).forEach((cells, i) => {
    cells = cells.map(c => c.replace(/[\r\n\t]/g, ' '));
    if (!cells.join('').trim()) return;
    lines.push(`R${i + 1}\t` + cells.join('\t'));
    rows.push({ r: i + 1, cells });
  });
  return { lines, sheets: [{ name: 'CSV', rows }] };
}

/* ======================= PDF ======================= */
function findPdftotext() {
  const la = process.env.LOCALAPPDATA || '', pf = process.env.ProgramFiles || 'C:\\Program Files';
  return findExecutable(['pdftotext.exe', 'pdftotext'], [
    path.join(la, 'Programs', 'Git', 'ucrt64', 'bin'), path.join(la, 'Programs', 'Git', 'mingw64', 'bin'),
    path.join(pf, 'Git', 'ucrt64', 'bin'), path.join(pf, 'Git', 'mingw64', 'bin'), 'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin',
  ]);
}
function convertPdf(file) {
  const exe = findPdftotext();
  if (!exe) throw new Error('pdftotext олдсонгүй');
  const tmp = path.join(os.tmpdir(), `arr-${process.pid}-${Date.now()}.txt`);
  try {
    spawnSync(exe, ['-enc', 'UTF-8', file, tmp], { windowsHide: true, stdio: 'ignore', timeout: 120000 });
    if (!fs.existsSync(tmp)) throw new Error('PDF уншиж чадсангүй');
    const raw = fs.readFileSync(tmp, 'utf8');
    const lines = [], blocks = [];
    let n = 0;
    raw.split('\f').forEach((pg, pi) => {
      for (const para of pg.split(/(?:\r?\n[ \t]*){2,}/)) {
        const text = para.split(/\r?\n/).map(s => s.trim()).join(' ').trim();
        if (!text || /^\s*\d+\s*$/.test(text)) continue;
        n++;
        const kind = text.length <= 90 && /^(\d+(\.\d+)*\.?|[IVX]+\.|[А-ЯӨҮ]\.)\s+\S/.test(text) ? 'h2' : 'p';
        lines.push(`[P${n}]` + (kind !== 'p' ? `[${kind}]` : '') + ` (х.${pi + 1}) ${text}`);
        blocks.push({ id: `P${n}`, kind, text, page: pi + 1 });
      }
    });
    return { lines, blocks, empty: n === 0 };
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

/* ======================= Excel profile ======================= */
const stripF = s => String(s ?? '').replace(/ \{=.*\}$/, '').trim();
function toNumber(s) {
  s = stripF(s).replace(/[\s ]/g, '');
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');      // 1,000,000.50 — мянгатын тусгаарлагч
  else if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');                  // 2500,5 — аравтын таслал
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  return Number(s);
}
function fmtNum(d) {
  if (d === null || d === undefined) return '';
  if (Math.abs(d - Math.round(d)) < 1e-9 && Math.abs(d) < 1e15) return Math.round(d).toLocaleString('en-US');
  return d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const cellText = (cells, j) => (j < cells.length ? stripF(cells[j]) : '');
function headerIndex(rows) {
  let idx = 0, best = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const t = rows[i].cells.filter(c => c && c.trim() && toNumber(c) === null).length;
    if (t > best) { best = t; idx = i; }
  }
  return idx;
}
const TOTAL_RE = /^\s*(нийт|бүгд|дүн(?![\p{L}\p{N}])|total|grand total|sum(?![\p{L}\p{N}]))/iu;
function isTotalRow(row) { return TOTAL_RE.test(row.cells.filter(c => c && c.trim()).slice(0, 2).join(' ')); }

function sheetProfile(sheet, ctx) {
  const out = ['', `=== PROFILE: ${sheet.name} ===`];
  const rows = sheet.rows;
  if (rows.length < 2) { out.push('(өгөгдөл хангалтгүй — profile хийгдээгүй)'); return out; }
  const h = headerIndex(rows);
  const hdr = rows[h].cells;
  const data = [], totals = [];
  for (let i = h + 1; i < rows.length; i++) (isTotalRow(rows[i]) ? totals : data).push(rows[i]);
  const nCols = Math.max(...rows.map(r => r.cells.length));
  out.push(`Header мөр: R${rows[h].r} | Өгөгдлийн мөр: ${data.length} (${data.length ? `R${data[0].r}–R${data[data.length - 1].r}` : '-'}) | Багана: ${nCols}`);
  for (const t of totals) out.push(`Нийт/Total мөр (өгөгдлөөс хассан): R${t.r} → ` + t.cells.map(stripF).join(' | '));

  const cols = [];
  for (let j = 0; j < nCols; j++) {
    const name = cellText(hdr, j) || `(багана ${j + 1})`;
    const sensitive = ctx.mask && !!sensitiveCategory(name); // хувийн мэдээллийн баганад min/max гаргахгүй
    const counts = new Map(), rowsOf = new Map(), nums = [];
    let nonEmpty = 0;
    for (const r of data) {
      const v = cellText(r.cells, j);
      if (!v) continue;
      nonEmpty++;
      if (!sensitive) { const n = toNumber(v); if (n !== null) nums.push(n); }
      counts.set(v, (counts.get(v) || 0) + 1);
      if (!rowsOf.has(v)) rowsOf.set(v, []);
      if (rowsOf.get(v).length < 5) rowsOf.get(v).push(r.r);
    }
    cols.push({ j, name, letter: indexToCol(j), nonEmpty, nums, counts, rowsOf, isNumeric: nonEmpty > 0 && nums.length >= 0.8 * nonEmpty });
  }
  out.push('', '-- Баганын статистик (Excel багана | нэр | дүүрсэн | тоон | нийлбэр | min | max | unique | давхардсан утга) --');
  for (const c of cols) {
    if (!c.nonEmpty) continue;
    const sum = c.nums.length ? fmtNum(c.nums.reduce((a, b) => a + b, 0)) : '';
    const min = c.nums.length ? fmtNum(Math.min(...c.nums)) : '', max = c.nums.length ? fmtNum(Math.max(...c.nums)) : '';
    c.dups = [...c.counts.keys()].filter(k => c.counts.get(k) > 1);
    out.push(`${c.letter} | ${c.name} | ${c.nonEmpty} | ${c.nums.length} | ${sum} | ${min} | ${max} | ${c.counts.size} | ${c.dups.length}`);
  }
  out.push('', '-- Давхардал (ID төст багана: unique утга ≥ 50%) --');
  let any = false;
  for (const c of cols) {
    if (c.nonEmpty < 2 || c.counts.size < 0.5 * c.nonEmpty || !c.dups?.length) continue;
    any = true;
    const ex = c.dups.slice(0, 15).map(v => `${v} ×${c.counts.get(v)} (R${c.rowsOf.get(v).join(',R')})`).join('; ');
    const extra = c.dups.reduce((a, v) => a + c.counts.get(v) - 1, 0);
    out.push(`${c.letter} ${c.name}: ${c.dups.length} утга давхардсан, давхар мөр ${extra}. Жишээ: ${ex}`);
  }
  if (!any) out.push('(илрээгүй)');
  const numCols = cols.filter(c => c.isNumeric).slice(0, 8);
  for (const c of cols) {
    if (!c.nonEmpty || c.isNumeric || c.counts.size > 25) continue;
    if (c.nonEmpty > 10 && c.counts.size >= 0.9 * c.nonEmpty) continue; // ID багана
    const sums = new Map();
    for (const r of data) {
      const k = cellText(r.cells, c.j); if (!k) continue;
      if (!sums.has(k)) sums.set(k, numCols.map(() => 0));
      numCols.forEach((nc, q) => { const x = toNumber(cellText(r.cells, nc.j)); if (x !== null) sums.get(k)[q] += x; });
    }
    out.push('', `-- Ангилал: ${c.letter} ${c.name} (хоосон: ${data.length - c.nonEmpty}) --`);
    out.push('Утга | Мөрийн тоо | %' + numCols.map(nc => ` | Σ ${nc.letter} ${nc.name}`).join(''));
    for (const k of [...c.counts.keys()].sort((a, b) => c.counts.get(b) - c.counts.get(a))) {
      out.push(`${k} | ${c.counts.get(k)} | ${(100 * c.counts.get(k) / Math.max(1, data.length)).toFixed(2)}` + sums.get(k).map(s => ' | ' + fmtNum(s)).join(''));
    }
  }
  out.push(`=== END PROFILE: ${sheet.name} ===`);
  return out;
}

/* ======================= Хувийн мэдээлэл далдлах ======================= */
const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
function sensitiveCategory(header) {
  const h = String(header || '').toLowerCase().trim();
  if (!h) return null;
  // Дүн, огноо, ангилал зэрэг тоон/ерөнхий багануудыг далдлахгүй
  if (new RegExp(`үлдэгдэл|дүн|хэмжээ|amount|balance|огноо|date|хугацаа|хувь|%|тоо${E}|бүтээгдэхүүн|product|салбар|branch|төрөл|ангилал|type|status|төлөв|валют|currency|хүү|rate|баримт|файл|хамаарал|relation`, 'u').test(h)) return null;
  if (new RegExp(`регистр|^рд$|${B}рд${E}|register|иргэний үнэмлэх|national id|passport|паспорт`, 'u').test(h)) return 'ID';
  if (/имэйл|и-мэйл|e-mail|email|цахим шуудан/.test(h)) return 'EMAIL';
  if (/утас|phone|mobile|\btel\b/.test(h)) return 'PHONE';
  if (/хаяг|address/.test(h)) return 'ADDR';
  if (/данс|account|iban|карт|card/.test(h)) return 'ACCT';
  if (/нэр|овог|name|харилцагч|зээлдэгч|borrower|customer|client|ажилтан|employee|эзэмшигч|батлан даагч|хамтран/.test(h)) return 'PERSON';
  return null;
}

// «Б.Болдын» → «Б.Болд» + «ын» гэж салгахдаа ашиглах залгаварууд (урт нь эхэндээ)
const NAME_SUFFIXES = MN_SUFFIX.slice(3, -2).split('|').sort((a, b) => b.length - a.length);
// Нэрийн эхний үсэг + нэр (зураастай нэр орно): Б.Болд, Б. Бат-Эрдэнэ
const INITIAL_NAME_RE = /(?<![\p{L}[])[А-ЯӨҮЁ]\.\s?[А-ЯӨҮЁ][а-яөүё]+(?:-[А-ЯӨҮЁ][а-яөүё]+)?/gu;

class Masker {
  constructor(allowText = '') {
    this.values = new Map(); this.columns = []; this.tokenOf = new Map(); this.realOf = {}; this.counters = {}; this.hits = {};
    this.allow = new Set(String(allowText).toLowerCase().match(/[\p{L}\p{N}-]+/gu) || []);
    this.allowText = allowText;
  }
  collect(fileName, sheet) {
    const rows = sheet.rows;
    if (rows.length < 2) return;
    const h = headerIndex(rows);
    rows[h].cells.forEach((hc, j) => {
      const name = stripF(hc), cat = sensitiveCategory(name);
      if (!cat) return;
      let n = 0;
      for (let i = h + 1; i < rows.length; i++) {
        if (isTotalRow(rows[i])) continue;
        const v = cellText(rows[i].cells, j);
        if (v.length < 3 || (/^\d+$/.test(v) && v.length < 6)) continue;
        if (!this.values.has(v)) this.values.set(v, cat);
        n++;
      }
      if (n) this.columns.push({ file: fileName, sheet: sheet.name, column: name, category: cat, cells: n });
    });
  }
  token(value, cat) {
    // Нэг утга = нэг token: утсыг цифрээр (99112233 = 9911-2233 = +976 9911 2233), РД-г зайгүй том үсгээр,
    // бусдыг том жижиг үсэг ялгахгүйгээр (ЗОРИГОО = Зоригоо) нэгтгэнэ
    const key = cat === 'PHONE' ? value.replace(/\D/g, '').replace(/^976(?=\d{8}$)/, '')
      : cat === 'ID' ? value.replace(/\s+/g, '').toUpperCase()
        : `${cat}:${value.toLowerCase().replace(/\s+/g, ' ')}`;
    if (this.tokenOf.has(key)) return this.tokenOf.get(key);
    this.counters[cat] = (this.counters[cat] || 0) + 1;
    const tok = `[${cat}-${String(this.counters[cat]).padStart(4, '0')}]`;
    this.tokenOf.set(key, tok); this.realOf[tok] = value;
    return tok;
  }
  // Дахин шалгалт: анхны review-ийн token-уудыг урьдчилан ачаална — ижил утга ижил token авч,
  // анхны Excel-д байсан нэр засварласан тайланд гарвал (Excel дахин оруулаагүй ч) далдлагдана
  seed(map) {
    for (const [tok, value] of Object.entries(map || {})) {
      const m = /^\[([A-Z]+)-(\d+)\]$/.exec(tok);
      if (!m || typeof value !== 'string') continue;
      const cat = m[1];
      const key = cat === 'PHONE' ? value.replace(/\D/g, '').replace(/^976(?=\d{8}$)/, '')
        : cat === 'ID' ? value.replace(/\s+/g, '').toUpperCase()
          : `${cat}:${value.toLowerCase().replace(/\s+/g, ' ')}`;
      this.tokenOf.set(key, tok); this.realOf[tok] = value;
      this.counters[cat] = Math.max(this.counters[cat] || 0, Number(m[2]));
      if (value.length >= 3 && !this.values.has(value)) this.values.set(value, cat);
    }
  }
  applyRules(text, rules) {
    for (const [cat, re, grp] of rules) {
      text = text.replace(re, (...m) => {
        this.hits[cat] = (this.hits[cat] || 0) + 1;
        return grp ? m[1] + m[2] + this.token(m[3], cat) : this.token(m[0], cat);
      });
    }
    return text;
  }
  protect(text) {
    // 0) РД, имэйл — тодорхой хэлбэртэй тул эхэлж (РД-ийн цифр Excel-ийн утастай давхцахаас сэргийлнэ)
    text = this.applyRules(text, [
      ['ID', /(?<![\p{L}\p{N}])[А-ЯӨҮЁ]{2}\s?\d{8}(?!\d)/gu, 0],
      ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 0],
    ]);
    // 1) Excel-ийн хувийн мэдээллийн баганаас цуглуулсан утгууд: том жижиг үсэг ялгахгүй, залгавартай хэлбэрийг
    //    оруулна (залгавар нь token-ы ард үлдэнэ: «[PERSON-0001]гийн»). Урт нь эхэндээ.
    const vals = [...this.values.keys()]
      .filter(v => !NAME_STOPWORDS.has(v.toLowerCase()) && !this.allow.has(v.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    const canon = new Map();
    for (const v of vals) {
      const l = v.toLowerCase();
      if (!canon.has(l)) canon.set(l, v);
      if (endsVowel(v) && !canon.has(l.slice(0, -1))) canon.set(l.slice(0, -1), v);
    }
    for (let k = 0; k < vals.length; k += 300) {
      const re = new RegExp(`${WB}(${vals.slice(k, k + 300).map(stemRe).join('|')})(?=${MN_SUFFIX}${WE})`, 'giu');
      text = text.replace(re, m => { const v = canon.get(m.toLowerCase()) || m; return this.token(v, this.values.get(v) || 'PERSON'); });
    }
    // 2) Чөлөөт текст дэх хэв маяг. Данс/утсыг түлхүүр үгийн ард л авна — 10+ оронтой мөнгөн дүнг далдлахгүйн тулд.
    text = this.applyRules(text, [
      ['PHONE', /(утас|утасны|гар утас|phone|tel)([^\d\r\n]{0,15})((?:\+?976[\s-]?)?[6-9]\d{3}[\s-]?\d{4})(?!\d)/giu, 3],
      ['PHONE', /()()(\+976[\s-]?[6-9]\d{3}[\s-]?\d{4})(?!\d)/gu, 3],
      ['ACCT', /(данс|дансны дугаар|account|iban)([^\d\r\n]{0,15})(\d{8,16})(?!\d)/giu, 3],
    ]);
    // 3) «Б.Болд», «Б. Бат-Эрдэнэ». «Б.Болдын» нь энэ текстэд «Б.Болд» хэлбэр ч байвал түүнтэй нэг token авна.
    const names = text.match(INITIAL_NAME_RE) || [];
    const seen = new Set(names.map(n => n.replace(/\s+/g, '').toLowerCase()));
    text = text.replace(INITIAL_NAME_RE, m => {
      this.hits.PERSON = (this.hits.PERSON || 0) + 1;
      const norm = m.replace(/\s+/g, '');
      for (const sfx of NAME_SUFFIXES) {
        if (norm.length - sfx.length < 4 || !norm.toLowerCase().endsWith(sfx)) continue;
        const base = norm.slice(0, -sfx.length);
        if (seen.has(base.toLowerCase())) return this.token(base, 'PERSON') + m.slice(m.length - sfx.length);
      }
      return this.token(norm, 'PERSON');
    });
    return text;
  }
  /** Маскийн дараах эцсийн шалгалт: жинхэнэ утга үлдсэн token-ууд */
  leaks(text) { return findLeaks(text, this.realOf, this.allowText); }
  summary() {
    const byCat = {};
    for (const tok of Object.keys(this.realOf)) { const c = tok.slice(1, tok.indexOf('-')); byCat[c] = (byCat[c] || 0) + 1; }
    return { unique_values: Object.keys(this.realOf).length, by_category: byCat, columns: this.columns, pattern_hits: this.hits, leak_check: this.leakCheck || null };
  }
}

/* ======================= Үндсэн процесс ======================= */
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name !== '.gitkeep') out.push(p);
    }
  })(dir);
  return out;
}

/**
 * @param {object} o  { inputDir, outDir, maskMapOut?, maskSummaryOut?, docJsonOut?, sourcesOut?, allowText? }
 * @returns {string[]} явцын мөрүүд
 */
function extractAll(o) {
  const log = [];
  const mask = !!o.maskMapOut;
  const masker = new Masker(o.allowText);
  if (mask && o.seedMap && fs.existsSync(o.seedMap)) masker.seed(JSON.parse(fs.readFileSync(o.seedMap, 'utf8')));
  fs.mkdirSync(o.outDir, { recursive: true });
  if (o.sourcesOut) fs.mkdirSync(o.sourcesOut, { recursive: true });
  const index = [];
  let srcNo = 0, docBlocks = null;
  if (!fs.existsSync(o.inputDir)) { log.push('input хавтас алга'); return log; }

  for (const file of listFiles(o.inputDir)) {
    const name = path.basename(file);
    const rel = path.relative(o.inputDir, file).split(path.sep).join('__');
    const category = rel.split('__')[0];
    const ext = path.extname(name).toLowerCase();
    const dest = path.join(o.outDir, rel + '.txt');
    let lines, sheets = null, blocks = null;
    try {
      if (ext === '.docx') ({ lines, blocks } = convertDocx(fs.readFileSync(file)));
      else if (ext === '.xlsx' || ext === '.xlsm') ({ lines, sheets } = convertXlsx(fs.readFileSync(file)));
      else if (ext === '.csv') ({ lines, sheets } = convertCsv(fs.readFileSync(file)));
      else if (ext === '.txt' || ext === '.md') lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
      else if (ext === '.pdf') {
        const r = convertPdf(file); lines = r.lines; blocks = r.blocks;
        if (r.empty) log.push(`WARN ${name}: PDF-д текст алга (скан хийсэн зураг байж магадгүй)`);
      } else { log.push(`SKIP ${name}: ${['.png', '.jpg', '.jpeg'].includes(ext) ? 'зураг' : ext + ' дэмжигдэхгүй (.doc/.xls бол .docx/.xlsx болгож хадгална уу)'}`); continue; }
    } catch (e) { log.push(`FAIL ${name}: ${e.message}`); continue; }

    fs.writeFileSync(dest, [`# SOURCE: ${rel.split('__').join('/')}`, `# EXTRACTED: ${new Date().toISOString().slice(0, 19)}`, '', ...lines].join('\r\n'), 'utf8');
    log.push(`OK   ${name} -> ${path.basename(dest)}`);
    if (!docBlocks && blocks && category === 'report' && o.docJsonOut) docBlocks = { file: name, blocks };
    if (mask && sheets) for (const sh of sheets) masker.collect(name, sh);

    if (sheets) {
      const p = ['# PROFILE: ' + name, '# Автомат тооцоолол. Header мөр, нийт мөрийг автоматаар тогтоосон тул тайлантай тулгахдаа R дугаараар шалгана уу.'];
      for (const sh of sheets) p.push(...sheetProfile(sh, { mask }));
      fs.writeFileSync(path.join(o.outDir, rel + '.profile.txt'), p.join('\r\n'), 'utf8');
      log.push(`OK   ${name} -> ${rel}.profile.txt`);
    }

    // Вэб дээр эх файлыг харуулах хувилбар
    if (o.sourcesOut) {
      if (sheets) {
        for (const sh of sheets) {
          srcNo++;
          const rows = sh.rows, h = rows.length ? headerIndex(rows) : 0;
          fs.writeFileSync(path.join(o.sourcesOut, `${srcNo}.tsv`), rows.map(r => `R${r.r}\t` + r.cells.map(stripF).join('\t')).join('\n'), 'utf8');
          index.push({
            id: srcNo, file: name, category, kind: 'sheet', sheet: sh.name, rows: rows.length,
            cols: rows.length ? Math.max(...rows.map(r => r.cells.length)) : 0,
            first_row: rows[0]?.r || 0, last_row: rows[rows.length - 1]?.r || 0,
            header_row: rows[h]?.r || 0, header: rows[h] ? rows[h].cells.map(stripF) : [],
          });
        }
      } else {
        const b = blocks || lines.filter(l => l.trim()).map((t, i) => ({ id: `P${i + 1}`, kind: 'p', text: t }));
        srcNo++;
        fs.writeFileSync(path.join(o.sourcesOut, `${srcNo}.json`), JSON.stringify({ blocks: b }), 'utf8');
        index.push({ id: srcNo, file: name, category, kind: 'doc', blocks: b.length });
      }
    }
  }

  if (o.sourcesOut) fs.writeFileSync(path.join(o.sourcesOut, 'index.json'), JSON.stringify({ sources: index }), 'utf8');
  if (docBlocks) fs.writeFileSync(o.docJsonOut, JSON.stringify(docBlocks), 'utf8');

  if (mask) {
    const targets = [];
    if (o.sourcesOut) for (const f of fs.readdirSync(o.sourcesOut)) targets.push(path.join(o.sourcesOut, f));
    if (docBlocks) targets.push(o.docJsonOut);
    for (const f of fs.readdirSync(o.outDir).filter(f => f.endsWith('.txt'))) targets.push(path.join(o.outDir, f));
    for (const f of targets) fs.writeFileSync(f, masker.protect(fs.readFileSync(f, 'utf8')), 'utf8');
    // Эцсийн хамгаалалт: жинхэнэ утга (өөр файлд хэв маягаар олдсон утгыг оруулаад) үлдсэн бол дахин нэг удаа
    // далдална; тэгээд ч үлдвэл задлалтыг зогсооно — Claude-д юу ч илгээгдэхгүй.
    const leakScan = () => { const s = new Set(); for (const f of targets) for (const t of masker.leaks(fs.readFileSync(f, 'utf8'))) s.add(t); return s; };
    let leaked = leakScan();
    const firstPass = leaked.size;
    if (leaked.size) {
      for (const t of leaked) masker.values.set(masker.realOf[t], t.slice(1, t.indexOf('-')));
      for (const f of targets) fs.writeFileSync(f, masker.protect(fs.readFileSync(f, 'utf8')), 'utf8');
      leaked = leakScan();
    }
    masker.leakCheck = { first_pass_leaks: firstPass, remaining_leaks: leaked.size };
    if (leaked.size) {
      if (o.maskSummaryOut) fs.writeFileSync(o.maskSummaryOut, JSON.stringify(masker.summary(), null, 2), 'utf8');
      throw new Error(`MASK GUARD: ${leaked.size} хувийн мэдээллийн утга далдлагдалгүй үлдсэн тул зогсоов (Claude-д илгээгээгүй)`);
    }
    if (firstPass) log.push(`MASK GUARD: ${firstPass} утгыг 2 дахь шатанд далдалсан`);
    // Файлын нэрэнд байгаа хувийн мэдээлэл
    for (const f of fs.readdirSync(o.outDir).filter(f => f.endsWith('.txt'))) {
      const safe = masker.protect(f).replace(/[[\]]/g, '_');
      if (safe !== f) fs.renameSync(path.join(o.outDir, f), path.join(o.outDir, safe));
    }
    fs.writeFileSync(o.maskMapOut, JSON.stringify(masker.realOf, null, 2), 'utf8');
    if (o.maskSummaryOut) fs.writeFileSync(o.maskSummaryOut, JSON.stringify(masker.summary(), null, 2), 'utf8');
    log.push(`MASK ${Object.keys(masker.realOf).length} хувийн мэдээллийн утгыг token-оор сольсон`);
  }
  return log;
}

module.exports = { extractAll, readZip, parseXml, convertDocx, convertXlsx, convertCsv, convertPdf, sensitiveCategory };

/* ======================= CLI ======================= */
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const o = {
    inputDir: path.resolve(get('--in', path.join(PATHS.root, 'input'))),
    outDir: path.resolve(get('--out', path.join(PATHS.root, 'work', 'extracted'))),
    maskMapOut: get('--mask-map') && path.resolve(get('--mask-map')),
    maskSummaryOut: get('--mask-summary') && path.resolve(get('--mask-summary')),
    docJsonOut: get('--doc-json') && path.resolve(get('--doc-json')),
    sourcesOut: get('--sources') && path.resolve(get('--sources')),
    allowText: get('--allow', ''), // аудитын нэр, салбар, код — эдгээрийг хувийн мэдээлэл гэж далдлахгүй
    seedMap: get('--seed-map') && path.resolve(get('--seed-map')), // дахин шалгалт: анхны review-ийн mask_map
  };
  for (const l of extractAll(o)) console.log(l);
}
