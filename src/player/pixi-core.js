export async function startMwgPixi(canvas, project) {
  const mwg = globalThis.mw_games;
  if (!mwg?.Game || !mwg?.Scene2D || !mwg?.TileMap || !mwg?.SpriteSheet) throw new Error('mw_games 2D runtime is unavailable');
  const mapEntry = project.maps.find(map => map.id === Number(project.initialMapId)) || project.maps[0];
  const map = mapEntry?.data;
  const tileSize = project.display?.tileSize || 48;
  const isXp = project.source?.engine === 'rpg-maker-xp';
  const xpFormat = project.tilesetFormat;
  const xpStaticBase = isXp ? Number(xpFormat?.staticTileBase) : 0;
  if (isXp && (!Number.isInteger(xpStaticBase) || xpStaticBase <= 0)) {
    throw new Error('XP MWGP project is missing a valid tilesetFormat.staticTileBase');
  }
  if (!map) throw new Error('MWGP project has no map');
  const position = { ...(project.player || { x: 0, y: 0 }) };
  const tilesetFlags = project.tilesets?.[map.tilesetId]?.flags || [];
  const assetRoot = project.assets?.kind === 'decoded' ? project.assets.root : null;
  const tileset = project.tilesets?.[map.tilesetId];
  const names = tileset?.tilesetNames || [];
  const realSheets = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter(index => names[index]).map(index => ({ slot: index, url: `${assetRoot}/img/tilesets/${encodeURIComponent(names[index])}.png` }));
  const sheetEntries = assetRoot && realSheets.length ? realSheets : [{ slot: 5, url: placeholderSheet() }];
  const xpAutotileEntries = isXp && assetRoot ? (tileset?.autotileNames || []).map((name, index) => name ? { index, url: `${assetRoot}/graphics/Autotiles/${encodeURIComponent(name)}.png` } : null).filter(Boolean) : [];
  const sheetUrls = sheetEntries.map(entry => entry.url);
  // Construct Game before creating/loading any textures. MWG's pixelArt option
  // sets Pixi's default atlas sampling to nearest-neighbour; doing this after
  // Resources.load() leaves already-created frames with linear filtering and
  // can expose one-pixel seams at tile boundaries.
  const game = new mwg.Game({ canvas, resizeTo: canvas.parentElement, background: 0x10131b, pixelArt: true });
  await mwg.Resources.load(sheetUrls);
  const sheets = await Promise.all(sheetEntries.map(entry => entry.slot < 4
    ? buildAutotileSheet(entry.url, entry.slot, mwg, tilesetFlags)
    : Promise.resolve(mwg.SpriteSheet.grid(entry.url, tileSize))));
  const xpAutotileUrls = xpAutotileEntries.map(entry => entry.url);
  const xpAutotileResults = isXp ? await Promise.allSettled(xpAutotileUrls.map(url => mwg.Resources.load([url]))) : [];
  const xpAutotileSheets = isXp ? xpAutotileEntries.filter((_, index) => xpAutotileResults[index]?.status === 'fulfilled').map(entry => ({ ...entry, sheet: mwg.SpriteSheet.grid(entry.url, 16) })) : [];
  const playerUrl = project.assets?.characters && project.playerSprite?.name ? `${project.assets.root}/img/characters/${encodeURIComponent(project.playerSprite.name)}.png` : null;
  const eventNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.map(page => page.image?.name).filter(Boolean)))];
  const eventUrls = project.assets?.characters ? eventNames.map(name => `${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`) : [];
  const portraitNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPortraitNames(page.commands))))];
  const portraitUrls = project.assets?.faces ? portraitNames.map(name => `${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`) : [];
  const pictureNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPictureNames(page.commands))))];
  const pictureUrls = project.assets?.pictures ? pictureNames.map(name => `${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`) : [];
  const soundNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectSoundNames(page.commands))))];
  const soundUrls = project.assets?.audio ? soundNames.map(name => `${project.assets.root}/audio/se/${encodeURIComponent(name)}.ogg`) : [];
  const musicNames = [...new Map((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectMusicNames(page.commands))).map(entry => [`${entry.dir}/${entry.name}`, entry])).values()];
  const musicUrls = project.assets?.audio ? musicNames.map(({ dir, name }) => `${project.assets.root}/audio/${dir}/${encodeURIComponent(name)}.ogg`) : [];
  const mapSettings = map.settings || {};
  const initialPanoramaUrl = isXp && assetRoot && mapSettings.panoramaName ? `${assetRoot}/graphics/Panoramas/${encodeURIComponent(mapSettings.panoramaName)}.png` : null;
  const initialFogUrl = isXp && assetRoot && mapSettings.fogName ? `${assetRoot}/graphics/Fogs/${encodeURIComponent(mapSettings.fogName)}.png` : null;
  const balloonUrl = project.assets?.system ? `${project.assets.root}/img/system/Balloon.png` : null;
  const animationSheetNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectAnimationSheetNames(page.commands, project.database?.animations))))];
  const animationUrls = project.assets?.animations ? animationSheetNames.map(name => `${project.assets.root}/img/animations/${encodeURIComponent(name)}.png`) : [];
  const meNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectMeNames(page.commands))))];
  const meUrls = project.assets?.audio ? meNames.map(name => `${project.assets.root}/audio/me/${encodeURIComponent(name)}.ogg`) : [];
  const optionalUrls = [...new Set([...(playerUrl ? [playerUrl] : []), ...eventUrls, ...portraitUrls, ...pictureUrls, ...soundUrls, ...musicUrls, ...meUrls, ...(balloonUrl ? [balloonUrl] : []), ...animationUrls, ...(initialPanoramaUrl ? [initialPanoramaUrl] : []), ...(initialFogUrl ? [initialFogUrl] : [])])];
  // A project can reference an optional/plugin-generated image that is absent
  // from the distributed archive. Load each asset independently so one stale
  // reference does not discard the complete Pixi renderer.
  const loadResults = await Promise.allSettled(optionalUrls.map(url => mwg.Resources.load([url])));
  const loadedUrls = new Set(optionalUrls.filter((_, index) => loadResults[index].status === 'fulfilled'));
  // Character sheets are sliced by the converter-measured frame geometry
  // (manifest characterFrames), never by assuming 48px cells: the engine's
  // own rule divides the bitmap by a $-prefix 3x4 grid or a standard 12x8 one.
  const playerGeom = characterGeometry(project.playerSprite?.name, project.characterFrames?.[project.playerSprite?.name]);
  const playerSheet = playerUrl && loadedUrls.has(playerUrl) ? mwg.SpriteSheet.grid(playerUrl, playerGeom.fw, playerGeom.fh) : null;
  const eventGeoms = new Map(project.assets?.characters ? eventNames.map(name => [name, characterGeometry(name, project.characterFrames?.[name])]) : []);
  const eventSheets = new Map(project.assets?.characters ? eventNames.filter((_, index) => loadedUrls.has(eventUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`, eventGeoms.get(name).fw, eventGeoms.get(name).fh)]) : []);
  const portraitSheets = new Map(project.assets?.faces ? portraitNames.filter((_, index) => loadedUrls.has(portraitUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`, 144)]) : []);
  const pictureTextures = new Map(project.assets?.pictures ? pictureNames.filter((_, index) => loadedUrls.has(pictureUrls[index])).map(name => [name, mwg.Resources.texture(`${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`)]) : []);
  const sounds = project.assets?.audio ? new Map(soundNames.filter((_, index) => loadedUrls.has(soundUrls[index])).map(name => [name, new mwg.Audio.Sound(`${project.assets.root}/audio/se/${encodeURIComponent(name)}.ogg`)])) : new Map();
  const meSounds = project.assets?.audio ? new Map(meNames.filter((_, index) => loadedUrls.has(meUrls[index])).map(name => [name, new mwg.Audio.Sound(`${project.assets.root}/audio/me/${encodeURIComponent(name)}.ogg`)])) : new Map();
  // Balloon.png is an 8-column strip per balloon row (48px cells, 15 rows);
  // animation sheets are 192px cells. Both verified against project data.
  const balloonSheet = balloonUrl && loadedUrls.has(balloonUrl) ? mwg.SpriteSheet.grid(balloonUrl, 48) : null;
  const animationSheets = new Map(project.assets?.animations ? animationSheetNames.filter((_, index) => loadedUrls.has(animationUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/animations/${encodeURIComponent(name)}.png`, 192)]) : []);
  const music = assetRoot && project.assets?.audio && mwg.Audio?.Music ? new mwg.Audio.Music({ volume: 0.7 }) : null;
  const loadedMusic = new Set(project.assets?.audio ? musicNames.filter((_, index) => loadedUrls.has(musicUrls[index])).map(({ dir, name }) => `${dir}/${name}`) : []);
  // A second music channel for background ambience (BGS): mw_games models one
  // crossfading music stream, and MV's BGM/BGS are two independent streams.
  const ambience = assetRoot && project.assets?.audio && mwg.Audio?.Music ? new mwg.Audio.Music({ volume: 0.7 }) : null;
  const bgmPath = map.bgm?.name ? `${project.assets.root}/audio/bgm/${encodeURIComponent(map.bgm.name)}.ogg` : null;
  // Only layers 0-3 hold tiles. Layer 4 is shadow bits (the engine draws them
  // as translucent quads, not tile frames) and layer 5 is region IDs
  // (Game_Map.regionId reads tileId(x, y, 5)); mapping either through
  // tileToFrame would render tileset-B frames in their place.
  // RPG Maker's star tiles are drawn in the upper tilemap layer, above the
  // player and events. XP stores the same notion as a numeric priority table.
  // Keep every source layer in the base map: a star tile can still be part of
  // the composed ground image, and removing it per-layer loses the lower half
  // of some roofs/trees when another layer occupies the same cell. The upper
  // pass is a second, sparse map containing only the effective (top-most)
  // tile at each cell, matching RPG Maker's priority resolution.
  const isAboveTile = tile => isXp
    ? Number(tileset?.priorities?.[tile] ?? 0) >= 2
    : (Number(tilesetFlags[tile] ?? 0) & 0x10) !== 0;
  const layers = Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => isXp && isAboveTile(tile) ? mwg.EMPTY : tileToFrame(tile, sheetEntries, sheets, mwg, isXp, tilesetFlags, xpStaticBase)));
  const xpAutotileLayers = isXp ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => tile > 0 && tile < xpStaticBase && !isAboveTile(tile) ? tile : mwg.EMPTY)) : [];
  const effectiveTiles = Array.from({ length: map.width * map.height }, (_, cell) => {
    for (let layer = 3; layer >= 0; layer--) {
      const tile = Number(map.data?.[layer * map.width * map.height + cell] || 0);
      if (tile) return tile;
    }
    return 0;
  });
  const aboveLayers = isXp
    ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => isAboveTile(tile) ? tileToFrame(tile, sheetEntries, sheets, mwg, isXp, tilesetFlags, xpStaticBase) : mwg.EMPTY))
    : [effectiveTiles.map(tile => isAboveTile(tile) ? tileToFrame(tile, sheetEntries, sheets, mwg, isXp, tilesetFlags, xpStaticBase) : mwg.EMPTY)];
  const xpAboveAutotileLayers = isXp ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => tile > 0 && tile < xpStaticBase && isAboveTile(tile) ? tile : mwg.EMPTY)) : [];
  const PlayerScene = class extends mwg.Scene2D {
    create() {
      this.tileMap = new mwg.TileMap({ width: map.width, height: map.height, sheet: sheets, tileWidth: tileSize, tileHeight: tileSize });
      this.panorama = initialPanoramaUrl && loadedUrls.has(initialPanoramaUrl) && mwg.TiledSprite ? new mwg.TiledSprite({ texture: mwg.Resources.texture(initialPanoramaUrl), width: game.width, height: game.height }) : null;
      if (this.panorama) this.stage.addChild(this.panorama);
      // MWG's Camera applies the world transform on whole screen pixels. This
      // avoids fractional camera translations (and the resulting seams or
      // shimmer) when a tile map is displayed at a browser/device scale.
      this.camera = mwg.Camera ? new mwg.Camera({ zoom: 1, pixelPerfectTileSize: tileSize }) : null;
      if (this.camera) {
        this.camera.setViewport(game.width, game.height);
        // Match RPG Maker's edge-clamped display position: a player near the
        // map edge must not reveal empty space outside the map rectangle.
        this.camera.setBounds({ minX: 0, minY: 0, maxX: map.width * tileSize, maxY: map.height * tileSize });
        this.stage.addChild(this.camera.world);
      }
      const world = this.camera?.world || this.stage;
      layers.forEach((data, index) => {
        this.tileMap.addLayer(`rpgm-${index}`, data);
        if (isXp && xpAutotileSheets.length) this.tileMap.addAutotileLayer(`rpgm-xp-${index}`, xpAutotileLayers[index], xpAutotileSheets.map(entry => ({ sheet: entry.sheet, format: 'rpgm-xp', index: entry.index })));
      });
      world.addChild(this.tileMap);
      this.aboveMap = new mwg.TileMap({ width: map.width, height: map.height, sheet: sheets, tileWidth: tileSize, tileHeight: tileSize });
      aboveLayers.forEach((data, index) => {
        this.aboveMap.addLayer(`rpgm-above-${index}`, data);
        if (isXp && xpAutotileSheets.length) this.aboveMap.addAutotileLayer(`rpgm-xp-above-${index}`, xpAboveAutotileLayers[index], xpAutotileSheets.map(entry => ({ sheet: entry.sheet, format: 'rpgm-xp', index: entry.index })));
      });
      this.fog = initialFogUrl && loadedUrls.has(initialFogUrl) && mwg.TiledSprite ? new mwg.TiledSprite({ texture: mwg.Resources.texture(initialFogUrl), width: game.width, height: game.height }) : null;
      if (this.fog) { this.fog.alpha = Math.max(0, Math.min(1, Number(mapSettings.fogOpacity ?? 0) / 255)); this.stage.addChild(this.fog); }
      // Placed directly above the map, below every sprite/window layer added further down,
      // so a fade or flash washes the world without obscuring dialogue text on top of it.
      this.screenEffects = mwg.ScreenEffects ? new mwg.ScreenEffects({ width: game.width, height: game.height }) : null;
      if (this.screenEffects) this.stage.addChild(this.screenEffects);
      mwg.Input.attach();
      this.cooldown = 0;
      this.messageOptions = { position: 2, frame: 0 };
      this.music = music;
      this.ambience = ambience;
      // MV Scroll Map pans belong to the map: a transfer rebuilds the scene
      // and resets them, matching MV where scrolling does not survive a move.
      this.cameraPan = { x: 0, y: 0 };
      this.panTween = null;
      this.savedBgm = null;
      this.bgmTrack = null;
      if (this.music && bgmPath && map.autoplayBgm !== false) {
        this.music.play(bgmPath, 1);
        this.bgmTrack = { kind: 'bgm', name: map.bgm?.name, volume: Number(map.bgm?.volume ?? 90) };
      }
      this.facing = 'down';
      this.gameState = new mwg.Rpg.GameState();
      // Party, inventory and gold have no home in mw_games' GameState (switches
      // and variables only), so the player carries them alongside it and saves
      // them through the same transfer/save payloads below.
      this.rpgExtra = freshExtraState();
      this.erasedEvents = new Set();
      this.currentEvent = null;
      this.shake = null;
      this.saves = new mwg.SaveSystem({ namespace: `mwgp:${project.source?.projectName || 'project'}`, version: 1 });
      const transition = this.saves.load('runtime-transition');
      if (transition?.state?.rpg) {
        position.x = Number(transition.state.x ?? position.x);
        position.y = Number(transition.state.y ?? position.y);
        this.facing = transition.state.facing || 'down';
        this.gameState = mwg.Rpg.GameState.fromJSON(transition.state.rpg);
        if (transition.state.extra) this.rpgExtra = { ...freshExtraState(), ...transition.state.extra };
        this.saves.delete('runtime-transition');
      }
      this.eventSprites = [];
      // Sprites render at their sheet's natural cell size (scaled to the tile
      // grid), feet-anchored like the engine: Sprite_Character centers x on
      // the tile and puts the sprite bottom at the tile bottom minus shiftY
      // (6px, or 0 for `!` object characters).
      for (const event of mapEntry?.mwgEvents || []) { const page = mwg.Rpg.activePage(event, this.gameState); const image = page?.image; const sheet = image && eventSheets.get(image.name); if (!sheet) continue; const geom = eventGeoms.get(image.name); const sprite = new mwg.TintedSprite({ texture: sheet.get(characterCellIndex(geom, image.index, image.direction, image.pattern)) }); const size = characterPixelSize(geom, tileSize); sprite.width = size.w; sprite.height = size.h; world.addChild(sprite); this.eventSprites.push({ event, sprite, ...size }); }
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
      if (playerSheet) (isXp ? addXpCharacterAnimations : addCharacterAnimations)(this.player, playerSheet, project.playerSprite.index || 0, playerGeom.big);
      this.playerSize = playerSheet ? characterPixelSize(playerGeom, tileSize) : { w: tileSize, h: tileSize, shift: 0 };
      this.player.width = this.playerSize.w; this.player.height = this.playerSize.h; this.player.tint = 0xffffff;
      world.addChild(this.player);
      world.addChild(this.aboveMap);
      this.pictureLayer = new mwg.Container2D();
      this.stage.addChild(this.pictureLayer);
      this.pictureSprites = new Map();
      this.pictureTweens = new Map();
      this.overlayLayer = new mwg.Container2D();
      world.addChild(this.overlayLayer);
      this.overlayAnims = [];
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: tileSize, tileHeight: tileSize, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
      this.pendingStep = null;
      this.updateCamera();
      this.runAutorunEvents();
    }
    update(dt) {
      this.windows.update(dt);
      this.music?.update(dt);
      this.ambience?.update(dt);
      this.screenEffects?.update(dt);
      this.updatePictures(dt);
      this.updateOverlayAnims(dt);
      this.updateCameraPan(dt);
      if (this.dialogue) return;
      this.parallelTimer -= dt;
      if (this.parallelTimer <= 0 && !this.eventRunning) { this.runParallelEvents(); this.parallelTimer = 0.25; }
      this.mover.update(dt);
      // Advance the repeat timer during a step. Freezing it until the mover is
      // idle creates a visible pause between consecutive held-key steps.
      this.cooldown -= dt;
      this.renderPosition = { x: this.player.x / tileSize, y: this.player.y / tileSize };
      this.updateCamera();
      if (this.pendingStep && !this.mover.isMoving) { const [x, y] = this.pendingStep; position.x = x; position.y = y; this.pendingStep = null; this.runEventAt(x, y, 'touch'); }
      if (this.mover.isMoving) return;
      if (this.cooldown <= 0) {
        const direction = mwg.Input.isDown('up') ? [0, -1, 'up'] : mwg.Input.isDown('down') ? [0, 1, 'down'] : mwg.Input.isDown('left') ? [-1, 0, 'left'] : mwg.Input.isDown('right') ? [1, 0, 'right'] : null;
        if (direction) {
          const [dx, dy, facing] = direction;
          this.facing = facing;
          const x = this.mover.x + dx, y = this.mover.y + dy;
          const moved = this.canStep(x, y, dx, dy) && this.mover.moveBy(dx, dy);
          if (moved) { this.pendingStep = [x, y]; this.cooldown = 0; }
          else { this.mover.turnTo(dx, dy); this.cooldown = 0.12; }
        }
        if (mwg.Input.justPressed('confirm')) this.runEventAt(...this.targetCell(), 'action');
      }
    }
    updateCamera() {
      // Screen shake has no mw_games primitive, so it is a plain jitter on the
      // camera offset for the effect's duration: MV's power is honored, its
      // speed only roughly (one new offset per frame), not a shared implementation.
      let shakeX = 0, shakeY = 0;
      if (this.shake && Date.now() < this.shake.until) {
        shakeX = (Math.random() * 2 - 1) * this.shake.power;
        shakeY = (Math.random() * 2 - 1) * this.shake.power;
      } else this.shake = null;
      // Pictures are screen-fixed in MV and ignore the pan; the world layers
      // (tiles, player, events) all move together under it.
      const panX = this.cameraPan.x + shakeX, panY = this.cameraPan.y + shakeY;
      // mwg sprites anchor at (0,0) (see TileMap's cellOrigin: top-left of the
      // cell), so the player sits exactly on its tile like event sprites do —
      // no half-tile or full-tile offset.
      const scale = tileSize; const x = this.mover?.isMoving ? this.renderPosition.x : (this.mover?.x ?? position.x), y = this.mover?.isMoving ? this.renderPosition.y : (this.mover?.y ?? position.y);
      if (this.camera) {
        this.tileMap.x = 0;
        this.tileMap.y = 0;
        this.camera.snapTo((x + 0.5) * scale - panX, (y + 0.5) * scale - panY);
      } else {
        this.tileMap.x = game.width / 2 - x * scale - scale / 2 + panX;
        this.tileMap.y = game.height / 2 - y * scale - scale / 2 + panY;
      }
      // this.renderPosition reads the mover's map-space sprite pos (tile
      // top-left units), so fractional movement positions anchor correctly here.
      this.player.x = x * scale + (scale - this.playerSize.w) / 2 + this.tileMap.x; this.player.y = y * scale + scale - this.playerSize.h - this.playerSize.shift + this.tileMap.y;
      for (const item of this.eventSprites || []) { item.sprite.x = item.event.x * scale + (scale - item.w) / 2 + this.tileMap.x; item.sprite.y = item.event.y * scale + scale - item.h - item.shift + this.tileMap.y; }
    }
    updateCameraPan(dt) {
      const tween = this.panTween;
      if (!tween) return;
      tween.elapsed += dt;
      const t = tween.duration > 0 ? Math.min(1, tween.elapsed / tween.duration) : 1;
      this.cameraPan.x = tween.from.x + (tween.to.x - tween.from.x) * t;
      this.cameraPan.y = tween.from.y + (tween.to.y - tween.from.y) * t;
      if (t >= 1) this.panTween = null;
    }
    resize(width, height) { this.camera?.setViewport(width, height); this.windows.setViewport(width, height); this.screenEffects?.setViewport(width, height); this.updateCamera(); }
    targetCell() { const offsets = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }; const [dx, dy] = offsets[this.facing]; return [position.x + dx, position.y + dy, 'action']; }
    canStep(x, y, dx, dy) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      const size = map.width * map.height, bit = directionBit(dx, dy);
      // Game_Map#layeredTiles checks the visible top layer first (3 -> 0).
      // Reading bottom-up lets a decorative lower tile override the actual
      // collision tile and makes movement diverge from RPG Maker.
      for (let layer = 3; layer >= 0; layer--) { const tile = map.data?.[layer * size + y * map.width + x] || 0; const flag = tilesetFlags[tile] ?? 0; if ((flag & 0x10) !== 0) continue; if ((flag & bit) === 0) return this.eventAllowsStep(x, y); }
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
      if (!event || this.erasedEvents.has(event.id)) return;
      const page = mwg.Rpg.activePage(event, this.gameState);
      if (!page || page.trigger !== trigger || (!page.commands?.length && !page.story)) return;
      this.runPage(page, event);
    }
    runAutorunEvents() {
      for (const event of mapEntry?.mwgEvents || []) {
        if (this.erasedEvents.has(event.id)) continue;
        const page = mwg.Rpg.activePage(event, this.gameState);
        if (page?.trigger === 'autorun' && (page.commands?.length || page.story)) this.runPage(page, event);
      }
    }
    runParallelEvents() {
      for (const event of mapEntry?.mwgEvents || []) {
        if (this.erasedEvents.has(event.id)) continue;
        const page = mwg.Rpg.activePage(event, this.gameState);
        if (page?.trigger === 'parallel' && (page.commands?.length || page.story)) this.runPage(page, event);
      }
    }
    runPage(page, event = null) {
      // Pages containing labels run as a story: passages keyed by label name,
      // following { goto } jumps until a passage runs out. GameState is mutated
      // in place, so switches/variables set mid-passage survive the jump.
      if (page.story) {
        const passages = Object.fromEntries(Object.entries(page.story.passages || {}).map(([name, body]) => [name, prepareEventCommands(body, this)]));
        this.eventQueue = this.eventQueue.then(() => { this.eventRunning = true; this.currentEvent = event; return this.runStoryLoop(passages, page.story.start || 'main'); })
          .catch(error => { if (!(error instanceof ExitEventSignal) && !(error instanceof BreakLoopSignal)) console.error('MWGP event failed', error); })
          .finally(() => { this.eventRunning = false; this.currentEvent = null; });
        return this.eventQueue;
      }
      const commands = prepareEventCommands(page.commands, this);
      // The running event is tracked so Erase Event knows which event to erase;
      // like MV, the erased state lasts until the map reloads.
      this.eventQueue = this.eventQueue.then(() => { this.eventRunning = true; this.currentEvent = event; return this.runBranch(commands); })
        // Exit Event Processing / Break Loop unwind via a thrown sentinel rather than a
        // return value, since EventRunner.run() offers no other way to stop mid-list; that
        // is expected control flow, not a failure, so only a genuine error is logged.
        .catch(error => { if (!(error instanceof ExitEventSignal) && !(error instanceof BreakLoopSignal)) console.error('MWGP event failed', error); })
        .finally(() => { this.eventRunning = false; this.currentEvent = null; });
      return this.eventQueue;
    }
    async runStoryLoop(passages, start) {
      // A missing passage ends the event with a warning, matching the loud
      // degradation rule: MV would hard-error, silence would be worse.
      let current = start, jumps = 0;
      while (current !== undefined && jumps++ < 1000) {
        if (!passages[current]) { console.warn(`MWGP story has no passage "${current}"; ending event`); return; }
        try {
          await this.runBranch(passages[current]);
          current = undefined;
        } catch (error) {
          if (error instanceof JumpSignal) current = error.passage;
          else throw error;
        }
      }
      if (jumps >= 1000) console.warn('MWGP story exceeded 1000 jumps without ending; stopping it');
    }
    // MV's convertEscapeCharacters, evaluated at display time so \V[n] sees live
    // variables: \V variable, \N actor name, \P party member name, \G currency
    // unit, \\ literal backslash. \C[n] colors, \I[n] icons, \. \| \^ \! waits,
    // \< \> instant toggles, \{ \} font size, and \$ gold window have no
    // MessageBox equivalent and strip to their payload (colors/icons) or
    // nothing (timing/layout). Unknown \PLUGIN[...] codes stay literal —
    // MV-faithful and loud, same rule as the converter's missing text keys.
    resolveEscapeCodes(text) {
      if (!text || !text.includes('\\')) return text;
      const escaped = text.replace(/\\\\/g, '\0');
      const actorName = id => project.database?.actors?.[Number(id)]?.name || '';
      const resolved = escaped
        .replace(/\\V\[(\d+)\]/gi, (_, id) => String(this.gameState?.variable?.(String(Number(id))) ?? 0))
        .replace(/\\N\[(\d+)\]/gi, (_, id) => actorName(id))
        .replace(/\\P\[(\d+)\]/gi, (_, n) => actorName(this.rpgExtra.party[Number(n) - 1]))
        .replace(/\\G/gi, project.database?.system?.currencyUnit || '')
        .replace(/\\C\[\d+\]/gi, '')
        .replace(/\\I\[\d+\]/gi, '')
        .replace(/\\[.\|^\!<>]/g, '')
        .replace(/\\[{}]/g, '')
        .replace(/\\\$/g, '');
      return resolved.replace(/\0/g, '\\');
    }
    messageAnchor() {
      return ['top', 'center', 'bottom'][Number(this.messageOptions?.position)] || 'bottom';
    }
    setMessageOptions(options) {
      this.messageOptions = {
        position: Math.max(0, Math.min(2, Number(options?.position ?? 2))),
        frame: Number(options?.frame ?? 0)
      };
    }
    async setMapSettings(settings) {
      if (!settings?.kind || !isXp || !assetRoot || !mwg.TiledSprite) return;
      if (settings.kind === 'battleback') {
        console.warn(`MWGP XP map battleback is not rendered: ${settings.name || '(none)'}`);
        return;
      }
      const directory = settings.kind === 'panorama' ? 'Panoramas' : 'Fogs';
      const url = settings.name ? `${assetRoot}/graphics/${directory}/${encodeURIComponent(settings.name)}.png` : null;
      const previous = settings.kind === 'panorama' ? this.panorama : this.fog;
      if (previous) { this.stage.removeChild(previous); previous.destroy?.(); }
      if (!url) { if (settings.kind === 'panorama') this.panorama = null; else this.fog = null; return; }
      try { await mwg.Resources.load([url]); } catch { console.warn(`MWGP XP map ${settings.kind} asset is missing: ${settings.name}`); return; }
      const visual = new mwg.TiledSprite({ texture: mwg.Resources.texture(url), width: game.width, height: game.height });
      if (settings.kind === 'panorama') { this.panorama = visual; if (this.stage.addChildAt) this.stage.addChildAt(visual, 0); else this.stage.addChild(visual); }
      else { visual.alpha = Math.max(0, Math.min(1, Number(settings.opacity ?? 0) / 255)); this.fog = visual; if (this.stage.addChildAt) this.stage.addChildAt(visual, 2); else this.stage.addChild(visual); }
    }
    inputNumber(state, command) {
      const variable = String(command.inputNumber.variable);
      const digits = Math.max(1, Math.min(9, Number(command.inputNumber.digits) || 1));
      const current = Number(state.game.variable(variable) || 0);
      const entered = globalThis.prompt?.(`Enter a number (${digits} digit${digits === 1 ? '' : 's'})`, String(current));
      if (entered === null || entered === undefined || entered === '') return;
      const value = Math.max(0, Math.min(10 ** digits - 1, Math.trunc(Number(entered))));
      if (Number.isFinite(value)) state.game.setVariable(variable, value);
    }
    presentDialogue(request) {
      return new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: 126, pages: [{ text: this.resolveEscapeCodes(request.text), speaker: request.speaker }], choices: (request.choices || []).map(choice => ({ ...choice, text: this.resolveEscapeCodes(choice.text) })), dims: this.messageOptions.frame === 0, anchor: this.messageAnchor(), onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
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
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: sheet ? 150 : 126, pages: [{ text: this.resolveEscapeCodes(command.ask || ''), portrait: sheet ? sheet.get(command.portrait.index) : undefined }], choices: (command.choices || []).map(choice => ({ ...choice, text: this.resolveEscapeCodes(choice.text) })), dims: this.messageOptions.frame === 0, anchor: this.messageAnchor(), onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
        this.windows.push(box);
      }).then(chosen => this.runBranch((command.branches || [])[Number(chosen)]));
    }
    async startBattle(spec) {
      const database = project.database || {};
      const troopId = spec.troopVariable
        ? Number(this.gameState.variable(String(spec.troopVariable)) || 0)
        : Number(spec.troopId || 0);
      const troop = database.troops?.[troopId];
      const enemies = (troop?.members || [])
        .filter(member => !member.hidden)
        .map(member => database.enemies?.[Number(member.enemyId)])
        .filter(Boolean)
        .map(enemy => makeBattleEnemy(enemy));
      if (!enemies.length) {
        await this.presentDialogue({ text: `Combat ${troopId} impossible : le groupe d'ennemis est introuvable.` });
        this.unsupportedCommand('battle', spec);
        return 'lose';
      }
      const actorId = Number(this.rpgExtra.party?.[0]) || findPlayerActor(project);
      const actor = database.actors?.[actorId];
      const klass = database.classes?.[Number(actor?.classId)];
      const level = Math.max(1, Number(actor?.initialLevel || 1));
      const params = klass?.params?.[level] || klass?.params?.[0] || [];
      const hero = {
        name: actor?.name || 'Héros',
        hp: Number(params[0] || 100),
        maxHp: Number(params[0] || 100),
        atk: Number(params[2] || 20),
        def: Number(params[3] || 10)
      };
      await this.presentDialogue({ text: `Un combat commence contre ${enemies.map(enemy => enemy.name).join(', ')}.` });
      for (const enemy of enemies) {
        while (hero.hp > 0 && enemy.hp > 0) {
          const choice = await this.presentDialogue({
            text: `${hero.name} (${hero.hp}/${hero.maxHp}) — ${enemy.name} (${enemy.hp}/${enemy.maxHp})`,
            choices: [{ text: 'Attaquer', value: 0 }, ...(spec.canEscape ? [{ text: 'Fuir', value: 1 }] : [])]
          });
          if (Number(choice) === 1) {
            await this.presentDialogue({ text: `${hero.name} s'enfuit.` });
            return 'escape';
          }
          const damage = Math.max(1, hero.atk - Math.floor(enemy.def / 2));
          enemy.hp = Math.max(0, enemy.hp - damage);
          await this.presentDialogue({ text: `${hero.name} inflige ${damage} dégâts à ${enemy.name}.` });
          if (enemy.hp <= 0) {
            await this.presentDialogue({ text: `${enemy.name} est vaincu.` });
            break;
          }
          const retaliation = Math.max(1, enemy.atk - Math.floor(hero.def / 2));
          hero.hp = Math.max(0, hero.hp - retaliation);
          await this.presentDialogue({ text: `${enemy.name} inflige ${retaliation} dégâts à ${hero.name}.` });
        }
        if (hero.hp <= 0) {
          await this.presentDialogue({ text: `${hero.name} est vaincu.` });
          return 'lose';
        }
      }
      await this.presentDialogue({ text: 'Victoire !' });
      return 'win';
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
        const resolved = resolveRouteStep(step, this.facing);
        if (!resolved) continue;
        // MV jumps arc over intervening tiles, ignoring passability; without a
        // jump animation the honest equivalent is an instant relocation.
        if (resolved.jump) {
          this.mover.x += resolved.jump.dx;
          this.mover.y += resolved.jump.dy;
          position.x = this.mover.x;
          position.y = this.mover.y;
          this.updateCamera();
          continue;
        }
        if (!this.canStep(this.mover.x + resolved.dx, this.mover.y + resolved.dy, resolved.dx, resolved.dy)) continue;
        this.facing = resolved.dy > 0 ? 'down' : resolved.dy < 0 ? 'up' : resolved.dx < 0 ? 'left' : 'right';
        if (!this.mover.moveBy(resolved.dx, resolved.dy)) continue;
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
      const order = ['up', 'right', 'down', 'left'];
      const at = order.indexOf(this.facing);
      let facing = direction;
      if (direction === 'around') facing = order[(at + 2) % 4];
      else if (direction === 'left90') facing = order[(at + 3) % 4];
      else if (direction === 'right90') facing = order[(at + 1) % 4];
      else if (direction === 'random') facing = order[Math.floor(Math.random() * 4)];
      // toward/away are degenerate for a player-target route (the target is the
      // player itself), so the facing is kept.
      else if (direction === 'toward' || direction === 'away') facing = this.facing;
      const vector = vectors[facing];
      if (vector) { this.facing = facing; this.mover?.turnTo(...vector); }
    }
    presentScroll(scroll) {
      // MV scrolls lines upward full-screen; the widget has no scroller, so the
      // honest equivalent is a centered box that reveals and auto-advances at
      // the converted speed. noFast (disallow skip) has no widget equivalent —
      // manual confirm still advances — so only the timing is preserved.
      const speed = Math.max(1, scroll.speed) * 20;
      const hold = scroll.text.length / speed + 2;
      return new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: 180, pages: [{ text: this.resolveEscapeCodes(scroll.text) }], speed, autoAdvance: hold, dims: this.messageOptions.frame === 0, anchor: this.messageAnchor(), onDone: () => { this.windows.pop(); this.dialogue = null; resolve(); } });
        this.windows.push(box);
      });
    }
    presentPortrait(command) {
      const sheet = portraitSheets.get(command.portrait.name);
      if (!sheet) return Promise.resolve();
      return new Promise(resolve => {
        this.dialogue = true;
        const box = new mwg.MessageBox({ width: Math.max(320, game.width - 48), height: 150, pages: [{ text: this.resolveEscapeCodes(command.say || command.ask || ''), portrait: sheet.get(command.portrait.index), }], choices: (command.choices || []).map(choice => ({ ...choice, text: this.resolveEscapeCodes(choice.text) })), dims: this.messageOptions.frame === 0, anchor: this.messageAnchor(), onDone: chosen => { this.windows.pop(); this.dialogue = null; resolve(chosen); } });
        this.windows.push(box);
      });
    }
    showPicture(picture) {
      const texture = pictureTextures.get(picture.name);
      if (!texture) return;
      this.pictureSprites.get(picture.id)?.destroy();
      // A fresh Show Picture resets all state, including any running tween.
      this.cancelPictureTween(picture.id);
      const sprite = new mwg.TintedSprite({ texture });
      sprite.anchor?.set(picture.origin === 1 ? 0.5 : 0);
      sprite.x = picture.x; sprite.y = picture.y;
      sprite.scale.set(picture.scaleX / 100, picture.scaleY / 100);
      sprite.alpha = picture.opacity / 255;
      this.pictureLayer.addChild(sprite);
      this.pictureSprites.set(picture.id, sprite);
    }
    erasePicture(id) {
      this.cancelPictureTween(id);
      const sprite = this.pictureSprites.get(id);
      if (!sprite) return;
      sprite.destroy();
      this.pictureSprites.delete(id);
    }
    cancelPictureTween(id) {
      // A replaced tween must release its waiter: MV lets the new command take
      // over, it never leaves the old wait hanging.
      const tween = this.pictureTweens.get(id);
      if (tween) { this.pictureTweens.delete(id); tween.resolve?.(); }
    }
    pictureVisual(sprite) {
      return {
        x: sprite.x, y: sprite.y,
        scaleX: sprite.scale.x * 100, scaleY: sprite.scale.y * 100,
        opacity: sprite.alpha * 255, tint: sprite.tint ?? 0xffffff
      };
    }
    applyPictureVisual(sprite, visual) {
      sprite.x = visual.x; sprite.y = visual.y;
      sprite.scale.set(visual.scaleX / 100, visual.scaleY / 100);
      sprite.alpha = visual.opacity / 255;
      sprite.tint = visual.tint;
    }
    movePicture(command) {
      const sprite = this.pictureSprites.get(command.id);
      const target = {
        ...this.pictureVisual(sprite || { x: 0, y: 0, scale: { x: 1, y: 1 }, alpha: 1, tint: 0xffffff }),
        x: command.x, y: command.y, scaleX: command.scaleX, scaleY: command.scaleY, opacity: command.opacity
      };
      // MV still blocks the full duration on wait even when the picture is gone.
      if (!sprite || !(command.duration > 0)) {
        if (sprite) this.applyPictureVisual(sprite, target);
        return command.wait ? new Promise(resolve => setTimeout(resolve, Math.max(0, command.duration) * 1000)) : Promise.resolve();
      }
      return new Promise(resolve => {
        this.cancelPictureTween(command.id);
        this.pictureTweens.set(command.id, { from: this.pictureVisual(sprite), to: target, duration: command.duration, elapsed: 0, resolve: command.wait ? resolve : null });
        if (!command.wait) resolve();
      });
    }
    tintPicture(command) {
      const sprite = this.pictureSprites.get(command.id);
      const [r = 0, g = 0, b = 0, gray = 0] = command.tone || [];
      const target = {
        ...this.pictureVisual(sprite || { x: 0, y: 0, scale: { x: 1, y: 1 }, alpha: 1, tint: 0xffffff }),
        tint: !r && !g && !b && !gray ? 0xffffff : pictureToneColor(command.tone)
      };
      if (!sprite || !(command.duration > 0)) {
        if (sprite) this.applyPictureVisual(sprite, target);
        return command.wait ? new Promise(resolve => setTimeout(resolve, Math.max(0, command.duration) * 1000)) : Promise.resolve();
      }
      return new Promise(resolve => {
        this.cancelPictureTween(command.id);
        this.pictureTweens.set(command.id, { from: this.pictureVisual(sprite), to: target, duration: command.duration, elapsed: 0, resolve: command.wait ? resolve : null });
        if (!command.wait) resolve();
      });
    }
    updatePictures(dt) {
      for (const [id, tween] of this.pictureTweens) {
        tween.elapsed += dt;
        const t = tween.duration > 0 ? Math.min(1, tween.elapsed / tween.duration) : 1;
        const sprite = this.pictureSprites.get(id);
        if (sprite) {
          const mix = (from, to) => from + (to - from) * t;
          const visual = { ...tween.to };
          for (const key of ['x', 'y', 'scaleX', 'scaleY', 'opacity']) visual[key] = mix(tween.from[key], tween.to[key]);
          if (tween.from.tint !== tween.to.tint) {
            const channel = shift => Math.round(mix((tween.from.tint >> shift) & 0xff, (tween.to.tint >> shift) & 0xff));
            visual.tint = (channel(16) << 16) | (channel(8) << 8) | channel(0);
          }
          this.applyPictureVisual(sprite, visual);
        }
        if (t >= 1) { this.pictureTweens.delete(id); tween.resolve?.(); }
      }
    }
    playSound(sound) {
      sounds.get(sound.name)?.play(Math.max(0, Math.min(1, sound.volume / 100)), Math.max(0.1, sound.pitch / 100));
    }
    stopSound() {
      for (const sound of sounds.values()) sound.stopAll();
    }
    musicPath(dir, name) {
      return `${project.assets.root}/audio/${dir}/${encodeURIComponent(name)}.ogg`;
    }
    playTrack(kind, track) {
      // Pitch/pan have no music-stream equivalent in mw_games (Sound.play takes
      // pitch, Music.play does not), so BGM/BGS play at volume only.
      const channel = kind === 'bgs' ? this.ambience : this.music;
      if (!channel || !loadedMusic.has(`${kind}/${track.name}`)) { console.warn(`MWGP ${kind} '${track.name}' has no decoded audio; skipping`); return; }
      channel.volume = Math.max(0, Math.min(1, track.volume / 100));
      channel.play(this.musicPath(kind, track.name), 1);
      if (kind === 'bgm') this.bgmTrack = { kind, name: track.name, volume: Number(track.volume ?? 90) };
    }
    saveBgm() {
      // MV's Save BGM snapshots the current track for Resume BGM.
      this.savedBgm = this.bgmTrack ? { ...this.bgmTrack } : null;
    }
    resumeBgm() {
      const saved = this.savedBgm;
      if (!saved) { console.warn('MWGP resumeBgm with no saved BGM; skipping'); return; }
      this.playTrack(saved.kind, { name: saved.name, volume: saved.volume, pitch: 100, pan: 0 });
    }
    playMe(me) {
      // An ME is a short jingle over the music, so a pooled one-shot fits it
      // better than the crossfading music stream; the BGM underneath is kept.
      const sound = meSounds.get(me.name);
      if (!sound) { console.warn(`MWGP me '${me.name}' has no decoded audio; skipping`); return; }
      sound.play(Math.max(0, Math.min(1, me.volume / 100)), Math.max(0.1, me.pitch / 100));
    }
    unimplementedScene(scene) {
      console.warn(`MWGP open-${scene} has no player scene; the menu/save UI does not exist outside RPG Maker`);
    }
    scrollMap(command) {
      const distance = Math.max(0, Number(command.distance || 0));
      // Screen offset is the negative of the viewed tile delta: revealing
      // tiles below means the tile layer moves up.
      const vector = { 2: [0, -1], 4: [1, 0], 6: [-1, 0], 8: [0, 1] }[Number(command.direction)] || [0, 0];
      // Engine scroll velocity is 2^speed pixels per frame at 256px tiles,
      // i.e. 2^speed*60/256 tiles per second at any tile size.
      const tilesPerSecond = Math.pow(2, Number(command.speed ?? 4)) * 60 / 256;
      const duration = tilesPerSecond > 0 ? distance / tilesPerSecond : 0;
      const to = { x: this.cameraPan.x + vector[0] * distance * tileSize, y: this.cameraPan.y + vector[1] * distance * tileSize };
      if (!(duration > 0) || !distance) { this.cameraPan = to; this.panTween = null; this.updateCamera(); return Promise.resolve(); }
      this.panTween = { from: { ...this.cameraPan }, to, elapsed: 0, duration };
      return Promise.resolve();
    }
    relocate(state, command) {
      const target = command.relocate;
      const x = target.varX !== undefined ? state.game.variable(String(target.varX)) : Number(target.x || 0);
      const y = target.varY !== undefined ? state.game.variable(String(target.varY)) : Number(target.y || 0);
      // Mutating the event's own x/y moves its sprite (positions derive from
      // them every frame) and its trigger cell — matching MV's locate.
      const event = target.target === 'self' && this.currentEvent ? this.currentEvent
        : (mapEntry?.mwgEvents || []).find(candidate => String(candidate.id) === String(target.target));
      if (target.target === 'player') {
        this.mover.x = x; this.mover.y = y;
        position.x = x; position.y = y;
        if (target.facing) this.turnPlayer(target.facing);
        this.updateCamera();
        return;
      }
      if (!event) { console.warn(`MWGP relocate target event "${target.target}" is not on this map; skipping`); return; }
      event.x = x; event.y = y;
      this.updateCamera();
    }
    playBgm(track) { this.playTrack('bgm', track); }
    playBgs(track) { this.playTrack('bgs', track); }
    fadeoutBgm({ duration }) { this.music?.stop(Math.max(0, duration)); }
    fadeoutBgs({ duration }) { this.ambience?.stop(Math.max(0, duration)); }
    resolveAmount(state, amount) {
      if (typeof amount === 'number') return amount;
      const value = state.game.variable(String(amount.variable));
      return amount.op === 'sub' ? -value : value;
    }
    applyInventory(state, command) {
      const extra = this.rpgExtra;
      if (command.changeGold !== undefined) extra.gold = Math.max(0, extra.gold + this.resolveAmount(state, command.changeGold));
      for (const [key, store] of [['changeItem', 'items'], ['changeWeapon', 'weapons'], ['changeArmor', 'armors']]) {
        const change = command[key];
        if (change === undefined) continue;
        const id = String(change.id);
        extra[store][id] = Math.max(0, (extra[store][id] || 0) + this.resolveAmount(state, change.amount));
        if (extra[store][id] === 0) delete extra[store][id];
      }
      if (command.changeParty) {
        const id = Number(command.changeParty.actorId);
        extra.party = command.changeParty.add
          ? (extra.party.includes(id) ? extra.party : [...extra.party, id])
          : extra.party.filter(member => member !== id);
      }
    }
    actorRecord(id) {
      const key = String(id);
      this.rpgExtra.actors[key] = this.rpgExtra.actors[key] || { states: [], skills: [], equips: {}, profile: '' };
      return this.rpgExtra.actors[key];
    }
    actorTargets(state, scope) {
      // MV's iterateActorEx scope: 0 = entire party, 1 = one actor id,
      // 2 = actor id read from a variable.
      if (scope.scope === 0) return [...this.rpgExtra.party];
      if (scope.scope === 2) return [Number(state.game.variable(String(scope.actor)))];
      return [Number(scope.actor)];
    }
    applyActor(state, command) {
      // Only states/skills/equipment/profile are modeled: the corpus never
      // touches HP/MP/EXP/levels through these codes, and Recover All's HP/MP
      // half has no model — it clears states, which is the observable part.
      if (command.changeState) {
        for (const id of this.actorTargets(state, command.changeState)) {
          const record = this.actorRecord(id);
          record.states = command.changeState.add
            ? (record.states.includes(command.changeState.state) ? record.states : [...record.states, command.changeState.state])
            : record.states.filter(stateId => stateId !== command.changeState.state);
        }
      }
      if (command.recoverAll) for (const id of this.actorTargets(state, command.recoverAll)) this.actorRecord(id).states = [];
      if (command.changeSkill) {
        for (const id of this.actorTargets(state, command.changeSkill)) {
          const record = this.actorRecord(id);
          record.skills = command.changeSkill.learn
            ? (record.skills.includes(command.changeSkill.skill) ? record.skills : [...record.skills, command.changeSkill.skill])
            : record.skills.filter(skillId => skillId !== command.changeSkill.skill);
        }
      }
      if (command.changeEquipment) {
        const { actor, slot, item } = command.changeEquipment;
        if (item) this.actorRecord(actor).equips[String(slot)] = item;
        else delete this.actorRecord(actor).equips[String(slot)];
      }
      if (command.changeProfile) this.actorRecord(command.changeProfile.actor).profile = command.changeProfile.profile;
    }
    setTransparent(transparent) {
      // MV draws a transparent player at reduced opacity rather than hiding it.
      // Route opacity steps (code 42) carry an exact alpha instead of the flag.
      if (!this.player) return;
      this.player.alpha = typeof transparent === 'number'
        ? Math.max(0, Math.min(1, transparent))
        : (transparent ? 160 / 255 : 1);
    }
    eraseEvent() {
      const event = this.currentEvent;
      if (!event || this.erasedEvents.has(event.id)) return;
      this.erasedEvents.add(event.id);
      const index = (this.eventSprites || []).findIndex(item => item.event === event);
      if (index >= 0) {
        const [item] = this.eventSprites.splice(index, 1);
        this.stage.removeChild(item.sprite);
        item.sprite.destroy();
      }
    }
    screenTint({ tone, duration, wait }) {
      if (!this.screenEffects) return Promise.resolve();
      const [r = 0, g = 0, b = 0, gray = 0] = tone || [];
      const clamp = n => Math.max(-255, Math.min(255, Math.round(Number(n) || 0)));
      const mix = n => Math.max(0, Math.min(255, 128 + Math.round(clamp(n) / 2) + Math.round(clamp(gray) / 4)));
      if (!r && !g && !b && !gray) this.screenEffects.clear();
      // The overlay holds one flat wash, so MV's tone (a per-channel offset
      // plus a grey desaturation) is approximated as a single colour wash at
      // the strongest channel's strength; the fade duration is a blocking wait
      // rather than a gradual transition, which the widget cannot express.
      else this.screenEffects.setTint((mix(r) << 16) | (mix(g) << 8) | mix(b),
        Math.max(0, Math.min(1, Math.max(Math.abs(clamp(r)), Math.abs(clamp(g)), Math.abs(clamp(b)), Math.abs(clamp(gray))) / 255)));
      return wait ? new Promise(resolve => setTimeout(resolve, duration * 1000)) : Promise.resolve();
    }
    screenShake({ power, duration, wait }) {
      this.shake = { power: Math.max(0, power), until: Date.now() + duration * 1000 };
      return wait ? new Promise(resolve => setTimeout(resolve, duration * 1000)) : Promise.resolve();
    }
    unsupportedCommand(kind, detail) {
      // MV script/plugin commands execute RPG Maker's own Ruby/JS context, which
      // a converted manifest cannot carry: warn loudly instead of pretending.
      console.warn(`MWGP ${kind} is not playable without RPG Maker and was skipped`, detail);
    }
    overlayTarget(target) {
      // Origins ride the sprite's center-x/feet (natural sprite height, not
      // one tile) so balloons and animations sit on tall characters' heads.
      if (target === -1) {
        if (!this.player || !this.mover) return null;
        return { x: this.player.x + this.playerSize.w / 2, feetY: this.player.y + this.playerSize.h, h: this.playerSize.h };
      }
      const id = target === 0 && this.currentEvent ? this.currentEvent.id : target;
      const item = (this.eventSprites || []).find(entry => String(entry.event.id) === String(id));
      if (!item) return null;
      return { x: item.sprite.x + item.w / 2, feetY: item.sprite.y + item.h, h: item.h };
    }
    showBalloon(command) {
      const origin = this.overlayTarget(command.target);
      const row = Math.max(0, Math.min(14, Number(command.balloon || 1) - 1));
      if (!origin || !balloonSheet) {
        console.warn(`MWGP balloon ${command.balloon} has no target or Balloon.png; skipping`);
        return Promise.resolve();
      }
      // The sheet is 8 frames per balloon row (measured 384x720 on real data).
      // MV bounces the icon for ~1.2s; here it rises slightly while cycling once.
      const container = new mwg.Container2D();
      container.x = origin.x; container.y = origin.feetY - origin.h - tileSize / 2;
      const sprite = new mwg.TintedSprite({ texture: balloonSheet.get(row * 8) });
      sprite.anchor?.set(0.5);
      sprite.width = tileSize; sprite.height = tileSize;
      container.addChild(sprite);
      this.overlayLayer.addChild(container);
      return new Promise(resolve => {
        this.overlayAnims.push({
          kind: 'balloon', container, sheet: balloonSheet, base: row * 8,
          frameCount: 8, fps: 8, elapsed: 0, duration: 1, rise: tileSize / 3,
          lastFrame: -1, resolve: command.wait ? resolve : null
        });
        if (!command.wait) resolve();
      });
    }
    playAnimation(command) {
      const origin = this.overlayTarget(command.target);
      const animation = project.database?.animations?.[command.animation];
      if (!origin || !animation) {
        console.warn(`MWGP animation ${command.animation} has no target or data; skipping`);
        return Promise.resolve();
      }
      const frames = animation.frames || [];
      const anchorY = animation.position === 3
        ? game.height / 2
        : animation.position === 2 ? origin.feetY : animation.position === 0 ? origin.feetY - origin.h : origin.feetY - origin.h / 2;
      const container = new mwg.Container2D();
      container.x = animation.position === 3 ? game.width / 2 : origin.x;
      container.y = anchorY;
      this.overlayLayer.addChild(container);
      // MV advances animation frames at ~12fps; timings (per-frame SE/flash)
      // have no player equivalent and are skipped.
      const duration = Math.max(0.1, frames.length / 12);
      return new Promise(resolve => {
        this.overlayAnims.push({
          kind: 'animation', container, animation, frames, frameCount: frames.length,
          fps: 12, elapsed: 0, duration,
          lastFrame: -1, resolve: command.wait ? resolve : null
        });
        if (!command.wait) resolve();
      });
    }
    drawOverlayFrame(anim, frame) {
      if (anim.kind === 'balloon') {
        const sprite = anim.container.children[0];
        if (sprite) sprite.texture = anim.sheet.get(anim.base + Math.min(anim.frameCount - 1, frame));
        return;
      }
      // Rebuild the frame's cells. A cell is
      // [pattern, x, y, scale, rotation, mirror, opacity, blend]: pattern
      // indexes the 192px grid, x/y are pixel offsets at MV's 48px grid scale.
      // Rotation is editor degrees; mirror flips horizontally. Blend modes and
      // dual-sheet pattern selection (animation2) are approximated away: cells
      // always read the first available sheet.
      while (anim.container.children.length) {
        const child = anim.container.children[0];
        anim.container.removeChild(child);
        child.destroy();
      }
      const scale = tileSize / 48;
      for (const cell of anim.frames[frame] || []) {
        const [pattern, cx, cy, cscale, rotation, mirror, opacity] = cell;
        const sheet = animationSheets.get(anim.animation.animation1Name) || animationSheets.get(anim.animation.animation2Name);
        if (!sheet) continue;
        const sprite = new mwg.TintedSprite({ texture: sheet.get(Math.max(0, pattern || 0)) });
        sprite.anchor?.set(0.5);
        sprite.width = 4 * tileSize * (Number(cscale ?? 100) / 100);
        sprite.height = 4 * tileSize * (Number(cscale ?? 100) / 100);
        sprite.x = Number(cx || 0) * scale;
        sprite.y = Number(cy || 0) * scale;
        sprite.rotation = Number(rotation || 0) * Math.PI / 180;
        if (mirror) sprite.scale.x *= -1;
        sprite.alpha = Math.max(0, Math.min(1, Number(opacity ?? 255) / 255));
        anim.container.addChild(sprite);
      }
    }
    updateOverlayAnims(dt) {
      for (let index = this.overlayAnims.length - 1; index >= 0; index--) {
        const anim = this.overlayAnims[index];
        anim.elapsed += dt;
        const frame = Math.min(anim.frameCount - 1, Math.floor(anim.elapsed * anim.fps));
        if (frame !== anim.lastFrame) { anim.lastFrame = frame; this.drawOverlayFrame(anim, frame); }
        if (anim.kind === 'balloon') anim.container.y -= (anim.rise * dt) / anim.duration;
        if (anim.elapsed >= anim.duration) {
          this.overlayLayer.removeChild(anim.container);
          anim.container.destroy({ children: true });
          this.overlayAnims.splice(index, 1);
          anim.resolve?.();
        }
      }
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
    transfer(target, state) {
      const value = (variable, fallback) => variable === undefined ? fallback : state?.game.variable(String(variable));
      const mapId = value(target.mapVar, target.mapId);
      const x = value(target.xVar, target.x);
      const y = value(target.yVar, target.y);
      this.saves.save('runtime-transition', { mapId, x, y, facing: this.facing, rpg: this.gameState.toJSON(), extra: this.rpgExtra }, { mapId, x, y });
      const params = new URLSearchParams(location.search);
      params.set('map', String(mapId)); params.set('x', String(x)); params.set('y', String(y));
      location.href = `${location.pathname}?${params}`;
    }
    // Save/load feedback is a title flash plus a console line: loud enough to
    // tell a working key from a swallowed one, with no new UI primitives.
    flashTitle(text) {
      try {
        const original = document.title;
        document.title = text;
        clearTimeout(this.titleTimer);
        this.titleTimer = setTimeout(() => { document.title = original; }, 1500);
      } catch { /* headless */ }
    }
    saveGame() {
      try {
        this.saves.save('slot-1', { mapId: mapEntry.id, x: this.mover.x, y: this.mover.y, facing: this.mover.facing, rpg: this.gameState.toJSON(), extra: this.rpgExtra }, { mapId: mapEntry.id, x: this.mover.x, y: this.mover.y });
        console.info(`MWGP saved slot-1 on map ${mapEntry.id} at (${this.mover.x}, ${this.mover.y})`);
        this.flashTitle('✓ Saved (slot 1)');
      } catch (error) { console.error('MWGP save failed', error); this.flashTitle('✗ Save failed — see console (F12)'); }
    }
    loadGame() {
      const saved = this.saves.load('slot-1');
      if (!saved) { this.flashTitle('No save in slot 1 yet'); return false; }
      if (this.mover.isMoving) return false;
      if (saved.state.extra) this.rpgExtra = { ...freshExtraState(), ...saved.state.extra };
      if (Number(saved.state.mapId) !== Number(mapEntry.id)) {
        this.saves.save('runtime-transition', { ...saved.state, extra: this.rpgExtra }, { mapId: saved.state.mapId, x: saved.state.x, y: saved.state.y });
        const params = new URLSearchParams(location.search);
        params.set('map', String(saved.state.mapId)); params.set('x', String(saved.state.x)); params.set('y', String(saved.state.y));
        location.href = `${location.pathname}?${params}`;
        return true;
      }
      position.x = saved.state.x; position.y = saved.state.y; this.facing = saved.state.facing || 'down';
      this.gameState = mwg.Rpg.GameState.fromJSON(saved.state.rpg);
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: tileSize, tileHeight: tileSize, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
      this.updateCamera();
      console.info(`MWGP loaded slot-1 on map ${saved.state.mapId} at (${saved.state.x}, ${saved.state.y})`);
      this.flashTitle('✓ Loaded (slot 1)');
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

async function buildAutotileSheet(url, slot, mwg, flags = []) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return mwg.SpriteSheet.grid(url, 48);
  const image = await new Promise((resolve, reject) => { const value = new Image(); value.onload = () => resolve(value); value.onerror = reject; value.src = url; });
  const count = AUTOTILE_COUNTS[slot];
  const canvas = document.createElement('canvas');
  canvas.width = 16 * 48; canvas.height = Math.ceil(count / 16) * 48;
  const context = canvas.getContext('2d');
  for (let offset = 0; offset < count; offset++) {
    const tile = AUTOTILE_TILE_BASE[slot] + offset;
    const dx = offset % 16 * 48, dy = Math.floor(offset / 16) * 48;
    for (const op of autotileDrawOps(tile, slot, flags)) {
      context.drawImage(image, op.sx, op.sy, op.sw, op.sh, dx + op.dx, dy + op.dy, op.dw, op.dh);
    }
  }
  return mwg.SpriteSheet.fromTexture(mwg.Texture2D.from(canvas), 48);
}

// Frame counts and kind bases per autotile sheet, straight from the engine's
// TILE_ID_A1/A2/A3/A4 spacing (48 shapes per kind).
const AUTOTILE_COUNTS = [768, 1536, 1536, 2304];
const AUTOTILE_KIND_BASE = [0, 16, 48, 80];
const AUTOTILE_TILE_BASE = [2048, 2816, 4352, 5888];

// Source-tile math mirroring rpg_core.js Tilemap._drawAutotile at animation
// frame 0 (waterSurfaceIndex 0), exported so tests can pin it. Returns null
// when the engine draws nothing: A1 waterfall kinds only define shapes 0-3,
// higher shapes sample no table and stay transparent.
export function autotileSource(tile, slot) {
  const kind = AUTOTILE_KIND_BASE[slot] + Math.floor((tile - AUTOTILE_TILE_BASE[slot]) / 48);
  const shape = (tile - AUTOTILE_TILE_BASE[slot]) % 48;
  const tx = kind % 8, ty = Math.floor(kind / 8);
  if (slot === 0) {
    if (kind === 0) return { kind, shape, bx: 0, by: 0, table: 'floor' };
    if (kind === 1) return { kind, shape, bx: 0, by: 3, table: 'floor' };
    if (kind === 2) return { kind, shape, bx: 6, by: 0, table: 'floor' };
    if (kind === 3) return { kind, shape, bx: 6, by: 3, table: 'floor' };
    const bx = Math.floor(tx / 4) * 8, by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
    if (kind % 2 === 0) return { kind, shape, bx, by, table: 'floor' };
    if (shape >= WATERFALL_AUTOTILE_TABLE.length) return null;
    return { kind, shape, bx: bx + 6, by, table: 'waterfall' };
  }
  if (slot === 1) return { kind, shape, bx: tx * 2, by: (ty - 2) * 3, table: 'floor' };
  if (slot === 2) return { kind, shape, bx: tx * 2, by: (ty - 6) * 2, table: 'wall' };
  // A4 renders wall autotiles on odd kind rows and floor autotiles on even
  // ones (rpg_core.js: `if (ty % 2 === 1)` selects the wall table).
  return { kind, shape, bx: tx * 2, by: Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0)), table: ty % 2 === 1 ? 'wall' : 'floor' };
}

