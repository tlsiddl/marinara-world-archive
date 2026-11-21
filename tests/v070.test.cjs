'use strict';
// v0.7.0 — 기억 서재 0.38.2 날짜 맞추기: storydate.cjs is the Memory Module's (8a310e0); years that are not 20xx and a story
// that goes back read the same; the Memory Module's story date (hand fixes included) comes first when it is on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CAL = require('../world-archive/lib/calendar.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');

const m = (content) => ({ content });

test('이야기 속 오늘: 1891 · 1988 as written, and a story that goes back is followed', () => {
  assert.equal(CAL.storyToday([m('§RP | 1891-10-26 (월) | 11:15 | 대강당 | 맑음§')]).date, '1891-10-26');
  const back = CAL.storyToday([m('§RP | 1988-07-19 (화) | 16:15 | 거리 | 흐림§'), m('§RP | 1988-07-15 (금) | 09:00 | 저택 | 맑음§')]);
  assert.equal(back.date, '1988-07-15', 'the last one, not the latest date');
  assert.equal(back.weekday, '금');
});

test('the Memory Module\'s date first (when on), the room\'s own text otherwise', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: '별시계 학원' });
  s.linkRoom('room-d', w.worldId);
  service._test.useEngine({ chatMessages: async () => ({ messages: [{ id: 'a', content: '§RP | 1891-10-26 (월) | 11:15 | 대강당§' }], cast: [] }) });
  const before = globalThis.__marinaraMemory;
  t.after(() => { globalThis.__marinaraMemory = before; service._test.useApp(null); });
  globalThis.__marinaraMemory = { version: '0.38.2' };
  let answer = { enabled: true, storyDate: '1891-11-02' };
  service._test.useApp({ inject: async ({ url }) => ({ statusCode: 200, body: JSON.stringify(url.endsWith('/room-d') ? answer : {}) }) });
  await service._test.updateScene('room-d');
  const st = s.getRoom('room-d').story;
  assert.deepEqual([st.date, st.weekday], ['1891-11-02', '월']);
  // off in the Memory Module: the room's own header
  answer = { enabled: false, storyDate: '1891-11-02' };
  service._test.useApp({ inject: async () => ({ statusCode: 200, body: JSON.stringify(answer) }) });
  await service._test.updateScene('room-d');
  assert.equal(s.getRoom('room-d').story.date, '1891-10-26');
  // no Memory Module at all
  delete globalThis.__marinaraMemory;
  service._test.useApp({ inject: async () => { throw Error('never asked'); } });
  await service._test.updateScene('room-d');
  assert.equal(s.getRoom('room-d').story.date, '1891-10-26');
});

test('v0.7.0 7: the person sets 숨김 per field, a 주제, 일하는 곳 — one edit, undoable; a relation turned around is recorded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤', fields: { age: '11살', personality: '조용함' } }, { type: 'place', name: '찻집' }, { type: 'rule', name: '통금' }, { type: 'person', name: '테오' }]);
  const E = () => s.listEntities(w.worldId);
  const p = E().find((e) => e.name === '하윤');
  const shop = E().find((e) => e.name === '찻집');
  const edited = s.updateEntity(w.worldId, p.entityId, { revision: p.revision, hidden: { age: true, personality: false, gender: true }, work: shop.entityId });
  assert.deepEqual(edited.hidden, { age: true }, 'only fields with a value');
  assert.equal(edited.work, shop.entityId);
  assert.equal(edited.sources.work, 'manual');
  assert.throws(() => s.updateEntity(w.worldId, p.entityId, { revision: edited.revision, work: E().find((e) => e.name === '통금').entityId }), /장소여야/);
  const rule = E().find((e) => e.name === '통금');
  assert.equal(s.updateEntity(w.worldId, rule.entityId, { revision: rule.revision, topic: '시간·영업' }).topic, '시간·영업');
  assert.throws(() => s.updateEntity(w.worldId, rule.entityId, { revision: rule.revision + 1, topic: '아무거나' }), /주제는/);
  const edit = s.listHistory(w.worldId).find((c) => c.action === 'edit' && c.entityId === p.entityId);
  assert.ok(edit.keys.includes('hidden') && edit.keys.includes('work'));
  s.undoChange(w.worldId, edit.id);
  const back = E().find((e) => e.name === '하윤');
  assert.equal(back.hidden, undefined);
  assert.equal(back.work, undefined);
  // a relation turned around by the person
  const teo = E().find((e) => e.name === '테오');
  const rel = s.createRelation(w.worldId, { from: back.entityId, to: teo.entityId, type: '친구', note: '' });
  s.updateRelation(w.worldId, rel.relationId, { from: teo.entityId, to: back.entityId });
  const flip = s.listHistory(w.worldId).find((c) => c.action === 'relation-flip');
  assert.ok(flip);
  s.undoChange(w.worldId, flip.id);
  assert.equal(s.listRelations(w.worldId).find((x) => x.relationId === rel.relationId).from, back.entityId);
});
