'use strict';
// World Archive storage. Everything lives under <DATA_DIR>/world-archive/ and nowhere else:
//   worlds.json             — the list of worlds
//   rooms.json              — which chat (roomId) reads which world
//   entities/<worldId>.json — the settings of one world
//   trash/                  — a deleted world's files, kept so a mistaken delete can be undone by hand
// Writes go to a temporary file first and then replace the old file in one step. A file that cannot be read,
// or that has a newer schema than this version knows, is never overwritten: the request fails instead.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCHEMA = 1;
const NAME_MAX = 120;
const DESC_MAX = 4000;
const ALIAS_MAX = 20;
const ALIAS_LEN = 60;
const ENTITY_MAX = 2000;
const FILE_MAX = 8 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TYPES = ['person', 'place', 'group', 'rule', 'schedule', 'custom'];
const BUDGET_MIN = 300;
const BUDGET_MAX = 20000;
const BUDGET_DEFAULT = 3000;

class ArchiveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const now = () => new Date().toISOString();

function cleanLine(v, max, what) {
  if (typeof v !== 'string') throw new ArchiveError(400, `${what}을(를) 글자로 입력해 줘.`);
  const x = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!x) throw new ArchiveError(400, `${what}이(가) 비어 있어.`);
  if (x.length > max) throw new ArchiveError(400, `${what}은(는) ${max}자까지야.`);
  return x;
}

function cleanText(v, max, what) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ArchiveError(400, `${what}을(를) 글자로 입력해 줘.`);
  const x = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (x.length > max) throw new ArchiveError(400, `${what}은(는) ${max}자까지야.`);
  return x;
}

function cleanAliases(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ArchiveError(400, '다른 이름은 목록으로 보내 줘.');
  const out = [];
  const seen = new Set([name.toLowerCase()]);
  for (const a of v) {
    const x = cleanLine(a, ALIAS_LEN, '다른 이름');
    if (seen.has(x.toLowerCase())) continue;
    seen.add(x.toLowerCase());
    out.push(x);
  }
  if (out.length > ALIAS_MAX) throw new ArchiveError(400, `다른 이름은 ${ALIAS_MAX}개까지야.`);
  return out;
}

function cleanBudget(v) {
  if (v === undefined || v === null) return BUDGET_DEFAULT;
  if (!Number.isSafeInteger(v) || v < BUDGET_MIN || v > BUDGET_MAX) {
    throw new ArchiveError(400, `프롬프트에 넣을 글자 수는 ${BUDGET_MIN}~${BUDGET_MAX} 사이여야 해.`);
  }
  return v;
}

function needId(id, what = '세계관') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ArchiveError(400, `${what} ID가 올바르지 않아.`);
  return id;
}

function needRoom(id) {
  if (typeof id !== 'string' || !ROOM_RE.test(id)) throw new ArchiveError(400, '채팅방 ID가 올바르지 않아.');
  return id;
}

function needRevision(r) {
  if (!Number.isSafeInteger(r) || r < 1) throw new ArchiveError(400, 'revision이 필요해. 목록을 새로 불러와.');
  return r;
}

const broken = (what) => new ArchiveError(409, `${what} 파일이 손상됐거나 이 버전이 모르는 형식이야. 덮어쓰지 않았어.`);

function validWorld(w) {
  return (
    isObject(w) &&
    typeof w.worldId === 'string' &&
    ID_RE.test(w.worldId) &&
    typeof w.name === 'string' &&
    typeof w.description === 'string' &&
    Number.isSafeInteger(w.injectChars) &&
    typeof w.createdAt === 'string' &&
    typeof w.updatedAt === 'string' &&
    Number.isSafeInteger(w.revision) &&
    w.revision >= 1
  );
}

function validEntity(e) {
  return (
    isObject(e) &&
    typeof e.entityId === 'string' &&
    ID_RE.test(e.entityId) &&
    TYPES.includes(e.type) &&
    typeof e.name === 'string' &&
    Array.isArray(e.aliases) &&
    e.aliases.every((a) => typeof a === 'string') &&
    typeof e.description === 'string' &&
    typeof e.status === 'string' &&
    typeof e.pinned === 'boolean' &&
    isObject(e.provenance) &&
    Number.isSafeInteger(e.revision) &&
    e.revision >= 1
  );
}

