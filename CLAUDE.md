# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

RPGM Player is a converter + local web player for RPG Maker games. It converts RPG Maker MV
projects into a portable JSON manifest format called **MWGP** (`mwgp.json`), then plays that
manifest in the browser against **`@datamoc/mw_games`** (imported as `mw_games`), an external
tile-game runtime library. This repo owns the MV→MWGP converter, the manifest format, and a
player built on `mw_games`'s primitives; it does not implement its own game engine or an
MV/RGSS emulator — `mw_games` is the runtime layer everything renders and runs through.

There is no build step, bundler, linter, or test suite. Everything is plain Node.js ESM
(`"type": "module"`, top-level `await` in the `tools/*.js` scripts) served as-is.

## Commands

```powershell
npm install
npm start                  # serves the launcher at http://127.0.0.1:4173 (port via RPGM_PORT)
npm run scan                # same detection logic as `start`, but prints the catalog as JSON and exits
npm run convert:mv -- "RPGM_versions\<project>" "MWGP_versions\<project>"
npm run validate:mwgp -- "MWGP_versions\<project>\mwgp.json"
```

`convert:mv` accepts `--copy-tilesets`, `--copy-characters`, `--copy-faces`, `--copy-pictures`,
`--copy-audio`, or `--copy-assets` (all of the above) to decode the corresponding RPG Maker
assets into the output folder; without any flag the manifest references the original `www`
folder in place and the player falls back to a placeholder tile sheet.

There is no automated test suite. `validate:mwgp` is the only correctness check that exists
today (structural checks on a generated manifest plus its event command tree); beyond that,
verify changes by running `npm start` and playing a converted project in the browser.

## Tooling discipline

Be conservative about `tools/`: only scripts with genuine reuse value live there
(converters, validators, checks run by `npm` scripts, diagnostics reused across
issues like `diag-sheets.mjs`). One-off probes and scratch scripts stay outside
the repo (e.g. under `/tmp`) — never committed, never deleted for the user, so
past verification stays re-runnable without cluttering the project. A substantial
inline or heredoc command is still a script: write it to a reusable file under
`/tmp` before executing it instead of leaving it only in shell history.

## Architecture

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
`public/` via dedicated routes instead — `/player-core.js` and `/pixi-core.js` read straight
from `src/player/`, and `/mwg.js` reads the prebuilt `mw_games` global bundle straight out of
`node_modules/@datamoc/mw_games/dist/mw_games.global.js`. Editing any of those files takes
effect on browser refresh with no compile step.

