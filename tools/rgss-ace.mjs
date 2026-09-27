// RPG Maker VX Ace (RGSS3) support for the RGSS converter (T123).
//
// What is verified vs assumed here (no local Ace project or RGSS3 binary
// exists to check against — see T123):
//
// - VERIFIED (independent, non-game sources): Data/*.rvdata2 uses the same Ruby
//   Marshal envelope as .rxdata/.rvdata, so it decodes with the same reader;
//   Game.rgss3a is RGSSAD version 3 (mkxp's src/rgssad.cpp, which ships real Ace
//   games: constant table key seed*9+3, absolute payload offsets, offset 0 ends
//   the table); Ace maps pick a database tileset per map (Map Properties) and
//   Ace ships a Database Tilesets tab (Ace editor tutorials).
// - ASSUMED from VX (shared pipeline below, marked as such): Ace's event
//   command codes and parameter layouts are VX's — the editor's event command
//   list did not change between VX and Ace, and Ace is documented as an
//   enhanced VX (same 32px tiles, same TileA1-A5/TileB-E sheets, same 60fps).
//   Every genuinely Ace-shaped read (tileset ids, the Tilesets table) degrades
//   loudly when the assumed field is absent, so a wrong assumption warns
//   instead of crashing.
import { VX_COMMAND_NAMES, VX_SUPPORTED, VX_PARTIAL, vxCommandStatus, vxRemap, vxWeatherType, VX_TILESET_SHEETS } from './rgss-vx.mjs';

export const ACE_DATA_EXT = '.rvdata2';
export const ENGINE_ACE = 'rpg-maker-vxace';
export const ACE_TILE_SIZE = 32;
// Counts as frames per second for Ace waits (stock engine rate, like VX).
export const ACE_FPS = 60;
// Event commands: shared VX numbering (see header). Re-exported under Ace
// names so the converter and the smoke suite pin the contract per engine.
export const ACE_COMMAND_NAMES = VX_COMMAND_NAMES;
export const ACE_SUPPORTED = VX_SUPPORTED;
export const ACE_PARTIAL = VX_PARTIAL;
export const aceCommandStatus = vxCommandStatus;
export const aceRemap = vxRemap;
export const aceWeatherType = vxWeatherType;
// Ace maps reference one of several database tilesets (VX synthesizes a single
// global one); the sheet order is VX's when the database names are absent.
export const ACE_TILESET_SHEETS = VX_TILESET_SHEETS;

// Tilesets.rvdata2 records -> manifest tileset entries. Assumed RPG::Tileset
// shape (@id, @tileset_names[9], @flags Table); every miss degrades loudly.
export function aceTilesetEntry(record, index, tableData, warn) {
  const iv = record?.ivars || record || {};
  const id = Number(iv['@id'] ?? index);
  const names = iv['@tileset_names'];
  const flags = iv['@flags'];
  if (!Array.isArray(names) || names.length !== 9) {
    warn(`tileset ${id}: @tileset_names is not the assumed 9-sheet Ace list; sheet names fall back to the VX order`);
  }
  if (flags == null) warn(`tileset ${id}: no @flags table; every tile reads as passable`);
  return {
    id,
    tilesetNames: Array.isArray(names) && names.length ? names.map(name => name || null) : [...ACE_TILESET_SHEETS],
    autotileNames: [],
    flags: flags != null ? tableData(flags) : [],
    priorities: [],
    terrainTags: []
  };
}
