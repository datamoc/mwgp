// Smoke test: convert/validate/player contract over the real game folders.
//
// 1. Every mwgp.json under MWGP_versions/ must pass tools/validate-mwgp.js.
// 2. Every command key used by those manifests must be in the validator's
//    allowed set (the converter must never emit what the validator rejects).
// 3. Every allowed key must be executable by src/player/pixi-core.js: either
//    passed straight to mw_games' own EventRunner (NATIVE list below) or
//    rewritten in prepareEventCommands (referenced as `command.<key>`).
// 4. `node src/server.js --scan` must still print a JSON catalog over the
//    real RPGM_versions/ + MWGP_versions/ trees.
//
// Usage: npm test
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];
const fail = message => failures.push(message);

// Commands mw_games' Rpg.EventRunner already understands natively: they pass
// through prepareEventCommands untouched and need no `command.<key>` branch.
const NATIVE = new Set(['say', 'ask', 'setSwitch', 'setVariable', 'addVariable', 'wait', 'move', 'if']);

function allowedSet() {
  const source = readFileSync(join(root, 'tools', 'validate-mwgp.js'), 'utf8');
  const block = source.match(/const allowed = new Set\(\[([\s\S]*?)\]\);/);
  if (!block) throw new Error('could not parse allowed set from tools/validate-mwgp.js');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
}

// A command is identified by whichever of its keys is in the validator's
// vocabulary; the other keys are parameters (value, amount, portrait, ...).
function collectKeys(commands, used, unknown) {
  for (const command of commands || []) {
    const keys = Object.keys(command);
    const hit = keys.find(key => used.has(key) || allowed.has(key));
    if (hit) used.add(hit);
    else unknown.push(keys.join('+') || '(empty)');
    collectKeys(command.then, used, unknown);
    collectKeys(command.else, used, unknown);
    collectKeys(command.loop, used, unknown);
    collectKeys(command.cancelBranch, used, unknown);
    for (const branch of command.branches || []) collectKeys(branch, used, unknown);
  }
}

// 1+2: manifests in MWGP_versions/
const allowed = allowedSet();
const convertedDirs = readdirSync(join(root, 'MWGP_versions'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name);
if (!convertedDirs.length) fail('MWGP_versions/ has no converted projects to smoke-test');
for (const dir of convertedDirs) {
  const manifestPath = join(root, 'MWGP_versions', dir, 'mwgp.json');
  if (!existsSync(manifestPath)) { notes.push(`${dir}: no mwgp.json, skipped`); continue; }
  try {
    execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), manifestPath], { stdio: 'pipe' });
  } catch (error) {
    fail(`${dir}: validate-mwgp failed: ${String(error.stderr || error.message).slice(0, 300)}`);
    continue;
  }
  const project = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const used = new Set();
  const unknown = [];
  for (const map of project.maps || []) for (const event of map.mwgEvents || []) for (const page of event.pages || []) {
    collectKeys(page.commands, used, unknown);
    for (const passage of Object.values(page.story?.passages || {})) collectKeys(passage, used, unknown);
  }
  if (unknown.length) fail(`${dir}: manifest uses commands the validator rejects: ${[...new Set(unknown)].slice(0, 5).join(', ')}`);
  else notes.push(`${dir}: valid, ${used.size} command key(s) all accepted (${[...used].sort().join(', ')})`);
  if (project.source?.engine === 'rpg-maker-xp') {
    const format = project.tilesetFormat;
    const expectedBase = Number(format?.autotilePatternCount) * Number(format?.autotileImageCount);
    if (!format || !Number.isInteger(format.staticTileBase) || format.staticTileBase <= 0 || format.staticTileBase !== expectedBase) {
      fail(`${dir}: XP tileset format is missing or inconsistent`);
    } else if (!project.assets?.autotiles || !project.playerSprite?.name || !Number.isFinite(project.player?.x) || !Number.isFinite(project.player?.y)) {
      fail(`${dir}: XP manifest is missing decoded autotiles, player sprite, or start position`);
    } else {
      notes.push(`${dir}: XP format metadata, decoded autotiles, player sprite, and data-driven start position ok`);
    }
  }
}

