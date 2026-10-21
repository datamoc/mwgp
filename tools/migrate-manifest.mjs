// Brings an XP manifest converted before random encounters existed up to date, without reconverting it: each map that has
// no encounter list gets `encounterList` and `encounterStep` read from the game's own map file (or its encrypted archive).
// Nothing else changes: `source.convertedAt` and the converter version stay, so the audio caches and the staleness mark do
// not move. Refuses a Studio project (the Studio keeps its own copies of the maps: reconvert it, the merge keeps its edits)
// and a manifest that is not XP. Usage: node tools/migrate-manifest.mjs <mwgp.json> <game folder>
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractRgssArchive } from './rgss-archive.mjs';
import { decodeRgssValue, xpEncounterFields } from './rgss-encounters.mjs';

const ARCHIVES = ['Game.rgssad', 'Game.rgss2a', 'Game.rgss3a', 'Game.rgssa'];

// The game's Data folder: loose files when present, otherwise the encrypted archive extracted to a temporary folder.
function dataFolder(gameDir) {
  const data = join(gameDir, 'Data');
  if (existsSync(data) && readdirSync(data).some(name => /^Map\d+\.rxdata$/i.test(name))) return { dataDir: data, cleanup: () => {} };
  const archive = ARCHIVES.map(name => join(gameDir, name)).find(path => existsSync(path));
  if (!archive) throw new Error(`${gameDir} has no Data/Map*.rxdata files and no ${ARCHIVES.join(', ')} archive`);
  const extracted = mkdtempSync(join(tmpdir(), 'mwgp-migrate-'));
  return {
    dataDir: join(extracted, 'Data'),
    cleanup: () => rmSync(extracted, { recursive: true, force: true }),
    extract: () => extractRgssArchive(archive, extracted),
  };
}

// The map file of a map id: Map001.rxdata for id 1, found by its number rather than by its padding.
function mapFile(dataDir, id) {
  const name = readdirSync(dataDir).find(file => {
    const match = file.match(/^Map(\d+)\.rxdata$/i);
    return match && Number(match[1]) === id;
  });
  return name ? join(dataDir, name) : null;
}

export async function migrateManifest(manifestPath, gameDir) {
  const folder = dirname(resolve(manifestPath));
  if (existsSync(join(folder, '.mwgp-studio.json'))) throw new Error('this project has a Studio state; reconvert it instead (the merge keeps the Studio edits)');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.source?.engine !== 'rpg-maker-xp') throw new Error(`not an XP manifest (engine ${manifest.source?.engine ?? 'unknown'})`);
  const { dataDir, cleanup, extract } = dataFolder(gameDir);
  try {
    if (extract) await extract();
    const migrated = [], missing = [];
    for (const map of manifest.maps || []) {
      if (Array.isArray(map.data?.encounterList)) continue;
      const file = mapFile(dataDir, Number(map.id));
      if (!file) { missing.push(map.id); continue; }
      const fields = xpEncounterFields(decodeRgssValue(readFileSync(file)));
      // A step the manifest already has (the Studio may have set one) is kept.
      map.data = { ...map.data, encounterList: fields.encounterList, encounterStep: map.data?.encounterStep ?? fields.encounterStep };
      migrated.push(map.id);
    }
    if (migrated.length) writeFileSync(manifestPath, JSON.stringify(manifest));
    return { migrated, missing, total: (manifest.maps || []).length };
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, gameDir] = process.argv.slice(2);
  if (!manifestPath || !gameDir) {
    console.error('Usage: node tools/migrate-manifest.mjs <mwgp.json> <game folder>');
    process.exit(2);
  }
  try {
    const result = await migrateManifest(manifestPath, gameDir);
    console.log(`migrated ${result.migrated.length} of ${result.total} maps${result.missing.length ? `; no map file for ${result.missing.join(', ')}` : ''}`);
  } catch (error) {
    console.error(`migrate-manifest: ${error.message}`);
    process.exit(1);
  }
}
