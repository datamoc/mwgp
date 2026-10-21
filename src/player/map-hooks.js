// The Game_Player methods of the map's encounter rules a plugin may override (map-engine.js), and how a plugin's source
// shows it. Pure: tools/mv-plugins.mjs selects plugins with the same list when it builds a library, and the player derives
// the list again from the plugins of an older manifest that has no `mapHooks`.

export const MAP_HOOK_METHODS = ['canEncounter', 'encounterProgressValue', 'makeEncounterCount', 'makeEncounterTroopId'];

// True for a source that assigns one of the methods through any alias of the class (`var _GP = Game_Player; _GP.prototype...`).
export const HOOKS_MAP_PATTERN = new RegExp(`\\.prototype\\.(?:${MAP_HOOK_METHODS.join('|')})\\s*=(?!=)`);

export function mapHookNames(source) {
  return MAP_HOOK_METHODS.filter(name => new RegExp(`\\.prototype\\.${name}\\s*=(?!=)`).test(source));
}
