import { assetUrl, loadAssetUrl } from '/asset-url.js';

const playerHost = globalThis.mwgpPlayerHost;
const id = playerHost?.id || new URLSearchParams(location.search).get('id');
const canvas = document.querySelector('#game');
const loading = document.createElement('div');
loading.id = 'loading';
loading.className = 'mwgp-loading';
loading.textContent = 'Loading game data…';
loading.setAttribute('role', 'status');
canvas.before(loading);
let bootstrapFailed = false;
try {
  const runtime = document.createElement('script');
  runtime.src = playerHost?.runtimeUrl || '/mwg.js';
  await new Promise((resolve, reject) => { runtime.onload = resolve; runtime.onerror = () => reject(new Error('mwg runtime failed to load')); document.head.append(runtime); });
  playerHost?.installAssets();
  const { MwgPlayer } = await import('/fallback-core.js');
  // T119: boot from the lightweight index (map stubs only) instead of the
  // whole manifest, then fetch just the booted map. The single-file on-disk
  // manifest and the full-manifest route are unchanged.
  const projectId = encodeURIComponent(id || '');
  const indexResponse = await fetch(`/api/mwgp/${projectId}/index`);
  if (!indexResponse.ok) throw new Error(`MWGP project not found (${indexResponse.status})`);
  const project = await indexResponse.json();
  if (playerHost) project.loadRgssRuntime = playerHost.loadRgssRuntime;
  // The stage is the game's own screen size (816x624 in MV/MZ by default), so the engine lays out, scrolls and draws windows
  // exactly as the original does; CSS scales the finished picture to the page (`?scale=1` pins it to 1:1 for pixel comparison).
  const stage = document.querySelector('#stage');
  const screenW = Number(project.display?.width) || 816, screenH = Number(project.display?.height) || 624;
  stage.style.width = screenW + 'px'; stage.style.height = screenH + 'px';
  const fitStage = () => {
    const fixed = Number(new URLSearchParams(location.search).get('scale'));
    const k = fixed > 0 ? fixed : Math.max(0.25, Math.min((stage.parentElement.clientWidth || screenW) / screenW, (innerHeight - stage.getBoundingClientRect().top - 16) / screenH));
    stage.style.transform = 'scale(' + k + ')'; stage.parentElement.style.height = Math.ceil(screenH * k + stage.offsetTop) + 'px';
  };
  fitStage(); addEventListener('resize', fitStage);
  const query = new URLSearchParams(location.search);
  if (query.has('map')) project.initialMapId = Number(query.get('map'));
  if (query.has('x') && query.has('y')) project.player = { ...(project.player || {}), mapId: project.initialMapId, x: Number(query.get('x')), y: Number(query.get('y')) };
  // On-demand map loader: replaces the index stub with the full entry
  // (tile data + converted events), kept in project.maps so transfer
  // validation, save-slot names and the boot fallback chain keep working.
  project.mapRoot = `/api/mwgp/${projectId}/maps`;
  project.loadMap = async mapId => {
    const wanted = Number(mapId);
    const cached = project.maps.find(map => Number(map?.id) === wanted && map?.data);
    if (cached) return cached;
    const mapResponse = await fetch(`${project.mapRoot}/${wanted}`);
    if (!mapResponse.ok) throw new Error(`MWGP map ${wanted} not found (${mapResponse.status})`);
    const full = await mapResponse.json();
    const at = project.maps.findIndex(map => Number(map?.id) === Number(full?.id));
    if (at >= 0) project.maps[at] = full;
    else project.maps.push(full);
    return full;
  };
  // Same fallback chain as startMwgPlayer: requested map, start map, first.
  const hasMap = value => Number.isFinite(value) && project.maps.some(map => Number(map?.id) === value);
  const requestedMapId = query.has('map') ? Number(query.get('map')) : NaN;
  const bootMapId = hasMap(requestedMapId) ? requestedMapId
    : hasMap(Number(project.initialMapId)) ? Number(project.initialMapId)
    : Number(project.maps[0]?.id);
  if (!Number.isFinite(bootMapId)) throw new Error('MWGP project has no map');
  loading.textContent = 'Loading map…';
  await project.loadMap(bootMapId);
  if (project.assets?.kind === 'decoded') project.assets.root = `/api/mwgp/${id}/assets`;
  if (project.pluginLibrary?.files) project.pluginLibrary.root = `/api/mwgp/${id}/assets`;
  if (project.titleScreen?.assets?.kind === 'decoded') project.titleScreen.assets.root = `/api/mwgp/${id}/assets`;
  document.querySelector('#title').textContent = project.display?.title || 'MWGP Player';
  const studioBtn = document.querySelector('#studio-btn');
  if (studioBtn && id && !playerHost) {
    studioBtn.href = '/studio.html?id=' + encodeURIComponent(id);
    studioBtn.style.display = 'inline-block';
  }
  showCompatibilityWarning(project);
  if (!query.has('map') && !query.has('skipTitle')) await showTitleScreen(project);
  loading.textContent = 'Loading game assets…';
  try {
    const { startMwgPlayer } = await (playerHost?.loadPlayer() || import(`/player-core.js?v=${Date.now()}`));
    await startMwgPlayer(canvas, project);
  } catch (error) {
    console.warn('MWG player unavailable, using compatibility renderer', error);
    new MwgPlayer(canvas, project);
  }
} catch (error) {
  bootstrapFailed = true;
  console.error('MWGP bootstrap failed', error);
  document.querySelector('#title').textContent = 'MWGP Player — load failed';
  loading.textContent = `Unable to load this game: ${error?.message || 'unknown error'}`;
  loading.setAttribute('role', 'alert');
} finally {
  if (!bootstrapFailed) loading.remove();
}

