'use strict';
/*
  Тайлан дээр шууд засах (server/edits.js) — модуль ба API. Ажиллуулах:  node --test tests/
  Түр хавтсанд тусдаа port дээр сервер асаана — бодит jobs/, logs/-д хүрэхгүй. Claude-ийг дуудахгүй.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-ed-'));
const DIRS = { jobs: path.join(TMP, 'jobs'), logs: path.join(TMP, 'logs'), archive: path.join(TMP, 'archive'), home: path.join(TMP, 'home') };
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
process.env.AR_USERS_FILE = path.join(TMP, 'users.json'); process.env.AR_JOBS_DIR = DIRS.jobs; process.env.AR_LOGS_DIR = DIRS.logs; process.env.AR_ARCHIVE_DIR = DIRS.archive;
const U = require(path.join(ROOT, 'server', 'users'));
const ED = require(path.join(ROOT, 'server', 'edits'));
const { zip } = require(path.join(ROOT, 'server', 'export'));
const { convertDocx } = require(path.join(ROOT, 'server', 'extract'));
const PORT = 19000 + Math.floor(Math.random() * 900);
const PW = 'Testpass123';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- Fixture: run-уудад хуваагдсан текст, хүснэгттэй .docx ---------- */
const run = (t, b) => `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p>${run('Зээлийн тай', true)}${run('лан нэг')}${run(' &amp; хавсралт')}</w:p>
<w:p></w:p>
<w:p>${run('Хоёр дахь')}<w:r><w:tab/></w:r>${run('догол мөр')}</w:p>
<w:tbl><w:tr><w:tc><w:p>${run('Нүд A')}</w:p></w:tc><w:tc><w:p>${run('Давхар үг')}</w:p></w:tc></w:tr>
<w:tr><w:tc><w:p>${run('Нүд B')}</w:p></w:tc><w:tc><w:p>${run('Давхар үг')}</w:p></w:tc></w:tr></w:tbl>
<w:sectPr/></w:body></w:document>`;
const DOCX = zip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: 'word/document.xml', data: DOC_XML },
]);
const textOf = buf => convertDocx(buf).lines.join('\n');

let seq = 0;
const jobId = () => `20260102-0000${String(++seq).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex')}`;
const ITEMS = [
  { id: 'RV-1', severity: 'R2', anchor: 'P1', quote: 'тайлан нэг', title: 'Нэр томьёо', required_action: 'Засах', suggested_text: 'тайлан [PERSON-0001]' },
  { id: 'RV-2', severity: 'R3', anchor: 'P2', quote: 'Хоёр дахь догол', title: 'Найруулга', required_action: 'Засах' },   // feedback-д suggested байхгүй — review-ээс авна
  { id: 'RV-3', severity: 'R3', anchor: 'T1R2', quote: 'Давхар үг', title: 'Хүснэгт', required_action: 'Засах' },
  { id: 'RV-4', severity: 'R3', anchor: null, quote: 'Давхар үг', title: 'Олон газар', required_action: 'Засах' },
  { id: 'RV-5', severity: 'R3', anchor: 'P1', quote: 'тайланд байхгүй', title: 'Олдохгүй', required_action: 'Засах' },
];
function makeJob({ report = 'Тайлан.docx', buf = DOCX, state = 'RETURNED' } = {}) {
  const id = jobId(), d = path.join(DIRS.jobs, id), out = path.join(d, 'sandbox', 'output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'review_findings.json'), JSON.stringify({ schema_version: 3, issues: ITEMS.map(x => x.id === 'RV-2' ? { ...x, suggested_text: 'Хоёрдугаар догол' } : x) }));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ status: 'done' }));
  fs.writeFileSync(path.join(d, 'mask_map.json'), JSON.stringify({ '[PERSON-0001]': 'Бат-Эрдэнэ' }));
  if (/\.docx$/.test(report)) fs.writeFileSync(path.join(d, 'doc.json'), JSON.stringify({ file: report, blocks: convertDocx(buf).blocks }));
  fs.mkdirSync(path.join(d, 'originals', 'report'), { recursive: true });
  fs.writeFileSync(path.join(d, 'originals', 'report', report), buf);
  fs.writeFileSync(path.join(d, 'originals', 'index.json'), JSON.stringify([{ cat: 'report', name: report, size: buf.length, sha256: sha(buf), source: 'upload' }]));
  fs.mkdirSync(path.join(d, 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(d, 'feedback', 'feedback_v1.json'), JSON.stringify({ version: 1, job: id, released_at: new Date().toISOString(),
    items: ITEMS.map(({ suggested_text, ...x }) => x.id === 'RV-1' ? { ...x, suggested_text } : x) }));
  fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ id, created: new Date().toISOString(), created_by: 'aud1', team: ['lead1'], audit: { code: 'T-1', branch: 'Эрдэнэт' }, mask: true,
    workflow: { state, version: 1, history: [] } }));
  return id;
}