API surface: `GET /api/games` (catalog), `GET /api/mwgp/:id` (manifest JSON),
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
say, ask, wait, setSwitch, setVariable, addVariable, copyVariable, if, loop, breakLoop,
exitEvent, move, transfer, picture, erasePicture, movePicture, tintPicture, balloon,
animation, scroll, scrollMap, relocate, saveBgm, resumeBgm, me, menu, goto,
changeState, recoverAll, changeSkill, changeEquipment, changeProfile, sound,
stopSound, playBgm, fadeoutBgm, playBgs, fadeoutBgs, turn, screenFade, screenFlash,
screenTint, screenShake, changeGold, changeItem, changeWeapon, changeArmor, changeParty,
setTransparent, eraseEvent, script, pluginCommand
```

Party, gold and inventory counts have no home in `mw_games`' `GameState`
(switches/variables only), so the player carries them as its own `rpgExtra`
state through transfers and saves. `script`/`pluginCommand` have no RPGM-free
execution and degrade to a loud console warning, never silent success.

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
4. The players — `src/player/pixi-core.js`'s `prepareEventCommands` only needs to handle the
   commands that require a scene/renderer callback or JS-level control flow mw_games's fixed
   `EventRunner.step()` can't express on its own (`transfer`, `picture`, `erasePicture`,
   `movePicture`, `tintPicture`, `balloon`, `animation`, `scroll`, `scrollMap`,
   `relocate`, `saveBgm`, `resumeBgm`, `me`, `menu`, `goto`,
   `changeState`, `recoverAll`, `changeSkill`, `changeEquipment`, `changeProfile`,
   `sound`, `stopSound`, `playBgm`, `fadeoutBgm`, `playBgs`, `fadeoutBgs`, `turn`,
   `screenFade`, `screenFlash`, `screenTint`, `screenShake`, `changeGold`, `changeItem`,
   `changeWeapon`, `changeArmor`, `changeParty`, `setTransparent`, `eraseEvent`, `script`,
   `pluginCommand`, `loop`, `breakLoop`, `exitEvent`, `copyVariable`, a choice command with
   `branches`, a portrait-bearing `say`/`ask`); each is rewritten into a `call` closure the
   runner's own generic escape hatch supports. `loop` and `exitEvent` unwind via a thrown
   sentinel (`BreakLoopSignal`/`ExitEventSignal`) caught by `runLoop`/`runPage` respectively,
   since `EventRunner.run()` has no other way to stop a list mid-flight. The rest (`say`,
   `ask` without `branches`, `setSwitch`, `setVariable`, `addVariable`, `wait`, `move`, `if`)
   pass straight through to `mw_games`'s own `Rpg.EventRunner`, which already understands that
   shape natively. `prepareEventCommands` is exported so `tools/test-smoke.mjs` can drive it
   in Node with a stub scene and assert every non-native command routes to a scene method.
   `src/player/core.js` (the canvas fallback) instead re-interprets raw MV command codes
   itself and does not go through this vocabulary at all — it's a separate, simpler code path.

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
report, and `maps[]` — each map keeps the **raw MV map `data`** (the six-layer tile array, used
directly by both players) alongside `mwgEvents` (the converted event pages). `database` holds
the other raw MV database JSON files (actors, classes, skills, …) lowercased by filename,
mostly unused by the player today beyond `playerSprite` lookup.

### The two players

`public/player.js` is the entry point: it loads the `mw_games` global bundle, fetches the
manifest for `?id=`, then tries the real player and falls back on failure:

- `src/player/pixi-core.js` (`startMwgPixi`) — the real player, built entirely on `mw_games`
  primitives (`Game`, `Scene2D`, `TileMap`, `SpriteSheet`, `WindowStack`, `MessageBox`,
  `Rpg.GameState`, `Rpg.EventRunner`, `Rpg.GridMover`, `Rpg.activePage`, `SaveSystem`, `Input`,
  `Audio`, `Resources`). It reconstructs RPG Maker's A1–A4 autotile sheets into static atlases
  client-side (`buildAutotileSheet` + the `FLOOR_AUTOTILE_TABLE`/`WALL_AUTOTILE_TABLE` shape
  tables — mirrored in `4MWG/extracts/rpgm-autotiles.js` as a reference for upstreaming this
  into `mw_games` itself), drives events/dialogue/pictures/sound through the vocabulary above,
  and carries `GameState` across map transfers by round-tripping through `SaveSystem` and a
  full page reload (`location.href` with `?map=&x=&y=`) rather than an in-memory scene swap.
  `F5`/`F9` save/load slot 1 the same way.
- `src/player/core.js` (`MwgPlayer`) — a minimal `<canvas>` 2D fallback with no asset
  dependency (flat-colored tiles), used only when the Pixi/mw_games 2D runtime is unavailable.
  It duplicates a small, simplified slice of MV command interpretation directly rather than
  sharing code with the converter or the Pixi player.

### Event scripts (Ruby in XP/VX/Ace events, JavaScript in MV/MZ events)

Game-agnostic: nothing in the converter or player names a particular game. One runtime,
`src/player/rgss-script.js` (served at `/rgss-script.js`, dynamically imported by
`startMwgPixi` so `prepareEventCommands` stays importable from Node), runs both dialects.

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
- **Timing** — snippets are synchronous; dialogue/balloons/animations are queued and awaited in
  order after the snippet. Library code that needs a real blocking wait (`Graphics.update`
  loops, message windows) cannot run and falls onto the warning path — a Web Worker with
  `Atomics.wait` would be the way to lift that. Not covered: VX/Ace *converters* (only XP
  `.rxdata` exists), move-route script steps.
- `npm test` runs a made-up game (Interpreter + Game_Event + module + helper `def`) through the
  whole pipeline, plus an MV script; both real Pokémon Void games transpile 100% of event
  scripts and ~96% of library units (`compatibility.scripts`, `rubyLibrary.failed`).

### Why `4MWG/` exists

`4MWG/` (gitignored) holds notes on gaps in `mw_games` that this player currently works around
— e.g. autotile reconstruction, an event presentation seam for portraits/choices, map-transition
state, compatibility diagnostics. It exists to eventually upstream those into `mw_games` and
shrink the workarounds in `pixi-core.js`. Check it before changing autotile/event-presentation
code in `pixi-core.js`, and update it if a workaround is added or removed.

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
`EventRunner` unchanged — `prepareEventCommands` in `src/player/pixi-core.js`, plus a row in
the routing table in `tools/test-smoke.mjs` so `npm test` covers the new route.
