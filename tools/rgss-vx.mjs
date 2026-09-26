// RPG Maker VX (RGSS2) support for the RGSS converter (T122).
//
// VX ships Data/*.rvdata (same Ruby Marshal envelope as XP's .rxdata) with
// renumbered event commands and RGSS2 scripts (plain Ruby, same
// Ruby2JS pipeline as XP). Facts below come from the VX interpreter's own
// command set (BASE table: every code VX dispatches; Ace-only codes listed
// separately) and its parameter layouts, cross-checked against the XP
// converter's verified cases — never inferred from MV's numbering:
//
// - 205 is Set Move Route [character_id, move_route] with 505 continuations
//   (XP's 209/509 pair); 203 is Set Event Location [character_id,
//   designation, x, y, direction] (XP's 202 relocate shape); 204 is Scroll
//   Map [direction, distance, speed] (XP's 203 scroll shape, same dialog
//   order); 214 is Erase Event (XP's 116).
// - 101/401 carry the text (VX has no face graphics); 111 branch types and
//   122 operand kinds are numbered exactly like XP's.
// - 122 kind 7 (Other) is stock VX here, not Essentials' override: index 0
//   is the map id and 2 the gold; index 1 (party members) has no MWGP
//   operand and stays loud.
// - 230 is Wait [frames] at the stock 60 fps (XP's 106 wait is
//   Essentials-specific at /20); move-route step 15 waits share that rate.
// - 212/213 are the real Show Animation / Show Balloon Icon
//   [character_id, id, wait]; 211 (transparency), 313/315-319 and 318/319
//   actor commands have layouts this converter cannot verify without a real
//   VX project, so they stay loud markers.
// - No Tilesets database and no tileset_id on maps: one global tileset
//   (Graphics/System/TileA1..A5, TileB..E). Tile passage flags have no
//   database source, so the manifest carries empty flags and conversion
//   warns loudly; movement is unclamped until the source is found.
// - VX map Tables are width x height x 3 (lower, upper, shadow): only the
//   two tile layers convert (MV layers 0 and 4); the shadow layer is
//   dropped with a loud note when a project actually uses it. Tile ids are
//   already in MV's number space (VX introduced the layout), so they pass
//   through unchanged.
// - The VX database (flat stat fields, parameter curves as Tables) is not
//   mapped: convertRgssDatabase stays XP-only and VX manifests ship
//   database {} (dialogue-duel battles, small save/close menu), like the
//   placeholder-database path.

export const VX_DATA_EXT = '.rvdata';
export const ENGINE_VX = 'rpg-maker-vx';
export const VX_TILE_SIZE = 32;
// Counts as frames per second for VX waits (stock engine rate).
export const VX_FPS = 60;
// The single global tileset, in sheet order.
export const VX_TILESET_SHEETS = ['TileA1', 'TileA2', 'TileA3', 'TileA4', 'TileA5', 'TileB', 'TileC', 'TileD', 'TileE'];
// VX map Table depth: lower tiles, upper tiles, shadow mask.
export const VX_MAP_LAYERS = 3;

