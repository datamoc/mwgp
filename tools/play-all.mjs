#!/usr/bin/env node
// Play-everything harness: find every RPG Maker game under a source tree, convert it, then run it in real Chromium and
// judge the MWGP player against the original engine.
//
//   node tools/play-all.mjs [sourceDir=RPGM_versions] [--only <name>] [--maps N] [--steps N] [--seed N]
//                           [--skip-convert] [--reconvert] [--no-parity] [--out reports/play-all]
//
// Per game it produces:
//   * conversion:   MWGP manifest (MWGP_port/<game>) and, for MV/MZ, the original engine as a web build
//                   (MWGP_reference/<game>) - the reference the port is compared with.
//   * boot/maps:    tools/test-browser.mjs --only <game> --maps N (does every sampled map boot, draw, and stay quiet).
//   * render:       N maps rendered by the original engine and by the port at the same spot, compared block by block. PNGs of
//                   reference, port and diff go to <out>/<game>/.
//   * progression:  the same seeded input script (confirm + walking) driven into both, sampling map, position, gold,
//                   switches and variables every step; reports where the port's trajectory leaves the original's and how
//                   much of the original's progress (maps visited, switches/variables changed) the port reproduces.
// RGSS games (XP/VX/Ace) have no browser-native original, so they get conversion + boot/maps + progression of the port
// alone (state recorded, compared with nothing); the report says so rather than pretending a comparison.
//
// Exit code 1 when any game fails to convert/boot, or a render/progression parity score is under its threshold
// (--min-render, default 0.70 of blocks matching; --min-progress, default 0.50).
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const usage = `Usage: node tools/play-all.mjs [sourceDir] [options]
  --help                Show this help without running or converting anything
  --list                List detected games without running or converting anything
  --only <name>         Test one detected game
  --maps <N>            Maps sampled per game (positive integer, default 4)
  --steps <N>           Seeded input steps (positive integer, default 150)
  --seed <N>            Unsigned 32-bit random seed (default 7)
  --skip-convert        Use existing outputs without converting
  --reconvert           Rebuild existing outputs
  --no-parity           Run only browser boot/map checks
  --out <directory>     Report and screenshot directory
  --port <N>            First of three local test ports (default 4291)
  --timeout <seconds>   Timeout per converter/browser subprocess (default 1800)
  --min-render <0..1>    Minimum render similarity per map (default 0.70)
  --min-progress <0..1>  Minimum coverage per progression category (default 0.50)
Reports describe sampled checks, not proof that a whole game can be completed.`;
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
const valueOptions = ['--only', '--maps', '--steps', '--seed', '--out', '--port', '--timeout', '--min-render', '--min-progress'];
const booleanOptions = ['--list', '--skip-convert', '--reconvert', '--no-parity'];
const positional = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (valueOptions.includes(arg)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
    index++;
  } else if (!booleanOptions.includes(arg)) {
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
}
if (positional.length > 1) throw new Error('Only one source directory is accepted');
const flag = name => args.includes(name);
const opt = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const sourceRoot = resolve(positional[0] || join(root, 'RPGM_versions'));
const only = opt('--only', null);
const mapLimit = Number(opt('--maps', 4));
const steps = Number(opt('--steps', 150));
const seed = Number(opt('--seed', 7));
const outDir = resolve(opt('--out', join(root, 'reports', 'play-all')));
const minRender = Number(opt('--min-render', 0.7));
const minProgress = Number(opt('--min-progress', 0.5));
const firstPort = Number(opt('--port', 4291));
const childTimeout = Number(opt('--timeout', 1800)) * 1000;
for (const [name, value] of [['--maps', mapLimit], ['--steps', steps], ['--timeout', childTimeout / 1000]]) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('--seed must be an unsigned 32-bit integer');
if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65533) throw new Error('--port must be between 1024 and 65533');
for (const [name, value] of [['--min-render', minRender], ['--min-progress', minProgress]]) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}
if (flag('--skip-convert') && flag('--reconvert')) throw new Error('--skip-convert and --reconvert cannot be combined');
const portRoot = join(root, 'MWGP_port'), referenceRoot = join(root, 'MWGP_reference');

