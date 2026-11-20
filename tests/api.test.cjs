'use strict';
// Routes and {{세계}} through the service, with a tiny stand-in for Fastify (register / get / post / …).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const service = require('../world-archive/lib/service.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');

function fakeApp() {
  const table = [];
  const hooks = [];
  const make = (prefix) => {
    const add = (method) => (p, fn) => table.push({ method, parts: (prefix + p).split('/'), fn });
    return { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };
  };
  const pending = [];
  const app = {
    register: (plugin, opts) => pending.push(plugin(make(opts.prefix))),
    addHook: (name, fn) => hooks.push({ name, fn }),
  };
  const call = async (method, url, body) => {
    await Promise.all(pending);
    const [p, q = ''] = url.split('?');
    const parts = p.split('/');
    for (const r of table) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {};
      if (!r.parts.every((x, i) => (x.startsWith(':') ? ((params[x.slice(1)] = decodeURIComponent(parts[i])), true) : x === parts[i]))) continue;
      const reply = { statusCode: 200, code(n) { this.statusCode = n; return this; }, send(d) { return d; } };
      const data = await r.fn({ params, body, query: Object.fromEntries(new URLSearchParams(q)) }, reply);
      return { status: reply.statusCode, data };
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { app, call, hooks };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  service._test.useStore(new Archive(dir));
  const f = fakeApp();
  service.attach(f.app);
  return f;
}

const A = '/api/world-archive';

test('worlds → entities → room link → {{세계}}', async (t) => {
  const { call } = setup(t);
  const w = await call('POST', `${A}/worlds`, { name: '별빛 학원', description: '산 위의 기숙학교' });
  assert.equal(w.status, 200);
  const id = w.data.worldId;
  const e = await call('POST', `${A}/worlds/${id}/entities`, { type: 'person', name: '한여름', description: '반장' });
  assert.equal(e.status, 200);
  assert.equal((await call('GET', `${A}/worlds/${id}/entities`)).data.entities.length, 1);

  assert.equal(service.render({ chatId: 'room_A' }), '', 'unlinked room: empty');
  assert.equal((await call('PUT', `${A}/rooms/room_A`, { worldId: id })).data.worldId, id);
  assert.equal(service.render({ chatId: 'room_A' }), '[세계관] 별빛 학원\n산 위의 기숙학교\n\n[인물]\n- 한여름\n  메모: 반장');
  const pv = await call('GET', `${A}/rooms/room_A/preview`);
  assert.equal(pv.data.included.length, 1);
  assert.equal(pv.data.worldName, '별빛 학원');

  assert.equal((await call('PUT', `${A}/rooms/room_A`, { worldId: null })).data.worldId, null);
  assert.equal(service.render({ chatId: 'room_A' }), '');
});

test('errors come back as status codes with a message', async (t) => {
  const { call } = setup(t);
  assert.equal((await call('POST', `${A}/worlds`, { name: '' })).status, 400);
  assert.equal((await call('GET', `${A}/worlds/00000000-0000-4000-8000-000000000000`)).status, 404);
  const w = await call('POST', `${A}/worlds`, { name: 'A' });
  assert.equal((await call('PATCH', `${A}/worlds/${w.data.worldId}`, { name: 'B', revision: 7 })).status, 409);
  assert.equal((await call('PUT', `${A}/rooms/room_A`, { worldId: 5 })).status, 400);
  assert.equal((await call('GET', `${A}/rooms/bad%2Fid/preview`)).status, 400);
  const del = await call('DELETE', `${A}/worlds/${w.data.worldId}?revision=1`);
  assert.equal(del.data.deleted, true, 'revision can come in the query (DELETE bodies are optional)');
});

test('{{세계}} never throws, even when the file is broken', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'A' });
  s.linkRoom('r1', w.worldId);
  fs.writeFileSync(s.roomsFile, 'not json');
  assert.equal(service.render({ chatId: 'r1' }), '');
  assert.equal(service.render({}), '');
  assert.equal(service.render(null), '');
});

