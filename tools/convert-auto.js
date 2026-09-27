// Convert every game in a source directory (e.g. RPGM_versions/) into an
// output directory (e.g. MWGP_versions/), one subfolder per game.
//
// Detection per subfolder, in order:
// - MV/MZ (`www/index.html` or `index.html`) -> tools/convert-mv.js with
//   --copy-assets, so the output plays without RPG Maker and without the
//   original folder.
// - Extracted RGSS (`Data/*.rxdata` XP, `Data/*.rvdata` VX, `Data/*.rvdata2` Ace) -> tools/convert-rgss.js.
// - Raw RGSS (`Game.rgssad`, `Game.rgss3a`) -> extracted to a temp dir, then convert-rgss.js.
// - Anything else is skipped with a reason.
//
// Usage: npm run convert:auto -- <source dir> <output dir> [--skip-existing]
import { readdirSync, existsSync, mkdirSync, cpSync } from 'node:fs';
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
  readdirSync(join(folder, 'Data')).some(name => /\.(rxdata|rvdata|rvdata2)$/i.test(name));
const hasMv = folder => existsSync(join(folder, 'www', 'index.html')) || existsSync(join(folder, 'index.html'));
const hasRgssad = folder => existsSync(join(folder, 'Game.rgssad')) || existsSync(join(folder, 'Game.rgss3a'));

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
    const archive = existsSync(join(from, 'Game.rgssad')) ? 'Game.rgssad' : 'Game.rgss3a';
    await invoke('extract-rgssad.js', [join(from, archive), extracted]);
    try {
      // Essentials projects commonly keep Audio/ beside Game.rgssad instead of
      // inside the archive. Preserve it in the temporary extracted project so
      // convert-rgss can expose it to the browser player.
      if (existsSync(join(from, 'Audio'))) {
        cpSync(join(from, 'Audio'), join(extracted, 'Audio'), { recursive: true, force: true });
      }
      // Loose folders the game reads at run time next to the archive (bitmap fonts and their descriptors).
      for (const folder of ['Fonts']) if (existsSync(join(from, folder)) && !existsSync(join(extracted, folder))) cpSync(join(from, folder), join(extracted, folder), { recursive: true, force: true });
      // A project's own SoundFont (Essentials ships soundfont.sf2 beside the executable) plays its MIDI.
      for (const file of readdirSync(from).filter(name => /\.sf2$/i.test(name))) cpSync(join(from, file), join(extracted, file), { force: true });
      const log = await invoke('convert-rgss.js', [extracted, to]);
      return { name, status: 'converted', kind: 'rgss', log };
    } finally {
      await run(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(extracted)}, { recursive: true, force: true })`]).catch(() => {});
    }
  }
  return { name, status: 'skipped', reason: 'no MV index.html, Data/*.rxdata|rvdata|rvdata2, or Game.rgssad|rgss3a found' };
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
