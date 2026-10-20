// Convert every game in a source directory (e.g. RPGM_versions/) into an
// output directory (e.g. MWGP_versions/), one subfolder per game.
//
// Detection per subfolder, in order:
// - MV/MZ (`www/index.html` or `index.html`) -> tools/convert-mv.js --copy-assets: the MWGP manifest (systematic default; --web selects tools/build-web.js instead, a web build of the game's own engine and files with
//   the nw.js host layer, playable in any browser but not editable in MWGP Studio). The MWGP manifest is what
//   the MWGP player runs and the editor edits, so conversion defaults to it for every engine.
// - Extracted RGSS (`Data/*.rxdata` XP, `Data/*.rvdata` VX, `Data/*.rvdata2` Ace) -> tools/convert-rgss.js.
// - Raw RGSS (`Game.rgssa`, `Game.rgssad`, `Game.rgss2a`, `Game.rgss3a`) -> convert-rgss.js extracts its encrypted data and Ruby scripts, then converts.
// - Anything else is skipped with a reason.
//
// Games convert in parallel, one process each, at most --jobs at a time (default: the number of cores). Each game
// gets a progress bar on stderr, fed by the converters' `@@progress` lines (tools/progress.mjs); stdout stays the
// JSON summary. The summary's per-game `log` shows only that game's difficulties (the converter warnings —
// unresolved text codes, missing sheets, loud fallbacks); the informational output is kept out of it unless
// --verbose asks for the full converter log back. Explicit warning-only findings
// report "converted with warnings"; unresolved conversion difficulties remain
// "converted with errors". Both keep their details in the summary.
//
// Usage: npm run convert:auto -- <source dir> <output dir> [--skip-existing] [--jobs N] [--web] [--verbose]
import { readManifestConverterVersion, isStaleConverterVersion } from './converter-version.mjs';
import { readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { spawn } from 'node:child_process';
import { PROGRESS_PREFIX } from './progress.mjs';
import { summarizeDiagnostics } from './conversion-diagnostics.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: node tools/convert-auto.js <source dir> <output dir> [--skip-existing] [--stale] [--jobs N] [--web] [--verbose]';
const positional = [], flags = new Set();
let jobs = availableParallelism();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--jobs') {
    jobs = Number(args[++index]);
    if (!Number.isInteger(jobs) || jobs < 1) { console.error(`--jobs needs a positive integer\n${usage}`); process.exit(1); }
  } else if (arg === '--skip-existing' || arg === '--mwgp' || arg === '--web' || arg === '--stale' || arg === '--verbose') flags.add(arg);
  else if (arg.startsWith('--')) { console.error(`Unknown option ${arg}\n${usage}`); process.exit(1); }
  else positional.push(arg);
}
const [sourceArg, outputArg] = positional;
if (!sourceArg || !outputArg || positional.length > 2) { console.error(usage); process.exit(1); }
const sourceRoot = resolve(sourceArg), outputRoot = resolve(outputArg);
const skipExisting = flags.has('--skip-existing');
// --verbose: the per-game log keeps the converters' full output. Without it, only the difficulties
// (their stderr warnings - unresolved text codes, missing sheets, loud fallbacks) reach the summary.
const verbose = flags.has('--verbose');
// --stale: convert only what needs it - projects with no MWGP manifest yet or one made by an older converter (tools/converter-version.mjs);
// up-to-date manifests and web builds are left alone.
const staleOnly = flags.has('--stale');
// MWGP conversion is the systematic default (editable in MWGP Studio); --web is the opt-in exception and --mwgp an accepted no-op.
const mvAsMwgp = !flags.has('--web');
mkdirSync(outputRoot, { recursive: true });

const has2k3 = folder => existsSync(join(folder, 'RPG_RT.exe')) && existsSync(join(folder, 'RPG_RT.ldb'));
const hasRxdata = folder => existsSync(join(folder, 'Data')) &&
  readdirSync(join(folder, 'Data')).some(name => /\.(rxdata|rvdata|rvdata2)$/i.test(name));
const hasMv = folder => existsSync(join(folder, 'www', 'index.html')) || existsSync(join(folder, 'index.html'));
const hasRgssad = folder => ['Game.rgssa', 'Game.rgssad', 'Game.rgss2a', 'Game.rgss3a'].some(name => existsSync(join(folder, name)));

