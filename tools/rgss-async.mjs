// Async lift for blocking RGSS code.
//
// RGSS scripts written as a loop (`loop { Graphics.update; Input.update; break if done }`, whole `pbMain` scenes)
// wait on the game's frame loop. The browser owns that loop, so Ruby2JS's synchronous output can never finish one of
// those loops. This pass rewrites the transpiled JS so a function that (transitively) reaches a blocking primitive
// becomes `async` and its call sites `await` it; the runtime's `Graphics.update` then returns a promise that resolves
// on the next frame, letting the browser render and read input in between.
//
// The analysis is by *name* (a callee's identifier or member property), which is all a Ruby-to-JS output leaves: a
// function is async when its own body (nested functions excluded) awaits, and a call to any async name is awaited.
// What it does not touch, and reports instead of guessing: constructors, getters, setters, and calls inside anonymous
// callbacks (an awaited call there would turn a callback into one returning a promise).
import * as acorn from 'acorn';
import { repairCallAssignments } from './rgss-repair.mjs';
import { JS_NATIVE_ZERO_ARG_PROPERTIES } from './rgss-call-filter.mjs';

export const BLOCKING = new Set(['Graphics.update', 'Graphics.wait']);
// Helpers the runtime provides as async builtins (dialogue-backed), so anything calling them is lifted whether or not the
// game's own definition looks blocking.
export const ASYNC_BUILTINS = ['pbMessage', 'pbConfirmMessage', 'pbConfirmMessageSerious'];

const parse = js => acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });

const isFunction = node => node && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');

// The name a call goes by: `foo(...)` -> foo, `x.foo(...)` -> foo, `foo.call(...)`/`.apply` -> foo.
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    if ((callee.property.name === 'call' || callee.property.name === 'apply') && callee.object) return calleeName(callee.object);
    return callee.property.name;
  }
  return null;
}
// How a call reaches its target: `f()` (bare), `this.f()` (same object), or `x.f()` (some other receiver: which class it is, is unknown).
function calleeKind(callee) {
  if (callee.type === 'Identifier') return 'bare';
  if (callee.type === 'MemberExpression' && !callee.computed) {
    if ((callee.property.name === 'call' || callee.property.name === 'apply') && callee.object) return calleeKind(callee.object);
    return callee.object.type === 'ThisExpression' ? 'this' : 'member';
  }
  return 'member';
}
const blockingCall = callee => callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && BLOCKING.has(`${callee.object.name}.${callee.property.name}`);

// Walk `root` without entering nested functions, calling `visit(node, parent)` for every node.
function walkShallow(root, visit) {
  const stack = [[root, null]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node !== root && isFunction(node)) continue;
    visit(node, parent);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) stack.push([child, node]);
      else if (value && typeof value.type === 'string') stack.push([value, node]);
    }
  }
}

// Every function-like node with the name it is known by and how to mark it async.
function collectFunctions(ast) {
  const found = [];
  const visit = (node, parent) => {
    if (isFunction(node)) {
      let name = null, kind = 'plain', insertAt = node.start, skip = false;
      if (node.type === 'FunctionDeclaration') name = node.id?.name ?? null;
      else if (parent?.type === 'MethodDefinition') {
        kind = parent.kind;
        name = !parent.computed && parent.key.type === 'Identifier' ? parent.key.name : null;
        insertAt = parent.key.start;
        skip = parent.kind !== 'method' || parent.computed;
      } else if (parent?.type === 'Property') {
        name = !parent.computed && (parent.key.type === 'Identifier' || parent.key.type === 'Literal') ? String(parent.key.name ?? parent.key.value) : null;
        if (parent.kind !== 'init') { kind = parent.kind; skip = true; }
        else if (parent.method) insertAt = parent.key.start;
      } else if (parent?.type === 'VariableDeclarator') name = parent.id.type === 'Identifier' ? parent.id.name : null;
      else if (parent?.type === 'AssignmentExpression') name = calleeName(parent.left);
      found.push({ node, name, kind, insertAt, skip, anonymous: name === null });
    }
  };
  // Full traversal (functions included) to find all function nodes with their parents.
  const stack = [[ast, null]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    visit(node, parent);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) stack.push([child, node]);
      else if (value && typeof value.type === 'string') stack.push([value, node]);
    }
  }
  return found;
}

