// RPG Maker XP database (Actors/Classes/Skills/Items/Weapons/Armors/Enemies/Troops/States/System .rxdata) -> the
// MV-shaped `database` the battle runner and menu already read (src/player/battle.js, menu.js).
//
// XP has nine stats where MV has eight parameters, and its damage is computed from power and the stat "factors"
// rather than a formula string, so the mapping is:
//   param 0 mhp   = maxhp            param 4 mat = int          param 8 (extra) = str
//   param 1 mmp   = maxsp            param 5 mdf = mdef         (weapon/armor/state `*_plus`/`*_rate` map the same way)
//   param 2 atk   = atk (weapon)     param 6 agi = agi
//   param 3 def   = pdef             param 7 luk = dex
// Skill damage is written out as the XP formula (power + atk*atk_f%, minus the defence factors, scaled by the stat
// factors) so the runner needs no XP-specific code. The runner's own attack/guard skills and guard state get spare ids
// (`system.battleIds`) because XP's own records already use ids 1 and 2.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const unwrap = value => value?.class && value.ivars ? value.ivars : value;
const field = (value, name, fallback = null) => unwrap(value)?.[`@${name}`] ?? fallback;
const list = value => Array.isArray(value) ? value : [];

function parseTable(value) {
  const raw = Buffer.from(value?.raw || value?.ivars?.['@raw'] || []);
  if (raw.length < 20) return { x: 0, y: 0, z: 0, data: [] };
  const x = raw.readInt32LE(4), y = raw.readInt32LE(8), z = raw.readInt32LE(12);
  const size = raw.readInt32LE(16) || x * y * z;
  return { x, y, z, data: Array.from({ length: size }, (_, index) => raw.readInt16LE(20 + index * 2)) };
}

// XP rank letters (A..F, stored 1..6) -> damage rate for elements and chance for states.
const ELEMENT_RANK_RATE = [0, 2, 1.5, 1, 0.5, 0, -1];
const STATE_RANK_RATE = [0, 1, 0.8, 0.6, 0.4, 0.2, 0];

const PARAM = { mhp: 0, mmp: 1, atk: 2, def: 3, mat: 4, mdf: 5, agi: 6, luk: 7, str: 8 };
const zeroParams = () => Array(9).fill(0);
// XP stat name -> parameter index (used by weapon/armor plus and state rate fields).
const STAT_PARAM = { maxhp: 0, maxsp: 1, atk: 2, pdef: 3, int: 4, mdef: 5, agi: 6, dex: 7, str: 8 };

const numberOrZero = value => Number(value) || 0;
const byId = records => { const out = [null]; for (const record of list(records)) if (record) out[Number(field(record, 'id', out.length))] = record; return out; };

function rankTraits(table, rates, code) {
  const { data } = parseTable(table);
  const traits = [];
  for (let id = 1; id < data.length; id++) {
    const rank = data[id];
    if (rank >= 1 && rank <= 6) traits.push({ code, dataId: id, value: rates[rank] });
  }
  return traits;
}

const SCOPE = { 0: 0, 1: 1, 2: 2, 3: 7, 4: 8, 5: 9, 6: 10, 7: 11 };

function skillFormula(skill) {
  const factor = name => numberOrZero(field(skill, name, 0));
  const power = numberOrZero(field(skill, 'power', 0));
  if (power === 0 && !factor('atk_f')) return { formula: '0', type: 0 };
  const stats = ['str', 'dex', 'agi', 'int'].map(name => [name, factor(`${name}_f`)]).filter(([, value]) => value)
    .map(([name, value]) => `${name === 'str' ? 'a.param(8)' : name === 'dex' ? 'a.luk' : name === 'agi' ? 'a.agi' : 'a.mat'} * ${value} / 100`);
  const defence = [factor('pdef_f') ? `b.def * ${factor('pdef_f')} / 200` : '', factor('mdef_f') ? `b.mdf * ${factor('mdef_f')} / 200` : ''].filter(Boolean);
  let text = `(${Math.abs(power)}${factor('atk_f') ? ` + a.atk * ${factor('atk_f')} / 100` : ''}`;
  if (power > 0 && defence.length) text += ` - (${defence.join(' + ')})`;
  text += ')';
  if (power > 0) text = `Math.max(${text}, 0)`;
  return { formula: `${text} * (20 + ${stats.length ? stats.join(' + ') : '0'}) / 20`, type: power < 0 ? 3 : 1 };
}

