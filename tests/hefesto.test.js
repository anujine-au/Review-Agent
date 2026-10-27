'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');

// Хуурамч Hefesto: хүсэлт бүрийг цуглуулж, heartbeat-д active утгыг буцаана
const got = [];
let active = true;
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    got.push({ path: req.url, token: req.headers['x-bot-token'], body: b ? JSON.parse(b) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url.endsWith('/heartbeat') ? JSON.stringify({ active, pendingTasks: 0 }) : '{}');
  });
});
const until = async f => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
let HF;

test.before(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.HEFESTO_API = `http://127.0.0.1:${srv.address().port}/api/v1/`;
  process.env.HEFESTO_BOT_TOKEN = 'hbt_test';
  HF = require(path.join(__dirname, '..', 'server', 'hefesto'));
});
test.after(() => srv.close());

test('token дэд процесст (process.env) дамжихгүй', () => {
  assert.ok(HF.enabled());
  assert.equal(process.env.HEFESTO_BOT_TOKEN, undefined);
  assert.equal(process.env.HEFESTO_API, undefined);
});

test('activity: heartbeat-аар X-Bot-Token-тэй, ≤200 тэмдэгт; хоосон = дууссан', async () => {
  got.length = 0;
  HF.setActivity('Салбарын аудитын тайланг AI-аар хянаж байна ' + 'x'.repeat(300));
  await until(() => got.length >= 1);
  assert.equal(got[0].path, '/api/v1/bot-api/heartbeat');
  assert.equal(got[0].token, 'hbt_test');
  assert.ok(got[0].body.activity.length <= 200);
  HF.setActivity('');
  await until(() => got.length >= 2);
  assert.equal(got[1].body.activity, '');
});

test('event: баримтын файлын нэр detail-д үлдэхгүй, stack-ийн мөр хадгалагдана', async () => {
  got.length = 0;
  HF.report('ERROR', 'Аудитын тайлангийн AI хяналт амжилтгүй боллоо', "job 1: ENOENT '/srv/input/Салбар_3_тайлан.docx'\n    at x (/home/u/review-agent/server/runner.js:1:1)");
  await until(() => got.length >= 1);
  assert.equal(got[0].path, '/api/v1/bot-api/events');
  assert.equal(got[0].body.type, 'ERROR');
  assert.ok(!/Салбар_3|\.docx/.test(got[0].body.detail), got[0].body.detail);
  assert.ok(got[0].body.detail.includes('\n') && got[0].body.detail.includes('runner.js'));
});

test('active=false → paused (шинэ хяналт эхлүүлэхгүй), true → дахин идэвхжинэ', async () => {
  active = false;
  HF.setActivity('a'); await until(() => HF.paused());
  assert.ok(HF.paused());
  active = true;
  HF.setActivity(''); await until(() => !HF.paused());
  assert.ok(!HF.paused());
});

test('Hefesto хүрэхгүй байсан ч алдаа шидэхгүй', async () => {
  srv.close();
  assert.equal(await HF.report('INFO', 'туршилт'), null);
});
