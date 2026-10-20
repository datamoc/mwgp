// The games the local checks run on: the RPG Maker games the developer keeps in RPGM_versions/.
// The repository ships no game and no check names one. A check discovers the games here, and
// fails (never skips) when fewer than MIN_GAMES have been converted.
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_GAMES = 2;

const SETUP = `Put at least ${MIN_GAMES} RPG Maker games (one folder each, with Game.exe) in RPGM_versions/, `
  + 'then run: npm run convert:auto -- RPGM_versions MWGP_versions';

function folderNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

// MV/MZ games have www/index.html, XP/VX/Ace games have Game.ini; both have Game.exe.
function isRpgmGame(dir) {
  return existsSync(join(dir, 'Game.exe')) && (existsSync(join(dir, 'www', 'index.html')) || existsSync(join(dir, 'Game.ini')));
}

export function rpgmGameNames(rpgmRoot = join(root, 'RPGM_versions')) {
  return folderNames(rpgmRoot).filter(name => isRpgmGame(join(rpgmRoot, name)));
}

// A game's converted output is MWGP_versions/<name>/: mwgp.json, or mwgp-web.json for a web build.
export function convertedGames(mwgpRoot = join(root, 'MWGP_versions')) {
  return rpgmGameNames().flatMap(name => {
    const dir = join(mwgpRoot, name);
    const manifestPath = join(dir, 'mwgp.json');
    const hasManifest = existsSync(manifestPath);
    if (!hasManifest && !existsSync(join(dir, 'mwgp-web.json'))) return [];
    return [{ name, dir, manifestPath, hasManifest }];
  });
}

// Throws unless at least MIN_GAMES converted games are present. With { manifest: true } only the
// games that have an mwgp.json count (web builds have none).
export function requireConvertedGames(mwgpRoot, { manifest = false } = {}) {
  const games = convertedGames(mwgpRoot).filter(game => !manifest || game.hasManifest);
  if (games.length < MIN_GAMES) {
    throw new Error(`${games.length} converted game(s) found, at least ${MIN_GAMES} needed. ${SETUP}`);
  }
  return games;
}
