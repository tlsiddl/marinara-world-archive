'use strict';
/**
 * 구성원 명단 (v0.5.0). Not stored and never written by the model: gathered by code from the 소속 relations, so a person's
 * card and the list cannot disagree. A smaller group in this one (소속 group → group, from the smaller) brings its people
 * too, marked with that group. extension/extension.js has the same walk for the screen (rosterOf there).
 *
 * @returns {null | { groupId: string, members: { entityId: string, name: string, via: string|null, viaId: string|null }[],
 *   groups: { entityId: string, name: string, parentId: string }[] }}
 */
function rosterOf(entities, relations, groupId) {
  const byId = new Map((entities || []).map((e) => [e.entityId, e]));
  if (byId.get(groupId)?.type !== 'group') return null;
  const aff = (relations || []).filter((r) => r.type === '소속');
  const groups = [];
  const order = [groupId];
  const seen = new Set(order);
  const at = new Map(); // person → the deepest group (in walk order) that lists them
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    for (const r of aff) {
      const other = r.from === id ? r.to : r.to === id ? r.from : null;
      const o = other && byId.get(other);
      if (!o) continue;
      if (o.type === 'person') at.set(other, id);
      else if (o.type === 'group' && r.from === other && !seen.has(other)) {
        seen.add(other);
        order.push(other);
        groups.push({ entityId: other, name: o.name, parentId: id });
      }
    }
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  const members = [...at].map(([pid, gid]) => ({
    entityId: pid,
    name: byId.get(pid).name,
    via: gid === groupId ? null : byId.get(gid).name,
    viaId: gid === groupId ? null : gid,
  }));
  members.sort((a, b) => rank.get(a.viaId || groupId) - rank.get(b.viaId || groupId) || a.name.localeCompare(b.name, 'ko'));
  return { groupId, members, groups };
}

module.exports = { rosterOf };