// ---- discovery --------------------------------------------------------------------------------------------------
const kindOf = folder => {
  const has = (...names) => names.some(name => existsSync(join(folder, name)));
  if (has('www/index.html') || has('index.html') && has('package.json')) return 'mv-mz';
  if (has('Game.rgssa', 'Game.rgssad', 'Game.rgss2a', 'Game.rgss3a')) return 'rgss';
  const data = join(folder, 'Data');
  if (existsSync(data) && readdirSync(data).some(name => /\.(rxdata|rvdata2?)$/i.test(name))) return 'rgss';
  return null;
};
function discover(dir, depth = 0, found = []) {
  if (!existsSync(dir) || depth > 3) return found;
  const kind = depth > 0 || kindOf(dir) ? kindOf(dir) : null;
  if (kind) { found.push({ name: basename(dir), dir, kind }); return found; }
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && !/^(node_modules|\.git)$/.test(entry.name)) discover(join(dir, entry.name), depth + 1, found);
  return found;
}
const games = discover(sourceRoot).filter(game => !only || game.name === only);
if (!games.length) { console.error(`No RPG Maker game found under ${sourceRoot}`); process.exit(1); }
if (flag('--list')) { console.log(JSON.stringify(games, null, 2)); process.exit(0); }

// ---- conversion -------------------------------------------------------------------------------------------------
function run(commandArgs, label, gameName) {
  const result = spawnSync(process.execPath, commandArgs, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: childTimeout, env: { ...process.env, MWGP_PROGRESS: '' } });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? '\n' + result.error.message : ''}`;
  const directory = join(outDir, gameName); mkdirSync(directory, { recursive: true });
  const log = join(directory, `${label}.log`);
  writeFileSync(log, output);
  const errorLine = output.split(/\r?\n/).find(line => /Error:|ENOENT|SyntaxError|timed out/.test(line));
  return { ok: result.status === 0 && !result.error, error: errorLine || output.slice(-1000), log };
}
function convert(game) {
  const notes = [];
  let ok = true;
  const reconvert = flag('--reconvert');
  const fresh = (outputRoot, marker) => !reconvert && existsSync(join(outputRoot, game.name, marker));
  const tool = game.kind === 'mv-mz' ? ['tools/convert-mv.js', game.dir, join(portRoot, game.name), '--copy-assets'] : ['tools/convert-rgss.js', game.dir, join(portRoot, game.name)];
  if (fresh(portRoot, 'mwgp.json')) notes.push('mwgp: existing output reused (freshness not checked; --reconvert rebuilds it)');
  else { const done = run(tool, 'mwgp', game.name); ok = done.ok; notes.push(`mwgp: ${done.ok ? 'ok' : 'FAILED ' + done.error} (log: ${done.log})`); }
  let reference = false;
  if (game.kind === 'mv-mz') {
    if (fresh(referenceRoot, 'mwgp-web.json')) notes.push('reference web build: existing output reused (freshness not checked)');
    else { const web = run(['tools/build-web.js', game.dir, join(referenceRoot, game.name)], 'web', game.name); ok = ok && web.ok; notes.push(`reference web build: ${web.ok ? 'ok' : 'FAILED ' + web.error} (log: ${web.log})`); }
    reference = existsSync(join(referenceRoot, game.name, 'mwgp-web.json'));
  }
  return { ok: ok && existsSync(join(portRoot, game.name, 'mwgp.json')), reference, notes };
}

// ---- browser ----------------------------------------------------------------------------------------------------
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright'];
  try { candidates.push(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* no npm */ }
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'));
  for (const candidate of candidates) { try { return require(candidate); } catch { /* next */ } }
  return null;
}
function installedChromium() {
  const dir = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (!dir || !existsSync(dir)) return null;
  const builds = readdirSync(dir).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) for (const rel of ['chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) { const file = join(dir, build, rel); if (existsSync(file)) return file; }
  return null;
}
async function startServer(mwgpRoot, port) {
  await checkPort(port);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, MWGP_ROOT: mwgpRoot, RPGM_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  for (let index = 0; index < 60; index++) {
    if (child.exitCode !== null) throw new Error(`server on ${port} exited: ${errors}`);
    try { if ((await fetch(`${base}/api/games`, { signal: AbortSignal.timeout(1000) })).ok) return { child, base }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  child.kill(); throw new Error(`server on ${port} never came up: ${errors}`);
}
async function checkPort(port) {
  const probe = createServer();
  await new Promise((resolvePort, reject) => {
    probe.once('error', error => reject(new Error(`Test port ${port} unavailable: ${error.message}. Choose --port <N>.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePort));
  });
}
const lcg = start => { let value = start >>> 0; return () => (value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 4294967296; };

// Same seeded script for both sides: mostly walking in short bursts, with confirm presses to advance text/choices.
function inputScript(count, start) {
  const next = lcg(start), keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], script = [];
  for (let index = 0; index < count; index++) {
    const roll = next();
    script.push(roll < 0.35 ? { key: 'Enter', hold: 140 } : { key: keys[Math.floor(next() * 4)], hold: 220 + Math.floor(next() * 260) });
  }
  return script;
}
async function drive(page, script, sample, traceFile) {
  const trace = [];
  const started = Date.now();
  writeFileSync(traceFile, '');
  const record = (step, state) => {
    const entry = { step, elapsedMs: Date.now() - started, ...state };
    trace.push(entry);
    appendFileSync(traceFile, JSON.stringify(entry) + '\n');
  };
  record(-1, await withTimeout(sample(page), 10000, 'Game stopped answering before progression'));
  for (const [index, step] of script.entries()) {
    const advance = async () => {
      await page.keyboard.down(step.key);
      try { await page.waitForTimeout(step.hold); } finally { await page.keyboard.up(step.key); }
      await page.waitForTimeout(80);
      return sample(page);
    };
    record(index, await withTimeout(advance(), 15000, `Game stopped answering at input step ${index} (${step.key})`));
  }
  return trace;
}
async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

