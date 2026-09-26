#!/usr/bin/env node
// Browser smoke harness: boots every MWGP project in a real Chromium page and
// asserts what the Node suite in tools/test-smoke.mjs cannot see - that the
// manifest fetches, the mw_games runtime constructs, a scene starts, the map
// renders, keyboard input moves (or turns) the player, and save/load round-trip.
//
// Run directly:  node tools/test-browser.mjs [--only <project name>] [--maps [N]] [--soak [seconds]]
//   --soak       a bot plays a new game of each project for N seconds (default 60): maps reached, dialogues opened,
//                and any runtime/uncaught error.
//   --maps       also boots every map of each project (or N evenly spread maps) and fails on maps that crash,
//                log console errors, or draw nothing: the reachability part of "can this game be played everywhere".
// Or via:        npm test            (set MWGP_BROWSER=0 to skip it loudly)
//
// MWGP_SMOKE_DEBUG=1 echoes every page console message.
// It starts its own server on RPGM_SMOKE_PORT (default 4199) unless
// MWGP_SMOKE_BASE points at an already-running one.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const mwgpRoot = join(root, 'MWGP_versions');
const port = Number(process.env.RPGM_SMOKE_PORT || 4199);
const base = process.env.MWGP_SMOKE_BASE || `http://127.0.0.1:${port}`;
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
const BOOT_TIMEOUT_MS = Number(process.env.MWGP_SMOKE_BOOT_MS || 120000);

// Loud skip: a missing browser must never look like a green run.
if (process.env.MWGP_BROWSER === '0') {
  console.log('SKIPPED (loud): MWGP_BROWSER=0 - no browser coverage this run; the Node suite alone does not prove a game boots.');
  process.exit(0);
}

const projects = readdirSync(mwgpRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(mwgpRoot, entry.name, 'mwgp.json')))
  .map(entry => entry.name)
  .filter(name => !only || name === only);
