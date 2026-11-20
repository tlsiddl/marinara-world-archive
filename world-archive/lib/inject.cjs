'use strict';
const { FIELDS } = require('./store.cjs');
const TT = require('./timetable.cjs');
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

function entityLine(e) {
  // v0.5.0 B: a 시간표 is its cells on one line
  if (e.timetable) return sanitize(`- ${e.name}\n  시간표: ${TT.timetableLine(e) || '(비어 있음)'}`);
  const aliases = e.aliases?.length ? ` (다른 이름: ${e.aliases.join(', ')})` : '';
  const lines = [`- ${e.name}${aliases}`];
  const defs = FIELDS[e.type] || [];
  const fields = e.fields || {};
  const short = defs.filter((d) => d.kind === 'line' && fields[d.key]).map((d) => `${d.label}: ${oneLine(fields[d.key])}${was(e, d.key)}`);
  if (short.length) lines.push('  ' + short.join(' / '));
  for (const d of defs) if (d.kind === 'text' && fields[d.key]) lines.push(`  ${d.label}: ${oneLine(fields[d.key])}${was(e, d.key)}`);
  for (const x of e.extra || []) if (x.value) lines.push(`  ${x.label}: ${oneLine(x.value)}`);
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
function assembleWorld(world, entities, budget = world?.injectChars ?? 3000, { scene = null, relations = [], scores = null } = {}) {
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

  // 'scene' mode: only what the scene needs — pinned settings, settings named in the latest messages, and rules
  // and systems (they hold everywhere). Without scene information yet (a fresh start), everything is a candidate.
  let pool = entities || [];
  let skipped = 0;
  if (world.injectMode === 'scene' && scene) {
    // v0.5.0 B: a 시간표 when its owner is in the scene, or a group a person in the scene belongs to (소속)
    const sceneGroups = new Set((relations || []).filter((r) => r.type === '소속' && scene.has(r.from)).map((r) => r.to));
    const sheetHere = (e) => e.timetable && (scene.has(e.timetable.ownerId) || sceneGroups.has(e.timetable.ownerId));
    const keep = pool.filter((e) => e.pinned || ALWAYS.has(e.type) || scene.has(e.entityId) || sheetHere(e));
    skipped = pool.filter((e) => e.status === 'confirmed').length - keep.filter((e) => e.status === 'confirmed').length;
    pool = keep;
  }
  const ordered = orderEntities(pool, scene);
  const byType = new Map();
  const included = [];
  const omitted = [];
  for (const e of ordered) {
    const line = entityLine(e);
    const header = byType.has(e.type) ? 0 : `\n\n[${TYPE_LABEL[e.type]}]`.length;
    const cost = header + 1 + line.length;
    if (used + cost > budget) {
      omitted.push(e.entityId);
      continue;
    }
    used += cost;
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(line);
    included.push(e.entityId);
  }

  // Scene mode: relations of people in the scene whose other end is in the scene too, one line each, if they fit.
  const relLines = [];
  if (world.injectMode === 'scene' && scene && Array.isArray(relations) && relations.length) {
    const shown = new Map(ordered.filter((e) => included.includes(e.entityId)).map((e) => [e.entityId, e]));
    for (const r of relations) {
      const a = shown.get(r.from);
      const b = shown.get(r.to);
      if (!a || !b || !scene.has(a.entityId) || !scene.has(b.entityId) || (a.type !== 'person' && b.type !== 'person')) continue;
      const line = sanitize(`- ${a.name} — ${b.name}: ${r.note || r.type}`);
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

module.exports = { assembleWorld, assembleLooks, orderEntities, sanitize, TYPE_LABEL, TYPE_ORDER, ALWAYS, LOOKS_CHARS };
