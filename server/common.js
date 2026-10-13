'use strict';
// Нийтлэг тогтмол, туслах функцууд (сервер, runner, extract хуваалцана)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PATHS = {
  root: ROOT,
  web: path.join(ROOT, 'web'),
  jobs: process.env.AR_JOBS_DIR || path.join(ROOT, 'jobs'),          // AR_*_DIR: зөвхөн тестэд
  logs: process.env.AR_LOGS_DIR || path.join(ROOT, 'logs'),
  archive: process.env.AR_ARCHIVE_DIR || path.join(ROOT, 'archive'),  // эцэслэн батлагдсан тайлан (10 жил)
  prompts: path.join(ROOT, 'prompts'),
  config: path.join(ROOT, 'config'),
  codeFile: path.join(ROOT, 'web', 'access_code.txt'),
};

const CATEGORIES = ['report', 'excel', 'program', 'evidence', 'followup'];
const ALLOWED_EXT = ['.docx', '.pdf', '.xlsx', '.xlsm', '.csv', '.txt', '.md', '.png', '.jpg', '.jpeg'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg'];
const OUTPUT_FILES = ['review_report.md', 'review_findings.json', 'review_summary.json', 'recheck.json'];
const TOKEN_RE = /\[(PERSON|ID|PHONE|EMAIL|ADDR|ACCT)-\d{4}\]/g;

function nowIso() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function timeHms() { return nowIso().slice(11); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// Атомаар бичих: эхлээд .tmp файлд, дараа нь сольж нэрлэнэ
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function randomString(len, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

// Windows EFS шифрлэлт (cipher.exe). Хавтасны шинэ файлууд автоматаар шифрлэгдэнэ.
function enableEfs(target) {
  if (process.platform !== 'win32') return false;
  try {
    const isDir = fs.statSync(target).isDirectory();
    spawnSync('cipher.exe', isDir ? ['/e', `/s:${target}`] : ['/e', target], { windowsHide: true, stdio: 'ignore' });
    return isEncrypted(target);
  } catch { return false; }
}
function isEncrypted(target) {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `[bool]((Get-Item -LiteralPath '${target.replace(/'/g, "''")}' -Force).Attributes -band [IO.FileAttributes]::Encrypted)`],
  { windowsHide: true, encoding: 'utf8' });
  return /True/.test(r.stdout || '');
}

// Token-уудыг жинхэнэ утгаар буцааж солих (зөвхөн хэрэглэгчид харуулахдаа)
function restoreTokens(jobDir, text, asJson) {
  const map = readJson(path.join(jobDir, 'mask_map.json'));
  if (!map) return text;
  return text.replace(TOKEN_RE, tok => {
    if (!Object.prototype.hasOwnProperty.call(map, tok)) return tok;
    const v = String(map[tok]);
    return asJson ? JSON.stringify(v).slice(1, -1) : v;
  });
}

/* ---------- Монгол нэрийн хэлбэр: маск ба алдагдлын шалгалтад хуваалцана ---------- */
// Нөхцөл залгавар (Зоригоо-гийн, Бат-Эрдэн-ийн). Ганц «т» (Эрдэнэ-т) салбарын нэртэй андуурагддаг тул оруулаагүй.
const MN_SUFFIX = '(?:ийн|ын|ний|гийн|ин|ийг|ыг|г|ад|эд|од|өд|д|аас|ээс|оос|өөс|гаас|гээс|тай|тэй|той|аар|ээр|оор|өөр|гаар|гээр|руу|рүү|луу|лүү|ч|аа|ээ|оо|өө|гаа|гээ)?';
const WB = '(?<![\\p{L}\\p{N}])', WE = '(?![\\p{L}\\p{N}])';
// Хувийн мэдээллийн баганад орсон ч нийтлэг үг (нэр биш) — хайхгүй
const NAME_STOPWORDS = new Set(['өөрөө', 'байхгүй', 'тийм', 'үгүй', 'нийт', 'бусад', 'тодорхойгүй', 'хамаарал', 'ажилтан', 'харилцагч', 'зээлдэгч', 'салбар', 'хэвийн', 'дутуу',
  // ураг төрлийн нэр томьёо («хамаарал» баганаас)
  'эхнэр', 'нөхөр', 'охин', 'хүргэн', 'хүүхэд', 'эцэг', 'аав', 'ээж', 'өвөө', 'эмээ', 'хадам', 'ах дүү', 'эгч дүү', 'төрөл', 'садан']);
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const endsVowel = v => v.length >= 5 && /[аэиоуөүяеё]$/i.test(v);
/** Утгын regex: 5+ үсэгтэй, эгшгээр төгссөн бол эцсийн эгшиг гээгдэж болно (Эрдэнэ → Эрдэн-ийн) */
const stemRe = v => endsVowel(v) ? `${escRe(v.slice(0, -1))}(?:${escRe(v.slice(-1))})?` : escRe(v);
/** (token, утга) хосууд: 4+ тэмдэгт, нийтлэг үг биш, аудитын нэр/салбарын үгтэй давхцахгүй; урт нь эхэндээ */
function sensitivePairs(map, allowText = '') {
  const allow = new Set(String(allowText).toLowerCase().match(/[\p{L}\p{N}-]+/gu) || []);
  return Object.entries(map || {})
    .map(([t, v]) => [t, String(v).trim()])
    .filter(([, v]) => v.length >= 4 && !NAME_STOPWORDS.has(v.toLowerCase()) && !allow.has(v.toLowerCase()))
    .sort((a, b) => b[1].length - a[1].length);
}
/** Текстэд жинхэнэ утга (залгавартай хэлбэрийг оруулаад) үлдсэн эсэх — зөвхөн token-уудыг буцаана */
function findLeaks(text, map, allowText) {
  const pairs = sensitivePairs(map, allowText), hits = new Set();
  for (let k = 0; k < pairs.length; k += 300) {
    const chunk = pairs.slice(k, k + 300);
    const re = new RegExp(`${WB}(${chunk.map(([, v]) => stemRe(v)).join('|')})(?=${MN_SUFFIX}${WE})`, 'giu');
    for (const m of text.matchAll(re)) {
      const l = m[1].toLowerCase();
      const p = chunk.find(([, v]) => v.toLowerCase() === l) || chunk.find(([, v]) => endsVowel(v) && v.toLowerCase().slice(0, -1) === l);
      if (p) hits.add(p[0]);
    }
  }
  return [...hits];
}

function findExecutable(names, extraDirs = []) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const d of dirs) for (const n of names) {
    const f = path.join(d, n);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/** Гарчиг цэвэрлэх: зай нэгтгэх, хашилтын дотор талын зай, эхэн/төгсгөлд ганцаар үлдсэн хашилт */
function normTitle(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  // Хос хашилтын дотор талын зай: “ X ” → “X”, « X » → «X», " X " → "X" (шулуун хашилтыг хосоор нь)
  t = t.replace(/([“„])\s*([^“”„]*?)\s*”/g, '$1$2”').replace(/«\s*([^«»]*?)\s*»/g, '«$1»').replace(/"\s*([^"]*?)\s*"/g, '"$1"');
  // Хосгүй үлдсэн эхний / сүүлийн хашилт
  const cnt = re => (t.match(re) || []).length;
  if (/^[“„«]/.test(t) && cnt(/[“„«]/g) > cnt(/[”»]/g)) t = t.slice(1);
  if (/[”»]$/.test(t) && cnt(/[”»]/g) > cnt(/[“„«]/g)) t = t.slice(0, -1);
  if (cnt(/"/g) % 2 === 1) { if (t.startsWith('"')) t = t.slice(1); else if (t.endsWith('"')) t = t.slice(0, -1); }
  // Нэр бүхэлдээ нэг хос хашилтад байвал хашилтыг авна («"ЭРДЭНЭТ"» → «ЭРДЭНЭТ»)
  const w = t.match(/^["“«„]([^"“”«»„]+)["”»]$/);
  if (w) t = w[1];
  return t.replace(/^["'“”«»\s]+$/, '').trim();
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

module.exports = {
  PATHS, CATEGORIES, ALLOWED_EXT, IMAGE_EXT, OUTPUT_FILES, TOKEN_RE,
  nowIso, timeHms, readJson, writeJson, randomString, enableEfs, isEncrypted, restoreTokens, findExecutable, rmrf, normTitle,
  MN_SUFFIX, WB, WE, NAME_STOPWORDS, escRe, endsVowel, stemRe, sensitivePairs, findLeaks,
};
