'use strict';
// 「같은 사람일 수 있음」: people whose names or other names say they may be one person. Only ever a suggestion —
// nothing here merges anything. (The Memory Module's names.cjs compares spellings and sounds of names used in a
// chat; here the names are the world's own settings, so the rule is about names and titles, written fresh.)
//
// The rule, on every name and other name of two people, after titles and spaces are taken off:
//   1. the same name                                       (「젬마」 · alias "prefect" on both)
//   2. a one-word name that is a whole word of the other   (「스네이프」 in 「세베루스 스네이프」)
//   3. a name of several words all found in the other      (「해리 포터」 in 「해리 제임스 포터」)
//   4. a Korean given name and the same name with a one-syllable surname before it (「지은」 · 「박지은」)
// Sharing one word between two names of several words is not enough: 「캐서린 베인」, 「줄리안 베인」 and
// 「베인 공작」 are a family, not one person.

/** Titles and honorifics that are a word of their own ("Professor Snape", "스네이프 교수", "마담 폼프리"). */
const TITLE_WORDS = new Set([
  '교수', '교수님', '선생', '선생님', '부인', '여사', '씨', '님', '마담', '경', '양', '군', '박사', '미스터', '미세스', '미스', '레이디',
  'mr', 'mrs', 'ms', 'miss', 'madam', 'madame', 'mme', 'professor', 'prof', 'sir', 'dame', 'lady', 'lord', 'dr',
]);
/** Titles written onto the name ("스네이프교수님", "젬마씨"); taken off only when two letters or more are left. */
const TITLE_ENDINGS = ['선생님', '교수님', '선생', '교수', '부인', '여사', '박사', '님', '씨'];

const HANGUL = /^[가-힣]+$/;
const len = (s) => [...s].length;

/** A name as words, titles taken off. Empty when nothing but titles was written. */
function words(name) {
  const plain = String(name || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[.,·・:;!?~"“”「」『』《》〈〉()[\]{}\-_/\\|]+/g, ' ');
  const out = [];
  for (let w of plain.split(/\s+/)) {
    if (!w || TITLE_WORDS.has(w)) continue;
    for (const end of TITLE_ENDINGS) {
      if (w.endsWith(end) && len(w) - len(end) >= 2) {
        w = w.slice(0, -end.length);
        break;
      }
    }
    out.push(w);
  }
  return out;
}

/** Every name and other name of a person, as { text, words, key }; keys shorter than two letters are left out. */
function forms(e) {
  const out = [];
  const seen = new Set();
  for (const text of [e.name, ...(e.aliases || [])]) {
    const w = words(text);
    const key = w.join('');
    if (len(key) < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, words: w, key, alias: text !== e.name });
  }
  return out;
}

/** Why two names may be one person (a short reason), or null. a and b are forms(). */
function whyForms(x, y) {
  if (x.key === y.key) {
    if (x.text.toLowerCase() !== y.text.toLowerCase()) return `같은 이름 「${x.text}」 · 「${y.text}」`;
    return x.alias || y.alias ? `같은 이름 「${x.text}」` : '이름이 같음';
  }
  const [s, l] = x.words.length <= y.words.length ? [x, y] : [y, x];
  if (s.words.length === 1 && l.words.length >= 2 && l.words.includes(s.key)) return `「${s.text}」 · 「${l.text}」의 일부`;
  if (s.words.length >= 2) {
    const left = [...l.words];
    if (s.words.every((w) => { const i = left.indexOf(w); if (i < 0) return false; left.splice(i, 1); return true; })) return `「${s.text}」 · 「${l.text}」의 일부`;
  }
  if (x.words.length === 1 && y.words.length === 1 && HANGUL.test(x.key) && HANGUL.test(y.key)) {
    const [g, f] = len(x.key) < len(y.key) ? [x, y] : [y, x];
    if (len(g.key) >= 2 && len(f.key) === len(g.key) + 1 && f.key.endsWith(g.key)) return `「${g.text}」 · 「${f.text}」에서 성을 뺀 이름`;
  }
  return null;
}

/** Why two people may be one, or null. */
function whySame(a, b) {
  const fa = forms(a);
  const fb = forms(b);
  // the people's own names first, then other names
  const order = (f) => [...f.filter((x) => !x.alias), ...f.filter((x) => x.alias)];
  for (const x of order(fa)) for (const y of order(fb)) {
    const why = whyForms(x, y);
    if (why) return why;
  }
  return null;
}

/**
 * Pairs of people that may be one person: [{ a, b, why }] (entity ids). Candidates are found through an index of
 * name keys and words, so a world with many people is not compared pair by pair. skip(a, b) leaves a pair out.
 */
function findPairs(entities, skip = () => false) {
  const people = entities.filter((e) => e.type === 'person');
  const index = new Map(); // key or word -> Set of people
  const add = (k, e) => {
    if (!index.has(k)) index.set(k, new Set());
    index.get(k).add(e);
  };
  for (const e of people) for (const f of forms(e)) {
    add(`k:${f.key}`, e);
    for (const w of f.words) add(`w:${w}`, e);
  }
  const filled = (e) => Object.values(e.fields || {}).filter(Boolean).length + (e.description ? 1 : 0) + (e.aliases || []).length;
  const out = [];
  const done = new Set();
  for (const e of people) {
    const near = new Set();
    for (const f of forms(e)) {
      for (const k of [`k:${f.key}`, ...f.words.map((w) => `w:${w}`)]) for (const o of index.get(k) || []) near.add(o);
      // a given name without the one-syllable surname in front
      if (f.words.length === 1 && HANGUL.test(f.key) && len(f.key) >= 3) for (const o of index.get(`k:${[...f.key].slice(1).join('')}`) || []) near.add(o);
    }
    for (const o of near) {
      if (o === e) continue;
      const pair = [e.entityId, o.entityId].sort().join('|');
      if (done.has(pair)) continue;
      done.add(pair);
      if (skip(e.entityId, o.entityId)) continue;
      const why = whySame(e, o);
      if (!why) continue;
      // the fuller one first: the one more likely to stay
      const [a, b] = filled(o) > filled(e) || (filled(o) === filled(e) && o.createdAt < e.createdAt) ? [o, e] : [e, o];
      out.push({ a: a.entityId, b: b.entityId, why });
    }
  }
  return out;
}

module.exports = { words, forms, whySame, findPairs, TITLE_WORDS };
