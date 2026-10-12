'use strict';
/*
  Follow-up эх сурвалж — IAD_RPT175 «Аудитын олдворын статус» (SP-118-04/03 §7.1 adapter, горим B: файл уншина).
  Төвийн нэг хувь: followup/current.xlsx (+ followup/current.json — нэгдсэн загвар).
  Review бүрт тухайн аудитлагдсан нэгжийн зөвлөмжийг input/followup/-д CSV болгон хавсаргана (далдлалт ердийнх шиг).
  8502 системтэй шууд холболт байхгүй — RPT-175-ын шинэ хувилбарыг вэбээс оруулна.

  Нэгдсэн мөр (followup_item): iss_id, iss_id_raw, audit, report_date, title, category, rating (Critical|High|Medium|Low), rating_mn,
    condition, criteria, cause, effect, recommendation, mgmt_action, owner, units[], due_original, due_revised, due, status_raw,
    status (S1..S7 | NA), pct, overdue_days, rag, validation, residual, closure_date, note, row (Excel мөр)

  CLI: node server/followup.js import "<RPT175.xlsx>"   |   node server/followup.js show [салбар]
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const { convertXlsx } = require('./extract');

const DIR = process.env.AR_FOLLOWUP_DIR || path.join(C.PATHS.root, 'followup');
const CUR_XLSX = () => path.join(DIR, 'current.xlsx');
const CUR_JSON = () => path.join(DIR, 'current.json');

// Толгойн нэрээр баганыг танина (баганын дараалал өөрчлөгдсөн ч ажиллана)
const COLS = {
  iss_id: /^олдвор\s*id|issue\s*id/i, audit: /^аудитын\s*нэр|audit\s*report/i, report_date: /^тайлангийн\s*огноо/i, title: /^олдворын\s*гарчиг|issue\s*title/i,
  category: /^ангилал/i, rating: /эрсдэлийн\s*зэрэглэл|risk\s*rating|severity/i, condition: /^нөхцөл/i, criteria: /^шалгуур/i, cause: /^шалтгаан/i,
  effect: /^үр\s*дагавар|^үр\s*нөлөө/i, recommendation: /^зөвлөмж/i, mgmt_action: /удирдлагын\s*арга\s*хэмжээ/i, owner: /^хариуцагч|action\s*owner/i,
  unit: /^нэгж|business\s*unit|department/i, due_original: /анхны\s*товлосон|original\s*due/i, due_revised: /шинэчилсэн\s*огноо|revised\s*due/i,
  status_raw: /хэрэгжилтийн\s*статус|^status/i, pct: /хэрэгжилтийн\s*%/i, due_effective: /үр\s*дүнтэй\s*товлолт/i, rag: /rag/i,
  validation: /ia\s*баталгаажуулалт|validation/i, residual: /үлдэгдэл\s*эрсдэл/i, closure_date: /хаалтын\s*огноо|closure/i, note: /^тайлбар/i,
  repeat: /давтагдсан|repeat/i, rc_code: /root\s*cause|шалтгааны\s*ангилал/i,
};
const RATING = { 'эгзэгтэй': 'Critical', 'critical': 'Critical', 'ноцтой': 'Critical', 'өндөр': 'High', 'high': 'High', 'дунд': 'Medium', 'medium': 'Medium', 'бага': 'Low', 'low': 'Low' };
const RATING_MN = { Critical: 'Эгзэгтэй', High: 'Өндөр', Medium: 'Дунд', Low: 'Бага' };
// Legacy статус → DOC-1906 Хав. А (S1–S7). «Done» + ДАГ баталгаажуулсан → S5, баталгаажаагүй → S4
function statusCode(raw, validation, pct) {
  const s = String(raw || '').trim().toLowerCase(), v = String(validation || '').toLowerCase();
  if (/^s[1-7]\b/.test(s)) return s.slice(0, 2).toUpperCase();
  if (/хамаарахгүй|n\/a|not applicable/.test(s)) return 'NA';
  if (/^done$|хаагдсан|баталгаажсан|closed|implemented|хэрэгжсэн$/.test(s)) return /баталгаажуулсан|баталгаажсан/.test(v) && !/хэсэгчлэн|баталгаажаагүй/.test(v) ? 'S5' : 'S4';
  if (/хүлээгдэж|pending validation|хяналт хүлээгдэж/.test(s)) return 'S4';
  if (/эрсдэл хүлээн/.test(s)) return 'S7';
  if (/хойшлуулсан|deferred/.test(s)) return 'S6';
  if (/blocked|саатсан/.test(s)) return 'S3';
  if (/хэрэгжиж байгаа|in progress|doing/.test(s) || (Number(pct) > 0 && Number(pct) < 1)) return 'S2';
  if (/to-?do|нээлттэй|open|^$/.test(s)) return 'S1';
  return 'S1';
}
const STATUS_MN = { S1: 'Нээлттэй', S2: 'Хэрэгжиж байгаа', S3: 'Саатсан', S4: 'Хэрэгжсэн — баталгаажуулалт хүлээгдэж буй', S5: 'Хаагдсан', S6: 'Хойшлуулсан', S7: 'Эрсдэл хүлээн зөвшөөрсөн', NA: 'Хамаарахгүй' };
const OPEN = new Set(['S1', 'S2', 'S3', 'S4', 'S6']);

const strip = v => String(v ?? '').replace(/\s*\{=[\s\S]*\}\s*$/, '').trim();   // томьёоны хэсгийг авна
function toDate(v) {
  const s = strip(v);
  const m = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
const CYR = { 'А': 'A', 'О': 'O', 'С': 'C', 'Е': 'E', 'Р': 'P', 'В': 'B', 'Н': 'H', 'К': 'K', 'М': 'M', 'Т': 'T', 'Х': 'X' };
const latinId = s => String(s || '').trim().replace(/[АОСЕРВНКМТХ]/g, ch => CYR[ch]).toUpperCase();

// Салбар/нэгжийн товчлол (RPT-175-д «Нэгж/Хэлтэс» товчоор бичигддэг)
const UNIT_ABBR = { 'Дижитал төлүүлэлтийн': ['ДТС'], 'Уламжлалт төлүүлэлтийн': ['УТС'] };

/** RPT-175 xlsx → { meta, items, issues } */
function parseWorkbook(buf, meta = {}) {
  const { sheets } = convertXlsx(buf);
  // «Олдвор ID» толгойтой хуудсыг хайна (нэр нь өөрчлөгдсөн ч)
  let sheet = null, hdrRow = null;
  for (const sh of sheets) {
    const h = sh.rows.find(r => r.cells.some(c => COLS.iss_id.test(String(c).trim())) && r.cells.some(c => COLS.status_raw.test(String(c).trim())));
    if (h) { sheet = sh; hdrRow = h; break; }
  }
  if (!sheet) throw new Error('RPT-175-ын «Олдворын статус» хуудас (Олдвор ID, Хэрэгжилтийн статус баганатай) олдсонгүй');
  const idx = {};
  hdrRow.cells.forEach((c, i) => { const t = String(c).trim(); for (const [k, re] of Object.entries(COLS)) if (idx[k] === undefined && t && re.test(t)) { idx[k] = i; break; } });
  const get = (cells, k) => idx[k] === undefined ? '' : strip(cells[idx[k]]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const items = [], quality = [], seen = new Map();
  let prev = null;
  for (const r of sheet.rows) {
    if (r.r <= hdrRow.r) continue;
    let raw = get(r.cells, 'iss_id');
    if (!raw && !get(r.cells, 'title')) continue;
    // Нэгтгэсэн (merge) нүд: нэг олдвор олон зөвлөмжтэй — ID зөвхөн эхний мөрөнд. Ижил аудит, гарчигтай бол дээд мөрөөс өвлөнө.
    let inherited = false;
    if (!raw && prev && prev.audit === get(r.cells, 'audit') && (!get(r.cells, 'title') || prev.title === get(r.cells, 'title'))) { raw = prev.iss_id_raw; inherited = true; }
    const ratingRaw = get(r.cells, 'rating').toLowerCase();
    const rating = RATING[ratingRaw] || null;
    const status = statusCode(get(r.cells, 'status_raw'), get(r.cells, 'validation'), get(r.cells, 'pct'));
    const due_original = toDate(get(r.cells, 'due_original')), due_revised = toDate(get(r.cells, 'due_revised'));
    const due = toDate(get(r.cells, 'due_effective')) || due_revised || due_original;
    const overdue = due && OPEN.has(status) ? Math.floor((today - new Date(due + 'T00:00:00')) / 86400000) : 0;
    // «ТАГ ЭУГ» гэх мэт таслалгүй товчлолыг ч салгана
    const units = get(r.cells, 'unit').split(/[,;/]|\s+(?=[А-ЯӨҮЁ]{2,6}(?:[\s,;]|$))/).map(s => s.trim()).filter(Boolean);
    const it = {
      iss_id: latinId(raw), iss_id_raw: raw, audit: get(r.cells, 'audit'), report_date: toDate(get(r.cells, 'report_date')), title: get(r.cells, 'title'),
      category: get(r.cells, 'category'), rating, rating_mn: RATING_MN[rating] || get(r.cells, 'rating'), condition: get(r.cells, 'condition'), criteria: get(r.cells, 'criteria'),
      cause: get(r.cells, 'cause'), effect: get(r.cells, 'effect'), recommendation: get(r.cells, 'recommendation'), mgmt_action: get(r.cells, 'mgmt_action'),
      owner: get(r.cells, 'owner'), units, due_original, due_revised, due, status_raw: get(r.cells, 'status_raw'), status, status_mn: STATUS_MN[status],
      pct: get(r.cells, 'pct'), overdue_days: overdue > 0 ? overdue : 0, rag: get(r.cells, 'rag'), validation: get(r.cells, 'validation'), residual: get(r.cells, 'residual'),
      closure_date: toDate(get(r.cells, 'closure_date')), note: get(r.cells, 'note'), repeat: get(r.cells, 'repeat'), rc_code: get(r.cells, 'rc_code'), row: r.r, sheet: sheet.name,
      inherited_id: inherited,
    };
    if (!it.title && prev && inherited) it.title = prev.title;
    it.rec_no = inherited && prev ? (prev.rec_no || 1) + 1 : 1;
    items.push(it); prev = it;
    // Өгөгдлийн чанар (DOC-1911 Хав. А, DOC-1906)
    if (!inherited && /[А-ЯЁӨҮ]/.test(raw)) quality.push({ row: r.r, type: 'cyrillic_id', text: `«${raw}» — кодонд кирилл үсэг (латин ${it.iss_id})` });
    if (!raw && !inherited) quality.push({ row: r.r, type: 'no_id', text: `Олдвор ID хоосон — «${it.title.slice(0, 60)}»` });
    // Ижил ID өөр олдворт (өөр гарчиг) хэрэглэгдсэн бол давхардал; нэг олдворын олон зөвлөмж бол хэвийн
    const s0 = seen.get(it.iss_id);
    if (raw && s0 && !inherited && s0.title !== it.title) quality.push({ row: r.r, type: 'duplicate_id', text: `«${it.iss_id}» өөр олдворт давхар хэрэглэгдсэн (мөр ${s0.row})` });
    else if (raw && !s0) seen.set(it.iss_id, { row: r.r, title: it.title });
    if (!rating) quality.push({ row: r.r, type: 'rating', text: `Зэрэглэл «${get(r.cells, 'rating') || 'хоосон'}» танигдсангүй` });
    if (!units.length && !inherited) quality.push({ row: r.r, type: 'unit', text: 'Нэгж/хэлтэс хоосон' });
    if (OPEN.has(status) && !due) quality.push({ row: r.r, type: 'due', text: 'Нээлттэй зөвлөмжид хугацаа алга' });
    if (!idx.rc_code) { /* RC код багана алга — нэг удаа доор */ }
  }
  if (idx.rc_code === undefined) quality.unshift({ row: hdrRow.r, type: 'no_rc', text: 'Шалтгааны ангилал (RC код) багана алга — давтагдсан олдворыг RC кодоор тулгах боломжгүй (DOC-1912 Хав. В)' });
  const by = k => items.reduce((a, x) => { const v = x[k] || '—'; a[v] = (a[v] || 0) + 1; return a; }, {});
  return {
    meta: { ...meta, sheet: sheet.name, header_row: hdrRow.r, columns: Object.keys(idx), parsed_at: C.nowIso(), count: items.length,
      findings: new Set(items.map(x => x.iss_id + '|' + x.title)).size,
      by_status: by('status'), by_rating: by('rating'), by_audit: by('audit'), open: items.filter(x => OPEN.has(x.status)).length,
      overdue: items.filter(x => x.overdue_days > 0).length },
    items, quality,
  };
}

/** Шинэ RPT-175 хувилбарыг төвийн эх сурвалж болгоно */
function importFile(src, { name, by } = {}) {
  const buf = fs.readFileSync(src);
  const st = fs.statSync(src);
  const fileName = name || path.basename(src);
  const m = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
  const res = parseWorkbook(buf, { file: fileName, file_date: m ? `${m[1]}-${m[2]}-${m[3]}` : null, file_modified: new Date(st.mtimeMs).toISOString().slice(0, 19), imported_by: by || null, imported_at: C.nowIso() });
  fs.mkdirSync(DIR, { recursive: true });
  C.enableEfs(DIR);
  fs.writeFileSync(CUR_XLSX(), buf);
  C.writeJson(CUR_JSON(), res);
  return res;
}
const current = () => C.readJson(CUR_JSON());

/** Аудитлагдсан нэгжийн зөвлөмжүүд: аудитын нэрэнд салбарын нэр, эсвэл «Нэгж/Хэлтэс»-т товчлол */
function forUnit(data, audit = {}) {
  if (!data) return [];
  const branch = C.normTitle(audit.branch || '').replace(/\s*салбар$/i, '');
  const keys = [branch, ...(UNIT_ABBR[branch] || [])].filter(Boolean).map(s => s.toLowerCase());
  if (!keys.length) return [];
  return data.items.filter(it => keys.some(k => it.audit.toLowerCase().includes(k) || it.units.some(u => u.toLowerCase() === k)));
}

/** Review-д хавсаргах CSV (ДАГ-ын харах баганууд) */
function toCsv(items) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Олдвор ID', 'Олдвор ID (эх бичлэг)', 'Аудитын нэр', 'Тайлангийн огноо', 'Олдворын гарчиг', 'Ангилал', 'Эрсдэлийн зэрэглэл', 'Зөвлөмж', 'Удирдлагын арга хэмжээ',
    'Хариуцагч', 'Нэгж', 'Хугацаа', 'Хугацаа сунгасан', 'Статус (S1–S7)', 'Статус (эх)', 'Хэрэгжилт %', 'Хугацаа хэтрэлт (хоног)', 'IA баталгаажуулалт', 'Хаалтын огноо', 'Тайлбар', 'RPT-175 мөр'];
  const rows = items.map(it => [it.iss_id, it.iss_id_raw, it.audit, it.report_date, it.title, it.category, it.rating_mn, it.recommendation, it.mgmt_action, it.owner, it.units.join(', '),
    it.due, it.due_revised && it.due_original && it.due_revised !== it.due_original ? `${it.due_original} → ${it.due_revised}` : '', `${it.status} ${it.status_mn}`, it.status_raw, it.pct,
    it.overdue_days || '', it.validation, it.closure_date, it.note, `R${it.row}`]);
  return '﻿' + [head, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}

