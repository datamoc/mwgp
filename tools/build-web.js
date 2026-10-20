// Builds a web version of an RPG Maker MV/MZ game: the game's own engine and files, playable in any browser from any
// static web host. MV/MZ games are browser code; nw.js only adds a few host APIs, which src/web/nwjs-host.js provides
// generically. Nothing here is converted or knows a particular game.
//
// Output (a self-contained static folder):
//   - the game's web root (`www/` for MV, the project root for MZ) copied as-is, encrypted assets included (the
//     engine decrypts them itself); a native `save/` folder is left out (saves live in the browser);
//   - nwjs-host.js, loaded first by the patched index.html, whose `<script src>` tags become `data-mwgp-src`
//     placeholders the host loads once its save store and file list are ready;
//   - files.json, the list of the game's files (the host answers `fs.readdirSync`/`existsSync` from it);
//   - mwgp-web.json, what the build is (the launcher lists folders carrying it).
//
// Usage: node tools/build-web.js <RPGM project> <output folder>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgress } from './progress.mjs';
import { assetLockBusy } from '../src/studio-assets.js';
import { buildRgss } from './build-rgss.mjs';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  console.error('Usage: node tools/build-web.js <RPGM project> <output folder>');
  process.exit(1);
}
const source = resolve(sourceArg), output = resolve(outputArg);
if (['.mwgp-studio.json', '.mwgp-studio-assets.json'].some(name => existsSync(join(output, name)))) {
  throw new Error('This output contains Studio edits. Use a separate output folder for the web build, or --mwgp for reconversion.');
}
if (await assetLockBusy(output)) {
  throw new Error('A Studio resource operation is live on this output; wait for it and retry the web build.');
}
const hostFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'nwjs-host.js');
const progress = createProgress();
let phase = progress.phase('reading the project', 2);

// The web root: MV nests the game under www/, MZ (and MV web exports) keep it at the project root.
const webRoot = [join(source, 'www'), source].find(dir => existsSync(join(dir, 'index.html')) && existsSync(join(dir, 'data', 'System.json')));
if (!webRoot) {
  phase.end();
  phase = progress.phase('building the RGSS archive and player', 98);
  const info = await buildRgss(source, output);
  phase.end();
  console.log(`MWGP web build: ${info.title} (${info.rgss.generation.toUpperCase()}), ${info.source.files} files -> ${output}`);
  process.exit(0);
}
const engine = existsSync(join(webRoot, 'js', 'rmmz_core.js')) ? 'rpg-maker-mz' : 'rpg-maker-mv';
let title = basename(source);
try { title = JSON.parse(readFileSync(join(webRoot, 'data', 'System.json'), 'utf8').replace(/^\uFEFF/, '')).gameTitle || title; } catch { /* keep the folder name */ }

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (!(dir === webRoot && entry.name.toLowerCase() === 'save')) walk(full, out); }
    else out.push(full);
  }
  return out;
};
const walkDirectories = (dir, base, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) {
    const full = join(dir, entry.name);
    const name = relative(base, full).split('\\').join('/');
    out.push(name);
    if (!(dir === base && entry.name.toLowerCase() === 'save')) walkDirectories(full, base, out);
  }
  return out;
};
const sourceFiles = walk(webRoot);
const relativeName = file => relative(webRoot, file).split('\\').join('/');
// NW projects may keep add-on data beside www/ while scripts resolve paths from the game root.
// Include only this conventional directory; do not absorb the native runtime or other host files.
const externalMods = webRoot !== source && existsSync(join(source, 'mods'))
  ? walk(join(source, 'mods')).map(file => ({ file, name: `mods/${relative(join(source, 'mods'), file).split('\\').join('/')}` }))
  : [];
