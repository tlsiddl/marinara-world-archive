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

// v0.7.0 5: 규칙 · 시스템 주제
test('주제: the reader sets it, never over the person\'s; recorded and undone', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070t-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별빛 시장' });
  s.applyAuto(w.worldId, [{ type: 'rule', name: '흥정 예절' }, { type: 'system', name: '은화 저울' }, { type: 'person', name: '상인' }]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.ok(s.setTopic(w.worldId, id('흥정 예절'), '금지·예절', { by: 'reader' }));
  assert.equal(by('흥정 예절').topic, '금지·예절');
  assert.equal(by('흥정 예절').sources.topic, 'auto');
  assert.equal(s.setTopic(w.worldId, id('은화 저울'), '아무거나'), null, 'only the six');
  assert.equal(s.setTopic(w.worldId, id('상인'), '돈·거래'), null, 'only rules and systems');
  // the person's 주제 is theirs from then on
  const e = by('은화 저울');
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, topic: '돈·거래' });
  assert.equal(by('은화 저울').sources.topic, 'manual');
  assert.equal(s.setTopic(w.worldId, id('은화 저울'), '방법·기술'), null);
  assert.equal(by('은화 저울').topic, '돈·거래');
  // undo the reader's
  const c = s.listHistory(w.worldId).find((x) => x.action === 'topic' && x.name === '흥정 예절');
  s.undoChange(w.worldId, c.id);
  assert.equal(by('흥정 예절').topic, undefined);
});

test('주제 from the reader\'s items: one of the six or nothing', () => {
  const X = require('../world-archive/lib/extract.cjs');
  const [part] = X.batches([{ id: 'm1', speaker: '서하', role: 'assistant', content: '시장에서는 값을 두 번 넘게 깎으면 무례로 여긴다. 은화는 상인회 저울로 달아 받는다.' }], 0);
  const { items } = X.checkItems({ items: [
    { type: 'rule', name: '흥정 예절', topic: '금지·예절', evidence: [{ n: '1.1', q: '두 번 넘게 깎으면' }] },
    { type: 'system', name: '은화 저울', topic: '경제', evidence: [{ n: '1.2', q: '상인회 저울로' }] },
  ] }, part, ['서하']);
  assert.deepEqual(items.map((x) => [x.name, x.topic]), [['흥정 예절', '금지·예절'], ['은화 저울', '']]);
});

test('「주제 채우기」: once for the empty ones; a topic not in the six dropped; the person\'s untouched', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const real = require('../world-archive/lib/vendor/engine.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070f-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: '별빛 시장', auto: { connectionId: 'c1' } });
  s.applyAuto(w.worldId, [{ type: 'rule', name: '흥정 예절' }, { type: 'system', name: '은화 저울' }, { type: 'rule', name: '찻집 조용히' }, { type: 'rule', name: '직접 정한 규칙' }]);
  const mine = s.listEntities(w.worldId).find((e) => e.name === '직접 정한 규칙');
  s.updateEntity(w.worldId, mine.entityId, { revision: mine.revision, topic: '유래·역사' });
  let calls = 0;
  let prompt = '';
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    askModel: async (m, messages) => { calls++; prompt = messages[1].content; return { content: JSON.stringify({ rules: [
      { name: '흥정 예절', topic: '금지·예절' }, { name: '은화 저울', topic: '돈·거래' }, { name: '찻집 조용히', topic: '조용함' }, { name: '직접 정한 규칙', topic: '그 밖' },
    ] }) }; },
    parseJsonObject: real.parseJsonObject,
  });
  const r = await service.fillTopics(w.worldId);
  assert.equal(calls, 1);
  assert.equal(r.asked, 3);
  assert.doesNotMatch(prompt, /직접 정한 규칙/);
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.deepEqual(['흥정 예절', '은화 저울', '찻집 조용히', '직접 정한 규칙'].map((n) => by(n).topic), ['금지·예절', '돈·거래', undefined, '유래·역사']);
  assert.ok(s.listHistory(w.worldId).some((c) => c.action === 'topic' && c.by === 'topic-fill'));
});

