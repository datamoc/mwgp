import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeMarshal } from '@datamoc/mw_games/rpg';
import { transpileSnippet, setInterpreterMethods } from './rgss-snippet.mjs';
import { readRgssScripts } from './rgss-scripts.mjs';
import { indexScripts, buildRgssLibrary } from './rgss-library.mjs';
import { buildAudioIndex } from './audio-index.mjs';
import { convertRgssDatabase } from './rgss-database.mjs';
import { liftBlocking } from './rgss-async.mjs';
import { exportRubyData, buildFileIndex, readTextFiles } from './rgss-data.mjs';
import { setKnownMethods } from './rgss-call-filter.mjs';
import { createProgress } from './progress.mjs';
import { VX_DATA_EXT, ENGINE_VX, VX_TILE_SIZE, VX_FPS, VX_TILESET_SHEETS, VX_MAP_LAYERS,
  vxRemap, vxWeatherType, VX_SYSTEM_SOUNDS, VX_SUPPORTED, VX_PARTIAL, vxCommandStatus } from './rgss-vx.mjs';
import { ACE_DATA_EXT, ENGINE_ACE, ACE_FPS, ACE_SUPPORTED, ACE_PARTIAL, aceTilesetEntry } from './rgss-ace.mjs';

const [, , extractedArg, outputArg, ...flags] = process.argv;
if (!extractedArg || !outputArg) {
  console.error('Usage: node tools/convert-rgss.js <extracted RGSS project> <MWGP output>');
  process.exit(1);
}
// --library-depth N: how many reference hops from the event scripts into the game's own Ruby
// library get transpiled (default 3); --no-library skips the library (event scripts only).
const libraryDepth = flags.includes('--no-library') ? 0 : Number(flags[flags.indexOf('--library-depth') + 1]) || 8;
const source = resolve(extractedArg), output = resolve(outputArg), dataDir = join(source, 'Data');
// Progress points (tools/progress.mjs): transpiling the game's Ruby library dominates the run.
const progress = createProgress();
let phase = progress.phase('reading the database', 2);
// T122: VX projects ship Data/*.rvdata (RGSS2) instead of XP's .rxdata. The
// engine gates every divergence below; the XP path stays byte-identical.
// T123: Ace projects ship Data/*.rvdata2 (RGSS3) with VX's event numbering,
// so Ace shares every VX-shaped gate below via isVxLike; genuinely
// Ace-shaped reads (tileset ids, the Tilesets table) branch on isAce.
const isAce = existsSync(join(dataDir, `System${ACE_DATA_EXT}`));
const isVx = !isAce && existsSync(join(dataDir, `System${VX_DATA_EXT}`));
const isVxLike = isVx || isAce;
const ENGINE_LABEL = isAce ? 'Ace' : isVx ? 'VX' : 'XP';
const dataExt = isAce ? ACE_DATA_EXT : isVx ? VX_DATA_EXT : '.rxdata';
const dataFile = stem => join(dataDir, `${stem}${dataExt}`);
const vxSystemDir = join(source, 'Graphics', 'System');
// VX/Ace run stock 60fps waits; XP counts in 1/20 s (command_106 waits n*2 frames at 40 fps).
const FRAME_DIVISOR = isAce ? ACE_FPS : isVx ? VX_FPS : 20;
const XP_AUTOTILE_PATTERNS = 48;
const XP_AUTOTILE_IMAGES = 8;
const XP_STATIC_TILE_BASE = XP_AUTOTILE_PATTERNS * XP_AUTOTILE_IMAGES;
const unwrap = value => value?.class && value.ivars ? value.ivars : value;
const field = (value, name, fallback = null) => unwrap(value)?.[`@${name}`] ?? fallback;

