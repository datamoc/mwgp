// RPG Maker 2000/2003 -> MWGP converter. Reads the LCF project
// (RPG_RT.ldb database, RPG_RT.lmt map tree, MapXXXX.lmu maps) with
// tools/lcf.mjs and emits an MWGP manifest the player runs:
//
//   node tools/convert-lcf.mjs "<project folder>" "<output folder>"
//
// Maps become MV-shaped six-layer data whose tile ids are chipset atlas
// frames (src/player/chipset.js, shared with the player, which composes
// the atlas from the chipset image). Event pages and a first vocabulary of
// event commands convert to MWGP commands; everything else is an explicit
// { unsupported } marker, never a silent drop. The database maps onto the
// MV-shaped tables the battle runner and menu read (2003's ATB specifics
// and DynRPG/Maniac patch commands stay out, loudly where they appear).
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseDatabase, parseMapTree, parseMap, readArray, readChunks, findChunk, chunkInt, chunkString } from './lcf.mjs';
import { chipsetFrameFor } from '../src/player/chipset.js';
import { buildAudioIndex } from './audio-index.mjs';

const [source, output] = process.argv.slice(2);
if (!source || !output) { console.error('usage: convert-lcf.mjs <project folder> <output folder>'); process.exit(2); }

const int = (chunks, id, fallback = 0) => { const chunk = findChunk(chunks, id); return chunk ? chunkInt(chunk) : fallback; };
const str = (chunks, id) => chunkString(findChunk(chunks, id));
const flag = (chunks, id) => int(chunks, id) !== 0;
const shorts = chunk => { const values = []; if (chunk) for (let i = 0; i + 1 < chunk.data.length; i += 2) values.push(chunk.data.readInt16LE(i)); return values; };
const subChunks = chunk => (chunk ? readChunks(chunk.data, 0, chunk.data.length) : []);

// ---- event commands ---------------------------------------------------------
// RM2000/2003 command codes (liblcf rpg::EventCommand) -> MWGP vocabulary.
const CODE = {
  message: 10110, message2: 20110, choice: 10110 + 30, inputNumber: 10150, switches: 10210, vars: 10220,
  gold: 10310, items: 10320, party: 10330, shop: 10720, teleport: 10810, picture: 11110, movePicture: 11120,
  erasePicture: 11130, wait: 11410, bgm: 11510, sound: 11550, conditional: 12010, elseBranch: 22010,
  endBranch: 22011, loop: 12210, endLoop: 22210, breakLoop: 12220, exitEvent: 12310, eraseEvent: 12320,
  callCommon: 1005, gameOver: 12420, returnTitle: 12510, comment: 12410, choiceOption: 20140, choiceEnd: 20141,
};

function parseCommands(data) {
  // EventCommand array chunk: per command, code/indent BER, string, params.
  const commands = [];
  let cursor = 0;
  const ber = () => { let value = 0; for (;;) { const byte = data[cursor++]; value = value * 128 + (byte & 0x7f); if (!(byte & 0x80)) return value; } };
  while (cursor < data.length) {
    const code = ber(); if (code === 0 || code === 10) break;
    const indent = ber();
    const length = ber();
    const string = data.subarray(cursor, cursor + length).toString('latin1'); cursor += length;
    const count = ber();
    const parameters = Array.from({ length: count }, () => ber());
    commands.push({ code, indent, string, parameters });
  }
  return commands;
}

let databaseMaps = { commonEvents: new Map() };

