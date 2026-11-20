'use strict';
/**
 * 구성원 명단 (v0.5.0). Not stored and never written by the model: gathered by code from the 소속 relations, so a person's
 * card and the list cannot disagree. A smaller group in this one (소속 group → group, from the smaller) brings its people
 * too, marked with that group. The screen asks the server for it (GET …/entities/:id/members).
 *
 * Each person is one of three (by code): member · staff (맡은 사람 — a role word in their 소속 칸: 사감, 교수, 반장 …) ·
 * past (지난 구성원 — 「출신」, 「창립자」, 「과거에는」 in the 소속 칸 or the relation's note). unnamed: a name that is a
 * description (「캐로 자매 중 한 명」, 「판시 파킨슨의 사촌」), not counted as a name known.
 */
/** Role words: a 소속 칸 with one is someone who holds a post there, not a plain member (and such a piece is not a group). */
const ROLE_WORDS = /(교수|교사|선생|사감|기숙사장|반장|감독생|교장|부교장|학장|원장|단장|부단장|회장|부회장|대장|주장|관리인|관리자|사서|집사|하인|하녀|시종|주인|점원|지배인|족장|우두머리|지도자|수장)/;
const PAST_WORDS = /(출신|졸업|전직|前|예전|옛|과거|였던|였음|창립자|설립자)/;
/** 「○○의 사촌」 · 「○○ 중 한 명」 · 「주근깨 있는 그리핀도르 남학생」: a person named by a description. */
function unnamed(name) {
  const n = String(name || '').trim();
  return /의\s/.test(n) || /(중 한 명|중 하나)$/.test(n) || /\s(있는|없는|입은|든|쓴)\s/.test(n)
    || (/\s/.test(n) && /(여학생|남학생|학생|소년|소녀|아이|사람|남자|여자)$/.test(n));
}

/**
 * @returns {null | { groupId, members: { entityId, name, via, viaId, kind: 'member'|'staff'|'past', unnamed }[],
 *   groups: { entityId, name, parentId }[], counts: { member, staff, past, named } }}
 */
function rosterOf(entities, relations, groupId) {
  const byId = new Map((entities || []).map((e) => [e.entityId, e]));
  if (byId.get(groupId)?.type !== 'group') return null;
  const aff = (relations || []).filter((r) => r.type === '소속');
  const groups = [];
  const order = [groupId];
  const seen = new Set(order);
  const at = new Map(); // person → the deepest group (in walk order) that lists them
  const notes = new Map(); // person → the notes of their 소속 relations here
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    for (const r of aff) {
      const other = r.from === id ? r.to : r.to === id ? r.from : null;
      const o = other && byId.get(other);
      if (!o) continue;
      if (o.type === 'person') {
        at.set(other, id);
        if (r.note) notes.set(other, [...(notes.get(other) || []), r.note]);
      } else if (o.type === 'group' && r.from === other && !seen.has(other)) {
        seen.add(other);
        order.push(other);
        groups.push({ entityId: other, name: o.name, parentId: id });
      }
    }
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  const members = [...at].map(([pid, gid]) => {
    const p = byId.get(pid);
    const aff = String(p.fields?.affiliation || '');
    const past = PAST_WORDS.test(aff) || (notes.get(pid) || []).some((n) => /과거에는/.test(n));
    const kind = past ? 'past' : ROLE_WORDS.test(aff) ? 'staff' : 'member';
    return { entityId: pid, name: p.name, via: gid === groupId ? null : byId.get(gid).name, viaId: gid === groupId ? null : gid, kind, unnamed: unnamed(p.name) };
  });
  const KIND_RANK = { member: 0, staff: 1, past: 2 };
  members.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || rank.get(a.viaId || groupId) - rank.get(b.viaId || groupId) || a.name.localeCompare(b.name, 'ko'));
  const count = (k) => members.filter((m) => m.kind === k).length;
  return { groupId, members, groups, counts: { member: count('member'), staff: count('staff'), past: count('past'), named: members.filter((m) => !m.unnamed).length } };
}

module.exports = { rosterOf, unnamed, ROLE_WORDS, PAST_WORDS };
