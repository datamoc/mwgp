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
import * as acorn from 'acorn';
import { RgssCalls, setKnownMethods, addKnownMethods, setSelfMethods, collectDefNames, collectAttrNames } from './rgss-call-filter.mjs';
import { resolveInitializeAliases } from './rgss-initialize-alias.mjs';
import { repairCallAssignments } from './rgss-repair.mjs';

// `def`s inside these are callable bare from anywhere (Ruby's global functions), so they
// are indexed as top-level defs: `module Kernel; def pbMessage ... end; end`.
const GLOBAL_SCOPES = ['Kernel', 'Object'];
const INTERPRETER_CLASSES = ['Game_Interpreter', 'Interpreter'];
// RGSS's own class names for the objects the player's built-in globals stand in for
// ($game_map, $game_player, ...). Methods the shim lacks are borrowed from these classes at
// run time (see openObject in rgss-script.js), so they ship whenever the game defines them.
// They join the library without being expanded, keeping the closure bounded.
const ENGINE_CLASSES = ['Game_Map', 'Game_Player', 'Game_Event', 'Game_Character', 'Game_Party', 'Game_Temp', 'Game_System', 'Game_Screen', 'Game_Picture'];
const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

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

// A top-level `Const.register(:id) { ... }` block whose body uses the save-data DSL becomes the Ruby constant
// `BootValue_<id> = { ensure_class: :X, save_value: -> { ... }, load_value: ->(value) { ... }, new_game_value: -> { ... } }`.
function bootRegistration(node, bytes) {
  if (node.type !== 'block') return null;
  const call = node.children[0];
  if (call?.type !== 'send' || call.children[0]?.type !== 'const' || String(call.children[1]) !== 'register') return null;
  const idNode = call.children[2];
  if (idNode?.type !== 'sym' && idNode?.type !== 'str') return null;
  const id = String(idNode.children[0]).replace(/[^A-Za-z0-9_]/g, '_');
  const slice = n => { const l = n.location ?? n.loc; return bytes.subarray(l._start_offset, l._end_offset).toString('utf8'); };
  const entries = [];
  for (const statement of bodyOf(node.children[2])) {
    if (statement.type === 'send' && statement.children[0] == null) {
      const [, method, ...args] = statement.children;
      if (String(method) === 'ensure_class' && args[0]) entries.push(`ensure_class: ${slice(args[0])}`);
      else if (args.length === 0) entries.push(`${method}: true`);
    } else if (statement.type === 'block' && statement.children[0]?.type === 'send' && statement.children[0].children[0] == null) {
      const method = String(statement.children[0].children[1]);
      const params = statement.children[1]?.children?.map(child => String(child.children[0])).filter(Boolean) ?? [];
      const body = statement.children[2] ? slice(statement.children[2]) : 'nil';
      entries.push(`${method}: ->${params.length ? `(${params.join(', ')})` : ''} { ${body} }`);
    }
  }
  if (!entries.length) return null;
  return { id, name: `BootValue_${id}`, node, text: `BootValue_${id} = { ${entries.join(', ')} }` };
}

// A top-level registration on a handler registry (`MenuHandlers.add(:pause_menu, :pokedex, {...})`,
// `ItemHandlers::UseOnPokemon.add(...)`, `GameData::TerrainTag.register(...)`, `MultipleForms.register(...)`): plain arguments (hashes of procs), no DSL. Kept as
// an ordered "boot statement" so the registries are filled when the game starts, as they are when Ruby loads the scripts.
const constPath = node => (node?.type === 'const' ? `${node.children[0] ? `${constPath(node.children[0])}::` : ''}${node.children[1]}` : null);
function bootStatement(node, bytes, typeConsts = null) {
  const call = node.type === 'block' ? node.children[0] : node;
  if (call?.type !== 'send') return null;
  const receiver = constPath(call.children[0]);
  if (!receiver || !['add', 'addIf', 'register', 'registerIf', 'copy'].includes(String(call.children[1]))) return null;
  if (!receiver.endsWith('Handlers') && !receiver.startsWith('GameData::') && !(typeConsts?.has(receiver) || typeConsts?.has(receiver.split('::')[0]))) return null;
  const location = node.location ?? node.loc;
  return { text: bytes.subarray(location._start_offset, location._end_offset).toString('utf8') };
}

