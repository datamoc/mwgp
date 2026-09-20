// Transpile the Ruby that XP/VX/Ace event scripts embed (Call Script 355/655,
// Conditional Branch > Script, Move Route > Script) into JavaScript the player
// runs against its RGSS shim (src/player/rgss-script.js).
//
// This is the *event-script subset* of Ruby, not the whole Scripts.rxdata
// corpus (see tools/bundle-rgss-scripts.mjs for that): short expressions and
// statement runs such as `$game_switches[3] = true`, `$bag.add(:POTION)` or
// `pbExclaim($game_map.events[2])`. Each snippet is converted on its own with
// the vendored Ruby2JS self-host build; the result is a function *body* whose
// free identifiers ($game_switches, pbMessage, ...) resolve against the shim
// scope at run time.
//
// Ruby2JS strips predicate/bang suffixes (`can_add?` -> `can_add`) and turns a
// paren-less zero-arg call on a receiver into property access; the shim
// defines its predicates without the suffix and its zero-arg readers as
// getters to match.
import { convert } from '../transpilers/ruby2js-master/demo/selfhost/ruby2js.js';
import Functions from '../transpilers/ruby2js-master/demo/selfhost/filters/functions.js';
import { selfCallsFilter } from './rgss-library.mjs';
import { RgssCalls } from './rgss-call-filter.mjs';

// Snippets run as bodies of the game's Interpreter methods: bare calls to those methods
// become `this.<name>()`. The set comes from the game's scripts (tools/rgss-library.mjs).
let selfFilter = null;
// RgssCalls (see rgss-call-filter.mjs) needs the game's `def` names via setKnownMethods,
// which the converter calls after indexing; snippets and library then agree on which
// paren-less calls are method calls.
export function setInterpreterMethods(names) {
  selfFilter = names?.size ? selfCallsFilter(names).prototype : null;
}
const compile = ruby => convert(ruby, { eslevel: 2022, underscored_private: true, filters: [Functions.prototype, ...(selfFilter ? [selfFilter] : []), RgssCalls.prototype] }).toString().trim();

// kind 'call' -> statements; kind 'cond' -> a body that returns the truthiness
// of the (possibly multi-statement) Ruby expression. Returns { js } or
// { error } so the converter can keep the Ruby text and report the failure
// instead of aborting a whole project on one exotic snippet.
export function transpileSnippet(ruby, kind = 'call') {
  const source = String(ruby ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) return { js: '' };
  try {
    if (kind === 'cond') {
      const js = compile(`__result = (\n${source}\n)`);
      return { js: `${js.replace(/;?\s*$/, ';')}\nreturn __result;` };
    }
    return { js: compile(source) };
  } catch (error) {
    return { error: String(error?.message || error).split('\n')[0].slice(0, 160) };
  }
}
