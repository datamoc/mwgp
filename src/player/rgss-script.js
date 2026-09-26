// (Also runs MV/MZ event scripts, which are JavaScript already: `dialect: 'mv'` swaps the
// built-ins for the MV globals ($gameSwitches, $gameMap, ...); see the end of the built-ins.)
//
// Runs the JavaScript that tools/rgss-snippet.mjs produced from the Ruby in XP/VX/Ace
// event scripts (Call Script, Conditional Branch > Script), together with the slice of
// the game's OWN Ruby library those scripts reach (manifest `rubyLibrary`, built by
// tools/rgss-library.mjs). Nothing here knows any particular game: it implements the
// standard RGSS globals and lets the game's code run on top of them.
//
// Name resolution for every free identifier in a snippet or library unit, in order:
//   1. the RGSS built-ins below ($game_switches, $game_party, Audio, rand, ...);
//   2. a unit of the game's library, transpiled and evaluated lazily on first use
//      (classes, modules, constants and top-level `def`s, including the game's
//      Interpreter class, which snippets run "inside" as `this`);
//   3. a stub that warns loudly, once per name, and evaluates to undefined.
// Never silent success, never a crashed event.
//
// Snippets run synchronously; built-ins that take time (dialogue, balloons, animations)
// are queued and awaited in order once the snippet returns, which keeps visible effects
// in call order. Library code that needs a real blocking wait (`Graphics.update` loops,
// message windows) cannot run here and degrades to the warning path.
//
// The transpiled JS comes from the game's own files at conversion time, i.e. it is the
// same trust level as the game itself. It evaluates through `new Function` + `with`
// because free identifiers must resolve against the scope above.
// State lives where the player already keeps it: switches/variables in GameState (self
// switches under the converter's `self:<map>:<event>:<ch>` key) and everything else in
// `scene.rpgExtra`, which rides through transfers and saves.

import { createRgssScreen } from './rgss-screen.js';
import { createRgssClasses, createKeyProbe } from './rgss-classes.js';

const JS_BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'console', 'globalThis', 'arguments', '__result', 'Promise', 'TypeError', 'RangeError'
]);
// MV's own class naming convention (Window_Base, Scene_Map, Game_Actor, ...).
const ENGINE_CLASS_NAME = /^(?:Window|Scene|Sprite|Spriteset|Game|Tilemap|Bitmap)_\w+$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// One keyboard probe per page: RGSS `Input` reads it (see rgss-classes.js).
let keyProbe = null;
let lastMatch = null;   // Ruby's `$~`, set by String#test

// The few Ruby core methods that Ruby2JS leaves as plain method calls and that game code
// leans on everywhere. Installed once, non-enumerable, so nothing that iterates keys
// (including the rest of the player) notices them. Only defined where absent.
function installRubyCore() {
  const define = (target, name, value) => {
    if (!Object.hasOwn(target, name)) Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };
  const dup = function () {
    const value = this?.valueOf?.();
    if (value !== this || typeof this !== 'object') return value;
    if (Array.isArray(this)) return [...this];
    if (this instanceof Map) return new Map(this);
    if (this instanceof Set) return new Set(this);
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
  };
  // `Klass.singleton_class.prototype.foo = ...` aliases/defines class-level (singleton) methods; those live on the class
  // object itself here, so the singleton's prototype is the object.
  if (!Object.getOwnPropertyDescriptor(Object.prototype, 'singleton_class')) Object.defineProperty(Object.prototype, 'singleton_class', { configurable: true, enumerable: false, get() { return { prototype: this }; } });
  // Ruby Array methods with no JS counterpart (defined only when absent, so Ruby2JS's own lowerings win).
  define(Array.prototype, 'each_index', function (block) { for (let index = 0; index < this.length; index++) block(index); return this; });
  define(Array.prototype, 'each_slice', function (size, block) { const slices = []; for (let index = 0; index < this.length; index += size) slices.push(this.slice(index, index + size)); if (block) { slices.forEach(slice => block(slice)); return this; } return slices; });
  define(Array.prototype, 'each_cons', function (size, block) { const groups = []; for (let index = 0; index + size <= this.length; index++) groups.push(this.slice(index, index + size)); if (block) { groups.forEach(group => block(group)); return this; } return groups; });
  define(Array.prototype, 'compact', function () { return this.filter(value => value != null); });
  define(Array.prototype, 'uniq', function () { return [...new Set(this)]; });
  define(Array.prototype, 'take', function (count) { return this.slice(0, count); });
  define(Array.prototype, 'drop', function (count) { return this.slice(count); });
  define(Array.prototype, 'rotate', function (count = 1) { const length = this.length; if (!length) return []; const shift = ((count % length) + length) % length; return [...this.slice(shift), ...this.slice(0, shift)]; });
  define(Array.prototype, 'sample', function () { return this[Math.floor(Math.random() * this.length)]; });
  define(Array.prototype, 'shuffle', function () { const copy = [...this]; for (let index = copy.length - 1; index > 0; index--) { const other = Math.floor(Math.random() * (index + 1)); [copy[index], copy[other]] = [copy[other], copy[index]]; } return copy; });
  // Object reflection. Ruby2JS lowers `@name` to `this._name` and strips a trailing `?`/`!`, so `respond_to?` arrives as
  // `respond_to` and `instance_variable_defined?` as `instance_variable_defined`.
  const ivar = name => `_${String(name).replace(/^@/, '')}`;
  define(Object.prototype, 'instance_variable_get', function (name) { return this[ivar(name)]; });
  define(Object.prototype, 'instance_variable_set', function (name, value) { this[ivar(name)] = value; return value; });
  define(Object.prototype, 'instance_variable_defined', function (name) { return this[ivar(name)] !== undefined; });
  define(Object.prototype, 'instance_variables', function () { return Object.keys(this).filter(key => key.startsWith('_')).map(key => `@${key.slice(1)}`); });
  define(Object.prototype, 'respond_to', function (name) { const key = String(name); return this != null && (key in Object(this)); });
  define(Object.prototype, 'send', function (name, ...args) { const target = this[String(name)]; return typeof target === 'function' ? target.apply(this, args) : target; });
  define(Object.prototype, 'public_send', function (name, ...args) { return this.send(name, ...args); });
  define(Object.prototype, 'tap', function (block) { block(this); return this; });
  // `str =~ /re/` is emitted as `str.test(/re/)`.
  // It also records the match for `$~` (`$MATCH`: pre_match, post_match, groups), which the game's loops read.
  define(String.prototype, 'test', function (pattern) {
    const text = String(this);
    if (!(pattern instanceof RegExp)) { const at = text.indexOf(String(pattern)); lastMatch = at < 0 ? null : { text, index: at, groups: [String(pattern)] }; return at >= 0; }
    const flags = pattern.flags.replace('g', '').replace('y', '');
    const found = new RegExp(pattern.source, flags).exec(text);
    lastMatch = found ? { text, index: found.index, groups: [...found] } : null;
    return Boolean(found);
  });
  // Ruby String/Numeric conversions that Ruby2JS leaves as method calls.
  define(String.prototype, 'to_i', function (base = 10) { const value = parseInt(String(this).replace(/_/g, ''), base); return Number.isNaN(value) ? 0 : value; });
  define(String.prototype, 'to_f', function () { const value = parseFloat(String(this)); return Number.isNaN(value) ? 0 : value; });
  define(String.prototype, 'to_s', function () { return String(this); });
  define(String.prototype, 'to_sym', function () { return String(this); });
  define(Number.prototype, 'to_i', function () { return Math.trunc(this); });
  define(Number.prototype, 'to_f', function () { return Number(this); });
  define(Number.prototype, 'to_s', function (base = 10) { return this.toString(base); });
  // `disposed?` on an object that never had a disposable resource (a game wrapper around the inert display layer).
  define(Object.prototype, 'disposed', function () { return false; });
  // Hash#keys / #values as properties (Ruby2JS reads a Hash's `.keys` without a call): accessors on Object.prototype, so
  // Array and Map keep their own `keys()`/`values()` methods; assigning an own `keys`/`values` field still works.
  for (const name of ['keys', 'values']) {
    if (!Object.getOwnPropertyDescriptor(Object.prototype, name)) {
      Object.defineProperty(Object.prototype, name, {
        configurable: true, enumerable: false,
        get() { return name === 'keys' ? Object.keys(this) : Object.values(this); },
        set(value) { Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true }); }
      });
    }
  }
  // Hash#include? (key membership); Array and String keep their own `includes`.
  define(Object.prototype, 'includes', function (key) { return Object.prototype.hasOwnProperty.call(this, key); });
  // Hash#map / #each_pair over a plain object (a Ruby Hash): the block receives [key, value] pairs. Arrays, Maps and Sets
  // keep their own `map`.
  define(Object.prototype, 'map', function (block) { return Object.entries(this).map(block); });
  define(Object.prototype, 'each_pair', function (block) { Object.entries(this).forEach(([key, value]) => block(key, value)); return this; });
  // Hash#clear (a Ruby Hash is a plain object here; Array/Map/Set keep their own clear).
  define(Object.prototype, 'clear', function () { for (const key of Object.keys(this)) delete this[key]; return this; });
  define(Array.prototype, 'clear', function () { this.length = 0; return this; });
  define(Array.prototype, 'replace', function (other) { this.length = 0; this.push(...other); return this; });
  define(Array.prototype, 'delete', function (value) { let found = null; for (let index = this.length - 1; index >= 0; index--) if (this[index] === value) { found = this.splice(index, 1)[0]; } return found; });
  define(Array.prototype, 'insert', function (index, ...values) { this.splice(index < 0 ? this.length + index + 1 : index, 0, ...values); return this; });
  define(Array.prototype, 'flatten', function (depth = Infinity) { return this.flat(depth); });
  define(Array.prototype, 'sum', function (start = 0) { return this.reduce((total, value) => total + value, start); });
  define(Array.prototype, 'first', function (count) { return count === undefined ? this[0] : this.slice(0, count); });
  define(Array.prototype, 'last', function (count) { return count === undefined ? this[this.length - 1] : this.slice(Math.max(0, this.length - count)); });
  define(Array.prototype, 'min', function () { return this.length ? this.reduce((low, value) => (value < low ? value : low)) : null; });
  define(Array.prototype, 'max', function () { return this.length ? this.reduce((high, value) => (value > high ? value : high)) : null; });
  define(Array.prototype, 'count', function (match) { return match === undefined ? this.length : typeof match === 'function' ? this.filter(match).length : this.filter(value => value === match).length; });
  define(Array.prototype, 'delete_at', function (index) { const at = index < 0 ? this.length + index : index; if (at < 0 || at >= this.length) return null; return this.splice(at, 1)[0]; });
  define(Array.prototype, 'delete_if', function (block) { for (let index = this.length - 1; index >= 0; index--) if (block(this[index])) this.splice(index, 1); return this; });
  define(Object.prototype, 'dup', dup);
  define(Object.prototype, 'clone', dup);
  // Essentials uses Object#defined? to probe optional methods and properties.
  // Ruby2JS lowers that probe to .defined(name); keep it side-effect-light
  // and compatible with the module/object proxies used by the browser shim.
  define(Object.prototype, 'defined', function (name) {
    if (name == null) return false;
    const key = String(name).replace(/^:/, '');
    if (key in Object(this)) return true;
    try { return this?.[key] !== undefined; } catch { return false; }
  });
  define(String.prototype, 'tr', function (from, to) {
    const source = String(from ?? ''), target = String(to ?? '');
    if (!source) return String(this);
    const chars = [...source], replacements = [...target];
    const table = new Map(chars.map((char, index) => [char, replacements[Math.min(index, Math.max(0, replacements.length - 1))] ?? '']));
    return [...String(this)].map(char => table.has(char) ? table.get(char) : char).join('');
  });
  define(String.prototype, 'capitalize', function () {
    const value = String(this);
    return value.length ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
  });
  const nativeReplaceAll = String.prototype.replaceAll;
  Object.defineProperty(String.prototype, 'replaceAll', { configurable: true, writable: true, value: function (search, replacement) {
    // Ruby's gsub is global even when the source regex has no `g` flag;
    // Ruby2JS commonly lowers it to JavaScript replaceAll, which otherwise
    // throws for a non-global RegExp.
    if (search instanceof RegExp && !search.global) search = new RegExp(search.source, `${search.flags}g`);
    return nativeReplaceAll.call(String(this), search, replacement);
  } });
  // Module reflection used by "define only if missing" hotfix idioms.
  define(Function.prototype, 'method_defined', function (name) { return typeof this.prototype?.[name] === 'function'; });
  define(Function.prototype, 'private_method_defined', () => false);
  define(Function.prototype, 'instance_method', function (name) { return this.prototype?.[name]; });
  // Ruby2JS emits frozen Hash literals as Object.freeze({...}) and later
  // lowers Hash#each to `for ... of`. Install the iterator before freezing so
  // the resulting constant remains immutable but iterable.
  const nativeFreeze = Object.freeze;
  if (!nativeFreeze.__mwgpRubyHashFreeze) {
    const freeze = value => nativeFreeze(installRubyHashIterator(value));
    Object.defineProperty(freeze, '__mwgpRubyHashFreeze', { value: true });
    Object.freeze = freeze;
  }
}

