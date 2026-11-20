'use strict';
// v0.5.1 I — 장소 배치 · 시설 · 방 배정: a person's 지내는 곳 is the place they stay now (only the current one; the ones
// before as 「이전」), the reader's value never goes over the person's, every change is undoable. Made-up world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, FIELDS } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤' }, { type: 'place', name: '은사슴 기숙사 2호실' }, { type: 'place', name: '은사슴 기숙사 5호실' }, { type: 'place', name: '별시계탑' }]);
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  return { s, w, by, id: (n) => by(n).entityId };
}

test('지내는 곳: only the current one; the one before is 「이전」; the person\'s value stays; undo one by one', (t) => {
  const { s, w, by, id } = world(t);
  s.setRoom(w.worldId, id('하윤'), id('은사슴 기숙사 2호실'), { by: 'reader', evidence: '하윤은 2호실을 배정받았다.' });
  assert.equal(by('하윤').room, id('은사슴 기숙사 2호실'));
  assert.equal(by('하윤').sources.room, 'auto');
  const moved = s.setRoom(w.worldId, id('하윤'), id('은사슴 기숙사 5호실'), { by: 'reader' });
  assert.equal(by('하윤').room, id('은사슴 기숙사 5호실'), 'a new room takes the place of the old one');
  assert.deepEqual(by('하윤').roomPast.map((x) => x.placeId), [id('은사슴 기숙사 2호실')], 'the one before is kept as 「이전」');
  assert.deepEqual([moved.action, moved.beforeName, moved.afterName], ['room', '은사슴 기숙사 2호실', '은사슴 기숙사 5호실']);
  assert.throws(() => s.setRoom(w.worldId, id('하윤'), id('하윤')), /장소여야/);
  // undo: back to 2호실, no 「이전」
  s.undoChange(w.worldId, moved.id);
  assert.equal(by('하윤').room, id('은사슴 기숙사 2호실'));
  assert.equal(by('하윤').roomPast, undefined);
  // the person sets it: the reader no longer writes over it
  s.setRoom(w.worldId, id('하윤'), id('별시계탑'), {}, { force: true });
  assert.equal(s.setRoom(w.worldId, id('하윤'), id('은사슴 기숙사 5호실'), { by: 'reader' }), null);
  assert.equal(by('하윤').room, id('별시계탑'));
  assert.equal(by('하윤').sources.room, 'manual');
});

test('{{세계}}: 「지내는 곳: …」 on the person\'s line; a merged place keeps its people; 배치·내부 구조 is the layout label', (t) => {
  const { s, w, by, id } = world(t);
  s.setRoom(w.worldId, id('하윤'), id('은사슴 기숙사 2호실'));
  let text = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, {}).text;
  assert.match(text, /- 하윤\n {2}지내는 곳: 은사슴 기숙사 2호실/);
  const keep = by('은사슴 기숙사 5호실');
  const drop = by('은사슴 기숙사 2호실');
  s.mergeEntities(w.worldId, { keepId: keep.entityId, dropId: drop.entityId, keepRevision: keep.revision, dropRevision: drop.revision });
  assert.equal(by('하윤').room, keep.entityId, 'merging the room moves her along');
  text = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, {}).text;
  assert.match(text, /지내는 곳: 은사슴 기숙사 5호실/);
  assert.equal(FIELDS.place.find((f) => f.key === 'layout').label, '배치·내부 구조');
});

test('the reader: a person\'s room is a place (made in the same batch is fine); moving rooms keeps the one before; the prompt asks for it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rm2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const messages = [msg(0, '안녕'), msg(1, '하윤은 은사슴 기숙사 3층 7호실을 배정받았다. 7호실에는 침대 다섯 개가 창가에 놓여 있다. 서윤은 늘 웃는다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  let reply = JSON.stringify({ items: [
    { type: 'person', name: '하윤', room: '3층 7호실', evidence: [{ n: '2.1', q: '하윤은' }] },
    { type: 'place', name: '3층 7호실', aliases: ['7호실'], fields: { layout: { v: '침대 다섯 개가 창가에', n: ['2.2'] } }, evidence: [{ n: '2.2', q: '7호실에는' }] },
    { type: 'person', name: '서윤', room: '하윤', evidence: [{ n: '2.3', q: '서윤은' }] },
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
  assert.equal((await service.runRoom('room')).state, 'done');
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.equal(by('하윤').room, by('3층 7호실').entityId, 'a place made in the same batch');
  assert.equal(by('3층 7호실').fields.layout, '침대 다섯 개가 창가에');
  assert.equal(by('서윤').room, undefined, 'a person is not a room');
  // she moves: the new one only, the old one as 「이전」
  messages.push(msg(6, '하윤은 탑 꼭대기 1호실로 방을 옮겼다.'), msg(7, '그렇구나.'), msg(8, '응.'), msg(9, '잘 자.'));
  reply = JSON.stringify({ items: [
    { type: 'person', name: '하윤', match: '하윤', room: '탑 꼭대기 1호실', evidence: [{ n: '7.1', q: '하윤은' }] },
    { type: 'place', name: '탑 꼭대기 1호실', evidence: [{ n: '7.1', q: '탑 꼭대기 1호실' }] },
  ] });
  assert.equal((await service.runRoom('room')).state, 'done');
  assert.equal(by('하윤').room, by('탑 꼭대기 1호실').entityId);
  assert.deepEqual(by('하윤').roomPast.map((x) => x.placeId), [by('3층 7호실').entityId]);
  const prompt = X.buildPrompt({ name: 'x' }, [], X.batches([msg(1, '가.')], 0)[0], [])[0].content;
  assert.match(prompt, /room\(지내는 곳\)을 적는다/);
  assert.match(prompt, /layout\(배치·내부 구조\)/);
});
