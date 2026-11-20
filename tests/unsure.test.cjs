'use strict';
// v0.5.1 N — 헷갈리면 띄우기: when the reader is not sure a new setting is one the world has, it is not skipped — it is
// made, and the pair is shown in 「같은 것일 수 있음」 for the person to merge or keep apart. Made-up world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });

test('the reader: an unsure one is made and shown first in 「같은 것일 수 있음」; 「다른 것이에요」 · 합치기 are the person\'s', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-un-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const messages = [msg(0, '안녕'), msg(1, '윤 반장이 복도 끝에서 손을 흔들었다. 북쪽 탑 꼭대기에는 낡은 관측실이 있다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  const reply = JSON.stringify({ items: [
    { type: 'person', name: '윤 반장', maybe: '윤하윤', evidence: [{ n: '2.1', q: '윤 반장이' }] },
    { type: 'place', name: '낡은 관측실', maybe: '별시계탑 관측실', evidence: [{ n: '2.2', q: '낡은 관측실' }] },
    { type: 'place', name: '북쪽 탑', maybe: '윤하윤', evidence: [{ n: '2.2', q: '북쪽 탑' }] },
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
  s.applyAuto(w.worldId, [{ type: 'person', name: '윤하윤', fields: { affiliation: '은사슴 반장' } }, { type: 'place', name: '별시계탑 관측실' }]);
  s.linkRoom('room', w.worldId);
  s.setRoomRead('room', { lastId: null, count: 0 });
  const job = await service.runRoom('room');
  assert.equal(job.state, 'done');
  assert.equal(job.unsure, 2, 'a person to a place is no pair');
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.ok(by('윤 반장') && by('낡은 관측실'), 'made, not skipped');
  const pairs = s.listDuplicates(w.worldId);
  const unsure = pairs.filter((p) => p.unsure);
  assert.deepEqual(unsure.map((p) => [p.type, p.a, p.b]), [
    ['person', by('윤하윤').entityId, by('윤 반장').entityId],
    ['place', by('별시계탑 관측실').entityId, by('낡은 관측실').entityId],
  ]);
  assert.match(unsure[0].why, /헷갈려 했어요 — 「윤 반장이 복도 끝에서 손을 흔들었다\.」/);
  assert.equal(pairs[0].unsure, true, 'shown first');
  // 「다른 것이에요」: not shown again
  s.dismissPair(w.worldId, by('별시계탑 관측실').entityId, by('낡은 관측실').entityId);
  assert.equal(s.listDuplicates(w.worldId).filter((p) => p.unsure).length, 1);
  // 합치기: the pair goes with it
  const keep = by('윤하윤');
  const drop = by('윤 반장');
  s.mergeEntities(w.worldId, { keepId: keep.entityId, dropId: drop.entityId, keepRevision: keep.revision, dropRevision: drop.revision });
  assert.equal(s.listDuplicates(w.worldId).filter((p) => p.unsure).length, 0);
  assert.match(X.buildPrompt({ name: 'x' }, [], X.batches([msg(1, '가.')], 0)[0], [])[0].content, /버리지 말고 새 항목으로 적되 maybe에/);
});

test('maybe and match together: match wins (it is that one)', () => {
  const [part] = X.batches([msg(1, '윤 반장이 손을 흔들었다.')], 0);
  const r = X.checkItems({ items: [{ type: 'person', name: '윤 반장', match: '윤하윤', maybe: '윤하윤', evidence: [{ n: '1.1', q: '윤 반장이' }] }] }, part, ['서하', '나']);
  assert.equal(r.items[0].maybe, null);
  assert.equal(r.items[0].match, '윤하윤');
});
