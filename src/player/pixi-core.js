export async function startMwgPixi(canvas, project) {
  const mwg = globalThis.mw_games;
  if (!mwg?.Game || !mwg?.Scene2D || !mwg?.TileMap || !mwg?.SpriteSheet) throw new Error('mw_games 2D runtime is unavailable');
  const mapEntry = project.maps.find(map => map.id === Number(project.initialMapId)) || project.maps[0];
  const map = mapEntry?.data;
  if (!map) throw new Error('MWGP project has no map');
  const position = { ...(project.player || { x: 0, y: 0 }) };
  const tilesetFlags = project.tilesets?.[map.tilesetId]?.flags || [];
  const assetRoot = project.assets?.kind === 'decoded' ? project.assets.root : null;
  const tileset = project.tilesets?.[map.tilesetId];
  const names = tileset?.tilesetNames || [];
  const realSheets = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter(index => names[index]).map(index => ({ slot: index, url: `${assetRoot}/img/tilesets/${encodeURIComponent(names[index])}.png` }));
  const sheetEntries = assetRoot && realSheets.length ? realSheets : [{ slot: 5, url: placeholderSheet() }];
  const sheetUrls = sheetEntries.map(entry => entry.url);
  await mwg.Resources.load(sheetUrls);
  const sheets = await Promise.all(sheetEntries.map(entry => entry.slot < 4
    ? buildAutotileSheet(entry.url, entry.slot, mwg)
    : Promise.resolve(mwg.SpriteSheet.grid(entry.url, 48))));
  const playerUrl = project.assets?.characters && project.playerSprite?.name ? `${project.assets.root}/img/characters/${encodeURIComponent(project.playerSprite.name)}.png` : null;
  const eventNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.map(page => page.image?.name).filter(Boolean)))];
  const eventUrls = project.assets?.characters ? eventNames.map(name => `${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`) : [];
  const portraitNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPortraitNames(page.commands))))];
  const portraitUrls = project.assets?.faces ? portraitNames.map(name => `${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`) : [];
  const pictureNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPictureNames(page.commands))))];
  const pictureUrls = project.assets?.pictures ? pictureNames.map(name => `${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`) : [];
  const soundNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectSoundNames(page.commands))))];
  const soundUrls = project.assets?.audio ? soundNames.map(name => `${project.assets.root}/audio/se/${encodeURIComponent(name)}.ogg`) : [];
  if (playerUrl || eventUrls.length || portraitUrls.length || pictureUrls.length || soundUrls.length) await mwg.Resources.load([...(playerUrl ? [playerUrl] : []), ...eventUrls, ...portraitUrls, ...pictureUrls, ...soundUrls]);
  const playerSheet = playerUrl ? mwg.SpriteSheet.grid(playerUrl, 48) : null;
  const eventSheets = new Map(eventNames.map((name, index) => [name, mwg.SpriteSheet.grid(eventUrls[index], 48)]));
  const portraitSheets = new Map(portraitNames.map((name, index) => [name, mwg.SpriteSheet.grid(portraitUrls[index], 144)]));
  const pictureTextures = new Map(pictureNames.map((name, index) => [name, mwg.Resources.texture(pictureUrls[index])]));
  const sounds = project.assets?.audio ? new Map(soundNames.map((name, index) => [name, new mwg.Audio.Sound(soundUrls[index])])) : new Map();
  const music = assetRoot && project.assets?.audio && mwg.Audio?.Music ? new mwg.Audio.Music({ volume: 0.7 }) : null;
  const bgmPath = map.bgm?.name ? `${project.assets.root}/audio/bgm/${encodeURIComponent(map.bgm.name)}.ogg` : null;
  const layers = Array.from({ length: 6 }, (_, index) => rpgmLayer(map, index).map(tile => tileToFrame(tile, sheetEntries, mwg)));
  const game = new mwg.Game({ canvas, resizeTo: canvas.parentElement, background: 0x10131b, pixelArt: true });
  const PlayerScene = class extends mwg.Scene2D {
    create() {
      this.tileMap = new mwg.TileMap({ width: map.width, height: map.height, sheet: sheets, tileWidth: 48, tileHeight: 48 });
      layers.forEach((data, index) => this.tileMap.addLayer(`rpgm-${index}`, data));
      this.stage.addChild(this.tileMap);
      mwg.Input.attach();
      this.cooldown = 0;
      this.music = music;
      if (this.music && bgmPath && map.autoplayBgm !== false) this.music.play(bgmPath, 1);
      this.facing = 'down';
      this.gameState = new mwg.Rpg.GameState();
      this.saves = new mwg.SaveSystem({ namespace: `mwgp:${project.source?.projectName || 'project'}`, version: 1 });
      const transition = this.saves.load('runtime-transition');
      if (transition?.state?.rpg) {
        position.x = Number(transition.state.x ?? position.x);
        position.y = Number(transition.state.y ?? position.y);
        this.facing = transition.state.facing || 'down';
        this.gameState = mwg.Rpg.GameState.fromJSON(transition.state.rpg);
        this.saves.delete('runtime-transition');
      }
      this.eventSprites = [];
      for (const event of mapEntry?.mwgEvents || []) { const page = mwg.Rpg.activePage(event, this.gameState); const image = page?.image; const sheet = image && eventSheets.get(image.name); if (!sheet) continue; const sprite = new mwg.TintedSprite({ texture: sheet.get(characterFrame(sheet, image)) }); sprite.width = 48; sprite.height = 48; this.stage.addChild(sprite); this.eventSprites.push({ event, sprite }); }
      this.saveKey = event => { if (event.key === 'F5') { event.preventDefault(); this.saveGame(); } if (event.key === 'F9') { event.preventDefault(); this.loadGame(); } };
      window.addEventListener('keydown', this.saveKey);
      this.dialogue = null;
      this.eventQueue = Promise.resolve();
      this.eventRunning = false;
      this.parallelTimer = 0;
      this.windows = new mwg.WindowStack();
      this.stage.addChild(this.windows);
      this.windows.setViewport(game.width, game.height);
      this.player = playerSheet ? new mwg.AnimatedSprite() : new mwg.TintedSprite({ texture: mwg.Resources.texture(sheetUrls[0]) });
      if (playerSheet) addCharacterAnimations(this.player, playerSheet, project.playerSprite.index || 0);
      this.player.width = 48; this.player.height = 48; this.player.tint = 0xffffff;
      this.stage.addChild(this.player);
      this.pictureLayer = new mwg.Container2D();
      this.stage.addChild(this.pictureLayer);
      this.pictureSprites = new Map();
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: 48, tileHeight: 48, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
      this.pendingStep = null;
      this.updateCamera();
      this.runAutorunEvents();
    }
    update(dt) {
      this.windows.update(dt);
      this.music?.update(dt);
      if (this.dialogue) { mwg.Input.endFrame(); return; }
      this.parallelTimer -= dt;
      if (this.parallelTimer <= 0 && !this.eventRunning) { this.runParallelEvents(); this.parallelTimer = 0.25; }
      this.mover.update(dt);
      this.renderPosition = { x: this.player.x / 48, y: this.player.y / 48 };
      this.updateCamera();
      if (this.pendingStep && !this.mover.isMoving) { const [x, y] = this.pendingStep; position.x = x; position.y = y; this.pendingStep = null; this.runEventAt(x, y, 'touch'); }
      if (this.mover.isMoving) { mwg.Input.endFrame(); return; }
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        const direction = mwg.Input.isDown('up') ? [0, -1, 'up'] : mwg.Input.isDown('down') ? [0, 1, 'down'] : mwg.Input.isDown('left') ? [-1, 0, 'left'] : mwg.Input.isDown('right') ? [1, 0, 'right'] : null;
        if (direction) { const [dx, dy, facing] = direction; this.facing = facing; const x = this.mover.x + dx, y = this.mover.y + dy; if (this.canStep(x, y, dx, dy) && this.mover.moveBy(dx, dy)) this.pendingStep = [x, y]; else this.mover.turnTo(dx, dy); this.cooldown = 0.12; }
        if (mwg.Input.justPressed('confirm')) this.runEventAt(...this.targetCell(), 'action');
      }
      mwg.Input.endFrame();
    }
    updateCamera() {
      const scale = 48; const x = this.mover?.isMoving ? this.renderPosition.x : (this.mover?.x ?? position.x), y = this.mover?.isMoving ? this.renderPosition.y : (this.mover?.y ?? position.y); this.tileMap.x = game.width / 2 - x * scale - scale / 2; this.tileMap.y = game.height / 2 - y * scale - scale / 2;
      this.player.x = x * scale + this.tileMap.x + scale / 2; this.player.y = y * scale + this.tileMap.y + scale;
      for (const item of this.eventSprites || []) { item.sprite.x = item.event.x * scale + this.tileMap.x; item.sprite.y = item.event.y * scale + this.tileMap.y; }
    }
    resize(width, height) { this.windows.setViewport(width, height); this.updateCamera(); }
    targetCell() { const offsets = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }; const [dx, dy] = offsets[this.facing]; return [position.x + dx, position.y + dy, 'action']; }
    canStep(x, y, dx, dy) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      const size = map.width * map.height, bit = directionBit(dx, dy);
      for (let layer = 0; layer < 6; layer++) { const tile = map.data?.[layer * size + y * map.width + x] || 0; const flag = tilesetFlags[tile] ?? 0; if ((flag & 0x10) !== 0) continue; if ((flag & bit) === 0) return this.eventAllowsStep(x, y); }
      return false;
    }
    eventAllowsStep(x, y) {
      const event = mapEntry?.mwgEvents?.find(item => item && item.x === x && item.y === y);
      if (!event) return true;
      const page = mwg.Rpg.activePage(event, this.gameState);
      return !page || page.through === true;
    }
    runEventAt(x, y, trigger) {
      const event = mapEntry?.mwgEvents?.find(candidate => candidate.x === x && candidate.y === y);
      const page = event && mwg.Rpg.activePage(event, this.gameState);
      if (!page || page.trigger !== trigger || !page.commands.length) return;
      this.runPage(page);
    }
    runAutorunEvents() {
      for (const event of mapEntry?.mwgEvents || []) {
        const page = mwg.Rpg.activePage(event, this.gameState);
        if (page?.trigger === 'autorun' && page.commands.length) this.runPage(page);
      }
    }
    runParallelEvents() {
      for (const event of mapEntry?.mwgEvents || []) {
        const page = mwg.Rpg.activePage(event, this.gameState);
        if (page?.trigger === 'parallel' && page.commands.length) this.runPage(page);
      }
    }
    runPage(page) {
      const commands = prepareEventCommands(page.commands, this);
      this.eventQueue = this.eventQueue.then(() => { this.eventRunning = true; return new mwg.Rpg.EventRunner({ game: this.gameState, move: (target, steps) => this.runMoveRoute(target, steps), present: request => new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: 126, pages: [{ text: request.text, speaker: request.speaker }], choices: request.choices, dims: true, anchor: 'bottom', onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
        this.windows.push(box);
      }) }).run(commands); }).catch(error => console.error('MWGP event failed', error)).finally(() => { this.eventRunning = false; });
      return this.eventQueue;
    }
    async runMoveRoute(target, steps) {
      if (target !== 'player' || !this.mover) return;
      for (const step of steps || []) {
        if (!this.canStep(this.mover.x + step.dx, this.mover.y + step.dy, step.dx, step.dy)) continue;
        this.facing = step.dy > 0 ? 'down' : step.dy < 0 ? 'up' : step.dx < 0 ? 'left' : 'right';
        if (!this.mover.moveBy(step.dx, step.dy)) continue;
        await new Promise(resolve => {
          const check = () => this.mover.isMoving ? setTimeout(check, 16) : resolve();
          check();
        });
        position.x = this.mover.x;
        position.y = this.mover.y;
      }
    }
    turnPlayer(direction) {
      const vectors = { down: [0, 1], left: [-1, 0], right: [1, 0], up: [0, -1] };
      const vector = vectors[direction];
      if (vector) { this.facing = direction; this.mover?.turnTo(...vector); }
    }
    presentPortrait(command) {
      const sheet = portraitSheets.get(command.portrait.name);
      if (!sheet) return Promise.resolve();
      return new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: 150, pages: [{ text: command.say || command.ask || '', portrait: sheet.get(command.portrait.index), }], choices: command.choices, dims: true, anchor: 'bottom', onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
        this.windows.push(box);
      });
    }
    showPicture(picture) {
      const texture = pictureTextures.get(picture.name);
      if (!texture) return;
      this.pictureSprites.get(picture.id)?.destroy();
      const sprite = new mwg.TintedSprite({ texture });
      sprite.anchor?.set(picture.origin === 1 ? 0.5 : 0);
      sprite.x = picture.x; sprite.y = picture.y;
      sprite.scale.set(picture.scaleX / 100, picture.scaleY / 100);
      sprite.alpha = picture.opacity / 255;
      this.pictureLayer.addChild(sprite);
      this.pictureSprites.set(picture.id, sprite);
    }
    erasePicture(id) {
      const sprite = this.pictureSprites.get(id);
      if (!sprite) return;
      sprite.destroy();
      this.pictureSprites.delete(id);
    }
    playSound(sound) {
      sounds.get(sound.name)?.play(Math.max(0, Math.min(1, sound.volume / 100)));
    }
    transfer(target) {
      this.saves.save('runtime-transition', { mapId: target.mapId, x: target.x, y: target.y, facing: this.facing, rpg: this.gameState.toJSON() }, { mapId: target.mapId, x: target.x, y: target.y });
      const params = new URLSearchParams(location.search);
      params.set('map', String(target.mapId)); params.set('x', String(target.x)); params.set('y', String(target.y));
      location.href = `${location.pathname}?${params}`;
    }
    saveGame() { this.saves.save('slot-1', { mapId: mapEntry.id, x: this.mover.x, y: this.mover.y, facing: this.mover.facing, rpg: this.gameState.toJSON() }, { mapId: mapEntry.id, x: this.mover.x, y: this.mover.y }); }
    loadGame() {
      const saved = this.saves.load('slot-1');
      if (!saved || this.mover.isMoving) return false;
      if (Number(saved.state.mapId) !== Number(mapEntry.id)) {
        this.saves.save('runtime-transition', saved.state, { mapId: saved.state.mapId, x: saved.state.x, y: saved.state.y });
        const params = new URLSearchParams(location.search);
        params.set('map', String(saved.state.mapId)); params.set('x', String(saved.state.x)); params.set('y', String(saved.state.y));
        location.href = `${location.pathname}?${params}`;
        return true;
      }
      position.x = saved.state.x; position.y = saved.state.y; this.facing = saved.state.facing || 'down';
      this.gameState = mwg.Rpg.GameState.fromJSON(saved.state.rpg);
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: 48, tileHeight: 48, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
      this.updateCamera();
      return true;
    }
    teardown() { window.removeEventListener('keydown', this.saveKey); this.windows?.destroy(); }
  };
  await game.start(PlayerScene);
  return game;
}

