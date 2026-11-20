'use strict';
/**
 * 시간표 (v0.5.0 B): one sheet per owner (a group or a person) — weekday × time cells. A schedule setting with a
 * `timetable` { ownerId, cells: { '월|1교시': { day, slot, value, evidence, source, at, past?, pending? } } }.
 * What a lesson or a daily round is fills a cell instead of becoming a schedule setting of its own.
 */
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const DAY_WORDS = [
  [/^(월|월요일|mon|monday)$/i, '월'], [/^(화|화요일|tue|tues|tuesday)$/i, '화'], [/^(수|수요일|wed|wednesday)$/i, '수'],
  [/^(목|목요일|thu|thur|thurs|thursday)$/i, '목'], [/^(금|금요일|fri|friday)$/i, '금'], [/^(토|토요일|sat|saturday)$/i, '토'],
  [/^(일|일요일|sun|sunday)$/i, '일'], [/^(매일|날마다|daily|every ?day)$/i, '매일'], [/^(평일|주중|weekdays?)$/i, '평일'],
];
const CELL_MAX = 80;
const SLOT_MAX = 24;
const PAST_MAX = 3;

/** 「월요일」 · 「Mon」 → 「월」; 매일 · 평일 as they are; anything else null. */
function normDay(x) {
  const t = String(x ?? '').trim();
  for (const [re, d] of DAY_WORDS) if (re.test(t)) return d;
  return null;
}
/** A time slot as written, tidied: 「1교시」, 「오전」, 「09:00–12:00」. Empty or too long: null. */
function normSlot(x) {
  const t = String(x ?? '').replace(/\s+/g, ' ').replace(/\s*[~\-–—]\s*/g, '–').trim();
  return t && t.length <= SLOT_MAX ? t : null;
}
const cellKey = (day, slot) => `${day}|${slot}`;
/** Weekdays first (월…일), then 평일 · 매일; slots in a natural order (교시 by number, times by clock, words by the day). */
const DAY_RANK = (d) => (DAYS.includes(d) ? DAYS.indexOf(d) : d === '평일' ? 7 : 8);
const WORD_SLOT = ['새벽', '아침', '오전', '점심', '오후', '저녁', '밤', '자정'];
function slotRank(s) {
  const t = String(s);
  let m = t.match(/^(\d+)\s*교시/);
  if (m) return Number(m[1]) * 100;
  m = t.match(/^(\d{1,2}):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/^(\d{1,2})\s*시/);
  if (m) return Number(m[1]) * 60;
  const w = WORD_SLOT.findIndex((x) => t.startsWith(x));
  return w >= 0 ? [300, 420, 540, 720, 840, 1080, 1260, 1440][w] : 2000;
}
const sortCells = (cells) => Object.values(cells || {}).sort((a, b) => DAY_RANK(a.day) - DAY_RANK(b.day) || slotRank(a.slot) - slotRank(b.slot) || a.slot.localeCompare(b.slot, 'ko'));

const TIME = /(\d+\s*교시|\d{1,2}:\d{2}(?:\s*[~\-–—]\s*\d{1,2}:\d{2})?|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?(?:\s*[~\-–—]\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?)?|새벽|아침|오전|점심|오후|저녁|밤|자정)/;
// v0.5.1 H: days that share one time — 「월요일 · 수요일 오후」, 「월·수 오후」, 「토/일」 (single letters only in a list,
// never inside a word: 「수업」 · 「통일」 are not days)
const DAY_WORD = '(?:월|화|수|목|금|토|일)요일|매일|날마다|평일';
const DAY_GROUP = new RegExp(`(?:${DAY_WORD})(?:\\s*(?:[·,/]|및)\\s*(?:${DAY_WORD}))*|(?<![가-힣])[월화수목금토일](?:\\s*[·/,]\\s*[월화수목금토일])+(?:요일)?(?![가-힣])`, 'g');
const DAY_ONE = /(월|화|수|목|금|토|일)요일|매일|날마다|평일|[월화수목금토일]/g;
const daysOf = (group) => [...new Set([...group.matchAll(DAY_ONE)].map((m) => normDay(m[0])).filter(Boolean))];
/**
 * The cells a 「언제」 text names, by code: 「금요일 아침 9시」 → 금 · 아침 9시? no — the first time phrase after the day:
 * 「금요일 아침」 → [금, 아침]; 「월요일 09:00–15:00, 화요일 09:00–15:00」 → two cells. A day without a time, or a date
 * (「9월 1일」), gives nothing: that is not a weekly cell.
 */
