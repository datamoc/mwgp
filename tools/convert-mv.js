import { CONVERTER_VERSION } from './converter-version.mjs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { buildPluginLibrary, externalizePluginLibrary } from './mv-plugins.mjs';
import { buildAudioIndex, missingAudio } from './audio-index.mjs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { createProgress } from './progress.mjs';

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg || !outputArg) {
  console.error('Usage: node tools/convert-mv.js <RPGM project> <MWGP output>');
  process.exit(1);
}

// Progress points (tools/progress.mjs): asset decoding dominates a --copy-assets run.
const progress = createProgress();
let phase = progress.phase('reading the database', 2);
const source = resolve(sourceArg);
const gameRoot = resolveGameRoot(source);
const engineKind = existsSync(join(gameRoot, 'js', 'rmmz_core.js')) ? 'rpg-maker-mz' : 'rpg-maker-mv';
const dataDir = join(gameRoot, 'data');
const output = resolve(outputArg);
const copyAssets = process.argv.includes('--copy-assets');
const copyTilesets = copyAssets || process.argv.includes('--copy-tilesets');
const copyCharacters = copyAssets || process.argv.includes('--copy-characters');
const copyFaces = copyAssets || process.argv.includes('--copy-faces');
const copyPictures = copyAssets || process.argv.includes('--copy-pictures');
const copyAudio = copyAssets || process.argv.includes('--copy-audio');
// Some MV projects keep dialogue in sidecar localization tables instead of
// the event list: plugins resolve `\CODE[key]` text codes against JSON files
// under www/loc/ whose entries look like `{ "key": { "text": ["line", ...] } }`.
// The converter discovers those tables generically (no plugin or game names):
// a non-standard escape code is looked up in the table whose file name best
// matches the code (e.g. code `ABC_MAP` -> `AbcMap_EN.json`), else in any table
// holding the key. Entry lines join with newlines. Unresolvable codes stay literal
// (loud, MV-faithful) with one warning. Only active when loc/*.json exist.
const BUILTIN_TEXT_CODES = new Set(['V', 'N', 'P', 'C', 'I', 'PN', 'FS', 'FN', 'FB', 'FI']);
const textTables = (() => {
  const tables = [];
  const dir = join(gameRoot, 'loc');
  if (!existsSync(dir)) return tables;
  for (const file of readdirSync(dir).filter(name => /\.json$/i.test(name))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8').replace(/^﻿/, ''));
      if (data && typeof data === 'object' && Object.values(data).some(entry => Array.isArray(entry?.text))) {
        tables.push({ file, tag: file.replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9]/g, ''), data });
      }
    } catch (error) { console.warn(`MWGP convert: unreadable text table ${file}: ${error.message}`); }
  }
  if (tables.length) console.log(`MWGP convert: text tables available: ${tables.map(table => table.file).join(', ')}`);
  return tables;
})();
const missingTextKeys = new Set();
function lookupTextTable(code, key) {
  const tag = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  const holders = textTables.filter(table => Array.isArray(table.data[key]?.text));
  return (holders.find(table => table.tag.startsWith(tag) || tag.startsWith(table.tag)) || holders[0])?.data[key];
}
function resolveTextTables(text) {
  if (!text || !textTables.length || !text.includes('\\')) return text;
  // The engine re-runs escape conversion over substituted text, so nested
  // codes resolve too; the cap only bounds malformed self-referential tables.
  for (let round = 0; round < 5; round++) {
    let changed = false;
    text = text.replace(/\\([A-Za-z][A-Za-z0-9_]*)\[(\w+)\]/g, (match, code, key) => {
      if (BUILTIN_TEXT_CODES.has(code.toUpperCase())) return match;
      const entry = lookupTextTable(code, key);
      if (!entry) {
        if (!missingTextKeys.has(match)) { missingTextKeys.add(match); console.warn(`MWGP convert: no text-table entry for ${match}; leaving it literal`); }
        return match;
      }
      changed = true;
      return entry.text.join('\n');
    });
    if (!changed) break;
  }
  return text;
}
const commandCounts = new Map();
// Fallback counters must initialize before the map loop below runs (top-level
// execution order): the converters call them during conversion.
const unsupportedBranchFallbacks = new Map();
const unsupportedOperandFallbacks = new Map();
const unsupportedCommandFallbacks = new Map();
// Operation names shared by the constant/variable/random 122 path and the
// extended operands ('set' is new: the engine's operateVariable case 0).
const OPERATION_NAMES = ['set', 'add', 'subtract', 'multiply', 'divide', 'modulo'];
const characterNames = new Set();
const scriptSources = new Set();
const pictureNames = new Set();
const foregroundNames = new Set();
const soundNames = new Set();
const musicNames = new Set();
const animationIds = new Set();
const meNames = new Set();
const movieNames = new Set();
const battlebackNames = { 1: new Set(), 2: new Set() };
const systemAudioReferences = [];
let balloonUsed = false;
// MV encrypts assets under a distinct extension (.rpgmvp/.rpgmvo/.rpgmvm); MZ instead
// appends an underscore to the original extension (.png_/.ogg_/.m4a_). Both use the
// same 16-byte XOR header scheme once identified.
const ENCRYPTED_EXTENSION = /\.rpgmvp$|\.rpgmvo$|\.rpgmvm$|\.png_$|\.ogg_$|\.m4a_$/i;

function resolveGameRoot(projectDir) {
  // MV projects nest the game under www/; MZ projects (and some MV web exports)
  // put index.html/data/js directly at the project root.
  if (existsSync(join(projectDir, 'www', 'index.html'))) return join(projectDir, 'www');
  if (existsSync(join(projectDir, 'index.html'))) return projectDir;
  throw new Error(`Could not find index.html under ${projectDir} or ${projectDir}/www`);
}

