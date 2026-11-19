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
const LINE_MAX = 200;
const TEXT_MAX = 2000;
const EXTRA_MAX = 20;
const EXTRA_LABEL = 40;

/**
 * Fields of each kind (기획서 2.3). kind 'line' is a short one-line value, 'text' a paragraph.
 * person.state is kept apart from the rest: it is what events changed (기획서 2단계 필수 설계 — 기본 정보와 사건으로
 * 변한 상태 구분). 'description' (메모) and 'extra' (사용자 정의 칸) exist for every kind.
 */
const FIELDS = {
  person: [
    { key: 'gender', label: '성별', kind: 'line' },
    { key: 'age', label: '나이·생일', kind: 'line' },
    { key: 'affiliation', label: '소속', kind: 'line' },
    { key: 'appearance', label: '외형', kind: 'text' },
    { key: 'personality', label: '성격', kind: 'text' },
    { key: 'background', label: '배경', kind: 'text' },
    { key: 'family', label: '가족 관계', kind: 'text' },
    { key: 'state', label: '지금 상태', kind: 'text', hint: '사건으로 바뀐 것 — 다침, 자리 이동, 관계 변화 같은 것' },
  ],
  place: [
    { key: 'location', label: '위치·소속', kind: 'line' },
    { key: 'use', label: '시설·용도', kind: 'line' },
    { key: 'layout', label: '내부 구조', kind: 'text' },
    { key: 'access', label: '출입구·연결', kind: 'text' },
    { key: 'limits', label: '제약', kind: 'text' },
  ],
  group: [
    { key: 'kind', label: '종류', kind: 'line', hint: '가문, 학교, 기숙사, 조직 같은 것' },
    { key: 'members', label: '구성원', kind: 'text' },
    { key: 'hierarchy', label: '위계·역할', kind: 'text' },
  ],
  rule: [{ key: 'category', label: '분류', kind: 'line', hint: '사회 제도, 세계 법칙, 능력 체계, 학교 규칙, 점수·계급 같은 것' }],
  schedule: [
    { key: 'when', label: '언제·주기', kind: 'line' },
    { key: 'where', label: '어디서', kind: 'line' },
    { key: 'who', label: '누가', kind: 'line' },
  ],
  custom: [],
};
const BUDGET_MIN = 300;
const BUDGET_MAX = 20000;
const BUDGET_DEFAULT = 3000;
const AUTO_EVERY = { min: 2, max: 50, default: 6 };
const HISTORY_MAX = 1000;
const SOURCES = ['manual', 'auto'];

class ArchiveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const now = () => new Date().toISOString();

function cleanLine(v, max, what) {
  if (typeof v !== 'string') throw new ArchiveError(400, `${what}을(를) 글자로 입력해 주세요.`);
  const x = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!x) throw new ArchiveError(400, `${what}이(가) 비어 있습니다.`);
  if (x.length > max) throw new ArchiveError(400, `${what}은(는) ${max}자까지입니다.`);
  return x;
}

function cleanText(v, max, what) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ArchiveError(400, `${what}을(를) 글자로 입력해 주세요.`);
  const x = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (x.length > max) throw new ArchiveError(400, `${what}은(는) ${max}자까지입니다.`);
  return x;
}

function cleanAliases(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ArchiveError(400, '다른 이름은 목록으로 보내 주세요.');
  const out = [];
  const seen = new Set([name.toLowerCase()]);
  for (const a of v) {
    const x = cleanLine(a, ALIAS_LEN, '다른 이름');
    if (seen.has(x.toLowerCase())) continue;
    seen.add(x.toLowerCase());
    out.push(x);
  }
  if (out.length > ALIAS_MAX) throw new ArchiveError(400, `다른 이름은 ${ALIAS_MAX}개까지입니다.`);
  return out;
}

function cleanFields(type, v) {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw new ArchiveError(400, '칸 내용은 {칸: 내용} 모양으로 보내 주세요.');
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    const def = FIELDS[type].find((f) => f.key === key);
    if (!def) throw new ArchiveError(400, `'${key}'은(는) 이 종류에 없는 칸입니다.`);
    const x = def.kind === 'line' ? (value == null ? '' : cleanText(value, LINE_MAX, def.label).replace(/\s+/g, ' ')) : cleanText(value, TEXT_MAX, def.label);
    if (x) out[key] = x;
  }
  return out;
}

