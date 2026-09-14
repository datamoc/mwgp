import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
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
const commandCounts = new Map();
const pictureNames = new Set();
const soundNames = new Set();
const musicNames = new Set();
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
  return { id: String(event.id), x: event.x, y: event.y, pages: (event.pages || []).map(page => ({
    trigger: ['action', 'touch', 'touch', 'autorun', 'parallel'][page.trigger] || 'action',
    conditions: convertConditions(page.conditions, mapId, event.id),
    commands: convertCommands(page.list || [], { mapId, eventId: event.id }),
    through: page.through === true,
    priorityType: page.priorityType === 0 || page.priorityType === 2 ? page.priorityType : 1,
    image: page.image?.characterName ? { name: page.image.characterName, index: page.image.characterIndex || 0, direction: page.image.direction || 2, pattern: page.image.pattern || 1 } : null
  })) };
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
  return parseBlock(0, -1).commands;

  // Terminators are recognised by (code, indent) alone, the same convention RPG Maker's own
  // indent-delimited list uses: whichever block is currently open decides what a terminator
  // at its own indent means (else/end-if, end-loop, or a choice/cancel boundary).
  function parseBlock(start, parentIndent) {
    const result = [];
    let index = start;
    let portrait;
    while (index < list.length) {
      const command = list[index];
      if ([402, 403, 404, 411, 412, 413].includes(command.code) && command.indent === parentIndent) {
        return { commands: result, index, marker: command.code };
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
          ask: '', choices: texts.map((text, i) => ({ text, value: i })), branches,
          ...(cancelType === -1 && cancelBranch ? { cancelBranch } : {}),
          ...(portrait ? { portrait } : {})
        });
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
  if (command.code === 401) return [{ say: command.parameters?.[0] || '', ...portrait }];
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
    // Constant (0), a copy from another variable (1), and a random range (2) all resolve to
    // a fixed or computable-at-convert-time number; game-data (3) and script (4) operands
    // would need runtime evaluation this static manifest can't express, so those are skipped.
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
      return null;
    }).filter(Boolean);
  }
  if (command.code === 230) return [{ wait: Number(command.parameters?.[0] || 0) / 60 }];
  if (command.code === 205 && (command.parameters?.[0] === -1 || command.parameters?.[0] === 0)) {
    const route = command.parameters?.[1] || {};
    const commands = [];
    for (const step of route.list || []) {
      const movement = { 1: { dx: 0, dy: 1 }, 2: { dx: -1, dy: 0 }, 3: { dx: 1, dy: 0 }, 4: { dx: 0, dy: -1 } }[step.code];
      const turn = { 16: 'down', 17: 'left', 18: 'right', 19: 'up' }[step.code];
      if (movement) commands.push({ move: { target: 'player', steps: [movement] } });
      else if (turn) commands.push({ turn });
      else if (step.code === 15) commands.push({ wait: Number(step.parameters?.[0] || 0) / 60 });
    }
    if (commands.length) return commands;
  }
  if (command.code === 231) {
    const p = command.parameters || [];
    if (p[1]) pictureNames.add(p[1]);
    return p[1] ? [{ picture: { id: Number(p[0]), name: p[1], origin: Number(p[2] || 0), x: Number(p[4] || 0), y: Number(p[5] || 0), scaleX: Number(p[6] ?? 100), scaleY: Number(p[7] ?? 100), opacity: Number(p[8] ?? 255) } }] : [];
  }
  if (command.code === 235) return [{ erasePicture: Number(command.parameters?.[0] || 0) }];
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
  if (command.code === 117 && context.depth < 8) {
    const commonEvent = commonEvents[Number(command.parameters?.[0])];
    return commonEvent?.list ? convertCommands(commonEvent.list, { ...context, depth: context.depth + 1 }) : [];
  }
  if (command.code === 201 && command.parameters?.[0] === 0) return [{ transfer: { mapId: command.parameters[1], x: command.parameters[2], y: command.parameters[3] } }];
  return [];
}

function convertBranchCondition(parameters) {
  if (parameters[0] === 0) return { switch: String(parameters[1]), equals: parameters[2] === 0 };
  if (parameters[0] === 1 && parameters[2] === 0) return { variable: String(parameters[1]), atLeast: Number(parameters[3] || 0) };
  return null;
}

const databaseFiles = ['Actors.json', 'Classes.json', 'Skills.json', 'Items.json', 'Weapons.json', 'Armors.json', 'Enemies.json', 'Troops.json', 'States.json', 'Animations.json', 'Tilesets.json', 'CommonEvents.json'];
const database = {};
for (const name of databaseFiles) database[name.replace('.json', '').toLowerCase()] = await readJson(name, true);

const pluginsPath = join(gameRoot, 'js', 'plugins.js');
const pluginsText = existsSync(pluginsPath) ? await readFile(pluginsPath, 'utf8') : '';
const pluginNames = [...pluginsText.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(match => match[1]);

await mkdir(join(output, 'data'), { recursive: true });
const manifest = {
  format: 'MWGP',
  version: 1,
  source: { engine: engineKind, projectName: basename(source), convertedAt: new Date().toISOString() },
  display: { title: system.gameTitle || basename(source), width: system.advanced?.screenWidth || 816, height: system.advanced?.screenHeight || 624 },
  initialMapId: startMap?.id || null,
  player: startMap ? { mapId: startMap.id, x: startMap.id === system.startMapId ? system.startX : 1, y: startMap.id === system.startMapId ? system.startY : 1 } : null,
  assets: { root: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio ? 'assets' : gameRoot, kind: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio ? 'decoded' : 'source', tilesets: copyTilesets, characters: copyCharacters, faces: copyFaces, pictures: copyPictures, audio: copyAudio, encryption: system.encryptionKey ? 'rpgm' : 'none' },
  tilesets: database.tilesets,
  playerSprite: database.actors?.[system.partyMembers?.[0]] ? { name: database.actors[system.partyMembers[0]].characterName, index: database.actors[system.partyMembers[0]].characterIndex } : null,
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
if (copyPictures && !copyAssets) await decodeNamedTree(join(gameRoot, 'img', 'pictures'), join(output, 'assets', 'img', 'pictures'), pictureNames, system.encryptionKey);
if (copyAudio && !copyAssets) {
  await decodeNamedTree(join(gameRoot, 'audio', 'se'), join(output, 'assets', 'audio', 'se'), soundNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'bgm'), join(output, 'assets', 'audio', 'bgm'), musicNames, system.encryptionKey);
  await decodeNamedTree(join(gameRoot, 'audio', 'bgs'), join(output, 'assets', 'audio', 'bgs'), musicNames, system.encryptionKey);
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
    0, 101, 102, 108, 111, 112, 113, 115, 117, 121, 123, 201, 221, 222, 224, 230, 235, 250,
    401, 402, 403, 404, 411, 412, 413, 505
  ]);
  // 108 (Comment) and 505 (a Set Movement Route step's editor-only sibling entry, already
  // folded into code 205's own parameters.list) are correctly handled by doing nothing.
  const partial = new Set([122, 205, 231]);
  return Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), {
    count,
    status: supported.has(code) ? 'supported' : partial.has(code) ? 'partial' : 'unsupported'
  }]));
}
