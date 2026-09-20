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

const JS_BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'console', 'globalThis', 'arguments', '__result', 'Promise', 'TypeError', 'RangeError'
]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

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
  define(Object.prototype, 'dup', dup);
  define(Object.prototype, 'clone', dup);
  // Module reflection used by "define only if missing" hotfix idioms.
  define(Function.prototype, 'method_defined', function (name) { return typeof this.prototype?.[name] === 'function'; });
  define(Function.prototype, 'private_method_defined', () => false);
  define(Function.prototype, 'instance_method', function (name) { return this.prototype?.[name]; });
}

export function createRgssRuntime(scene, { mapId, mapEvents = [], mapSize = {}, library = null, dialect = 'rgss' } = {}) {
  if (dialect === 'rgss') installRubyCore();
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
    apply: () => { warnOnce(path); return undefined; },
    construct: () => { warnOnce(`new ${path}`); return {}; },
    set: () => { warnOnce(`${path}=`); return true; }
  });

  // Free-form RGSS object ($game_temp, $game_system, ...): reads and writes just
  // persist under the object's name, so game code that stashes flags there works.
  // Methods the game's own class defines but this shim does not are borrowed from that class's
  // prototype (`className`), bound to the shim object, so game helpers such as
  // Game_Event#setTempSwitchOn run against the shim's state.
  const openObject = (name, extras = {}, className = null) => new Proxy(extras, {
    get: (target, key, receiver) => {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return target[key];
      const stored = rgss().data[`${name}.${key}`];
      if (stored !== undefined) return stored;
      const borrowed = className ? unit(className)?.prototype?.[key] : undefined;
      return typeof borrowed === 'function' ? borrowed.bind(receiver) : undefined;
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
      get _id() { return target; }, get _map_id() { return mapId; },
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

  const audio = kind => (name, volume = 100, pitch = 100) => scene.playSound?.({ name, volume, pitch, pan: 0, kind });

  const eventsObject = {};
  for (const event of mapEvents) Object.defineProperty(eventsObject, String(event.id), { enumerable: true, get: () => character(event.id) });
  const mapWidth = mapSize.width ?? 0, mapHeight = mapSize.height ?? 0;

  const builtins = {
    $game_switches: keyed(key => current.state.game.switch(key), (key, value) => current.state.game.setSwitch(key, Boolean(value))),
    $game_variables: keyed(key => current.state.game.variable(key), (key, value) => current.state.game.setVariable(key, Number(value))),
    $game_self_switches: keyed(key => current.state.game.switch(selfKey(key)), (key, value) => current.state.game.setSwitch(selfKey(key), Boolean(value))),
    $game_map: openObject('map', {
      get map_id() { return reader('map_id', () => mapId); },
      get _map_id() { return mapId; },
      get width() { return reader('width', () => mapWidth); },
      get height() { return reader('height', () => mapHeight); },
      // A plain object (not a Proxy) so `events.values`/iteration behave like Ruby's Hash.
      get events() { return eventsObject; }
    }, 'Game_Map'),
    $game_player: character(-1),
    $game_party: openObject('party', party, 'Game_Party'),
    $game_temp: openObject('temp', {
      // XP's classic way to show a message from a script.
      set message_text(text) { later('message_text=', () => scene.presentDialogue({ text: String(text) })); }
    }, 'Game_Temp'),
    $game_system: openObject('system', {}, 'Game_System'),
    $game_screen: openObject('screen', {}, 'Game_Screen'),
    Graphics: {
      update: () => {},
      get frame_count() { return reader('frame_count', () => 0); },
      get frame_rate() { return reader('frame_rate', () => 60); },
      get width() { return reader('width', () => 640); },
      get height() { return reader('height', () => 480); }
    },
    Audio: { se_play: audio('se'), bgm_play: (name, volume = 100, pitch = 100) => scene.playTrack?.('bgm', { name, volume, pitch, pan: 0 }), bgm_stop() {}, bgs_stop() {}, me_stop() {} },
    // Class-body macros that Ruby2JS leaves as calls when they sit in a module body; nothing to do
    // in JS (accessors compile to properties, visibility does not exist).
    attr_accessor() {}, attr_reader() {}, attr_writer() {}, module_function() {}, private() {}, public() {}, protected() {},
    require() {}, require_relative() {},
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
      set _balloon(value) {}
    });
  };
  const mvItems = keyed(id => ({ id: Number(id) }), () => {});
  const idOf = item => Number(item?.id ?? item);
  const mvBuiltins = {
    $gameSwitches: { value: id => current.state.game.switch(String(id)), setValue: (id, value) => current.state.game.setSwitch(String(id), Boolean(value)) },
    $gameVariables: { value: id => current.state.game.variable(String(id)), setValue: (id, value) => current.state.game.setVariable(String(id), Number(value)) },
    $gameSelfSwitches: { value: key => current.state.game.switch(selfKey(String(key))), setValue: (key, value) => current.state.game.setSwitch(selfKey(String(key)), Boolean(value)) },
    $gameMap: openObject('map', {
      mapId: () => mapId, width: () => mapSize.width ?? 0, height: () => mapSize.height ?? 0,
      event: id => mvCharacter(Number(id) === 0 ? currentEventId() ?? 0 : id), requestRefresh() {}
    }),
    $gamePlayer: mvCharacter(-1),
    $gameParty: openObject('party', {
      gold: () => scene.rpgExtra.gold, gainGold: party.gain_gold, loseGold: party.lose_gold,
      gainItem: (item, amount = 1) => party.gain_item(idOf(item), amount), loseItem: (item, amount = 1) => party.lose_item(idOf(item), amount),
      numItems: item => party.item_number(idOf(item)), hasItem: item => party.item_number(idOf(item)) > 0,
      members: () => scene.rpgExtra.party.map(id => ({ actorId: () => id }))
    }),
    $dataItems: mvItems, $dataWeapons: mvItems, $dataArmors: mvItems,
    $gameSystem: openObject('system'), $gameTemp: openObject('temp'), $gameScreen: openObject('screen')
  };
  const dialectBuiltins = () => dialect === 'mv' ? mvBuiltins : builtins;

  // ---- the game's own library, loaded lazily -------------------------------------
  const units = library?.units || {};
  const loaded = new Map();
  const loading = new Set();
  const compile = (js, tail = '') => new Function('scope', `with (scope) {\n${js}\n${tail}\n}`);
  const unit = name => {
    if (loaded.has(name)) return loaded.get(name);
    if (!Object.hasOwn(units, name) || loading.has(name) || !IDENTIFIER.test(name)) return undefined;
    loading.add(name);
    try {
      // `this` is the scope so top-level reflection calls (`method_defined`) resolve to built-ins.
      loaded.set(name, compile(units[name], `return typeof ${name} !== 'undefined' ? ${name} : undefined;`).call(scope, scope));
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
      if (key in dialectBuiltins()) return dialectBuiltins()[key];
      const found = unit(key);
      return found !== undefined ? found : stub(key);
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
    // Call Script: run, then play the queued waits in order. Errors are logged with the
    // original Ruby and never stop the event.
    async run(script, state, event) {
      if (!usable(script, false)) {
        console.warn('MWGP RGSS script could not be transpiled and was skipped', describe(script), script?.error ?? '');
        return;
      }
      current = { state, event };
      queue = [];
      try {
        body(jsOf(script, false)).call(interpreterFor(event), scope);
        const pending = queue; queue = null;
        for (const thunk of pending) await thunk();
      } catch (error) {
        console.error('MWGP RGSS script failed', describe(script), error);
      } finally { queue = null; }
    },
    // Conditional Branch > Script: a synchronous truthiness test; false on any failure.
    evaluate(script, state, event) {
      if (!usable(script, true)) {
        console.warn('MWGP RGSS script condition could not be transpiled; treating as false', describe(script), script?.error ?? '');
        return false;
      }
      current = { state, event };
      queue = null;
      try { return Boolean(body(jsOf(script, true)).call(interpreterFor(event), scope)); }
      catch (error) { console.error('MWGP RGSS script condition failed', describe(script), error); return false; }
    }
  };
}