async function readJson(name, optional = false) {
  const path = join(dataDir, name);
  if (!existsSync(path)) {
    if (optional) return null;
    throw new Error(`Missing RPG Maker data file: ${path}`);
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

const system = await readJson('System.json');
// Audio the engine itself plays (title/battle music, jingles, the 24 system sound effects, vehicle
// music) never appears in an event command, so it is collected from System.json. Same field names
// in MV and MZ.
const SYSTEM_SOUND_KEYS = ['cursor', 'ok', 'cancel', 'buzzer', 'equip', 'save', 'load', 'battleStart', 'escape', 'enemyAttack', 'enemyDamage',
  'enemyCollapse', 'bossCollapse1', 'bossCollapse2', 'actorDamage', 'actorCollapse', 'recovery', 'miss', 'evasion', 'magicEvasion', 'magicReflection',
  'shop', 'useItem', 'useSkill'];
const audioParams = entry => entry?.name ? { name: String(entry.name), volume: Number(entry.volume ?? 90), pitch: Number(entry.pitch ?? 100), pan: Number(entry.pan || 0) } : null;
const systemAudio = {
  titleBgm: audioParams(system.titleBgm), battleBgm: audioParams(system.battleBgm),
  victoryMe: audioParams(system.victoryMe), defeatMe: audioParams(system.defeatMe), gameoverMe: audioParams(system.gameoverMe),
  vehicles: Object.fromEntries(['boat', 'ship', 'airship'].map(key => [key, audioParams(system[key]?.bgm)]).filter(([, value]) => value)),
  sounds: Object.fromEntries(SYSTEM_SOUND_KEYS.map((key, index) => [key, audioParams(system.sounds?.[index])]).filter(([, value]) => value))
};
const titleAssetsAvailable = existsSync(join(gameRoot, 'img', 'titles1')) || existsSync(join(gameRoot, 'img', 'titles2'));
const mapInfos = await readJson('MapInfos.json');
const commonEvents = await readJson('CommonEvents.json', true) || [];
// Plugin-command families at source level (pre-inline: inlining repeats one
// source call at every call site, so counting here is the honest priority
// list for what to convert next). Reported once at the end, below.
const pluginFamilyCounts = new Map();
// Roots for the plugin library: the MV 356 command words and the plugins MZ 357 commands name.
const pluginCommandWords = new Set();
const pluginCommandPlugins = new Set();
// MZ 357 command name -> the plugin that registers it, for the compatibility report.
const mzCommandPlugin = new Map();
function tallyPluginCommand(command) {
  // MZ tallies under the command name, like MV 356's first word.
  if (command?.code === 357 && Array.isArray(command.parameters)) {
    const name = String(command.parameters[1] || command.parameters[0] || '').trim() || '(empty)';
    const plugin = String(command.parameters[0] || '').trim();
    if (plugin) { pluginCommandPlugins.add(plugin); mzCommandPlugin.set(name, plugin); }
    pluginFamilyCounts.set(name, (pluginFamilyCounts.get(name) || 0) + 1);
    return;
  }
  if (command?.code !== 356 || !command.parameters?.[0]) return;
  const name = String(command.parameters[0]).trim().split(/\s+/)[0] || '(empty)';
  pluginCommandWords.add(name);
  pluginFamilyCounts.set(name, (pluginFamilyCounts.get(name) || 0) + 1);
}
for (const commonEvent of commonEvents) for (const command of commonEvent?.list || []) {
  commandCounts.set(command.code, (commandCounts.get(command.code) || 0) + 1);
  tallyPluginCommand(command);
}
function normalizeMZMapData(data) {
  const expected = Math.max(0, Number(data.width) * Number(data.height) * 6);
  const source = Array.isArray(data.data) ? data.data : [];
  // MZ reads exactly six width-major layers. Some exported projects append
  // plugin data after those layers and may contain signed sentinel values;
  // the native Tilemap rejects those values as invisible tiles.
  data.data = Array.from({ length: expected }, (_, index) => {
    const tile = Number(source[index] ?? 0);
    return Number.isInteger(tile) && tile > 0 && tile < 8192 ? tile : 0;
  });
  return data;
}

// Foreground.js (Sasuke KANNAZUKI, ed. Remtairy) draws an over-map tiling
// layer from the map note, the same way $dataMap.meta reads it: <fgName:name>
// with <fgLoopX/Y>, <fgSx/Sy> and an optional <fgSwitch:N> gate, plus a second
// _b-suffixed layer with its own gate (<fgSwitch_b:N>) and hide-switches
// (<fgNotSwitch_b(:2):N>). Stored on data.settings next to the XP converter's
// map settings so the player reads one shape.
function parseForegroundLayer(note, suffix, switchTags) {
  const text = String(note || '');
  const tag = name => { const match = new RegExp(`<${name}${suffix}:([^>]+)>`).exec(text); return match ? match[1].trim() : ''; };
  const named = tagName => { const match = new RegExp(`<${tagName}:([^>]+)>`).exec(text); return match ? match[1].trim() : ''; };
  const name = tag('fgName');
  if (!name) return null;
  const num = raw => { const value = Number(raw); return raw !== '' && Number.isFinite(value) ? value : 0; };
  return {
    name, zero: name.startsWith('!'),
    loopX: text.includes(`<fgLoopX${suffix}:`), loopY: text.includes(`<fgLoopY${suffix}:`),
    sx: num(tag('fgSx')), sy: num(tag('fgSy')), switch: num(named(switchTags.on)),
    notSwitch: num(named(switchTags.off)), notSwitch2: num(named(switchTags.off2))
  };
}
function parseForegroundNote(note) {
  const primary = parseForegroundLayer(note, '', { on: 'fgSwitch', off: 'fgNotSwitch', off2: 'fgNotSwitch2' });
  const secondary = parseForegroundLayer(note, '_b', { on: 'fgSwitch_b', off: 'fgNotSwitch_b', off2: 'fgNotSwitch_b2' });
  if (!primary && !secondary) return null;
  return { ...(primary ? { foreground: primary } : {}), ...(secondary ? { foregroundB: secondary } : {}) };
}

const maps = [];
const mapFiles = readdirSync(dataDir).filter(name => /^Map\d+\.json$/i.test(name)).sort();
phase.end();
phase = progress.phase('maps', 20, mapFiles.length);
for (const name of mapFiles) {
  const id = Number(name.match(/\d+/)[0]);
  const data = await readJson(name);
  if (engineKind === 'rpg-maker-mz') normalizeMZMapData(data);
  if (data.bgm?.name) musicNames.add(data.bgm.name);
  if (data.bgs?.name) musicNames.add(data.bgs.name);
  // MV/MZ map parallax (map properties): the image is decoded from img/parallaxes like the foreground art.
  if (data.parallaxName) foregroundNames.add(String(data.parallaxName));
  const foreground = parseForegroundNote(data.note);
  if (foreground) {
    data.settings = { ...(data.settings || {}), ...foreground };
    for (const layer of [foreground.foreground, foreground.foregroundB]) if (layer) foregroundNames.add(layer.name);
  }
  for (const event of data.events || []) for (const page of event?.pages || []) for (const command of page.list || []) {
    commandCounts.set(command.code, (commandCounts.get(command.code) || 0) + 1);
    tallyPluginCommand(command);
  }
  maps.push({ id, info: mapInfos[id] || null, data, mwgEvents: data.events.filter(Boolean).map(event => convertEvent(event, id)) });
  phase.tick(`map ${id}`);
}
phase.end();
phase = progress.phase('common events and database', 3);

const configuredStartMap = maps.find(map => map.id === Number(system.startMapId));
// The configured start map may be an intentionally blank bootstrap map whose
// autorun transfers to the real opening scene (a mode selector is a common
// example). Never replace it merely because its tile data is empty.
const startMap = configuredStartMap
  || maps.find(map => map.data?.data?.some(tile => tile > 0))
  || null;
const convertedCommonEvents = Object.fromEntries(commonEvents
  .map((entry, id) => entry?.list ? [String(id), convertCommands(entry.list, { commonEventId: id })] : null)
  .filter(Boolean));

function convertEvent(event, mapId) {
  return { id: String(event.id), name: String(event.name || ''), x: event.x, y: event.y, pages: (event.pages || []).map(page => {
    // A labeled list converts to { story } instead of a flat array; the player
    // drives it with runStoryLoop (see runPage).
    const converted = convertCommands(page.list || [], { mapId, eventId: event.id });
    if (page.image?.characterName) characterNames.add(page.image.characterName);
    return {
      trigger: ['action', 'touch', 'touch', 'autorun', 'parallel'][page.trigger] || 'action',
      conditions: convertConditions(page.conditions, mapId, event.id),
      commands: Array.isArray(converted) ? converted : [],
      ...(converted.story ? { story: converted.story } : {}),
      through: page.through === true,
      priorityType: page.priorityType === 0 || page.priorityType === 2 ? page.priorityType : 1,
      image: page.image?.characterName ? { name: page.image.characterName, index: page.image.characterIndex || 0, direction: page.image.direction || 2, pattern: page.image.pattern || 1 } : null
    };
  }) };
}

// Self switches ('A'-'D') are a namespace keyed per map+event, distinct from the global
// switches array; we fold them into the same string-keyed switch space GameState already
// uses by prefixing the key, rather than teaching the runtime a second switch kind.
function selfSwitchKey(mapId, eventId, ch) {
  return `self:${mapId}:${eventId}:${ch}`;
}

// The JS is stored once, as `source` (the player wraps a condition in `return (...)`); only a
// syntax error is recorded here, so a broken script is reported at conversion time and stays
// a loud warning instead of throwing inside an event.
function syntaxError(body) {
  try { new Function(body); return {}; }
  catch (error) { return { error: String(error.message).slice(0, 160) }; }
}
function scriptBody(source) { scriptSources.add(source); return syntaxError(source); }
function conditionBody(source) { scriptSources.add(source); return syntaxError(`return (${source}\n);`); }

function convertConditions(conditions = {}, mapId, eventId) {
  const result = [];
  if (conditions.switch1Valid) result.push({ switch: String(conditions.switch1Id), equals: true });
  if (conditions.switch2Valid) result.push({ switch: String(conditions.switch2Id), equals: true });
  if (conditions.variableValid) result.push({ variable: String(conditions.variableId), atLeast: conditions.variableValue });
  if (conditions.selfSwitchValid) result.push({ switch: selfSwitchKey(mapId, eventId, conditions.selfSwitchCh || 'A'), equals: true });
  return result;
}

// MV's Jump to Label finds a label anywhere in the event list, including inside if/loop/choice
// blocks, and execution continues from there through the rest of that block and then whatever
// follows the enclosing blocks. The tree model cannot jump into a block, so each label nested
// in a block becomes its own passage holding exactly that continuation: the block's tail, then
// for each enclosing statement (innermost first) the loop again if it was a loop, then the
// commands after that statement, and finally the next top-level passage (sequential fall-through).
// Nested passages stay out of `order`, so they end instead of falling through a second time.
function addNestedLabelPassages(story, order) {
  const childArrays = command => {
    const arrays = [];
    for (const key of ['then', 'else', 'loop', 'cancelBranch']) if (Array.isArray(command[key])) arrays.push(command[key]);
    if (Array.isArray(command.branches)) for (const branch of command.branches) if (Array.isArray(branch)) arrays.push(branch);
    return arrays;
  };
  const nested = {};
  const build = (ancestors, array, index, topName) => {
    const tail = array.slice(index + 1);
    for (let level = ancestors.length - 1; level >= 0; level--) {
      const { array: parentArray, index: statementIndex, command } = ancestors[level];
      if (Array.isArray(command.loop)) tail.push(command);
      tail.push(...parentArray.slice(statementIndex + 1));
    }
    const next = order[order.indexOf(topName) + 1];
    if (next !== undefined) tail.push({ goto: next });
    return tail;
  };
  const visit = (array, ancestors, topName) => {
    array.forEach((command, index) => {
      if (command?.__label) {
        if (nested[command.__label] || story.passages[command.__label]) console.warn(`MWGP convert: duplicate label "${command.__label}"; later passage wins`);
        nested[command.__label] = build(ancestors, array, index, topName);
      }
      for (const child of childArrays(command || {})) visit(child, [...ancestors, { array, index, command }], topName);
    });
  };
  for (const name of [...order]) if (Array.isArray(story.passages[name])) visit(story.passages[name], [], name);
  if (!Object.keys(nested).length) return;
  const strip = array => {
    for (let index = array.length - 1; index >= 0; index--) if (array[index]?.__label) array.splice(index, 1);
    for (const command of array) for (const child of childArrays(command || {})) strip(child);
  };
  Object.assign(story.passages, nested);
  for (const array of Object.values(story.passages)) strip(array);
}

function convertCommands(list, context = {}) {
  const { mapId, eventId, depth = 0, stack = [] } = context;
  // Labels (118) split the top-level list into named story passages; jumps
  // (119) become { goto } markers the player's story driver follows. Labels
  // nested inside blocks are dropped with a warning: splitting there would
  // break the block structure, and no corpus project uses one.
  const story = { start: 'main', passages: {} };
  const order = ['main'];
  let current = 'main';
  // Inlined common events (depth > 0) must stay flat arrays for spreading, so
  // only page-level lists split into passages.
  const parsed = parseBlock(0, -1, depth === 0);
  story.passages[current] = parsed.commands;
  if (depth === 0) addNestedLabelPassages(story, order);
  if (Object.keys(story.passages).length > 1) return { story: { ...story, order } };
  return parsed.commands;

  // Terminators are recognised by (code, indent) alone, the same convention RPG Maker's own
  // indent-delimited list uses: whichever block is currently open decides what a terminator
  // at its own indent means (else/end-if, end-loop, or a choice/cancel boundary).
  function parseBlock(start, parentIndent, topLevel = false) {
    let result = [];
    let index = start;
    let portrait;
    while (index < list.length) {
      const command = list[index];
      if ([402, 403, 404, 411, 412, 413, 601, 602, 603, 604].includes(command.code) && command.indent === parentIndent) {
        return { commands: result, index, marker: command.code };
      }
      if (command.code === 118) {
        const name = String(command.parameters?.[0] || 'label');
        // Inlined common events stay flat arrays, so their nested labels cannot become passages.
        if (!topLevel && depth > 0) console.warn(`MWGP convert: label "${name}" in an inlined common event (map ${mapId}, event ${eventId}) cannot split passages; dropping it`);
        else if (!topLevel) result.push({ __label: name });
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
        const condition = command.parameters?.[0] === 12
          ? { script: { source: String(command.parameters[1] ?? ''), ...conditionBody(String(command.parameters[1] ?? '')) } }
          : convertBranchCondition(command.parameters || [], { mapId, eventId });
        const thenBlock = parseBlock(index + 1, command.indent);
        index = thenBlock.index;
        let elseCommands;
        if (thenBlock.marker === 411) {
          const elseBlock = parseBlock(index + 1, command.indent);
          elseCommands = elseBlock.commands;
          index = elseBlock.index;
        }
        // convertBranchCondition never returns null (unknown kinds become an
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
          ask: '', choices: texts.map((text, i) => ({ text: resolveTextTables(text), value: i })), branches,
          ...(cancelType === -1 && cancelBranch ? { cancelBranch } : {}),
          ...(portrait ? { portrait } : {})
        });
        continue;
      }
      if (command.code === 302) {
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
          })),
          purchaseOnly: command.parameters?.[4] === true
        } });
        index++;
        continue;
      }
      if (command.code === 303) {
        const [actor, maxLength] = command.parameters || [];
        result.push({ inputName: { target: 'player', actorId: Number(actor || 0), maxLength: Number(maxLength || 12) } });
        index++;
        continue;
      }
      if (command.code === 301) {
        const battle = convertCommand(command, { portrait, depth, mapId, eventId, stack })?.[0]?.battle;
        const branches = {};
        index++;
        while (index < list.length) {
          const marker = list[index];
          const name = { 601: 'win', 602: 'escape', 603: 'lose' }[marker.code];
          if (name && marker.indent === command.indent) {
            const block = parseBlock(index + 1, command.indent);
            branches[name] = block.commands;
            index = block.index;
            continue;
          }
          if (marker.code === 604 && marker.indent === command.indent) { index++; break; }
          break;
        }
        if (battle) result.push({ battle: { ...battle, ...(Object.keys(branches).length ? { branches } : {}) } });
        continue;
      }
      if (command.code === 355) {
        let script = command.parameters?.[0] || '';
        while (index + 1 < list.length && list[index + 1].code === 655) {
          index++;
          script += '\n' + (list[index].parameters?.[0] || '');
        }
        // MV/MZ scripts are JavaScript already; the player runs them against its MV-globals shim.
        result.push({ script, mv: true, ...scriptBody(script) });
        index++;
        continue;
      }
      // 105 (Show Scrolling Text) owns its following 405 body lines the way
      // 355 owns 655s — verified against Game_Interpreter.command105 in the
      // shipped engine. A 405 outside a 105 is plugin data (seen in the wild)
      // and stays dropped by convertCommand below.
      if (command.code === 105) {
        const [speed, noFast] = command.parameters || [];
        const lines = [];
        while (index + 1 < list.length && list[index + 1].code === 405) {
          index++;
          lines.push(list[index].parameters?.[0] || '');
        }
        result.push({ scroll: { text: resolveTextTables(lines.join('\n')), speed: Number(speed ?? 2), noFast: noFast === true } });
        index++;
        continue;
      }
      if (command.code === 101 && command.parameters?.[0]) portrait = { name: command.parameters[0], index: Number(command.parameters[1] || 0) };
      const converted = convertCommand(command, { portrait, depth, mapId, eventId, stack });
      if (converted) result.push(...converted);
      index++;
    }
    return { commands: result, index, marker: null };
  }
}

