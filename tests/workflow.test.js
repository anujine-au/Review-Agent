'use strict';
/*
  Ажлын урсгалын хүлээн авах шалгуур (prompt §9). Ажиллуулах:  node --test tests/
  - Түр хавтсанд (jobs, logs, archive, users) тусдаа port дээр сервер асаана — бодит jobs/, logs/-д хүрэхгүй.
  - Claude-ийг ДУУДАХГҮЙ: PATH, USERPROFILE-ийг claude.exe олдохгүй болгож тохируулна (засварын AI шалгалт «failed» болно).
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-wf-'));
const DIRS = { jobs: path.join(TMP, 'jobs'), logs: path.join(TMP, 'logs'), archive: path.join(TMP, 'archive'), home: path.join(TMP, 'home') };
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
const USERS = path.join(TMP, 'users.json');
process.env.AR_USERS_FILE = USERS; process.env.AR_JOBS_DIR = DIRS.jobs; process.env.AR_LOGS_DIR = DIRS.logs; process.env.AR_ARCHIVE_DIR = DIRS.archive;
const U = require(path.join(ROOT, 'server', 'users'));
const PORT = 18000 + Math.floor(Math.random() * 900);
const PW = 'Testpass123';
let server;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- Fixture ---------- */
let seq = 0;
function jobId() { seq++; return `20260101-0000${String(seq).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex')}`; }
const DOCX1 = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('report v1 bytes')]);
function makeJob({ created_by = 'aud1', team = [], issues = 10, r1 = 0, workflow = { state: 'CAE_REVIEW', version: 1, history: [] }, verdict, parent_id, round } = {}) {
  const id = jobId(), d = path.join(DIRS.jobs, id), out = path.join(d, 'sandbox', 'output');
  fs.mkdirSync(out, { recursive: true });
  const list = Array.from({ length: issues }, (_, i) => ({ id: `RV-T-C1-${String(i + 1).padStart(3, '0')}`, severity: i < r1 ? 'R1' : 'R2', module: 'M08', rule: 'M08-01', confidence: 'High',
    anchor: 'P1', quote: 'Зээлийн', title: `Санал ${i + 1}`, issue: 'Тайлбар', required_action: `Засах ${i + 1}` }));
  const v = verdict || (r1 ? 'NOT_READY' : 'READY_WITH_FIXES');
  fs.writeFileSync(path.join(out, 'review_findings.json'), JSON.stringify({ schema_version: 3, audit: { code: 'T-1' }, review: { verdict: v, r1_count: r1, r2_count: issues - r1, r3_count: 0, r4_count: 0 }, issues: list }));
  fs.writeFileSync(path.join(out, 'review_summary.json'), JSON.stringify({ audit: {}, review: { verdict: v, r1_count: r1, r2_count: issues - r1, r3_count: 0, r4_count: 0 } }));
  fs.writeFileSync(path.join(out, 'review_report.md'), '# Review\n');
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ status: 'done', finished: new Date().toISOString() }));
  fs.writeFileSync(path.join(d, 'doc.json'), JSON.stringify({ file: 'T_v1.docx', blocks: [{ id: 'P1', kind: 'p', text: 'Зээлийн тайлан нэг' }, { id: 'P2', kind: 'p', text: 'Хоёр дахь догол мөр' }] }));
  fs.writeFileSync(path.join(d, 'mask_map.json'), '{}');
  fs.mkdirSync(path.join(d, 'originals', 'report'), { recursive: true }); fs.mkdirSync(path.join(d, 'originals', 'program'), { recursive: true });
  fs.writeFileSync(path.join(d, 'originals', 'report', 'T_v1.docx'), DOCX1);
  fs.writeFileSync(path.join(d, 'originals', 'program', 'P.docx'), DOCX1);
  fs.writeFileSync(path.join(d, 'originals', 'index.json'), JSON.stringify([{ cat: 'report', name: 'T_v1.docx', size: DOCX1.length, sha256: sha(DOCX1), source: 'upload' },
    { cat: 'program', name: 'P.docx', size: DOCX1.length, sha256: sha(DOCX1), source: 'upload' }]));
  fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ id, created: new Date().toISOString(), created_by, team, audit: { name: 'Тест аудит', code: 'T-1', branch: 'Эрдэнэт' }, mask: true,
    files: [{ category: 'report', name: 'T_v1.docx' }], ...(workflow ? { workflow } : {}), ...(parent_id ? { parent_id, round } : {}) }));
  return id;
}

