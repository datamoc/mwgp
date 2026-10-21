// Real offline Chromium + CLI parity over all five engines and both RGSSAD
// formats. Fixtures and verification output are retained in the OS temp dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, gunzipSync } from 'node:zlib';
import { encodeMarshal } from '@datamoc/mwg/rpg';
import { unzipSync } from 'fflate';
import { exportBrowserConverter } from './export-browser-converter.mjs';
import { exportStandaloneStudio } from './export-standalone-studio.mjs';
import { PLAYER_VERSION } from '../src/standalone-player/player-version.js';
import { decryptPayload } from './rgss-archive.mjs';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'mwgp-browser-converter-'));
const html = join(work, 'converter.html');
await exportBrowserConverter(html);
const require = createRequire(import.meta.url);
let playwright;
for (const path of ['playwright', join(process.env.APPDATA || '', 'npm/node_modules/playwright')]) {
  try { playwright = require(path); break; } catch { /* next supported installation */ }
}
if (!playwright) throw new Error('SKIPPED (loud): Playwright is unavailable; browser converter has NOT been verified.');
// Playwright's default headless target is the separate headless_shell build,
// which a machine may not have downloaded even though a full Chromium is
// installed. Prefer an installed Chromium/Chrome (system or Playwright's own
// full build), like tools/test-browser.mjs does, instead of channel:'chromium'.
function installedChromium() {
  const candidates = [
    join(process.env.ProgramFiles || '', 'Chromium/Application/chrome.exe'),
    join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Chromium/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Chromium/Application/chrome.exe'),
  ];
  const dir = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (dir && existsSync(dir)) {
    const builds = readdirSync(dir).filter(name => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    const rel = ['chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'];
    for (const build of builds) for (const candidate of rel) candidates.push(join(dir, build, candidate));
  }
  return candidates.find(file => file && existsSync(file)) || null;
}
const browser = await playwright.chromium.launch({ headless: true, executablePath: installedChromium() || undefined, args: ['--enable-unsafe-swiftshader', '--use-gl=angle'] });
const O = (name, fields) => ({ class: name, ivars: Object.fromEntries(Object.entries(fields).map(([key, value]) => ['@' + key, value])) });
const command = (code, parameters) => O('RPG::EventCommand', { code, indent: 0, parameters });
async function put(folder, name, data) {
  await mkdir(dirname(join(folder, name)), { recursive: true });
  await writeFile(join(folder, name), data);
}
const json = (folder, name, value) => put(folder, name, JSON.stringify(value));
async function listFiles(folder, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(folder, name));
    else files.push(name);
  }
  return files.sort();
}
function normalManifest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.source.convertedAt;
  // RGSS labels its project from the chosen output directory.
  delete copy.source.projectName;
  return copy;
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function solidPng(width, height, color = [40, 130, 80, 255]) {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(color, y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function mvFixture(folder, mz) {
  const base = mz ? folder : join(folder, 'www');
  await put(base, 'index.html', '<!doctype html><html></html>');
  await put(base, `js/${mz ? 'rmmz' : 'rpg'}_core.js`, '// engine fingerprint');
  const key = '00112233445566778899aabbccddeeff';
  await json(base, 'data/System.json', { gameTitle: mz ? 'MZ browser fixture' : 'MV browser fixture', partyMembers: [], startMapId: 1, startX: 1, startY: 1, encryptionKey: key,
    title1Name: 'Title', title2Name: '', optDrawTitle: true });
  await json(base, 'data/MapInfos.json', [null, { id: 1, name: 'Room' }, { id: 2, name: 'Next room' }]);
  await json(base, 'data/Tilesets.json', [null, { id: 1, name: 'Probe', tilesetNames: ['', '', '', '', '', 'Probe'], flags: [] }]);
  const mapData = [...Array(16).fill(1), ...Array(80).fill(0)];
  await json(base, 'data/Map001.json', { width: 4, height: 4, tilesetId: 1, data: mapData, events: [null, {
    id: 1, name: 'Test', x: 0, y: 0, pages: [{ conditions: {}, trigger: 0, image: { characterName: '$Hero', direction: 2, pattern: 1 }, list: [
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] }, { code: 401, indent: 0, parameters: ['Bonjour éà世界'] },
      { code: 355, indent: 0, parameters: ['Demo.echo()'] },
      { code: mz ? 357 : 356, indent: 0, parameters: mz ? ['Demo', 'echo', 'Echo', { value: 'été' }] : ['echo été'] },
      { code: 0, indent: 0, parameters: [] },
    ] }],
  }] });
  await json(base, 'data/Map002.json', { width: 4, height: 4, tilesetId: 1, data: mapData, events: [] });
  await put(base, 'js/plugins.js', 'var $plugins = ' + JSON.stringify([{ name: 'Demo', status: true, parameters: {} }]) + ';');
  await put(base, 'js/plugins/Demo.js', 'var Demo = { echo: function () { return "été"; } };\nPluginManager.registerCommand("Demo", "echo", Demo.echo);');
  const payload = Buffer.from(png), bytes = Buffer.from(key, 'hex');
  for (let i = 0; i < 16; i++) payload[i] ^= bytes[i];
  await put(base, `img/pictures/été.${mz ? 'png_' : 'rpgmvp'}`, Buffer.concat([Buffer.alloc(16), payload]));
  await put(base, 'audio/bgm/sub/empty.ogg', Buffer.from('OggS probe'));
  await put(base, 'img/pictures/empty.png', Buffer.alloc(0));
  for (const kind of ['tilesets', 'characters']) await put(base, `img/${kind}/probe.png`, png);
  await put(base, 'img/tilesets/Probe.png', solidPng(768, 768));
  await put(base, 'img/characters/$Hero.png', solidPng(144, 192, [180, 70, 35, 255]));
  await put(base, 'img/titles1/Title.png', solidPng(816, 624, [35, 65, 100, 255]));
  const wave = Buffer.alloc(44 + 8000 * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  await put(base, 'audio/bgm/test.wav', wave);
  await mkdir(join(base, 'img/faces'), { recursive: true });
}

// The payload is one or more <script> elements, read back in order (standalone.js).
const PAYLOAD_ELEMENT = /<script (?:data-mwgp-payload|id="mwgp-payload") type="application\/octet-stream">([\s\S]*?)<\/script>/g;
// A page over the payload limit (gate.js) stops before the payload is read and offers to unpack the game. The folder
// picker is not used here (it needs a person), so the unpacking goes to the browser's private storage; a small limit in a
// copy of the page stands in for the 100 MB one. The unpacked copy must start the game, and reopening the page must
// offer it again.
async function checkLargePage(browser, playablePath, playableHtml, engine) {
  const large = join(work, `${engine}-large.html`);
  await writeFile(large, playableHtml.replace(/(<meta name="mwgp-payload-limit" content=")\d+"/, '$11000"'), 'utf8');
  // Served over http: private storage (the fallback without a folder picker) is not available to file:// pages.
  const body = await readFile(large);
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/large.html`;
  const context = await browser.newContext();
  await context.addInitScript(() => { delete window.showDirectoryPicker; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error)));
  try {
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.body?.textContent.includes('This game page is'), null, { timeout: 60000 });
    assert.ok(await page.locator('#gate-panel button', { hasText: 'Unpack this game' }).isVisible(), `${engine}: the large page offers to unpack the game`);
    await page.locator('#gate-panel button', { hasText: 'Unpack this game' }).click();
    await page.waitForFunction(() => document.querySelector('#gate-status')?.textContent.includes('Now select'), null, { timeout: 30000 });
    await page.locator('#gate-status button').click();
    await page.locator('#gate-panel input[type=file]').setInputFiles(playablePath);
    // The unpacked game opens on its title screen, like the playable page: start a new game to reach a map.
    await page.getByRole('button', { name: 'New Game', exact: true }).click({ timeout: 120000 });
    await page.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 180000 });
    assert.equal(errors.length, 0, `${engine}: the unpacked game starts without page errors: ${errors.slice(0, 2).join(' | ')}`);
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.body?.textContent.includes('This game page is'), null, { timeout: 60000 });
    assert.equal(await page.locator('#gate-panel button', { hasText: 'Open the unpacked copy' }).count(), 1, `${engine}: the unpacked copy is offered again`);
    console.log(`PASS ${engine}: large page stops, unpacks to private storage, starts the game, and offers the copy again`);
  } finally {
    await context.close();
    server.close();
  }
}

// The standalone Studio opens a large page (directly, or the folder a large page unpacked) and regenerates it: the
// regenerated page declares its payload size, keeps the limit and the id, and carries the size gate, so it stops like the
// page it came from and starts with ?force=1. The folder is opened through a picker, which the test stands in for with
// the browser's private storage (where the game page unpacked it).
async function checkLargeStudio(browser, { work, studioHtml }) {
  const playable = join(work, 'mv-play.html');
  const playableHtml = await readFile(playable, 'utf8');
  const large = playableHtml.replace(/(<meta name="mwgp-payload-limit" content=")\d+"/, '$11000"');
  const largePath = join(work, 'mv-large-source.html');
  await writeFile(largePath, large, 'utf8');
  const pages = { '/large.html': large, '/studio.html': await readFile(studioHtml, 'utf8') };
  const server = createServer((request, response) => {
    const body = pages[new URL(request.url, 'http://127.0.0.1').pathname];
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => { try { localStorage.setItem('mwgp-lang', 'fr'); } catch { /* no storage */ } });
  await context.addInitScript(() => {
    if (location.pathname === '/studio.html') window.showDirectoryPicker = () => navigator.storage.getDirectory();
    else delete window.showDirectoryPicker;
  });
  const errors = [];
  const regenerate = async (studio, dialogue) => {
    await studio.locator('#map-canvas').click({ position: { x: 16, y: 16 } });
    const sayBox = studio.locator('.cmd-box[data-type="say"] textarea');
    await sayBox.waitFor({ timeout: 30000 });
    await sayBox.fill(dialogue);
    await studio.locator('#btn-apply-event').click();
    await studio.locator('#btn-save').click();
    await studio.waitForFunction(() => document.querySelector('#toast').textContent.includes('sauvegardé'), null, { timeout: 30000 });
    const download = studio.waitForEvent('download');
    await studio.locator('#studio-download-game').click();
    const saved = await download;
    const path = join(work, `regenerated-${Date.now()}.html`);
    await saved.saveAs(path);
    return path;
  };
  // The regenerated page: its declared size is its payload, the limit and id are right, it carries the gate, and it runs
  // its edit. A page still over its limit stops first and starts with ?force=1; a page under it starts directly.
  const assertRegenerated = async (path, dialogue, label, { limit, overLimit }) => {
    const html = await readFile(path, 'utf8');
    const packed = unpackStandalone(html);
    const declared = Number(html.match(/<meta name="mwgp-payload-bytes" content="(\d+)"/)?.[1]);
    const payloadLength = [...html.matchAll(/<script data-mwgp-payload type="application\/octet-stream">\n([\s\S]*?)<\/script>/g)].reduce((sum, match) => sum + match[1].length, 0);
    assert.equal(declared, payloadLength, `${label}: the regenerated page declares its payload size`);
    assert.equal(html.match(/<meta name="mwgp-payload-limit" content="(\d+)"/)?.[1], String(limit), `${label}: the limit is kept`);
    assert.equal(html.match(/<meta name="mwgp-payload-id" content="([^"]+)"/)?.[1], packed.metadata.id, `${label}: the id matches the payload`);
    assert.ok(html.includes('<script id="mwgp-gate">'), `${label}: the regenerated page carries the size gate`);
    const say = JSON.parse(packed.files.get('mwgp.json')).maps[0].mwgEvents[0].pages[0].commands.find(command => typeof command.say === 'string');
    assert.equal(say.say, dialogue, `${label}: the edit is inside`);
    const opened = await context.newPage();
    opened.on('pageerror', error => errors.push(error.message));
    await opened.goto(pathToFileURL(path).href, { waitUntil: 'commit' });
    if (overLimit) {
      await opened.waitForFunction(() => document.body?.textContent.includes('This game page is'), null, { timeout: 60000 });
      await opened.goto(`${pathToFileURL(path).href}?force=1`);
    }
    await opened.getByRole('button', { name: 'New Game', exact: true }).click({ timeout: 90000 });
    await opened.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover), null, { timeout: 90000 });
    assert.deepEqual(errors, [], `${label}: no page errors`);
    await opened.close();
  };
  try {
    // 1. The Studio opens the large page itself.
    const direct = await context.newPage();
    direct.on('pageerror', error => errors.push(error.message));
    await direct.goto(pathToFileURL(studioHtml).href);
    await direct.locator('#studio-open-file').setInputFiles(largePath);
    await direct.waitForFunction(() => document.querySelectorAll('#map-list .item-row').length > 0, null, { timeout: 90000 });
    const directPath = await regenerate(direct, 'Dialogue depuis une grosse page.');
    await assertRegenerated(directPath, 'Dialogue depuis une grosse page.', 'large page', { limit: 1000, overLimit: true });
    console.log('PASS standalone Studio: a large page opens, is edited, and regenerates with the size gate');
    await direct.close();

    // 2. The game page unpacks the game into private storage; the Studio opens that folder and regenerates it.
    const unpacking = await context.newPage();
    await unpacking.goto(`${base}/large.html`, { waitUntil: 'commit' });
    await unpacking.waitForFunction(() => document.body?.textContent.includes('This game page is'), null, { timeout: 60000 });
    await unpacking.locator('#gate-panel button', { hasText: 'Unpack this game' }).click();
    await unpacking.waitForFunction(() => document.querySelector('#gate-status')?.textContent.includes('Now select'), null, { timeout: 30000 });
    await unpacking.locator('#gate-status button').click();
    await unpacking.locator('#gate-panel input[type=file]').setInputFiles(playable);
    await unpacking.waitForFunction(() => Boolean(globalThis.mwgpStandalone), null, { timeout: 180000 });
    await unpacking.close();
    const studio = await context.newPage();
    studio.on('pageerror', error => errors.push(error.message));
    await studio.goto(`${base}/studio.html`);
    await studio.locator('#studio-open-folder').click();
    await studio.waitForFunction(() => document.querySelectorAll('#map-list .item-row').length > 0, null, { timeout: 90000 });
    const folderPath = await regenerate(studio, 'Dialogue depuis un dossier décompressé.');
    await assertRegenerated(folderPath, 'Dialogue depuis un dossier décompressé.', 'unpacked folder', { limit: 104857600, overLimit: false });
    console.log('PASS standalone Studio: an unpacked game folder opens, is edited, and regenerates with the size gate');
    await studio.close();
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
}

function unpackStandalone(html) {
  const payloads = [...html.matchAll(PAYLOAD_ELEMENT)];
  assert.ok(payloads.length, 'standalone contains a compressed payload');
  const gzip = Buffer.concat(payloads.flatMap(match => match[1].trim().split('\n')).map(line => Buffer.from(line, 'base64')));
  assert.deepEqual([...gzip.subarray(0, 3)], [31, 139, 8], 'payload is gzip');
  const raw = gunzipSync(gzip), length = raw.readUInt32LE(0);
  const metadata = JSON.parse(raw.subarray(4, 4 + length));
  let offset = 4 + length;
  const files = new Map();
  for (const entry of metadata.files) { files.set(entry.path, raw.subarray(offset, offset + entry.size)); offset += entry.size; }
  assert.equal(offset, raw.length, 'payload index covers every byte');
  assert.ok(gzip.length < raw.length, 'player and data are compressed');
  return { metadata, files };
}
function fixnum(value) {
  if (value === 0) return [0];
  if (value < 123) return [value + 5];
  const bytes = [];
  while (value > 0) { bytes.push(value & 255); value >>>= 8; }
  return [bytes.length, ...bytes];
}
function scriptsFile() {
  const string = bytes => [34, ...fixnum(bytes.length), ...bytes];
  const ruby = 'module Demo\n  def self.echo\n    42\n  end\nend\n';
  return Buffer.from([4, 8, 91, ...fixnum(1), 91, ...fixnum(3), 105, ...fixnum(1), ...string(Buffer.from('Demo')), ...string(deflateSync(ruby))]);
}
async function rgssFixture(folder, engine) {
  const ext = { xp: 'rxdata', vx: 'rvdata', ace: 'rvdata2' }[engine];
  const marshal = (name, value) => put(folder, `Data/${name}.${ext}`, encodeMarshal(value));
  await put(folder, 'Game.ini', '[Game]\nTitle=Browser fixture\n');
  await marshal('System', O('RPG::System', { game_title: 'RGSS browser fixture', start_map_id: 1, start_x: 0, start_y: 0, party_members: [] }));
  await marshal('MapInfos', new Map([[1, O('RPG::MapInfo', { name: 'Room' })]]));
  await marshal('CommonEvents', []);
  await marshal('Tilesets', [null, O('RPG::Tileset', { id: 1, tileset_name: '', autotile_names: [], tileset_names: [] })]);
  const raw = Buffer.alloc(20 + 2 * 2 * 3 * 2);
  [3, 2, 2, 3, 12].forEach((value, i) => raw.writeInt32LE(value, i * 4));
  await marshal('Map001', O('RPG::Map', { width: 2, height: 2, tileset_id: 1,
    data: O('Table', { raw: [...raw] }), events: new Map([[1, O('RPG::Event', { id: 1, name: 'Test', x: 0, y: 0,
      pages: [O('RPG::Event::Page', { condition: O('RPG::Event::Page::Condition', {}), graphic: O('RPG::Event::Page::Graphic', {}),
        trigger: 0, list: [command(355, ['$game_variables[1] = Demo.echo']), command(0, [])] })] })]]) }));
  await put(folder, `Data/Scripts.${ext}`, scriptsFile());
  await put(folder, 'Graphics/Pictures/test.png', png);
  await put(folder, 'Audio/BGM/sub/test.ogg', 'OggS probe');
}
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; };
async function archiveFixture(source, folder, version) {
  const entries = [];
  for (const name of await listFiles(source)) if (name.startsWith('Data/') || name.startsWith('Graphics/')) {
    entries.push({ name, bytes: await readFile(join(source, name)) });
  }
  const chunks = [Buffer.from([82, 71, 83, 83, 65, 68, 0, version])];
  const advance = key => (Math.imul(key, 7) + 3) >>> 0;
  if (version === 1) {
    let key = 0xdeadcafe;
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'latin1');
      chunks.push(u32(name.length ^ key)); key = advance(key);
      for (let i = 0; i < name.length; i++) { name[i] ^= key & 255; key = advance(key); }
      chunks.push(name, u32(entry.bytes.length ^ key)); key = advance(key);
      const bytes = Buffer.from(entry.bytes); decryptPayload(bytes, key); chunks.push(bytes);
    }
  } else {
    const seed = 17, tableKey = seed * 9 + 3;
    chunks.push(u32(seed));
    let offset = 12 + entries.reduce((sum, entry) => sum + 16 + Buffer.byteLength(entry.name, 'latin1'), 0) + 4;
    const payloads = [];
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'latin1'), key = 0x12345678;
      for (let i = 0; i < name.length; i++) name[i] ^= (tableKey >>> (8 * (i % 4))) & 255;
      chunks.push(u32(offset ^ tableKey), u32(entry.bytes.length ^ tableKey), u32(key ^ tableKey), u32(name.length ^ tableKey), name);
      const bytes = Buffer.from(entry.bytes); decryptPayload(bytes, key); payloads.push(bytes);
      offset += bytes.length;
    }
    chunks.push(u32(tableKey), ...payloads);
  }
  await put(folder, version === 1 ? 'Game.rgssad' : 'Game.rgss3a', Buffer.concat(chunks));
  // Loose graphics override the archive, as in the CLI.
  await put(folder, 'Graphics/Pictures/test.png', Buffer.from('loose override'));
  await put(folder, 'Game.ini', '[Game]\nTitle=Archived fixture\n');
}

try {
  const context = await browser.newContext({ offline: true, acceptDownloads: true });
  // The pages default to English; this run checks the French strings.
  await context.addInitScript(() => { try { localStorage.setItem('mwgp-lang', 'fr'); } catch { /* no storage */ } });
  const page = await context.newPage();
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.goto(pathToFileURL(html).href);
  for (const engine of ['mv', 'mz', 'xp', 'vx', 'ace', 'xp-archive', 'ace-archive']) {
    const source = join(work, engine);
    if (engine === 'mv' || engine === 'mz') await mvFixture(source, engine === 'mz');
    else if (engine.endsWith('-archive')) await archiveFixture(join(work, engine.split('-')[0]), source, engine === 'xp-archive' ? 1 : 3);
    else await rgssFixture(source, engine);
    const output = join(work, 'node', engine);
    const script = engine === 'mv' || engine === 'mz' ? 'convert-mv.js' : 'convert-rgss.js';
    execFileSync(process.execPath, [join(root, 'tools', script), source, output, '--copy-assets'], { stdio: 'pipe' });
    execFileSync(process.execPath, [join(root, 'tools/validate-mwgp.js'), join(output, 'mwgp.json')], { stdio: 'pipe' });
    await page.locator('#source').setInputFiles(source);
    await page.locator('input[value=zip]').check();
    await page.locator('#run').click();
    await page.waitForFunction(() => !document.querySelector('#run').disabled, { timeout: 90000 });
    const status = await page.locator('#status').textContent();
    assert.match(status, /^Conversion terminée/, `${engine}: ${status}\n${await page.locator('#log').textContent()}`);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await downloadPromise;
    const zipPath = join(work, engine + '.zip');
    await download.saveAs(zipPath);
    const zip = unzipSync(await readFile(zipPath));
    const nodeFiles = await listFiles(output);
    assert.deepEqual(Object.keys(zip).filter(name => !name.endsWith('/')).sort(), nodeFiles, `${engine}: file list matches CLI`);
    if (engine === 'mv' || engine === 'mz') assert.ok(zip['assets/img/faces/'], 'empty resource directory survives ZIP');
    for (const name of nodeFiles) {
      const expected = await readFile(join(output, name));
      if (name === 'mwgp.json' || name === '.mwgp-conversion.json') {
        assert.deepEqual(normalManifest(JSON.parse(Buffer.from(zip[name]).toString())), normalManifest(JSON.parse(expected)), `${engine}: ${name} matches CLI`);
      } else if (name.endsWith('.json')) assert.deepEqual(JSON.parse(Buffer.from(zip[name]).toString()), JSON.parse(expected), `${engine}: ${name}`);
      else assert.deepEqual(Buffer.from(zip[name]), expected, `${engine}: ${name}`);
    }
    const manifest = JSON.parse(Buffer.from(zip['mwgp.json']).toString());
    const extracted = join(work, 'extracted', engine);
    for (const [name, bytes] of Object.entries(zip)) {
      if (name.endsWith('/')) await mkdir(join(extracted, name), { recursive: true });
      else await put(extracted, name, bytes);
    }
    execFileSync(process.execPath, [join(root, 'tools/validate-mwgp.js'), join(extracted, 'mwgp.json')], { stdio: 'pipe' });
    if (script === 'convert-rgss.js') {
      assert.equal(manifest.compatibility.scripts.failed.length, 0, 'Ruby snippet transpiles');
      assert.ok(Object.keys(manifest.rubyLibrary?.units || {}).length, 'Ruby library transpiles');
    }
    console.log(`PASS ${engine}: offline file:// conversion, ZIP, validator and CLI parity (${nodeFiles.length} files)`);

    await page.locator('input[value=html]').check();
    await page.locator('#run').click();
    await page.waitForFunction(() => !document.querySelector('#run').disabled, { timeout: 90000 });
    assert.match(await page.locator('#status').textContent(), /^Conversion terminée/, await page.locator('#log').textContent());
    const htmlDownloadPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const htmlDownload = await htmlDownloadPromise;
    assert.ok(htmlDownload.suggestedFilename().endsWith('.html'));
    const playable = join(work, `${engine}-play.html`);
    await htmlDownload.saveAs(playable);
    const playableHtml = await readFile(playable, 'utf8');
    const packed = unpackStandalone(playableHtml);
    assert.equal(packed.metadata.format, 'MWGP-standalone');
    assert.equal(PLAYER_VERSION, '0.0.1', 'player version is fixed at 0.0.1 until the project manages it');
    assert.equal(packed.metadata.playerVersion, PLAYER_VERSION, 'standalone payload carries the player version');
    assert.match(playableHtml, new RegExp(`<meta name="mwgp-player-version" content="${PLAYER_VERSION.replaceAll('.', '\\.')}"`), 'standalone page declares the player version in its head');
    assert.match(playableHtml, new RegExp(`id="player-version"[^>]*>Player MWGP ${PLAYER_VERSION.replaceAll('.', '\\.')}<`), 'standalone page shows the player version');
    assert.ok(packed.files.has('.runtime/mwg.js') && packed.files.has('.runtime/player.js'));
    await checkLargePage(browser, playable, playableHtml, engine);
    assert.deepEqual(normalManifest(JSON.parse(packed.files.get('mwgp.json'))), normalManifest(manifest));
    for (const name of nodeFiles.filter(name => name.startsWith('assets/'))) assert.deepEqual(packed.files.get(name), await readFile(join(output, name)), `${engine}: gzip asset ${name}`);
    // The standalone Studio recreates the editable directory from the game
    // page alone, so the payload must carry the Studio baseline files too.
    assert.deepEqual(normalManifest(JSON.parse(packed.files.get('.mwgp-conversion.json'))), normalManifest(manifest), `${engine}: payload carries the Studio conversion baseline`);
    assert.ok(packed.files.has('.mwgp-merge-report.json'), `${engine}: payload carries the merge report`);
    if (engine === 'mv' || engine === 'mz') assert.ok(packed.files.has('assets/img/faces/'), `${engine}: payload carries empty resource directories`);
    // Recreate the directory (ZIP form) from the game page, in the converter page itself.
    await page.locator('#studio-source').setInputFiles(playable);
    assert.match(await page.locator('#studio-selection').textContent(), /page de jeu/, `${engine}: studio reads the game page`);
    const studioZipPromise = page.waitForEvent('download');
    await page.locator('#studio-zip').click();
    const studioZipPath = join(work, `${engine}-studio.zip`);
    await (await studioZipPromise).saveAs(studioZipPath);
    assert.match(await page.locator('#studio-status').textContent(), /^Dossier recréé/, `${engine}: studio reports recreation`);
    const studioZip = unzipSync(await readFile(studioZipPath));
    const studioFiles = Object.keys(studioZip).filter(name => !name.endsWith('/')).sort();
    assert.deepEqual(studioFiles, nodeFiles, `${engine}: studio ZIP recreates every CLI file`);
    for (const name of nodeFiles) {
      if (name === 'mwgp.json' || name === '.mwgp-conversion.json') assert.deepEqual(normalManifest(JSON.parse(Buffer.from(studioZip[name]).toString())), normalManifest(JSON.parse(await readFile(join(output, name), 'utf8'))), `${engine}: studio ${name}`);
      else assert.deepEqual(Buffer.from(studioZip[name]), await readFile(join(output, name)), `${engine}: studio file ${name}`);
    }
    if (engine === 'mv' || engine === 'mz') assert.ok(studioZip['assets/img/faces/'], `${engine}: studio ZIP preserves empty directories`);
    console.log(`PASS ${engine}: standalone Studio recreates the editable directory (ZIP) from the game page`);
    const gamePage = await context.newPage();
    const gameErrors = [];
    gamePage.on('pageerror', error => gameErrors.push(error.message));
    gamePage.on('console', message => {
      if (message.type() === 'error' || message.text().includes('using compatibility renderer')) gameErrors.push(message.text());
    });
    gamePage.on('requestfailed', request => gameErrors.push(`request failed: ${request.url()}`));
    try {
      await gamePage.goto(pathToFileURL(playable).href);
      const declared = await gamePage.evaluate(() => ({
        meta: document.querySelector('meta[name="mwgp-player-version"]')?.content,
        shown: document.querySelector('#player-version')?.textContent,
      }));
      assert.equal(declared.meta, PLAYER_VERSION, 'running page exposes the player version meta');
      assert.equal(declared.shown, `Player MWGP ${PLAYER_VERSION}`, 'running page shows the player version');
      if (engine === 'mv' || engine === 'mz') {
        await gamePage.waitForFunction(() => [...document.querySelectorAll('.mwgp-title img')].some(image => image.naturalWidth === 816), null, { timeout: 30000 });
      }
      await gamePage.getByRole('button', { name: 'New Game', exact: true }).click({ timeout: 60000 });
      assert.equal(await gamePage.evaluate(() => globalThis.mwgpStandalone?.playerVersion), PLAYER_VERSION, 'running player exposes mwgpStandalone.playerVersion');
      await gamePage.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover) && !document.querySelector('#loading'), null, { timeout: 45000 });
      assert.ok(await gamePage.locator('#studio-btn').isHidden(), 'standalone does not link to a missing Studio server');
      if (engine === 'mv' || engine === 'mz') {
        const assets = await gamePage.evaluate(async () => {
          const scene = globalThis.__MWG__.currentScene;
          const root = scene.project.assets.root;
          const picture = root + '/img/pictures/' + encodeURIComponent('été') + '.png';
          await mwg.Resources.load([picture]); // a typed image value is readable only after load()
          const img = new Image(); img.src = mwg.Resources.resolve(picture); await img.decode();
          const audio = await scene.audio.load('bgm', 'test');
          return { tile: mwg.Resources.isLoaded(root + '/img/tilesets/Probe.png'),
            character: mwg.Resources.isLoaded(root + '/img/characters/%24Hero.png'), imageWidth: img.naturalWidth,
            audioSamples: audio?.buffer.length || 0 };
        });
        assert.ok(assets.tile && assets.character, 'Pixi loads embedded tileset and character textures');
        assert.equal(assets.imageWidth, 1, 'encrypted Unicode-named image resolves to a loadable embedded URL');
        assert.ok(assets.audioSamples > 0, 'embedded WAV decodes');
        const before = await gamePage.evaluate(() => globalThis.__MWG__.currentScene.mover.x);
        await gamePage.keyboard.down('ArrowRight'); await gamePage.waitForTimeout(250); await gamePage.keyboard.up('ArrowRight');
        await gamePage.waitForFunction(x => globalThis.__MWG__.currentScene.mover.x !== x, before);
        await gamePage.evaluate(() => {
          const scene = globalThis.__MWG__.currentScene;
          globalThis.standalonePreviousScene = scene;
          try { scene.transfer({ mapId: 2, x: 1, y: 1 }); }
          catch (error) { if (error.constructor.name !== 'ExitEventSignal') throw error; }
        });
        await gamePage.waitForFunction(() => globalThis.__MWG__?.currentScene?.mover && globalThis.__MWG__.currentScene !== globalThis.standalonePreviousScene && new URLSearchParams(location.search).get('map') === '2');
        await gamePage.evaluate(() => {
          const scene = globalThis.__MWG__.currentScene;
          scene.gameState.setVariable('9', 42); scene.saveGame(1);
        });
        await gamePage.reload();
        await gamePage.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover) && !document.querySelector('#loading'));
        await gamePage.evaluate(() => globalThis.__MWG__.currentScene.loadGame(1));
        await gamePage.waitForFunction(() => globalThis.__MWG__.currentScene.gameState.variable('9') === 42);
        assert.equal(await gamePage.evaluate(() => globalThis.__MWG__.currentScene.saves.load('slot-1').state.mapId), 2);
        await gamePage.screenshot({ path: join(work, `${engine}-standalone.png`), fullPage: true });
      }
      assert.deepEqual(gameErrors, [], `${engine}: standalone has no runtime/fetch errors`);
      console.log(`PASS ${engine}: gzip HTML contains player + exact game bytes, boots full player offline${engine === 'mv' || engine === 'mz' ? ', textures/audio/movement/transfer/save/reload' : ''}`);
    } finally { await gamePage.close(); }
  }
  const goodHtml = await readFile(join(work, 'mv-play.html'), 'utf8');
  const corruptHtml = goodHtml.replace(/(<script data-mwgp-payload type="application\/octet-stream">)([\s\S]*?)(<\/script>)/, (_, before, payload, after) => {
    const bytes = Buffer.concat(payload.trim().split('\n').map(line => Buffer.from(line, 'base64')));
    bytes[bytes.length - 8] ^= 1; // corrupt gzip CRC32, preserving the packed files
    return before + '\n' + bytes.toString('base64') + '\n' + after;
  });
  const corruptPath = join(work, 'corrupt-game.html'); await writeFile(corruptPath, corruptHtml);
  const corruptPage = await context.newPage();
  try {
    await corruptPage.goto(pathToFileURL(corruptPath).href);
    await corruptPage.locator('#unpacking[role=alert]').waitFor({ timeout: 30000 });
    assert.match(await corruptPage.locator('#unpacking').textContent(), /^Could not open the game/);
    assert.ok(await corruptPage.evaluate(() => !globalThis.mwg), 'corrupt gzip never starts the player');
    console.log('PASS corrupted gzip: visible failure before player execution');
  } finally { await corruptPage.close(); }
  // A game too large for one script element is written as several: the same
  // page, its payload cut into one-line elements, must still open and start.
  const chunkedPath = join(work, 'chunked-game.html');
  const lines = [...goodHtml.matchAll(PAYLOAD_ELEMENT)][0][1].trim().split('\n');
  assert.ok(lines.length > 1, 'the sample payload has several lines to split');
  const chunkedHtml = goodHtml.replace(PAYLOAD_ELEMENT, () => lines
    .map(line => `<script data-mwgp-payload type="application/octet-stream">\n${line}\n</script>`).join('\n'));
  await writeFile(chunkedPath, chunkedHtml);
  const chunkedPage = await context.newPage();
  try {
    await chunkedPage.goto(pathToFileURL(chunkedPath).href);
    await chunkedPage.waitForFunction(() => globalThis.mwgpStandalone?.files?.has('mwgp.json'), null, { timeout: 60000 });
    assert.equal(await chunkedPage.evaluate(() => document.querySelectorAll('script[data-mwgp-payload]').length), 0, 'every payload element is read and removed');
    console.log('PASS chunked payload: several script elements unpack and start the player');
  } finally { await chunkedPage.close(); }
  // A malformed input must recover without a reload; cancellation must
  // immediately return control and permit selecting another project.
  const bad = join(work, 'bad'); await put(bad, 'readme.txt', 'not a game');
  await page.locator('#source').setInputFiles(bad); await page.locator('#run').click();
  await page.waitForFunction(() => !document.querySelector('#run').disabled);
  assert.match(await page.locator('#status').textContent(), /Projet non reconnu/);
  await page.locator('#source').setInputFiles(join(work, 'mv'));
  await page.locator('#run').click(); await page.locator('#cancel').click();
  assert.match(await page.locator('#status').textContent(), /annulée/);
  await page.locator('#run').click();
  await page.waitForFunction(() => !document.querySelector('#run').disabled);
  assert.match(await page.locator('#status').textContent(), /^Conversion terminée/);
  await page.screenshot({ path: join(work, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on mobile');
  await page.screenshot({ path: join(work, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'no uncaught page errors');
  assert.deepEqual(network, [], 'no network requests');
  // Exercise real writable FileSystemDirectoryHandles in Chromium's OPFS. Only
  // the OS picker is replaced; structured cloning and all Worker writes are real.
  const server = createServer(async (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(await readFile(html));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await context.setOffline(false);
    await page.addInitScript(() => { window.showDirectoryPicker = () => navigator.storage.getDirectory(); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await context.setOffline(true);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const existing = await root.getDirectoryHandle('mv-mwgp', { create: true });
      const file = await existing.getFileHandle('keep.txt', { create: true });
      const writer = await file.createWritable(); await writer.write('untouched'); await writer.close();
    });
    await page.locator('#source').setInputFiles(join(work, 'mv'));
    await page.locator('#folder-option').check();
    await page.locator('#run').click();
    await page.waitForFunction(() => !document.querySelector('#run').disabled, { timeout: 60000 });
    assert.match(await page.locator('#status').textContent(), /^Conversion terminée/, await page.locator('#log').textContent());
    assert.match(await page.locator('#result-description').textContent(), /mv-mwgp-2/);
    const result = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const existing = await root.getDirectoryHandle('mv-mwgp');
      const fresh = await root.getDirectoryHandle('mv-mwgp-2');
      const read = async (dir, name) => (await (await dir.getFileHandle(name)).getFile()).text();
      const assets = await fresh.getDirectoryHandle('assets');
      const images = await assets.getDirectoryHandle('img');
      const faces = await images.getDirectoryHandle('faces');
      return { emptyFaces: faces.kind === 'directory', sentinel: await read(existing, 'keep.txt'), manifest: JSON.parse(await read(fresh, 'mwgp.json')) };
    });
    assert.equal(result.sentinel, 'untouched', 'existing folder is preserved');
    assert.ok(result.emptyFaces, 'empty resource directory is created on disk');
    assert.deepEqual(normalManifest(result.manifest), normalManifest(JSON.parse(await readFile(join(work, 'node/mv/mwgp.json'), 'utf8'))));
    assert.ok(await page.locator('#download').isHidden(), 'folder output has no ZIP download');
    console.log('PASS native directory handles: Worker writes, CLI parity, existing output preserved');
    // The standalone Studio writes the recreated directory through the same
    // real directory handles, starting only from the game page.
    await page.locator('#studio-source').setInputFiles(join(work, 'mv-play.html'));
    await page.locator('#studio-folder').click();
    await page.waitForFunction(() => /^Dossier recréé/.test(document.querySelector('#studio-status').textContent), { timeout: 60000 });
    const studioResult = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const fresh = await root.getDirectoryHandle('mv-play');
      const read = async (dir, name) => (await (await dir.getFileHandle(name)).getFile()).text();
      const assets = await fresh.getDirectoryHandle('assets');
      const images = await assets.getDirectoryHandle('img');
      const faces = await images.getDirectoryHandle('faces');
      return { emptyFaces: faces.kind === 'directory', manifest: JSON.parse(await read(fresh, 'mwgp.json')),
        baseline: JSON.parse(await read(fresh, '.mwgp-conversion.json')) };
    });
    assert.ok(studioResult.emptyFaces, 'studio recreates empty resource directories on disk');
    assert.deepEqual(normalManifest(studioResult.manifest), normalManifest(JSON.parse(await readFile(join(work, 'node/mv/mwgp.json'), 'utf8'))), 'studio folder manifest matches CLI');
    assert.deepEqual(normalManifest(studioResult.baseline), normalManifest(studioResult.manifest), 'studio folder baseline matches manifest');
    console.log('PASS standalone Studio: directory recreated on disk from the game page alone');
  } finally { await new Promise(resolve => server.close(resolve)); }
  // ---- Standalone Studio: the full graphical editor in one offline file ----
  const studioHtml = join(work, 'studio-standalone.html');
  await exportStandaloneStudio(studioHtml);
  const studioPage = await context.newPage();
  const studioErrors = [];
  studioPage.on('pageerror', error => studioErrors.push(error.message));
  try {
    await studioPage.goto(pathToFileURL(studioHtml).href);
    await studioPage.locator('#studio-open-file').setInputFiles(join(work, 'mv-play.html'));
    await studioPage.waitForFunction(() => document.querySelectorAll('#map-list .item-row').length > 0, { timeout: 60000 });
    assert.equal(await studioPage.locator('#project-title').textContent(), 'MV browser fixture', 'studio loads the game manifest');
    // Edit the fixture event's dialogue through the graphical inspector.
    await studioPage.locator('#map-canvas').click({ position: { x: 16, y: 16 } });
    const sayBox = studioPage.locator('.cmd-box[data-type="say"] textarea');
    await sayBox.waitFor({ timeout: 30000 });
    await sayBox.fill('Dialogue édité dans le Studio autonome.');
    await studioPage.locator('#btn-apply-event').click();
    // Change the player version in the Studio, then save: the regenerated
    // game page must carry it in its payload, its head and its visible line.
    await studioPage.locator('#player-version').fill('1.2.3');
    await studioPage.locator('#btn-save').click();
    await studioPage.waitForFunction(() => document.querySelector('#toast').textContent.includes('sauvegardé'), { timeout: 30000 });
    // Download the regenerated, self-contained game page and verify the edit inside.
    const repackPromise = studioPage.waitForEvent('download');
    await studioPage.locator('#studio-download-game').click();
    const repackedPath = join(work, 'mv-edited-play.html');
    await (await repackPromise).saveAs(repackedPath);
    const repackedHtml = await readFile(repackedPath, 'utf8');
    const repacked = unpackStandalone(repackedHtml);
    assert.equal(repacked.metadata.playerVersion, '1.2.3', 'studio-set player version reaches the payload');
    assert.match(repackedHtml, /<meta name="mwgp-player-version" content="1\.2\.3">/, 'studio-set player version reaches the page head');
    assert.match(repackedHtml, /id="player-version"[^>]*>Player MWGP 1\.2\.3</, 'studio-set player version reaches the visible line');
    const editedManifest = JSON.parse(repacked.files.get('mwgp.json'));
    assert.equal(editedManifest.playerVersion, '1.2.3', 'player version is stored in the manifest');
    const say = editedManifest.maps[0].mwgEvents[0].pages[0].commands.find(command => typeof command.say === 'string');
    assert.equal(say.say, 'Dialogue édité dans le Studio autonome.', 'edited dialogue is inside the regenerated game page');
    assert.deepEqual(normalManifest(JSON.parse(repacked.files.get('.mwgp-conversion.json'))), normalManifest(JSON.parse(await readFile(join(work, 'node/mv/mwgp.json'), 'utf8'))), 'repacked page keeps the original conversion baseline');
    const editedPage = await context.newPage();
    const editedErrors = [];
    editedPage.on('pageerror', error => editedErrors.push(error.message));
    editedPage.on('requestfailed', request => editedErrors.push(`request failed: ${request.url()}`));
    try {
      await editedPage.goto(pathToFileURL(repackedPath).href);
      await editedPage.getByRole('button', { name: 'New Game', exact: true }).click({ timeout: 60000 });
      await editedPage.waitForFunction(() => Boolean(globalThis.__MWG__?.currentScene?.mover) && !document.querySelector('#loading'), null, { timeout: 45000 });
      assert.equal(await editedPage.evaluate(() => globalThis.mwgpStandalone?.playerVersion), '1.2.3', 'edited page runs with the studio-set player version');
      assert.deepEqual(editedErrors, [], 'edited game page boots offline without errors');
    } finally { await editedPage.close(); }
    assert.deepEqual(studioErrors, [], 'standalone studio has no page errors');
    console.log('PASS standalone Studio: full editor offline, dialogue edited, saved, game page regenerated and booted');
  } finally { await studioPage.close(); }
  await checkLargeStudio(browser, { work, studioHtml });
  console.log(`PASS errors, cancellation/retry, mobile layout, zero network requests. Evidence: ${work}`);
} finally { await browser.close(); }
