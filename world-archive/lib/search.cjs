'use strict';
// 할 일 6 — 검색. Code only (no model): names, other names, field values, memos and extra fields, ignoring case and
// spaces. Results: name hits first, then other-name hits, then content hits; each with the matched part marked.
// glossary: [{ from: 'Severus Snape', to: '세베루스 스네이프' }] — searching the English finds the Korean name too.

/** The text without spaces, lower case, and where each kept letter came from (to mark the match in the original). */
function folded(text) {
  const src = String(text || '').normalize('NFC');
  let out = '';
  const at = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) continue;
    out += ch.toLowerCase();
    at.push(i);
  }
  return { out, at, src };
}

/** The first place q (already folded) is in text: { text, start, end } in the original text, or null. */
function find(text, q) {
  if (!q) return null;
  const f = folded(text);
  const i = f.out.indexOf(q);
  if (i < 0) return null;
  return { text: f.src, start: f.at[i], end: f.at[i + q.length - 1] + 1 };
}

const fold = (s) => folded(s).out;
const CLIP = 120;
/** A short piece of a long text around the match, with start / end moved to match. */
function around(hit) {
  if (hit.text.length <= CLIP) return hit;
  const from = Math.max(0, hit.start - 40);
  const to = Math.min(hit.text.length, Math.max(hit.end + 40, from + CLIP));
  const pre = from > 0 ? '…' : '';
  return { text: pre + hit.text.slice(from, to) + (to < hit.text.length ? '…' : ''), start: hit.start - from + pre.length, end: hit.end - from + pre.length };
}

/**
 * entities: the world's settings; q: what was typed; types: kinds to keep (all when empty); glossary: pairs.
 * Returns [{ entityId, type, name, rank (0 name · 1 other name · 2 content), hits: [{ where, text, start, end }] }].
 * where: 'name' · 'alias' · 'glossary' · a field key · 'description' · 'extra:<label>'.
 */
function search(entities, q, { types = [], glossary = [], fields = {} } = {}) {
  const qf = fold(q);
  if (!qf) return [];
  // English typed → the Korean names the glossary gives it (and the other way round).
  const via = (Array.isArray(glossary) ? glossary : []).filter((p) => fold(p.from).includes(qf) || fold(p.to).includes(qf));
  const out = [];
  for (const e of entities || []) {
    if (types.length && !types.includes(e.type)) continue;
    const hits = [];
    let rank = 3;
    const name = find(e.name, qf);
    if (name) (hits.push({ where: 'name', ...name }), (rank = 0));
    for (const a of e.aliases || []) {
      const h = find(a, qf);
      if (h) {
        hits.push({ where: 'alias', ...h });
        rank = Math.min(rank, 1);
      }
    }
    for (const p of via) {
      if ([e.name, ...(e.aliases || [])].some((n) => fold(n) === fold(p.to) || fold(n) === fold(p.from))) {
        const h = find(`${p.from} = ${p.to}`, qf);
        if (h) hits.push({ where: 'glossary', label: '번역 단어장', ...h });
        rank = Math.min(rank, 1);
      }
    }
    for (const [k, v] of Object.entries(e.fields || {})) {
      const h = find(v, qf);
      if (h) (hits.push({ where: k, label: fields[e.type]?.find((f) => f.key === k)?.label || k, ...around(h) }), (rank = Math.min(rank, 2)));
    }
    const memo = find(e.description, qf);
    if (memo) (hits.push({ where: 'description', label: '메모', ...around(memo) }), (rank = Math.min(rank, 2)));
    for (const x of e.extra || []) {
      const h = find(x.value, qf) || find(x.label, qf);
      if (h) (hits.push({ where: `extra:${x.label}`, label: x.label, ...around(h) }), (rank = Math.min(rank, 2)));
    }
    if (hits.length) out.push({ entityId: e.entityId, type: e.type, name: e.name, rank, hits });
  }
  return out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ko'));
}

module.exports = { search, find, fold };
