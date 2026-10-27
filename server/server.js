'use strict';
/*
  Audit Report Reviewer — вэб сервер (Node.js, гадны сангүй).

  Хамгаалалт:
  - Анхдагчаар зөвхөн энэ компьютер (localhost). --lan үед заавал HTTPS.
  - Нэрийн хэрэглэгч + role (admin / хянагч / аудитор / удирдлага), нууц үг scrypt hash (server/users.js).
    20 тэмдэгттэй нийтийн код нь зөвхөн анхны admin-ыг үүсгэхэд ажиллана.
  - Нэвтрэлт → түр session token (30 мин идэвхгүй бол дуусна, 8 цагийн дээд хязгаар).
  - 5 удаа буруу оролдлого → тухайн IP 15 минут түгжигдэнэ.
  - Host header шалгалт (DNS rebinding), cross-origin хаалт, CSP / X-Frame-Options / no-referrer.
  - jobs\, logs\, нэвтрэх код Windows EFS-ээр шифрлэгдэнэ.
  - Review дуусмагц задалсан текст устна; эх файл originals/-д хувилбараар хадгалагдана; бүх review --retention-days (анхдагч 90) хоногийн дараа устна.
  - Хувийн мэдээллийг Claude-д илгээхээс өмнө token-оор сольж, үр дүнг харуулахдаа буцааж тавина.
  - Хандалтын бүртгэл: logs\access-YYYYMM.log (файлын нэр, агуулга бүртгэхгүй).

  Ажиллуулах:
    node server/server.js                       http://localhost:8080
    node server/server.js --lan                 https://<IP>:8443 (дотоод сүлжээ)
    node server/server.js --retention-days 3
    node server/server.js --rotate-code         шинэ нэвтрэх код
*/

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const C = require('./common');
const { runJob, clearWorkFiles, killTree } = require('./runner');
const { buildExport, EXPORT_FORMATS, zip: zipFiles, feedbackExport } = require('./export');
const ORIG = require('./originals');
const WF = require('./workflow');
const NT = require('./notify');
const FINAL = require('./final');
const { prepare: prepareDocs } = require('./docs_prep');
const { build: buildAnnotated } = require('./docs_annot');
const { verifyFindings } = require('./verify');
const U = require('./users');
const CR = require('./criteria');
const FU = require('./fetch_url');
const GD = require('./gdrive');
const { detectFile } = require('./detect_meta');
const S = require('./standard');
const AL = require('./ailog');
const LIB = require('./library');
const FUP = require('./followup');
const MAN = require('./manual');
const ED = require('./edits');
const SUG = require('./suggest');
const AF = require('./autofix');
const HF = require('./hefesto');   // Hefesto телеметр (token-ийг process.env-ээс хасна)
const { convertDocx } = require('./extract');
// Шийдвэр / илгээлт / эхлүүлэлтийг hash-chain логт (SP-118-04/01 §6 Decision, Submission лог)
const auditLog = (action, fields) => { try { AL.append('audit', { action, ...fields }); } catch (e) { console.error('audit log:', e.message); } };
WF.setAudit(auditLog);   // төлөвийн шилжилт бүр logs/audit.jsonl-д
const pdfTickets = new Map();   // ticket → { id, ip, exp }

/* ---------- Тохиргоо ---------- */
const argv = process.argv.slice(2).map(a => a.toLowerCase().replace(/^-+/, '--'));
const flag = k => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const LAN = flag('--lan');
const PORT = Number(opt('--port', LAN ? 8443 : 8080));
const RETENTION_DAYS = Number(opt('--retention-days', 90));   // 2026-10-12 хэрэглэгчийн шийдвэр: 7 → 90 хоног (эх файлыг хувилбараар хадгалах)
const SESSION_MINUTES = Number(opt('--session-minutes', 0));   // 0 = идэвхгүй байдлаар автоматаар гаргахгүй (2026-10-12 хэрэглэгчийн шийдвэр)
const MAX_UPLOAD_MB = Number(opt('--max-upload-mb', 100));
const PRECHECK_MAX = Number(opt('--precheck-max', 3));   // «Өөрөө шалгах»-ыг нэг тайланд хэдэн удаа ажиллуулах (бүрэн AI хяналт ~10 мин, ~$3)
const P = C.PATHS;

for (const d of [P.jobs, P.logs]) fs.mkdirSync(d, { recursive: true });
const EFS_ON = C.enableEfs(P.jobs) && C.enableEfs(P.logs);

/* ---------- Нэвтрэх код ---------- */
let code = fs.existsSync(P.codeFile) ? fs.readFileSync(P.codeFile, 'utf8').replace(/^﻿/, '').trim() : '';
if (flag('--rotate-code') || code.replace(/[^A-Z0-9]/g, '').length < 20) {
  code = C.randomString(20).match(/.{5}/g).join('-');
  fs.writeFileSync(P.codeFile, code, 'utf8');
}
C.enableEfs(P.codeFile);
const CODE_NORM = Buffer.from(code.replace(/[^A-Z0-9]/g, ''));

const sessions = new Map();   // token → { created, last, ip, user, role, must_change, setup }
const failures = new Map();   // ip → [timestamps]
const lockedUntil = new Map();

/* ---------- TLS (--lan) ---------- */
function loadTls() {
  if (process.platform !== 'win32') return loadTlsPem();
  const pfx = path.join(P.web, 'tls.pfx'), passFile = path.join(P.web, 'tls.pass'), cer = path.join(P.web, 'tls.cer');
  if (!fs.existsSync(pfx) || !fs.existsSync(passFile) || !fs.existsSync(cer)) {
    const pass = C.randomString(32);
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    const san = ['DNS=localhost', `DNS=${os.hostname()}`, ...ips.map(ip => `IPAddress=${ip}`)].join('&');
    const ps = `$c = New-SelfSignedCertificate -Subject 'CN=${os.hostname()} Audit Report Reviewer' -FriendlyName 'AuditReportReviewer' ` +
      `-CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(2) -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 ` +
      `-TextExtension @('2.5.29.17={text}${san}'); ` +
      `Export-PfxCertificate -Cert $c -FilePath '${pfx}' -Password (ConvertTo-SecureString '${pass}' -AsPlainText -Force) | Out-Null; ` +
      `Export-Certificate -Cert $c -FilePath '${cer}' -Type CERT | Out-Null`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
    if (!fs.existsSync(pfx)) { console.error('Сертификат үүсгэж чадсангүй:', r.stderr); process.exit(1); }
    fs.writeFileSync(passFile, pass, 'utf8');
    C.enableEfs(pfx); C.enableEfs(passFile);
  }
  return {
    pfx: fs.readFileSync(pfx),
    passphrase: fs.readFileSync(passFile, 'utf8').trim(),
    fingerprint: new crypto.X509Certificate(fs.readFileSync(cer)).fingerprint256,
  };
}

// Linux сервер: web/tls.key + web/tls.crt (байхгүй бол openssl-ээр self-signed үүсгэнэ; байгууллагын сертификатаар сольж болно)
function loadTlsPem() {
  const key = path.join(P.web, 'tls.key'), crt = path.join(P.web, 'tls.crt');
  if (!fs.existsSync(key) || !fs.existsSync(crt)) {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    const san = ['DNS:localhost', `DNS:${os.hostname()}`, ...extraHosts().map(h => /^[\d.]+$/.test(h) ? `IP:${h}` : `DNS:${h}`), ...ips.map(ip => `IP:${ip}`)].join(',');
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '730', '-keyout', key, '-out', crt,
      '-subj', `/CN=${os.hostname()} Audit Report Reviewer`, '-addext', `subjectAltName=${san}`], { encoding: 'utf8' });
    if (!fs.existsSync(crt)) { console.error('Сертификат үүсгэж чадсангүй (openssl):', r.stderr || r.error); process.exit(1); }
    fs.chmodSync(key, 0o600);
  }
  const cert = fs.readFileSync(crt);
  return { key: fs.readFileSync(key), cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
}
// AR_HOSTS=review.netgroup.mn,10.0.0.5 — сервер дээр хандах нэмэлт нэр / IP
function extraHosts() { return String(process.env.AR_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }

/* ---------- Зөвшөөрөгдсөн Host (DNS rebinding хамгаалалт) ---------- */
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...extraHosts()]);
if (LAN) {
  for (const i of Object.values(os.networkInterfaces()).flat()) if (i) allowedHosts.add(i.family === 'IPv6' ? `[${i.address.replace(/%.*$/, '')}]` : i.address);
  allowedHosts.add(os.hostname().toLowerCase());
}

/* ---------- Бүртгэл ---------- */
// Мөр: огноо \t IP \t хэрэглэгч \t үйлдэл \t дэлгэрэнгүй
function accessLog(ip, action, detail = '', user = '-') {
  const d = new Date();
  const file = path.join(process.env.AR_LOGS_DIR || P.logs, `access-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}.log`);
  fs.appendFileSync(file, `${C.nowIso()}\t${ip}\t${user}\t${action}\t${detail}\r\n`, 'utf8');
}

/* ---------- HTTP туслах ---------- */
const SEC_HEADERS = {
  'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function send(res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(buf);
}
const sendJson = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
const sendErr = (res, status, msg) => sendJson(res, status, { error: msg });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const b = (await readBody(req, 64 * 1024)).toString('utf8').trim();
  return b ? JSON.parse(b) : {};
}

