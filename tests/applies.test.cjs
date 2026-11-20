'use strict';
// v0.5.0 C — 적용되는 곳: a rule or system holds in one place or group (empty: the whole world). The reader names it,
// the service finds the setting; the same name somewhere else is another rule; the person's value is never written
// over; recorded and undoable; {{세계}} says where. Made-up world only (별시계 학원).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '은사슴 기숙사', aliases: ['은사슴'] },
    { type: 'group', name: '청매 기숙사', aliases: ['청매'] },
    { type: 'place', name: '별시계탑' },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n)?.entityId;
  const rules = (n) => s.listEntities(w.worldId).filter((e) => e.name === n);
  return { s, w, id, rules };
}

test('the same rule name in another place or group is another rule; the same place matches; an empty one is filled', (t) => {
  const { s, w, id, rules } = world(t);
  s.applyAuto(w.worldId, [{ type: 'rule', name: '기숙사 암호는 2주마다 바뀐다', appliesTo: id('은사슴 기숙사') }]);
  s.applyAuto(w.worldId, [{ type: 'rule', name: '기숙사 암호는 2주마다 바뀐다', appliesTo: id('청매 기숙사') }]);
  assert.deepEqual(rules('기숙사 암호는 2주마다 바뀐다').map((e) => e.appliesTo).sort(), [id('은사슴 기숙사'), id('청매 기숙사')].sort(), 'two rules');
  s.applyAuto(w.worldId, [{ type: 'rule', name: '기숙사 암호는 2주마다 바뀐다', appliesTo: id('은사슴 기숙사'), memo: '석벽에 대고 말한다' }]);
  assert.equal(rules('기숙사 암호는 2주마다 바뀐다').length, 2, 'same place: matched, not a third');
  // a rule with no place yet, then the reader names one: filled through setAppliesTo
  s.applyAuto(w.worldId, [{ type: 'system', name: '별시계 종소리' }]);
  const c = s.setAppliesTo(w.worldId, rules('별시계 종소리')[0].entityId, id('별시계탑'), { by: 'reader' });
  assert.deepEqual([c.action, c.beforeName, c.afterName], ['applies', '', '별시계탑']);
  assert.equal(rules('별시계 종소리')[0].sources.appliesTo, 'auto');
  assert.throws(() => s.setAppliesTo(w.worldId, rules('별시계 종소리')[0].entityId, rules('기숙사 암호는 2주마다 바뀐다')[0].entityId), (e) => e.status === 400, 'only a place or group');
});

test('the person\'s 적용되는 곳 is theirs: the reader does not change it; undo; a merged place keeps its rules', (t) => {
  const { s, w, id, rules } = world(t);
  s.applyAuto(w.worldId, [{ type: 'rule', name: '밤 10시 이후 소등' }]);
  const r = rules('밤 10시 이후 소등')[0];
  s.setAppliesTo(w.worldId, r.entityId, id('은사슴 기숙사'), {}, { force: true });
  assert.equal(s.setAppliesTo(w.worldId, r.entityId, id('청매 기숙사'), { by: 'reader' }), null, 'not over the person\'s');
  assert.equal(rules('밤 10시 이후 소등')[0].appliesTo, id('은사슴 기숙사'));
  // the person sets it back to the whole world, then undoes that
  s.setAppliesTo(w.worldId, r.entityId, null, {}, { force: true });
  assert.equal(rules('밤 10시 이후 소등')[0].appliesTo, undefined);
  const last = s.listHistory(w.worldId).find((c) => c.action === 'applies');
  s.undoChange(w.worldId, last.id);
  assert.equal(rules('밤 10시 이후 소등')[0].appliesTo, id('은사슴 기숙사'));
  // merging 은사슴 into another group moves the rule's place along
  s.applyAuto(w.worldId, [{ type: 'group', name: '은사슴 학생회' }]);
  const keep = s.listEntities(w.worldId).find((e) => e.name === '은사슴 학생회');
  const drop = s.listEntities(w.worldId).find((e) => e.name === '은사슴 기숙사');
  s.mergeEntities(w.worldId, { keepId: keep.entityId, dropId: drop.entityId, keepRevision: keep.revision, dropRevision: drop.revision });
  assert.equal(rules('밤 10시 이후 소등')[0].appliesTo, keep.entityId);
});

test('{{세계}}: a rule that holds somewhere says where', (t) => {
  const { s, w, id, rules } = world(t);
  s.applyAuto(w.worldId, [{ type: 'rule', name: '탑 계단은 오른쪽으로만', appliesTo: id('별시계탑') }, { type: 'rule', name: '마법은 지팡이로' }]);
  const text = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, {}).text;
  assert.match(text, /- 탑 계단은 오른쪽으로만 \[별시계탑에서\]/);
  assert.match(text, /- 마법은 지팡이로\n|- 마법은 지팡이로$/);
  void rules;
});

test('the reader: where is a name; a place made in the same batch is found after it is saved; a person or nonsense is not a place', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ap2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const messages = [msg(0, '안녕'), msg(1, '은사슴 기숙사의 암호는 2주마다 바뀐다. 새 온실에서는 장갑을 껴야 한다. 하윤은 늘 웃는다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  const reply = JSON.stringify({ items: [
    { type: 'rule', name: '기숙사 암호는 2주마다 바뀐다', where: '은사슴 기숙사', evidence: [{ n: '2.1', q: '암호는 2주마다' }] },
    { type: 'rule', name: '온실에서는 장갑', where: '새 온실', evidence: [{ n: '2.2', q: '장갑을 껴야' }] },
    { type: 'place', name: '새 온실', evidence: [{ n: '2.2', q: '새 온실에서는' }] },
    { type: 'rule', name: '웃어야 한다', where: '하윤', evidence: [{ n: '2.3', q: '하윤은 늘 웃는다' }] },
    { type: 'person', name: '하윤', evidence: [{ n: '2.3', q: '하윤은' }] },
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
  s.applyAuto(w.worldId, [{ type: 'group', name: '은사슴 기숙사' }]);
  s.linkRoom('room', w.worldId);
  s.setRoomRead('room', { lastId: null, count: 0 });
  const job = await service.runRoom('room');
  assert.equal(job.state, 'done');
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.equal(by('기숙사 암호는 2주마다 바뀐다').appliesTo, by('은사슴 기숙사').entityId, 'a group the world had');
  assert.equal(by('온실에서는 장갑').appliesTo, by('새 온실').entityId, 'a place of the same batch, set after saving');
  assert.equal(by('웃어야 한다').appliesTo, undefined, 'a person is not where a rule holds');
  assert.match(X.buildPrompt({ name: 'x' }, [], X.batches([msg(1, '가.')], 0)[0], [])[0].content, /where\(적용되는 곳\)를 적는다/);
});
