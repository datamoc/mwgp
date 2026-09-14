import { Parser, SEXP, s, S, ast_node, convert, parse, include, Filter, DEFAULTS, excluded, included, _options, filterContext, nodesEqual, registerFilter, scanRegexpGroups, Ruby2JS } from "../ruby2js.js";

class Combiner extends Filter.Processor {
  // Ensure combiner runs after ESM filter so that import statements
  // have been converted to :import nodes before we try to deduplicate them
  static reorder(filters) {
    let esm_filter = typeof Ruby2JS.Filter.ESM !== 'undefined' ? Ruby2JS.Filter.ESM : null;
    if (!esm_filter || !filters.includes(esm_filter)) return filters;
    let combiner_index = filters.indexOf(Ruby2JS.Filter.Combiner);
    let esm_index = filters.indexOf(esm_filter);

    // Use explicit nil check - in JS, index 0 is falsy so `!index` would be true
    if (combiner_index === -1 || esm_index === -1) return filters;
    if (combiner_index > esm_index) return filters // Already after ESM;

    // Move combiner to after ESM
    filters = filters.dup();
    filters.delete_at(combiner_index);

    // esm_index may have shifted if combiner was before it
    esm_index = filters.indexOf(esm_filter);
    filters.insert(esm_index + 1, Ruby2JS.Filter.Combiner);
    return filters
  };

