'use strict';
/*
  Нэрийн хэрэглэгч ба role (DOC-1917: хэн юу хийснийг нэрээр бүртгэх).
  Файл: web/users.json (EFS шифрлэлттэй; Claude-ийн sandbox руу хуулагддаггүй хавтас).
  Нууц үг: scrypt (salt-тай hash) — жинхэнэ нууц үг хаана ч хадгалагдахгүй.

  Сэргээх (нууц үгээ мартсан, admin түгжигдсэн үед) — серверийн компьютер дээр:
    node server/users.js list
    node server/users.js add <нэр> <admin|cae|lead_auditor|auditor> ["Бүтэн нэр"]   → түр нууц үг хэвлэнэ
    node server/users.js set <нэр> <нууц үг>                                       → байнгын нууц үг (солиулахгүй)
    node server/users.js reset <нэр>                                               → түр нууц үг хэвлэнэ
    node server/users.js disable <нэр> | enable <нэр>
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./common');

const FILE = process.env.AR_USERS_FILE || path.join(C.PATHS.web, 'users.json'); // AR_USERS_FILE: зөвхөн тестэд
// SP-118-04/01 §5 RBAC: cae = ДАГ-ын захирал, lead_auditor = ахлах аудитор, auditor = аудитор, viewer = харах.
// «Менежер / хянагч» (reviewer), «Удирдлага (харах)» (viewer) role-уудыг 2026-10-12 хассан — байгууллагад ийм албан тушаал байхгүй. PERMS-д үлдээсэн нь хуучин бүртгэлтэй нийцүүлэх зорилготой.
const ROLES = {
  admin: 'Admin',
  cae: 'ДАГ-ын захирал',
  lead_auditor: 'Ахлах аудитор',
  auditor: 'Аудитор',
};
// Үйлдэл → зөвшөөрөгдсөн role
const PERMS = {
  'job.viewAll': ['admin', 'cae', 'reviewer', 'viewer'],   // бусдын review-г харах (аудитор зөвхөн өөрийнхийг)
  'job.create': ['admin', 'cae', 'reviewer', 'lead_auditor', 'auditor'],
  'job.cancelAny': ['admin', 'cae', 'reviewer'],
  'job.delete': ['admin', 'cae', 'reviewer'],
  'docs.prep': ['admin', 'cae', 'reviewer'],
  'issue.decide': ['admin', 'cae', 'reviewer'],   // санал зөвшөөрөх / засах / татгалзах (S5; менежер — захирлын эрх шилжүүлснээр)
  'issue.viewAll': ['admin', 'cae', 'reviewer', 'viewer'],   // аудитор зөвхөн захирлын зөвшөөрсөн саналыг харна
  'job.finalize': ['admin', 'cae'],
  'job.runAI': ['cae', 'admin'],           // «AI хянуулах» — илгээсэн тайланг AI-аар шалгуулж эхлүүлэх (захирал өөрөө сонгоно)
  'job.release': ['cae'],                  // «Батлаад илгээх» — feedback-ийг аудиторт (зөвхөн захирал)
  'job.downloadFinal': ['cae', 'admin'],   // эцсийн тайлан (.docx / PDF / бүх хувилбар ZIP)
  'job.cancelWorkflow': ['cae', 'admin'],  // ажлын урсгалыг цуцлах (тайлбартай)        // эцсийн батлалт, бүртгэлийн дугаар, архив (S10 — зөвхөн захирал)
  'logs.view': ['admin', 'cae', 'reviewer'],      // AI Run Log, шийдвэрийн лог, hash-chain шалгалт
  'users.manage': ['admin'],
};
const can = (role, action) => (PERMS[action] || []).includes(role);

const USER_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
function normUser(u) { return String(u || '').trim().toLowerCase().replace(/@netgroup\.mn$/, ''); }

function load() { return C.readJson(FILE) || { users: {} }; }
function save(db) { C.writeJson(FILE, db); C.enableEfs(FILE); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}
/** Нууц үгийн бодлого: зөвхөн хоосон биш (тэмдэгтийн шаардлагагүй) */
function passwordProblem(pw, username) {
  // 2026-10-12 хэрэглэгчийн шийдвэр: тэмдэгтийн шаардлага (урт, үсэг + тоо, нэр агуулахгүй) хассан — зөвхөн хоосон биш байх
  const s = String(pw || '');
  if (!s.trim()) return 'Нууц үг хоосон байж болохгүй';
  return null;
}
// Анхны (түр) нууц үг: web/auth_settings.json-д initial_password заасан бол бүх шинэ/шинэчилсэн хэрэглэгчид
// тэр нууц үгийг өгнө (admin-ы шийдвэр, 2026-10-08), үгүй бол санамсаргүй. Аль ч тохиолдолд эхний нэвтрэлтэд солиулна.
const SETTINGS_FILE = path.join(path.dirname(FILE), 'auth_settings.json');
const tempPassword = () => (C.readJson(SETTINGS_FILE) || {}).initial_password ||
  C.randomString(4, 'abcdefghjkmnpqrstuvwxyz') + '-' + C.randomString(4, '23456789') + '-' + C.randomString(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ');

const hasAdmin = (db = load()) => Object.values(db.users).some(u => u.role === 'admin' && !u.disabled);
function publicUser(name, u) {
  return { username: name, name: u.name || '', role: u.role, role_label: ROLES[u.role] || u.role, disabled: !!u.disabled, must_change: !!u.must_change, created: u.created, last_login: u.last_login || null, prev_login: u.prev_login || null, password_changed: u.password_changed || null };
}
function list() { const db = load(); return Object.entries(db.users).map(([n, u]) => publicUser(n, u)).sort((a, b) => a.username.localeCompare(b.username)); }

/** Шинэ хэрэглэгч. password өгөөгүй бол түр нууц үг үүсгэж буцаана (эхний нэвтрэлтэд солиулна). */
function addUser({ username, role, name = '', password = null, by = 'system' }) {
  const u = normUser(username);
  if (!USER_RE.test(u)) throw new Error('Нэвтрэх нэр: 3–40 латин жижиг үсэг, тоо, . _ - (жишээ: anujin.e)');
  if (!ROLES[role]) throw new Error('Role буруу');
  const db = load();
  if (db.users[u]) throw new Error('Ийм нэртэй хэрэглэгч бүртгэлтэй байна');
  let temp = null;
  if (password) { const pr = passwordProblem(password, u); if (pr) throw new Error(pr); } else temp = tempPassword();
  db.users[u] = { name: String(name).slice(0, 80), role, hash: hashPassword(password || temp), must_change: !password, disabled: false, created: C.nowIso(), created_by: by };
  save(db);
  return { username: u, temp_password: temp };
}
function updateUser(username, { role, disabled, name, reset, password }, by = 'system') {
  const u = normUser(username), db = load(), rec = db.users[u];
  if (!rec) throw new Error('Хэрэглэгч олдсонгүй');
  const next = { ...rec };
  if (role !== undefined) { if (!ROLES[role]) throw new Error('Role буруу'); next.role = role; }
  if (disabled !== undefined) next.disabled = !!disabled;
  if (name !== undefined) next.name = String(name).slice(0, 80);
  // Сүүлчийн идэвхтэй admin-ыг бууруулах/идэвхгүй болгохыг хориглоно (түгжигдэхээс сэргийлнэ)
  const after = { ...db.users, [u]: next };
  if (!Object.values(after).some(x => x.role === 'admin' && !x.disabled)) throw new Error('Дор хаяж нэг идэвхтэй admin үлдэх ёстой');
  let temp = null;
  if (reset) { temp = tempPassword(); next.hash = hashPassword(temp); next.must_change = true; }
  // Admin-ы өгсөн байнгын нууц үг (2026-10-12 хэрэглэгчийн шийдвэр: нэг удаагийн нууц үг солиулахгүй)
  if (password !== undefined) { const pr = passwordProblem(password, u); if (pr) throw new Error(pr); next.hash = hashPassword(password); next.must_change = false; next.password_set_by = by; next.password_changed = C.nowIso(); }
  next.updated = C.nowIso(); next.updated_by = by;
  db.users[u] = next; save(db);
  return { username: u, temp_password: temp };
}
/** Нэвтрэх нэр солих. Хуучин бүртгэлийг шинэ нэр рүү шилжүүлнэ (нууц үг, role хэвээр). */
function renameUser(oldName, newName, by = 'system') {
  const o = normUser(oldName), n = normUser(newName), db = load();
  if (!db.users[o]) throw new Error('Хэрэглэгч олдсонгүй');
  if (!USER_RE.test(n)) throw new Error('Нэвтрэх нэр: 3–40 латин жижиг үсэг, тоо, . _ - (жишээ: bat.b)');
  if (o === n) return { username: n };
  if (db.users[n]) throw new Error('Ийм нэртэй хэрэглэгч бүртгэлтэй байна');
  db.users[n] = { ...db.users[o], renamed_from: o, updated: C.nowIso(), updated_by: by };
  delete db.users[o];
  save(db);
  return { username: n, from: o };
}
function changePassword(username, oldPw, newPw) {
  const u = normUser(username), db = load(), rec = db.users[u];
  if (!rec || !checkPassword(oldPw, rec.hash)) throw new Error('Одоогийн нууц үг буруу');
  const pr = passwordProblem(newPw, u); if (pr) throw new Error(pr);
  if (checkPassword(newPw, rec.hash)) throw new Error('Шинэ нууц үг хуучнаасаа өөр байх ёстой');
  rec.hash = hashPassword(newPw); rec.must_change = false; rec.password_changed = C.nowIso();
  save(db);
}
/** Нэвтрэх: амжилттай бол хэрэглэгчийн мэдээлэл, үгүй бол null (нэр байгаа эсэхийг илчлэхгүй) */
function authenticate(username, password) {
  const u = normUser(username), db = load(), rec = db.users[u];
  // Нэр байхгүй үед ч hash тооцож хугацааг ижил байлгана
  const ok = checkPassword(password, rec ? rec.hash : 'scrypt$00$' + '00'.repeat(64));
  if (!rec || !ok || rec.disabled) return null;
  rec.prev_login = rec.last_login || null; rec.last_login = C.nowIso(); save(db);
  return publicUser(u, rec);
}
function getUser(username) { const db = load(), rec = db.users[normUser(username)]; return rec ? publicUser(normUser(username), rec) : null; }

/** Нэвтрэлт шаардах эсэх. web/auth_settings.json → login_required: false бол нэвтрэлтгүй (admin-ы шийдвэр). */
const loginRequired = () => (C.readJson(SETTINGS_FILE) || {}).login_required !== false;
function setLoginRequired(on) { const s = C.readJson(SETTINGS_FILE) || {}; s.login_required = !!on; s.login_changed_at = C.nowIso(); C.writeJson(SETTINGS_FILE, s); C.enableEfs(SETTINGS_FILE); }

module.exports = { loginRequired, setLoginRequired, ROLES, PERMS, can, normUser, hasAdmin, list, addUser, updateUser, renameUser, changePassword, authenticate, getUser, passwordProblem };

/* ---------- CLI (сэргээх) ---------- */
if (require.main === module) {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  try {
    if (cmd === 'list') for (const u of list()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.disabled ? 'ИДЭВХГҮЙ' : ''} ${u.name}`);
    else if (cmd === 'add') { const r = addUser({ username: a1, role: a2, name: a3 || '', by: 'cli' }); console.log(`Нэмлээ: ${r.username}\nТүр нууц үг: ${r.temp_password}\n(Эхний нэвтрэлтэд солиулна)`); }
    else if (cmd === 'delete') {
      // Бүрмөсөн устгах (review-ийн бүртгэлд нэр нь хэвээр үлдэнэ). Сүүлчийн идэвхтэй admin-ыг устгахгүй.
      const u = normUser(a1), db = load();
      if (!db.users[u]) throw new Error('Хэрэглэгч олдсонгүй');
      const rest = Object.entries(db.users).filter(([n]) => n !== u);
      if (!rest.some(([, x]) => x.role === 'admin' && !x.disabled)) throw new Error('Дор хаяж нэг идэвхтэй admin үлдэх ёстой');
      delete db.users[u]; save(db);
      console.log(`Устгалаа: ${u}`);
    }
    else if (cmd === 'set') { if (!a2) throw new Error('node server/users.js set <нэр> <нууц үг>'); const r = updateUser(a1, { password: a2 }, 'cli'); console.log(`Нууц үг тохирууллаа: ${r.username} (солиулахгүй)`); }
    else if (cmd === 'reset') { const r = updateUser(a1, { reset: true }, 'cli'); console.log(`Түр нууц үг (${r.username}): ${r.temp_password}`); }
    else if (cmd === 'login') { if (!['on', 'off'].includes(a1)) throw new Error('login on | login off'); setLoginRequired(a1 === 'on'); console.log(`Нэвтрэлт: ${a1 === 'on' ? 'ШААРДАНА' : 'ШААРДАХГҮЙ'} (серверийг дахин асаах шаардлагагүй)`); }
    else if (cmd === 'disable' || cmd === 'enable') { updateUser(a1, { disabled: cmd === 'disable' }, 'cli'); console.log('OK'); }
    else console.log('Хэрэглээ: node server/users.js login on|off | list | add <нэр> <admin|cae|lead_auditor|auditor> ["Бүтэн нэр"] | reset <нэр> | disable <нэр> | enable <нэр>');
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}