function safeName(raw) {
  let n = path.basename(String(raw || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (n.length > 150) { const e = path.extname(n); n = n.slice(0, 150 - e.length) + e; }
  return !n || n.startsWith('.') ? '' : n;
}
// Файлын төрлийг агуулгаар нь шалгах (өргөтгөл хуурамч эсэх)
function magicOk(file, ext) {
  const buf8 = Buffer.alloc(8); const fd = fs.openSync(file, 'r'); const nRead = fs.readSync(fd, buf8, 0, 8, 0); fs.closeSync(fd);
  const head = buf8.subarray(0, nRead), hex = head.toString('hex').toUpperCase();
  return ['.docx', '.xlsx', '.xlsm'].includes(ext) ? hex.startsWith('504B0304')
    : ext === '.pdf' ? hex.startsWith('25504446') : ext === '.png' ? hex.startsWith('89504E47')
      : ['.jpg', '.jpeg'].includes(ext) ? hex.startsWith('FFD8FF') : !head.includes(0);
}

/* ---------- Нэвтрэлт ---------- */
function sameCode(given) {
  const g = Buffer.from(String(given || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return g.length === CODE_NORM.length && crypto.timingSafeEqual(g, CODE_NORM);
}
const isLocked = ip => (lockedUntil.get(ip) || 0) > Date.now();
function registerFailure(ip) {
  const arr = (failures.get(ip) || []).filter(t => t > Date.now() - 15 * 60000);
  arr.push(Date.now()); failures.set(ip, arr);
  if (arr.length >= 5) {
    lockedUntil.set(ip, Date.now() + 15 * 60000); failures.delete(ip);
    accessLog(ip, 'LOCKOUT', '15 min');
    console.log(`[${C.timeHms()}] LOCKOUT ${ip} (5 буруу оролдлого)`);
  }
}
function getSession(req, ip) {
  // Нэвтрэлтгүй горим (SP-118-04/01 §5): хүсэлт бүр «хэн, ямар үүрэгтэй» гэдгийг толгойгоор (X-AR-Role, X-AR-Name) авч, эрхийг backend шалгана.
  // Нууц үггүй тул баталгаажуулалт биш — дараа SSO холбоход зөвхөн энэ давхарга солигдоно. Сонгоогүй бол «Менежер / хянагч».
  if (!U.loginRequired()) {
    const r = String(req.headers['x-ar-role'] || '');
    const role = ['cae', 'lead_auditor', 'auditor'].includes(r) ? r : 'auditor';   // сонгоогүй бол хамгийн бага эрх (зөвхөн өөрийн тайлан)
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-ar-name'] || '')).replace(/[\t\r\n\x00-\x1f]/g, ' ').trim().slice(0, 40); } catch { name = ''; }
    return { tok: null, user: name ? `name:${name}` : `ip:${ip}`, name: name || ip, role, open: true, chosen: !!r };
  }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const tok = auth.slice(7).trim();
  const s = sessions.get(tok);
  if (!s) return null;
  const now = Date.now();
  if (s.ip !== ip || (SESSION_MINUTES > 0 && (s.last < now - SESSION_MINUTES * 60000 || s.created < now - 8 * 3600000))) { sessions.delete(tok); return null; }
  s.last = now;
  return { tok, ...s };
}
function newSession(ip, fields) {
  const tok = crypto.randomBytes(32).toString('hex');
  sessions.set(tok, { created: Date.now(), last: Date.now(), ip, ...fields });
  return tok;
}
// Эрх нь өөрчлөгдсөн/идэвхгүй болсон хэрэглэгчийн session-уудыг шууд хаана
function dropSessions(user) { for (const [k, s] of sessions) if (s.user === user) sessions.delete(k); }
const meOf = s => ({ open: !!s.open, user: s.user, name: s.name || '', role: s.role, role_label: U.ROLES[s.role] || s.role, must_change: !!s.must_change, setup: !!s.setup,
  perms: Object.keys(U.PERMS).filter(a => U.can(s.role, a)) });
// Аудитор / ахлах аудитор зөвхөн өөрийн үүсгэсэн эсвэл багт нь орсон review-д хандана (баг = root job-ийн team)
function canSeeJob(s, dir) {
  if (U.can(s.role, 'job.viewAll')) return true;
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  if (job.created_by === s.user) return true;
  return WF.isTeam(job.parent_id || path.basename(dir), s.user);
}
// AI-ийн дотоод үр дүнг (санал, verdict, R-тоо, шийдвэр, events, review_report, экспорт) харах эсэх — §5
const seesInternals = s => WF.seesInternals(s, U.can);
// Багийн гишүүн (бэлтгэгч) — өөрийн тайлангийн саналыг шийдвэрлэх, release, finalize хийхгүй (DOC-1917 §9)
const isPreparer = (s, id) => (U.loginRequired() || String(s.user).startsWith('name:')) && WF.isTeam(WF.rootOf(id), s.user);

/* ---------- Job туслах ---------- */
const isJobId = id => /^\d{8}-\d{6}-[a-z0-9]{6}$/.test(id);
const jobDir = id => path.join(P.jobs, id);
let active = null; // { id, ctl, promise }

function jobStatus(dir) {
  const state = C.readJson(path.join(dir, 'state.json'));
  if (state && state.status) {
    if (['extracting', 'running'].includes(state.status) && (!active || active.id !== path.basename(dir))) return 'failed';
    return state.status;
  }
  const job = C.readJson(path.join(dir, 'job.json'));
  return job && job.queued ? 'queued' : job && job.awaiting_ai ? 'pending' : 'draft';
}
function jobFiles(dir) {
  const out = [];
  for (const cat of C.CATEGORIES) {
    const d = path.join(dir, 'input', cat);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) out.push({ category: cat, name: f, size: fs.statSync(path.join(d, f)).size });
  }
  return out;
}
function jobSummary(id) {
  const dir = jobDir(id);
  const job = C.readJson(path.join(dir, 'job.json')) || {};
  const sum = C.readJson(path.join(dir, 'sandbox', 'output', 'review_summary.json'));
  const o = { id, created: job.created, created_by: job.created_by || null, audit: job.audit, status: jobStatus(dir), mask: job.mask };
  if (sum && sum.review) {
    const r = sum.review;
    if (r.r1_count !== undefined) Object.assign(o, { verdict: r.verdict, r1: r.r1_count, r2: r.r2_count, r3: r.r3_count, r4: r.r4_count });
    else {
      // Хуучин review: v2 major/moderate/minor → R1/R2/R3; v1 critical/major/minor → R1/R2/R3
      const v2 = r.moderate_count !== undefined;
      Object.assign(o, { verdict: S.legacyVerdict(r.decision), decision: r.decision, legacy: true,
        r1: v2 ? r.major_count : r.critical_count, r2: v2 ? r.moderate_count : r.major_count, r3: r.minor_count, r4: 0 });
    }
  }
  o.cycle_no = job.parent_id ? (job.round || 1) + 1 : 1;
  if (job.finalized) o.finalized = job.finalized;
  // Ажлын урсгал — гинжийн нэг төлөв (root дээр хадгалагдана)
  if (job.kind === 'precheck') o.precheck = { group: job.precheck_group || id, submitted_as: job.submitted_as || null };
  else try { const w = WF.stateOf(job.parent_id || id); o.workflow = { state: w.state, label: w.label, version: w.version, released: w.released }; } catch { /* ignore */ }
  if (!job.parent_id) o.team = WF.teamOf(id);
  if (job.parent_id) {
    o.parent_id = job.parent_id; o.round = job.round || 1;
    const rc = C.readJson(path.join(dir, 'sandbox', 'output', 'recheck.json'));
    if (rc && Array.isArray(rc.items)) {
      o.recheck = recheckCounts(rc); if (rc.verdict) o.verdict = rc.verdict;
      // Жагсаалтад бүх мөр нэг форматтай байхын тулд: засагдаагүй үлдсэн (хэсэгчлэн / засагдаагүй / шинэ алдаа) + шинэ саналыг R1–R4-өөр
      const prev = new Map((C.readJson(path.join(dir, 'previous_issues.json')) || []).map(x => [x.id, x]));
      const open = { r1: 0, r2: 0, r3: 0, r4: 0 };
      for (const it of rc.items) {
        if (!['PARTIAL', 'NOT_RESOLVED', 'REGRESSED'].includes(S.normRecheckStatus(it.status))) continue;
        const k = S.normSeverity(it.severity || prev.get(it.id)?.severity, 2).toLowerCase(); if (open[k] !== undefined) open[k]++;
      }
      for (const it of rc.new_issues || []) { const k = S.normSeverity(it.severity, 3).toLowerCase(); if (open[k] !== undefined) open[k]++; }
      Object.assign(o, open, { open_counts: true });
      if (!o.verdict) o.verdict = S.computeVerdict({ issues: Object.entries(open).flatMap(([k, n]) => Array(n).fill({ severity: k.toUpperCase() })) });
    }
  }
  o.created_by_name = displayName(job.created_by);
  return o;
}
// Оруулсан хүний нэр: нэрийн хэрэглэгч (users.json) → бүтэн нэр; «Би хэн бэ»-ээр сонгосон нэр; IP бол null (UI tooltip-д IP)
function displayName(by) {
  const s = String(by || '');
  if (!s || s.startsWith('ip:') || s === 'setup') return null;
  if (s.startsWith('name:')) return s.slice(5) || null;
  const u = U.getUser(s);
  return (u && u.name) || s;
}
function recheckCounts(rc) {
  const c = { total: rc.items.length, new: (rc.new_issues || []).length };
  for (const st of S.RECHECK_STATUSES) c[st] = 0;
  for (const it of rc.items) c[S.normRecheckStatus(it.status)]++;
  return c;
}
// Аудитор зөвхөн захирлын зөвшөөрсөн (APPROVED / EDITED) саналыг харна (SP-118-04/01 §5)
function filterForAuditor(dir, text) {
  let f; try { f = JSON.parse(text); } catch { return text; }
  const dec = S.normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {});
  if (Array.isArray(f.issues)) f.issues = f.issues.filter(it => ['APPROVED', 'EDITED'].includes(dec[it.id]?.decision))
    .map(it => dec[it.id].decision === 'EDITED' && dec[it.id].edited_text ? { ...it, required_action: dec[it.id].edited_text } : it);
  delete f.dropped_issues;
  return stripLessons(f);
}
// Захирлын сургамж — AI-ийн дотоод мэдээлэл, аудиторт харуулахгүй
function stripLessons(f) {
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch { return f; } }
  for (const k of ['lessons_applied', 'lessons_used', 'lessons_available']) delete f[k];
  for (const it of f.issues || []) delete it.lesson_refs;
  return JSON.stringify(f);
}
const jobMeta = id => C.readJson(path.join(jobDir(id), 'job.json')) || {};
// Тайлангийн .docx-д үлдсэн «[АУДИТОР БАТАЛГААЖУУЛАХ: …]» тэмдэглэгээ — догол мөрийн дугаараар (P12, T3R2)
function draftMarksIn(reportDir) {
  const out = [];
  if (!fs.existsSync(reportDir)) return out;
  for (const f of fs.readdirSync(reportDir).filter(x => /\.docx$/i.test(x))) {
    try {
      for (const b of convertDocx(fs.readFileSync(path.join(reportDir, f))).blocks) {
        const t = b.kind === 'table' ? (b.rows || []).map((r, i) => [i, r.join(' ')]) : [[null, b.text]];
        for (const [i, s] of t) if (String(s).includes(ED.DRAFT_TAG)) out.push(i == null ? b.id : `${b.id}R${i + 1}`);
      }
    } catch { /* уншигдахгүй файл — бусад шалгалт барина */ }
  }
  return out;
}
// AI-ийн автомат засвар (server/autofix.js) — дуусахад багт мэдэгдэнэ (notify = null бол мэдэгдэхгүй)
function startAutofix(rootId, n, who, audit, notify, force = false) {
  const r = AF.start(rootId, n, who, { force, onDone: s => {
    auditLog('report.autofix', { job: rootId, version: n, state: s.state, fixed: s.fixed, drafts: s.drafts, manual: s.manual, total: s.total, user: who });
    console.log(`[${C.timeHms()}] AUTOFIX ${rootId} v${n} ${s.state} fixed=${s.fixed}/${s.total}${s.error ? ' — ' + s.error : ''}`);
    if (s.state === 'done') HF.report('FIX', `AI захирлын баталсан саналаар тайланд ${s.fixed}/${s.total} засвар (Track Changes) бэлтгэлээ — job ${rootId} v${n}`);
    else if (s.state === 'failed') HF.report('ERROR', 'AI-ийн автомат засвар амжилтгүй боллоо', `job ${rootId} v${n}: ${s.error || ''}`);
    if (notify && s.state === 'done' && s.fixed) NT.send(notify, { kind: 'AUTOFIX', job: rootId, version: n, audit,
      text: `${audit.code || ''} ${audit.branch || ''}: AI ${s.fixed} саналыг тайланд засаж оруулсан${s.drafts ? ` (${s.drafts} ноорог)` : ''}, ${s.manual} нь гараар засах — Track Changes-тэй Word файлыг шалгана уу`.trim() });
  } });
  if (!r.error) auditLog('report.autofix.start', { job: rootId, version: n, total: r.total, user: who });
  return r;
}
function listJobIds() { return fs.readdirSync(P.jobs).filter(isJobId).sort(); }

function removeJob(dir) { clearWorkFiles(dir); C.rmrf(dir); }

/* ---------- Өөрөө шалгах (2026-10-21) ----------
  Аудитор захиралд илгээхээсээ өмнө бүрэн AI хяналтыг өөрөө ажиллуулж, бүх саналыг шууд харна (засаад дахин шалгаж болно).
  Тусдаа job (kind: 'precheck') — ажлын урсгал, хувилбарын гинжид ордоггүй; нэг тайлангийн шалгалтууд = precheck_group.
  Илгээхэд шинэ job нь precheck_group-ийг авч, шалгалтууд submitted_as = <root> болно → захирал тайлан дээрээ харна. */
const isPrecheck = id => jobMeta(id).kind === 'precheck';
const precheckGroup = g => g ? listJobIds().filter(x => { const j = jobMeta(x); return j.kind === 'precheck' && j.precheck_group === g; }) : [];
const prechecksRan = g => precheckGroup(g).filter(x => jobStatus(jobDir(x)) !== 'draft');
function precheckRow(x) {
  const s = jobSummary(x);
  return { id: x, created: s.created, created_by: s.created_by, created_by_name: s.created_by_name, status: s.status, verdict: s.verdict, r1: s.r1, r2: s.r2, r3: s.r3, r4: s.r4 };
}
// Илгээх / дахин шалгахад холбох шалгалт: харах эрхтэй, илгээгдээгүй precheck байх ёстой
function precheckLink(session, raw) {
  const pid = String(raw || '');
  if (!isJobId(pid) || !fs.existsSync(jobDir(pid)) || !canSeeJob(session, jobDir(pid))) return { error: 'Өөрөө шалгасан тайлан олдсонгүй', code: 404 };
  const j = jobMeta(pid);
  if (j.kind !== 'precheck') return { error: 'Энэ нь өөрөө шалгасан тайлан биш', code: 400 };
  if (j.submitted_as) return { error: 'Энэ шалгалтын тайлан аль хэдийн захиралд илгээгдсэн', code: 409 };
  return { id: pid, job: j, group: j.precheck_group || pid };
}
// Оруулаагүй ангиллын файлыг (жишээ нь өөрчлөгдөөгүй Excel, хөтөлбөр) өмнөх шалгалтын эх файлаас хуулна
function copyMissingFrom(srcId, dir) {
  if (!srcId) return;
  const have = new Set(jobFiles(dir).map(f => f.category));
  for (const it of ORIG.list(jobDir(srcId)).filter(x => !have.has(x.cat))) {
    const f = ORIG.fileOf(jobDir(srcId), it.cat, it.name);
    if (f) { fs.mkdirSync(path.join(dir, 'input', it.cat), { recursive: true }); fs.copyFileSync(f.path, path.join(dir, 'input', it.cat, it.name)); }
  }
}
// Тасарсан AI-г дахин эхлүүлэхэд: эх файлыг originals/-аас input/ руу сэргээнэ
function restoreInputs(dir) {
  for (const it of ORIG.list(dir)) {
    const src = ORIG.fileOf(dir, it.cat, it.name), dest = path.join(dir, 'input', it.cat, it.name);
    if (src && !fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src.path, dest); }
  }
}

function startNext() {
  if (active || HF.paused()) return;   // Hefesto-ийн админ агентыг түр зогсоосон бол шинэ хяналт эхлүүлэхгүй
  const next = listJobIds().find(id => jobStatus(jobDir(id)) === 'queued');
  if (!next) return;
  const dir = jobDir(next);
  C.writeJson(path.join(dir, 'state.json'), { status: 'extracting', pid: process.pid, started: C.nowIso() });
  const ctl = { children: new Set() };
  active = { id: next, ctl };
  console.log(`[${C.timeHms()}] START ${next}`);
  const pc = jobMeta(next).kind === 'precheck';
  HF.setActivity(pc ? 'Аудиторын өөрөө шалгах хүсэлтээр тайланг AI-аар хянаж байна' : 'Салбарын аудитын тайланг AI-аар хянаж байна');
  active.promise = runJob(dir, ctl).catch(e => console.error('runJob:', e)).finally(() => {
    console.log(`[${C.timeHms()}] END   ${next} (${jobStatus(dir)})`);
    HF.setActivity('');
    const fin = jobStatus(dir);
    if (fin === 'done') HF.report('ANALYSIS', `Аудитын тайлангийн AI хяналт дууслаа${pc ? ' (өөрөө шалгах)' : ''} — job ${next}`);
    else if (fin === 'failed') HF.report('ERROR', 'Аудитын тайлангийн AI хяналт амжилтгүй боллоо', `job ${next}: ${(C.readJson(path.join(dir, 'state.json')) || {}).error || ''}`);
    try { WF.sync(WF.rootOf(next)); } catch (e) { console.error('workflow sync:', e.message); }   // AI дуусав → CAE_REVIEW
    const jn = jobMeta(next);
    if (jn.kind === 'precheck') {
      const st = jobStatus(dir), au = jn.audit || {};
      NT.send(WF.teamOf(next), { kind: 'PRECHECK', job: next, audit: au,
        text: `${[au.code, au.branch].filter(Boolean).join(' ')}: өөрөө шалгасан AI хяналт ${st === 'done' ? 'дууслаа — засах зүйлсээ харна уу' : 'тасарлаа — дахин эхлүүлнэ үү'}`.trim() });
    }
    active = null; setImmediate(startNext);
  });
}

// Өдөр бүр hash-chain шалгалт (SP-118-04/03 §6) — эвдэрвэл консол, хандалтын логт сэрэмжлүүлэг
let lastChainCheck = 0;
function chainCheck() {
  if (Date.now() - lastChainCheck < 24 * 3600000) return;
  lastChainCheck = Date.now();
  for (const k of ['ai', 'audit']) {
    const r = AL.verifyChain(k);
    if (!r.ok) { console.error(`[${C.timeHms()}] АНХААР: ${k} логийн hash-chain эвдэрсэн (мөр ${r.broken_at}: ${r.reason})`); accessLog('system', 'LOG_CHAIN_BROKEN', `${k} line=${r.broken_at}`); }
  }
}

function housekeeping() {
  chainCheck();
  for (const id of listJobIds()) {
    const dir = jobDir(id), status = jobStatus(dir);
    if (['done', 'failed', 'cancelled'].includes(status)) clearWorkFiles(dir);
    // PDF үүсгэхэд үлдсэн түр хавтас (export-*)
    for (const f of fs.readdirSync(dir)) if (/^export-[0-9a-f]+$/.test(f)) {
      try { if (fs.statSync(path.join(dir, f)).mtimeMs < Date.now() - 10 * 60000) C.rmrf(path.join(dir, f)); } catch { /* ignore */ }
    }
    const job = C.readJson(path.join(dir, 'job.json'));
    const created = job && job.created ? new Date(job.created) : fs.statSync(dir).birthtime;
    // Хувилбар устгагдахгүй: эцэслэн батлагдаагүй, идэвхтэй урсгалтай гинжийг автомат устгалаас чөлөөлнө (§6)
    let wfActive = false;
    // Өөрөө шалгасан job: илгээгдсэн бол тухайн тайлангийн урсгалаар, илгээгээгүй бол энгийн хугацаагаар
    const wfRoot = job && job.kind === 'precheck' ? job.submitted_as : WF.rootOf(id);
    try { wfActive = !!wfRoot && ['SUBMITTED', 'CAE_REVIEW', 'RETURNED', 'RESUBMITTED'].includes(WF.stateOf(wfRoot).state); } catch { /* ignore */ }
    if (!wfActive && !['extracting', 'running'].includes(status) && created < Date.now() - RETENTION_DAYS * 86400000) {
      removeJob(dir); accessLog('system', 'RETENTION_DELETE', id);
      console.log(`[${C.timeHms()}] ${RETENTION_DAYS} хоног хэтэрсэн review устгагдлаа: ${id}`);
    }
  }
  if (SESSION_MINUTES > 0) for (const [k, s] of sessions) if (s.last < Date.now() - SESSION_MINUTES * 60000) sessions.delete(k);
  for (const [k, t] of pdfTickets) if (t.exp < Date.now()) pdfTickets.delete(k);
}