// Draw ops (24px-half units) for one autotile frame, mirroring the engine's
// quadrant loop plus the A2 table-tile self composite: quads sampling the
// table's front-face row (qsy 1/5) draw it full-height first, then overlay
// the top half of their own art. The neighbor-dependent table *edge* strip
// (_drawTableEdge, drawn onto the cell below a table) has no static-atlas
// equivalent and stays a known gap. Pure so tests can pin it.
export function autotileDrawOps(tile, slot, flags = []) {
  const source = autotileSource(tile, slot);
  if (!source) return [];
  const table = autotileTable(source.table)[source.shape];
  if (!table) return [];
  const isTable = slot === 1 && (flags[tile] & 0x80) !== 0;
  const ops = [];
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    const [qx, qy] = table[quadrant];
    const sx = (source.bx * 2 + qx) * 24, sy = (source.by * 2 + qy) * 24;
    const dx = (quadrant % 2) * 24, dy = Math.floor(quadrant / 2) * 24;
    if (isTable && (qy === 1 || qy === 5)) {
      const qx2 = qy === 1 ? [0, 3, 2, 1][qx] : qx;
      ops.push({ sx: (source.bx * 2 + qx2) * 24, sy: (source.by * 2 + 3) * 24, sw: 24, sh: 24, dx, dy, dw: 24, dh: 24 });
      ops.push({ sx, sy, sw: 24, sh: 12, dx, dy: dy + 12, dw: 24, dh: 12 });
    } else {
      ops.push({ sx, sy, sw: 24, sh: 24, dx, dy, dw: 24, dh: 24 });
    }
  }
  return ops;
}

