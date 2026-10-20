import { Parser, SEXP, s, S, ast_node, convert, parse, include, Filter, DEFAULTS, excluded, included, _options, filterContext, nodesEqual, registerFilter, scanRegexpGroups, Ruby2JS } from "../ruby2js.js";

class Return extends Filter.Processor {
  static EXPRESSIONS = [
    "array",
    "float",
    "hash",
    "if",
    "int",
    "lvar",
    "nil",
    "send"
  ];

  // Methods where blocks become arrow functions with implicit returns
  // These shouldn't get explicit return added
  static IMPLICIT_RETURN_METHODS = Object.freeze([
    "map",
    "select",
    "filter",
    "reject",
    "find",
    "find_all",
    "detect",
    "collect",
    "each",
    "each_with_index",
    "each_with_object",
    "reduce",
    "inject",
    "fold",
    "sort",
    "sort_by",
    "any?",
    "all?",
    "none?",
    "one?",
    "take_while",
    "drop_while",
    "group_by",
    "partition",
    "min_by",
    "max_by",
    "minmax_by",
    "forEach"
  ]);

  on_block(node) {
    node = this._parent.on_block.call(this, node);
    if (node.type !== "block") return node;
    let call = node.children[0];

    // Don't wrap Class.new blocks - they contain method definitions, not return values
    if (call.type === "send" && call.children[0]?.type === "const" && call.children[0].children[0] == null && call.children[0].children[1] === "Class" && call.children[1] === "new") {
      return node
    };

    // Don't wrap blocks for methods that become arrow functions with implicit returns
    if (call.type === "send" && Return.IMPLICIT_RETURN_METHODS.includes(call.children[1])) {
      return node
    };

    let children = node.children.dup();
    if (children.at(-1) == null) children[children.length - 1] = s("nil");

    return node.updated(
      null,
      [...children.slice(0, 2), s("autoreturn", ...children.slice(2))]
    )
  };

  on_def(node) {
    node = this._parent.on_def.call(this, node);

    if (node.type !== "def" && node.type !== "deff" && node.type !== "defm") {
      return node
    };

    if (["constructor", "initialize"].includes(node.children[0])) return node;
    let children = node.children.slice(1);
    if (children.at(-1) == null) children[children.length - 1] = s("nil");

    return node.updated(null, [
      node.children[0],
      children[0],
      s("autoreturn", ...children.slice(1))
    ])
  };

  on_deff(node) {
    return this.on_def(node)
  };

  on_defm(node) {
    return this.on_def(node)
  };

  on_defs(node) {
    node = this._parent.on_defs.call(this, node);
    if (node.type !== "defs") return node;
    let children = node.children.slice(3);
    if (children.at(-1) == null) children[children.length - 1] = s("nil");

    return node.updated(
      null,
      [...node.children.slice(0, 3), s("autoreturn", ...children)]
    )
  }
};

Object.defineProperties(
  Return.prototype,
  Object.getOwnPropertyDescriptors(SEXP)
);

registerFilter("Return", Return.prototype);
export default Return;
export { Return }