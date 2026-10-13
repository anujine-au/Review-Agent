'use strict';
/*
  Оруулсан эх файлууд — хувилбар (review / дахин хяналт) бүрээр хадгалж, татаж авах боломжтой.
  Review дуусмагц input/-ийг устгахын оронд jobs/<id>/originals/<ангилал>/<файл> руу ШИЛЖҮҮЛНЭ (jobs/ нь EFS шифрлэлттэй).
  Системийн автоматаар хавсаргасан файл (төвийн RPT-175, зөвлөмжийн шаардлага) хадгалагдахгүй — тэдгээр нь эх файл биш.
  originals/index.json: [{ cat, name, size, sha256, source: 'upload' | 'link', host?, saved_at }]
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./common');

const DIR = 'originals';
const indexOf = jobDir => C.readJson(path.join(jobDir, DIR, 'index.json')) || [];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** input/ дахь хэрэглэгчийн файлуудыг originals/ руу шилжүүлнэ (давтан дуудаж болно).
 *  copy: true — илгээх агшинд ХУУЛНА (AI шалгалт input-ийг ашигласаар байна); дараа нь preserve() давхардуулахгүй. */
function preserve(jobDir, { copy = false } = {}) {
  const inDir = path.join(jobDir, 'input');
  if (!fs.existsSync(inDir)) return 0;
  const job = C.readJson(path.join(jobDir, 'job.json')) || {};
  const auto = new Set([job.followup_auto?.file].filter(Boolean).map(f => `followup/${f}`));
  const links = job.link_sources || {};
  const idx = indexOf(jobDir);
  let n = 0;
  for (const cat of fs.readdirSync(inDir)) {
    const cd = path.join(inDir, cat);
    if (!fs.statSync(cd).isDirectory() || cat === 'recreq') continue;
    for (const name of fs.readdirSync(cd)) {
      const src = path.join(cd, name);
      if (!fs.statSync(src).isFile() || name === '.gitkeep' || auto.has(`${cat}/${name}`)) continue;
      const destDir = path.join(jobDir, DIR, cat);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, name);
      if (idx.some(x => x.cat === cat && x.name === name)) continue;
      if (copy) fs.copyFileSync(src, dest);
      else { try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); } }
      const lk = links[`${cat}/${name}`];
      // link_sources: хуучин хэлбэр — host мөр; шинэ — { host, url, fetched_at, sha256 }
      const lo = lk ? (typeof lk === 'string' ? { host: lk } : lk) : null;
      idx.push({ cat, name, size: fs.statSync(dest).size, sha256: sha256(dest), source: lo ? 'link' : 'upload', ...(lo ? { host: lo.host, url: lo.url, fetched_at: lo.fetched_at } : {}),
        uploaded_by: job.created_by || null, version: job.parent_id ? (job.round || 1) + 1 : 1, saved_at: C.nowIso() });
      n++;
    }
  }
  if (n) C.writeJson(path.join(jobDir, DIR, 'index.json'), idx);
  return n;
}

/** Нэг файлын бүтэн зам (жагсаалтад бүртгэлтэй байх ёстой — path traversal-аас хамгаална) */
function fileOf(jobDir, cat, name) {
  const it = indexOf(jobDir).find(x => x.cat === cat && x.name === name);
  if (!it) return null;
  const p = path.join(jobDir, DIR, it.cat, it.name);
  return fs.existsSync(p) ? { ...it, path: p } : null;
}

/** Архив руу хуулна (эцсийн батлалт): <dest>/<prefix>/<cat>/<name> */
function copyTo(jobDir, dest) {
  let n = 0;
  for (const it of indexOf(jobDir)) {
    const p = path.join(jobDir, DIR, it.cat, it.name);
    if (!fs.existsSync(p)) continue;
    fs.mkdirSync(path.join(dest, it.cat), { recursive: true });
    fs.copyFileSync(p, path.join(dest, it.cat, it.name));
    n++;
  }
  if (n) C.writeJson(path.join(dest, 'index.json'), indexOf(jobDir));
  return n;
}

const snapshot = jobDir => preserve(jobDir, { copy: true });

module.exports = { preserve, snapshot, list: indexOf, fileOf, copyTo, DIR };
