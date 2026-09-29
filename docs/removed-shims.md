# Removed game-specific shims

Archived on 2026-09-27 when the converters and player were made game-agnostic: nothing may name a particular game, a
framework (Pokémon Essentials) or a third-party plugin. Each entry says what the shim did, which game relied on it, and
what the generic path does instead. The code is verbatim from commit `27128af` plus the uncommitted working tree of that
day; `git log -S` on any identifier below finds the history.

Reinstating one of these is the wrong fix. The right one is a generic mechanism that makes the game's own code work (for
example: drawing RGSS windows, running the engine's scene loop, loading the MV window layer in the plugin sandbox).

## Pokémon Essentials helper fallbacks in the RGSS runtime

- **What it did:** `pbStartQuest`, `pbCompleteQuest`, `pbQuestComplete`, `pbItemBall`, `pbReceiveItem`, `pbCheckItem` and `pbAddPokemon` answered from player-held `rpgExtra.quests / namedItems / namedParty` when the game library lacked the name.
- **Relied on by:** Pokémon Void (event scripts calling those helpers).
- **Generic path now:** The game's own library supplies these names (they are ordinary reachable units); when it does not, the call hits the usual loud stub.

`src/player/rgss-script.js` lines 398-424:

```js
  const questId = id => String(id ?? '').replace(/^:/, '');
  const questRecord = id => {
    const key = questId(id);
    if (!key) return null;
    scene.rpgExtra.quests ||= {};
    return scene.rpgExtra.quests[key] ||= { active: false, completed: false, objectives: {} };
  };
  const startQuest = id => { const quest = questRecord(id); if (!quest) return false; quest.active = true; return true; };
  const completeQuest = id => { const quest = questRecord(id); if (!quest) return false; quest.active = true; quest.completed = true; return true; };
  const questComplete = id => scene.rpgExtra.quests?.[questId(id)]?.completed === true;
  const namedItemId = id => String(id ?? '').replace(/^:/, '');
  const namedItemCount = id => scene.rpgExtra.namedItems?.[namedItemId(id)] || 0;
  const giveNamedItem = (id, amount = 1) => {
    const key = namedItemId(id);
    if (!key) return false;
    scene.rpgExtra.namedItems ||= {};
    scene.rpgExtra.namedItems[key] = Math.max(0, namedItemCount(key) + Number(amount || 0));
    if (!scene.rpgExtra.namedItems[key]) delete scene.rpgExtra.namedItems[key];
    return true;
  };
  const addNamedPokemon = (species, level = 1) => {
    const key = namedItemId(species);
    if (!key) return false;
    scene.rpgExtra.namedParty ||= [];
    scene.rpgExtra.namedParty.push({ species: key, level: Number(level) || 1 });
    return true;
  };
```

`src/player/rgss-script.js` lines 828-842:

```js
  // Engine-framework helpers (Pokémon Essentials-style `pb*` names) used only
  // when the game's own library does not define the name: consulted after the
  // library and before the warning stub, so a game's real implementation wins.
  const fallbacks = {
    // Pokémon Essentials' quest helpers are small state operations in the
    // event corpus; keep them deterministic even when the full UI plugin is
    // unavailable. Unknown quest ids remain ordinary data, not false stubs.
    pbStartQuest: startQuest,
    pbCompleteQuest: completeQuest,
    pbQuestComplete: questComplete,
    pbItemBall: id => giveNamedItem(id, 1),
    pbReceiveItem: (id, amount = 1) => giveNamedItem(id, amount),
    pbCheckItem: id => namedItemCount(id) > 0,
    pbAddPokemon: addNamedPokemon
  };
```

## `$player` built-in stub

- **What it did:** An inert `$player` (character_ID 1, name "Player", trainer_type "PLAYER"), which also forced the boot pass to special-case `$player`.
- **Relied on by:** Pokémon Essentials games before their `SaveData.register(:player)` value existed.
- **Generic path now:** The game's own `SaveData.register` boot values create every global they register, `$player` included, like any other.

`src/player/rgss-script.js` lines 623-630:

```js
    // Essentials exposes the player as `$player`; keep the object
    // stateful even when the export has no full Essentials database. A stable
    // default character id gives gender/pronoun helpers a safe startup value.
    $player: openObject("player", {
      get character_ID() { return rgss().data["player.character_ID"] ?? 1; },
      get name() { return rgss().data["player.name"] ?? "Player"; },
      get trainer_type() { return rgss().data["player.trainer_type"] ?? "PLAYER"; }
    }),
```

`src/player/rgss-script.js` lines 1022-1023:

```js
        // Values the runtime already stands in for with its own objects (switches, variables, map, ...) keep those.
        if (target && `$${target}` !== '$player' && `$${target}` in builtins) continue;
```

## Essentials message helpers, `validate` and `RTP` overriding the game's own code

- **What it did:** Built-ins named `pbMessage`, `pbConfirmMessage`, `pbConfirmMessageSerious` (routed to the player dialogue box), `validate` (no-op) and `RTP` (path resolver) sat ahead of the game library in the lookup order, so the game's own definitions never ran.
- **Relied on by:** Pokémon Essentials games (Pokémon Void).
- **Generic path now:** The game's own definitions run. Messages then depend on the game's own (Sprite-built) windows being drawn by `rgss-screen.js`, and `validate`/`RTP` on the runtime's Ruby core and file index.

`src/player/rgss-script.js` lines 679-691:

```js
    // Essentials' message helpers, backed by the player's own dialogue box. The game's `pbMessage` drives inert window
    // shims and can never return a choice; these await the real box, which needs the async lift (a script that reaches
    // them is lifted like any that waits on frames). `cmdIfCancel`: >0 returns cmdIfCancel-1 on cancel, <0 returns it.
    pbMessage: async (message, commands = null, cmdIfCancel = 0, skin = null, defaultCmd = 0) => {
      const text = String(message ?? '');
      const list = Array.isArray(commands) ? commands.map(String) : null;
      const answer = await resumeAfter(scene.presentDialogue({ text, ...(list ? { choices: list.map((label, index) => ({ text: label, value: index })) } : {}) }));
      if (!list) return 0;
      if (answer === undefined || answer === null) return cmdIfCancel > 0 ? cmdIfCancel - 1 : cmdIfCancel < 0 ? cmdIfCancel : Number(defaultCmd) || 0;
      return Number(answer);
    },
    pbConfirmMessage: async message => (await builtins.pbMessage(message, ['Yes', 'No'], 2)) === 0,
    pbConfirmMessageSerious: async message => (await builtins.pbMessage(message, ['Yes', 'No'], 2, null, 1)) === 0,
```