function convertCommand(command, context = {}) {
  const portrait = context.portrait ? { portrait: context.portrait } : {};
  if (command.code === 301) {
    const [designation, troop, canEscape, canLose] = command.parameters || [];
    return [{ battle: {
      ...(Number(designation) === 1 ? { troopVariable: String(troop) } : { troopId: Number(troop || 0) }),
      canEscape: canEscape === true,
      canLose: canLose === true
    } }];
  }
  if (command.code === 401) return [{ say: resolveTextTables(command.parameters?.[0] || ''), ...portrait }];
  if (command.code === 113) return [{ breakLoop: true }];
  if (command.code === 115) return [{ exitEvent: true }];
  if (command.code === 123 && context.mapId != null && context.eventId != null) {
    const [ch, value] = command.parameters || [];
    return [{ setSwitch: selfSwitchKey(context.mapId, context.eventId, ch || 'A'), value: value === 0 }];
  }
  if (command.code === 121) return Array.from({ length: command.parameters[1] - command.parameters[0] + 1 }, (_, offset) => ({ setSwitch: String(command.parameters[0] + offset), value: command.parameters[2] === 0 }));
  if (command.code === 122) {
    const first = Number(command.parameters[0]);
    const last = Number(command.parameters[1] ?? first);
    const operation = Number(command.parameters[2] || 0);
    const operandType = Number(command.parameters[3] || 0);
    // Constant (0), a copy from another variable (1), and a random range (2) all resolve at
    // runtime; game-data (3) and script (4) operands go through convertExtendedOperand below.
    if (operandType > 2) return convertExtendedOperand(command.parameters || [], context);
    return Array.from({ length: last - first + 1 }, (_, offset) => {
      const id = String(first + offset);
      let operand;
      if (operandType === 1) operand = { variable: String(command.parameters[4]) };
      else if (operandType === 2) operand = { random: [Number(command.parameters[4] || 0), Number(command.parameters[5] || 0)] };
      else operand = { value: Number(command.parameters[4] || 0) };
      if (operation === 0) return operandType === 0 ? { setVariable: id, value: operand.value } : { copyVariable: id, ...operand };
      if (operation === 1 && operandType === 0) return { addVariable: id, amount: operand.value };
      if (operation === 2 && operandType === 0) return { addVariable: id, amount: -operand.value };
      if (operation >= 1 && operation <= 5) return { modifyVariable: { target: id, operation: ['add', 'subtract', 'multiply', 'divide', 'modulo'][operation - 1], operand } };
      return null;
    }).filter(Boolean);
  }
  if (command.code === 230) return [{ wait: Number(command.parameters?.[0] || 0) / 60 }];
  // Routes keep their real target. The player is -1, the running event is 0,
  // and positive values address a map event by id. The player executes these
  // routes through the same movement callback as native MWG commands.
  // Step codes are MV's Game_Character.ROUTE_* constants (see rpg_objects.js in
  // any MV project). Steps needing runtime state (facing/position) are emitted
  // as descriptors ({ random, forward, backward, jump }) that the player's
  // toRouteSteps hands to the library's MoveRouteRunner; speed/frequency/animation/fix/blend steps
  // (29-36, 43) remain partial, while through, transparency, image changes,
  // scripts, and SE retain their observable side effects.
  if (command.code === 205) {
    const rawTarget = Number(command.parameters?.[0]);
    const routeTarget = rawTarget === -1 ? 'player'
      : rawTarget === 0 && context.eventId != null ? `event:${context.eventId}`
        : rawTarget === 0 ? 'self'
        : rawTarget > 0 ? `event:${rawTarget}` : null;
    // No resolvable target: the whole route (including real steps) would
    // vanish, so it stays a loud marker.
    if (!routeTarget) return [unsupportedCommand(Number(command.code), 2, context)];
    const route = command.parameters?.[1] || {};
    const commands = [];
    const repeatableSteps = [];
    let routeOnly = true;
    for (const step of route.list || []) {
      const movement = {
        1: { dx: 0, dy: 1 }, 2: { dx: -1, dy: 0 }, 3: { dx: 1, dy: 0 }, 4: { dx: 0, dy: -1 },
        5: { dx: -1, dy: 1 }, 6: { dx: 1, dy: 1 }, 7: { dx: -1, dy: -1 }, 8: { dx: 1, dy: -1 },
        9: { random: true }, 12: { forward: true }, 13: { backward: true }
      }[step.code];
      const relative = { 10: { toward: true }, 11: { away: true } }[step.code];
      const jump = step.code === 14 ? { jump: { dx: Number(step.parameters?.[0] || 0), dy: Number(step.parameters?.[1] || 0) } } : null;
      const turn = {
        16: 'down', 17: 'left', 18: 'right', 19: 'up', 20: 'right90', 21: 'left90',
        22: 'around', 23: 'random', 24: 'random', 25: 'toward', 26: 'away'
      }[step.code];
      if (movement) { commands.push({ move: { target: routeTarget, steps: [movement] } }); repeatableSteps.push(movement); }
      else if (jump) { commands.push({ move: { target: routeTarget, steps: [jump] } }); repeatableSteps.push(jump); }
      else if (relative) { commands.push({ move: { target: routeTarget, steps: [relative] } }); repeatableSteps.push(relative); }
      else if (turn) { commands.push(routeTarget === 'player' ? { turn } : { turn: { target: routeTarget, direction: turn } }); repeatableSteps.push({ turn }); }
      else if (step.code === 15) { const wait = { wait: Number(step.parameters?.[0] || 0) / 60 }; commands.push(wait); repeatableSteps.push(wait); }
      else if (step.code === 27 || step.code === 28) { routeOnly = false; commands.push({ setSwitch: String(step.parameters?.[0] ?? 0), value: step.code === 27 }); }
      else if ([29, 30, 31, 32, 33, 34, 35, 36].includes(Number(step.code))) {
        routeOnly = false;
        const option = { 29: 'speed', 30: 'frequency', 31: 'walkAnimation', 32: 'walkAnimation', 33: 'stepAnimation', 34: 'stepAnimation', 35: 'directionFix', 36: 'directionFix' }[Number(step.code)];
        const value = [29, 30].includes(Number(step.code)) ? Number(step.parameters?.[0] || 0) : ![32, 34, 36].includes(Number(step.code));
        commands.push({ routeOption: { target: routeTarget, option, value } });
      }
      else if (step.code === 37 || step.code === 38) { routeOnly = false; commands.push({ routeThrough: { target: routeTarget, value: step.code === 37 } }); }
      else if (step.code === 39 || step.code === 40 || step.code === 42) {
        routeOnly = false;
        const value = step.code === 42
          ? Math.max(0, Math.min(1, Number(step.parameters?.[0] ?? 255) / 255))
          : step.code === 39;
        commands.push({ setTransparent: routeTarget === 'player' ? value : { target: routeTarget, value } });
      }
      else if (step.code === 41 && step.parameters?.[0] !== undefined) {
        routeOnly = false;
        const image = {
          name: String(step.parameters[0] || ''),
          index: Number(step.parameters[1] || 0),
          direction: Number(step.parameters[2] || 2),
          pattern: Number(step.parameters[3] || 1)
        };
        if (image.name) characterNames.add(image.name);
        commands.push({ routeImage: { target: routeTarget, image } });
      }
      else if (step.code === 44) {
        routeOnly = false;
        const se = step.parameters?.[0];
        if (se?.name) {
          soundNames.add(se.name);
          commands.push({ sound: { name: se.name, volume: Number(se.volume ?? 90), pitch: Number(se.pitch ?? 100), pan: Number(se.pan || 0) } });
        }
      } else if (step.code === 45 && step.parameters?.[0]) {
        routeOnly = false;
        const script = String(step.parameters[0]);
        // ROUTE_SCRIPT is MV JavaScript, just like command 355. Preserve the
        // mv marker and syntax diagnostic so prepareEventCommands sends it
        // through the bounded globals bridge instead of dropping it as an
        // untyped/unsupported script.
        commands.push({ script, mv: true, ...scriptBody(script) });
      }
      else if (step.code !== 0) routeOnly = false;
    }
    if (route.repeat && routeOnly && repeatableSteps.length) return [{ move: { target: routeTarget, steps: repeatableSteps, repeat: true, skippable: route.skippable === true, wait: route.wait === true } }];
    if (commands.length) return commands;
    // Only dropped steps (speed/frequency/animation/appearance) remain: the
    // route moves nothing and completes instantly, so skipping it is faithful
    // — except a repeating waiter, which the engine would wait on indefinitely.
    if (route.repeat && route.wait) return [unsupportedCommand(Number(command.code), 1, context)];
    return [];
  }
  if (command.code === 231) {
    const p = command.parameters || [];
    if (p[1]) pictureNames.add(p[1]);
    return p[1] ? [{ picture: { id: Number(p[0]), name: p[1], origin: Number(p[2] || 0), x: Number(p[4] || 0), y: Number(p[5] || 0), scaleX: Number(p[6] ?? 100), scaleY: Number(p[7] ?? 100), opacity: Number(p[8] ?? 255) } }] : [];
  }
  if (command.code === 235) return [{ erasePicture: Number(command.parameters?.[0] || 0) }];
  // MV interpolates the move/tint over duration frames; the player owns that
  // tween (see scene.updatePictures), so the target state travels with the command.
  if (command.code === 232) {
    const p = command.parameters || [];
    return [{
      movePicture: {
        id: Number(p[0]), x: Number(p[2] || 0), y: Number(p[3] || 0),
        scaleX: Number(p[4] ?? 100), scaleY: Number(p[5] ?? 100), opacity: Number(p[6] ?? 255),
        duration: Number(p[8] || 0) / 60, wait: p[9] === true
      }
    }];
  }
  if (command.code === 234) {
    const p = command.parameters || [];
    return [{ tintPicture: { id: Number(p[0]), tone: p[1] || [0, 0, 0, 0], duration: Number(p[2] || 0) / 60, wait: p[3] === true } }];
  }
  // MV's Fadeout/Fadein Screen take no parameters; the editor always uses its standard
  // 24-frame transition, so that duration is baked in rather than read from parameters.
  if (command.code === 221) return [{ screenFade: { direction: 'out', duration: 24 / 60 } }];
  if (command.code === 222) return [{ screenFade: { direction: 'in', duration: 24 / 60 } }];
  if (command.code === 224) {
    const p = command.parameters || [];
    const [r, g, b, power] = p[0] || [255, 255, 255, 0];
    const clamp = n => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
    const color = (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
    return [{ screenFlash: { color, peak: Math.max(0, Math.min(1, Number(power || 0) / 255)), duration: Number(p[1] || 0) / 60, wait: p[2] === true } }];
  }
  if (command.code === 250) {
    // MV stores the SE as one audio object in parameters[0] ({ name, volume, pitch, pan }),
    // the same shape as BGM/ME/BGS — not spread across parameters[0..3].
    const p = command.parameters || [];
    const se = p[0] && typeof p[0] === 'object' ? p[0] : { name: p[0], volume: p[1], pitch: p[2], pan: p[3] };
    if (!se.name) return [];
    soundNames.add(se.name);
    return [{ sound: { name: se.name, volume: Number(se.volume ?? 90), pitch: Number(se.pitch ?? 100), pan: Number(se.pan || 0) } }];
  }
  if (command.code === 125) {
    const [op, type, val] = command.parameters || [];
    const amount = type === 0 ? (op === 1 ? -Number(val || 0) : Number(val || 0)) : { variable: String(val), op: op === 1 ? 'sub' : 'add' };
    return [{ changeGold: amount }];
  }
  if (command.code === 126) {
    const [id, op, type, val] = command.parameters || [];
    const amount = type === 0 ? (op === 1 ? -Number(val || 0) : Number(val || 0)) : { variable: String(val), op: op === 1 ? 'sub' : 'add' };
    return [{ changeItem: { id: Number(id), amount } }];
  }
  if (command.code === 127) {
    const [id, op, type, val] = command.parameters || [];
    const amount = type === 0 ? (op === 1 ? -Number(val || 0) : Number(val || 0)) : { variable: String(val), op: op === 1 ? 'sub' : 'add' };
    return [{ changeWeapon: { id: Number(id), amount } }];
  }
  if (command.code === 128) {
    const [id, op, type, val] = command.parameters || [];
    const amount = type === 0 ? (op === 1 ? -Number(val || 0) : Number(val || 0)) : { variable: String(val), op: op === 1 ? 'sub' : 'add' };
    return [{ changeArmor: { id: Number(id), amount } }];
  }
  if (command.code === 129) {
    const [actorId, op] = command.parameters || [];
    return [{ changeParty: { actorId: Number(actorId), add: op === 0 } }];
  }
  // 213 params are [eventId, balloonId, wait]; -1 is the player, 0 the running
  // event (resolved by the player), anything else a map event id.
  if (command.code === 213) {
    const [target, balloon, wait] = command.parameters || [];
    if (!balloon) return [];
    balloonUsed = true;
    return [{ balloon: { target: Number(target ?? -1), balloon: Number(balloon), wait: wait === true } }];
  }
  // 212 params are [eventId, animationId, wait]; sprite sheets resolve after
  // the database loads (see animationSpriteNames below).
  if (command.code === 212) {
    const [target, animation, wait] = command.parameters || [];
    if (!animation) return [];
    animationIds.add(Number(animation));
    return [{ animation: { target: Number(target ?? -1), animation: Number(animation), wait: wait === true } }];
  }
  // 204 is Scroll Map (engine command204: [direction, distance, speed]), a
  // non-blocking camera pan the player owns (see scene.scrollMap).
  if (command.code === 236) {
    const [type, power, duration, wait] = command.parameters || [];
    return [{ weather: { type: String(type || 'none'), power: Number(power || 0), duration: Number(duration || 0) / 60, wait: wait === true } }];
  }
  if (command.code === 204) {
    const [direction, distance, speed] = command.parameters || [];
    return [{ scrollMap: { direction: Number(direction || 2), distance: Number(distance || 0), speed: Number(speed ?? 4) } }];
  }
  // 202 params are [vehicle, designation, map, x, y]. Vehicle ids follow
  // RPG Maker: 0 boat, 1 ship, 2 airship. Variable designation is preserved.
  if (command.code === 202) {
    const [vehicle, designation, a, b, c] = command.parameters || [];
    if (Number(designation || 0) === 0) return [{ vehicleLocation: { vehicle: Number(vehicle || 0), mapId: Number(a || 0), x: Number(b || 0), y: Number(c || 0) } }];
    if (Number(designation) === 1) return [{ vehicleLocation: { vehicle: Number(vehicle || 0), mapVar: String(a ?? 0), xVar: String(b ?? 0), yVar: String(c ?? 0) } }];
    return [unsupportedCommand(Number(command.code), Number(designation), context)];
  }
  // 203 params are [target, designation, x, y(, direction)]: -1 player,
  // 0 running event, N map event. Designation 1 reads x/y from variables at
  // runtime; designation 2 (swap two events) has no player equivalent.
  if (command.code === 203) {
    const [target, designation, a, b, direction] = command.parameters || [];
    const resolved = Number(target ?? -1) === -1 ? 'player' : Number(target) === 0 ? 'self' : String(target);
    const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[Number(direction)] || null;
    if (Number(designation) === 1) {
      return [{ relocate: { target: resolved, varX: String(a ?? 0), varY: String(b ?? 0), ...(facing ? { facing } : {}) } }];
    }
    // Designation 2 swaps two events' positions; the player has no read of
    // another event's live position, so it stays a loud marker, never a skip.
    if (Number(designation || 0) !== 0) return [unsupportedCommand(Number(command.code), Number(designation), context)];
    return [{ relocate: { target: resolved, x: Number(a || 0), y: Number(b || 0), ...(facing ? { facing } : {}) } }];
  }
  // Actor commands address MV's iterateActorEx scope: 0 = entire party,
  // 1 = specific actor id, 2 = actor id read from a variable at runtime.
  if (command.code === 311) {
    const [scope, actor, operation, operandType, operand, allowDeath] = command.parameters || [];
    const amount = operandType === 0 ? Number(operand || 0) : { variable: String(operand ?? 0) };
    return [{ changeHp: { scope: Number(scope || 0), actor: Number(actor || 0), amount, sign: Number(operation || 0) === 0 ? 1 : -1, allowDeath: allowDeath === true } }];
  }
  if (command.code === 313) {
    const [scope, actor, mode, state] = command.parameters || [];
    return [{ changeState: { scope: Number(scope || 0), actor: Number(actor || 0), add: Number(mode || 0) === 0, state: Number(state || 0) } }];
  }
  if (command.code === 314) {
    const [scope, actor] = command.parameters || [];
    return [{ recoverAll: { scope: Number(scope || 0), actor: Number(actor || 0) } }];
  }
  if (command.code === 316) {
    const [scope, actor, operation, operandType, operand, show] = command.parameters || [];
    const amount = operandType === 0 ? Number(operand || 0) : { variable: String(operand ?? 0) };
    return [{ changeLevel: { scope: Number(scope || 0), actor: Number(actor || 0), amount, sign: Number(operation || 0) === 0 ? 1 : -1, show: show === true } }];
  }
  if (command.code === 321) {
    const [actor, classId, keepExp] = command.parameters || [];
    return [{ changeClass: { actor: Number(actor || 0), classId: Number(classId || 0), keepExp: keepExp === true } }];
  }
  if (command.code === 318) {
    const [scope, actor, mode, skill] = command.parameters || [];
    return [{ changeSkill: { scope: Number(scope || 0), actor: Number(actor || 0), learn: Number(mode || 0) === 0, skill: Number(skill || 0) } }];
  }
  if (command.code === 319) {
    const [actor, slot, item] = command.parameters || [];
    return [{ changeEquipment: { actor: Number(actor || 0), slot: Number(slot || 0), item: Number(item || 0) } }];
  }
  // 322 is Change Actor Images (character, face, battler); the profile text is 325. (An earlier
  // revision stored 322's character sheet name as the actor's profile.)
  if (command.code === 322) {
    const [actor, characterName, characterIndex, faceName, faceIndex, battlerName] = command.parameters || [];
    return [{ changeActorImages: { actor: Number(actor || 0), characterName: String(characterName || ''), characterIndex: Number(characterIndex || 0), faceName: String(faceName || ''), faceIndex: Number(faceIndex || 0), battlerName: String(battlerName || '') } }];
  }
  if (command.code === 325) {
    const [actor, profile] = command.parameters || [];
    return [{ changeProfile: { actor: Number(actor || 0), profile: String(profile || '') } }];
  }
  if (command.code === 320 || command.code === 324) {
    const [actor, text] = command.parameters || [];
    return [{ changeActorText: { actor: Number(actor || 0), field: command.code === 320 ? 'name' : 'nickname', text: String(text ?? '') } }];
  }
  // 312 MP, 315 EXP, 317 parameter, 326 TP share 311's operand shape ([scope, actor, operation,
  // operandType, operand]); 317 inserts the parameter id before the operation.
  if (command.code === 312 || command.code === 315 || command.code === 326 || command.code === 317) {
    const p = command.parameters || [];
    const offset = command.code === 317 ? 1 : 0;
    const [scope, actor] = p;
    const operation = p[2 + offset], operandType = p[3 + offset], operand = p[4 + offset];
    const amount = operandType === 0 ? Number(operand || 0) : { variable: String(operand ?? 0) };
    const stat = { 312: 'mp', 315: 'exp', 317: 'param', 326: 'tp' }[command.code];
    return [{ changeActorStat: { stat, scope: Number(scope || 0), actor: Number(actor || 0), amount, sign: Number(operation || 0) === 0 ? 1 : -1, ...(stat === 'param' ? { param: Number(p[2] || 0) } : {}), ...(stat === 'exp' ? { show: p[5] === true } : {}) } }];
  }
  // System toggles and settings that live on Game_System / Game_Map in the engine: 134 save, 135 menu,
  // 136 encounter, 137 formation access (0 disables), 216 followers (0 shows), 281 map name display (0 on),
  // 138 window tone, 132/133/139 battle BGM and victory/defeat ME, 140 vehicle BGM, 323 vehicle image.
  // The player stores them in rpgExtra.system and honours the ones that have a consumer (menu, save,
  // battle music); the rest are kept so a save round-trips them.
  if (command.code === 134 || command.code === 135 || command.code === 136 || command.code === 137) {
    const key = { 134: 'saveAccess', 135: 'menuAccess', 136: 'encounterAccess', 137: 'formationAccess' }[command.code];
    return [{ systemFlag: { key, value: Number(command.parameters?.[0] || 0) !== 0 } }];
  }
  if (command.code === 216) return [{ systemFlag: { key: 'followers', value: Number(command.parameters?.[0] || 0) === 0 } }];
  if (command.code === 281) return [{ systemFlag: { key: 'mapNameDisplay', value: Number(command.parameters?.[0] || 0) === 0 } }];
  if (command.code === 138) return [{ systemFlag: { key: 'windowTone', value: (command.parameters?.[0] || [0, 0, 0]).map(Number) } }];
  if (command.code === 132 || command.code === 133 || command.code === 139) {
    const audio = command.parameters?.[0];
    const key = { 132: 'battleBgm', 133: 'victoryMe', 139: 'defeatMe' }[command.code];
    if (audio?.name) (command.code === 132 ? musicNames : meNames).add(audio.name);
    return [{ systemFlag: { key, value: audio?.name ? audioParams(audio) : null } }];
  }
  if (command.code === 140) {
    const audio = command.parameters?.[1];
    if (audio?.name) musicNames.add(audio.name);
    return [{ systemFlag: { key: `vehicleBgm:${Number(command.parameters?.[0] || 0)}`, value: audio?.name ? audioParams(audio) : null } }];
  }
  if (command.code === 323) return [{ systemFlag: { key: `vehicleImage:${Number(command.parameters?.[0] || 0)}`, value: { name: String(command.parameters?.[1] || ''), index: Number(command.parameters?.[2] || 0) } } }];
  // 217 gathers followers around the player; this player draws none, so there is nothing to gather.
  if (command.code === 217) return [];
  // 124 timer: [0 start | 1 stop, seconds]. 206 boards or leaves the vehicle at the player's position.
  if (command.code === 124) return [{ timer: Number(command.parameters?.[0] || 0) === 0 ? { start: Number(command.parameters?.[1] || 0) } : { stop: true } }];
  if (command.code === 206) return [{ vehicleBoard: true }];
  // 261 Play Movie: the file is copied next to the audio (movies/<name>.webm) and plays over the map.
  if (command.code === 261) {
    const name = String(command.parameters?.[0] || '');
    if (!name) return [];
    movieNames.add(name);
    return [{ playMovie: { name } }];
  }
  // 339 Force Action: [subject type (0 enemy, 1 actor), enemy index / actor id, skill id, target
  // (-2 = the subject's last target, -1 = random, 0.. = that index)]. Only meaningful in a troop event.
  if (command.code === 339) {
    const [kind, subject, skill, target] = command.parameters || [];
    return [{ forceAction: { subjectKind: Number(kind || 0) === 0 ? 'enemy' : 'actor', subject: Number(subject || 0), skill: Number(skill || 0), target: Number(target ?? -2) } }];
  }
  // 354 Return to Title Screen.
  if (command.code === 354) return [{ returnToTitle: true }];
  if (command.code === 243) return [{ saveBgm: true }];
  if (command.code === 244) return [{ resumeBgm: true }];
  if (command.code === 249) {
    const me = (command.parameters || [])[0];
    if (!me?.name) return [];
    meNames.add(me.name);
    return [{ me: { name: me.name, volume: Number(me.volume ?? 90), pitch: Number(me.pitch ?? 100), pan: Number(me.pan || 0) } }];
  }
  // 351/352 open the menu/save scenes, which have no player equivalent.
  if (command.code === 351) return [{ menu: 'menu' }];
  if (command.code === 352) return [{ menu: 'save' }];
  if (command.code === 353) return [{ gameOver: true }];
  if (command.code === 211) return [{ setTransparent: command.parameters?.[0] === 0 }];
  if (command.code === 214) return [{ eraseEvent: true }];
  if (command.code === 223) {
    const p = command.parameters || [];
    return [{ screenTint: { tone: p[0] || [0, 0, 0, 0], duration: Number(p[1] || 0) / 60, wait: p[2] === true } }];
  }
  if (command.code === 225) {
    const p = command.parameters || [];
    return [{ screenShake: { power: Number(p[0] || 5), speed: Number(p[1] || 5), duration: Number(p[2] || 0) / 60, wait: p[3] === true } }];
  }
  if (command.code === 241) {
    const p = command.parameters || [];
    const bgm = p[0] && typeof p[0] === 'object' ? p[0] : { name: p[0], volume: p[1], pitch: p[2], pan: p[3] };
    if (!bgm?.name) return [];
    musicNames.add(bgm.name);
    return [{ playBgm: { name: bgm.name, volume: Number(bgm.volume ?? 90), pitch: Number(bgm.pitch ?? 100), pan: Number(bgm.pan || 0) } }];
  }
  if (command.code === 242) return [{ fadeoutBgm: { duration: Number(command.parameters?.[0] || 1) } }];
  if (command.code === 245) {
    const p = command.parameters || [];
    const bgs = p[0] && typeof p[0] === 'object' ? p[0] : { name: p[0], volume: p[1], pitch: p[2], pan: p[3] };
    if (!bgs?.name) return [];
    musicNames.add(bgs.name);
    return [{ playBgs: { name: bgs.name, volume: Number(bgs.volume ?? 90), pitch: Number(bgs.pitch ?? 100), pan: Number(bgs.pan || 0) } }];
  }
  if (command.code === 246) return [{ fadeoutBgs: { duration: Number(command.parameters?.[0] || 1) } }];
  if (command.code === 251) return [{ stopSound: true }];
  // Troop-event commands on the enemies of the running battle (index -1 = the whole troop).
  // Enemy commands act on the running battle's enemies (index -1 = the whole troop). Engine numbering:
  // 331 HP, 332 MP, 333 State, 334 Recover All, 335 Appear, 336 Transform, 337 Show Animation, 340 Abort
  // Battle, 342 TP. (An earlier revision read 333 as TP and 334 as a state change.)
  if (command.code === 331 || command.code === 332 || command.code === 342) {
    const [index, operation, operandType, operand, allowDeath] = command.parameters || [];
    const amount = operandType === 0 ? Number(operand || 0) : { variable: String(operand ?? 0) };
    const key = { 331: 'changeEnemyHp', 332: 'changeEnemyMp', 342: 'changeEnemyTp' }[command.code];
    return [{ [key]: { index: Number(index ?? 0), amount, sign: Number(operation || 0) === 0 ? 1 : -1, ...(command.code === 331 ? { allowDeath: allowDeath === true } : {}) } }];
  }
  if (command.code === 333) return [{ changeEnemyState: { index: Number(command.parameters?.[0] ?? 0), add: Number(command.parameters?.[1] || 0) === 0, state: Number(command.parameters?.[2] || 0) } }];
  if (command.code === 334) return [{ enemyRecoverAll: { index: Number(command.parameters?.[0] ?? 0) } }];
  // 337 plays an animation on an enemy sprite; battles draw no animations, so it is a visual-only no-op (partial).
  if (command.code === 337) return [];
  if (command.code === 340) return [{ abortBattle: true }];
  // 104 Select Item: [variable, item type (1 regular, 2 key, 3 hidden A, 4 hidden B)].
  if (command.code === 104) return [{ selectItem: { variable: String(command.parameters?.[0] ?? 0), itemType: Number(command.parameters?.[1] || 1) } }];
  // 233 Rotate Picture: [picture, speed]; the engine turns it speed/2 degrees per frame.
  if (command.code === 233) return [{ rotatePicture: { id: Number(command.parameters?.[0] || 0), speed: Number(command.parameters?.[1] || 0) } }];
  // 285 Get Location Info: [variable, info (0 terrain tag, 1 event id, 2-5 tile id of layer 1-4, 6 region), designation, x, y].
  if (command.code === 285) {
    const [variable, info, designation, a, b] = command.parameters || [];
    return [{ locationInfo: { variable: String(variable ?? 0), info: Number(info || 0), ...(Number(designation || 0) === 0 ? { x: Number(a || 0), y: Number(b || 0) } : { xVar: String(a ?? 0), yVar: String(b ?? 0) }) } }];
  }
  // 282 Change Tileset: [tileset id]. The player rebuilds the current map with it (see scene.changeTileset).
  if (command.code === 282) return [{ changeTileset: { id: Number(command.parameters?.[0] || 0) } }];
  // 284 Change Parallax: [name, loop X, loop Y, scroll X, scroll Y]; an empty name hides it.
  if (command.code === 284) {
    const [name, loopX, loopY, sx, sy] = command.parameters || [];
    if (name) foregroundNames.add(String(name));
    return [{ changeParallax: { name: String(name || ''), loopX: loopX === true, loopY: loopY === true, sx: Number(sx || 0), sy: Number(sy || 0) } }];
  }
  // 283 Change Battle Back: the two battleback images used by the next battles on this run.
  if (command.code === 283) {
    const [first, second] = command.parameters || [];
    if (first) battlebackNames[1].add(String(first));
    if (second) battlebackNames[2].add(String(second));
    return [{ systemFlag: { key: 'battleback', value: { first: String(first || ''), second: String(second || '') } } }];
  }
  if (command.code === 336) return [{ enemyTransform: { index: Number(command.parameters?.[0] ?? 0), enemyId: Number(command.parameters?.[1] || 0) } }];
  if (command.code === 335) return [{ enemyAppear: { index: Number(command.parameters?.[0] || 0) } }];
  if (command.code === 356 && command.parameters?.[0]) {
    const raw = String(command.parameters[0]);
    // Split first: a table entry can hold spaces, and resolving before the
    // split would shatter it into extra positional args. Text args (Tachie
    // portrait names, etc.) resolve like say/choice text; other args pass
    // through unchanged.
    const parts = raw.trim().split(/\s+/).map(part => resolveTextTables(part));
    return [{ pluginCommand: { raw: resolveTextTables(raw), name: parts[0] || '', args: parts.slice(1) } }];
  }
  // MZ plugin commands (code 357, [pluginName, commandName, label, args]): the
  // same pluginCommand vocabulary as MV's 356 above, plus the plugin name and
  // the args object the engine hands to the plugin's registered command
  // (`PluginManager.callCommand`). The args also flatten to positional string
  // args like the MV split. Malformed params fall through to the loud marker
  // below, never a skip.
  if (command.code === 357 && Array.isArray(command.parameters)) {
    const [plugin = '', sub = ''] = command.parameters;
    const argsObject = command.parameters.find(param => param && typeof param === 'object' && !Array.isArray(param));
    const values = argsObject ? Object.values(argsObject) : [];
    const name = String(sub || plugin || '').trim();
    if (!name) return [unsupportedCommand(Number(command.code), 0, context)];
    const args = values.map(value => resolveTextTables(String(value ?? '')));
    const raw = [String(plugin || '').trim(), name, ...args].filter(Boolean).join(' ');
    return [{ pluginCommand: { raw, name, args, ...(plugin ? { plugin: String(plugin).trim(), params: argsObject || {} } : {}) } }];
  }
  // Keep common-event calls as runtime references. Inlining made valid
  // diamond-shaped call graphs explode and forced a depth-8 truncation;
  // the player executes the converted list with a cycle guard instead.
  if (command.code === 117) {
    const ceId = Number(command.parameters?.[0]);
    const commonEvent = commonEvents[ceId];
    if (commonEvent?.list) return [{ commonEvent: String(ceId) }];
    return [unsupportedCommand(Number(command.code), 0, context)];
  }
  if (command.code === 103) {
    const [variable, digits] = command.parameters || [];
    return [{ inputNumber: { variable: String(variable ?? 0), digits: Number(digits || 1) } }];
  }
  if (command.code === 201 && command.parameters?.[0] === 0) return [{ transfer: { mapId: command.parameters[1], x: command.parameters[2], y: command.parameters[3] } }];
  // Designation 1 reads map/x/y from variables at runtime (MV editor: "Designation
  // with variables"); the player already resolves mapVar/xVar/yVar (see
  // scene.transfer). Dropping these silently strands the player, so preserve them.
  if (command.code === 201 && command.parameters?.[0] === 1) return [{ transfer: { mapVar: String(command.parameters[1]), xVar: String(command.parameters[2]), yVar: String(command.parameters[3]) } }];
  // Engine-faithful no-ops stay silent: 0 (empty slot), 101 (Show Text header —
  // parseBlock already took the portrait, the 401 lines carry the text),
  // 108/408 (comments),
  // 405 outside scrolling text (plugin data), 505 (a route step's
  // editor-only sibling, folded into 205). Anything else unmapped is a real
  // gap: loud marker, never a skip.
  if ([0, 101, 108, 405, 408, 505].includes(Number(command.code))) return [];
  return [unsupportedCommand(Number(command.code), 0, context)];
}

// Catch-all loud fallback for unmapped event commands. Warns once per code
// (first location kept; common-event inlining would repeat it) with the rest
// in the end-of-conversion summary; every site is marked in the manifest so
// the player warns at runtime instead of skipping silently.
function unsupportedCommand(code, kind, context = {}) {
  const key = `${code}:${kind}`;
  const seen = unsupportedCommandFallbacks.get(key);
  if (!seen) {
    unsupportedCommandFallbacks.set(key, { count: 1, first: `map ${context.mapId}, event ${context.eventId}` });
    console.warn(`MWGP convert: event command ${code} has no converted equivalent; it warns at runtime and is skipped (first seen at map ${context.mapId}, event ${context.eventId})`);
  } else seen.count++;
  return { unsupported: { code, kind } };
}

// Control Variables with a game-data (3) or script (4) operand. Every shape the
// player can resolve exactly becomes a modifyVariable (or a plain setVariable
// for static strings); anything else becomes an explicit unsupported marker —
// the pre-existing behavior of returning [] silently dropped the assignment.
function convertExtendedOperand(parameters, context = {}) {
  const first = Number(parameters[0]);
  const last = Number(parameters[1] ?? first);
  const operation = OPERATION_NAMES[Number(parameters[2] || 0)];
  const operandType = Number(parameters[3] || 0);
  const range = build => Array.from({ length: last - first + 1 }, (_, offset) => build(String(first + offset)));
  if (!operation) return range(() => unsupportedOperand(operandType, context));
  if (operandType === 3) {
    const gameData = gameDataOperandShape(Number(parameters[4]), parameters[5], parameters[6]);
    if (!gameData) return range(() => unsupportedOperand(operandType, context));
    return range(id => ({ modifyVariable: { target: id, operation, operand: { gameData } } }));
  }
  if (operandType === 4) {
    const source = String(parameters[4] ?? '');
    const fixed = staticScriptValue(source);
    return range(id => {
      if (fixed && operation === 'set') return { setVariable: id, value: fixed.value };
      return { modifyVariable: { target: id, operation, operand: { script: { source, ...scriptBody(source) } } } };
    });
  }
  return range(() => unsupportedOperand(operandType, context));
}

// Game-data operands (engine gameDataOperand) that read player-held state:
// item/weapon/armor counts, the player's map position, party membership,
// and the map/gold/party-size counters. Actor stats, enemies, screen
// coordinates, steps, and playtime/save/battle counters have no player-side
// model and return null (loud marker, never a silent drop).
function gameDataOperandShape(type, p1, p2) {
  if (type === 0) return { kind: 'itemCount', id: String(p1 ?? 0) };
  if (type === 1) return { kind: 'weaponCount', id: String(p1 ?? 0) };
  if (type === 2) return { kind: 'armorCount', id: String(p1 ?? 0) };
  if (type === 5 && Number(p1) === -1 && Number(p2) === 0) return { kind: 'playerX' };
  if (type === 5 && Number(p1) === -1 && Number(p2) === 1) return { kind: 'playerY' };
  if (type === 6) return { kind: 'partyMember', index: Number(p1 ?? 0) };
  if (type === 7 && Number(p1) === 0) return { kind: 'mapId' };
  if (type === 7 && Number(p1) === 1) return { kind: 'partySize' };
  if (type === 7 && Number(p1) === 2) return { kind: 'gold' };
  return null;
}

// Scripts with a statically known value assign directly instead of depending
// on the runtime shim: string literals.
// Anything else returns null for the shim path.
function staticScriptValue(source) {
  const text = String(source ?? '').trim();
  const literal = text.match(/^('([^']*)'|"([^"]*)")$/);
  if (literal) return { value: literal[2] ?? literal[3] };
  return null;
}

function unsupportedOperand(operandType, context = {}) {
  const seen = unsupportedOperandFallbacks.get(operandType);
  if (!seen) {
    unsupportedOperandFallbacks.set(operandType, { count: 1, first: `map ${context.mapId}, event ${context.eventId}` });
    console.warn(`MWGP convert: variable operand type ${operandType} has no converted equivalent; it warns at runtime and reads as 0 (first seen at map ${context.mapId}, event ${context.eventId})`);
  } else seen.count++;
  return { unsupported: { code: 122, kind: Number(operandType) } };
}

function convertBranchCondition(parameters, context = {}) {
  if (parameters[0] === 0) return { switch: String(parameters[1]), equals: parameters[2] === 0 };
  if (parameters[0] === 1) {
    const operator = { 0: 'gte', 1: 'lte', 2: 'eq', 3: 'gt', 4: 'lt', 5: 'neq' }[Number(parameters[4] ?? 0)];
    if (!operator) return unsupportedCondition(parameters, context);
    if (Number(parameters[2] || 0) === 0) {
      return operator === 'gte'
        ? { variable: String(parameters[1]), atLeast: Number(parameters[3] || 0) }
        : { variable: String(parameters[1]), operator, value: Number(parameters[3] || 0) };
    }
    return { variable: String(parameters[1]), operator, compareVariable: String(parameters[3]) };
  }
  // Self switch (engine command111 case 2: key [mapId, eventId, letter], ON is
  // params[2] === 0) reuses the synthesized self-switch namespace, exactly like
  // code 123 sets and page conditions do.
  if (parameters[0] === 2 && context.mapId != null && context.eventId != null) {
    return { switch: selfSwitchKey(context.mapId, context.eventId, parameters[1] || 'A'), equals: parameters[2] === 0 };
  }
  // Actor checks (engine case 4) read the player-held actor records: sub 0 is
  // party membership, sub 3 a learned skill, sub 6 an affecting state. Like the
  // engine (`if (actor)` guard), an unknown actor id evaluates as false.
  // Timer (engine case 3): params [3, seconds, 0 = at least | 1 = at most] against the Control Timer countdown.
  if (parameters[0] === 3) return { timer: { seconds: Number(parameters[1] || 0), atLeast: Number(parameters[2] || 0) === 0 } };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 0) return { partyMember: Number(parameters[1] || 0) };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 1) return { actorName: { actor: Number(parameters[1] || 0), name: String(parameters[3] ?? '') } };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 2) return { actorClass: { actor: Number(parameters[1] || 0), classId: Number(parameters[3] || 0) } };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 3) return { actorSkill: { actor: Number(parameters[1] || 0), skill: Number(parameters[3] || 0) } };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 4) return { actorWeapon: { actor: Number(parameters[1] || 0), weapon: Number(parameters[3] || 0) } };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 5) return { actorArmor: { actor: Number(parameters[1] || 0), armor: Number(parameters[3] || 0) } };
  if (parameters[0] === 4 && Number(parameters[2] ?? -1) === 6) return { actorState: { actor: Number(parameters[1] || 0), state: Number(parameters[3] || 0) } };
  // Enemy (engine case 5, troop events): sub 0 = the enemy is alive/appeared, sub 1 = it is affected by a state.
  if (parameters[0] === 5 && Number(parameters[2] ?? -1) === 0) return { enemyAlive: { index: Number(parameters[1] || 0) } };
  if (parameters[0] === 5 && Number(parameters[2] ?? -1) === 1) return { enemyState: { index: Number(parameters[1] || 0), state: Number(parameters[3] || 0) } };
  if (parameters[0] === 9) return { weapon: { id: Number(parameters[1] || 0), includeEquipped: parameters[2] === true } };
  if (parameters[0] === 10) return { armor: { id: Number(parameters[1] || 0), includeEquipped: parameters[2] === true } };
  // Vehicle state (engine case 13): true while the player is riding the
  // requested boat, ship, or airship. MV stores a numeric type; MZ can use
  // the type name directly.
  if (parameters[0] === 13) {
    const vehicle = typeof parameters[1] === 'string' ? parameters[1] : ['boat', 'ship', 'airship'][Number(parameters[1])];
    if (vehicle) return { vehicle };
  }
  // Character facing (engine case 6: direction() === params[2], keypad
  // 2/4/6/8). -1 is the player, 0 the running event; other event ids have no
  // tracked facing at condition time and stay unsupported.
  if (parameters[0] === 6) {
    const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[Number(parameters[2])];
    if (facing && Number(parameters[1]) === -1) return { facing };
    if (facing && Number(parameters[1]) === 0) return { eventFacing: facing };
  }
  // Gold (engine case 7: only >=, <=, <) reads the player-held gold count.
  if (parameters[0] === 7) {
    const operator = { 0: 'gte', 1: 'lte', 2: 'lt' }[Number(parameters[2] ?? -1)];
    if (operator) return { gold: { operator, value: Number(parameters[1] || 0) } };
  }
  // Item in possession (engine case 8: hasItem) reads the player-held inventory.
  if (parameters[0] === 8) return { item: String(parameters[1] ?? 0) };
  return unsupportedCondition(parameters, context);
}

