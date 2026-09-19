import { Parser, SEXP, s, S, ast_node, convert, parse, include, Filter, DEFAULTS, excluded, included, _options, filterContext, nodesEqual, registerFilter, scanRegexpGroups, Ruby2JS } from "../ruby2js.js";

class Functions extends Filter.Processor {
  // Methods that convert only when is_method? is true (parentheses present)
  // OR when explicitly included via include: option.
  static REQUIRE_PARENS = [
    "keys",
    "values",
    "entries",
    "index",
    "rindex",
    "clear",
    "reverse!",
    "max",
    "min"
  ];

  // Check if a REQUIRE_PARENS method should convert:
  // - Always convert if node.is_method? (has parentheses)
  // - Also convert if explicitly included via include: option
  parens_or_included(node, method) {
    if (node.is_method()) return true;
    return this.explicitly_included(method)
  };

  // Check if a method was explicitly included via the include: or include_all: option
  explicitly_included(method) {
    return this._options.include_all ?? this._options.include?.includes(method)
  };

  // Check if an AST node is known to produce a hash (plain JS object).
  // Detects: literal hashes, hash cast sentinels,
  // and variables with inferred hash type (from pragma filter's @var_types).
  hash_node(node) {
    if (typeof node !== "object" || node == null || !("type" in node)) {
      return false
    };

    if (node.type === "hash") return true;

    // Check pragma filter's type inference for local/instance variables
    if (typeof this._var_types !== 'undefined' && ["lvar", "ivar"].includes(node.type)) {
      let var_name = node.children[0];

      if (node.type === "ivar") {
        var_name = (var_name ?? "").toString().replace(/^@/m, "")
      };

      return this._var_types[var_name] === "hash"
    };

    return false
  };

  static VAR_TO_ASSIGN = {
    lvar: "lvasgn",
    ivar: "ivasgn",
    cvar: "cvasgn",
    gvar: "gvasgn"
  };

  // Helper to replace local variable references in an AST node
  replace_lvar(node, old_name, new_name) {
    if (!ast_node(node)) return node;

    return node.type === "lvar" && node.children[0] === old_name ? node.updated(
      null,
      [new_name]
    ) : node.updated(
      null,
      node.children.map(c => this.replace_lvar(c, old_name, new_name))
    )
  };

  // Check if a node contains a break statement with a value (recursively)
  // Used to detect when a loop needs to be wrapped in an IIFE
  contains_break_with_value(node) {
    if (!ast_node(node)) return false;
    if (node.type === "break" && node.children.length > 0) return true;

    // Don't descend into nested blocks/lambdas - they have their own break scope
    if (["block", "lambda"].includes(node.type)) return false;
    return node.children.some(c => this.contains_break_with_value(c))
  };

  // Enumerable#each becomes forEach in JavaScript, where a Ruby break
  // cannot be emitted as a JavaScript break (it would be inside a
  // callback). Use a for..of loop for these blocks instead.
  contains_plain_break(node) {
    if (!ast_node(node)) return false;
    if (node.type === "break") return true;
    if (["block", "lambda"].includes(node.type)) return false;
    return node.children.some(child => this.contains_plain_break(child))
  };

  // Replace break statements with return statements (recursively)
  // Used when wrapping a loop in an IIFE to support break-with-value
  replace_breaks_with_returns(node) {
    if (!ast_node(node)) return node;

    if (node.type === "break") {
      return s("return", ...node.children)
    } else if (["block", "lambda"].includes(node.type)) {
      return node
    } else {
      return node.updated(
        null,
        node.children.map(c => this.replace_breaks_with_returns(c))
      )
    }
  };

  // Convert a block arg (or nested mlhs) to lvasgn for for..of destructuring
  args_to_lvasgn(child) {
    if (child.type === "mlhs") {
      return s("mlhs", ...child.children.map(c => this.args_to_lvasgn(c)))
    } else if (child.type === "splat") {
      return s("restarg", child.children[0].children[0])
    } else if (child.type === "restarg") {
      return child
    } else {
      return s("lvasgn", child.children[0])
    }
  };

  // Collect all leaf arg names from an args node (handles nested mlhs)
  collect_arg_names(node) {
    let names = [];

    if (node.type === "mlhs") {
      for (let c of node.children) {
        names.push(...this.collect_arg_names(c))
      }
    } else if (node.type === "arg") {
      names.push(node.children[0])
    } else if (node.type === "args") {
      for (let c of node.children) {
        names.push(...this.collect_arg_names(c))
      }
    };

    return names
  };

  // Reconstruct an arg/mlhs node as an lvar/array expression
  // :arg -> s(:lvar, name), :mlhs -> s(:array, *children)
  arg_to_lvar_expr(node) {
    if (node.type === "mlhs") {
      return s(
        "array",
        ...node.children.map(c => this.arg_to_lvar_expr(c))
      )
    } else if (node.type === "arg") {
      return s("lvar", node.children[0])
    } else {
      return node
    }
  };

  // Suffix all leaf arg names in an args structure (for sort_by comparison)
  suffix_args(node, suffix) {
    if (node.type === "mlhs") {
      return s(
        "mlhs",
        ...node.children.map(c => this.suffix_args(c, suffix))
      )
    } else if (node.type === "arg") {
      return s("arg", `${node.children[0] ?? ""}${suffix ?? ""}`)
    } else if (node.type === "args") {
      return s(
        "args",
        ...node.children.map(c => this.suffix_args(c, suffix))
      )
    } else {
      return node
    }
  };

  _filter_init(...args) {
    this._jsx = false;
    this._index_result_vars = new Set;
    return this._parent._filter_init.call(this, ...args)
  };

  // Reset index tracking per method scope
  on_def(node) {
    this._index_result_vars = new Set;
    return this._parent.on_def.call(this, node)
  };

  on_defs(node) {
    this._index_result_vars = new Set;
    return this._parent.on_defs.call(this, node)
  };

  // Track local variables assigned from .index() calls
  // so we can convert .nil? checks to === -1
  on_lvasgn(node) {
    let [var_name, value] = node.children;

    if (value?.type === "send" && value.children[1] === "index") {
      this._index_result_vars.add(var_name)
    };

    return this._parent.on_lvasgn.call(this, node)
  };

  on_csend(node) {
    let [target, method, ...args] = node.children;

    // Handle empty? specially for csend - we want obj?.length === 0
    // not obj.length?.==(0)
    if (method === "empty?" && args.length === 0 && !excluded(method)) {
      return this.process(this.S(
        "send",
        this.S("csend", target, "length"),
        "==",
        s("int", 0)
      ))
    };

    // process csend (safe navigation) nodes the same as send nodes
    // so method names get converted (e.g., include? -> includes)
    // then restore the csend type if needed
    let result = this.on_send(node);

    if (result?.type === "send" && node.type === "csend" && (result.children[0] != null || node.children[0] == null) && /^[a-zA-Z_]/.test((result.children[1] ?? "").toString())) {
      // Only restore csend when safe:
      // - Receiver wasn't moved to an argument (to_i/to_f → parseInt)
      // - Method is still an identifier, not an operator (negative? → <)
      result = result.updated("csend")
    } else if (result?.type === "call" && node.type === "csend") {
      // Handle &.call -> ccall (conditional call) for optional chaining
      result = result.updated("ccall")
    };

    return result
  };

  // Methods that always need () in JS even when called without args/parens in Ruby
  // These return values and must be called as methods, not accessed as properties
  static FORCE_PARENS = Object.freeze([
    "reverse",
    "pop",
    "shift",
    "sort",
    "dup",
    "clone"
  ]);

