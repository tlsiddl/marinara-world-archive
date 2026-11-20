'use strict';
// World Archive server side: {{세계}} rendering and the /api/world-archive routes.
// Routes are registered with app.register at the app.js anchor, so Marinara's own access checks (login, IP allowlist,
// CSRF, host validation) cover them exactly like the engine's routes. There is no separate token.
const path = require('node:path');
const { Archive, ArchiveError, mentions, isDescriptiveName, TYPES, FIELDS, BUDGET_DEFAULT, BUDGET_MIN, BUDGET_MAX, AUTO_EVERY } = require('./store.cjs');
const X = require('./extract.cjs');
const N = require('./names.cjs');
const G = require('./vendor/glossary.cjs');
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

// ---------------------------------------------------------------- automatic updates
// The engine side (reading chats, calling a model) is loaded only when a world has automatic updates on.
let eng = null;
const engineApi = () => (eng ??= require('./vendor/engine.cjs'));
function useEngine(e) {
  eng = e;
}

const AUTO_DELAY_MS = 4000; // after a reply: wait a little, so a quick reroll is not read first
const AUTO_MAX_BATCHES = 4; // per reply; the rest is read after the next replies (or with 「지금 읽기」)
const READ_MAX_TOKENS = 8192; // a full batch with per-field evidence can pass 4096 (seen on the real server, v0.3.4)
const jobs = new Map(); // roomId -> job
const timers = new Map();