/* ---------- Routes ---------- */
async function handle(req, res) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const url = new URL(req.url, 'http://x');
  // /api/v1/… — хувилбартай гэрээ (SP-118-04/03 §3). Одоогоор /api/…-тай ижил; гаднын систем үргэлж /api/v1-ийг ашиглана.
  let p = decodeURIComponent(url.pathname); const m = req.method;
  if (p.startsWith('/api/v1/')) p = '/api/' + p.slice(8);

  // Host header шалгалт
  const hostHdr = String(req.headers.host || '').toLowerCase();
  const hostOnly = hostHdr.startsWith('[') ? hostHdr.slice(0, hostHdr.indexOf(']') + 1) : hostHdr.split(':')[0];
  if (!allowedHosts.has(hostOnly)) return sendErr(res, 403, 'Host not allowed');

  if (m === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(P.web, 'index.html')));
  // Шалгуурын PDF — шинэ таб нээхэд Authorization header явуулах боломжгүй тул 5 минутын, IP-д уясан тасалбараар
  const pm = m === 'GET' && p.match(/^\/pdf\/([A-Za-z0-9_-]{24})$/);
  if (pm) {
    const tk = pdfTickets.get(pm[1]);
    if (!tk || tk.ip !== ip || tk.exp < Date.now()) return sendErr(res, 404, 'Холбоосын хугацаа дууссан — дахин дарна уу');
    const { 'Content-Security-Policy': _csp, ...h } = SEC_HEADERS;   // PDF viewer CSP-д хаагддаг
    const buf = fs.readFileSync(CR.pdfPath(tk.id));
    res.writeHead(200, { ...h, 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Content-Disposition': `inline; filename="${tk.id}.pdf"` });
    return res.end(buf);
  }
  if (!p.startsWith('/api/')) return sendErr(res, 404, 'Not found');

  // Cross-site хүсэлтийг хаах
  const origin = req.headers.origin;
  if (origin && origin.replace(/^https?:\/\//, '').toLowerCase() !== hostHdr) return sendErr(res, 403, 'Cross-origin request blocked');

  // Нэвтрэх хэлбэр: admin бүртгэгдээгүй бол «анхны тохиргоо» (нийтийн кодоор)
  if (m === 'GET' && p === '/api/auth-mode') return sendJson(res, 200, { setup: U.loginRequired() && !U.hasAdmin(), open: !U.loginRequired() });

  if (m === 'POST' && p === '/api/login') {
    if (isLocked(ip)) return sendErr(res, 429, 'Олон удаа буруу оролдсон тул 15 минут түгжигдлээ');
    const body = await readJsonBody(req);
    const fail = async (who, msg) => {
      registerFailure(ip); accessLog(ip, 'LOGIN_FAIL', '', who);
      await new Promise(r => setTimeout(r, 800));
      return sendErr(res, 401, msg);
    };
    if (body.code !== undefined) {
      // Нийтийн код зөвхөн анхны admin-ыг үүсгэхэд
      if (U.hasAdmin()) return sendErr(res, 410, 'Нийтийн кодоор нэвтрэх боломжгүй болсон. Нэвтрэх нэр, нууц үгээ ашиглана уу.');
      if (!sameCode(body.code)) return fail('setup', 'Нэвтрэх код буруу');
      const tok = newSession(ip, { user: 'setup', role: 'setup', setup: true });
      accessLog(ip, 'SETUP_LOGIN', '', 'setup');
      return sendJson(res, 200, { token: tok, session_minutes: SESSION_MINUTES, setup: true });
    }
    const user = U.authenticate(body.username, body.password);
    if (!user) return fail(U.normUser(body.username).slice(0, 40) || '-', 'Нэвтрэх нэр эсвэл нууц үг буруу');
    const tok = newSession(ip, { user: user.username, name: user.name, role: user.role, must_change: user.must_change });
    accessLog(ip, 'LOGIN_OK', user.role, user.username);
    return sendJson(res, 200, { token: tok, session_minutes: SESSION_MINUTES, ...meOf({ ...user, user: user.username }) });
  }

  const session = getSession(req, ip);
  if (!session) return sendErr(res, 401, 'Нэвтрэх шаардлагатай');
  const who = session.user;
  const log = (action, detail = '') => accessLog(ip, action, detail, who);
  const deny = () => sendErr(res, 403, 'Танд энэ үйлдлийн эрх байхгүй');

  if (m === 'POST' && p === '/api/logout') { sessions.delete(session.tok); log('LOGOUT'); return sendJson(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/api/me') {
    const u = session.setup ? null : U.getUser(who);
    return sendJson(res, 200, { ...meOf(session), ...(u ? { created: u.created, prev_login: u.prev_login, password_changed: u.password_changed } : {}) });
  }

  // Анхны admin үүсгэх (зөвхөн setup session)
  if (m === 'POST' && p === '/api/setup') {
    if (!session.setup || U.hasAdmin()) return deny();
    const body = await readJsonBody(req);
    try { U.addUser({ username: body.username, role: 'admin', name: body.name || '', password: body.password, by: 'setup' }); } catch (e) { return sendErr(res, 400, e.message); }
    const user = U.getUser(body.username);
    sessions.delete(session.tok);
    const tok = newSession(ip, { user: user.username, name: user.name, role: 'admin', must_change: false });
    accessLog(ip, 'SETUP_ADMIN_CREATED', user.username, user.username);
    return sendJson(res, 200, { token: tok, session_minutes: SESSION_MINUTES, ...meOf({ ...user, user: user.username }) });
  }
  if (session.setup) return sendErr(res, 403, 'Эхлээд admin хэрэглэгч үүсгэнэ үү');

  if (m === 'POST' && p === '/api/me/password') {
    const body = await readJsonBody(req);
    try { U.changePassword(who, body.old_password, body.new_password); } catch (e) { log('PASSWORD_CHANGE_FAIL'); return sendErr(res, 400, e.message); }
    dropSessions(who);
    const tok = newSession(ip, { user: who, name: session.name, role: session.role, must_change: false });
    log('PASSWORD_CHANGED');
    return sendJson(res, 200, { token: tok, ...meOf({ ...session, must_change: false }) });
  }
  // Түр нууц үгтэй бол эхлээд солиулна
  if (session.must_change) return sendErr(res, 403, 'Түр нууц үгээ эхлээд солино уу');

  // Нэвтрэлтийн горим. Асаах нь хамгаалалтыг нэмэгдүүлдэг тул нэвтрэлтгүй горимд ч зөвшөөрнө (бүртгэлтэй admin байх ёстой);
  // унтраах нь зөвхөн нууц үгээр нэвтэрсэн admin.
  if (m === 'GET' && p === '/api/auth/settings') return sendJson(res, 200, { login_required: U.loginRequired(), admins: U.list().filter(u => u.role === 'admin' && !u.disabled).length });
  if (m === 'POST' && p === '/api/auth/login-required') {
    const body = await readJsonBody(req);
    const on = body.on === true;
    if (on) {
      if (!U.hasAdmin()) return sendErr(res, 409, 'Идэвхтэй admin бүртгэлгүй — серверийн компьютер дээр `node server/users.js add <нэр> admin` гэж эхлээд admin үүсгэнэ үү');
    } else if (session.open || !U.can(session.role, 'users.manage')) return deny();
    U.setLoginRequired(on);
    log('LOGIN_REQUIRED', on ? 'on' : 'off');
    auditLog('auth.login_required', { on, user: who, role: session.role });
    if (on) sessions.clear();
    return sendJson(res, 200, { ok: true, login_required: on });
  }

  // Хэрэглэгч удирдах (admin)
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!U.can(session.role, 'users.manage')) return deny();
    if (m === 'GET' && p === '/api/users') return sendJson(res, 200, { users: U.list(), roles: U.ROLES });
    if (m === 'POST' && p === '/api/users') {
      const body = await readJsonBody(req);
      if (!body.password) return sendErr(res, 400, 'Нууц үгийг оруулна уу');
      let r; try { r = U.addUser({ username: body.username, role: body.role, name: body.name || '', password: String(body.password), by: who }); } catch (e) { return sendErr(res, 400, e.message); }
      log('USER_ADD', `${r.username} role=${body.role}`);
      return sendJson(res, 201, r);
    }
    const um = p.match(/^\/api\/users\/([^/]+)$/);
    if (m === 'PATCH' && um) {
      const body = await readJsonBody(req);
      const patch = {};
      for (const k of ['role', 'disabled', 'name', 'password']) if (body[k] !== undefined) patch[k] = k === 'password' ? String(body[k]) : body[k];
      // Нэвтрэх нэр солих: бүртгэл + тайлангийн эзэмшил (created_by, team, submitted_by)-ийг шинэ нэр рүү. Логийг өөрчлөхгүй (DOC-1917).
      let target = um[1];
      if (body.username !== undefined && U.normUser(body.username) !== U.normUser(um[1])) {
        let rn; try { rn = U.renameUser(um[1], body.username, who); } catch (e) { return sendErr(res, 400, e.message); }
        let moved = 0;
        for (const jid of listJobIds()) {
          const f = path.join(jobDir(jid), 'job.json'), jj = C.readJson(f);
          if (!jj) continue;
          let ch = false;
          if (jj.created_by === rn.from) { jj.created_by = rn.username; ch = true; }
          if (jj.submitted_by === rn.from) { jj.submitted_by = rn.username; ch = true; }
          if (Array.isArray(jj.team) && jj.team.includes(rn.from)) { jj.team = jj.team.map(x => x === rn.from ? rn.username : x); ch = true; }
          if (ch) { C.writeJson(f, jj); moved++; }
        }
        dropSessions(rn.from);
        auditLog('user.rename', { from: rn.from, to: rn.username, jobs_updated: moved, user: who, role: session.role });
        log('USER_RENAME', `${rn.from} -> ${rn.username} jobs=${moved}`);
        target = rn.username;
      }
      let r; try { r = U.updateUser(target, patch, who); } catch (e) { return sendErr(res, 400, e.message); }
      if (patch.role !== undefined || patch.disabled || patch.password !== undefined) dropSessions(r.username);
      log('USER_UPDATE', `${r.username} ${Object.entries(patch).map(([k, v]) => `${k}=${k === 'password' ? 'set' : v}`).join(' ')}`);
      return sendJson(res, 200, r);
    }
    return sendErr(res, 404, 'Not found');
  }

  // API гэрээ (OpenAPI 3.1) — docs/openapi.yaml
  if (m === 'GET' && p === '/api/openapi.yaml') return send(res, 200, 'application/yaml; charset=utf-8', fs.readFileSync(path.join(P.root, 'docs', 'openapi.yaml')));
  // SP-118-04/03 §9: api, rulepack, prompt, model хувилбар
  if (m === 'GET' && p === '/api/version') {
    const last = AL.readAll('ai', { limit: 50 }).reverse().find(r => r.type === 'AI_RUN');   // AI_RUN_ABORTED-д model байхгүй
    return sendJson(res, 200, { api: S.API_VERSION, schema: S.SCHEMA_VERSION, rulepack: S.RULEPACK, prompt_template_id: S.PROMPT_TEMPLATE_ID,
      recheck_template_id: S.RECHECK_TEMPLATE_ID, last_model: last?.model || null, node: process.version });
  }
  // Follow-up эх сурвалж (RPT-175): харах, шинэ хувилбар оруулах, салбарын зөвлөмжийн тоо
  if (p === '/api/followup' || p === '/api/followup/unit') {
    if (m === 'GET' && p === '/api/followup/unit') {
      const d = FUP.current(); if (!d) return sendJson(res, 200, { available: false });
      const it = FUP.forUnit(d, { branch: url.searchParams.get('branch') || '' });
      return sendJson(res, 200, { available: true, source: d.meta.file, as_of: (d.meta.file_modified || '').slice(0, 10), count: it.length,
        findings: new Set(it.map(x => x.iss_id + '|' + x.title)).size, open: it.filter(x => FUP.OPEN.has(x.status)).length, overdue: it.filter(x => x.overdue_days > 0).length });
    }
    if (m === 'GET') {
      if (!U.can(session.role, 'issue.viewAll')) return deny();
      const d = FUP.current();
      return sendJson(res, 200, d ? { available: true, meta: d.meta, quality: d.quality, items: d.items.map(({ condition, criteria, cause, effect, mgmt_action, ...x }) => x) } : { available: false });
    }
    if (m === 'POST' && p === '/api/followup') {
      if (!U.can(session.role, 'issue.decide')) return deny();
      const name = safeName(url.searchParams.get('name')), ext = path.extname(name).toLowerCase();
      if (!['.xlsx', '.xlsm'].includes(ext)) return sendErr(res, 400, 'RPT-175-г .xlsx эсвэл .xlsm хэлбэрээр оруулна уу');
      const tmp = path.join(P.jobs, '_detect', C.randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789') + ext);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      try {
        fs.writeFileSync(tmp, await readBody(req, MAX_UPLOAD_MB * 1024 * 1024));
        if (!magicOk(tmp, ext)) return sendErr(res, 400, 'Файлын агуулга Excel биш байна');
        const r = FUP.importFile(tmp, { name, by: who });
        log('FOLLOWUP_IMPORT', `${name} items=${r.meta.count}`);
        auditLog('followup.import', { file: name, items: r.meta.count, open: r.meta.open, user: who, role: session.role });
        return sendJson(res, 200, { ok: true, meta: r.meta, quality: r.quality.length });
      } catch (e) { return sendErr(res, 400, e.message); } finally { C.rmrf(tmp); }
    }
  }
  // «Стандарт, баримт» хуудас: модуль, шалгуур, баримтын сан, дүрмийн файл, хувилбар
  if (m === 'GET' && p === '/api/library') { log('LIBRARY_VIEW'); return sendJson(res, 200, LIB.library()); }
  const lm = m === 'GET' && p.match(/^\/api\/library\/rules\/([a-z_]{3,30})$/);
  if (lm) {
    const t = LIB.ruleText(lm[1]);
    return t === null ? sendErr(res, 404, 'Not found') : send(res, 200, 'text/markdown; charset=utf-8', t);
  }
  // Google Drive холболт (admin): нэг дансны унших эрхээр хувийн Drive линкийг татах
  if (p === '/api/gdrive' || p.startsWith('/api/gdrive/')) {
    if (!U.can(session.role, 'users.manage')) return deny();
    try {
      if (m === 'GET' && p === '/api/gdrive') return sendJson(res, 200, GD.status());
      if (m === 'POST' && p === '/api/gdrive/start') { const b = await readJsonBody(req); return sendJson(res, 200, { url: GD.start(b.client_id, b.client_secret) }); }
      if (m === 'POST' && p === '/api/gdrive/finish') {
        const b = await readJsonBody(req), st = await GD.finish(b.url, who);
        log('GDRIVE_CONNECT', st.email); auditLog('GDRIVE_CONNECT', { by: who, account: st.email });
        return sendJson(res, 200, st);
      }
      if (m === 'DELETE' && p === '/api/gdrive') {
        const was = GD.status().email; await GD.disconnect();
        log('GDRIVE_DISCONNECT', was); auditLog('GDRIVE_DISCONNECT', { by: who, account: was });
        return sendJson(res, 200, GD.status());
      }
    } catch (e) { return sendErr(res, 400, e.message); }
    return sendErr(res, 404, 'Not found');
  }
  // Лог (AI Run, шийдвэр) + hash-chain бүрэн бүтэн байдал
  if (m === 'GET' && p === '/api/logs') {
    if (!U.can(session.role, 'logs.view')) return deny();
    const type = url.searchParams.get('type') === 'audit' ? 'audit' : 'ai';
    log('LOG_VIEW', type);
    return sendJson(res, 200, { type, integrity: AL.verifyChain(type), entries: AL.readAll(type, { limit: Math.min(Number(url.searchParams.get('limit')) || 200, 2000) }).reverse() });
  }
  if (m === 'GET' && p === '/api/security') return sendJson(res, 200, { network: LAN ? 'lan-https' : 'localhost', efs: EFS_ON, retention_days: RETENTION_DAYS, session_minutes: SESSION_MINUTES, max_upload_mb: MAX_UPLOAD_MB });
  // Шалгуурын баримт (DOC-19xx, ДАГ аргачлал): ?sec=§5.2 → тухайн хэсэг
  const cm = p.match(/^\/api\/criteria\/([A-Z]{2,4}(?:-(?:\d{4}|\d{2}|TR))?)(\/pdf)?$/);
  if (cm) {
    const doc = CR.load(cm[1]);
    if (!doc) return sendErr(res, 404, 'Баримт олдсонгүй');
    if (m === 'GET' && !cm[2]) return sendJson(res, 200, { id: doc.id, title: doc.title, pages: doc.pages, has_text: doc.has_text, has_pdf: !!CR.pdfPath(doc.id), blocks: doc.blocks, hit: CR.find(doc, url.searchParams.get('sec')) });
    if (m === 'POST' && cm[2]) {
      if (!CR.pdfPath(doc.id)) return sendErr(res, 404, 'PDF олдсонгүй');
      const t = crypto.randomBytes(18).toString('base64url');
      pdfTickets.set(t, { id: doc.id, ip, exp: Date.now() + 5 * 60000 });
      return sendJson(res, 200, { url: `/pdf/${t}` });
    }
  }
  if (m === 'GET' && p === '/api/jobs') {
    const internal = seesInternals(session);
    const ids = listJobIds().reverse().filter(id => canSeeJob(session, jobDir(id)));
    // Өөрөө шалгасан job-ууд тайлангийн жагсаалтад орохгүй; захиралд илгээгээгүйг нь тусад нь (илгээсэн нь тайлан дээрээ харагдана)
    const pcs = ids.filter(isPrecheck);
    return sendJson(res, 200, { jobs: ids.filter(id => !pcs.includes(id)).map(jobSummary).map(o => internal ? o : WF.restrictJob(o)),
      prechecks: pcs.filter(id => !jobMeta(id).submitted_as).map(jobSummary) });
  }

  // Мэдэгдэл (вэб хонх)
  if (m === 'GET' && p === '/api/notifications') return sendJson(res, 200, NT.forUser(who));
  if (m === 'POST' && p === '/api/notifications/read') {
    const body = await readJsonBody(req);
    NT.markRead(who, body.all ? 'all' : (Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : []));
    return sendJson(res, 200, NT.forUser(who));
  }
  // Багийн гишүүн сонгох жагсаалт (зөвхөн аудитор, ахлах аудитор — нэр, role)
  if (m === 'GET' && p === '/api/team-candidates') {
    if (!U.can(session.role, 'job.create')) return deny();
    return sendJson(res, 200, { users: U.list().filter(u => !u.disabled && ['auditor', 'lead_auditor'].includes(u.role)).map(u => ({ username: u.username, name: u.name, role: u.role, role_label: u.role_label })) });
  }

  // Тайлангийн нүүрээс аудитын мэдээлэл таних (файл эсвэл линк). Файлыг шифрлэгдсэн jobs\_detect-д түр хадгалаад тэр дор нь устгана.
  if (m === 'POST' && (p === '/api/detect-meta' || p === '/api/detect-meta-url')) {
    if (!U.can(session.role, 'job.create')) return deny();
    const tmpDir = path.join(P.jobs, '_detect');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, C.randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789'));
    let file = null, ext = '', host = '', via = '';
    try {
      if (p === '/api/detect-meta') {
        ext = path.extname(safeName(url.searchParams.get('name'))).toLowerCase();
        if (!['.docx', '.pdf'].includes(ext)) return sendJson(res, 200, { meta: {} });
        const buf = await readBody(req, MAX_UPLOAD_MB * 1024 * 1024);
        file = tmp + ext; fs.writeFileSync(file, buf);
      } else {
        const body = await readJsonBody(req);
        try { host = new URL(String(body.url)).hostname; } catch {}
        const got = await FU.download(String(body.url || ''), { maxBytes: MAX_UPLOAD_MB * 1024 * 1024, destFn: raw => { ext = path.extname(safeName(raw)).toLowerCase(); return { name: raw, path: tmp + ext }; } });
        file = got.path; via = got.via;
        if (!['.docx', '.pdf'].includes(ext)) return sendJson(res, 200, { meta: {} });
      }
      if (!magicOk(file, ext)) return sendJson(res, 200, { meta: {} });
      const meta = detectFile(file, ext, fs.readFileSync(file));
      log('DETECT_META', `${host || 'upload'}${via === 'drive' ? ' (drive)' : ''} fields=${Object.keys(meta).join(',') || '-'}`);
      return sendJson(res, 200, { meta });
    } catch (e) {
      return sendErr(res, 400, e.message);
    } finally { if (file) C.rmrf(file); }
  }

  if (m === 'POST' && p === '/api/jobs') {
    if (!U.can(session.role, 'job.create')) return deny();
    const body = await readJsonBody(req);
    const id = C.nowIso().replace(/[-:]/g, '').replace('T', '-') + '-' + C.randomString(6, 'abcdefghijklmnopqrstuvwxyz0123456789');
    // Засварласан хувилбарыг дахин шалгах: үргэлж анхны (root) review-тэй холбоно
    let parent = null;
    if (body.parent_id) {
      const pid = String(body.parent_id);
      if (!isJobId(pid) || !fs.existsSync(jobDir(pid)) || !canSeeJob(session, jobDir(pid))) return sendErr(res, 404, 'Анхны review олдсонгүй');
      const rootId = jobMeta(pid).parent_id || pid;
      if (jobMeta(rootId).finalized) return sendErr(res, 409, `Тайлан эцэслэн батлагдсан (${jobMeta(rootId).finalized.reg_no}) тул дахин засвар оруулах боломжгүй`);
      if (!fs.existsSync(path.join(jobDir(rootId), 'sandbox', 'output', 'review_findings.json'))) return sendErr(res, 409, 'Анхны review дуусаагүй эсвэл үр дүнгүй байна');
      // Засварласан хувилбарыг зөвхөн захирал feedback буцаасны дараа (RETURNED), эсвэл өмнөх засвар тасарсан үед оруулна
      const wf = WF.stateOf(rootId);
      const retry = wf.state === 'RESUBMITTED' && ['failed', 'cancelled'].includes(wf.latest_ai);
      if (wf.state !== 'RETURNED' && !retry) return sendErr(res, 409, `Төлөв «${wf.label}» — захирал feedback буцаасны дараа л засварласан хувилбар оруулна`);
      if (!WF.isTeam(rootId, who) && !U.can(session.role, 'job.cancelAny')) return sendErr(res, 403, 'Зөвхөн тайлангийн багийн гишүүн засварласан хувилбар оруулна');
      // Өмнө нь оруулаад эхлүүлээгүй засварын ноорог байвал түүнийг ашиглана
      const draftKid = WF.chain(rootId).find(x => x !== rootId && WF.aiStatus(x) === 'draft');
      if (draftKid) return sendJson(res, 200, { id: draftKid, existing: true });
      const round = listJobIds().filter(x => jobMeta(x).parent_id === rootId).length + 1;
      parent = { id: rootId, round, job: jobMeta(rootId) };
    }
    // Өөрөө шалгах: precheck = шинэ шалгалт (precheck_prev = өмнөх шалгалтын цуврал үргэлжлүүлэх); precheck_id = шалгасан тайланг захиралд илгээх
    let pcGroup = null, pcPrev = null;
    if ((body.precheck || body.precheck_id) && body.parent_id) return sendErr(res, 400, 'Өөрөө шалгах нь зөвхөн анхны илгээлтэд');
    if (body.precheck_prev || body.precheck_id) {
      pcPrev = precheckLink(session, body.precheck_prev || body.precheck_id);
      if (pcPrev.error) return sendErr(res, pcPrev.code, pcPrev.error);
      pcGroup = pcPrev.group;
    }
    if (body.precheck && pcGroup && prechecksRan(pcGroup).length >= PRECHECK_MAX)
      return sendErr(res, 409, `Өөрөө шалгах дээд тоо (${PRECHECK_MAX} удаа) хүрсэн — тайлангаа захиралд илгээнэ үү`);
    const dir = jobDir(id);
    for (const cat of C.CATEGORIES) fs.mkdirSync(path.join(dir, 'input', cat), { recursive: true });
    const audit = {};
    for (const k of ['name', 'code', 'branch', 'objective', 'period', 'fieldwork', 'report_date', 'notes']) audit[k] = body[k] ? String(body[k]).slice(0, 2000) : (parent?.job.audit?.[k] || '');
    // Цэвэрлэх: илүү зай, хашилтын доторх зай, ганцаар үлдсэн хашилт (жишээ «“ ЭРДЭНЭТ”» → «“ЭРДЭНЭТ”»)
    for (const k of ['name', 'code', 'branch']) audit[k] = C.normTitle(audit[k]);
    audit.code = audit.code.toUpperCase();
    if (audit.branch === '__other') audit.branch = '';
    // Салбар заавал биш (бүх салбарыг хамарсан аудит, 2026-10-26)
    if (!parent && !audit.code) { C.rmrf(jobDir(id)); return sendErr(res, 400, 'Аудитын дугаарыг заавал бөглөнө үү'); }
    // Дахин шалгалт анхныхтай ижил далдлалттай байна (token-ууд тохирох ёстой)
    const mask = parent ? parent.job.mask !== false : body.mask !== false, sendImages = body.send_images === true; // анхдагчаар далдална, зураг илгээхгүй
    // Баг (зөвхөн анхны хүсэлтэд): аудитор / ахлах аудитор role-той идэвхтэй хэрэглэгчид
    const okTeam = new Set(U.list().filter(u => !u.disabled && ['auditor', 'lead_auditor'].includes(u.role)).map(u => u.username));
    let team = parent ? undefined : [...new Set((Array.isArray(body.team) ? body.team : []).map(x => U.normUser(x)).filter(x => okTeam.has(x) && x !== who))].slice(0, 20);
    // Өмнөх шалгалтын баг (шалгасан хүн өөр бол түүнийг ч) өвлөнө — бүгд шалгалтын үр дүнгээ харсаар байна
    if (pcPrev) team = [...new Set([...team, ...WF.teamOf(pcPrev.id)])].filter(x => x !== who).slice(0, 20);
    C.writeJson(path.join(dir, 'job.json'), { id, created: C.nowIso(), created_by: who, audit, queued: false, mask, send_images: sendImages,
      ...(parent ? { parent_id: parent.id, round: parent.round } : { team }),
      ...(body.precheck ? { kind: 'precheck', precheck_group: pcGroup || id } : pcGroup ? { precheck_group: pcGroup } : {}) });
    log('JOB_CREATE', `${id} mask=${mask} images=${sendImages}${parent ? ` recheck_of=${parent.id} round=${parent.round}` : ''}${body.precheck ? ` precheck group=${pcGroup || id}` : pcGroup ? ` from_precheck=${pcGroup}` : ''}`);
    return sendJson(res, 201, { id });
  }

  const jm = p.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
  if (jm) {
    const id = jm[1], rest = jm[2] || '';
    if (!isJobId(id)) return sendErr(res, 400, 'Invalid job id');
    const dir = jobDir(id);
    if (!fs.existsSync(dir) || !canSeeJob(session, dir)) return sendErr(res, 404, 'Job not found');
    const status = jobStatus(dir);
    const isOwner = (C.readJson(path.join(dir, 'job.json')) || {}).created_by === who;
    const rootId = WF.rootOf(id), inTeam = WF.isTeam(rootId, who), jobM = jobMeta(id), isPc = jobM.kind === 'precheck';
    // Өөрөө шалгасан job-ийн бүх үр дүнг баг (аудитор) өөрөө харна — захирлын шүүлтгүй
    const internal = seesInternals(session) || (isPc && (isOwner || inTeam));
    // §5: AI-ийн дотоод үр дүнд хандах бүх замыг нэг газар хаана (UI-д нуух хангалтгүй)
    // Үл хамаарах: feedback илгээгдсэн хувилбарын тайлангийн бичвэр (/document) — аудитор саналыг өөрийн тайлан дээр харна.
    // Бичвэр нь аудиторын өөрийн тайлан (AI-ийн үр дүн биш); илгээхээс өмнө хаалттай хэвээр.
    const fbDoc = !internal && m === 'GET' && rest === '/document' && WF.releasedVersions(rootId).some(n => WF.versions(rootId)[n - 1] === id);
    if (!internal && !fbDoc && /^\/(output|export|document|sources|previous|docs-prep|diff|decisions|comments)(\/|$)/.test(rest)) return deny();

    if (m === 'GET' && !rest) {
      const o = jobSummary(id);
      const job = C.readJson(path.join(dir, 'job.json')) || {};
      const state = C.readJson(path.join(dir, 'state.json')) || {};
      Object.assign(o, {
        files: job.files || jobFiles(dir), send_images: job.send_images,
        started: state.started, finished: state.finished,
        error: state.error || (status === 'failed' ? 'Процесс тасарсан (сервер дахин эхэлсэн байж магадгүй)' : undefined),
        mask_summary: C.readJson(path.join(dir, 'mask_summary.json')),
        outputs: C.OUTPUT_FILES.filter(f => fs.existsSync(path.join(dir, 'sandbox', 'output', f))),
        inputs_purged: !fs.existsSync(path.join(dir, 'input')),
        originals: ORIG.list(dir).length,
        has_document: fs.existsSync(path.join(dir, 'doc.json')),
      });
      o.decisions = S.normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {});
      const wfs = WF.stateOf(rootId);
      o.workflow = { state: wfs.state, label: wfs.label, version: wfs.version, released: wfs.released, history: wfs.history, latest: wfs.latest };
      o.cycle_warning = wfs.version > 3;
      o.team = WF.teamOf(rootId).filter(u => !/^ip:/.test(u)).map(u => u.replace(/^name:/, '')); o.root_id = rootId;
      o.version_no = WF.versions(rootId).indexOf(id) + 1 || null;   // гинж доторх дараалал (v1, v2…)
      o.can = { release: U.can(session.role, 'job.release') && !isPreparer(session, id), finalize: U.can(session.role, 'job.finalize') && !isPreparer(session, id),
        resubmit: (inTeam || U.can(session.role, 'job.cancelAny')) && U.can(session.role, 'job.create'), downloadFinal: U.can(session.role, 'job.downloadFinal'),
        cancelWorkflow: U.can(session.role, 'job.cancelWorkflow'), runAI: U.can(session.role, 'job.runAI'), decide: U.can(session.role, 'issue.decide') && !isPreparer(session, id) };
      o.ai_run_id = state.ai_run_id;
      o.standard = { rulepack: S.RULEPACK, prompt_template_id: S.PROMPT_TEMPLATE_ID };
      o.rechecks = listJobIds().filter(x => jobMeta(x).parent_id === id && canSeeJob(session, jobDir(x))).map(jobSummary);
      if (job.parent_id) {
        const rd = jobDir(job.parent_id);
        o.parent = fs.existsSync(rd) && canSeeJob(session, rd) ? { id: job.parent_id, audit: jobMeta(job.parent_id).audit } : { id: job.parent_id, missing: true };
        o.previous_count = (C.readJson(path.join(dir, 'previous_issues.json')) || []).length || undefined;
      }
      const ds = C.readJson(path.join(dir, 'docs', 'state.json'));
      if (ds && ds.url) o.docs = { url: ds.url, published_at: ds.published_at, last_sync: ds.last_sync };
      // Өөрөө шалгасан тайлан: ажлын урсгалгүй, захирлын үйлдэлгүй; цувралын бусад шалгалт, үлдсэн тоо
      if (isPc) {
        const g = jobM.precheck_group || id, mine = isOwner || inTeam, ran = prechecksRan(g).length;
        delete o.workflow; delete o.version_no; o.cycle_warning = false;
        o.can = { decide: false, release: false, finalize: false, runAI: false, resubmit: false, cancelWorkflow: false, downloadFinal: false,
          precheck: mine && U.can(session.role, 'job.create') && !jobM.submitted_as };
        o.precheck = { group: g, submitted_as: jobM.submitted_as || null, max: PRECHECK_MAX, used: ran, left: Math.max(0, PRECHECK_MAX - ran),
          n: precheckGroup(g).indexOf(id) + 1, series: precheckGroup(g).map(precheckRow) };
      } else if (jobM.precheck_group) {
        // Захирал (болон баг) — аудитор илгээхээсээ өмнө өөрөө шалгасан түүх
        o.prechecks = precheckGroup(jobM.precheck_group).filter(x => canSeeJob(session, jobDir(x))).map(precheckRow);
      }
      const ev = path.join(dir, 'events.jsonl');
      if (!internal) {
        // Багийн гишүүнд: зөвхөн нэр, код, огноо, хувилбар, төлөв, өөрийн оруулсан файл (§5)
        const r = WF.restrictJob(o);
        r.workflow = { state: wfs.state, label: wfs.label, version: wfs.version, released: wfs.released };
        if (o.prechecks) r.prechecks = o.prechecks;
        return sendJson(res, 200, r);
      }
      o.events = fs.existsSync(ev) ? fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).slice(-80).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
      return sendJson(res, 200, o);
    }

    // Файл нэмэх, эхлүүлэх: review үүсгэх эрхтэй бөгөөд өөрийнх нь (эсвэл хянагч/admin)
    const canEdit = U.can(session.role, 'job.create') && (isOwner || inTeam || U.can(session.role, 'job.cancelAny'));
    if (m === 'PUT' && rest === '/files') {
      if (!canEdit) return deny();
      if (status !== 'draft') return sendErr(res, 409, 'Review эхэлсэн тул файл нэмэх боломжгүй');
      const cat = url.searchParams.get('cat');
      if (!C.CATEGORIES.includes(cat)) return sendErr(res, 400, 'Invalid category');
      const name = safeName(url.searchParams.get('name'));
      if (!name) return sendErr(res, 400, 'Invalid file name');
      const ext = path.extname(name).toLowerCase();
      if (!C.ALLOWED_EXT.includes(ext)) return sendErr(res, 400, `${ext} өргөтгөл зөвшөөрөгдөхгүй`);
      const limit = MAX_UPLOAD_MB * 1024 * 1024;
      if (Number(req.headers['content-length'] || 0) > limit) return sendErr(res, 413, `Файл ${MAX_UPLOAD_MB} MB-аас том байна`);
      const dest = path.join(dir, 'input', cat, name);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest); let n = 0;
        req.on('data', c => { n += c.length; if (n > limit) { req.destroy(); ws.destroy(); reject(new Error('Файл хэт том')); } });
        req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
      }).catch(e => { C.rmrf(dest); throw e; });
      if (!magicOk(dest, ext)) { C.rmrf(dest); return sendErr(res, 400, `${name}: файлын агуулга ${ext} өргөтгөлтэй тохирохгүй байна`); }
      return sendJson(res, 201, { ok: true, name });
    }

    // Линкээс файл татах (Google Drive/Docs/Sheets, OneDrive/SharePoint, https)
    if (m === 'POST' && rest === '/files-url') {
      if (!canEdit) return deny();
      if (status !== 'draft') return sendErr(res, 409, 'Review эхэлсэн тул файл нэмэх боломжгүй');
      const body = await readJsonBody(req);
      const cat = String(body.cat || '');
      if (!C.CATEGORIES.includes(cat)) return sendErr(res, 400, 'Invalid category');
      let host = '';
      try { host = new URL(String(body.url)).hostname; } catch {}
      let got;
      try {
        got = await FU.download(String(body.url || ''), {
          maxBytes: MAX_UPLOAD_MB * 1024 * 1024,
          destFn: raw => {
            const name = safeName(raw);
            const ext = path.extname(name).toLowerCase();
            if (!C.ALLOWED_EXT.includes(ext)) throw new Error(`${name}: ${ext || 'өргөтгөлгүй'} файл зөвшөөрөгдөхгүй`);
            return { name, path: path.join(dir, 'input', cat, name) };
          },
        });
      } catch (e) { log('FILE_URL_FAIL', `${id} ${host}`); return sendErr(res, 400, `${e.message}. Линкээс татаж чадахгүй бол Google Docs дээр «Файл → Download → Microsoft Word (.docx)» хийж, файлаар оруулна уу.`); }
      const ext = path.extname(got.name).toLowerCase();
      if (!magicOk(got.path, ext)) { C.rmrf(got.path); return sendErr(res, 400, `${got.name}: файлын агуулга ${ext} өргөтгөлтэй тохирохгүй байна`); }
      log('FILE_URL', `${id} ${host}${got.via === 'drive' ? ` drive:${GD.status().email} owner:${got.owner}` : ''}`);
      // Эх файлын хадгалалтад «линкээс» гэж тэмдэглэх (хаягийн зөвхөн host-ыг)
      const jm = C.readJson(path.join(dir, 'job.json')) || {};
      // Линкийн агуулга дараа өөрчлөгдөж болох тул тухайн агшны хуулбар (originals/) + линк, огноо, sha256-ийг тэмдэглэнэ (§6)
      C.writeJson(path.join(dir, 'job.json'), { ...jm, link_sources: { ...(jm.link_sources || {}), [`${cat}/${got.name}`]: { host, url: String(body.url).slice(0, 1000), fetched_at: C.nowIso(), sha256: AL.fileSha256(got.path) } } });
      return sendJson(res, 201, { ok: true, name: got.name, size: got.size });
    }

    // Вэб дээр засварласан тайланг (server/edits.js) засварласан хувилбарын тайлан болгон оруулах
    if (m === 'POST' && rest === '/files-edits') {
      if (!canEdit) return deny();
      if (status !== 'draft') return sendErr(res, 409, 'Review эхэлсэн тул файл нэмэх боломжгүй');
      const job = C.readJson(path.join(dir, 'job.json')) || {};
      if (!job.parent_id) return sendErr(res, 400, 'Зөвхөн засварласан хувилбарт ашиглана');
      const w = ED.latestWorking(rootId);
      if (!w) return sendErr(res, 404, 'Вэб дээр хийсэн засвар алга');
      const name = safeName(w.name);
      fs.mkdirSync(path.join(dir, 'input', 'report'), { recursive: true });
      fs.copyFileSync(w.path, path.join(dir, 'input', 'report', name));
      auditLog('report.edit.use', { job: id, root: rootId, from_version: w.version, applied: w.applied, user: who, role: session.role });
      return sendJson(res, 201, { ok: true, name, size: fs.statSync(w.path).size });
    }

    // Хянуулах (DRAFT → SUBMITTED, v1) / засвар илгээх (RETURNED → RESUBMITTED, v{n+1}). /start нь хуучин UI-д зориулсан нэр.
    if (m === 'POST' && (rest === '/start' || rest === '/submit' || rest === '/resubmit')) {
      if (!canEdit) return deny();
      if (status !== 'draft') return sendErr(res, 409, `Төлөв: ${status}`);
      if (!fs.existsSync(path.join(P.prompts, 'system_prompt.md'))) return sendErr(res, 409, 'Review-ийн нөхцөл (prompts/system_prompt.md) тохируулаагүй байна. Шинэ нөхцөл оруулсны дараа review хийх боломжтой.');
      const job = C.readJson(path.join(dir, 'job.json'));
      if (job.kind === 'precheck') return sendErr(res, 409, 'Өөрөө шалгасан тайланг шууд илгээхгүй — «Захиралд илгээх»-ээр шинэ илгээлт үүсгэнэ');
      const body = await readJsonBody(req);
      const isResubmit = !!job.parent_id;
      // Өөрөө шалгаснаас илгээх: оруулаагүй ангиллын файлыг (жишээ нь өөрчлөгдөөгүй Excel, хөтөлбөр) сүүлийн шалгалтаас хуулна
      const pcFrom = !isResubmit && job.precheck_group ? prechecksRan(job.precheck_group).pop() : null;
      if (pcFrom && !jobMeta(pcFrom).submitted_as) copyMissingFrom(pcFrom, dir);
      if (rest === '/resubmit' && !isResubmit) return sendErr(res, 400, 'Энэ бол анхны хүсэлт — /submit ашиглана уу');
      const wf = WF.stateOf(rootId);
      if (!isResubmit && wf.state !== 'DRAFT') return sendErr(res, 409, `Төлөв «${wf.label}» — дахин илгээх боломжгүй`);
      const retry = wf.state === 'RESUBMITTED' && ['failed', 'cancelled'].includes(wf.latest_ai);
      if (isResubmit && wf.state !== 'RETURNED' && !retry) return sendErr(res, 409, `Төлөв «${wf.label}» — захирал feedback буцаасны дараа л засвар илгээнэ`);
      const note = String(body.note || '').trim().slice(0, 2000);
      // «Юу зассан бэ» заавал биш (2026-10-12 хэрэглэгчийн шийдвэр — талбарыг хассан)
      let files = jobFiles(dir);
      if (!files.some(f => f.category === 'report')) return sendErr(res, 400, isResubmit ? 'Засварласан тайлангийн файл эсвэл линкийг заавал оруулна уу' : 'Үндсэн тайлан (report) оруулаагүй байна');
      if (isResubmit) {
        // AI-ийн ноорог тэмдэглэгээ «[АУДИТОР БАТАЛГААЖУУЛАХ: …]» үлдсэн тайланг илгээхгүй — аудитор нотолгоотой бөглөх ёстой
        const left = draftMarksIn(path.join(dir, 'input', 'report'));
        if (left.length) return sendErr(res, 409, `Тайланд AI-ийн ноорог тэмдэглэгээ «[${ED.DRAFT_TAG}: …]» ${left.length} газар үлдсэн байна (${left.slice(0, 6).join(', ')}${left.length > 6 ? ' …' : ''}). Нотолгоотой тулгаж бөглөөд, тэмдэглэгээг арилгаад дахин илгээнэ үү.`);
        // Excel / хөтөлбөр өөрчлөгдөөгүй бол өмнөх хувилбарынхыг дахин ашиглана (эх файлаас хуулна)
        const prevV = WF.versions(rootId).filter(x => x !== id).pop();
        for (const cat of ['excel', 'program']) {
          if (files.some(f => f.category === cat) || !prevV) continue;
          for (const it of ORIG.list(jobDir(prevV)).filter(x => x.cat === cat)) {
            const f = ORIG.fileOf(jobDir(prevV), it.cat, it.name);
            if (f) { fs.mkdirSync(path.join(dir, 'input', cat), { recursive: true }); fs.copyFileSync(f.path, path.join(dir, 'input', cat, it.name)); }
          }
        }
        files = jobFiles(dir);
      }
      // Төлөвийг ЭХЛЭЭД шилжүүлнэ: queued гэж тэмдэглэсний дараа хуучин (workflow-гүй) job-ийн тооцоолсон төлөв
      // аль хэдийн SUBMITTED болж «хяналтад → хяналтад» алдаа өгдөг байв (2026-10-12).
      const version = isResubmit ? (retry ? WF.versions(rootId).length : WF.versions(rootId).length + 1) : 1;
      if (!retry) {
        const t = WF.transition(rootId, isResubmit ? 'RESUBMITTED' : 'SUBMITTED', { by: who, role: session.role, version, note: isResubmit ? note : '' });
        if (t.error) return sendErr(res, t.code, t.error);
      }
      // Эх файлуудыг илгээх агшинд хувилбарт хадгална (AI шалгалт дуусахыг хүлээхгүй)
      try { ORIG.snapshot(dir); } catch (e) { console.error('originals snapshot:', e.message); }
      // transition нь root-ийн job.json-д workflow бичсэн тул дахин уншиж нэмнэ
      // AI шууд ажиллахгүй — захирал «AI хянуулах» дарахыг хүлээнэ (захиралд олон тайлан ирдэг тул өөрөө сонгоно, 2026-10-13)
      C.writeJson(path.join(dir, 'job.json'), { ...(C.readJson(path.join(dir, 'job.json')) || job), queued: false, awaiting_ai: true, files, submitted_by: who, submitted_at: C.nowIso(), ...(isResubmit ? { resubmit_note: note } : {}) });
      // Өөрөө шалгасан цувралыг энэ тайлантай холбоно — захирал тайлан дээрээ харна
      const pcIds = !isResubmit ? precheckGroup(job.precheck_group) : [];
      for (const x of pcIds) { const f = path.join(jobDir(x), 'job.json'); C.writeJson(f, { ...(C.readJson(f) || {}), submitted_as: rootId }); }
      log('JOB_SUBMIT', `${id} files=${files.length} v${version}${pcIds.length ? ` prechecks=${pcIds.length}` : ''}`);
      auditLog('submission', { job: id, root: rootId, version, user: who, role: session.role, cycle_no: version, parent: job.parent_id || null,
        files: files.map(f => ({ category: f.category, sha256: AL.fileSha256(path.join(dir, 'input', f.category, f.name)), size: f.size })) });
      // Захиралд мэдэгдэл; захирал бүртгэлгүй бол admin-д (хүсэлт хэнд ч хүрэхгүй үлдэхээс сэргийлнэ)
      const actUsers = U.list().filter(u => !u.disabled);
      let caes = actUsers.filter(u => u.role === 'cae').map(u => u.username);
      if (!caes.length) caes = actUsers.filter(u => u.role === 'admin').map(u => u.username);
      const au = jobMeta(rootId).audit || {};
      NT.send(caes, { kind: isResubmit ? 'RESUBMITTED' : 'SUBMITTED', job: rootId, version, audit: au,
        text: `${isResubmit ? `Засварласан хувилбар (v${version}) хянуулах хүсэлт ирлээ` : 'Шинэ хянуулах хүсэлт ирлээ'}: ${[au.code, au.branch, au.name].filter(Boolean).join(' · ')} — илгээсэн: ${session.name || who}.${pcIds.length ? ` Аудитор илгээхээсээ өмнө ${pcIds.length} удаа өөрөө шалгасан.` : ''} AI хяналтыг «AI хянуулах» товчоор эхлүүлнэ.` });
      return sendJson(res, 200, { ok: true, version });
    }

    // Захирал «AI хянуулах» — илгээсэн хувилбарыг AI-аар шалгуулж эхлүүлнэ (тасарсан бол дахин)
    if (m === 'POST' && rest === '/ai-review') {
      if (!U.can(session.role, 'job.runAI')) return deny();
      if (!WF.AI_STARTABLE.includes(status)) return sendErr(res, 409, `AI төлөв: ${status} — зөвхөн илгээгдээд хүлээж буй эсвэл тасарсан хувилбарыг эхлүүлнэ`);
      const wf = WF.stateOf(rootId);
      if (!['SUBMITTED', 'RESUBMITTED'].includes(wf.state)) return sendErr(res, 409, `Төлөв «${wf.label}» — AI хяналт эхлүүлэх боломжгүй`);
      if (wf.latest !== id) return sendErr(res, 409, 'Зөвхөн сүүлийн илгээсэн хувилбарыг AI-аар шалгуулна');
      if (!fs.existsSync(path.join(P.prompts, 'system_prompt.md'))) return sendErr(res, 409, 'Review-ийн нөхцөл (prompts/system_prompt.md) тохируулаагүй байна.');
      // Тасарсан бол: эх файлыг originals/-аас сэргээж, хуучин гүйцэтгэлийн үлдэгдлийг цэвэрлэнэ
      if (status !== 'pending') {
        restoreInputs(dir);
        if (!jobFiles(dir).some(f => f.category === 'report')) return sendErr(res, 409, 'Эх файл хадгалагдаагүй тул дахин шалгах боломжгүй — аудитор дахин илгээнэ үү');
        C.rmrf(path.join(dir, 'sandbox', 'output')); C.rmrf(path.join(dir, 'state.json'));
      }
      const job = C.readJson(path.join(dir, 'job.json')) || {};
      C.writeJson(path.join(dir, 'job.json'), { ...job, queued: true, ai_requested_by: who, ai_requested_at: C.nowIso() });
      log('JOB_START', `${id} v${wf.version}${status !== 'pending' ? ` retry(${status})` : ''}`);
      auditLog('ai.start', { job: id, root: rootId, version: wf.version, user: who, role: session.role, retry: status !== 'pending' });
      startNext();
      return sendJson(res, 200, { ok: true, version: wf.version });
    }

    // Аудитор «Өөрөө шалгах» — илгээхээс өмнөх бүрэн AI хяналт (захирлын «AI хянуулах»-гүй, шууд дараалалд). Тасарсан бол дахин.
    if (m === 'POST' && rest === '/precheck') {
      if (!canEdit) return deny();
      if (!isPc) return sendErr(res, 400, 'Энэ нь өөрөө шалгах тайлан биш');
      if (jobM.submitted_as) return sendErr(res, 409, 'Захиралд илгээгдсэн тул дахин шалгах боломжгүй');
      if (!['draft', 'failed', 'cancelled'].includes(status)) return sendErr(res, 409, `AI төлөв: ${status}`);
      if (!fs.existsSync(path.join(P.prompts, 'system_prompt.md'))) return sendErr(res, 409, 'Review-ийн нөхцөл (prompts/system_prompt.md) тохируулаагүй байна.');
      const g = jobM.precheck_group || id;
      if (status === 'draft' && prechecksRan(g).length >= PRECHECK_MAX) return sendErr(res, 409, `Өөрөө шалгах дээд тоо (${PRECHECK_MAX} удаа) хүрсэн — тайлангаа захиралд илгээнэ үү`);
      if (status !== 'draft') { restoreInputs(dir); C.rmrf(path.join(dir, 'sandbox', 'output')); C.rmrf(path.join(dir, 'state.json')); }
      else copyMissingFrom(prechecksRan(g).filter(x => x !== id).pop(), dir);   // дахин шалгахад өөрчлөгдөөгүй файлыг өмнөх шалгалтаас
      const files = jobFiles(dir);
      if (!files.some(f => f.category === 'report')) return sendErr(res, 400, 'Үндсэн тайлан (report) оруулаагүй байна');
      if (status === 'draft') try { ORIG.snapshot(dir); } catch (e) { console.error('originals snapshot:', e.message); }
      C.writeJson(path.join(dir, 'job.json'), { ...(C.readJson(path.join(dir, 'job.json')) || jobM), queued: true, files, ai_requested_by: who, ai_requested_at: C.nowIso() });
      log('PRECHECK_START', `${id} group=${g}${status !== 'draft' ? ` retry(${status})` : ''}`);
      auditLog('precheck.start', { job: id, group: g, n: prechecksRan(g).length, user: who, role: session.role, retry: status !== 'draft',
        files: files.map(f => ({ category: f.category, sha256: AL.fileSha256(path.join(dir, 'input', f.category, f.name)), size: f.size })) });
      startNext();
      return sendJson(res, 200, { ok: true });
    }

    if (m === 'POST' && rest === '/cancel') {
      if (!(U.can(session.role, 'job.cancelAny') || (isOwner && U.can(session.role, 'job.create')))) return deny();
      if (active && active.id === id) {
        C.writeJson(path.join(dir, 'state.json'), { ...(C.readJson(path.join(dir, 'state.json')) || {}), status: 'cancelled', finished: C.nowIso() });
        for (const ch of active.ctl.children) killTree(ch);
      } else if (status === 'queued') {
        const job = C.readJson(path.join(dir, 'job.json'));
        C.writeJson(path.join(dir, 'job.json'), { ...job, queued: false });
      }
      log('JOB_CANCEL', id);
      return sendJson(res, 200, { ok: true });
    }

    if (m === 'DELETE' && !rest) {
      // Захирал / admin — дурын тайлан; үүсгэсэн хүн — зөвхөн хэзээ ч илгээгээгүй ноорог (хяналтын бүртгэлийг хамгаална)
      // Өөрөө шалгасан, захиралд илгээгээгүй тайланг баг өөрөө устгана (илгээсэн бол захирлын бүртгэлд үлдэнэ)
      const ownPc = isPc && (isOwner || inTeam) && !jobM.submitted_as;
      const ownDraft = ownPc || (!isPc && isOwner && WF.stateOf(rootId).state === 'DRAFT' && WF.versions(rootId).length === 0);
      if (!U.can(session.role, 'job.delete') && !ownDraft) return deny();
      // ?all=1 — тайлангийн бүх хувилбар (v1 + засварууд) + түүнтэй холбоотой өөрөө шалгасан тайлан. Эцэслэн батлагдсан бол archive/-д хуулбар нь хэвээр үлдэнэ.
      const ids = isPc ? [id] : url.searchParams.get('all') ? [...WF.chain(rootId), ...listJobIds().filter(x => isPrecheck(x) && jobMeta(x).submitted_as === rootId)] : [id];
      if (active && ids.includes(active.id)) return sendErr(res, 409, 'Ажиллаж байгаа review-г эхлээд зогсооно уу');
      // Нэг хувилбар: зөвхөн сүүлийн, feedback илгээгээгүй засварласан хувилбар. Өмнөх хувилбар, feedback, засвар хэвээр.
      if (ids.length === 1 && WF.chain(rootId).length > 1) {
        if (!U.can(session.role, 'job.delete')) return deny();
        const chk = WF.canDropVersion(rootId, id);
        if (chk.error) return sendErr(res, chk.code, chk.error);
        const from = WF.stateOf(rootId).state;
        removeJob(jobDir(id));
        WF.versionDropped(rootId, chk.version, { from, by: who, role: session.role, note: String(url.searchParams.get('note') || '') });
        log('JOB_DELETE_VERSION', `${rootId} v${chk.version} ${id}`);
        auditLog('job.delete_version', { job: rootId, deleted: id, version: chk.version, user: who, role: session.role });
        return sendJson(res, 200, { ok: true, deleted: 1, version: chk.version, root: rootId });
      }
      for (const x of ids.slice().reverse()) removeJob(jobDir(x));
      log('JOB_DELETE', `${ids.join(',')}`);
      auditLog('job.delete', { job: rootId, deleted: ids, versions: ids.length, user: who, role: session.role });
      return sendJson(res, 200, { ok: true, deleted: ids.length });
    }

    // Захирлын шийдвэр (SP-118-04 S5): APPROVED / EDITED (засварласан текст) / REJECTED, null = буцаах.
    // Зөвхөн APPROVED/EDITED санал аудиторт очиж, дахин хяналтад шалгагдана. Preparer ≠ Reviewer (DOC-1917 §9).
    const dm = rest.match(/^\/decisions(?:\/([A-Za-z0-9_-]{1,40}))?$/);
    if (dm && ((m === 'PATCH' && dm[1]) || (m === 'POST' && !dm[1]))) {
      if (!U.can(session.role, 'issue.decide')) return deny();
      if (status !== 'done') return sendErr(res, 409, 'Review дуусаагүй байна');
      if (jobMeta(id).finalized) return sendErr(res, 409, 'Тайлан эцэслэн батлагдсан тул шийдвэрийг өөрчлөх боломжгүй');
      if (isPreparer(session, id)) return sendErr(res, 409, 'Тайлангийн багийн гишүүн өөрийн тайлангийн саналыг шийдвэрлэх эрхгүй (DOC-1917 §9 — бэлтгэгч ≠ хянагч)');
      const body = await readJsonBody(req);
      const list = dm[1] ? [{ ...body, id: dm[1] }] : (Array.isArray(body.items) ? body.items : []);
      if (!list.length || list.length > 500) return sendErr(res, 400, 'items хоосон');
      for (const it of list) {
        const d = it.decision === null || it.decision === undefined ? null : String(it.decision).toUpperCase();
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(it.id || ''))) return sendErr(res, 400, 'Invalid issue id');
        if (d !== null && !S.DECISIONS.includes(d)) return sendErr(res, 400, 'decision: APPROVED | EDITED | REJECTED | null');
        if (d === 'EDITED' && !String(it.edited_text || '').trim()) return sendErr(res, 400, 'Засварласан текст хоосон байна');
        it.decision = d;
      }
      const f = path.join(dir, 'decisions.json'), all = S.normDecisions(C.readJson(f) || {});
      for (const it of list) {
        if (it.decision === null) delete all[it.id];
        else all[it.id] = { decision: it.decision, ...(it.decision === 'EDITED' ? { edited_text: String(it.edited_text).slice(0, 2000) } : {}),
          note: String(it.note || '').slice(0, 1000), by: who, at: C.nowIso() };
        auditLog('review.decide', { job: id, rv_id: it.id, decision: it.decision, edited: it.decision === 'EDITED', user: who, role: session.role,
          ai_run_id: (C.readJson(path.join(dir, 'state.json')) || {}).ai_run_id || null });
      }
      C.writeJson(f, all);
      log('ISSUE_DECIDE', `${id} ${list.length === 1 ? `${list[0].id} ${list[0].decision ?? 'clear'}` : `bulk=${list.length}`}`);
      return sendJson(res, 200, { ok: true, decisions: all });
    }
    // Хянагчийн гараар нэмсэн тэмдэглэл: POST /comments (нэмэх), PATCH|DELETE /comments/MAN-001
    const mc = rest.match(/^\/comments(?:\/(MAN-\d{1,4}))?$/);
    if (mc && ((m === 'POST' && !mc[1]) || ((m === 'PATCH' || m === 'DELETE') && mc[1]))) {
      if (!U.can(session.role, 'issue.decide')) return deny();
      if (status !== 'done') return sendErr(res, 409, 'Review дуусаагүй байна');
      if (jobMeta(id).finalized) return sendErr(res, 409, 'Тайлан эцэслэн батлагдсан тул тэмдэглэл нэмэх, засах боломжгүй');
      if (isPreparer(session, id)) return sendErr(res, 409, 'Тайлангийн багийн гишүүн өөрийн тайланд тэмдэглэл нэмэх эрхгүй (DOC-1917 §9)');
      try {
        let r;
        if (m === 'DELETE') r = MAN.remove(dir, mc[1]);
        else { const body = await readJsonBody(req); r = m === 'POST' ? MAN.add(dir, body, who) : MAN.edit(dir, mc[1], body, who); }
        const cid = mc[1] || r.issue?.id;
        auditLog('review.manual_comment', { job: id, rv_id: cid, action: m === 'POST' ? 'add' : m === 'PATCH' ? 'edit' : 'delete', user: who, role: session.role });
        log('MANUAL_COMMENT', `${id} ${cid} ${m}`);
        return sendJson(res, 200, { ok: true, id: cid, decisions: r.decisions || S.normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {}) });
      } catch (e) { return sendErr(res, e.code || 500, e.message); }
    }
    /* ---------- Ажлын урсгал: release, feedback, хувилбар, ялгаа, эцсийн тайлан, цуцлах ---------- */
    // Батлаад илгээх: CAE_REVIEW → RETURNED. Feedback_v{n}-ийг царцааж, багт мэдэгдэнэ. GET = урьдчилан харах (тоо)
    if (rest === '/release' && (m === 'GET' || m === 'POST')) {
      if (!U.can(session.role, 'job.release')) return deny();
      if (isPreparer(session, id)) return sendErr(res, 409, 'Тайлангийн багийн гишүүн өөрийн тайланг буцааж илгээх эрхгүй (DOC-1917 §9)');
      const wf = WF.stateOf(rootId);
      if (wf.state !== 'CAE_REVIEW') return sendErr(res, 409, `Төлөв «${wf.label}» — зөвхөн захирлын хяналтад (AI дууссан) байх үед илгээнэ`);
      const draft = WF.draftFeedback(rootId);
      if (draft.error) return sendErr(res, 409, draft.error);
      const summary = { version: draft.version, sent: draft.items.length, excluded: draft.excluded.length, undecided: draft.undecided.length, undecided_ids: draft.undecided.slice(0, 50) };
      if (m === 'GET') return sendJson(res, 200, summary);
      const body = await readJsonBody(req);
      if (draft.undecided.length && body.exclude_undecided !== true) return sendErr(res, 409, `${draft.undecided.length} санал шийдвэрлэгдээгүй байна — шийдвэрлэх эсвэл «шийдвэрлээгүйг хасах»-ыг баталгаажуулна уу`);
      const fr = WF.freezeFeedback(rootId, draft, { by: who, role: session.role });
      if (fr.error) return sendErr(res, fr.code || 409, fr.error);
      const t = WF.transition(rootId, 'RETURNED', { by: who, role: session.role, version: draft.version, note: String(body.note || '').slice(0, 2000) });
      if (t.error) return sendErr(res, t.code, t.error);
      auditLog('review.release', { job: rootId, version: draft.version, sent: draft.items.length, excluded: draft.excluded.length, undecided_excluded: draft.undecided.length, user: who, role: session.role });
      const au = jobMeta(rootId).audit || {};
      const latestBy = jobMeta(draft.job).submitted_by || jobMeta(draft.job).created_by;
      NT.send([...WF.teamOf(rootId), latestBy], { kind: 'RETURNED', job: rootId, version: draft.version, audit: au,
        text: `${au.code || ''} ${au.branch || ''}: захирал v${draft.version}-д ${draft.items.length} санал буцаалаа — засаад дахин илгээнэ үү`.trim() });
      log('RELEASE', `${rootId} v${draft.version} sent=${draft.items.length}`);
      // AI-ийн автомат засвар: баталсан санал бүрийг тайланд Track Changes-ээр (ар талд, хүлээхгүй)
      startAutofix(rootId, draft.version, who, au, [...WF.teamOf(rootId), latestBy]);
      return sendJson(res, 200, { ok: true, ...summary, file: fr.file, autofix: true });
    }
    // Царцсан feedback (багийн гишүүн ба захирал) — зөвхөн release хийсэн хувилбар
    const fm = rest.match(/^\/feedback\/(\d{1,3})$/);
    if (m === 'GET' && fm) {
      const n = Number(fm[1]);
      if (!WF.releasedVersions(rootId).includes(n)) return sendErr(res, 404, 'Энэ хувилбарт feedback илгээгдээгүй байна');
      log('FEEDBACK_VIEW', `${rootId} v${n}`);
      return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(jobDir(rootId), fs.readFileSync(path.join(jobDir(rootId), 'feedback', `feedback_v${n}.json`), 'utf8'), true));
    }
    // Аудиторын «Зассан» тэмдэглэгээ (feedback бүрийн мөрөөр). Feedback өөрөө царцсан хэвээр — тусдаа progress_v{n}.json.
    // Энэ нь аудиторын өөрийн тэмдэглэл; засагдсан эсэхийг дахин хяналт (M14) бие даан шалгана.
    // Баг (аудитор, ахлах аудитор) ажлын урсгалын бүх шатанд, release хийсэн аль ч хувилбар дээр тэмдэглэнэ.
    const fpm = rest.match(/^\/feedback\/(\d{1,3})\/progress(?:\/([A-Za-z0-9_-]{1,40}))?$/);
    if (fpm && ((m === 'GET' && !fpm[2]) || (m === 'PATCH' && fpm[2]))) {
      const n = Number(fpm[1]), rel = WF.releasedVersions(rootId);
      if (!rel.includes(n)) return sendErr(res, 404, 'Энэ хувилбарт feedback илгээгдээгүй байна');
      const pf = path.join(jobDir(rootId), 'feedback', `progress_v${n}.json`);
      const all = C.readJson(pf) || {};
      if (m === 'GET') return sendJson(res, 200, { progress: all });
      if (!inTeam) return sendErr(res, 403, 'Зөвхөн тайлангийн багийн гишүүн «Зассан» гэж тэмдэглэнэ');
      const fb = C.readJson(path.join(jobDir(rootId), 'feedback', `feedback_v${n}.json`)) || {};
      if (!(fb.items || []).some(x => x.id === fpm[2])) return sendErr(res, 404, 'Санал олдсонгүй');
      const body = await readJsonBody(req);
      if (body.done) all[fpm[2]] = { done: true, by: who, at: C.nowIso() }; else delete all[fpm[2]];
      C.writeJson(pf, all);
      auditLog('feedback.progress', { job: rootId, version: n, rv_id: fpm[2], done: !!body.done, user: who, role: session.role });
      return sendJson(res, 200, { ok: true, progress: all });
    }
    // Тайлан дээр шууд засах (server/edits.js): санал бүрийн ишлэлийг .docx-д солих, буцаах. Эх файл өөрчлөгдөхгүй.
    // Харах — job-ийг харах эрхтэй хүн бүр; засах / буцаах — зөвхөн багийн гишүүн, RETURNED төлөвт, сүүлийн feedback дээр.
    const edm = rest.match(/^\/feedback\/(\d{1,3})\/edits(?:\/(preview|suggest|docx|tracked|autofix|all|\d{1,5}))?(?:\/(revert))?$/);
    if (edm) {
      const n = Number(edm[1]), sub = edm[2] || '', rel = WF.releasedVersions(rootId);
      if (!rel.includes(n)) return sendErr(res, 404, 'Энэ хувилбарт feedback илгээгдээгүй байна');
      if (m === 'GET' && !sub) {
        const st = ED.state(rootId, n);
        if (st.autofix?.state === 'running' && !AF.isRunning(rootId, n)) st.autofix.state = 'interrupted';   // сервер дахин ассан
        return st.error ? sendErr(res, st.code, st.error) : sendJson(res, 200, st);
      }
      if (m === 'GET' && (sub === 'docx' || sub === 'tracked')) {
        const w = ED.working(rootId, n, sub === 'tracked');
        if (!w) return sendErr(res, 404, sub === 'tracked' ? 'AI засвартай (Track Changes) хувилбар алга' : 'Вэб дээр хийсэн засвар алга');
        auditLog('report.edit.download', { job: rootId, version: n, applied: w.applied, tracked: sub === 'tracked', user: who, role: session.role });
        const ascii = w.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
        return send(res, 200, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fs.readFileSync(w.path),
          { 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(w.name)}` });
      }
      if (m !== 'POST') return sendErr(res, 405, 'Method not allowed');
      if (!inTeam) return sendErr(res, 403, 'Зөвхөн тайлангийн багийн гишүүн тайланг засна');
      if (WF.stateOf(rootId).state !== 'RETURNED' || n !== rel[rel.length - 1]) return sendErr(res, 409, 'Засвар илгээсний дараа тайланг энд засах боломжгүй');
      const body = await readJsonBody(req);
      const pf = path.join(jobDir(rootId), 'feedback', `progress_v${n}.json`);
      // AI-ийн автомат засварыг дахин ажиллуулах (тасарсан / амжилтгүй болсон үед) — хэрэглэсэн засвар хэвээр
      if (sub === 'autofix') {
        const r = startAutofix(rootId, n, who, jobMeta(rootId).audit || {}, null, body.force === true);
        return r.error ? sendErr(res, 409, r.error) : sendJson(res, 200, r);
      }
      if (sub === 'preview') {
        const r = ED.preview(rootId, n, String(body.rv_id || ''), body.text, body.old);
        return r.error ? sendErr(res, r.code || 409, r.error) : sendJson(res, 200, r);
      }
      // AI-аар найруулга бэлтгэх (нэг санал, далдалсан бичвэрээр, хэрэгсэлгүй)
      if (sub === 'suggest') {
        const rv = String(body.rv_id || '');
        const r = await SUG.suggest(rootId, n, rv, who);
        if (r.error) return sendErr(res, r.code || 502, r.error);
        auditLog('report.edit.suggest', { job: rootId, version: n, rv_id: rv, fixable: r.suggestion.fixable, ai_run_id: r.suggestion.ai_run_id, user: who, role: session.role });
        log('REPORT_SUGGEST', `${rootId} v${n} ${rv} fixable=${r.suggestion.fixable}`);
        return sendJson(res, 200, r);
      }
      if (!sub) {
        const rv = String(body.rv_id || '');
        const r = ED.apply(rootId, n, rv, body.text, who, body.old);
        if (r.error) return sendErr(res, r.code || 409, r.error);
        // Засвар хийсэн саналыг автоматаар «Зассан» гэж тэмдэглэнэ (буцаавал автоматаар хасагдана)
        const pr = C.readJson(pf) || {};
        if (!pr[rv]?.done) { pr[rv] = { done: true, by: who, at: C.nowIso(), via: 'edit' }; C.writeJson(pf, pr); }
        auditLog('report.edit.apply', { job: rootId, version: n, rv_id: rv, seq: r.edit.seq, block: r.edit.block, user: who, role: session.role });
        log('REPORT_EDIT', `${rootId} v${n} ${rv} seq=${r.edit.seq}`);
        return sendJson(res, 200, { ok: true, edit: r.edit, state: ED.state(rootId, n), progress: pr });
      }
      if (edm[3] === 'revert' && (sub === 'all' || /^\d+$/.test(sub))) {
        const r = ED.revert(rootId, n, sub, who);
        if (r.error) return sendErr(res, r.code || 409, r.error);
        const pr = C.readJson(pf) || {};
        for (const { rv_id } of r.reverted) if (pr[rv_id]?.via === 'edit' && !r.edits.some(e => e.rv_id === rv_id && e.status === 'applied')) delete pr[rv_id];
        C.writeJson(pf, pr);
        auditLog('report.edit.revert', { job: rootId, version: n, seqs: r.reverted.map(x => x.seq), user: who, role: session.role });
        log('REPORT_EDIT_REVERT', `${rootId} v${n} ${sub}`);
        return sendJson(res, 200, { ok: true, reverted: r.reverted, conflicts: r.conflicts, state: ED.state(rootId, n), progress: pr });
      }
      return sendErr(res, 404, 'Not found');
    }
    // Царцсан feedback-ийг файлаар татах (Word / Excel) — баг болон захирал
    const fdm =rest.match(/^\/feedback\/(\d{1,3})\/(docx|xlsx)$/);
    if (m === 'GET' && fdm) {
      const n = Number(fdm[1]);
      let fb;
      if (WF.releasedVersions(rootId).includes(n)) fb = JSON.parse(C.restoreTokens(jobDir(rootId), fs.readFileSync(path.join(jobDir(rootId), 'feedback', `feedback_v${n}.json`), 'utf8'), true));
      else {
        // Илгээгээгүй (сүүлийн) хувилбарын төсөл — захирлын одоогийн шийдвэрээр + шийдвэрлээгүй санал. Аудитор release хүртэл харахгүй (§5).
        if (!U.can(session.role, 'issue.viewAll')) return sendErr(res, 404, 'Энэ хувилбарт feedback илгээгдээгүй байна');
        const draft = WF.draftFeedback(rootId, { includeUndecided: true });
        if (draft.error) return sendErr(res, 409, draft.error);
        if (draft.version !== n) return sendErr(res, 404, 'Энэ хувилбарт feedback илгээгдээгүй байна');
        const txt = C.restoreTokens(jobDir(draft.job), JSON.stringify({ version: n, job: draft.job, draft: true, drafted_at: C.nowIso(), items: draft.items }), true);
        fb = JSON.parse(C.restoreTokens(jobDir(rootId), txt, true));
      }
      const out = feedbackExport(fb, jobMeta(rootId).audit, fdm[2]);
      log('FEEDBACK_DOWNLOAD', `${rootId} v${n} ${fdm[2]}`);
      auditLog('feedback.download', { job: rootId, version: n, format: fdm[2], ...(fb.draft ? { draft: true } : {}), user: who, role: session.role });
      const ascii = out.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      return send(res, 200, out.type, out.data, { 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(out.filename)}` });
    }
    // Хувилбарын timeline
    if (m === 'GET' && rest === '/versions') {
      const released = WF.releasedVersions(rootId);
      const list = WF.versions(rootId).map((x, i) => {
        const jm2 = jobMeta(x), sum = internal ? jobSummary(x) : null;
        return { version: i + 1, job: x, created: jm2.created, submitted_at: jm2.submitted_at || null, submitted_by: jm2.submitted_by || jm2.created_by || null,
          note: jm2.resubmit_note || '',
          // AI шалгалт дуусах хүртэл эх файл originals/-д шилжээгүй байдаг — илгээсэн жагсаалтыг job.json-оос харуулна
          // Линкээр оруулсан бол эх линк, татсан огноо (тухайн агшны хуулбар нь v<n>_ файл)
          files: !ORIG.list(jobDir(x)).length
            ? (jm2.files || []).filter(f => !f.auto).map(f => { const lk = (jm2.link_sources || {})[`${f.category}/${f.name}`]; const lo = lk && typeof lk === 'object' ? lk : null;
              return { cat: f.category, name: f.name, size: f.size, pending: true, ...(lk ? { source: 'link', host: lo ? lo.host : lk, url: lo?.url, fetched_at: lo?.fetched_at } : {}) }; })
            : ORIG.list(jobDir(x)).map(f => ({ cat: f.cat, name: f.name, sha256: f.sha256, source: f.source, host: f.host, url: f.url, fetched_at: f.fetched_at })),
          released: released.includes(i + 1), ...(internal ? { ai: WF.aiStatus(x), verdict: sum.verdict || null, r1: sum.r1, r2: sum.r2, r3: sum.r3, r4: sum.r4 } : {}) };
      });
      return sendJson(res, 200, { root: rootId, workflow: (({ state, label, version, history }) => ({ state, label, version, history: internal ? history : undefined }))(WF.stateOf(rootId)), versions: list });
    }
    // Хувилбар хоорондын ялгаа (догол мөрийн түвшинд) — зөвхөн захирал / хянагч (дээрх internal хаалт)
    if (m === 'GET' && rest === '/diff') {
      const vs = WF.versions(rootId), a = Number(url.searchParams.get('from')) || vs.length - 1, b = Number(url.searchParams.get('to')) || vs.length;
      if (!vs[a - 1] || !vs[b - 1] || a === b) return sendErr(res, 400, 'Хувилбарын дугаар буруу');
      const d = WF.diff(vs[a - 1], vs[b - 1]);
      if (d.error) return sendErr(res, 409, d.error);
      return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(jobDir(vs[b - 1]), C.restoreTokens(jobDir(vs[a - 1]), JSON.stringify({ from: a, to: b, ...d }), true), true));
    }
    // Эцсийн тайлан: docx (сүүлийн хувилбар, эх хэлбэрээр) / pdf (нүүрэнд RPT дугаар) / zip (бүх хувилбар + feedback + approval)
    const fnm = rest.match(/^\/final\/(docx|pdf|zip)$/);
    if (m === 'GET' && fnm) {
      if (!U.can(session.role, 'job.downloadFinal')) return deny();
      let out;
      try { out = await FINAL.build(rootId, fnm[1]); } catch (e) { return sendErr(res, e.code || 500, e.message); }
      auditLog('final.download', { job: rootId, format: fnm[1], version: out.version || null, method: out.method || null, user: who, role: session.role });
      log('FINAL_DOWNLOAD', `${rootId} ${fnm[1]}`);
      const ascii = out.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      return send(res, 200, out.type, out.data, { 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(out.filename)}` });
    }
    // Ажлын урсгалыг цуцлах (тайлбар заавал)
    if (m === 'POST' && rest === '/cancel-workflow') {
      if (!U.can(session.role, 'job.cancelWorkflow')) return deny();
      const body = await readJsonBody(req);
      const note = String(body.note || '').trim();
      if (!note) return sendErr(res, 400, 'Цуцлах шалтгааныг заавал бичнэ үү');
      const t = WF.transition(rootId, 'CANCELLED', { by: who, role: session.role, note });
      if (t.error) return sendErr(res, t.code, t.error);
      const au = jobMeta(rootId).audit || {};
      NT.send(WF.teamOf(rootId), { kind: 'CANCELLED', job: rootId, audit: au, text: `${au.code || ''} ${au.branch || ''}: хяналт цуцлагдлаа — ${note.slice(0, 120)}`.trim() });
      return sendJson(res, 200, { ok: true });
    }

    // S10 Эцсийн батлалт (зөвхөн захирал): сүүлийн давталтын verdict R1 = 0 байх → бүртгэлийн дугаар, батлагдсан огноо, архив, түгжих
    if (m === 'POST' && rest === '/finalize') {
      if (!U.can(session.role, 'job.finalize')) return sendErr(res, 403, 'Эцэслэн батлах эрх зөвхөн ДАГ-ын захиралд байна');
      const job = jobMeta(id);
      if (job.parent_id) return sendErr(res, 400, 'Анхны review-ийн хуудаснаас батална уу');
      if (job.finalized) return sendErr(res, 409, `Аль хэдийн батлагдсан: ${job.finalized.reg_no}`);
      if (status !== 'done') return sendErr(res, 409, 'Review дуусаагүй байна');
      if (isPreparer(session, id)) return sendErr(res, 409, 'Тайлангийн багийн гишүүн өөрийн тайланг батлах эрхгүй (DOC-1917 §9)');
      const wfF = WF.stateOf(id);
      if (wfF.state !== 'CAE_REVIEW') return sendErr(res, 409, `Төлөв «${wfF.label}» — зөвхөн захирлын хяналтад (сүүлийн хувилбарын AI дууссан) байх үед батална`);
      const cycles = [id, ...listJobIds().filter(x => jobMeta(x).parent_id === id && jobStatus(jobDir(x)) === 'done').sort((a, b) => (jobMeta(a).round || 0) - (jobMeta(b).round || 0))];
      const lastId = cycles[cycles.length - 1], last = jobSummary(lastId);
      if (Number(last.r1) > 0) return sendErr(res, 409, `Сүүлийн хяналт (C${last.cycle_no})-д ноцтой (R1) санал ${last.r1} үлдсэн — засагдсаны дараа батална`);
      if (!['READY', 'READY_WITH_FIXES'].includes(last.verdict)) return sendErr(res, 409, `Сүүлийн хяналт (C${last.cycle_no}) «${last.verdict || 'тодорхойгүй'}» байна — ноцтой (R1) санал засагдаж, «Батлахад бэлэн» эсвэл «Засвартайгаар батлах боломжтой» болсны дараа батална`);
      const body = await readJsonBody(req);
      const year = new Date().getFullYear(), cf = path.join(P.logs, 'registration_counter.json');
      const cnt = C.readJson(cf) || {}; cnt[year] = (cnt[year] || 0) + 1; C.writeJson(cf, cnt);
      const regNo = `RPT-174-${year}-${String(cnt[year]).padStart(3, '0')}`;
      const fin = { reg_no: regNo, approved_at: C.nowIso(), approved_by: who, approver_name: session.name || who, final_job: lastId, final_cycle: last.cycle_no, verdict: last.verdict, note: String(body.note || '').slice(0, 1000) };
      // Архив (DOC-1914: 10 жил) — jobs\-ийн автомат устгалд (--retention-days) хамаарахгүй, EFS шифрлэлттэй
      const arch = path.join(P.archive, regNo);
      fs.mkdirSync(arch, { recursive: true }); C.enableEfs(P.archive);
      const saved = [];
      for (const [jid, fmt] of [[id, 'docx'], [id, 'xlsx'], ...(lastId !== id ? [[lastId, 'docx']] : [])]) {
        try { const out = await buildExport(jobDir(jid), fmt); fs.writeFileSync(path.join(arch, out.filename), out.data); saved.push(out.filename); } catch (e) { console.error('archive export:', e.message); }
      }
      // Хувилбар бүрийн эх файлууд (originals/C<n>/<ангилал>/<файл>)
      cycles.forEach((x, i) => { try { const n = ORIG.copyTo(jobDir(x), path.join(arch, 'originals', `C${i + 1}`)); if (n) saved.push(`originals/C${i + 1} (${n} файл)`); } catch (e) { console.error('archive originals:', e.message); } });
      C.writeJson(path.join(arch, 'approval.json'), { ...fin, audit: job.audit, cycles: cycles.map(x => ({ job: x, ...(({ cycle_no, verdict, r1, r2, r3, r4 }) => ({ cycle_no, verdict, r1, r2, r3, r4 }))(jobSummary(x)), ai_run_id: (C.readJson(path.join(jobDir(x), 'state.json')) || {}).ai_run_id || null })),
        decisions: S.normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {}), files: saved, retention: '10 жил (DOC-1914)', rpt175: 'Follow-up систем (8502)-д бүртгэх — гараар (холболт хийгдээгүй)' });
      fin.archive = path.relative(P.root, arch).replace(/\\/g, '/');
      C.writeJson(path.join(arch, 'approval.json'), { ...C.readJson(path.join(arch, 'approval.json')), archive: fin.archive });
      C.writeJson(path.join(dir, 'job.json'), { ...jobMeta(id), finalized: fin });
      WF.transition(id, 'APPROVED_FINAL', { by: who, role: session.role, version: wfF.version, note: regNo });
      // Эцсийн тайлан (сүүлийн хувилбарын эх файл) архивт
      try { const fr = await FINAL.build(id, 'docx'); fs.writeFileSync(path.join(arch, 'FINAL_' + fr.filename), fr.data); } catch (e) { console.error('archive final:', e.message); }
      NT.send(WF.teamOf(id), { kind: 'APPROVED_FINAL', job: id, version: wfF.version, audit: job.audit || {}, text: `${job.audit?.code || ''} ${job.audit?.branch || ''}: тайлан эцэслэн батлагдлаа (${regNo})`.trim() });
      auditLog('engagement.finalize', { job: id, reg_no: regNo, final_job: lastId, cycle_no: last.cycle_no, verdict: last.verdict, user: who, role: session.role, files: saved.length });
      log('FINALIZE', `${id} ${regNo}`);
      return sendJson(res, 200, { ok: true, finalized: fin });
    }

    // Оруулсан эх файлууд — хувилбар (анхны review + дахин хяналтууд) бүрээр. Масккүй жинхэнэ файл тул
    // зөвхөн хянагч / захирал / админ эсвэл тайланг оруулсан аудитор татна; татах бүрийг логт бичнэ.
    const om0 = rest.match(/^\/originals(?:\/(file|zip))?$/);
    if (m === 'GET' && om0) {
      // Тайланг харах эрхтэй хэн ч (захирал, admin, баг) бүх хувилбарын эх файлыг татна. Хувилбар = гинж дэх дараалал (v1, v2, v3…)
      const chain = WF.versions(rootId).map((x, i) => ({ x, i }))
        .filter(({ x }) => fs.existsSync(jobDir(x)) && canSeeJob(session, jobDir(x)))
        .map(({ x, i }) => { const jm = jobMeta(x); return { job: x, version: i + 1, cycle: i + 1, created: jm.submitted_at || jm.created || null, files: ORIG.list(jobDir(x)) }; });
      if (!om0[1]) return sendJson(res, 200, { root: rootId, versions: chain });
      const attach = (name, type, data) => send(res, 200, type, data, { 'Content-Disposition': `attachment; filename="${encodeURIComponent(name).replace(/%/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
      if (om0[1] === 'file') {
        const jid = url.searchParams.get('job') || id;
        if (!chain.some(v => v.job === jid)) return sendErr(res, 404, 'Not found');
        const f = ORIG.fileOf(jobDir(jid), String(url.searchParams.get('cat') || ''), String(url.searchParams.get('name') || ''));
        if (!f) return sendErr(res, 404, 'Эх файл олдсонгүй');
        log('ORIGINAL_DOWNLOAD', `${jid} ${f.cat}`);
        auditLog('original.download', { job: jid, cat: f.cat, sha256: f.sha256, user: who, role: session.role });
        const ver = (chain.find(v => v.job === jid) || {}).version || 1;
        return attach(`v${ver}_${f.name}`, 'application/octet-stream', fs.readFileSync(f.path));
      }
      const entries = [];
      for (const v of chain) for (const it of v.files) {
        const f = ORIG.fileOf(jobDir(v.job), it.cat, it.name);
        if (f) entries.push({ name: `v${v.version}/v${v.version}_${it.name}`, data: fs.readFileSync(f.path) });
      }
      if (!entries.length) return sendErr(res, 404, 'Хадгалагдсан эх файл алга');
      log('ORIGINAL_DOWNLOAD', `${rootId} zip=${entries.length}`);
      auditLog('original.download', { job: rootId, zip: true, files: entries.length, user: who, role: session.role });
      const audit = jobMeta(rootId).audit || {};
      return attach(`Eh_failuud_${String(audit.code || rootId).replace(/[^\w-]+/g, '_')}.zip`, 'application/zip', zipFiles(entries));
    }

    if (m === 'GET' && rest === '/previous') {
      const f = path.join(dir, 'previous_issues.json');
      if (!fs.existsSync(f)) return sendJson(res, 200, []);
      return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(dir, fs.readFileSync(f, 'utf8'), true));
    }

    // Эх файлуудын жагсаалт (нотолгооны холбоосыг шийдэхэд)
    if (m === 'GET' && rest === '/sources') {
      const f = path.join(dir, 'sources', 'index.json');
      if (!fs.existsSync(f)) return sendJson(res, 200, { sources: [] });
      return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(dir, fs.readFileSync(f, 'utf8'), true));
    }

    // Нэг эх файлын агуулга: sheet бол Excel-ийн мөрийн дугаараар [from, to] (≤ 400 мөр), баримт бол бүх догол мөр
    const sm = rest.match(/^\/sources\/(\d{1,4})$/);
    if (m === 'GET' && sm) {
      const js = path.join(dir, 'sources', sm[1] + '.json'), tsv = path.join(dir, 'sources', sm[1] + '.tsv');
      if (fs.existsSync(js)) return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(dir, fs.readFileSync(js, 'utf8'), true));
      if (!fs.existsSync(tsv)) return sendErr(res, 404, 'Эх файл олдсонгүй');
      const from = Number(url.searchParams.get('from')) || 0;
      let to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : Infinity;
      if (to - from > 400 && !url.searchParams.get('all')) to = from + 400;   // all=1: офлайн вэб хуулбарт бүх мөр
      const rows = [];
      for (const line of fs.readFileSync(tsv, 'utf8').split('\n')) {
        const tab = line.indexOf('\t');
        const r = Number(line.slice(1, tab > 0 ? tab : undefined));
        if (r < from) continue; if (r > to) break;
        rows.push({ r, c: tab > 0 ? line.slice(tab + 1).split('\t') : [] });
      }
      return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(dir, JSON.stringify({ rows }), true));
    }

    if (m === 'GET' && rest === '/document') {
      const f = path.join(dir, 'doc.json');
      if (!fs.existsSync(f)) return sendErr(res, 404, 'Баримтын бүтэц алга');
      return send(res, 200, 'application/json; charset=utf-8', C.restoreTokens(dir, fs.readFileSync(f, 'utf8'), true));
    }

    // Цэгцтэй татах: PDF / Word / Excel / HTML / бүгдийг ZIP
    const xm = rest.match(/^\/export\/([a-z]+)$/);
    if (m === 'GET' && xm) {
      if (!EXPORT_FORMATS.includes(xm[1])) return sendErr(res, 404, 'Unknown format');
      if (status !== 'done') return sendErr(res, 409, 'Review дуусаагүй байна');
      // Аудитор зөвхөн захирлын зөвшөөрсөн саналын даалгаврыг татна
      if (xm[1] !== 'task' && !U.can(session.role, 'issue.viewAll') && !isPc) return deny();
      let out;
      try { out = await buildExport(dir, xm[1]); } catch (e) { return sendErr(res, xm[1] === 'task' ? 409 : 500, e.message); }
      log('DOWNLOAD', `${id} export.${xm[1]}`);
      if (xm[1] === 'task') {
        const dec = S.normDecisions(C.readJson(path.join(dir, 'decisions.json')) || {});
        auditLog('review.dispatch', { job: id, file: out.filename, approved: Object.values(dec).filter(d => d.decision !== 'REJECTED').length, user: who, role: session.role });
      }
      const ascii = out.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      return send(res, 200, out.type, out.data, { 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(out.filename)}` });
    }

    // Claude Docs руу илгээхэд бэлтгэх (зөвхөн локал; илгээхийг Claude Code-ийн /publish-docs хийнэ)
    if (m === 'POST' && rest === '/docs-prep') {
      if (!U.can(session.role, 'docs.prep')) return deny();
      if (status !== 'done') return sendErr(res, 409, 'Review дуусаагүй байна');
      let r;
      try { r = prepareDocs(id); } catch (e) { return sendErr(res, 400, e.message); }
      // Тайлан дээрх тэмдэглэлийн хувилбар (Claude Docs, comment-оор) — захирал зөвшөөрөөгүй бол бэлтгэгдэхгүй
      let an = null, anErr = null;
      try { an = buildAnnotated(id); } catch (e) { anErr = e.message; }
      log('DOCS_PREP', `${id} ok=${r.ok} leaks=${r.remaining_leak_tokens.length} fixed=${r.auto_fixed_leaks} annotated=${an ? an.ok : 'no'}`);
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        ok: r.ok && (!an || an.ok), issues: r.issues, sections: r.sections, auto_fixed_leaks: r.auto_fixed_leaks,
        remaining_leaks: r.remaining_leak_tokens.length + (an ? an.remaining_leaks : 0), pattern_redactions: r.pattern_redactions,
        command: an && an.ok ? `/publish-docs ${id} claude` : `/publish-docs ${id}`, doc_url: r.docs_state?.url || null,
        annotated: an ? { ok: an.ok, comments: an.anchored + an.general, chunks: an.chunks } : { ok: false, reason: anErr },
      }));
    }

    const om = rest.match(/^\/output\/([a-z_]+\.(md|json))$/);
    if (m === 'GET' && om) {
      const fname = om[1];
      if (!C.OUTPUT_FILES.includes(fname)) return sendErr(res, 404, 'Not found');
      const f = path.join(dir, 'sandbox', 'output', fname);
      if (!fs.existsSync(f)) return sendErr(res, 404, 'Not ready');
      const isJson = fname.endsWith('.json');
      const viewAll = U.can(session.role, 'issue.viewAll');
      if (!viewAll && fname === 'review_report.md') return deny();   // бүх саналтай архивын тайлан — зөвхөн захирал/хянагч
      const extra = {};
      if (url.searchParams.get('download')) { extra['Content-Disposition'] = `attachment; filename="${id}-${fname}"`; log('DOWNLOAD', `${id} ${fname}`); }
      let text = C.restoreTokens(dir, fs.readFileSync(f, 'utf8'), isJson);
      // Өөрөө шалгасан тайлан: бүх санал (захирлын шийдвэр байхгүй), зөвхөн захирлын сургамжийг хасна
      if (!viewAll && fname === 'review_findings.json') text = isPc ? stripLessons(text) : filterForAuditor(dir, text);
      return send(res, 200, isJson ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', text, extra);
    }
  }
  return sendErr(res, 404, 'Not found');
}

function onRequest(req, res) {
  handle(req, res).catch(e => {
    console.error(`[${C.timeHms()}] ERROR ${e.message}`);
    HF.report('ERROR', 'Вэб серверийн дотоод алдаа (HTTP 500)', `${req.method} ${String(req.url || '').split('?')[0]}: ${e.message}\n${e.stack || ''}`);
    if (!res.headersSent) { try { sendErr(res, 500, 'Серверийн алдаа'); } catch { /* ignore */ } }
  });
}

/* ---------- Эхлүүлэх ---------- */
// Сервер унтарч байхад тасарсан review-г "failed" болгоно
for (const id of listJobIds()) {
  const sf = path.join(jobDir(id), 'state.json'), st = C.readJson(sf);
  if (st && ['extracting', 'running'].includes(st.status)) {
    C.writeJson(sf, { ...st, status: 'failed', error: 'Сервер дахин эхэлсэн тул review тасарсан', finished: C.nowIso() });
    clearWorkFiles(jobDir(id));
  }
  // Ишлэлийн шалгалтгүй хуучин review-г нэг удаа шалгана (агентаар засуулахгүй — эх файл устсан)
  if (jobStatus(jobDir(id)) === 'done') {
    const f = C.readJson(path.join(jobDir(id), 'sandbox', 'output', 'review_findings.json'));
    if (f && !f.quote_verification) { try { verifyFindings(jobDir(id)); } catch (e) { console.error('verify:', e.message); } }
  }
}

const tls = LAN ? loadTls() : null;
const make = () => {
  const s = tls ? https.createServer({ ...(tls.pfx ? { pfx: tls.pfx, passphrase: tls.passphrase } : { key: tls.key, cert: tls.cert }), minVersion: 'TLSv1.2' }, onRequest) : http.createServer(onRequest);
  s.headersTimeout = 15000; s.requestTimeout = 10 * 60000; s.keepAliveTimeout = 5000;
  return s;
};
const binds = LAN ? [['::', false]] : [['127.0.0.1'], ['::1']];
let listening = 0;
for (const [host] of binds) {
  const s = make();
  s.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} ашиглагдаж байна (сервер аль хэдийн ажиллаж байж магадгүй). --port 9090 гэх мэтээр өөр port сонгоно уу.`); process.exit(1); }
    if (host === '::1') return; // IPv6 байхгүй бол IPv4-өөр л ажиллана
    throw e;
  });
  s.listen({ port: PORT, host, ipv6Only: false }, () => { if (++listening === 1) banner(); });
}

