'use strict';
// 연동 v2 (docs/연동-v2-설계안.md): relations for the memory module (people who know each other from the start, now or
// before), one setting by entityId, the contract level in status and on the in-process api, and the 종 (species) field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const service = require('../world-archive/lib/service.cjs');
const X = require('../world-archive/lib/extract.cjs');
const { Archive, FIELDS } = require('../world-archive/lib/store.cjs');

function fakeApp() {
  const table = [];
  const make = (prefix) => {
    const add = (method) => (p, fn) => table.push({ method, parts: (prefix + p).split('/'), fn });
    return { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };
  };
  const pending = [];
  const app = { register: (plugin, opts) => pending.push(plugin(make(opts.prefix))), addHook: () => {} };
  const call = async (method, url) => {
    await Promise.all(pending);
    const parts = url.split('?')[0].split('/');
    for (const r of table) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {};
      if (!r.parts.every((x, i) => (x.startsWith(':') ? ((params[x.slice(1)] = decodeURIComponent(parts[i])), true) : x === parts[i]))) continue;
      const reply = { statusCode: 200, code(n) { this.statusCode = n; return this; }, send(d) { return d; } };
      const data = await r.fn({ params, body: {}, query: {} }, reply);
      return { status: reply.statusCode, data };
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { app, call };
}

const A = '/api/world-archive';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-link2-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__marinaraWorldArchive; });
  const s = new Archive(dir);
  service._test.useStore(s);
  globalThis.__marinaraWorldArchive = { version: 'test' };
  const f = fakeApp();
  service.attach(f.app);
  const w = s.createWorld({ name: '베인 공작가' });
  const id = (type, name, fields = {}) => s.createEntity(w.worldId, { type, name, fields }).entityId;
  const ids = {
    edward: id('person', '에드워드 베인'), catherine: id('person', '캐서린 베인'), irina: id('person', '이리나'),
    julian: id('person', '줄리언 에이버리'), mor: id('person', '모웨나 셀윈'), gareth: id('person', '가레스 어콰트'),
    cat: id('person', '베아트릭스', { species: '하프니즐' }), house: id('group', '슬리데린'), hall: id('place', '연회장'),
  };
  s.linkRoom('room', w.worldId);
  return { s, w, ids, call: f.call };
}

test('relations: family, friends, lovers, teacher and student, enemies — now or before; not 소속 · 위치 · 기타, not a place or group', async (t) => {
  const { s, w, ids, call } = setup(t);
  s.applyRelations(w.worldId, [
    { from: ids.edward, to: ids.catherine, type: '가족', note: '부부' },
    { from: ids.irina, to: ids.mor, type: '친구', note: '' },
    { from: ids.irina, to: ids.house, type: '소속', note: '기숙사' },
    { from: ids.gareth, to: ids.mor, type: '기타', note: '같은 객실' },
    { from: ids.irina, to: ids.julian, type: '연인', note: '' },
  ]);
  // 연인 → 적대: the reader writes the new one with `was`; the old one goes and the note says 과거에는 연인.
  s.applyRelations(w.worldId, [{ from: ids.irina, to: ids.julian, type: '적대', note: '등 돌림', was: '연인' }]);
  const got = (await call('GET', `${A}/rooms/room/relations`)).data;
  assert.equal(got.worldId, w.worldId);
  const rows = got.relations.map((r) => `${r.fromName}—${r.toName}:${r.type}${r.previous.length ? `(과거 ${r.previous.join(',')})` : ''}`).sort();
  assert.deepEqual(rows, ['에드워드 베인—캐서린 베인:가족', '이리나—모웨나 셀윈:친구', '이리나—줄리언 에이버리:적대(과거 연인)']);
  assert.deepEqual(service.roomRelations('room'), got, 'the same in process');
  assert.deepEqual((await call('GET', `${A}/rooms/lonely/relations`)).data, { worldId: null, relations: [] });
  assert.equal((await call('GET', `${A}/rooms/bad%2Fid/relations`)).status, 400);
});

test('a relation that is 기타 now but was 스승·제자 still counts (with the past kind whole)', (t) => {
  const { s, w, ids } = setup(t);
  s.applyRelations(w.worldId, [{ from: ids.edward, to: ids.irina, type: '스승·제자', note: '' }]);
  s.applyRelations(w.worldId, [{ from: ids.edward, to: ids.irina, type: '기타', note: '', was: '스승·제자' }]);
  const [r] = service.roomRelations('room').relations;
  assert.equal(r.type, '기타');
  assert.deepEqual(r.previous, ['스승·제자']);
});

test('entity by id, the contract level in status and on the api', async (t) => {
  const { ids, call } = setup(t);
  const one = (await call('GET', `${A}/rooms/room/entities/${ids.cat}`)).data;
  assert.equal(one.entity.name, '베아트릭스');
  assert.equal(one.entity.fields.species, '하프니즐');
  assert.equal((await call('GET', `${A}/rooms/room/entities/00000000-0000-4000-8000-000000000000`)).data.entity, null);
  const status = (await call('GET', `${A}/status`)).data;
  assert.equal(status.contract, 2);
  assert.deepEqual(status.features, ['relations', 'species', 'entity']);
  assert.ok(status.fields.person.some((f) => f.key === 'species' && f.label === '종'));
  const api = globalThis.__marinaraWorldArchive.api;
  assert.equal(api.version, 1, 'v2 only adds: old modules keep working');
  assert.equal(api.contract, 2);
  assert.equal(typeof api.roomRelations, 'function');
  assert.equal(typeof api.entity, 'function');
});

test('종 (species): only for a being that is not a person — "사람" and the like stay empty (unknown)', () => {
  assert.ok(FIELDS.person.some((f) => f.key === 'species'));
  const index = new Map([['1.1', { number: 1, sentence: 1, text: '반니즐 베아트릭스가 하품했다.' }], ['1.2', { number: 1, sentence: 2, text: '모웨나는 사람이다.' }]]);
  const cat = X.checkFields('person', { species: { v: '반니즐', n: ['1.1'] } }, index);
  assert.equal(cat.fields.species, '반니즐');
  for (const v of ['사람', '인간', 'Human', '머글', '마녀']) {
    const out = X.checkFields('person', { species: { v, n: ['1.2'] } }, index);
    assert.equal(out.fields.species, undefined, v);
    assert.match(out.droppedFields[0].why, /a person/);
  }
  const [sys] = X.buildPrompt({ name: 'w' }, [], { batch: [{ number: 1, speaker: 'x', sentences: ['a'] }], context: [] }, []);
  assert.match(sys.content, /species\(종\)에는 사람이 아닌 존재/);
});
