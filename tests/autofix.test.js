'use strict';
/*
  AI-ийн автомат засвар (server/autofix.js, edits.js-ийн Track Changes / comment). Ажиллуулах:  node --test tests/autofix.test.js
  Түр хавтсанд ажиллана — бодит jobs/-д хүрэхгүй. Claude-ийг ДУУДАХГҮЙ: suggest.suggest-ийг хуурамч хариугаар орлуулна.
*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-af-'));
const DIRS = { jobs: path.join(TMP, 'jobs'), logs: path.join(TMP, 'logs'), archive: path.join(TMP, 'archive') };
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
process.env.AR_JOBS_DIR = DIRS.jobs; process.env.AR_LOGS_DIR = DIRS.logs; process.env.AR_ARCHIVE_DIR = DIRS.archive;
const SUG = require(path.join(ROOT, 'server', 'suggest'));
const ED = require(path.join(ROOT, 'server', 'edits'));
const AF = require(path.join(ROOT, 'server', 'autofix'));
const { zip } = require(path.join(ROOT, 'server', 'export'));
const { convertDocx, readZip } = require(path.join(ROOT, 'server', 'extract'));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>` +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>1. Удиртгал</w:t></w:r></w:p>' +
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Аудитын хугацаа 2026.09.08 </w:t></w:r><w:r><w:t>байна.</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Зөвлөмжийг хэрэгжүүлэх хугацаа тодорхойгүй.</w:t></w:r></w:p>' +
  '</w:body></w:document>';
const DOCX = zip([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>') },
  { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
  { name: 'word/document.xml', data: Buffer.from(DOC) }]);

test('Track Changes: хуучныг w:del, шинийг w:ins болгож, хэлбэржүүлэлтийг хадгална; comment нэмнэ', () => {
  const edits = [{ seq: 1, status: 'applied', auto: true, old: '2026.09.08', new: '2026.09.08–2026.10.14', anchor: 'P2' }];
  const r = ED.build(DOCX, edits, { track: true, comments: [{ block: 'P3', text: 'Гараар засах — хугацаа\nХийх: огноо нэмэх' }] });
  assert.equal(r.results[1], 'ok');
  const z = readZip(r.buf), xml = z.text('word/document.xml');
  assert.match(xml, /<w:del w:id="\d+" w:author="[^"]+" w:date="[^"]+"><w:r><w:rPr><w:b\/><\/w:rPr><w:delText xml:space="preserve">2026\.09\.08<\/w:delText>/);
  assert.match(xml, /<w:ins w:id="\d+"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">2026\.09\.08–2026\.10\.14<\/w:t>/);
  // Засварын дараах текст (устгасныг тооцохгүй) ба дахин хяналтад «tracked-insert» тэмдэглэгээ
  const ex = convertDocx(r.buf);
  assert.equal(ex.blocks[1].text, 'Аудитын хугацаа 2026.09.08–2026.10.14 байна.');
  assert.ok(ex.lines.includes('MARK P2 {highlight:none,tracked-insert} 2026.09.08–2026.10.14') || ex.lines.some(l => /^MARK P2 \{[^}]*tracked-insert[^}]*\} 2026\.09\.08–2026\.10\.14$/.test(l)));
  // Comment: comments.xml, rels, content type, догол мөр дээрх тэмдэглэгээ
  assert.match(z.text('word/comments.xml'), /<w:comment w:id="(\d+)"[^>]*><w:p><w:r><w:t xml:space="preserve">Гараар засах — хугацаа<\/w:t><\/w:r><\/w:p><w:p><w:r><w:t xml:space="preserve">Хийх: огноо нэмэх/);
  assert.match(z.text('word/_rels/document.xml.rels'), /relationships\/comments" Target="comments.xml"/);
  assert.match(z.text('[Content_Types].xml'), /PartName="\/word\/comments.xml"/);
  assert.match(xml, /<w:p><w:commentRangeStart w:id="\d+"\/><w:r><w:t>Зөвлөмжийг[^<]*<\/w:t><\/w:r><w:commentRangeEnd w:id="\d+"\/><w:r><w:commentReference w:id="\d+"\/><\/w:r><\/w:p>/);
  // Энгийн (track-гүй) хувилбар — өмнөх шигээ
  assert.equal(convertDocx(ED.build(DOCX, edits).buf).blocks[1].text, 'Аудитын хугацаа 2026.09.08–2026.10.14 байна.');
  assert.doesNotMatch(readZip(ED.build(DOCX, edits).buf).text('word/document.xml'), /w:ins/);
});

test('ноорог горимын prompt: мэдээлэл дутууг [АУДИТОР БАТАЛГААЖУУЛАХ: …] гэж тэмдэглэнэ', () => {
  const tgt = { targets: [{ id: 'P3', cells: ['Зөвлөмжийг хэрэгжүүлэх хугацаа тодорхойгүй.'] }], context: [] };
  const item = { title: 'Хугацаа', issue: 'Хугацаа алга', required_action: 'Хугацаа, хариуцагч нэмэх', anchor: 'P3' };
  assert.match(SUG.buildPrompt(item, tgt, { draft: true }), /\[АУДИТОР БАТАЛГААЖУУЛАХ: хариуцагчийн нэр\]/);
  assert.doesNotMatch(SUG.buildPrompt(item, tgt), /АУДИТОР БАТАЛГААЖУУЛАХ/);
});

test('release-ийн дараах автомат засвар: засах, ноорог, засаж чадаагүйг comment болгох', async () => {
  const root = '20261020-000001-aftest', d = path.join(DIRS.jobs, root);
  fs.mkdirSync(path.join(d, 'originals', 'report'), { recursive: true });
  fs.mkdirSync(path.join(d, 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(d, 'originals', 'report', 'R.docx'), DOCX);
  fs.writeFileSync(path.join(d, 'originals', 'index.json'), JSON.stringify([{ cat: 'report', name: 'R.docx', size: DOCX.length, sha256: crypto.createHash('sha256').update(DOCX).digest('hex'), source: 'upload' }]));
  fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ id: root, audit: { code: 'T-1' } }));
  fs.writeFileSync(path.join(d, 'doc.json'), JSON.stringify(convertDocx(DOCX)));
  const items = [
    { id: 'RV-1', severity: 'R3', title: 'Хугацаа', issue: 'Хугацаа дутуу', required_action: 'Дуусах огноо нэмэх', anchor: 'P2', quote: '2026.09.08' },
    { id: 'RV-2', severity: 'R2', title: 'Зөвлөмжийн хугацаа', issue: 'Хугацаа алга', required_action: 'Хугацаа нэмэх', anchor: 'P3', quote: '' },
    { id: 'RV-3', severity: 'R2', title: 'Хавсралт', issue: 'Хавсралт ирээгүй', required_action: 'Хавсралт 8-ыг оруулах', anchor: 'P1', quote: '' },
    { id: 'RV-4', severity: 'R3', title: 'Ерөнхий', issue: 'Байршилгүй', required_action: 'Нэр томьёо нэгтгэх', anchor: null, quote: '' }];
  fs.writeFileSync(path.join(d, 'feedback', 'feedback_v1.json'), JSON.stringify({ version: 1, job: root, items }));
  // Claude-ийн оронд: RV-1 засна, RV-2 ноорог, RV-3 текстээр засагдахгүй
  const replies = {
    'RV-1': { fixable: true, old: '2026.09.08', new: '2026.09.08–2026.10.14', note: 'Дуусах огноог нэмэв', block: 'P2', numbers: [{ n: '2026.10.14', src: 'none' }] },
    'RV-2': { fixable: true, old: 'тодорхойгүй.', new: `[${ED.DRAFT_TAG}: огноо]-ны дотор хэрэгжүүлнэ.`, note: 'Хугацааг ноороглов', block: 'P3', numbers: [] },
    'RV-3': { fixable: false, reason: 'Хавсралт нэмэх шаардлагатай' } };
  const real = SUG.suggest;
  SUG.suggest = async (r, n, id) => ({ ok: true, suggestion: { ...replies[id], ai_run_id: 'AIR-T' } });
  let summary;
  try {
    const st = AF.start(root, 1, 'cae1', { onDone: s => { summary = s; } });
    assert.equal(st.total, 4);
    for (let i = 0; i < 100 && !summary; i++) await new Promise(r => setTimeout(r, 20));
  } finally { SUG.suggest = real; }
  assert.deepEqual({ fixed: summary.fixed, drafts: summary.drafts, manual: summary.manual, state: summary.state }, { fixed: 2, drafts: 2, manual: 2, state: 'done' });
  const af = AF.read(root, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(af.items).map(([k, v]) => [k, v.status])), { 'RV-1': 'applied', 'RV-2': 'applied', 'RV-3': 'not_fixable', 'RV-4': 'no_anchor' });
  const st = ED.state(root, 1);
  assert.equal(st.applied, 2); assert.equal(st.tracked, true);
  assert.deepEqual({ fixed: st.autofix.fixed, manual: st.autofix.manual, drafts: st.autofix.drafts }, { fixed: 2, manual: 2, drafts: 2 });
  assert.ok(st.edits.every(e => e.auto && e.by === 'AI (автомат)'));
  // Энгийн файл: засвар орсон; Track Changes файл: comment 4 (2 засвар + 2 гараар)
  const plain = convertDocx(fs.readFileSync(ED.working(root, 1).path));
  assert.equal(plain.blocks[2].text, `Зөвлөмжийг хэрэгжүүлэх хугацаа [${ED.DRAFT_TAG}: огноо]-ны дотор хэрэгжүүлнэ.`);
  const tw = ED.working(root, 1, true);
  assert.match(tw.name, /_AI-засвар\.docx$/);
  const cm = readZip(fs.readFileSync(tw.path)).text('word/comments.xml');
  assert.equal((cm.match(/<w:comment /g) || []).length, 4);
  assert.match(cm, /Гараар засах — RV-3 · Хавсралт/);
  assert.match(cm, /AI: Хавсралт нэмэх шаардлагатай/);
  assert.match(cm, /⚠ Шинэ тоо \(2026\.10\.14\)/);
  assert.match(cm, /⚠ Ноорог/);
  // Дахин эхлүүлэхгүй (дууссан)
  assert.ok(AF.start(root, 1, 'cae1').error);
});
