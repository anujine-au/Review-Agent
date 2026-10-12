'use strict';
/*
  Зөвлөмжийн шаардлага — «RPT175 Нөлөөллийн матриц» (claude.ai artifact, impact-data.js)-аас импортолсон лавлагаа.
  Матриц нь RPT-175-ын зөвлөмж бүрийг баримтын сантай холбож: аль DOC-д, аль бүлэгт, ямар төрлийн шаардлага
  (ХАРИУЦАГЧ/ЭРХ, ХУГАЦАА/SLA, НОТОЛГОО, ХААЛТ/GATE …) буухыг гаргасан. Review-д үүнийг M08-08…M08-12-оор ашиглана.

  Хадгалалт: recreq/current.json (өгөгдлийн хэмнэлт — баримтын эшлэл (cur), дам нөлөө (ripple)-г авахгүй).
  Review бүрт тухайн нэгжийн мөрүүд + баримтын каталогийг input/recreq/-д текст болгон хавсаргана (далдлалт ердийнх шиг).

  CLI: node server/recreq.js import "<impact-data.js>"   |   node server/recreq.js show [салбар]
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const FU = require('./followup');

const DIR = process.env.AR_RECREQ_DIR || path.join(C.PATHS.root, 'recreq');
const CUR_JSON = () => path.join(DIR, 'current.json');

// Матрицын шаардлагын төрлүүд (spec.tag) — тайлангийн зөвлөмжийг шалгах бүрдэл
const TAGS = {
  'ХАРИУЦАГЧ / ЭРХ': 'хэн хийх, хэн батлах (албан тушаал / газар)',
  'ХУГАЦАА / SLA': 'хэзээ гэхэд, ямар давтамжтай, хэдэн хоногт',
  'НОТОЛГОО': 'хэрэгжсэнийг юугаар нотлох (бүртгэл, баримт, систем)',
  'ХААЛТ / GATE': 'хориг, урьдчилсан нөхцөл — хангаагүй бол үйлдэл хийгдэхгүй',
  'БОСГО / ХЯЗГААР': 'тоон босго, лимит',
  'ШАЛГУУР': 'хэмжих / шалгах шалгуур',
  'ЯЛГАА / СЕГМЕНТ': 'суваг, салбар, бүтээгдэхүүнээр ялгаатай хэрэглэх эсэх',
  'ТАЙЛАГНАЛ': 'хэнд, хэдий давтамжтай тайлагнах',
  'ЗААЛТ': 'баримтын заалтыг яг юу болгож өөрчлөх',
  'ПРОЦЕСС / АЛХАМ': 'процессын алхам',
  'АВТОМАТЖУУЛАЛТ': 'системийн хяналт',
};

function loadImpact(file) {
  const src = fs.readFileSync(file, 'utf8');
  const w = {};
  // impact-data.js нь зөвхөн `window.IMPACT = {...}` гэсэн өгөгдөл — JSON хэсгийг нь салгаж уншина (код ажиллуулахгүй)
  const i = src.indexOf('{'), j = src.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('impact-data.js-д өгөгдөл олдсонгүй');
  try { w.IMPACT = JSON.parse(src.slice(i, j + 1)); } catch (e) { throw new Error('impact-data.js JSON биш: ' + e.message); }
  if (!Array.isArray(w.IMPACT.recs)) throw new Error('impact-data.js-д recs алга');
  return w.IMPACT;
}

const target = p => ({ id: p.id && p.id !== '—' ? p.id : null, doc: p.doc, dept: p.dept, action: p.action || '', chapter: p.chapter || '',
  evidence: p.evMN || '', spec: (p.spec || []).map(s => ({ tag: s.tag, text: s.text })) });

function importFile(file) {
  const D = loadImpact(file);
  const catalog = new Map();
  const addDoc = (p, role) => {
    if (!p || !p.doc || p.kind === 'EXT' || /^[·⚠◇—]/.test(p.doc)) return;
    const k = `${p.dept}|${p.doc}`;
    if (!catalog.has(k)) catalog.set(k, { id: p.id && p.id !== '—' ? p.id : null, doc: p.doc, dept: p.dept, roles: new Set() });
    catalog.get(k).roles.add(role);
  };
  const items = D.recs.map(r => {
    (r.primary || []).forEach(p => addDoc(p, 'зорилт'));
    (r.eom || []).forEach(p => addDoc(p, 'санал болгосон зорилт'));
    (r.peers || []).forEach(p => addDoc(p, 'ижил баримт'));
    (r.ripple || []).forEach(p => addDoc(p, 'дам нөлөө'));
    return {
      fid: r.fid, row: r.row, audit: r.audit, unit: r.unit, unit_full: r.unitFull, units: [r.unit].filter(Boolean), risk: r.risk, category: r.cat,
      title: r.title, recommendation: r.rec, one_off: !!r.nodoc, one_off_why: r.nodoc ? r.nodocWhy : '',
      targets: (r.primary || []).filter(p => p.kind === 'LIB' && !/^[·⚠—]/.test(p.doc)).map(target),
      external: (r.primary || []).filter(p => p.kind === 'EXT').map(p => p.cited),
      proposed_targets: (r.eom || []).filter(p => !p.gapmap).map(p => ({ ...target(p), why: p.why || '' })),
      peers: (r.peers || []).map(p => ({ id: p.id && p.id !== '—' ? p.id : null, doc: p.doc, dept: p.dept })),
      status: r.track?.status || '', owner: r.track?.owner || '', due: r.track?.due1 || r.track?.due0 || '',
    };
  });
  const res = {
    meta: { source: D.meta?.source || 'RPT175 нөлөөллийн матриц', sheet: D.meta?.sheet || '', library: D.meta?.library || '', generated: D.meta?.generated || '',
      imported_at: C.nowIso(), file: path.basename(file), recs: items.length, catalog_docs: catalog.size,
      note: 'Каталог нь баримтын сангийн БҮРЭН жагсаалт биш — зөвхөн матрицад холбогдсон баримтууд.' },
    tags: TAGS,
    catalog: [...catalog.values()].map(d => ({ ...d, roles: [...d.roles] })).sort((a, b) => (a.dept + a.doc).localeCompare(b.dept + b.doc)),
    items,
  };
  fs.mkdirSync(DIR, { recursive: true });
  C.writeJson(CUR_JSON(), res);
  return res;
}
const current = () => C.readJson(CUR_JSON());

/** Аудитлагдсан нэгжийн мөрүүд — RPT-175-ын нэгжийн тааруулалтыг (салбарын нэр / ДТС, УТС) ашиглана */
const forUnit = (data, audit = {}) => (data ? FU.forUnit(data, audit) : []);

