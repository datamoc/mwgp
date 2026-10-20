// Unit checks for the random encounter rules (src/player/map-rules.js). Pure functions, seeded randomness.
import assert from 'node:assert/strict';
import { canEncounter, encounterProgress, encounterStepCount, isDashing, moveSpeedFor, pickTroop } from '../src/player/map-rules.js';

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

console.log('map rules ok (step counts, progress, blockers, troop pick, regions, weights, dash)');
