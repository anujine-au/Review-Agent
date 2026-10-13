'use strict';
/*
  Rule Engine — SP-118-04/02 каталогийн детерминист (D) шалгуурууд. AI ашиглахгүй, үр дүн 100% давтагдана.
  Оролт: doc.json (далдлагдсан тайлан), sandbox/extracted/*.txt, ирсэн файлын жагсаалт.
  Гаралт: { gate0, issues[], facts, insufficient_inputs[], partial_modules[] }
  - issues нь schema v3 хэлбэртэй (origin: "rule_engine"); quote нь тайлангийн текстээс яг хуулсан хэсэг.
  - facts нь LLM-д «баталгаажсан баримт» болж очно (facts/rule_engine.json).

  CLI (туршилт):  node server/rules.js <jobDir>
*/

const fs = require('fs');
const path = require('path');
const RQ = require('./recreq');

const MAX_EXAMPLES = 6;

/* ---------- Туслах ---------- */
function unitsOf(doc) {
  const units = [];
  (doc.blocks || []).forEach((b, bi) => {
    if (b.kind === 'table') (b.rows || []).forEach((r, ri) => units.push({ id: `${b.id}R${ri + 1}`, block: b.id, bi, kind: 'row', cells: r || [], text: (r || []).join(' | ') }));
    else units.push({ id: b.id, block: b.id, bi, kind: b.kind || 'p', text: b.text || '' });
  });
  return units;
}

// Тохирлын эргэн тойрноос ≤ 25 үгтэй, эх текстээс яг хуулсан ишлэл
function quoteAt(text, index, len) {
  const s = String(text);
  let a = Math.max(0, index - 70), b = Math.min(s.length, index + len + 70);
  if (a > 0) { const sp = s.indexOf(' ', a); if (sp >= 0 && sp < index) a = sp + 1; }
  if (b < s.length) { const sp = s.lastIndexOf(' ', b); if (sp > index + len) b = sp; }
  let q = s.slice(a, b).replace(/\t/g, ' ');
  // Хүснэгтийн мөрд нүдний хил давахгүй
  q = q.split(' | ').find(part => part.includes(s.slice(index, index + len).split(' | ')[0])) || q;
  const words = q.trim().split(/\s+/);
  if (words.length > 25) {
    const hit = s.slice(index, index + len);
    const wi = Math.max(0, words.findIndex(w => hit.includes(w) || w.includes(hit.split(/\s+/)[0])));
    q = words.slice(Math.max(0, wi - 10), Math.max(0, wi - 10) + 25).join(' ');
  }
  return q.trim();
}

// Бүх тохирол: [{u, index, match}]
function scan(units, re, filter = () => true) {
  const out = [];
  for (const u of units) {
    if (!filter(u)) continue;
    re.lastIndex = 0;
    for (const m of u.text.matchAll(re)) out.push({ u, index: m.index, match: m[0], m });
  }
  return out;
}

function issue(fields) {
  return {
    id: null, severity: 'R3', module: fields.rule.split('-')[0], confidence: 'High', category: 'LANGUAGE',
    anchor: null, quote: '', title: '', issue: '', why_it_matters: '', evidence: [], required_action: '', suggested_text: '',
    impacts: [], resolution_check: '', draft_source: false, origin: 'rule_engine', ...fields,
  };
}

// Олон тохиролыг нэг санал болгох (эхний тохирол = anchor, бусад нь evidence)
function grouped(hits, reportFile, fields, detail = h => h.match) {
  if (!hits.length) return null;
  const first = hits[0];
  const anchors = [...new Set(hits.map(h => h.u.id))];
  const examples = hits.slice(0, MAX_EXAMPLES).map(h => ({ file: reportFile, anchor: h.u.id, source: `${reportFile} › ${h.u.id}`, detail: String(detail(h)).slice(0, 120) }));
  return issue({
    anchor: first.u.id, quote: quoteAt(first.u.text, first.index, first.match.length),
    evidence: examples, ...fields,
    issue: fields.issue.replace('{n}', String(hits.length)).replace('{places}', String(anchors.length)),
  });
}

const CYR_LOOK = 'АВЕКМНОРСТХ';
const toLatinLook = s => s.replace(/[АВЕКМНОРСТХ]/g, ch => 'ABEKMHOPCTX'[CYR_LOOK.indexOf(ch)]);

