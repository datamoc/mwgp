// The game's own list builders run over the player's item and skill lists (rgss-script.js `listHook`), and the converter
// ships the plugins that wrap them (tools/mv-plugins.mjs). Synthetic game, no real plugin. Run: node tools/test-list-hook.mjs
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginLibrary } from './mv-plugins.mjs';
import { createRgssRuntime } from '../src/player/rgss-script.js';

const sorter = `
(function () {
  var _make = Window_ItemList.prototype.makeItemList;
  Window_ItemList.prototype.makeItemList = function () {
    _make.call(this);
    this._data.sort(function (a, b) { return Number(a.meta.order) - Number(b.meta.order); });
  };
  var _skills = Window_SkillList.prototype.makeItemList;
  Window_SkillList.prototype.makeItemList = function () {
    _skills.call(this);
    this._data = this._data.filter(function (skill) { return !skill.meta.hidden; });
  };
})();`;
const unrelated = 'var Unrelated = 1;';

// 1. The converter ships a plugin that wraps the list builders even though no event script mentions it.
{
  const root = mkdtempSync(join(tmpdir(), 'mwgp-listhook-'));
  mkdirSync(join(root, 'js', 'plugins'), { recursive: true });
  writeFileSync(join(root, 'js', 'plugins', 'Sorter.js'), sorter);
  writeFileSync(join(root, 'js', 'plugins', 'Unrelated.js'), unrelated);
  const text = 'var $plugins = [{"name":"Sorter","status":true,"parameters":{}},{"name":"Unrelated","status":true,"parameters":{}}];';
  const library = await buildPluginLibrary(root, text, []);
  assert.ok(library?.order.includes('Sorter'), `a plugin wrapping the list builders must ship: ${JSON.stringify(library?.order)}`);
  assert.ok(!library.order.includes('Unrelated'), 'a plugin nothing reaches stays out');
}

// 2. The runtime runs the game's hooks over a list: sorted by the game's own rule, and entries it hides left out.
{
  const rpgExtra = { items: {}, party: [], gold: 0 };
  const pluginLibrary = { order: ['Sorter'], parameters: {}, engine: [], sources: { Sorter: sorter } };
  const rt = createRgssRuntime({ rpgExtra, mover: { x: 1, y: 1 }, facing: 'down', project: { database: {} }, presentDialogue() {}, playSound() {} },
    { mapId: 1, mapEvents: [], dialect: 'mv', pluginLibrary });
  const entry = (id, meta) => ({ id, name: `E${id}`, meta });
  const items = [entry(1, { order: 30 }), entry(2, { order: 10 }), entry(3, { order: 20 })];
  const sorted = rt.listHook('Window_ItemList', items);
  assert.deepEqual(sorted.map(item => item.id), [2, 3, 1], 'the list must come back in the order the game sorts it');
  const skills = [entry(7, {}), entry(8, { hidden: true }), entry(9, {})];
  assert.deepEqual(rt.listHook('Window_SkillList', skills).map(skill => skill.id), [7, 9], 'an entry the game hides must be left out');
  assert.equal(rt.listHook('Window_ItemList', []), null, 'an empty list says nothing');
  assert.deepEqual(items.map(item => item.id), [1, 2, 3], 'the caller\'s own list is not modified');
}

// 3. No plugin engine (or no hook): nothing to say, the player keeps its order.
{
  const rt = createRgssRuntime({ rpgExtra: { items: {}, party: [], gold: 0 }, mover: { x: 1, y: 1 }, facing: 'down', project: { database: {} }, presentDialogue() {}, playSound() {} },
    { mapId: 1, mapEvents: [], dialect: 'rgss' });
  assert.equal(rt.listHook('Window_ItemList', [{ id: 1 }]), null);
}

console.log('list-hook test ok: the converter ships list-builder plugins, the game sorts and filters the player lists, no engine = no change');
