#!/usr/bin/env node
// Shim-coverage report for the Ruby runtime: which RGSS classes and methods a converted XP/VX/Ace
// project's transpiled Ruby actually uses, checked against (a) the real runtime's API surface
// (tools/rgss-api-dump.mjs) and (b) what the browser shim (src/player/rgss-script.js) implements.
// It turns "the Ruby runtime is incomplete" into a ranked missing-method list.
//
//   node tools/rgss-coverage.mjs <mwgp.json> [--api api.json] [--out report.md|report.json] [--top 25]
//
// What is measured, all from the manifest's transpiled JavaScript (event scripts, conditions and the
// reachable slice of the game's own library, `rubyLibrary.units`):
//   * static uses `Class.member` of API classes (Graphics.update, Input.trigger, Audio.se_play, ...),
//     split into methods and constants;
//   * `new Class(...)` instantiations (Bitmap, Sprite, Window, ...);
//   * instance calls `.name(...)` whose name is an RGSS method and is NOT a method the game defines
//     itself; the receiver class cannot be known statically, so these are attributed to every API
//     class that has the method (an upper bound; the ranking is what matters);
//   * Kernel-level functions (load_data, rgss_main, ...);
//   * API classes the game re-opens with its own `class Bitmap; def ...` units.
// Ruby2JS drops `?` and `!` from names, so comparison ignores those suffixes and setters (`x=`).
// Ruby core (String#gsub, Array#each_with_index, ...) is Ruby2JS's job, not the RGSS runtime's, and
// is not part of this report.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const normalize = name => String(name).replace(/[?!=]$/, '');
// Names that are also everyday Ruby core methods (File.exist?, Object#freeze, IO.open, ...): a call
// named like this says nothing about an RGSS receiver, so instance-call attribution skips them.
const CORE_AMBIGUOUS = new Set(['freeze', 'open', 'exist', 'name', 'size', 'set', 'clear', 'stop', 'play', 'color', 'font', 'index', 'children', 'delete_at', 'include']);

function collectSources(project) {
  const sources = [];
  for (const [name, js] of Object.entries(project.rubyLibrary?.units || {})) if (typeof js === 'string') sources.push({ label: `unit ${name}`, js, unit: name });
  const walk = (node, label) => {
    if (Array.isArray(node)) { for (const item of node) walk(item, label); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.js === 'string') sources.push({ label, js: node.js });
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, label);
  };
  for (const map of project.maps || []) for (const event of map.mwgEvents || []) walk(event.pages, `map ${map.id} event ${event.id ?? event.name}`);
  for (const [id, commands] of Object.entries(project.commonEvents || {})) walk(commands, `common event ${id}`);
  return sources;
}

function bump(table, key, label) {
  const entry = table.get(key) || { count: 0, where: new Set() };
  entry.count++;
  if (entry.where.size < 3) entry.where.add(label);
  table.set(key, entry);
}