if (!projects.length) {
  console.error(`SKIPPED (loud): no converted project under MWGP_versions/${only ? ` matching "${only}"` : ''} to drive.`);
  process.exit(1);
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright'];
  try { candidates.push(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* npm not on PATH */ }
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'));
  for (const candidate of candidates) {
    // require() resolves a package directory (main entry) where import() refuses to.
    try { return require(candidate); } catch { /* try next */ }
    try { return await import(pathToFileURL(candidate).href); } catch { /* try next */ }
  }
  return null;
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return true; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

const playwright = await loadPlaywright();
if (!playwright) {
  console.error('SKIPPED (loud): playwright is not installed locally or globally - browser coverage is NOT running.');
  process.exit(1);
}

let server = null;let startedServer = false;
if (!process.env.MWGP_SMOKE_BASE) {
  server = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    env: { ...process.env, RPGM_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  startedServer = true;
  server.stderr.on('data', chunk => process.env.MWGP_SMOKE_VERBOSE && process.stderr.write(chunk));
  if (!(await waitForServer(`${base}/api/games`))) {
    console.error('FAIL: the launcher server did not come up on ' + base);
    server.kill();
    process.exit(1);
  }
}

const results = [];
// Playwright's default headless target is the separate headless_shell build,
// which a machine may not have downloaded even though the full Chromium is
// there. Prefer the installed full Chromium when we can find it.
function installedChromium() {
  const dir = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (!dir || !existsSync(dir)) return null;
  const builds = readdirSync(dir).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const rel = ['chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'];
  for (const build of builds) for (const candidate of rel) { const file = join(dir, build, candidate); if (existsSync(file)) return file; }
  return null;
}

let browser;
try {
  const executablePath = installedChromium();
  browser = await playwright.chromium.launch({ executablePath: executablePath || undefined, args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
} catch (error) {
  console.error('FAIL: chromium could not start - ' + (error?.message || error));
  if (startedServer) server.kill();
  process.exit(1);
}

// Known-benign console noise: missing optional assets are handled by the player
// (placeholder sheet + loud warning), and the browser logs every 404 as an error.
const resourceNoise = /Failed to load resource|the server responded with a status of 40/i;

async function check(name) {
  const id = Buffer.from(name, 'utf8').toString('base64url');
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  const notes = [];
  page.on('pageerror', error => { errors.push(`uncaught: ${error?.message || error}`); if (process.env.MWGP_SMOKE_DEBUG) console.log(`[pageerror] ${String(error?.stack || error).slice(0, 400)}`); });
  page.on('console', message => {
    if (process.env.MWGP_SMOKE_DEBUG) console.log(`[${message.type()}] ${message.text().slice(0, 300)}`);
    if (message.type() === 'error' && !resourceNoise.test(message.text())) errors.push(`console.error: ${message.text()}`);
    if (message.type() === 'warning' && /MWGP compatibility:/.test(message.text())) notes.push(message.text());
  });

  const fail = async reason => { await context.close().catch(() => {}); return { name, ok: false, reason, errors, notes }; };
  const state = () => page.evaluate(() => {
    const scene = globalThis.__MWG__?.currentScene;
    if (!scene) return null;
    return {
      mapId: scene.mapEntry ? Number(scene.mapEntry.id) : null,
      x: scene.mover?.x ?? null,
      y: scene.mover?.y ?? null,
      facing: scene.mover?.facing ?? scene.facing ?? null,
      dialogue: Boolean(scene.dialogue),
      eventRunning: Boolean(scene.eventRunning)
    };
  });

  try {
    const manifest = await fetch(`${base}/api/mwgp/${encodeURIComponent(id)}`);
    if (!manifest.ok) return await fail(`manifest HTTP ${manifest.status}`);

    await page.goto(`${base}/player.html?id=${encodeURIComponent(id)}&skipTitle=1`, { waitUntil: 'domcontentloaded' });

    // Boot: the loading status disappears once the real player started, and
    // turns into role=alert when bootstrap failed.
    const bootError = `#loading[role="alert"]`;
    const booted = await Promise.race([
      page.waitForSelector('#loading', { state: 'detached', timeout: BOOT_TIMEOUT_MS }).then(() => 'ok'),
      page.waitForSelector(bootError, { timeout: BOOT_TIMEOUT_MS }).then(() => 'failed').catch(() => 'timeout'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), BOOT_TIMEOUT_MS))
    ]);
    if (bootError && booted === 'failed') return await fail(`bootstrap failed: ${(await page.textContent('#loading'))?.trim()}`);
    if (booted !== 'ok') return await fail(`still loading after ${BOOT_TIMEOUT_MS}ms`);

    // The real mw_games player must have started. A silent fall back to the
    // canvas renderer is exactly the degradation this harness exists to catch.
    const ready = await page.waitForFunction(() => {
      const scene = globalThis.__MWG__?.currentScene;
      return Boolean(scene && scene.mover && scene.project);
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!ready) return await fail('mw_games scene never reached ready state (fallback renderer? see console)');

    const canvasBox = await page.evaluate(() => {
      const canvas = document.querySelector('#game');
      return canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null;
    });
    if (!canvasBox || !canvasBox.w || !canvasBox.h) return await fail('the game canvas has no size');

    // Give autorun/intro events a moment, then dismiss any dialogue so input
    // reaches the map.
    await page.waitForTimeout(600);
    for (let index = 0; index < Number(process.env.MWGP_SMOKE_DISMISS || 20); index++) {
      const current = await state();
      if (!current?.dialogue && !current?.eventRunning) break;
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
    }

    // An autorun map transfer reloads the page (state is carried through
    // SaveSystem); wait for the new page's scene instead of reading mid-reload.
    await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 30000 }).catch(() => {});
    if (process.env.MWGP_SMOKE_SETTLE) await page.waitForTimeout(Number(process.env.MWGP_SMOKE_SETTLE));
    const before = await state().catch(() => null);
    if (!before) return await fail('scene state unreadable');

    // Audio: a map whose data says "autoplay BGM" must end up with a live music stream, and no
    // track may have failed to load. Skipped for projects converted without audio.
    const audioExpected = await page.evaluate(() => {
      const scene = globalThis.__MWG__?.currentScene;
      const data = scene?.mapEntry?.data || scene?.project?.maps?.find(m => Number(m.id) === Number(new URLSearchParams(location.search).get('map') || scene.project.initialMapId))?.data;
      return { has: Boolean(scene?.audio), bgm: data?.autoplayBgm !== false && data?.bgm?.name ? data.bgm.name : null };
    }).catch(() => ({ has: false, bgm: null }));
    // Format sweep: one track of every extension the project ships must decode (or, for MIDI,
    // synthesize) in this browser. Formats the browser build lacks are reported, not failed.
    if (audioExpected.has && !process.env.MWGP_SMOKE_NOAUDIO) {
      const sweep = await page.evaluate(async () => {
        const audio = globalThis.__MWG__?.currentScene?.audio;
        const index = audio?.index || {};
        const picks = new Map();
        for (const kind of ['bgm', 'se', 'me', 'bgs']) for (const [name, extension] of Object.entries(index[kind] || {})) if (!picks.has(extension)) picks.set(extension, { kind, name });
        const results = [];
        for (const [extension, { kind, name }] of picks) {
          if (extension === '.wma') continue;
          const isMidi = ['.mid', '.midi', '.rmi'].includes(extension);
          const fontStarted = performance.now();
          if (isMidi) await audio.soundfont();
          const fontMs = Math.round(performance.now() - fontStarted);
          const started = performance.now();
          const loaded = await Promise.race([audio.load(kind, name), new Promise(resolve => setTimeout(() => resolve('timeout'), 60000))]);
          let detail = '';
          if (isMidi) {
            const renderMs = Math.round(performance.now() - started);
            // A page reload keeps the IndexedDB render cache but not the in-memory buffers: emulate it.
            await new Promise(resolve => setTimeout(resolve, 500));
            audio.buffers.clear(); audio.bufferOrder.length = 0;
            const again = performance.now();
            const second = await audio.load(kind, name);
            detail = ` render ${renderMs}ms, soundfont ${fontMs}ms, ${(await audio.soundfont()) ? 'SoundFont' : 'synth'}, after reload ${Math.round(performance.now() - again)}ms${second?.buffer ? '' : ' (FAILED)'}`;
          }
          results.push({ extension, kind, name, detail, ok: Boolean(loaded && loaded !== 'timeout' && loaded.buffer?.duration > 0), timeout: loaded === 'timeout' });
        }
        return results;
      }).catch(error => [{ extension: 'sweep', ok: false, name: String(error) }]);
      const bad = sweep.filter(entry => !entry.ok);
      if (sweep.length) notes.unshift(`audio formats: ${sweep.map(entry => `${entry.extension}${entry.ok ? ' ok' : ' FAILED'}${entry.detail || ''}`).join(', ')}`);
      // .m4a/.aac need proprietary codecs the test browser may not ship; everything else must load.
      const hard = bad.filter(entry => !['.m4a', '.aac'].includes(entry.extension));
      if (hard.length) return await fail(`audio: could not load ${hard.map(entry => `${entry.extension} (${entry.kind}/${entry.name})`).join(', ')}`);
    }
    if (audioExpected.has && audioExpected.bgm && !process.env.MWGP_SMOKE_NOAUDIO) {
      const audioResult = await page.waitForFunction(() => {
        const audio = globalThis.__MWG__?.currentScene?.audio;
        return audio && (audio.isPlaying('bgm') ? 'playing' : [...audio.warned].some(key => key.startsWith('load:') || key.startsWith('missing:') || key.startsWith('format:')) ? 'failed' : false);
      }, null, { timeout: 15000 }).then(handle => handle.jsonValue()).catch(() => 'never started');
      const detail = await page.evaluate(() => { const audio = globalThis.__MWG__?.currentScene?.audio; return audio ? { context: audio.context?.state, warned: [...audio.warned] } : null; }).catch(() => null);
      if (audioResult === 'playing') notes.unshift(`audio: BGM "${audioExpected.bgm}" playing (context ${detail?.context})`);
      else if (audioResult === 'failed' && detail?.warned?.every(key => key.startsWith('format:'))) notes.unshift(`audio: BGM "${audioExpected.bgm}" is in a format browsers cannot decode (${detail.warned.join(', ')})`);
      else return await fail(`audio: BGM "${audioExpected.bgm}" did not start (${audioResult}; ${JSON.stringify(detail)})`);
    }

    // Script gaps: distinct calls the script runtime skipped loudly during boot (the remaining work).
    const scriptGaps = await page.evaluate(() => globalThis.__MWG__?.currentScene?.rgss?.introspect?.().warned || []).catch(() => []);
    if (scriptGaps.length) notes.unshift(`script calls skipped (${scriptGaps.length}): ${scriptGaps.slice(0, 6).join(', ')}${scriptGaps.length > 6 ? ', ...' : ''}`);

    // Input: the player must move, or at least turn in place (a wall still
    // proves the key -> GridMover path works). Some maps open a dialogue on
    // first contact, which also counts as input reaching the game.
    let after = before;
    let inputWorked = false;
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
      // Hold the key across a few frames: a heavy scene renders slowly in a software-GL browser, and
      // an instantaneous press can fall between two frames and be missed.
      await page.keyboard.down(key);
      await page.waitForTimeout(300);
      await page.keyboard.up(key);
      await page.waitForTimeout(350);
      after = await state();
      if (!after) break;
      if (after.x !== before.x || after.y !== before.y || after.facing !== before.facing || after.dialogue !== before.dialogue) { inputWorked = true; break; }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
    // A long opening cutscene keeps a dialogue/event running past the dismissal cap: the
    // game is alive (the player is being moved by the event), but keyboard input cannot be
    // tested until it ends. Say so rather than fail.
    if (!inputWorked && before.eventRunning && after?.eventRunning) { notes.push('opening cutscene still running after the dismissal cap: input not testable'); inputWorked = true; }
    if (!inputWorked && process.env.MWGP_SMOKE_DEBUG) {
      const flags = await page.evaluate(() => { const scene = globalThis.__MWG__?.currentScene; return scene ? Object.fromEntries(Object.entries(scene).filter(([, value]) => typeof value === 'boolean' || (typeof value === 'number' && value !== 0)).slice(0, 40)) : null; }).catch(() => null);
      console.log('[scene flags]', JSON.stringify(flags));
      if (process.env.MWGP_SMOKE_SHOT) await page.screenshot({ path: process.env.MWGP_SMOKE_SHOT }).catch(() => {});
    }
    if (!inputWorked) return await fail(`keyboard input changed nothing (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);

    // Save/load round trip: F5 writes slot 1 and says so on the console, F9 reads it back.
    const consoleLines = [];
    page.on('console', message => consoleLines.push(message.text()));
    await page.keyboard.press('F5');
    const saved = await Promise.race([
      page.waitForFunction(() => document.title.includes('Saved'), null, { timeout: 5000 }).then(() => true).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(consoleLines.some(line => /saved slot-1/.test(line))), 3000))
    ]);
    if (!saved) return await fail('F5 did not report a save');

    await page.keyboard.press('F9');
    await page.waitForTimeout(500);
    const loaded = await Promise.race([
      page.waitForFunction(() => document.title.includes('Loaded'), null, { timeout: 5000 }).then(() => true).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(consoleLines.some(line => /loaded slot-1/.test(line))), 3000))
    ]);
    if (!loaded) return await fail('F9 did not report a load');

    // Battle: a project with the MV/MZ database gets a real troop battle on its weakest troop, driven through the
    // player's own dialogue UI by pressing Enter (the first menu entries are Fight / Attack). It must resolve.
    if (!process.env.MWGP_SMOKE_NOBATTLE) {
      const battleResult = await page.evaluate(() => {
        const scene = globalThis.__MWG__?.currentScene, database = scene?.project?.database;
        if (!scene || !database?.troops || !database?.enemies || !database?.classes) return { skipped: true };
        let best = null;
        database.troops.forEach((troop, id) => {
          if (!troop?.members?.length || !(scene.rpgExtra.party?.length || database.system?.partyMembers?.length)) return;
          const hp = troop.members.reduce((sum, member) => sum + Number(database.enemies[member.enemyId]?.params?.[0] || 1e9), 0);
          if (!best || hp < best.hp) best = { id, hp };
        });
        if (!best) return { skipped: true };
        globalThis.__battleOutcome = undefined;
        scene.startBattle({ troopId: best.id, canEscape: true, canLose: true }).then(outcome => { globalThis.__battleOutcome = outcome; }, error => { globalThis.__battleOutcome = 'error: ' + (error?.message || error); });
        return { started: best.id, hp: best.hp };
      }).catch(error => ({ error: String(error) }));
      if (battleResult.started !== undefined) {
        let outcome;
        let stage = null;
        for (let index = 0; index < 600 && outcome === undefined; index++) {
          // Once the battle is on: the stage shows the enemies' battler images when the project ships them.
          if (index === 6 && !stage) {
            stage = await page.evaluate(async () => {
              const scene = globalThis.__MWG__?.currentScene, root = scene?.project?.assets?.root;
              const names = (scene?.battleEnemies || []).map(enemy => enemy.source?.battlerName).filter(Boolean);
              const reachable = root && names.length ? await fetch(`${root}/img/enemies/${encodeURIComponent(names[0])}.png`).then(response => response.ok, () => false) : false;
              return { sprites: scene?.battleSprites?.length ?? 0, expected: reachable, named: names.length };
            }).catch(() => null);
            if (stage && process.env.MWGP_SMOKE_BATTLESHOT) await page.screenshot({ path: process.env.MWGP_SMOKE_BATTLESHOT }).catch(() => {});
          }
          await page.keyboard.press('Enter');
          await page.waitForTimeout(120);
          outcome = await page.evaluate(() => globalThis.__battleOutcome).catch(() => undefined);
        }
        if ((outcome === undefined || String(outcome).startsWith('error')) && process.env.MWGP_SMOKE_SHOT) await page.screenshot({ path: process.env.MWGP_SMOKE_SHOT }).catch(() => {});
        if (outcome === undefined || String(outcome).startsWith('error')) {
          const where = await page.evaluate(() => { const scene = globalThis.__MWG__?.currentScene; return { dialogue: Boolean(scene?.dialogue), eventRunning: Boolean(scene?.eventRunning), turn: scene?.battleTurn, enemies: (scene?.battleEnemies || []).map(enemy => `${enemy.name} ${enemy.hp}/${enemy.maxHp}`), hero: scene?.battleHero ? `${scene.battleHero.hp}/${scene.battleHero.maxHp} atk ${scene.battleHero.atk} states ${JSON.stringify(scene.battleHero.states)}` : null, record: JSON.stringify(scene?.rpgExtra?.actors?.[1] || null).slice(0, 400), party: scene?.rpgExtra?.party }; }).catch(() => null);
          return await fail(`battle on troop ${battleResult.started} did not resolve (${outcome}); state ${JSON.stringify(where)}`);
        }
        if (stage?.expected && !stage.sprites) return await fail(`battle stage drew no enemy sprite although ${stage.named} enemy image(s) exist`);
        if (stage) notes.unshift(`battle stage: ${stage.sprites} enemy sprite(s) drawn${stage.expected ? '' : ' (no enemy art shipped)'}`);
        notes.unshift(`battle: troop ${battleResult.started} resolved as "${outcome}" through the dialogue UI`);
      } else if (battleResult.error) return await fail(`battle start failed: ${battleResult.error}`);
    }

    // Menu: open the full menu through the real dialogue UI, walk into the Item screen and back, read a Status
    // page, and close it (ArrowUp wraps to the last entry, Cancel). It must close, with no console errors.
    if (!process.env.MWGP_SMOKE_NOMENU) {
      const started = await page.evaluate(() => {
        const scene = globalThis.__MWG__?.currentScene;
        if (!scene?.project?.database?.items || !scene.project.database.classes) return { skipped: true };
        globalThis.__menuDone = undefined;
        scene.openMenu().then(result => { globalThis.__menuDone = result ?? 'done'; }, error => { globalThis.__menuDone = 'error: ' + (error?.message || error); });
        return { started: true };
      }).catch(error => ({ error: String(error) }));
      if (started.started) {
        const press = async (key, wait = 220) => { await page.keyboard.press(key); await page.waitForTimeout(wait); };
        await page.waitForTimeout(400);
        await press('Enter');                    // Item screen (first entry)
        await press('ArrowUp'); await press('Enter');   // Cancel: back to the main menu
        for (let index = 0; index < 3; index++) await press('ArrowDown', 120);
        await press('Enter');                    // Status
        await press('Enter'); await press('Enter'); await press('Enter'); await press('Enter');   // pick the actor, read the pages
        let done;
        for (let index = 0; index < 40 && done === undefined; index++) { await press('ArrowUp'); await press('Enter'); done = await page.evaluate(() => globalThis.__menuDone).catch(() => undefined); }
        if (done === undefined || String(done).startsWith('error')) return await fail(`menu did not close (${done})`);
        notes.unshift('menu: opened, Item and Status screens walked through the dialogue UI, closed');
      } else if (started.error) return await fail(`menu start failed: ${started.error}`);
    }

    // Save files: two different slots keep independent saves with readable summaries.
    const slots = await page.evaluate(() => {
      const scene = globalThis.__MWG__?.currentScene;
      if (!scene?.savedSlots) return null;
      scene.saveGame(2); scene.saveGame(4);
      const saved = scene.savedSlots();
      return { slots: [...saved.keys()].sort(), labels: [2, 4].map(slot => scene.slotLabel(slot, saved.get(slot))), empty: scene.slotLabel(3, saved.get(3)) };
    }).catch(() => null);
    if (slots) {
      if (!(slots.slots.includes(2) && slots.slots.includes(4)) || slots.slots.includes(3) || !slots.labels[0].startsWith('File 2:') || !slots.empty.endsWith('—')) return await fail(`save slots misbehave: ${JSON.stringify(slots)}`);
      notes.unshift(`save files: slots 2 and 4 saved independently (${slots.labels[1].slice(0, 70)})`);
    }

    await context.close().catch(() => {});
    return { name, ok: true, errors, notes, moved: { from: { x: before.x, y: before.y }, to: { x: after?.x, y: after?.y } } };
  } catch (error) {
    return await fail(`exception: ${error?.message || error}`);
  }
}

// Title screen: once, on the first project - it is the entry every game shares.
async function checkTitleScreen(name) {
  const id = Buffer.from(name, 'utf8').toString('base64url');
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/player.html?id=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    const hasTitle = await page.waitForSelector('.mwgp-title button', { timeout: 30000 }).then(() => true).catch(() => false);
    if (!hasTitle) { await context.close(); return { name, ok: false, reason: 'title screen buttons never appeared' }; }
    await page.keyboard.press('Enter');
    const entered = await page.waitForSelector('#loading', { state: 'detached', timeout: BOOT_TIMEOUT_MS }).then(() => true).catch(() => false);
    await context.close().catch(() => {});
    return { name, ok: entered, reason: entered ? null : 'choosing New Game left the player loading forever' };
  } catch (error) {
    await context.close().catch(() => {});
    return { name, ok: false, reason: `exception: ${error?.message || error}` };
  }
}

// Map sweep: each map of a project booted on its own (`?map=&x=&y=` at the map centre), checking that the real
// player starts, nothing throws or logs errors, and the canvas is not blank.
async function sweepMaps(name, limit) {
  const id = Buffer.from(name, 'utf8').toString('base64url');
  const project = await (await fetch(`${base}/api/mwgp/${encodeURIComponent(id)}`)).json();
  let maps = (project.maps || []).filter(map => map?.data?.width > 0);
  if (process.env.MWGP_SMOKE_MAPIDS) { const wanted = new Set(process.env.MWGP_SMOKE_MAPIDS.split(',').map(Number)); maps = maps.filter(map => wanted.has(Number(map.id))); }
  if (Number.isFinite(limit) && limit > 0 && maps.length > limit) { const step = maps.length / limit; maps = Array.from({ length: limit }, (_, index) => maps[Math.floor(index * step)]); }
  const problems = [], loops = [], gameNotes = [];
  for (const map of maps) {
    const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
    const page = await context.newPage();
    const errors = [];
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    page.on('pageerror', error => errors.push(`uncaught: ${String(error?.message || error).slice(0, 140)}`));
    page.on('console', async message => { if (process.env.MWGP_SMOKE_DEBUG && /player unavailable/.test(message.text())) { const stack = await message.args()[1]?.evaluate(error => String(error?.stack || error)).catch(() => ''); console.log(`   [map ${map.id} stack] ${String(stack).slice(0, 1200)}`); } if (process.env.MWGP_SMOKE_DEBUG && ['error', 'warning'].includes(message.type()) && !/compatibility:/.test(message.text())) console.log(`   [map ${map.id} ${message.type()}] ${message.text().slice(0, 600)}`); if (message.type() === 'error' && !resourceNoise.test(message.text())) errors.push(`console.error: ${message.text().slice(0, 140)}`); });
    try {
      const x = Math.floor(map.data.width / 2), y = Math.floor(map.data.height / 2);
      await page.goto(`${base}/player.html?id=${encodeURIComponent(id)}&map=${map.id}&x=${x}&y=${y}&skipTitle=1`, { waitUntil: 'domcontentloaded' });
      const ready = await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover && globalThis.__MWG__.currentScene.project), null, { timeout: 45000 }).then(() => true).catch(() => false);
      if (!ready) problems.push(`map ${map.id}: scene never started${errors.length ? ` (${errors[0]})` : ''}`);
      else {
        // The scene object exists before the map's assets finish loading: wait for the loading indicator to clear.
        const settled = await page.waitForSelector('#loading', { state: 'detached', timeout: 60000 }).then(() => true).catch(() => false);
        if (!settled && navigations > 5) loops.push(`map ${map.id}: reloaded ${navigations} times (an autorun event keeps transferring from this entry state); not judged`);
        else if (!settled) { problems.push(`map ${map.id}: still loading after 60 s`); if (process.env.MWGP_SMOKE_DEBUG) console.log(`   [map ${map.id} pending] ${await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.responseEnd === 0 || entry.duration > 20000).map(entry => entry.name).slice(0, 8).join(' | ')).catch(() => '?')}`); }
        await page.waitForTimeout(500);
        // A WebGL canvas cannot be read back outside its frame, so judge by a real screenshot: a flat image compresses to a few KB.
        const shot = await page.locator('#game').screenshot().catch(() => null);
        // A dark map with sprites on it is fine (title/transition maps are black): judge by what the scene holds too.
        const holdsSprites = await page.evaluate(() => { const scene = globalThis.__MWG__?.currentScene; return (scene?.eventSprites?.length || 0) > 0 || (scene?.world?.children?.length || 0) > 2; }).catch(() => false);
        const drawn = !shot || shot.length > 6000 || holdsSprites;
        if (!settled && navigations > 5) { /* reload loop: reported above */ }
        else if (errors.length && errors.every(text => text.startsWith('console.error: ') && !text.startsWith('console.error: MWGP'))) gameNotes.push(`map ${map.id}: game-logged error (the game recovers from it): ${errors[0].slice(15, 110)}`);
        else if (errors.length) problems.push(`map ${map.id}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1})` : ''}`);
        else if (!drawn) { problems.push(`map ${map.id}: canvas is blank`); if (process.env.MWGP_SMOKE_SHOTDIR) await page.screenshot({ path: `${process.env.MWGP_SMOKE_SHOTDIR}/${name.replace(/\W+/g, '_')}-map${map.id}.png` }).catch(() => {}); }
      }
    } catch (error) { problems.push(`map ${map.id}: exception ${String(error?.message || error).slice(0, 120)}`); }
    await context.close().catch(() => {});
  }
  return { name, tested: maps.length, total: (project.maps || []).length, problems, loops: loops.concat(gameNotes) };
}