function convertCommandList(list, context = {}) {
  const out = [];
  let i = 0;
  const unsupported = command => out.push({ unsupported: { code: command.code, kind: 2003 } });
  while (i < list.length) {
    const command = list[i];
    const p = command.parameters;
    switch (command.code) {
      case CODE.message: case CODE.message2: {
        const lines = [command.string];
        while (list[i + 1]?.code === CODE.message2) { i++; lines.push(list[i].string); }
        out.push({ say: lines.join('\n') });
        break;
      }
      case 10140: { // Show Choice: options are the following 20140 arms.
        const choice = { ask: '', choices: [], branches: [] };
        i++;
        while (list[i]?.code === CODE.choiceOption) {
          const label = list[i].string;
          const index = choice.choices.length;
          const branch = collectBlock(list, ++i, command.indent);
          choice.choices.push({ text: label, value: index });
          choice.branches[index] = convertCommandList(branch.commands, context);
          i = branch.next;
        }
        if (list[i]?.code === CODE.choiceEnd) i++;
        out.push(choice);
        continue;
      }
      case CODE.inputNumber: out.push({ inputNumber: { variable: String(p[0]), digits: p[1] || 1 } }); break;
      case CODE.switches: {
        if (p[2] === 2) { unsupported(command); break; }
        for (let id = p[0]; id <= Math.min(p[1], p[0] + 200); id++) out.push({ setSwitch: String(id), value: p[2] !== 1 });
        break;
      }
      case CODE.vars: {
        for (let id = p[0]; id <= Math.min(p[1], p[0] + 200); id++) {
          if (p[3] === 0 && p[2] === 0) out.push({ setVariable: String(id), value: p[4] || 0 });
          else if (p[3] === 0 && (p[2] === 1 || p[2] === 2)) out.push({ addVariable: String(id), amount: (p[2] === 2 ? -1 : 1) * (p[4] || 0) });
          else if (p[3] === 1 && p[2] === 0) out.push({ copyVariable: String(id), variable: String(p[4]) });
          else unsupported(command);
        }
        break;
      }
      case CODE.gold: if (p[1] === 0) out.push({ changeGold: (p[0] === 1 ? -1 : 1) * (p[2] || 0) }); else unsupported(command); break;
      case CODE.items: out.push({ changeItem: { id: p[0], amount: (p[1] === 1 ? -1 : 1) * (p[3] || 0) } }); break;
      case CODE.party: out.push({ changeParty: { actorId: p[0], add: p[1] !== 1 } }); break;
      case CODE.shop: out.push({ shop: { goods: p.map(id => ({ kind: 0, id, priceType: 0, price: 0 })).filter(g => g.id > 0) } }); break;
      case CODE.teleport: out.push({ transfer: { mapId: p[0], x: p[1], y: p[2] } }); break;
      case CODE.picture: out.push({ picture: { id: p[0], name: command.string, origin: 0, x: p[2] || 0, y: p[3] || 0, scaleX: 100, scaleY: 100, opacity: 255, blend: 0 } }); break;
      case CODE.erasePicture: out.push({ erasePicture: p[0] }); break;
      case CODE.wait: out.push({ wait: (p[0] || 0) / 10 }); break;
      case CODE.bgm: out.push({ playBgm: { name: command.string, volume: p[1] ?? 100, pitch: p[2] ?? 100 } }); break;
      case CODE.sound: out.push({ sound: { name: command.string, volume: p[0] ?? 100, pitch: p[1] ?? 100 } }); break;
      case CODE.conditional: {
        const condition = convertCondition(p);
        const thenBlock = collectBlock(list, i + 1, command.indent);
        let elseCommands = [];
        let next = thenBlock.next;
        if (list[next]?.code === CODE.elseBranch && list[next].indent === command.indent) {
          const elseBlock = collectBlock(list, next + 1, command.indent);
          elseCommands = elseBlock.commands; next = elseBlock.next;
        }
        if (list[next]?.code === CODE.endBranch) next++;
        if (condition) out.push({ if: condition, then: convertCommandList(thenBlock.commands, context), else: convertCommandList(elseCommands, context) });
        else unsupported(command);
        i = next; continue;
      }
      case CODE.loop: {
        const body = collectBlock(list, i + 1, command.indent);
        let next = body.next;
        if (list[next]?.code === CODE.endLoop) next++;
        out.push({ loop: convertCommandList(body.commands, context) });
        i = next; continue;
      }
      case CODE.breakLoop: out.push({ breakLoop: true }); break;
      case CODE.exitEvent: out.push({ exitEvent: true }); break;
      case CODE.eraseEvent: out.push({ eraseEvent: true }); break;
      case CODE.gameOver: out.push({ gameOver: true }); break;
      case CODE.returnTitle: out.push({ returnToTitle: true }); break;
      case CODE.callCommon: {
        const common = databaseMaps.commonEvents.get(p[0]);
        if (common && (context.depth || 0) < 4) out.push(...convertCommandList(parseCommands(common), { ...context, depth: (context.depth || 0) + 1 }));
        else unsupported(command);
        break;
      }
      case CODE.comment: break;
      default: unsupported(command);
    }
    i++;
  }
  return out;
}

// Commands belonging to a block opened at `indent` (deeper indent), from index.
function collectBlock(list, start, indent) {
  const commands = [];
  let i = start;
  while (i < list.length && list[i].indent > indent) { commands.push(list[i]); i++; }
  return { commands, next: i };
}