test('a branch reads the same world as its source room', (t) => {
  const { hooks } = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'A' });
  s.linkRoom('src', w.worldId);
  const onSend = hooks.find((h) => h.name === 'onSend').fn;
  const req = { method: 'POST', raw: { url: '/api/chats/src/branch' } };
  onSend(req, { statusCode: 200 }, JSON.stringify({ id: 'new_branch' }), () => {});
  assert.equal(s.roomWorldId('new_branch'), w.worldId);
  onSend({ method: 'POST', raw: { url: '/api/chats/src/branch' } }, { statusCode: 500 }, JSON.stringify({ id: 'failed' }), () => {});
  assert.equal(s.roomWorldId('failed'), null);

  onSend({ method: 'DELETE', raw: { url: '/api/chats/src' } }, { statusCode: 403 }, '{}', () => {});
  assert.equal(s.roomWorldId('src'), w.worldId, 'a refused delete keeps the link');
  onSend({ method: 'DELETE', raw: { url: '/api/chats/src' } }, { statusCode: 200 }, '{}', () => {});
  assert.equal(s.roomWorldId('src'), null, 'a deleted chat loses its link');
  assert.equal(s.listWorlds().length, 1, 'the world itself stays');
});

// ---------------------------------------------------------------- the current scene and the module API
const say = (i, content) => ({ id: `m${i}`, speaker: 'x', role: 'assistant', content });

