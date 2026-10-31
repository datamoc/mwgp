#!/usr/bin/env node
// Regression checks for the generic RGSS conversion/runtime fixes found by playing Pokemon Void through tools/play-all.mjs:
//   - alias chains on global methods (`alias old pbX` + `def pbX` inside a global module), across several scripts;
//   - a Ruby block passed to a method with optional parameters lands in the block parameter;
//   - `yield` inside a block of a method that names its block;
//   - `scan` (a global `match`) answers a list, never null;
//   - Kernel#format;
// Prints a JSON array of what passed; exits 1 on the first failure.
import { indexScripts, transpileUnit } from './rgss-library.mjs';
import { shiftTrailingBlock, bindYieldToBlock, emptyListForGlobalMatch, attachConditionalMethods, classCaseSwitches, labelLoopBreaks, hoistLocalSetters } from './rgss-block-arg.mjs';
import { lowerRuby, liftBlocking } from './rgss-async.mjs';
import { resolveInitializeAliases } from './rgss-initialize-alias.mjs';
import { collidingPredicates, setPredicateRenames, renamePredicates } from './rgss-predicates.mjs';
import { rubyFormat } from '../src/player/rgss-script.js';

const passed = [];
const check = (condition, label) => { if (!condition) { console.error(`FAIL: ${label}`); process.exit(1); } passed.push(label); };
// The runtime's store for fields a derived constructor sets before `super()` (src/player/rgss-script.js `__RUBY_PRE`).
const makePre = () => ({ target: null, fields: null, set(t, k, v) { if (this.target !== t) { this.target = t; this.fields = {}; } this.fields[k] = v; }, apply(o, t) { if (this.fields && this.target === t) { const f = this.fields; this.target = null; this.fields = null; Object.assign(o, f); } } });