function convertCondition(p) {
  switch (p[0]) {
    case 0: return { switch: String(p[1]), equals: p[2] === 0 };
    case 1: {
      const ops = ['eq', 'gte', 'lte', 'gt', 'lt', 'neq'];
      return { variable: String(p[1]), operator: ops[p[4]] || 'eq', ...(p[2] === 1 ? { compareVariable: String(p[3]) } : { value: p[3] || 0 }) };
    }
    case 2: return { item: p[1] };
    case 5: return { gold: { operator: ['gte', 'lte', 'lt'][p[2]] || 'gte', value: p[1] || 0 } };
    default: return null;
  }
}

// ---- main -------------------------------------------------------------------
const files = await readdir(source);
const database = parseDatabase(await readFile(join(source, 'RPG_RT.ldb')));
const tree = parseMapTree(await readFile(join(source, 'RPG_RT.lmt')));
for (const event of database.commonEvents) {
  const chunk = findChunk(event.chunks, 0x16);
  if (chunk) databaseMaps.commonEvents.set(event.id, chunk.data);
}

const systemChunks = database.system || [];
const titleName = str(systemChunks, 0x11);
const partyShorts = shorts(findChunk(systemChunks, 0x16));
const startParty = partyShorts.length ? partyShorts : [database.actors.find(a => a.id)?.id || 1];

// Tilesets with passage, converted to MWGP flags indexed by atlas frame.
const { chipsetFrameFor: frameFor } = await import('../src/player/chipset.js');
function convertTileset(record) {
  const lowerPassage = findChunk(record.chunks, 4)?.data || new Uint8Array(0);
  const upperPassage = findChunk(record.chunks, 5)?.data || new Uint8Array(0);
  const flags = [];
  const apply = (id, byte) => {
    const frame = frameFor(id);
    if (!frame) return;
    // RM2k passage byte: bits 0-3 passable directions, bit4 star (above),
    // bit5 counter. MWGP flags: bits 0-3 blocked directions, 0x10 star.
    flags[frame] = ((~byte) & 0x0f) | (byte & 0x10);
  };
  for (let i = 0; i < lowerPassage.length; i++) {
    const id = i < 3 ? i * 1000 : i < 6 ? 3000 + (i - 3) * 50 : i < 18 ? 4000 + (i - 6) * 50 : 5000 + (i - 18);
    // A passage byte covers its whole autotile block: apply to every variant.
    if (i < 3) for (let v = 0; v < 1000; v++) apply(id + v, lowerPassage[i]);
    else if (i < 18) for (let v = 0; v < 50; v++) apply(id + v, lowerPassage[i]);
    else apply(id, lowerPassage[i]);
  }
  for (let i = 0; i < upperPassage.length; i++) apply(10000 + i, upperPassage[i]);
  return {
    id: record.id, name: record.name,
    tilesetNames: [null, null, null, null, null, str(record.chunks, 2)],
    autotileNames: [], flags, priorities: [], terrainTags: [],
  };
}
const tilesets = database.tilesets.map(convertTileset);

