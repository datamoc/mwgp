// Smoke test: convert/validate/player contract over the real game folders.
//
// 1. Every mwgp.json under MWGP_versions/ must pass tools/validate-mwgp.js.
// 2. Every command key used by those manifests must be in the validator's
//    allowed set (the converter must never emit what the validator rejects).
// 3. Every allowed key must be executable by src/player/player-core.js: either
//    passed straight to mwg' own EventRunner (NATIVE list below) or
//    rewritten in prepareEventCommands (referenced as `command.<key>`).
// 4. `node src/server.js --scan` must still print a JSON catalog over the
//    real RPGM_versions/ + MWGP_versions/ trees.
//
// Usage: npm test
import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import './test-asset-usage.mjs';
import { requireConvertedGames } from './test-games.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];
const fail = message => failures.push(message);

// Commands mwg' Rpg.EventRunner already understands natively: they pass
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
// One converted project per game in RPGM_versions/ (at least two; see tools/test-games.mjs).
const convertedDirs = requireConvertedGames().map(game => game.name);
for (const dir of convertedDirs) {
  const manifestPath = join(root, 'MWGP_versions', dir, 'mwgp.json');
  if (!existsSync(manifestPath)) {
    // Web builds share metadata; MV/MZ use the nw.js host, RGSS packages a stored archive and mkxp-z player.
    const webInfo = join(root, 'MWGP_versions', dir, 'mwgp-web.json');
    if (existsSync(webInfo)) {
      const info = JSON.parse(readFileSync(webInfo, 'utf8'));
      if (info.source?.engine === 'rpg-maker-rgss') {
        const archive = join(root, 'MWGP_versions', dir, 'game.mkxpz');
        const ok = info.format === 'MWGP-web' && existsSync(archive) && existsSync(join(root, 'MWGP_versions', dir, 'rgss-player.js'))
          && existsSync(join(root, 'MWGP_versions', dir, 'mkxp-z_libretro.wasm')) && info.archive?.bytes === statSync(archive).size;
        if (!ok) fail(`${dir}: RGSS web build is malformed`);
        else notes.push(`${dir}: RGSS web build ok (${info.source.files} files)`);
        continue;
      }
      const html = readFileSync(join(root, 'MWGP_versions', dir, 'index.html'), 'utf8');
      const hostAt = html.indexOf('nwjs-host.js'), firstDeferred = html.indexOf('data-mwgp-src');
      const fileList = JSON.parse(readFileSync(join(root, 'MWGP_versions', dir, 'files.json'), 'utf8'));
      if (info.format !== 'MWGP-web' || hostAt < 0 || (firstDeferred >= 0 && firstDeferred < hostAt) || /<script\b[^>]*(?<![-\w])src=/i.test(html.replace(/<script src="nwjs-host\.js"><\/script>/, ''))
        || !existsSync(join(root, 'MWGP_versions', dir, 'nwjs-host.js')) || !Array.isArray(fileList) || fileList.length !== info.source?.files) {
        fail(`${dir}: web build is malformed (host not first, a game script not deferred, or files.json out of sync)`);
      } else notes.push(`${dir}: web build ok (${info.source.engine}, ${fileList.length} files)`);
    } else notes.push(`${dir}: no mwgp.json, skipped`);
    continue;
  }
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
    // A family is unsupported with no shipped handler, supported when its handler's own command code stays in
    // game state, and partial (with the display classes it reaches) when that code touches a window, scene or
    // sprite this player never runs.
    const misrated = Object.entries(pluginReport || {}).filter(([, entry]) => {
      if (entry.status === 'unsupported') return Boolean(entry.handledBy?.length);
      if (!entry.handledBy?.length) return true;
      return entry.status === 'partial' ? !(entry.reaches || []).length : Boolean(entry.reaches?.length);
    });
    if (misrated.length) fail(`${dir}: plugin families rated without a shipped handler, or partial without what they reach: ${misrated.map(([name]) => name).slice(0, 5).join(', ')}`);
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
    } else if (!project.assets?.autotiles || (project.playerSprite && !project.playerSprite.name) || !Number.isFinite(project.player?.x) || !Number.isFinite(project.player?.y)) {
      // A null player sprite is allowed: the start actor's charset may not ship with the project.
      fail(`${dir}: XP manifest is missing decoded autotiles or start position, or has a malformed player sprite`);
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
    '125', '126', '127', '128', '129', '132', '133', '134', '135', '136', '137', '138', '139', '140', '124', '206', '216', '217', '261', '281', '312', '315', '317', '320', '323', '324', '325', '326', '339', '354', '104', '233', '282', '283', '284', '285', '333', '334', '337', '340', '342', '201', '203', '204', '205', '211', '212', '213', '214', '221', '222',
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

// 2d: per-feature banner areas (T128) — every supported/partial code from both
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
  if (karrynLike.map(entry => entry.area).join(',') !== 'plugins,scripts' || !featureLines(karrynLike)[0].startsWith('Plugins: partial (356×4178')) {
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
  const { foregroundOrigin, normalizeDialogueMarkup, prepareEventCommands, resolveGameDataOperand, resolveTransferTarget, runBattleFallback, sanitizeMapPosition, selectForegroundLayer } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
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
    [{ systemFlag: { key: 'menuAccess', value: false } }, 'setSystemFlag'],
    [{ gatherFollowers: true }, 'gatherFollowers'],
    [{ changeActorStat: { stat: 'mp', scope: 1, actor: 1, amount: 5, sign: 1 } }, 'applyActorStat'],
    [{ changeActorText: { actor: 1, field: 'name', text: 'Ann' } }, 'changeActorText'],
    [{ changeActorImages: { actor: 1, characterName: 'Actor2', characterIndex: 1, faceName: '', faceIndex: 0, battlerName: '' } }, 'changeActorImages'],
    [{ timer: { start: 30 } }, 'setTimer'],
    [{ vehicleBoard: true }, 'boardVehicle'],
    [{ playMovie: { name: 'intro' } }, 'playMovie'],
    [{ forceAction: { subjectKind: 'enemy', subject: 0, skill: 1, target: -2 } }, 'forceAction'],
    [{ returnToTitle: true }, 'returnToTitle'],
    [{ rotatePicture: { id: 1, speed: 4 } }, 'rotatePicture'],
    [{ changeTileset: { id: 2 } }, 'changeTileset'],
    [{ changeParallax: { name: 'Sky', loopX: true, loopY: false, sx: 2, sy: 0 } }, 'changeParallax'],
    [{ locationInfo: { variable: '1', info: 0, x: 2, y: 3 } }, 'locationInfo'],
    [{ selectItem: { variable: '1', itemType: 1 } }, 'selectItem'],
    [{ abortBattle: true }, 'abortBattle'],
    [{ enemyRecoverAll: { index: -1 } }, 'enemyRecoverAll'],
    [{ if: { timer: { seconds: 5, atLeast: true } }, then: [], else: [] }, 'runBranch'],
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
  if (normalizeDialogueMarkup('a<br>b <i>c</i>') === 'a\nb *c*') notes.push('inline dialogue markup normalization ok');
  else fail('inline dialogue markup normalization changed styled text incorrectly');
  if (!playerCore.includes("like Karryn's `\\#`")) fail('player-core.js prints unknown text escapes instead of consuming them');
  else notes.push('unknown text escapes are consumed like the engine ok');
  if (!playerCore.includes('_saveCount') || !playerCore.includes('promptSaveGame')) fail('player-core.js does not count engine saves or prompt for the save file');
  else notes.push('engine save count and save-file prompt ok');
  if (!playerCore.includes('refreshAutorunEvents')) fail('player-core.js never refreshes autorun events after a page finishes');
  else notes.push('autorun refresh after page completion ok');
  // Event-script runtime, end to end on a made-up game (no real game data): a Scripts.rxdata
  // stand-in defines an Interpreter class, a Game_Event class, a module and a helper def;
  // the library builder transpiles what the snippets reach and the runtime runs it.
  {
    const { setInterpreterMethods, transpileSnippet } = await import(pathToFileURL(join(root, 'tools', 'rgss-snippet.mjs')).href);
    const { indexScripts, buildRgssLibrary, transpileUnit, mergeTranspiledParts } = await import(pathToFileURL(join(root, 'tools', 'rgss-library.mjs')).href);
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
      { name: 'AliasOverride', source: 'def alias_probe\n  "original"\nend\nalias alias_probe_original alias_probe\ndef alias_probe\n  alias_probe_original + "-override"\nend\n' },
      { name: 'Pronoun', source: 'module Pronoun\n  def self.current_gender\n    "female"\n  end\n  def self.title\n    current_gender\n  end\n  def self.id_check\n    "x".respond_to?("id")\n  end\nend\n' },
      { name: 'HashMethodCall', source: 'module HashMethodCall\n  DATA = { "ACE" => 1 }\n  def self.keys\n    DATA.keys\n  end\n  def self.first_key\n    keys[0]\n  end\nend\n' }
      , { name: 'SelfNamespace', source: 'module SelfNamespace\n  class Value\n    def self.answer\n      42\n    end\n  end\n  COPY = SelfNamespace::Value\n  def self.answer\n    SelfNamespace::Value.answer\n  end\nend\n' }
    ];
    const snippets = ['get_self.setTempSwitchOn("A")', 'give_potion(2)', 'on_event?', 'alias_probe', 'HashProbe.total_value', 'HashProbe.count', 'ForwardConst.value', 'PartialUnit.missing_method', 'Pronoun.title', 'HashMethodCall.first_key', 'HashMethodCall.keys[0]', 'Unknown.thing(1)', 'SelfNamespace.answer'];
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
    const aliasProbe = rgss.evaluateValue({ source: 'alias_probe', js: 'return alias_probe();' }, { game }, events[0]);
    const dataRuntime = createRgssRuntime(scene, { rubyData: { 'System.rxdata': { class: 'RPG::System', ivars: { '@cursor_se': { class: 'RPG::AudioFile', ivars: { '@name': 'Cursor', '@volume': 80, '@pitch': 100 } } } } }, library: { ...library, methods: [...library.methods, 'name'] } });
    const systemAudioName = dataRuntime.evaluateValue({ source: '$data_system.cursor_se.name', js: 'return $data_system.cursor_se.name();' }, { game }, events[0]);
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
      const zeroArgHashMethodCall = rgss.evaluateValue({ source: 'HashMethodCall.first_key', js: 'return HashMethodCall.first_key();' }, { game }, events[0]);
      const constantHashMethodCall = rgss.evaluateValue({ source: 'HashMethodCall.keys[0]', js: 'return HashMethodCall.keys()[0];' }, { game }, events[0]);
      const rubyRegexReplace = rgss.evaluateValue({ source: '"a1 a2".gsub(/a\\d/, "x")', js: 'return "a1 a2".replaceAll(/a\\d/, "x");' }, { game }, events[0]);
      const rubyObjectRegexReplace = rgss.evaluateValue({ source: 'a path-like Ruby object with to_str', js: 'return ({ toString() { return "a1 a2"; } }).replaceAll(/a\\d/, "x");' }, { game }, events[0]);
      const rubyConstReflection = rgss.evaluateValue({ source: 'Module#const_defined?', js: 'return ({ VALUE: 1 }).const_defined("VALUE") && !({}).const_defined("MISSING");' }, { game }, events[0]);
      const camelGlobalAlias = rgss.evaluateValue({ source: 'RGSS camel-case global alias', js: 'return $gameSystem === $game_system;' }, { game }, events[0]);
      rgss.evaluate({ source: 'RGSS camel-case global assignment', js: '$gameSystem = $game_system;' }, { game }, events[0]);
      const fileExtname = rgss.evaluateValue({ source: 'File.extname("portrait.png")', js: 'return File.extname("portrait.png");' }, { game }, events[0]);
      const emptyFileExists = rgss.evaluateValue({ source: 'File.exist?("")', js: 'return File.exist("");' }, { game }, events[0]);
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
      const implicitSuperJs = transpileUnit({ name: 'ForwardChild', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'implicit super', text: '# Pokémon child class\nclass ForwardBase\n  def initialize(name, type)\n    @received = [name, type]\n  end\nend\nclass ForwardChild < ForwardBase\n  def initialize(name, type)\n    super\n  end\nend' }] });
      let implicitSuperHit = false;
      try { implicitSuperHit = new Function(`${implicitSuperJs}; return new ForwardChild('Michel', 'TRAINER')._received.join('|');`)() === 'Michel|TRAINER'; } catch { /* asserted below */ }
      const singletonAliasJs = transpileUnit({ name: 'SingletonAliasProbe', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'singleton alias', text: 'class SingletonAliasProbe\n  class << self\n    def new(value)\n      value\n    end\n    alias open new\n  end\nend' }] });
      let singletonAliasHit = false;
      try { singletonAliasHit = new Function(`${singletonAliasJs}; return SingletonAliasProbe.open('reader');`)() === 'reader'; } catch { /* asserted below */ }
      const conditionalAliasJs = transpileUnit({ name: 'ConditionalAliasProbe', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'conditional singleton alias', text: 'module ConditionalAliasProbe\n  class << self\n    def target\n      42\n    end\n    if true\n      alias copy target\n    end\n  end\nend' }] });
      const conditionalAliasLoads = /if \(true\) this\.copy = this\.target/.test(conditionalAliasJs) && !/static copy =/.test(conditionalAliasJs);
      // A framework helper the game's library does not define is a loud stub like any unknown name: no built-in
      // stands in for it, and no player state appears.
      await run('pbItemBall(:POTION)');
      // The newest lowerings, end to end: `slice!`, Hash key membership, a module sharing `@cache`
      // state across sibling calls (the `RPG::Cache` bitmap-cache shape), and a method kept callable next to a
      // same-name setter. Handler-registry statements (`XHandlers.add`, `GameData::X.register`) index as boot units.
      const { lowerRuby, liftBlocking } = await import(pathToFileURL(join(root, 'tools', 'rgss-async.mjs')).href);
      // Same-named methods split across classes (`TrainerBattle.generate_foes`
      // async, `WildBattle.generate_foes` sync): a call through the class name
      // awaits exactly when that class's own definitions agree.
      const liftProbe = liftBlocking({
        LiftA: 'class LiftA {\n  static fetch() { return LiftA.load(); }\n  static load() { Graphics.update(); return 1; }\n}',
        LiftB: 'class LiftB {\n  static fetch() { return LiftB.load(); }\n  static load() { return 2; }\n}',
      }, [], {});
      const liftKeyed = liftProbe.units.LiftA.includes('(await LiftA.load())') && !liftProbe.units.LiftB.includes('(await LiftB.load())');
      const spliceOk = await rgss.run({ source: 'slice!', js: 'let s = "hello"; const cut = __splice(s, (__v) => { s = __v }, 1, 2); const a = [1, 2, 3]; const head = __splice(a, null, 0, 1); $game_variables[9] = cut + "|" + s + "|" + head + "|" + a.join(",");' }, { game }, events[0]);
      const hashIncludes = rgss.evaluateValue({ source: 'include?', js: 'return ({a: 1}).includes("a") && !({a: 1}).includes("z") && [1, 2].includes(2);' }, { game }, events[0]);
      const cacheJs = lowerRuby('const Cache = (() => { this._cache = {}; function load(n) { return this._cache[n] ?? (this._cache[n] = n * 2) } function get(n) { return load(n) } return { load, get } })()');
      const cacheHit = rgss.evaluateValue({ source: 'cache', js: `${cacheJs}; return Cache.get(21) + Cache.get(21);` }, { game }, events[0]);
      const clashJs = lowerRuby('class W { columns() { return 3 } set columns(v) { this._c = v } }');
      const clashHit = rgss.evaluateValue({ source: 'clash', js: `${clashJs}; const w = new W(); w.columns = 9; return w.columns() + w._c;` }, { game }, events[0]);
      const clampHit = rgss.evaluateValue({ source: 'clamp', js: 'return (5).clamp(0, 10) + (50).clamp(0, 10) + (-5).clamp(0, 10);' }, { game }, events[0]);
      // `yield` inside a Ruby block is the enclosing method's block: the block's arrow must not declare its own.
      const yieldJs = lowerRuby('function outer(_implicitBlockYield=null) { return inner((p, _implicitBlockYield=null) => { return _implicitBlockYield(p + 1) }) }\nfunction inner(fn) { return fn(1) }');
      let yieldHit = false;
      try { yieldHit = new Function(`${yieldJs}\nreturn outer(v => v * 10);`)() === 20; } catch { yieldHit = false; }
      // `attr_reader`/`attr_accessor` expand to plain defs (readers must be
      // methods, not getters: every paren-less use compiles to a call), with
      // an explicit setter each for accessors (the GameData record shape).
      // addKnownMethods mirrors what indexScripts does for real scripts
      // (collectAttrNames feeds allDefNames).
      const { addKnownMethods } = await import(pathToFileURL(join(root, 'tools', 'rgss-call-filter.mjs')).href);
      addKnownMethods(['real_name', 'stage']);
      const attrJs = lowerRuby(transpileUnit({ name: 'attr', kind: 'const', methods: new Set(['real_name', 'stage']), sends: new Set(), consts: new Set(), pieces: [{ script: 'A', text: 'class AttrThing\n  attr_reader :real_name\n  attr_accessor :stage\nend' }] }));
      const attrHit = rgss.evaluateValue({ source: 'attr', js: `${attrJs}; const t = new AttrThing(); t.stage = 2; return [typeof t.real_name, typeof t.stage, t.stage()].join("|");` }, { game }, events[0]);
      const attrIndex = indexScripts([{ name: 'AttrIdx', source: 'class AttrIdx\n  attr_reader :mood\n  attr_accessor :energy\nend' }]);
      const attrIndexed = attrIndex.allDefNames.has('mood') && attrIndex.allDefNames.has('energy');
      const indexedBang = transpileUnit({ name: 'indexed_bang', kind: 'def', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'T', text: 'def indexed_bang(list)\n  list[0].gsub!(/a/, "b")\n  list[0]\nend' }] });
      const indexedBangHit = new Function(`${indexedBang}; return indexed_bang(['alpha']);`)();
      const aliasIndex = indexScripts([{ name: 'Aliases', source: 'class AliasAccessors\n  attr_accessor :width, :height\n  alias xsize width\n  alias ysize height\nend' }]);
      const aliasAccessors = transpileUnit(aliasIndex.units.get('AliasAccessors'));
      const aliasAccessorsValid = aliasAccessors.includes('xsize') && aliasAccessors.includes('ysize') && !aliasAccessors.includes('.prototype.xsize');
      const classNameJs = transpileUnit({ name: 'class_name', kind: 'def', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'T', text: 'def class_name(value)\n  value.class.name\nend' }] });
      const classNameHit = new Function(`class ClassNameProbe {}\n${classNameJs}; return class_name(new ClassNameProbe());`)();
      const respondToJs = transpileUnit({ name: 'RespondProbe', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'respond_to', text: 'module RespondProbe\n  def self.player_defined?\n    $player.respond_to?(:character_ID)\n  end\n  def self.self_defined?\n    respond_to?(:character_ID)\n  end\nend' }] });
      const respondToReceivers = respondToJs.includes('__respond_to($player, "character_ID")') && respondToJs.includes('__respond_to(this, "character_ID")') && !respondToJs.includes('defined(character_ID()');
      const registryRuntime = createRgssRuntime(scene, { library: { methods: new Set(['keys']), units: { Registry: 'const Registry = (() => { class TrainerType { static DATA = {}; static DATA_FILENAME = "trainer_types.dat"; static keys() { return this.DATA.keys; } }; return { TrainerType }; })();' } }, rubyData: { 'trainer_types.dat': { ['$map']: [['RED', 1], ['BLUE', 2]] } } });
      const shippedRegistryKey = registryRuntime.evaluateValue({ source: 'Registry.TrainerType.keys[0]', js: 'return Registry.TrainerType.keys[0];' }, { game }, events[0]);
      const moduleReaderRuntime = createRgssRuntime(scene, { library: { methods: new Set(['selected_character_key']), units: { ReaderProbe: 'const ReaderProbe = { _selected_character_key: "ronan", get selected_character_key() { return this._selected_character_key; } };' } } });
      const moduleReaderValue = moduleReaderRuntime.evaluateValue({ source: 'ReaderProbe.selected_character_key', js: 'return ReaderProbe.selected_character_key();' }, { game }, events[0]);
      const bootRuntime = createRgssRuntime(scene, { library: { methods: new Set(['new_game_value']), boot: ['BootValue_map_factory'], units: { BootValue_map_factory: 'const BootValue_map_factory = { load_value(value) {}, save_value() { return null; } };' } } });
      bootRuntime.evaluateValue({ source: 'boot probe', js: 'return true;' }, { game }, events[0]);
      const missingBootFactoryNoOp = !warnings.some(w => String(w).includes('BootValue_map_factory.new_game_value'));
      const orderedBootRuntime = createRgssRuntime(scene, { library: {
        boot: ['BootValue_player'], bootStatements: ['BootStatement_trainer'],
        units: {
          GameData: 'const GameData = { TrainerType: { keys: [], DATA: {} } };',
          Player: 'class Player { constructor(type) { if (!GameData.TrainerType.DATA[type]) throw new Error("trainer not registered"); this.name = "Unnamed"; } }',
          BootStatement_trainer: 'GameData.TrainerType.DATA.ACE = { id: "ACE" }; GameData.TrainerType.keys.push("ACE");',
          BootValue_player: 'const BootValue_player = { new_game_value() { return new Player(GameData.TrainerType.keys[0]); }, load_value(value) { $player = value; }, save_value() { return $player; } };'
        }
      } });
      orderedBootRuntime.evaluateValue({ source: 'ordered boot registration', js: 'return true;' }, { game }, events[0]);
      const orderedBootPlayer = orderedBootRuntime.evaluateValue({ source: 'booted player', js: 'return $player.name;' }, { game }, events[0]);
      setKnownMethods(index.allDefNames);
      // A Ruby mixin module reaches JS as an IIFE whose return lists only some
      // of its functions (zero-argument defs arrive as getters, and only some
      // survive); `extend` must still give the class every one of them, so the
      // lowered export carries the missing names as methods (the GameData
      // registries' `each`/`exists`/`count` shape from Pokemon Void).
      const mixinJs = lowerRuby('const Kinds = (() => { this._mark = 1; function schema() { return 7 } function register(h) { return h.id } function exists(other) { return other != null } function get(other) { return other } function keys() { return [1] } function each(f) { return f(1) } function count() { return 1 } return { register, get, keys, get exists() { return exists.call(this) } } })(); class Mon {} __mixin(Mon, Object.getOwnPropertyDescriptors(Kinds));');
      const mixinHit = rgss.evaluateValue({ source: 'mixin', js: `${mixinJs}; const seen = []; Kinds.each(v => seen.push(v)); return [typeof Mon.each, typeof Mon.count, Mon.exists(1), Mon.get(5), Mon.keys().join(), seen.join(), Mon.schema()].join("|");` }, { game }, events[0]);
      // A setter aliased under a plain name (`alias __shadow_hpeq hp=`, the Shadow
      // Pokémon shape) stays a plain callable def: the override invokes the old
      // body as `__shadow_hpeq(value)`, which a JS setter could never answer.
      const shadowJs = lowerRuby(transpileUnit({ name: 'shadow', kind: 'class', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'S', text: 'class ShadowMon\n  def hp=(value)\n    @_hp = value\n  end\n  alias __shadow_hpeq hp=\n  def hp=(value)\n    __shadow_hpeq(value)\n    @_hp += 1\n  end\nend' }] }));
      const shadowHit = rgss.evaluateValue({ source: 'shadow', js: `${shadowJs}; const p = new ShadowMon(); p.hp = 5; return p.__hp;` }, { game }, events[0]);
      // A `.call` on a game module survives Ruby2JS's proc-invocation lowering:
      // the indexer marks the const, lowerRuby restores `ModCall.call(...)`.
      const modCallJs = lowerRuby(transpileUnit({ name: 'modcall', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'S', text: 'module ModCall\n  def self.call(x)\n    x * 2\n  end\nend\nModCall.call(21)' }] }), null, null, new Set(['ModCall']));
      const modCallHit = rgss.evaluateValue({ source: 'modcall', js: `${modCallJs}\nreturn ModCall.call(21);` }, { game }, events[0]);
      // Merged reopenings can reference the class ahead of the block declaring
      // it (`Battle.Battler = ...` before `class Battle`): the first
      // declaration hoists so the reference never hits the tail binding's
      // temporal dead zone.
      const mergedJs = mergeTranspiledParts('MergeMon', ['MergeMon.Kind = 1;\nclass MergeMon {\n  constructor() { this._k = 1; }\n}', 'class MergeMon {\n};\nMergeMon.Half = 2;\n__mixin(MergeMon.prototype, Object.getOwnPropertyDescriptors({ extra() { return 9; } }));', 'MergeMon.Scene = class {\n  full() { return 1; }\n};\nMergeMon.Scene.Animation = class {\n  play() { return 2; }\n};', 'MergeMon.Scene = class {\n  extra() { return 3; }\n};\nMergeMon.Scene.Animation.Arceus = class extends MergeMon.Scene.Animation {\n  burst() { return 4; }\n};']);
      const mergedHit = rgss.evaluateValue({ source: 'merge', js: `${mergedJs}\nreturn MergeMon.Kind + MergeMon.Half + new MergeMon()._k + new MergeMon().extra() + new MergeMon.Scene().full() + new MergeMon.Scene().extra() + new MergeMon.Scene.Animation().play() + new (MergeMon.Scene.Animation.Arceus)().burst();` }, { game }, events[0]);
      // Ruby's `class << self` singleton reopening (alias + override) arrives
      // as an arrow IIFE over `this`: the body binds to the existing object,
      // the capture keeps a reference, and the discarded `return {}` returns it.
      const iifeJs = mergeTranspiledParts('IifeMon', ['class IifeMon {\n}', 'IifeMon.Fx = class {};\nIifeMon.Fx.play = () => { return \'old\'; };', 'IifeMon.Fx = (() => {\n  this.origPlay = this.play();\n  this.play = () => { return \'new\' + this.origPlay(); };\n  return {}\n})()']);
      const iifeHit = rgss.evaluateValue({ source: 'iife', js: `${iifeJs}\nreturn IifeMon.Fx.play();` }, { game }, events[0]);
      // A static initializer reading the class's own path (`Box.Holder.base`
      // inside `Box.Holder = class ...`) means `this` there: the class is
      // still being defined, so its path does not resolve yet.
      const selfStaticJs = lowerRuby('TargetBox.Holder = class {\n  static base = 7;\n  static doubled = TargetBox.Holder.base * 2;\n};');
      const selfStaticHit = rgss.evaluateValue({ source: 'selfstatic', js: `const TargetBox = {};\n${selfStaticJs}\nreturn TargetBox.Holder.doubled;` }, { game }, events[0]);
      const guardedConstantJs = transpileUnit({ name: 'GuardedEffects', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'guard', text: 'module GuardedEffects\n  NEW_EFFECT = 205 if !const_defined?(:NEW_EFFECT)\nend' }] });
      const guardedConstantHit = rgss.evaluateValue({ source: 'guarded constant', js: `${guardedConstantJs}\nreturn GuardedEffects.NEW_EFFECT;` }, { game }, events[0]);
      const setterProbeJs = transpileUnit({ name: 'SetterProbe', kind: 'const', methods: new Set(['has_writer']), sends: new Set(), consts: new Set(), pieces: [{ script: 'setter', text: 'class SetterProbe\n  def has_writer?\n    respond_to?(:writer=)\n  end\n  def writer=(value)\n    @writer = value\n  end\nend' }] });
      const setterProbeHit = rgss.evaluateValue({ source: 'setter probe', js: `${setterProbeJs}\nreturn new SetterProbe().has_writer();` }, { game }, events[0]);
      const singletonAccessorJs = transpileUnit({ name: 'SingletonAccessor', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'singleton accessor', text: 'class SingletonAccessor\n  class << self\n    attr_accessor :value\n  end\nend' }] });
      const singletonAccessorHit = singletonAccessorJs.includes('static value(') && singletonAccessorJs.includes('static set value(');
      const accessorOrJs = transpileUnit({ name: 'AccessorOr', kind: 'const', methods: new Set(['value', 'ensure_value']), sends: new Set(), consts: new Set(), pieces: [{ script: 'accessor ||= ', text: 'class AccessorOr\n  attr_accessor :value\n  def ensure_value\n    self.value ||= {}\n  end\nend' }] });
      const accessorOrHit = /this\.value = this\.value\(\) \?\? \{\}/.test(accessorOrJs);
      setKnownMethods([...index.allDefNames, 'data']);
      const mapRecordJs = transpileUnit({ name: 'Game_Map', kind: 'const', methods: new Set(['data']), sends: new Set(), consts: new Set(), pieces: [{ script: 'RPG::Map record', text: 'class Game_Map\n  def data\n    @map.data\n  end\nend' }] });
      const mapRecordHit = /this\._map\.data\b/.test(mapRecordJs) && !/this\._map\.data\(\)/.test(mapRecordJs);
      setKnownMethods(index.allDefNames);
      const rubyStringTypeHit = rgss.evaluateValue({ source: 'Ruby primitive type', js: 'return __ruby_is_a("None", String) && __ruby_is_a("None", Symbol);' }, { game }, events[0]);
      const plainAliasJs = transpileUnit({ name: 'PlainAlias', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'plain alias', text: 'module PlainAlias\n  class << self\n    def target\n      42\n    end\n    alias copy target\n  end\nend' }] });
      const plainAliasHit = /this\.copy = this\.target;/.test(plainAliasJs);
      const reinitializedClassJs = transpileUnit({ name: 'Reinitialized', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [
        { script: 'base', text: 'class Reinitialized\n  def initialize\n    @base = true\n  end\nend' },
        { script: 'plugin', text: 'class Reinitialized\n  alias original_initialize initialize\n    def initialize\n      original_initialize\n      @plugin = true\n    end\nend' }
      ] });
      const reinitializedClassHit = (reinitializedClassJs.match(/\bconstructor\s*\(/g) || []).length === 1 && new Function(`${reinitializedClassJs}\nconst value = new Reinitialized(); return value._base && value._plugin;`)();
      const lateMixinScripts = [{ name: 'Mixins', source: 'module Container\nend\nclass IncludeEarly\n  include Container::LateMixin\n  def value\n    late_value\n  end\nend\nmodule Container::LateMixin\n  def late_value\n    42\n  end\nend' }];
      const lateMixinIndex = indexScripts(lateMixinScripts);
      setKnownMethods(lateMixinIndex.allDefNames); setInterpreterMethods(lateMixinIndex.interpreterMethods);
      const lateMixinLibrary = await buildRgssLibrary(lateMixinScripts, ['IncludeEarly.value', 'Container'], { index: lateMixinIndex, maxDepth: 2, log: () => {} });
      const lateMixinRuntime = createRgssRuntime(scene, { mapId: 3, mapEvents: events, mapSize: { width: 10, height: 10 }, library: lateMixinLibrary });
      const lateMixinHit = lateMixinRuntime.evaluateValue({ source: 'late mixin', js: 'const instance = new IncludeEarly(); return [typeof IncludeEarly.prototype.late_value, typeof instance.late_value, typeof Container.LateMixin.late_value, instance.value()].join("|");' }, { game }, events[0]);
      const nestedConstScripts = [{ name: 'Nested constants', source: 'class NestedOwner\n  class NestedSlot\n    def value\n      42\n    end\n  end\n  def create_slot\n    NestedSlot.new\n  end\nend' }];
      const nestedConstIndex = indexScripts(nestedConstScripts);
      setKnownMethods(nestedConstIndex.allDefNames); setInterpreterMethods(nestedConstIndex.interpreterMethods);
      const nestedConstLibrary = await buildRgssLibrary(nestedConstScripts, ['NestedOwner.create_slot'], { index: nestedConstIndex, maxDepth: 2, log: () => {} });
      const nestedConstRuntime = createRgssRuntime(scene, { mapId: 3, mapEvents: events, mapSize: { width: 10, height: 10 }, library: nestedConstLibrary });
      const nestedConstHit = nestedConstRuntime.evaluateValue({ source: 'nested constant', js: 'return new NestedOwner().create_slot().value();' }, { game }, events[0]);
      setKnownMethods(index.allDefNames); setInterpreterMethods(index.interpreterMethods);
      // A top-level `X.register(...)` on the game's own module (MultipleForms,
      // not just *Handlers/GameData::*) indexes as a boot statement too.
      // A `SaveData.register(...) do ... end` block is a save-data value even
      // though it also matches the registry-statement shape: the DSL matcher
      // runs first.
      const saveIndex = indexScripts([{ name: 'Saves', source: 'module SaveData\nend\nSaveData.register(:hero) do\n  ensure_class Player\n  save_value { 1 }\n  load_value { |v| }\n  new_game_value { 2 }\nend\n' }]);
      const formIndex = indexScripts([{ name: 'Forms', source: 'module MultipleForms\nend\nMultipleForms.register(:UNOWN, { "getFormOnCreation" => 1 })\n' }]);
      const bootIndex = indexScripts([{ name: 'Handlers', source: 'MenuHandlers.add(:pause_menu, :pokedex, { "name" => "Pokedex" })\n' }]);
      const checks = [
        [Object.keys(library.units).sort().join() === 'ForwardConst,Game_Event,HashMethodCall,HashProbe,Interpreter,PartialUnit,Pronoun,SelfNamespace,Shop,alias_probe,alias_probe_original,give_potion', 'library holds exactly the units the snippets reach'],
        [switches.get('7') === true && variables.get('2') === 3, 'built-in $game_switches / $game_variables'],
        [switches.get('self:3:5:A') === true, "the game's own Interpreter#get_self + Game_Event#setTempSwitchOn run on the shim"],
        [scene.rpgExtra.items['1'] === 2 && scene.rpgExtra.gold === 85, "a game-defined top-level def and module method run (gold 100 - 20 + 5)"],
        [JSON.stringify(played) === JSON.stringify([['say', 'hi'], ['balloon', 7, 1]]), 'queued waits play in call order'],
        [warnings.some(w => String(w).includes('pbItemBall')) && scene.rpgExtra.namedItems === undefined && !('pbItemBall' in rgss.introspect().builtins), 'an undefined framework helper is a loud stub, not a built-in'],
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
        , [zeroArgHashMethodCall === 'ACE', 'Ruby Hash#keys and same-named module methods are called before indexing']
        , [constantHashMethodCall === 'ACE', 'a constant-qualified Ruby zero-argument keys method is called before indexing']
        , [rubyRegexReplace === 'x x', 'Ruby gsub accepts non-global regular expressions']
        , [rubyObjectRegexReplace === 'x x', 'Ruby gsub lowering stringifies string-like engine values']
        , [rubyConstReflection === true, 'Ruby Module#const_defined? checks constants on transpiled modules']
        , [camelGlobalAlias === true, 'camel-case engine globals resolve to their RGSS snake-case state object']
        , [fileExtname === '.png', 'RGSS File.extname is available to browser scripts']
        , [emptyFileExists === false, 'an empty RGSS file path is not treated as the virtual root directory']
        , [warnings.some(w => String(w).includes('PartialUnit.missing_method')), 'missing library methods degrade to a loud callable stub']
        , [strippedMethodNames, 'manifest method names are stripped of ?/! like the transpiled output']
        , [redefinedLoadsLastWins, 'a redefined helper keeps only its last definition and loads under with(scope)']
        , [implicitSuperHit, 'bare Ruby super forwards the current method arguments to the parent initializer']
        , [singletonAliasHit, 'aliases in Ruby singleton classes become valid static aliases in JavaScript classes']
        , [conditionalAliasLoads, 'conditional singleton aliases remain runtime statements, not static fields']
        , [aliasProbe === 'original-override', 'a top-level Ruby alias before a redefinition remains callable in the merged library unit']
        , [systemAudioName === 'Cursor', 'Marshal-backed $data_system reads RGSS core-class ivars as Ruby attributes']
        , [spliceOk === true && variables.get('9') === 'el|hlo|1|2,3', 'Ruby slice! removes and returns through __splice (string and array)']
        , [hashIncludes === true, 'Hash#include? reads key membership without shadowing Array#includes']
        , [cacheHit === 84, 'a module IIFE shares its @cache across sibling calls through one self']
        , [clashHit === 12, 'a method next to a same-name setter stays callable and the setter still assigns']
        , [clampHit === 15, 'Ruby Numeric#clamp is available to RGSS libraries']
        , [yieldHit, "yield inside a block reaches the enclosing method's block"]
        , [attrHit === 'function|function|2', 'attr_reader/attr_accessor expand to callable readers with a working setter']
        , [attrIndexed === true, 'the indexer collects attr_reader/attr_accessor names as known methods']
        , [indexedBangHit === 'blphb', 'indexed Ruby bang-method receivers transpile as writable indexed expressions']
        , [aliasAccessorsValid, 'aliases of accessors in nested classes keep a valid receiver in generated JavaScript']
        , [classNameHit === 'ClassNameProbe', 'Ruby class-name reflection reads JavaScript constructor.name as a property']
        , [respondToReceivers, 'Ruby respond_to? keeps its explicit receiver and checks the implicit self when omitted']
        , [shippedRegistryKey === 'RED', 'decoded Marshal registries expose Ruby Hash#keys to data-class loaders']
        , [moduleReaderValue === 'ronan', 'Ruby module readers stay callable when their transpiled export is a JavaScript getter']
        , [missingBootFactoryNoOp, 'save data without new_game_value does not call the missing method stub']
        , [orderedBootPlayer === 'Unnamed', 'Ruby handler/registry boot statements run before save-data constructors that query registries']
        , [mixinHit === 'function|function|true|5|1|1|7', 'an extended class answers every mixin def (each/exists/count/keys/get/register/schema)']
        , [(bootIndex.bootStatementNames || []).length === 1, 'handler-registry statements index as boot units']
        , [shadowHit === 6, 'a setter aliased under a plain name stays callable from its override']
        , [modCallHit === 42 && modCallJs.includes('ModCall.call('), 'a .call on a game module survives the proc-invocation lowering']
        , [(formIndex.bootStatementNames || []).length === 1, 'a top-level register on a game module indexes as a boot statement']
        , [(saveIndex.bootNames || []).join() === 'BootValue_hero' && !(saveIndex.bootStatementNames || []).length, 'a save-data register block indexes as a boot value, not a boot statement']
        , [mergedHit === 23, 'merged reopenings hoist the first class declaration, drop empty shadowing ones and merge repeated nested classes']
        , [iifeHit === 'newold', 'a merged singleton reopening binds its body to the existing object and keeps the alias capture']
        , [test('Pronoun.id_check()') === false, 'a literal respond_to on a primitive is false, not a throw']
        , [test('Pronoun.respond_to?("title")') === true, 'a literal respond_to finds a real method']
        , [rgss.evaluateValue({ source: 'stored', js: '$game_temp.title = "kept"; return $game_temp.title();' }, { game }, events[0]) === 'kept', 'a stored shim value under a method name still answers as a call']
        , [liftKeyed === true, 'the async lift awaits a class-named call exactly when that class agrees']
        , [transpileUnit({ name: 'safenav', kind: 'const', methods: new Set(), sends: new Set(), consts: new Set(), pieces: [{ script: 'S', text: 'module SafeNav\n  def self.check(env)\n    env&.climate == :Cave\n  end\nend' }] }).includes('=='), 'safe navigation keeps == comparisons instead of rewriting them into assignments']
        , [selfStaticHit === 14, 'a static initializer reading its own class path means this']
        , [guardedConstantHit === 205, 'guarded Ruby module constants transpile to a valid exported constant']
        , [setterProbeHit === true, 'respond_to?(:writer=) checks the current Ruby object setter']
        , [singletonAccessorHit, 'singleton-class attr_accessor preserves its static setter syntax']
        , [accessorOrHit, 'Ruby accessor ||= reads the accessor then invokes its setter']
        , [mapRecordHit, 'RPG::Map data fields remain properties when Ruby accessors share their names']
        , [rubyStringTypeHit, 'Ruby String and Symbol type checks accept primitive JavaScript strings']
        , [plainAliasHit, 'a plain Ruby alias captures a method reference without invoking it during library load']
        , [reinitializedClassHit, 'initialize aliases across inconsistently indented class reopenings keep one constructor and chain both bodies']
        , [lateMixinHit === 'function|function|function|42', `a Ruby include resolves its module when the definition appears later in the script set (${lateMixinHit}; ${Object.keys(lateMixinLibrary.units)}; ${lateMixinLibrary.units.Container?.slice(0, 400)})`]
        , [nestedConstHit === 42, 'a nested Ruby class constant resolves inside its owner after transpilation']
        , [test('SelfNamespace.COPY') === true, 'self-qualified Ruby namespace constants resolve during module initialization']
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
        rpg_core: "function JsonEx() {}\nJsonEx.stringify = function (o) { return JSON.stringify(o); };\nJsonEx.parse = function (t) { return JSON.parse(t); };\nfunction Game_Interpreter() { this._eventId = 0; }\nGame_Interpreter.prototype.pluginCommand = function () {};\nfunction Game_Variables() {}\nfunction TextManager() {}",
        rpg_objects: "function Game_System() { this._flag = 0; }\nfunction Game_Screen() { this._tone = 1; }\nfunction Game_Timer() { this._frames = 0; }\nfunction Game_Party() { this._gold = 0; this._items = {}; this._weapons = {}; this._armors = {}; this._actors = []; }\nGame_Party.prototype.gold = function () { return this._gold; };\nGame_Party.prototype.gainGold = function (n) { this._gold += n; };\nfunction Game_Actors() { this._data = []; }\nGame_Actors.prototype.actor = function (id) { return this._data[id] || (this._data[id] = { id: id, hp: 10 }); };"
      },
      sources: { Extra: "Game_Party.prototype.bonus = function () { this.gainGold(10); this._visits = (this._visits || 0) + 1; return this.gold(); };\nGame_Variables.prototype.twice = function (id) { this.setValue(id, this.value(id) * 2); };\nvar _pc = Game_Interpreter.prototype.pluginCommand;\nGame_Interpreter.prototype.pluginCommand = function (c, a) { _pc.call(this, c, a); if (c === 'Bump') { $gameVariables.setValue(5, Number(a[0]) + this._eventId); $gameVariables.twice(5); } };\nTextManager.convertEscapeCharacters = function (t) { t = t.replace(/\\\\/g, '\\x1b'); return t.replace(/\\x1bTEST\\[(\\d+)\\]/gi, function () { return 'g' + $gameParty.gold(); }); };\nTextManager.convertExtraEscapeCharacters = function (t) { return t.replace(/\\x1bGAME\\[(\\d+)\\]/gi, function () { return 'G' + arguments[1]; }); };" }
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
      const noEngine = createRgssRuntime({ rpgExtra, mover: { x: 1, y: 1 }, facing: 'down', project, presentDialogue() {}, playSound() {} }, { mapId: 1, mapEvents: [], dialect: 'mv', pluginLibrary: { ...pluginLibrary, engine: [], engineSources: {}, sources: {}, order: [] } });
      const unknownStillFalse = noEngine.pluginCommand('Bump', [], { game }, { id: 0 }) === false;
      const noChainNull = noEngine.convertDisplayText('x \\TEST[1]', { game }, { id: 0 }) === null;
      const gameEscapeChain = make().convertDisplayText('Hi \\TEST[2] and \\GAME[3]', { game }, { id: 0 }) === `Hi g${rpgExtra.gold} and G3`;
      results = [gameEscapeChain, noChainNull, pluginRan, unknownStillFalse, bonus === 13, rpgExtra.gold === 13, ev(second, '$gameSystem._flag') === 7, ev(second, '$gameActors._data[1].hp') === 4, ev(second, '$gameParty._visits') === 1, ev(second, '$gameScreen._tone') === 9 && ev(second, '$gameTimer._frames') === 30, ev(second, '$gameParty.gold()') === 13];
    } finally { console.warn = originalWarn; console.info = originalInfo; }
    if (results.every(Boolean)) notes.push('mv engine layer ok (11 checks: plugin method on real class, plugin commands through Game_Interpreter, the game TextManager escape chain (base + extra halves), null without a chain, rpgExtra bridge, reload persistence)'); else fail(`mv engine layer: ${JSON.stringify(results)}`);
  }
  // Audio: the adapter over mwg' AudioBus (>= 0.18): format resolution, loop tags, mixer scaling,
  // ME/BGM resume, state round-trip, MIDI through the library's parser/renderer + SoundFont (worker
  // render bit-identity and sync fallback, >= 0.20), the render cache, and the converter's index,
  // against a fake AudioContext (no browser needed).
  {
    const lib = await import('@datamoc/mwg/audio');
    const { AudioManager, chooseExtension } = await import(pathToFileURL(join(root, 'src', 'player', 'audio-manager.js')).href);
    const { buildAudioIndex } = await import(pathToFileURL(join(root, 'tools', 'audio-index.mjs')).href);
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const checks = [];
    checks.push(chooseExtension(['.wma', '.mp3', '.ogg']) === '.ogg' && chooseExtension(['.mid', '.wav']) === '.wav' && chooseExtension(['.mid']) === '.mid');
    // a real Ogg Vorbis comment header with loop points, read by the library's parser and turned into a loop region
    const oggPage = packet => { const header = new Uint8Array(27); header.set([0x4f, 0x67, 0x67, 0x53]); header[26] = 1; return Uint8Array.from([...header, packet.length, ...packet]); };
    const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
    const comments = ['LOOPSTART=1000', 'LOOPLENGTH=2000'].map(text => new TextEncoder().encode(text));
    const commentPacket = [3, ...new TextEncoder().encode('vorbis'), ...u32(1), 0x78, ...u32(comments.length), ...comments.flatMap(c => [...u32(c.length), ...c])];
    const loopOgg = Uint8Array.from([...oggPage([1, ...new TextEncoder().encode('vorbis')]), ...oggPage(commentPacket)]);
    checks.push(JSON.stringify(lib.parseVorbisLoopTags(loopOgg)) === JSON.stringify({ loopStart: 1000, loopLength: 2000 }) && lib.parseVorbisLoopTags(new Uint8Array(20)) === null);
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
      // 0.20+: the worker render is present and bit-identical to the sync path.
      checks.push(typeof lib.renderMidiToBufferAsync === 'function');
      const asyncRendered = await lib.renderMidiToBufferAsync(bytes, { soundFontBytes: sf2 });
      checks.push(asyncRendered.sampleRate === sampled.sampleRate && asyncRendered.loopStart === sampled.loopStart &&
        asyncRendered.left.length === sampled.left.length &&
        asyncRendered.left.every((value, index) => value === sampled.left[index]) &&
        asyncRendered.right.every((value, index) => value === sampled.right[index]));
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
      // The manager falls back to the sync render when the library predates the worker path.
      const syncLib = { ...lib };
      delete syncLib.renderMidiToBufferAsync;
      const syncCache = new Map();
      const syncOnly = make({ ...options, lib: syncLib, renderCache: { get: async key => syncCache.get(key) ?? null, set: async (key, value) => { syncCache.set(key, value); } } });
      await syncOnly.playBgm({ name: 'Song' }); await settle();
      checks.push(syncOnly.isPlaying('bgm') && syncCache.size === 1);
    }
    if (checks.every(Boolean)) notes.push(`audio adapter over mwg ${lib.AudioBus ? 'AudioBus' : '?'}, MIDI + SoundFont and index ok (${checks.length} checks)`); else fail(`audio manager: ${JSON.stringify(checks)}`);
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
    const shim = { dialect: 'rgss', builtins: { Graphics: { type: 'object', members: ['update', 'frame_count'] }, Audio: { type: 'object', members: ['se_play', 'bgm_play'] } } };
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
    const { decodeRgssMarshal } = await import(pathToFileURL(join(root, 'tools', 'rgss-marshal.mjs')).href);
    const { encodeRubyValue } = await import(pathToFileURL(join(root, 'tools', 'rgss-data.mjs')).href);
    const str = text => [text.length + 5, ...Buffer.from(text)];
    const marshal = Uint8Array.from([4, 8, 73, 67, 58, ...str('PBAnimations'), 91, 7, 105, 6, 105, 7, 6, 58, ...str('@selected'), 105, 6]);
    const decoded = decodeRgssMarshal(marshal, () => { throw new Error('unsupported tag "C" (0x43)'); });
    const json = encodeRubyValue(decoded);
    if (json?.$rubySubclass?.class === 'PBAnimations' && json.$rubySubclass.value.join() === '1,2' && json.$rubySubclass.ivars['@selected'] === 1) notes.push('RGSS Marshal C subclass with ivars ok');
    else fail(`RGSS Marshal C subclass: ${JSON.stringify(json)}`);
  }
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
    // 8. Force Action (command 339): a troop event makes a battler act at once. The engine skips canUse for a forced
    //    action but still pays the cost: the hero (3 MP) is forced to cast Fire (5 MP) at the Boss and ends at 0 MP;
    //    the Boss is forced to attack (the hero loses HP); a forced hero attack kills the lone Slime, and forcing the
    //    dead Slime afterwards is skipped.
    {
      const drive = async (troopId, body, records) => {
        let controls; const p = player(['Escape']); const out = {};
        await runBattle({ database: database(), troopId, party: [1], records, items: {}, present: p.present, rng: () => 0, canEscape: true,
          hooks: { onControls: value => { controls = value; }, onStart: async () => { await body(controls, out); } } });
        return out;
      };
      const r1 = { 1: { level: 1, classId: 1, hp: 100, mp: 3 } };
      const boss = await drive(3, async (c, out) => {
        out.hero = await c.forceAction({ subjectKind: 'actor', subject: 1, skillId: 3, target: 0 });
        out.boss = await c.forceAction({ subjectKind: 'enemy', subject: 0, skillId: 1, target: -1 });
      }, r1);
      checks.push(boss.hero === true && boss.boss === true && r1[1].mp === 0 && r1[1].hp < 100);
      const slime = await drive(1, async (c, out) => {
        out.kill = await c.forceAction({ subjectKind: 'actor', subject: 1, skillId: 1, target: 0 });
        out.again = await c.forceAction({ subjectKind: 'enemy', subject: 0, skillId: 1, target: -2 });
        out.unknown = await c.forceAction({ subjectKind: 'actor', subject: 99, skillId: 1, target: 0 });
      }, { 1: { level: 1, classId: 1, hp: 100, mp: 20 } });
      checks.push(slime.kill === true && slime.again === false && slime.unknown === false);
    }
    // 9. Abort Battle (command 340) ends the fight at once with the escape result and no rewards.
    {
      let controls; const p = player(['Fight', 'Attack']); const gained = { gold: 0 };
      const aborted = await runBattle({ database: database(), troopId: 1, party: [1], records: { 1: { level: 1, classId: 1, hp: 100, mp: 20 } }, items: {}, present: p.present, rng: () => 0, canEscape: true,
        hooks: { onControls: value => { controls = value; }, onStart: async () => { controls.abort(); }, gainGold: amount => { gained.gold += amount; } } });
      checks.push(aborted.outcome === 'escape' && gained.gold === 0 && aborted.exp === 0);
    }
    // 10. Counter attack, magic reflection, substitute and TP (Game_Action / BattleManager.invokeAction rules).
    {
      const mech = () => {
        const db = database();
        db.skills[5] = { name: 'Charge', hitType: 1, scope: 1, successRate: 100, mpCost: 0, tpCost: 0, tpGain: 20, speed: 0, repeats: 1, stypeId: 1, damage: { type: 1, formula: 'a.atk * 4', variance: 0, critical: false, elementId: -1 }, effects: [] };
        db.skills[6] = { name: 'Ultimate', hitType: 1, scope: 1, successRate: 100, mpCost: 0, tpCost: 50, tpGain: 0, speed: 0, repeats: 1, stypeId: 1, damage: { type: 1, formula: '1', variance: 0, critical: false, elementId: -1 }, effects: [] };
        const base = { params: [1000, 0, 12, 5, 5, 5, 8, 8], exp: 0, gold: 0, dropItems: [], actions: [{ skillId: 1, rating: 5, conditionType: 0 }] };
        const hit = { code: 22, dataId: 0, value: 0.95 };
        db.enemies[4] = { ...base, name: 'Guardian', traits: [hit, { code: 62, dataId: 2, value: 1 }] };     // special flag: substitute
        db.enemies[5] = { ...base, name: 'Thorn', traits: [hit, { code: 22, dataId: 6, value: 1 }] };         // CNT 100%
        db.enemies[6] = { ...base, name: 'Mirror', traits: [hit, { code: 22, dataId: 5, value: 1 }] };        // MRF 100%
        db.troops[5] = { members: [{ enemyId: 1 }, { enemyId: 4 }] }; db.troops[6] = { members: [{ enemyId: 5 }] }; db.troops[7] = { members: [{ enemyId: 6 }] };
        return db;
      };
      const fight = async (troopId, body, { hp = 100, tpRandom = () => 0 } = {}) => {
        const out = {}; let controls; const p = player(['Escape']);
        const record = { level: 1, classId: 1, hp, mp: 20 };
        await runBattle({ database: mech(), troopId, party: [1], records: { 1: record }, items: {}, present: p.present, rng: () => 0, tpRandom, canEscape: true,
          hooks: { onControls: value => { controls = value; }, onSetup: ({ actors, enemies }) => { out.actors = actors; out.enemies = enemies; }, onStart: async () => { await body(controls, out); } } });
        out.record = record; return out;
      };
      const force = (c, skillId, target = 0, kind = 'actor', subject = 1) => c.forceAction({ subjectKind: kind, subject, skillId, target });
      // Counter: the hero's physical attack on Thorn is answered instead of landing.
      const counter = await fight(6, async (c, out) => { out.hpBefore = out.actors[0].hp; await force(c, 1); out.after = { hero: out.actors[0].hp, thorn: out.enemies[0].hp }; });
      checks.push(counter.after.thorn === 1000 && counter.after.hero < counter.hpBefore);
      // Reflection: the hero's Fire (magical) at Mirror is turned back on the hero.
      const reflect = await fight(7, async (c, out) => { await force(c, 3); out.after = { hero: out.actors[0].hp, mirror: out.enemies[0].hp }; });
      checks.push(reflect.after.mirror === 1000 && reflect.after.hero < 100);
      // Substitute: with the first Slime dying (hp 5 < 30 / 4), the Guardian takes the hit for it.
      const substitute = await fight(5, async (c, out) => { out.enemies[0].hp = 5; await force(c, 1, 0); out.after = { slime: out.enemies[0].hp, guardian: out.enemies[1].hp }; });
      checks.push(substitute.after.slime === 5 && substitute.after.guardian < 1000);
      // TP: a skill's tpGain adds to the user; a hit taken charges 50 * damage / max HP; tpCost gates and is paid.
      const tp = await fight(3, async (c, out) => {
        out.start = out.actors[0].tp;
        await force(c, 5); out.afterCharge = out.actors[0].tp;
        const hpBefore = out.actors[0].hp; await force(c, 1, 0, 'enemy', 0);
        out.damage = hpBefore - out.actors[0].hp; out.afterHit = out.actors[0].tp;
        out.actors[0].tp = 60; await force(c, 6); out.afterCost = out.actors[0].tp;
      });
      checks.push(tp.start === 0 && tp.afterCharge === 20 && tp.afterHit === 20 + Math.floor(50 * tp.damage / 100) && tp.afterCost === 10);
      checks.push(tp.record.tp === 0);                                                    // not preserved: cleared after the battle
      // Preserve TP (special flag 3) keeps the value in the actor record.
      const keep = mech(); keep.classes[1].traits.push({ code: 62, dataId: 3, value: 1 });
      const keepRecord = { level: 1, classId: 1, hp: 100, mp: 20, tp: 40 };
      await runBattle({ database: keep, troopId: 3, party: [1], records: { 1: keepRecord }, items: {}, present: player(['Escape']).present, rng: () => 0, canEscape: true });
      checks.push(keepRecord.tp === 40);
    }
    // 11. Formations (src/player/formation.js): shapes, rows, modifiers, and their effect on who is hit and how hard.
    {
      const { layoutFormation, rowModifiers, stagePositions, FORMATION_NAMES } = await import(pathToFileURL(join(root, 'src', 'player', 'formation.js')).href);
      const sizes = (name, n) => { const slots = layoutFormation(name, n); return Array.from({ length: slots[0]?.rows || 0 }, (_, row) => slots.filter(slot => slot.row === row).length); };
      checks.push(JSON.stringify(sizes('triangle', 6)) === '[1,2,3]' && JSON.stringify(sizes('inverted', 6)) === '[3,2,1]');
      checks.push(JSON.stringify(sizes('square', 4)) === '[2,2]' && JSON.stringify(sizes('line', 4)) === '[4]' && JSON.stringify(sizes('column', 3)) === '[1,1,1]');
      checks.push(JSON.stringify(sizes('diamond', 4)) === '[1,2,1]' && layoutFormation('chevron', 5)[0].row === 0 && layoutFormation('circle', 5).length === 5);
      checks.push(FORMATION_NAMES.every(name => [1, 2, 3, 4, 5, 6].every(n => layoutFormation(name, n).length === n)) && layoutFormation('nonsense', 3).length === 3);
      const lead = layoutFormation('triangle', 3)[0];
      checks.push(lead.row === 0 && lead.y === 0);                                                        // the leader is the apex
      checks.push(rowModifiers(0, 3).tgr === 1.5 && rowModifiers(2, 3).pdr === 0.85 && rowModifiers(1, 3).tgr === 1 && rowModifiers(0, 1).tgr === 1);
      const spots = stagePositions('square', 4);
      checks.push(spots.length === 4 && new Set(spots.map(spot => `${spot.x},${spot.y}`)).size === 4);
      // In battle: two actors in a triangle (front apex, back row). Enemies pick the front one more often, and
      // the back row takes less physical damage. A line (one row) is neutral.
      const duo = formation => {
        const db = database(); db.actors[2] = { ...db.actors[1], name: 'Sidekick' };
        return { db, formation };
      };
      const runDuo = async (formation, rngValue, target, body) => {
        const { db } = duo(formation); const out = { effects: [] }; let controls; const p = player(['Escape']);
        const records = { 1: { level: 1, classId: 1, hp: 100, mp: 20 }, 2: { level: 1, classId: 1, hp: 100, mp: 20 } };
        await runBattle({ database: db, troopId: 3, party: [1, 2], records, items: {}, present: p.present, rng: () => rngValue, canEscape: true, formation,
          hooks: { onControls: value => { controls = value; }, onSetup: ({ actors }) => { out.actors = actors; },
            onEffect: effect => out.effects.push(effect), onStart: async () => { await controls.forceAction({ subjectKind: 'enemy', subject: 0, skillId: 1, target }); } } });
        out.hp = [out.actors[0].hp, out.actors[1].hp]; return out;
      };
      const triangle = await runDuo('triangle', 0.6, -1), line = await runDuo('line', 0.6, -1);
      checks.push(triangle.hp[0] < 100 && triangle.hp[1] === 100);                                       // TGR 1.5 vs 0.6: roll 1.26 lands on the front actor
      checks.push(line.hp[0] === 100 && line.hp[1] < 100);                                               // equal rates: roll 1.2 lands on the second
      const front = await runDuo('triangle', 0, 0), back = await runDuo('triangle', 0, 1);
      checks.push((100 - front.hp[0]) > (100 - back.hp[1]) && (100 - back.hp[1]) > 0);                   // x1.10 physical vs x0.85
      checks.push(front.effects.length === 1 && front.effects[0].kind === 'hit' && front.effects[0].hp < 0 && front.effects[0].target === front.actors[0]);
    }
    // 12. Actor poses (Sprite_Actor motions on the 9x6 sv_actors sheet) and the choice of pose.
    {
      const { svCell, svPattern, svIdleMotion, svActionMotion, SV_MOTIONS } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
      // wait (index 1) is row 1, columns 0-2; thrust (6) is column 3 row 0; victory (13) column 6 row 1; dead (17) column 6 row 5.
      checks.push(svCell('wait', 0) === 9 && svCell('wait', 2) === 11 && svCell('thrust', 1) === 4 && svCell('victory', 0) === 15 && svCell('dead', 2) === 53);
      checks.push(Object.keys(SV_MOTIONS).length === 18 && new Set(Object.values(SV_MOTIONS).map(motion => motion.index)).size === 18);
      const seq = (name, steps) => steps.map(step => svPattern(name, step * 0.2 + 0.01).pattern).join('');
      checks.push(seq('wait', [0, 1, 2, 3, 4]) === '01210' && seq('swing', [0, 1, 2]) === '012' && svPattern('swing', 0.61).done === true && svPattern('swing', 0.59).done === false);
      const db = database(); db.states[5] = { name: 'Sleep', motion: 2, priority: 50, restriction: 4, traits: [] }; db.states[6] = { name: 'Poison', motion: 1, priority: 30, traits: [] };
      const battler = overrides => ({ states: [], dead: false, isGuarding: false, isDying: false, ...overrides });
      checks.push(svIdleMotion(battler({}), db) === 'wait' && svIdleMotion(battler({ dead: true }), db) === 'dead' && svIdleMotion(battler({ isDying: true }), db) === 'dying');
      checks.push(svIdleMotion(battler({ isGuarding: true, isDying: true }), db) === 'guard' && svIdleMotion(battler({ states: [{ id: 6 }], isDying: true }), db) === 'abnormal');
      checks.push(svIdleMotion(battler({ states: [{ id: 5 }, { id: 6 }] }), db) === 'sleep');                       // higher priority state wins
      db.system.attackMotions = [{ type: 0 }, { type: 1 }, { type: 2 }]; db.system.magicSkills = [1];
      const armed = wtypeId => battler({ equipItems: () => [{ wtypeId }] });
      checks.push(svActionMotion(armed(0), db.skills[1], false, db) === 'thrust' && svActionMotion(armed(1), db.skills[1], false, db) === 'swing' && svActionMotion(armed(2), db.skills[1], false, db) === 'missile');
      checks.push(svActionMotion(armed(1), db.skills[3], false, db) === 'spell' && svActionMotion(armed(1), { stypeId: 2 }, false, db) === 'skill' && svActionMotion(armed(1), db.items[1], true, db) === 'item');
    }
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
      // Formation: pick a layout, then swap the two members' order; the party array is reordered in place.
      {
        const db = menuDb(); db.actors[2] = { ...db.actors[1], name: 'Sidekick' }; db.system.terms.commands[8] = 'Formation';
        const party = [1, 2]; let layout = 'default';
        const p = player(['Formation', 'Layout: Default (staggered) (1-1)', 'Triangle  1-1', 'Change order', '1. Hero', '2. Sidekick', 'Cancel', 'Cancel']);
        await runMenu({ database: db, records: { 1: { level: 1, classId: 1 }, 2: { level: 1, classId: 1 } }, party, items: {}, weapons: {}, armors: {}, gold: 0, present: p.present, rng: () => 0,
          hooks: { maxBattleMembers: 4, formation: { get: () => layout, set: name => { layout = name; } } } });
        mchecks.push(layout === 'triangle' && party.join() === '2,1');
        const hidden = await menuRun(['Cancel']);                                                       // no hook: no Formation entry
        mchecks.push(!hidden.log.some(text => text.includes('Formation')));
      }
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
      // What the editor edits on the actor shows here, through the battle's own rule: the database profile,
      // a scalar `params[pid]` override and the MV `bparams` bonus all reach the Max HP the player reads.
      const statusRun = async (mutate, plan) => {
        const db = menuDb(); mutate(db); const p = player([...plan]);
        await runMenu({ database: db, records: { 1: { level: 1, classId: 1, hp: 100, mp: 20 } }, party: [1], items: {}, weapons: {}, armors: {}, gold: 5, present: p.present, rng: () => 0, hooks: {} });
        return p.log;
      };
      mchecks.push((await statusRun(db => { db.actors[1].profile = 'A tested hero'; }, ['Status', 'Hero', 'Cancel'])).some(text => text.includes('A tested hero')));
      mchecks.push((await statusRun(db => { db.actors[1].params = [500]; }, ['Status', 'Hero', 'Cancel'])).some(text => /100\/500/.test(text)));
      mchecks.push((await statusRun(db => { db.actors[1].bparams = [50, 0, 0, 0, 0, 0, 0, 0]; }, ['Status', 'Hero', 'Cancel'])).some(text => /100\/150/.test(text)));
      // Unknown page triggers warn once per page (loud), instead of the page silently never firing.
      {
        const { checkPageTriggers } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
        const triggerWarns = [];
        const realWarn = console.warn; console.warn = text => { triggerWarns.push(String(text)); };
        try {
          const pageMap = { id: 7, mwgEvents: [{ id: 1, pages: [{ trigger: 'action' }, { trigger: 'playerTouch' }] }] };
          checkPageTriggers(pageMap); checkPageTriggers(pageMap);
          checkPageTriggers({ id: 8, mwgEvents: [{ id: 1, pages: [{ trigger: 'touch' }, { trigger: 'parallel' }] }] });
        } finally { console.warn = realWarn; }
        mchecks.push(triggerWarns.length === 1 && triggerWarns[0].includes('playerTouch'));
      }
      checks.push(mchecks.every(Boolean));
      if (!mchecks.every(Boolean)) fail(`menu screens: ${JSON.stringify(mchecks)} skill hp ${skillMenu.records[1].hp}/${skillMenu.records[1].mp} equip ${JSON.stringify(equipMenu.records[1].equips)} ${JSON.stringify(equipMenu.weapons)}`);
    }
    if (checks.every(Boolean)) notes.push(`battle runner and menu screens ok (${checks.length} checks: win/level-up/drops, escape, defeat, items, MP skills, states, formula safety, item/skill/equip/status/save menus, editor-editable profile/stats, unknown-trigger warnings)`); else fail(`battle runner: ${JSON.stringify(checks)} potion log: ${JSON.stringify(potion.log)} items ${JSON.stringify(potion.items)}`);
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
    const counters = { ...extra, steps: 42, playtime: 3725.9, timer: { seconds: 12.4, working: true }, saveCount: 3, battleCount: 5, winCount: 4, escapeCount: 2 };
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
      [resolveGameDataOperand(counters, context, { kind: 'steps' }) === 42, 'steps reads the walking counter'],
      [resolveGameDataOperand(counters, context, { kind: 'playtime' }) === 3725, 'playtime reads whole seconds'],
      [resolveGameDataOperand(counters, context, { kind: 'timer' }) === 13, 'timer reads the countdown'],
      [resolveGameDataOperand(counters, context, { kind: 'saveCount' }) === 3, 'save count reads saved games'],
      [resolveGameDataOperand(counters, context, { kind: 'battleCount' }) === 5, 'battle count reads battles run'],
      [resolveGameDataOperand(counters, context, { kind: 'winCount' }) === 4, 'win count reads battles won'],
      [resolveGameDataOperand(counters, context, { kind: 'escapeCount' }) === 2, 'escape count reads escapes']
    ];
    const originalWarn = console.warn; console.warn = () => {};
    let unknownKind;
    try { unknownKind = resolveGameDataOperand(extra, context, { kind: 'actorStat' }); }
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
            { code: 111, indent: 0, parameters: [1, 42, 0, 5, 0] }, { code: 412, indent: 0, parameters: [] },
            { code: 111, indent: 0, parameters: [1, 42, 0, 5, 1] }, { code: 412, indent: 0, parameters: [] },
            { code: 111, indent: 0, parameters: [1, 42, 0, 5, 2] }, { code: 412, indent: 0, parameters: [] },
            { code: 111, indent: 0, parameters: [1, 42, 0, 5, 5] }, { code: 412, indent: 0, parameters: [] },
            { code: 111, indent: 0, parameters: [1, 43, 1, 44, 3] }, { code: 412, indent: 0, parameters: [] },
            { code: 122, indent: 0, parameters: [9, 9, 0, 3, 7, 3, 0] },
            { code: 122, indent: 0, parameters: [10, 10, 0, 3, 7, 4, 0] },
            { code: 122, indent: 0, parameters: [11, 11, 0, 3, 7, 5, 0] },
            { code: 122, indent: 0, parameters: [12, 12, 0, 3, 7, 6, 0] },
            { code: 122, indent: 0, parameters: [13, 13, 0, 3, 7, 7, 0] },
            { code: 122, indent: 0, parameters: [14, 14, 0, 3, 7, 8, 0] },
            { code: 122, indent: 0, parameters: [15, 15, 0, 3, 7, 9, 0] },
            { code: 134, indent: 0, parameters: [0] }, { code: 135, indent: 0, parameters: [0] },
            { code: 124, indent: 0, parameters: [0, 90] },
            { code: 111, indent: 0, parameters: [3, 30, 1] }, { code: 412, indent: 0, parameters: [] },
            { code: 206, indent: 0, parameters: [] },
            { code: 261, indent: 0, parameters: ['intro'] },
            { code: 339, indent: 0, parameters: [0, 0, 1, -2] },
            { code: 312, indent: 0, parameters: [0, 0, 1, 0, 5] }, { code: 315, indent: 0, parameters: [1, 2, 0, 1, 7, true] },
            { code: 317, indent: 0, parameters: [0, 0, 2, 0, 0, 3] }, { code: 326, indent: 0, parameters: [0, 0, 1, 0, 10] },
            { code: 320, indent: 0, parameters: [1, 'Ann'] }, { code: 324, indent: 0, parameters: [1, 'Ace'] }, { code: 325, indent: 0, parameters: [1, 'Bio'] },
            { code: 322, indent: 0, parameters: [1, 'Actor2', 3, 'Face', 1, 'Battler'] },
            { code: 138, indent: 0, parameters: [[10, 20, 30]] }, { code: 132, indent: 0, parameters: [{ name: 'Battle9', volume: 90, pitch: 100, pan: 0 }] },
            { code: 140, indent: 0, parameters: [1, { name: 'Sea', volume: 90, pitch: 100, pan: 0 }] }, { code: 323, indent: 0, parameters: [1, 'Vehicle', 2] },
            { code: 216, indent: 0, parameters: [1] }, { code: 217, indent: 0, parameters: [] }, { code: 281, indent: 0, parameters: [1] },
            { code: 354, indent: 0, parameters: [] },
            { code: 104, indent: 0, parameters: [3, 2] }, { code: 233, indent: 0, parameters: [1, 6] },
            { code: 285, indent: 0, parameters: [4, 0, 0, 1, 2] }, { code: 283, indent: 0, parameters: ['Grassland', 'Forest'] },
            { code: 333, indent: 0, parameters: [0, 0, 4] }, { code: 334, indent: 0, parameters: [-1] }, { code: 337, indent: 0, parameters: [0, 5, false] },
            { code: 282, indent: 0, parameters: [2] }, { code: 284, indent: 0, parameters: ['Sky', true, false, 2, 0] },
            { code: 340, indent: 0, parameters: [] }, { code: 342, indent: 0, parameters: [0, 0, 0, 25] },
            { code: 0, indent: 0, parameters: [] }
          ],
          moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: false, skippable: false, wait: false },
          moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true
        }]
      }]
    });
    mkdirSync(join(mzDir, 'movies'), { recursive: true });
    writeFileSync(join(mzDir, 'movies', 'intro.webm'), Buffer.from('webm'));
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
      const cv = await import(pathToFileURL(join(root, 'tools', 'converter-version.mjs')).href);
      const oldManifest = join(mzDir, 'old-mwgp.json');
      writeFileSync(oldManifest, JSON.stringify({ format: 'MWGP', version: 1, source: {} }));
      const mzChecks = [
        [mzManifest.source?.engine === 'rpg-maker-mz', 'probe detected as MZ'],
        [mzEventText.includes('"pluginCommand"'), 'MZ 357 converts to pluginCommand'],
        [!mzEventText.includes('"unsupported"'), 'MZ probe has no loud markers'],
        [mzEventText.includes('"else":[]'), 'branch without else keeps an empty else list'],
        [mzManifest.compatibility?.commands?.['357']?.status === 'partial', 'MZ 357 classified partial'],
        [mzManifest.compatibility?.plugins?.['MessageRows']?.status === 'unsupported' && !mzManifest.compatibility.plugins.MessageRows.handledBy, 'MZ plugin census covers 357 names (no shipped plugin: unsupported)'],
        [mzEventText.includes('"plugin":"DemoPlugin"') && mzEventText.includes('"params":{"rows":"6"}'), 'MZ 357 keeps its plugin name and args object'],
        [mzFg.foreground?.name === 'Mist_1' && mzFg.foreground?.loopX === true && mzFg.foreground?.sx === -1.4, 'map <fgName> note parses to settings.foreground'],
        [mzFg.foregroundB?.name === 'Mist_2' && mzFg.foregroundB?.switch === 11, 'map <fgName_b> note parses to settings.foregroundB with its switch'],
        [mzManifest.assets?.parallaxes === true, 'referenced foreground art flags assets.parallaxes'],
        [mzEventText.includes('"systemFlag":{"key":"menuAccess","value":false}') && mzEventText.includes('"key":"saveAccess"'), '134/135 convert to systemFlag (menu and save access)'],
        [mzEventText.includes('"timer":{"start":90}') && mzEventText.includes('"timer":{"seconds":30,"atLeast":false}'), '124 and the timer condition convert'],
        [mzEventText.includes('"vehicleBoard":true') && mzEventText.includes('"playMovie":{"name":"intro"}') && mzEventText.includes('"returnToTitle":true'), '206, 261 and 354 convert'],
        [mzEventText.includes('"forceAction":{"subjectKind":"enemy","subject":0,"skill":1,"target":-2}'), '339 converts to forceAction'],
        [['mp', 'exp', 'param', 'tp'].every(stat => mzEventText.includes(`"stat":"${stat}"`)), '312/315/317/326 convert to changeActorStat'],
        [mzEventText.includes('"changeActorImages"') && mzEventText.includes('"changeProfile":{"actor":1,"profile":"Bio"}') && !mzEventText.includes('"profile":"Actor2"'), '322 is Change Actor Images and 325 is Change Profile'],
        [!mzEventText.includes('"unsupported"'), 'none of the new codes fall back to the loud marker'],
        [cv.readManifestConverterVersion(join(mzOut, 'mwgp.json')) === cv.CONVERTER_VERSION && !cv.isStaleConverterVersion(cv.CONVERTER_VERSION), 'the manifest carries the converter stamp near its start and is current'],
        [cv.readManifestConverterVersion(oldManifest) === null && cv.isStaleConverterVersion(null) && cv.isStaleConverterVersion('0.1.0') && !cv.isStaleConverterVersion('0.10.0') && cv.compareVersions('0.2.0', '0.10.0') === -1, 'an unstamped or older manifest is stale (numeric version compare)'],
        [existsSync(join(mzOut, 'assets', 'movies', 'intro.webm')), 'a movie named by 261 is copied to assets/movies'],
        [mzEventText.includes('"selectItem":{"variable":"3","itemType":2}') && mzEventText.includes('"rotatePicture":{"id":1,"speed":6}') && mzEventText.includes('"locationInfo":{"variable":"4","info":0,"x":1,"y":2}'), '104, 233 and 285 convert'],
        [mzEventText.includes('"changeEnemyState":{"index":0,"add":true,"state":4}') && mzEventText.includes('"enemyRecoverAll":{"index":-1}') && mzEventText.includes('"changeEnemyTp":{"index":0,"amount":25,"sign":1}') && mzEventText.includes('"abortBattle":true'), '333 is enemy state, 334 recover all, 342 enemy TP, 340 abort'],
        [mzEventText.includes('"changeTileset":{"id":2}'), '282 converts to changeTileset'],
        [mzEventText.includes('"changeParallax":{"name":"Sky","loopX":true,"loopY":false,"sx":2,"sy":0}'), '284 converts to changeParallax'],
        [mzEventText.includes('"variable":"42","operator":"eq","value":5'), '111 operator 0 is equal-to (MV editor order, not the VX order)'],
        [mzEventText.includes('"variable":"42","atLeast":5'), '111 operator 1 (>= constant) collapses to the mwg atLeast form'],
        [mzEventText.includes('"variable":"42","operator":"lte","value":5') && mzEventText.includes('"variable":"42","operator":"neq","value":5'), '111 operators 2 and 5 convert as <= and !='],
        [mzEventText.includes('"variable":"43","operator":"gt","compareVariable":"44"'), '111 variable-vs-variable comparison keeps the second variable'],
        [['steps', 'playtime', 'timer', 'saveCount', 'battleCount', 'winCount', 'escapeCount'].every(kind => mzEventText.includes(`"gameData":{"kind":"${kind}"}`)), '122 game-data Other kinds convert: steps, playtime, timer, save/battle/win/escape count'],
        [mzEventText.includes('"key":"battleback"') && existsSync(join(mzOut, 'assets')), '283 converts to the battleback system setting']
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
  // Picture-command titles: MOG-style Command_0..N art in img/titles2 (stock
  // title names empty) records background/logo/commands plus the plugin's
  // button positions, so the title screen renders the game's own image menu.
  {
    const picDir = mkdtempSync(join(tmpdir(), 'mwgp-smoke-title-'));
    const writeJson = (rel, value) => writeFileSync(join(picDir, rel), JSON.stringify(value));
    writeFileSync(join(picDir, 'index.html'), '<!DOCTYPE html><html><body></body></html>');
    mkdirSync(join(picDir, 'js'), { recursive: true });
    mkdirSync(join(picDir, 'data'), { recursive: true });
    writeJson('data/System.json', { gameTitle: 'Pic Test', title1Name: '', title2Name: '', optDrawTitle: false, titleCommandWindow: { offsetX: 5, offsetY: -3 }, partyMembers: [], startMapId: 1, startX: 1, startY: 1 });
    writeJson('data/MapInfos.json', [null, { id: 1, expanded: false, name: 'Room', order: 1, parentId: 0 }]);
    const probePage = list => ({
      conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
      directionFix: false, image: { tileId: 0, characterName: '', direction: 2, pattern: 1, characterIndex: 0 }, list,
      moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: false, skippable: false, wait: false },
      moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true
    });
    writeJson('data/Map001.json', { width: 5, height: 5, tilesetId: 1, autoplayBgm: false, autoplayBgs: false, data: Array(150).fill(0), events: [null, { id: 1, name: 'EV001', note: '', x: 1, y: 1, pages: [probePage([
      { code: 356, indent: 0, parameters: ['ProbeCmd a b'] }, { code: 356, indent: 0, parameters: ['Nobody x'] }, { code: 356, indent: 0, parameters: ['FOO x'] },
      { code: 356, indent: 0, parameters: ['UiCmd x'] }, { code: 356, indent: 0, parameters: ['ChainCmd x'] },
      { code: 401, indent: 0, parameters: ['Hello \\FOO[1] and \\BAR[2]'] }, { code: 0, indent: 0, parameters: [] }
    ])] }] });
    writeJson('data/Tilesets.json', [null, { id: 1, mode: 0, name: 'Outside', tilesetNames: ['', '', '', '', '', '', '', '', ''], flags: [0] }]);
    // Plugin parameters that used to drive a named-plugin title (button positions, a screen size) must not.
    writeFileSync(join(picDir, 'js', 'plugins.js'), 'var $plugins = [{"name":"MOG_TitlePictureCom","status":true,"parameters":{"Title Sprite":"true","Command Pos 1":"800,410","Command Pos 2":""}},{"name":"YEP_CoreEngine","status":true,"parameters":{"Screen Width":"1440","Screen Height":"810"}},{"name":"Probe_Handler","status":true,"parameters":{}},{"name":"Title_Hook","status":true,"parameters":{}},{"name":"Escape_Handler","status":true,"parameters":{}},{"name":"Ui_Handler","status":true,"parameters":{}},{"name":"Chain_Handler","status":true,"parameters":{}}];');
    mkdirSync(join(picDir, 'loc'), { recursive: true });
    writeFileSync(join(picDir, 'loc', 'LocProbe.json'), JSON.stringify({ hello: { text: ['x'] } }));
    mkdirSync(join(picDir, 'js', 'plugins'), { recursive: true });
    writeFileSync(join(picDir, 'js', 'plugins', 'Probe_Handler.js'), "var _probe = Game_Interpreter.prototype.pluginCommand;\nGame_Interpreter.prototype.pluginCommand = function (command, args) { _probe.call(this, command, args); if (command === 'ProbeCmd') this._probed = args; };\n");
    writeFileSync(join(picDir, 'js', 'plugins', 'Title_Hook.js'), "var _titleBg = Scene_Title.prototype.createBackground;\nScene_Title.prototype.createBackground = function () { _titleBg.call(this); };\n");
    writeFileSync(join(picDir, 'js', 'plugins', 'Escape_Handler.js'), "var _esc = Game_Interpreter.prototype.pluginCommand;\nGame_Interpreter.prototype.pluginCommand = function (command, args) { _esc.call(this, command, args); if (command === 'FOO') this._escaped = args; };\n");
    // A command whose own code builds a window is partial (the player never runs the window layer); a command
    // that only calls a plugin-local helper which builds a sprite is partial too, through the helper.
    writeFileSync(join(picDir, 'js', 'plugins', 'Ui_Handler.js'), "var _ui = Game_Interpreter.prototype.pluginCommand;\nGame_Interpreter.prototype.pluginCommand = function (command, args) { _ui.call(this, command, args); if (command === 'UiCmd') this._uiWindow = new Window_Gold(); };\n");
    writeFileSync(join(picDir, 'js', 'plugins', 'Chain_Handler.js'), "var _chain = Game_Interpreter.prototype.pluginCommand;\nGame_Interpreter.prototype.pluginCommand = function (command, args) { _chain.call(this, command, args); if (command === 'ChainCmd') this._chainSprite = ChainPlugin.marker(); };\nvar ChainPlugin = {};\nChainPlugin.marker = function () { return new Sprite_Character(); };\n");
    mkdirSync(join(picDir, 'img', 'titles2'), { recursive: true });
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (const file of ['Background.png', 'Logo_1.png', 'Command_0.png', 'Command_1.png', 'Command_0_RU.png']) writeFileSync(join(picDir, 'img', 'titles2', file), tinyPng);
    const picOut = join(picDir, 'out');
    let picManifest;
    let picStderr = '';
    try {
      const picRun = spawnSync(process.execPath, [join(root, 'tools', 'convert-mv.js'), picDir, picOut], { encoding: 'utf8' });
      picStderr = String(picRun.stderr || '');
      if (picRun.status !== 0) throw new Error(String(picRun.stderr || picRun.message));
      picManifest = JSON.parse(readFileSync(join(picOut, 'mwgp.json'), 'utf8'));
    } catch (error) {
      fail(`title probe conversion failed: ${String(error.stderr || error.message).slice(0, 300)}`);
    }
    if (picManifest) {
      const pluginReport = picManifest.compatibility?.plugins || {};
      const picChecks = [
        [picManifest.titleScreen?.pictureCommands === undefined, 'no picture-command title from plugin names'],
        [picManifest.display?.width === 1440 && picManifest.display?.height === 810, 'screen size follows a plugin Screen Width/Screen Height pair, whatever the plugin is called'],
        [picManifest.titleScreen?.drawTitle === false, 'optDrawTitle recorded on the title screen'],
        [JSON.stringify(picManifest.titleScreen?.commandOffset) === '{"x":5,"y":-3}', 'title command offsets recorded'],
        [(picManifest.pluginLibrary?.order || []).includes('Probe_Handler'), 'the plugin handling an event plugin command ships in the plugin library'],
        [(picManifest.pluginLibrary?.order || []).includes('Title_Hook'), 'a plugin hooking Scene_Title ships in the plugin library (title scenes are visible surface)'],
        [pluginReport.ProbeCmd?.status === 'supported' && JSON.stringify(pluginReport.ProbeCmd?.handledBy) === '["Probe_Handler"]', 'a handled plugin command whose code stays in game state is supported and names its plugin'],
        [pluginReport.Nobody?.status === 'unsupported' && !pluginReport.Nobody?.handledBy, 'an unhandled plugin command is unsupported'],
        [pluginReport.UiCmd?.status === 'partial' && (pluginReport.UiCmd?.reaches || []).includes('Window_Gold'), 'a command building a window is partial and names what it reaches'],
        [pluginReport.ChainCmd?.status === 'partial' && (pluginReport.ChainCmd?.reaches || []).includes('Sprite_Character'), 'a command reaching the display layer only through a plugin-local helper is partial too'],
        [picManifest.compatibility?.commands?.['356']?.status === 'partial', 'code 356 is partial while a counted family is'],
        [picStderr.includes('no text-table entry for \\BAR[2]'), 'an escape no shipped plugin mentions still warns loudly'],
        [!picStderr.includes('FOO[1]'), 'an escape a shipped plugin source mentions stays silent (the game resolves it at display)'],
        [(picManifest.maps?.[0]?.mwgEvents?.[0]?.pages?.[0]?.commands || []).some(command => command.say === 'Hello \\FOO[1] and \\BAR[2]'), 'unresolved escapes stay literal in the manifest']
      ];
      for (const [ok, label] of picChecks) if (!ok) fail(`generic MV title/plugin probe: ${label}`);
      if (picChecks.every(([ok]) => ok)) notes.push(`generic MV title/plugin probe ok (${picChecks.length} checks)`);
      try {
        const out = JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), join(picOut, 'mwgp.json')], { stdio: 'pipe' }).toString());
        if (out.valid !== true) fail('validator rejected the title probe manifest');
        else notes.push('title probe manifest validates ok');
      } catch (error) {
        fail(`validator rejected the title probe manifest: ${String(error.stderr || error.message).slice(0, 200)}`);
      }
    }
    rmSync(picDir, { recursive: true, force: true });
  }
  // MV/MZ web build (tools/build-web.js): the game's files as-is, the nw.js host first, every game script deferred to
  // it, a native save/ folder left out, a previous MWGP conversion in the output replaced, and a rebuild copying only
  // what changed.
  {
    const webDir = mkdtempSync(join(tmpdir(), 'mwgp-smoke-web-'));
    const gameRoot = join(webDir, 'Game'), game = join(gameRoot, 'www'), out = join(webDir, 'out');
    for (const dir of ['js/plugins', 'data', 'img/titles1', 'save']) mkdirSync(join(game, dir), { recursive: true });
    mkdirSync(join(gameRoot, 'mods'), { recursive: true });
    mkdirSync(join(gameRoot, 'logs'), { recursive: true });
    writeFileSync(join(game, 'index.html'), '<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"><title>t</title></head>\n<body>\n<script type="text/javascript" src="js/rpg_core.js"></script>\n<script src=\'js/main.js\'></script>\n<script>var inline = 1;</script>\n</body>\n</html>\n');
    writeFileSync(join(game, 'js', 'rpg_core.js'), '// core');
    writeFileSync(join(game, 'js', 'main.js'), '// main');
    writeFileSync(join(game, 'data', 'System.json'), JSON.stringify({ gameTitle: 'Web Probe' }));
    writeFileSync(join(game, 'img', 'titles1', 'Castle.rpgmvp'), 'encrypted-bytes');
    writeFileSync(join(game, 'save', 'file1.rpgsave'), 'native save');
    writeFileSync(join(gameRoot, 'mods', 'SampleMod.js'), '// sample mod');
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'mwgp.json'), JSON.stringify({ format: 'MWGP', version: 1 }));
    writeFileSync(join(out, 'assets', 'stale.png'), 'x');
    let firstLog = '', secondLog = '';
    try {
      firstLog = execFileSync(process.execPath, [join(root, 'tools', 'build-web.js'), join(webDir, 'Game'), out], { encoding: 'utf8' });
      secondLog = execFileSync(process.execPath, [join(root, 'tools', 'build-web.js'), join(webDir, 'Game'), out], { encoding: 'utf8' });
    } catch (error) { fail(`web build probe failed: ${String(error.stderr || error.message).slice(0, 300)}`); }
    if (firstLog) {
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      const info = JSON.parse(readFileSync(join(out, 'mwgp-web.json'), 'utf8'));
      const list = JSON.parse(readFileSync(join(out, 'files.json'), 'utf8'));
      const directories = JSON.parse(readFileSync(join(out, 'directories.json'), 'utf8'));
      const webChecks = [
        [html.indexOf('<script src="nwjs-host.js"></script>') > html.indexOf('<head') && html.indexOf('nwjs-host.js') < html.indexOf('data-mwgp-src'), 'host loads first, in <head>'],
        [(html.match(/data-mwgp-src=/g) || []).length === 2 && html.includes('data-mwgp-src="js/rpg_core.js"') && html.includes("data-mwgp-src='js/main.js'") && html.includes('type="text/javascript" data-mwgp-src'), 'both game scripts deferred, attributes kept'],
        [html.includes('<script>var inline = 1;</script>'), 'inline scripts untouched'],
        [existsSync(join(out, 'nwjs-host.js')) && readFileSync(join(out, 'img', 'titles1', 'Castle.rpgmvp'), 'utf8') === 'encrypted-bytes', 'host copied, encrypted assets copied as-is'],
        [!existsSync(join(out, 'save')) && !list.some(name => name.startsWith('save/')), 'native save/ folder left out'],
        [existsSync(join(out, 'mods', 'SampleMod.js')) && readFileSync(join(out, 'mods', 'SampleMod.js'), 'utf8') === '// sample mod', 'project-level mods copied beside the web root'],
        [directories.includes('logs') && directories.includes('save') && directories.includes('mods'), 'empty writable and mod directories are indexed'],
        [JSON.stringify(list) === JSON.stringify(['data/System.json', 'img/titles1/Castle.rpgmvp', 'index.html', 'js/main.js', 'js/rpg_core.js', 'mods/SampleMod.js']), 'files.json indexes game and mod files'],
        [info.format === 'MWGP-web' && info.title === 'Web Probe' && info.source?.engine === 'rpg-maker-mv' && info.source?.files === 6, 'mwgp-web.json describes the build'],
        [!existsSync(join(out, 'mwgp.json')) && !existsSync(join(out, 'assets')), 'a previous MWGP conversion is replaced'],
        [/6 files \(6 copied, 0 unchanged\)/.test(firstLog) && /\(1 copied, 5 unchanged\)/.test(secondLog), 'a rebuild copies only what changed (index.html is re-patched)']
      ];
      for (const [ok, label] of webChecks) if (!ok) fail(`web build probe: ${label}`);
      if (webChecks.every(([ok]) => ok)) notes.push(`web build probe ok (${webChecks.length} checks)`);
    }
    rmSync(webDir, { recursive: true, force: true });
  }
  // RGSS web build: stored archive entries, original data, exclusions, core and player options.
  {
    const dir = mkdtempSync(join(tmpdir(), 'mwgp-smoke-rgss-web-'));
    const source = join(dir, 'Game'), out = join(dir, 'out');
    for (const folder of ['Data', 'Audio', 'GPUCache', 'Save']) mkdirSync(join(source, folder), { recursive: true });
    writeFileSync(join(source, 'Game.ini'), '[Game]\nTitle=RGSS Probe\n');
    writeFileSync(join(source, 'Data', 'Scripts.rxdata'), 'script bytes');
    writeFileSync(join(source, 'Audio', 'theme.ogg'), 'audio bytes');
    writeFileSync(join(source, 'Game.exe'), 'native executable');
    writeFileSync(join(source, 'RGSS104E.dll'), 'native library');
    writeFileSync(join(source, 'GPUCache', 'cache.bin'), 'cache');
    writeFileSync(join(source, 'Save', 'Save1.rxdata'), 'native save');
    let built = false;
    try { execFileSync(process.execPath, [join(root, 'tools', 'build-web.js'), source, out], { stdio: 'pipe' }); built = true; }
    catch (error) { fail(`RGSS web build probe failed: ${String(error.stderr || error.message).slice(0, 300)}`); }
    if (built) {
      const info = JSON.parse(readFileSync(join(out, 'mwgp-web.json'), 'utf8'));
      const zip = readFileSync(join(out, 'game.mkxpz'));
      const checks = [
        [info.source.engine === 'rpg-maker-rgss' && info.title === 'RGSS Probe' && info.rgss.syntaxTransform === 2, 'classic RGSS uses syntax rewrite'],
        [info.archive.entries.includes('Data/Scripts.rxdata') && info.archive.entries.includes('Audio/theme.ogg') && !info.archive.entries.some(name => /\.exe$|\.dll$|GPUCache|^Save\//i.test(name)), 'archive includes original data and omits native files and cache'],
        [zip.readUInt32LE(0) === 0x04034b50 && zip.includes(Buffer.from('script bytes')) && zip.includes(Buffer.from('audio bytes')), 'mkxpz is an uncompressed ZIP with original bytes'],
        [existsSync(join(out, 'mkxp-z_libretro.wasm')) && existsSync(join(out, 'nostalgist.umd.js')) && readFileSync(join(out, 'index.html'), 'utf8').includes('rgss-player.js'), 'core and our player page are packaged']
      ];
      for (const [ok, label] of checks) if (!ok) fail(`RGSS web build probe: ${label}`);
      if (checks.every(([ok]) => ok)) notes.push(`RGSS web build probe ok (${checks.length} checks)`);
    }
    writeFileSync(join(source, 'x64-msvcrt-ruby310.dll'), 'modern Ruby');
    const { rgssOptions } = await import(pathToFileURL(join(root, 'tools', 'build-rgss.mjs')).href);
    if (rgssOptions(source).syntaxTransform !== 0) fail('RGSS web build probe: modern Ruby must disable syntax rewrite');
    rmSync(dir, { recursive: true, force: true });
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
    const needed = ['convertXpGameDataOperand', "gameData = { kind: 'partySize' }", "operator: Number(parameters[2] || 0) === 0 ? 'gte' : 'lte'"];
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
      [mvConverter.includes('[0, 101, 108, 405, 408, 505].includes(Number(command.code))'), 'MV silent no-op allowlist'],
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

  // 5b: move-step descriptor table (converter emits, toRouteSteps hands to the library's MoveRouteRunner).
  const { toRouteSteps } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
  const aim = () => ({ x: 4, y: 2 });
  const stepCases = [
    [[{ dx: 1, dy: -1 }], null, [{ step: { dx: 1, dy: -1 } }]],
    [[{ jump: { dx: 0, dy: 2 } }], null, [{ jump: { dx: 0, dy: 2 } }]],
    [[{ forward: true }, { backward: true }], null, [{ dir: 'forward' }, { dir: 'backward' }]],
    [[{ random: true }], null, [{ dir: 'random' }]],
    [[{ wait: 0.5 }], null, [{ wait: 0.5 }]],
    [[{ turn: 'left90' }, { turn: 'down' }, { turn: 'random' }], null, [{ turn: 'left90' }, { turn: 'down' }, { turn: 'random' }]],
    [[{ toward: true }, { away: true }, { turn: 'toward' }], null, []],
    [[{ toward: true }, { away: true }, { turn: 'away' }], aim, [{ dir: 'toward', target: aim }, { dir: 'away', target: aim }, { turn: 'away', target: aim }]],
    [[{}, null, 3], null, []],
    [null, null, []],
  ];
  let stepFailures = 0;
  for (const [steps, target, expected] of stepCases) {
    if (JSON.stringify(toRouteSteps(steps, target)) !== JSON.stringify(expected)) {
      fail(`toRouteSteps(${JSON.stringify(steps)}) mismatch`);
      stepFailures++;
    }
  }
  // The steps drive the library's runner: diagonal, facing-relative and aimed moves all land where MV puts them.
  {
    const mwgLib = await import(pathToFileURL(join(root, 'node_modules', '@datamoc', 'mwg', 'dist', 'rpg', 'index.js')).href);
    const mover = new mwgLib.GridMover({ x: 0, y: 0 }, 2, 2, { tileWidth: 1, tileHeight: 1, speed: 1e6 });
    const runner = new mwgLib.MoveRouteRunner(mover, { steps: toRouteSteps([{ dx: 1, dy: 1 }, { turn: 'left' }, { forward: true }, { toward: true }], () => ({ x: 9, y: 3 })), skippable: true });
    for (let i = 0; i < 8 && !runner.done; i++) { runner.update(1); mover.update(1); }
    if (mover.x !== 3 || mover.y !== 3) { fail(`route through MoveRouteRunner ended at (${mover.x}, ${mover.y}), wanted (3, 3)`); stepFailures++; }
  }
  {
    const { transferTargetsOfPage } = await import(pathToFileURL(join(root, 'src', 'player', 'player-core.js')).href);
    const page = { commands: [{ say: 'x' }, { if: { switch: '1' }, then: [{ transfer: { mapId: 4, x: 1, y: 2 } }], else: [{ transfer: { mapId: 9, x: 3, y: 4 } }] }, { transfer: { mapVar: 5, x: 0, y: 0 } }, { transfer: { mapId: 'nope', x: 0, y: 0 } }] };
    const found = transferTargetsOfPage(page);
    if (JSON.stringify(found) !== JSON.stringify([{ mapId: 4, x: 1, y: 2 }, { mapId: 9, x: 3, y: 4 }])) { fail(`transferTargetsOfPage returned ${JSON.stringify(found)}`); stepFailures++; }
    if (transferTargetsOfPage(page) !== found) { fail('transferTargetsOfPage did not cache per page'); stepFailures++; }
    if (transferTargetsOfPage(null).length !== 0) { fail('transferTargetsOfPage(null) should be empty'); stepFailures++; }
  }
  if (!stepFailures) notes.push('toRouteSteps descriptor table + MoveRouteRunner ok');

  // 5c: autotile source math and character frame geometry (engine rules the
  // converter measures and the player renders by; see rpg_core.js Tilemap
  // and rpg_sprites.js Sprite_Character).
  const { autotileSource, autotileDrawOps, characterDepth, characterGeometry, characterCellIndex, characterPixelSize, normalTileFrame, passageAllowsStep, tileToFrame } =
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
  // B-E sheets use the engine's 8-column halves, not row-major-16: Karryn's
  // tile 814 must sample the empty (6,5) cell, never the dev-badge art.
  expect(normalTileFrame(512), 0, 'normalTileFrame sheet origin');
  expect(normalTileFrame(519), 7, 'normalTileFrame first row end');
  expect(normalTileFrame(520), 16, 'normalTileFrame second half starts a new row');
  expect(normalTileFrame(767), 255, 'normalTileFrame sheet corner is stable');
  expect(normalTileFrame(814), 86, 'normalTileFrame Karryn badge tile samples empty (6,5)');
  expect(normalTileFrame(8), 16, 'normalTileFrame B tile 8');
  const stubMwg = { EMPTY: -1, tileFrame: (sheet, frame) => (sheet << 20) | frame };
  const eEntries = [{ slot: 7 }, { slot: 8 }];
  const eSheets = [{ count: 256 }, { count: 256 }];
  expect(tileToFrame(814, eEntries, eSheets, stubMwg), (1 << 20) | 86, 'tileToFrame routes E tiles through the half-sheet frame');
  expect(tileToFrame(767, eEntries, eSheets, stubMwg), (0 << 20) | 255, 'tileToFrame keeps the stable corner');
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

// 7: VX (RGSS2) conversion (T122) - a synthetic VX project, its XP twin and an
// Ace (RGSS3, T123) sibling, built with mwg' own encodeMarshal, convert
// end to end and validate. The Ace shapes beyond the Marshal envelope are
// assumed from VX (see tools/rgss-ace.mjs), so its fixture pins the plumbing
// and the loud fallbacks, not ground truth from a real Ace project.
try {
  const vx = await import(pathToFileURL(join(root, 'tools', 'rgss-vx.mjs')).href);
  const ace = await import(pathToFileURL(join(root, 'tools', 'rgss-ace.mjs')).href);
  const { encodeMarshal } = await import('@datamoc/mwg/rpg');
  const { deflateSync } = await import('node:zlib');
  const vxChecks = [];
  const check = (ok, label) => vxChecks.push([ok, label]);
  // Reference-table sanity: every VX command classifies exactly once, and the
  // renumbers/weather map land where the converter applies them.
  const classified = new Set([...vx.VX_SUPPORTED, ...vx.VX_PARTIAL]);
  check(Object.keys(vx.VX_COMMAND_NAMES).every(code => classified.has(Number(code)) || vx.vxCommandStatus(code) === 'unsupported'), 'every VX command has a status');
  check(vx.vxRemap(203) === 202 && vx.vxRemap(204) === 203 && vx.vxRemap(205) === 209 && vx.vxRemap(214) === null, 'VX renumbers hit XP cases');
  check(vx.vxWeatherType(1) === 'rain' && vx.vxWeatherType(2) === 'storm' && vx.vxWeatherType(3) === 'snow' && vx.vxWeatherType(9) === 'none', 'VX weather enum maps');
  check(vx.VX_TILESET_SHEETS.length === 9 && vx.VX_TILESET_SHEETS[0] === 'TileA1', 'VX global tileset sheets listed');
  // Ace shares VX's event numbering (assumed, see tools/rgss-ace.mjs): the
  // re-export must stay identical, and the tileset reader must degrade loudly.
  check(JSON.stringify(Object.keys(ace.ACE_COMMAND_NAMES).sort()) === JSON.stringify(Object.keys(vx.VX_COMMAND_NAMES).sort())
    && ace.aceRemap(205) === 209 && ace.aceWeatherType(1) === 'rain', 'Ace re-exports the VX command layer');
  {
    const warnings = [];
    const fallback = ace.aceTilesetEntry({ class: 'RPG::Tileset', ivars: { '@id': 5 } }, 5, () => { throw new Error('no table read on fallback'); }, message => warnings.push(message));
    check(fallback.id === 5 && JSON.stringify(fallback.tilesetNames) === JSON.stringify(ace.ACE_TILESET_SHEETS) && fallback.flags.length === 0 && warnings.length === 2, 'Ace tileset reader falls back loudly');
  }
  const O = (cls, ivars) => ({ class: cls, ivars });
  const cmd = (code, parameters, indent = 0) => O('RPG::EventCommand', { '@code': code, '@indent': indent, '@parameters': parameters });
  const audioFile = name => O('RPG::AudioFile', { '@name': name, '@volume': 90, '@pitch': 100 });
  const tableBytes = (w, h, z, fill) => {
    const bytes = [];
    for (const n of [3, w, h, z, w * h * z]) for (let i = 0; i < 4; i++) bytes.push((n >> (8 * i)) & 0xff);
    for (let i = 0; i < w * h * z; i++) { const v = fill(i); bytes.push(v & 0xff, (v >> 8) & 0xff); }
    return bytes;
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const pngChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(head));
    return Buffer.concat([len, head, crc]);
  };
  const png = (w, h) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), pngChunk('IEND', Buffer.alloc(0))]);
  };
  // Hand-built Scripts container: zlib bytes cannot round-trip encodeMarshal.
  const fixnum = n => {
    if (n === 0) return [0];
    if (n > 0 && n < 123) return [n + 5];
    const bytes = []; let v = Math.abs(n);
    while (v > 0) { bytes.push(v & 0xff); v >>>= 8; }
    return [n < 0 ? 256 - bytes.length : bytes.length].concat(bytes);
  };
  const mstr = bytes => [0x22].concat(fixnum(bytes.length), [...bytes]);
  const scriptsFile = entries => {
    const out = [4, 8, 0x5b].concat(fixnum(entries.length));
    for (const [id, name, code] of entries) {
      const nb = Buffer.from(name, 'utf8'), zb = deflateSync(code);
      out.push(0x5b, ...fixnum(3), 0x69, ...fixnum(id), ...mstr(nb), ...mstr(zb));
    }
    return Buffer.from(out);
  };
  const route = steps => O('RPG::MoveRoute', { '@repeat': false, '@skippable': false,
    '@list': steps.map(([code, parameters]) => O('RPG::MoveCommand', { '@code': code, '@parameters': parameters })) });
  const pageOf = (list, graphic) => O('RPG::Event::Page', {
    '@condition': O('RPG::Event::Page::Condition', {}),
    '@graphic': graphic || O('RPG::Event::Page::Graphic', {}),
    '@move_type': 0, '@trigger': 0, '@list': list });
  const buildFixture = (dir, engine, unsupportedXpShapes = false) => {
    const isAce = engine === 'ace';
    const isVx = engine === 'vx';
    const isVxLike = isVx || isAce;
    const ext = isAce ? '.rvdata2' : isVx ? '.rvdata' : '.rxdata';
    const write = (name, value) => writeFileSync(join(dir, 'Data', name + ext), Buffer.from(encodeMarshal(value)));
    mkdirSync(join(dir, 'Data'), { recursive: true });
    const sysIv = { '@game_title': `${engine} Probe`, '@start_map_id': 1, '@start_x': 2, '@start_y': 3,
      '@title_bgm': audioFile('Town1'), '@battle_bgm': audioFile('Battle1'),
      '@battle_end_me': audioFile('Victory1'), '@gameover_me': audioFile('GameOver1') };
    sysIv['@party_members'] = [1];
    if (!isVxLike) sysIv['@title_name'] = 'title';
    if (isVxLike) {
      sysIv['@sounds'] = [audioFile('Cursor1'), audioFile('Decision1'), null, null, null, null, null, null, null, null, null, null];
    }
    write('System', O('RPG::System', sysIv));
    write('MapInfos', new Map([[1, O('RPG::MapInfo', { '@name': 'Town', '@parent_id': 0, '@order': 1 })]]));
    write('CommonEvents', []);
    if (isAce) {
      write('Actors', [O('RPG::Actor', { '@id': 1, '@character_name': 'Hero', '@character_index': 2 })]);
      write('Tilesets', [null, O('RPG::Tileset', { '@id': 1, '@name': 'World',
        '@tileset_names': ['TileA1', 'TileA2', 'TileA3', 'TileA4', 'TileA5', 'TileB', 'TileC', 'TileD', 'TileE'],
        '@flags': O('Table', { '@raw': tableBytes(4, 1, 1, () => 0x10) }) })]);
    } else if (isVx) write('Actors', [O('RPG::Actor', { '@id': 1, '@character_name': 'Hero', '@character_index': 2 })]);
    else {
      const tilesetTable = layer => tableBytes(6, 5, 1, () => layer);
      write('Actors', [null, O('RPG::Actor', { '@id': 1, '@character_name': 'Hero' })]);
      write('Tilesets', [O('RPG::Tileset', { '@id': 0, '@tileset_name': 'World', '@autotile_names': ['028-Weiner'],
        '@passages': O('Table', { '@raw': tilesetTable(15) }), '@priorities': O('Table', { '@raw': tilesetTable(0) }), '@terrain_tags': O('Table', { '@raw': tilesetTable(0) }) })]);
    }
    const list = [
      cmd(101, ['Hello']), cmd(401, ['World']),
      cmd(111, [1, 7, 0, 5, 1], 0),
      cmd(126, [5, 0, 0, 3], 1), cmd(411, [], 0), cmd(125, [1, 0, 50], 1), cmd(412, [], 0),
      cmd(212, [-1, 3, true]), cmd(213, [0, 1, false]),
      cmd(122, [1, 2, 0, 0, 10]), cmd(122, [5, 5, 1, 7, 0]), cmd(122, [6, 6, 0, 7, 1]),
      cmd(129, [2, 0, 0]), cmd(314, [0, 0]), cmd(313, [0, 1, 0, 5]),
      cmd(102, [['Yes', 'No'], -1]), cmd(402, [0, 'Yes']), cmd(402, [1, 'No']), cmd(403, []), cmd(404, []),
      cmd(301, isVxLike ? [0, 7, true, false] : [7, true, false]),
      cmd(355, ['$game_variables[3] = 7']),
      cmd(111, [12, '$game_switches[1]'])
    ];
    if (isVxLike) list.push(
      cmd(205, [-1, route([[1, []]])]), cmd(505, []),
      cmd(230, [30]), cmd(214, []), cmd(203, [-1, 0, 2, 3, 2]), cmd(204, [2, 5, 4]),
      cmd(202, [0, 0, 1, 4, 5]), cmd(236, [1, 5, 60]),
      cmd(302, [0, 5, 0, 100]), cmd(605, [1, 3, 0, 200]), cmd(303, [1, 8]),
      cmd(211, [0, 0]), cmd(106, [20]));
    else list.push(
      cmd(209, [-1, route([[1, []]])]), cmd(509, []),
      cmd(106, [20]), cmd(116, []), cmd(208, [0]), cmd(104, [2, 0]),
      cmd(105, [2, false]), cmd(405, ['scroll line']),
      cmd(123, ['A', 0]), cmd(125, [1, 1, 7]), cmd(202, [-1, 0, 2, 4, 6]),
      cmd(204, [1, 'Fog', 0, 200, 0, 100, 1, -1]));
    if (!isVxLike && unsupportedXpShapes) list.push(cmd(202, [0, 2, 1, 4, 6]), cmd(204, [2, 'Arena']));
    const mapIv = {
      '@width': 6, '@height': 5,
      '@data': O('Table', { '@raw': tableBytes(6, 5, 3, i => (i < 30 ? 2816 : (i === 30 ? 20 : (i === 61 ? 1 : 0)))) }),
      '@events': new Map([[1, O('RPG::Event', { '@id': 1, '@name': 'Greeter', '@x': 2, '@y': 3,
        '@pages': [pageOf(list, O('RPG::Event::Page::Graphic', { '@character_name': 'Hero', '@character_index': 0, '@direction': 2, '@pattern': 1 }))] })]]),
      '@encounter_list': [3, 5], '@encounter_step': 20,
      '@bgm': audioFile('Town1'), '@autoplay_bgm': true, '@bgs': audioFile(''), '@autoplay_bgs': false
    };
    if (isAce) mapIv['@tileset_id'] = 1;
    else if (!isVx) mapIv['@tileset_id'] = 0;
    write('Map001', O('RPG::Map', mapIv));
    const libScripts = [[1, isAce ? 'AceLib' : 'VXLib', 'class Game_VX\nend\n']];
    // The game sets its own screen size from a constant: the converter resolves it (XP only here, so VX/Ace keep
    // the engine default).
    if (!isVxLike) libScripts.push([2, 'Settings', 'module Settings\n  SCREEN_W = 512\nend\nGraphics.resize_screen(Settings::SCREEN_W, 384)\n']);
    writeFileSync(join(dir, 'Data', 'Scripts' + ext), scriptsFile(libScripts));
    mkdirSync(join(dir, 'Graphics', 'Characters'), { recursive: true });
    writeFileSync(join(dir, 'Graphics', 'Characters', 'Hero.png'), png(isVxLike ? 96 : 128, isVxLike ? 128 : 192));
    if (!isVxLike) {
      mkdirSync(join(dir, 'Graphics', 'Titles'), { recursive: true });
      writeFileSync(join(dir, 'Graphics', 'Titles', 'title.png'), png(32, 32));
    }
    if (isVx) {
      mkdirSync(join(dir, 'Graphics', 'System'), { recursive: true });
      for (const sheet of vx.VX_TILESET_SHEETS) writeFileSync(join(dir, 'Graphics', 'System', sheet + '.png'), png(32, 32));
    }
    if (isAce) {
      mkdirSync(join(dir, 'Graphics', 'Tilesets'), { recursive: true });
      for (const sheet of ace.ACE_TILESET_SHEETS) writeFileSync(join(dir, 'Graphics', 'Tilesets', sheet + '.png'), png(32, 32));
    }
  };
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mwgp-vx-'));
  try {
    const converted = {};
    for (const engine of ['vx', 'xp', 'ace']) {
      const from = join(fixtureRoot, engine), to = join(fixtureRoot, engine + '-out');
      buildFixture(from, engine);
      try {
        execFileSync(process.execPath, [join(root, 'tools', 'convert-rgss.js'), from, to], { stdio: 'pipe' });
      } catch (error) {
        check(false, `${engine} fixture converts (${String(error.stderr || error.message).slice(0, 200)})`);
        continue;
      }
      try {
        execFileSync(process.execPath, [join(root, 'tools', 'validate-mwgp.js'), join(to, 'mwgp.json')], { stdio: 'pipe' });
        check(true, `${engine} fixture manifest validates`);
      } catch (error) {
        check(false, `${engine} fixture manifest validates (${String(error.stderr || error.message).slice(0, 200)})`);
      }
      converted[engine] = JSON.parse(readFileSync(join(to, 'mwgp.json'), 'utf8'));
    }
    const strongly = (cond, label) => check(!!cond, label);
    const xpGaps = join(fixtureRoot, 'xp-gaps'), xpGapsOut = join(fixtureRoot, 'xp-gaps-out');
    buildFixture(xpGaps, 'xp', true);
    try {
      execFileSync(process.execPath, [join(root, 'tools', 'convert-rgss.js'), xpGaps, xpGapsOut], { stdio: 'pipe' });
      const report = JSON.parse(readFileSync(join(xpGapsOut, 'mwgp.json'), 'utf8')).compatibility.commands;
      strongly(report['202']?.status === 'partial' && report['204']?.status === 'partial', 'XP relocation exchange and battleback uses keep commands partial');
    } catch (error) {
      strongly(false, `XP partial-shape fixture converts (${String(error.stderr || error.message).slice(0, 200)})`);
    }
    if (converted.vx) {
      const m = converted.vx, event = m.maps[0].mwgEvents[0], commands = event.pages[0].commands;
      const flat = [];
      (function walk(list) { for (const c of list || []) { flat.push(c); walk(c.then); walk(c.else); for (const b of c.branches || []) walk(b); if (c.cancelBranch) walk(c.cancelBranch); } })(commands);
      const one = pred => flat.find(pred);
      const loud = flat.filter(c => c.unsupported !== undefined).map(c => `${c.unsupported.code}:${c.unsupported.kind}`).sort();
      strongly(m.source.engine === 'rpg-maker-vx', 'VX manifest carries the VX engine tag');
      strongly(m.display.tileSize === 32 && m.maps.length === 1 && m.maps[0].info?.name === 'Town', 'VX map converts with its name');
      strongly(JSON.stringify(m.tilesets[0]?.tilesetNames) === JSON.stringify(vx.VX_TILESET_SHEETS) && m.tilesets[0]?.flags?.length === 0, 'VX global tileset synthesizes with empty flags');
      strongly(m.maps[0].data.tilesetId === 0, 'VX maps need no tileset_id');
      const layer = l => m.maps[0].data.data.slice(l * 30, l * 30 + 30);
      strongly(layer(0).every(t => t === 2816) && layer(4)[0] === 20 && layer(4).slice(1).every(t => t === 0)
        && [1, 2, 3, 5].every(l => layer(l).every(t => t === 0)), 'VX tile layers land on MV 0/4, shadow dropped');
      strongly(m.playerSprite?.name === 'Hero' && m.playerSprite?.index === 2, 'VX start actor gives the player sprite');
      strongly(JSON.stringify(m.initialParty) === '[1]' && Object.keys(m.database || {}).length === 0, 'VX party comes from System, database stays empty');
      strongly(one(c => c.modifyVariable?.operand?.gameData?.kind === 'partySize') !== undefined, 'VX 122-kind7 index 1 reads the party size');
      strongly(m.display.width === 544 && m.display.height === 416, 'VX screen is the engine default without resize_screen');
      strongly(commands[0]?.say === 'Hello' && commands[1]?.say === 'World', 'VX text converts');
      strongly(one(c => c.wait === 0.5) !== undefined, 'VX 230 waits /60');
      strongly(one(c => c.eraseEvent) !== undefined, 'VX 214 erases');
      strongly(JSON.stringify(one(c => c.animation)?.animation) === JSON.stringify({ target: -1, animation: 3, wait: true }), 'VX 212 animates');
      strongly(one(c => c.relocate?.target) !== undefined && one(c => c.relocate)?.relocate?.x === 2, 'VX 203 relocates (not a vehicle)');
      strongly(one(c => c.scrollMap?.distance === 5) !== undefined, 'VX 204 scrolls');
      strongly(one(c => c.vehicleLocation?.mapId === 1) !== undefined, 'VX 202 places the vehicle');
      strongly(one(c => c.weather?.type === 'rain') !== undefined, 'VX 236 weathers by enum');
      strongly(one(c => c.shop)?.shop?.goods?.length === 2, 'VX 302 shops with 605 goods');
      strongly(one(c => c.inputName?.actorId === 1) !== undefined, 'VX 303 takes the name');
      strongly(one(c => c.battle?.troopId === 7) !== undefined, 'VX 301 designates the troop');
      strongly(one(c => typeof c.script === 'string' && typeof c.js === 'string') !== undefined, 'VX scripts transpile');
      strongly(one(c => c.if?.script) !== undefined, 'VX script branches convert');
      strongly(one(c => c.changeItem?.id === 5) !== undefined, 'VX 126 changes items');
      strongly(one(c => c.changeParty?.actorId === 2) !== undefined, 'VX 129 changes the party');
      strongly(one(c => c.recoverAll) !== undefined, 'VX 314 recovers the party');
      strongly(one(c => c.choices && c.cancelBranch) !== undefined, 'VX choices keep branches');
      strongly(JSON.stringify(loud) === JSON.stringify(['106:0', '211:0', '313:0']), 'VX unknowns stay loud (106/211/313)');
      const report = m.compatibility.commands;
      strongly(report['205']?.status === 'supported' && report['214']?.status === 'supported'
        && report['230']?.status === 'supported' && report['505']?.status === 'supported'
        && report['111']?.status === 'supported' && report['122']?.status === 'supported'
        && report['301']?.status === 'partial', 'VX compatibility report classifies');
    }
    if (converted.ace) {
      const m = converted.ace, event = m.maps[0].mwgEvents[0], commands = event.pages[0].commands;
      const flat = [];
      (function walk(list) { for (const c of list || []) { flat.push(c); walk(c.then); walk(c.else); for (const b of c.branches || []) walk(b); if (c.cancelBranch) walk(c.cancelBranch); } })(commands);
      const one = pred => flat.find(pred);
      const loud = flat.filter(c => c.unsupported !== undefined).map(c => `${c.unsupported.code}:${c.unsupported.kind}`).sort();
      strongly(m.source.engine === 'rpg-maker-vxace', 'Ace manifest carries the Ace engine tag');
      strongly(m.display.tileSize === 32 && m.maps.length === 1 && m.maps[0].info?.name === 'Town', 'Ace map converts with its name');
      strongly(m.maps[0].data.tilesetId === 1, 'Ace maps keep their database tileset id');
      strongly(JSON.stringify(m.tilesets[1]?.tilesetNames) === JSON.stringify(ace.ACE_TILESET_SHEETS)
        && JSON.stringify(m.tilesets[1]?.flags) === JSON.stringify([16, 16, 16, 16]), 'Ace Tilesets table converts with names and flags');
      strongly(m.tilesets[0] === null, 'Ace null tileset rows stay null');
      strongly(m.playerSprite?.name === 'Hero' && m.playerSprite?.index === 2, 'Ace start actor gives the player sprite');
      strongly(JSON.stringify(m.initialParty) === '[1]' && Object.keys(m.database || {}).length === 0, 'Ace party comes from System, database stays empty');
      strongly(commands[0]?.say === 'Hello' && commands[1]?.say === 'World', 'Ace text converts');
      strongly(one(c => c.wait === 0.5) !== undefined, 'Ace 230 waits /60');
      strongly(one(c => c.eraseEvent) !== undefined, 'Ace 214 erases');
      strongly(one(c => c.relocate)?.relocate?.x === 2, 'Ace 203 relocates');
      strongly(one(c => c.vehicleLocation?.mapId === 1) !== undefined, 'Ace 202 places the vehicle');
      strongly(one(c => c.battle?.troopId === 7) !== undefined, 'Ace 301 designates the troop');
      strongly(one(c => typeof c.script === 'string' && typeof c.js === 'string') !== undefined, 'Ace scripts transpile');
      strongly(JSON.stringify(loud) === JSON.stringify(['106:0', '211:0', '313:0']), 'Ace unknowns stay loud (106/211/313)');
      const report = m.compatibility.commands;
      strongly(report['205']?.status === 'supported' && report['214']?.status === 'supported'
        && report['230']?.status === 'supported' && report['301']?.status === 'partial', 'Ace compatibility report classifies');
    }
    if (converted.xp) {
      const m = converted.xp, commands = m.maps[0].mwgEvents[0].pages[0].commands;
      const flat = [];
      (function walk(list) { for (const c of list || []) { flat.push(c); walk(c.then); walk(c.else); } })(commands);
      const one = pred => flat.find(pred);
      strongly(m.source.engine === 'rpg-maker-xp', 'XP manifest keeps the XP engine tag');
      strongly(JSON.stringify(m.tilesets[0]?.tilesetNames) === JSON.stringify([null, null, null, null, null, 'World'])
        && m.tilesets[0]?.flags?.length === 30, 'XP tileset still maps with flags');
      strongly(one(c => c.wait === 1) !== undefined, 'XP 106 waits /20');
      strongly(one(c => c.eraseEvent) !== undefined, 'XP 116 erases');
      strongly(one(c => c.setTransparent === true) !== undefined, 'XP 208 sets transparency');
      strongly(one(c => c.messageOptions) !== undefined, 'XP 104 keeps message options');
      strongly(one(c => c.scroll?.text === 'scroll line') !== undefined, 'XP 105 scrolls with 405 lines');
      strongly(one(c => c.battle?.troopId === 7) !== undefined, 'XP 301 keeps its troop');
      strongly(m.maps[0].data.encounterStep === 20 && JSON.stringify(m.maps[0].data.encounterList) === JSON.stringify([{ troopId: 3, weight: 10, regionSet: [] }, { troopId: 5, weight: 10, regionSet: [] }]), 'XP encounter_list and encounter_step reach the map data');
      strongly(one(c => c.modifyVariable?.operand?.gameData?.kind === 'partySize') !== undefined, 'XP 122-kind7 index 1 reads the stock party size');
      strongly(m.maps[0].mwgEvents[0].pages[0].commands[2]?.then?.[0]?.changeItem?.id === 5, 'XP 126 changes items like stock XP');
      strongly(one(c => c.changeParty?.actorId === 2 && c.changeParty.add === true) !== undefined, 'XP 129 changes the party');
      strongly(m.playerSprite?.name === 'Hero' && m.playerSprite?.index === 0 && m.playerSprite?.source === 'start-actor', 'XP start actor gives the player sprite');
      strongly(m.titleScreen?.title1 === 'title' && m.titleScreen?.drawTitle === false && m.titleScreen?.assets?.kind === 'decoded' && !m.titleScreen?.kind, 'XP stock title uses System title_name');
      strongly(m.display.width === 512 && m.display.height === 384, "XP screen size comes from the game's own resize_screen constant");
      strongly(!m.playerMetadata, 'XP manifest carries no framework player metadata');
      strongly(!converted.vx?.titleScreen && !converted.ace?.titleScreen, 'VX/Ace fixtures without title art keep the generic title');
      strongly(m.compatibility.commands['123']?.status === 'supported'
        && m.compatibility.commands['125']?.status === 'supported'
        && m.compatibility.commands['202']?.status === 'supported'
        && m.compatibility.commands['204']?.status === 'supported', 'XP self-switch, gold, direct relocation, and fog commands are classified supported when their used shapes are implemented');
    }
    for (const [ok, label] of vxChecks) if (!ok) fail(`VX fixture: ${label}`);
    if (converted.vx && converted.xp && converted.ace) notes.push(`VX/XP/Ace fixtures convert (${vxChecks.length} checks)`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
} catch (error) {
  fail(`VX fixture check failed: ${String(error.message).slice(0, 200)}`);
}

// 8: RGSSAD archives (T123) - v1 and v3 round-trips built by hand from the
// layouts extract-rgssad.js implements (v3 per mkxp's src/rgssad.cpp), plus
// loud rejections of bad magic, unknown versions and corrupt v3 entries.
try {
  const archiveChecks = [];
  const acheck = (ok, label) => archiveChecks.push([ok, label]);
  const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return [...b]; };
  const xorPayload = (data, startKey) => {
    const out = Buffer.from(data);
    let key = startKey >>> 0;
    for (let o = 0; o < out.length; o += 4) {
      const chunk = Math.min(4, out.length - o);
      for (let b = 0; b < chunk; b++) out[o + b] ^= (key >>> (8 * b)) & 0xff;
      key = (Math.imul(key, 7) + 3) >>> 0;
    }
    return out;
  };
  const advanceKey = key => (Math.imul(key, 7) + 3) >>> 0;
  // v3 builder: header + seed + entry table (offset/size/key/namelen/name per
  // file, terminator offset 0) + payloads at absolute offsets.
  const buildV3 = (seed, files) => {
    const key = (Math.imul(seed, 9) + 3) >>> 0;
    const encNames = files.map(([name]) => {
      const plain = Buffer.from(name, 'latin1'), enc = Buffer.from(plain);
      for (let i = 0; i < enc.length; i++) enc[i] ^= (key >>> (8 * (i % 4))) & 0xff;
      return enc;
    });
    let at = 12 + files.reduce((n, _, i) => n + 16 + encNames[i].length, 0) + 4;
    const table = [];
    const payloads = [];
    files.forEach(([name, data, entryKey], i) => {
      table.push(...u32le((at ^ key) >>> 0), ...u32le((data.length ^ key) >>> 0),
        ...u32le((entryKey ^ key) >>> 0), ...u32le((encNames[i].length ^ key) >>> 0), ...encNames[i]);
      payloads.push(xorPayload(data, entryKey));
      at += data.length;
    });
    table.push(...u32le((0 ^ key) >>> 0));
    return Buffer.concat([Buffer.from('RGSSAD\0', 'latin1'), Buffer.from([3]), Buffer.from(u32le(seed)), Buffer.from(table), ...payloads]);
  };
  // v1 builder: header + front-to-back stream (namelen/name/datalen/data).
  const buildV1 = files => {
    const parts = [Buffer.from('RGSSAD\0', 'latin1'), Buffer.from([1])];
    let key = 0xDEADCAFE >>> 0;
    for (const [name, data, entryKey] of files) {
      const nb = Buffer.from(name, 'latin1');
      parts.push(Buffer.from(u32le((nb.length ^ key) >>> 0))); key = advanceKey(key);
      const enc = Buffer.from(nb);
      for (let i = 0; i < enc.length; i++) { enc[i] ^= key & 0xff; key = advanceKey(key); }
      parts.push(enc);
      parts.push(Buffer.from(u32le((data.length ^ key) >>> 0))); key = advanceKey(key);
      parts.push(xorPayload(data, key));
    }
    return Buffer.concat(parts);
  };
  const archiveRoot = mkdtempSync(join(tmpdir(), 'mwgp-rgssad-'));
  try {
    const sysData = Buffer.from([4, 8, 0x5b, 5]);           // tiny Marshal array
    const tuneData = Buffer.from([1, 2, 3, 4, 5, 6, 7]);    // odd length: tail bytes
    const v3 = buildV3(0x11223344, [['Data\\System.rvdata2', sysData, 0x12345678], ['Audio/Bgm/Theme.ogg', tuneData, 0x9abcdef0]]);
    writeFileSync(join(archiveRoot, 'Game.rgss3a'), v3);
    mkdirSync(join(archiveRoot, 'v3out'), { recursive: true });
    try {
      execFileSync(process.execPath, [join(root, 'tools', 'extract-rgssad.js'), join(archiveRoot, 'Game.rgss3a'), join(archiveRoot, 'v3out')], { stdio: 'pipe' });
      acheck(readFileSync(join(archiveRoot, 'v3out', 'Data', 'System.rvdata2')).equals(sysData)
        && readFileSync(join(archiveRoot, 'v3out', 'Audio', 'Bgm', 'Theme.ogg')).equals(tuneData), 'v3 archive round-trips (backslash names normalized)');
    } catch (error) {
      acheck(false, `v3 archive extracts (${String(error.stderr || error.message).slice(0, 200)})`);
    }
    const v1 = buildV1([['Data/System.rxdata', sysData, 0]]);
    writeFileSync(join(archiveRoot, 'Game.rgssad'), v1);
    const rgssaProject = join(archiveRoot, 'rgssa-project');
    mkdirSync(rgssaProject, { recursive: true });
    writeFileSync(join(rgssaProject, 'Game.rgssa'), v1);
    let converterProbe = '';
    try {
      converterProbe = execFileSync(process.execPath, [join(root, 'tools', 'convert-rgss.js'), rgssaProject, join(archiveRoot, 'rgssa-output')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      converterProbe = `${error.stdout || ''}\n${error.stderr || ''}`;
    }
    acheck(converterProbe.includes('extracted encrypted Ruby scripts and game data from') && !converterProbe.includes('contains no Game.rgssa'), 'converter discovers and extracts a Game.rgssa archive in the project directory');
    const autoSource = join(archiveRoot, 'auto-source');
    const autoGame = join(autoSource, 'rgssa-game');
    mkdirSync(autoGame, { recursive: true });
    writeFileSync(join(autoGame, 'Game.rgssa'), v1);
    let autoSummary;
    try {
      autoSummary = JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'convert-auto.js'), autoSource, join(archiveRoot, 'auto-output'), '--jobs', '1', '--mwgp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (error) {
      try { autoSummary = JSON.parse(String(error.stdout || '')); } catch { autoSummary = null; }
    }
    const autoResult = autoSummary?.results?.[0];
    acheck(autoResult?.status !== 'skipped' && !String(autoResult?.reason || '').includes('no Game.rgssa'), 'convert:auto recognizes a project folder containing Game.rgssa');
    // The systematic default is the MWGP conversion (editable), no --mwgp flag
    // needed: the same source converted without the flag must produce a
    // manifest, not a web build.
    let defaultSummary;
    try {
      defaultSummary = JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'convert-auto.js'), autoSource, join(archiveRoot, 'auto-output-default'), '--jobs', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (error) {
      try { defaultSummary = JSON.parse(String(error.stdout || '')); } catch { defaultSummary = null; }
    }
    const defaultGame = join(archiveRoot, 'auto-output-default', 'rgssa-game');
    // This hand-built archive is too small for a full RGSS conversion (no
    // MapInfos), so the converter itself fails; what the default decides is
    // the routing: the MWGP converter must be attempted, never build-web.
    acheck(String(defaultSummary?.results?.[0]?.reason || '').includes('convert-rgss.js') && !existsSync(join(defaultGame, 'mwgp-web.json')),
      'convert:auto defaults to the MWGP conversion (convert-rgss, no web build) without --mwgp');
    // The summary's per-game log reports difficulties by default (the converter's stderr warnings);
    // its informational stdout only returns with --verbose.
    const autoMvSource = join(archiveRoot, 'auto-mv-source');
    const mvGame = join(autoMvSource, 'mv-game');
    for (const dir of ['data', 'js', 'img/characters', 'loc']) mkdirSync(join(mvGame, dir), { recursive: true });
    writeFileSync(join(mvGame, 'index.html'), '<!doctype html><html><body></body></html>');
    writeFileSync(join(mvGame, 'js', 'plugins.js'), 'var $plugins = [];');
    writeFileSync(join(mvGame, 'loc', 'GhostTable.json'), JSON.stringify({ entry: { text: ['x'] } }));
    writeFileSync(join(mvGame, 'data', 'System.json'), JSON.stringify({ gameTitle: 'Auto Probe', startMapId: 1, startX: 0, startY: 0, partyMembers: [] }));
    writeFileSync(join(mvGame, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Room', order: 1, parentId: 0 }]));
    writeFileSync(join(mvGame, 'data', 'Tilesets.json'), JSON.stringify([null, { id: 1, tilesetNames: ['', '', '', '', '', '', '', '', ''], flags: [0] }]));
    writeFileSync(join(mvGame, 'data', 'Map001.json'), JSON.stringify({ width: 2, height: 2, tilesetId: 1, autoplayBgm: false, data: Array(24).fill(0), events: [null, { id: 1, name: 'Ghost', x: 0, y: 0, pages: [{ trigger: 0, image: { characterName: 'Ghost404', characterIndex: 0 }, conditions: {}, list: [{ code: 401, indent: 0, parameters: ['Hi \\GHOST_CODE[1]'] }, { code: 0, indent: 0, parameters: [] }] }] }] }));
    const autoMv = extra => {
      try { return JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'convert-auto.js'), autoMvSource, join(archiveRoot, extra[0]), '--jobs', '1', ...extra.slice(1)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); }
      catch (error) { try { return JSON.parse(String(error.stdout || '').trim()); } catch { return null; } }
    };
    const quietAuto = autoMv(['auto-mv-out']);
    const loudAuto = autoMv(['auto-mv-out-verbose', '--verbose']);
    const quietLog = String(quietAuto?.results?.[0]?.log || '');
    const loudLog = String(loudAuto?.results?.[0]?.log || '');
    acheck(quietAuto?.results?.[0]?.status === 'converted with errors' && existsSync(join(archiveRoot, 'auto-mv-out', 'mv-game', 'mwgp.json')), 'convert:auto converts an MV fixture and flags its missing gameplay sprite');
    acheck(quietLog.includes('missing asset img/characters/Ghost404 [potential-gameplay-use]') && quietLog.includes('GHOST_CODE[1]'), 'the default per-game log keeps exactly the difficulties');
    acheck(!quietLog.includes('Converted 1 maps') && !quietLog.includes('text tables available'), 'the default per-game log drops the informational converter output');
    acheck(loudLog.includes('Converted 1 maps') && loudLog.includes('text tables available') && loudLog.includes('Ghost404'), '--verbose brings the full converter log back');
    mkdirSync(join(archiveRoot, 'v1out'), { recursive: true });
    try {
      execFileSync(process.execPath, [join(root, 'tools', 'extract-rgssad.js'), join(archiveRoot, 'Game.rgssad'), join(archiveRoot, 'v1out')], { stdio: 'pipe' });
      acheck(readFileSync(join(archiveRoot, 'v1out', 'Data', 'System.rxdata')).equals(sysData), 'v1 archive still round-trips after the refactor');
    } catch (error) {
      acheck(false, `v1 archive extracts (${String(error.stderr || error.message).slice(0, 200)})`);
    }
    const badRun = args => {
      try { execFileSync(process.execPath, [join(root, 'tools', 'extract-rgssad.js'), ...args], { stdio: 'pipe' }); return 'ran'; }
      catch (error) { return String(error.stderr || error.message); }
    };
    writeFileSync(join(archiveRoot, 'bad.bin'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    acheck(badRun([join(archiveRoot, 'bad.bin'), join(archiveRoot, 'badout')]).includes('not an RGSSAD archive'), 'bad magic fails loudly');
    const v2 = Buffer.from(v3); v2[7] = 2;
    writeFileSync(join(archiveRoot, 'Game2.rgssad'), v2);
    acheck(badRun([join(archiveRoot, 'Game2.rgssad'), join(archiveRoot, 'v2out')]).includes('Unsupported RGSSAD version 2'), 'unknown version fails loudly');
    const corrupt = Buffer.from(v3);
    corrupt.writeUInt32LE(((0xfffff000 ^ ((Math.imul(0x11223344, 9) + 3) >>> 0)) >>> 0), 12);
    writeFileSync(join(archiveRoot, 'Game3.rgss3a'), corrupt);
    acheck(badRun([join(archiveRoot, 'Game3.rgss3a'), join(archiveRoot, 'v3out2')]).includes('corrupt v3 entry'), 'out-of-range v3 offset fails loudly');
  } finally {
    rmSync(archiveRoot, { recursive: true, force: true });
  }
  for (const [ok, label] of archiveChecks) if (!ok) fail(`RGSSAD fixture: ${label}`);
  notes.push(`RGSSAD v1/v3 fixtures extract (${archiveChecks.length} checks)`);
} catch (error) {
  fail(`RGSSAD fixture check failed: ${String(error.message).slice(0, 200)}`);
}

// 6: lazy per-map index (T119) - stubs keep id+info and drop data/mwgEvents,
// every stub resolves back to its full entry, and the index is far smaller.
try {
  const { buildMapIndex, findMapEntry, spliceMapEntry, manifestVersion, indexCacheKey, mapCacheKey } = await import(pathToFileURL(join(root, 'src', 'map-index.js')).href);
  // Cache keys invalidate with the file version: a reconvert (new mtime/size)
  // must not serve the previous conversion's compressed payloads.
  const statA = { mtimeMs: 1000, size: 71 }, statB = { mtimeMs: 2000, size: 71 };
  if (manifestVersion(statA) === manifestVersion(statB)) fail('manifest version must change with mtime');
  if (indexCacheKey('f', statA) === indexCacheKey('f', statB)) fail('index cache key must change with mtime');
  if (mapCacheKey('f', statA, 3) === mapCacheKey('f', statB, 3)) fail('map cache key must change with mtime');
  if (mapCacheKey('f', statA, 3) === mapCacheKey('f', statA, 4)) fail('map cache key must change with map id');
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

// 8: maps-sweep resume log - parse/filter/prune rules over synthetic log text.
try {
  const { filterResumedMaps, parseResumeSkips, pruneProjectLines } = await import(pathToFileURL(join(root, 'tools', 'resume-log.mjs')).href);
  const fakeLog = [
    '2026-09-27T00:00:00.000Z Elementals: sweep start, 3/89 maps',
    '2026-09-27T00:00:01.000Z Elementals: map 1 ok',
    '2026-09-27T00:00:02.000Z Elementals: map 2 PROBLEM',
    '2026-09-27T00:00:03.000Z Karryn: map 1 ok',
    '2026-09-27T00:00:04.000Z Elementals: map 3 ok',
    ''
  ].join('\n');
  const done = parseResumeSkips(fakeLog, 'Elementals');
  if (done.size !== 2 || !done.has(1) || !done.has(3)) fail('resume log must collect only ok maps of the project');
  const { maps, skipped } = filterResumedMaps([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], done);
  if (skipped !== 2 || maps.map(map => map.id).join(',') !== '2,4') fail('resume filter must drop ok maps and retry PROBLEM/untested ones');
  const pruned = pruneProjectLines(fakeLog, 'Elementals');
  if (/Elementals: (map|sweep start)/.test(pruned) || !/Karryn: map 1 ok/.test(pruned)) fail('fresh runs must prune only their own project lines');
  else notes.push('maps-sweep resume log ok (parse/filter/prune)');
} catch (error) {
  fail(`resume log check failed: ${String(error.message).slice(0, 200)}`);
}

// Generic RGSS conversion/runtime fixes found by playing a Ruby game through (tools/test-rgss-fixes.mjs).
try {
  const passed = JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'test-rgss-fixes.mjs')], { stdio: 'pipe' }).toString());
  notes.push(`RGSS generic fixes ok (${passed.length} checks)`);
} catch (error) {
  fail(`RGSS generic fixes failed: ${String(error.stderr || error.message).slice(0, 300)}`);
}

