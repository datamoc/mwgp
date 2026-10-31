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
export function qualifyNestedConstants(js, unitName, knownNested = null, knownPaths = null) {
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
  if (!nested.size && !(knownPaths && (knownPaths.size ?? knownPaths.length))) return js;
  const edits = [];
  // Ruby looks a bare constant up through every class it is written in: inside `Battle::Scene`, `CommandMenu` is `Battle::Scene::CommandMenu`.
  // `lexical` is the dotted path of the class being visited (`Battle.Scene`), found from the `Battle.Scene = class ...` assignments (and the
  // root `class Battle`); the innermost enclosing path that has the name as a nested class wins.
  const paths = knownPaths instanceof Set ? knownPaths : new Set(knownPaths || []);
  const dotted = node => (node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? (dotted(node.object) ? `${dotted(node.object)}.${node.property.name}` : null) : null);
  const deepName = (name, lexical) => { for (let depth = lexical.length; depth >= 1; depth--) { const candidate = `${lexical.slice(0, depth).join('.')}.${name}`; if (depth >= 2 && paths.has(candidate)) return candidate; } return null; };
  const visit = (node, parent, key, lexical = [unitName]) => {
    if (!node || typeof node.type !== 'string') return;
    if (paths.size && node.type === 'AssignmentExpression' && node.operator === '=') {
      const target = dotted(node.left);
      if (target && target.startsWith(`${unitName}.`)) { visit(node.left, node, 'left', lexical); visit(node.right, node, 'right', target.split('.')); return; }
    }
    if (paths.size && node.type === 'Identifier' && /^[A-Z]/.test(node.name) && !nested.has(node.name)) {
      const skipDeep = (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed)
        || ((parent?.type === 'ClassDeclaration' || parent?.type === 'ClassExpression' || parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression') && key === 'id')
        || (parent?.type === 'VariableDeclarator' && key === 'id') || key === 'params';
      const qualified = skipDeep ? null : deepName(node.name, lexical);
      if (qualified) edits.push({ start: node.start, end: node.end, text: qualified });
    }
    if (node.type === 'Identifier' && nested.has(node.name)) {
      const skip = (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed)
        || ((parent?.type === 'ClassDeclaration' || parent?.type === 'ClassExpression' || parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression') && key === 'id')
        || (parent?.type === 'VariableDeclarator' && key === 'id') || key === 'params';
      if (!skip) edits.push({ start: node.start, end: node.end, text: `${unitName}.${node.name}` });
    }
    for (const field of Object.keys(node)) {
      const value = node[field];
      if (Array.isArray(value)) value.forEach(child => visit(child, node, field, lexical)); else if (value && typeof value.type === 'string') visit(value, node, field, lexical);
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
  const simple = node => node.type === 'Identifier' || node.type === 'ThisExpression' || (node.type === 'MemberExpression' && (!node.computed || node.property.type === 'Literal') && simple(node.object));
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

// Ruby's `break` inside a `case/when` leaves the enclosing loop (a `case` is not a loop). Ruby2JS emits a `switch`, where a `break`
// leaves only the switch: Essentials' battle command loop (`when 0 then break if pbFightMenu`) then cancelled the choice it had
// just made. A `break` nested in an if/try inside a case body (never the case's own terminating `break`) that is not inside a
// deeper loop or switch gets the label of the loop around the switch.
export function labelLoopBreaks(js) {
  if (!/\bswitch\s*\(/.test(js) || !/\b(while|for|do)\b/.test(js)) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const edits = [];
  let counter = 0;
  const labels = new Map();
  const isLoop = node => node.type === 'WhileStatement' || node.type === 'DoWhileStatement' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement';
  const isFunction = node => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
  const nestedBreaks = (node, top, out) => {
    if (!node || typeof node.type !== 'string') return;
    if (isLoop(node) || node.type === 'SwitchStatement' || isFunction(node) || node.type === 'ClassBody') return;
    if (node.type === 'BreakStatement') { if (!node.label && !top) out.push(node); return; }
    const next = node.type === 'BlockStatement' ? top : false;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) nestedBreaks(child, next, out);
      else if (value && typeof value.type === 'string') nestedBreaks(value, next, out);
    }
  };
  const visit = (node, loop) => {
    if (!node || typeof node.type !== 'string') return;
    if (isFunction(node)) loop = null;
    if (isLoop(node)) loop = node;
    if (node.type === 'SwitchStatement' && loop) {
      const found = [];
      for (const item of node.cases) for (const statement of item.consequent) nestedBreaks(statement, true, found);
      if (found.length) {
        if (!labels.has(loop)) { labels.set(loop, `__loop${++counter}`); edits.push({ at: loop.start, del: 0, text: `${labels.get(loop)}: ` }); }
        for (const found_ of found) edits.push({ at: found_.start, del: found_.end - found_.start, text: `break ${labels.get(loop)};` });
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child, loop);
      else if (value && typeof value.type === 'string') visit(value, loop);
    }
  };
  visit(ast, null);
  let out = js;
  for (const edit of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.del);
  return out;
}

// A Ruby local that shares its name with an accessor of the class (`startX = 16` next to `def startX=`) is a local in Ruby, but
// Ruby2JS emits the assignment as `this.startX = 16` while the later reads stay bare (`startX`). In a function that assigns `this.N`
// and also reads an undeclared bare `N`, the assignments are locals: declare `let N` at the top of the function and drop the `this.`.
export function hoistLocalSetters(js) {
  if (!/this\.[a-z]\w*\s*[-+*/|&]?=[^=]/.test(js)) return js;
  let ast;
  try { ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return js; }
  const edits = [];
  const isFunction = node => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
  const GLOBALS = new Set(['undefined', 'arguments', 'console', 'window', 'document', 'globalThis', 'self', 'super']);
  const handle = fn => {
    if (fn.body.type !== 'BlockStatement') return;
    const assigned = new Map();   // name -> assignment nodes
    let declared = new Set();
    const reads = new Map();      // name -> count of bare reads
    const addPattern = pattern => { if (!pattern) return; if (pattern.type === 'Identifier') declared.add(pattern.name); else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left); else if (pattern.type === 'RestElement') addPattern(pattern.argument); else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(addPattern); else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(property => addPattern(property.value ?? property.argument)); };
    fn.params.forEach(addPattern);
    const inner = [];    // `let` declarations in nested blocks of this function (not in arrows, not loop heads)
    const shadow = [];   // parameter names of the arrows being walked: their bare reads are the parameters, not a local of ours
    const visit = (node, parent, key) => {
      if (!node || typeof node.type !== 'string') return;
      if (node !== fn.body && isFunction(node)) {
        // A nested arrow shares `this` and the locals of this function (its parameters hide ours); any other function has its own `this`
        // and is handled on its own.
        if (node.type !== 'ArrowFunctionExpression') return;
        const names = new Set(); const hold = declared; const probe = new Set(); declared = probe; node.params.forEach(addPattern); declared = hold; probe.forEach(name => names.add(name)); shadow.push(names);
        for (const k of Object.keys(node)) { const value = node[k]; if (Array.isArray(value)) for (const child of value) visit(child, node, k); else if (value && typeof value.type === 'string') visit(value, node, k); }
        shadow.pop();
        return;
      }
      // Only a declaration that covers the whole function counts (`var`, or a top-level `let`/`const`); a block's own `let` hides nothing
      // outside it, and neither does the parameter of a nested arrow.
      if (node.type === 'VariableDeclaration' && node.kind === 'let' && parent !== fn.body && !shadow.length && !(parent && /^For(In|Of)?Statement$/.test(parent.type))) inner.push(node);
      if (node.type === 'VariableDeclaration' && (node.kind === 'var' || parent === fn.body)) node.declarations.forEach(declaration => addPattern(declaration.id));
      if (node.type === 'CatchClause') addPattern(node.param);
      if (node.type === 'FunctionDeclaration' && node.id) declared.add(node.id.name);
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.object.type === 'ThisExpression' && !node.left.computed && node.left.property.type === 'Identifier' && /^[a-z]/.test(node.left.property.name)) {
        const list = assigned.get(node.left.property.name) ?? []; list.push(node); assigned.set(node.left.property.name, list);
      }
      if (node.type === 'Identifier' && !(parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) && !(parent?.type === 'Property' && key === 'key' && !parent.computed) && !(parent?.type === 'MethodDefinition' && key === 'key')
        && !(parent?.type === 'VariableDeclarator' && key === 'id') && !(parent?.type === 'LabeledStatement') && !(parent?.type === 'BreakStatement') && !(parent?.type === 'ContinueStatement')) {
        if (!shadow.some(names => names.has(node.name))) reads.set(node.name, (reads.get(node.name) ?? 0) + 1);
      }
      for (const k of Object.keys(node)) {
        const value = node[k];
        if (Array.isArray(value)) for (const child of value) visit(child, node, k);
        else if (value && typeof value.type === 'string') visit(value, node, k);
      }
    };
    visit(fn.body, fn, 'body');
    const names = [];
    for (const [name, nodes] of assigned) {
      if (declared.has(name) || GLOBALS.has(name) || !reads.get(name)) continue;
      names.push(name);
      for (const node of nodes) edits.push({ at: node.left.start, del: node.left.end - node.left.start, text: name });
    }
    if (names.length) {
      edits.push({ at: fn.body.start + 1, del: 0, text: ` let ${names.join(', ')};` });
      // Ruby has one variable per method: a block's own `let width` (Ruby2JS declared it where it was first assigned there) must not shadow it.
      for (const declaration of inner) {
        const ours = declaration.declarations.filter(declarator => declarator.id.type === 'Identifier' && names.includes(declarator.id.name));
        if (!ours.length || ours.length !== declaration.declarations.length) continue;
        const assigned = ours.filter(declarator => declarator.init).map(declarator => `${declarator.id.name} = ${js.slice(declarator.init.start, declarator.init.end)}`);
        edits.push({ at: declaration.start, del: declaration.end - declaration.start, text: assigned.length ? `${assigned.join(', ')};` : '' });
      }
    }
  };
  const walkAll = node => {
    if (!node || typeof node.type !== 'string') return;
    if (isFunction(node) && node.type !== 'ArrowFunctionExpression') handle(node);
    for (const k of Object.keys(node)) {
      const value = node[k];
      if (Array.isArray(value)) value.forEach(walkAll);
      else if (value && typeof value.type === 'string') walkAll(value);
    }
  };
  walkAll(ast);
  if (!edits.length) return js;
  let out = js;
  for (const edit of edits.sort((a, b) => b.at - a.at || b.del - a.del)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.del);
  return out;
}
