'use strict';
// World Archive server side: {{세계}} rendering and the /api/world-archive routes.
// Routes are registered with app.register at the app.js anchor, so Marinara's own access checks (login, IP allowlist,
// CSRF, host validation) cover them exactly like the engine's routes. There is no separate token.
const path = require('node:path');
const { Archive, ArchiveError, TYPES, FIELDS, BUDGET_DEFAULT, BUDGET_MIN, BUDGET_MAX } = require('./store.cjs');
const { assembleWorld } = require('./inject.cjs');

const TAG = '[world-archive]';
const PREFIX = '/api/world-archive';
const log = (m) => process.stderr.write(`${TAG} ${m}\n`);

/**
 * <Marinara's data folder>/world-archive, found the way Marinara finds its folder: DATA_DIR (relative to
 * packages/server) when set, otherwise packages/server/data. Docker sets DATA_DIR=/app/data.
 */
function dataDir() {
  if (process.env.WORLD_ARCHIVE_DATA_DIR) return path.resolve(process.env.WORLD_ARCHIVE_DATA_DIR);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const serverRoot = /[\\/]packages[\\/]server[\\/]dist[\\/]index\.js$/i.test(entry) ? path.resolve(entry, '..', '..') : null;
  const raw = String(process.env.DATA_DIR || '').trim();
  const base = raw
    ? path.resolve(serverRoot || process.cwd(), raw)
    : serverRoot
      ? path.join(serverRoot, 'data')
      : '/app/data';
  return path.join(base, 'world-archive');
}

let archive = null;
function store() {
  if (!archive) archive = new Archive(dataDir());
  return archive;
}
function useStore(s) {
  archive = s;
}

/** What one room's {{세계}} would be right now. */
function preview(roomId) {
  const s = store();
  const worldId = s.roomWorldId(roomId);
  if (!worldId) return { roomId, worldId: null, text: '', chars: 0, budget: 0, included: [], omitted: [] };
  const world = s.listWorlds().find((w) => w.worldId === worldId);
  if (!world) return { roomId, worldId: null, text: '', chars: 0, budget: 0, included: [], omitted: [] };
  return { roomId, worldId, worldName: world.name, ...assembleWorld(world, s.readEntities(worldId).entities) };
}

const reported = new Set();
/** {{세계}}: never throws — a broken file gives an empty macro and one log line, not a failed reply. */
function render(ctx) {
  const roomId = typeof ctx?.chatId === 'string' ? ctx.chatId : '';
  try {
    const p = preview(roomId);
    const key = `${roomId}|${p.worldId}|${p.included.length}|${p.omitted.length}`;
    if (!reported.has(key)) {
      reported.add(key);
      log(
        p.worldId
          ? `{{세계}} for chat ${roomId}: ${p.included.length} settings (${p.chars}/${p.budget} chars)${p.omitted.length ? `, ${p.omitted.length} left out for length` : ''}`
          : `{{세계}} for chat ${roomId || '(none)'}: no world linked`,
      );
    }
    return p.text;
  } catch (error) {
    log(`{{세계}} for chat ${roomId}: ${error?.message || error}`);
    return '';
  }
}

async function routes(r) {
  const s = () => store();
  const handle = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      const code = e instanceof ArchiveError ? e.status : 500;
      if (code === 500) log(`error: ${e?.stack || e}`);
      return reply.code(code).send({ error: code === 500 ? '세계관을 저장하다 문제가 생겼습니다. 서버 기록을 확인해 주세요.' : e.message });
    }
  };
  const body = (req) => req.body ?? {};

  r.get('/status', handle(async () => ({
    version: globalThis.__marinaraWorldArchive?.version ?? null,
    patches: globalThis.__marinaraWorldArchive?.patches ?? {},
    memoryModule: globalThis.__marinaraMemory?.version ?? null,
    types: TYPES,
    fields: FIELDS,
    budget: { default: BUDGET_DEFAULT, min: BUDGET_MIN, max: BUDGET_MAX },
  })));

  r.get('/worlds', handle(async () => ({ worlds: s().listWorlds() })));
  r.post('/worlds', handle(async (req) => s().createWorld(body(req))));
  r.get('/worlds/:worldId', handle(async (req) => s().getWorld(req.params.worldId)));
  r.patch('/worlds/:worldId', handle(async (req) => s().updateWorld(req.params.worldId, body(req))));
  r.delete('/worlds/:worldId', handle(async (req) => s().deleteWorld(req.params.worldId, body(req).revision ?? Number(req.query?.revision))));

  r.get('/worlds/:worldId/entities', handle(async (req) => ({ entities: s().listEntities(req.params.worldId) })));
  r.post('/worlds/:worldId/entities', handle(async (req) => s().createEntity(req.params.worldId, body(req))));
  r.patch('/worlds/:worldId/entities/:entityId', handle(async (req) => s().updateEntity(req.params.worldId, req.params.entityId, body(req))));
  r.delete('/worlds/:worldId/entities/:entityId', handle(async (req) =>
    s().deleteEntity(req.params.worldId, req.params.entityId, body(req).revision ?? Number(req.query?.revision))));

  r.get('/rooms/:roomId', handle(async (req) => s().getRoom(req.params.roomId)));
  r.put('/rooms/:roomId', handle(async (req) => {
    const w = body(req).worldId;
    if (w !== null && typeof w !== 'string') throw new ArchiveError(400, 'worldId(연결을 끊을 때는 null)를 보내 주세요.');
    return s().linkRoom(req.params.roomId, w);
  }));
  r.get('/rooms/:roomId/preview', handle(async (req) => {
    s().getRoom(req.params.roomId); // validates the id
    return preview(req.params.roomId);
  }));
}

/**
 * POST /api/chats/:id/branch answered with the new chat: it gets the same world as the source room.
 * DELETE /api/chats/:id that succeeded: the room's link goes (the world and its settings stay).
 */
function branchOnSend(req, reply, payload) {
  try {
    const url = String(req.raw?.url || '').split('?')[0];
    const gone = /^\/api\/chats\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url);
    if (req.method === 'DELETE' && gone && reply.statusCode >= 200 && reply.statusCode < 300) {
      if (store().roomWorldId(gone[1])) {
        store().linkRoom(gone[1], null);
        log(`chat ${gone[1]} deleted; its world link removed`);
      }
      return;
    }
    const m = /^\/api\/chats\/([A-Za-z0-9_-]{1,128})\/branch\/?$/.exec(url);
    if (req.method !== 'POST' || !m || reply.statusCode < 200 || reply.statusCode >= 300) return;
    const chat = typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(String(payload)) : payload;
    if (typeof chat?.id === 'string' && store().inheritRoom(m[1], chat.id)) log(`branch ${chat.id} reads the world of ${m[1]}`);
  } catch (error) {
    log(`branch link failed: ${error?.message || error}`);
  }
}

function attach(app) {
  app.register(routes, { prefix: PREFIX });
  app.addHook('onSend', (req, reply, payload, done) => {
    branchOnSend(req, reply, payload);
    done(null, payload);
  });
  log(`API ready at ${PREFIX} (data: ${dataDir()})`);
}

module.exports = { render, attach, preview, routes, dataDir, _test: { useStore, branchOnSend } };