function parseWhen(text) {
  const t = String(text || '');
  const out = [];
  const hits = [...t.matchAll(DAY_GROUP)];
  const TIME_ALL = new RegExp(TIME.source, 'g');
  for (let i = 0; i < hits.length; i++) {
    const days = daysOf(hits[i][0]);
    const rest = t.slice(hits[i].index + hits[i][0].length, hits[i + 1]?.index ?? t.length);
    const times = [...rest.matchAll(TIME_ALL)];
    if (!days.length || !times.length || rest.slice(0, times[0].index).replace(/[\s,]/g, '').length > 6) continue;
    const at = [];
    // 「09:00–12:15 및 15:30–17:00 비행」: a cell per time; what follows a time (up to the next one) is what happens
    for (let j = 0; j < times.length; j++) {
      let slotText = times[j][0];
      let end = times[j].index + times[j][0].length;
      // 「아침 9시」: a word for the time of day right before a clock time is one slot
      const next = times[j + 1];
      if (next && !/\d/.test(slotText) && /\d/.test(next[0]) && /^\s*$/.test(rest.slice(end, next.index))) {
        slotText += ' ' + next[0];
        end = next.index + next[0].length;
        j++;
      }
      let after = rest.slice(end, times[j + 1]?.index ?? rest.length);
      // 「1시 30분까지」 is a time up to then, not a lesson called 「까지」
      if (/^\s*까지/.test(after)) slotText += '까지';
      after = after.replace(/^\s*(까지|부터|에|경|쯤)/, '').split(/[,，;；\n]|(?<=[.。])\s/)[0].replace(/(^|\s)및\s*$/, '').replace(/^[\s,]+|[\s,.]+$/g, '').trim();
      const slot = normSlot(slotText);
      if (slot) at.push({ slot, after });
    }
    for (const day of days) for (const c of at) out.push({ day, ...c });
  }
  return out;
}

/**
 * v0.6.4 e: an English timetable text in the shape the reader of Korean ones knows — 「Monday: 09:00–10:30 Charms (with
 * Ravenclaw, …); 10:45–12:15 Herbology」 → 「월요일: 09:00–10:30 Charms; 10:45–12:15 Herbology」. Days, 「daily」,
 * 「9 o'clock」 · 「1:30 pm」 · 「from 12:15 to 13:30」; what is in brackets (who with, which room) is left out. A text
 * with no English day stays as it is.
 */
