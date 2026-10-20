// A Ruby block passed to a method that also has optional parameters arrives from Ruby2JS as one more trailing argument:
// `pbMessage(text, choices, 1) { ... }` becomes `pbMessage(text, choices, 1, () => ...)`, while `def pbMessage(message,
// commands = nil, cmdIfCancel = 0, skin = nil, defaultCmd = 0, &block)` becomes `function pbMessage(message, commands, cmdIfCancel,
// skin, defaultCmd, block)`. With fewer arguments than parameters the function lands in the first optional slot (`skin`), not in
// `block`. For every function whose last parameter is the block, a call that ends in a function and is short of arguments is
// therefore re-seated: the function goes to the block, and the slots it passed through get their defaults back.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const BLOCK_NAMES = new Set(['block', '_implicitBlockYield']);

export function shiftTrailingBlock(js) {
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const edits = [];
  const visit = node => {
    const params = node.params;
    if (!params || params.length < 2 || node.body?.type !== 'BlockStatement') return;
    const last = params.at(-1);
    const name = last.type === 'Identifier' ? last.name : last.type === 'AssignmentPattern' && last.left.type === 'Identifier' ? last.left.name : null;
    if (!BLOCK_NAMES.has(name)) return;
    if (params.some(param => param.type !== 'Identifier' && !(param.type === 'AssignmentPattern' && param.left.type === 'Identifier'))) return;
    const count = params.length;
    const resets = params.slice(0, -1).map((param, index) => {
      const target = param.type === 'Identifier' ? param.name : param.left.name;
      const fallback = param.type === 'AssignmentPattern' ? js.slice(param.right.start, param.right.end) : 'undefined';
      return `case ${index}: ${target} = ${fallback};`;
    });
    edits.push({ at: node.body.start + 1, text: `\nconst __given = arguments.length;\nif (__given > 0 && __given < ${count} && typeof arguments[__given - 1] === 'function') {\n${name} = arguments[__given - 1];\nswitch (__given - 1) { ${resets.join(' ')} }\n}\n` });
  };
  walk.full(ast, node => { if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') visit(node); });
  let out = js;
  for (const edit of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at);
  return out;
}

// `yield` inside a block of a method that names its block (`def f(&block) ... g { yield(x) } ... end`) is emitted as
// `_implicitBlockYield(x)`, a name only methods without an explicit `&block` get as a parameter. Each such reference is bound to the
// nearest enclosing function that does declare `block`.
export function bindYieldToBlock(js) {
  if (!js.includes('_implicitBlockYield')) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const declares = (fn, name) => fn.params.some(param => (param.type === 'Identifier' && param.name === name) || (param.type === 'AssignmentPattern' && param.left.type === 'Identifier' && param.left.name === name));
  const edits = [];
  const visit = (node, stack) => {
    if (!node || typeof node.type !== 'string') return;
    const isFunction = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
    const nextStack = isFunction ? [...stack, node] : stack;
    // Ruby2JS gives a nested JS block an `_implicitBlockYield` parameter when
    // it contains Ruby `yield`, even though Ruby's yield still targets the
    // enclosing method's block. Only an actual non-arrow function is a Ruby
    // method boundary; the synthetic arrow parameter must not shadow it.
    const methodOwnsImplicitYield = stack.some(fn => fn.type !== 'ArrowFunctionExpression' && declares(fn, '_implicitBlockYield'));
    const isParameter = stack.some(fn => fn.params.some(param => param === node || param.type === 'AssignmentPattern' && param.left === node));
    if (node.type === 'Identifier' && node.name === '_implicitBlockYield' && stack.length && !methodOwnsImplicitYield && !isParameter) {
      if (stack.some(fn => declares(fn, 'block'))) edits.push({ start: node.start, end: node.end, text: 'block' });
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(child => visit(child, nextStack)); else if (value && typeof value.type === 'string') visit(value, nextStack);
    }
  };
  visit(ast, []);
  let out = js;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

// Ruby's `str.scan(/re/)` is emitted as `str.match(/re/g)`, which is null when nothing matches where Ruby answers `[]`. Every
// global `match` call is therefore read as the list of matches (an empty one when there are none).
export function emptyListForGlobalMatch(js) {
  if (!js.includes('.match(')) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const edits = [];
  walk.full(ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.name !== 'match') return;
    const [pattern] = node.arguments;
    if (node.arguments.length !== 1 || pattern?.type !== 'Literal' || !pattern.regex || !pattern.regex.flags.includes('g')) return;
    edits.push({ start: node.start, end: node.end });
  });
  let out = js;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = `${out.slice(0, edit.start)}(${out.slice(edit.start, edit.end)} ?? [])${out.slice(edit.end)}`;
  return out;
}

// A mod that redefines a method only when it exists (`class Pokemon; if method_defined?(:ability_id); alias old ability_id; def
// ability_id ... end; end; end`) is emitted as `if ("ability_id" in Pokemon.prototype) { function ability_id() {...} }`: a function
// declaration inside a block that never reaches the class. Each such function becomes an assignment on the class prototype, a bare
// `prototype` (the class name was lost) is read as the unit's own class, and `this.a = this.b` (an alias copy emitted at the top level)
// copies between the prototypes.
export function attachConditionalMethods(js, unitName) {
  if (!/\bin\s+(?:[\w$.]+\.)?prototype\b/.test(js)) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const edits = [];
  for (const node of ast.body) {
    if (node.type !== 'IfStatement' || node.alternate || node.consequent.type !== 'BlockStatement') continue;
    const test = node.test;
    if (test.type !== 'BinaryExpression' || test.operator !== 'in' || test.left.type !== 'Literal' || typeof test.left.value !== 'string') continue;
    const target = test.right;
    let owner;
    if (target.type === 'Identifier' && target.name === 'prototype') { if (!unitName) continue; owner = `${unitName}.prototype`; }
    else if (target.type === 'MemberExpression' && !target.computed && target.property.name === 'prototype') owner = js.slice(target.start, target.end);
    else continue;
    // The guard asked whether the method exists before the mod wrapped it; the alias pass has by now renamed that original (to the alias),
    // so it would read false. The original did exist, hence the block always runs.
    edits.push({ start: test.start, end: test.end, text: 'true' });
    for (const statement of node.consequent.body) {
      if (statement.type === 'FunctionDeclaration' && statement.id) {
        // `def x=(v)` arrives as `function x(v)`; the alias comment the resolver left (`alias y of x= resolved`) tells it was a setter.
        const before = js.slice(Math.max(0, node.start - 400), statement.start);
        const isSetter = new RegExp(`alias \\w+ of ${statement.id.name}= resolved`).test(before);
        if (isSetter) {
          // The reader stays: its accessor when the class has one, else the plain method `x()` handed out through a getter, so both
          // `obj.x()` and `obj.x = v` keep working (the getter/method clash pattern of methodSetterClashEdits).
          const quoted = JSON.stringify(statement.id.name);
          edits.push({ start: statement.start, end: statement.start, text: `Object.defineProperty(${owner}, ${quoted}, { configurable: true, get: (() => { const d = Object.getOwnPropertyDescriptor(${owner}, ${quoted}); return d?.["get"] ?? (typeof d?.["value"] === "function" ? function () { const f = d["value"], self = this; return function () { return f.apply(self, arguments) } } : undefined) })(), set: ` });
          edits.push({ start: statement.end, end: statement.end, text: ' });' });
        } else {
          edits.push({ start: statement.start, end: statement.start, text: `${owner}.${statement.id.name} = ` });
          edits.push({ start: statement.end, end: statement.end, text: ';' });
        }
      } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.operator === '='
        && statement.expression.left.type === 'MemberExpression' && statement.expression.left.object.type === 'ThisExpression'
        && statement.expression.right.type === 'MemberExpression' && statement.expression.right.object.type === 'ThisExpression') {
        const { left, right } = statement.expression;
        edits.push({ start: left.start, end: left.end, text: `${owner}.${left.property.name}` }, { start: right.start, end: right.end, text: `${owner}.${right.property.name}` });
      }
    }
  }
  let out = js;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

// Ruby resolves a bare constant through the classes it is written in: inside `class Player`, `Pokedex` is `Player::Pokedex` even when
// a global `Pokedex` exists. The output keeps the bare name, which then finds the global one. Every reference to a class nested in the
// unit (`Player.Pokedex = class ...`) is therefore qualified with its enclosing class.
export function qualifyNestedConstants(js, unitName, knownNested = null) {
  if (!unitName) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  // Nested classes known from the whole unit (the other pieces of it), plus those assigned in this code.
  const nested = new Set(knownNested || []);
  const assigned = new Set();
  for (const node of ast.body) {
    const expression = node.type === 'ExpressionStatement' ? node.expression : null;
    if (expression?.type === 'AssignmentExpression' && expression.operator === '=' && expression.left.type === 'MemberExpression' && !expression.left.computed
      && expression.left.object.type === 'Identifier' && expression.left.object.name === unitName && /^[A-Z]/.test(expression.left.property.name)
      && (expression.right.type === 'ClassExpression' || expression.right.type === 'CallExpression')) { nested.add(expression.left.property.name); assigned.add(expression.left.property.name); }
  }
  // In a module body (`const Unit = (() => { ... })()`) the nested classes are locals of that body and must stay bare; the qualification is for
  // class-style units, where a method body names a sibling class declared in another piece.
  const moduleBody = new RegExp(String.raw`\bconst\s+${unitName}\s*=\s*\(\s*\(\s*\)\s*=>`).test(js);
  if (moduleBody) for (const name of [...nested]) if (!assigned.has(name)) nested.delete(name);
  if (!nested.size) return js;
  const edits = [];
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && nested.has(node.name)) {
      const skip = (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed)
        || ((parent?.type === 'ClassDeclaration' || parent?.type === 'ClassExpression' || parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression') && key === 'id')
        || (parent?.type === 'VariableDeclarator' && key === 'id') || key === 'params';
      if (!skip) edits.push({ start: node.start, end: node.end, text: `${unitName}.${node.name}` });
    }
    for (const field of Object.keys(node)) {
      const value = node[field];
      if (Array.isArray(value)) value.forEach(child => visit(child, node, field)); else if (value && typeof value.type === 'string') visit(value, node, field);
    }
  };
  visit(ast, null, null);
  let out = js;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

// Ruby's `case value when Pokemon ... when Array ...` compares with `===`, which for a class means "is an instance of". Ruby2JS emits
// `switch (value) { case Pokemon: ... }`, a strict equality that never holds for a class. A switch on a plain variable (or `this.x`) whose
// labels name classes (capitalised identifiers) becomes `switch (true)` with `__ruby_is_a(value, Class)` for those labels and
// `value === label` for the others.
export function classCaseSwitches(js) {
  if (!/\bswitch\s*\(/.test(js)) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const simple = node => node.type === 'Identifier' || node.type === 'ThisExpression' || (node.type === 'MemberExpression' && !node.computed && simple(node.object));
  const classLabel = node => (node.type === 'Identifier' && /^[A-Z]/.test(node.name) && node.name !== 'NaN' && node.name !== 'Infinity')
    || (node.type === 'MemberExpression' && !node.computed && classLabel(node.property.type === 'Identifier' ? node.property : node.object) && /^[A-Z]/.test(node.property?.name ?? ''));
  const edits = [];
  walk.full(ast, node => {
    if (node.type !== 'SwitchStatement' || !simple(node.discriminant)) return;
    const labels = node.cases.filter(item => item.test);
    if (!labels.some(item => classLabel(item.test))) return;
    const subject = js.slice(node.discriminant.start, node.discriminant.end);
    edits.push({ start: node.discriminant.start, end: node.discriminant.end, text: 'true' });
    for (const item of labels) {
      const label = js.slice(item.test.start, item.test.end);
      edits.push({ start: item.test.start, end: item.test.end, text: classLabel(item.test) ? `__ruby_is_a(${subject}, ${label})` : `${subject} === ${label}` });
    }
  });
  let out = js;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
