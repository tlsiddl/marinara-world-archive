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
const { findPairs, describedPairs, speciesPairs, thingPairs } = require('./same.cjs');
const { rosterOf, ROLE_WORDS } = require('./roster.cjs');
const TT = require('./timetable.cjs');
const CAL = require('./calendar.cjs');
const N = require('./names.cjs');

const SCHEMA = 1;
const BACKUP_FORMAT = 'marinara-world-archive-backup';
/** 할 일 10: how many earlier values a field keeps (shown as 「이전: ○○」; never put in {{세계}}). */
const PAST_MAX = 3;
/** 할 일 11: a room's score events (the board's name and unit are the world's). */
const SCORE_MAX = 20000;
function validScoreEvent(e) {
  return isObject(e) && typeof e.eventId === 'string' && typeof e.target === 'string' && Number.isSafeInteger(e.delta) && SOURCES.includes(e.source);
}
function cleanScoreEvent(raw) {
  if (!isObject(raw)) return null;
  const target = typeof raw.target === 'string' ? raw.target.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  const delta = typeof raw.delta === 'string' && /^[+-]?\d+$/.test(raw.delta.trim()) ? Number(raw.delta.trim()) : raw.delta;
  if (!target || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return null;
  return {
    target, delta,
    reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : '',
    evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, 300) : '',
    messageId: typeof raw.messageId === 'string' ? raw.messageId : null,
    sentence: Number.isSafeInteger(raw.sentence) ? raw.sentence : null,
  };
}
/** The world's board: { name, unit } or null (no board: the reader does not look for points). */
function cleanBoard(v) {
  if (v === null) return null;
  if (!isObject(v)) throw new ArchiveError(400, '점수판은 {name, unit} 모양으로 보내 주세요.');
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 40) : '';
  if (!name) return null;
  return { name, unit: typeof v.unit === 'string' ? v.unit.trim().slice(0, 10) : '' };
}
const validPast = (v) => isObject(v) && Object.values(v).every((list) => Array.isArray(list) && list.every((x) => isObject(x) && typeof x.value === 'string'));
const validPending = (v) => isObject(v) && Object.values(v).every((x) => isObject(x) && typeof x.value === 'string');
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
    // 종: only a being that is not a person (고양이 · 부엉이 · 용). Empty means unknown, not "a person" (연동 v2).
    { key: 'species', label: '종', kind: 'line' },
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
    { key: 'layout', label: '배치·내부 구조', kind: 'text' },
    { key: 'access', label: '출입구·연결', kind: 'text' },
    { key: 'limits', label: '제약', kind: 'text' },
  ],
  group: [
    { key: 'kind', label: '종류', kind: 'line', hint: '가문, 학교, 기숙사, 조직 같은 것' },
    { key: 'members', label: '구성원', kind: 'text' },
    // v0.5.1 J: how many there are in all (「아홉 명」) — the 명단 shows 「이름 아는 사람 M명 / 전체 N명」
    { key: 'size', label: '전체 인원', kind: 'line' },
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
/** Kinds with a direction: from is the one inside / belonging / the pupil… (the others read the same both ways). */
const DIRECTED = new Set(['소속', '위치', '스승·제자']);
const REL_NOTE = 300;
const relKey = (r) => [r.from, r.to].sort().join('|') + '|' + r.type;
/** 「가스파르의 5학년 누나」: a person named by description (someone's relative), not by a name of their own. */
const isDescriptiveName = (n) => /의\s/.test(String(n || ''));
/** 「그리핀도르 1학년 무리」, 「학생들」: a crowd, not a person. */
const isGroupName = (n) => /(무리|일행|들)$/.test(String(n || '').trim());
const squashName = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/[\s"'“”‘’·,.()]+/g, '');
/** What a longer group name may add and still be the same group, not one inside it (「슬리데린 기숙사」 is 「슬리데린」). */
const SAME_GROUP_SUFFIX = new Set(['기숙사', '가문', '집안', '일가', '학교', '마법학교', '학원', '기사단', '조직', '무리', '일행', 'house', 'family', 'school']);
/** A squashed group name without such an ending (「슬리데린기숙사」 → 「슬리데린」); itself when nothing of 2+ letters is left. */
const groupCore = (k) => {
  for (const suf of SAME_GROUP_SUFFIX) if (k.endsWith(suf) && k.length - suf.length >= 2) return k.slice(0, -suf.length);
  return k;
};
const groupKeys = (g) => [...new Set([g.name, ...(g.aliases || [])].map(squashName).flatMap((k) => [k, groupCore(k)]))].filter((k) => k.length >= 2);
/** Whether a 소속 text names a group: its name or other name, or that without 「기숙사」 · 「무리」…, whole, without spaces. */
const namesGroup = (text, g) => {
  const t = squashName(text);
  return Boolean(t && g?.name) && groupKeys(g).some((k) => t.includes(k));
};
/** Two group names for the same group (「슬리데린」 · 「슬리데린 기숙사」 · 「그리핀도르 1학년 무리」 ~ 「그리핀도르 1학년」). */
const sameGroupName = (name, g) => { const k = squashName(name); return groupKeys(g).some((x) => x === k || x === groupCore(k)); };
/** A 소속 piece that reads as a group: a year, a house, a family, a club… (not 「교수」 · 「부교장」 · 「주인」). */
const GROUPISH = /(학년|기숙사|가문|집안|반|동아리|클럽|길드|기사단|협회|조합|교단|무리|일행|여학생|남학생|학생회|연구회|부대|분대|소대)$/;
const KEEP_AS_IS = new Set(['rule', 'system', 'schedule', 'history', 'custom']);
/** 적용되는 곳 (v0.5.0 C): rules and systems can hold in one place or group; empty is the whole world. */
const APPLIES_TYPES = new Set(['rule', 'system']);
const APPLIES_TO = new Set(['place', 'group']);
/** 적용되는 곳 「세계 전체」 (v0.5.0 D); none at all is 「모름」. */
const WORLD = 'world';
/** An other name of a group that names a place: what its 본거지 can be made from (v0.5.0 E). */
const PLACE_ALIAS = /(성|궁|궁전|저택|본관|건물|캠퍼스|교정|castle|manor|palace|hall|campus|tower)$/i;
/** Words after a place's name that say near it, not in it (「검은 호수 아래」 · 「리키 콜드런 뒷문 너머」). */
const NOT_INSIDE = /(아래|밑|옆|근처|부근|너머|건너편|맞은편|바깥|밖|떨어진|가는 길|위쪽|아랫|기슭)/;
/** A building: underground under it is still in it (v0.5.0 E). */
const BUILDING = /(성|궁|궁전|저택|본관|건물|탑|별관|관|castle|manor|palace|hall|tower)$/i;
/** Words of English names that say nothing about who it is ("Hogwarts School of Witchcraft and Wizardry"). */
const NAME_FILLER = new Set(['the', 'and', 'of', 'for', 'with', 'from', 'into', 'house', 'school', 'family', 'lady', 'lord', 'miss', 'mister', 'mrs', 'mr', 'sir', 'madam', 'madame', 'professor', 'young', 'little', 'your', 'grace', 'head']);
/**
 * Whether a text names a setting: its whole name or another name, or one of their words — a Korean word of 2+ letters,
 * a word in Latin letters of 4+ letters that is not a filler word.
 */
function mentions(text, e) {
  const t = squashName(text);
  if (!t || !e) return false;
  const names = [e.name, ...(e.aliases || [])];
  const whole = names.map(squashName).filter((k) => k.length >= 2);
  const words = names.flatMap((n) => String(n).split(/[\s.,'’-]+/)).map((w) => w.normalize('NFC').toLowerCase()).filter((w) => {
    if (/^[a-z]+$/.test(w)) return w.length >= 4 && !NAME_FILLER.has(w);
    return w.length >= 2 && /\p{Script=Hangul}/u.test(w);
  });
  return [...whole, ...words].some((k) => t.includes(squashName(k)));
}
/**
 * Which kinds of settings a relation from the reader may join: 위치 two places, 소속 a person and a group (or a smaller group in a bigger one; A→B and B→A are the same pair, so no loop), the people
 * kinds two people (적대·친구 also groups), 기타 any two named settings except a person and a place.
 */
function relationFits(type, a, b) {
  const both = (...k) => k.includes(a) && k.includes(b);
  if (type === '위치') return a === 'place' && b === 'place';
  if (type === '소속') return (a === 'person' && b === 'group') || (a === 'group' && b === 'person') || (a === 'group' && b === 'group'); // 집단 → 집단: from is the smaller one (a crowd in a house)
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

/**
 * Whether an other name is a name, not a piece of a sentence (v0.5.0 O): 「Professor Snape pulls the bolt back」 ·
 * 「oil the pivot pin」 · 「Kneazles know when someone's lying」 are not; 「Hogwarts School of Witchcraft and Wizardry」 ·
 * 「the dungeons」 · 「Madam Malkin's Robes for All Occasions」 are.
 */
const NAME_FUNC = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'de', 'du', 'da', 'del', 'di', 'van', 'von', 'le', 'la', 'des', 'since', 'with', 'from', 'by', 'or']);
function nameLike(alias) {
  const a = String(alias || '').trim();
  if (!a) return false;
  if (/["“”「」『』]/.test(a)) return false;
  const latin = /^[A-Za-z0-9]/.test(a) && !/[가-힣]/.test(a);
  const words = a.split(/\s+/);
  if (!latin) return words.length <= 5 && !/[.!?…。]$/.test(a);
  if (/[!?…]$/.test(a) || (/\.$/.test(a) && !/(?:^|\s|\.)[A-Z]\.$/.test(a))) return false;
  if (/,/.test(a)) return false;
  const lower = words.filter((w) => /^[a-z]/.test(w) && !NAME_FUNC.has(w.toLowerCase()));
  if (lower.length >= 3) return false;
  // a verb before its object: 「pulls the bolt」 · 「register every litter」
  if (/\b(?!of\b|in\b|on\b|at\b|to\b|for\b|with\b|from\b|by\b|into\b|under\b|over\b|and\b|or\b)[a-z]{2,}\s+(the|a|an|every|his|her|its|their|my|your|our)\s/.test(a + ' ') && !/^the\s/i.test(a)) return false;
  if (words.length > 5 && lower.length >= 2) return false;
  return true;
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
    (w.scoreboard === undefined || w.scoreboard === null || (isObject(w.scoreboard) && typeof w.scoreboard.name === 'string')) &&
    (w.auto === undefined || isObject(w.auto)) &&
    (w.yearStart === undefined || (Number.isInteger(w.yearStart) && w.yearStart >= 1 && w.yearStart <= 12)) &&
    (w.nameStyle === undefined || ['auto', 'ko', 'original'].includes(w.nameStyle)) &&
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
    (e.past === undefined || validPast(e.past)) &&
    (e.pending === undefined || validPending(e.pending)) &&
    (e.timetable === undefined || TT.validTimetable(e.timetable)) &&
    (e.calendar === undefined || CAL.validCalendar(e.calendar)) &&
    (e.nameCheck === undefined || isObject(e.nameCheck)) &&
    (e.hidden === undefined || (isObject(e.hidden) && Object.values(e.hidden).every((v) => v === true))) &&
    (e.rumors === undefined || (isObject(e.rumors) && Object.values(e.rumors).every((r) => isObject(r) && typeof r.value === 'string'))) &&
    (e.base === undefined || e.base === null || (typeof e.base === 'string' && ID_RE.test(e.base))) &&
    (e.maybe === undefined || (Array.isArray(e.maybe) && e.maybe.every((m) => isObject(m) && typeof m.id === 'string'))) &&
    (e.room === undefined || e.room === null || (typeof e.room === 'string' && ID_RE.test(e.room))) &&
    (e.appliesTo === undefined || e.appliesTo === null || e.appliesTo === WORLD || (typeof e.appliesTo === 'string' && ID_RE.test(e.appliesTo))) &&
    (e.pastInPrompt === undefined || (isObject(e.pastInPrompt) && Object.values(e.pastInPrompt).every((v) => typeof v === 'boolean'))) &&
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
    this.scoreDir = path.join(this.dir, 'scores');
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
    const scoreboard = body.scoreboard === undefined ? null : cleanBoard(body.scoreboard);
    const world = { worldId: randomUUID(), name, description, injectChars, injectMode, scoreboard, auto, revision: 1, createdAt: t, updatedAt: t };
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
    if (body.scoreboard !== undefined) (next.scoreboard = cleanBoard(body.scoreboard)), (changed = true);
    if (body.auto !== undefined) (next.auto = cleanAuto(body.auto, { ...defaultAuto(), ...(world.auto || {}) })), (changed = true);
    // v0.5.0 K: the month a school year starts (학년도); 2) how names are written in {{세계}} (auto · ko · original)
    if (body.yearStart !== undefined) {
      if (!Number.isInteger(body.yearStart) || body.yearStart < 1 || body.yearStart > 12) throw new ArchiveError(400, '학년도 시작 달은 1~12입니다.');
      next.yearStart = body.yearStart;
      changed = true;
    }
    if (body.nameStyle !== undefined) {
      if (!['auto', 'ko', 'original'].includes(body.nameStyle)) throw new ArchiveError(400, '이름 표기는 auto · ko · original 중 하나입니다.');
      next.nameStyle = body.nameStyle;
      changed = true;
    }
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
    // 할 일 10 (사령탑 추가): per field, put the earlier value into {{세계}} too — 「(과거: ○○)」. Off by default.
    if (body.pastInPrompt !== undefined) {
      if (!isObject(body.pastInPrompt) || !Object.values(body.pastInPrompt).every((v) => typeof v === 'boolean')) throw new ArchiveError(400, 'pastInPrompt는 {칸: true/false}입니다.');
      out.pastInPrompt = Object.fromEntries(Object.entries(body.pastInPrompt).filter(([, v]) => v));
    }
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
    // 할 일 5: what the person does by hand is in the history too, and can be undone.
    this.pushHistory(worldId, [{ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId: entity.entityId, name: entity.name, type: entity.type, action: 'create' }]);
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
    if (JSON.stringify(next.aliases) !== JSON.stringify(entity.aliases)) next.sources.aliases = 'manual'; // v0.5.0 O: kept by 「관계 다시 보기」
    // A name the person typed is theirs too: the glossary only suggests its own form from then on.
    if (next.name !== entity.name) {
      delete next.nameCheck; // v0.5.0 R: the person named them
      delete entity.nameCheck;
      next.sources.name = 'manual';
      delete next.glossaryName;
      delete entity.glossaryName;
    }
    const before = structuredClone(entity);
    if (entity.pending && next.fields) {
      for (const k of Object.keys(entity.pending)) if ((next.fields[k] || '') !== (entity.fields?.[k] || '')) delete entity.pending[k];
    }
    Object.assign(entity, next, { revision: entity.revision + 1, updatedAt: now() });
    if (entity.hidden) {
      for (const k of Object.keys(entity.hidden)) if ((before.fields || {})[k] !== (entity.fields || {})[k]) delete entity.hidden[k];
      if (!Object.keys(entity.hidden).length) delete entity.hidden;
    }
    this.writeJson(this.entityFile(worldId), doc);
    const keys = [...new Set([...Object.keys(before.fields || {}), ...Object.keys(entity.fields || {})])].filter((k) => (before.fields || {})[k] !== (entity.fields || {})[k]);
    for (const k of ['name', 'type', 'description', 'pinned']) if (JSON.stringify(before[k]) !== JSON.stringify(entity[k])) keys.push(k);
    if (JSON.stringify(before.aliases) !== JSON.stringify(entity.aliases)) keys.push('aliases');
    if (JSON.stringify(before.extra) !== JSON.stringify(entity.extra)) keys.push('extra');
    this.pushHistory(worldId, [{ id: randomUUID(), at: entity.updatedAt, by: 'person', roomId: null, messageIds: [], entityId, name: entity.name, type: entity.type, action: 'edit', keys, before, afterRevision: entity.revision }]);
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
    let anyTouched = false;
    const log = (c) => changes.push({ id: randomUUID(), at: t, by, roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], ...c });
    const norm = (x) => String(x || '').normalize('NFC').trim().toLowerCase();
    const findEntity = (item) => {
      const keys = new Set([item.match, item.name, ...(item.aliases || [])].filter(Boolean).map(norm));
      const hit = (e) => [e.name, ...e.aliases].some((n) => keys.has(norm(n)));
      // v0.5.0 C: the same name for a rule · system that holds in another place or group is another one
      const sameWhere = (e) => !APPLIES_TYPES.has(item.type) || !item.appliesTo || !e.appliesTo || e.appliesTo === item.appliesTo;
      return doc.entities.find((e) => e.type === item.type && hit(e) && sameWhere(e)) || (APPLIES_TYPES.has(item.type) && item.appliesTo ? null : doc.entities.find(hit)) || null;
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
        aliases = cleanAliases(Array.isArray(item.aliases) ? item.aliases.filter((a) => typeof a === 'string' && a.trim() && nameLike(a)).slice(0, ALIAS_MAX) : [], name);
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
        // v0.5.0 R: a described name the sentence does not back
        if (isObject(item.nameCheck) && typeof item.nameCheck.said === 'string') entity.nameCheck = { said: item.nameCheck.said.slice(0, 60) };
        // v0.5.0 L: rumours of a new setting
        const rum = isObject(item.rumors) ? Object.entries(item.rumors).filter(([k, r]) => isObject(r) && typeof r.value === 'string' && r.value.trim() && FIELDS[item.type].some((f) => f.key === k)) : [];
        if (rum.length) entity.rumors = Object.fromEntries(rum.map(([k, r]) => [k, { value: r.value.slice(0, 300), by: String(r.by || '소문').slice(0, 40), evidence: String(r.evidence || '').slice(0, 300), at: t }]));
        // v0.5.0 S: fields only a profile block says
        const hid = isObject(item.hidden) ? Object.keys(item.hidden).filter((k) => item.hidden[k] === true && entity.fields[k]) : [];
        if (hid.length) entity.hidden = Object.fromEntries(hid.map((k) => [k, true]));
        if (APPLIES_TYPES.has(item.type) && item.appliesTo && (item.appliesTo === WORLD || doc.entities.some((x) => x.entityId === item.appliesTo && APPLIES_TO.has(x.type)))) {
          entity.appliesTo = item.appliesTo;
          entity.sources.appliesTo = 'auto';
        }
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
        const said = isObject(item.fieldEvidence) && typeof item.fieldEvidence[key] === 'string' ? item.fieldEvidence[key].slice(0, 300) : evidence;
        // v0.5.0 G · S: what only a profile block says fills an empty field only, marked 「아직 드러나지 않음」; the story
        // saying it later takes the mark off (recorded)
        const fromBlock = isObject(item.hidden) && item.hidden[key] === true;
        if (fromBlock && before) continue;
        if (!fromBlock && e.hidden?.[key]) {
          delete e.hidden[key];
          if (!Object.keys(e.hidden).length) delete e.hidden;
          touched = true;
          log({ entityId: e.entityId, name: e.name, type: e.type, action: 'reveal', key, before: '', after: before === value ? value : value, evidence: said });
        }
        if (before === value) {
          if (e.pending?.[key]) (delete e.pending[key], (touched = true)); // the story came back to what the person wrote
          continue;
        }
        // The person's own field is never written over: the story's newer value waits as 「대화에서는 ○○가 됐어요 [적용]」.
        if (e.sources[key] === 'manual' || (before && !e.sources[key])) {
          if (e.pending?.[key]?.value !== value) {
            e.pending = { ...(e.pending || {}), [key]: { value, evidence: said, at: t } };
            touched = true;
          }
          continue;
        }
        // 실시간 반영: the newer value replaces the old one; the old one is kept below as 「이전: ○○」 — not for a
        // correction (v0.5.0 M: it was wrong, so it is not 「이전」; 기록 says 정정됨).
        const corrected = isObject(item.corrections) && item.corrections[key] === true;
        if (before && !corrected) e.past = { ...(e.past || {}), [key]: [{ value: before, until: t, evidence: said }, ...((e.past || {})[key] || [])].slice(0, PAST_MAX) };
        e.fields[key] = value;
        e.sources[key] = 'auto';
        if (fromBlock) e.hidden = { ...(e.hidden || {}), [key]: true };
        touched = true;
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'field', key, before, after: value, evidence: said, ...(fromBlock ? { hidden: true } : {}), ...(corrected && before ? { correction: true } : {}) });
        // a rumour the story now says as a fact goes
        if (e.rumors?.[key] && e.rumors[key].value === value) { delete e.rumors[key]; if (!Object.keys(e.rumors).length) delete e.rumors; }
      }
      // v0.5.0 L: what someone says — 「확인 안 됨 · ○○의 말」, beside the fact, never over it
      for (const [key, r] of Object.entries(isObject(item.rumors) ? item.rumors : {})) {
        if (!isObject(r) || typeof r.value !== 'string' || !r.value.trim() || !FIELDS[e.type].some((f) => f.key === key)) continue;
        if ((e.fields[key] || '') === r.value || e.rumors?.[key]?.value === r.value) continue;
        const prev = e.rumors?.[key] || null;
        e.rumors = { ...(e.rumors || {}), [key]: { value: r.value.slice(0, 300), by: String(r.by || '소문').slice(0, 40), evidence: String(r.evidence || '').slice(0, 300), at: t } };
        touched = true;
        log({ entityId: e.entityId, name: e.name, type: e.type, action: 'rumor', key, before: prev?.value || '', after: r.value, by2: r.by, prevRumor: prev, evidence: r.evidence || '' });
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
        anyTouched = true;
        e.revision++;
        e.updatedAt = t;
      }
    }
    if (!changes.length) {
      if (anyTouched) this.writeJson(this.entityFile(worldId), doc); // only waiting values (pending) changed
      return [];
    }
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
    } else if (c.action === 'edit') {
      if (!e) throw new ArchiveError(409, '이미 지워진 설정입니다.');
      if (e.revision !== c.afterRevision) throw new ArchiveError(409, later);
      if (!validEntity(c.before)) throw broken('변경 기록');
      doc.entities[index] = { ...structuredClone(c.before), revision: e.revision + 1, updatedAt: now() };
    } else if (c.action === 'retype') {
      if (!e) throw new ArchiveError(409, '이미 지워진 설정입니다.');
      if (e.revision !== c.afterRevision) throw new ArchiveError(409, later);
      if (!validEntity(c.before)) throw broken('변경 기록');
      doc.entities[index] = { ...structuredClone(c.before), revision: e.revision + 1, updatedAt: now() };
      const have = new Set(doc.relations.map(relKey));
      const ids = new Set(doc.entities.map((x) => x.entityId));
      for (const r of c.relations || []) if (validRelation(r) && ids.has(r.from) && ids.has(r.to) && !have.has(relKey(r))) doc.relations.push(structuredClone(r));
    } else if (c.action === 'relation-add' || c.action === 'relation-note' || c.action === 'relation-remove' || c.action === 'relation-flip') {
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
      if (c.by !== 'person' && Object.values(e.sources || {}).includes('manual')) throw new ArchiveError(409, '직접 고친 칸이 있는 설정이라 지우지 않았습니다. 지우려면 설정에서 지워 주세요.');
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
        if (key !== 'description' && e.past?.[key]?.[0]?.value === c.before) {
          e.past[key] = e.past[key].slice(1);
          if (!e.past[key].length) delete e.past[key];
        }
        if (c.before) e.sources[key] = c.by === 'person' && key !== 'description' ? 'manual' : 'auto'; // undoing [적용]: the person's value again
        else delete e.sources[key];
      } else if (c.action === 'rumor') {
        if (e.rumors?.[c.key]?.value !== c.after) throw new ArchiveError(409, later);
        if (c.prevRumor) e.rumors[c.key] = structuredClone(c.prevRumor);
        else { delete e.rumors[c.key]; if (!Object.keys(e.rumors).length) delete e.rumors; }
      } else if (c.action === 'reveal') {
        e.hidden = { ...(e.hidden || {}), [c.key]: true };
      } else if (c.action === 'room') {
        if ((e.room || null) !== (c.after || null)) throw new ArchiveError(409, later);
        if (c.before) e.room = c.before; else delete e.room;
        if (c.roomPast) e.roomPast = structuredClone(c.roomPast); else delete e.roomPast;
        if (c.by === 'person') delete e.sources?.room;
      } else if (c.action === 'base') {
        if ((e.base || null) !== (c.after || null)) throw new ArchiveError(409, later);
        if (c.before) e.base = c.before; else delete e.base;
        if (c.by === 'person') delete e.sources?.base;
      } else if (c.action === 'applies') {
        if ((e.appliesTo || null) !== (c.after || null)) throw new ArchiveError(409, later);
        if (c.before) e.appliesTo = c.before; else delete e.appliesTo;
        if (c.by === 'person') delete e.sources?.appliesTo;
      } else if (c.action === 'event') {
        const events = e.calendar?.events;
        if (!events) throw new ArchiveError(409, later);
        const cur = c.eventId ? events[c.eventId] || null : null;
        if (JSON.stringify(cur) !== JSON.stringify(c.after)) throw new ArchiveError(409, later);
        if (c.before) events[c.before.id] = structuredClone(c.before);
        else if (c.eventId) delete events[c.eventId];
      } else if (c.action === 'event-pending') {
        const ev = e.calendar?.events?.[c.eventId];
        if (ev?.pending) delete ev.pending;
      } else if (c.action === 'cell') {
        // a 시간표 cell back as it was, only while it still holds what this change wrote
        const cells = e.timetable?.cells;
        if (!cells) throw new ArchiveError(409, later);
        if ((cells[c.key]?.value || '') !== (c.after || '')) throw new ArchiveError(409, later);
        if (c.cellBefore) cells[c.key] = structuredClone(c.cellBefore);
        else delete cells[c.key];
        TT.refresh(e);
      } else if (c.action === 'cell-pending') {
        const cell = e.timetable?.cells?.[c.key];
        if (cell?.pending?.value === c.after) delete cell.pending;
      } else if (c.action === 'alias-remove') {
        if (!e.aliases.includes(c.alias) && e.aliases.length < ALIAS_MAX) e.aliases.push(c.alias);
      } else if (c.action === 'alias-move') {
        // the other name goes back to the setting it was taken from (and leaves the one it went to, when that one is not new)
        const went = c.toId && doc.entities.find((x) => x.entityId === c.toId);
        if (went) went.aliases = went.aliases.filter((x) => x !== c.alias);
        if (!e.aliases.includes(c.alias)) {
          if (e.aliases.length >= ALIAS_MAX) throw new ArchiveError(409, later);
          e.aliases.push(c.alias);
        }
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

  // ---------------------------------------------------------------- 장소 위치 · 본거지 (v0.5.0 E)

  /**
   * A group's 본거지 (base): the place it is at (은사슴 기숙사 → 별시계탑 아래 기숙사 건물). Like 적용되는 곳: the
   * reader's and the buttons' value never goes over the person's; recorded ('base', undoable). placeId null: none.
   */
  setBase(worldId, groupId, placeId, meta = {}, { force = false } = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const g = doc.entities.find((x) => x.entityId === groupId && x.type === 'group');
    if (!g) throw new ArchiveError(404, '집단을 찾지 못했습니다.');
    if (placeId != null && !doc.entities.some((x) => x.entityId === placeId && x.type === 'place')) throw new ArchiveError(400, '본거지는 장소여야 합니다.');
    if (!force && g.sources?.base === 'manual') return null;
    const before = g.base || null;
    const after = placeId || null;
    if (before === after && !(force && g.sources?.base !== 'manual')) return null;
    if (after) g.base = after; else delete g.base;
    g.sources = { ...(g.sources || {}) };
    if (force) g.sources.base = 'manual';
    else if (after) g.sources.base = 'auto';
    else delete g.sources.base;
    g.revision++;
    g.updatedAt = now();
    this.writeJson(this.entityFile(worldId), doc);
    const nameOf = (id) => doc.entities.find((x) => x.entityId === id)?.name || '';
    const c = { id: randomUUID(), at: g.updatedAt, by: force ? 'person' : meta.by || 'reader', roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], entityId: groupId, entityIds: [groupId, after || before].filter(Boolean), name: g.name, type: 'group', action: 'base', before, after, beforeName: nameOf(before), afterName: nameOf(after), evidence: meta.evidence || '' };
    this.pushHistory(worldId, [c]);
    return c;
  }

  /**
   * v0.5.1 I: a person's 지내는 곳 (방 배정 · 숙소) — the place they stay now. Only the current one counts: a new one
   * takes its place and the one before is kept as 「이전」 (roomPast, up to 3). Like 본거지: the reader's value never goes
   * over the person's; recorded ('room', undoable). placeId null: none.
   */
  setRoom(worldId, personId, placeId, meta = {}, { force = false } = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const p = doc.entities.find((x) => x.entityId === personId && x.type === 'person');
    if (!p) throw new ArchiveError(404, '인물을 찾지 못했습니다.');
    if (placeId != null && !doc.entities.some((x) => x.entityId === placeId && x.type === 'place')) throw new ArchiveError(400, '지내는 곳은 장소여야 합니다.');
    if (!force && p.sources?.room === 'manual') return null;
    const before = p.room || null;
    const after = placeId || null;
    if (before === after && !(force && p.sources?.room !== 'manual')) return null;
    const roomPast = p.roomPast ? structuredClone(p.roomPast) : null;
    if (before && before !== after) p.roomPast = [{ placeId: before, until: now() }, ...(p.roomPast || []).filter((x) => x.placeId !== before && x.placeId !== after)].slice(0, 3);
    if (after) p.room = after; else delete p.room;
    p.sources = { ...(p.sources || {}) };
    if (force) p.sources.room = 'manual';
    else if (after) p.sources.room = 'auto';
    else delete p.sources.room;
    p.revision++;
    p.updatedAt = now();
    this.writeJson(this.entityFile(worldId), doc);
    const nameOf = (id) => doc.entities.find((x) => x.entityId === id)?.name || '';
    const c = { id: randomUUID(), at: p.updatedAt, by: force ? 'person' : meta.by || 'reader', roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], entityId: personId, entityIds: [personId, after || before].filter(Boolean), name: p.name, type: 'person', action: 'room', before, after, beforeName: nameOf(before), afterName: nameOf(after), roomPast, evidence: meta.evidence || '' };
    this.pushHistory(worldId, [c]);
    return c;
  }

  /**
   * The place a group stands for, to put places in: its 본거지, or — when it has none — a place made from one of its
   * other names that names a place (「호그와트 성」 · 「Hogwarts Castle」 of 「호그와트 마법학교」): that place is made
   * (auto, recorded), those names move to it ('alias-move') and it becomes the 본거지. null when there is none.
   */
  basePlace(worldId, groupId, meta = {}) {
    const doc = this.readEntities(worldId);
    const g = doc.entities.find((x) => x.entityId === groupId && x.type === 'group');
    if (!g) return null;
    if (g.base && doc.entities.some((x) => x.entityId === g.base && x.type === 'place')) return g.base;
    const placeish = (g.aliases || []).filter((a) => PLACE_ALIAS.test(String(a).trim()));
    const ko = placeish.find((a) => /\p{Script=Hangul}/u.test(a)) || placeish[0];
    if (!ko || doc.entities.length >= ENTITY_MAX) return null;
    const t = now();
    const by = meta.by || 'location-fill';
    const place = {
      entityId: randomUUID(), type: 'place', name: ko, aliases: placeish.filter((a) => a !== ko), description: '', fields: {}, extra: [], pinned: false,
      sources: {}, status: 'confirmed', provenance: { source: 'auto', by, roomId: null, evidence: '「' + g.name + '」의 다른 이름' }, revision: 1, createdAt: t, updatedAt: t,
    };
    doc.entities.push(place);
    g.aliases = g.aliases.filter((a) => !placeish.includes(a));
    g.revision++;
    g.updatedAt = t;
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, [
      { id: randomUUID(), at: t, by, roomId: null, messageIds: [], entityId: place.entityId, name: place.name, type: 'place', action: 'create', evidence: place.provenance.evidence },
      ...placeish.map((a) => ({ id: randomUUID(), at: t, by, roomId: null, messageIds: [], entityId: g.entityId, entityIds: [g.entityId, place.entityId], name: g.name, type: 'group', action: 'alias-move', alias: a, to: place.name })),
    ]);
    this.setBase(worldId, g.entityId, place.entityId, { by, evidence: place.provenance.evidence });
    return place.entityId;
  }

  /**
   * 장소 위치, by code (no model): a place with no place around it yet whose 「위치·소속」 칸 begins with another
   * place's name (or a group's — then the group's 본거지) is in that place (「호그와트 지하, 옛 회랑 너머」 → 호그와트
   * 지하). Not when the words after the name say beside, under, beyond … (「검은 호수 아래」 is not in the lake).
   * Returns { relations: changes, left: [place ids still alone] }.
   */
  linkPlaces(worldId, meta = {}) {
    this.getWorld(worldId);
    const by = meta.by || 'location-fill';
    const insideOf = (doc) => new Set(doc.relations.filter((r) => r.type === '위치').map((r) => r.from));
    let doc = this.readEntities(worldId);
    const found = [];
    for (const p of doc.entities.filter((e) => e.type === 'place' && !insideOf(doc).has(e.entityId))) {
      const seg = String(p.fields?.location || '').split(/[,，;]/)[0].trim();
      if (!seg) continue;
      const k = squashName(seg);
      let best = null;
      for (const o of doc.entities) {
        if (o.entityId === p.entityId || (o.type !== 'place' && o.type !== 'group')) continue;
        for (const n of [o.name, ...(o.aliases || [])]) {
          const nk = squashName(n);
          if (nk.length < 2 || !k.startsWith(nk)) continue;
          if (!best || nk.length > best.len) best = { o, len: nk.length, name: n };
        }
      }
      if (!best) continue;
      // what comes after the name: 「아래 · 옆 · 너머 …」 is near it, not in it
      const after = seg.slice(seg.indexOf(best.name) >= 0 ? seg.indexOf(best.name) + best.name.length : 0);
      // under a building is still in it when the place is underground (「지하 선착장 · 성 아래」); under a bridge or a
      // cliff is not (사령탑 E 덧붙임)
      const underBuilding = /지하/.test(p.name + ' ' + p.fields.location) && /^\s*\S*\s*(바로\s*)?(아래|밑)/.test(after.replace(/^\s*기초/, ''))
        && (best.o.type === 'group' || BUILDING.test(best.name));
      if (NOT_INSIDE.test(after) && !underBuilding) continue;
      // 「호그와트 급행열차 3호차」 is not in 호그와트: the name with the next word names something else the world has
      const next = after.trim().split(/\s+/)[0];
      if (next && doc.entities.some((x) => x !== p && x !== best.o && squashName(x.name).startsWith(squashName(best.name + next)))) continue;
      found.push({ p, o: best.o });
    }
    const rels = [];
    for (const { p, o } of found) {
      const to = o.type === 'place' ? o.entityId : this.basePlace(worldId, o.entityId, { by });
      if (!to || to === p.entityId) continue;
      rels.push({ from: p.entityId, to, type: '위치', note: '', evidence: '위치·소속: ' + p.fields.location });
    }
    const changes = this.applyRelations(worldId, rels, { ...meta, by });
    doc = this.readEntities(worldId);
    const inside = insideOf(doc);
    return { relations: changes, left: doc.entities.filter((e) => e.type === 'place' && !inside.has(e.entityId)).map((e) => e.entityId) };
  }

  // ---------------------------------------------------------------- 적용되는 곳 (v0.5.0 C)

  /**
   * Where a rule or system holds: one place or group (its entityId), or the whole world (none). The reader's and the
   * buttons' value never goes over the person's (sources.appliesTo 'manual'). Recorded ('applies', undoable).
   * meta.by: who; force: the person (manual). targetId null: the whole world.
   */
  setAppliesTo(worldId, entityId, targetId, meta = {}, { force = false } = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const e = doc.entities.find((x) => x.entityId === entityId);
    if (!e || !APPLIES_TYPES.has(e.type)) throw new ArchiveError(404, '규칙이나 시스템을 찾지 못했습니다.');
    if (targetId != null && targetId !== WORLD && !doc.entities.some((x) => x.entityId === targetId && APPLIES_TO.has(x.type))) throw new ArchiveError(400, '적용되는 곳은 장소나 집단(또는 세계 전체)이어야 합니다.');
    if (!force && e.sources?.appliesTo === 'manual') return null;
    const before = e.appliesTo || null;
    const after = targetId || null;
    if (before === after && !(force && e.sources?.appliesTo !== 'manual')) return null;
    if (after) e.appliesTo = after; else delete e.appliesTo;
    e.sources = { ...(e.sources || {}) };
    if (force) e.sources.appliesTo = 'manual';
    else if (after) e.sources.appliesTo = 'auto';
    else delete e.sources.appliesTo;
    e.revision++;
    e.updatedAt = now();
    this.writeJson(this.entityFile(worldId), doc);
    const nameOf = (id) => (id === WORLD ? '세계 전체' : doc.entities.find((x) => x.entityId === id)?.name || '');
    const c = { id: randomUUID(), at: e.updatedAt, by: force ? 'person' : meta.by || 'reader', roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], entityId, name: e.name, type: e.type, action: 'applies', before, after, beforeName: nameOf(before), afterName: nameOf(after), evidence: meta.evidence || '' };
    this.pushHistory(worldId, [c]);
    return c;
  }

  // ---------------------------------------------------------------- 학사일정 (v0.5.0 K)

  /** The owner's 학사일정 (ownerId null: the whole world's), or null. */
  calendarOf(doc, ownerId) {
    return doc.entities.find((e) => e.type === 'schedule' && e.calendar && (e.calendar.ownerId ?? null) === (ownerId ?? null)) || null;
  }

  /**
   * Dated events the reader (or 「학사일정으로 모으기」) found: [{ ownerId|null, date, end, when, name, place, placeId,
   * who, cancelled, evidence }]. The same event (same name, same school year or no date yet) is changed, not added: a
   * new date keeps the old one as 「이전」; cancelled marks it (never deleted); an event the person wrote only gets
   * 「대화에서는 ○○예요 [적용] [무시]」. meta.yearStart: the school year's first month. Recorded ('event', undoable).
   */
  applyCalendar(worldId, events, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const by = typeof meta.by === 'string' && /^[a-z0-9-]{1,40}$/.test(meta.by) ? meta.by : 'reader';
    const start = Number.isInteger(meta.yearStart) ? meta.yearStart : 9;
    const t = now();
    const changes = [];
    const log = (c) => changes.push({ id: randomUUID(), at: t, by, roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], ...c });
    for (const raw of Array.isArray(events) ? events : []) {
      const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, CAL.NAME_MAX);
      if (!name) continue;
      const ownerId = raw.ownerId ?? null;
      const owner = ownerId ? doc.entities.find((e) => e.entityId === ownerId && (e.type === 'group' || e.type === 'place')) : null;
      if (ownerId && !owner) continue;
      const date = raw.date ? CAL.normDate(raw.date) : null;
      const end = raw.end ? CAL.normDate(raw.end) : null;
      const when = !date && typeof raw.when === 'string' ? raw.when.trim().slice(0, 60) : '';
      if (!date && !when) continue;
      const evidence = typeof raw.evidence === 'string' ? raw.evidence.slice(0, 300) : '';
      let sheet = this.calendarOf(doc, ownerId);
      if (!sheet) {
        if (doc.entities.length >= ENTITY_MAX) continue;
        sheet = {
          entityId: randomUUID(), type: 'schedule', name: owner ? owner.name + ' 학사일정' : '세계 학사일정', aliases: [], description: '',
          fields: owner ? { who: owner.name } : {}, extra: [], pinned: false, sources: {}, status: 'confirmed',
          provenance: { source: 'auto', by, roomId: meta.roomId ?? null, evidence }, calendar: { ownerId, events: {} },
          revision: 1, createdAt: t, updatedAt: t,
        };
        doc.entities.push(sheet);
        log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'create', evidence });
      }
      const k = squashName(name);
      const same = Object.values(sheet.calendar.events).find((x) => squashName(x.name) === k
        && (!x.date || !date || CAL.schoolYear(x.date, start) === CAL.schoolYear(date, start) || x.date.slice(-5) === date.slice(-5)));
      const facts = {
        ...(date ? { date } : {}), ...(end && end !== date ? { end } : {}), ...(when ? { when } : {}),
        ...(raw.place ? { place: String(raw.place).trim().slice(0, 60) } : {}), ...(raw.placeId ? { placeId: raw.placeId } : {}),
        ...(raw.who ? { who: String(raw.who).trim().slice(0, 80) } : {}),
      };
      if (!same) {
        const id = randomUUID();
        sheet.calendar.events[id] = { id, name, ...facts, ...(raw.cancelled ? { cancelled: true } : {}), evidence, source: 'auto', at: t };
        log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'event', eventId: id, before: null, after: structuredClone(sheet.calendar.events[id]), evidence });
        sheet.revision++;
        sheet.updatedAt = t;
        continue;
      }
      const before = structuredClone(same);
      const next = { ...same };
      if (date && date !== same.date) {
        if (same.date) next.past = [{ date: same.date, until: t, evidence: same.evidence || '' }, ...(same.past || [])].slice(0, 3);
        next.date = date;
        delete next.when;
      }
      if (end && end !== next.end) next.end = end;
      if (raw.cancelled && !same.cancelled) next.cancelled = true;
      for (const f of ['place', 'placeId', 'who']) if (facts[f] && !same[f]) next[f] = facts[f];
      if (JSON.stringify(next) === JSON.stringify(same)) continue;
      if (same.source === 'manual') {
        const offer = { ...(date && date !== same.date ? { date } : {}), ...(raw.cancelled && !same.cancelled ? { cancelled: true } : {}), evidence, at: t };
        if (Object.keys(offer).length <= 2 || JSON.stringify(same.pending || {}) === JSON.stringify(offer)) continue;
        same.pending = offer;
        log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'event-pending', eventId: same.id, after: offer, evidence });
      } else {
        Object.assign(same, next, { evidence: evidence || same.evidence, at: t });
        log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'event', eventId: same.id, before, after: structuredClone(same), evidence });
      }
      sheet.revision++;
      sheet.updatedAt = t;
    }
    if (!changes.length) return [];
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return changes;
  }

  /**
   * An event the person writes (theirs from then on): { entityId | ownerId (null: the world's), eventId?, name, date,
   * end, place, who, cancelled }; name '' takes the event away. Recorded ('event', by person), undoable.
   */
  setEvent(worldId, body = {}) {
    this.getWorld(worldId);
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const doc = this.readEntities(worldId);
    let sheet = body.entityId ? doc.entities.find((e) => e.entityId === body.entityId && e.calendar) : this.calendarOf(doc, body.ownerId ?? null);
    const t = now();
    const changes = [];
    if (!sheet) {
      const owner = body.ownerId ? doc.entities.find((e) => e.entityId === body.ownerId && (e.type === 'group' || e.type === 'place')) : null;
      if (body.ownerId && !owner) throw new ArchiveError(404, '학사일정의 주인(집단이나 장소)을 찾지 못했습니다.');
      sheet = {
        entityId: randomUUID(), type: 'schedule', name: owner ? owner.name + ' 학사일정' : '세계 학사일정', aliases: [], description: '',
        fields: owner ? { who: owner.name } : {}, extra: [], pinned: false, sources: { name: 'manual' }, status: 'confirmed',
        provenance: { source: 'manual' }, calendar: { ownerId: owner?.entityId ?? null, events: {} }, revision: 1, createdAt: t, updatedAt: t,
      };
      doc.entities.push(sheet);
      changes.push({ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'create' });
    }
    const ev = body.eventId ? sheet.calendar.events[body.eventId] : null;
    if (body.eventId && !ev) throw new ArchiveError(404, '그 일정을 찾지 못했습니다.');
    const before = ev ? structuredClone(ev) : null;
    const name = String(body.name ?? ev?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, CAL.NAME_MAX);
    if (!name) {
      if (!ev) throw new ArchiveError(400, '행사 이름을 적어 주세요.');
      delete sheet.calendar.events[ev.id];
    } else {
      const date = body.date !== undefined ? (body.date ? CAL.normDate(body.date) : null) : ev?.date || null;
      if (body.date && !date) throw new ArchiveError(400, '날짜는 1991-10-31이나 10월 31일처럼 적어 주세요.');
      const id = ev?.id || randomUUID();
      const next = { ...(ev || {}), id, name, source: 'manual', at: t };
      if (date) next.date = date; else delete next.date;
      for (const f of ['place', 'who']) if (body[f] !== undefined) { if (String(body[f]).trim()) next[f] = String(body[f]).trim().slice(0, 80); else delete next[f]; }
      if (body.end !== undefined) { const e2 = body.end ? CAL.normDate(body.end) : null; if (e2) next.end = e2; else delete next.end; }
      if (body.cancelled !== undefined) { if (body.cancelled) next.cancelled = true; else delete next.cancelled; }
      if (ev?.date && date && ev.date !== date) next.past = [{ date: ev.date, until: t, evidence: '' }, ...(ev.past || [])].slice(0, 3);
      delete next.pending;
      sheet.calendar.events[id] = next;
    }
    sheet.revision++;
    sheet.updatedAt = t;
    const after = name ? structuredClone(Object.values(sheet.calendar.events).find((x) => x.name === name && x.source === 'manual' && x.at === t) || null) : null;
    changes.push({ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'event', eventId: after?.id || ev?.id, before, after });
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return sheet;
  }

  /** 「대화에서는 ○○예요」 on an event the person wrote: [적용] or [무시]. */
  applyEventPending(worldId, entityId, eventId, { discard = false } = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const sheet = doc.entities.find((e) => e.entityId === entityId && e.calendar);
    const ev = sheet?.calendar.events[eventId];
    if (!ev?.pending) throw new ArchiveError(404, '대화에서 온 값이 없습니다.');
    const before = structuredClone(ev);
    const p = ev.pending;
    delete ev.pending;
    const t = now();
    if (!discard) {
      if (p.date && p.date !== ev.date) { if (ev.date) ev.past = [{ date: ev.date, until: t, evidence: ev.evidence || '' }, ...(ev.past || [])].slice(0, 3); ev.date = p.date; }
      if (p.cancelled) ev.cancelled = true;
      ev.at = t;
    }
    sheet.revision++;
    sheet.updatedAt = t;
    this.writeJson(this.entityFile(worldId), doc);
    if (!discard) this.pushHistory(worldId, [{ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId, name: sheet.name, type: 'schedule', action: 'event', eventId, before, after: structuredClone(ev) }]);
    return sheet;
  }

  /** v0.5.0 (밤샘 2): whether the room is in English (its latest messages mostly in Latin letters). */
  setRoomLatin(roomId, latin) {
    needRoom(roomId);
    const rooms = this.readRooms();
    if (!rooms.rooms[roomId] || rooms.rooms[roomId].latin === latin) return;
    rooms.rooms[roomId].latin = latin;
    this.writeJson(this.roomsFile, rooms);
  }

  /** The story's today the room last showed (§RP header): { date, weekday, written, at } or null. */
  setRoomStory(roomId, story) {
    needRoom(roomId);
    const rooms = this.readRooms();
    if (!rooms.rooms[roomId]) return;
    const prev = rooms.rooms[roomId].story;
    if (!story) { if (!prev) return; delete rooms.rooms[roomId].story; }
    else if (prev?.date === story.date && prev?.weekday === story.weekday) return;
    else rooms.rooms[roomId].story = { date: story.date, weekday: story.weekday, written: !!story.written, at: now() };
    this.writeJson(this.roomsFile, rooms);
  }

  // ---------------------------------------------------------------- 시간표 (v0.5.0 B)

  /** The owner's 시간표 setting (a schedule with a timetable), or null. */
  timetableOf(doc, ownerId, year = null) {
    // v0.5.0 K: with a 학년도 — that year's sheet, or one with no year yet (it takes the year); a new year gets a new
    // sheet and last year's stays. Without one — the newest.
    const mine = doc.entities.filter((e) => e.type === 'schedule' && e.timetable?.ownerId === ownerId);
    if (year) return mine.find((e) => e.timetable.year === year) || mine.find((e) => !e.timetable.year) || null;
    return mine.sort((a, b) => String(b.timetable.year || '').localeCompare(String(a.timetable.year || '')))[0] || null;
  }

  /**
   * Cells the reader (or 「시간표로 모으기」) found: [{ ownerId, day, slot, value, evidence }]. The owner's sheet is made
   * when there is none (「○○ 시간표」). A new value for a cell: the old one is kept as 「이전」 (PAST_MAX); a cell the person
   * wrote is not written over — 「대화에서는 ○○예요 [적용] [무시]」 (pending) instead. Each change is in the history
   * ('cell', undoable). Returns the changes.
   */
  applyTimetable(worldId, cells, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const by = typeof meta.by === 'string' && /^[a-z0-9-]{1,40}$/.test(meta.by) ? meta.by : 'reader';
    const t = now();
    const changes = [];
    const log = (c) => changes.push({ id: randomUUID(), at: t, by, roomId: meta.roomId ?? null, messageIds: meta.messageIds || [], ...c });
    for (const raw of Array.isArray(cells) ? cells : []) {
      const owner = doc.entities.find((e) => e.entityId === raw?.ownerId && (e.type === 'group' || e.type === 'person'));
      const day = TT.normDay(raw?.day);
      const slot = TT.normSlot(raw?.slot);
      const value = String(raw?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, TT.CELL_MAX);
      if (!owner || !day || !slot || !value) continue;
      const evidence = typeof raw.evidence === 'string' ? raw.evidence.slice(0, 300) : '';
      const year = typeof meta.year === 'string' && meta.year ? meta.year : null;
      let sheet = this.timetableOf(doc, owner.entityId, year);
      if (sheet && year && !sheet.timetable.year) sheet.timetable.year = year;
      if (!sheet) {
        if (doc.entities.length >= ENTITY_MAX) continue;
        const older = doc.entities.some((e) => e.type === 'schedule' && e.timetable?.ownerId === owner.entityId);
        sheet = {
          entityId: randomUUID(), type: 'schedule', name: owner.name + ' 시간표' + (year && older ? ` (${year})` : ''), aliases: [], description: '',
          fields: { when: '매주', who: owner.name }, extra: [], pinned: false, sources: { when: 'auto', who: 'auto' }, status: 'confirmed',
          provenance: { source: 'auto', by, roomId: meta.roomId ?? null, evidence }, timetable: { ownerId: owner.entityId, cells: {}, ...(year ? { year } : {}) },
          revision: 1, createdAt: t, updatedAt: t,
        };
        doc.entities.push(sheet);
        log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'create', evidence });
      }
      const key = TT.cellKey(day, slot);
      const cell = sheet.timetable.cells[key];
      if (cell?.value === value) continue;
      if (cell?.source === 'manual') {
        if (cell.pending?.value === value) continue;
        cell.pending = { value, evidence, at: t };
        sheet.revision++;
        sheet.updatedAt = t;
        log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'cell-pending', key, after: value, evidence });
        continue;
      }
      const before = cell ? structuredClone(cell) : null;
      const past = cell?.value ? [{ value: cell.value, until: t, evidence: cell.evidence || '' }, ...(cell.past || [])].slice(0, TT.PAST_MAX) : cell?.past;
      sheet.timetable.cells[key] = { day, slot, value, evidence, source: 'auto', at: t, ...TT.cellExtras(raw), ...(past?.length ? { past } : {}) };
      sheet.revision++;
      sheet.updatedAt = t;
      log({ entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'cell', key, before: before?.value || '', after: value, cellBefore: before, evidence, ...(raw.moved ? { moved: raw.moved } : {}) });
    }
    if (!changes.length) return [];
    for (const e of doc.entities) if (e.timetable) TT.refresh(e);
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return changes;
  }

  /**
   * A cell the person writes (value '' takes it away). Theirs from then on: the reader only offers its value. To make
   * a sheet for someone: ownerId without entityId. Recorded ('cell', by person) and undoable.
   */
  setCell(worldId, body = {}) {
    this.getWorld(worldId);
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    const doc = this.readEntities(worldId);
    const day = TT.normDay(body.day);
    const slot = TT.normSlot(body.slot);
    if (!day) throw new ArchiveError(400, '요일은 월 · 화 · 수 · 목 · 금 · 토 · 일 · 평일 · 매일 중 하나입니다.');
    if (!slot) throw new ArchiveError(400, `시간은 1~${TT.SLOT_MAX}자로 적어 주세요(예: 1교시, 오전, 09:00–10:30).`);
    const value = cleanText(body.value ?? '', TT.CELL_MAX, '칸 내용').replace(/\s+/g, ' ').trim();
    let sheet = body.entityId ? doc.entities.find((e) => e.entityId === body.entityId && e.timetable) : this.timetableOf(doc, body.ownerId);
    const t = now();
    const changes = [];
    if (!sheet) {
      const owner = doc.entities.find((e) => e.entityId === body.ownerId && (e.type === 'group' || e.type === 'person'));
      if (!owner) throw new ArchiveError(404, body.entityId ? '시간표를 찾지 못했습니다.' : '시간표의 주인(집단이나 인물)을 찾지 못했습니다.');
      if (!value) throw new ArchiveError(400, '칸 내용을 적어 주세요.');
      if (doc.entities.length >= ENTITY_MAX) throw new ArchiveError(400, `설정은 ${ENTITY_MAX}개까지입니다.`);
      sheet = {
        entityId: randomUUID(), type: 'schedule', name: owner.name + ' 시간표', aliases: [], description: '',
        fields: { when: '매주', who: owner.name }, extra: [], pinned: false, sources: { name: 'manual' }, status: 'confirmed',
        provenance: { source: 'manual' }, timetable: { ownerId: owner.entityId, cells: {} }, revision: 1, createdAt: t, updatedAt: t,
      };
      doc.entities.push(sheet);
      changes.push({ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'create' });
    }
    if (body.revision !== undefined && sheet.revision !== body.revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
    const key = TT.cellKey(day, slot);
    const cell = sheet.timetable.cells[key];
    if ((cell?.value || '') === value && cell?.source === 'manual') return { entity: sheet, changed: false };
    if (!cell && !value) throw new ArchiveError(404, '그 칸은 비어 있습니다.');
    const before = cell ? structuredClone(cell) : null;
    if (value) {
      const past = cell?.value && cell.value !== value ? [{ value: cell.value, until: t, evidence: cell.evidence || '' }, ...(cell.past || [])].slice(0, TT.PAST_MAX) : cell?.past;
      sheet.timetable.cells[key] = { day, slot, value, evidence: '', source: 'manual', at: t, ...TT.cellExtras(body), ...(past?.length ? { past } : {}) };
    } else delete sheet.timetable.cells[key];
    TT.refresh(sheet);
    sheet.revision++;
    sheet.updatedAt = t;
    changes.push({ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId: sheet.entityId, name: sheet.name, type: 'schedule', action: 'cell', key, before: before?.value || '', after: value, cellBefore: before });
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return { entity: sheet, changed: true };
  }

  /** 「대화에서는 ○○예요」 on a cell the person wrote: [적용] (the story's value, the person's one kept as 「이전」) or [무시]. */
  applyCellPending(worldId, entityId, key, { discard = false } = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const sheet = doc.entities.find((e) => e.entityId === entityId && e.timetable);
    const cell = sheet?.timetable.cells[key];
    if (!cell?.pending) throw new ArchiveError(404, '대화에서 온 값이 없습니다.');
    const t = now();
    const before = structuredClone(cell);
    const p = cell.pending;
    delete cell.pending;
    if (!discard) {
      cell.past = [{ value: cell.value, until: t, evidence: cell.evidence || '' }, ...(cell.past || [])].slice(0, TT.PAST_MAX);
      cell.value = p.value;
      cell.evidence = p.evidence || '';
      cell.at = t;
      // still the person's: they chose this value
    }
    TT.refresh(sheet);
    sheet.revision++;
    sheet.updatedAt = t;
    this.writeJson(this.entityFile(worldId), doc);
    if (!discard) this.pushHistory(worldId, [{ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId, name: sheet.name, type: 'schedule', action: 'cell', key, before: before.value, after: cell.value, cellBefore: before, evidence: cell.evidence }]);
    return sheet;
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
    // v0.5.0 F: an other name in Latin letters left on a rule or system (「Slytherin」 on 「호그와트는 네 기숙사로
    // 나뉜다」) whose glossary pair's Korean names a group or place goes to that group or place ('alias-move', undoable).
    {
      const sq = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');
      for (const e of doc.entities) {
        if (e.type !== 'rule' && e.type !== 'system') continue;
        for (const a of [...(e.aliases || [])]) {
          if (!/^[A-Za-z][A-Za-z '’.-]*$/.test(a)) continue;
          const pair = pairs.find((p) => sq(p.from) === sq(a) || sq(p.to) === sq(a));
          if (!pair) continue;
          const ko = /[가-힣]/.test(pair.to) ? pair.to : pair.from;
          const owners = doc.entities.filter((x) => (x.type === 'group' || x.type === 'place') && [x.name, ...(x.aliases || [])].some((n) => sq(n) === sq(ko)));
          if (owners.length !== 1) continue;
          const to = owners[0];
          e.aliases = e.aliases.filter((x) => x !== a);
          if (!to.aliases.some((x) => sq(x) === sq(a)) && to.aliases.length < ALIAS_MAX) to.aliases.push(a);
          e.revision++;
          e.updatedAt = t;
          to.revision++;
          to.updatedAt = t;
          dirty = true;
          log({ entityId: e.entityId, entityIds: [e.entityId, to.entityId], name: e.name, type: e.type, action: 'alias-move', alias: a, to: to.name, toId: to.entityId, evidence: `번역 단어장 「${pair.from} = ${pair.to}」` });
        }
      }
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

  /**
   * v0.5.1 N: the reader was not sure a new setting is one the world had — kept on the new one (maybe: [{ id, why }],
   * up to 5) and shown first in 「같은 것일 수 있음」; merging or 「다른 것이에요」 is the person's.
   */
  markMaybe(worldId, newId, oldId, why = '') {
    this.getWorld(worldId);
    if (newId === oldId) return false;
    const doc = this.readEntities(worldId);
    const e = doc.entities.find((x) => x.entityId === newId);
    const o = doc.entities.find((x) => x.entityId === oldId);
    if (!e || !o || e.type !== o.type || (e.maybe || []).some((m) => m.id === oldId)) return false;
    e.maybe = [...(e.maybe || []), { id: oldId, why: String(why).slice(0, 200), at: now() }].slice(-5);
    this.writeJson(this.entityFile(worldId), doc);
    return true;
  }

  /** People who may be one person: [{ a, b, why }]. Only a suggestion; nothing is merged without mergeEntities. */
  listDuplicates(worldId) {
    this.getWorld(worldId);
    const gone = new Set(this.readDismissed(worldId).pairs.map((p) => pairKey(p.a, p.b)));
    const doc = this.readEntities(worldId);
    const skip = (a, b) => gone.has(pairKey(a, b));
    const seen = new Set();
    const byId = new Map(doc.entities.map((e) => [e.entityId, e]));
    const unsure = doc.entities.flatMap((e) => (e.maybe || []).filter((m) => byId.get(m.id)?.type === e.type && m.id !== e.entityId && !skip(e.entityId, m.id)).map((m) => ({ a: m.id, b: e.entityId, why: `자동 반영이 같은 것인지 헷갈려 했어요${m.why ? ` — 「${m.why}」` : ''}`, type: e.type, unsure: true })));
    return [...unsure,...findPairs(doc.entities, skip).map((x) => ({ ...x, type: 'person' })), ...describedPairs(doc.entities, doc.relations, skip).map((x) => ({ ...x, type: 'person' })), ...speciesPairs(doc.entities, skip).map((x) => ({ ...x, type: 'person' })), ...thingPairs(doc.entities, doc.relations, skip)].filter((p) => { const k = pairKey(p.a, p.b); if (seen.has(k)) return false; seen.add(k); return true; });
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
    if (merged.type === 'person' && !merged.room && drop.room) { merged.room = drop.room; merged.sources = { ...(merged.sources || {}), room: drop.sources?.room || 'auto' }; } // v0.5.1 I
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
    for (const e of doc.entities) {
      if (e.appliesTo === dropId) e.appliesTo = keepId; // v0.5.0 C
      if (e.base === dropId) e.base = keepId; // v0.5.0 E
      if (e.room === dropId) e.room = keepId; // v0.5.1 I
      if (e.timetable?.ownerId === dropId) e.timetable.ownerId = keepId; // v0.5.0 B
    }
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
        if (same.source === 'manual') continue;
        // A kind with a direction (소속 · 위치 · 스승·제자) read the other way round: the newer reading wins.
        if (DIRECTED.has(same.type) && same.from === raw.to && same.to === raw.from) {
          changes.push({ ...this.relationLog(doc, same, 'relation-flip', by, meta), before: { from: same.from, to: same.to }, after: { from: raw.from, to: raw.to }, evidence });
          same.from = raw.from;
          same.to = raw.to;
          if (evidence) same.evidence = evidence;
          same.updatedAt = t;
        }
        if (!note || same.note === note) continue;
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
    const groups = doc.entities.filter((e) => e.type === 'group');
    const exists = new Set(doc.relations.map(relKey));
    const found = [];
    // v0.5.0 (명단은 지금 상태): the 소속 칸 changed (전학 · 배정) → a relation to a group it no longer names goes. Those
    // made from the 소속 칸 always follow it; the reader's go when the earlier value (meta.was: { personId: before })
    // named that group. The person's own relations stay.
    const stale = [];
    for (const p of doc.entities) {
      if (p.type !== 'person' || (ids && !ids.includes(p.entityId))) continue;
      const named = new Set(groups.filter((g) => namesGroup(p.fields?.affiliation, g)).map((g) => g.entityId));
      const was = typeof meta.was?.[p.entityId] === 'string' ? meta.was[p.entityId] : null;
      for (const r of doc.relations) {
        if (r.type !== '소속' || r.source === 'manual' || (r.from !== p.entityId && r.to !== p.entityId)) continue;
        const g = groups.find((x) => x.entityId === (r.from === p.entityId ? r.to : r.from));
        if (!g || named.has(g.entityId)) continue;
        if (String(r.evidence || '').startsWith('소속:') || (was !== null && namesGroup(was, g))) stale.push(r);
      }
      for (const g of groups) {
        if (!named.has(g.entityId)) continue;
        const r = { from: p.entityId, to: g.entityId, type: '소속', note: '', evidence: '소속: ' + p.fields.affiliation };
        if (!exists.has(relKey(r))) found.push(r);
      }
    }
    const by = meta.by || 'affiliation';
    const gone = [];
    if (stale.length) {
      doc.relations = doc.relations.filter((r) => !stale.includes(r));
      this.writeJson(this.entityFile(worldId), doc);
      gone.push(...stale.map((r) => ({ ...this.relationLog(doc, r, 'relation-remove', by, meta), why: 'affiliation changed' })));
      this.pushHistory(worldId, gone);
    }
    return [...gone, ...this.applyRelations(worldId, found, { ...meta, by })];
  }

  /**
   * 작은 집단 → 큰 집단, by code (v0.5.0): a group whose name begins with another group's name or other name
   * (「슬리데린 1학년」 → 「슬리데린」) gets a 소속 relation to it, unless the two are already joined either way.
   */
  linkSubgroups(worldId, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const groups = doc.entities.filter((e) => e.type === 'group');
    const joined = new Set(doc.relations.filter((r) => r.type === '소속').flatMap((r) => [r.from + '|' + r.to, r.to + '|' + r.from]));
    const found = [];
    for (const a of groups) {
      const an = squashName(a.name);
      // The longest name it begins with: 「슬리데린 1학년 여학생」 joins 「슬리데린 1학년」, not 「슬리데린」 as well.
      let best = null;
      for (const b of groups) {
        if (b === a) continue;
        const len = Math.max(0, ...[b.name, ...(b.aliases || [])].map(squashName)
          .filter((k) => k.length >= 2 && an.length > k.length && an.startsWith(k) && !SAME_GROUP_SUFFIX.has(an.slice(k.length)))
          .map((k) => k.length));
        if (len && (!best || len > best.len)) best = { b, len };
      }
      if (!best || joined.has(a.entityId + '|' + best.b.entityId)) continue;
      found.push({ from: a.entityId, to: best.b.entityId, type: '소속', note: '', evidence: '이름: ' + a.name });
    }
    return this.applyRelations(worldId, found, { ...meta, by: meta.by || 'subgroup' });
  }

  /**
   * 없는 집단 채우기 (v0.5.0 A-2, by code, no model). What the 소속 칸 of people name that is not a group yet:
   * - an other name of a rule · system · …(「호그와트는 네 기숙사로 나뉜다」's 「슬리데린 기숙사」) that people's 소속 칸 name;
   * - a piece of the 소속 칸 that reads as a group (「슬리데린 1학년」, after a bigger group's name in front of another group's
   *   name: 「호그와트 슬리데린 1학년」), not the name of another setting (a place 「… 남학생 기숙사」 stays a place).
   * Two people or more: made (make). One: only offered (suggest — 「집단으로 만들기」).
   */
  planGroups(doc) {
    const groups = doc.entities.filter((e) => e.type === 'group');
    const people = doc.entities.filter((e) => e.type === 'person' && String(e.fields?.affiliation || '').trim());
    const covered = (name) => groups.some((g) => sameGroupName(name, g));
    const isOther = (name) => doc.entities.some((e) => e.type !== 'group' && [e.name, ...(e.aliases || [])].some((n) => squashName(n) === squashName(name)));
    const out = [];
    const taken = (name) => out.some((o) => sameGroupName(name, { name: o.name, aliases: o.aliases }));
    // 1) other names of rules · systems · …
    for (const x of doc.entities.filter((e) => KEEP_AS_IS.has(e.type))) {
      for (const a of x.aliases || []) {
        if (!/\p{Script=Hangul}/u.test(a) || squashName(a).length < 2 || covered(a) || taken(a)) continue;
        const who = people.filter((p) => namesGroup(p.fields.affiliation, { name: a, aliases: [] }));
        if (!who.length) continue;
        const core = a.replace(/\s*(기숙사|가문|집안|일가|무리|일행)$/, '').trim();
        const parents = groups.filter((gr) => namesGroup([x.name, ...Object.values(x.fields || {})].join(' '), gr));
        out.push({ name: a, aliases: core.length >= 2 && core !== a ? [core] : [], people: who.map((p) => p.entityId), from: 'alias', ownerId: x.entityId, ownerName: x.name, parentId: parents.length === 1 ? parents[0].entityId : null, evidence: x.name });
      }
    }
    // 2) pieces of the 소속 칸 that read as a group
    const all = () => [...groups, ...out.map((o) => ({ name: o.name, aliases: o.aliases }))];
    const isGroupWord = (w) => all().some((g) => groupKeys(g).includes(squashName(w)));
    const pieces = new Map();
    for (const p of people) {
      for (const part of p.fields.affiliation.split(/[,，/·;]|\s및\s/)) {
        let words = part.trim().split(/\s+/).filter(Boolean);
        let prefix = null;
        // 「호그와트 슬리데린 1학년」: the bigger group in front goes while another group's name follows it
        while (words.length > 1) {
          const k = [1, 2, 3].find((n) => n < words.length && isGroupWord(words.slice(0, n).join(' ')) && isGroupWord(words[n]));
          if (!k) break;
          prefix = all().find((g) => groupKeys(g).includes(squashName(words.slice(0, k).join(' '))));
          words = words.slice(k);
        }
        const r = words.join(' ');
        if (squashName(r).length < 2 || !GROUPISH.test(r) || ROLE_WORDS.test(words.at(-1)) || !/\p{Script=Hangul}/u.test(r) || covered(r) || isOther(r)) continue;
        const key = squashName(r);
        const it = pieces.get(key) || { name: r, people: new Set(), prefixes: new Map() };
        it.people.add(p.entityId);
        if (prefix?.name) it.prefixes.set(prefix.name, (it.prefixes.get(prefix.name) || 0) + 1);
        pieces.set(key, it);
      }
    }
    for (const it of pieces.values()) {
      if (taken(it.name)) continue;
      const top = [...it.prefixes].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      out.push({ name: it.name, aliases: [], people: [...it.people], from: 'affiliation', parentName: top, evidence: '' });
    }
    const names = (o) => o.people.map((id) => doc.entities.find((e) => e.entityId === id)?.name).filter(Boolean);
    return {
      make: out.filter((o) => o.people.length >= 2).map((o) => ({ ...o, peopleNames: names(o) })),
      suggest: out.filter((o) => o.people.length === 1).map((o) => ({ ...o, peopleNames: names(o) })),
    };
  }

  /**
   * Carries out planGroups (only = one name: the person chose 「집단으로 만들기」). A new group is source auto (the
   * person's: manual), in the history and undoable; an other name it came from leaves that setting ('alias-move',
   * undoable). Then the groups are joined: by name (linkSubgroups), to the bigger group the rule names or the 소속 칸
   * put in front, and the people by their 소속 칸.
   */
  fillGroups(worldId, meta = {}, only = null) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const plan = this.planGroups(doc);
    const list = only ? [...plan.make, ...plan.suggest].filter((o) => squashName(o.name) === squashName(only)) : plan.make;
    if (only && !list.length) throw new ArchiveError(404, '소속 칸에서 그 이름을 찾지 못했습니다.');
    if (!list.length) return { created: [], moved: [], relations: [] };
    const by = only ? 'person' : meta.by || 'fill-groups';
    const t = now();
    const changes = [];
    const made = [];
    for (const o of list) {
      if (doc.entities.length >= ENTITY_MAX) break;
      const entity = {
        entityId: randomUUID(), type: 'group', name: o.name, aliases: o.aliases, description: '', fields: {}, extra: [], pinned: false,
        sources: only ? { name: 'manual' } : {}, status: 'confirmed',
        provenance: { source: only ? 'manual' : 'auto', by, roomId: meta.roomId ?? null, evidence: o.from === 'alias' ? '「' + o.ownerName + '」의 다른 이름' : '소속 칸 · ' + o.peopleNames.join(', ') },
        revision: 1, createdAt: t, updatedAt: t,
      };
      doc.entities.push(entity);
      made.push({ entity, o });
      changes.push({ id: randomUUID(), at: t, by, roomId: meta.roomId ?? null, messageIds: [], entityId: entity.entityId, name: entity.name, type: 'group', action: 'create', evidence: entity.provenance.evidence });
      const owner = o.ownerId && doc.entities.find((e) => e.entityId === o.ownerId);
      if (owner && owner.aliases.includes(o.name)) {
        owner.aliases = owner.aliases.filter((a) => a !== o.name);
        owner.revision++;
        owner.updatedAt = t;
        changes.push({ id: randomUUID(), at: t, by, roomId: null, messageIds: [], entityId: owner.entityId, entityIds: [owner.entityId, entity.entityId], name: owner.name, type: owner.type, action: 'alias-move', alias: o.name, to: entity.name });
      }
    }
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    const rels = [...this.linkSubgroups(worldId, { by })];
    // the bigger group: what the rule names (네 기숙사 → 호그와트), or what the 소속 칸 put in front — unless joined by name
    const after = this.readEntities(worldId);
    const up = [];
    for (const { entity, o } of made) {
      if (after.relations.some((r) => r.type === '소속' && r.from === entity.entityId)) continue;
      const parent = o.parentId ? after.entities.find((e) => e.entityId === o.parentId)
        : o.parentName ? after.entities.find((e) => e.type === 'group' && e.name === o.parentName) : null;
      if (!parent || parent.entityId === entity.entityId) continue;
      const first = after.entities.find((e) => e.entityId === o.people[0]);
      up.push({ from: entity.entityId, to: parent.entityId, type: '소속', note: '', evidence: o.from === 'alias' ? o.evidence : '소속: ' + (first?.fields?.affiliation || '') });
    }
    rels.push(...this.applyRelations(worldId, up, { ...meta, by }), ...this.linkAffiliations(worldId, null, { ...meta, by }));
    return { created: made.map(({ entity }) => entity.name), moved: changes.filter((c) => c.action === 'alias-move').map((c) => ({ from: c.name, alias: c.alias })), relations: rels };
  }

  /** v0.5.0 R: 「이름 확인 필요」 on a person (a mark only; the person renaming them takes it off). */
  setNameCheck(worldId, entityId, check) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const e = doc.entities.find((x) => x.entityId === entityId && x.type === 'person');
    if (!e) return null;
    e.nameCheck = { said: String(check?.said || '').slice(0, 60) };
    this.writeJson(this.entityFile(worldId), doc);
    return e;
  }

  /** v0.5.0 P · Q: the world's latest 「잡다한 설정 정리」 candidates (nothing deleted until the person picks). */
  tidyFile(worldId) {
    return path.join(this.dir, 'tidy', `${needId(worldId)}.json`);
  }
  saveTidy(worldId, out) {
    this.getWorld(worldId);
    fs.mkdirSync(path.join(this.dir, 'tidy'), { recursive: true });
    this.writeJson(this.tidyFile(worldId), { schemaVersion: SCHEMA, at: out.at, items: out.items, fields: out.fields });
  }
  readTidy(worldId) {
    this.getWorld(worldId);
    const f = this.tidyFile(worldId);
    if (!fs.existsSync(f)) return { schemaVersion: SCHEMA, at: null, items: [], fields: [] };
    const doc = this.readJson(f, () => ({ schemaVersion: SCHEMA, at: null, items: [], fields: [] }), (x) => Array.isArray(x.items) && Array.isArray(x.fields), '정리 후보');
    // what is gone or was emptied since is no longer offered
    const ents = new Map(this.readEntities(worldId).entities.map((e) => [e.entityId, e]));
    doc.items = doc.items.filter((x) => ents.has(x.entityId));
    doc.fields = doc.fields.filter((x) => { const e = ents.get(x.entityId); return e && (x.key === 'description' ? e.description : e.fields?.[x.key]); });
    return doc;
  }
  /** 「남기기」: a candidate taken off the list (nothing changes in the world). */
  keepTidy(worldId, entityId, key = null) {
    const doc = this.readTidy(worldId);
    if (key) doc.fields = doc.fields.filter((x) => !(x.entityId === entityId && x.key === key));
    else doc.items = doc.items.filter((x) => x.entityId !== entityId);
    this.writeJson(this.tidyFile(worldId), doc);
    return doc;
  }

  /** 구성원 명단 of a group (v0.5.0): gathered from the 소속 relations by code; see roster.cjs. */
  roster(worldId, groupId) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const out = rosterOf(doc.entities, doc.relations, groupId);
    if (!out) throw new ArchiveError(404, '집단을 찾지 못했습니다.');
    return out;
  }

  /**
   * Adding someone to a group's list, or taking them off, is changing their 소속 칸 (v0.5.0): on adds the group's name
   * to it, off takes the group's names out and ends the 소속 relations between the two (the person's own too — they
   * asked). Each step is in the history like any edit and can be undone.
   */
  setMember(worldId, groupId, personId, on) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const g = doc.entities.find((e) => e.entityId === groupId && e.type === 'group');
    const p = doc.entities.find((e) => e.entityId === personId && e.type === 'person');
    if (!g || !p) throw new ArchiveError(404, g ? '인물을 찾지 못했습니다.' : '집단을 찾지 못했습니다.');
    const before = p.fields?.affiliation || '';
    let after = before;
    if (on) {
      if (!namesGroup(before, g)) after = before ? `${before}, ${g.name}` : g.name;
    } else {
      const names = [g.name, ...(g.aliases || [])].filter((n) => String(n).trim().length >= 2).sort((x, y) => y.length - x.length);
      for (const n of names) after = after.split(n).join(' ');
      after = after.replace(/\s*([,·/])\s*(?=[,·/]|$)/g, '').replace(/^[\s,·/]+|[\s,·/]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    }
    if (after !== before) this.updateEntity(worldId, personId, { revision: p.revision, fields: { ...(p.fields || {}), affiliation: after } });
    const changes = this.linkAffiliations(worldId, [personId], { by: 'person', was: { [personId]: before } });
    if (!on) {
      for (const r of this.readEntities(worldId).relations.filter((r) => r.type === '소속' && [r.from, r.to].includes(personId) && [r.from, r.to].includes(groupId))) {
        this.deleteRelation(worldId, r.relationId);
        changes.push({ action: 'relation-remove' });
      }
    }
    return { affiliation: { before, after }, relations: changes.length, roster: this.roster(worldId, groupId) };
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
   * v0.5.0 O: other names that are not names (pieces of sentences, descriptions) taken off — not the ones the person
   * wrote (sources.aliases 'manual'). Recorded ('alias-remove', undoable). Returns the changes.
   */
  tidyAliases(worldId, meta = {}) {
    this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const t = now();
    const changes = [];
    for (const e of doc.entities) {
      if (e.sources?.aliases === 'manual') continue;
      const off = (e.aliases || []).filter((a) => !nameLike(a));
      if (!off.length) continue;
      e.aliases = e.aliases.filter((a) => nameLike(a));
      e.revision++;
      e.updatedAt = t;
      for (const a of off) changes.push({ id: randomUUID(), at: t, by: meta.by || 'recheck', roomId: null, messageIds: [], entityId: e.entityId, name: e.name, type: e.type, action: 'alias-remove', alias: a });
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
    const whyOff = (r) => {
      const a = byId.get(r.from);
      const b = byId.get(r.to);
      const model = r.source === 'auto' && !String(r.evidence || '').startsWith('소속:');
      return !model || !a || !b ? null
        : !relationFits(r.type, a.type, b.type) ? 'kind'
        : (a.type === 'person' && isDescriptiveName(a.name)) || (b.type === 'person' && isDescriptiveName(b.name)) ? 'described name'
        : !mentions(r.evidence, a) && !mentions(r.evidence, b) ? 'evidence names neither'
        : null;
    };
    for (const r of doc.relations) {
      const why = whyOff(r);
      if (why) out.push({ r, why });
      else keep.push(r);
    }
    // Relations a crowd → group change took away come back when they fit again under today's rules (e.g. 소속 between
    // two groups, allowed since) — only while both settings are still there and nothing like them exists.
    const restored = [];
    const have = new Set(keep.map(relKey));
    for (const c of this.readHistory(worldId).changes) {
      if (c.action !== 'retype' || c.undoneAt) continue;
      for (const r of c.relations || []) {
        const a = byId.get(r.from);
        const b = byId.get(r.to);
        if (!validRelation(r) || !a || !b || have.has(relKey(r)) || !relationFits(r.type, a.type, b.type) || whyOff(r)) continue;
        have.add(relKey(r));
        keep.push(structuredClone(r));
        restored.push(r);
      }
    }
    if (!out.length && !restored.length) return [];
    doc.relations = keep;
    this.writeJson(this.entityFile(worldId), doc);
    const changes = [
      ...out.map(({ r, why }) => ({ ...this.relationLog(doc, r, 'relation-remove', meta.by || 'recheck', meta), why })),
      ...restored.map((r) => ({ ...this.relationLog(doc, r, 'relation-add', meta.by || 'recheck', meta), why: 'fits again' })),
    ];
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
    } else if (c.action === 'relation-flip') {
      if (!cur || cur.from !== c.after?.from || cur.to !== c.after?.to) throw new ArchiveError(409, later);
      cur.from = c.before.from;
      cur.to = c.before.to;
      cur.updatedAt = now();
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

  // ---------------------------------------------------------------- 할 일 11 — 방별 점수판

  scoreFile(roomId) {
    needRoom(roomId);
    return path.join(this.scoreDir, `${roomId}.json`);
  }

  readScores(roomId) {
    return this.readJson(
      this.scoreFile(roomId),
      () => ({ schemaVersion: SCHEMA, roomId, events: [] }),
      (d) => d.roomId === roomId && Array.isArray(d.events) && d.events.every(validScoreEvent),
      '점수판',
    );
  }

  /**
   * The room's board: the world's board name and unit, the events, and totals added up by code — events from a message
   * that is gone (rerolled, edited, deleted) and undone events do not count. Targets are summed under the setting's
   * name when a name or other name matches, otherwise as written.
   */
  getScores(roomId) {
    const worldId = this.roomWorldId(roomId);
    const world = worldId ? this.getWorld(worldId) : null;
    const doc = this.readScores(roomId);
    const entities = worldId ? this.readEntities(worldId).entities : [];
    const canon = (t) => this.findByName(entities, t)?.name || String(t).trim();
    const totals = new Map();
    for (const ev of doc.events) {
      if (ev.gone || ev.undoneAt) continue;
      const k = canon(ev.target);
      totals.set(k, (totals.get(k) || 0) + ev.delta);
    }
    return {
      roomId,
      worldId,
      board: world?.scoreboard || null,
      totals: [...totals.entries()].map(([target, total]) => ({ target, total })).sort((a, b) => b.total - a.total || a.target.localeCompare(b.target, 'ko')),
      events: doc.events.slice().reverse(),
    };
  }

  /**
   * Score events the reader found: [{ target, delta, reason, evidence, messageId, sentence }]. The same message,
   * sentence, target and points count once. Returns the events added.
   */
  addScores(roomId, events, by = 'reader') {
    const doc = this.readScores(roomId);
    const key = (e) => [e.messageId || '', e.sentence ?? '', squashName(e.target), e.delta].join('|');
    const have = new Set(doc.events.filter((e) => !e.undoneAt).map(key));
    const added = [];
    const t = now();
    for (const raw of Array.isArray(events) ? events : []) {
      const ev = cleanScoreEvent(raw);
      if (!ev || (ev.messageId && have.has(key(ev)))) continue;
      if (doc.events.length >= SCORE_MAX) break;
      have.add(key(ev));
      const e = { eventId: randomUUID(), ...ev, source: by === 'person' ? 'manual' : 'auto', by, at: t };
      doc.events.push(e);
      added.push(e);
    }
    if (added.length) this.writeJson(this.scoreFile(roomId), doc);
    return added;
  }

  /** 손으로 더하기 · 빼기: recorded on the board like the reader's events (source manual), undoable. */
  addScoreByHand(roomId, body = {}) {
    if (!isObject(body)) throw new ArchiveError(400, '내용을 보내 주세요.');
    if (!this.roomWorldId(roomId)) throw new ArchiveError(400, '이 방은 세계관에 연결되어 있지 않습니다.');
    const ev = cleanScoreEvent({ target: body.target, delta: body.delta, reason: body.reason ?? '손으로 고침', evidence: '' });
    if (!ev) throw new ArchiveError(400, '대상과 점수(정수)를 보내 주세요.');
    return this.addScores(roomId, [ev], 'person')[0];
  }

  /** 되돌리기 (or bring back, undo: false) of one event. Nothing is deleted. */
  undoScore(roomId, eventId, undo = true) {
    const doc = this.readScores(roomId);
    const e = doc.events.find((x) => x.eventId === eventId);
    if (!e) throw new ArchiveError(404, '점수 기록을 찾지 못했습니다.');
    if (undo && e.undoneAt) throw new ArchiveError(409, '이미 되돌린 기록입니다.');
    if (undo) e.undoneAt = now();
    else delete e.undoneAt;
    this.writeJson(this.scoreFile(roomId), doc);
    return e;
  }

  /**
   * Each reading checks the reader's events against the room as it is now: an event whose message is gone, or whose
   * sentence is no longer in it (rerolled or edited), is marked gone and leaves the totals (not deleted); it comes
   * back if the message does. messages: [{ id, content }].
   */
  markGoneScores(roomId, messages) {
    const doc = this.readScores(roomId);
    if (!doc.events.length) return 0;
    const byId = new Map(messages.map((m) => [m.id, squashName(m.content)]));
    let changed = 0;
    for (const e of doc.events) {
      if (e.source !== 'auto' || !e.messageId) continue;
      const text = byId.get(e.messageId);
      const gone = text === undefined || (e.evidence && !text.includes(squashName(e.evidence).slice(0, 40)));
      if (!!e.gone !== gone) {
        if (gone) e.gone = true;
        else delete e.gone;
        changed++;
      }
    }
    if (changed) this.writeJson(this.scoreFile(roomId), doc);
    return changed;
  }

  // ---------------------------------------------------------------- 할 일 10 — 대화에서 바뀐 값 [적용]

  /**
   * 「대화에서는 ○○가 됐어요 [적용]」: the person takes the story's newer value for a field they wrote. The field
   * becomes an automatic one again (later readings keep it current), their value is kept as 「이전」, and it is in
   * the history ('field' by person) so 되돌리기 works. discard: true just drops the suggestion.
   */
  applyPending(worldId, entityId, key, revision, { discard = false } = {}) {
    this.getWorld(worldId);
    needId(entityId, '설정');
    needRevision(revision);
    const doc = this.readEntities(worldId);
    const e = doc.entities.find((x) => x.entityId === entityId);
    if (!e) throw new ArchiveError(404, '설정을 찾지 못했습니다.');
    if (e.revision !== revision) throw new ArchiveError(409, '다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 해 주세요.');
    const p = e.pending?.[key];
    if (!p) throw new ArchiveError(404, '대화에서 바뀐 값이 없습니다.');
    delete e.pending[key];
    const t = now();
    const changes = [];
    if (!discard) {
      const before = e.fields[key] || '';
      if (before) e.past = { ...(e.past || {}), [key]: [{ value: before, until: t, evidence: '직접 쓴 값' }, ...((e.past || {})[key] || [])].slice(0, PAST_MAX) };
      e.fields[key] = p.value;
      e.sources[key] = 'auto';
      changes.push({ id: randomUUID(), at: t, by: 'person', roomId: null, messageIds: [], entityId, name: e.name, type: e.type, action: 'field', key, before, after: p.value, evidence: p.evidence || '' });
    }
    e.revision++;
    e.updatedAt = t;
    this.writeJson(this.entityFile(worldId), doc);
    this.pushHistory(worldId, changes);
    return e;
  }

  // ---------------------------------------------------------------- 할 일 7 — 백업 · 복원

  /**
   * One world as one file: its settings, entities, relations, history and the rooms that read it. format and
   * schemaVersion say what it is, so a later version can refuse it safely.
   */
  exportWorld(worldId) {
    const world = this.getWorld(worldId);
    const doc = this.readEntities(worldId);
    const rooms = Object.entries(this.readRooms().rooms).filter(([, l]) => l.worldId === worldId).map(([roomId]) => roomId);
    return {
      format: BACKUP_FORMAT,
      schemaVersion: SCHEMA,
      exportedAt: now(),
      world: { name: world.name, description: world.description, injectChars: world.injectChars, injectMode: world.injectMode, auto: world.auto },
      entities: doc.entities,
      relations: doc.relations,
      history: this.readHistory(worldId).changes,
      dismissed: this.readDismissed(worldId).pairs,
      rooms,
    };
  }

  /**
   * A backup comes back as a NEW world (「이름 (복원)」); nothing that exists is written over, and no room is linked
   * (a room reads one world only). A file of a newer version or one that does not check out is refused whole —
   * nothing is written. Entity and relation ids stay as in the file (they belong to the new world only).
   */
  importWorld(file) {
    if (!isObject(file) || file.format !== BACKUP_FORMAT) throw new ArchiveError(400, '세계관 설정집 백업 파일이 아닙니다.');
    if (!Number.isSafeInteger(file.schemaVersion) || file.schemaVersion < 1) throw new ArchiveError(400, '백업 파일의 형식 번호가 없습니다.');
    if (file.schemaVersion > SCHEMA) throw new ArchiveError(409, '이 파일은 더 새로운 판에서 만든 백업입니다. 세계관 설정집을 업데이트한 뒤 복원해 주세요.');
    if (Buffer.byteLength(JSON.stringify(file)) > FILE_MAX * 2) throw new ArchiveError(413, '백업 파일이 너무 큽니다.');
    const w = file.world;
    if (!isObject(w)) throw new ArchiveError(400, '백업 파일이 깨졌습니다(세계관 정보).');
    const entities = Array.isArray(file.entities) ? file.entities : null;
    const relations = file.relations === undefined ? [] : Array.isArray(file.relations) ? file.relations : null;
    const history = file.history === undefined ? [] : Array.isArray(file.history) ? file.history : null;
    const dismissed = file.dismissed === undefined ? [] : Array.isArray(file.dismissed) ? file.dismissed : null;
    if (!entities || !relations || !history || !dismissed) throw new ArchiveError(400, '백업 파일이 깨졌습니다.');
    if (entities.length > ENTITY_MAX || relations.length > REL_MAX) throw new ArchiveError(413, '백업 파일의 설정이 너무 많습니다.');
    const ids = new Set();
    for (const e of entities) {
      if (!validEntity(e) || ids.has(e.entityId)) throw new ArchiveError(400, '백업 파일이 깨졌습니다(설정).');
      ids.add(e.entityId);
    }
    const keys = new Set();
    for (const r of relations) {
      if (!validRelation(r) || !ids.has(r.from) || !ids.has(r.to) || keys.has(relKey(r))) throw new ArchiveError(400, '백업 파일이 깨졌습니다(관계).');
      keys.add(relKey(r));
    }
    if (!dismissed.every((x) => isObject(x) && typeof x.a === 'string' && typeof x.b === 'string')) throw new ArchiveError(400, '백업 파일이 깨졌습니다(다른 사람 표시).');
    if (!history.every((c) => isObject(c) && typeof c.id === 'string')) throw new ArchiveError(400, '백업 파일이 깨졌습니다(기록).');
    // Check the world's own fields with the usual rules before anything is written.
    const base = String(w.name || '').trim() || '복원한 세계관';
    const made = this.createWorld({
      name: (base.length > NAME_MAX - 5 ? base.slice(0, NAME_MAX - 5) : base) + ' (복원)',
      description: typeof w.description === 'string' ? w.description : '',
      injectChars: Number.isSafeInteger(w.injectChars) ? cleanBudget(w.injectChars) : undefined,
      injectMode: INJECT_MODES.includes(w.injectMode) ? w.injectMode : undefined,
      auto: isObject(w.auto) ? { ...defaultAuto(), ...w.auto, enabled: false } : undefined,
    });
    const worldId = made.worldId;
    this.writeJson(this.entityFile(worldId), { schemaVersion: SCHEMA, worldId, entities: structuredClone(entities), relations: structuredClone(relations) });
    this.writeJson(this.historyFile(worldId), { schemaVersion: SCHEMA, worldId, changes: structuredClone(history).slice(-HISTORY_MAX) });
    if (dismissed.length) this.writeJson(this.dismissFile(worldId), { schemaVersion: SCHEMA, worldId, pairs: structuredClone(dismissed).slice(-DISMISS_MAX) });
    return { world: this.getWorld(worldId), entities: entities.length, relations: relations.length, history: history.length, roomsInFile: Array.isArray(file.rooms) ? file.rooms.length : 0 };
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
    // v0.5.0: the story's today the room last showed, and whether it is in English
    return { roomId, worldId: exists ? link.worldId : null, linkedAt: link.linkedAt, read: link.read || null, ...(link.story ? { story: link.story } : {}), ...(typeof link.latin === 'boolean' ? { latin: link.latin } : {}) };
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
  nameLike,
  namesGroup,
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
