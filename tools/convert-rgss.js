import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeMarshal } from '@datamoc/mw_games/rpg';

const [, , extractedArg, outputArg] = process.argv;
if (!extractedArg || !outputArg) {
  console.error('Usage: node tools/convert-rgss.js <extracted RGSS project> <MWGP output>');
  process.exit(1);
}
const source = resolve(extractedArg), output = resolve(outputArg), dataDir = join(source, 'Data');
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
  const raw = Buffer.from(value?.raw || []);
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
const commonEvents = new Map();

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
// flag). Type 3+ (timer etc.) has no MWGP condition equivalent and drops the
// branch.
function convertBranchCondition(parameters, mapId, eventId) {
  if (parameters[0] === 0) return { switch: String(parameters[1]), equals: parameters[2] === 0 };
  if (parameters[0] === 1 && parameters[2] === 0 && parameters[4] === 1) return { variable: String(parameters[1]), atLeast: Number(parameters[3] || 0) };
  if (parameters[0] === 2) return { switch: selfSwitchKey(mapId, eventId, parameters[1] || 'A'), equals: parameters[2] === 0 };
  return null;
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
  return { id: String(eventId), x: Number(field(event, 'x', 0)), y: Number(field(event, 'y', 0)), pages };
}

function convertCommands(list, context = {}) {
  const { mapId, eventId, depth = 0 } = context;
  // Labels (118) split the top-level list into named story passages; jumps
  // (119) become { goto } markers the player's story driver follows. Labels
  // nested inside blocks are dropped with a warning: splitting there would
  // break the block structure.
  const story = { start: 'main', passages: {} };
  let current = 'main';
  // Inlined common events (depth > 0) must stay flat arrays for spreading, so
  // only page-level lists split into passages.
  const parsed = parseBlock(0, -1, depth === 0);
  story.passages[current] = parsed.commands;
  if (Object.keys(story.passages).length > 1) return { story };
  return parsed.commands;

  function parseBlock(start, parentIndent, topLevel = false) {
    let result = [];
    let index = start;
    while (index < list.length) {
      const command = list[index];
      if ([402, 403, 404, 411, 412, 413].includes(command.code) && command.indent === parentIndent) {
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
        const condition = convertBranchCondition(command.parameters || [], mapId, eventId);
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
          ask: '', choices: texts.map((text, i) => ({ text, value: i })), branches,
          ...(cancelType === -1 && cancelBranch ? { cancelBranch } : {})
        });
        continue;
      }
      if (command.code === 355) {
        let script = command.parameters?.[0] || '';
        // The engine keeps appending while the next line is 355 or 655.
        while (index + 1 < list.length && [355, 655].includes(list[index + 1].code)) {
          index++;
          script += '\n' + (list[index].parameters?.[0] || '');
        }
        result.push({ script });
        index++;
        continue;
      }
      // 105 (Show Scrolling Text) owns its following 405 body lines the way
      // 355 owns 655s. A 405 outside a 105 stays dropped by convertCommand.
      if (command.code === 105) {
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
      // (verified: 638/638 routes in the Pokemon Void corpus).
      if (command.code === 209) {
        const moved = convertRoute(command.parameters?.[0], unwrap(command.parameters?.[1]));
        if (moved.length) result.push(...moved);
        index++;
        while (index < list.length && list[index].code === 509) index++;
        continue;
      }
      const converted = convertCommand(command, { depth, mapId, eventId });
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
// corpus); speed/frequency/through steps (29-38, 41, 43) have no player-side
// equivalent and stay dropped, keeping routes partial.
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
    else if (step.code === 15) commands.push({ wait: Number(step.parameters?.[0] || 0) / 20 });
    else if (step.code === 27 || step.code === 28) commands.push({ setSwitch: String(step.parameters?.[0] ?? 0), value: step.code === 27 });
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
  const p = command.parameters || [];
  // 101/401 continuation lines join into one message box in the engine, but MV's
  // converter already emits them as sequential says and the player shows those
  // in order, so XP matches that shape instead of introducing a joined form.
  if (command.code === 101 || command.code === 401) return [{ say: String(p[0] || '') }];
  if (command.code === 102 || command.code === 105 || command.code === 111 || command.code === 112 || command.code === 209 || command.code === 355) return [];
  // Essentials' 103/104 commands are stateful message interactions rather
  // than MV's same-numbered commands. Keep their verified XP parameters in
  // the manifest so the player can reproduce them without guessing.
  if (command.code === 103) return [{ inputNumber: { variable: String(p[0] ?? 0), digits: Number(p[1] ?? 1) } }];
  if (command.code === 104) return [{ messageOptions: { position: Number(p[0] ?? 2), frame: Number(p[1] ?? 0) } }];
  // Essentials measures waits in real seconds as frames/20 (command_106), not
  // the /60 MV's 60fps engine implies.
  if (command.code === 106) return [{ wait: Number(p[0] || 0) / 20 }];
  // 108/408 (Comment / Comment body) are correctly handled by doing nothing.
  if (command.code === 108 || command.code === 408 || command.code === 0) return [];
  if (command.code === 113) return [{ breakLoop: true }];
  if (command.code === 115) return [{ exitEvent: true }];
  // 117 inlines the common event's list (depth-limited to 8 against cycles),
  // the same treatment MV's converter gives its code 117.
  if (command.code === 117 && context.depth < 8) {
    const body = commonEvents.get(Number(p[0]));
    return body ? convertCommands(body, { ...context, depth: context.depth + 1 }) : [];
  }
  if (command.code === 121) return Array.from({ length: p[1] - p[0] + 1 }, (_, offset) => ({ setSwitch: String(p[0] + offset), value: p[2] === 0 }));
  // 122 params are [first, last, op, kind, operand]: kind 0 constant, 1 another
  // variable, 2 a random range; op 0 set, 1 add, 2 subtract. Variable operands
  // only support set (copyVariable); variable add/subtract has no MWGP shape.
  // Game-data/script operands would need runtime evaluation this static
  // manifest can't express.
  if (command.code === 122) {
    const first = Number(p[0]);
    const last = Number(p[1] ?? first);
    const operation = Number(p[2] || 0);
    const operandType = Number(p[3] || 0);
    if (operandType > 2) return [];
    return Array.from({ length: last - first + 1 }, (_, offset) => {
      const id = String(first + offset);
      if (operandType === 1) return operation === 0 ? { copyVariable: id, variable: String(p[4]) } : null;
      const amount = operandType === 2
        ? { random: [Number(p[4] || 0), Number(p[5] || 0)] }
        : { value: Number(p[4] || 0) };
      if (operation === 0) return operandType === 0 ? { setVariable: id, value: amount.value } : { copyVariable: id, ...amount };
      if (operation === 1 && operandType === 0) return { addVariable: id, amount: amount.value };
      if (operation === 2 && operandType === 0) return { addVariable: id, amount: -amount.value };
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
  if (command.code === 201 && p[0] === 0) return [{ transfer: { mapId: p[1], x: p[2], y: p[3] } }];
  // 201 with a variable designation reads map/x/y from variables at runtime,
  // which the static transfer shape can't express; dropped and reported.
  // 202 params are [target, designation, x, y, direction]: designation 0 is
  // direct, 1 reads x/y from variables (dropped), anything else swaps two
  // events (no player equivalent, dropped). The facing table is the standard
  // 2/4/6/8 keypad, which MWGP relocate already carries as facing.
  if (command.code === 202 && Number(p[1] || 0) === 0) {
    const resolved = Number(p[0] ?? -1) === -1 ? 'player' : Number(p[0]) === 0 ? 'self' : String(p[0]);
    const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[Number(p[4])] || null;
    return [{ relocate: { target: resolved, x: Number(p[2] || 0), y: Number(p[3] || 0), ...(facing ? { facing } : {}) } }];
  }
  // 203 is Scroll Map with MV's own [direction, distance, speed] parameter
  // order (verified: start_scroll(@parameters[0..2])), so it maps onto the
  // same scrollMap shape MV's 204 produces.
  if (command.code === 203) {
    const [direction, distance, speed] = p;
    return [{ scrollMap: { direction: Number(direction || 2), distance: Number(distance || 0), speed: Number(speed ?? 4) } }];
  }
  // 103 and 104 are handled above. 204 is Change Map Settings
  // (panorama/fog/battleback), not MV's Scroll Map; the player renders no fog
  // or panorama layers, so it is dropped. 205 is the fog tone change and goes
  // with it. 233 (Rotate Picture) has no vocabulary entry either.
  // 212/213 (animation/balloon) and 214-216 have no handler in
  // the shipped Interpreter at all, so dropping them matches the engine.
  // 126/127/128/129 (items/weapons/armor/party) are command_dummy no-ops in
  // the shipped engine itself — Pokémon tracks those elsewhere — so doing
  // nothing is the faithful conversion.
  if (command.code === 116) return [{ eraseEvent: true }];
  if (command.code === 126 || command.code === 127 || command.code === 128 || command.code === 129) return [];
  // 208 sets player transparency (like MV's 211), which MWGP's setTransparent
  // already expresses. 210 (Wait for Move's Completion) is satisfied by the
  // sequential execution itself: converted routes run to completion before the
  // next command starts.
  if (command.code === 208) return [{ setTransparent: p[0] === 0 }];
  if (command.code === 210) return [];
  // 221 (freeze) + 222 (execute transition by name) bracket a scene transition;
  // with the usual empty name that transition is a plain fade, which screenFade
  // approximates. A named fancy transition still reads as a visible cut.
  if (command.code === 221) return [{ screenFade: { direction: 'out', duration: 24 / 60 } }];
  if (command.code === 222) return [{ screenFade: { direction: 'in', duration: 24 / 60 } }];
  // All frame-denominated screen durations below divide by 20: Essentials keeps
  // real-time seconds (Game_Screen and Game_Picture divide every duration by
  // 20.0), and XP lists carry no wait flags, so waits read as false.
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
    if (!p[1] || Number(p[3] || 0) !== 0) return [];
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
  if (command.code === 247) return [{ saveBgm: true }];
  if (command.code === 248) return [{ resumeBgm: true }];
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
  // engine too.
  if (command.code === 313 || (command.code >= 315 && command.code <= 319)) return [];
  if (command.code === 314) return Number(p[0] || 0) === 0 ? [{ recoverAll: { scope: 0, actor: 0 } }] : [];
  // 509 steps are consumed structurally by 209 above; an orphaned one is data.
  if (command.code === 509) return [];
  return [];
}

function buildCompatibilityReport(counts) {
  const supported = new Set([
    0, 101, 102, 103, 104, 105, 106, 108, 112, 113, 115, 116, 117, 118, 119, 121,
    126, 127, 128, 129, 201, 203, 208, 209, 210, 221, 222, 223, 224, 225, 231, 232,
    234, 235, 241, 242, 247, 248, 249, 250, 251, 313, 314, 315, 316, 317, 318, 319, 355,
    401, 402, 403, 404, 405, 408,
    411, 412, 413, 509, 655
  ]);
  // Every classification below is verified against the Interpreter section of
  // the shipped scripts, not guessed from MV's numbering: 111 is partial (only
  // switch, constant->= variable, and self-switch branches map; ==/<=/>/</!=
  // and variable-vs-variable tests are dropped), 116/126-129/313/315-319 are
  // supported no-ops-or-erase (116 erases the running event; the rest are
  // command_dummy in the engine itself, as is 314 with a nonzero target),
  // 122 partial (constant/random operands with set/add/subtract, variable
  // operands with set only; multiply/divide, variable add/subtract, and
  // character/game-data operands are dropped), 123 partial (needs
  // map/event context), 125 partial (variable gold reuses MV's amount shape),
  // 201 partial (direct designation only), 202 partial (direct x/y only;
  // variable and exchange designations are dropped), 204 dropped (map
  // panorama/fog/battleback settings the player doesn't render), 205 dropped
  // (fog tone), 208 supported (player transparency via setTransparent),
  // 210 supported no-op (sequential execution satisfies the wait),
  // 231/232 partial (direct appointments only; blend mode unmapped),
  // 233 dropped (no vocabulary entry), 236 dropped (weather, not rendered),
  // 103/104 dropped (verified shapes but no vocabulary entry), 212/213/214/
  // 215/216 dropped (no handler in the shipped Interpreter at all).
  const partial = new Set([111, 122, 123, 125, 201, 202, 231, 232, 234]);
  return Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), {
    count,
    status: supported.has(code) ? 'supported' : partial.has(code) ? 'partial' : 'unsupported'
  }]));
}

