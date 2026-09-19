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

let knownMethods = new Set(BUILTIN_ZERO_ARG_METHODS);

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

export class RgssCalls extends Filter.Processor {
  on_send(node) {
    const [receiver, method, ...args] = node.children;
    if (node.type === 'send' && receiver != null && args.length === 0 && knownMethods.has(method)) {
      return this.process_children(node.updated('call', node.children));
    }
    return this.process_children(node);
  }

  on_def(node) {
    const [name] = node.children;
    if (node.type === 'def' && knownMethods.has(name) && !node.is_method()) {
      return this.process_children(node.updated('defm', node.children));
    }
    return this.process_children(node);
  }
}

export default RgssCalls;
