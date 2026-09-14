import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg || !outputArg) {
  console.error('Usage: node tools/convert-mv.js <RPGM project> <MWGP output>');
  process.exit(1);
}

const source = resolve(sourceArg);
const dataDir = join(source, 'www', 'data');
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
  for (const event of data.events || []) for (const page of event?.pages || []) for (const command of page.list || []) commandCounts.set(command.code, (commandCounts.get(command.code) || 0) + 1);
  maps.push({ id, info: mapInfos[id] || null, data, mwgEvents: data.events.filter(Boolean).map(convertEvent) });
}

function convertEvent(event) {
  return { id: String(event.id), x: event.x, y: event.y, pages: (event.pages || []).map(page => ({
    trigger: ['action', 'touch', 'touch', 'autorun', 'parallel'][page.trigger] || 'action',
    conditions: convertConditions(page.conditions),
    commands: convertCommands(page.list || []),
    image: page.image?.characterName ? { name: page.image.characterName, index: page.image.characterIndex || 0, direction: page.image.direction || 2, pattern: page.image.pattern || 1 } : null
  })) };
}

function convertConditions(conditions = {}) {
  const result = [];
  if (conditions.switch1Valid) result.push({ switch: String(conditions.switch1Id), equals: true });
  if (conditions.switch2Valid) result.push({ switch: String(conditions.switch2Id), equals: true });
  if (conditions.variableValid) result.push({ variable: String(conditions.variableId), atLeast: conditions.variableValue });
  return result;
}