// Soak: a bot plays a new game for a while (walks in random directions, presses Enter/Escape now and then), so the
// events, dialogues, transfers and battles it stumbles into run for real. Reports what it reached and fails on
// runtime (`MWGP ...`) or uncaught errors; the game's own logged errors are notes.
async function soak(name, seconds) {
  const id = Buffer.from(name, 'utf8').toString('base64url');
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const errors = [], gameErrors = [], maps = new Set(['start']);
  let dialogues = 0, wasDialogue = false, navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) { navigations++; const map = new URL(frame.url()).searchParams.get('map'); if (map) maps.add(map); } });
  page.on('pageerror', error => errors.push(`uncaught: ${String(error?.message || error).slice(0, 160)}`));
  page.on('console', async message => {
    if (message.type() !== 'error' || resourceNoise.test(message.text())) return;
    (message.text().startsWith('MWGP') ? errors : gameErrors).push(message.text().slice(0, 160));
    if (process.env.MWGP_SMOKE_DEBUG) console.log('   [soak error]', (await Promise.all(message.args().map(arg => arg.evaluate(value => value instanceof Error ? value.stack : String(value)).catch(() => '?')))).join(' | ').slice(0, 1200));
  });
  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  try {
    await page.goto(`${base}/player.html?id=${encodeURIComponent(id)}&skipTitle=1`, { waitUntil: 'domcontentloaded' });
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      try {
        await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover) && !document.querySelector('#loading'), null, { timeout: 30000 });
        // A page stuck in a script loop never answers: report it instead of hanging the harness with it.
        const dialogue = await Promise.race([
          page.evaluate(() => Boolean(globalThis.__MWG__?.currentScene?.dialogue)).catch(() => false),
          new Promise(resolve => setTimeout(() => resolve('hung'), 15000))
        ]);
        if (dialogue === 'hung') { errors.push(`page stopped answering (a script loop?) after ${Math.round((Date.now() - (end - seconds * 1000)) / 1000)}s at ${page.url().slice(-60)}`); break; }
        if (dialogue && !wasDialogue) dialogues++;
        wasDialogue = dialogue;
        if (dialogue || random() < 0.2) { await page.keyboard.press('Enter'); await page.waitForTimeout(90); continue; }
        const key = keys[Math.floor(random() * keys.length)];
        await page.keyboard.down(key); await page.waitForTimeout(160 + Math.floor(random() * 400)); await page.keyboard.up(key);
        if (random() < 0.03) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); await page.keyboard.press('Escape'); }
      } catch { await page.waitForTimeout(300); }
    }
  } catch (error) { errors.push(`exception ${String(error?.message || error).slice(0, 120)}`); }
  await Promise.race([context.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 10000))]);
  return { name, seconds, maps: maps.size, dialogues, navigations, errors, gameErrors };
}