// Database -> MV-shaped tables.
const paramTable = (chunks, id) => {
  const values = shorts(findChunk(chunks, id));
  const levels = Math.floor(values.length / 6);
  const params = Array.from({ length: 8 }, () => Array(levels + 1).fill(0));
  for (let level = 1; level <= levels; level++) {
    const row = values.slice((level - 1) * 6, level * 6);
    [params[0][level], params[1][level], params[2][level], params[3][level], params[4][level], params[6][level]] = row;
    params[5][level] = params[4][level]; params[7][level] = params[6][level];
  }
  return params;
};
const learnings = chunks => readArray(findChunk(chunks, 0x3f)?.data || new Uint8Array(0)).map(entry => ({ level: int(entry.chunks, 1, 1), skillId: int(entry.chunks, 2) }));
const expCurveFor = record => {
  const base = int(record.chunks, 0x29, 30), inflation = int(record.chunks, 0x2a, 30), correction = int(record.chunks, 0x2b, 0);
  return Array.from({ length: 100 }, (_, level) => Math.round(base * Math.pow(1 + inflation / 100, level) + correction * level));
};
const db = { system: { partyMembers: startParty, currencyUnit: 'G', terms: { basic: ['Level', 'Lv', 'HP', 'HP', 'MP', 'MP', 'TP', 'TP', 'EXP'], params: ['Max HP', 'Max MP', 'Attack', 'Defense', 'Spirit', 'Agility'], commands: [], messages: {} } } };
db.actors = database.actors.map(a => ({
  id: a.id, name: a.name, classId: int(a.chunks, 0x39, 1), initialLevel: int(a.chunks, 0x07, 1), maxLevel: int(a.chunks, 0x08, 99) || 99,
  characterName: str(a.chunks, 0x03), characterIndex: int(a.chunks, 0x04), faceName: str(a.chunks, 0x0f), faceIndex: int(a.chunks, 0x10),
  equips: shorts(findChunk(a.chunks, 0x33)).slice(0, 5), params: paramTable(a.chunks, 0x1f), expCurve: expCurveFor(a), profile: str(a.chunks, 0x02), traits: [],
}));
db.classes = (database.classes || []).map(c => ({ id: c.id, name: c.name, params: paramTable(c.chunks, 0x1f), learnings: learnings(c.chunks), expParams: [30, 20, 30, 30], traits: [] }));
db.skills = database.skills.map(s => {
  const power = int(s.chunks, 0x18), phys = int(s.chunks, 0x15), mag = int(s.chunks, 0x16);
  const stateEffects = findChunk(s.chunks, 0x2a)?.data || new Uint8Array(0);
  const effects = [...stateEffects].flatMap((on, index) => on ? [{ code: 21, dataId: index + 1, value1: 1, value2: 0 }] : []);
  return {
    id: s.id, name: s.name, description: str(s.chunks, 0x02), mpCost: int(s.chunks, 0x0b), tpCost: 0,
    scope: [1, 2, 11, 7, 8, 11][int(s.chunks, 0x0c)] ?? 1, occasion: 1, speed: 0, successRate: int(s.chunks, 0x19, 100) || 100,
    repeats: 1, tpGain: 0, hitType: phys >= mag ? 1 : 2, animationId: int(s.chunks, 0x0e),
    damage: { type: flag(s.chunks, 0x1f) ? 1 : 0, elementId: 0, formula: power || phys || mag ? `Math.max(${power} + a.atk * ${phys} / 100 + a.mat * ${mag} / 100 - b.def / 2, 0)` : '0', variance: int(s.chunks, 0x17, 20), critical: false },
    effects, message1: str(s.chunks, 0x03), message2: str(s.chunks, 0x04), note: '',
  };
});
const itemTables = { items: [], weapons: [], armors: [] };
for (const item of database.items) {
  const type = int(item.chunks, 0x03);
  const base = { id: item.id, name: item.name, description: str(item.chunks, 0x02), price: int(item.chunks, 0x05), note: '' };
  if (type === 1) itemTables.weapons.push({ ...base, params: [0, 0, int(item.chunks, 0x0b), int(item.chunks, 0x0c), int(item.chunks, 0x0d), int(item.chunks, 0x0d), int(item.chunks, 0x0e), 0], traits: [], animationId: int(item.chunks, 0x14), wtypeId: 0, etypeId: 1 });
  else if (type >= 2 && type <= 5) itemTables.armors.push({ ...base, params: [0, 0, int(item.chunks, 0x0b), int(item.chunks, 0x0c), int(item.chunks, 0x0d), int(item.chunks, 0x0d), int(item.chunks, 0x0e), 0], traits: [], atypeId: type, etypeId: type });
  else itemTables.items.push({
    ...base, itypeId: 1, consumable: true, scope: 7, occasion: 0, speed: 0, successRate: 100, repeats: 1, tpGain: 0, hitType: 0, animationId: 0,
    damage: { type: 0, elementId: 0, formula: '0', variance: 0, critical: false },
    effects: [
      ...(int(item.chunks, 0x21) || int(item.chunks, 0x20) ? [{ code: 11, dataId: 0, value1: int(item.chunks, 0x20) / 100, value2: int(item.chunks, 0x21) }] : []),
      ...(int(item.chunks, 0x23) || int(item.chunks, 0x22) ? [{ code: 12, dataId: 0, value1: int(item.chunks, 0x22) / 100, value2: int(item.chunks, 0x23) }] : []),
    ],
  });
}
Object.assign(db, itemTables);
const battleIds = { attackSkill: db.skills.length, guardSkill: db.skills.length + 1, escapeSkill: db.skills.length + 2, waitSkill: db.skills.length + 3, guardState: 0 };
db.system.battleIds = battleIds;
const spareSkill = (id, name, extra = {}) => ({ id, name, description: '', mpCost: 0, tpCost: 0, scope: 0, occasion: 1, speed: 0, successRate: 100, repeats: 1, tpGain: 0, hitType: 0, animationId: 0, damage: { type: 0, elementId: 0, formula: '0', variance: 0, critical: false }, effects: [], message1: '', message2: '', note: '', ...extra });
db.skills[battleIds.attackSkill] = spareSkill(battleIds.attackSkill, 'Attack', { scope: 1, hitType: 1, damage: { type: 1, elementId: 0, formula: 'Math.max(a.atk * 2 - b.def, 0)', variance: 20, critical: false } });
db.skills[battleIds.guardSkill] = spareSkill(battleIds.guardSkill, 'Guard', { scope: 11 });
db.skills[battleIds.escapeSkill] = spareSkill(battleIds.escapeSkill, 'Escape', { scope: 11, effects: [{ code: 41, dataId: 0, value1: 0, value2: 0 }] });
db.skills[battleIds.waitSkill] = spareSkill(battleIds.waitSkill, 'Wait', { scope: 0 });