const buildDirectories = new Set(walkDirectories(webRoot, webRoot));
if (externalMods.length || (webRoot !== source && existsSync(join(source, 'mods')))) {
  buildDirectories.add('mods');
  for (const dir of walkDirectories(join(source, 'mods'), join(source, 'mods'))) buildDirectories.add(`mods/${dir}`);
}
// Some games expect to inspect their writable log directory before creating or writing any logs.
if (webRoot !== source && existsSync(join(source, 'logs'))) buildDirectories.add('logs');
const buildFilesByName = new Map(sourceFiles.map(file => {
  const name = relativeName(file);
  return [name.toLowerCase(), { file, name }];
}));
for (const entry of externalMods) buildFilesByName.set(entry.name.toLowerCase(), entry);
const buildFiles = [...buildFilesByName.values()];

// A previous build of the same folder: remove what the game no longer ships. A previous MWGP conversion of it (the
// mwgp.json manifest and its decoded assets/) is replaced by this build.
phase.end();
phase = progress.phase('cleaning the previous build', 3);
await mkdir(output, { recursive: true });
const wanted = new Set(buildFiles.map(entry => entry.name.toLowerCase()));
try {
  const previous = JSON.parse(await readFile(join(output, 'files.json'), 'utf8'));
  for (const name of Array.isArray(previous) ? previous : []) if (!wanted.has(String(name).toLowerCase())) await rm(join(output, name), { force: true });
} catch { /* no previous web build */ }
try {
  const manifest = JSON.parse(await readFile(join(output, 'mwgp.json'), 'utf8'));
  if (manifest?.format === 'MWGP') {
    await rm(join(output, 'mwgp.json'), { force: true });
    await rm(join(output, 'assets'), { recursive: true, force: true });
    console.log('MWGP web build: replaced the previous MWGP conversion in this folder (mwgp.json, assets/)');
  }
} catch { /* no previous conversion */ }

phase.end();
phase = progress.phase('copying the game', 90, buildFiles.length);
let copied = 0, unchanged = 0;
for (const { file, name } of buildFiles) {
  const target = join(output, name);
  const from = statSync(file);
  const to = existsSync(target) ? statSync(target) : null;
  // Unchanged files (same size, not older) are kept: rebuilding a multi-GB game only copies what changed.
  if (to && to.size === from.size && to.mtimeMs >= from.mtimeMs) unchanged++;
  else { await mkdir(dirname(target), { recursive: true }); await copyFile(file, target); copied++; }
  phase.tick(name);
}

phase.end();
phase = progress.phase('writing the web host', 5);
// index.html: the host first, then the game's scripts as placeholders it loads in order.
const html = await readFile(join(webRoot, 'index.html'), 'utf8');
let deferred = 0;
const patched = html
  .replace(/<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']*)\2([^>]*)>/gi, (whole, before, quote, src, after) => { deferred++; return `<script${before}data-mwgp-src=${quote}${src}${quote}${after}>`; })
  .replace(/<head([^>]*)>/i, head => `${head}\n        <script src="nwjs-host.js"></script>`);
if (!/nwjs-host\.js/.test(patched)) throw new Error('index.html has no <head> to load the web host from');
await writeFile(join(output, 'index.html'), patched);
await copyFile(hostFile, join(output, 'nwjs-host.js'));
const fileList = buildFiles.map(entry => entry.name).sort();
await writeFile(join(output, 'files.json'), JSON.stringify(fileList));
await writeFile(join(output, 'directories.json'), JSON.stringify([...buildDirectories].sort()));
const buildInfo = {
  format: 'MWGP-web', version: 1, title, entry: 'index.html', host: 'nwjs-host.js',
  source: { engine, projectName: basename(source), builtAt: new Date().toISOString(), files: fileList.length }
};
await writeFile(join(output, 'mwgp-web.json'), JSON.stringify(buildInfo, null, 2));
phase.end();
console.log(`MWGP web build: ${title} (${engine === 'rpg-maker-mz' ? 'MZ' : 'MV'}), ${fileList.length} files (${copied} copied, ${unchanged} unchanged), ${deferred} script(s) loaded through the host -> ${output}`);
