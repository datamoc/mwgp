// The in-game menu for MV/MZ projects: Item, Skill, Equip, Status, Save, Options and Game End, over the
// project's own database and the player's actor records, driven through the same dialogue seam as battles
// (`present({ text, choices })`, paged five entries at a time), so it is deterministic and testable.
//
//   runMenu({ database, records, party, items, weapons, armors, gold, present, hooks, rng, variable })
//
// `records` maps actor id -> the persistent record (level, exp, hp, mp, states, skills, equips);
// `items` / `weapons` / `armors` are { id: count } inventories, all mutated in place. Screens:
//   * Item   - usable items (occasion always / menu), key items listed; scope-aware target choice; effects and
//              recovery formulas share the battle rules (createRules), consumables are used up;
//   * Skill  - an actor's learned skills usable from the menu; MP is paid, effects applied to the chosen ally;
//   * Equip  - per slot: what can be equipped (slot type + the class's weapon/armor type traits), swapping with
//              the inventory, stats clamped afterwards; "Unequip" empties a slot;
//   * Status - level, class, HP/MP, experience to next level, the eight parameters, equipment and states;
//   * Formation - RPG Maker's party reorder (the first `hooks.maxBattleMembers` fight, the rest wait in reserve) plus this
//              player's own choice of battlefield layout (line, triangle, square, ... see formation.js), through
//              `hooks.formation = { get(), set(name) }`; shown only when supplied (Change Formation Access can hide it);
//   * Save / Options / Game End go through `hooks` (save, options, toTitle), shown only when supplied.
import { FORMATION_NAMES, FORMATION_LABELS, layoutFormation } from './formation.js';
import { ActorBattler, createPicker, createRules, battleText, expForLevel, format } from './battle.js';

const DEATH_STATE = 1;

