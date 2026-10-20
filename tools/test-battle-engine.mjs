// A battle hands a skill whose database entry has a note to the game's own engine classes
// (src/player/battle-engine.js): the engine decides its cost and its effect, the runner applies the
// outcome. Synthetic engine and plugin, no real game. Run: node tools/test-battle-engine.mjs
import assert from 'node:assert';
import { createRgssRuntime } from '../src/player/rgss-script.js';
import { runBattle } from '../src/player/battle.js';
import { createBattleEngine } from '../src/player/battle-engine.js';

const engineObjects = `
function Game_Battler() {}
Game_Battler.prototype.result = function () { return this._result || (this._result = { missed: false, evaded: false, critical: false, hpDamage: 0, mpDamage: 0 }); };
Game_Battler.prototype.skillMpCost = function (skill) { return skill.mpCost; };
Game_Battler.prototype.skillTpCost = function (skill) { return skill.tpCost; };
function Game_Actor(id) { this._actorId = id; this._hp = 0; this._mp = 0; this._tp = 0; this._states = []; this._outfit = 3; }
Game_Actor.prototype = Object.create(Game_Battler.prototype);
function Game_Actors() { this._data = []; }
Game_Actors.prototype.actor = function (id) { return this._data[id] || (this._data[id] = new Game_Actor(id)); };
function Game_Enemy(index) { this._index = index; this._hp = 0; this._mp = 0; this._tp = 0; this._states = []; }
Game_Enemy.prototype = Object.create(Game_Battler.prototype);
function Game_Troop() { this._enemies = []; }
Game_Troop.prototype.setup = function (id) { this._enemies = $dataTroops[id].members.map((m, i) => new Game_Enemy(i)); };
Game_Troop.prototype.members = function () { return this._enemies; };
function Game_Party() { this._inBattle = false; }
function Game_Action(subject) { this._subject = subject; }
Game_Action.prototype.setSkill = function (id) { this._item = $dataSkills[id]; };
Game_Action.prototype.setItem = function (id) { this._item = $dataItems[id]; };
Game_Action.prototype.apply = function (target) { target.result().hpDamage = 0; };
Game_Action.prototype.itemCnt = function () { return 0; };
Game_Action.prototype.itemMrf = function () { return 0; };
`;
// The plugin: a skill's cost and effect are code in the game, driven by its own note.
const plugin = `
Game_Battler.prototype.skillMpCost = function (skill) { return skill.note.includes('PRICEY') ? 5 : skill.mpCost; };
var _apply = Game_Action.prototype.apply;
Game_Action.prototype.itemCnt = function () { return this._item.note.includes('RIPOSTE') ? 1 : 0; };
Game_Action.prototype.itemMrf = function () { return this._item.note.includes('MIRROR') ? 1 : 0; };
Game_Action.prototype.apply = function (target) {
  _apply.call(this, target);
  if (this._item.note.includes('MEND')) { this._subject._outfit = 99; this._subject._mp += 0; }
  if (this._item.note.includes('SMASH')) { target._hp -= 40; target.result().hpDamage = 40; }
};
`;

const database = {
  system: { partyMembers: [1], terms: {} },
  actors: [null, { id: 1, name: 'Hero', classId: 1, initialLevel: 1 }],
  classes: [null, { id: 1, name: 'C', params: [[0, 100, 100], [0, 20, 20], [0, 10, 10], [0, 10, 10], [0, 10, 10], [0, 10, 10], [0, 10, 10], [0, 10, 10]], learnings: [], traits: [] }],
  enemies: [null, { id: 1, name: 'Foe', params: [60, 0, 5, 5, 5, 5, 5, 5], traits: [], actions: [{ skillId: 1, rating: 5, conditionType: 0 }], exp: 0, gold: 0, dropItems: [] }],
  troops: [null, { id: 1, name: 'T', members: [{ enemyId: 1, x: 100, y: 100 }], pages: [] }],
  skills: [null,
    { id: 1, name: 'Attack', scope: 1, stypeId: 0, damage: { type: 1, formula: '1', variance: 0 }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '' },
    { id: 2, name: 'Guard', scope: 11, stypeId: 0, damage: { type: 0, formula: '0' }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '' },
    { id: 3, name: 'Mend', scope: 11, stypeId: 1, damage: { type: 0, formula: '0' }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '<do>MEND PRICEY</do>' },
    { id: 4, name: 'Smash', scope: 1, stypeId: 1, damage: { type: 0, formula: '0' }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '<do>SMASH</do>' },
    { id: 5, name: 'Plain', scope: 1, stypeId: 1, damage: { type: 1, formula: '7', variance: 0 }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '' },
    { id: 6, name: 'Riposted', scope: 1, stypeId: 1, damage: { type: 0, formula: '0' }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '<do>RIPOSTE</do>' },
    { id: 7, name: 'Mirrored', scope: 1, stypeId: 1, damage: { type: 0, formula: '0' }, effects: [], hitType: 0, successRate: 100, repeats: 1, mpCost: 0, tpCost: 0, note: '<do>MIRROR</do>' }],
  items: [null], weapons: [null], armors: [null], states: [null, { id: 1, name: 'Death', restriction: 4, traits: [] }], animations: [null], commonevents: [null]
};
database.system.attackSkillId = 1;

