'use strict';
/*
  Тайланд шууд засах — найруулгын санал AI-аар (2026-10-16).
  Review-ийн үед AI найруулга (suggested_text) бараг бичдэггүй, ишлэл нь ихэвчлэн гарчиг / шошго мэт богино байдаг тул
  аудитор «✨ AI-аар найруулга» дарахад тухайн НЭГ саналд, тухайн нэгжийн (догол мөр / хүснэгтийн мөрийн нүд) хүрээнд:
    { fixable: true, old: <нэгжээс яг хуулсан хэсэг>, new: <орлох текст>, note }  эсвэл  { fixable: false, reason }
  Claude-д зөвхөн ДАЛДАЛСАН бичвэр (doc.json, feedback-ийн token-той хэлбэр) очно; хэрэгсэлгүй (--tools ""), нэг асуулт.
  Хариуг mask_map-аар алдагдал шалгаж, old нь нэгжид байгааг тулгана. jobs/<root>/edits/v<n>/suggestions.json (token-той).
  Ажиллагаа бүрийг logs/ai_runs.jsonl-д AI_SUGGEST гэж бүртгэнэ (текстгүй, hash-аар).
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./common');
const WF = require('./workflow');
const AL = require('./ailog');
const { normMap, cleanQuote } = require('./verify');

const TEMPLATE_ID = 'SUGGEST-1';
const jdir = id => path.join(C.PATHS.jobs, id);
const edDir = (rootId, n) => path.join(jdir(rootId), 'edits', `v${n}`);
const sugFile = (rootId, n) => path.join(edDir(rootId, n), 'suggestions.json');
const running = new Set();

const readAll = (rootId, n) => C.readJson(sugFile(rootId, n)) || {};
/** Хадгалсан саналууд — жинхэнэ утгаар (UI-д) */
function list(rootId, n) {
  const all = readAll(rootId, n);
  return JSON.parse(C.restoreTokens(jdir(rootId), JSON.stringify(all), true));
}

/* ---------- Нэгжүүд (verify.js-ийн blockUnits-тэй ижил дугаарлалт) ---------- */
function unitsOf(doc) {
  const out = [];
  (doc.blocks || []).forEach(b => {
    if (b.kind === 'table') (b.rows || []).forEach((r, ri) => out.push({ id: `${b.id}R${ri + 1}`, block: b.id, cells: (r || []).map(x => String(x || '')) }));
    else out.push({ id: b.id, block: b.id, cells: [String(b.text || '')] });
  });
  return out;
}
const anchorKey = a => { const k = String(a || '').toUpperCase().replace(/[[\]\s]/g, '').match(/^(P\d+|T\d+)(R\d+)?/); return k ? { block: k[1], row: k[2] || '' } : null; };
/** Засах нэгж(үүд) ба эргэн тойрны контекст */
function targetOf(doc, anchor) {
  const k = anchorKey(anchor);
  if (!k) return null;
  const units = unitsOf(doc);
  let idx = units.map((u, i) => (k.row ? u.id === k.block + k.row : u.block === k.block) ? i : -1).filter(i => i >= 0);
  if (!idx.length) return null;
  idx = idx.slice(0, 12);   // том хүснэгт — эхний 12 мөр
  const ctx = [...new Set([idx[0] - 2, idx[0] - 1, idx[idx.length - 1] + 1].filter(i => i >= 0 && i < units.length && !idx.includes(i)))];
  return { targets: idx.map(i => units[i]), context: ctx.map(i => units[i]) };
}