function installRubyHashIterator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.hasOwn(value, Symbol.iterator)) return value;
  // Ruby2JS lowers `hash.keys` to a property access in a few generated
  // library units (e.g. constant token tables). Keep a
  // snapshot alongside the iterator so frozen Hash literals still expose
  // the Ruby API without turning `keys` into an eager function call.
  if (!Object.hasOwn(value, 'keys')) Object.defineProperty(value, 'keys', {
    configurable: true,
    value: Object.keys(value),
    enumerable: false
  });
  Object.defineProperty(value, Symbol.iterator, {
    configurable: true,
    value: function* () {
      for (const [key, entry] of Object.entries(this)) {
        let rubyKey = key;
        if (key.startsWith('/') && key.lastIndexOf('/') > 0) {
          const slash = key.lastIndexOf('/');
          try { rubyKey = new RegExp(key.slice(1, slash), key.slice(slash + 1)); } catch { /* ordinary string key */ }
        }
        yield [rubyKey, entry];
      }
    }
  });
  return value;
}

// Ruby Hash literals are emitted by the vendored Ruby2JS build as plain
// objects, while Hash#each is emitted as `for ... of hash`. Add the iterator
// lazily to plain objects exported by a library unit so both ordinary hashes
// and hashes whose keys were Ruby regular expressions behave like Ruby.
function adaptRubyHash(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value;
  seen.add(value);
  if (typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) installRubyHashIterator(value);
  // Module/class exports contain getters (Ruby2JS represents paren-less
  // methods as accessors). Inspect descriptors instead of reading them: eager
  // getter evaluation would execute game code while merely loading a unit and
  // can create initialization cycles or throw on missing shim state.
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) adaptRubyHash(descriptor.value, seen);
  }
  return value;
}

// The MV core (rpg_core.js) extends native prototypes; plugins call these freely.
// Installed once, non-enumerable, only where absent.
function installMvCore() {
  const define = (target, name, value) => {
    if (!Object.hasOwn(target, name)) Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };
  define(Number.prototype, 'clamp', function (min, max) { return Math.min(Math.max(this, min), max); });
  define(Number.prototype, 'mod', function (n) { return ((this % n) + n) % n; });
  define(Number.prototype, 'padZero', function (length) { return String(this).padZero(length); });
  define(String.prototype, 'padZero', function (length) { let text = String(this); while (text.length < length) text = '0' + text; return text; });
  define(String.prototype, 'contains', function (text) { return this.includes(text); });
  define(String.prototype, 'format', function (...args) { return this.replace(/%([0-9]+)/g, (_, index) => args[Number(index) - 1]); });
  define(Array.prototype, 'contains', function (element) { return this.includes(element); });
  define(Array.prototype, 'equals', function (array) { return Array.isArray(array) && this.length === array.length && this.every((value, index) => value === array[index]); });
  define(Array.prototype, 'clone', function () { return this.slice(0); });
  define(Math, 'randomInt', max => Math.floor(max * Math.random()));
}