/* ---------- HTTP ---------- */
async function call(tok, method, p, body, raw) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: r.status, json, buf, type: r.headers.get('content-type') };
}
const tokens = {};
async function login(u) { const r = await call(null, 'POST', '/api/login', { username: u, password: PW }); assert.equal(r.status, 200, `login ${u}: ${r.buf}`); return (tokens[u] = r.json.token); }

let A, C, D, E;
before(async () => {
  for (const [u, role] of [['adm', 'admin'], ['cae1', 'cae'], ['cae2', 'cae'], ['aud1', 'auditor'], ['lead1', 'lead_auditor']]) U.addUser({ username: u, role, password: PW });
  A = makeJob({ team: ['lead1', 'cae2'] });                       // 10 санал, CAE_REVIEW
  C = makeJob({ r1: 1 });                                          // R1 = 1 → finalize 409
  D = makeJob({ issues: 2, verdict: 'READY' });                   // R1 = 0 → finalize OK
  E = makeJob({ workflow: null });                                  // хуучин job (workflow талбаргүй)
  const nodeDir = path.dirname(process.execPath), sys = process.env.SystemRoot || 'C:\\Windows';
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, USERPROFILE: DIRS.home, PATH: [nodeDir, path.join(sys, 'System32'), path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(';') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let outLog = ''; server.stdout.on('data', d => { outLog += d; }); server.stderr.on('data', d => { outLog += d; });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/auth-mode`); if (r.ok) break; } catch { /* асаж байна */ } await new Promise(r => setTimeout(r, 100)); }
  for (const u of ['adm', 'cae1', 'cae2', 'aud1', 'lead1']) await login(u);
});
after(() => { try { server.kill(); } catch { /* ignore */ } });

/* ---------- §9 шалгуурууд ---------- */
test('1. Аудитор илгээсний дараа санал, verdict, R-тоо авахгүй', async () => {
  const j = await call(tokens.aud1, 'GET', `/api/jobs/${A}`);
  assert.equal(j.status, 200);
  for (const k of ['verdict', 'r1', 'r2', 'decisions', 'events', 'outputs']) assert.equal(j.json[k], undefined, `${k} ил гарсан`);
  assert.equal(j.json.restricted, true);
  for (const p of ['/output/review_findings.json', '/output/review_report.md', '/export/pdf', '/export/task', '/document', '/sources', '/previous'])
    assert.equal((await call(tokens.aud1, 'GET', `/api/jobs/${A}${p}`)).status, 403, p);
  const list = await call(tokens.aud1, 'GET', '/api/jobs');
  const row = list.json.jobs.find(x => x.id === A);
  assert.ok(row && row.verdict === undefined && row.r1 === undefined);
  // ахлах аудитор (багийн гишүүн) ч ижил
  assert.equal((await call(tokens.lead1, 'GET', `/api/jobs/${A}/output/review_findings.json`)).status, 403);
});

test('3a. Release-ээс өмнө аудиторт мэдэгдэл ирэхгүй', async () => {
  const n = await call(tokens.aud1, 'GET', '/api/notifications');
  assert.equal(n.json.items.filter(x => x.kind === 'RETURNED').length, 0);
});

test('8. Багийн гишүүн (захирлын эрхтэй ч) өөрийн тайланг шийдвэрлэх, release хийх → 409', async () => {
  assert.equal((await call(tokens.cae2, 'POST', `/api/jobs/${A}/decisions`, { items: [{ id: 'RV-T-C1-001', decision: 'APPROVED' }] })).status, 409);
  assert.equal((await call(tokens.cae2, 'POST', `/api/jobs/${A}/release`, {})).status, 409);
});

test('7. Аудитор / ахлах аудитор release, finalize, эцсийн тайлан → 403', async () => {
  for (const u of ['aud1', 'lead1']) {
    assert.equal((await call(tokens[u], 'POST', `/api/jobs/${A}/release`, {})).status, 403, `${u} release`);
    assert.equal((await call(tokens[u], 'POST', `/api/jobs/${A}/finalize`, {})).status, 403, `${u} finalize`);
    assert.equal((await call(tokens[u], 'GET', `/api/jobs/${A}/final/docx`)).status, 403, `${u} final`);
  }
});

test('2. 7 APPROVED + 3 REJECTED → аудитор яг 7-г харна; 3b. release-ийн дараа мэдэгдэл; 4. дараагийн өөрчлөлт feedback-д нөлөөлөхгүй', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `RV-T-C1-${String(i + 1).padStart(3, '0')}`, decision: i < 7 ? 'APPROVED' : 'REJECTED' }));
  assert.equal((await call(tokens.cae1, 'POST', `/api/jobs/${A}/decisions`, { items })).status, 200);
  const pre = await call(tokens.cae1, 'GET', `/api/jobs/${A}/release`);
  assert.deepEqual([pre.json.sent, pre.json.excluded, pre.json.undecided], [7, 3, 0]);
  const rel = await call(tokens.cae1, 'POST', `/api/jobs/${A}/release`, {});
  assert.equal(rel.status, 200, String(rel.buf));
  const fb = await call(tokens.aud1, 'GET', `/api/jobs/${A}/feedback/1`);
  assert.equal(fb.status, 200);
  assert.equal(fb.json.items.length, 7);
  for (const id of ['RV-T-C1-008', 'RV-T-C1-009', 'RV-T-C1-010']) assert.ok(!fb.json.items.some(x => x.id === id), `татгалзсан ${id} харагдсан`);
  // 3b
  const n = await call(tokens.aud1, 'GET', '/api/notifications');
  assert.ok(n.json.items.some(x => x.kind === 'RETURNED') && n.json.unread >= 1);
  // 4 — захирал шийдвэрээ өөрчилсөн ч v1 feedback хэвээр
  await call(tokens.cae1, 'PATCH', `/api/jobs/${A}/decisions/RV-T-C1-001`, { decision: 'REJECTED' });
  const fb2 = await call(tokens.aud1, 'GET', `/api/jobs/${A}/feedback/1`);
  assert.equal(fb2.json.items.length, 7);
  assert.ok(fb2.json.items.some(x => x.id === 'RV-T-C1-001'));
  // давхар release → 409
  assert.equal((await call(tokens.cae1, 'POST', `/api/jobs/${A}/release`, {})).status, 409);
});

test('2b. Аудитор засварыг «Зассан» гэж тэмдэглэнэ; захирал харна, өөрчлөхгүй; feedback царцсан хэвээр', async () => {
  const base = `/api/jobs/${A}/feedback/1/progress`;
  const before = fs.readFileSync(path.join(DIRS.jobs, A, 'feedback', 'feedback_v1.json'), 'utf8');
  let r = await call(tokens.lead1, 'PATCH', `${base}/RV-T-C1-001`, { done: true });
  assert.equal(r.status, 200, String(r.buf));
  r = await call(tokens.aud1, 'PATCH', `${base}/RV-T-C1-002`, { done: true });
  assert.equal(r.status, 200, String(r.buf));
  assert.deepEqual(Object.keys(r.json.progress).sort(), ['RV-T-C1-001', 'RV-T-C1-002']);
  r = await call(tokens.aud1, 'PATCH', `${base}/RV-T-C1-002`, { done: false });
  assert.deepEqual(Object.keys(r.json.progress), ['RV-T-C1-001']);
  assert.equal((await call(tokens.aud1, 'PATCH', `${base}/RV-T-C1-009`, { done: true })).status, 404);   // аудиторт очоогүй санал
  assert.equal((await call(tokens.cae1, 'PATCH', `${base}/RV-T-C1-003`, { done: true })).status, 403);   // багийн бус захирал
  const g = await call(tokens.cae1, 'GET', base);
  assert.equal(g.status, 200);
  assert.ok(g.json.progress['RV-T-C1-001'].done);
  assert.equal(fs.readFileSync(path.join(DIRS.jobs, A, 'feedback', 'feedback_v1.json'), 'utf8'), before);
});

test('5. Засаад дахин оруулахад v2 үүсч, v1-ийн эх файл sha256-аараа өөрчлөгдөөгүй', async () => {
  const c = await call(tokens.aud1, 'POST', '/api/jobs', { parent_id: A });
  assert.ok([200, 201].includes(c.status), String(c.buf));
  const B = c.json.id;
  const v2 = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('report v2 changed')]);
  assert.equal((await call(tokens.aud1, 'PUT', `/api/jobs/${B}/files?cat=report&name=T_v2.docx`, v2, true)).status, 201);
  const st = await call(tokens.aud1, 'POST', `/api/jobs/${B}/start`, {});   // «юу зассан» заавал биш
  assert.equal(st.status, 200, String(st.buf));
  assert.equal(st.json.version, 2);
  const v1 = await call(tokens.aud1, 'GET', `/api/jobs/${A}/originals/file?job=${A}&cat=report&name=T_v1.docx`);
  assert.equal(v1.status, 200);
  assert.equal(sha(v1.buf), sha(DOCX1));
  const vs = await call(tokens.cae1, 'GET', `/api/jobs/${A}/versions`);
  assert.equal(vs.json.versions.length, 2);
  // захиралд мэдэгдэл
  const n = await call(tokens.cae1, 'GET', '/api/notifications');
  assert.ok(n.json.items.some(x => x.kind === 'RESUBMITTED'));
  // засвар илгээсний дараа ч «Зассан» тэмдэглэгээг баг (аудитор, ахлах аудитор) өөрчилж болно; захирал өөрчлөхгүй
  assert.equal((await call(tokens.aud1, 'PATCH', `/api/jobs/${A}/feedback/1/progress/RV-T-C1-003`, { done: true })).status, 200);
  assert.equal((await call(tokens.lead1, 'PATCH', `/api/jobs/${A}/feedback/1/progress/RV-T-C1-003`, { done: false })).status, 200);
  assert.equal((await call(tokens.cae1, 'PATCH', `/api/jobs/${A}/feedback/1/progress/RV-T-C1-003`, { done: true })).status, 403);
  assert.ok((await call(tokens.aud1, 'GET', `/api/jobs/${A}/feedback/1/progress`)).json.progress['RV-T-C1-001']);
});

test('6. Линкээр илгээсэн бол тухайн агшны хуулбар (url, огноо, sha256) хадгалагдана', () => {
  const ORIG = require(path.join(ROOT, 'server', 'originals'));
  const d = path.join(TMP, 'linkjob');
  fs.mkdirSync(path.join(d, 'input', 'report'), { recursive: true });
  const snap = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('google snapshot')]);
  fs.writeFileSync(path.join(d, 'input', 'report', 'G.docx'), snap);
  fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ created_by: 'aud1', link_sources: { 'report/G.docx': { host: 'docs.google.com', url: 'https://docs.google.com/document/d/X/edit', fetched_at: '2026-10-12T10:00:00' } } }));
  ORIG.preserve(d);
  const it = ORIG.list(d)[0];
  assert.equal(it.source, 'link'); assert.equal(it.url, 'https://docs.google.com/document/d/X/edit'); assert.ok(it.fetched_at);
  assert.equal(it.sha256, sha(snap));
  // линкийн агуулга өөрчлөгдсөн ч хадгалсан хуулбар өөрчлөгдөхгүй
  assert.equal(sha(fs.readFileSync(ORIG.fileOf(d, 'report', 'G.docx').path)), sha(snap));
});

test('9. R1 > 0 → finalize 409; R1 = 0 → RPT дугаар, эцсийн .docx + PDF', { timeout: 240000 }, async () => {
  const bad = await call(tokens.cae1, 'POST', `/api/jobs/${C}/finalize`, {});
  assert.equal(bad.status, 409);
  const ok = await call(tokens.cae1, 'POST', `/api/jobs/${D}/finalize`, {});
  assert.equal(ok.status, 200, String(ok.buf));
  assert.match(ok.json.finalized.reg_no, /^RPT-174-\d{4}-\d{3}$/);
  const docx = await call(tokens.cae1, 'GET', `/api/jobs/${D}/final/docx`);
  assert.equal(docx.status, 200); assert.equal(sha(docx.buf), sha(DOCX1));
  const pdf = await call(tokens.cae1, 'GET', `/api/jobs/${D}/final/pdf`);
  assert.equal(pdf.status, 200, String(pdf.buf).slice(0, 200)); assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  const z = await call(tokens.cae1, 'GET', `/api/jobs/${D}/final/zip`);
  assert.equal(z.status, 200); assert.equal(z.buf.subarray(0, 2).toString(), 'PK');
  // батлагдсаны дараа шийдвэр түгжигдэнэ
  assert.equal((await call(tokens.cae1, 'POST', `/api/jobs/${D}/release`, {})).status, 409);
});

test('10. Шилжилт бүр audit.jsonl-д хэрэглэгч, role, хувилбар, хугацаатай', () => {
  const lines = fs.readFileSync(path.join(DIRS.logs, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.action === 'workflow.transition');
  const tos = lines.map(x => x.to);
  for (const t of ['RETURNED', 'RESUBMITTED', 'APPROVED_FINAL']) assert.ok(tos.includes(t), `${t} бүртгэгдээгүй`);
  for (const x of lines) { assert.ok(x.user && x.role && x.ts, JSON.stringify(x)); assert.ok(x.version !== undefined); }
});

test('11. Хуучин job (workflow талбаргүй) алдаагүй нээгдэнэ; бодит 4 job-ийн төлөв тооцоологдоно', async () => {
  const r = await call(tokens.cae1, 'GET', `/api/jobs/${E}`);
  assert.equal(r.status, 200); assert.equal(r.json.workflow.state, 'CAE_REVIEW');
  // Бодит jobs/ — зөвхөн уншина (тусдаа процесс, AR_JOBS_DIR-гүй)
  const realJobs = path.join(ROOT, 'jobs');
  const ids = fs.existsSync(realJobs) ? fs.readdirSync(realJobs).filter(x => /^2026100\d-/.test(x)) : [];
  if (!ids.length) return;
  const env = { ...process.env }; delete env.AR_JOBS_DIR;
  const outp = execFileSync(process.execPath, ['-e', `const W=require(${JSON.stringify(path.join(ROOT, 'server', 'workflow'))});for(const id of ${JSON.stringify(ids)}){const s=W.stateOf(W.rootOf(id));console.log(id+' '+s.state)}`], { env, encoding: 'utf8' });
  for (const l of outp.trim().split('\n')) assert.match(l, / (CAE_REVIEW|APPROVED_FINAL|RETURNED|SUBMITTED|RESUBMITTED|DRAFT|CANCELLED)$/);
});

test('12. Шинэ хүсэлт (workflow-гүй ноорог) ахлах аудитор илгээхэд SUBMITTED болно — «хяналтад → хяналтад» алдаагүй', async () => {
  // салбар, хөтөлбөр заавал биш (2026-10-26) — дугаар л заавал
  assert.equal((await call(tokens.lead1, 'POST', '/api/jobs', { branch: 'Эрдэнэт', name: 'Шинэ тайлан' })).status, 400, 'дугааргүй үүссэн');
  const c = await call(tokens.lead1, 'POST', '/api/jobs', { code: 'T-NEW', name: 'Шинэ тайлан', team: ['aud1'] });
  assert.equal(c.status, 201, String(c.buf));
  const id = c.json.id;
  const f = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('new report')]);
  assert.equal((await call(tokens.lead1, 'PUT', `/api/jobs/${id}/files?cat=report&name=R.docx`, f, true)).status, 201);
  const st = await call(tokens.lead1, 'POST', `/api/jobs/${id}/start`, {});
  assert.equal(st.status, 200, String(st.buf));
  const j = await call(tokens.lead1, 'GET', `/api/jobs/${id}`);
  assert.equal(j.json.workflow.state, 'SUBMITTED');
  assert.equal(j.json.status, 'pending', 'илгээхэд AI шууд ажиллах ёсгүй');
  assert.equal(j.json.workflow.version, 1);
  // багийн гишүүн (aud1) харж чадна, захиралд мэдэгдэл
  assert.equal((await call(tokens.aud1, 'GET', `/api/jobs/${id}`)).status, 200);
  const n = await call(tokens.cae1, 'GET', '/api/notifications');
  assert.ok(n.json.items.some(x => x.kind === 'SUBMITTED' && x.job === id));
});

test('13. Үүсгэсэн хүн илгээгээгүй ноорогоо устгана; илгээсэн тайланг устгах → 403', async () => {
  const c = await call(tokens.lead1, 'POST', '/api/jobs', { code: 'T-DRAFT', branch: 'Эрдэнэт' });
  assert.equal((await call(tokens.aud1, 'DELETE', `/api/jobs/${c.json.id}?all=1`)).status, 404, 'бусдын ноорог харагдсан');
  assert.equal((await call(tokens.lead1, 'DELETE', `/api/jobs/${c.json.id}?all=1`)).status, 200);
  assert.equal((await call(tokens.aud1, 'DELETE', `/api/jobs/${A}?all=1`)).status, 403);
});

test('14. Илгээсний дараа ахлах аудитор илгээсэн файлуудаа харна; захиралд «Шинэ хянуулах хүсэлт ирлээ»', async () => {
  const c = await call(tokens.lead1, 'POST', '/api/jobs', { code: 'T-FILES', branch: 'Эрдэнэт' });
  const id = c.json.id, f = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('x')]);
  await call(tokens.lead1, 'PUT', `/api/jobs/${id}/files?cat=report&name=Тайлан.docx`, f, true);
  await call(tokens.lead1, 'PUT', `/api/jobs/${id}/files?cat=program&name=Хөтөлбөр.docx`, f, true);
  assert.equal((await call(tokens.lead1, 'POST', `/api/jobs/${id}/start`, {})).status, 200);
  const v = await call(tokens.lead1, 'GET', `/api/jobs/${id}/versions`);
  const names = v.json.versions[0].files.map(x => x.name).sort();
  assert.deepEqual(names, ['Тайлан.docx', 'Хөтөлбөр.docx']);
  assert.equal(v.json.versions[0].verdict, undefined);
  const n = await call(tokens.cae1, 'GET', '/api/notifications');
  assert.ok(n.json.items.some(x => x.job === id && /Шинэ хянуулах хүсэлт ирлээ/.test(x.text)));
});

test('15. Илгээхэд AI ажиллахгүй; зөвхөн захирал «AI хянуулах»; AI ажиллах зуур өөр тайлангийн саналыг шийдвэрлэнэ', { timeout: 60000 }, async () => {
  const c = await call(tokens.lead1, 'POST', '/api/jobs', { code: 'T-AI', branch: 'Эрдэнэт', name: 'AI товч' });
  const id = c.json.id, f = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('ai')]);
  await call(tokens.lead1, 'PUT', `/api/jobs/${id}/files?cat=report&name=R.docx`, f, true);
  await call(tokens.lead1, 'PUT', `/api/jobs/${id}/files?cat=program&name=P.docx`, f, true);
  assert.equal((await call(tokens.lead1, 'POST', `/api/jobs/${id}/start`, {})).status, 200);
  assert.equal((await call(tokens.cae1, 'GET', `/api/jobs/${id}`)).json.status, 'pending');
  // аудитор / ахлах аудитор эхлүүлэх эрхгүй
  assert.equal((await call(tokens.lead1, 'POST', `/api/jobs/${id}/ai-review`, {})).status, 403);
  assert.equal((await call(tokens.aud1, 'POST', `/api/jobs/${id}/ai-review`, {})).status, 404);
  assert.equal((await call(tokens.cae1, 'POST', `/api/jobs/${id}/ai-review`, {})).status, 200);
  assert.equal((await call(tokens.cae1, 'POST', `/api/jobs/${id}/ai-review`, {})).status, 409, 'давхар эхлүүлсэн');
  // AI ажиллаж / дараалалд байх зуур өөр (дууссан) тайлангийн саналыг шийдвэрлэнэ
  const d = await call(tokens.cae1, 'PATCH', `/api/jobs/${C}/decisions/RV-T-C1-001`, { decision: 'REJECTED' });
  assert.equal(d.status, 200, String(d.buf));
  // claude олдохгүй тул failed болно → захирал дахин эхлүүлнэ (эх файлыг originals/-аас сэргээнэ)
  let st; for (let i = 0; i < 100; i++) { st = (await call(tokens.cae1, 'GET', `/api/jobs/${id}`)).json.status; if (['failed', 'done'].includes(st)) break; await new Promise(r => setTimeout(r, 200)); }
  assert.equal(st, 'failed');
  assert.equal((await call(tokens.cae1, 'POST', `/api/jobs/${id}/ai-review`, {})).status, 200, 'дахин эхлүүлж чадсангүй');
});

test('16. Зөвхөн сүүлийн засварласан хувилбарыг устгана; өмнөх хувилбар, feedback хэвээр, RETURNED руу буцна', async () => {
  const R = makeJob({ workflow: { state: 'RESUBMITTED', version: 2, history: [] } });
  fs.mkdirSync(path.join(DIRS.jobs, R, 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.jobs, R, 'feedback', 'feedback_v1.json'), JSON.stringify({ version: 1, job: R, items: [{ id: 'RV-T-C1-001' }] }));
  const V2 = makeJob({ parent_id: R, round: 1, workflow: null });
  assert.equal((await call(tokens.aud1, 'DELETE', `/api/jobs/${V2}`)).status, 403, 'аудитор хувилбар устгасан');
  assert.equal((await call(tokens.cae1, 'DELETE', `/api/jobs/${R}`)).status, 409, 'v1-ийг дангаар нь устгасан');
  const r = await call(tokens.cae1, 'DELETE', `/api/jobs/${V2}`);
  assert.equal(r.status, 200, String(r.buf));
  assert.ok(!fs.existsSync(path.join(DIRS.jobs, V2)), 'v2 үлдсэн');
  assert.ok(fs.existsSync(path.join(DIRS.jobs, R, 'feedback', 'feedback_v1.json')), 'v1-ийн feedback устсан');
  assert.ok(fs.existsSync(path.join(DIRS.jobs, R, 'originals', 'report', 'T_v1.docx')), 'v1-ийн эх файл устсан');
  const w = (await call(tokens.cae1, 'GET', `/api/jobs/${R}/versions`)).json;
  assert.equal(w.workflow.state, 'RETURNED'); assert.equal(w.workflow.version, 1); assert.equal(w.versions.length, 1);
  // feedback нь илгээгдсэн хувилбарыг устгахгүй
  const V2b = makeJob({ parent_id: R, round: 1, workflow: null });
  fs.writeFileSync(path.join(DIRS.jobs, R, 'feedback', 'feedback_v2.json'), JSON.stringify({ version: 2, job: V2b, items: [] }));
  const jf = path.join(DIRS.jobs, R, 'job.json');
  fs.writeFileSync(jf, JSON.stringify({ ...JSON.parse(fs.readFileSync(jf, 'utf8')), workflow: { state: 'RETURNED', version: 2, history: [] } }));
  assert.equal((await call(tokens.cae1, 'DELETE', `/api/jobs/${V2b}`)).status, 409, 'илгээсэн feedback-тэй хувилбар устсан');
});

test('17. Илгээгээгүй хувилбарын засах зөвлөмжийн төсөл: захирал татна (шийдвэрлээгүйг тэмдэглэнэ), аудитор — 404', async () => {
  const J = makeJob({ issues: 3 });
  await call(tokens.cae1, 'PATCH', `/api/jobs/${J}/decisions/RV-T-C1-001`, { decision: 'APPROVED' });
  await call(tokens.cae1, 'PATCH', `/api/jobs/${J}/decisions/RV-T-C1-002`, { decision: 'REJECTED' });
  for (const f of ['docx', 'xlsx']) {
    const r = await call(tokens.cae1, 'GET', `/api/jobs/${J}/feedback/1/${f}`);
    assert.equal(r.status, 200, String(r.buf));
  }
  const x = await call(tokens.cae1, 'GET', `/api/jobs/${J}/feedback/1/xlsx`);
  const xml = require(path.join(ROOT, 'server', 'extract')).readZip(x.buf).text('xl/worksheets/sheet1.xml') || '';
  assert.ok(xml.includes('Санал 1') && xml.includes('(шийдвэрлээгүй) Санал 3') && !xml.includes('Санал 2<'), 'төслийн агуулга буруу');
  assert.equal((await call(tokens.aud1, 'GET', `/api/jobs/${J}/feedback/1/docx`)).status, 404, 'аудитор төсөл татсан');
  assert.equal((await call(tokens.cae1, 'GET', `/api/jobs/${J}/feedback/2/docx`)).status, 404);
});

/* ---------- Өөрөө шалгах (2026-10-21) ---------- */
// Дууссан «өөрөө шалгах» job (fixture): workflow-гүй, kind: 'precheck'
function makePrecheck({ created_by = 'aud1', team = [], group, issues = 4 } = {}) {
  const id = makeJob({ created_by, team, issues, workflow: null });
  const jf = path.join(DIRS.jobs, id, 'job.json');
  fs.writeFileSync(jf, JSON.stringify({ ...JSON.parse(fs.readFileSync(jf, 'utf8')), kind: 'precheck', precheck_group: group || id }));
  return id;
}

test('18. Аудитор өөрөө шалгасан бүх саналыг харна; жагсаалтад тусдаа; бусад аудитор харахгүй; шууд илгээх → 409', async () => {
  const P1 = makePrecheck();
  const j = await call(tokens.aud1, 'GET', `/api/jobs/${P1}`);
  assert.equal(j.status, 200);
  assert.ok(!j.json.restricted && j.json.workflow === undefined, 'өөрөө шалгасан job хязгаарлагдсан');
  assert.equal(j.json.can.precheck, true); assert.equal(j.json.can.decide, false);
  assert.equal(j.json.precheck.used, 1); assert.equal(j.json.precheck.left, 2);
  const f = await call(tokens.aud1, 'GET', `/api/jobs/${P1}/output/review_findings.json`);
  assert.equal(f.status, 200); assert.equal(f.json.issues.length, 4, 'шийдвэргүй санал шүүгдсэн');
  assert.equal((await call(tokens.aud1, 'GET', `/api/jobs/${P1}/document`)).status, 200);
  assert.equal((await call(tokens.aud1, 'POST', `/api/jobs/${P1}/decisions`, { items: [{ id: 'RV-T-C1-001', decision: 'APPROVED' }] })).status, 403);
  assert.equal((await call(tokens.aud1, 'POST', `/api/jobs/${P1}/start`, {})).status, 409);
  const list = await call(tokens.aud1, 'GET', '/api/jobs');
  assert.ok(!list.json.jobs.some(x => x.id === P1) && list.json.prechecks.some(x => x.id === P1));
  assert.equal((await call(tokens.lead1, 'GET', `/api/jobs/${P1}`)).status, 404, 'багт ороогүй аудитор харсан');
  // захирал харна
  const c = await call(tokens.cae1, 'GET', '/api/jobs');
  assert.ok(c.json.prechecks.some(x => x.id === P1));
  assert.equal((await call(tokens.cae1, 'GET', `/api/jobs/${P1}/output/review_findings.json`)).json.issues.length, 4);
});

test('19. Өөрөө шалгах: файл оруулаад AI шууд дараалалд (захирал хэрэггүй); дээд тоо хэтрэхэд 409', { timeout: 60000 }, async () => {
  const c = await call(tokens.aud1, 'POST', '/api/jobs', { code: 'T-PC', branch: 'Эрдэнэт', precheck: true });
  assert.equal(c.status, 201, String(c.buf));
  const id = c.json.id, f = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('pc')]);
  await call(tokens.aud1, 'PUT', `/api/jobs/${id}/files?cat=report&name=R.docx`, f, true);
  assert.equal((await call(tokens.aud1, 'POST', `/api/jobs/${id}/precheck`, {})).status, 200);
  let st; for (let i = 0; i < 100; i++) { st = (await call(tokens.aud1, 'GET', `/api/jobs/${id}`)).json.status; if (['failed', 'done'].includes(st)) break; await new Promise(r => setTimeout(r, 200)); }
  assert.equal(st, 'failed');   // claude олдохгүй
  assert.equal((await call(tokens.aud1, 'POST', `/api/jobs/${id}/precheck`, {})).status, 200, 'тасарсныг дахин эхлүүлж чадсангүй');
  for (let i = 0; i < 100; i++) { st = (await call(tokens.aud1, 'GET', `/api/jobs/${id}`)).json.status; if (['failed', 'done'].includes(st)) break; await new Promise(r => setTimeout(r, 200)); }
  const n = await call(tokens.aud1, 'GET', '/api/notifications');
  assert.ok(n.json.items.some(x => x.kind === 'PRECHECK' && x.job === id), 'мэдэгдэл ирээгүй');
  // дээд тоо: цувралд 3 шалгалт ажилласан бол дахин шалгах → 409
  const G = makePrecheck(); makePrecheck({ group: G }); makePrecheck({ group: G });
  const r = await call(tokens.aud1, 'POST', '/api/jobs', { code: 'T-PC', branch: 'Эрдэнэт', precheck: true, precheck_prev: G });
  assert.equal(r.status, 409, String(r.buf));
});

test('20. Өөрөө шалгаснаас захиралд илгээх: оруулаагүй файлыг шалгалтаас авна; захирал, аудитор шалгалтын түүхийг харна', async () => {
  const P1 = makePrecheck(), P2 = makePrecheck({ group: P1 });
  const c = await call(tokens.aud1, 'POST', '/api/jobs', { code: 'T-1', branch: 'Эрдэнэт', precheck_id: P2 });
  assert.equal(c.status, 201, String(c.buf));
  const id = c.json.id;
  const f = Buffer.concat([Buffer.from('504B0304', 'hex'), Buffer.from('fixed report')]);
  await call(tokens.aud1, 'PUT', `/api/jobs/${id}/files?cat=report&name=Fixed.docx`, f, true);
  const st = await call(tokens.aud1, 'POST', `/api/jobs/${id}/start`, {});
  assert.equal(st.status, 200, String(st.buf));   // хөтөлбөрийг шалгалтаас авсан
  assert.ok(fs.existsSync(path.join(DIRS.jobs, id, 'input', 'program', 'P.docx')), 'хөтөлбөр хуулагдаагүй');
  assert.ok(fs.existsSync(path.join(DIRS.jobs, id, 'input', 'report', 'Fixed.docx')) && !fs.existsSync(path.join(DIRS.jobs, id, 'input', 'report', 'T_v1.docx')), 'зассан тайлангийн оронд хуучныг авсан');
  for (const x of [P1, P2]) assert.equal(JSON.parse(fs.readFileSync(path.join(DIRS.jobs, x, 'job.json'), 'utf8')).submitted_as, id);
  const cae = await call(tokens.cae1, 'GET', `/api/jobs/${id}`);
  assert.deepEqual(cae.json.prechecks.map(x => x.id), [P1, P2]);
  const aud = await call(tokens.aud1, 'GET', `/api/jobs/${id}`);
  assert.equal(aud.json.restricted, true); assert.equal(aud.json.prechecks.length, 2);
  // илгээсэн шалгалтыг дахин холбох, устгах боломжгүй; жагсаалтад «илгээгээгүй»-д харагдахгүй
  assert.equal((await call(tokens.aud1, 'POST', '/api/jobs', { code: 'T-1', branch: 'Эрдэнэт', precheck_id: P2 })).status, 409);
  assert.equal((await call(tokens.aud1, 'DELETE', `/api/jobs/${P2}`)).status, 403);
  assert.ok(!(await call(tokens.aud1, 'GET', '/api/jobs')).json.prechecks.some(x => x.id === P2));
  const n = await call(tokens.cae1, 'GET', '/api/notifications');
  assert.ok(n.json.items.some(x => x.job === id && /2 удаа өөрөө шалгасан/.test(x.text)));
  // илгээгээгүй шалгалтыг аудитор өөрөө устгана
  const P3 = makePrecheck();
  assert.equal((await call(tokens.aud1, 'DELETE', `/api/jobs/${P3}`)).status, 200);
});
