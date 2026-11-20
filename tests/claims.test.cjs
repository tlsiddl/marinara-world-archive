'use strict';
// v0.5.0 H · L · M — a timetable written into a field moves to a 시간표 (v0.5.1 H: 「시간표로 옮김」); what someone says is
// kept apart as 「확인 안 됨 · ○○의 말」 and never over a fact; a correction leaves no 「이전」. Made-up world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  return { s, w, by: (n) => s.listEntities(w.worldId).find((e) => e.name === n) };
}

test('the reader\'s fields: a timetable in a group field moves to its 시간표; a rumour is kept apart; a correction is marked', () => {
  const [part] = X.batches([msg(1, '은사슴 1학년은 월요일 1교시에 별자리학, 화요일 2교시에 약초학을 듣는다. 서하 말로는 노을 교수가 용을 키운다더라. 하윤의 성은 사실 처음부터 윤이었다.')], 0);
  const parsed = { items: [
    { type: 'group', name: '은사슴 1학년', fields: { members: { v: '월요일 1교시 별자리학, 화요일 2교시 약초학', n: ['1.1'] } }, evidence: [{ n: '1.1', q: '은사슴 1학년은' }] },
    { type: 'person', name: '노을 교수', fields: { background: { v: '용을 키운다', n: ['1.2'], rumor: '서하' } }, evidence: [{ n: '1.2', q: '노을 교수가' }] },
    { type: 'person', name: '하윤', fields: { family: { v: '성은 윤', n: ['1.3'], fix: true } }, evidence: [{ n: '1.3', q: '하윤의 성은' }] },
  ] };
  const r = X.checkItems(parsed, part, ['서하', '나']);
  const by = (n) => r.items.find((i) => i.name === n);
  assert.deepEqual(by('은사슴 1학년').fields, {}, 'nothing left of the field: it stays empty');
  assert.deepEqual(by('은사슴 1학년').toTimetable.map((m) => [m.key, m.cells.map((c) => `${c.day} ${c.slot} ${c.value}`)]), [['members', ['월 1교시 별자리학', '화 2교시 약초학']]], 'not thrown away');
  assert.ok(!r.droppedFields.length);
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

test('v0.5.1 H: 「월·수 오후 도서관 당번, 책을 좋아함」 in 배경 → two cells of her 시간표 + 배경 「책을 좋아함」; 「시간표로 옮김」 in the history, undoable; for a place, 「시간표로 모으기」', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-h-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const messages = [msg(0, '안녕'), msg(1, '하윤은 월·수 오후 도서관 당번이고, 책을 좋아한다. 별시계탑은 화·목 저녁 천문 관측 모임에 열린다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  const reply = JSON.stringify({ items: [
    { type: 'person', name: '하윤', fields: { background: { v: '월·수 오후 도서관 당번, 책을 좋아함', n: ['2.1'] } }, evidence: [{ n: '2.1', q: '하윤은' }] },
    { type: 'place', name: '별시계탑', fields: { use: { v: '화·목 저녁 천문 관측 모임', n: ['2.2'] } }, evidence: [{ n: '2.2', q: '별시계탑은' }] },
  ] });
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    chatMessages: async () => ({ messages, cast: ['서하', '나'] }),
    askModel: async () => ({ content: reply }),
    parseJsonObject: real.parseJsonObject,
    listConnections: async () => [],
  });
  service._test.jobs.clear();
  const w = s.createWorld({ name: '별시계 학원', auto: { enabled: true, connectionId: 'c1', every: 4 } });
  s.linkRoom('room', w.worldId);
  s.setRoomRead('room', { lastId: null, count: 0 });
  const job = await service.runRoom('room');
  assert.equal(job.state, 'done');
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.equal(by('하윤').fields.background, '책을 좋아함', 'the rest of the text stays');
  const sheet = s.listEntities(w.worldId).find((e) => e.timetable?.ownerId === by('하윤').entityId);
  assert.deepEqual(Object.values(sheet.timetable.cells).map((c) => `${c.day} ${c.slot} ${c.value}`).sort(), ['수 오후 도서관 당번', '월 오후 도서관 당번']);
  const moved = s.readHistory(w.worldId).changes.filter((c) => c.action === 'cell' && c.moved);
  assert.equal(moved.length, 2);
  assert.deepEqual(moved[0].moved, { type: 'person', key: 'background' }, '「시간표로 옮김」 — from which field');
  s.undoChange(w.worldId, moved[0].id);
  assert.equal(Object.keys(s.listEntities(w.worldId).find((e) => e.entityId === sheet.entityId).timetable.cells).length, 1, 'undone one by one');
  // a place has no 시간표: a schedule for 「시간표로 모으기」, which finds no owner by code and leaves it for the model
  const cand = by('별시계탑 시설·용도');
  assert.equal(cand.type, 'schedule');
  assert.equal(cand.fields.when, '화·목 저녁 천문 관측 모임');
  assert.equal(cand.fields.where, '별시계탑');
  assert.equal(by('별시계탑').fields.use, undefined, 'nothing left: the field stays empty');
  const g = await service.gatherTimetables(w.worldId, { model: false });
  assert.deepEqual(g.left, ['별시계탑 시설·용도'], 'a 「시간표로 모으기」 candidate');
});