// Тайлан дахь баримтын нэр / дугаарыг каталогтой тулгах (rules.js)
const normDoc = s => String(s || '').toLowerCase().replace(/[_\-–—&,.()«»"']+/g, ' ').replace(/\s+/g, ' ').trim();

/** Review-д хавсаргах текст: шаардлагын төрөл, нэгжийн өмнөх зөвлөмжийн шаардлага, баримтын каталог */
function toText(data, items, audit) {
  const L = [];
  L.push(`# Зөвлөмжийн шаардлага — ${data.meta.source} (матриц ${data.meta.generated}, импорт ${data.meta.imported_at.slice(0, 10)})`);
  L.push(`# Нэгж: ${audit.branch || '—'} · өмнөх зөвлөмж: ${items.length} · каталог: ${data.catalog.length} баримт (${data.meta.note})`, '');
  L.push('## 1. Шаардлагын төрлүүд (spec tag)');
  for (const [k, v] of Object.entries(data.tags)) L.push(`- ${k}: ${v}`);
  L.push('', '## 2. Энэ нэгжийн RPT-175-д бүртгэгдсэн зөвлөмж ба баримтад буух шаардлага');
  if (!items.length) L.push('(Энэ нэгжид матрицад бүртгэгдсэн зөвлөмж алга)');
  items.forEach((it, i) => {
    L.push('', `### REQ-${String(i + 1).padStart(2, '0')} · ${it.fid || 'ID-гүй'} · ${it.risk} · ${it.title}`);
    L.push(`Аудит: ${it.audit} · хариуцагч нэгж: ${it.unit_full || it.unit} · RPT-175 статус: ${it.status || '—'} · хугацаа: ${it.due || '—'}`);
    L.push(`Зөвлөмж (RPT-175): ${it.recommendation}`);
    if (it.one_off) L.push(`Төрөл: НЭГ УДААГИЙН ГҮЙЦЭТГЭХ ҮЙЛДЭЛ — ${it.one_off_why}`);
    if (it.external.length) L.push(`Гадаад эх сурвалж (DOC сангийн биш): ${it.external.join('; ')}`);
    const tg = it.targets.length ? it.targets : it.proposed_targets;
    if (!it.targets.length && it.proposed_targets.length) L.push('Зорилтот баримт: зөвлөмж нэрлээгүй — EOM §2.8-аар САНАЛ БОЛГОСОН (ДАГ баталгаажуулна)');
    if (!tg.length && !it.one_off) L.push('Зорилтот баримт: матрицад ТОГТООГДООГҮЙ (ижил олдворын өөр мөрд буусан эсвэл цоорхой)');
    for (const t of tg) {
      L.push(`- Зорилт: ${t.id || '—'} «${t.doc}» · ${t.dept}${t.action ? ' · ' + t.action : ''}${t.chapter ? ' · ' + t.chapter : ''}${t.evidence ? ' · нотолгоо: ' + t.evidence : ''}`);
      for (const s of t.spec) L.push(`  - [${s.tag}] ${s.text}`);
      if (t.why) L.push(`  - Үндэслэл: ${t.why.slice(0, 400)}`);
    }
    if (it.peers.length) L.push(`Ижил баримт бусад газарт: ${it.peers.slice(0, 8).map(p => `${p.id || '—'} «${p.doc}» (${p.dept})`).join('; ')}${it.peers.length > 8 ? ` … +${it.peers.length - 8}` : ''}`);
  });
  L.push('', '## 3. Баримтын каталог (матрицад холбогдсон баримтууд; DOC дугаар газар бүрд давтагддаг тул НЭР + ГАЗРААР тулга)');
  for (const d of data.catalog) L.push(`- ${d.id || '—'} | ${d.doc} | ${d.dept} | ${d.roles.join(', ')}`);
  return L.join('\r\n');
}

/** Review эхлэхэд: input/recreq/-д нэгжийн шаардлагын текстийг бичнэ. Буцаах: { file, count, catalog } эсвэл null */
function attachToJob(jobDir, audit) {
  const data = current();
  if (!data) return null;
  const items = forUnit(data, audit);
  const dir = path.join(jobDir, 'input', 'recreq');
  fs.mkdirSync(dir, { recursive: true });
  const file = `RECREQ_${(audit.branch || 'нэгж').replace(/[^\p{L}\p{N}-]+/gu, '_')}_${(data.meta.generated || '').slice(0, 10)}.txt`;
  fs.writeFileSync(path.join(dir, file), '﻿' + toText(data, items, audit), 'utf8');
  return { file, count: items.length, catalog: data.catalog.length, source: data.meta.source, as_of: data.meta.generated };
}

module.exports = { DIR, TAGS, importFile, current, forUnit, attachToJob, toText, normDoc };

if (require.main === module) {
  const [cmd, a] = process.argv.slice(2);
  if (cmd === 'import' && a) {
    const r = importFile(path.resolve(a));
    console.log(`OK ${r.meta.recs} зөвлөмж, ${r.meta.catalog_docs} баримт → ${CUR_JSON()}`);
  } else if (cmd === 'show') {
    const d = current();
    if (!d) return console.log('recreq/current.json алга — эхлээд import хийнэ үү');
    const items = a ? forUnit(d, { branch: a }) : d.items;
    console.log(`${d.meta.source} · ${d.meta.generated} · ${items.length} мөр`);
    for (const it of items) console.log(`${it.fid}\t${it.risk}\t${it.one_off ? 'нэг удаа' : (it.targets.length || it.proposed_targets.length) + ' зорилт'}\t${it.title.slice(0, 70)}`);
  } else console.log('node server/recreq.js import "<impact-data.js>" | show [салбар]');
}