function convertSkill(skill, spares) {
  const { formula, type } = skillFormula(skill);
  const physical = numberOrZero(field(skill, 'atk_f', 0)) > 0 || numberOrZero(field(skill, 'str_f', 0)) > 0;
  const elements = list(field(skill, 'element_set', []));
  const effects = [
    ...list(field(skill, 'plus_state_set', [])).map(id => ({ code: 21, dataId: Number(id), value1: 1, value2: 0 })),
    ...list(field(skill, 'minus_state_set', [])).map(id => ({ code: 22, dataId: Number(id), value1: 1, value2: 0 })),
    ...(numberOrZero(field(skill, 'common_event_id', 0)) ? [{ code: 44, dataId: numberOrZero(field(skill, 'common_event_id', 0)), value1: 0, value2: 0 }] : [])
  ];
  return {
    id: Number(field(skill, 'id')), name: String(field(skill, 'name', '')), description: String(field(skill, 'description', '')),
    iconName: String(field(skill, 'icon_name', '')), stypeId: 1, scope: SCOPE[numberOrZero(field(skill, 'scope', 1))] ?? 1,
    occasion: numberOrZero(field(skill, 'occasion', 1)), mpCost: numberOrZero(field(skill, 'sp_cost', 0)),
    tpCost: 0, speed: 0, successRate: numberOrZero(field(skill, 'hit', 100)), repeats: 1, tpGain: 0,
    hitType: type === 0 ? 0 : physical ? 1 : 2, animationId: numberOrZero(field(skill, 'animation2_id', 0)),
    damage: { type, elementId: elements.length ? Number(elements[0]) : 0, formula, variance: numberOrZero(field(skill, 'variance', 0)), critical: false },
    effects, message1: '', message2: '', note: ''
  };
}

function convertItem(item) {
  const hp = numberOrZero(field(item, 'recover_hp', 0)), hpRate = numberOrZero(field(item, 'recover_hp_rate', 0));
  const sp = numberOrZero(field(item, 'recover_sp', 0)), spRate = numberOrZero(field(item, 'recover_sp_rate', 0));
  const effects = [
    ...(hp || hpRate ? [{ code: 11, dataId: 0, value1: hpRate / 100, value2: hp }] : []),
    ...(sp || spRate ? [{ code: 12, dataId: 0, value1: spRate / 100, value2: sp }] : []),
    ...list(field(item, 'plus_state_set', [])).map(id => ({ code: 21, dataId: Number(id), value1: 1, value2: 0 })),
    ...list(field(item, 'minus_state_set', [])).map(id => ({ code: 22, dataId: Number(id), value1: 1, value2: 0 })),
    ...(numberOrZero(field(item, 'common_event_id', 0)) ? [{ code: 44, dataId: numberOrZero(field(item, 'common_event_id', 0)), value1: 0, value2: 0 }] : [])
  ];
  const elements = list(field(item, 'element_set', []));
  return {
    id: Number(field(item, 'id')), name: String(field(item, 'name', '')), description: String(field(item, 'description', '')),
    iconName: String(field(item, 'icon_name', '')), itypeId: 1, price: numberOrZero(field(item, 'price', 0)),
    consumable: field(item, 'consumable', true) !== false, scope: SCOPE[numberOrZero(field(item, 'scope', 0))] ?? 0,
    occasion: numberOrZero(field(item, 'occasion', 0)), speed: 0, successRate: numberOrZero(field(item, 'hit', 100)), repeats: 1, tpGain: 0,
    hitType: 0, animationId: numberOrZero(field(item, 'animation2_id', 0)),
    damage: { type: 0, elementId: elements.length ? Number(elements[0]) : 0, formula: '0', variance: numberOrZero(field(item, 'variance', 0)), critical: false },
    effects, message1: '', message2: '', note: ''
  };
}

function equipParams(record) {
  const params = zeroParams();
  for (const [stat, index] of Object.entries(STAT_PARAM)) {
    params[index] += numberOrZero(field(record, stat === 'atk' || stat === 'pdef' || stat === 'mdef' ? stat : `${stat}_plus`, 0));
  }
  return params;
}

