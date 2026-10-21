// Browser checks for the map features the player implements: random encounters, dash, the gamepad, a click on an
// action event, party followers (and command 216/217), the map name band, and weather particles. They run on a made-up
// project (synthetic-mv-project.mjs), converted into a temporary folder and served by a second server whose MWGP_ROOT is
// that folder, so no local game is needed. Each check reads the player's scene through globalThis.__MWG__.currentScene.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertMv } from './convert-mv.js';
import { writeSyntheticMvProject } from './synthetic-mv-project.mjs';

const PROJECT = 'Synthetic Test Game';
const idOf = name => Buffer.from(name, 'utf8').toString('base64url');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A pad the page reads through navigator.getGamepads; the checks move its buttons.
const FAKE_PAD = `
  window.__pad = { id: 'fake', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => [window.__pad, null, null, null];
`;

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

async function until(read, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) { await sleep(120); value = await read(); }
  return value;
}

// Opens the synthetic project on a map in a fresh context (its own fake pad), past any opening message.
async function openPlayer(browser, base, extra = '') {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  await context.addInitScript(FAKE_PAD);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error)));
  await page.goto(`${base}/player.html?id=${encodeURIComponent(idOf(PROJECT))}&skipTitle=1${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 90000 });
  for (let i = 0; i < 40; i++) {
    const busy = await page.evaluate(() => Boolean(globalThis.__MWG__.currentScene.dialogue));
    if (!busy) break;
    await page.keyboard.press('Enter');
    await sleep(200);
  }
  await page.evaluate(() => { globalThis.__MWG__.currentScene.encounterCount = 999; });
  return { context, page, errors };
}

const sceneState = page => page.evaluate(() => {
  const s = globalThis.__MWG__.currentScene;
  return { x: s.mover.x, y: s.mover.y, speed: s.mover.speed, dialogue: Boolean(s.dialogue), busy: Boolean(s.eventRunning || s.encounterBusy), count: s.encounterCount, mapName: Boolean(s.mapName) };
});

// Screen point of a cell's centre, from the canvas and the world transform.
const cellPoint = (page, x, y) => page.evaluate(([x, y]) => {
  const s = globalThis.__MWG__.currentScene;
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const tile = s.tileMap?.tileWidth || 48;
  const world = s.camera?.world || s.stage;
  const scale = world.scale?.x || 1;
  return {
    x: rect.left + (world.x + (x + 0.5) * tile * scale) * (rect.width / canvas.width),
    y: rect.top + (world.y + (y + 0.5) * tile * scale) * (rect.height / canvas.height),
  };
}, [x, y]);

async function clickCell(page, x, y) {
  const point = await cellPoint(page, x, y);
  await page.mouse.click(point.x, point.y);
}

// Holds a key for a while and reads the mover's speed during the hold.
async function holdAndReadSpeed(page, keys, direction) {
  for (const key of keys) await page.keyboard.down(key);
  await page.keyboard.down(direction);
  await sleep(500);
  const speed = (await sceneState(page)).speed;
  await page.keyboard.up(direction);
  for (const key of keys) await page.keyboard.up(key);
  await sleep(500);
  return speed;
}

export async function checkMapFeatures(browser, { port }) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
  const temp = mkdtempSync(join(tmpdir(), 'mwgp-map-features-'));
  let server = null;
  try {
    // The made-up project, converted into the temporary root that the second server serves.
    const source = writeSyntheticMvProject(join(temp, 'source'));
    await convertMv(source, join(temp, 'root', PROJECT), []);
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, MWGP_ROOT: join(temp, 'root'), RPGM_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!(await waitForServer(`${base}/api/games`))) throw new Error(`the map feature server did not come up on ${base}`);

    // 1. Random encounters: a step spends the count and a battle opens; with command 136 off nothing is spent.
    {
      const { context, page, errors } = await openPlayer(browser, base);
      const start = await sceneState(page);
      await page.evaluate(() => { globalThis.__MWG__.currentScene.encounterCount = 1; });
      await clickCell(page, start.x + 1, start.y);
      const after = await until(() => sceneState(page), state => state.busy || state.dialogue);
      check('encounter starts a battle after the count is spent', after.busy || after.dialogue, `battle running ${after.busy}, dialogue open ${after.dialogue}`);
      await context.close();
      const off = await openPlayer(browser, base);
      await off.page.evaluate(() => {
        const s = globalThis.__MWG__.currentScene;
        s.setSystemFlag({ key: 'encounterAccess', value: false });
        s.encounterCount = 5;
      });
      const before = await sceneState(off.page);
      await clickCell(off.page, before.x + 1, before.y);
      await sleep(1500);
      const offAfter = await sceneState(off.page);
      check('command 136 off: a step does not spend the count, no battle', offAfter.count === 5 && !offAfter.busy && !offAfter.dialogue, `count ${offAfter.count}`);
      check('no page errors during encounters', errors.length === 0 && off.errors.length === 0, [...errors, ...off.errors].slice(0, 2).join(' | '));
      await off.context.close();
    }

    // 2. Dash: Shift doubles the walking speed; a map that disables dashing ignores Shift.
    {
      const { context, page, errors } = await openPlayer(browser, base);
      const plain = await holdAndReadSpeed(page, [], 'ArrowRight');
      const dashed = await holdAndReadSpeed(page, ['ShiftLeft'], 'ArrowLeft');
      check('Shift doubles the walking speed', plain === 6 && dashed === 12, `speed plain ${plain}, with Shift ${dashed}`);
      await context.close();
      const corridor = await openPlayer(browser, base, '&map=2');
      const blocked = await holdAndReadSpeed(corridor.page, ['ShiftLeft'], 'ArrowRight');
      check('a map with dashing disabled ignores Shift', blocked === 6, `speed with Shift ${blocked}`);
      check('no page errors during dash', errors.length === 0 && corridor.errors.length === 0, [...errors, ...corridor.errors].slice(0, 2).join(' | '));
      await corridor.context.close();
    }

    // 3. Gamepad: the d-pad's right button walks the player one way.
    {
      const { context, page, errors } = await openPlayer(browser, base);
      const before = await sceneState(page);
      await page.evaluate(() => { window.__pad.buttons[15].pressed = true; });
      await sleep(600);
      await page.evaluate(() => { window.__pad.buttons[15].pressed = false; });
      await sleep(400);
      const after = await sceneState(page);
      check('gamepad d-pad right walks the player', after.x !== before.x, `(${before.x},${before.y}) -> (${after.x},${after.y})`);
      check('no page errors with a gamepad', errors.length === 0, errors.slice(0, 2).join(' | '));
      await context.close();
    }

    // 4. A click on an action event's cell walks next to it and runs its page (a line of text opens).
    {
      const { context, page, errors } = await openPlayer(browser, base);
      await clickCell(page, 4, 2);
      const state = await until(() => sceneState(page), current => current.dialogue);
      check('click on an action event runs it', state.dialogue, `at (${state.x},${state.y})`);
      check('no page errors on a click', errors.length === 0, errors.slice(0, 2).join(' | '));
      await context.close();
    }

    // 5. Followers: four steps down a free column leave the followers on the cells the leader left; 217 gathers them.
    {
      const { context, page, errors } = await openPlayer(browser, base);
      const start = await sceneState(page);
      const followers = await page.evaluate(() => globalThis.__MWG__.currentScene.followers.length);
      check('the party has two followers behind the leader', followers === 2, `followers ${followers}`);
      await clickCell(page, start.x, start.y + 4);
      await until(() => sceneState(page), state => state.y === start.y + 4 && !state.dialogue);
      await sleep(400);
      const cells = await page.evaluate(() => {
        const s = globalThis.__MWG__.currentScene;
        return { leader: [s.mover.x, s.mover.y], followers: s.followers.map(f => [f.mover.x, f.mover.y]) };
      });
      const expected = [[start.x, start.y + 3], [start.x, start.y + 2]];
      check('followers stand on the cells the leader left', JSON.stringify(cells.followers) === JSON.stringify(expected), `followers ${JSON.stringify(cells.followers)} expected ${JSON.stringify(expected)}`);
      await page.evaluate(() => { globalThis.__gathered = false; globalThis.__MWG__.currentScene.gatherFollowers().then(() => { globalThis.__gathered = true; }); });
      const gathered = await until(() => page.evaluate(() => globalThis.__gathered === true), value => value, 9000);
      const onLeader = await page.evaluate(() => {
        const s = globalThis.__MWG__.currentScene;
        return s.followers.every(f => f.mover.x === s.mover.x && f.mover.y === s.mover.y);
      });
      check('command 217 gathers the followers onto the leader', gathered && onLeader, `resolved ${gathered}, on leader ${onLeader}`);
      await page.evaluate(() => globalThis.__MWG__.currentScene.setSystemFlag({ key: 'followers', value: false }));
      const hidden = await page.evaluate(() => globalThis.__MWG__.currentScene.followersShown());
      check('command 216 hides the followers', hidden === false, `followersShown ${hidden}`);
      check('no page errors with followers', errors.length === 0, errors.slice(0, 2).join(' | '));
      await context.close();
    }

    // 6. The map name band: shown after a new game, absent after a plain load.
    {
      const fresh = await openPlayer(browser, base, '&newGame=1');
      const shown = await sceneState(fresh.page);
      const gone = await until(() => sceneState(fresh.page), state => !state.mapName, 6000);
      check('a new game shows the map name band, then clears it', shown.mapName && !gone.mapName, `shown ${shown.mapName}, later ${gone.mapName}`);
      await fresh.context.close();
      const loaded = await openPlayer(browser, base);
      const plain = await sceneState(loaded.page);
      check('a plain load shows no map name band', !plain.mapName, `band ${plain.mapName}`);
      await loaded.context.close();
    }

    // 7. Weather: power 5 gives 50 falling particles, and none clears them.
    {
      const { context, page, errors } = await openPlayer(browser, base);
      await page.evaluate(() => globalThis.__MWG__.currentScene.setWeather({ type: 'rain', power: 5 }));
      const sample = () => page.evaluate(() => {
        const layer = globalThis.__MWG__.currentScene.weatherLayer;
        return { count: layer.particles.length, ys: layer.particles.slice(0, 3).map(p => Math.round(p.sprite.y)) };
      });
      const first = await sample();
      await sleep(600);
      const second = await sample();
      await page.evaluate(() => globalThis.__MWG__.currentScene.setWeather({ type: 'none', power: 0 }));
      const cleared = await page.evaluate(() => globalThis.__MWG__.currentScene.weatherLayer.particles.length);
      check('rain gives 50 particles that fall, and none clears them', first.count === 50 && JSON.stringify(first.ys) !== JSON.stringify(second.ys) && cleared === 0, `count ${first.count}, moved ${JSON.stringify(first.ys) !== JSON.stringify(second.ys)}, cleared ${cleared}`);
      check('no page errors with weather', errors.length === 0, errors.slice(0, 2).join(' | '));
      await context.close();
    }
  } catch (error) {
    check('map feature checks ran', false, String(error?.message || error).slice(0, 300));
  } finally {
    if (server) server.kill();
    rmSync(temp, { recursive: true, force: true });
  }
  return { ok: results.every(result => result.ok), results };
}