// Every code VX's Game_Interpreter dispatches, in the editor's words.
export const VX_COMMAND_NAMES = {
  0: 'Blank', 101: 'Show Text', 102: 'Show Choices', 103: 'Input Number',
  108: 'Comment', 111: 'Conditional Branch', 112: 'Loop', 113: 'Break Loop',
  115: 'Exit Event Processing', 117: 'Call Common Event', 118: 'Label',
  119: 'Jump to Label', 121: 'Control Switches', 122: 'Control Variables',
  123: 'Control Self Switch', 124: 'Control Timer', 125: 'Change Gold',
  126: 'Change Items', 127: 'Change Weapons', 128: 'Change Armor',
  129: 'Change Party Member', 132: 'Change Battle BGM', 133: 'Change Battle End ME',
  134: 'Change Save Access', 135: 'Change Menu Access', 136: 'Change Encounter',
  201: 'Transfer Player', 202: 'Set Vehicle Location', 203: 'Set Event Location',
  204: 'Scroll Map', 205: 'Set Move Route', 206: 'Get on/off Vehicle',
  211: 'Change Transparency', 212: 'Show Animation', 213: 'Show Balloon Icon',
  214: 'Erase Event', 221: 'Fadeout Screen', 222: 'Fadein Screen',
  223: 'Tint Screen', 224: 'Flash Screen', 225: 'Shake Screen', 230: 'Wait',
  231: 'Show Picture', 232: 'Move Picture', 233: 'Rotate Picture',
  234: 'Tint Picture', 235: 'Erase Picture', 236: 'Set Weather Effects',
  241: 'Play BGM', 242: 'Fadeout BGM', 245: 'Play BGS', 246: 'Fadeout BGS',
  249: 'Play ME', 250: 'Play SE', 251: 'Stop SE', 301: 'Battle Processing',
  302: 'Shop Processing', 303: 'Name Input Processing', 311: 'Change HP',
  312: 'Change MP', 313: 'Change State', 314: 'Recover All',
  315: 'Change Experience', 316: 'Change Level', 317: 'Change Parameters',
  318: 'Change Skills', 319: 'Change Equipment', 320: 'Change Actor Name',
  321: 'Change Class', 322: 'Change Actor Graphic', 323: 'Change Vehicle Graphic',
  331: 'Change Enemy HP', 332: 'Change Enemy MP', 333: 'Change Enemy State',
  334: 'Enemy Recover All', 335: 'Enemy Appear', 336: 'Enemy Transform',
  337: 'Show Battle Animation', 339: 'Force Action', 340: 'Abort Battle',
  351: 'Open Menu Screen', 352: 'Open Save Screen', 353: 'Game Over',
  354: 'Return to Title Screen', 355: 'Script',
  401: 'Text Line', 402: 'When [choice]', 403: 'When Cancel',
  404: 'End Choices', 408: 'Comment Line', 411: 'Else', 412: 'End Branch',
  413: 'Repeat Above', 505: 'Move Command', 601: 'If Win', 602: 'If Escape',
  603: 'If Lose', 604: 'End Battle', 605: 'Shop Goods', 655: 'Script Line'
};

// Pure renumbers: the VX code means exactly what the XP code's case already
// does (same parameter positions), so the list normalizes to XP numbering
// before the shared pipeline runs. Anything else keeps its number: shared
// codes flow through unchanged and unknown ones land on loud markers.
// (214/erase is an explicit case, not a remap, because the XP 116 case is
// engine-gated.)
export const VX_COMMAND_REMAP = { 203: 202, 204: 203, 205: 209 };
export function vxRemap(code) {
  return VX_COMMAND_REMAP[Number(code)] ?? null;
}

// VX Set Weather Effects type enum (0 None, 1 Rain, 2 Storm, 3 Snow) onto
// the weather type strings the player renders.
export function vxWeatherType(type) {
  return ({ 0: 'none', 1: 'rain', 2: 'storm', 3: 'snow' })[Number(type)] || 'none';
}

// Order of VX System's sounds array: cursor, decision, cancel, buzzer,
// equip, shop, save, load, battle start, escape, actor collapse,
// enemy collapse (same slots the XP converter reads as named keys).
export const VX_SYSTEM_SOUNDS = ['cursor', 'ok', 'cancel', 'buzzer', 'equip', 'shop',
  'save', 'load', 'battleStart', 'escape', 'actorCollapse', 'enemyCollapse'];

// Compatibility classification for VX corpora: supported codes convert
// fully (parameter layouts from the VX reference, shapes mirrored from the
// MV converter's identical commands); partial codes convert the verified
// shapes and mark the rest loud; anything else is unsupported.
export const VX_SUPPORTED = new Set([
  0, 101, 102, 103, 108, 112, 113, 115, 117, 118, 119, 121, 123, 125,
  126, 127, 128, 201, 202, 203, 204, 205, 212, 213, 214, 221, 222, 223,
  224, 225, 230, 231, 232, 234, 235, 236, 241, 242, 245, 246, 249, 250,
  251, 302, 303, 355, 401, 402, 403, 404, 408, 411, 412, 413, 505, 601,
  602, 603, 604, 605, 655
]);
export const VX_PARTIAL = new Set([111, 122, 129, 301, 314]);
export function vxCommandStatus(code) {
  const n = Number(code);
  if (VX_SUPPORTED.has(n)) return 'supported';
  if (VX_PARTIAL.has(n)) return 'partial';
  return 'unsupported';
}