function convertEquipment(record, kind) {
  const weapon = kind === 'weapon';
  const evaRate = numberOrZero(field(record, 'eva', 0));
  const traits = [
    ...(evaRate ? [{ code: 22, dataId: 1, value: evaRate / 100 }] : []),
    ...list(field(record, weapon ? 'element_set' : 'guard_element_set', [])).map(id => weapon ? { code: 31, dataId: Number(id), value: 1 } : { code: 11, dataId: Number(id), value: 0.5 }),
    ...list(field(record, weapon ? 'plus_state_set' : 'guard_state_set', [])).map(id => weapon ? { code: 32, dataId: Number(id), value: 1 } : { code: 14, dataId: Number(id), value: 1 }),
    ...(!weapon && numberOrZero(field(record, 'auto_state_id', 0)) ? [{ code: 13, dataId: numberOrZero(field(record, 'auto_state_id', 0)), value: 1 }] : [])
  ];
  return {
    id: Number(field(record, 'id')), name: String(field(record, 'name', '')), description: String(field(record, 'description', '')),
    iconName: String(field(record, 'icon_name', '')), price: numberOrZero(field(record, 'price', 0)),
    // Each XP weapon/armor is its own equipment type, so a class's usable sets become "can equip type N" traits.
    ...(weapon ? { wtypeId: Number(field(record, 'id')), etypeId: 1 } : { atypeId: Number(field(record, 'id')), etypeId: 2 + numberOrZero(field(record, 'kind', 0)) }),
    params: equipParams(record), traits, animationId: weapon ? numberOrZero(field(record, 'animation2_id', 0)) : 0, note: ''
  };
}

const RESTRICTION = { 0: 0, 1: 0, 2: 1, 3: 3, 4: 4 };
function convertState(state, guardStateId) {
  const traits = [];
  for (const [stat, index] of Object.entries(STAT_PARAM)) {
    const rate = numberOrZero(field(state, `${stat}_rate`, 100));
    if (rate !== 100) traits.push({ code: 21, dataId: index, value: rate / 100 });
  }
  if (numberOrZero(field(state, 'eva', 0))) traits.push({ code: 22, dataId: 1, value: 0.3 });
  if (field(state, 'slip_damage', false)) traits.push({ code: 22, dataId: 7, value: -0.1 });
  if (numberOrZero(field(state, 'restriction', 0)) === 1) traits.push({ code: 42, dataId: 1 });
  const hold = numberOrZero(field(state, 'hold_turn', 0)), release = numberOrZero(field(state, 'auto_release_prob', 0));
  return {
    id: Number(field(state, 'id')), name: String(field(state, 'name', '')), iconIndex: 0, iconName: '',
    restriction: RESTRICTION[numberOrZero(field(state, 'restriction', 0))] ?? 0, priority: numberOrZero(field(state, 'rating', 5)),
    removeAtBattleEnd: field(state, 'battle_only', false) === true,
    autoRemovalTiming: hold || release ? 2 : 0,
    minTurns: hold || (release ? 1 : 0), maxTurns: hold || (release ? Math.max(1, Math.ceil(100 / release)) : 0),
    removeByDamage: numberOrZero(field(state, 'shock_release_prob', 0)) > 0, chanceByDamage: numberOrZero(field(state, 'shock_release_prob', 0)),
    traits, message1: '', message2: '', message3: '', message4: '', note: ''
  };
}

