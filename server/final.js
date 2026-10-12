'use strict';
/*
  Эцсийн тайлан (зөвхөн APPROVED_FINAL, зөвхөн захирал / админ):
    docx — аудиторын СҮҮЛИЙН хувилбарын тайлан, оруулсан хэлбэрээр нь (originals/)
    pdf  — ижил тайлан, нүүрэнд бүртгэлийн дугаар, батлагдсан огноо, батлагчийн нэр.
           MS Word (COM) байвал түүгээр — хэлбэр яг хэвээр; үгүй бол тайлангийн бичвэрээс HTML → Edge PDF (хэлбэр хялбаршина)
    zip  — бүх хувилбарын эх файл + feedback бүр + approval.json
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./common');
const ORIG = require('./originals');
const WF = require('./workflow');
const { zip, htmlToPdf } = require('./export');

const jdir = id => path.join(C.PATHS.jobs, id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Сүүлийн хувилбарын тайлангийн эх файл */
function latestReport(rootId) {
  const vs = WF.versions(rootId);
  for (let i = vs.length - 1; i >= 0; i--) {
    const it = ORIG.list(jdir(vs[i])).find(x => x.cat === 'report');
    if (it) { const f = ORIG.fileOf(jdir(vs[i]), it.cat, it.name); if (f) return { ...f, job: vs[i], version: i + 1 }; }
  }
  return null;
}

function coverLines(fin, audit) {
  return [`ЭЦСЭЭР БАТЛАГДСАН ТАЙЛАН`, `${audit.name || ''}`.trim(), `Аудитын дугаар: ${audit.code || '—'}`, `Бүртгэлийн дугаар: ${fin.reg_no}`,
    `Батлагдсан огноо: ${String(fin.approved_at || '').slice(0, 10).replace(/-/g, '.')}`, `Баталсан: ${fin.approver_name || fin.approved_by || ''} (ДАГ-ын захирал)`,
    'Internal Audit – Restricted'].filter(Boolean);
}

// Word COM: хуулбарыг нээж, эхэнд нүүр хуудас оруулаад PDF болгоно (эх файл өөрчлөгдөхгүй)
const PS = `
$ErrorActionPreference = 'Stop'
$w = New-Object -ComObject Word.Application
$w.Visible = $false; $w.DisplayAlerts = 0
try {
  $d = $w.Documents.Open($env:AR_IN, $false, $false, $false)
  $r = $d.Range(0, 0)
  $r.InsertBefore($env:AR_COVER + [char]13)
  $r.Font.Bold = $true; $r.Font.Size = 14
  $r.Collapse(0); $r.InsertBreak(7)
  $d.SaveAs2([ref]$env:AR_OUT, [ref]17)
  $d.Close([ref]0)
} finally { $w.Quit() }
`;
function wordPdf(docx, cover, tmp) {
  return new Promise((resolve, reject) => {
    const inF = path.join(tmp, 'in' + path.extname(docx)), outF = path.join(tmp, 'out.pdf'), ps = path.join(tmp, 'topdf.ps1');
    fs.copyFileSync(docx, inF);
    fs.writeFileSync(ps, PS, 'utf8');
    const ch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, AR_IN: inF, AR_OUT: outF, AR_COVER: cover.join('\r') } });
    const timer = setTimeout(() => { try { ch.kill(); } catch { /* ignore */ } }, 120000);
    ch.on('error', e => { clearTimeout(timer); reject(e); });
    ch.on('exit', () => {
      clearTimeout(timer);
      if (fs.existsSync(outF) && fs.statSync(outF).size > 0) resolve(fs.readFileSync(outF)); else reject(new Error('Word-оор PDF үүсгэж чадсангүй'));
    });
  });
}

