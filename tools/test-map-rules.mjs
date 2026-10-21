// Unit checks for the random encounter rules (src/player/map-rules.js). Pure functions, seeded randomness.
import assert from 'node:assert/strict';
import { canEncounter, encounterProgress, encounterStepCount, followerStep, groupAgility, isDashing, moveSpeedFor, pickTroop, ratePreemptive, rateSurprise, rollFirstStrike } from '../src/player/map-rules.js';
import { partyAbilities, runBattle } from '../src/player/battle.js';

const fixed = value => () => value;
// Small deterministic generator (mulberry32) so the distribution checks are repeatable.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// encounterStepCount: two rolls below the step length, plus one.
assert.equal(encounterStepCount(30, fixed(0)), 1);
assert.equal(encounterStepCount(30, fixed(0.999999)), 59);
{
  const random = seeded(1);
  let min = Infinity, max = -Infinity, total = 0;
  const rolls = 20000;
  for (let i = 0; i < rolls; i++) {
    const count = encounterStepCount(30, random);
    min = Math.min(min, count); max = Math.max(max, count); total += count;
  }
  assert.equal(min, 1);
  assert.equal(max, 59);
  const mean = total / rolls;
  assert.ok(Math.abs(mean - 30) < 0.5, `mean step count ${mean} should be about 30`);
}

// encounterProgress: bushes double it, half-rate halves it, a ship halves it again.
assert.equal(encounterProgress(), 1);
assert.equal(encounterProgress({ bush: true }), 2);
assert.equal(encounterProgress({ halfRate: true }), 0.5);
assert.equal(encounterProgress({ inShip: true }), 0.5);
assert.equal(encounterProgress({ bush: true, halfRate: true, inShip: true }), 0.5);

// canEncounter: every blocker stops encounters, the defaults allow them.
assert.equal(canEncounter(), true);
assert.equal(canEncounter({ noEncounters: true }), false);
assert.equal(canEncounter({ disabled: true }), false);
assert.equal(canEncounter({ inAirship: true }), false);
assert.equal(canEncounter({ forced: true }), false);

// pickTroop: no entries or zero weights give no battle.
assert.equal(pickTroop([], 0, fixed(0.5)), 0);
assert.equal(pickTroop(undefined, 0, fixed(0.5)), 0);
assert.equal(pickTroop([{ troopId: 4, weight: 0, regionSet: [] }], 0, fixed(0.5)), 0);

// Region filter: an entry with a region set only counts on those regions.
{
  const list = [{ troopId: 1, weight: 1, regionSet: [5] }, { troopId: 2, weight: 1, regionSet: [] }];
  for (let i = 0; i < 50; i++) assert.equal(pickTroop(list, 3, seeded(i)), 2, 'region 3 must not draw troop 1');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickTroop(list, 5, seeded(i)));
  assert.deepEqual([...seen].sort(), [1, 2]);
}

// Weights: with weights 1 and 3 the first troop wins 1/4 of the time.
{
  const list = [{ troopId: 1, weight: 1, regionSet: [] }, { troopId: 2, weight: 3, regionSet: [] }];
  assert.equal(pickTroop(list, 0, fixed(0)), 1);
  assert.equal(pickTroop(list, 0, fixed(0.5)), 2);
  assert.equal(pickTroop(list, 0, fixed(0.99)), 2);
  const random = seeded(7);
  let first = 0;
  const rolls = 20000;
  for (let i = 0; i < rolls; i++) if (pickTroop(list, 0, random) === 1) first++;
  const share = first / rolls;
  assert.ok(Math.abs(share - 0.25) < 0.02, `troop 1 share ${share} should be about 0.25`);
}

// isDashing: the button or a click destination dashes, a blocker or always-dash inversion decides the rest.
assert.equal(isDashing({ allowed: true, shiftHeld: true }), true);
assert.equal(isDashing({ allowed: true, destination: true }), true);
assert.equal(isDashing({ allowed: true }), false);
assert.equal(isDashing({ shiftHeld: true }), false, 'not allowed (vehicle or disabled map) never dashes');
assert.equal(isDashing({ allowed: true, alwaysDash: true }), true, 'always dash runs without Shift');
assert.equal(isDashing({ allowed: true, alwaysDash: true, shiftHeld: true }), false, 'Shift walks when always dash is on');
assert.equal(moveSpeedFor(6, false), 6);
assert.equal(moveSpeedFor(6, true), 12);

// followerStep: one cell toward the target, x before y, null on the target itself.
assert.equal(followerStep({ x: 2, y: 2 }, { x: 2, y: 2 }), null);
assert.deepEqual(followerStep({ x: 2, y: 2 }, { x: 5, y: 2 }), { dx: 1, dy: 0 });
assert.deepEqual(followerStep({ x: 2, y: 2 }, { x: 0, y: 4 }), { dx: -1, dy: 0 });
assert.deepEqual(followerStep({ x: 2, y: 2 }, { x: 2, y: 0 }), { dx: 0, dy: -1 });