  // Process the entire AST after all children are processed
  // We need to find and merge duplicate module/class definitions
  // Note: Only handles statement-level :begin, not expression grouping
  on_begin(node) {
    // Only process if this is a top-level statement sequence (multiple children)
    // Single-child begin nodes are used for expression grouping (like `!(a && b)`)
    // and should be left alone to preserve semantics
    if (node.children.length <= 1) return this._parent.on_begin.call(this, node);
    let children = this.process_all(node.children);
    children = this._merge_definitions(children);
    children = children.filter(x => x != null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return node.updated(null, children)
  };

  // Flatten nested :begin nodes to get all children at the same level
  // This handles cases where require filter wraps content in :begin nodes
  _flatten_begins(nodes) {
    let result = [];

    for (let node of nodes) {
      if (!node) continue;

      if (node.type === "begin") {
        // Recursively flatten nested begins
        // Note: Use push with splat instead of concat - Ruby's concat modifies
        // in place but JS concat returns a new array
        result.push(...this._flatten_begins(node.children))
      } else {
        result.push(node)
      }
    };

    return result
  };

  // Merge duplicate module/class definitions and deduplicate imports
  _merge_definitions(nodes) {
    // Flatten any nested :begin nodes first
    nodes = this._flatten_begins(nodes);

    // Track definitions by their full name (including nesting)
    let definitions = {} // name => [index, node];

    // Track imports by module path for deduplication
    let imports = {} // path => [index, node];
    let result = [];

    for (let index = 0; index < nodes.length; index++) {
      let orig_index, orig_node, merged;
      let node = nodes[index];
      if (!node) continue;

      if (["module", "class"].includes(node.type)) {
        let name_key = this._definition_key(node);

        if (definitions[name_key]) {
          // Merge into existing definition
          let [orig_index, orig_node] = definitions[name_key];
          merged = this._merge_definition(orig_node, node);
          result[orig_index] = merged;
          definitions[name_key] = [orig_index, merged]
        } else {
          // Don't add this node to result (it's been merged)
          // First occurrence - track it
          definitions[name_key] = [result.length, node];
          result.push(node)
        }
      } else if (node.type === "import" || this._is_import_send(node)) {
        let import_key = this._import_path(node);

        if (imports[import_key]) {
          // Merge into existing import
          [orig_index, orig_node] = imports[import_key];
          merged = this._merge_imports(orig_node, node);
          result[orig_index] = merged;
          imports[import_key] = [orig_index, merged]
        } else {
          // Don't add this node to result (it's been merged)
          // First occurrence - track it
          imports[import_key] = [result.length, node];
          result.push(node)
        }
      } else {
        result.push(node)
      }
    };

    return result
  };

  // Generate a unique key for a module/class definition
  _definition_key(node) {
    let const_node = node.children[0];
    let name_parts = [];

    // Walk const chain to get full name (e.g., Ruby2JS::Converter)
    while (const_node?.type === "const") {
      name_parts.unshift(const_node.children[1]);
      const_node = const_node.children[0]
    };

    return `${node.type ?? ""}:${name_parts.join("::") ?? ""}`
  };

  // Merge two module or class definitions
  _merge_definition(original, reopened) {
    let orig_body, reopen_body, superclass;

    // Use array indexing instead of destructuring to avoid
    // JS block-scoping issues (let in if/else creates new scope)
    let orig_name = original.children[0];

    if (original.type === "class") {
      // class has 3 children: name, superclass, body
      let orig_super = original.children[1];
      orig_body = original.children[2];
      let reopen_super = reopened.children[1];
      reopen_body = reopened.children[2];
      superclass = orig_super ?? reopen_super
    } else {
      // module has 2 children: name, body
      orig_body = original.children[1];
      reopen_body = reopened.children[1];
      superclass = null
    };

    // Merge bodies
    let orig_children = this._body_children(orig_body);
    let reopen_children = this._body_children(reopen_body);

    // Recursively merge any nested modules/classes
    // Note: Use splat instead of + for JS compatibility
    // Ruby's array + is not the same as JS's + operator
    let merged_children = this._merge_definitions([
      ...orig_children,
      ...reopen_children
    ]);

    // A later reopening's `def foo` replaces an earlier one - two same-named methods
    // (or worse, two `initialize`s - a hard "class may only have one constructor"
    // SyntaxError) can't both survive being merged into one JS class body the way they
    // could coexist as separate `Class.prototype.foo = ...` reopening assignments.
    merged_children = this._dedupe_defs(merged_children);

    // Reorder: put class variable assignments (cvasgn) first
    // JavaScript requires static fields to be declared before use
    merged_children = this._reorder_class_body(merged_children);

    // Create merged body
    let merged_body = (() => {
      switch (merged_children.length) {
      case 0:
        return null;

      case 1:
        return merged_children[0];

      default:
        return s("begin", ...merged_children)
      }
    })();

    return original.type === "class" ? s(
      "class",
      orig_name,
      superclass,
      merged_body
    ) : s("module", orig_name, merged_body)
  };

  // Keep only the last of any same-named :def/:defs/:casgn nodes in a (already merged)
  // class body, matching Ruby's reopening semantics - a later definition or constant
  // assignment replaces an earlier one, it does not coexist alongside it. Two survivors
  // with the same name is not just redundant here, it can be a hard SyntaxError (two
  // `initialize`s, or two `let NAME = ...` class-constant declarations in one scope).
  _dedupe_key(node, index) {
    if (node.type === "def") {
      return ["def", node.children[0]]
    } else if (node.type === "defs" && node.children[0]?.type === "self") {
      return ["defs", node.children[1]]
    } else if (node.type === "casgn" && node.children[0] == null) {
      return ["casgn", node.children[1]]
    } else {
      return ["unique", index]
    }
  };

  _dedupe_defs(children) {
    let last_index = {};

    for (let index = 0; index < children.length; index++) {
      let node = children[index];
      if (typeof node !== "object" || node == null || !("type" in node)) continue;
      last_index[this._dedupe_key(node, index)] = index
    };

    let kept = [];

    for (let index = 0; index < children.length; index++) {
      let node = children[index];

      if (typeof node !== "object" || node == null || !("type" in node)) {
        kept.push(node)
      } else if (last_index[this._dedupe_key(node, index)] === index) {
        kept.push(node)
      }
    };

    return kept
  };

  // Extract children from a body node
  _body_children(body) {
    if (body == null) return [];

    // Note: Don't use .to_a here - children is already an array,
    // and JS Object.prototype.to_a returns entries not the array itself
    if (body.type === "begin") return body.children;
    return [body]
  };

  // Check if a :send node is an import statement
  // e.g., (send nil :import (const nil :React) (hash (pair (sym :from) (str "react"))))
  _is_import_send(node) {
    return node.type === "send" && node.children[0] == null && node.children[1] === "import"
  };

  // Extract the module path from an import node for deduplication
  // Handles both :import nodes and :send nodes with :import method
  _import_path(node) {
    let from_pair;

    if (node.type === "send" && node.children[1] === "import") {
      // :send import - look for hash with :from key
      let hash_node = node.children.find(c => (
        typeof c === "object" && c != null && "type" in c && c.type === "hash"
      ));

      if (hash_node) {
        from_pair = hash_node.children.find(p => p.children[0].children[0] === "from");
        if (from_pair) return from_pair.children[1].children[0]
      };

      // Fallback to string argument
      let str_node = node.children.find(c => (
        typeof c === "object" && c != null && "type" in c && c.type === "str"
      ));

      if (str_node) return str_node.children[0];
      return (node ?? "").toString()
    };

    // :import node
    let path = node.children[0];

    if (Array.isArray(path)) {
      // Find the 'from:' pair
      // Note: Use explicit guards instead of rescue - the rescue modifier
      // transpiles to try/catch without return statements in JS
      from_pair = path.find((p) => {
        if (typeof p !== "object" || p == null || !("type" in p) || p.type !== "pair") {
          return false
        };

        if (typeof p.children[0] !== "object" || p.children[0] == null || !("children" in p.children[0])) {
          return false
        };

        return p.children[0].children[0] === "from"
      });

      return from_pair ? from_pair.children[1].children[0] : (path[0] ?? "").toString()
    } else if (typeof path === "string") {
      return path
    } else {
      return (path ?? "").toString()
    }
  };

  // Merge two import statements for the same module
  // Combines default imports and named imports
  _merge_imports(orig, new_import) {
    // Extract path and imports from both nodes
    let orig_path = orig.children[0];
    let orig_imports = orig.children.slice(1);
    let new_imports = new_import.children.slice(1);

    // If both are identical (same path, same imports), just return original
    if (orig_imports === new_imports) return orig;

    // If one has no imports (side-effect import), prefer the one with imports
    if (new_imports.length === 0) return orig;
    if (orig_imports.length === 0) return new_import;

    // Merge imports - combine default and named imports
    let merged_imports = this._merge_import_specifiers(
      orig_imports,
      new_imports
    );

    return s("import", orig_path, ...merged_imports)
  };

  // Merge import specifiers (default imports and named imports)
  _merge_import_specifiers(orig, new_specs) {
    // Separate default imports (single const) from named imports (arrays)
    let orig_default = orig.find(i => (
      !Array.isArray(i) && typeof i === "object" && i != null && "type" in i && i.type === "const"
    ));

    let new_default = new_specs.find(i => (
      !Array.isArray(i) && typeof i === "object" && i != null && "type" in i && i.type === "const"
    ));

    let orig_named = orig.find(i => Array.isArray(i));
    let new_named = new_specs.find(i => Array.isArray(i));
    let result = [];

    // Use the default import from either (they should be the same if both exist)
    if (orig_default || new_default) result.push(orig_default ?? new_default);

    // Merge named imports
    if (orig_named || new_named) {
      // Use splat for JS-compatible array concatenation
      let all_named = [...orig_named ?? [], ...new_named ?? []];

      // Deduplicate by const name
      let seen = {};

      let unique_named = all_named.filter((spec) => {
        if (typeof spec !== "object" || spec == null || !("type" in spec)) {
          return false
        };

        let name = spec.children[1];

        if (seen[name]) {
          return false
        } else {
          seen[name] = true;
          return true
        }
      });

      if (unique_named.length !== 0) result.push(unique_named)
    };

    return result
  };

  // Reorder class body: static fields (cvasgn) must come before
  // methods that use them, since JavaScript evaluates class body
  // in order (unlike Ruby where class variables are hoisted)
  _reorder_class_body(children) {
    // Partition into class variable assignments and everything else
    let [cvasgns, others] = children.partition(node => node?.type === "cvasgn");
    return [...cvasgns, ...others]
  }
};

// frozen_string_literal: true
// Combiner filter - merges reopened modules and classes
//
// Ruby allows reopening modules and classes to add methods:
//   module Foo
//     def bar; end
//   end
//   module Foo
//     def baz; end
//   end
//
// JavaScript doesn't support this pattern. This filter merges
// all definitions with the same name into a single definition.
//
// Run this filter AFTER the require filter so that inlined
// files get their classes/modules merged with the main file.
Object.defineProperties(
  Combiner.prototype,
  Object.getOwnPropertyDescriptors(SEXP)
);

registerFilter("Combiner", Combiner.prototype, false);
Ruby2JS.Filter.Combiner.reorder = Combiner.reorder;
export default Combiner;
export { Combiner }

// NOTE: Combiner is NOT added to DEFAULTS because it's specifically
// for self-hosting scenarios where multiple files define the same
// module/class. Most users don't need this filter.