'use strict';
// The reader end to end with a stand-in engine (chat messages + a scripted model), and its pure parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const X = require('../world-archive/lib/extract.cjs');
const service = require('../world-archive/lib/service.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });

test('unread: holds back the newest two, resumes after the last read id, falls back to the count', () => {
  const ms = Array.from({ length: 10 }, (_, i) => msg(i, `글 ${i}`));
  assert.deepEqual(X.unread(ms, null).pending.map((m) => m.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  assert.deepEqual(X.unread(ms, { lastId: 'm5', count: 6 }).pending.map((m) => m.id), ['m6', 'm7']);
  assert.deepEqual(X.unread(ms, { lastId: 'gone', count: 7 }).pending.map((m) => m.id), ['m7']);
  assert.equal(X.unread(ms.slice(0, 2), null).pending.length, 0);
});

test('batches stay under the size limits and carry the two messages before them', () => {
  const ms = Array.from({ length: 70 }, (_, i) => msg(i, 'ㄱ'.repeat(1000)));
  const parts = X.batches(ms, 0);
  assert.ok(parts.every((p) => p.batch.reduce((n, m) => n + m.content.length, 0) <= 14000));
  assert.deepEqual(parts[1].context.map((m) => m.id), parts[0].batch.slice(-2).map((m) => m.id));
  assert.equal(parts.at(-1).end, 70);
  assert.equal(parts.flatMap((p) => p.batch).length, 70);
});

test('checkItems keeps only what the text supports, and takes the evidence sentence from the text', () => {
  const [part] = X.batches([msg(1, '사서 선생님인 "마르타"는 도서관 열쇠를 늘 목에 걸고 다닌다. 아무도 그 열쇠를 본 적이 없다.'), msg(2, '서하가 웃었다.')], 0);
  const { items, dropped } = X.checkItems({
    items: [
      { type: 'person', name: '마르타', aliases: ['사서 선생님'], fields: { affiliation: '도서관' }, evidence: [{ n: '1.1', q: '열쇠를 늘 목에' }] },
      { type: 'place', name: '도서관', evidence: [{ n: '7.7', q: '그 열쇠를 본 적이' }] },
      { type: 'person', name: '서하', evidence: [{ n: '2.1', q: '서하가 웃었다' }] },
      { type: 'person', name: '유령 교장', evidence: [{ n: '1.1', q: '열쇠' }] },
      { type: 'rule', name: '마르타', evidence: [{ n: '9.9', q: '지어낸 구절' }] },
      { type: 'monster', name: '마르타', evidence: [{ n: '1.1' }] },
      'junk',
    ],
  }, part, ['서하', '나']);
  assert.deepEqual(items.map((x) => x.name), ['마르타', '도서관']);
  assert.equal(items[0].evidence, '사서 선생님인 "마르타"는 도서관 열쇠를 늘 목에 걸고 다닌다.');
  assert.equal(items[1].evidence, '아무도 그 열쇠를 본 적이 없다.', 'a wrong number is found again by its phrase');
  assert.deepEqual(items[0].evidenceAt, [{ messageId: 'm1', sentence: 1 }]);
  assert.deepEqual(dropped.map((d) => d.why), ['card', 'name not in text', 'no evidence sentence', 'type']);
});

test('buildPrompt names the cards to skip, the known settings near the text, and only the new messages to read', () => {
  const part = X.batches([msg(0, '앞 내용'), msg(1, '앞 내용 2'), msg(2, '마르타가 들어왔다.')], 2)[0];
  const [sys, user] = X.buildPrompt({ name: '별빛 학원', description: '' }, [
    { type: 'person', name: '마르타', aliases: ['사서'], fields: { age: '50대' } },
    { type: 'place', name: '옥상', aliases: [], fields: {} },
  ], part, ['서하']);
  assert.match(sys.content, /person: gender\(성별\)/);
  assert.match(user.content, /\[카드가 있는 인물 — 적지 마\]\n서하/);
  assert.match(user.content, /- \(person\) 마르타 \[사서\] :: age=50대/);
  assert.match(user.content, /그 밖에 이미 있는 항목: 옥상\(place\)/);
  assert.match(user.content, /\[앞 내용 — 참고만[^\]]*\]\n\[나\] 앞 내용\n\[서하\] 앞 내용 2/);
  assert.match(user.content, /\[새 대화 — 여기서만 뽑아[^\]]*\]\n#3 \[나\]\n3\.1 마르타가 들어왔다\./);
});

test('parseJsonObject reads fenced or thinking replies', () => {
  assert.deepEqual(real.parseJsonObject('<think>음</think>```json\n{"items":[{"a":"}"}]}\n```'), { items: [{ a: '}' }] });
  assert.equal(real.parseJsonObject('없음'), null);
});

function setup(t, messages, replies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-x-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const calls = [];
  service._test.useEngine({
    model: async (id) => { if (!id) throw Error('no connection'); return { id }; },
    chatMessages: async () => ({ messages, cast: ['서하', '나'] }),
    askModel: async (m, prompt) => { calls.push(prompt); return { content: replies.shift() ?? '{"items":[]}' }; },
    parseJsonObject: real.parseJsonObject,
    listConnections: async () => [],
  });
  service._test.jobs.clear();
  const w = s.createWorld({ name: '별빛 학원', auto: { enabled: true, connectionId: 'c1', every: 4 } });
  s.linkRoom('room', w.worldId);
  return { s, w, calls };
}

test('runRoom: waits for enough settled messages, then reads, writes, and remembers where it stopped', async (t) => {
  const messages = [msg(0, '안녕'), msg(1, '사서 마르타는 열쇠를 목에 건다.'), msg(2, '그래?'), msg(3, '응.')];
  const reply = JSON.stringify({ items: [
    { type: 'person', name: '마르타', aliases: ['사서'], fields: { affiliation: '도서관' }, evidence: [{ n: '2.1', q: '사서 마르타는' }] },
    { type: 'person', name: '지어낸 사람', evidence: [{ n: '2.1', q: '없는 문장' }] },
  ] });
  const { s, w, calls } = setup(t, messages, [reply]);
  let job = await service.runRoom('room');
  assert.equal(job.state, 'idle', 'only 2 settled messages, every is 4');
  assert.equal(calls.length, 0);
  messages.push(msg(4, '내일 봐.'), msg(5, '잘 자.'));
  job = await service.runRoom('room');
  assert.equal(job.state, 'done');
  assert.deepEqual([job.added, job.dropped], [1, 1]);
  const [e] = s.listEntities(w.worldId);
  assert.equal(e.name, '마르타');
  assert.equal(e.provenance.source, 'auto');
  assert.deepEqual(s.getRoom('room').read.lastId, 'm3');
  assert.equal((await service.runRoom('room', { all: true })).state, 'idle', 'nothing new to read');
  assert.equal(calls.length, 1);
  assert.equal(s.listHistory(w.worldId)[0].roomId, 'room');
});

test('runRoom: a broken reply is tried twice and then reported; nothing is marked read', async (t) => {
  const messages = Array.from({ length: 8 }, (_, i) => msg(i, `글 ${i}`));
  const { s, calls } = setup(t, messages, ['이건 JSON이 아님', '여전히 아님']);
  const job = await service.runRoom('room', { all: true });
  assert.equal(job.state, 'error');
  assert.match(job.error, /모델 답을 읽지 못했습니다/);
  assert.equal(calls.length, 2);
  assert.equal(s.getRoom('room').read, null);
});

test('scheduleRoom does nothing for rooms that are not linked or not switched on', (t) => {
  const { s, w } = setup(t, [], []);
  service._test.scheduleRoom('nope');
  s.updateWorld(w.worldId, { auto: { enabled: false }, revision: 1 });
  service._test.scheduleRoom('room');
  assert.equal(service._test.jobs.size, 0);
});
