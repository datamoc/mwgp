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
import { CONVERTER_VERSION } from './converter-version.mjs';
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
// Layouts pinned against the EasyRPG Player interpreters (local reference
// checkout C:/Users/miche/dev/EasyRPG/Player/src/game_interpreter*.cpp, notes
// in notes/rpgmaker-docs/lcf-command-params.md) and the real command streams of
// the two installed projects.
const CODE = {
  message: 10110, message2: 20110, choice: 10110 + 30, inputNumber: 10150, switches: 10210, vars: 10220,
  gold: 10310, items: 10320, party: 10330, shop: 10720, teleport: 10810, picture: 11110, movePicture: 11120,
  erasePicture: 11130, wait: 11410, bgm: 11510, sound: 11550, conditional: 12010, elseBranch: 22010,
  endBranch: 22011, loop: 12210, endLoop: 22210, breakLoop: 12220, exitEvent: 12310, eraseEvent: 12320,
  callCommon: 1005, gameOver: 12420, returnTitle: 12510, comment: 12410, choiceOption: 20140, choiceEnd: 20141,
  messageOptions: 10120, face: 10130, timer: 10230,
  changeExp: 10410, changeLevel: 10420, changeParameters: 10430, changeSkills: 10440, changeEquipment: 10450,
  changeHp: 10460, changeSp: 10470, changeCondition: 10480, fullHeal: 10490,
  changeName: 10610, changeTitle: 10620, changeSprite: 10630, changeActorFace: 10640, changeVehicleGraphic: 10650,
  changeSystemBgm: 10660, changeSystemSfx: 10670,
  enemyEncounter: 10710, enterHeroName: 10740,
  memorizeLocation: 10820, recallLocation: 10830, enterExitVehicle: 10840, setVehicleLocation: 10850, changeEventLocation: 10860,
  eraseScreen: 11010, showScreen: 11020, tintScreen: 11030, flashScreen: 11040, shakeScreen: 11050, weather: 11070,
  battleAnimation: 11210, playerVisibility: 11310, moveEvent: 11330,
  fadeoutBgm: 11520, memorizeBgm: 11530, playMemorizedBgm: 11540, playMovie: 11560,
  changeTileset: 11710, changePbg: 11720, encounterSteps: 11740,
  openSaveMenu: 11910, changeSaveAccess: 11930, openMainMenu: 11950, changeMenuAccess: 11960,
  changeTeleportAccess: 11820, changeEscapeAccess: 11840,
  label: 12110, jumpToLabel: 12120, callEvent: 12330,
  changeMonsterHp: 13110, changeMonsterMp: 13120, changeMonsterCondition: 13130,
  showHiddenMonster: 13150, changeBattleBg: 13210, terminateBattle: 13410, changeClass: 1008,
};

// RM2000/2003 stores items, weapons and armors in ONE id space (liblcf Data::items,
// Item::Type_*). The MWGP database splits them into separate tables (ids kept), so a
// command carrying a raw id classifies through this map.
const unifiedType = new Map();
const unifiedKind = id => {
  const type = unifiedType.get(Number(id)) || 0;
  return type === 1 ? 1 : type >= 2 && type <= 5 ? 2 : 0; // 1 weapon, 2 armor, 0 item
};
// Operands: RM2000/2003 OperateValue(operation, operandType, operand) — direct (0) or a
// variable (1). The MWGP stat commands take the same {variable} amount shape as MV.
const amountOf = (operandType, operand) => operandType === 0 ? Number(operand || 0) : { variable: String(operand ?? 0) };

// Control Variables operand (p[4] type, p[5..6] values) -> an MWGP operand shape, or
// null when no equivalent exists (indirect values, actor stats, per-event data
// beyond the player's position, Maniac operands).
function controlOperand(p) {
  switch (p[4]) {
    case 0: return { value: p[5] || 0 };
    case 1: return { variable: String(p[5]) };
    case 3: return { random: [Math.min(p[5], p[6]), Math.max(p[5], p[6])] };
    case 4: {
      if (p[6] !== 0) return null; // "how often equipped" has no MWGP kind
      const kind = unifiedKind(p[5] || 0);
      return { gameData: { kind: kind === 1 ? 'weaponCount' : kind === 2 ? 'armorCount' : 'itemCount', id: String(p[5]) } };
    }
    case 6: {
      // Event data (p[5] character, p[6] sub: 0 map id, 1 x, 2 y): only the
      // player's position exists in the vocabulary.
      if (p[5] !== 10001 && p[5] !== 0) return null;
      const kind = ['mapId', 'playerX', 'playerY'][p[6]];
      return kind ? { gameData: { kind } } : null;
    }
    case 7: {
      // "Other": 0 gold, 1 timer seconds, 2 party size, 3 save count, 4 battle
      // count, 5 wins, 6 escapes — all player-held rpgExtra counters.
      const kind = ['gold', 'timer', 'partySize', 'saveCount', 'battleCount', 'winCount', 'escapeCount'][p[6]];
      return kind ? { gameData: { kind } } : null;
    }
    default: return null;
  }
}

