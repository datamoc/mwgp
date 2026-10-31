// Player functions the original RPG Maker engine gives every game, exercised
// without RPG Maker: shop Buy/Sell, in-game number/name entry (no browser
// prompt), the on-screen timer format, Always Dash options, and the RGSS
// overlay's Window / tone / blend handling. Run: node tools/test-player-functions.mjs
import assert from 'node:assert/strict';
import { runShop, sellPrice } from '../src/player/shop.js';
import { runNumberInput, runNameInput, NAME_LETTERS } from '../src/player/entry.js';
import { formatTimer, prepareEventCommands, routeSegments } from '../src/player/player-core.js';
import { createPicker } from '../src/player/battle.js';
import { toneFilter, blendOperation } from '../src/player/rgss-screen.js';
import { decodeEngineSave, convertEngineSave, lzDecompressFromBase64 } from '../src/player/save-import.js';
import { deflateSync, inflateSync } from 'node:zlib';
import { convertAceDatabaseTables, convertVxDatabaseTables } from '../tools/rgss-database.mjs';
import { createRgssRuntime, isGameSceneInstance } from '../src/player/rgss-script.js';

let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deep = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// A present() seam that answers from a script of choice values (indexes into
// the paged picker are resolved by createPicker, so queue entry labels' values
// by feeding raw `chosen` results: numbers pick the visible row, 'back' exits).
function scriptedPresent(answers) {
  const asked = [];
  const present = async ({ text, choices }) => { asked.push({ text, choices }); return answers.shift(); };
  return { present, asked };
}

const database = {
  system: { currencyUnit: 'G', terms: { basic: ['Level', 'Lv', 'HP', 'HP', 'MP', 'MP', 'TP', 'TP'], messages: {}, commands: [] } },
  items: { 1: { id: 1, name: 'Potion', price: 50 }, 2: { id: 2, name: 'Ether', price: 120 } },
  weapons: { 1: { id: 1, name: 'Sword', price: 200 } },
  armors: { 1: { id: 1, name: 'Shield', price: 80 } },
};

// ---- shop: buy two potions (quantity), then sell one back at half price ----
{
  eq(sellPrice({ price: 50 }), 25, 'sell price is half, rounded down by the caller');
  eq(sellPrice({ price: 51 }), 25, 'sell price floors');
  const items = {}, weapons = {}, armors = {};
  const state = { gold: 300 };
  // Buy menu -> Potion -> quantity 2 -> Leave. createPicker shows 5 rows/page:
  // Buy/Sell/Leave are values 0/1/2; then goods rows; then quantity rows.
  const { present } = scriptedPresent([
    0,          // Buy
    0,          // Potion (first good)
    1,          // quantity row "2"
    'back',     // leave goods list
    2,          // Leave... main rows are Buy(0) Sell(1) Leave(2): after buying we are back at goods; 'back' handled above
  ]);
  // The flow above needs the exact sequence runShop asks; drive it loosely:
  // if the script runs out, present returns undefined which acts as Cancel.
  await runShop({ database, state, items, weapons, armors, goods: [{ kind: 0, id: 1, priceType: 0, price: 0 }, { kind: 1, id: 1, priceType: 0, price: 0 }], present });
  eq(state.gold, 200, 'buying 2 potions at 50 costs 100');
  eq(items[1], 2, 'two potions in inventory');

  const sellRun = scriptedPresent([
    1,          // Sell
    0,          // Potion (first owned)
    0,          // quantity row "1"
    'back',     // leave sell list
    'back',     // leave shop
  ]);
  await runShop({ database, state, items, weapons, armors, goods: [{ kind: 0, id: 1, priceType: 0, price: 0 }], present: sellRun.present });
  eq(state.gold, 225, 'selling 1 potion pays half price (25)');
  eq(items[1], 1, 'one potion left after selling');
}

// ---- shop: cannot buy what gold cannot pay for ------------------------------
{
  const items = {}, weapons = {}, armors = {};
  const state = { gold: 10 };
  const { present } = scriptedPresent([0, 'back', 'back']);
  await runShop({ database, state, items, weapons, armors, goods: [{ kind: 0, id: 1, priceType: 0, price: 0 }], present });
  eq(state.gold, 10, 'unaffordable goods leave gold untouched');
  eq(items[1] || 0, 0, 'unaffordable goods are not granted');
}