/** The last cut-off reply of a room, for looking into why (DATA_DIR/world-archive/debug/cut-<room>.txt). Never throws. */
function keepCut(roomId, text) {
  try {
    const fs = require('node:fs');
    const dir = path.join(store().dir, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const s = String(text || '');
    fs.writeFileSync(path.join(dir, `cut-${roomId}.txt`), `${new Date().toISOString()} · ${s.length} chars\n--- start\n${s.slice(0, 3000)}\n--- end\n${s.slice(-3000)}\n`);
  } catch {}
}

function autoReady(world) {
  return !!(world?.auto?.enabled && world.auto.connectionId);
}

// ---------------------------------------------------------------- the translation glossary (read only)
const glossaries = new Map(); // roomId -> the pairs last read, for suggest() between readings

/**
 * The room's 「번역 프리셋·단어장」 pairs, or null when the glossary cannot be read or has no glossary field (then
 * nothing follows it — a failure is never an empty glossary). Never throws.
 */
async function roomGlossary(api, roomId) {
  try {
    if (typeof api.glossary !== 'function') return null;
    const text = await api.glossary(roomId);
    if (typeof text !== 'string') return null;
    const pairs = G.parseGlossary(text);
    glossaries.set(roomId, pairs);
    return pairs;
  } catch {
    return null;
  }
}

/**
 * When the room's glossary differs from the one last brought in (by hash), every setting of the world is brought in
 * line with it; otherwise nothing. Returns the changes.
 */
function followGlossary(roomId, worldId, pairs) {
  const hash = N.hashPairs(pairs);
  if (store().roomGlossaryHash(roomId) === hash) return [];
  const changes = store().alignGlossary(worldId, pairs, { roomId });
  store().setRoomGlossary(roomId, hash);
  if (changes.length) log(`chat ${roomId}: glossary changed; ${changes.length} name change(s)`);
  return changes;
}

/** The settings a reading touched or named (by name or other name), for checking their names after saving. */
function touchedIds(worldId, items, changes) {
  const ids = new Set(changes.map((c) => c.entityId));
  const keys = new Set(items.flatMap((it) => [it.name, it.match, ...(Array.isArray(it.aliases) ? it.aliases : [])]).filter((n) => typeof n === 'string' && n.trim()).map(N.key));
  for (const e of store().readEntities(worldId).entities) if ([e.name, ...e.aliases].some((n) => keys.has(N.key(n)))) ids.add(e.entityId);
  return ids;
}

/**
 * Reads what was not read yet in one room and writes what it finds into the room's world.
 * all: read everything pending now (the 「지금 읽기」 button); otherwise only when at least `every` settled messages
 * wait, and at most AUTO_MAX_BATCHES batches.
 */
async function runRoom(roomId, { all = false, reason = 'reply', restart = false } = {}) {
  const running = jobs.get(roomId);
  if (running?.state === 'running') return running;
  const s = store();
  const worldId = s.roomWorldId(roomId);
  if (!worldId) throw new ArchiveError(400, '이 방은 세계관에 연결되어 있지 않습니다.');
  const world = s.getWorld(worldId);
  const job = { state: 'running', reason, stage: '대화를 불러오는 중', done: 0, total: 0, added: 0, changed: 0, renamed: 0, relations: 0, dropped: 0, fieldsDropped: 0, calls: 0, tokens: {}, startedAt: new Date().toISOString() };
  jobs.set(roomId, job);
  // 「처음부터 다시 읽기」: only where the room was read is forgotten. Settings stay; what is read again is applied (and
  // recorded) the usual way, so a person's own fields are still never written over.
  if (restart) {
    s.setRoomRead(roomId, null);
    log(`chat ${roomId}: reading again from the start`);
  }
  try {
    const api = engineApi();
    // The glossary is read first: a changed one brings the existing names in line even when nothing new waits.
    const glossary = await roomGlossary(api, roomId);
    if (glossary) job.renamed += followGlossary(roomId, worldId, glossary).filter((c) => c.action === 'rename').length;
    const m = await api.model(world.auto.connectionId);
    const { messages, cast } = await api.chatMessages(roomId);
    const { start, pending, settled } = X.unread(messages, s.getRoom(roomId).read);
    if (!pending.length || (!all && pending.length < world.auto.every)) {
      job.state = 'idle';
      job.stage = '';
      job.pending = pending.length;
      return job;
    }
    const parts = X.batches(settled, start);
    const todo = all ? parts : parts.slice(0, AUTO_MAX_BATCHES);
    job.total = todo.length;
    for (const [i, first] of todo.entries()) {
      job.stage = `${i + 1}/${todo.length}번째 묶음을 읽는 중`;
      // A reply cut off at the length limit is read again as two halves (at most twice), so nothing in the batch is
      // lost; only a single message that still does not fit keeps the whole items that arrived.
      const queue = [first];
      while (queue.length) {
        const part = queue.shift();
        let parsed = null;
        let split = false;
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
          const reply = await api.askModel(m, X.buildPrompt(world, s.readEntities(worldId).entities, part, cast, glossary || []), { maxTokens: READ_MAX_TOKENS });
          job.calls++;
          // Whatever token counts the provider reports (names differ between providers), summed for measuring.
          for (const [k, v] of Object.entries(reply.usage || {})) if (typeof v === 'number') job.tokens[k] = (job.tokens[k] || 0) + v;
          const got = X.readReply(reply.content, api.parseJsonObject);
          if (got?.cut || (!got && /"items"\s*:\s*\[/.test(reply.content || ''))) {
            keepCut(roomId, reply.content);
            if (part.batch.length > 1 && (part.depth || 0) < 2) {
              const k = Math.ceil(part.batch.length / 2);
              const depth = (part.depth || 0) + 1;
              queue.unshift(
                { batch: part.batch.slice(0, k), context: part.context, end: part.end - (part.batch.length - k), depth },
                { batch: part.batch.slice(k), context: part.batch.slice(Math.max(0, k - 2), k), end: part.end, depth },
              );
              log(`chat ${roomId}: reply cut off in batch ${i + 1} (${part.batch.length} messages); reading it again in two halves`);
              split = true;
              break;
            }
            if (got) log(`chat ${roomId}: reply cut off in batch ${i + 1}; kept ${got.items.length} whole item(s)`);
          }
          parsed = got;
        }
        if (split) continue;
        if (!parsed) throw Error('모델 답을 읽지 못했습니다. 잠시 뒤 다시 해 보거나, 다른 연결을 골라 주세요.');
        const { items, dropped, droppedFields } = X.checkItems(parsed, part, cast);
        const changes = s.applyAuto(worldId, items, { roomId, messageIds: part.batch.map((x) => x.id) });
        job.added += changes.filter((c) => c.action === 'create').length;
        job.changed += changes.filter((c) => c.action !== 'create').length;
        // Saved, then checked by the program: names the glossary has become the glossary's (model or not).
        if (glossary) job.renamed += s.alignGlossary(worldId, glossary, { roomId, ids: touchedIds(worldId, items, changes) }).filter((c) => c.action === 'rename').length;
        job.dropped += dropped.length;
        job.fieldsDropped += droppedFields.length;
        // Relations: both ends must be settings by now (existing, or made from this batch's items).
        const meta = { roomId, messageIds: part.batch.map((x) => x.id) };
        s.convertGroups(worldId, null, meta); // 「○○ 무리」 · 「학생들」: a crowd is a group
        const rel = X.checkRelations(parsed, part, cast);
        const ents = s.readEntities(worldId).entities;
        const resolved = [];
        for (const r of rel.relations) {
          const from = s.findByName(ents, r.from);
          const to = s.findByName(ents, r.to);
          if (!from || !to || from.entityId === to.entityId) rel.dropped.push({ name: r.from + ' — ' + r.to, why: 'no such setting' });
          else if (!X.relationFits(r.type, from.type, to.type)) rel.dropped.push({ name: r.from + ' — ' + r.to, why: `${r.type} between ${from.type} and ${to.type}` });
          else if ((from.type === 'person' && isDescriptiveName(from.name)) || (to.type === 'person' && isDescriptiveName(to.name))) rel.dropped.push({ name: r.from + ' — ' + r.to, why: 'described name' });
          else if (!mentions(r.evidence, from) && !mentions(r.evidence, to)) rel.dropped.push({ name: r.from + ' — ' + r.to, why: 'evidence names neither' });
          else resolved.push({ ...r, from: from.entityId, to: to.entityId });
        }
        const relChanges = [...s.applyRelations(worldId, resolved, meta), ...s.linkAffiliations(worldId, null, meta)];
        job.relations += relChanges.filter((c) => c.action === 'relation-add').length;
        if (rel.dropped.length) log(`chat ${roomId}: left out relations ${rel.dropped.map((d) => `${d.name} (${d.why})`).join(', ')}`);
        s.setRoomRead(roomId, { lastId: part.batch.at(-1).id, count: part.end });
        if (dropped.length) log(`chat ${roomId}: left out ${dropped.map((d) => `${d.name} (${d.why})`).join(', ')}`);
        if (droppedFields.length) log(`chat ${roomId}: left out fields ${droppedFields.map((d) => `${d.name}.${d.key} (${d.why})`).join(', ')}`);
      }
      job.done++;
    }
    job.pending = settled.length - todo.at(-1).end;
    job.state = 'done';
    job.stage = '';
    const secs = ((Date.now() - Date.parse(job.startedAt)) / 1000).toFixed(1);
    log(`chat ${roomId}: read ${todo.length} batch(es) in ${secs}s, ${job.calls} call(s), tokens ${JSON.stringify(job.tokens)}, ${job.added} new, ${job.changed} updated, ${job.renamed} renamed by the glossary, ${job.relations} relation(s), ${job.dropped} left out, ${job.fieldsDropped} field(s) left out`);
  } catch (error) {
    job.state = 'error';
    job.error = error?.message || String(error);
    log(`chat ${roomId}: automatic update failed: ${job.error}`);
  } finally {
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

/** After a reply in a linked room whose world reads automatically. Never throws. */
function scheduleRoom(roomId) {
  try {
    const worldId = store().roomWorldId(roomId);
    if (!worldId || !autoReady(store().getWorld(worldId))) return;
    clearTimeout(timers.get(roomId));
    timers.set(roomId, setTimeout(() => {
      timers.delete(roomId);
      runRoom(roomId).catch((e) => log(`chat ${roomId}: ${e?.message || e}`));
    }, AUTO_DELAY_MS));
  } catch (error) {
    log(`chat ${roomId}: could not schedule: ${error?.message || error}`);
  }
}

async function roomAuto(roomId) {
  const s = store();
  const room = s.getRoom(roomId);
  const world = room.worldId ? s.getWorld(room.worldId) : null;
  const out = { roomId, worldId: room.worldId, enabled: !!world?.auto.enabled, ready: autoReady(world), every: world?.auto.every ?? null, job: jobs.get(roomId) || null, pending: null, read: room.read };
  if (world?.auto.connectionId) {
    try {
      const { messages } = await engineApi().chatMessages(roomId);
      out.pending = X.unread(messages, room.read).pending.length;
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- the current scene
// Which settings are named in the latest messages of a room. Worked out (async) just before a reply or a prompt
// preview is built, and read (sync) by {{세계}}. Without it, {{세계}} still works: everything is a candidate.
const SCENE_MESSAGES = 12;
const SCENE_TIMEOUT_MS = 1500;
const scenes = new Map(); // roomId -> { ids: Set, at }

function sceneIds(entities, texts) {
  const text = X.squash(texts.join('\n'));
  const ids = new Set();
  for (const e of entities) {
    if ([e.name, ...e.aliases].some((n) => { const k = X.squash(n); return k.length >= 2 && text.includes(k); })) ids.add(e.entityId);
  }
  return ids;
}

async function updateScene(roomId, extraText = '') {
  const worldId = store().roomWorldId(roomId);
  if (!worldId) return null;
  const { messages } = await engineApi().chatMessages(roomId);
  const texts = messages.slice(-SCENE_MESSAGES).map((m) => m.content);
  if (extraText) texts.push(extraText);
  const ids = sceneIds(store().readEntities(worldId).entities, texts);
  scenes.set(roomId, { ids, worldId, at: Date.now() });
  return ids;
}

/** Before a reply or a preview: refresh the scene, but never hold the reply up for long or fail it. */
async function sceneBeforeReply(req) {
  try {
    const url = String(req.raw?.url || '').split('?')[0];
    if (req.method !== 'POST' || (url !== '/api/generate' && url !== '/api/generate/dryRun')) return;
    const chatId = req.body?.chatId;
    if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId) || !store().roomWorldId(chatId)) return;
    const extra = typeof req.body?.userMessage === 'string' ? req.body.userMessage : '';
    await Promise.race([updateScene(chatId, extra), new Promise((r) => setTimeout(r, SCENE_TIMEOUT_MS))]);
  } catch (error) {
    log(`scene for ${req.body?.chatId}: ${error?.message || error}`);
  }
}

/** What one room's {{세계}} would be right now. */
function preview(roomId) {
  const s = store();
  const worldId = s.roomWorldId(roomId);
  if (!worldId) return { roomId, worldId: null, text: '', chars: 0, budget: 0, included: [], omitted: [], skipped: 0 };
  const world = s.listWorlds().find((w) => w.worldId === worldId);
  if (!world) return { roomId, worldId: null, text: '', chars: 0, budget: 0, included: [], omitted: [], skipped: 0 };
  // A scene worked out for another world (the room was relinked since) does not count.
  const known = scenes.get(roomId);
  const doc = s.readEntities(worldId);
  const scene = known?.worldId === worldId ? known.ids : null;
  return { roomId, worldId, worldName: world.name, mode: world.injectMode, sceneKnown: !!scene, ...assembleWorld(world, doc.entities, world.injectChars, { scene, relations: doc.relations }) };
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
          ? `{{세계}} for chat ${roomId}: ${p.included.length} settings (${p.chars}/${p.budget} chars)${p.omitted.length ? `, ${p.omitted.length} left out for length` : ''}${p.skipped ? `, ${p.skipped} outside the scene` : ''}`
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
    autoEvery: AUTO_EVERY,
  })));

  r.get('/worlds', handle(async () => ({ worlds: s().listWorlds() })));
  r.post('/worlds', handle(async (req) => s().createWorld(body(req))));
  r.get('/worlds/:worldId', handle(async (req) => s().getWorld(req.params.worldId)));
  r.patch('/worlds/:worldId', handle(async (req) => s().updateWorld(req.params.worldId, body(req))));
  r.delete('/worlds/:worldId', handle(async (req) => s().deleteWorld(req.params.worldId, body(req).revision ?? Number(req.query?.revision))));

  r.get('/worlds/:worldId/entities', handle(async (req) => ({ entities: s().listEntities(req.params.worldId) })));
  r.post('/worlds/:worldId/entities', handle(async (req) => s().createEntity(req.params.worldId, body(req))));
  r.patch('/worlds/:worldId/entities/:entityId', handle(async (req) => {
    const e = s().updateEntity(req.params.worldId, req.params.entityId, body(req));
    // 소속 칸이 설정집의 집단을 가리키면 소속 관계도 (코드로, 모델 없이).
    if (e.type === 'person') s().linkAffiliations(req.params.worldId, [e.entityId], { by: 'affiliation' });
    return e;
  }));
  r.get('/worlds/:worldId/relations', handle(async (req) => ({ relations: s().listRelations(req.params.worldId) })));
  // The current rules applied again by code to what was already read (no model): crowds become groups, misfit relations go.
  r.post('/worlds/:worldId/relations/recheck', handle(async (req) => {
    const retyped = s().convertGroups(req.params.worldId, null, { by: 'recheck' });
    const removed = s().recheckRelations(req.params.worldId, { by: 'recheck' });
    return { retyped: retyped.map((c) => c.name), removed: removed.map((c) => ({ name: c.name, type: c.relation.type, why: c.why })) };
  }));
  r.post('/worlds/:worldId/relations', handle(async (req) => s().createRelation(req.params.worldId, body(req))));
  r.patch('/worlds/:worldId/relations/:relationId', handle(async (req) => s().updateRelation(req.params.worldId, req.params.relationId, body(req))));
  r.delete('/worlds/:worldId/relations/:relationId', handle(async (req) => s().deleteRelation(req.params.worldId, req.params.relationId)));
  r.delete('/worlds/:worldId/entities/:entityId', handle(async (req) =>
    s().deleteEntity(req.params.worldId, req.params.entityId, body(req).revision ?? Number(req.query?.revision))));

  r.get('/rooms/:roomId', handle(async (req) => s().getRoom(req.params.roomId)));
  r.get('/rooms/:roomId/auto', handle(async (req) => roomAuto(req.params.roomId)));
  r.post('/rooms/:roomId/auto', handle(async (req) => {
    const room = s().getRoom(req.params.roomId);
    if (!room.worldId) throw new ArchiveError(400, '이 방은 세계관에 연결되어 있지 않습니다.');
    const world = s().getWorld(room.worldId);
    if (!world.auto.connectionId) throw new ArchiveError(400, '자동 반영에 쓸 연결을 먼저 골라 주세요 (세계관 정보).');
    const p = runRoom(req.params.roomId, { all: body(req).all !== false, reason: body(req).restart === true ? 'restart' : 'button', restart: body(req).restart === true });
    // Reading can take minutes: answer at once, the screen asks again for progress.
    await Promise.race([p, new Promise((r) => setTimeout(r, 300))]);
    return roomAuto(req.params.roomId);
  }));
  // 같은 사람일 수 있음: suggestions only; merging takes the person's own press, and is undone from the history.
  r.get('/worlds/:worldId/duplicates', handle(async (req) => ({ pairs: s().listDuplicates(req.params.worldId) })));
  r.post('/worlds/:worldId/duplicates/dismiss', handle(async (req) => s().dismissPair(req.params.worldId, body(req).a, body(req).b)));
  r.post('/worlds/:worldId/merge', handle(async (req) => s().mergeEntities(req.params.worldId, body(req))));
  r.get('/worlds/:worldId/history', handle(async (req) => ({ changes: s().listHistory(req.params.worldId, Math.min(Number(req.query?.limit) || 200, 1000)) })));
  r.post('/worlds/:worldId/history/:changeId/undo', handle(async (req) => s().undoChange(req.params.worldId, req.params.changeId)));
  r.get('/connections', handle(async () => ({ connections: await engineApi().listConnections() })));
  r.get('/rooms/:roomId/entities', handle(async (req) => { s().getRoom(req.params.roomId); return roomEntities(req.params.roomId); }));
  r.get('/rooms/:roomId/lookup', handle(async (req) => { s().getRoom(req.params.roomId); return lookup(req.params.roomId, String(req.query?.name || '')); }));
  r.get('/rooms/:roomId/names', handle(async (req) => { s().getRoom(req.params.roomId); return names(req.params.roomId); }));
  r.post('/rooms/:roomId/suggest', handle(async (req) => {
    s().getRoom(req.params.roomId);
    const by = typeof body(req).by === 'string' ? body(req).by : 'module';
    return suggest(req.params.roomId, body(req).items, by);
  }));
  r.put('/rooms/:roomId', handle(async (req) => {
    const w = body(req).worldId;
    if (w !== null && typeof w !== 'string') throw new ArchiveError(400, 'worldId(연결을 끊을 때는 null)를 보내 주세요.');
    return s().linkRoom(req.params.roomId, w);
  }));
  r.get('/rooms/:roomId/preview', handle(async (req) => {
    s().getRoom(req.params.roomId); // validates the id
    try { await Promise.race([updateScene(req.params.roomId), new Promise((r) => setTimeout(r, SCENE_TIMEOUT_MS))]); } catch {}
    return preview(req.params.roomId);
  }));
}