// v0.7.0 3: 정리 언어 · 보기: 한국어
test('정리 언어: the world\'s choice; 자동 is the room\'s 기억 서재 기억 언어, else 한국어', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070l-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Starclock' });
  const before = globalThis.__marinaraMemory;
  t.after(() => { globalThis.__marinaraMemory = before; service._test.useApp(null); });
  globalThis.__marinaraMemory = { version: '0.38.2' };
  let answer = { enabled: true, memoryLanguage: 'en' };
  service._test.useApp({ inject: async () => ({ statusCode: 200, body: JSON.stringify(answer) }) });
  assert.equal(await service.organizeLang(s.getWorld(w.worldId), 'room-en'), 'en');
  service._test.useApp({ inject: async () => ({ statusCode: 200, body: JSON.stringify({ enabled: false, memoryLanguage: 'en' }) }) });
  assert.equal(await service.organizeLang(s.getWorld(w.worldId), 'room-off'), 'ko', 'off in the 기억 서재: 한국어');
  answer = { enabled: true, memoryLanguage: 'zh' };
  service._test.useApp({ inject: async () => ({ statusCode: 200, body: JSON.stringify(answer) }) });
  assert.equal(await service.organizeLang(s.getWorld(w.worldId), 'room-zh'), 'ko');
  s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, summaryLang: 'en' });
  assert.equal(await service.organizeLang(s.getWorld(w.worldId), 'room-zh'), 'en', 'the world\'s choice first');
  assert.throws(() => s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, summaryLang: 'fr' }), (e) => e.status === 400);
  s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, summaryLang: 'auto' });
  assert.equal(s.getWorld(w.worldId).summaryLang, undefined);
});

test('정리 언어 영어: the prompt asks English values and names as written; the glossary\'s Korean is an other name', (t) => {
  const X = require('../world-archive/lib/extract.cjs');
  const [part] = X.batches([{ id: 'm1', speaker: 'A', role: 'assistant', content: 'Edwin walked into Hogwarts.' }], 0);
  const pairs = [{ from: 'Hogwarts', to: '호그와트' }];
  const en = X.buildPrompt({ name: 'w' }, [], part, [], pairs, null, 'en');
  assert.match(en[0].content, /정리 언어: 영어/);
  assert.match(en[1].content, /name을 원래\(로마자\) 표기 그대로 쓰고, 단어장의 한국어 표기는 aliases에/);
  const ko = X.buildPrompt({ name: 'w' }, [], part, [], pairs, null);
  assert.match(ko[0].content, /정리 언어: 한국어/);
  assert.match(ko[1].content, /name을 단어장의 한국어 표기 그대로/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070g-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: 'Starclock' });
  s.applyAuto(w.worldId, [{ type: 'place', name: 'Hogwarts' }]);
  const changes = s.alignGlossary(w.worldId, pairs, { keepName: true });
  const e = s.listEntities(w.worldId)[0];
  assert.deepEqual([e.name, e.aliases], ['Hogwarts', ['호그와트']]);
  assert.deepEqual(changes.map((c) => c.action), ['alias']);
  assert.deepEqual(s.alignGlossary(w.worldId, pairs, { keepName: true }), [], 'twice: nothing');
});

test('보기: 한국어 — only text that is not Korean; the cache first, small calls for the rest; 되돌리기 kept for the view', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070v-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Starclock', auto: { connectionId: 'c1' } });
  let calls = 0;
  let asked = '';
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    askModel: async (m, messages) => {
      calls++;
      asked = messages[1].content;
      const lines = asked.split('[글]\n')[1].split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
      return { content: JSON.stringify({ t: lines.map((l) => (/[가-힣]/.test(l) ? `EN:${l}` : `KO:${l}`)) }) };
    },
    parseJsonObject: (x) => JSON.parse(x),
    chatMessages: async () => ({ messages: [], cast: [] }),
  });
  const r = await service.translateView(w.worldId, ['Tall and quiet.', '이미 한국어', 'PEOPLE · 14', 'Tall and quiet.', 'Keeps the archive.']);
  assert.deepEqual(r.items, { 'Tall and quiet.': 'KO:Tall and quiet.', 'Keeps the archive.': 'KO:Keeps the archive.' });
  assert.equal(calls, 1);
  assert.doesNotMatch(asked, /이미 한국어|PEOPLE/);
  const again = await service.translateView(w.worldId, ['Tall and quiet.']);
  assert.equal(calls, 1, 'from the cache');
  assert.equal(again.items['Tall and quiet.'], 'KO:Tall and quiet.');
  // written in Korean: back to English, and the view then shows what the person wrote
  const b = await service.translateBack(w.worldId, ['차를 좋아한다'], 'en');
  assert.deepEqual(b.items, ['EN:차를 좋아한다']);
  const view = await service.translateView(w.worldId, ['EN:차를 좋아한다']);
  assert.ok(view.items, 'Hangul in it: not asked');
  const cache = s.readTranslations(w.worldId).items;
  assert.equal(cache[service.trHash('EN:차를 좋아한다')].ko, '차를 좋아한다');
  assert.equal(calls, 2);
  // only a view: the settings and {{세계}} never change
  assert.equal(s.listEntities(w.worldId).length, 0);
});
