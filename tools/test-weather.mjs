// Unit checks for the weather particles (src/player/weather.js): the count, the dimmer, the fall and rebirth rules,
// and the layer's sprite bookkeeping. The sprite and texture factories are fakes, so this runs without a browser.
import assert from 'node:assert/strict';
import { WeatherLayer, stepParticle, weatherDimmerAlpha, weatherSpriteCount } from '../src/player/weather.js';

const fixed = value => () => value;

assert.equal(weatherSpriteCount(0), 0);
assert.equal(weatherSpriteCount(1), 10);
assert.equal(weatherSpriteCount(9), 90);
assert.equal(weatherSpriteCount(12), 90, 'power is capped at 9');
assert.equal(weatherSpriteCount(undefined), 0);
assert.equal(weatherDimmerAlpha(9), 54 / 255);
assert.equal(weatherDimmerAlpha(0), 0);

// stepParticle: a new particle (opacity 0) is reborn at once, at the reborn ranges; with a fixed generator the corner.
{
  const reborn = stepParticle({ ax: 0, ay: 0, opacity: 0 }, { fall: 6, fade: 6, rotation: Math.PI / 16 }, fixed(0), 800, 600);
  assert.equal(reborn.ax, -100);
  assert.equal(reborn.ay, -200);
  assert.equal(reborn.opacity, 160);
}

// A falling rain particle: drifts by fall * sin/cos of its rotation and loses its fade each frame.
{
  const spec = { fall: 6, fade: 6, rotation: Math.PI / 16 };
  const particle = stepParticle({ ax: 100, ay: 100, opacity: 200 }, spec, fixed(0.5), 800, 600);
  assert.equal(particle.opacity, 194);
  assert.ok(Math.abs(particle.ax - (100 - 6 * Math.sin(Math.PI / 16))) < 1e-9);
  assert.ok(Math.abs(particle.ay - (100 + 6 * Math.cos(Math.PI / 16))) < 1e-9);
}

// Rebirth happens below 40 opacity, and its opacity is 160 to 219 for a random value in range.
{
  const spec = { fall: 3, fade: 3, rotation: Math.PI / 16 };
  const particle = stepParticle({ ax: 0, ay: 0, opacity: 42 }, spec, fixed(0.999), 800, 600);
  assert.equal(particle.opacity, 219, 'opacity 39 after the fade, so reborn with 160 + 59');
  const kept = stepParticle({ ax: 5, ay: 5, opacity: 100 }, spec, fixed(0.999), 800, 600);
  assert.equal(kept.ax !== 5, true, 'a particle above 40 keeps moving and is not reborn');
}

// WeatherLayer with fake sprites: the particle count, the dimmer under the particles, a type change, and clearing.
{
  const children = [];
  const made = [];
  const createSprite = texture => {
    const sprite = { texture, x: 0, y: 0, alpha: 1, tint: 0, rotation: 0, width: 0, height: 0,
      removeFromParent() { const index = children.indexOf(sprite); if (index >= 0) children.splice(index, 1); },
      destroy() { sprite.destroyed = true; } };
    made.push(sprite);
    return sprite;
  };
  const layer = { addChild: sprite => children.push(sprite) };
  const createTexture = spec => ({ spec });
  const weather = new WeatherLayer({ layer, width: 800, height: 600, createSprite, createTexture, random: fixed(0.5) });

  weather.set('rain', 5);
  assert.equal(children.length, 51, 'a dimmer plus 50 rain particles');
  assert.equal(children[0].alpha, 30 / 255, 'the dimmer is first, under the particles');
  assert.equal(children[0].tint, 0x505050);
  assert.equal(children[1].texture.spec.height, 60, 'rain particles are 1x60 streaks');
  assert.ok(children[1].rotation > 0);

  weather.update(1 / 60);
  for (const sprite of children) assert.ok(sprite.alpha >= 0 && sprite.alpha <= 1);

  weather.set('snow', 2);
  const particles = children.slice(1);
  assert.equal(particles.length, 20);
  assert.ok(particles.every(sprite => sprite.texture.spec.circle === true), 'a type change rebuilds the particles as snow');

  weather.set('none', 0);
  assert.equal(children.length, 0, 'none clears the layer');
  assert.equal(weather.particles.length, 0);
}

console.log('weather ok (count, dimmer, fall, rebirth, layer rebuild)');