function cleanExtra(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ArchiveError(400, '추가 칸은 목록으로 보내 주세요.');
  const out = [];
  for (const x of v) {
    if (!isObject(x)) throw new ArchiveError(400, '추가 칸은 {label, value} 모양입니다.');
    const value = cleanText(x.value, TEXT_MAX, '추가 칸 내용');
    const label = typeof x.label === 'string' ? x.label.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
    if (!label && !value) continue;
    if (!label) throw new ArchiveError(400, '추가 칸에 이름을 붙여 주세요.');
    if (label.length > EXTRA_LABEL) throw new ArchiveError(400, `추가 칸 이름은 ${EXTRA_LABEL}자까지입니다.`);
    out.push({ label, value });
  }
  if (out.length > EXTRA_MAX) throw new ArchiveError(400, `추가 칸은 ${EXTRA_MAX}개까지입니다.`);
  return out;
}

/** Sources after a hand edit: every field (and the memo) whose text the person changed is marked manual. */
function markManual(sources, before, after) {
  const out = { ...sources };
  const keys = new Set([...Object.keys(before.fields || {}), ...Object.keys(after.fields || {})]);
  for (const k of keys) {
    const a = (after.fields || {})[k] || '';
    if (a === ((before.fields || {})[k] || '')) continue;
    if (a) out[k] = 'manual';
    else delete out[k];
  }
  if ((after.description || '') !== (before.description || '')) {
    if (after.description) out.description = 'manual';
    else delete out.description;
  }
  for (const k of Object.keys(out)) if (k !== 'description' && !(after.fields || {})[k]) delete out[k];
  return out;
}

function cleanBudget(v) {
  if (v === undefined || v === null) return BUDGET_DEFAULT;
  if (!Number.isSafeInteger(v) || v < BUDGET_MIN || v > BUDGET_MAX) {
    throw new ArchiveError(400, `프롬프트에 넣을 글자 수는 ${BUDGET_MIN}~${BUDGET_MAX} 사이여야 합니다.`);
  }
  return v;
}

/** A world's automatic-update settings. connectionId is a Marinara connection id; null means none chosen yet. */
function cleanAuto(v, base = defaultAuto()) {
  if (!isObject(v)) throw new ArchiveError(400, '자동 반영 설정을 {enabled, connectionId, every} 모양으로 보내 주세요.');
  const out = { ...base };
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') throw new ArchiveError(400, 'enabled는 true 또는 false입니다.');
    out.enabled = v.enabled;
  }
  if (v.connectionId !== undefined) {
    if (v.connectionId !== null && (typeof v.connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.connectionId))) {
      throw new ArchiveError(400, '연결 ID가 올바르지 않습니다.');
    }
    out.connectionId = v.connectionId;
  }
  if (v.every !== undefined) {
    if (!Number.isSafeInteger(v.every) || v.every < AUTO_EVERY.min || v.every > AUTO_EVERY.max) {
      throw new ArchiveError(400, `읽는 간격은 메시지 ${AUTO_EVERY.min}~${AUTO_EVERY.max}개입니다.`);
    }
    out.every = v.every;
  }
  return out;
}
const defaultAuto = () => ({ enabled: false, connectionId: null, every: AUTO_EVERY.default });

function needId(id, what = '세계관') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ArchiveError(400, `${what} ID가 올바르지 않습니다.`);
  return id;
}

function needRoom(id) {
  if (typeof id !== 'string' || !ROOM_RE.test(id)) throw new ArchiveError(400, '채팅방 ID가 올바르지 않습니다.');
  return id;
}

function needRevision(r) {
  if (!Number.isSafeInteger(r) || r < 1) throw new ArchiveError(400, 'revision이 필요합니다. 목록을 새로 불러와 주세요.');
  return r;
}

const broken = (what) => new ArchiveError(409, `${what} 파일이 손상됐거나 이 버전이 모르는 형식입니다. 덮어쓰지 않았습니다.`);