function convertEnemy(enemy, database) {
  const params = zeroParams();
  for (const [stat, index] of Object.entries(STAT_PARAM)) params[index] = numberOrZero(field(enemy, stat, 0));
  const actions = list(field(enemy, 'actions', [])).map(action => {
    const basic = numberOrZero(field(action, 'basic', 0));
    const skillId = numberOrZero(field(action, 'kind', 0)) === 1 ? numberOrZero(field(action, 'skill_id', 1)) : [database.battleIds.attackSkill, database.battleIds.guardSkill, database.battleIds.escapeSkill, database.battleIds.waitSkill][basic] ?? database.battleIds.attackSkill;
    const conditions = [];
    const turnB = numberOrZero(field(action, 'condition_turn_b', 0));
    if (turnB || numberOrZero(field(action, 'condition_turn_a', 0))) conditions.push({ conditionType: 1, conditionParam1: numberOrZero(field(action, 'condition_turn_a', 0)), conditionParam2: turnB });
    if (numberOrZero(field(action, 'condition_hp', 100)) < 100) conditions.push({ conditionType: 2, conditionParam1: 0, conditionParam2: numberOrZero(field(action, 'condition_hp', 100)) / 100 });
    if (numberOrZero(field(action, 'condition_level', 1)) > 1) conditions.push({ conditionType: 5, conditionParam1: numberOrZero(field(action, 'condition_level', 1)), conditionParam2: 0 });
    if (numberOrZero(field(action, 'condition_switch_id', 0))) conditions.push({ conditionType: 6, conditionParam1: numberOrZero(field(action, 'condition_switch_id', 0)), conditionParam2: 0 });
    // The runner takes one condition per action: keep the first and let further ones split into their own gated actions.
    return { skillId, rating: numberOrZero(field(action, 'rating', 5)), ...(conditions[0] || { conditionType: 0, conditionParam1: 0, conditionParam2: 0 }) };
  });
  const dropped = numberOrZero(field(enemy, 'item_id', 0)) ? { kind: 1, dataId: numberOrZero(field(enemy, 'item_id', 0)) }
    : numberOrZero(field(enemy, 'weapon_id', 0)) ? { kind: 2, dataId: numberOrZero(field(enemy, 'weapon_id', 0)) }
      : numberOrZero(field(enemy, 'armor_id', 0)) ? { kind: 3, dataId: numberOrZero(field(enemy, 'armor_id', 0)) } : null;
  const probability = Math.max(1, numberOrZero(field(enemy, 'treasure_prob', 0)));
  const evaRate = numberOrZero(field(enemy, 'eva', 0));
  return {
    id: Number(field(enemy, 'id')), name: String(field(enemy, 'name', '')), battlerName: String(field(enemy, 'battler_name', '')),
    battlerHue: numberOrZero(field(enemy, 'battler_hue', 0)), params, exp: numberOrZero(field(enemy, 'exp', 0)), gold: numberOrZero(field(enemy, 'gold', 0)),
    dropItems: dropped && numberOrZero(field(enemy, 'treasure_prob', 0)) ? [{ ...dropped, denominator: Math.max(1, Math.round(100 / probability)) }] : [],
    actions, traits: [
      ...(evaRate ? [{ code: 22, dataId: 1, value: evaRate / 100 }] : []),
      ...rankTraits(field(enemy, 'element_ranks'), ELEMENT_RANK_RATE, 11), ...rankTraits(field(enemy, 'state_ranks'), STATE_RANK_RATE, 13)
    ], note: ''
  };
}

// experience table: the XP curve (basis, inflation) as cumulative experience per level.
function expCurve(actor) {
  const basis = numberOrZero(field(actor, 'exp_basis', 30)), inflation = numberOrZero(field(actor, 'exp_inflation', 30));
  const power = 2.4 + inflation / 100;
  const curve = [0, 0];
  for (let level = 2; level <= 100; level++) curve[level] = curve[level - 1] + Math.trunc(basis * Math.pow(level + 3, power) / Math.pow(5, power));
  return curve;
}

function convertActor(actor, spares) {
  const table = parseTable(field(actor, 'parameters'));
  const params = Array.from({ length: 9 }, () => Array(101).fill(0));
  const columns = table.x || 6;
  for (let level = 1; level <= Math.min(100, table.y - 1); level++) {
    const row = table.data.slice(level * columns, level * columns + columns);
    // XP order: maxhp, maxsp, str, dex, agi, int.
    [params[0][level], params[1][level], params[8][level], params[7][level], params[6][level], params[4][level]] = row.map(numberOrZero);
  }
  return {
    id: Number(field(actor, 'id')), name: String(field(actor, 'name', '')), classId: numberOrZero(field(actor, 'class_id', 1)),
    initialLevel: numberOrZero(field(actor, 'initial_level', 1)), maxLevel: numberOrZero(field(actor, 'final_level', 99)) || 99,
    characterName: String(field(actor, 'character_name', '')), characterIndex: 0, battlerName: String(field(actor, 'battler_name', '')),
    equips: [field(actor, 'weapon_id', 0), field(actor, 'armor1_id', 0), field(actor, 'armor2_id', 0), field(actor, 'armor3_id', 0), field(actor, 'armor4_id', 0)].map(numberOrZero),
    params, expCurve: expCurve(actor), traits: [], profile: '', nickname: '', note: ''
  };
}

