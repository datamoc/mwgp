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
// The player version a Studio assigns to the project; stamped into standalone
// game pages when they are created. Optional: absent means the default.
if (project.playerVersion !== undefined) check(typeof project.playerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(project.playerVersion), 'playerVersion must be a version such as "0.0.1"');

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
  'say', 'ask', 'inputNumber', 'inputName', 'messageOptions', 'battle', 'weather', 'gameOver', 'wait', 'setSwitch', 'setVariable', 'addVariable', 'modifyVariable', 'copyVariable', 'if', 'loop',
  'breakLoop', 'exitEvent', 'commonEvent', 'move', 'transfer', 'picture', 'erasePicture', 'movePicture', 'tintPicture',
  'balloon', 'animation', 'animationAt', 'shop', 'scroll', 'scrollMap', 'mapSettings', 'relocate', 'saveBgm', 'resumeBgm', 'me', 'menu', 'goto',
  'changeHp', 'changeLevel', 'changeClass', 'vehicleLocation', 'enemyAppear', 'changeEnemyHp', 'changeEnemyMp', 'changeEnemyTp', 'changeEnemyState', 'enemyTransform', 'changeState', 'recoverAll', 'changeSkill', 'changeEquipment', 'changeProfile',
  'sound', 'turn',
  'screenFade', 'screenFlash', 'changeGold', 'changeItem', 'changeWeapon', 'changeArmor', 'changeParty',
  'setTransparent', 'routeThrough', 'routeImage', 'routeOption', 'eraseEvent', 'screenTint', 'screenShake', 'playBgm', 'fadeoutBgm', 'playBgs', 'fadeoutBgs',
  'stopSound', 'script', 'pluginCommand', 'unsupported',
  'systemFlag', 'gatherFollowers', 'changeActorStat', 'changeActorText', 'changeActorImages', 'timer', 'vehicleBoard', 'playMovie', 'forceAction', 'returnToTitle',
  'changeTileset', 'changeParallax', 'enemyRecoverAll', 'abortBattle', 'selectItem', 'rotatePicture', 'locationInfo'
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
// Plugin/engine library (MV/MZ): either inline `sources` or a `files` map to assets/plugins|engine.
if (project.pluginLibrary !== undefined) {
  const library = project.pluginLibrary;
  check(library && Array.isArray(library.order), 'pluginLibrary.order must be an array');
  const provided = library?.files?.plugins || library?.sources || {};
  for (const name of library?.order || []) check(typeof provided[name] === 'string', `pluginLibrary has no source for plugin "${name}"`);
  if (library?.files) for (const group of ['plugins', 'engine']) for (const [name, file] of Object.entries(library.files[group] || {})) check(typeof file === 'string' && !file.includes('..') && file.endsWith('.js'), `pluginLibrary.files.${group}["${name}"] must be a relative .js path`);
}
// Audio section: the index maps each kind's track name to the file extension it resolved to,
// and the system entries (title/battle music, jingles, system sounds) name tracks the index
// should resolve. Optional for manifests converted before audio management existed.
if (project.audio !== undefined) {
  const audio = project.audio;
  check(typeof audio === 'object' && audio !== null && typeof audio.index === 'object' && audio.index !== null, 'audio.index must be an object');
  for (const kind of ['bgm', 'bgs', 'me', 'se']) {
    const entries = audio?.index?.[kind];
    check(typeof entries === 'object' && entries !== null, `audio.index.${kind} must be an object`);
    for (const [name, extension] of Object.entries(entries || {})) check(typeof extension === 'string' && /^\.[a-z0-9]+$/i.test(extension), `audio.index.${kind}["${name}"] must be a file extension such as ".ogg"`);
  }
  check(audio.soundfont === undefined || audio.soundfont === null || (typeof audio.soundfont === 'string' && audio.soundfont.endsWith('.sf2')), 'audio.soundfont must be a .sf2 file name or null');
  const systemTracks = [audio.system?.titleBgm, audio.system?.battleBgm, audio.system?.victoryMe, audio.system?.defeatMe, audio.system?.gameoverMe, ...Object.values(audio.system?.vehicles || {}), ...Object.values(audio.system?.sounds || {})];
  for (const track of systemTracks) if (track) check(typeof track.name === 'string' && track.name.length > 0 && Number.isFinite(track.volume), 'audio.system entries need a name and a numeric volume');
}
let eventCount = 0, commandCount = 0;
if (project.commonEvents !== undefined) {
  check(typeof project.commonEvents === 'object' && project.commonEvents !== null, 'commonEvents must be an object');
  for (const [id, commands] of Object.entries(project.commonEvents || {})) {
    check(Array.isArray(commands), `common event ${id} must contain a command array`);
    validateCommands(commands || [], `common:${id}`, 0);
  }
}
for (const map of project.maps || []) {
  const data = map.data;
  check(Number.isInteger(data?.width) && Number.isInteger(data?.height), `map ${map.id} has invalid dimensions`);
  check(Array.isArray(data?.data) && data.data.length >= data.width * data.height * 6, `map ${map.id} must contain at least six MV layers`);
  check(Number.isInteger(map.tilesetId ?? data?.tilesetId), `map ${map.id} has no tileset id`);
  const tilesetId = Number(map.tilesetId ?? data?.tilesetId);
  if (Array.isArray(project.tilesets)) check(tilesetId >= 0 && tilesetId < project.tilesets.length && project.tilesets[tilesetId], `map ${map.id} references missing tileset ${tilesetId}`);
  // Only layers 0-3 hold tile ids: layer 4 is shadow bits and layer 5 is
  // region ids, and real projects store bit flags there (e.g. 0x80000000-based
  // shadow values in Elementals), which the player never renders as tiles.
  for (const tile of (data?.data || []).slice(0, data.width * data.height * 4)) check(Number.isInteger(tile) && tile >= 0, `map ${map.id} contains an invalid tile id`);
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
      check(command.if.switch !== undefined || command.if.variable !== undefined || command.if.script !== undefined
        || command.if.partyMember !== undefined || command.if.facing !== undefined || command.if.eventFacing !== undefined
        || command.if.gold !== undefined || command.if.item !== undefined || command.if.weapon !== undefined || command.if.armor !== undefined
        || command.if.actorName !== undefined || command.if.actorClass !== undefined || command.if.actorSkill !== undefined
        || command.if.actorWeapon !== undefined || command.if.actorArmor !== undefined || command.if.actorState !== undefined
        || command.if.vehicle !== undefined || command.if.timer !== undefined || command.if.unsupported !== undefined,
        `if command in event ${eventId} on map ${mapId} has no supported condition`);
      if (command.if.operator) check(['eq', 'neq', 'gte', 'lte', 'gt', 'lt'].includes(command.if.operator),
        `if command in event ${eventId} on map ${mapId} has an invalid variable operator`);
      if (command.if.facing !== undefined) check(['up', 'down', 'left', 'right'].includes(command.if.facing),
        `if command in event ${eventId} on map ${mapId} has an invalid facing`);
      if (command.if.vehicle !== undefined) check(['boat', 'ship', 'airship'].includes(command.if.vehicle), 'if command has an invalid vehicle');
      if (command.if.eventFacing !== undefined) check(['up', 'down', 'left', 'right'].includes(command.if.eventFacing),
        `if command in event ${eventId} on map ${mapId} has an invalid event facing`);
      if (command.if.gold !== undefined) check(['gte', 'lte', 'lt'].includes(command.if.gold?.operator),
        `if command in event ${eventId} on map ${mapId} has an invalid gold operator`);
      if (command.if.unsupported !== undefined) check(Number.isInteger(command.if.unsupported?.code) && Number.isInteger(command.if.unsupported?.kind),
        `if command in event ${eventId} on map ${mapId} has a malformed unsupported marker`);
      if (command.if.script) check(typeof command.if.script.source === 'string' && (command.if.script.js === undefined || typeof command.if.script.js === 'string'),
        `script condition in event ${eventId} on map ${mapId} needs a source string`);
      validateCommands(command.then || [], eventId, mapId);
      validateCommands(command.else || [], eventId, mapId);
    }
    for (const key of ['changeEnemyHp', 'changeEnemyMp', 'changeEnemyTp']) if (command[key] !== undefined) check(Number.isInteger(command[key]?.index) && command[key].index >= -1 && (typeof command[key].amount === 'number' || typeof command[key].amount?.variable === 'string') && [1, -1].includes(command[key].sign), `${key} is malformed`);
    if (command.changeEnemyState !== undefined) check(Number.isInteger(command.changeEnemyState?.index) && Number.isInteger(command.changeEnemyState?.state) && typeof command.changeEnemyState?.add === 'boolean', 'changeEnemyState is malformed');
    if (command.enemyTransform !== undefined) check(Number.isInteger(command.enemyTransform?.index) && Number.isInteger(command.enemyTransform?.enemyId), 'enemyTransform is malformed');
    if (command.enemyAppear !== undefined) check(Number.isInteger(command.enemyAppear?.index) && command.enemyAppear.index >= 0, 'enemyAppear has an invalid index');
    if (command.routeOption !== undefined) check(typeof command.routeOption?.target === 'string' && ['speed', 'frequency', 'walkAnimation', 'stepAnimation', 'directionFix'].includes(command.routeOption?.option), 'routeOption is malformed');
    if (command.vehicleLocation !== undefined) {
      const v = command.vehicleLocation;
      check(Number.isInteger(v?.vehicle) && v.vehicle >= 0 && v.vehicle <= 2, 'vehicleLocation has an invalid vehicle');
      check(Number.isInteger(v?.mapId) || typeof v?.mapVar === 'string', 'vehicleLocation has no map target');
      check((Number.isInteger(v?.x) && Number.isInteger(v?.y)) || (typeof v?.xVar === 'string' && typeof v?.yVar === 'string'), 'vehicleLocation has invalid coordinates');
    }
    if (command.routeImage !== undefined) {
      check(typeof command.routeImage?.target === 'string' && typeof command.routeImage?.image?.name === 'string' && command.routeImage.image.name.length > 0, 'routeImage needs a character name');
      check(Number.isInteger(command.routeImage.image.index) && Number.isInteger(command.routeImage.image.direction) && Number.isInteger(command.routeImage.image.pattern), 'routeImage has invalid character coordinates');
    }
    if (command.shop !== undefined) {
      check(Array.isArray(command.shop?.goods) && command.shop.goods.length > 0, 'shop has no goods');
      for (const good of command.shop.goods || []) check(Number.isInteger(good?.kind) && good.kind >= 0 && good.kind <= 2 && Number.isInteger(good?.id) && good.id > 0, 'shop has an invalid good');
    }
    if (command.script !== undefined && command.js !== undefined) check(typeof command.js === 'string', `script in event ${eventId} on map ${mapId} has a non-string js`);
    if (command.changeLevel !== undefined) {
      check([0, 1, 2].includes(Number(command.changeLevel?.scope)), 'changeLevel has an invalid scope');
      check(Number.isFinite(Number(command.changeLevel?.amount)) || typeof command.changeLevel?.amount?.variable === 'string', 'changeLevel has an invalid amount');
    }
    if (command.changeClass !== undefined) check(Number.isInteger(command.changeClass?.actor) && Number(command.changeClass.actor) > 0 && Number.isInteger(command.changeClass?.classId) && Number(command.changeClass.classId) > 0, 'changeClass has an invalid actor or class');
    if (command.changeHp !== undefined) {
      check([0, 1, 2].includes(Number(command.changeHp?.scope)), 'changeHp has an invalid scope');
      check(Number.isFinite(Number(command.changeHp?.amount)) || typeof command.changeHp?.amount?.variable === 'string', 'changeHp has an invalid amount');
    }
    if (command.modifyVariable !== undefined) {
      check(['set', 'add', 'subtract', 'multiply', 'divide', 'modulo'].includes(command.modifyVariable?.operation),
        `modifyVariable in event ${eventId} on map ${mapId} has an invalid operation`);
      const operand = command.modifyVariable?.operand;
      if (operand?.gameData !== undefined) check(['itemCount', 'weaponCount', 'armorCount', 'playerX', 'playerY', 'partyMember', 'mapId', 'partySize', 'gold', 'steps', 'playtime', 'timer', 'saveCount', 'battleCount', 'winCount', 'escapeCount'].includes(operand.gameData?.kind),
        `modifyVariable in event ${eventId} on map ${mapId} has an invalid game-data kind`);
      if (operand?.script !== undefined) check(typeof operand.script?.source === 'string',
        `modifyVariable in event ${eventId} on map ${mapId} has a script operand without a source string`);
    }
    if (command.unsupported !== undefined) check(Number.isInteger(command.unsupported?.code) && Number.isInteger(command.unsupported?.kind),
      `unsupported marker in event ${eventId} on map ${mapId} needs integer code and kind`);
    if (command.loop) validateCommands(command.loop, eventId, mapId);
    if (command.branches) {
      for (const branch of command.branches) validateCommands(branch || [], eventId, mapId);
      if (command.cancelBranch) validateCommands(command.cancelBranch, eventId, mapId);
    }
    if (command.battle) {
      check(Number.isInteger(command.battle.troopId) || command.battle.troopVariable, `battle command in event ${eventId} on map ${mapId} has no troop`);
      for (const branch of Object.values(command.battle.branches || {})) validateCommands(branch || [], eventId, mapId);
    }
  }
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ valid: true, maps: project.maps.length, events: eventCount, commands: commandCount }));