function banner() {
  const scheme = tls ? 'https' : 'http';
  accessLog('system', 'SERVER_START', `lan=${LAN} port=${PORT} efs=${EFS_ON} retention=${RETENTION_DAYS}`);
  if (HF.enabled()) { HF.start(); HF.report('INFO', 'Review Agent вэб сервер эхэллээ'); }
  console.log('\n  Audit Report Reviewer — вэб сервер ажиллаж байна (Node.js ' + process.version + ')');
  console.log(`  Энэ компьютер дээр : ${scheme}://localhost:${PORT}`);
  if (LAN) {
    for (const i of Object.values(os.networkInterfaces()).flat()) if (i && i.family === 'IPv4' && !i.internal) console.log(`  Дотоод сүлжээнд    : https://${i.address}:${PORT}`);
    console.log(`  Сертификат SHA256  : ${tls.fingerprint}`);
    console.log('                       Хөтөч анхааруулга гаргавал энэ fingerprint-тэй тулгаж баталгаажуулна.');
  } else console.log('  Сүлжээ             : хаалттай (нээх бол --lan, HTTPS-ээр)');
  if (U.hasAdmin()) console.log('  Нэвтрэлт           : нэрийн хэрэглэгч (admin нь вэб дээр хэрэглэгч нэмнэ)');
  else console.log(`  Анхны тохиргоо код : ${code}  ← вэб дээр энэ кодоор нэвтэрч admin үүсгэнэ`);
  console.log(`  Hefesto телеметр   : ${HF.enabled() ? 'идэвхтэй (heartbeat 60 сек)' : 'идэвхгүй (HEFESTO_BOT_TOKEN тохируулаагүй)'}`);
  console.log(`  Шифрлэлт (EFS)     : ${EFS_ON ? 'идэвхтэй' : 'ИДЭВХГҮЙ — IT-тай холбогдоно уу'}`);
  console.log(`  Хадгалах хугацаа   : ${RETENTION_DAYS} хоног (эх файл хувилбараар хадгалагдана)`);
  console.log('  Зогсоох            : Ctrl+C\n');
}

setInterval(() => { try { startNext(); } catch (e) { console.error('Queue error:', e.message); } }, 3000);
setInterval(() => { try { housekeeping(); } catch (e) { console.error('Housekeeping error:', e.message); } }, 10 * 60000);
setTimeout(() => { try { housekeeping(); } catch (e) { console.error(e.message); } }, 5000);

process.on('SIGINT', () => { if (active) for (const ch of active.ctl.children) killTree(ch); sessions.clear(); process.exit(0); });
