#!/usr/bin/env node
// Dumps the RGSS class/method surface a Windows RGSS runtime binary exposes, from its plain-text
// strings only (no disassembly or decompilation), for tools/rgss-coverage.mjs to compare against
// what the transpiled Ruby calls and what the browser shim implements.
//
//   node tools/rgss-api-dump.mjs <Game.exe | RGSS*.dll | mkxp binary> [--out api.json]
//
// How it works. RGSS classes are bound to Ruby by calling `define_class("Bitmap")` followed by
// `define_method(klass, "blt", ...)` for each method, and compilers lay the string literals out in
// source order, so the binding tables read as runs of `ClassName method method method ...` in the
// binary's string pool. The dump walks the pool, opens a segment at each class-like name that is
// followed by a run of method-like names, and closes it at the first string that is not an
// identifier (error text, format strings). UPPER_CASE strings between segments are the previous
// class's constants (Input::DOWN, ...). Method lists can contain a few attribute names the bindings
// reuse (`children`, `color`), so membership answers "plausibly defined", never "certainly missing".
// The embedded Ruby prelude (`module RPG ... attr_accessor`) is parsed for the RPG data classes.
//
// Not every runtime exposes names: the stock Enterbrain RGSS*.dll keeps them in a packed image, and
// some rebuilds pack theirs (Pokemon Void's RGSS104E.dll has none; its Game.exe, a Ruby 3.1 MKXP-style
// host, has them all). The tool says so and produces an empty surface rather than guessing.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*[?!=]?$/;
const CLASS_NAME = /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/;       // CamelCase, has a lowercase letter
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]{1,}$/;
const OPERATOR_NAME = /^(?:===?|=~|<=>|!=|\[\]=?|<<|>>|\*\*|[+\-*\/%<>&|^~!]|[+\-]@|<=|>=)$/;
const METHOD_NAME = { test: text => /^[a-z_][A-Za-z0-9_]*[?!=]?$/.test(text) || OPERATOR_NAME.test(text) };
// The classes every RGSS runtime binds; the segment of the string pool around them is the API region.
const ANCHOR_CLASSES = new Set(['Bitmap', 'Sprite', 'Graphics', 'Input', 'Window', 'Tilemap', 'Audio', 'Viewport', 'Plane', 'Color', 'Rect', 'Tone', 'Table', 'Font']);
// Names seen in bindings that are not classes (ObjectSpace is a Ruby core module the bindings poke).
const NOT_CLASSES = new Set(['ObjectSpace', 'Kernel', 'Object', 'Comparable', 'Enumerable', 'String', 'Array', 'Hash', 'Integer', 'Float', 'Symbol', 'Proc', 'Exception', 'Struct']);

export function extractStrings(bytes, minimum = 2) {
  const strings = [];
  let start = -1;
  for (let index = 0; index <= bytes.length; index++) {
    const byte = index < bytes.length ? bytes[index] : 0;
    if (byte >= 32 && byte < 127 || byte === 10 || byte === 13 || byte === 9) { if (start < 0) start = index; continue; }
    if (start >= 0 && index - start >= minimum && byte === 0) strings.push(Buffer.from(bytes.subarray(start, index)).toString('latin1'));
    start = -1;
  }
  return strings;
}

export function parseBindings(strings) {
  const classes = {};
  const order = [];
  let current = null;
  for (let index = 0; index < strings.length; index++) {
    const text = strings[index];
    if (CLASS_NAME.test(text) && !NOT_CLASSES.has(text)) {
      // A class header needs method-like names right after it (allowing one more header, e.g. "Font Bitmap dispose ...").
      let run = 0;
      for (let next = index + 1; next < Math.min(strings.length, index + 12) && METHOD_NAME.test(strings[next]); next++) run++;
      const nextIsHeader = CLASS_NAME.test(strings[index + 1] || '') && !NOT_CLASSES.has(strings[index + 1]);
      if (run >= 3 || nextIsHeader || (ANCHOR_CLASSES.has(text) && run >= 1)) {
        current = classes[text] ||= { methods: [], constants: [], at: index };
        if (!order.includes(text)) order.push(text);
        let position = index + 1;
        while (position < strings.length && METHOD_NAME.test(strings[position])) { if (!current.methods.includes(strings[position])) current.methods.push(strings[position]); position++; }
        while (position < strings.length && CONSTANT_NAME.test(strings[position])) { if (!current.constants.includes(strings[position])) current.constants.push(strings[position]); position++; }
        index = position - 1;
        continue;
      }
    }
    if (current && CONSTANT_NAME.test(text) && index > 0 && CONSTANT_NAME.test(strings[index - 1] || text)) { if (!current.constants.includes(text)) current.constants.push(text); }
  }
  // Drop headers that never gained methods (e.g. "Font" as a bare separator before "Bitmap").
  for (const name of Object.keys(classes)) if (!classes[name].methods.length && !ANCHOR_CLASSES.has(name)) delete classes[name];
  // Keep only the API region: a game executable's string pool also holds OpenSSL, DirectSound, font
  // and libc names that look like classes. The region spans the anchor classes plus a margin.
  const anchors = Object.entries(classes).filter(([name]) => ANCHOR_CLASSES.has(name)).map(([, entry]) => entry.at);
  if (anchors.length >= 3) {
    const low = Math.min(...anchors) - 400, high = Math.max(...anchors) + 900;
    for (const name of Object.keys(classes)) if (classes[name].at < low || classes[name].at > high) delete classes[name];
  }
  for (const entry of Object.values(classes)) delete entry.at;
  return classes;
}

