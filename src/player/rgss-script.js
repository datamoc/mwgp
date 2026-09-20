// Runs the JavaScript that tools/rgss-snippet.mjs produced from the Ruby in XP/VX/Ace
// event scripts (Call Script, Conditional Branch > Script) against a small shim of
// the RGSS globals those scripts touch: $game_switches, $game_variables,
// $game_self_switches, $game_map, $game_player, get_self/get_character, the
// paren-less helpers (setTempSwitchOn, pbMessage, pbExclaim, ...) and the item bag.
//
// Design rules:
// - Free identifiers in a snippet resolve through a `with` scope whose Proxy claims every
//   name that is not a JS builtin. Anything the shim does not implement (battles, marts,
//   Pokémon Essentials engine calls, ...) becomes a stub that warns loudly, once per
//   name, and evaluates to undefined: never silent success, never a crashed event.
// - Snippets run synchronously; shim functions that take time (dialogue, balloons,
//   walking) are queued and awaited in order once the snippet returns. That preserves
//   the order of visible effects. A condition cannot wait, so a queued action inside
//   one only warns.
// - State lives where the player already keeps it: switches/variables in GameState
//   (self switches under the `self:<map>:<event>:<ch>` key the converter uses) and
//   everything else in `scene.rpgExtra`, which rides through transfers and saves.

const JS_BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'console', 'globalThis', 'arguments', '__result', 'Promise'
]);

const humanize = item => String(item).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