export async function runMenu({ database, records, party, items, weapons, armors, gold = 0, present, hooks = {}, rng = Math.random, variable = () => 0 }) {
  const { terms, message, basic } = battleText(database);
  const pick = createPicker(present, terms);
  const rules = createRules({ database, rng, variable, message, basic });
  const battle = { database, rng, variable, terms, items };
  const command = (index, fallback) => terms.commands?.[index] || fallback;
  const currency = database.system?.currencyUnit || 'G';
  const say = async lines => { const list = lines.filter(Boolean); for (let at = 0; at < list.length; at += 4) await present({ text: list.slice(at, at + 4).join('\n') }); };

  const battlerFor = id => new ActorBattler(battle, id, records[id] || (records[id] = { level: database.actors?.[id]?.initialLevel || 1, classId: database.actors?.[id]?.classId }), 0);
  // Writes a battler's HP/MP/state back to the persistent record (same as the end of a battle).
  const sync = battler => {
    const record = battler.record;
    record.hp = battler.hp; record.mp = battler.mp; record.maxHp = battler.mhp; record.maxMp = battler.mmp; record.dead = battler.dead;
    record.states = battler.states.map(state => state.id).filter(id => !database.states?.[id]?.removeAtBattleEnd);
  };
  const members = () => party.map(battlerFor);
  const memberLabel = actor => `${actor.name}  ${basic(1)}${actor.level}  ${basic(2)} ${actor.hp}/${actor.mhp}${actor.mmp ? `  ${basic(4)} ${actor.mp}/${actor.mmp}` : ''}${actor.dead ? '  †' : ''}`;
  const partyText = () => `${members().map(actor => `${actor.name} ${actor.hp}/${actor.mhp}`).join(' | ')}\n${gold}${currency}`;
  const chooseActor = async text => { const list = members(); const entry = await pick(text, list.map(actor => ({ label: memberLabel(actor), actor }))); return entry?.actor ?? null; };

  // ---- using an item or skill on party members ---------------------------------------------------
  const targetsFor = async (user, thing) => {
    const scope = Number(thing.scope);
    // The caster is one instance everywhere (a fresh battler for the same actor would overwrite its MP/HP on sync).
    const all = members().map(actor => (actor.actorId === user.actorId ? user : actor));
    if (scope === 8) return all.filter(actor => !actor.dead);
    if (scope === 10) return all.filter(actor => actor.dead);
    if (scope === 11) return [user];
    if (![7, 9].includes(scope)) return [];
    const pool = scope === 9 ? all.filter(actor => actor.dead) : all.filter(actor => !actor.dead);
    if (pool.length <= 1) return pool;
    const entry = await pick(thing.name, pool.map(actor => ({ label: memberLabel(actor), actor })));
    return entry ? [entry.actor] : null;
  };
  const applyTo = (user, target, thing, log) => {
    const type = Number(thing.damage?.type || 0);
    if (type === 3 || type === 4) {
      const { value } = rules.damageFor(user, target, thing);
      if (type === 3) target.gainHp(-value); else target.gainMp(-value);
      log.push(format(message('actorRecovery'), target.name, type === 3 ? basic(2) : basic(4), Math.abs(value)));
    }
    rules.applyEffects(user, target, thing, log);
  };
  const applyThing = async (user, thing, targets, { consume } = {}) => {
    const log = [format('%1 uses %2!', user.name, thing.name)];
    for (const target of targets) applyTo(user, target, thing, log);
    if (log.length === 1) log.push(format(message('actionFailure'), targets[0]?.name || user.name));
    sync(user); for (const target of targets) sync(target);
    consume?.();
    await say(log);
  };

  // ---- screens ----------------------------------------------------------------------------------
  const itemScreen = async () => {
    for (;;) {
      const usable = Object.entries(items).filter(([, count]) => count > 0).map(([id, count]) => ({ id, count, item: database.items?.[id] })).filter(entry => entry.item);
      if (!usable.length) { await say([command(4, 'Item'), '—']); return; }
      // The order the game's own list builders give the item list (hooks.listOrder: plugins that sort or filter it).
      const itemOrder = hooks.listOrder?.('Window_ItemList', usable.map(entry => entry.item));
      if (itemOrder) usable.sort((a, b) => itemOrder.indexOf(a.item) - itemOrder.indexOf(b.item));
      const entry = await pick(`${command(4, 'Item')}  ${partyText()}`, usable.map(candidate => ({ ...candidate, label: `${candidate.item.name} ×${candidate.count}${[0, 2].includes(Number(candidate.item.occasion)) ? '' : '  (—)'}` })));
      if (!entry) return;
      const item = entry.item;
      if (![0, 2].includes(Number(item.occasion))) { await say([item.name, item.description || '']); continue; }
      const user = members().find(actor => !actor.dead) || members()[0];
      const targets = await targetsFor(user, item);
      if (!targets || !targets.length) continue;
      await applyThing(user, item, targets, { consume: () => { if (item.consumable !== false) { items[entry.id] -= 1; if (items[entry.id] <= 0) delete items[entry.id]; } } });
    }
  };

  const skillScreen = async () => {
    const owner = await chooseActor(command(5, 'Skill'));
    if (!owner) return;
    for (;;) {
      const skills = owner.skills().filter(skill => [0, 2].includes(Number(skill.occasion)));
      const skillOrder = skills.length ? hooks.listOrder?.('Window_SkillList', skills) : null;
      if (skillOrder) skills.sort((a, b) => skillOrder.indexOf(a) - skillOrder.indexOf(b));
      if (!skills.length) { await say([`${owner.name}: ${command(5, 'Skill')}`, '—']); return; }
      const entry = await pick(`${owner.name}  ${basic(4)} ${owner.mp}/${owner.mmp}`, skills.map(skill => ({ skill, label: `${skill.name}${skill.mpCost ? `  ${skill.mpCost} ${basic(5)}` : ''}` })));
      if (!entry) return;
      if (owner.mp < Number(entry.skill.mpCost || 0)) { await say([`${owner.name}: ${basic(4)}?`]); continue; }
      const targets = await targetsFor(owner, entry.skill);
      if (!targets || !targets.length) continue;
      owner.mp -= Number(entry.skill.mpCost || 0);
      await applyThing(owner, entry.skill, targets);
    }
  };

  // Which items may go in a slot: the slot's equipment type plus the class's weapon/armor type traits.
  const allowedTypes = (actor, code) => new Set([...(actor.klass?.traits || []), ...(actor.source.traits || [])].filter(trait => trait.code === code).map(trait => trait.dataId));
  const equippable = (actor, slot) => {
    const pool = slot === 1 ? weapons : armors, table = slot === 1 ? database.weapons : database.armors;
    const types = allowedTypes(actor, slot === 1 ? 51 : 52);
    return Object.entries(pool).filter(([, count]) => count > 0).map(([id]) => ({ id: Number(id), item: table?.[id] }))
      .filter(({ item }) => item && Number(item.etypeId) === (slot === 1 ? 1 : slot) && (!types.size || types.has(slot === 1 ? item.wtypeId : item.atypeId)));
  };
  const currentEquip = (record, actor, slot) => { const override = record.equips?.[String(slot)]; return override ? Number(override.id) : Number(actor.source.equips?.[slot - 1] || 0); };
  const equipScreen = async () => {
    const owner = await chooseActor(command(6, 'Equip'));
    if (!owner) return;
    for (;;) {
      const actor = battlerFor(owner.actorId);
      const slots = Math.max(actor.source.equips?.length || 0, database.system?.equipTypes ? database.system.equipTypes.length - 1 : 0);
      const rows = [];
      for (let slot = 1; slot <= slots; slot++) {
        const id = currentEquip(actor.record, actor, slot);
        const table = slot === 1 ? database.weapons : database.armors;
        rows.push({ slot, label: `${database.system?.equipTypes?.[slot] || `#${slot}`}: ${id ? table?.[id]?.name || `#${id}` : '—'}` });
      }
      const row = await pick(`${actor.name}  ${basic(1)}${actor.level}`, rows);
      if (!row) return;
      const options = [{ label: '—', id: 0 }, ...equippable(actor, row.slot).map(({ id, item }) => ({ label: `${item.name} ×${(row.slot === 1 ? weapons : armors)[id]}`, id }))];
      const chosen = await pick(rows.find(entry => entry.slot === row.slot).label, options);
      if (!chosen) continue;
      const pool = row.slot === 1 ? weapons : armors;
      const current = currentEquip(actor.record, actor, row.slot);
      if (current) pool[current] = (pool[current] || 0) + 1;
      if (chosen.id) { pool[chosen.id] -= 1; if (pool[chosen.id] <= 0) delete pool[chosen.id]; }
      (actor.record.equips ||= {})[String(row.slot)] = chosen.id ? { id: chosen.id, kind: row.slot === 1 ? 'weapon' : 'armor' } : { id: 0, kind: row.slot === 1 ? 'weapon' : 'armor' };
      const updated = battlerFor(actor.actorId);       // new stats: clamp HP/MP under the new maximums
      updated.hp = Math.min(updated.hp, updated.mhp); updated.mp = Math.min(updated.mp, updated.mmp);
      sync(updated);
    }
  };

  const statusScreen = async () => {
    const owner = await chooseActor(command(7, 'Status'));
    if (!owner) return;
    const actor = battlerFor(owner.actorId);
    const next = expForLevel(actor.klass, actor.level + 1);
    const names = terms.params || ['Max HP', 'Max MP', 'Attack', 'Defense', 'M.Attack', 'M.Defense', 'Agility', 'Luck'];
    const equipment = actor.equipItems().map(item => item.name).join(', ') || '—';
    const states = actor.states.map(state => database.states?.[state.id]?.name).filter(Boolean).join(', ') || '—';
    await say([
      `${actor.name}  ${actor.klass?.name || ''}  ${basic(1)}${actor.level}`,
      // The database/Change Actor Text profile (MV's Game_Actor#profile): what the editor writes, shown here.
      String(actor.record.profile || actor.source.profile || ''),
      `${basic(2)} ${actor.hp}/${actor.mhp}   ${basic(4)} ${actor.mp}/${actor.mmp}`,
      `${terms.messages?.expTotal ? format(terms.messages.expTotal, basic(8) || 'EXP') : 'EXP'} ${actor.record.exp ?? expForLevel(actor.klass, actor.level)}   ${terms.messages?.expNext ? format(terms.messages.expNext, basic(0)) : 'Next'} ${Math.max(0, next - Number(actor.record.exp ?? expForLevel(actor.klass, actor.level)))}`
    ]);
    await say([[2, 3, 4, 5].map(id => `${names[id]} ${actor.param(id)}`).join('  '), [6, 7].map(id => `${names[id]} ${actor.param(id)}`).join('  '), `${command(6, 'Equip')}: ${equipment}`, `State: ${states}`]);
  };

  // ---- formation: order and layout ----------------------------------------------------------------
  const formationScreen = async () => {
    const fighting = Math.max(1, Number(hooks.maxBattleMembers || 4));
    const rowsText = name => layoutFormation(name, Math.min(party.length, fighting)).reduce((rows, slot) => { rows[slot.row] = (rows[slot.row] || 0) + 1; return rows; }, []).join('-');
    for (;;) {
      const layout = hooks.formation.get();
      const chosen = await pick(command(8, 'Formation'), [
        { label: `Change order`, kind: 'order' },
        { label: `Layout: ${FORMATION_LABELS[layout] || layout} (${rowsText(layout)})`, kind: 'layout' }
      ]);
      if (!chosen) return;
      if (chosen.kind === 'layout') {
        const shape = await pick('Layout (front-to-back rows)', FORMATION_NAMES.map(name => ({ label: `${FORMATION_LABELS[name] || name}  ${rowsText(name)}${name === layout ? ' ◀' : ''}`, name })));
        if (shape) hooks.formation.set(shape.name);
        continue;
      }
      if (party.length < 2) { await say(['Only one member.']); continue; }
      const members = () => party.map((id, index) => ({ label: `${index + 1}. ${battlerFor(id).name}${index >= fighting ? ' (reserve)' : ''}`, index }));
      const first = await pick('Move whom?', members());
      if (!first) continue;
      const second = await pick('Swap with?', members().filter(entry => entry.index !== first.index));
      if (!second) continue;
      [party[first.index], party[second.index]] = [party[second.index], party[first.index]];
    }
  };

  // ---- the main menu -----------------------------------------------------------------------------
  for (;;) {
    const rows = [
      { label: command(4, 'Item'), run: itemScreen }, { label: command(5, 'Skill'), run: skillScreen },
      { label: command(6, 'Equip'), run: equipScreen }, { label: command(7, 'Status'), run: statusScreen },
      ...(hooks.formation ? [{ label: command(8, 'Formation'), run: formationScreen }] : []),
      ...(hooks.save ? [{ label: command(9, 'Save'), run: async () => { await hooks.save(); await say([command(9, 'Save')]); } }] : []),
      ...(hooks.load ? [{ label: command(18, 'Load'), run: hooks.load }] : []),
      ...(hooks.options ? [{ label: command(11, 'Options'), run: hooks.options }] : []),
      ...(hooks.toTitle ? [{ label: command(10, 'Game End'), run: async () => { const sure = await pick(command(10, 'Game End'), [{ label: command(21, 'To Title'), yes: true }]); if (sure?.yes) { await hooks.toTitle(); return 'end'; } } }] : [])
    ];
    const chosen = await pick(partyText(), rows);
    if (!chosen) return { closed: true };
    if ((await chosen.run()) === 'end') return { closed: false, ended: true };
  }
}