// Conditions with no engine-free equivalent (timer, enemies, buttons,
// vehicles, actor name/class/skill checks, ...) must never vanish silently:
// they convert to an explicit marker the player warns on at runtime and
// evaluates as false (the else-branch runs), so the gap is loud instead of
// a missing event page. Always returns an object — parseBlock keeps the block.
function unsupportedCondition(parameters, context = {}) {
  // Common-event inlining repeats one source branch at every call site, so the
  // warning fires once per kind (first location kept) and the rest collapse
  // into the end-of-conversion summary below — every site stays marked in the
  // manifest itself.
  const kind = Number(parameters[0]);
  const seen = unsupportedBranchFallbacks.get(kind);
  if (!seen) {
    unsupportedBranchFallbacks.set(kind, { count: 1, first: `map ${context.mapId}, event ${context.eventId}` });
    console.warn(`MWGP convert: conditional branch type ${kind} has no converted equivalent; it warns at runtime and takes the else-branch (first seen at map ${context.mapId}, event ${context.eventId})`);
  } else seen.count++;
  return { unsupported: { code: 111, kind } };
}

const databaseFiles = ['Actors.json', 'Classes.json', 'Skills.json', 'Items.json', 'Weapons.json', 'Armors.json', 'Enemies.json', 'Troops.json', 'States.json', 'Animations.json', 'Tilesets.json', 'CommonEvents.json', 'System.json'];
const database = {};
for (const name of databaseFiles) database[name.replace('.json', '').toLowerCase()] = await readJson(name, true);

