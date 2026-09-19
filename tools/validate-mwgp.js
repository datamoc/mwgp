import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/validate-mwgp.js <mwgp.json>');
  process.exit(1);
}

const project = JSON.parse(await readFile(resolve(file), 'utf8'));
const manifestDir = dirname(resolve(file));
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
check(project.format === 'MWGP', 'format must be MWGP');
check(Number.isInteger(project.version) && project.version >= 1, 'version must be a positive integer');
check(Array.isArray(project.maps) && project.maps.length > 0, 'maps must be a non-empty array');
check(project.initialMapId == null || project.maps.some(map => map.id === project.initialMapId), 'initialMapId must refer to a map');
check(project.assets && typeof project.assets === 'object', 'assets metadata is required');

// A structurally valid manifest is not playable if its decoded resources were
// never copied. Resolve relative asset roots from the manifest itself so this
// check remains valid when a project is moved as a folder.
if (project.assets?.kind === 'decoded') {
  const assetRoot = resolve(manifestDir, project.assets.root || 'assets');
  check(existsSync(assetRoot), `decoded asset root does not exist: ${project.assets.root || 'assets'}`);
  const requiredAssetDirs = [
    ['tilesets', 'img/tilesets'], ['characters', 'img/characters'], ['faces', 'img/faces'],
    ['pictures', 'img/pictures'], ['audio', 'audio'], ['autotiles', 'graphics/Autotiles']
  ];
  for (const [flag, relative] of requiredAssetDirs) {
    if (project.assets[flag]) check(existsSync(join(assetRoot, relative)), `decoded ${flag} assets are missing: ${relative}`);
  }
}
if (project.source?.engine === 'rpg-maker-xp') {
  const format = project.tilesetFormat;
  check(Number.isInteger(format?.autotilePatternCount) && format.autotilePatternCount > 0,
    'XP autotilePatternCount must be a positive integer');
  check(Number.isInteger(format?.autotileImageCount) && format.autotileImageCount > 0,
    'XP autotileImageCount must be a positive integer');
  check(Number.isInteger(format?.staticTileBase) && format.staticTileBase ===
    format.autotilePatternCount * format.autotileImageCount,
    'XP staticTileBase must equal autotilePatternCount * autotileImageCount');
}

const allowed = new Set([
  'say', 'ask', 'inputNumber', 'messageOptions', 'wait', 'setSwitch', 'setVariable', 'addVariable', 'copyVariable', 'if', 'loop',
  'breakLoop', 'exitEvent', 'move', 'transfer', 'picture', 'erasePicture', 'movePicture', 'tintPicture',
  'balloon', 'animation', 'scroll', 'scrollMap', 'mapSettings', 'relocate', 'saveBgm', 'resumeBgm', 'me', 'menu', 'goto',
  'changeState', 'recoverAll', 'changeSkill', 'changeEquipment', 'changeProfile',
  'sound', 'turn',
  'screenFade', 'screenFlash', 'changeGold', 'changeItem', 'changeWeapon', 'changeArmor', 'changeParty',
  'setTransparent', 'eraseEvent', 'screenTint', 'screenShake', 'playBgm', 'fadeoutBgm', 'playBgs', 'fadeoutBgs',
  'stopSound', 'script', 'pluginCommand'
]);
// Frame geometry the converter measured from the original character sheets
// ($-prefix grid rule + PNG dimensions). Optional for older manifests; when
// present every entry must carry positive cell dimensions.
if (project.characterFrames !== undefined) {
  check(typeof project.characterFrames === 'object' && project.characterFrames !== null, 'characterFrames must be an object');
  for (const [name, frame] of Object.entries(project.characterFrames || {})) {
    check(typeof frame?.big === 'boolean' && typeof frame?.object === 'boolean' &&
      Number.isFinite(frame?.fw) && frame.fw > 0 && Number.isFinite(frame?.fh) && frame.fh > 0,
      `characterFrames entry ${name} has invalid geometry`);
  }
}
let eventCount = 0, commandCount = 0;
for (const map of project.maps || []) {
  const data = map.data;
  check(Number.isInteger(data?.width) && Number.isInteger(data?.height), `map ${map.id} has invalid dimensions`);
  check(Array.isArray(data?.data) && data.data.length === data.width * data.height * 6, `map ${map.id} must contain six MV layers`);
  check(Number.isInteger(map.tilesetId ?? data?.tilesetId), `map ${map.id} has no tileset id`);
  const tilesetId = Number(map.tilesetId ?? data?.tilesetId);
  if (Array.isArray(project.tilesets)) check(tilesetId >= 0 && tilesetId < project.tilesets.length && project.tilesets[tilesetId], `map ${map.id} references missing tileset ${tilesetId}`);
  for (const tile of data?.data || []) check(Number.isInteger(tile) && tile >= 0, `map ${map.id} contains an invalid tile id`);
  for (const event of map.mwgEvents || []) {
    eventCount++;
    check(Array.isArray(event.pages), `event ${event.id} on map ${map.id} has no pages`);
    check(Number.isInteger(event.x) && Number.isInteger(event.y) && event.x >= 0 && event.x < data.width && event.y >= 0 && event.y < data.height,
      `event ${event.id} on map ${map.id} is outside map bounds`);
    for (const page of event.pages || []) {
      validateCommands(page.commands || [], event.id, map.id);
      for (const passage of Object.values(page.story?.passages || {})) validateCommands(passage, event.id, map.id);
    }
  }
}

function validateCommands(commands, eventId, mapId) {
  for (const command of commands) {
    commandCount++;
    check(Object.keys(command).some(key => allowed.has(key)), `unsupported command in event ${eventId} on map ${mapId}`);
    if (command.if) {
      check(command.if.switch || command.if.variable, `if command in event ${eventId} on map ${mapId} has no supported condition`);
      validateCommands(command.then || [], eventId, mapId);
      validateCommands(command.else || [], eventId, mapId);
    }
    if (command.loop) validateCommands(command.loop, eventId, mapId);
    if (command.branches) {
      for (const branch of command.branches) validateCommands(branch || [], eventId, mapId);
      if (command.cancelBranch) validateCommands(command.cancelBranch, eventId, mapId);
    }
  }
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ valid: true, maps: project.maps.length, events: eventCount, commands: commandCount }));
