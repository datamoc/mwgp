// Unit checks for the game's own map rules (src/player/map-engine.js) and the plugin detection that feeds them
// (mapHookNames in tools/mv-plugins.mjs). The sandbox is a fake: only the contract is checked here.
import assert from 'node:assert/strict';
import { createMapEngine } from '../src/player/map-engine.js';
import { mapHookNames } from './mv-plugins.mjs';

const state = { x: 3, y: 4, vehicle: 'walk', disabled: false };
const fakeRgss = result => {
  const calls = [];
  return { calls, evaluateValue: (script, context, frame) => { calls.push({ script, context, frame }); return typeof result === 'function' ? result(script) : result; } };
};

// Without an override the engine is never asked: the stock rule decides (null), and the sandbox is not touched.
{
  const rgss = fakeRgss({ value: true });
  const engine = createMapEngine(rgss, {}, { mapHooks: [] });
  assert.equal(engine.overrides('canEncounter'), false);
  assert.equal(engine.canEncounter(state), null);
  assert.equal(engine.encounterProgressValue(state), null);
  assert.equal(rgss.calls.length, 0);
}

// With an override, the engine's value is used, and the scene's state reaches the sandbox as JSON arguments.
{
  const rgss = fakeRgss({ value: false });
  const engine = createMapEngine(rgss, {}, { mapHooks: ['canEncounter'] });
  assert.equal(engine.canEncounter({ ...state, disabled: true }), false);
  assert.equal(rgss.calls.length, 1);
  const js = rgss.calls[0].script.js;
  assert.ok(js.includes('"disabled":true'), 'the command 136 state is passed to the sandbox');
  assert.ok(js.includes('$gameSystem._encounterEnabled'), 'and written into the sandbox game system');
  assert.ok(js.includes('canEncounter()'), 'the game method itself is called');
}

// A failing or wrongly typed answer warns once and falls back to the stock rule.
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const failing = createMapEngine(fakeRgss({ error: 'Game_System is not defined' }), {}, { mapHooks: ['canEncounter'] });
    assert.equal(failing.canEncounter(state), null);
    assert.equal(failing.canEncounter(state), null);
    const wrongType = createMapEngine(fakeRgss({ value: 'yes' }), {}, { mapHooks: ['canEncounter'] });
    assert.equal(wrongType.canEncounter(state), null);
    const notFinite = createMapEngine(fakeRgss({ value: NaN }), {}, { mapHooks: ['encounterProgressValue'] });
    assert.equal(notFinite.encounterProgressValue(state), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.filter(text => text.includes('canEncounter')).length, 2, 'one warning per engine and rule (two engines here), not one per step');
  assert.equal(warnings.length, 3, 'canEncounter, the wrong type, and the number');
}

// Only the overridable rules are honoured from mapHooks.
{
  const engine = createMapEngine(fakeRgss({ value: 1 }), {}, { mapHooks: ['makeEncounterCount', 'encounterProgressValue'] });
  assert.equal(engine.overrides('makeEncounterCount'), false);
  assert.equal(engine.overrides('encounterProgressValue'), true);
}

// Detection: a plugin that assigns one of the methods through any alias of the class is found.
assert.deepEqual(mapHookNames('var _GP = Game_Player; _GP.prototype.canEncounter = function() { return true; };'), ['canEncounter']);
assert.deepEqual(mapHookNames('Game_Player.prototype.encounterProgressValue = function() { return 1; };'), ['encounterProgressValue']);
assert.deepEqual(mapHookNames('if (Game_Player.prototype.canEncounter === undefined) {}'), [], 'a read is not an override');
assert.deepEqual(mapHookNames('Game_Party.prototype.hasEncounterNone = function() { return true; };'), [], 'other classes are not map hooks');

console.log('map engine ok (stock fallback, override, warn-once fallback, alias detection)');