// Names of functions that (transitively) block. `sources` = [{ js, ast, functions }] of every unit/snippet.
function asyncNamesOf(parsed) {
  // The analysis is by name, and a name like `get` or `update` is defined in many unrelated classes. So a name is:
  //  * async  (`all`): some definition of it waits on frames, directly or through a call it awaits;
  //  * strong (`strong`): EVERY definition of it is async. Only strong names are awaited through `obj.name()` calls (the class
  //    behind `obj` is unknown); any async name is awaited through a bare `name()` or `this.name()` call.
  const all = new Set(ASYNC_BUILTINS), strong = new Set(ASYNC_BUILTINS);
  const bodies = [];
  const totals = new Map();
  for (const entry of parsed) {
    for (const fn of entry.functions) {
      if (fn.skip) continue;
      const calls = [];
      walkShallow(fn.node.body, (node) => { if (node.type === 'CallExpression') calls.push({ blocking: blockingCall(node.callee), name: calleeName(node.callee), kind: calleeKind(node.callee) }); });
      bodies.push({ fn, calls, async: false });
      if (fn.name) totals.set(fn.name, (totals.get(fn.name) || 0) + 1);
    }
  }
  // Only a bare `name()` call is unambiguously "the" global function of that name; `this.name()` and `obj.name()` could
  // both reach any class that defines `name`, so both require every definition to agree (`strong`), not just one.
  const qualifies = call => call.name && all.has(call.name) && (call.kind === 'bare' || strong.has(call.name));
  let changed = true;
  while (changed) {
    changed = false;
    const asyncCounts = new Map();
    for (const body of bodies) {
      if (!body.async && body.calls.some(call => call.blocking || qualifies(call))) { body.async = true; changed = true; if (body.fn.name) all.add(body.fn.name); }
      if (body.async && body.fn.name) asyncCounts.set(body.fn.name, (asyncCounts.get(body.fn.name) || 0) + 1);
    }
    for (const [name, count] of asyncCounts) if (count === totals.get(name) && !strong.has(name)) { strong.add(name); changed = true; }
  }
  return { all, strong };
}

// Edits for one parsed source: `async` on every function that awaits, `(await ...)` around every call to an async name.
function editsFor(entry, names, report) {
  const edits = [];
  let programAsync = false;
  const awaited = (node, inFunction) => {
    if (node.type !== 'CallExpression') return false;
    const name = calleeName(node.callee);
    if (blockingCall(node.callee)) return true;
    if (!name || !names.all.has(name)) return false;
    return calleeKind(node.callee) === 'bare' || names.strong.has(name);
  };
  const handle = (bodyRoot, fn) => {
    const calls = [];
    walkShallow(bodyRoot, node => { if (awaited(node)) calls.push(node); });
    if (!calls.length) return;
    // A function that cannot be async (constructor/getter/setter) or an anonymous callback keeps its calls as they are.
    if (fn && (fn.skip || fn.anonymous || fn.node.generator)) { report.unawaited += calls.length; return; }
    for (const call of calls) { edits.push({ pos: call.start, text: '(await ' }, { pos: call.end, text: ')' }); report.awaits++; }
    if (fn) { if (!fn.node.async) edits.push({ pos: fn.insertAt, text: 'async ' }); report.functions++; } else programAsync = true;
  };
  // Only a snippet (a function body of its own) can be awaited at its top level; a unit's top level must stay sync.
  if (entry.kind === 'snippet') handle(entry.ast, null);
  else { let top = 0; walkShallow(entry.ast, node => { if (awaited(node)) top++; }); report.unawaited += top; }
  for (const fn of entry.functions) handle(fn.node.body, fn);
  edits.sort((a, b) => b.pos - a.pos);
  let js = entry.js;
  for (const edit of edits) js = js.slice(0, edit.pos) + edit.text + js.slice(edit.pos);
  return { js, edits: edits.length, programAsync };
}