// First strike rates and the roll (BattleManager.onEncounter).
assert.equal(groupAgility([]), 1);
assert.equal(groupAgility([2, 4]), 3);
assert.equal(groupAgility([0, 0]), 1);
assert.equal(ratePreemptive(10, 5, false), 0.05);
assert.equal(ratePreemptive(5, 10, false), 0.03);
assert.equal(ratePreemptive(10, 5, true), 0.2, 'raise preemptive quadruples the rate');
assert.equal(rateSurprise(10, 5, false), 0.03);
assert.equal(rateSurprise(5, 10, false), 0.05);
assert.equal(rateSurprise(5, 10, true), 0, 'cancel surprise removes the surprise');
assert.equal(rollFirstStrike({ preemptive: 1, surprise: 1 }, fixed(0)), 'preemptive', 'a preemptive roll wins over a surprise');
assert.equal(rollFirstStrike({ preemptive: 0, surprise: 1 }, fixed(0)), 'surprise');
assert.equal(rollFirstStrike({ preemptive: 0, surprise: 0 }, fixed(0.5)), null);
assert.equal(rollFirstStrike({ preemptive: 0.5, surprise: 1 }, fixed(0.9)), 'surprise');

// A battle with a made-up database: the first strike decides who acts on turn 1.
const database = {
  actors: [null, { id: 1, name: 'Hero', classId: 1, initialLevel: 1, maxLevel: 99, equips: [0, 0, 0, 0, 0], traits: [], skills: [], note: '' }],
  classes: [null, { id: 1, name: 'Warrior', expParams: [30, 20, 30, 30], params: Array.from({ length: 8 }, (_, param) => [0, ...Array.from({ length: 99 }, () => 10 + param * 5)]), learnings: [], traits: [], skills: [] }],
  enemies: [null, { id: 1, name: 'Slime', params: [50, 0, 10, 10, 10, 10, 10, 10], actions: [{ conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId: 1 }], traits: [], exp: 0, gold: 0, dropItems: [] }],
  skills: [null, { id: 1, name: 'Attack', damage: { type: 1, elementId: 0, formula: 'a.atk * 4 - b.def * 2', variance: 0, critical: false }, effects: [], hitType: 1, scope: 1, occasion: 1, mpCost: 0, tpCost: 0, message1: '%1 attacks!', message2: '', successRate: 100, requiredWtypeId1: 0, requiredWtypeId2: 0, stypeId: 1, speed: 0, repeats: 1, traits: [], note: '', animationId: 0, iconIndex: 0, description: '' }],
  items: [], weapons: [], armors: [],
  states: [null, { id: 1, name: 'Dead', restriction: 4, traits: [], priority: 100, minTurns: 1, maxTurns: 1, removeAtBattleEnd: false, autoRemovalTiming: 0, removeByDamage: false, removeByRestriction: false, note: '' }],
  troops: [null, { id: 1, name: 'Slimes', members: [{ enemyId: 1, x: 0, y: 0, hidden: false }], pages: [], span: 0 }],
};
// The enemy is fast in the surprise case (the party is slower, so the troop's surprise is the likelier one).
const fastEnemy = structuredClone(database);
fastEnemy.enemies[1].params[6] = 100;
// Rolls for a battle: the first two draws are the strike's, the rest the battle's own (fixed at 0.5).
const rollsFor = first => { let calls = 0; return () => (calls++ < 2 ? first : 0.5); };
const battleLog = async (options) => {
  const log = [];
  const present = async ({ text, choices }) => {
    log.push({ text: String(text), choice: Boolean(choices) });
    if (!choices) return undefined;
    return (choices.find(choice => choice.text === 'Escape') || choices.find(choice => typeof choice.value === 'number'))?.value;
  };
  const result = await runBattle({ database: options.database, troopId: 1, party: [1], records: {}, present, rng: rollsFor(options.first), canEscape: true, canLose: false, encounter: options.encounter });
  return { outcome: result.outcome, log };
};

{
  // Surprise: the troop acts first and the party gets no command on turn 1.
  const { log } = await battleLog({ database: fastEnemy, first: 0.04, encounter: true });
  const surprised = log.findIndex(entry => /was surprised/.test(entry.text));
  const firstChoice = log.findIndex(entry => entry.choice);
  const enemyAct = log.findIndex(entry => /Slime attacks/.test(entry.text));
  assert.ok(surprised >= 0, 'the surprise line shows');
  assert.ok(enemyAct > surprised && (firstChoice < 0 || firstChoice > enemyAct), 'the troop attacks before the party is asked for a command');
}
{
  // Preemptive: the party acts first, and the escape it chooses on turn 1 succeeds at once.
  const { outcome, log } = await battleLog({ database, first: 0.01, encounter: true });
  assert.ok(log.some(entry => /got the upper hand/.test(entry.text)), 'the upper-hand line shows');
  assert.equal(outcome, 'escape', 'a preemptive escape always works');
  assert.ok(!log.some(entry => /Slime attacks/.test(entry.text)), 'the troop does not act on turn 1');
}
{
  // Without an encounter there is no first strike: the party is asked for its command first, as before.
  const { log } = await battleLog({ database, first: 0.01, encounter: false });
  assert.ok(!log.some(entry => /upper hand|was surprised/.test(entry.text)), 'no strike line for a battle that is not an encounter');
  assert.ok(log.find(entry => entry.choice), 'the party gets its command');
}
{
  // Encounter abilities come from the actors' own traits, and reading them never writes an actor record.
  const withTrait = structuredClone(database);
  withTrait.actors[1].traits = [{ code: 64, dataId: 1, value: 0 }, { code: 64, dataId: 2, value: 0 }];
  const records = { 1: { level: 3 } };
  const before = JSON.stringify(records);
  const abilities = partyAbilities(withTrait, records, [1]);
  assert.deepEqual([...abilities].sort(), [1, 2]);
  assert.equal(JSON.stringify(records), before, 'no record is created or changed');
  assert.equal(partyAbilities(database, {}, [1]).size, 0, 'a party without the traits has no abilities');
}

console.log('map rules ok (step counts, progress, blockers, troop pick, regions, weights, dash, followers, first strike)');
