'use strict';
/*
  «Стандарт, баримт» хуудасны өгөгдөл: агентын модуль (skill) ба шалгуур, мөрдөж буй стандарт баримтууд,
  агентын дүрмийн файлууд, хувилбар, prompt архив. Бүгд одоо ажиллаж буй файлуудаас шууд уншина —
  дүрэм өөрчлөгдөхөд энэ хуудас автоматаар шинэчлэгдэнэ.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./common');
const S = require('./standard');
const CR = require('./criteria');
const { CHECKED_RULES } = require('./rules');

const RULE_FILES = [
  { key: 'system_prompt', title: 'Агентын үндсэн заавар', sub: 'Үүрэг, хатуу дүрэм, G0–M14 модуль, шалгуурын каталог', file: path.join(C.PATHS.prompts, 'system_prompt.md') },
  { key: 'decision_rules', title: 'Зэрэглэл, эцсийн санал, хамаарлын дүрэм', sub: 'R1–R4, verdict, нөлөөлөл × магадлалын матриц, KB-CONFLICT, давталтын дүрэм', file: path.join(C.PATHS.config, 'decision_rules.md') },
  { key: 'writing_standard', title: 'Бичгийн стандарт', sub: 'ДАГ-ын аргачлал: огноо, мөнгө, товчлол, зөв бичих, зөвлөмжийн хугацааны матриц', file: path.join(C.PATHS.config, 'writing_standard.md') },
  { key: 'output_template', title: 'Гаралтын бүтэц', sub: 'review_findings.json (schema v3), захиралд очих тайлангийн бүтэц', file: path.join(C.PATHS.prompts, 'output_template.md') },
];

const GROUPS = [
  { key: 'sp', title: 'SP-118-04 — агентын стандартын багц', note: 'Энэ агентыг тодорхойлсон баримтууд', test: id => /^SP-/.test(id) },
  { key: 'gias', title: 'Олон улсын стандарт (IIA)', note: 'Шатлалын хамгийн дээд түвшин', test: id => /^GIAS/.test(id) },
  { key: 'tier12', title: 'ДАГ-ын дүрэм, бодлого, Tier-2 стандарт', note: 'DOC-1900 Дүрэм, DOC-1901 Хараат бус байдал, DOC-1902 Бодлого, DOC-1903 QAIP, DOC-1916 Гүйцэтгэх журам', test: id => ['DOC-1900', 'DOC-1901', 'DOC-1902', 'DOC-1903', 'DOC-1916'].includes(id) },
  { key: 'tier3', title: 'Tier-3 стандарт, журам', note: 'Тайлагнал, зэрэглэл, бүртгэл, AI хэрэглээ, нууцлал г.м.', test: id => /^DOC-/.test(id) },
  { key: 'method', title: 'Аргачлал, тусгай журам', note: 'Батлагдсан баримтууд', test: () => true },
];
// Баримт бүрийг агент хаана хэрэглэдэг вэ (system_prompt-оос гүйцэтгэх модулиудыг тоолно)
const MODULE_RE = /^###\s+((?:G0|M\d{2}))\s+·\s+(.+?)\s*$/;
const ROW_RE = /^\|\s*((?:G0|M\d{2})-\d{2})\s*\|\s*(.+?)\s*\|\s*(R[1-4]\*?)\s+(D\+J|D|J)\s*\|(?:\s*(.+?)\s*\|)?\s*$/;

// Кодыг нэг форматад: кирилл ижил хэлбэртэй үсгийг латин болгоно (М01 → M01, G0 хэвээр). Эх файлыг өөрчлөхгүй — зөвхөн харуулахад.
const CYR2LAT = { 'М': 'M', 'м': 'M', 'О': '0', 'о': '0', 'Г': 'G', 'В': 'B', 'Р': 'P', 'С': 'C', 'А': 'A', 'Е': 'E', 'К': 'K', 'Т': 'T', 'Н': 'H', 'Х': 'X' };
const normCode = s => String(s).replace(/[МмОоГВРСАЕКТНХ]/g, ch => CYR2LAT[ch] || ch).toUpperCase();

function parseModules() {
  const text = fs.readFileSync(path.join(C.PATHS.prompts, 'system_prompt.md'), 'utf8')
    .replace(/^(###\s+)(\S+)/gm, (m, a, b) => a + normCode(b)).replace(/^(\|\s*)(\S+-\d{2})/gm, (m, a, b) => a + normCode(b));
  const mods = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(MODULE_RE);
    if (h) {
      const src = ((h[2].match(/\(([^)]+)\)\s*$/) || [])[1] || '').replace(/\s*—.*$/, '').trim();
      cur = { id: h[1], name: S.MODULE_NAMES[h[1]] || h[2].replace(/\s*\([^)]*\)\s*$/, ''), source: src, criteria: [] };
      mods.push(cur); continue;
    }
    if (/^##\s/.test(line)) cur = null;
    const r = cur && line.match(ROW_RE);
    if (r) {
      const auto = CHECKED_RULES.includes(r[1]);
      cur.criteria.push({ id: r[1], text: r[2].replace(/\*\*/g, ''), level: r[3].replace('*', ''), type: r[4], source: r[5] || '',
        by: auto ? (r[4] === 'D' ? 'code' : 'code+ai') : r[1].startsWith('M14') ? 'ai+code' : 'ai' });
    }
  }
  for (const m of mods) {
    const c = m.criteria;
    m.levels = { R1: 0, R2: 0, R3: 0, R4: 0 };
    for (const x of c) if (m.levels[x.level] !== undefined) m.levels[x.level]++;
    m.counts = { total: c.length, code: c.filter(x => x.by === 'code').length, mixed: c.filter(x => x.by === 'code+ai' || x.by === 'ai+code').length, ai: c.filter(x => x.by === 'ai').length };
    m.by = !c.length ? 'ai' : m.counts.ai === c.length ? 'ai' : m.counts.code === c.length ? 'code' : 'mixed';
  }
  return mods;
}