const EN_DAYS = [['mon', '월'], ['tue', '화'], ['wed', '수'], ['thu', '목'], ['fri', '금'], ['sat', '토'], ['sun', '일']];
function englishWhen(text) {
  let t = String(text || '');
  if (!/\b(mon|tues?|wed|thu|fri|sat|sun)[a-z]*\b|\bdaily\b|\bevery day\b|\bweekdays?\b/i.test(t)) return t;
  t = t.replace(/\s*\([^)]*\)/g, '');
  t = t.replace(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday|s)?s?\b\.?/gi, (m, d) => `${EN_DAYS.find(([k]) => k === d.toLowerCase())[1]}요일`);
  t = t.replace(/\b(daily|every day)\b/gi, '매일').replace(/\bweekdays?\b/gi, '평일');
  // 「Luncheon runs daily from …」: what happens comes before the day — put it after the time, where it is read
  t = t.replace(/\b([A-Z][A-Za-z]+(?: [A-Za-z]+)?)\s+(?:runs|is held|is|are held|are|takes place|happens)\s+(매일|평일|[월화수목금토일]요일)\s+(?:from\s+)?(\d{1,2}:\d{2})\s*(?:to|until|till|–|-)\s*(\d{1,2}:\d{2})/g, '$2 $3–$4 $1');
  t = t.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?(?![a-z])/gi, (m, h, mm, ap) => { let n = Number(h) % 12; if (/p/i.test(ap)) n += 12; return `${String(n).padStart(2, '0')}:${mm || '00'}`; });
  t = t.replace(/\b(\d{1,2})\s*o['’]?clock\b/gi, '$1시');
  t = t.replace(/\bfrom\s+(\d{1,2}:\d{2})\s+(?:to|until|till)\s+(\d{1,2}:\d{2})/gi, '$1–$2').replace(/(\d{1,2}:\d{2})\s+(?:to|until|till)\s+(\d{1,2}:\d{2})/gi, '$1–$2');
  return t;
}

/**
 * v0.5.1 H: a field's text split into its timetable part and the rest — 「월·수 오후 도서관 당번, 책을 좋아함」 →
 * cells 월 · 수 오후 「도서관 당번」, moved 「월·수 오후 도서관 당번」, rest 「책을 좋아함」. A piece (between commas,
 * semicolons, lines or sentences) is timetable when it names a cell, or is only a time following one (「…, 2교시 약초학」);
 * days alone (「월요일, 수요일 오후 …」) go with the piece after them. Returns { cells, moved, rest }.
 */
function splitWhen(text) {
  const t = String(text || '').trim();
  const cells = parseWhen(t);
  if (!cells.length) return { cells, moved: '', rest: t };
  const parts = t.split(/\s*[,，;；\n]+\s*|(?<=[.。])\s+/).map((x) => x.trim()).filter(Boolean);
  const onlyDays = (p) => new RegExp(DAY_GROUP.source).test(p) && !p.replace(new RegExp(DAY_GROUP.source, 'g'), '').replace(/[\s·,/및]/g, '');
  const startsWithTime = new RegExp(`^(?:${TIME.source})`);
  const keep = [];
  const moved = [];
  let carry = '';
  let last = false;
  for (const p0 of parts) {
    const p = carry ? `${carry}, ${p0}` : p0;
    if (onlyDays(p)) { carry = p; continue; }
    carry = '';
    last = parseWhen(p).length > 0 || (last && startsWithTime.test(p));
    (last ? moved : keep).push(p);
  }
  if (carry) keep.push(carry);
  const join = (list) => list.reduce((s, p) => (s ? s + (/[.。]$/.test(s) ? ' ' : ', ') + p : p), '');
  return { cells, moved: join(moved), rest: join(keep) };
}

/**
 * When a slot is, in minutes of the day [start, end), or null when it cannot be told (「1교시」 has no clock time).
 * 「09:00–12:00」 · 「23:00–00:30」 (past midnight) · 「아침 9시」 / 「9시」 (an hour from then) · 「1시 30분까지」 (up to then,
 * 1–6시 read as afternoon) · words: 아침 6–10시, 오전 9–12시, 점심 11:30–13:30, 오후 12–18시, 저녁 17–21시, 밤 20–24시 …
 */
const WORD_SPAN = { 새벽: [180, 360], 아침: [360, 600], 오전: [540, 720], 점심: [690, 810], 오후: [720, 1080], 저녁: [1020, 1260], 밤: [1200, 1440], 자정: [1410, 1470] };
function span(slot) {
  const t = String(slot || '');
  const hm = (h, m) => (Number(h) < 7 && !/오전|아침|새벽/.test(t) ? Number(h) + 12 : Number(h)) * 60 + Number(m || 0);
  let m = t.match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const a = Number(m[1]) * 60 + Number(m[2]);
    let b = Number(m[3]) * 60 + Number(m[4]);
    if (b <= a) b += 1440;
    return [a, b];
  }
  m = t.match(/(\d{1,2})(?::(\d{2})|\s*시(?:\s*(\d{1,2})\s*분)?)/);
  if (m) {
    const at = /\d{1,2}:\d{2}/.test(m[0]) ? Number(m[1]) * 60 + Number(m[2]) : hm(m[1], m[3]);
    return /까지/.test(t) ? [at - 60, at] : [at, at + 60];
  }
  const w = Object.keys(WORD_SPAN).find((x) => t.startsWith(x));
  return w ? WORD_SPAN[w] : null;
}
/**
 * The sheet's cells looked at together (v0.5.0 B, by code): overlaps — two cells of one day whose times cross and
 * neither holds the other (shown as 「시간이 겹쳐요」, never merged or taken away by code); wide — a cell that holds
 * another (「09:00–15:00 수업」 with 「13:30–15:00 변신술」 in it: shown faintly, after the narrow ones in {{세계}}).
 */