export function createRgssRuntime(scene, { mapId, mapEvents = [] } = {}) {
  const warned = new Set();
  const warnOnce = (name, detail) => {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(`MWGP RGSS script call "${name}" is not implemented and was skipped`, detail ?? '');
  };

  const rgss = () => (scene.rpgExtra.rgss ||= { stats: {}, portrait: null });
  let queue = null;
  let current = { state: null, event: null };
  const later = (name, thunk) => {
    if (!queue) return warnOnce(`${name} (needs a wait; unavailable inside a condition)`);
    queue.push(thunk);
  };

  // Ruby's `stub.anything.chained(args)` all funnel into one warning.
  const stub = path => new Proxy(function () {}, {
    get: (_, key) => key === Symbol.toPrimitive ? () => 0 : typeof key === 'symbol' ? undefined : stub(`${path}.${key}`),
    apply: () => { warnOnce(path); return undefined; },
    set: () => { warnOnce(`${path}=`); return true; }
  });

  const eventById = id => mapEvents.find(event => String(event.id) === String(id));
  const character = id => {
    const numeric = Number(id);
    const isPlayer = numeric === -1 || id === 'player';
    const position = () => isPlayer ? { x: scene.mover?.x ?? 0, y: scene.mover?.y ?? 0 } : (eventById(id) || { x: 0, y: 0 });
    return {
      id: isPlayer ? -1 : numeric,
      _target: isPlayer ? 'player' : `event:${id}`,
      get x() { return position().x; },
      get y() { return position().y; },
      get direction() { return { up: 8, right: 6, down: 2, left: 4 }[isPlayer ? scene.facing : (eventById(id)?.facing || 'down')] || 2; },
      // Player standing on this event's own tile: the RGSS `onEvent?` check Essentials
      // events use to detect a step-on trigger.
      get onEvent() { const there = position(), player = character(-1); return there.x === player.x && there.y === player.y; },
      set pattern(value) { warnOnce('Game_Character#pattern=', value); }
    };
  };
  const currentEventId = () => current.event?.id;

  const keyed = (get, set) => new Proxy({}, {
    get: (_, key) => typeof key === 'symbol' ? undefined : get(String(key)),
    set: (_, key, value) => { set(String(key), value); return true; }
  });

  // Ruby `$game_self_switches[[map, event, 'A']]` stringifies its array key to "map,event,A".
  const selfKey = key => { const [map, event, ch] = key.split(','); return `self:${map}:${event}:${ch}`; };
  const setSelf = (letter, value) => {
    const id = currentEventId();
    if (id === undefined) return warnOnce('setTempSwitch (no running event)');
    current.state.game.setSwitch(`self:${mapId}:${id}:${String(letter).toUpperCase()}`, value);
  };

  // Essentials animation ids 3.. map onto MV/XP-style balloon rows 1.. (! ? note heart ...).
  const balloon = (target, id = 3) => later('pbExclaim', () => scene.showBalloon({ target: target.id, balloon: Math.max(1, Number(id) - 2), wait: true }));
  const say = text => later('pbMessage', () => scene.presentDialogue({ text: String(text) }));
  const walk = (target, x, y) => later('pbWalk', () => {
    const steps = [];
    for (let i = 0; i < Math.abs(x - target.x); i++) steps.push({ dx: Math.sign(x - target.x), dy: 0 });
    for (let i = 0; i < Math.abs(y - target.y); i++) steps.push({ dx: 0, dy: Math.sign(y - target.y) });
    return scene.runMoveRoute(target._target, steps);
  });

  const bag = {
    add: (item, quantity = 1) => { const items = scene.rpgExtra.items; items[item] = (items[item] || 0) + quantity; return true; },
    remove: (item, quantity = 1) => {
      const items = scene.rpgExtra.items;
      if ((items[item] || 0) < quantity) return false;
      items[item] -= quantity;
      if (!items[item]) delete items[item];
      return true;
    },
    // Bag capacity is a Pokémon Essentials rule; without pockets everything fits.
    can_add: () => true,
    has: (item, quantity = 1) => (scene.rpgExtra.items[item] || 0) >= quantity,
    quantity: item => scene.rpgExtra.items[item] || 0
  };
  const receive = (item, quantity = 1) => {
    bag.add(item, quantity);
    say(`You found ${quantity > 1 ? `${quantity} ` : 'a '}${humanize(item)}!`);
    return true;
  };

  const player = new Proxy({}, {
    get: (_, key) => {
      if (typeof key === 'symbol') return undefined;
      if (key === 'name') return rgss().playerName || 'Player';
      return stub(`$player.${key}`);
    }
  });

  const globals = {
    $game_switches: keyed(key => current.state.game.switch(key), (key, value) => current.state.game.setSwitch(key, Boolean(value))),
    $game_variables: keyed(key => current.state.game.variable(key), (key, value) => current.state.game.setVariable(key, Number(value))),
    $game_self_switches: keyed(key => current.state.game.switch(selfKey(key)), (key, value) => current.state.game.setSwitch(selfKey(key), Boolean(value))),
    $game_map: { map_id: mapId, events: keyed(id => character(id), () => {}) },
    $game_player: character(-1),
    $bag: bag,
    $player: player,
    // Free-form counters (`$stats.drinks_bought += 1`): unset reads as 0 like a fresh save.
    $stats: keyed(key => rgss().stats[key] ?? 0, (key, value) => { rgss().stats[key] = value; }),
    get_character: id => character(Number(id) === 0 ? currentEventId() ?? 0 : id),
    setTempSwitchOn: letter => setSelf(letter, true),
    setTempSwitchOff: letter => setSelf(letter, false),
    pbGet: id => current.state.game.variable(String(id)),
    pbSet: (id, value) => current.state.game.setVariable(String(id), Number(value)),
    pbExclaim: (target, id) => balloon(target, id),
    pbMessage: say,
    pbItemBall: receive,
    pbReceiveItem: receive,
    pbWalkCharacterTo: (id, x, y) => walk(character(id), x, y),
    pbWalkPlayerTo: (x, y) => walk(character(-1), x, y),
    // Dialogue portraits: the speaker label rides along with every later message until
    // cleared. Portrait art itself is an Essentials graphic the converter does not extract.
    pbSetDialoguePortrait: (art, speaker) => { rgss().portrait = { art: String(art), speaker: speaker ? String(speaker) : undefined }; },
    pbSetPlayerDialoguePortrait: () => { rgss().portrait = null; },
    pbSetRivalDialoguePortrait: () => { rgss().portrait = { art: 'rival', speaker: 'Rival' }; },
    pbClearDialoguePortrait: () => { rgss().portrait = null; }
  };

  const scope = new Proxy({}, {
    has: (_, key) => typeof key === 'string' && !JS_BUILTINS.has(key),
    get: (_, key) => {
      if (typeof key === 'symbol') return undefined;
      // `get_self` reads like a variable in transpiled output; it is the running event.
      if (key === 'get_self') return character(currentEventId() ?? 0);
      return key in globals ? globals[key] : stub(key);
    },
    set: (_, key, value) => { globals[key] = value; return true; }
  });

  const compiled = new Map();
  const compile = js => {
    if (!compiled.has(js)) compiled.set(js, new Function('scope', `with (scope) {\n${js}\n}`));
    return compiled.get(js);
  };
  const describe = script => String(script?.ruby ?? script ?? '').slice(0, 160);
  const usable = script => script?.error === undefined && typeof script?.js === 'string';

  return {
    // Call Script: run, then play the queued waits in order. Errors are logged with the
    // original Ruby and never stop the event.
    async run(script, state, event) {
      if (!usable(script)) {
        console.warn('MWGP RGSS script could not be transpiled and was skipped', describe(script), script?.error ?? '');
        return;
      }
      current = { state, event };
      queue = [];
      try {
        compile(script.js)(scope);
        const pending = queue; queue = null;
        for (const thunk of pending) await thunk();
      } catch (error) {
        console.error('MWGP RGSS script failed', describe(script), error);
      } finally { queue = null; }
    },
    // Conditional Branch > Script: a synchronous truthiness test; false on any failure.
    evaluate(script, state, event) {
      if (!usable(script)) {
        console.warn('MWGP RGSS script condition could not be transpiled; treating as false', describe(script), script?.error ?? '');
        return false;
      }
      current = { state, event };
      queue = null;
      try { return Boolean(compile(script.js)(scope)); }
      catch (error) { console.error('MWGP RGSS script condition failed', describe(script), error); return false; }
    },
    // The speaker label a running dialogue should carry, or undefined.
    speaker: () => rgss().portrait?.speaker
  };
}