// Ruby semantics that Ruby2JS's JS output gets wrong, fixed in one edit pass:
//  * `%` takes the sign of the divisor (-1 % 3 == 2 in Ruby, -1 in JS), which turns a wrap-around index into -1:
//    every binary `%` becomes `__mod(left, right)` (the runtime's helper passes non-numbers to plain `%`).
//  * `this._x` used as an ivar next to a method `_x` is renamed `this._$x` (see ivarCollisionEdits).
//  * `list.map("to_i")` (symbol-to-proc) becomes `list.map((item) => item.to_i())`.
//  * `let $global = v` (a Ruby global assigned in a method) becomes `$global = v`.
//  * `Object.defineProperties(X, Object.getOwnPropertyDescriptors(M))` (extend/include) becomes `__mixin(...)`: own methods win.
//  * a setter `set _x` that assigns `this._x` is renamed `set x`.
//  * a bare identifier naming a zero-parameter library function becomes a call (see bareFunctionCallEdits).
//  * a method `x()` next to a setter `set x` is kept alongside it (methodSetterClashEdits).
//  * `x.splice(a, n)` (Ruby's `slice!`) becomes `__splice(x, v => { x = v }, a, n)`.
//  * `set x(v) { super.x(v) }` becomes `super.x = v` plus a delegating getter (setterSuperEdits).
//  * ivar assignments ahead of `super(...)` in a constructor move after it (constructorOrderEdits).
//  * `x?.name` for a name the game `def`s becomes `x?.name()` (see optionalReadEdits).
//  * `x.map.with_index(fn)` becomes `x.map(fn)`.
//  * `defined?(x)` is emitted as `typeof x()`: the call is dropped.
//  * A local assigned inside a block (`begin`/`rescue`, `if`, a loop) is visible after it in Ruby, but Ruby2JS declares
//    it with `let` inside the block: reading it afterwards is a ReferenceError (or, when the code redeclares it,
//    a temporal-dead-zone error). Such a declaration is hoisted: `let name;` before the statement, plain assignments inside.
const blocksOf = statement => {
  const blocks = [];
  const push = node => { if (node?.type === 'BlockStatement') blocks.push(node); };
  if (statement.type === 'TryStatement') { push(statement.block); push(statement.handler?.body); push(statement.finalizer); }
  else if (statement.type === 'IfStatement') { push(statement.consequent); let alt = statement.alternate; while (alt) { if (alt.type === 'IfStatement') { push(alt.consequent); alt = alt.alternate; } else { push(alt); alt = null; } } }
  else if (['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement'].includes(statement.type)) push(statement.body);
  return blocks;
};
const mentions = (node, names, found) => {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current.type !== 'string') continue;
    if (current.type === 'Identifier' && names.has(current.name)) found.add(current.name);
    // A declarator's own id is a (re)declaration, not a read of the earlier variable: only its initializer counts.
    if (current.type === 'VariableDeclarator') { stack.push(current.init); continue; }
    for (const key of Object.keys(current)) {
      const value = current[key];
      if (Array.isArray(value)) for (const child of value) stack.push(child);
      else if (value && typeof value.type === 'string') stack.push(value);
    }
  }
};
// Ruby2JS writes the instance variable `@x` as `this._x`, which collides with an instance method named `_x` (Ruby's
// private-by-convention `def _x`) in the same class: caching into `@x` overwrites the method. Reads and writes of
// `this._x` that are not calls become `this._$x`.
function ivarCollisionEdits(ast) {
  const edits = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.body?.body) {
      const methods = new Set(node.body.body.filter(member => member.type === 'MethodDefinition' && member.kind === 'method' && !member.static && !member.computed && member.key.type === 'Identifier' && member.key.name.startsWith('_')).map(member => member.key.name));
      if (methods.size) {
        const stack = [[node.body, node]];
        while (stack.length) {
          const [current, above] = stack.pop();
          if (!current || typeof current.type !== 'string') continue;
          if (current.type === 'MemberExpression' && !current.computed && current.object.type === 'ThisExpression' && current.property.type === 'Identifier' && methods.has(current.property.name)
            && !(above.type === 'CallExpression' && above.callee === current)) edits.push({ pos: current.property.start + 1, text: '$' });
          for (const key of Object.keys(current)) {
            const value = current[key];
            if (Array.isArray(value)) for (const child of value) stack.push([child, current]);
            else if (value && typeof value.type === 'string') stack.push([value, current]);
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child, node);
      else if (value && typeof value.type === 'string') visit(value, node);
    }
  };
  visit(ast, null);
  return edits;
}

// The converter turns a paren-less zero-arg `x.name` into a call when the game `def`s `name` anywhere, but not Ruby's
// safe navigation `x&.name` (emitted as `x?.name`, a property read): the same name would be a call on one path and a
// value on the other. Optional reads of known method names become calls.
function optionalReadEdits(ast, known) {
  const edits = [];
  if (!known?.size) return edits;
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression' && node.optional === true && !node.computed && node.property.type === 'Identifier'
      && known.has(node.property.name) && !JS_NATIVE_ZERO_ARG_PROPERTIES.has(node.property.name)
      && !(parent?.type === 'CallExpression' && parent.callee === node)
      && !(parent?.type === 'AssignmentExpression' && parent.left === node)) edits.push({ pos: node.property.end, text: '()' });
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child, node);
      else if (value && typeof value.type === 'string') visit(value, node);
    }
  };
  visit(ast, null);
  return edits;
}