// Fallback: тайлангийн бичвэр (doc.json, жинхэнэ утгаар) → HTML
function docHtml(jobId, cover) {
  const raw = fs.readFileSync(path.join(jdir(jobId), 'doc.json'), 'utf8');
  const doc = JSON.parse(C.restoreTokens(jdir(jobId), raw, true));
  const body = (doc.blocks || []).map(b => {
    if (b.kind === 'table') return `<table>${(b.rows || []).map(r => `<tr>${(r || []).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    const t = esc(b.text || '');
    if (/^(title|h1)$/.test(b.kind)) return `<h1>${t}</h1>`;
    if (b.kind === 'h2') return `<h2>${t}</h2>`;
    if (b.kind === 'h3') return `<h3>${t}</h3>`;
    if (b.kind === 'li') return `<ul><li>${t}</li></ul>`;
    return `<p>${t}</p>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:11pt "Times New Roman",serif;margin:2cm} .cover{page-break-after:always;padding-top:6cm;text-align:center} .cover p{font-size:14pt;margin:6px}
    table{border-collapse:collapse;width:100%;margin:8px 0} td{border:1px solid #888;padding:3px 5px;font-size:9.5pt;vertical-align:top} h1{font-size:15pt} h2{font-size:13pt} h3{font-size:12pt}
    .note{font:9pt sans-serif;color:#666;text-align:center;margin-top:2cm}</style></head><body>
    <div class="cover">${cover.map((l, i) => `<p>${i === 0 ? `<b>${esc(l)}</b>` : esc(l)}</p>`).join('')}
    <div class="note">Энэ PDF-ийг тайлангийн бичвэрээс автоматаар үүсгэсэн (MS Word ашиглах боломжгүй байсан) — эх хэлбэрийг .docx файлаас үзнэ үү.</div></div>
    ${body}</body></html>`;
}

async function build(rootId, fmt) {
  const root = WF.stateOf(rootId);
  const job = C.readJson(path.join(jdir(rootId), 'job.json')) || {};
  if (root.state !== 'APPROVED_FINAL' || !job.finalized) throw Object.assign(new Error('Тайлан эцэслэн батлагдаагүй байна'), { code: 409 });
  const fin = job.finalized, audit = job.audit || {};
  const base = `${fin.reg_no}_${String(audit.code || '').replace(/[^\w-]+/g, '_')}`.replace(/_+$/, '');
  if (fmt === 'zip') {
    const entries = [];
    WF.versions(rootId).forEach((id, i) => {
      for (const it of ORIG.list(jdir(id))) {
        const f = ORIG.fileOf(jdir(id), it.cat, it.name);
        if (f) entries.push({ name: `v${i + 1}/${it.cat}/${it.name}`, data: fs.readFileSync(f.path) });
      }
    });
    for (const n of WF.releasedVersions(rootId)) {
      const f = path.join(jdir(rootId), 'feedback', `feedback_v${n}.json`);
      entries.push({ name: `feedback/feedback_v${n}.json`, data: C.restoreTokens(jdir(rootId), fs.readFileSync(f, 'utf8'), true) });
    }
    const appr = fin.archive ? path.join(C.PATHS.root, fin.archive, 'approval.json') : null;
    entries.push({ name: 'approval.json', data: appr && fs.existsSync(appr) ? fs.readFileSync(appr) : JSON.stringify({ ...fin, audit, workflow: job.workflow }, null, 2) });
    return { data: zip(entries), type: 'application/zip', filename: `${base}_bukh_huvilbar.zip` };
  }
  const rep = latestReport(rootId);
  if (!rep) throw Object.assign(new Error('Сүүлийн хувилбарын тайлангийн эх файл хадгалагдаагүй байна'), { code: 404 });
  const ext = path.extname(rep.name).toLowerCase();
  if (fmt === 'docx') return { data: fs.readFileSync(rep.path), type: ext === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: rep.name, version: rep.version };
  if (fmt !== 'pdf') throw Object.assign(new Error('Unknown format'), { code: 404 });
  if (ext === '.pdf') return { data: fs.readFileSync(rep.path), type: 'application/pdf', filename: rep.name, version: rep.version };
  const cover = coverLines(fin, audit);
  const tmp = path.join(jdir(rootId), 'export-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let data, method = 'word';
    try { data = await wordPdf(rep.path, cover, tmp); }
    catch (e) { method = 'html'; data = await htmlToPdf(docHtml(rep.job, cover), jdir(rootId)); }
    return { data, type: 'application/pdf', filename: rep.name.replace(/\.[^.]+$/, '') + `_${fin.reg_no}.pdf`, version: rep.version, method };
  } finally { setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ } }, 1000); }
}

module.exports = { build, latestReport };
