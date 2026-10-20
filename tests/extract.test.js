'use strict';
/*
  Word задлалт (server/extract.js) — өнгөөр тэмдэглэсэн хэсэг. Ажиллуулах:  node --test tests/extract.test.js
*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zip } = require('../server/export');
const { convertDocx } = require('../server/extract');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = body => zip([{ name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`) }]);

test('highlight, shading, үсгийн өнгө, track changes оруулгыг MARK мөрөөр гаргана', () => {
  const r = convertDocx(docx(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:color w:val="2F5496"/></w:rPr><w:t>Гарчиг</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Энгийн, </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>зассан 12 сая төг</w:t></w:r>' +
    '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>рөг</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>Улаан</w:t></w:r><w:ins w:id="1" w:author="a"><w:r><w:t> шинэ</w:t></w:r></w:ins>' +
    '<w:del w:id="2" w:author="a"><w:r><w:delText>хассан</w:delText></w:r></w:del></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>А</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:shd w:val="clear" w:fill="FFFF00"/></w:rPr><w:t>45</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'));
  const marks = r.lines.filter(l => l.startsWith('MARK '));
  assert.deepEqual(marks, [
    'MARK P2 {highlight:yellow} зассан 12 сая төгрөг',
    'MARK P3 {font:#FF0000} Улаан',
    'MARK P3 {tracked-insert} шинэ',
    'MARK T1R1 {shading:#FFFF00} 45',
  ]);
  assert.ok(r.lines.includes('[P2] Энгийн, зассан 12 сая төгрөг'));   // эх мөр өөрчлөгдөхгүй
});

test('цагаан highlight, загварын саарал / бараан өнгийг тооцохгүй; гарчгийн улаан өнгийг тооцно', () => {
  const r = convertDocx(docx(
    '<w:p><w:r><w:rPr><w:highlight w:val="white"/></w:rPr><w:t>Цагаан</w:t></w:r>' +
    '<w:r><w:rPr><w:color w:val="52514E"/></w:rPr><w:t> саарал</w:t></w:r><w:r><w:rPr><w:color w:val="1F3864"/></w:rPr><w:t> бараан</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>Улаан гарчиг</w:t></w:r></w:p>'));
  assert.deepStrictEqual(r.lines.filter(l => l.startsWith('MARK ')), ['MARK P2 {font:#FF0000} Улаан гарчиг']);
});

test('нүдийг бүхэлд нь будсаныг тооцно; толгой мөр, хөх / саарал загварын өнгийг тооцохгүй', () => {
  const tc = (fill, t) => `<w:tc>${fill ? `<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>` : ''}<w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const r = convertDocx(docx('<w:tbl>' +
    `<w:tr>${tc('FFC000', 'Толгой')}${tc('FFC000', 'Дүн')}</w:tr>` +
    `<w:tr>${tc('D9E2F3', 'Шошго')}${tc('FFF2CC', '1,855.0')}</w:tr>` +
    `<w:tr>${tc('F2F2F2', 'Саарал')}${tc('FFC000', 'Толгойн өнгө')}</w:tr>` +
    `<w:tr>${tc('', 'Энгийн')}${tc('92D050', 'Ногоон')}</w:tr></w:tbl>`));
  assert.deepEqual(r.lines.filter(l => l.startsWith('MARK ')), ['MARK T1R2 {cell:#FFF2CC} 1,855.0', 'MARK T1R4 {cell:#92D050} Ногоон']);
});

test('header / footer / зүүлт, хүснэгтийн гарчиг ба тайлбар, нэгтгэсэн нүдийг уншина', () => {
  const xml = b => Buffer.from(`<?xml version="1.0"?>${b}`);
  const body = '<w:p><w:r><w:t>Хүснэгт 3. Багц /сая төгрөгөөр/</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Бүлэг</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Дүн</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Авто</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t>Эх сурвалж: ЗМС</w:t></w:r></w:p>';
  const r = convertDocx(zip([
    { name: 'word/document.xml', data: xml(`<w:document ${W}><w:body>${body}</w:body></w:document>`) },
    { name: 'word/header1.xml', data: xml(`<w:hdr ${W}><w:p><w:r><w:t>ТУЗ-ийн 2026 оны тайлан</w:t></w:r></w:p></w:hdr>`) },
    { name: 'word/footer1.xml', data: xml(`<w:ftr ${W}><w:p/></w:ftr>`) },
    { name: 'word/footnotes.xml', data: xml(`<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>—</w:t></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Тушаал А/12</w:t></w:r></w:p></w:footnote></w:footnotes>`) }]));
  const L = r.lines;
  assert.deepEqual(L.slice(0, 4), ['=== HEADER / FOOTER / FOOTNOTES ===', 'HEADER | ТУЗ-ийн 2026 оны тайлан', 'FN1 | Тушаал А/12', '=== END HEADER / FOOTER ===']);
  assert.ok(L.includes('=== TABLE 1 === (гарчиг [P1]: Хүснэгт 3. Багц /сая төгрөгөөр/)'));
  assert.deepEqual(L.filter(l => /^T1R/.test(l)), ['T1R1 | Бүлэг | Дүн | ←', 'T1R2 | Авто | 1 | 2', 'T1R3 | ↑ | 3 | 4']);
  assert.ok(L.includes('=== END TABLE 1 === (тайлбар [P2]: Эх сурвалж: ЗМС)'));
  assert.deepEqual(r.blocks[1].rows[2], ['', '3', '4']);   // doc.json (ишлэл тулгалт) хэвээр
});

test('өнгөгүй тайланд COLOR-MARKED хэсэг нэмэгдэхгүй', () => {
  const r = convertDocx(docx('<w:p><w:r><w:rPr><w:color w:val="000000"/><w:highlight w:val="none"/></w:rPr><w:t>Хар</w:t></w:r></w:p>'));
  assert.equal(r.marks, 0);
  assert.ok(!r.lines.some(l => l.includes('COLOR-MARKED')));
});