// 2b: converter report sanity — every MV code the converter translates must be
// classified supported or partial, never unsupported (a code that converts but
// reports unsupported both lies in the banner and hides real gaps).
{
  const converter = readFileSync(join(root, 'tools', 'convert-mv.js'), 'utf8');
  const setOf = name => new Set([...converter.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`))[1].matchAll(/\d+/g)].map(m => m[0]));
  const supported = setOf('supported');
  const partial = setOf('partial');
  const classified = new Set([...supported, ...partial]);
  // Codes with a convertCommand/parseBlock translation (structural block codes
  // 102/111/112/117/355/204/402-404/411-413/505/655 included).
  const translated = ['0', '101', '102', '105', '108', '111', '112', '113', '115', '117', '118', '119', '121', '122', '123',
    '125', '126', '127', '128', '129', '135', '201', '203', '204', '205', '211', '212', '213', '214', '221', '222',
    '223', '224', '225', '230', '231', '232', '234', '235', '241', '242', '243', '244', '245', '246', '249', '250', '251',
    '301', '313', '314', '318', '319', '322', '351', '352', '355', '356', '401', '402', '403', '404', '405', '408', '411',
    '412', '413', '505', '601', '602', '603', '604', '655'];
  const lying = translated.filter(code => !classified.has(code));
  if (lying.length) fail(`convert-mv.js translates but misreports as unsupported: ${lying.join(', ')}`);
  else notes.push('converter report classification ok (all translated codes supported/partial)');
}

// 2c: same report sanity for the XP converter — every code convert-rgss.js
// translates (emits commands or is structurally consumed) must classify
// supported or partial, never unsupported.
{
  const converter = readFileSync(join(root, 'tools', 'convert-rgss.js'), 'utf8');
  const setOf = name => new Set([...converter.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`))[1].matchAll(/\d+/g)].map(m => m[0]));
  const classified = new Set([...setOf('supported'), ...setOf('partial')]);
  const translated = ['0', '101', '102', '103', '104', '105', '106', '108', '111', '112', '113', '115', '116', '117', '118', '119',
    '121', '122', '123', '125', '126', '127', '128', '129', '201', '202', '203', '208', '209', '210', '221', '222',
    '223', '224', '225', '231', '232', '234', '235', '241', '242', '247', '248', '249', '250', '251', '313', '314',
    '315', '316', '317', '318', '319', '355', '401', '402', '403', '404', '405', '408', '411', '412', '413', '509', '655'];
  const lying = translated.filter(code => !classified.has(code));
  if (lying.length) fail(`convert-rgss.js translates but misreports as unsupported: ${lying.join(', ')}`);
  else notes.push('xp converter report classification ok (all translated codes supported/partial)');
}

// 3: player coverage of the validator's vocabulary
const pixi = readFileSync(join(root, 'src', 'player', 'pixi-core.js'), 'utf8');
const uncovered = [...allowed].filter(key => !NATIVE.has(key) && !pixi.includes(`command.${key}`));
if (uncovered.length) fail(`pixi-core.js has no prepareEventCommands branch for: ${uncovered.join(', ')}`);

