// Build the slice of a game's own Ruby library (Data/Scripts.rxdata) that its event
// scripts actually reach, as independently-loadable JS units.
//
// Event scripts call game-defined helpers (`def give_gold`, `class Shop`, the
// game's Interpreter methods, ...). Transpiling the whole library in one Ruby2JS
// call is what the bundling effort (tools/bundle-rgss-scripts.mjs) attempted and it
// does not scale, so this works the other way round and needs no knowledge of any
// particular game:
//
// 1. Each script is parsed on its own and every *top-level definition* is recorded
//    with its source byte-range: `def name` -> unit `name`, `class|module X` (all
//    reopenings across scripts) -> unit `X`, `X = ...` -> unit `X`.
// 2. Starting from the names the event snippets reference, a breadth-first closure
//    over definitions' own references picks the reachable units (to `maxDepth`;
//    anything beyond the horizon becomes a run-time stub that warns).
// 3. Each reachable unit is transpiled ALONE (reopenings merged by Ruby2JS's Combiner
//    filter). A unit that will not convert is dropped and reported, so one exotic
//    construct costs one unit, not the whole library. Cross-unit references stay
//    free identifiers that the player resolves lazily (src/player/rgss-script.js).
//
// Event scripts run as bodies of the game's Interpreter methods, so bare calls to
// Interpreter methods in snippets are rewritten to `this.<name>()`; the interpreter
// class is `Game_Interpreter` (VX/Ace) or `Interpreter` (XP), whichever the game defines.
import { convert, parse, Filter } from '../transpilers/ruby2js-master/demo/selfhost/ruby2js.js';
import Functions from '../transpilers/ruby2js-master/demo/selfhost/filters/functions.js';
import Combiner from '../transpilers/ruby2js-master/demo/selfhost/filters/combiner.js';
import Return from '../transpilers/ruby2js-master/demo/selfhost/filters/return.js';
import { RgssCalls, setKnownMethods, collectDefNames } from './rgss-call-filter.mjs';

// `def`s inside these are callable bare from anywhere (Ruby's global functions), so they
// are indexed as top-level defs: `module Kernel; def pbMessage ... end; end`.
const GLOBAL_SCOPES = ['Kernel', 'Object'];
const INTERPRETER_CLASSES = ['Game_Interpreter', 'Interpreter'];
// RGSS's own class names for the objects the player's built-in globals stand in for
// ($game_map, $game_player, ...). Methods the shim lacks are borrowed from these classes at
// run time (see openObject in rgss-script.js), so they ship whenever the game defines them.
// They join the library without being expanded, keeping the closure bounded.
const ENGINE_CLASSES = ['Game_Map', 'Game_Player', 'Game_Event', 'Game_Character', 'Game_Party', 'Game_Temp', 'Game_System', 'Game_Screen'];

const isNode = value => value && typeof value === 'object' && 'type' in value && 'children' in value;
const constRoot = node => { while (node.children[0]?.type === 'const') node = node.children[0]; return String(node.children[1]); };
const bodyOf = node => !node ? [] : node.type === 'begin' ? node.children : [node];

// Names a piece of Ruby refers to that a library unit could define: receiver-less
// method calls and the root of every constant path.
export function referencedNames(ast, out = { sends: new Set(), consts: new Set() }) {
  if (!isNode(ast)) return out;
  if (ast.type === 'send' && ast.children[0] == null) out.sends.add(String(ast.children[1]));
  if (ast.type === 'const') out.consts.add(constRoot(ast));
  for (const child of ast.children) referencedNames(child, out);
  return out;
}

// Rewrites receiver-less calls to the given method names into `this.<name>(...)`.
export function selfCallsFilter(names) {
  return class SelfCalls extends Filter.Processor {
    on_send(node) {
      const [receiver, method, ...args] = node.children;
      if (receiver == null && names.has(String(method))) {
        // `call` forces a method call even without parens (see rgss-call-filter.mjs).
        return this.process_children(node.updated(args.length ? 'send' : 'call', [this.s('self'), method, ...args]));
      }
      return this.process_children(node);
    }
  };
}