// A paren-less receiver-less call to a game function (`pbInBugContest?` in `return if !pbInBugContest?`) can arrive as the
// bare identifier `pbInBugContest`: a function object, always truthy, never run. For zero-parameter library functions the
// bare identifier becomes a call, unless the name is declared locally, is being called/assigned/declared, or is the
// operand of `typeof` (a `defined?` probe).
function bareFunctionCallEdits(ast, zeroArg) {
  const edits = [];
  if (!zeroArg?.size) return edits;
  const declared = new Set();
  const collect = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declared.add(node.id.name);
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) for (const param of node.params) { if (param.type === 'Identifier') declared.add(param.name); else if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') declared.add(param.left.name); }
    for (const key of Object.keys(node)) { const value = node[key]; if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value.type === 'string') collect(value); }
  };
  collect(ast);
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && zeroArg.has(node.name) && !declared.has(node.name) && parent) {
      const isCallee = parent.type === 'CallExpression' && parent.callee === node;
      const isMember = parent.type === 'MemberExpression' && (parent.property === node && !parent.computed);
      const isKey = (parent.type === 'Property' && (parent.key === node && !parent.computed || parent.shorthand)) || (parent.type === 'MethodDefinition' && parent.key === node);
      const isDeclaration = (parent.type === 'FunctionDeclaration' && parent.id === node) || (parent.type === 'FunctionExpression' && parent.id === node) || parent.type === 'VariableDeclarator' && parent.id === node;
      const isAssignTarget = parent.type === 'AssignmentExpression' && parent.left === node;
      const isTypeof = parent.type === 'UnaryExpression' && parent.operator === 'typeof';
      const isParam = key === 'params';
      if (!isCallee && !isMember && !isKey && !isDeclaration && !isAssignTarget && !isTypeof && !isParam && !(parent.type === 'NewExpression' && parent.callee === node)) edits.push({ pos: node.end, text: '()' });
    }
    for (const k of Object.keys(node)) {
      const value = node[k];
      if (Array.isArray(value)) for (const child of value) visit(child, node, k);
      else if (value && typeof value.type === 'string') visit(value, node, k);
    }
  };
  visit(ast, null, null);
  return edits;
}

// Ruby sets instance variables before `super` in `initialize`; a JS derived constructor must call `super(...)` before touching
// `this`. Statements ahead of the first top-level `super(...)` that use `this` move to just after it (locals stay, so
// they can still feed the `super` arguments).
function constructorOrderEdits(ast, js) {
  const edits = [];
  const usesThis = node => {
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current.type !== 'string') continue;
      if (current.type === 'ThisExpression') return true;
      for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value.type === 'string') stack.push(value); }
    }
    return false;
  };
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.superClass && node.body?.body) {
      const constructor = node.body.body.find(member => member.type === 'MethodDefinition' && member.kind === 'constructor');
      const statements = constructor?.value?.body?.body;
      if (statements?.length) {
        const superIndex = statements.findIndex(statement => statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression' && statement.expression.callee.type === 'Super');
        // A derived constructor that never calls `super` (legal in Ruby: the parent's initialize is simply skipped) cannot run in
        // JS: it calls `super()` first.
        const callsSuper = (() => { const stack = [constructor.value.body]; while (stack.length) { const c = stack.pop(); if (!c || typeof c.type !== 'string') continue; if (c.type === 'CallExpression' && c.callee.type === 'Super') return true; for (const key of Object.keys(c)) { const v = c[key]; if (Array.isArray(v)) stack.push(...v); else if (v && typeof v.type === 'string') stack.push(v); } } return false; })();
        if (!callsSuper) edits.push({ pos: constructor.value.body.start + 1, text: ' super(); ' });
        if (superIndex > 0) {
          const moved = statements.slice(0, superIndex).filter(usesThis);
          if (moved.length) {
            const superStatement = statements[superIndex];
            const newline = String.fromCharCode(10);
            const text = moved.map(statement => js.slice(statement.start, statement.end)).join(newline);
            for (const statement of moved) edits.push({ pos: statement.start, del: statement.end - statement.start, text: '' });
            edits.push({ pos: superStatement.end, text: newline + text });
          }
        }
      }
    }
    for (const key of Object.keys(node)) { const value = node[key]; if (Array.isArray(value)) for (const child of value) visit(child); else if (value && typeof value.type === 'string') visit(value); }
  };
  visit(ast);
  return edits;
}

