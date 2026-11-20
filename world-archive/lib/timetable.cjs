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
const DAY_IN_TEXT = /(월|화|수|목|금|토|일)요일|매일|날마다|평일/g;
/**
 * The cells a 「언제」 text names, by code: 「금요일 아침 9시」 → 금 · 아침 9시? no — the first time phrase after the day:
 * 「금요일 아침」 → [금, 아침]; 「월요일 09:00–15:00, 화요일 09:00–15:00」 → two cells. A day without a time, or a date
 * (「9월 1일」), gives nothing: that is not a weekly cell.
 */
function parseWhen(text) {
  const t = String(text || '');
  const out = [];
  const hits = [...t.matchAll(DAY_IN_TEXT)];
  const TIME_ALL = new RegExp(TIME.source, 'g');
  for (let i = 0; i < hits.length; i++) {
    const day = normDay(hits[i][0]);
    const rest = t.slice(hits[i].index + hits[i][0].length, hits[i + 1]?.index ?? t.length);
    const times = [...rest.matchAll(TIME_ALL)];
    if (!day || !times.length || rest.slice(0, times[0].index).replace(/[\s,]/g, '').length > 6) continue;
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
      after = after.replace(/^\s*(까지|부터|에|경|쯤)/, '').split(/[,，]/)[0].replace(/(^|\s)및\s*$/, '').replace(/^[\s,]+|[\s,.]+$/g, '').trim();
      const slot = normSlot(slotText);
      if (slot) out.push({ day, slot, after });
    }
  }
  return out;
}

/** The sheet as one short line for {{세계}}: 「월 1교시 마법약 · 월 2교시 변신술」 (a hidden-from-the-story cell is not special here). */
function timetableLine(e) {
  return sortCells(e.timetable?.cells).filter((c) => c.value).map((c) => `${c.day} ${c.slot} ${c.value}`).join(' · ');
}

function validTimetable(t) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(t) || typeof t.ownerId !== 'string' || !isObj(t.cells)) return false;
  return Object.entries(t.cells).every(([k, c]) => isObj(c) && typeof c.day === 'string' && typeof c.slot === 'string' && k === cellKey(c.day, c.slot)
    && typeof c.value === 'string' && (c.evidence === undefined || typeof c.evidence === 'string')
    && (c.source === 'auto' || c.source === 'manual')
    && (c.past === undefined || (Array.isArray(c.past) && c.past.every((p) => isObj(p) && typeof p.value === 'string')))
    && (c.pending === undefined || (isObj(c.pending) && typeof c.pending.value === 'string')));
}

module.exports = { DAYS, normDay, normSlot, cellKey, sortCells, slotRank, parseWhen, timetableLine, validTimetable, CELL_MAX, SLOT_MAX, PAST_MAX };