const troopEvents = Object.fromEntries((database.troops || []).map((troop, troopId) => [String(troop?.id ?? troopId), (troop?.pages || []).map((page, pageIndex) => {
  const converted = convertCommands(page.list || [], { troopId: Number(troop?.id ?? troopId), troopPage: pageIndex });
  return { conditions: page.conditions || {}, span: Number(page.span || 0), commands: Array.isArray(converted) ? converted : [], ...(converted?.story ? { story: converted.story } : {}) };
}).filter(page => page.commands.length || page.story)]));
database.troopEvents = troopEvents;

const pluginsPath = join(gameRoot, 'js', 'plugins.js');
const pluginsText = existsSync(pluginsPath) ? await readFile(pluginsPath, 'utf8') : '';
for (const track of [systemAudio.titleBgm, systemAudio.battleBgm, ...Object.values(systemAudio.vehicles)]) if (track) { musicNames.add(track.name); systemAudioReferences.push({ kind: 'bgm', name: track.name }); }
for (const track of [systemAudio.victoryMe, systemAudio.defeatMe, systemAudio.gameoverMe]) if (track) { meNames.add(track.name); systemAudioReferences.push({ kind: 'me', name: track.name }); }
for (const track of Object.values(systemAudio.sounds)) { soundNames.add(track.name); systemAudioReferences.push({ kind: 'se', name: track.name }); }
phase.end();
phase = progress.phase('selecting plugins', 5);
const pluginLibrary = await buildPluginLibrary(gameRoot, pluginsText, scriptSources, { commandWords: pluginCommandWords, commandPlugins: pluginCommandPlugins, log: message => console.log(`MWGP convert: ${message}`) });
const pluginNames = [...pluginsText.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(match => match[1]);

// Animation sprite sheets resolve only now that the database is loaded.
const animationSpriteNames = new Set();
// Battle animations: every animation a skill, item or weapon plays on its target (animationId > 0; -1 means the
// attacker's weapon animation, which is already in the weapons list).
for (const table of ['skills', 'items', 'weapons']) for (const entry of database[table] || []) if (Number(entry?.animationId) > 0) animationIds.add(Number(entry.animationId));
for (const id of animationIds) {
  const animation = database.animations?.[id];
  if (animation?.animation1Name) animationSpriteNames.add(animation.animation1Name);
  if (animation?.animation2Name) animationSpriteNames.add(animation.animation2Name);
}

// Character frame geometry comes from the original project, not pixel scans:
// RPG Maker's own rule (rpg_managers.js ImageManager.isBigCharacter /
// isObjectCharacter, rpg_sprites.js Sprite_Character.patternWidth/Height) is a
// `$` filename prefix for single-character sheets (3x4 cells, otherwise 12x8)
// and a `!` prefix for object characters (no 6px upward shift). Cell size is
// the IHDR dimensions divided by that grid — sheets are not always 48px cells
// (e.g. Karryn's Prison ships 60px and 65px characters), so the player must
// slice and size sprites from this table instead of assuming 48.
const playerSprite = database.actors?.[system.partyMembers?.[0]] ? { name: database.actors[system.partyMembers[0]].characterName, index: database.actors[system.partyMembers[0]].characterIndex } : null;
if (playerSprite?.name) characterNames.add(playerSprite.name);
const characterFrames = buildCharacterFrames(characterNames);

function buildCharacterFrames(names) {
  const frames = {};
  const dir = join(gameRoot, 'img', 'characters');
  if (!existsSync(dir)) return frames;
  const entries = new Map();
  for (const file of readdirSync(dir)) entries.set(decodedName(file).replace(/\.[^.]+$/, ''), file);
  for (const name of names) {
    const file = entries.get(name);
    if (!file) { console.warn(`MWGP convert: character sheet ${name} not found in img/characters; sprite falls back to 48px cells`); continue; }
    const size = pngDimensions(join(dir, file), file);
    if (!size) { console.warn(`MWGP convert: cannot read dimensions of character sheet ${file}; sprite falls back to 48px cells`); continue; }
    const sign = name.match(/^[\!\$]+/)?.[0] || '';
    const big = sign.includes('$');
    const cols = big ? 3 : 12, rows = big ? 4 : 8;
    if (size.w % cols || size.h % rows) console.warn(`MWGP convert: character sheet ${file} is ${size.w}x${size.h}, not divisible into ${cols}x${rows}; cells round down`);
    frames[name] = { big, object: sign.includes('!'), fw: Math.floor(size.w / cols), fh: Math.floor(size.h / rows) };
  }
  return frames;
}

function pngDimensions(path, file) {
  // Header-only read: plain PNGs carry IHDR at bytes 16/20. Encrypted sheets
  // go through the same decodeRpgmAsset header path as conversion itself, so
  // no second decryption scheme can drift out of sync.
  try {
    const head = readFileSync(path).subarray(0, 64);
    const bytes = decodeRpgmAsset(head, file, system.encryptionKey);
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  } catch { /* handled below */ }
  return null;
}

await mkdir(join(output, 'data'), { recursive: true });
// Foreground art follows files actually present, so the validator's
// decoded-root check stays honest when the source folder is absent.
// Window.png (192x192) is the skin of every window. It is decoded whenever the assets are (never turning an in-place
// conversion into a decoded one), and the player applies it to the dialogue and menu windows.
const windowSkinFile = ['Window.png', 'Window.rpgmvp', 'Window.png_'].map(name => join(gameRoot, 'img', 'system', name)).find(existsSync);
const decodedAssets = copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio || balloonUsed;
const windowSkinAvailable = Boolean(windowSkinFile) && decodedAssets;
// The game font. MZ names it in System.json (advanced.mainFontFilename, advanced.fontSize); MV declares
// `@font-face { font-family: GameFont; src: url(file) }` in fonts/gamefont.css and draws at 28. Only the one file the
// game itself uses is copied (fonts/ can hold many). It is applied when the assets are decoded, like the window skin.
function findGameFont() {
  const fontsDir = join(gameRoot, 'fonts');
  let file = system.advanced?.mainFontFilename;
  if (!file && existsSync(join(fontsDir, 'gamefont.css'))) {
    const css = readFileSync(join(fontsDir, 'gamefont.css'), 'utf8');
    const face = css.match(/@font-face\s*\{[^}]*font-family:\s*["']?GameFont["']?\s*;[^}]*\}/i)?.[0];
    file = face?.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1];
  }
  if (!file || !existsSync(join(fontsDir, file))) return null;
  return { file, size: Number(system.advanced?.fontSize || 28), fallback: String(system.advanced?.fallbackFonts || 'sans-serif') };
}
const gameFont = decodedAssets ? findGameFont() : null;
const foregroundParallaxesAvailable = foregroundNames.size > 0 && (copyAssets || existsSync(join(gameRoot, 'img', 'parallaxes')));
const manifest = {
  format: 'MWGP',
  converter: { version: CONVERTER_VERSION },   // keep it this early in the file: readManifestConverterVersion reads only the first bytes
  version: 1,
  source: { engine: engineKind, projectName: basename(source), convertedAt: new Date().toISOString() },
  display: { title: system.gameTitle || basename(source), width: system.advanced?.screenWidth || 816, height: system.advanced?.screenHeight || 624, ...(gameFont ? { font: { file: gameFont.file, family: 'GameFont', size: gameFont.size, fallback: gameFont.fallback } } : {}) },
  initialMapId: startMap?.id || null,
  player: startMap ? { mapId: startMap.id, x: startMap.id === system.startMapId ? system.startX : 1, y: startMap.id === system.startMapId ? system.startY : 1 } : null,
  assets: { windowSkin: windowSkinAvailable, root: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio || balloonUsed || animationSpriteNames.size || foregroundParallaxesAvailable ? 'assets' : gameRoot, kind: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio || balloonUsed || animationSpriteNames.size || foregroundParallaxesAvailable ? 'decoded' : 'source', tilesets: copyTilesets, characters: copyCharacters, faces: copyFaces, pictures: copyPictures, audio: copyAudio, system: balloonUsed, animations: animationSpriteNames.size > 0, parallaxes: foregroundParallaxesAvailable, encryption: system.encryptionKey ? 'rpgm' : 'none' },
  tilesets: database.tilesets,
  playerSprite,
  initialParty: Array.isArray(system.partyMembers) ? system.partyMembers.map(Number).filter(Number.isInteger) : [],
  titleScreen: { title1: String(system.title1Name || ''), title2: String(system.title2Name || ''), drawTitle: system.optDrawTitle !== false, commandOffset: { x: Number(system.titleCommandWindow?.offsetX || 0), y: Number(system.titleCommandWindow?.offsetY || 0) }, titleBgm: system.titleBgm ? { name: String(system.titleBgm.name || ''), volume: Number(system.titleBgm.volume ?? 100), pitch: Number(system.titleBgm.pitch ?? 100), pan: Number(system.titleBgm.pan ?? 0) } : null, commands: { newGame: system.titleCommandWindow?.newGame !== false, continue: system.titleCommandWindow?.continue_ !== false, options: system.titleCommandWindow?.options !== false }, assets: titleAssetsAvailable ? { root: 'assets', kind: 'decoded' } : null },
  vehicles: {
    boat: system.boat ? { characterName: system.boat.characterName || 'Vehicle', characterIndex: Number(system.boat.characterIndex || 0), mapId: Number(system.boat.startMapId || 0), x: Number(system.boat.startX || 0), y: Number(system.boat.startY || 0) } : null,
    ship: system.ship ? { characterName: system.ship.characterName || 'Vehicle', characterIndex: Number(system.ship.characterIndex || 1), mapId: Number(system.ship.startMapId || 0), x: Number(system.ship.startX || 0), y: Number(system.ship.startY || 0) } : null,
    airship: system.airship ? { characterName: system.airship.characterName || 'Vehicle', characterIndex: Number(system.airship.characterIndex || 2), mapId: Number(system.airship.startMapId || 0), x: Number(system.airship.startX || 0), y: Number(system.airship.startY || 0) } : null
  },
  characterFrames,
  plugins: pluginNames,
  ...(pluginLibrary ? { pluginLibrary } : {}),
  compatibility: { source: engineKind, commands: buildCompatibilityReport(commandCounts), plugins: buildPluginCompatibilityReport(pluginFamilyCounts, pluginLibrary) },
  commonEvents: convertedCommonEvents,
  maps,
  database
};
phase.end();
phase = progress.phase('decoding assets', 62, copyAssets ? countFiles(join(gameRoot, 'img')) + countFiles(join(gameRoot, 'audio')) : copyTilesets ? countFiles(join(gameRoot, 'img', 'tilesets')) : 1);
if (titleAssetsAvailable) {
  await decodeTree(join(gameRoot, 'img', 'titles1'), join(output, 'assets', 'img', 'titles1'), system.encryptionKey);
  await decodeTree(join(gameRoot, 'img', 'titles2'), join(output, 'assets', 'img', 'titles2'), system.encryptionKey);
}
if (copyAssets) {
  await decodeTree(join(gameRoot, 'img'), join(output, 'assets', 'img'), system.encryptionKey);
  await decodeTree(join(gameRoot, 'audio'), join(output, 'assets', 'audio'), system.encryptionKey);
} else if (copyTilesets) {
  await decodeTree(join(gameRoot, 'img', 'tilesets'), join(output, 'assets', 'img', 'tilesets'), system.encryptionKey);
}
phase.end();
phase = progress.phase('decoding referenced assets', 3);
if (copyCharacters) await decodeTree(join(gameRoot, 'img', 'characters'), join(output, 'assets', 'img', 'characters'), system.encryptionKey);
if (copyFaces) await decodeTree(join(gameRoot, 'img', 'faces'), join(output, 'assets', 'img', 'faces'), system.encryptionKey);
// Balloon art lives in img/system (decoded only when a balloon command was
// converted; the directory is small) and animation cells in img/animations
// (only the sheets referenced by converted animation ids).
if (balloonUsed && !copyAssets) await decodeTree(join(gameRoot, 'img', 'system'), join(output, 'assets', 'img', 'system'), system.encryptionKey);
if (animationSpriteNames.size && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'animations'), join(output, 'assets', 'img', 'animations'), animationSpriteNames, system.encryptionKey);
if (copyPictures && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'pictures'), join(output, 'assets', 'img', 'pictures'), pictureNames, system.encryptionKey);
// Foreground art lives in img/parallaxes; like balloon/system art it is small,
// so decode what the map notes reference even without a copy flag.
if (foregroundParallaxesAvailable && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'parallaxes'), join(output, 'assets', 'img', 'parallaxes'), foregroundNames, system.encryptionKey);
// Movies are plain files (no MV encryption) and play only when an event asks, so copy just those named.
for (const level of [1, 2]) if (battlebackNames[level].size) await decodeNamedTree(join(gameRoot, 'img', `battlebacks${level}`), join(output, 'assets', 'img', `battlebacks${level}`), battlebackNames[level], system.encryptionKey);
if (gameFont) {
  await mkdir(join(output, 'assets', 'fonts'), { recursive: true });
  await writeFile(join(output, 'assets', 'fonts', gameFont.file), await readFile(join(gameRoot, 'fonts', gameFont.file)));
}
if (windowSkinAvailable && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'system'), join(output, 'assets', 'img', 'system'), new Set(['Window']), system.encryptionKey);
if (movieNames.size) await decodeNamedTree(join(gameRoot, 'movies'), join(output, 'assets', 'movies'), movieNames, system.encryptionKey);
if (copyAudio && !copyAssets) {
  await decodeNamedTree(join(gameRoot, 'audio', 'se'), join(output, 'assets', 'audio', 'se'), soundNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'bgm'), join(output, 'assets', 'audio', 'bgm'), musicNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'bgs'), join(output, 'assets', 'audio', 'bgs'), musicNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'me'), join(output, 'assets', 'audio', 'me'), meNames, system.encryptionKey);
}
// Audio index: which file (and format) each named track resolved to in the converted tree.
const audioRoot = join(output, 'assets', 'audio');
if (existsSync(audioRoot)) {
  const index = buildAudioIndex(audioRoot);
  manifest.audio = { index, system: systemAudio };
  const inMusic = name => name in index.bgm || name in index.bgs;
  const missing = [...new Set([
    ...[...musicNames].filter(name => !inMusic(name)).map(name => `bgm|bgs/${name}`),
    ...missingAudio(index, [...meNames].map(name => ({ kind: 'me', name })).concat([...soundNames].map(name => ({ kind: 'se', name }))))
  ])];
  if (missing.length) console.warn(`MWGP convert: ${missing.length} referenced audio file(s) not found in the project: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}`);
}
if (manifest.pluginLibrary) manifest.pluginLibrary = await externalizePluginLibrary(manifest.pluginLibrary, output);
// Compact: pretty-printing pushes the largest projects past V8's maximum string length.
phase.end();
phase = progress.phase('writing the manifest', 5);
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest));
phase.end();
console.log(`Converted ${maps.length} maps and ${pluginNames.length} plugins to ${join(output, 'mwgp.json')}${copyAssets ? ' with assets' : ''}`);
for (const [kind, info] of [...unsupportedBranchFallbacks].sort((a, b) => a[0] - b[0])) {
  if (info.count > 1) console.warn(`MWGP convert: branch type ${kind} fell back ${info.count} times (first at ${info.first}); every site is marked unsupported in the manifest`);
}
for (const [kind, info] of [...unsupportedOperandFallbacks].sort((a, b) => a[0] - b[0])) {
  if (info.count > 1) console.warn(`MWGP convert: variable operand type ${kind} fell back ${info.count} times (first at ${info.first}); every site is marked unsupported in the manifest`);
}
for (const [key, info] of [...unsupportedCommandFallbacks].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
  if (info.count > 1) console.warn(`MWGP convert: event command ${key} fell back ${info.count} times (first at ${info.first}); every site is marked unsupported in the manifest`);
}
if (pluginFamilyCounts.size) {
  const top = [...pluginFamilyCounts].sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 10).map(([name, count]) => `${name} (${count})`).join(', ');
  console.log(`MWGP convert: plugin command families: ${shown}${top.length > 10 ? ` +${top.length - 10} more` : ''}; each runs through the game's own plugin code when the plugin handling it ships`);
}

