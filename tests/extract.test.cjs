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

test('rules, schedules and the rest are named by description: their evidence is the check, not the name', () => {
  const [part] = X.batches([msg(1, '여관 문은 세 번 두드려야 주인이 연다. 두 번 두드리면 아무도 열지 않는다.'), msg(2, '안개가 짙은 날에는 시장이 닫힌다.')], 0);
  const { items, dropped } = X.checkItems({
    items: [
      { type: 'rule', name: '여관 문 두드리는 관례', evidence: [{ n: '1.1', q: '세 번 두드려야' }] },
      { type: 'schedule', name: '가라앉는 날', fields: { when: { v: '안개가 짙은 날', n: ['2.1'] } }, evidence: [{ n: '2.1' }] },
      { type: 'rule', name: '지어낸 규칙', evidence: [{ n: '9.9', q: '없는 구절' }] },
      { type: 'person', name: '등대지기', evidence: [{ n: '1.1' }] },
    ],
  }, part, []);
  assert.deepEqual(items.map((x) => x.name), ['여관 문 두드리는 관례', '가라앉는 날']);
  assert.equal(items[1].fields.when, '안개가 짙은 날');
  assert.deepEqual(dropped.map((d) => [d.name, d.why]), [['지어낸 규칙', 'no evidence sentence'], ['등대지기', 'name not in text']]);
});

test('each field is checked against its own evidence; a field that fails is left out, the item stays', () => {
  const [part] = X.batches([
    msg(1, '물푸레의 주인은 노인이다. 그의 왼손에는 약지가 없다.'),
    msg(2, 'The old man has kept the inn for thirty years.'),
  ], 0);
  const { items, droppedFields } = X.checkItems({
    items: [{
      type: 'person', name: '물푸레의 주인', evidence: [{ n: '1.1' }],
      fields: {
        age: { v: '노인', n: ['1.1'] },
        appearance: { v: '왼손 약지가 없음', n: ['1.2'] },
        state: { v: '서른 해 전 서른둘, 콧수염이 검었음', n: ['1.2'] }, // the sentence says something else
        family: { v: '아내가 있었음', n: ['8.8'] }, // no such sentence
        background: { v: '서른 해째 여관을 지킴', n: ['2.1'] }, // translated from English: not compared
        personality: '무뚝뚝함', // plain string: taken as before
      },
    }],
  }, part, []);
  const [e] = items;
  assert.deepEqual(Object.keys(e.fields).sort(), ['age', 'appearance', 'background', 'personality']);
  assert.equal(e.fieldEvidence.age, '물푸레의 주인은 노인이다.');
  assert.equal(e.fieldEvidence.appearance, '그의 왼손에는 약지가 없다.');
  assert.equal(e.fieldEvidence.personality, undefined);
  assert.deepEqual(droppedFields.map((d) => [d.key, d.why]), [['state', 'not in its evidence'], ['family', 'no evidence sentence']]);
});

test('class fields need only their sentence; a field without numbers uses the item evidence; paragraphs need 20%', () => {
  const [part] = X.batches([msg(1, '순찰이 다리를 건넌다. 그는 고개를 숙였다. 문은 세 번 두드려야 열린다.')], 0);
  const { items, droppedFields } = X.checkItems({
    items: [
      { type: 'group', name: '순찰', evidence: [{ n: '1.1' }], fields: { kind: { v: '도시 경비대', n: ['1.1'] }, members: { v: '다리를 건너는 사람들', n: [] } } },
      { type: 'person', name: '순찰', evidence: [{ n: '1.2' }], fields: { gender: { v: '남성', n: ['1.2'] }, personality: { v: '고개를 잘 숙임', n: ['1.2'] } } },
      { type: 'rule', name: '문은 세 번 두드린다', evidence: [{ n: '1.3' }], fields: { category: { v: '관례' } } },
    ],
  }, part, []);
  assert.deepEqual(items.map((i) => Object.keys(i.fields).sort()), [['kind', 'members'], ['gender', 'personality'], ['category']]);
  assert.equal(items[0].fieldEvidence.members, '순찰이 다리를 건넌다.', 'no numbers: the item evidence');
  assert.equal(items[2].fieldEvidence.category, '문은 세 번 두드려야 열린다.');
  assert.deepEqual(droppedFields, []);
});

test('a card character\'s own details and mixed-script names are left out; a place named after them stays', () => {
  const [part] = X.batches([msg(1, '이리나의 지팡이는 버드나무다. 이리나의 침실은 동쪽 탑에 있다. Ronald가 웃었다. 론은 손을 흔들었다.')], 0);
  const { items, dropped } = X.checkItems({
    items: [
      { type: 'custom', name: '이리나의 지팡이', evidence: [{ n: '1.1' }] },
      { type: 'place', name: '이리나의 침실', evidence: [{ n: '1.2' }] },
      { type: 'person', name: '론ald', evidence: [{ n: '1.3' }] },
      { type: 'person', name: '론', aliases: ['Ronald'], evidence: [{ n: '1.4' }] },
    ],
  }, part, ['이리나 베인', '해리포터']);
  assert.deepEqual(items.map((i) => i.name), ['이리나의 침실', '론']);
  assert.deepEqual(dropped.map((d) => [d.name, d.why]), [['이리나의 지팡이', 'about a card'], ['론ald', 'mixed script name']]);
});

test('overlap counts the value\'s two-letter pieces found in the evidence', () => {
  assert.equal(X.overlap('노인', '주인은 노인이다'), 1);
  assert.equal(X.overlap('검은 콧수염', '약지가 없다'), 0);
  assert.equal(X.overlap('경계심이 많음', '그는 경계심 어린 눈으로 보았다'), 0.4, 'enough for a paragraph field (30%), not for a line (50%)');
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

test('runRoom restart: forgets where the room was read and reads it all again, keeping the settings', async (t) => {
  const messages = [msg(0, '안녕'), msg(1, '사서 마르타는 열쇠를 목에 건다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  const first = JSON.stringify({ items: [{ type: 'person', name: '마르타', fields: { affiliation: { v: '도서관', n: ['2.1'] } }, evidence: [{ n: '2.1', q: '사서 마르타는' }] }] });
  const again = JSON.stringify({ items: [{ type: 'person', name: '마르타', aliases: ['사서'], evidence: [{ n: '2.1', q: '사서 마르타는' }] }] });
  const { s, w, calls } = setup(t, messages, [first, again]);
  await service.runRoom('room', { all: true });
  assert.equal(s.getRoom('room').read.lastId, 'm3');
  assert.equal((await service.runRoom('room', { all: true })).state, 'idle');
  const job = await service.runRoom('room', { all: true, restart: true, reason: 'restart' });
  assert.equal(job.state, 'done');
  assert.equal(calls.length, 2, 'read from the first message again');
  assert.equal(s.getRoom('room').read.lastId, 'm3');
  const [e] = s.listEntities(w.worldId);
  assert.deepEqual([e.name, e.aliases], ['마르타', ['사서']], 'the setting stays and is updated, not made twice');
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