// ---------------------------------------------------------------- for other modules (기억 서재 and others)
// Contract: docs/연동-계약.md. The same four things are offered in-process on globalThis.__marinaraWorldArchive.api
// (no HTTP, for preloads in the same server) and over HTTP under /api/world-archive/rooms/:roomId/….
const compact = (e) => ({ entityId: e.entityId, type: e.type, name: e.name, aliases: e.aliases, fields: e.fields, description: e.description, pinned: e.pinned, sources: e.sources, updatedAt: e.updatedAt });

function roomEntities(roomId) {
  const worldId = store().roomWorldId(roomId);
  if (!worldId) return { worldId: null, entities: [] };
  return { worldId, entities: store().readEntities(worldId).entities.map(compact) };
}

function lookup(roomId, name) {
  const { worldId, entities } = roomEntities(roomId);
  const key = X.squash(name);
  if (!key) return { worldId, entity: null };
  const hit = entities.find((e) => [e.name, ...e.aliases].some((n) => X.squash(n) === key)) || null;
  return { worldId, entity: hit };
}

/**
 * Settings another module found (same item shape as the reader's: type, name, aliases, match, fields, memo, evidence
 * as text). Written like the reader's: never over what the person typed, logged with `by`, undoable. Only for a room
 * whose world has automatic updates on — otherwise nothing is written and { written: false } comes back.
 */