/** A world linked to `room` with three settings, and a stand-in engine whose chat is `chat.messages`. */
function sceneSetup(t, { mode = 'scene', auto } = {}) {
  const f = setup(t);
  const s = new Archive(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-')));
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  service._test.useStore(s);
  service._test.scenes.clear();
  const chat = { messages: [], calls: 0, fail: null };
  service._test.useEngine({
    chatMessages: async (id) => {
      chat.calls++;
      if (chat.fail) return chat.fail();
      return { messages: chat.messages, cast: [] };
    },
  });
  const w = s.createWorld({ name: '별빛 학원', injectMode: mode, ...(auto ? { auto } : {}) });
  const ids = {
    rule: s.createEntity(w.worldId, { type: 'rule', name: '통금', description: '밤 10시' }).entityId,
    pin: s.createEntity(w.worldId, { type: 'person', name: '교장', pinned: true }).entityId,
    summer: s.createEntity(w.worldId, { type: 'person', name: '한여름', aliases: ['반장'] }).entityId,
    roof: s.createEntity(w.worldId, { type: 'place', name: '옥상 정원' }).entityId,
  };
  s.linkRoom('room', w.worldId);
  return { ...f, s, w, ids, chat };
}

test('updateScene: names from the last 12 messages (and the message being sent) make the scene', async (t) => {
  const { s, w, ids, chat } = sceneSetup(t);
  chat.messages = [say(0, '옥상 정원에 올라갔다.'), ...Array.from({ length: 12 }, (_, i) => say(i + 1, `반장이 말했다 ${i}`))];
  const scene = await service._test.updateScene('room');
  assert.deepEqual([...scene], [ids.summer], 'an alias counts; the 13th message from the end does not');
  let p = service.preview('room');
  assert.equal(p.sceneKnown, true);
  assert.equal(p.mode, 'scene');
  assert.deepEqual(p.included.slice().sort(), [ids.rule, ids.pin, ids.summer].sort());
  assert.equal(p.skipped, 1);
  assert.doesNotMatch(service.render({ chatId: 'room' }), /옥상/);

  await service._test.updateScene('room', '옥상으로 가자');
  assert.equal(service.preview('room').skipped, 1, 'a part of a name is not a match');
  await service._test.updateScene('room', '「옥상정원」으로 가자');
  p = service.preview('room');
  assert.equal(p.skipped, 0, 'the pending message counts, matched without spaces or quotes');

  assert.equal(await service._test.updateScene('nowhere'), null, 'unlinked room: nothing');
  s.updateWorld(w.worldId, { injectMode: 'all', revision: 1 });
  assert.equal(service.preview('room').included.length, 4, 'mode all: everything, in-scene first');
});

test('a scene worked out for another world is ignored after relinking', async (t) => {
  const { s, ids, chat } = sceneSetup(t);
  chat.messages = [say(0, '한여름')];
  await service._test.updateScene('room');
  assert.equal(service.preview('room').skipped, 1);
  const other = s.createWorld({ name: '다른 세계', injectMode: 'scene' });
  s.createEntity(other.worldId, { type: 'place', name: '항구' });
  s.linkRoom('room', other.worldId);
  const p = service.preview('room');
  assert.equal(p.sceneKnown, false);
  assert.deepEqual([p.included.length, p.skipped], [1, 0], 'no scene for this world yet: everything is a candidate');
  void ids;
});

test('sceneBeforeReply: only for the two generate URLs of linked rooms, never throws, never waits long', async (t) => {
  const { hooks, chat, ids } = sceneSetup(t);
  const pre = hooks.find((h) => h.name === 'preHandler').fn;
  chat.messages = [say(0, '교장과 한여름')];
  const req = (method, url, body) => ({ method, raw: { url }, body });

  await pre(req('GET', '/api/generate', { chatId: 'room' }));
  await pre(req('POST', '/api/chats', { chatId: 'room' }));
  await pre(req('POST', '/api/generate', { chatId: 'other_room' }));
  await pre(req('POST', '/api/generate', { chatId: '../room' }));
  await pre(req('POST', '/api/generate', {}));
  await pre(req('POST', '/api/generate'));
  assert.equal(chat.calls, 0, 'nothing read for other requests or rooms');

  await pre(req('POST', '/api/generate?stream=1', { chatId: 'room', userMessage: '옥상 정원으로' }));
  assert.equal(chat.calls, 1);
  assert.deepEqual([...service._test.scenes.get('room').ids].sort(), [ids.pin, ids.summer, ids.roof].sort());
  await pre(req('POST', '/api/generate/dryRun', { chatId: 'room' }));
  assert.equal(chat.calls, 2);
  assert.equal(service._test.scenes.get('room').ids.has(ids.roof), false, 'the scene follows the latest messages');

  chat.fail = () => { throw new Error('engine down'); };
  await pre(req('POST', '/api/generate', { chatId: 'room' }));
  assert.equal(service._test.scenes.get('room').ids.has(ids.summer), true, 'a failure keeps the last scene');

  chat.fail = () => new Promise(() => {});
  const started = Date.now();
  await pre(req('POST', '/api/generate', { chatId: 'room' }));
  const took = Date.now() - started;
  assert.ok(took >= 1000 && took < 3000, `waited ${took} ms`);
});

test('GET preview refreshes the scene and reports what was left out for it', async (t) => {
  const { call, chat } = sceneSetup(t);
  chat.messages = [say(0, '반장')];
  const p = (await call('GET', `${A}/rooms/room/preview`)).data;
  assert.deepEqual([p.sceneKnown, p.included.length, p.skipped], [true, 3, 1]);
  const none = (await call('GET', `${A}/rooms/empty_room/preview`)).data;
  assert.deepEqual([none.worldId, none.skipped], [null, 0]);
});

test('module API over HTTP: entities and lookup by name or other name', async (t) => {
  const { call, w, ids } = sceneSetup(t);
  const list = (await call('GET', `${A}/rooms/room/entities`)).data;
  assert.equal(list.worldId, w.worldId);
  assert.equal(list.entities.length, 4);
  assert.deepEqual(Object.keys(list.entities[0]).sort(), ['aliases', 'description', 'entityId', 'fields', 'name', 'pinned', 'sources', 'type', 'updatedAt']);
  for (const name of ['한여름', '반장', ' 한 여름 ', '「한여름」']) {
    const r = (await call('GET', `${A}/rooms/room/lookup?name=${encodeURIComponent(name)}`)).data;
    assert.equal(r.entity?.entityId, ids.summer, name);
  }
  assert.equal((await call('GET', `${A}/rooms/room/lookup?name=${encodeURIComponent('옥상정원')}`)).data.entity.entityId, ids.roof);
  assert.equal((await call('GET', `${A}/rooms/room/lookup?name=${encodeURIComponent('여름')}`)).data.entity, null, 'a part of a name is not a match');
  assert.equal((await call('GET', `${A}/rooms/room/lookup`)).data.entity, null);
  assert.deepEqual((await call('GET', `${A}/rooms/lonely/entities`)).data, { worldId: null, entities: [] });
  assert.deepEqual((await call('GET', `${A}/rooms/lonely/lookup?name=x`)).data, { worldId: null, entity: null });
  assert.equal((await call('GET', `${A}/rooms/bad%2Fid/entities`)).status, 400);
  assert.equal((await call('GET', `${A}/rooms/bad%2Fid/lookup?name=x`)).status, 400);
});

test('suggest: writes only when automatic updates are on, never over hand-written fields, recorded with by', async (t) => {
  const { call, s, w, ids } = sceneSetup(t);
  const items = [
    { type: 'person', name: '한여름', fields: { age: '17세', gender: '남' }, evidence: '열일곱 살 반장' },
    { type: 'place', name: '도서관', fields: { use: '책' }, evidence: 'ㄱ'.repeat(500) },
  ];
  const off = (await call('POST', `${A}/rooms/room/suggest`, { items, by: 'memory-module' })).data;
  assert.deepEqual(off, { written: false, reason: 'automatic updates off', changes: [] });
  assert.equal(s.listEntities(w.worldId).length, 4, 'nothing written');
  assert.equal(s.listHistory(w.worldId).filter((c) => c.by !== 'person').length, 0, 'only the hand-made settings of the setup are recorded');

  const cur = s.listEntities(w.worldId).find((e) => e.entityId === ids.summer);
  s.updateEntity(w.worldId, ids.summer, { fields: { gender: '여' }, revision: cur.revision });
  s.updateWorld(w.worldId, { auto: { enabled: true }, revision: 1 });
  const on = (await call('POST', `${A}/rooms/room/suggest`, { items, by: 'memory-module' })).data;
  assert.equal(on.written, true);
  assert.deepEqual(on.changes.map((c) => c.action).sort(), ['create', 'field']);
  const summer = s.listEntities(w.worldId).find((e) => e.entityId === ids.summer);
  assert.deepEqual([summer.fields.gender, summer.fields.age], ['여', '17세'], 'the hand-written field stays');
  const hist = s.listHistory(w.worldId).filter((c) => c.by !== 'person'); // the setup's own hand edits are recorded too (할 일 5)
  assert.ok(hist.every((c) => c.by === 'memory-module' && c.roomId === 'room'));
  assert.ok(hist.every((c) => c.evidence.length <= 300));
  assert.equal(s.undoChange(w.worldId, hist.find((c) => c.action === 'field').id).undone, true, 'undoable like the reader\'s');

  const anon = (await call('POST', `${A}/rooms/room/suggest`, { items: [{ type: 'rule', name: '소등', evidence: '' }] })).data;
  assert.equal(anon.written, true);
  assert.equal(s.listHistory(w.worldId)[0].by, 'module', 'no name given: module');
  await call('POST', `${A}/rooms/room/suggest`, { items: [{ type: 'rule', name: '점호' }], by: 'Not An Id!' });
  assert.equal(s.listHistory(w.worldId)[0].by, 'module');
  assert.deepEqual((await call('POST', `${A}/rooms/room/suggest`, { items: 'nope' })).data, { written: true, changes: [] });
  assert.deepEqual((await call('POST', `${A}/rooms/lonely/suggest`, { items })).data, { written: false, reason: 'no world', changes: [] });
  assert.equal((await call('POST', `${A}/rooms/bad%2Fid/suggest`, { items })).status, 400);
});

test('names over HTTP: people, places and groups with a romanized other name, in the glossary\'s shape', async (t) => {
  const { call, s, w } = sceneSetup(t);
  s.createEntity(w.worldId, { type: 'person', name: '세베루스 스네이프', aliases: ['Professor Snape', 'Severus Snape', 'Snape', '스네이프 교수'] });
  s.createEntity(w.worldId, { type: 'place', name: '호그와트', aliases: ['Hogwarts'] });
  s.createEntity(w.worldId, { type: 'group', name: '슬리데린', aliases: ['Slytherin'] });
  // not proper nouns: never offered to the translation glossary
  s.createEntity(w.worldId, { type: 'system', name: '기숙사 점수', aliases: ['House Points'] });
  s.createEntity(w.worldId, { type: 'system', name: '변신술', aliases: ['Wandless, non-verbal Transfiguration'] });
  s.createEntity(w.worldId, { type: 'rule', name: '통금', aliases: ['Curfew'] });
  s.createEntity(w.worldId, { type: 'schedule', name: '마법약 수업', aliases: ['Potions Class'] });
  s.createEntity(w.worldId, { type: 'history', name: '마법사 전쟁', aliases: ['Wizarding War'] });
  s.createEntity(w.worldId, { type: 'custom', name: '기숙사 배정 모자', aliases: ['Sorting Hat'] });
  s.createEntity(w.worldId, { type: 'person', name: 'Argus Filch', aliases: ['Filch'] }); // no Korean name: not a translation
  s.createEntity(w.worldId, { type: 'person', name: '마담 폼프리', aliases: ['폼프리'] }); // no romanized form
  const r = await call('GET', `${A}/rooms/room/names`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { names: [
    { original: 'Severus Snape', translation: '세베루스 스네이프', kind: '인물' },
    { original: 'Hogwarts', translation: '호그와트', kind: '장소' },
    { original: 'Slytherin', translation: '슬리데린', kind: '집단' },
  ] });
  assert.deepEqual((await call('GET', `${A}/rooms/lonely/names`)).data, { names: [] }, 'a room with no world');
  assert.equal((await call('GET', `${A}/rooms/bad%2Fid/names`)).status, 400);
});

test('suggest: names follow the room\'s glossary as last read, like the reader\'s', async (t) => {
  const { call, s, w } = sceneSetup(t, { auto: { enabled: true } });
  service._test.glossaries.clear();
  t.after(() => service._test.glossaries.clear());
  const items = [{ type: 'person', name: '마가렛', aliases: ['Margaret'], evidence: 'Margaret가 왔다' }];
  await call('POST', `${A}/rooms/room/suggest`, { items: [{ ...items[0], name: '젬마', aliases: ['Gemma'] }], by: 'memory-module' });
  assert.ok(s.listEntities(w.worldId).some((e) => e.name === '젬마'), 'no glossary read yet: as sent');
  service._test.glossaries.set('room', [{ from: 'Margaret', to: '마거릿' }]);
  const r = (await call('POST', `${A}/rooms/room/suggest`, { items, by: 'memory-module' })).data;
  assert.deepEqual(r.changes.map((c) => c.action), ['create', 'rename']);
  assert.deepEqual(s.listEntities(w.worldId).find((e) => e.entityId === r.changes[0].entityId).aliases, ['Margaret', '마가렛']);
});

test('the same four functions are offered in-process on globalThis.__marinaraWorldArchive.api', async (t) => {
  const before = globalThis.__marinaraWorldArchive;
  globalThis.__marinaraWorldArchive = { version: 'test' };
  t.after(() => {
    if (before === undefined) delete globalThis.__marinaraWorldArchive;
    else globalThis.__marinaraWorldArchive = before;
  });
  const { s, w, ids } = sceneSetup(t, { auto: { enabled: true } });
  const api = globalThis.__marinaraWorldArchive.api;
  assert.equal(api.version, 1);
  assert.deepEqual(Object.keys(api).sort(), ['contract', 'entity', 'features', 'lookup', 'names', 'roomEntities', 'roomRelations', 'suggest', 'version'], 'v1 functions kept, v2 added');
  assert.equal(api.roomEntities('room').entities.length, 4);
  assert.deepEqual(api.names('room'), { names: [] }, 'no romanized other names yet');
  assert.deepEqual(api.names('../x'), { names: [] });
  assert.equal(api.lookup('room', '반장').entity.entityId, ids.summer);
  assert.equal(api.lookup('../x', '반장').entity, null, 'a bad room id finds nothing');
  const r = api.suggest('room', [{ type: 'place', name: '강당', evidence: '강당에 모였다' }], 'memory-module');
  assert.equal(r.written, true);
  assert.equal(s.listHistory(w.worldId)[0].by, 'memory-module');
});

test('same person over HTTP: suggestions, merge, history, undo, 「다른 사람이에요」', async (t) => {
  const { call } = setup(t);
  const w = (await call('POST', `${A}/worlds`, { name: '호그와트' })).data;
  const add = async (name, aliases = []) => (await call('POST', `${A}/worlds/${w.worldId}/entities`, { type: 'person', name, aliases })).data;
  const severus = await add('세베루스 스네이프');
  const snape = await add('스네이프', ['Professor Snape']);
  const gemma = await add('젬마 페얼리', ['prefect']);
  const prefect = await add('슬리데린 5학년 반장', ['prefect']);
  await add('캐서린 베인');
  await add('베인 공작');
  const d = await call('GET', `${A}/worlds/${w.worldId}/duplicates`);
  assert.equal(d.status, 200);
  assert.equal(d.data.pairs.length, 2);
  assert.ok(d.data.pairs.every((p) => typeof p.a === 'string' && typeof p.b === 'string' && typeof p.why === 'string'));

  const stale = await call('POST', `${A}/worlds/${w.worldId}/merge`, { keepId: severus.entityId, dropId: snape.entityId, keepRevision: 9, dropRevision: 1 });
  assert.equal(stale.status, 409);
  const m = await call('POST', `${A}/worlds/${w.worldId}/merge`, { keepId: severus.entityId, dropId: snape.entityId, keepRevision: 1, dropRevision: 1 });
  assert.equal(m.status, 200);
  assert.deepEqual(m.data.aliases, ['스네이프', 'Professor Snape']);
  assert.equal((await call('GET', `${A}/worlds/${w.worldId}/entities`)).data.entities.length, 5);
  const [h] = (await call('GET', `${A}/worlds/${w.worldId}/history`)).data.changes;
  assert.equal(h.action, 'merge');
  assert.equal((await call('POST', `${A}/worlds/${w.worldId}/history/${h.id}/undo`)).data.undone, true);
  assert.equal((await call('GET', `${A}/worlds/${w.worldId}/entities`)).data.entities.length, 6);

  const x = await call('POST', `${A}/worlds/${w.worldId}/duplicates/dismiss`, { a: gemma.entityId, b: prefect.entityId });
  assert.equal(x.data.dismissed, true);
  assert.equal((await call('GET', `${A}/worlds/${w.worldId}/duplicates`)).data.pairs.length, 1);
  assert.equal((await call('POST', `${A}/worlds/${w.worldId}/duplicates/dismiss`, { a: gemma.entityId })).status, 400);
});

test('{{세계외형}}: people in the scene with an appearance only, the latest messages first, whole lines in the budget', async (t) => {
  const { s, w, ids, chat } = sceneSetup(t);
  s.updateEntity(w.worldId, ids.summer, { fields: { gender: '여', age: '17', appearance: '짧은 단발\n검은 눈' }, revision: 1 });
  const kai = s.createEntity(w.worldId, { type: 'person', name: '카이', fields: { appearance: '그을린 소매' } }).entityId;
  s.createEntity(w.worldId, { type: 'person', name: '미오', fields: { appearance: '긴 머리' } });
  assert.equal(service.renderLooks({ chatId: 'room' }), '', 'no scene known yet: empty');
  chat.messages = [say(0, '미오가 손을 들었다.'), say(1, '카이가 웃었다.'), say(2, '반장이 고개를 끄덕였다.'), say(3, '교장이 들어왔다.')];
  await service._test.updateScene('room');
  assert.equal(
    service.renderLooks({ chatId: 'room' }),
    '[외형]\n- 한여름 (여, 17): 짧은 단발 / 검은 눈\n- 미오: 긴 머리\n- 카이: 그을린 소매',
    'the latest two messages first (교장 has no appearance, 옥상 정원 is no person); then by name',
  );
  chat.messages.push(say(4, '카이가 불을 껐다.'));
  await service._test.updateScene('room');
  assert.match(service.renderLooks({ chatId: 'room' }), /^\[외형\]\n- 카이: /, 'whoever the newest message names comes first');
  const p = service.looks('room');
  assert.equal(p.included.length, 3);
  assert.ok(p.included.includes(kai));
  const { assembleLooks } = require('../world-archive/lib/inject.cjs');
  const all = s.readEntities(w.worldId).entities;
  const small = assembleLooks(all, service._test.scenes.get('room').ids, { budget: 30 });
  assert.equal(small.included.length + small.omitted.length, 3);
  assert.ok(small.text.length <= 30 && !small.text.includes(' / 검'), 'a line that does not fit is left out whole');
  s.linkRoom('room', null);
  assert.equal(service.renderLooks({ chatId: 'room' }), '', 'unlinked: empty');
  assert.equal(service.renderLooks(null), '');
});

test('v0.5.0 구성원 명단 over HTTP: a new group joins the people whose 소속 칸 names it; add / take off; undo follows', async (t) => {
  const { call } = setup(t);
  const id = (await call('POST', `${A}/worlds`, { name: '별시계 학원' })).data.worldId;
  const p = (await call('POST', `${A}/worlds/${id}/entities`, { type: 'person', name: '하윤', fields: { affiliation: '은사슴 1학년' } })).data;
  const big = (await call('POST', `${A}/worlds/${id}/entities`, { type: 'group', name: '은사슴' })).data;
  const small = (await call('POST', `${A}/worlds/${id}/entities`, { type: 'group', name: '은사슴 1학년' })).data;
  const names = async (g) => (await call('GET', `${A}/worlds/${id}/entities/${g}/members`)).data.members.map((m) => m.name + (m.via ? '·' + m.via : ''));
  assert.deepEqual(await names(small.entityId), ['하윤'], 'a group made after the person still gets them');
  assert.deepEqual(await names(big.entityId), ['하윤·은사슴 1학년']);
  const off = await call('POST', `${A}/worlds/${id}/entities/${small.entityId}/members`, { personId: p.entityId, on: false });
  assert.equal(off.status, 200);
  assert.deepEqual(off.data.affiliation, { before: '은사슴 1학년', after: '' });
  assert.deepEqual(await names(big.entityId), []);
  const edit = (await call('GET', `${A}/worlds/${id}/history`)).data.changes.find((c) => c.action === 'edit');
  assert.equal((await call('POST', `${A}/worlds/${id}/history/${edit.id}/undo`)).status, 200);
  assert.deepEqual(await names(small.entityId), ['하윤'], 'undo brings the 소속 칸 back and the list with it');
  assert.equal((await call('POST', `${A}/worlds/${id}/entities/${small.entityId}/members`, {})).status, 400);
  assert.equal((await call('GET', `${A}/worlds/${id}/entities/${p.entityId}/members`)).status, 404);
});
