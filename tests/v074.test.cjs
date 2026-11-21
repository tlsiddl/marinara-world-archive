'use strict';
// v0.7.4 — 정리 후보 ② narrower; 주제 다시 매기기; 숨김 at a third (and true hidden ones stay); world laws after the
// place's rules in a scene; a 위치 칸 that is only a group's name goes into its 본거지.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('../world-archive/lib/inject.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-074-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

test('1) 「한 번만 나왔어요」 leaves out a rule of a place or group and money', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [{ type: 'place', name: 'Great Hall' }]);
  const hall = s.listEntities(w.worldId)[0].entityId;
  s.applyAuto(w.worldId, [
    { type: 'rule', name: 'Snape quizzes on Friday' },
    { type: 'rule', name: 'No kissing at the High Table', appliesTo: hall },
    { type: 'system', name: 'Wizarding currency' },
  ], { messageIds: ['m1'] });
  s.saveTidy(w.worldId, { at: null, items: [], fields: [] });
  assert.deepEqual(s.readTidy(w.worldId).once.map((x) => x.name), ['Snape quizzes on Friday']);
});

test('2) 주제 다시 매기기: the automatic ones asked again, the person\'s kept, recorded', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const real = require('../world-archive/lib/vendor/engine.cjs');
  const s = temp(t);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Hogwarts', auto: { connectionId: 'c1' } });
  s.applyAuto(w.worldId, [{ type: 'rule', name: 'Common room password' }, { type: 'rule', name: 'Mine' }]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  s.setTopic(w.worldId, id('Common room password'), '금지·예절', { by: 'reader' });
  const mine = s.listEntities(w.worldId).find((e) => e.name === 'Mine');
  s.updateEntity(w.worldId, mine.entityId, { revision: mine.revision, topic: '돈·거래' });
  let asked = '';
  service._test.useEngine({ model: async (c) => ({ id: c }), askModel: async (m, msgs) => { asked = msgs[1].content; return { content: JSON.stringify({ rules: [{ name: 'Common room password', topic: '그 밖' }, { name: 'Mine', topic: '그 밖' }] }) }; }, parseJsonObject: real.parseJsonObject });
  const plain = await service.fillTopics(w.worldId);
  assert.equal(plain.asked, 0, 'without redo: none are empty');
  const r = await service.fillTopics(w.worldId, { redo: true });
  assert.equal(r.asked, 1);
  assert.doesNotMatch(asked, /Mine/);
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.deepEqual([by('Common room password').topic, by('Mine').topic], ['그 밖', '돈·거래']);
  assert.ok(s.listHistory(w.worldId).some((c) => c.action === 'topic' && c.before === '금지·예절' && c.after === '그 밖'));
});

test('3) 숨김: more than a third and more than two key words take it off; two words leave it hidden', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Liverpool' });
  const value = 'Tall severe woman with emerald robes, square spectacles and a tight black bun';
  s.applyProfiles(w.worldId, [
    { kind: 'npc', name: 'Minerva', fields: { appearance: value }, lines: { name: 'Name: Minerva', appearance: 'Appearance: ' + value } },
    { kind: 'npc', name: 'Severus', fields: { appearance: value }, lines: { name: 'Name: Severus', appearance: 'Appearance: ' + value } },
  ], { lang: 'en', by: 'profile' });
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.ok(by('Minerva').hidden?.appearance && by('Severus').hidden?.appearance);
  s.recheckFields(w.worldId, {
    story: ['Minerva straightened her emerald robes and peered through square spectacles.', 'Severus wore black, as ever, and stood very tall.'],
    profile: ['Appearance: ' + value], isStatus: () => false, says: () => false,
  });
  assert.ok(!by('Minerva').hidden?.appearance, 'emerald · robes · square · spectacles: four of nine');
  assert.ok(by('Severus').hidden?.appearance, 'black · tall: two words — the profile still holds it');
});

test('4) a scene: the whole world\'s laws come after the rules of this place, within a third', () => {
  const w = { name: 'H', injectMode: 'scene' };
  const ents = [
    { entityId: 'p', type: 'place', name: 'Great Hall', aliases: [], fields: {}, status: 'confirmed' },
    { entityId: 'law', type: 'rule', name: 'Decree for the Restriction of Underage Wizardry', aliases: [], fields: {}, appliesTo: 'world', status: 'confirmed', seen: { n: 9 } },
    { entityId: 'sort', type: 'rule', name: 'Sorting ceremony', aliases: [], fields: {}, appliesTo: 'p', status: 'confirmed', seen: { n: 2 } },
  ];
  const text = I.assembleWorld(w, ents, 3000, { scene: new Set(['p']), relations: [] }).text;
  assert.ok(text.includes('Sorting ceremony'));
  assert.ok(text.includes('Decree') && text.indexOf('Sorting ceremony') < text.indexOf('Decree'), 'the place\'s rule first, the law after it (room within a third)');
  const named = I.assembleWorld(w, ents, 3000, { scene: new Set(['p', 'law']), relations: [] }).text;
  assert.ok(named.includes('Decree'), 'named in the latest messages: in');
});

test('5) a 위치 칸 that is only a group\'s name: into its 본거지, made as 「… grounds」 when it has none', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'London' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: 'Gringotts' },
    { type: 'place', name: 'Gringotts great hall', fields: { location: 'Inside Gringotts, beyond the silver doors' } },
    { type: 'place', name: 'Gringotts inner hall', fields: { location: 'Inside Gringotts' } },
  ]);
  s.linkPlaces(w.worldId);
  const ents = s.listEntities(w.worldId);
  const base = ents.find((e) => e.name === 'Gringotts grounds');
  assert.ok(base && base.type === 'place');
  for (const n of ['Gringotts great hall', 'Gringotts inner hall']) {
    const id = ents.find((e) => e.name === n).entityId;
    assert.deepEqual(s.listRelations(w.worldId).filter((r) => r.type === '위치' && r.from === id).map((r) => r.to), [base.entityId], n);
  }
});