`src/player/rgss-script.js` lines 694-696:

```js
    // Essentials' `validate({value => [Classes]})` is a debug-time type check that raises on a mismatch; the JS value
    // classes differ from Ruby's (Integer, Symbol, ...), so it would reject valid calls. It has no effect on game logic.
    validate: () => {},
```

`src/player/rgss-script.js` lines 752-773:

```js
    // Essentials' RTP resolver is filesystem-backed in RGSS.  The browser
    // converter already serves assets through MWGP URLs, so expose the same
    // callback shape without letting the transpiled `eachPath` block call
    // escape into an unbound `_implicitBlockYield`.
    RTP: {
      // The game's own paths resolve against the project file index (`fileIndex`): the callback gets the path as given, and the
      // game's own existence checks (`FileTest.exist`, `File.open`) answer from the index.
      eachPathFor: (filename, callback) => {
        if (!filename || typeof callback !== 'function') return;
        // Only a path that exists (as given, or with an image/audio extension) is yielded: no file, no callback.
        if (['', '.png', '.gif', '.jpg', '.jpeg', '.bmp', '.ogg', '.wav', '.mid', '.midi', '.mp3'].some(extension => fsExists(String(filename) + extension))) callback(String(filename));
        else warnOnce(`RTP file ${filename}`, 'is not among the project files (a resource lookup will come back empty)');
      },
      eachPath: callback => {
        if (typeof callback === 'function') callback('./');
      },
      // Nothing lives in a runtime package here (`RTP.exists?`): the game ships its own assets.
      exists: () => false,
      getPath: filename => filename,
      getImagePath: filename => filename,
      getAudioPath: filename => filename
    },
```

## Essentials pause menu entry point (`?gamemenu=1`)

