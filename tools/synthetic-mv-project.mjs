// A made-up RPG Maker MV project, small enough to convert and boot in a browser test: a complete database (so the
// troop battles run), a three-member party, two maps (one with dashing disabled), a random encounter list on the first,
// and one action event. It has no images and no plugins: the player's placeholders stand in for them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const row = (cells) => Array.from({ length: cells }, () => 0);
const params = () => Array.from({ length: 8 }, (_, param) => [0, ...Array.from({ length: 99 }, () => 10 + param * 5)]);
const actor = (id, name) => ({ id, name, nickname: '', classId: 1, initialLevel: 1, maxLevel: 99, profile: '', note: '', characterName: '', characterIndex: 0, faceName: '', faceIndex: 0, battlerName: '', equips: [1, 0, 0, 0, 0], traits: [], skills: [] });

// One event: an action event whose page shows one line of text when the player faces it and presses the action key.
const actionEvent = (id, x, y, text) => ({
  id, name: `EV${String(id).padStart(3, '0')}`, note: '', x, y,
  pages: [{
    conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
    directionFix: false, image: { tileId: 0, characterName: '', direction: 2, pattern: 1, characterIndex: 0 },
    list: [{ code: 101, indent: 0, parameters: ['', 0, 0, 2] }, { code: 401, indent: 0, parameters: [text] }, { code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true,
  }],
});

const map = ({ id, name, displayName, disableDashing = false, encounters = false, events = [] }) => ({
  id, displayName, disableDashing, encounterStep: 30, encounterList: encounters ? [{ troopId: 1, weight: 10, regionSet: [] }] : [],
  width: 8, height: 8, tilesetId: 1, autoplayBgm: false, autoplayBgs: false, scrollType: 0, specifyBattleback: false,
  bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, bgs: { name: '', volume: 90, pitch: 100, pan: 0 },
  battleback1Name: '', battleback2Name: '', parallaxName: '', parallaxLoopX: false, parallaxLoopY: false, parallaxSx: 0, parallaxSy: 0,
  note: name, data: [...row(64), ...row(64), ...row(64), ...row(64), ...row(64), ...row(64)],
  events: [null, ...events],
});

export function writeSyntheticMvProject(dir) {
  const data = join(dir, 'data');
  mkdirSync(join(dir, 'js'), { recursive: true });
  mkdirSync(data, { recursive: true });
  const write = (name, value) => writeFileSync(join(data, name), JSON.stringify(value));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>');
  writeFileSync(join(dir, 'js', 'plugins.js'), 'var $plugins = [];');
  write('System.json', {
    gameTitle: 'Synthetic Test Game', currencyUnit: 'G', startMapId: 1, startX: 2, startY: 2, partyMembers: [1, 2, 3],
    advanced: { gameId: 1, screenWidth: 816, screenHeight: 624, uiAreaWidth: 816, uiAreaHeight: 624, mainFontFilename: 'mplus-1m-regular.ttf', fontSize: 28 },
    optFollowers: true, optTransparent: false, elements: [], skillTypes: [], weaponTypes: [], armorTypes: [], equipTypes: [],
    switches: [null], variables: [null], terms: { basic: [], commands: [], params: [], messages: {} },
    versionId: 1, titleBgm: { name: '', volume: 90, pitch: 100, pan: 0 }, titleImage: '',
  });
  write('Actors.json', [null, actor(1, 'Hero'), actor(2, 'Second'), actor(3, 'Third')]);
  write('Classes.json', [null, { id: 1, name: 'Warrior', expParams: [30, 20, 30, 30], params: params(), learnings: [], traits: [], skills: [] }]);
  write('Skills.json', [null, { id: 1, name: 'Attack', description: '', iconIndex: 0, mpCost: 0, tpCost: 0, scope: 1, occasion: 1, speed: 0, repeats: 1, damage: { type: 1, elementId: 0, formula: 'a.atk * 4 - b.def * 2', variance: 20, critical: false }, effects: [], hitType: 1, animationId: 0, message1: '%1 attacks!', message2: '', successRate: 100, requiredWtypeId1: 0, requiredWtypeId2: 0, stypeId: 1, traits: [], note: '' }]);
  write('Items.json', [null]);
  write('Weapons.json', [null]);
  write('Armors.json', [null]);
  write('States.json', [null, { id: 1, name: 'Dead', iconIndex: 1, restriction: 4, priority: 100, traits: [], removeAtBattleEnd: false, autoRemovalTiming: 0, minTurns: 1, maxTurns: 1, removeByDamage: false, removeByRestriction: false, note: '' }]);
  write('Enemies.json', [null, { id: 1, name: 'Slime', battlerName: '', battlerHue: 0, params: [50, 0, 10, 10, 10, 10, 10, 10], exp: 10, gold: 5, dropItems: [], actions: [{ conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId: 1 }], traits: [], note: '' }]);
  write('Troops.json', [null, { id: 1, name: 'Slimes', members: [{ enemyId: 1, x: 400, y: 300, hidden: false }], pages: [], span: 0 }]);
  write('MapInfos.json', [null, { id: 1, name: 'Room', order: 1, parentId: 0, expanded: false }, { id: 2, name: 'Corridor', order: 2, parentId: 0, expanded: false }]);
  write('Tilesets.json', [null, { id: 1, name: 'Synthetic', mode: 0, tilesetNames: ['', '', '', '', '', '', '', '', ''], flags: [0], note: '' }]);
  write('Map001.json', map({ id: 1, name: 'Room', displayName: 'Test Room', encounters: true, events: [actionEvent(1, 4, 2, 'Hello from the sign.')] }));
  write('Map002.json', map({ id: 2, name: 'Corridor', displayName: 'Second Room', disableDashing: true }));
  return dir;
}