export function indexScripts(scripts, log = () => {}) {
  const bootNames = [];
  const bootStatementNames = [];
  const units = new Map(); // name -> { kind, pieces: [{ script, text }], sends, consts, methods }
  const allDefNames = new Set();
  const typeConsts = new Set(); // every class/module const the game defines (not proc-holding casgn consts)
  for (const script of scripts) {
    let ast;
    try { [ast] = parse(script.source, script.name); }
    catch (error) { log(`index: skipping "${script.name}" (${String(error.message).split('\n')[0].slice(0, 80)})`); continue; }
    collectDefNames(ast, allDefNames);
    collectAttrNames(ast, allDefNames);
    const bytes = Buffer.from(script.source, 'utf8');
    const record = (name, kind, node, methods = new Set(), replacement = null) => {
      const location = node.location ?? node.loc;
      const text = replacement ?? bytes.subarray(location._start_offset, location._end_offset).toString('utf8');
      const unit = units.get(name) || { name, kind, pieces: [], sends: new Set(), consts: new Set(), methods: new Set() };
      unit.pieces.push({ script: script.name, text });
      const refs = referencedNames(node);
      refs.sends.forEach(n => unit.sends.add(n));
      refs.consts.forEach(n => unit.consts.add(n));
      methods.forEach(n => unit.methods.add(n));
      units.set(name, unit);
    };
    for (const node of bodyOf(ast)) {
      if ((node.type === 'class' || node.type === 'module') && constPath(node.children[0])) typeConsts.add(constPath(node.children[0]));
      // `SaveData.register(:player) do save_value { ... }; load_value { |v| ... }; new_game_value { ... } end`: a save-data
      // registration written in Ruby's instance_eval DSL, which Ruby2JS cannot express. Kept as a "boot" unit: a hash of
      // lambdas the runtime applies at startup (see `bootState` in rgss-script.js).
      // The save-data DSL matcher goes first: a `SaveData.register(...) do ... end`
      // block also matches the registry-statement shape below (a `register`
      // send on a game module), but only the DSL form rebuilds the value.
      const boot = bootRegistration(node, bytes);
      if (boot) { record(boot.name, 'const', boot.node, new Set(), boot.text); boot.id && bootNames.push(boot.name); continue; }
      const statement = bootStatement(node, bytes, typeConsts);
      if (statement) { const name = `BootStatement_${bootStatementNames.length}`; record(name, 'const', node, new Set(), statement.text); bootStatementNames.push(name); continue; }
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
        for (const member of bodyOf(node.children[2])) {
          if (member.type === 'def') methods.add(String(member.children[0]));
          else if (member.type === 'send' && (member.children[1] === 'attr_reader' || member.children[1] === 'attr_accessor')) {
            for (const arg of member.children.slice(2)) {
              if (arg?.type === 'sym' && typeof arg.children[0] === 'string') methods.add(arg.children[0]);
            }
          }
        }
      }
      record(name, kind, node, methods);
    }
  }
  const interpreter = INTERPRETER_CLASSES.find(name => units.get(name)?.kind === 'const' && units.get(name).methods.size) || null;
  return { units, allDefNames, typeConsts, bootNames, bootStatementNames, interpreter, interpreterMethods: interpreter ? units.get(interpreter).methods : new Set() };
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

// Ruby's `nil.to_s` is "" but Ruby2JS emits `x.toString()`, which throws on
// null/undefined. Rewrite plain receiver chains to a nil-safe form.
export const nilSafeToString = js => js.replace(/(?<![\w$.)\]])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.toString\(\)/g, 'String($1 ?? "")');

// Names the game defines as instance methods but never as top-level functions: a receiver-less call to one of them inside a
// class body is a call on `self` even when the method is inherited (`refresh` in a Window subclass).
let methodOnlyNames = new Set();
export function setMethodOnlyNames(names) { methodOnlyNames = new Set(names || []); }