function lookTogether(cells) {
  const list = Object.entries(cells || {}).map(([k, c]) => ({ k, day: c.day, s: span(c.slot) })).filter((x) => x.s);
  const overlaps = [];
  const wide = new Set();
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.day !== b.day || a.s[1] <= b.s[0] || b.s[1] <= a.s[0]) continue;
    const aHolds = a.s[0] <= b.s[0] && a.s[1] >= b.s[1];
    const bHolds = b.s[0] <= a.s[0] && b.s[1] >= a.s[1];
    if (aHolds && !bHolds) wide.add(a.k);
    else if (bHolds && !aHolds) wide.add(b.k);
    else overlaps.push([a.k, b.k]);
  }
  return { overlaps, wide: [...wide] };
}
/**
 * What else a cell can carry (v0.5.0 B, for the 시간표 screen to come — 시안 E): subject (과목 — the same subject the
 * same colour), place (장소, and its setting when the world has it), hours (how many 교시 · hours it runs, to join the
 * cells). Only what is given; never made up. Returns the cleaned facts.
 */
function cellExtras(raw) {
  const out = {};
  const subject = String(raw?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const place = String(raw?.place ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const hours = Number(raw?.hours);
  if (subject) out.subject = subject;
  if (place) out.place = place;
  if (typeof raw?.placeId === 'string' && raw.placeId) out.placeId = raw.placeId;
  if (Number.isInteger(hours) && hours >= 1 && hours <= 12) out.hours = hours;
  return out;
}
/** The subject a cell shows (its own, or the part of its value before 「—」 · 「(」 · 「,」): 「마법약 — 스네이프」 → 마법약. */
const subjectOf = (c) => c?.subject || String(c?.value || '').split(/\s*[—(,·]\s*|\s-\s/)[0].trim();
/** How long a cell runs in hours: its own 「hours」, or from a clock range (09:00–12:00 → 3); 1 when it cannot be told. */
function hoursOf(c) {
  if (c?.hours) return c.hours;
  const sp = /\d{1,2}:\d{2}\s*[–-]/.test(String(c?.slot || '')) ? span(c.slot) : null;
  return sp ? Math.max(1, Math.round((sp[1] - sp[0]) / 60)) : 1;
}

/** Keeps a sheet's overlaps and wide cells up to date (after every change to its cells). */
function refresh(sheet) {
  if (!sheet?.timetable) return sheet;
  const { overlaps, wide } = lookTogether(sheet.timetable.cells);
  sheet.timetable.overlaps = overlaps;
  sheet.timetable.wide = wide;
  return sheet;
}

/** The sheet as one short line for {{세계}}: 「월 1교시 마법약 · 월 2교시 변신술」 (a hidden-from-the-story cell is not special here). */
function timetableLine(e) {
  // the narrow cells first: a wide one (「09:00–15:00 수업」) only gives the background
  const wide = new Set(e.timetable?.wide || []);
  const cells = sortCells(e.timetable?.cells).filter((c) => c.value);
  const isWide = (c) => wide.has(cellKey(c.day, c.slot));
  return [...cells.filter((c) => !isWide(c)), ...cells.filter(isWide)].map((c) => `${c.day} ${c.slot} ${c.value}`).join(' · ');
}

function validTimetable(t) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(t) || typeof t.ownerId !== 'string' || !isObj(t.cells) || (t.year !== undefined && typeof t.year !== 'string')) return false;
  return Object.entries(t.cells).every(([k, c]) => isObj(c) && typeof c.day === 'string' && typeof c.slot === 'string' && k === cellKey(c.day, c.slot)
    && typeof c.value === 'string' && (c.evidence === undefined || typeof c.evidence === 'string')
    && (c.source === 'auto' || c.source === 'manual')
    && (c.past === undefined || (Array.isArray(c.past) && c.past.every((p) => isObj(p) && typeof p.value === 'string')))
    && (c.pending === undefined || (isObj(c.pending) && typeof c.pending.value === 'string'))
    && (c.subject === undefined || typeof c.subject === 'string') && (c.place === undefined || typeof c.place === 'string')
    && (c.placeId === undefined || typeof c.placeId === 'string') && (c.hours === undefined || (Number.isInteger(c.hours) && c.hours >= 1 && c.hours <= 12)));
}

module.exports = { englishWhen, DAYS, normDay, normSlot, cellKey, sortCells, slotRank, parseWhen, splitWhen, span, lookTogether, refresh, cellExtras, subjectOf, hoursOf, timetableLine, validTimetable, CELL_MAX, SLOT_MAX, PAST_MAX };