export function analyze(project, api, shim) {
  const apiClasses = new Set(Object.keys(api.classes));
  const memberIndex = new Map();     // normalized member -> Set(classes) for instance-call attribution
  for (const [className, entry] of Object.entries(api.classes)) for (const method of entry.methods) {
    const key = normalize(method);
    if (!memberIndex.has(key)) memberIndex.set(key, new Set());
    memberIndex.get(key).add(className);
  }
  const gameMethods = new Set((project.rubyLibrary?.methods || []).map(normalize));
  const statics = new Map(), instantiations = new Map(), instances = new Map(), kernel = new Map();
  const kernelNames = Object.keys(api.kernel || {}).filter(name => /^[a-z_]/.test(name));
  const kernelPattern = kernelNames.length ? new RegExp(`(?<![\\w$.])(${kernelNames.join('|')})\\s*\\(`, 'g') : null;
  const reopened = Object.keys(project.rubyLibrary?.units || {}).filter(name => apiClasses.has(name));

  for (const { label, js } of collectSources(project)) {
    for (const match of js.matchAll(/(?<![\w$.])([A-Z][A-Za-z0-9]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (apiClasses.has(match[1])) bump(statics, `${match[1]}.${match[2]}`, label);
    }
    for (const match of js.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*)\b/g)) if (apiClasses.has(match[1])) bump(instantiations, match[1], label);
    for (const match of js.matchAll(/\.\s*([a-z_][A-Za-z0-9_]*)\s*(?:\(|=(?!=))/g)) {
      const name = match[1];
      if (memberIndex.has(name) && !gameMethods.has(name) && !CORE_AMBIGUOUS.has(name)) bump(instances, name, label);
    }
    if (kernelPattern) for (const match of js.matchAll(kernelPattern)) if (!gameMethods.has(match[1])) bump(kernel, match[1], label);
  }

  const shimMembers = className => new Set((shim?.builtins?.[className]?.members || []).map(normalize));
  const classReport = {};
  for (const [key, entry] of statics) {
    const [className, member] = key.split('.');
    const isConstant = /^[A-Z]/.test(member);
    const apiEntry = api.classes[className];
    const inApi = isConstant ? apiEntry.constants.includes(member) || apiEntry.constants.length === 0 || /^[A-Z][A-Z0-9_]*$/.test(member) : apiEntry.methods.some(method => normalize(method) === normalize(member));
    const inShim = shim?.builtins?.[className] && shimMembers(className).has(normalize(member));
    const report = classReport[className] ||= { references: 0, distinct: 0, members: [] };
    report.references += entry.count;
    report.distinct++;
    // A member the runtime lacks but the game's own Ruby defines (`class Color; def self.black`) is game code, not shim work.
    const gameDefined = !inApi && gameMethods.has(normalize(member));
    report.members.push({ member, kind: isConstant ? 'constant' : 'method', count: entry.count, inApi, gameDefined, inShim: Boolean(inShim), where: [...entry.where] });
  }
  for (const report of Object.values(classReport)) report.members.sort((left, right) => right.count - left.count);

  const instanceReport = [...instances].map(([name, entry]) => ({ name, count: entry.count, classes: [...memberIndex.get(name)], where: [...entry.where] })).sort((left, right) => right.count - left.count);
  const shimClasses = new Set(Object.keys(shim?.builtins || {}));
  const classSummary = Object.entries(api.classes).map(([className, entry]) => ({
    className, apiMethods: entry.methods.length,
    shimmed: shimClasses.has(className), shimMembers: shimClasses.has(className) ? shimMembers(className).size : 0,
    staticUses: classReport[className]?.references || 0, instantiations: instantiations.get(className)?.count || 0, reopened: reopened.includes(className)
  })).sort((left, right) => (right.staticUses + right.instantiations) - (left.staticUses + left.instantiations));

  const missing = [];
  for (const [className, report] of Object.entries(classReport)) for (const member of report.members) if (!member.inShim && !member.gameDefined) missing.push({ className, ...member });
  missing.sort((left, right) => right.count - left.count);
  return {
    classes: classSummary, statics: classReport, missing, instanceCalls: instanceReport,
    kernel: [...kernel].map(([name, entry]) => ({ name, count: entry.count, shimmed: Boolean(shim?.builtins?.[name] || shim?.fallbacks?.includes(name)), where: [...entry.where] })).sort((left, right) => right.count - left.count),
    reopened, totals: { sources: collectSources(project).length, staticReferences: [...statics.values()].reduce((sum, entry) => sum + entry.count, 0), instantiations: [...instantiations.values()].reduce((sum, entry) => sum + entry.count, 0) }
  };
}

export function renderMarkdown(result, meta) {
  const top = meta.top;
  const lines = [];
  lines.push(`# RGSS shim coverage — ${meta.project}`, '', '_Generated by `npm run rgss:coverage`; see `tools/rgss-coverage.mjs` for what is measured._', '');
  lines.push(`Runtime API surface: \`${meta.apiSource}\` (${Object.keys(meta.api.classes).length} classes, ${meta.api.summary?.methods ?? '?'} methods). Shim: \`src/player/rgss-script.js\` (${meta.shimDialect}).`);
  lines.push(`Scanned ${result.totals.sources} transpiled Ruby sources: ${result.totals.staticReferences} static \`Class.member\` uses and ${result.totals.instantiations} \`new Class\` instantiations.`, '');
  lines.push('## API classes by use', '', '| Class | API methods | Static uses | `new` | Shim has it | Shim members | Reopened by game |', '|---|---:|---:|---:|:-:|---:|:-:|');
  for (const entry of result.classes) lines.push(`| ${entry.className} | ${entry.apiMethods} | ${entry.staticUses} | ${entry.instantiations} | ${entry.shimmed ? 'yes' : '**no**'} | ${entry.shimMembers} | ${entry.reopened ? 'yes' : ''} |`);
  lines.push('', `## Missing from the shim, by use (static \`Class.member\`, top ${top})`, '', '| Class.member | Kind | Uses | In real runtime | Example |', '|---|---|---:|:-:|---|');
  for (const entry of result.missing.slice(0, top)) lines.push(`| ${entry.className}.${entry.member} | ${entry.kind} | ${entry.count} | ${entry.inApi ? 'yes' : 'no'} | ${entry.where[0] || ''} |`);
  lines.push('', `## Instance calls that hit RGSS methods (top ${top})`, '',
    'Receivers are not typed after transpilation, so a name is attributed to every API class that defines it (upper bound); names the game defines itself are excluded.', '',
    '| Method | Calls | Defined by |', '|---|---:|---|');
  for (const entry of result.instanceCalls.slice(0, top)) lines.push(`| ${entry.name} | ${entry.count} | ${entry.classes.join(', ')} |`);
  lines.push('', '## Kernel-level functions', '', '| Function | Calls | Shim |', '|---|---:|:-:|');
  for (const entry of result.kernel) lines.push(`| ${entry.name} | ${entry.count} | ${entry.shimmed ? 'yes' : '**no**'} |`);
  if (result.reopened.length) lines.push('', `## API classes re-opened by the game's own Ruby`, '', result.reopened.map(name => `\`${name}\``).join(', '), '', 'These carry game-defined methods on top of the runtime\'s, so they are transpiled units, not shim work.');
  const unimplemented = result.classes.filter(entry => !entry.shimmed && (entry.staticUses + entry.instantiations) > 0);
  lines.push('', '## Reading this', '', `- ${unimplemented.length} API class(es) are used but have no shim object at all: ${unimplemented.map(entry => entry.className).join(', ') || 'none'}. Every method on them runs into the loud "not implemented" stub.`,
    '- "In real runtime: no" means the game references a member the runtime binary does not bind and that the game\'s own Ruby does not define either: a Ruby core method (`Marshal.load`), a typo, or something the string dump could not attribute. Members the game defines itself on a re-opened class are excluded from the missing list.',
    '- The API list comes from plain-text strings of the runtime binary and can list a few attribute names a class does not truly bind, so it over-approximates "exists"; it never hides a real method.');
  return lines.join('\n') + '\n';
}

async function main() {
  const [, , projectPath, ...flags] = process.argv;
  if (!projectPath) { console.error('Usage: node tools/rgss-coverage.mjs <mwgp.json> [--api api.json] [--out report.md|.json] [--top 25] [--name label]'); process.exit(1); }
  const value = name => (flags.indexOf(name) >= 0 ? flags[flags.indexOf(name) + 1] : null);
  const apiPath = value('--api') || join(here, '..', 'docs', 'rgss-api-xp.json');
  if (!existsSync(apiPath)) { console.error(`No API surface at ${apiPath}: run tools/rgss-api-dump.mjs <Game.exe> --out ${apiPath} first, or pass --api`); process.exit(1); }
  const api = JSON.parse(readFileSync(apiPath, 'utf8'));
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  if (!project.rubyLibrary && !(project.maps || []).some(map => JSON.stringify(map.mwgEvents || []).includes('"js"'))) console.warn('NOTE: this manifest carries no transpiled Ruby (not an XP/VX/Ace conversion?); the report will be empty');
  const { createRgssRuntime } = await import(pathToFileURL(join(here, '..', 'src', 'player', 'rgss-script.js')).href);
  const shim = createRgssRuntime({ rpgExtra: { items: {}, party: [], gold: 0, weapons: {}, armors: {} }, project: {} }, { mapId: 1, mapEvents: [], dialect: 'rgss', library: project.rubyLibrary || null }).introspect();
  const result = analyze(project, api, shim);
  const top = Number(value('--top') || 25);
  const meta = { project: value('--name') || project.source?.projectName || projectPath, api, apiSource: api.source || apiPath, shimDialect: shim.dialect, top };
  const out = value('--out');
  const text = out?.endsWith('.json') ? JSON.stringify({ meta: { project: meta.project, apiSource: meta.apiSource }, ...result }, null, 2) : renderMarkdown(result, meta);
  if (out) { writeFileSync(out, text); console.log(`wrote ${out}`); } else process.stdout.write(text);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
