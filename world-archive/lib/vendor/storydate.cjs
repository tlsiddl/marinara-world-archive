'use strict';
// 이야기 속 날짜 읽기 (v0.5.0 K · 이야기 속 오늘). Copied unchanged from tlsiddl/marinara-memory-module main 32f72b9
// (0.38.3 — 상태창의 여덟 자리 숫자를 날짜로 읽지 않음; 0.38.2 — 20xx가 아닌 연도, 이야기가 과거로 가면 따라감),
// memory-module/lib/ledger.cjs lines 1712–1985 (WEEKDAYS … storyTime): the 「§RP | 24-10-18 (금) | 11:15 | …§」 header and other date lines.

const WEEKDAYS = '일월화수목금토';

/**
 * A two-digit year as a full one: the century of the story's day (`base`) that puts it nearest that day, so in a
 * story of 1766 "66-08-19" is 1766, not 2066. Without a known day, 20xx.
 */
function fullYear(two, base = null) {
  const yy = Number(two);
  const by = base ? Number(String(base).slice(0, 4)) : NaN;
  if (!Number.isFinite(by)) return 2000 + yy;
  const c = Math.floor(by / 100) * 100;
  return [c - 100 + yy, c + yy, c + 100 + yy].sort((a, b) => Math.abs(a - by) - Math.abs(b - by))[0];
}

/** "24-10-18" for showing a day of 20xx; any other year is written in full ("1766-08-19"), so it reads back the same. */
function shortDay(iso) {
  return /^20\d{2}-/.test(String(iso || '')) ? String(iso).slice(2) : String(iso || '');
}

/** "24-10-18" / "2024-10-18" / "10-18" (year from `base`) → "2024-10-18", or null. */
function isoDate(text, base = null) {
  const m = String(text || '').match(/(?:(\d{2}|\d{4})[-./])?(\d{1,2})[-./](\d{1,2})/);
  if (!m) return null;
  const year = m[1] ? (m[1].length === 2 ? fullYear(m[1], base) : Number(m[1])) : base ? Number(base.slice(0, 4)) : null;
  if (!year) return null;
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3])));
  if (year < 100) d.setUTCFullYear(year);
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]) ? null : d.toISOString().slice(0, 10);
}