function pngDimensions(buffer) {
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseTable(value) {
  // Real Table dumps decode to { class, raw: bytes }; the ivars form below
  // matches tools/rgss-database.mjs for programmatically built fixtures.
  const raw = Buffer.from(value?.raw || value?.ivars?.['@raw'] || []);
  const z = raw.readInt32LE(0), x = raw.readInt32LE(4), y = raw.readInt32LE(8);
  const size = raw.readInt32LE(16) || x * y * z;
  // RGSS1's Table user-marshal payload has five Int32 header words followed
  // by signed 16-bit values. The fifth word is the element count.
  const data = Array.from({ length: size }, (_, index) => raw.readInt16LE(20 + index * 2));
  return { x, y, z, data };
}

function tableData(value) {
  const raw = value?.raw || value?.ivars?.['@raw'] || [];
  if (!raw?.length) return [];
  return parseTable({ raw }).data;
}

// XP event lists are (code, indent)-delimited exactly like MV's: 111 opens a
// conditional branch closed by 411 (else) / 412 (end), 112 a loop closed by 413,
// 102 a choice list closed by 404 with one 402 per choice and an optional 403
// cancel branch, and 118/119 are labels/jumps. The parser below mirrors
// convert-mv.js's parseBlock, including its terminator-by-(code, indent) rule.
const commandCounts = new Map();
// Loud-fallback counter, initialized before the map loop runs (top-level order).
const unsupportedCommandFallbacks = new Map();
// Branch (111) and variable-operand (122) fallback sites, mirroring MV's maps:
// 111/122 promote to supported in the report below when these stay empty.
const unsupportedBranchFallbacks = new Map();
const unsupportedOperandFallbacks = new Map();
function recordFallback(fallbacks, key, mapId, eventId) {
  const seen = fallbacks.get(key);
  if (!seen) fallbacks.set(key, { count: 1, first: `map ${mapId}, event ${eventId}` });
  else seen.count++;
}
function unsupportedCommand(code, kind, mapId, eventId) {
  const key = `${code}:${kind}`;
  const seen = unsupportedCommandFallbacks.get(key);
  if (!seen) {
    unsupportedCommandFallbacks.set(key, { count: 1, first: `map ${mapId}, event ${eventId}` });
    console.warn(`MWGP convert: ${ENGINE_LABEL} event command ${code} has no converted equivalent; it warns at runtime and is skipped (first seen at map ${mapId}, event ${eventId})`);
  } else seen.count++;
  return { unsupported: { code, kind } };
}

// Ruby embedded in events (355/655 Call Script, 111 branch type 12) is
// transpiled to JS once per unique source; the manifest keeps the Ruby text
// next to the JS so a failed snippet stays diagnosable and loud at run time.
const scriptStats = { total: 0, transpiled: 0, failed: new Map(), sources: new Set() };
const snippetCache = new Map();
function convertScript(ruby, kind) {
  const key = `${kind}:${ruby}`;
  if (!snippetCache.has(key)) {
    const result = transpileSnippet(ruby, kind);
    snippetCache.set(key, result);
    if (result.error) scriptStats.failed.set(ruby, result.error);
  }
  scriptStats.total++;
  scriptStats.sources.add(ruby);
  const result = snippetCache.get(key);
  if (!result.error) scriptStats.transpiled++;
  return result.error ? { source: ruby, error: result.error } : { source: ruby, js: result.js };
}
const commonEvents = new Map();

// Game-data variable operands in the stock RGSS command_122 layout. Kind 6
// (character: player x/y) and kind 7 (map id, party size, gold) read
// player-held state; directions, screen coordinates, terrain tags, steps,
// playtime, timer, and save counts have no model and stay loud markers.
function convertXpGameDataOperand(p, operation, context = {}) {
  const operationName = ['set', 'add', 'subtract', 'multiply', 'divide', 'modulo'][Number(operation || 0)];
  const first = Number(p[0]);
  const last = Number(p[1] ?? first);
  const range = build => Array.from({ length: last - first + 1 }, (_, offset) => build(String(first + offset)));
  const kind = Number(p[3] || 0);
  let gameData = null;
  if (kind === 6 && Number(p[4]) === -1 && Number(p[5]) === 0) gameData = { kind: 'playerX' };
  else if (kind === 6 && Number(p[4]) === -1 && Number(p[5]) === 1) gameData = { kind: 'playerY' };
  else if (kind === 7 && Number(p[4]) === 0) gameData = { kind: 'mapId' };
  else if (kind === 7 && Number(p[4]) === 1) gameData = { kind: 'partySize' };
  else if (kind === 7 && Number(p[4]) === 2) gameData = { kind: 'gold' };
  if (!gameData || !operationName) {
    console.warn(`MWGP convert: ${ENGINE_LABEL} game-data operand ${kind}/${p[4]}/${p[5]} has no converted equivalent; it warns at runtime and reads as 0 (map ${context.mapId}, event ${context.eventId})`);
    recordFallback(unsupportedOperandFallbacks, `122:${kind}`, context.mapId, context.eventId);
    return range(() => ({ unsupported: { code: 122, kind } }));
  }
  return range(id => ({ modifyVariable: { target: id, operation: operationName, operand: { gameData } } }));
}
function selfSwitchKey(mapId, eventId, ch) {
  return `self:${mapId}:${eventId}:${ch}`;
}

function convertPageConditions(condition, mapId, eventId) {
  const result = [];
  if (field(condition, 'switch1_valid', false)) result.push({ switch: String(field(condition, 'switch1_id', 0)), equals: true });
  if (field(condition, 'switch2_valid', false)) result.push({ switch: String(field(condition, 'switch2_id', 0)), equals: true });
  // Page variable conditions are a fixed >= test (Game_Event refresh skips the
// page while `$game_variables[id] < value`), matching MV's atLeast semantics.
  if (field(condition, 'variable_valid', false)) result.push({ variable: String(field(condition, 'variable_id', 0)), atLeast: Number(field(condition, 'variable_value', 0)) });
  if (field(condition, 'self_switch_valid', false)) result.push({ switch: selfSwitchKey(mapId, eventId, field(condition, 'self_switch_ch', 'A') || 'A'), equals: true });
  return result;
}

// XP branch types (verified against Interpreter_Commands#command_111 in the
// shipped scripts): 0 switch (parameters[2] picks ON vs OFF), 1 variable with
// [varId, const?(0)/var(1), valueOrVarId, op(0==,1>=,2<=,3>,4<,5!=)] of which
// only a constant >= maps onto MWGP's atLeast, 2 self switch (same ON/OFF
// flag). Type 6 (character facing) and 7 (gold) map onto the same MWGP
// conditions MV uses; anything else becomes a loud unsupported marker.

function convertBranchCondition(parameters, mapId, eventId) {
  if (parameters[0] === 0) return { switch: String(parameters[1]), equals: parameters[2] === 0 };
  if (parameters[0] === 1) {
    const operator = { 0: 'eq', 1: 'gte', 2: 'lte', 3: 'gt', 4: 'lt', 5: 'neq' }[Number(parameters[4] ?? 0)];
    if (!operator) { console.warn(`MWGP convert: ${ENGINE_LABEL} variable comparison operator ${parameters[4]} has no converted equivalent; it warns at runtime and takes the else-branch (map ${mapId}, event ${eventId})`); recordFallback(unsupportedBranchFallbacks, '111:1', mapId, eventId); return { unsupported: { code: 111, kind: 1 } }; }
    if (Number(parameters[2] || 0) === 0) {
      return operator === 'gte'
        ? { variable: String(parameters[1]), atLeast: Number(parameters[3] || 0) }
        : { variable: String(parameters[1]), operator, value: Number(parameters[3] || 0) };
    }
    return { variable: String(parameters[1]), operator, compareVariable: String(parameters[3]) };
  }
  if (parameters[0] === 2) return { switch: selfSwitchKey(mapId, eventId, parameters[1] || 'A'), equals: parameters[2] === 0 };
  // Type 12 is a Ruby expression ("Script" in the branch dialog); it runs in
  // the player's RGSS shim rather than mapping onto a fixed MWGP condition.
  if (parameters[0] === 12) return { script: convertScript(String(parameters[1] ?? ''), 'cond') };
  if (parameters[0] === 6) {
    const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[Number(parameters[2])];
    if (facing && Number(parameters[1]) === -1) return { facing };
    if (facing && Number(parameters[1]) === 0) return { eventFacing: facing };
  }
  if (parameters[0] === 7) {
    return { gold: { operator: Number(parameters[2] || 0) === 0 ? 'gte' : 'lte', value: Number(parameters[1] || 0) } };
  }
  // Types without an engine-free equivalent must stay loud instead of dropping
  // the whole branch: the player warns on the marker and takes the else-branch.
  console.warn(`MWGP convert: ${ENGINE_LABEL} branch type ${parameters[0]} has no converted equivalent; it warns at runtime and takes the else-branch (map ${mapId}, event ${eventId})`);
  recordFallback(unsupportedBranchFallbacks, `111:${parameters[0]}`, mapId, eventId);
  return { unsupported: { code: 111, kind: Number(parameters[0]) } };
}

function convertEvent(event, mapId) {
  const eventId = field(event, 'id', 0);
  const pages = field(event, 'pages', []).map(page => {
    const graphic = unwrap(field(page, 'graphic', {}));
    const list = field(page, 'list', []).map(item => ({
      code: field(item, 'code', 0),
      indent: Number(field(item, 'indent', 0)),
      parameters: field(item, 'parameters', [])
    }));
    for (const item of list) commandCounts.set(item.code, (commandCounts.get(item.code) || 0) + 1);
    // A labeled list converts to { story } instead of a flat array; the player
    // drives it with runStoryLoop (see runPage).
    const converted = convertCommands(list, { mapId, eventId });
    return {
      trigger: ['action', 'touch', 'touch', 'autorun', 'parallel'][Number(field(page, 'trigger', 0))] || 'action',
      conditions: convertPageConditions(field(page, 'condition', null), mapId, eventId),
      commands: Array.isArray(converted) ? converted : [],
      ...(converted.story ? { story: converted.story } : {}),
      through: Boolean(field(page, 'through', false)),
      priorityType: Number(field(page, 'through', false)) ? 0 : 1,
      image: field(graphic, 'character_name', '') ? { name: field(graphic, 'character_name', ''), index: 0, direction: Number(field(graphic, 'direction', 2)), pattern: Number(field(graphic, 'pattern', 1)) } : null
    };
  });
  return { id: String(eventId), name: String(field(event, 'name', '') || ''), x: Number(field(event, 'x', 0)), y: Number(field(event, 'y', 0)), pages };
}

function convertCommands(list, context = {}) {
  const { mapId, eventId, depth = 0, stack = [] } = context;
  // Labels (118) split the top-level list into named story passages; jumps
  // (119) become { goto } markers the player's story driver follows. Labels
  // nested inside blocks are dropped with a warning: splitting there would
  // break the block structure.
  const story = { start: 'main', passages: {} };
  const order = ['main'];
  let current = 'main';
  // Inlined common events (depth > 0) must stay flat arrays for spreading, so
  // only page-level lists split into passages.
  const parsed = parseBlock(0, -1, depth === 0);
  story.passages[current] = parsed.commands;
  if (Object.keys(story.passages).length > 1) return { story: { ...story, order } };
  return parsed.commands;

  function parseBlock(start, parentIndent, topLevel = false) {
    let result = [];
    let index = start;
    while (index < list.length) {
      const command = list[index];
      if ([402, 403, 404, 411, 412, 413, 601, 602, 603, 604].includes(command.code) && command.indent === parentIndent) {
        return { commands: result, index, marker: command.code };
      }
      if (command.code === 118) {
        const name = String(command.parameters?.[0] || 'label');
        if (!topLevel) console.warn(`MWGP convert: label "${name}" nested in a block (map ${mapId}, event ${eventId}) cannot split passages; dropping it`);
        else {
          if (story.passages[name]) console.warn(`MWGP convert: duplicate label "${name}" (map ${mapId}, event ${eventId}); later passage wins`);
          story.passages[current] = result;
          current = name;
          if (!order.includes(name)) order.push(name);
          result = [];
        }
        index++;
        continue;
      }
      if (command.code === 119) {
        result.push({ goto: String(command.parameters?.[0] || '') });
        index++;
        continue;
      }
      if (command.code === 111) {
        const condition = convertBranchCondition(command.parameters || [], mapId, eventId);
        const thenBlock = parseBlock(index + 1, command.indent);
        index = thenBlock.index;
        let elseCommands;
        if (thenBlock.marker === 411) {
          const elseBlock = parseBlock(index + 1, command.indent);
          elseCommands = elseBlock.commands;
          index = elseBlock.index;
        }
        // convertBranchCondition never returns null (unknown types become an
        // explicit unsupported marker), so the block is always preserved.
        result.push({ if: condition, then: thenBlock.commands, else: elseCommands || [] });
        if (list[index]?.code === 412 && list[index].indent === command.indent) index++;
        continue;
      }
      if (command.code === 112) {
        const body = parseBlock(index + 1, command.indent);
        index = body.index;
        result.push({ loop: body.commands });
        if (list[index]?.code === 413 && list[index].indent === command.indent) index++;
        continue;
      }
      if (command.code === 102) {
        const texts = command.parameters?.[0] || [];
        const cancelType = Number(command.parameters?.[1] ?? -2);
        const branches = texts.map(() => []);
        let cancelBranch;
        index++;
        while (index < list.length) {
          const sub = list[index];
          if (sub.code === 404 && sub.indent === command.indent) { index++; break; }
          if (sub.code === 402 && sub.indent === command.indent) {
            const choiceIndex = Number(sub.parameters?.[0] ?? 0);
            const block = parseBlock(index + 1, command.indent);
            branches[choiceIndex] = block.commands;
            index = block.index;
            continue;
          }
          if (sub.code === 403 && sub.indent === command.indent) {
            const block = parseBlock(index + 1, command.indent);
            cancelBranch = block.commands;
            index = block.index;
            continue;
          }
          index++;
        }
        result.push({
          ask: '', choices: texts.map((text, i) => ({ text, value: i })), branches,
          ...(cancelType === -1 && cancelBranch ? { cancelBranch } : {})
        });
        continue;
      }
      // 301 Battle Processing owns its following Win/Escape/Lose blocks (601-603, closed by 604).
      // VX carries a leading designation (0 direct, 1 variable troop, 2 random
      // encounter), so its troop id sits one slot later; variable/random
      // designations still read that slot (battles are duel-fallback without
      // a mapped VX database anyway).
      if (command.code === 301) {
        const [troop, canEscape, canLose] = isVxLike ? (command.parameters || []).slice(1) : (command.parameters || []);
        const branches = {};
        index++;
        while (index < list.length) {
          const marker = list[index];
          const name = { 601: 'win', 602: 'escape', 603: 'lose' }[marker.code];
          if (name && marker.indent === command.indent) { const block = parseBlock(index + 1, command.indent); branches[name] = block.commands; index = block.index; continue; }
          if (marker.code === 604 && marker.indent === command.indent) { index++; break; }
          break;
        }
        result.push({ battle: { troopId: Number(troop || 0), canEscape: canEscape === true, canLose: canLose === true, ...(Object.keys(branches).length ? { branches } : {}) } });
        continue;
      }
      if (command.code === 355) {
        let script = command.parameters?.[0] || '';
        // The engine keeps appending while the next line is 355 or 655.
        while (index + 1 < list.length && [355, 655].includes(list[index + 1].code)) {
          index++;
          script += '\n' + (list[index].parameters?.[0] || '');
        }
        const trainerName = /^\s*(?:this\.)?pbTrainerName\s*(?:\(\s*\))?\s*;?\s*$/i.test(script);
        result.push(trainerName
          ? { inputName: { target: 'player', maxLength: 12 } }
          : { script, ...(({ js, error }) => js !== undefined ? { js } : { error })(convertScript(script, 'call')) });
        index++;
        continue;
      }
      // 105 (Show Scrolling Text) owns its following 405 body lines the way
      // 355 owns 655s. A 405 outside a 105 stays dropped by convertCommand.
      // XP-only: VX has neither code (both stay loud markers there).
      if (command.code === 105 && !isVxLike) {
        const [speed, noFast] = command.parameters || [];
        const lines = [];
        while (index + 1 < list.length && list[index + 1].code === 405) {
          index++;
          lines.push(list[index].parameters?.[0] || '');
        }
        result.push({ scroll: { text: lines.join('\n'), speed: Number(speed ?? 2), noFast: noFast === true } });
        index++;
        continue;
      }
      // 209 (Set Movement Route) owns its following 509 step entries the way
      // 355 owns 655s; the route object itself lives in parameters[1]
      // (verified: 638/638 routes in the Pokemon Void corpus). VX renumbered
      // the pair to 205/505 with the same positions.
      if ((command.code === 209 && !isVxLike) || (command.code === 205 && isVxLike)) {
        const moved = convertRoute(command.parameters?.[0], unwrap(command.parameters?.[1]));
        if (moved.length) result.push(...moved);
        index++;
        const continuation = isVxLike ? 505 : 509;
        while (index < list.length && list[index].code === continuation) index++;
        continue;
      }
      // VX 302 (Shop Processing) owns its following 605 goods lines like MV's
      // 302: the command's own parameters are the first goods entry
      // [goods_type, goods_id, price_type, price] (no purchase-only flag).
      if (command.code === 302 && isVxLike) {
        const goods = [command.parameters || []];
        while (index + 1 < list.length && list[index + 1].code === 605) {
          index++;
          goods.push(list[index].parameters || []);
        }
        result.push({ shop: {
          goods: goods.map(entry => ({
            kind: Number(entry[0] ?? 0),
            id: Number(entry[1] ?? 0),
            priceType: Number(entry[2] ?? 0),
            price: Number(entry[3] ?? 0)
          }))
        } });
        index++;
        continue;
      }
      const converted = convertCommand(command, { depth, mapId, eventId, stack });
      if (converted) result.push(...converted);
      index++;
    }
    return { commands: result, index, marker: null };
  }
}

// Routes targeting the player (-1) or the running event itself (0) execute as
// player movement: the player has no per-event movers, so an event's own route
// visibly moves the player instead — an approximation. Other targets are
// dropped. Step codes are RGSS's Game_Character ROUTE_* constants, the same
// numbering MV kept (turns 16-19, wait 15, jump 14 all confirmed in the XP
// corpus). Through and transparency steps are retained; speed/frequency and
// image/blend steps (29-36, 41, 43) have no player-side equivalent and stay
// dropped, keeping routes partial.
function convertRoute(target, route) {
  if (target !== -1 && target !== 0) return [];
  const commands = [];
  for (const item of field(route, 'list', [])) {
    const step = { code: field(item, 'code', 0), parameters: field(item, 'parameters', []) };
    const movement = {
      1: { dx: 0, dy: 1 }, 2: { dx: -1, dy: 0 }, 3: { dx: 1, dy: 0 }, 4: { dx: 0, dy: -1 },
      5: { dx: -1, dy: 1 }, 6: { dx: 1, dy: 1 }, 7: { dx: -1, dy: -1 }, 8: { dx: 1, dy: -1 },
      9: { random: true }, 12: { forward: true }, 13: { backward: true }
    }[step.code];
    // 10/11 (toward/away from player) are degenerate for a player target.
    const jump = step.code === 14 ? { jump: { dx: Number(step.parameters?.[0] || 0), dy: Number(step.parameters?.[1] || 0) } } : null;
    const turn = {
      16: 'down', 17: 'left', 18: 'right', 19: 'up', 20: 'right90', 21: 'left90',
      22: 'around', 23: 'random', 24: 'random', 25: 'toward', 26: 'away'
    }[step.code];
    if (movement) commands.push({ move: { target: 'player', steps: [movement] } });
    else if (jump) commands.push({ move: { target: 'player', steps: [jump] } });
    else if (turn) commands.push({ turn });
    else if (step.code === 15) commands.push({ wait: Number(step.parameters?.[0] || 0) / FRAME_DIVISOR });
    else if (step.code === 27 || step.code === 28) commands.push({ setSwitch: String(step.parameters?.[0] ?? 0), value: step.code === 27 });
    else if (step.code === 37 || step.code === 38) commands.push({ routeThrough: { target: 'player', value: step.code === 37 } });
    else if (step.code === 39 || step.code === 40 || step.code === 42) {
      const value = step.code === 42
        ? Math.max(0, Math.min(1, Number(step.parameters?.[0] ?? 255) / 255))
        : step.code === 39;
      commands.push({ setTransparent: value });
    }
    else if (step.code === 44) {
      const se = step.parameters?.[0];
      const audio = unwrap(se);
      if (audio?.name) commands.push({ sound: { name: audio.name, volume: Number(audio.volume ?? 90), pitch: Number(audio.pitch ?? 100), pan: Number(audio.pan || 0) } });
    } else if (step.code === 45 && step.parameters?.[0]) commands.push({ script: String(step.parameters[0]) });
  }
  return commands;
}

function audioParams(entry) {
  const audio = unwrap(entry);
  if (!audio?.name) return null;
  return { name: audio.name, volume: Number(audio.volume ?? 90), pitch: Number(audio.pitch ?? 100), pan: Number(audio.pan || 0) };
}

function convertCommand(command, context = {}) {
  // T122: VX divergences. Same-number/different-meaning codes get their own
  // case here so no XP case below can mis-fire on VX data; pure renumbers
  // normalize to the XP case afterwards (order matters: a remapped 203 must
  // reach XP's 202 relocate case, not VX's 202 vehicle case above).
  if (isVxLike) {
    const vp = command.parameters || [];
    // 202 is Set Vehicle Location [vehicle, designation, map, x, y] (XP's
    // 202 is Set Event Location): same shape MV's 202 produces.
    if (command.code === 202) {
      const [vehicle, designation, a, b, c] = vp;
      if (Number(designation || 0) === 0) return [{ vehicleLocation: { vehicle: Number(vehicle || 0), mapId: Number(a || 0), x: Number(b || 0), y: Number(c || 0) } }];
      if (Number(designation) === 1) return [{ vehicleLocation: { vehicle: Number(vehicle || 0), mapVar: String(a ?? 0), xVar: String(b ?? 0), yVar: String(c ?? 0) } }];
      return [unsupportedCommand(Number(command.code), Number(designation), context.mapId, context.eventId)];
    }
    // 230 is Wait [frames] at the stock 60 fps.
    if (command.code === 230) return [{ wait: Number(vp[0] || 0) / FRAME_DIVISOR }];
    // 212/213 are the real Show Animation / Show Balloon Icon
    // [character_id, id, wait], like MV's; a falsy id shows nothing.
    if (command.code === 212) return Number(vp[1]) ? [{ animation: { target: Number(vp[0] ?? -1), animation: Number(vp[1]), wait: vp[2] === true } }] : [];
    if (command.code === 213) return Number(vp[1]) ? [{ balloon: { target: Number(vp[0] ?? -1), balloon: Number(vp[1]), wait: vp[2] === true } }] : [];
    // 236 weather [type, power, duration]: int enum onto player strings.
    if (command.code === 236) return [{ weather: { type: vxWeatherType(vp[0]), power: Number(vp[1] || 0), duration: Number(vp[2] || 0) / FRAME_DIVISOR, wait: false } }];
    // 303 name input [actor_id, max_characters], like MV's 303.
    if (command.code === 303) return [{ inputName: { target: 'player', actorId: Number(vp[0] || 0), maxLength: Number(vp[1] || 12) } }];
    // 214 is Erase Event (XP's 116): explicit case, not a remap, because the
    // XP 116 case below is engine-gated.
    if (command.code === 214) return [{ eraseEvent: true }];
    const remapped = vxRemap(command.code);
    if (remapped != null) command = { ...command, code: remapped };
  }
  const p = command.parameters || [];
  // 126-129 inventory/party, same layout in XP, VX and Ace: [id, operation,
  // operand_type, value] (VX/Ace weapons and armor carry an unmapped
  // include_equipped fifth slot), the amount shape MV's identical commands
  // produce; 129 is [actor_id, operation, initialize], and the initialize flag
  // has no MWGP shape (partial in the report).
  if (command.code === 126 || command.code === 127 || command.code === 128) {
    const [id, op, type, val] = p;
    const amount = type === 0 ? (op === 1 ? -Number(val || 0) : Number(val || 0)) : { variable: String(val), op: op === 1 ? 'sub' : 'add' };
    const key = command.code === 126 ? 'changeItem' : command.code === 127 ? 'changeWeapon' : 'changeArmor';
    return [{ [key]: { id: Number(id), amount } }];
  }
  if (command.code === 129) return [{ changeParty: { actorId: Number(p[0]), add: Number(p[1]) === 0 } }];
  // 101/401 continuation lines join into one message box in the engine, but MV's
  // converter already emits them as sequential says and the player shows those
  // in order, so XP matches that shape instead of introducing a joined form.
  // VX carries the first line the same way (it has no face graphics); a
  // four-param face-style opener carries no text — the 401s below do.
  if (command.code === 401) return [{ say: String(p[0] || '') }];
  if (command.code === 101) {
    if (isVxLike && p.length >= 4 && typeof p[1] === 'number') return [];
    return [{ say: String(p[0] || '') }];
  }
  if (command.code === 102 || command.code === 111 || command.code === 112 || command.code === 355 || ((command.code === 105 || command.code === 209) && !isVxLike)) return [];
  // XP's 103 (Input Number [variable, digits]) and 104 (Change Text Options
  // [position, frame]) are stock RGSS shapes, not MV's same-numbered commands.
  if (command.code === 103) return [{ inputNumber: { variable: String(p[0] ?? 0), digits: Number(p[1] ?? 1) } }];
  // 104/106 are XP shapes (message options, 1/20 s waits); VX has neither
  // code, so they stay loud markers there (gated below).
  if (command.code === 104 && !isVxLike) return [{ messageOptions: { position: Number(p[0] ?? 2), frame: Number(p[1] ?? 0) } }];
  // Stock XP command_106 waits n*2 frames at 40 fps: n/20 seconds, not the /60
  // MV's 60fps engine implies.
  if (command.code === 106 && !isVxLike) return [{ wait: Number(p[0] || 0) / 20 }];
  // 108/408 (Comment / Comment body) are correctly handled by doing nothing.
  if (command.code === 108 || command.code === 408 || command.code === 0) return [];
  if (command.code === 113) return [{ breakLoop: true }];
  if (command.code === 115) return [{ exitEvent: true }];
  // 117 inlines the common event's list, the same treatment MV's converter
  // gives its code 117: true recursion (kind 1) and the depth-8 backstop
  // against diamond reuse (kind 2) stay loud markers, as does a dangling id
  // (kind 0) — never a silent skip.
  if (command.code === 117) {
    const ceId = Number(p[0]);
    const body = commonEvents.get(ceId);
    const inlineStack = Array.isArray(context.stack) ? context.stack : [];
    const inlineDepth = Number(context.depth ?? 0);
    if (body && !inlineStack.includes(ceId) && inlineDepth < 8) {
      return convertCommands(body, { ...context, depth: inlineDepth + 1, stack: [...inlineStack, ceId] });
    }
    return [unsupportedCommand(Number(command.code), !body ? 0 : inlineStack.includes(ceId) ? 1 : 2, context.mapId, context.eventId)];
  }
  if (command.code === 121) return Array.from({ length: p[1] - p[0] + 1 }, (_, offset) => ({ setSwitch: String(p[0] + offset), value: p[2] === 0 }));
  // 122 params are [first, last, op, kind, operand]: kind 0 constant, 1 another
  // variable, 2 a random range; op 0 set, 1 add, 2 subtract, 3 multiply,
  // 4 divide, 5 modulo. Kinds 6/7 go through convertXpGameDataOperand above;
  // anything the operand mapper rejects stays a loud unsupported marker
  // (same rule as MV's convertExtendedOperand fallback).
  if (command.code === 122) {
    const first = Number(p[0]);
    const last = Number(p[1] ?? first);
    const operation = Number(p[2] || 0);
    const operandType = Number(p[3] || 0);
    if (operandType === 6 || operandType === 7) return convertXpGameDataOperand(p, operation, { mapId: context.mapId, eventId: context.eventId });
    if (operandType > 2) {
      console.warn(`MWGP convert: ${ENGINE_LABEL} variable operand kind ${operandType} has no converted equivalent; it warns at runtime and reads as 0 (map ${context.mapId}, event ${context.eventId})`);
      recordFallback(unsupportedOperandFallbacks, `122:${operandType}`, context.mapId, context.eventId);
      return Array.from({ length: last - first + 1 }, () => ({ unsupported: { code: 122, kind: operandType } }));
    }
    return Array.from({ length: last - first + 1 }, (_, offset) => {
      const id = String(first + offset);
      if (operandType === 1) return operation === 0 ? { copyVariable: id, variable: String(p[4]) } : null;
      const amount = operandType === 2
        ? { random: [Number(p[4] || 0), Number(p[5] || 0)] }
        : { value: Number(p[4] || 0) };
      if (operation === 0) return operandType === 0 ? { setVariable: id, value: amount.value } : { copyVariable: id, ...amount };
      if (operation === 1 && operandType === 0) return { addVariable: id, amount: amount.value };
      if (operation === 2 && operandType === 0) return { addVariable: id, amount: -amount.value };
      if (operation >= 1 && operation <= 5) return { modifyVariable: { target: id, operation: ['add', 'subtract', 'multiply', 'divide', 'modulo'][operation - 1], operand: operandType === 1 ? { variable: String(p[4]) } : amount } };
      return null;
    }).filter(Boolean);
  }
  if (command.code === 123 && context.mapId != null && context.eventId != null) {
    return [{ setSwitch: selfSwitchKey(context.mapId, context.eventId, p[0] || 'A'), value: p[1] === 0 }];
  }
  // 125 params are [op, kind, value]: op 0 increase, 1 decrease; kind 0 a
  // constant, 1 a variable id. The variable form reuses MV's { variable, op }
  // amount shape, which the player's applyInventory already resolves.
  if (command.code === 125) {
    const [op, kind, val] = p;
    const amount = kind === 0 ? (op === 1 ? -Number(val || 0) : Number(val || 0)) : { variable: String(val), op: op === 1 ? 'sub' : 'add' };
    return [{ changeGold: amount }];
  }
  if (command.code === 201) {
    if (Number(p[0] || 0) === 0) return [{ transfer: { mapId: p[1], x: p[2], y: p[3] } }];
    if (Number(p[0] || 0) === 1) return [{ transfer: { mapVar: p[1], xVar: p[2], yVar: p[3] } }];
  }
  // 202 params are [target, designation, x, y, direction]: designation 0 is
  // direct and 1 reads x/y from variables; anything else swaps two events (no
  // player equivalent, dropped). The facing table is the standard 2/4/6/8
  // keypad, which MWGP relocate already carries as facing.
  if (command.code === 202 && [0, 1].includes(Number(p[1] || 0))) {
    const resolved = Number(p[0] ?? -1) === -1 ? 'player' : Number(p[0]) === 0 ? 'self' : String(p[0]);
    const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[Number(p[4])] || null;
    return [{ relocate: {
      target: resolved,
      ...(Number(p[1] || 0) === 1 ? { varX: String(p[2]), varY: String(p[3]) } : { x: Number(p[2] || 0), y: Number(p[3] || 0) }),
      ...(facing ? { facing } : {})
    } }];
  }
  // 204 changes map-wide panorama, fog, or battleback settings. Panorama and
  // fog are retained as explicit runtime settings; battlebacks remain a
  // partial visual feature outside the map scene.
  if (command.code === 204) {
    if (Number(p[0] || 0) === 0) return [{ mapSettings: { kind: 'panorama', name: String(p[1] || ''), hue: Number(p[2] || 0) } }];
    if (Number(p[0] || 0) === 1) return [{ mapSettings: { kind: 'fog', name: String(p[1] || ''), hue: Number(p[2] || 0), opacity: Number(p[3] || 0), blendType: Number(p[4] || 0), zoom: Number(p[5] || 100), sx: Number(p[6] || 0), sy: Number(p[7] || 0) } }];
    if (Number(p[0] || 0) === 2) return [{ mapSettings: { kind: 'battleback', name: String(p[1] || '') } }];
    return [unsupportedCommand(Number(command.code), Number(p[0] ?? 0), context.mapId, context.eventId)];
  }
  // 203 is Scroll Map with MV's own [direction, distance, speed] parameter
  // order (verified: start_scroll(@parameters[0..2])), so it maps onto the
  // same scrollMap shape MV's 204 produces.
  if (command.code === 203) {
    const [direction, distance, speed] = p;
    return [{ scrollMap: { direction: Number(direction || 2), distance: Number(distance || 0), speed: Number(speed ?? 4) } }];
  }
  // 103 and 104 are handled above. 205 is the fog tone change and remains
  // partial until the fog filter can accept an XP tone object. 233 (Rotate
  // Picture) has no vocabulary entry either.
  // 212/213 (animation/balloon) and 214-216 have no handler in
  // the shipped Interpreter at all, so dropping them matches the engine.
  // 116/208/210 are XP shapes (erase, transparency, wait-for-move); VX
  // renumbered erase to 214, so the XP cases stay gated.
  if (command.code === 116 && !isVxLike) return [{ eraseEvent: true }];
  // 208 sets player transparency (like MV's 211), which MWGP's setTransparent
  // already expresses. 210 (Wait for Move's Completion) is satisfied by the
  // sequential execution itself: converted routes run to completion before the
  // next command starts.
  if (command.code === 208 && !isVxLike) return [{ setTransparent: p[0] === 0 }];
  if (command.code === 210 && !isVxLike) return [];
  // 221 (freeze) + 222 (execute transition by name) bracket a scene transition;
  // with the usual empty name that transition is a plain fade, which screenFade
  // approximates. A named fancy transition still reads as a visible cut.
  if (command.code === 221) return [{ screenFade: { direction: 'out', duration: 24 / 60 } }];
  if (command.code === 222) return [{ screenFade: { direction: 'in', duration: 24 / 60 } }];
  // All frame-denominated screen durations below divide by 20: stock XP passes
  // n*2 frames at 40 fps (n/20 seconds), and XP lists carry no wait flags, so
  // waits read as false.
  // 223 params are [tone, duration].
  if (command.code === 223) {
    const tone = [field(p[0], 'red', 0), field(p[0], 'green', 0), field(p[0], 'blue', 0), field(p[0], 'gray', 0)];
    const clamp = n => Math.max(-255, Math.min(255, Math.round(Number(n) || 0)));
    return [{ screenTint: { tone: tone.map(clamp), duration: Number(p[1] || 0) / 20, wait: false } }];
  }
  // 224 params are [color(4 doubles incl. alpha), duration]: the alpha channel
  // becomes the flash peak.
  if (command.code === 224) {
    const flash = [field(p[0], 'red', 255), field(p[0], 'green', 255), field(p[0], 'blue', 255), field(p[0], 'alpha', 0)];
    const clamp = n => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
    return [{ screenFlash: { color: (clamp(flash[0]) << 16) | (clamp(flash[1]) << 8) | clamp(flash[2]), peak: Math.max(0, Math.min(1, Number(flash[3] || 0) / 255)), duration: Number(p[1] || 0) / 20, wait: false } }];
  }
  // 225 params are [power, speed, duration].
  if (command.code === 225) return [{ screenShake: { power: Number(p[0] || 5), speed: Number(p[1] || 5), duration: Number(p[2] || 0) / 20, wait: false } }];
  // 231 params are [id, name, origin, designation, x, y, zoomX, zoomY, opacity,
  // blend] (verified: pictures[number].show(name, origin, x, y, zx, zy, op,
  // blend) with x/y direct at [4]/[5] when [3] is 0, variable ids otherwise).
  // Only direct appointments convert; the blend mode has no MWGP field.
  if (command.code === 231) {
    // An empty picture name shows nothing (engine no-op); a variable
    // designation has no MWGP shape and stays a loud marker.
    if (!p[1]) return [];
    if (Number(p[3] || 0) !== 0) return [unsupportedCommand(Number(command.code), Number(p[3]), context.mapId, context.eventId)];
    return [{ picture: { id: Number(p[0]), name: p[1], origin: Number(p[2] || 0), x: Number(p[4] || 0), y: Number(p[5] || 0), scaleX: Number(p[6] ?? 100), scaleY: Number(p[7] ?? 100), opacity: Number(p[8] ?? 255) } }];
  }
  // 232 params are [id, duration, origin, designation, x, y, zoomX, zoomY,
  // opacity, blend] (verified: pictures[number].move(duration, origin, x, y,
  // zx, zy, op, blend) against Game_Picture#move's signature) — same fields as
  // MV's Move Picture in a different order, which is why the MV indices looked
  // wrong. Direct appointments convert with the duration in /20 seconds.
  if (command.code === 232 && Number(p[3] || 0) === 0) {
    return [{
      movePicture: {
        id: Number(p[0]), x: Number(p[4] || 0), y: Number(p[5] || 0),
        scaleX: Number(p[6] ?? 100), scaleY: Number(p[7] ?? 100), opacity: Number(p[8] ?? 255),
        duration: Number(p[1] || 0) / 20, wait: false
      }
    }];
  }
  if (command.code === 234) {
    const tone = [field(p[1], 'red', 0), field(p[1], 'green', 0), field(p[1], 'blue', 0), field(p[1], 'gray', 0)];
    const clamp = n => Math.max(-255, Math.min(255, Math.round(Number(n) || 0)));
    return [{ tintPicture: { id: Number(p[0]), tone: tone.map(clamp), duration: Number(p[2] || 0) / 20, wait: false } }];
  }
  if (command.code === 235) return [{ erasePicture: Number(p[0] || 0) }];
  if (command.code === 241) {
    const bgm = audioParams(p[0]);
    return bgm ? [{ playBgm: bgm }] : [];
  }
  if (command.code === 242) return [{ fadeoutBgm: { duration: Number(p[0] || 1) } }];
  // 236 sets weather [type, power, duration], which the player doesn't render;
  // dropped and reported. 247/248 memorize and restore the BGM/BGS, which is
  // exactly what MWGP's saveBgm/resumeBgm pair (borrowed from MV's 243/244)
  // already expresses in the player.
  if (command.code === 245) {
    const bgs = audioParams(p[0]);
    return bgs ? [{ playBgs: bgs }] : [];
  }
  if (command.code === 246) return [{ fadeoutBgs: { duration: Number(p[0] || 1) } }];
  // XP's Memorize/Restore covers the BGM and the BGS together (MV's 243/244 only the BGM).
  if (command.code === 247) return [{ saveBgm: 'both' }];
  if (command.code === 248) return [{ resumeBgm: 'both' }];
  if (command.code === 249) {
    const me = audioParams(p[0]);
    return me ? [{ me }] : [];
  }
  if (command.code === 250) {
    const se = audioParams(p[0]);
    return se ? [{ sound: se }] : [];
  }
  if (command.code === 251) return [{ stopSound: true }];
  // 313/315-319 (state/EXP/level/params/skills/equipment) are command_dummy
  // no-ops in the shipped engine, so doing nothing is faithful. 314 heals the
  // party only when parameters[0] is 0; any other target is a no-op in the
  // engine too. VX actor commands are real engine calls with unverified
  // layouts (except 314's party shape, shared below), so they stay loud.
  if (!isVxLike && (command.code === 313 || (command.code >= 315 && command.code <= 319))) return [];
  if (command.code === 314) return Number(p[0] || 0) === 0 ? [{ recoverAll: { scope: 0, actor: 0 } }] : [];
  // 509 steps are consumed structurally by 209 above; an orphaned one is data.
  // VX uses 505 continuations instead (consumed by its 205 block), so an
  // orphaned 509 there stays loud.
  if (command.code === 509 && !isVxLike) return [];
  // 212-216 have no handler in the shipped XP Interpreter at all, so dropping
  // them matches the engine; VX's interpreter likewise dispatches no 215/216
  // (its 212-214 convert for real above). Anything else unmapped is a real
  // gap: loud marker, never a skip.
  if ([212, 213, 214, 215, 216].includes(Number(command.code))) return [];
  return [unsupportedCommand(Number(command.code), 0, context.mapId, context.eventId)];
}

function classifyCommands(counts, supported, partial) {
  return Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), {
    count,
    status: supported.has(code) ? 'supported' : partial.has(code) ? 'partial' : 'unsupported'
  }]));
}