function setup() {
  const project = { database, pluginLibrary: { order: ['Extra'], parameters: {}, engine: ['Game_Action', 'Game_Actor'],
    engineSources: { rpg_objects: engineObjects }, sources: { Extra: plugin } } };
  const rpgExtra = { items: {}, party: [1], gold: 0 };
  const rt = createRgssRuntime({ rpgExtra, mover: { x: 1, y: 1 }, facing: 'down', project, presentDialogue() {}, playSound() {} },
    { mapId: 1, mapEvents: [], dialect: 'mv', pluginLibrary: project.pluginLibrary });
  const game = { switch: () => false, setSwitch() {}, variable: () => 0, setVariable() {} };
  const ev = js => rt.evaluateValue({ source: js, mv: true, js: `return (${js});` }, { game }, { id: 0 });
  return { engine: createBattleEngine(rt, game), ev };
}

async function fight(engine, picks) {
  const records = { 1: { level: 1, classId: 1, hp: 100, mp: 20, skills: [3, 4, 5, 6, 7] } };
  // Menu policy: walk Fight > Skill > the wanted skill, then Escape.
  const messages = [];
  const choose = async ({ text, choices }) => {
    if (!choices) { messages.push(String(text)); return undefined; }
    const labels = choices.map(choice => String(choice.text ?? choice.label ?? ''));
    const pick = re => labels.findIndex(label => re.test(label));
    let index = -1;
    if (picks.length) {
      index = pick(new RegExp(`^${picks[0]}`));
      if (index >= 0) { picks.shift(); return choices[index].value; }
      index = pick(/^Skill/); if (index >= 0) return choices[index].value;
      index = pick(/^Fight/); if (index >= 0) return choices[index].value;
    }
    index = pick(/^Escape/); return choices[index >= 0 ? index : 0].value;
  };
  const costs = [], used = [];
  const result = await runBattle({ database, troopId: 1, party: [1], records, items: {}, present: choose, rng: () => 0.5, canEscape: true,
    hooks: { onSetup: () => engine.begin({ troopId: 1 }), skillCost: use => { const cost = engine.skillCost(use); costs.push([use.skill.name, cost]); return cost; },
      applyAction: use => engine.applyAction(use), counterRates: use => engine.counterRates(use), onUse: use => used.push(use.item.name), onEnd: () => engine.end() } });
  return { result, records, costs, used, messages };
}

{
  const { engine, ev } = setup();
  assert.equal(engine.available, true, 'the sandbox must report the game engine as available');

  // 1. A noted skill: the engine's cost (5, from the plugin) is charged, and its effect runs on the engine's actor.
  const mend = await fight(engine, ['Mend']);
  assert.ok(mend.used.includes('Mend'), JSON.stringify(mend.used));
  assert.deepEqual(mend.costs.find(([name]) => name === 'Mend')[1], { mp: 5, tp: 0 }, 'the cost comes from the game\'s own code');
  assert.equal(ev('$gameActors.actor(1)._outfit'), 99, 'the skill\'s game-code effect must have run');
  assert.equal(mend.records[1].mp, 15, 'the engine cost, not the database cost, is paid');

  // 2. A noted attack skill: the engine decides the damage, the runner's enemy loses it.
  const smash = await fight(setup().engine, ['Smash']);
  assert.ok(smash.used.includes('Smash'));
  assert.ok(smash.costs.some(([name]) => name === 'Smash'));

  // 3. A skill with no note stays on the runner's own rules (the engine is not asked).
  const plain = await fight(setup().engine, ['Plain']);
  assert.ok(plain.used.includes('Plain'));
  assert.deepEqual(plain.costs.find(([name]) => name === 'Plain')[1], null, 'a skill with no note is not the engine\'s to price');
}

// 3b. The engine's own odds decide counters and reflections (itemCnt / itemMrf).
{
  const riposted = await fight(setup().engine, ['Riposted']);
  assert.ok(riposted.messages.some(line => /counterattack/i.test(line)), 'the engine counter rate must produce a counter attack: ' + riposted.messages.join(' | '));
  const mirrored = await fight(setup().engine, ['Mirrored']);
  assert.ok(mirrored.messages.some(line => /reflect|mirror|bounce/i.test(line)), 'the engine reflection rate must produce a reflection: ' + mirrored.messages.join(' | '));
  const plain = await fight(setup().engine, ['Plain']);
  assert.ok(!plain.messages.some(line => /counterattack|reflect/i.test(line)), 'an unnoted skill keeps the odds of the runner');
}

// 4. Without a plugin engine the bridge reports itself unavailable and the runner is untouched.
{
  const project = { database };
  const rt = createRgssRuntime({ rpgExtra: { items: {}, party: [1], gold: 0 }, mover: { x: 1, y: 1 }, facing: 'down', project, presentDialogue() {}, playSound() {} }, { mapId: 1, mapEvents: [], dialect: 'mv' });
  const engine = createBattleEngine(rt, { switch: () => false, setSwitch() {}, variable: () => 0, setVariable() {} });
  assert.equal(engine.available, false);
  assert.equal(engine.begin({ troopId: 1 }), false);
  assert.equal(engine.skillCost({ subject: { isActor: true }, skill: database.skills[3] }), null);
}

console.log('battle-engine test ok: engine cost, engine effect, engine counter and reflection odds, unnoted skills on the runner, no engine = no change');