const sampleReference = page => page.evaluate(() => ({
  map: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, gold: $gameParty.gold(),
  switches: $gameSwitches._data.map((value, id) => value ? id : 0).filter(Boolean),
  variables: Object.fromEntries($gameVariables._data.map((value, id) => [id, value]).filter(([id, value]) => id && value)),
  message: Boolean($gameMessage.isBusy())
}));
const samplePort = page => page.evaluate(() => {
  const scene = globalThis.__MWG__?.currentScene, state = scene?.gameState?.toJSON?.() || {};
  if (!scene?.mover) throw new Error('MWGP scene or mover unavailable while sampling progression');
  const pairs = list => (Array.isArray(list) ? list : []);
  return {
    map: Number(new URL(location.href).searchParams.get('map') ?? scene?.project?.initialMapId ?? 0), x: scene?.mover?.x ?? null, y: scene?.mover?.y ?? null,
    gold: Number(scene?.rpgExtra?.gold || 0),
    switches: pairs(state.switches).filter(([id, value]) => value && /^\d+$/.test(String(id))).map(([id]) => Number(id)),
    selfSwitches: pairs(state.switches).filter(([id, value]) => value && String(id).startsWith('self:')).map(([id]) => String(id)),
    variables: Object.fromEntries(pairs(state.variables).filter(([, value]) => value)),
    message: Boolean(scene?.dialogue || scene?.eventRunning), dialogue: Boolean(scene?.dialogue)
  };
});

// Capture failures throughout boot and input, including ones logged and recovered by the player.
function observe(page, result) {
  page.on('pageerror', error => result.pageErrors.push(String(error?.stack || error).slice(0, 2000)));
  const networkDiagnostic = (request, diagnostic) => {
    const required = ['script', 'stylesheet', 'image', 'media', 'font'].includes(request.resourceType());
    const target = required ? result.runtimeErrors : result.networkNotes;
    if (!target.includes(diagnostic)) target.push(diagnostic);
  };
  page.on('response', response => {
    if (response.status() < 400) return;
    const type = response.request().resourceType();
    const diagnostic = `HTTP ${response.status()} ${type}: ${response.url()}`;
    // A fetch/XHR may deliberately probe an optional file and handle its absence.
    // Failed script/image/media loads cannot be handled that way by their elements.
    networkDiagnostic(response.request(), diagnostic);
  });
  page.on('requestfailed', request => networkDiagnostic(request, `${request.failure()?.errorText}: ${request.url()}`));
  page.on('console', message => {
    const value = message.text();
    if (value.startsWith('MWGP compatibility:')) { result.compatibilityNotes.push(value); return; }
    if (value.startsWith('Failed to load resource:')) {
      result.networkNotes.push(`${value} (${message.location().url})`);
      return;
    }
    const runtimeWarning = message.type() === 'warning' && /\bMWGP\b/.test(value);
    if (message.type() === 'error' || runtimeWarning || /MWGP.*(?:unsupported|not supported|skipped|failed|cannot|unknown|not implemented)/i.test(value)) {
      const location = message.location();
      const diagnostic = `${value}${location.url ? ` (${location.url}:${location.lineNumber})` : ''}`.slice(0, 2000);
      if (!result.runtimeErrors.includes(diagnostic)) result.runtimeErrors.push(diagnostic);
    }
  });
}
const diagnostics = () => ({ pageErrors: [], runtimeErrors: [], networkNotes: [], compatibilityNotes: [] });