// A Ruby setter override that calls `super` (`def x=(value); super; ...; end`) arrives as `set x(value) { super.x(value); ... }`.
// It is `super.x = value`, and the override (which shadows the parent's accessor) needs a getter that reads it back.
function setterSuperEdits(ast, js) {
  const edits = [];
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.superClass && node.body?.body) {
      const members = node.body.body;
      for (const member of members) {
        if (member.type !== 'MethodDefinition' || member.kind !== 'set' || member.computed || member.key.type !== 'Identifier') continue;
        const name = member.key.name;
        const stack = [member.value.body];
        let converted = false;
        while (stack.length) {
          const current = stack.pop();
          if (!current || typeof current.type !== 'string') continue;
          if (current.type === 'CallExpression' && current.callee.type === 'MemberExpression' && current.callee.object.type === 'Super' && !current.callee.computed
            && current.callee.property.name === name && current.arguments.length === 1) {
            edits.push({ pos: current.start, del: current.end - current.start, text: `super.${name} = ${js.slice(current.arguments[0].start, current.arguments[0].end)}` });
            converted = true;
          }
          for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value.type === 'string') stack.push(value); }
        }
        const hasGetter = members.some(other => other.type === 'MethodDefinition' && other.kind === 'get' && other.key.type === 'Identifier' && other.key.name === name && other.static === member.static);
        if (converted && !hasGetter) edits.push({ pos: member.start, text: `get ${name}() { return super.${name} }
  ` });
      }
    }
    for (const key of Object.keys(node)) { const value = node[key]; if (Array.isArray(value)) for (const child of value) visit(child); else if (value && typeof value.type === 'string') visit(value); }
  };
  visit(ast);
  return edits;
}

// A Ruby module keeps state in its own instance variables (`@cache`) and its functions call each other. Ruby2JS emits an IIFE:
// the top-level `this._cache = {}` runs against the IIFE's outer `this`, the exported functions run with `this` = the exports,
// and bare calls between sibling functions lose `this` altogether. One shared self object fixes all three: it is the `this` of
// the module's top level, it IS the exported object, and sibling calls carry `this` (`name.call(this, ...)`).
function moduleSelfEdits(ast, js) {
  const edits = [];
  const usesThis = (node, deep) => {
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current.type !== 'string') continue;
      if (current.type === 'ThisExpression') return true;
      if (!deep && current !== node && (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression' || current.type === 'ClassDeclaration' || current.type === 'ClassExpression')) continue;
      for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value.type === 'string') stack.push(value); }
    }
    return false;
  };
  const iifes = [];
  const find = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.arguments.length === 0 && node.callee.type === 'ArrowFunctionExpression' && node.callee.params.length === 0) iifes.push(node);
    for (const key of Object.keys(node)) { const value = node[key]; if (Array.isArray(value)) for (const child of value) find(child); else if (value && typeof value.type === 'string') find(value); }
  };
  find(ast);
  for (const call of iifes) {
    {
      if (call.callee.body.type !== 'BlockStatement') continue;
      const body = call.callee.body;
      const last = body.body[body.body.length - 1];
      if (last?.type !== 'ReturnStatement' || last.argument?.type !== 'ObjectExpression') continue;
      const functions = new Map(body.body.filter(node => node.type === 'FunctionDeclaration' && node.id).map(node => [node.id.name, node]));
      if (!functions.size || ![...functions.values()].some(fn => usesThis(fn.body, false)) && !body.body.some(node => node.type !== 'FunctionDeclaration' && node.type !== 'ReturnStatement' && usesThis(node, false))) continue;
      // `this.constructor` on a Ruby module is the module's own singleton class: distinct per module, used to memoize
      // module-level state (`this.constructor._cache ||= ...`). A plain `{}`'s `.constructor` is JS's `Object`, shared by
      // every module in the game; giving each `__self` its own fake constructor keeps that state per module.
      edits.push({ pos: body.start + 1, text: ' const __self = {}; Object.defineProperty(__self, "constructor", { value: __self, enumerable: false }); ' });
      // Top-level `this` (module-level ivars) -> the shared self.
      for (const node of body.body) {
        if (node.type === 'FunctionDeclaration' || node.type === 'ReturnStatement') continue;
        const stack = [node];
        while (stack.length) {
          const current = stack.pop();
          if (!current || typeof current.type !== 'string') continue;
          if (current.type === 'ThisExpression') { edits.push({ pos: current.start, del: current.end - current.start, text: '__self' }); continue; }
          if (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression' || current.type === 'ClassDeclaration' || current.type === 'ClassExpression') continue;
          for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value.type === 'string') stack.push(value); }
        }
      }
      // The export IS the shared self (getters kept).
      edits.push({ pos: last.argument.start, text: 'Object.defineProperties(__self, Object.getOwnPropertyDescriptors(' }, { pos: last.argument.end, text: '))' });
      // Sibling calls inside the module's functions carry `this`.
      for (const fn of functions.values()) {
        const stack = [fn.body];
        while (stack.length) {
          const current = stack.pop();
          if (!current || typeof current.type !== 'string') continue;
          if (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression' || current.type === 'ClassDeclaration' || current.type === 'ClassExpression') continue;
          if (current.type === 'CallExpression' && current.callee.type === 'Identifier' && functions.has(current.callee.name) && !current.optional && usesThis(functions.get(current.callee.name).body, false)) {
            edits.push({ pos: current.callee.end, del: 1, text: `.call(this${current.arguments.length ? ', ' : ''}` });
          }
          for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value.type === 'string') stack.push(value); }
        }
      }
    }
  }
  return edits;
}