class Archive {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.worldsFile = path.join(this.dir, 'worlds.json');
    this.roomsFile = path.join(this.dir, 'rooms.json');
    this.entityDir = path.join(this.dir, 'entities');
    this.trashDir = path.join(this.dir, 'trash');
  }

  // ---------------------------------------------------------------- files

  readJson(file, empty, check, what) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return empty();
      throw e;
    }
    if (Buffer.byteLength(raw, 'utf8') > FILE_MAX) throw new ArchiveError(409, `${what} 파일이 너무 커. 덮어쓰지 않았어.`);
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw broken(what);
    }
    if (!isObject(doc) || doc.schemaVersion !== SCHEMA || !check(doc)) throw broken(what);
    return doc;
  }

  writeJson(file, doc) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }

  readWorlds() {
    return this.readJson(
      this.worldsFile,
      () => ({ schemaVersion: SCHEMA, worlds: [] }),
      (d) => {
        if (!Array.isArray(d.worlds)) return false;
        const ids = new Set();
        for (const w of d.worlds) {
          if (!validWorld(w) || ids.has(w.worldId)) return false;
          ids.add(w.worldId);
        }
        return true;
      },
      '세계관 목록',
    );
  }

  readRooms() {
    return this.readJson(
      this.roomsFile,
      () => ({ schemaVersion: SCHEMA, rooms: {} }),
      (d) =>
        isObject(d.rooms) &&
        Object.entries(d.rooms).every(
          ([k, v]) => ROOM_RE.test(k) && isObject(v) && typeof v.worldId === 'string' && ID_RE.test(v.worldId),
        ),
      '채팅방 연결',
    );
  }

  entityFile(worldId) {
    return path.join(this.entityDir, `${needId(worldId)}.json`);
  }

  readEntities(worldId) {
    return this.readJson(
      this.entityFile(worldId),
      () => ({ schemaVersion: SCHEMA, worldId, entities: [] }),
      (d) => {
        if (d.worldId !== worldId || !Array.isArray(d.entities)) return false;
        const ids = new Set();
        for (const e of d.entities) {
          if (!validEntity(e) || ids.has(e.entityId)) return false;
          ids.add(e.entityId);
        }
        return true;
      },
      '세계관 설정',
    );
  }

  // ---------------------------------------------------------------- worlds

  listWorlds() {
    return this.readWorlds().worlds;
  }

  getWorld(worldId) {
    needId(worldId);
    const w = this.readWorlds().worlds.find((x) => x.worldId === worldId);
    if (!w) throw new ArchiveError(404, '세계관을 찾지 못했어.');
    return w;
  }

  createWorld(body = {}) {
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 줘.');
    const name = cleanLine(body.name, NAME_MAX, '세계관 이름');
    const description = cleanText(body.description, DESC_MAX, '세계관 설명');
    const injectChars = cleanBudget(body.injectChars);
    const doc = this.readWorlds();
    const t = now();
    const world = { worldId: randomUUID(), name, description, injectChars, revision: 1, createdAt: t, updatedAt: t };
    doc.worlds.push(world);
    this.writeJson(this.worldsFile, doc);
    return world;
  }

  updateWorld(worldId, body = {}) {
    needId(worldId);
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 줘.');
    const revision = needRevision(body.revision);
    const doc = this.readWorlds();
    const world = doc.worlds.find((x) => x.worldId === worldId);
    if (!world) throw new ArchiveError(404, '세계관을 찾지 못했어.');
    if (world.revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤어. 새로 불러와서 다시 해 줘.');
    const next = { ...world };
    let changed = false;
    if (body.name !== undefined) (next.name = cleanLine(body.name, NAME_MAX, '세계관 이름')), (changed = true);
    if (body.description !== undefined) (next.description = cleanText(body.description, DESC_MAX, '세계관 설명')), (changed = true);
    if (body.injectChars !== undefined) (next.injectChars = cleanBudget(body.injectChars)), (changed = true);
    if (!changed) throw new ArchiveError(400, '고칠 내용이 없어.');
    next.revision++;
    next.updatedAt = now();
    Object.assign(world, next);
    this.writeJson(this.worldsFile, doc);
    return world;
  }

  /** The world, its settings and its room links go to trash/<worldId>-<time>/ — nothing is lost for good. */
  deleteWorld(worldId, revision) {
    needId(worldId);
    needRevision(revision);
    const doc = this.readWorlds();
    const index = doc.worlds.findIndex((x) => x.worldId === worldId);
    if (index < 0) throw new ArchiveError(404, '세계관을 찾지 못했어.');
    if (doc.worlds[index].revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤어. 새로 불러와서 다시 해 줘.');
    const entities = this.readEntities(worldId); // fails (and stops the delete) when the settings file is broken
    const rooms = this.readRooms();
    const linked = Object.keys(rooms.rooms).filter((k) => rooms.rooms[k].worldId === worldId);
    const bin = path.join(this.trashDir, `${worldId}-${now().replace(/[:.]/g, '-')}`);
    this.writeJson(path.join(bin, 'world.json'), {
      schemaVersion: SCHEMA,
      world: doc.worlds[index],
      entities: entities.entities,
      rooms: linked,
      deletedAt: now(),
    });
    for (const k of linked) delete rooms.rooms[k];
    if (linked.length) this.writeJson(this.roomsFile, rooms);
    doc.worlds.splice(index, 1);
    this.writeJson(this.worldsFile, doc);
    try {
      fs.unlinkSync(this.entityFile(worldId));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return { deleted: true, worldId, unlinkedRooms: linked.length };
  }

  // ---------------------------------------------------------------- entities

  listEntities(worldId) {
    this.getWorld(worldId);
    return this.readEntities(worldId).entities;
  }

  entityInput(body, base) {
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 줘.');
    const out = { ...base };
    if (body.type !== undefined || !base) {
      if (!TYPES.includes(body.type)) throw new ArchiveError(400, `종류는 ${TYPES.join(', ')} 중 하나여야 해.`);
      out.type = body.type;
    }
    if (body.name !== undefined || !base) out.name = cleanLine(body.name, NAME_MAX, '이름');
    if (body.aliases !== undefined || !base) out.aliases = cleanAliases(body.aliases, out.name);
    else if (body.name !== undefined) out.aliases = cleanAliases(out.aliases, out.name);
    if (body.description !== undefined || !base) out.description = cleanText(body.description, DESC_MAX, '설명');
    if (body.pinned !== undefined || !base) {
      if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new ArchiveError(400, 'pinned는 true/false야.');
      out.pinned = body.pinned === true;
    }
    return out;
  }

  createEntity(worldId, body = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    if (doc.entities.length >= ENTITY_MAX) throw new ArchiveError(400, `한 세계관에는 설정을 ${ENTITY_MAX}개까지 넣을 수 있어.`);
    const input = this.entityInput(body, null);
    const t = now();
    const entity = {
      entityId: randomUUID(),
      ...input,
      status: 'confirmed',
      provenance: { source: 'manual' },
      revision: 1,
      createdAt: t,
      updatedAt: t,
    };
    doc.entities.push(entity);
    this.writeJson(this.entityFile(worldId), doc);
    return entity;
  }

  updateEntity(worldId, entityId, body = {}) {
    this.getWorld(worldId);
    needId(entityId, '설정');
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 줘.');
    const revision = needRevision(body.revision);
    const doc = this.readEntities(worldId);
    const entity = doc.entities.find((x) => x.entityId === entityId);
    if (!entity) throw new ArchiveError(404, '설정을 찾지 못했어.');
    if (entity.revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤어. 새로 불러와서 다시 해 줘.');
    const { revision: _r, ...rest } = body;
    if (!Object.keys(rest).length) throw new ArchiveError(400, '고칠 내용이 없어.');
    const next = this.entityInput(rest, entity);
    Object.assign(entity, next, { revision: entity.revision + 1, updatedAt: now() });
    this.writeJson(this.entityFile(worldId), doc);
    return entity;
  }

  deleteEntity(worldId, entityId, revision) {
    this.getWorld(worldId);
    needId(entityId, '설정');
    needRevision(revision);
    const doc = this.readEntities(worldId);
    const index = doc.entities.findIndex((x) => x.entityId === entityId);
    if (index < 0) throw new ArchiveError(404, '설정을 찾지 못했어.');
    if (doc.entities[index].revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤어. 새로 불러와서 다시 해 줘.');
    doc.entities.splice(index, 1);
    this.writeJson(this.entityFile(worldId), doc);
    return { deleted: true, entityId };
  }

  // ---------------------------------------------------------------- rooms

  roomWorldId(roomId) {
    if (typeof roomId !== 'string' || !ROOM_RE.test(roomId)) return null;
    return this.readRooms().rooms[roomId]?.worldId ?? null;
  }

  getRoom(roomId) {
    needRoom(roomId);
    const link = this.readRooms().rooms[roomId];
    if (!link) return { roomId, worldId: null };
    const exists = this.readWorlds().worlds.some((w) => w.worldId === link.worldId);
    return { roomId, worldId: exists ? link.worldId : null, linkedAt: link.linkedAt };
  }

  /** worldId null unlinks the room. */
  linkRoom(roomId, worldId) {
    needRoom(roomId);
    const rooms = this.readRooms();
    if (worldId === null) {
      if (rooms.rooms[roomId]) {
        delete rooms.rooms[roomId];
        this.writeJson(this.roomsFile, rooms);
      }
      return { roomId, worldId: null };
    }
    this.getWorld(worldId);
    rooms.rooms[roomId] = { worldId, linkedAt: now() };
    this.writeJson(this.roomsFile, rooms);
    return { roomId, worldId, linkedAt: rooms.rooms[roomId].linkedAt };
  }

  /** A branch of a linked room reads the same world. Never replaces a link the new room already has. */
  inheritRoom(fromRoomId, toRoomId) {
    if (!ROOM_RE.test(fromRoomId || '') || !ROOM_RE.test(toRoomId || '')) return false;
    const rooms = this.readRooms();
    const link = rooms.rooms[fromRoomId];
    if (!link || rooms.rooms[toRoomId]) return false;
    rooms.rooms[toRoomId] = { worldId: link.worldId, linkedAt: now(), branchedFrom: fromRoomId };
    this.writeJson(this.roomsFile, rooms);
    return true;
  }
}

module.exports = {
  Archive,
  ArchiveError,
  SCHEMA,
  TYPES,
  BUDGET_DEFAULT,
  BUDGET_MIN,
  BUDGET_MAX,
  ROOM_RE,
};
