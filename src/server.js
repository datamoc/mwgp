import { readManifestConverterVersion, isStaleConverterVersion } from '../tools/converter-version.mjs';
import { saveStudioManifest, compareStudioManifest, loadStudioManifest, createStudioProject } from './studio-manifest.js';
import { listStudioAssets, readStudioAsset, saveStudioAsset, isTextAsset } from './studio-assets.js';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildMapIndex, findMapEntry, indexCacheKey, mapCacheKey } from './map-index.js';

// Text responses (manifests, plugin/engine sources) are large and compress ~8x: gzip them for clients that
// accept it, keeping the compressed copy per file version so the cost is paid once.
const gzipped = new Map();

// A generated cache (e.g. FastCutIns) writes many files in one burst, each its own POST to /api/web-cache:
// concurrent requests must not read-modify-write the same build's files.json in parallel, or the read-modify-write
// race silently drops entries (the last writer's read predates the others' appends), which then makes the game
// think those files were never generated on the next launch. Serialize per build (outputRoot).
const fileListLocks = new Map();
function withFileListLock(outputRoot, task) {
  const chained = (fileListLocks.get(outputRoot) || Promise.resolve()).then(task, task);
  fileListLocks.set(outputRoot, chained.catch(() => {}));
  return chained;
}
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
const mwgpRoot = resolve(process.env.MWGP_ROOT || join(root, 'MWGP_versions'));
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

// Converted projects: MWGP manifests (played by the MWGP player) and MV/MZ web builds (the game's own engine,
// tools/build-web.js), both under MWGP_versions/.
function listMwgp() {
  if (!existsSync(mwgpRoot)) return [];
  return readdirSync(mwgpRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const folder = join(mwgpRoot, entry.name);
    const id = Buffer.from(entry.name, 'utf8').toString('base64url');
    if (existsSync(join(folder, 'mwgp.json'))) {
      // A manifest made by an older converter (or one that predates the stamp) is flagged so the launcher can offer a reconversion.
      const converterVersion = readManifestConverterVersion(join(folder, 'mwgp.json'));
      return { id, name: entry.name, kind: 'mwgp', converterVersion, stale: isStaleConverterVersion(converterVersion) };
    }
    if (existsSync(join(folder, 'mwgp-web.json'))) {
      let info = {};
      try { info = JSON.parse(readFileSync(join(folder, 'mwgp-web.json'), 'utf8')); } catch { /* listed by name only */ }
      return { id, name: entry.name, kind: 'web', engine: info.source?.engine === 'rpg-maker-rgss' ? `RPG Maker ${info.rgss?.generation?.toUpperCase() || 'XP/VX/Ace'} (web build)` : info.source?.engine === 'rpg-maker-mz' ? 'RPG Maker MZ (web build)' : 'RPG Maker MV (web build)', title: info.title || entry.name };
    }
    return null;
  }).filter(Boolean);
}

// Web builds are static folders: any file, with a type the browser needs to use it.
const webTypes = { ...assetTypes, '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8' };
async function sendWebFile(req, res, id, path) {
  if (!listMwgp().some(item => item.id === id && item.kind === 'web')) return json(res, 404, { error: 'Web build not found' });
  const base = resolve(mwgpRoot, Buffer.from(id, 'base64url').toString('utf8'));
  let file = resolve(base, `.${path || '/'}`);
  if (file !== base && !file.startsWith(base + sep)) return json(res, 404, { error: 'Not found' });
  if (statSafe(file)?.isDirectory()) file = join(file, 'index.html');
  const stat = statSafe(file);
  if (!stat?.isFile()) return json(res, 404, { error: 'Not found' });
  const type = webTypes[extname(file).toLowerCase()] || 'application/octet-stream';
  if (/json|javascript|text|svg/.test(type)) return sendFile(req, res, file, type);
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
  return undefined;
}

function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

// Lazy per-map loading (T119): the on-disk manifest stays a single file, but
// the browser boots from a small index (map stubs only) and fetches one full
// map entry per visited map. Parsing a tens-of-MB manifest per request would
// spike the server, so parsed manifests are cached per file version.
const parsedManifests = new Map();
async function loadManifest(file) {
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(file);
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  let entry = parsedManifests.get(file);
  if (!entry || entry.key !== key) {
    entry = { key, manifest: JSON.parse(await fs.readFile(file, 'utf8')) };
    parsedManifests.set(file, entry);
  }
  return entry.manifest;
}

// Same one-time gzip pattern as sendFile, for generated JSON payloads.
async function sendJson(req, res, text, cacheKey) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' };
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && text.length > 4096) {
    if (!gzipped.has(cacheKey)) gzipped.set(cacheKey, promisify(gzip)(text));
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(await gzipped.get(cacheKey));
  }
  res.writeHead(200, headers);
  return res.end(text);
}