function buildCompatibilityReport(counts) {
  // T122: VX classifies against its own command set (tools/rgss-vx.mjs);
  // 111/122 promote exactly like XP's when the corpus used only mapped shapes.
  // T123: Ace shares VX's numbering, so it classifies against the Ace
  // re-export (identical content, honest source label).
  if (isVxLike) {
    const supported = new Set(isAce ? ACE_SUPPORTED : VX_SUPPORTED);
    const partial = new Set(isAce ? ACE_PARTIAL : VX_PARTIAL);
    if (!unsupportedBranchFallbacks.size) { partial.delete(111); supported.add(111); }
    if (!unsupportedOperandFallbacks.size) { partial.delete(122); supported.add(122); }
    return classifyCommands(counts, supported, partial);
  }
  const supported = new Set([
    0, 101, 102, 103, 104, 105, 106, 108, 112, 113, 115, 116, 117, 118, 119, 121,
    126, 127, 128, 129, 201, 203, 208, 209, 210, 221, 222, 223, 224, 225, 231, 232,
    234, 235, 241, 242, 245, 246, 247, 248, 249, 250, 251, 313, 314, 315, 316, 317, 318, 319, 355,
    301, 401, 402, 403, 404, 405, 408,
    411, 412, 413, 509, 601, 602, 603, 604, 655
  ]);
  // Every classification below is verified against the Interpreter section of
  // the shipped scripts, not guessed from MV's numbering: 111 is partial (only
  // switch, all variable comparison operators, and self-switch branches map;
  // timer/actor/other non-switch conditions convert to an explicit unsupported
  // marker the player warns on instead of dropping the branch),
  // 116/313/315-319 are
  // supported no-ops-or-erase (116 erases the running event; the rest are
  // command_dummy in the engine itself, as is 314 with a nonzero target),
  // 126-128 convert to changeItem/changeWeapon/changeArmor and 129 to changeParty,
  // 122 partial (constant/variable/random operands with set/add/subtract/
  // multiply/divide/modulo map; kind 6 player x/y and kind 7 map id, party
  // size, and money map onto game-data operands; anything else converts to
  // loud unsupported markers instead of vanishing),
  // 123 partial (needs
  // map/event context), 125 partial (variable gold reuses MV's amount shape),
  // 201/202 support direct and variable designations; event-exchange 202
  // designations remain unsupported. 204 partial (panorama
  // and fog render; battleback is retained as metadata), 205 dropped (fog
  // tone), 208 supported (player transparency via setTransparent),
  // 210 supported no-op (sequential execution satisfies the wait),
  // 231/232 partial (direct appointments only; blend mode unmapped),
  // 233 dropped (no vocabulary entry), 236 dropped (weather, not rendered),
  // 103/104 supported (number input and message options), 212/213/214/
  // 215/216 dropped (no handler in the shipped Interpreter at all).
  const partial = new Set([111, 122, 123, 125, 202, 204, 231, 232, 234]);
  // Like MV, 111/122 promote to supported when the corpus used only mapped
  // shapes: the fallback maps above stay empty and no manifest carries markers.
  if (!unsupportedBranchFallbacks.size) { partial.delete(111); supported.add(111); }
  if (!unsupportedOperandFallbacks.size) { partial.delete(122); supported.add(122); }
  return classifyCommands(counts, supported, partial);
}

