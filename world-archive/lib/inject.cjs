'use strict';
const { FIELDS } = require('./store.cjs');
// What {{세계}} becomes. Pure functions: no files, no engine.
// Budget handling follows the idea of the Memory Module's renderMemorySource (tlsiddl/marinara-memory-module
// refactor/modular e873fd1): whole items only, most important first, never cut in the middle of a line.

const TYPE_LABEL = {
  person: '인물',
  place: '장소',
  group: '집단',
  rule: '규칙',
  schedule: '일정',
  custom: '기타',
};
const TYPE_ORDER = ['person', 'place', 'group', 'rule', 'schedule', 'custom'];

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
function entityLine(e) {
  const aliases = e.aliases?.length ? ` (다른 이름: ${e.aliases.join(', ')})` : '';
  const lines = [`- ${e.name}${aliases}`];
  const defs = FIELDS[e.type] || [];
  const fields = e.fields || {};
  const short = defs.filter((d) => d.kind === 'line' && fields[d.key]).map((d) => `${d.label}: ${oneLine(fields[d.key])}`);
  if (short.length) lines.push('  ' + short.join(' / '));
  for (const d of defs) if (d.kind === 'text' && fields[d.key]) lines.push(`  ${d.label}: ${oneLine(fields[d.key])}`);
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
function assembleWorld(world, entities, budget = world?.injectChars ?? 3000, { scene = null } = {}) {
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
  // (they hold everywhere). Without scene information yet (a fresh start), everything is a candidate.
  let pool = entities || [];
  let skipped = 0;
  if (world.injectMode === 'scene' && scene) {
    const keep = pool.filter((e) => e.pinned || e.type === 'rule' || scene.has(e.entityId));
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

  const parts = [head + (desc ? '\n' + desc : '')];
  // Sections appear in kind order; inside each, the order chosen above (pinned first).
  for (const type of TYPE_ORDER) {
    const lines = byType.get(type);
    if (lines) parts.push(`[${TYPE_LABEL[type]}]\n${lines.join('\n')}`);
  }
  const text = parts.join('\n\n');
  return { text, chars: text.length, budget, included, omitted, skipped };
}

module.exports = { assembleWorld, orderEntities, sanitize, TYPE_LABEL, TYPE_ORDER };