// RM2k3 move-route codes (liblcf MoveCommand, 0-based) -> MWGP move step descriptors.
// Only codes 32-35 carry stream parameters (DecodeMove in EasyRPG's interpreter shared code).
const ROUTE_STEP = { 0: { dx: 0, dy: -1 }, 1: { dx: 1, dy: 0 }, 2: { dx: 0, dy: 1 }, 3: { dx: -1, dy: 0 }, 4: { dx: 1, dy: -1 }, 5: { dx: 1, dy: 1 }, 6: { dx: -1, dy: 1 }, 7: { dx: -1, dy: -1 } };
const ROUTE_MOVE = { 8: { random: true }, 9: { toward: true }, 10: { away: true }, 11: { forward: true } };
const ROUTE_TURN = { 12: 'up', 13: 'right', 14: 'down', 15: 'left', 16: 'right90', 17: 'left90', 18: 'around', 19: 'random', 20: 'random', 21: 'toward', 22: 'away' };

// Change Sprite/Face rewrite the actor's whole image record (changeActorImages replaces
// every field), so the conversion tracks each actor's images across the project.
const actorImages = new Map();
const imagesFor = id => {
  let record = actorImages.get(id);
  if (!record) {
    const actor = database.actors.find(a => a.id === id) || {};
    record = {
      characterName: str(actor.chunks, 0x03), characterIndex: int(actor.chunks, 0x04),
      faceName: str(actor.chunks, 0x0f), faceIndex: int(actor.chunks, 0x10),
    };
    actorImages.set(id, record);
  }
  return record;
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
        out.push({ say: lines.join('\n'), ...(context.face ? { portrait: context.face } : {}) });
        break;
      }
      case CODE.face: context.face = { name: command.string, index: 0 }; break;
      case CODE.messageOptions: out.push({ messageOptions: { position: p[1] || 0, frame: p[0] !== 0 ? 2 : 0 } }); break;
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
      case CODE.inputNumber: out.push({ inputNumber: { variable: String(p[1]), digits: p[0] || 1 } }); break;
      case CODE.switches: {
        if (p[2] === 2) { // toggle: flip each switch of the range from its current value
          for (let id = p[0]; id <= Math.min(p[1], p[0] + 200); id++) out.push({ if: { switch: String(id), equals: true }, then: [{ setSwitch: String(id), value: false }], else: [{ setSwitch: String(id), value: true }] });
          break;
        }
        for (let id = p[0]; id <= Math.min(p[1], p[0] + 200); id++) out.push({ setSwitch: String(id), value: p[2] !== 1 });
        break;
      }
      case CODE.vars: {
        // RM2000/2003 layout (verified against EasyRPG's CommandControlVariables and
        // real tuples): p[0] target mode (0 single, 1 range, 2/3 indirect), p[1] first
        // var, p[2] last var, p[3] operation (0 set, 1 add, 2 sub, 3 mult, 4 div,
        // 5 mod), p[4] operand type, p[5..6] operands. The earlier converter read
        // p[2]/p[3]/p[4] as op/type/value — every Control Variables misconverted.
        const operation = ['set', 'add', 'subtract', 'multiply', 'divide', 'modulo'][p[3]];
        const operand = operation ? controlOperand(p) : null;
        if (!operation || !operand) { unsupported(command); break; }
        for (let id = p[1]; id <= Math.min(p[2], p[1] + 200); id++) {
          if (operation === 'set' && operand.value !== undefined) out.push({ setVariable: String(id), value: operand.value });
          else if (operation === 'add' && operand.value !== undefined) out.push({ addVariable: String(id), amount: operand.value });
          else out.push({ modifyVariable: { target: String(id), operation, operand } });
        }
        break;
      }
      case CODE.timer: {
        // 2003 carries a second timer id in p[5]; the player runs one timer.
        if ((p[5] || 0) > 0 || p[1] === 1) { unsupported(command); break; }
        if (p[0] === 2) out.push({ timer: { stop: true } });
        else out.push({ timer: { start: p[2] || 0 } });
        break;
      }
      case CODE.gold:
        // p[1] 0 direct / 1 a variable (read when the command runs, like MV 125).
        if (p[1] === 0) out.push({ changeGold: (p[0] === 1 ? -1 : 1) * (p[2] || 0) });
        else if (p[1] === 1) out.push({ changeGold: { variable: String(p[2]), op: p[0] === 1 ? 'sub' : 'add' } });
        else unsupported(command);
        break;
      case CODE.items: {
        // p[0] operation (0 add / 1 remove), p[1] item-id mode (0 direct), p[2] id,
        // p[3] amount mode, p[4] amount. RM2000 ids span items AND weapons/armors.
        if (p[1] > 1 || p[3] > 1) { unsupported(command); break; }
        const amount = p[3] === 0 ? (p[0] === 1 ? -1 : 1) * (p[4] || 0) : { variable: String(p[4]), op: p[0] === 1 ? 'sub' : 'add' };
        if (p[1] === 1) { out.push({ changeItem: { idVariable: String(p[2]), amount } }); break; } // the id (hence the store) is read when the command runs
        const kind = unifiedKind(p[2] || 0);
        out.push(kind === 1 ? { changeWeapon: { id: p[2], amount } } : kind === 2 ? { changeArmor: { id: p[2], amount } } : { changeItem: { id: p[2] || 0, amount } });
        break;
      }
      case CODE.party: {
        // p[0] operation (0 add / 1 remove), p[1] id mode, p[2] actor id.
        if (p[1] !== 0) { unsupported(command); break; }
        out.push({ changeParty: { actorId: p[2] || 0, add: p[0] === 0 } });
        break;
      }
      case CODE.shop: {
        // p[0] 0 buy&sell / 1 buy only / 2 sell only, p[1] shop type, p[2] handlers
        // flag; the goods ids start at p[4] (CommandOpenShop in EasyRPG).
        const goods = p.slice(4).filter(id => id > 0).map(id => ({ kind: unifiedKind(id), id }));
        if (!goods.length) { unsupported(command); break; }
        out.push({ shop: { goods, purchaseOnly: p[0] === 1 } });
        break;
      }
      case CODE.teleport: out.push({ transfer: { mapId: p[0], x: p[1], y: p[2] } }); break;
      case CODE.picture: {
        const at = (p[1] & 0xff) === 1 ? { xVar: String(p[2]), yVar: String(p[3]) } : { x: p[2] || 0, y: p[3] || 0 }; // x/y direct or read from variables when the command runs
        out.push({
          picture: {
            id: p[0], name: command.string, origin: (p[1] >> 8) & 0xff ? 1 : 0, ...at,
            scaleX: p[5] || 100, scaleY: p[5] || 100, opacity: 255 - (p[6] || 0),
          },
        });
        if (p[8] || p[9] || p[10] || p[11]) out.push({ tintPicture: { id: p[0], tone: [p[8] || 0, p[9] || 0, p[10] || 0, p[11] || 0], duration: 0, wait: false } });
        break;
      }
      case CODE.movePicture: {
        const at = (p[1] & 0xff) === 1 ? { xVar: String(p[2]), yVar: String(p[3]) } : { x: p[2] || 0, y: p[3] || 0 };
        out.push({
          movePicture: {
            id: p[0], ...at,
            scaleX: p[5] || 100, scaleY: p[5] || 100, opacity: 255 - (p[6] || 0),
            duration: (p[14] || 0) / 10, wait: (p[15] || 0) !== 0,
          },
        });
        if (p[8] || p[9] || p[10] || p[11]) out.push({ tintPicture: { id: p[0], tone: [p[8] || 0, p[9] || 0, p[10] || 0, p[11] || 0], duration: (p[14] || 0) / 10, wait: (p[15] || 0) !== 0 } });
        break;
      }
      case CODE.erasePicture: out.push({ erasePicture: p[0] }); break;
      case CODE.wait: out.push({ wait: (p[0] || 0) / 10 }); break;
      case CODE.bgm: out.push({ playBgm: { name: command.string, volume: p[1] ?? 100, pitch: p[2] ?? 100 } }); break; // p[0] fade-in
      case CODE.sound: out.push({ sound: { name: command.string, volume: p[1] ?? 100, pitch: p[2] ?? 100 } }); break;
      case CODE.conditional: {
        const result = convertCondition(p, command, context);
        const thenBlock = collectBlock(list, i + 1, command.indent);
        let elseCommands = [];
        let next = thenBlock.next;
        if (list[next]?.code === CODE.elseBranch && list[next].indent === command.indent) {
          const elseBlock = collectBlock(list, next + 1, command.indent);
          elseCommands = elseBlock.commands; next = elseBlock.next;
        }
        if (list[next]?.code === CODE.endBranch) next++;
        if (result) out.push({
          if: result.condition,
          then: convertCommandList(result.negate ? elseCommands : thenBlock.commands, context),
          else: convertCommandList(result.negate ? thenBlock.commands : elseCommands, context),
        });
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
      case CODE.callEvent: {
        // p[0] 0 common event / 1 map event page / 2 indirect. Common events and
        // pages of an event on this map are inlined by the same conversion the 1005 path uses (the commands keep the caller's
        // event as "this event", as the engine's interpreter does).
        if (p[0] === 1) {
          const target = p[1] === 10005 ? context.eventId : p[1];
          const pageData = context.rawEvents?.find(event => event.id === target)?.pages?.[(p[2] || 1) - 1];
          const data = pageData && findChunk(pageData.chunks, 0x34);
          if (data && (context.depth || 0) < 4) out.push(...convertCommandList(parseCommands(data.data), { ...context, depth: (context.depth || 0) + 1 }));
          else unsupported(command);
          break;
        }
        if (p[0] !== 0) { unsupported(command); break; }
        const common = databaseMaps.commonEvents.get(p[1]);
        if (common && (context.depth || 0) < 4) out.push(...convertCommandList(parseCommands(common), { ...context, depth: (context.depth || 0) + 1 }));
        else unsupported(command);
        break;
      }
      case CODE.jumpToLabel: {
        // Stories (pages with top-level labels) resolve goto through passages; a
        // flat page (inlined common event) has no passage table to jump in.
        if (context.depth) unsupported(command);
        else out.push({ goto: String(p[0] ?? 0) });
        break;
      }
      case CODE.label: break; // marker: the page story split consumes it
      case CODE.changeExp: // scope, actor, operation, operandType, operand, show
        out.push({ changeActorStat: { stat: 'exp', scope: p[0], actor: p[1], amount: amountOf(p[3], p[4]), sign: p[2] === 0 ? 1 : -1, show: p[5] !== 0 } });
        break;
      case CODE.changeLevel:
        out.push({ changeLevel: { scope: p[0], actor: p[1], amount: amountOf(p[3], p[4]), sign: p[2] === 0 ? 1 : -1, show: p[5] !== 0 } });
        break;
      case CODE.changeParameters: // scope, actor, operation, param, operandType, operand
        out.push({ changeActorStat: { stat: 'param', scope: p[0], actor: p[1], param: p[3], amount: amountOf(p[4], p[5]), sign: p[2] === 0 ? 1 : -1 } });
        break;
      case CODE.changeSp:
        out.push({ changeActorStat: { stat: 'mp', scope: p[0], actor: p[1], amount: amountOf(p[3], p[4]), sign: p[2] === 0 ? 1 : -1 } });
        break;
      case CODE.changeSkills: {
        if (p[3] !== 0) { unsupported(command); break; } // skill id from a variable
        out.push({ changeSkill: { scope: p[0], actor: p[1], learn: p[2] === 0, skill: p[4] || 0 } });
        break;
      }
      case CODE.changeEquipment: {
        // p[2] 0 equip a specific item / 1 remove from slot p[3]+1; optimal-equip
        // (2/3) and party-wide scopes have no single-actor equivalent.
        if (p[0] !== 1) { unsupported(command); break; }
        if (p[2] === 1) { out.push({ changeEquipment: { actor: p[1], slot: (p[3] || 0) + 1, item: 0 } }); break; }
        if (p[2] === 0 && p[3] === 1) { out.push({ changeEquipment: { actor: p[1], itemVariable: String(p[4]) } }); break; }
        if (p[2] === 0 && p[3] === 0) {
          const kind = unifiedKind(p[4] || 0);
          if (kind === 0) { unsupported(command); break; } // consumables do not equip
          out.push({ changeEquipment: { actor: p[1], slot: kind === 1 ? 1 : unifiedType.get(p[4]) || 0, item: p[4] } });
          break;
        }
        unsupported(command);
        break;
      }
      case CODE.changeHp: // scope, actor, operation, operandType, operand, lethal — MV 311's layout
        out.push({ changeHp: { scope: p[0], actor: p[1], amount: amountOf(p[3], p[4]), sign: p[2] === 0 ? 1 : -1, allowDeath: p[5] !== 0 } });
        break;
      case CODE.changeCondition:
        out.push({ changeState: { scope: p[0], actor: p[1], add: p[2] === 0, state: p[3] } });
        break;
      case CODE.fullHeal:
        out.push({ recoverAll: { scope: p[0], actor: p[1] } });
        break;
      case CODE.changeName:
        out.push({ changeActorText: { actor: p[0], field: 'name', text: command.string } });
        break;
      case CODE.changeTitle:
        out.push({ changeActorText: { actor: p[0], field: 'nickname', text: command.string } });
        break;
      case CODE.changeSprite: {
        const images = imagesFor(p[0] || 0);
        images.characterName = command.string; images.characterIndex = p[1] || 0;
        // p[2] transparent flag: the vocabulary has no actor transparency (partial).
        out.push({ changeActorImages: { actor: p[0] || 0, ...images, battlerName: '' } });
        break;
      }
      case CODE.changeActorFace: {
        const images = imagesFor(p[0] || 0);
        images.faceName = command.string; images.faceIndex = p[1] || 0;
        out.push({ changeActorImages: { actor: p[0] || 0, ...images, battlerName: '' } });
        break;
      }
      case CODE.changeVehicleGraphic: // p[0] 0 boat / 1 ship / 2 airship
        out.push({ systemFlag: { key: `vehicleImage:${p[0] || 0}`, value: { name: command.string, index: p[1] || 0 } } });
        break;
      case CODE.changeSystemBgm: {
        // Contexts (liblcf Game_System BGM): 0 title, 1 battle, 2 victory, 3 defeat,
        // 4 gameover, 5 boat, 6 ship, 7 airship. Vehicles use the player's 0-based ids.
        const key = { 0: 'titleBgm', 1: 'battleBgm', 2: 'victoryMe', 3: 'defeatMe', 4: 'gameoverMe', 5: 'vehicleBgm:0', 6: 'vehicleBgm:1', 7: 'vehicleBgm:2' }[p[0]];
        if (!key) { unsupported(command); break; }
        out.push({ systemFlag: { key, value: { name: command.string, volume: p[2] ?? 100, pitch: p[3] ?? 100 } } });
        break;
      }
      // 10680 Change System Graphics (name, p[0] stretch, p[1] font) and 10690 Change Screen Transitions (p[0] kind, p[1] effect):
      // kept in rpgExtra.system like the other 2003 system settings; the player draws its own window skin and fades.
      case 10680: out.push({ systemFlag: { key: 'systemGraphics', value: { name: command.string, stretch: p[0] ?? 0, font: p[1] ?? 0 } } }); break;
      case 10690: out.push({ systemFlag: { key: `screenTransition:${p[0] ?? 0}`, value: p[1] ?? 0 } }); break;
      case CODE.changeSystemSfx:
        out.push({ systemFlag: { key: `systemSfx:${p[0]}`, value: { name: command.string, volume: p[1] ?? 100, pitch: p[2] ?? 100 } } });
        break;
      case CODE.enemyEncounter: {
        if (p[0] !== 0) { unsupported(command); break; } // troop id from a variable
        // p[3] escape mode (0 disallow), p[4] defeat mode (0 game over): the custom
        // handlers branch on 20710 win / 20711 escape / 20712 defeat, ended by 20713.
        const branches = {};
        let next = i + 1;
        while (next < list.length) {
          const marker = list[next];
          const name = { 20710: 'win', 20711: 'escape', 20712: 'defeat' }[marker.code];
          if (!name || marker.indent !== command.indent) break;
          const block = collectBlock(list, next + 1, command.indent);
          branches[name] = convertCommandList(block.commands, context);
          next = block.next;
        }
        while (list[next]?.code === 20713 && list[next].indent === command.indent) next++;
        out.push({ battle: { troopId: p[1] || 0, canEscape: p[3] !== 0, canLose: p[4] !== 0, ...(Object.keys(branches).length ? { branches } : {}) } });
        i = next; continue;
      }
      case CODE.enterHeroName: out.push({ inputName: { target: 'player', actorId: p[0], maxLength: 6 } }); break;
      case CODE.memorizeLocation:
        out.push(
          { modifyVariable: { target: String(p[0]), operation: 'set', operand: { gameData: { kind: 'mapId' } } } },
          { modifyVariable: { target: String(p[1]), operation: 'set', operand: { gameData: { kind: 'playerX' } } } },
          { modifyVariable: { target: String(p[2]), operation: 'set', operand: { gameData: { kind: 'playerY' } } } },
        );
        break;
      case CODE.recallLocation:
        out.push({ transfer: { mapVar: String(p[0]), xVar: String(p[1]), yVar: String(p[2]) } });
        break;
      case CODE.enterExitVehicle: out.push({ vehicleBoard: true }); break; // boards or leaves at the player's cell, like MV 206
      case CODE.setVehicleLocation: {
        if (p[1] !== 0) { unsupported(command); break; } // coordinates from variables
        out.push({ vehicleLocation: { vehicle: p[0] || 0, mapId: p[2], x: p[3] || 0, y: p[4] || 0 } });
        break;
      }
      case CODE.changeEventLocation: {
        // p[0] event id, p[1] operand mode (0 direct, 1 variables), p[2..3] x/y,
        // p[4] facing+1 (2003). The player's relocate moves the player or a map event.
        const id = p[0] || 0;
        const target = id === 0 || id === 10001 ? 'player'
          : id === 10005 ? (context.eventId != null ? `event:${context.eventId}` : 'self')
          : id >= 10002 && id <= 10004 ? null
          : id > 0 ? `event:${id}` : null;
        if (!target || p[1] > 1) { unsupported(command); break; }
        const coords = p[1] === 0 ? { x: p[2] || 0, y: p[3] || 0 } : { varX: String(p[2]), varY: String(p[3]) };
        const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[(p[4] || 0) - 1];
        out.push({ relocate: { target, ...coords, ...(facing && target === 'player' ? { facing } : {}) } });
        break;
      }
      case 10920: {
        // Store Event ID (10910, Store Terrain ID, stays unsupported: the chipset terrain table is not converted): p[0] 0 direct or 1 variables, p[1..2] x/y (or their variables), p[3] the result variable.
        if (p[0] > 1) { unsupported(command); break; }
        const where = p[0] === 0 ? { x: p[1] || 0, y: p[2] || 0 } : { xVar: String(p[1]), yVar: String(p[2]) };
        out.push({ locationInfo: { variable: String(p[3] ?? 0), info: 1, ...where } });
        break;
      }
      case CODE.eraseScreen: out.push({ screenFade: { direction: 'out', duration: 24 / 60 } }); break;
      case CODE.showScreen: out.push({ screenFade: { direction: 'in', duration: 24 / 60 } }); break;
      case CODE.tintScreen:
        out.push({ screenTint: { tone: [p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0], duration: (p[4] || 0) / 10, wait: p[5] !== 0 } });
        break;
      case CODE.flashScreen: // RM2000/2003 flash power runs 0-31
        out.push({ screenFlash: { color: [p[0] || 0, p[1] || 0, p[2] || 0], peak: Math.max(0, Math.min(1, (p[3] || 0) / 31)), duration: (p[4] || 0) / 10, wait: p[5] !== 0 } });
        break;
      case CODE.shakeScreen:
        out.push({ screenShake: { power: p[0] || 0, speed: p[1] || 0, duration: (p[2] || 0) / 10, wait: p[3] !== 0 } });
        break;
      case CODE.weather: {
        // 0 none, 1 rain, 2 snow, 3 fog (2003). Fog has no MWGP weather.
        if (p[0] === 3) { unsupported(command); break; }
        out.push({ weather: { type: ['none', 'rain', 'snow'][p[0]] || 'none', power: p[1] || 0, duration: 0, wait: false } });
        break;
      }
      case CODE.battleAnimation: {
        // p[0] animation, p[1] target (10001 hero, 10005 this event, else an event
        // id), p[2] wait, p[3] global flag (shown across maps; not reproduced).
        if (p[1] >= 10002 && p[1] <= 10004) { unsupported(command); break; }
        const target = p[1] === 10001 ? -1 : p[1] === 10005 && context.eventId != null ? context.eventId : p[1] || 0;
        out.push({ animation: { target, animation: p[0] || 0, wait: p[2] !== 0 } });
        break;
      }
      case 11060: {
        // Pan screen: p[0] 0 lock / 1 unlock / 2 pan; a pan carries direction
        // (0 up, 1 right, 2 down, 3 left), distance and speed. The 2k3 wait flag
        // rides along: the player's scroll tween is awaited like any call. The
        // camera lock/unlock has no vocabulary form.
        if (p[0] === 2) out.push({ scrollMap: { direction: [8, 6, 2, 4][p[1]] || 2, distance: p[2] || 0, speed: p[3] || 0 } });
        else unsupported(command);
        break;
      }
      case CODE.moveEvent: {
        if ((p[2] & 4) !== 0) { unsupported(command); break; } // event id from a variable
        const id = p[0] || 0;
        const target = id === 0 || id === 10001 ? 'player'
          : id === 10005 ? (context.eventId != null ? `event:${context.eventId}` : 'self')
          : id >= 10002 && id <= 10004 ? null // vehicle routes: the player's routes reach only events and the player
          : id > 0 ? `event:${id}` : null;
        if (!target) { unsupported(command); break; }
        const commands = [];
        let pending = [];
        let routeOnly = true;
        let jump = null;
        const flush = () => { if (pending.length) { commands.push({ move: { target, steps: pending } }); pending = []; } };
        const stream = p.slice(4);
        let cursor = 0;
        const readInt = () => stream[cursor++] ?? 0;
        const readString = () => Array.from({ length: readInt() }, () => String.fromCharCode(readInt() & 0xff)).join('');
        while (cursor < stream.length) {
          const code = readInt();
          if (code === 24) { jump = { dx: 0, dy: 0, steps: [] }; continue; } // begin jump
          if (code === 25) { // end jump: the engine simulates the inner moves; the net displacement is the landing
            if (jump) {
              if (jump.steps.length) pending.push({ jump: { dx: jump.dx, dy: jump.dy } });
              jump = null;
            }
            continue;
          }
          if (jump) {
            const inner = ROUTE_STEP[code];
            if (inner) { jump.dx += inner.dx; jump.dy += inner.dy; jump.steps.push(inner); continue; }
            if (jump.steps.length) pending.push(...jump.steps); // a random/relative move ruins the landing: plain steps
            jump = null;
          }
          const step = ROUTE_STEP[code] || ROUTE_MOVE[code];
          if (step) { pending.push(step); continue; }
          const turn = ROUTE_TURN[code];
          if (turn) { pending.push({ turn }); continue; }
          if (code === 23) { pending.push({ wait: 0.5 }); continue; } // one step's pause (no duration in the stream)
          if (code === 26 || code === 27) { flush(); commands.push({ routeOption: { target, option: 'directionFix', value: code === 26 } }); routeOnly = false; continue; }
          if (code === 32 || code === 33) { flush(); commands.push({ setSwitch: String(readInt() ?? 0), value: code === 32 }); routeOnly = false; continue; }
          if (code === 34) { flush(); const name = readString(); const index = readInt(); if (name) { characterNames.add(name); commands.push({ routeImage: { target, image: { name, index, direction: 2, pattern: 1 } } }); } routeOnly = false; continue; }
          if (code === 35) { flush(); const name = readString(); const volume = readInt(); const pitch = readInt(); readInt(); if (name) commands.push({ sound: { name, volume, pitch } }); routeOnly = false; continue; }
          if (code === 36 || code === 37) { flush(); commands.push({ routeThrough: { target, value: code === 36 } }); routeOnly = false; continue; }
          if (code === 38 || code === 39) { flush(); commands.push({ routeOption: { target, option: 'walkAnimation', value: code === 39 } }); routeOnly = false; continue; }
          if (code === 40 || code === 41) { flush(); commands.push({ setTransparent: { target, value: code === 40 } }); routeOnly = false; continue; }
          // 28-31: one step up or down of the speed (1-6) or frequency (1-8) scale; the player's routeOption carries it as a delta.
          if (code >= 28 && code <= 31) { flush(); commands.push({ routeOption: { target, option: code <= 29 ? 'speed' : 'frequency', delta: code % 2 === 0 ? 1 : -1 } }); routeOnly = false; continue; }
          flush();
          commands.push({ unsupported: { code: command.code, kind: 2003, route: code } });
          routeOnly = false;
        }
        if (routeOnly && !commands.length && pending.length) {
          // One pure route: repeat/skippable ride on the move itself.
          out.push({ move: { target, steps: pending, repeat: (p[2] & 1) !== 0, skippable: (p[3] || 0) !== 0 } });
        } else {
          flush();
          out.push(...commands);
        }
        // "Proceed with Movement" (11340) waits for the route to finish: it folds
        // into the move that just went out. Non-repeating routes are awaited by
        // the runner anyway, so this matters for background (repeating) ones.
        if (list[i + 1]?.code === 11340 && list[i + 1].indent === command.indent) {
          const last = out[out.length - 1];
          if (last?.move) { last.move = { ...last.move, wait: true }; i++; }
        }
        break;
      }
      case CODE.fadeoutBgm: out.push({ fadeoutBgm: { duration: (p[0] || 0) / 1000 } }); break; // 2k3 stores milliseconds
      case CODE.memorizeBgm: out.push({ saveBgm: true }); break;
      case CODE.playMemorizedBgm: out.push({ resumeBgm: true }); break;
      case CODE.playMovie: out.push({ playMovie: { name: command.string } }); break; // .avi movies ship undecoded (partial)
      case CODE.changeTileset: out.push({ changeTileset: { id: p[0] } }); break;
      case CODE.changePbg:
        out.push({ changeParallax: { name: command.string, loopX: p[0] !== 0, loopY: p[1] !== 0, sx: p[2] !== 0 ? (p[3] || 0) : 0, sy: p[4] !== 0 ? (p[5] || 0) : 0 } });
        break;
      case CODE.encounterSteps: out.push({ systemFlag: { key: 'encounterSteps', value: p[0] || 0 } }); break; // stored only
      case CODE.openSaveMenu: out.push({ menu: 'save' }); break;
      case CODE.openMainMenu: out.push({ menu: 'menu' }); break;
      case CODE.changeSaveAccess: out.push({ systemFlag: { key: 'saveAccess', value: p[0] !== 0 } }); break;
      case CODE.changeMenuAccess: out.push({ systemFlag: { key: 'menuAccess', value: p[0] !== 0 } }); break;
      case CODE.changeTeleportAccess: out.push({ systemFlag: { key: 'teleportAccess', value: p[0] !== 0 } }); break;
      case CODE.changeEscapeAccess: out.push({ systemFlag: { key: 'escapeAccess', value: p[0] !== 0 } }); break;
      case CODE.changeMonsterHp: // index, lose, operandType, operand, lethal
        out.push({ changeEnemyHp: { index: p[0], amount: p[2] === 0 ? (p[3] || 0) : { variable: String(p[3]) }, sign: p[1] > 0 ? -1 : 1, allowDeath: p[4] > 0 } });
        break;
      case CODE.changeMonsterMp:
        out.push({ changeEnemyMp: { index: p[0], amount: p[2] === 0 ? (p[3] || 0) : { variable: String(p[3]) }, sign: p[1] > 0 ? -1 : 1 } });
        break;
      case CODE.changeMonsterCondition:
        out.push({ changeEnemyState: { index: p[0], add: p[1] === 0, state: p[2] } });
        break;
      case CODE.showHiddenMonster: out.push({ enemyAppear: { index: p[0] } }); break;
      case CODE.changeBattleBg: out.push({ systemFlag: { key: 'battleback', value: { first: command.string } } }); break;
      case CODE.terminateBattle: out.push({ abortBattle: true }); break;
      case CODE.changeClass: {
        if (p[0] !== 1) { unsupported(command); break; } // party-wide / variable actor
        out.push({ changeClass: { actor: p[1], classId: p[2] || 0, keepExp: p[5] === 0 } });
        break;
      }
      case 11350: out.push({ haltMovement: true }); break; // Halt All Movement: every running route stops
      case 11340: break; // Proceed with Movement after anything but a route: nothing is running that a wait could cover
      case CODE.comment: case 22410: break; // 22410 continues a comment over several lines
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

// Top-level labels (12110) split a page into passages the player's story driver
// follows: it runs them in order and { goto } (12120) jumps between them, like
// MV's label handling. Labels nested inside blocks stay put; a goto that targets
// one warns loudly at run time (no passage holds it).
function convertPageStory(raw, context) {
  if (!raw.some(command => command.code === CODE.label && command.indent === 0)) {
    return { commands: convertCommandList(raw, context) };
  }
  const passages = { main: [] };
  const order = ['main'];
  let current = 'main';
  for (const command of raw) {
    if (command.code === CODE.label && command.indent === 0) {
      const name = String(command.parameters[0] ?? `label${order.length}`);
      if (passages[name]) console.warn(`MWGP convert: duplicate label "${name}" (map ${context.mapId ?? '?'}); later passage wins`);
      else { passages[name] = []; order.push(name); }
      current = name;
      continue;
    }
    (passages[current] ||= []).push(command);
  }
  return {
    commands: [],
    story: {
      passages: Object.fromEntries(Object.entries(passages).map(([name, list]) => [name, convertCommandList(list, context)])),
      order,
      start: 'main',
    },
  };
}

// Conditional branch (12010), RM2000/2003 layout (verified against EasyRPG's
// CommandConditionalBranch): 0 switch, 1 variable, 2 timer, 3 gold, 4 item,
// 5 actor sub-conditions, 6 character facing. Returns { condition, negate }:
// negated forms (a "not having" item check) swap the branch bodies, which the
// vocabulary cannot express any other way.
function convertCondition(p, command, context) {
  switch (p[0]) {
    case 0: return { condition: { switch: String(p[1]), equals: p[2] === 0 } };
    case 1: {
      const ops = ['eq', 'gte', 'lte', 'gt', 'lt', 'neq'];
      return { condition: { variable: String(p[1]), operator: ops[p[4]] || 'eq', ...(p[2] === 1 ? { compareVariable: String(p[3]) } : { value: p[3] || 0 }) } };
    }
    case 2: return { condition: { timer: { seconds: p[1] || 0, atLeast: p[2] === 0 } } };
    case 3: return { condition: { gold: { operator: p[2] === 0 ? 'gte' : 'lte', value: p[1] || 0 } } };
    case 4: return { condition: { item: p[1] || 0 }, negate: p[2] !== 0 };
    case 5: {
      // Actor: p[1] actor id, p[2] sub (0 in party, 1 name, 2 level, 3 hp,
      // 4 skill learned, 5 equipped, 6 state), p[3] value, string = name.
      switch (p[2]) {
        case 0: return { condition: { partyMember: p[1] || 0 } };
        case 1: return { condition: { actorName: { actor: p[1] || 0, name: command.string } } };
        case 4: return { condition: { actorSkill: { actor: p[1] || 0, skill: p[3] || 0 } } };
        case 5: { // equipped: weapons and armors share the item id space, the player checks the matching slot kind
          const kind = unifiedKind(p[3] || 0);
          return kind === 1 ? { condition: { actorWeapon: { actor: p[1] || 0, weapon: p[3] } } } : kind === 2 ? { condition: { actorArmor: { actor: p[1] || 0, armor: p[3] } } } : null;
        }
        case 6: return { condition: { actorState: { actor: p[1] || 0, state: p[3] || 0 } } };
        default: return null; // level/hp comparisons and "is equipped" have no MWGP condition
      }
    }
    case 6: {
      // Facing: 10001 hero, 10005 (or 0 in RM2000 files) this event; other
      // events have no per-id facing condition in the vocabulary. Directions
      // are the 2/4/6/8 numpad, like XP.
      const facing = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' }[p[2]];
      if (!facing) return null;
      if (p[1] === 10001) return { condition: { facing } };
      if (p[1] === 10005 || p[1] === 0) return { condition: { eventFacing: facing } };
      return null;
    }
    case 7: return { condition: { vehicle: ['boat', 'ship', 'airship'][p[1]] } };
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
  unifiedType.set(item.id, type);
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
      const eventId = event.id;
      const converted = commandsData
        ? convertPageStory(parseCommands(commandsData.data), { mapId: id, eventId, rawEvents: raw.events })
        : { commands: [] };
      const spriteName = str(page.chunks, 0x15);
      if (spriteName) characterNames.add(spriteName);
      return {
        trigger: ['action', 'touch', 'touch', 'autorun', 'parallel'][int(page.chunks, 0x21)] || 'action',
        conditions,
        commands: converted.commands,
        ...(converted.story ? { story: converted.story } : {}),
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
  // "version" first: readManifestConverterVersion reads only the first bytes of the file.
  format: 'MWGP', version: 1, converter: { version: CONVERTER_VERSION, name: 'convert-lcf' },
  source: { engine: 'rpg-maker-2003', projectName: basename(source), title: titleName || basename(source) },
  display: { tileSize: 16, font: null },
  initialMapId: startMap?.id || 1,
  player: { mapId: startMap?.id || 1, x: Math.min(9, (startMap?.data.width || 20) - 1), y: Math.min(7, (startMap?.data.height || 15) - 1), direction: 2 },
  playerSprite: { name: firstActor.characterName || '', index: firstActor.characterIndex || 0 },
  characterFrames: Object.fromEntries([...characterNames, firstActor.characterName].filter(Boolean).map(name => [name, { format: 'rm2k', big: false, object: false, fw: 24, fh: 32 }])),
  assets: { root: 'assets', kind: 'decoded', tilesets: true, characters: true, pictures: true, faces: true, audio: Object.keys(audioIndex.bgm).length > 0 },
  audio: { index: audioIndex, system: {}, soundfont: null },
  tilesets, maps, database: db,
  // 2000/2003 items, weapons and armors share one id space: the kind (1 weapon, 2-5 armor type) of the ids a variable can name.
  itemKinds: Object.fromEntries([...unifiedType].filter(([, type]) => type >= 1 && type <= 5)),
  plugins: [], compatibility: { commands: {} }, titleScreen: { title1Name: '', title2Name: '', drawGameTitle: true },
};
await mkdir(output, { recursive: true });
await writeFile(join(output, 'mwgp.json'), JSON.stringify(manifest));
console.log(JSON.stringify({ project: basename(source), maps: maps.length, events: maps.reduce((n, m) => n + m.mwgEvents.length, 0), tilesets: tilesets.length, actors: db.actors.length, out: output }, null, 2));