// ---- progress display -------------------------------------------------------------------------------------------
const games = new Map();
const interactive = Boolean(process.stderr.isTTY);
let drawnLines = 0;
const elapsed = game => {
  if (!game.startedAt) return '';
  const seconds = Math.round(((game.endedAt || Date.now()) - game.startedAt) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};
const ratio = game => (String(game.status).startsWith('converted') ? 1 : game.total > 0 ? Math.min(1, game.done / game.total) : 0);
const ICONS = { queued: '·', extracting: '…', converting: '…', converted: '✓', 'converted with warnings': '⚠', 'converted with errors': '⚠', skipped: '-', failed: '✗' };
function line(game, nameWidth, columns) {
  const barWidth = Math.max(10, Math.min(30, columns - nameWidth - 40));
  const filled = Math.round(ratio(game) * barWidth);
  const bar = game.status === 'queued' || game.status === 'skipped' ? ' '.repeat(barWidth) : '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const percent = game.status === 'queued' || game.status === 'skipped' ? '    ' : `${String(Math.round(ratio(game) * 100)).padStart(3)}%`;
  const detail = game.status === 'converting' ? game.label : game.reason ? `${game.status}: ${game.reason}` : game.status;
  // Every name takes exactly nameWidth columns (shortened with an ellipsis when longer) so the bars line up.
  const name = game.name.length > nameWidth ? `${game.name.slice(0, nameWidth - 1)}…` : game.name.padEnd(nameWidth);
  const text = `${ICONS[game.status]} ${name} ${bar} ${percent} ${elapsed(game).padStart(6)}  ${detail || ''}`;
  return text.length > columns - 1 ? `${text.slice(0, columns - 2)}…` : text;
}
function draw() {
  if (!interactive) return;
  const columns = process.stderr.columns || 100;
  // The longest name, unless that leaves too little room for the bar and its details on this terminal.
  const nameWidth = Math.max(8, Math.min(Math.max(...[...games.values()].map(game => game.name.length)), columns - 60));
  let out = drawnLines ? `\x1b[${drawnLines}F` : '';
  for (const game of games.values()) out += `\x1b[2K${line(game, nameWidth, columns)}\n`;
  process.stderr.write(out);
  drawnLines = games.size;
}
// Without a terminal (a log file, CI): one line per status change and per 10% of progress.
function report(game) {
  if (interactive) return;
  const bucket = Math.floor(ratio(game) * 10);
  const key = `${game.status}:${bucket}`;
  if (key === game.reported) return;
  game.reported = key;
  const percent = String(game.status).startsWith('converted') || game.status === 'converting' ? ` ${bucket * 10}%` : '';
  process.stderr.write(`[convert:auto] ${game.name}: ${game.status}${percent}${game.status === 'converting' && game.label ? ` (${game.label})` : ''}${game.reason ? ` - ${game.reason}` : ''} ${elapsed(game)}\n`);
}
const update = (game, changes) => { Object.assign(game, changes); report(game); };

// ---- conversion -------------------------------------------------------------------------------------------------
// Runs one tool, streaming its `@@progress` lines into the game's bar. Its stderr (warnings, crash output) is the
// difficulties the summary reports by default; its stdout (informational output) only joins the log under --verbose.
function invoke(game, tool, toolArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join('tools', tool), ...toolArgs], { cwd: process.cwd(), env: { ...process.env, MWGP_PROGRESS: '1' } });
    const full = [], issues = [];
    const stderrTail = [];
    let pending = '';
    child.stdout.on('data', chunk => full.push(String(chunk)));
    child.stderr.on('data', chunk => {
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const text of lines) {
        if (text.startsWith(PROGRESS_PREFIX)) {
          try { const { done, total, label } = JSON.parse(text.slice(PROGRESS_PREFIX.length)); update(game, { done, total, label }); } catch { /* a torn line: the next one catches up */ }
        } else { full.push(`${text}\n`); issues.push(`${text}\n`); stderrTail.push(text); if (stderrTail.length > 20) stderrTail.shift(); }
      }
    });
    child.on('error', rejectPromise);
    child.on('close', code => {
      if (pending && !pending.startsWith(PROGRESS_PREFIX)) { const tail = `${pending}\n`; full.push(tail); issues.push(tail); stderrTail.push(pending); }
      if (code === 0) resolvePromise({ full: full.join('').trim(), issues: issues.join('').trim() });
      else rejectPromise(new Error(`${tool} failed (exit ${code}): ${stderrTail.join('\n').slice(-400)}`));
    });
  });
}

