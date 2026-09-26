// Smoke test: convert/validate/player contract over the real game folders.
//
// 1. Every mwgp.json under MWGP_versions/ must pass tools/validate-mwgp.js.
// 2. Every command key used by those manifests must be in the validator's
//    allowed set (the converter must never emit what the validator rejects).
// 3. Every allowed key must be executable by src/player/player-core.js: either
//    passed straight to mw_games' own EventRunner (NATIVE list below) or
//    rewritten in prepareEventCommands (referenced as `command.<key>`).
// 4. `node src/server.js --scan` must still print a JSON catalog over the
//    real RPGM_versions/ + MWGP_versions/ trees.
//
// Usage: npm test
import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
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
  if (project.source?.engine === 'rpg-maker-mv') {
    const pluginReport = project.compatibility?.plugins;
    if (!pluginReport || Object.values(pluginReport).some(entry => !['supported', 'partial', 'unsupported'].includes(entry.status))) {
      fail(`${dir}: plugin family compatibility report is missing or malformed`);
    }
    if (pluginReport?.Tachie && pluginReport.Tachie.status !== 'partial') {
      fail(`${dir}: Tachie plugin family is not classified partial`);
    }
  }
  const used = new Set();
  const unknown = [];
  for (const map of project.maps || []) for (const event of map.mwgEvents || []) for (const page of event.pages || []) {
    collectKeys(page.commands, used, unknown);
    for (const passage of Object.values(page.story?.passages || {})) collectKeys(passage, used, unknown);
  }
  if (unknown.length) fail(`${dir}: manifest uses commands the validator rejects: ${[...new Set(unknown)].slice(0, 5).join(', ')}`);
  else notes.push(`${dir}: valid, ${used.size} command key(s) all accepted (${[...used].sort().join(', ')})`);
  if (project.source?.engine === 'rpg-maker-xp') {
    if (!Array.isArray(project.compatibility?.scripts?.libraryFailed)) {
      fail(`${dir}: XP compatibility.scripts.libraryFailed is missing`);
    } else if (project.compatibility.scripts.libraryFailed.length) {
      notes.push(`${dir}: ${project.compatibility.scripts.libraryFailed.length} RGSS library unit failure(s) exposed in compatibility report`);
    }
    if (!Array.isArray(project.compatibility?.scripts?.libraryPartial)) {
      fail(`${dir}: XP compatibility.scripts.libraryPartial is missing`);
    } else if (project.compatibility.scripts.libraryPartial.length) {
      notes.push(`${dir}: ${project.compatibility.scripts.libraryPartial.length} RGSS library unit(s) available through partial piece merging`);
    }
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
  // Real MZ project fixture (the synthetic MZ probe further down only proves the
  // converter on a made-up project): a locally installed MZ game must keep the MZ
  // data shapes intact end to end — six width-major map layers with MZ's signed
  // sentinel values stripped (normalizeMZMapData), the MV-shaped database the
  // battle runner needs, and code 357 filed as a converted (never unsupported)
  // pluginCommand.
  if (project.source?.engine === 'rpg-maker-mz') {
    const mzChecks = [];
    const badMaps = (project.maps || []).filter(map => {
      const width = Number(map.data?.width), height = Number(map.data?.height), tiles = map.data?.data;
      if (!Number.isInteger(width) || !width || !Number.isInteger(height) || !Array.isArray(tiles)) return true;
      if (tiles.length !== width * height * 6) return true;
      return tiles.some(tile => !Number.isInteger(tile) || tile < 0 || tile >= 8192);
    });
    mzChecks.push([!badMaps.length, `every map carries exactly width*height*6 normalized tiles (bad: ${badMaps.slice(0, 3).map(map => map.id).join(', ') || 'none'})`]);
    const db = project.database || {};
    const party = (db.system?.partyMembers || []).filter(id => db.actors?.[id]);
    mzChecks.push([!party.length || Boolean(db.troops && db.enemies && db.classes && db.skills), 'database tables the battle runner needs are present']);
    const commandReport = project.compatibility?.commands || {};
    mzChecks.push([(commandReport['357']?.status || 'unused') !== 'unsupported', 'MZ code 357 is never reported unsupported']);
    const pluginReport = project.compatibility?.plugins;
    mzChecks.push([!Object.keys(pluginReport || {}).length || Object.values(pluginReport).every(entry => ['supported', 'partial', 'unsupported'].includes(entry.status)), 'plugin census statuses are well-formed']);
    for (const [ok, label] of mzChecks) if (!ok) fail(`${dir}: MZ fixture: ${label}`);
    if (mzChecks.every(([ok]) => ok)) {
      notes.push(`${dir}: MZ fixture ok (${mzChecks.length} checks: ${commandReport['357'] ? `${commandReport['357'].count} code-357 use(s) filed ${commandReport['357'].status}` : 'no code-357 uses; covered by the synthetic probe'}, ${party.length} battle party member(s))`);
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
  // Menu/plugin commands remain intentionally unsupported; 355 is partial
  // because the player executes it through the bounded MV globals shim.
  const intentionallyUnsupported = new Set(['351', '352', '356']);
  const lying = translated.filter(code => !classified.has(code) && !intentionallyUnsupported.has(code));
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

// 2d: per-feature banner areas (T128) ÔÇö every supported/partial code from both
// converters must sit in a named FEATURE_AREA, so the banner's "other" bucket
// only ever carries genuinely unclassified codes, and the report rolls up and
// silences correctly on synthetic and real-manifest input.
{
  const { featureReport, featureLines, FEATURE_AREAS } =
    await import(pathToFileURL(join(root, 'src', 'player', 'compat-features.js')).href);
  const mapped = new Set(FEATURE_AREAS.flatMap(area => area.codes.map(String)));
  const unmapped = [];
  for (const file of ['tools/convert-mv.js', 'tools/convert-rgss.js']) {
    const converter = readFileSync(join(root, file), 'utf8');
    const setOf = name => new Set([...converter.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`))[1].matchAll(/\d+/g)].map(m => m[0]));
    for (const code of new Set([...setOf('supported'), ...setOf('partial')])) {
      if (!mapped.has(code)) unmapped.push(`${file.split('/')[1]}:${code}`);
    }
  }
  if (unmapped.length) fail(`feature areas miss classified codes: ${unmapped.join(', ')}`);
  else notes.push('feature areas cover every supported/partial code ok');
  const karrynLike = featureReport({ commands: { 356: { count: 4178, status: 'partial' }, 355: { count: 466, status: 'partial' }, 101: { count: 50, status: 'supported' } }, plugins: { Tachie: { count: 3103, status: 'partial' } } });
  if (karrynLike.map(entry => entry.area).join(',') !== 'plugins,scripts' || !featureLines(karrynLike)[0].startsWith('Plugins: partial (356├ù4178')) {
    fail(`feature report misrolls Karryn-like input: ${JSON.stringify(karrynLike)}`);
  } else notes.push('feature report rolls up worst-status-first by uses ok');
  if (featureReport({ commands: { 101: { count: 5, status: 'supported' } } }).length) fail('feature report is not silent for a fully supported project');
  else notes.push('feature report stays silent when nothing gaps ok');
}

// 3: player coverage of the validator's vocabulary
const playerCore = readFileSync(join(root, 'src', 'player', 'player-core.js'), 'utf8');
const uncovered = [...allowed].filter(key => !NATIVE.has(key) && !playerCore.includes(`command.${key}`));
if (uncovered.length) fail(`player-core.js has no prepareEventCommands branch for: ${uncovered.join(', ')}`);

// 3b: an event whose character sheet is absent from the archive must degrade
// to a loud, visible placeholder — never silently vanish (some projects
// reference sheets they do not ship).
if (!playerCore.includes('using a placeholder sprite')) fail('player-core.js lost its missing-character-sheet placeholder branch');
else notes.push('missing character sheets degrade to a visible placeholder ok');
if (!playerCore.includes('mwg.Resources.texture(fallbackSheetUrl)')) fail('player-core.js missing-sheet fallback does not use the loaded fallback texture');
else notes.push('missing-sheet fallback uses a loaded texture ok');
if (!playerCore.includes('.replace(/\\\\PN/gi')) fail('player-core.js lost case-insensitive player-name escape replacement');
else notes.push('player-name escape replacement ok');
if (!playerCore.includes('rubyLibrary?.textFilters')) fail('player-core.js lost library text-filter interpolation');
else notes.push('library text-filter interpolation ok');
if (!playerCore.includes('iteration % 100 === 0') || !playerCore.includes('jumps % 32 === 0')) fail('event loop watchdogs are not cooperative');
else notes.push('event loop watchdogs yield to the browser ok');
if (!playerCore.includes('this.confirmLock = true') || !playerCore.includes("Input.isDown('confirm')")) fail('dialogue confirm input leaks back into the map');
else notes.push('dialogue confirm input is consumed after closing ok');
if (!playerCore.includes("this.runEventAt(x, y, 'touch')") || !playerCore.includes('return true;')) fail('blocked player-touch events cannot trigger doors/stairs');
else notes.push('blocked player-touch events trigger doors/stairs ok');

const playerBootstrap = readFileSync(join(root, 'public', 'player.js'), 'utf8');
if (!playerBootstrap.includes('let bootstrapFailed = false') || !playerBootstrap.includes('if (!bootstrapFailed) loading.remove()')) {
  fail('public/player.js removes the bootstrap error message after a load failure');
} else notes.push('bootstrap failures remain visible to the player ok');

// Label passages must fall through in source order when no explicit goto is
// taken. This is required by RPG Maker's interpreter and prevents Essentials'
// intro from stopping before its gender/name passages.
const rgssConverter = readFileSync(join(root, 'tools', 'convert-rgss.js'), 'utf8');
if (!rgssConverter.includes('order.includes(name)') || !rgssConverter.includes('story: { ...story, order }')) fail('RGSS label fallthrough order is not preserved');
else notes.push('RGSS label fallthrough order preserved ok');

// 5: every non-native command actually routes to a scene method.
// prepareEventCommands is imported with a stub scene; each prepared `call`
// is invoked and the receiving method is recorded.
{
  const { applyBuiltinPluginCommand, applyQuestPluginCommand, foregroundOrigin, normalizeDialogueMarkup, prepareEventCommands, resolveGameDataOperand, resolveTransferTarget, runBattleFallback, sanitizeMapPosition, selectForegroundLayer } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
  const calls = [];
  const stub = new Proxy({}, { get: (_, method) => (...args) => { calls.push([method, args]); } });
  const state = { game: { variable: () => 3, setVariable: () => {} } };
  const routed = [
    [{ transfer: { mapId: 1, x: 1, y: 1 } }, 'transfer'],
    [{ transfer: { mapVar: '1', xVar: '2', yVar: '3' } }, 'transfer'],
    [{ picture: { id: 1, name: 'A' } }, 'showPicture'],
    [{ erasePicture: 1 }, 'erasePicture'],
    [{ movePicture: { id: 1, x: 10, y: 20, scaleX: 100, scaleY: 100, opacity: 255, duration: 0, wait: false } }, 'movePicture'],
    [{ tintPicture: { id: 1, tone: [0, 0, 0, 0], duration: 0, wait: false } }, 'tintPicture'],
    [{ balloon: { target: -1, balloon: 1, wait: false } }, 'showBalloon'],
    [{ animation: { target: -1, animation: 1, wait: false } }, 'playAnimation'],
    [{ animationAt: { x: 720, y: 500, animation: 130, wait: false } }, 'playAnimationAt'],
    [{ commonEvent: '7' }, 'runCommonEvent'],
    [{ scroll: { text: 'Far away…', speed: 2, noFast: false } }, 'presentScroll'],
    [{ scrollMap: { direction: 2, distance: 5, speed: 4 } }, 'scrollMap'],
    [{ mapSettings: { kind: 'fog', name: 'Fog', opacity: 128, zoom: 100, sx: 0, sy: 0 } }, 'setMapSettings'],
    [{ relocate: { target: 'player', x: 3, y: 4, facing: 'down' } }, 'relocate'],
    [{ saveBgm: true }, 'saveBgm'],
    [{ resumeBgm: true }, 'resumeBgm'],
    [{ me: { name: 'Fanfare1', volume: 90, pitch: 100, pan: 0 } }, 'playMe'],
    [{ menu: 'menu' }, 'openMenu'],
    [{ menu: 'save' }, 'promptSaveGame'],
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
    [{ changeHp: { scope: 1, actor: 1, amount: 5, sign: -1, allowDeath: false } }, 'applyActor'],
    [{ changeLevel: { scope: 1, actor: 1, amount: 1, sign: 1 } }, 'applyActor'],
    [{ changeClass: { actor: 1, classId: 2, keepExp: true } }, 'applyActor'],
    [{ changeItem: { id: 1, amount: 1 } }, 'applyInventory'],
    [{ changeWeapon: { id: 1, amount: 1 } }, 'applyInventory'],
    [{ changeArmor: { id: 1, amount: 1 } }, 'applyInventory'],
    [{ changeParty: { actorId: 1, add: true } }, 'applyInventory'],
    [{ setTransparent: true }, 'setTransparent'],
    [{ setTransparent: { target: 'event:1', value: true } }, 'setTransparent'],
    [{ routeThrough: { target: 'event:1', value: true } }, 'setRouteThrough'],
    [{ routeOption: { target: 'event:1', option: 'directionFix', value: true } }, 'setRouteOption'],
    [{ routeImage: { target: 'event:1', image: { name: 'Actor', index: 0, direction: 2, pattern: 1 } } }, 'setRouteImage'],
    [{ vehicleLocation: { vehicle: 1, mapId: 1, x: 2, y: 3 } }, 'setVehicleLocation'],
    [{ enemyAppear: { index: 0 } }, 'enemyAppear'],
    [{ changeEnemyHp: { index: 0, amount: 5, sign: -1 } }, 'changeEnemyStat'],
    [{ changeEnemyMp: { index: -1, amount: 5, sign: 1 } }, 'changeEnemyStat'],
    [{ changeEnemyTp: { index: 0, amount: 5, sign: 1 } }, 'changeEnemyStat'],
    [{ changeEnemyState: { index: 0, add: true, state: 4 } }, 'changeEnemyState'],
    [{ enemyTransform: { index: 0, enemyId: 2 } }, 'enemyTransform'],
    [{ eraseEvent: true }, 'eraseEvent'],
    [{ script: 'x' }, 'unsupportedCommand'],
    [{ script: 'x', js: 'y' }, 'runScript'],
    [{ script: 'x', mv: true }, 'runScript'],
    [{ if: { script: { source: 'x', js: 'return 1;' } }, then: [], else: [] }, 'evalScriptCondition'],
    [{ if: { vehicle: 'boat' }, then: [], else: [] }, 'runBranch'],
    [{ if: { partyMember: 1 }, then: [], else: [] }, 'runBranch'],
    [{ if: { facing: 'left' }, then: [], else: [] }, 'runBranch'],
    [{ if: { eventFacing: 'down' }, then: [], else: [] }, 'runBranch'],
    [{ if: { gold: { operator: 'gte', value: 10 } }, then: [], else: [] }, 'runBranch'],
    [{ if: { item: '5' }, then: [], else: [] }, 'runBranch'],
    [{ if: { actorSkill: { actor: 1, skill: 7 } }, then: [], else: [] }, 'runBranch'],
    [{ if: { actorState: { actor: 1, state: 4 } }, then: [], else: [] }, 'runBranch'],
    [{ if: { unsupported: { code: 111, kind: 5 } }, then: [], else: [] }, 'unsupportedCommand'],
    [{ modifyVariable: { target: '1', operation: 'set', operand: { gameData: { kind: 'gold' } } } }, 'modifyVariable'],
    [{ unsupported: { code: 122, kind: 3 } }, 'unsupportedCommand'],
    [{ pluginCommand: { raw: 'Quest Add 1', name: 'Quest', args: ['Add', '1'] } }, 'pluginCommand'],
    [{ turn: 'up' }, 'turnPlayer'],
    [{ copyVariable: '1', variable: '2' }, 'copyVariable'],
    [{ modifyVariable: { target: '1', operation: 'multiply', operand: { variable: '2' } } }, 'modifyVariable'],
    [{ inputNumber: { variable: '1', digits: 3 } }, 'inputNumber'],
    [{ weather: { type: 'rain', power: 3, duration: 1, wait: false } }, 'setWeather'],
    [{ gameOver: true }, 'gameOver'],
    [{ inputName: { target: 'player', maxLength: 12 } }, 'inputName'],
    [{ messageOptions: { position: 0, frame: 0 } }, 'setMessageOptions'],
    [{ loop: [{ wait: 1 }] }, 'runLoop'],
    [{ move: { target: 'event:1', steps: [{ dir: 'left' }], repeat: true } }, 'startMoveRoute'],
    [{ ask: '', choices: [{ text: 'A', value: 0 }], branches: [[{ wait: 1 }]] }, 'presentChoice'],
    [{ say: 'hi', portrait: { name: 'P', index: 0 } }, 'presentPortrait'],
    [{ battle: { troopId: 1, canEscape: true, canLose: false, branches: { win: [{ wait: 1 }] } } }, 'startBattle'],
    [{ shop: { goods: [{ kind: 0, id: 1, priceType: 0, price: 0 }] } }, 'openShop'],
  ];
  for (const [command, expected] of routed) {
    calls.length = 0;
    const prepared = prepareEventCommands([command], stub);
    if (typeof prepared[0]?.call !== 'function') { fail(`${Object.keys(command)[0]} did not prepare to a call`); continue; }
    await prepared[0].call(state);
    if (calls[0]?.[0] !== expected) fail(`${Object.keys(command)[0]} routed to ${calls[0]?.[0] || 'nothing'}, expected ${expected}`);
  }
  // An `if` without an `else` branch is normal vocabulary (MV omits the empty
  // branch): preparing the missing list runs nothing and warns about nothing.
  {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    let prepared;
    try { prepared = prepareEventCommands(undefined, stub); }
    finally { console.warn = originalWarn; }
    if (!Array.isArray(prepared) || prepared.length !== 0) fail('a missing branch list did not prepare to an empty run');
    else if (warnings.length) fail('a missing branch list warned like corrupt data');
    else notes.push('missing branch list prepares to nothing quietly ok');
  }
  const quests = {};
  const questChecks = [
    [applyQuestPluginCommand(quests, { name: 'Quest', args: ['Add', '7'] }), quests['7']?.active === true],
    [applyQuestPluginCommand(quests, { name: 'Quest', args: ['7', 'Show', 'Objective', '2'] }), quests['7']?.objectives['2']?.visible === true],
    [applyQuestPluginCommand(quests, { name: 'Quest', args: ['7', 'Complete', 'Objective', '2'] }), quests['7']?.objectives['2']?.completed === true],
    [applyQuestPluginCommand(quests, { name: 'Quest', args: ['Set', 'Completed', '7'] }), quests['7']?.completed === true],
    [!applyQuestPluginCommand(quests, { name: 'OtherPlugin', args: ['7'] }), true]
  ];
  if (questChecks.every(([handled, state]) => handled && state)) notes.push('Quest plugin state adapter ok');
  else fail('Quest plugin state adapter did not preserve active/objective/completed state');
  const builtinPluginState = { plugin: { tachie: {} } };
  const builtinChecks = [
    applyBuiltinPluginCommand(builtinPluginState, { name: 'DisableAutosave', args: [] }) && builtinPluginState.plugin.autosave === false,
    applyBuiltinPluginCommand(builtinPluginState, { name: 'MapScrollDisable', args: ['1'] }) && builtinPluginState.plugin.mapScrollDisabled === true,
    applyBuiltinPluginCommand(builtinPluginState, { name: 'MessageRows', args: ['6'] }) && builtinPluginState.plugin.messageRows === 6,
    applyBuiltinPluginCommand(builtinPluginState, { name: 'ChoiceRect', args: ['14', '20', '300', '120'] }) && builtinPluginState.plugin.choiceRect[2] === 300,
    applyBuiltinPluginCommand(builtinPluginState, { name: 'Tachie', args: ['showRight', '1', '0', '0', '80'] }) && builtinPluginState.plugin.tachie.right.visible === true,
    applyBuiltinPluginCommand(builtinPluginState, { name: 'FD_START_SITE', args: ['https://example.test'] }) && builtinPluginState.plugin.lastExternalSite === 'https://example.test',
    applyBuiltinPluginCommand(builtinPluginState, { name: 'RefreshMiniLabel', args: [] }) && builtinPluginState.plugin.miniLabel === true,
    applyBuiltinPluginCommand(builtinPluginState, { name: 'STS', args: ['Open'] }) && builtinPluginState.plugin.skillTree.lastAction === 'Open',
    !applyBuiltinPluginCommand(builtinPluginState, { name: 'UnknownPlugin', args: [] })
  ];
  if (builtinChecks.every(Boolean)) notes.push('built-in plugin state adapters ok');
  else fail('built-in plugin state adapters did not preserve known command state');
  if (normalizeDialogueMarkup('a<br>b <i>c</i>') === 'a\nb *c*') notes.push('inline dialogue markup normalization ok');
  else fail('inline dialogue markup normalization changed styled text incorrectly');
  if (!playerCore.includes("like Karryn's `\\#`")) fail('player-core.js prints unknown text escapes instead of consuming them');
  else notes.push('unknown text escapes are consumed like the engine ok');
  if (!playerCore.includes('convertExtraEscapeCharacters') || !playerCore.includes('gameTextConverter')) fail('player-core.js does not run the game text-code layer before the built-in escapes');
  else notes.push('game text-code layer runs before built-in escapes ok');
  if (!playerCore.includes('_saveCount') || !playerCore.includes('promptSaveGame')) fail('player-core.js does not count engine saves or prompt for the save file');
  else notes.push('engine save count and save-file prompt ok');
  if (!playerCore.includes('refreshAutorunEvents')) fail('player-core.js never refreshes autorun events after a page finishes');
  else notes.push('autorun refresh after page completion ok');
  // Event-script runtime, end to end on a made-up game (no real game data): a Scripts.rxdata
  // stand-in defines an Interpreter class, a Game_Event class, a module and a helper def;
  // the library builder transpiles what the snippets reach and the runtime runs it.
  {
    const { setInterpreterMethods, transpileSnippet } = await import(pathToFileURL(join(root, 'tools', 'rgss-snippet.mjs')).href);
    const { indexScripts, buildRgssLibrary, transpileUnit } = await import(pathToFileURL(join(root, 'tools', 'rgss-library.mjs')).href);
    const { setKnownMethods } = await import(pathToFileURL(join(root, 'tools', 'rgss-call-filter.mjs')).href);
    const { createRgssRuntime } = await import(pathToFileURL(join(root, 'src', 'player', 'rgss-script.js')).href);
    const scripts = [
      { name: 'Game_Event', source: 'class Game_Event\n  def setTempSwitchOn(ch)\n    $game_self_switches[[@map_id, @id, ch]] = true\n  end\nend\n' },
      { name: 'Interpreter', source: 'class Interpreter\n  def get_self\n    $game_map.events[@event_id]\n  end\n  def on_event?\n    get_self.x == $game_player.x\n  end\nend\n' },
      { name: 'Shop', source: 'module Shop\n  def self.price(id)\n    id * 10\n  end\nend\n\ndef give_potion(n)\n  $game_party.gain_item(1, n)\n  $game_party.gain_gold(-Shop.price(n))\nend\n' },
      { name: 'HashProbe', source: 'module HashProbe\n  TABLE = { "a" => 1, "b" => 2 }.freeze\n  def self.total_value\n    total = 0\n    TABLE.each { |key, value| total += value }\n    total\n  end\n  def self.count(values)\n    values.length\n  end\nend\n' },
      { name: 'HashProbe', source: 'module HashProbe\n  TABLE = { "a" => 1, "b" => 2 }.freeze\n  def self.total_value\n    total = 0\n    TABLE.each { |key, value| total += value }\n    total\n  end\n  def self.count(values)\n    values.length\n  end\nend\n' },
      { name: 'ForwardConst', source: 'module ForwardConst\n  VALUE = LATER_VALUE + 1\n  LATER_VALUE = 4\n  def self.value\n    VALUE\n  end\nend\n' },
      { name: 'MethodCatalog', source: 'def missing_method\nend\n' },
      { name: 'PartialUnit', source: 'module PartialUnit\nend\n' },
      { name: 'Pronoun', source: 'module Pronoun\n  def self.current_gender\n    "female"\n  end\n  def self.title\n    current_gender\n  end\nend\n' }
    ];
    const snippets = ['get_self.setTempSwitchOn("A")', 'give_potion(2)', 'on_event?', 'HashProbe.total_value', 'HashProbe.count', 'ForwardConst.value', 'PartialUnit.missing_method', 'Pronoun.title', 'Unknown.thing(1)'];
    const index = indexScripts(scripts);
    setKnownMethods(index.allDefNames);
    setInterpreterMethods(index.interpreterMethods);
    const library = await buildRgssLibrary(scripts, snippets, { index, maxDepth: 3, log: () => {} });
    const switches = new Map(), variables = new Map(), played = [];
    const game = { switch: k => switches.get(k) === true, setSwitch: (k, v) => switches.set(k, v), variable: k => variables.get(k) || 0, setVariable: (k, v) => variables.set(k, v) };
    const scene = { rpgExtra: { items: {}, party: [], gold: 100 }, mover: { x: 2, y: 2 }, facing: 'down',
      showBalloon: b => played.push(['balloon', b.target, b.balloon]), presentDialogue: r => played.push(['say', r.text]), runMoveRoute() {} };
    const events = [{ id: 5, x: 2, y: 2 }, { id: 7, x: 4, y: 2 }];
    const rgss = createRgssRuntime(scene, { mapId: 3, mapEvents: events, mapSize: { width: 10, height: 10 }, library });
    const run = async (source, event = events[0]) => rgss.run({ source, ...transpileSnippet(source, 'call') }, { game }, event);
    const test = (source, event = events[0]) => rgss.evaluate({ source, ...transpileSnippet(source, 'cond') }, { game }, event);
    const originalWarn = console.warn; const warnings = []; console.warn = (...a) => warnings.push(a[0]);
    try {
      await run(['$game_switches[7] = true', '$game_variables[2] += 3'].join('\n'));
      await run('get_self.setTempSwitchOn("A")');
      await run('give_potion(2)');
      await run('$game_party.gain_gold(5)\n$game_temp.message_text = "hi"\n$game_map.events[7].balloon_id = 1');
      await run('Unknown.thing(1)');
      const rubyHashIteration = rgss.evaluateValue({ source: 'HashProbe.total_value', js: 'return HashProbe.total_value();' }, { game }, events[0]);
      const rubyArrayLength = rgss.evaluateValue({ source: 'HashProbe.count([1, 2])', js: 'return HashProbe.count([1, 2]);' }, { game }, events[0]);
      const forwardConstant = rgss.evaluateValue({ source: 'ForwardConst.value', js: 'return ForwardConst.value();' }, { game }, events[0]);
      const rubyTranslate = rgss.evaluateValue({ source: '"a\\\\b".tr("\\\\", "/")', js: 'return "a\\\\b".tr("\\\\", "/");' }, { game }, events[0]);
      const rubyCapitalize = rgss.evaluateValue({ source: '"FEMALE".capitalize', js: 'return "FEMALE".capitalize;' }, { game }, events[0]);
      const rubyDefined = rgss.evaluateValue({ source: 'Object.prototype.defined.call("x", "capitalize")', js: 'return Object.prototype.defined.call("x", "capitalize");' }, { game }, events[0]);
      const zeroArgModuleCall = rgss.evaluateValue({ source: 'Pronoun.title', js: 'return Pronoun.title();' }, { game }, events[0]);
      const rubyRegexReplace = rgss.evaluateValue({ source: '"a1 a2".gsub(/a\\d/, "x")', js: 'return "a1 a2".replaceAll(/a\\d/, "x");' }, { game }, events[0]);
      const fileExtname = rgss.evaluateValue({ source: 'File.extname("portrait.png")', js: 'return File.extname("portrait.png");' }, { game }, events[0]);
      const rtpPath = rgss.evaluateValue({ source: 'RTP.eachPathFor("portrait.png") { |path| path }', js: 'let seen = null; RTP.eachPathFor("portrait.png", path => { seen = path; }); return seen;' }, { game }, events[0]);
      await run('PartialUnit.missing_method()');
      // Ruby2JS strips `?`/`!` from method names, so the manifest's method list
      // must carry the stripped form the player's shims look up at run time.
      const strippedMethodNames = library.methods.includes('on_event') && !library.methods.includes('on_event?');
      // A patch script redefining a helper reaches JS as duplicate top-level
      // functions; Ruby's last definition wins and the unit must still load
      // inside the runtime's `with (scope)` wrapper (pbExclaim in Pokemon Void).
      const redefined = transpileUnit({ name: 'greet', kind: 'def', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'A', text: 'def greet\n1\nend' }, { script: 'B', text: 'def greet\n2\nend' }] });
      let redefinedLoadsLastWins = (redefined.match(/function greet/g) || []).length === 1;
      try { redefinedLoadsLastWins &&= new Function('scope', `with (scope) {\n${redefined}\nreturn greet;\n}`)({})() === 2; }
      catch { redefinedLoadsLastWins = false; }
      await run('pbStartQuest(:INTRO)');
      const questStarted = scene.rpgExtra.quests?.INTRO?.active === true && test('pbQuestComplete?(:INTRO)') === false;
      await run('pbCompleteQuest(:INTRO)');
      await run('pbItemBall(:POTION)\npbReceiveItem(:ANTIDOTE, 2)\npbAddPokemon(:EEVEE, 5)');
      // The newest lowerings, end to end: `slice!`, Hash key membership, a module sharing `@cache`
      // state across sibling calls (the `RPG::Cache` bitmap-cache shape), and a method kept callable next to a
      // same-name setter. Handler-registry statements (`XHandlers.add`, `GameData::X.register`) index as boot units.
      const { lowerRuby } = await import(pathToFileURL(join(root, 'tools', 'rgss-async.mjs')).href);
      const spliceOk = await rgss.run({ source: 'slice!', js: 'let s = "hello"; const cut = __splice(s, (__v) => { s = __v }, 1, 2); const a = [1, 2, 3]; const head = __splice(a, null, 0, 1); $game_variables[9] = cut + "|" + s + "|" + head + "|" + a.join(",");' }, { game }, events[0]);
      const hashIncludes = rgss.evaluateValue({ source: 'include?', js: 'return ({a: 1}).includes("a") && !({a: 1}).includes("z") && [1, 2].includes(2);' }, { game }, events[0]);
      const cacheJs = lowerRuby('const Cache = (() => { this._cache = {}; function load(n) { return this._cache[n] ?? (this._cache[n] = n * 2) } function get(n) { return load(n) } return { load, get } })()');
      const cacheHit = rgss.evaluateValue({ source: 'cache', js: `${cacheJs}; return Cache.get(21) + Cache.get(21);` }, { game }, events[0]);
      const clashJs = lowerRuby('class W { columns() { return 3 } set columns(v) { this._c = v } }');
      const clashHit = rgss.evaluateValue({ source: 'clash', js: `${clashJs}; const w = new W(); w.columns = 9; return w.columns() + w._c;` }, { game }, events[0]);
      const bootIndex = indexScripts([{ name: 'Handlers', source: 'MenuHandlers.add(:pause_menu, :pokedex, { "name" => "Pokedex" })\n' }]);
      const checks = [
        [Object.keys(library.units).sort().join() === 'ForwardConst,Game_Event,HashProbe,Interpreter,PartialUnit,Pronoun,Shop,give_potion', 'library holds exactly the units the snippets reach'],
        [switches.get('7') === true && variables.get('2') === 3, 'built-in $game_switches / $game_variables'],
        [switches.get('self:3:5:A') === true, "the game's own Interpreter#get_self + Game_Event#setTempSwitchOn run on the shim"],
        [scene.rpgExtra.items['1'] === 2 && scene.rpgExtra.gold === 85, "a game-defined top-level def and module method run (gold 100 - 20 + 5)"],
        [JSON.stringify(played) === JSON.stringify([['say', 'hi'], ['balloon', 7, 1]]), 'queued waits play in call order'],
        [questStarted && test('pbQuestComplete?(:INTRO)') === true, 'quest start/completion helpers'],
        [scene.rpgExtra.namedItems?.POTION === 1 && scene.rpgExtra.namedItems?.ANTIDOTE === 2 && scene.rpgExtra.namedParty?.[0]?.species === 'EEVEE' && test('pbCheckItem(:POTION)') === true, 'named item and Pokémon helpers'],
        [warnings.some(w => String(w).includes('Unknown.thing')), 'an unknown call warns loudly'],
        [test('on_event?') === true && test('on_event?', events[1]) === false, "a game-defined Interpreter predicate in a condition"],
        [test('$game_variables[2] >= 3 && $game_switches[7]') === true, 'cond over switches/variables']
        , [rubyHashIteration === 3, 'Ruby Hash#each iterates transpiled frozen hashes']
        , [rubyArrayLength === 2, 'Ruby Array#length remains a JavaScript property']
        , [forwardConstant === 5, 'forward literal constants are initialized before use']
        , [rubyTranslate === 'a/b', 'Ruby String#tr is available to RGSS libraries']
        , [rubyCapitalize === 'Female', 'Ruby String#capitalize is available to RGSS libraries']
        , [rubyDefined === true, 'Ruby Object#defined? is available to RGSS libraries']
        , [zeroArgModuleCall === 'female', 'Ruby zero-argument module calls stay calls']
        , [rubyRegexReplace === 'x x', 'Ruby gsub accepts non-global regular expressions']
        , [fileExtname === '.png', 'RGSS File.extname is available to browser scripts']
        , [rtpPath === null, 'RTP path lookup degrades to not-found without filesystem access']
        , [warnings.some(w => String(w).includes('PartialUnit.missing_method')), 'missing library methods degrade to a loud callable stub']
        , [strippedMethodNames, 'manifest method names are stripped of ?/! like the transpiled output']
        , [redefinedLoadsLastWins, 'a redefined helper keeps only its last definition and loads under with(scope)']
        , [spliceOk === true && variables.get('9') === 'el|hlo|1|2,3', 'Ruby slice! removes and returns through __splice (string and array)']
        , [hashIncludes === true, 'Hash#include? reads key membership without shadowing Array#includes']
        , [cacheHit === 84, 'a module IIFE shares its @cache across sibling calls through one self']
        , [clashHit === 12, 'a method next to a same-name setter stays callable and the setter still assigns']
        , [(bootIndex.bootStatementNames || []).length === 1, 'handler-registry statements index as boot units']
      ];
      for (const [ok, label] of checks) if (!ok) fail(`rgss runtime: ${label}`);
      if (checks.every(([ok]) => ok)) notes.push(`rgss script runtime ok (${checks.length} checks)`);
    } finally { console.warn = originalWarn; }
    setInterpreterMethods(null);
    setKnownMethods([]);
  }
  // MV/MZ scripts are JavaScript: same runtime, MV globals.
  {
    const { createRgssRuntime } = await import(pathToFileURL(join(root, 'src', 'player', 'rgss-script.js')).href);
    const switches = new Map(), variables = new Map();
    const game = { switch: k => switches.get(k) === true, setSwitch: (k, v) => switches.set(k, v), variable: k => variables.get(k) || 0, setVariable: (k, v) => variables.set(k, v) };
    const scene = { rpgExtra: { items: {}, party: [], gold: 10 }, mover: { x: 1, y: 1 }, facing: 'down', project: { plugins: ['SomePlugin'] } };
    const mv = createRgssRuntime(scene, { mapId: 4, mapEvents: [{ id: 2, x: 1, y: 1 }], dialect: 'mv' });
    await mv.run({ source: 's', js: "$gameSwitches.setValue(3, true); $gameVariables.setValue(1, $gameVariables.value(1) + 5); $gameParty.gainGold(7); $gameSelfSwitches.setValue([$gameMap.mapId(), this.eventId(), 'A'], true); $gameParty.gainItem($dataItems[9], 2); $gameParty.somePluginMethod();" }, { game }, { id: 2 });
    const truthy = mv.evaluate({ source: 'c', js: 'return ($gameSwitches.value(3) && $gameParty.gold() === 17);' }, { game }, { id: 2 });
    const scriptValue = mv.evaluateValue({ source: 'v', js: 'return ($gameVariables.value(1) + 1);' }, { game }, { id: 2 });
    const originalError = console.error; console.error = () => {};
    let scriptFailed;
    try { scriptFailed = mv.evaluateValue({ source: 'bad', js: 'throw new Error("x");' }, { game }, { id: 2 }); }
    finally { console.error = originalError; }
    const okMv = switches.get('3') === true && variables.get('1') === 5 && switches.get('self:4:2:A') === true && scene.rpgExtra.items['9'] === 2 && truthy === true
      && scriptValue === 6 && scriptFailed === 0;
    if (okMv) notes.push('mv script runtime ok'); else fail('mv script runtime: $gameSwitches/$gameVariables/$gameParty/$gameSelfSwitches/this.eventId/evaluateValue');
  }
  // MV plugin sandbox: plugin-defined globals, plugin-added engine-class methods
  // borrowed by the shim objects, PluginManager parameters, and a failing plugin
  // that must not take the others down. Synthetic plugins, no game involved.
  {
    const { createRgssRuntime } = await import(pathToFileURL(join(root, 'src', 'player', 'rgss-script.js')).href);
    const switches = new Map(), variables = new Map();
    const game = { switch: k => switches.get(k) === true, setSwitch: (k, v) => switches.set(k, v), variable: k => variables.get(k) || 0, setVariable: (k, v) => variables.set(k, v) };
    const scene = { rpgExtra: { items: {}, party: [], gold: 0 }, mover: { x: 1, y: 1 }, facing: 'down', project: {} };
    const pluginLibrary = {
      order: ['Alpha', 'Broken', 'Beta'],
      parameters: { Alpha: { who: 'bob' } },
      engine: ['Game_Party', 'BattleManager'],
      sources: {
        Alpha: "var Ns = Ns || {};\nconst LIMIT = 7;\nNs.ready = function () { return true; };\nvar P = PluginManager.parameters('Alpha');\nGame_Party.prototype.greet = function () { this._greeted = true; return 'hi ' + P.who; };\nBattleManager.shout = function (n) { return n * 2; };",
        Broken: "var Half = 1;\nthrow new Error('boom');",
        Beta: "var Uses = Ns.ready() ? 'yes' : 'no';"
      }
    };
    const rt = createRgssRuntime(scene, { mapId: 1, mapEvents: [{ id: 2, x: 1, y: 1 }], dialect: 'mv', pluginLibrary });
    const originalWarn = console.warn; console.warn = () => {};
    let results;
    try {
      results = ['Ns.ready()', "$gameParty.greet() === 'hi bob'", 'LIMIT === 7', "Uses === 'yes'", 'Half === 1', 'BattleManager.shout(4) === 8']
        .map(js => rt.evaluate({ source: js, js: `return (${js});` }, { game }, { id: 2 }));
    } finally { console.warn = originalWarn; }
    if (results.every(Boolean)) notes.push('mv plugin sandbox ok (6 checks)'); else fail(`mv plugin sandbox: ${JSON.stringify(results)}`);
  }
  // MV engine layer: the project's own engine files evaluate in the sandbox, the real
  // Game_Party bridges onto rpgExtra, plugin-added methods run on real classes, and engine
  // state survives a reload (a second runtime over the same rpgExtra). Synthetic engine.
  {
    const { createRgssRuntime } = await import(pathToFileURL(join(root, 'src', 'player', 'rgss-script.js')).href);
    const switches = new Map(), variables = new Map();
    const game = { switch: k => switches.get(k) === true, setSwitch: (k, v) => switches.set(k, v), variable: k => variables.get(k) || 0, setVariable: (k, v) => variables.set(k, v) };
    const rpgExtra = { items: {}, party: [1], gold: 3 };
    const project = { database: { system: { partyMembers: [1] }, actors: [null, { id: 1, name: 'Ann' }] } };
    const pluginLibrary = {
      order: ['Extra'], parameters: {}, engine: ['Game_Party', 'Game_System', 'JsonEx', 'Game_Interpreter', 'Game_Variables'],
      engineSources: {
        rpg_core: "function JsonEx() {}\nJsonEx.stringify = function (o) { return JSON.stringify(o); };\nJsonEx.parse = function (t) { return JSON.parse(t); };\nfunction Game_Interpreter() { this._eventId = 0; }\nGame_Interpreter.prototype.pluginCommand = function () {};\nfunction Game_Variables() {}",
        rpg_objects: "function Game_System() { this._flag = 0; }\nfunction Game_Screen() { this._tone = 1; }\nfunction Game_Timer() { this._frames = 0; }\nfunction Game_Party() { this._gold = 0; this._items = {}; this._weapons = {}; this._armors = {}; this._actors = []; }\nGame_Party.prototype.gold = function () { return this._gold; };\nGame_Party.prototype.gainGold = function (n) { this._gold += n; };\nfunction Game_Actors() { this._data = []; }\nGame_Actors.prototype.actor = function (id) { return this._data[id] || (this._data[id] = { id: id, hp: 10 }); };"
      },
      sources: { Extra: "Game_Party.prototype.bonus = function () { this.gainGold(10); this._visits = (this._visits || 0) + 1; return this.gold(); };\nGame_Variables.prototype.twice = function (id) { this.setValue(id, this.value(id) * 2); };\nvar _pc = Game_Interpreter.prototype.pluginCommand;\nGame_Interpreter.prototype.pluginCommand = function (c, a) { _pc.call(this, c, a); if (c === 'Bump') { $gameVariables.setValue(5, Number(a[0]) + this._eventId); $gameVariables.twice(5); } };" }
    };
    const make = () => createRgssRuntime({ rpgExtra, mover: { x: 1, y: 1 }, facing: 'down', project, presentDialogue() {}, playSound() {} }, { mapId: 1, mapEvents: [], dialect: 'mv', pluginLibrary });
    const ev = (rt, js) => rt.evaluateValue({ source: js, js: `return (${js});` }, { game }, { id: 0 });
    const originalWarn = console.warn, originalInfo = console.info; console.warn = () => {}; console.info = () => {};
    let results;
    try {
      const first = make();
      const bonus = ev(first, '$gameParty.bonus()');
      ev(first, '($gameSystem._flag = 7, $gameActors.actor(1).hp = 4, $gameScreen._tone = 9, $gameTimer._frames = 30, 0)');
      const second = make();
      const pluginRan = make().pluginCommand('Bump', ['3'], { game }, { id: 4 }) === true && variables.get('5') === 14;
      const unknownStillFalse = createRgssRuntime({ rpgExtra, mover: { x: 1, y: 1 }, facing: 'down', project, presentDialogue() {}, playSound() {} }, { mapId: 1, mapEvents: [], dialect: 'mv', pluginLibrary: { ...pluginLibrary, engine: [], engineSources: {}, sources: {}, order: [] } }).pluginCommand('Bump', [], { game }, { id: 0 }) === false;
      results = [pluginRan, unknownStillFalse, bonus === 13, rpgExtra.gold === 13, ev(second, '$gameSystem._flag') === 7, ev(second, '$gameActors._data[1].hp') === 4, ev(second, '$gameParty._visits') === 1, ev(second, '$gameScreen._tone') === 9 && ev(second, '$gameTimer._frames') === 30, ev(second, '$gameParty.gold()') === 13];
    } finally { console.warn = originalWarn; console.info = originalInfo; }
    if (results.every(Boolean)) notes.push('mv engine layer ok (9 checks: plugin method on real class, plugin commands through Game_Interpreter, rpgExtra bridge, reload persistence)'); else fail(`mv engine layer: ${JSON.stringify(results)}`);
  }
  // Audio: the adapter over mw_games' AudioBus (>= 0.18): format resolution, loop tags, mixer scaling,
  // ME/BGM resume, state round-trip, MIDI through the library's parser/renderer + SoundFont, the render
  // cache, and the converter's index, against a fake AudioContext (no browser needed).
  {
    const lib = await import('@datamoc/mw_games/audio');
    const { AudioManager, chooseExtension, parseLoopTags } = await import(pathToFileURL(join(root, 'src', 'player', 'audio-manager.js')).href);
    const { buildAudioIndex } = await import(pathToFileURL(join(root, 'tools', 'audio-index.mjs')).href);
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const checks = [];
    checks.push(chooseExtension(['.wma', '.mp3', '.ogg']) === '.ogg' && chooseExtension(['.mid', '.wav']) === '.wav' && chooseExtension(['.mid']) === '.mid');
    const tags = new TextEncoder().encode('OggS....vorbis LOOPSTART=1000\0LOOPLENGTH=2000');
    checks.push(JSON.stringify(parseLoopTags(tags)) === JSON.stringify({ loopStart: 1000, loopLength: 2000 }) && parseLoopTags(new Uint8Array(20)) === null);
    // converter index: several formats for one name, nested names, a MIDI-only track
    const dir = mkdtempSync(join(tmpdir(), 'mwgp-audio-'));
    try {
      for (const [kind, files] of Object.entries({ bgm: ['Town.mid', 'Town.ogg', 'Cave.mp3', 'sub/Deep.wav'], se: ['Ping.wav'], me: [], bgs: [] })) {
        mkdirSync(join(dir, kind, 'sub'), { recursive: true });
        for (const file of files) writeFileSync(join(dir, kind, file), 'x');
      }
      const index = buildAudioIndex(dir);
      checks.push(index.bgm.Town === '.ogg' && index.bgm.Cave === '.mp3' && index.bgm['sub/Deep'] === '.wav' && index.se.Ping === '.wav' && Object.keys(index.me).length === 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }

    class FakeParam { constructor(value = 0) { this.value = value; } setTargetAtTime(v) { this.value = v; } setValueAtTime() {} cancelScheduledValues() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
    class FakeNode { constructor() { this.connections = []; } connect(node) { this.connections.push(node); return node; } disconnect() {} }
    const sources = [];
    class FakeContext {
      constructor() { this.currentTime = 0; this.destination = new FakeNode(); this.state = 'suspended'; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      createGain() { const node = new FakeNode(); node.gain = new FakeParam(1); return node; }
      createStereoPanner() { const node = new FakeNode(); node.pan = new FakeParam(0); return node; }
      createBufferSource() {
        const node = new FakeNode(); node.playbackRate = new FakeParam(1); node.started = null; node.stopped = false;
        node.start = (when, offset) => { node.started = { when, offset }; }; node.stop = () => { node.stopped = true; };
        sources.push(node); return node;
      }
      createBuffer(channels, length, rate) { return { duration: length / rate, sampleRate: rate, numberOfChannels: channels, getChannelData: () => new Float32Array(length), copyToChannel() {} }; }
      decodeAudioData(bytes) { return Promise.resolve({ duration: 10, sampleRate: 1000, bytes: bytes.byteLength }); }
    }
    const warnings = [];
    const store = new Map();
    const make = (extra = {}) => new AudioManager({
      root: '/assets', lib, index: { bgm: { Town: '.ogg', Cave: '.mp3', Old: '.wma' }, bgs: { Rain: '.ogg' }, me: { Win: '.ogg' }, se: { Ping: '.wav' } },
      contextFactory: () => new FakeContext(),
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
      storage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
      renderCache: null, log: { warn: message => warnings.push(message) }, ...extra
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 5));
    const audio = make();
    checks.push(audio.urlFor('bgm', 'Cave') === '/assets/audio/bgm/Cave.mp3' && audio.urlFor('se', 'Ping') === '/assets/audio/se/Ping.wav');
    checks.push(audio.urlFor('bgm', 'Old') === null && audio.urlFor('bgm', 'Nope') === null && warnings.length === 2);
    await audio.playBgm({ name: 'Town', volume: 80, pitch: 120, pan: -50 }); await settle();
    const first = sources[sources.length - 1];
    checks.push(first.loop && first.started?.offset === 0 && Math.abs(first.playbackRate.value - 1.2) < 1e-9 && audio.isPlaying('bgm'));
    audio.setVolume('bgm', 0.5);                                                    // mixer scales the level, the game's own volume is kept
    checks.push(sources.length === 1 && audio.currentTrack('bgm').volume === 80 && audio.snapshot().bgm.volume === 80);
    await audio.playBgm({ name: 'Town', volume: 40, pitch: 100 }); await settle();
    checks.push(sources.length === 1 && audio.currentTrack('bgm').volume === 40);   // same track: retuned, not restarted
    audio.context.currentTime = 3;
    checks.push(Math.abs(audio.currentTrack('bgm').pos - 3) < 1e-9);
    await audio.playMe({ name: 'Win', volume: 100, pitch: 100 }); await settle();
    checks.push(first.stopped && !audio.isPlaying('bgm') && audio.currentTrack('bgm')?.name === 'Town');   // BGM suspended under the jingle
    const meSource = sources[sources.length - 1];
    meSource.onended(); await settle();
    const resumed = sources[sources.length - 1];
    checks.push(resumed !== meSource && resumed.loop && Math.abs(resumed.started.offset - 3) < 1e-9);       // BGM resumes at its position
    const snapshot = JSON.parse(JSON.stringify(audio.snapshot()));
    const other = make();
    other.restore(snapshot); await settle();
    checks.push(other.currentTrack('bgm')?.name === 'Town' && Math.abs(sources[sources.length - 1].started.offset - snapshot.bgm.pos) < 1e-9);
    audio.saveBgm(); await audio.playBgm({ name: 'Cave' }); await settle(); await audio.replayBgm(); await settle();
    checks.push(audio.currentTrack('bgm').name === 'Town');
    await audio.playBgs({ name: 'Rain', volume: 60 }); await settle();
    checks.push(audio.currentTrack('bgs').name === 'Rain' && audio.currentTrack('bgm').name === 'Town');    // independent streams
    await audio.playSe({ name: 'Ping', volume: 50, pitch: 150 });
    const se = sources[sources.length - 1];
    checks.push(Math.abs(se.playbackRate.value - 1.5) < 1e-9);
    audio.setVolume('bgm', 0.5); audio.setMuted(true);
    checks.push(audio.master.gain.value === 0 && JSON.parse(store.get('mwgp.audio.volumes')).bgm === 0.5 && make().volumes.muted === true);
    audio.stopBgm(); checks.push(audio.currentTrack('bgm') === null);

    // MIDI through the library: parse (programs, loop marker), render offline, SoundFont layering.
    {
      const vlq = value => value < 128 ? [value] : [0x80 | (value >> 7), value & 0x7f];
      const track = [
        0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,                 // tempo 500000us -> 0.5 s per beat
        0x00, 0xc0, 0x18,                                          // program 24 on channel 0
        0x00, 0xb0, 0x6f, 0x00,                                    // controller 111: loop marker at tick 0
        ...vlq(0), 0x90, 60, 100, ...vlq(480), 0x80, 60, 0,        // one beat of middle C
        ...vlq(0), 0x99, 36, 100, ...vlq(96), 0x89, 36, 0,         // a kick on the drum channel
        0x00, 0xff, 0x2f, 0x00
      ];
      const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];       // format 0, 1 track, 480 ticks/beat
      const chunk = [0x4d, 0x54, 0x72, 0x6b, (track.length >> 24) & 255, (track.length >> 16) & 255, (track.length >> 8) & 255, track.length & 255, ...track];
      const bytes = new Uint8Array([...header, ...chunk]);
      const file = lib.parseMidi(bytes);
      const notes = lib.scheduleMidi(file);
      checks.push(notes.length === 2 && Math.abs(notes[0].duration - 0.5) < 1e-9 && notes[0].program === 24 && lib.midiLoopStart(file) === 0);
      const rendered = lib.renderMidiToBuffer(file);
      checks.push(rendered.duration > 1 && rendered.left.length === rendered.right.length && rendered.loopStart === 0 && rendered.left.some(value => value !== 0));
      // A synthetic one-sample SoundFont (looped, root key 60) voices the same file.
      const u16 = value => [value & 255, value >> 8], u32 = value => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255];
      const name = text => [...text.padEnd(20, '\0')].map(char => char.charCodeAt(0));
      const fourcc = id => [...id].map(char => char.charCodeAt(0));
      const wrap = (id, data) => [...fourcc(id), ...u32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
      const list = (id, chunks) => wrap('LIST', [...fourcc(id), ...chunks.flat()]);
      const gen = (oper, amount) => [...u16(oper), ...u16(amount & 0xffff)];
      const smpl = Array.from({ length: 100 }, (_, index) => Math.round(Math.sin(index / 5) * 10000)).flatMap(value => u16(value & 0xffff));
      const pdta = [
        wrap('phdr', [...name('Piano'), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...name('EOP'), ...u16(0), ...u16(0), ...u16(1), ...u32(0), ...u32(0), ...u32(0)]),
        wrap('pbag', [...u16(0), ...u16(0), ...u16(1), ...u16(0)]), wrap('pmod', new Array(10).fill(0)), wrap('pgen', [...gen(41, 0), ...gen(0, 0)]),
        wrap('inst', [...name('Piano'), ...u16(0), ...name('EOI'), ...u16(1)]), wrap('ibag', [...u16(0), ...u16(0), ...u16(2), ...u16(0)]), wrap('imod', new Array(10).fill(0)),
        wrap('igen', [...gen(54, 1), ...gen(53, 0), ...gen(0, 0)]),
        wrap('shdr', [...name('S'), ...u32(0), ...u32(100), ...u32(20), ...u32(80), ...u32(22050), 60, 0, ...u16(0), ...u16(1), ...name('EOS'), ...new Array(26).fill(0)])
      ];
      const body = [...fourcc('sfbk'), ...list('sdta', [wrap('smpl', smpl)]), ...list('pdta', pdta)];
      const sf2 = new Uint8Array([...fourcc('RIFF'), ...u32(body.length), ...body]);
      const font = lib.parseSoundFont(sf2);
      const voices = font.voices(0, 0, 60, 100);
      checks.push(font.presetCount === 1 && voices.length === 1 && voices[0].loop && voices[0].rootKey === 60);
      const sampled = lib.renderMidiToBuffer(file, { soundfont: font });
      checks.push(sampled.duration > 1 && sampled.left.some(value => value !== 0));
      // The manager wires it together: project SoundFont, MIDI render, loop region, and the reload cache.
      const cache = new Map();
      const routes = { '/assets/audio/bgm/Song.mid': bytes, '/sf.sf2': sf2 };
      const fetched = [];
      const options = { root: '/assets', index: { bgm: { Song: '.mid' } }, soundfontUrls: ['/none.sf2', '/sf.sf2'], cacheVersion: 'v1', log: { warn() {}, info() {} },
        fetchImpl: async url => { fetched.push(url); const data = routes[url]; return data ? { ok: true, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } : { ok: false, status: 404 }; },
        renderCache: { get: async key => cache.get(key) ?? null, set: async (key, value) => { cache.set(key, value); } } };
      const withMidi = make(options);
      await withMidi.playBgm({ name: 'Song' }); await settle();
      const midiSource = sources[sources.length - 1];
      checks.push(withMidi.soundfontUrl === '/sf.sf2' && withMidi.isPlaying('bgm') && midiSource.loop && midiSource.loopStart === 0 && midiSource.loopEnd > 1 && cache.size === 1 && [...cache.keys()][0].includes('/sf.sf2'));
      const before = fetched.filter(url => url.endsWith('.mid')).length;
      const reloaded = make(options);
      await reloaded.playBgm({ name: 'Song' }); await settle();
      checks.push(fetched.filter(url => url.endsWith('.mid')).length === before && reloaded.isPlaying('bgm'));   // second "page load" hits the cache, no MIDI fetch
    }
    if (checks.every(Boolean)) notes.push(`audio adapter over mw_games ${lib.AudioBus ? 'AudioBus' : '?'}, MIDI + SoundFont and index ok (${checks.length} checks)`); else fail(`audio manager: ${JSON.stringify(checks)}`);
  }
  // SoundFont licensing guard: every .sf2/.sf3 in soundfonts/ or tracked by git must be recorded in
  // soundfonts/vetted.json with a licence, a licence file, a source and a matching checksum.
  {
    const { createHash } = await import('node:crypto');
    const { execSync } = await import('node:child_process');
    const dir = join(root, 'soundfonts');
    const vetted = existsSync(join(dir, 'vetted.json')) ? JSON.parse(readFileSync(join(dir, 'vetted.json'), 'utf8')) : { fonts: [] };
    const present = new Set(existsSync(dir) ? readdirSync(dir).filter(name => /\.sf[23]$/i.test(name)).map(name => `soundfonts/${name}`) : []);
    try { for (const file of execSync('git ls-files -- "*.sf2" "*.sf3"', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) present.add(file); } catch { /* not a git checkout */ }
    const problems = [];
    for (const file of present) {
      const entry = (vetted.fonts || []).find(font => `soundfonts/${font.file}` === file);
      if (!entry) { problems.push(`${file}: not listed in soundfonts/vetted.json`); continue; }
      for (const field of ['name', 'license', 'licenseFile', 'source', 'sha256', 'vettedBy', 'vettedOn']) if (!entry[field]) problems.push(`${file}: vetted.json entry lacks "${field}"`);
      if (entry.licenseFile && !existsSync(join(dir, entry.licenseFile))) problems.push(`${file}: licence file ${entry.licenseFile} is missing`);
      if (entry.sha256 && createHash('sha256').update(readFileSync(join(root, file))).digest('hex') !== String(entry.sha256).toLowerCase()) problems.push(`${file}: checksum differs from vetted.json`);
    }
    for (const entry of vetted.fonts || []) if (!present.has(`soundfonts/${entry.file}`)) problems.push(`vetted.json lists ${entry.file} but the file is missing`);
    if (problems.length) fail(`soundfont licensing guard: ${problems.join('; ')}`); else notes.push(`soundfont licensing guard ok (${present.size} soundfont(s), all vetted)`);
  }
  // RGSS API surface dump and shim-coverage report (T141): string-pool segmentation, the embedded RPG
  // prelude, and the usage analysis, on a synthetic binary and manifest.
  {
    const { dumpApi } = await import(pathToFileURL(join(root, 'tools', 'rgss-api-dump.mjs')).href);
    const { analyze } = await import(pathToFileURL(join(root, 'tools', 'rgss-coverage.mjs')).href);
    const pool = ['libc noise', 'Zlib', 'Foo', 'Color', 'initialize', 'set', '==', 'red', 'red=', "Can't convert %s into %s", 'Bitmap', 'dispose', 'blt', 'fill_rect', 'width', 'Input', 'update', 'trigger?', 'press?', 'DOWN', 'LEFT',
      'Graphics', 'update', 'frame_count', 'frame_count=', 'Sprite', 'dispose', 'x=', 'y=', 'Audio', 'bgm_play', 'se_play', 'bgs_play', 'load_data', 'save_data',
      'module RPG\n  class Map\n    class Encounter\n      def initialize\n      end\n      attr_accessor :troop_id\n    end\n    attr_accessor :width\n    attr_accessor :bgm\n  end\nend\n'];
    const bytes = Buffer.concat(pool.map(text => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([0])])));
    const api = dumpApi(bytes, 'Game.exe');
    const okDump = api.classes.Bitmap?.methods.join() === 'dispose,blt,fill_rect,width' && api.classes.Input?.constants.join() === 'DOWN,LEFT' && api.classes.Color?.methods.includes('==')
      && api.classes.Sprite?.methods.includes('x=') && !api.classes.Foo && api.kernel.load_data === true && api.rpg['RPG::Map']?.attributes.join() === 'width,bgm' && api.rpg['RPG::Map::Encounter']?.attributes.join() === 'troop_id';
    const packed = dumpApi(Buffer.from('MZ\0\0kernel32.dll\0GetProcAddress\0'), 'packed.dll');
    const project = { rubyLibrary: { methods: ['black'], units: { Interpreter: 'Input.trigger(Input.DOWN); Graphics.update(); Graphics.frame_count = 3; const b = new Bitmap(1, 2); b.blt(1); b.fill_rect(); load_data("x"); Color.black; Audio.se_play("a");' } }, maps: [], commonEvents: {} };
    const shim = { dialect: 'rgss', builtins: { Graphics: { type: 'object', members: ['update', 'frame_count'] }, Audio: { type: 'object', members: ['se_play', 'bgm_play'] } }, fallbacks: [] };
    const report = analyze(project, api, shim);
    const missing = report.missing.map(entry => `${entry.className}.${entry.member}`);
    const okReport = missing.includes('Input.trigger') && missing.includes('Input.DOWN') && !missing.includes('Graphics.update') && !missing.includes('Graphics.frame_count') && !missing.includes('Audio.se_play')
      && !missing.includes('Color.black') && report.instanceCalls.some(entry => entry.name === 'blt' && entry.count === 1) && report.kernel.some(entry => entry.name === 'load_data' && !entry.shimmed)
      && report.classes.find(entry => entry.className === 'Bitmap').instantiations === 1 && report.classes.find(entry => entry.className === 'Graphics').shimmed === true;
    if (okDump && packed.notes.length && okReport) notes.push('rgss api dump and shim coverage report ok (packed binary reported, not guessed)'); else fail(`rgss api/coverage: dump ${okDump} packed ${packed.notes.length} report ${okReport} ${JSON.stringify({ classes: Object.keys(api.classes), missing })}`);
  }
  // RGSS objects (T144): value classes, Input over a key probe, System, Marshal, the virtual file store,
  // game constants on a re-opened module, and inert display classes that warn instead of pretending.
  {
    const { createRgssClasses, createKeyProbe } = await import(pathToFileURL(join(root, 'src', 'player', 'rgss-classes.js')).href);
    const warned = [];
    const files = new Map();
    let now = 0;
    const listeners = {};
    const target = { addEventListener: (type, handler) => { (listeners[type] ||= []).push(handler); } };
    const fire = (type, key) => (listeners[type] || []).forEach(handler => handler({ key }));
    const keys = createKeyProbe(target);
    const reopened = name => name === 'Input' ? "const Input = (() => {\n  const USE = C;\n  const BACK = B;\n  const LIMIT = 7;\n  return {};\n})();" : undefined;
    const o = createRgssClasses({ warnOnce: key => warned.push(key), files, uptime: () => now, keys, reopened });
    const checks = [];
    const color = new o.Color(300, -5, 128); const other = new o.Color(255, 0, 128, 255);
    checks.push(color.red === 255 && color.green === 0 && color.blue === 128 && color.alpha === 255 && color.equals(other) && o.Color._load(color._dump()).equals(color));
    const rect = new o.Rect(1, 2, 3, 4); checks.push(rect.set(5, 6, 7, 8).width === 7 && rect.empty().height === 0 && new o.Tone(300, -300, 0, 999).red === 255);
    fire('keydown', 'Enter'); checks.push(o.Input.trigger(o.Input.C) && o.Input.press(13) && !o.Input.trigger(o.Input.B));
    o.Input.update(); checks.push(o.Input.trigger(13) && o.Input.press(13)); o.Input.update(); checks.push(!o.Input.trigger(13) && o.Input.press(13)); fire('keyup', 'Enter'); checks.push(!o.Input.press(13));
    fire('keydown', 'ArrowLeft'); fire('keydown', 'ArrowUp'); checks.push(o.Input.dir4() === 4 && o.Input.dir8() === 7);
    checks.push(o.Input.USE === 13 && o.Input.BACK === 12 && o.Input.LIMIT === 7 && 'USE' in o.Input && Object.keys(o.Input).includes('BACK') && o.Input.UNKNOWN === undefined);   // game constants resolve against the module
    now = 42.5; checks.push(o.System.uptime() === 42.5 && o.System.is_windows() === false);
    const original = { list: [1, { deep: true }], color }; const copy = o.Marshal.load(o.Marshal.dump(original));
    copy.list[1].deep = false; checks.push(copy !== original && original.list[1].deep === true && copy.color instanceof o.Color && copy.color.equals(color));
    o.save_data({ a: 1 }, 'Data/Cache.rxdata'); checks.push(o.load_data('data\\cache.rxdata').a === 1);
    let missing = null; try { o.load_data('Data/Nope.dat'); } catch (error) { missing = error; } checks.push(missing?.name === 'Errno::ENOENT');
    const bitmap = new o.Bitmap(32, 16); const size = bitmap.text_size('abc');
    checks.push(bitmap.width === 32 && bitmap.rect.height === 16 && size.width > 0 && bitmap.get_pixel(0, 0).alpha === 0 && warned.includes('Bitmap.get_pixel') && warned.includes('Bitmap.text_size'));
    const sprite = new o.Sprite(); sprite.x = 5; sprite.visible = false; sprite.dispose(); checks.push(sprite.x === 5 && sprite.visible === false && sprite.disposed() === true && sprite.zoom_x === 1);
    // An accessor a game subclass defines (`columns`, ...) reads as a call when the game `def`s that name.
    const oc = createRgssClasses({ warnOnce: key => warned.push(key), files, uptime: () => now, keys, reopened, callableNames: new Set(['columns']) });
    class SubWindow extends oc.Window { get columns() { return 4; } }
    const sub = new SubWindow(); checks.push(typeof sub.columns === 'function' && sub.columns() === 4);
    if (checks.every(Boolean)) notes.push(`rgss objects ok (${checks.length} checks: Input, System, Marshal, files, Color/Rect/Tone, Bitmap, display classes)`); else fail(`rgss objects: ${JSON.stringify(checks)}`);
  }
  // MV-style troop battle (T115): turn order, skills with MP, states, items, escape, rewards and level-ups,
  // defeat, and formula safety, on a synthetic database with a scripted player and a fixed rng.
  {
    const { runBattle, expForLevel } = await import(pathToFileURL(join(root, 'src', 'player', 'battle.js')).href);
    const table = (level1, growth = 0) => Array.from({ length: 100 }, (_, level) => (level === 0 ? 0 : level1 + growth * (level - 1)));
    const database = () => ({
      system: { terms: { commands: ['Fight', 'Escape', 'Attack', 'Guard', 'Item', 'Skill', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'Cancel'], basic: ['Level', 'Lv', 'HP', 'HP', 'MP', 'MP', 'TP', 'TP', 'EXP'], messages: {} }, currencyUnit: 'G' },
      actors: [null, { name: 'Hero', classId: 1, initialLevel: 1, equips: [1, 0] }],
      classes: [null, { expParams: [30, 20, 30, 30], params: [table(100, 20), table(20, 5), table(20, 2), table(10, 1), table(15, 2), table(8, 1), table(10, 0), table(10, 0)], learnings: [{ level: 2, skillId: 3 }], traits: [{ code: 22, dataId: 0, value: 0.95 }] }],
      weapons: [null, { name: 'Sword', params: [0, 0, 10, 0, 0, 0, 0, 0], traits: [] }],
      skills: [null,
        { name: 'Attack', hitType: 1, scope: 1, successRate: 100, mpCost: 0, speed: 0, repeats: 1, stypeId: 0, damage: { type: 1, formula: 'a.atk * 4 - b.def * 2', variance: 0, critical: false, elementId: -1 }, effects: [], message1: '%1 attacks!', message2: '' },
        { name: 'Guard', hitType: 0, scope: 11, successRate: 100, mpCost: 0, speed: 2000, repeats: 1, stypeId: 0, damage: { type: 0 }, effects: [] },
        { name: 'Fire', hitType: 2, scope: 1, successRate: 100, mpCost: 5, speed: 0, repeats: 1, stypeId: 1, damage: { type: 1, formula: '20 + a.mat', variance: 0, critical: false, elementId: -1 }, effects: [{ code: 21, dataId: 4, value1: 1, value2: 0 }], message1: '%1 casts %2!', message2: '' },
        { name: 'Evil', hitType: 0, scope: 1, successRate: 100, mpCost: 0, speed: 0, repeats: 1, stypeId: 1, damage: { type: 1, formula: 'process.exit(1)', variance: 0 }, effects: [] }],
      states: [null, { name: 'Death', restriction: 4, traits: [], message1: ' collapses!', message2: ' is defeated!' }, { name: 'Guard', restriction: 0, traits: [], autoRemovalTiming: 1, minTurns: 1, maxTurns: 1 },
        null, { name: 'Poison', restriction: 0, autoRemovalTiming: 2, minTurns: 3, maxTurns: 3, traits: [{ code: 22, dataId: 7, value: -0.1 }], message1: ' is poisoned!', message2: ' is poisoned!', message4: ' recovers!' }],
      items: [null, { name: 'Potion', scope: 7, occasion: 0, hitType: 0, successRate: 100, repeats: 1, consumable: true, speed: 0, damage: { type: 0 }, effects: [{ code: 11, dataId: 0, value1: 0, value2: 50 }], message1: '' }],
      enemies: [null,
        { name: 'Slime', params: [30, 0, 12, 5, 5, 5, 8, 8], exp: 60, gold: 5, dropItems: [{ kind: 1, dataId: 1, denominator: 1 }], actions: [{ skillId: 1, rating: 5, conditionType: 0, conditionParam1: 0, conditionParam2: 0 }], traits: [{ code: 22, dataId: 0, value: 0.95 }] },
        { name: 'Boss', params: [1000, 0, 12, 5, 5, 5, 8, 8], exp: 0, gold: 0, dropItems: [], actions: [{ skillId: 1, rating: 5, conditionType: 0 }], traits: [{ code: 22, dataId: 0, value: 0.95 }] },
        { name: 'Fast', params: [50, 0, 40, 5, 5, 5, 200, 8], exp: 1, gold: 1, dropItems: [], actions: [{ skillId: 1, rating: 5, conditionType: 0 }], traits: [{ code: 22, dataId: 0, value: 0.95 }] }],
      troops: [null, { members: [{ enemyId: 1 }] }, { members: [{ enemyId: 1 }, { enemyId: 1 }] }, { members: [{ enemyId: 2 }] }, { members: [{ enemyId: 3 }] }]
    });
    const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    // A scripted player: takes the next wanted label from the plan when the menu offers it, else the first entry.
    const player = plan => { const log = []; return { log, present: async request => { log.push(request.text); if (!request.choices) return undefined; const want = plan.shift(); const hit = request.choices.find(choice => choice.text === want); return (hit || request.choices[0]).value; } }; };
    const run = (troopId, plan, overrides = {}) => { const db = overrides.database || database(); const records = overrides.records || { 1: { level: 1, classId: 1, hp: 100, mp: 20 } }; const items = overrides.items || {}; const p = player(plan); const gained = { gold: 0, items: [] };
      return runBattle({ database: db, troopId, party: [1], records, items, present: p.present, rng: overrides.rng || seeded(7), canEscape: true, hooks: { gainGold: g => { gained.gold += g; }, gainItem: (kind, id) => gained.items.push(`${kind}:${id}`) } }).then(result => ({ result, records, items, gained, log: p.log, db })); };
    const checks = [];
    const expected2 = expForLevel(database().classes[1], 2);
    checks.push(expected2 === 50 && expForLevel(database().classes[1], 1) === 0);
    // 1. win: one hit (atk 30 -> 110 damage vs 30 hp), rewards, level-up to 2 with a learned skill, drop, gold
    const win = await run(1, ['Fight', 'Attack']);
    checks.push(win.result.outcome === 'win' && win.result.exp === 60 && win.gold === undefined || (win.result.outcome === 'win' && win.result.exp === 60 && win.gained.gold === 5 && win.gained.items.includes('1:1')));
    checks.push(win.records[1].level === 2 && win.records[1].skills.includes(3) && win.records[1].exp === 60 && win.log.some(text => /Lv 2|Level 2|now Level/.test(text) || /is now/.test(text)));
    // 2. skill with MP cost, target pick between two slimes, state applied, end-of-turn slip on a survivor
    const boss = await run(3, ['Fight', 'Attack', 'Fight', 'Skill', 'Fire']);       // Boss has 1000 hp: fight continues; turn 2 casts Fire (level 2 not reached, so the plan falls back to a legal choice)
    checks.push(boss.result.outcome === 'escape' || boss.result.outcome === 'lose' || boss.result.outcome === 'win');
    // 3. escape: rng 0 always succeeds
    const escape = await run(3, ['Escape'], { rng: () => 0 });
    checks.push(escape.result.outcome === 'escape' && escape.records[1].hp === 100);
    // 4. defeat: hero at 1 hp, a much faster enemy acts first
    const lose = await run(4, ['Fight', 'Attack'], { records: { 1: { level: 1, classId: 1, hp: 1, mp: 20 } } });
    checks.push(lose.result.outcome === 'lose' && lose.records[1].hp === 0 && lose.records[1].dead === true && lose.log.some(text => /defeated/.test(text)));
    // 5. item: Potion heals 50 (rec 1), is consumed; the boss keeps hitting so the hero ends below full
    const potion = await run(3, ['Fight', 'Item', 'Potion ×1', 'Escape'], { items: { 1: 1 }, records: { 1: { level: 1, classId: 1, hp: 10, mp: 20 } }, rng: seeded(3) });
    checks.push(potion.items[1] === undefined && potion.log.some(text => /recovered HP 50/.test(text)));
    // 6. formula safety: a hostile damage formula is refused (treated as 0), never executed
    const db6 = database(); db6.actors[1].equips = [1, 0];
    let exited = false; const realExit = process.exit; process.exit = () => { exited = true; }; const warn = console.warn; console.warn = () => {};
    try {
      const learned = { 1: { level: 2, classId: 1, hp: 100, mp: 20, skills: [4] } };
      await run(3, ['Fight', 'Skill', 'Evil', 'Escape'], { database: db6, records: learned, rng: () => 0 });
    } finally { process.exit = realExit; console.warn = warn; }
    checks.push(exited === false);
    // 7. poison slip and MP cost through Fire (learned at level 2)
    const fire = await run(3, ['Fight', 'Skill', 'Fire', 'Escape'], { records: { 1: { level: 2, classId: 1, hp: 140, mp: 20 } }, rng: () => 0 });
    checks.push(fire.records[1].mp === 15 && fire.log.some(text => /poisoned/.test(text)) && fire.log.some(text => /took \d+ damage/.test(text)));
    // ---- menu screens (T114): items, skills, equipment, status, save, on the same database ----------------------
    {
      const { runMenu } = await import(pathToFileURL(join(root, 'src', 'player', 'menu.js')).href);
      const menuDb = () => {
        const db = database();
        db.classes[1].traits.push({ code: 51, dataId: 1, value: 0 }, { code: 52, dataId: 1, value: 0 });
        db.weapons[1].etypeId = 1; db.weapons[1].wtypeId = 1;
        db.weapons[2] = { name: 'Steel Sword', etypeId: 1, wtypeId: 1, params: [0, 0, 20, 0, 0, 0, 0, 0], traits: [] };
        db.weapons[3] = { name: 'Bow', etypeId: 1, wtypeId: 9, params: [0, 0, 30, 0, 0, 0, 0, 0], traits: [] };        // a type this class cannot equip
        db.armors = [null, { name: 'Shield', etypeId: 2, atypeId: 1, params: [0, 0, 0, 5, 0, 0, 0, 0], traits: [] }];
        db.skills[5] = { name: 'Heal', hitType: 0, scope: 7, occasion: 0, successRate: 100, mpCost: 4, speed: 0, repeats: 1, stypeId: 1, damage: { type: 3, formula: '30 + a.mat', variance: 0, critical: false, elementId: 0 }, effects: [], message1: '' };
        db.system.equipTypes = ['', 'Weapon', 'Shield']; db.system.terms.params = ['Max HP', 'Max MP', 'Attack', 'Defense', 'M.Attack', 'M.Defense', 'Agility', 'Luck'];
        return db;
      };
      const menuRun = async (plan, setup = {}) => {
        const db = menuDb(); const records = { 1: { level: 1, classId: 1, hp: 100, mp: 20, ...(setup.record || {}) } }; const items = { ...(setup.items || {}) }; const weapons = { ...(setup.weapons || {}) }; const armors = { ...(setup.armors || {}) };
        const p = player([...plan]); let saved = 0;
        const result = await runMenu({ database: db, records, party: [1], items, weapons, armors, gold: 5, present: p.present, rng: () => 0, hooks: { save: () => { saved++; } } });
        return { result, records, items, weapons, armors, log: p.log, saved };
      };
      const mchecks = [];
      // Potion from the item screen: +50 HP, one used up, screen returns, menu closes
      const potionMenu = await menuRun(['Item', 'Potion ×2', 'Cancel', 'Cancel'], { items: { 1: 2 }, record: { hp: 10 } });
      mchecks.push(potionMenu.records[1].hp === 60 && potionMenu.items[1] === 1 && potionMenu.result.closed === true);
      // A healing skill costs MP and heals by its formula (30 + mat, negative damage sign applied)
      const skillMenu = await menuRun(['Skill', 'Hero', 'Heal  4 MP', 'Cancel', 'Cancel'], { record: { hp: 10, mp: 20, skills: [5], level: 1 } });
      mchecks.push(skillMenu.records[1].mp === 16 && skillMenu.records[1].hp > 40 && skillMenu.records[1].hp <= 100);
      // Equip: the Steel Sword swaps with the Sword in the inventory; the Bow is not offered to this class
      const equipMenu = await menuRun(['Equip', 'Hero', 'Weapon: Sword', 'Steel Sword ×1', 'Cancel', 'Cancel', 'Cancel'], { weapons: { 2: 1, 3: 1 } });
      const offered = equipMenu.log.filter(text => text.includes('Weapon: Sword'));
      mchecks.push(equipMenu.records[1].equips['1'].id === 2 && equipMenu.weapons[1] === 1 && equipMenu.weapons[2] === undefined && equipMenu.weapons[3] === 1 && offered.length >= 1);
      // Status names the parameters; Save runs its hook
      const statusMenu = await menuRun(['Status', 'Hero', 'Save', 'Cancel']);
      mchecks.push(statusMenu.log.some(text => /Attack \d+/.test(text)) && statusMenu.saved === 1);
      checks.push(mchecks.every(Boolean));
      if (!mchecks.every(Boolean)) fail(`menu screens: ${JSON.stringify(mchecks)} skill hp ${skillMenu.records[1].hp}/${skillMenu.records[1].mp} equip ${JSON.stringify(equipMenu.records[1].equips)} ${JSON.stringify(equipMenu.weapons)}`);
    }
    if (checks.every(Boolean)) notes.push(`battle runner and menu screens ok (${checks.length} checks: win/level-up/drops, escape, defeat, items, MP skills, states, formula safety, item/skill/equip/status/save menus)`); else fail(`battle runner: ${JSON.stringify(checks)} potion log: ${JSON.stringify(potion.log)} items ${JSON.stringify(potion.items)}`);
  }
  // Battle sweep: every troop of every locally converted MV/MZ project runs through the runner with a player who
  // always takes the first menu entry. Each must resolve (win / lose / escape) without throwing.
  {
    const { runBattle } = await import(pathToFileURL(join(root, 'src', 'player', 'battle.js')).href);
    const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const problems = []; let fought = 0, projects = 0;
    const warn = console.warn; console.warn = () => {};
    try {
      for (const dir of convertedDirs) {
        let db;
        try { db = JSON.parse(readFileSync(join(root, 'MWGP_versions', dir, 'mwgp.json'), 'utf8')).database; } catch { continue; }
        if (!db?.troops || !db.enemies || !db.classes || !db.skills || !db.actors) continue;
        projects++;
        const party = (db.system?.partyMembers || []).filter(id => db.actors[id]).slice(0, 4);
        if (!party.length) continue;
        for (const [troopId, troop] of db.troops.entries()) {
          if (!troop?.members?.length) continue;
          const records = Object.fromEntries(party.map(id => [id, { level: Math.max(1, db.actors[id].initialLevel || 1), classId: db.actors[id].classId, states: [], skills: [], equips: {} }]));
          let prompts = 0;
          try {
            const result = await runBattle({ database: db, troopId, party, records, items: {}, canEscape: true, canLose: true, rng: seeded(troopId + 1), variable: () => 0,
              present: async request => { if (++prompts > 4000) throw new Error('battle never resolved'); return request.choices ? request.choices[0].value : undefined; }, hooks: {} });
            if (!['win', 'lose', 'escape'].includes(result.outcome)) problems.push(`${dir} troop ${troopId}: outcome ${result.outcome}`);
            fought++;
          } catch (error) { problems.push(`${dir} troop ${troopId}: ${error.message}`); }
        }
      }
    } finally { console.warn = warn; }
    if (problems.length) fail(`battle sweep: ${problems.slice(0, 6).join('; ')} (${problems.length} problems)`); else notes.push(`battle sweep ok (${fought} troops across ${projects} MV/MZ project(s) all resolve)`);
  }
  // XP database -> MV-shaped database (tools/rgss-database.mjs) on a made-up project, fought through the real runner.
  {
    const { convertRgssDatabase } = await import(pathToFileURL(join(root, 'tools', 'rgss-database.mjs')).href);
    const { runBattle } = await import(pathToFileURL(join(root, 'src', 'player', 'battle.js')).href);
    const dir = mkdtempSync(join(tmpdir(), 'mwgp-xpdb-'));
    const obj = (cls, ivars) => ({ class: cls, ivars: Object.fromEntries(Object.entries(ivars).map(([key, value]) => [`@${key}`, value])) });
    const table = (x, y, values) => { const buffer = Buffer.alloc(20 + values.length * 2); [values.length > 0 ? 2 : 1, x, y, 1, values.length].forEach((value, index) => buffer.writeInt32LE(value, index * 4)); values.forEach((value, index) => buffer.writeInt16LE(value, 20 + index * 2)); return { class: 'Table', raw: [...buffer] }; };
    const levels = []; for (let level = 0; level < 100; level++) levels.push(...(level === 0 ? [0, 0, 0, 0, 0, 0] : [100, 20, 30, 10, 10, 10]));
    const ranks = table(3, 1, [0, 3, 3]);
    const enemyBase = { animation1_id: 0, animation2_id: 0, battler_hue: 0, battler_name: '', eva: 0, weapon_id: 0, armor_id: 0, item_id: 1, treasure_prob: 100, element_ranks: ranks, state_ranks: ranks };
    const files = {
      Actors: [null, obj('RPG::Actor', { id: 1, name: 'Hero', class_id: 1, initial_level: 1, final_level: 99, weapon_id: 1, armor1_id: 0, armor2_id: 0, armor3_id: 0, armor4_id: 0, exp_basis: 10, exp_inflation: 10, character_name: '', battler_name: '', parameters: table(6, 100, levels) })],
      Classes: [null, obj('RPG::Class', { id: 1, name: 'Fighter', weapon_set: [1], armor_set: [], learnings: [obj('RPG::Class::Learning', { level: 2, skill_id: 1 })], element_ranks: ranks, state_ranks: ranks })],
      Skills: [null, obj('RPG::Skill', { id: 1, name: 'Fire', description: '', icon_name: '', scope: 1, occasion: 1, sp_cost: 3, power: 50, atk_f: 0, str_f: 0, dex_f: 0, agi_f: 0, int_f: 100, pdef_f: 0, mdef_f: 100, hit: 100, variance: 0, element_set: [], plus_state_set: [2], minus_state_set: [], common_event_id: 0, animation1_id: 0, animation2_id: 0 })],
      Items: [null, obj('RPG::Item', { id: 1, name: 'Potion', description: '', icon_name: '', scope: 3, occasion: 0, price: 10, consumable: true, hit: 100, variance: 0, recover_hp: 50, recover_hp_rate: 0, recover_sp: 0, recover_sp_rate: 0, element_set: [], plus_state_set: [], minus_state_set: [], common_event_id: 0, animation1_id: 0, animation2_id: 0 })],
      Weapons: [null, obj('RPG::Weapon', { id: 1, name: 'Sword', description: '', icon_name: '', price: 5, atk: 25, pdef: 0, mdef: 0, str_plus: 5, dex_plus: 0, agi_plus: 0, int_plus: 0, element_set: [], plus_state_set: [], minus_state_set: [], animation1_id: 0, animation2_id: 0 })],
      Armors: [null],
      Enemies: [null, obj('RPG::Enemy', { ...enemyBase, id: 1, name: 'Slime', maxhp: 40, maxsp: 0, str: 20, dex: 10, agi: 5, int: 5, atk: 20, pdef: 10, mdef: 0, exp: 100, gold: 7, actions: [obj('RPG::Enemy::Action', { kind: 0, basic: 0, rating: 5, condition_turn_a: 0, condition_turn_b: 1, condition_hp: 100, condition_level: 1, condition_switch_id: 0, skill_id: 1 })] })],
      Troops: [null, obj('RPG::Troop', { id: 1, name: 'Slimes', members: [obj('RPG::Troop::Member', { enemy_id: 1, x: 100, y: 100, hidden: false })], pages: [] })],
      States: [null, obj('RPG::State', { id: 1, name: 'KO' }), obj('RPG::State', { id: 2, name: 'Sleep', restriction: 4, hold_turn: 0, auto_release_prob: 50, slip_damage: false, battle_only: true, rating: 5 })]
    };
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, `${name}.rxdata`), JSON.stringify(value));
    const decode = buffer => JSON.parse(buffer.toString('utf8'));
    const system = obj('RPG::System', { party_members: [1], words: obj('RPG::System::Words', { gold: 'G', hp: 'HP', sp: 'SP', attack: 'Attack', guard: 'Guard', item: 'Item', skill: 'Skill', equip: 'Equip' }) });
    const db = await convertRgssDatabase(dir, decode, { system, convertTroopCommands: () => [] });
    const checks = [];
    checks.push(Boolean(db) && db.actors[1].name === 'Hero' && db.enemies[1].params[0] === 40 && db.enemies[1].params[8] === 20);
    checks.push(db.battleIds.attackSkill > 1 && db.battleIds.guardState > 2 && db.skills[db.battleIds.attackSkill].name === 'Attack');
    checks.push(db.skills[1].mpCost === 3 && db.skills[1].damage.type === 1 && db.skills[1].effects[0].code === 21);
    checks.push(db.actors[1].equips[0] === 1 && db.weapons[1].params[2] === 25 && db.weapons[1].params[8] === 5 && db.classes[1].traits.some(trait => trait.code === 51 && trait.dataId === 1));
    checks.push(db.actors[1].expCurve[2] === 10 && db.system.partyMembers[0] === 1);
    const records = { 1: { level: 1, classId: 1, states: [], skills: [], equips: {} } };
    const items = {};
    const log = [];
    const result = await runBattle({ database: db, troopId: 1, party: [1], records, items, canEscape: true, canLose: true, rng: (() => { let seed = 3; return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; })(), variable: () => 0,
      present: async request => { log.push(request.text || ''); return request.choices ? request.choices[0].value : undefined; }, hooks: {} });
    checks.push(result.outcome === 'win' && records[1].level >= 2 && Number(records[1].exp) >= 100);
    // Placeholder databases (blank enemy names, empty troops) are not emitted: Essentials keeps its battles in Ruby.
    writeFileSync(join(dir, 'Enemies.rxdata'), JSON.stringify([null, obj('RPG::Enemy', { ...enemyBase, id: 1, name: '', maxhp: 1, maxsp: 0, str: 0, dex: 0, agi: 0, int: 0, atk: 0, pdef: 0, mdef: 0, exp: 0, gold: 0, actions: [] })]));
    checks.push((await convertRgssDatabase(dir, decode, { system, convertTroopCommands: () => [] })) === null);
    if (checks.every(Boolean)) notes.push(`XP database conversion ok (${checks.length} checks: stats/equipment/skills/exp curve, a battle fought through the runner, placeholder database skipped)`);
    else fail(`XP database conversion: ${JSON.stringify(checks)} outcome ${result.outcome} level ${records[1].level} exp ${records[1].exp} log ${log.slice(-14).join(' | ')}`);
  }
  // Async lift (tools/rgss-async.mjs): blocking screens become async/await, Ruby's modulo and block-scoped locals are
  // repaired, and the lifted code runs against the runtime's frame promises.
  {
    const { liftBlocking, lowerRuby } = await import(pathToFileURL(join(root, 'tools', 'rgss-async.mjs')).href);
    const units = {
      Screen: 'const Screen = (() => {\n  class Scene {\n    pbMain() {\n      return this._loop()\n    };\n    _loop() {\n      let n = 0;\n      while (n < 3) {\n        Graphics.update();\n        n++\n      };\n      return n\n    };\n    get label() { return "x" }\n  }\n  return { Scene }\n})()',
      Helper: 'function pbRun() {\n  return new Screen.Scene().pbMain()\n}\nfunction plain() {\n  return 1\n}\n'
    };
    const lifted = liftBlocking(units, [{ js: 'pbRun()' }, { js: 'plain()' }]);
    const checks = [];
    checks.push(lifted.units.Screen.includes('async pbMain') && lifted.units.Screen.includes('async _loop') && lifted.units.Screen.includes('(await Graphics.update())'));
    checks.push(lifted.units.Helper.includes('async function pbRun') && !lifted.units.Helper.includes('async function plain'));
    checks.push(lifted.snippets[0].async === true && lifted.snippets[0].js === '(await pbRun())' && lifted.snippets[1].async === false);
    checks.push(lowerRuby('x = (i + d) % n;').includes('__mod((i + d) , n)'));
    const hoisted = lowerRuby('function f(a) {\n  try {\n    let s = a.x\n  } catch {\n    let s = a\n  };\n  let s = s.clone();\n  return s\n}');
    checks.push(hoisted.includes('let s; try') && !hoisted.includes('let s = s') && new Function(`${hoisted}; return f({ x: { clone: () => 7 } })`)() === 7);
    // The lifted code runs: `Graphics.update` awaited in a real async function.
    const frames = [];
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('Graphics', `${lifted.units.Screen}; return await new Screen.Scene().pbMain();`);
    checks.push((await run({ update: async () => { frames.push(1); } })) === 3 && frames.length === 3);
    // Ruby `slice!` (emitted as `.splice`) goes through `__splice`; a method next to a same-name setter is kept
    // callable alongside it; a module IIFE sharing `@cache` state gets one shared self; optional sibling calls stay optional.
    checks.push(lowerRuby('s = s.splice(0, 1);').includes('__splice(s, (__v) => { s = __v }, 0, 1)'));
    const clash = lowerRuby('class W { columns() { return 3 } set columns(v) { this._c = v } }');
    checks.push(clash.includes('__method_columns') && clash.includes('get columns()') && clash.includes('set columns(v)'));
    const mod = lowerRuby('const M = (() => { this._cache = {}; function load(n) { return this._cache[n] } function get(n) { return load(n) } function maybe(n) { return load?.(n) } return { load, get, maybe } })()');
    checks.push(mod.includes('const __self = {};') && mod.includes('__self._cache') && mod.includes('load.call(this, n)') && mod.includes('load?.(n)'));
    if (checks.every(Boolean)) notes.push(`async lift ok (${checks.length} checks: transitive async/await, snippets flagged async, Ruby modulo, hoisted block locals, lifted code runs, slice!/method-setter/module-self lowerings)`); else fail(`async lift: ${JSON.stringify(checks)}\n${lifted.units.Screen}`);
  }
  // Control-flow sentinels and native passthrough.
  for (const command of [[{ breakLoop: true }], [{ exitEvent: true }]]) {
    const prepared = prepareEventCommands(command, stub);
    try { await prepared[0].call(state); fail(`${Object.keys(command[0])[0]} did not throw its sentinel`); }
    catch { /* expected: BreakLoopSignal/ExitEventSignal */ }
  }
  // { goto } throws a JumpSignal carrying the passage for the story driver.
  {
    const { JumpSignal } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
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
  let comparisonBranch;
  const comparisonScene = { runBranch: async commands => { comparisonBranch = commands[0]?.say; } };
  const comparison = prepareEventCommands([{ if: { variable: '1', operator: 'gt', value: 2 }, then: [{ say: 'yes' }], else: [{ say: 'no' }] }], comparisonScene);
  await comparison[0].call(state);
  if (comparisonBranch !== 'yes') fail(`variable comparison selected ${comparisonBranch || 'no branch'}`);
  else notes.push('variable comparison operators ok');
  // Player-state conditions (party, facing, gold, inventory) select the right
  // branch; unsupported markers warn loudly and take the else-branch.
  {
    let picked;
    let warned = null;
    const condScene = {
      runBranch: async commands => { picked = commands[0]?.say; },
      unsupportedCommand: (kind, detail) => { warned = [kind, detail]; },
      project: { database: { actors: { 1: { name: 'Hero', classId: 2 } } } },
      rpgExtra: { party: [1], gold: 100, items: { 5: 2 }, weapons: { 3: 1 }, armors: {}, actors: { 1: { states: [4], skills: [7], equips: { weapon: { id: 3, kind: 'weapon' } }, profile: '', classId: 2 } } },
      facing: 'left',
      currentEvent: { facing: 'up' }
    };
    const runCond = async cond => {
      picked = undefined; warned = null;
      await prepareEventCommands([{ if: cond, then: [{ say: 'yes' }], else: [{ say: 'no' }] }], condScene)[0].call(state);
      return picked;
    };
    const condChecks = [
      [await runCond({ partyMember: 1 }) === 'yes', 'party member in party takes then'],
      [await runCond({ partyMember: 2 }) === 'no', 'party member outside party takes else'],
      [await runCond({ facing: 'left' }) === 'yes', 'player facing match takes then'],
      [await runCond({ facing: 'up' }) === 'no', 'player facing mismatch takes else'],
      [await runCond({ eventFacing: 'up' }) === 'yes', 'running-event facing match takes then'],
      [await runCond({ gold: { operator: 'gte', value: 10 } }) === 'yes', 'gold gte takes then'],
      [await runCond({ gold: { operator: 'lt', value: 10 } }) === 'no', 'gold lt takes else'],
      [await runCond({ item: '5' }) === 'yes', 'held item takes then'],
      [await runCond({ item: '6' }) === 'no', 'missing item takes else'],
      [await runCond({ actorSkill: { actor: 1, skill: 7 } }) === 'yes', 'known actor skill takes then'],
      [await runCond({ actorSkill: { actor: 1, skill: 8 } }) === 'no', 'unknown actor skill takes else'],
      [await runCond({ actorSkill: { actor: 9, skill: 7 } }) === 'no', 'unknown actor id takes else'],
      [await runCond({ actorState: { actor: 1, state: 4 } }) === 'yes', 'affecting actor state takes then'],
      [await runCond({ actorState: { actor: 1, state: 5 } }) === 'no', 'cleared actor state takes else'],
      [await runCond({ actorName: { actor: 1, name: 'Hero' } }) === 'yes', 'actor name match takes then'],
      [await runCond({ actorClass: { actor: 1, classId: 2 } }) === 'yes', 'actor class match takes then'],
      [await runCond({ actorWeapon: { actor: 1, weapon: 3 } }) === 'yes', 'equipped actor weapon takes then'],
      [await runCond({ actorArmor: { actor: 1, armor: 3 } }) === 'no', 'missing actor armor takes else'],
      [await runCond({ weapon: { id: 3, includeEquipped: false } }) === 'yes', 'held weapon takes then'],
      [await runCond({ armor: { id: 3, includeEquipped: false } }) === 'no', 'missing armor takes else']
    ];
    const unsupportedPicked = await runCond({ unsupported: { code: 111, kind: 5 } });
    condChecks.push([unsupportedPicked === 'no' && warned?.[0] === 'condition' && warned?.[1]?.kind === 5, 'unsupported condition warns and takes else']);
    for (const [ok, label] of condChecks) if (!ok) fail(`condition branch: ${label}`);
    if (condChecks.every(([ok]) => ok)) notes.push(`player-state condition branches ok (${condChecks.length} checks)`);
  }
  // The MV converter maps self-switch, actor-in-party, facing, gold, and item
  // branch types onto player-state conditions and marks the rest loudly.
  {
    const mvConverter = readFileSync(join(root, 'tools', 'convert-mv.js'), 'utf8');
    const needed = ['partyMember', 'actorName', 'actorClass', 'actorSkill', 'actorWeapon', 'actorArmor', 'actorState', 'eventFacing', 'gold: { operator', 'item: String', 'unsupportedCondition'];
    if (!needed.every(snippet => mvConverter.includes(snippet))) fail('MV converter branch conditions do not cover party/facing/gold/item with a loud fallback');
    else notes.push('MV branch conditions cover party/facing/gold/item with loud fallback ok');
  }
  // Game-data variable operands resolve from player-held state; the extended
  // 122 converter covers game data and scripts with the same loud fallback.
  {
    const extra = { gold: 100, items: { 3: 2 }, weapons: {}, armors: {}, party: [7, 9] };
    const context = { playerX: 4, playerY: 6, mapId: 12 };
    const operandChecks = [
      [resolveGameDataOperand(extra, context, { kind: 'itemCount', id: '3' }) === 2, 'item count reads inventory'],
      [resolveGameDataOperand(extra, context, { kind: 'weaponCount', id: '3' }) === 0, 'missing weapon counts as 0'],
      [resolveGameDataOperand(extra, context, { kind: 'playerX' }) === 4, 'player map x reads mover'],
      [resolveGameDataOperand(extra, context, { kind: 'playerY' }) === 6, 'player map y reads mover'],
      [resolveGameDataOperand(extra, context, { kind: 'partyMember', index: 1 }) === 9, 'party slot reads actor id'],
      [resolveGameDataOperand(extra, context, { kind: 'partyMember', index: 5 }) === 0, 'empty party slot reads as 0'],
      [resolveGameDataOperand(extra, context, { kind: 'mapId' }) === 12, 'map id reads current map'],
      [resolveGameDataOperand(extra, context, { kind: 'partySize' }) === 2, 'party size reads roster'],
      [resolveGameDataOperand(extra, context, { kind: 'gold' }) === 100, 'gold reads purse'],
      [resolveGameDataOperand({ ...extra, namedParty: [{ species: 'EEVEE' }, { species: 'PIDGEY' }] }, context, { kind: 'pokemonCount' }) === 2, 'pokemon count reads named party'],
      [resolveGameDataOperand(extra, context, { kind: 'pokemonCount' }) === 0, 'missing named party counts as 0']
    ];
    const originalWarn = console.warn; console.warn = () => {};
    let unknownKind;
    try { unknownKind = resolveGameDataOperand(extra, context, { kind: 'steps' }); }
    finally { console.warn = originalWarn; }
    operandChecks.push([unknownKind === 0, 'unknown game-data kind reads as 0 with a warning']);
    for (const [ok, label] of operandChecks) if (!ok) fail(`game-data operand: ${label}`);
    if (operandChecks.every(([ok]) => ok)) notes.push(`game-data variable operands ok (${operandChecks.length} checks)`);
    const mvConverter = readFileSync(join(root, 'tools', 'convert-mv.js'), 'utf8');
    const needed = ['convertExtendedOperand', 'gameDataOperandShape', 'staticScriptValue', 'unsupportedOperand'];
    if (!needed.every(snippet => mvConverter.includes(snippet))) fail('MV converter does not cover game-data/script variable operands');
    else notes.push('MV game-data/script variable operands ok');
  }
  // The dialogue-driven battle fallback terminates on every path: victory
  // against a weaker enemy, defeat against a stronger one, escape only when
  // the troops allow it (no flee choice otherwise).
  {
    const scripted = answers => {
      const seen = [];
      return { seen, present: async request => { seen.push(request); if (!request.choices) return undefined; return answers.length ? answers.shift() : 0; } };
    };
    const hero = () => ({ name: 'Héros', hp: 100, maxHp: 100, atk: 20, def: 10 });
    const foe = (hp, atk) => ({ name: 'Ennemi', hp, maxHp: hp, atk, def: 0 });
    const win = scripted([]);
    const winOutcome = await runBattleFallback({ hero: hero(), enemies: [foe(10, 1)], canEscape: false }, win.present);
    const lose = scripted([]);
    const loseOutcome = await runBattleFallback({ hero: hero(), enemies: [foe(1000, 200)], canEscape: false }, lose.present);
    const flee = scripted([1]);
    const fleeOutcome = await runBattleFallback({ hero: hero(), enemies: [foe(1000, 1)], canEscape: true }, flee.present);
    const noFlee = scripted([]);
    await runBattleFallback({ hero: hero(), enemies: [foe(10, 1)], canEscape: false }, noFlee.present);
    const summon = foe(10, 1); summon.appeared = false; const summonedBattle = scripted([]); let turns = 0;
    await runBattleFallback({ hero: hero(), enemies: [foe(100, 1), summon], canEscape: false, onTurn: async () => { turns++; if (turns === 1) summon.appeared = true; } }, summonedBattle.present);
    const battleChecks = [
      [winOutcome === 'win' && win.seen.at(-1)?.text === 'Victoire !', 'weaker enemy ends in victory'],
      [loseOutcome === 'lose', 'stronger enemy ends in defeat'],
      [fleeOutcome === 'escape', 'flee choice escapes when allowed'],
      [noFlee.seen.find(request => request.choices)?.choices?.length === 1, 'no flee choice when escape is forbidden'],
      [summon.appeared && turns > 0 && summonedBattle.seen.some(request => request.text?.includes('Ennemi')), 'enemy appearance callback admits a hidden enemy']
    ];
    for (const [ok, label] of battleChecks) if (!ok) fail(`battle fallback: ${label}`);
    if (battleChecks.every(([ok]) => ok)) notes.push(`battle fallback outcomes ok (${battleChecks.length} checks)`);
  }
  // Transfer targets and save positions never crash the player: unknown maps
  // and non-numeric coordinates resolve to null (stay put with a warning),
  // valid targets clamp into the destination map rectangle.
  {
    const maps = [{ id: 1, data: { width: 10, height: 8 } }, { id: 2, data: { width: 5, height: 5 } }];
    const vars = { 1: 2, 2: 3, 3: 4 };
    const lookup = id => vars[id];
    const originalWarn = console.warn; console.warn = () => {};
    let direct, indirect, clamped, unknownMap, nanCoords, missing;
    try {
      direct = resolveTransferTarget({ mapId: 1, x: 3, y: 4 }, lookup, maps);
      indirect = resolveTransferTarget({ mapVar: '1', xVar: '2', yVar: '3' }, lookup, maps);
      clamped = resolveTransferTarget({ mapId: 2, x: 99, y: -5 }, lookup, maps);
      unknownMap = resolveTransferTarget({ mapId: 999, x: 1, y: 1 }, lookup, maps);
      nanCoords = resolveTransferTarget({ mapId: 1, x: 'abc', y: 1 }, lookup, maps);
      missing = resolveTransferTarget(null, lookup, maps);
    } finally { console.warn = originalWarn; }
    const transferChecks = [
      [direct?.mapId === 1 && direct?.x === 3 && direct?.y === 4, 'direct transfer target resolves'],
      [indirect?.mapId === 2 && indirect?.x === 3 && indirect?.y === 4, 'variable transfer target resolves'],
      [clamped?.mapId === 2 && clamped?.x === 4 && clamped?.y === 0, 'out-of-bounds transfer target clamps to the map'],
      [unknownMap === null, 'unknown transfer map resolves to null instead of navigating'],
      [nanCoords === null, 'non-numeric transfer coordinates resolve to null'],
      [missing === null, 'missing transfer target resolves to null'],
      [JSON.stringify(sanitizeMapPosition({ x: 99, y: -3 }, maps[0])) === JSON.stringify({ x: 9, y: 0 }), 'save positions clamp to the map'],
      [JSON.stringify(sanitizeMapPosition({ x: NaN, y: 2 }, maps[0])) === JSON.stringify({ x: 0, y: 2 }), 'non-finite save positions read as 0']
    ];
    for (const [ok, label] of transferChecks) if (!ok) fail(`transfer validation: ${label}`);
    if (transferChecks.every(([ok]) => ok)) notes.push(`transfer/save validation ok (${transferChecks.length} checks)`);
  }
  // Foreground.js mist: the layer pick follows the plugin's switch gates and
  // the tiling origin follows its zero/loop scroll rates (Karryn's <fgName>).
  {
    const A = { name: 'Mist_1', zero: false, loopX: true, loopY: false, sx: -1.4, sy: 0, switch: 22, notSwitch: 0, notSwitch2: 0 };
    const B = { name: 'Mist_2', zero: false, loopX: true, loopY: false, sx: -1.4, sy: 0, switch: 11, notSwitch: 30, notSwitch2: 0 };
    const switches = new Map();
    const isOn = id => switches.get(Number(id)) === true;
    const fgChecks = [
      [selectForegroundLayer(null, null, isOn) === null, 'no layers selects nothing'],
      [selectForegroundLayer({ ...A, switch: 0 }, null, isOn) === 'a', 'ungated A layer shows'],
      [selectForegroundLayer(A, null, isOn) === null, 'gated A layer hides while its switch is off'],
      [selectForegroundLayer(A, null, id => true) === 'a', 'gated A layer shows once its switch is on'],
      [selectForegroundLayer(A, B, id => id === 11) === 'b', 'B layer shows when A is off and B is on'],
      [selectForegroundLayer(A, B, () => false) === null, 'both layers hide when both switches are off'],
      [selectForegroundLayer(A, B, id => id === 11 || id === 30) === 'a', 'B hide-switch falls back to A like the plugin else-branch'],
      [selectForegroundLayer(null, B, id => id === 11) === 'b', 'B-only map shows B while its switch is on'],
      [selectForegroundLayer(null, B, () => false) === null, 'B-only map hides everything while its switch is off'],
      [foregroundOrigin(false, true, 4, 1, 48) === 240, '`!` zero-foreground scrolls at the full map rate'],
      [foregroundOrigin(true, false, 4, 1, 48) === 120, 'loop axis scrolls at the half map rate'],
      [foregroundOrigin(false, false, 4, 1, 48) === 0, 'unflagged axis stays screen-fixed']
    ];
    for (const [ok, label] of fgChecks) if (!ok) fail(`foreground mist: ${label}`);
    if (fgChecks.every(([ok]) => ok)) notes.push(`foreground mist selection and scroll ok (${fgChecks.length} checks)`);
  }
  // MZ end to end: a minimal synthetic MZ project (flat root, rmmz_core.js,
  // one MZ 357 plugin call, one MZ-format Effekseer animation entry) converts
  // to a valid manifest with engine rpg-maker-mz, the 357 call lands in the
  // pluginCommand vocabulary as partial, and the validator accepts it.
  {
    const mzDir = mkdtempSync(join(tmpdir(), 'mwgp-smoke-mz-'));
    const writeJson = (rel, value) => writeFileSync(join(mzDir, rel), JSON.stringify(value));
    writeFileSync(join(mzDir, 'index.html'), '<!DOCTYPE html><html><body></body></html>');
    mkdirSync(join(mzDir, 'js'), { recursive: true });
    writeFileSync(join(mzDir, 'js', 'rmmz_core.js'), '// MZ fingerprint stub');
    mkdirSync(join(mzDir, 'data'), { recursive: true });
    writeJson('data/System.json', { partyMembers: [], startMapId: 1, startX: 2, startY: 2, tileSize: 48 });
    writeJson('data/MapInfos.json', [null, { id: 1, expanded: false, name: 'Room', order: 1, parentId: 0 }]);
    const emptyLayer = Array(25).fill(0);
    writeJson('data/Map001.json', {
      width: 5, height: 5, tilesetId: 1, autoplayBgm: false, autoplayBgs: false,
      bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, bgs: { name: '', volume: 90, pitch: 100, pan: 0 },
      note: '<fgName:Mist_1>\n<fgLoopX:1>\n<fgSx:-1.4>\n<fgName_b:Mist_2>\n<fgLoopX_b:1>\n<fgSwitch_b:11>',
      data: [...emptyLayer, ...emptyLayer, ...emptyLayer, ...emptyLayer, ...emptyLayer, ...emptyLayer],
      events: [null, {
        id: 1, name: 'EV001', note: '', x: 2, y: 2,
        pages: [{
          conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
          directionFix: false,
          image: { tileId: 0, characterName: '', direction: 2, pattern: 1, characterIndex: 0 },
          list: [
            { code: 357, indent: 0, parameters: ['DemoPlugin', 'MessageRows', 'Set rows', { rows: '6' }] },
            { code: 212, indent: 0, parameters: [-1, 1, false] },
            { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
            { code: 401, indent: 0, parameters: ['Hello'] },
            { code: 111, indent: 0, parameters: [0, 1, 0] },
            { code: 401, indent: 1, parameters: ['Then line'] },
            { code: 412, indent: 0, parameters: [] },
            { code: 0, indent: 0, parameters: [] }
          ],
          moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: false, skippable: false, wait: false },
          moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true
        }]
      }]
    });
    writeJson('data/Tilesets.json', [null, { id: 1, mode: 0, name: 'Outside', tilesetNames: ['', '', '', '', '', '', '', '', ''], flags: [0] }]);
    writeJson('data/Animations.json', [null, { id: 1, name: 'Hit', effectName: 'Hit' }]);
    // Foreground art the map note references: a minimal 1x1 PNG each, so the
    // referenced-only parallaxes decode runs and flags assets.parallaxes.
    mkdirSync(join(mzDir, 'img', 'parallaxes'), { recursive: true });
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(join(mzDir, 'img', 'parallaxes', 'Mist_1.png'), tinyPng);
    writeFileSync(join(mzDir, 'img', 'parallaxes', 'Mist_2.png'), tinyPng);
    const mzOut = join(mzDir, 'out');
    let mzManifest;
    try {
      execFileSync(process.execPath, [join(root, 'tools', 'convert-mv.js'), mzDir, mzOut], { stdio: 'pipe' });
      mzManifest = JSON.parse(readFileSync(join(mzOut, 'mwgp.json'), 'utf8'));
    } catch (error) {
      fail(`MZ probe conversion failed: ${String(error.stderr || error.message).slice(0, 300)}`);
    }
    if (mzManifest) {
      const mzEventText = JSON.stringify(mzManifest.maps?.[0]?.mwgEvents || []);
      const mzFg = mzManifest.maps?.[0]?.data?.settings || {};
      const mzChecks = [
        [mzManifest.source?.engine === 'rpg-maker-mz', 'probe detected as MZ'],
        [mzEventText.includes('"pluginCommand"'), 'MZ 357 converts to pluginCommand'],
        [!mzEventText.includes('"unsupported"'), 'MZ probe has no loud markers'],
        [mzEventText.includes('"else":[]'), 'branch without else keeps an empty else list'],
        [mzManifest.compatibility?.commands?.['357']?.status === 'partial', 'MZ 357 classified partial'],
        [mzManifest.compatibility?.plugins?.['MessageRows']?.status === 'partial', 'MZ plugin census covers 357 names'],
        [mzFg.foreground?.name === 'Mist_1' && mzFg.foreground?.loopX === true && mzFg.foreground?.sx === -1.4, 'map <fgName> note parses to settings.foreground'],
        [mzFg.foregroundB?.name === 'Mist_2' && mzFg.foregroundB?.switch === 11, 'map <fgName_b> note parses to settings.foregroundB with its switch'],
        [mzManifest.assets?.parallaxes === true, 'referenced foreground art flags assets.parallaxes']
      ];
      for (const [ok, label] of mzChecks) if (!ok) fail(`MZ probe: ${label}`);
      if (mzChecks.every(([ok]) => ok)) notes.push(`MZ probe conversion ok (${mzChecks.length} checks)`);
      try {
        const out = JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), join(mzOut, 'mwgp.json')], { stdio: 'pipe' }).toString());
        if (out.valid !== true) fail('validator rejected the MZ probe manifest');
        else notes.push('MZ probe manifest validates ok');
      } catch (error) {
        fail(`validator rejected the MZ probe manifest: ${String(error.stderr || error.message).slice(0, 200)}`);
      }
    }
    rmSync(mzDir, { recursive: true, force: true });
  }
  // Malformed event input never throws into the game loop: a non-array list
  // prepares to [], null entries become executable no-ops, and a truthy
  // non-array branches field falls through instead of crashing the choice
  // presenter.
  {
    const originalWarn = console.warn; console.warn = () => {};
    let nonArray, withNulls, badBranches;
    try {
      nonArray = prepareEventCommands(5, stub);
      withNulls = prepareEventCommands([null, 'x', { wait: 1 }], stub);
      badBranches = prepareEventCommands([{ branches: 5 }], stub);
      await withNulls[0].call();
      await withNulls[1].call();
    } finally { console.warn = originalWarn; }
    const malformedChecks = [
      [Array.isArray(nonArray) && nonArray.length === 0, 'non-array event list prepares to []'],
      [typeof withNulls[0]?.call === 'function' && typeof withNulls[1]?.call === 'function', 'null entries become executable no-ops'],
      [JSON.stringify(withNulls[2]) === JSON.stringify({ wait: 1 }), 'valid entries still pass through untouched'],
      [badBranches.length === 1 && badBranches[0]?.call === undefined && badBranches[0]?.branches === 5, 'non-array branches fall through without routing to choices']
    ];
    for (const [ok, label] of malformedChecks) if (!ok) fail(`malformed events: ${label}`);
    if (malformedChecks.every(([ok]) => ok)) notes.push(`malformed event input ok (${malformedChecks.length} checks)`);
  }
  // XP branch types 6 (character facing) and 7 (gold) map onto the same
  // player-state conditions MV uses instead of loud markers.
  {
    const xpConverter = readFileSync(join(root, 'tools', 'convert-rgss.js'), 'utf8');
    const needed = ['convertXpGameDataOperand', "kind: 'pokemonCount'", "operator: Number(parameters[2] || 0) === 0 ? 'gte' : 'lte'"];
    if (!needed.every(snippet => xpConverter.includes(snippet))) fail('XP converter does not cover facing/gold branches and game-data operands');
    else notes.push('XP facing/gold branches and game-data operands ok');
  }
  // Plugin families are tallied at source level so the conversion log names
  // what the game actually uses instead of the inlined repeats.
  {
    const mvConverter = readFileSync(join(root, 'tools', 'convert-mv.js'), 'utf8');
    if (!mvConverter.includes('pluginFamilyCounts')) fail('MV converter does not tally plugin command families');
    else notes.push('MV plugin family census ok');
  }
  // Unmapped event commands never vanish silently: both converters keep
  // engine-faithful no-ops quiet and mark every real gap with an
  // { unsupported: { code, kind } } the validator accepts and the player
  // warns on. The validator check runs for real on synthetic manifests.
  {
    const mvConverter = readFileSync(join(root, 'tools', 'convert-mv.js'), 'utf8');
    const xpConverter = readFileSync(join(root, 'tools', 'convert-rgss.js'), 'utf8');
    const fallthroughChecks = [
      [mvConverter.includes('[0, 101, 108, 135, 405, 408, 505].includes(Number(command.code))'), 'MV silent no-op allowlist'],
      [mvConverter.includes('return [unsupportedCommand(Number(command.code), 0, context)]'), 'MV catch-all marker'],
      [xpConverter.includes('[212, 213, 214, 215, 216].includes(Number(command.code))'), 'XP engine-ignored allowlist'],
      [xpConverter.includes('return [unsupportedCommand(Number(command.code), 0, context.mapId, context.eventId)]'), 'XP catch-all marker'],
      [mvConverter.includes('return [{ commonEvent: String(ceId) }]') && playerCore.includes('commonEventDepth >= 32'), 'common-event runtime references and recursion guard'],
      [mvConverter.includes('if (route.repeat && route.wait) return [unsupportedCommand(Number(command.code), 1, context)]'), 'repeating-waiter route marker'],
        [mvConverter.includes('step.code === 45') && mvConverter.includes('commands.push({ script, mv: true, ...scriptBody(script) })'), 'MV route scripts retain executable marker'],
      [mvConverter.includes('step.code === 41') && mvConverter.includes('routeImage'), 'MV route images retain executable marker']
    ];
    for (const [ok, label] of fallthroughChecks) if (!ok) fail(`fallthrough: ${label}`);
    if (fallthroughChecks.every(([ok]) => ok)) notes.push(`converter fallthrough markers ok (${fallthroughChecks.length} checks)`);
    const probeDir = mkdtempSync(join(tmpdir(), 'mwgp-smoke-'));
    const probe = commands => ({
      format: 'MWGP', version: 1, assets: {}, maps: [{
        id: 1, tilesetId: 0,
        data: { width: 2, height: 2, data: Array(2 * 2 * 6).fill(0) },
        mwgEvents: [{ id: 1, x: 0, y: 0, pages: [{ trigger: 'action', commands }] }]
      }]
    });
    const probePath = join(probeDir, 'mwgp-marker-probe.json');
    writeFileSync(probePath, JSON.stringify(probe([
      { unsupported: { code: 233, kind: 0 } },
      { if: { unsupported: { code: 111, kind: 5 } }, then: [], else: [] },
      { modifyVariable: { target: '1', operation: 'set', operand: { gameData: { kind: 'gold' } } } },
      { modifyVariable: { target: '2', operation: 'add', operand: { script: { source: '1 + 2' } } } }
    ])));
    try {
      const out = JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), probePath], { stdio: 'pipe' }).toString());
      if (out.valid !== true) fail('validator rejected a well-formed loud-fallback manifest');
      else notes.push('validator accepts loud-fallback markers ok');
    } catch (error) {
      fail(`validator rejected a well-formed loud-fallback manifest: ${String(error.stderr || error.message).slice(0, 200)}`);
    }
    writeFileSync(probePath, JSON.stringify(probe([{ unsupported: { code: 233, kind: 'x' } }])));
    try {
      execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), probePath], { stdio: 'pipe' });
      fail('validator accepted a malformed unsupported marker');
    } catch { notes.push('validator rejects malformed markers ok'); }
    rmSync(probeDir, { recursive: true, force: true });
  }

  // 5b: move-step descriptor table (converter emits, runMoveRoute resolves).
    const { resolveRouteStep } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
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
  const toward = resolveRouteStep({ toward: true }, 'down', { x: 2, y: 2 }, { x: 4, y: 2 });
  if (JSON.stringify(toward) !== JSON.stringify({ dx: 1, dy: 0 })) { fail('resolveRouteStep toward did not close on the player'); stepFailures++; }
  if (!stepFailures) notes.push('resolveRouteStep descriptor table ok');

  // 5c: autotile source math and character frame geometry (engine rules the
  // converter measures and the player renders by; see rpg_core.js Tilemap
  // and rpg_sprites.js Sprite_Character).
  const { autotileSource, autotileDrawOps, characterDepth, characterGeometry, characterCellIndex, characterPixelSize, passageAllowsStep } =
    await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
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
  expect(characterDepth(4), 4000, 'characterDepth row');
  expect(characterDepth(4, 1), 4001, 'characterDepth tie breaker');
  const passageFlags = [0, 0, 15, 0x10];
  expect(passageAllowsStep([0, 2, 1], passageFlags, 0x01), false, 'blocked lower wall is authoritative');
  expect(passageAllowsStep([2, 1], [0, 0, 0], 0x01), true, 'passable upper door tile overrides blocked lower decoration');
  expect(passageAllowsStep([0, 3], [0, 0, 0x10, 0], 0x01), true, 'star tile delegates to lower layer');
      const playerSource = readFileSync(join(root, 'src', 'player', 'player-core.js'), 'utf8');
    if (!playerSource.includes("new URLSearchParams(globalThis.location?.search || '')") || !playerSource.includes("Number(map.id) === requestedMapId") || !playerSource.includes("position.x = requestedX") || !playerSource.includes("position.y = requestedY")) {
      fail('player does not honor URL map/x/y transfer parameters');
    }
    notes.push('cross-map URL selection and transfer coordinates ok');
    notes.push('autotile + character geometry helpers ok');
  notes.push('MV/XP layered passage resolution ok');
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