// A Ruby class can define both `def columns` (a method) and `def columns=(v)` (a setter). In a JS class the accessor replaces
// the method under the same key. The method is renamed and a getter returns a function that calls it, so `x.columns()` and
// `x.columns = 2` both work.
function methodSetterClashEdits(ast) {
  const edits = [];
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.body?.body) {
      const members = node.body.body;
      for (const setter of members) {
        if (setter.type !== 'MethodDefinition' || setter.kind !== 'set' || setter.computed || setter.static || setter.key.type !== 'Identifier') continue;
        const name = setter.key.name;
        const hasGetter = members.some(other => other.type === 'MethodDefinition' && other.kind === 'get' && !other.static && other.key.type === 'Identifier' && other.key.name === name);
        const method = members.find(other => other.type === 'MethodDefinition' && other.kind === 'method' && !other.static && !other.computed && other.key.type === 'Identifier' && other.key.name === name);
        if (!method || hasGetter) continue;
        edits.push({ pos: method.key.start, del: method.key.end - method.key.start, text: `__method_${name}` });
        edits.push({ pos: setter.start, text: `get ${name}() { const self = this; return function () { return self.__method_${name}(...arguments) } }
  ` });
      }
    }
    for (const key of Object.keys(node)) { const value = node[key]; if (Array.isArray(value)) for (const child of value) visit(child); else if (value && typeof value.type === 'string') visit(value); }
  };
  visit(ast);
  return edits;
}

