'use strict';
const { FIELDS, groupOfPlace } = require('./store.cjs');
const TT = require('./timetable.cjs');
const R = require('./roster.cjs');
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
function entityLine(e, nameOf = () => '', today = null, names = 'ko', knownOf = () => null) {
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
  const total = e.type === 'group' ? R.headcount(fields.size) : null;
  // v0.7.2 K: a rule's or system's 분류 stays on the screen; {{세계}} says its 주제
  const isLaw = e.type === 'rule' || e.type === 'system';
  const short = defs.filter((d) => d.kind === 'line' && fields[d.key] && !(total && d.key === 'size') && !(isLaw && d.key === 'category')).map((d) => `${d.label}: ${oneLine(fields[d.key])}${veiled(d.key)}${was(e, d.key)}`);
  if (isLaw && e.topic) short.unshift(`주제: ${e.topic}`);
  // v0.5.1 J: how many in all, and how many of them have a name here
  if (total) { const k = knownOf(e.entityId); short.push(`인원: ${k != null ? `이름 아는 사람 ${k}명 / ` : ''}전체 ${total}명`); }
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
 * v0.5.1 T: the two last lines of {{세계}} — no new macro. 「[이미 있는 인물] 이름, 이름, … 외 N명」 (the people there are,
 * the latest first, up to CAST_CHARS, so a reply does not make them again) and 「[균형] 반복 등장 인물 N명: 여 a · 남 b /
 * 혈통 편견: … 」 (the people who come back — pinned, or spoken of in two batches or more — counted by code; what is not
 * known is 「모름」). Each can be turned off in the world (world.tail.cast · world.tail.balance, on by default); the 균형
 * 볼 칸 are world.balance (default 성별): a person field by its label, or else the person's 추가 칸 of that name.
 */
const CAST_CHARS = 600;
const GENDER = [[/^(여|여성|여자|소녀|female|woman|girl|f)$/i, '여'], [/^(남|남성|남자|소년|male|man|boy|m)$/i, '남']];
const GENDER_RANK = (v) => (v === '여' ? 0 : v === '남' ? 1 : v === '모름' ? 3 : 2);
function tailLines(world, entities, { recurring = null, names = 'ko' } = {}) {
  const lines = [];
  const people = (entities || []).filter((e) => e.type === 'person' && e.status === 'confirmed');
  const on = (k) => world?.tail?.[k] !== false;
  if (on('cast') && people.length) {
    const list = people.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.name.localeCompare(b.name, 'ko'));
    const head = '[이미 있는 인물] ';
    const say = (shown) => head + shown.join(', ') + (list.length > shown.length ? ` 외 ${list.length - shown.length}명` : '');
    let shown = [];
    for (const e of list) {
      const next = [...shown, shownName(e, names)];
      if (say(next).length > CAST_CHARS) break;
      shown = next;
    }
    if (shown.length) lines.push(sanitize(say(shown)));
  }
  if (on('balance')) {
    const back = people.filter((e) => (recurring ? recurring.has(e.entityId) : e.pinned || (e.seen?.n || 0) >= 2));
    if (back.length) {
      const labels = Array.isArray(world.balance) && world.balance.length ? world.balance : ['성별'];
      const parts = labels.map((label) => {
        const def = FIELDS.person.find((f) => f.label === label);
        const gender = def?.key === 'gender';
        const count = new Map();
        for (const e of back) {
          let v = String((def ? e.fields?.[def.key] : (e.extra || []).find((x) => x.label === label)?.value) || '').trim();
          if (gender) v = (GENDER.find(([re]) => re.test(v)) || [null, v])[1];
          v = v ? oneLine(v).slice(0, 12) : '모름';
          count.set(v, (count.get(v) || 0) + 1);
        }
        const all = [...count].sort((a, b) => (gender ? GENDER_RANK(a[0]) - GENDER_RANK(b[0]) : 0) || (a[0] === '모름') - (b[0] === '모름') || b[1] - a[1]);
        const top = all.filter(([v]) => v !== '모름').slice(0, 4);
        const more = all.filter(([v]) => v !== '모름').slice(4).reduce((a, x) => a + x[1], 0);
        const unknown = count.get('모름') || 0;
        const body = [...top.map(([v, n]) => `${v} ${n}`), ...(more ? [`그 밖 ${more}`] : []), ...(unknown ? [`모름 ${unknown}`] : [])].join(' · ');
        return gender ? body : `${label}: ${body}`;
      });
      lines.push(sanitize(`[균형] 반복 등장 인물 ${back.length}명: ${parts.join(' / ')}`));
    }
  }
  return { lines, kept: [] };
}

