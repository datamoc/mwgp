import { createServer } from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Text responses (manifests, plugin/engine sources) are large and compress ~8x: gzip them for clients that
// accept it, keeping the compressed copy per file version so the cost is paid once.
const gzipped = new Map();
async function sendFile(req, res, file, type) {
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(file);
  const headers = { 'content-type': type, 'cache-control': 'no-cache' };
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && stat.size > 4096 && /json|javascript|text/.test(type)) {
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (!gzipped.has(key)) gzipped.set(key, promisify(gzip)(await fs.readFile(file)));
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(await gzipped.get(key));
  }
  res.writeHead(200, headers);
  return res.end(await fs.readFile(file));
}

// Content types for decoded project assets (audio covers every RPG Maker generation's formats).
const assetTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg', '.mid': 'audio/midi', '.wma': 'audio/x-ms-wma', '.sf2': 'audio/x-soundfont', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gamesRoot = join(root, 'RPGM_versions');
const mwgpRoot = join(root, 'MWGP_versions');
const publicRoot = join(root, 'public');
const port = Number(process.env.RPGM_PORT || 4173);

function detectGame(folderName) {
  const folder = join(gamesRoot, folderName);
  if (!statSafe(folder)?.isDirectory()) return null;
  // MV nests the game under www/; MZ (and some MV web exports) put data/js/index.html
  // directly at the project root. System.json is the RPG Maker fingerprint that tells
  // a real project apart from an unrelated web app that happens to ship a data/ folder.
  const mvRoot = existsSync(join(folder, 'www', 'data', 'System.json')) ? join(folder, 'www') : null;
  const flatRoot = !mvRoot && existsSync(join(folder, 'data', 'System.json')) ? folder : null;
  const gameRoot = mvRoot || flatRoot;
  const rgss = existsSync(join(folder, 'Game.ini')) && existsSync(join(folder, 'Game.exe'));
  if (!gameRoot && !rgss) return null;
  const isMz = gameRoot && existsSync(join(gameRoot, 'js', 'rmmz_core.js'));
  return {
    id: Buffer.from(folderName, 'utf8').toString('base64url'),
    name: folderName,
    engine: gameRoot ? (isMz ? 'RPG Maker MZ' : 'RPG Maker MV') : 'RPG Maker XP/VX/Ace (RGSS)',
    kind: gameRoot ? 'mv' : 'rgss',
    executable: join(folder, 'Game.exe')
  };
}

function listGames() {
  if (!existsSync(gamesRoot)) return [];
  return readdirSync(gamesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => detectGame(entry.name))
    .filter(Boolean);
}

function listMwgp() {
  if (!existsSync(mwgpRoot)) return [];
  return readdirSync(mwgpRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const folder = join(mwgpRoot, entry.name);
    return existsSync(join(folder, 'mwgp.json')) ? { id: Buffer.from(entry.name, 'utf8').toString('base64url'), name: entry.name, kind: 'mwgp' } : null;
  }).filter(Boolean);
}

function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function launchGame(id) {
  const game = listGames().find(item => item.id === id);
  if (!game) return { error: 'Game not found' };
  if (!existsSync(game.executable)) return { error: 'Game executable not found' };
  const child = spawn(game.executable, [], { cwd: resolve(game.executable, '..'), detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, name: game.name };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/games' && req.method === 'GET') return json(res, 200, { rpgm: listGames(), mwgp: listMwgp() });
  if (url.pathname.startsWith('/api/mwgp/') && req.method === 'GET') {
    const rest = decodeURIComponent(url.pathname.slice('/api/mwgp/'.length));
    const assetMarker = '/assets/';
    if (rest.includes(assetMarker)) {
      const [assetId, assetPath] = rest.split(assetMarker);
      const assetName = Buffer.from(assetId, 'base64url').toString('utf8');
      const assetFile = resolve(mwgpRoot, assetName, 'assets', assetPath);
      const assetBase = resolve(mwgpRoot, assetName, 'assets');
      if (!assetFile.startsWith(assetBase + sep) || !existsSync(assetFile)) return json(res, 404, { error: 'Asset not found' });
      const type = assetTypes[extname(assetFile).toLowerCase()] || 'application/octet-stream';
      return sendFile(req, res, assetFile, type);
    }
    const id = rest;
    const folder = listMwgp().find(item => item.id === id);
    if (!folder) return json(res, 404, { error: 'MWGP project not found' });
    const name = Buffer.from(id, 'base64url').toString('utf8');
    const manifest = join(mwgpRoot, name, 'mwgp.json');
    if (!existsSync(manifest)) return json(res, 404, { error: 'MWGP manifest not found' });
    return sendFile(req, res, manifest, 'application/json; charset=utf-8');
  }
  if (url.pathname === '/api/launch' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { return json(res, 200, launchGame(JSON.parse(body).id)); }
    catch { return json(res, 400, { error: 'Invalid request' }); }
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (url.pathname === '/fallback-core.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'src', 'player', 'fallback-core.js'))));
  }
  if (url.pathname === '/player-core.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'src', 'player', 'player-core.js'))));
  }
  if (url.pathname === '/audio-manager.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'src', 'player', 'audio-manager.js'))));
  }
  if (url.pathname === '/soundfont.sf2') {
    // Optional shared General MIDI SoundFont: only entries of soundfonts/vetted.json (licence and
    // ownership checked, see soundfonts/README.md). Games that ship their own are served from
    // their converted assets instead.
    const dir = join(root, 'soundfonts');
    let file = null;
    try {
      const vetted = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'vetted.json'), 'utf8')));
      file = (vetted.fonts || []).map(entry => entry.file).find(name => typeof name === 'string' && basename(name) === name && existsSync(join(dir, name)));
    } catch { /* no vetted list */ }
    if (!file) return json(res, 404, { error: 'No vetted shared SoundFont installed' });
    res.writeHead(200, { 'content-type': 'audio/x-soundfont' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(dir, file))));
  }
  if (url.pathname === '/rgss-classes.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'src', 'player', 'rgss-classes.js'))));
  }
  if (url.pathname === '/rgss-script.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'src', 'player', 'rgss-script.js'))));
  }
  // Any other module of the player (imported relatively by player-core.js / rgss-script.js): src/player/<name>.js.
  if (/^\/[a-z0-9_-]+\.js$/i.test(url.pathname) && existsSync(join(root, 'src', 'player', url.pathname.slice(1)))) {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'src', 'player', url.pathname.slice(1)))));
  }
  if (url.pathname === '/mwg.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'node_modules', '@datamoc', 'mw_games', 'dist', 'mw_games.global.js'))));
  }
  // Browsers request a favicon even when the page does not declare one.
  // Return an explicit empty response so console diagnostics contain only
  // actual launcher/player failures.
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = resolve(publicRoot, `.${requested}`);
  if (!file.startsWith(publicRoot + sep) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain';
  res.writeHead(200, { 'content-type': type });
  res.end(await import('node:fs/promises').then(fs => fs.readFile(file)));
});

if (process.argv.includes('--scan')) {
  console.log(JSON.stringify({ rpgm: listGames(), mwgp: listMwgp() }, null, 2));
} else {
  server.listen(port, '127.0.0.1', () => console.log(`RPGM Player: http://127.0.0.1:${port}`));
}