db.enemies = database.enemies.map(e => ({
  id: e.id, name: e.name, battlerName: str(e.chunks, 0x02), battlerHue: int(e.chunks, 0x03),
  params: [int(e.chunks, 0x04), int(e.chunks, 0x05), int(e.chunks, 0x06), int(e.chunks, 0x07), int(e.chunks, 0x08), int(e.chunks, 0x08), int(e.chunks, 0x09), int(e.chunks, 0x09)],
  exp: int(e.chunks, 0x0b), gold: int(e.chunks, 0x0c),
  dropItems: int(e.chunks, 0x0d) ? [{ kind: 0, dataId: int(e.chunks, 0x0d), denominator: Math.max(1, Math.round(100 / Math.max(1, int(e.chunks, 0x0e, 100)))) }] : [],
  actions: readArray(findChunk(e.chunks, 0x2a)?.data || new Uint8Array(0)).map(a => ({ skillId: int(a.chunks, 1) === 1 ? int(a.chunks, 3, battleIds.attackSkill) : battleIds.attackSkill, rating: int(a.chunks, 0x0d, 5), conditionType: int(a.chunks, 0x05), conditionParam1: int(a.chunks, 0x06), conditionParam2: int(a.chunks, 0x07) })),
  traits: [],
}));
db.troops = database.troops.map(t => ({
  id: t.id, name: t.name,
  members: readArray(findChunk(t.chunks, 2)?.data || new Uint8Array(0)).map(m => ({ enemyId: int(m.chunks, 1), x: int(m.chunks, 2, 256), y: int(m.chunks, 3, 160), hidden: flag(m.chunks, 5) })),
  pages: [],
}));
db.states = database.states.map(s => ({ id: s.id, name: s.name, restriction: 0, priority: 50, removeAtBattleEnd: false, traits: [], note: '' }));
battleIds.guardState = db.states.length;
db.states[battleIds.guardState] = { id: battleIds.guardState, name: 'Guard', restriction: 0, priority: 0, removeAtBattleEnd: true, traits: [], note: '' };
db.troopEvents = {};

// Maps and events.
const mapFiles = files.filter(name => /^Map\d+\.lmu$/i.test(name)).sort();
const maps = [];
const characterNames = new Set();
for (const file of mapFiles) {
  const id = Number(file.match(/\d+/)[0]);
  const raw = parseMap(await readFile(join(source, file)));
  const size = raw.width * raw.height;
  const layer = tiles => Array.from({ length: size }, (_, i) => chipsetFrameFor(tiles[i] || 0));
  const empty = Array(size).fill(0);
  const mwgEvents = raw.events.map(event => ({
    id: String(event.id), name: event.name, x: event.x, y: event.y,
    pages: event.pages.map(page => {
      const condition = subChunks(findChunk(page.chunks, 0x02));
      const conditions = [];
      const flags = int(condition, 1);
      if (flags & 1) conditions.push({ switch: String(int(condition, 2, 1)), equals: true });
      if (flags & 2) conditions.push({ switch: String(int(condition, 3, 1)), equals: true });
      if (flags & 4) conditions.push({ variable: String(int(condition, 4, 1)), atLeast: int(condition, 5) });
      const commandsData = findChunk(page.chunks, 0x34);
      const commands = commandsData ? convertCommandList(parseCommands(commandsData.data)) : [];
      const spriteName = str(page.chunks, 0x15);
      if (spriteName) characterNames.add(spriteName);
      return {
        trigger: ['action', 'touch', 'touch', 'autorun', 'parallel'][int(page.chunks, 0x21)] || 'action',
        conditions, commands,
        through: int(page.chunks, 0x22) === 0,
        priorityType: int(page.chunks, 0x22) === 1 ? 1 : 0,
        image: spriteName ? { name: spriteName, index: int(page.chunks, 0x16), direction: [8, 6, 2, 4][int(page.chunks, 0x17, 2)] || 2, pattern: Math.min(2, int(page.chunks, 0x18, 1)) } : null,
      };
    }),
  }));
  const info = tree.maps.find(map => map.id === id);
  maps.push({
    id, info: info ? { id, name: info.name, parentId: info.parentId } : { id, name: `Map ${id}` },
    data: { width: raw.width, height: raw.height, data: [...layer(raw.lower), ...layer(raw.upper), ...empty, ...empty, ...empty, ...empty], tilesetId: raw.chipsetId, encounterList: [], encounterStep: 30, autoplayBgm: false, bgm: null, autoplayBgs: false, bgs: null },
    mwgEvents,
  });
}

