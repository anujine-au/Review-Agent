'use strict';
/*
  Google Drive холболт (server/gdrive.js, fetch_url.js). Ажиллуулах:  node --test tests/
  Google руу хандахгүй — fetch-ийг mock хийнэ. Тохиргоог түр хавтсанд (AR_GDRIVE_DIR) бичнэ.
*/
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-gd-'));
process.env.AR_GDRIVE_DIR = TMP;
const GD = require('../server/gdrive');
const FU = require('../server/fetch_url');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const calls = [];
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
global.fetch = async (url, opt = {}) => {
  calls.push({ url: String(url), opt });
  if (url === 'https://oauth2.googleapis.com/token') {
    const b = new URLSearchParams(opt.body);
    if (b.get('grant_type') === 'authorization_code') {
      assert.equal(b.get('code'), 'C0DE'); assert.ok(b.get('code_verifier'));
      assert.equal(b.get('client_secret'), 'GOCSPX-abcdefghijklmnopqrstuvwxyz12');   // хоосон зай, хашилтгүй
      assert.equal(b.get('client_id'), '123-abc.apps.googleusercontent.com');
      const idt = 'x.' + Buffer.from(JSON.stringify({ email: 'anujin.e@netgroup.mn' })).toString('base64url') + '.y';
      return json({ access_token: 'AT1', expires_in: 3600, refresh_token: 'RT-secret', scope: 'openid email https://www.googleapis.com/auth/drive.readonly', id_token: idt });
    }
    return json({ access_token: 'AT2', expires_in: 3600 });
  }
  if (url === 'https://oauth2.googleapis.com/revoke') return json({});
  if (String(url).includes('/files/DOC1?fields')) return json({ id: 'DOC1', name: 'Тайлан', mimeType: 'application/vnd.google-apps.document', owners: [{ emailAddress: 'bat@netgroup.mn' }] });
  if (String(url).includes('/files/FOLD?fields')) return json({ id: 'FOLD', name: 'x', mimeType: 'application/vnd.google-apps.folder' });
  if (String(url).includes('/files/NOPE?fields')) return json({}, 404);
  if (String(url).includes('/files/FLAKY?fields')) {   // эхний оролдлогод сүлжээ тасарна
    if (calls.filter(c => c.url.includes('/files/FLAKY')).length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return json({ id: 'FLAKY', name: 'a.pdf', mimeType: 'application/pdf' });
  }
  if (String(url).includes('/files/DOWN?fields')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  throw new Error('unexpected fetch ' + url);
};

test('normalize: Google линкээс файлын ID', () => {
  assert.equal(FU.normalize('https://docs.google.com/document/d/AbC_1-x/edit').gid, 'AbC_1-x');
  assert.equal(FU.normalize('https://drive.google.com/file/d/Zz9/view?usp=sharing').gid, 'Zz9');
  assert.equal(FU.normalize('https://example.com/a.docx').gid, undefined);
});

test('холбох → token шифрлэгдсэн, файлыг татах хаяг → салгах', async () => {
  assert.equal(GD.connected(), false);
  assert.throws(() => GD.start('bad', 's'), /Client ID/);
  assert.throws(() => GD.start('123-abc.apps.googleusercontent.com', 'MyLoginPassw0rd'), /буруу хуулагдсан.*GOCSPX-»-ээр эхлээгүй/);
  assert.throws(() => GD.start('123-abc.apps.googleusercontent.com', 'MyLoginPassw0rd'), e => !e.message.includes('MyLogin'));
  const SECRET = 'GOCSPX-abcdefghijklmnopqrstuvwxyz12';
  const u = new URL(GD.start(' 123-abc.apps.googleusercontent.com\n', ` "${SECRET}" `));
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1');
  assert.match(u.searchParams.get('scope'), /drive\.readonly/);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(GD.finish('http://127.0.0.1/?state=wrong&code=C0DE', 'admin'), /Хугацаа дууссан/);
  const st = await GD.finish(`http://127.0.0.1/?state=${u.searchParams.get('state')}&code=C0DE&scope=x`, 'admin');
  assert.deepEqual([st.connected, st.email, st.by], [true, 'anujin.e@netgroup.mn', 'admin']);
  const raw = fs.readFileSync(path.join(TMP, 'gdrive.json'), 'utf8');
  assert.ok(!raw.includes('RT-secret') && !raw.includes(SECRET), 'token, secret ил хадгалагдахгүй');
  // state нэг удаа л хэрэглэгдэнэ
  await assert.rejects(GD.finish(`http://127.0.0.1/?state=${u.searchParams.get('state')}&code=C0DE`, 'admin'), /Хугацаа дууссан/);

  const r = await GD.resolve('DOC1');
  assert.equal(r.name, 'Тайлан.docx');
  assert.match(r.url, /\/files\/DOC1\/export\?mimeType=application%2Fvnd\.openxmlformats/);
  assert.equal(r.headers.Authorization, 'Bearer AT1');
  assert.equal(r.owner, 'bat@netgroup.mn');
  await assert.rejects(GD.resolve('FOLD'), /Хавтасны/);
  await assert.rejects(GD.resolve('NOPE'), /эрх алга/);
  assert.equal((await GD.resolve('FLAKY')).name, 'a.pdf');   // түр тасалдалд дахин оролдоно
  await assert.rejects(GD.resolve('DOWN'), /холбогдож чадсангүй \(ENOTFOUND\)/);

  await GD.disconnect();
  assert.equal(GD.connected(), false);
  assert.ok(calls.some(c => c.url.endsWith('/revoke') && new URLSearchParams(c.opt.body).get('token') === 'RT-secret'));
  assert.ok(!fs.existsSync(path.join(TMP, 'gdrive.json')) && !fs.existsSync(path.join(TMP, 'gdrive.key')));
});