// ---- number entry: digit by digit, no prompt --------------------------------
{
  const { present } = scriptedPresent([1, 2, 3]); // digits 1,2,3
  eq(await runNumberInput({ present, digits: 3, current: 0 }), 123, 'number entry composes digits');
}
{
  const { present } = scriptedPresent([9, 'back', 4, 2]); // fix first digit, then finish
  eq(await runNumberInput({ present, digits: 2, current: 0 }), 42, 'number entry can go back a digit');
}
{
  const { present } = scriptedPresent([]); // cancel at once keeps the current value
  eq(await runNumberInput({ present, digits: 2, current: 7 }), 7, 'cancelling number entry keeps current value');
}

// ---- name entry: pick letters, delete, done ---------------------------------
{
  assert.ok(NAME_LETTERS.includes('A') && NAME_LETTERS.includes('z') && NAME_LETTERS.includes('0'), 'name entry offers letters and digits'); checks++;
  // Main loop rows: Add(0) Delete(1) Done(2); letter picker rows are paged letters.
  const { present } = scriptedPresent([
    0, 0,       // Add -> 'A'
    0, 1,       // Add -> 'B'
    1,          // Delete (removes B)
    0, 2,       // Add -> 'C'
    2,          // Done
  ]);
  eq(await runNameInput({ present, maxLength: 12, current: '' }), 'AC', 'name entry adds/deletes letters and finishes');
}
{
  const { present } = scriptedPresent(['back']);
  eq(await runNameInput({ present, maxLength: 12, current: 'Hero' }), 'Hero', 'cancelling name entry keeps current name');
}
{
  const { present } = scriptedPresent([0, 0, 0, 0, 0, 0, 2]);
  eq((await runNameInput({ present, maxLength: 3, current: '' })).length, 3, 'name entry respects maxLength');
}

// ---- on-screen timer format (Sprite_Timer: minutes:seconds) -----------------
eq(formatTimer(0), '0:00', 'timer zero');
eq(formatTimer(65), '1:05', 'timer pads seconds');
eq(formatTimer(600), '10:00', 'timer minutes unpadded');
eq(formatTimer(59.2), '0:59', 'timer floors fractional seconds');
eq(formatTimer(-5), '0:00', 'timer clamps negative');

// ---- RGSS overlay helpers ------------------------------------------------------
eq(blendOperation(0), 'source-over', 'blend 0 is normal');
eq(blendOperation(1), 'lighter', 'blend 1 is addition');
eq(blendOperation(2), 'difference', 'blend 2 approximates subtraction');
eq(toneFilter(null), '', 'no tone, no filter');
eq(toneFilter({ _red: 0, _green: 0, _blue: 0, _gray: 0 }), '', 'zero tone, no filter');
assert.match(toneFilter({ _red: 0, _green: 0, _blue: 0, _gray: 255 }), /saturate\(0(\.0+)?\)/, 'full gray desaturates'); checks++;
assert.match(toneFilter({ _red: 255, _green: 0, _blue: 0, _gray: 0 }), /brightness/, 'tone shifts brightness'); checks++;