function placeholderSheet() {
  const cells = Array.from({ length: 256 }, (_, i) => `<rect x="${i % 16 * 48}" y="${Math.floor(i / 16) * 48}" width="48" height="48" fill="hsl(${i * 47 % 360} 25% ${28 + i % 12}%)"/>`).join('');
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768">${cells}</svg>`)}`;
}

async function buildAutotileSheet(url, slot, mwg) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return mwg.SpriteSheet.grid(url, 48);
  const image = await new Promise((resolve, reject) => { const value = new Image(); value.onload = () => resolve(value); value.onerror = reject; value.src = url; });
  const count = [768, 1536, 1536, 2304][slot];
  const canvas = document.createElement('canvas');
  canvas.width = 16 * 48; canvas.height = Math.ceil(count / 16) * 48;
  const context = canvas.getContext('2d');
  const table = slot >= 2 ? WALL_AUTOTILE_TABLE : FLOOR_AUTOTILE_TABLE;
  const baseKind = [0, 16, 48, 80][slot];
  for (let offset = 0; offset < count; offset++) {
    const kind = baseKind + Math.floor(offset / 48);
    const shape = offset % 48;
    const tx = kind % 8;
    const ty = Math.floor(kind / 8);
    let bx, by;
    if (slot === 0) { bx = Math.floor(tx / 4) * 8; by = ty * 6 + Math.floor(tx / 2) % 2 * 3; }
    else if (slot === 1) { bx = tx * 2; by = (ty - 2) * 3; }
    else if (slot === 2) { bx = tx * 2; by = (ty - 6) * 2; }
    else { bx = tx * 2; by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0)); }
    const dx = offset % 16 * 48;
    const dy = Math.floor(offset / 16) * 48;
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const [qx, qy] = table[shape % table.length][quadrant];
      context.drawImage(image, (bx * 2 + qx) * 24, (by * 2 + qy) * 24, 24, 24, dx + quadrant % 2 * 24, dy + Math.floor(quadrant / 2) * 24, 24, 24);
    }
  }
  return mwg.SpriteSheet.fromTexture(mwg.Texture2D.from(canvas), 48);
}

function collectPortraitNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.portrait?.name) names.push(command.portrait.name);
    if (command.if) { names.push(...collectPortraitNames(command.then)); names.push(...collectPortraitNames(command.else)); }
  }
  return names;
}

function collectPictureNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.picture?.name) names.push(command.picture.name);
    if (command.if) { names.push(...collectPictureNames(command.then)); names.push(...collectPictureNames(command.else)); }
  }
  return names;
}

function collectSoundNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.sound?.name) names.push(command.sound.name);
    if (command.if) { names.push(...collectSoundNames(command.then)); names.push(...collectSoundNames(command.else)); }
  }
  return names;
}

function prepareEventCommands(commands, scene) {
  return (commands || []).map(command => {
    if (command.if) return { ...command, then: prepareEventCommands(command.then, scene), ...(command.else ? { else: prepareEventCommands(command.else, scene) } : {}) };
    if (command.transfer) return { call: () => scene.transfer(command.transfer) };
    if (command.picture) return { call: () => scene.showPicture(command.picture) };
    if (command.erasePicture !== undefined) return { call: () => scene.erasePicture(command.erasePicture) };
    if (command.sound) return { call: () => scene.playSound(command.sound) };
    if (command.turn) return { call: () => scene.turnPlayer(command.turn) };
    if (command.portrait && (command.say !== undefined || command.ask !== undefined)) return { call: () => scene.presentPortrait(command) };
    return command;
  });
}