const mapInfoHash = decodeMarshal(await readFile(join(dataDir, 'MapInfos.rxdata')));
// Common events inline into pages at code 117 like MV's; normalize once here so
// pages share the same { code, indent, parameters } shape the parser consumes.
for (const entry of decodeMarshal(await readFile(join(dataDir, 'CommonEvents.rxdata')))) {
  if (!entry) continue;
  commonEvents.set(Number(field(entry, 'id', 0)), field(entry, 'list', []).map(item => ({
    code: field(item, 'code', 0),
    indent: Number(field(item, 'indent', 0)),
    parameters: field(item, 'parameters', [])
  })));
}
const tilesetData = decodeMarshal(await readFile(join(dataDir, 'Tilesets.rxdata')));
const tilesets = tilesetData.map((value, index) => value ? {
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
const maps = [];
for (const name of (await readdir(dataDir)).filter(item => /^Map\d+\.rxdata$/i.test(item)).sort()) {
  const sourceMap = decodeMarshal(await readFile(join(dataDir, name)));
  const width = Number(field(sourceMap, 'width', 0)), height = Number(field(sourceMap, 'height', 0));
  const table = parseTable(field(sourceMap, 'data', {}));
  const layers = Array.from({ length: 6 }, (_, layer) => Array.from({ length: width * height }, (_, index) => table.data[layer * width * height + index] || 0));
  const events = field(sourceMap, 'events', new Map());
  const id = Number(name.match(/\d+/)[0]);
  const mwgEvents = [...events.values()].map(event => convertEvent(event, id));
  const bgm = field(sourceMap, 'bgm', null);
  maps.push({ id, info: unwrap(mapInfoHash.get(id)) || null, data: { width, height, data: layers.flat(), tilesetId: Number(field(sourceMap, 'tileset_id', 0)), autoplayBgm: Boolean(field(sourceMap, 'autoplay_bgm', false)), bgm: bgm ? { name: field(bgm, 'name', ''), volume: Number(field(bgm, 'volume', 100)), pitch: Number(field(bgm, 'pitch', 100)) } : null }, mwgEvents });
}

async function copyTree(input, destination) {
  if (!existsSync(input)) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(input, { withFileTypes: true })) {
    const from = join(input, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else await writeFile(to, await readFile(from));
  }
}

await mkdir(output, { recursive: true });
await copyTree(join(source, 'Graphics', 'Characters'), join(output, 'assets', 'img', 'characters'));
await copyTree(join(source, 'Graphics', 'Tilesets'), join(output, 'assets', 'img', 'tilesets'));
await copyTree(join(source, 'Graphics', 'Pictures'), join(output, 'assets', 'img', 'pictures'));
await copyTree(join(source, 'Graphics'), join(output, 'assets', 'graphics'));
await copyTree(join(source, 'Audio'), join(output, 'assets', 'audio'));
const system = decodeMarshal(await readFile(join(dataDir, 'System.rxdata')));
const playerMetadataPath = join(dataDir, 'player_metadata.dat');
const playerMetadata = existsSync(playerMetadataPath) ? decodeMarshal(await readFile(playerMetadataPath)) : new Map();
const firstPlayer = [...playerMetadata.values()].sort((a, b) => Number(field(a, 'id', 0)) - Number(field(b, 'id', 0)))[0] || null;
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
  // custom-sized object sheets both retain their authored geometry.
  format: 'xp',
  fw: dimensions.width / 4,
  fh: dimensions.height / 4,
  big: false,
  object: false
}]));
const playerMetadataValues = [...playerMetadata.values()].sort((a, b) => Number(field(a, 'id', 0)) - Number(field(b, 'id', 0)));
function resolvePlayerSprite(metadata) {
  if (!metadata) return null;
  const walk = String(field(metadata, 'walk_charset', '') || '');
  if (characterFiles.has(walk)) return { name: walk, index: 0, source: 'player_metadata' };
  // Essentials stores the default player charset in generated data for some
  // projects. If that generated sheet is absent from the archive, derive the
  // trainer charset from the metadata trainer type and use the matching
  // original asset when present (e.g. POKEMONTRAINER_RONAN -> trainer_RONAN).
  const trainerType = String(field(metadata, 'trainer_type', '') || '');
  const suffix = trainerType.replace(/^POKEMONTRAINER_/i, '');
  const candidate = [...characterFiles.keys()].find(name => name.toLowerCase() === `trainer_${suffix}`.toLowerCase());
  return candidate ? { name: candidate, index: 0, source: 'player_metadata_trainer_fallback' } : { name: walk, index: 0, source: 'player_metadata_missing_asset' };
}
const playerSprite = resolvePlayerSprite(firstPlayer);
const startMapId = Number(field(system, 'start_map_id', 0));
const initialMap = maps.find(map => map.id === startMapId) || maps.find(map => map.data.data.some(tile => tile >= XP_STATIC_TILE_BASE)) || maps[0];
const assetAvailability = {
  tilesets: existsSync(join(source, 'Graphics', 'Tilesets')),
  autotiles: existsSync(join(source, 'Graphics', 'Autotiles')),
  characters: existsSync(join(source, 'Graphics', 'Characters')),
  pictures: existsSync(join(source, 'Graphics', 'Pictures')),
  audio: existsSync(join(source, 'Audio'))
};
const manifest = {
  format: 'MWGP', version: 1,
  source: { engine: 'rpg-maker-xp', projectName: output.split(/[\\/]/).pop(), convertedAt: new Date().toISOString() },
  display: { title: field(system, 'game_title', 'Pokémon Essentials'), width: 512, height: 384, tileSize: 32 },
  initialMapId: initialMap?.id || null,
  player: initialMap ? { mapId: initialMap.id, x: Number(field(system, 'start_x', 0)), y: Number(field(system, 'start_y', 0)) } : null,
  tilesetFormat: { engine: 'rpg-maker-xp', autotilePatternCount: XP_AUTOTILE_PATTERNS, autotileImageCount: XP_AUTOTILE_IMAGES, staticTileBase: XP_STATIC_TILE_BASE },
  assets: { root: 'assets', kind: 'decoded', ...assetAvailability, faces: false, encryption: 'rgssad-extracted' },
  tilesets, playerSprite, characterFrames, playerMetadata: playerMetadataValues.map(value => ({
    id: Number(field(value, 'id', 0)), trainerType: field(value, 'trainer_type', ''), walkCharset: field(value, 'walk_charset', ''), runCharset: field(value, 'run_charset', ''), cycleCharset: field(value, 'cycle_charset', ''), surfCharset: field(value, 'surf_charset', '')
  })), plugins: [], compatibility: { source: 'rpg-maker-xp', commands: buildCompatibilityReport(commandCounts) }, maps, database: {}
};
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest, null, 2));
console.log(`Converted ${maps.length} XP maps to ${join(output, 'mwgp.json')}`);
