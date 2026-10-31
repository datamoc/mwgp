// Autonomous event movement, the rules of RPG Maker's Game_Event.updateSelfMovement (rpg_objects.js / rmmz_objects.js).
// Pure: the scene gives positions and a random generator and gets back which way to try, so the rules are unit-tested
// in Node (tools/test-event-movement.mjs). Types: 0 fixed, 1 random, 2 approach the player, 3 custom route (a route
// the scene runs itself).

export const DIRECTION_STEPS = { down: [0, 1], left: [-1, 0], right: [1, 0], up: [0, -1] };
const DIRECTIONS = ['down', 'left', 'right', 'up'];

export const DEFAULT_SPEED = 4;
export const DEFAULT_FREQUENCY = 3;

// Game_Event.stopCountThreshold: frames to stand still before the next move (frequency 1-5).
export function stopFrames(frequency = DEFAULT_FREQUENCY) {
  return 30 * (5 - Math.min(5, Math.max(1, Number(frequency))));
}

// Game_CharacterBase.distancePerFrame = 2^speed / 256 of a tile, so a tile takes this many frames.
export function moveFrames(speed = DEFAULT_SPEED) {
  return 256 / 2 ** Math.min(6, Math.max(1, Number(speed)));
}

// Seconds from the start of one move to the start of the next.
export function moveInterval(speed, frequency) {
  return (moveFrames(speed) + stopFrames(frequency)) / 60;
}

// Game_Event.isNearThePlayer: the sum of both distances under 20 tiles.
export function isNearPlayer(event, player) {
  return Math.abs(event.x - player.x) + Math.abs(event.y - player.y) < 20;
}

function randomDirection(rng) {
  return DIRECTIONS[Math.floor(rng() * 4)];
}

// Game_Character.moveTowardCharacter: the longer axis first, then the other one when that move fails.
function towardPlayer(event, player) {
  const sx = event.x - player.x;
  const sy = event.y - player.y;
  const horizontal = sx === 0 ? [] : [sx > 0 ? 'left' : 'right'];
  const vertical = sy === 0 ? [] : [sy > 0 ? 'up' : 'down'];
  return Math.abs(sx) > Math.abs(sy) ? [...horizontal, ...vertical] : [...vertical, ...horizontal];
}

// Directions to try, in order, for one self-movement decision; an empty list means stand still this time.
// `facing` is the event's current direction (moveForward).
export function chooseDirections({ type, event, player, facing = 'down', rng = Math.random }) {
  if (type === 1) {
    const roll = Math.floor(rng() * 6);
    if (roll <= 1) return [randomDirection(rng)];
    if (roll <= 4) return [facing];
    return [];
  }
  if (type === 2) {
    if (!isNearPlayer(event, player)) return [randomDirection(rng)];
    const roll = Math.floor(rng() * 6);
    if (roll <= 3) return towardPlayer(event, player);
    if (roll === 4) return [randomDirection(rng)];
    return [facing];
  }
  return [];
}
