'use strict';
/*
  Google Drive холболт — админ өөрийн (эсвэл тусгай) Google дансны уншиx эрхийг нэг удаа хуваалцана.
  Үүний дараа хувийн (зөвхөн netgroup.mn-д хуваалцсан) Drive / Docs / Sheets линкийг сервер тэр дансны эрхээр татна.

  - OAuth «Desktop app» client (loopback redirect) — серверт домэйн нэр хэрэггүй. Зөвшөөрсний дараа хөтөч
    http://127.0.0.1/?code=… руу шилжиж «холбогдож чадсангүй» гэнэ — тэр хаягийг хуулж буцааж оруулна.
  - Эрх: drive.readonly (зөвхөн унших). Refresh token-ыг AES-256-GCM-ээр шифрлэж web/gdrive.json-д,
    түлхүүрийг тусдаа web/gdrive.key-д (0600) хадгална. Хоёулаа git-д орохгүй.
  - Салгахад Google талд token-ыг цуцалж (revoke), файлуудыг устгана.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATHS } = require('./common');

const DIR = process.env.AR_GDRIVE_DIR || PATHS.web;   // AR_*_DIR: зөвхөн тестэд
const CFG = path.join(DIR, 'gdrive.json');
const KEYF = path.join(DIR, 'gdrive.key');
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.readonly';
const REDIRECT = 'http://127.0.0.1';
const API = 'https://www.googleapis.com/drive/v3/files/';
const EXPORT = { 'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'] };

function key() {
  if (!fs.existsSync(KEYF)) fs.writeFileSync(KEYF, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(KEYF, 'utf8').trim(), 'base64');
}
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function unseal(s) {
  const [iv, tag, enc] = String(s).split('.').map(b => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
// Google руу хандах: сүлжээний түр тасалдалд (холбогдож чадаагүй) нэг удаа дахин оролдоно, шалтгааныг тодорхой хэлнэ
async function gfetch(url, opt) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, opt); } catch (e) {
      if (e.name === 'AbortError') throw e;
      const code = (e.cause && (e.cause.code || e.cause.message)) || e.message;
      if (i < 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
      throw new Error(`Сервер Google (${new URL(url).hostname}) руу холбогдож чадсангүй (${code}). Хэсэг хүлээгээд дахин оролдоно уу`);
    }
  }
}
const readCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return null; } };
const writeCfg = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2), { mode: 0o600 });

function status() {
  const c = readCfg();
  return c && c.refresh ? { connected: true, email: c.email, connected_at: c.connected_at, by: c.by } : { connected: false };
}
const connected = () => status().connected;

// 1-р алхам: зөвшөөрлийн хаяг (state + PKCE-г 15 минут санах ойд)
const pending = new Map();
function start(clientId, clientSecret) {
  // Хуулахад орсон хоосон зай, мөр шилжилт, хашилтыг арилгана
  clientId = String(clientId || '').replace(/[\s"']/g, ''); clientSecret = String(clientSecret || '').replace(/[\s"']/g, '');
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Client ID буруу байна (…apps.googleusercontent.com гэж төгсөнө)');
  if (!clientSecret) throw new Error('Client secret-ийг оруулна уу');
  if (!/^GOCSPX-[\w-]{20,}$/.test(clientSecret)) throw new Error(`Client secret буруу хуулагдсан бололтой (${clientSecret.length} тэмдэгт${clientSecret.startsWith('GOCSPX-') ? '' : ', «GOCSPX-»-ээр эхлээгүй'}). Зөв secret «GOCSPX-» гэж эхэлж, 35 орчим тэмдэгттэй. Хөтөч нууц үгээ автоматаар бөглөсөн эсэхийг шалгана уу`);
  const state = crypto.randomBytes(16).toString('hex'), verifier = crypto.randomBytes(32).toString('base64url');
  pending.set(state, { clientId, clientSecret, verifier, exp: Date.now() + 15 * 60000 });
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

// 2-р алхам: хөтчийн хаягийн мөрөөс хуулсан http://127.0.0.1/?state=…&code=… хаягийг солилцоно
async function finish(redirected, by) {
  let u; try { u = new URL(String(redirected || '').trim()); } catch { throw new Error('Хөтчийн хаягийн мөрөөс бүтэн хаягийг (http://127.0.0.1/?…) хуулж оруулна уу'); }
  if (u.searchParams.get('error')) throw new Error('Google зөвшөөрөл өгөөгүй: ' + u.searchParams.get('error'));
  const p = pending.get(u.searchParams.get('state'));
  if (!p || p.exp < Date.now()) throw new Error('Хугацаа дууссан эсвэл өөр холболтын хаяг байна — «Google-ээр холбох»-ыг дахин дарна уу');
  pending.delete(u.searchParams.get('state'));
  const r = await gfetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: u.searchParams.get('code') || '', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: p.verifier }) });
  const t = await r.json().catch(() => ({}));
  if (t.error === 'invalid_grant') throw new Error('Зөвшөөрлийн код хүчингүй эсвэл хэрэглэгдсэн байна — «Google-ээр холбох»-ыг дахин дарж, шинэ хаягаа шууд оруулна уу');
  if (!r.ok || !t.refresh_token) throw new Error('Google token олгосонгүй: ' + (t.error_description || t.error || r.status));
  if (!String(t.scope || '').includes('drive.readonly')) throw new Error('Drive унших эрхийг зөвшөөрөөгүй байна — дахин холбож, Drive-ийн нүдийг чагтална уу');
  let email = '';
  try { email = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch {}
  writeCfg({ client_id: p.clientId, secret: seal(p.clientSecret), refresh: seal(t.refresh_token), email, connected_at: new Date().toISOString(), by });
  access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
  return status();
}

async function disconnect() {
  const c = readCfg();
  if (c && c.refresh) {
    try { await gfetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: unseal(c.refresh) }) }); } catch { /* сүлжээгүй ч локал файлыг устгана */ }
  }
  access = null;
  for (const f of [CFG, KEYF]) { try { fs.rmSync(f, { force: true }); } catch {} }
}

