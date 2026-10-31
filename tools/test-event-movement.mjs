import assert from 'node:assert/strict';
import { chooseDirections, isNearPlayer, moveFrames, moveInterval, stopFrames } from '../src/player/event-movement.js';

// Frequency 5 never waits, frequency 1 waits 120 frames (Game_Event.stopCountThreshold).
assert.equal(stopFrames(5), 0);
assert.equal(stopFrames(3), 60);
assert.equal(stopFrames(1), 120);
// Speed 4 takes 16 frames per tile, speed 6 four.
assert.equal(moveFrames(4), 16);
assert.equal(moveFrames(6), 4);
assert.equal(moveInterval(4, 3), (16 + 60) / 60);

const sequence = values => { let i = 0; return () => values[i++ % values.length]; };
const event = { x: 5, y: 5 };

// Random type: rolls 0-1 move randomly, 2-4 keep going forward, 5 stands still.
assert.deepEqual(chooseDirections({ type: 1, event, player: { x: 0, y: 0 }, facing: 'left', rng: sequence([0, 0.5]) }), ['right']);
assert.deepEqual(chooseDirections({ type: 1, event, player: { x: 0, y: 0 }, facing: 'left', rng: sequence([2.5 / 6]) }), ['left']);
assert.deepEqual(chooseDirections({ type: 1, event, player: { x: 0, y: 0 }, facing: 'left', rng: sequence([5.5 / 6]) }), []);

// Approach type: far away it wanders; near it heads for the player, longer axis first.
assert.equal(isNearPlayer({ x: 0, y: 0 }, { x: 10, y: 9 }), true);
assert.equal(isNearPlayer({ x: 0, y: 0 }, { x: 10, y: 10 }), false);
assert.deepEqual(chooseDirections({ type: 2, event: { x: 5, y: 5 }, player: { x: 2, y: 4 }, facing: 'down', rng: sequence([0]) }), ['left', 'up']);
assert.deepEqual(chooseDirections({ type: 2, event: { x: 5, y: 5 }, player: { x: 5, y: 9 }, facing: 'down', rng: sequence([0]) }), ['down']);
assert.deepEqual(chooseDirections({ type: 2, event: { x: 5, y: 5 }, player: { x: 2, y: 4 }, facing: 'right', rng: sequence([5.5 / 6]) }), ['right']);
assert.equal(chooseDirections({ type: 2, event: { x: 0, y: 0 }, player: { x: 40, y: 40 }, facing: 'down', rng: sequence([0.1, 0.1]) }).length, 1);

// Fixed and custom types are not decided here.
assert.deepEqual(chooseDirections({ type: 0, event, player: event }), []);
assert.deepEqual(chooseDirections({ type: 3, event, player: event }), []);
console.log('event movement ok');
