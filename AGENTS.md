# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, opencode, ...) when working with code in this repository. (`CLAUDE.md` only points here.)

## What this is

RPGM Player makes RPG Maker games playable in any browser. The goal is playing every game everywhere, by the
simplest faithful route per engine:

- **MV/MZ → web build** (`tools/build-web.js`, the `convert:auto` default). MV/MZ games are browser JavaScript;
  nw.js only adds a few host APIs. A web build is the game's own engine and files, unchanged, plus
  `src/web/nwjs-host.js`, a generic nw.js host layer (see "Web builds" below). Titles, menus, battles and plugins
  run exactly as in RPG Maker; nothing is converted.
- **XP/VX/Ace → mkxp-z web build** (`tools/build-web.js`, the `convert:auto` default): the game's original files
  go into an uncompressed `.mkxpz`; our page runs them with the pinned mkxp-z libretro WebAssembly core.
  `--mwgp` keeps the manifest converter/player path described below.

The MWGP path converts a project into a portable JSON manifest format called **MWGP** (`mwgp.json`), then plays that
manifest in the browser against **`@datamoc/mw_games`** (imported as `mw_games`), an external
tile-game runtime library. This repo owns the MV→MWGP converter, the manifest format, and a
player built on `mw_games`'s primitives; it does not implement its own game engine or an
MV/RGSS emulator — `mw_games` is the runtime layer everything renders and runs through. (Event scripts are the
one exception in spirit: MV/MZ projects ship their own engine logic and plugin JS, which the player runs in a
sandbox, and XP/VX/Ace Ruby is transpiled to JS; see "Event scripts" below.)

There is no build step, bundler, or linter. Everything is plain Node.js ESM
(`"type": "module"`, top-level `await` in the `tools/*.js` scripts) served as-is.

## Commands

```powershell
npm install
npm start                  # serves the launcher at http://127.0.0.1:4173 (port via RPGM_PORT)
npm run scan                # same detection logic as `start`, but prints the catalog as JSON and exits
npm run convert:mv -- "RPGM_versions\<project>" "MWGP_versions\<project>"
npm run convert:auto -- RPGM_versions MWGP_versions [--jobs N] [--skip-existing] [--mwgp]   # every game, in parallel
npm run build:web -- "RPGM_versions\<project>" "MWGP_versions\<project>"   # one MV/MZ or XP/VX/Ace web build
npm run validate:mwgp -- "MWGP_versions\<project>\mwgp.json"
npm run rgss:api -- "RPGM_versions/<project>/Game.exe" --out docs/rgss-api-xp.json        # RGSS class/method surface, from strings only
npm run rgss:coverage -- "MWGP_versions/<project>/mwgp.json" --out docs/rgss-shim-coverage.md  # what the Ruby uses vs what the shim has
```

`rgss:api` reads the plain-text strings of a runtime binary (no disassembly). Pokemon Void's `RGSS104E.dll` is
packed and yields no names; its `Game.exe` (a Ruby 3.1, MKXP-style host) lists every RGSS class, method and the
`RPG::*` attributes, so point it at the executable. `rgss:coverage` ranks the RGSS members the transpiled Ruby
calls that the shim (`createRgssRuntime(...).introspect()`) lacks; `docs/rgss-shim-coverage.md` is the current
list.

`convert:mv` accepts `--copy-tilesets`, `--copy-characters`, `--copy-faces`, `--copy-pictures`,
`--copy-audio`, or `--copy-assets` (all of the above) to decode the corresponding RPG Maker
assets into the output folder; without any flag the manifest references the original `www`
folder in place and the player falls back to a placeholder tile sheet.

`convert:auto` detects each game's engine (MV/MZ → a web build, or with `--mwgp` the MWGP conversion
`convert:mv --copy-assets`; XP/VX/Ace → a mkxp-z web build, or with `--mwgp` the RGSS manifest converter,
extracting raw archives first) and converts
the games in parallel, one process each,
at most `--jobs N` at a time (default: the core count; lower it when memory is short). Each game gets a
progress bar on stderr, fed by `@@progress` lines the converters write when `MWGP_PROGRESS` is set
(`tools/progress.mjs`: 100 points split into weighted phases, per-item ticks); stdout stays the JSON
summary.

