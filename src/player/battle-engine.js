// Lets a battle use the game's own engine classes for what its data says is game code.
//
// `runBattle` (battle.js) is the player's own troop battle runner. A game whose
// project ships its plugin library carries rules the runner cannot know: a
// skill's real cost, its after-use effect, its damage formula are code the game's
// own `Game_Action` / `Game_Battler` run. When that engine is loaded in the
// plugin sandbox (rgss-script.js, `mv` dialect), the runner hands those skills to it:
//
//   * each combatant has a mirror in the sandbox (`$gameActors.actor(id)`, the
//     members of `$gameTroop`), whose hp/mp/tp/states are set from the runner's
//     battler before the engine acts and read back afterwards;
//   * `skillCost` asks the engine what a skill costs the user;
//   * `applyAction` is `Game_Action#apply`: the engine pays nothing and decides
//     everything else; the runner shows the result.
//
// Both hooks are synchronous, like the runner's own rules. A skill or item whose
// database entry has a note is data written for the game's own code, so only those
// are delegated. Everything else (and every project without a plugin engine) stays
// on the runner's own rules. Nothing here names a game, a framework or a plugin.
const hasNote = item => typeof item?.note === 'string' && item.note.trim() !== '';

export function createBattleEngine(rgss, game) {
  const run = (code, args) => rgss.evaluateValue(
    { source: 'battle engine', mv: true, js: `const A = ${JSON.stringify(args ?? null)};\ntry {\n${code}\n} catch (error) { return { error: String(error && error.message || error) }; }` },
    { game }, { id: 0 });
  let usable = null;
  let warned = false;
  const warnOnce = message => { if (!warned) { warned = true; console.warn(`MWGP battle engine: ${message}; the runner's own rules are used`); } };
  const guard = result => {
    if (result && typeof result === 'object' && !result.error) return result;
    warnOnce(result?.error ?? 'the engine returned nothing');
    return null;
  };

  // The sandbox side: mirrors of the runner's combatants.
  const prelude = `
    const mirror = ref => ref.enemy ? $gameTroop.members()[ref.index] : $gameActors.actor(ref.id);
    const push = (battler, state) => { battler._hp = state.hp; battler._mp = state.mp; battler._tp = state.tp; battler._states = state.states.slice(); };
    const pull = battler => ({ hp: battler._hp, mp: battler._mp, tp: battler._tp, states: (battler._states || []).slice() });
  `;
  const ref = battler => battler.isActor ? { id: battler.actorId } : { enemy: true, index: battler.index };
  const state = battler => ({ hp: battler.hp, mp: battler.mp, tp: battler.tp, states: battler.states.map(entry => entry.id) });

  // Writes the engine's view back onto the runner's battler, keeping the turns of states it already had.
  const apply = (battler, after) => {
    battler.hp = Math.max(0, Math.min(Number(after.hp) || 0, battler.mhp));
    battler.mp = Math.max(0, Math.min(Number(after.mp) || 0, Math.max(battler.mmp, battler.mp)));
    battler.tp = Math.max(0, Math.min(Number(after.tp) || 0, 100));
    battler.states = after.states.map(id => battler.states.find(entry => entry.id === id) || { id, turns: 0 });
  };

  return {
    // The engine must be present, and a battle must have been begun.
    get available() {
      if (usable === null) {
        const probe = run(`return { ready: typeof Game_Action === 'function' && typeof Game_Troop === 'function' && typeof $gameActors === 'object' && !!$gameActors && typeof $dataSkills === 'object' };`);
        usable = Boolean(probe?.ready);
      }
      return usable;
    },
    begin({ troopId }) {
      if (!this.available) return false;
      const result = guard(run(`$gameTroop = new Game_Troop(); $gameTroop.setup(A.troopId); $gameParty._inBattle = true; return { members: $gameTroop.members().length };`, { troopId }));
      return Boolean(result);
    },
    end() {
      if (usable) run(`$gameParty._inBattle = false; return {};`);
    },
    delegates(item) { return usable === true && hasNote(item); },
    // What the engine charges `subject` for `skill`, or null when it is not the engine's to say.
    skillCost({ subject, skill }) {
      if (!this.delegates(skill)) return null;
      const result = guard(run(`${prelude}
        const user = mirror(A.ref); push(user, A.state);
        const skill = $dataSkills[A.id];
        return { mp: user.skillMpCost(skill), tp: user.skillTpCost(skill) };`, { ref: ref(subject), state: state(subject), id: skill.id }));
      return result ? { mp: Number(result.mp) || 0, tp: Number(result.tp) || 0 } : null;
    },
    // Game_Action#itemCnt / #itemMrf: the odds that `target` counters or reflects `item`, or null when the runner's own traits decide.
    counterRates({ subject, target, item, isItem }) {
      if (!this.delegates(item)) return null;
      const result = guard(run(`${prelude}
        const user = mirror(A.subject.ref), target = mirror(A.target.ref);
        push(user, A.subject.state); if (target !== user) push(target, A.target.state);
        const action = new Game_Action(user, true);
        if (A.isItem) action.setItem(A.id); else action.setSkill(A.id);
        return { cnt: action.itemCnt(target), mrf: action.itemMrf(target) };`,
      { subject: { ref: ref(subject), state: state(subject) }, target: { ref: ref(target), state: state(target) }, id: item.id, isItem: Boolean(isItem) }));
      return result ? { cnt: Number(result.cnt) || 0, mrf: Number(result.mrf) || 0 } : null;
    },
    // Game_Action#apply of the engine. Returns what happened, or null when the runner should apply it itself.
    applyAction({ subject, target, item, isItem }) {
      if (!this.delegates(item)) return null;
      const result = guard(run(`${prelude}
        const user = mirror(A.subject.ref), target = mirror(A.target.ref);
        push(user, A.subject.state); if (target !== user) push(target, A.target.state);
        const action = new Game_Action(user, true);
        if (A.isItem) action.setItem(A.id); else action.setSkill(A.id);
        action.apply(target);
        const r = target.result();
        return { subject: pull(user), target: target === user ? pull(user) : pull(target),
          result: { missed: !!r.missed, evaded: !!r.evaded, critical: !!r.critical, hpDamage: r.hpDamage || 0, mpDamage: r.mpDamage || 0 } };`,
      { subject: { ref: ref(subject), state: state(subject) }, target: { ref: ref(target), state: state(target) }, id: item.id, isItem: Boolean(isItem) }));
      if (!result) return null;
      apply(subject, result.subject);
      if (target !== subject) apply(target, result.target);
      return result.result;
    }
  };
}