export function lowerRuby(js, known = null, zeroArg = null) {
  js = repairCallAssignments(js);
  // `::Sprite` (a top-level constant, from inside a namespace) is emitted as `Function("return this")().Sprite`: the runtime's own globals.
  js = js.split('Function("return this")()').join('__global');
  let ast;
  try { ast = parse(js); } catch { return js; }
  const edits = [...ivarCollisionEdits(ast), ...optionalReadEdits(ast, known), ...bareFunctionCallEdits(ast, zeroArg), ...constructorOrderEdits(ast, js), ...setterSuperEdits(ast, js), ...moduleSelfEdits(ast, js), ...methodSetterClashEdits(ast)];
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node.type === 'BinaryExpression' && node.operator === '%') {
      const at = js.slice(node.left.end, node.right.start).indexOf('%');
      if (at >= 0) edits.push({ pos: node.start, text: '__mod(' }, { pos: node.left.end + at, del: 1, text: ',' }, { pos: node.end, text: ')' });
    }
    // `defined?(name)` arrives as `typeof name() !== 'undefined'`, which calls the function with no arguments (and runs
    // it): it is a probe, so drop the call.
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'CallExpression' && node.argument.arguments.length === 0
      && (node.argument.callee.type === 'Identifier' || node.argument.callee.type === 'MemberExpression')) {
      edits.push({ pos: node.argument.callee.end, del: node.argument.end - node.argument.callee.end, text: '' });
    }
    // `list.map.with_index { |x, i| ... }` arrives as `list.map.with_index(fn)`: `.map(fn)` already passes (item, index).
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'with_index'
      && node.callee.object.type === 'MemberExpression' && !node.callee.object.computed && node.arguments.length === 1 && node.arguments[0].type !== 'Literal') {
      const base = node.callee.object.property;
      edits.push({ pos: node.callee.object.end, del: node.callee.property.end - node.callee.object.end, text: '' });
      if (base.name === 'each') edits.push({ pos: base.start, del: base.end - base.start, text: 'forEach' });
    }
    // Symbol-to-proc (`list.map(&:to_i)`) arrives as `list.map("to_i")`: make it the arrow it means.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.arguments.length === 1
      && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.arguments[0].value)
      && ['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'flatMap', 'reduce'].includes(node.callee.property.name) && node.callee.property.name !== 'reduce') {
      edits.push({ pos: node.arguments[0].start, del: node.arguments[0].end - node.arguments[0].start, text: `(item) => item.${node.arguments[0].value}()` });
    }
    // `for (x of hash)`: Ruby's `hash.each_value { |x| }` (x is the value) and `hash.each { |pair| pair[1] }` (x is the pair)
    // both compile to it, and a plain object is not iterable. A single loop variable that the body never indexes is a
    // values loop; anything else iterates [key, value] pairs. The runtime helpers pass real iterables through untouched.
    if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration' && node.left.declarations[0].id.type === 'Identifier') {
      const variable = node.left.declarations[0].id.name;
      let indexed = false;
      const scan = [node.body];
      while (scan.length && !indexed) {
        const current = scan.pop();
        if (!current || typeof current.type !== 'string') continue;
        if (current.type === 'MemberExpression' && current.computed && current.object.type === 'Identifier' && current.object.name === variable) indexed = true;
        for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) scan.push(...value); else if (value && typeof value.type === 'string') scan.push(value); }
      }
      const helper = indexed ? '__each' : '__values';
      edits.push({ pos: node.right.start, text: `${helper}(` }, { pos: node.right.end, text: ')' });
    } else if (node.type === 'ForOfStatement') {
      edits.push({ pos: node.right.start, text: '__each(' }, { pos: node.right.end, text: ')' });
    }
    // A Ruby global assigned inside a method (`$game_temp = Game_Temp.new`) is emitted as a local (`let $game_temp = ...`),
    // so it never reaches the rest of the game: make it a plain assignment (the runtime's scope stores globals).
    if (node.type === 'VariableDeclaration' && node.kind === 'let' && node.declarations.length === 1 && node.declarations[0].id.type === 'Identifier'
      && node.declarations[0].id.name.startsWith('$') && node.declarations[0].init) {
      edits.push({ pos: node.start, del: 4, text: '' });
    }
    // Ruby's `extend`/`include` never override a method the class defines itself; the emitted
    // `Object.defineProperties(X, Object.getOwnPropertyDescriptors(Mixin))` does. `__mixin` defines only what is missing.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier'
      && node.callee.object.name === 'Object' && node.callee.property.name === 'defineProperties' && node.arguments.length === 2
      && node.arguments[1].type === 'CallExpression' && node.arguments[1].callee.type === 'MemberExpression' && node.arguments[1].callee.property?.name === 'getOwnPropertyDescriptors') {
      edits.push({ pos: node.callee.start, del: node.callee.end - node.callee.start, text: '__mixin' });
    }
    // An explicit Ruby setter `def x=(v)` is emitted as `set _x(v)`, whose body assigns the field `this._x`: it calls itself
    // forever, and `obj.x = v` never reaches it. The setter is named `x`.
    if (node.type === 'MethodDefinition' && node.kind === 'set' && !node.computed && node.key.type === 'Identifier' && node.key.name.startsWith('_') && node.key.name.length > 1) {
      const field = node.key.name;
      let assignsField = false;
      const scan = [node.value.body];
      while (scan.length && !assignsField) {
        const current = scan.pop();
        if (!current || typeof current.type !== 'string') continue;
        if (current.type === 'MemberExpression' && !current.computed && current.object.type === 'ThisExpression' && current.property.name === field) assignsField = true;
        for (const key of Object.keys(current)) { const value = current[key]; if (Array.isArray(value)) scan.push(...value); else if (value && typeof value.type === 'string') scan.push(value); }
      }
      if (assignsField) edits.push({ pos: node.key.start, del: 1, text: '' });
    }
    // Ruby's `str.slice!(start, len)` (removes and returns a piece of a String) arrives as `str.splice(start, len)`, which only Arrays
    // have. Both forms go through `__splice`, which mutates an array in place and, for a string, returns the removed piece
    // and reassigns the variable.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'splice'
      && (node.callee.object.type === 'Identifier' || (node.callee.object.type === 'MemberExpression' && !node.callee.object.optional)) && node.arguments.length >= 1) {
      const target = js.slice(node.callee.object.start, node.callee.object.end);
      const args = node.arguments.map(argument => js.slice(argument.start, argument.end)).join(', ');
      edits.push({ pos: node.start, del: node.end - node.start, text: `__splice(${target}, (__v) => { ${target} = __v }, ${args})` });
    }
    const list = node.type === 'BlockStatement' || node.type === 'Program' ? node.body : node.type === 'SwitchCase' ? node.consequent : null;
    if (list) {
      const declaredHere = new Set();   // names already declared (or hoisted) at this level, in source order
      list.forEach((statement, index) => {
        if (statement.type === 'VariableDeclaration') for (const declarator of statement.declarations) if (declarator.id.type === 'Identifier') declaredHere.add(declarator.id.name);
        const blocks = blocksOf(statement);
        if (!blocks.length) return;
        const declared = new Map();   // name -> declaration nodes (single-declarator `let` directly inside the blocks)
        const blocked = new Set();    // names declared in a form we do not rewrite
        for (const block of blocks) for (const inner of block.body) {
          if (inner.type !== 'VariableDeclaration' || inner.kind !== 'let') continue;
          for (const declarator of inner.declarations) {
            if (declarator.id.type !== 'Identifier') continue;
            if (inner.declarations.length > 1) blocked.add(declarator.id.name);
            else declared.set(declarator.id.name, [...(declared.get(declarator.id.name) || []), inner]);
          }
        }
        const names = new Set([...declared.keys()].filter(name => !blocked.has(name)));
        if (!names.size) return;
        const later = new Set();
        list.slice(index + 1).forEach(sibling => mentions(sibling, names, later));
        // A later declaration that owns the name (multi-declarator, or one that does not read its own earlier value)
        // is a different scope: leave the block-local alone.
        for (const sibling of list.slice(index + 1)) {
          if (sibling.type !== 'VariableDeclaration') continue;
          for (const declarator of sibling.declarations) {
            if (declarator.id.type !== 'Identifier' || !later.has(declarator.id.name)) continue;
            const reads = new Set();
            if (declarator.init) mentions(declarator.init, new Set([declarator.id.name]), reads);
            if (sibling.declarations.length > 1 || !reads.size) later.delete(declarator.id.name);
          }
        }
        if (!later.size) return;
        for (const name of later) {
          for (const declaration of declared.get(name)) edits.push({ pos: declaration.start, del: 4, text: '' });
          // A later `let name = ...` at the same level is the same Ruby variable: make it a plain assignment.
          for (const sibling of list.slice(index + 1)) if (sibling.type === 'VariableDeclaration' && sibling.kind === 'let' && sibling.declarations.length === 1 && sibling.declarations[0].id.name === name) edits.push({ pos: sibling.start, del: 4, text: '' });
        }
        const fresh = [...later].filter(name => !declaredHere.has(name));
        for (const name of fresh) declaredHere.add(name);
        if (fresh.length) edits.push({ pos: statement.start, text: `let ${fresh.join(', ')}; ` });
      });
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) stack.push(child);
      else if (value && typeof value.type === 'string') stack.push(value);
    }
  }
  edits.sort((a, b) => b.pos - a.pos);
  let out = js;
  for (const edit of edits) out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos + (edit.del || 0));
  return out;
}
export const lowerModulo = lowerRuby;