/* ---------- Prompt ---------- */
const clip = (s, n) => (s = String(s || '')).length > n ? s.slice(0, n) + '…' : s;
function buildPrompt(item, tgt) {
  const unitLines = u => u.cells.length > 1 ? u.cells.map((c, i) => `<<${u.id} нүд ${i + 1}>> ${clip(c, 1500)}`).join('\n') : `<<${u.id}>> ${clip(u.cells[0], 3000)}`;
  return `You help an internal auditor fix ONE review comment directly in their Mongolian audit report. Reply with ONE JSON object only — no prose, no code fences.

REVIEW COMMENT (approved by the Chief Audit Executive)
- Title: ${clip(item.title, 300)}
- Problem: ${clip(item.issue, 1200)}
- What to fix: ${clip(item.required_action, 1200)}
- Quoted text: ${item.quote ? `«${clip(item.quote, 600)}»` : '(none)'}
- Location: ${item.anchor}

TARGET TEXT — you may change text ONLY here (one paragraph or one table cell):
${tgt.targets.map(unitLines).join('\n')}

CONTEXT (read only, do not edit):
${tgt.context.map(unitLines).join('\n') || '(none)'}

RULES
1. Propose exactly one replacement inside ONE target paragraph/cell. "old" must be copied character-for-character from that target text (tokens such as [PERSON-0001] included); "new" replaces it. Pick the smallest span that fully fixes the comment — a phrase, a sentence, or the whole paragraph/cell.
2. Use only facts, numbers, names and terms already present in the report text or the review comment above. Never invent numbers, dates, names, findings, causes or evidence. If the fix needs a value the auditor must supply, put a placeholder in square brackets, e.g. [___ тоо оруулах].
3. Copy tokens like [PERSON-0001] verbatim; never guess real values. Formal Mongolian, the report's own terminology. No comments, quotes or "..." inside "new".
4. If the comment cannot be fixed by rewriting text in one target paragraph/cell (it needs new testing or analysis, a new section, an attachment, restructuring a table, or changes in several places), do not force it.

OUTPUT (one of):
{"fixable": true, "old": "<exact text from target>", "new": "<replacement>", "note": "<one short Mongolian sentence: what changed and why>"}
{"fixable": false, "reason": "<one short Mongolian sentence: what the auditor must do instead>"}`;
}

/* ---------- Claude (хэрэгсэлгүй, нэг асуулт) ---------- */
function findClaude() {
  return C.findExecutable(['claude.exe', 'claude'], [path.join(process.env.USERPROFILE || require('os').homedir(), '.local', 'bin')]);
}
function ask(prompt, cwd) {
  const claude = findClaude();
  if (!claude) return Promise.reject(new Error('Claude Code олдсонгүй — серверт суулгаагүй байна'));
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--strict-mcp-config',
    '--no-session-persistence', '--tools', '', '--max-turns', '2'];
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { cwd, windowsHide: true, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => {
      let r = null; try { r = JSON.parse(out); } catch { /* доор */ }
      if (!r) return reject(new Error(`AI хариу өгсөнгүй (код ${code})${err ? ': ' + err.trim().split('\n').pop() : ''}`));
      resolve(r);
    });
    child.stdin.end(prompt, 'utf8');
  });
}
function parseReply(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

/**
 * Шинэ текстэд гарсан (хуучинд байгаагүй) тоо бүрийн эх сурвалж: 'report' — тайланд үгчлэн бий,
 * 'comment' — зөвхөн захирлын баталсан саналын тайлбарт, 'none' — аль алинд нь алга (AI тооцоолсон / зохиосон байж болзошгүй).
 */
const NUM_RE = /\d[\d,.]*\d|\d/g;
const numsOf = s => [...new Set((String(s || '').match(NUM_RE) || []).map(x => x.replace(/[.,]$/, '')))];
function numberSources(newText, oldText, doc, item) {
  const old = new Set(numsOf(oldText));
  const fresh = numsOf(newText.replace(/\[[^\]]*\]/g, ' ')).filter(x => !old.has(x));   // [___ …] орлуулагч, token-ыг тоолохгүй
  if (!fresh.length) return [];
  const reportNums = new Set(numsOf((doc.blocks || []).map(b => b.kind === 'table' ? (b.rows || []).map(r => (r || []).join(' ')).join(' ') : b.text).join(' ')));
  const commentNums = new Set(numsOf([item.title, item.issue, item.required_action].join(' ')));
  return fresh.map(n => ({ n, src: reportNums.has(n) ? 'report' : commentNums.has(n) ? 'comment' : 'none' }));
}