// Timing differs between the engines (text speed, frame rate), so compare what each run ever reached - maps visited,
// switches turned on, variables changed - not the state at one instant. A reference that got further than the port
// (the port is stuck or missing logic) lowers the score; a port that got further than the reference does not.
function progressScore(reference, port) {
  const valid = trace => trace.filter(entry => !entry.error);
  const reached = (trace, pick) => new Set(valid(trace).flatMap(pick));
  const covered = (referenceSet, portSet) => referenceSet.size ? [...referenceSet].filter(item => portSet.has(item)).length / referenceSet.size : 1;
  const maps = [reached(reference, entry => [entry.map]), reached(port, entry => [entry.map])];
  const switches = [reached(reference, entry => entry.switches), reached(port, entry => entry.switches)];
  const variables = [reached(reference, entry => Object.keys(entry.variables)), reached(port, entry => Object.keys(entry.variables))];
  const mapScore = covered(maps[0], maps[1]), switchScore = covered(switches[0], switches[1]), variableScore = covered(variables[0], variables[1]);
  const goldOf = trace => Math.max(0, ...valid(trace).map(entry => entry.gold));
  const goldReference = goldOf(reference), goldPort = goldOf(port);
  const goldScore = goldReference ? Math.min(1, goldPort / goldReference) : 1;
  return { score: (mapScore + switchScore + variableScore + goldScore) / 4, mapScore, switchScore, variableScore, goldScore, goldReference, goldPort, mapsReference: [...maps[0]], mapsPort: [...maps[1]], onlyInReference: { switches: [...switches[0]].filter(id => !switches[1].has(id)), variables: [...variables[0]].filter(id => !variables[1].has(id)) } };
}

async function diffImages(page, a, b) {
  return page.evaluate(async ([left, right]) => {
    const load = src => new Promise((resolveImage, reject) => { const image = new Image(); image.onload = () => resolveImage(image); image.onerror = reject; image.src = src; });
    const [imageA, imageB] = await Promise.all([load(left), load(right)]);
    const width = Math.min(imageA.width, imageB.width), height = Math.min(imageA.height, imageB.height);
    const draw = image => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, width, height); return context.getImageData(0, 0, width, height); };
    const dataA = draw(imageA), dataB = draw(imageB), out = document.createElement('canvas'); out.width = width; out.height = height;
    const outContext = out.getContext('2d'), outData = outContext.createImageData(width, height);
    // Structural, not pixel-exact: scaling, smoothing and UI chrome differ by design, so compare the mean colour of 8x8
    // blocks and call a block equal when it is within a tolerance (a dimmed or wrongly tinted map still fails).
    const BLOCK = 8; let same = 0, blocks = 0;
    const mean = (data, bx, by) => { let r = 0, g = 0, b = 0, n = 0; for (let y = by; y < Math.min(by + BLOCK, height); y++) for (let x = bx; x < Math.min(bx + BLOCK, width); x++) { const i = (y * width + x) * 4; r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2]; n++; } return [r / n, g / n, b / n]; };
    for (let by = 0; by < height; by += BLOCK) for (let bx = 0; bx < width; bx += BLOCK) {
      const ma = mean(dataA, bx, by), mb = mean(dataB, bx, by);
      const equal = Math.abs(ma[0] - mb[0]) + Math.abs(ma[1] - mb[1]) + Math.abs(ma[2] - mb[2]) <= 60;
      blocks++; if (equal) same++;
      for (let y = by; y < Math.min(by + BLOCK, height); y++) for (let x = bx; x < Math.min(bx + BLOCK, width); x++) { const i = (y * width + x) * 4; outData.data[i] = equal ? dataA.data[i] >> 2 : 255; outData.data[i + 1] = equal ? dataA.data[i + 1] >> 2 : 0; outData.data[i + 2] = equal ? dataA.data[i + 2] >> 2 : 0; outData.data[i + 3] = 255; }
    }
    outContext.putImageData(outData, 0, 0);
    return { equal: same / blocks, diff: out.toDataURL('image/png'), size: [imageA.width, imageA.height, imageB.width, imageB.height] };
  }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]);
}

