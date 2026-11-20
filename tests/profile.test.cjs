'use strict';
// v0.5.0 G · S — profile blocks in replies (<npc_profile> · <world_profile>): read as settled settings; a field only a
// block says is 「아직 드러나지 않음」 until the story says it; a block fills empty fields only; a room without blocks
// reads as before. Made-up world only (별시계 학원).
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
const S = require('../world-archive/lib/vendor/sentences.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
const REPLY = '노을 교수가 교탁 앞에 섰다. "자, 시작하지."\n<npc_profile>\n이름/나이/성별: 노을 하르트 / 마흔둘 / 남\n외형과 옷차림: 은테 안경, 회색 망토\n태도와 주요 성격: 말수가 적고 엄격하다\n그 밖에 눈에 띄는 것: 사실은 저택 하르트 가문의 셋째 아들\n</npc_profile>';

test('a message is split as before, its profile block lines marked; no block: exactly S.segment', () => {
  const [part] = X.batches([msg(1, REPLY)], 0);
  const m = part.batch[0];
  assert.equal(m.sentences.length, 6);
  assert.deepEqual(m.blocks, [null, null, 'npc_profile', 'npc_profile', 'npc_profile', 'npc_profile']);
  assert.ok(!m.sentences.some((x) => /npc_profile/.test(x)), 'the tags are not sentences');
  const plain = '하윤이 웃었다. 비가 온다.\n종이 울렸다.';
  const [p2] = X.batches([msg(1, plain)], 0);
  assert.deepEqual(p2.batch[0].sentences, S.segment(plain));
  const prompt = X.buildPrompt({ name: 'x' }, [], part, [])[0].content + X.buildPrompt({ name: 'x' }, [], part, [])[1].content;
  assert.match(prompt, /1\.3 \[프로필\] 이름\/나이\/성별/);
  assert.match(prompt, /\[프로필\] 표시가 붙은 문장은/);
});

function world(t, replies, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    chatMessages: async () => ({ messages, cast: ['서하', '나'] }),
    askModel: async () => ({ content: replies.shift() ?? '{"items":[]}' }),
    parseJsonObject: real.parseJsonObject,
    listConnections: async () => [],
  });
  service._test.jobs.clear();
  const w = s.createWorld({ name: '별시계 학원', auto: { enabled: true, connectionId: 'c1', every: 4 } });
  s.linkRoom('room', w.worldId);
  s.setRoomRead('room', { lastId: null, count: 0 });
  return { s, w };
}

test('only the block says it: 「아직 드러나지 않음」 on the card and in {{세계}}; the story saying it later takes the mark off', async (t) => {
  const messages = [msg(0, '수업이다.'), msg(1, REPLY), msg(2, '네.'), msg(3, '좋아.'), msg(4, '.'), msg(5, '.')];
  const first = JSON.stringify({ items: [{ type: 'person', name: '노을 교수', fields: {
    personality: { v: '말수가 적고 엄격하다', n: ['2.5'] },
    background: { v: '하르트 가문의 셋째 아들', n: ['2.6'] },
    appearance: { v: '은테 안경, 회색 망토', n: ['2.4', '2.1'] },
  }, evidence: [{ n: '2.1', q: '노을 교수가' }] }] });
  const { s, w } = world(t, [first], messages);
  await service.runRoom('room');
  let e = s.listEntities(w.worldId).find((x) => x.name === '노을 교수');
  assert.deepEqual(e.hidden, { personality: true, background: true }, 'appearance has a story sentence too: not hidden');
  const text = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, {}).text;
  assert.match(text, /성격: 말수가 적고 엄격하다 \(아직 드러나지 않음\)/);
  assert.match(text, /배경: 하르트 가문의 셋째 아들 \(아직 드러나지 않음\)/);
  assert.doesNotMatch(text, /외형: [^\n]*아직/);
  // the story says the secret: the mark goes, recorded
  s.applyAuto(w.worldId, [{ type: 'person', match: '노을 교수', name: '노을 교수', fields: { background: '하르트 가문의 셋째 아들' }, fieldEvidence: { background: '"나는 하르트 가문의 셋째다."' } }]);
  e = s.listEntities(w.worldId).find((x) => x.name === '노을 교수');
  assert.deepEqual(e.hidden, { personality: true });
  const rv = s.listHistory(w.worldId).find((c) => c.action === 'reveal');
  assert.equal(rv.key, 'background');
  s.undoChange(w.worldId, rv.id);
  assert.ok(s.listEntities(w.worldId).find((x) => x.name === '노을 교수').hidden.background, 'undo puts the mark back');
});

test('a block fills empty fields only (the story\'s value stays); the person\'s edit takes the mark off', (t) => {
  const { s, w } = world(t, [], []);
  s.applyAuto(w.worldId, [{ type: 'person', name: '서림', fields: { personality: '수다스럽다' } }]);
  s.applyAuto(w.worldId, [{ type: 'person', match: '서림', name: '서림', fields: { personality: '과묵하다', age: '열다섯' }, hidden: { personality: true, age: true } }]);
  let e = s.listEntities(w.worldId).find((x) => x.name === '서림');
  assert.equal(e.fields.personality, '수다스럽다', 'not over the story\'s value');
  assert.equal(e.fields.age, '열다섯');
  assert.deepEqual(e.hidden, { age: true });
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { ...e.fields, age: '열여섯' } });
  e = s.listEntities(w.worldId).find((x) => x.name === '서림');
  assert.equal(e.hidden, undefined, 'the person wrote it');
});
