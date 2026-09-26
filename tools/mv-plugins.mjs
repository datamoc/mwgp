// Selects the slice of an MV/MZ project's own plugin JavaScript that event
// scripts reach, so the player can run it (src/player/rgss-script.js, `mv`
// dialect) instead of guessing what plugin-owned names do. Nothing here names a
// game or plugin: it is name-reachability over the project's own files.
//
//   1. every enabled plugin (js/plugins.js, in load order) is indexed for the
//      names it defines: column-0 `var/let/const/function/class` names, and
//      `Class.prototype.member =` / `Class.member =` assignments;
//   2. a plugin is selected when it defines a name that appears in an event
//      script (`referenced` identifiers);
//   3. selection closes over plugins defining a top-level name the selected
//      plugins mention (bounded by `depth` and `maxBytes`).
//
// Returns { order, sources, stats } for manifest `pluginLibrary`. `order`
// keeps plugins.js load order, which the player evaluates in.
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const IDENT = /[A-Za-z_$][\w$]*/g;
const MIN_MEMBER_LENGTH = 5;

export function indexPlugin(source) {
  const top = new Set(), members = new Set();
  for (const match of source.matchAll(/^(?:var|let|const|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) top.add(match[1]);
  for (const match of source.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) top.add(match[1]);
  for (const match of source.matchAll(/\b([A-Z][\w$]*)(?:\.prototype)?\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    if (match[2].length >= MIN_MEMBER_LENGTH) members.add(match[2]);
    if (/^[A-Z]/.test(match[1]) && !match[0].includes('.prototype')) top.add(match[1]);
  }
  return { top, members };
}

// Names the engine itself (js/rpg_*.js) defines. Plugins that merely override
// or extend those are not what a script is asking for: the player has no
// engine to run them against, only names the plugins introduce matter.
async function engineNames(gameRoot) {
  const top = new Set(), members = new Set();
  const dir = join(gameRoot, 'js');
  if (!existsSync(dir)) return { top, members };
  for (const file of readdirSync(dir).filter(name => /^rpg_.*\.js$/i.test(name))) {
    const index = indexPlugin(await readFile(join(dir, file), 'utf8'));
    index.top.forEach(name => top.add(name));
    index.members.forEach(name => members.add(name));
  }
  return { top, members };
}

export async function buildPluginLibrary(gameRoot, pluginsText, scriptSources, { depth = 3, maxBytes = 40 * 1024 * 1024, log = () => {} } = {}) {
  const entries = [];
  try {
    const list = JSON.parse(pluginsText.slice(pluginsText.indexOf('['), pluginsText.lastIndexOf(']') + 1));
    for (const item of list) if (item?.name && item.status !== false) entries.push(item);
  } catch { return null; }
  const referenced = new Set();
  for (const source of scriptSources) for (const token of String(source).match(IDENT) || []) referenced.add(token);
  if (!referenced.size) return null;

  const engine = await engineNames(gameRoot);
  const plugins = [];
  for (const item of entries) {
    const path = join(gameRoot, 'js', 'plugins', `${item.name}.js`);
    if (!existsSync(path)) continue;
    const source = await readFile(path, 'utf8');
    const index = indexPlugin(source);
    for (const name of engine.top) index.top.delete(name);
    for (const name of engine.members) index.members.delete(name);
    plugins.push({ name: item.name, parameters: item.parameters || {}, description: item.description || '', source, ...index });
  }
  const selected = new Set();
  for (const plugin of plugins) {
    if ([...plugin.top].some(name => referenced.has(name)) || [...plugin.members].some(name => referenced.has(name))) selected.add(plugin.name);
  }
  const direct = selected.size;
  const definer = new Map();
  for (const plugin of plugins) for (const name of plugin.top) if (!definer.has(name)) definer.set(name, plugin.name);
  // Plugins also depend on each other through methods they add to engine classes.
  for (const plugin of plugins) for (const name of plugin.members) if (!definer.has(name)) definer.set(name, plugin.name);
  for (let round = 0; round < depth; round++) {
    const before = selected.size;
    for (const plugin of plugins.filter(entry => selected.has(entry.name))) {
      for (const token of new Set(plugin.source.match(IDENT) || [])) {
        const owner = definer.get(token);
        if (owner && !selected.has(owner)) selected.add(owner);
      }
    }
    if (selected.size === before) break;
  }
  let bytes = 0;
  const order = [], sources = {}, parameters = {}, descriptions = {};
  for (const plugin of plugins) {
    if (!selected.has(plugin.name)) continue;
    if (bytes + plugin.source.length > maxBytes) { log(`plugin library: size cap reached, skipping ${plugin.name}`); continue; }
    bytes += plugin.source.length;
    order.push(plugin.name);
    sources[plugin.name] = plugin.source;
    parameters[plugin.name] = plugin.parameters;
    descriptions[plugin.name] = plugin.description;
  }
  log(`plugin library: ${order.length}/${plugins.length} plugins (${direct} directly referenced, ${Math.round(bytes / 1024)} KiB)`);
  // The engine's own logic files (no scenes/sprites/windows): the Game_* objects the
  // plugins extend, so plugin code runs against real classes instead of stubs.
  const engineSources = {};
  const dir = join(gameRoot, 'js');
  for (const base of ['core', 'managers', 'objects']) {
    for (const prefix of ['rpg', 'rmmz']) {
      const path = join(dir, `${prefix}_${base}.js`);
      if (existsSync(path)) { engineSources[`${prefix}_${base}`] = await readFile(path, 'utf8'); break; }
    }
  }
  return { order, sources, parameters, descriptions, engine: [...engine.top].sort(), engineSources, stats: { total: plugins.length, direct, selected: order.length, bytes } };
}

// The sources are the bulk of the library (Karryn's Prison: ~14 MB of a 26 MB manifest). Written as
// files under assets/plugins and assets/engine instead, they stay out of mwgp.json (which the player
// parses whole), gzip well over the wire and sit in the browser's HTTP cache across the page reloads
// every map change causes. The manifest keeps names, parameters and a name -> file map; the player
// fetches the files at startup (player-core.js `loadPluginFiles`).
export async function externalizePluginLibrary(library, outputDir) {
  if (!library?.sources) return library;
  const safeName = (name, used) => {
    let base = String(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'plugin';
    let file = `${base}.js`;
    for (let n = 2; used.has(file); n++) file = `${base}-${n}.js`;
    used.add(file);
    return file;
  };
  const files = { plugins: {}, engine: {} };
  for (const [group, sources, folder] of [['plugins', library.sources, 'plugins'], ['engine', library.engineSources || {}, 'engine']]) {
    const directory = join(outputDir, 'assets', folder);
    await mkdir(directory, { recursive: true });
    const used = new Set();
    for (const [name, source] of Object.entries(sources)) {
      const file = safeName(name, used);
      await writeFile(join(directory, file), source);
      files[group][name] = `${folder}/${file}`;
    }
  }
  const { sources, engineSources, ...rest } = library;
  return { ...rest, files };
}
