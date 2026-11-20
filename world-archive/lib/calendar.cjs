'use strict';
/**
 * 학사일정 (v0.5.0 K): one sheet per owner (a group or a place; none = the whole world) of dated events that happen
 * once — 입학식, 연회, 경기, 방학, 시험. A schedule setting with a `calendar` { ownerId, events: { id: { date, end?, when?,
 * name, place?, placeId?, who?, evidence, source, at, past?, cancelled?, pending? } } }. A date is 「YYYY-MM-DD」 or, when
 * the year is not known, 「--MM-DD」; a date nobody can tell yet (「다음 주」 with no story day known) keeps its words in
 * `when` and no date. Also the story's today (from the §RP header) and the school year (학년도).
 */
const D = require('./vendor/storydate.cjs');

const WEEKDAYS = '일월화수목금토';
const NAME_MAX = 80;

/** 「1991-10-31」 · 「91.10.31」 · 「1991년 10월 31일」 · 「10월 31일」 (no year: --10-31) · 「10/31」 → a date, or null. */
function normDate(text, baseYear = null) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let m = t.match(/^--(\d{2})-(\d{2})$/);
  if (m) return t;
  const iso = D.isoDate(t, baseYear ? `${baseYear}-01-01` : null);
  if (iso && /\d{2,4}[-./]\d{1,2}[-./]\d{1,2}/.test(t)) {
    // 「91.10.31」 in a story of 1991: the story's century, not 2091
    const two = t.match(/^(\d{2})[-./]/);
    return two && baseYear ? `${Math.floor(baseYear / 100) * 100 + Number(two[1])}${iso.slice(4)}` : iso;
  }
  m = t.match(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) m = t.match(/^(?:(\d{4})[-./])?(\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const [mo, d] = [Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const y = m[1] ? Number(m[1]) : baseYear;
  const two = (x) => String(x).padStart(2, '0');
  if (!y) return `--${two(mo)}-${two(d)}`;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? `${y}-${two(mo)}-${two(d)}` : null;
}
const hasYear = (date) => /^\d{4}-/.test(String(date || ''));
/** Days from a to b (both YYYY-MM-DD), or null. */
function daysBetween(a, b) {
  if (!hasYear(a) || !hasYear(b)) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
/** 「1891–92」: the school year a date falls in, the year starting in startMonth (default 9). null without a year. */
function schoolYear(date, startMonth = 9) {
  if (!hasYear(date)) return null;
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(5, 7));
  const first = mo >= startMonth ? y : y - 1;
  return startMonth === 1 ? String(first) : `${first}–${String(first + 1).slice(-2)}`;
}

/**
 * The story's today from a room's messages (the newest date line — the §RP header and the like, as the Memory Module
 * reads it) and its weekday: the one the header writes (「(금)」) wins over the calendar's. null when nothing says it.
 */
function storyToday(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const date = D.storyDate(list);
  if (!date) return null;
  let weekday = null;
  for (let i = list.length - 1; i >= 0 && !weekday; i--) {
    const text = String(list[i]?.content || '');
    const at = D.dateInText(text);
    if (at?.date !== date) continue;
    const m = text.match(/\(\s*([월화수목금토일])\s*\)/) || text.match(/([월화수목금토일])요일/);
    if (m) weekday = m[1];
  }
  return { date, weekday: weekday || WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()], written: Boolean(weekday) };
}

const sortEvents = (events) => Object.values(events || {}).sort((a, b) => String(a.date || '9999').replace(/^--/, '0000-').localeCompare(String(b.date || '9999').replace(/^--/, '0000-')) || a.name.localeCompare(b.name, 'ko'));

/**
 * The next n events (not cancelled) from today; without today, the first n by date — then no 「며칠 뒤」.
 * Returns [{ e, days }].
 */
function upcoming(cal, today = null, n = 3) {
  const list = sortEvents(cal?.events).filter((e) => !e.cancelled && e.date);
  const t = today && hasYear(today) ? today : null;
  const pick = t ? list.filter((e) => hasYear(e.date) && (e.end || e.date) >= t) : list;
  return pick.slice(0, n).map((e) => ({ e, days: t ? daysBetween(t, e.date) : null }));
}
const short = (date) => (date ? `${Number(date.slice(-5, -3))}/${Number(date.slice(-2))}` : '');
/** One line for {{세계}}: 「다가오는 일: 10/31 핼러윈 연회 (5일 뒤) · 11/7 첫 경기 (12일 뒤)」, or '' with nothing ahead. */
function calendarLine(e, today = null) {
  const list = upcoming(e.calendar, today, 3);
  if (!list.length) return '';
  const when = (d) => (d == null ? '' : d === 0 ? ' (오늘)' : d > 0 ? ` (${d}일 뒤)` : ' (진행 중)');
  return '다가오는 일: ' + list.map(({ e: x, days }) => `${short(x.date)}${x.end && x.end !== x.date ? `~${short(x.end)}` : ''} ${x.name}${x.place ? ` · ${x.place}` : ''}${when(days)}`).join(' · ');
}

function validCalendar(c) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(c) || (c.ownerId !== null && typeof c.ownerId !== 'string') || !isObj(c.events)) return false;
  return Object.values(c.events).every((e) => isObj(e) && typeof e.name === 'string' && (e.date === undefined || e.date === null || typeof e.date === 'string')
    && (e.source === 'auto' || e.source === 'manual') && (e.past === undefined || Array.isArray(e.past)) && (e.pending === undefined || isObj(e.pending)));
}

module.exports = { normDate, hasYear, daysBetween, schoolYear, storyToday, sortEvents, upcoming, calendarLine, validCalendar, NAME_MAX, WEEKDAYS };
