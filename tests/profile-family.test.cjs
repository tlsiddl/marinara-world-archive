'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const { parseProfiles } = require('../world-archive/lib/profile.cjs');

const makeStore = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-profile-family-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
};

test('two people with the same surname do not prevent a new fully named relative', (t) => {
  const s = makeStore(t), world = s.createWorld({ name: '[시험] 세계' });
  const a = s.createEntity(world.worldId, { type: 'person', name: 'Fel Ashford', fields: { appearance: 'a purple hat' } });
  s.createEntity(world.worldId, { type: 'person', name: 'Ashford' });
  const input = '<npc_profile>\n- Name: Madam Beatrice Ashford / Age: 71 / Gender: Female\n- Appearance and clothing (hair colour and eye colour first): short white hair, black eyes.\n- Demeanor and key personality traits: Direct.\n- Other noteworthy details: A retired healer.\n</npc_profile>';
  const profiles = parseProfiles(input);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].fields.appearance, 'short white hair, black eyes.');
  const changes = s.applyProfiles(world.worldId, profiles, { lang: 'en', story: [] });
  assert.equal(changes.filter((c) => c.action === 'create').length, 1);
  const people = s.readEntities(world.worldId).entities;
  const created = people.find((p) => p.name === 'Madam Beatrice Ashford');
  assert.ok(created);
  assert.equal(created.fields.appearance, 'short white hair, black eyes');
  assert.equal(people.find((p) => p.entityId === a.entityId).fields.appearance, 'a purple hat');
  assert.equal(s.applyProfiles(world.worldId, profiles, { lang: 'en', story: [] }).filter((c) => c.action === 'create').length, 0);
});

test('ambiguous short names are still not guessed', (t) => {
  const s = makeStore(t), w = s.createWorld({ name: '[시험] 세계' });
  s.createEntity(w.worldId, { type: 'person', name: 'Fel Ashford' });
  s.createEntity(w.worldId, { type: 'person', name: 'Mira Ashford' });
  const changes = s.applyProfiles(w.worldId, parseProfiles('<npc_profile>\n- Name: Ashford\n</npc_profile>'), { lang: 'en' });
  assert.equal(changes.filter((c) => c.action === 'create').length, 0);
  assert.equal(s.readEntities(w.worldId).entities.length, 2);
});

test('a full name is not invented when its given name already has an ambiguous match', (t) => {
  const s = makeStore(t), w = s.createWorld({ name: '[시험] 세계' });
  s.createEntity(w.worldId, { type: 'person', name: 'Beatrice' });
  s.createEntity(w.worldId, { type: 'person', name: 'Ashford' });
  const changes = s.applyProfiles(w.worldId, parseProfiles('<npc_profile>\n- Name: Beatrice Ashford\n</npc_profile>'), { lang: 'en' });
  assert.equal(changes.filter((c) => c.action === 'create').length, 0);
  assert.equal(s.readEntities(w.worldId).entities.length, 2);
});

test('profile labels accept annotations and Korean variants', () => {
  const [p] = parseProfiles('<npc_profile>\n- 이름: [시험] 보라 / 나이: 71 / 성별: 여성\n- 외모 및 복장 (머리색과 눈동자 색 우선): 흰 머리.\n- 태도 및 주요 성격 특성: 침착함.\n- 기타 특이 사항: 은퇴한 치료사.\n</npc_profile>');
  assert.equal(p.fields.appearance, '흰 머리.');
  assert.equal(p.fields.personality, '침착함.');
  assert.equal(p.fields.background, '은퇴한 치료사.');
});
