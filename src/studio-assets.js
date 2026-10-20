// Converted resource edits keep their bytes independently of converter output.
// The playable assets/ tree is materialized, so static exports work too.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Script } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const digest = data => createHash('sha256').update(data).digest('hex');
const statePath = folder => join(folder, '.mwgp-studio-assets.json');
const fileRecord = (state, path) => Object.hasOwn(state.files, path) ? state.files[path] : null;
const textExtensions = new Set(['.js', '.json', '.txt', '.csv', '.xml', '.ini', '.css', '.rb', '.md', '.fnt']);
export const isTextAsset = path => textExtensions.has(extname(path).toLowerCase());

async function optionalRead(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function stateOf(folder) {
  const bytes = await optionalRead(statePath(folder));
  return bytes ? JSON.parse(bytes) : { version: 1, revision: 0, files: {} };
}
export async function protectedStudioAssets(folder) {
  return Object.keys((await stateOf(folder)).files);
}
export async function studioAssetRevision(folder) {
  return (await stateOf(folder)).revision;
}
async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}
async function saveState(folder, state) {
  await atomicWrite(statePath(folder), JSON.stringify(state));
}

// A lock names its holder's pid (written just after creation; an empty lock older than two minutes
// is one whose holder died before writing it, or a pre-pid leftover). A killed conversion used to
// lock its project out of every Studio route and re-conversion forever - a dead holder is taken over.
async function lockIsStale(path) {
  let pid = 0, age = 0;
  try {
    age = Date.now() - (await stat(path)).mtimeMs;
    pid = Number((await readFile(path, 'utf8')).trim()) || 0;
  } catch { return false; }
  if (!pid) return age > 120000;
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
async function withAssetLock(folder, operation) {
  const path = join(folder, '.mwgp-assets.lock');
  const deadline = Date.now() + 30000;
  let handle;
  while (!handle) {
    try { handle = await open(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await lockIsStale(path)) { console.warn(`MWGP Studio: taking over the lock left by a dead process: ${path}`); await rm(path); continue; }
      if (Date.now() >= deadline) {
        const holder = await readFile(path, 'utf8').catch(() => '');
        throw new Error(`Studio resource operation still locked${Number(holder) ? ` by live process ${holder}` : ''}: ${path}`);
      }
      await delay(50);
    }
  }
  try { await handle.write(String(process.pid)); return await operation(); }
  finally { await handle.close(); await rm(path); }
}
// Whether a live process holds the asset lock right now (a dead holder's lock is stale, never busy).
export async function assetLockBusy(folder) {
  const path = join(folder, '.mwgp-assets.lock');
  try { await stat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return !(await lockIsStale(path));
}

// Validate both the lexical path and its filesystem destination: a game's
// symlink must not turn an asset replacement into a write outside assets/.
export async function resolveStudioAsset(folder, path = '', allowMissing = false) {
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.includes(':') ||
      path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid resource path');
  const project = await realpath(folder);
  const root = await realpath(join(folder, 'assets'));
  if (!root.startsWith(project + sep)) throw new Error('Resource root escapes the project');
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Invalid resource path');
  let actual;
  try { actual = await realpath(target); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    actual = join(await realpath(dirname(target)), target.slice(dirname(target).length + 1));
  }
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Resource path escapes assets');
  return actual;
}

async function blobPath(folder, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid resource hash');
  const project = await realpath(folder), store = join(folder, '.mwgp-studio-assets');
  await mkdir(store, { recursive: true });
  if (!(await realpath(store)).startsWith(project + sep)) throw new Error('Resource store escapes the project');
  const directory = join(store, 'blobs');
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (!actual.startsWith(project + sep)) throw new Error('Resource store escapes the project');
  const file = join(actual, hash);
  try {
    if (!(await realpath(file)).startsWith(actual + sep)) throw new Error('Resource snapshot escapes the store');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
async function keepBytes(folder, bytes) {
  if (bytes === null) return null;
  const hash = digest(bytes);
  await atomicWrite(await blobPath(folder, hash), bytes);
  return hash;
}

export async function listStudioAssets(folder, prefix = '') {
  let directory;
  try { directory = await resolveStudioAsset(folder, prefix); }
  catch (error) { if (!prefix && error.code === 'ENOENT') return { revision: 0, prefix, entries: [] }; throw error; }
  const state = await stateOf(folder);
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const tracked = fileRecord(state, path);
    entries.push({ name: entry.name, path, directory: entry.isDirectory(), text: isTextAsset(path),
      ...(tracked ? { protected: true, ...tracked, divergent: tracked.editedHash !== tracked.freshHash } : {}) });
  }
  return { revision: state.revision, prefix, entries: entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
}

export async function readStudioAsset(folder, path, version = 'edited') {
  const target = await resolveStudioAsset(folder, path, true);
  if (!['base', 'edited', 'fresh'].includes(version)) throw new Error('Invalid resource version');
  const state = await stateOf(folder), tracked = fileRecord(state, path);
  const hash = tracked?.[`${version}Hash`];
  if (tracked) {
    if (!hash) return null;
    return readFile(await blobPath(folder, hash));
  }
  return optionalRead(target);
}

export async function saveStudioAsset(folder, path, bytes) {
  return withAssetLock(folder, async () => {
    const target = await resolveStudioAsset(folder, path);
    if (!(await stat(target)).isFile()) throw new Error('Select a resource file');
    if (extname(path).toLowerCase() === '.json') JSON.parse(bytes.toString('utf8'));
    if (extname(path).toLowerCase() === '.js') new Script(bytes.toString('utf8'), { filename: path });
    const state = await stateOf(folder);
    if (!fileRecord(state, path)) {
      const original = await readFile(target);
      const baseHash = await keepBytes(folder, original);
      state.files = { ...state.files, [path]: { baseHash, freshHash: baseHash } };
    }
    const editedHash = await keepBytes(folder, bytes);
    state.files[path].editedHash = editedHash;
    state.revision++;
    await saveState(folder, state);
    await atomicWrite(target, bytes);
    // Audio's persistent decoded cache must distinguish two editor versions.
    const manifestFile = join(folder, 'mwgp.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.assets = { ...manifest.assets, revision: state.revision };
    await atomicWrite(manifestFile, JSON.stringify(manifest));
    return { revision: state.revision, path, protected: true, ...state.files[path] };
  });
}

export async function createConversionOutput(folder) {
  await mkdir(folder, { recursive: true });
  // A killed conversion leaves its staging tree inside the project forever. Sweep stale siblings
  // under the asset lock first (a live holder's staging is young and stays; a dead one's lock is
  // taken over) so crash-recovery never piles litter onto a playable folder.
  try {
    await withAssetLock(folder, async () => {
      for (const name of await readdir(folder)) {
        if (!name.startsWith('.mwgp-conversion-')) continue;
        const leftover = join(folder, name);
        try { if (Date.now() - (await stat(leftover)).mtimeMs > 120000) await rm(leftover, { recursive: true, force: true }); }
        catch { /* a sibling that vanished mid-sweep is nobody's problem */ }
      }
    });
  } catch (error) { console.warn(`MWGP Studio: could not sweep old conversion staging in ${folder}: ${error.message}`); }
  return mkdtemp(join(folder, '.mwgp-conversion-'));
}

async function ensureAssetParent(folder, path) {
  const project = await realpath(folder), root = join(folder, 'assets');
  await mkdir(root, { recursive: true });
  const actualRoot = await realpath(root);
  if (!actualRoot.startsWith(project + sep)) throw new Error('Resource root escapes the project');
  let parent = actualRoot;
  for (const part of path.split('/').slice(0, -1)) {
    if (!part || part === '.' || part === '..') throw new Error('Invalid conversion resource path');
    parent = join(parent, part);
    await mkdir(parent, { recursive: true });
    if (!(await realpath(parent)).startsWith(actualRoot + sep)) throw new Error('Resource parent escapes assets');
  }
}

// Convert into a separate tree first. This records the real new source bytes,
// including deletion and source/edition convergence, without touching edits.
export async function publishConvertedAssets(folder, working) {
  const stage = resolve(working), project = resolve(folder);
  if (dirname(stage) !== project || !relative(project, stage).startsWith('.mwgp-conversion-')) throw new Error('Invalid conversion staging path');
  return withAssetLock(folder, async () => {
    const state = await stateOf(folder), seen = new Set();
    async function publish(directory, prefix = '') {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      // Empty decoded categories still belong to a valid exported asset tree.
      await ensureAssetParent(folder, prefix ? `${prefix}/.directory` : '.directory');
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const file = join(directory, entry.name);
        if (entry.isDirectory()) { await publish(file, path); continue; }
        if (!entry.isFile()) throw new Error(`Conversion produced a non-file resource: ${path}`);
        seen.add(path);
        const target = join(folder, 'assets', path);
        await ensureAssetParent(folder, path);
        await resolveStudioAsset(folder, path, true);
        const tracked = fileRecord(state, path);
        if (tracked) {
          tracked.freshHash = await keepBytes(folder, await readFile(file));
          await atomicWrite(target, await readFile(await blobPath(folder, tracked.editedHash)));
        } else await rename(file, target);
      }
    }
    await publish(join(working, 'assets'));
    for (const [path, tracked] of Object.entries(state.files)) if (!seen.has(path)) {
      tracked.freshHash = null;
      const target = join(folder, 'assets', path);
      await ensureAssetParent(folder, path);
      await resolveStudioAsset(folder, path, true);
      await atomicWrite(target, await readFile(await blobPath(folder, tracked.editedHash)));
    }
    if (state.revision) await saveState(folder, state);
    // working is created inside the explicit output folder; verify that exact
    // boundary before removing the successful conversion's temporary tree.
    if (dirname(stage) !== project || !relative(project, stage).startsWith('.mwgp-conversion-')) throw new Error('Invalid conversion staging path');
    await rm(stage, { recursive: true });
    return state.revision;
  });
}
