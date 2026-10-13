'use strict';
/*
  Тайлангийн эхний хэсгээс аудитын мэдээллийг таних (зөвхөн энэ компьютер дээр, Claude-д юу ч илгээхгүй).

  Таних зүйлс:
  - name        — «…САЛБАРЫН … АУДИТ» гарчиг (компанийн нэрийн угтварыг хасна)
  - code        — «Аудитын дугаар: C202603»
  - branch      — гарчгаас «<нэр> САЛБАР» (вэб тал жагсаалтаас тохирохыг сонгоно)
  - period      — «Аудит хамарсан хугацаа: 2024.04.10-2026.08.31»
  - report_date — «Аудитыг гүйцэтгэсэн хугацаа», «Тайлангийн огноо» гэх мэт
*/

const { convertDocx, convertPdf } = require('./extract');

const HEAD_BLOCKS = 60;   // тайлангийн эхний хэсэг (нүүр, гарчиг) л хангалттай
const LABELS = {
  code: /аудит(ын)?\s*(дугаар|код)|тайлангийн\s*дугаар/i,
  period: /(хамарсан|хамрах|шалгасан|хамруулсан)\s*(хугацаа|үе)|аудитын\s*хугацаа|тайлант\s*хугацаа/i,
  report_date: /(гүйцэтгэсэн|ажилласан|хийсэн)\s*хугацаа|тайлан(гийн)?\s*(огноо|гаргасан)|аудитын\s*огноо/i,
};
const DATE_RE = /(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})|(\d{4})\s*оны\s*(\d{1,2})\s*(?:-?р\s*)?сарын\s*(\d{1,2})/g;

const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/[“"]\s+/g, '“').replace(/\s+[”"]/g, '”').trim();

function normDates(raw) {
  const s = clean(raw), ds = [];
  let after = '';
  for (const m of s.matchAll(DATE_RE)) {
    const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) { ds.push(`${y}.${mo.padStart(2, '0')}.${d.padStart(2, '0')}`); if (ds.length === 1) after = s.slice(m.index + m[0].length); }
  }
  if (ds.length >= 2) return `${ds[0]} – ${ds[1]}`;
  // «2026.09.08-2026.09.» — дуусах огноо бүрэн биш бол эхлэхийг нь л авна
  if (ds.length === 1) return /^\s*[-–—]\s*\d/.test(after) ? `${ds[0]} –` : ds[0];
  return '';
}

/* Блокуудыг «шошго → утга» мөр болгон задлах */
function labelPairs(blocks) {
  const pairs = [];
  for (const b of blocks) {
    if (b.kind === 'table') {
      for (const row of b.rows || []) {
        row.forEach((cell, i) => {
          const c = clean(cell);
          if (!c) return;
          const m = c.match(/^(.{3,60}?)\s*:\s*(.*)$/);
          const next = row.slice(i + 1).map(clean).find(Boolean) || '';
          if (m) pairs.push([m[1], m[2] || next]);
          else if (next && c.length <= 60) pairs.push([c, next]);
        });
      }
    } else {
      const m = clean(b.text).match(/^(.{3,60}?)\s*:\s*(.+)$/);
      if (m) pairs.push([m[1], m[2]]);
    }
  }
  return pairs;
}

function detect(blocks) {
  const head = blocks.slice(0, HEAD_BLOCKS), out = {};
  const texts = head.flatMap(b => b.kind === 'table' ? (b.rows || []).flat() : [b.text]).map(clean).filter(Boolean);

  const title = texts.find(t => t.length >= 10 && t.length <= 300 && /АУДИТ/i.test(t) && !/^\d|агуулга|хураангуй|тайланг\s+тайлагнах/i.test(t) && !/:\s*\S/.test(t));
  if (title) {
    // «“Нэткапитал …” ХХК / “ЭРДЭНЭТ” САЛБАРЫН …» → угтварыг хасна
    const parts = title.split(/\s+\/\s+/);
    out.name = clean(parts.length > 1 && /ХХК|ББСБ|компани/i.test(parts[0]) ? parts.slice(1).join(' / ') : title);
  }
  const branchSrc = out.name || texts.slice(0, 10).join(' ');
  const bm = branchSrc.match(/[“"]?\s*([А-ЯӨҮЁA-Za-zа-яөүё\- ]{2,40}?)\s*[”"]?\s+САЛБАР/i);
  if (bm) out.branch = clean(bm[1]);

  for (const [label, value] of labelPairs(head)) {
    if (!value || /^[/….\s]*$/.test(value)) continue;
    if (!out.code && LABELS.code.test(label)) { const v = clean(value).split(/\s{2,}|\t/)[0]; if (v.length <= 40) out.code = v; }
    else if (!out.period && LABELS.period.test(label)) { const v = normDates(value); if (v) out.period = v; }
    else if (!out.report_date && LABELS.report_date.test(label)) { const v = normDates(value); if (v) out.report_date = v; }
  }
  return out;
}

function detectFile(file, ext, buf) {
  const doc = ext === '.docx' ? convertDocx(buf) : ext === '.pdf' ? convertPdf(file) : null;
  if (!doc) return {};
  return detect(doc.blocks);
}

module.exports = { detect, detectFile, normDates };