function suggest(roomId, items, by = 'module') {
  const worldId = store().roomWorldId(roomId);
  if (!worldId) return { written: false, reason: 'no world', changes: [] };
  const world = store().getWorld(worldId);
  if (!world.auto.enabled) return { written: false, reason: 'automatic updates off', changes: [] };
  const list = (Array.isArray(items) ? items : []).slice(0, 50).map((it) => ({ ...it, evidence: typeof it?.evidence === 'string' ? it.evidence.slice(0, 300) : '' }));
  // `by` names the module in the history; a name that is not a plain id is recorded as 'module'.
  const who = typeof by === 'string' && /^[a-z0-9-]{1,40}$/.test(by) ? by : 'module';
  const changes = store().applyAuto(worldId, list, { roomId, by: who });
  // the room's glossary as last read: names it has become its own, as after the reader's saving
  const pairs = glossaries.get(roomId);
  if (pairs) changes.push(...store().alignGlossary(worldId, pairs, { roomId, ids: touchedIds(worldId, list.filter((x) => x && typeof x === 'object'), changes) }));
  return { written: true, changes: changes.map((c) => ({ id: c.id, action: c.action, entityId: c.entityId, name: c.name, key: c.key })) };
}

/**
 * GET …/names: the room's names in the glossary's shape, { names: [{ original, translation, kind }] } — settings with
 * a Korean name and a romanized other name, proper nouns only (people, places, groups; kind is the Korean label:
 * 인물, 장소, 집단). A room
 * with no world: { names: [] }. Names that follow the glossary come back as the glossary's own pairs.
 */
