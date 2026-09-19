#!/usr/bin/env node
// Bundle an extracted RGSS project's Ruby scripts into ONE executable JavaScript file.
//
// Unlike tools/transpile-rgss-scripts.mjs (which transpiles each script independently,
// producing one JS file per script for inspection/diagnostics), this transpiles the whole
// project as a SINGLE Ruby source in Scripts.rxdata's own load order. That is required for
// correctness, not just convenience: RGSS scripts pervasively reopen classes defined by
// earlier scripts (`class Battle; ...; end` appearing in a dozen different files, each adding
// methods to the same class), and only converting the whole program in one pass lets Ruby2JS
// see — and correctly merge — those reopens. Converted independently, the same class name
// would be redeclared once per file, which is a SyntaxError the moment two such outputs share
// a JS scope.
//
// It also applies tools/rgss-call-filter.mjs, which fixes a separate, silent correctness bug:
// RGSS code idiomatically omits parens on zero-arg calls/defs (`Graphics.update`, `def main`),
// which Ruby2JS's default heuristic reads as JS property access / a getter instead of a call.
// See that file's own header comment for the full explanation.
//
// Because it is one Ruby2JS `convert()` call over the entire project, this is all-or-nothing:
// a single unsupported construct anywhere in the bundle fails the whole build. That is a real,
// current limitation — see CLAUDE.md / the RGSS runtime notes for known gaps still to close.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { convert, parse } from '../transpilers/ruby2js-master/demo/selfhost/ruby2js.js';
import Functions from '../transpilers/ruby2js-master/demo/selfhost/filters/functions.js';
// Ruby2JS ships a filter purpose-built for this: it merges same-named module/class bodies
// into one combined declaration BEFORE conversion, so class.rb never sees a "reopened" class
// at all - the narrower, harder-to-get-right alternative (teaching the converter itself to
// detect and correctly re-merge reopening after the fact) is what tools/rgss-call-filter.mjs's
// sibling fixes upstream (see CLAUDE.md) were chasing before this was found. It is not a full
// fix on its own: a merged class body can't express "alias the CURRENT method, then redefine
// it" (RGSS's own most common hotfix idiom) the way sequential prototype assignments can,
// since JS class bodies don't execute member-by-member - a later same-named method silently
// wins, so an alias meant to capture the pre-hotfix implementation ends up aliasing the
// post-hotfix one instead. Not yet addressed; see the RGSS runtime effort memory notes.
import Combiner from '../transpilers/ruby2js-master/demo/selfhost/filters/combiner.js';
import { RgssCalls, setKnownMethods, collectDefNames } from './rgss-call-filter.mjs';

const [, , projectArg, outputArg] = process.argv;
if (!projectArg || !outputArg) {
  console.error('Usage: node tools/bundle-rgss-scripts.mjs <extracted RGSS project> <output.js>');
  process.exit(1);
}

const project = resolve(projectArg);
const output = resolve(outputArg);

function decodeScripts(file) {
  const result = spawnSync('ruby', ['tools/read-rgss-scripts.rb', file], {
    cwd: resolve('.'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || `Ruby exited with ${result.status}`);
  return result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
}

const containers = ['Scripts.rxdata', 'PluginScripts.rxdata'];
const scripts = [];
for (const fileName of containers) {
  const file = join(project, 'Data', fileName);
  let entries;
  try { await readFile(file); entries = decodeScripts(file); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const entry of entries) {
    scripts.push({ name: entry.name || `script-${entry.id}`, source: Buffer.from(entry.source, 'base64').toString('utf8') });
  }
}

const combined = scripts.map(s => `# ==== ${s.name} ====\n${s.source}`).join('\n\n');
console.log(`Bundling ${scripts.length} scripts (${combined.length} bytes) from ${basename(project)}...`);

console.time('parse');
const [ast] = parse(combined, project);
console.timeEnd('parse');

setKnownMethods(collectDefNames(ast));

console.time('convert');
const js = convert(combined, {
  preset: true, eslevel: 2022, loose_break: true,
  // Real (#-syntax) private fields must be lexically declared inside the class body that
  // uses them; RGSS reopens classes constantly, and a reopened method is compiled as a
  // `ClassName.prototype.foo = function(){...}` assignment outside that lexical body, so any
  // @ivar reference inside it can't legally use `#ivar`. Underscored (`this._ivar`) fields
  // sidestep the restriction entirely - this codebase has no use for true JS privacy anyway.
  underscored_private: true,
  filters: [Functions.prototype, Combiner.prototype, RgssCalls.prototype],
  file: project
}).toString();
console.timeEnd('convert');

new Function(js); // throws SyntaxError with a location if the output is not valid JS

await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, `${js}\n`);
console.log(`Wrote ${output} (${js.length} bytes)`);