function resolveProject(id) {
  if (!listMwgp().some(item => item.id === id)) return { error: 'MWGP project not found' };
  const name = Buffer.from(id, 'base64url').toString('utf8');
  const manifest = join(mwgpRoot, name, 'mwgp.json');
  if (!existsSync(manifest)) return { error: 'MWGP manifest not found' };
  return { manifest };
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
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        origin && origin !== url.origin || site && !['same-origin', 'none'].includes(site)) {
      return json(res, 403, { error: 'This action must originate from the local application' });
    }
  }
  if (url.pathname.startsWith('/web/')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  if (url.pathname === '/api/games' && req.method === 'GET') return json(res, 200, { rpgm: listGames(), mwgp: listMwgp() });
  const studioAssets = /^\/api\/studio\/assets\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (studioAssets && ['GET', 'POST'].includes(req.method)) {
    const resolved = resolveProject(studioAssets[1]);
    if (resolved.error) return json(res, 404, { error: resolved.error });
    const folder = resolve(resolved.manifest, '..'), path = url.searchParams.get('path');
    try {
      if (req.method === 'GET' && path === null) return json(res, 200, await listStudioAssets(folder, url.searchParams.get('prefix') || ''));
      if (!path) return json(res, 400, { error: 'Select a resource file' });
      if (req.method === 'GET') {
        const bytes = await readStudioAsset(folder, path, url.searchParams.get('version') || 'edited');
        if (bytes === null) return json(res, 404, { error: 'Resource absent in this version' });
        res.writeHead(200, { 'content-type': isTextAsset(path) ? 'text/plain; charset=utf-8' : assetTypes[extname(path).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store' });
        return res.end(bytes);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) return json(res, 413, { error: 'Resource replacement exceeds 64 MiB' });
        chunks.push(chunk);
      }
      const result = await saveStudioAsset(folder, path, Buffer.concat(chunks));
      parsedManifests.delete(resolved.manifest);
      // Resource changes also change the manifest's audio cache revision.
      gzipped.clear();
      return json(res, 200, { ok: true, ...result });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  const studioProject = /^\/api\/studio\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (studioProject && req.method === 'GET') {
    const resolved = resolveProject(studioProject[1]);
    if (resolved.error) return json(res, 404, { error: resolved.error });
    try { return json(res, 200, await loadStudioManifest(resolve(resolved.manifest, '..'))); }
    catch (error) { return json(res, 500, { error: error.message }); }
  }
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
    // Project ids are base64url (never contain '/'), so a '/maps/' or
    // '/index' suffix unambiguously marks a lazy-loading route (T119).
    const mapMarker = '/maps/';
    if (rest.includes(mapMarker)) {
      const [mapIdPart, mapIdRaw] = rest.split(mapMarker);
      const resolved = resolveProject(mapIdPart);
      if (resolved.error) return json(res, 404, { error: resolved.error });
      const entry = findMapEntry(await loadManifest(resolved.manifest), mapIdRaw);
      if (!entry) return json(res, 404, { error: 'MWGP map not found' });
      return sendJson(req, res, JSON.stringify(entry), mapCacheKey(resolved.manifest, statSafe(resolved.manifest), entry.id));
    }
    if (rest.endsWith('/index')) {
      const resolved = resolveProject(rest.slice(0, -'/index'.length));
      if (resolved.error) return json(res, 404, { error: resolved.error });
      const payload = JSON.stringify(buildMapIndex(await loadManifest(resolved.manifest)));
      return sendJson(req, res, payload, indexCacheKey(resolved.manifest, statSafe(resolved.manifest)));
    }
    const resolved = resolveProject(rest);
    if (resolved.error) return json(res, 404, { error: resolved.error });
    return sendFile(req, res, resolved.manifest, 'application/json; charset=utf-8');
  }
  if (url.pathname === '/api/launch' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { return json(res, 200, launchGame(JSON.parse(body).id)); }
    catch { return json(res, 400, { error: 'Invalid request' }); }
  }
  if (url.pathname === '/api/studio/init' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { name, title } = JSON.parse(body);
      const folderName = String(name || '').trim();
      if (!folderName || folderName.length > 64 || /[\\/:*?"<>|]|\.\./.test(folderName) || folderName.startsWith('.')) return json(res, 400, { error: 'Nom de projet invalide' });
      const folder = resolve(mwgpRoot, folderName);
      if (!folder.startsWith(resolve(mwgpRoot) + sep)) return json(res, 400, { error: 'Nom de projet invalide' });
      if (existsSync(join(folder, 'mwgp.json'))) return json(res, 409, { error: 'Ce projet existe déjà' });
      await createStudioProject(folder, String(title || folderName));
      return json(res, 201, { ok: true, name: folderName, id: Buffer.from(folderName).toString('base64url') });
    } catch (error) { return json(res, 500, { error: error.message || 'Création impossible' }); }
  }
  if (['/api/studio/save', '/api/studio/compare'].includes(url.pathname) && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id, manifest } = JSON.parse(body);
      if (!id || !manifest) return json(res, 400, { error: 'Missing id or manifest' });
      const resolved = resolveProject(id);
      if (resolved.error) return json(res, 404, { error: resolved.error });
      const targetFile = resolved.manifest;
      const folder = resolve(targetFile, '..');
      const name = basename(folder);
      if (manifest.format !== 'MWGP' || !Array.isArray(manifest.maps)) {
        return json(res, 400, { error: 'Invalid MWGP manifest' });
      }
      if (url.pathname === '/api/studio/compare') {
        return json(res, 200, await compareStudioManifest(folder, manifest));
      }
      const protection = await saveStudioManifest(folder, manifest);
      parsedManifests.delete(targetFile);
      for (const key of gzipped.keys()) {
        if (key.startsWith(targetFile)) gzipped.delete(key);
      }
      return json(res, 200, { ok: true, name, maps: manifest.maps.length, ...protection });
    } catch (err) {
      console.error('[studio save] error:', err);
      return json(res, 500, { error: err.message || 'Could not save manifest' });
    }
  }
  const webCache = /^\/api\/web-cache\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (webCache && req.method === 'POST') {
    const [, id] = webCache;
    const build = listMwgp().find(item => item.id === id && item.kind === 'web');
    if (!build) return json(res, 404, { error: 'Web build not found' });
    let relativePath;
    relativePath = (url.searchParams.get('path') || '').replace(/\\/g, '/');
    const segments = relativePath.split('/').filter(Boolean);
    const cachePath = segments.at(-1) === '.fast-cut-ins' || segments.at(-1) === '.fast-cut-ins.lock' || segments.some(part => /_fast$/i.test(part));
    if (!segments.length || segments.some(part => part === '.' || part === '..' || part.includes(':')) || !cachePath)
      return json(res, 400, { error: 'Only generated FastCutIns cache paths can be written' });
    const buffers = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) return json(res, 413, { error: 'Cache file exceeds 128 MiB' });
      buffers.push(chunk);
    }
    const data = Buffer.concat(buffers, size);
    const projectRoot = resolve(gamesRoot, build.name);
    const sourceRoot = existsSync(join(projectRoot, 'www', 'data', 'System.json')) ? join(projectRoot, 'www') : projectRoot;
    const outputRoot = resolve(mwgpRoot, build.name);
    const sourceFile = resolve(sourceRoot, relativePath), outputFile = resolve(outputRoot, relativePath);
    if (!sourceFile.startsWith(sourceRoot + sep) || !outputFile.startsWith(outputRoot + sep)) return json(res, 400, { error: 'Invalid cache path' });
    try {
      // Save to the served build first; native game processes can briefly hold an existing source cache open.
      mkdirSync(resolve(outputFile, '..'), { recursive: true });
      writeFileSync(outputFile, data);
      let sourceSaved = false, sourceError = null;
      for (let attempt = 0; attempt < 4 && !sourceSaved; attempt++) {
        try { mkdirSync(resolve(sourceFile, '..'), { recursive: true }); writeFileSync(sourceFile, data); sourceSaved = true; }
        catch (error) {
          sourceError = error;
          if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 3) break;
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
      await withFileListLock(outputRoot, () => {
        const fileListPath = join(outputRoot, 'files.json');
        const fileList = JSON.parse(readFileSync(fileListPath, 'utf8'));
        if (!fileList.some(name => name.toLowerCase() === relativePath.toLowerCase())) {
          fileList.push(relativePath);
          fileList.sort((a, b) => a.localeCompare(b));
          writeFileSync(fileListPath, JSON.stringify(fileList));
        }
      });
      if (!sourceSaved) console.warn('[web cache] saved to web build; source cache remains locked', build.name, relativePath, sourceError);
      return json(res, 200, { ok: true, sourceSaved });
    } catch (error) {
      console.error('[web cache] write failed', build.name, relativePath, error);
      return json(res, 500, { error: 'Could not save generated cache' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  // /web/<id>/... : an MV/MZ web build, served as the static folder it is (relative URLs resolve inside it).
  const web = /^\/web\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
  if (web) {
    if (!web[2]) { res.writeHead(301, { location: `/web/${web[1]}/` }); return res.end(); }
    let path;
    try { path = decodeURIComponent(web[2]); } catch { return json(res, 400, { error: 'Bad path' }); }
    return sendWebFile(req, res, web[1], path);
  }
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
    return res.end(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'node_modules', '@datamoc', 'mwg', 'dist', 'mwg.global.js'))));
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