/**
 * Only confirmed settings go into the prompt. Pinned ones first, then the ones in the current scene (scene: a Set of
 * entity ids named in the latest messages), then by kind, then by name.
 */
/** v0.7.2 A: spoken of in more reading batches first, then the latest evidence (not the name). */
const seenN = (e) => (Number.isFinite(e?.seen?.n) ? e.seen.n : 1);
const often = (a, b) => seenN(b) - seenN(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
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
        often(a, b) ||
        a.name.localeCompare(b.name, 'ko'),
    );
}

/**
 * @returns {{ text: string, chars: number, budget: number, included: string[], omitted: string[] }}
 * included / omitted are entity IDs. An item that does not fit is left out whole; smaller ones after it can
 * still fit. The world description is cut at a line break only when it alone is larger than the budget.
 */
/**
 * v0.6.2 ② · v0.6.4 a: a rule, system, 기타 or 역사 the reading found in one batch only (seen.n < 2) — 「한 번 나옴」:
 * kept in the world, not put in {{세계}}. Not one that is pinned, that the person wrote, or whose name says it is a law
 * (법 · 령 · 규칙 · 제도).
 * One counted before v0.5.1 (no seen) is not judged here; recheck counts it.
 */
// 「법」 as a law: stuck to the word before (「유지법」), not a how-to (「받는 법」) and not 「마법」
// v0.7.2 0): law · decree · statute · act · currency · money beside 법 · 령 · 제도 · 화폐
const LAW_NAME = /([^\s마]법(\s|$)|령(\s|$)|규칙|제도)|\b(?:laws?|decrees?|statutes?|acts?|codes?|charters?|treaty|treaties|rules?|regulations?|edicts?)\b/i;
const WORLD_SYSTEM = /([^\s마]법(\s|$)|령(\s|$)|제도|화폐|통화)|\b(?:laws?|decrees?|statutes?|acts?|codes?|charters?|treaty|treaties|rules?|regulations?|edicts?)\b|\b(?:currency|currencies|money|coinage|coins?|exchange rates?|galleons?)\b/i;
const ONCE_TYPES = new Set(['rule', 'system', 'custom', 'history']);
// v0.6.5 1: only the whole world's (or nobody said where) — a rule or system of a place or group stays, and goes into
// the scenes there (「여기」) even when one batch spoke of it (배정식 · 금지된 숲)
const onceOnly = (e) => ONCE_TYPES.has(e?.type) && !(e.appliesTo && e.appliesTo !== WORLD) && !e.pinned && e.provenance?.source !== 'manual' && !Object.values(e.sources || {}).includes('manual') && !LAW_NAME.test(String(e.name || '')) && Number.isFinite(e.seen?.n) && e.seen.n < 2;