// The Functions filter lowers `rec.respond_to?("lit")` (or `:sym`) to
// `"lit" in rec`, which throws when rec is a primitive. Ruby's respond_to? is
// total, so route literal checks through the nil-safe `__respond_to`
// runtime helper. The receiver is found by scanning back over identifier
// runs, member dots, balanced brackets and string literals; anything else
// (operators, statement starts) ends it, and an empty receiver is left alone.
// A leading `&.` is dropped: the helper is nil-safe, so the guard is implied.
export function rewriteLiteralRespondTo(source) {
  const pattern = /\.respond_to\?\s*\(\s*(?::(\w+)|"((?:[^"\\]|\\.)*)")\s*\)/g;
  let out = '';
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const end = match.index;
    let j = end - 1;
    if (source[j] === '&') j--;
    const closers = { ')': '(', ']': '[', '}': '{' };
    const skipString = () => {
      const quote = source[j];
      j--;
      while (j >= 0 && (source[j] !== quote || source[j - 1] === '\\')) j--;
      return j >= 0;
    };
    let ok = true;
    while (j >= 0) {
      const char = source[j];
      // No `!`: a leading negation (`!owner.respond_to?`) ends the receiver
      // and stays outside the helper; a trailing `!`/`?` is a method suffix.
      if (/[\w$@?]/.test(char) || char === '.' || ((char === '!' || char === '?') && j === end - 2)) { j--; continue; }
      if (char === '"' || char === "'") { if (!skipString()) { ok = false; break; } j--; continue; }
      if (char === ')' || char === ']' || char === '}') {
        const opener = closers[char];
        let depth = 1;
        j--;
        while (j >= 0 && depth) {
          const inner = source[j];
          if (inner === '"' || inner === "'") { if (!skipString()) break; }
          else if (inner === char) depth++;
          else if (inner === opener) depth--;
          j--;
        }
        if (depth) { ok = false; break; }
        continue;
      }
      break;
    }
    let rec = source.slice(j + 1, end);
    // Safe navigation (`y&.respond_to?`): the `&` stays out; the helper is
    // nil-safe, so the guard is implied.
    if (rec.startsWith('&')) rec = rec.slice(1);
    if (rec.endsWith('&')) rec = rec.slice(0, -1);
    if (!ok || !rec || rec.endsWith('.') || /[^\w$@?!.[\](){}'",: ]/.test(rec)) continue;
    out += source.slice(last, j + 1) + `__respond_to(${rec}, "${match[1] ?? match[2]}")`;
    last = pattern.lastIndex;
  }
  return out + source.slice(last);
}

// A patch script redefining a helper (`def pbExclaim` twice across pieces) reaches
// JS as duplicate top-level `function NAME` declarations. Bare they validate, but
// the runtime compiles units inside `with (scope)`, where the duplicate throws and
// the whole unit fails to load. Ruby's last definition wins, so earlier ones are
// dropped (hoisting already made the last one the visible binding everywhere).
function dropShadowedFunctions(js) {
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const seen = new Map();
  const shadowed = [];
  for (const node of ast.body) {
    if (node.type !== 'FunctionDeclaration' || !node.id) continue;
    if (seen.has(node.id.name)) shadowed.push(seen.get(node.id.name));
    seen.set(node.id.name, node);
  }
  let out = js;
  for (const node of shadowed.sort((a, b) => b.start - a.start)) out = out.slice(0, node.start) + out.slice(node.end);
  return out;
}

