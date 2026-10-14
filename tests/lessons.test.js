'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LS = require('../server/lessons');

function mkJob(root, name, issues, decisions) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'sandbox', 'output'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), '{}');
  fs.writeFileSync(path.join(dir, 'sandbox', 'output', 'review_findings.json'), JSON.stringify({ schema_version: 3, issues }));
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(decisions));
  return dir;
}

test('сургамж: REJECTED / EDITED / MANUAL цуглуулж, token хасаж, давхардлыг тоолно', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsn-'));
  mkJob(root, 'a', [
    { id: 'RV-1', rule: 'M05-03', title: 'Нэр томьёо тогтворгүй', issue: '[PERSON-0001]-ийн нэр' },
    { id: 'RV-2', rule: 'M08-04', title: 'Хугацаа тодорхойгүй', required_action: 'Хугацаа нэм' },
    { id: 'RV-3', rule: 'G0-02', title: 'Систем', origin: 'rule_engine' },
    { id: 'MAN-001', rule: 'M06-01', title: 'Эрсдэлийн үнэлгээ дутуу', origin: 'manual', issue: 'Шалтгаан алга' },
  ], { 'RV-1': { decision: 'REJECTED', at: '2026-10-01' }, 'RV-2': { decision: 'EDITED', edited_text: '2026-12-31-ний дотор салбарын захирал хариуцан засна', at: '2026-10-02' },
    'RV-3': { decision: 'REJECTED' } });
  mkJob(root, 'b', [{ id: 'RV-9', rule: 'M05-03', title: 'Нэр томьёо тогтворгүй', issue: 'x' }], { 'RV-9': { decision: 'REJECTED', at: '2026-10-05' } });
  const cur = mkJob(root, 'c', [{ id: 'RV-5', rule: 'M01-01', title: 'Өөрийн', issue: 'y' }], { 'RV-5': { decision: 'REJECTED' } });

  const ls = LS.collect({ jobsDir: root, excludeDir: cur });
  const rej = ls.filter(l => l.kind === 'REJECTED');
  assert.strictEqual(rej.length, 1);
  assert.strictEqual(rej[0].times, 2);
  assert.ok(!JSON.stringify(ls).includes('PERSON-0001'));
  assert.ok(ls.some(l => l.kind === 'EDITED' && l.after.includes('2026-12-31')));
  assert.ok(ls.some(l => l.kind === 'MANUAL' && l.rule === 'M06-01'));
  assert.ok(!ls.some(l => l.rule === 'G0-02' || l.title === 'Өөрийн'));

  // attach: мэдэгдэхгүй ID-г хасна, issue_ids-ийг холбоно
  const id = rej[0].id;
  const f = { issues: [{ id: 'RV-X', lesson_refs: [id, 'L-NOPE'] }], lessons_applied: [{ lesson_id: 'L-FAKE', effect: 'raised' }, { lesson_id: id, effect: 'reworded', note: 'ok' }] };
  LS.attach(f, ls);
  assert.deepStrictEqual(f.issues[0].lesson_refs, [id]);
  assert.strictEqual(f.lessons_applied.length, 1);
  assert.deepStrictEqual(f.lessons_applied[0].issue_ids, ['RV-X']);
  assert.strictEqual(f.lessons_used[0].id, id);
  assert.strictEqual(f.lessons_available, ls.length);
});
