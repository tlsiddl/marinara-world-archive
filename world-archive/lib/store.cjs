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
const { findPairs, describedPairs } = require('./same.cjs');
const N = require('./names.cjs');

const SCHEMA = 1;
const NAME_MAX = 120;
const DESC_MAX = 4000;
const ALIAS_MAX = 20;
const ALIAS_LEN = 60;
const ENTITY_MAX = 2000;
const FILE_MAX = 8 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TYPES = ['person', 'place', 'group', 'rule', 'system', 'schedule', 'history', 'custom'];
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
  // rule: what must be obeyed. system: how the world works (magic, abilities, economy, points).
  rule: [{ key: 'category', label: '분류', kind: 'line', hint: '법, 제도, 관례, 금기, 학교 규칙 같은 것' }],
  system: [
    { key: 'category', label: '분류', kind: 'line', hint: '마법, 능력, 경제, 점수 같은 것' },
    { key: 'how', label: '작동 방식', kind: 'text' },
    { key: 'limits', label: '제약·대가', kind: 'text' },
  ],
  schedule: [
    { key: 'when', label: '언제·주기', kind: 'line' },
    { key: 'where', label: '어디서', kind: 'line' },
    { key: 'who', label: '누가', kind: 'line' },
  ],
  // history: what happened before the story began (the world's timeline). Events of the story itself are the
  // Memory Module's.
  history: [
    { key: 'when', label: '시기', kind: 'line' },
    { key: 'where', label: '장소', kind: 'line' },
    { key: 'who', label: '관련 인물·집단', kind: 'line' },
    { key: 'result', label: '결과·영향', kind: 'text' },
  ],
  custom: [],
};
const BUDGET_MIN = 300;
const BUDGET_MAX = 20000;
const BUDGET_DEFAULT = 3000;
const AUTO_EVERY = { min: 2, max: 50, default: 6 };
const HISTORY_MAX = 1000;
const SOURCES = ['manual', 'auto'];
const INJECT_MODES = ['all', 'scene'];
/** Relations between two settings (사령탑 할 일 3). Matched as an unordered pair + kind. */
const REL_TYPES = ['가족', '소속', '친구', '적대', '연인', '스승·제자', '위치', '기타'];
const REL_MAX = 5000;
const REL_NOTE = 300;
const relKey = (r) => [r.from, r.to].sort().join('|') + '|' + r.type;
/** 「가스파르의 5학년 누나」: a person named by description (someone's relative), not by a name of their own. */
const isDescriptiveName = (n) => /의\s/.test(String(n || ''));
/** 「그리핀도르 1학년 무리」, 「학생들」: a crowd, not a person. */
const isGroupName = (n) => /(무리|일행|들)$/.test(String(n || '').trim());
const squashName = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/[\s"'“”‘’·,.()]+/g, '');
/** Whether a text names a setting: its name, another name, or one of the name's words (2+ letters). */
function mentions(text, e) {
  const t = squashName(text);
  if (!t || !e) return false;
  const names = [e.name, ...(e.aliases || [])];
  const parts = names.flatMap((n) => [n, ...String(n).split(/[\s.]+/)]).map(squashName).filter((k) => k.length >= 2);
  return parts.some((k) => t.includes(k));
}
/**
 * Which kinds of settings a relation from the reader may join: 위치 two places, 소속 a person and a group, the people
 * kinds two people (적대·친구 also groups), 기타 any two named settings except a person and a place.
 */
function relationFits(type, a, b) {
  const both = (...k) => k.includes(a) && k.includes(b);
  if (type === '위치') return a === 'place' && b === 'place';
  if (type === '소속') return (a === 'person' && b === 'group') || (a === 'group' && b === 'person');
  if (type === '적대' || type === '친구') return both('person', 'group');
  if (type === '기타') return both('person', 'place', 'group') && !((a === 'person' && b === 'place') || (a === 'place' && b === 'person'));
  return a === 'person' && b === 'person';
}
function validRelation(r) {
  return (
    r !== null && typeof r === 'object' && typeof r.relationId === 'string' && ID_RE.test(r.from || '') && ID_RE.test(r.to || '') &&
    r.from !== r.to && REL_TYPES.includes(r.type) && typeof r.note === 'string' && SOURCES.includes(r.source)
  );
}
function cleanMode(v) {
  if (v === undefined) return 'all';
  if (!INJECT_MODES.includes(v)) throw new ArchiveError(400, `넣는 방식은 ${INJECT_MODES.join(', ')} 중 하나입니다.`);
  return v;
}

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
  // the name: marked manual once the person renames (see updateEntity); it has no field of its own
  for (const k of Object.keys(out)) if (k !== 'description' && k !== 'name' && !(after.fields || {})[k]) delete out[k];
  return out;
}

