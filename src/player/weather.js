// Weather particles of RPG Maker MV/MZ (the Weather sprite in rpg_sprites.js / rmmz_sprites.js), on a screen-space layer.
// The pure rules are exported for the tests; WeatherLayer takes its sprite and texture factories from the caller.

const WEATHER = {
  rain: { width: 1, height: 60, circle: false, rotation: Math.PI / 16, fall: 6, fade: 6 },
  storm: { width: 2, height: 100, circle: false, rotation: Math.PI / 8, fall: 8, fade: 8 },
  snow: { width: 9, height: 9, circle: true, rotation: Math.PI / 16, fall: 3, fade: 3 },
};

export const WEATHER_TYPES = Object.keys(WEATHER);

// Game_Screen weather power is 0 to 9; the particle count is floor(power * 10) (at most 90).
export function weatherSpriteCount(power) {
  return Math.floor(Math.max(0, Math.min(9, Number(power) || 0)) * 10);
}

// The grey dimmer behind the weather: opacity floor(power * 6), out of 255.
export function weatherDimmerAlpha(power) {
  return Math.floor(Math.max(0, Math.min(9, Number(power) || 0)) * 6) / 255;
}

// One frame of one particle. A particle starts at opacity 0 and is reborn as soon as its opacity drops below 40,
// at a random place above and around the screen, with an opacity of 160 to 219.
export function stepParticle(particle, spec, random, width, height) {
  particle.ax -= spec.fall * Math.sin(spec.rotation);
  particle.ay += spec.fall * Math.cos(spec.rotation);
  particle.opacity -= spec.fade;
  if (particle.opacity < 40) {
    particle.ax = Math.floor(random() * (width + 100)) - 100;
    particle.ay = Math.floor(random() * (height + 200)) - 200;
    particle.opacity = 160 + Math.floor(random() * 60);
  }
  return particle;
}

export class WeatherLayer {
  // createSprite(texture) -> a display sprite; createTexture(spec) -> a texture for a particle bitmap; layer: a container.
  constructor({ layer, width, height, createSprite, createTexture, random = Math.random }) {
    Object.assign(this, { layer, width, height, createSprite, createTexture, random });
    this.textures = new Map();
    this.particles = [];
    this.type = 'none';
    this.dimmer = null;
  }

  set(type, power) {
    if (!WEATHER[type]) { this.clear(); return; }
    const count = weatherSpriteCount(power);
    const spec = WEATHER[type];
    if (this.type !== type) {
      // Another kind of particle: the old sprites carry the wrong bitmap, so they are rebuilt.
      for (const particle of this.particles.splice(0)) { particle.sprite.removeFromParent?.(); particle.sprite.destroy?.(); }
    }
    this.type = type;
    this.ensureDimmer(weatherDimmerAlpha(power));
    while (this.particles.length < count) {
      const sprite = this.createSprite(this.textureFor(type));
      sprite.tint = 0xffffff;
      this.layer.addChild(sprite);
      this.particles.push({ sprite, ax: 0, ay: 0, opacity: 0 });
    }
    for (const particle of this.particles.splice(count)) { particle.sprite.removeFromParent?.(); particle.sprite.destroy?.(); }
    for (const particle of this.particles) particle.sprite.rotation = spec.rotation;
  }

  update(dt) {
    if (!this.particles.length) return;
    const spec = WEATHER[this.type];
    const steps = Math.min(4, Math.max(1, Math.round(dt * 60)));
    for (const particle of this.particles) {
      for (let step = 0; step < steps; step++) stepParticle(particle, spec, this.random, this.width, this.height);
      particle.sprite.x = particle.ax;
      particle.sprite.y = particle.ay;
      particle.sprite.alpha = particle.opacity / 255;
    }
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    if (this.dimmer) { this.dimmer.width = width; this.dimmer.height = height; }
  }

  clear() {
    for (const particle of this.particles) { particle.sprite.removeFromParent?.(); particle.sprite.destroy?.(); }
    this.particles = [];
    this.dimmer?.removeFromParent?.();
    this.dimmer?.destroy?.();
    this.dimmer = null;
    this.type = 'none';
  }

  textureFor(type) {
    if (!this.textures.has(type)) this.textures.set(type, this.createTexture(WEATHER[type]));
    return this.textures.get(type);
  }

  // The dimmer is a grey solid over the screen, added before any particle so it sits underneath them.
  ensureDimmer(alpha) {
    if (!this.dimmer) {
      if (!this.textures.has('dimmer')) this.textures.set('dimmer', this.createTexture({ width: 1, height: 1, circle: false }));
      this.dimmer = this.createSprite(this.textures.get('dimmer'));
      this.dimmer.tint = 0x505050;
      this.dimmer.width = this.width;
      this.dimmer.height = this.height;
      this.layer.addChild(this.dimmer);
    }
    this.dimmer.alpha = alpha;
  }
}
