'use strict';
// Names that follow the room's translation glossary (「번역 프리셋·단어장」: "Severus Snape = 세베루스 스네이프").
// The glossary is only read, never written. Pure functions: which pairs a batch needs, which pair names a setting,
// what the setting's name would become, and the room's names in the glossary's own shape (for GET …/names).
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

/** The glossary pair a setting is named by (its name first, then its other names), or null. */
function pairFor(e, pairs) {
  const index = new Map();
  for (const p of pairs || []) for (const n of [p.from, p.to]) if (!index.has(key(n))) index.set(key(n), p);
  for (const n of [e.name, ...(e.aliases || [])]) {
    const p = index.get(key(n));
    if (p) return p;
  }
  return null;
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
 * The world's names in the glossary's shape: [{ original, translation, kind }] — settings with a Korean name and a
 * romanized other name. The original is the romanized other name with the most words once titles are taken off
 * ("Severus Snape" before "Professor Snape" and "Snape"), then the longest.
 */
function glossaryNames(entities) {
  const out = [];
  for (const e of entities) {
    if (!hasHangul(e.name) || hasLatin(e.name)) continue;
    const latin = (e.aliases || []).filter(latinOnly);
    if (!latin.length) continue;
    const best = latin.reduce((a, b) => {
      const wa = words(a).length;
      const wb = words(b).length;
      return wb > wa || (wb === wa && b.length > a.length) ? b : a;
    });
    out.push({ original: best, translation: e.name, kind: KIND_KO[e.type] || '기타' });
  }
  return out;
}

module.exports = { key, hashPairs, pairsInText, pairFor, planFor, manualName, glossaryNames, latinOnly, KIND_KO };
