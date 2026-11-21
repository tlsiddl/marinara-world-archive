'use strict';
// v0.8.0 — 학교가 아닌 세계(왕국 · 도시 · 센티넬 · 헌터) 시험에서 나온 것:
// 1) a short world has no 「한 번 나옴」 yet (rules stay in {{세계}}) 2) the reader's topic · where (template, and a topic
// written in the 분류 칸) 3) translate-back keeps no list numbers 4) a 위치 whose own sentence says 「not inside」 /
// 「옆」 is not made, and recheck takes it off 5) a calendar is a 학사일정 only in a world with a school.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-080-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}
const msg = (n, content) => ({ id: 'm' + n, speaker: 'A', role: 'assistant', content });

test('1) a world read less than 100 messages has no 「한 번 나옴」: its rules go into {{세계}} and are not tidy candidates', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Valdrenn' }).worldId;
  s.applyAuto(w, [{ type: 'rule', name: 'Thornby gate curfew' }], { messageIds: ['m1'] });
  s.linkRoom('roomShort000000000001', w);
  s.setRoomRead('roomShort000000000001', { lastId: 'm48', count: 48 });
  assert.equal(s.onceReady(w), false);
  s.saveTidy(w, { at: null, items: [], fields: [] });
  assert.deepEqual(s.readTidy(w).once, []);
  const ents = s.listEntities(w);
  assert.equal(ents[0].seen.n, 1);
  assert.match(I.assembleWorld(s.getWorld(w), ents, 3000, { onceOn: s.onceReady(w) }).text, /Thornby gate curfew/);
  assert.doesNotMatch(I.assembleWorld(s.getWorld(w), ents, 3000, { onceOn: true }).text, /Thornby gate curfew/, 'a long-read world still leaves it out');
  s.setRoomRead('roomShort000000000001', { lastId: 'm120', count: 120 });
  assert.equal(s.onceReady(w), true);
  assert.deepEqual(s.readTidy(w).once.map((x) => x.name), ['Thornby gate curfew']);
});

test('2) the reader is shown where · topic in the item; a topic name in the 분류 칸 is the topic', () => {
  const [part] = X.batches([msg(1, '등록 의무: 각성한 센티넬은 14일 안에 센터에 등록해야 한다.'), msg(2, '센터 규칙은 엄격했다.')], 0);
  const prompt = X.buildPrompt({ name: 'w' }, [], part, [], [], null, 'ko')[0].content;
  assert.match(prompt, /"where":"rule·system만/);
  assert.match(prompt, /"topic":"rule·system만/);
  const { items } = X.checkItems({ items: [
    { type: 'rule', name: '등록 의무', fields: { category: { v: '금지·예절', n: ['1.1'] } }, evidence: [{ n: '1.1', q: '14일 안에' }] },
    { type: 'rule', name: '센터 규칙', topic: '그 밖', fields: { category: { v: '규정', n: ['2.1'] } }, evidence: [{ n: '2.1', q: '센터 규칙은' }] },
  ] }, part, []);
  assert.equal(items[0].topic, '금지·예절');
  assert.equal(items[0].fields.category, undefined, 'a topic is not a 분류');
  assert.equal(items[1].topic, '그 밖');
  assert.equal(items[1].fields.category, '규정');
});

test('3) translate-back (한국어로 고친 것): a list number the model kept is taken off', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const real = require('../world-archive/lib/vendor/engine.cjs');
  const s = temp(t);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Harrow Bay', auto: { connectionId: 'c1' } }).worldId;
  service._test.useEngine({ model: async (c) => ({ id: c }), askModel: async () => ({ content: JSON.stringify({ t: ['1. A coastal city reached by night train', '2) Harrow Bay', '3. Pier 3'] }) }), parseJsonObject: real.parseJsonObject });
  const r = await service.translateBack(w, ['야간 열차로 도착하는 해안 도시', '해로우 베이', '3. 3번 부두'], 'en');
  assert.deepEqual(r.items, ['A coastal city reached by night train', 'Harrow Bay', '3. Pier 3']);
});

test('4) a 위치 whose own sentence says not inside · next to is not made; under a building still is; recheck takes old ones off', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Center' }).worldId;
  s.applyAuto(w, [
    { type: 'place', name: '센티넬 센터', aliases: ['센터'] }, { type: 'place', name: '지하 통로' }, { type: 'place', name: '격리 병동' },
    { type: 'place', name: '청명 연구소' }, { type: 'place', name: '지하 보관실' }, { type: 'place', name: 'Pier Lane' }, { type: 'place', name: 'Kiosk' },
  ]);
  const id = (n) => s.listEntities(w).find((e) => e.name === n).entityId;
  const ev1 = '지하 통로는 본관 지하 2층 끝에 있는 긴 복도로, 격리 병동은 그 안에 있는 게 아니라 통로 끝의 철문 너머에 있었다.';
  s.applyRelations(w, [
    { from: id('격리 병동'), to: id('지하 통로'), type: '위치', note: '', evidence: ev1 },
    { from: id('지하 통로'), to: id('센티넬 센터'), type: '위치', note: '', evidence: '센터 본관 지하 2층 끝의 지하 통로.' },
    { from: id('청명 연구소'), to: id('센티넬 센터'), type: '위치', note: '', evidence: '리아는 도윤을 데리고 센터 옆 별관의 청명 연구소로 갔다.' },
    { from: id('지하 보관실'), to: id('센티넬 센터'), type: '위치', note: '', evidence: '센터 아래 지하 보관실.' },
    { from: id('Kiosk'), to: id('Pier Lane'), type: '위치', note: '', evidence: 'The kiosk stands next to Pier Lane.' },
  ]);
  const pairs = () => s.readEntities(w).relations.map((r) => [s.listEntities(w).find((e) => e.entityId === r.from).name, s.listEntities(w).find((e) => e.entityId === r.to).name]);
  assert.deepEqual(pairs(), [['지하 통로', '센티넬 센터'], ['지하 보관실', '센티넬 센터']]);
  // one made before v0.8.0 goes at recheck (recorded)
  const doc = s.readEntities(w);
  doc.relations.push({ relationId: 'rel-old-1', from: id('격리 병동'), to: id('지하 통로'), type: '위치', note: '', evidence: ev1, source: 'auto', createdAt: 'x', updatedAt: 'x' });
  s.writeJson(s.entityFile(w), doc);
  const removed = s.recheckRelations(w, { by: 'recheck' });
  assert.deepEqual(removed.map((c) => c.why), ['not inside']);
  assert.equal(pairs().length, 2);
});

test('5) a calendar made by code is a 학사일정 only in a world with a school', (t) => {
  const s = temp(t);
  const a = s.createWorld({ name: 'Center' }).worldId;
  s.applyAuto(a, [{ type: 'place', name: '센티넬 센터' }]);
  const center = s.listEntities(a)[0].entityId;
  s.setEvent(a, { ownerId: center, date: '2026-12-16', name: '정기 검진' });
  assert.ok(s.listEntities(a).some((e) => e.name === '센티넬 센터 일정표'));
  const b = s.createWorld({ name: 'Hogwarts' }).worldId;
  s.applyAuto(b, [{ type: 'group', name: 'Hogwarts School' }]);
  const school = s.listEntities(b)[0].entityId;
  s.setEvent(b, { ownerId: school, date: '1991-09-01', name: '입학식' });
  assert.ok(s.listEntities(b).some((e) => e.name === 'Hogwarts School 학사일정'));
});