function names(roomId) {
  const worldId = store().roomWorldId(roomId);
  if (!worldId) return { names: [] };
  return { names: N.glossaryNames(store().readEntities(worldId).entities) };
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
  if (globalThis.__marinaraWorldArchive) globalThis.__marinaraWorldArchive.api = { version: 1, roomEntities, lookup, suggest, names };
  app.register(routes, { prefix: PREFIX });
  app.addHook('preHandler', sceneBeforeReply);
  app.addHook('onSend', (req, reply, payload, done) => {
    branchOnSend(req, reply, payload);
    done(null, payload);
  });
  app.addHook('onResponse', async (req, reply) => {
    try {
      const url = String(req.raw?.url || '').split('?')[0];
      if (req.method !== 'POST' || url !== '/api/generate' || reply.statusCode >= 400) return;
      const chatId = req.body?.chatId;
      if (typeof chatId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(chatId)) scheduleRoom(chatId);
    } catch {}
  });
  log(`API ready at ${PREFIX} (data: ${dataDir()})`);
}

module.exports = { render, attach, preview, routes, dataDir, runRoom, roomEntities, lookup, suggest, names, _test: { useStore, useEngine, branchOnSend, scheduleRoom, jobs, updateScene, sceneBeforeReply, scenes, glossaries } };