/**
 * keep with drop folded in (nothing saved). The kept name stays; the other's name and other names become other
 * names (up to ALIAS_MAX). Empty fields are filled from drop. A field the person wrote on keep is never replaced;
 * a field the person wrote on drop replaces only an empty or automatic one on keep. A different memo is added
 * below. A field written before sources were kept (no source) counts as the person's, as in applyAuto.
 */
function mergeInto(keep, drop) {
  const mine = (sources, k, value) => !!value && sources[k] !== 'auto';
  const ds = drop.sources || {};
  const sources = { ...(keep.sources || {}) };
  const fields = { ...(keep.fields || {}) };
  for (const def of FIELDS[keep.type]) {
    const k = def.key;
    const dv = (drop.fields || {})[k] || '';
    if (!dv) continue;
    const kv = fields[k] || '';
    if (!kv) {
      fields[k] = dv;
      if (ds[k]) sources[k] = ds[k];
      else delete sources[k];
    } else if (!mine(sources, k, kv) && mine(ds, k, dv)) {
      fields[k] = dv;
      sources[k] = 'manual';
    }
  }
  let description = keep.description || '';
  const dd = drop.description || '';
  if (dd && !description) {
    description = dd;
    if (ds.description) sources.description = ds.description;
    else delete sources.description;
  } else if (dd && !description.includes(dd)) {
    description = `${description}\n\n${dd}`.slice(0, DESC_MAX);
    if (sources.description === 'auto' && ds.description !== 'auto') sources.description = 'manual';
  }
  for (const k of Object.keys(sources)) if (k !== 'name' && (k === 'description' ? !description : !fields[k])) delete sources[k];
  const aliases = [...keep.aliases];
  const seen = new Set([keep.name, ...aliases].map((a) => a.toLowerCase()));
  for (const a of [drop.name, ...drop.aliases]) {
    if (aliases.length >= ALIAS_MAX) break;
    if (seen.has(a.toLowerCase()) || a.length > ALIAS_LEN) continue;
    aliases.push(a);
    seen.add(a.toLowerCase());
  }
  const extra = [...(keep.extra || [])];
  for (const x of drop.extra || []) {
    if (extra.length >= EXTRA_MAX) break;
    if (!extra.some((y) => y.label === x.label && y.value === x.value)) extra.push({ ...x });
  }
  const merged = [...(keep.provenance?.merged || []), { entityId: drop.entityId, name: drop.name, source: drop.provenance?.source ?? null }].slice(-ALIAS_MAX);
  return { ...keep, aliases, fields, sources, description, extra, pinned: keep.pinned || drop.pinned, provenance: { ...keep.provenance, merged } };
}

