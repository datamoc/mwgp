// Lets the map's random encounter rules use the game's own engine code when a plugin overrides them.
//
// The stock rules (map-rules.js) run unless the project's plugin library lists the method in `mapHooks`, which
// tools/mv-plugins.mjs fills when a selected plugin assigns one of the Game_Player methods (HOOKS_MAP). Then the
// engine's method runs in the plugin sandbox (rgss-script.js, `mv` dialect) on a bare player object carrying the
// scene's state, the same way battle-engine.js runs the game's own skills. A failure, or a value of the wrong
// type, warns once and returns null, and the caller uses the stock rule. Nothing here names a game, a framework
// or a plugin.

const OVERRIDABLE = ['canEncounter', 'encounterProgressValue'];

// `state`: { x, y, vehicle, disabled } where vehicle is 'walk', 'boat', 'ship' or 'airship' (Game_Player's _vehicleType)
// and disabled is true while command 136 has switched encounters off.
export function createMapEngine(rgss, game, { mapHooks = [] } = {}) {
  const overridden = new Set(mapHooks.filter(name => OVERRIDABLE.includes(name)));
  const warned = new Set();
  const warnOnce = (name, message) => {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(`MWGP map engine: ${name} ${message}; the stock rule is used`);
  };
  const run = (name, code, args) => rgss.evaluateValue(
    { source: `map engine ${name}`, mv: true, js: `const A = ${JSON.stringify(args)};\ntry {\n${code}\n} catch (error) { return { error: String(error && error.message || error) }; }` },
    { game }, { id: 0 });
  // A bare player: the engine's own method reads these fields and calls the game's other engine objects. Command 136
  // lives in the scene's state, so it is written into the sandbox's Game_System before the call.
  const bare = `if ($gameSystem) $gameSystem._encounterEnabled = !A.disabled; const player = Object.create(Game_Player.prototype); Object.assign(player, { _x: A.x, _y: A.y, _vehicleType: A.vehicle, _moveRouteForcing: false });`;

  return {
    overrides(name) { return overridden.has(name); },
    canEncounter(state) {
      if (!overridden.has('canEncounter')) return null;
      const result = run('canEncounter', `${bare} return { value: player.canEncounter() };`, state);
      if (result && !result.error && typeof result.value === 'boolean') return result.value;
      warnOnce('canEncounter', result?.error ?? 'returned no boolean');
      return null;
    },
    encounterProgressValue(state) {
      if (!overridden.has('encounterProgressValue')) return null;
      const result = run('encounterProgressValue', `${bare} return { value: player.encounterProgressValue() };`, state);
      if (result && !result.error && Number.isFinite(result.value)) return result.value;
      warnOnce('encounterProgressValue', result?.error ?? 'returned no number');
      return null;
    },
  };
}