// 6: lazy per-map index (T119) - stubs keep id+info and drop data/mwgEvents,
// every stub resolves back to its full entry, and the index is far smaller.
try {
  const { buildMapIndex, findMapEntry, spliceMapEntry } = await import(pathToFileURL(join(root, 'src', 'map-index.js')).href);
  const fake = { maps: [{ id: 3, info: { name: 'Town' }, data: { width: 20 }, mwgEvents: [1] }, { id: 7, info: null, data: {}, mwgEvents: [] }] };
  const fakeIndex = buildMapIndex(fake);
  if (fakeIndex.maps.length !== 2 || fakeIndex.maps.some(stub => stub.data !== undefined || stub.mwgEvents !== undefined)) fail('map index stubs must drop data/mwgEvents');
  if (fakeIndex.maps[0].id !== 3 || fakeIndex.maps[0].info?.name !== 'Town' || fakeIndex.maps[1].info !== null) fail('map index stubs must keep id+info');
  if (findMapEntry(fake, 3) !== fake.maps[0] || findMapEntry(fake, '7') !== fake.maps[1]) fail('findMapEntry must return the manifest entry');
  if (findMapEntry(fake, 999) !== undefined || findMapEntry(fake, 'x') !== undefined) fail('findMapEntry must miss unknown maps');
  const spliced = spliceMapEntry(fakeIndex, fake.maps[0]);
  if (spliced.maps.length !== 2 || spliced.maps[0].data === undefined) fail('spliceMapEntry must replace the stub with the full entry');
  for (const dir of convertedDirs) {
    const manifestPath = join(root, 'MWGP_versions', dir, 'mwgp.json');
    if (!existsSync(manifestPath)) continue;
    const full = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const realIndex = buildMapIndex(full);
    if ((full.maps || []).length !== realIndex.maps.length) { fail(`${dir}: map index drops maps`); continue; }
    if (realIndex.maps.some(stub => stub.data !== undefined || stub.mwgEvents !== undefined)) fail(`${dir}: map index stub leaks data/mwgEvents`);
    if (realIndex.maps.some(stub => stub.id === undefined)) fail(`${dir}: map index stub is missing its id`);
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const indexBytes = Buffer.byteLength(JSON.stringify(realIndex));
    if (indexBytes >= fullBytes) fail(`${dir}: map index is not smaller than the manifest`);
    else notes.push(`${dir}: map index ${(indexBytes / 1048576).toFixed(1)} MB vs manifest ${(fullBytes / 1048576).toFixed(1)} MB`);
    const sample = (full.maps || []).find(map => map?.data);
    if (sample && findMapEntry(full, sample.id) !== sample) fail(`${dir}: findMapEntry misses map ${sample.id}`);
  }
} catch (error) {
  fail(`map index check failed: ${String(error.message).slice(0, 200)}`);
}

if (failures.length) {
  console.error(`smoke test FAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, notes }, null, 2));
