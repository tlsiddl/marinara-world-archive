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
const ROLE = /\d|반장|사감|감독|회장|단장|대장|주인|장수|학생|학년|하인|집사|관리인|수위|사서|선배|후배|기사단|\b(?:prefects?|head|captain|students?|years?|first-years?|servants?|butler|caretaker|librarian|keeper|knights?|maids?|footman|valet|governess|nanny|owner|clerk)\b/i;

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

/** A name that is only a 종: another person's 종 is it, or ends in it (「크니즐」 and 「하프 크니즐」). */
function speciesName(name, species) {
  const plain = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');
  const n = plain(name);
  const sp = String(species || '').trim();
  if (n.length < 2 || !sp) return false;
  return plain(sp) === n || plain(sp.split(/\s+/).at(-1)) === n;
}

/**
 * 「크니즐」: a person setting that is only a 종 name (made before the reader was told not to) — suggested as possibly
 * the person whose 종 it is (「베아트릭스」, 종 하프 크니즐). Never merged by itself; the named one comes first.
 * Only another individual of that kind counts: a setting whose own name is its 종 (「거대 오징어」, 「그린디로」) is
 * the creature itself when nothing else has that 종, and is never suggested.
 */
function speciesPairs(entities, skip = () => false) {
  const people = entities.filter((e) => e.type === 'person');
  const out = [];
  for (const p of people) {
    const sp = String(p.fields?.species || '').trim();
    if (!sp || speciesName(p.name, sp)) continue; // the kind itself, not another individual of it
    for (const s of people) {
      if (s === p || !speciesName(s.name, sp) || skip(p.entityId, s.entityId)) continue;
      out.push({ a: p.entityId, b: s.entityId, why: `「${s.name}」은(는) 종 이름일 수 있음 (${p.name}의 종: ${sp})` });
    }
  }
  return out;
}

/**
 * Places, groups, rules, systems, schedules that may be one (v0.5.0 F — 「같은 것일 수 있음」, never merged by itself).
 * Same kind; an other name the same, or one name's words all in the other's after a few same-meaning words are
 * read alike (특급 · 급행, 여자 · 여학생, 침실 · 기숙사 …). Not two places one inside the other (위치), not two groups one
 * in the other (소속), not two rules said to hold in different places. [{ a, b, why }], the fuller one first.
 */
const THING_TYPES = new Set(['place', 'group', 'rule', 'system', 'schedule', 'custom']);
const SAME_WORD = new Map([['특급', '급행'], ['특급열차', '급행열차'], ['여자', '여학생'], ['남자', '남학생'], ['침실', '기숙사'], ['숙소', '기숙사'], ['기숙사방', '기숙사'], ['지하실', '지하'], ['지하감옥', '지하'], ['감옥', '지하'], ['express', '급행열차'],
  // v0.7.2 0): English words read alike (plural, the same thing said two ways)
  ['bedroom', 'dormitory'], ['bedchamber', 'dormitory'], ['dorm', 'dormitory'], ['quarters', 'dormitory'], ['dungeon', '지하'], ['cellar', '지하'], ['basement', '지하'], ['underground', '지하'],
  ['carriage', 'car'], ['coach', 'car'], ['compartment', 'car'], ['loch', 'lake'], ['lavatory', 'washroom'], ['bathroom', 'washroom'], ['toilet', 'washroom'], ['lesson', 'class'], ['lessons', 'class']]);
const PLAIN_WORDS = new Set(['기숙사', '학교', '마법학교', '건물', '본관', '교실', '전용', '공용', '의',
  'the', 'a', 'an', 'of', 'house', 'school', 'building', 'main', 'dormitory', 'classroom', 'hall', 'castle', 'side']);
