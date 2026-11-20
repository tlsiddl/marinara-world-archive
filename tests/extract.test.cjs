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

test('history and system are named by description: kept on their evidence without the name in the text', () => {
  const [part] = X.batches([
    msg(1, '백 년 전 두 왕국이 북쪽 국경에서 싸웠고, 그 뒤로 강이 국경이 되었다. 마법은 지팡이 없이 쓰면 힘이 흩어진다. 많이 쓰면 며칠 앓는다.'),
    msg(2, '이리나의 마력은 남들보다 약하다.'),
  ], 0);
  const { items, dropped, droppedFields } = X.checkItems({
    items: [
      {
        type: 'history', name: '북부 전쟁', evidence: [{ n: '1.1' }],
        fields: { when: { v: '백 년 전', n: ['1.1'] }, who: { v: '두 왕국', n: ['1.1'] }, result: { v: '강이 국경이 되었다', n: ['1.1'] } },
      },
      {
        type: 'system', name: '마법의 원리', evidence: [{ n: '1.2' }],
        fields: { category: { v: '마법', n: ['1.2'] }, how: { v: '지팡이 없이 쓰면 힘이 흩어짐', n: ['1.2'] }, limits: { v: '많이 쓰면 며칠 앓음', n: ['1.3'] } },
      },
      { type: 'history', name: '지어낸 옛일', evidence: [{ n: '9.9', q: '없는 구절' }] },
      { type: 'system', name: '이리나의 마력', evidence: [{ n: '2.1' }] },
      { type: 'history', name: '건국', evidence: [{ n: '1.1' }], fields: { where: { v: '남쪽 바닷가 항구', n: ['1.1'] } } },
    ],
  }, part, ['이리나 베인']);
  assert.deepEqual(items.map((i) => [i.type, i.name]), [['history', '북부 전쟁'], ['system', '마법의 원리'], ['history', '건국']]);
  assert.deepEqual(items[0].fields, { when: '백 년 전', who: '두 왕국', result: '강이 국경이 되었다' });
  assert.deepEqual(Object.keys(items[1].fields).sort(), ['category', 'how', 'limits']);
  assert.equal(items[1].fieldEvidence.limits, '많이 쓰면 며칠 앓는다.');
  assert.deepEqual(dropped.map((d) => [d.name, d.why]), [['지어낸 옛일', 'no evidence sentence'], ['이리나의 마력', 'about a card']]);
  assert.deepEqual(droppedFields.map((d) => [d.name, d.key, d.why]), [['건국', 'where', 'not in its evidence']]);
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

test('buildPrompt explains rule, system and history, and lists them in the item shape and the fields', () => {
  const part = X.batches([msg(0, '마르타가 들어왔다.')], 0)[0];
  const [sys] = X.buildPrompt({ name: '별빛 학원', description: '' }, [], part, []);
  const guide = sys.content.split('종류 (맞는 것을 고른다):\n')[1].split('\n\n')[0].split('\n');
  const kinds = guide.map((l) => l.match(/^- (\w+)\(/)?.[1]).filter(Boolean);
  assert.deepEqual(kinds.slice(0, 7), ['person', 'place', 'group', 'rule', 'system', 'schedule', 'history']);
  assert.equal(kinds[7], 'custom', 'the custom line comes last');
  assert.match(sys.content, /- system\(시스템\): [^\n]*마법·능력·경제·점수/);
  assert.match(sys.content, /- history\(역사\): 이야기가 시작되기 전/);
  assert.match(sys.content, /- rule\(규칙\): 이 세계에서 지켜야 하는 것/);
  assert.match(sys.content, /이야기 안에서 지금 일어나는 사건은 history\(역사\)가 아니다\(그건 기억 서재 몫이다\)/);
  assert.match(sys.content, /rule·system·history 구별/);
  assert.match(sys.content, /"type":"person\|place\|group\|rule\|system\|schedule\|history\|custom"/);
  assert.match(sys.content, /system: category\(분류\), how\(작동 방식\), limits\(제약·대가\)/);
  assert.match(sys.content, /history: when\(시기\), where\(장소\), who\(관련 인물·집단\), result\(결과·영향\)/);
  assert.match(sys.content, /규칙·시스템·일정·역사·기타는 이름을 설명형으로/);
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

test('readReply keeps the whole items of a reply cut off at the length limit', () => {
  const full = '{"items":[{"type":"rule","name":"가","evidence":[{"n":"1.1"}]}]}';
  assert.deepEqual(X.readReply(full, real.parseJsonObject), { items: [{ type: 'rule', name: '가', evidence: [{ n: '1.1' }] }], relations: [], scores: [], cut: false });
  const cut = '```json\n{"items":[{"type":"person","name":"수위","fields":{"age":{"v":"사십 대","n":["1.2"]}},"evidence":[{"n":"1.2","q":"}{"}]},{"type":"rule","name":"문은 세 번","memo":"두 번은 안 \\"열\\"림"},{"type":"place","name":"등대","fields":{"use":{"v":"등';
  const got = X.readReply(cut, real.parseJsonObject);
  assert.equal(got.cut, true);
  assert.deepEqual(got.items.map((i) => i.name), ['수위', '문은 세 번']);
  assert.equal(X.readReply('이건 JSON이 아님', real.parseJsonObject), null);
});

test('runRoom asks for room to answer (8192 tokens) and uses a cut-off reply instead of losing the batch', async (t) => {
  const messages = [msg(0, '안녕'), msg(1, '사서 마르타는 열쇠를 목에 건다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  const { s, w } = setup(t, messages, ['{"items":[{"type":"person","name":"마르타","evidence":[{"n":"2.1"}]},{"type":"person","name":"마르']);
  let asked = null;
  const eng = { ...require('../world-archive/lib/vendor/engine.cjs') };
  service._test.useEngine({
    model: async () => ({}),
    chatMessages: async () => ({ messages, cast: [] }),
    askModel: async (m, prompt, opts) => { asked = opts; return { content: '{"items":[{"type":"person","name":"마르타","evidence":[{"n":"2.1"}]},{"type":"person","name":"마르' }; },
    parseJsonObject: eng.parseJsonObject,
    listConnections: async () => [],
  });
  const job = await service.runRoom('room', { all: true });
  assert.equal(job.state, 'done');
  assert.equal(asked.maxTokens, 8192);
  assert.deepEqual(s.listEntities(w.worldId).map((e) => e.name), ['마르타']);
});

test('a cut-off batch is read again in two halves, so nothing in it is lost', async (t) => {
  const messages = Array.from({ length: 8 }, (_, i) => msg(i, i === 1 ? '사서 마르타는 열쇠를 건다.' : i === 4 ? '수위 오렌은 등대에 산다.' : `글 ${i}`));
  const { s, w, calls } = setup(t, messages, [
    '{"items":[{"type":"person","name":"마르타","evidence":[{"n":"2.1"}]},{"type":"person","name":"오',
    '{"items":[{"type":"person","name":"마르타","evidence":[{"n":"2.1"}]}]}',
    '{"items":[{"type":"person","name":"오렌","evidence":[{"n":"5.1"}]}]}',
  ]);
  const job = await service.runRoom('room', { all: true });
  assert.equal(job.state, 'done');
  assert.equal(calls.length, 3, 'one cut reply, then two halves');
  assert.deepEqual(s.listEntities(w.worldId).map((e) => e.name).sort(), ['마르타', '오렌']);
  assert.equal(s.getRoom('room').read.lastId, 'm5');
  assert.ok(fs.existsSync(path.join(s.dir, 'debug', 'cut-room.txt')));
});

// ---------------------------------------------------------------- the translation glossary (번역 프리셋·단어장)
const G = require('../world-archive/lib/vendor/glossary.cjs');

test('glossary: "A = B" either way round, the room\'s own else the default, nothing when it cannot be read', async () => {
  assert.deepEqual(G.parseGlossary('Severus Snape = 세베루스 스네이프\n마거릿 = Margaret\n노트\n단어 = 낱말\nHogwarts=호그와트'), [
    { from: 'Severus Snape', to: '세베루스 스네이프' },
    { from: 'Margaret', to: '마거릿' },
    { from: 'Hogwarts', to: '호그와트' },
  ]);
  const value = { config: { defaults: { glossary: 'A = 가' }, chats: { room: { glossary: 'B = 나' }, bare: {} } } };
  assert.equal(G.glossaryText(value, 'room'), 'B = 나');
  assert.equal(G.glossaryText(value, 'other'), 'A = 가', 'a room without its own: the default');
  assert.equal(G.glossaryText(value, 'bare'), null, 'a room scope without a glossary field: nothing (not empty)');
  assert.equal(G.glossaryText({ config: { defaults: {} } }, 'room'), null);
  assert.equal(G.glossaryText({}, 'room'), null);
  assert.equal(G.glossaryText(null, 'room'), null);
  assert.equal(G.glossaryText({ config: { defaults: { glossary: '' } } }, 'room'), '', 'a saved empty glossary is a glossary');
  assert.equal(G.findExtension([{ id: 'x', name: '다른 것' }, { id: 'g', name: '번역 프리셋·단어장 (기억 서재 호환)' }]).id, 'g');
  assert.equal(G.findExtension([{ id: 'x', name: '다른 것' }]), null);
  assert.equal(await real.glossary('room'), null, 'outside Marinara the reader fails quietly: null, never empty');
});

test('buildPrompt: only the glossary pairs named in the batch go in, with how to use them', () => {
  const part = X.batches([msg(0, 'Severus Snape가 들어왔다. 마거릿도 왔다.')], 0)[0];
  const pairs = [{ from: 'Severus Snape', to: '세베루스 스네이프' }, { from: 'Margaret', to: '마거릿' }, { from: 'Albus Dumbledore', to: '알버스 덤블도어' }];
  const [sys, user] = X.buildPrompt({ name: '호그와트', description: '' }, [], part, [], pairs);
  assert.match(user.content, /\[번역 단어장 — [^\]]*name을 단어장의 한국어 표기 그대로[^\]]*aliases에 넣어\]\n- Severus Snape = 세베루스 스네이프\n- Margaret = 마거릿\n\n/);
  assert.doesNotMatch(user.content, /덤블도어/, 'a pair not in the batch stays out');
  const [sys0, plain] = X.buildPrompt({ name: '호그와트', description: '' }, [], part, []);
  assert.doesNotMatch(plain.content, /번역 단어장/, 'no glossary: no section');
  assert.equal(sys.content, sys0.content, 'the system prompt does not change');
});

/** setup() with a stand-in glossary reader: source.text is what the extension holds (null: none), source.fail throws. */
function glossarySetup(t, messages, replies, source) {
  const r = setup(t, messages, replies);
  service._test.glossaries.clear();
  service._test.useEngine({
    model: async () => ({}),
    chatMessages: async () => ({ messages, cast: [] }),
    askModel: async (m, prompt) => { r.calls.push(prompt); return { content: replies.shift() ?? '{"items":[]}' }; },
    parseJsonObject: real.parseJsonObject,
    listConnections: async () => [],
    glossary: async (roomId) => { source.asked = (source.asked || 0) + 1; if (source.fail) throw Error('storage down'); return roomId === 'room' ? source.text : null; },
  });
  return r;
}
const six = (first) => [msg(0, first), msg(1, '응.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];

test('runRoom with the glossary: the prompt names the pairs, saved names follow the glossary, renames are undoable', async (t) => {
  const messages = six('Margaret Bell과 Gemma Farley가 왔다.');
  const reply = JSON.stringify({ items: [
    { type: 'person', name: '마가렛 벨', aliases: ['Margaret Bell'], evidence: [{ n: '1.1' }] },
    { type: 'person', name: '젬마 페럴리', aliases: ['Gemma Farley'], evidence: [{ n: '1.1' }] },
  ] });
  const source = { text: 'Margaret Bell = 마거릿 벨\nGemma Farley = 젬마 페얼리\nHogwarts = 호그와트' };
  const { s, w, calls } = glossarySetup(t, messages, [reply, reply], source);
  const job = await service.runRoom('room', { all: true });
  assert.equal(job.state, 'done');
  assert.match(calls[0][1].content, /- Margaret Bell = 마거릿 벨\n- Gemma Farley = 젬마 페얼리\n\n/);
  assert.doesNotMatch(calls[0][1].content, /호그와트/);
  const people = s.listEntities(w.worldId);
  assert.deepEqual(people.map((e) => [e.name, e.aliases]), [['마거릿 벨', ['Margaret Bell', '마가렛 벨']], ['젬마 페얼리', ['Gemma Farley', '젬마 페럴리']]]);
  assert.equal(job.renamed, 2);
  const renames = s.listHistory(w.worldId).filter((c) => c.action === 'rename');
  assert.deepEqual(renames.map((c) => [c.before, c.after, c.by]).sort(), [['마가렛 벨', '마거릿 벨', 'glossary'], ['젬마 페럴리', '젬마 페얼리', 'glossary']]);

  // undone: the old name comes back, and the glossary's stays only a suggestion
  const r = renames.find((c) => c.before === '마가렛 벨');
  assert.equal(s.undoChange(w.worldId, r.id).undone, true);
  let mg = s.listEntities(w.worldId).find((e) => e.entityId === r.entityId);
  assert.deepEqual([mg.name, mg.aliases, mg.glossaryName], ['마가렛 벨', ['Margaret Bell'], '마거릿 벨']);
  s.setRoomRead('room', null);
  await service.runRoom('room', { all: true }); // the same names read again
  mg = s.listEntities(w.worldId).find((e) => e.entityId === r.entityId);
  assert.equal(mg.name, '마가렛 벨', 'an undone rename is not done again');
  // 「적용」 is the person's own rename: the suggestion goes, the name is the person's
  const applied = s.updateEntity(w.worldId, mg.entityId, { name: mg.glossaryName, aliases: [...mg.aliases, mg.name], revision: mg.revision });
  assert.deepEqual([applied.name, applied.glossaryName, applied.sources.name], ['마거릿 벨', undefined, 'manual']);
});

test('runRoom with the glossary: a changed glossary renames existing settings; the same one does not run again', async (t) => {
  const messages = six('아무 일도 없었다.');
  const source = { text: 'Margaret = 마가렛' };
  const { s, w } = glossarySetup(t, messages, [], source);
  const auto = s.applyAuto(w.worldId, [
    { type: 'person', name: '마가렛', aliases: ['Margaret'] },
    { type: 'place', name: 'Hogwarts' },
    { type: 'person', name: '스네이프', aliases: ['Snape'] },
  ]);
  assert.equal(auto.length, 3);
  const hand = s.createEntity(w.worldId, { type: 'person', name: 'Gemma Farley' });
  await service.runRoom('room');
  assert.equal(s.listHistory(w.worldId).filter((c) => c.action === 'rename').length, 0, 'already as the glossary says');

  source.text = 'Margaret = 마거릿\nHogwarts = 호그와트\nGemma Farley = 젬마 페얼리\nSeverus Snape = 세베루스 스네이프';
  const job = await service.runRoom('room'); // nothing new to read: idle, but the names follow
  assert.equal(job.state, 'idle');
  const by = (id) => s.listEntities(w.worldId).find((e) => e.entityId === id);
  const [mg, hw, sn] = auto.map((c) => by(c.entityId));
  assert.deepEqual([mg.name, mg.aliases], ['마거릿', ['Margaret', '마가렛']]);
  assert.deepEqual([hw.name, hw.aliases, hw.type], ['호그와트', ['Hogwarts'], 'place'], 'places too');
  assert.deepEqual([sn.name, sn.aliases], ['스네이프', ['Snape']], 'a surname alone is not the full name: left alone');
  const g = by(hand.entityId);
  assert.deepEqual([g.name, g.glossaryName], ['Gemma Farley', '젬마 페얼리'], 'a name the person typed: only a suggestion');
  const count = s.listHistory(w.worldId).length;
  await service.runRoom('room');
  assert.equal(s.listHistory(w.worldId).length, count, 'the same glossary again: nothing');
});

test('runRoom with the glossary: unreadable or missing means nothing at all, never an empty glossary', async (t) => {
  const messages = six('Margaret가 왔다.');
  const reply = () => JSON.stringify({ items: [{ type: 'person', name: '마가렛', aliases: ['Margaret'], evidence: [{ n: '1.1' }] }] });
  for (const source of [{ fail: true, text: 'Margaret = 마거릿' }, { text: null }]) {
    const { s, w, calls } = glossarySetup(t, messages, [reply()], source);
    const job = await service.runRoom('room', { all: true });
    assert.equal(job.state, 'done');
    assert.equal(source.asked, 1);
    assert.doesNotMatch(calls[0][1].content, /번역 단어장/);
    assert.equal(s.listEntities(w.worldId)[0].name, '마가렛');
    assert.equal(s.roomGlossaryHash('room'), null, 'nothing remembered either');
  }
});

test('round trip: glossary → archive names → glossary changes nothing the second time', async (t) => {
  const messages = six('Margaret Bell과 Hogwarts, 그리고 Slytherin.');
  const reply = JSON.stringify({ items: [
    { type: 'person', name: '마가렛 벨', aliases: ['Margaret Bell', 'Professor Bell'], evidence: [{ n: '1.1' }] },
    { type: 'place', name: 'Hogwarts', evidence: [{ n: '1.1' }] }, // (「호그와트 성」 would stay: never shortened)
    { type: 'group', name: '슬리데린', aliases: ['Slytherin'], evidence: [{ n: '1.1' }] },
  ] });
  const glossary = 'Margaret Bell = 마거릿 벨\nHogwarts = 호그와트';
  const source = { text: glossary };
  const { s, w } = glossarySetup(t, messages, [reply], source);
  await service.runRoom('room', { all: true });
  const { names } = service.names('room');
  assert.deepEqual(names, [
    { original: 'Margaret Bell', translation: '마거릿 벨', kind: '인물' },
    { original: 'Hogwarts', translation: '호그와트', kind: '장소' },
    { original: 'Slytherin', translation: '슬리데린', kind: '집단' },
  ]);
  const pairs = G.parseGlossary(glossary);
  for (const p of pairs) assert.ok(names.some((n) => n.original === p.from && n.translation === p.to), `${p.from} comes back as the glossary has it`);
  // the archive's names added to the glossary, read again: no change anywhere
  source.text = [...new Set([...glossary.split('\n'), ...names.map((n) => `${n.original} = ${n.translation}`)])].join('\n');
  const before = JSON.stringify(s.listEntities(w.worldId));
  const historyBefore = s.listHistory(w.worldId).length;
  await service.runRoom('room');
  assert.equal(JSON.stringify(s.listEntities(w.worldId)), before);
  assert.equal(s.listHistory(w.worldId).length, historyBefore);
  assert.deepEqual(service.names('room').names, names);
});
