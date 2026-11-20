'use strict';
const { FIELDS } = require('./store.cjs');
const TT = require('./timetable.cjs');
const CAL = require('./calendar.cjs');
// What {{세계}} becomes. Pure functions: no files, no engine.
// Budget handling follows the idea of the Memory Module's renderMemorySource (tlsiddl/marinara-memory-module
// refactor/modular e873fd1): whole items only, most important first, never cut in the middle of a line.

const TYPE_LABEL = {
  person: '인물',
  place: '장소',
  group: '집단',
  rule: '규칙',
  system: '시스템',
  schedule: '일정',
  history: '역사',
  custom: '기타',
};
const TYPE_ORDER = ['person', 'place', 'group', 'rule', 'system', 'schedule', 'history', 'custom'];
/** Kinds that hold everywhere: in 'scene' mode they go in whether or not the scene names them. */
const ALWAYS = new Set(['rule', 'system']);
/** 적용되는 곳 「세계 전체」 (v0.5.0 D): said to hold everywhere. No 적용되는 곳 at all is 「모름」. */
const WORLD = 'world';

/** Text taken from settings must never turn into new macros: {{ and }} get a zero-width space. */
function sanitize(text) {
  return String(text ?? '')
    .replace(/\{\{/g, '{​{')
    .replace(/\}\}/g, '}​}');
}

const oneLine = (t) => String(t).replace(/\s*\n+\s*/g, ' / ').trim();

/**
 * One setting as a block: the name line, then short fields together on one line, then each long field, extra field
 * and the memo on a line of its own, indented under the name.
 *   - 한여름 (다른 이름: 여름)
 *     성별: 여 / 나이·생일: 17 / 소속: 천문부
 *     성격: 규칙에 엄격하다
 */
/** 할 일 10: the earlier value, only for a field the person switched on (「이전 값도 프롬프트에」). */
const was = (e, k) => (e.pastInPrompt?.[k] && e.past?.[k]?.[0]?.value ? ` (과거: ${oneLine(e.past[k][0].value)})` : '');

/**
 * v0.5.0 (밤샘 2): a setting's name the way the room writes — 「Severus Snape(세베루스 스네이프)」 in a room in English
 * (its original name: the first other name in Latin letters), the Korean one alone otherwise or when there is none.
 */