function assembleWorld(world, entities, budget = world?.injectChars ?? 3000, { scene = null, relations = [], scores = null, today = null, names = 'ko', recurring = null } = {}) {
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
  const once = (entities || []).filter(onceOnly).length;
  let pool = (entities || []).filter((e) => !onceOnly(e));
  let skipped = 0;
  const byIdAll = new Map((entities || []).map((x) => [x.entityId, x]));
  const nameOf = (id) => byIdAll.get(id)?.name || '';
  const knownOf = (id) => R.rosterOf(entities, relations, id)?.counts.known ?? null;
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
      // v0.6.2: a place whose 위치 칸 names a group (교장실 → 호그와트) is in that group: its rules · 시간표 · 학사일정 are here too
      if (e?.type === 'place') { const g = groupOfPlace(e, entities); if (g) add(g.entityId, here.get(id) + 1); }
    }
    const ruleLike = (e) => ALWAYS.has(e.type);
    const whereKnown = (e) => ruleLike(e) && e.appliesTo && e.appliesTo !== WORLD && byIdAll.has(e.appliesTo);
    const sheetHere = (e) => (e.timetable && (scene.has(e.timetable.ownerId) || here.has(e.timetable.ownerId))) || (e.calendar?.ownerId && (scene.has(e.calendar.ownerId) || here.has(e.calendar.ownerId)));
    const worldCalendar = (e) => e.calendar && !e.calendar.ownerId;
    // v0.6.4 b: a system for the whole world (「세계 전체」) only when it is pinned, named in the latest messages (the
    // scene), or a law · 화폐 by name — the know-how of one shop is not in every scene. Rules and 「모름」 as before.
    const everywhereOk = (e) => e.type !== 'system' || e.appliesTo !== WORLD || e.pinned || scene.has(e.entityId) || WORLD_SYSTEM.test(String(e.name || ''));
    const keep = pool.filter((e) => e.pinned || scene.has(e.entityId) || sheetHere(e) || worldCalendar(e) || (ruleLike(e) && (!whereKnown(e) || here.has(e.appliesTo)) && everywhereOk(e)));
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
    // v0.7.2 A: within a part — named in the latest messages, the nearer place, spoken of more often, the latest
    // evidence; the name only breaks a tie (it used to decide what the budget cut)
    ordered = keep.filter((e) => e.status === 'confirmed').map((e) => [rank(e), e]).sort(([ra, a], [rb, b]) => ra - rb
      // v0.7.5: here, the rules of the scene's own place first (Great Hall), then the place it is in (Hogwarts) …
      || (ra === 3 ? near(a) - near(b) : 0)
      || (ra >= 2 ? named(a) - named(b) : 0)
      || often(a, b)
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
      const line = entityLine(e, nameOf, today, names, knownOf);
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
  // v0.5.1 T: the two last lines take their room first, right after the pinned ones (each that fits)
  const tail = tailLines(world, entities || [], { recurring, names });
  const reserve = () => { for (const l of tail.lines) if (used + 2 + l.length <= budget) { used += 2 + l.length; tail.kept.push(l); } };
  if (part) {
    // v0.5.0 D: pinned and the scene first; what is left goes at most a third to the rules of the whole world, the
    // rest to the rules · 시간표 here — a part that does not use its share leaves it to the other — then the unknown.
    const of = (k) => ordered.filter((e) => part(e) === k);
    fill(of(0), budget);
    reserve();
    fill(of(1), budget);
    // v0.7.4 4: the whole world's laws · money are not always first — those named in the latest messages right after
    // the scene, the rest only after the rules of this place, and all of them within a third
    const worldCap = used + Math.floor((budget - used) / 3);
    const worldNamed = of(2).filter((e) => scene.has(e.entityId));
    const worldRest = of(2).filter((e) => !scene.has(e.entityId));
    fill(worldNamed, worldCap);
    fill(of(3), budget);
    fill(worldRest, Math.max(worldCap, used));
    fill([...of(4), ...of(5)], budget);
  } else {
    fill(ordered.filter((e) => e.pinned), budget);
    reserve();
    fill(ordered, budget);
  }
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
  if (tail.kept.length) parts.push(tail.kept.join('\n'));
  const text = parts.join('\n\n');
  return { text, chars: text.length, budget, included, omitted, skipped, once };
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

module.exports = { onceOnly, ONCE_TYPES, WORLD_SYSTEM, LAW_NAME, WORLD, shownName, tailLines, CAST_CHARS, assembleWorld, assembleLooks, orderEntities, sanitize, TYPE_LABEL, TYPE_ORDER, ALWAYS, LOOKS_CHARS };
