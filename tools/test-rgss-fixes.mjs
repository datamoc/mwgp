#!/usr/bin/env node
// Regression checks for the generic RGSS conversion/runtime fixes found by playing Pokemon Void through tools/play-all.mjs:
//   - alias chains on global methods (`alias old pbX` + `def pbX` inside a global module), across several scripts;
//   - a Ruby block passed to a method with optional parameters lands in the block parameter;
//   - `yield` inside a block of a method that names its block;
//   - `scan` (a global `match`) answers a list, never null;
//   - Kernel#format;
// Prints a JSON array of what passed; exits 1 on the first failure.
import { indexScripts, transpileUnit } from './rgss-library.mjs';
import { shiftTrailingBlock, bindYieldToBlock, emptyListForGlobalMatch, attachConditionalMethods, classCaseSwitches } from './rgss-block-arg.mjs';
import { lowerRuby } from './rgss-async.mjs';
import { collidingPredicates, setPredicateRenames, renamePredicates } from './rgss-predicates.mjs';
import { rubyFormat } from '../src/player/rgss-script.js';

const passed = [];
const check = (condition, label) => { if (!condition) { console.error(`FAIL: ${label}`); process.exit(1); } passed.push(label); };

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

console.log(JSON.stringify(passed));