function convertCommands(list, depth = 0) {
  return parseBlock(0, -1).commands;

  function parseBlock(start, parentIndent) {
    const result = [];
    let index = start;
    let portrait;
    while (index < list.length) {
      const command = list[index];
      if ((command.code === 411 || command.code === 412) && command.indent === parentIndent) {
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
      if (command.code === 101 && command.parameters?.[0]) portrait = { name: command.parameters[0], index: Number(command.parameters[1] || 0) };
      const converted = convertCommand(command, { portrait, depth });
      if (converted) result.push(...converted);
      index++;
    }
    return { commands: result, index, marker: null };
  }
}

function convertCommand(command, context = {}) {
  const portrait = context.portrait ? { portrait: context.portrait } : {};
  if (command.code === 401) return [{ say: command.parameters?.[0] || '', ...portrait }];
  if (command.code === 102) return [{ ask: '', choices: (command.parameters?.[0] || []).map(text => ({ text })), ...portrait }];
  if (command.code === 121) return Array.from({ length: command.parameters[1] - command.parameters[0] + 1 }, (_, offset) => ({ setSwitch: String(command.parameters[0] + offset), value: command.parameters[2] === 0 }));
  if (command.code === 122) {
    const first = Number(command.parameters[0]);
    const last = Number(command.parameters[1] ?? first);
    const operation = Number(command.parameters[2] || 0);
    const operandType = Number(command.parameters[3] || 0);
    const operand = Number(command.parameters[4] || 0);
    if (operandType !== 0) return [];
    return Array.from({ length: last - first + 1 }, (_, offset) => {
      const id = String(first + offset);
      if (operation === 0) return { setVariable: id, value: operand };
      if (operation === 1) return { addVariable: id, amount: operand };
      if (operation === 2) return { addVariable: id, amount: -operand };
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
  if (command.code === 250) {
    const p = command.parameters || [];
    if (p[0]) soundNames.add(p[0]);
    return p[0] ? [{ sound: { name: p[0], volume: Number(p[1] ?? 90), pitch: Number(p[2] ?? 100), pan: Number(p[3] || 0) } }] : [];
  }
  if (command.code === 117 && context.depth < 8) {
    const commonEvent = commonEvents[Number(command.parameters?.[0])];
    return commonEvent?.list ? convertCommands(commonEvent.list, context.depth + 1) : [];
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

const pluginsPath = join(source, 'www', 'js', 'plugins.js');
const pluginsText = existsSync(pluginsPath) ? await readFile(pluginsPath, 'utf8') : '';
const pluginNames = [...pluginsText.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(match => match[1]);

await mkdir(join(output, 'data'), { recursive: true });
const manifest = {
  format: 'MWGP',
  version: 1,
  source: { engine: 'rpg-maker-mv', projectName: basename(source), convertedAt: new Date().toISOString() },
  display: { title: system.gameTitle || basename(source), width: system.advanced?.screenWidth || 816, height: system.advanced?.screenHeight || 624 },
  initialMapId: system.startMapId || null,
  player: system.startX != null ? { mapId: system.startMapId, x: system.startX, y: system.startY } : null,
  assets: { root: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio ? 'assets' : join(source, 'www'), kind: copyTilesets || copyCharacters || copyFaces || copyPictures || copyAudio ? 'decoded' : 'source', tilesets: copyTilesets, characters: copyCharacters, faces: copyFaces, pictures: copyPictures, audio: copyAudio, encryption: system.encryptionKey ? 'rpgm' : 'none' },
  tilesets: database.tilesets,
  playerSprite: database.actors?.[system.partyMembers?.[0]] ? { name: database.actors[system.partyMembers[0]].characterName, index: database.actors[system.partyMembers[0]].characterIndex } : null,
  plugins: pluginNames,
  compatibility: { source: 'rpg-maker-mv', commands: buildCompatibilityReport(commandCounts) },
  maps,
  database
};
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest, null, 2));
if (copyAssets) {
  await decodeTree(join(source, 'www', 'img'), join(output, 'assets', 'img'), system.encryptionKey);
  await decodeTree(join(source, 'www', 'audio'), join(output, 'assets', 'audio'), system.encryptionKey);
} else if (copyTilesets) {
  await decodeTree(join(source, 'www', 'img', 'tilesets'), join(output, 'assets', 'img', 'tilesets'), system.encryptionKey);
}
if (copyCharacters) await decodeTree(join(source, 'www', 'img', 'characters'), join(output, 'assets', 'img', 'characters'), system.encryptionKey);
if (copyFaces) await decodeTree(join(source, 'www', 'img', 'faces'), join(output, 'assets', 'img', 'faces'), system.encryptionKey);
if (copyPictures && !copyAssets) await decodeNamedTree(join(source, 'www', 'img', 'pictures'), join(output, 'assets', 'img', 'pictures'), pictureNames, system.encryptionKey);
if (copyAudio && !copyAssets) await decodeNamedTree(join(source, 'www', 'audio', 'se'), join(output, 'assets', 'audio', 'se'), soundNames, system.encryptionKey);
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
    const sourceName = entry.name.replace(/\.rpgmv[opm]$/i, '').replace(/\.[^.]+$/, '');
    if (!names.has(sourceName)) continue;
    await writeFile(join(destination, decodedName(entry.name)), decodeRpgmAsset(await readFile(join(input, entry.name)), entry.name, encryptionKey));
  }
}

function decodedName(name) {
  return name.replace(/\.rpgmvp$/i, '.png').replace(/\.rpgmvo$/i, '.ogg').replace(/\.rpgmvm$/i, '.m4a');
}

function decodeRpgmAsset(bytes, name, encryptionKey) {
  if (!/\.rpgmv[opm]$/i.test(name) || bytes.length < 16 || !encryptionKey) return bytes;
  const key = Buffer.from(encryptionKey, 'hex');
  if (!key.length) return bytes.subarray(16);
  const result = Buffer.from(bytes.subarray(16));
  // MV's encryption header protects only the first 16 payload bytes. The
  // remaining bytes are already in their original form and must be copied as-is.
  for (let i = 0; i < Math.min(16, result.length); i++) result[i] ^= key[i % key.length];
  return result;
}

function buildCompatibilityReport(counts) {
  const supported = new Set([0, 101, 102, 111, 117, 121, 122, 201, 230, 235, 401, 411, 412]);
  const partial = new Set([101, 108, 205, 231, 250, 402, 404]);
  return Object.fromEntries([...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), {
    count,
    status: supported.has(code) ? 'supported' : partial.has(code) ? 'partial' : 'unsupported'
  }]));
}
