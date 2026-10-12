'use strict';
/*
  Мэдэгдэл: вэб хонх (logs/notifications.jsonl) + имэйл (SMTP, сонголтоор).
  - notifications.jsonl: мөр бүр { id, at, to, kind, job, version, text }. Уншсан төлөв: logs/notifications_read.json { user: [id…] }.
  - Имэйл: web/smtp.json (EFS шифрлэлттэй; config/ нь Claude-ийн sandbox руу хуулагддаг тул ТЭНД хадгалахгүй).
      { "enabled": true, "host": "smtp.netgroup.mn", "port": 587, "secure": false, "from": "review-agent@netgroup.mn",
        "user": "review-agent@netgroup.mn", "password": "…", "domain": "netgroup.mn", "base_url": "https://10.0.19.61:8443" }
    Хүлээн авагч = <нэвтрэх нэр>@domain. Илгээлт алдаатай байсан ч урсгалыг зогсоохгүй — консол, логт бичнэ.
  Имэйлд тайлангийн агуулга, санал ОРУУЛАХГҮЙ — зөвхөн «юу болсон», аудитын код, линк.
*/

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const C = require('./common');

const LOGS = () => process.env.AR_LOGS_DIR || C.PATHS.logs;
const FILE = () => path.join(LOGS(), 'notifications.jsonl');
const READ = () => path.join(LOGS(), 'notifications_read.json');
const SMTP_FILE = () => process.env.AR_SMTP_FILE || path.join(C.PATHS.web, 'smtp.json');

function all() {
  const f = FILE();
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Хэрэглэгчийн мэдэгдэл (сүүлийн 50) + уншаагүй тоо */
function forUser(user) {
  const read = new Set((C.readJson(READ()) || {})[user] || []);
  const mine = all().filter(n => n.to === user).reverse();
  return { unread: mine.filter(n => !read.has(n.id)).length, items: mine.slice(0, 50).map(n => ({ ...n, read: read.has(n.id) })) };
}
function markRead(user, ids) {
  const db = C.readJson(READ()) || {};
  const set = new Set(db[user] || []);
  const mine = all().filter(n => n.to === user).map(n => n.id);
  for (const id of ids === 'all' ? mine : ids) if (mine.includes(id)) set.add(id);
  db[user] = [...set].slice(-2000);
  C.writeJson(READ(), db);
}

/** Мэдэгдэл бичих: to = хэрэглэгчийн нэрсийн жагсаалт */
function send(to, { kind, job, version, text, audit = {} }) {
  const users = [...new Set((to || []).filter(u => u && !/^(ip|name):/.test(u)))];
  if (!users.length) return 0;
  fs.mkdirSync(LOGS(), { recursive: true });
  const at = C.nowIso();
  const lines = users.map(u => JSON.stringify({ id: crypto.randomBytes(6).toString('hex'), at, to: u, kind, job, version: version ?? null, text: String(text).slice(0, 300) }));
  fs.appendFileSync(FILE(), lines.join('\n') + '\n', 'utf8');
  email(users, kind, job, text, audit).catch(e => console.error(`[${C.timeHms()}] имэйл илгээж чадсангүй: ${e.message}`));
  return users.length;
}

/* ---------- SMTP (Node built-in, STARTTLS / TLS + AUTH LOGIN) ---------- */
function smtpConfig() { const c = C.readJson(SMTP_FILE()); return c && c.enabled && c.host && c.from ? c : null; }

function smtpSend(cfg, rcpts, subject, body) {
  return new Promise((resolve, reject) => {
    let sock = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port || 465, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port || 587 });
    sock.setEncoding('utf8');
    sock.setTimeout(30000, () => { sock.destroy(); reject(new Error('SMTP хугацаа хэтэрсэн')); });
    // Хариу бүр: «250-…» мөрүүд + төгсгөлийн «250 …» мөр
    let buf = '';
    const pending = [], waiters = [];
    const onData = d => {
      buf += d;
      let m;
      while ((m = buf.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/))) {
        buf = buf.slice(m[0].length);
        if (waiters.length) waiters.shift()(m[0]); else pending.push(m[0]);
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
    const read = () => pending.length ? Promise.resolve(pending.shift()) : new Promise(r => waiters.push(r));
    const cmd = async (line, ok) => { if (line !== null) sock.write(line + '\r\n'); const r = await read(); if (!ok.test(r)) throw new Error(`SMTP: ${r.trim().split('\r\n').pop()}`); return r; };
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    (async () => {
      await cmd(null, /^220/m);
      let ehlo = await cmd(`EHLO review-agent`, /^250/m);
      if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', /^220/m);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: cfg.host });
        sock.setEncoding('utf8'); sock.on('data', onData); sock.on('error', reject);
        await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
        ehlo = await cmd('EHLO review-agent', /^250/m);
      }
      if (cfg.user && cfg.password) {
        await cmd('AUTH LOGIN', /^334/m); await cmd(b64(cfg.user), /^334/m); await cmd(b64(cfg.password), /^235/m);
      }
      await cmd(`MAIL FROM:<${cfg.from}>`, /^250/m);
      for (const r of rcpts) await cmd(`RCPT TO:<${r}>`, /^25[01]/m);
      await cmd('DATA', /^354/m);
      const msg = [`From: Review Agent <${cfg.from}>`, `To: ${rcpts.join(', ')}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(body).replace(/.{1,76}/g, '$&\r\n')].join('\r\n');
      await cmd(msg + '\r\n.', /^250/m);
      sock.write('QUIT\r\n'); sock.end();
      resolve();
    })().catch(e => { try { sock.destroy(); } catch { /* ignore */ } reject(e); });
  });
}

const SUBJECT = { SUBMITTED: 'Шинэ тайлан хяналтад ирлээ', RESUBMITTED: 'Засварласан тайлан хяналтад ирлээ', RETURNED: 'Захирал тайланд санал буцаалаа',
  APPROVED_FINAL: 'Тайлан эцэслэн батлагдлаа', CANCELLED: 'Хяналт цуцлагдлаа' };
async function email(users, kind, job, text, audit) {
  const cfg = smtpConfig();
  if (!cfg) return;
  const domain = cfg.domain || 'netgroup.mn';
  const rcpts = users.map(u => u.includes('@') ? u : `${u}@${domain}`);
  const subject = `[Review Agent] ${SUBJECT[kind] || 'Мэдэгдэл'}${audit.code ? ' — ' + audit.code : ''}`;
  const body = `${text}\n\n${cfg.base_url ? `Нээх: ${cfg.base_url}/#job/${job}\n\n` : ''}Энэ имэйлд тайлангийн агуулга орохгүй. Дэлгэрэнгүйг системд нэвтэрч харна уу.\nInternal Audit – Restricted`;
  await smtpSend(cfg, rcpts, subject, body);
}

module.exports = { send, forUser, markRead, smtpConfig, smtpSend };