// MWGP Studio bridge (DOC59 triple): lift/publish/merge/compare on a synthetic
// manifest — player-visible must be Studio-editable, edits must publish, and
// editor-modified entities must survive a later conversion with a comparable
// conflict report (tools/test-mwgp-studio.mjs).
try {
  execFileSync(process.execPath, [join(root, 'tools', 'test-mwgp-studio.mjs')], { stdio: 'pipe' });
  notes.push('mwgp-studio triple ok (lift/edit/publish/merge/compare)');
} catch (error) {
  fail(`mwgp-studio triple failed: ${String(error.stderr || error.message).slice(0, 300)}`);
}

// MWGP Studio integration: real MV/MZ and RGSS XP manifest edits, publication & merge
try {
  execFileSync(process.execPath, [join(root, 'tools', 'test-studio-integration.mjs')], { stdio: 'pipe' });
  notes.push('mwgp-studio integration ok (MZ + XP edit/publish/merge)');
} catch (error) {
  fail(`mwgp-studio integration failed: ${String(error.stderr || error.message).slice(0, 300)}`);
}

// Edited Ruby event scripts regenerate their JS, and battles hand noted skills to the game's own engine.
for (const [file, label] of [['test-studio-code.mjs', 'studio Ruby recompile'], ['test-battle-engine.mjs', 'battle engine bridge'], ['test-list-hook.mjs', 'list hooks'], ['test-map-rules.mjs', 'map rules']]) {
  try {
    const output = execFileSync(process.execPath, [join(root, 'tools', file)], { stdio: 'pipe', encoding: 'utf8' });
    notes.push(`${label} ok${/SKIPPED/.test(output) ? ' (some checks skipped: see the test output)' : ''}`);
  } catch (error) {
    fail(`${label} failed: ${String(error.stderr || error.message).slice(0, 300)}`);
  }
}