const FLOOR_AUTOTILE_TABLE = [
  [[2,4],[1,4],[2,3],[1,3]],[[2,0],[1,4],[2,3],[1,3]],[[2,4],[3,0],[2,3],[1,3]],[[2,0],[3,0],[2,3],[1,3]],
  [[2,4],[1,4],[2,3],[3,1]],[[2,0],[1,4],[2,3],[3,1]],[[2,4],[3,0],[2,3],[3,1]],[[2,0],[3,0],[2,3],[3,1]],
  [[2,4],[1,4],[2,1],[1,3]],[[2,0],[1,4],[2,1],[1,3]],[[2,4],[3,0],[2,1],[1,3]],[[2,0],[3,0],[2,1],[1,3]],
  [[2,4],[1,4],[2,1],[3,1]],[[2,0],[1,4],[2,1],[3,1]],[[2,4],[3,0],[2,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],
  [[0,4],[1,4],[0,3],[1,3]],[[0,4],[3,0],[0,3],[1,3]],[[0,4],[1,4],[0,3],[3,1]],[[0,4],[3,0],[0,3],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[2,2],[1,2],[2,3],[3,1]],[[2,2],[1,2],[2,1],[1,3]],[[2,2],[1,2],[2,1],[3,1]],
  [[2,4],[3,4],[2,3],[3,3]],[[2,4],[3,4],[2,1],[3,3]],[[2,0],[3,4],[2,3],[3,3]],[[2,0],[3,4],[2,1],[3,3]],
  [[2,4],[1,4],[2,5],[1,5]],[[2,0],[1,4],[2,5],[1,5]],[[2,4],[3,0],[2,5],[1,5]],[[2,0],[3,0],[2,5],[1,5]],
  [[0,4],[3,4],[0,3],[3,3]],[[2,2],[1,2],[2,5],[1,5]],[[0,2],[1,2],[0,3],[1,3]],[[0,2],[1,2],[0,3],[3,1]],
  [[2,2],[3,2],[2,3],[3,3]],[[2,2],[3,2],[2,1],[3,3]],[[2,4],[3,4],[2,5],[3,5]],[[2,0],[3,4],[2,5],[3,5]],
  [[0,4],[1,4],[0,5],[1,5]],[[0,4],[3,0],[0,5],[1,5]],[[0,2],[3,2],[0,3],[3,3]],[[0,2],[1,2],[0,5],[1,5]],
  [[0,4],[3,4],[0,5],[3,5]],[[2,2],[3,2],[2,5],[3,5]],[[0,2],[3,2],[0,3],[3,5]],[[0,0],[1,0],[0,1],[1,1]]
];

const WALL_AUTOTILE_TABLE = [
  [[2,2],[1,2],[2,1],[1,1]],[[0,2],[1,2],[0,1],[1,1]],[[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,2],[3,2],[2,1],[3,1]],[[0,2],[3,2],[0,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[0,2],[1,2],[0,3],[1,3]],[[2,0],[1,0],[2,3],[1,3]],[[0,0],[1,0],[0,3],[1,3]],
  [[2,2],[3,2],[2,3],[3,3]],[[0,2],[3,2],[0,3],[3,3]],[[2,0],[3,0],[2,3],[3,3]],[[0,0],[3,0],[0,3],[3,3]]
];

function flattenRpgmLayers(map) {
  const size = map.width * map.height;
  return Array.from({ length: size }, (_, index) => {
    for (let layer = 5; layer >= 0; layer--) if (map.data?.[layer * size + index]) return map.data[layer * size + index];
    return 0;
  });
}

function rpgmLayer(map, layer) {
  const size = map.width * map.height;
  return Array.from({ length: size }, (_, index) => map.data?.[layer * size + index] || 0);
}

function tileToFrame(tile, sheetEntries, mwg) {
  if (!tile) return mwg.EMPTY;
  const slot = tile >= 2048 && tile < 2816 ? 0 : tile >= 2816 && tile < 4352 ? 1 : tile >= 4352 && tile < 5888 ? 2 : tile >= 5888 && tile < 8192 ? 3 : tile >= 1536 && tile < 1664 ? 4 : tile < 256 ? 5 : tile < 512 ? 6 : tile < 768 ? 7 : tile < 1024 ? 8 : -1;
  const sheet = sheetEntries.findIndex(entry => entry.slot === slot);
  if (sheet < 0) return mwg.EMPTY;
  const base = slot === 0 ? 2048 : slot === 1 ? 2816 : slot === 2 ? 4352 : slot === 3 ? 5888 : slot === 4 ? 1536 : slot === 5 ? 0 : slot === 6 ? 256 : slot === 7 ? 512 : 768;
  return mwg.tileFrame(sheet, tile - base);
}

function addCharacterAnimations(sprite, sheet, characterIndex) {
  const stride = sheet.columns === 3 ? 3 : 12;
  const base = sheet.columns === 3 ? 0 : characterIndex * 3;
  const rows = { down: 0, left: 1, right: 2, up: 3 };
  for (const [direction, row] of Object.entries(rows)) {
    const first = base + row * stride;
    sprite.add(`idle-${direction}`, [sheet.get(first + 1)], { fps: 1 });
    sprite.add(`walk-${direction}`, [sheet.get(first), sheet.get(first + 1), sheet.get(first + 2)], { fps: 8 });
  }
  sprite.play('idle-down');
}

function characterFrame(sheet, image) {
  const stride = sheet.columns === 3 ? 3 : 12;
  const base = sheet.columns === 3 ? 0 : image.index * 3;
  const row = { 2: 0, 4: 1, 6: 2, 8: 3 }[image.direction] ?? 0;
  return base + row * stride + Math.min(2, image.pattern ?? 1);
}

function directionBit(dx, dy) {
  if (dy > 0) return 0x01;
  if (dx < 0) return 0x02;
  if (dx > 0) return 0x04;
  return 0x08;
}
