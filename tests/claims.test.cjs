'use strict';
// v0.5.0 H · L · M — a timetable written into a field is left out (it belongs in "timetable"); what someone says is
// kept apart as 「확인 안 됨 · ○○의 말」 and never over a fact; a correction leaves no 「이전」. Made-up world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  return { s, w, by: (n) => s.listEntities(w.worldId).find((e) => e.name === n) };
}

test('the reader\'s fields: a timetable in a group field is left out; a rumour is kept apart; a correction is marked', () => {
  const [part] = X.batches([msg(1, '은사슴 1학년은 월요일 1교시에 별자리학, 화요일 2교시에 약초학을 듣는다. 서하 말로는 노을 교수가 용을 키운다더라. 하윤의 성은 사실 처음부터 윤이었다.')], 0);
  const parsed = { items: [
    { type: 'group', name: '은사슴 1학년', fields: { members: { v: '월요일 1교시 별자리학, 화요일 2교시 약초학', n: ['1.1'] } }, evidence: [{ n: '1.1', q: '은사슴 1학년은' }] },
    { type: 'person', name: '노을 교수', fields: { background: { v: '용을 키운다', n: ['1.2'], rumor: '서하' } }, evidence: [{ n: '1.2', q: '노을 교수가' }] },
    { type: 'person', name: '하윤', fields: { family: { v: '성은 윤', n: ['1.3'], fix: true } }, evidence: [{ n: '1.3', q: '하윤의 성은' }] },
  ] };
  const r = X.checkItems(parsed, part, ['서하', '나']);
  const by = (n) => r.items.find((i) => i.name === n);
  assert.deepEqual(by('은사슴 1학년').fields, {}, 'a timetable in a field');
  assert.ok(r.droppedFields.some((d) => d.why === 'a timetable in a field'));
  assert.deepEqual(by('노을 교수').fields, {});
  assert.deepEqual([by('노을 교수').rumors.background.value, by('노을 교수').rumors.background.by], ['용을 키운다', '서하']);
  assert.deepEqual(by('하윤').corrections, { family: true });
});

test('a rumour never goes over a fact; {{세계}} marks it; the story saying the same as a fact takes it off; undo', (t) => {
  const { s, w, by } = world(t);
  s.applyAuto(w.worldId, [{ type: 'person', name: '노을 교수', fields: { background: '천문학자' } }]);
  s.applyAuto(w.worldId, [{ type: 'person', match: '노을 교수', name: '노을 교수', rumors: { background: { value: '용을 키운다', by: '서하', evidence: '서하 말로는…' } } }]);
  assert.equal(by('노을 교수').fields.background, '천문학자', 'the fact stays');
  assert.equal(by('노을 교수').rumors.background.value, '용을 키운다');
  const text = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, {}).text;
  assert.match(text, /배경: 천문학자\n {2}배경: 용을 키운다 \(소문\)/);
  const rc = s.listHistory(w.worldId).find((c) => c.action === 'rumor');
  s.undoChange(w.worldId, rc.id);
  assert.equal(by('노을 교수').rumors, undefined, 'undo takes the rumour away');
  // a new person known only by a rumour, then the story says it as a fact
  s.applyAuto(w.worldId, [{ type: 'person', name: '그림자 사서', rumors: { state: { value: '밤마다 탑에 오른다', by: '소문' } } }]);
  assert.equal(by('그림자 사서').rumors.state.by, '소문');
  s.applyAuto(w.worldId, [{ type: 'person', match: '그림자 사서', name: '그림자 사서', fields: { state: '밤마다 탑에 오른다' } }]);
  assert.equal(by('그림자 사서').rumors, undefined, 'settled');
  assert.equal(by('그림자 사서').fields.state, '밤마다 탑에 오른다');
});

test('a change keeps 「이전」; a correction does not, and 기록 says so', (t) => {
  const { s, w, by } = world(t);
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤', fields: { affiliation: '은사슴 1학년', family: '성은 한' } }]);
  s.applyAuto(w.worldId, [{ type: 'person', match: '하윤', name: '하윤', fields: { affiliation: '청매 1학년' } }]);
  s.applyAuto(w.worldId, [{ type: 'person', match: '하윤', name: '하윤', fields: { family: '성은 윤' }, corrections: { family: true } }]);
  const e = by('하윤');
  assert.deepEqual(e.past.affiliation.map((p) => p.value), ['은사슴 1학년']);
  assert.equal(e.past.family, undefined, 'no 「이전」 for a correction');
  assert.equal(s.listHistory(w.worldId).find((c) => c.key === 'family' && c.after === '성은 윤').correction, true);
});