  on_send(node) {
    let body, index, regex, tokens, groups, stack, group, prepend, append, expr, neg_index, new_index, range, value, start, finish, len, key_strings, arg, key, result, pattern, gpattern, callback, block_args, block_body, match_var, block_arg_name, before, after, js_method, method_name, method_args, callback_args, variable, i, length, start_expr, end_expr, final, length_obj, mapper, has_sentinel, parent, ptarget, multiplier, scaled, rounded, raw, first, op, block_pass, name_arg;
    let [target, method, ...args] = node.children;

    if (excluded(method) && method !== "call") {
      return this._parent.on_send.call(this, node)
    };

    // require 'json' → remove (JSON is built-in in JavaScript)
    // require 'ostruct' → remove (JS objects are effectively OpenStructs)
    if (target == null && method === "require" && args.length === 1 && args[0].type === "str" && [
      "json",
      "ostruct"
    ].includes(args[0].children[0])) return s("begin");

    // OpenStruct.new(hash) → plain object
    if (method === "new" && nodesEqual(
      target,
      s("const", null, "OpenStruct")
    )) {
      if (args.length === 1 && args[0].type === "hash") {
        return this.process(args[0])
      } else if (args.length === 0) {
        return s("hash")
      }
    };

    // Force certain methods to always have () in JS output
    // Without this, is_method? heuristics treat them as property access
    if (target && Functions.FORCE_PARENS.includes(method) && args.length === 0 && !node.is_method()) {
      return this._parent.on_send.call(
        this,
        node.updated("call", node.children)
      )
    };

    // Class.new { }.new -> object literal {}
    // Transform anonymous class instantiation to object literal
    if (method === "new" && target && target.type === "block") {
      let block_call = target.children[0];
      let const_node = block_call.children[0];

      if (block_call.type === "send" && const_node?.type === "const" && const_node.children[0] == null && const_node.children[1] === "Class" && block_call.children[1] === "new" && block_call.children.length === 2) {
        // Extract body from block
        body = target.children[2];
        if (body?.type === "begin") body = body.children;
        if (!Array.isArray(body)) body = [body].filter(x => x != null);

        // Convert method definitions to hash pairs
        let pairs = [];

        for (let m of body) {
          let existing;
          if (m.type !== "def") continue;
          let name = m.children[0];
          let method_args = m.children[1];
          let method_body = m.children[2];

          if ((name ?? "").toString().endsWith("=")) {
            // Setter: def foo=(v) -> prop with set
            let base_name = (name ?? "").toString().slice(0, -1);
            let setter = s("defm", null, method_args, method_body);

            // Check if there's already a getter for this property
            // Use explicit != -1 check (Ruby returns nil, JS returns -1 when not found)
            let existing_idx = pairs.findIndex(p => (
              p.children[0].type === "prop" && p.children[0].children[0] === base_name
            )) ?? -1;

            if (existing_idx !== -1) {
              // Merge with existing getter
              existing = pairs[existing_idx];
              pairs.splice(existing_idx, 1);

              pairs.push(s(
                "pair",
                s("prop", base_name),
                {get: existing.children[1].get, set: setter}
              ))
            } else {
              pairs.push(s("pair", s("prop", base_name), {set: setter}))
            }
          } else if (!m.is_method() && method_args.children.length === 0) {
            // Getter: def foo (no parens, no args) -> prop with get
            let getter = s(
              "defm",
              null,
              method_args,
              s("autoreturn", method_body)
            );

            // Check if there's already a setter for this property
            // Use explicit != -1 check (Ruby returns nil, JS returns -1 when not found)
            let existing_idx = pairs.findIndex(p => (
              p.children[0].type === "prop" && p.children[0].children[0] === name
            )) ?? -1;

            if (existing_idx !== -1) {
              // Merge with existing setter
              existing = pairs[existing_idx];
              pairs.splice(existing_idx, 1);

              pairs.push(s(
                "pair",
                s("prop", name),
                {get: getter, set: existing.children[1].set}
              ))
            } else {
              pairs.push(s("pair", s("prop", name), {get: getter}))
            }
          } else {
            pairs.push(s(
              "pair",
              s("sym", name),
              s("defm", null, method_args, method_body)
            ))
          }
        };

        return this.process(s("hash", ...pairs))
      }
    };

    // debugger as a standalone statement -> JS debugger statement
    if (method === "debugger" && target == null && args.length === 0) {
      return s("debugger")
    };

    // typeof(x) -> typeof x (JS type checking operator)
    if (method === "typeof" && target == null && args.length === 1) {
      return s("typeof", this.process(args[0]))
    };

    if (["max", "min"].includes(method) && args.length === 0) {
      if (target.type === "array") {
        return this.process(this.S(
          "send",
          s("const", null, "Math"),
          node.children[1],
          ...target.children
        ))
      } else if (this.parens_or_included(node, method)) {
        return this.process(this.S(
          "send",
          s("const", null, "Math"),
          node.children[1],
          s("splat", target)
        ))
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "call" && target && target.type !== "block" && ([
      "ivar",
      "cvar"
    ].includes(target.type) || !excluded("call"))) {
      return this.S(
        "call",
        this.process(target),
        null,
        ...this.process_all(args)
      )
    } else if (method === "keys" && args.length === 0 && this.parens_or_included(
      node,
      method
    )) {
      return this.process(this.S(
        "send",
        s("const", null, "Object"),
        "keys",
        target
      ))
    } else if (method === "define_method" && target == null && args.length === 2) {
      return this.process(this.S(
        "send",
        s("attr", s("attr", s("self"), "constructor"), "prototype"),
        "[]=",
        args[0],
        args[1]
      ))
    } else if (method === "[]=" && args.length === 3 && args[0].type === "regexp" && args[1].type === "int") {
      index = args[1].children[0];

      // identify groups
      regex = args[0].children[0].children[0];
      tokens = scanRegexpGroups(regex);
      groups = [];
      stack = [];

      for (let token of tokens) {
        if (token[0] !== "group") continue;

        if (token[1] === "capture") {
          groups.push(token.dup());

          if (groups.length === index && stack.length !== 0) {
            return this._parent.on_send.call(this, node)
          };

          stack.push(groups.at(-1))
        } else if (token[1] === "close") {
          let popped = stack.pop();
          popped[popped.length - 1] = token.at(-1)
        }
      };

      group = groups[index - 1];

      // rewrite regex
      prepend = null;
      append = null;

      if (group[4] < regex.length) {
        regex = (regex.slice(0, group[4]) + "(" + regex.slice(group[4]) + ")").replace(
          /\$\)$/m,
          ")$"
        );

        append = 2
      };

      if (group[4] - group[3] === 2) {
        regex = regex.slice(0, group[3]) + regex.slice(group[4]);
        if (append) append = 1
      };

      if (group[3] > 0) {
        regex = ("(" + regex.slice(0, group[3]) + ")" + regex.slice(group[3])).replace(
          /^\(\^/m,
          "^("
        );

        prepend = 1;
        if (append) append++
      };

      regex = this.process(s(
        "regexp",
        s("str", regex),
        args[0].children.at(-1)
      ));

      // 
      if (args.at(-1).type === "str") {
        let str = args.at(-1).children[0].replaceAll("$", "$$");
        if (prepend) str = `$${prepend ?? ""}${str ?? ""}`;
        if (append) str = `${str ?? ""}$${append ?? ""}`;
        expr = s("send", target, "replace", regex, s("str", str))
      } else {
        let dstr = args.at(-1).type === "dstr" ? args.at(-1).children.dup() : [args.at(-1)];

        if (prepend) {
          dstr.unshift(s(
            "send",
            s("lvar", "match"),
            "[]",
            s("int", prepend - 1)
          ))
        };

        if (append) {
          dstr.push(s("send", s("lvar", "match"), "[]", s("int", append - 1)))
        };

        expr = s(
          "block",
          s("send", target, "replace", regex),
          s("args", s("arg", "match")),
          this.process(s("dstr", ...dstr))
        )
      };

      if (Object.keys(Functions.VAR_TO_ASSIGN).includes(target.type)) {
        return this.S(
          Functions.VAR_TO_ASSIGN[target.type],
          target.children[0],
          expr
        )
      } else if (target.type === "send") {
        return target.children[0] == null ? this.S(
          "lvasgn",
          target.children[1],
          expr
        ) : this.S(
          "send",
          target.children[0],
          `${target.children[1] ?? ""}=`,
          expr
        )
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "[]=" && args.length === 2 && args[0].type === "int" && args[0].children[0] < 0) {
      // arr[-1] = x => arr[arr.length - 1] = x
      neg_index = -args[0].children[0];

      new_index = this.S(
        "send",
        this.S("attr", target, "length"),
        "-",
        s("int", neg_index)
      );

      return this.process(this.S("send", target, "[]=", new_index, args[1]))
    } else if (method === "[]=" && args.length === 2 && [
      "irange",
      "erange"
    ].includes(args[0].type)) {
      // input: arr[start..finish] = value or arr[start...finish] = value
      // output: arr.splice(start, length, ...value)
      range = args[0];
      value = args[1];
      let [start, finish] = range.children;

      if (range.type === "erange") {
        // exclusive range: start...finish
        if (finish) {
          len = this.S("send", finish, "-", start)
        } else {
          // no finish means to end of array
          len = this.S("send", s("attr", target, "length"), "-", start)
        }
      } else if (finish?.type === "int" && finish.children[0] === -1) {
        // start..-1 means from start to end
        len = this.S("send", s("attr", target, "length"), "-", start)
      } else if (finish) {
        len = this.S(
          "send",
          this.S("send", finish, "-", start),
          "+",
          s("int", 1)
        )
      } else {
        len = this.S("send", s("attr", target, "length"), "-", start)
      };

      return this.process(this.S(
        "send",
        target,
        "splice",
        start,
        len,
        s("splat", value)
      ))
    } else if (method === "merge") {
      // Use Object.assign({}, ...) instead of {...spread} to avoid
      // statement-level { being parsed as a block in JS
      if (target) args.unshift(target);

      return this.process(this.S(
        "send",
        s("const", null, "Object"),
        "assign",
        s("hash"),
        ...args
      ))
    } else if (method === "merge!") {
      return this.process(this.S("assign", target, ...args))
    } else if (method === "except" && args.length >= 1 && target) {
      // hash.except(:a, :b) =>
      //   Object.fromEntries(Object.entries(hash).filter(([k]) => !["a","b"].includes(k)))
      key_strings = args.map(arg => (
        arg.type === "sym" || arg.type === "str" ? s(
          "str",
          (arg.children[0] ?? "").toString()
        ) : arg
      ));

      return this.process(s(
        "send",
        s("const", null, "Object"),
        "fromEntries",

        s(
          "send",
          s("send", s("const", null, "Object"), "entries", target),
          "filter",

          s(
            "block",
            s("send", null, "proc"),
            s("args", s("mlhs", s("arg", "k"))),

            s(
              "send",
              s("send", s("array", ...key_strings), "includes", s("lvar", "k")),
              "!"
            )
          )
        )
      ))
    } else if (method === "delete" && args.length === 1) {
      if (!target) {
        // Bare delete(x): convert to JS delete only if arg is a property
        // access (has a target, e.g., a.x) or an ivar/gvar. A bare method
        // call (no target, e.g., session_url) is likely HTTP DELETE verb
        // in Rails tests — leave for other filters to handle.
        arg = args[0];

        if (arg.type === "send" && arg.children[0]) {
          return this.process(this.S("undef", arg))
        } else if (["ivar", "gvar", "lvar"].includes(arg.type)) {
          return this.process(this.S("undef", arg))
        } else {
          return this._parent.on_send.call(this, node)
        }
      } else if (args[0].type === "str") {
        key = args[0].children[0];

        return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? this.process(this.S(
          "undef",
          this.S("attr", target, key)
        )) : this.process(this.S(
          "undef",
          this.S("send", target, "[]", args[0])
        ))
      } else {
        return this.process(this.S(
          "undef",
          this.S("send", target, "[]", args[0])
        ))
      }
    } else if (method === "dig" && args.length >= 1 && target) {
      // hash.dig(:a, :b) => hash?.[a]?.[b] (optional chaining)
      result = target;

      for (let arg of args) {
        result = s("csend", result, "[]", arg)
      };

      return this.process(result)
    } else if (method === "to_s") {
      return this._options.nullish_to_s && this.es2020 && args.length === 0 ? this.process(this.S(
        "call",
        s("begin", s("nullish", target, s("str", ""))),
        "toString"
      )) : this.process(this.S("call", target, "toString", ...args))
    } else if (method === "Array" && target == null) {
      return this.process(this.S(
        "send",
        s("const", null, "Array"),
        "from",
        ...args
      ))
    } else if (method === "String" && target == null && args.length === 1) {
      return this._options.nullish_to_s && this.es2020 ? node.updated(
        null,

        [
          null,
          "String",
          s("begin", s("nullish", this.process(args[0]), s("str", "")))
        ]
      ) : this._parent.on_send.call(this, node)
    } else if (method === "to_i") {
      return this.process(node.updated(
        "send",
        [null, "parseInt", target, ...args]
      ))
    } else if (method === "to_f") {
      return this.process(node.updated(
        "send",
        [null, "parseFloat", target, ...args]
      ))
    } else if (method === "to_json") {
      return this.process(node.updated(
        "send",
        [s("const", null, "JSON"), "stringify", target, ...args]
      ))
    } else if (method === "sub" && args.length === 2) {
      if (args[1].type === "str") {
        args[1] = s("str", args[1].children[0].replaceAll(/\\(\d)/g, "$$1"))
      };

      return this.process(node.updated(null, [target, "replace", ...args]))
    } else if (["sub!", "gsub!"].includes(method)) {
      method = `${(method ?? "").toString().slice(0, -1) ?? ""}`;

      if (Object.keys(Functions.VAR_TO_ASSIGN).includes(target.type)) {
        return this.process(this.S(
          Functions.VAR_TO_ASSIGN[target.type],
          target.children[0],
          this.S("send", target, method, ...node.children.slice(2))
        ))
      } else if (target.type === "send") {
        return target.children[0] == null ? this.process(this.S(
          "lvasgn",
          target.children[1],

          this.S(
            "send",
            this.S("lvar", target.children[1]),
            method,
            ...node.children.slice(2)
          )
        )) : this.process(this.S(
          "send",
          target.children[0],
          `${target.children[1] ?? ""}=`,
          this.S("send", target, method, ...node.children.slice(2))
        ))
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "scan" && args.length === 1) {
      arg = args[0];

      if (arg.type === "str") {
        arg = arg.updated(
          "regexp",
          [s("str", RegExp.escape(arg.children[0])), s("regopt")]
        )
      };

      if (arg.type === "regexp") {
        pattern = arg.children[0].children[0];
        pattern = pattern.replaceAll(/\\./g, "").replaceAll(/\[.*\]/g, "");

        gpattern = arg.updated("regexp", [
          ...arg.children.slice(0, -1),
          s("regopt", "g", ...arg.children.at(-1).children)
        ])
      } else {
        gpattern = s(
          "send",
          s("const", null, "RegExp"),
          "new",
          arg,
          s("str", "g")
        )
      };

      if (arg.type !== "regexp" || pattern.includes("(")) {
        return this.es2020 ? s(
          "send",
          s("const", null, "Array"),
          "from",
          s("send", this.process(target), "matchAll", gpattern),

          s(
            "block",
            s("send", null, "proc"),
            s("args", s("arg", "s")),
            s("send", s("lvar", "s"), "slice", s("int", 1))
          )
        ) : s(
          "block",

          s(
            "send",

            s(
              "or",
              s("send", this.process(target), "match", gpattern),
              s("array")
            ),

            "map"
          ),

          s("args", s("arg", "s")),

          s("return", s(
            "send",
            s("send", s("lvar", "s"), "match", arg),
            "slice",
            s("int", 1)
          ))
        )
      } else {
        return this.S("send", this.process(target), "match", gpattern)
      }
    } else if (method === "scan" && args.length === 2 && args[1].type === "block") {
      // str.scan(/pattern/) { |match| ... } with capturing groups
      // Convert to: for (let $_ of str.matchAll(/pattern/g)) { let match = $_.slice(1); ... }
      arg = args[0];
      callback = args[1];

      if (arg.type === "regexp") {
        gpattern = arg.updated("regexp", [
          ...arg.children.slice(0, -1),
          s("regopt", "g", ...arg.children.at(-1).children)
        ])
      } else {
        gpattern = s(
          "send",
          s("const", null, "RegExp"),
          "new",
          this.process(arg),
          s("str", "g")
        )
      };

      // Extract block args and body
      block_args = callback.children[1];
      block_body = callback.children[2];

      // Build: for (let $_ of str.matchAll(/pattern/g)) { let match = $_.slice(1); body }
      match_var = "$_";
      block_arg_name = block_args.children[0]?.children[0] ?? "match";

      return s(
        "for_of",
        s("lvasgn", match_var),
        s("send", this.process(target), "matchAll", gpattern),

        s(
          "begin",

          s(
            "lvasgn",
            block_arg_name,
            s("send", s("lvar", match_var), "slice", s("int", 1))
          ),

          this.process(block_body)
        )
      )
    } else if (method === "gsub" && args.length === 2) {
      let [before, after] = args;

      if (before.type === "regexp") {
        before = before.updated("regexp", [
          ...before.children.slice(0, -1),
          s("regopt", "g", ...before.children.at(-1).children)
        ])
      } else if (before.type === "str" && !this.es2021) {
        before = before.updated(
          "regexp",
          [s("str", RegExp.escape(before.children[0])), s("regopt", "g")]
        )
      };

      if (after.type === "str") {
        after = s("str", after.children[0].replaceAll(/\\(\d)/g, "$$1"))
      };

      return this.es2021 ? this.process(node.updated(
        null,
        [target, "replaceAll", before, after]
      )) : this.process(node.updated(
        null,
        [target, "replace", before, after]
      ))
    } else if (method === "ord" && args.length === 0) {
      return target.type === "str" ? this.process(this.S(
        "int",
        target.children.at(-1).charCodeAt(0)
      )) : this.process(this.S("send", target, "charCodeAt", s("int", 0)))
    } else if (method === "getbyte" && args.length === 1) {
      return this.process(this.S("send", target, "charCodeAt", ...args))
    } else if (method === "chr" && args.length === 0) {
      return target.type === "int" ? this.process(this.S(
        "str",
        String.fromCharCode(target.children.at(-1))
      )) : this.process(this.S(
        "send",
        s("const", null, "String"),
        "fromCharCode",
        target
      ))
    } else if (method === "size" && args.length === 0) {
      return this.process(this.S("attr", target, "length"))
    } else if (method === "empty?" && args.length === 0) {
      return this.process(this.S(
        "send",
        this.S("attr", target, "length"),
        "==",
        s("int", 0)
      ))
    } else if (method === "nil?" && args.length === 0) {
      return target?.type === "lvar" && this._index_result_vars.has(target.children[0]) ? this.process(this.S(
        "send",
        target,
        "===",
        s("int", -1)
      )) : this.process(this.S("send", target, "==", s("nil")))
    } else if (method === "zero?" && args.length === 0) {
      return this.process(this.S("send", target, "===", s("int", 0)))
    } else if (method === "positive?" && args.length === 0) {
      return this.process(this.S("send", target, ">", s("int", 0)))
    } else if (method === "negative?" && args.length === 0) {
      return this.process(this.S("send", target, "<", s("int", 0)))
    } else if (method === "any?" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("attr", target, "length"),
        ">",
        s("int", 0)
      ))
    } else if (method === "all?" && args.length === 0) {
      return this.process(this.S(
        "send",
        target,
        "every",
        s("const", null, "Boolean")
      ))
    } else if (method === "none?" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("attr", target, "length"),
        "===",
        s("int", 0)
      ))
    } else if (["start_with?", "end_with?"].includes(method) && args.length >= 1) {
      js_method = method === "start_with?" ? "startsWith" : "endsWith";

      return args.length === 1 ? this.process(this.S(
        "send",
        target,
        js_method,
        ...args
      )) : this.process(this.S(
        "send",
        this.S("array", ...args),
        "some",

        this.S(
          "block",
          this.S("send", null, "proc"),
          this.S("args", this.S("arg", "_p")),
          this.S("send", target, js_method, this.S("lvar", "_p"))
        )
      ))
    } else if (method === "clear" && args.length === 0 && this.parens_or_included(
      node,
      method
    )) {
      return this.process(this.S("send", target, "length=", s("int", 0)))
    } else if (method === "replace" && args.length === 1) {
      return this.process(this.S(
        "begin",
        this.S("send", target, "length=", s("int", 0)),
        this.S("send", target, "push", s("splat", node.children[2]))
      ))
    } else if (method === "include?" && args.length === 1) {
      while (target.type === "begin" && target.children.length === 1) {
        target = target.children[0]
      };

      if (target.type === "irange") {
        return this.S(
          "and",
          s("send", args[0], ">=", target.children[0]),
          s("send", args[0], "<=", target.children.at(-1))
        )
      } else if (target.type === "erange") {
        return this.S(
          "and",
          s("send", args[0], ">=", target.children[0]),
          s("send", args[0], "<", target.children.at(-1))
        )
      } else {
        return this.process(this.S("send", target, "includes", args[0]))
      }
    } else if (method === "respond_to?" && args.length === 1) {
      return node.type === "csend" ? this.process(this.S(
        "and",
        this.S("send", target, "!=", s("nil")),
        this.S("in?", args[0], target)
      )) : this.process(this.S("in?", args[0], target))
    } else if (method === "send" && args.length >= 1) {
      // target.send(:method, arg1, arg2) => target.method(arg1, arg2)
      // target.send(method_var, arg1) => target[method_var](arg1)
      method_name = args[0];
      method_args = args.slice(1);

      return method_name.type === "sym" ? this.process(this.S(
        "send",
        target,
        method_name.children[0],
        ...method_args
      )) : this.process(this.S(
        "send!",
        this.S("send", target, "[]", method_name),
        null,
        ...method_args
      ))
    } else if (["has_key?", "key?", "member?"].includes(method) && args.length === 1) {
      return this.process(this.S("in?", args[0], target))
    } else if (method === "each") {
      callback = args[0];

      if (args.length === 1 && ["block", "def"].includes(callback?.type) && this.contains_plain_break(callback.children[2])) {
        callback_args = callback.children[1];
        variable = callback_args?.children[0];

        return variable?.type === "arg" ? this.process(this.S(
          "for_of",
          s("lvasgn", variable.children[0]),
          target,
          callback.children[2]
        )) : this.process(this.S("send", target, "forEach", ...args))
      } else {
        return this.process(this.S("send", target, "forEach", ...args))
      }
    } else if (method === "downcase" && args.length === 0) {
      return this.process(s("send!", target, "toLowerCase"))
    } else if (method === "upcase" && args.length === 0) {
      return this.process(s("send!", target, "toUpperCase"))
    } else if (method === "strip" && args.length === 0) {
      return this.process(s("send!", target, "trim"))
    } else if (method === "join" && args.length === 0) {
      return this.process(node.updated(
        null,
        [target, "join", s("str", "")]
      ))
    } else if (node.children[0] === null && node.children[1] === "puts") {
      return this.process(this.S(
        "send",
        s("attr", null, "console"),
        "log",
        ...args
      ))
    } else if (method === "first") {
      if (node.children.length === 2) {
        return this.process(this.S("send", target, "[]", s("int", 0)))
      } else if (node.children.length === 3) {
        return this.process(this.on_send(this.S(
          "send",
          target,
          "[]",
          s("erange", s("int", 0), node.children[2])
        )))
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "last") {
      if (node.children.length === 2) {
        return this.es2022 ? this.process(this.S(
          "send",
          target,
          "at",
          s("int", -1)
        )) : this.process(this.on_send(this.S(
          "send",
          target,
          "[]",
          s("int", -1)
        )))
      } else if (node.children.length === 3) {
        return this.process(this.S(
          "send",
          target,
          "slice",
          s("send", s("attr", target, "length"), "-", node.children[2]),
          s("attr", target, "length")
        ))
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "[]" && nodesEqual(
      target,
      s("const", null, "Hash")
    )) {
      return s(
        "send",
        s("const", null, "Object"),
        "fromEntries",
        ...this.process_all(args)
      )
    } else if (nodesEqual(target, s("const", null, "JSON"))) {
      if (method === "generate" || method === "dump") {
        return this.process(node.updated(
          null,
          [target, "stringify", ...args]
        ))
      } else if (method === "pretty_generate") {
        return this.process(node.updated(
          null,
          [target, "stringify", args[0], s("nil"), s("int", 2)]
        ))
      } else if (method === "parse" || method === "load") {
        return this._parent.on_send.call(this, node)
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (nodesEqual(target, s("const", null, "URI"))) {
      if (method === "join" && args.length >= 2) {
        // URI.join(base, relative) => new URL(relative, base)
        // For multiple args, chain: URI.join(a,b,c) => new URL(c, new URL(b, a))
        result = this.process(args[0]);

        for (let arg of args.slice(1)) {
          result = this.S(
            "send",
            s("const", null, "URL"),
            "new",
            this.process(arg),
            result
          )
        };

        return result
      } else if (method === "parse" && args.length === 1) {
        return this.process(this.S(
          "send",
          s("const", null, "URL"),
          "new",
          args[0]
        ))
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "[]") {
      // resolve negative literal indexes
      i = (index) => {
        if (index.type === "int" && index.children[0] < 0) {
          if (this.es2022) {
            return this.process(this.S("send", target, "at", index))
          } else {
            return this.process(this.S(
              "send",
              this.S("attr", target, "length"),
              "-",
              s("int", -index.children[0])
            ))
          }
        } else {
          return index
        }
      };

      index = args[0];

      if (!index) {
        return this._parent.on_send.call(this, node)
      } else if (index.type === "regexp") {
        return this.es2020 ? this.process(this.S(
          "csend",
          this.S("send", this.process(target), "match", index),
          "[]",
          args[1] ?? s("int", 0)
        )) : this.process(this.S(
          "send",

          s(
            "or",
            this.S("send", this.process(target), "match", index),
            s("array")
          ),

          "[]",
          args[1] ?? s("int", 0)
        ))
      } else if (args.length === 2) {
        // str[start, length] => str.slice(start, start + length)
        // Ruby's 2-arg slice: str[start, length] extracts length chars starting at start
        start = args[0];
        length = args[1];

        if (start.type === "int" && start.children[0] < 0) {
          // Handle negative start index (only for literal integers)
          start_expr = this.S(
            "send",
            this.S("attr", target, "length"),
            "-",
            s("int", -start.children[0])
          )
        } else {
          start_expr = start
        };

        end_expr = this.S("send", start_expr, "+", length);

        return this.process(this.S(
          "send",
          target,
          "slice",
          start_expr,
          end_expr
        ))
      } else if (node.children.length !== 3) {
        return this._parent.on_send.call(this, node)
      } else if (index.type === "int" && index.children[0] < 0) {
        return this.process(this.S("send", target, "[]", i(index)))
      } else if (index.type === "erange") {
        [start, finish] = index.children;

        if (!finish) {
          return this.process(this.S("send", target, "slice", start))
        } else if (finish.type === "int") {
          return this.process(this.S("send", target, "slice", i(start), finish))
        } else {
          return this.process(this.S(
            "send",
            target,
            "slice",
            i(start),
            i(finish)
          ))
        }
      } else if (index.type === "irange") {
        [start, finish] = index.children;

        if (finish && finish.type === "int") {
          final = this.S("int", finish.children[0] + 1)
        } else {
          final = this.S("send", finish, "+", s("int", 1))
        };

        return !finish || finish.children[0] === -1 ? this.process(this.S(
          "send",
          target,
          "slice",
          start
        )) : this.process(this.S("send", target, "slice", start, final))
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "slice!" && args.length === 1) {
      arg = args[0];

      if (arg.type === "irange") {
        // input: a.slice!(start..-1)
        // output: a.splice(start)
        [start, finish] = arg.children;

        if (finish?.type === "int" && finish.children[0] === -1) {
          return this.process(this.S(
            "send",
            target,
            "splice",
            this.process(start)
          ))
        } else {
          // input: a.slice!(start..finish)
          // output: a.splice(start, finish - start + 1)
          len = this.S(
            "send",
            this.S("send", this.process(finish), "-", this.process(start)),
            "+",
            s("int", 1)
          );

          return this.process(this.S(
            "send",
            target,
            "splice",
            this.process(start),
            len
          ))
        }
      } else if (arg.type === "erange") {
        // input: a.slice!(start...finish)
        // output: a.splice(start, finish - start)
        [start, finish] = arg.children;

        if (finish) {
          len = this.S("send", this.process(finish), "-", this.process(start));

          return this.process(this.S(
            "send",
            target,
            "splice",
            this.process(start),
            len
          ))
        } else {
          return this.process(this.S(
            "send",
            target,
            "splice",
            this.process(start)
          ))
        }
      } else if (args.length === 1) {
        return this.process(this.S(
          "send",
          target,
          "splice",
          this.process(arg),
          s("int", 1)
        ))
      } else {
        return this.process(this.S(
          "send",
          target,
          "splice",
          ...this.process_all(args)
        ))
      }
    } else if (method === "reverse!" && this.parens_or_included(
      node,
      method
    )) {
      return this.process(this.S(
        "send",
        target,
        "splice",
        s("int", 0),
        s("attr", target, "length"),

        s(
          "splat",
          this.S("send", target, "reverse", ...node.children.slice(2))
        )
      ))
    } else if (method === "each_with_index") {
      return this.process(this.S("send", target, "forEach", ...args))
    } else if (method === "inspect" && args.length === 0) {
      return this.S(
        "send",
        s("const", null, "JSON"),
        "stringify",
        this.process(target)
      )
    } else if (method === "*" && target.type === "str") {
      return this.process(this.S("send", target, "repeat", args[0]))
    } else if (method === "*" && target.type === "array" && args.length === 1) {
      if (target.children.length === 1) {
        return this.process(this.S(
          "send",
          s("send", s("const", null, "Array"), null, args[0]),
          "fill",
          target.children[0]
        ))
      } else {
        // Multiple elements: Array.from({length: n}, () => [a, b]).flat()
        // Array.from with length object and mapper, then flatten
        // Use send! to force method call syntax (with parens)
        length_obj = s("hash", s("pair", s("sym", "length"), args[0]));
        mapper = s("block", s("send", null, "proc"), s("args"), target);

        return this.process(this.S(
          "send!",
          s("send", s("const", null, "Array"), "from", length_obj, mapper),
          "flat"
        ))
      }
    } else if (method === "+" && args.length === 1 && (target.type === "array" || args[0].type === "array")) {
      // Array concatenation when either side is known to be an array.
      // Check for array-typed sentinels (s(:array, s(:cast, expr))) — these
      // wrap async expressions (e.g., await pluck()) and need spread syntax
      // to avoid await precedence issues with .concat() chaining.
      has_sentinel = [target, args[0]].some(n => (
        n.type === "array" && n.children.length === 1 && typeof n.children[0] === "object" && n.children[0] != null && "type" in n.children[0] && n.children[0].type === "cast"
      ));

      return has_sentinel ? this.process(s(
        "array",
        s("splat", target),
        s("splat", args[0])
      )) : this.process(this.S("send", target, "concat", args[0]))
    } else if (["is_a?", "kind_of?"].includes(method) && args.length === 1) {
      if (args[0].type === "const") {
        parent = args[0].children.at(-1);

        if (parent === "Array") {
          return this.S(
            "send",
            s("const", null, "Array"),
            "isArray",
            this.process(target)
          )
        } else if (parent === "Integer") {
          return this.S(
            "and",

            s(
              "send",
              s("send", null, "typeof", this.process(target)),
              "===",
              s("str", "number")
            ),

            s(
              "send",
              s("const", null, "Number"),
              "isInteger",
              this.process(target)
            )
          )
        } else if (["Float", "Numeric"].includes(parent)) {
          return this.S(
            "send",
            s("send", null, "typeof", this.process(target)),
            "===",
            s("str", "number")
          )
        } else if (parent === "String") {
          return this.S(
            "send",
            s("send", null, "typeof", this.process(target)),
            "===",
            s("str", "string")
          )
        } else if (parent === "Symbol") {
          return this.S(
            "send",
            s("send", null, "typeof", this.process(target)),
            "===",
            s("str", "symbol")
          )
        } else if (parent === "Hash") {
          return this.S(
            "and",

            s(
              "and",

              s(
                "send",
                s("send", null, "typeof", this.process(target)),
                "===",
                s("str", "object")
              ),

              s("send", this.process(target), "!==", s("nil"))
            ),

            s(
              "send",
              s("send", s("const", null, "Array"), "isArray", this.process(target)),
              "!"
            )
          )
        } else if (parent === "NilClass") {
          return this.S(
            "or",
            s("send", this.process(target), "===", s("nil")),
            s("send", this.process(target), "===", s("send", null, "undefined"))
          )
        } else if (parent === "TrueClass") {
          return this.S("send", this.process(target), "===", s("true"))
        } else if (parent === "FalseClass") {
          return this.S("send", this.process(target), "===", s("false"))
        } else if (parent === "Boolean") {
          return this.S(
            "send",
            s("send", null, "typeof", this.process(target)),
            "===",
            s("str", "boolean")
          )
        } else if (parent === "Proc" || parent === "Function") {
          return this.S(
            "send",
            s("send", null, "typeof", this.process(target)),
            "===",
            s("str", "function")
          )
        } else if (parent === "Regexp") {
          return this.S(
            "instanceof",
            this.process(target),
            s("const", null, "RegExp")
          )
        } else if (parent === "Exception" || parent === "Error") {
          return this.S(
            "instanceof",
            this.process(target),
            s("const", null, "Error")
          )
        } else {
          return this.S("instanceof", this.process(target), args[0])
        }
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (method === "instance_of?" && args.length === 1) {
      if (args[0].type === "const") {
        parent = args[0].children.at(-1);

        if (parent === "Array") {
          return this.S(
            "send",
            s("attr", target, "constructor"),
            "===",
            s("const", null, "Array")
          )
        } else if (parent === "Integer") {
          return this.S(
            "and",

            s(
              "and",

              s(
                "send",
                s("send", null, "typeof", target),
                "===",
                s("str", "number")
              ),

              s("send", s("const", null, "Number"), "isInteger", target)
            ),

            s("send", s("send", target, "%", s("int", 1)), "===", s("int", 0))
          )
        } else if (["Float", "Numeric"].includes(parent)) {
          return this.S(
            "and",

            s(
              "send",
              s("send", null, "typeof", target),
              "===",
              s("str", "number")
            ),

            s(
              "send",
              s("send", s("const", null, "Number"), "isInteger", target),
              "!"
            )
          )
        } else if (parent === "String") {
          return this.S(
            "send",
            s("send", null, "typeof", target),
            "===",
            s("str", "string")
          )
        } else if (parent === "Symbol") {
          return this.S(
            "send",
            s("send", null, "typeof", target),
            "===",
            s("str", "symbol")
          )
        } else if (parent === "Hash") {
          return this.S(
            "send",
            s("attr", target, "constructor"),
            "===",
            s("const", null, "Object")
          )
        } else if (parent === "NilClass") {
          return this.S(
            "or",
            s("send", target, "===", s("nil")),
            s("send", target, "===", s("send", null, "undefined"))
          )
        } else if (parent === "TrueClass") {
          return this.S("send", target, "===", s("true"))
        } else if (parent === "FalseClass") {
          return this.S("send", target, "===", s("false"))
        } else if (parent === "Boolean") {
          return this.S(
            "send",
            s("send", null, "typeof", target),
            "===",
            s("str", "boolean")
          )
        } else if (parent === "Proc" || parent === "Function") {
          return this.S(
            "send",
            s("send", null, "typeof", target),
            "===",
            s("str", "function")
          )
        } else if (parent === "Regexp") {
          return this.S(
            "send",
            s("attr", target, "constructor"),
            "===",
            s("const", null, "RegExp")
          )
        } else if (parent === "Exception" || parent === "Error") {
          return this.S(
            "send",
            s("attr", target, "constructor"),
            "===",
            s("const", null, "Error")
          )
        } else {
          return this.S(
            "send",
            s("attr", target, "constructor"),
            "===",
            args[0]
          )
        }
      } else {
        return this._parent.on_send.call(this, node)
      }
    } else if (target && target.type === "send" && target.children[1] === "delete") {
      return this.S(
        "send",
        target.updated("sendw"),
        ...node.children.slice(1)
      )
    } else if (method === "entries" && args.length === 0 && this.parens_or_included(
      node,
      method
    )) {
      return this.process(node.updated(
        null,
        [s("const", null, "Object"), "entries", target]
      ))
    } else if (method === "values" && args.length === 0 && this.parens_or_included(
      node,
      method
    )) {
      return this.process(node.updated(
        null,
        [s("const", null, "Object"), "values", target]
      ))
    } else if (method === "rjust") {
      return this.process(node.updated(null, [target, "padStart", ...args]))
    } else if (method === "ljust") {
      return this.process(node.updated(null, [target, "padEnd", ...args]))
    } else if (method === "flatten" && args.length === 0) {
      return this.process(node.updated(
        null,
        [target, "flat", s("lvar", "Infinity")]
      ))
    } else if (method === "compact" && args.length === 0) {
      return this.process(s("send", target, "filter", s(
        "block",
        s("send", null, "proc"),
        s("args", s("arg", "x")),
        s("send", s("lvar", "x"), "!=", s("nil"))
      )))
    } else if (method === "compact!" && args.length === 0) {
      return this.process(s(
        "send",
        target,
        "splice",
        s("int", 0),
        s("attr", target, "length"),

        s("splat", s("send", target, "filter", s(
          "block",
          s("send", null, "proc"),
          s("args", s("arg", "x")),
          s("send", s("lvar", "x"), "!=", s("nil"))
        )))
      ))
    } else if (method === "uniq" && args.length === 0) {
      return this.process(s(
        "array",
        s("splat", s("send", s("const", null, "Set"), "new", target))
      ))
    } else if (method === "uniq!" && args.length === 0) {
      return this.process(s(
        "send",
        target,
        "splice",
        s("int", 0),
        s("attr", target, "length"),
        s("splat", s("send", s("const", null, "Set"), "new", target))
      ))
    } else if (method === "rotate") {
      if (args.length === 0) {
        return this.process(s(
          "array",
          s("splat", s("send", target, "slice", s("int", 1))),
          s("send", target, "[]", s("int", 0))
        ))
      } else if (args.length === 1) {
        return this.process(s(
          "array",
          s("splat", s("send", target, "slice", args[0])),
          s("splat", s("send", target, "slice", s("int", 0), args[0]))
        ))
      }
    } else if (method === "to_h" && args.length === 0) {
      return this.process(node.updated(
        null,
        [s("const", null, "Object"), "fromEntries", target]
      ))
    } else if (method === "rstrip") {
      return this.process(node.updated(null, [target, "trimEnd", ...args]))
    } else if (method === "lstrip" && args.length === 0) {
      return this.process(s("send!", target, "trimStart"))
    } else if (method === "index" && this.parens_or_included(
      node,
      method
    )) {
      return args.length === 1 && args[0].type === "regexp" ? this.process(node.updated(
        null,
        [target, "search", ...args]
      )) : this.process(node.updated(null, [target, "indexOf", ...args]))
    } else if (method === "rindex" && this.parens_or_included(
      node,
      method
    ) && !args.some(arg => arg.type === "block_pass")) {
      return this.process(node.updated(
        null,
        [target, "lastIndexOf", ...args]
      ))
    } else if (method === "class" && args.length === 0 && !node.is_method()) {
      return this.process(node.updated("attr", [target, "constructor"]))
    } else if (method === "superclass" && args.length === 0 && target?.type === "const" && !node.is_method()) {
      return this.process(this.S(
        "attr",

        s(
          "send",
          s("const", null, "Object"),
          "getPrototypeOf",
          s("attr", target, "prototype")
        ),

        "constructor"
      ))
    } else if (method === "new" && nodesEqual(
      target,
      s("const", null, "Exception")
    )) {
      return this.process(this.S(
        "send",
        s("const", null, "Error"),
        "new",
        ...args
      ))
    } else if (method === "escape" && nodesEqual(
      target,
      s("const", null, "Regexp")
    ) && this.es2025) {
      return this.process(this.S(
        "send",
        s("const", null, "RegExp"),
        "escape",
        ...args
      ))
    } else if (method === "block_given?" && target == null && args.length === 0) {
      return this.process(this.process(s("lvar", "_implicitBlockYield")))
    } else if (method === "abs" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("const", null, "Math"),
        "abs",
        target
      ))
    } else if (method === "round" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("const", null, "Math"),
        "round",
        target
      ))
    } else if (method === "round" && args.length === 1 && !nodesEqual(
      target,
      s("const", null, "Math")
    )) {
      // round(n) -> Math.round(x * 10**n) / 10**n
      arg = this.process(args[0]);
      ptarget = this.process(target);
      multiplier = this.S("send", s("int", 10), "**", arg);
      scaled = this.S("send", ptarget, "*", multiplier);
      rounded = this.S("send", s("const", null, "Math"), "round", scaled);
      return this.S("send", rounded, "/", multiplier)
    } else if (method === "ceil" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("const", null, "Math"),
        "ceil",
        target
      ))
    } else if (method === "floor" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("const", null, "Math"),
        "floor",
        target
      ))
    } else if (method === "rand" && target == null) {
      if (args.length === 0) {
        return this.process(this.S(
          "send!",
          s("const", null, "Math"),
          "random"
        ))
      } else if (["irange", "erange"].includes(args[0].type)) {
        range = args[0];
        multiplier = s("send", range.children.at(-1), "-", range.children[0]);

        if (range.children.every(child => child.type === "int")) {
          multiplier = s(
            "int",
            range.children.at(-1).children.at(-1) - range.children[0].children.at(-1)
          );

          if (range.type === "irange") multiplier = s("int", multiplier.children[0] + 1)
        } else if (range.type === "irange") {
          if (multiplier.children.at(-1).type === "int") {
            let diff = multiplier.children.at(-1).children.at(-1) - 1;

            multiplier = s(
              "send",
              ...multiplier.children.slice(0, 2),
              s("int", diff)
            );

            if (diff === 0) multiplier = multiplier.children[0];

            if (diff < 0) {
              multiplier = s("send", multiplier.children[0], "+", s("int", -diff))
            }
          } else {
            multiplier = s("send", multiplier, "+", s("int", 1))
          }
        };

        raw = s(
          "send",
          s("send", s("const", null, "Math"), "random"),
          "*",
          multiplier
        );

        first = range.children[0];

        if (first.type !== "int" || first.children[0] !== 0) {
          raw = s("send", raw, "+", first)
        };

        return this.process(this.S("send", null, "parseInt", raw))
      } else {
        return this.process(this.S("send", null, "parseInt", s(
          "send",
          s("send", s("const", null, "Math"), "random"),
          "*",
          args[0]
        )))
      }
    } else if (method === "sum" && args.length === 0) {
      return this.process(this.S(
        "send",
        target,
        "reduce",

        s(
          "block",
          s("send", null, "proc"),
          s("args", s("arg", "a"), s("arg", "b")),
          s("send", s("lvar", "a"), "+", s("lvar", "b"))
        ),

        s("int", 0)
      ))
    } else if (["reduce", "inject"].includes(method) && args.length === 1 && args[0].type === "sym") {
      // reduce(:+) → reduce((a, b) => a + b)
      // reduce(:merge) → reduce((a, b) => ({...a, ...b}))
      op = args[0].children[0];

      return op === "merge" ? this.process(this.S(
        "send",
        target,
        "reduce",

        s(
          "block",
          s("send", null, "proc"),
          s("args", s("arg", "a"), s("arg", "b")),
          s("hash", s("kwsplat", s("lvar", "a")), s("kwsplat", s("lvar", "b")))
        )
      )) : this.process(this.S("send", target, "reduce", s(
        "block",
        s("send", null, "proc"),
        s("args", s("arg", "a"), s("arg", "b")),
        s("send", s("lvar", "a"), op, s("lvar", "b"))
      )))
    } else if (method === "method_defined?" && args.length >= 1) {
      if (nodesEqual(args[1], s("false"))) {
        return this.process(this.S(
          "send",
          s("attr", target, "prototype"),
          "hasOwnProperty",
          args[0]
        ))
      } else if (args.length === 1 || nodesEqual(args[1], s("true"))) {
        return this.process(this.S(
          "in?",
          args[0],
          s("attr", target, "prototype")
        ))
      } else {
        return this.process(this.S(
          "if",
          args[1],
          s("in?", args[0], s("attr", target, "prototype")),
          s("send", s("attr", target, "prototype"), "hasOwnProperty", args[0])
        ))
      }
    } else if (method === "alias_method" && args.length === 2) {
      return this.process(this.S(
        "send",
        s("attr", target, "prototype"),
        "[]=",
        args[0],
        s("attr", s("attr", target, "prototype"), args[1].children[0])
      ))
    } else if (method === "new" && args.length === 2 && nodesEqual(
      target,
      s("const", null, "Array")
    )) {
      return s(
        "send",
        this.S("send", target, "new", args[0]),
        "fill",
        args.at(-1)
      )
    } else if (method === "freeze" && args.length === 0) {
      return this.process(this.S(
        "send",
        s("const", null, "Object"),
        "freeze",
        target ?? s("self")
      ))
    } else if (method === "to_sym" && args.length === 0) {
      return this.process(target)
    } else if (method === "reject" && args.length === 1 && args[0]?.type === "block_pass") {
      // .reject(&:method) → .filter with negated block
      // reject(&:empty?) → filter(item => !item.empty())
      block_pass = args[0];

      if (block_pass.children[0]?.type === "sym") {
        let method_sym = block_pass.children[0].children[0];
        arg = s("arg", "item");

        body = s(
          "send",
          s("begin", s("send", s("lvar", "item"), method_sym)),
          "!"
        );

        let new_block = s(
          "block",
          s("send", target, "filter"),
          s("args", arg),
          s("autoreturn", body)
        );

        return this.process(new_block)
      };

      return this._parent.on_send.call(this, node)
    } else if (method === "chars" && args.length === 0) {
      return this.S("send", s("const", null, "Array"), "from", target)
    } else if (method === "method" && target == null && args.length === 1) {
      // method(:name) => this.name.bind(this) or this[name].bind(this)
      name_arg = args[0];

      return name_arg.type === "sym" ? this.process(this.S(
        "send",
        s("attr", s("self"), name_arg.children[0]),
        "bind",
        s("self")
      )) : this.process(this.S(
        "send",
        s("send", s("self"), "[]", name_arg),
        "bind",
        s("self")
      ))
    } else {
      return this._parent.on_send.call(this, node)
    }
  };

  on_block(node) {
    let args, body, block, target, map_block, processed_call, receiver, entries_call, processed_args, is_hash, children, setup, last_stmt, processed_setup, processed_last, negated_last, new_body, processed_body, negated_body, some_result, block_body, item_to_push, reduce_arg, arg_name, callback_args, callback, acc_get, acc_get_or_empty, reduce_body, reduce_block, all_names, key_a, key_b, comparison, compare_args, compare_block, prefix, key_expr, prefix_a, key_expr_a, prefix_b, key_expr_b, range, start_node, end_node, length, temp_var, callback_body, transformed_body, count, result, step, lvasgn, args_children, first_arg, index_arg, item_assign;
    let call = node.children[0];
    let method = call.children[1];
    if (excluded(method)) return this._parent.on_block.call(this, node);

    // Function.new { } => function() {} (regular function, not arrow)
    // This is needed when you need dynamic `this` binding (e.g., for filter composition)
    // Note: Use element-by-element comparison for JS compatibility (JS compares arrays by reference)
    if (call.children[0]?.type === "const" && call.children[0].children[0] == null && call.children[0].children[1] === "Function" && method === "new") {
      args = node.children[1];
      body = node.children[2];

      // Use :deff to force regular function syntax instead of arrow function
      return this.process(node.updated("deff", [null, args, body]))
    };

    // A break inside an each callback cannot be emitted inside
    // Array#forEach. Lower this particular form to a real JavaScript
    // for..of loop, whose break has the same control-flow scope as Ruby.
    if (method === "each" && node.children[1]?.children?.length === 1 && this.contains_plain_break(node.children[2])) {
      let variable = node.children[1].children[0];

      if (variable?.type === "arg") {
        return this.process(this.S(
          "for_of",
          s("lvasgn", variable.children[0]),
          call.children[0],
          node.children[2]
        ))
      }
    };

    if (["setInterval", "setTimeout", "set_interval", "set_timeout"].includes(method)) {
      if (call.children[0] != null) return this._parent.on_block.call(this, node);

      block = this.process(s(
        "block",
        s("send", null, "proc"),
        ...node.children.slice(1)
      ));

      return this.on_send(call.updated(
        null,
        [...call.children.slice(0, 2), block, ...call.children.slice(2)]
      ))
    } else if (["sub", "gsub", "sub!", "gsub!", "sort!"].includes(method)) {
      if (call.children[0] == null) return this._parent.on_block.call(this, node);

      block = s(
        "block",
        s("send", null, "proc"),
        node.children[1],
        s("autoreturn", ...node.children.slice(2))
      );

      return this.process(call.updated(null, [...call.children, block]))
    } else if (method === "to_h" && call.children.length === 2) {
      // arr.to_h { |x| [k, v] } => Object.fromEntries(arr.map(x => [k, v]))
      target = call.children[0];

      map_block = s(
        "block",
        s("send", target, "map"),
        node.children[1],
        s("autoreturn", ...node.children.slice(2))
      );

      return this.process(s(
        "send",
        s("const", null, "Object"),
        "fromEntries",
        map_block
      ))
    } else if (method === "compact" && call.children.length === 2) {
      // compact with a block is NOT the array compact method
      // (e.g., serializer.compact { ... } should not become filter)
      // Skip on_send processing by constructing the call node directly
      target = call.children[0];

      processed_call = call.updated(
        null,
        [this.process(target), "compact"]
      );

      return node.updated(null, [
        processed_call,
        this.process(node.children[1]),
        ...this.process_all(node.children.slice(2))
      ])
    } else if (["select", "find_all"].includes(method) && call.children.length === 2) {
      // Hash receiver with 2+ args: Object.entries(hash).filter(([k, v]) => ...)
      receiver = call.children[0];
      args = node.children[1];

      if (args && args.children.length > 1 && this.hash_node(receiver)) {
        entries_call = s(
          "send",
          s("const", null, "Object"),
          "entries",
          receiver
        );

        call = call.updated(null, [entries_call, "filter"]);
        processed_args = s("args", s("mlhs", ...args.children))
      } else {
        call = call.updated(null, [call.children[0], "filter"]);
        processed_args = this.process(node.children[1])
      };

      return node.updated(null, [
        this.process(call),
        processed_args,
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "reject" && call.children.length === 2) {
      // arr.reject { |x| cond } => arr.filter(x => !(cond))
      // Hash receiver with 2+ args: Object.entries(hash).filter(([k, v]) => !(cond))
      receiver = call.children[0];
      args = node.children[1];
      is_hash = args && args.children.length > 1 && this.hash_node(receiver);

      if (is_hash) {
        entries_call = s(
          "send",
          s("const", null, "Object"),
          "entries",
          receiver
        );

        call = call.updated(null, [entries_call, "filter"])
      } else {
        call = call.updated(null, [call.children[0], "filter"])
      };

      processed_args = is_hash ? s("args", s("mlhs", ...args.children)) : this.process(node.children[1]);
      body = node.children[2];

      if (body?.type === "begin" && body.children.length > 1) {
        // Multi-statement block: negate only the last statement
        // Use explicit slicing instead of splat to avoid selfhost transpilation issues
        children = body.children;
        setup = children.slice(0, -1) // All but last;
        last_stmt = children.at(-1) // Last element;
        processed_setup = this.process_all(setup);
        processed_last = this.process(last_stmt);
        negated_last = s("send", s("begin", processed_last), "!");
        new_body = s("begin", ...processed_setup, negated_last);

        return node.updated(
          null,
          [this.process(call), processed_args, s("autoreturn", new_body)]
        )
      } else {
        // Single-statement block: negate the whole thing
        processed_body = this.process_all(node.children.slice(2));
        negated_body = s("send", s("begin", ...processed_body), "!");

        return node.updated(
          null,
          [this.process(call), processed_args, s("autoreturn", negated_body)]
        )
      }
    } else if (method === "any?" && call.children.length === 2) {
      call = call.updated(null, [call.children[0], "some"]);

      return node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "all?" && call.children.length === 2) {
      call = call.updated(null, [call.children[0], "every"]);

      return node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "none?" && call.children.length === 2) {
      // arr.none? { |x| cond } => !arr.some(x => cond)
      call = call.updated(null, [call.children[0], "some"]);

      some_result = node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ]);

      return s("send", some_result, "!")
    } else if (method === "find" && call.children.length === 2) {
      return node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "flat_map" && call.children.length === 2) {
      // Ruby's flat_map → JavaScript's flatMap
      call = call.updated(null, [call.children[0], "flatMap"]);

      return node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "group_by" && call.children.length === 2) {
      // array.group_by { |x| x.category }
      // array.group_by { |k, v| k.to_s }  # with destructuring
      target = call.children[0];
      args = node.children[1];
      if (!args) return this._parent.on_block.call(this, node) // Ruby 3.4 it blocks handled by converter;
      block_body = node.children[2];

      // Unwrap :return node from &:symbol syntax (processor.rb wraps in return)
      if (block_body?.type === "return") block_body = block_body.children[0];

      // Check if we have multiple args (destructuring case)
      if (args.children.length > 1) {
        // Multiple args: use destructuring and push the whole item as array
        // Create mlhs for destructuring: ([a, b]) => ...
        let mlhs_arg = s("mlhs", ...args.children);

        // Push the reconstructed array [a, b] (handles nested mlhs)
        item_to_push = s(
          "array",
          ...args.children.map(arg => this.arg_to_lvar_expr(arg))
        );

        reduce_arg = s("args", s("arg", "$acc"), mlhs_arg)
      } else {
        // Single arg: simple case
        arg_name = args.children[0].children[0];
        item_to_push = s("lvar", arg_name);
        reduce_arg = s("args", s("arg", "$acc"), s("arg", arg_name))
      };

      if (this.es2024) {
        // ES2024+: Map.groupBy(array, x => x.category)
        // For destructuring, wrap args in mlhs: ([a, b]) => ...
        callback_args = args.children.length > 1 ? s(
          "args",
          s("mlhs", ...args.children)
        ) : node.children[1];

        callback = s(
          "block",
          s("send", null, "proc"),
          callback_args,
          s("autoreturn", ...node.children.slice(2))
        );

        return this.process(s(
          "send",
          s("const", null, "Map"),
          "groupBy",
          target,
          callback
        ))
      } else {
        // Pre-ES2024: array.reduce into a new Map
        // Build: acc.set(key, [...(acc.get(key) || []), item])
        acc_get = s("send", s("lvar", "$acc"), "get", s("lvar", "$key"));
        acc_get_or_empty = s("or", acc_get, s("array"));
        let get_and_push = s("send", acc_get_or_empty, "push", item_to_push);

        let set_call = s(
          "send",
          s("lvar", "$acc"),
          "set",
          s("lvar", "$key"),
          acc_get_or_empty
        );

        // Build the reduce block body
        reduce_body = s(
          "begin",
          s("lvasgn", "$key", block_body),

          s("send", s("lvar", "$acc"), "set", s("lvar", "$key"), s(
            "send",

            s(
              "or",
              s("send", s("lvar", "$acc"), "get", s("lvar", "$key")),
              s("array")
            ),

            "concat",
            s("array", item_to_push)
          )),

          s("return", s("lvar", "$acc"))
        );

        reduce_block = s(
          "block",
          s("send", null, "proc"),
          reduce_arg,
          reduce_body
        );

        return this.process(s(
          "send",
          target,
          "reduce",
          reduce_block,
          s("send", s("const", null, "Map"), "new")
        ))
      }
    } else if (method === "sort_by" && call.children.length === 2) {
      // array.sort_by { |x| x.name } => array.slice().sort((a, b) => ...)
      // With ES2023+: array.toSorted((a, b) => ...)
      target = call.children[0];
      args = node.children[1];
      if (!args) return this._parent.on_block.call(this, node) // Ruby 3.4 it blocks handled by converter;

      // Hash receiver with 2+ args: Object.entries(hash).sort_by(...)
      if ((args.children.length > 1 || args.children[0].type === "mlhs") && this.hash_node(target)) {
        target = s("send", s("const", null, "Object"), "entries", target)
      };

      block_body = node.children[2];

      // Unwrap :return node from &:symbol syntax (processor.rb wraps in return)
      if (block_body?.type === "return") block_body = block_body.children[0];

      // Create two argument sets for the comparison function.
      // Handle nested destructuring: |(pid, cid), _| has mlhs children
      all_names = this.collect_arg_names(args);

      // Replace references to all block args with _a and _b suffixed versions
      key_a = block_body;
      key_b = block_body;

      for (let name of all_names) {
        key_a = this.replace_lvar(key_a, name, `${name ?? ""}_a`);
        key_b = this.replace_lvar(key_b, name, `${name ?? ""}_b`)
      };

      // Build comparison: key_a < key_b ? -1 : key_a > key_b ? 1 : 0
      comparison = s(
        "if",
        s("send", key_a, "<", key_b),
        s("int", -1),
        s("if", s("send", key_a, ">", key_b), s("int", 1), s("int", 0))
      );

      // Build comparison function args with _a and _b suffixed names
      compare_args = s(
        "args",
        ...args.children.map(c => this.suffix_args(c, "_a")),
        ...args.children.map(c => this.suffix_args(c, "_b"))
      );

      // For destructuring, wrap each comparison arg in mlhs
      if (args.children.length > 1 || args.children[0].type === "mlhs") {
        let arg_a_parts = args.children.map(c => this.suffix_args(c, "_a"));
        let arg_b_parts = args.children.map(c => this.suffix_args(c, "_b"));

        compare_args = s(
          "args",
          s("mlhs", ...arg_a_parts),
          s("mlhs", ...arg_b_parts)
        )
      };

      compare_block = s(
        "block",
        s("send", null, "proc"),
        compare_args,
        s("autoreturn", comparison)
      );

      return this.es2023 ? this.process(s(
        "send",
        target,
        "toSorted",
        compare_block
      )) : this.process(s(
        "send",
        s("send!", target, "slice"),
        "sort",
        compare_block
      ))
    } else if (method === "max_by" && call.children.length === 2) {
      // array.max_by { |x| x.score } => array.reduce((a, b) => key(a) > key(b) ? a : b)
      target = call.children[0];
      args = node.children[1];
      if (!args) return this._parent.on_block.call(this, node) // Ruby 3.4 it blocks handled by converter;
      block_body = node.children[2];

      // Unwrap :return node from &:symbol syntax (processor.rb wraps in return)
      if (block_body?.type === "return") block_body = block_body.children[0];
      arg_name = args.children[0].children[0];

      if (block_body?.type === "begin") {
        // Multi-statement block: use temp variables to avoid
        // inlining statements into expression position
        prefix = block_body.children.slice(0, -1);
        key_expr = block_body.children.at(-1);
        prefix_a = prefix.map(stmt => this.replace_lvar(stmt, arg_name, "a"));
        key_expr_a = this.replace_lvar(key_expr, arg_name, "a");
        prefix_b = prefix.map(stmt => this.replace_lvar(stmt, arg_name, "b"));
        key_expr_b = this.replace_lvar(key_expr, arg_name, "b");

        comparison = s(
          "if",
          s("send", s("lvar", "_ka"), ">=", s("lvar", "_kb")),
          s("lvar", "a"),
          s("lvar", "b")
        );

        body = s(
          "begin",
          ...prefix_a,
          s("lvasgn", "_ka", key_expr_a),
          ...prefix_b,
          s("lvasgn", "_kb", key_expr_b),
          comparison
        )
      } else {
        key_a = this.replace_lvar(block_body, arg_name, "a");
        key_b = this.replace_lvar(block_body, arg_name, "b");

        body = s(
          "if",
          s("send", key_a, ">=", key_b),
          s("lvar", "a"),
          s("lvar", "b")
        )
      };

      reduce_block = s(
        "block",
        s("send", null, "proc"),
        s("args", s("arg", "a"), s("arg", "b")),
        s("autoreturn", body)
      );

      return this.process(s("send", target, "reduce", reduce_block))
    } else if (method === "min_by" && call.children.length === 2) {
      // array.min_by { |x| x.score } => array.reduce((a, b) => key(a) <= key(b) ? a : b)
      target = call.children[0];
      args = node.children[1];
      if (!args) return this._parent.on_block.call(this, node) // Ruby 3.4 it blocks handled by converter;
      block_body = node.children[2];

      // Unwrap :return node from &:symbol syntax (processor.rb wraps in return)
      if (block_body?.type === "return") block_body = block_body.children[0];
      arg_name = args.children[0].children[0];

      if (block_body?.type === "begin") {
        // Multi-statement block: use temp variables to avoid
        // inlining statements into expression position
        prefix = block_body.children.slice(0, -1);
        key_expr = block_body.children.at(-1);
        prefix_a = prefix.map(stmt => this.replace_lvar(stmt, arg_name, "a"));
        key_expr_a = this.replace_lvar(key_expr, arg_name, "a");
        prefix_b = prefix.map(stmt => this.replace_lvar(stmt, arg_name, "b"));
        key_expr_b = this.replace_lvar(key_expr, arg_name, "b");

        comparison = s(
          "if",
          s("send", s("lvar", "_ka"), "<=", s("lvar", "_kb")),
          s("lvar", "a"),
          s("lvar", "b")
        );

        body = s(
          "begin",
          ...prefix_a,
          s("lvasgn", "_ka", key_expr_a),
          ...prefix_b,
          s("lvasgn", "_kb", key_expr_b),
          comparison
        )
      } else {
        key_a = this.replace_lvar(block_body, arg_name, "a");
        key_b = this.replace_lvar(block_body, arg_name, "b");

        body = s(
          "if",
          s("send", key_a, "<=", key_b),
          s("lvar", "a"),
          s("lvar", "b")
        )
      };

      reduce_block = s(
        "block",
        s("send", null, "proc"),
        s("args", s("arg", "a"), s("arg", "b")),
        s("autoreturn", body)
      );

      return this.process(s("send", target, "reduce", reduce_block))
    } else if (method === "find_index" && call.children.length === 2) {
      call = call.updated(null, [call.children[0], "findIndex"]);

      return node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "index" && call.children.length === 2) {
      call = call.updated(null, [call.children[0], "findIndex"]);

      return node.updated(null, [
        this.process(call),
        this.process(node.children[1]),
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (method === "map" && call.children[0].type === "begin" && call.children[0].children.length === 1 && [
      "irange",
      "erange"
    ].includes(call.children[0].children[0].type) && node.children[1].children.length === 1) {
      range = call.children[0].children[0];
      start_node = range.children[0];
      end_node = range.children[1];
      arg_name = node.children[1].children[0].children[0];
      block_body = node.children[2];

      // Calculate length: end - start + 1 for irange, end - start for erange
      if (start_node.type === "int" && start_node.children[0] === 0) {
        // (0..n) or (0...n) - length is just end+1 or end
        length = range.type === "irange" ? s(
          "send",
          end_node,
          "+",
          s("int", 1)
        ) : end_node
      } else if (start_node.type === "int" && end_node.type === "int") {
        // Both are literals - compute length
        let len_val = end_node.children[0] - start_node.children[0];
        if (range.type === "irange") len_val++;
        length = s("int", len_val)
      } else if (start_node.type === "int" && start_node.children[0] === 1 && range.type === "irange") {
        // (1..n) - length is just n
        length = end_node
      } else {
        // General case: end - start + 1 (irange) or end - start (erange)
        length = s("send", end_node, "-", start_node);
        if (range.type === "irange") length = s("send", length, "+", s("int", 1))
      };

      if (start_node.type === "int" && start_node.children[0] === 0) {
        callback = s(
          "block",
          s("send", null, "proc"),
          s("args", s("arg", "_"), s("arg", arg_name)),
          s("autoreturn", block_body)
        );

        return this.process(s(
          "send",
          s("const", null, "Array"),
          "from",
          s("hash", s("pair", s("sym", "length"), length)),
          callback
        ))
      } else {
        // General case: need to offset the index
        // Array.from({length}, (_, $i) => { let i = $i + start; return ... })
        temp_var = `$${arg_name ?? ""}`;

        callback_body = s(
          "begin",

          s(
            "lvasgn",
            arg_name,
            s("send", s("lvar", temp_var), "+", start_node)
          ),

          s("autoreturn", block_body)
        );

        callback = s(
          "block",
          s("send", null, "proc"),
          s("args", s("arg", "_"), s("arg", temp_var)),
          callback_body
        );

        return this.process(s(
          "send",
          s("const", null, "Array"),
          "from",
          s("hash", s("pair", s("sym", "length"), length)),
          callback
        ))
      }
    } else if (["map", "collect"].includes(method) && call.children.length === 2) {
      // For destructuring (multiple args), wrap in mlhs: ([a, b]) => ...
      args = node.children[1];
      if (!args) return this._parent.on_block.call(this, node) // Ruby 3.4 it blocks handled by converter;

      // Normalize :collect to :map (Ruby aliases)
      if (method === "collect") call = call.updated(null, [call.children[0], "map"]);

      // Hash receiver with 2+ args: Object.entries(hash).map(([k, v]) => ...)
      receiver = call.children[0];

      if (args.children.length > 1 && this.hash_node(receiver)) {
        entries_call = s(
          "send",
          s("const", null, "Object"),
          "entries",
          receiver
        );

        call = call.updated(null, [entries_call, "map"])
      };

      processed_args = args.children.length > 1 ? s(
        "args",
        s("mlhs", ...args.children)
      ) : this.process(args);

      return node.updated(null, [
        this.process(call),
        processed_args,
        s("autoreturn", ...this.process_all(node.children.slice(2)))
      ])
    } else if (["map!", "collect!", "select!"].includes(method)) {
      // input: a.map! {expression}
      // output: a.splice(0, a.length, *a.map {expression})
      method = ["map!", "collect!"].includes(method) ? "map" : "select";
      target = call.children[0];

      return this.process(call.updated(
        "send",

        [target, "splice", s("splat", s(
          "send",
          s("array", s("int", 0), s("attr", target, "length")),
          "concat",

          s(
            "block",
            s("send", target, method, ...call.children.slice(2)),
            ...node.children.slice(1)
          )
        ))]
      ))
    } else if (nodesEqual(node.children[0], s("send", null, "loop")) && nodesEqual(
      node.children[1],
      s("args")
    )) {
      // input: loop {statements}
      // output: while(true) {statements}
      // If the loop contains break-with-value, wrap in IIFE and use return
      body = node.children[2];

      if (this.contains_break_with_value(body)) {
        // Wrap in IIFE: (() => { while(true) { ... return value ... } })()
        transformed_body = this.replace_breaks_with_returns(body);

        return s(
          "send",

          s(
            "block",
            s("send", null, "lambda"),
            s("args"),
            this.S("while", s("true"), this.process(transformed_body))
          ),

          "call"
        )
      } else {
        return this.S("while", s("true"), this.process(body))
      }
    } else if (method === "times" && call.children.length === 2) {
      // input: n.times { |i| ... }
      // output: for (let i = 0; i < n; i++) { ... }
      count = call.children[0];

      // If no block variable provided, create a dummy one
      if (node.children[1].children.length === 0) {
        args = s("args", s("arg", "_"))
      } else {
        args = node.children[1]
      };

      return this.process(node.updated(null, [
        s("send", s("begin", s("erange", s("int", 0), count)), "each"),
        args,
        node.children[2]
      ]))
    } else if (method === "delete") {
      // restore delete methods that are prematurely mapped to undef
      result = this._parent.on_block.call(this, node);

      if (result.children[0].type === "undef") {
        call = result.children[0].children[0];

        if (call.type === "attr") {
          call = call.updated(
            "send",
            [call.children[0], "delete", s("str", call.children[1])]
          );

          result = result.updated(null, [call, ...result.children.slice(1)])
        } else {
          call = call.updated(
            null,
            [call.children[0], "delete", ...call.children.slice(2)]
          );

          result = result.updated(null, [call, ...result.children.slice(1)])
        }
      };

      return result
    } else if (method === "downto") {
      range = s("irange", call.children[0], call.children[2]);
      call = call.updated(null, [s("begin", range), "step", s("int", -1)]);

      return this.process(node.updated(
        null,
        [call, ...node.children.slice(1)]
      ))
    } else if (method === "upto") {
      range = s("irange", call.children[0], call.children[2]);
      call = call.updated(null, [s("begin", range), "step", s("int", 1)]);

      return this.process(node.updated(
        null,
        [call, ...node.children.slice(1)]
      ))
    } else if (method === "step" && call.children[0].type === "begin" && call.children[0].children.length === 1 && [
      "irange",
      "erange"
    ].includes(call.children[0].children[0].type) && node.children[1].children.length === 1) {
      // (a..b).step(n) {|v| ...}
      range = call.children[0].children[0];
      step = call.children[2] ?? s("int", 1);

      return this.process(s(
        "for",
        s("lvasgn", node.children[1].children[0].children[0]),
        s("send", range, "step", step),
        node.children[2]
      ))
    } else if (method === "each" && call.children[0].type === "send" && call.children[0].children[1] === "step") {
      // i.step(j, n).each {|v| ...}
      range = call.children[0];
      step = range.children[3] ?? s("int", 1);

      call = call.updated(null, [
        s("begin", s("irange", range.children[0], range.children[2])),
        "step",
        step
      ]);

      return this.process(node.updated(
        null,
        [call, ...node.children.slice(1)]
      ))
    } else if (method === "each" && call.children[0].type === "begin" && call.children[0].children.length === 1 && [
      "irange",
      "erange"
    ].includes(call.children[0].children[0].type) && node.children[1].children.length <= 1) {
      lvasgn = node.children[1].children.length === 1 ? s(
        "lvasgn",
        node.children[1].children[0].children[0]
      ) : s("lvasgn", "_");

      return this.process(s(
        "for",
        lvasgn,
        call.children[0].children[0],
        node.children[2]
      ))
    } else if (["each", "each_value"].includes(method)) {
      if (node.children[1].children.length === 0) {
        return this.process(node.updated(
          "for_of",
          [s("lvasgn", "_"), node.children[0].children[0], node.children[2]]
        ))
      } else if (node.children[1].children.length > 1) {
        receiver = node.children[0].children[0];

        if (this.hash_node(receiver)) {
          receiver = s("send", s("const", null, "Object"), "entries", receiver)
        };

        return this.process(node.updated("for_of", [
          s(
            "mlhs",
            ...node.children[1].children.map(child => this.args_to_lvasgn(child))
          ),

          receiver,
          node.children[2]
        ]))
      } else if (node.children[1].children[0].type === "mlhs") {
        receiver = node.children[0].children[0];

        if (this.hash_node(receiver)) {
          receiver = s("send", s("const", null, "Object"), "entries", receiver)
        };

        return this.process(node.updated("for_of", [
          s("mlhs", ...node.children[1].children[0].children.map(child => (
            this.args_to_lvasgn(child)
          ))),

          receiver,
          node.children[2]
        ]))
      } else {
        return this.process(node.updated("for_of", [
          s("lvasgn", node.children[1].children[0].children[0]),
          node.children[0].children[0],
          node.children[2]
        ]))
      }
    } else if (method === "each_key" && ["each", "each_key"].includes(method) && node.children[1].children.length === 1) {
      return this.process(node.updated("for", [
        s("lvasgn", node.children[1].children[0].children[0]),
        node.children[0].children[0],
        node.children[2]
      ]))
    } else if (method === "inject") {
      return this.process(node.updated("send", [
        call.children[0],
        "reduce",
        s("block", s("send", null, "lambda"), ...node.children.slice(1, 3)),
        ...call.children.slice(2)
      ]))
    } else if (method === "each_pair" && node.children[1].children.length === 2) {
      return this.process(node.updated(null, [
        s(
          "send",
          s("send", s("const", null, "Object"), "entries", call.children[0]),
          "each"
        ),

        node.children[1],
        node.children[2]
      ]))
    } else if (method === "scan" && call.children.length === 3) {
      return this.process(call.updated(null, [
        ...call.children,
        s("block", s("send", null, "proc"), ...node.children.slice(1))
      ]))
    } else if (method === "yield_self" && call.children.length === 2) {
      return this.process(node.updated("send", [
        s(
          "block",
          s("send", null, "proc"),
          node.children[1],
          s("autoreturn", node.children[2])
        ),

        "[]",
        call.children[0]
      ]))
    } else if (method === "tap" && call.children.length === 2) {
      // Handle Ruby 3.4's `it` implicit block parameter (args is nil)
      args = node.children[1];
      arg_name = args?.children[0]?.children[0] ?? "it";

      return this.process(node.updated("send", [
        s(
          "block",
          s("send", null, "proc"),
          args,
          s("begin", node.children[2], s("return", s("lvar", arg_name)))
        ),

        "[]",
        call.children[0]
      ]))
    } else if (method === "define_method" && call.children.length === 3 && call.children[0]) {
      return this.process(node.updated("send", [
        s("attr", call.children[0], "prototype"),
        "[]=",
        call.children[2],
        s("deff", null, ...node.children.slice(1))
      ]))
    } else if (method === "each_with_index" && call.children.length === 2) {
      // array.each_with_index { |item, i| ... }
      // => for (let i = 0; i < array.length; i++) { let item = array[i]; ... }
      args_children = node.children[1].children;
      first_arg = args_children[0];
      index_arg = args_children[1]?.children[0] ?? "_i";
      target = call.children[0];
      body = node.children[2];

      // Build item assignment based on arg type
      if (first_arg?.type === "mlhs") {
        // Destructured: |([k,v]), i| => let [k, v] = target[i]
        let lhs = s(
          "mlhs",
          ...first_arg.children.map(a => s("lvasgn", a.children[0]))
        );

        item_assign = s(
          "masgn",
          lhs,
          s("send", target, "[]", s("lvar", index_arg))
        )
      } else {
        // Simple: |item, i| => let item = target[i]
        let item_name = first_arg?.children[0] ?? "_item";

        item_assign = s(
          "lvasgn",
          item_name,
          s("send", target, "[]", s("lvar", index_arg))
        )
      };

      body = body?.type === "begin" ? body.updated(
        null,
        [item_assign, ...body.children]
      ) : body ? s("begin", item_assign, body) : item_assign;

      return this.process(s(
        "for",
        s("lvasgn", index_arg),
        s("erange", s("int", 0), s("attr", target, "length")),
        body
      ))
    } else {
      return this._parent.on_block.call(this, node)
    }
  };

  // Recursively add class name as receiver to define_method and method_defined? calls
  // This handles define_method/method_defined? inside loops like:
  //   %i[a b].each { |t| define_method(t) { ... } unless method_defined?(t) }
  add_class_receiver(node, class_name) {
    if (!ast_node(node)) return node;

    if (node.type === "block") {
      let call = node.children[0];

      if (call.type === "send" && call.children[0] === null && call.children[1] === "define_method") {
        let new_call = call.updated(
          "send",
          [class_name, ...call.children.slice(1)]
        );

        return node.updated("block", [
          new_call,
          ...node.children.slice(1).map(c => this.add_class_receiver(c, class_name))
        ])
      }
    } else if (node.type === "send" && node.children[0] === null && node.children[1] === "method_defined?") {
      return node.updated("send", [class_name, ...node.children.slice(1)])
    };

    // Recursively process children
    let new_children = node.children.map(child => (
      ast_node(child) ? this.add_class_receiver(child, class_name) : child
    ));

    return new_children !== node.children ? node.updated(
      null,
      new_children
    ) : node
  };

  on_class(node) {
    let [name, inheritance, ...body] = node.children;
    body.splice(0, body.length, ...body.filter(x => x != null));

    for (let i = 0; i < body.length; i++) {
      let child = body[i];

      // alias_method without receiver -> add class name as receiver
      if (child.type === "send" && child.children[0] === null && child.children[1] === "alias_method") {
        body[i] = child.updated("send", [name, ...child.children.slice(1)])
      } else if (child.type === "send" && child.children[0] === null && child.children[1] === "method_defined?") {
        body[i] = child.updated("send", [name, ...child.children.slice(1)])
      } else if (child.type === "block") {
        let call = child.children[0];

        if (call.type === "send" && call.children[0] === null && call.children[1] === "define_method") {
          let new_call = call.updated(
            "send",
            [name, ...call.children.slice(1)]
          );

          body[i] = child.updated(
            "block",
            [new_call, ...child.children.slice(1)]
          )
        } else {
          // Recursively search for define_method/method_defined? inside nested blocks (e.g., .each loops)
          body[i] = this.add_class_receiver(child, name)
        }
      } else if (child.type === "begin") {
        // Process children of begin node (class body wrapped in begin)
        body[i] = this.add_class_receiver(child, name)
      }
    };

    if (nodesEqual(inheritance, s("const", null, "Exception"))) {
      if (!body.some(statement => (
        statement.type === "def" && statement.children[0] === "initialize"
      ))) {
        body.unshift(s(
          "def",
          "initialize",
          s("args", s("arg", "message")),

          s(
            "begin",
            s("send", s("self"), "message=", s("lvar", "message")),
            s("send", s("self"), "name=", s("sym", name.children[1])),

            s(
              "send",
              s("self"),
              "stack=",
              s("attr", s("send", null, "Error", s("lvar", "message")), "stack")
            )
          )
        ))
      };

      if (body.length > 1) body = [s("begin", ...body)];
      return this.S("class", name, s("const", null, "Error"), ...body)
    } else {
      if (body.length > 1) body = [s("begin", ...body)];

      return this._parent.on_class.call(
        this,
        this.S("class", name, inheritance, ...body)
      )
    }
  };

  // Convert Struct.new to a class definition
  // Color = Struct.new(:name, :value) becomes:
  // class Color {
    //   constructor(name, value) { this.name = name; this.value = value }
    //   get name() { return this._name }
    //   set name(v) { this._name = v }
    //   ...
    // }
    on_casgn(node) {
      let target, method, args;
      let [cbase, name, value] = node.children;

      // Only handle top-level constant assignment of Struct.new
      if (cbase == null && value?.type === "send") {
        let [target, method, ...args] = value.children;

        // Check for Struct.new - use element comparison for JS compatibility
        // (array == array doesn't work in JS)
        if (target?.type === "const" && target.children[0] == null && target.children[1] === "Struct" && method === "new" && args.every(a => (
          a.type === "sym"
        ))) {
          // Extract field names from Struct.new(:field1, :field2, ...)
          let fields = args.map(a => a.children[0]);

          // Build constructor args: s(:args, s(:arg, :field1), s(:arg, :field2), ...)
          let constructor_args = s("args", ...fields.map(f => s("arg", f)));

          // Build constructor body: this._field1 = field1; etc.
          // Use ivars for storage so accessors can use them
          let assignments = fields.map(f => s("ivasgn", `@${f ?? ""}`, s("lvar", f)));

          let constructor_body = assignments.length === 1 ? assignments[0] : s(
            "begin",
            ...assignments
          );

          // Build class with constructor and attr_accessor for each field
          let constructor = s(
            "def",
            "initialize",
            constructor_args,
            constructor_body
          );

          let attr_accessor = s(
            "send",
            null,
            "attr_accessor",
            ...fields.map(f => s("sym", f))
          );

          let class_node = s(
            "class",
            s("const", null, name),
            null,
            s("begin", attr_accessor, constructor)
          );

          return this.process(class_node)
        }
      };

      return this._parent.on_casgn.call(this, node)
    };

    // Map Ruby exception classes to JavaScript equivalents
    on_const(node) {
      if (node.children.length === 2 && nodesEqual(
        node.children[0],
        s("const", null, "JSON")
      ) && node.children[1] === "ParserError") {
        return s("const", null, "SyntaxError")
      } else if (node.children[0] == null && node.children[1] === "StandardError") {
        return s("const", null, "Error")
      } else if (node.children[0] == null && node.children[1] === "RuntimeError") {
        return s("const", null, "Error")
      } else if (node.children[0] == null && node.children[1] === "ArgumentError") {
        return s("const", null, "TypeError")
      } else {
        return this._parent.on_const.call(this, node)
      }
    }
  };

  Object.defineProperties(
    Functions.prototype,
    Object.getOwnPropertyDescriptors(SEXP)
  );

  // require explicit opt-in to call => direct invocation mapping
  // (JS uses Function.prototype.call() which would break)
  Filter.exclude("call");
  registerFilter("Functions", Functions.prototype);
  export default Functions;
  export { Functions }