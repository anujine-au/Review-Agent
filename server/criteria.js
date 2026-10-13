'use strict';
/**
 * Шалгуурын баримтын сан (DOC-19xx, ДАГ аргачлал, ISO журам).
 * Тэмдэглэлийн «Эх сурвалж: DOC-1912 §5.2» → тухайн PDF-ийн яг тэр хэсэг.
 *
 *   node server/criteria.js build "<PDF-үүдийн хавтас>"   — criteria/ санг (дахин) үүсгэнэ
 *   node server/criteria.js find DOC-1912 "§5.2"           — хэсгийг хайж туршина
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const C = require('./common');

const DIR = path.join(C.PATHS.root, 'criteria');
const ID_RE = /^(DOC-\d{4}|DAG|ISO|GIAS|GIAS-TR|SP-0[1-4])$/;

function findPdftotext() {
  const la = process.env.LOCALAPPDATA || '', pf = process.env.ProgramFiles || 'C:\\Program Files';
  return C.findExecutable(['pdftotext.exe', 'pdftotext'], [
    path.join(la, 'Programs', 'Git', 'ucrt64', 'bin'), path.join(la, 'Programs', 'Git', 'mingw64', 'bin'),
    path.join(pf, 'Git', 'ucrt64', 'bin'), path.join(pf, 'Git', 'mingw64', 'bin'), 'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin',
  ]);
}

function docId(name) {
  const sp = name.match(/SP-118-04_0([1-4])_/i);
  if (sp) return 'SP-0' + sp[1];
  const m = name.match(/DOC-?\s?(\d{4})/i);
  if (m) return 'DOC-' + m[1];
  if (/ДАГ|аргачлал/i.test(name)) return 'DAG';
  if (/ISO/i.test(name)) return 'ISO';
  if (/globalinternalauditstandards/i.test(name)) return 'GIAS';
  if (/topical_requirements/i.test(name)) return 'GIAS-TR';
  return null;
}
const SP_TITLES = {
  'SP-01': 'SP-118-04 / 01 — Танилцуулга, шийдлийн загвар, workflow, use case',
  'SP-02': 'SP-118-04 / 02 — Шалгуурын каталог ба хамаарлын матриц (RP-SP11804-v1.0)',
  'SP-03': 'SP-118-04 / 03 — Backend техникийн тодорхойлолт',
  'SP-04': 'SP-118-04 / 04 — Agent System Prompt (PT-SP11804-SYS-v1.0)',
};
function docTitle(id, name) {
  if (SP_TITLES[id]) return SP_TITLES[id];
  if (id === 'GIAS') return 'GIAS 2024 — Global Internal Audit Standards (IIA)';
  if (id === 'GIAS-TR') return 'GIAS — Topical Requirements, хэрэглэх заавар (IIA)';
  if (id === 'DAG') return 'ДАГ — Аудитын тайлан бичих нэгдсэн аргачлал (2023.11.07)';
  if (id === 'ISO') return 'ISO 27001:2022 МАБМТ — Аудит хийх журам (2026.05.20)';
  return id + ' — ' + name.replace(/^DOC-?\d{4}_?/i, '').replace(/\s*\(\d+\)(?=\.pdf$)/i, '').replace(/(\.docx)?\.pdf$/i, '').replace(/_/g, ' ').trim();
}

function build(srcDir) {
  const exe = findPdftotext();
  if (!exe) throw new Error('pdftotext олдсонгүй');
  fs.mkdirSync(DIR, { recursive: true });
  const index = [];
  const prevIndex = (C.readJson(path.join(DIR, 'index.json')) || { docs: [] }).docs;   // өмнөх сан — нэмж шинэчилнэ, устгахгүй
  for (const name of fs.readdirSync(srcDir).filter(f => /\.pdf$/i.test(f)).sort()) {
    const id = docId(name);
    if (!id || index.some(d => d.id === id)) continue;   // давхардсан хуулбар «(1)»-ийг алгасна
    const src = path.join(srcDir, name);
    fs.copyFileSync(src, path.join(DIR, id + '.pdf'));
    const tmp = path.join(os.tmpdir(), `arr-crit-${process.pid}-${Date.now()}.txt`);
    spawnSync(exe, ['-enc', 'UTF-8', src, tmp], { windowsHide: true, stdio: 'ignore', timeout: 120000 });
    const raw = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
    C.rmrf(tmp);
    const blocks = [];
    raw.replace(/\u200b/g, '').split('\f').forEach((pg, pi) => {
      for (const para of pg.split(/(?:\r?\n[ \t]*){2,}/)) {
        const text = para.split(/\r?\n/).map(s => s.trim()).join(' ').replace(/\s+/g, ' ').trim();
        if (text && !/^\d+$/.test(text)) blocks.push({ page: pi + 1, text });
      }
    });
    const doc = { id, title: docTitle(id, name), file: name, pages: raw.split('\f').length, has_text: blocks.length > 0, blocks };
    C.writeJson(path.join(DIR, id + '.json'), doc);
    index.push({ id, title: doc.title, file: name, pages: doc.pages, has_text: doc.has_text });
    console.log(`${id.padEnd(9)} ${String(blocks.length).padStart(4)} догол мөр  ${name}`);
  }
  const merged = [...prevIndex.filter(d => !index.some(x => x.id === d.id)), ...index].sort((a, b) => a.id.localeCompare(b.id));
  C.writeJson(path.join(DIR, 'index.json'), { built: C.nowIso(), docs: merged });
  return index;
}

function load(id) {
  if (!ID_RE.test(id)) return null;
  return C.readJson(path.join(DIR, id + '.json'));
}
const pdfPath = id => (ID_RE.test(id) && fs.existsSync(path.join(DIR, id + '.pdf')) ? path.join(DIR, id + '.pdf') : null);
const listDocs = () => (C.readJson(path.join(DIR, 'index.json')) || { docs: [] }).docs;

/* ---------- Хэсэг хайх ---------- */
const LAT2CYR = { A: 'А', B: 'В', C: 'С', E: 'Е' };
const CYR2LAT = Object.fromEntries(Object.entries(LAT2CYR).map(([k, v]) => [v, k]));
const NB = '(?<![0-9A-Za-zА-ЯӨҮа-яөү.§])';   // өмнө нь үсэг, цифр, цэг, § байхгүй
const SECT_RE = /(?<=^|\s)(?:\d+(?:\.\d+)+|\d+\.|[А-ЯA-Z](?:\.\d+)+)\.?\s(?=[А-ЯӨҮA-Z(«“"])/g;   // дараагийн хэсгийн дугаар
const depth = s => s.split('.').filter(Boolean).length;

// ДАГ аргачлал: writing_standard.md-ийн гарчиг → PDF дээрх үг хэллэг
const DAG_TITLES = {
  'нүүр хуудас': 'Тайлангийн нүүр хуудас', 'хавсралт': 'хавсралтыг шар өнгөөр', 'тоочих': 'Тоочсон мэдээлэл',
  'огноо, хугацаа': 'Хугацаа, тоон мэдээлэл', 'мөнгөн дүн': 'Хүснэгт болон хавсралтад 241,587.86',
  'хүснэгт, зураг': 'Хүснэгтэн мэдээлэл, зураг', 'товчлол': 'Нэрийн товчлол', 'бусад': '6. Бусад',
  'зөв бичих': 'Зарим үгийн бичилт',
};
const DAG_SECTIONS = { 1: 'Дүрмийн болон найруулгын алдаагүй', 2: 'Хоёр. Аудитын тайлан бичих', 3: 'доорх матрицыг ашиглан', 4: 'Хангалттай сайн болон Сайн', 5: '3. Тайланг мэдээлэх', 6: '4. Тайлан бичихэд мөрдлөг' };

function phraseHit(doc, phrase, from = 0, to = doc.blocks.length) {
  const low = phrase.toLowerCase();
  for (let i = from; i < to; i++) {
    const k = doc.blocks[i].text.toLowerCase().indexOf(low);
    if (k >= 0) return { block: i, start: k, end: Math.min(doc.blocks[i].text.length, nextSection(doc.blocks[i].text, k + phrase.length)) };
  }
  return null;
}
function nextSection(text, from) {
  SECT_RE.lastIndex = from;
  const m = SECT_RE.exec(text);
  return m ? m.index : text.length;
}

function findDag(doc, sec) {
  const h = findDag1(doc, sec);
  // Богино гарчиг бол дараагийн 3 догол мөрийг хамруулна
  if (h && h.end - h.start < 60) {
    const len = doc.blocks[h.block].text.length;
    h.end = Math.min(len, h.start + 600);
    if (h.end === len) h.to_block = Math.min(doc.blocks.length - 1, h.block + 3);
  }
  return h;
}
function findDag1(doc, sec) {
  const s =sec.replace(/^§\s*/, '').trim();
  const title = (s.match(/[«“"](.+?)[»”"]/) || [])[1];
  if (title && DAG_TITLES[title.toLowerCase()]) return phraseHit(doc, DAG_TITLES[title.toLowerCase()]);
  if (/нүүр/i.test(s)) return phraseHit(doc, DAG_TITLES['нүүр хуудас']);
  // «зарчим 8» эсвэл «§1.8» → Нэг дэх хэсгийн 8-р заалт
  const pm = s.match(/зарчим\s*(\d+)/i) || s.match(/^1\.(\d+)$/);
  if (pm) {
    const stop = doc.blocks.findIndex(b => /^Хоёр\./.test(b.text));
    const re = new RegExp(`${NB}${pm[1]}\\.\\s`);
    for (let i = 0; i < (stop < 0 ? doc.blocks.length : stop); i++) {
      const m = re.exec(doc.blocks[i].text);
      if (m) { const t = doc.blocks[i].text; const e = t.slice(m.index + m[0].length).search(/(?<=\s)\d+\.\s/); return { block: i, start: m.index, end: e < 0 ? t.length : m.index + m[0].length + e }; }
    }
    return null;
  }
  const n = s.match(/^(\d+)/);
  if (n && DAG_SECTIONS[n[1]]) return phraseHit(doc, DAG_SECTIONS[n[1]]);
  return null;
}

function find(doc, secRaw) {
  if (!doc || !doc.has_text || !secRaw) return null;
  if (doc.id === 'DAG') return findDag(doc, secRaw);
  let s = String(secRaw).replace(/^§\s*/, '').replace(/\s+/g, ' ').trim();
  let pat;
  const app = s.match(/^Хав(?:сралт)?\.?\s*([А-ЯA-Z])(?:\s*\.?\s*([\d.]+))?$/i);
  if (app && app[2]) s = app[1] + '.' + app[2].replace(/^\.|\.$/g, '');
  const variants = ch => [ch, LAT2CYR[ch] || CYR2LAT[ch]].filter(Boolean);
  const pats = [];
  if (app && !app[2]) for (const L of variants(app[1].toUpperCase())) pats.push(new RegExp(`Хавсралт\\s+${L}\\.`, 'g'), new RegExp(`Хавсралт\\s+${L}(?=\\s)`, 'g'));
  else if (/^[А-ЯA-Z](\.\d+)+$/i.test(s)) for (const L of variants(s[0].toUpperCase())) pats.push(new RegExp(`${NB}${L}${C.escRe(s.slice(1))}\\.?(?=\\s)`, 'g'));
  else if (/^\d+(\.\d+)*$/.test(s)) pats.push(new RegExp(`${NB}${C.escRe(s)}${s.includes('.') ? '\\.?' : '\\.'}(?=\\s)`, 'g'));
  else return null;
  // Хамгийн «гарчиг шиг» тохиолдлыг сонгоно: догол мөрийн эхэнд, араас нь урт текст (агуулгын жагсаалт биш)
  let best = null;
  for (pat of pats) {
    doc.blocks.forEach((b, i) => {
      for (const m of b.text.matchAll(pat)) {
        const atStart = m.index === 0 ? 3 : /[.:;]\s$/.test(b.text.slice(Math.max(0, m.index - 2), m.index)) ? 2 : 0;
        const score = atStart + (b.text.length - m.index > 120 ? 1 : 0) + (pat === pats[0] ? 0.5 : 0);
        if (!best || score > best.score) best = { score, block: i, start: m.index, len: m[0].length };
      }
    });
    if (best && best.score >= 3.5) break;
  }
  if (!best) return null;
  const t = doc.blocks[best.block].text;
  const hit = { block: best.block, start: best.start, end: nextSection(t, best.start + best.len) };
  // Зөвхөн гарчиг бол дараагийн ижил/дээд түвшний хэсэг хүртэлх догол мөрүүдийг хамруулна
  if (hit.end - hit.start < 100 && hit.end === t.length) {
    const d = depth(s.replace(/^[А-ЯA-Z]/i, 'X'));
    let j = best.block + 1;
    for (; j < doc.blocks.length && j <= best.block + 25; j++) {
      const m = doc.blocks[j].text.match(/^(\d+(?:\.\d+)*|[А-ЯA-Z](?:\.\d+)+|Хавсралт)\.?\s/);
      if (m && (m[1] === 'Хавсралт' || depth(m[1].replace(/^[А-ЯA-Z]/i, 'X')) <= d)) break;
    }
    hit.to_block = j - 1;
  }
  return hit;
}

module.exports = { DIR, build, load, find, pdfPath, listDocs };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'build') build(a || path.join(os.homedir(), 'Downloads', 'Агентын шаардлагууд'));
  else if (cmd === 'find') {
    const doc = load(a), h = find(doc, b);
    if (!h) console.log('олдсонгүй');
    else { const t = doc.blocks[h.block]; console.log(`P${h.block} х.${t.page}${h.to_block ? ` → P${h.to_block}` : ''}: ${t.text.slice(h.start, Math.min(h.end, h.start + 220))}`); }
  } else console.log('node server/criteria.js build "<хавтас>" | find <DOC-ID> "<хэсэг>"');
}
