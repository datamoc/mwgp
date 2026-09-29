import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { ensureCore, CORE_FILES, CORE_REVISION, sha256 } from './mkxp-core.mjs';

const require = createRequire(import.meta.url);
const { ZipFile } = require('yazl');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set(['save', 'gpucache', 'code cache', 'dawncache', 'shadercache', 'grshadercache']);
const excludedExtensions = new Set(['.exe', '.dll']);

export function rgssFiles(source) {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) walk(full);
      } else if (entry.isFile() && !excludedExtensions.has(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  walk(source);
  return out.sort((a, b) => a.localeCompare(b));
}

export function rgssOptions(source) {
  const names = readdirSync(source);
  const modernRuby = names.some(name => /(?:^|[-_])ruby(?:2\d\d|3\d\d)(?:\D|$)/i.test(name));
  const generation = existsSync(join(source, 'Game.rgss3a')) || existsSync(join(source, 'Data', 'Scripts.rvdata2')) ? 'ace'
    : existsSync(join(source, 'Game.rgss2a')) || existsSync(join(source, 'Data', 'Scripts.rvdata')) ? 'vx' : 'xp';
  return { generation, modernRuby, syntaxTransform: modernRuby ? 0 : 2 };
}

async function archive(source, target, files) {
  const zip = new ZipFile();
  for (const file of files) zip.addFile(file, relative(source, file).replaceAll('\\', '/'), { compress: false });
  const stream = pipeline(zip.outputStream, createWriteStream(target));
  zip.end({ forceZip64Format: true });
  await stream;
}

export async function buildRgss(source, output) {
  if (!existsSync(join(source, 'Game.ini')) || !(
    existsSync(join(source, 'Game.rgssad')) || existsSync(join(source, 'Game.rgss2a')) || existsSync(join(source, 'Game.rgss3a')) ||
    existsSync(join(source, 'Data', 'Scripts.rxdata')) || existsSync(join(source, 'Data', 'Scripts.rvdata')) || existsSync(join(source, 'Data', 'Scripts.rvdata2'))
  )) throw new Error(`${source} is not an RGSS project`);
  const files = rgssFiles(source);
  const names = files.map(file => relative(source, file).replaceAll('\\', '/'));
  const options = rgssOptions(source);
  let title = basename(source);
  try { title = (await readFile(join(source, 'Game.ini'), 'utf8')).match(/^Title\s*=\s*(.+)$/im)?.[1]?.trim() || title; } catch { /* folder name */ }
  const core = await ensureCore();
  await mkdir(output, { recursive: true });
  const previous = join(output, 'mwgp-web.json');
  if (existsSync(previous)) {
    try {
      const old = JSON.parse(await readFile(previous, 'utf8'));
      if (old.source?.engine === 'rpg-maker-rgss') {
        for (const name of ['game.mkxpz', 'rgss-player.js', 'nostalgist.umd.js', ...Object.keys(CORE_FILES)]) await rm(join(output, name), { force: true });
      }
    } catch { /* old metadata */ }
  }
  if (existsSync(join(output, 'mwgp.json'))) {
    await rm(join(output, 'mwgp.json'), { force: true });
    await rm(join(output, 'assets'), { recursive: true, force: true });
  }
  for (const name of ['files.json', 'nwjs-host.js']) await rm(join(output, name), { force: true });
  const target = join(output, 'game.mkxpz');
  await archive(source, target, files);
  await copyFile(join(repo, 'src', 'web', 'rgss-player.html'), join(output, 'index.html'));
  await copyFile(join(repo, 'src', 'web', 'rgss-player.js'), join(output, 'rgss-player.js'));
  await copyFile(join(repo, 'src', 'web', 'mkxp-z-COPYING'), join(output, 'mkxp-z-COPYING'));
  await copyFile(require.resolve('nostalgist'), join(output, 'nostalgist.umd.js'));
  await copyFile(join(dirname(require.resolve('nostalgist')), '..', 'license'), join(output, 'nostalgist-LICENSE'));
  for (const name of Object.keys(CORE_FILES)) await copyFile(join(core, name), join(output, name));
  const info = { format: 'MWGP-web', version: 1, title, entry: 'index.html',
    source: { engine: 'rpg-maker-rgss', projectName: basename(source), builtAt: new Date().toISOString(), files: files.length },
    rgss: options,
    core: { revision: CORE_REVISION, files: Object.fromEntries(Object.keys(CORE_FILES).map(name => [name, { sha256: CORE_FILES[name], bytes: statSync(join(core, name)).size }])) },
    archive: { name: 'game.mkxpz', bytes: statSync(target).size, sha256: await sha256(target), entries: names } };
  await writeFile(previous, JSON.stringify(info, null, 2));
  return info;
}
