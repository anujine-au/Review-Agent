'use strict';
/*
  AI-ийн автомат засвар (2026-10-20). Захирал «Батлаад аудиторт буцаах» дарахад (release) feedback-ийн санал бүрийг:
    1. server/suggest.js-ээр (далдалсан бичвэр, хэрэгсэлгүй Claude, ноорог горим) нэг догол мөр / нүдний засвар болгоно —
       мэдээлэл дутуу хэсгийг «[АУДИТОР БАТАЛГААЖУУЛАХ: …]» гэж тэмдэглэнэ;
    2. server/edits.js-ийн log-д «auto» засвар болгон хэрэглэнэ — аудитор вэб дээр харж, нэг бүрчлэн буцаана;
    3. засаж чадаагүй саналыг Word comment («Гараар засах») болгоно.
  Үр дүн: edits/v<n>/working.docx (засвартай) ба working_tracked.docx (Track Changes + comment, Word-оор хянах).
  Төлөв: edits/v<n>/autofix.json — { state: running|done|failed, total, done, items: { RV-id: { status, reason } } }.
  Эцсийн тайлан аудиторынх: засварыг хүлээн авах, ноорог хэсгийг бөглөх нь хүний шийдвэр.
*/

const fs = require('fs');
const path = require('path');
const C = require('./common');
const ED = require('./edits');
const SUG = require('./suggest');

const CONCURRENCY = 2;
const BY = 'AI (автомат)';
const running = new Set();
const afFile = (rootId, n) => path.join(ED.edDir(rootId, n), 'autofix.json');
const read = (rootId, n) => C.readJson(afFile(rootId, n));
const write = (rootId, n, st) => { fs.mkdirSync(ED.edDir(rootId, n), { recursive: true }); C.writeJson(afFile(rootId, n), st); };

/** Нэг санал: AI-аар засвар бэлтгэж, тайланд хэрэглэнэ → { status, reason? } */
async function fixOne(rootId, n, item) {
  if (!item.anchor) return { status: 'no_anchor', reason: 'Тайлангийн тодорхой хэсэгт холбогдоогүй санал — аудитор өөрөө засна.' };
  const r = await SUG.suggest(rootId, n, item.id, BY, { draft: true });
  if (r.error) return { status: 'failed', reason: r.error };
  const s = r.suggestion;   // жинхэнэ утгаар
  if (!s.fixable) return { status: 'not_fixable', reason: s.reason };
  const a = ED.applyAuto(rootId, n, item.id, s);
  return a.error ? { status: 'conflict', reason: a.error } : { status: 'applied', seq: a.edit.seq, draft: !!a.edit.draft };
}

/**
 * Release-ийн дараа дуудна (хүлээхгүй). Аль хэдийн ажиллаж байгаа / дууссан бол дахин эхлүүлэхгүй (force-оор дахин).
 * onDone(summary) — мэдэгдэл илгээхэд.
 */
function start(rootId, n, by, { force = false, onDone } = {}) {
  const key = `${rootId}/${n}`;
  if (running.has(key)) return { error: 'AI засвар хийгдэж байна' };
  const prev = read(rootId, n);
  // Сервер дахин ассанаар тасарсан (running) бол үргэлжлүүлнэ — хэрэглэсэн засвар давхардахгүй
  if (prev && !force && !['failed', 'running'].includes(prev.state)) return { error: 'AI засвар аль хэдийн хийгдсэн' };
  const fb = ED.feedback(rootId, n);
  if (!fb) return { error: 'Энэ хувилбарт feedback илгээгдээгүй байна' };
  const items = (fb.items || []).filter(x => x.id);
  const st = { state: 'running', by, started: C.nowIso(), total: items.length, done: 0, items: Object.fromEntries(items.map(x => [x.id, prev?.items?.[x.id]?.status === 'applied' ? prev.items[x.id] : { status: 'pending' }])) };
  write(rootId, n, st);
  running.add(key);
  (async () => {
    const queue = items.filter(x => st.items[x.id].status === 'pending');
    st.done = items.length - queue.length;
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        let res;
        try { res = await fixOne(rootId, n, it); } catch (e) { res = { status: 'failed', reason: String(e.message || e).slice(0, 300) }; }
        st.items[it.id] = res; st.done++;
        write(rootId, n, st);
        // Claude нэвтрээгүй г.м. бүх саналд давтагдах алдаа — үлдсэнийг хүлээлгэхгүй
        if (res.status === 'failed' && /нэвтрээгүй|олдсонгүй — серверт/.test(res.reason || '')) { st.error = res.reason; queue.length = 0; }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    for (const [id, x] of Object.entries(st.items)) if (x.status === 'pending') st.items[id] = { status: 'failed', reason: st.error || 'Хийгдээгүй' };
    const vals = Object.values(st.items);
    Object.assign(st, { state: st.error && !vals.some(x => x.status === 'applied') ? 'failed' : 'done', finished: C.nowIso() });
    write(rootId, n, st);
    ED.rebuild(rootId, n);   // comment-тай Word хувилбар
    const summary = { fixed: vals.filter(x => x.status === 'applied').length, drafts: vals.filter(x => x.draft).length, manual: vals.filter(x => x.status !== 'applied').length, total: st.total, state: st.state, error: st.error };
    if (onDone) try { onDone(summary); } catch { /* мэдэгдэл */ }
  })().catch(e => { st.state = 'failed'; st.error = String(e.message || e).slice(0, 300); st.finished = C.nowIso(); write(rootId, n, st); })
    .finally(() => running.delete(key));
  return { ok: true, total: items.length };
}

const isRunning = (rootId, n) => running.has(`${rootId}/${n}`);

module.exports = { start, read, isRunning };