function convertClass(klass) {
  const equipTraits = [
    ...list(field(klass, 'weapon_set', [])).map(id => ({ code: 51, dataId: Number(id) })),
    ...list(field(klass, 'armor_set', [])).map(id => ({ code: 52, dataId: Number(id) }))
  ];
  return {
    id: Number(field(klass, 'id')), name: String(field(klass, 'name', '')),
    learnings: list(field(klass, 'learnings', [])).map(entry => ({ level: numberOrZero(field(entry, 'level', 1)), skillId: numberOrZero(field(entry, 'skill_id', 0)), note: '' })),
    traits: [...equipTraits, ...rankTraits(field(klass, 'element_ranks'), ELEMENT_RANK_RATE, 11), ...rankTraits(field(klass, 'state_ranks'), STATE_RANK_RATE, 13)],
    params: [], expParams: [30, 20, 30, 30], note: ''
  };
}

async function readTable(dataDir, name, decodeMarshal) {
  const path = join(dataDir, `${name}.rxdata`);
  return existsSync(path) ? decodeMarshal(await readFile(path)) : null;
}

// `convertTroopCommands(list, { troopId, troopPage })` is convert-rgss.js's own event-list converter.
export async function convertRgssDatabase(dataDir, decodeMarshal, { system, convertTroopCommands } = {}) {
  const tables = Object.fromEntries(await Promise.all(['Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'Troops', 'States'].map(async name => [name, await readTable(dataDir, name, decodeMarshal)])));
  if (!tables.Actors || !tables.Classes || !tables.Skills || !tables.Enemies || !tables.Troops) return null;
  // Essentials-style projects keep placeholder records here (blank names, no troop members) and run their battles
  // and menus in Ruby: only a database somebody actually filled in is emitted.
  const namedEnemy = new Set(list(tables.Enemies).filter(enemy => enemy && String(field(enemy, 'name', '')).trim()).map(enemy => Number(field(enemy, 'id'))));
  const playable = list(tables.Troops).some(troop => troop && list(field(troop, 'members', [])).some(member => namedEnemy.has(numberOrZero(field(member, 'enemy_id', 0)))));
  if (!playable) return null;
  const skills = byId(tables.Skills), states = byId(tables.States), items = byId(tables.Items);
  const battleIds = { attackSkill: skills.length, guardSkill: skills.length + 1, escapeSkill: skills.length + 2, waitSkill: skills.length + 3, guardState: states.length };

  const database = { skills: skills.map(skill => skill && convertSkill(skill)), states: states.map(state => state && convertState(state)), battleIds };
  database.skills[battleIds.attackSkill] = { id: battleIds.attackSkill, name: 'Attack', stypeId: 0, scope: 1, occasion: 1, mpCost: 0, tpCost: 0, speed: 0, successRate: 100, repeats: 1, tpGain: 0, hitType: 1, animationId: -1, damage: { type: 1, elementId: -1, formula: 'Math.max(a.atk - b.def / 2, 0) * (20 + a.param(8)) / 20', variance: 15, critical: false }, effects: [], message1: '', message2: '', note: '' };
  database.skills[battleIds.guardSkill] = { id: battleIds.guardSkill, name: 'Guard', stypeId: 0, scope: 11, occasion: 1, mpCost: 0, tpCost: 0, speed: 2000, successRate: 100, repeats: 1, tpGain: 0, hitType: 0, animationId: 0, damage: { type: 0, elementId: 0, formula: '0', variance: 0, critical: false }, effects: [], message1: '', message2: '', note: '' };
  database.skills[battleIds.escapeSkill] = { id: battleIds.escapeSkill, name: 'Escape', stypeId: 0, scope: 11, occasion: 1, mpCost: 0, tpCost: 0, speed: 0, successRate: 100, repeats: 1, tpGain: 0, hitType: 0, animationId: 0, damage: { type: 0, elementId: 0, formula: '0', variance: 0, critical: false }, effects: [{ code: 41, dataId: 0, value1: 0, value2: 0 }], message1: '', message2: '', note: '' };
  database.skills[battleIds.waitSkill] = { id: battleIds.waitSkill, name: 'Wait', stypeId: 0, scope: 0, occasion: 1, mpCost: 0, tpCost: 0, speed: 0, successRate: 100, repeats: 1, tpGain: 0, hitType: 0, animationId: 0, damage: { type: 0, elementId: 0, formula: '0', variance: 0, critical: false }, effects: [], message1: '', message2: '', note: '' };
  database.states[battleIds.guardState] = { id: battleIds.guardState, name: 'Guard', iconIndex: 0, restriction: 0, priority: 0, removeAtBattleEnd: true, autoRemovalTiming: 1, minTurns: 1, maxTurns: 1, removeByDamage: false, chanceByDamage: 0, traits: [], message1: '', message2: '', message3: '', message4: '', note: '' };
  database.items = items.map(item => item && convertItem(item));
  database.weapons = byId(tables.Weapons).map(weapon => weapon && convertEquipment(weapon, 'weapon'));
  database.armors = byId(tables.Armors).map(armor => armor && convertEquipment(armor, 'armor'));
  database.classes = byId(tables.Classes).map(klass => klass && convertClass(klass));
  database.actors = byId(tables.Actors).map(actor => actor && convertActor(actor));
  database.enemies = byId(tables.Enemies).map(enemy => enemy && convertEnemy(enemy, database));

  const troopEvents = {};
  database.troops = byId(tables.Troops).map(troop => {
    if (!troop) return null;
    const id = Number(field(troop, 'id'));
    const pages = list(field(troop, 'pages', [])).map((page, index) => {
      const condition = field(page, 'condition', {});
      const converted = convertTroopCommands ? convertTroopCommands(list(field(page, 'list', [])).map(command => ({ code: field(command, 'code', 0), indent: field(command, 'indent', 0), parameters: field(command, 'parameters', []) })), { troopId: id, troopPage: index }) : [];
      // XP page conditions -> MV's: turn (a, b), enemy hp, actor hp, switch.
      const conditions = {
        turnEnding: false, turnValid: field(condition, 'turn_valid', false) === true, turnA: numberOrZero(field(condition, 'turn_a', 0)), turnB: numberOrZero(field(condition, 'turn_b', 0)),
        enemyValid: field(condition, 'enemy_valid', false) === true, enemyIndex: numberOrZero(field(condition, 'enemy_index', 0)), enemyHp: numberOrZero(field(condition, 'enemy_hp', 50)),
        actorValid: field(condition, 'actor_valid', false) === true, actorId: numberOrZero(field(condition, 'actor_id', 1)), actorHp: numberOrZero(field(condition, 'actor_hp', 50)),
        switchValid: field(condition, 'switch_valid', false) === true, switchId: numberOrZero(field(condition, 'switch_id', 1))
      };
      return { conditions, span: numberOrZero(field(page, 'span', 0)), commands: Array.isArray(converted) ? converted : [], ...(converted?.story ? { story: converted.story } : {}) };
    });
    troopEvents[String(id)] = pages.filter(page => page.commands.length || page.story);
    return { id, name: String(field(troop, 'name', '')), members: list(field(troop, 'members', [])).map(member => ({ enemyId: numberOrZero(field(member, 'enemy_id', 0)), x: numberOrZero(field(member, 'x', 0)), y: numberOrZero(field(member, 'y', 0)), hidden: field(member, 'hidden', false) === true })), pages: pages.map(page => ({ conditions: page.conditions, span: page.span, list: [] })) };
  });
  database.troopEvents = troopEvents;

  // System: words -> the terms the battle and menu print; the starting party.
  const words = field(system, 'words', null);
  const word = name => String(field(words, name, '') || '');
  database.system = {
    partyMembers: list(field(system, 'party_members', [])).map(Number), currencyUnit: word('gold'), battleIds,
    terms: {
      basic: ['Level', 'Lv', word('hp') || 'HP', word('hp') || 'HP', word('sp') || 'MP', word('sp') || 'MP', 'TP', 'TP', 'EXP'],
      params: [word('hp'), word('sp'), word('atk'), word('pdef'), word('int'), word('mdef'), word('agi'), word('dex')],
      commands: ['Fight', 'Escape', word('attack'), word('guard'), word('item'), word('skill'), word('equip'), 'Status', 'Formation', 'Save', 'Game End', 'Options', word('weapon'), word('armor1'), 'Key Item', 'Equip', 'Optimize', 'Clear', 'New Game', 'Continue', 'Shutdown', 'To Title', 'Cancel', '', 'Buy', 'Sell'],
      messages: {}
    }
  };
  return database;
}
