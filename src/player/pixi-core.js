export async function startMwgPixi(canvas, project) {
  const mwg = globalThis.mw_games;
  if (!mwg?.Game || !mwg?.Scene2D || !mwg?.TileMap || !mwg?.SpriteSheet) throw new Error('mw_games 2D runtime is unavailable');
  const mapEntry = project.maps.find(map => map.id === Number(project.initialMapId)) || project.maps[0];
  const map = mapEntry?.data;
  const tileSize = project.display?.tileSize || 48;
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
    : Promise.resolve(mwg.SpriteSheet.grid(entry.url, tileSize))));
  const playerUrl = project.assets?.characters && project.playerSprite?.name ? `${project.assets.root}/img/characters/${encodeURIComponent(project.playerSprite.name)}.png` : null;
  const eventNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.map(page => page.image?.name).filter(Boolean)))];
  const eventUrls = project.assets?.characters ? eventNames.map(name => `${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`) : [];
  const portraitNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPortraitNames(page.commands))))];
  const portraitUrls = project.assets?.faces ? portraitNames.map(name => `${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`) : [];
  const pictureNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPictureNames(page.commands))))];
  const pictureUrls = project.assets?.pictures ? pictureNames.map(name => `${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`) : [];
  const soundNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectSoundNames(page.commands))))];
  const soundUrls = project.assets?.audio ? soundNames.map(name => `${project.assets.root}/audio/se/${encodeURIComponent(name)}.ogg`) : [];
  const optionalUrls = [...new Set([...(playerUrl ? [playerUrl] : []), ...eventUrls, ...portraitUrls, ...pictureUrls, ...soundUrls])];
  // A project can reference an optional/plugin-generated image that is absent
  // from the distributed archive. Load each asset independently so one stale
  // reference does not discard the complete Pixi renderer.
  const loadResults = await Promise.allSettled(optionalUrls.map(url => mwg.Resources.load([url])));
  const loadedUrls = new Set(optionalUrls.filter((_, index) => loadResults[index].status === 'fulfilled'));
  const playerSheet = playerUrl && loadedUrls.has(playerUrl) ? mwg.SpriteSheet.grid(playerUrl, tileSize) : null;
  const eventSheets = new Map(project.assets?.characters ? eventNames.filter((_, index) => loadedUrls.has(eventUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`, tileSize)]) : []);
  const portraitSheets = new Map(project.assets?.faces ? portraitNames.filter((_, index) => loadedUrls.has(portraitUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`, 144)]) : []);
  const pictureTextures = new Map(project.assets?.pictures ? pictureNames.filter((_, index) => loadedUrls.has(pictureUrls[index])).map(name => [name, mwg.Resources.texture(`${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`)]) : []);
  const sounds = project.assets?.audio ? new Map(soundNames.filter((_, index) => loadedUrls.has(soundUrls[index])).map(name => [name, new mwg.Audio.Sound(`${project.assets.root}/audio/se/${encodeURIComponent(name)}.ogg`)])) : new Map();
  const music = assetRoot && project.assets?.audio && mwg.Audio?.Music ? new mwg.Audio.Music({ volume: 0.7 }) : null;
  const bgmPath = map.bgm?.name ? `${project.assets.root}/audio/bgm/${encodeURIComponent(map.bgm.name)}.ogg` : null;
  const layers = Array.from({ length: 6 }, (_, index) => rpgmLayer(map, index).map(tile => tileToFrame(tile, sheetEntries, sheets, mwg, project.source?.engine === 'rpg-maker-xp')));
  const game = new mwg.Game({ canvas, resizeTo: canvas.parentElement, background: 0x10131b, pixelArt: true });
  const PlayerScene = class extends mwg.Scene2D {
    create() {
      this.tileMap = new mwg.TileMap({ width: map.width, height: map.height, sheet: sheets, tileWidth: tileSize, tileHeight: tileSize });
      layers.forEach((data, index) => this.tileMap.addLayer(`rpgm-${index}`, data));
      this.stage.addChild(this.tileMap);
      // Placed directly above the map, below every sprite/window layer added further down,
      // so a fade or flash washes the world without obscuring dialogue text on top of it.
      this.screenEffects = mwg.ScreenEffects ? new mwg.ScreenEffects({ width: game.width, height: game.height }) : null;
      if (this.screenEffects) this.stage.addChild(this.screenEffects);
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
      for (const event of mapEntry?.mwgEvents || []) { const page = mwg.Rpg.activePage(event, this.gameState); const image = page?.image; const sheet = image && eventSheets.get(image.name); if (!sheet) continue; const sprite = new mwg.TintedSprite({ texture: sheet.get(characterFrame(sheet, image)) }); sprite.width = tileSize; sprite.height = tileSize; this.stage.addChild(sprite); this.eventSprites.push({ event, sprite }); }
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
      this.player.width = tileSize; this.player.height = tileSize; this.player.tint = 0xffffff;
      this.stage.addChild(this.player);
      this.pictureLayer = new mwg.Container2D();
      this.stage.addChild(this.pictureLayer);
      this.pictureSprites = new Map();
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: tileSize, tileHeight: tileSize, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
      this.pendingStep = null;
      this.updateCamera();
      this.runAutorunEvents();
    }
    update(dt) {
      this.windows.update(dt);
      this.music?.update(dt);
      this.screenEffects?.update(dt);
      if (this.dialogue) return;
      this.parallelTimer -= dt;
      if (this.parallelTimer <= 0 && !this.eventRunning) { this.runParallelEvents(); this.parallelTimer = 0.25; }
      this.mover.update(dt);
      this.renderPosition = { x: this.player.x / tileSize, y: this.player.y / tileSize };
      this.updateCamera();
      if (this.pendingStep && !this.mover.isMoving) { const [x, y] = this.pendingStep; position.x = x; position.y = y; this.pendingStep = null; this.runEventAt(x, y, 'touch'); }
      if (this.mover.isMoving) return;
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        const direction = mwg.Input.isDown('up') ? [0, -1, 'up'] : mwg.Input.isDown('down') ? [0, 1, 'down'] : mwg.Input.isDown('left') ? [-1, 0, 'left'] : mwg.Input.isDown('right') ? [1, 0, 'right'] : null;
        if (direction) { const [dx, dy, facing] = direction; this.facing = facing; const x = this.mover.x + dx, y = this.mover.y + dy; if (this.canStep(x, y, dx, dy) && this.mover.moveBy(dx, dy)) this.pendingStep = [x, y]; else this.mover.turnTo(dx, dy); this.cooldown = 0.12; }
        if (mwg.Input.justPressed('confirm')) this.runEventAt(...this.targetCell(), 'action');
      }
    }
    updateCamera() {
      const scale = tileSize; const x = this.mover?.isMoving ? this.renderPosition.x : (this.mover?.x ?? position.x), y = this.mover?.isMoving ? this.renderPosition.y : (this.mover?.y ?? position.y); this.tileMap.x = game.width / 2 - x * scale - scale / 2; this.tileMap.y = game.height / 2 - y * scale - scale / 2;
      this.player.x = x * scale + this.tileMap.x + scale / 2; this.player.y = y * scale + this.tileMap.y + scale;
      for (const item of this.eventSprites || []) { item.sprite.x = item.event.x * scale + this.tileMap.x; item.sprite.y = item.event.y * scale + this.tileMap.y; }
    }
    resize(width, height) { this.windows.setViewport(width, height); this.screenEffects?.setViewport(width, height); this.updateCamera(); }
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
      if (!page) return true;
      if (page.through === true) return true;
      // MV passability: only "Same as characters" (priorityType 1) blocks movement.
      // "Below" (0) and "Above" (2) never block; Through overrides everything.
      // Missing priorityType defaults to 1, preserving old manifests' blocking behaviour.
      return (page.priorityType ?? 1) !== 1;
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
      this.eventQueue = this.eventQueue.then(() => { this.eventRunning = true; return this.runBranch(commands); })
        // Exit Event Processing / Break Loop unwind via a thrown sentinel rather than a
        // return value, since EventRunner.run() offers no other way to stop mid-list; that
        // is expected control flow, not a failure, so only a genuine error is logged.
        .catch(error => { if (!(error instanceof ExitEventSignal) && !(error instanceof BreakLoopSignal)) console.error('MWGP event failed', error); })
        .finally(() => { this.eventRunning = false; });
      return this.eventQueue;
    }
    presentDialogue(request) {
      return new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: 126, pages: [{ text: request.text, speaker: request.speaker }], choices: request.choices, dims: true, anchor: 'bottom', onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
        this.windows.push(box);
      });
    }
    runBranch(commands) {
      if (!commands?.length) return Promise.resolve();
      return new mwg.Rpg.EventRunner({ game: this.gameState, move: (target, steps) => this.runMoveRoute(target, steps), present: request => this.presentDialogue(request) }).run(commands);
    }
    presentChoice(command) {
      const sheet = command.portrait ? portraitSheets.get(command.portrait.name) : null;
      return new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: sheet ? 150 : 126, pages: [{ text: command.ask || '', portrait: sheet ? sheet.get(command.portrait.index) : undefined }], choices: command.choices, dims: true, anchor: 'bottom', onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
        this.windows.push(box);
      }).then(chosen => this.runBranch((command.branches || [])[Number(chosen)]));
    }
    async runLoop(body) {
      // MV loops are unbounded unless a Break Loop fires; the cap only guards against a
      // malformed/never-breaking loop freezing the tab, it is not gameplay-visible.
      for (let iteration = 0; iteration < 100000; iteration++) {
        try {
          await this.runBranch(body);
        } catch (error) {
          if (error instanceof BreakLoopSignal) return;
          throw error;
        }
      }
      console.warn('MWGP loop exceeded 100000 iterations without a Break Loop; stopping it');
    }
    copyVariable(state, command) {
      const value = command.random
        ? Math.floor(Math.random() * (command.random[1] - command.random[0] + 1)) + command.random[0]
        : state.game.variable(command.variable);
      state.game.setVariable(command.copyVariable, value);
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
    screenFade({ direction, duration }) {
      if (!this.screenEffects) return Promise.resolve();
      if (direction === 'out') this.screenEffects.fadeOut(duration, 0x000000);
      else this.screenEffects.fadeIn(duration, 0x000000);
      // MV always blocks the event until a screen fade completes.
      return new Promise(resolve => setTimeout(resolve, duration * 1000));
    }
    screenFlash({ color, peak, duration, wait }) {
      if (!this.screenEffects) return Promise.resolve();
      this.screenEffects.flash(duration, color, peak);
      return wait ? new Promise(resolve => setTimeout(resolve, duration * 1000)) : Promise.resolve();
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
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: tileSize, tileHeight: tileSize, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
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
  for (let offset = 0; offset < count; offset++) {
    const kind = [0, 16, 48, 80][slot] + Math.floor(offset / 48);
    const shape = offset % 48;
    const tx = kind % 8;
    const ty = Math.floor(kind / 8);
    let bx, by;
    if (slot === 0) { bx = Math.floor(tx / 4) * 8; by = ty * 6 + Math.floor(tx / 2) % 2 * 3; }
    else if (slot === 1) { bx = tx * 2; by = (ty - 2) * 3; }
    else if (slot === 2) { bx = tx * 2; by = (ty - 6) * 2; }
    else { bx = tx * 2; by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0)); }
    const dx = offset % 16 * 48, dy = Math.floor(offset / 16) * 48;
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const [qx, qy] = table[shape % table.length][quadrant];
      context.drawImage(image, (bx * 2 + qx) * 24, (by * 2 + qy) * 24, 24, 24, dx + quadrant % 2 * 24, dy + Math.floor(quadrant / 2) * 24, 24, 24);
    }
  }
  return mwg.SpriteSheet.fromTexture(mwg.Texture2D.from(canvas), 48);
}

