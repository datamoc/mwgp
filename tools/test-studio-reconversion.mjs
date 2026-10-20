// Real converter + HTTP Studio save + repeated reconversions, synthetic files only.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeManifest } from '../src/studio-manifest.js';
import { deflateSync } from 'node:zlib';

function pngPixel(red, green, blue) {
  function chunk(name, data) {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4), footer = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), 'mwgp-reconversion-'));
const source = join(tmp, 'source'), outputs = join(tmp, 'outputs'), output = join(outputs, 'fixture');
await mkdir(join(source, 'data'), { recursive: true });
await mkdir(output, { recursive: true });
const put = (path, data) => writeFile(path, JSON.stringify(data));
const load = path => readFile(path, 'utf8').then(JSON.parse);
const run = (...args) => promisify(execFile)(process.execPath, args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(source, 'index.html'), '<!doctype html>');
for (const category of ['tilesets', 'characters', 'faces', 'pictures', 'system']) await mkdir(join(source, 'img', category), { recursive: true });
for (const kind of ['bgm', 'bgs', 'me', 'se']) await mkdir(join(source, 'audio', kind), { recursive: true });
await mkdir(join(source, 'js/plugins'), { recursive: true });
await writeFile(join(source, 'js/plugins.js'), 'var $plugins = [{"name":"Fixture","status":true,"parameters":{}}];');
const pluginSource = value => `function fixtureValue() { return ${value}; }`;
await writeFile(join(source, 'js/plugins/Fixture.js'), pluginSource(3));
const red = pngPixel(255, 0, 0), green = pngPixel(0, 255, 0), blue = pngPixel(0, 0, 255), magenta = pngPixel(255, 0, 255);
await writeFile(join(source, 'img/pictures/Marker.png'), red);
await put(join(source, 'data', 'System.json'), { gameTitle: 'Source', startMapId: 1, startX: 0, startY: 0, partyMembers: [1] });
await put(join(source, 'data', 'MapInfos.json'), [null, { id: 1, name: 'Room' }]);
await put(join(source, 'data', 'Actors.json'), [null, { id: 1, name: 'Hero', characterName: '', characterIndex: 0 }]);
await put(join(source, 'data', 'Tilesets.json'), [null, { id: 1, tilesetNames: [], flags: [] }]);
const map = { width: 2, height: 2, tilesetId: 1, data: Array(24).fill(0), events: [null,
  { id: 1, name: 'Sign', x: 0, y: 0, pages: [{ trigger: 0, image: {}, conditions: {}, list: [
    { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
    { code: 401, indent: 0, parameters: ['Hello'] },
    { code: 355, indent: 0, parameters: ['$gameVariables.setValue(9, fixtureValue());'] },
    { code: 0, indent: 0, parameters: [] }
  ] }] },
  { id: 2, name: 'Delete me', x: 1, y: 1, pages: [] }
] };
await put(join(source, 'data', 'Map001.json'), map);
const convert = () => run('tools/convert-mv.js', source, output, '--copy-assets');
await convert();
const initial = await load(join(output, 'mwgp.json'));
const cliDir = join(tmp, 'cli-studio');
await run('tools/mwgp-studio.mjs', 'lift', join(output, 'mwgp.json'), cliDir);
await run('tools/validate-mwgp.js', join(output, 'mwgp.json'));

let errors = '';
// Reserve a free port for the short-lived isolated test server.
const { createServer } = await import('node:net');
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['src/server.js'], { cwd: root,
  env: { ...process.env, MWGP_ROOT: outputs, RPGM_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', data => { errors += data; });
const url = `http://127.0.0.1:${port}`;
const id = Buffer.from('fixture').toString('base64url');
async function request(action, manifest) {
  const response = await fetch(`${url}/api/studio/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, manifest }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const assetUrl = (path, version = 'edited') => `${url}/api/studio/assets/${id}?${new URLSearchParams({ path, version })}`;
async function saveResource(path, bytes) {
  const response = await fetch(assetUrl(path), { method: 'POST', body: bytes });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const resourceBytes = async (path, version) => {
  const response = await fetch(assetUrl(path, version));
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
};
try {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', () => resolve());
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Server exited ${code}: ${errors}`)));
  });
  const edited = structuredClone(initial);
  edited.display.title = 'Editor title';
  edited.maps[0].mwgEvents[0].pages[0].commands[0].say = 'Editor dialogue';
  edited.maps[0].mwgEvents.splice(1, 1);
  edited.database.actors[1].name = 'Editor hero';
  edited.player.x = 1;
  edited.maps[0].data.data[0] = 2816;
  await request('save', edited);
  const saved = await load(join(output, 'mwgp.json'));
  assert.deepEqual(saved, edited, 'save publishes exactly the edited runtime manifest');
  const status = await (await fetch(`${url}/api/studio/${id}`)).json();
  assert.ok(status.protectedPaths.includes('/display/title'), 'saved edit status survives a new load');
  assert.deepEqual(status.manifest, saved);
  // Player version is a project property the Studio edits in the folder: it is
  // published into mwgp.json, and an invalid version is refused by the save.
  const versioned = structuredClone(saved);
  versioned.playerVersion = '2.3.4';
  await request('save', versioned);
  assert.equal((await load(join(output, 'mwgp.json'))).playerVersion, '2.3.4', 'folder project keeps its player version');
  const badVersion = await fetch(`${url}/api/studio/save`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, manifest: { ...versioned, playerVersion: 'deux' } }) });
  assert.equal(badVersion.status, 500, 'invalid player version is rejected like any invalid manifest');
  assert.equal((await load(join(output, 'mwgp.json'))).playerVersion, '2.3.4', 'rejected save leaves the folder untouched');
  await request('save', saved);
  await saveResource('img/pictures/Marker.png', green);
  await saveResource('plugins/Fixture.js', pluginSource(9));
  assert.deepEqual(await readFile(join(output, 'assets/img/pictures/Marker.png')), green, 'edited image is materialized for static exports');
  assert.deepEqual(await readFile(join(source, 'img/pictures/Marker.png')), red, 'RPG Maker source is untouched');
  const invalidScript = await fetch(assetUrl('plugins/Fixture.js'), { method: 'POST', body: 'function broken (' });
  assert.equal(invalidScript.status, 400);
  assert.equal((await resourceBytes('plugins/Fixture.js', 'edited')).toString(), pluginSource(9));
  for (const headers of [{ origin: 'https://elsewhere.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await fetch(assetUrl('plugins/Fixture.js'), { method: 'POST', headers, body: pluginSource(-1) });
    assert.equal(response.status, 403, 'another website cannot replace local game resources');
  }
  for (const path of ['../mwgp.json', 'img/../../mwgp.json', 'C:/outside', 'img\\pictures\\Marker.png']) {
    const response = await fetch(assetUrl(path), { method: 'POST', body: 'must not write' });
    assert.equal(response.status, 400);
  }

  // Source changes collide with title and dialogue; untouched map metadata
  // must continue to update, including on the second and third conversion.
  for (const revision of [1, 2, 3]) {
    await put(join(source, 'data', 'System.json'), { gameTitle: revision === 2 ? 'Editor title' : `Source ${revision}`,
      startMapId: 1, startX: 0, startY: 0, partyMembers: [1] });
    map.displayName = `Room ${revision}`;
    map.events[1].pages[0].list[1].parameters[0] = `Source dialogue ${revision}`;
    await put(join(source, 'data', 'Map001.json'), map);
    const freshPixel = revision === 2 ? green : blue;
    await writeFile(join(source, 'img/pictures/Marker.png'), freshPixel);
    await writeFile(join(source, 'js/plugins/Fixture.js'), pluginSource(revision === 2 ? 9 : revision + 20));
    await convert();
    const playable = await load(join(output, 'mwgp.json'));
    assert.equal(playable.display.title, 'Editor title', 'known edit stays protected even after source temporarily matches it');
    assert.equal(playable.maps[0].mwgEvents[0].pages[0].commands[0].say, 'Editor dialogue');
    assert.equal(playable.maps[0].mwgEvents.length, 1, 'editor deletion is not resurrected');
    assert.equal(playable.maps[0].data.displayName, `Room ${revision}`, 'untouched source field updates every time');
    assert.equal(playable.database.actors[1].name, 'Editor hero');
    assert.equal(playable.player.x, 1);
    assert.equal(playable.maps[0].data.data[0], 2816);
    await run('tools/validate-mwgp.js', join(output, 'mwgp.json'));
    const comparison = await request('compare', playable);
    assert.equal(comparison.fresh.display.title, revision === 2 ? 'Editor title' : `Source ${revision}`);
    assert.ok(comparison.conflicts.some(conflict => conflict.path.endsWith('/pages')));
    assert.ok(comparison.protectedPaths.includes('/display/title'));
    assert.deepEqual(await resourceBytes('img/pictures/Marker.png', 'base'), red);
    assert.deepEqual(await resourceBytes('img/pictures/Marker.png', 'edited'), green);
    assert.deepEqual(await resourceBytes('img/pictures/Marker.png', 'fresh'), freshPixel);
    assert.equal((await resourceBytes('plugins/Fixture.js', 'edited')).toString(), pluginSource(9));
    assert.equal((await resourceBytes('plugins/Fixture.js', 'fresh')).toString(), pluginSource(revision === 2 ? 9 : revision + 20));
  }
  await unlink(join(source, 'img/pictures/Marker.png'));
  await convert();
  assert.equal((await fetch(assetUrl('img/pictures/Marker.png', 'fresh'))).status, 404, 'a removed source resource is reported absent');
  assert.deepEqual(await resourceBytes('img/pictures/Marker.png', 'edited'), green);
  await writeFile(join(source, 'img/pictures/Marker.png'), red);
  await convert();
  // This directory predates all web edits and reconversions. Publishing its
  // one changed field must retain current source fields and web edits.
  const cliActors = await load(join(cliDir, 'database/actors.json'));
  cliActors[1].profile = 'CLI profile';
  await put(join(cliDir, 'database/actors.json'), cliActors);
  await run('tools/mwgp-studio.mjs', 'publish', cliDir, join(output, 'mwgp.json'));
  let combined = await load(join(output, 'mwgp.json'));
  assert.equal(combined.database.actors[1].profile, 'CLI profile');
  assert.equal(combined.database.actors[1].name, 'Editor hero');
  assert.equal(combined.display.title, 'Editor title');
  assert.equal(combined.maps[0].data.displayName, 'Room 3');
  assert.equal(combined.maps[0].mwgEvents.length, 1);
  await convert();
  combined = await load(join(output, 'mwgp.json'));
  assert.equal(combined.database.actors[1].profile, 'CLI profile', 'CLI publication is protected by the actual converter');
  assert.equal(combined.maps[0].mwgEvents[0].pages[0].commands[0].say, 'Editor dialogue');
  await assert.rejects(run('tools/build-web.js', source, output), /Studio edits/);
  if (process.env.MWGP_STUDIO_BROWSER === '1') {
    let playwright;
    try { playwright = await import('playwright'); }
    catch { playwright = await import(pathToFileURL(join(process.env.APPDATA, 'npm/node_modules/playwright/index.mjs')).href); }
    const cache = join(process.env.LOCALAPPDATA || tmpdir(), 'ms-playwright');
    const builds = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
    const executablePath = process.env.MWGP_CHROMIUM || builds.map(name => join(cache, name, 'chrome-win/chrome.exe')).find(existsSync);
    const browser = await playwright.chromium.launch({ executablePath, headless: true });
    try {
      const pristineDir = join(outputs, 'pristine');
      await mkdir(pristineDir);
      await put(join(pristineDir, 'mwgp.json'), initial);
      await cp(join(output, 'assets'), join(pristineDir, 'assets'), { recursive: true });
      const pristine = await browser.newPage();
      await pristine.goto(`${url}/studio.html?id=${Buffer.from('pristine').toString('base64url')}`);
      await pristine.locator('#project-title').filter({ hasText: 'Source' }).waitFor();
      await pristine.locator('#map-canvas').click({ position: { x: 48, y: 48 } });
      const noOpSave = pristine.waitForResponse(response => response.url().endsWith('/api/studio/save'));
      await pristine.locator('#btn-save').click();
      assert.deepEqual((await (await noOpSave).json()).protectedPaths, [], 'inspection alone must not create protected edits');
      assert.deepEqual(await load(join(pristineDir, 'mwgp.json')), initial, 'inspection does not normalize fields into the manifest');
      await pristine.close();
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`${url}/studio.html?id=${id}`);
      await page.locator('#project-title').filter({ hasText: 'Editor title' }).waitFor();
      await page.locator('#btn-assets').click();
      await page.locator('#asset-select').selectOption('plugins');
      await page.locator('#asset-select').selectOption('plugins/Fixture.js');
      await page.getByRole('textbox', { name: 'Ressource éditée', exact: true }).fill(pluginSource(42));
      const pluginSave = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/studio/assets/'));
      await page.locator('#asset-save-text').click();
      assert.equal((await pluginSave).status(), 200);
      await page.locator('#asset-up').click();
      await page.locator('#asset-select').selectOption('img');
      await page.locator('#asset-select').selectOption('img/pictures');
      await page.locator('#asset-select').selectOption('img/pictures/Marker.png');
      const imageSave = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/studio/assets/'));
      await page.locator('#asset-replacement').setInputFiles({ name: 'Marker.png', mimeType: 'image/png', buffer: magenta });
      assert.equal((await imageSave).status(), 200);
      await page.locator('#asset-status').filter({ hasText: 'Édition protégée' }).waitFor();
      await page.screenshot({ path: join(tmp, 'studio-resources.png'), fullPage: true });
      await page.locator('#asset-close').click();
      await page.locator('#btn-manifest').click();
      const full = JSON.parse(await page.locator('#manifest-json').inputValue());
      full.display.title = 'Browser title';
      const extraCommands = [{ picture: { id: 1, name: 'Marker', origin: 0, x: 40, y: 40, scaleX: 9600, scaleY: 9600, opacity: 255 } },
        initial.maps[0].mwgEvents[0].pages[0].commands.find(command => command.script)];
      full.maps[0].mwgEvents[0].pages[0].commands = [
        { say: 'Browser dialogue', portrait: { name: 'Face', index: 0 } },
        { setSwitch: 'self:1:1:A', value: true }, { wait: 12 }, ...extraCommands
      ];
      await page.locator('#manifest-json').fill(JSON.stringify(full));
      await page.locator('#btn-apply-manifest').click();
      await page.locator('#map-canvas').click({ position: { x: 16, y: 16 } });
      await page.locator('#cmd-list [data-type="say"] textarea').fill('Browser edited dialogue');
      await page.locator('#cmd-list .sw-val').selectOption('false');
      await page.locator('#cmd-list [data-idx="2"] .cmd-json').fill('{"wait":0.01}');
      await page.locator('#btn-apply-event').click();
      const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/studio/save'));
      await page.locator('#btn-save').click();
      assert.equal((await saveResponse).status(), 200);
      const fromBrowser = await load(join(output, 'mwgp.json'));
      assert.equal(fromBrowser.display.title, 'Browser title');
      assert.deepEqual(fromBrowser.maps[0].mwgEvents[0].pages[0].commands, [
        { say: 'Browser edited dialogue', portrait: { name: 'Face', index: 0 } },
        { setSwitch: 'self:1:1:A', value: false }, { wait: 0.01 }, ...extraCommands
      ]);
      await page.locator('#btn-reconvert').click();
      await page.locator('#reconvert-report').filter({ hasText: 'protectedPaths' }).waitFor();
      await page.reload();
      await page.locator('#project-title').filter({ hasText: 'Browser title' }).waitFor();
      await page.locator('#mod-badge').filter({ hasText: 'modification' }).waitFor();
      await page.locator('#map-canvas').click({ position: { x: 16, y: 16 } });
      assert.equal(await page.locator('#evt-mod-badge').textContent(), 'Modifié (protégé)');
      assert.deepEqual(pageErrors, []);
      await page.screenshot({ path: join(tmp, 'studio.png'), fullPage: true });
      await convert();
      assert.deepEqual(await readFile(join(output, 'assets/img/pictures/Marker.png')), magenta);
      assert.equal(await readFile(join(output, 'assets/plugins/Fixture.js'), 'utf8'), pluginSource(42));
      await page.goto(`${url}/player.html?id=${id}&skipTitle=1&newGame=1`);
      await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover));
      assert.equal(await page.locator('#title').textContent(), 'Browser title');
      await page.evaluate(() => {
        const scene = globalThis.__MWG__.currentScene;
        const original = scene.presentDialogue.bind(scene);
        scene.presentDialogue = request => { globalThis.studioPresented = request; return original(request); };
        scene.gameState.setSwitch('self:1:1:A', true);
      });
      await page.keyboard.down('ArrowLeft');
      await page.waitForTimeout(150);
      await page.keyboard.up('ArrowLeft');
      await page.waitForFunction(() => globalThis.__MWG__.currentScene.cooldown <= 0);
      await page.keyboard.down('Enter');
      await page.waitForTimeout(150);
      await page.keyboard.up('Enter');
      try { await page.waitForFunction(() => globalThis.studioPresented?.text === 'Browser edited dialogue', null, { timeout: 5000 }); }
      catch (error) {
        await page.screenshot({ path: join(tmp, 'player-failure.png'), fullPage: true });
        const detail = await page.evaluate(() => {
          const scene = globalThis.__MWG__.currentScene;
          return { x: scene.mover.x, y: scene.mover.y, facing: scene.mover.facing, events: scene.project?.maps?.[0]?.mwgEvents,
            dialogue: scene.dialogue, presented: globalThis.studioPresented };
        });
        throw new Error(`${error.message}; ${JSON.stringify(detail)}; fixtures ${tmp}`);
      }
      await page.waitForFunction(() => globalThis.__MWG__.currentScene.windows.top?.pageComplete);
      assert.equal(await page.evaluate(() => globalThis.__MWG__.currentScene.windows.top.pageText), 'Browser edited dialogue');
      await page.screenshot({ path: join(tmp, 'player-dialogue.png'), fullPage: true });
      for (let press = 0; press < 6; press++) {
        if (!await page.evaluate(() => globalThis.__MWG__.currentScene.eventRunning)) break;
        await page.keyboard.down('Enter');
        await page.waitForTimeout(80);
        await page.keyboard.up('Enter');
        await page.waitForTimeout(200);
      }
      await page.waitForFunction(() => !globalThis.__MWG__.currentScene.eventRunning);
      assert.equal(await page.evaluate(() => globalThis.__MWG__.currentScene.gameState.switch('self:1:1:A')), false);
      assert.equal(await page.evaluate(() => globalThis.__MWG__.currentScene.gameState.variable('9')), 42, 'the edited external plugin code executes');
      assert.equal(await page.evaluate(() => globalThis.__MWG__.currentScene.audio.cacheVersion), `${(await load(join(output, 'mwgp.json'))).source.convertedAt}:assets4`);
      const shot = await page.locator('#game').screenshot();
      const pixel = await page.evaluate(async encoded => {
        const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return [...context.getImageData(Math.floor(image.width * 60 / 816), Math.floor(image.height * 60 / 624), 1, 1).data].slice(0, 3);
      }, shot.toString('base64'));
      assert.deepEqual(pixel, [255, 0, 255], 'the replaced image is rendered by the real player');
      await page.screenshot({ path: join(tmp, 'player-resources.png'), fullPage: true });
      assert.deepEqual(pageErrors, []);
      console.log('Studio Chromium OK: edit/save/reload/protection, then edited dialogue and self switch executed by the real player.');
    } finally { await browser.close(); }
  }
  const beforeInvalid = await readFile(join(output, 'mwgp.json'), 'utf8');
  const invalid = structuredClone(saved);
  invalid.maps[0].mwgEvents[0].pages[0].commands = [{ madeUpCommand: true }];
  const response = await fetch(`${url}/api/studio/save`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, manifest: invalid }) });
  assert.equal(response.status, 500);
  assert.equal(await readFile(join(output, 'mwgp.json'), 'utf8'), beforeInvalid, 'invalid edit never replaces the playable manifest');

  const base = { maps: [], database: { actors: [null, { id: 1, name: 'A' }, { id: 2, name: 'B' }] } };
  const edit = structuredClone(base), fresh = structuredClone(base);
  edit.database.actors[1] = null;
  fresh.database.actors[2].name = 'B2';
  const result = mergeManifest(base, edit, fresh).manifest;
  assert.equal(result.database.actors[1], null);
  assert.equal(result.database.actors[2].id, 2);
  assert.equal(result.database.actors[2].name, 'B2');
  // CLI merge must protect deletions and table positions just like the web
  // converter path, even when a later source briefly matches an edited value.
  const cliBase = structuredClone(initial);
  cliBase.database.actors.push({ id: 2, name: 'Second' });
  const cliMergeDir = join(tmp, 'cli-merge');
  await put(join(tmp, 'cli-base.json'), cliBase);
  await run('tools/mwgp-studio.mjs', 'lift', join(tmp, 'cli-base.json'), cliMergeDir);
  const cliMap = await load(join(cliMergeDir, 'maps/map-1.json'));
  cliMap.mwgEvents.splice(1, 1);
  await put(join(cliMergeDir, 'maps/map-1.json'), cliMap);
  const cliRows = await load(join(cliMergeDir, 'database/actors.json'));
  cliRows[1] = null;
  await put(join(cliMergeDir, 'database/actors.json'), cliRows);
  const cliIndex = await load(join(cliMergeDir, 'studio.json'));
  cliIndex.display.title = 'CLI title';
  await put(join(cliMergeDir, 'studio.json'), cliIndex);
  for (const title of ['CLI title', 'Later source title']) {
    const fresh = structuredClone(cliBase);
    fresh.display.title = title;
    fresh.database.actors[2].name = title;
    await put(join(tmp, 'cli-fresh.json'), fresh);
    await run('tools/mwgp-studio.mjs', 'merge', cliMergeDir, join(tmp, 'cli-fresh.json'), cliMergeDir);
    await run('tools/mwgp-studio.mjs', 'publish', cliMergeDir, join(tmp, 'cli-play.json'));
    const published = await load(join(tmp, 'cli-play.json'));
    assert.equal(published.display.title, 'CLI title');
    assert.equal(published.maps[0].mwgEvents.length, 1);
    assert.equal(published.database.actors[1], null);
    assert.equal(published.database.actors[2].name, title);
  }
  // A killed conversion leaves its lock (its holder's pid is dead), its staging tree, and possibly
  // no published manifest, inside the output. The next conversion must heal the folder on its own:
  // take over the dead lock, sweep the stale orphan staging, and re-publish protected edits.
  const zombie = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const zombiePid = zombie.pid;
  zombie.kill();
  await new Promise(resolve => zombie.once('exit', resolve));
  await writeFile(join(output, '.mwgp-assets.lock'), String(zombiePid));
  const orphan = join(output, '.mwgp-conversion-dead0000');
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, 'stale.txt'), 'left by the crash');
  const longAgo = new Date(Date.now() - 600000);
  await utimes(orphan, longAgo, longAgo);
  await unlink(join(output, 'mwgp.json'));
  await convert();
  assert.ok(existsSync(join(output, 'mwgp.json')), 'a crashed run does not lock the project out of later conversions');
  assert.ok(!existsSync(join(output, '.mwgp-assets.lock')), "the dead holder's lock is taken over and released");
  assert.ok(!readdirSync(output).includes('.mwgp-conversion-dead0000'), 'stale orphan staging is swept before the new run starts');
  const recovered = await load(join(output, 'mwgp.json'));
  assert.ok(recovered.maps[0].mwgEvents.some(event => String(event.id) === '1'), 'the recovered manifest carries the protected dialogue');
  assert.ok((await load(join(output, '.mwgp-studio.json'))).protectedPaths.includes('/display/title'), 'known edits stay known after crash recovery');
  // A project can also be born from the web Studio: /api/studio/init creates it under the MWGP
  // root, the editor opens it, and its first save is protected like a converted project's.
  const bornResponse = await fetch(`${url}/api/studio/init`, { method: 'POST', body: JSON.stringify({ name: 'Studio Born', title: 'Né du Studio' }) });
  const born = await bornResponse.json();
  assert.equal(bornResponse.status, 201, JSON.stringify(born), 'creating a project answers 201');
  const bornLoad = await (await fetch(`${url}/api/studio/${born.id}`)).json();
  assert.equal(bornLoad.manifest.database.actors[1].name, 'Héros', 'the born project ships a starter actor');
  const bornEdit = structuredClone(bornLoad.manifest);
  bornEdit.display.title = 'Né du Studio!';
  const bornSaved = await (await fetch(`${url}/api/studio/save`, { method: 'POST', body: JSON.stringify({ id: born.id, manifest: bornEdit }) })).json();
  assert.equal(bornSaved.ok, true, JSON.stringify(bornSaved));
  assert.ok(bornSaved.protectedPaths?.includes('/display/title'), 'born edits are protected like converted ones');
  assert.equal((await (await fetch(`${url}/api/mwgp/${born.id}`)).json()).display.title, 'Né du Studio!', 'the player route serves the born project');
  assert.equal((await fetch(`${url}/api/studio/init`, { method: 'POST', body: JSON.stringify({ name: 'Studio Born' }) })).status, 409, 'a taken project name is refused');
  assert.equal((await fetch(`${url}/api/studio/init`, { method: 'POST', body: JSON.stringify({ name: '../échapper' }) })).status, 400, 'an escaping name is refused');
  console.log(`Studio reconversion OK: converter, HTTP save, repeat merge, deletions, comparison, validation, web guard, crash recovery, Studio-born project. Fixtures: ${tmp}`);
} finally {
  server.kill();
}