const pairKey = (a, b) => [a, b].sort().join('|');
const DISMISS_MAX = 5000;

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
    (w.injectMode === undefined || INJECT_MODES.includes(w.injectMode)) &&
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
    this.dismissDir = path.join(this.dir, 'dismissed');
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
        if (d.relations !== undefined && !(Array.isArray(d.relations) && d.relations.every(validRelation))) return false;
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
    if (doc.relations === undefined) doc.relations = [];
    return doc;
  }

  // ---------------------------------------------------------------- worlds

  listWorlds() {
    return this.readWorlds().worlds.map((w) => ({ ...w, injectMode: w.injectMode || 'all', auto: { ...defaultAuto(), ...(w.auto || {}) } }));
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
    const injectMode = cleanMode(body.injectMode);
    const world = { worldId: randomUUID(), name, description, injectChars, injectMode, auto, revision: 1, createdAt: t, updatedAt: t };
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
    if (body.injectMode !== undefined) (next.injectMode = cleanMode(body.injectMode)), (changed = true);
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
    // A name the person typed is theirs too: the glossary only suggests its own form from then on.
    if (next.name !== entity.name) {
      next.sources.name = 'manual';
      delete next.glossaryName;
      delete entity.glossaryName;
    }
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
    const [gone] = doc.entities.splice(index, 1);
    // Its relations go with it; the history keeps both so 되돌리기 brings them back together.
    const relations = doc.relations.filter((r) => r.from === entityId || r.to === entityId);
    doc.relations = doc.relations.filter((r) => r.from !== entityId && r.to !== entityId);
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, [{ id: randomUUID(), at: now(), by: 'person', roomId: null, messageIds: [], entityId, name: gone.name, type: gone.type, action: 'delete', entity: structuredClone(gone), index, relations }]);
    return { deleted: true, entityId, relations: relations.length };
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

  pushHistory(worldId, changes) {
    if (!changes.length) return;
    const history = this.readHistory(worldId);
    history.changes.push(...changes);
    if (history.changes.length > HISTORY_MAX) history.changes.splice(0, history.changes.length - HISTORY_MAX);
    this.writeJson(this.historyFile(worldId), history);
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
    const by = typeof meta.by === 'string' && /^[a-z0-9-]{1,40}$/.test(meta.by) ? meta.by : 'reader';
    const log = (c) => changes.push({ id: randomUUID(), at: t, by, roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], ...c });
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
          provenance: { source: 'auto', by, roomId: meta.roomId ?? null, evidence },
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
    if (c.action === 'merge') {
      // Both come back as they were before the merge, only while the kept one is still exactly as the merge left it.
      if (!e) throw new ArchiveError(409, '합친 설정이 지워져서 되돌리지 않았습니다.');
      if (e.revision !== c.afterRevision) throw new ArchiveError(409, '합친 뒤에 다시 바뀌어서 되돌리지 않았습니다. 설정에서 직접 고쳐 주세요.');
      if (!validEntity(c.before) || !validEntity(c.dropped) || c.before.entityId !== e.entityId) throw broken('변경 기록');
      if (doc.entities.some((x) => x.entityId === c.dropped.entityId)) throw new ArchiveError(409, '합쳐진 설정이 이미 따로 있습니다.');
      if (doc.entities.length >= ENTITY_MAX) throw new ArchiveError(409, `설정이 ${ENTITY_MAX}개라 되살릴 자리가 없습니다.`);
      // The kept one's revision moves on (never back), so a screen still holding the merged one cannot write over it.
      doc.entities[index] = { ...structuredClone(c.before), revision: e.revision + 1, updatedAt: now() };
      const at = Number.isSafeInteger(c.dropIndex) ? Math.min(Math.max(c.dropIndex, 0), doc.entities.length) : doc.entities.length;
      doc.entities.splice(at, 0, structuredClone(c.dropped));
      if (Array.isArray(c.relationsBefore)) {
        const touched = (r) => [r.from, r.to].some((x) => x === c.entityId || x === c.dropId);
        doc.relations = doc.relations.filter((r) => !touched(r)).concat(c.relationsBefore.filter(validRelation).map((r) => structuredClone(r)));
      }
    } else if (c.action === 'retype') {
      if (!e) throw new ArchiveError(409, '이미 지워진 설정입니다.');
      if (e.revision !== c.afterRevision) throw new ArchiveError(409, later);
      if (!validEntity(c.before)) throw broken('변경 기록');
      doc.entities[index] = { ...structuredClone(c.before), revision: e.revision + 1, updatedAt: now() };
      const have = new Set(doc.relations.map(relKey));
      const ids = new Set(doc.entities.map((x) => x.entityId));
      for (const r of c.relations || []) if (validRelation(r) && ids.has(r.from) && ids.has(r.to) && !have.has(relKey(r))) doc.relations.push(structuredClone(r));
    } else if (c.action === 'relation-add' || c.action === 'relation-note' || c.action === 'relation-remove') {
      this.undoRelation(doc, c, later);
    } else if (c.action === 'delete') {
      if (!validEntity(c.entity)) throw broken('변경 기록');
      if (doc.entities.some((x) => x.entityId === c.entity.entityId)) throw new ArchiveError(409, '그 설정이 이미 있습니다.');
      if (doc.entities.length >= ENTITY_MAX) throw new ArchiveError(409, '설정이 ' + ENTITY_MAX + '개라 되살릴 자리가 없습니다.');
      const at = Number.isSafeInteger(c.index) ? Math.min(Math.max(c.index, 0), doc.entities.length) : doc.entities.length;
      doc.entities.splice(at, 0, structuredClone(c.entity));
      const ids = new Set(doc.entities.map((x) => x.entityId));
      const have = new Set(doc.relations.map(relKey));
      for (const r of c.relations || []) if (validRelation(r) && ids.has(r.from) && ids.has(r.to) && !have.has(relKey(r))) doc.relations.push(structuredClone(r));
    } else if (c.action === 'create') {
      if (!e) throw new ArchiveError(409, '이미 지워진 설정입니다.');
      if (Object.values(e.sources || {}).includes('manual')) throw new ArchiveError(409, '직접 고친 칸이 있는 설정이라 지우지 않았습니다. 지우려면 설정에서 지워 주세요.');
      // Removing the setting would also throw away what was read into it afterwards: undo those first.
      const after = history.changes.slice(history.changes.indexOf(c) + 1).filter((x) => (x.entityId === c.entityId || x.entityIds?.includes(c.entityId)) && !x.undoneAt).length;
      if (after) throw new ArchiveError(409, `그 뒤 자동으로 ${after}번 바뀌었어요. 최근 기록부터 되돌리거나 설정에서 지워 주세요.`);
      doc.entities.splice(index, 1);
      doc.relations = doc.relations.filter((r) => r.from !== c.entityId && r.to !== c.entityId);
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
      } else if (c.action === 'rename') {
        // The old name comes back and is kept as the person's choice (nameKept): the glossary's form is then only a
        // suggestion, so the next reading does not rename it again. (Not a manual source: undoing 'create' still works.)
        if (e.name !== c.after) throw new ArchiveError(409, later);
        e.name = c.before;
        const added = new Set(c.addedAliases || []);
        e.aliases = e.aliases.filter((a) => !added.has(a) && a.toLowerCase() !== e.name.toLowerCase());
        for (const a of c.removedAliases || []) if (!e.aliases.includes(a) && e.aliases.length < ALIAS_MAX) e.aliases.push(a);
        e.nameKept = true;
        e.glossaryName = c.after;
      }
      e.revision++;
      e.updatedAt = now();
    }
    this.writeJson(this.entityFile(worldId), doc);
    c.undoneAt = now();
    this.writeJson(this.historyFile(worldId), history);
    return { undone: true, changeId };
  }

  // ---------------------------------------------------------------- names from the translation glossary

  /**
   * Brings names in line with the room's glossary pairs ([{ from, to }], from vendor/glossary.cjs). ids: only these
   * settings (after a reading), or all when omitted (the glossary changed). A person, place or group whose whole name
   * is a pair (names.cjs matchFor: its name, or its longest romanized other name, is the pair's romanized side) gets
   * the glossary's Korean as its name and the original form among its other names; that is a 'rename' in the
   * history, undoable like the rest. Never a rename to a part of the name it has; a one-word pair of a name of several
   * words only adds other names ('alias'). A name the person chose is not renamed: the setting carries
   * glossaryName (shown as a suggestion) instead. When another setting already has the glossary's name, both stay as
   * they are (「같은 사람일 수 있음」 shows them). Returns the changes.
   */
  alignGlossary(worldId, pairs, meta = {}) {
    this.getWorld(worldId);
    if (!Array.isArray(pairs)) return [];
    const doc = this.readEntities(worldId);
    const history = this.readHistory(worldId); // a broken history file stops this before anything is written
    const t = now();
    const changes = [];
    const only = meta.ids ? new Set(meta.ids) : null;
    let dirty = false;
    const log = (c) => changes.push({ id: randomUUID(), at: t, by: 'glossary', roomId: meta.roomId ?? null, messageIds: [], ...c });
    for (const e of doc.entities) {
      if (only && !only.has(e.entityId)) continue;
      const m = N.matchFor(e, pairs);
      const p = m?.full;
      if (!p) {
        if (e.glossaryName) {
          delete e.glossaryName; // the glossary no longer names it
          dirty = true;
        }
        if (!m?.short.length) continue;
        // a one-word pair of a name of several words (a given name, a nickname): other names only, never the name
        const taken = new Set(doc.entities.filter((o) => o !== e).map((o) => N.key(o.name)));
        let added = 0;
        for (const sp of m.short) {
          for (const a of N.shortAliases(e, sp, taken, { aliasMax: ALIAS_MAX, aliasLen: ALIAS_LEN })) {
            e.aliases.push(a);
            log({ entityId: e.entityId, name: e.name, type: e.type, action: 'alias', after: a, evidence: `번역 단어장: ${sp.from} = ${sp.to}` });
            added++;
          }
        }
        if (added) {
          e.revision++;
          e.updatedAt = t;
          dirty = true;
        }
        continue;
      }
      const taken = new Set(doc.entities.filter((o) => o !== e).map((o) => N.key(o.name)));
      const plan = N.planFor(e, p, taken, { aliasMax: ALIAS_MAX, aliasLen: ALIAS_LEN });
      const evidence = `번역 단어장: ${p.from} = ${p.to}`;
      if (plan?.suggest) {
        if (e.glossaryName !== plan.suggest) (e.glossaryName = plan.suggest), (dirty = true);
        continue;
      }
      if (e.glossaryName && (e.name === p.to || plan?.rename)) {
        delete e.glossaryName;
        dirty = true;
      }
      if (plan?.alias) {
        e.aliases.push(plan.alias);
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'alias', after: plan.alias, evidence });
      } else if (plan?.rename) {
        const before = e.name;
        e.name = plan.rename.name;
        e.aliases = plan.rename.aliases;
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'rename', before, after: e.name, addedAliases: plan.rename.added, removedAliases: plan.rename.removed, evidence });
      } else continue;
      e.revision++;
      e.updatedAt = t;
      dirty = true;
    }
    if (!dirty) return [];
    this.writeJson(this.entityFile(worldId), doc);
    if (changes.length) {
      history.changes.push(...changes);
      if (history.changes.length > HISTORY_MAX) history.changes.splice(0, history.changes.length - HISTORY_MAX);
      this.writeJson(this.historyFile(worldId), history);
    }
    return changes;
  }

  // ---------------------------------------------------------------- 같은 사람일 수 있음

  dismissFile(worldId) {
    return path.join(this.dismissDir, `${needId(worldId)}.json`);
  }

  /** Pairs the person said are two people (「다른 사람이에요」): { pairs: [{ a, b, at }] }. */
  readDismissed(worldId) {
    return this.readJson(
      this.dismissFile(worldId),
      () => ({ schemaVersion: SCHEMA, worldId, pairs: [] }),
      (d) => d.worldId === worldId && Array.isArray(d.pairs) && d.pairs.every((p) => isObject(p) && typeof p.a === 'string' && typeof p.b === 'string'),
      '다른 사람 표시',
    );
  }

  /** People who may be one person: [{ a, b, why }]. Only a suggestion; nothing is merged without mergeEntities. */
  listDuplicates(worldId) {
    this.getWorld(worldId);
    const gone = new Set(this.readDismissed(worldId).pairs.map((p) => pairKey(p.a, p.b)));
    const doc = this.readEntities(worldId);
    const skip = (a, b) => gone.has(pairKey(a, b));
    return [...findPairs(doc.entities, skip), ...describedPairs(doc.entities, doc.relations, skip)];
  }

  /** 「다른 사람이에요」: the pair is not suggested again (by id, so renaming either does not bring it back). */
  dismissPair(worldId, a, b) {
    this.getWorld(worldId);
    needId(a, '설정');
    needId(b, '설정');
    if (a === b) throw new ArchiveError(400, '서로 다른 두 설정을 골라 주세요.');
    const ids = new Set(this.readEntities(worldId).entities.map((e) => e.entityId));
    if (!ids.has(a) || !ids.has(b)) throw new ArchiveError(404, '설정을 찾지 못했습니다.');
    const doc = this.readDismissed(worldId);
    const key = pairKey(a, b);
    if (!doc.pairs.some((p) => pairKey(p.a, p.b) === key)) {
      const [x, y] = [a, b].sort();
      doc.pairs.push({ a: x, b: y, at: now() });
      if (doc.pairs.length > DISMISS_MAX) doc.pairs.splice(0, doc.pairs.length - DISMISS_MAX);
      this.writeJson(this.dismissFile(worldId), doc);
    }
    return { dismissed: true, a, b };
  }

  /**
   * Merges two settings the person said are one: body { keepId, dropId, keepRevision, dropRevision, preview? }.
   * How fields are folded together: mergeInto. The dropped one is removed. One history entry (action 'merge')
   * keeps the kept one as it was and the dropped one whole, so undoChange can bring both back. preview: true
   * returns the merged setting without saving anything.
   */
  mergeEntities(worldId, body = {}) {
    this.getWorld(worldId);
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const keepId = needId(body.keepId, '남길 설정');
    const dropId = needId(body.dropId, '합칠 설정');
    if (keepId === dropId) throw new ArchiveError(400, '서로 다른 두 설정을 골라 주세요.');
    const keepRevision = needRevision(body.keepRevision);
    const dropRevision = needRevision(body.dropRevision);
    const doc = this.readEntities(worldId);
    const keepIndex = doc.entities.findIndex((x) => x.entityId === keepId);
    const dropIndex = doc.entities.findIndex((x) => x.entityId === dropId);
    if (keepIndex < 0 || dropIndex < 0) throw new ArchiveError(404, '설정을 찾지 못했습니다.');
    const keep = doc.entities[keepIndex];
    const drop = doc.entities[dropIndex];
    if (keep.revision !== keepRevision || drop.revision !== dropRevision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
    if (keep.type !== drop.type) throw new ArchiveError(400, '같은 종류의 설정끼리만 합칠 수 있습니다.');
    const t = now();
    const merged = { ...mergeInto(keep, drop), revision: keep.revision + 1, updatedAt: t };
    if (body.preview === true) return merged;
    const history = this.readHistory(worldId);
    const before = structuredClone(keep);
    const dropped = structuredClone(drop);
    doc.entities[keepIndex] = merged;
    doc.entities.splice(dropIndex, 1);
    // Relations follow the kept setting: the dropped one's are pointed at it (no self-links, no doubles).
    const relationsBefore = structuredClone(doc.relations.filter((r) => [r.from, r.to].some((x) => x === keepId || x === dropId)));
    const seen = new Set();
    const moved = [];
    for (const r of doc.relations) {
      const n = { ...r, from: r.from === dropId ? keepId : r.from, to: r.to === dropId ? keepId : r.to };
      if (n.from === n.to || seen.has(relKey(n))) continue;
      seen.add(relKey(n));
      moved.push(n);
    }
    doc.relations = moved;
    this.writeJson(this.entityFile(worldId), doc);
    history.changes.push({
      id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [],
      entityId: keepId, name: merged.name, type: merged.type, action: 'merge',
      dropId, dropName: drop.name, before, dropped, dropIndex, afterRevision: merged.revision, relationsBefore,
    });
    if (history.changes.length > HISTORY_MAX) history.changes.splice(0, history.changes.length - HISTORY_MAX);
    this.writeJson(this.historyFile(worldId), history);
    return merged;
  }

  // ---------------------------------------------------------------- relations

  listRelations(worldId) {
    this.getWorld(worldId);
    return this.readEntities(worldId).relations;
  }

  /** The setting a name (or other name) belongs to, compared without spaces and case; null when none or unsure. */
  findByName(entities, name) {
    const key = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');
    const k = key(name);
    if (!k) return null;
    const hits = entities.filter((e) => [e.name, ...e.aliases].some((n) => key(n) === k));
    return hits.length === 1 ? hits[0] : hits.find((e) => key(e.name) === k) || null;
  }

  relationInput(doc, body, base) {
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const out = { ...base };
    for (const k of ['from', 'to']) {
      if (body[k] === undefined && base) continue;
      if (!doc.entities.some((e) => e.entityId === body[k])) throw new ArchiveError(400, '이을 설정을 찾지 못했습니다.');
      out[k] = body[k];
    }
    if (out.from === out.to) throw new ArchiveError(400, '서로 다른 두 설정을 골라 주세요.');
    if (body.type !== undefined || !base) {
      if (!REL_TYPES.includes(body.type)) throw new ArchiveError(400, '관계는 ' + REL_TYPES.join(', ') + ' 중 하나입니다.');
      out.type = body.type;
    }
    if (body.note !== undefined || !base) out.note = cleanText(body.note ?? '', REL_NOTE, '관계 메모');
    return out;
  }

  /** A relation the person adds (source manual: the reader never changes it). */
  createRelation(worldId, body = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    if (doc.relations.length >= REL_MAX) throw new ArchiveError(400, '관계는 ' + REL_MAX + '개까지 넣을 수 있습니다.');
    const t = now();
    const r = { relationId: randomUUID(), ...this.relationInput(doc, body, null), evidence: '', source: 'manual', createdAt: t, updatedAt: t };
    if (doc.relations.some((x) => relKey(x) === relKey(r))) throw new ArchiveError(409, '같은 관계가 이미 있습니다.');
    doc.relations.push(r);
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, [this.relationLog(doc, r, 'relation-add', 'person', {})]);
    return r;
  }

  updateRelation(worldId, relationId, body = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const r = doc.relations.find((x) => x.relationId === relationId);
    if (!r) throw new ArchiveError(404, '관계를 찾지 못했습니다.');
    const before = structuredClone(r);
    Object.assign(r, this.relationInput(doc, body, r), { source: 'manual', updatedAt: now() });
    if (doc.relations.some((x) => x !== r && relKey(x) === relKey(r))) throw new ArchiveError(409, '같은 관계가 이미 있습니다.');
    this.writeJson(this.entityFile(worldId), doc);
    if (before.note !== r.note && before.type === r.type) {
      this.pushHistory(worldId, [{ ...this.relationLog(doc, r, 'relation-note', 'person', {}), before: before.note, after: r.note }]);
    }
    return r;
  }

  deleteRelation(worldId, relationId) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const i = doc.relations.findIndex((x) => x.relationId === relationId);
    if (i < 0) throw new ArchiveError(404, '관계를 찾지 못했습니다.');
    const [r] = doc.relations.splice(i, 1);
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, [this.relationLog(doc, r, 'relation-remove', 'person', {})]);
    return { deleted: true, relationId };
  }

  relationLog(doc, r, action, by, meta) {
    const nameOf = (id) => doc.entities.find((e) => e.entityId === id)?.name || '';
    return {
      id: randomUUID(), at: now(), by, roomId: meta.roomId ?? null, messageIds: meta.messageIds || [],
      entityId: r.from, entityIds: [r.from, r.to], name: nameOf(r.from) + ' — ' + nameOf(r.to), type: 'relation', action,
      relation: structuredClone(r), evidence: r.evidence || '',
    };
  }

  /**
   * Relations the reader found, endpoints already resolved to ids: [{ from, to, type, note, was?, evidence }].
   * Both settings must exist. Same pair and kind: only the note is renewed. was (an earlier kind between the two that
   * has ended, e.g. 연인 → 헤어짐): that relation goes and the new note keeps 「과거에는 ○○」. The person's relations
   * (source manual) are never changed. Every change is in the history and can be undone.
   */
  applyRelations(worldId, rels, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const ids = new Set(doc.entities.map((e) => e.entityId));
    const by = typeof meta.by === 'string' && /^[a-z0-9-]{1,40}$/.test(meta.by) ? meta.by : 'reader';
    const changes = [];
    const t = now();
    for (const raw of Array.isArray(rels) ? rels : []) {
      if (!isObject(raw) || !ids.has(raw.from) || !ids.has(raw.to) || raw.from === raw.to || !REL_TYPES.includes(raw.type)) continue;
      let note = typeof raw.note === 'string' ? raw.note.trim().slice(0, REL_NOTE) : '';
      const evidence = typeof raw.evidence === 'string' ? raw.evidence.slice(0, 300) : '';
      if (REL_TYPES.includes(raw.was) && raw.was !== raw.type) {
        const old = doc.relations.find((x) => relKey(x) === relKey({ ...raw, type: raw.was }));
        if (old && old.source !== 'manual') {
          doc.relations.splice(doc.relations.indexOf(old), 1);
          changes.push(this.relationLog(doc, old, 'relation-remove', by, meta));
          const past = '과거에는 ' + raw.was;
          if (!note.includes(past)) note = (note ? note + ' · ' + past : past).slice(0, REL_NOTE);
        }
      }
      const same = doc.relations.find((x) => relKey(x) === relKey(raw));
      if (same) {
        if (same.source === 'manual' || !note || same.note === note) continue;
        changes.push({ ...this.relationLog(doc, same, 'relation-note', by, meta), before: same.note, after: note, evidence });
        same.note = note;
        if (evidence) same.evidence = evidence;
        same.updatedAt = t;
        continue;
      }
      if (doc.relations.length >= REL_MAX) continue;
      const r = { relationId: randomUUID(), from: raw.from, to: raw.to, type: raw.type, note, evidence, source: 'auto', createdAt: t, updatedAt: t };
      doc.relations.push(r);
      changes.push(this.relationLog(doc, r, 'relation-add', by, meta));
    }
    if (!changes.length) return [];
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return changes;
  }

  /**
   * 소속 칸 → 소속 관계, by code (no model): a person whose affiliation names a group of this world (its name or other
   * name, whole) gets a 소속 relation to it unless one exists. ids: only these people (all when omitted).
   */
  linkAffiliations(worldId, ids = null, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const squashed = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/[\s"'“”‘’·,.()]+/g, '');
    const groups = doc.entities.filter((e) => e.type === 'group');
    const exists = new Set(doc.relations.map(relKey));
    const found = [];
    for (const p of doc.entities) {
      if (p.type !== 'person' || (ids && !ids.includes(p.entityId))) continue;
      const text = squashed(p.fields?.affiliation);
      if (!text) continue;
      for (const g of groups) {
        if (!g.name || ![g.name, ...g.aliases].some((n) => squashed(n).length >= 2 && text.includes(squashed(n)))) continue;
        const r = { from: p.entityId, to: g.entityId, type: '소속', note: '', evidence: '소속: ' + p.fields.affiliation };
        if (!exists.has(relKey(r))) found.push(r);
      }
    }
    return this.applyRelations(worldId, found, { ...meta, by: meta.by || 'affiliation' });
  }

  /**
   * 무리를 인물로 잡은 것: a person whose name ends in 무리 · 일행 · ~들 becomes a group (by code). Fields a group does
   * not have are dropped, relations that no longer fit go; all of it is in one 'retype' history entry for 되돌리기.
   * A setting the person edited by hand is left alone. ids: only these (all when omitted).
   */
  convertGroups(worldId, ids = null, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const changes = [];
    const t = now();
    for (const e of doc.entities) {
      if (e.type !== 'person' || (ids && !ids.includes(e.entityId)) || !isGroupName(e.name)) continue;
      if (Object.values(e.sources || {}).includes('manual') || e.provenance?.source === 'manual') continue;
      const before = structuredClone(e);
      const keys = new Set(FIELDS.group.map((f) => f.key));
      e.type = 'group';
      e.fields = Object.fromEntries(Object.entries(e.fields || {}).filter(([k]) => keys.has(k)));
      e.sources = Object.fromEntries(Object.entries(e.sources || {}).filter(([k]) => k === 'description' || keys.has(k)));
      e.revision++;
      e.updatedAt = t;
      const typeOf = (id) => (id === e.entityId ? 'group' : doc.entities.find((x) => x.entityId === id)?.type);
      const gone = doc.relations.filter((r) => (r.from === e.entityId || r.to === e.entityId) && r.source !== 'manual' && !relationFits(r.type, typeOf(r.from), typeOf(r.to)));
      doc.relations = doc.relations.filter((r) => !gone.includes(r));
      changes.push({ id: randomUUID(), at: t, by: meta.by || 'retype', roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], entityId: e.entityId, name: e.name, type: 'group', action: 'retype', before, after: 'group', afterRevision: e.revision, relations: gone });
    }
    if (!changes.length) return [];
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return changes;
  }

  /**
   * The reader's relations checked again by code (no model): a relation whose kind does not fit its two settings,
   * that has a person named by description at either end, or whose evidence names neither setting, is removed
   * ('relation-remove', undoable). Relations from the 소속 칸 and the person's own are left as they are.
   */
  recheckRelations(worldId, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const byId = new Map(doc.entities.map((e) => [e.entityId, e]));
    const out = [];
    const keep = [];
    for (const r of doc.relations) {
      const a = byId.get(r.from);
      const b = byId.get(r.to);
      const model = r.source === 'auto' && !String(r.evidence || '').startsWith('소속:');
      const why = !model || !a || !b ? null
        : !relationFits(r.type, a.type, b.type) ? 'kind'
        : (a.type === 'person' && isDescriptiveName(a.name)) || (b.type === 'person' && isDescriptiveName(b.name)) ? 'described name'
        : !mentions(r.evidence, a) && !mentions(r.evidence, b) ? 'evidence names neither'
        : null;
      if (why) out.push({ r, why });
      else keep.push(r);
    }
    if (!out.length) return [];
    doc.relations = keep;
    this.writeJson(this.entityFile(worldId), doc);
    const changes = out.map(({ r, why }) => ({ ...this.relationLog(doc, r, 'relation-remove', meta.by || 'recheck', meta), why }));
    this.pushHistory(worldId, changes);
    return changes;
  }

  undoRelation(doc, c, later) {
    const r = c.relation;
    if (!validRelation(r)) throw broken('변경 기록');
    const cur = doc.relations.find((x) => x.relationId === r.relationId);
    if (c.action === 'relation-add') {
      if (!cur) throw new ArchiveError(409, '이미 지워진 관계입니다.');
      if (cur.type !== r.type || (c.by !== 'person' && (cur.source === 'manual' || cur.note !== r.note))) throw new ArchiveError(409, later);
      doc.relations.splice(doc.relations.indexOf(cur), 1);
    } else if (c.action === 'relation-note') {
      if (!cur || cur.note !== c.after) throw new ArchiveError(409, later);
      cur.note = c.before || '';
      cur.updatedAt = now();
    } else {
      if (cur || doc.relations.some((x) => relKey(x) === relKey(r))) throw new ArchiveError(409, '같은 관계가 이미 있습니다.');
      const ids = new Set(doc.entities.map((e) => e.entityId));
      if (!ids.has(r.from) || !ids.has(r.to)) throw new ArchiveError(409, '이을 설정이 지워져서 되돌리지 않았습니다.');
      doc.relations.push(structuredClone(r));
    }
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

  /** The hash of the glossary pairs last brought into this room's world (null: never; relinking forgets it). */
  roomGlossaryHash(roomId) {
    if (typeof roomId !== 'string' || !ROOM_RE.test(roomId)) return null;
    const h = this.readRooms().rooms[roomId]?.glossary?.hash;
    return typeof h === 'string' ? h : null;
  }

  setRoomGlossary(roomId, hash) {
    needRoom(roomId);
    const rooms = this.readRooms();
    if (!rooms.rooms[roomId]) return;
    rooms.rooms[roomId].glossary = { hash: String(hash), at: now() };
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
  REL_TYPES,
  relationFits,
  mentions,
  isDescriptiveName,
  isGroupName,
};
