// XP's random encounters of a map (Game_Map's encounter_list and encounter_step), in the MV map shape the player reads.
// The converter (convert-rgss.js) and the manifest migration (migrate-manifest.mjs) both read maps through here, so an
// old manifest gets exactly what a fresh conversion gives.
import { decodeMarshal as decodeMwgMarshal } from '@datamoc/mwg/rpg';
import { decodeRgssMarshal } from './rgss-marshal.mjs';

// A Marshal map file as the converter reads it.
export const decodeRgssValue = bytes => decodeRgssMarshal(bytes, decodeMwgMarshal);

// A Ruby object's instance variable, read as the converter reads them (an object's ivars, or the value itself).
export function rubyField(value, name, fallback = null) {
  const unwrap = item => (item?.class && item.ivars ? item.ivars : item);
  return unwrap(value)?.[`@${name}`] ?? fallback;
}

// XP draws a troop uniformly from encounter_list (an array of troop ids), so every entry gets the same weight.
export function xpEncounterFields(sourceMap) {
  const ids = rubyField(sourceMap, 'encounter_list', []);
  const encounterList = (Array.isArray(ids) ? ids : [])
    .map(troopId => ({ troopId: Number(troopId), weight: 10, regionSet: [] }))
    .filter(entry => entry.troopId > 0);
  return { encounterList, encounterStep: Number(rubyField(sourceMap, 'encounter_step', 30)) || 30 };
}