// ---- engine save import (MV .rpgsave / MZ .rmmzsave -> MWGP slot state) -----
{
  // Ground-truth vector from MV's own lz-string.js (the codec StorageManager writes).
  const sample = '{"system":{"_saveCount":3},"switches":{"_data":[null,true,false]},"party":{"_gold":250,"_actors":[1]}}';
  const vector = 'N4IgzgnmAuCmC2IBcoD6YCGA3WBhA9gK4B20yAzAL4A04A7gJbQDGAFrGMmgCYbQbIA2sUIAbUdWgAnQrGoAzDKLCwAujRAAHDFOgQuIVAHN8o7sgBMAVgAMtVBmbR8UzkkEBGdZSA==';
  eq(lzDecompressFromBase64(vector), sample, 'LZString-base64 save decodes (real MV codec vector)');

  const engineSave = {
    system: { _saveCount: 2 }, switches: { _data: [null, true, false, true] }, variables: { _data: [null, null, null, 6] },
    selfSwitches: { _data: { '1,1,A': true } },
    actors: { _data: [null, { _actorId: 3, _name: 'Ember', _level: 5, _classId: 4, _hp: 90, _mp: 20, _exp: { 4: 500 }, _skills: [85, 107], _states: [], _equips: [{ _dataClass: 'weapon', _itemId: 59 }, { _dataClass: '', _itemId: 0 }] }] },
    party: { _gold: 53, _steps: 14, _actors: [3], _items: { 33: 3 }, _weapons: {}, _armors: { 2: 1 } },
    map: { _mapId: 2 }, player: { _x: 13, _y: 14, _direction: 4 },
  };
  const inflate = async bytes => inflateSync(bytes);
  // MZ local-file form: deflated bytes written as a binary string, UTF-8 on disk.
  const mzBytes = new TextEncoder().encode(String.fromCharCode(...deflateSync(JSON.stringify(engineSave))));
  const decoded = await decodeEngineSave(mzBytes, { inflate });
  const state = convertEngineSave(decoded);
  eq(state.mapId, 2, 'imported save map');
  eq(state.x, 13, 'imported save x'); eq(state.y, 14, 'imported save y');
  eq(state.facing, 'left', 'imported save facing from direction 4');
  deep(state.rpg.switches, [['1', true], ['2', false], ['3', true], ['self:1:1:A', true]], 'imported switches incl. self switch');
  deep(state.rpg.variables, [['3', 6]], 'imported variables');
  eq(state.extra.gold, 53, 'imported gold'); deep(state.extra.party, [3], 'imported party');
  deep(state.extra.items, { 33: 3 }, 'imported items');
  eq(state.extra.actors[3].name, 'Ember', 'imported actor name');
  eq(state.extra.actors[3].equips[1].id, 59, 'imported actor weapon');
  eq(state.extra.saveCount, 2, 'imported save count');
  // MV form: the LZ text itself decodes and converts.
  const mvDecoded = await decodeEngineSave(vector, { inflate });
  eq(mvDecoded.party._gold, 250, 'MV LZ save decodes through decodeEngineSave');
}

// ---- VX Ace database mapping (RGSS3 tables -> the MV-shaped database) -------
{
  const rec = (klass, ivars) => ({ class: klass, ivars });
  // RPG::Table raw form the decoder hands over: header + int16 cells, x=8 params.
  const table = (x, y, cells) => {
    const bytes = Buffer.alloc(20 + cells.length * 2);
    bytes.writeInt32LE(x, 4); bytes.writeInt32LE(y, 8); bytes.writeInt32LE(1, 12); bytes.writeInt32LE(cells.length, 16);
    cells.forEach((v, i) => bytes.writeInt16LE(v, 20 + i * 2));
    return { raw: [...bytes] };
  };
  const paramsCells = []; for (let level = 0; level < 3; level++) for (let param = 0; param < 8; param++) paramsCells.push(100 + param * 10 + level);
  const tables = {
    Actors: [null, rec('RPG::Actor', { '@id': 1, '@name': 'Eric', '@class_id': 1, '@initial_level': 1, '@equips': [1], '@character_name': 'Actor1' })],
    Classes: [null, rec('RPG::Class', { '@id': 1, '@name': 'Fighter', '@exp_curve': [30, 20, 30, 30], '@params': table(8, 3, paramsCells), '@learnings': [rec('RPG::Class::Learning', { '@level': 2, '@skill_id': 2 })], '@features': [rec('RPG::BaseItem::Feature', { '@code': 51, '@data_id': 1, '@value': 0 })] })],
    Skills: [null,
      rec('RPG::Skill', { '@id': 1, '@name': 'Attack', '@scope': 1, '@occasion': 1, '@damage': rec('RPG::UsableItem::Damage', { '@type': 1, '@element_id': 0, '@formula': 'a.atk * 4 - b.def * 2', '@variance': 20, '@critical': true }) }),
      rec('RPG::Skill', { '@id': 2, '@name': 'Guard', '@scope': 11, '@occasion': 1 })],
    Items: [null, rec('RPG::Item', { '@id': 1, '@name': 'Potion', '@price': 50, '@scope': 7, '@occasion': 0, '@effects': [rec('RPG::UsableItem::Effect', { '@code': 11, '@data_id': 0, '@value1': 0.5, '@value2': 100 })] })],
    Weapons: [null, rec('RPG::Weapon', { '@id': 1, '@name': 'Sword', '@price': 200, '@params': [0, 0, 10, 0, 0, 0, 0, 0], '@wtype_id': 1 })],
    Armors: [null],
    Enemies: [null, rec('RPG::Enemy', { '@id': 1, '@name': 'Slime', '@params': [50, 10, 5, 3, 2, 2, 4, 4], '@exp': 10, '@gold': 7, '@actions': [rec('RPG::Enemy::Action', { '@skill_id': 1, '@rating': 5 })], '@drop_items': [rec('RPG::Enemy::DropItem', { '@kind': 1, '@data_id': 1, '@denominator': 2 })] })],
    Troops: [null, rec('RPG::Troop', { '@id': 1, '@name': 'Slimes', '@members': [rec('RPG::Troop::Member', { '@enemy_id': 1, '@x': 100, '@y': 80 })], '@pages': [] })],
    States: [null, rec('RPG::State', { '@id': 1, '@name': 'Death', '@restriction': 4 })],
  };
  const system = rec('RPG::System', { '@party_members': [1], '@currency_unit': 'G', '@terms': rec('RPG::System::Terms', { '@basic': ['Level', 'Lv', 'HP', 'HP', 'MP', 'MP', 'TP', 'TP'], '@commands': [], '@params': [], '@messages': { $map: [['guard', '%1 guards.']] } }) });
  const db = convertAceDatabaseTables(tables, { system, convertTroopCommands: () => [] });
  assert.ok(db, 'Ace database converts'); checks++;
  eq(db.actors[1].name, 'Eric', 'Ace actor name');
  eq(db.classes[1].params[0][2], 102, 'Ace class param table [mhp][level 2]');
  eq(db.classes[1].learnings[0].skillId, 2, 'Ace class learning');
  eq(db.skills[1].damage.formula, 'a.atk * 4 - b.def * 2', 'Ace skill formula kept');
  eq(db.system.battleIds.attackSkill, 1, 'Ace attack skill keeps id 1');
  eq(db.enemies[1].params[0], 50, 'Ace enemy mhp');
  eq(db.enemies[1].dropItems[0].denominator, 2, 'Ace drop denominator');
  eq(db.troops[1].members[0].enemyId, 1, 'Ace troop member');
  eq(db.weapons[1].params[2], 10, 'Ace weapon atk');
  eq(db.system.terms.messages.guard, '%1 guards.', 'Ace terms messages from Marshal hash');
  deep(db.system.partyMembers, [1], 'Ace party members');
}

