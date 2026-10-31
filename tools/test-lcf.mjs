// RPG Maker 2000/2003 LCF reading (tools/lcf.mjs) against the real projects
// installed under RPGM_versions/ (skipped loudly when none is present):
// the map tree, the database sections and one map must come out with the
// counts and names the files actually contain. Run: node tools/test-lcf.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseMapTree, parseDatabase, parseMap, isLcfProject } from './lcf.mjs';
import { chipsetFrameFor, chipsetCellFor, isChipsetAutotile, chipsetTileQuads } from '../src/player/chipset.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync as readJsonSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const gamesRoot = join(root, 'RPGM_versions');
const projects = existsSync(gamesRoot)
  ? readdirSync(gamesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(gamesRoot, entry.name))
    .filter(dir => isLcfProject(readdirSync(dir)))
  : [];

if (!projects.length) {
  console.log('LCF: no RPG Maker 2000/2003 project under RPGM_versions/ — skipped');
  process.exit(0);
}

let checks = 0;
for (const dir of projects) {
  const tree = parseMapTree(readFileSync(join(dir, 'RPG_RT.lmt')));
  assert.ok(tree.maps.length > 10, `${dir}: map tree has entries`);
  assert.equal(tree.order.length, tree.maps.length, 'tree order covers every map');
  assert.ok(tree.maps[1]?.name.length > 0, 'second map is named');
  checks += 3;

  const database = parseDatabase(readFileSync(join(dir, 'RPG_RT.ldb')));
  for (const section of ['actors', 'skills', 'items', 'enemies', 'troops', 'states', 'tilesets', 'commonEvents']) {
    assert.ok(Array.isArray(database[section]) && database[section].length > 0, `database section ${section} parsed`);
    checks++;
  }
  const namedActors = database.actors.filter(actor => actor.name.trim().length >= 2);
  assert.ok(namedActors.length >= database.actors.length / 2, 'most actor names decode readably');
  assert.ok(database.system?.length > 0, 'system section kept');
  checks += 2;

  const map = parseMap(readFileSync(join(dir, 'Map0001.lmu')));
  assert.ok(map.width > 0 && map.height > 0, 'map dimensions');
  assert.equal(map.lower.length, map.width * map.height, 'lower layer covers the map');
  assert.equal(map.upper.length, map.width * map.height, 'upper layer covers the map');
  assert.equal(map.events.length, map.eventIds.length, 'events parsed for every event id');
  checks += 4;
  console.log(`LCF ok: ${dir.split(/[\\/]/).pop()} — ${tree.maps.length} maps, ${database.actors.length} actors, ${database.skills.length} skills, Map0001 ${map.width}x${map.height} with ${map.events.length} events`);

  // Full conversion to a validated MWGP manifest in a temp folder.
  const out = mkdtempSync(join(tmpdir(), 'mwgp-lcf-'));
  execFileSync(process.execPath, [join(root, 'tools', 'convert-lcf.mjs'), dir, out], { stdio: 'pipe' });
  execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), join(out, 'mwgp.json')], { stdio: 'pipe' });
  const manifest = JSON.parse(readJsonSync(join(out, 'mwgp.json'), 'utf8'));
  assert.equal(manifest.source.engine, 'rpg-maker-2003', 'manifest engine');
  assert.ok(manifest.maps.length > 10, 'converted maps present');
  const first = manifest.maps[0];
  assert.equal(first.data.data.length, first.data.width * first.data.height * 6, 'six layers per map');
  assert.ok(manifest.database.actors.length > 0 && manifest.database.enemies.length > 0, 'database converted');
  assert.ok(manifest.maps.some(entry => entry.mwgEvents.some(event => event.pages.some(page => page.commands.length))), 'events carry commands');
  checks += 5;
  console.log(`LCF convert ok: ${manifest.maps.length} maps validated`);
}

// Chipset atlas mapping (src/player/chipset.js, facts from the EasyRPG layout).
assert.deepEqual(chipsetCellFor(5000), { x: 12, y: 0 }, 'first simple lower tile');
assert.deepEqual(chipsetCellFor(10000), { x: 18, y: 8 }, 'first upper tile');
assert.deepEqual(chipsetCellFor(3000), { x: 3, y: 4 }, 'first animated tile');
assert.equal(chipsetCellFor(4100), null, 'autotile has no static cell');
assert.equal(isChipsetAutotile(4100), true, 'ground autotile');
assert.equal(isChipsetAutotile(5000), false, 'simple tile is not an autotile');
assert.ok(chipsetFrameFor(5000) > 1 && chipsetFrameFor(4100) > 480, 'frames are 1-based into the atlas');
checks += 7;

// Autotile quarter composition (EasyRPG GenerateAutotileAB/D, animation
// frame 0): each autotile id splices four 8x8 quarters from the chipset.
assert.deepEqual(chipsetTileQuads(4000), [{ x: 16, y: 160 }, { x: 24, y: 160 }, { x: 16, y: 168 }, { x: 24, y: 168 }], 'ground autotile 4000 quarters (block 0 interior)');
assert.deepEqual(chipsetTileQuads(4049), [{ x: 0, y: 128 }, { x: 8, y: 128 }, { x: 0, y: 136 }, { x: 8, y: 136 }], 'ground autotile variant 49 quarters');
assert.deepEqual(chipsetTileQuads(0), [{ x: 0, y: 64 }, { x: 8, y: 64 }, { x: 0, y: 72 }, { x: 8, y: 72 }], 'water autotile 0 quarters (all B)');
assert.deepEqual(chipsetTileQuads(1046), [{ x: 48, y: 0 }, { x: 56, y: 0 }, { x: 48, y: 8 }, { x: 56, y: 8 }], 'water autotile 1046 quarters (all A, block 1)');
assert.equal(chipsetTileQuads(2999), null, 'out-of-range water variant has no composition');
assert.equal(chipsetTileQuads(5000), null, 'simple tile has no quarter composition');
checks += 6;
console.log(`LCF checks passed (${checks})`);
