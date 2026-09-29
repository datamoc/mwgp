import { AudioManager } from './audio-manager.js';
import { runBattle, createPicker, expForLevel } from './battle.js';
import { runMenu } from './menu.js';
import { stagePositions } from './formation.js';

export 
// ---- MV's window colours and gauges ------------------------------------------------------------------------------
// Game text colours are pixels of Window.png: colour n sits at (96 + n % 8 * 12 + 6, 144 + floor(n / 8) * 12 + 6). The gauges use
// 19 (back), 20/21 (HP), 22/23 (MP) and 28/29 (TP), the text 0 (normal), 17 (crisis) and 18 (knockout). The defaults are the
// engine's stock Window.png values, used until (or unless) the game's own file is read.
const STOCK_PALETTE = { text: 0xffffff, crisis: 0xffff40, knockout: 0xff2020, gaugeBack: 0x202040, hp: [0xe08040, 0xf0c040], mp: [0x40c0f0, 0x80e0ff], tp: [0x40c040, 0x80e080] };
let windowPalette = STOCK_PALETTE;
export const gaugePalette = () => windowPalette;

function readWindowPalette(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const colour = index => {
    const x = 96 + (index % 8) * 12 + 6, y = 144 + Math.floor(index / 8) * 12 + 6;
    if (x >= bitmap.width || y >= bitmap.height) return null;
    const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
    return a ? (r << 16) | (g << 8) | b : null;
  };
  const pick = (index, fallback) => colour(index) ?? fallback;
  windowPalette = {
    text: pick(0, STOCK_PALETTE.text), crisis: pick(17, STOCK_PALETTE.crisis), knockout: pick(18, STOCK_PALETTE.knockout), gaugeBack: pick(19, STOCK_PALETTE.gaugeBack),
    hp: [pick(20, STOCK_PALETTE.hp[0]), pick(21, STOCK_PALETTE.hp[1])], mp: [pick(22, STOCK_PALETTE.mp[0]), pick(23, STOCK_PALETTE.mp[1])], tp: [pick(28, STOCK_PALETTE.tp[0]), pick(29, STOCK_PALETTE.tp[1])]
  };
}

// The actor sprite motions of Sprite_Actor (sv_actors.png: 9 columns x 6 rows, three patterns per motion; motion `index` sits at
// column floor(index / 6) * 3 + pattern, row index % 6). Looping motions run 0,1,2,1; the others 0,1,2 and then return to the idle pose.
export const SV_MOTIONS = {
  walk: { index: 0, loop: true }, wait: { index: 1, loop: true }, chant: { index: 2, loop: true }, guard: { index: 3, loop: true },
  damage: { index: 4, loop: false }, evade: { index: 5, loop: false }, thrust: { index: 6, loop: false }, swing: { index: 7, loop: false },
  missile: { index: 8, loop: false }, skill: { index: 9, loop: false }, spell: { index: 10, loop: false }, item: { index: 11, loop: false },
  escape: { index: 12, loop: true }, victory: { index: 13, loop: true }, dying: { index: 14, loop: true }, abnormal: { index: 15, loop: true },
  sleep: { index: 16, loop: true }, dead: { index: 17, loop: true }
};
const SV_PATTERN_SECONDS = 12 / 60;   // Sprite_Actor.motionSpeed: 12 frames per pattern
// Index into the sheet's row-major cell grid for a motion's pattern.
export function svCell(motion, pattern) {
  const def = SV_MOTIONS[motion] || SV_MOTIONS.wait;
  return (def.index % 6) * 9 + Math.floor(def.index / 6) * 3 + pattern;
}
// The pattern shown `elapsed` seconds into a motion, and whether a non-looping motion has finished.
export function svPattern(motion, elapsed) {
  const def = SV_MOTIONS[motion] || SV_MOTIONS.wait;
  const step = Math.floor(elapsed / SV_PATTERN_SECONDS);
  if (def.loop) return { pattern: [0, 1, 2, 1][step % 4], done: false };
  return { pattern: Math.min(2, step), done: step >= 3 };
}
// Sprite_Actor.refreshMotion for a battler that is not acting: state motion (dead/sleep), guard, abnormal state, dying, else wait.
export function svIdleMotion(actor, database) {
  const states = (actor.states || []).map(entry => database?.states?.[entry.id]).filter(Boolean).sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  const stateMotion = actor.dead ? 3 : Number(states[0]?.motion || 0);
  if (stateMotion === 3) return 'dead';
  if (stateMotion === 2) return 'sleep';
  if (actor.isGuarding) return 'guard';
  if (stateMotion === 1) return 'abnormal';
  if (actor.isDying) return 'dying';
  return 'wait';
}
// The motion of an action (Game_Actor.performAction): the weapon's attack motion for the attack skill, spell for magic skills,
// skill for other skills, item for items.
export function svActionMotion(actor, item, isItem, database) {
  if (isItem) return 'item';
  const system = database?.system || {};
  if (item && item === database?.skills?.[Number(system.battleIds?.attackSkill ?? 1)]) {
    const weapon = actor.equipItems?.()[0];
    const motion = system.attackMotions?.[Number(weapon?.wtypeId || 0)];
    return motion ? ['thrust', 'swing', 'missile'][Number(motion.type)] || 'swing' : 'swing';
  }
  return (system.magicSkills || []).includes(Number(item?.stypeId)) ? 'spell' : 'skill';
}

// The game's own font (manifest display.font, copied by the converter): loaded as GameFont and made the window theme's font at
// the engine's size (MV 28, MZ advanced.fontSize) scaled to the canvas, line height size + 8 as the engine's `lineHeight` 36.
async function applyGameFont(mwg, project, assetRoot, pixelHeight) {
  const font = project.display?.font;
  if (!font?.file || !assetRoot || !mwg.setTheme || typeof FontFace === 'undefined') return;
  const face = new FontFace(font.family || 'GameFont', `url(${assetRoot}/fonts/${encodeURIComponent(font.file)})`);
  await face.load();
  document.fonts.add(face);
  const scale = pixelHeight && project.display?.height ? pixelHeight / Number(project.display.height) : 1;   // the canvas is sized to the page, the design to display.height
  const size = Number(font.size || 28) * scale;
  // setTheme rebuilds from the library defaults, not from the current theme, so merge with what is set; lineHeight is a multiplier of the size.
  const current = mwg.theme?.() || {};
  mwg.setTheme({ ...current, font: { ...(current.font || {}), family: `${font.family || 'GameFont'}, ${font.fallback || 'sans-serif'}`, size, lineHeight: (Number(font.size || 28) + 8) / Number(font.size || 28) } });
}

// MV's Window.png: a 96x96 background at (0,0) and the 96x96 frame at (96,0) with 24px corners. Composed into one
// nine-patch texture and installed as mw_games' window theme, so every dialogue, choice and menu window takes the
// engine's frame instead of the library default. White text on the frame, as in the engine's default window.
async function applyWindowSkin(mwg, url) {
  if (!mwg.setTheme || !mwg.Texture2D || typeof document === 'undefined') return;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  if (bitmap.width < 192 || bitmap.height < 96) return;   // not a stock Window.png layout
  try { readWindowPalette(bitmap); } catch (error) { console.warn('MWGP window colours not read; using the stock palette', error); }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, 96, 96, 0, 0, 96, 96);
  // The engine draws only the frame's four corners and edges (24px); its middle holds the arrow and pause sprites.
  const frame = document.createElement('canvas');
  frame.width = frame.height = 96;
  const frameContext = frame.getContext('2d');
  frameContext.drawImage(bitmap, 96, 0, 96, 96, 0, 0, 96, 96);
  frameContext.clearRect(24, 24, 48, 48);
  context.drawImage(frame, 0, 0);
  const current = mwg.theme?.() || {};
  mwg.setTheme({ ...current, panel: mwg.Texture2D.from(canvas), panelBorder: 24, padding: 0, color: { ...(current.color || {}), text: 0xffffff, textHighlight: 0xffffff } });
}

export function normalizeDialogueMarkup(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:i|em)\b[^>]*>/gi, '*')
    .replace(/<\/?(?:b|strong)\b[^>]*>/gi, '**');
}

function plainDialogueText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:i|em|b|strong)\b[^>]*>/gi, '');
}

// Older MWG bundles construct MessageBox text with a plain Label. RPG Maker
// text commonly contains inline <i>/<b> tags, so upgrade the body when the
// bundle exposes RichLabel. Choices stay plain because ListView still uses a
// regular Label. RichLabel owns the reveal so markup markers never leak.
function createDialogueBox(mwg, options) {
  const pages = (options.pages || []).map(page => typeof page === 'string'
    ? normalizeDialogueMarkup(page)
    : { ...page, text: normalizeDialogueMarkup(page.text) });
  const choices = (options.choices || []).map(choice => ({ ...choice, text: plainDialogueText(choice.text) }));
  const box = new mwg.MessageBox({ ...options, pages, choices });
  if (!mwg.RichLabel || !box.body || !box.content) return box;
  const oldBody = box.body;
  const body = new mwg.RichLabel({
    wrapWidth: box.contentWidth,
    tagStyles: {
      i: { fontStyle: 'italic' },
      em: { fontStyle: 'italic' },
      b: { fontWeight: 'bold' },
      strong: { fontWeight: 'bold' }
    }
  });
  body.x = oldBody.x;
  body.y = oldBody.y;
  box.content.removeChild(oldBody);
  oldBody.destroy();
  box.content.addChild(body);
  box.body = body;
  let renderedPage = box.pageIndex;
  body.showProgressive(box.pageText, options.speed ?? 40);
  box.renderBody = () => {
    if (renderedPage === box.pageIndex) return;
    renderedPage = box.pageIndex;
    body.showProgressive(box.pageText, options.speed ?? 40);
  };
  const update = box.update.bind(box);
  box.update = dt => {
    body.updateReveal(dt);
    update(dt);
  };
  const handleAction = box.handleAction.bind(box);
  box.handleAction = action => {
    if (action === 'confirm' && !box.pageComplete) body.completeReveal();
    return handleAction(action);
  };
  return box;
}

// MV/MZ plugin and engine sources ship as files next to the manifest (tools/mv-plugins.mjs
// `externalizePluginLibrary`); fetch them before any script can run. A file that cannot be had drops
// that plugin (loudly) instead of the whole library.
async function loadPluginFiles(project) {
  const library = project.pluginLibrary;
  if (!library?.files) return;
  const root = library.root || '';
  const fetchText = async file => { const response = await fetch(`${root}/${file.split('/').map(encodeURIComponent).join('/')}`); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); };
  library.sources ||= {};
  library.engineSources ||= {};
  await Promise.all([
    ...Object.entries(library.files.plugins || {}).map(([name, file]) => fetchText(file).then(text => { library.sources[name] = text; }, error => { console.warn(`MWGP plugin "${name}" could not be loaded (${error?.message || error}); it is skipped`); library.order = (library.order || []).filter(entry => entry !== name); })),
    ...Object.entries(library.files.engine || {}).map(([name, file]) => fetchText(file).then(text => { library.engineSources[name] = text; }, error => console.warn(`MWGP engine file "${name}" could not be loaded (${error?.message || error})`)))
  ]);
  if (!Object.keys(library.engineSources).length) delete library.engineSources;
}