/** "2024-03-01", "1766.8.19", "2024/3/1" with a full year → "2024-03-01", or null (a date the user typed in). */
function isoDateStrict(text) {
  const m = String(text || '').trim().match(/^(\d{3,4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?$/);
  return m ? isoDate(`${m[1].padStart(4, '0')}-${m[2]}-${m[3]}`) : null;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The story's day as of the last message that shows one (a header like "§RP | 24-10-18 (금) | 11:15 | …§", or the
 * tracker's date). The last one, not the latest: a story that goes back in time, or a tracker that puts a wrong
 * start right, is where the story is now.
 */
function storyDate(messages, base = null) {
  let latest = null;
  for (const m of messages || []) {
    // clockOnly: a date set by hand, or a room that reads dates from the tracker only (its clock already says).
    const own = m.clockOnly ? null : dateInText(m.content, latest || base);
    if (own) latest = own.date;
    else if (m.clock?.date) latest = m.clock.date;
  }
  return latest;
}

const WEEKDAY_WORD = /[월화수목금토일]요일|\(\s*[월화수목금토일]\s*\)|\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|urday|rsday)?\b/i;

/**
 * The story date a line states, when the line is a date line ("24-10-18 (금) | 14:00", "2027년 4월 14일 수요일 |
 * 10시 30분", "[2027.04.14 (수) 10:30 · 카페]"), not a sentence that mentions a date ("4월 14일에 보자.", a quote).
 * A date line has a year or a weekday, is short, and is not said or written as part of a sentence.
 */
function dateLine(line, base = null) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 90 || /[.!?…。]["”’」』)]*$/.test(raw)) return null;
  const t = raw.replace(/^[^\p{L}\p{N}"“'‘「『]+/u, '');
  if (/["“”「」『』]/.test(t)) return null;
  if (!/(?<!\d)\d{8}(?!\d)|\d{4}\s*년|\d{2,4}[-./]\d{1,2}[-./]\d{1,2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s*\d{4}/i.test(t) && !WEEKDAY_WORD.test(t)) return null;
  // "14일에", "14일까지", "18일이었다": a date inside a sentence.
  if (/\d\s*일\s*(?:에|엔|까지|부터|쯤|께|이었|이야|이다|이라|이니|인데|로|은|는|의)/.test(t) || /요일\s*(?:에|엔|까지|부터|이었|이야|이다|인데|은|는|의)/.test(t)) return null;
  // An English line with many words around the date is a sentence that mentions it, not a date line.
  if ((t.match(/\b[a-z]{2,}\b/g) || []).filter((w) => !/^(?:am|pm|at|of|the|on|and|in|st|nd|rd|th)$/.test(w)).length > 4) return null;
  const c = parseClock(t, base);
  // Eight digits as the only sign of a day, under another label and with no time ("금화|20241018", "💰 금화 20241018"):
  // an amount, however much it looks like a day. "📅 20241018", "날짜: 20241018" or "20241018 19:25" are days.
  if (c?.date && !c.time && /(?<!\d)\d{8}(?!\d)/.test(t) && !WEEKDAY_WORD.test(t) && !/\d{4}\s*년|\d{2,4}[-./]\d{1,2}[-./]\d{1,2}/.test(t)) {
    const rest = t.replace(/(?<!\d)\d{8}(?!\d)/, '').replace(/날짜|일자|작중|오늘|\bdate\b|\bday\b|\brp\b/gi, '');
    if (/\p{L}/u.test(rest)) return null;
  }
  return c?.date ? c : null;
}

/** The latest date line of a message (its own story date and time), or null. */
function dateInText(content, base = null) {
  let best = null;
  const take = (c) => {
    if (c?.date && (!best || `${c.date}T${c.time || ''}` > `${best.date}T${best.time || ''}`)) best = c;
  };
  const text = String(content || '');
  // Compact dates in an explicit RP header can appear inline with prose.
  for (const hit of text.matchAll(/§\s*RP\s*\|\s*(\d{8})(?=\s*\|)([^§]*)/gi)) {
    take(parseClock(`${hit[1]} ${hit[2]}`, base));
  }
  // A bracketed header of fields, also inline before prose and whatever the place or weather field says:
  // "[20201018|19:25] 그녀가…", "[RP|20201018|19:35|"블루문" 바|비]", "[RP|2020년 10월 18일|19:35|…]".
  // Read field by field: the first field that is a date, then the first field after it that is a time.
  for (const hit of text.matchAll(/[[【]\s*((?:[A-Za-z가-힣]{1,6}\s*\|\s*)?[^|\]】\n]{4,24}\|[^\]】\n]{1,200})[\]】]/g)) {
    const fields = hit[1].split('|').map((f) => f.trim());
    const at = fields.findIndex((f, i) => i < 2 && /\d/.test(f) && parseClock(f, base)?.date);
    if (at < 0) continue;
    const c = parseClock(fields[at], base);
    const time = c.time || fields.slice(at + 1, at + 3).map((f) => parseClock(f)).find((x) => x?.time && !x.date)?.time || null;
    // "3/10" or "4.5" alone is a score as often as a day ("[서아|3/10|기분 좋음]", "[호감도|4.5]"): a day only with a
    // year, a month word ("3월 10일", "Mar 10") or a time beside it.
    if (/^\d{1,2}\s*[-./]\s*\d{1,2}$/.test(fields[at]) && !time) continue;
    // Eight digits alone ("20241018") under a label that is not a date's ("[금화|20241018]") is an amount, however
    // much it looks like a day: a day when it leads the bracket, follows a date label (RP, 날짜, 📅), or has a time.
    if (/^\d{8}$/.test(fields[at]) && !time && at > 0 && !/^(?:rp|날짜|일자|작중|date|day|\p{Extended_Pictographic})/iu.test(fields[0])) continue;
    take({ date: c.date, time });
  }
  // A numeric date with its weekday in brackets is a header wherever it stands, even inline before a line of
  // dialogue ("§RP | 24-10-18 (금) | 02:32 | 서재§ 하루 | …").
  for (const hit of text.matchAll(/(\d{2,4}-\d{1,2}-\d{1,2})\s*\([월화수목금토일]\)(?:\s*\|?\s*(\d{1,2}:\d{2}))?/g)) {
    const date = isoDate(hit[1]);
    if (date) take({ date, time: hit[2] ? hit[2].padStart(5, '0') : null });
  }
  // A status window drawn with inline tags (<span>) reads as one line: "📅 2020.10.18 (일) 🕐 19:35 👔 니트 📝 …".
  // Two or more emoji labels on a line make it a row of fields, one field per emoji.
  const lines = text.split('\n').flatMap((line) => ((line.match(/\p{Extended_Pictographic}/gu) || []).length >= 2 ? line.split(/(?=\p{Extended_Pictographic})/u) : [line]));
  lines.forEach((line, i) => {
    const c = dateLine(line, best?.date || base);
    // A status window often puts the time on its own line, not always right under the date
    // ("📅 2024년 10월 18일 (금)" / "📍 카페" / "🕐 오후 3:20").
    if (c && !c.time) c.time = timeNearDate(lines, i);
    take(c);
  });
  return best;
}

/** A line that can be part of a status window: short, not a sentence, not a quote. Blank lines are skipped. */
function statusLike(line) {
  const t = String(line || '').trim();
  return t.length <= 90 && !/[.!?…。]["”’」』)]*$/.test(t) && !/["“”「」『』]/.test(t);
}

const TIME_LABEL = /(시간|시각|현재\s*시|time|clock|[\u{1F550}-\u{1F567}⏰⌚⏱⏲🕰])/iu;
// A clock time, not a count or a range: "15:20", "오후 3시 20분", "3:20 PM". "09:00~18:00" is a range.
const CLOCK_TIME = /(?:(?:오전|오후|새벽|아침|저녁|밤)\s*)?\d{1,2}\s*(?::\s*\d{2}|시(?!\s*(?:간|방향|쯤에|에\s|까지)))/;
const TIME_RANGE = /\d\s*(?::\s*\d{2}|시)?\s*[~〜\-–]\s*\d{1,2}\s*(?::|시)/;

/**
 * The time in the same status window as the date line `i`: the block of status-like lines around it, up to the
 * next date line or a line of prose. A labelled time ("🕐", "시간:") wins over a bare one; none is null.
 */
function timeNearDate(lines, i) {
  const block = [];
  for (const step of [-1, 1]) {
    for (let j = i + step, seen = 0; j >= 0 && j < lines.length && seen < 12; j += step) {
      const t = lines[j].trim();
      if (!t) continue;
      if (!statusLike(t) || dateLine(t)) break;
      block.push(t);
      seen++;
    }
  }
  const times = block.filter((t) => CLOCK_TIME.test(t) && !TIME_RANGE.test(t)).map((t) => ({ t, c: parseClock(t) })).filter((x) => x.c?.time && !x.c.date);
  return (times.find((x) => TIME_LABEL.test(x.t)) || (times.length === 1 ? times[0] : null))?.c.time || null;
}

/**
 * A date and time written in a tracker field, in the forms people use: "2024-10-18", "24.10.18", "2024년 10월 18일",
 * "10월 18일" or "10/18" (year from `base`), "14:30", "오후 2시 30분", "2:30 PM". Returns { date, time } or null.
 * "Day 3" or "3일차" is not a calendar date: null (the story then keeps order only).
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseClock(text, base = null) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let date = null;
  const compact = raw.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (compact) date = isoDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const ko = raw.match(/(?:(\d{2}|\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일(?!\s*차)/);
  if (!date && ko) date = isoDate(`${ko[1] ? `${ko[1]}-` : ''}${ko[2]}-${ko[3]}`, base);
  const cjk = !date && raw.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (cjk) date = isoDate(`${cjk[1] ? `${cjk[1]}-` : ''}${cjk[2]}-${cjk[3]}`, base);
  if (!date) {
    // English: "October 18, 2024", "Oct 18th", "18 October 2024", "Fri, Oct 18 2024".
    const month = (m) => MONTHS.findIndex((x) => m.toLowerCase().startsWith(x)) + 1;
    // Also "the 2nd of March" and "March the 2nd".
    const mdy = raw.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/i);
    const dmy = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,?\s*(\d{4}))?/i);
    if (mdy) date = isoDate(`${mdy[3] ? `${mdy[3]}-` : ''}${month(mdy[1])}-${mdy[2]}`, base);
    else if (dmy) date = isoDate(`${dmy[3] ? `${dmy[3]}-` : ''}${month(dmy[2])}-${dmy[1]}`, base);
  }
  if (!date) {
    const num = raw.match(/(?<![\d:])(?:(\d{4}|\d{2})[-./]\s*)?(\d{1,2})[-./]\s*(\d{1,2})(?![\d:])/);
    if (num) date = isoDate(`${num[1] ? `${num[1]}-` : ''}${num[2]}-${num[3]}`, base);
  }
  let time = null;
  const hm = raw.match(/(오전|오후|새벽|아침|저녁|밤)?\s*(\d{1,2})\s*(?::\s*(\d{2})|시\s*(?:(\d{1,2})\s*분|반)?)\s*(AM|PM|am|pm)?/);
  if (hm && (hm[3] !== undefined || /시/.test(hm[0]))) {
    let h = Number(hm[2]);
    const min = hm[3] !== undefined ? Number(hm[3]) : hm[4] !== undefined ? Number(hm[4]) : /반/.test(hm[0]) ? 30 : 0;
    const pm = /오후|저녁|밤|PM|pm/.test(`${hm[1] || ''}${hm[5] || ''}`);
    const am = /오전|새벽|아침|AM|am/.test(`${hm[1] || ''}${hm[5] || ''}`);
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    if (/밤/.test(hm[1] || '') && h === 24) h = 0;
    if (h < 24 && min < 60) time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return date || time ? { date, time } : null;
}

/**
 * A story-day counter in a tracker's date: "Day 3", "Day 3 of spring", "D+3", "3일차", "3일째", "제3일", "the 3rd day".
 * Its number, or null. It is not a calendar date: the date it means is counted from a day whose date is known.
 */
function dayCounter(text) {
  const t = String(text || '');
  const m = t.match(/\bday\s*#?\s*(\d{1,4})\b/i) || t.match(/\bD\s*\+\s*(\d{1,4})\b/) || t.match(/(\d{1,4})\s*일\s*(?:차|째)/) || t.match(/제\s*(\d{1,4})\s*일/) || t.match(/\b(\d{1,4})(?:st|nd|rd|th)\s+day\b/i) || t.match(/第\s*(\d{1,4})\s*[天日]/);
  return m ? Number(m[1]) : null;
}

const WEEKDAY_NAMES = [/\bsun(?:day)?\b|일요일/i, /\bmon(?:day)?\b|월요일/i, /\btue(?:s|sday)?\b|화요일/i, /\bwed(?:nesday)?\b|수요일/i, /\bthu(?:r|rs|rsday)?\b|목요일/i, /\bfri(?:day)?\b|금요일/i, /\bsat(?:urday)?\b|토요일/i];
/** The weekday a tracker's date names ("Saturday", "토요일"), 0 = Sunday, or null (none, or more than one). */
function weekdayOf(text) {
  const hits = WEEKDAY_NAMES.map((re, i) => (re.test(String(text || '')) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * " (작중 24-10-18 (금) 14:00 · 날씨: 비)" after a speaker name: the story date from a tracker (when the message has
 * no date line of its own) and the tracker's weather.
 */
function clockNote(message) {
  const c = message?.clock;
  const parts = [];
  if ((c?.date || c?.time || c?.label) && (message.clockOnly || !dateInText(message.content, c?.date || null))) {
    // A tracker date that could not be read as a calendar day is passed on in its own words (not an older date).
    const day = c.date ? `${shortDay(c.date)} (${WEEKDAYS[new Date(`${c.date}T00:00:00Z`).getUTCDay()]})` : c.label || '';
    parts.push(`작중 ${[day, c.time].filter(Boolean).join(' ')}`);
  }
  if (message?.weather) parts.push(`날씨: ${message.weather}`);
  return parts.length ? ` (${parts.join(' · ')})` : '';
}

const ROUTINE = ['meal', 'wash', 'groom', 'sleep', 'wake', 'medicine'];
const ROUTINE_KEEP = 40;
const PAST_DAYS = 3;
const COSMETICS = /(화장(?!실)|메이크업|마스카라|립스틱|립\s*마무리|향수|헤어스타일|make\s?up|mascara|lipstick|perfume)/i;
const WASHING = /(샤워|목욕|세수|양치|씻|머리\s*감|클렌징|외출\s*준비|shower|bath|wash)/i;
const routineDisplayKind = (r) => r.what === 'wash' && COSMETICS.test(r.text || '') && !WASHING.test(r.text || '') ? 'groom' : r.what;
const DRINK_OR_SMOKE = /(담배|시가|궐련|커피|라떼|술|맥주|와인|버번|위스키|보드카|칵테일|음료|주스|우유|콜라|탄산|녹차|홍차|(?:^|\s)물(?:\s|을|만|$)|얼음물|생수|사탕|껌)/;
const FOOD = /(밥|식사|끼니|아침|점심|저녁|야식|브런치|스테이크|고기|빵|토스트|샌드위치|죽|국|찌개|요리|면|라면|파스타|샐러드|피자|햄버거|계란|달걀|과일|수프|스프|도시락|김밥|떡)/;

/** Drinks, smokes and sweets are not meals, even if the model files them as one. */
function notAMeal(text) {
  return Boolean(text) && DRINK_OR_SMOKE.test(text) && !FOOD.test(text);
}

/** The newest in-story date and time, "2024-10-18T11:15", from headers like "24-10-18 (금) | 11:15". */
function storyTime(messages, base = null) {
  let latest = null;
  for (const m of messages || []) {
    const own = m.clockOnly ? null : dateInText(m.content, latest?.slice(0, 10) || base);
    const found = !!own;
    // A date line without a time takes the tracker's time when the tracker is on the same day.
    const time = own?.time || (own && m.clock?.date === own.date ? m.clock.time : null);
    if (time) {
      const at = `${own.date}T${time}`;
      if (!latest || at > latest) latest = at;
    }
    // No date line in the message: the tracker's date and time for it, when both are known.
    if (!found && m.clock?.date && m.clock.time) {
      const at = `${m.clock.date}T${m.clock.time}`;
      if (!latest || at > latest) latest = at;
    }
  }
  return latest;
}

module.exports = { isoDate, isoDateStrict, addDays, storyDate, dateLine, dateInText, parseClock, storyTime, WEEKDAYS, fullYear, shortDay };