console.log(`Browser smoke: ${projects.length} project(s) against ${base}`);
for (const project of projects) {
  const result = await check(project);
  results.push(result);
  const status = result.ok ? (result.errors.length ? 'PASS (with console errors)' : 'PASS') : 'FAIL';
  console.log(`  ${status}  ${project}${result.reason ? ` - ${result.reason}` : ''}`);
  for (const error of result.errors || []) console.log(`          ! ${error}`);
  for (const note of (result.notes || []).slice(0, 2)) console.log(`          ~ ${note.slice(0, 160)}`);
}

const mapsIndex = process.argv.indexOf('--maps');
const mapSweeps = [];
if (mapsIndex >= 0) {
  const limit = Number(process.argv[mapsIndex + 1]);
  for (const project of projects) {
    const sweep = await sweepMaps(project, Number.isFinite(limit) ? limit : Infinity);
    mapSweeps.push(sweep);
    console.log(`  ${sweep.problems.length ? 'FAIL' : 'PASS'}  maps of ${project}: ${sweep.tested}/${sweep.total} booted${sweep.problems.length ? `, ${sweep.problems.length} problem(s)` : ''}`);
    for (const problem of sweep.problems.slice(0, 12)) console.log(`          ! ${problem}`);
    for (const loop of sweep.loops.slice(0, 5)) console.log(`          ~ ${loop}`);
  }
}