`npm test` runs `tools/test-smoke.mjs` (converter/validator/runtime checks on synthetic and locally installed
projects, plus the audio, SoundFont-licence and RGSS-coverage checks, then the browser harness as its last
section: every converted project in a real Chromium — boot, movement, save/load, map BGM, one track of every
audio format — loudly skipped with `MWGP_BROWSER=0` or when no playwright/chromium is installed);
`node tools/test-browser.mjs` also runs standalone with the same debug aids plus `--only`, `--maps` and `--soak`.
For each MV/MZ web build the harness boots the game's own engine to its first scene, starts a new game on a map,
saves there, reloads, and loads the save back (stock `SceneManager`/`DataManager` APIs; uncaught errors fail, errors
the game logs and recovers from are notes). `validate:mwgp` checks a generated manifest and its event command tree. Beyond that, verify changes by
running `npm start` and playing a converted project in the browser. Debug aids for the browser harness:
`MWGP_SMOKE_DEBUG=1` (echo page console), `MWGP_SMOKE_SHOT=<png>`, `MWGP_SMOKE_SETTLE=<ms>`,
`MWGP_SMOKE_DISMISS=<n>`, `MWGP_SMOKE_NOAUDIO=1`, `MWGP_SMOKE_NOBATTLE=1`, `MWGP_SMOKE_NOMENU=1`, `MWGP_SMOKE_JOBS=<n>` (map boots in parallel, defaults to core count), `MWGP_SMOKE_PROGRESS=<file>` (live per-map progress log, defaults into the OS temp dir), `MWGP_SMOKE_RESUME=1` (skip maps the log already records as ok, so an interrupted sweep relaunches for the remaining maps only; fresh runs truncate their project's old lines), `--only <project>`, and
`--soak [seconds]` (a bot plays a new game of each project: walks, presses Enter/Esc; reports maps reached, dialogues opened and fails on runtime/uncaught errors or a page that stops answering; `MWGP_SMOKE_DEBUG=1` prints the error stacks), and
`--maps [N]`, which also boots every map of each project (or N evenly spread ones) on its own and fails on maps that
crash, log runtime (`MWGP ...`) or uncaught errors or draw nothing (errors the game's own code logs and recovers from are printed as notes) (`npm run` is not needed: `node tools/test-browser.mjs --maps`).

## Tooling discipline

Be conservative about `tools/`: only scripts with genuine reuse value live there
(converters, validators, checks run by `npm` scripts, diagnostics reused across
issues like `diag-sheets.mjs`). One-off probes and scratch scripts stay outside
the repo (e.g. under `/tmp`) — never committed, never deleted for the user, so
past verification stays re-runnable without cluttering the project. A substantial
inline or heredoc command is still a script: write it to a reusable file under
`/tmp` before executing it instead of leaving it only in shell history.

## Where supporting material lives (`notes/` vs `docs/`)

- `notes/` is the drawer for raw working material: downloaded documentation,
  reference screenshots, and useful logs (e.g. a test run's output kept for
  comparison). Anything tied to one specific investigation, not meant to be
  read as documentation.
- `docs/` is for documentation meant to be read: markdown files that explain,
  summarize or guide (checklists, coverage reports, API notes). A readable
  write-up always goes here, never in `notes/`.

## Architecture

### Web builds (MV/MZ)

`tools/build-web.js <project> <output>` copies the game's web root (`www/` for MV, the project root for MZ) as-is,
encrypted assets included (the engine decrypts them itself); a native `save/` folder is left out. It adds
`nwjs-host.js` (from `src/web/`), `files.json` and `directories.json` (the game's file and directory indexes) and `mwgp-web.json` (`format: "MWGP-web"`,
title, engine, file count), and patches `index.html`: the host loads first in `<head>` and every game
`<script src>` becomes a `data-mwgp-src` placeholder. A rebuild copies only changed files; a previous MWGP
conversion in the same folder (`mwgp.json`, `assets/`) is replaced.

`src/web/nwjs-host.js` knows no game. It provides what nw.js adds to a browser page:
- `require('fs')`: reads over HTTP (synchronous XHR, like nw's synchronous fs); writes (saves, config) in memory,
  persisted to IndexedDB (no localStorage size limit). On the local `npm start` server, generated FastCutIns cache
  files are also written to the original project and web build; on static hosts they stay in browser storage.
  `readdirSync`/`existsSync` use the file/directory indexes plus what the
  game wrote; `mkdirSync` creates directories.
- `path`, `process`, `os`, `util`, `events`, `nw.gui`/`nw` (window, shell, app).
- Any other module (child_process, worker_threads, native add-ons such as Steam bindings) is a lenient object whose
  calls do nothing, warned once per module.

With `require` and `process` defined, the engine takes its nw.js paths (`Utils.isNwjs()`): saves go through `fs` to
the host's store. Boot order matters. The host first loads the store and file list, then the game's scripts in
document order. Then, like the browser's own `load` event, it waits for every script those scripts inserted (MV's
`PluginManager.setup` adds the plugins that way) before running the page-load handlers the game registered
(`window.onload`, `addEventListener('load')`). The output is a static folder any web host can serve; `npm start`
serves it at `/web/<id>/`, and the launcher lists it with a "Play (web)" button. Known limits: a Linux static host
is case-sensitive while RPG Maker projects are not; games that log to a folder beside the game log recoverable
`ENOENT`s.
When an MV project has `www/` and a sibling `mods/` folder, the build copies those mod files into output `mods/`
and indexes them alongside the web root files. A `www/mods/` folder is copied with the web root.

### Web builds (XP/VX/Ace)

`tools/build-web.js` dispatches RGSS projects to `tools/build-rgss.mjs`. It packages their original files as stored
ZIP64 entries in `game.mkxpz`, excluding Windows executables, DLLs, native saves and GPU caches. The build copies
our `src/web/rgss-player.html` and `rgss-player.js`, Nostalgist, and the mkxp-z libretro core. The core is fetched
once into gitignored `.cache/mkxp-z/` from a pinned upstream deployment and SHA-256 checked by `tools/mkxp-core.mjs`.
The page uses OPFS for the archive and saves (IDBFS fallback), shows download progress, binds RPG Maker keys, and
sets `mkxp-z_syntaxTransform` to 0 for a shipped modern Ruby runtime, 2 for classic RGSS. `npm start` serves
`/web/<id>/` with COOP and COEP headers. `tools/test-browser.mjs` checks core preparation; gameplay needs a manual
check because the automated browser cannot inspect the core's frames. Provenance, licenses and verification limits
are in `docs/rgss-web-build.md`.

### Two on-disk game representations

- `RPGM_versions/<name>/` — untouched RPG Maker projects, as installed. `src/server.js`
  detects two kinds by folder contents: MV/MZ (`www/index.html` + `Game.exe`, an nw.js app)
  and XP/VX/Ace (`Game.ini` + `Game.exe`, an RGSS app). Both kinds can be launched natively
  (`spawn`s `Game.exe`) from the web UI; only MV/MZ can currently be *converted*.
- `MWGP_versions/<name>/` — converter output: `mwgp.json` plus an optional `assets/` tree of
  decoded images/audio. This is what the browser player actually reads.

Both trees are scanned fresh on every request (`listGames`/`listMwgp` in `src/server.js`), not
cached, and both can be large (RPG Maker asset trees run into gigabytes) — avoid broad
glob/grep passes over `RPGM_versions/` or `MWGP_versions/`; treat them as data, not code.
Project identifiers used throughout the API (`?id=`) are the folder name, base64url-encoded.

### The server (`src/server.js`)

A single `node:http` server with no framework and no build step: static files under `public/`
are served with a path-traversal guard, and three source files are served from outside
`public/` via dedicated routes instead — `/player-core.js` and `/fallback-core.js` read straight
from `src/player/`, and `/mwg.js` reads the prebuilt `mw_games` global bundle straight out of
`node_modules/@datamoc/mw_games/dist/mw_games.global.js`. Editing any of those files takes
effect on browser refresh with no compile step.

API surface: `GET /api/games` (catalog), `GET /api/mwgp/:id` (manifest JSON),
`GET /api/mwgp/:id/index` (manifest with maps replaced by lightweight `{id, info}` stubs —
the browser boots from this, then fetches one full map per visited map via
`GET /api/mwgp/:id/maps/:mapId`; parsed manifests are cached per file version),
`GET /api/mwgp/:id/assets/*` (decoded asset bytes, also path-traversal-guarded against the
project's own `assets/` root), and `POST /api/launch` (spawns a native `Game.exe` detached).

### The converter (`tools/convert-mv.js`) and the MWGP command vocabulary

Reads `www/data/*.json` from an MV project and emits one `mwgp.json`. The interesting part is
`convertCommands`/`parseBlock`: it walks MV's flat, indent-delimited event command list
recursively to rebuild nested `if`/`else` blocks (MV codes 111/411/412), Loop/Break Loop
(112/113/413), and Show Choices' per-choice/cancel branches (102/402/403/404), and inlines
common event calls (code 117, depth-limited to 8 to avoid cycles) — then translates only a
subset of MV's command codes into a small, explicit MWGP vocabulary:

```
say, ask, inputName, wait, setSwitch, setVariable, addVariable, copyVariable, if, loop, breakLoop,
exitEvent, move, transfer, picture, erasePicture, movePicture, tintPicture, balloon,
animation, scroll, scrollMap, relocate, saveBgm, resumeBgm, me, menu, goto,
changeState, recoverAll, changeSkill, changeEquipment, changeProfile, sound,
stopSound, playBgm, fadeoutBgm, playBgs, fadeoutBgs, turn, screenFade, screenFlash,
screenTint, screenShake, changeGold, changeItem, changeWeapon, changeArmor, changeParty,
setTransparent, eraseEvent, script, pluginCommand, unsupported,
systemFlag, changeActorStat, changeActorText, changeActorImages, timer, vehicleBoard, playMovie,
forceAction, returnToTitle
```

The last row (0.2.0) covers the Game_Interpreter codes the first converter left out: `systemFlag` folds 134-137 (save,
menu, encounter, formation access), 138 (window tone), 132/133/139 (battle BGM, victory/defeat ME), 140/323 (vehicle
BGM/image), 216 and 281 into `rpgExtra.system`; menu and save access, and the battle/victory/defeat audio, are honoured
(Esc/X, the menu's Save entry, `startTroopBattle`), the rest is stored only. `changeActorStat` is 312/315/317/326 (MP, EXP
with level-up, parameter bonus, TP), `changeActorText` 320/324, `changeActorImages` 322 (which the first converter wrongly
stored as the profile; the profile is 325), `timer` 124 plus the `if.timer` condition (no on-screen counter), `vehicleBoard`
206, `playMovie` 261 (a `<video>` overlay over `assets/movies/<name>.webm`, copied by the converter), `forceAction` 339
(`runBattle`'s `hooks.onControls` hands the scene a `forceAction`, run at the point of the troop event; the cost is paid, canUse is
skipped) and `returnToTitle` 354. Also `selectItem` 104, `rotatePicture` 233, `locationInfo` 285 (Game_Map's own terrain-tag/tile/region
rules), `abortBattle` 340 (`hooks.onControls.abort`, escape result), `enemyRecoverAll` 334, and 283 (a `systemFlag` battleback the
battle stage reads). 337 draws no animation (battles have none). 282 Change Tileset (`changeTileset`) rebuilds the map with the new tileset through the transfer's save-and-reload (`&tileset=<id>`, kept in `rpgExtra.mapTilesets` for later transfers back); the scene cannot be rebuilt in place, so the asking event restarts from its first command once after the reload (asking for the tileset already in use is a no-op, which ends the restart). Every command code of the engine is now converted or documented partial.
284 Change Parallax and the map's own parallax (properties: image, loop, scroll speed, '!' prefix) are rendered as a `TiledSprite` behind the tilemap
(`installParallax`/`updateParallax`, `Game_Map.parallaxOx` maths shared with the foreground layer); the converter decodes the images from `img/parallaxes`.
Engine numbering for enemy commands is 331 HP, 332 MP, 333 State, 334 Recover All, 335 Appear, 336 Transform, 342 TP (the first
converter had 333 as TP and 334 as a state change, and 322 as the profile; Karryn's Prison uses 333 x12 and 322 x37).

`unsupported` is the explicit loud-fallback marker (never a silent drop): the
converters emit `{ unsupported: { code, kind } }` for event-command shapes with
no engine-free equivalent (unknown conditional-branch kinds, unmappable
variable operands), and the player routes it to a console warning and continues
with the next command. New `if` condition shapes (`partyMember`,
`actorSkill`, `actorState`, `facing`, `eventFacing`, `gold`, `item`) and new
`modifyVariable` operand shapes (`gameData`, `script`, plus the `set`
operation) are sub-shapes of the existing `if`/`modifyVariable` keys, evaluated
by `prepareEventCommands`/scene methods against player-held `rpgExtra` state.

Party, gold and inventory counts have no home in `mw_games`' `GameState`
(switches/variables only), so the player carries them as its own `rpgExtra`
state through transfers and saves. MV `script` commands run through the bounded
MV globals shim when conversion produced valid JavaScript; unsupported calls warn
loudly. Every `pluginCommand` runs the game's own plugin code in the plugin sandbox (`rgss.pluginCommand`): MV 356
through the `Game_Interpreter#pluginCommand` chain, MZ 357 (which keeps `plugin` and its `params` object) through
the command that plugin registered (`PluginManager.callCommand`); plugin-added methods on
`Game_Variables/Switches/SelfSwitches` run against the shim objects. It warns loudly when no engine is loaded or no
plugin registered the MZ command. The plugins handling the events' command words ship in the plugin library (see
`tools/mv-plugins.mjs`), and `compatibility.plugins` rates a command `partial` (with `handledBy`) exactly when one does.

**No game-, framework- or plugin-specific code.** Nothing in the converters or players may name a particular game,
a framework (Pokémon Essentials, ...) or a third-party plugin, or read a plugin's parameters by its name. What a
game needs beyond the stock engine comes from running its own code (Ruby library, plugin JS) or stays a loud gap.
The shims removed under this rule, with what they did and which game relied on them, are archived in
`docs/removed-shims.md`; reinstating one is the wrong fix.

Self switches (MV's per-map-event 'A'-'D' switches) are not a separate vocabulary entry —
they're folded into `setSwitch`/the `if` condition's `switch` key via a synthesized
`self:<mapId>:<eventId>:<ch>` string key, reusing `GameState`'s single switch namespace
instead of teaching the runtime a second switch kind.

**This vocabulary is a contract shared by four files**, and they must be kept in sync when a
command is added or changed:
1. `tools/convert-mv.js` (`convertCommand`/`parseBlock`) — produces it from MV command codes.
2. `tools/convert-mv.js` (`buildCompatibilityReport`) — classifies every MV command code seen
   in the project as `supported`/`partial`/`unsupported`, written into the manifest as
   `compatibility.commands` (a data-driven priority list for what to convert next).
3. `tools/validate-mwgp.js` (`allowed` set) — rejects any manifest command key not in the list.
4. The players — `src/player/player-core.js`'s `prepareEventCommands` only needs to handle the
   commands that require a scene/renderer callback or JS-level control flow mw_games's fixed
   `EventRunner.step()` can't express on its own (`transfer`, `picture`, `erasePicture`,
   `movePicture`, `tintPicture`, `balloon`, `animation`, `scroll`, `scrollMap`,
   `relocate`, `saveBgm`, `resumeBgm`, `me`, `menu`, `goto`,
   `changeState`, `recoverAll`, `changeSkill`, `changeEquipment`, `changeProfile`,
   `sound`, `stopSound`, `playBgm`, `fadeoutBgm`, `playBgs`, `fadeoutBgs`, `turn`,
   `screenFade`, `screenFlash`, `screenTint`, `screenShake`, `changeGold`, `changeItem`,
   `changeWeapon`, `changeArmor`, `changeParty`, `setTransparent`, `eraseEvent`, `script`,
   `pluginCommand`, `unsupported`, `loop`, `breakLoop`, `exitEvent`, `copyVariable`, a choice command with
   `branches`, a portrait-bearing `say`/`ask`, an `if` with a player-state
   condition (`partyMember`, `actorSkill`, `actorState`, `facing`,
   `eventFacing`, `gold`, `item`, `unsupported`), or a `modifyVariable` with a
   `gameData`/`script` operand or the `set` operation); each is rewritten into
   a `call` closure the runner's own generic escape hatch supports. `loop` and `exitEvent` unwind via a thrown
   sentinel (`BreakLoopSignal`/`ExitEventSignal`) caught by `runLoop`/`runPage` respectively,
   since `EventRunner.run()` has no other way to stop a list mid-flight. The rest (`say`,
   `ask` without `branches`, `setSwitch`, `setVariable`, `addVariable`, `wait`, `move`, `if`)
   pass straight through to `mw_games`'s own `Rpg.EventRunner`, which already understands that
   shape natively. `prepareEventCommands` is exported so `tools/test-smoke.mjs` can drive it
   in Node with a stub scene and assert every non-native command routes to a scene method.
   `src/player/fallback-core.js` (the canvas fallback) consumes the same converted
   vocabulary (`mwgEvents` + `Rpg.EventRunner`): its native subset runs unchanged, `transfer`
   and choice `branches` are rewritten into `call` closures, and anything else warns once
   per page — no raw MV command codes anywhere (T127).

Asset decoding (`decodeTree`/`decodeNamedTree`) also does MV's asset "encryption": it XORs
only the first 16 bytes of `.rpgmvp`/`.rpgmvo`/`.rpgmvm` files against the project's key from
`System.json`, then strips the 16-byte header — the remaining bytes are already plain PNG/OGG.
`--copy-pictures` / `--copy-audio` only decode assets actually referenced by converted events
(tracked via `pictureNames`/`soundNames` collected while converting commands), to avoid
copying entire multi-gigabyte `img/pictures` or `audio` folders.

### The MWGP manifest shape

`mwgp.json` carries: `format`/`version`, `source`/`display` metadata, `initialMapId` and
`player` start position, `assets` (root path + which categories were decoded + encryption
kind), the raw `tilesets` database table (for autotile flags and sheet names), `playerSprite`,
detected `plugins` (names only, scraped from `www/js/plugins.js`), the `compatibility.commands`
report, `titleScreen` (the engine's stock title: title1/title2 names plus `drawTitle`/`commandOffset` from
`System.json`; RGSS maps XP's `title_name`, VX's `System/Title` and Ace's `title1/title2_name` onto the same
shape, copying the art to `img/titles1`/`img/titles2`), and `maps[]` — each map keeps the **raw MV map `data`** (the six-layer tile array, used
directly by both players) alongside `mwgEvents` (the converted event pages). `database` holds
the other raw MV database JSON files (actors, classes, skills, …) lowercased by filename,
mostly unused by the player today beyond `playerSprite` lookup.

### The two players

`public/player.js` is the entry point: it loads the `mw_games` global bundle, fetches the
manifest for `?id=`, then tries the real player and falls back on failure:

- `src/player/player-core.js` (`startMwgPlayer`) — the real player, built entirely on `mw_games`
  primitives (`Game`, `Scene2D`, `TileMap`, `SpriteSheet`, `WindowStack`, `MessageBox`,
  `Rpg.GameState`, `Rpg.EventRunner`, `Rpg.GridMover`, `Rpg.activePage`, `SaveSystem`, `Input`,
  `Audio`, `Resources`). It reconstructs RPG Maker's A1–A4 autotile sheets into static atlases
  client-side (`buildAutotileSheet` + the `FLOOR_AUTOTILE_TABLE`/`WALL_AUTOTILE_TABLE` shape
  tables — mirrored in `4MWG/extracts/rpgm-autotiles.js` as a reference for upstreaming this
  into `mw_games` itself), drives events/dialogue/pictures/sound through the vocabulary above,
  and carries `GameState` across map transfers by round-tripping through `SaveSystem` and a
  full page reload (`location.href` with `?map=&x=&y=`) rather than an in-memory scene swap.
  `F5`/`F9` save/load slot 1 the same way.
- `src/player/fallback-core.js` (`MwgPlayer`) — a minimal `<canvas>` 2D fallback with no asset
  dependency (flat-colored tiles), used only when the Pixi/mw_games 2D runtime is unavailable.
  It runs the converted event vocabulary through `Rpg.EventRunner` (native subset plus
  fallback-side `transfer`/choice-branch rewrites, loud once-per-kind warnings through `onUnknownCommand` (0.22+) for the rest)
  rather than interpreting raw MV codes; still no pictures, audio, menus, or battles.

### Sound and music (all RPG Maker generations)

Playback runs on `mw_games` >= 0.18's audio layer: `AudioBus` (BGM and BGS as independent looping
streams where replaying the same track only retunes it, ME jingles that suspend and resume the BGM at
its position, overlapping SE, volume/pitch/pan per play, save/replay with playheads, plain-data
snapshots), `parseMidi`/`renderMidiToBuffer` and `parseSoundFont`. `src/player/audio-manager.js` (served
at `/audio-manager.js`, shared by the title screen in `public/player.js` and the scene in
`player-core.js`) is the thin adapter over it and holds only what the library leaves to the game:
- **finding files** through the manifest's `audio` section (below);
- **decoding**: `decodeAudioData` for real audio plus the MV/MZ `LOOPSTART`/`LOOPLENGTH` Vorbis loop
  tags (read by the library's `parseVorbisLoopTags`/`loopRegionFromTags`, 0.22+); MIDI through `renderMidiToBufferAsync` on a worker thread (mw_games 0.20+, bit-identical
  to the sync `parseMidi` -> `renderMidiToBuffer` path it falls back to — about 0.7 s for a track
  with the project's SoundFont, now off the main thread), the PCM cached in IndexedDB
  (`cacheVersion` = `source.convertedAt`, plus a `libN` suffix bumped when the library's render changes: `lib2` for 0.22's voiced pitch bend) because every map change reloads the page;
- **the player's mixer**: master, per-kind volumes and mute in `localStorage` (`M` toggles mute in
  game; sliders in the title Options panel), applied through `AudioBus.setMixer` (0.22+) on top of each
  track's own volume, so snapshots report the level the game asked for with no unmixing here;
- the browser autoplay unlock and a small LRU of decoded music.
`snapshot()`/`restore()` ride in `runtimeState().audio`, so music continues from its position across a
map transfer. Commands `playBgm/playBgs/me/sound/fadeout*/saveBgm/resumeBgm/stopSound` route to it
(`saveBgm`/`resumeBgm` with value `'both'` is XP's Memorize/Restore BGM+BGS); XP `Audio.*` and the MV
sandbox's `AudioManager.*` (engine plugins) call the same manager. The map's `bgm`/`bgs` autoplay like
the engine.

The manifest's `audio` section is written by both converters via `tools/audio-index.mjs`: `index` maps
each kind's track name to the extension that exists (XP/VX/Ace mix `.ogg .mp3 .wav .mid .wma`; MV/MZ
decode to `.ogg/.m4a`), `system` holds the engine's own tracks read from `System.json`/`System.rxdata`
(title/battle BGM, jingles, system sounds, vehicle BGM), `soundfont` names the project's own `.sf2`.
RGSS audio dirs are copied to lowercase kinds. MV decodes only referenced audio unless `--copy-assets`.
`.wma` cannot be decoded and warns once. The browser harness checks that the map BGM starts and that one
track of every shipped format decodes/renders.

**SoundFont licensing:** a soundfont is a separately licensed, owned work. A game's own `soundfont.sf2`
is copied only into the gitignored `MWGP_versions/` output and must never be committed. The repo and
`mw_games` may carry a shared one only after it is recorded in `soundfonts/vetted.json` (licence, licence
file, source, sha256, who/when — see `soundfonts/README.md`); `npm test` fails on any unvetted
`.sf2`/`.sf3` and the server's `/soundfont.sf2` serves only vetted entries. GeneralUser GS v2.0.3 is vetted
(its author's provenance caveat was accepted by michel on 2026-09-25) and is the shared fallback for games that ship no
soundfont; without any font MIDI uses the library's built-in synth.

### Battles (MV/MZ)

`src/player/battle.js` (`runBattle`, pure and deterministic given an injected `present`/`rng`) is a troop battle
runner over the project's own database: actors (class curve `params[paramId][level]`, equipment, traits, states,
buffs) against a troop; per-actor commands (Attack / Skill / Guard / Item), enemy actions chosen by rating and
conditions, actions ordered by agility and skill speed, MP costs, hit/evade, damage formulas with physical/magical
rates, element rates, guard, critical and variance, HP/MP damage/recovery/drain, the effects that matter (recover,
add/remove state, buffs, learn skill, escape), state restriction and regeneration/slip, the MV escape ratio, and
victory (experience with level-ups and learned skills, gold, drops) or defeat. Results are written back to the
player's actor records (`rpgExtra.actors`), inventory and gold. `startBattle` in `player-core.js` uses it whenever
the manifest has a database (MV/MZ, or an XP project whose database was filled in, see below; otherwise the old dialogue duel stays);
losing without "can lose" goes to Game Over. Presentation is the dialogue box with menus (paged five at a time);
battle graphics are a stage only (`buildBattleStage` in `player-core.js`: the map's battle background (only maps that specify one; MV's terrain-derived default is not reproduced, so other maps get a dark base) each enemy's battler at its troop position and the party's side-view battlers (idle pose, MV's default formation), dimmed when defeated; the browser harness checks it draws when enemy art ships), with no animations, no motion or damage popups, or plugin damage engines. TP is modelled (a random 0-24 start unless the Preserve TP flag keeps the actor's value, TP charged by damage taken, TRG regeneration, `tpCost`, `tpGain`), as are counter attacks (CNT against physical skills), magic reflection (MRF against magical ones) and the Substitute flag (a dying ally is replaced by a holder, unless the skill never misses), in the order of `BattleManager.invokeAction`. Battles also draw feedback (0.2.0): damage/heal/MP popups through mw_games' `FloatingTextStack`, a hit shake and an attack step, and the skill's or weapon's database animation (`playBattleAnimation`, sheets loaded on demand; animation patterns 100+ read `animation2Name`), all driven by `runBattle`'s `hooks.onUse`/`hooks.onEffect` and never affecting the outcome. The party stands in a formation (`src/player/formation.js`: default, line, column, triangle, inverted, square, diamond, chevron, circle): the menu's Formation screen (hidden by Change Formation Access) reorders the party (only the first `maxBattleMembers`, default 4, fight) and picks the layout, and with two or more rows the front row draws more attacks (TGR x1.5, physical damage x1.10) while the back row is covered (TGR x0.6, x0.85). That row rule is this player's own extension, not RPG Maker's. Enemy target choice is TGR-weighted like the engine's `randomTarget`. The battle BGM (System.json or Change Battle BGM), the victory/defeat ME and a return to the map music are played.
Damage formulas are evaluated only if they are plain expressions; empty ones or plugin code
(`value = user.dmgFormula_x(target);`) fall back loudly to MV's stock attack/magic formula so a battle can still be
won, and a class with no hit-rate trait hits always. `tools/test-smoke.mjs` covers the rules on a synthetic
database and sweeps every troop of every converted MV/MZ project; `tools/test-browser.mjs` runs the weakest troop
through the real dialogue UI (`MWGP_SMOKE_NOBATTLE=1` skips it).

**XP database (`tools/rgss-database.mjs`):** `convert-rgss.js` converts `Actors/Classes/Skills/Items/Weapons/Armors/
Enemies/Troops/States/System.rxdata` into the same MV-shaped `database`, so XP games with the default battle system
use this runner and menu unchanged. (VX `.rvdata` / Ace `.rvdata2` files are discovered and their maps/events/scripts convert, but the
mapper stays XP-only: VX/Ace manifests ship `database: {}`.) Stats map to params (mhp, mmp, atk = weapon atk, def = pdef, mat = int, mdf = mdef,
agi, luk = dex, and param 8 = str); each skill's power/stat factors are written out as an XP damage formula string; the
per-actor stat tables (`actor.params[param][level]`) and XP's exp curve (`actor.expCurve`) live on the actor; element/
state ranks become trait 11/13 rates; troop pages convert through the same event converter. XP's own records use ids 1
and 2, so the runner's built-in attack/guard/escape/wait skills and guard state get spare ids named in
`database.system.battleIds` (MV keeps 1/2/2). Command 301 (with Win/Escape/Lose blocks 601-603) converts to `battle`.
A placeholder database (Essentials keeps blank names and empty troops and fights in Ruby) is not emitted, so those
games keep their own menus. Verified on a made-up project in `npm test`; no local XP game ships a filled database.

### Fonts, gauges and poses

- **Font.** With decoded assets the converter copies the one font the game uses (MZ: `System.json` `advanced.mainFontFilename`/`fontSize`/`fallbackFonts`; MV: the `GameFont` `@font-face` in `fonts/gamefont.css`, size 28) and records it as `display.font`. `applyGameFont` loads it as `GameFont` and sets it as the window theme's font at the engine's size scaled to the canvas. **`setTheme` rebuilds from the library defaults, not from the current theme**: every call must merge with `mwg.theme()` (the font was silently reset by the window-skin call until it did), and `lineHeight` is a multiplier of the size, not pixels.
- **Gauges.** `Window.png` is also the game's colour table (colour n at `(96 + n%8*12 + 6, 144 + floor(n/8)*12 + 6)`): the gauge back (19), HP (20/21), MP (22/23), TP (28/29) and text colours (0, crisis 17, knockout 18) are read from it (`readWindowPalette`, stock values as fallback). The battle draws a status panel top right (name, HP/MP/TP with the engine's gradients, the name in crisis/knockout colour); TP shows unless `optDisplayTp` is false.
- **Poses.** Actors animate on their `sv_actors` sheet like `Sprite_Actor`: wait/guard/dying/abnormal/sleep/dead follow the battler, attack (thrust/swing/missile from the weapon's `attackMotions`), skill/spell (`magicSkills`)/item on use, damage on a hit, evade on a miss, victory when the fight is won (`svCell`/`svPattern`/`svIdleMotion`/`svActionMotion`, unit-tested). Enemies stay static, as in the engine.
- **Old manifests.** The converter stamps `converter.version` as the second key of `mwgp.json`; `tools/converter-version.mjs` reads it from the first bytes, and `LAST_OUTPUT_CHANGE` (0.2.0) is what a manifest is compared against, so bump that constant when a conversion fix changes existing output. The launcher marks stale manifests ("reconvert"), the player shows a banner line for them, and `npm run convert:auto -- <src> <dst> --stale` reconverts only what is missing or stale.

### Windows

When assets are decoded the converter also decodes `img/system/Window.png` (`assets.windowSkin`). `applyWindowSkin` composes its 96x96 background and the frame's 24px corners/edges (the frame's middle holds the arrow sprites and is cleared) into one nine-patch and installs it as mw_games' window theme (`setTheme`), so dialogue, choice and menu windows all wear the game's own frame, with white text and a four-line message window. Without the file the library's default look stays.

### Menu (MV/MZ)

`src/player/menu.js` (`runMenu`, same dialogue seam and paged picker as battles) is the in-game menu, opened by the
"Open Menu Screen" command and by Esc/X on the map: **Item** (usable items with scope-aware target choice, key items
listed, consumables used up), **Skill** (an actor's menu-usable skills, MP paid), **Equip** (per slot, restricted by
slot type and the class's weapon/armor-type traits, swapping with the inventory, stats clamped), **Status** (level,
class, HP/MP, experience to next level, parameters, equipment, states), **Save** (slot 1), **Options** (the audio
mixer) and **Game End** (to title). Effects and recovery formulas are the battle rules (`createRules` in
`battle.js`), equipment lives in `rpgExtra.actors[id].equips[<1-based slot>] = { id, kind }` (as Change Equipment
stores it), and class parameters are `class.params[paramId][level]`. XP conversions (no database) keep the small
Save/Close box. There is no Formation screen and no graphical windows.

**Save files:** `SLOT_COUNT` (5) numbered slots (`slot-N` in the `SaveSystem`), each with a one-line summary (leader
and level, map name, date; `savedSlots()`, `slotLabel()`, `pickSlot()` in `player-core.js`). The menu's Save asks
which file and Load lists the non-empty ones; F5/F9 use the last file used; the title screen's Continue loads the only
save or asks which; Game Over offers Continue (when a save exists), Restart (a new game) and To Title.

### Event scripts (Ruby in XP/VX/Ace events, JavaScript in MV/MZ events)

Game-agnostic: nothing in the converter or player names a particular game (sidecar `loc/*.json` text tables are discovered generically; message-text hooks are found as `def self.inline` modules and listed in `rubyLibrary.textFilters`; a framework helper the game's library does not define is a loud stub like any unknown name, never a built-in stand-in; MV/MZ: the converter ships the project's own plugin JS that event scripts or plugin commands reach plus its engine logic files (`pluginLibrary`: `tools/mv-plugins.mjs`, name-reachability over `js/plugins/` and `rpg_core/managers/objects`, plus plugin-command words found as string literals and the plugins MZ commands name), and the same runtime evaluates them in a `with`-scope sandbox: the real `Game_*` classes, `DataManager` hooks, `JsonEx` and plugin globals run for real; windows/scenes/sprites are auto-created inert stubs; display/audio singletons are inert; nw.js host APIs (`require`, `process`, `document.currentScript`) are shimmed. The real `Game_Party` is bridged onto `rpgExtra` (gold/items/members) and engine object state (system, actors, party extras, screen, timer) persists in `rpgExtra.mvEngine` across page reloads; the plugin/engine sources are written as files (`assets/plugins/`, `assets/engine/`, `externalizePluginLibrary`) that the player fetches at startup (`loadPluginFiles`), keeping them out of `mwgp.json` (Karryn: 26 MB -> 11 MB), and the server gzips manifests and text assets; the runtime's `introspect()` also lists every call it skipped loudly (`warned`), which the browser harness prints per game; switches/variables/map/player stay on `GameState` via the shim built-ins. Engine behaviour that needs the unloaded UI/scene layer fails loudly). One runtime,
`src/player/rgss-script.js` (served at `/rgss-script.js`, dynamically imported by
`startMwgPlayer` so `prepareEventCommands` stays importable from Node), runs both dialects.

- **XP (`tools/convert-rgss.js`)** — Call Script (355/655) and Conditional Branch > Script
  (111 type 12) are transpiled per unique snippet by `tools/rgss-snippet.mjs` (vendored Ruby2JS
  self-host) into `{ script, js }` commands / `{ if: { script: { source, js } } }` conditions.
  A snippet that fails keeps `error` and stays a loud warning. The game's **own** Ruby library
  (`Data/Scripts.rxdata` + `PluginScripts.rxdata`, read in pure Node by `tools/rgss-scripts.mjs`)
  is handled by `tools/rgss-library.mjs`: each script is parsed alone, top-level definitions
  (`def`, `class`/`module` incl. all reopenings, constants, and `def`s inside `module Kernel`)
  become *units*; the units reachable from the event snippets (breadth-first, `--library-depth`,
  default 3; `--no-library` skips) plus RGSS's engine classes (`Game_Map`, `Game_Event`, ...) are
  transpiled **one unit at a time** and stored as `manifest.rubyLibrary` (`units`, `methods` =
  every `def` name, `interpreter`, `failed`). A unit that will not convert costs only itself.
  Whole-library bundling (`tools/bundle-rgss-scripts.mjs`) does not scale and is not used here.
- **MV/MZ (`tools/convert-mv.js`)** — scripts are already JS: `{ script, mv: true }` and
  `{ if: { script: { source } } }`; only a syntax `error` is recorded. The manifest is written
  compact (pretty-printing exceeded V8's string limit on the biggest project).
- **Runtime** — free identifiers resolve through a `with` Proxy: built-ins (`$game_switches`,
  `$game_variables`, `$game_self_switches`, `$game_map/player/party/temp/system/screen`,
  `Graphics`, `Audio`, `rand`; the MV globals in `dialect: 'mv'`), then library units loaded
  lazily on first use, then a stub that warns once and returns undefined. Built-in objects
  borrow methods the shim lacks from the game's own class (`Game_Event#setTempSwitchOn` runs on
  the shim). Snippets run as bodies of the game's `Interpreter`/`Game_Interpreter`, so bare
  calls to its methods compile to `this.<name>()` (`selfCallsFilter`).
- **Ruby2JS quirks that shape the shim** — `?`/`!` are stripped from names (`can_add?` →
  `can_add`); a paren-less zero-arg call on a receiver is a *call* iff the game `def`s that name
  (`RgssCalls`, fed by `setKnownMethods`) and a *property read* otherwise, so built-in readers use
  `reader(name, fn)` to expose the same shape; filter order matters (`RgssCalls` ends a node's
  chain, so it goes last; `Return` adds implicit returns); `.call(x)` compiles to `f(x)`.
- **Library-load fixes** — a `GameData` registry that loads empty (the game's top-level `register(...)` calls are not
  part of any unit) answers `try_get` with a permissive all-false record rather than nil; Ruby2JS's exported private
  helpers that take parameters (`get name() { return name.call(this) }`) are exported as the function itself
  (`fixExportedGetters`). Both are generic and live in `rgss-script.js`.
- **Ruby runtime coverage found by the soak** — `installRubyCore` adds the Array/Hash/Object methods JS lacks
  (`each_index`, `each_slice`, `clear`, `first/last`, `instance_variable_get/set`, `respond_to`, `send`, ...); shim
  display/value classes answer names the game itself `def`s as callable readers (`callableAttributes`, same
  call-vs-property rule as `reader`); a shim object that borrows the game's methods first runs the game's constructor
  once to seed its instance variables (`seedInstanceVariables`, e.g. `Game_Screen`'s `@tone`); `for (x of hash)`
  loops go through `__each` (a plain object yields `[key, value]`); `Game_Picture` is an engine class the converter
  keeps.
- **Async lift (`tools/rgss-async.mjs`, run by `convert-rgss.js` after the library is built)** — Ruby loops that wait
  on frames (`loop { Graphics.update; Input.update; ... }`, whole `pbMain` scenes) cannot finish in synchronous JS.
  With acorn the converter finds, by callee *name* across every library unit and Call Script snippet, the functions
  that (transitively) reach `Graphics.update`/`Graphics.wait`, marks them `async` and wraps their calls in `(await ...)`;
  snippets that await are flagged `async: true` and run as async function bodies. The runtime's `Graphics.update`
  returns the next animation frame (a loop that spins on it without yielding trips a counter and errors loudly), and
  `Input.update` latches key edges for `trigger?`. Not lifted (reported as "left sync"): constructors, getters/setters
  and calls inside anonymous callbacks. Same pass repairs two Ruby2JS output bugs: Ruby's modulo (`__mod`, sign of the
  divisor) and block-scoped locals that Ruby uses afterwards (`begin/rescue`, `if`, loops: hoisted `let`). The lift is
  name-based, so generic names (`update`, `refresh`) inflate the async set (about 1,400 functions in Void); awaiting a
  synchronous function is harmless. The same pass also lowers: `x.map.with_index(fn)` -> `x.map(fn)`, `typeof f()`
  (`defined?(f)`) -> `typeof f`, and `for (x of hash)` loops to `__values`/`__each` (a single loop variable the body never
  indexes is a values loop; otherwise `[key, value]` pairs).
- **The game's own data and files** — `tools/rgss-data.mjs` exports every `Data/*.dat` (Marshal) as
  `assets/ruby-data/<file>.json` (`manifest.rubyData`; objects keep `{ class, ivars }`, a Hash is `{ $map: [...] }`) and a
  listing of the project's files as `manifest.fileIndex`. At startup the player fetches the data (`loadRubyData`); the
  runtime rebuilds instances of the game's own transpiled classes (`decodeRuby`), fills every `GameData` registry whose
  class has `static DATA_FILENAME` (so `GameData::Species.get(...)` works) and answers `load_data("Data/x.dat")` from it;
  `File.exist?`, `Dir.exist?`, `Dir.glob`, `Dir.entries`, `FileTest.*` read the file index (case-insensitive, read-only;
  a built-in `File`/`Dir`/`FileTest` falls back to the game's own reopened module for names it lacks). Instances of
  the game's classes answer names the game `def`s anywhere as callable readers (`gameInstance`/`gameClass`), matching the
  call-vs-property rule. Registry `get` failures rethrow as `Error` with a stack.
- **Display layer** — `Bitmap` is real where a canvas exists (`CanvasBitmap` in `rgss-classes.js`): `fill_rect`, `blt`,
  `stretch_blt`, `draw_text` (font, alignment, shadow/outline), `get_pixel`/`set_pixel`, `text_size`, gradients; a
  bitmap made from a file loads its image asynchronously (`width` reads 0 until it is in; RGSS loads synchronously,
  which a browser cannot). `File.read` answers from `manifest.textFiles` (small text files the converter embeds:
  bitmap-font descriptors, tables) and `Fonts/` is copied to `assets/fonts` (`convert-auto.js` keeps that loose folder
  beside the archive). **Sprites and Planes are drawn**: `src/player/rgss-screen.js` composites every live, visible
  Sprite/Plane (z-order, viewport clipping and origin, `src_rect`, `ox/oy`, zoom, angle, mirror, opacity) onto a
  canvas overlaid, letterboxed, on the game canvas while a script scene runs (`data-rgss-screen`); `dispose` really
  removes them, and a script that fails disposes what it created (`disposeSince`). Not drawn yet: Window (Essentials
  builds its windows from Sprites, so text and boxes mostly work through Bitmaps), tone/color/flash, blend types.
- **More converter lowerings** — Ruby's `@x` becomes `this._x`, which collides with a method `_x`: such ivars are
  renamed `this._$x`; `x&.name` (a property read) becomes a call for names the game `def`s, like `x.name`; `list.map(&:to_i)`
  (emitted as `map("to_i")`) becomes an arrow.
- **Interleaving** — lifted scripts wait on frames while others run, and `current`/`queue` are shared: each wait
  (`nextFrame`) captures the caller's context and restores it on resume (`resumeAfter`); conditions and
  operands restore theirs when they finish.
- **A game's own menu scenes** — the player has no entry point into them: an opt-in `?gamemenu=1` that ran Essentials'
  pause menu by class name was removed as framework-specific (`docs/removed-shims.md`); a generic entry needs the
  engine's own menu call. What that experiment found, and the generic fixes it produced: it failed because the save state was never built:
  `$player.money`, the bag, the party and the rest are created by the engine's own start-up (`Game.start_new`), which
  this runtime does not run, so `$player` is an empty shim object. Building that state (running the game's
  initialization, or seeding `Player`/`PokemonBag`/`PokemonGlobalMetadata` from the shipped `Data/*.dat`) is the next
  step for Void's menus and battles. Two findings from reading `Game.initialize`/`Game.start_new`: (1) Ruby2JS emits a
  Ruby global assignment inside a method as a local (`let $game_temp = new Game_Temp()`), so the game's own start-up
  cannot publish its globals; the lowering pass would turn `let $name = ...` into a plain assignment (the scope proxy
  stores it). (2) The state is registered by *top-level* calls in the game's scripts (`SaveData.register(:player) { ... }`,
  `Events.on... += proc`, `MultipleForms.register`), which the per-definition library never converts: the library needs
  a "boot" unit that keeps a script's top-level statements, in script order, and runs them before the first scene.
  **Built (save-data half):** `indexScripts` (tools/rgss-library.mjs) turns every top-level
  `Const.register(:id) do save_value { }; load_value { |v| }; new_game_value { }; ensure_class :X end` block into a Ruby
  hash of lambdas (`BootValue_<id>`, `rubyLibrary.boot`), always in the library with what it references. At first
  script use the runtime (`ensureBoot`, rgss-script.js) creates each value (`new_game_value`) or rebuilds it from the saved
  state and hands it to `load_value` (which assigns the game's global: `$bag`, `$PokemonGlobal`, `$stats`, ...); values
  the runtime already stands in for (`$game_switches`, `$game_map`, ...) are skipped. After every script the values are
  written back (`snapshotBoot`: class name + fields, references by id) into `rpgExtra.rgss.boot`, because every map change
  reloads the page. Void: all 17 registrations apply: `$player` is a real `Player` (money 3000 from the shipped
  `Metadata`), `$bag` a `PokemonBag`, `$PokemonGlobal` the real metadata. Getting there took generic fixes to Ruby's
  object model as Ruby2JS emits it (all in the converter's lowering pass, `tools/rgss-async.mjs`, or the Ruby-source
  rewrite `tools/rgss-initialize-alias.mjs`): `alias new old` + a redefinition (any method, `initialize` included) keeps
  the original as `new` (constructors call `super` first); `extend`/`include` no longer override the class's own
  methods (`__mixin`); an explicit setter `def x=` (emitted `set _x`, recursing) is named `x`; `x.name += 1` /
  `name()++` (assignment to a call, which also made nine units unparseable and so skipped by every lowering) become
  property updates; a bare identifier naming a zero-parameter library function becomes a call; `Klass.keys[0]` and
  `hash.keys/values` work. The library horizon (`--library-depth`) is now 8 (about 720 units, 20 MB manifest for Void).
  Later fixes in the same family: the call filter (`RgssCalls`) now also does the receiver-less self-call rewrite, because
  a second filter ahead of it ended the chain and the paren-less zero-argument heuristic never ran inside any class with
  methods (`Graphics.update;` stayed a property read); `def self.x` with no parameters becomes a method, not a static getter;
  a receiver-less call to an inherited instance method inside a class is `this.name()` (`methodOnlyNames`);
  constructors: `this` assignments ahead of `super(...)` move after it, and a derived constructor that never calls
  `super` gets `super()`; `repairCallAssignments` runs before the syntax check so a unit no longer falls back to the
  no-call-heuristic transpile. The pause-menu experiment then ran further (it builds its windows, sets
  a cursor rect, plays its open sound) and now stops on a memoized windowskin path (`SpriteWindow_Base`'s
  `MessageConfig.pbGetSystemFrame()`) coming back nil at a specific point in the real menu flow, though it returns the
  correct string when called standalone — not yet root-caused (see next item's correction). Beyond that its command
  windows are Ruby `Window` subclasses that are neither drawn nor driven by the inert `Window` shim, so it needs a
  real Window (skin, contents, cursor, `index`) next.
  **Correction (superseding "the async lift only follows `obj.name()` ... while bare and `this.` calls follow any
  async name" above)**: that was a real bug, not a feature — `this.foo()` can reach as many different classes as
  `obj.foo()` can, so it needs the same full-agreement (`strong`) requirement, not the lenient one bare global calls
  get. Without this, one unrelated class's legitimately-async `foo` silently made every *other* class's synchronous
  `this.foo()` await a value that was never a promise — this broke a Ruby setter (`pokemon=`) that can't be `async` in
  JS, which received a `Promise` instead of a string. Fixed in `rgss-async.mjs` (`calleeKind(...) === 'bare'` gates
  the lenient path now). Confirmed by tracing a real false-positive chain (`icon_filename_from_pokemon` →
  `icon_filename` → `check_egg_graphic_file` → `get_species_form`, none of which touch anything blocking) back to
  fully synchronous. Async count dropped from ~900 to ~730 functions.
  **Second fix, same investigation**: Ruby's `self.class`/class-variable memoization idiom (`this.constructor._cache
  ||= ...`, from `@@x` or module-level `@x`) was colliding across *every* module in the game, because a plain `{}`'s
  `.constructor` is JS's shared `Object`. Each module's `__self` now gets `Object.defineProperty(__self, 'constructor',
  { value: __self, enumerable: false })` so this state is scoped per module (`moduleSelfEdits` in `rgss-async.mjs`).
  **Also found and fixed**: the "own field is read as a call" wrapping (`sprite.opacity()`) applied to *any* key the
  game defines a method for anywhere, including underscore-prefixed ivar fields (`this._curframe`) that happen to
  share a name with an unrelated method elsewhere — silently turning a plain string field into a callable wrapper.
  Guarded with `!key.startsWith('_')` in all three call sites (`rgss-classes.js`'s display-object proxy and value-class
  `callable()`, `rgss-script.js`'s `gameInstance`/`callableAttributes`).
  **Root-caused and fixed**: the windowskin-nil bug traced to `callableAttributes` (`rgss-script.js`, wraps the shim's
  own `Bitmap`/`Sprite`/`Window`/etc. classes) checking the library-wide `definedMethods` set **directly**, bypassing
  the `callableMethods` filter used everywhere else, and with **no `value !== undefined` guard at all** — so a key some
  *entirely unrelated* class happens to define (`[]=`, from a hash-like class like `HandlerHash`/`Game_Switches`) turned
  a genuine absence on the shim instance into a real callable `() => undefined`. `typeof x === 'function'` then reads as
  "yes, `[]=` exists here", and `gameInstance`'s set trap (added earlier this session for `options[name] = value`
  index-assignment) redirected an ordinary field write (`this._curframe = ...`) through it instead of storing the
  value — silently discarding it. Fixed: `callableAttributes` now uses the same `callableMethods` set as the other
  call sites (not the raw `definedMethods`), and `[]`/`[]=` are excluded from `callableMethods` entirely (Ruby
  operator names, already handled by their own dedicated redirects; letting them also match the generic "does this
  look like a method" checks was never sound given the set is library-wide, not per-class). A first version of this
  fix also added a `value !== undefined` guard to `callableAttributes`, matching the other call sites — that broke
  call-style access to a genuinely-unset field (`sprite.bitmap()` before any bitmap is assigned must still work,
  returning a callable `() => undefined`), caught by the soak regression and reverted; the `callableMethods` exclusion
  alone is sufficient. Confirmed fixed
  by retest: `SpriteWindow_Base` now correctly finds and applies its windowskin. The pause menu gets substantially
  further after this (draws its window, evaluates menu-item availability) before hitting the next gap, an incomplete
  Ruby `alias new old` (a **plain** alias, no redefinition follows — e.g. `PokemonBag`'s `alias can_remove? has?`) that
  `resolveInitializeAliases` was wrongly treating like the shadow-and-override idiom, destructively renaming `has?` to
  `can_remove?` and losing the original name; it now only renames when a redefinition of `old` genuinely follows, and
  otherwise leaves `old` untouched and emits `new` as a thin forwarder (`def new(*a); old(*a); end`, positional-only:
  Ruby2JS's self-host build mishandles a trailing `&block` param by popping it off the splat, corrupting a plain call).
- **Where Void stops** — both versions run the character select and customization scenes without a runtime error in
  the soak (7-20 dialogues) and the character select is visible (trainer sprites over the scene background; the
  text drawn with the bitmap font has not been checked by eye); the pause menu (opt-in, see above) gets further than
  before but still fails before any command can be picked. Everything beyond that (the Pokémon battle system, the
  real menus) is untested. A person playing is the next real check.
- **Timing** — snippets that do not wait on frames are synchronous; their dialogue/balloons/animations are queued and
  awaited in order after the snippet. Code that waits on frames is lifted to async (see above). Conditions and
  Control Variables scripts stay synchronous (never lifted). Not covered: move-route script steps.
  VX converts end to end (`tools/rgss-vx.mjs` tables, synthetic VX/XP fixtures in `npm test`) but ships
  `database: {}` (flat VX stats unmapped: duel-fallback battles, minimal menu) and empty tile-passage
  flags (no database source: movement unclamped), and no local VX game has been played through yet.
  Ace converts end to end the same way (`tools/rgss-ace.mjs`, synthetic Ace fixture in `npm test`,
  `.rgss3a` archives extract): it shares VX's event numbering (assumed, unverified against a real Ace
  project — no local Ace game or RGSS3 binary exists yet) but reads its own `Tilesets.rvdata2` passage
  flags and per-map tileset ids, so movement is clamped where VX's is not; database and real-project
  playthrough stay open.
- `npm test` runs a made-up game (Interpreter + Game_Event + module + helper `def`) through the
  whole pipeline, plus an MV script; both real Pokémon Void games transpile 100% of event
  scripts and ~96% of library units (`compatibility.scripts`, `rubyLibrary.failed`).

### Why `4MWG/` exists

`4MWG/` (gitignored) holds notes on gaps in `mw_games` that this player currently works around
— e.g. autotile reconstruction, an event presentation seam for portraits/choices, map-transition
state, compatibility diagnostics. It exists to eventually upstream those into `mw_games` and
shrink the workarounds in `player-core.js`. Check it before changing autotile/event-presentation
code in `player-core.js`, and update it if a workaround is added or removed.

### Vendored transpilers (`transpilers/`, gitignored)

`transpilers/opal-master` and `transpilers/ruby2js-master` are full vendored copies of two
Ruby-to-JS transpilers. `opal-master` is still unused. `ruby2js-master` is not: its self-hosted
JS build (`demo/selfhost/ruby2js.js`, no Ruby needed at conversion time) is imported directly by
`tools/transpile-ruby.mjs`, `tools/transpile-rgss-scripts.mjs`, `tools/bundle-rgss-scripts.mjs`,
and `tools/rgss-call-filter.mjs` — the RGSS/Pokémon-Essentials-in-browser effort (see
`.remember`/session memory for status) runs Essentials' real Ruby scripts through it.

**This copy carries real patches, not pristine vendor code**, in
`lib/ruby2js/converter/{class,converter,def,hash}.rb` — fixes for gaps hit while bundling
Essentials' whole script corpus into one conversion (class-body `if`/`unless` modifiers e.g.
`alias foo bar unless method_defined?(:foo)`; a `$Range` runtime class with no iterator; a
`==` comparison on AST nodes that the self-host build compiles to JS reference equality instead
of structural equality; an implicit block parameter appended after a rest parameter). Rebuild
the self-hosted bundle after touching any of those files — `rake`'s own task for the specific
file doesn't work from this checkout (its shell command assumes bash `VAR=val cmd` syntax `sh()`
doesn't support here), so run the step it wraps directly instead:
```
cd transpilers/ruby2js-master
BUNDLE_GEMFILE="$PWD/Gemfile" bundle exec ruby demo/selfhost/scripts/transpile_bundle.rb > demo/selfhost/ruby2js.js.new
node --check demo/selfhost/ruby2js.js.new && mv demo/selfhost/ruby2js.js.new demo/selfhost/ruby2js.js
```
**`transpilers/` is `.gitignore`d, so none of this is version-controlled** — these patches
exist only on disk. Losing or resetting the directory silently loses them; there's no `git
status` signal that they're gone. Worth resolving (un-ignore this fork, or extract the patches
elsewhere) before relying on this further.

## Adding support for a new MV event command

Touch, in order: `convertCommand` in `tools/convert-mv.js` (translate the MV code into the
MWGP vocabulary, or extend the vocabulary itself), `buildCompatibilityReport`'s `supported`/
`partial` sets in the same file, the `allowed` set in `tools/validate-mwgp.js`, and — only if
the new command needs a scene callback rather than passing through to `mw_games`'s
`EventRunner` unchanged — `prepareEventCommands` in `src/player/player-core.js`, plus a row in
the routing table in `tools/test-smoke.mjs` so `npm test` covers the new route.
