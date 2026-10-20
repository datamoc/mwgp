// Selects the slice of an MV/MZ project's own plugin JavaScript that event
// scripts reach, so the player can run it (src/player/rgss-script.js, `mv`
// dialect) instead of guessing what plugin-owned names do. Nothing here names a
// game or plugin: it is name-reachability over the project's own files.
//
//   1. every enabled plugin (js/plugins.js, in load order) is indexed for the
//      names it defines: column-0 `var/let/const/function/class` names, and
//      `Class.prototype.member =` / `Class.member =` assignments;
//   2. a plugin is selected when it defines a name that appears in an event
//      script (`referenced` identifiers), when it handles a plugin-command word
//      the events use (MV 356: it hooks the command dispatch and names the word
//      as a whole token anywhere in its source, which covers words its code
//      builds at run time since plugins document their commands in their
//      `@help` header), or when it is the plugin an MZ 357 command names;
//   3. selection closes over plugins defining a top-level name the selected
//      plugins mention (bounded by `depth` and `maxBytes`).
//
// Returns { order, sources, stats } for manifest `pluginLibrary`. `order`
// keeps plugins.js load order, which the player evaluates in. The library also
// carries `commandReach` (word -> plugin -> the display classes the plugin's own
// command dispatch touches), which the compatibility report uses to tell a plugin
// command that runs fully here from one whose effect lands on the display layer
// the player never runs (tools/plugin-reach.mjs).
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatchReach } from './plugin-reach.mjs';

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

// A plugin that hooks the engine's plugin-command dispatch can handle command words (through any alias of
// Game_Interpreter, e.g. `var _GI = Game_Interpreter; _GI.prototype.pluginCommand = ...`).
const HOOKS_COMMANDS = /\.prototype\.pluginCommand\s*=(?!=)|\bPluginManager\.registerCommand\s*\(/;
// The title screen is part of a game's visible surface too: a plugin that
// decorates Scene_Title (background/foreground/command sprites) ships even
// when no event ever reaches it, so the player can run it at title time.
const HOOKS_TITLE = /\bScene_Title\.prototype\.\w+\s*=(?!=)/;
// A plugin that re-orders or filters the item and skill lists wraps the list builders (`makeItemList`); the player runs
// those hooks over its own menu and battle lists (rgss-script.js `listHook`), so such a plugin ships even when no event
// reaches it.
const HOOKS_LISTS = /\bWindow_(?:Item|Skill)List\.prototype\.makeItemList\s*=(?!=)/;
// Game_Player methods the map's encounter rules may ask the game for (map-engine.js): a plugin that overrides one
// ships even when no event reaches it, and the library records which methods it overrides (`mapHooks`).
const MAP_HOOK_METHODS = ['canEncounter', 'encounterProgressValue', 'makeEncounterCount', 'makeEncounterTroopId'];
const HOOKS_MAP = new RegExp(`\\.prototype\\.(?:${MAP_HOOK_METHODS.join('|')})\\s*=(?!=)`);
export function mapHookNames(source) {
  return MAP_HOOK_METHODS.filter(name => new RegExp(`\\.prototype\\.${name}\\s*=(?!=)`).test(source));
}
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionsWord = (source, word) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(word)}(?![A-Za-z0-9_$])`, 'i').test(source);

export async function buildPluginLibrary(gameRoot, pluginsText, scriptSources, { commandWords = [], commandPlugins = [], depth = 3, maxBytes = 40 * 1024 * 1024, log = () => {} } = {}) {
  const entries = [];
  try {
    const list = JSON.parse(pluginsText.slice(pluginsText.indexOf('['), pluginsText.lastIndexOf(']') + 1));
    for (const item of list) if (item?.name && item.status !== false) entries.push(item);
  } catch { return null; }
  const referenced = new Set();
  for (const source of scriptSources) for (const token of String(source).match(IDENT) || []) referenced.add(token);
  const words = new Set([...commandWords].map(String).filter(Boolean));
  const namedPlugins = new Set([...commandPlugins].map(String).filter(Boolean));
  // (The empty-library bail lives below, once plugin sources are read: a
  // title-only plugin is a reason to ship a library on its own.)

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
  const handles = new Map();
  for (const plugin of plugins) {
    if ([...plugin.top].some(name => referenced.has(name)) || [...plugin.members].some(name => referenced.has(name))) selected.add(plugin.name);
    if (namedPlugins.has(plugin.name)) selected.add(plugin.name);
    if (HOOKS_TITLE.test(plugin.source) || HOOKS_LISTS.test(plugin.source) || HOOKS_MAP.test(plugin.source)) selected.add(plugin.name);
    if (!words.size || !HOOKS_COMMANDS.test(plugin.source)) continue;
    const handled = [...words].filter(word => mentionsWord(plugin.source, word));
    if (handled.length) { selected.add(plugin.name); handles.set(plugin.name, handled); }
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
  const mapHooks = new Set();
  for (const plugin of plugins) {
    if (!selected.has(plugin.name)) continue;
    if (bytes + plugin.source.length > maxBytes) { log(`plugin library: size cap reached, skipping ${plugin.name}`); continue; }
    bytes += plugin.source.length;
    order.push(plugin.name);
    sources[plugin.name] = plugin.source;
    parameters[plugin.name] = plugin.parameters;
    descriptions[plugin.name] = plugin.description;
    for (const name of mapHookNames(plugin.source)) mapHooks.add(name);
  }
  log(`plugin library: ${order.length}/${plugins.length} plugins (${direct} directly referenced, ${Math.round(bytes / 1024)} KiB)`);
  // Which shipped plugin handles which plugin-command word (lowercased key), for the compatibility report.
  const commandHandlers = {};
  for (const [name, handled] of handles) {
    if (!order.includes(name)) continue;
    for (const word of handled) {
      const list = commandHandlers[word.toLowerCase()] ||= [];
      if (!list.includes(name)) list.push(name);
    }
  }
  // What each shipped plugin's own command dispatch reaches (tools/plugin-reach.mjs):
  // word -> plugin -> the display classes (windows, scenes, sprites) its command code
  // touches. An MV pluginCommand override answers every word the plugin handles, an MZ
  // PluginManager.registerCommand answers its own. A word a handler answers but whose
  // dispatch the probe could not read has no entry: the compatibility report treats that
  // as reaching (partial), which is the conservative side.
  const commandReach = {};
  for (const name of order) {
    const reach = dispatchReach(sources[name]);
    if (!reach) continue;
    for (const entry of reach) {
      const words = entry.word === null ? (handles.get(name) || []) : [entry.word];
      for (const word of words) {
        const bucket = commandReach[word.toLowerCase()] ||= {};
        if (!bucket[name]) bucket[name] = entry.reaches;
      }
    }
  }
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
  return { order, sources, parameters, descriptions, mapHooks: [...mapHooks].sort(), engine: [...engine.top].sort(), engineSources, commandHandlers, commandReach, stats: { total: plugins.length, direct, selected: order.length, bytes } };
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