function validWorld(w) {
  return (
    isObject(w) &&
    typeof w.worldId === 'string' &&
    ID_RE.test(w.worldId) &&
    typeof w.name === 'string' &&
    typeof w.description === 'string' &&
    Number.isSafeInteger(w.injectChars) &&
    (w.auto === undefined || isObject(w.auto)) &&
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
    (e.fields === undefined || (isObject(e.fields) && Object.values(e.fields).every((v) => typeof v === 'string'))) &&
    (e.extra === undefined ||
      (Array.isArray(e.extra) && e.extra.every((x) => isObject(x) && typeof x.label === 'string' && typeof x.value === 'string'))) &&
    (e.sources === undefined || (isObject(e.sources) && Object.values(e.sources).every((v) => SOURCES.includes(v)))) &&
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
    this.historyDir = path.join(this.dir, 'history');
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
    if (Buffer.byteLength(raw, 'utf8') > FILE_MAX) throw new ArchiveError(409, `${what} 파일이 너무 큽니다. 덮어쓰지 않았습니다.`);
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

  readEntitiesRaw(worldId) {
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

  readEntities(worldId) {
    const doc = this.readEntitiesRaw(worldId);
    // Settings saved before fields existed read as having none.
    for (const e of doc.entities) {
      if (e.fields === undefined) e.fields = {};
      if (e.extra === undefined) e.extra = [];
      if (e.sources === undefined) e.sources = {};
    }
    return doc;
  }

  // ---------------------------------------------------------------- worlds

  listWorlds() {
    return this.readWorlds().worlds.map((w) => ({ ...w, auto: { ...defaultAuto(), ...(w.auto || {}) } }));
  }

  getWorld(worldId) {
    needId(worldId);
    const w = this.listWorlds().find((x) => x.worldId === worldId);
    if (!w) throw new ArchiveError(404, '세계관을 찾지 못했습니다.');
    return w;
  }

  createWorld(body = {}) {
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const name = cleanLine(body.name, NAME_MAX, '세계관 이름');
    const description = cleanText(body.description, DESC_MAX, '세계관 설명');
    const injectChars = cleanBudget(body.injectChars);
    const doc = this.readWorlds();
    const t = now();
    const auto = body.auto === undefined ? defaultAuto() : cleanAuto(body.auto);
    const world = { worldId: randomUUID(), name, description, injectChars, auto, revision: 1, createdAt: t, updatedAt: t };
    doc.worlds.push(world);
    this.writeJson(this.worldsFile, doc);
    return world;
  }

  updateWorld(worldId, body = {}) {
    needId(worldId);
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const revision = needRevision(body.revision);
    const doc = this.readWorlds();
    const world = doc.worlds.find((x) => x.worldId === worldId);
    if (!world) throw new ArchiveError(404, '세계관을 찾지 못했습니다.');
    if (world.revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
    const next = { ...world };
    let changed = false;
    if (body.name !== undefined) (next.name = cleanLine(body.name, NAME_MAX, '세계관 이름')), (changed = true);
    if (body.description !== undefined) (next.description = cleanText(body.description, DESC_MAX, '세계관 설명')), (changed = true);
    if (body.injectChars !== undefined) (next.injectChars = cleanBudget(body.injectChars)), (changed = true);
    if (body.auto !== undefined) (next.auto = cleanAuto(body.auto, { ...defaultAuto(), ...(world.auto || {}) })), (changed = true);
    if (!changed) throw new ArchiveError(400, '고칠 내용이 없습니다.');
    next.revision++;
    next.updatedAt = now();
    Object.assign(world, next);
    this.writeJson(this.worldsFile, doc);
    return this.getWorld(worldId);
  }

  /** The world, its settings and its room links go to trash/<worldId>-<time>/ — nothing is lost for good. */
  deleteWorld(worldId, revision) {
    needId(worldId);
    needRevision(revision);
    const doc = this.readWorlds();
    const index = doc.worlds.findIndex((x) => x.worldId === worldId);
    if (index < 0) throw new ArchiveError(404, '세계관을 찾지 못했습니다.');
    if (doc.worlds[index].revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
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

  /** Counts per kind, for the overview. */
  countEntities(worldId) {
    const out = Object.fromEntries(TYPES.map((t) => [t, 0]));
    for (const e of this.readEntities(worldId).entities) out[e.type]++;
    return out;
  }

  entityInput(body, base) {
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const out = { ...base };
    if (body.type !== undefined || !base) {
      if (!TYPES.includes(body.type)) throw new ArchiveError(400, `종류는 ${TYPES.join(', ')} 중 하나여야 합니다.`);
      out.type = body.type;
    }
    if (body.name !== undefined || !base) out.name = cleanLine(body.name, NAME_MAX, '이름');
    if (body.aliases !== undefined || !base) out.aliases = cleanAliases(body.aliases, out.name);
    else if (body.name !== undefined) out.aliases = cleanAliases(out.aliases, out.name);
    if (body.description !== undefined || !base) out.description = cleanText(body.description, DESC_MAX, '설명');
    if (body.fields !== undefined || !base) out.fields = cleanFields(out.type, body.fields);
    else if (body.type !== undefined) {
      // kind changed without new fields: keep only the fields the new kind also has
      const keep = Object.fromEntries(Object.entries(out.fields || {}).filter(([k]) => FIELDS[out.type].some((f) => f.key === k)));
      out.fields = keep;
    }
    if (body.extra !== undefined || !base) out.extra = cleanExtra(body.extra);
    if (body.pinned !== undefined || !base) {
      if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new ArchiveError(400, 'pinned는 true 또는 false입니다.');
      out.pinned = body.pinned === true;
    }
    return out;
  }

  createEntity(worldId, body = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    if (doc.entities.length >= ENTITY_MAX) throw new ArchiveError(400, `한 세계관에는 설정을 ${ENTITY_MAX}개까지 넣을 수 있습니다.`);
    const input = this.entityInput(body, null);
    const t = now();
    const entity = {
      entityId: randomUUID(),
      ...input,
      sources: markManual({}, {}, input),
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
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const revision = needRevision(body.revision);
    const doc = this.readEntities(worldId);
    const entity = doc.entities.find((x) => x.entityId === entityId);
    if (!entity) throw new ArchiveError(404, '설정을 찾지 못했습니다.');
    if (entity.revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
    const { revision: _r, ...rest } = body;
    if (!Object.keys(rest).length) throw new ArchiveError(400, '고칠 내용이 없습니다.');
    const next = this.entityInput(rest, entity);
    // What the person changed by hand becomes theirs: automatic updates never write over it again.
    next.sources = markManual(entity.sources || {}, entity, next);
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
    if (index < 0) throw new ArchiveError(404, '설정을 찾지 못했습니다.');
    if (doc.entities[index].revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
    doc.entities.splice(index, 1);
    this.writeJson(this.entityFile(worldId), doc);
    return { deleted: true, entityId };
  }

  // ---------------------------------------------------------------- automatic updates

  historyFile(worldId) {
    return path.join(this.historyDir, `${needId(worldId)}.json`);
  }

  readHistory(worldId) {
    return this.readJson(
      this.historyFile(worldId),
      () => ({ schemaVersion: SCHEMA, worldId, changes: [] }),
      (d) => d.worldId === worldId && Array.isArray(d.changes) && d.changes.every((c) => isObject(c) && typeof c.id === 'string'),
      '변경 기록',
    );
  }

  listHistory(worldId, limit = 200) {
    this.getWorld(worldId);
    return this.readHistory(worldId).changes.slice(-limit).reverse();
  }

  /**
   * Writes what the reader found. items: [{ type, name, aliases, fields, memo, evidence, match? }] already checked
   * against the source text. meta: { roomId, messageIds }. Never writes over what the person typed:
   *   - an unknown name becomes a new setting (source auto);
   *   - an empty field is filled; a field the reader filled before is replaced by the newer statement;
   *   - a field the person wrote (source manual) is left alone;
   *   - new other names are added; the memo is written only while it is empty.
   * Every change goes to the world's history so it can be undone one by one.
   */
  applyAuto(worldId, items, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const history = this.readHistory(worldId);
    const t = now();
    const changes = [];
    const log = (c) => changes.push({ id: randomUUID(), at: t, roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], ...c });
    const norm = (x) => String(x || '').normalize('NFC').trim().toLowerCase();
    const findEntity = (item) => {
      const keys = new Set([item.match, item.name, ...(item.aliases || [])].filter(Boolean).map(norm));
      const hit = (e) => [e.name, ...e.aliases].some((n) => keys.has(norm(n)));
      return doc.entities.find((e) => e.type === item.type && hit(e)) || doc.entities.find(hit) || null;
    };
    for (const raw of items) {
      if (!isObject(raw) || !TYPES.includes(raw.type)) continue;
      let name;
      try {
        name = cleanLine(raw.name, NAME_MAX, '이름');
      } catch {
        continue;
      }
      const item = { ...raw, name };
      let fields = {};
      try {
        fields = cleanFields(item.type, Object.fromEntries(Object.entries(isObject(item.fields) ? item.fields : {}).filter(([k, v]) => FIELDS[item.type].some((f) => f.key === k) && typeof v === 'string')));
      } catch {
        fields = {};
      }
      let memo = '';
      try {
        memo = cleanText(typeof item.memo === 'string' ? item.memo : '', DESC_MAX, '메모');
      } catch {}
      let aliases = [];
      try {
        aliases = cleanAliases(Array.isArray(item.aliases) ? item.aliases.filter((a) => typeof a === 'string' && a.trim()).slice(0, ALIAS_MAX) : [], name);
      } catch {}
      const evidence = typeof item.evidence === 'string' ? item.evidence.slice(0, 300) : '';
      const found = findEntity({ ...item, aliases });
      if (!found) {
        if (doc.entities.length >= ENTITY_MAX) continue;
        const entity = {
          entityId: randomUUID(),
          type: item.type,
          name,
          aliases,
          description: memo,
          fields,
          extra: [],
          pinned: false,
          sources: Object.fromEntries([...Object.keys(fields).map((k) => [k, 'auto']), ...(memo ? [['description', 'auto']] : [])]),
          status: 'confirmed',
          provenance: { source: 'auto', roomId: meta.roomId ?? null, evidence },
          revision: 1,
          createdAt: t,
          updatedAt: t,
        };
        doc.entities.push(entity);
        log({ entityId: entity.entityId, name, type: item.type, action: 'create', evidence });
        continue;
      }
      const e = found;
      e.sources = e.sources || {};
      let touched = false;
      for (const [key, value] of Object.entries(fields)) {
        if (e.type !== item.type && !FIELDS[e.type].some((f) => f.key === key)) continue;
        const before = e.fields[key] || '';
        if (before === value || e.sources[key] === 'manual') continue;
        if (before && !e.sources[key]) continue; // written before sources were kept: treat as the person's
        e.fields[key] = value;
        e.sources[key] = 'auto';
        touched = true;
        const said = isObject(item.fieldEvidence) && typeof item.fieldEvidence[key] === 'string' ? item.fieldEvidence[key].slice(0, 300) : evidence;
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'field', key, before, after: value, evidence: said });
      }
      const known = new Set([e.name, ...e.aliases].map(norm));
      for (const a of [name, ...aliases]) {
        if (known.has(norm(a)) || e.aliases.length >= ALIAS_MAX) continue;
        e.aliases.push(a);
        known.add(norm(a));
        touched = true;
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'alias', after: a, evidence });
      }
      if (memo && !e.description) {
        e.description = memo;
        e.sources.description = 'auto';
        touched = true;
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'memo', before: '', after: memo, evidence });
      }
      if (touched) {
        e.revision++;
        e.updatedAt = t;
      }
    }
    if (!changes.length) return [];
    this.writeJson(this.entityFile(worldId), doc);
    history.changes.push(...changes);
    if (history.changes.length > HISTORY_MAX) history.changes.splice(0, history.changes.length - HISTORY_MAX);
    this.writeJson(this.historyFile(worldId), history);
    return changes;
  }

  /** Undoes one automatic change, only while what it wrote is still there untouched. */
  undoChange(worldId, changeId) {
    this.getWorld(worldId);
    const history = this.readHistory(worldId);
    const c = history.changes.find((x) => x.id === changeId);
    if (!c) throw new ArchiveError(404, '그 기록을 찾지 못했습니다.');
    if (c.undoneAt) throw new ArchiveError(409, '이미 되돌린 기록입니다.');
    const doc = this.readEntities(worldId);
    const index = doc.entities.findIndex((e) => e.entityId === c.entityId);
    const e = doc.entities[index];
    const later = '그 뒤에 다시 바뀌어서 되돌리지 않았습니다. 설정에서 직접 고쳐 주세요.';
    if (c.action === 'create') {
      if (!e) throw new ArchiveError(409, '이미 지워진 설정입니다.');
      if (Object.values(e.sources || {}).includes('manual')) throw new ArchiveError(409, '직접 고친 칸이 있는 설정이라 지우지 않았습니다. 지우려면 설정에서 지워 주세요.');
      // Removing the setting would also throw away what was read into it afterwards: undo those first.
      const after = history.changes.slice(history.changes.indexOf(c) + 1).filter((x) => x.entityId === c.entityId && !x.undoneAt).length;
      if (after) throw new ArchiveError(409, `그 뒤 자동으로 ${after}번 바뀌었어요. 최근 기록부터 되돌리거나 설정에서 지워 주세요.`);
      doc.entities.splice(index, 1);
    } else {
      if (!e) throw new ArchiveError(409, '이미 지워진 설정입니다.');
      if (c.action === 'field' || c.action === 'memo') {
        const key = c.action === 'memo' ? 'description' : c.key;
        const current = key === 'description' ? e.description : e.fields[key] || '';
        if (current !== c.after) throw new ArchiveError(409, later);
        if (key === 'description') e.description = c.before || '';
        else if (c.before) e.fields[key] = c.before;
        else delete e.fields[key];
        if (c.before) e.sources[key] = 'auto';
        else delete e.sources[key];
      } else if (c.action === 'alias') {
        const i = e.aliases.indexOf(c.after);
        if (i < 0) throw new ArchiveError(409, later);
        e.aliases.splice(i, 1);
      }
      e.revision++;
      e.updatedAt = now();
    }
    this.writeJson(this.entityFile(worldId), doc);
    c.undoneAt = now();
    this.writeJson(this.historyFile(worldId), history);
    return { undone: true, changeId };
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
    return { roomId, worldId: exists ? link.worldId : null, linkedAt: link.linkedAt, read: link.read || null };
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
    if (rooms.rooms[roomId]?.worldId === worldId) return this.getRoom(roomId); // same world: keep how far it was read
    rooms.rooms[roomId] = { worldId, linkedAt: now() };
    this.writeJson(this.roomsFile, rooms);
    return { roomId, worldId, linkedAt: rooms.rooms[roomId].linkedAt };
  }

  /** How far the automatic reader got in a room: { lastId, count } of the last message it read. */
  /** read null forgets how far the room was read (「처음부터 다시 읽기」); the settings stay as they are. */
  setRoomRead(roomId, read) {
    needRoom(roomId);
    const rooms = this.readRooms();
    if (!rooms.rooms[roomId]) return;
    if (read === null) delete rooms.rooms[roomId].read;
    else rooms.rooms[roomId].read = { lastId: read.lastId ?? null, count: read.count, at: now() };
    this.writeJson(this.roomsFile, rooms);
  }

  /** A branch of a linked room reads the same world. Never replaces a link the new room already has. */
  inheritRoom(fromRoomId, toRoomId) {
    if (!ROOM_RE.test(fromRoomId || '') || !ROOM_RE.test(toRoomId || '')) return false;
    const rooms = this.readRooms();
    const link = rooms.rooms[fromRoomId];
    if (!link || rooms.rooms[toRoomId]) return false;
    rooms.rooms[toRoomId] = {
      worldId: link.worldId,
      linkedAt: now(),
      branchedFrom: fromRoomId,
      // a branch copies the messages up to its start under new ids: what was read is counted, not named
      ...(link.read ? { read: { lastId: null, count: link.read.count, at: link.read.at } } : {}),
    };
    this.writeJson(this.roomsFile, rooms);
    return true;
  }
}

module.exports = {
  Archive,
  ArchiveError,
  SCHEMA,
  TYPES,
  FIELDS,
  BUDGET_DEFAULT,
  BUDGET_MIN,
  BUDGET_MAX,
  ROOM_RE,
  AUTO_EVERY,
};