const saveDataUrl = (file, url) => writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
const sampleMaps = (manifest, limit) => {
  const maps = manifest.maps.filter(map => map.data?.width && map.data?.height);
  if (maps.length <= limit) return maps;
  return Array.from({ length: limit }, (_, index) => maps[Math.floor(index * maps.length / limit)]);
};

async function parity(game, browser, servers) {
  const result = { render: [], progression: null, notes: [], port: diagnostics(), reference: diagnostics() };
  let stage = '';
  const gameOut = join(outDir, game.name); mkdirSync(gameOut, { recursive: true });
  const id = Buffer.from(game.name, 'utf8').toString('base64url');
  const referenceUrl = `${servers.reference.base}/web/${Buffer.from(game.name, 'utf8').toString('base64url')}/`;
  const manifest = JSON.parse(readFileSync(join(portRoot, game.name, 'mwgp.json'), 'utf8'));
  const newContext = () => browser.newContext({ viewport: { width: 1100, height: 900 } });
  const diffPage = await (await newContext()).newPage();
  const bootReference = async context => {
    const page = await context.newPage();
    observe(page, result.reference);
    await page.goto(referenceUrl);
    await page.waitForFunction(() => typeof SceneManager !== 'undefined' && SceneManager._scene && typeof Scene_Boot !== 'undefined' && !(SceneManager._scene instanceof Scene_Boot) && (SceneManager._sceneStarted || SceneManager._scene.isStarted?.()), null, { timeout: 120000 });
    // The original stretches its canvas to the window; pin it to its native size so the comparison is pixel for pixel.
    await page.evaluate(() => { try { Graphics._stretchEnabled = false; Graphics._updateAllElements(); } catch { /* engine without stretch */ } });
    return page;
  };

  // --- render ---
  for (const map of sampleMaps(manifest, mapLimit)) {
    const x = Math.floor(map.data.width / 2), y = Math.floor(map.data.height / 2), entry = { map: map.id, equal: null };
    const referenceContext = await newContext(), portContext = await newContext();
    try {
      stage = 'reference boot'; const referencePage = await bootReference(referenceContext);
      stage = 'reference transfer'; await referencePage.evaluate(([mapId, px, py]) => { DataManager.setupNewGame(); $gamePlayer.reserveTransfer(mapId, px, py, 2, 0); SceneManager.goto(Scene_Map); }, [Number(map.id), x, y]);
      await referencePage.waitForFunction(mapId => SceneManager._scene instanceof Scene_Map && $gameMap.mapId() === mapId && !$gamePlayer.isTransferring() && (SceneManager._sceneStarted || SceneManager._scene.isStarted?.()), Number(map.id), { timeout: 60000 });
      await referencePage.waitForTimeout(1500);
      const referenceShot = await referencePage.locator('canvas').first().screenshot();
      stage = 'port boot'; const portPage = await portContext.newPage();
      observe(portPage, result.port);
      await portPage.goto(`${servers.port.base}/player.html?id=${id}&map=${map.id}&x=${x}&y=${y}&skipTitle=1&scale=1`, { waitUntil: 'domcontentloaded' });
      await portPage.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 60000 });
      await portPage.waitForSelector('#loading', { state: 'detached', timeout: 60000 }).catch(() => {});
      await portPage.waitForFunction(() => globalThis.__MWG__?.currentScene?.screenEffects?.phase === 'idle', null, { timeout: 20000 }).catch(() => {});
      await portPage.waitForTimeout(2500);
      const portShot = await portPage.locator('canvas').first().screenshot();
      const compared = await diffImages(diffPage, referenceShot, portShot);
      writeFileSync(join(gameOut, `map-${map.id}-reference.png`), referenceShot); writeFileSync(join(gameOut, `map-${map.id}-port.png`), portShot); saveDataUrl(join(gameOut, `map-${map.id}-diff.png`), compared.diff);
      entry.equal = compared.equal; entry.size = compared.size;
    } catch (error) { entry.error = stage + ': ' + String(error?.message || error).split('\n')[0].slice(0, 200); }
    finally { await referenceContext.close(); await portContext.close(); }
    result.render.push(entry);
  }

  // --- progression ---
  const script = inputScript(steps, seed);
  const referenceContext = await newContext(), portContext = await newContext();
  try {
    stage = 'reference boot'; const referencePage = await bootReference(referenceContext);
    await referencePage.evaluate(() => { DataManager.setupNewGame(); SceneManager.goto(Scene_Map); });
    await referencePage.waitForFunction(() => SceneManager._scene instanceof Scene_Map && (SceneManager._sceneStarted || SceneManager._scene.isStarted?.()), null, { timeout: 60000 });
    await referencePage.waitForTimeout(1500);
    const referenceTrace = await drive(referencePage, script, sampleReference, join(gameOut, 'reference-trace.jsonl'));
    stage = 'port boot'; const portPage = await portContext.newPage();
    observe(portPage, result.port);
    await portPage.goto(`${servers.port.base}/player.html?id=${id}&newGame=1&skipTitle=1&scale=1`, { waitUntil: 'domcontentloaded' });
    await portPage.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 60000 });
    await portPage.waitForSelector('#loading', { state: 'detached', timeout: 60000 }).catch(() => {});
    await portPage.waitForFunction(() => globalThis.__MWG__?.currentScene?.screenEffects?.phase === 'idle', null, { timeout: 20000 }).catch(() => {});
      await portPage.waitForTimeout(2500);
    const portTrace = await drive(portPage, script, samplePort, join(gameOut, 'port-trace.jsonl'));
    writeFileSync(join(gameOut, 'progression.json'), JSON.stringify({ script, reference: referenceTrace, port: portTrace }));
    result.progression = progressScore(referenceTrace, portTrace);
    result.progression.samples = { reference: referenceTrace.length, port: portTrace.length };
  } catch (error) { result.progression = { error: stage + ': ' + String(error?.message || error).split('\n')[0].slice(0, 200) }; }
  finally { await referenceContext.close(); await portContext.close(); await diffPage.context().close(); }
  return result;
}