const mapInfoHash = decodeMarshal(await readFile(dataFile('MapInfos')));
// Common events inline into pages at code 117 like MV's; normalize once here so
// pages share the same { code, indent, parameters } shape the parser consumes.
for (const entry of decodeMarshal(await readFile(dataFile('CommonEvents')))) {
  if (!entry) continue;
  commonEvents.set(Number(field(entry, 'id', 0)), field(entry, 'list', []).map(item => ({
    code: field(item, 'code', 0),
    indent: Number(field(item, 'indent', 0)),
    parameters: field(item, 'parameters', [])
  })));
}
// VX has no Tilesets database and maps carry no tileset_id: one global
// tileset (Graphics/System/TileA1..A5, TileB..E, copied to img/tilesets
// below). Passage flags have no database source, so the manifest carries
// none and conversion warns loudly; movement stays unclamped until the
// source is found (see T122).
// Ace does ship Tilesets.rvdata2: one entry per database tileset with its
// sheet names and passage flags (assumed RPG::Tileset shape, see
// tools/rgss-ace.mjs); a missing table falls back to VX's posture loudly.
let tilesets;
if (isVx) {
  tilesets = [{ id: 0, tilesetNames: [...VX_TILESET_SHEETS], autotileNames: [],
    flags: [], priorities: [], terrainTags: [], global: true }];
  console.warn('MWGP convert: VX tile passage flags have no database source; the manifest carries empty flags and every tile reads as passable');
} else if (isAce) {
  let records = null;
  try { records = decodeMarshal(await readFile(dataFile('Tilesets'))); }
  catch { records = null; }
  if (!Array.isArray(records) || !records.some(Boolean)) {
    console.warn('MWGP convert: Ace Tilesets.rvdata2 is missing or empty; the manifest carries one global tileset with empty flags and every tile reads as passable');
    records = null;
  }
  tilesets = records
    ? records.map((value, index) => value ? aceTilesetEntry(value, index, tableData, message => console.warn(`MWGP convert: ${message}`)) : null)
    : [{ id: 0, tilesetNames: [...VX_TILESET_SHEETS], autotileNames: [], flags: [], priorities: [], terrainTags: [], global: true }];
} else {
  const tilesetData = decodeMarshal(await readFile(dataFile('Tilesets')));
  tilesets = tilesetData.map((value, index) => value ? {
    id: index,
    tilesetNames: [null, null, null, null, null, field(value, 'tileset_name', '')],
    autotileNames: field(value, 'autotile_names', []).map(name => name || null),
    // XP's passages table already uses MV's flag convention (verified against the
    // shipped scripts: Game_Map#passable? blocks when `passage & bit != 0` with
    // the same down/left/right/up = 0x01/0x02/0x04/0x08 bits the player tests),
    // so it passes through unchanged.
    flags: tableData(field(value, 'passages', null)),
    priorities: tableData(field(value, 'priorities', null)),
    terrainTags: tableData(field(value, 'terrain_tags', null))
  } : null);
}
// The game's own Ruby library is indexed before events convert: its Interpreter methods
// decide how bare calls in event snippets are compiled (as `this.<name>()`).
phase.end();
phase = progress.phase('indexing the game scripts', 8);
const rubyScripts = libraryDepth ? await readRgssScripts(dataDir).catch(error => { console.warn(`MWGP convert: cannot read Scripts${dataExt} (${error.message}); event scripts run without the game library`); return []; }) : [];
const libraryIndex = rubyScripts.length ? indexScripts(rubyScripts, message => console.warn(`MWGP convert: ${message}`)) : null;
setInterpreterMethods(libraryIndex?.interpreterMethods);
if (libraryIndex) setKnownMethods(libraryIndex.allDefNames);
const maps = [];
let shadowWarned = false;
const mapFiles = (await readdir(dataDir)).filter(item => /^Map\d+/i.test(item) && item.toLowerCase().endsWith(dataExt)).sort();
phase.end();
phase = progress.phase('maps', 10, mapFiles.length);
for (const name of mapFiles) {
  const sourceMap = decodeMarshal(await readFile(join(dataDir, name)));
  const width = Number(field(sourceMap, 'width', 0)), height = Number(field(sourceMap, 'height', 0));
  const table = parseTable(field(sourceMap, 'data', {}));
  const tableLayer = layer => Array.from({ length: width * height }, (_, index) => table.data[layer * width * height + index] || 0);
  // VX Tables are width x height x 3 (lower, upper, shadow): the two tile
  // layers land on MV layers 0 and 4 (characters render between them); the
  // shadow mask has no player rendering and is dropped loudly when used.
  // Tile ids are already in MV's number space (VX introduced the layout).
  let layers;
  if (isVxLike) {
    const empty = Array.from({ length: width * height }, () => 0);
    layers = [tableLayer(0), empty, empty, empty, tableLayer(1), empty];
    if (!shadowWarned && tableLayer(2).some(tile => tile)) {
      shadowWarned = true;
      console.warn('MWGP convert: VX shadow-layer tiles are dropped; the player renders no shadows');
    }
  } else {
    layers = Array.from({ length: 6 }, (_, layer) => tableLayer(layer));
  }
  const events = field(sourceMap, 'events', new Map());
  const id = Number(name.match(/\d+/)[0]);
  const mwgEvents = [...events.values()].map(event => convertEvent(event, id));
  const bgm = field(sourceMap, 'bgm', null);
  const bgs = field(sourceMap, 'bgs', null);
  // VX MapInfo unwraps to {@name, ...} ivars; surface a clean {name} like the
  // player (save labels) and the map index (stub names) read.
  const mapInfo = isVxLike
    ? { name: String(field(unwrap(mapInfoHash.get(id)), 'name', '') || '') }
    : unwrap(mapInfoHash.get(id)) || null;
  maps.push({ id, info: mapInfo, data: {
    width, height, data: layers.flat(), tilesetId: isVx ? 0 : Number(field(sourceMap, 'tileset_id', 0)),
    autoplayBgm: Boolean(field(sourceMap, 'autoplay_bgm', false)),
    bgm: bgm ? { name: field(bgm, 'name', ''), volume: Number(field(bgm, 'volume', 100)), pitch: Number(field(bgm, 'pitch', 100)) } : null,
    autoplayBgs: Boolean(field(sourceMap, 'autoplay_bgs', false)),
    bgs: bgs ? { name: field(bgs, 'name', ''), volume: Number(field(bgs, 'volume', 100)), pitch: Number(field(bgs, 'pitch', 100)) } : null,
    settings: {
      panoramaName: String(field(sourceMap, 'panorama_name', '') || ''), panoramaHue: Number(field(sourceMap, 'panorama_hue', 0) || 0),
      fogName: String(field(sourceMap, 'fog_name', '') || ''), fogHue: Number(field(sourceMap, 'fog_hue', 0) || 0), fogOpacity: Number(field(sourceMap, 'fog_opacity', 0) || 0),
      fogBlendType: Number(field(sourceMap, 'fog_blend_type', 0) || 0), fogZoom: Number(field(sourceMap, 'fog_zoom', 100) || 100), fogSx: Number(field(sourceMap, 'fog_sx', 0) || 0), fogSy: Number(field(sourceMap, 'fog_sy', 0) || 0)
    }
  }, mwgEvents });
  phase.tick(`map ${id}`);
}