async function decodeTree(input, destination, encryptionKey) {
  if (!existsSync(input)) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(input, { withFileTypes: true })) {
    const from = join(input, entry.name);
    const targetName = entry.isDirectory() ? entry.name : decodedName(entry.name);
    const to = join(destination, targetName);
    if (entry.isDirectory()) await decodeTree(from, to, encryptionKey);
    else { await writeFile(to, decodeRpgmAsset(await readFile(from), entry.name, encryptionKey)); phase.tick(entry.name); }
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1), 0);
}

async function decodeNamedTree(input, destination, names, encryptionKey) {
  if (!existsSync(input)) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const sourceName = entry.name.replace(ENCRYPTED_EXTENSION, '').replace(/\.[^.]+$/, '');
    if (!names.has(sourceName)) continue;
    const name = decodedName(entry.name);
    const outputName = extname(name) ? name : `${name}${destination.includes(`${sep}audio${sep}`) ? '.ogg' : '.png'}`;
    await writeFile(join(destination, outputName), decodeRpgmAsset(await readFile(join(input, entry.name)), entry.name, encryptionKey));
  }
}

function decodedName(name) {
  return name.replace(/\.rpgmvp$/i, '.png').replace(/\.rpgmvo$/i, '.ogg').replace(/\.rpgmvm$/i, '.m4a')
    .replace(/\.png_$/i, '.png').replace(/\.ogg_$/i, '.ogg').replace(/\.m4a_$/i, '.m4a');
}