const originalOf = (e) => (e.aliases || []).find((a) => /^[A-Za-z][A-Za-z .'’-]*$/.test(String(a).trim()));
const shownName = (e, names) => { const o = names === 'original' ? originalOf(e) : null; return o ? `${o}(${e.name})` : e.name; };
function entityLine(e, nameOf = () => '', today = null, names = 'ko') {
  // v0.5.0 K: a 학사일정 is the next three events on one line (nothing ahead: nothing)
  if (e.calendar) { const l = CAL.calendarLine(e, today); return l ? sanitize(`- ${shownName(e, names)}\n  ${l}`) : ''; }
  // v0.5.0 B: a 시간표 is its cells on one line
  if (e.timetable) return sanitize(`- ${shownName(e, names)}\n  시간표: ${TT.timetableLine(e) || '(비어 있음)'}`);
  const shown = shownName(e, names);
  const rest = (e.aliases || []).filter((a) => !(shown !== e.name && a === originalOf(e)));
  const aliases = rest.length ? ` (다른 이름: ${rest.join(', ')})` : '';
  // v0.5.0 C: where a rule or system holds
  const where = e.appliesTo && nameOf(e.appliesTo) ? ` [${nameOf(e.appliesTo)}에서]` : '';
  const lines = [`- ${shown}${aliases}${where}`];
  const defs = FIELDS[e.type] || [];
  const fields = e.fields || {};
  // v0.5.0 S: a field only a profile block has said so far
  const veiled = (k) => (e.hidden?.[k] ? ' (아직 드러나지 않음)' : '');
  const short = defs.filter((d) => d.kind === 'line' && fields[d.key]).map((d) => `${d.label}: ${oneLine(fields[d.key])}${veiled(d.key)}${was(e, d.key)}`);
  // v0.5.1 I: where a person stays now (방 배정)
  if (e.type === 'person' && e.room && nameOf(e.room)) short.push(`지내는 곳: ${nameOf(e.room)}`);
  if (short.length) lines.push('  ' + short.join(' / '));
  for (const d of defs) if (d.kind === 'text' && fields[d.key]) lines.push(`  ${d.label}: ${oneLine(fields[d.key])}${veiled(d.key)}${was(e, d.key)}`);
  for (const x of e.extra || []) if (x.value) lines.push(`  ${x.label}: ${oneLine(x.value)}`);
  // v0.5.0 L: what someone says, short, marked
  for (const [k, r] of Object.entries(e.rumors || {})) { const d = defs.find((x) => x.key === k); if (d && r?.value) lines.push(`  ${d.label}: ${oneLine(r.value).slice(0, 120)} (소문)`); }
  if (e.description) lines.push(`  ${defs.length ? '메모: ' : ''}${oneLine(e.description)}`);
  return sanitize(lines.join('\n'));
}

/**
 * Only confirmed settings go into the prompt. Pinned ones first, then the ones in the current scene (scene: a Set of
 * entity ids named in the latest messages), then by kind, then by name.
 */
function orderEntities(entities, scene = null) {
  const inScene = (e) => Number(!!scene?.has(e.entityId));
  return entities
    .filter((e) => e.status === 'confirmed')
    .slice()
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        inScene(b) - inScene(a) ||
        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
        a.name.localeCompare(b.name, 'ko'),
    );
}

/**
 * @returns {{ text: string, chars: number, budget: number, included: string[], omitted: string[] }}
 * included / omitted are entity IDs. An item that does not fit is left out whole; smaller ones after it can
 * still fit. The world description is cut at a line break only when it alone is larger than the budget.
 */
function assembleWorld(world, entities, budget = world?.injectChars ?? 3000, { scene = null, relations = [], scores = null, today = null, names = 'ko' } = {}) {
  const empty = { text: '', chars: 0, budget, included: [], omitted: [], skipped: 0 };
  if (!world) return empty;
  const head = sanitize(`[세계관] ${world.name}`);
  let desc = sanitize(world.description || '');
  let used = head.length;
  if (desc) {
    const room = budget - used - 1;
    if (desc.length > room) {
      const cut = desc.lastIndexOf('\n', room);
      desc = room > 0 ? desc.slice(0, cut > 0 ? cut : room).trimEnd() : '';
    }
    if (desc) used += 1 + desc.length;
  }

  // 'scene' mode (v0.5.0 D): what the scene needs, in this order while the budget lasts —
  //   pinned → the settings named in the scene → rules · systems of the whole world (the latest first) → rules ·
  //   systems of the places and groups here, and their 시간표 → rules · systems nobody has said where for.
  // 「Here」: the places and groups of the scene, the places they are in (위치) and the bigger groups (소속), the groups
  // the people of the scene belong to. A rule of a place or group not here is left out.
  // Without scene information yet (a fresh start), everything is a candidate in the plain order.
  let pool = entities || [];
  let skipped = 0;
  const byIdAll = new Map((entities || []).map((x) => [x.entityId, x]));
  const nameOf = (id) => byIdAll.get(id)?.name || '';
  let ordered;
  let part = null; // scene mode: which part of the budget a setting fills from (see below)
  if (world.injectMode === 'scene' && scene) {
    const rel = Array.isArray(relations) ? relations : [];
    // here: id → how far from the scene (0 the scene's own places and groups; +1 for each place it is in or bigger group)
    const here = new Map();
    const queue = [];
    const add = (id, d) => { if (id && (!here.has(id) || here.get(id) > d)) { here.set(id, d); queue.push(id); } };
    for (const id of scene) {
      const e = byIdAll.get(id);
      if (!e) continue;
      if (e.type === 'place' || e.type === 'group') add(id, 0);
      if (e.type === 'person') for (const r of rel) if (r.type === '소속' && r.from === id && byIdAll.get(r.to)?.type === 'group') add(r.to, 1);
    }
    while (queue.length) {
      const id = queue.shift();
      for (const r of rel) {
        if (r.from !== id || (r.type !== '위치' && r.type !== '소속')) continue;
        const up = byIdAll.get(r.to);
        if (up && (up.type === 'place' || up.type === 'group')) add(r.to, here.get(id) + 1);
      }
      // v0.5.0 E: a group's 본거지, and the groups whose 본거지 is this place
      const e = byIdAll.get(id);
      if (e?.type === 'group' && e.base && byIdAll.has(e.base)) add(e.base, here.get(id));
      if (e?.type === 'place') for (const g of entities || []) if (g.type === 'group' && g.base === id) add(g.entityId, here.get(id) + 1);
    }
    const ruleLike = (e) => ALWAYS.has(e.type);
    const whereKnown = (e) => ruleLike(e) && e.appliesTo && e.appliesTo !== WORLD && byIdAll.has(e.appliesTo);
    const sheetHere = (e) => (e.timetable && (scene.has(e.timetable.ownerId) || here.has(e.timetable.ownerId))) || (e.calendar?.ownerId && (scene.has(e.calendar.ownerId) || here.has(e.calendar.ownerId)));
    const worldCalendar = (e) => e.calendar && !e.calendar.ownerId;
    const keep = pool.filter((e) => e.pinned || scene.has(e.entityId) || sheetHere(e) || worldCalendar(e) || (ruleLike(e) && (!whereKnown(e) || here.has(e.appliesTo))));
    skipped = pool.filter((e) => e.status === 'confirmed').length - keep.filter((e) => e.status === 'confirmed').length;
    const rank = (e) => (e.pinned ? 0
      : scene.has(e.entityId) && !ruleLike(e) ? 1
      : (ruleLike(e) && e.appliesTo === WORLD) || worldCalendar(e) ? 2
      : sheetHere(e) || whereKnown(e) ? 3
      : ruleLike(e) ? 4 : 5);
    // the nearest place or group first (the scene's own, then the place it is in, the bigger group …)
    const sheetOwner = (e) => e.timetable?.ownerId || e.calendar?.ownerId;
    const near = (e) => (sheetOwner(e) ? (scene.has(sheetOwner(e)) ? 0 : here.get(sheetOwner(e)) ?? 99) : whereKnown(e) ? here.get(e.appliesTo) ?? 99 : 0);
    // in each part, a rule named in the latest messages (it is in the scene) comes first
    const named = (e) => Number(!scene.has(e.entityId));
    ordered = keep.filter((e) => e.status === 'confirmed').map((e) => [rank(e), e]).sort(([ra, a], [rb, b]) => ra - rb
      || (ra >= 2 ? named(a) - named(b) : 0)
      || (ra === 2 ? String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) : 0)
      || (ra === 3 ? near(a) - near(b) : 0)
      || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
      || a.name.localeCompare(b.name, 'ko')).map(([, e]) => e);
    part = (e) => Math.min(rank(e), 5);
  } else ordered = orderEntities(pool, scene);
  const byType = new Map();
  const included = [];
  const omitted = [];
  const tried = new Set();
  const fill = (list, limit) => {
    for (const e of list) {
      if (tried.has(e.entityId) && included.includes(e.entityId)) continue;
      const line = entityLine(e, nameOf, today, names);
      if (!line) continue;
      const header = byType.has(e.type) ? 0 : `\n\n[${TYPE_LABEL[e.type]}]`.length;
      const cost = header + 1 + line.length;
      tried.add(e.entityId);
      if (used + cost > limit) continue;
      used += cost;
      if (!byType.has(e.type)) byType.set(e.type, []);
      byType.get(e.type).push(line);
      included.push(e.entityId);
    }
  };
  if (part) {
    // v0.5.0 D: pinned and the scene first; what is left goes at most a third to the rules of the whole world, the
    // rest to the rules · 시간표 here — a part that does not use its share leaves it to the other — then the unknown.
    const of = (k) => ordered.filter((e) => part(e) === k);
    fill([...of(0), ...of(1)], budget);
    const worldCap = used + Math.floor((budget - used) / 3);
    fill(of(2), worldCap);
    fill(of(3), budget);
    fill(of(2), budget);
    fill([...of(4), ...of(5)], budget);
  } else fill(ordered, budget);
  for (const e of ordered) if (!included.includes(e.entityId)) omitted.push(e.entityId);

  // Scene mode: relations of people in the scene whose other end is in the scene too, one line each, if they fit.
  const relLines = [];
  if (world.injectMode === 'scene' && scene && Array.isArray(relations) && relations.length) {
    const shown = new Map(ordered.filter((e) => included.includes(e.entityId)).map((e) => [e.entityId, e]));
    for (const r of relations) {
      const a = shown.get(r.from);
      const b = shown.get(r.to);
      if (!a || !b || !scene.has(a.entityId) || !scene.has(b.entityId) || (a.type !== 'person' && b.type !== 'person')) continue;
      const line = sanitize(`- ${shownName(a, names)} — ${shownName(b, names)}: ${r.note || r.type}`);
      const cost = (relLines.length ? 0 : '\n\n[관계]'.length) + 1 + line.length;
      if (used + cost > budget) continue;
      used += cost;
      relLines.push(line);
    }
  }

  // 할 일 11: the room's totals (added up by code) right under the world, if they fit.
  let scoreLine = '';
  if (scores?.board?.name && scores.totals?.length) {
    const unit = scores.board.unit || '';
    const line = sanitize(`[점수] ${scores.board.name}: ${scores.totals.map((x) => `${x.target} ${x.total}${unit}`).join(' · ')}`);
    if (used + 2 + line.length <= budget) (scoreLine = line), (used += 2 + line.length);
  }
  const parts = [head + (desc ? '\n' + desc : '')];
  if (scoreLine) parts.push(scoreLine);
  // Sections appear in kind order; inside each, the order chosen above (pinned first).
  for (const type of TYPE_ORDER) {
    const lines = byType.get(type);
    if (lines) parts.push(`[${TYPE_LABEL[type]}]\n${lines.join('\n')}`);
  }
  if (relLines.length) parts.push(`[관계]\n${relLines.join('\n')}`);
  const text = parts.join('\n\n');
  return { text, chars: text.length, budget, included, omitted, skipped };
}