async function copyTree(input, destination) {
  if (!existsSync(input)) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(input, { withFileTypes: true })) {
    const from = join(input, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else { await writeFile(to, await readFile(from)); phase.tick(entry.name); }
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1), 0);
}

// The engine's own title screen: XP draws Graphics/Titles/<System title_name>, VX Graphics/System/Title, Ace
// Graphics/Titles1/<title1_name> under Graphics/Titles2/<title2_name> (plus the game title while opt_draw_title).
// The art is copied where the player's stock title reads it (img/titles1, img/titles2).
async function buildStockTitle() {
  const layers = isAce
    ? [['titles1', 'Titles1', field(system, 'title1_name', '')], ['titles2', 'Titles2', field(system, 'title2_name', '')]]
    : [['titles1', isVx ? 'System' : 'Titles', isVx ? 'Title' : field(system, 'title_name', '')]];
  const names = {};
  for (const [kind, folder, name] of layers) {
    if (!name) continue;
    const file = join(source, 'Graphics', folder, `${name}.png`);
    if (!existsSync(file)) { console.warn(`MWGP convert: title image Graphics/${folder}/${name}.png is not in the project; the title shows without it`); continue; }
    await mkdir(join(output, 'assets', 'img', kind), { recursive: true });
    await writeFile(join(output, 'assets', 'img', kind, `${name}.png`), await readFile(file));
    names[kind] = String(name);
  }
  if (!names.titles1 && !names.titles2) return null;
  return {
    title1: names.titles1 || '', title2: names.titles2 || '',
    drawTitle: isAce ? field(system, 'opt_draw_title', true) !== false : false,
    commandOffset: { x: 0, y: 0 }, commands: { newGame: true, continue: true, options: true },
    assets: { root: 'assets', kind: 'decoded' }
  };
}