// Lazy lookup: the shape tables are declared further down this module.
function autotileTable(name) {
  return name === 'wall' ? WALL_AUTOTILE_TABLE : name === 'waterfall' ? WATERFALL_AUTOTILE_TABLE : FLOOR_AUTOTILE_TABLE;
}

// Every place a command can contain nested command arrays — if/else branches, a loop body,
// or a Show Choices command's per-choice/cancel branches — so asset collectors and
// prepareEventCommands only need to know this shape once.
function childBlocks(command) {
  return [command.then, command.else, command.loop, ...(command.branches || []), command.cancelBranch,
    ...Object.values(command.battle?.branches || {})].filter(Boolean);
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

function collectMusicNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.playBgm?.name) names.push({ dir: 'bgm', name: command.playBgm.name });
    if (command.playBgs?.name) names.push({ dir: 'bgs', name: command.playBgs.name });
    for (const block of childBlocks(command)) names.push(...collectMusicNames(block));
  }
  return names;
}

function collectAnimationSheetNames(commands, animations) {
  const names = [];
  for (const command of commands || []) {
    const animation = animations?.[command.animation?.animation];
    if (animation?.animation1Name) names.push(animation.animation1Name);
    if (animation?.animation2Name) names.push(animation.animation2Name);
    for (const block of childBlocks(command)) names.push(...collectAnimationSheetNames(block, animations));
  }
  return names;
}

function collectMeNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.me?.name) names.push(command.me.name);
    for (const block of childBlocks(command)) names.push(...collectMeNames(block));
  }
  return names;
}

// Party, gold and item/weapon/armor counts are player-held MWGP state, not
// mw_games GameState (switches/variables only). No starting party is known —
// the manifest carries no System.json party — so it starts empty and only
// changeParty commands populate it.
function freshExtraState() {
  return { gold: 0, items: {}, weapons: {}, armors: {}, party: [], actors: {} };
}

function findPlayerActor(project) {
  const sprite = project.playerSprite || {};
  const actors = Object.values(project.database?.actors || {});
  return Number(actors.find(actor => actor?.characterName === sprite.name && Number(actor.characterIndex) === Number(sprite.index))?.id || 1);
}

function makeBattleEnemy(enemy) {
  const params = enemy.params || [];
  return {
    name: enemy.name || 'Ennemi',
    hp: Math.max(1, Number(params[0] || 1)),
    maxHp: Math.max(1, Number(params[0] || 1)),
    atk: Number(params[2] || 1),
    def: Number(params[3] || 0)
  };
}

// Maps an MV picture tone ([r, g, b, gray] offsets plus desaturation) onto a
// single multiply color, the same approximation as the screen tint: per-sprite
// alpha is already owned by opacity, so only the color travels here.
function pictureToneColor(tone) {
  const [r = 0, g = 0, b = 0, gray = 0] = tone || [];
  const clamp = n => Math.max(-255, Math.min(255, Math.round(Number(n) || 0)));
  const mix = n => Math.max(0, Math.min(255, 128 + Math.round(clamp(n) / 2) + Math.round(clamp(gray) / 4)));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

// Resolves one converter-emitted move step against the live facing. Pure (no
// scene) so tools/test-smoke.mjs can cover the descriptor table in Node.
// Returns { dx, dy }, { jump } or null (degenerate/unknown: toward/away from
// the player itself when the route target is the player).
export function resolveRouteStep(step, facing) {
  if (!step || typeof step !== 'object') return null;
  if (Number.isFinite(step.dx) && Number.isFinite(step.dy)) return { dx: step.dx, dy: step.dy };
  if (step.jump && Number.isFinite(step.jump.dx) && Number.isFinite(step.jump.dy)) {
    return { jump: { dx: step.jump.dx, dy: step.jump.dy } };
  }
  // MV picks a random cardinal direction; diagonals never come out of random.
  if (step.random) {
    const dirs = [[0, 1], [0, -1], [-1, 0], [1, 0]];
    const [dx, dy] = dirs[Math.floor(Math.random() * dirs.length)];
    return { dx, dy };
  }
  const vectors = { down: [0, 1], left: [-1, 0], right: [1, 0], up: [0, -1] };
  const [fx, fy] = vectors[facing] || [0, 1];
  if (step.forward) return { dx: fx, dy: fy };
  if (step.backward) return { dx: -fx, dy: -fy };
  return null;
}

class BreakLoopSignal extends Error {}
class ExitEventSignal extends Error {}
// Thrown by a prepared { goto } marker (see prepareEventCommands) and caught by
// the story driver below. A dedicated signal rather than the runner's own goto
// handling because run() throws on goto instead of running it.
export class JumpSignal extends Error {
  constructor(passage) {
    super(`jump to passage "${passage}"`);
    this.passage = passage;
  }
}

// Exported for tools/test-smoke.mjs: the module has no imports and no
// top-level side effects, so Node can import it and drive this function with
// a stub scene. The browser entry point is unaffected (it uses startMwgPixi).
export function prepareEventCommands(commands, scene) {
  return (commands || []).map(command => {
    if (command.if) return { ...command, then: prepareEventCommands(command.then, scene), ...(command.else ? { else: prepareEventCommands(command.else, scene) } : {}) };
    if (command.loop) return { call: () => scene.runLoop(prepareEventCommands(command.loop, scene)) };
    if (command.breakLoop) return { call: () => { throw new BreakLoopSignal(); } };
    if (command.exitEvent) return { call: () => { throw new ExitEventSignal(); } };
    if (command.goto !== undefined) return { call: () => { throw new JumpSignal(command.goto); } };
    if (command.copyVariable !== undefined) return { call: state => scene.copyVariable(state, command) };
    if (command.inputNumber) return { call: state => scene.inputNumber(state, command) };
    if (command.messageOptions) return { call: () => scene.setMessageOptions(command.messageOptions) };
    if (command.mapSettings) return { call: () => scene.setMapSettings(command.mapSettings) };
    if (command.battle) return { call: async () => {
      const outcome = await scene.startBattle(command.battle);
      const branch = command.battle.branches?.[outcome];
      if (branch) await scene.runBranch(prepareEventCommands(branch, scene));
    } };
    if (command.branches) return { call: () => scene.presentChoice({ ...command, branches: command.branches.map(branch => prepareEventCommands(branch, scene)), cancelBranch: command.cancelBranch && prepareEventCommands(command.cancelBranch, scene) }) };
    if (command.transfer) return { call: state => scene.transfer(command.transfer, state) };
    if (command.picture) return { call: () => scene.showPicture(command.picture) };
    if (command.erasePicture !== undefined) return { call: () => scene.erasePicture(command.erasePicture) };
    if (command.movePicture) return { call: () => scene.movePicture(command.movePicture) };
    if (command.tintPicture) return { call: () => scene.tintPicture(command.tintPicture) };
    if (command.balloon) return { call: () => scene.showBalloon(command.balloon) };
    if (command.animation) return { call: () => scene.playAnimation(command.animation) };
    if (command.scroll) return { call: () => scene.presentScroll(command.scroll) };
    if (command.scrollMap) return { call: () => scene.scrollMap(command.scrollMap) };
    if (command.relocate) return { call: state => scene.relocate(state, command) };
    if (command.saveBgm) return { call: () => scene.saveBgm() };
    if (command.resumeBgm) return { call: () => scene.resumeBgm() };
    if (command.me) return { call: () => scene.playMe(command.me) };
    if (command.menu) return { call: () => scene.unimplementedScene(command.menu) };
    if (command.sound) return { call: () => scene.playSound(command.sound) };
    if (command.stopSound) return { call: () => scene.stopSound() };
    if (command.playBgm) return { call: () => scene.playBgm(command.playBgm) };
    if (command.fadeoutBgm) return { call: () => scene.fadeoutBgm(command.fadeoutBgm) };
    if (command.playBgs) return { call: () => scene.playBgs(command.playBgs) };
    if (command.fadeoutBgs) return { call: () => scene.fadeoutBgs(command.fadeoutBgs) };
    if (command.screenFade) return { call: () => scene.screenFade(command.screenFade) };
    if (command.screenFlash) return { call: () => scene.screenFlash(command.screenFlash) };
    if (command.screenTint) return { call: () => scene.screenTint(command.screenTint) };
    if (command.screenShake) return { call: () => scene.screenShake(command.screenShake) };
    if (command.changeGold !== undefined || command.changeItem !== undefined || command.changeWeapon !== undefined || command.changeArmor !== undefined || command.changeParty !== undefined) return { call: state => scene.applyInventory(state, command) };
    if (command.changeState !== undefined || command.recoverAll !== undefined || command.changeSkill !== undefined || command.changeEquipment !== undefined || command.changeProfile !== undefined) return { call: state => scene.applyActor(state, command) };
    if (command.setTransparent !== undefined) return { call: () => scene.setTransparent(command.setTransparent) };
    if (command.eraseEvent) return { call: () => scene.eraseEvent() };
    if (command.script !== undefined) return { call: () => scene.unsupportedCommand('script', command.script) };
    if (command.pluginCommand) return { call: () => scene.unsupportedCommand('pluginCommand', command.pluginCommand.raw) };
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
  [[0,4],[3,4],[0,5],[3,5]],[[2,2],[3,2],[2,5],[3,5]],[[0,2],[3,2],[0,5],[3,5]],[[0,0],[1,0],[0,1],[1,1]]
];

const WALL_AUTOTILE_TABLE = [
  [[2,2],[1,2],[2,1],[1,1]],[[0,2],[1,2],[0,1],[1,1]],[[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,2],[3,2],[2,1],[3,1]],[[0,2],[3,2],[0,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[0,2],[1,2],[0,3],[1,3]],[[2,0],[1,0],[2,3],[1,3]],[[0,0],[1,0],[0,3],[1,3]],
  [[2,2],[3,2],[2,3],[3,3]],[[0,2],[3,2],[0,3],[3,3]],[[2,0],[3,0],[2,3],[3,3]],[[0,0],[3,0],[0,3],[3,3]]
];

// Only four shapes exist; higher A1 waterfall shapes sample no table and the
// engine leaves those quadrants transparent. Copied from rpg_core.js.
const WATERFALL_AUTOTILE_TABLE = [
  [[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]]
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

// Exported for tools/test-smoke.mjs (pure frame math with a stub mwg).
export function tileToFrame(tile, sheetEntries, sheets, mwg, isXp = false, tilesetFlags = [], xpStaticBase = 0) {
  if (!tile) return mwg.EMPTY;
  if (isXp) {
    // XP autotiles (1..383) are rendered by TileMap.addAutotileLayer. The
    // static tileset image starts at the format's reserved boundary.
    const sheet = sheetEntries.findIndex(entry => entry.slot === 5);
    if (sheet < 0 || tile < xpStaticBase) return mwg.EMPTY;
    return safeTileFrame(mwg, sheet, tile - xpStaticBase, sheets);
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

function addXpCharacterAnimations(sprite, sheet) {
  const rows = { down: 0, left: 1, right: 2, up: 3 };
  for (const [direction, row] of Object.entries(rows)) {
    const first = row * 4;
    sprite.add(`idle-${direction}`, [sheet.get(first + 1)], { fps: 1 });
    sprite.add(`walk-${direction}`, [sheet.get(first), sheet.get(first + 1), sheet.get(first + 2)], { fps: 8 });
  }
  sprite.play('idle-down');
}

function addCharacterAnimations(sprite, sheet, characterIndex, big) {
  const stride = big ? 3 : 12;
  // MV packs four 3x4 character blocks per row pair, not one long row:
  // characterBlockX = (index % 4) * 3 and characterBlockY = floor(index / 4) * 4.
  const base = big ? 0 : (Math.floor((Number(characterIndex) || 0) / 4) * 4 * 12) + ((Number(characterIndex) || 0) % 4) * 3;
  const rows = { down: 0, left: 1, right: 2, up: 3 };
  for (const [direction, row] of Object.entries(rows)) {
    const first = base + row * stride;
    sprite.add(`idle-${direction}`, [sheet.get(first + 1)], { fps: 1 });
    sprite.add(`walk-${direction}`, [sheet.get(first), sheet.get(first + 1), sheet.get(first + 2)], { fps: 8 });
  }
  sprite.play('idle-down');
}

// Frame geometry for one character sheet, from the manifest's characterFrames
// table (measured by the converter from the original PNG IHDR dimensions plus
// the engine's `$`/`!` filename rule). Predates-the-table manifests fall back
// to the filename rule with standard 48px cells. Pure so tests can pin it.
export function characterGeometry(name, entry) {
  if (entry && Number.isFinite(entry.fw) && Number.isFinite(entry.fh) && entry.fw > 0 && entry.fh > 0) {
    return { ...(entry.format ? { format: entry.format } : {}), big: !!entry.big, object: !!entry.object, fw: entry.fw, fh: entry.fh };
  }
  const sign = String(name || '').match(/^[\!\$]+/)?.[0] || '';
  return { big: sign.includes('$'), object: sign.includes('!'), fw: 48, fh: 48 };
}

// Cell index within the sheet, mirroring Sprite_Character's block/pattern
// math (characterBlockX/Y + characterPatternX/Y). Pure so tests can pin it.
export function characterCellIndex(geom, index, direction, pattern) {
  if (geom.format === 'xp') {
    const row = { 2: 0, 4: 1, 6: 2, 8: 3 }[direction] ?? 0;
    return row * 4 + Math.min(3, pattern ?? 1);
  }
  const stride = geom.big ? 3 : 12;
  const characterIndex = Number(index) || 0;
  const base = geom.big ? 0 : (Math.floor(characterIndex / 4) * 4 * 12) + (characterIndex % 4) * 3;
  const row = { 2: 0, 4: 1, 6: 2, 8: 3 }[direction] ?? 0;
  return base + row * stride + Math.min(2, pattern ?? 1);
}

// On-screen pixel size plus the engine's upward shift (Game_CharacterBase
// shiftY: 6px, or 0 for `!` object characters), at the tile grid's scale.
export function characterPixelSize(geom, tileSize) {
  const scale = tileSize / 48;
  return { w: geom.fw * scale, h: geom.fh * scale, shift: (geom.object ? 0 : 6) * scale };
}

function directionBit(dx, dy) {
  if (dy > 0) return 0x01;
  if (dx < 0) return 0x02;
  if (dx > 0) return 0x04;
  return 0x08;
}