// 1. Alias chain: a core def, then two scripts wrapping it from inside `module Kernel`.
{
  const scripts = [
    { name: 'Messages', source: 'def pbMessage(message, commands = nil, &block)\n  [:core, message]\nend\n' },
    { name: 'Mod A', source: 'module Kernel\n  alias mod_a_pbMessage pbMessage unless method_defined?(:mod_a_pbMessage)\n  def pbMessage(message, *args, &block)\n    mod_a_pbMessage(message, *args, &block)\n  end\nend\n' },
    { name: 'Mod B', source: 'module Kernel\n  alias mod_b_pbMessage pbMessage\n  def pbMessage(*args, &block)\n    mod_b_pbMessage(*args, &block)\n  end\nend\n' }
  ];
  const js = transpileUnit(indexScripts(scripts).units.get('pbMessage'));
  const declared = [...js.matchAll(/function (\w+)\(/g)].map(match => match[1]).sort();
  check(JSON.stringify(declared) === JSON.stringify(['mod_a_pbMessage', 'mod_b_pbMessage', 'pbMessage']), 'alias chain across scripts keeps every wrapped definition');
}

// 2. Trailing block with optional parameters.
{
  const js = shiftTrailingBlock('function f(message, commands=null, cmd=0, skin=null, block) { return [message, commands, cmd, skin, typeof block]; }');
  const f = new Function(`${js}; return f;`)();
  check(JSON.stringify(f('m', ['a'], 1, () => 1)) === JSON.stringify(['m', ['a'], 1, null, 'function']), 'a block passed after fewer arguments reaches the block parameter');
  check(JSON.stringify(f('m', ['a'], 1, 'skin', () => 1)) === JSON.stringify(['m', ['a'], 1, 'skin', 'function']), 'a full argument list is left alone');
}

// 3. yield inside a nested block binds to the method's named block.
{
  const js = bindYieldToBlock('function f(id, block) { return [1].map((x, _implicitBlockYield=null) => { if (_implicitBlockYield) return _implicitBlockYield(x); return null; }); }');
  const f = new Function(`${js}; return f;`)();
  check(JSON.stringify(f(0, value => value + 1)) === '[2]', 'yield inside a nested block calls the enclosing block parameter');
  const own = bindYieldToBlock('function f(_implicitBlockYield=null) { return [1].map((x, _implicitBlockYield=null) => _implicitBlockYield(x)); }');
  check(own.includes('=> _implicitBlockYield(x)'), 'a nested yield keeps the current method\'s implicit block parameter');
}

// 4. scan with no match is an empty list.
{
  const js = emptyListForGlobalMatch('function chars(text) { return String(text ?? "").match(/./gs).map(c => c); }');
  check(new Function(`${js}; return chars("");`)().length === 0 && new Function(`${js}; return chars("ab");`)().length === 2, 'a global match answers a list even when nothing matches');
}

// 4b. `a |= b` on arrays is a union.
{
  const js = lowerRuby('function f() { let k = [1, 2]; k |= [2, 3]; return k; }');
  check(JSON.stringify(new Function(`const __bor = (a, b) => Array.isArray(a) ? [...new Set([...a, ...b])] : a | b; ${js}; return f();`)()) === '[1,2,3]', 'a |= b on arrays becomes a union');
}

// 4c. A method redefined under `if method_defined?` reaches the class.
{
  const js = attachConditionalMethods('class Pokemon { ability_id() { return 1 } }' + String.fromCharCode(10) + 'if ("ability_id" in Pokemon.prototype) { function ability_id() { return 2 } }', 'Pokemon');
  check(new Function(`${js}; return new Pokemon().ability_id();`)() === 2, 'a conditional method definition is attached to the class prototype');
}

// 4d. A conditional setter definition replaces the setter, keeps the getter, and is not triggered by the assignment.
{
  const nl = String.fromCharCode(10);
  const js = attachConditionalMethods(['class W { get text() { return this._t } set text(v) { this._t = "old:" + v } }', '// alias old_set of text= resolved', 'if ("text" in W.prototype) { function text(v) { this._t = "new:" + v } }'].join(nl), 'W');
  const w = new Function(`${js}; const w = new W(); w.text = 'a'; return w.text;`)();
  check(w === 'new:a', 'a conditional setter definition replaces the setter and keeps the getter');
}

// 4e. A `private` in one script does not make the methods of the next script private.
{
  const nl = String.fromCharCode(10);
  const js = transpileUnit({ name: 'Menu', kind: 'const', methods: new Set(['open', 'helper']), sends: new Set(), consts: new Set(), pieces: [
    { script: 'A', text: ['class Menu', '  def helper', '    1', '  end', '  private', '  def secret', '    2', '  end', 'end'].join(nl) },
    { script: 'B', text: ['class Menu', '  def open', '    3', '  end', 'end'].join(nl) }] });
  check(/open/.test(js) && !/_open/.test(js) && !/_secret/.test(js) && /secret/.test(js), 'private methods keep their own names (no _name rename across scripts or subclasses)');
}

// 4f. `x?` and `x` defined in one class stay two methods; a built-in predicate name is never renamed.
{
  const nl = String.fromCharCode(10);
  const ruby = ['class Helper', '  def self.skip_battle?', '    true', '  end', '  def self.skip_battle(a)', '    a', '  end', '  def empty?', '    true', '  end', '  def empty', '    1', '  end', 'end'].join(nl);
  const clashing = collidingPredicates([ruby]);
  setPredicateRenames(clashing);
  check(clashing.has('skip_battle') && !clashing.has('empty'), 'a predicate and an action of the same name are detected, built-in predicate names are not');
  check(renamePredicates('Helper.skip_battle? && x.empty?') === 'Helper.skip_battle__q && x.empty?', 'predicate calls are renamed with their definitions, other predicates are not');
  setPredicateRenames([]);
}

// 4g. `case x when SomeClass` tests class membership.
{
  const js = classCaseSwitches('function f(arg) { switch (arg) { case Pokemon: return "p"; case Array: return "a"; default: return "d" } }');
  class Pokemon {}
  const run = new Function('Pokemon', 'Array', '__ruby_is_a', js + '; return [f(new Pokemon()), f([1]), f(3)].join();');
  check(run(Pokemon, Array, (value, klass) => value instanceof klass) === 'p,a,d', 'a case/when on classes becomes an instance test');
}

// 4g2. The subject may be an indexed read (`case args[0]`).
{
  const js = classCaseSwitches('function f(args) { switch (args[0]) { case String: return "s"; default: return "d" } }');
  const run = new Function('String', '__ruby_is_a', js + '; return [f(["x"]), f([3])].join();');
  check(run(String, (value, klass) => typeof value === 'string' && klass === String) === 's,d', 'a case/when on classes also works on an indexed subject');
}

// 4b. `!x.is_a?(K)` is emitted `!x instanceof K` (the negation lands on x): it must negate the whole test.
{
  const js = lowerRuby('function f(p, l){ if (!p instanceof Pokemon) p = new Pokemon(p, l); if (!p) return 1; return p; }');
  check(js.includes('if (!(p instanceof Pokemon)) p = new Pokemon(p, l);') && js.includes('if (__falsy(p)) return 1;'), 'a negated is_a? test negates the instanceof, a plain !x still reads Ruby truthiness');
}

// 4c. `Move::Struggle.new` inside `class Battle` is `Battle::Move::Struggle`, also when the unit holds a Ruby2JS shape that only the later
// repairs make parseable (a method with an implicit block parameter is first emitted as an invalid getter): the qualification pass used to
// skip such a unit whole, so a global `Move` was found instead of the nested one.
{
  const scripts = [
    { name: 'Battle', source: 'class Battle\n  def initialize\n    @struggle = Move::Struggle.new(self, nil)\n  end\n\n  def eachBattler\n    @list.each { |b| yield b }\n  end\nend\n' },
    { name: 'Move', source: 'class Battle::Move\n  def id; 1; end\nend\n' },
    { name: 'Struggle', source: 'class Battle::Move::Struggle < Battle::Move\n  def swap(user)\n    user.attack, user.defense = user.defense, user.attack\n  end\nend\n' }
  ];
  const js = transpileUnit(indexScripts(scripts).units.get('Battle'));
  check(js.includes('new Battle.Move.Struggle(this, null)'), 'a nested class named from inside its enclosing class is qualified, even in a unit the first pass could not parse');
}

// 4d. A derived `initialize` that never calls `super` skips its parents' `initialize` (Ruby); one that does, runs them.
{
  const js = lowerRuby('class A { constructor(b, m) { this._id = m.id } }\nclass B extends A { constructor(b, m) { this._x = 1 } }\nclass C extends A { constructor(b, m) { super(b, m); this._y = 2 } }');
  const flag = { on: false };
  const run = (skip) => new Function('__RUBY_SKIP', '__RUBY_PRE', js + '; const out = []; out.push(new B(1, undefined)._x); try { new C(1, undefined); out.push("no throw"); } catch { out.push("parent ran"); } out.push(new C(1, { id: 5 })._id); return out;')(skip, makePre());
  check(JSON.stringify(run(flag)) === '[1,"parent ran",5]' && flag.on === false, 'a constructor without super skips its parents, one with super runs them, and the skip flag is lowered again');
}

// 4e. A game that reopens `class String` must not turn `String(x)` (the `.to_s` lowering) into `String.call(x)`: that call runs
// `String()` with `x` as `this`, an empty string, so every `case x.to_s` matched nothing. A game module's own `call` still is one.
{
  const js = lowerRuby('function f(rule) { return String(rule ?? "").toLowerCase() + MultipleForms("a", 1); }', null, null, new Set(['String', 'MultipleForms']));
  check(js.includes('String(rule ?? "")') && !js.includes('String.call') && js.includes('MultipleForms.call("a", 1)'), 'a reopened built-in keeps its conversion call, a game module still gets its .call');
}

// 4f. `x&.clone` / `x&.dup` are emitted `x?.()` by Ruby2JS (a call of x itself): the source is written out as the nil test.
{
  const js = transpileUnit(indexScripts([{ name: 'T', source: 'class T\n  def a(bgm)\n    @x = bgm&.clone\n    @y = bgm&.name\n  end\nend\n' }]).units.get('T'));
  check(js.includes('bgm == null ? null : bgm.clone()') && js.includes('bgm?.name') && !js.includes('bgm?.()'), 'a safe-navigation clone is a nil test plus the copy, other safe reads are untouched');
}

// 4g. Shapes Ruby2JS emits that are not JavaScript (a parallel attribute swap, an accessor with a parameter) used to make every analysis
// pass skip the whole unit, so a guarded `alias`+`def` stayed a stray block that never reached the class. They are repaired first, and the
// swap really swaps.
{
  const scripts = [
    { name: 'Core', source: 'class Battle\n  def pbStartBattle\n    return :orig\n  end\n\n  def swap(user)\n    user.attack, user.defense = user.defense, user.attack\n  end\n\n  def eachBattler\n    @l.each { |b| yield b }\n  end\nend\n' },
    { name: 'Mod', source: 'class Battle\n  if method_defined?(:pbStartBattle)\n    alias wrapOrig pbStartBattle\n    def pbStartBattle(*args)\n      return [:w, wrapOrig(*args)]\n    end\n  end\nend\n' }
  ];
  const js = transpileUnit(indexScripts(scripts).units.get('Battle'));
  const battle = new (new Function(js + '; return Battle;')())();
  const user = { attack: 1, defense: 2 };
  battle.swap(user);
  check(JSON.stringify([user.attack, user.defense, battle.pbStartBattle()]) === '[2,1,["w","orig"]]', 'a unit with an invalid-JS shape still gets its guarded alias chain attached, and a parallel attribute assignment swaps');
}

// 4h. A bare constant is looked up through the classes it is written in: `CommandMenu` inside `Battle::Scene` is `Battle::Scene::CommandMenu`
// (two levels under the unit), while the same bare name in `Battle::Battler` stays what it was (Ruby would not find it there either).
{
  const scripts = [
    { name: 'Scene', source: 'class Battle::Scene\n  def init\n    @menu = CommandMenu.new(self, 1)\n  end\n\n  class CommandMenu\n    def initialize(scene, n); @n = n; end\n  end\nend\n' },
    { name: 'Battler', source: 'class Battle::Battler\n  def probe\n    CommandMenu.new\n  end\nend\n' },
    { name: 'Battle', source: 'class Battle\n  def go; end\nend\n' }
  ];
  const js = transpileUnit(indexScripts(scripts).units.get('Battle'));
  check(js.includes('new Battle.Scene.CommandMenu(this, 1)') && js.includes('return new CommandMenu') && !js.includes('new Battle.Scene.CommandMenu\n'), 'a deeply nested class is found lexically from its enclosing class only');
}

// 4i. `Array.new(n) { |i| ... }` arrives as `new Array(n, fn)`, a two-element array in JS: the block must run once per index.
{
  const js = lowerRuby('function f(w) { const a = new Array(4, (i) => { return i * 2 }); const b = new Array(3).fill(0); const c = new Array(2, 7); return [a, b, c]; }');
  check(JSON.stringify(new Function(js + '; return f(1);')()) === '[[0,2,4,6],[0,0,0],[2,7]]', 'Array.new with a block builds its elements from the index; the other Array forms are untouched');
}

// 4j. Ruby sets ivars before `super` and the parent's initialize may read them through an overridable method: the plain `this._x = expr`
// statements ahead of `super()` are applied to the object before the parent's constructor runs.
{
  const js = lowerRuby('class Base { constructor(a) { this._a = a; this.build() } build() { this._built = this._battle.name } }\nclass Intro extends Base { constructor(a, battle) { this._battle = battle; this._tag = a + 1; super(a); this._after = 1 } build() { this._built = this._battle.name + ":" + this._tag } }');
  const result = new Function('__RUBY_SKIP', '__RUBY_PRE', js + '; const i = new Intro(5, { name: "B" }); return [i._built, i._after, i._battle.name];')({ on: false }, makePre());
  check(JSON.stringify(result) === '["B:6",1,"B"]', 'fields set before super are visible to the parent constructor, and the statements after super still run');
}

// 4k. `x.length()` is never right (an array's length is a property); a call with arguments or an optional call is left alone.
{
  const js = lowerRuby('function f(a, o) { return [a.length(), a.length, o.length(1), o?.length(), a.size()]; }');
  check(js.includes('return [a.length, a.length, o.length(1), o?.length(), a.size()]'), 'a zero-argument length() call becomes the property read');
}

// 5. Kernel#format.
check(rubyFormat('%s_%d', ['map', 3]) === 'map_3', 'format %s_%d');
check(rubyFormat('%05.1f|%-5s|%+d|%x|%%', [3.14159, 'ab', 7, 255]) === '003.1|ab   |+7|ff|%', 'format flags, width and precision');
check(rubyFormat('%{a}-%<b>03d', [{ a: 'x', b: 7 }]) === 'x-007', 'format named references');

// A module nested in a class is emitted after it as a sibling const; the game reaches it as `Class.Module`.
{
  const { attachNestedModules } = await import('../src/player/rgss-script.js');
  const nested = 'class Win {\n  constructor() { this.flags = Win.Bits.A | Win.Bits.B }\n};\nconst Bits = (() => { const A = 1; const B = 2; return { A, B } })()';
  const fixed = attachNestedModules(nested);
  check(new Function(`${fixed}; return new Win().flags;`)() === 3, 'a module nested in a class is reachable as Class.Module');
  check(attachNestedModules('class Win {}\nconst Bits = (() => ({}))()') === 'class Win {}\nconst Bits = (() => ({}))()', 'an unused sibling module is left alone');
  check(attachNestedModules('class Win {}\nWin.Bits = 1;\nconst Bits = (() => ({}))();\nlet x = Win.Bits') === 'class Win {}\nWin.Bits = 1;\nconst Bits = (() => ({}))();\nlet x = Win.Bits', 'an existing assignment is not overridden');
}

// 4h. A reopened built-in with no superclass: the alias of its engine `initialize` becomes `self.set`; a derived class is left alone.
{
  const nl = String.fromCharCode(10);
  const own = ['class Color', '  alias init_original initialize', '  def initialize(*args)', '    init_original(*args)', '  end', 'end', ''].join(nl);
  const derived = ['class Foo < Bar', '  alias old_init initialize', '  def initialize(a)', '    old_init(a)', '  end', 'end', ''].join(nl);
  check(resolveInitializeAliases(own).source.includes('self.set(*args)') && !resolveInitializeAliases(own).source.includes('init_original(*args)'), 'a reopened built-in value class calls set where it called the aliased engine initialize');
  check(resolveInitializeAliases(derived).source.includes('old_init(a)'), 'an alias of an inherited initialize is not rewritten into set');
}

// 4i. A method a mod adds with `Outer.Scene.prototype.update = async function` belongs to class Scene, so `this.update()` inside
// Scene awaits it even though an unrelated class defines a synchronous `update`.
{
  const unit = [
    'Outer.Scene = class {',
    '  run() { this.update(); }',
    '};',
    'class Other { update() { return 1; } }',
    'Outer.Scene.prototype.update = async function update() { await Graphics.update(); };'
  ].join(String.fromCharCode(10));
  const lifted = liftBlocking({ Outer: unit }, []).units.Outer;
  check(lifted.includes('(await this.update())'), 'this.name() awaits a prototype-assigned async method of the same nested class');
}

// 4j. `this._scene.menu()` inside a class that owns a nested Scene awaits the Scene's async method.
{
  const unit = [
    'class Battle {',
    '  loop() { return this._scene.menu(); }',
    '}',
    'Battle.Scene = class {',
    '  async menu() { await Graphics.update(); }',
    '};',
    'class Elsewhere { menu() { return 1; } }'
  ].join(String.fromCharCode(10));
  const lifted = liftBlocking({ Battle: unit }, []).units.Battle;
  check(lifted.includes('(await this._scene.menu())'), 'this._scene.f() awaits the async method of the nested Scene class');
}

// 4k. A splat of nil is nothing (Ruby), not a TypeError (JS).
{
  const out = new Function(lowerRuby('const cb = [1, 2]; const pick = (...a) => a.length; return pick(...cb[2]) + pick(...[1, 2]);'))();
  check(out === 2, 'a spread of an undefined value passes no arguments');
}

// 4l. `super(*arg)` reaches the parent with the arguments, not with a Range object.
{
  const out = lowerRuby('class P { constructor(...a) { this.n = a.length; } } class C extends P { constructor(...arg) { super(new $Range(null, arg, true)); } }');
  check(out.includes('super(...arg)') && !out.includes('$Range'), 'a super call whose splat was read as a beginless range is a spread again');
}

// 4m. A Ruby `break` inside a case leaves the loop, not just the switch; the case's own terminator and loops inside it are untouched.
{
  const js = labelLoopBreaks('function f(cmds) { const out = []; while (true) { const c = cmds.shift(); switch (c) { case 0: if (c === 0) break; break; case 1: for (const x of [1, 2]) { if (x) break; } out.push("one"); break; default: out.push("d") } if (c === undefined) break; out.push("after" + c); } return out.join(); }');
  const run = new Function(js + '; return f;')();
  check(run([1, 1, 0, 9]) === 'one,after1,one,after1', 'a break nested in a case leaves the enclosing loop, other breaks keep their target');
}

// 4n. A function that runs its block (`yield`) waits for a block that waits: the wrapper awaits it, the callback is async, the caller awaits the wrapper.
{
  const unit = [
    'function logonerr(_implicitBlockYield = null) { try { _implicitBlockYield() } catch (e) { return 0 } }',
    'class Loop { async phase() { await Graphics.update(); } async run() { logonerr(() => this.phase()); } }'
  ].join(String.fromCharCode(10));
  const lifted = liftBlocking({ Loop: unit }, []).units.Loop;
  check(lifted.includes('(await _implicitBlockYield())') && lifted.includes('async () => (await this.phase())') && lifted.includes('(await logonerr('), 'a block wrapper awaits a blocking callback and its caller awaits the wrapper');
}

// 4o. A Ruby local named like an accessor stays a local: `this.n = v` next to a bare read of `n` in the same function.
{
  const js = hoistLocalSetters('class W { set n(v) { this._n = v; this.refresh() } refresh() { if (this.a) { this.n = 16; } else { this.n = 4; } return n + 1 } other() { this.n = 3; return this.n } }');
  check(js.includes('refresh() { let n;') && !js.includes('this.n = 16') && js.includes('other() { this.n = 3;'), 'an assignment to this.n becomes a local when the function also reads a bare n, other methods are untouched');
}

// 4p. `@x = ...` lines a root initialize runs before its super stay ahead of the super call once initialize is wrapped by an alias.
{
  const nl = String.fromCharCode(10);
  const src = ['class W < Base', '  def initialize(text = "")', '    @starting = true', '    super(0, 0, 33, 33)', '    @text = ""', '  end', '  alias mod_init initialize', '  def initialize(*args)', '    mod_init(*args)', '  end', 'end', ''].join(nl);
  const out = resolveInitializeAliases(src).source;
  check(out.indexOf('@starting = true') > 0 && out.indexOf('@starting = true') < out.indexOf('super(0, 0, 33, 33)') && out.indexOf('super(0, 0, 33, 33)') < out.indexOf('mod_init(*args)') && out.split('@starting').length === 2, 'the root initialize keeps its ivar assignments ahead of the super call');
}

// 4q. A setter wrapped by an alias keeps calling its parent's setter: `super(value)` in the renamed body is `super.visible = value`.
{
  const nl = String.fromCharCode(10);
  const scripts = [
    { name: 'Base', source: ['class Base', '  def visible=(value)', '    @v = value', '  end', 'end', ''].join(nl) },
    { name: 'Box', source: ['class Box < Base', '  def visible=(value)', '    super(value)', '  end', 'end', ''].join(nl) },
    { name: 'BoxMod', source: ['class Box', '  alias mod_set_visible visible=', '  def visible=(value)', '    mod_set_visible(value)', '  end', 'end', ''].join(nl) }
  ];
  const js = transpileUnit(indexScripts(scripts).units.get('Box'));
  check(js.includes('super.visible = value') && !js.includes('super.visible('), 'a renamed setter calls the parent setter as an assignment, not a method call');
}

// 4r. A compound assignment on a name the game defines as a method reads it as a call, like every other read.
{
  const out = lowerRuby('function f(sprite, z) { sprite.x *= z; this.count += 1; }', new Set(['x']));
  check(out.includes('sprite.x = sprite.x() * ( z)') && out.includes('this.count += 1'), 'sprite.x *= z becomes sprite.x = sprite.x() * (z), other names are untouched');
}

// 4s. A hoisted local is one variable for the whole method: a block's own `let` of the same name is removed, so the block updates it.
{
  const js = hoistLocalSetters('class W { a() { this.width = 1; for (const ch of list) { let width; width = 3 } return width } }');
  const out = new Function(js + '; const w = new W(); return w.a.call({ }, 1);');
  check(js.includes('let width;') && !js.includes('let width; width = 3') && js.includes('width = 3'), 'the loop assigns the method-level variable, not a copy of its own');
}

// 4t. Ruby Array#concat appends in place; a dropped-result concat statement becomes a push, a used one (Ruby `a + b`) is left alone.
{
  const out = new Function(lowerRuby('function f() { const list = [1]; list.concat([2, 3]); const sum = list.concat([9]); return [list.length, sum.length]; } return f();'))();
  check(out[0] === 3 && out[1] === 4, 'a concat statement mutates the array, a concat whose value is used does not');
}

// 4u. A field assigned from another field before super (`@trainer = @battle.owner(idx)`) is already set when the parent's constructor runs.
{
  const lowered = lowerRuby('class A { constructor(s) { this.seen = this._trainer; } } class B extends A { constructor(s, battle, idx) { this._battle = battle; this._trainer = this._battle.owner(idx); super(s); } }');
  const pre = { target: null, fields: null, set(t, k, v) { if (this.target !== t) { this.target = t; this.fields = {}; } this.fields[k] = v; }, self(t) { return this.target === t && this.fields ? this.fields : {}; }, apply(o, t) { if (this.fields && this.target === t) { const f = this.fields; this.target = null; this.fields = null; Object.assign(o, f); } } };
  const out = new Function('__RUBY_SKIP', '__RUBY_PRE', lowered + '; return new B(1, { owner: i => "owner" + i }, 7).seen;')({ on: false }, pre);
  check(out === 'owner7', 'the parent constructor sees a field computed from another field before super');
}

console.log(JSON.stringify(passed));
