// Checks for the XP manifest migration (tools/migrate-manifest.mjs): the encounter fields come from the game's own map
// files, only maps without a list change, an existing step survives, nothing else is touched, and Studio or non-XP
// manifests are refused. The map files are real Marshal files (encodeMarshal from mwg), read by the same decoder as the
// converter.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeMarshal } from '@datamoc/mwg/rpg';
import { migrateManifest } from './migrate-manifest.mjs';

const temp = mkdtempSync(join(tmpdir(), 'mwgp-migrate-test-'));
try {
  const game = join(temp, 'game');
  mkdirSync(join(game, 'Data'), { recursive: true });
  const mapFile = (ivars) => Buffer.from(encodeMarshal({ class: 'RPG::Map', ivars }));
  // Map 1 has an encounter list in the game; map 2 is already migrated; map 3 has no file.
  writeFileSync(join(game, 'Data', 'Map001.rxdata'), mapFile({ '@encounter_list': [3, 5], '@encounter_step': 20 }));
  writeFileSync(join(game, 'Data', 'Map002.rxdata'), mapFile({ '@encounter_list': [7] }));

  const folder = join(temp, 'MWGP_versions', 'Synthetic XP');
  mkdirSync(folder, { recursive: true });
  const manifestPath = join(folder, 'mwgp.json');
  const manifest = () => ({
    format: 'MWGP', version: 1, converter: { version: '0.2.2' },
    source: { engine: 'rpg-maker-xp', convertedAt: '2026-01-01T00:00:00.000Z' },
    maps: [
      { id: 1, info: { name: 'Room' }, data: { width: 1, height: 1, data: [0], encounterStep: 42 }, mwgEvents: [] },
      { id: 2, info: null, data: { width: 1, height: 1, data: [0], encounterList: [{ troopId: 9, weight: 10, regionSet: [] }], encounterStep: 30 }, mwgEvents: [] },
      { id: 3, info: null, data: { width: 1, height: 1, data: [0] }, mwgEvents: [] },
    ],
  });
  writeFileSync(manifestPath, JSON.stringify(manifest()));

  const result = await migrateManifest(manifestPath, game);
  assert.deepEqual(result.migrated, [1]);
  assert.deepEqual(result.missing, [3]);
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(after.maps[0].data.encounterList, [{ troopId: 3, weight: 10, regionSet: [] }, { troopId: 5, weight: 10, regionSet: [] }]);
  assert.equal(after.maps[0].data.encounterStep, 42, 'a step the manifest already has is kept');
  assert.deepEqual(after.maps[1].data.encounterList, [{ troopId: 9, weight: 10, regionSet: [] }], 'a migrated map is not changed');
  assert.equal(after.maps[2].data.encounterList, undefined, 'a map without a file gets nothing');
  assert.equal(after.source.convertedAt, '2026-01-01T00:00:00.000Z', 'the conversion stamp stays');
  assert.equal(after.converter.version, '0.2.2', 'the converter version stays');

  // A project with a Studio state, and a manifest that is not XP, are refused and left alone.
  writeFileSync(join(folder, '.mwgp-studio.json'), '{}');
  const before = readFileSync(manifestPath, 'utf8');
  await assert.rejects(migrateManifest(manifestPath, game), /Studio state/);
  assert.equal(readFileSync(manifestPath, 'utf8'), before, 'a refused project is not written');
  rmSync(join(folder, '.mwgp-studio.json'));
  const mv = { ...manifest(), source: { engine: 'rpg-maker-mv' } };
  writeFileSync(manifestPath, JSON.stringify(mv));
  await assert.rejects(migrateManifest(manifestPath, game), /not an XP manifest/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('migrate manifest ok (XP encounter fields from the map files, stamps kept, Studio and non-XP refused)');
