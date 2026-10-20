// Random encounter rules of RPG Maker MV/MZ (Game_Player, Game_Map and Game_Party in the engine), as pure functions.
// `random` returns a number in [0, 1): the scene passes Math.random, the tests pass a seeded generator.

const randomInt = (random, max) => Math.floor(random() * max);

// Steps until the next encounter: the sum of two rolls below the map's encounter step (Game_Player.makeEncounterCount).
export function encounterStepCount(stepLength, random) {
  return randomInt(random, stepLength) + randomInt(random, stepLength) + 1;
}

// How much one completed step counts down (Game_Player.encounterProgressValue): bushes count double,
// the half-rate ability halves it, and a ship halves it again (a boat does not).
export function encounterProgress({ bush = false, halfRate = false, inShip = false } = {}) {
  let value = bush ? 2 : 1;
  if (halfRate) value *= 0.5;
  if (inShip) value *= 0.5;
  return value;
}

// Game_Player.canEncounter: no encounters while the "no encounters" ability is held, while encounters are
// switched off (command 136 with 0), in the airship, or while a move route forces the player.
export function canEncounter({ noEncounters = false, disabled = false, inAirship = false, forced = false } = {}) {
  return !noEncounters && !disabled && !inAirship && !forced;
}

// The troop of an encounter (Game_Player.makeEncounterTroopId): the weighted pick among the map's entries whose
// region set is empty or contains the player's region. 0 means no battle (no entry, or all weights zero).
export function pickTroop(encounterList, regionId, random) {
  const eligible = (encounterList || []).filter(entry => !entry.regionSet?.length || entry.regionSet.includes(regionId));
  const weightSum = eligible.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
  if (weightSum <= 0) return 0;
  let value = randomInt(random, weightSum);
  for (const entry of eligible) {
    value -= Number(entry.weight || 0);
    if (value < 0) return Number(entry.troopId) || 0;
  }
  return 0;
}

// Game_Player.updateDashing: decided between tiles. Dashing needs the player free to move (not in a vehicle, the
// map not disabling it) and either the dash button or a click destination. "Always dash" inverts the button.
export function isDashing({ allowed = false, shiftHeld = false, alwaysDash = false, destination = false } = {}) {
  const dashButton = alwaysDash ? !shiftHeld : shiftHeld;
  return allowed && (dashButton || destination);
}

// Game_CharacterBase.realMoveSpeed: a dash adds one speed step, which doubles the distance covered per frame.
export function moveSpeedFor(baseSpeed, dashing) {
  return dashing ? baseSpeed * 2 : baseSpeed;
}
