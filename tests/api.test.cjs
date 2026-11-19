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