/** 할 일 12: what {{세계외형}} may hold at most (whole lines only). */
const LOOKS_CHARS = 1500;

/**
 * {{세계외형}} / {{world_looks}} — for the illustrator: confirmed people in the scene who have an appearance, one line
 * each (name, gender · age, appearance as written now).
 * People named in the latest messages first (recent: a Set of ids), then pinned, then by name.
 * No scene known yet: empty. A line that does not fit is left out whole.
 */
function assembleLooks(entities, scene, { recent = null, budget = LOOKS_CHARS } = {}) {
  if (!scene) return { text: '', included: [], omitted: [] };
  const people = (entities || [])
    .filter((e) => e.type === 'person' && e.status === 'confirmed' && scene.has(e.entityId) && String(e.fields?.appearance || '').trim())
    .sort(
      (a, b) =>
        Number(!!recent?.has(b.entityId)) - Number(!!recent?.has(a.entityId)) ||
        Number(b.pinned) - Number(a.pinned) ||
        a.name.localeCompare(b.name, 'ko'),
    );
  const head = '[외형]';
  let used = head.length;
  const lines = [];
  const included = [];
  const omitted = [];
  for (const e of people) {
    const f = e.fields || {};
    const who = [f.gender, f.age].map((v) => String(v || '').trim()).filter(Boolean).map(oneLine).join(', ');
    const line = sanitize(`- ${e.name}${who ? ` (${who})` : ''}: ${oneLine(f.appearance)}`);
    if (used + 1 + line.length > budget) {
      omitted.push(e.entityId);
      continue;
    }
    used += 1 + line.length;
    lines.push(line);
    included.push(e.entityId);
  }
  return { text: lines.length ? `${head}\n${lines.join('\n')}` : '', included, omitted };
}

module.exports = { WORLD, shownName, assembleWorld, assembleLooks, orderEntities, sanitize, TYPE_LABEL, TYPE_ORDER, ALWAYS, LOOKS_CHARS };
