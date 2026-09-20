import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg || !outputArg) {
  console.error('Usage: node tools/convert-mv.js <RPGM project> <MWGP output>');
  process.exit(1);
}

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
// the event list — Karryn's Prison (Remtairy) references www/loc/RemMap_EN.json
// entries as \REM_MAP[key] text codes (plus \REM_EFF / \REM_DESC from their own
// tables), resolved by the plugin at display time. The converter resolves them
// the same way: each entry's text lines join with \n, a missing key becomes
// 'REM_MAP <id>' with one warning — exactly what the engine itself prints
// (RemtairyMisc.js TextManager.remMiscMapText / getLocalizedText fallback).
// Only activates when the files exist; anything else is untouched.
const textTables = (() => {
  const tables = [];
  for (const [code, file] of [['REM_MAP', 'RemMap_EN.json'], ['REM_EFF', 'RemEff.json'], ['REM_DESC', 'RemDesc_EN.json']]) {
    const path = join(gameRoot, 'loc', file);
    if (!existsSync(path)) continue;
    try {
      tables.push({ code, data: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (error) { console.warn(`MWGP convert: unreadable text table ${file}: ${error.message}`); }
  }
  if (tables.length) console.log(`MWGP convert: resolving text codes from ${tables.map(table => table.code).join(', ')}`);
  return tables;
})();
const missingTextKeys = new Set();
function resolveTextTables(text) {
  if (!text || !textTables.length || !text.includes('\\')) return text;
  // The engine re-runs escape conversion over substituted text, so nested
  // codes resolve too; the iteration cap mirrors the story-jump guard style
  // and only bounds malformed self-referential tables.
  for (let round = 0; round < 5 && /\\REM_(MAP|EFF|DESC)\[/i.test(text); round++) {
    text = text.replace(/\\REM_(MAP|EFF|DESC)\[(\w+)\]/gi, (match, code, key) => {
      // The capture is the suffix (MAP/EFF/DESC); table codes carry the REM_ prefix.
      const fullCode = `REM_${code.toUpperCase()}`;
      const entry = textTables.find(table => table.code === fullCode)?.data[key];
      if (!entry?.text) {
        if (!missingTextKeys.has(match)) { missingTextKeys.add(match); console.warn(`MWGP convert: no text-table entry for ${match}; using the engine's missing-key text`); }
        return `${fullCode} ${key}`;
      }
      return entry.text.join('\n');
    });
  }
  return text;
}
const commandCounts = new Map();
const characterNames = new Set();
const pictureNames = new Set();
const soundNames = new Set();
const musicNames = new Set();
const animationIds = new Set();
const meNames = new Set();
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
const mapInfos = await readJson('MapInfos.json');
const commonEvents = await readJson('CommonEvents.json', true) || [];
const maps = [];
for (const name of readdirSync(dataDir).filter(name => /^Map\d+\.json$/i.test(name)).sort()) {
  const id = Number(name.match(/\d+/)[0]);
  const data = await readJson(name);
  if (data.bgm?.name) musicNames.add(data.bgm.name);
  if (data.bgs?.name) musicNames.add(data.bgs.name);
  for (const event of data.events || []) for (const page of event?.pages || []) for (const command of page.list || []) commandCounts.set(command.code, (commandCounts.get(command.code) || 0) + 1);
  maps.push({ id, info: mapInfos[id] || null, data, mwgEvents: data.events.filter(Boolean).map(event => convertEvent(event, id)) });
}

const configuredStartMap = maps.find(map => map.id === system.startMapId);
const startMap = configuredStartMap?.data?.data?.some(tile => tile > 0)
  ? configuredStartMap
  : maps.find(map => map.data?.data?.some(tile => tile > 0)) || configuredStartMap;

function convertEvent(event, mapId) {
  return { id: String(event.id), x: event.x, y: event.y, pages: (event.pages || []).map(page => {
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

function convertConditions(conditions = {}, mapId, eventId) {
  const result = [];
  if (conditions.switch1Valid) result.push({ switch: String(conditions.switch1Id), equals: true });
  if (conditions.switch2Valid) result.push({ switch: String(conditions.switch2Id), equals: true });
  if (conditions.variableValid) result.push({ variable: String(conditions.variableId), atLeast: conditions.variableValue });
  if (conditions.selfSwitchValid) result.push({ switch: selfSwitchKey(mapId, eventId, conditions.selfSwitchCh || 'A'), equals: true });
  return result;
}

function convertCommands(list, context = {}) {
  const { mapId, eventId, depth = 0 } = context;
  // Labels (118) split the top-level list into named story passages; jumps
  // (119) become { goto } markers the player's story driver follows. Labels
  // nested inside blocks are dropped with a warning: splitting there would
  // break the block structure, and no corpus project uses one.
  const story = { start: 'main', passages: {} };
  let current = 'main';
  // Inlined common events (depth > 0) must stay flat arrays for spreading, so
  // only page-level lists split into passages.
  const parsed = parseBlock(0, -1, depth === 0);
  story.passages[current] = parsed.commands;
  if (Object.keys(story.passages).length > 1) return { story };
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
        if (!topLevel) console.warn(`MWGP convert: label "${name}" nested in a block (map ${mapId}, event ${eventId}) cannot split passages; dropping it`);
        else {
          if (story.passages[name]) console.warn(`MWGP convert: duplicate label "${name}" (map ${mapId}, event ${eventId}); later passage wins`);
          story.passages[current] = result;
          current = name;
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
        const condition = convertBranchCondition(command.parameters || []);
        const thenBlock = parseBlock(index + 1, command.indent);
        index = thenBlock.index;
        let elseCommands;
        if (thenBlock.marker === 411) {
          const elseBlock = parseBlock(index + 1, command.indent);
          elseCommands = elseBlock.commands;
          index = elseBlock.index;
        }
        if (condition) result.push({ if: condition, then: thenBlock.commands, ...(elseCommands ? { else: elseCommands } : {}) });
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
      if (command.code === 301) {
        const battle = convertCommand(command, { portrait, depth, mapId, eventId })?.[0]?.battle;
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
        result.push({ script });
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
      const converted = convertCommand(command, { portrait, depth, mapId, eventId });
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
    // runtime; game-data (3) and script (4) operands need engine evaluation, so those are skipped.
    if (operandType > 2) return [];
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
  // resolveRouteStep interprets; speed/frequency/anim/fix/through/image/blend
  // steps (29-38, 41, 43) have no player-side equivalent and stay dropped,
  // keeping code 205 partial.
  if (command.code === 205) {
    const rawTarget = Number(command.parameters?.[0]);
    const routeTarget = rawTarget === -1 ? 'player'
      : rawTarget === 0 && context.eventId != null ? `event:${context.eventId}`
        : rawTarget > 0 ? `event:${rawTarget}` : null;
    if (!routeTarget) return [];
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
      else if (step.code === 39) { routeOnly = false; commands.push({ setTransparent: true }); }
      else if (step.code === 40) { routeOnly = false; commands.push({ setTransparent: false }); }
      else if (step.code === 42) { routeOnly = false; commands.push({ setTransparent: Math.max(0, Math.min(1, Number(step.parameters?.[0] ?? 255) / 255)) }); }
      else if (step.code === 44) {
        routeOnly = false;
        const se = step.parameters?.[0];
        if (se?.name) {
          soundNames.add(se.name);
          commands.push({ sound: { name: se.name, volume: Number(se.volume ?? 90), pitch: Number(se.pitch ?? 100), pan: Number(se.pan || 0) } });
        }
      } else if (step.code === 45 && step.parameters?.[0]) { routeOnly = false; commands.push({ script: String(step.parameters[0]) }); }
      else if (step.code !== 0) routeOnly = false;
    }
    if (route.repeat && routeOnly && repeatableSteps.length) return [{ move: { target: routeTarget, steps: repeatableSteps, repeat: true, skippable: route.skippable === true, wait: route.wait === true } }];
    if (commands.length) return commands;
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
  if (command.code === 204) {
    const [direction, distance, speed] = command.parameters || [];
    return [{ scrollMap: { direction: Number(direction || 2), distance: Number(distance || 0), speed: Number(speed ?? 4) } }];
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
    if (Number(designation || 0) !== 0) return [];
    return [{ relocate: { target: resolved, x: Number(a || 0), y: Number(b || 0), ...(facing ? { facing } : {}) } }];
  }
  // Actor commands address MV's iterateActorEx scope: 0 = entire party,
  // 1 = specific actor id, 2 = actor id read from a variable at runtime.
  if (command.code === 313) {
    const [scope, actor, mode, state] = command.parameters || [];
    return [{ changeState: { scope: Number(scope || 0), actor: Number(actor || 0), add: Number(mode || 0) === 0, state: Number(state || 0) } }];
  }
  if (command.code === 314) {
    const [scope, actor] = command.parameters || [];
    return [{ recoverAll: { scope: Number(scope || 0), actor: Number(actor || 0) } }];
  }
  if (command.code === 318) {
    const [scope, actor, mode, skill] = command.parameters || [];
    return [{ changeSkill: { scope: Number(scope || 0), actor: Number(actor || 0), learn: Number(mode || 0) === 0, skill: Number(skill || 0) } }];
  }
  if (command.code === 319) {
    const [actor, slot, item] = command.parameters || [];
    return [{ changeEquipment: { actor: Number(actor || 0), slot: Number(slot || 0), item: Number(item || 0) } }];
  }
  if (command.code === 322) {
    const [actor, profile] = command.parameters || [];
    return [{ changeProfile: { actor: Number(actor || 0), profile: String(profile || '') } }];
  }
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
  if (command.code === 356 && command.parameters?.[0]) {
    const raw = String(command.parameters[0]);
    const parts = raw.trim().split(/\s+/);
    return [{ pluginCommand: { raw, name: parts[0] || '', args: parts.slice(1) } }];
  }
  if (command.code === 117 && context.depth < 8) {
    const commonEvent = commonEvents[Number(command.parameters?.[0])];
    return commonEvent?.list ? convertCommands(commonEvent.list, { ...context, depth: context.depth + 1 }) : [];
  }
  if (command.code === 201 && command.parameters?.[0] === 0) return [{ transfer: { mapId: command.parameters[1], x: command.parameters[2], y: command.parameters[3] } }];
  return [];
}

function convertBranchCondition(parameters) {
  if (parameters[0] === 0) return { switch: String(parameters[1]), equals: parameters[2] === 0 };
  if (parameters[0] === 1) {
    const operator = { 0: 'gte', 1: 'lte', 2: 'eq', 3: 'gt', 4: 'lt', 5: 'neq' }[Number(parameters[4] ?? 0)];
    if (!operator) return null;
    if (Number(parameters[2] || 0) === 0) {
      return operator === 'gte'
        ? { variable: String(parameters[1]), atLeast: Number(parameters[3] || 0) }
        : { variable: String(parameters[1]), operator, value: Number(parameters[3] || 0) };
    }
    return { variable: String(parameters[1]), operator, compareVariable: String(parameters[3]) };
  }
  return null;
}

const databaseFiles = ['Actors.json', 'Classes.json', 'Skills.json', 'Items.json', 'Weapons.json', 'Armors.json', 'Enemies.json', 'Troops.json', 'States.json', 'Animations.json', 'Tilesets.json', 'CommonEvents.json'];
const database = {};
for (const name of databaseFiles) database[name.replace('.json', '').toLowerCase()] = await readJson(name, true);

const pluginsPath = join(gameRoot, 'js', 'plugins.js');
const pluginsText = existsSync(pluginsPath) ? await readFile(pluginsPath, 'utf8') : '';
const pluginNames = [...pluginsText.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(match => match[1]);

// Animation sprite sheets resolve only now that the database is loaded.
const animationSpriteNames = new Set();
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
const manifest = {
  format: 'MWGP',
  version: 1,
  source: { engine: engineKind, projectName: basename(source), convertedAt: new Date().toISOString() },
  display: { title: system.gameTitle || basename(source), width: system.advanced?.screenWidth || 816, height: system.advanced?.screenHeight || 624 },
  initialMapId: startMap?.id || null,
  player: startMap ? { mapId: startMap.id, x: startMap.id === system.startMapId ? system.startX : 1, y: startMap.id === system.startMapId ? system.startY : 1 } : null,
  assets: { root: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio || balloonUsed || animationSpriteNames.size ? 'assets' : gameRoot, kind: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio || balloonUsed || animationSpriteNames.size ? 'decoded' : 'source', tilesets: copyTilesets, characters: copyCharacters, faces: copyFaces, pictures: copyPictures, audio: copyAudio, system: balloonUsed, animations: animationSpriteNames.size > 0, encryption: system.encryptionKey ? 'rpgm' : 'none' },
  tilesets: database.tilesets,
  playerSprite,
  characterFrames,
  plugins: pluginNames,
  compatibility: { source: engineKind, commands: buildCompatibilityReport(commandCounts) },
  maps,
  database
};
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest, null, 2));
if (copyAssets) {
  await decodeTree(join(gameRoot, 'img'), join(output, 'assets', 'img'), system.encryptionKey);
  await decodeTree(join(gameRoot, 'audio'), join(output, 'assets', 'audio'), system.encryptionKey);
} else if (copyTilesets) {
  await decodeTree(join(gameRoot, 'img', 'tilesets'), join(output, 'assets', 'img', 'tilesets'), system.encryptionKey);
}
if (copyCharacters) await decodeTree(join(gameRoot, 'img', 'characters'), join(output, 'assets', 'img', 'characters'), system.encryptionKey);
if (copyFaces) await decodeTree(join(gameRoot, 'img', 'faces'), join(output, 'assets', 'img', 'faces'), system.encryptionKey);
// Balloon art lives in img/system (decoded only when a balloon command was
// converted; the directory is small) and animation cells in img/animations
// (only the sheets referenced by converted animation ids).
if (balloonUsed && !copyAssets) await decodeTree(join(gameRoot, 'img', 'system'), join(output, 'assets', 'img', 'system'), system.encryptionKey);
if (animationSpriteNames.size && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'animations'), join(output, 'assets', 'img', 'animations'), animationSpriteNames, system.encryptionKey);
if (copyPictures && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'pictures'), join(output, 'assets', 'img', 'pictures'), pictureNames, system.encryptionKey);
if (copyAudio && !copyAssets) {
  await decodeNamedTree(join(gameRoot, 'audio', 'se'), join(output, 'assets', 'audio', 'se'), soundNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'bgm'), join(output, 'assets', 'audio', 'bgm'), musicNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'bgs'), join(output, 'assets', 'audio', 'bgs'), musicNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'me'), join(output, 'assets', 'audio', 'me'), meNames, system.encryptionKey);
}
console.log(`Converted ${maps.length} maps and ${pluginNames.length} plugins to ${join(output, 'mwgp.json')}${copyAssets ? ' with assets' : ''}`);

async function decodeTree(input, destination, encryptionKey) {
  if (!existsSync(input)) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(input, { withFileTypes: true })) {
    const from = join(input, entry.name);
    const targetName = entry.isDirectory() ? entry.name : decodedName(entry.name);
    const to = join(destination, targetName);
    if (entry.isDirectory()) await decodeTree(from, to, encryptionKey);
    else await writeFile(to, decodeRpgmAsset(await readFile(from), entry.name, encryptionKey));
  }
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
    0, 101, 102, 105, 108, 112, 113, 115, 117, 118, 119, 121, 123, 125, 126, 127, 128, 129,
    201, 203, 204, 211, 212, 213, 214, 221, 222, 223, 224, 225, 230, 231, 232, 234, 235, 241, 242, 243,
    244, 245, 246, 249, 250, 251, 313, 314, 318, 319, 322,
    401, 402, 403, 404, 405, 408, 411, 412, 413, 352, 505, 601, 602, 603, 604, 655
  ]);
  // 108 (Comment) and 505 (a Set Movement Route step's editor-only sibling entry, already
  // folded into code 205's own parameters.list) are correctly handled by doing nothing.
  // 408 (Comment body lines, verified 1681/1681 under a 108 across both MV projects)
  // likewise produces no commands.
  // 231 is fully covered (show/move/tint); 233 Rotate Picture has zero uses in
  // the corpus and stays unsupported on its own.
  // 405 lines under a 105 convert into the scroll command (unit F); orphaned
  // 405s are plugin data lines and stay dropped.
  // 135 (menu access) has nothing to act on — the player has no menu scene —
  // so doing nothing is the correct conversion.
  // 111 is partial: switch and variable conditions are preserved, while timer,
  // actor, item, and other engine-specific condition kinds remain unsupported.
  // 355/356 are preserved as loud runtime warnings, but arbitrary RPG Maker
  // JavaScript and plugin APIs cannot execute outside the original engine.
  // 135/351 request menu scenes that the browser player does not implement;
  // 352 is supported through the player's slot-1 save path.
  const partial = new Set([111, 122, 205, 301]);
  return Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), {
    count,
    status: supported.has(code) ? 'supported' : partial.has(code) ? 'partial' : 'unsupported'
  }]));
}