export function indexScripts(scripts, log = () => {}) {
  const units = new Map(); // name -> { kind, pieces: [{ script, text }], sends, consts, methods }
  const allDefNames = new Set();
  for (const script of scripts) {
    let ast;
    try { [ast] = parse(script.source, script.name); }
    catch (error) { log(`index: skipping "${script.name}" (${String(error.message).split('\n')[0].slice(0, 80)})`); continue; }
    collectDefNames(ast, allDefNames);
    const bytes = Buffer.from(script.source, 'utf8');
    const record = (name, kind, node, methods = new Set()) => {
      const location = node.location ?? node.loc;
      const text = bytes.subarray(location._start_offset, location._end_offset).toString('utf8');
      const unit = units.get(name) || { name, kind, pieces: [], sends: new Set(), consts: new Set(), methods: new Set() };
      unit.pieces.push({ script: script.name, text });
      const refs = referencedNames(node);
      refs.sends.forEach(n => unit.sends.add(n));
      refs.consts.forEach(n => unit.consts.add(n));
      methods.forEach(n => unit.methods.add(n));
      units.set(name, unit);
    };
    for (const node of bodyOf(ast)) {
      if ((node.type === 'module' || node.type === 'class') && GLOBAL_SCOPES.includes(constRoot(node.children[0])) && node.children[0].children[0] == null) {
        for (const member of bodyOf(node.children[node.type === 'class' ? 2 : 1])) if (member.type === 'def') record(String(member.children[0]), 'def', member);
        continue;
      }
      let name, kind;
      if (node.type === 'def') { name = String(node.children[0]); kind = 'def'; }
      else if (node.type === 'class' || node.type === 'module') { name = constRoot(node.children[0]); kind = 'const'; }
      else if (node.type === 'casgn' && !node.children[0]) { name = String(node.children[1]); kind = 'const'; }
      else continue;
      // Instance methods of a plain (non-nested-path) class: bare calls to them inside
      // the class are calls on `this`.
      const methods = new Set();
      if (node.type === 'class' && node.children[0].children[0] == null) {
        for (const member of bodyOf(node.children[2])) if (member.type === 'def') methods.add(String(member.children[0]));
      }
      record(name, kind, node, methods);
    }
  }
  const interpreter = INTERPRETER_CLASSES.find(name => units.get(name)?.kind === 'const' && units.get(name).methods.size) || null;
  return { units, allDefNames, interpreter, interpreterMethods: interpreter ? units.get(interpreter).methods : new Set() };
}

// Names event snippets reach: units they reference directly, plus the interpreter
// class whenever they call one of its methods.
export function snippetRoots(index, snippets) {
  const roots = new Set();
  for (const ruby of snippets) {
    let ast;
    try { [ast] = parse(ruby, 'snippet'); } catch { continue; }
    const { sends, consts } = referencedNames(ast);
    for (const name of sends) {
      if (index.units.get(name)?.kind === 'def') roots.add(name);
      if (index.interpreterMethods.has(name)) roots.add(index.interpreter);
    }
    for (const name of consts) if (index.units.has(name)) roots.add(name);
  }
  return roots;
}

export function closure(index, roots, maxDepth) {
  const depth = new Map([...roots].map(name => [name, 0]));
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift(), d = depth.get(name);
    if (d >= maxDepth) continue;
    const unit = index.units.get(name);
    for (const next of [...unit.sends, ...unit.consts]) {
      if (!index.units.has(next) || depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  return depth;
}

export function transpileUnit(unit) {
  const source = unit.pieces.map(piece => `# ---- ${piece.script} ----\n${piece.text}`).join('\n\n');
  // Filter order matters: RgssCalls ends a node's chain, so anything that must see a call
  // (SelfCalls) goes before it. Return adds Ruby's implicit `return` of the last expression.
  const filters = [Functions.prototype, Return.prototype, Combiner.prototype];
  if (unit.methods.size) filters.push(selfCallsFilter(unit.methods).prototype);
  filters.push(RgssCalls.prototype);
  const js = convert(source, { preset: true, eslevel: 2022, loose_break: true, underscored_private: true, filters }).toString();
  new Function(js); // a SyntaxError here means the unit is unusable
  return js;
}

// snippets: array of Ruby sources. Returns the manifest's `rubyLibrary` section.
export async function buildRgssLibrary(scripts, snippets, { maxDepth = 3, log = console.log, index = null } = {}) {
  if (!index) { log(`library: indexing ${scripts.length} scripts`); index = indexScripts(scripts, log); }
  setKnownMethods(index.allDefNames);
  const roots = snippetRoots(index, snippets);
  const depths = closure(index, roots, maxDepth);
  for (const name of ENGINE_CLASSES) if (index.units.has(name) && !depths.has(name)) depths.set(name, maxDepth);
  log(`library: ${index.units.size} units, ${roots.size} referenced by event scripts, ${depths.size} within depth ${maxDepth}`);
  // `methods`: every name the game defines with `def`. Ruby2JS compiles a paren-less zero-arg
  // call on such a name as a call, on any other name as a property read, so the player's
  // built-in objects must expose exactly those names as functions (see rgss-script.js).
  const out = { interpreter: index.interpreter, interpreterMethods: [...index.interpreterMethods], methods: [...index.allDefNames].map(String), units: {}, failed: {} };
  let done = 0;
  for (const [name] of depths) {
    // Ruby2JS drops `?`/`!` from method names, so units are keyed by their JS name.
    try { out.units[name.replace(/[?!]$/, '')] = transpileUnit(index.units.get(name)); }
    catch (error) { out.failed[name] = String(error?.message || error).split('\n')[0].slice(0, 160); }
    if (++done % 25 === 0) log(`library: ${done}/${depths.size} units (${Object.keys(out.failed).length} failed)`);
  }
  log(`library: ${Object.keys(out.units).length} units transpiled, ${Object.keys(out.failed).length} failed`);
  return out;
}