function fileInfo(f) {
  try {
    const st = fs.statSync(f), buf = fs.readFileSync(f);
    const d = new Date(st.mtimeMs), p = n => String(n).padStart(2, '0');
    return { modified: `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, sha8: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8), size: st.size };
  } catch { return null; }
}

/**
 * Шалгуур бүр одоо байгаа review-үүдэд хэдэн удаа өдөөгдсөн (output/review_findings.json issues[].rule,
 * recheck.json new_issues[].rule). Хуучин (2026-10-09-өөс өмнөх) review нь A1…L3 блок кодтой тул тусад нь тоолно.
 */
function triggerCounts() {
  const counts = {}, ids = new Set();
  let reviews = 0, legacy = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(C.PATHS.jobs).filter(d => /^\d{8}-\d{6}-[a-z0-9]{6}$/.test(d)); } catch { /* jobs алга */ }
  for (const d of dirs) {
    // Аудиторын «Өөрөө шалгах» нь илгээгдэх тайлангийн давхар хяналт — статистикт тоолохгүй
    if ((C.readJson(path.join(C.PATHS.jobs, d, 'job.json')) || {}).kind === 'precheck') continue;
    const out = path.join(C.PATHS.jobs, d, 'sandbox', 'output');
    const f = C.readJson(path.join(out, 'review_findings.json')), rc = C.readJson(path.join(out, 'recheck.json'));
    const issues = [...(Array.isArray(f?.issues) ? f.issues : []), ...(Array.isArray(rc?.new_issues) ? rc.new_issues : [])];
    if (!issues.length) continue;
    reviews++;
    for (const it of issues) {
      const r = normCode(it.rule || '');
      if (/^(G0|M\d{2})-\d{2}$/.test(r)) { counts[r] = (counts[r] || 0) + 1; ids.add(d); }
      else if (/^[A-L]\d{1,2}$/.test(r)) legacy++;
    }
  }
  return { counts, reviews, reviews_with_new_codes: ids.size, legacy_issues: legacy };
}

function library() {
  const docs = CR.listDocs();
  const used = new Map();
  const prompt = fs.readFileSync(path.join(C.PATHS.prompts, 'system_prompt.md'), 'utf8') + fs.readFileSync(path.join(C.PATHS.config, 'decision_rules.md'), 'utf8');
  for (const d of docs) {
    const key = d.id === 'DAG' ? /аргачлал/gi : d.id === 'ISO' ? /ISO/g : d.id.startsWith('SP-') ? /SP-118-04/g : d.id === 'GIAS' ? /GIAS/g : new RegExp(d.id, 'g');
    used.set(d.id, (prompt.match(key) || []).length);
  }
  const left = [...docs];
  const groups = GROUPS.map(g => {
    const mine = left.filter(d => g.test(d.id));
    mine.forEach(d => left.splice(left.indexOf(d), 1));
    return { key: g.key, title: g.title, note: g.note, docs: mine.map(d => ({ ...d, refs: used.get(d.id) || 0 })) };
  }).filter(g => g.docs.length);

  let archive = [];
  try { archive = fs.readdirSync(path.join(process.env.AR_LOGS_DIR || C.PATHS.logs, 'prompt_archive')).sort().reverse().slice(0, 20); } catch { /* хоосон */ }

  const spFile = path.join(C.PATHS.prompts, 'system_prompt.md');
  const modules = parseModules();
  const trig = triggerCounts();
  for (const m of modules) for (const c of m.criteria) c.triggers = trig.counts[c.id] || 0;
  return {
    version: { rulepack: S.RULEPACK, prompt_template_id: S.PROMPT_TEMPLATE_ID, recheck_template_id: S.RECHECK_TEMPLATE_ID, schema: S.SCHEMA_VERSION, api: S.API_VERSION,
      source_file: path.relative(C.PATHS.root, spFile).replace(/\\/g, '/'), source_modified: fileInfo(spFile)?.modified || null, source_sha8: fileInfo(spFile)?.sha8 || null },
    triggers: { reviews: trig.reviews, reviews_with_new_codes: trig.reviews_with_new_codes, legacy_issues: trig.legacy_issues },
    hierarchy: ['Хууль', 'GIAS 2024', 'DOC-1900 Дүрэм', 'DOC-1902 Бодлого', 'Tier-3 стандарт, журам (DOC-1903…1918)', 'ДАГ-ын аргачлал', 'Бүртгэл, загвар'],
    severities: [
      { id: 'R1', name: 'Ноцтой (BLOCKER)', text: 'Засагдахаас өмнө батлахгүй' }, { id: 'R2', name: 'Томоохон (MAJOR)', text: 'Захирлын шийдвэрээр засна' },
      { id: 'R3', name: 'Бага (MINOR)', text: 'Формат, найруулга, кодчлол' }, { id: 'R4', name: 'Санал (SUGGESTION)', text: 'Сайжруулалт, заавал биш' }],
    modules,
    groups,
    rules: RULE_FILES.map(r => ({ key: r.key, title: r.title, sub: r.sub, file: path.relative(C.PATHS.root, r.file).replace(/\\/g, '/'), ...fileInfo(r.file) })),
    commands: [
      { name: '/review-audit', text: 'input/ хавтасны тайланг вэбгүйгээр шууд review хийнэ (Claude Code дээр)' },
      { name: '/publish-docs <jobId>', text: 'Дууссан review-г далдалж Google Docs / Claude Docs руу илгээнэ' },
      { name: '/sync-docs <jobId>', text: 'Docs дээрх аудиторын хариу, comment-ийг уншиж дүгнэлт бичнэ' },
    ],
    prompt_archive: archive,
    workflow: WORKFLOW, use_cases: USE_CASES, deviations: DEVIATIONS,
  };
}

/* ---------- Workflow (SP-118-04/01 §3) ба use case (§4) — хэрэгжилтийн төлөвтэй ---------- */
// status: done = бүрэн, partial = хэсэгчлэн, none = хийгдээгүй
const WORKFLOW = [
  { id: 'S1', name: 'Оруулах', who: 'Аудитор', what: 'Тайлан (файл/линк), Excel хавсралт, аудитын хөтөлбөр, нотолгоо, follow-up (RPT-175)', status: 'done' },
  { id: 'S2', name: 'Gate-0', who: 'Систем', what: 'Оролтын бүрэн байдал, хувилбар, дурдсан хавсралт ирсэн эсэх, AI-д хандсан заавар', status: 'done' },
  { id: 'S3', name: 'Хяналт', who: 'Систем + AI', what: 'M01–M13: 26 шалгуурыг код, бусдыг Claude; хамаарлын гинж', status: 'partial', gap: 'RPT-175-г 8502-оос шууд татахгүй — төвийн хувийг «Зөвлөмжийн бүртгэл» табаас шинэчилнэ, review бүрт салбарын мөрүүд автоматаар хавсарна' },
  { id: 'S4', name: 'Багц', who: 'Систем → захирал', what: 'Шийдвэрийн хуудас, R1–R4 саналууд, scorecard, эскалаци', status: 'done' },
  { id: 'S5', name: 'Захирлын шийдвэр', who: 'Захирал (менежер)', what: 'Санал бүрийг Зөвшөөрөх / Засах / Татгалзах; R3, R4-ийг бөөнөөр', status: 'done' },
  { id: 'S6', name: 'Даалгавар', who: 'Систем', what: 'Зөвхөн зөвшөөрсөн саналаар аудиторт даалгавар (.docx)', status: 'partial', gap: 'Drive-ийн _v2 хавтсанд автоматаар хадгалах, аудиторт мэдэгдэх хийгдээгүй — татаж өгнө' },
  { id: 'S7', name: 'Засвар', who: 'Аудитор', what: 'Тайлангаа засаж v2 оруулна; засварын байршлыг систем өөрөө тодорхойлно', status: 'done' },
  { id: 'S8', name: 'Дахин хяналт', who: 'Систем + AI', what: 'M14: өмнөх санал бүр RESOLVED / PARTIAL / NOT_RESOLVED / REGRESSED; шинэ R1–R2', status: 'done' },
  { id: 'S9', name: 'Шийдвэр', who: 'Захирал', what: 'R1 = 0 бол батлах, эс бөгөөс S5 руу; 3-аас олон давталтад сэрэмжлүүлэг', status: 'done' },
  { id: 'S10', name: 'Хаалт', who: 'Захирал → систем', what: 'Эцсийн батлалт: бүртгэлийн дугаар, огноо, архив (10 жил), лог; цаашид түгжинэ', status: 'partial', gap: 'Follow-up системд (RPT-175) олдвор бүртгэх нь гараар' },
];
const USE_CASES = [
  { id: 'UC-01', name: 'Тайлан хяналтад оруулах', actor: 'Аудитор', status: 'done' },
  { id: 'UC-02', name: 'Бүрэн хяналт (FULL)', actor: 'Агент', status: 'done' },
  { id: 'UC-03', name: 'Хуудас хоорондын тоон тулгалт', actor: 'Агент', status: 'partial', gap: 'Excel-ийн статистикийг код гаргана, тулгалтыг AI хийнэ (тоон утгыг кодоор бүрэн задлахгүй)' },
  { id: 'UC-04', name: 'Follow-up тулгалт (8502)', actor: 'Агент, систем', status: 'partial', gap: 'Төвийн RPT-175-аар автоматаар (M10-01, M10-04 кодоор); 8502-той шууд холболтгүй, RC кодын багана алга' },
  { id: 'UC-05', name: 'Захирал санал батлах', actor: 'Захирал', status: 'done' },
  { id: 'UC-06', name: 'Засварын даалгавар илгээх', actor: 'Систем', status: 'partial', gap: 'Drive, мэдэгдэлгүй — .docx татна' },
  { id: 'UC-07', name: 'Засварласан тайлан дахин хянах (DELTA)', actor: 'Аудитор, агент', status: 'done' },
  { id: 'UC-08', name: 'Эцсийн батлалт ба архив', actor: 'Захирал, систем', status: 'done' },
  { id: 'UC-09', name: 'Тусгай эскалаци (AML 24ц, кибер 1ц)', actor: 'Агент → захирал', status: 'partial', gap: 'Илрүүлж, хугацааг харуулна; цаг тоолуур, автомат мэдэгдэлгүй' },
  { id: 'UC-10', name: 'Мэдлэгийн сангийн зөрчил (KB-CONFLICT)', actor: 'Агент → захирал', status: 'partial', gap: 'Зөрчлийг харуулна; шийдвэрийн (DEC) бүртгэл гараар' },
  { id: 'UC-11', name: 'Дүрэм, журам шинэчлэгдэх', actor: 'Methodology Lead', status: 'partial', gap: 'Дүрмийн файл засахад шууд хэрэгжиж, архивлагдана; регресс тест автоматаар ажиллахгүй' },
  { id: 'UC-12', name: 'Тайлан, статистик харах', actor: 'Захирал, менежер, QA', status: 'partial', gap: 'Лог, давталтын үр дүн бий; KPI самбар алга' },
  { id: 'UC-13', name: 'Эрх тохируулах', actor: 'Admin, захирал', status: 'partial', gap: 'Захирал / менежер / аудитор / харах эрх бий; engagement-ээр хязгаарлах, эрх шилжүүлэх хугацаа алга' },
];
const DEVIATIONS = [
  { ref: 'SP-01 S7', text: '«Засвар хийсэн байршил» баганыг хассан — систем засварласан тайлангаас байршлыг өөрөө олдог тул аудиторт илүү ажил болно.' },
  { ref: 'SP-02 G0-02', text: 'Файлын нэрэнд хувилбар (vM.m) байхгүй бол R1 биш R3 (M12-02-т нэгтгэсэн) — эс бөгөөс одоогийн бүх тайлан блоклогдоно.' },
  { ref: 'SP-02 KB-CONFLICT-01', text: 'Зөвлөмжийн хугацааг ДАГ-ын аргачлалын матрицаар шалгана (хэрэглэгчийн шийдвэр 2026-10-07); DOC-1912 Хав. Б-г лавлагаа болгон харуулна.' },
  { ref: 'SP-03 §2', text: 'Backend: Node.js, өгөгдөл файлд (PostgreSQL биш), queue нэг процесст. API гэрээ /api/v1 + docs/openapi.yaml.' },
  { ref: 'SP-03 §7', text: '8502 follow-up систем, Google Drive-тай шууд холболт хийгдээгүй (IT-ын зөвшөөрөл, API мэдээлэл хэрэгтэй).' },
  { ref: 'SP-01 §5', text: 'Нэвтрэлтгүй горимд хэрэглэгч «Би хэн бэ»-гээ сонгоно (нууц үггүй); захирлын эрх шилжүүлэлт (R3/R4 хязгаар) хэрэгжээгүй.' },
  { ref: 'SP-01 §7', text: 'Хадгалалт: стандартад 7 хоног — хэрэглэгчийн шийдвэрээр (2026-10-12) 90 хоног болгосон, эх файлыг хувилбар бүрээр хадгалж татах боломжтой; эцэслэн батлагдсан тайлан болон эх файлууд archive/ хавтсанд 10 жил (DOC-1914).' },
];

function ruleText(key) {
  const r = RULE_FILES.find(x => x.key === key);
  return r && fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null;
}

module.exports = { library, ruleText, WORKFLOW, USE_CASES, DEVIATIONS };

if (require.main === module) {
  const l = library();
  for (const m of l.modules) console.log(m.id, m.name, JSON.stringify(m.counts), m.by);
  console.log(l.groups.map(g => `${g.title}: ${g.docs.map(d => `${d.id}(${d.refs})`).join(' ')}`).join('\n'));
  console.log(l.rules.map(r => `${r.file} ${r.modified} ${r.sha8}`).join('\n'));
}
