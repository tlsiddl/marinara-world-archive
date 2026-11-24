'use strict';
// Adapted from marinara-shell server-patch/shell-lite.cjs, cfba3dec.
const looksNorm = (s) => String(s || '').toLowerCase().replace(/[\s·・,.'"!?()\-–—:;/~‘’“”「」『』]/g, '');
// 한국어 색 이름 → 단부루 색 낱말 (셸 H1 색 표와 같은 순서 · 「검은색」 안의 「은색」 때문에 검은이 먼저)
const LOOKS_COLORS = [
  [/검은|까만|검정|흑발|흑색|칠흑/, 'black'],
  [/백금발|플래티넘/, 'platinum blonde'],
  [/금발|금색|황금/, 'blonde'],
  [/(?<![붉짙옅밝깊낮넓])은(?:발|색|빛)/, 'silver'], // 0.42.0 「붉은색」 · 「짙은색」 안의 「은색」을 은발로 읽지 않게
  [/갈색|밤색|브라운|고동/, 'brown'],
  [/헤이즐/, 'brown'],
  [/호박/, 'yellow'],
  [/빨간|붉은|빨강|적발|다홍/, 'red'],
  [/주황|오렌지/, 'orange'],
  [/노란|노랑/, 'yellow'],
  [/초록|녹색|에메랄드|연두/, 'green'],
  [/하늘/, 'light blue'],
  [/남색|감색/, 'blue'],
  [/파란|푸른|파랑|청색|벽안/, 'blue'],
  [/보라|자주|바이올렛/, 'purple'],
  [/분홍|핑크/, 'pink'],
  [/회색|잿빛|회백|그레이/, 'grey'],
  [/흰|하얀|백발|흰색|백색/, 'white'],
];
const LOOKS_COLOR_WORD = LOOKS_COLORS.map(([re]) => re.source).join('|');
const LOOKS_HOUSES = { 그리핀도르: 'gryffindor', 슬리데린: 'slytherin', 래번클로: 'ravenclaw', 후플푸프: 'hufflepuff', gryffindor: 'gryffindor', slytherin: 'slytherin', ravenclaw: 'ravenclaw', hufflepuff: 'hufflepuff' };
/** 칸 값 → 단부루 색 낱말 (한국어 색 이름 · 영어 낱말 그대로 · #색코드만이면 없음) */
function looksColor(value) {
  const v = String(value || '').replace(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/gi, '').trim();
  if (!v) return '';
  const hit = LOOKS_COLORS.find(([re]) => re.test(v));
  if (hit) return hit[1];
  const en = v.toLowerCase().replace(/\s*(hair|eyes?)$/, '').trim();
  return /^[a-z][a-z \-]{1,30}$/.test(en) ? en : '';
}
/** 백과 외모 한 줄에서 분명할 때만 (「헝클어진 검은 머리, 초록 눈」 → { hair: 검은, eyes: 초록 }) */
function looksFromProse(text) {
  const t = String(text || '');
  const hair = t.match(new RegExp(`(${LOOKS_COLOR_WORD})(?:색)?\\s*(?:(?:긴|짧은|곱슬|곱슬곱슬한|헝클어진|부스스한|숱 많은|단정한|기름진|올려 묶은)\\s*)*(?:머리|머리카락|곱슬머리)|(백금발|금발|은발|흑발|백발)`));
  const eyes = t.match(new RegExp(`(${LOOKS_COLOR_WORD})(?:색)?\\s*(?:눈동자|눈)(?![가-힣])`));
  return { hair: hair ? hair[1] || hair[2] : '', eyes: eyes ? eyes[1] : '' };
}
const looksExtra = (e, labels) => {
  const want = labels.map(looksNorm);
  return String((e?.extra || []).find((x) => want.includes(looksNorm(x.label)) && String(x.value || '').trim())?.value || '').trim();
};
// The optional shell encyclopedia is not bundled.
const hpIndex = () => new Map();
// 0.37.1 H5 #19 동물은 설정집과 같은 낱말일 때만 hair 대신 fur · 백과(사람)는 안 봄 (집요정 · 고블린 · 유령 · 센티넬은 사람 칸 그대로) · 셸 www/shared/animal.js와 같은 목록
const LOOKS_ANIMALS = ["동물","animal","표범","leopard","panther","고양이","cat","kitten","개","강아지","dog","puppy","puppies","hound","늑대","wolf","wolves","여우","fox","foxes","부엉이","올빼미","owl","까마귀","raven","crow","뱀","snake","serpent","쥐","rat","mouse","mice","두꺼비","toad","불사조","phoenix","phoenixes","용","드래곤","dragon","사슴","stag","deer","곰","bear","토끼","rabbit","hare","말","horse","pony","ponies","니즐","크니즐","kneazle","half-kneazle","새","bird","페럿","ferret"];
const LOOKS_PERSON = /animagus|animagi|애니마구스|\bhuman\b|인간/i; // 0.43.4 애니마구스는 사람 (종 칸에 고양이 낱말이 있어도)
const looksAnimal = (p) => {
  if (LOOKS_PERSON.test(String(p?.fields?.species || ''))) return false;
  const words = String(p?.fields?.species || '').normalize('NFC').toLowerCase().split(/[^\p{L}-]+/u).filter(Boolean);
  return LOOKS_ANIMALS.some((x) => (/[a-z]/.test(x) ? words.includes(x) || words.includes(x + 's') : words.some((y) => y === x || (x.length >= 2 && y.endsWith(x)))))
    || (p?.tags || []).some((t) => /^(?:동물|animal)$/i.test(String(t).trim()));
};
// 0.37.0 답 글 안 <npc_profile> … </npc_profile>(사용자 프리셋 · 셸 0.15.80 시공간 카드 이름표와 같은 뽑기) · 닫힌 것만 · 가장 최근 것
const LOOKS_EN = new Set('black ebony jet brown chestnut tawny copper bronze blonde blond golden gold platinum silver silvery grey gray ash ashen slate white snowy cream ivory red crimson scarlet auburn ginger orange amber hazel yellow green emerald jade olive blue sapphire azure navy teal cyan violet purple lavender pink rose'.split(' '));
const LOOKS_EN_MOD = new Set('pale light dark deep'.split(' '));
const LOOKS_CUT = /[,，.。·;；:：()（）[\]\n/]|그리고|및/;
const LOOKS_PROFILE_RE = /<npc_profile\b[^>]*>([\s\S]*?)<\/npc_profile\s*>/gi;
function looksProfileFields(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\*\*|__/g, '').replace(/^\s*[-*•]\s*/, '').trim();
    if (!line) continue;
    for (const part of line.split(/\s+[/|｜]\s+|\s*｜\s*|\s+[·•]\s+(?=[^:：\s][^:：]{0,24}[:：])/)) {
      const m = part.match(/^\s*([^:：]{1,28}?)\s*[:：]\s*([\s\S]*)$/);
      if (m) out.push({ label: m[1].replace(/[*_`]/g, '').trim(), value: m[2].trim() });
      else if (out.length) out[out.length - 1].value += ` / ${part.trim()}`;
    }
  }
  return out;
}
/** 「밤색 머리」 · 「dark brown hair」 → 색 말 (같은 마디 안 · 이름 바로 앞) */
function looksColorNear(text, nounRe) {
  const t = String(text || '');
  const re = new RegExp(nounRe, 'gi');
  let m;
  while ((m = re.exec(t))) {
    const clause = t.slice(Math.max(0, m.index - 24), m.index).split(LOOKS_CUT).pop();
    const ko = [...clause.matchAll(new RegExp(`[가-힣]*(?:${LOOKS_COLOR_WORD})[가-힣]*`, 'g'))].pop()?.[0];
    if (ko) return ko;
    const words = clause.toLowerCase().split(/\s+/).filter(Boolean);
    const tail = [];
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (LOOKS_EN.has(w) || LOOKS_EN_MOD.has(w) || w.split('-').some((x) => LOOKS_EN.has(x))) tail.unshift(w);
      else if (/^(flat|dull|soft|warm|cool|bright|vivid)$/.test(w)) continue;
      else break;
    }
    if (tail.some((w) => LOOKS_EN.has(w) || w.includes('-'))) return tail.join(' ');
  }
  return '';
}
// 0.42.0 피부색: 추가 칸(피부색) → 외형 글의 「창백한 피부」 · 「pale skin」 (바로 앞 낱말만)
const LOOKS_SKIN = [[/창백|핏기/, 'pale'], [/뽀얀|새하얀|하얀|흰|백옥|우윳빛|상아/, 'fair'], [/구릿빛|그을린|태닝|황갈색|까무잡잡/, 'tan'], [/올리브/, 'olive'], [/갈색|밤색/, 'brown'], [/어두운|짙은|검은/, 'dark'], [/밝은/, 'light']];
const LOOKS_SKIN_EN = new Set('pale fair light tan tanned olive brown dark ebony porcelain ivory white black'.split(' '));
function looksSkin(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const hit = LOOKS_SKIN.find(([re]) => re.test(v));
  if (hit) return hit[1];
  const en = v.toLowerCase().replace(/\s*skin(?:ned)?$/, '').trim();
  return en && en.split(/[\s-]+/).every((w) => LOOKS_SKIN_EN.has(w)) ? en : '';
}
function looksSkinNear(text) {
  const t = String(text || '');
  const re = /피부|살결|살갗|\bskin\b/gi;
  let m;
  while ((m = re.exec(t))) {
    const words = t.slice(Math.max(0, m.index - 24), m.index).split(LOOKS_CUT).pop().trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const last = words[words.length - 1];
    if (/[가-힣]/.test(last)) {
      const ko = looksSkin(last);
      if (ko) return ko;
      continue;
    }
    const tail = [];
    for (let i = words.length - 1; i >= 0 && LOOKS_SKIN_EN.has(words[i].toLowerCase()); i--) tail.unshift(words[i].toLowerCase());
    if (tail.length) return tail.join(' ');
  }
  return '';
}
function looksProfile(text) {
  const fields = looksProfileFields(text);
  const name = (fields.find((f) => /^(?:이름|성명|name|full\s*name)$/i.test(f.label))?.value || '').trim();
  const looks = fields.filter((f) => /^(?:외모(?:\s*(?:및|&|와|과)\s*복장)?|외형|생김새|appearance(?:\s*(?:&|and)\s*attire)?|looks|physical(?:\s*description)?|attire)$/i.test(f.label)).map((f) => f.value).join(', ') || String(text || '');
  return {
    name,
    hair: looksColorNear(looks, String.raw`(?:머리카락|곱슬머리|머리)(?![가-힣]*(?:띠|핀|끈|장식|띄|위))|\bhair\b`),
    eyes: looksColorNear(looks, String.raw`(?:눈동자|눈)(?![가-힣])|\beyes?\b|\biris(?:es)?\b`),
    skin: looksSkinNear(looks),
  };
}
const looksClean = (s) => {
  let x = String(s || '').replace(/[　 ]/g, ' ').trim();
  for (let i = 0; i < 3; i++) x = x.replace(/\s*[(（[［【][^)）\]］】]*[)）\]］】]\s*$/u, '').trim();
  return x.replace(/[^\p{L}\p{N}\s'’"“”「」.-]+$/u, '').trim();
};
function looksProfileNames(raw) {
  const r = looksClean(raw);
  const nick = r.match(/["“”'‘’「『]([^"“”'‘’」』]+)["“”'‘’」』]/)?.[1] || '';
  const plain = r.replace(/\s*["“”'‘’「『][^"“”'‘’」』]*["“”'‘’」』]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const last = plain.split(' ').pop();
  return [plain, nick, nick && last && nick !== last ? `${nick} ${last}` : ''].filter(Boolean).map(looksNorm);
}
/** 글들(최근 것부터)의 <npc_profile> → [{ names, hair, eyes }] (최근 것부터) */
function looksProfilesFrom(texts) {
  const out = [];
  for (const t of texts) {
    const blocks = [...String(t || '').matchAll(LOOKS_PROFILE_RE)].map((m) => m[1]);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const p = looksProfile(blocks[i]);
      if (p.name) out.push({ names: looksProfileNames(p.name), hair: p.hair, eyes: p.eyes, skin: p.skin });
    }
  }
  return out;
}
/** 0.43.8 설정집 칸이 마디 통째(「Dark black hair greying at the temples」)여도 색만 읽음 */
const LOOKS_HAIR_NOUN = String.raw`\bhair\b|머리카락|머리`, LOOKS_EYE_NOUN = String.raw`\beyes?\b|\biris(?:es)?\b|눈동자|눈(?![가-힣])`;
function looksColorOf(value, noun) {
  const near = looksColorNear(value, noun);
  return (near && (looksColor(near) || near)) || looksColor(value);
}
/** 한 사람의 태그 ['black hair', 'green eyes', 'gryffindor uniform'] · 칸마다 설정집 → 예전 추가 칸 → <npc_profile> → 백과 · 동물이면 fur */
function personLookTags(name, people, profiles = []) {
  const l = personLooks(name, people, profiles);
  return [l.hair && `${l.hair} ${l.animal ? 'fur' : 'hair'}`, l.eyes && `${l.eyes} eyes`, l.skin && `${l.skin} skin`, l.uniform].filter(Boolean);
}
function personLooks(name, people, profiles = []) {
  const n = looksNorm(looksClean(name));
  const p = (people || []).find((e) => looksNorm(e.name) === n || (e.aliases || []).some((a) => looksNorm(a) === n));
  const animal = !!p && looksAnimal(p);
  let hair = p ? looksColorOf(p.fields?.hair || looksExtra(p, ['머리색', '머리 색', '머리', '털색', '털 색', '털']), LOOKS_HAIR_NOUN) : '';
  let eyes = p ? looksColorOf(p.fields?.eyes || looksExtra(p, ['눈색', '눈 색', '눈동자', '눈']), LOOKS_EYE_NOUN) : '';
  if (p && !hair) hair = looksColor(looksColorNear(p.fields?.appearance, animal ? String.raw`\b(?:fur|feathers?)\b|털|깃털` : LOOKS_HAIR_NOUN));
  if (p && !eyes) eyes = looksColor(looksColorNear(p.fields?.appearance, LOOKS_EYE_NOUN));
  let house = p ? String(p.fields?.house || looksExtra(p, ['기숙사']) || '').trim() : '';
  let skin = p && !animal ? looksSkin(p.fields?.skin || looksExtra(p, ['피부색', '피부 색', '피부'])) || looksSkinNear(p.fields?.appearance) : '';
  if (!animal && (!hair || !eyes || !skin)) {
    const want = new Set([n, ...(p ? [p.name, ...(p.aliases || [])].map((x) => looksNorm(looksClean(x))) : [])]);
    const prof = profiles.find((x) => x.names.some((k) => want.has(k)));
    if (prof) {
      hair ||= looksColor(prof.hair);
      eyes ||= looksColor(prof.eyes);
      skin ||= looksSkin(prof.skin);
    }
  }
  if (!animal && (!hair || !eyes || !house)) {
    // 0.43.4 백과는 보이는 이름 → 설정집 이름 → 온 이름인 다른 이름 순으로 (원문 · 정발 표기)
    const tries = [n, ...(p ? [p.name, ...(p.aliases || []).filter((x) => /\s/.test(String(x).trim()))].map((x) => looksNorm(looksClean(x))) : [])];
    const e = tries.map((k) => hpIndex().get(k)).find(Boolean);
    if (e) {
      const prose = looksFromProse(e.looks);
      hair ||= looksColor(prose.hair);
      eyes ||= looksColor(prose.eyes);
      skin ||= looksSkinNear(e.looks);
      house ||= e.house || '';
    }
  }
  const houseTag = Object.entries(LOOKS_HOUSES).find(([k]) => looksNorm(house).includes(looksNorm(k)))?.[1];
  return { person: p || null, animal, hair, eyes, skin, uniform: houseTag ? `${houseTag} uniform` : '' };
}
/** 답 글의 마지막 §RP 줄 바로 아래 인물 줄 이름들 (셸 시공간 카드 card.js와 같은 모양: 「- 이름: 의상 | 자세 | 심리」) */
function rpCastNames(text) {
  const t = String(text || '').replace(/<[^>]+>/g, '\n').replace(/\*+/g, '');
  const at = t.lastIndexOf('§RP');
  if (at < 0) return [];
  const close = t.indexOf('§', at + 3);
  if (close < 0) return [];
  const names = [];
  for (const line of t.slice(close + 1).split(/\r?\n/).slice(0, 40)) {
    if (!line.trim()) { if (names.length) break; continue; }
    const m = line.match(/^[ \t]*(?:[-*•·][ \t]+)?([^:：|｜§]{1,40}?)[ \t]*[:：][ \t]*[^§]*?[|｜]/);
    if (!m) break;
    names.push(m[1].trim());
    if (names.length >= 20) break;
  }
  return names;
}
/** 삽화 에이전트에 넣을 칸 글 (없으면 '') · overrides: 카드 인물 이름 → 「이 방만 이미지 외형」 글 */
function worldLooksBlock(text, people, overrides = {}, moreTexts = [], relations = [], opts = {}) {
  return worldLooksParts(text, people, overrides, moreTexts, relations, opts).text;
}
// 0.42.0 가족 호칭: 설정집 「가족」 관계 메모의 호칭이 딱 한 사람을 가리킬 때만 그 사람에게 잇는다
const LOOKS_KIN = { 어머니: 'f', 엄마: 'f', 모친: 'f', 딸: 'f', 누나: 'f', 언니: 'f', 여동생: 'f', 이모: 'f', 고모: 'f', 할머니: 'f', 아내: 'f', mother: 'f', mom: 'f', mum: 'f', daughter: 'f', sister: 'f', aunt: 'f', grandmother: 'f', wife: 'f', 아버지: 'm', 아빠: 'm', 부친: 'm', 아들: 'm', 형: 'm', 오빠: 'm', 남동생: 'm', 삼촌: 'm', 할아버지: 'm', 남편: 'm', father: 'm', dad: 'm', son: 'm', brother: 'm', uncle: 'm', grandfather: 'm', husband: 'm', 동생: '' };
const LOOKS_KIN_EN = { 어머니: ['mother', 'mom'], 엄마: ['mother', 'mom'], 모친: ['mother'], 아버지: ['father', 'dad'], 아빠: ['father', 'dad'], 부친: ['father'], 딸: ['daughter'], 아들: ['son'], 누나: ['sister'], 언니: ['sister'], 여동생: ['sister'], 오빠: ['brother'], 형: ['brother'], 남동생: ['brother'], 할머니: ['grandmother'], 할아버지: ['grandfather'], 이모: ['aunt'], 고모: ['aunt'], 삼촌: ['uncle'], 아내: ['wife'], 남편: ['husband'] };
const looksKinIn = (note, word) => (/[a-z]/.test(word) ? new RegExp(`\\b${word}\\b`, 'i') : new RegExp(`(?<![가-힣])${word}(?:[은는이가을를의와과도로])?(?![가-힣])`)).test(note);
const looksGender = (p) => {
  const g = String(p?.fields?.gender || '').trim().toLowerCase();
  if (/female|woman|girl|여/.test(g) || g === 'f') return 'f';
  if (/male|man|boy|남/.test(g) || g === 'm') return 'm';
  return '';
};
function looksKinEnd(note, word, gender, a, b) {
  const namesOf = (p) => [p.name, ...(p.aliases || []), ...String(p.name || '').split(/\s+/)].filter((x) => String(x).length >= 2);
  const says = (p, other) => { // 같은 성처럼 두 사람이 함께 가진 조각은 누구 말인지 모르니 뺌
    const shared = new Set(namesOf(other).map(looksNorm));
    return namesOf(p).filter((x) => !shared.has(looksNorm(x))).some((x) => note.includes(`${x}의 ${word}`) || note.toLowerCase().includes(`${String(x).toLowerCase()}'s ${word}`));
  };
  const sa = says(a, b), sb = says(b, a);
  if (sa !== sb) return sa ? b : a; // 「A의 어머니」면 다른 쪽이 어머니
  if (!gender) return null;
  const ga = looksGender(a) === gender, gb = looksGender(b) === gender;
  return ga !== gb ? (ga ? a : b) : null;
}
const LOOKS_PARENT_WORDS = new Set(['어머니', '엄마', '모친', '아버지', '아빠', '부친', 'mother', 'mom', 'mum', 'father', 'dad']);
function looksKinMap(people, relations) {
  const byId = new Map((people || []).filter((p) => p.entityId).map((p) => [p.entityId, p]));
  const found = new Map();
  for (const r of relations || []) {
    if (r?.type !== '가족') continue;
    const a = byId.get(r.from), b = byId.get(r.to), note = String(r.note || '');
    if (!a || !b || !note) continue;
    for (const [word, gender] of Object.entries(LOOKS_KIN)) {
      if (!looksKinIn(note, word)) continue;
      const set = found.get(word) || new Set();
      const who = looksKinEnd(note, word, gender, a, b);
      if (who) set.add(who); else { set.add(a); set.add(b); } // 누군지 모르면 둘 다 넣어 「한 명」이 안 되게
      found.set(word, set);
    }
  }
  // 0.43.8 가족 관계가 비어 있어도: 그 사람 칸에 「Irina's father」 · 「father of Irina」 · 「이리나의 아버지」처럼 다른 인물 이름과 같이 적혀 있으면
  const partsOf = (p) => [p.name, ...(p.aliases || []), ...String(p.name || '').split(/\s+/)].map((x) => String(x).trim()).filter((x) => x.length >= 2);
  for (const p of people || []) {
    const text = [p.fields?.family, p.fields?.background, p.fields?.affiliation].filter(Boolean).join('\n').toLowerCase();
    if (!text) continue;
    for (const [word, gender] of Object.entries(LOOKS_KIN)) {
      if (!text.includes(word) || (gender && looksGender(p) && looksGender(p) !== gender)) continue;
      const hit = (people || []).find((o) => o !== p && partsOf(o).filter((x) => !partsOf(p).includes(x)).some((n) => { const k = n.toLowerCase(); return text.includes(`${k}의 ${word}`) || text.includes(`${k}'s ${word}`) || text.includes(`${k}’s ${word}`) || text.includes(`${word} of ${k}`) || text.includes(`${word} to ${k}`); }));
      if (!hit) continue;
      found.set(word, (found.get(word) || new Set()).add(p));
      // 0.43.9 「Elsa의 아버지」면 Elsa는 그 집 딸 · 아들 (자식이 둘이면 「한 명」이 안 되어 안 맞춤)
      if (LOOKS_PARENT_WORDS.has(word)) for (const c of looksGender(hit) === 'f' ? ['daughter', '딸'] : looksGender(hit) === 'm' ? ['son', '아들'] : []) found.set(c, (found.get(c) || new Set()).add(hit));
    }
  }
  const byWord = new Map(), ofPerson = new Map();
  for (const [word, set] of found) {
    if (set.size !== 1) continue;
    const p = [...set][0];
    byWord.set(looksNorm(word), p);
    ofPerson.set(p, [...(ofPerson.get(p) || []), word]);
  }
  return { byWord, ofPerson };
}
/** 0.42.0 장면에 나온 인물만 한 사람 한 줄 · cast: 이름표(@이름)로 찾을 값 */
function worldLooksParts(text, people, overrides = {}, moreTexts = [], relations = [], opts = {}) {
  const lines = [], cast = new Map(), seen = new Set(), entries = [];
  const profiles = looksProfilesFrom([text, ...moreTexts]); // 0.37.0 이 답 → 앞 답들 순서로 <npc_profile>
  const kin = looksKinMap(people, relations);
  const castNames = rpCastNames(text);
  // Other presets need not emit a §RP tracker: use names detected in the current reply.
  for (const raw of castNames.length ? castNames : (opts.castNames || [])) {
    const clean = looksClean(raw), n = looksNorm(clean);
    const direct = (people || []).find((e) => looksNorm(e.name) === n || (e.aliases || []).some((a) => looksNorm(a) === n));
    const p = direct || kin.byWord.get(n) || null;
    const key = p ? p.entityId || looksNorm(p.name) : n;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = p ? p.name : clean;
    const look = personLooks(name, people, profiles);
    const own = String(overrides[looksNorm(name)] || overrides[looksNorm(raw)] || '').toLowerCase();
    const hair = own && /\b(?:hair|fur)\b/.test(own) ? '' : look.hair;
    const eyes = own && /\beyes?\b/.test(own) ? '' : look.eyes;
    const skin = own && /\bskin\b/.test(own) ? '' : look.skin;
    const uniform = own && /uniform/.test(own) ? '' : look.uniform;
    const slots = [hair && `${look.animal ? 'fur' : 'hair'}: ${hair} ${look.animal ? 'fur' : 'hair'}`, eyes && `eyes: ${eyes} eyes`, skin && `skin: ${skin} skin`, uniform && `uniform: ${uniform}`].filter(Boolean);
    if (!slots.length) continue;
    const others = [];
    const words = p ? kin.ofPerson.get(p) || [] : [];
    for (const x of [...(p?.aliases || []).slice(0, 3), ...words, clean]) if (x && looksNorm(x) !== looksNorm(name) && !others.some((y) => looksNorm(y) === looksNorm(x))) others.push(x);
    lines.push(`${name}${others.length ? ` (${others.join(' · ')})` : ''} — ${slots.join(' / ')}`);
    const ageNum = Number(String(p?.fields?.age || '').match(/\d{1,3}/)?.[0]);
    const who = { name, animal: look.animal, hair, eyes, skin, gender: p ? looksGender(p) : '', age: Number.isFinite(ageNum) ? ageNum : NaN, kinEn: words.flatMap((w) => LOOKS_KIN_EN[w] || []) };
    entries.push(who);
    for (const x of [name, clean, ...(p?.aliases || []), ...words, ...who.kinEn]) if (looksNorm(x) && !cast.has(looksNorm(x))) cast.set(looksNorm(x), who);
  }
  if (!lines.length) return { text: '', cast };
  // 이름 한 조각(@Mira)도 그 장면에 한 사람뿐이면 찾음
  const piece = new Map();
  for (const who of entries) for (const w of [...String(who.name).split(/\s+/), ...who.kinEn]) { const k = looksNorm(w); if (k.length >= 2) piece.set(k, piece.has(k) && piece.get(k) !== who ? null : who); }
  for (const [k, who] of piece) if (who && !cast.has(k)) cast.set(k, who);
  return {
    cast,
    text: [
      '<world_archive_looks>',
      "Fixed looks of the people in this scene, one person per line, from the World Archive, the NPC profiles in the story, or the encyclopedia, as Danbooru tags. Names in parentheses are other names or family titles of the same person. The character appearance reference wins where it already names these traits.",
      "Copy each person's hair (fur for animals), eyes, and skin tags exactly from their own line. Never mix them with another person's line.",
      ...(opts.label ? ['In the image prompt, give each visible person their own "|" section. Begin it with @ and the name before the dash, for example "@Name, 1girl, ...", and include that person\'s hair, eyes, and skin tags in it. The server removes this label before the image is made.'] : []),
      ...lines,
      '</world_archive_looks>',
    ].join('\n'),
  };
}
// 0.42.0 안전망: 「@이름」이 붙은 | 칸의 머리 · 눈 · 피부 색 태그를 그 사람 값으로 바꾸고 이름표를 지움 · 못 찾은 이름표와 표 없는 칸은 손대지 않음
const looksIsColor = (w) => { const x = w.toLowerCase(); return LOOKS_EN.has(x) || LOOKS_EN_MOD.has(x) || /^(?:light|dark|pale)-colou?red$/.test(x) || (x.includes('-') && x.split('-').every((y) => LOOKS_EN.has(y) || LOOKS_EN_MOD.has(y))); };
const looksIsSkin = (w) => LOOKS_SKIN_EN.has(w.toLowerCase());
// 0.43.8 안전망 (사용자 03:19 「또 섞였어」): 칸을 인물에 맞춘 뒤 그 칸의 머리 · 눈 · 피부 색 태그를 지우고 설정집 값을 넣음 · 같은 인물의 칸이 여럿이면 뒤 칸으로 합침
//  맞추는 순서: @이름표 → 칸 안의 이름 · 다른 이름 · 호칭 → 성별 + 나이 낱말로 묶음에서 딱 한 명 · 못 맞춘 칸은 손대지 않음 · 장면의 인원 수 태그는 손대지 않음
const LOOKS_FIX_COLOR = new Set('greying graying greyed streaked streaks streak highlights highlight ombre gradient multicolored multicoloured two-tone sun-kissed sunkissed tanned tan fair olive porcelain sandy sea raven mousy ashy dusky bronzed'.split(' '));
const LOOKS_FIX_STYLE = new Set('long short medium very shoulder-length messy wavy curly straight tousled fluffy spiky slicked swept neat tied braided'.split(' '));
const LOOKS_FIX_ALONE = new Set('ponytail updo bun bob braid braids bangs pigtails twintails'.split(' '));
const looksFixWord = (w) => { const x = w.toLowerCase(); return LOOKS_EN.has(x) || LOOKS_EN_MOD.has(x) || LOOKS_FIX_COLOR.has(x) || LOOKS_SKIN_EN.has(x) || (x.includes('-') && x.split('-').some((y) => LOOKS_EN.has(y) || LOOKS_FIX_COLOR.has(y))) || /^(?:light|dark|pale)-colou?red$/.test(x); };
/** 태그 하나에서 색만 뺌: 그 태그가 아니면 그대로 · 머리 모양 낱말은 남김 · 남는 게 없으면 null */
function looksStripTag(raw, kind) {
  const m = String(raw).match(/^(\s*)([{[(]*(?:-?\d+(?:\.\d+)?::)?)(.*?)((?:::)?[}\])]*)(\s*)$/s);
  if (!m) return raw;
  const inner = m[3];
  const noun = kind === 'hair' ? /\b(?:hair|fur)\b/i : kind === 'eyes' ? /\b(?:eyes?|irises)\b/i : /\bskin\b|-skinned\b/i;
  if (!noun.test(inner)) return kind === 'skin' && /^\s*tan(?:ned)?\s*$/i.test(inner) ? null : raw;
  const words = inner.split(/[\s_/]+/).filter(Boolean);
  if (kind === 'skin' && /-skinned\b/i.test(inner)) { const rest = words.filter((w) => !/-skinned$/i.test(w)).join(' '); return rest ? `${m[1]}${m[2]}${rest}${m[4]}${m[5]}` : null; }
  if (!words.some((w) => !noun.test(w) && looksFixWord(w.replace(/[(),.]/g, '')))) return raw;
  if (kind !== 'hair') return null;
  const plain = words.map((w) => w.toLowerCase().replace(/[(),.]/g, ''));
  const alone = plain.filter((w) => LOOKS_FIX_ALONE.has(w)), style = plain.filter((w) => LOOKS_FIX_STYLE.has(w));
  if (alone.length) return `${m[1]}${m[2]}${[...style, ...alone].join(' ')}${m[4]}${m[5]}`;
  return style.length ? `${m[1]}${m[2]}${style.join(' ')} hair${m[4]}${m[5]}` : null;
}
/** 맞춘 칸의 색 태그를 설정집 값으로 → { text, swapped } (값을 모르는 칸의 태그는 그대로) */
function looksFixSection(sec, who) {
  const kinds = [['hair', who.hair], ['eyes', who.eyes], ['skin', who.skin]].filter(([, v]) => v);
  const out = [];
  let at = -1, removed = 0;
  for (const raw of sec.split(',')) {
    let t = raw;
    for (const [kind] of kinds) {
      if (t === null) break;
      const next = looksStripTag(t, kind);
      if (next !== t) { removed += 1; if (at < 0) at = out.length; }
      t = next;
    }
    if (t !== null && (t.trim() || sec.split(',').length === 1)) out.push(t);
  }
  const adds = kinds.map(([kind, v]) => ` ${v} ${kind === 'hair' ? (who.animal ? 'fur' : 'hair') : kind}`);
  const seen = new Set(out.map((t) => t.trim().toLowerCase()));
  const fresh = adds.filter((t) => !seen.has(t.trim().toLowerCase()));
  out.splice(at >= 0 ? at : Math.min(1, out.length), 0, ...fresh);
  let text = out.join(',');
  if (!/^\s/.test(sec)) text = text.replace(/^\s+/, '');
  return { text, swapped: Math.max(removed, fresh.length) };
}
const looksTagName = (t) => looksNorm(looksClean(String(t).replace(/^\s*[{[(]*(?:-?\d+(?:\.\d+)?::)?/, '').replace(/(?:::)?[}\])]*\s*$/, '')));
/** 0.43.10 「Cordelia Vane on left」 · 「이리나 in center」처럼 이름 뒤에 자리 말이 붙은 태그 */
function looksLeadName(tag, cast) {
  const t = String(tag).trim().replace(/^[{[(]*(?:-?\d+(?:\.\d+)?::)?/, '').replace(/(?:::)?[}\])]*$/, '');
  const m = t.match(/^(.+?)\s+(?:on|in|at|to|near|by)\s+(?:the\s+)?(?:left|right|center|centre|middle|foreground|background)\b/i);
  return m ? cast.get(looksNorm(looksClean(m[1]))) || null : null;
}
const looksSecGender = (sec) => {
  const low = sec.split(',').map((t) => t.trim().toLowerCase());
  const f = low.some((t) => /(?:^|\s)(?:1?girl|woman|female|lady|mother)(?:$|\s)/.test(t)), m = low.some((t) => /(?:^|\s)(?:1?boy|man|male|gentleman|father)(?:$|\s)/.test(t));
  return f === m ? '' : f ? 'f' : 'm';
};
const looksHasColor = (sec) => sec.split(',').some((t) => ['hair', 'eyes', 'skin'].some((k) => looksStripTag(t, k) !== t));
/** 0.43.10 이름만 있는 칸 N개 뒤에 외형 칸 N개가 같은 순서로 오면 짝지음 (성별이나 다른 단서가 어긋나면 그 묶음은 안 맞춤) */
function looksPairRows(parts, cast, sceneAt) {
  const out = new Map();
  const idx = parts.map((s, i) => (s.trim() && i > sceneAt ? i : -1)).filter((i) => i >= 0);
  const nameOf = (sec) => { const first = sec.split(',')[0]; return looksHasColor(sec) ? null : looksLeadName(first, cast) || cast.get(looksTagName(first)) || null; };
  for (let k = 0; k < idx.length;) {
    const names = [];
    while (k + names.length < idx.length) {
      const who = nameOf(parts[idx[k + names.length]]);
      if (!who || names.includes(who)) break;
      names.push(who);
    }
    if (!names.length) { k += 1; continue; }
    const rows = idx.slice(k + names.length, k + names.length * 2);
    const fits = rows.length === names.length && rows.every((i, n) => {
      const sec = parts[i], who = names[n], g = looksSecGender(sec);
      if (nameOf(sec) || (g && who.gender && g !== who.gender) || (!g && !looksHasColor(sec))) return false; // 0.43.11 외형 칸에 색 태그가 없어도 성별이 맞으면 짝
      const other = looksSectionWho(sec, cast);
      return !other || other.who === who;
    });
    if (fits) {
      names.forEach((who, n) => { out.set(idx[k + n], who); out.set(rows[n], who); });
      k += names.length * 2;
    } else k += names.length;
  }
  return out;
}
/** 칸 → 인물 (@이름표 → 칸 안의 이름 · 호칭 → 성별 + 나이) · 둘 이상이면 못 맞춤 */
function looksSectionWho(sec, cast) {
  const m = sec.match(/^(\s*)@([^,|:\n@]{1,60}?)\s*(?:,\s*|$)/);
  let body = sec;
  if (m) {
    const who = cast.get(looksNorm(looksClean(m[2])));
    if (who) return { who, body: m[1] + sec.slice(m[0].length) };
    if (!(m[2].trim().toLowerCase() in LOOKS_KIN)) return null; // 0.43.9 설정집에 없는 이름표는 다른 사람이니 손대지 않음
    body = m[1] + sec.slice(m[0].length); // 호칭 이름표(@daughter)는 떼고 아래 길로 맞춤
  }
  const tags = body.split(',');
  const named = new Set();
  for (const t of tags) {
    if (looksIsColor(t.trim())) continue;
    const who = cast.get(looksTagName(t)) || looksLeadName(t, cast);
    if (who) named.add(who);
  }
  if (named.size === 1) return { who: [...named][0], body };
  if (named.size > 1) return null;
  const low = tags.map((t) => t.trim().toLowerCase());
  if (low.some((t) => /(?:^|\s)(?:[2-9]|\d{2,})\s*(?:girls?|boys?|others?)\b|\b(?:multiple|group|crowd)\b/.test(t))) return null; // 장면 칸
  const f = low.some((t) => /(?:^|\s)(?:1?girl|woman|female|lady)(?:$|\s)/.test(t)), b = low.some((t) => /(?:^|\s)(?:1?boy|man|male|gentleman)(?:$|\s)/.test(t));
  if (f === b) return null;
  const text = low.join(' ');
  const older = /\b(?:mature|middle-aged|older|elderly|aged|mother|father|mom|mum|dad)\b/.test(text), younger = /\b(?:young|teen|teenage|adolescent)\b/.test(text);
  let list = [...new Set(cast.values())].filter((x) => x.gender === (f ? 'f' : 'm'));
  if (older !== younger) list = list.filter((x) => Number.isFinite(x.age) && (older ? x.age >= 35 : x.age < 35));
  return list.length === 1 ? { who: list[0], body } : null;
}
/** 프롬프트 전체 → { prompt, stats: { sections, matched, swapped, merged } } */
function looksFixRun(prompt, cast) {
  const parts = String(prompt).split('|');
  const stats = { sections: parts.filter((x) => x.trim()).length, matched: 0, swapped: 0, merged: 0 };
  const whoOf = new Map();
  // 칸이 여럿이면 화풍 칸들 다음 첫 칸이 장면 칸
  const sceneAt = parts.length > 1 ? parts.findIndex((x) => x.trim() && !x.split(',').every((t) => !t.trim() || /artist:/i.test(t))) : -1;
  const paired = looksPairRows(parts, cast, sceneAt);
  const out = parts.map((sec, i) => {
    // 장면 칸은 @이름표가 있을 때만 인물 칸
    const got = paired.has(i) ? { who: paired.get(i), body: sec } : sec.trim() && (i > sceneAt || /^\s*@/.test(sec)) ? looksSectionWho(sec, cast) : null;
    if (!got) return sec;
    stats.matched += 1;
    const r = looksFixSection(got.body, got.who);
    stats.swapped += r.swapped;
    whoOf.set(got.who, [...(whoOf.get(got.who) || []), i]);
    return r.text;
  });
  for (const idx of whoOf.values()) {
    if (idx.length < 2) continue;
    const last = idx[idx.length - 1], keep = out[last].split(','), seen = new Set(keep.map((t) => t.trim().toLowerCase()));
    for (const i of idx.slice(0, -1)) {
      for (const t of out[i].split(',')) { const k = t.trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); keep.push(t); } }
      out[i] = null;
      stats.merged += 1;
    }
    out[last] = keep.join(',');
  }
  return { prompt: stats.matched ? out.filter((x) => x !== null).join('|') : String(prompt), stats };
}
const looksFixPrompt = (prompt, cast) => looksFixRun(prompt, cast).prompt;

module.exports = { looksNorm, worldLooksParts, looksFixRun };
