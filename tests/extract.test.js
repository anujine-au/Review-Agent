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

test('зураг, Word-ийн диаграм, SmartArt, текст хайрцаг, жагсаалтын дугаар, sdt-ээр боосон мөрийг уншина', () => {
  const xml = b => Buffer.from(`<?xml version="1.0"?>${b}`);
  const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const drawing = inner => `<w:r><w:drawing><wp:inline xmlns:wp="x"><wp:docPr id="1" name="p" descr="Багцын бүтэц"/>${inner}</wp:inline></w:drawing></w:r>`;
  const body =
    `<w:p>${drawing('<a:graphic xmlns:a="a"><a:graphicData><a:blip r:embed="rIdImg"/></a:graphicData></a:graphic>')}</w:p>` +
    '<w:p><w:r><w:t>Зураг 2. Багцын бүтэц</w:t></w:r></w:p>' +
    `<w:p>${drawing('<c:chart xmlns:c="c" r:id="rIdCh"/>')}</w:p>` +
    `<w:p>${drawing('<dgm:relIds xmlns:dgm="d" r:dm="rIdDg"/>')}</w:p>` +
    `<w:p><w:r><w:t>Үндсэн</w:t></w:r><mc:AlternateContent xmlns:mc="m"><mc:Choice><w:r><w:drawing><wps:txbx xmlns:wps="s"><w:txbxContent><w:p><w:r><w:t>Хайрцаг</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r></mc:Choice>` +
    '<mc:Fallback><w:r><w:pict><v:textbox xmlns:v="v"><w:txbxContent><w:p><w:r><w:t>Хайрцаг</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></w:r></mc:Fallback></mc:AlternateContent></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Нэгдүгээр</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Дэд</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Хоёрдугаар</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>А</w:t></w:r></w:p></w:tc></w:tr><w:sdt><w:sdtContent><w:tr><w:tc><w:p><w:r><w:t>Б</w:t></w:r></w:p></w:tc></w:tr></w:sdtContent></w:sdt></w:tbl>';
  const r = convertDocx(zip([
    { name: 'word/document.xml', data: xml(`<w:document ${W} ${R}><w:body>${body}</w:body></w:document>`) },
    { name: 'word/_rels/document.xml.rels', data: xml('<Relationships><Relationship Id="rIdImg" Target="media/image1.png"/><Relationship Id="rIdCh" Target="charts/chart1.xml"/><Relationship Id="rIdDg" Target="diagrams/data1.xml"/></Relationships>') },
    { name: 'word/media/image1.png', data: Buffer.from('PNG') },
    { name: 'word/charts/chart1.xml', data: xml(`<c:chartSpace ${C}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>NPL</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser>` +
      '<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2026</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
      '<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Авто</c:v></c:pt><c:pt idx="1"><c:v>Хэрэглээ</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
      '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>4.2</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>') },
    { name: 'word/diagrams/data1.xml', data: xml('<dgm:dataModel xmlns:dgm="d" xmlns:a="a"><dgm:ptLst><dgm:pt modelId="1" type="doc"><dgm:t><a:p><a:r><a:t>Үйл явц</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="2"><dgm:t><a:p><a:r><a:t>Олголт</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="3" type="parTrans"/></dgm:ptLst></dgm:dataModel>') },
    { name: 'word/numbering.xml', data: xml(`<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`) }]));
  const L = r.lines.filter(l => !l.startsWith('=== ') && l);
  assert.deepEqual(L, [
    '[IMG1] Зураг (image1.png) → report_images/IMG1.png alt: Багцын бүтэц (гарчиг [P1]: Зураг 2. Багцын бүтэц)',
    '[P1] Зураг 2. Багцын бүтэц',
    '[CH1] Диаграм: NPL alt: Багцын бүтэц',
    'CH1S1 | 2026 | Авто: 4.2; Хэрэглээ: 7',
    '[DG1] SmartArt: Үйл явц / Олголт alt: Багцын бүтэц',
    '[P2] Үндсэн',
    '[TB1] Текст хайрцаг: Хайрцаг',
    '[P3][№ 1.] Нэгдүгээр',
    '[P4][№ a)] Дэд',
    '[P5][№ 2.] Хоёрдугаар',
    'T1R1 | А',
    'T1R2 | Б']);
  assert.deepEqual(r.images.map(i => i.file), ['IMG1.png']);
});

test('өнгөгүй тайланд COLOR-MARKED хэсэг нэмэгдэхгүй', () => {
  const r = convertDocx(docx('<w:p><w:r><w:rPr><w:color w:val="000000"/><w:highlight w:val="none"/></w:rPr><w:t>Хар</w:t></w:r></w:p>'));
  assert.equal(r.marks, 0);
  assert.ok(!r.lines.some(l => l.includes('COLOR-MARKED')));
});