/** Нэг саналд найруулга бэлтгэнэ: { ok, suggestion } эсвэл { error, code } */
async function suggest(rootId, n, rvId, by) {
  const fbRaw = C.readJson(path.join(jdir(rootId), 'feedback', `feedback_v${n}.json`));   // token-той
  if (!fbRaw) return { error: 'Энэ хувилбарт feedback илгээгдээгүй байна', code: 404 };
  const item = (fbRaw.items || []).find(x => x.id === rvId);
  if (!item) return { error: 'Санал олдсонгүй', code: 404 };
  const doc = C.readJson(path.join(jdir(fbRaw.job), 'doc.json'));
  if (!doc) return { error: 'Тайлангийн бичвэр хадгалагдаагүй хувилбар байна', code: 409 };
  const tgt = targetOf(doc, item.anchor);
  if (!tgt) return { error: 'Энэ санал тайлангийн тодорхой хэсэгт холбогдоогүй тул шууд засах боломжгүй — эх файлдаа засна уу', code: 409 };
  const key = `${rootId}/${n}/${rvId}`;
  if (running.has(key)) return { error: 'Энэ саналд AI найруулга бэлтгэж байна — түр хүлээнэ үү', code: 409 };
  running.add(key);
  const cwd = path.join(jdir(rootId), 'edits', '_ai');
  fs.mkdirSync(cwd, { recursive: true });
  const prompt = buildPrompt(item, tgt), t0 = Date.now();
  const runId = AL.nextRunId();
  let r, err;
  try { r = await ask(prompt, cwd); } catch (e) { err = e; } finally { running.delete(key); }
  const model = r && r.modelUsage ? Object.keys(r.modelUsage)[0] || null : null;
  const logRun = (status, extra = {}) => { try { AL.append('ai', { type: 'AI_SUGGEST', ai_run_id: runId, job: rootId, version: n, rv_id: rvId, prompt_template_id: TEMPLATE_ID,
    prompt_sha256: crypto.createHash('sha256').update(prompt).digest('hex'), model, cost_usd: r?.total_cost_usd ?? null, duration_ms: Date.now() - t0, status, reviewer: by, ...extra }); } catch { /* лог */ } };
  if (err) { logRun('failed', { error: String(err.message).slice(0, 300) }); return { error: err.message, code: 502 }; }
  const ans = parseReply(r.result);
  if (!ans || typeof ans.fixable !== 'boolean') { logRun('bad_reply'); return { error: 'AI-ийн хариуг уншиж чадсангүй — дахин оролдоно уу', code: 502 }; }
  // Алдагдал шалгах (оролт далдалсан тул жинхэнэ утга гарах ёсгүй)
  const map = C.readJson(path.join(jdir(rootId), 'mask_map.json')) || {};
  const leaks = C.findLeaks([ans.old, ans.new, ans.note, ans.reason].filter(Boolean).join('\n'), map);
  if (leaks.length) { logRun('leak'); return { error: 'AI-ийн хариунд хувийн мэдээлэл илэрсэн тул хэрэглэхгүй', code: 502 }; }
  let sug;
  if (ans.fixable) {
    const oldText = String(ans.old || ''), newText = String(ans.new || '').replace(/\s*\n+\s*/g, ' ').trim();
    const q = cleanQuote(oldText);
    const unit = q && tgt.targets.find(u => u.cells.some(c => normMap(c).n.includes(q)));
    if (!unit || !newText || cleanQuote(newText) === q) {
      logRun('invalid');
      return { error: 'AI-ийн санал тайлангийн текстэй таарсангүй — дахин оролдох эсвэл гараар засна уу', code: 502 };
    }
    sug = { fixable: true, old: oldText, new: newText, note: String(ans.note || '').slice(0, 500), block: unit.id, numbers: numberSources(newText, oldText, doc, item) };
  } else sug = { fixable: false, reason: String(ans.reason || 'Текст солиод засагдахгүй').slice(0, 500) };
  Object.assign(sug, { ai_run_id: runId, at: C.nowIso(), by });
  const all = readAll(rootId, n);
  all[rvId] = sug;
  fs.mkdirSync(edDir(rootId, n), { recursive: true });
  C.writeJson(sugFile(rootId, n), all);
  logRun(sug.fixable ? 'ok' : 'not_fixable');
  return { ok: true, suggestion: JSON.parse(C.restoreTokens(jdir(rootId), JSON.stringify(sug), true)) };
}

module.exports = { suggest, list, buildPrompt, targetOf, parseReply, numberSources, TEMPLATE_ID };