/* ---------- Шалгуурууд ---------- */
function checkReport(units, ctx) {
  const R = ctx.reportFile;
  const out = [];
  const add = x => { if (x) out.push(x); };
  const paras = u => u.kind !== 'row';
  const body = u => u.kind === 'p';
  const all = units.map(u => u.text).join('\n');

  // M01-02 — Бүртгэлийн дугаар, Баталгаажуулсан огноо (нүүр хэсэгт)
  const head = units.slice(0, Math.min(units.length, 60));
  const hasReg = head.some(u => /бүртгэлийн\s*(дугаар|№)/i.test(u.text));
  const hasApp = head.some(u => /баталгаажуулсан\s*огноо/i.test(u.text));
  if (!hasReg || !hasApp) {
    const missing = [!hasReg && '«Бүртгэлийн дугаар»', !hasApp && '«Баталгаажуулсан огноо»'].filter(Boolean).join(', ');
    add(issue({ rule: 'M01-02', severity: 'R1', category: 'STRUCTURE', anchor: units[0]?.id || null,
      title: 'Нүүрэнд бүртгэлийн дугаар, огнооны талбар алга',
      issue: `Тайлангийн нүүр хэсэгт ${missing} талбар байхгүй.`,
      why_it_matters: 'Батлагдсан тайланг бүртгэж, хэзээ хүчин төгөлдөр болсныг тогтоох боломжгүй.',
      required_action: `Нүүр хуудсанд ${missing} талбар нэмэх (батлах үед бөглөнө).`,
      resolution_check: 'Нүүрэнд хоёр талбар байгаа эсэх.', source: 'DOC-1912 §14.5', draft_source: true }));
  }

  // M03-05 — RC код
  const rcHits = scan(units, /\bRC-([A-Z])\b/g);
  const badRc = rcHits.filter(h => !'PHSCGTD'.includes(h.m[1]));
  if (!rcHits.length && /шалтгаан/i.test(all)) {
    const h = scan(units, /шалтгаан/gi, paras)[0];
    add(issue({ rule: 'M03-05', severity: 'R2', category: '5C_MISSING', anchor: h?.u.id || null, quote: h ? quoteAt(h.u.text, h.index, h.match.length) : '',
      title: 'Шалтгааны ангиллын код огт алга',
      issue: 'Тайланд шалтгааны ангиллын код (RC-P, RC-H, RC-S, RC-C, RC-G, RC-T, RC-D) нэг ч удаа хэрэглэгдээгүй.',
      why_it_matters: 'Давтагдсан олдвор, системийн шалтгааныг тайлан хооронд тулгах боломжгүй болно.',
      required_action: 'Олдвор бүрийн шалтгаанд 7 ангиллын нэг RC кодыг тэмдэглэх.',
      resolution_check: 'Олдвор бүрийн C3-т RC код байгаа эсэх.', source: 'DOC-1912 Хав. А.1', draft_source: true }));
  }
  add(grouped(badRc, R, { rule: 'M03-05', severity: 'R2', category: '5C_MISSING', title: 'Шалтгааны код буруу',
    issue: 'Зөвшөөрөгдөөгүй RC код {n} удаа хэрэглэгдсэн (зөвхөн P/H/S/C/G/T/D).', why_it_matters: 'Шалтгааны ангилал тайлан хооронд тулгагдахгүй.',
    required_action: 'RC кодыг DOC-1912 Хав. А.1-ийн 7 ангиллын нэгээр солих.', source: 'DOC-1912 Хав. А.1', draft_source: true }));

  // M03-10 — хүчингүй нэршил
  add(grouped(scan(units, /CCCCI|ажиглалтын\s+(5|таван)\s+элемент/gi), R, { rule: 'M03-10', severity: 'R2', category: '5C_MISSING',
    title: 'Хүчингүй олдворын загвар хэрэглэсэн', issue: 'CCCCI / «Ажиглалтын 5 элемент» гэсэн хуучин нэршил {n} удаа байна.',
    why_it_matters: 'Олдвор DOC-1912-ийн 5C бүтэцтэй нийцэхгүй.', required_action: 'Олдворыг 5C (шалгуур, нөхцөл, шалтгаан, үр нөлөө, зөвлөмж) бүтцээр бичих.',
    source: 'DOC-1912 Хав. А.3', draft_source: true }));

  // M04-01 — зэрэглэлийн нэршил
  add(grouped(scan(units, /\b(Major|Minor|Moderate)\b|(?<![\p{L}])(Мажор|Минор)(?![\p{L}])/giu), R, { rule: 'M04-01', severity: 'R2', category: 'RATING',
    title: 'Зэрэглэлийн нэршил стандартаас өөр', issue: 'Major / Minor зэрэг стандартад байхгүй зэрэглэлийн нэршил {n} удаа хэрэглэгдсэн.',
    why_it_matters: 'Зэрэглэл DOC-1912-ийн 4 түвшинд хөрвөхгүй, хугацаа, эскалаци буруу тогтоогдоно.',
    required_action: 'Зэрэглэлийг зөвхөн Critical / Өндөр / Дунд / Бага гэж бичих.', source: 'DOC-1912 §7.3.1', draft_source: true }));

  // M04-02 — оноо ↔ зэрэглэл (хүснэгт ба мөр доторх «Өндөр (оноо 5)»)
  const ratingOf = s => {
    const t = String(s).toLowerCase();
    if (/critical|эгзэгтэй|ноцтой/.test(t)) return 'Critical';
    if (/(^|[^\p{L}])(high|өндөр)/u.test(t) && !/маш\s+өндөр/.test(t)) return 'High';
    if (/medium|дунд/.test(t)) return 'Medium';
    if (/(^|[^\p{L}])(low|бага)/u.test(t)) return 'Low';
    return null;
  };
  const expectFor = n => n >= 8 ? 'Critical' : n >= 6 ? 'High' : n >= 4 ? 'Medium' : 'Low';
  const MN = { Critical: 'Critical', High: 'Өндөр', Medium: 'Дунд', Low: 'Бага' };
  const scoreHits = [];
  const tables = new Map();
  for (const u of units) if (u.kind === 'row') { if (!tables.has(u.block)) tables.set(u.block, []); tables.get(u.block).push(u); }
  for (const rows of tables.values()) {
    const hdr = rows[0]?.cells || [];
    const sc = hdr.findIndex(c => /оноо|score/i.test(c)), rt = hdr.findIndex(c => /зэрэглэл|rating/i.test(c));
    if (sc < 0 || rt < 0 || sc === rt) continue;
    for (const u of rows.slice(1)) {
      const n = Number(String(u.cells[sc] || '').trim()), r = ratingOf(u.cells[rt] || '');
      if (Number.isInteger(n) && n >= 1 && n <= 10 && r && r !== expectFor(n)) {
        const cell = String(u.cells[rt]);
        scoreHits.push({ u, index: u.text.indexOf(cell), match: cell, detail: `${MN[r]} — оноо ${n} (${MN[expectFor(n)]} байх ёстой)` });
      }
    }
  }
  for (const h of scan(units, /(Critical|Эгзэгтэй|Өндөр|High|Дунд|Medium|Бага|Low)\s*[(\/,–-]?\s*(?:оноо|score)\s*[:\-–]?\s*(\d{1,2})|(Critical|Эгзэгтэй|Өндөр|High|Дунд|Medium|Бага|Low)\s*\(\s*(\d{1,2})\s*оноо/giu)) {
    const r = ratingOf(h.m[1] || h.m[3]), n = Number(h.m[2] || h.m[4]);
    if (r && n >= 1 && n <= 10 && r !== expectFor(n)) scoreHits.push({ ...h, detail: `${MN[r]} — оноо ${n} (${MN[expectFor(n)]} байх ёстой)` });
  }
  add(grouped(scoreHits.filter(h => h.index >= 0), R, { rule: 'M04-02', severity: 'R1', category: 'RATING',
    title: 'Зэрэглэл оноотойгоо тохирохгүй', issue: 'Зэрэглэл ба оноо {n} газарт зөрсөн (8–10 Critical, 6–7 Өндөр, 4–5 Дунд, 1–3 Бага).',
    why_it_matters: 'Буруу зэрэглэл нь хугацаа, эскалаци, нийт дүгнэлтийг өөрчилнө.', required_action: 'Оноо эсвэл зэрэглэлийг матрицтай нийцүүлж, өөрчилсөн бол үндэслэл бичих.',
    impacts: [{ element: 'Зөвлөмжийн хугацаа, эскалаци, хураангуйн зэрэглэлийн задаргаа', action: 'дахин тулгах' }],
    source: 'DOC-1912 §7.3.1', draft_source: true }, h => h.detail));

  // M06-01 — WP / EVD лавлагаа
  const hasWp = /\bWP-[A-Z0-9]/.test(all), hasEvd = /\bEVD-[A-Z0-9]/.test(all);
  if (!hasWp || !hasEvd) {
    const miss = [!hasWp && 'ажлын баримт (WP-…)', !hasEvd && 'нотлох баримт (EVD-…)'].filter(Boolean).join(', ');
    add(issue({ rule: 'M06-01', severity: 'R1', category: 'EVIDENCE',
      title: 'Олдворт ажлын баримтын лавлагаа алга', issue: `Тайланд ${miss} кодын лавлагаа нэг ч удаа байхгүй.`,
      why_it_matters: 'Олдвор бүрийг нотолгоо руу мөшгөх боломжгүй — QAIP хяналтад доголдол болно.',
      required_action: 'Олдвор бүрд холбогдох WP ба EVD кодыг (DOC-1911 Хав. А) бичих.',
      resolution_check: 'Олдвор бүрд ≥ 1 WP ба EVD код байгаа эсэх.', source: 'GIAS 14.6; DOC-1910 F2/F3', draft_source: true }));
  }

  // M06-02 / M12 — кирилл үсэг холилдсон код
  const codeRe = /(?<![\p{L}\p{N}\[])[A-Za-zА-ЯЁӨҮ]{1,6}(?:-[A-Za-zА-ЯЁӨҮ0-9]{1,10}){1,6}(?![\p{L}\p{N}])/gu;
  const mixed = scan(units, codeRe).filter(h => {
    const s = h.match;
    if (!/\d/.test(s)) return false;
    const lat = /[A-Za-z]/.test(s), cyr = /[А-ЯЁӨҮ]/.test(s);
    if (lat && cyr) return true;
    const first = s.split('-')[0];
    return cyr && !lat && [...first].every(ch => CYR_LOOK.includes(ch)) && ['AO', 'TC', 'OP', 'PC', 'KT'].includes(toLatinLook(first));
  });
  add(grouped(mixed, R, { rule: 'M06-02', severity: 'R2', category: 'CODING',
    title: 'Кодонд кирилл үсэг холилдсон', issue: 'Латин байх ёстой кодонд кирилл үсэг {n} удаа холилдсон (А/О/С/Е/Р г.м.).',
    why_it_matters: 'Код бүртгэл, follow-up системтэй автоматаар тулгагдахгүй.', required_action: 'Кодыг зөвхөн латин том үсэг, тоогоор дахин бичих.',
    source: 'DOC-1911 Хав. А', draft_source: true }, h => h.match));

  // M07-02 — хүчингүй стандарт
  add(grouped(scan(units, /\bIPPF\b|мэргэжлийн\s+практикийн\s+олон\s+улсын\s+(хүрээ|стандарт)/gi), R, { rule: 'M07-02', severity: 'R3', category: 'COMPLIANCE',
    title: 'Хүчингүй IPPF стандарт иш татсан', issue: 'Хүчингүй болсон IPPF (2200–2500)-г {n} удаа иш татсан; GIAS 2024 хүчин төгөлдөр.',
    why_it_matters: 'Тайлан хүчингүй стандартад тулгуурласан мэт харагдана.', required_action: 'Лавлагааг GIAS 2024-ийн холбогдох зарчим (13–15)-аар солих.',
    source: 'GIAS 2024; KB-CONFLICT-02' }));

  // M07-06 — хувийн мэдээлэл тайланд
  const pii = scan(units, /\[(ID|ACCT|PHONE)-\d{4}\]/g);
  const piiRaw = ctx.mask ? [] : scan(units, /(?<![\p{L}])[А-ЯӨҮ]{2}\d{8}(?!\d)/gu);
  add(grouped(pii.length ? pii : piiRaw, R, { rule: 'M07-06', severity: 'R2', category: 'COMPLIANCE',
    title: 'Тайланд хувийн мэдээлэл ил гарсан', issue: 'Регистр, данс эсвэл утасны дугаар {n} удаа шууд бичигдсэн.',
    why_it_matters: 'Тайлан түгээгдэхэд хувийн мэдээлэл задарна (Хувийн мэдээлэл хамгаалах тухай хууль).',
    required_action: 'Дугааруудыг хасах эсвэл хавсралтын дугаараар лавлах.', source: 'ХХМХТХ; DOC-1914' }, h => h.m[1] ? { ID: 'регистр', ACCT: 'данс', PHONE: 'утас' }[h.m[1]] || h.match : 'регистр'));

  // M09-03 — ерөнхий удирдлагын хариу (нэр дэвшигч, D+J)
  add(grouped(scan(units, /анхааралдаа\s+авлаа|анхааралдаа\s+авч\s+ажиллана|анхаарч\s+ажиллана|хяналтаа\s+сайжруулна|\bnoted\b/gi), R, { rule: 'M09-03', severity: 'R2', confidence: 'Medium', category: 'MGMT_RESPONSE',
    title: 'Удирдлагын хариу ерөнхий', issue: '«Анхааралдаа авлаа», «анхаарч ажиллана» маягийн тодорхой бус хариу {n} удаа байна.',
    why_it_matters: 'Эзэн, хугацаа, арга хэмжээгүй хариуг follow-up-д хянах боломжгүй.',
    required_action: 'Удирдлагаас тодорхой арга хэмжээ, эзэн, зорилтот огноотой хариу авах.', source: 'DOC-1912 §8.2', draft_source: true }));

  // M11-01 — огнооны формат
  const dateHits = scan(units, /(?<![\d.])(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|\d{4}\.\d\.\d{1,2}|\d{4}\.\d{2}\.\d(?!\d))(?![\d])/g);
  add(grouped(dateHits, R, { rule: 'M11-01', severity: 'R3', category: 'LANGUAGE', title: 'Огнооны бичлэг стандартаас өөр',
    issue: 'yyyy.mm.dd-ээс өөр хэлбэрийн огноо {n} удаа ({places} газар) байна.', why_it_matters: 'Тайлан даяар огнооны бичлэг жигд биш.',
    required_action: 'Бүх огноог yyyy.mm.dd (жишээ 2026.09.08) хэлбэрт оруулах.', source: 'Аргачлал II.3' }));

  // M11-02 — мөнгөн тэмдэгт
  add(grouped(scan(units, /\bMNT\b|\bUSD\b|₮/g, u => u.kind !== 'row' || !/^\s*(MNT|USD)\s*$/.test(u.text)), R, { rule: 'M11-02', severity: 'R3', category: 'LANGUAGE',
    title: 'Мөнгөн дүнгийн бичлэг стандартаас өөр', issue: 'MNT, USD, ₮ тэмдэглэгээ {n} удаа хэрэглэгдсэн.', why_it_matters: 'Аргачлалд «төгрөг», «ам.доллар» гэж бичихээр заасан.',
    required_action: '«10.0 сая төгрөг», «9.08 ам.доллар» хэлбэрээр бичих.', source: 'Аргачлал II.3' }));

  // M11-03 — өгүүлбэр тоогоор эхлэх (жагсаалтын дугаарлалтыг тооцохгүй)
  const numStart = [];
  for (const u of units) {
    if (!body(u)) continue;
    const re = /(^|[.!?]\s+)(\d[\d,.]*\s+[\p{Ll}])/gu;
    for (const m of u.text.matchAll(re)) {
      const at = m.index + m[1].length;
      const rest = u.text.slice(at);
      if (/^\d+(\.\d+)*[.)]\s/.test(rest) || /^\d+(\.\d+)*\s+(дугаар|дүгээр|дахь|дэх)/.test(rest)) continue;
      if (at === 0 && /^\d+(\.\d+)+\s/.test(rest)) continue; // «2.1 Зорилго» маягийн гарчиг
      numStart.push({ u, index: at, match: m[2] });
    }
  }
  add(grouped(numStart, R, { rule: 'M11-03', severity: 'R3', category: 'LANGUAGE', title: 'Өгүүлбэр тоогоор эхэлсэн',
    issue: 'Тоогоор эхэлсэн өгүүлбэр {n} удаа байна.', why_it_matters: 'Аргачлалд өгүүлбэрийг тоогоор эхлүүлэхгүй гэж заасан.',
    required_action: 'Өгүүлбэрийг үгээр эхлүүлэх (жишээ: «Нийт 15 зээл…»).', source: 'Аргачлал I.10' }));

  // M11-06 — зөв бичгийн хар жагсаалт
  const BAD = [['баримтанд', 'баримтад'], ['хавсралтанд', 'хавсралтад'], ['хүснэгтэнд', 'хүснэгтэд'], ['эрсдлийн', 'эрсдэлийн'], ['нөхцлийн', 'нөхцөлийн'],
    ['компаны', 'компанийн'], ['компаний', 'компанийн'], ['дараахи', 'дараах'], ['идэвхигүй', 'идэвхгүй'], ['дурьдсан', 'дурдсан'], ['хүүний түвшин', 'хүүгийн түвшин'],
    ['банкыг', 'банкийг'], ['ажилчид', 'ажилтнууд'], ['дансдууд', 'данснууд']];
  const spellRe = new RegExp(`(?<![\\p{L}])(${BAD.map(b => b[0]).join('|')})(?![\\p{L}])`, 'giu');
  add(grouped(scan(units, spellRe), R, { rule: 'M11-06', severity: 'R3', category: 'LANGUAGE', title: 'Зөв бичгийн алдаа',
    issue: 'Аргачлалын жагсаалтад орсон буруу бичлэг {n} удаа байна.', why_it_matters: 'Албан баримтын хэлний чанар.',
    required_action: 'Жагсаалтын дагуу засах (жишээ: баримтанд → баримтад).', source: 'Аргачлал II.6' },
  h => { const b = BAD.find(x => x[0] === h.match.toLowerCase()); return b ? `${h.match} → ${b[1]}` : h.match; }));

  // M12-01 — хуучин тайлангийн дугаар
  add(grouped(scan(units, /\bRPT-00\d{2}\b/g), R, { rule: 'M12-01', severity: 'R3', category: 'CODING', title: 'Хуучин тайлангийн дугаар хэрэглэсэн',
    issue: 'RPT-00NN хэлбэрийн хуучин дугаар {n} удаа байна.', why_it_matters: 'Тайлангийн бүртгэлтэй тулгагдахгүй.',
    required_action: 'Тайлангийн дугаарыг RPT-1NN (аудитын тайлан RPT-174) болгох.', source: 'DOC-1911 Хав. Б' }));

  // M12-03 — Engagement ID
  const engIds = [...new Set((all.match(/\bIA-\d{4}-[A-Z]{2}-\d{3}\b/g) || []))];
  if (!engIds.length) {
    add(issue({ rule: 'M12-03', severity: 'R2', category: 'CODING', anchor: units[0]?.id || null,
      title: 'Аудитын (engagement) код алга', issue: 'Тайланд IA-YYYY-TT-NNN хэлбэрийн аудитын код байхгүй.',
      why_it_matters: 'Тайлан, ажлын баримт, follow-up бүртгэлийг нэг кодоор холбох боломжгүй.',
      required_action: 'Нүүр хуудсанд аудитын кодыг (жишээ IA-2026-AS-004) бичих.', source: 'DOC-1911 Хав. А', draft_source: true }));
  }
  const badIss = scan(units, /\bISS-[A-Za-z0-9-]+/g).filter(h => !/^ISS-IA-\d{4}-[A-Z]{2}-\d{3}-\d{2}$/.test(h.match));
  add(grouped(badIss, R, { rule: 'M12-03', severity: 'R2', category: 'CODING', title: 'Олдворын кодын формат буруу',
    issue: 'ISS-<EngID>-NN хэлбэрт нийцээгүй олдворын код {n} удаа байна.', why_it_matters: 'Олдвор follow-up бүртгэлтэй тулгагдахгүй.',
    required_action: 'Олдворын кодыг ISS-IA-YYYY-TT-NNN-NN хэлбэрээр бичих.', source: 'DOC-1911 Хав. А', draft_source: true }, h => h.match));

  // M12-04 — нууцлалын тэмдэглэгээ (толгой/хөл задлагдаагүй байж болох тул Medium)
  if (!/internal\s+audit\s*[–—-]\s*restricted|restricted|confidential|нууц|хязгаарлагдмал\s+хэрэглээ/i.test(all)) {
    add(issue({ rule: 'M12-04', severity: 'R2', confidence: 'Medium', category: 'CODING', anchor: units[0]?.id || null,
      title: 'Нууцлалын тэмдэглэгээ алга', issue: 'Тайланд «Internal Audit – Restricted» эсвэл «Нууц» гэсэн тэмдэглэгээ олдсонгүй (толгой/хөлд байвал шалгана уу).',
      why_it_matters: 'Тайланг хэнд түгээж болохыг уншигч мэдэхгүй.', required_action: 'Толгой эсвэл нүүрэнд нууцлалын ангиллыг бичих.', source: 'DOC-1914' }));
  }

  // M12-05 — хуучин лавлагаа (баримтын сангийн каталогт байгаа DOC-0xxx нь хүчинтэй баримт — M08-08-ын зорилт)
  const libIds = new Set(((ctx.recreq || {}).catalog || []).map(d => d.id).filter(Boolean));
  add(grouped(scan(units, /\bDOC-0\d{3}\b|\bIO-\d{2,}/g).filter(h => !libIds.has(h.match)), R, { rule: 'M12-05', severity: 'R3', category: 'CODING', title: 'Хуучин баримтын лавлагаа үлдсэн',
    issue: 'Хүчингүй DOC-0xxx / IO-xxx лавлагаа {n} удаа байна.', why_it_matters: 'Хуучирсан журам руу заана.',
    required_action: 'Лавлагааг DOC-19xx шинэ дугаараар солих.', source: 'DOC-1915' }, h => h.match));

  // M02-05 — хамрах хугацааны интервал их биед давтагдсан
  const rangeRe = /\d{4}\.\d{2}\.\d{2}\s*[-–—]\s*\d{4}\.\d{2}\.\d{2}/g;
  const firstH1 = units.findIndex(u => /^h1$/.test(u.kind));
  const coverEnd = firstH1 > 0 ? firstH1 : Math.min(units.length, 25);
  const coverRanges = new Set(scan(units.slice(0, coverEnd), rangeRe).map(h => h.match.replace(/\s/g, '').replace(/[–—]/g, '-')));
  const repeats = scan(units.slice(coverEnd), rangeRe, body).filter(h => coverRanges.has(h.match.replace(/\s/g, '').replace(/[–—]/g, '-')));
  add(grouped(repeats, R, { rule: 'M02-05', severity: 'R3', category: 'LANGUAGE', title: 'Хамрах хугацаа их биед давтагдсан',
    issue: 'Нүүрэнд бичсэн хамрах хугацааны интервал их биед {n} удаа давтагдсан.', why_it_matters: 'Аргачлалд хамрах хугацааг их биед давтахгүй гэж заасан.',
    required_action: 'Их биеэс интервалыг хасаж, «аудит хамарсан хугацаанд» гэж бичих.', source: 'Аргачлал II.3' }));

  return { issues: out, facts: { engagement_ids: engIds, rc_codes: [...new Set(rcHits.map(h => h.match))], has_wp: hasWp, has_evd: hasEvd, has_registration_field: hasReg, has_approval_date_field: hasApp } };
}

/* ---------- Prompt injection (G0-06) — бүх задалсан файлд ---------- */
const INJECTION_RE = /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions?|prompt|rules)\b|\bsystem\s+prompt\b|\byou\s+are\s+(now\s+)?(an?\s+)?(ai|assistant|chatgpt|claude)\b|\b(AI|Claude|ChatGPT|GPT|LLM|агент|хиймэл\s+оюун)\s*[:：]\s*\S|(PASS|READY|зөв|асуудалгүй)\s*гэж\s*(бич|тэмдэглэ|дүгнэ)|өмнөх\s+заавр\S*\s+(үл\s+тоо|орхи|март)/giu;
function checkInjection(extractedDir, reportFile, units) {
  const hits = [];
  if (extractedDir && fs.existsSync(extractedDir)) {
    for (const f of fs.readdirSync(extractedDir)) {
      if (!f.endsWith('.txt') || f.endsWith('.profile.txt')) continue;
      const lines = fs.readFileSync(path.join(extractedDir, f), 'utf8').split(/\r?\n/);
      let src = f, sheet = '';
      for (const line of lines) {
        if (line.startsWith('# SOURCE:')) { src = line.slice(9).trim().split('/').pop(); continue; }
        const sh = line.match(/^=== SHEET:\s*(.+?)\s*===$/) || line.match(/^SHEET:\s*(.+)$/); if (sh) { sheet = sh[1].trim(); continue; }
        INJECTION_RE.lastIndex = 0;
        const m = INJECTION_RE.exec(line);
        if (!m) continue;
        const loc = line.match(/^\[(P\d+)\]|^(T\d+R\d+)\b|^R(\d+)\t/);
        hits.push({ file: src, isReport: f.startsWith('report__'), anchor: loc ? (loc[1] || loc[2]) : null, rows: loc && loc[3] ? `R${loc[3]}` : null, sheet, text: m[0] });
      }
    }
  }
  if (!hits.length) return null;
  const rep = hits.find(h => h.isReport && h.anchor);
  const u = rep && units.find(x => x.id === rep.anchor);
  const idx = u ? u.text.search(new RegExp(rep.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')) : -1;
  return issue({ rule: 'G0-06', module: 'G0', severity: 'R2', confidence: 'Medium', category: 'INPUT',
    anchor: u ? u.id : null, quote: u && idx >= 0 ? quoteAt(u.text, idx, rep.text.length) : '',
    title: 'Оролтод AI-д хандсан заавар маягийн бичвэр', issue: `AI-д зориулсан заавар маягийн бичвэр ${hits.length} газар илэрсэн; агент үүнийг өгөгдөл гэж үзэж, гүйцэтгээгүй.`,
    why_it_matters: 'Хяналтын үр дүнд зориудаар нөлөөлөх оролдлого байж болзошгүй.',
    required_action: 'Бичвэрийн гарал үүслийг тодруулж, шаардлагагүй бол файлаас хасах.',
    evidence: hits.slice(0, MAX_EXAMPLES).map(h => ({ file: h.file, ...(h.sheet && h.rows ? { sheet: h.sheet, rows: h.rows } : {}), ...(h.anchor ? { anchor: h.anchor } : {}), source: [h.file, h.sheet, h.anchor || h.rows].filter(Boolean).join(' › '), detail: h.text.slice(0, 80) })),
    source: 'DOC-1917 §4' });
}

/* ---------- Gate-0 ---------- */
function gate0(ctx, units) {
  const c = ctx.counts || {};
  const notes = [], issues = [], insufficient = [], partial = [];
  const inputs = { report: !!c.report && units.length > 0, annex: !!c.excel, program: !!c.program, evidence: !!c.evidence, followup: !!c.followup };
  if (!inputs.report) return { gate: { status: 'REJECTED', inputs, notes: ['G0-01: үндсэн тайлан алга эсвэл уншигдахгүй'] }, issues, insufficient: ['Үндсэн тайлан'], partial: ['G0'] };

  const ver = String(ctx.reportFile || '').match(/(?:^|[^a-z])v(\d+)(?:\.(\d+))?(?!\d)/i);
  const version = ver ? `v${ver[1]}.${ver[2] || 0}` : null;
  notes.push(`Source_Doc_ID: ${ctx.sourceDocId} · хувилбар: ${version || 'файлын нэрэнд алга'}`);

  // M12-02 (G0-02-ийг хамруулна) — файлын нэр
  if (!/^IAD_RPT\d{3}_.+_\d{4}-\d{2}-\d{2}_v\d+\.\d+\.(docx|pdf)$/i.test(ctx.reportFile || '')) {
    issues.push(issue({ rule: 'M12-02', severity: 'R3', category: 'CODING',
      title: 'Тайлангийн файлын нэр стандартаас өөр', issue: `Файлын нэр «${ctx.reportFile}» нь IAD_RPT174_<Нэр>_YYYY-MM-DD_vM.m хэлбэрт нийцэхгүй${version ? '' : '; хувилбарын дугаар алга'}.`,
      why_it_matters: 'Хувилбар хооронд аль нь сүүлийнх болохыг тодорхойлох, бүртгэхэд хүндрэлтэй.',
      required_action: 'Файлыг IAD_RPT174_<Нэр>_YYYY-MM-DD_v1.0.docx гэж нэрлэх.', evidence: [{ file: ctx.reportFile, source: ctx.reportFile, detail: 'файлын нэр' }],
      source: 'DOC-1911 Б.3', draft_source: true }));
  }
  if (!inputs.program) {
    partial.push('M02');
    insufficient.push('Аудитын хөтөлбөр ирээгүй — M02 (хөтөлбөрийн хэрэгжилт) PARTIAL');
    issues.push(issue({ rule: 'G0-03', module: 'G0', severity: 'R2', category: 'INPUT',
      title: 'Аудитын хөтөлбөр хавсаргаагүй', issue: 'Хөтөлбөрийн алхам бүр гүйцэтгэгдсэн эсэхийг тулгах боломжгүй.',
      why_it_matters: 'Хийгдээгүй журам тайланд хязгаарлалтгүйгээр орхигдсон эсэхийг захирал мэдэхгүй.',
      required_action: 'Аудитын хөтөлбөрийг (гүйцэтгэлийн төлөвтэй) хавсаргаж дахин илгээх.', source: 'DOC-1916 §6.3.3', draft_source: true }));
  }
  if (!inputs.followup) { partial.push('M10'); insufficient.push('Follow-up extract (RPT-175 / 8502) ирээгүй — M10 PARTIAL (нээлттэй, давтагдсан олдвор тулгаагүй)'); }
  else {
    const d = String(ctx.followupFile || '').match(/(\d{4})[-.](\d{2})[-.](\d{2})/);
    if (!d) notes.push('G0-05: follow-up extract-ийн огноо файлын нэрээс тодорхойгүй');
    else {
      const age = Math.floor((Date.now() - new Date(`${d[1]}-${d[2]}-${d[3]}T00:00:00`).getTime()) / 86400000);
      if (age > 35) issues.push(issue({ rule: 'G0-05', module: 'G0', severity: 'R3', category: 'INPUT',
        title: 'Follow-up мэдээлэл хуучирсан', issue: `Follow-up extract ${d[1]}.${d[2]}.${d[3]}-ны (${age} хоногийн өмнөх) байна; 35 хоногоос хуучин.`,
        why_it_matters: 'Сүүлийн сарын хэрэгжилт, хугацаа хэтрэлт тусгагдахгүй.', required_action: 'Сүүлийн сарын RPT-175 extract-ийг оруулах.',
        evidence: [{ file: ctx.followupFile, source: ctx.followupFile, detail: 'файлын огноо' }], source: 'IAD Register RPT-175' }));
    }
  }
  if (!inputs.annex) insufficient.push('Excel хавсралт ирээгүй — M05 тоон тулгалт зөвхөн тайлан доторх тоогоор');

  // G0-04 — «Хавсралт N» лавлагаа
  const refs = new Map();
  // «журмын Хавсралт 2», «тушаалын Хавсралт 1–4» — өөр баримтын хавсралт, тайлангийнх биш
  const foreignAnnex = before => /(журм|журам|тушаал|заавар|дүрэм|гэрээ|бодлог|стандарт|шийдвэр|тогтоол)\S*[»"”]?\S*\s*$|[\p{L}»"”](ын|ийн|ний|гийн|-ын|-ийн)\s*$/iu.test(before.slice(-40));
  for (const h of scan(units, /хавсралт[\s№-]*(\d{1,2})(?!\d)/giu)) {
    if (foreignAnnex(h.u.text.slice(0, h.index))) continue;
    const n = Number(h.m[1]); if (!refs.has(n)) refs.set(n, []); refs.get(n).push(h.u.id); }
  const received = (ctx.files || []).filter(f => ['excel', 'evidence'].includes(f.category)).map(f => f.name);
  // Тайлангийн төгсгөлд өөрөө агуулагдсан хавсралт («Хавсралт 3» гарчигтай хэсэг) — ирсэн гэж тооцно
  const inside = new Set(units.filter(u => u.text.trim().length < 120).map(u => u.text.trim().match(/^хавсралт[\s№-]*(\d{1,2})(?!\d)/iu)).filter(Boolean).map(m => Number(m[1])));
  const annexRefs = [...refs.entries()].sort((a, b) => a[0] - b[0]).map(([n, anchors]) => ({ n, anchors: [...new Set(anchors)].slice(0, 5), in_report: inside.has(n) }));
  // Хавсралт ирсэн эсэх: Excel-ийн sheet нэр («1», «Хавсралт 1», «Хав.1 …») эсвэл файлын нэр («…Хавсралт 2…»)
  const sheetNames = (ctx.sources || []).filter(s => s.kind === 'sheet' || s.sheet).map(s => String(s.sheet || ''));
  const hasAnnex = n => sheetNames.some(s => new RegExp(`^\\s*(хавсралт|хав\\.?|annex)?\\s*[№#-]?\\s*${n}(?!\\d)`, 'iu').test(s))
    || received.some(f => new RegExp(`(хавсралт|annex)[\\s_№-]*${n}(?!\\d)`, 'iu').test(f));
  for (const r of annexRefs) r.received = r.in_report || hasAnnex(r.n);
  const external = annexRefs.filter(r => !r.received);
  const maxRef = external.length;
  if (maxRef > 0) {
    const first = external[0];
    const u = units.find(x => x.id === first.anchors[0]);
    const m = u && u.text.match(new RegExp(`хавсралт[\\s№-]*${first.n}(?!\\d)`, 'iu'));
    issues.push(issue({ rule: 'G0-04', module: 'G0', severity: 'R2', confidence: 'Medium', category: 'INPUT',
      anchor: u ? u.id : null, quote: u && m ? quoteAt(u.text, m.index, m[0].length) : '',
      title: 'Тайланд дурдсан хавсралт ирээгүй', issue: `Тайланд дурдсан Хавсралт ${external.map(r => r.n).join(', ')} нь ирсэн файл, Excel-ийн sheet-үүдийн аль алинд олдсонгүй.`,
      why_it_matters: 'Хавсралтгүй тоо, нотолгоог тулгах боломжгүй.', required_action: 'Дурдсан бүх хавсралтыг оруулах эсвэл лавлагааг засах.',
      evidence: annexRefs.slice(0, MAX_EXAMPLES).map(r => ({ file: ctx.reportFile, anchor: r.anchors[0], source: `${ctx.reportFile} › ${r.anchors[0]}`, detail: `Хавсралт ${r.n}` })),
      source: 'Аргачлал II.1' }));
  }
  const status = partial.length || !inputs.annex ? 'PARTIAL' : 'ACCEPTED';
  return { gate: { status, inputs, source_doc_id: ctx.sourceDocId, version, notes }, issues, insufficient, partial, facts: { annex_refs: annexRefs, received_annex_files: received } };
}

/* ---------- Follow-up (RPT-175) — M10-01 тусгагдсан эсэх, M10-04 хугацаа хэтрэлт ---------- */
const lat = s => String(s || '').replace(/[АОСЕРВНКМТХ]/g, ch => 'AOCEPBHKMTX'['АОСЕРВНКМТХ'.indexOf(ch)]).toUpperCase();
// Тайланд дурдсан эсэх: олдвор ID (латин/кирилл), эсвэл гарчгийн утга бүхий үгсийн ≥ 75% нь НЭГ догол мөр / хүснэгтийн мөрөнд
// (урт тайланд нийтлэг үгс тархдаг тул бүх бичвэрээр биш, нэгж бүрээр тулгана)
function mentioned(it, units, allText, allLat) {
  if (it.iss_id && new RegExp(`(?<![A-Z0-9])${lat(it.iss_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(allLat)) return true;
  const stems = [...new Set((String(it.title || '').toLowerCase().match(/[\p{L}]{5,}/gu) || []).map(w => w.slice(0, Math.max(5, w.length - 3))))];   // залгаврыг тооцохгүй
  if (stems.length < 3) return false;
  return units.some(u => { const t = u.text.toLowerCase(); return stems.filter(s => t.includes(s)).length / stems.length >= 0.75; });
}
function checkFollowup(units, ctx) {
  const fu = ctx.followup;
  if (!fu || !Array.isArray(fu.items) || !fu.items.length) return { issues: [], facts: fu ? { followup_items: 0 } : {} };
  const allText = units.map(u => u.text).join('\n').toLowerCase(), allLat = lat(allText);
  // Олдвор тус бүрээр (нэг олдвор олон зөвлөмжтэй байж болно)
  const byFinding = new Map();
  for (const it of fu.items) { const k = (it.iss_id || '') + '|' + it.title; if (!byFinding.has(k)) byFinding.set(k, []); byFinding.get(k).push(it); }
  const findings = [...byFinding.values()].map(recs => ({ ...recs[0], recs, open: recs.some(r => ['S1', 'S2', 'S3', 'S4', 'S6'].includes(r.status)), overdue: Math.max(...recs.map(r => r.overdue_days || 0)) }));
  const ev = f => ({ file: fu.file, rows: `R${f.csv_row || ''}`.replace(/^R$/, ''), source: `${fu.source || 'RPT-175'} › мөр ${f.recs.map(r => r.row).join(',')}`, detail: `${f.iss_id || 'ID-гүй'} · ${f.rating_mn || ''} · ${f.status} · ${String(f.title).slice(0, 60)}` });
  const out = [];
  const openNot = findings.filter(f => f.open && !mentioned(f, units, allText, allLat));
  if (openNot.length) out.push(issue({ rule: 'M10-01', module: 'M10', severity: 'R2', confidence: 'Medium', category: 'FOLLOWUP',
    title: 'Нээлттэй өмнөх зөвлөмж тайланд тусгагдаагүй', issue: `Энэ нэгжийн RPT-175-д нээлттэй ${openNot.length} олдвор (${openNot.filter(f => f.rating === 'Critical').length} эгзэгтэй) тайланд дурдагдаагүй.`,
    why_it_matters: 'Захирал, Аудитын хороо өмнөх зөвлөмжийн хэрэгжилтийг энэ тайлангаас харахгүй.',
    required_action: 'Өмнөх аудитын хэрэгжээгүй зөвлөмжүүдийн төлөв, хугацааг тайланд тусгах (follow-up хэсэг).',
    impacts: [{ element: 'Дүгнэлт, гүйцэтгэх хураангуй', action: 'нээлттэй зөвлөмжийг тусгах' }],
    evidence: openNot.slice(0, MAX_EXAMPLES).map(ev), source: 'DOC-1912 §14.2; RPT-175', draft_source: true }));
  // Хугацаа хэтэрсэн: эгзэгтэй — ямар ч хэтрэлт, өндөр — 30 хоногоос дээш (KB-CONFLICT-06)
  const over = findings.filter(f => f.open && ((f.rating === 'Critical' && f.overdue > 0) || (f.rating === 'High' && f.overdue > 30)) && !mentioned(f, units, allText, allLat));
  if (over.length) out.push(issue({ rule: 'M10-04', module: 'M10', severity: 'R2', confidence: 'High', category: 'FOLLOWUP',
    title: 'Хугацаа хэтэрсэн зөвлөмж эскалацигүй', issue: `Хугацаа хэтэрсэн ${over.length} эгзэгтэй/өндөр зөвлөмж (хамгийн их ${Math.max(...over.map(f => f.overdue))} хоног) тайлан, эскалацид тусгагдаагүй.`,
    why_it_matters: 'Хугацаа хэтэрсэн өндөр эрсдэлтэй зөвлөмжийг Аудитын хороонд мэдээлэх шаардлагатай.',
    required_action: 'Хугацаа хэтэрсэн зөвлөмжийг тайланд тусгаж, эскалацийн шаардлагыг бичих.',
    evidence: over.slice(0, MAX_EXAMPLES).map(ev), source: 'DOC-1912 §12.2; DOC-1906 Хав. C', draft_source: true }));
  return { issues: out, facts: { followup_source: fu.source, followup_as_of: fu.as_of, followup_findings: findings.length, followup_open: findings.filter(f => f.open).length,
    followup_open_not_in_report: openNot.map(f => f.iss_id || f.title.slice(0, 40)), followup_overdue: findings.filter(f => f.overdue > 0).map(f => `${f.iss_id} +${f.overdue}`) } };
}

/* ---------- Зөвлөмжийн шаардлага (RPT175 нөлөөллийн матриц) — M08-08/M08-11-д LLM-д өгөх баримт ---------- */
// Санал гаргахгүй: каталог бүрэн биш тул «олдсонгүй» нь алдаа гэсэн үг биш. Зөвхөн баталгаажсан баримт (facts) бэлтгэнэ.
const { normDoc } = RQ;
function checkRecReq(units, ctx) {
  const rq = ctx.recreq;
  if (!rq || !Array.isArray(rq.catalog)) return { facts: {} };
  const norm = units.map(u => ({ u, t: normDoc(u.text) }));
  // Ижил нэртэй баримт олон газарт байдаг («Registers & Logs» 9 газарт) — нэрээр бүлэглэж, газар тодорхойгүйг ambiguous гэнэ
  const byName = new Map();
  for (const d of rq.catalog) {
    const n = normDoc(d.doc);
    if (n.length < 12) continue;   // хэт богино нэр санамсаргүй тааралдана
    const hit = norm.find(x => x.t.includes(n));
    if (!hit) continue;
    if (!byName.has(n)) byName.set(n, { doc: d.doc, anchor: hit.u.id, depts: [] });
    byName.get(n).depts.push(`${d.id || '—'} ${d.dept}`);
  }
  const named = [...byName.values()].map(x => ({ ...x, ambiguous: x.depts.length > 1, depts: x.depts.slice(0, 10) }));
  const ids = new Map();
  for (const h of scan(units, /\bDOC-\d{4}\b/g)) if (!ids.has(h.match)) ids.set(h.match, h.u.id);
  const byId = id => rq.catalog.filter(d => d.id === id);
  const docIds = [...ids.entries()].map(([id, anchor]) => {
    const m = byId(id);
    return { id, anchor, in_catalog: m.length > 0, ambiguous: m.length > 1, candidates: m.slice(0, 6).map(d => `${d.doc} (${d.dept})`) };
  }).filter(x => !/^DOC-19\d{2}$/.test(x.id));   // DOC-19xx — ДАГ-ын өөрийн журам
  const allText = units.map(u => u.text).join('\n').toLowerCase(), allLat = lat(allText);
  const items = RQ.forUnit(rq, ctx.audit || {});
  const prec = items.map(it => ({ fid: it.fid, title: it.title, in_report: mentioned({ iss_id: it.fid, title: it.title }, units, allText, allLat),
    one_off: it.one_off, targets: (it.targets.length ? it.targets : it.proposed_targets).map(t => `${t.id || '—'} ${t.doc} (${t.dept})`) }));
  return { facts: { recreq_source: `${rq.meta?.source || ''} · ${rq.meta?.generated || ''}`, recreq_catalog_docs: rq.catalog.length,
    recreq_docs_named_in_report: named, recreq_doc_ids_in_report: docIds, recreq_unit_precedents: prec } };
}

/* ---------- Нийт ---------- */
function runRules(ctx) {
  const units = unitsOf(ctx.doc || { blocks: [] });
  const g = gate0(ctx, units);
  if (g.gate.status === 'REJECTED') return { gate0: g.gate, issues: [], facts: {}, insufficient_inputs: g.insufficient, partial_modules: g.partial };
  const r = checkReport(units, ctx);
  const inj = checkInjection(ctx.extractedDir, ctx.reportFile, units);
  const fu = checkFollowup(units, ctx);
  const rq = checkRecReq(units, ctx);
  if (!ctx.recreq) g.insufficient.push('Зөвлөмжийн шаардлагын матриц (RPT175 нөлөөлөл) оруулаагүй — M08-11, M08-12 шалгаагүй, баримтын нэрийг каталогтой тулгаагүй');
  const issues = [...g.issues, ...(inj ? [inj] : []), ...r.issues, ...fu.issues];
  return {
    gate0: g.gate, issues, insufficient_inputs: g.insufficient, partial_modules: g.partial,
    facts: { ...g.facts, ...r.facts, ...fu.facts, ...rq.facts, prompt_injection_detected: !!inj, report_file: ctx.reportFile, source_doc_id: ctx.sourceDocId,
      checked_rules: CHECKED_RULES },
  };
}

// Rule Engine-ийн кодоор шалгадаг шалгуурууд (G0-01-ийг сервер эхлүүлэхэд шалгана)
const CHECKED_RULES = ['G0-01', 'G0-02', 'G0-03', 'G0-04', 'G0-05', 'G0-06', 'M01-02', 'M02-05', 'M03-05', 'M03-10', 'M04-01', 'M04-02', 'M06-01', 'M06-02', 'M07-02', 'M07-06', 'M09-03', 'M10-01', 'M10-04', 'M11-01', 'M11-02', 'M11-03', 'M11-06', 'M12-01', 'M12-02', 'M12-03', 'M12-04', 'M12-05'];

module.exports = { runRules, unitsOf, quoteAt, CHECKED_RULES };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || '');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'));
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  const files = job.files || [];
  const counts = {}; for (const f of files) counts[f.category] = (counts[f.category] || 0) + 1;
  const rep = files.find(f => f.category === 'report');
  const idx = fs.existsSync(path.join(dir, 'sources', 'index.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'sources', 'index.json'), 'utf8')) : [];
  const res = runRules({ doc, files, counts, sources: idx.sources || idx, reportFile: rep ? rep.name : doc.file, followupFile: (files.find(f => f.category === 'followup') || {}).name,
    sourceDocId: 'SUB-TEST', mask: job.mask !== false, extractedDir: path.join(dir, 'sandbox', 'extracted'), audit: job.audit, recreq: RQ.current() });
  console.log(JSON.stringify(res.gate0));
  for (const it of res.issues) console.log(`${it.severity}\t${it.rule}\t${it.anchor}\t${it.title}\t| ${it.issue}\t| q=${it.quote.slice(0, 60)}`);
  console.log('insufficient:', res.insufficient_inputs);
}
