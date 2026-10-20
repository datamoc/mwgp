// RGSS/Ruby idiomatically omits parens on zero-arg method calls and definitions
// (`Graphics.update`, `def main`), which Ruby2JS's default heuristic reads as JS
// attribute access / a getter instead of a call: `Graphics.update` compiles to the
// no-op statement `Graphics.update;`, and `def main` compiles to `get main() {...}`
// (uncallable as `main()`). Ruby2JS already exposes the escape hatch it uses
// internally for this exact ambiguity — the synthetic `:call`/`:defm` node types
// force "always a method", overriding the parens-presence heuristic — so this filter
// just decides, name by name, when to apply it: any zero-arg `def`/`defs` name seen
// anywhere in the program (plus a short seed list of RGSS builtins with no Ruby
// `def` of their own, e.g. Graphics.transition) is assumed to be a real method at
// every call site, not a property.
import { Filter } from '../transpilers/ruby2js-master/demo/selfhost/ruby2js.js';

// RGSS-native zero-arg calls with no Ruby `def` anywhere in a project's own scripts.
const BUILTIN_ZERO_ARG_METHODS = ['transition', 'freeze', 'frame_reset', 'dir4', 'dir8'];
// Ruby2JS represents Array#length (and a number of other JS-native members)
// as a property. Do not turn these into calls merely because a game happens
// to define a Ruby method with the same name somewhere in its script corpus.
// Otherwise unrelated code such as `parts.length` becomes `parts.length()`.
export const JS_NATIVE_ZERO_ARG_PROPERTIES = new Set([
  'length', 'size', 'map', 'filter', 'find', 'findIndex', 'includes', 'indexOf',
  'lastIndexOf', 'slice', 'join', 'concat', 'reverse', 'sort', 'forEach',
  'keys', 'values', 'entries', 'toString', 'valueOf',
  // RPGM libraries commonly expose mutable state through a zero-argument
  // reader plus `state = value`. Keep that Ruby property shape intact: a
  // method call on the left-hand side would become invalid JavaScript.
  'state'
]);
// RPG::Map records decoded from RGSS Marshal files expose these as plain data
// fields. A same-named accessor elsewhere in the game's Ruby must not turn
// `@map.data` (or its sibling map metadata fields) into a JS method call.
const RGSS_MAP_RECORD_FIELDS = new Set(['data', 'events', 'width', 'height', 'tileset_id']);

let knownMethods = new Set(BUILTIN_ZERO_ARG_METHODS);

// Methods invented by a source rewrite (renamed `initialize`s) join the set so they compile as methods, not getters.
export function addKnownMethods(names) { for (const name of names) knownMethods.add(name); }

export function setKnownMethods(names) {
  knownMethods = new Set([...BUILTIN_ZERO_ARG_METHODS, ...names]);
}

// Walks a parsed Ruby2JS AST (as returned by `parse()`) collecting every name
// defined via `def`/`defs`, so the filter can later force those names to compile
// as calls at every call site — regardless of which specific script defines them,
// since scripts are bundled and executed as one program.
export function collectDefNames(ast, names = new Set()) {
  if (!ast || typeof ast !== 'object' || !('type' in ast) || !('children' in ast)) return names;
  if (ast.type === 'def') names.add(ast.children[0]);
  if (ast.type === 'defs') names.add(ast.children[1]);
  for (const child of ast.children) collectDefNames(child, names);
  return names;
}

// `attr_reader`/`attr_accessor` declare zero-argument readers without a `def`
// node (transpileUnit expands them to real defs before conversion). Collect
// their names too, so call sites compile to calls exactly like plainer defs.
export function collectAttrNames(ast, names = new Set()) {
  if (!ast || typeof ast !== 'object' || !('type' in ast) || !('children' in ast)) return names;
  if (ast.type === 'send' && (ast.children[1] === 'attr_reader' || ast.children[1] === 'attr_accessor')) {
    for (const arg of ast.children.slice(2)) {
      if (arg?.type === 'sym' && typeof arg.children[0] === 'string') names.add(arg.children[0]);
    }
  }
  for (const child of ast.children) collectAttrNames(child, names);
  return names;
}

// Instance methods of the class being transpiled: a receiver-less call to one is a call on `self` (`this.name(...)`).
// Handled here rather than by a separate filter: a filter that returns without passing the node on ends the chain, so a
// second filter placed before this one made the zero-argument heuristic below unreachable for every class with methods.
let selfMethods = new Set();
export function setSelfMethods(names) { selfMethods = new Set(names || []); }

export class RgssCalls extends Filter.Processor {
  on_send(node) {
    const [receiver, method, ...args] = node.children;
    if (node.type === 'send' && receiver == null && selfMethods.has(String(method))) {
      return this.process_children(node.updated(args.length ? 'send' : 'call', [this.s('self'), method, ...args]));
    }
    const mapRecordField = receiver?.type === 'ivar' && receiver.children?.[0] === '@map' && RGSS_MAP_RECORD_FIELDS.has(String(method));
    // A Ruby class/module constant can expose its own zero-argument `keys` or
    // `values` method, while `this.DATA.keys` is the transpiled Hash property
    // that the runtime represents as an array. Force the call on constant
    // receivers only; keeping the Hash property form intact is essential.
    // All-caps constants conventionally hold data (especially Hash tables),
    // whereas mixed-case constants name Ruby classes/modules with class methods.
    // The runtime Hash adapter supports both `.keys` and `.keys()` already.
    const constantHash = receiver?.type === 'const' && /^[A-Z0-9_]+$/.test(String(receiver.children?.[1]));
    const constantMethod = receiver?.type === 'const' && !constantHash && ['keys', 'values', 'entries'].includes(String(method)) && knownMethods.has(method);
    if (node.type === 'send' && args.length === 0 && knownMethods.has(method) && (!JS_NATIVE_ZERO_ARG_PROPERTIES.has(String(method)) || constantMethod) && !mapRecordField) {
      // Ruby permits receiver-less zero-argument method calls (current_gender)
      // and receiver calls (gender.capitalize) without parentheses. Ruby2JS
      // otherwise emits a function reference for the former, which then leaks
      // into string interpolation or method chaining. A synthetic call node
      // preserves Ruby semantics for both forms.
      return this.process_children(node.updated('call', node.children));
    }
    return this.process_children(node);
  }

  // `def self.name` with no parameters and no parentheses is emitted as a static getter, but every paren-less `X.name` of a
  // known method name is a call (above): dropping the source location makes Ruby2JS treat the definition as a method.
  on_defs(node) {
    const name = node.children[1];
    if (node.type === 'defs' && knownMethods.has(name) && !JS_NATIVE_ZERO_ARG_PROPERTIES.has(String(name)) && node.is_method?.() === false) {
      return this.process_children(node.updated(null, node.children, { location: null }));
    }
    return this.process_children(node);
  }

  on_def(node) {
    const [name] = node.children;
    if (node.type === 'def' && knownMethods.has(name) && !JS_NATIVE_ZERO_ARG_PROPERTIES.has(String(name)) && !node.is_method()) {
      return this.process_children(node.updated('defm', node.children));
    }
    return this.process_children(node);
  }
}

export default RgssCalls;