// Assets: chipsets, character sets, pictures and audio keep their folders.
await mkdir(join(output, 'assets', 'img', 'tilesets'), { recursive: true });
await mkdir(join(output, 'assets', 'img', 'characters'), { recursive: true });
const copyTree = async (from, to, exts) => {
  if (!existsSync(from)) return 0;
  await mkdir(to, { recursive: true });
  let count = 0;
  for (const entry of await readdir(from)) {
    if (exts && !exts.includes(extname(entry).toLowerCase())) continue;
    await copyFile(join(from, entry), join(to, entry)); count++;
  }
  return count;
};
const imageExts = ['.png', '.bmp', '.xyz'];
await copyTree(join(source, 'ChipSet'), join(output, 'assets', 'img', 'tilesets'), imageExts);
await copyTree(join(source, 'CharSet'), join(output, 'assets', 'img', 'characters'), imageExts);
await copyTree(join(source, 'Picture'), join(output, 'assets', 'img', 'pictures'), imageExts);
await copyTree(join(source, 'FaceSet'), join(output, 'assets', 'img', 'faces'), imageExts);
await copyTree(join(source, 'Panorama'), join(output, 'assets', 'img', 'parallaxes'), imageExts);
await copyTree(join(source, 'Title'), join(output, 'assets', 'img', 'titles1'), imageExts);
for (const [folder, kind] of [['Music', 'bgm'], ['Sound', 'se']]) {
  const from = join(source, folder);
  if (!existsSync(from)) continue;
  const to = join(output, 'assets', 'audio', kind);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const ext = extname(entry).toLowerCase();
    if (!['.mp3', '.ogg', '.wav', '.mid', '.midi'].includes(ext)) continue;
    await copyFile(join(from, entry), join(to, entry));
  }
}
const audioIndex = buildAudioIndex(join(output, 'assets', 'audio'));

const firstActor = db.actors.find(a => startParty.includes(a.id)) || db.actors[0] || {};
const startMap = maps[0];
const manifest = {
  format: 'MWGP', version: 1, converter: { name: 'convert-lcf', version: '0.2.6' },
  source: { engine: 'rpg-maker-2003', projectName: basename(source), title: titleName || basename(source) },
  display: { tileSize: 16, font: null },
  initialMapId: startMap?.id || 1,
  player: { mapId: startMap?.id || 1, x: Math.min(9, (startMap?.data.width || 20) - 1), y: Math.min(7, (startMap?.data.height || 15) - 1), direction: 2 },
  playerSprite: { name: firstActor.characterName || '', index: firstActor.characterIndex || 0 },
  characterFrames: Object.fromEntries([...characterNames, firstActor.characterName].filter(Boolean).map(name => [name, { format: 'rm2k', big: false, object: false, fw: 24, fh: 32 }])),
  assets: { root: 'assets', kind: 'decoded', tilesets: true, characters: true, pictures: true, faces: true, audio: Object.keys(audioIndex.bgm).length > 0 },
  audio: { index: audioIndex, system: {}, soundfont: null },
  tilesets, maps, database: db,
  plugins: [], compatibility: { commands: {} }, titleScreen: { title1Name: '', title2Name: '', drawGameTitle: true },
};
await mkdir(output, { recursive: true });
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest));
console.log(JSON.stringify({ project: basename(source), maps: maps.length, events: maps.reduce((n, m) => n + m.mwgEvents.length, 0), tilesets: tilesets.length, actors: db.actors.length, out: output }, null, 2));