// ---- VX database mapping (.rvdata tables -> the MV-shaped database) ---------
{
  const rec = (klass, ivars) => ({ class: klass, ivars });
  const table = (x, y, cells) => {
    const bytes = Buffer.alloc(20 + cells.length * 2);
    bytes.writeInt32LE(x, 4); bytes.writeInt32LE(y, 8); bytes.writeInt32LE(1, 12); bytes.writeInt32LE(cells.length, 16);
    cells.forEach((v, i) => bytes.writeInt16LE(v, 20 + i * 2));
    return { raw: [...bytes] };
  };
  // VX actor parameters: columns maxhp, maxmp, atk, def, spi, agi per level.
  const cells = []; for (let level = 0; level < 3; level++) for (let col = 0; col < 6; col++) cells.push(50 + col * 10 + level);
  const tables = {
    Actors: [null, rec('RPG::Actor', { '@id': 1, '@name': 'Ralph', '@class_id': 1, '@initial_level': 1, '@parameters': table(6, 3, cells), '@weapon_id': 1, '@exp_basis': 30, '@exp_inflation': 30 })],
    Classes: [null, rec('RPG::Class', { '@id': 1, '@name': 'Paladin', '@weapon_set': [1], '@learnings': { $map: [[2, [2]]] } })],
    Skills: [null, rec('RPG::Skill', { '@id': 1, '@name': 'Heal', '@base_damage': -50, '@spi_f': 100, '@scope': 7, '@occasion': 0 })],
    Items: [null, rec('RPG::Item', { '@id': 1, '@name': 'Potion', '@price': 50, '@hp_recovery': 100, '@scope': 7 })],
    Weapons: [null, rec('RPG::Weapon', { '@id': 1, '@name': 'Sword', '@atk': 10, '@price': 100 })],
    Armors: [null, rec('RPG::Armor', { '@id': 1, '@name': 'Shield', '@kind': 0, '@def': 5 })],
    Enemies: [null, rec('RPG::Enemy', { '@id': 1, '@name': 'Bat', '@maxhp': 40, '@atk': 6, '@spi': 3, '@exp': 5, '@gold': 3, '@actions': [rec('RPG::Enemy::Action', { '@kind': 0, '@basic': 0, '@rating': 5 })] })],
    Troops: [null, rec('RPG::Troop', { '@id': 1, '@name': 'Bats', '@members': [rec('RPG::Troop::Member', { '@enemy_id': 1, '@x': 200, '@y': 100 })], '@pages': [] })],
    States: [null, rec('RPG::State', { '@id': 1, '@name': 'Death', '@restriction': 4 })],
  };
  const system = rec('RPG::System', { '@party_members': [1], '@terms': rec('RPG::System::Terms', { '@basic': [], '@commands': [], '@params': [], '@messages': { $map: [] } }) });
  const db = convertVxDatabaseTables(tables, { system, convertTroopCommands: () => [] });
  assert.ok(db, 'VX database converts'); checks++;
  eq(db.actors[1].params[0][1], 51, 'VX actor mhp at level 1');
  eq(db.actors[1].params[4][1], 91, 'VX actor spi serves as mat');
  eq(db.actors[1].params[5][1], 91, 'VX actor spi serves as mdf');
  eq(db.classes[1].learnings[0].skillId, 2, 'VX class learnings from level hash');
  eq(db.skills[1].damage.type, 3, 'VX negative base damage heals');
  assert.match(db.skills[1].damage.formula, /a\.mat/, 'VX spi factor uses mat'); checks++;
  eq(db.enemies[1].params[0], 40, 'VX enemy maxhp');
  eq(db.weapons[1].params[2], 10, 'VX weapon atk');
  eq(db.system.currencyUnit, 'G', 'VX currency defaults to G');
}