let access = null;
async function accessToken() {
  if (access && access.exp > Date.now()) return access.token;
  const c = readCfg();
  if (!c || !c.refresh) throw new Error('Google Drive холбогдоогүй');
  const r = await gfetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: unseal(c.secret), refresh_token: unseal(c.refresh), grant_type: 'refresh_token' }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(t.error === 'invalid_grant' ? 'Google Drive-ийн холболт хүчингүй болсон — админ дахин холбоно уу' : 'Google token сэргээж чадсангүй');
  access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
  return access.token;
}

// Файлын ID → татах хаяг, нэр. Google Docs / Sheets-ийг .docx / .xlsx болгож экспортолно.
async function resolve(fileId, signal) {
  const tok = await accessToken();
  const r = await gfetch(`${API}${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,owners(emailAddress)&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${tok}` }, signal });
  if (r.status === 404) throw new Error(`Файл олдсонгүй эсвэл ${status().email || 'холбосон данс'}-д хандах эрх алга`);
  if (!r.ok) throw new Error(`Google Drive хариу өгсөнгүй (HTTP ${r.status})`);
  const f = await r.json();
  if (f.mimeType === 'application/vnd.google-apps.folder') throw new Error('Хавтасны биш, файлын линк оруулна уу');
  const ex = EXPORT[f.mimeType];
  if (!ex && String(f.mimeType).startsWith('application/vnd.google-apps.')) throw new Error('Энэ төрлийн Google файл дэмжигдэхгүй (Docs, Sheets л болно)');
  const name = ex ? f.name.replace(/\.(docx?|xlsx?)$/i, '') + ex[1] : f.name;
  const url = ex ? `${API}${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(ex[0])}` : `${API}${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
  return { url, name, headers: { Authorization: `Bearer ${tok}` }, owner: (f.owners || [])[0]?.emailAddress || '' };
}

module.exports = { status, connected, start, finish, disconnect, resolve };