function decodeRpgmAsset(bytes, name, encryptionKey) {
  if (!ENCRYPTED_EXTENSION.test(name) || bytes.length < 16 || !encryptionKey) return bytes;
  const key = Buffer.from(encryptionKey, 'hex');
  if (!key.length) return bytes.subarray(16);
  const result = Buffer.from(bytes.subarray(16));
  // MV's encryption header protects only the first 16 payload bytes. The
  // remaining bytes are already in their original form and must be copied as-is.
  for (let i = 0; i < Math.min(16, result.length); i++) result[i] ^= key[i % key.length];
  return result;
}

function buildCompatibilityReport(counts) {
  const supported = new Set([
    301, 331, 332, 333, 334, 336, 351, 0, 101, 102, 105, 108, 112, 113, 115, 117, 118, 119, 121, 123, 125, 126, 127, 128, 129, 135,
    201, 202, 203, 204, 211, 212, 335, 213, 214, 221, 222, 223, 224, 225, 230, 231, 232, 234, 235, 241, 242, 243,
    244, 245, 246, 249, 250, 251, 311, 313, 314, 316, 318, 319, 321, 322,
    124, 132, 133, 134, 139, 206, 261, 312, 315, 317, 320, 324, 325, 326, 339, 354,
    104, 233, 282, 283, 284, 285, 340, 342,
    103, 401, 402, 403, 404, 405, 408, 411, 412, 413, 236, 302, 303, 352, 353, 505, 601, 602, 603, 604, 605, 655
  ]);
  // 108 (Comment) and 505 (a Set Movement Route step's editor-only sibling entry, already
  // folded into code 205's own parameters.list) are correctly handled by doing nothing.
  // 408 (Comment body lines, verified 1681/1681 under a 108 across both MV projects)
  // likewise produces no commands.
  // 231 is fully covered (show/move/tint); 233 Rotate Picture has zero uses in
  // the corpus and stays unsupported on its own.
  // 405 lines under a 105 convert into the scroll command (unit F); orphaned
  // 405s are plugin data lines and stay dropped.
  // 135 (menu access) and 134 (save access) are honoured: Esc/X and the menu's Save entry check them.
  // 111 is partial: switch, variable, self-switch, actor-in-party, player/own
  // facing, gold, and item conditions are preserved (verified against the
  // shipped command111), while timer, enemy, button, vehicle, and other
  // engine-specific condition kinds convert to an explicit unsupported marker
  // the player warns on and evaluates as false instead of dropping the block.
  // 355 is preserved and executed through the bounded MV globals shim; it is
  // partial because arbitrary RPG Maker JavaScript/API calls may still fail.
  // 356 is partial: it runs the game's own plugin code, which may reach the
  // scene/window layer the player does not load.
  // 357 is MZ's structured equivalent and converts to the same vocabulary.
  // 351 opens the player's menu (Item/Skill/Equip/Status/Save/Options), 301 runs the troop battle runner
  // (src/player/battle.js), 331-334/336 act on the battle's enemies: all supported, within the limits
  // documented in AGENTS.md (no battle graphics, no plugin damage engines).
  // 352 is supported through the player's slot-1 save path.
  // 337 draws no animation (battles have none). 136/137/138/140/216/217/281/323 are stored as system settings (rpgExtra.system) that nothing in this
  // player consumes yet: there are no random encounters, formation screen, followers, map name window or
  // vehicle art, and window colours are not applied.
  const partial = new Set([111, 122, 205, 355, 356, 357, 136, 137, 138, 140, 216, 217, 281, 323, 337]);
  // Keep the report honest for each project. These command families are only
  // partial when this conversion actually had to emit a loud fallback for one
  // of their shapes; otherwise a game that uses only the supported subset
  // should not warn about scenes that are fully executable here.
  if (!unsupportedBranchFallbacks.size) { partial.delete(111); supported.add(111); }
  if (!unsupportedOperandFallbacks.size) { partial.delete(122); supported.add(122); }
  if (![...unsupportedCommandFallbacks.keys()].some(key => key.startsWith('205:'))) { partial.delete(205); supported.add(205); }
  return Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), {
    count,
    status: supported.has(code) ? 'supported' : partial.has(code) ? 'partial' : 'unsupported'
  }]));
}

// A plugin command runs through the game's own plugin code (its `pluginCommand` override, or the MZ command it
// registers), so it is partial when the plugin that handles it ships in the plugin library (the plugin may still
// reach the scene/window layer this player does not load) and unsupported when nothing shipped handles it.
function buildPluginCompatibilityReport(counts, library) {
  const shipped = new Set(library?.order || []);
  const handlersOf = name => {
    const mzPlugin = mzCommandPlugin.get(name);
    if (mzPlugin) return shipped.has(mzPlugin) ? [mzPlugin] : [];
    return library?.commandHandlers?.[name.toLowerCase()] || [];
  };
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => {
    const handledBy = handlersOf(name);
    return [name, { count, status: handledBy.length ? 'partial' : 'unsupported', ...(handledBy.length ? { handledBy } : {}) }];
  }));
}