// Every place a command can contain nested command arrays — if/else branches, a loop body,
// or a Show Choices command's per-choice/cancel branches — so asset collectors and
// prepareEventCommands only need to know this shape once.
function childBlocks(command) {
  return [command.then, command.else, command.loop, ...(command.branches || []), command.cancelBranch].filter(Boolean);
}

function collectPortraitNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.portrait?.name) names.push(command.portrait.name);
    for (const block of childBlocks(command)) names.push(...collectPortraitNames(block));
  }
  return names;
}

function collectPictureNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.picture?.name) names.push(command.picture.name);
    for (const block of childBlocks(command)) names.push(...collectPictureNames(block));
  }
  return names;
}

function collectSoundNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.sound?.name) names.push(command.sound.name);
    for (const block of childBlocks(command)) names.push(...collectSoundNames(block));
  }
  return names;
}

class BreakLoopSignal extends Error {}
class ExitEventSignal extends Error {}

function prepareEventCommands(commands, scene) {
  return (commands || []).map(command => {
    if (command.if) return { ...command, then: prepareEventCommands(command.then, scene), ...(command.else ? { else: prepareEventCommands(command.else, scene) } : {}) };
    if (command.loop) return { call: () => scene.runLoop(prepareEventCommands(command.loop, scene)) };
    if (command.breakLoop) return { call: () => { throw new BreakLoopSignal(); } };
    if (command.exitEvent) return { call: () => { throw new ExitEventSignal(); } };
    if (command.copyVariable !== undefined) return { call: state => scene.copyVariable(state, command) };
    if (command.branches) return { call: () => scene.presentChoice({ ...command, branches: command.branches.map(branch => prepareEventCommands(branch, scene)), cancelBranch: command.cancelBranch && prepareEventCommands(command.cancelBranch, scene) }) };
    if (command.transfer) return { call: () => scene.transfer(command.transfer) };
    if (command.picture) return { call: () => scene.showPicture(command.picture) };
    if (command.erasePicture !== undefined) return { call: () => scene.erasePicture(command.erasePicture) };
    if (command.sound) return { call: () => scene.playSound(command.sound) };
    if (command.screenFade) return { call: () => scene.screenFade(command.screenFade) };
    if (command.screenFlash) return { call: () => scene.screenFlash(command.screenFlash) };
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

function tileToFrame(tile, sheetEntries, sheets, mwg, isXp = false) {
  if (!tile) return mwg.EMPTY;
  if (isXp) {
    const sheet = sheetEntries.findIndex(entry => entry.slot === 5);
    return sheet < 0 ? mwg.EMPTY : safeTileFrame(mwg, sheet, Math.max(0, tile - 384), sheets);
  }
  const slot = tile >= 2048 && tile < 2816 ? 0 : tile >= 2816 && tile < 4352 ? 1 : tile >= 4352 && tile < 5888 ? 2 : tile >= 5888 && tile < 8192 ? 3 : tile >= 1536 && tile < 1664 ? 4 : tile < 256 ? 5 : tile < 512 ? 6 : tile < 768 ? 7 : tile < 1024 ? 8 : -1;
  const sheet = sheetEntries.findIndex(entry => entry.slot === slot);
  if (sheet < 0) return mwg.EMPTY;
  const base = slot === 0 ? 2048 : slot === 1 ? 2816 : slot === 2 ? 4352 : slot === 3 ? 5888 : slot === 4 ? 1536 : slot === 5 ? 0 : slot === 6 ? 256 : slot === 7 ? 512 : 768;
  return safeTileFrame(mwg, sheet, tile - base, sheets);
}

function safeTileFrame(mwg, sheet, frame, sheets) {
  try { return mwg.tileFrame(sheet, frame); }
  catch { return mwg.EMPTY; }
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
