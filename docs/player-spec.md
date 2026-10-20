# MWGP player specification

How an MWGP manifest plays in the browser. Implementation:
`public/player.js` (entry + title), `src/player/player-core.js` (scene),
`battle.js`, `menu.js`, `audio-manager.js`, `rgss-script.js`,
`rgss-classes.js`, `rgss-screen.js`, `fallback-core.js`, `compat-features.js`,
on `@datamoc/mwg` primitives (`Game Scene2D TileMap SpriteSheet
WindowStack MessageBox Rpg.GameState Rpg.EventRunner Rpg.GridMover
Rpg.activePage SaveSystem Input Audio Resources`). Served by `src/server.js`
with no build step — editing player files takes effect on refresh.

MV/MZ games are normally not played by this player any more: their web build
runs the game's own engine through the nw.js host layer (section 10). The MWGP
player below plays XP/VX/Ace conversions, and MV/MZ ones made with
`convert:auto --mwgp`.

## 1. Boot sequence (`public/player.js`)

1. Load the `mwg` global bundle (`/mwg.js`), fetch
   `GET /api/mwgp/:id/index` (manifest with maps as `{id, info}` stubs).
2. `?map=&x=&y=` overrides select the boot map; fetch it full from
   `/api/mwgp/:id/maps/:mapId` (`loadMap`, cached into `project.maps`).
   Decoded asset roots rewrite to `/api/mwgp/:id/assets`; plugin/engine
   library roots likewise.
3. Unless `?map`/`?skipTitle`, `showTitleScreen(project)` (section 2), with
   title music from `audio.system.titleBgm`.
4. `startMwgPlayer(canvas, project)`; on its failure the canvas fallback
   (`fallback-core.js`: flat-colored tiles, native-subset events, no
   pictures/audio/menus/battles) takes over and warns.

`?newGame=1` boots the start map fresh (clears the transfer payload);
`?load=1` opens the newest save (slot picker when several).
`F5`/`F9` save/load the last used slot.

## 2. Title screens (`showTitleScreen`)

Two branches, picked from `manifest.titleScreen`, the same for every engine:

- **Generic** (no usable art): project name over a shaded backdrop, New Game /
  dimmed-until-a-save-exists Continue / Options (audio mixer) buttons.
- **Stock** (`title1`/`title2`): the engine's `Scene_Title` layout —
  fullscreen layers, game title at H/4 while `drawTitle`, command box
  bottom-96px plus `commandOffset`. RGSS titles arrive in the same shape (the
  converter copies XP/VX/Ace title art to `img/titles1`/`img/titles2`).
- Plugin-drawn titles (picture commands, …) and a game's own Ruby title scene
  are not reproduced: the player never reads a plugin's parameters or a
  framework's scene by name (see `docs/removed-shims.md`).
- Both branches dim Continue until a save exists; the check uses the player's
  `slot-N` namespace. Keyboard: arrows cycle, Enter/Space confirm, Escape
  closes Options. Finishing sets `?load=1`/`?newGame=1` + `skipTitle` and
  removes the overlay. A per-feature compatibility banner
  (`compat-features.js`) precedes the title; fully supported projects stay
  silent.

## 3. Scene and rendering (`player-core.js`)

- `TileMap` with the six MV layers (characters between lower/above groups);
  autotile sheets reconstructed client-side into static atlases (XP 48×8 and
  MV A1–A4 shapes from the manifest tileset tables). Panorama/fog/foreground
  from map settings; `ScreenEffects` (fade/flash/tint/shake) above the world,
  below the window stack so effects wash the world, never the text.