const gameLog = out => (verbose ? out.full : out.issues);
// Explicit informational warnings do not count as conversion defects. Legacy
// stderr keeps its error classification so unresolved fallbacks stay loud.
const gameResult = (kind, out) => ({ ...summarizeDiagnostics(out.issues), kind, log: gameLog(out) });

async function convert(game) {
  const from = join(sourceRoot, game.name), to = join(outputRoot, game.name);
  if (staleOnly && existsSync(join(to, 'mwgp.json')) && !isStaleConverterVersion(readManifestConverterVersion(join(to, 'mwgp.json')))) return { status: 'skipped', reason: 'manifest is current' };
  if (staleOnly && !mvAsMwgp && existsSync(join(to, 'mwgp-web.json'))) return { status: 'skipped', reason: 'web build' };
  // A lone web build is not "already converted" under the MWGP default (it is not editable): only --web counts it as existing.
  if (skipExisting && (existsSync(join(to, 'mwgp.json')) || (!mvAsMwgp && existsSync(join(to, 'mwgp-web.json'))))) return { status: 'skipped', reason: 'already converted' };
  // RPG Maker 2000/2003 (T124): detected explicitly and reported as its own
  // case — the LCF reader exists (tools/lcf.mjs) but there is no chipset
  // rendering in the player yet, so writing a manifest would be a lie.
  if (has2k3(from)) return { status: 'skipped', reason: 'RPG Maker 2000/2003 (RPG_RT) detected: LCF conversion not available yet (parser foundation in tools/lcf.mjs)' };
  if (hasRxdata(from) || hasRgssad(from)) {
    update(game, { status: 'converting', label: 'starting' });
    if (!mvAsMwgp) return gameResult('web', await invoke(game, 'build-web.js', [from, to]));
    if (hasRxdata(from)) return gameResult('rgss', await invoke(game, 'convert-rgss.js', [from, to]));
    if (hasRgssad(from)) return gameResult('rgss', await invoke(game, 'convert-rgss.js', [from, to]));
  }
  if (hasMv(from)) {
    update(game, { status: 'converting', label: 'starting' });
    if (mvAsMwgp) return gameResult('mv', await invoke(game, 'convert-mv.js', [from, to, '--copy-assets']));
    return gameResult('web', await invoke(game, 'build-web.js', [from, to]));
  }
  return { status: 'skipped', reason: 'no MV index.html, Data/*.rxdata|rvdata|rvdata2, or Game.rgssa|rgssad|rgss2a|rgss3a found' };
}

// Game folders, including ones reached through a symlink or junction.
const isFolder = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const names = readdirSync(sourceRoot).filter(name => isFolder(join(sourceRoot, name)));
for (const name of names) games.set(name, { name, status: 'queued', done: 0, total: 0, label: '' });
const workers = Math.max(1, Math.min(jobs, names.length));
if (!interactive) process.stderr.write(`[convert:auto] ${names.length} game(s), ${workers} at a time\n`);
const timer = interactive ? setInterval(draw, 100) : null;
draw();
const queue = [...games.values()];
const results = new Map();
await Promise.all(Array.from({ length: workers }, async () => {
  for (let game = queue.shift(); game; game = queue.shift()) {
    update(game, { startedAt: Date.now() });
    try {
      const result = await convert(game);
      update(game, { ...result, endedAt: Date.now(), label: '' });
      results.set(game.name, { name: game.name, ...result });
    } catch (error) {
      update(game, { status: 'failed', reason: String(error.message).split('\n')[0].slice(0, 200), endedAt: Date.now() });
      results.set(game.name, { name: game.name, status: 'failed', reason: error.message });
    }
  }
}));
if (timer) clearInterval(timer);
draw();

const ordered = names.map(name => results.get(name));
const summary = {
  converted: ordered.filter(r => r.status === 'converted').length,
  withWarnings: ordered.filter(r => r.status === 'converted with warnings').length,
  withErrors: ordered.filter(r => r.status === 'converted with errors').length,
  skipped: ordered.filter(r => r.status === 'skipped').length,
  failed: ordered.filter(r => r.status === 'failed').length,
  results: ordered
};
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exit(1);