/**
 * Review эхлэхэд: аудитор follow-up файл оруулаагүй бол төвийн RPT-175-аас тухайн нэгжийн мөрүүдийг input/followup/-д бичнэ.
 * Буцаах: { used, file, count, open, overdue, as_of } эсвэл null
 */
function attachToJob(jobDir, audit) {
  const data = current();
  if (!data) return null;
  const items = forUnit(data, audit);
  const dir = path.join(jobDir, 'input', 'followup');
  fs.mkdirSync(dir, { recursive: true });
  const asOf = (data.meta.file_modified || data.meta.imported_at || '').slice(0, 10);
  const file = `RPT175_${(audit.branch || 'нэгж').replace(/[^\p{L}\p{N}-]+/gu, '_')}_${asOf}.csv`;
  fs.writeFileSync(path.join(dir, file), toCsv(items), 'utf8');
  return { used: true, file, count: items.length, open: items.filter(x => OPEN.has(x.status)).length, overdue: items.filter(x => x.overdue_days > 0).length, as_of: asOf, source: data.meta.file };
}

module.exports = { DIR, parseWorkbook, importFile, current, forUnit, toCsv, attachToJob, statusCode, latinId, OPEN, STATUS_MN, RATING_MN };

if (require.main === module) {
  const [cmd, a] = process.argv.slice(2);
  if (cmd === 'import') { const r = importFile(a); console.log(JSON.stringify(r.meta, null, 1)); console.log(r.quality.length, 'чанарын тэмдэглэл'); }
  else if (cmd === 'show') { const d = current(); if (!d) return console.log('RPT-175 оруулаагүй'); const it = a ? forUnit(d, { branch: a }) : d.items; for (const x of it) console.log(`${x.iss_id}\t${x.status}\t${x.rating || '-'}\t${x.due || '-'}\t+${x.overdue_days}\t${x.audit.slice(0, 50)}\t${x.title.slice(0, 50)}`); }
  else console.log('node server/followup.js import "<RPT175.xlsx>" | show [салбар]');
}