- Characters from `characterFrames` cell math (never assumed 48px),
  feet-anchored with the 6px shiftY (`!` objects exempt); grid movement,
  event alpha/erased sets, vehicles, party followers behind the leader (216/217, AGENTS.md "Map features").
  A `null` `playerSprite` (the start actor's charset does not ship) draws a
  static placeholder tile for the player.
- **Pictures** below the message windows (a fullscreen splash can never cover
  question text); balloons/animations through the event vocabulary.
- **Battle stage** (`buildBattleStage`): map battleback (or dark base),
  troop-positioned enemy battlers, side-view party idle poses dimmed when
  defeated.
- **RGSS overlay** (`rgss-screen.js`): live `Sprite`/`Plane` instances
  composited on a letterboxed canvas over the game canvas (z-order, viewports,
  `src_rect`, opacity); `Bitmap` is real on canvas (blt, text with
  shadow/outline, gradients, get/set_pixel). `Window` is not drawn yet (games
  that build their windows from Sprites still show their text); tone/flash and
  blend types are pending.
- Map transfers carry `GameState` through `SaveSystem` (`runtime-transition`
  payload) into a scene rebuilt in the same page (`switchMap`; the URL follows
  via `history.replaceState`); music resumes from its playhead. A failed switch
  falls back to reloading the page.

## 4. Events and dialogue

`prepareEventCommands` rewrites only what `mwg`' fixed
`EventRunner.step()` cannot express into `call` closures (transfers, pictures,
choice branches, audio routing, screen effects, inventory/party/gold, menu,
`goto`, battle triggers, `script`, `pluginCommand`, `unsupported`, control
flow via thrown `BreakLoopSignal`/`ExitEventSignal`, portrait-bearing lines,
player-state `if` conditions, `gameData`/`script` variable operands);
`say`/`ask` (plain), switches, plain variables, waits, moves and plain `if`s
pass straight to the native runner. Presentation seam: dialogue box + paged
picker (`presentDialogue`), shared by events, battles, menus, shops, Game Over.
Message text gets the stock escape codes (`\V \N \P \G`, colour/icon codes
dropped, unknown `\X` consumed like the engine) after the game library's own
`self.inline` text filters; plugin text-code layers are not run.

**Plugin commands** always run the game's own plugin code in the sandbox:
MV 356 through the `Game_Interpreter#pluginCommand` chain, MZ 357 through
`PluginManager.callCommand(interpreter, plugin, name, params)` when that plugin
registered the command. The sandbox provides an inert current scene
(`SceneManager._scene` with an empty `_windowLayer`) because plugins reach
through it during map play. A command no loaded plugin handles, or one whose
plugin needs the scene/window layer, fails loudly; the player carries no
per-plugin adapters.

## 5. Audio (`audio-manager.js` over `mwg` ≥ 0.20)

`AudioBus`: independent looping BGM/BGS streams (same-track replay only
retunes), ME jingles suspending/resuming BGM at position, overlapping SE,
per-play volume/pitch/pan, plain-data snapshots riding in the transfer
payload. Decoding: real audio + MV/MZ Vorbis `LOOPSTART`/`LOOPLENGTH` tags;
MIDI rendered on a worker (`renderMidiToBufferAsync`, bit-identical to the
sync path) with the project's `.sf2`, cached in IndexedDB keyed by
`source.convertedAt`. Player mixer (master/kind volumes, mute, `M` in game,
title Options sliders) scales on top of track volumes. Vocabulary commands
`playBgm/playBgs/me/sound/fadeout*/saveBgm('both')/resumeBgm/stopSound` route
here; map autoplay behaves like the engine; `.wma` warns once.

## 6. Battles (`battle.js`, pure; presentation in `player-core.js`)

Deterministic given injected `present`/`rng`, over the project's database
(MV/MZ, or XP via the mapped database): class-curve stats with equipment,
traits and states, per-actor Attack/Skill/Guard/Item, rated enemy actions,
agility/speed ordering, MP, hit/evade, plain-expression damage formulas
(plugin formulas fall back loudly to the stock formula), element/guard/crit/
variance, HP/MP damage/recovery/drain, states/buffs/learn/escape, regen/slip,
MV escape ratio, victory (experience, level-ups, gold, drops) or defeat.
Results write back to `rpgExtra.actors`, inventory, gold; no-save "can lose"
goes to Game Over (Continue/Restart/To Title). Without a database the old
dialogue duel stays. Presentation is dialogue + paged menus; no animations,
motion, popups, TP, counters, or plugin damage engines. Every troop of every
converted MV/MZ project is swept in `npm test`; the browser harness plays the
weakest troop through the real UI.

## 7. Menu (`menu.js`) and saves

MV/MZ database menu on Esc/X: Item (scope-aware targets, consumables used),
Skill (menu-usable, MP paid), Equip (slot/type traits, inventory swap),
Status, Save (slot picker), Options (mixer), Game End (to title). Five
numbered slots with one-line summaries (leader/level, map, date);
`savedSlots()`/`slotLabel()`/`pickSlot()` shared with the title's Continue.
XP without a database keeps the small Save/Close box. No Formation screen,
no graphical windows.

## 8. Event scripts (RGSS Ruby / MV JS)

One runtime (`rgss-script.js`, dynamically imported so
`prepareEventCommands` stays Node-importable) runs both dialects through a
`with`-scope Proxy: built-ins (`$game_switches/variables/self_switches`,
`$game_map/player/party/temp/system/screen`, `Graphics`, `Audio`, `rand`,
`File`/`Dir`/`FileTest` over the file index, MV globals in `mv` mode), then
library units loaded lazily, then a warn-once stub. Built-ins cover only the
stock RGSS/MV engine: no framework helper (`pb*`, `$player`, `RTP`, …) is
stood in for, so the game's own definitions always win and a missing one is a
loud stub. Snippets run as bodies of the game's own `Interpreter`, so bare calls
compile to `this.<name>()`; Ruby2JS quirks are normalized in the converter
(`?`/`!` stripping, call-vs-property via known-method sets, `alias` chains,
`extend`/`include` order, setters, `@x`/`_x` collisions, modulo and hoisted
locals, `yield` inside blocks). Frame-waiting code runs lifted-async
(`nextFrame` yields animation frames), including a game's own message
functions, which draw through its own Sprites; XP's
`$game_temp.message_text = ...` shows in the player's dialogue box; sync
snippets queue their presentation in order afterwards. Display/audio singletons are inert where the canvas
layer stands in; engine behavior needing the unloaded UI/scene layer fails
loudly. Switches/variables/map/player stay on `GameState`; party/gold/
inventory/engine objects persist in `rpgExtra` (`mvEngine`, `rgss.boot`)
across reloads. The runtime's `introspect()` lists every loudly-skipped call
for the harness.

Save-data state: `ensureBoot` materializes the game's `SaveData.register`
values before first script use and snapshots them after every script (every
registered global, `$player`/`$bag`/`$PokemonGlobal` in Void, is the game's
own object), which is why Void's character select runs. There is no entry
point into a game's own menu scenes: Escape opens the player's menu. Running
them needs a generic scene entry, a real `Window` and full `Game.start_new`
state.

## 9. Compatibility, validation in the browser, gaps

- `showCompatibilityWarning` + soak/map-sweep notes print per-feature gaps
  (most-used first), never raw counts; clean projects stay silent.
- The default browser harness (`test-browser.mjs`) asserts per project: boot,
  input, save/load round-trip, map BGM, one track per audio format, menu walk,
  weakest-troop battle, battle-stage pixels, and the title-to-game path.
  `--maps` additionally boots every map (or a selected spread) and checks for
  crashes and blank output; `--soak` runs a timed input bot and fails on
  runtime errors or an unresponsive page.
- Known gaps (roadmap): real `Window` (skin/contents/cursor/index); full
  `Game.start_new` state (menus/battles end to end); a generic entry into a
  game's own title/menu scenes; the MV scene/window layer for plugins that
  draw; VX/Ace database mapping;
  tone/color/flash and blend types on the RGSS overlay; move-route script
  steps; async conditions/operands; Formation screen; save import from engine
  formats; 2000/2003 support (converter spec section 9).

## 10. MV/MZ web builds: the nw.js host layer (`src/web/nwjs-host.js`)

A web build (converter spec section 3a) plays the game's own MV/MZ engine; this
player is not involved. `npm start` serves the build as a static folder at
`/web/<id>/` (the launcher's "Play (web)"), and any other static web host can
serve it the same way. The host layer knows no game; it supplies what nw.js adds
to a browser page:

- **`require('fs')`**: reads come from the web server (synchronous XHR, like
  nw's synchronous fs); writes (saves, config, anything the game writes) live
  in memory and persist to IndexedDB (`mwgp-web:<path>`), so saves are not
  capped at localStorage's few MB. `existsSync`/`readdirSync`/`statSync` answer
  from `files.json` plus what the game wrote; `mkdirSync` creates directories;
  async and `fs.promises` forms wrap the synchronous ones.
- **`path`, `process`, `os`, `util`, `events`, `nw.gui`/`nw`**: Node-compatible
  where games use them (`path.normalize` keeps trailing separators, `parse`,
  `relative`, …); the nw window maps to the tab (fullscreen through the
  Fullscreen API), `Shell.openExternal` to a new tab.
- **Anything else** (child_process, worker_threads, stream, native add-ons
  such as Steam bindings): a lenient object whose calls do nothing, warned once
  per module (`[nw.js host] require('x') has no browser equivalent`).
- **Engine mode**: with `require`/`process` present, `Utils.isNwjs()` is true,
  so the engine uses its desktop code paths; saves go through `fs` into the
  host's store (MV `save/fileN.rpgsave`, `global.rpgsave`; MZ likewise).
- **Boot order**: the patched `index.html` loads the host first. The host loads
  the store and `files.json`, then the game's deferred scripts in document
  order, then waits for every script those scripts inserted (MV's
  `PluginManager.setup` adds each plugin as a `<script>`), exactly as the
  browser's own `load` event would, and only then runs the page-load handlers
  the game registered (`window.onload`, `addEventListener('load')`).
- **Diagnostics**: `window.__mwgpWebHost` (`files()`, `stored()`,
  `warnedModules()`), used by the browser harness.
- **Verified** (browser harness, `npm test`): Karryn's Prison and Way of
  Corruption (MV) and Elementals (MZ) boot to their own title screens, start a
  new game on a map, and a save made there survives a reload and loads.
- **Limits**: static hosts on Linux are case-sensitive while RPG Maker projects
  are not (a mismatched file name 404s there); features that need the desktop
  (Steam, opening local folders, native logs beside the game) do nothing, and
  games log that and carry on.
