'use strict';
/**
 * v0.6.2 ⑨ — profile blocks read by code (no model). A reply's <npc_profile> has a fixed shape:
 *   - Name: Margaret "Maggie" Doyle / Age: 19 / Gender: Female
 *   - Appearance and clothing: …
 *   - Demeanor and key personality traits: …
 *   - Other noteworthy details: …
 * (each on its own line too, and the Korean labels 이름/나이/성별 · 외형과 옷차림 · 태도와 주요 성격 · 그 밖에 눈에 띄는 것).
 * A <world_profile> has 「- Subject / - Type / - Established information」. The values are kept as written (English
 * stays English unless the room's glossary names it); the next reading translates them.
 */

const BLOCK = /<(npc_profile|world_profile)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const squash = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/[\s"'“”‘’·,.()]+/g, '');
const clean = (x) => String(x || '').replace(/<\/?[a-z][a-z0-9_-]*(\s[^<>]*)?\/?>/gi, '').replace(/\s+/g, ' ').trim();

// label → field (lower case, without spaces)
const NPC_LABELS = [
  [/^(name|이름)$/, 'name'],
  [/^(age|나이)$/, 'age'],
  [/^(gender|sex|성별)$/, 'gender'],
  [/^(species|race|종족|종)$/, 'species'],
  [/^(appearance(andclothing)?|appearanceandoutfit|외형(과옷차림)?|외모(와옷차림)?)$/, 'appearance'],
  [/^(demeanor(andkeypersonalitytraits)?|personality(traits)?|태도(와주요성격)?|성격)$/, 'personality'],
  [/^(other(noteworthy)?details|notes|그밖에눈에띄는것|기타)$/, 'background'],
];
const WORLD_LABELS = [[/^(subject|주제|대상)$/, 'subject'], [/^(type|종류)$/, 'type'], [/^(establishedinformation|information|details|내용|확정된정보)$/, 'info']];
const labelOf = (list, raw) => { const k = squash(raw).replace(/[/:]/g, ''); return list.find(([re]) => re.test(k))?.[1] || null; };

/** One line 「- A: x / B: y」 (or 「이름/나이/성별: a / b / c」) → [[label, value]…]. */
function pairsOfLine(line, list) {
  const t = clean(line).replace(/^[-*•]\s*/, '');
  // 「이름/나이/성별: 노을 하르트 / 마흔둘 / 남」: the labels together, then the values in the same order
  const m = t.match(/^([^:：]{1,40}(?:\/[^:：/]{1,20})+)\s*[:：]\s*(.+)$/);
  if (m && !/[:：]/.test(m[2])) {
    const labels = m[1].split('/').map((x) => labelOf(list, x));
    const values = m[2].split(/\s+\/\s+|\//).map((x) => x.trim());
    if (labels.every(Boolean) && values.length === labels.length) return labels.map((l, i) => [l, values[i]]);
  }
  // 「Name: X / Age: Y / Gender: Z」 or one 「Label: value」
  const out = [];
  for (const part of t.split(/\s+\/\s+(?=[^/:：]{1,40}[:：])/)) {
    const at = part.search(/[:：]/);
    if (at < 1) continue;
    const label = labelOf(list, part.slice(0, at));
    const value = part.slice(at + 1).trim();
    if (label && value) out.push([label, value]);
  }
  return out;
}

/** The profile blocks of a text: [{ kind: 'npc', name, nick, fields: { age, gender, … }, lines: { key: line } } |
 *  { kind: 'world', subject, type, info, line }]. */
function parseProfiles(text) {
  const out = [];
  for (const m of String(text || '').matchAll(BLOCK)) {
    const kind = m[1].toLowerCase() === 'npc_profile' ? 'npc' : 'world';
    const lines = m[2].split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (kind === 'npc') {
      const p = { kind, name: '', nick: '', fields: {}, lines: {} };
      for (const line of lines) for (const [k, v] of pairsOfLine(line, NPC_LABELS)) {
        if (k === 'name') {
          // 「Margaret "Maggie" Doyle」 · 「Beatrix (Nickname: Bea)」 · 「Alistair Vane, 9th Duke of Vane」
          const nick = v.match(/["“]([^"”]{1,30})["”]/)?.[1] || v.match(/\((?:nickname|aka|별명)\s*[:：]?\s*([^)]{1,30})\)/i)?.[1] || '';
          const title = v.match(/,\s*([^,()]{2,60})$/)?.[1] || '';
          p.name = v.replace(/\s*["“][^"”]*["”]\s*/g, ' ').replace(/\s*\([^)]*\)/g, '').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
          p.nick = nick.trim();
          p.title = title.trim();
          // 「(unnamed)」, or a description for a name (「Gringotts silver-door goblin」: two small words in a row)
          p.nameless = /\b(unnamed|unknown|nameless)\b|이름\s*없/i.test(v) || /(^|\s)[a-z][a-z'-]+\s+[a-z][a-z'-]+(\s|$)/.test(p.name);
          p.lines.name = clean(line);
        } else if (!p.fields[k]) { p.fields[k] = v; p.lines[k] = clean(line); }
      }
      if (p.name) out.push(p);
    } else {
      const p = { kind, subject: '', type: '', info: '', line: '' };
      let last = null;
      for (const line of lines) {
        const got = pairsOfLine(line, WORLD_LABELS);
        if (got.length) for (const [k, v] of got) { p[k] = v; last = k; }
        else if (last === 'info') p.info += ` ${clean(line).replace(/^[-*•]\s*/, '')}`; // the information may go on
      }
      p.info = p.info.trim();
      p.line = clean(lines.join(' '));
      if (p.subject && p.info) out.push(p);
    }
  }
  return out;
}

/** Type → kind of setting (사령탑: Location → 장소, Group · Institution → 집단, Schedule → 일정, System → 시스템). */
function kindOfType(type) {
  const t = squash(type);
  if (/^(location|place|building|region|장소)/.test(t)) return 'place';
  if (/^(group|institution|organi[sz]ation|faction|family|house|집단|기관|조직)/.test(t)) return 'group';
  if (/^(schedule|timetable|calendar|event|일정|시간표)/.test(t)) return 'schedule';
  if (/^(system|magic|economy|시스템|제도)/.test(t)) return 'system';
  if (/^(rule|law|규칙|법)/.test(t)) return 'rule';
  if (/^(history|역사)/.test(t)) return 'history';
  return 'custom';
}

/** 「Male」 → 남성; a number → 「52살」; the rest as written. v0.7.1: in English (lang 'en') Male · Female · the number as written. */
function tidyValue(key, v, lang = 'ko') {
  const s = String(v || '').trim().replace(/[.。]$/, '');
  if (lang === 'en') {
    if (key === 'gender' && /^(male|man|boy|m|남|남자|남성)$/i.test(s)) return 'Male';
    if (key === 'gender' && /^(female|woman|girl|f|여|여자|여성)$/i.test(s)) return 'Female';
    const age = key === 'age' && s.match(/^(\d{1,4})\s*(살|세)$/);
    return age ? age[1] : s;
  }
  if (key === 'gender') {
    if (/^(male|man|boy|m|남|남자|남성)$/i.test(s)) return '남성';
    if (/^(female|woman|girl|f|여|여자|여성)$/i.test(s)) return '여성';
    return s;
  }
  if (key === 'age' && /^\d{1,4}$/.test(s)) return `${s}살`;
  return s;
}

/** The glossary's Korean for an English name: the whole name, or word by word when every word has one. */
function korean(name, pairs) {
  const k = squash(name);
  const whole = (pairs || []).find((p) => squash(p.from) === k);
  if (whole) return whole.to;
  const words = String(name).trim().split(/\s+/);
  if (words.length < 2) return null;
  const each = words.map((w) => (pairs || []).find((p) => squash(p.from) === squash(w))?.to);
  return each.every(Boolean) ? each.join(' ') : null;
}

/** Two values that say the same (numbers in an age; the same words). Different scripts are not compared. */
function sameValue(key, a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return true;
  if (key === 'age') { const nx = x.match(/\d+/)?.[0]; const ny = y.match(/\d+/)?.[0]; return !nx || !ny || nx === ny; }
  const hx = /[가-힣]/.test(x);
  const hy = /[가-힣]/.test(y);
  if (hx !== hy) return true; // a translation, not another value
  if (key === 'gender') { const g = (v) => ({ 암컷: '여성', 수컷: '남성', 여자: '여성', 남자: '남성' })[squash(v)] || squash(v); return g(x) === g(y); }
  return squash(x) === squash(y) || squash(x).includes(squash(y)) || squash(y).includes(squash(x));
}

/** Two days of the week or more (English or Korean): a timetable's text. */
function holdsDays(text) {
  const t = String(text || '');
  const en = new Set((t.match(/\b(mon|tue|wed|thu|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b/gi) || []).map((d) => d.slice(0, 3).toLowerCase()));
  const ko = new Set(t.match(/[월화수목금토일](?=요일|\s*[0-9])/g) || []);
  return en.size >= 2 || ko.size >= 2;
}

module.exports = { holdsDays, parseProfiles, kindOfType, tidyValue, korean, sameValue, BLOCK };