// ---- Command Remember picker start + async script conditions ----------------
{
  const seen = [];
  const present = async ({ choices }) => { seen.push(choices.map(c => c.text)); return 'back'; };
  const pick = createPicker(present, {});
  const entries = Array.from({ length: 7 }, (_, i) => ({ label: `E${i}` }));
  await pick('Pick', entries, { initial: 6 });
  deep(seen[0].slice(0, 2), ['E5', 'E6'], 'picker with initial starts on the remembered page');
}
{
  // An async (frame-waiting) script condition that resolves false must take
  // the else branch: the promise itself is truthy, so only awaiting works.
  let branched = null;
  const scene = {
    evalScriptCondition: async () => false,
    runBranch: async commands => { branched = commands; },
  };
  const prepared = prepareEventCommands([{ if: { script: { source: 'x', async: true } }, then: [{ wait: 1 }], else: [{ wait: 2 }] }], scene);
  await prepared[0].call({});
  eq(branched?.[0]?.wait, 2, 'async script condition awaited (else branch)');
}

// ---- script steps inside a move route (segmented runner) ---------------------
{
  const script = { source: 'this.stepRoute()', mv: true };
  const segments = routeSegments([{ dx: 1, dy: 0 }, { script }, { wait: 1 }, { turn: 'down' }, { script }]);
  eq(segments.length, 4, 'route splits at script steps');
  deep(segments[0].steps, [{ dx: 1, dy: 0 }], 'first segment is movement');
  eq(segments[1].script, script, 'script step stands alone');
  deep(segments[2].steps, [{ wait: 1 }, { turn: 'down' }], 'movement after script regroups');
  eq(segments[3].script, script, 'trailing script step');
  deep(routeSegments([{ dx: 0, dy: 1 }]), [{ steps: [{ dx: 0, dy: 1 }] }], 'script-free route is one segment');
  deep(routeSegments([]), [], 'empty route has no segments');
}

// ---- a game's own scene request ($scene = Scene_Menu.new) --------------------
{
  eq(isGameSceneInstance({ main() {} }), true, 'object with a main loop is a scene');
  eq(isGameSceneInstance({}), false, 'plain object is not a scene');
  eq(isGameSceneInstance(null), false, 'null is not a scene');
  const runtime = createRgssRuntime({ rpgExtra: {}, project: { maps: [] } }, { mapId: 1 });
  eq(runtime.takeSceneRequest(), null, 'no scene requested at boot');
  await runtime.run({ source: '$scene = Scene_Menu.new', js: '$scene = { main: async () => {} };' }, { game: null });
  const handed = runtime.takeSceneRequest();
  assert.ok(handed && typeof handed.main === 'function', 'script-assigned $scene is handed to the player'); checks++;
  eq(runtime.takeSceneRequest(), null, 'scene request is handed over once');
}

console.log(`player functions ok (${checks} checks): shop buy/sell, number/name entry, timer format, RGSS tone/blend, engine save import, Ace+VX database, command remember, async conditions, route script steps, game scene entry`);
