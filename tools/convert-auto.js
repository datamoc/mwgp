// Convert every game in a source directory (e.g. RPGM_versions/) into an
// output directory (e.g. MWGP_versions/), one subfolder per game.
//
// Detection per subfolder, in order:
// - MV/MZ (`www/index.html` or `index.html`) -> tools/convert-mv.js with
//   --copy-assets, so the output plays without RPG Maker and without the
//   original folder.
// - Extracted RGSS (`Data/*.rxdata`) -> tools/convert-rgss.js.
// - Raw RGSS (`Game.rgssad`) -> extracted to a temp dir, then convert-rgss.js.
// - Anything else is skipped with a reason.
//
// Usage: npm run convert:auto -- <source dir> <output dir> [--skip-existing]
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [sourceArg, outputArg, ...flags] = process.argv.slice(2);
if (!sourceArg || !outputArg || flags.some(flag => !['--skip-existing'].includes(flag))) {
  console.error('Usage: node tools/convert-auto.js <source dir> <output dir> [--skip-existing]');
  process.exit(1);
}
const sourceRoot = resolve(sourceArg), outputRoot = resolve(outputArg);
const skipExisting = flags.includes('--skip-existing');
mkdirSync(outputRoot, { recursive: true });

const hasRxdata = folder => existsSync(join(folder, 'Data')) &&
  readdirSync(join(folder, 'Data')).some(name => /\.rxdata$/i.test(name));
const hasMv = folder => existsSync(join(folder, 'www', 'index.html')) || existsSync(join(folder, 'index.html'));
const hasRgssad = folder => existsSync(join(folder, 'Game.rgssad'));

async function convert(name) {
  const from = join(sourceRoot, name), to = join(outputRoot, name);
  if (skipExisting && existsSync(join(to, 'mwgp.json'))) return { name, status: 'skipped', reason: 'mwgp.json already present' };
  const invoke = async (tool, args) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [join('tools', tool), ...args], { cwd: process.cwd() });
      return (stdout + stderr).trim();
    } catch (error) {
      throw new Error(`${tool} failed: ${String(error.stderr || error.message).slice(0, 400)}`);
    }
  };
  if (hasRxdata(from)) {
    const log = await invoke('convert-rgss.js', [from, to]);
    return { name, status: 'converted', kind: 'rgss', log };
  }
  if (hasMv(from)) {
    const log = await invoke('convert-mv.js', [from, to, '--copy-assets']);
    return { name, status: 'converted', kind: 'mv', log };
  }
  if (hasRgssad(from)) {
    const extracted = join(tmpdir(), `mwgp-extract-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await invoke('extract-rgssad.js', [join(from, 'Game.rgssad'), extracted]);
    try {
      const log = await invoke('convert-rgss.js', [extracted, to]);
      return { name, status: 'converted', kind: 'rgss', log };
    } finally {
      await run(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(extracted)}, { recursive: true, force: true })`]).catch(() => {});
    }
  }
  return { name, status: 'skipped', reason: 'no MV index.html, Data/*.rxdata, or Game.rgssad found' };
}

const entries = readdirSync(sourceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const results = [];
for (const name of entries) {
  try {
    results.push(await convert(name));
  } catch (error) {
    results.push({ name, status: 'failed', reason: error.message });
  }
}
const summary = {
  converted: results.filter(r => r.status === 'converted').length,
  skipped: results.filter(r => r.status === 'skipped').length,
  failed: results.filter(r => r.status === 'failed').length,
  results
};
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exit(1);