export function transpileUnit(unit) {
  let source = unit.pieces.map(piece => `# ---- ${piece.script} ----\n${piece.text}`).join('\n\n');
  const resolvedAliases = resolveInitializeAliases(source);
  source = resolvedAliases.source;
  if (resolvedAliases.methods.size) addKnownMethods(resolvedAliases.methods);
  if (resolvedAliases.methods.size) unit = { ...unit, methods: new Set([...(unit.methods || []), ...resolvedAliases.methods]) };
  // Ruby's Exception is represented by JavaScript's Error. Ruby2JS emits a
  // duplicate constructor when a class explicitly inherits from its special
  // Exception shim, so normalize that inheritance before conversion. This is
  // semantics-preserving for the browser bridge and keeps custom exception
  // classes constructible.
  source = source.replace(/(class\s+[A-Za-z_]\w*\s*<\s*)Exception\b/g, '$1Error');
  // A bare Hash as the final expression of a Ruby method is occasionally
  // emitted by Ruby2JS as a JavaScript block (`{ key: value }`) instead of a
  // returned object. Mark the unambiguous immediate hash-body form explicitly.
  source = source.replace(/(\bdef\s+[^\n]+\n\s*)\{(?=\s*[A-Za-z_$][\w$]*\s*:)/g, '$1return {');
  // Ruby supports parallel assignment to attribute expressions, but the
  // transpiler can emit an invalid destructuring target (`[obj.x = , ...]`).
  // Expand the common two-value attribute swap before conversion.
  source = source.replace(/([@A-Za-z_$][\w$\[\].]*\.index)\s*,\s*([@A-Za-z_$][\w$\[\].]*\.index)\s*=\s*([@A-Za-z_$][\w$\[\].]*\.index)\s*,\s*([@A-Za-z_$][\w$\[\].]*\.index)/g,
    '__mwgp_swap_index = $3; $1 = $4; $2 = __mwgp_swap_index');
  // Safe-navigation assignment (`object&.property = value`) has no direct
  // JavaScript assignment form. A missing optional UI object is equivalent to
  // a no-op in the portable renderer, so use an ordinary assignment and let
  // the existing object shims provide the value when present. The `=` must be
  // a lone assignment: comparisons (`==`, `!=`, `<=`, `>=`) and hash rockets
  // (`=>`) share its first character and must not match.
  source = source.replace(/([^\s=]+)&\.(\w+)\s*(?<![=!<>])=(?![=>])\s*([^\n]+)/g, '$1.$2 = $3');
  // Ruby2JS lowers a receiver-less respond_to?(:foo) to `"foo" in `, which is
  // invalid JavaScript. In RGSS library code this idiom means “is the optional
  // helper available in the current script scope”; defined?(foo) has the same
  // useful meaning for the player shim and is handled by the transpiler.
  source = source.replace(/respond_to\?\s*\(\s*:(\w+)\s*\)/g, 'defined?($1)');
  // The same filter lowers `rec.respond_to?("lit")` to `"lit" in rec`, which
  // throws when rec is a primitive (a species id string reaching a registry
  // `[]`). Ruby's respond_to? is total, so literal checks go through a
  // nil-safe runtime helper instead; dynamic names already stay calls.
  source = rewriteLiteralRespondTo(source);
  // `attr_reader`/`attr_accessor` declare zero-argument readers that Ruby2JS
  // emits as getters, while every paren-less use compiles to a call (RgssCalls
  // forces the call form for any name the game defines): `s.type()` against
  // `get type()` throws. Expand readers to plain `def`s so definitions agree
  // with call sites; accessor writers keep an explicit setter each, and the
  // existing method/setter reconciliation covers the pair. Only the simple
  // space-separated `:sym` line form is expanded (the whole Void corpus);
  // anything else stays native, exactly as today.
  source = source.replace(/^([ \t]*)attr_(reader|accessor)[ \t]+((?::[A-Za-z_$][\w$]*[ \t]*,?[ \t]*)+?)([ \t]*(?:#[^\n]*)?)\r?$/gm,
    (line, indent, kind, names, comment) => {
      if (/,\s*$/.test(names)) return line;
      const defs = [];
      for (const raw of names.split(',')) {
        const name = raw.trim().replace(/^:/, '');
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) return line;
        defs.push(`${indent}def ${name}\n${indent}  @${name}\n${indent}end`);
        if (kind === 'accessor') defs.push(`${indent}def ${name}=(__value)\n${indent}  @${name} = __value\n${indent}end`);
      }
      return defs.join('\n') + (comment ? ` ${comment.trim()}` : '');
    });
  // Filter order matters: RgssCalls ends a node's chain, so anything that must see a call
  // (SelfCalls) goes before it. Return adds Ruby's implicit `return` of the last expression.
  const filters = [Functions.prototype, Return.prototype, Combiner.prototype];
  // Inherited instance methods are only assumed inside classes with instance methods of their own (not modules).
  setSelfMethods(unit.kind === 'const' && unit.methods.size ? new Set([...unit.methods, ...methodOnlyNames]) : unit.methods);
  filters.push(RgssCalls.prototype);
  // `x.name += 1` compiles to `x.name() += 1` (an assignment to a call): repaired here, so the syntax check below does not
  // send the unit down the "no call heuristic" fallback, which would turn every zero-argument call in it into a property read.
  let js = dropShadowedFunctions(repairCallAssignments(nilSafeToString(convert(source, { preset: true, eslevel: 2022, loose_break: true, underscored_private: true, filters }).toString())));
  // Ruby methods with an implicit block parameter are emitted by Ruby2JS as
  // `get each(_implicitBlockYield)`, which is invalid JavaScript: accessors
  // cannot declare parameters. Such methods are called with a block and must
  // remain ordinary methods; zero-argument Ruby readers keep their getter
  // form and therefore retain the existing property semantics.
  js = js.replace(/\bget\s+([A-Za-z_$][\w$]*)\s*\(([^()]+)\)\s*\{/g, '$1($2) {');
  // Ruby's `super` inside an []= method is lowered as `super.[]=(...)` by
  // Ruby2JS; call the inherited bracket-assignment method by its quoted JS
  // name (a `super(...)` call is only legal inside a constructor).
  js = js.replace(/super\.\[\]=\(([^()]*)\)/g, 'super["[]="]($1)');
  // Ruby2JS's destructuring lowering for simple parallel attribute assignment
  // leaves empty assignment slots. Expand those slots into two ordinary
  // assignments before syntax validation.
  js = js.replace(/\[([^\[\],]+)\s*=\s*,\s*([^\[\],]+)\s*=\s*\]\s*=\s*\[\s*([^\[\],]+)\s*,\s*([^\[\],]+)\s*\]/g,
    '$1 = $3; $2 = $4');
  // Ruby's splatted return expression is emitted with an extra spread before
  // the callee (`return ...foo(...)`), which is not valid JavaScript. The
  // callee still receives its own spread arguments, so only the return-level
  // marker is removed.
  js = js.replace(/\breturn\s+\.\.\./g, 'return ');
  // Ruby constants may be assigned in a later script while earlier class-body
  // expressions already read them. Ruby loads the whole script set before
  // those expressions are used; a single JS IIFE otherwise hits the temporal
  // dead zone. Hoist literal ALL_CAPS constants when their first reference
  // precedes their declaration (the common Essentials Settings pattern).
  const literals = [];
  const literalPattern = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*((?:-?\d+(?:\.\d+)?|true|false|null|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*;/g;
  for (const match of js.matchAll(literalPattern)) {
    const firstReference = js.slice(0, match.index).search(new RegExp(`\\b${match[1]}\\b`));
    if (firstReference >= 0) literals.push({ name: match[1], declaration: match[0] });
  }
  if (literals.length) {
    for (const { declaration } of literals) js = js.replace(declaration, '');
    const bodyStart = js.indexOf('=> {');
    if (bodyStart >= 0) js = `${js.slice(0, bodyStart + 4)}\n  ${literals.map(({ declaration }) => declaration).join('\n  ')}${js.slice(bodyStart + 4)}`;
  }
  try {
    new Function(js); // a SyntaxError here means the unit is unusable
  } catch (error) {
    if (process.env.MWGP_DEBUG_LIB) console.warn(`library: unit fallback (${String(error?.message || error).slice(0, 100)})`);
    // Ruby permits shadowing a local in reopened/plugin code. Ruby2JS can
    // flatten those scopes into one IIFE and emit duplicate `state` bindings.
    // Relax only this proven collision; every other syntax error still uses
    // the piece-merging fallback or remains an explicit library failure.
    if (/Identifier ['"]state['"] has already been declared/.test(String(error?.message || error))) {
      const relaxed = js.replace(/\b(?:const|let)\s+state\b/g, 'var state');
      new Function(relaxed);
      js = relaxed;
    } else if (/Invalid left-hand side in assignment/.test(String(error?.message || error))) {
      // A zero-argument Ruby reader that also has a writer (`state=`, `hp=`,
      // `skill_level=`, ...) can be mistaken for a call by RgssCalls. On an
      // assignment target, restore the JavaScript property form.
      const relaxed = js.replace(/\.([A-Za-z_$][\w$]*)\(\)\s*=/g, '.$1 =');
      try {
        new Function(relaxed);
        js = relaxed;
      } catch {
        // If the call filter produced a different malformed assignment shape,
        // retry the same unit without its global zero-argument call heuristic.
        // Ruby2JS's native property form is syntactically safe and the runtime
        // shim still resolves the resulting getters/methods lazily.
        const safeFilters = filters.filter(filter => filter !== RgssCalls.prototype);
        let safe = nilSafeToString(convert(source, { preset: true, eslevel: 2022, loose_break: true, underscored_private: true, filters: safeFilters }).toString());
        safe = safe.replace(/\bget\s+([A-Za-z_$][\w$]*)\s*\(([^()]+)\)\s*\{/g, '$1($2) {');
        new Function(safe);
        js = safe;
      }
    } else throw error;
  }
  return js;
}

// A Ruby class/module is often reopened by plugins. If the combined source
// contains a construct Ruby2JS cannot merge, keep independently valid pieces
// usable: extend the first exported class/module with the methods/constants
// from the other successful pieces. This is deliberately a partial fallback,
// reported to the manifest, never a silent claim of full parity.
export function mergeTranspiledParts(name, parts) {
  // Parts can reference the class at top level ahead of the block that
  // declares it (`Battle.Battler = ...` before `class Battle`), which is a
  // temporal dead zone for the merged tail binding below. Hoist the first
  // declaration to the top so every later block sees an initialized class.
  let head = '';
  // Ruby reopens nested classes across script sections (`class Battle::Scene`
  // in two files); Ruby2JS emits each reopening as `Battle.Scene = class ...`,
  // so a later one would replace the earlier and drop everything attached to
  // it (`Battle.Scene.Animation`, read by a heritage clause further down).
  // Track nested-path assignments in execution order: a repeated one merges
  // the fresh class into the existing value instead of replacing it. Anything
  // that is not a class-on-class merge still replaces, as before.
  const assignedPaths = new Set();
  const blocks = parts.map(js => {
    let body = js;
    try {
      const ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
      const isDecl = node => (node.type === 'ClassDeclaration' && node.id?.name === name) || (node.type === 'VariableDeclaration' && node.declarations.some(d => d.id?.type === 'Identifier' && d.id.name === name));
      const edits = [];
      let hoisted = null;
      if (!head) {
        const decl = ast.body.find(isDecl);
        if (decl) {
          head = js.slice(decl.start, decl.end);
          hoisted = decl;
          edits.push({ start: decl.start, end: decl.end, text: '' });
        }
      }
      // An empty superclass-less reopening (`class Battle {}` around an
      // `include`) contributes nothing but its binding, which shadows the
      // hoisted class: `Name.X` reads in its block then miss (and its
      // `__mixin(Name.prototype, ...)` would land on the shadow, lost).
      for (const node of ast.body) {
        if (node !== hoisted && node.type === 'ClassDeclaration' && node.id?.name === name && node.body.body.length === 0 && !node.superClass) edits.push({ start: node.start, end: node.end, text: '' });
      }
      // Ruby's `class << self` (a singleton reopening, the mod idiom for wrapping a
      // method with `alias new old` + a redefinition) arrives as `PATH = (() => {
      // this.new = this.old(); this.old = ...; return {} })()`. The arrow fixes
      // `this` to the loader scope instead of the object under definition, so
      // captures read stubs and overrides land on the scope; and the capture
      // invokes the old method instead of referencing it. Bind the body to the
      // path's current value (a fresh object on first assignment), return that
      // object instead of the discarded `{}`, and drop the capture's parens
      // when the captured name is redefined later in the same body.
      const bindSelfIife = (expr, lhs) => {
        if (expr.type !== 'CallExpression' || expr.arguments.length || expr.callee.type !== 'ArrowFunctionExpression' || expr.callee.async || expr.callee.params.length || expr.callee.body.type !== 'BlockStatement') return null;
        const stmts = expr.callee.body.body;
        const topThis = node => {
          const stack = [node];
          while (stack.length) {
            const current = stack.pop();
            if (!current || typeof current.type !== 'string') continue;
            if (current.type === 'ThisExpression') return true;
            if (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression' || current.type === 'ClassDeclaration' || current.type === 'ClassExpression') continue;
            for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value.type === 'string') stack.push(value); }
          }
          return false;
        };
        if (!stmts.some(node => node.type !== 'FunctionDeclaration' && topThis(node))) return null;
        const selfOf = member => member.type === 'MemberExpression' && !member.computed && member.object.type === 'ThisExpression' && member.property.type === 'Identifier' ? member.property.name : null;
        const redefined = new Set();
        for (const node of stmts) {
          if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.operator === '=') {
            const target = selfOf(node.expression.left);
            if (target) redefined.add(target);
          }
        }
        const inner = [];
        for (const node of stmts) {
          if (node.type === 'ReturnStatement' && node.argument?.type === 'ObjectExpression' && node.argument.properties.length === 0) inner.push({ start: node.argument.start, end: node.argument.end, text: 'this' });
          if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.operator === '=') {
            const call = node.expression.right;
            if (call?.type === 'CallExpression' && call.arguments.length === 0 && redefined.has(selfOf(call.callee)) && selfOf(node.expression.left)) inner.push({ start: call.start, end: call.end, text: js.slice(call.callee.start, call.callee.end) });
          }
        }
        let text = js.slice(expr.callee.body.start, expr.callee.body.end);
        inner.sort((a, b) => b.start - a.start);
        for (const edit of inner) text = text.slice(0, edit.start - expr.callee.body.start) + edit.text + text.slice(edit.end - expr.callee.body.start);
        return `(function () ${text}).call(${lhs} == null ? {} : ${lhs})`;
      };
      for (const node of ast.body) {
        if (node.type !== 'ExpressionStatement' || node.expression.type !== 'AssignmentExpression' || node.expression.operator !== '=') continue;
        const chain = [];
        let at = node.expression.left;
        while (at?.type === 'MemberExpression' && !at.computed && at.property.type === 'Identifier') { chain.unshift(at.property.name); at = at.object; }
        if (at?.type !== 'Identifier' || at.name !== name || !chain.length) continue;
        const path = chain.join('.');
        const lhs = js.slice(node.expression.left.start, node.expression.left.end);
        const bound = bindSelfIife(node.expression.right, lhs);
        const rhs = bound ?? js.slice(node.expression.right.start, node.expression.right.end);
        if (assignedPaths.has(path)) edits.push({ start: node.expression.start, end: node.expression.end, text: `${lhs} = __mwgp_reopen(${lhs}, (${rhs}))` });
        else if (bound) edits.push({ start: node.expression.right.start, end: node.expression.right.end, text: rhs });
        assignedPaths.add(path);
      }
      if (edits.length) {
        edits.sort((a, b) => b.start - a.start);
        for (const edit of edits) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
      }
    } catch { /* keep the part whole: the tail merge still applies */ }
    return `{
  ${body}
  __mwgp_parts.push(typeof ${name} !== 'undefined' ? ${name} : undefined);
}`;
  }).join('\n');
  return `
const __mwgp_parts = [];
function __mwgp_reopen(__mwgp_existing, __mwgp_fresh) {
  if (!__mwgp_existing) return __mwgp_fresh;
  if ((typeof __mwgp_existing === 'function' || (typeof __mwgp_existing === 'object' && __mwgp_existing !== null)) && (typeof __mwgp_fresh === 'function' || (typeof __mwgp_fresh === 'object' && __mwgp_fresh !== null))) {
    const __mwgp_copy = (__mwgp_target, __mwgp_source, __mwgp_skip) => {
      for (const __mwgp_key of Object.getOwnPropertyNames(__mwgp_source)) {
        if (__mwgp_skip.includes(__mwgp_key)) continue;
        try { Object.defineProperty(__mwgp_target, __mwgp_key, Object.getOwnPropertyDescriptor(__mwgp_source, __mwgp_key)); } catch { /* a non-configurable slot keeps its value; the rest still merges */ }
      }
    };
    if (typeof __mwgp_existing === 'function' && typeof __mwgp_fresh === 'function' && __mwgp_existing.prototype && __mwgp_fresh.prototype) __mwgp_copy(__mwgp_existing.prototype, __mwgp_fresh.prototype, ['constructor']);
    __mwgp_copy(__mwgp_existing, __mwgp_fresh, ['length', 'name', 'prototype', 'constructor']);
    return __mwgp_existing;
  }
  return __mwgp_fresh;
}
${head}
${blocks}
${head ? '' : `let ${name} = __mwgp_parts.shift();`}
for (const __mwgp_part of __mwgp_parts) {
  if (!__mwgp_part || __mwgp_part === ${name} || !${name}) continue;
  if (typeof ${name} === 'function' && __mwgp_part.prototype) {
    for (const __mwgp_key of Object.getOwnPropertyNames(__mwgp_part.prototype)) {
      if (__mwgp_key !== 'constructor') Object.defineProperty(${name}.prototype, __mwgp_key, Object.getOwnPropertyDescriptor(__mwgp_part.prototype, __mwgp_key));
    }
  }
  if ((typeof ${name} === 'object' || typeof ${name} === 'function') && (typeof __mwgp_part === 'object' || typeof __mwgp_part === 'function')) {
    for (const __mwgp_key of Object.getOwnPropertyNames(__mwgp_part)) {
      if (!['length', 'name', 'prototype'].includes(__mwgp_key)) Object.defineProperty(${name}, __mwgp_key, Object.getOwnPropertyDescriptor(__mwgp_part, __mwgp_key));
    }
  }
}
`;
}

// snippets: array of Ruby sources. Returns the manifest's `rubyLibrary` section.
export async function buildRgssLibrary(scripts, snippets, { maxDepth = 3, log = console.log, index = null, onUnit = null } = {}) {
  if (!index) { log(`library: indexing ${scripts.length} scripts`); index = indexScripts(scripts, log); }
  setKnownMethods(index.allDefNames);
  {
    const topLevel = new Set([...index.units.values()].filter(unit => unit.kind === 'def').map(unit => unit.name.replace(/[?!]$/, '')));
    const instance = new Set();
    for (const unit of index.units.values()) if (unit.kind === 'const') for (const name of unit.methods) instance.add(String(name).replace(/[?!]$/, ''));
    setMethodOnlyNames([...instance].filter(name => !topLevel.has(name) && name !== 'initialize'));
  }
  const roots = snippetRoots(index, snippets);
  for (const name of [...(index.bootNames || []), ...(index.bootStatementNames || [])]) roots.add(name);   // save-data registrations are always loaded, with what they reference
  const depths = closure(index, roots, maxDepth);
  for (const name of ENGINE_CLASSES) if (index.units.has(name) && !depths.has(name)) depths.set(name, maxDepth);
  // Text filters: a module exposing `def self.inline(text) (or module_function inline)` is the game's own
  // message-text substitution hook (token expansion). Load it eagerly and let
  // the player run message text through it; no game or module names involved.
  const textFilters = [];
  for (const [name, unit] of index.units) {
    if (unit.kind === 'const' && unit.pieces.some(piece => /def\s+(?:self\.)?inline\s*\(\s*\w+\s*\)/.test(piece.text))) {
      textFilters.push(name);
      if (!depths.has(name)) depths.set(name, maxDepth);
    }
  }
  log(`library: ${index.units.size} units, ${roots.size} referenced by event scripts, ${depths.size} within depth ${maxDepth}`);
  // `methods`: every name the game defines with `def`. Ruby2JS compiles a paren-less zero-arg
  // call on such a name as a call, on any other name as a property read, so the player's
  // built-in objects must expose exactly those names as functions (see rgss-script.js).
  const out = { interpreter: index.interpreter, interpreterMethods: [...index.interpreterMethods], methods: [...new Set([...index.allDefNames].map(name => String(name).replace(/[?!]$/, '')))], textFilters, units: {}, failed: {}, partial: {} };
  let done = 0;
  // Units differ wildly in cost (a one-line registration vs a whole battle class): progress is weighed by source size.
  const unitSize = name => (index.units.get(name)?.pieces || []).reduce((sum, piece) => sum + String(piece.text || '').length, 0) || 1;
  const totalSize = onUnit ? [...depths.keys()].reduce((sum, name) => sum + unitSize(name), 0) : 0;
  for (const [name] of depths) {
    // Ruby2JS drops `?`/`!` from method names, so units are keyed by their JS name.
    const outputName = name.replace(/[?!]$/, '');
    try { out.units[outputName] = transpileUnit(index.units.get(name)); }
    catch (error) {
      const unit = index.units.get(name);
      const pieces = [];
      const pieceFailures = [];
      for (const piece of unit?.pieces || []) {
        try { pieces.push(transpileUnit({ ...unit, pieces: [piece] })); }
        catch (pieceError) { pieceFailures.push({ script: piece.script, error: String(pieceError?.message || pieceError).split('\n')[0].slice(0, 160) }); }
      }
      if (pieces.length && JS_IDENTIFIER.test(outputName)) {
        out.units[outputName] = mergeTranspiledParts(outputName, pieces);
        out.partial[name] = {
          error: String(error?.message || error).split('\n')[0].slice(0, 160),
          pieces: pieces.length,
          failedPieces: pieceFailures
        };
      } else out.failed[name] = String(error?.message || error).split('\n')[0].slice(0, 160);
    }
    if (++done % 25 === 0) log(`library: ${done}/${depths.size} units (${Object.keys(out.failed).length} failed)`);
    if (onUnit) {
      onUnit({ name, size: unitSize(name), totalSize });
      // Let progress output flush while the (synchronous) transpile runs.
      if (done % 10 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }
  out.boot = (index.bootNames || []).filter(name => out.units[name]);
  out.bootStatements = (index.bootStatementNames || []).filter(name => out.units[name]);
  log(`library: ${Object.keys(out.units).length} units transpiled, ${Object.keys(out.failed).length} failed${out.boot.length ? `, ${out.boot.length} save-data registration(s)` : ''}`);
  return out;
}