// The game's title: System's game_title where the engine has one (VX/Ace), else Game.ini's `Title=` (where XP keeps it).
function gameTitle() {
  const fromSystem = String(field(system, 'game_title', '') || '').trim();
  if (fromSystem) return fromSystem;
  const ini = join(source, 'Game.ini');
  const fromIni = existsSync(ini) ? (readFileSync(ini, 'utf8').match(/^\s*Title\s*=\s*(.*?)\s*$/mi) || [])[1] : '';
  return fromIni || `Untitled ${ENGINE_LABEL} game`;
}

// The screen size the game sets itself (`Graphics.resize_screen(w, h)`) when both arguments are numbers or constants
// the scripts assign a number; otherwise the engine default (XP 640x480, VX/Ace 544x416).
function scriptScreenSize() {
  const sources = (rubyScripts || []).map(entry => String(entry.source || ''));
  const constant = name => {
    for (const text of sources) { const found = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*(?:#.*)?$`, 'm')); if (found) return Number(found[1]); }
    return NaN;
  };
  const value = arg => /^\d+$/.test(arg) ? Number(arg) : /^[A-Z][\w:]*$/.test(arg) ? constant(arg.split('::').pop()) : NaN;
  for (const text of sources) {
    for (const call of text.matchAll(/Graphics\.resize_screen\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g)) {
      const width = value(call[1]), height = value(call[2]);
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return isVxLike ? { width: 544, height: 416 } : { width: 640, height: 480 };
}

phase.end();
phase = progress.phase('copying graphics and audio', 10, ['Characters', 'Tilesets', 'Pictures'].reduce((sum, folder) => sum + countFiles(join(source, 'Graphics', folder)), 0)
  + countFiles(join(source, 'Graphics')) + countFiles(join(source, 'Fonts')) + countFiles(join(source, 'Audio')));
await mkdir(output, { recursive: true });
await copyTree(join(source, 'Graphics', 'Characters'), join(output, 'assets', 'img', 'characters'));
await copyTree(join(source, 'Graphics', 'Tilesets'), join(output, 'assets', 'img', 'tilesets'));
// VX's global tileset lives as loose sheets under Graphics/System.
if (isVx) {
  for (const sheet of VX_TILESET_SHEETS) {
    const sheetFile = join(vxSystemDir, `${sheet}.png`);
    if (!existsSync(sheetFile)) continue;
    await mkdir(join(output, 'assets', 'img', 'tilesets'), { recursive: true });
    await writeFile(join(output, 'assets', 'img', 'tilesets', `${sheet}.png`), await readFile(sheetFile));
  }
}
await copyTree(join(source, 'Graphics', 'Pictures'), join(output, 'assets', 'img', 'pictures'));
await copyTree(join(source, 'Graphics'), join(output, 'assets', 'graphics'));
if (existsSync(join(source, 'Fonts'))) await copyTree(join(source, 'Fonts'), join(output, 'assets', 'fonts'));
// Audio/BGM, Audio/bgm, ... -> assets/audio/<lowercase kind>: the player and the server address
// audio by lowercase kind, and only Windows treats the case variants as one directory.
if (existsSync(join(source, 'Audio'))) {
  for (const entry of await readdir(join(source, 'Audio'), { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(source, 'Audio', entry.name), join(output, 'assets', 'audio', entry.name.toLowerCase()));
  }
}
const system =decodeMarshal(await readFile(dataFile('System')));
const characterDir = join(source, 'Graphics', 'Characters');
const characterFiles = new Map();
if (existsSync(characterDir)) {
  for (const name of await readdir(characterDir)) {
    if (!/\.png$/i.test(name)) continue;
    const dimensions = pngDimensions(await readFile(join(characterDir, name)));
    if (dimensions) characterFiles.set(name.replace(/\.png$/i, ''), dimensions);
  }
}
const characterFrames = Object.fromEntries([...characterFiles].map(([name, dimensions]) => [name, {
  // RGSS character sheets are four columns and four directional rows. The
  // dimensions are read from the actual PNG, so Essentials' 64px sheets and
  // custom-sized object sheets both retain their authored geometry. VX sheets
  // are eight 3x4 characters (four across, two down): the 'vx' format selects
  // the player's MV-style cell math for that layout.
  ...(isVxLike
    ? { format: 'vx', fw: dimensions.width / 12, fh: dimensions.height / 8 }
    : { format: 'xp', fw: dimensions.width / 4, fh: dimensions.height / 4 }),
  big: false,
  object: false
}]));
// The player's look is the start party's first actor's charset, from the Actors table (XP sheets hold one
// character, VX/Ace sheets eight: character_index picks one).
function resolveStartActorSprite() {
  const party = field(system, 'party_members', []);
  const actorId = Array.isArray(party) ? Number(party[0] || 0) : 0;
  if (!actorId) return null;
  let actors = null;
  try { actors = decodeMarshal(readFileSync(dataFile('Actors'))); } catch { return null; }
  const actor = (Array.isArray(actors) ? actors : []).find(entry => Number(field(entry, 'id', 0)) === actorId);
  const name = String(field(actor, 'character_name', '') || '');
  if (!name || !characterFiles.has(name)) return null;
  return { name, index: isVxLike ? Math.max(0, Math.min(7, Number(field(actor, 'character_index', 0)))) : 0, source: 'start-actor' };
}
const playerSprite = resolveStartActorSprite();
const startMapId = Number(field(system, 'start_map_id', 0));
// VX tile ids live in MV's number space (A tiles at 1536+), so the
// has-content fallback looks there instead of XP's static base.
const initialMap = maps.find(map => map.id === startMapId)
  || maps.find(map => map.data.data.some(tile => tile >= (isVxLike ? 1536 : XP_STATIC_TILE_BASE))) || maps[0];
const assetAvailability = {
  tilesets: existsSync(join(source, 'Graphics', 'Tilesets')) || (isVxLike && VX_TILESET_SHEETS.every(sheet => existsSync(join(vxSystemDir, `${sheet}.png`)))),
  autotiles: existsSync(join(source, 'Graphics', 'Autotiles')),
  characters: existsSync(join(source, 'Graphics', 'Characters')),
  pictures: existsSync(join(source, 'Graphics', 'Pictures')),
  audio: existsSync(join(source, 'Audio'))
};
phase.end();
phase = progress.phase('selecting the Ruby library', 0);
let libraryPhase = null;
const rubyLibrary = libraryIndex
  ? await buildRgssLibrary(rubyScripts, [...scriptStats.sources], { index: libraryIndex, maxDepth: libraryDepth, log: message => console.log(`MWGP convert: ${message}`),
    onUnit: ({ name, size, totalSize }) => { libraryPhase ||= progress.phase('transpiling the Ruby library', 50, totalSize); libraryPhase.tick(name, size); } })
  : null;
(libraryPhase || progress.phase('transpiling the Ruby library', 50)).end();
phase = progress.phase('lifting blocking code to async', 8);
// Blocking screens (`loop { Graphics.update ... }`): units and Call Script snippets that wait on frames become async.
let asyncLift = null;
if (rubyLibrary) {
  const snippetCommands = [];
  (function collect(value) {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if (typeof value.script === 'string' && typeof value.js === 'string') snippetCommands.push(value);
      for (const key of Object.keys(value)) if (typeof value[key] === 'object') collect(value[key]);
    }
  })(maps.map(map => map.mwgEvents));
  const lifted = liftBlocking(rubyLibrary.units, snippetCommands.map(command => ({ js: command.js })), { knownMethods: rubyLibrary.methods, callModules: libraryIndex?.typeConsts });
  rubyLibrary.units = lifted.units;
  snippetCommands.forEach((command, index) => { command.js = lifted.snippets[index].js; if (lifted.snippets[index].async) command.async = true; });
  rubyLibrary.asyncNames = lifted.names;
  asyncLift = lifted.report;
  console.log(`MWGP convert: async lift: ${asyncLift.functions} function(s) async, ${asyncLift.awaits} call(s) awaited, ${lifted.names.length} blocking name(s)${asyncLift.unawaited ? `, ${asyncLift.unawaited} call(s) left sync (constructors/callbacks)` : ''}${asyncLift.unparsed.length ? `, ${asyncLift.unparsed.length} source(s) unparsed` : ''}`);
}
phase.end();
phase = progress.phase('exporting game data', 5);
// The game's Marshal data files (Essentials' GameData registries, message tables, ...) as assets the runtime loads.
const rubyDataFiles = await exportRubyData(dataDir, join(output, 'assets', 'ruby-data'), decodeMarshal, message => console.warn(`MWGP convert: ${message}`));
if (rubyDataFiles.length) console.log(`MWGP convert: ${rubyDataFiles.length} Data/*.dat file(s) exported for load_data and the GameData registries`);
const fileIndex = await buildFileIndex(source);
const textFiles = await readTextFiles(source, fileIndex);
phase.end();
phase = progress.phase('converting the database', 2);
const libraryFailures = Object.entries(rubyLibrary?.failed || {}).map(([name, error]) => ({ name, error }));
const libraryPartials = Object.entries(rubyLibrary?.partial || {}).map(([name, detail]) => ({ name, ...detail }));
// The database mapper reads XP-shaped tables (stat names, rank curves);
// VX's flat fields and Table curves are not mapped, so VX manifests ship
// database {} (dialogue-duel battles, minimal menu) like the placeholder path.
const xpDatabase = isVxLike ? null : await convertRgssDatabase(dataDir, decodeMarshal, { system, convertTroopCommands: (list, context) => convertCommands(list, context) }).catch(error => { console.warn(`MWGP convert: cannot convert the RPG database (${error.message}); battles use the dialogue duel`); return null; });
if (isVxLike) console.warn(`MWGP convert: the ${ENGINE_LABEL} database is not mapped to MV-shaped tables yet; battles use the dialogue duel and the menu stays minimal`);
if (xpDatabase) console.log(`MWGP convert: database ${xpDatabase.actors.length - 1} actors, ${xpDatabase.enemies.length - 1} enemies, ${xpDatabase.troops.length - 1} troops, ${xpDatabase.skills.length - 1} skills`);
// VX/Ace start party comes straight from System (the database mapper is skipped).
const vxParty = isVxLike && Array.isArray(field(system, 'party_members', [])) ? field(system, 'party_members', []).map(Number).filter(id => id > 0) : [];
const titleScreen = await buildStockTitle();
phase.end();
phase = progress.phase('writing the manifest', 5);
const screenSize = scriptScreenSize();
const manifest = {
  format: 'MWGP', version: 1,
  source: { engine: isAce ? ENGINE_ACE : isVx ? ENGINE_VX : 'rpg-maker-xp', projectName: output.split(/[\\/]/).pop(), convertedAt: new Date().toISOString() },
  display: { title: gameTitle(), width: screenSize.width, height: screenSize.height, tileSize: VX_TILE_SIZE },
  initialMapId: initialMap?.id || null,
  player: initialMap ? { mapId: initialMap.id, x: Number(field(system, 'start_x', 0)), y: Number(field(system, 'start_y', 0)) } : null,
  tilesetFormat: isAce ? { engine: ENGINE_ACE } : isVx ? { engine: ENGINE_VX } : { engine: 'rpg-maker-xp', autotilePatternCount: XP_AUTOTILE_PATTERNS, autotileImageCount: XP_AUTOTILE_IMAGES, staticTileBase: XP_STATIC_TILE_BASE },
  assets: { root: 'assets', kind: 'decoded', ...assetAvailability, faces: false, encryption: isVxLike ? 'loose-files' : 'rgssad-extracted' },
  tilesets, playerSprite, characterFrames, plugins: [], compatibility: { source: isAce ? ENGINE_ACE : isVx ? ENGINE_VX : 'rpg-maker-xp', commands: buildCompatibilityReport(commandCounts), scripts: { total: scriptStats.total, transpiled: scriptStats.transpiled, failed: [...scriptStats.failed].map(([ruby, error]) => ({ ruby: ruby.slice(0, 200), error })), libraryFailed: libraryFailures, libraryPartial: libraryPartials } }, maps, database: xpDatabase || {},
  ...(xpDatabase ? { initialParty: xpDatabase.system.partyMembers } : {}),
  ...(vxParty.length ? { initialParty: vxParty } : {}),
  ...(fileIndex.length ? { fileIndex } : {}),
  ...(Object.keys(textFiles).length ? { textFiles } : {}),
  ...(rubyDataFiles.length ? { rubyData: { root: 'ruby-data', files: rubyDataFiles } } : {}),
  ...(rubyLibrary ? { rubyLibrary } : {}),
  ...(titleScreen ? { titleScreen } : {})
};
// Audio the engine plays itself (title/battle music, jingles, system sound effects) and the
// index of what really exists on disk, in whatever formats the project ships.
{
  const audioRoot = join(output, 'assets', 'audio');
  if (existsSync(audioRoot)) {
    const track = key => audioParams(field(system, key, null));
    // VX System keeps the twelve UI sounds in a positional array (same slots
    // the XP converter reads as named keys); flat keys win when both exist.
    const vxSounds = isVxLike && Array.isArray(field(system, 'sounds', [])) ? field(system, 'sounds', []) : [];
    const sounds = Object.fromEntries([['cursor', 'cursor_se'], ['ok', 'decision_se'], ['cancel', 'cancel_se'], ['buzzer', 'buzzer_se'], ['equip', 'equip_se'], ['shop', 'shop_se'],
      ['save', 'save_se'], ['load', 'load_se'], ['battleStart', 'battle_start_se'], ['escape', 'escape_se'], ['actorCollapse', 'actor_collapse_se'], ['enemyCollapse', 'enemy_collapse_se']]
      .map(([name, key], index) => [name, track(key) || audioParams(vxSounds[index])]).filter(([, value]) => value));
    // MIDI music sounds far better with a SoundFont: `--soundfont <file>`, else the project's own .sf2.
    const flagged = flags.indexOf('--soundfont') >= 0 ? flags[flags.indexOf('--soundfont') + 1] : null;
    const found = flagged || (await readdir(source)).find(name => /\.sf2$/i.test(name));
    const soundfontPath = found ? (existsSync(found) ? found : join(source, found)) : null;
    if (soundfontPath && existsSync(soundfontPath)) await writeFile(join(audioRoot, 'soundfont.sf2'), await readFile(soundfontPath));
    manifest.audio = { soundfont: soundfontPath && existsSync(soundfontPath) ? 'soundfont.sf2' : null, index: buildAudioIndex(audioRoot), system: { titleBgm: track('title_bgm'), battleBgm: track('battle_bgm'), victoryMe: track('battle_end_me'), gameoverMe: track('gameover_me'), vehicles: {}, sounds } };
  }
}
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest, null, 2));
phase.end();
console.log(`Event scripts: ${scriptStats.transpiled}/${scriptStats.total} transpiled to JS${scriptStats.failed.size ? `, ${scriptStats.failed.size} unique failed (see compatibility.scripts.failed)` : ''}`);
console.log(`Converted ${maps.length} ${ENGINE_LABEL} maps to ${join(output, 'mwgp.json')}`);
for (const [fallbacks, label] of [[unsupportedCommandFallbacks, 'event command'], [unsupportedBranchFallbacks, '111 branch type'], [unsupportedOperandFallbacks, '122 operand']]) {
  for (const [key, info] of [...fallbacks].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    if (info.count > 1) console.warn(`MWGP convert: ${ENGINE_LABEL} ${label} ${key} fell back ${info.count} times (first at ${info.first}); every site is marked unsupported in the manifest`);
  }
}
