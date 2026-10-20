// Edited Ruby event scripts must regenerate the JavaScript the player runs
// (src/studio-code.js). Synthetic manifests only. Run: node tools/test-studio-code.mjs
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { recompileScripts } from '../src/studio-code.js';
import { requireConvertedGames } from './test-games.mjs';

if (!existsSync(new URL('../transpilers/ruby2js-master/demo/selfhost/ruby2js.js', import.meta.url))) {
  console.log('studio-code test SKIPPED: transpilers/ruby2js-master is not present (gitignored vendor copy)');
  process.exit(0);
}

const script = (ruby, js, extra = {}) => ({ script: ruby, js, ...extra });
const manifest = () => ({
  maps: [{ id: 1, mwgEvents: [{ id: 1, pages: [{ commands: [
    script('$game_switches[3] = true', 'old-js-1'),
    script('$game_switches[4] = true', 'old-js-2'),
    script('$game_switches[5] = true', 'hand-written-js'),
    { script: 'x = 1', mv: true },
    { if: { script: { source: '$game_switches[3]', js: 'old-cond' } }, then: [] },
  ] }] }] }],
  database: {},
  rubyLibrary: { methods: ['update', 'trigger'], interpreterMethods: [], units: {} },
});
const base = manifest();

// 1. an unchanged manifest is left alone and loads no transpiler work
{
  const { report } = await recompileScripts(manifest(), base);
  assert.deepEqual(report.recompiled, []);
}

// 2. an edited Ruby regenerates js; an untouched sibling keeps its js
{
  const edited = manifest();
  const commands = edited.maps[0].mwgEvents[0].pages[0].commands;
  commands[0].script = '$game_switches[3] = false';
  const { report } = await recompileScripts(edited, base);
  assert.deepEqual(report.recompiled, ['/maps/0/mwgEvents/0/pages/0/commands/0']);
  assert.notEqual(commands[0].js, 'old-js-1', 'js must be regenerated from the edited Ruby');
  assert.match(commands[0].js, /false/, commands[0].js);
  assert.equal(commands[1].js, 'old-js-2');
  assert.equal(commands[0].error, undefined);
}

// 3. a hand-edited js next to an edited Ruby is the editor's choice and is kept
{
  const edited = manifest();
  const commands = edited.maps[0].mwgEvents[0].pages[0].commands;
  commands[2].script = '$game_switches[5] = false';
  commands[2].js = 'hand-edited-js';
  const { report } = await recompileScripts(edited, base);
  assert.equal(commands[2].js, 'hand-edited-js');
  assert.deepEqual(report.keptHandEdit, ['/maps/0/mwgEvents/0/pages/0/commands/2']);
}

// 4. a blocking loop becomes async, like at conversion
{
  const edited = manifest();
  const commands = edited.maps[0].mwgEvents[0].pages[0].commands;
  commands[1].script = 'loop do\n  Graphics.update\n  break if Input.trigger?(Input::C)\nend';
  await recompileScripts(edited, base);
  assert.equal(commands[1].async, true, commands[1].js);
  assert.match(commands[1].js, /await/);
}

// 5. a condition keeps its shape (source + js, synchronous)
{
  const edited = manifest();
  const condition = edited.maps[0].mwgEvents[0].pages[0].commands[4].if.script;
  condition.source = '$game_switches[9]';
  await recompileScripts(edited, base);
  assert.notEqual(condition.js, 'old-cond');
  assert.match(condition.js, /return __result/);
  assert.equal(condition.async, undefined);
}

// 6. Ruby that does not parse is reported loudly: error kept, no stale js left to run
{
  const edited = manifest();
  const commands = edited.maps[0].mwgEvents[0].pages[0].commands;
  commands[0].script = 'def (';
  const { report } = await recompileScripts(edited, base);
  assert.equal(report.failed.length, 1, JSON.stringify(report));
  assert.ok(commands[0].error && commands[0].js === undefined);
  // fixing it clears the error again
  commands[0].script = '$game_switches[1] = true';
  await recompileScripts(edited, base);
  assert.equal(commands[0].error, undefined);
  assert.ok(commands[0].js);
}

// 7. MV scripts (no js) are never touched
{
  const edited = manifest();
  const mv = edited.maps[0].mwgEvents[0].pages[0].commands[3];
  mv.script = 'y = 2';
  await recompileScripts(edited, base);
  assert.deepEqual(mv, { script: 'y = 2', mv: true });
}

// 9. The Studio save path regenerates js: edit the Ruby, save through saveStudioManifest, read the published manifest.
{
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveStudioManifest } = await import('../src/studio-manifest.js');
  const folder = mkdtempSync(join(tmpdir(), 'studio-save-'));
  const project = () => ({ format: 'MWGP', version: 1, source: { engine: 'rpg-maker-mv' }, display: { title: 'T' }, initialMapId: 1,
    player: { mapId: 1, x: 1, y: 1 }, assets: { kind: 'source' }, rubyLibrary: { methods: ['update'], interpreterMethods: [], units: {} },
    maps: [{ id: 1, info: { name: 'M' }, data: { width: 3, height: 3, tilesetId: 1, data: new Array(54).fill(0) },
      mwgEvents: [{ id: 1, name: 'E', x: 1, y: 1, pages: [{ trigger: 'action', commands: [{ script: '$game_switches[3] = true', js: 'old-js' }] }] }] }],
    database: { actors: [null, { id: 1, name: 'A' }] } });
  writeFileSync(join(folder, 'mwgp.json'), JSON.stringify(project()));
  const edited = project();
  edited.maps[0].mwgEvents[0].pages[0].commands[0].script = '$game_switches[3] = false';
  await saveStudioManifest(folder, edited);
  const published = JSON.parse(readFileSync(join(folder, 'mwgp.json'), 'utf8')).maps[0].mwgEvents[0].pages[0].commands[0];
  assert.equal(published.script, '$game_switches[3] = false');
  assert.match(published.js, /false/, 'the saved manifest must carry the js regenerated from the edited Ruby');
}

// 8. Fidelity on the converted XP/VX/Ace games in RPGM_versions/: recompiling every script of each
// must give back exactly the js the converter stored. Fails when no such game is converted.
{
  const rubyGames = requireConvertedGames(undefined, { manifest: true })
    .filter(game => readFileSync(game.manifestPath, 'utf8').includes('"rubyLibrary"'));
  assert.ok(rubyGames.length > 0, 'no converted XP/VX/Ace game in RPGM_versions/ to check script fidelity on');
  for (const game of rubyGames) {
    const real = JSON.parse(readFileSync(game.manifestPath, 'utf8'));
    const stored = JSON.stringify(real.maps);
    const { report } = await recompileScripts(real, null);
    assert.equal(JSON.stringify(real.maps), stored, `recompiling unchanged scripts of ${game.name} changed their js (${report.failed.length} failed)`);
    console.log(`studio-code fidelity: ${report.recompiled.length} scripts of ${game.name} recompile to their stored js`);
  }
}

console.log('studio-code test ok: edited Ruby regenerates js, async lift, conditions, hand edits, errors, MV untouched');