// Browser harness (T126): the headless Chromium playthrough over every converted
// project, wired into npm test so regressions are caught without a manual run.
// MWGP_BROWSER=0 skips it loudly; a machine with no playable browser (no
// playwright/chromium installed) also skips loudly instead of failing — only a
// harness that runs and reports failures fails the suite.
try {
  if (process.env.MWGP_BROWSER === '0') {
    notes.push('browser harness skipped (loud): MWGP_BROWSER=0 - no browser coverage this run; the Node suite alone does not prove a game boots');
  } else {
    const { spawnSync } = await import('node:child_process');
    console.log('browser harness: driving every converted project in Chromium...');
    const ran = spawnSync(process.execPath, [join(root, 'tools', 'test-browser.mjs')], { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(ran.stdout || '');
    process.stderr.write(ran.stderr || '');
    const output = `${ran.stdout || ''}\n${ran.stderr || ''}`;
    const skipped = output.split('\n').find(line => line.includes('SKIPPED (loud)'));
    const summary = output.split('\n').filter(line => line.startsWith('Browser smoke:')).pop();
    if (ran.error) fail(`browser harness could not run: ${String(ran.error?.message || ran.error).slice(0, 200)}`);
    else if (skipped) notes.push(`browser harness: ${skipped.trim()}`);
    else if (ran.status === 0 && summary && /no failures/.test(summary) && !/[1-9]\d* with console errors/.test(summary)) notes.push(`browser harness ok (${summary.replace(/^Browser smoke: /, '')})`);
    else {
      // Name the noisy projects: the harness summary's trailing "no failures"
      // means no FAILED verdicts, which reads wrong next to a gate failure.
      const noisy = output.split('\n').filter(line => line.includes('PASS (with console errors)')).map(line => line.trim());
      const what = summary ? summary.replace(/^Browser smoke: /, '').replace(/, no failures$/, '') : `exit ${ran.status}`;
      fail(`browser harness failed (${what}${noisy.length ? ` [${noisy.join('; ')}]` : ''})`);
    }
  }
} catch (error) {
  fail(`browser harness could not run: ${String(error?.message || error).slice(0, 200)}`);
}

if (failures.length) {
  console.error(`smoke test FAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, notes }, null, 2));