// `module RPG` ... `class Map` ... `attr_accessor :foo` from the runtime's embedded Ruby prelude.
export function parseRpgPrelude(strings) {
  const source = strings.find(text => /\bmodule RPG\b/.test(text) && /attr_accessor/.test(text));
  if (!source) return {};
  const classes = {};
  const stack = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^(\s*)(class|module)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (match) {
      const depth = match[1].length;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ depth, name: match[3] });
      const path = stack.map(entry => entry.name).join('::');
      classes[path] ||= { attributes: [] };
      continue;
    }
    // A line indented at or below a class header's own column is outside that class.
    const indent = /^(\s*)\S/.exec(line)?.[1].length;
    if (indent !== undefined) while (stack.length && stack[stack.length - 1].depth >= indent) stack.pop();
    const attribute = /^\s*attr_(?:accessor|reader|writer)\s+:([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (attribute && stack.length) { const path = stack.map(entry => entry.name).join('::'); if (!classes[path].attributes.includes(attribute[1])) classes[path].attributes.push(attribute[1]); }
  }
  return classes;
}

// Kernel-level functions games call directly.
// RGSS's own additions to Kernel (Ruby core functions like sprintf/raise/loop are Ruby2JS's concern).
const KERNEL_CANDIDATES = ['load_data', 'save_data', 'rgss_main', 'rgss_stop', 'msgbox', 'msgbox_p', 'print', 'p'];

export function dumpApi(bytes, name = 'binary') {
  const strings = extractStrings(bytes);
  const classes = parseBindings(strings);
  const has = word => strings.some(text => text === word);
  const kernel = Object.fromEntries(KERNEL_CANDIDATES.map(word => [word, has(word)]));
  const rpg = parseRpgPrelude(strings);
  const exportsList = strings.filter(text => /^RGSS[A-Z][A-Za-z]*$/.test(text));
  const methodCount = Object.values(classes).reduce((sum, entry) => sum + entry.methods.length, 0);
  const notes = [];
  if (!Object.keys(classes).length) notes.push('no RGSS class names found in the strings: the binary is probably packed or keeps its API elsewhere (try the game executable instead of the RGSS DLL)');
  return { source: basename(name), sha256: createHash('sha256').update(bytes).digest('hex'), provenance: 'class and method NAMES read from the binary\'s plain-text strings (no disassembly); a fact list about the API, no code or assets', stringCount: strings.length, classes, rpg, kernel, exports: exportsList, summary: { classes: Object.keys(classes).length, methods: methodCount, rpgClasses: Object.keys(rpg).length }, notes };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('rgss-api-dump.mjs')) {
  const [, , input, ...flags] = process.argv;
  if (!input) { console.error('Usage: node tools/rgss-api-dump.mjs <Game.exe | RGSS*.dll> [--out api.json]'); process.exit(1); }
  const api = dumpApi(readFileSync(input), input);
  const outIndex = flags.indexOf('--out');
  if (outIndex >= 0) writeFileSync(flags[outIndex + 1], JSON.stringify(api, null, 2));
  console.log(`${api.source}: ${api.summary.classes} classes, ${api.summary.methods} methods, ${api.summary.rpgClasses} RPG:: classes (of ${api.stringCount} strings)`);
  for (const [className, entry] of Object.entries(api.classes)) console.log(`  ${className}: ${entry.methods.length} methods${entry.constants.length ? `, ${entry.constants.length} constants` : ''}`);
  for (const note of api.notes) console.warn(`NOTE: ${note}`);
  if (outIndex < 0 && !api.notes.length) console.log('(pass --out api.json to save the full surface)');
}