// Runs the game's own title-scene plugins and records the sprite layers they
// build, so a custom title screen (picture commands, layered art) shows its
// own art instead of the generic fallback. Nothing names a game or a plugin:
// any shipped plugin that hooks Scene_Title is evaluated, in load order,
// against a recording stub engine (sprites register their bitmap, position
// and frame; bitmap dimensions come from the real images). Whatever fails is
// warned about and skipped — the stock title below remains the fallback.
async function capturePluginTitleLayers(project, savesExist) {
  const lib = project.pluginLibrary;
  const titleRoot = project.titleScreen?.assets?.root || project.assets?.root;
  if (!lib?.files?.plugins || !titleRoot) return null;
  const sources = [];
  for (const name of lib.order || []) {
    const file = lib.files.plugins[name];
    if (!file) continue;
    try { sources.push([name, await (await fetch(`${titleRoot}/${file}`)).text()]); } catch { /* a missing plugin file simply never runs */ }
  }
  if (!sources.some(([, source]) => /\bScene_Title\.prototype\.\w+\s*=/.test(source))) return null;
  const gameW = Number(project.display?.width) || 816, gameH = Number(project.display?.height) || 624;
  const title = project.titleScreen || {};
  const commands = { newGame: true, continue: true, options: true, ...(title.commands || {}) };
  const symbols = [commands.newGame && 'newGame', commands.continue && 'continue', commands.options && 'options'].filter(Boolean);
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.append(iframe);
  try {
    const win = iframe.contentWindow;
    const bitmaps = [], sprites = [];
    class BitmapRec {
      constructor(folder, name) { this.folder = folder; this.name = String(name || ''); this.width = 0; this.height = 0; bitmaps.push(this); }
    }
    class SpriteRec {
      constructor(bitmap) {
        this.bitmap = bitmap || null; this.x = 0; this.y = 0; this.opacity = 255; this.visible = true;
        this.scale = { x: 1, y: 1 }; this.anchor = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
        this.children = []; this.__frame = null; sprites.push(this);
      }
      setFrame(x, y, w, h) { this.__frame = { x, y, w, h }; }
      addChild(child) { this.children.push(child); return child; }
      removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; }
      move(x, y) { this.x = x; this.y = y; }
    }
    class WindowRec {
      constructor() { this.__children = []; this.visible = true; this.opacity = 255; }
      addChild(child) { this.__children.push(child); return child; }
      setHandler() {} setBackgroundType() {} updatePlacement() {} activate() {} deactivate() {}
    }
    class WindowTitleCommandRec extends WindowRec {
      constructor() { super(); this._list = symbols.map(symbol => ({ symbol, name: symbol })); this._index = 0; }
      isContinueEnabled() { return savesExist; }
      isCommandEnabled() { return true; }
      activate() {} deactivate() {} select(i) { this._index = i; } processOk() {}
    }
    class SceneBase {
      constructor() { this.__children = []; }
      addChild(child) { this.__children.push(child); return child; }
      removeChild(child) { const i = this.__children.indexOf(child); if (i >= 0) this.__children.splice(i, 1); return child; }
      create() {} update() {} isReady() { return true; }
    }
    class SceneTitleRec extends SceneBase {
      create() {
        this.createBackground(); this.createForeground(); this.createCommandWindow();
      }
      createBackground() {
        if ($dataSystem.title1Name) { this._backSprite1 = new SpriteRec(ImageManager.loadTitle1($dataSystem.title1Name)); this.addChild(this._backSprite1); }
        if ($dataSystem.title2Name) { this._backSprite2 = new SpriteRec(ImageManager.loadTitle1($dataSystem.title2Name)); this.addChild(this._backSprite2); }
      }
      createForeground() {}
      createCommandWindow() { this._commandWindow = new WindowTitleCommandRec(); this.addChild(this._commandWindow); }
    }
    const $dataSystem = { title1Name: title.title1 || '', title2Name: title.title2 || '', optDrawTitle: title.drawTitle !== false, gameTitle: project.display?.title || '' };
    // One shared deep-inert: any property read or call on it yields itself,
    // so a plugin touching an engine service we do not model fails soft
    // (falsy checks on plain objects below still behave).
    const inertObj = (() => {
      const self = new Proxy(function () {}, {
        get: (t, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : self),
        apply: () => self, set: () => true,
      });
      return self;
    })();
    const ImageManager = {
      loadTitle1: name => new BitmapRec('titles1', name), loadTitle2: name => new BitmapRec('titles2', name),
      loadPicture: name => new BitmapRec('pictures', name), loadSystem: name => new BitmapRec('system', name),
      loadBitmap: (folder, name) => new BitmapRec(String(folder || '').replace(/^img\//, ''), name),
    };
    for (const [key, value] of Object.entries({
      Sprite: SpriteRec, Scene_Title: SceneTitleRec, Scene_Base: SceneBase, Window_TitleCommand: WindowTitleCommandRec,
      ImageManager, $dataSystem,
      Graphics: { boxWidth: gameW, boxHeight: gameH, width: gameW, height: gameH, frameCount: 0 },
      PluginManager: { parameters: name => (lib.parameters || {})[name] || {}, setParameters() {}, registerCommand() {}, registerPluginCommand() {}, setup() {} },
      TextManager: new Proxy({}, { get: (t, p) => (typeof p === 'string' && p.startsWith('is') ? false : inertObj) }),
      $gameSwitches: { value: () => false }, $gameVariables: { value: () => 0 }, $gameActors: inertObj, $gameParty: inertObj, $gamePlayer: inertObj, $gameMap: inertObj, $gameTroop: inertObj, $gameSystem: inertObj, $gameTemp: inertObj, $gameScreen: inertObj, ConfigManager: {},
      $plugins: (project.plugins || []).map(name => ({ name, status: true, description: (lib.descriptions || {})[name] || '', parameters: (lib.parameters || {})[name] || {} })),
      Utils: { isNwjs: () => false, isMobileDevice: () => false, isOptionValid: () => false, canReadGameFiles: () => false, rgbToCssColor: (r, g, b) => `rgb(${r},${g},${b})`, extractFileName: p => String(p).split('/').pop().replace(/\.[^.]*$/, '') },
      require: () => ({}), Logger: null,
      TouchInput: { isTriggered: () => false, isPressed: () => false, x: 0, y: 0 },
      Input: { isTriggered: () => false, isPressed: () => false, dir4: 0, dir8: 0 },
      DataManager: inertObj, SceneManager: inertObj,
    })) win[key] = value;
    // MV core prototype staples plugins assume at load time.
    try {
      win.eval("Number.prototype.clamp = function (min, max) { return Math.min(Math.max(this, min), max); };" +
        "Number.prototype.padZero = function (n) { return String(this).padStart(n, '0'); };" +
        "String.prototype.format = function () { const args = arguments; return this.replace(/%([1-9]\\d*)/g, (m, i) => args[Number(i) - 1]); };" +
        "String.prototype.contains = function (s) { return this.includes(s); };" +
        "Array.prototype.equals = function (other) { return Boolean(other) && this.length === other.length && this.every((v, i) => v === other[i]); };");
    } catch { /* prototype setup is best-effort */ }
    // Engine class names the plugins may extend at load time get inert classes.
    for (const name of lib.engine || []) if (!(name in win)) { try { win[name] = class {}; } catch { /* a non-identifier name */ } }
    if (!('Scene_Base' in win)) win.Scene_Base = SceneBase;
    win.Logger = inertObj;
    win.Math.randomInt = max => Math.floor(Math.random() * max);
    // Real <script> tags, not eval: a plugin's top-level const/let must stay
    // visible to the plugins loaded after it, exactly as in the engine, and
    // one plugin throwing at load must not stop the next ones.
    let loadingPlugin = null;
    win.addEventListener('error', event => {
      console.warn(`MWGP title: plugin ${loadingPlugin || '?'} could not run and was skipped`, event.error || event.message);
    });
    for (const [name, source] of sources) {
      loadingPlugin = name;
      const script = win.document.createElement('script');
      script.textContent = source;
      win.document.head.append(script);
      script.remove();
    }
    loadingPlugin = null;
    let scene = null;
    try { scene = new win.Scene_Title(); scene.create(); } catch (error) { console.warn('MWGP title: the game title scene stopped early; keeping the layers it built', error); }
    if (!scene) return null;
    // Bitmap sizes drive the plugins' own frame/position maths (refresh runs
    // on update), so load the real images before updating the scene.
    await Promise.all(bitmaps.map(async b => {
      const src = await loadAssetUrl(`${titleRoot}/img/${b.folder}/${encodeURIComponent(b.name)}.png`);
      await new Promise(resolve => {
        const img = new Image();
        img.onload = () => { b.width = img.naturalWidth; b.height = img.naturalHeight; resolve(); };
        img.onerror = () => resolve();
        img.src = src;
      });
    }));
    for (let i = 0; i < 3; i++) { try { scene.update && scene.update(); } catch { break; } }
    const layers = sprites.filter(s => s.bitmap?.name && s.visible !== false && s.bitmap.width > 0)
      .map(s => ({ folder: s.bitmap.folder, name: s.bitmap.name, x: Number(s.x) || 0, y: Number(s.y) || 0,
        opacity: Math.max(0, Math.min(255, Number(s.opacity ?? 255))), frame: s.__frame,
        bitmapW: s.bitmap.width, bitmapH: s.bitmap.height }));
    // Picture-command sprites are recognizable structurally: a two-frame
    // image (normal/highlight halves) framed to one half. Their rectangles,
    // in creation order, are where the game's own commands live.
    const commands = sprites.filter(s => s.__frame && s.bitmap?.height === s.__frame.h * 2 && s.__frame.w === s.bitmap.width)
      .map(s => ({ x: Number(s.x) || 0, y: Number(s.y) || 0, w: s.__frame.w, h: s.__frame.h }));
    return layers.length ? { layers, commands } : null;
  } finally { iframe.remove(); }
}

async function showTitleScreen(project) {
  const title = project.titleScreen || {};
  // Title music and menu sounds. The audio context starts on the first key press or click
  // (browser autoplay rules), and the volume sliders below are shared with the game itself.
  let titleAudio = null;
  try {
    if (project.assets?.kind === 'decoded' && project.assets.audio && project.audio) {
      const { AudioManager } = await import('/audio-manager.js');
      titleAudio = new AudioManager({ root: project.assets.root, index: project.audio.index, cacheVersion: `${project.source?.convertedAt || ''}:assets${project.assets?.revision || 0}`, soundfontUrls: [project.audio.soundfont ? `${project.assets.root}/audio/${project.audio.soundfont}` : null, '/soundfont.sf2'].filter(Boolean) });
      titleAudio.unlock();
      if (project.audio.system?.titleBgm) titleAudio.playBgm(project.audio.system.titleBgm);
    }
  } catch (error) { console.warn('MWGP title audio unavailable', error); }
  const menuSound = name => { const sound = project.audio?.system?.sounds?.[name]; if (sound) titleAudio?.playSe(sound); };
  const titleRoot = title.assets?.root || project.assets?.root;
  const titleAssets = title.assets?.kind === 'decoded';
  const commands = { newGame: true, continue: true, options: true, ...(title.commands || {}) };
  const gameW = Number(project.display?.width) || 816, gameH = Number(project.display?.height) || 624;
  const root = document.createElement('section'); root.className = 'mwgp-title';
  const art = document.createElement('div'); art.className = 'mwgp-title-art';
  if (titleAssets && title.title2) art.style.backgroundImage = 'url("' + assetUrl(titleRoot + '/img/titles2/' + encodeURIComponent(title.title2) + '.png') + '")';
  const shade = document.createElement('div'); shade.className = 'mwgp-title-shade';
  const content = document.createElement('div'); content.className = 'mwgp-title-content';
  const kicker = document.createElement('p'); kicker.className = 'mwgp-title-kicker'; kicker.textContent = 'RPG Maker / MWGP';
  const name = document.createElement('h2'); name.className = 'mwgp-title-name'; name.textContent = project.display?.title || project.source?.projectName || 'Untitled game';
  // Stock engine titles draw title1/title2 as fullscreen layers (Scene_Title),
  // so they get the staged treatment below — never the small logo look.
  const stock = titleAssets && (title.title1 || title.title2);
  if (!stock) content.append(kicker, name);
  const menu = document.createElement('nav'); menu.className = 'mwgp-title-menu';
  const options = document.createElement('div'); options.className = 'mwgp-options'; options.hidden = true;
  if (titleAudio) {
    const heading = document.createElement('p'); heading.textContent = 'Volume'; options.append(heading);
    for (const [kind, label] of [['master', 'Master'], ['bgm', 'Music'], ['bgs', 'Ambience'], ['me', 'Jingles'], ['se', 'Effects']]) {
      const row = document.createElement('label'); row.style.cssText = 'display:flex;gap:10px;align-items:center;margin:4px 0';
      const text = document.createElement('span'); text.textContent = label; text.style.minWidth = '84px';
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(Math.round(titleAudio.volumes[kind] * 100));
      slider.addEventListener('input', () => titleAudio.setVolume(kind, Number(slider.value) / 100));
      slider.addEventListener('change', () => { if (kind === 'se') menuSound('cursor'); });
      row.append(text, slider); options.append(row);
    }
    const mute = document.createElement('label'); mute.style.cssText = 'display:flex;gap:10px;align-items:center;margin:8px 0 0';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = titleAudio.volumes.muted; box.addEventListener('change', () => titleAudio.setMuted(box.checked));
    const muteText = document.createElement('span'); muteText.textContent = 'Mute (M in game)'; mute.append(box, muteText); options.append(mute);
  } else options.textContent = 'This game has no converted audio.';
  const note = document.createElement('p'); note.className = 'mwgp-title-note'; note.textContent = 'Arrow keys / WASD / Enter or Space';
  const buttons = []; const makeButton = (label, primary, action) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (primary) button.dataset.primary = 'true'; button.addEventListener('click', () => { menuSound('ok'); action(); }); buttons.push(button); return button; };
  let finish; const done = new Promise(resolve => { finish = mode => { titleAudio?.fadeOutBgm(0.8); if (mode === 'continue') { const next = new URL(location.href); next.searchParams.set('load', '1'); next.searchParams.set('skipTitle', '1'); history.replaceState(null, '', next); } else if (mode === 'new') { const next = new URL(location.href); next.searchParams.set('newGame', '1'); next.searchParams.set('skipTitle', '1'); history.replaceState(null, '', next); } root.remove(); resolve(); }; });
  // The engine dims Continue when no save file exists (isContinueEnabled):
  // same namespace and slot keys the player itself uses (slot-N, 5 slots).
  // Any failure falls back to enabled, which is today's behavior.
  let savesExist = true;
  try {
    const saves = new globalThis.mwg.SaveSystem({ namespace: `mwgp:${project.source?.projectName || 'project'}`, version: 1 });
    savesExist = saves.list().some(item => /^slot-\d+$/.test(item?.slot));
  } catch { savesExist = true; }
  // A game whose plugins build their own title scene (no stock title1/title2)
  // gets its recorded sprite layers, with the stock command box on top.
  let pluginTitle = null;
  if (!stock && titleAssets) {
    try { pluginTitle = await capturePluginTitleLayers(project, savesExist); }
    catch (error) { console.warn('MWGP plugin title unavailable', error); }
  }
  // The title is built with synchronous DOM URLs, so every image it shows is loaded first.
  const titleImages = titleAssets ? [
    title.title1 && `${titleRoot}/img/titles1/${encodeURIComponent(title.title1)}.png`,
    title.title2 && `${titleRoot}/img/titles2/${encodeURIComponent(title.title2)}.png`,
  ].filter(Boolean) : [];
  for (const layer of pluginTitle?.layers ?? []) titleImages.push(`${titleRoot}/img/${layer.folder}/${encodeURIComponent(layer.name)}.png`);
  await Promise.all(titleImages.map(url => loadAssetUrl(url)));
  if (pluginTitle) {
    const stage = document.createElement('div');
    stage.className = 'mwgp-title-stage';
    stage.style.cssText = `position:relative;place-self:center;width:min(100%,calc((100vh - 170px)*${gameW}/${gameH}));aspect-ratio:${gameW}/${gameH};container-type:size;overflow:hidden;`;
    for (const layer of pluginTitle.layers) {
      const frame = layer.frame;
      const w = frame ? frame.w : layer.bitmapW, h = frame ? frame.h : layer.bitmapH;
      if (!w || !h) continue;
      const div = document.createElement('div');
      const url = assetUrl(`${titleRoot}/img/${layer.folder}/${encodeURIComponent(layer.name)}.png`);
      const crop = frame
        ? `background-size:${layer.bitmapW / w * 100}% ${layer.bitmapH / h * 100}%;background-position:${(frame.x / Math.max(1, layer.bitmapW - w)) * 100}% ${(frame.y / Math.max(1, layer.bitmapH - h)) * 100}%;`
        : 'background-size:100% 100%;';
      div.style.cssText = `position:absolute;left:${layer.x / gameW * 100}%;top:${layer.y / gameH * 100}%;width:${w / gameW * 100}%;aspect-ratio:${w}/${h};background-image:url("${url}");background-repeat:no-repeat;${crop}opacity:${layer.opacity / 255};image-rendering:pixelated;`;
      stage.append(div);
    }
    const entries = [
      { label: 'New Game', show: commands.newGame, run: () => finish('new') },
      { label: 'Continue', show: commands.continue, disabled: !savesExist, run: () => finish('continue') },
      { label: 'Options', show: commands.options, run: () => { options.hidden = !options.hidden; } }
    ].filter(entry => entry.show);
    // When the game's picture commands were captured, the buttons are
    // invisible hit areas exactly over them (creation order = command
    // order); otherwise the stock box carries the same entries.
    const rects = pluginTitle.commands.length >= entries.length ? pluginTitle.commands : null;
    const boxW = 240;
    const box = document.createElement('div');
    if (!rects) box.style.cssText = `position:absolute;left:${((gameW - boxW) / 2) / gameW * 100}%;width:${boxW / gameW * 100}%;bottom:${96 / gameH * 100}%;background:rgba(8,10,26,.55);border:2px solid rgba(240,240,255,.85);border-radius:1cqw;padding:1cqw;box-sizing:border-box;`;
    entries.forEach((entry, i) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = entry.label;
      const rect = rects?.[i];
      button.style.cssText = rect
        ? `position:absolute;left:${rect.x / gameW * 100}%;top:${rect.y / gameH * 100}%;width:${rect.w / gameW * 100}%;height:${rect.h / gameH * 100}%;background:transparent;border:0;color:transparent;font-size:0;cursor:${entry.disabled ? 'default' : 'pointer'};${entry.disabled ? 'opacity:.45;' : ''}`
        : `display:block;width:100%;padding:0.8cqh 0;margin:0;background:transparent;border:0;color:#fff;font:3.4cqw system-ui;text-align:center;cursor:${entry.disabled ? 'default' : 'pointer'};${entry.disabled ? 'opacity:.45;' : ''}`;
      if (entry.disabled) { button.setAttribute('aria-disabled', 'true'); button.tabIndex = -1; }
      else buttons.push(button);
      const sel = on => { button.style.background = on ? 'rgba(255,255,255,.22)' : 'transparent'; };
      if (rect) { button.setAttribute('aria-label', entry.label); button.style.outlineOffset = '-2px'; }
      button.addEventListener('focus', () => sel(true));
      button.addEventListener('blur', () => sel(false));
      button.addEventListener('mouseenter', () => { if (!entry.disabled) button.focus(); });
      button.addEventListener('mouseleave', () => sel(document.activeElement === button));
      button.addEventListener('click', () => {
        if (entry.disabled) { menuSound('buzzer'); console.warn('MWGP title: Continue unavailable (no saved games yet)'); return; }
        menuSound('ok'); entry.run();
      });
      (rect ? stage : box).append(button);
    });
    if (!rects) stage.append(box);
    menu.append(note); root.append(art, shade, stage, menu, options); document.body.append(root);
  } else if (stock) {
    // Stock engine layout (Scene_Title on MV and MZ alike): title1 behind
    // title2, both fullscreen; the game title drawn at y = H/4 while
    // optDrawTitle; the command window centered with its bottom 96px above
    // the screen edge (plus the project's command offsets).
    const stage = document.createElement('div');
    stage.className = 'mwgp-title-stage';
    stage.style.cssText = `position:relative;place-self:center;width:min(100%,calc((100vh - 170px)*${gameW}/${gameH}));aspect-ratio:${gameW}/${gameH};container-type:size;`;
    const layer = src => { const img = document.createElement('img'); img.alt = ''; img.src = assetUrl(src); img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'; img.onerror = () => img.remove(); stage.append(img); };
    if (title.title1) layer(titleRoot + '/img/titles1/' + encodeURIComponent(title.title1) + '.png');
    if (title.title2) layer(titleRoot + '/img/titles2/' + encodeURIComponent(title.title2) + '.png');
    if (title.drawTitle !== false) {
      const text = document.createElement('div');
      text.textContent = project.display?.title || project.source?.projectName || '';
      text.style.cssText = `position:absolute;left:${20 / gameW * 100}%;right:${20 / gameW * 100}%;top:25%;text-align:center;color:#fff;font:700 8.82cqw Georgia,serif;-webkit-text-stroke:0.98cqw #000;`;
      stage.append(text);
    }
    const offX = Number(title.commandOffset?.x) || 0, offY = Number(title.commandOffset?.y) || 0;
    const boxW = 240;
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${((gameW - boxW) / 2 + offX) / gameW * 100}%;width:${boxW / gameW * 100}%;bottom:${(96 - offY) / gameH * 100}%;background:rgba(8,10,26,.78);border:2px solid rgba(240,240,255,.85);border-radius:1cqw;padding:1cqw;box-sizing:border-box;`;
    const entries = [
      { label: 'New Game', show: commands.newGame, run: () => finish('new') },
      { label: 'Continue', show: commands.continue, disabled: !savesExist, run: () => finish('continue') },
      { label: 'Options', show: commands.options, run: () => { options.hidden = !options.hidden; } }
    ];
    for (const entry of entries) {
      if (!entry.show) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = entry.label;
      button.style.cssText = `display:block;width:100%;padding:0.8cqh 0;margin:0;background:transparent;border:0;color:#fff;font:3.4cqw system-ui;text-align:center;cursor:${entry.disabled ? 'default' : 'pointer'};${entry.disabled ? 'opacity:.45;' : ''}`;
      if (entry.disabled) { button.setAttribute('aria-disabled', 'true'); button.tabIndex = -1; }
      else buttons.push(button);
      const sel = on => { button.style.background = on ? 'rgba(255,255,255,.22)' : 'transparent'; };
      button.addEventListener('focus', () => sel(true));
      button.addEventListener('blur', () => sel(false));
      button.addEventListener('mouseenter', () => { if (!entry.disabled) button.focus(); });
      button.addEventListener('mouseleave', () => sel(document.activeElement === button));
      button.addEventListener('click', () => {
        if (entry.disabled) { menuSound('buzzer'); console.warn('MWGP title: Continue unavailable (no saved games yet)'); return; }
        menuSound('ok'); entry.run();
      });
      box.append(button);
    }
    stage.append(box);
    menu.append(note); root.append(art, shade, stage, menu, options); document.body.append(root);
  } else {
    if (commands.newGame) menu.append(makeButton('New Game', true, () => finish('new')));
    if (commands.continue && savesExist) menu.append(makeButton('Continue', false, () => finish('continue')));
    else if (commands.continue) {
      const dimmed = document.createElement('button');
      dimmed.type = 'button'; dimmed.textContent = 'Continue'; dimmed.style.opacity = '.45';
      dimmed.addEventListener('click', () => { menuSound('buzzer'); console.warn('MWGP title: Continue unavailable (no saved games yet)'); });
      menu.append(dimmed);
    }
    if (commands.options) menu.append(makeButton('Options', false, () => { options.hidden = !options.hidden; }));
    menu.append(note); root.append(art, shade, content, menu, options); document.body.append(root);
  }
  const onKey = event => { if (!root.isConnected) return; if (['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)) { if (!buttons.length) return; event.preventDefault(); const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1; const current = buttons.indexOf(document.activeElement); buttons[(current + delta + buttons.length) % buttons.length].focus(); menuSound('cursor'); } else if ((event.key === 'Enter' || event.key === ' ') && document.activeElement instanceof HTMLButtonElement) { event.preventDefault(); document.activeElement.click(); } else if (event.key === 'Escape') options.hidden = true; };
  window.addEventListener('keydown', onKey); (buttons[0] || root).focus(); await done; window.removeEventListener('keydown', onKey);
}
async function showCompatibilityWarning(project) {
  // Per-feature report (T128): areas with a concrete remaining gap, most-used
  // first, instead of raw command counts. A fully supported project stays silent.
  let lines = [];
  try {
    const { featureReport, featureLines } = await import('/compat-features.js');
    lines = featureLines(featureReport(project.compatibility));
  } catch (error) { console.warn('MWGP compatibility report unavailable', error); }
  // A manifest made before the converter stamp (0.2.0) carries older command mappings (322 as profile, 333/334 as enemy TP/state ...).
  const stamp = project.converter?.version;
  if (/^rpg-maker-m/.test(String(project.source?.engine || '')) && (!stamp || stamp.localeCompare('0.2.0', undefined, { numeric: true }) < 0)) {
    lines.unshift(`Converted by an older converter (${stamp || 'before 0.2.0'}): reconvert to fix known command mappings`);
  }
  if (!lines.length) return;
  const message = `This project still depends on RPG Maker behavior here — ${lines.join('; ')}. Those scenes may not play as in RPG Maker.`;
  console.warn(`MWGP compatibility: ${message}`);
  const banner = document.createElement('p');
  banner.setAttribute('role', 'note');
  banner.style.cssText = 'background:#3a2a12;border:1px solid #a97b2f;border-radius:6px;padding:8px 12px;color:#f2d9a4';
  banner.textContent = message;
  document.querySelector('#stage')?.before(banner);
}