- **What it did:** Escape ran `PokemonPauseMenu`/`PokemonPauseMenu_Scene` by name when the library shipped them.
- **Relied on by:** Pokémon Essentials games; experimental and failing by default.
- **Generic path now:** Escape opens the player's own menu. Running a game's own menu scene needs a generic scene entry point (the engine's menu call), not a framework class name.

`src/player/player-core.js` lines 1526-1545:

```js
    // The full menu (Item / Skill / Equip / Status / Save / Options / Game End, src/player/menu.js) when the project
    // has the MV/MZ database; the small Save/Close box below otherwise (XP conversions carry no database).
    // The game's own pause menu, when its library ships Essentials' standard one (`PokemonPauseMenu`): a script-driven scene,
    // run like any lifted Ruby screen. The key that opened it is flushed so the scene does not read it as "back".
    async openGamePauseMenu() {
      if (this.menuOpen) return undefined;
      this.menuOpen = true;
      let worked = false;
      try {
        this.rgss.flushInput?.();
        worked = await this.rgss.run({ source: 'PokemonPauseMenu', js: 'await new PokemonPauseMenu(new PokemonPauseMenu_Scene()).pbStartPokemonMenu()', async: true }, { game: this.gameState }, null);
      } finally { this.menuOpen = false; }
      // The game's menu needs Essentials' full save state (`$player.money`, the bag, ...) that this runtime does not
      // build yet: when it fails, the player's own simple menu still opens.
      if (!worked) return this.openSimpleMenu();
      return undefined;
    }
    async openMenu() {
      // Experimental (`?gamemenu=1`): it needs Essentials' save state, which is not built yet, so it fails loudly by default.
      if (new URLSearchParams(globalThis.location?.search || '').get('gamemenu') === '1' && project.rubyLibrary?.units?.PokemonPauseMenu && project.rubyLibrary?.units?.PokemonPauseMenu_Scene && this.rgss?.run) return this.openGamePauseMenu();
```

## XP Control Variables "Other" index 1 as Pokémon count

- **What it did:** XP 122 operand kind 7 index 1 converted to `gameData: pokemonCount`, read from `rpgExtra.namedParty`.
- **Relied on by:** Pokémon Essentials, whose `Interpreter#command_122` overrides that index.
- **Generic path now:** Stock RGSS meaning: index 1 is the party size (`$game_party.actors.size`), converted to `gameData: partySize`.

`tools/convert-rgss.js` lines 116-141:

```js
// XP game-data variable operands verified against command_122 in the shipped
// scripts. Kind 6 (character: player x/y) and kind 7 (map id, Pokémon count,
// money) read player-held state; directions, screen coordinates, terrain tags,
// steps, playtime, timer, and save counts have no model and stay loud markers.
function convertXpGameDataOperand(p, operation, context = {}) {
  const operationName = ['set', 'add', 'subtract', 'multiply', 'divide', 'modulo'][Number(operation || 0)];
  const first = Number(p[0]);
  const last = Number(p[1] ?? first);
  const range = build => Array.from({ length: last - first + 1 }, (_, offset) => build(String(first + offset)));
  const kind = Number(p[3] || 0);
  let gameData = null;
  if (kind === 6 && Number(p[4]) === -1 && Number(p[5]) === 0) gameData = { kind: 'playerX' };
  else if (kind === 6 && Number(p[4]) === -1 && Number(p[5]) === 1) gameData = { kind: 'playerY' };
  else if (kind === 7 && Number(p[4]) === 0) gameData = { kind: 'mapId' };
  // Index 1 is Essentials' Pokémon count override (verified against its
  // command_122); stock VX reads party members there, which has no MWGP
  // operand and stays loud below.
  else if (kind === 7 && Number(p[4]) === 1 && !isVxLike) gameData = { kind: 'pokemonCount' };
  else if (kind === 7 && Number(p[4]) === 2) gameData = { kind: 'gold' };
  if (!gameData || !operationName) {
    console.warn(`MWGP convert: ${ENGINE_LABEL} game-data operand ${kind}/${p[4]}/${p[5]} has no converted equivalent; it warns at runtime and reads as 0 (map ${context.mapId}, event ${context.eventId})`);
    recordFallback(unsupportedOperandFallbacks, `122:${kind}`, context.mapId, context.eventId);
    return range(() => ({ unsupported: { code: 122, kind } }));
  }
  return range(id => ({ modifyVariable: { target: id, operation: operationName, operand: { gameData } } }));
}
```

`src/player/player-core.js` lines 2596-2596:

```js
    case 'pokemonCount': return (extra?.namedParty || []).length;
```

`tools/validate-mwgp.js` lines 182-182:

```js
      if (operand?.gameData !== undefined) check(['itemCount', 'weaponCount', 'armorCount', 'playerX', 'playerY', 'partyMember', 'mapId', 'partySize', 'pokemonCount', 'gold'].includes(operand.gameData?.kind),
```

## Essentials title screen (IntroEventScene)

- **What it did:** The converter found `class IntroEventScene`, read its `SPLASH_IMAGES`, `TITLE_BG_IMAGE`, `TITLE_START_IMAGE`, timing constants and `Graphics/UI/Load` art, and the title page recreated the splash sequence, the flashing press-start strip and the Load panel menu (panel geometry hard-coded from `PokemonLoad_Scene`).
- **Relied on by:** Pokémon Essentials games (Pokémon Void).
- **Generic path now:** The stock title from `System.rxdata` (title name) and the generic title menu. Running a game's own title scene needs the RGSS main loop, which the runtime does not have yet.

`tools/convert-rgss.js` lines 898-948:

```js
// Essentials' title flow (IntroEventScene in UI_SplashesAndTitleScreen: timed
// splash images, a title background with a flashing press-start strip, then
// the Load-bg panel menu) is Ruby-driven, so none of the stock MV title
// fields describe it. Detect the scene by name - the same name-based
// framework-idiom detection convert-mv.js uses for MOG picture titles - read
// its image constants, and record the art the player recreates the flow from.
// A name without art (or art without the scene) keeps the generic title.
function buildEssentialsTitle() {
  const script = (rubyScripts || []).find(entry => /class\s+IntroEventScene\b/.test(entry.source || ''));
  if (!script) return null;
  const text = script.source;
  const splashList = (text.match(/SPLASH_IMAGES\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const named = key => (text.match(new RegExp(key + '\\s*=\\s*"([^"]+)"')) || [])[1] || null;
  const counted = (key, fallback) => {
    const found = text.match(new RegExp(key + '\\s*=\\s*(\\d+(?:\\.\\d+)?)'));
    return found ? Number(found[1]) : fallback;
  };
  const titleImage = name => join(source, 'Graphics', 'Titles', `${name}.png`);
  let title = named('TITLE_BG_IMAGE'), start = named('TITLE_START_IMAGE');
  const splash = [];
  for (const [, name] of splashList.matchAll(/"([^"]+)"/g)) {
    if (existsSync(titleImage(name))) splash.push(name);
    else console.warn(`MWGP convert: Essentials splash "${name}" has no Graphics/Titles/${name}.png; dropping it`);
  }
  if (title && !existsSync(titleImage(title))) {
    console.warn(`MWGP convert: Essentials title background "${title}" has no Graphics/Titles/${title}.png; dropping it`);
    title = null;
  }
  if (start && !existsSync(titleImage(start))) {
    console.warn(`MWGP convert: Essentials press-start image "${start}" has no Graphics/Titles/${start}.png; dropping it`);
    start = null;
  }
  if (!splash.length && !title) return null;
  const loadFile = name => join(source, 'Graphics', 'UI', 'Load', `${name}.png`);
  const loadBg = existsSync(loadFile('bg')) ? 'UI/Load/bg' : null;
  const loadPanels = existsSync(loadFile('panels')) ? 'UI/Load/panels' : null;
  if (!loadBg) console.warn('MWGP convert: Essentials load menu has no Graphics/UI/Load/bg.png; the panel menu renders on a plain background');
  if (!loadPanels) console.warn('MWGP convert: Essentials load menu has no Graphics/UI/Load/panels.png; the panel menu renders as plain buttons');
  return {
    kind: 'essentials',
    splash, title, start,
    startX: counted('TITLE_START_IMAGE_X', 0), startY: counted('TITLE_START_IMAGE_Y', 322),
    load: { bg: loadBg, panels: loadPanels },
    timing: {
      secondsPerSplash: counted('SECONDS_PER_SPLASH', 2),
      fadeTicks: counted('FADE_TICKS', 8),
      enterFlashTicks: counted('TICKS_PER_ENTER_FLASH', 40)
    },
    assets: { root: 'assets', kind: 'decoded' }
  };
}
```

`tools/convert-rgss.js` lines 1074-1075:

```js
const essentialsTitle = buildEssentialsTitle();
if (essentialsTitle) console.log(`MWGP convert: Essentials title: ${essentialsTitle.splash.length} splash image(s)${essentialsTitle.title ? `, "${essentialsTitle.title}" press-start screen` : ''}${essentialsTitle.load.bg ? ', Load panel menu' : ''}`);
```

`public/player.js` lines 141-258:

```js
  // Essentials' Ruby-driven title (IntroEventScene): timed splash images, a
  // title background with a flashing press-start strip, then the Load-bg panel
  // menu - recreated here from the manifest's titleScreen (kind essentials),
  // since the stock/MOG branches above have no shape for it. Art comes from
  // the converted Graphics tree; without it the generic menu below runs.
  const ess = title.kind === 'essentials' && title.assets?.kind === 'decoded'
    && ((title.splash || []).length > 0 || title.title) ? title : null;
  if (ess) {
    const gfx = file => titleRoot + '/graphics/' + file + '.png';
    const stage = document.createElement('div');
    stage.className = 'mwgp-title-stage';
    stage.style.cssText = `position:relative;place-self:center;width:min(100%,calc((100vh - 170px)*${gameW}/${gameH}));aspect-ratio:${gameW}/${gameH};background:#000;overflow:hidden;container-type:size;`;
    const layer = src => { const img = document.createElement('img'); img.alt = ''; img.src = src; img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'; img.onerror = () => img.remove(); stage.append(img); return img; };
    menu.append(note); root.append(stage, menu, options); document.body.append(root);
    // Splash and press-start advance on Enter/Space/click, or on the game's
    // own splash timer - the press-start screen itself waits, like the engine
    // waiting for C, until the load menu below takes over the shared keys.
    const fadeMs = Math.max(0, (Number(ess.timing?.fadeTicks) || 8) / 20 * 1000);
    const splashMs = Math.max(500, (Number(ess.timing?.secondsPerSplash) || 2) * 1000);
    let phase = null;
    const onAdvance = event => {
      if (event?.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      if (phase) { event?.preventDefault?.(); const next = phase; phase = null; next(); }
    };
    window.addEventListener('keydown', onAdvance);
    stage.addEventListener('click', onAdvance);
    const waitPhase = ms => new Promise(resolve => { phase = resolve; setTimeout(() => { if (phase === resolve) { phase = null; resolve(); } }, ms); });
    try {
      for (const shot of ess.splash || []) {
        const img = layer(gfx('Titles/' + shot));
        img.style.transition = `opacity ${fadeMs}ms linear`;
        img.style.opacity = '0';
        requestAnimationFrame(() => { img.style.opacity = '1'; });
        await waitPhase(fadeMs + splashMs);
        img.style.opacity = '0';
        await new Promise(resolve => setTimeout(resolve, fadeMs));
        img.remove();
      }
      if (ess.title) {
        layer(gfx('Titles/' + ess.title));
        let press = null;
        if (ess.start) {
          press = document.createElement('img'); press.alt = '';
          press.src = gfx('Titles/' + ess.start);
          press.style.cssText = `position:absolute;left:${(Number(ess.startX) || 0) / gameW * 100}%;top:${(Number(ess.startY) || 0) / gameH * 100}%;width:100%;`;
          press.onerror = () => press.remove();
          stage.append(press);
        }
        // The engine pulses the strip's opacity; a visibility blink is the
        // cheap DOM equivalent at the same TICKS_PER_ENTER_FLASH cycle.
        const flashMs = Math.max(400, (Number(ess.timing?.enterFlashTicks) || 40) / 20 * 1000);
        const blink = press ? setInterval(() => { press.style.visibility = press.style.visibility === 'hidden' ? '' : 'hidden'; }, flashMs / 2) : null;
        await waitPhase(3600000);
        if (blink) clearInterval(blink);
      }
    } finally {
      window.removeEventListener('keydown', onAdvance);
      stage.removeEventListener('click', onAdvance);
    }
    stage.replaceChildren();
    // The Load panel menu (PokemonLoad_Scene): the Load/bg background with one
    // panels.png slice per command, positioned like the engine (x 48, rows of
    // 46 from y 32; the Continue panel is 222 tall). Slices are selected by
    // translating the sheet in an overflow-hidden frame, the same trick the
    // picture-command branch above uses for two-state images.
    if (ess.load?.bg) layer(gfx(ess.load.bg));
    else stage.style.background = '#f8f8f8';
    const panels = ess.load?.panels ? gfx(ess.load.panels) : null;
    const entries = [
      ...(savesExist && commands.continue ? [{ label: 'Continue', tall: true, run: () => finish('continue') }] : []),
      ...(commands.newGame ? [{ label: 'New Game', run: () => finish('new') }] : []),
      ...(commands.options ? [{ label: 'Options', run: () => { options.hidden = !options.hidden; } }] : []),
      { label: 'Quit Game', quit: true }
    ];
    let rowY = 32;
    for (const entry of entries) {
      const h = entry.tall ? 222 : 46;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', entry.label);
      button.style.cssText = `position:absolute;left:${48 / gameW * 100}%;top:${rowY / gameH * 100}%;width:${408 / gameW * 100}%;aspect-ratio:408/${h};padding:0;border:0;background:transparent;cursor:pointer;`;
      rowY += entry.tall ? 224 : 48;
      const frame = document.createElement('span');
      frame.style.cssText = 'position:absolute;inset:0;display:block;overflow:hidden;';
      if (panels) {
        // Non-continue rows use the y=444 strip (y=490 while selected), the
        // tall Continue panel y=0 (y=222 while selected); the sheet is 536 tall.
        const stripY = entry.tall ? 0 : 444;
        const img = document.createElement('img');
        img.alt = ''; img.src = panels;
        img.style.cssText = 'display:block;width:100%;';
        const paint = selected => { img.style.transform = `translateY(${-(stripY + (selected ? h : 0)) / 536 * 100}%)`; };
        img.onload = () => paint(document.activeElement === button);
        img.onerror = () => { img.remove(); button.style.background = 'rgba(8,10,26,.78)'; button.style.border = '2px solid rgba(240,240,255,.85)'; };
        // Selection shows through the strip swap alone (the engine has no
        // focus ring); only focus the button so arrows/Enter keep working.
        button.addEventListener('focus', () => paint(true));
        button.addEventListener('blur', () => paint(false));
        button.addEventListener('mouseenter', () => button.focus());
        frame.append(img);
      } else {
        button.style.background = 'rgba(8,10,26,.78)';
        button.style.border = '2px solid rgba(240,240,255,.85)';
      }
      const text = document.createElement('span');
      text.textContent = entry.label;
      text.style.cssText = `position:absolute;left:${32 / 408 * 100}%;top:${(entry.tall ? 16 : 14) / h * 100}%;color:#e8e8e8;font:600 3.9cqw system-ui;text-shadow:0.21cqw 0.21cqw 0 #888;`;
      button.addEventListener('click', () => {
        // Quit Game has no browser equivalent: keep it visible for fidelity
        // (it is the engine's third row) but warn loudly instead of acting,
        // like the plugin-added entries of the picture-command branch.
        if (entry.quit) { menuSound('buzzer'); console.warn('MWGP title: Quit Game has no browser equivalent; staying on the title'); return; }
        menuSound('ok'); entry.run();
      });
      buttons.push(button);
      button.append(frame, text);
      stage.append(button);
    }
```

## Essentials player charset, screen size and default title

- **What it did:** XP read the player sprite from Essentials' `Data/player_metadata.dat` (with a `POKEMONTRAINER_x` -> `trainer_x` fallback), shipped `playerMetadata` in the manifest, fixed the screen at 512x384 and named untitled XP games "Pokémon Essentials".
- **Relied on by:** Pokémon Essentials games.
- **Generic path now:** XP reads the start party's first actor charset from `Actors.rxdata`, like VX/Ace; the screen is the engine default unless the scripts call `Graphics.resize_screen` with literal numbers; an untitled game is "Untitled XP game".

`tools/convert-rgss.js` lines 973-977:

```js
// player_metadata.dat is Essentials-only; VX reads the start actor's charset
// from its own Actors table instead (see resolveVxPlayerSprite below).
const playerMetadataPath = join(dataDir, 'player_metadata.dat');
const playerMetadata = !isVxLike && existsSync(playerMetadataPath) ? decodeMarshal(await readFile(playerMetadataPath)) : new Map();
const firstPlayer = [...playerMetadata.values()].sort((a, b) => Number(field(a, 'id', 0)) - Number(field(b, 'id', 0)))[0] || null;
```

`tools/convert-rgss.js` lines 999-1012:

```js
const playerMetadataValues = [...playerMetadata.values()].sort((a, b) => Number(field(a, 'id', 0)) - Number(field(b, 'id', 0)));
function resolvePlayerSprite(metadata) {
  if (!metadata) return null;
  const walk = String(field(metadata, 'walk_charset', '') || '');
  if (characterFiles.has(walk)) return { name: walk, index: 0, source: 'player_metadata' };
  // Essentials stores the default player charset in generated data for some
  // projects. If that generated sheet is absent from the archive, derive the
  // trainer charset from the metadata trainer type and use the matching
  // original asset when present (e.g. POKEMONTRAINER_RONAN -> trainer_RONAN).
  const trainerType = String(field(metadata, 'trainer_type', '') || '');
  const suffix = trainerType.replace(/^POKEMONTRAINER_/i, '');
  const candidate = [...characterFiles.keys()].find(name => name.toLowerCase() === `trainer_${suffix}`.toLowerCase());
  return candidate ? { name: candidate, index: 0, source: 'player_metadata_trainer_fallback' } : { name: walk, index: 0, source: 'player_metadata_missing_asset' };
}
```

`tools/convert-rgss.js` lines 1079-1079:

```js
  display: { title: field(system, 'game_title', isAce ? 'Untitled Ace game' : isVx ? 'Untitled VX game' : 'Pokémon Essentials'), width: 512, height: 384, tileSize: VX_TILE_SIZE },
```

`tools/convert-rgss.js` lines 1084-1086:

```js
  tilesets, playerSprite, characterFrames, playerMetadata: playerMetadataValues.map(value => ({
    id: Number(field(value, 'id', 0)), trainerType: field(value, 'trainer_type', ''), walkCharset: field(value, 'walk_charset', ''), runCharset: field(value, 'run_charset', ''), cycleCharset: field(value, 'cycle_charset', ''), surfCharset: field(value, 'surf_charset', '')
  })), plugins: [], compatibility: { source: isAce ? ENGINE_ACE : isVx ? ENGINE_VX : 'rpg-maker-xp', commands: buildCompatibilityReport(commandCounts), scripts: { total: scriptStats.total, transpiled: scriptStats.transpiled, failed: [...scriptStats.failed].map(([ruby, error]) => ({ ruby: ruby.slice(0, 200), error })), libraryFailed: libraryFailures, libraryPartial: libraryPartials } }, maps, database: xpDatabase || {},
```

## MOG_TitlePictureCom / YEP_CoreEngine title (MV)

- **What it did:** The converter read `MOG_TitlePictureCom` button positions and `YEP_CoreEngine` screen size by plugin name, inventoried `img/titles2/Command_N` art, and the title page drew a picture-command menu on a stage of that size.
- **Relied on by:** Karryn's Prison (1440x810 picture-command title).
- **Generic path now:** The stock MV/MZ title (title1/title2, command window) at the System.json screen size.

`tools/convert-mv.js` lines 1049-1069:

```js
// MOG_TitlePictureCom-style picture-command titles place their Command_1..10
// buttons at positions from that (public third-party) plugin's parameters,
// read here as plain data like the names above — nothing game-specific.
let mogTitlePositions = [];
let mogTitleStage = null;
try {
  const pluginList = JSON.parse(pluginsText.slice(pluginsText.indexOf('['), pluginsText.lastIndexOf(']') + 1));
  const mog = Array.isArray(pluginList) ? pluginList.find(item => item?.name === 'MOG_TitlePictureCom' && item.status !== false) : null;
  const params = mog?.parameters || {};
  for (let i = 1; i <= 10; i++) {
    const pair = String(params[`Command Pos ${i}`] || '').split(',').map(Number);
    mogTitlePositions.push(pair.length === 2 && pair.every(Number.isFinite) ? pair : null);
  }
  // YEP_CoreEngine can resize the whole game (Karryn's Prison renders its
  // 1440x810 title art at that size, not System.json's 816x624). The title
  // stage needs the real geometry or the configured button positions land
  // outside the art.
  const yep = Array.isArray(pluginList) ? pluginList.find(item => item?.name === 'YEP_CoreEngine' && item.status !== false) : null;
  const screenW = Number(yep?.parameters?.['Screen Width']), screenH = Number(yep?.parameters?.['Screen Height']);
  if (Number.isFinite(screenW) && Number.isFinite(screenH) && screenW > 0 && screenH > 0) mogTitleStage = { w: screenW, h: screenH };
} catch { mogTitlePositions = []; }
```

`tools/convert-mv.js` lines 1156-1181:

```js
// Picture-command title inventory: when the project ships MOG-style
// Command_0..N images in img/titles2 (stock title1/title2 names stay empty in
// that setup), record what was actually decoded so the title screen can render
// the game's own image menu instead of text buttons. Only decoded files are
// recorded, so the manifest never points at art the player cannot fetch; the
// locale-suffixed variants (Command_0_RU, ...) are the game's own localized
// buttons and stay out — the player shows the default-language set.
{
  const titles2Dir = join(output, 'assets', 'img', 'titles2');
  if (titleAssetsAvailable && existsSync(titles2Dir)) {
    const files = (await readdir(titles2Dir)).sort();
    const isImage = name => /\.(png|jpe?g|webp)$/i.test(name);
    const base = name => name.replace(/\.[^.]+$/, '');
    const commands = [];
    for (let i = 0; ; i++) {
      const file = files.find(name => base(name) === `Command_${i}` && isImage(name));
      if (!file) break;
      commands.push({ image: file, position: mogTitlePositions[i] || null });
    }
    if (commands.length) {
      const background = files.find(name => /^Background\.png$/i.test(name)) || files.find(name => /^Background.+\.png$/i.test(name)) || null;
      const logo = files.find(name => /^Logo.+\.(png|jpe?g|webp)$/i.test(name)) || files.find(name => /^Title.+\.(png|jpe?g|webp)$/i.test(name)) || null;
      manifest.titleScreen.pictureCommands = { background, logo, stage: mogTitleStage, commands };
    }
  }
}
```

`public/player.js` lines 91-102:

```js
  // Picture-command titles (MOG_TitlePictureCom setups: stock title1/title2
  // names empty, the menu is Command_0..N images over a fullscreen
  // Background/Logo composite). Index 0/1/2 keep their stock meaning (new
  // game, continue, options); further entries are plugin-added (external
  // links, exit, ...) with no player equivalent, so they render for fidelity
  // but warn loudly instead of acting.
  const pic = titleAssets && title.pictureCommands?.commands?.length ? title.pictureCommands : null;
  const picUrl = file => titleRoot + '/img/titles2/' + encodeURIComponent(file);
  const gameW = Number(project.display?.width) || 816, gameH = Number(project.display?.height) || 624;
  // A resized game (YEP_CoreEngine screen size) draws its title in those
  // pixels; the button positions only line up on a stage of that geometry.
  const stageW = Number(pic?.stage?.w) || gameW, stageH = Number(pic?.stage?.h) || gameH;
```

`public/player.js` lines 259-312:

```js
  } else if (pic) {
    // Game-aspect stage: background, logo and Command_N buttons layer exactly
    // like the plugin draws them (fullscreen images at 0,0, buttons at their
    // configured positions), letterboxed by the locked aspect ratio.
    const stage = document.createElement('div');
    stage.className = 'mwgp-title-stage';
    stage.style.cssText = `position:relative;place-self:center;width:min(100%,calc((100vh - 170px)*${stageW}/${stageH}));aspect-ratio:${stageW}/${stageH};display:flex;flex-direction:column;align-items:center;justify-content:flex-end;`;
    const layer = src => { const img = document.createElement('img'); img.alt = ''; img.src = src; img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'; img.onerror = () => img.remove(); stage.append(img); };
    if (pic.background) layer(picUrl(pic.background));
    if (pic.logo) layer(picUrl(pic.logo));
    const stock = [
      { label: 'New Game', ok: commands.newGame, run: () => finish('new') },
      { label: 'Continue', ok: commands.continue, run: () => finish('continue') },
      { label: 'Options', ok: commands.options, run: () => { options.hidden = !options.hidden; } }
    ];
    pic.commands.forEach((entry, index) => {
      const known = stock[index];
      if (known && !known.ok) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', known ? known.label : `Title option ${index + 1} (not available in MWGP)`);
      if (known) button.title = known.label;
      const [px, py] = entry.position || [];
      const positioned = Number.isFinite(px) && Number.isFinite(py);
      button.style.cssText = positioned
        ? `position:absolute;left:${px / stageW * 100}%;top:${py / stageH * 100}%;padding:0;border:0;background:transparent;cursor:pointer;`
        : 'position:static;padding:0;border:0;background:transparent;cursor:pointer;margin:4px;';
      const frame = document.createElement('span');
      frame.style.cssText = 'display:block;overflow:hidden;width:100%;';
      const img = document.createElement('img');
      img.alt = ''; img.src = picUrl(entry.image);
      img.style.cssText = 'display:block;width:100%;';
      // MOG picture commands are two-state images: the top half shows while
      // selected, the bottom half otherwise (refresh_picture_command).
      const paint = () => { img.style.transform = document.activeElement === button ? 'translateY(0)' : 'translateY(-50%)'; };
      img.onload = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          frame.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight / 2}`;
          if (positioned) button.style.width = `${img.naturalWidth / stageW * 100}%`;
          else button.style.width = `${img.naturalWidth}px`;
        }
        paint();
      };
      img.onerror = () => button.remove();
      button.addEventListener('focus', () => { button.style.outline = '2px solid #d2a35b'; button.style.outlineOffset = '3px'; paint(); });
      button.addEventListener('blur', () => { button.style.outline = ''; paint(); });
      button.addEventListener('mouseenter', () => button.focus());
      button.addEventListener('click', () => {
        if (known) { menuSound('ok'); known.run(); }
        else { menuSound('buzzer'); console.warn(`MWGP title: ${entry.image} has no player action (plugin-added title entry); skipping`); }
      });
      frame.append(img); button.append(frame); stage.append(button); buttons.push(button);
    });
    menu.append(note); root.append(art, shade, stage, menu, options); document.body.append(root);
```

## Named MV plugin-command adapters

- **What it did:** State-only adapters for `Quest`, `Tachie`, `DisableAutosave/EnableAutosave/Autosave`, `MapScrollDisable`, `HideMiniLabel/ShowMiniLabel/RefreshMiniLabel`, `SFC_REM_*`, `MWL_*`/`MessageRows`, `ChoiceRect` (MPP_ChoiceEX), `AnimeLight`, `FD_START_SITE`, `STS` (FTKR skill tree) and `TE_CALL_MAP_EVENT`, plus the player features they fed (message rows, choice rectangle, suppressed map scroll), and a compatibility report that rated those names supported/partial.
- **Relied on by:** Karryn's Prison and the other local MV projects.
- **Generic path now:** Every plugin command goes to the game's own `Game_Interpreter#pluginCommand` chain in the plugin sandbox, and warns loudly when nothing handles it. The report rates a plugin command by whether the plugin that declares it ships in the plugin library.

`src/player/player-core.js` lines 28-45:

```js
  // MPP_ChoiceEX stores this rectangle on the message, then applies it when
  // the choice list is created. MWG creates that list lazily, so mirror the
  // same timing while keeping -1 as "use the normal layout".
  if (options.choiceRect) {
    const showChoices = box.showChoices.bind(box);
    box.showChoices = () => {
      showChoices();
      const rect = options.choiceRect;
      if (!box.choiceList || !rect) return;
      const width = Number(rect.width);
      const height = Number(rect.height);
      if (width > 0 || height > 0) {
        box.choiceList.resize(width > 0 ? width : box.choiceList.viewWidth, height > 0 ? height : box.choiceList.viewHeight);
      }
      if (Number(rect.x) >= 0) box.choiceList.x = Number(rect.x);
      if (Number(rect.y) >= 0) box.choiceList.y = Number(rect.y);
    };
  }
```

`src/player/player-core.js` lines 873-883:

```js
    messageBoxHeight(kind = 'normal') {
      const rows = Math.max(1, Math.min(15, Number(this.rpgExtra?.plugin?.messageRows) || 3));
      const rowHeight = 42;
      const base = kind === 'portrait' ? 150 : kind === 'scroll' ? 180 : 0;
      return Math.min(Math.max(84, base, rows * rowHeight), Math.max(96, game.height - 24));
    }
    choiceRect() {
      const rect = this.rpgExtra?.plugin?.choiceRect;
      if (!rect) return undefined;
      return { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) };
    }
```

`src/player/player-core.js` lines 1603-1611:

```js
    scrollMap(command) {
      if (this.rpgExtra?.plugin?.mapScrollDisabled) {
        // MapScrollDisable is a presentation plugin command: keep the event
        // flow synchronous while suppressing the camera movement itself.
        this.cameraPan = { x: 0, y: 0 };
        this.panTween = null;
        this.updateCamera();
        return Promise.resolve();
      }
```

`src/player/player-core.js` lines 1800-1817:

```js
    pluginCommand(command, state) {
      const name = String(command?.name || '').toLowerCase();
      const args = (command?.args || []).map(value => String(value).trim()).filter(Boolean);
      if (name === 'te_call_map_event') {
        const target = args[0] || String(this.currentEvent?.id || '');
        const pageIndex = Math.max(1, Number(args[1]) || 1);
        const events = mapEntry?.mwgEvents || [];
        const rawEvents = (mapEntry?.data?.events || []).filter(Boolean);
        const event = events.find(candidate => String(candidate.id) === target || String(candidate.name || '') === target)
          || events.find(candidate => rawEvents.find(raw => String(raw.id) === String(candidate.id) && String(raw.name || '') === target));
        if (!event) {
          this.unsupportedCommand('pluginCommand', command?.raw || command);
          return;
        }
        return this.runNestedPage(event.pages?.[pageIndex - 1] || event.pages?.[0], event);
      }
      if (applyBuiltinPluginCommand(this.rpgExtra, command)) return;
      if (applyQuestPluginCommand(this.rpgExtra.quests, command)) return;
```

`src/player/player-core.js` lines 2269-2389:

```js
function freshExtraState() {
  return {
    gold: 0, items: {}, weapons: {}, armors: {}, party: [], actors: {}, quests: {},
    namedItems: {}, namedParty: [], playerName: '',
    plugin: { autosave: true, mapScrollDisabled: false, miniLabel: true, messageRows: 3, tachie: {} }
  };
}

// State-only adapters for common presentation/quality-of-life plugin families.
// Unknown families still warn loudly; these adapters preserve command state
// across saves/transfers without pretending to reproduce plugin rendering.
export function applyBuiltinPluginCommand(extra, command) {
  const name = String(command?.name || '').toLowerCase();
  const args = (command?.args || []).map(value => String(value).trim()).filter(Boolean);
  const plugin = extra.plugin ||= { autosave: true, mapScrollDisabled: false, miniLabel: true, messageRows: 3, tachie: {} };
  if (name === 'disableautosave' || name === 'enableautosave' || name === 'autosave') {
    plugin.autosave = name !== 'disableautosave';
    return true;
  }
  if (name === 'mapscrolldisable') {
    plugin.mapScrollDisabled = args[0] !== '0';
    return true;
  }
  if (name === 'hideminilabel' || name === 'showminilabel') {
    plugin.miniLabel = name === 'showminilabel';
    return true;
  }
  if (name === 'sfc_rem_enable' || name === 'sfc_rem_disable') {
    plugin.remEnabled = name === 'sfc_rem_enable';
    return true;
  }
  if (name === 'mwl_reset_lines') {
    plugin.messageRows = 3;
    return true;
  }
  if (name === 'mwl_change_lines' || name === 'messagerows') {
    const rows = Number(args[0]);
    if (Number.isFinite(rows) && rows > 0) plugin.messageRows = Math.max(1, Math.min(15, Math.trunc(rows)));
    return true;
  }
  if (name === 'choicerect') {
    plugin.choiceRect = [0, 1, 2, 3].map(index => Number(args[index] ?? -1));
    return true;
  }
  if (name === 'animelight') {
    plugin[name] = args;
    return true;
  }
  // FD_START_SITE-style plugins open an external page in the native game. The
  // portable player must not navigate away from the running game, so retain
  // the request as data and treat it as a safe, visible no-op. RefreshMiniLabel
  // likewise only asks the native plugin to repaint UI that this renderer does
  // not own; restoring the enabled state is the faithful portable behavior.
  if (name === 'fd_start_site') {
    plugin.lastExternalSite = args.join(' ');
    return true;
  }
  if (name === 'refreshminilabel') {
    plugin.miniLabel = true;
    return true;
  }
  // FTKR Skill Tree System's event command normally opens a separate scene.
  // Preserve the request and its arguments so later conversion layers can
  // provide a real scene, while keeping the event flow non-blocking today.
  if (name === 'sts') {
    plugin.skillTree ||= { requests: [] };
    plugin.skillTree.requests.push(args);
    plugin.skillTree.lastAction = args[0] || '';
    return true;
  }
  if (name === 'tachie') {
    const action = (args.shift() || '').toLowerCase();
    const tachie = plugin.tachie;
    if (action === 'hideleft' || action === 'hideright' || action === 'hidename') {
      tachie[action.slice(4)] = { visible: false };
      return true;
    }
    if (action === 'showleft' || action === 'showright' || action === 'showname') {
      tachie[action.slice(4)] = { visible: true, args };
      return true;
    }
    if (['body', 'face', 'hat', 'hoppe', 'sweat'].includes(action) && args.length >= 2) {
      const actor = args.shift();
      tachie[`${actor}:${action}`] = args;
      return true;
    }
  }
  return false;
}

// Small, data-only compatibility adapter for the Quest plugin command family
// found in the MV corpus. Unknown plugin commands remain explicit warnings.
export function applyQuestPluginCommand(quests, command) {
  if (String(command?.name || '').toLowerCase() !== 'quest') return false;
  const args = (command?.args || []).map(value => String(value).trim()).filter(Boolean);
  const first = args[0]?.toLowerCase();
  const action = first === 'add' || first === 'set' ? first : args[1]?.toLowerCase();
  const id = first === 'add' ? args[1] : first === 'set' ? args[2] : args[0];
  if (!id) return false;
  const quest = quests[id] ||= { active: false, completed: false, objectives: {} };
  if (action === 'add') {
    quest.active = true;
    return true;
  }
  if (action === 'set' && args[1]?.toLowerCase() === 'completed') {
    quest.active = true;
    quest.completed = true;
    return true;
  }
  if (action === 'show' || action === 'complete') {
    const objectiveWord = first === action ? args[1] : args[2];
    const objectiveId = first === action ? args[2] : args[3];
    if (objectiveWord?.toLowerCase() !== 'objective' || !objectiveId) return false;
    quest.active = true;
    const objective = quest.objectives[objectiveId] ||= { visible: false, completed: false };
    objective.visible = true;
    if (action === 'complete') objective.completed = true;
    return true;
  }
  return false;
}
```

`tools/convert-mv.js` lines 1323-1335:

```js
function buildPluginCompatibilityReport(counts) {
  const supported = new Set(['quest', 'te_call_map_event', '指定位置にアニメーション表示']);
  const partial = new Set([
    'tachie', 'disableautosave', 'enableautosave', 'autosave', 'mapscrolldisable',
    'hideminilabel', 'showminilabel', 'sfc_rem_enable', 'sfc_rem_disable',
    'mwl_reset_lines', 'mwl_change_lines', 'messagerows', 'choicerect', 'animelight'
    , 'fd_start_site', 'refreshminilabel', 'sts'
  ]);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, {
    count,
    status: supported.has(name.toLowerCase()) ? 'supported' : partial.has(name.toLowerCase()) ? 'partial' : 'unsupported'
  }]));
}
```

## Karryn text-code hook (`TextManager.convertExtraEscapeCharacters`)

- **What it did:** Message text went through a plugin-defined `TextManager.convertExtraEscapeCharacters` when present.
- **Relied on by:** Karryn's Prison (`\REM_xxx[n]` codes).
- **Generic path now:** The stock MV escape pass; unknown codes are consumed as the engine does.

`src/player/player-core.js` lines 837-863:

```js
    // A game whose plugins override the message-code layer (Karryn's
    // `TextManager.convertExtraEscapeCharacters`, resolving dynamic \REM_xxx[n]
    // codes from live party state) runs first, exactly like the engine: stock
    // conversion, then the game's extra pass. The engine form uses ESC (\x1b)
    // for escapes, mapped back to `\` for the generic MV pass above; a literal
    // backslash comes back doubled, like the source. Games without that layer
    // keep the generic pass: the probe is quiet (typeof cannot throw) and the
    // hook disables itself after one loud warning on failure, never silently.
    convertGameText(text) {
      if (this.gameTextConverter === false || !this.rgss) return text;
      const state = { game: this.gameState };
      if (this.gameTextConverter === undefined) {
        const probe = this.rgss.evaluateValue({ source: 'typeof TextManager.convertExtraEscapeCharacters', mv: true, js: "return (typeof TextManager !== 'undefined' && TextManager.convertExtraEscapeCharacters && TextManager.convertEscapeCharacters) ? 1 : 0;" }, state, this.currentEvent);
        this.gameTextConverter = probe === 1;
        if (!this.gameTextConverter) return text;
      }
      try {
        const literal = JSON.stringify(text);
        const out = this.rgss.evaluateValue({ source: `TextManager.convertExtraEscapeCharacters(TextManager.convertEscapeCharacters(${literal}))`, mv: true, js: `return TextManager.convertExtraEscapeCharacters(TextManager.convertEscapeCharacters(${literal}));` }, state, this.currentEvent);
        if (typeof out !== 'string') throw new Error(`game text converter returned ${typeof out}`);
        return out.replace(/\x1b\x1b/g, '\\\\').replace(/\x1b/g, '\\');
      } catch (error) {
        console.warn(`MWGP game text codes unavailable (${String(error?.message || error).slice(0, 120)}); using built-in escapes`);
        this.gameTextConverter = false;
        return text;
      }
    }
```

## XP inventory and party commands dropped as Essentials dummies

- **What it did:** XP commands 126-129 (Change Items / Weapons / Armor / Party Member) converted to nothing, because Pokémon Essentials redefines them as `command_dummy`.
- **Relied on by:** Pokémon Essentials games; every other XP game silently lost its inventory and party changes.
- **Generic path now:** Stock XP semantics, shared with VX/Ace (same parameter layout): `changeItem`, `changeWeapon`, `changeArmor`, `changeParty`.

`tools/convert-rgss.js` (before the change):

```js
  // 126/127/128/129 (items/weapons/armor/party) are command_dummy no-ops in
  // the shipped engine itself — Pokémon tracks those elsewhere — so doing
  // nothing is the faithful conversion.
  // 116/126-129/208/210 are XP shapes (erase, Essentials dummy inventory,
  // transparency, wait-for-move); VX renumbered erase to 214 and maps
  // inventory for real above, so the XP cases stay gated.
  if (command.code === 116 && !isVxLike) return [{ eraseEvent: true }];
  if (!isVxLike && (command.code === 126 || command.code === 127 || command.code === 128 || command.code === 129)) return [];
```

## Essentials message helpers forced async by name

- **What it did:** The async lift treated `pbMessage`, `pbConfirmMessage` and `pbConfirmMessageSerious` as blocking by name, to await the runtime's dialogue-backed built-ins (removed above).
- **Relied on by:** Pokémon Essentials games.
- **Generic path now:** Only `Graphics.update` / `Graphics.wait` seed the lift; a game's own message function is lifted because it loops on them.

`tools/rgss-async.mjs` (before the change):

```js
// Helpers the runtime provides as async builtins (dialogue-backed), so anything calling them is lifted whether or not the
// game's own definition looks blocking.
export const ASYNC_BUILTINS = ['pbMessage', 'pbConfirmMessage', 'pbConfirmMessageSerious'];
// ...
  const all = new Set(ASYNC_BUILTINS), strong = new Set(ASYNC_BUILTINS);
```