// units: { name: js }, snippets: [{ js }] (statement lists run as a function body).
// Returns { units, snippets: [{ js, async }], names, report } with every source rewritten where it blocks.
export function liftBlocking(units, snippets, { knownMethods = null } = {}) {
  const known = knownMethods ? new Set(knownMethods) : null;
  // Zero-parameter top-level library functions (`function pbInBugContest() {`), by name.
  const zeroArg = new Set();
  for (const js of Object.values(units)) for (const match of js.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)/gm)) zeroArg.add(match[1]);
  const report = { functions: 0, awaits: 0, unawaited: 0, unparsed: [] };
  const parsed = [];
  const parseAll = (kind, key, js) => {
    try { const ast = parse(js); parsed.push({ kind, key, js, ast, functions: collectFunctions(ast) }); }
    catch (error) { report.unparsed.push(`${kind}:${key}`); }
  };
  units = Object.fromEntries(Object.entries(units).map(([name, js]) => [name, lowerRuby(js, known, zeroArg)]));
  snippets = snippets.map(snippet => ({ ...snippet, js: lowerRuby(snippet.js, known, zeroArg) }));
  for (const [name, js] of Object.entries(units)) parseAll('unit', name, js);
  snippets.forEach((snippet, index) => parseAll('snippet', index, snippet.js));
  const names = asyncNamesOf(parsed);
  const outUnits = { ...units };
  const outSnippets = snippets.map(snippet => ({ js: snippet.js, async: false }));
  for (const entry of parsed) {
    const { js, edits, programAsync } = editsFor(entry, names, report);
    if (entry.kind === 'unit' && edits) outUnits[entry.key] = js;
    else if (entry.kind === 'snippet' && edits) outSnippets[entry.key] = { js, async: programAsync };
  }
  return { units: outUnits, snippets: outSnippets, names: [...names.all].sort(), strongNames: [...names.strong].sort(), report };
}