// RGSS games have no original that renders in a headless browser (the mkxp-z core draws nothing without a GPU), so the port is
// driven alone: same seeded script, screenshots for a human to judge, and the objective signals that need no reference -
// uncaught page errors, script calls the shim skipped, and whether the run went anywhere (position, map, switches changed).
async function portOnly(game, browser, servers) {
  const gameOut = join(outDir, game.name); mkdirSync(gameOut, { recursive: true });
  const id = Buffer.from(game.name, 'utf8').toString('base64url');
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const observed = diagnostics();
  observe(page, observed);
  try {
    await page.goto(`${servers.port.base}/player.html?id=${id}&newGame=1&skipTitle=1&scale=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 90000 });
    await page.waitForSelector('#loading', { state: 'detached', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator('canvas').first().screenshot({ path: join(gameOut, 'start.png') });
    const trace = await drive(page, inputScript(steps, seed), samplePort, join(gameOut, 'port-trace.jsonl'));
    await page.locator('canvas').first().screenshot({ path: join(gameOut, 'end.png') });
    const valid = trace.filter(entry => !entry.error);
    const cells = new Set(valid.map(entry => entry.map + ':' + entry.x + ',' + entry.y));
    let dialogueChanges = 0;
    for (let index = 1; index < valid.length; index++) if (valid[index].dialogue !== valid[index - 1].dialogue) dialogueChanges++;
    const gaps = await page.evaluate(() => globalThis.__MWG__?.currentScene?.rgss?.introspect?.().warned || []).catch(() => []);
    writeFileSync(join(gameOut, 'progression.json'), JSON.stringify({ trace, gaps }));
    return { portOnly: true, cellsVisited: cells.size, mapsReached: [...new Set(valid.map(entry => entry.map))], samples: trace.length, switchesOn: valid.at(-1)?.switches.length ?? 0, skippedScriptCalls: gaps.length, skippedExamples: gaps.slice(0, 5), ...observed, dialogueChanges, moved: cells.size > 1 || dialogueChanges >= 2 };
  } catch (error) { return { portOnly: true, error: String(error?.stack || error).slice(0, 2000), ...observed };
  } finally { await context.close(); }
}

// ---- main -------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const report = [];
const pct = value => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const checkpoint = () => writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
function problemsFor(entry, renderMean) {
  const problems = [];
  if (!entry.convert?.ok) { problems.push('convert'); return problems; }
  if (!entry.validation?.ok) { problems.push('manifest validation'); return problems; }
  if (!entry.browser?.ok) problems.push(entry.browser?.skipped ? 'browser skipped' : 'browser');
  if (renderMean != null && entry.parity.render.some(render => render.equal != null && render.equal < minRender)) problems.push('render');
  const progression = entry.parity?.progression;
  if (progression && !progression.error && ['mapScore', 'switchScore', 'variableScore', 'goldScore'].some(key => progression[key] < minProgress)) problems.push('progression');
  if (entry.parity) {
    if (entry.parity.render.some(render => render.error) || progression?.error) problems.push('parity error');
    for (const side of ['port', 'reference']) {
      if (entry.parity[side].pageErrors.length || entry.parity[side].runtimeErrors.length) problems.push(`${side} runtime errors`);
    }
  }
  if (entry.solo) {
    const solo = entry.solo;
    if (solo.error || solo.pageErrors.length || solo.runtimeErrors.length || solo.skippedScriptCalls || !solo.moved) problems.push('port-only run');
  }
  if (!flag('--no-parity') && !entry.parity && !entry.solo) problems.push('progression not run');
  return problems;
}
for (const game of games) {
  console.log(`\n== ${game.name} (${game.kind}) ==`);
  const entry = { name: game.name, kind: game.kind, startedAt: new Date().toISOString(), convert: null, validation: null, browser: null, parity: null };
  entry.convert = flag('--skip-convert') ? { ok: existsSync(join(portRoot, game.name, 'mwgp.json')), reference: game.kind === 'mv-mz' && existsSync(join(referenceRoot, game.name, 'mwgp-web.json')), notes: ['skipped'] } : convert(game);
  for (const note of entry.convert.notes) console.log(`  convert: ${note}`);
  report.push(entry);
  checkpoint();
  if (!entry.convert.ok) continue;
  const validation = run(['tools/validate-mwgp.js', join(portRoot, game.name, 'mwgp.json')], 'validate', game.name);
  entry.validation = { ok: validation.ok, log: validation.log, ...(validation.ok ? {} : { error: validation.error }) };
  console.log(`  manifest: ${validation.ok ? 'valid' : 'FAILED ' + validation.error}`);
  checkpoint();
  if (!validation.ok) continue;
  try { await checkPort(firstPort); } catch (error) {
    entry.browser = { ok: false, summary: [error.message] }; checkpoint(); continue;
  }
  const browserRun = spawnSync(process.execPath, ['tools/test-browser.mjs', '--only', game.name, '--maps', String(mapLimit)], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: childTimeout, env: { ...process.env, MWGP_ROOT: portRoot, RPGM_SMOKE_PORT: String(firstPort), MWGP_SMOKE_BASE: '', MWGP_SMOKE_RESUME: '0', MWGP_SMOKE_PROGRESS: join(outDir, 'maps-progress.log') } });
  const browserOutput = `${browserRun.stdout || ''}${browserRun.stderr || ''}${browserRun.error ? '\n' + browserRun.error.message : ''}`;
  const browserLog = join(outDir, game.name); mkdirSync(browserLog, { recursive: true });
  writeFileSync(join(browserLog, 'browser.log'), browserOutput);
  const skipped = /SKIPPED \(loud\)/.test(browserOutput);
  entry.browser = { ok: browserRun.status === 0 && !browserRun.error && !skipped && /Browser smoke:/.test(browserOutput), skipped, exitCode: browserRun.status, summary: browserOutput.split('\n').filter(line => /PASS|FAIL|SKIPPED|!|Error|timed out/.test(line)).slice(0, 20) };
  for (const line of entry.browser.summary) console.log(`  ${line.trim()}`);
  checkpoint();
}

const playwright = flag('--no-parity') ? null : await loadPlaywright();
const comparable = report.filter(entry => entry.validation?.ok && entry.convert.reference);
const solo = report.filter(entry => entry.validation?.ok && !entry.convert.reference && entry.kind === 'rgss');
if (playwright && (comparable.length || solo.length)) {
  let browser;
  const servers = {};
  try {
    browser = await playwright.chromium.launch({ executablePath: installedChromium() || undefined, args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
    servers.port = await startServer(portRoot, firstPort + 1);
    if (comparable.length) servers.reference = await startServer(referenceRoot, firstPort + 2);
    for (const entry of comparable) {
      console.log(`\n== parity ${entry.name} ==`);
      entry.parity = await parity(entry, browser, servers);
      for (const render of entry.parity.render) console.log(`  render map ${render.map}: ${render.error ? 'ERROR ' + render.error : pct(render.equal) + ' of blocks match'}`);
      const progression = entry.parity.progression;
      console.log(`  progression: ${progression?.error ? 'ERROR ' + progression.error : `${pct(progression.score)} (maps ${pct(progression.mapScore)}, switches ${pct(progression.switchScore)}, variables ${pct(progression.variableScore)}, gold ${progression.goldReference} vs ${progression.goldPort}, maps ${progression.mapsReference} vs ${progression.mapsPort})`}`);
      checkpoint();
    }
    for (const entry of solo) {
      console.log(`
== port-only ${entry.name} ==`);
      entry.solo = await portOnly(entry, browser, servers);
      const solo1 = entry.solo;
      console.log(`  ${solo1.error ? 'ERROR ' + solo1.error : `${solo1.cellsVisited} cell(s) visited, maps ${solo1.mapsReached}, ${solo1.switchesOn} switch(es) on, ${solo1.skippedScriptCalls} skipped script call(s), ${solo1.pageErrors.length} page error(s)`}`);
      checkpoint();
    }
  } catch (error) {
    for (const entry of [...comparable, ...solo]) if (!entry.parity && !entry.solo) entry.progressionError = String(error?.stack || error);
    checkpoint();
    console.error(error);
  } finally { await browser?.close(); servers.port?.child.kill(); servers.reference?.child.kill(); }
} else if (!flag('--no-parity')) {
  for (const entry of report.filter(entry => entry.convert?.ok)) entry.progressionError = 'Progression not run: Playwright or original-engine reference missing';
  checkpoint();
  console.error('\nProgression coverage missing (see report).');
}

// ---- report -----------------------------------------------------------------------------------------------------
let failed = false;
const lines = ['# play-all report', '', `Source: \`${sourceRoot}\` - ${new Date().toISOString()} - ${mapLimit} maps, ${steps} input steps, seed ${seed}`, '',
  'Scope: sampled boot, maps and seeded input only. A passing sample does not prove that the entire game can be completed.',
  ...(flag('--no-parity') ? ['Progression and render comparison explicitly disabled (--no-parity).'] : []), '',
  '| Game | Engine | Converts | Validates | Boots + maps | Render equal | Progression | Reference |', '|---|---|---|---|---|---|---|---|'];
for (const entry of report) {
  const renders = entry.parity?.render.filter(render => render.equal != null) || [];
  const renderMean = renders.length ? renders.reduce((sum, render) => sum + render.equal, 0) / renders.length : null;
  const progression = entry.parity?.progression;
  const problems = problemsFor(entry, renderMean);
  entry.problems = problems;
  if (problems.length) failed = true;
  lines.push(`| ${entry.name} | ${entry.kind} | ${entry.convert?.ok ? 'yes' : '**NO**'} | ${entry.validation ? (entry.validation.ok ? 'yes' : '**NO**') : '-'} | ${entry.browser ? (entry.browser.ok ? 'yes' : '**NO**') : '-'} | ${pct(renderMean)} | ${progression ? (progression.error ? 'error' : pct(progression.score)) : entry.solo ? (entry.solo.error ? 'error' : `port only: ${entry.solo.cellsVisited} cells, ${entry.solo.dialogueChanges} dialogue changes, ${entry.solo.skippedScriptCalls} skipped script calls`) : '-'} | ${entry.convert?.reference ? 'original engine' : 'none (port only)'} |${problems.length ? ' FAIL: ' + problems.join(', ') : ''}`);
}
writeFileSync(join(outDir, 'report.md'), lines.join('\n') + '\n');
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nReport: ${join(outDir, 'report.md')}`);
process.exit(failed ? 1 : 0);