/** Word ends that are words of their own when they stick to the word before (「급행열차」 → 급행 · 열차). */
const TAIL_WORDS = ['열차', '기숙사', '휴게실', '교실', '침실', '지하실', '감옥', '선착장', '도서관', '사무실'];
const splitWord = (w) => {
  const t = TAIL_WORDS.find((x) => w.length > x.length && w.endsWith(x));
  return t ? [w.slice(0, -t.length), t] : [w];
};
// v0.7.2 0): English words one by one — hyphens apart, a plural as its singular (dormitories · dungeons), "the" away
const singular = (w) => (!/^[a-z]{4,}$/.test(w) ? w : w.endsWith('ies') ? w.slice(0, -3) + 'y' : /(ss|us|is)$/.test(w) ? w : w.endsWith('s') ? w.slice(0, -1) : w);
const thingWords = (name) => String(name || '').normalize('NFC').toLowerCase().replace(/[()「」『』"'“”‘’·,.]/g, ' ').replace(/(?<=[a-z])-(?=[a-z])/g, ' ').split(/\s+/).filter(Boolean).flatMap(splitWord).map(singular).map((w) => SAME_WORD.get(w) || w).filter((w) => w !== 'the');
function thingPairs(entities, relations = [], skip = () => false) {
  const linked = new Set((relations || []).filter((r) => r.type === '위치' || r.type === '소속').flatMap((r) => [r.from + '|' + r.to, r.to + '|' + r.from]));
  const filled = (e) => Object.values(e.fields || {}).filter(Boolean).length + (e.description ? 1 : 0) + (e.aliases || []).length;
  const key = (n) => String(n || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');
  // the words of the names of groups and places the world has
  const known = new Set(entities.filter((e) => e.type === 'group' || e.type === 'place').flatMap((e) => [e.name, ...(e.aliases || [])]).filter((n) => !/\s/.test(String(n).trim())).map((n) => String(n).normalize('NFC').toLowerCase()).flatMap((n) => [n, singular(n)]));
  // v0.7.2 D: two 시간표 that hold the same cells (a house's and its first-years') — 「같은 것일 수 있음」, never merged
  // (the subject only: 「Charms」 · 「Charms (with Ravenclaw)」 are one class)
  const cellsOf = (e) => new Set(Object.values(e.timetable?.cells || {}).map((c) => `${c.day}|${c.slot}|${String(c.subject || c.value || '').replace(/\s*[(（].*$/, '').trim().toLowerCase()}`));
  const byType = new Map();
  // v0.6.2 ②: rules and systems are looked at together (「애니마구스 등록」 a rule and a system)
  const kindKey = (t) => (t === 'rule' || t === 'system' ? 'rule|system' : t);
  for (const e of entities) if (THING_TYPES.has(e.type)) byType.set(kindKey(e.type), [...(byType.get(kindKey(e.type)) || []), e]);
  const out = [];
  for (const list of byType.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (skip(x.entityId, y.entityId) || linked.has(x.entityId + '|' + y.entityId)) continue;
      if (x.appliesTo && y.appliesTo && x.appliesTo !== y.appliesTo) continue;
      if (x.timetable && y.timetable) {
        const cx = cellsOf(x), cy = cellsOf(y);
        const both = [...cx].filter((c) => cy.has(c)).length;
        const less = Math.min(cx.size, cy.size);
        if (less >= 3 && both * 5 >= less * 4) {
          const [a, b] = cx.size >= cy.size ? [x, y] : [y, x];
          out.push({ a: a.entityId, b: b.entityId, why: `시간표 칸 ${both}개가 같음`, type: a.type });
        }
        continue;
      }
      if (x.timetable || y.timetable) continue;
      let why = null;
      const kx = new Set([x.name, ...(x.aliases || [])].map(key).filter((k) => k.length >= 2));
      const shared = [y.name, ...(y.aliases || [])].find((n) => kx.has(key(n)));
      if (shared) why = `같은 이름 「${shared}」`;
      else {
        // the words only one name has must say nothing new: a common word (기숙사 · 교실 …) or a name the world has
        // (호그와트 · 슬리데린) — 「호그와트 지하 선착장」 is a place in 「호그와트 지하」, not the same one
        const wx = thingWords(x.name), wy = thingWords(y.name);
        const [small, big] = wx.length <= wy.length ? [wx, wy] : [wy, wx];
        const extra = big.filter((w) => !small.includes(w));
        if (small.length >= 2 && small.every((w) => big.includes(w)) && extra.every((w) => PLAIN_WORDS.has(w) || known.has(w))) why = `이름 「${x.name}」 · 「${y.name}」`;
      }
      if (!why) continue;
      const [a, b] = filled(y) > filled(x) ? [y, x] : [x, y];
      out.push({ a: a.entityId, b: b.entityId, why: x.type !== y.type ? `${why} · 규칙과 시스템` : why, type: a.type });
    }
  }
  return out;
}

/**
 * v0.6.2 ②: rules and systems about the same thing that may say different things (「옷에 지팡이 주머니를 달 때는
 * 오른팔에」 · 「교복 로브의 지팡이 주머니는 손목집 위에」) — 「서로 다른 말을 해요」. Two words in a row that two names
 * or more share (the topic, 「지팡이 주머니」), where the rules hold for the same place or group (or nobody said).
 * Shown for the person to look at; nothing is changed. Returns [{ topic, ids }].
 */
const PARTICLE = /(을|를|은|는|의|에서|에|으로|까지|부터)$/;
function topicGroups(entities) {
  const list = (entities || []).filter((e) => (e.type === 'rule' || e.type === 'system') && !e.timetable && !e.calendar);
  const wordsOf = (n) => String(n || '').normalize('NFC').toLowerCase().split(/[\s·,.()「」]+/).map((w) => (w.length > 2 ? w.replace(PARTICLE, '') : w)).filter((w) => w.length >= 2);
  // the words of the world's place and group names: where a rule holds, not what it is about
  const scope = new Set((entities || []).filter((e) => e.type === 'place' || e.type === 'group').flatMap((e) => [e.name, ...(e.aliases || [])]).flatMap((n) => String(n).normalize('NFC').toLowerCase().split(/\s+/)).filter((w) => w.length >= 2));
  const by = new Map();
  for (const e of list) {
    const w = wordsOf(e.name);
    const seenHere = new Set();
    for (let i = 0; i + 1 < w.length; i++) {
      const k = `${w[i]} ${w[i + 1]}`;
      if (seenHere.has(k) || scope.has(w[i]) || scope.has(w[i + 1])) continue;
      seenHere.add(k);
      const at = `${e.appliesTo || ''}|${k}`;
      by.set(at, [...(by.get(at) || []), e.entityId]);
    }
  }
  // the biggest topics first; a group inside a bigger one with the same ids is the same group
  const out = [];
  for (const [at, ids] of [...by].sort((a, b) => b[1].length - a[1].length)) {
    if (ids.length < 2) continue;
    if (out.some((g) => ids.every((id) => g.ids.includes(id)))) continue;
    out.push({ topic: at.split('|')[1], ids });
  }
  return out;
}

module.exports = { topicGroups, thingPairs, words, forms, whySame, findPairs, describedPairs, speciesPairs, speciesName, TITLE_WORDS };