export function createRgssRuntime(scene, { mapId, mapEvents = [], mapSize = {}, library = null, pluginLibrary = null, rubyData = null, fileIndex = null, textFiles = null, dialect = 'rgss' } = {}) {
  if (dialect === 'rgss') installRubyCore();
  if (dialect === 'mv') installMvCore();
  const warned = new Set();
  const warnOnce = (name, detail) => {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(`MWGP RGSS script call "${name}" is not implemented and was skipped`, detail ?? '');
  };
  const rgss = () => (scene.rpgExtra.rgss ||= { data: {} });

  let queue = null;
  let current = { state: null, event: null };
  const later = (name, thunk) => {
    if (!queue) return warnOnce(`${name} (needs a wait; unavailable inside a condition)`);
    queue.push(thunk);
  };

  // Callable placeholder: `Thing.method(args)` and deeper chains all funnel into one warning.
  const stub = path => new Proxy(function () {}, {
    get: (_, key) => key === Symbol.toPrimitive ? () => 0 : typeof key === 'symbol' ? undefined : stub(`${path}.${key}`),
    // An unknown helper handed a block (`with_forced_z { ... }`, `each_x { ... }`) is far more often a wrapper than a
    // no-op: skipping the block would silently drop its body, so it runs once, still warning that the helper is unknown.
    apply: (_, __, args) => { warnOnce(path); const block = args.find(argument => typeof argument === 'function'); return block ? block() : undefined; },
    construct: () => { warnOnce(`new ${path}`); return {}; },
    set: () => { warnOnce(`${path}=`); return true; }
  });

  // Free-form RGSS object ($game_temp, $game_system, ...): reads and writes just
  // persist under the object's name, so game code that stashes flags there works.
  // Methods the game's own class defines but this shim does not are borrowed from that class's
  // prototype (`className`), bound to the shim object, so game helpers such as
  // Game_Event#setTempSwitchOn run against the shim's state.
  // A shim object that borrows the game's methods never ran the game's `initialize`, so the instance variables those
  // methods read (`@tone`, `@pictures`, ...) would be missing: run the constructor once on a scratch instance and copy
  // the values it set (only the ones not stored yet).
  const seeded = new Set();
  const seedInstanceVariables = (name, Class, receiver, target) => {
    if (seeded.has(name)) return;
    seeded.add(name);
    try {
      const instance = new Class();
      for (const [key, value] of Object.entries(instance)) if (!(key in target) && rgss().data[`${name}.${key}`] === undefined) receiver[key] = value;
    } catch { /* a constructor that needs the engine: the methods that need its variables fail loudly as before */ }
  };
  const openObject = (name, extras = {}, className = null, unknownMethods = false) => new Proxy(extras, {
    get: (target, key, receiver) => {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return target[key];
      const stored = rgss().data[`${name}.${key}`];
      if (stored !== undefined) return stored;
      const Class = className ? unit(className) : null;
      const descriptor = Class?.prototype ? Object.getOwnPropertyDescriptor(Class.prototype, key) : undefined;
      if (descriptor) {
        seedInstanceVariables(name, Class, receiver, target);
        if (typeof descriptor.get === 'function') return descriptor.get.call(receiver);
        if (typeof descriptor.value === 'function') return descriptor.value.bind(receiver);
      }
      const borrowed = Class?.prototype?.[key];
      if (typeof borrowed === 'function') { seedInstanceVariables(name, Class, receiver, target); return borrowed.bind(receiver); }
      return unknownMethods && !key.startsWith('_') ? stub(`${name}.${key}`) : undefined;
    },
    set: (target, key, value) => {
      if (key in target && Object.getOwnPropertyDescriptor(target, key)?.set) target[key] = value;
      else rgss().data[`${name}.${key}`] = value;
      return true;
    }
  });

  // A paren-less zero-arg read compiles to a call when the game `def`s that name and to a
  // property read otherwise (see tools/rgss-library.mjs); expose the same shape.
  const definedMethods = new Set(library?.methods || []);
  // Names the converter always reads as properties (JS-native members: `keys`, `length`, `map`, ...), even when the game defines a
  // method of that name: never wrapped as callable readers.
  const NATIVE_PROPERTY_NAMES = new Set(['length', 'size', 'map', 'filter', 'find', 'findIndex', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'join', 'concat', 'reverse', 'sort', 'forEach', 'keys', 'values', 'entries', 'toString', 'valueOf', 'state']);
  const callableMethods = new Set([...definedMethods].filter(name => !NATIVE_PROPERTY_NAMES.has(name)));
  // One browser frame: resolves on the next animation frame. A loop that never awaits it (an unlifted sync spin)
  // trips the counter, which only a real frame boundary resets.
  let framesSpun = 0;
  const nextFrame = who => {
    if (++framesSpun > 4000) { framesSpun = 0; throw new Error(`MWGP: this script spins on ${who} without yielding a frame (it could not be made async); skipped`); }
    return resumeAfter(new Promise(resolve => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => { framesSpun = 0; resolve(); }) : setTimeout(() => { framesSpun = 0; resolve(); }, 16))));
  };
  // Scripts that wait interleave, and `current`/`queue` are shared: a wait remembers the caller's context (taken when the
  // wait starts, while that script is the one running) and puts it back when the script resumes.
  const resumeAfter = promise => {
    const context = { current, queue };
    return promise.then(value => { current = context.current; queue = context.queue; return value; });
  };
  const reader = (name, read) => definedMethods.has(name) ? read : read();

  const eventById = id => mapEvents.find(event => String(event.id) === String(id));
  const character = id => {
    const numeric = Number(id);
    const isPlayer = numeric === -1 || id === 'player';
    const position = () => isPlayer ? { x: scene.mover?.x ?? 0, y: scene.mover?.y ?? 0 } : (eventById(id) || { x: 0, y: 0 });
    const target = isPlayer ? -1 : numeric;
    const direction = () => ({ up: 8, right: 6, down: 2, left: 4 }[isPlayer ? scene.facing : (eventById(id)?.facing || 'down')] || 2);
    return openObject(`character:${target}`, {
      _target: isPlayer ? 'player' : `event:${id}`,
      get id() { return reader('id', () => target); },
      get x() { return reader('x', () => position().x); },
      get y() { return reader('y', () => position().y); },
      get direction() { return reader('direction', direction); },
      // The ivars the game's Game_Character/Game_Event methods read.
      get _id() { return target; }, get _map_id() { return mapId; }, get map_id() { return reader('map_id', () => mapId); },
      get _x() { return position().x; }, get _y() { return position().y; }, get _direction() { return direction(); },
      // Balloon/animation ids are how VX/Ace scripts trigger those effects.
      set balloon_id(value) { if (value) later('balloon_id=', () => scene.showBalloon({ target, balloon: Number(value), wait: true })); },
      set animation_id(value) { if (value) later('animation_id=', () => scene.playAnimation({ target, animation: Number(value), wait: false })); }
    }, isPlayer ? 'Game_Player' : 'Game_Event');
  };
  const currentEventId = () => current.event?.id;

  const keyed = (get, set) => new Proxy({}, {
    get: (_, key) => typeof key === 'symbol' ? undefined : get(String(key)),
    set: (_, key, value) => { set(String(key), value); return true; }
  });
  // Ruby `$game_self_switches[[map, event, 'A']]` stringifies its array key to "map,event,A".
  const selfKey = key => { const [map, event, ch] = key.split(','); return `self:${map}:${event}:${ch}`; };

  const inventory = kind => keyed(
    id => scene.rpgExtra[kind][id] || 0,
    (id, value) => { if (value > 0) scene.rpgExtra[kind][id] = value; else delete scene.rpgExtra[kind][id]; }
  );
  const party = {
    get gold() { return reader('gold', () => scene.rpgExtra.gold); },
    gain_gold: amount => { scene.rpgExtra.gold = Math.max(0, scene.rpgExtra.gold + Number(amount)); },
    lose_gold: amount => { scene.rpgExtra.gold = Math.max(0, scene.rpgExtra.gold - Number(amount)); },
    gain_item: (id, amount = 1) => { const items = scene.rpgExtra.items; items[id] = Math.max(0, (items[id] || 0) + Number(amount)); if (!items[id]) delete items[id]; },
    lose_item: (id, amount = 1) => party.gain_item(id, -Number(amount)),
    item_number: id => scene.rpgExtra.items[id] || 0,
    get actors() { return reader('actors', () => scene.rpgExtra.party.map(id => ({ id }))); }
  };
  const questId = id => String(id ?? '').replace(/^:/, '');
  const questRecord = id => {
    const key = questId(id);
    if (!key) return null;
    scene.rpgExtra.quests ||= {};
    return scene.rpgExtra.quests[key] ||= { active: false, completed: false, objectives: {} };
  };
  const startQuest = id => { const quest = questRecord(id); if (!quest) return false; quest.active = true; return true; };
  const completeQuest = id => { const quest = questRecord(id); if (!quest) return false; quest.active = true; quest.completed = true; return true; };
  const questComplete = id => scene.rpgExtra.quests?.[questId(id)]?.completed === true;
  const namedItemId = id => String(id ?? '').replace(/^:/, '');
  const namedItemCount = id => scene.rpgExtra.namedItems?.[namedItemId(id)] || 0;
  const giveNamedItem = (id, amount = 1) => {
    const key = namedItemId(id);
    if (!key) return false;
    scene.rpgExtra.namedItems ||= {};
    scene.rpgExtra.namedItems[key] = Math.max(0, namedItemCount(key) + Number(amount || 0));
    if (!scene.rpgExtra.namedItems[key]) delete scene.rpgExtra.namedItems[key];
    return true;
  };
  const addNamedPokemon = (species, level = 1) => {
    const key = namedItemId(species);
    if (!key) return false;
    scene.rpgExtra.namedParty ||= [];
    scene.rpgExtra.namedParty.push({ species: key, level: Number(level) || 1 });
    return true;
  };

  // RGSS `Audio` module (XP/VX/Ace; volume and pitch default to 100, fades are in milliseconds).
  const rgssAudio = {
    bgm_play: (name, volume = 100, pitch = 100, pos = 0) => scene.audio?.playBgm({ name, volume, pitch, pos }),
    bgs_play: (name, volume = 100, pitch = 100, pos = 0) => scene.audio?.playBgs({ name, volume, pitch, pos }),
    me_play: (name, volume = 100, pitch = 100) => scene.audio?.playMe({ name, volume, pitch }),
    se_play: (name, volume = 100, pitch = 100) => scene.audio?.playSe({ name, volume, pitch }),
    bgm_stop: () => scene.audio?.stopBgm(), bgs_stop: () => scene.audio?.stopBgs(), me_stop: () => scene.audio?.stopMe(), se_stop: () => scene.audio?.stopSe(),
    bgm_fade: ms => scene.audio?.fadeOutBgm(Number(ms) / 1000), bgs_fade: ms => scene.audio?.fadeOutBgs(Number(ms) / 1000), me_fade: () => scene.audio?.stopMe(),
    bgm_pos: () => scene.audio?.currentTrack('bgm')?.pos ?? 0, bgs_pos: () => scene.audio?.currentTrack('bgs')?.pos ?? 0
  };

  // The current map as RGSS objects: a `Table` of tile ids (z-major like the manifest) and the tileset's passage,
  // priority and terrain-tag tables, built once on first use.
  let mapModelCache = null;
  const mapModel = () => {
    if (mapModelCache) return mapModelCache;
    const entry = (scene.project?.maps || []).find(candidate => Number(candidate.id) === Number(mapId));
    const data = entry?.data || {};
    const tileset = scene.project?.tilesets?.[Number(data.tilesetId)] || {};
    const table = (values, xsize) => { const out = new rgssClasses.Table(xsize || (values?.length ?? 1), 1, 1); (values || []).forEach((value, index) => { out.data[index] = value; }); return out; };
    const tiles = new rgssClasses.Table(data.width || 1, data.height || 1, 3);
    (data.data || []).slice(0, tiles.data.length).forEach((value, index) => { tiles.data[index] = value; });
    mapModelCache = {
      map: { width: data.width || 0, height: data.height || 0, data: tiles, tileset_id: data.tilesetId, autoplay_bgm: data.autoplayBgm, bgm: data.bgm, autoplay_bgs: data.autoplayBgs, bgs: data.bgs, events: eventsObject },
      tilesetId: data.tilesetId, passages: table(tileset.flags), priorities: table(tileset.priorities), terrainTags: table(tileset.terrainTags)
    };
    return mapModelCache;
  };
  const eventsObject = {};
  // `for (event of $game_map.events)` in transpiled game code walks the events themselves (Ruby's `events.values`).
  Object.defineProperty(eventsObject, Symbol.iterator, { value: function* () { for (const key of Object.keys(this)) yield this[key]; } });
  for (const event of mapEvents) Object.defineProperty(eventsObject, String(event.id), { enumerable: true, get: () => character(event.id) });
  const mapWidth = mapSize.width ?? 0, mapHeight = mapSize.height ?? 0;

  // RGSS objects the coverage report ranked (Input, System, Marshal, load_data/save_data, Color/Tone/Rect/Font,
  // Bitmap and the display classes): src/player/rgss-classes.js. The virtual file store behind
  // save_data/load_data lives for this map's runtime only (values keep their prototypes and may be cyclic).
  const virtualFiles = new Map();
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  // The game's Marshal data (`Data/*.dat`, exported by the converter): decoded once, with objects rebuilt as instances of
  // the game's own transpiled classes (`{ class: 'GameData::Species', ivars }`) and a Hash as a plain object.
  // A read-only file system over the converter's `fileIndex` (the project's own Graphics/Audio/Data/... paths): the game
  // probes its folders (`File.exist?`, `Dir.exist?`, `Dir.glob`, `Dir.entries`) to find assets. Case-insensitive.
  const slash = String.fromCharCode(92);
  const fsPath = path => String(path ?? '').split(slash).join('/').replace(/^[.]\//, '').replace(/[/]+$/, '');
  const fsText = new Map(Object.entries(textFiles || {}).map(([path, text]) => [path.toLowerCase(), text]));
  const fsFiles = new Map((Array.isArray(fileIndex) ? fileIndex : []).map(path => [path.toLowerCase(), path]));
  const fsDirs = new Map([['', ''], ['.', '']]);
  for (const path of fsFiles.values()) { const parts = path.split('/'); for (let length = 1; length < parts.length; length++) { const dir = parts.slice(0, length).join('/'); fsDirs.set(dir.toLowerCase(), dir); } }
  const fsChildren = dir => {
    const prefix = fsPath(dir).toLowerCase();
    const base = prefix === '' || prefix === '.' ? '' : `${prefix}/`;
    const names = new Set();
    for (const [lower, original] of [...fsFiles, ...fsDirs]) {
      if (!lower.startsWith(base) || lower === prefix || lower === '' || lower === '.') continue;
      names.add(original.slice(base.length).split('/')[0]);
    }
    return [...names];
  };
  const globMatch = (pattern, text) => {
    const match = (pi, ti) => {
      while (pi < pattern.length) {
        const c = pattern[pi];
        if (c === '*' && pattern[pi + 1] === '*') { let next = pi + 2; if (pattern[next] === '/') next++; for (let skip = ti; skip <= text.length; skip++) if (match(next, skip)) return true; return false; }
        if (c === '*') { for (let skip = ti; skip <= text.length; skip++) { if (match(pi + 1, skip)) return true; if (text[skip] === '/') break; } return false; }
        if (c === '?') { if (ti >= text.length || text[ti] === '/') return false; pi++; ti++; continue; }
        if (c === '{') { const close = pattern.indexOf('}', pi); if (close < 0) return false; return pattern.slice(pi + 1, close).split(',').some(option => globMatch(option + pattern.slice(close + 1), text.slice(ti))); }
        if (ti >= text.length || text[ti] !== c) return false;
        pi++; ti++;
      }
      return ti === text.length;
    };
    return match(0, 0);
  };
  const fsGlob = pattern => [...(Array.isArray(pattern) ? pattern : [pattern])].flatMap(one => {
    const lowered = fsPath(one).toLowerCase();
    return [...fsFiles, ...[...fsDirs].filter(([lower]) => lower)].filter(([lower]) => globMatch(lowered, lower)).map(([, original]) => original);
  }).sort();
  const fsExists = path => { const lower = fsPath(path).toLowerCase(); return fsFiles.has(lower) || fsDirs.has(lower); };

  // A built-in module the game also reopens (`module FileTest; def self.audio_exist?`): the built-in answers first, and
  // names it lacks come from the game's own module.
  const reopenedBuiltin = (name, base) => new Proxy(base, {
    get: (target, key, receiver) => {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver);
      const own = unit(name);
      return own && typeof own === 'object' || typeof own === 'function' ? own[key] : undefined;
    }
  });
  // The game's own classes: a name the game `def`s anywhere makes every paren-less `x.name` compile to a call, while an
  // `attr_reader :name` on a class is a getter (`x.name` is the value). Instances (constructed or rehydrated) answer
  // such names with a function returning the value, and keep `this` as the instance, since the class's own code
  // reads them as calls too.
  const gameInstance = instance => (definedMethods.size ? new Proxy(instance, {
    set: (target, key, value, receiver) => {
      if (typeof key === 'string' && !(key in target) && typeof target['[]='] === 'function') { target['[]='](key, value); return true; }
      return Reflect.set(target, key, value, receiver);
    },
    get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver);
      // `obj.keys` / `obj.values` on a game hash-like class: Ruby2JS reads them as properties, but the class defines methods.
      if ((key === 'keys' || key === 'values') && typeof value === 'function') return arrayLikeCallable(() => value.call(receiver));
      // Index syntax on a class that defines Ruby's `[]` / `[]=`: `options[name]` calls the method.
      if (value === undefined && typeof key === 'string' && typeof target['[]'] === 'function' && !(key in target)) return target['[]'](key);
      // Never for an underscore-prefixed key: that's a plain ivar field, never a method call, even if some unrelated
      // class in the game happens to define a method of that literal (underscored) name.
      return typeof key === 'string' && !key.startsWith('_') && typeof value !== 'function' && callableMethods.has(key) && Reflect.has(target, key) ? () => value : value;
    }
  }) : instance);
  // `Klass.keys` is a static method here but Ruby2JS reads it as a property (`Klass.keys[0]`, `.keys.first`): the method
  // answers as a callable that also behaves like the array it returns.
  const arrayLikeCallable = produce => new Proxy(produce, {
    get: (target, key) => {
      if (key === 'call' || key === 'apply' || key === 'bind' || typeof key === 'symbol') return Reflect.get(target, key);
      const result = produce();
      const value = result?.[key];
      return typeof value === 'function' ? value.bind(result) : value;
    }
  });
  const gameClass = Class => (typeof Class === 'function' && Class.prototype && definedMethods.size ? new Proxy(Class, {
    construct: (target, args, newTarget) => gameInstance(Reflect.construct(target, args, newTarget)),
    get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver);
      return key === 'keys' && typeof value === 'function' && target.DATA ? arrayLikeCallable(() => value.call(receiver)) : value;
    }
  }) : Class);
  const shippedTables = new Map(Object.entries(rubyData || {}).map(([name, value]) => [name.toLowerCase(), value]));
  const shippedDecoded = new Map();
  const resolveClass = (qualified, lookup) => {
    let target;
    for (const [index, part] of String(qualified).split('::').entries()) {
      target = index === 0 ? (lookup?.(part) ?? unit(part) ?? rgssClasses?.[part]) : target?.[part];
      if (!target) return undefined;
    }
    return typeof target === 'function' ? target : undefined;
  };
  const decodeRuby = (value, lookup) => {
    if (Array.isArray(value)) return value.map(item => decodeRuby(item, lookup));
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value.$map)) return Object.fromEntries(value.$map.map(([key, item]) => [String(key), decodeRuby(item, lookup)]));
    if (typeof value.class === 'string' && value.ivars && typeof value.ivars === 'object') {
      const instance = Object.create(resolveClass(value.class, lookup)?.prototype ?? Object.prototype);
      for (const [name, item] of Object.entries(value.ivars)) instance[String(name).replace(/^@/, '_')] = decodeRuby(item, lookup);
      return gameInstance(instance);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeRuby(item, lookup)]));
  };
  const shippedData = (path, lookup) => {
    const key = String(path).split('/').pop();
    if (shippedDecoded.has(key)) return shippedDecoded.get(key);
    if (!shippedTables.has(key)) return undefined;
    const value = decodeRuby(shippedTables.get(key), lookup);
    shippedDecoded.set(key, value);
    return value;
  };
  // RGSS display objects (Sprites, Planes) are composited onto an overlay canvas; without a DOM (Node tests) there is none.
  const screen = dialect === 'rgss' && typeof document !== 'undefined' ? createRgssScreen({ width: Number(scene.project?.display?.width) || 640, height: Number(scene.project?.display?.height) || 480 }) : null;
  const rgssClasses = createRgssClasses({
    screen,
    callableNames: callableMethods,
    rawFile: path => { const key = fsPath(path).toLowerCase(); return fsFiles.has(key) ? (fsText.get(key) ?? String.fromCharCode(0)) : undefined; },
    warnOnce, files: virtualFiles,
    uptime: () => ((typeof performance !== 'undefined' ? performance.now() : startedAt) - startedAt) / 1000 + (scene.rpgExtra?.rgss?.data?.uptimeBase || 0),
    keys: typeof window !== 'undefined' ? (keyProbe ||= createKeyProbe(window)) : null,
    reopened: name => library?.units?.[name],
    shipped: path => shippedData(path),
    // `Bitmap.new("Graphics/Pictures/x")`: the served URL of that image (the converter copies Graphics/ to assets/graphics/).
    imageUrl: name => {
      const root = scene.project?.assets?.root;
      const base = fsPath(name).toLowerCase();
      if (!root || !base) return null;
      for (const extension of ['', '.png', '.gif', '.jpg', '.jpeg', '.bmp']) {
        const original = fsFiles.get(base + extension);
        if (original) { const [top, ...rest] = original.split('/'); return `${root}/${top.toLowerCase()}/${rest.map(encodeURIComponent).join('/')}`; }
      }
      return null;
    }
  });
  // A paren-less `obj.name` compiled as a call when the game defines a method `name` anywhere (`definedMethods`), even
  // on the shim's own display/value classes (`sprite.bitmap` -> `sprite.bitmap()`): instances of those classes answer
  // such names with a function returning the value. Methods are bound to the raw instance so the class's own
  // `this.width` reads stay plain.
  const callableAttributes = Class => typeof Class !== 'function' || !definedMethods.size ? Class : new Proxy(Class, {
    construct: (target, args, newTarget) => new Proxy(Reflect.construct(target, args, newTarget), {
      get: (object, key) => {
        const value = Reflect.get(object, key, object);
        if (typeof value === 'function') return typeof key === 'string' && key !== 'constructor' ? value.bind(object) : value;
        // Never for an underscore-prefixed key: that's a plain ivar field, never a method call.
        return typeof key === 'string' && !key.startsWith('_') && definedMethods.has(key) ? () => value : value;
      }
    })
  });
  const builtins = {
    // Essentials exposes the player as `$player`; keep the object
    // stateful even when the export has no full Essentials database. A stable
    // default character id gives gender/pronoun helpers a safe startup value.
    $player: openObject("player", {
      get character_ID() { return rgss().data["player.character_ID"] ?? 1; },
      get name() { return rgss().data["player.name"] ?? "Player"; },
      get trainer_type() { return rgss().data["player.trainer_type"] ?? "PLAYER"; }
    }),
    $game_switches: keyed(key => current.state.game.switch(key), (key, value) => current.state.game.setSwitch(key, Boolean(value))),
    // Variables store raw values like MV/XP (a script can keep a string: Ruby's
    // `slice!` returns one). Readers coerce to Number where they do arithmetic.
    $game_variables: keyed(key => current.state.game.variable(key), (key, value) => current.state.game.setVariable(key, value)),
    $game_self_switches: keyed(key => current.state.game.switch(selfKey(key)), (key, value) => current.state.game.setSwitch(selfKey(key), Boolean(value))),
    $game_map: openObject('map', {
      get map_id() { return reader('map_id', () => mapId); },
      get _map_id() { return mapId; },
      get width() { return reader('width', () => mapWidth); },
      get height() { return reader('height', () => mapHeight); },
      // A plain object (not a Proxy) so `events.values`/iteration behave like Ruby's Hash.
      get events() { return eventsObject; },
      // The instance data the game's own Game_Map methods read (`@map.data`, `@passages`, ...), from the manifest.
      get _map() { return mapModel().map; }, get map() { return mapModel().map; },
      get _tileset_id() { return mapModel().tilesetId; }, get tileset_id() { return mapModel().tilesetId; },
      get _passages() { return mapModel().passages; }, get _priorities() { return mapModel().priorities; }, get _terrain_tags() { return mapModel().terrainTags; }
    }, 'Game_Map'),
    $game_player: character(-1),
    $game_party: openObject('party', party, 'Game_Party', true),
    $game_temp: openObject('temp', {
      // XP's classic way to show a message from a script.
      set message_text(text) { later('message_text=', () => scene.presentDialogue({ text: String(text) })); }
    }, 'Game_Temp'),
    $game_system: openObject('system', {}, 'Game_System'),
    $game_screen: openObject('screen', {}, 'Game_Screen'),
    $scene: {
      spriteset: () => ({
        addUserAnimation: () => ({ disposed: () => true })
      })
    },
    Graphics: {
      // The converter lifts code that waits on frames to async (tools/rgss-async.mjs), so a blocking screen awaits the
      // browser's next frame here. Code that could not be lifted and spins on it synchronously gets a loud error
      // instead of a frozen page.
      update: () => nextFrame('Graphics.update'),
      // Frame-pacing and presentation calls: the browser owns the frame loop, so these are the no-ops
      // they mean here; the fades and transitions map onto the player's own screen effects.
      frame_reset() {}, freeze() {}, delta: () => 0, wait: async frames => { for (let index = 0; index < Math.max(1, Number(frames) || 1); index++) await nextFrame('Graphics.wait'); }, fullscreen: false, brightness: 255,
      transition: (duration = 8) => later('Graphics.transition', () => scene.screenFade?.({ direction: 'in', duration: Number(duration) / 20, wait: false })),
      fadeout: frames => later('Graphics.fadeout', () => scene.screenFade?.({ direction: 'out', duration: Number(frames) / 60, wait: true })),
      fadein: frames => later('Graphics.fadein', () => scene.screenFade?.({ direction: 'in', duration: Number(frames) / 60, wait: true })),
      snap_to_bitmap: () => new rgssClasses.Bitmap(0, 0), screenshot() { warnOnce('Graphics.screenshot', 'needs the RGSS display layer'); }, scale: 1, resize_screen() {}, resize_window() {}, center() {},
      get frame_count() { return reader('frame_count', () => 0); },
      get frame_rate() { return reader('frame_rate', () => 60); },
      get width() { return reader('width', () => 640); },
      get height() { return reader('height', () => 480); }
    },
    Audio: rgssAudio,
    // Essentials' message helpers, backed by the player's own dialogue box. The game's `pbMessage` drives inert window
    // shims and can never return a choice; these await the real box, which needs the async lift (a script that reaches
    // them is lifted like any that waits on frames). `cmdIfCancel`: >0 returns cmdIfCancel-1 on cancel, <0 returns it.
    pbMessage: async (message, commands = null, cmdIfCancel = 0, skin = null, defaultCmd = 0) => {
      const text = String(message ?? '');
      const list = Array.isArray(commands) ? commands.map(String) : null;
      const answer = await resumeAfter(scene.presentDialogue({ text, ...(list ? { choices: list.map((label, index) => ({ text: label, value: index })) } : {}) }));
      if (!list) return 0;
      if (answer === undefined || answer === null) return cmdIfCancel > 0 ? cmdIfCancel - 1 : cmdIfCancel < 0 ? cmdIfCancel : Number(defaultCmd) || 0;
      return Number(answer);
    },
    pbConfirmMessage: async message => (await builtins.pbMessage(message, ['Yes', 'No'], 2)) === 0,
    pbConfirmMessageSerious: async message => (await builtins.pbMessage(message, ['Yes', 'No'], 2, null, 1)) === 0,
    // Ruby's modulo takes the divisor's sign (the converter rewrites every `a % b` to `__mod(a, b)`).
    __mod: (left, right) => (typeof left === 'number' && typeof right === 'number' ? ((left % right) + right) % right : left % right),
    // Essentials' `validate({value => [Classes]})` is a debug-time type check that raises on a mismatch; the JS value
    // classes differ from Ruby's (Integer, Symbol, ...), so it would reject valid calls. It has no effect on game logic.
    validate: () => {},
    // Ruby's extend/include: the module's methods fill in what the class does not define itself (the converter rewrites
    // `Object.defineProperties(X, Object.getOwnPropertyDescriptors(M))` to this).
    // `::Name` from inside a namespace: the sandbox's own global lookup (builtins, then the game's units).
    get __global() { return scope; },
    // Ruby `slice!` on a String (emitted as `.splice`): the removed piece is returned and the variable reassigned; an Array is
    // spliced in place.
    __splice: (target, assign, ...args) => {
      if (Array.isArray(target)) return target.splice(...args);
      const [start, length] = args;
      const text = String(target ?? '');
      const from = start < 0 ? Math.max(0, text.length + start) : start;
      const count = length === undefined ? 1 : length;
      const removed = text.slice(from, from + count);
      assign(text.slice(0, from) + text.slice(from + count));
      return removed;
    },
    // Ruby's `$~` (English: `$MATCH`): the last `str =~ /re/` match.
    get $MATCH() { return lastMatch ? { pre_match: lastMatch.text.slice(0, lastMatch.index), post_match: lastMatch.text.slice(lastMatch.index + lastMatch.groups[0].length), to_a: lastMatch.groups, ...lastMatch.groups } : null; },
    __mixin: (target, descriptors) => { for (const key of Reflect.ownKeys(descriptors)) if (!Object.prototype.hasOwnProperty.call(target, key)) Object.defineProperty(target, key, descriptors[key]); return target; },
    __values: value => (value != null && typeof value === 'object' && typeof value[Symbol.iterator] !== 'function' ? Object.values(value) : value),
    __each: value => (value != null && typeof value[Symbol.iterator] !== 'function' && typeof value === 'object' ? Object.entries(value) : value),
    ...Object.fromEntries(Object.entries(rgssClasses).map(([name, Class]) => [name, callableAttributes(Class)])),
    // Class-body macros that Ruby2JS leaves as calls when they sit in a module body; nothing to do
    // in JS (accessors compile to properties, visibility does not exist).
    attr_accessor() {}, attr_reader() {}, attr_writer() {}, module_function() {}, private() {}, public() {}, protected() {},
    require() {}, require_relative() {},
    File: reopenedBuiltin('File', {
      extname: path => { const match = String(path ?? '').match(/(\.[^./\\]+)$/); return match ? match[1] : ''; },
      exist: fsExists, exists: fsExists, file: path => fsFiles.has(fsPath(path).toLowerCase()), directory: path => fsDirs.has(fsPath(path).toLowerCase()), readable: fsExists,
      // Embedded text files only (bitmap-font descriptors, tables); anything else reads as empty.
      read: path => fsText.get(fsPath(path).toLowerCase()) ?? '',
      // Read-only: a file in the index opens (its text, when embedded; otherwise a single NUL byte per read), anything else is ENOENT.
      open: (path, mode, block) => {
        if (!fsFiles.has(fsPath(path).toLowerCase())) throw Object.assign(new Error(`No such file or directory - ${path}`), { name: 'Errno::ENOENT', code: 'ENOENT' });
        const text = fsText.get(fsPath(path).toLowerCase());
        const file = { read: length => (text !== undefined ? (length === undefined ? text : text.slice(0, length)) : String.fromCharCode(0).repeat(length === undefined ? 0 : length)), readlines: () => (text ?? '').split(String.fromCharCode(10)), close() {}, eof: () => true, each_line() {}, path: String(path) };
        return typeof block === 'function' ? block(file) : file;
      },
      readlines: path => (fsText.get(fsPath(path).toLowerCase()) ?? '').split(String.fromCharCode(10)).map(line => line + String.fromCharCode(10)),
      // Path helpers (pure string work; there is no file system here).
      join: (...parts) => parts.flat().map(String).map(part => part.split(String.fromCharCode(92)).join('/')).filter((part, index) => part !== '' || index === 0).join('/').split('//').join('/'),
      basename: (path, suffix) => { const name = String(path ?? '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean).pop() || ''; return suffix === '.*' ? name.replace(/[.][^.]*$/, '') : suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name; },
      dirname: path => { const parts = String(path ?? '').split(String.fromCharCode(92)).join('/').split('/'); parts.pop(); return parts.join('/') || '.'; },
      expand_path: path => String(path ?? '')
    }),
    Dir: reopenedBuiltin('Dir', { glob: fsGlob, exist: path => fsDirs.has(fsPath(path).toLowerCase()), exists: path => fsDirs.has(fsPath(path).toLowerCase()), entries: dir => ['.', '..', ...fsChildren(dir)], children: fsChildren, each_child: (dir, block) => fsChildren(dir).forEach(block), pwd: () => '.' }),
    FileTest: reopenedBuiltin('FileTest', { exist: fsExists, exists: fsExists, file: path => fsFiles.has(fsPath(path).toLowerCase()), directory: path => fsDirs.has(fsPath(path).toLowerCase()), readable: fsExists }),
    // Essentials' RTP resolver is filesystem-backed in RGSS.  The browser
    // converter already serves assets through MWGP URLs, so expose the same
    // callback shape without letting the transpiled `eachPath` block call
    // escape into an unbound `_implicitBlockYield`.
    RTP: {
      // The game's own paths resolve against the project file index (`fileIndex`): the callback gets the path as given, and the
      // game's own existence checks (`FileTest.exist`, `File.open`) answer from the index.
      eachPathFor: (filename, callback) => {
        if (!filename || typeof callback !== 'function') return;
        // Only a path that exists (as given, or with an image/audio extension) is yielded: no file, no callback.
        if (['', '.png', '.gif', '.jpg', '.jpeg', '.bmp', '.ogg', '.wav', '.mid', '.midi', '.mp3'].some(extension => fsExists(String(filename) + extension))) callback(String(filename));
        else warnOnce(`RTP file ${filename}`, 'is not among the project files (a resource lookup will come back empty)');
      },
      eachPath: callback => {
        if (typeof callback === 'function') callback('./');
      },
      // Nothing lives in a runtime package here (`RTP.exists?`): the game ships its own assets.
      exists: () => false,
      getPath: filename => filename,
      getImagePath: filename => filename,
      getAudioPath: filename => filename
    },
    // Reflection used by "define only if missing" idioms at module/class top level: nothing is defined.
    method_defined: () => false, private_method_defined: () => false,
    rand: (max = 0) => max ? Math.floor(Math.random() * Number(max)) : Math.random(),
    print: (...args) => console.log('MWGP RGSS print', ...args),
    p: (...args) => { console.log('MWGP RGSS p', ...args); return args[0]; },
    puts: (...args) => console.log('MWGP RGSS puts', ...args),
    // VX/Ace Interpreter helper; XP scripts index $game_map.events themselves.
    get_character: id => character(Number(id) === 0 ? currentEventId() ?? 0 : id)
  };

  // MV/MZ flavour of the same built-ins. Scripts are JavaScript, so free names that exist in
  // the browser (window, Math, ...) are left alone; everything else that is not modelled here
  // (plugin globals, SceneManager, ...) is a warning stub like above.
  const mvCharacter = id => {
    const base = character(id);
    return openObject(`mvcharacter:${base.id ?? id}`, {
      get x() { return base._x; }, get y() { return base._y; },
      direction: () => base._direction, eventId: () => base._id, event: () => ({ id: base._id }),
      set _balloon(value) {}, refresh() {}
    }, null, true);
  };
  const mvItems = keyed(id => ({ id: Number(id) }), () => {});
  const idOf = item => Number(item?.id ?? item);
  // Methods plugins add to an engine class (`Game_Variables.prototype.SetFire = ...`) run against the shim object.
  const borrowing = (target, className) => new Proxy(target, {
    get: (object, key, receiver) => {
      if (typeof key === 'symbol' || key in object) return Reflect.get(object, key, receiver);
      const borrowed = unit(className)?.prototype?.[key];
      return typeof borrowed === 'function' ? borrowed.bind(receiver) : undefined;
    }
  });
  const mvBuiltins = {
    // `_data` mirrors the engine's private tables, which plugins read and write directly.
    $gameSwitches: borrowing({ value: id => current.state.game.switch(String(id)), setValue: (id, value) => current.state.game.setSwitch(String(id), Boolean(value)), onChange() {}, clear() {},
      _data: keyed(id => current.state.game.switch(id), (id, value) => current.state.game.setSwitch(id, Boolean(value))) }, 'Game_Switches'),
    $gameVariables: borrowing({ value: id => current.state.game.variable(String(id)), setValue: (id, value) => current.state.game.setVariable(String(id), Number(value)), onChange() {}, clear() {},
      _data: keyed(id => current.state.game.variable(id), (id, value) => current.state.game.setVariable(id, Number(value))) }, 'Game_Variables'),
    $gameSelfSwitches: borrowing({ value: key => current.state.game.switch(selfKey(String(key))), setValue: (key, value) => current.state.game.setSwitch(selfKey(String(key)), Boolean(value)), onChange() {}, clear() {},
      _data: keyed(key => current.state.game.switch(selfKey(key)), (key, value) => current.state.game.setSwitch(selfKey(key), Boolean(value))) }, 'Game_SelfSwitches'),
    $gameMap: openObject('map', {
      mapId: () => mapId, width: () => mapSize.width ?? 0, height: () => mapSize.height ?? 0,
      event: id => mvCharacter(Number(id) === 0 ? currentEventId() ?? 0 : id), requestRefresh() {}, refresh() {}
    }, 'Game_Map', true),
    $gamePlayer: mvCharacter(-1),
    $gameParty: openObject('party', {
      gold: () => scene.rpgExtra.gold, gainGold: party.gain_gold, loseGold: party.lose_gold,
      gainItem: (item, amount = 1) => party.gain_item(idOf(item), amount), loseItem: (item, amount = 1) => party.lose_item(idOf(item), amount),
      numItems: item => party.item_number(idOf(item)), hasItem: item => party.item_number(idOf(item)) > 0,
      members: () => scene.rpgExtra.party.map(id => ({ actorId: () => id }))
    }, 'Game_Party', true),
    $gameActors: openObject('actors', { actor: id => openObject(`actor.${id}`, { actorId: () => Number(id) }, 'Game_Actor', true) }),
    $dataItems: mvItems, $dataWeapons: mvItems, $dataArmors: mvItems,
    $gameSystem: openObject('system', {}, 'Game_System'), $gameTemp: openObject('temp', {}, 'Game_Temp'), $gameScreen: openObject('screen', {}, 'Game_Screen')
  };
  // Engine-framework helpers (Pokémon Essentials-style `pb*` names) used only
  // when the game's own library does not define the name: consulted after the
  // library and before the warning stub, so a game's real implementation wins.
  const fallbacks = {
    // Pokémon Essentials' quest helpers are small state operations in the
    // event corpus; keep them deterministic even when the full UI plugin is
    // unavailable. Unknown quest ids remain ordinary data, not false stubs.
    pbStartQuest: startQuest,
    pbCompleteQuest: completeQuest,
    pbQuestComplete: questComplete,
    pbItemBall: id => giveNamedItem(id, 1),
    pbReceiveItem: (id, amount = 1) => giveNamedItem(id, amount),
    pbCheckItem: id => namedItemCount(id) > 0,
    pbAddPokemon: addNamedPokemon
  };
  const dialectBuiltins = () => dialect === 'mv' ? mvBuiltins : builtins;


  // ---- MV/MZ: the project's own plugin code, run against engine stubs ------------------
  // The converter ships the plugins that define names event scripts reach (manifest
  // `pluginLibrary`, tools/mv-plugins.mjs). They were written against the MV engine
  // (rpg_*.js), which this player does not embed, so they run here against
  // auto-created engine classes: every engine name a plugin touches is an empty class
  // whose prototype the plugin can extend, and absent statics are inert during load
  // and loud stubs afterwards. Plugin-defined top-level names become script globals and
  // plugin-added methods on engine classes are borrowed by the matching shim objects
  // (`openObject(..., 'Game_Party')`). Engine behaviour itself is not emulated.
  const pluginGlobals = Object.create(null);
  const engineClasses = new Map();
  const engineNames = new Set(pluginLibrary?.engine || []);
  // Function/class names the file being evaluated declares itself: those must resolve to
  // its own declarations, never to a same-named engine class stub.
  let ownDeclarations = new Set();
  let pluginsLoading = false, pluginsLoaded = false, engineLoading = false;
  const lenient = path => new Proxy(function () {}, {
    get: (_, key) => key === Symbol.toPrimitive ? () => 0 : typeof key === 'symbol' ? undefined : lenient(`${path}.${key}`),
    apply: () => undefined,
    construct: () => ({})
  });
  const engineClass = name => {
    if (!engineClasses.has(name)) {
      const target = function () {};
      Object.defineProperty(target, 'name', { value: name });
      // Classes the sandbox does not load (windows, scenes, sprites) answer every method
      // name with an inert function: core-version probes (`if (!Window_Base.prototype.x)`)
      // pass and `_alias = X.prototype.y; ... _alias.call(this)` stays callable.
      const noop = function () {};
      target.prototype = new Proxy({}, {
        get: (base, key, receiver) => key in base || typeof key === 'symbol' || key.startsWith('_') || key === 'then' ? Reflect.get(base, key, receiver) : noop
      });
      engineClasses.set(name, new Proxy(target, {
        get: (base, key, receiver) => {
          if (typeof key === 'symbol' || key in base) return Reflect.get(base, key, receiver);
          return pluginsLoading ? lenient(`${name}.${key}`) : undefined;
        }
      }));
    }
    return engineClasses.get(name);
  };
  const pluginScope = () => new Proxy({}, {
    // Only names that exist somewhere are intercepted: earlier plugins' globals, the shim's
    // built-ins and the engine's own class names. Anything else stays a plain free
    // identifier, so `var Ns = Ns || {}` namespace idioms still create a fresh object.
    has: (_, key) => typeof key === 'string' && key !== '__export' && !JS_BUILTINS.has(key) && !ownDeclarations.has(key)
      && (key in pluginGlobals || key in mvBuiltins || (!(key in globalThis) && (engineLoading || key in mvBuiltins || engineNames.has(key) || (pluginsLoading && ENGINE_CLASS_NAME.test(key))))),
    get: (_, key) => {
      if (typeof key === 'symbol') return undefined;
      // The shim's built-ins outrank the engine's own (null) `var $gameSwitches` style globals.
      if (key in mvBuiltins) return mvBuiltins[key];
      if (key in pluginGlobals) return pluginGlobals[key];
      // Engine files lean on helper libraries that live outside rpg_*.js (loggers, pixi, ...).
      return engineLoading && !engineNames.has(key) && !ENGINE_CLASS_NAME.test(key) ? lenient(key) : engineClass(key);
    },
    set: (_, key, value) => { pluginGlobals[key] = value; return true; }
  });
  // The game's own engine logic (rpg_core/managers/objects: Game_* objects, DataManager,
  // JsonEx, ...) is evaluated first, in the same sandbox, so plugins extend real classes and
  // engine methods such as Game_Actor#learnSkill exist. Scenes, sprites and windows are not
  // loaded. The player's own state stays authoritative: the real Game_Party is bridged onto
  // `rpgExtra` (gold, items, weapons, armors, members) and switches/variables/map/player
  // keep going through GameState via the shim built-ins.
  // First engine/plugin frame of an error, for diagnostics: `Class.method:line`.
  const describeThrow = error => String(error?.stack || '').split('\n').slice(1, 3).map(line => line.trim().replace(/\(eval at .*?\), /, '')).join(' <- ');
  let currentScriptSrc = '';
  const evalInSandbox = (name, source, scope, src = '') => {
    currentScriptSrc = src;
    const exports = [...new Set([...source.matchAll(/^(?:var|let|const|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]))]
      .map(id => `try { __export(${JSON.stringify(id)}, ${id}); } catch (e) {}`).join('\n');
    // Top-level const/let become var so they hoist out of the try block and are still
    // exported (as assigned so far) when a file throws part-way.
    const body = source.replace(/^(?:const|let)(\s)/gm, 'var$1');
    ownDeclarations = new Set([...source.matchAll(/^(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]));
    try {
      new Function('scope', '__export', `with (scope) {\ntry {\n${body}\n} finally {\n${exports}\n}\n}`).call(scope, scope, (id, value) => { pluginGlobals[id] = value; });
      return true;
    } catch (error) {
      console.warn(`MWGP ${name} did not finish loading: ${String(error?.message || error).slice(0, 160)} ${String(error?.stack || '').split('\n')[1]?.match(/<anonymous>:(\d+)/)?.[0] || ''}`);
      return false;
    } finally { ownDeclarations = new Set(); }
  };
  const loadEngine = scope => {
    if (!('PIXI' in globalThis)) pluginGlobals.PIXI = lenient('PIXI');
    engineLoading = true;
    try { for (const [name, source] of Object.entries(pluginLibrary.engineSources)) evalInSandbox(`engine ${name}`, source, scope, `js/${name}.js`); } finally { engineLoading = false; }
    // The engine assigns its helpers onto native prototypes as enumerable properties;
    // keep them out of for..in for everything else on the page.
    for (const target of [Array.prototype, String.prototype, Number.prototype, Object.prototype, Math]) {
      for (const key of Object.keys(target)) if (typeof target[key] === 'function') Object.defineProperty(target, key, { enumerable: false });
    }
    // No media I/O from inside the script sandbox: the player owns images and audio. Plugins
    // that preload or play through the engine's managers get inert objects instead of requests.
    const G0 = pluginGlobals;
    if (G0.Bitmap?.prototype) G0.Bitmap.prototype._requestImage = function () { this._loadingState = 'loaded'; };
    // Display/input/media singletons keep their data (sizes, flags) but every method is inert.
    for (const singleton of ['Graphics', 'Input', 'TouchInput', 'WebAudio', 'Html5Audio', 'Decrypter', 'ImageManager']) {
      const target = G0[singleton];
      if (target && typeof target === 'object' || typeof target === 'function') {
        G0[singleton] = new Proxy(target, { get: (base, key, receiver) => { const value = Reflect.get(base, key, receiver); return typeof value === 'function' && typeof key === 'string' && !/^[A-Z]/.test(key) ? () => undefined : value; } });
      }
    }
    // The engine's AudioManager (used directly by plugins) drives the player's real audio.
    if (G0.AudioManager) {
      const manager = () => scene.audio;
      Object.assign(G0.AudioManager, {
        audioFileExt: () => '.ogg', createBuffer: () => lenient('AudioBuffer'),
        playBgm: (bgm, pos) => manager()?.playBgm({ ...bgm, pos }), playBgs: (bgs, pos) => manager()?.playBgs({ ...bgs, pos }),
        playMe: me => manager()?.playMe(me), playSe: se => manager()?.playSe(se), playStaticSe: se => manager()?.playSe(se),
        stopBgm: () => manager()?.stopBgm(), stopBgs: () => manager()?.stopBgs(), stopMe: () => manager()?.stopMe(), stopSe: () => manager()?.stopSe(),
        stopAll() { manager()?.stopAll(); },
        fadeOutBgm: seconds => manager()?.fadeOutBgm(seconds), fadeOutBgs: seconds => manager()?.fadeOutBgs(seconds), fadeOutMe: () => manager()?.stopMe(),
        saveBgm: () => manager()?.saveBgm() ?? { name: '', volume: 90, pitch: 100, pan: 0, pos: 0 }, saveBgs: () => manager()?.saveBgs() ?? { name: '', volume: 90, pitch: 100, pan: 0, pos: 0 },
        replayBgm: bgm => manager()?.playBgm(bgm), replayBgs: bgs => manager()?.playBgs(bgs)
      });
    }
    const db = scene.project?.database || {};
    const tables = { Actors: 'actors', Classes: 'classes', Skills: 'skills', Items: 'items', Weapons: 'weapons', Armors: 'armors', Enemies: 'enemies', Troops: 'troops', States: 'states', Animations: 'animations', Tilesets: 'tilesets', CommonEvents: 'commonevents', System: 'system' };
    for (const [name, key] of Object.entries(tables)) if (db[key]) { pluginGlobals[`$data${name}`] = db[key]; if (name !== 'System' && name !== 'CommonEvents') mvBuiltins[`$data${name}`] = db[key]; }
  };
  // Second phase, after the plugins have wrapped the engine: database post-processing hook and
  // the game objects themselves.
  // Engine objects are rebuilt on every page load (map transfers reload the page), so their
  // own state rides in `rpgExtra.mvEngine`, serialized with the engine's JsonEx. Gold, items
  // and members already live in rpgExtra through the party bridge and are left out.
  const BRIDGED_PARTY_KEYS = new Set(['_gold', '_items', '_weapons', '_armors', '_actors']);
  let engineReady = false;
  // ---- Save-data registrations (the game's `SaveData.register(:x) { save_value..; load_value..; new_game_value.. }`) ----
  // The converter turned each into an object of methods (`library.boot`, units `BootValue_<id>`). At first use every
  // registered value is created (`new_game_value`) or rebuilt from the saved state, then handed to its `load_value` (which
  // assigns the game's global: `$player`, `$bag`, ...). Every map change reloads the page, so after each script the values
  // are written back (`save_value`) as plain data: class name + fields, with shared/cyclic references kept by id.
  const bootIds = library?.boot || [];
  let bootReady = !(library?.boot?.length || library?.bootStatements?.length) || dialect !== 'rgss';
  const encodeState = (value, seen = new Map()) => {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    if (seen.has(value)) return { $ref: seen.get(value) };
    const id = seen.size;
    seen.set(value, id);
    if (Array.isArray(value)) return { $id: id, $a: value.map(item => encodeState(item, seen)) };
    if (value instanceof Date) return { $id: id, $date: value.getTime() };
    if (value instanceof Set) return { $id: id, $set: [...value].map(item => encodeState(item, seen)) };
    if (value instanceof Map) return { $id: id, $map: [...value].map(([key, item]) => [encodeState(key, seen), encodeState(item, seen)]) };
    const fields = {};
    for (const key of Object.keys(value)) fields[key] = encodeState(value[key], seen);
    const constructorName = Object.getPrototypeOf(value)?.constructor?.name;
    return constructorName && constructorName !== 'Object' ? { $id: id, $c: constructorName, $p: fields } : { $id: id, $o: fields };
  };
  const decodeState = (data, refs = new Map()) => {
    if (data === null || typeof data !== 'object') return data;
    if ('$ref' in data) return refs.get(data.$ref);
    if (data.$a) { const out = []; refs.set(data.$id, out); for (const item of data.$a) out.push(decodeState(item, refs)); return out; }
    if ('$date' in data) { const out = new Date(data.$date); refs.set(data.$id, out); return out; }
    if (data.$set) { const out = new Set(); refs.set(data.$id, out); for (const item of data.$set) out.add(decodeState(item, refs)); return out; }
    if (data.$map) { const out = new Map(); refs.set(data.$id, out); for (const [key, item] of data.$map) out.set(decodeState(key, refs), decodeState(item, refs)); return out; }
    const Class = data.$c ? resolveClass(data.$c) : null;
    const raw = data.$c ? Object.create(Class?.prototype ?? Object.prototype) : {};
    const out = data.$c ? gameInstance(raw) : raw;
    refs.set(data.$id, out);
    for (const [key, item] of Object.entries(data.$p ?? data.$o ?? {})) raw[key] = decodeState(item, refs);
    return out;
  };
  const bootStatementNames = library?.bootStatements || [];
  const ensureBoot = () => {
    if (bootReady) return;
    bootReady = true;
    const saved = (rgss().boot ||= {});
    for (const name of bootIds) {
      const id = name.replace(/^BootValue_/, '');
      try {
        const record = unit(name);
        if (!record || typeof record.load_value !== 'function') continue;
        const source = String(record.load_value);
        const target = /[$]([A-Za-z_0-9]+)\s*=/.exec(source)?.[1];
        // Values the runtime already stands in for with its own objects (switches, variables, map, ...) keep those.
        if (target && `$${target}` !== '$player' && `$${target}` in builtins) continue;
        if (saved[id] !== undefined) record.load_value(decodeState(saved[id]));
        else if (typeof record.new_game_value === 'function') record.load_value(record.new_game_value());
      } catch (error) { console.warn(`MWGP save-data value "${id}" could not be set up: ${String(error?.message || error).slice(0, 160)}`); }
    }
    runBootStatements();
  };
  // Registrations on handler registries (`MenuHandlers.add`, `GameData::X.register`, ...): each statement is a unit whose code
  // runs when loaded. They run in script order, once, quietly: a statement that cannot run is counted, not logged one by one.
  const runBootStatements = () => {
    if (!bootStatementNames.length || dialect !== 'rgss') return;
    let failed = 0;
    for (const name of bootStatementNames) {
      try { compile(fixExportedGetters(units[name])).call(scope, scope); }
      catch (error) { failed++; if (failed <= 3) warnOnce(`registration ${name}`, String(error?.message || error).slice(0, 100)); }
    }
    if (failed) console.warn(`MWGP ${failed} of ${bootStatementNames.length} handler registrations could not run`);
  };
  const snapshotBoot = () => {
    if (!bootIds.length || dialect !== 'rgss') return;
    const saved = (rgss().boot ||= {});
    for (const name of bootIds) {
      const id = name.replace(/^BootValue_/, '');
      try {
        const record = loaded.get(name);
        if (!record || typeof record.save_value !== 'function' || saved[id] === undefined && !bootTouched.has(name)) continue;
        saved[id] = encodeState(record.save_value());
      } catch (error) { warnOnce(`save-data ${id}`, String(error?.message || error).slice(0, 120)); }
    }
  };
  const bootTouched = new Set(bootIds);
  const snapshotEngine = () => {
    const G = pluginGlobals;
    if (!engineReady || !G.JsonEx?.stringify) return;
    try {
      const partyData = {};
      for (const key of Object.keys(G.$gameParty)) if (!BRIDGED_PARTY_KEYS.has(key)) partyData[key] = G.$gameParty[key];
      scene.rpgExtra.mvEngine = { system: G.JsonEx.stringify(G.$gameSystem), actors: G.JsonEx.stringify(G.$gameActors), party: G.JsonEx.stringify(partyData) };
      // Screen tint/pictures and the timer are objects plugins commonly mutate; carried when the engine has them.
      for (const [key, global] of [['screen', '$gameScreen'], ['timer', '$gameTimer']]) if (G[global]) scene.rpgExtra.mvEngine[key] = G.JsonEx.stringify(G[global]);
    } catch (error) { warnOnce('engine state snapshot', String(error?.message || error)); }
  };
  const restoreEngine = publish => {
    const G = pluginGlobals, saved = scene.rpgExtra.mvEngine;
    if (!saved || !G.JsonEx?.parse) return;
    try {
      if (saved.system) publish('$gameSystem', G.JsonEx.parse(saved.system));
      if (saved.party) { const data = G.JsonEx.parse(saved.party); for (const key of Object.keys(data)) if (!BRIDGED_PARTY_KEYS.has(key)) G.$gameParty[key] = data[key]; }
      if (saved.actors) publish('$gameActors', G.JsonEx.parse(saved.actors));
      if (saved.screen && G.$gameScreen) publish('$gameScreen', G.JsonEx.parse(saved.screen));
      if (saved.timer && G.$gameTimer) publish('$gameTimer', G.JsonEx.parse(saved.timer));
    } catch (error) { warnOnce('engine state restore', String(error?.message || error)); }
  };
  const bootEngineObjects = () => {
    const G = pluginGlobals;
    if (typeof G.Game_Party !== 'function') return;
    if (!G.$dataSystem) { console.warn('MWGP engine objects unavailable: plugins run against stubs'); return; }
    try {
      // Each object is published the moment it exists: plugin constructors reach for the
      // globals created before them (`$gameSystem` inside `Game_Party`, ...).
      const publish = (global, value) => { G[global] = value; mvBuiltins[global] = value; return value; };
      for (const [global, Class] of [['$gameTemp', 'Game_Temp'], ['$gameSystem', 'Game_System'], ['$gameScreen', 'Game_Screen'], ['$gameTimer', 'Game_Timer'], ['$gameMessage', 'Game_Message']]) {
        if (typeof G[Class] === 'function') publish(global, new G[Class]());
      }
      const party = new G.Game_Party();
      const bridge = (key, get, set) => Object.defineProperty(party, key, { configurable: true, enumerable: true, get, set: set || (() => {}) });
      bridge('_gold', () => scene.rpgExtra.gold, value => { scene.rpgExtra.gold = value; });
      bridge('_items', () => scene.rpgExtra.items);
      bridge('_weapons', () => scene.rpgExtra.weapons ||= {});
      bridge('_armors', () => scene.rpgExtra.armors ||= {});
      bridge('_actors', () => scene.rpgExtra.party, value => { scene.rpgExtra.party = value; });
      publish('$gameParty', party);
      if (typeof G.Game_Actors === 'function') publish('$gameActors', new G.Game_Actors());
      if (typeof G.Game_Troop === 'function') publish('$gameTroop', new G.Game_Troop());
      restoreEngine(publish);
    } catch (error) {
      console.warn(`MWGP engine object setup failed: ${String(error?.message || error).slice(0, 200)} ${describeThrow(error)}`);
    }
    // DataManager.isDatabaseLoaded() is the hook plugins use to post-process the database
    // (notetags, derived fields). The engine reads the tables off `window`, so expose them
    // there for the call, empty where the manifest has no table.
    try {
      for (const file of G.DataManager?._databaseFiles || []) {
        globalThis[file.name] = G[file.name] || globalThis[file.name] || [];
        G[file.name] ||= globalThis[file.name];
      }
      G.DataManager?.isDatabaseLoaded?.();
    } catch (error) {
      console.warn(`MWGP database post-processing failed: ${String(error?.message || error).slice(0, 200)} ${describeThrow(error)}`);
    }
    engineReady = !!pluginGlobals.$gameParty;
  };
  const ensurePlugins = () => {
    if (pluginsLoaded || dialect !== 'mv' || !pluginLibrary?.order?.length) { pluginsLoaded = true; return; }
    pluginsLoaded = true;
    pluginsLoading = true;
    pluginGlobals.$plugins = pluginLibrary.order.map(name => ({ name, status: true, description: pluginLibrary.descriptions?.[name] || '', parameters: { ...(pluginLibrary.parameters?.[name] || {}) } }));
    // nw.js host shim: MV games are packaged as nw.js apps, so plugins call Node's `require`,
    // `process` and friends. The browser has no disk: reads of files throw ENOENT like a
    // missing file would (plugins probe optional files that way), writes are dropped.
    const enoent = path => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    const nodeModules = {
      fs: {
        readFileSync: path => { throw enoent(path); }, existsSync: () => false, readdirSync: () => [],
        statSync: path => { throw enoent(path); }, writeFileSync() {}, mkdirSync() {}, unlinkSync() {},
        readFile: (path, ...args) => { const callback = args.pop(); if (typeof callback === 'function') callback(enoent(path)); }
      },
      path: {
        sep: '/', join: (...parts) => parts.join('/').replace(/\/+/g, '/'), resolve: (...parts) => parts.join('/').replace(/\/+/g, '/'),
        dirname: path => String(path).replace(/\/[^/]*$/, '') || '/', basename: path => String(path).split('/').pop(),
        extname: path => (String(path).match(/(\.[^./]+)$/) || [''])[0]
      }
    };
    pluginGlobals.require = name => nodeModules[String(name).replace(/^node:/, '')] || lenient(`require(${name})`);
    // Plugins locate themselves through their <script> tag (file-name checks, base paths).
    const scriptTag = () => ({ src: currentScriptSrc, type: 'text/javascript', getAttribute: attribute => attribute === 'src' ? currentScriptSrc : null });
    if (typeof document !== 'undefined') {
      pluginGlobals.document = new Proxy(document, {
        get: (target, key) => {
          if (key === 'currentScript') return scriptTag();
          if (key === 'getElementsByTagName') return tag => String(tag).toLowerCase() === 'script' ? [scriptTag()] : target.getElementsByTagName(tag);
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set: (target, key, value) => { target[key] = value; return true; }
      });
    }
    pluginGlobals.process = { mainModule: { filename: '/index.html' }, platform: 'browser', env: {}, versions: {}, argv: [], cwd: () => '/', nextTick: callback => Promise.resolve().then(callback), on() {} };
    // Host-provided helper the engine core assumes (nw.js logger); inert here.
    const makeLogger = tag => ({
      trace() {}, debug() {}, info() {},
      warn: (...args) => warnOnce(`log:${tag}:${String(args[1] ?? args[0]?.message ?? args[0]).slice(0, 80)}`, args[0]?.err?.message || ''),
      error: (...args) => warnOnce(`log:${tag}:${String(args[1] ?? args[0]?.message ?? args[0]).slice(0, 80)}`, args[0]?.err?.message || ''),
      fatal() {}, child: () => makeLogger(tag)
    });
    pluginGlobals.Logger = { createDefaultLogger: makeLogger, createLogger: makeLogger };
    const scope = pluginScope();
    let failed = 0;
    // Plugins compile notetag/eval strings with `new Function(...)`; those run in the real global
    // scope, which cannot see the sandbox's globals. Route `Function` through the sandbox scope.
    const ScopedFunction = function (...args) {
      const body = String(args.pop() ?? '');
      return new Function('__scope', `with (__scope) { return function anonymous(${args.join(',')}\n) {\n${body}\n}; }`)(scope);
    };
    ScopedFunction.prototype = Function.prototype;
    pluginGlobals.Function = ScopedFunction;
    // `window[name]` is how the engine (JsonEx, plugins) looks classes and shared state up:
    // sandbox globals first, then the real window. Writes stay inside the sandbox.
    if (typeof window !== 'undefined') {
      pluginGlobals.window = new Proxy(window, {
        get: (target, key) => {
          if (typeof key === 'string' && key in pluginGlobals) return pluginGlobals[key];
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' && !/^[A-Z]/.test(String(key)) ? value.bind(target) : value;
        },
        has: (target, key) => (typeof key === 'string' && key in pluginGlobals) || key in target,
        set: (target, key, value) => { pluginGlobals[key] = value; return true; }
      });
    }
    if (pluginLibrary.engineSources) loadEngine(scope);
    // The engine's own PluginManager is kept (plugins call its statics); its parameter table is
    // seeded from the manifest instead of `setup()`, which would load script tags.
    const engineManager = pluginGlobals.PluginManager;
    if (engineManager && typeof engineManager.setParameters === 'function') {
      for (const name of pluginLibrary.order) engineManager.setParameters(name, { ...(pluginLibrary.parameters?.[name] || {}) });
      engineManager.registerCommand ||= () => {};
    } else {
      pluginGlobals.PluginManager = {
        parameters: name => ({ ...(pluginLibrary.parameters?.[name] || {}) }),
        registerCommand() {}, callCommand() {}
      };
    }
    for (const name of pluginLibrary.order) {
      const source = pluginLibrary.sources?.[name];
      if (!source) continue;
      if (!evalInSandbox(`plugin "${name}"`, source, scope, `js/plugins/${name}.js`)) failed++;
    }
    if (pluginLibrary.engineSources) bootEngineObjects();
    pluginsLoading = false;
    console.info(`MWGP plugin library: ${pluginLibrary.order.length - failed}/${pluginLibrary.order.length} plugins evaluated`);
  };

  // ---- the game's own library, loaded lazily -------------------------------------
  const units = library?.units || {};
  const loaded = new Map();
  const loading = new Set();
  // Ruby2JS exports a module's private helpers as `get name() { return name.call(this) }`; for a helper that takes
  // parameters the getter would run it with none at load time, so those are exported as the function itself.
  const hasParameters = (js, fn) => { const at = js.indexOf(`function ${fn}(`); return at >= 0 && js.slice(at + fn.length + 10).trimStart()[0] !== ")"; };
  const fixExportedGetters = js => js.replace(/^(\s*)get (\w+)\(\) \{\s*return \2\.call\(this\)\s*\}/gm, (whole, indent, fn) =>
    hasParameters(js, fn) ? `${indent}${fn}` : whole);
  // Ruby's `hash.each { |pair| ... }` is emitted as `for (x of hash)`, and a plain object is not iterable: loops over a
  // simple expression go through `__each`, which yields [key, value] pairs for a plain object and passes anything
  // iterable (arrays, Maps, Sets, ranges) through untouched.
  const FOR_OF = /for [(](let|const|var) ([^;]*?) of ([A-Za-z_$][\w$.]*(?:[[][^\]]*[\]])*)[)]/g;
  const iterableLoops = js => dialect !== 'rgss' ? js : js.replace(FOR_OF, (whole, kind, target, subject) => `for (${kind} ${target} of __each(${subject}))`);
  const compile = (js, tail = '') => new Function('scope', `with (scope) {\n${iterableLoops(js)}\n${tail}\n}`);
  const unit = name => {
    if (dialect === 'mv') { ensurePlugins(); return typeof pluginGlobals[name] === 'function' ? pluginGlobals[name] : engineClasses.get(name); }
    if (loaded.has(name)) return loaded.get(name);
    if (!Object.hasOwn(units, name) || loading.has(name) || !IDENTIFIER.test(name)) return undefined;
    loading.add(name);
    try {
      // `this` is the scope so top-level reflection calls (`method_defined`) resolve to built-ins.
      const exported = compile(fixExportedGetters(units[name]), `return typeof ${name} !== 'undefined' ? ${name} : undefined;`).call(scope, scope);
      const adapted = adaptRubyHash(exported);
      // Data classes whose registry the game loads from a shipped file (`static DATA_FILENAME = "types.dat"`): fill `DATA`
      // from the exported Marshal data, rebuilt as instances of these very classes.
      if (exported && typeof exported === 'object' && shippedTables.size) {
        const lookup = part => (part === name ? exported : undefined);
        for (const cls of Object.values(exported)) {
          if (typeof cls !== 'function' || typeof cls.DATA_FILENAME !== 'string') continue;
          const table = shippedData(`data/${cls.DATA_FILENAME}`, lookup);
          if (table && typeof table === 'object') cls.DATA = table;
        }
      }
      // Registry lookups raise a bare string (`raise "Unknown ID #{x}"`): rethrow as an Error so the failure carries a stack.
      if (exported && typeof exported === 'object') {
        for (const cls of Object.values(exported)) {
          if (typeof cls !== 'function' || typeof cls.get !== 'function' || !cls.DATA) continue;
          const original = cls.get;
          cls.get = function (...args) { try { return original.apply(this, args); } catch (error) { throw typeof error === 'string' ? new Error(`${cls.name}.get: ${error}`) : error; } };
        }
      }
      // The game's registry entries (`GameData::TerrainTag.register(...)`) are top-level calls outside any unit, so a
      // registry that comes up empty answers `try_get` with a permissive record (every flag false) instead of nil.
      if (exported && typeof exported === 'object') {
        for (const cls of Object.values(exported)) {
          if (typeof cls !== 'function' || typeof cls.try_get !== 'function' || !cls.DATA || Object.keys(cls.DATA).length) continue;
          const original = cls.try_get;
          const blank = new Proxy({}, { get: (_, key) => (key === "then" || typeof key === "symbol" ? undefined : key === "id" ? "None" : false) });
          cls.try_get = function (other) { return original.call(this, other) ?? blank; };
        }
      }
      // A reachable class/module can be only partially transpiled (for
      // example, a Ruby reopening whose method body was outside the selected
      // library slice). Keep the event alive: calls to known game-defined but
      // absent methods become the same loud callable stub used for free names,
      // rather than a fatal `undefined is not a function`.
      // RGSS engine built-ins the game's scripts extend but never create: `RPG::Cache` keeps its bitmaps in `@cache`.
      // ... and the small RPG data classes the engine defines (audio file descriptors carry name, volume and pitch).
      if (name === 'RPG' && adapted && typeof adapted === 'object' && !adapted.AudioFile) {
        adapted.AudioFile = class AudioFile { constructor(name = '', volume = 100, pitch = 100) { this._name = name; this._volume = volume; this._pitch = pitch; } get name() { return this._name; } set name(value) { this._name = value; } get volume() { return this._volume; } set volume(value) { this._volume = value; } get pitch() { return this._pitch; } set pitch(value) { this._pitch = value; } };
      }
      if (name === 'RPG' && adapted?.Cache && typeof adapted.Cache === 'object' && adapted.Cache._cache === undefined) adapted.Cache._cache = {};
      // The game's classes construct instances that honour the call-vs-property rule (see `gameInstance`).
      let exposed = adapted;
      if (dialect === 'rgss' && typeof adapted === 'function') exposed = gameClass(adapted);
      else if (dialect === 'rgss' && adapted && typeof adapted === 'object') {
        for (const member of Object.keys(adapted)) {
          try { const value = adapted[member]; if (typeof value === 'function' && /^[A-Z]/.test(member) && value.prototype) adapted[member] = gameClass(value); } catch { /* frozen or a getter that needs the engine: left as is */ }
        }
      }
      const safeExport = exposed && (typeof exposed === 'object' || typeof exposed === 'function')
        ? new Proxy(exposed, { get: (target, key, receiver) => {
          if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
          return typeof key === 'string' && definedMethods.has(key) ? stub(`${name}.${key}`) : undefined;
        } })
        : exposed;
      loaded.set(name, safeExport);
    } catch (error) {
      console.error(`MWGP RGSS library unit "${name}" failed to load`, error);
      loaded.set(name, undefined);
    } finally { loading.delete(name); }
    return loaded.get(name);
  };

  const scope = new Proxy({}, {
    has: (_, key) => typeof key === 'string' && !JS_BUILTINS.has(key) && (dialect !== 'mv' || key in mvBuiltins || !(key in globalThis)),
    get: (_, key) => {
      if (typeof key === 'symbol') return undefined;
      // MV: the plugin/engine layer replaces some built-ins, so it must be up before any lookup.
      if (dialect === 'mv') ensurePlugins();
      if (key in dialectBuiltins()) return dialectBuiltins()[key];
      if (dialect === 'mv') {
        if (key in pluginGlobals) return pluginGlobals[key];
        if (engineClasses.has(key) || engineNames.has(key)) return engineClass(key);
      }
      const found = unit(key);
      if (found !== undefined) return found;
      if (dialect !== 'mv' && Object.hasOwn(fallbacks, key)) return fallbacks[key];
      return stub(key);
    },
    set: (_, key, value) => { dialectBuiltins()[key] = value; return true; }
  });

  // The Interpreter a snippet runs inside: the game's class when it has one (so its
  // helper methods exist as `this.<name>`), else a bare object.
  let interpreter = null;
  const interpreterFor = event => {
    if (dialect === 'mv') return { _mapId: mapId, _eventId: event?.id ?? 0, eventId: () => event?.id ?? 0, character: id => mvBuiltins.$gameMap.event(id) };
    const Class = library?.interpreter ? unit(library.interpreter) : null;
    interpreter = Class?.prototype ? Object.create(Class.prototype) : {};
    Object.assign(interpreter, { _map_id: mapId, _event_id: event?.id ?? 0, _list: [], _index: 0, _params: [] });
    return interpreter;
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const compiledAsync = new Map();
  // Snippets the converter lifted to async (they await frame waits) compile as async function bodies.
  const asyncBody = js => {
    if (!compiledAsync.has(js)) compiledAsync.set(js, new AsyncFunction('scope', `with (scope) {
${iterableLoops(js)}
}`));
    return compiledAsync.get(js);
  };
  const compiled = new Map();
  const body = js => {
    if (!compiled.has(js)) compiled.set(js, compile(js));
    return compiled.get(js);
  };
  const describe = script => String(script?.source ?? script ?? '').slice(0, 160);
  // Ruby scripts carry their transpiled `js`; MV/MZ scripts are JavaScript already, so the
  // converter stores only `source` (a condition's source is an expression to return).
  const jsOf = (script, condition) => typeof script?.js === 'string' ? script.js
    : dialect === 'mv' && typeof script?.source === 'string' ? (condition ? `return (${script.source}\n);` : script.source) : undefined;
  const usable = (script, condition) => script?.error === undefined && jsOf(script, condition) !== undefined;

  return {
    // What the shim implements, for tools/rgss-coverage.mjs: every built-in name with its own
    // member names (getters are listed, not invoked), plus the framework fallbacks.
    introspect() {
      const own = value => {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];
        try { return Reflect.ownKeys(value).filter(key => typeof key === 'string'); } catch { return []; }
      };
      return {
        dialect,
        builtins: Object.fromEntries(Object.entries(dialectBuiltins()).map(([name, value]) => [name, { type: typeof value, members: own(value) }])),
        fallbacks: Object.keys(fallbacks),
        // Every distinct call that hit the loud "not implemented" path so far (the remaining script gaps).
        warned: [...warned]
      };
    },
    // Call Script: run, then play the queued waits in order. Errors are logged with the
    // original Ruby and never stop the event.
    async run(script, state, event) {
      if (!usable(script, false)) {
        console.warn('MWGP RGSS script could not be transpiled and was skipped', describe(script), script?.error ?? '');
        return;
      }
      current = { state, event };
      const mine = queue = [];
      const screenMark = screen?.mark();
      ensureBoot();
      try {
        const result = script.async === true ? await asyncBody(jsOf(script, false)).call(interpreterFor(event), scope) : body(jsOf(script, false)).call(interpreterFor(event), scope);
        void result;
        const pending = mine; queue = null;
        for (const thunk of pending) await thunk();
        return true;
      } catch (error) {
        console.error('MWGP RGSS script failed', describe(script), error, error?.stack || new Error('(no JS stack: a bare Ruby raise)').stack);
        screen?.disposeSince(screenMark);
        return false;
      } finally { queue = null; snapshotEngine(); snapshotBoot(); }
    },
    // Drop pending key edges (the key that opened a scene must not count as input inside it).
    flushInput() { keyProbe?.update(); keyProbe?.update(); },
    // Plugin Command (MV 356): the game's own `Game_Interpreter#pluginCommand` chain (each plugin aliases it), run on a
    // real engine interpreter. Returns false when this runtime has no such interpreter (not MV, or no engine loaded).
    pluginCommand(name, args, state, event) {
      if (dialect !== 'mv') return false;
      let Interpreter;
      try { Interpreter = unit('Game_Interpreter'); } catch { return false; }
      if (typeof Interpreter !== 'function' || typeof Interpreter.prototype?.pluginCommand !== 'function') return false;
      current = { state, event };
      queue = null;
      try {
        const interpreter = new Interpreter();
        interpreter._mapId = mapId; interpreter._eventId = event?.id ?? 0;
        interpreter.pluginCommand(String(name), (args || []).map(String));
        snapshotEngine();
        return true;
      } catch (error) { console.error(`MWGP plugin command "${name}" failed`, error); return true; }
    },
    // Conditional Branch > Script: a synchronous truthiness test; false on any failure.
    evaluate(script, state, event) {
      if (!usable(script, true)) {
        console.warn('MWGP RGSS script condition could not be transpiled; treating as false', describe(script), script?.error ?? '');
        return false;
      }
      ensureBoot();
      const saved = { current, queue };
      current = { state, event };
      queue = null;
      try { return Boolean(body(jsOf(script, true)).call(interpreterFor(event), scope)); }
      catch (error) { console.error('MWGP RGSS script condition failed', describe(script), error); return false; }
      finally { current = saved.current; queue = saved.queue; }
    },
    // Control Variables > Script: the raw eval result (not a truthiness test,
    // so strings assign as strings); 0 with a loud error on any failure,
    // matching the engine's catch (which resets the variable to 0).
    evaluateValue(script, state, event) {
      if (!usable(script, true)) {
        console.warn('MWGP RGSS script operand could not be transpiled; reading as 0', describe(script), script?.error ?? '');
        return 0;
      }
      ensureBoot();
      const saved = { current, queue };
      current = { state, event };
      queue = null;
      try { const value = body(jsOf(script, true)).call(interpreterFor(event), scope); snapshotEngine(); return value; }
      catch (error) { console.error('MWGP RGSS script operand failed', describe(script), error); return 0; }
      finally { current = saved.current; queue = saved.queue; }
    }
  };
}