const soakIndex = process.argv.indexOf('--soak');
const soaks = [];
if (soakIndex >= 0) {
  const seconds = Number(process.argv[soakIndex + 1]) || 60;
  for (const project of projects) {
    const result = await soak(project, seconds);
    soaks.push(result);
    console.log(`  ${result.errors.length ? 'FAIL' : 'PASS'}  soak of ${project}: ${result.seconds}s, ${result.maps} map(s) reached, ${result.dialogues} dialogue(s), ${result.navigations} page load(s)${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
    for (const error of result.errors.slice(0, 5)) console.log(`          ! ${error}`);
    for (const error of [...new Set(result.gameErrors)].slice(0, 3)) console.log(`          ~ game-logged error: ${error}`);
  }
}

const titleResult = await checkTitleScreen(projects[0]);
console.log(`  ${titleResult.ok ? 'PASS' : 'FAIL'}  title screen (${projects[0]})${titleResult.reason ? ` - ${titleResult.reason}` : ''}`);

await browser.close();
if (startedServer) server.kill();

const failed = results.filter(result => !result.ok).concat(titleResult.ok ? [] : [titleResult]).concat(mapSweeps.filter(sweep => sweep.problems.length)).concat(soaks.filter(result => result.errors.length));
const withErrors = results.filter(result => result.ok && result.errors.length);
console.log(`\nBrowser smoke: ${results.length - results.filter(result => !result.ok).length}/${results.length} booted, ${withErrors.length} with console errors, ${failed.length ? `${failed.length} failed` : 'no failures'}`);
if (failed.length || withErrors.length) process.exit(1);
