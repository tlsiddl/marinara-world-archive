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
// Two people whose own names are both a given name and a family name, with different family names, are never one
// person — even when they share an other name (「줄리안 에이버리」 · 「줄리안 베인」, both also "Julian").
// Two people whose own names are both a given name and a family name are compared only through names of several
// words: a one-word other name ("Vane", "Duke") or the shared family name alone never makes 「에드워드 베인」 and
// 「캐서린 베인」 one person — the given names must match too, or a whole name of several words be the same.
// A way of addressing ("His Grace", "Your Majesty") is no name at all.
// Words are compared whole: 「공작」 is not 「공작부인」 (a rank keeps the title written onto it).

/** Titles and honorifics that are a word of their own ("Professor Snape", "스네이프 교수", "마담 폼프리"). */
const TITLE_WORDS = new Set([
  '교수', '교수님', '선생', '선생님', '부인', '여사', '씨', '님', '마담', '경', '양', '군', '박사', '미스터', '미세스', '미스', '레이디',
  'mr', 'mrs', 'ms', 'miss', 'madam', 'madame', 'mme', 'professor', 'prof', 'sir', 'dame', 'lady', 'lord', 'dr',
]);
/** Titles written onto the name ("스네이프교수님", "젬마씨"); taken off only when two letters or more are left. */
const TITLE_ENDINGS = ['선생님', '교수님', '선생', '교수', '부인', '여사', '박사', '님', '씨'];

/** Ranks: 「공작부인」 is a title of its own (the duchess), not 「공작」 with 「부인」 written onto it. */
const RANKS = new Set(['공작', '후작', '백작', '자작', '남작', '대공', '왕', '국왕', '여왕', '황제', '황후', '왕비', '왕자', '공주', '영주']);
/** Words that make a name a role, not a given name and a family name (「슬리데린 5학년 반장」). */
const ROLE = /\d|반장|사감|감독|회장|단장|대장|주인|장수|학생|학년|하인|집사|관리인|수위|사서|선배|후배|기사단/;

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
      if (w.endsWith(end) && len(w) - len(end) >= 2 && !RANKS.has(w.slice(0, -end.length))) {
        w = w.slice(0, -end.length);
        break;
      }
    }
    out.push(w);
  }
  return out;
}

/** Ways of addressing someone ("His Grace", "Your Majesty"): said to many people, never a name of one. */
const ADDRESS = /^(?:his|her|your|their|my)(?:grace|majesty|highness|lordship|ladyship|excellency|honou?r|lord|lady)$/;

/**
 * Every name and other name of a person, as { text, words, key }; keys shorter than two letters and ways of
 * addressing are left out.
 */
function forms(e) {
  const out = [];
  const seen = new Set();
  for (const text of [e.name, ...(e.aliases || [])]) {
    const w = words(text);
    const key = w.join('');
    if (len(key) < 2 || seen.has(key) || ADDRESS.test(key)) continue;
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

/** A name of a given name and a family name: two to four words of letters, none a rank, not a role. */
const personal = (f) => f.words.length >= 2 && f.words.length <= 4 && f.words.every((w) => /^\p{L}+$/u.test(w) && !RANKS.has(w)) && !ROLE.test(f.text);
const script = (w) => (/[가-힣]/.test(w) ? 'ko' : /[a-z]/.test(w) ? 'latin' : 'other');

/** Family names (last words) of a person's personal names and other names, by script. */
function families(fs) {
  const out = new Map();
  for (const f of fs) {
    if (!personal(f)) continue;
    const last = f.words.at(-1);
    const s = script(last);
    if (!out.has(s)) out.set(s, new Set());
    out.get(s).add(last);
  }
  return out;
}

/**
 * Both people's own names are a given name and a family name, and their family names differ (compared within one
 * script, so 「줄리안 에이버리」 and "Julian Avery" are not told apart by spelling; any family name in common wins).
 */
function otherFamilies(fa, fb) {
  const na = fa.find((f) => !f.alias);
  const nb = fb.find((f) => !f.alias);
  if (!na || !nb || !personal(na) || !personal(nb)) return false;
  const A = families(fa);
  const B = families(fb);
  let differ = false;
  for (const [s, set] of A) {
    const other = B.get(s);
    if (!other) continue;
    if ([...set].some((x) => other.has(x))) return false;
    differ = true;
  }
  return differ;
}

/** Why two people may be one, or null. */
function whySame(a, b) {
  const fa = forms(a);
  const fb = forms(b);
  if (otherFamilies(fa, fb)) return null;
  // both own names a given name and a family name: only names of several words count (a family is not one person)
  const na = fa.find((f) => !f.alias);
  const nb = fb.find((f) => !f.alias);
  const full = na && nb && personal(na) && personal(nb);
  // the people's own names first, then other names
  const order = (f) => [...f.filter((x) => !x.alias), ...f.filter((x) => x.alias)];
  for (const x of order(fa)) for (const y of order(fb)) {
    if (full && (x.words.length < 2 || y.words.length < 2)) continue;
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

/**
 * 「가스파르의 5학년 누나」: a person named by description. The person it is said about (X) is found by name or given
 * name; named people who are X's family (a 가족 relation, or X's family name) are suggested as possibly the same.
 * Never merged by itself. The named one comes first (the one more likely to stay).
 */
function describedPairs(entities, relations = [], skip = () => false) {
  const people = entities.filter((e) => e.type === 'person');
  const plain = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');
  const described = people.filter((e) => /의\s/.test(e.name));
  const named = people.filter((e) => !/의\s/.test(e.name));
  const out = [];
  for (const d of described) {
    const x = d.name.split(/의\s/)[0].trim();
    const ref = named.find((p) => [p.name, ...(p.aliases || [])].some((n) => plain(n) === plain(x) || plain(String(n).split(/\s+/)[0]) === plain(x)));
    if (!ref) continue;
    const fam = String(ref.name).trim().split(/\s+/);
    const surname = fam.length > 1 ? fam.at(-1) : null;
    const kin = new Set(relations.filter((r) => r.type === '가족' && (r.from === ref.entityId || r.to === ref.entityId)).map((r) => (r.from === ref.entityId ? r.to : r.from)));
    for (const p of named) {
      if (p === ref || p === d) continue;
      const sameFamily = surname && String(p.name).trim().split(/\s+/).length > 1 && String(p.name).trim().split(/\s+/).at(-1) === surname;
      if (!kin.has(p.entityId) && !sameFamily) continue;
      if (skip(p.entityId, d.entityId)) continue;
      out.push({ a: p.entityId, b: d.entityId, why: `「${d.name}」은(는) 이름 있는 인물일 수 있음 (${ref.name}의 가족)` });
    }
  }
  return out;
}

module.exports = { words, forms, whySame, findPairs, describedPairs, TITLE_WORDS };
