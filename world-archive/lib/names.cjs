'use strict';
// Names that follow the room's translation glossary (「번역 프리셋·단어장」: "Severus Snape = 세베루스 스네이프").
// The glossary is only read, never written. Pure functions: which pairs a batch needs, which pair names a setting,
// what the setting's name would become, and the room's names in the glossary's own shape (for GET …/names).
// Only people, places and groups follow the glossary, and only a pair that is the setting's whole name renames it:
// a part of a name ("Gaspard" of 「가스파르 셀윈」) or a related term ("Slytherin" of 「호그와트 지하 기숙사」) never does.
const crypto = require('node:crypto');
const { words } = require('./same.cjs');

/** For matching a name to a glossary side: NFC, lower case, no spaces or quote marks. */
const key = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[\s"'“”‘’「」『』《》〈〉]+/g, '');
const hasHangul = (s) => /[가-힣]/.test(s);
const hasLatin = (s) => /[A-Za-z]/.test(s);
/** Written in Latin letters (romanized), no Hangul. */
const latinOnly = (s) => hasLatin(s) && !hasHangul(s);

const KIND_KO = { person: '인물', place: '장소', group: '집단', rule: '규칙', system: '시스템', schedule: '일정', history: '역사', custom: '기타' };

/** A short hash of the pairs, to tell when a room's glossary changed. */
const hashPairs = (pairs) => crypto.createHash('sha1').update(JSON.stringify(pairs.map((p) => [p.from, p.to]))).digest('hex').slice(0, 20);

/** The pairs whose either side appears in the text (for the reader's prompt). */
function pairsInText(pairs, text) {
  const t = key(text);
  return (pairs || []).filter((p) => [p.from, p.to].some((n) => { const k = key(n); return k.length >= 2 && t.includes(k); }));
}

/** Kinds the glossary names: proper nouns only (a rule or a schedule is never renamed, nor offered to the glossary). */
const NAMED_KINDS = new Set(['person', 'place', 'group']);
const wordCount = (s) => words(s).length;

/**
 * The romanized other name that stands for the whole setting: the one with the most words once titles are taken off
 * ("Severus Snape" before "Professor Snape" and "Snape"), then the longest. null when there is none.
 */
function longestLatin(e) {
  const latin = (e.aliases || []).filter(latinOnly);
  if (!latin.length) return null;
  return latin.reduce((a, b) => {
    const wa = wordCount(a);
    const wb = wordCount(b);
    return wb > wa || (wb === wa && b.length > a.length) ? b : a;
  });
}

/**
 * Which glossary pairs name setting e: { full, short }, or null (also for kinds the glossary never names).
 *   full — the pair is the setting's whole identity: its name is the pair's Korean side (already right), or its name
 *     or its longest romanized other name is the pair's romanized side and the pair has at least as many words as
 *     that other name. A one-word pair never names a setting whose own name has several words (「가스파르 셀윈」 is
 *     not "Gaspard", 「크리스핀 플리트」 not "Fleet"). When several pairs do, the one with the most words wins.
 *   short — one-word pairs ("Gaspard = 가스파르", "Bea = 비아") with a side among the other names of a setting whose
 *     own name has several words: they may become other names, never the name.
 */
function matchFor(e, pairs) {
  if (!NAMED_KINDS.has(e.type)) return null;
  const name = key(e.name);
  const nameWords = wordCount(e.name);
  const long = longestLatin(e);
  const longKey = long ? key(long) : null;
  const longWords = long ? wordCount(long) : 0;
  const aliasKeys = new Set((e.aliases || []).map(key));
  let full = null;
  const short = [];
  for (const p of pairs || []) {
    const from = key(p.from);
    const to = key(p.to);
    const pw = wordCount(p.from);
    const whole = name === to || ((name === from || longKey === from) && pw >= longWords && !(pw <= 1 && nameWords >= 2));
    if (whole) {
      if (!full || pw > wordCount(full.from)) full = p;
    } else if (pw <= 1 && nameWords >= 2 && (aliasKeys.has(from) || aliasKeys.has(to))) short.push(p);
  }
  return full || short.length ? { full, short } : null;
}

/** The glossary pair a setting is named by as a whole (matchFor's full), or null. */
function pairFor(e, pairs) {
  return matchFor(e, pairs)?.full || null;
}

/** A name the person chose: typed into the name box, a setting the person made, or a rename the person undid. */
const manualName = (e) => e.sources?.name === 'manual' || e.provenance?.source === 'manual' || e.nameKept === true;

/**
 * What following pair p means for setting e, given the other settings' names (taken: Set of keys):
 *   { rename: { name, aliases, added, removed } } — the glossary's Korean becomes the name, the old name and the
 *     original (romanized) form go to other names;
 *   { suggest: name } — the person chose the name: only a suggestion is kept;
 *   { alias: original } — the name is already right, the original form is not among the other names yet;
 *   null — nothing to do (also when another setting already has the glossary's name: both stay, and 「같은 사람일 수
 *     있음」 shows them).
 * aliasMax / aliasLen: the store's limits.
 */
function planFor(e, p, taken, { aliasMax = 20, aliasLen = 60 } = {}) {
  const has = (list, n) => list.some((a) => key(a) === key(n));
  if (e.name === p.to) return has(e.aliases, p.from) || e.aliases.length >= aliasMax ? null : { alias: p.from };
  if (taken.has(key(p.to))) return null;
  // never shortened to a part of the name it has (「가스파르 셀윈」 does not become 「가스파르」)
  if (key(e.name) !== key(p.to) && key(e.name).includes(key(p.to))) return null;
  if (manualName(e)) return { suggest: p.to };
  const removed = e.aliases.filter((a) => key(a) === key(p.to));
  const aliases = e.aliases.filter((a) => key(a) !== key(p.to));
  const added = [];
  for (const n of [e.name, p.from]) {
    if (key(n) === key(p.to) || has(aliases, n) || n.length > aliasLen || aliases.length >= aliasMax) continue;
    aliases.push(n);
    added.push(n);
  }
  return { rename: { name: p.to, aliases, added, removed } };
}

/**
 * The other names a short pair (matchFor's short) adds to setting e: the pair's sides not yet among e's names, never
 * a side that is another setting's name (taken: Set of keys), within the store's limits.
 */
function shortAliases(e, p, taken, { aliasMax = 20, aliasLen = 60 } = {}) {
  const have = new Set([e.name, ...e.aliases].map(key));
  const out = [];
  for (const n of [p.from, p.to]) {
    if (have.has(key(n)) || taken.has(key(n)) || n.length > aliasLen || e.aliases.length + out.length >= aliasMax) continue;
    have.add(key(n));
    out.push(n);
  }
  return out;
}

/**
 * The world's names in the glossary's shape: [{ original, translation, kind }] — people, places and groups (proper
 * nouns only; rules, systems, schedules, history and the rest are not names to translate) with a Korean name and a
 * romanized other name. The original is longestLatin().
 */
function glossaryNames(entities, cache = {}) {
  const out = [];
  for (const e of entities) {
    if (!NAMED_KINDS.has(e.type)) continue;
    if (hasHangul(e.name) && !hasLatin(e.name)) {
      const best = longestLatin(e);
      if (best) out.push({ original: best, translation: e.name, kind: KIND_KO[e.type] });
      continue;
    }
    // v0.7.2 J: a world organized in English — the name as written, its Korean other name (or the Korean view's fixed one)
    if (!hasLatin(e.name) || hasHangul(e.name)) continue;
    const ko = (e.aliases || []).find((a) => hasHangul(a) && !hasLatin(a)) || cache[e.name];
    if (ko) out.push({ original: e.name, translation: ko, kind: KIND_KO[e.type] });
  }
  return out;
}
/** v0.7.2 J: the name pairs of a world organized in English — whole names and, for two words to two words, each word. */
function englishNamePairs(entities, cache = {}) {
  const out = [];
  for (const p of glossaryNames(entities, cache)) {
    if (!hasLatin(p.original)) continue;
    out.push({ from: p.original, to: p.translation });
    const a = p.original.trim().split(/\s+/);
    const b = p.translation.trim().split(/\s+/);
    // Titles do not align word-for-word across languages: Mrs Pell = 펠 부인,
    // not Mrs = 펠 or Pell = 부인. Keep the whole pair, never its fragments.
    const titleEn = /^(?:mr|mrs|ms|miss|mister|madam|lady|lord|sir|dr|doctor|prof|professor|captain|capt|rev|reverend)\.?$/i;
    const titleKo = /(?:부인|여사|아가씨|선생님|교수님|교수|박사님|박사|경|공작|백작|남작)$/;
    if (a.length === 2 && b.length === 2 && !a.some((word) => titleEn.test(word)) && !b.some((word) => titleKo.test(word))) for (let i = 0; i < 2; i++) if (a[i].length >= 3) out.push({ from: a[i], to: b[i] });
  }
  return out;
}

module.exports = { key, hashPairs, pairsInText, matchFor, pairFor, planFor, shortAliases, manualName, glossaryNames, englishNamePairs, longestLatin, latinOnly, KIND_KO, NAMED_KINDS };