// 5: every non-native command actually routes to a scene method.
// prepareEventCommands is imported with a stub scene; each prepared `call`
// is invoked and the receiving method is recorded.
{
  const { prepareEventCommands } = await import(pathToFileURL(join(root, 'src', 'player', 'pixi-core.js')).href);
  const calls = [];
  const stub = new Proxy({}, { get: (_, method) => (...args) => { calls.push([method, args]); } });
  const state = { game: { variable: () => 3, setVariable: () => {} } };
  const routed = [
    [{ transfer: { mapId: 1, x: 1, y: 1 } }, 'transfer'],
    [{ picture: { id: 1, name: 'A' } }, 'showPicture'],
    [{ erasePicture: 1 }, 'erasePicture'],
    [{ movePicture: { id: 1, x: 10, y: 20, scaleX: 100, scaleY: 100, opacity: 255, duration: 0, wait: false } }, 'movePicture'],
    [{ tintPicture: { id: 1, tone: [0, 0, 0, 0], duration: 0, wait: false } }, 'tintPicture'],
    [{ balloon: { target: -1, balloon: 1, wait: false } }, 'showBalloon'],
    [{ animation: { target: -1, animation: 1, wait: false } }, 'playAnimation'],
    [{ scroll: { text: 'Far away…', speed: 2, noFast: false } }, 'presentScroll'],
    [{ scrollMap: { direction: 2, distance: 5, speed: 4 } }, 'scrollMap'],
    [{ mapSettings: { kind: 'fog', name: 'Fog', opacity: 128, zoom: 100, sx: 0, sy: 0 } }, 'setMapSettings'],
    [{ relocate: { target: 'player', x: 3, y: 4, facing: 'down' } }, 'relocate'],
    [{ saveBgm: true }, 'saveBgm'],
    [{ resumeBgm: true }, 'resumeBgm'],
    [{ me: { name: 'Fanfare1', volume: 90, pitch: 100, pan: 0 } }, 'playMe'],
    [{ menu: 'menu' }, 'unimplementedScene'],
    [{ changeState: { scope: 1, actor: 2, add: true, state: 4 } }, 'applyActor'],
    [{ recoverAll: { scope: 1, actor: 2 } }, 'applyActor'],
    [{ changeSkill: { scope: 1, actor: 2, learn: true, skill: 7 } }, 'applyActor'],
    [{ changeEquipment: { actor: 2, slot: 1, item: 5 } }, 'applyActor'],
    [{ changeProfile: { actor: 2, profile: 'A hero' } }, 'applyActor'],
    [{ sound: { name: 'S', volume: 90, pitch: 100, pan: 0 } }, 'playSound'],
    [{ stopSound: true }, 'stopSound'],
    [{ playBgm: { name: 'B', volume: 90, pitch: 100, pan: 0 } }, 'playBgm'],
    [{ fadeoutBgm: { duration: 1 } }, 'fadeoutBgm'],
    [{ playBgs: { name: 'C', volume: 90, pitch: 100, pan: 0 } }, 'playBgs'],
    [{ fadeoutBgs: { duration: 1 } }, 'fadeoutBgs'],
    [{ screenFade: { direction: 'out', duration: 0.4 } }, 'screenFade'],
    [{ screenFlash: { color: 0xffffff, peak: 1, duration: 0.2, wait: false } }, 'screenFlash'],
    [{ screenTint: { tone: [0, 0, 0, 0], duration: 0, wait: false } }, 'screenTint'],
    [{ screenShake: { power: 3, speed: 5, duration: 0.2, wait: false } }, 'screenShake'],
    [{ changeGold: 10 }, 'applyInventory'],
    [{ changeItem: { id: 1, amount: 1 } }, 'applyInventory'],
    [{ changeWeapon: { id: 1, amount: 1 } }, 'applyInventory'],
    [{ changeArmor: { id: 1, amount: 1 } }, 'applyInventory'],
    [{ changeParty: { actorId: 1, add: true } }, 'applyInventory'],
    [{ setTransparent: true }, 'setTransparent'],
    [{ eraseEvent: true }, 'eraseEvent'],
    [{ script: 'x' }, 'unsupportedCommand'],
    [{ pluginCommand: { raw: 'A b', name: 'A', args: ['b'] } }, 'unsupportedCommand'],
    [{ turn: 'up' }, 'turnPlayer'],
    [{ copyVariable: '1', variable: '2' }, 'copyVariable'],
    [{ inputNumber: { variable: '1', digits: 3 } }, 'inputNumber'],
    [{ messageOptions: { position: 0, frame: 0 } }, 'setMessageOptions'],
    [{ loop: [{ wait: 1 }] }, 'runLoop'],
    [{ ask: '', choices: [{ text: 'A', value: 0 }], branches: [[{ wait: 1 }]] }, 'presentChoice'],
    [{ say: 'hi', portrait: { name: 'P', index: 0 } }, 'presentPortrait'],
    [{ battle: { troopId: 1, canEscape: true, canLose: false, branches: { win: [{ wait: 1 }] } } }, 'startBattle'],
  ];
  for (const [command, expected] of routed) {
    calls.length = 0;
    const prepared = prepareEventCommands([command], stub);
    if (typeof prepared[0]?.call !== 'function') { fail(`${Object.keys(command)[0]} did not prepare to a call`); continue; }
    await prepared[0].call(state);
    if (calls[0]?.[0] !== expected) fail(`${Object.keys(command)[0]} routed to ${calls[0]?.[0] || 'nothing'}, expected ${expected}`);
  }
  // Control-flow sentinels and native passthrough.
  for (const command of [[{ breakLoop: true }], [{ exitEvent: true }]]) {
    const prepared = prepareEventCommands(command, stub);
    try { await prepared[0].call(state); fail(`${Object.keys(command[0])[0]} did not throw its sentinel`); }
    catch { /* expected: BreakLoopSignal/ExitEventSignal */ }
  }
  // { goto } throws a JumpSignal carrying the passage for the story driver.
  {
    const { JumpSignal } = await import(pathToFileURL(join(root, 'src', 'player', 'pixi-core.js')).href);
    const prepared = prepareEventCommands([{ goto: 'Loop' }], stub);
    try { await prepared[0].call(state); fail('goto did not throw its JumpSignal'); }
    catch (error) {
      if (!(error instanceof JumpSignal) || error.passage !== 'Loop') fail(`goto threw the wrong signal: ${error}`);
      else notes.push('goto JumpSignal ok (passage "Loop" carried to the story driver)');
    }
  }
  const native = prepareEventCommands([{ say: 'hi' }, { setSwitch: '1', value: true }, { if: { switch: '1', equals: true }, then: [{ wait: 1 }] }], stub);
  if (native[0].say !== 'hi' || native[1].setSwitch !== '1' || native[2].then[0].wait !== 1) fail('native commands were not passed through untouched');
  else notes.push(`prepareEventCommands routing ok (${routed.length} scene routes + sentinels + passthrough)`);

  // 5b: move-step descriptor table (converter emits, runMoveRoute resolves).
  const { resolveRouteStep } = await import(pathToFileURL(join(root, 'src', 'player', 'pixi-core.js')).href);
  const stepCases = [
    [{ dx: 1, dy: -1 }, 'down', { dx: 1, dy: -1 }],
    [{ jump: { dx: 0, dy: 2 } }, 'up', { jump: { dx: 0, dy: 2 } }],
    [{ forward: true }, 'left', { dx: -1, dy: 0 }],
    [{ backward: true }, 'left', { dx: 1, dy: 0 }],
    [{ forward: true }, 'up', { dx: 0, dy: -1 }],
    [{ toward: true }, 'down', null],
    [{ away: true }, 'down', null],
    [{}, 'down', null],
    [null, 'down', null],
  ];
  let stepFailures = 0;
  for (const [step, facing, expected] of stepCases) {
    if (JSON.stringify(resolveRouteStep(step, facing)) !== JSON.stringify(expected)) {
      fail(`resolveRouteStep(${JSON.stringify(step)}, ${facing}) mismatch`);
      stepFailures++;
    }
  }
  for (let i = 0; i < 20; i++) {
    const resolved = resolveRouteStep({ random: true }, 'down');
    if (![[0, 1], [0, -1], [-1, 0], [1, 0]].some(([dx, dy]) => resolved?.dx === dx && resolved?.dy === dy)) {
      fail('resolveRouteStep random left the cardinal set');
      stepFailures++;
      break;
    }
  }
  if (!stepFailures) notes.push('resolveRouteStep descriptor table ok');

  // 5c: autotile source math and character frame geometry (engine rules the
  // converter measures and the player renders by; see rpg_core.js Tilemap
  // and rpg_sprites.js Sprite_Character).
  const { autotileSource, autotileDrawOps, characterGeometry, characterCellIndex, characterPixelSize } =
    await import(pathToFileURL(join(root, 'src', 'player', 'pixi-core.js')).href);
  const expect = (actual, wanted, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(wanted)}`);
  };
  // Map-48 wall tile 6992: A4 kind 103, even kind row -> floor table (the old
  // code always sampled wall, striping every even-row wall).
  expect(autotileSource(6992, 3), { kind: 103, shape: 0, bx: 14, by: 5, table: 'floor' }, 'autotileSource A4 even row');
  // A4 kind 89 (tile 6320): odd kind row -> wall table.
  expect(autotileSource(6320, 3), { kind: 89, shape: 0, bx: 2, by: 3, table: 'wall' }, 'autotileSource A4 odd row');
  // A1 animated kinds at frame 0, plus waterfall kinds and their empty shapes.
  expect(autotileSource(2048, 0), { kind: 0, shape: 0, bx: 0, by: 0, table: 'floor' }, 'autotileSource A1 kind 0');
  expect(autotileSource(2096, 0), { kind: 1, shape: 0, bx: 0, by: 3, table: 'floor' }, 'autotileSource A1 kind 1');
  expect(autotileSource(2288, 0), { kind: 5, shape: 0, bx: 14, by: 0, table: 'waterfall' }, 'autotileSource A1 waterfall kind');
  if (autotileSource(2298, 0) !== null) fail('autotileSource A1 waterfall shape >= 4 should draw nothing');
  if (autotileDrawOps(2298, 0).length !== 0) fail('autotileDrawOps A1 waterfall shape >= 4 should emit no ops');
  // A2 table-tile self composite: FLOOR shape 8 holds a qy=1 quad, so a flagged
  // table tile (4072, kind 42) emits the extra front-face op; unflagged stays 4.
  const tableFlags = [];
  tableFlags[4072] = 0x80;
  expect(autotileDrawOps(4072, 1, []).length, 4, 'autotileDrawOps plain A2 op count');
  expect(autotileDrawOps(4072, 1, tableFlags).length, 5, 'autotileDrawOps table A2 op count');
  // Character geometry: manifest entries win; otherwise the filename rule.
  expect(characterGeometry('C_Karryn01', { big: false, object: false, fw: 60, fh: 60 }),
    { big: false, object: false, fw: 60, fh: 60 }, 'characterGeometry manifest entry');
  expect(characterGeometry('$Gate', undefined), { big: true, object: false, fw: 48, fh: 48 }, 'characterGeometry $ fallback');
  expect(characterGeometry('!$Door', undefined), { big: true, object: true, fw: 48, fh: 48 }, 'characterGeometry !$ fallback');
  expect(characterCellIndex({ big: false }, 1, 4, 1), 16, 'characterCellIndex standard block');
  expect(characterCellIndex({ big: false }, 5, 8, 1), 88, 'characterCellIndex second MV block row');
  expect(characterCellIndex({ big: true }, 5, 8, 2), 11, 'characterCellIndex big sheet ignores index');
  expect(characterPixelSize({ fw: 60, fh: 60, object: false }, 48), { w: 60, h: 60, shift: 6 }, 'characterPixelSize shift');
  expect(characterPixelSize({ fw: 60, fh: 80, object: true }, 48), { w: 60, h: 80, shift: 0 }, 'characterPixelSize object');
  notes.push('autotile + character geometry helpers ok');
}

// 4: server catalog scan over the real trees
try {
  const out = execFileSync(process.execPath, [join(root, 'src', 'server.js'), '--scan'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const catalog = JSON.parse(out);
  if (!Array.isArray(catalog.rpgm) || !Array.isArray(catalog.mwgp)) fail('--scan did not print a { rpgm, mwgp } catalog');
  else notes.push(`--scan catalog ok (${catalog.rpgm.length} rpgm + ${catalog.mwgp.length} mwgp)`);
} catch (error) {
  fail(`--scan failed: ${String(error.message).slice(0, 300)}`);
}

if (failures.length) {
  console.error(`smoke test FAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, notes }, null, 2));