// The game's Marshal data files (`Data/*.dat`, exported by tools/rgss-data.mjs): fetched before any script can run, since
// `load_data` and the GameData registries read them synchronously. A file that cannot be had is skipped loudly.
async function loadRubyData(project) {
  const data = project.rubyData;
  if (!data?.files?.length || !project.assets?.root) return;
  data.tables = {};
  await Promise.all(data.files.map(async name => {
    try {
      const response = await fetch(`${project.assets.root}/${data.root}/${encodeURIComponent(name)}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data.tables[name] = await response.json();
    } catch (error) { console.warn(`MWGP Data/${name} could not be loaded (${error.message}); load_data on it will fail`); }
  }));
}

const SLOT_COUNT = 5;

export async function startMwgPlayer(canvas, project) {
  await loadPluginFiles(project);
  await loadRubyData(project);
  // Loaded here rather than statically so prepareEventCommands stays importable from Node.
  const { createRgssRuntime } = await import(`/rgss-script.js?v=${Date.now()}`);
  const mwg = globalThis.mw_games;
  if (!mwg?.Game || !mwg?.Scene2D || !mwg?.TileMap || !mwg?.SpriteSheet) throw new Error('mw_games 2D runtime is unavailable');
  // Transfers and cross-map loads round-trip through the URL. Prefer the
  // requested map when present, while retaining the manifest start map for a
  // clean launch and a safe fallback for malformed/stale URLs.
  const params = new URLSearchParams(globalThis.location?.search || '');
  const requestedMapId = params.has('map') ? Number(params.get('map')) : NaN;
  const startMapId = Number(project.initialMapId);
  const mapEntry = project.maps.find(map => Number(map.id) === requestedMapId)
    || project.maps.find(map => Number(map.id) === startMapId)
    || project.maps[0];
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
  const requestedX = params.has('x') ? Number(params.get('x')) : NaN;
  const requestedY = params.has('y') ? Number(params.get('y')) : NaN;
  if (Number.isFinite(requestedX)) position.x = requestedX;
  if (Number.isFinite(requestedY)) position.y = requestedY;
  // Change Tileset (282) reloads the map with `&tileset=<id>` (the tileset is fixed when the scene is built).
  const tilesetId = params.has('tileset') && Number.isFinite(Number(params.get('tileset'))) && project.tilesets?.[Number(params.get('tileset'))] ? Number(params.get('tileset')) : map.tilesetId;
  const tilesetFlags = project.tilesets?.[tilesetId]?.flags || [];
  const assetRoot = project.assets?.kind === 'decoded' ? project.assets.root : null;
  const tileset = project.tilesets?.[tilesetId];
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
  // A single broken or stalled optional asset must not hold the complete game
  // startup hostage. The underlying request may finish later and be cached by
  // MWG, but scene creation gets a bounded failure and can use its normal
  // missing-asset fallback.
  const loadResource = url => {
    let timer;
    return Promise.race([
      Promise.resolve().then(() => mwg.Resources.load([url])),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`asset load timeout: ${url}`)), 12000); })
    ]).finally(() => clearTimeout(timer));
  };
  const hasNativeAutotiles = typeof mwg.TileMap.prototype?.addAutotileLayer === 'function';
  const sheetResults = await Promise.allSettled(sheetUrls.map(loadResource));
  const missingSheets = sheetEntries.filter((_, index) => sheetResults[index]?.status !== 'fulfilled');
  const placeholderUrl = missingSheets.length ? placeholderSheet() : null;
  if (placeholderUrl) await loadResource(placeholderUrl);
  const renderSheetEntries = sheetEntries.map((entry, index) => sheetResults[index]?.status === 'fulfilled' ? entry : { ...entry, url: placeholderUrl });
  const fallbackSheetUrl = renderSheetEntries[0]?.url || placeholderSheet();
  for (const entry of missingSheets) console.warn(`MWGP tileset sheet '${entry.url}' is missing; using a placeholder for slot ${entry.slot}`);
  // MV A4 (slot 3) is drawn by the library's native autotile layer (`mode: 'mixed'`: floor and wall tables by kind row)
  // when the library also carries the table-edge strip and shadow layer this player pairs with it; older libraries
  // keep the static atlas for every family. A placeholder standing in for a missing sheet has no autotile art to sample.
  const hasEngineExtras = typeof mwg.TileMap.prototype?.addShadowLayer === 'function';
  const mvA4Native = hasNativeAutotiles && hasEngineExtras && !isXp && renderSheetEntries.some(entry => entry.slot === 3 && entry.url !== placeholderUrl);
  const sheets = await Promise.all(renderSheetEntries.map(entry => entry.slot < 4 && !(mvA4Native && entry.slot === 3)
    ? buildAutotileSheet(entry.url, entry.slot, mwg, tilesetFlags)
    : Promise.resolve(mwg.SpriteSheet.grid(entry.url, tileSize))));
  const mvA4Sheet = mvA4Native ? sheets[renderSheetEntries.findIndex(entry => entry.slot === 3)] : null;
  // The A2 sheet stays on the atlas; its table-edge strips read the raw sheet.
  const mvA2Entry = renderSheetEntries.find(entry => entry.slot === 1 && entry.url !== placeholderUrl);
  const mvA2Raw = hasEngineExtras && !isXp && mvA2Entry ? mwg.SpriteSheet.grid(mvA2Entry.url, tileSize) : null;
  const xpAutotileUrls = xpAutotileEntries.map(entry => entry.url);
  const xpAutotileResults = isXp ? await Promise.allSettled(xpAutotileUrls.map(loadResource)) : [];
  const xpAutotileSheets = isXp ? xpAutotileEntries.filter((_, index) => xpAutotileResults[index]?.status === 'fulfilled').map(entry => ({ ...entry, sheet: mwg.SpriteSheet.grid(entry.url, 16) })) : [];
  for (const entry of xpAutotileEntries.filter((_, index) => xpAutotileResults[index]?.status !== 'fulfilled')) console.warn(`MWGP XP autotile '${entry.url}' is missing; keeping the compatibility path for this map`);
  // XP's autotile layout is uniform per source image and maps directly to MWG; MV A4 rides `mode: 'mixed'` (above).
  const nativeAutotilesReady = hasNativeAutotiles && isXp && xpAutotileEntries.length > 0 && xpAutotileSheets.length === xpAutotileEntries.length;
  const playerUrl = project.assets?.characters && project.playerSprite?.name ? `${project.assets.root}/img/characters/${encodeURIComponent(project.playerSprite.name)}.png` : null;
  const eventNames = [...new Set([...(mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => [page.image?.name, ...collectRouteImageNames(page.commands)])), ...Object.values(project.commonEvents || {}).flatMap(commands => collectRouteImageNames(commands))].filter(Boolean))];
  const eventUrls = project.assets?.characters ? eventNames.map(name => `${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`) : [];
  const portraitNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPortraitNames(page.commands))))];
  const portraitUrls = project.assets?.faces ? portraitNames.map(name => `${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`) : [];
  const pictureNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectPictureNames(page.commands))))];
  const pictureUrls = project.assets?.pictures ? pictureNames.map(name => `${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`) : [];
  const soundNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectSoundNames(page.commands))))];
  const musicNames = [...new Map((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectMusicNames(page.commands))).map(entry => [`${entry.dir}/${entry.name}`, entry])).values()];
  const mapSettings = map.settings || {};
  const initialPanoramaUrl = isXp && assetRoot && mapSettings.panoramaName ? `${assetRoot}/graphics/Panoramas/${encodeURIComponent(mapSettings.panoramaName)}.png` : null;
  const initialFogUrl = isXp && assetRoot && mapSettings.fogName ? `${assetRoot}/graphics/Fogs/${encodeURIComponent(mapSettings.fogName)}.png` : null;
  // Foreground.js over-map mist (MV/MZ map notes, converter: data.settings).
  const foregroundUrlFor = settings => project.assets?.parallaxes && assetRoot && settings?.name ? `${assetRoot}/img/parallaxes/${encodeURIComponent(settings.name)}.png` : null;
  const initialForegroundUrl = foregroundUrlFor(mapSettings.foreground);
  const initialForegroundBUrl = foregroundUrlFor(mapSettings.foregroundB);
  // MV/MZ map parallax (properties: image, loop, scroll speed); '!' in front of the name means it scrolls with the map.
  const parallaxUrlFor = name => project.assets?.parallaxes && assetRoot && name ? `${assetRoot}/img/parallaxes/${encodeURIComponent(name)}.png` : null;
  const windowSkinUrl = project.assets?.windowSkin && assetRoot ? `${assetRoot}/img/system/Window.png` : null;
  const initialParallaxUrl = !isXp && map.parallaxShow !== false ? parallaxUrlFor(map.parallaxName) : null;
  const balloonUrl = project.assets?.system ? `${project.assets.root}/img/system/Balloon.png` : null;
  const animationSheetNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectAnimationSheetNames(page.commands, project.database?.animations))))];
  const animationUrls = project.assets?.animations ? animationSheetNames.map(name => `${project.assets.root}/img/animations/${encodeURIComponent(name)}.png`) : [];
  const meNames = [...new Set((mapEntry?.mwgEvents || []).flatMap(event => event.pages.flatMap(page => collectMeNames(page.commands))))];
  const optionalUrls = [...new Set([...(playerUrl ? [playerUrl] : []), ...eventUrls, ...portraitUrls, ...pictureUrls, ...(balloonUrl ? [balloonUrl] : []), ...animationUrls, ...(initialPanoramaUrl ? [initialPanoramaUrl] : []), ...(initialFogUrl ? [initialFogUrl] : []), ...(initialForegroundUrl ? [initialForegroundUrl] : []), ...(initialForegroundBUrl ? [initialForegroundBUrl] : []), ...(initialParallaxUrl ? [initialParallaxUrl] : []), ...(windowSkinUrl ? [windowSkinUrl] : [])])];
  // A project can reference an optional/plugin-generated image that is absent
  // from the distributed archive. Load each asset independently so one stale
  // reference does not discard the complete Pixi renderer.
  const loadResults = await Promise.allSettled(optionalUrls.map(loadResource));
  const loadedUrls = new Set(optionalUrls.filter((_, index) => loadResults[index].status === 'fulfilled'));
  await applyGameFont(mwg, project, assetRoot, canvas?.clientHeight || 0).catch(error => console.warn('MWGP game font not applied', error));
  if (windowSkinUrl && loadedUrls.has(windowSkinUrl)) await applyWindowSkin(mwg, windowSkinUrl).catch(error => console.warn('MWGP window skin not applied', error));
  // Character sheets are sliced by the converter-measured frame geometry
  // (manifest characterFrames), never by assuming 48px cells: the engine's
  // own rule divides the bitmap by a $-prefix 3x4 grid or a standard 12x8 one.
  const playerGeom = characterGeometry(project.playerSprite?.name, project.characterFrames?.[project.playerSprite?.name]);
  const playerSheet = playerUrl && loadedUrls.has(playerUrl) ? mwg.SpriteSheet.grid(playerUrl, playerGeom.fw, playerGeom.fh) : null;
  const eventGeoms = new Map(project.assets?.characters ? eventNames.map(name => [name, characterGeometry(name, project.characterFrames?.[name])]) : []);
  const eventSheets = new Map(project.assets?.characters ? eventNames.filter((_, index) => loadedUrls.has(eventUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/characters/${encodeURIComponent(name)}.png`, eventGeoms.get(name).fw, eventGeoms.get(name).fh)]) : []);
  const portraitSheets = new Map(project.assets?.faces ? portraitNames.filter((_, index) => loadedUrls.has(portraitUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/faces/${encodeURIComponent(name)}.png`, 144)]) : []);
  const pictureTextures = new Map(project.assets?.pictures ? pictureNames.filter((_, index) => loadedUrls.has(pictureUrls[index])).map(name => [name, mwg.Resources.texture(`${project.assets.root}/img/pictures/${encodeURIComponent(name)}.png`)]) : []);
  // Balloon.png is an 8-column strip per balloon row (48px cells, 15 rows);
  // animation sheets are 192px cells. Both verified against project data.
  const balloonSheet = balloonUrl && loadedUrls.has(balloonUrl) ? mwg.SpriteSheet.grid(balloonUrl, 48) : null;
  const animationSheets = new Map(project.assets?.animations ? animationSheetNames.filter((_, index) => loadedUrls.has(animationUrls[index])).map(name => [name, mwg.SpriteSheet.grid(`${project.assets.root}/img/animations/${encodeURIComponent(name)}.png`, 192)]) : []);
  // Audio: BGM/BGS/ME/SE with volume, pitch and pan, format-independent (see audio-manager.js).
  // The manager is created only for decoded projects; tracks decode lazily on first use, and the
  // sounds this map's events and the engine itself use are warmed up front.
  const audio = assetRoot && project.assets?.audio ? new AudioManager({ root: assetRoot, lib: mwg.Audio, index: project.audio?.index, cacheVersion: project.source?.convertedAt || '', soundfontUrls: [project.audio?.soundfont ? `${assetRoot}/audio/${project.audio.soundfont}` : null, '/soundfont.sf2'].filter(Boolean) }) : null;
  if (audio) {
    const systemTracks = project.audio?.system || {};
    audio.preload([
      ...soundNames.map(name => ({ kind: 'se', name })), ...meNames.map(name => ({ kind: 'me', name })),
      ...Object.values(systemTracks.sounds || {}).map(track => ({ kind: 'se', name: track.name }))
    ]);
    audio.unlock();
  }
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
  const isAutotile = tile => isXp ? tile > 0 && tile < xpStaticBase : tile >= 2048 && tile < 8192;
  // Cells a native autotile layer draws instead of the static atlas: every XP autotile, and MV A4 (ids 5888-8191).
  const isNativeAutotile = tile => isXp ? nativeAutotilesReady && isAutotile(tile) : mvA4Native && tile >= 5888 && tile < 8192;
  const layers = Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => isXp && isAboveTile(tile) || isNativeAutotile(tile) ? mwg.EMPTY : tileToFrame(tile, renderSheetEntries, sheets, mwg, isXp, tilesetFlags, xpStaticBase)));
  // An XP autotile id (48 per slot) whose slot has no image in the tileset (or a missing file) has no set to
  // resolve against, and addAutotileLayer throws on it; such cells draw nothing (as RPG Maker does).
  const xpAutotileSlots = new Set(xpAutotileSheets.map(entry => entry.index));
  const hasAutotileSet = tile => xpAutotileSlots.has(Math.floor(tile / 48));   // XP ids 48..383: slot = floor(id / 48), 1-based like autotileNames
  const xpAutotileLayers = isXp ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => tile > 0 && tile < xpStaticBase && !isAboveTile(tile) && hasAutotileSet(tile) ? tile : mwg.EMPTY)) : [];
  const effectiveTiles = Array.from({ length: map.width * map.height }, (_, cell) => {
    for (let layer = 3; layer >= 0; layer--) {
      const tile = Number(map.data?.[layer * map.width * map.height + cell] || 0);
      if (tile) return tile;
    }
    return 0;
  });
  const aboveLayers = isXp
    ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => isAboveTile(tile) && !isNativeAutotile(tile) ? tileToFrame(tile, renderSheetEntries, sheets, mwg, isXp, tilesetFlags, xpStaticBase) : mwg.EMPTY))
    : [effectiveTiles.map(tile => isAboveTile(tile) && !isNativeAutotile(tile) ? tileToFrame(tile, renderSheetEntries, sheets, mwg, isXp, tilesetFlags, xpStaticBase) : mwg.EMPTY)];
  // MV A4 cells, layer by layer: the ones drawn beneath characters, and (as one sparse layer, like the atlas path) the effective star tiles above them.
  const isA4Cell = tile => tile >= 5888 && tile < 8192;
  const mvA4Layers = mvA4Native ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => isA4Cell(tile) && !isAboveTile(tile) ? tile : mwg.EMPTY)) : [];
  const mvA4AboveLayer = mvA4Native ? effectiveTiles.map(tile => isA4Cell(tile) && isAboveTile(tile) ? tile : mwg.EMPTY) : null;
  // Map layer 4 holds shadow bits and the engine draws them after layers 0-1; a table's front edge goes on the cell below it.
  const shadowBits = hasEngineExtras && !isXp ? rpgmLayer(map, 4) : null;
  const hasShadow = shadowBits?.some(bits => (bits & 0x0f) !== 0);
  const tableEdgeCells = mvA2Raw && !isXp ? mwg.rpgmTableEdgeCells({ width: map.width, height: map.height, ground: rpgmLayer(map, 0), objects: rpgmLayer(map, 1), flags: tilesetFlags }) : null;
  const hasTableEdge = tableEdgeCells?.some(tile => tile > 0);
  const xpAboveAutotileLayers = isXp ? Array.from({ length: 4 }, (_, index) => rpgmLayer(map, index).map(tile => tile > 0 && tile < xpStaticBase && isAboveTile(tile) && hasAutotileSet(tile) ? tile : mwg.EMPTY)) : [];
  const PlayerScene = class extends mwg.Scene2D {
    create() {
      this.project = project;
      this.tileMap = new mwg.TileMap({ width: map.width, height: map.height, sheet: sheets, tileWidth: tileSize, tileHeight: tileSize });
      this.panorama = initialPanoramaUrl && loadedUrls.has(initialPanoramaUrl) && mwg.TiledSprite ? new mwg.TiledSprite({ texture: mwg.Resources.texture(initialPanoramaUrl), width: game.width, height: game.height }) : null;
      if (this.panorama) this.stage.addChild(this.panorama);
      // MV/MZ parallax: the far background behind the tilemap; Change Parallax (284) replaces it.
      this.parallax = null;
      this.parallaxState = { name: '', loopX: false, loopY: false, sx: 0, sy: 0, driftX: 0, driftY: 0 };
      if (initialParallaxUrl && loadedUrls.has(initialParallaxUrl) && mwg.TiledSprite) this.installParallax({ name: map.parallaxName, loopX: map.parallaxLoopX === true, loopY: map.parallaxLoopY === true, sx: map.parallaxSx, sy: map.parallaxSy }, initialParallaxUrl);
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
      // RPG Maker sorts character sprites by their feet position, not by the
      // order in which events happen to appear in the JSON. Keep the map's
      // priority layer above characters and let the character layer sort by
      // depth as actors move.
      this.world = world;
      world.sortableChildren = true;
      layers.forEach((data, index) => {
        this.tileMap.addLayer(`rpgm-${index}`, data);
        if (isXp && xpAutotileSheets.length) this.tileMap.addAutotileLayer(`rpgm-xp-${index}`, xpAutotileLayers[index], xpAutotileSheets.map(entry => ({ sheet: entry.sheet, format: 'rpgm-xp', index: entry.index })));
        if (mvA4Native) this.tileMap.addAutotileLayer(`rpgm-a4-${index}`, mvA4Layers[index], { sheet: mvA4Sheet, slot: 3, mode: 'mixed' });
        if (index === 1 && hasShadow) this.tileMap.addShadowLayer('rpgm-shadow', shadowBits.map(bits => bits & 0x0f));
        if (index === 1 && hasTableEdge) this.tileMap.addAutotileLayer('rpgm-table-edge', tableEdgeCells, { sheet: mvA2Raw, slot: 1, tableEdge: true });
      });
      world.addChild(this.tileMap);
      this.tileMap.zIndex = 0;
      this.aboveMap = new mwg.TileMap({ width: map.width, height: map.height, sheet: sheets, tileWidth: tileSize, tileHeight: tileSize });
      aboveLayers.forEach((data, index) => {
        this.aboveMap.addLayer(`rpgm-above-${index}`, data);
        if (isXp && xpAutotileSheets.length) this.aboveMap.addAutotileLayer(`rpgm-xp-above-${index}`, xpAboveAutotileLayers[index], xpAutotileSheets.map(entry => ({ sheet: entry.sheet, format: 'rpgm-xp', index: entry.index })));
      });
      if (mvA4AboveLayer) this.aboveMap.addAutotileLayer('rpgm-a4-above', mvA4AboveLayer, { sheet: mvA4Sheet, slot: 3, mode: 'mixed' });
      this.aboveMap.zIndex = 1000000000;
      this.fog = initialFogUrl && loadedUrls.has(initialFogUrl) && mwg.TiledSprite ? new mwg.TiledSprite({ texture: mwg.Resources.texture(initialFogUrl), width: game.width, height: game.height }) : null;
      if (this.fog) { this.fog.alpha = Math.max(0, Math.min(1, Number(mapSettings.fogOpacity ?? 0) / 255)); this.stage.addChild(this.fog); }
      // Foreground.js mist sits above the whole world (characters included)
      // like the engine's _baseSprite layer; updateForeground picks A/B by
      // switch and scrolls the origin with the map. A referenced file that did
      // not decode warns once here instead of failing the scene silently.
      const makeForeground = (settings, url) => settings && url && loadedUrls.has(url) && mwg.TiledSprite ? new mwg.TiledSprite({ texture: mwg.Resources.texture(url), width: game.width, height: game.height }) : null;
      this.foregroundA = makeForeground(mapSettings.foreground, initialForegroundUrl);
      this.foregroundB = makeForeground(mapSettings.foregroundB, initialForegroundBUrl);
      if (this.foregroundA) this.stage.addChild(this.foregroundA);
      if (this.foregroundB) this.stage.addChild(this.foregroundB);
      this.foregroundDrift = { ax: 0, ay: 0, bx: 0, by: 0 };
      if ((mapSettings.foreground || mapSettings.foregroundB) && !this.foregroundA && !this.foregroundB) console.warn(`MWGP foreground ${mapSettings.foreground?.name || mapSettings.foregroundB?.name} on map ${mapEntry.id} did not load; reconvert with foreground art decoded`);
      // Placed directly above the map, below every sprite/window layer added further down,
      // so a fade or flash washes the world without obscuring dialogue text on top of it.
      this.screenEffects = mwg.ScreenEffects ? new mwg.ScreenEffects({ width: game.width, height: game.height }) : null;
      if (this.screenEffects) this.stage.addChild(this.screenEffects);
      mwg.Input.attach();
      this.cooldown = 0;
      this.autotileFrame = 0;
      this.autotileElapsed = 0;
      this.messageOptions = { position: 2, frame: 0 };
      this.audio = audio;
      // MV Scroll Map pans belong to the map: a transfer rebuilds the scene
      // and resets them, matching MV where scrolling does not survive a move.
      this.cameraPan = { x: 0, y: 0 };
      this.panTween = null;
      this.facing = 'down';
      this.gameState = new mwg.Rpg.GameState();
      // Party, inventory and gold have no home in mw_games' GameState (switches
      // and variables only), so the player carries them alongside it and saves
      // them through the same transfer/save payloads below.
      this.rpgExtra = { ...freshExtraState(), party: [...(project.initialParty || [])] };
      this.erasedEvents = new Set();
      this.eventAlpha = new Map();
      this.mapRuntime = {};
      this.pendingRuntimeState = null;
      this.currentEvent = null;
      this.commonEventDepth = 0;
      this.rgss = createRgssRuntime(this, { mapId: mapEntry.id, mapEvents: mapEntry.mwgEvents || [], mapSize: { width: map.width, height: map.height }, library: project.rubyLibrary, pluginLibrary: project.pluginLibrary, rubyData: project.rubyData?.tables, fileIndex: project.fileIndex, textFiles: project.textFiles, dialect: isXp ? 'rgss' : 'mv' });
      this.shake = null;
      this.saves = new mwg.SaveSystem({ namespace: `mwgp:${project.source?.projectName || 'project'}`, version: 1 });
      const newGame = new URLSearchParams(globalThis.location?.search || '').get('newGame') === '1';
      if (newGame) {
        try { this.saves.delete('runtime-transition'); } catch (error) { console.warn('MWGP new-game transition cleanup failed', error); }
        const clean = new URL(globalThis.location.href); clean.searchParams.delete('newGame'); history.replaceState(null, '', clean);
      }
      let transition = null;
      if (!newGame) {
        try { transition = this.saves.load('runtime-transition'); } catch (error) { console.warn('MWGP transition load failed; starting fresh', error); }
      }
      if (transition?.state?.rpg) {
        try {
          const entry = (project.maps || []).find(map => Number(map.id) === Number(transition.state.mapId));
          if (!entry) throw new Error(`unknown map ${transition.state.mapId}`);
          const next = sanitizeMapPosition({ x: transition.state.x, y: transition.state.y }, entry);
          position.x = next.x; position.y = next.y;
          this.facing = transition.state.facing || 'down';
          this.gameState = mwg.Rpg.GameState.fromJSON(transition.state.rpg);
          if (transition.state.extra) this.rpgExtra = { ...freshExtraState(), ...transition.state.extra };
          this.pendingRuntimeState = transition.state;
        } catch (error) { console.warn('MWGP transition state was invalid; starting fresh on the start map', error); }
        try { this.saves.delete('runtime-transition'); } catch { /* headless */ }
      }
      // Carry the music across the page reload a map transfer causes (same track continues from
      // its position), then let the map's own autoplay BGM/BGS take over like the engine does.
      if (this.audio) {
        this.audio.restore(transition?.state?.audio);
        this.applyMapAudio();
      }
      this.eventSprites = [];
      this.vehicleSprites = [];
      this.rpgExtra.vehicles = { ...(project.vehicles || {}), ...(this.rpgExtra.vehicles || {}) };
      this.activeVehicle = this.rpgExtra.activeVehicle || null;
      // Sprites render at their sheet's natural cell size (scaled to the tile
      // grid), feet-anchored like the engine: Sprite_Character centers x on
      // the tile and puts the sprite bottom at the tile bottom minus shiftY
      // (6px, or 0 for `!` object characters).
      this.saveKey = event => { if (event.key === 'F5') { event.preventDefault(); this.saveGame(); } if (event.key === 'F9') { event.preventDefault(); this.loadGame(); } if ((event.key === 'Escape' || event.key === 'x' || event.key === 'X') && !this.dialogue && !this.eventRunning && !this.menuOpen && this.rpgExtra?.system?.menuAccess !== false && !this.mover?.isMoving && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); this.openMenu(); } if (event.key === 'm' && !event.ctrlKey && !event.altKey && !event.metaKey && !this.dialogue && this.audio) { this.flashTitle(this.audio.toggleMute() ? '🔇 Muted (M)' : '🔊 Sound on (M)'); } };
      window.addEventListener('keydown', this.saveKey);
      this.dialogue = null;
      // MessageBox is updated before the scene. When the final confirm closes
      // a box, the same justPressed input would otherwise fall through to the
      // map and activate the event again on the very next line.
      this.confirmLock = false;
      this.confirmLockUntil = 0;
      this.eventQueue = Promise.resolve();
      this.backgroundRoutes = new Map();
      this.routeThrough = new Map();
      this.routeOptions = new Map();
      this.restoreRuntimeState(this.pendingRuntimeState);
      if (this.activeVehicle) { this.routeThrough.set("player", true); }
      this.pendingRuntimeState = null;
      this.eventRunning = false;
      this.parallelTimer = 0;
      const playerIndex = Number(project.playerSprite?.index) || 0;
      const initialPlayerTexture = playerSheet?.get(characterCellIndex(playerGeom, playerIndex, 2, 1));
      this.player = playerSheet ? new mwg.AnimatedSprite({ texture: initialPlayerTexture }) : new mwg.TintedSprite({ texture: mwg.Resources.texture(fallbackSheetUrl) });
      if (playerSheet) (isXp ? addXpCharacterAnimations : addCharacterAnimations)(this.player, playerSheet, playerIndex, playerGeom.big);
      this.playerSize = playerSheet ? characterPixelSize(playerGeom, tileSize) : { w: tileSize, h: tileSize, shift: 0 };
      this.player.width = this.playerSize.w; this.player.height = this.playerSize.h; this.player.tint = 0xffffff;
      this.player.zIndex = characterDepth(position.y, 1);
      world.addChild(this.player);
      world.addChild(this.aboveMap);
      this.pictureLayer = new mwg.Container2D();
      this.stage.addChild(this.pictureLayer);
      // RPG Maker draws pictures below the message/choice windows: the window
      // stack joins the stage after the picture layer, so a fullscreen splash
      // can never cover the question text (Pokemon Void intro).
      this.windows = new mwg.WindowStack();
      this.stage.addChild(this.windows);
      this.windows.setViewport(game.width, game.height);
      this.pictureSprites = new Map();
      this.pictureTweens = new Map();
      this.overlayLayer = new mwg.Container2D();
      this.overlayLayer.zIndex = 1000000001;
      world.addChild(this.overlayLayer);
      this.overlayAnims = [];
      this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: tileSize, tileHeight: tileSize, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
      this.pendingStep = null;
      this.refreshEventSprites();
      this.refreshVehicleSprites();
      this.updateCamera();
      this.runAutorunEvents();
      if (new URLSearchParams(globalThis.location?.search || '').get('load') === '1') {
        queueMicrotask(async () => {
          const slots = [...this.savedSlots().keys()];
          if (slots.length > 1) { const chosen = await this.pickSlot(request => this.presentDialogue(request), { forSave: false }); if (chosen) this.loadGame(chosen); }
          else this.loadGame(slots[0] || 1);
        });
      }
    }
    refreshEventSprites() {
      const previous = new Map((this.eventSprites || []).map(entry => [String(entry.event.id), entry]));
      const next = [];
      for (const event of mapEntry?.mwgEvents || []) {
        const old = previous.get(String(event.id));
        if (this.erasedEvents?.has(event.id)) {
          if (old) { old.sprite.removeFromParent?.(); old.sprite.destroy?.(); }
          continue;
        }
        const page = mwg.Rpg.activePage(event, this.gameState);
        const image = event.routeImage || page?.image;
        const geom = image && eventGeoms.get(image.name);
        const sheet = image && eventSheets.get(image.name);
        if (!image || !geom) {
          if (old) { old.sprite.removeFromParent?.(); old.sprite.destroy?.(); }
          continue;
        }
        const direction = event.facing ? ({ down: 2, left: 4, right: 6, up: 8 }[event.facing] || image.direction) : image.direction;
        const key = `${image.name}|${image.index}|${direction}|${image.pattern}`;
        if (old?.visualKey === key) {
          next.push(old);
          continue;
        }
        if (old) { old.sprite.removeFromParent?.(); old.sprite.destroy?.(); }
        // A referenced sheet can be absent from the project archive (stale
        // authoring reference). Keep a loud, visible stand-in so the event
        // stays findable and interactable — triggers are position-based —
        // instead of silently vanishing.
        const sprite = sheet
          ? new mwg.TintedSprite({ texture: sheet.get(safeCharacterCell(sheet, characterCellIndex(geom, image.index, direction, image.pattern), image.name)) })
          : new mwg.TintedSprite({ texture: mwg.Resources.texture(fallbackSheetUrl) });
        if (!sheet) {
          console.warn(`MWGP character sheet '${image.name}' is missing; using a placeholder sprite`);
          sprite.tint = 0xff4fd8;
        }
        const size = characterPixelSize(geom, tileSize);
        sprite.width = size.w; sprite.height = size.h; sprite.alpha = this.eventAlpha.get(String(event.id)) ?? 1; sprite.zIndex = characterDepth(event.y);
        this.world.addChild(sprite);
        next.push({ event, sprite, visualKey: key, ...size });
      }
      this.eventSprites = next;
      this.updateCamera();
    }
    vehicleAt(x, y) {
      for (const [name, vehicle] of Object.entries(this.rpgExtra?.vehicles || {})) if (vehicle && Number(vehicle.mapId) === Number(mapEntry.id) && Number(vehicle.x) === Number(x) && Number(vehicle.y) === Number(y)) return name;
      return null;
    }
    syncActiveVehicle() {
      if (!this.activeVehicle) return;
      const vehicle = this.rpgExtra?.vehicles?.[this.activeVehicle];
      if (!vehicle) return;
      vehicle.mapId = Number(mapEntry.id); vehicle.x = Number(position.x); vehicle.y = Number(position.y);
      this.refreshVehicleSprites();
    }
    tryVehicleAction() {
      if (this.activeVehicle) {
        this.activeVehicle = null; this.rpgExtra.activeVehicle = null;
        this.routeThrough.delete("player");
        this.player.alpha = 1;
        this.refreshVehicleSprites();
        return true;
      }
      const [x, y] = this.targetCell();
      const name = this.vehicleAt(x, y);
      if (!name) return false;
      this.activeVehicle = name; this.rpgExtra.activeVehicle = name;
      this.routeThrough.set("player", true);
      this.player.alpha = 0.45;
      return true;
    }
    refreshVehicleSprites() {
      for (const entry of this.vehicleSprites || []) { entry.sprite.removeFromParent?.(); entry.sprite.destroy?.(); }
      this.vehicleSprites = [];
      const colors = { boat: 0x4aa3df, ship: 0xd99b43, airship: 0xc45bd6 };
      for (const name of ['boat', 'ship', 'airship']) {
        const vehicle = this.rpgExtra?.vehicles?.[name];
        if (!vehicle || Number(vehicle.mapId) !== Number(mapEntry.id) || !Number.isFinite(Number(vehicle.x)) || !Number.isFinite(Number(vehicle.y))) continue;
        const sprite = new mwg.TintedSprite({ texture: mwg.Resources.texture(fallbackSheetUrl) });
        sprite.width = tileSize; sprite.height = tileSize; sprite.tint = colors[name]; sprite.alpha = 0.9;
        this.world.addChild(sprite);
        this.vehicleSprites.push({ name, vehicle, sprite });
      }
      this.updateCamera();
    }
    setVehicleLocation(spec, state) {
      const name = ['boat', 'ship', 'airship'][Number(spec?.vehicle)];
      if (!name) return;
      const read = value => Number(state?.game?.variable?.(String(value)) ?? 0);
      const mapId = spec.mapId !== undefined ? Number(spec.mapId) : read(spec.mapVar);
      const x = spec.x !== undefined ? Number(spec.x) : read(spec.xVar);
      const y = spec.y !== undefined ? Number(spec.y) : read(spec.yVar);
      if (!Number.isInteger(mapId) || !Number.isInteger(x) || !Number.isInteger(y)) { console.warn("MWGP vehicle location is invalid; ignoring it", spec); return; }
      this.rpgExtra.vehicles = { ...(this.rpgExtra.vehicles || {}), [name]: { ...(this.rpgExtra.vehicles?.[name] || {}), mapId, x, y } };
      this.refreshVehicleSprites();
    }
    restoreRuntimeState(state) {
      this.mapRuntime = state?.mapRuntime && typeof state.mapRuntime === 'object' ? state.mapRuntime : {};
      const current = this.mapRuntime[String(mapEntry.id)] || {};
      for (const saved of current.events || []) {
        const event = (mapEntry.mwgEvents || []).find(candidate => String(candidate.id) === String(saved.id));
        if (!event) continue;
        if (Number.isFinite(saved.x)) event.x = saved.x;
        if (Number.isFinite(saved.y)) event.y = saved.y;
        if (saved.facing) event.facing = saved.facing;
        if (saved.routeImage) event.routeImage = saved.routeImage;
        if (saved.erased) this.erasedEvents.add(event.id);
      }
      this.eventAlpha = new Map((current.alpha || []).map(entry => [String(entry[0]), Number(entry[1])]).filter(entry => Number.isFinite(entry[1])));
      this.routeThrough = new Map(Object.entries(state?.routeThrough || {}).map(([target, value]) => [target, value === true]));
    }
    captureRuntimeState() {
      const events = (mapEntry.mwgEvents || []).map(event => ({
        id: String(event.id), x: Number(event.x), y: Number(event.y),
        ...(event.facing ? { facing: event.facing } : {}),
        ...(event.routeImage ? { routeImage: event.routeImage } : {}),
        ...(this.erasedEvents.has(event.id) ? { erased: true } : {})
      }));
      const alpha = [...this.eventAlpha.entries()];
      this.mapRuntime[String(mapEntry.id)] = { events, alpha };
      return this.mapRuntime;
    }
    runtimeState(extra = {}) {
      return {
        audio: this.audio?.snapshot(),
        ...extra,
        mapRuntime: this.captureRuntimeState(),
        routeThrough: Object.fromEntries(this.routeThrough)
      };
    }
    update(dt) {
      this.windows.update(dt);
      this.tickTimer(dt);
      this.screenEffects?.update(dt);
      // AnimatedSprite deliberately does not advance itself: MWG expects the
      // owning scene (or a SpriteGroup) to provide the frame delta. Without
      // this call the player keeps the texture selected at construction time,
      // even though GridMover changes the walk/idle animation name correctly.
      // The fallback (no character sheet) is a static TintedSprite with nothing to animate.
      this.player?.update?.(dt);
      this.updatePictures(dt);
      this.updateForeground(dt);
      this.updateParallax(dt);
      this.updateOverlayAnims(dt);
      this.updateBattleFx(dt);
      this.updateBattlePoses(dt);
      this.updateCameraPan(dt);
      if (nativeAutotilesReady) {
        this.autotileElapsed += dt;
        if (this.autotileElapsed >= 0.5) {
          this.autotileElapsed %= 0.5;
          this.autotileFrame++;
          for (let index = 0; index < 4; index++) {
            this.tileMap.setAutotileFrame(`rpgm-xp-${index}`, this.autotileFrame);
            this.aboveMap.setAutotileFrame(`rpgm-xp-above-${index}`, this.autotileFrame);
          }
        }
      }
      if (this.dialogue) return;
      if (this.confirmLock) {
        // A browser/embedded keyboard can lose the matching keyup while a
        // dialogue is being removed.  Do not leave the whole map frozen in
        // that case: the short grace period still prevents the closing
        // confirm from retriggering the event, then expires on its own.
        if (!mwg.Input.isDown('confirm') || performance.now() >= this.confirmLockUntil) this.confirmLock = false;
        else return;
      }
      this.parallelTimer -= dt;
      if (this.parallelTimer <= 0 && !this.eventRunning) { this.runParallelEvents(); this.parallelTimer = 0.25; }
      this.mover.update(dt);
      // Advance the repeat timer during a step. Freezing it until the mover is
      // idle creates a visible pause between consecutive held-key steps.
      this.cooldown -= dt;
      this.renderPosition = { x: this.player.x / tileSize, y: this.player.y / tileSize };
      this.updateCamera();
      if (this.pendingStep && !this.mover.isMoving) { const [x, y] = this.pendingStep; position.x = x; position.y = y; this.pendingStep = null; this.syncActiveVehicle(); this.runEventAt(x, y, 'touch'); }
      if (this.mover.isMoving) return;
      if (this.cooldown <= 0) {
        const direction = mwg.Input.isDown('up') ? [0, -1, 'up'] : mwg.Input.isDown('down') ? [0, 1, 'down'] : mwg.Input.isDown('left') ? [-1, 0, 'left'] : mwg.Input.isDown('right') ? [1, 0, 'right'] : null;
        if (direction) {
          const [dx, dy, facing] = direction;
          this.facing = facing;
          const x = this.mover.x + dx, y = this.mover.y + dy;
          const moved = this.canStep(x, y, dx, dy) && this.mover.moveBy(dx, dy);
          // MV checks player-touch events at the attempted front cell even
          // when the event itself has priority 1 and therefore blocks entry.
          // Doors/stairs in XP projects commonly use exactly that shape.
          if (!moved && this.runEventAt(x, y, 'touch')) { this.cooldown = 0.12; }
          else if (moved) { this.pendingStep = [x, y]; this.cooldown = 0; }
          else { this.mover.turnTo(dx, dy); this.cooldown = 0.12; }
        }
        if (mwg.Input.justPressed('confirm')) {
          if (!this.tryVehicleAction()) this.runEventAt(...this.targetCell(), 'action');
        }
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
      this.player.x = x * scale + (scale - this.playerSize.w) / 2 + this.tileMap.x; this.player.y = y * scale + scale - this.playerSize.h - this.playerSize.shift + this.tileMap.y; this.player.zIndex = characterDepth(y, 1);
      for (const item of this.eventSprites || []) { item.sprite.x = item.event.x * scale + (scale - item.w) / 2 + this.tileMap.x; item.sprite.y = item.event.y * scale + scale - item.h - item.shift + this.tileMap.y; item.sprite.zIndex = characterDepth(item.event.y); }
      for (const item of this.vehicleSprites || []) { item.sprite.x = Number(item.vehicle.x) * scale + this.tileMap.x; item.sprite.y = Number(item.vehicle.y) * scale + this.tileMap.y; item.sprite.zIndex = characterDepth(Number(item.vehicle.y)); }
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
      // Resolve the visible layers from top to bottom. Empty cells and star
      // tiles do not participate in collision; the first real tile is
      // authoritative. Treating an empty upper layer as passable used to let
      // the lower wall be walked through, while waiting until the end could
      // reject valid door/stair cells whose upper tile is passable.
      if (this.routeThrough.get('player') === true) return true;
      const tileIds = Array.from({ length: 4 }, (_, index) => {
        const layer = 3 - index;
        return map.data?.[layer * size + y * map.width + x] || 0;
      });
      return passageAllowsStep(tileIds, tilesetFlags, bit) && this.eventAllowsStep(x, y);
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
      if (!event || this.erasedEvents.has(event.id)) return false;
      const page = mwg.Rpg.activePage(event, this.gameState);
      if (!page || page.trigger !== trigger || (!page.commands?.length && !page.story)) return false;
      this.runPage(page, event);
      return true;
    }
    runAutorunEvents() {
      for (const event of mapEntry?.mwgEvents || []) {
        // One corrupt event must never kill the boot scan: warn and continue.
        try {
          if (this.erasedEvents.has(event.id)) continue;
          const page = mwg.Rpg.activePage(event, this.gameState);
          if (page?.trigger === 'autorun' && (page.commands?.length || page.story)) this.runPage(page, event);
        } catch (error) { console.warn('MWGP autorun event failed to start; skipping it', event?.id, error); }
      }
    }
    // MV refreshes the map when an event finishes: an autorun page whose
    // conditions just became true (a door choice setting its switch) starts
    // now, not only at map boot. Skipped while a cross-map transfer unloads
    // the page, where queued runs would die anyway.
    refreshAutorunEvents() {
      if (this.transferring) return;
      this.runAutorunEvents();
    }
    runParallelEvents() {
      // This runs inside the frame loop: one corrupt event must never throw
      // into it and freeze the game. Warn and continue instead.
      for (const event of mapEntry?.mwgEvents || []) {
        try {
          if (this.erasedEvents.has(event.id)) continue;
          const page = mwg.Rpg.activePage(event, this.gameState);
          if (page?.trigger === 'parallel' && (page.commands?.length || page.story)) this.runPage(page, event);
        } catch (error) { console.warn('MWGP parallel event failed to start; skipping it', event?.id, error); }
      }
    }
    runPage(page, event = null) {
      // Pages containing labels run as a story: passages keyed by label name,
      // following { goto } jumps until a passage runs out. GameState is mutated
      // in place, so switches/variables set mid-passage survive the jump.
      if (page.story) {
        const passages = Object.fromEntries(Object.entries(page.story.passages || {}).map(([name, body]) => [name, prepareEventCommands(body, this)]));
        const order = Array.isArray(page.story.order) ? page.story.order : Object.keys(passages);
        this.eventQueue = this.eventQueue.then(() => { this.eventRunning = true; this.currentEvent = event; return this.runStoryLoop(passages, page.story.start || 'main', order); })
          .catch(error => { if (!(error instanceof ExitEventSignal) && !(error instanceof BreakLoopSignal)) console.error('MWGP event failed', error); })
          .finally(() => { this.eventRunning = false; this.currentEvent = null; this.refreshEventSprites(); this.refreshAutorunEvents(); });
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
        .finally(() => { this.eventRunning = false; this.currentEvent = null; this.refreshEventSprites(); this.refreshAutorunEvents(); });
      return this.eventQueue;
    }
    async runStoryLoop(passages, start, order = Object.keys(passages)) {
      // A missing passage ends the event with a warning, matching the loud
      // degradation rule: MV would hard-error, silence would be worse.
      let current = start, jumps = 0;
      while (current !== undefined && jumps++ < 1000) {
        // A malformed label cycle must not monopolize the browser thread while
        // the hard jump cap is being approached.
        if (jumps % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        if (!passages[current]) { console.warn(`MWGP story has no passage "${current}"; ending event`); return; }
        try {
          await this.runBranch(passages[current]);
          const next = order.indexOf(current) + 1;
          current = next > 0 && next < order.length ? order[next] : undefined;
        } catch (error) {
          if (error instanceof JumpSignal) current = error.passage;
          else throw error;
        }
      }
      if (jumps >= 1000) console.warn('MWGP story exceeded 1000 jumps without ending; stopping it');
    }
    async runNestedPage(page, event) {
      if (!page) return;
      const previousEvent = this.currentEvent;
      this.currentEvent = event;
      try {
        if (page.story) {
          const passages = Object.fromEntries(Object.entries(page.story.passages || {}).map(([name, body]) => [name, prepareEventCommands(body, this)]));
          const order = Array.isArray(page.story.order) ? page.story.order : Object.keys(passages);
          await this.runStoryLoop(passages, page.story.start || 'main', order);
        } else {
          await this.runBranch(prepareEventCommands(page.commands, this));
        }
      } finally {
        this.currentEvent = previousEvent;
      }
    }
    // MV's convertEscapeCharacters, evaluated at display time so \V[n] sees live
    // variables: \V variable, \N actor name, \P party member name, \G currency
    // unit, \\ literal backslash. \C[n] colors, \I[n] icons, \. \| \^ \! waits,
    // \< \> instant toggles, \{ \} font size, and \$ gold window have no
    // MessageBox equivalent and strip to their payload (colors/icons) or
    // nothing (timing/layout). Unknown \PLUGIN[...] codes stay literal —
    // MV-faithful and loud, same rule as the converter's missing text keys.
    resolveEscapeCodes(text) {
      if (text == null) return text;
      let resolvedText = String(text);
      // Message-text filters the game's own library declares (`self.inline`
      // hooks, found by the converter) expand game-specific tokens before the
      // MV escape codes below.
      for (const filter of project.rubyLibrary?.textFilters || []) {
        if (!project.rubyLibrary.units?.[filter] || this.disabledTextFilters?.has(filter)) continue;
        const literal = JSON.stringify(resolvedText);
        const inlined = this.rgss.evaluateValue({ source: `${filter}.inline`, js: `return ${filter}.inline(${literal});` }, { game: this.gameState }, this.currentEvent);
        if (typeof inlined === 'string') resolvedText = inlined;
        else (this.disabledTextFilters ||= new Set()).add(filter);
      }
      if (!resolvedText.includes('\\')) return resolvedText;
      const escaped = resolvedText.replace(/\\\\/g, '\0');
      const actorName = id => this.rpgExtra.actors?.[String(id)]?.name ?? project.database?.actors?.[Number(id)]?.name ?? '';
      const resolved = escaped
        .replace(/\\V\[(\d+)\]/gi, (_, id) => String(this.gameState?.variable?.(String(Number(id))) ?? 0))
        .replace(/\\N\[(\d+)\]/gi, (_, id) => actorName(id))
        .replace(/\\PN/gi, () => this.rpgExtra.playerName || actorName((this.rpgExtra.party || [])[0]))
        .replace(/\\P\[(\d+)\]/gi, (_, n) => actorName((this.rpgExtra.party || [])[Number(n) - 1]))
        .replace(/\\G/gi, project.database?.system?.currencyUnit || '')
        .replace(/\\C\[\d+\]/gi, '')
        .replace(/\\I\[\d+\]/gi, '')
        .replace(/\\[.\|^\!<>]/g, '')
        .replace(/\\[{}]/g, '')
        .replace(/\\\$/g, '')
        // RPG Maker consumes an unknown `\X` escape (a plugin code from
        // another project, like Karryn's `\#`) instead of printing it. This
        // runs while `\\` literals are still NUL-protected, so only real
        // unknown codes are dropped.
        .replace(/\\./g, '');
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
    messageBoxHeight(kind = 'normal') {
      // MV's message window shows four lines (4 x 36 + 2 x 18 padding); the skinned frame needs that room.
      const skinned = Boolean(windowSkinUrl && loadedUrls.has(windowSkinUrl));
      const rows = skinned ? 4 : 3;
      const rowHeight = skinned ? 45 : 42;
      const base = kind === 'portrait' ? 150 : kind === 'scroll' ? 180 : 0;
      return Math.min(Math.max(84, base, rows * rowHeight), Math.max(96, game.height - 24));
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
      try { await loadResource(url); } catch { console.warn(`MWGP XP map ${settings.kind} asset is missing: ${settings.name}`); return; }
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
    inputName(state, command) {
      const maxLength = Math.max(1, Math.min(32, Number(command.inputName?.maxLength) || 12));
      const current = String(this.rpgExtra.playerName || '');
      const entered = globalThis.prompt?.('What is your name?', current);
      const value = entered === null || entered === undefined ? current : String(entered).trim().slice(0, maxLength);
      this.rpgExtra.playerName = value || current || 'Player';
    }
    presentDialogue(request) {
      // A portrait arrives as the converter's `{ name, index }` face reference; a face whose sheet did not load shows the text alone.
      const face = request.portrait?.name !== undefined ? portraitSheets.get(request.portrait.name) : null;
      return new Promise(resolve => {
        this.dialogue = true;
        const box = createDialogueBox(mwg, { width: Math.max(320, game.width - 48), height: this.messageBoxHeight(face ? 'portrait' : 'normal'), pages: [{ text: this.resolveEscapeCodes(request.text), speaker: request.speaker, portrait: face ? face.get(request.portrait.index) : undefined }], choices: (request.choices || []).map(choice => ({ ...choice, text: this.resolveEscapeCodes(choice.text) })), dims: this.messageOptions.frame === 0, anchor: this.messageAnchor(), onDone: chosen => { this.windows.pop(); this.dialogue = null; this.confirmLock = true; this.confirmLockUntil = performance.now() + 180; resolve(chosen); } });
        this.windows.push(box);
      });
    }
    runBranch(commands) {
      if (!commands?.length) return Promise.resolve();
      return new mwg.Rpg.EventRunner({ game: this.gameState, move: (target, steps) => this.runMoveRoute(target, steps), present: request => this.presentDialogue(request) }).run(commands);
    }
    async runCommonEvent(id) {
      const commands = project.commonEvents?.[String(id)];
      if (!Array.isArray(commands)) {
        this.unsupportedCommand('commonEvent', { id });
        return;
      }
      if (this.commonEventDepth >= 32) {
        console.warn(`MWGP common event ${id} recursion exceeded 32 calls; stopping this branch`);
        return;
      }
      this.commonEventDepth++;
      try {
        await this.runBranch(prepareEventCommands(commands, this));
      } finally {
        this.commonEventDepth--;
      }
    }
    async presentChoice(command) {
      const chosen = await this.presentDialogue({ text: command.ask || '', portrait: command.portrait, choices: command.choices || [] });
      return this.runBranch((command.branches || [])[Number(chosen)]);
    }
    async openShop(spec) {
      const goods = (spec?.goods || []).filter(entry => Number(entry?.id) > 0);
      if (!goods.length) return;
      const database = project.database || {};
      const typeInfo = kind => kind === 1 ? ['weapons', 'Weapon'] : kind === 2 ? ['armors', 'Armor'] : ['items', 'Item'];
      const entries = goods.map((entry, index) => {
        const [store] = typeInfo(Number(entry.kind));
        const item = database[store]?.[Number(entry.id)];
        const price = Number(entry.priceType) === 1 ? Number(entry.price || 0) : Number(item?.price || 0);
        return { ...entry, index, store, item, price: Math.max(0, price) };
      }).filter(entry => entry.item);
      if (!entries.length) { await this.presentDialogue({ text: 'This shop has nothing available.' }); return; }
      const choices = entries.map(entry => ({ text: String(entry.item.name || 'Unknown') + ' - ' + entry.price + ' G', value: entry.index }));
      choices.push({ text: 'Leave', value: -1 });
      while (true) {
        const chosen = await this.presentDialogue({ text: 'Gold: ' + Number(this.rpgExtra.gold || 0) + ' G', choices });
        const index = Number(chosen);
        if (!Number.isInteger(index) || index < 0) return;
        const entry = entries.find(candidate => candidate.index === index);
        if (!entry) return;
        if (Number(this.rpgExtra.gold || 0) < entry.price) {
          await this.presentDialogue({ text: 'Not enough gold.' });
          continue;
        }
        this.rpgExtra.gold -= entry.price;
        const key = String(entry.id);
        this.rpgExtra[entry.store][key] = (this.rpgExtra[entry.store][key] || 0) + 1;
        await this.presentDialogue({ text: 'Purchased ' + String(entry.item.name || 'item') + '.' });
      }
    }
    setWeather(weather) {
      const type = String(weather?.type || 'none').toLowerCase();
      if (type === 'none' || !this.screenEffects) {
        this.weather = { type: 'none', power: 0 };
        this.screenEffects?.clear();
        return weather?.wait ? new Promise(resolve => setTimeout(resolve, Math.max(0, Number(weather.duration || 0)) * 1000)) : Promise.resolve();
      }
      const color = type === 'snow' ? 0xdcecff : type === 'storm' ? 0x53627a : 0x416fa8;
      const strength = Math.max(0, Math.min(1, Number(weather.power || 0) / 9 * 0.35));
      this.weather = { type, power: Number(weather.power || 0) };
      this.screenEffects.setTint(color, strength);
      return weather.wait ? new Promise(resolve => setTimeout(resolve, Math.max(0, Number(weather.duration || 0)) * 1000)) : Promise.resolve();
    }
    async gameOver() {
      const present = request => this.presentDialogue(request);
      for (;;) {
        const continues = this.savedSlots().size > 0;
        const choice = await present({ text: 'Game Over', choices: [...(continues ? [{ text: project.database?.system?.terms?.commands?.[19] || 'Continue', value: 'continue' }] : []), { text: 'Restart', value: 'restart' }, { text: project.database?.system?.terms?.commands?.[21] || 'To Title', value: 'title' }] });
        if (choice === 'continue') { const slot = await this.pickSlot(present, { forSave: false }); if (slot) { this.loadGame(slot); return; } continue; }
        if (choice === 'title') { try { this.saves.delete('runtime-transition'); } catch { /* headless */ } const url = new URL(globalThis.location.href); url.search = ''; url.searchParams.set('id', new URLSearchParams(globalThis.location.search).get('id') || ''); globalThis.location.href = url.toString(); return; }
        try { this.saves.delete('runtime-transition'); } catch { /* headless */ }
        const url = new URL(globalThis.location.href);
        url.searchParams.set('map', String(Number(project.initialMapId)));
        url.searchParams.set('x', String(Number(project.player?.x || 0)));
        url.searchParams.set('y', String(Number(project.player?.y || 0)));
        url.searchParams.set('newGame', '1');
        globalThis.location.href = url.toString();
        return;
      }
    }
    troopPageActive(conditions, phase = 'start') {
      if (!conditions || typeof conditions !== 'object') return true;
      if (conditions.switchValid && !this.gameState.switch(String(conditions.switchId))) return false;
      if (conditions.actorValid && !(this.rpgExtra.party || []).includes(Number(conditions.actorId))) return false;
      if (conditions.enemyValid) {
        const enemy = this.battleEnemies?.[Number(conditions.enemyIndex)];
        if (!enemy || enemy.appeared === false || enemy.hp <= 0) return false;
      }
      if (conditions.actorHp && conditions.actorValid) {
        const actor = this.battleHero;
        if (!actor || actor.maxHp <= 0 || actor.hp / actor.maxHp * 100 > Number(conditions.actorHp)) return false;
      }
      if (conditions.enemyHp && conditions.enemyValid) {
        const enemy = this.battleEnemies?.[Number(conditions.enemyIndex)];
        if (!enemy || enemy.appeared === false || enemy.hp / Math.max(1, enemy.maxHp) * 100 > Number(conditions.enemyHp)) return false;
      }
      if (conditions.turnValid) {
        if (phase !== 'turn') return false;
        const turn = Number(this.battleTurn || 0);
        const first = Number(conditions.turnA || 0);
        const interval = Number(conditions.turnB || 0);
        if (turn < first || (interval > 0 && turn % interval !== first % interval)) return false;
      }
      if (conditions.turnEnding && phase !== 'turn') return false;
      return true;
    }
    async runBattleTroopEvents(troopId, phase = 'start') {
      const pages = this.projectTroopEvents?.[String(troopId)] || project.database?.troopEvents?.[String(troopId)] || [];
      for (const [pageIndex, page] of pages.entries()) {
        const span = Number(page.span || 0);
        if (span === 0 && phase !== 'start') continue;
        if (span === 1 && phase !== 'turn') continue;
        if (span === 2 && phase !== 'turn') continue;
        const key = String(troopId) + ':' + String(pageIndex);
        if ((span === 0 || span === 2) && this.battleTriggeredPages?.has(key)) continue;
        if (!this.troopPageActive(page.conditions, phase)) continue;
        try { await this.runBranch(prepareEventCommands(page.commands || [], this));
          if (span === 0 || span === 2) this.battleTriggeredPages.add(key);
        } catch (error) { console.warn('MWGP troop event failed; continuing battle', error); }
      }
    }
    // Troop-event commands on the running battle's enemies (index -1 = all of them); outside a battle they warn.
    battleEnemyTargets(spec, command) {
      if (!this.battleEnemies) { this.unsupportedCommand(command, spec); return []; }
      const index = Number(spec?.index);
      return index < 0 ? this.battleEnemies : [this.battleEnemies[index]].filter(Boolean);
    }
    changeEnemyStat(kind, spec, state) {
      const amount = this.resolveAmount(state, spec.amount) * (Number(spec.sign) < 0 ? -1 : 1);
      for (const enemy of this.battleEnemyTargets(spec, kind)) {
        if (kind === 'changeEnemyHp') { const floor = spec.allowDeath === true ? 0 : 1; enemy.gainHp(amount < 0 ? Math.max(floor - enemy.hp, amount) : amount); }
        else if (kind === 'changeEnemyMp') enemy.gainMp(amount);
        else enemy.tp = Math.max(0, Math.min(100, Number(enemy.tp || 0) + amount));
      }
    }
    changeEnemyState(spec) {
      for (const enemy of this.battleEnemyTargets(spec, 'changeEnemyState')) { if (spec.add) enemy.addState(spec.state, 1); else enemy.removeState(spec.state); }
    }
    enemyTransform(spec) {
      const target = project.database?.enemies?.[Number(spec.enemyId)];
      for (const enemy of this.battleEnemyTargets(spec, 'enemyTransform')) { if (target) { enemy.source = target; enemy.hp = enemy.mhp; enemy.mp = enemy.mmp; } }
    }
    enemyAppear(spec) {
      const index = Number(spec?.index);
      const enemy = this.battleEnemies?.[index];
      if (!this.battleEnemies) { this.unsupportedCommand('enemyAppear', spec); return; }
      if (!enemy) return;
      enemy.appeared = true;
    }
    // Full troop battle (src/player/battle.js) when the project has the MV/MZ database; the dialogue
    // duel below stays for manifests without one (XP conversions carry no database yet).
    async startBattle(spec) {
      const database = project.database || {};
      if (database.troops && database.enemies && database.actors && database.classes && database.skills) return this.startTroopBattle(spec, database);
      return this.startDuelBattle(spec, database);
    }
    // The battle stage: the map's battle background and each enemy's battler at its troop position, drawn over the
    // map while the dialogue-driven battle runs (no animations). Missing images degrade to nothing, never an error.
    async buildBattleStage(enemies, actors = []) {
      const root = project.assets?.root;
      if (!root || !mwg.Container2D) return;
      const data = mapEntry?.data || {};
      const scaleX = game.width / Number(project.display?.width || 816), scaleY = game.height / Number(project.display?.height || 624);
      const stage = new mwg.Container2D();
      // Change Battle Back (283) overrides the map's own battlebacks until the next such command.
      const backName = key => this.rpgExtra.system?.battleback?.[key === 'battleback1Name' ? 'first' : 'second'] || data[key];
      const wanted = [
        ...['battleback1Name', 'battleback2Name'].map(key => backName(key) && { url: `${root}/img/battlebacks${key === 'battleback1Name' ? 1 : 2}/${encodeURIComponent(backName(key))}.png`, back: true }),
        ...enemies.map(enemy => enemy.source?.battlerName && { url: `${root}/img/enemies/${encodeURIComponent(enemy.source.battlerName)}.png`, enemy })
      ].filter(Boolean);
      const loaded = await Promise.all(wanted.map(entry => loadResource(entry.url).then(() => true, () => false)));
      // A solid dark base (a 4x4 black image) so the map behind stays unreadable when a battle has no backdrop art.
      const base = document.createElement('canvas'); base.width = base.height = 4;
      const baseContext = base.getContext('2d'); baseContext.fillStyle = '#05060a'; baseContext.fillRect(0, 0, 4, 4);
      const baseUrl = base.toDataURL();
      await loadResource(baseUrl).catch(() => {});
      const shade = new mwg.TintedSprite({ texture: mwg.Resources.texture(baseUrl) });
      shade.width = game.width; shade.height = game.height;
      stage.addChildAt ? stage.addChildAt(shade, 0) : stage.addChild(shade);
      this.battleSprites = [];
      wanted.forEach((entry, index) => {
        if (!loaded[index]) return;
        const sprite = new mwg.TintedSprite({ texture: mwg.Resources.texture(entry.url) });
        if (entry.back) { sprite.width = game.width; sprite.height = game.height; }
        else {
          sprite.anchor?.set(0.5, 1);
          sprite.scale.set(scaleX, scaleY);
          sprite.x = Number(entry.enemy.member?.x || 0) * scaleX; sprite.y = Number(entry.enemy.member?.y || 0) * scaleY;
          sprite.fxBase = { x: sprite.x, y: sprite.y };
          this.battleSprites.push({ sprite, enemy: entry.enemy });
        }
        stage.addChild(sprite);
      });
      // The party: each actor's side-view battler (idle pose of the `wait` row of the 9x6 sv_actors sheet), on the right
      // in MV's default formation. Actors without art are simply not drawn.
      // The party stands in the chosen formation (formation.js); MV's own staggered layout is the 'default'.
      const spots = stagePositions(this.rpgExtra.formation || 'default', actors.length);
      for (const [index, actor] of actors.entries()) {
        const name = actor.source?.battlerName;
        if (!name) continue;
        const url = `${root}/img/sv_actors/${encodeURIComponent(name)}.png`;
        if (!(await loadResource(url).then(() => true, () => false))) continue;
        const texture = mwg.Resources.texture(url);
        const cellW = Math.floor(Number(texture.width) / 9), cellH = Math.floor(Number(texture.height) / 6);
        if (!cellW || !cellH) continue;
        const frame = mwg.SpriteSheet.grid(url, cellW, cellH).get(9 + 1);
        if (!frame) continue;
        const sprite = new mwg.TintedSprite({ texture: frame });
        sprite.anchor?.set(0.5, 1);
        sprite.scale.set(scaleX, scaleY);
        sprite.x = spots[index].x * scaleX; sprite.y = spots[index].y * scaleY;
        sprite.fxBase = { x: sprite.x, y: sprite.y };
        stage.addChild(sprite);
        (this.battleActorSprites ||= []).push({ sprite, actor, sheet: mwg.SpriteSheet.grid(url, cellW, cellH), motion: { name: 'wait', elapsed: 0, oneShot: false } });
      }
      this.battleShadeTexture = mwg.Resources.texture(baseUrl);
      this.buildBattleStatus(stage, actors);
      this.battleFx = { stack: new mwg.FloatingTextStack(), motions: [] };
      stage.addChild(this.battleFx.stack);
      this.battleStage = stage;
      this.stage.addChild(stage);
      this.refreshBattleStage();
    }
    refreshBattleStage() {
      for (const { sprite, enemy } of this.battleSprites || []) {
        sprite.visible = enemy.appeared !== false;
        sprite.alpha = enemy.hp > 0 ? 1 : 0.15;
      }
      for (const { sprite, actor, sheet } of this.battleActorSprites || []) sprite.alpha = actor.hp > 0 || sheet ? 1 : 0.35;   // a posed actor lies down instead of fading
      this.refreshBattleStatus();
    }
    destroyBattleStage() {
      this.battleStage?.destroy({ children: true });
      this.battleFx = null;
      this.battleStatus = null;
      this.battleStage = null; this.battleSprites = null; this.battleActorSprites = null;
    }
    async startTroopBattle(spec, database) {
      const troopId = spec.troopVariable ? Number(this.gameState.variable(String(spec.troopVariable)) || 0) : Number(spec.troopId || 0);
      if (!database.troops?.[troopId]) { this.unsupportedCommand('battle', spec); return 'lose'; }
      if (!this.rpgExtra.party?.length) { const fallbackActor = findPlayerActor(project); if (fallbackActor) this.rpgExtra.party = [fallbackActor]; }
      const party = [...(this.rpgExtra.party || [])].slice(0, this.maxBattleMembers());   // Game_Party.battleMembers
      const records = Object.fromEntries(party.map(id => [id, this.actorRecord(id)]));
      this.battleTurn = 0;
      this.battleTriggeredPages = new Set();
      // BattleManager.playBattleBgm: the battle BGM (System.json, or Change Battle BGM) replaces the map music, which
      // resumes afterwards. Victory and defeat jingles follow Change Victory/Defeat ME.
      const audioSystem = project.audio?.system || {};
      const battleBgm = this.rpgExtra.system?.battleBgm !== undefined ? this.rpgExtra.system.battleBgm : audioSystem.battleBgm;
      if (this.audio) { this.saveBgm(true); if (battleBgm) this.playBgm(battleBgm); }
      const stores = { 1: 'items', 2: 'weapons', 3: 'armors' };
      let result;
      try {
        result = await runBattle({
          database, troopId, party, records, formation: this.rpgExtra.formation || 'default', items: this.rpgExtra.items, canEscape: spec.canEscape === true, canLose: spec.canLose === true,
          present: request => { this.refreshBattleStage(); return this.presentDialogue(request); },
          variable: key => (String(key).startsWith('switch:') ? this.gameState.switch(String(key).slice(7)) : this.gameState.variable(String(key))),
          hooks: {
            onSetup: ({ actors, enemies }) => { this.battleEnemies = enemies; this.battleHero = actors[0]; return this.buildBattleStage(enemies, actors).catch(error => console.warn('MWGP battle stage unavailable', error)); },
            onControls: controls => { this.battleControls = controls; },
            onUse: use => this.battleUse(use),
            onVictory: () => { for (const entry of this.battleActorSprites || []) if (entry.actor.alive) { entry.hold = 'victory'; this.svMotion(entry.actor, 'victory'); entry.motion.oneShot = false; } },
            onEffect: effect => { this.battleEffect(effect); this.refreshBattleStage(); },
            onStart: () => this.runBattleTroopEvents(troopId, 'start'),
            onTurn: () => { this.battleTurn++; return this.runBattleTroopEvents(troopId, 'turn'); },
            gainGold: amount => { this.rpgExtra.gold = Math.max(0, (this.rpgExtra.gold || 0) + amount); },
            gainItem: (kind, id, count) => { const store = this.rpgExtra[stores[kind]] ||= {}; store[String(id)] = (store[String(id)] || 0) + count; }
          }
        });
      } finally { this.battleEnemies = null; this.battleHero = null; this.battleControls = null; this.destroyBattleStage(); }
      if (this.audio) {
        const me = result.outcome === 'win' ? (this.rpgExtra.system?.victoryMe !== undefined ? this.rpgExtra.system.victoryMe : audioSystem.victoryMe)
          : result.outcome === 'lose' ? (this.rpgExtra.system?.defeatMe !== undefined ? this.rpgExtra.system.defeatMe : audioSystem.defeatMe) : null;
        if (me) this.playMe(me);
        this.resumeBgm(true);
      }
      // MV: losing without "can lose" ends the game; with it, the event's defeat branch runs.
      if (result.outcome === 'lose' && spec.canLose !== true) await this.gameOver();
      return result.outcome;
    }
    async startDuelBattle(spec, database) {
      const troopId = spec.troopVariable
        ? Number(this.gameState.variable(String(spec.troopVariable)) || 0)
        : Number(spec.troopId || 0);
      const troop = database.troops?.[troopId];
      const enemies = (troop?.members || [])
        .map((member, index) => {
          const enemy = database.enemies?.[Number(member.enemyId)];
          return enemy ? { ...makeBattleEnemy(enemy), appeared: member.hidden !== true, index } : null;
        })
        .filter(Boolean);
      if (!enemies.some(enemy => enemy.appeared)) {
        await this.presentDialogue({ text: `Combat ${troopId} impossible : le groupe d'ennemis est introuvable.` });
        this.unsupportedCommand('battle', spec);
        return 'lose';
      }
      const actorId = Number(this.rpgExtra.party?.[0]) || findPlayerActor(project);
      const actor = database.actors?.[actorId];
      const klass = database.classes?.[Number(actor?.classId)];
      const level = Math.max(1, Number(actor?.initialLevel || 1));
      const params = [0, 1, 2, 3].map(id => klass?.params?.[id]?.[level]);   // MV stores class parameters as [paramId][level]
      const hero = {
        name: actor?.name || 'Héros',
        hp: Number(params[0] || 100),
        maxHp: Number(params[0] || 100),
        atk: Number(params[2] || 20),
        def: Number(params[3] || 10)
      };
      this.battleEnemies = enemies;
      this.battleHero = hero;
      this.battleTurn = 0;
      this.battleTriggeredPages = new Set();
      await this.runBattleTroopEvents(troopId, 'start');
      try { return await runBattleFallback({ hero, enemies, canEscape: spec.canEscape === true, onTurn: () => { this.battleTurn++; return this.runBattleTroopEvents(troopId, 'turn'); } }, request => this.presentDialogue(request)); }
      finally { this.battleEnemies = null; this.battleHero = null; }
    }
    async runLoop(body) {
      // MV loops are unbounded unless a Break Loop fires; the cap only guards against a
      // malformed/never-breaking loop freezing the tab, it is not gameplay-visible.
      for (let iteration = 0; iteration < 100000; iteration++) {
        // Keep malformed or plugin-dependent loops cooperative. Without this
        // yield, even the safety cap would still freeze input/rendering first.
        if (iteration > 0 && iteration % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
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
    modifyVariable(state, command) {
      const spec = command.modifyVariable || {};
      const current = Number(state.game.variable(String(spec.target)) || 0);
      const operandSpec = spec.operand;
      const operand = operandSpec?.variable !== undefined
        ? Number(state.game.variable(String(operandSpec.variable)) || 0)
        : operandSpec?.random
          ? Math.floor(Math.random() * (Number(operandSpec.random[1]) - Number(operandSpec.random[0]) + 1)) + Number(operandSpec.random[0])
          : operandSpec?.gameData
            ? resolveGameDataOperand(this.rpgExtra, { playerX: this.mover?.x ?? 0, playerY: this.mover?.y ?? 0, mapId: Number(mapEntry?.id) ?? 0 }, operandSpec.gameData)
            : operandSpec?.script
              ? this.evalScriptOperand(operandSpec.script, state)
              : Number(operandSpec?.value ?? operandSpec ?? 0);
      const value = spec.operation === 'set' ? operand
        : spec.operation === 'add' ? current + operand
        : spec.operation === 'subtract' ? current - operand
          : spec.operation === 'multiply' ? current * operand
            : spec.operation === 'divide' ? (operand === 0 ? 0 : current / operand)
              : spec.operation === 'modulo' ? (operand === 0 ? 0 : current % operand) : current;
      state.game.setVariable(String(spec.target), value);
    }
    evalScriptOperand(script, state) {
      // Control Set > Script: the raw eval result (not a truthiness test), so
      // strings assign as strings exactly like the engine's operateVariable.
      // Failures read as 0 with a loud warning, matching the engine's catch
      // (which resets the variable to 0) instead of aborting the event.
      try {
        const value = this.rgss.evaluateValue(script, state, this.currentEvent);
        return value ?? 0;
      } catch (error) {
        console.warn('MWGP script operand failed and read as 0', script?.source ?? script, error);
        return 0;
      }
    }
    startMoveRoute(route) {
      const key = String(route.target || 'player');
      if (this.backgroundRoutes.has(key)) return undefined;
      const task = this.runMoveRoute(route.target, route.steps, route)
        .catch(error => console.error(`MWGP background movement route failed for ${key}`, error))
        .finally(() => this.backgroundRoutes.delete(key));
      this.backgroundRoutes.set(key, task);
      return undefined;
    }
    setRouteOption(route) {
      const target = String(route?.target || 'player');
      const current = this.routeOptions.get(target) || {};
      this.routeOptions.set(target, { ...current, [String(route.option)]: route.value });
    }
    setRouteThrough(route) {
      this.routeThrough.set(String(route.target || 'player'), route.value === true);
    }
    setRouteImage(route) {
      const target = String(route?.target || 'player');
      if (target === 'player') {
        console.warn('MWGP movement route image for the player is not rendered dynamically; keeping the current player sheet', route?.image);
        return;
      }
      const eventId = target.startsWith('event:') ? target.slice(6) : '';
      const event = (mapEntry?.mwgEvents || []).find(candidate => String(candidate.id) === eventId);
      if (!event || !route.image?.name) { console.warn('MWGP movement route image target is unavailable', target); return; }
      event.routeImage = { ...route.image };
      this.refreshEventSprites();
    }
    async runMoveRoute(target, steps, options = {}) {
      const isPlayer = target === 'player';
      const eventId = target === 'self' && this.currentEvent ? String(this.currentEvent.id)
        : String(target || '').startsWith('event:') ? String(target).slice(6) : null;
      const event = eventId ? (mapEntry?.mwgEvents || []).find(candidate => String(candidate.id) === eventId) : null;
      if (!isPlayer && !event) { console.warn(`MWGP movement route target "${target}" is not on this map; skipping`); return; }
      let facing = isPlayer ? this.facing : (event.facing || 'down');
      const coordinate = () => isPlayer ? { x: this.mover.x, y: this.mover.y } : { x: event.x, y: event.y };
      const execute = async () => { for (const step of steps || []) {
        if (step.wait !== undefined) { await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(step.wait) * 1000))); continue; }
        const resolved = resolveRouteStep(step, facing, coordinate(), isPlayer ? null : { x: this.mover.x, y: this.mover.y });
        if (!resolved) continue;
        if (resolved.dx === undefined && resolved.dy === undefined && !resolved.jump) continue;
        if (resolved.turn) { facing = resolved.turn === 'random' ? ['up', 'right', 'down', 'left'][Math.floor(Math.random() * 4)] : resolved.turn; if (!isPlayer) { event.facing = facing; this.refreshEventSprites(); } else this.turnPlayer(facing); continue; }
        // MV jumps arc over intervening tiles, ignoring passability; without a
        // jump animation the honest equivalent is an instant relocation.
        if (resolved.jump) {
          const current = coordinate();
          const next = { x: current.x + resolved.jump.dx, y: current.y + resolved.jump.dy };
          if (isPlayer) { this.mover.x = next.x; this.mover.y = next.y; position.x = next.x; position.y = next.y; this.updateCamera(); }
          else { event.x = next.x; event.y = next.y; this.refreshEventSprites(); }
          continue;
        }
        const current = coordinate();
        const next = { x: current.x + resolved.dx, y: current.y + resolved.dy };
        if (this.routeThrough.get(String(target)) !== true && !this.canStep(next.x, next.y, resolved.dx, resolved.dy)) continue;
        if (this.routeOptions.get(String(target))?.directionFix !== true) facing = resolved.dy > 0 ? 'down' : resolved.dy < 0 ? 'up' : resolved.dx < 0 ? 'left' : 'right';
        if (isPlayer) {
          this.facing = facing;
          if (!this.mover.moveBy(resolved.dx, resolved.dy)) continue;
          await new Promise(resolve => {
            const check = () => this.mover.isMoving ? setTimeout(check, 16) : resolve();
            check();
          });
          position.x = this.mover.x;
          position.y = this.mover.y;
        } else { event.x = next.x; event.y = next.y; event.facing = facing; this.refreshEventSprites(); }
      } };
      do { await execute(); if (options.repeat) await new Promise(resolve => setTimeout(resolve, 16)); } while (options.repeat);
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
    turnRoute(route) {
      if (!route || route.target === 'player') { this.turnPlayer(route?.direction || route); return; }
      const eventId = String(route.target || '').startsWith('event:') ? String(route.target).slice(6) : '';
      const event = (mapEntry?.mwgEvents || []).find(candidate => String(candidate.id) === eventId);
      if (event) { event.facing = route.direction; this.refreshEventSprites(); }
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
        const box = createDialogueBox(mwg, { width: Math.max(320, game.width - 48), height: this.messageBoxHeight('scroll'), pages: [{ text: this.resolveEscapeCodes(scroll.text) }], speed, autoAdvance: hold, dims: this.messageOptions.frame === 0, anchor: this.messageAnchor(), onDone: () => { this.windows.pop(); this.dialogue = null; this.confirmLock = true; this.confirmLockUntil = performance.now() + 180; resolve(); } });
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
      for (const sprite of this.pictureSprites.values()) if (sprite.pictureRotateSpeed) sprite.rotation += sprite.pictureRotateSpeed * dt;
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
    installParallax(spec, url) {
      if (this.parallax) { this.stage.removeChild(this.parallax); this.parallax.destroy?.(); this.parallax = null; }
      this.parallaxState = { name: String(spec.name || ''), loopX: spec.loopX === true, loopY: spec.loopY === true, sx: Number(spec.sx || 0), sy: Number(spec.sy || 0), driftX: 0, driftY: 0 };
      if (!url) return;
      this.parallax = new mwg.TiledSprite({ texture: mwg.Resources.texture(url), width: game.width, height: game.height });
      if (this.stage.addChildAt) this.stage.addChildAt(this.parallax, 0); else this.stage.addChild(this.parallax);
    }
    // 284 Change Parallax. The image loads on demand; an empty name removes the layer.
    async changeParallax(spec) {
      if (isXp || !mwg.TiledSprite) return;
      const url = parallaxUrlFor(spec.name);
      if (spec.name && !url) { console.warn(`MWGP parallax '${spec.name}' needs decoded parallax art (convert with --copy-assets)`); return; }
      if (url) { try { await loadResource(url); } catch { console.warn(`MWGP parallax image is missing: ${spec.name}`); return; } }
      this.installParallax(spec, url);
    }
    // Game_Map.parallaxOx: the image drifts at half the map's scroll when it loops (all of it when the name starts
    // with '!'), plus the configured speed; without a loop flag it stays fixed to the screen.
    updateParallax(dt) {
      const state = this.parallaxState;
      if (!this.parallax || !state) return;
      if (state.loopX) state.driftX += state.sx * 0.625 * dt;
      if (state.loopY) state.driftY += state.sy * 0.625 * dt;
      const scrollTX = (this.camera ? -(this.world?.x || 0) : -(this.tileMap?.x || 0)) / tileSize;
      const scrollTY = (this.camera ? -(this.world?.y || 0) : -(this.tileMap?.y || 0)) / tileSize;
      const zero = state.name.startsWith('!');
      this.parallax.tilePosition = { x: foregroundOrigin(state.loopX, zero, scrollTX, state.driftX, tileSize), y: foregroundOrigin(state.loopY, zero, scrollTY, state.driftY, tileSize) };
    }
    // Foreground.js per-frame update; the pick and the origin math live in the
    // pure selectForegroundLayer/foregroundOrigin below so tests can pin them.
    // Map scroll in px is the negated world offset; shake/pan ride along,
    // invisibly for mist.
    updateForeground(dt) {
      const a = mapSettings.foreground || null, b = mapSettings.foregroundB || null;
      const show = (sprite, on) => { if (sprite) sprite.visible = !!on; };
      const isOn = id => !id || this.gameState.switch(String(id));
      const active = selectForegroundLayer(a, b, isOn);
      show(this.foregroundA, active === 'a');
      show(this.foregroundB, active === 'b');
      const settings = active === 'a' ? a : active === 'b' ? b : null;
      const sprite = active === 'a' ? this.foregroundA : active === 'b' ? this.foregroundB : null;
      if (!settings || !sprite) return;
      const drift = this.foregroundDrift;
      if (settings.loopX) drift[`${active}x`] += settings.sx * 0.625 * dt;
      if (settings.loopY) drift[`${active}y`] += settings.sy * 0.625 * dt;
      const scrollTX = (this.camera ? -(this.world?.x || 0) : -(this.tileMap?.x || 0)) / tileSize;
      const scrollTY = (this.camera ? -(this.world?.y || 0) : -(this.tileMap?.y || 0)) / tileSize;
      sprite.tilePosition = {
        x: foregroundOrigin(settings.loopX, settings.zero, scrollTX, drift[`${active}x`], tileSize),
        y: foregroundOrigin(settings.loopY, settings.zero, scrollTY, drift[`${active}y`], tileSize)
      };
    }
    // ---- audio (BGM/BGS/ME/SE): thin wrappers over the AudioManager -------------------
    applyMapAudio() {
      const track = entry => ({ name: entry?.name || '', volume: entry?.volume ?? 90, pitch: entry?.pitch ?? 100, pan: entry?.pan ?? 0 });
      if (map.autoplayBgm !== false && map.bgm) this.audio.playBgm(track(map.bgm));
      if (map.autoplayBgs === true && map.bgs) this.audio.playBgs(track(map.bgs));
    }
    playSound(sound) { this.audio?.playSe(sound); }
    stopSound() { this.audio?.stopSe(); }
    playTrack(kind, track) { if (kind === 'bgs') this.audio?.playBgs(track); else this.audio?.playBgm(track); }
    saveBgm(both = false) {
      // MV's Save BGM memorizes the BGM; XP's Memorize BGM/BGS memorizes both.
      this.audio?.saveBgm();
      if (both) this.audio?.saveBgs();
    }
    resumeBgm(both = false) {
      this.audio?.replayBgm();
      if (both) this.audio?.replayBgs();
    }
    playMe(me) { this.audio?.playMe(me); }
    unimplementedScene(scene) {
      console.warn(`MWGP open-${scene} has no player scene; the menu/save UI does not exist outside RPG Maker`);
    }
    // The full menu (Item / Skill / Equip / Status / Save / Options / Game End, src/player/menu.js) when the project
    // has the MV/MZ database; the small Save/Close box below otherwise (XP conversions carry no database).
    async openMenu() {
      const database = project.database || {};
      if (!(database.actors && database.classes && database.items && database.skills)) return this.openSimpleMenu();
      if (this.menuOpen) return undefined;
      this.menuOpen = true;
      try {
        if (!this.rpgExtra.party?.length) { const fallbackActor = findPlayerActor(project); if (fallbackActor) this.rpgExtra.party = [fallbackActor]; }
        const party = [...(this.rpgExtra.party || [])];
        const records = Object.fromEntries(party.map(id => [id, this.actorRecord(id)]));
        const present = request => this.presentDialogue(request);
        const menuState = { gold: this.rpgExtra.gold || 0 };
        await runMenu({
          database, records, party, items: this.rpgExtra.items, weapons: this.rpgExtra.weapons ||= {}, armors: this.rpgExtra.armors ||= {}, gold: menuState.gold, present,
          variable: key => this.gameState.variable(String(key)),
          hooks: {
            maxBattleMembers: this.maxBattleMembers(),
            formation: this.rpgExtra.system?.formationAccess === false ? null : { get: () => this.rpgExtra.formation || 'default', set: name => { this.rpgExtra.formation = name; } },
            save: this.rpgExtra.system?.saveAccess === false ? null : async () => { const slot = await this.pickSlot(present, { forSave: true }); if (slot) this.saveGame(slot); return Boolean(slot); },
            load: this.savedSlots().size ? async () => { const slot = await this.pickSlot(present, { forSave: false }); if (slot) this.loadGame(slot); } : null,
            options: () => this.optionsMenu(present),
            toTitle: () => { try { this.saves.delete('runtime-transition'); } catch { /* headless */ } const url = new URL(globalThis.location.href); url.search = ''; url.searchParams.set('id', new URLSearchParams(globalThis.location.search).get('id') || ''); globalThis.location.href = url.toString(); }
          }
        });
        this.rpgExtra.party = party;   // the Formation screen reorders it in place
      } finally { this.menuOpen = false; this.confirmLock = true; this.confirmLockUntil = performance.now() + 180; }
      return 'close';
    }
    // Options: the audio mixer (master / BGM / BGS / ME / SE, cycling 0-100 %, plus mute).
    async optionsMenu(present) {
      if (!this.audio) { await present({ text: 'No options for this project.' }); return; }
      const pick = createPicker(present, project.database?.system?.terms);
      const rows = [['master', 'Master'], ['bgm', project.database?.system?.terms?.messages?.bgmVolume || 'BGM Volume'], ['bgs', project.database?.system?.terms?.messages?.bgsVolume || 'BGS Volume'], ['me', project.database?.system?.terms?.messages?.meVolume || 'ME Volume'], ['se', project.database?.system?.terms?.messages?.seVolume || 'SE Volume']];
      for (;;) {
        const entry = await pick('Options', [...rows.map(([kind, label]) => ({ kind, label: `${label}: ${Math.round(this.audio.volumes[kind] * 100)}%` })), { kind: 'mute', label: `Mute: ${this.audio.volumes.muted ? 'on' : 'off'}` }]);
        if (!entry) return;
        if (entry.kind === 'mute') this.audio.toggleMute();
        else { const next = (Math.round(this.audio.volumes[entry.kind] * 4) + 1) % 5; this.audio.setVolume(entry.kind, next / 4); }
      }
    }
    openSimpleMenu() {
      return new Promise(resolve => {
        this.dialogue = true;
        const box = createDialogueBox(mwg, {
          width: Math.max(320, game.width - 48),
          height: 126,
          pages: [{ text: 'Menu' }],
          choices: [{ text: 'Save', value: 'save' }, { text: 'Close', value: 'close' }],
          dims: this.messageOptions.frame === 0,
          anchor: 'center',
          onDone: chosen => {
            this.windows.pop();
            this.dialogue = null;
            this.confirmLock = true;
            this.confirmLockUntil = performance.now() + 180;
            if (chosen === 'save') this.saveGame();
            resolve(chosen);
          }
        });
        this.windows.push(box);
      });
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
    fadeoutBgm({ duration }) { this.audio?.fadeOutBgm(duration); }
    fadeoutBgs({ duration }) { this.audio?.fadeOutBgs(duration); }
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
      if (!this.rpgExtra.actors[key]) {
        const actor = project.database?.actors?.[Number(id)];
        const klass = project.database?.classes?.[Number(actor?.classId)];
        const level = Math.max(1, Number(actor?.initialLevel || 1));
        // MV stores class parameters as [paramId][level].
        const maxHp = Math.max(1, Number(klass?.params?.[0]?.[level] || 100));
        const maxMp = Math.max(0, Number(klass?.params?.[1]?.[level] || 0));
        this.rpgExtra.actors[key] = { states: [], skills: [], equips: {}, profile: '', level, classId: Number(actor?.classId || 0), hp: maxHp, maxHp, mp: maxMp, maxMp };
      }
      return this.rpgExtra.actors[key];
    }
    refreshActorStats(id, record) {
      const actor = project.database?.actors?.[Number(id)];
      const classId = Number(record.classId || actor?.classId || 0);
      const klass = project.database?.classes?.[classId];
      const level = Math.max(1, Number(record.level || actor?.initialLevel || 1));
      record.maxHp = Math.max(1, Number(klass?.params?.[0]?.[level] || record.maxHp || 100));
      record.maxMp = Math.max(0, Number(klass?.params?.[1]?.[level] || record.maxMp || 0));
      record.hp = Math.max(0, Math.min(record.maxHp, Number(record.hp ?? record.maxHp)));
      record.mp = Math.max(0, Math.min(record.maxMp, Number(record.mp ?? record.maxMp)));
      record.dead = record.hp <= 0;
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
      if (command.changeHp) {
        const spec = command.changeHp;
        for (const id of this.actorTargets(state, spec)) {
          const record = this.actorRecord(id);
          let amount = this.resolveAmount(state, spec.amount) * (Number(spec.sign) < 0 ? -1 : 1);
          if (amount < 0 && spec.allowDeath !== true && record.hp <= -amount) amount = 1 - record.hp;
          record.hp = Math.max(0, Math.min(record.maxHp, record.hp + amount));
          record.dead = record.hp <= 0;
        }
      }
      if (command.changeLevel) {
        const spec = command.changeLevel;
        for (const id of this.actorTargets(state, spec)) {
          const record = this.actorRecord(id);
          record.level = Math.max(1, Number(record.level || 1) + this.resolveAmount(state, spec.amount) * (Number(spec.sign) < 0 ? -1 : 1));
          this.refreshActorStats(id, record);
        }
      }
      if (command.changeClass) {
        const spec = command.changeClass;
        const record = this.actorRecord(spec.actor);
        record.classId = Number(spec.classId);
        this.refreshActorStats(spec.actor, record);
      }
      if (command.changeState) {
        for (const id of this.actorTargets(state, command.changeState)) {
          const record = this.actorRecord(id);
          record.states = command.changeState.add
            ? (record.states.includes(command.changeState.state) ? record.states : [...record.states, command.changeState.state])
            : record.states.filter(stateId => stateId !== command.changeState.state);
        }
      }
      if (command.recoverAll) for (const id of this.actorTargets(state, command.recoverAll)) {
        const record = this.actorRecord(id);
        record.states = []; record.hp = record.maxHp; record.mp = record.maxMp; record.dead = false;
      }
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
        if (item) this.actorRecord(actor).equips[String(slot)] = { id: Number(item), kind: Number(slot) === 1 ? 'weapon' : 'armor' };
        else delete this.actorRecord(actor).equips[String(slot)];
      }
      if (command.changeProfile) this.actorRecord(command.changeProfile.actor).profile = command.changeProfile.profile;
    }
    // ---- system settings (commands 132-140, 216, 281, 323 and the access flags 134-137) ------------------
    // Game_System keeps these; saves round-trip them through rpgExtra.system. Only menuAccess, saveAccess and
    // the battle/victory/defeat audio have a consumer here; see the compatibility notes in convert-mv.js.
    setSystemFlag({ key, value }) { (this.rpgExtra.system ||= {})[key] = value; }
    // 312 MP, 315 EXP, 317 parameter, 326 TP. TP has no battle model, so it is only recorded on the actor.
    applyActorStat(state, spec) {
      for (const id of this.actorTargets(state, spec)) {
        const record = this.actorRecord(id);
        const amount = this.resolveAmount(state, spec.amount) * (Number(spec.sign) < 0 ? -1 : 1);
        if (spec.stat === 'mp') record.mp = Math.max(0, Math.min(record.maxMp, Number(record.mp ?? record.maxMp) + amount));
        else if (spec.stat === 'tp') record.tp = Math.max(0, Math.min(100, Number(record.tp || 0) + amount));
        else if (spec.stat === 'param') { const bonus = (record.paramPlus ||= {}); bonus[spec.param] = Number(bonus[spec.param] || 0) + amount; }
        else if (spec.stat === 'exp') {
          // Game_Actor.changeExp(currentExp + value): the level follows the experience table.
          const klass = project.database?.classes?.[Number(record.classId || 0)];
          const before = Number(record.level || 1);
          record.exp = Math.max(0, Number(record.exp ?? expForLevel(klass, before)) + amount);
          const max = Number(project.database?.actors?.[Number(id)]?.maxLevel || 99);
          while (record.level < max && record.exp >= expForLevel(klass, record.level + 1)) record.level++;
          while (record.level > 1 && record.exp < expForLevel(klass, record.level)) record.level--;
          if (record.level !== before) this.refreshActorStats(id, record);
        }
      }
    }
    changeActorText({ actor, field, text }) { this.actorRecord(actor)[field] = text; }
    changeActorImages(spec) { Object.assign(this.actorRecord(spec.actor), { characterName: spec.characterName, characterIndex: spec.characterIndex, faceName: spec.faceName, faceIndex: spec.faceIndex, battlerName: spec.battlerName }); }
    // 124 Control Timer: counts down in seconds while the map runs; condition 111/timer reads it. There is no
    // on-screen counter (the engine draws one); the value is what events can observe.
    setTimer(spec) {
      if (spec.stop) { if (this.rpgExtra.timer) this.rpgExtra.timer.working = false; return; }
      this.rpgExtra.timer = { seconds: Math.max(0, Number(spec.start || 0)), working: true };
    }
    tickTimer(dt) {
      const timer = this.rpgExtra.timer;
      if (!timer?.working) return;
      timer.seconds = Math.max(0, timer.seconds - dt);
      if (timer.seconds <= 0) timer.working = false;   // the engine's onExpire aborts a battle; on the map nothing else happens
    }
    // 206 Get on/off Vehicle, the same action as pressing the vehicle key facing one.
    boardVehicle() { this.tryVehicleAction(); }
    // 261 Play Movie: a full-screen <video> over the canvas, awaited to its end. A missing file or a blocked
    // playback resolves at once with a warning, so an event never hangs on it. A click skips it.
    playMovie({ name }) {
      const url = project.assets ? `${project.assets.root}/movies/${encodeURIComponent(name)}.webm` : null;
      if (!url || typeof document === 'undefined') { console.warn(`MWGP movie '${name}' cannot be played here`); return Promise.resolve(); }
      return new Promise(resolve => {
        const video = document.createElement('video');
        Object.assign(video.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', background: '#000', zIndex: 9999, objectFit: 'contain' });
        video.src = url; video.autoplay = true; video.playsInline = true;
        let finished = false;
        const done = () => { if (finished) return; finished = true; video.remove(); resolve(); };
        video.addEventListener('ended', done);
        video.addEventListener('click', done);
        video.addEventListener('error', () => { console.warn(`MWGP movie '${name}' failed to load`); done(); });
        document.body.appendChild(video);
        video.play?.().catch(() => { console.warn(`MWGP movie '${name}' was blocked from playing`); done(); });
      });
    }
    // 339 Force Action (only inside a troop event; elsewhere the engine has no battler to act).
    async forceAction(spec) {
      if (!this.battleControls?.forceAction) { this.unsupportedCommand('forceAction', spec); return; }
      await this.battleControls.forceAction(spec);
      this.refreshBattleStage();
    }
    // ---- battle status panel: name, HP / MP / TP gauges (the engine's gauge colours) -------------------------------
    // Top right of the stage, clear of the message box at the bottom. One row per battle member.
    buildBattleStatus(stage, actors) {
      const palette = gaugePalette();
      const scale = game.height / Number(project.display?.height || 624);
      const rowHeight = 30 * scale, gaugeHeight = (project.source?.engine === 'rpg-maker-mz' ? 12 : 6) * scale;
      const showTp = project.database?.system?.optDisplayTp !== false;
      const width = (showTp ? 560 : 430) * scale;
      const panel = new mwg.Container2D();
      const back = new mwg.TintedSprite({ texture: this.battleShadeTexture });
      back.width = width; back.height = actors.length * rowHeight + 12 * scale; back.alpha = 0.6;
      panel.addChild(back);
      const gradient = (from, to) => {
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 1;
        const context = canvas.getContext('2d');
        const fill = context.createLinearGradient(0, 0, 64, 0);
        const css = value => `#${value.toString(16).padStart(6, '0')}`;
        fill.addColorStop(0, css(from)); fill.addColorStop(1, css(to));
        context.fillStyle = fill; context.fillRect(0, 0, 64, 1);
        return mwg.Texture2D.from(canvas);
      };
      const rows = actors.map((actor, index) => {
        const y = 6 * scale + index * rowHeight;
        const name = new mwg.Label({ text: actor.name, size: 18 * scale, color: palette.text });
        name.x = 8 * scale; name.y = y; panel.addChild(name);
        const gauge = (label, x, w, colors) => {
          const caption = new mwg.Label({ text: label, size: 14 * scale, color: palette.crisis });
          caption.x = x; caption.y = y; panel.addChild(caption);
          const bar = new mwg.Bar({ width: w, height: gaugeHeight, value: 1, max: 1, fillTexture: gradient(colors[0], colors[1]), background: palette.gaugeBack });
          bar.x = x; bar.y = y + 20 * scale; panel.addChild(bar);
          const value = new mwg.Label({ text: '', size: 14 * scale, color: palette.text, align: 'right' });
          value.anchor?.set(1, 0); value.x = x + w; value.y = y; panel.addChild(value);   // right-aligned to the gauge's end
          return { bar, value, w };
        };
        return { actor, hp: gauge('HP', 150 * scale, 120 * scale, palette.hp), mp: gauge('MP', 290 * scale, 120 * scale, palette.mp), tp: showTp ? gauge('TP', 430 * scale, 110 * scale, palette.tp) : null, name };
      });
      panel.x = game.width - width - 8 * scale; panel.y = 8 * scale;
      stage.addChild(panel);
      this.battleStatus = { panel, rows };
      this.refreshBattleStatus();
    }
    refreshBattleStatus() {
      const palette = gaugePalette();
      for (const row of this.battleStatus?.rows || []) {
        const { actor } = row;
        const set = (part, value, max) => {
          if (!part) return;
          part.bar.setValue(max > 0 ? Math.max(0, Math.min(1, value / max)) : 0, 1);
          part.value.setText(max > 0 ? `${Math.max(0, Math.round(value))}/${Math.round(max)}` : `${Math.round(value)}`);
        };
        set(row.hp, actor.hp, actor.mhp); set(row.mp, actor.mp, actor.mmp);
        if (row.tp) { row.tp.bar.setValue(Math.max(0, Math.min(1, actor.tp / 100)), 1); row.tp.value.setText(String(Math.round(actor.tp))); }
        // Window_Base.hpColor: knockout when dead, crisis under a quarter, else normal.
        row.name.setColor(actor.dead ? palette.knockout : actor.isDying ? palette.crisis : palette.text);
      }
    }
    // ---- actor poses (Sprite_Actor motions) -----------------------------------------------------------------------
    svEntry(actor) { return this.battleActorSprites?.find(entry => entry.actor === actor && entry.sheet) || null; }
    svMotion(actor, name) {
      const entry = this.svEntry(actor);
      if (entry) entry.motion = { name, elapsed: 0, oneShot: !SV_MOTIONS[name]?.loop };
    }
    updateBattlePoses(dt) {
      const database = project.database;
      for (const entry of this.battleActorSprites || []) {
        if (!entry.sheet) continue;
        entry.motion ||= { name: 'wait', elapsed: 0, oneShot: false };
        const current = entry.motion;
        if (!current.oneShot && !entry.hold) {
          // An idle pose follows the battler: dead, asleep, guarding, dying...
          const idle = svIdleMotion(entry.actor, database);
          if (current.name !== idle) { current.name = idle; current.elapsed = 0; }
        }
        current.elapsed += dt;
        const { pattern, done } = svPattern(current.name, current.elapsed);
        if (done) { entry.motion = { name: entry.hold || svIdleMotion(entry.actor, database), elapsed: 0, oneShot: false }; continue; }
        const texture = entry.sheet.get(svCell(current.name, pattern));
        if (texture && entry.sprite.texture !== texture) entry.sprite.texture = texture;
      }
    }
    // ---- battle effects: damage popups, hit shakes, attack steps, skill animations ---------------------------------
    // Popups use mw_games' FloatingTextStack (stacked, rising, fading numbers). Motions are small offsets applied to
    // a sprite's stored home position and always return to it. None of this changes the battle's outcome: the runner
    // reports what happened through hooks.onUse / hooks.onEffect and this only draws it.
    battleSpriteFor(battler) {
      return (battler.isActor ? this.battleActorSprites : this.battleSprites)?.find(entry => (entry.actor || entry.enemy) === battler)?.sprite || null;
    }
    battlePointFor(battler) {
      const sprite = this.battleSpriteFor(battler);
      if (sprite) return { x: sprite.fxBase?.x ?? sprite.x, y: (sprite.fxBase?.y ?? sprite.y) - (sprite.height || 0) / 2, feetY: sprite.fxBase?.y ?? sprite.y, height: sprite.height || 0, sprite };
      const index = Number(battler.index || 0);
      return battler.isActor ? { x: game.width * 0.78, y: game.height * (0.45 + index * 0.06), feetY: game.height * (0.5 + index * 0.06), height: 0 } : { x: game.width * (0.25 + index * 0.1), y: game.height * 0.4, feetY: game.height * 0.45, height: 0 };
    }
    battleMotion(sprite, motion) {
      if (!sprite) return;
      sprite.fxBase ||= { x: sprite.x, y: sprite.y };
      this.battleFx.motions = this.battleFx.motions.filter(entry => entry.sprite !== sprite);   // a new motion replaces a running one
      this.battleFx.motions.push({ sprite, t: 0, ...motion });
    }
    battleUse({ subject, item, isItem }) {
      if (subject.isActor) this.svMotion(subject, svActionMotion(subject, item, isItem, project.database));
      // The attacker steps toward the enemy (actors move left, enemies right) and back.
      const sprite = this.battleSpriteFor(subject);
      if (sprite) this.battleMotion(sprite, { kind: 'step', dx: (subject.isActor ? -1 : 1) * 24 * (sprite.scale?.x || 1), dur: 0.35 });
    }
    battleEffect(effect) {
      if (!this.battleFx) return;
      const { target, kind } = effect;
      const point = this.battlePointFor(target);
      const push = (text, color, size = 22) => this.battleFx.stack.push({ text, color, size, x: point.x, y: point.y, key: target.isActor ? `a${target.index}` : `e${target.index}` });
      if (target.isActor) { if (kind === 'miss') this.svMotion(target, 'evade'); else if (effect.hp < 0) this.svMotion(target, 'damage'); }
      if (kind === 'miss') { push('Miss', 0xb0b0b0, 18); return; }
      if (effect.hp) {
        const amount = Math.abs(effect.hp);
        if (effect.hp < 0) { push(String(amount), target.isActor ? 0xff7070 : 0xffffff, effect.critical ? 30 : 22); this.battleMotion(point.sprite, { kind: 'shake', amp: 6 * (point.sprite?.scale?.x || 1), dur: 0.3 }); }
        else push(String(amount), 0x90ee90);
      }
      if (effect.mp) push(String(Math.abs(effect.mp)), effect.mp < 0 ? 0xc090ff : 0x80c8ff, 18);
      if (effect.animationId > 0) this.playBattleAnimation(effect.animationId, point).catch(error => console.warn('MWGP battle animation failed', error));
    }
    // The animation's sheets load on first use (only the current map's event animations are preloaded).
    async playBattleAnimation(id, point) {
      const animation = project.database?.animations?.[id];
      if (!animation || !this.battleStage || !project.assets?.animations) return;
      for (const name of [animation.animation1Name, animation.animation2Name].filter(Boolean)) {
        if (animationSheets.has(name)) continue;
        const url = `${project.assets.root}/img/animations/${encodeURIComponent(name)}.png`;
        if (await loadResource(url).then(() => true, () => false)) animationSheets.set(name, mwg.SpriteSheet.grid(url, 192));
      }
      if (!this.battleStage) return;   // the battle ended while the sheets loaded
      const y = animation.position === 3 ? game.height / 2 : animation.position === 2 ? point.feetY : animation.position === 0 ? point.feetY - point.height : point.y;
      await this.playAnimationAt({ animation: id, x: animation.position === 3 ? game.width / 2 : point.x, y, wait: false, parent: this.battleStage });
    }
    updateBattleFx(dt) {
      const fx = this.battleFx;
      if (!fx) return;
      fx.stack.update(dt);
      fx.motions = fx.motions.filter(motion => {
        motion.t += dt;
        const base = motion.sprite.fxBase || { x: motion.sprite.x, y: motion.sprite.y };
        const done = motion.t >= motion.dur;
        const k = Math.min(1, motion.t / motion.dur);
        if (done) { motion.sprite.x = base.x; motion.sprite.y = base.y; return false; }
        if (motion.kind === 'shake') motion.sprite.x = base.x + Math.sin(motion.t * 70) * motion.amp * (1 - k);
        else motion.sprite.x = base.x + motion.dx * Math.sin(Math.PI * k);
        return true;
      });
    }
    // 233 Rotate Picture: Game_Picture.rotate(speed) turns the picture speed / 2 degrees every frame (60 per second),
    // about its origin; a new Show Picture resets it (the sprite is recreated).
    rotatePicture({ id, speed }) {
      const sprite = this.pictureSprites.get(id);
      if (sprite) sprite.pictureRotateSpeed = Number(speed) / 2 * 60 * Math.PI / 180;
    }
    // 285 Get Location Info, evaluated with Game_Map's own rules: terrainTag is the first non-zero flags>>12 from
    // the top layer down, tileId(x, y, z) reads one layer, regionId is layer 5, eventIdXy is the first event there.
    locationInfo(state, spec) {
      const read = key => Number(state.game.variable(String(key)) ?? 0);
      const x = spec.x !== undefined ? spec.x : read(spec.xVar), y = spec.y !== undefined ? spec.y : read(spec.yVar);
      const inside = x >= 0 && y >= 0 && x < map.width && y < map.height;
      const size = map.width * map.height;
      const tile = layer => (inside ? map.data?.[layer * size + y * map.width + x] || 0 : 0);
      let value = 0;
      if (spec.info === 0) { for (const layer of [3, 2, 1, 0]) { const tag = Number(tilesetFlags[tile(layer)] ?? 0) >> 12; if (tag > 0) { value = tag; break; } } }
      else if (spec.info === 1) value = Number((mapEntry.mwgEvents || []).find(event => Number(event.x) === x && Number(event.y) === y && !this.erasedEvents.has(event.id))?.id ?? 0) || 0;
      else if (spec.info >= 2 && spec.info <= 5) value = tile(spec.info - 2);
      else value = tile(5);
      state.game.setVariable(String(spec.variable), value);
    }
    // 104 Select Item: picks from the inventory items of one item type (1 regular, 2 key, 3 hidden A, 4 hidden B)
    // and stores the item id in the variable, 0 when cancelled.
    async selectItem(state, spec) {
      const items = project.database?.items || {};
      const owned = Object.entries(this.rpgExtra.items || {}).filter(([id, count]) => count > 0 && Number(items[id]?.itypeId ?? 1) === Number(spec.itemType));
      if (!owned.length) { state.game.setVariable(String(spec.variable), 0); return; }
      const pick = createPicker(request => this.presentDialogue(request), project.database?.system?.terms);
      const chosen = await pick('', owned.map(([id, count]) => ({ label: `${items[id]?.name || `#${id}`} ×${count}`, id: Number(id) })));
      state.game.setVariable(String(spec.variable), chosen?.id ?? 0);
    }
    // 340 Abort Battle and 334 Enemy Recover All (troop events only).
    abortBattle() {
      if (!this.battleControls?.abort) { this.unsupportedCommand('abortBattle', {}); return; }
      this.battleControls.abort();
    }
    enemyRecoverAll(spec) {
      for (const enemy of this.battleEnemyTargets(spec, 'enemyRecoverAll')) {
        for (const state of [...(enemy.states || [])]) enemy.removeState?.(state.id);
        enemy.hp = enemy.mhp; enemy.mp = enemy.mmp;
      }
    }
    // Game_Party.maxBattleMembers: 4 in the engine; a project or plugin setting (`system.maxBattleMembers`) may raise it.
    maxBattleMembers() { return Math.max(1, Number(this.rpgExtra.system?.maxBattleMembers ?? project.database?.system?.maxBattleMembers ?? 4)); }
    // 354 Return to Title Screen.
    returnToTitle() {
      try { this.saves.delete('runtime-transition'); } catch { /* headless */ }
      const url = new URL(globalThis.location.href); url.search = ''; url.searchParams.set('id', new URLSearchParams(globalThis.location.search).get('id') || '');
      globalThis.location.href = url.toString();
    }
    setTransparent(transparent) {
      // MV draws a transparent player at reduced opacity rather than hiding it.
      // Route opacity steps (code 42) carry an exact alpha instead of the flag.
      const target = transparent && typeof transparent === 'object' ? String(transparent.target || 'player') : 'player';
      const value = transparent && typeof transparent === 'object' ? transparent.value : transparent;
      const alpha = typeof value === 'number' ? Math.max(0, Math.min(1, value)) : (value ? 160 / 255 : 1);
      if (target === 'player') { if (this.player) this.player.alpha = alpha; return; }
      const eventId = target.startsWith('event:') ? target.slice(6) : '';
      const item = (this.eventSprites || []).find(entry => String(entry.event.id) === eventId);
      this.eventAlpha.set(eventId, alpha);
      if (item) item.sprite.alpha = alpha;
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
    // Event-script Ruby (XP/VX/Ace) that the converter transpiled to JS; see rgss-script.js.
    runScript(script, state) { return this.rgss.run(script, state, this.currentEvent); }
    evalScriptCondition(script, state) { return this.rgss.evaluate(script, state, this.currentEvent); }
    pluginCommand(command, state) {
      // The game's own plugins: MV's `Game_Interpreter#pluginCommand` chain, or the MZ command the named plugin registered.
      if (this.rgss.pluginCommand?.(command?.name, command?.args, state, this.currentEvent, { plugin: command?.plugin, params: command?.params })) return;
      this.unsupportedCommand('pluginCommand', command?.raw || command);
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
      const anchorY = animation.position === 3
        ? game.height / 2
        : animation.position === 2 ? origin.feetY : animation.position === 0 ? origin.feetY - origin.h : origin.feetY - origin.h / 2;
      return this.playAnimationAt({ ...command, x: animation.position === 3 ? game.width / 2 : origin.x, y: anchorY });
    }
    playAnimationAt(command) {
      const animation = project.database?.animations?.[command.animation];
      if (!animation) {
        console.warn(`MWGP animation ${command.animation} has no data; skipping`);
        return Promise.resolve();
      }
      const frames = animation.frames || [];
      const container = new mwg.Container2D();
      container.x = Number(command.x || 0);
      container.y = Number(command.y || 0);
      const parent = command.parent || this.overlayLayer;
      parent.addChild(container);
      // MV advances animation frames at ~12fps; timings (per-frame SE/flash)
      // have no player equivalent and are skipped.
      const duration = Math.max(0.1, frames.length / 12);
      return new Promise(resolve => {
        this.overlayAnims.push({
          kind: 'animation', container, parent, animation, frames, frameCount: frames.length,
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
        // Patterns 0-99 read animation1's sheet, 100 and up animation2's (pattern - 100).
        const second = Number(pattern) >= 100;
        const sheet = animationSheets.get(second ? anim.animation.animation2Name : anim.animation.animation1Name);
        if (!sheet) continue;
        const sprite = new mwg.TintedSprite({ texture: sheet.get(Math.max(0, (pattern || 0) - (second ? 100 : 0))) });
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
          (anim.parent || this.overlayLayer).removeChild(anim.container);
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
      const resolved = resolveTransferTarget(target, id => state?.game.variable(String(id)), project.maps);
      if (!resolved) {
        console.warn('MWGP transfer target is invalid; staying on the current map', target);
        if (typeof this.flashTitle === 'function') this.flashTitle('Transfert impossible — voir console (F12)');
        return;
      }
      const { mapId, x, y } = resolved;
      // Transfer Player to the map the player is already on does not reload anything in RPG Maker: the player is moved and
      // the event that asked carries on with its next command. Reloading here would restart that event forever (an
      // autorun event whose first command is such a transfer never finished).
      if (Number(mapId) === Number(mapEntry.id)) {
        this.mover.x = x; this.mover.y = y;
        position.x = x; position.y = y;
        this.updateCamera();
        return;
      }
      try {
        this.saves.save('runtime-transition', this.runtimeState({ mapId, x, y, facing: this.facing, rpg: this.gameState.toJSON(), extra: this.rpgExtra }), { mapId, x, y });
      } catch (error) { console.warn('MWGP transfer save failed; continuing without carried state', error); }
      this.transferring = true;
      const params = new URLSearchParams(location.search);
      params.set('map', String(mapId)); params.set('x', String(x)); params.set('y', String(y));
      params.delete('tileset');
      const changed = this.rpgExtra.mapTilesets?.[String(mapId)];
      if (changed !== undefined) params.set('tileset', String(changed));
      location.href = `${location.pathname}?${params}`;
    }
    // 282 Change Tileset: the map is rebuilt with the new tileset at the player's position, carrying all state through the
    // same save-and-reload a transfer uses. The event that asked restarts from its first command once after the reload (the
    // scene cannot be rebuilt in place), so it is best placed first in the event; asking again for the tileset already in
    // use does nothing, which is what ends that restart.
    changeTileset({ id }) {
      const target = Number(id);
      if (!project.tilesets?.[target]) { this.unsupportedCommand('changeTileset', { id }); return; }
      if (target === tilesetId) return;
      this.rpgExtra.mapTilesets = { ...(this.rpgExtra.mapTilesets || {}), [String(mapEntry.id)]: target };
      try {
        this.saves.save('runtime-transition', this.runtimeState({ mapId: mapEntry.id, x: this.mover.x, y: this.mover.y, facing: this.facing, rpg: this.gameState.toJSON(), extra: this.rpgExtra }), { mapId: mapEntry.id, x: this.mover.x, y: this.mover.y });
      } catch (error) { console.warn('MWGP tileset change could not carry state; continuing without it', error); }
      this.transferring = true;
      const query = new URLSearchParams(location.search);
      query.set('map', String(mapEntry.id)); query.set('x', String(this.mover.x)); query.set('y', String(this.mover.y)); query.set('tileset', String(target));
      location.href = `${location.pathname}?${query}`;
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
    saveGame(slot = this.lastSlot || 1) {
      const key = `slot-${slot}`;
      this.lastSlot = slot;
      try {
        this.noteEngineSave();
        this.saves.save(key, this.runtimeState({ mapId: mapEntry.id, x: this.mover.x, y: this.mover.y, facing: this.mover.facing, rpg: this.gameState.toJSON(), extra: this.rpgExtra }), { mapId: mapEntry.id, x: this.mover.x, y: this.mover.y, gold: this.rpgExtra.gold, leader: this.slotLeader() });
        console.info(`MWGP saved ${key} on map ${mapEntry.id} at (${this.mover.x}, ${this.mover.y})`);
        this.flashTitle(`✓ Saved (file ${slot})`);
      } catch (error) { console.error('MWGP save failed', error); this.flashTitle('✗ Save failed — see console (F12)'); }
    }
    // MV counts every successful save on `$gameSystem._saveCount` and events
    // gate on it (Karryn's door scene loops its save prompt until the count is
    // nonzero). evaluateValue snapshots the engine synchronously, so the count
    // rides inside the save written above and across transfers like the engine.
    noteEngineSave() {
      if (!this.rgss || this.engineSaveCounted === false) return;
      const count = { game: this.gameState };
      const probe = this.rgss.evaluateValue({ source: 'typeof $gameSystem', mv: true, js: "return (typeof $gameSystem !== 'undefined' && $gameSystem) ? 1 : 0;" }, count, this.currentEvent);
      if (!probe) { this.engineSaveCounted = false; return; }
      this.engineSaveCounted = true;
      this.rgss.evaluateValue({ source: '$gameSystem._saveCount = ($gameSystem._saveCount || 0) + 1;', mv: true, js: 'return ($gameSystem._saveCount = ($gameSystem._saveCount || 0) + 1);' }, count, this.currentEvent);
    }
    // MV's Open Save Screen (code 352) shows the file window: the player picks
    // a slot and cancelling saves nothing. Never a silent write to the last slot.
    async promptSaveGame() {
      const slot = await this.pickSlot(request => this.presentDialogue(request), { forSave: true });
      if (slot) this.saveGame(slot);
    }
    // ---- save files: SLOT_COUNT numbered slots, each with a one-line summary ---------------------------------
    slotLeader() {
      const id = Number((this.rpgExtra.party || [])[0]);
      const actor = project.database?.actors?.[id];
      return actor ? { name: actor.name, level: Number(this.rpgExtra.actors?.[String(id)]?.level || actor.initialLevel || 1) } : null;
    }
    savedSlots() {
      const slots = new Map();
      try { for (const item of this.saves.list()) { const match = /^slot-(\d+)$/.exec(item.slot); if (match) slots.set(Number(match[1]), item); } } catch { /* headless */ }
      return slots;
    }
    slotLabel(slot, item) {
      if (!item) return `File ${slot}: —`;
      const preview = item.meta?.preview || {};
      const where = (project.maps || []).find(map => Number(map.id) === Number(preview.mapId))?.info?.name || `Map ${preview.mapId}`;
      const who = preview.leader ? `${preview.leader.name} Lv${preview.leader.level}  ` : '';
      return `File ${slot}: ${who}${where}  ${new Date(item.meta.savedAt).toLocaleString()}`;
    }
    // Asks which file (paged); `forSave` lists empty slots too. Resolves to the slot number or null.
    async pickSlot(present, { forSave }) {
      const slots = this.savedSlots();
      const rows = [];
      for (let slot = 1; slot <= SLOT_COUNT; slot++) if (forSave || slots.has(slot)) rows.push({ slot, label: this.slotLabel(slot, slots.get(slot)) });
      if (!rows.length) { await present({ text: 'No saved games yet.' }); return null; }
      const pick = createPicker(present, project.database?.system?.terms);
      const chosen = await pick(forSave ? (project.database?.system?.terms?.messages?.saveMessage || 'Which file would you like to save to?') : (project.database?.system?.terms?.messages?.loadMessage || 'Which file would you like to load?'), rows);
      return chosen?.slot ?? null;
    }
    loadGame(slot = this.lastSlot || 1) {
      try {
        const key = `slot-${slot}`;
        const saved = this.saves.load(key);
        this.lastSlot = slot;
        if (!saved) { this.flashTitle('No save in slot 1 yet'); return false; }
        if (this.mover.isMoving) return false;
        const state = saved.state;
        if (!state || typeof state !== 'object' || !state.rpg) {
          console.warn('MWGP save in slot 1 is unreadable; ignoring it', state);
          this.flashTitle('Sauvegarde illisible — voir console (F12)');
          return false;
        }
        const entry = (project.maps || []).find(map => Number(map.id) === Number(state.mapId));
        if (!entry) {
          console.warn(`MWGP save in slot 1 points at unknown map ${state.mapId}; ignoring it`, state);
          this.flashTitle('Sauvegarde illisible — voir console (F12)');
          return false;
        }
        if (state.extra) this.rpgExtra = { ...freshExtraState(), ...state.extra };
        const pos = sanitizeMapPosition({ x: state.x, y: state.y }, entry);
        if (Number(state.mapId) !== Number(mapEntry.id)) {
          this.mapRuntime = { ...(state.mapRuntime || {}), ...this.mapRuntime };
          try {
            this.saves.save('runtime-transition', { ...state, ...this.runtimeState({}), audio: state.audio, mapId: Number(entry.id), x: pos.x, y: pos.y, extra: this.rpgExtra }, { mapId: Number(entry.id), x: pos.x, y: pos.y });
          } catch (error) { console.warn('MWGP load carry-over save failed; loading the map without carried state', error); }
          const params = new URLSearchParams(location.search);
          params.set('map', String(Number(entry.id))); params.set('x', String(pos.x)); params.set('y', String(pos.y));
          location.href = `${location.pathname}?${params}`;
          return true;
        }
        position.x = pos.x; position.y = pos.y; this.facing = state.facing || 'down';
        if (state.audio) this.audio?.restore(state.audio);
        try {
          this.gameState = mwg.Rpg.GameState.fromJSON(state.rpg);
        } catch (error) {
          console.warn('MWGP save in slot 1 has a corrupt game state; ignoring it', error);
          this.flashTitle('Sauvegarde illisible — voir console (F12)');
          return false;
        }
        this.restoreRuntimeState(state);
        this.mover = new mwg.Rpg.GridMover(this.player, position.x, position.y, { tileWidth: tileSize, tileHeight: tileSize, speed: 6, walkAnimation: direction => `walk-${direction}`, idleAnimation: direction => `idle-${direction}` });
        this.refreshEventSprites();
        this.updateCamera();
        console.info(`MWGP loaded ${key} on map ${state.mapId} at (${pos.x}, ${pos.y})`);
        this.flashTitle('✓ Loaded (slot 1)');
        return true;
      } catch (error) { console.error('MWGP load failed', error); this.flashTitle('✗ Load failed — see console (F12)'); return false; }
    }
    teardown() { window.removeEventListener('keydown', this.saveKey); this.audio?.stopAll(); this.windows?.destroy(); }
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

function collectRouteImageNames(commands) {
  const names = [];
  for (const command of commands || []) {
    if (command.routeImage?.image?.name) names.push(command.routeImage.image.name);
    for (const block of childBlocks(command)) names.push(...collectRouteImageNames(block));
  }
  return names;
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
  return {
    gold: 0, items: {}, weapons: {}, armors: {}, party: [], actors: {}, playerName: '', system: {}, timer: null
  };
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

// The dialogue-driven battle fallback (no MV-style troop runner exists, see
// roadmap item J): one duel per enemy, minimum 1 damage each way so every
// battle terminates, flee offered only when the troops allow escape.
// Exported pure-of-scene (the `present` dialogue seam is injected) so tests
// can drive win/lose/escape deterministically. Consumes hero/enemies (hp).
export async function runBattleFallback(setup, present) {
  const { hero, enemies, canEscape, onTurn } = setup;
  await present({ text: `Un combat commence contre ${enemies.map(enemy => enemy.name).join(', ')}.` });
  for (const enemy of enemies) {
    if (enemy.appeared === false) continue;
    while (hero.hp > 0 && enemy.hp > 0) {
      const choice = await present({
        text: `${hero.name} (${hero.hp}/${hero.maxHp}) — ${enemy.name} (${enemy.hp}/${enemy.maxHp})`,
        choices: [{ text: 'Attaquer', value: 0 }, ...(canEscape ? [{ text: 'Fuir', value: 1 }] : [])]
      });
      if (Number(choice) === 1) {
        await present({ text: `${hero.name} s'enfuit.` });
        return 'escape';
      }
      const damage = Math.max(1, hero.atk - Math.floor(enemy.def / 2));
      enemy.hp = Math.max(0, enemy.hp - damage);
      await present({ text: `${hero.name} inflige ${damage} dégâts à ${enemy.name}.` });
      if (enemy.hp <= 0) {
        await present({ text: `${enemy.name} est vaincu.` });
        break;
      }
      const retaliation = Math.max(1, enemy.atk - Math.floor(hero.def / 2));
      hero.hp = Math.max(0, hero.hp - retaliation);
      if (onTurn) await onTurn();
      await present({ text: `${enemy.name} inflige ${retaliation} dégâts à ${hero.name}.` });
    }
    if (hero.hp <= 0) {
      await present({ text: `${hero.name} est vaincu.` });
      return 'lose';
    }
  }
  await present({ text: 'Victoire !' });
  return 'win';
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

// Clamps a map position into the map rectangle (floored). Pure so
// tools/test-smoke.mjs can cover it in Node. Non-finite coordinates read as 0
// instead of propagating NaN into the mover, the camera, or the URL.
export function sanitizeMapPosition(pos, mapEntry) {
  const w = Number(mapEntry?.data?.width);
  const h = Number(mapEntry?.data?.height);
  let x = Math.floor(Number(pos?.x));
  let y = Math.floor(Number(pos?.y));
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  x = Number.isFinite(w) && w > 0 ? Math.max(0, Math.min(w - 1, x)) : Math.max(0, x);
  y = Number.isFinite(h) && h > 0 ? Math.max(0, Math.min(h - 1, y)) : Math.max(0, y);
  return { x, y };
}

// Validates a converter-emitted transfer target (direct ids or variable refs)
// against the manifest map list. Pure (the variable lookup is injected) so
// tools/test-smoke.mjs can cover it in Node. Returns { mapId, x, y } with the
// position clamped to the target map, or null when the target is unusable —
// the scene then stays on the current map with a loud warning instead of
// navigating to a URL no map can boot from.
export function resolveTransferTarget(target, variable, maps) {
  if (!target || typeof target !== 'object') {
    console.warn('MWGP transfer target is missing; staying on the current map', target);
    return null;
  }
  const value = (id, fallback) => id === undefined ? fallback : variable(String(id));
  let rawMap, rawX, rawY;
  try {
    rawMap = value(target.mapVar, target.mapId);
    rawX = value(target.xVar, target.x);
    rawY = value(target.yVar, target.y);
  } catch (error) {
    console.warn('MWGP transfer variable lookup failed; staying on the current map', target, error);
    return null;
  }
  const mapId = Number(rawMap);
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(mapId) || !Number.isFinite(x) || !Number.isFinite(y)) {
    console.warn('MWGP transfer target has non-numeric coordinates; staying on the current map', target);
    return null;
  }
  const entry = (maps || []).find(map => Number(map?.id) === mapId);
  if (!entry) {
    console.warn(`MWGP transfer target map ${mapId} is not in this project; staying on the current map`, target);
    return null;
  }
  const pos = sanitizeMapPosition({ x, y }, entry);
  return { mapId: Number(entry.id), x: pos.x, y: pos.y };
}

// Resolves one converter-emitted move step against the live facing. Pure (no
// scene) so tools/test-smoke.mjs can cover the descriptor table in Node.
// Returns { dx, dy }, { jump } or null (degenerate/unknown: toward/away from
// the player itself when the route target is the player).
export function resolveRouteStep(step, facing, origin = null, target = null) {
  if (!step || typeof step !== 'object') return null;
  if (step.turn) return { turn: step.turn };
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
  if ((step.toward || step.away) && origin && target) {
    const sign = step.toward ? 1 : -1;
    const dx = target.x - origin.x, dy = target.y - origin.y;
    return Math.abs(dx) >= Math.abs(dy)
      ? { dx: sign * Math.sign(dx), dy: 0 }
      : { dx: 0, dy: sign * Math.sign(dy) };
  }
  return null;
}

// Foreground.js layer pick, pure so tools/test-smoke.mjs can pin it in Node:
// 'a' when the A switch is on, 'b' when it is off but B is on and neither
// hide-switch is, 'a' again otherwise, null when every all-off combination
// hides both. Mirrors the plugin's updateForeground gates exactly.
export function selectForegroundLayer(a, b, isOn) {
  if (!a && !b) return null;
  const on = id => !id || !!isOn(id);
  const aOn = on(a?.switch), bOn = on(b?.switch);
  const bClear = !!b && bOn && !(b.notSwitch && isOn(b.notSwitch)) && !(b.notSwitch2 && isOn(b.notSwitch2));
  // A set id of 0/undefined counts as unset: on() already treats it as on, so
  // compare the raw ids (not the resolved states) for the gate combinations.
  const hidden = (a?.switch && b?.switch && !aOn && !bOn) || (a?.switch && !b?.switch && !aOn) || (b?.switch && !a?.switch && !bOn && !a?.name);
  if (hidden) return null;
  if (aOn && a) return 'a';
  if (bClear) return 'b';
  return a ? 'a' : null;
}

// Tiling origin in px for one Foreground.js axis: full map-scroll rate for `!`
// zero-foregrounds, half rate for loop flags, screen-fixed otherwise. Scroll
// and drift arrive in tiles; tilePx scales back to px like the plugin's
// display * tileWidth(/2) origins.
export function foregroundOrigin(loop, zero, scrollTiles, driftTiles, tilePx) {
  if (zero) return (scrollTiles + driftTiles) * tilePx;
  if (loop) return (scrollTiles + driftTiles) * tilePx / 2;
  return 0;
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

// Game-data variable operands resolved from player-held state (no engine
// needed): inventory counts, the player's live position, party membership,
// and the map/gold/party-size counters.
// Pure so tests can pin it; the scene
// method passes live mover/map context. Unknown kinds read as 0 with a loud
// warning instead of aborting the event.
export function resolveGameDataOperand(extra, context, spec) {
  const store = { itemCount: 'items', weaponCount: 'weapons', armorCount: 'armors' }[spec?.kind];
  if (store) return Number(extra?.[store]?.[String(spec.id)] || 0);
  switch (spec?.kind) {
    case 'playerX': return Number(context?.playerX ?? 0);
    case 'playerY': return Number(context?.playerY ?? 0);
    case 'partyMember': return Number(extra?.party?.[Number(spec.index)] ?? 0);
    case 'mapId': return Number(context?.mapId ?? 0);
    case 'partySize': return (extra?.party || []).length;
    case 'gold': return Number(extra?.gold || 0);
    default: console.warn('MWGP game-data operand is not playable without RPG Maker and read as 0', spec); return 0;
  }
}

// Exported for tools/test-smoke.mjs: the module has no imports and no
// top-level side effects, so Node can import it and drive this function with
// a stub scene. The browser entry point is unaffected (it uses startMwgPlayer).
export function prepareEventCommands(commands, scene) {
  // A malformed list (hand-edited manifest, corrupt data) must never throw
  // synchronously into the caller's frame loop: warn loudly and run nothing.
  // A missing list is the normal "no else branch" shape older manifests omit,
  // not corruption: run nothing without the warning.
  if (commands === undefined) return [];
  if (!Array.isArray(commands)) {
    console.warn('MWGP event list is not an array; skipping it', commands);
    return [];
  }
  return commands.map(command => {
    // A null/non-object entry would break EventRunner.run the same way: warn
    // loudly and replace it with a no-op instead of throwing.
    if (!command || typeof command !== 'object') {
      console.warn('MWGP event command is malformed; skipping it', command);
      return { call: () => {} };
    }
    if (command.if?.script) return { call: async state => {
      const matches = scene.evalScriptCondition(command.if.script, state);
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.operator) return { call: async state => {
      const condition = command.if;
      const left = Number(state.game.variable(String(condition.variable)) || 0);
      const right = condition.compareVariable !== undefined
        ? Number(state.game.variable(String(condition.compareVariable)) || 0)
        : Number(condition.value || 0);
      const matches = { eq: left === right, neq: left !== right, gte: left >= right, lte: left <= right, gt: left > right, lt: left < right }[condition.operator] === true;
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    // Conditions over player-held state (party, facing, gold, inventory) have no
    // upstream equivalent, so they evaluate here against scene.rpgExtra instead
    // of reaching EventRunner, which only understands switch/variable shapes.
    if (command.if?.vehicle !== undefined) return { call: async state => {
      const matches = scene.activeVehicle === command.if.vehicle;
      return scene.runBranch(matches ? command.then : command.else);
    } };
    if (command.if?.partyMember !== undefined) return { call: async state => {
      const matches = (scene.rpgExtra?.party || []).includes(Number(command.if.partyMember));
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.facing !== undefined) return { call: async state => {
      const matches = scene.facing === command.if.facing;
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.eventFacing !== undefined) return { call: async state => {
      const matches = (scene.currentEvent?.facing || 'down') === command.if.eventFacing;
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.gold) return { call: async state => {
      const amount = Number(scene.rpgExtra?.gold || 0);
      const value = Number(command.if.gold.value || 0);
      const matches = { gte: amount >= value, lte: amount <= value, lt: amount < value }[command.if.gold.operator] === true;
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.item !== undefined) return { call: async state => {
      const matches = (scene.rpgExtra?.items?.[String(command.if.item)] || 0) > 0;
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    // Actor skill/state checks read the player-held actor records without
    // creating them (actorRecord would populate); a missing record is false,
    // matching the engine's `if (actor)` guard for unknown ids.
    if (command.if?.actorName) return { call: async state => {
      const actor = scene.project?.database?.actors?.[Number(command.if.actorName.actor)];
      const matches = !!actor && String(scene.rpgExtra?.actors?.[String(command.if.actorName.actor)]?.name ?? actor.name ?? '') === String(command.if.actorName.name || '');
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.actorClass) return { call: async state => {
      const record = scene.rpgExtra?.actors?.[String(command.if.actorClass.actor)];
      const actor = scene.project?.database?.actors?.[Number(command.if.actorClass.actor)];
      const matches = Number(record?.classId ?? actor?.classId ?? 0) === Number(command.if.actorClass.classId);
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.actorWeapon) return { call: async state => {
      const record = scene.rpgExtra?.actors?.[String(command.if.actorWeapon.actor)];
      const matches = Object.values(record?.equips || {}).some(item => String(item?.kind || 'weapon') === 'weapon' && Number(item?.id ?? item) === Number(command.if.actorWeapon.weapon));
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.actorArmor) return { call: async state => {
      const record = scene.rpgExtra?.actors?.[String(command.if.actorArmor.actor)];
      const matches = Object.values(record?.equips || {}).some(item => String(item?.kind || 'armor') === 'armor' && Number(item?.id ?? item) === Number(command.if.actorArmor.armor));
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.weapon) return { call: async state => {
      const spec = command.if.weapon;
      const owned = Number(scene.rpgExtra?.weapons?.[String(spec.id)] || 0) > 0;
      const equipped = spec.includeEquipped === true && Object.values(scene.rpgExtra?.actors || {}).some(record => Object.values(record?.equips || {}).some(item => String(item?.kind || 'weapon') === 'weapon' && Number(item?.id ?? item) === Number(spec.id)));
      await scene.runBranch(prepareEventCommands(owned || equipped ? command.then : command.else, scene));
    } };
    if (command.if?.armor) return { call: async state => {
      const spec = command.if.armor;
      const owned = Number(scene.rpgExtra?.armors?.[String(spec.id)] || 0) > 0;
      const equipped = spec.includeEquipped === true && Object.values(scene.rpgExtra?.actors || {}).some(record => Object.values(record?.equips || {}).some(item => String(item?.kind || 'armor') === 'armor' && Number(item?.id ?? item) === Number(spec.id)));
      await scene.runBranch(prepareEventCommands(owned || equipped ? command.then : command.else, scene));
    } };
    if (command.if?.actorSkill) return { call: async state => {
      const record = scene.rpgExtra?.actors?.[String(command.if.actorSkill.actor)];
      const matches = (record?.skills || []).includes(Number(command.if.actorSkill.skill));
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.enemyAlive) return { call: async state => {
      const enemy = scene.battleEnemies?.[Number(command.if.enemyAlive.index)];
      await scene.runBranch(prepareEventCommands(enemy && enemy.appeared !== false && enemy.hp > 0 ? command.then : command.else, scene));
    } };
    if (command.if?.enemyState) return { call: async state => {
      const enemy = scene.battleEnemies?.[Number(command.if.enemyState.index)];
      await scene.runBranch(prepareEventCommands(enemy?.hasState?.(Number(command.if.enemyState.state)) ? command.then : command.else, scene));
    } };
    if (command.if?.timer) return { call: async () => {
      const timer = scene.rpgExtra?.timer;
      const seconds = timer ? Math.ceil(timer.seconds) : 0;
      const matches = command.if.timer.atLeast ? seconds >= command.if.timer.seconds : seconds <= command.if.timer.seconds;
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    if (command.if?.actorState) return { call: async state => {
      const record = scene.rpgExtra?.actors?.[String(command.if.actorState.actor)];
      const matches = (record?.states || []).includes(Number(command.if.actorState.state));
      await scene.runBranch(prepareEventCommands(matches ? command.then : command.else, scene));
    } };
    // Convert-time unsupported marker: warn loudly and take the else-branch
    // (false), matching what the upstream runner would do with an
    // unrecognized shape — but visibly, never silently.
    if (command.if?.unsupported) return { call: async state => {
      scene.unsupportedCommand('condition', command.if.unsupported);
      await scene.runBranch(prepareEventCommands(command.else, scene));
    } };
    if (command.if) return { ...command, then: prepareEventCommands(command.then, scene), ...(command.else ? { else: prepareEventCommands(command.else, scene) } : {}) };
    if (command.loop) return { call: () => scene.runLoop(prepareEventCommands(command.loop, scene)) };
    if (command.breakLoop) return { call: () => { throw new BreakLoopSignal(); } };
    if (command.exitEvent) return { call: () => { throw new ExitEventSignal(); } };
    if (command.goto !== undefined) return { call: () => { throw new JumpSignal(command.goto); } };
    if (command.copyVariable !== undefined) return { call: state => scene.copyVariable(state, command) };
    if (command.modifyVariable) return { call: state => scene.modifyVariable(state, command) };
    if (command.inputNumber) return { call: state => scene.inputNumber(state, command) };
    if (command.inputName) return { call: state => scene.inputName(state, command) };
    if (command.messageOptions) return { call: () => scene.setMessageOptions(command.messageOptions) };
    if (command.mapSettings) return { call: () => scene.setMapSettings(command.mapSettings) };
    if (command.shop) return { call: () => scene.openShop(command.shop) };
    if (command.weather) return { call: () => scene.setWeather(command.weather) };
    if (command.gameOver) return { call: () => scene.gameOver() };
    if (command.enemyAppear) return { call: () => scene.enemyAppear(command.enemyAppear) };
    if (command.changeEnemyHp) return { call: state => scene.changeEnemyStat('changeEnemyHp', command.changeEnemyHp, state) };
    if (command.changeEnemyMp) return { call: state => scene.changeEnemyStat('changeEnemyMp', command.changeEnemyMp, state) };
    if (command.changeEnemyTp) return { call: state => scene.changeEnemyStat('changeEnemyTp', command.changeEnemyTp, state) };
    if (command.changeEnemyState) return { call: () => scene.changeEnemyState(command.changeEnemyState) };
    if (command.enemyTransform) return { call: () => scene.enemyTransform(command.enemyTransform) };
    if (command.battle) return { call: async () => {
      const outcome = await scene.startBattle(command.battle);
      const branch = command.battle.branches?.[outcome];
      if (branch) await scene.runBranch(prepareEventCommands(branch, scene));
    } };
    if (Array.isArray(command.branches)) return { call: () => scene.presentChoice({ ...command, branches: command.branches.map(branch => prepareEventCommands(branch, scene)), cancelBranch: command.cancelBranch && prepareEventCommands(command.cancelBranch, scene) }) };
    if (command.transfer) return { call: state => scene.transfer(command.transfer, state) };
    if (command.systemFlag) return { call: () => scene.setSystemFlag(command.systemFlag) };
    if (command.changeActorStat) return { call: state => scene.applyActorStat(state, command.changeActorStat) };
    if (command.changeActorText) return { call: () => scene.changeActorText(command.changeActorText) };
    if (command.changeActorImages) return { call: () => scene.changeActorImages(command.changeActorImages) };
    if (command.timer) return { call: () => scene.setTimer(command.timer) };
    if (command.vehicleBoard) return { call: () => scene.boardVehicle() };
    if (command.playMovie) return { call: () => scene.playMovie(command.playMovie) };
    if (command.forceAction) return { call: () => scene.forceAction(command.forceAction) };
    if (command.changeTileset) return { call: () => scene.changeTileset(command.changeTileset) };
    if (command.changeParallax) return { call: () => scene.changeParallax(command.changeParallax) };
    if (command.rotatePicture) return { call: () => scene.rotatePicture(command.rotatePicture) };
    if (command.locationInfo) return { call: state => scene.locationInfo(state, command.locationInfo) };
    if (command.selectItem) return { call: state => scene.selectItem(state, command.selectItem) };
    if (command.abortBattle) return { call: () => scene.abortBattle() };
    if (command.enemyRecoverAll) return { call: () => scene.enemyRecoverAll(command.enemyRecoverAll) };
    if (command.returnToTitle) return { call: () => scene.returnToTitle() };
    if (command.vehicleLocation) return { call: state => scene.setVehicleLocation(command.vehicleLocation, state) };
    if (command.routeThrough) return { call: () => scene.setRouteThrough(command.routeThrough) };
    if (command.routeOption) return { call: () => scene.setRouteOption(command.routeOption) };
    if (command.routeImage) return { call: () => scene.setRouteImage(command.routeImage) };
    if (command.move?.repeat) return { call: () => command.move.wait ? scene.runMoveRoute(command.move.target, command.move.steps, command.move) : scene.startMoveRoute(command.move) };
    if (command.picture) return { call: () => scene.showPicture(command.picture) };
    if (command.erasePicture !== undefined) return { call: () => scene.erasePicture(command.erasePicture) };
    if (command.movePicture) return { call: () => scene.movePicture(command.movePicture) };
    if (command.tintPicture) return { call: () => scene.tintPicture(command.tintPicture) };
    if (command.balloon) return { call: () => scene.showBalloon(command.balloon) };
    if (command.animation) return { call: () => scene.playAnimation(command.animation) };
    if (command.animationAt) return { call: () => scene.playAnimationAt(command.animationAt) };
    if (command.commonEvent !== undefined) return { call: () => scene.runCommonEvent(command.commonEvent) };
    if (command.scroll) return { call: () => scene.presentScroll(command.scroll) };
    if (command.scrollMap) return { call: () => scene.scrollMap(command.scrollMap) };
    if (command.relocate) return { call: state => scene.relocate(state, command) };
    if (command.saveBgm) return { call: () => scene.saveBgm(command.saveBgm === 'both') };
    if (command.resumeBgm) return { call: () => scene.resumeBgm(command.resumeBgm === 'both') };
    if (command.me) return { call: () => scene.playMe(command.me) };
    if (command.menu === 'save') return { call: () => scene.promptSaveGame() };
    if (command.menu === 'menu') return { call: () => scene.openMenu() };
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
    if (command.changeHp !== undefined || command.changeLevel !== undefined || command.changeClass !== undefined || command.changeState !== undefined || command.recoverAll !== undefined || command.changeSkill !== undefined || command.changeEquipment !== undefined || command.changeProfile !== undefined) return { call: state => scene.applyActor(state, command) };
    if (command.setTransparent !== undefined) return { call: () => scene.setTransparent(command.setTransparent) };
    if (command.eraseEvent) return { call: () => scene.eraseEvent() };
    // XP scripts arrive transpiled (`js`); MV/MZ scripts are JavaScript in `script` itself.
    if (command.script !== undefined && (command.js !== undefined || command.error !== undefined || command.mv === true)) return { call: state => scene.runScript({ source: command.script, js: command.js, async: command.async === true, error: command.error }, state) };
    if (command.script !== undefined) return { call: () => scene.unsupportedCommand('script', command.script) };
    if (command.pluginCommand) return { call: state => scene.pluginCommand(command.pluginCommand, state) };
    // Convert-time unsupported marker (unmappable 122 operands, ...): warn
    // loudly and continue with the next command instead of aborting the event.
    if (command.unsupported) return { call: () => scene.unsupportedCommand('command', command.unsupported) };
    if (command.turn) return { call: () => typeof command.turn === 'object' ? scene.turnRoute(command.turn) : scene.turnPlayer(command.turn) };
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
  if (slot >= 5) return safeTileFrame(mwg, sheet, normalTileFrame(tile), sheets);
  const base = slot === 0 ? 2048 : slot === 1 ? 2816 : slot === 2 ? 4352 : slot === 3 ? 5888 : 1536;
  return safeTileFrame(mwg, sheet, tile - base, sheets);
}

// B-E sheets are addressed in 8-column halves, not row-major-16:
// col = (floor(id/128)%2)*8 + id%8, row = floor((id%256)/8)%16, frame =
// row*16+col (rpg_core.js Tilemap._drawNormalTile, both renderers).
// Row-major lands on unrelated art — e.g. Karryn's BBgradation2 dev-marker
// badges. Pure so tests can pin it.
export function normalTileFrame(tile) {
  const col = (Math.floor(tile / 128) % 2) * 8 + (tile % 8);
  const row = Math.floor((tile % 256) / 8) % 16;
  return row * 16 + col;
}

// A character cell past the end of its sheet (the measured grid disagrees with the image) must not abort the scene:
// fall back to the first frame, once per sheet, loudly.
const warnedCharacterSheets = new Set();
function safeCharacterCell(sheet, cell, name) {
  const count = sheet?.count;
  if (!Number.isFinite(count) || cell < count) return cell;
  if (!warnedCharacterSheets.has(name)) { warnedCharacterSheets.add(name); console.warn(`MWGP character sheet '${name}' has ${count} frames but frame ${cell} was requested; using frame 0`); }
  return 0;
}

function safeTileFrame(mwg, sheet, frame, sheets) {
  // A tile id past the end of its tileset image (maps outlive edits to the image) draws nothing, as in the editor;
  // the TileMap would otherwise refuse the whole layer ("frame N is outside this sheet").
  const count = sheets?.[sheet]?.count;
  if (Number.isFinite(count) && frame >= count) return mwg.EMPTY;
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

// Use a large separation between rows so the optional tie-breaker keeps the
// player above an event standing on exactly the same tile, matching the stable
// insertion order of the original map scene.
export function characterDepth(y, tieBreaker = 0) {
  return Number(y || 0) * 1000 + Number(tieBreaker || 0);
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

// RPG Maker's passage check walks visible tile layers from top to bottom. A
// zero tile is empty and a star tile delegates to the layer below; the first
// ordinary tile decides the direction. This is shared by MV and XP manifests.
export function passageAllowsStep(tileIds, flags, bit) {
  for (const tile of tileIds || []) {
    if (!tile) continue;
    const flag = flags?.[tile] ?? 0;
    if ((flag & 0x10) !== 0) continue;
    return (flag & bit) === 0;
  }
  return true;
}

function directionBit(dx, dy) {
  if (dy > 0) return 0x01;
  if (dx < 0) return 0x02;
  if (dx > 0) return 0x04;
  return 0x08;
}