/* ---------- HTTP ---------- */
async function call(tok, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: r.status, json, buf };
}
const tokens = {};
let server, J, PDFJ, SUB;
before(async () => {
  for (const [u, role] of [['cae1', 'cae'], ['aud1', 'auditor'], ['lead1', 'lead_auditor'], ['aud2', 'auditor']]) U.addUser({ username: u, role, password: PW });
  J = makeJob(); PDFJ = makeJob({ report: 'Тайлан.pdf', buf: Buffer.from('%PDF-1.4 test') }); SUB = makeJob({ state: 'RESUBMITTED' });
  const nodeDir = path.dirname(process.execPath), sys = process.env.SystemRoot || 'C:\\Windows';
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, HEFESTO_BOT_TOKEN: '', HEFESTO_API: '', USERPROFILE: DIRS.home, PATH: [nodeDir, path.join(sys, 'System32')].join(';') }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/auth-mode`)).ok) break; } catch { /* асаж байна */ } await new Promise(r => setTimeout(r, 100)); }
  for (const u of ['cae1', 'aud1', 'lead1', 'aud2']) {
    const r = await call(null, 'POST', '/api/login', { username: u, password: PW });
    assert.equal(r.status, 200, `login ${u}`); tokens[u] = r.json.token;
  }
});
after(() => { try { server.kill(); } catch { /* ignore */ } });

/* ---------- Модуль ---------- */
test('scan: дугаарлалт extract.js-тэй ижил (хоосон догол мөр алгасна, хүснэгт T1R1…)', () => {
  const ids = ED.scan(DOC_XML).map(p => p.id);
  assert.deepEqual(ids, ['P1', 'P2', 'T1R1', 'T1R1', 'T1R2', 'T1R2']);
  assert.equal(ED.scan(DOC_XML)[0].text, 'Зээлийн тайлан нэг & хавсралт');
});

test('build: run хооронд хуваагдсан текстийг солино, бусад хэвээр; буцаавал эх текст', () => {
  const e = { seq: 1, status: 'applied', old: 'тайлан нэг', new: 'тайлан <шинэ>', anchor: 'P1' };
  const r = ED.build(DOCX, [e]);
  assert.equal(r.results[1], 'ok');
  assert.match(textOf(r.buf), /\[P1\] Зээлийн тайлан <шинэ> & хавсралт/);
  assert.match(r.xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Зээлийн тайлан &lt;шинэ&gt;<\/w:t>/);   // эхний run-ийн хэлбэржүүлэлт
  assert.equal(textOf(ED.build(DOCX, [{ ...e, status: 'reverted' }]).buf), textOf(DOCX));
});

test('build: anchor-аар давхардлыг ялгана, anchor-гүй давхардал / олдохгүй бол алдаа', () => {
  const r = ED.build(DOCX, [{ seq: 1, status: 'applied', old: 'Давхар үг', new: 'Ганц үг', anchor: 'T1R2' },
    { seq: 2, status: 'applied', old: 'Нүд A Давхар', new: 'x', anchor: null },
    { seq: 3, status: 'applied', old: 'хоёр  ДАХЬ   догол', new: 'Хоёрдугаар догол', anchor: 'P2' }]);
  assert.equal(r.results[1], 'ok');
  assert.equal(r.results[2], 'not_found');   // хоёр нүдийг дамнасан
  assert.equal(r.results[3], 'ok');          // зай, том жижиг үсэг хамаарахгүй
  assert.match(textOf(r.buf), /T1R1 \| Нүд A \| Давхар үг\nT1R2 \| Нүд B \| Ганц үг/);
  assert.match(textOf(r.buf), /\[P2\] Хоёрдугаар догол мөр/);
  const amb = ED.build(DOCX, [{ seq: 1, status: 'applied', old: 'Давхар үг', new: 'y', anchor: null }]);
  assert.equal(amb.results[1], 'ambiguous');
});

/* ---------- API ---------- */
const base = id => `/api/jobs/${id}/feedback/1/edits`;

test('GET: санал болгох найруулга (token сэргээсэн, хуучин feedback-д review-ээс)', async () => {
  const r = await call(tokens.aud1, 'GET', base(J));
  assert.equal(r.status, 200, String(r.buf));
  assert.equal(r.json.available, true);
  const by = Object.fromEntries(r.json.items.map(x => [x.id, x]));
  assert.equal(by['RV-1'].suggested, 'тайлан Бат-Эрдэнэ');
  assert.equal(by['RV-2'].suggested, 'Хоёрдугаар догол');
  assert.equal(r.json.applied, 0);
});

test('Урьдчилан харах → зөвшөөрөх → «Зассан» автоматаар; эх файл өөрчлөгдөхгүй', async () => {
  const orig = fs.readFileSync(path.join(DIRS.jobs, J, 'originals', 'report', 'Тайлан.docx'));
  // anchor-гүй, 2 газар давтагдсан ишлэл → 409 (RV-3 засагдсаны дараа давтагдахаа болино)
  assert.equal((await call(tokens.lead1, 'POST', `${base(J)}/preview`, { rv_id: 'RV-4', text: 'x' })).status, 409);
  const pv = await call(tokens.lead1, 'POST', `${base(J)}/preview`, { rv_id: 'RV-1', text: 'тайлан Бат-Эрдэнэ' });
  assert.equal(pv.status, 200, String(pv.buf));
  assert.deepEqual([pv.json.block, pv.json.after], ['P1', 'Зээлийн тайлан Бат-Эрдэнэ & хавсралт']);
  assert.equal((await call(tokens.lead1, 'GET', base(J))).json.applied, 0, 'preview хадгалахгүй');

  const ap = await call(tokens.lead1, 'POST', base(J), { rv_id: 'RV-1', text: 'тайлан Бат-Эрдэнэ' });
  assert.equal(ap.status, 200, String(ap.buf));
  assert.equal(ap.json.state.applied, 1);
  assert.equal(ap.json.progress['RV-1'].via, 'edit');
  const ap2 = await call(tokens.aud1, 'POST', base(J), { rv_id: 'RV-3', text: 'Ганц үг' });
  assert.equal(ap2.status, 200, String(ap2.buf));

  const dl = await call(tokens.aud1, 'GET', `${base(J)}/docx`);
  assert.equal(dl.status, 200);
  const t = textOf(dl.buf);
  assert.match(t, /Зээлийн тайлан Бат-Эрдэнэ & хавсралт/);
  assert.match(t, /T1R2 \| Нүд B \| Ганц үг/);
  assert.ok(orig.equals(fs.readFileSync(path.join(DIRS.jobs, J, 'originals', 'report', 'Тайлан.docx'))), 'эх файл өөрчлөгдсөн');
  // захирал харна
  assert.equal((await call(tokens.cae1, 'GET', base(J))).json.applied, 2);
});

test('Олдохгүй / давхардсан ишлэл, ижил текст → 409/400, юу ч хадгалахгүй', async () => {
  assert.equal((await call(tokens.aud1, 'POST', base(J), { rv_id: 'RV-5', text: 'x' })).status, 409);
  assert.equal((await call(tokens.aud1, 'POST', base(J), { rv_id: 'RV-2', text: 'Хоёр дахь догол' })).status, 400);
  assert.equal((await call(tokens.aud1, 'POST', base(J), { rv_id: 'RV-404', text: 'x' })).status, 404);
  assert.equal((await call(tokens.aud1, 'GET', base(J))).json.applied, 2);
});

test('Буцаах: нэгийг буцаахад бусад хэвээр, «Зассан» хасагдана; бүгдийг буцаахад эх текст', async () => {
  const st = (await call(tokens.aud1, 'GET', base(J))).json;
  const e1 = st.edits.find(e => e.rv_id === 'RV-1');
  const r = await call(tokens.aud1, 'POST', `${base(J)}/${e1.seq}/revert`, {});
  assert.equal(r.status, 200, String(r.buf));
  assert.equal(r.json.state.applied, 1);
  assert.equal(r.json.progress['RV-1'], undefined);
  let t = textOf((await call(tokens.aud1, 'GET', `${base(J)}/docx`)).buf);
  assert.match(t, /Зээлийн тайлан нэг & хавсралт/);
  assert.match(t, /Ганц үг/);
  // дахин буцаах → 404
  assert.equal((await call(tokens.aud1, 'POST', `${base(J)}/${e1.seq}/revert`, {})).status, 404);
  const all = await call(tokens.lead1, 'POST', `${base(J)}/all/revert`, {});
  assert.equal(all.status, 200);
  assert.equal(all.json.state.applied, 0);
  assert.equal((await call(tokens.aud1, 'GET', `${base(J)}/docx`)).status, 404);
  // түүх хадгалагдана
  assert.equal(all.json.state.edits.filter(e => e.status === 'reverted').length, 2);
});

test('Эрх: багийн бус аудитор харахгүй, захирал засахгүй, засвар илгээсний дараа засахгүй, PDF тайлан боломжгүй', async () => {
  assert.equal((await call(tokens.aud2, 'GET', base(J))).status, 404);
  assert.equal((await call(tokens.cae1, 'POST', base(J), { rv_id: 'RV-1', text: 'x' })).status, 403);
  assert.equal((await call(tokens.aud1, 'POST', base(SUB), { rv_id: 'RV-1', text: 'x' })).status, 409);
  const p = await call(tokens.aud1, 'GET', base(PDFJ));
  assert.equal(p.json.available, false);
  assert.match(p.json.reason, /\.docx биш/);
  assert.equal((await call(tokens.aud1, 'POST', base(PDFJ), { rv_id: 'RV-1', text: 'x' })).status, 409);
});

test('Засварласан хувилбарт вэб засварыг тайлан болгон оруулах (files-edits)', async () => {
  assert.equal((await call(tokens.aud1, 'POST', base(J), { rv_id: 'RV-1', text: 'тайлан шинэ' })).status, 200);
  const c = await call(tokens.aud1, 'POST', '/api/jobs', { parent_id: J });
  assert.ok([200, 201].includes(c.status), String(c.buf));
  const kid = c.json.id;
  const r = await call(tokens.aud1, 'POST', `/api/jobs/${kid}/files-edits`, {});
  assert.equal(r.status, 201, String(r.buf));
  const f = path.join(DIRS.jobs, kid, 'input', 'report', 'Тайлан.docx');
  assert.match(textOf(fs.readFileSync(f)), /Зээлийн тайлан шинэ/);
  // анхны (root) job дээр — илгээгдсэн тул 409
  assert.equal((await call(tokens.aud1, 'POST', `/api/jobs/${J}/files-edits`, {})).status, 409);
});

/* ---------- AI найруулга (server/suggest.js) — Claude-гүйгээр ---------- */
test('suggest: тооны эх сурвалж, хариу задлах, засах нэгж', () => {
  const SUG = require(path.join(ROOT, 'server', 'suggest'));
  const doc = { blocks: [{ id: 'P1', kind: 'p', text: 'Нийт 31 зөвлөмж, 2026.08.31' }, { id: 'T1', kind: 'table', rows: [['A', 'Нийт 31'], ['B', 'x']] }] };
  assert.deepEqual(SUG.numberSources('Нийт 18 зөвлөмж, 31 биш, [PERSON-0001], 99', 'Нийт 31', doc, { issue: 'их биед 18 байна' }),
    [{ n: '18', src: 'comment' }, { n: '99', src: 'none' }]);
  assert.deepEqual(SUG.parseReply('```json\n{"fixable": false, "reason": "x"}\n```'), { fixable: false, reason: 'x' });
  assert.equal(SUG.parseReply('no json'), null);
  const t = SUG.targetOf(doc, 'T1R2');
  assert.deepEqual(t.targets.map(u => u.id), ['T1R2']);
  assert.deepEqual(SUG.targetOf(doc, 'T1').targets.map(u => u.id), ['T1R1', 'T1R2']);
  assert.equal(SUG.targetOf(doc, null), null);
  assert.match(SUG.buildPrompt({ title: 't', issue: 'i', required_action: 'a', quote: '', anchor: 'P1' }, SUG.targetOf(doc, 'P1')), /<<P1>> Нийт 31 зөвлөмж/);
});

test('AI сонгосон хэсгээр (ишлэлээс өргөн) солих; AI олдохгүй бол ойлгомжтой алдаа', async () => {
  const K = makeJob();
  // ишлэл «тайлан нэг» — AI бүтэн догол мөрийг сонгосон гэж үзье
  const pv = await call(tokens.aud1, 'POST', `${base(K)}/preview`, { rv_id: 'RV-1', old: 'Зээлийн тайлан нэг & хавсралт', text: 'Зээлийн тайлан, хавсралт' });
  assert.equal(pv.status, 200, String(pv.buf));
  assert.equal(pv.json.after, 'Зээлийн тайлан, хавсралт');
  const ap = await call(tokens.aud1, 'POST', base(K), { rv_id: 'RV-1', old: 'Зээлийн тайлан нэг & хавсралт', text: 'Зээлийн тайлан, хавсралт' });
  assert.equal(ap.status, 200, String(ap.buf));
  assert.equal(ap.json.edit.old, 'Зээлийн тайлан нэг & хавсралт');
  assert.match(textOf((await call(tokens.aud1, 'GET', `${base(K)}/docx`)).buf), /\[P1\] Зээлийн тайлан, хавсралт/);
  // тестийн орчинд Claude байхгүй → 502, юу ч хадгалахгүй
  const sg = await call(tokens.aud1, 'POST', `${base(K)}/suggest`, { rv_id: 'RV-2' });
  assert.equal(sg.status, 502);
  assert.deepEqual((await call(tokens.aud1, 'GET', base(K))).json.ai, {});
  // багийн бус → 404, захирал → 403
  assert.equal((await call(tokens.aud2, 'POST', `${base(K)}/suggest`, { rv_id: 'RV-2' })).status, 404);
  assert.equal((await call(tokens.cae1, 'POST', `${base(K)}/suggest`, { rv_id: 'RV-2' })).status, 403);
});
