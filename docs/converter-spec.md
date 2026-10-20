# MWGP converter specification

How an RPG Maker project becomes an MWGP manifest (`mwgp.json`) that the
browser player runs. Implementation: `tools/convert-auto.js`,
`tools/extract-rgssad.js`, `tools/convert-mv.js`, `tools/convert-rgss.js`,
`tools/rgss-*.mjs`, `tools/audio-index.mjs`, `tools/validate-mwgp.js`.
Format background (LCF, Marshal, RGSSAD, MV JSON) lives in
`notes/rpgmaker-docs/`; pinned third-party references in
`notes/rpgmaker-docs/downloads/`.

## 1. Pipeline overview

```
RPGM_versions/<game>/  --convert-auto-->  MWGP_versions/<game>/
   MV/MZ    -> web build: the game's own files + nwjs-host.js, files.json, mwgp-web.json   (section 3a)
   XP/VX/Ace -> {mwgp.json, assets/}  --validate-mwgp--> ok / errors
```

- `convert-auto.js` converts every subfolder of a source tree (symlinked or
  junctioned folders included). Detection per folder, in order: extracted RGSS
  (`Data/*.rxdata|rvdata|rvdata2`) → `convert-rgss.js`; MV/MZ
  (`www/index.html` or `index.html`) → `build-web.js` (with `--mwgp`:
  `convert-mv.js --copy-assets`); raw archive (`Game.rgssa|Game.rgssad|Game.rgss2a|Game.rgss3a`) →
  `convert-rgss.js` extracts it to a temporary tree, including beside-archive
  `Audio/`, `Fonts/`, `Game.ini`, and `*.sf2` sidecars; else skipped with a reason.
  `--skip-existing` leaves folders that already have `mwgp.json` or
  `mwgp-web.json`.
- **Parallel runs**: each game converts in its own process, at most `--jobs N`
  at a time (default: the number of cores; lower it when memory is short — an
  RGSS library conversion peaks at a few GB). Each game gets a progress bar on
  stderr (redrawn in place on a terminal, one line per status change and per
  10% otherwise); stdout stays the JSON summary (`converted`, `skipped`,
  `failed`, per-game `results` with the converter log). Five local games take
  about 1m45 in parallel instead of about 10 minutes one after the other.
- **Progress protocol** (`tools/progress.mjs`): with `MWGP_PROGRESS` set, a
  converter writes `@@progress {"done","total":100,"label"}` lines on stderr.
  It splits 100 points into phases weighted by their usual share of a run
  (MV: maps 20, asset decoding 62, …; RGSS: Ruby library 50, maps 10, asset
  copy 10, …); a phase made of items (maps, decoded files, library units
  weighed by source size) advances per item, so bars never move backwards.
  Without the variable every call is a no-op.
- Every converter only ever emits the **MWGP event vocabulary** (section 4);
  anything without an equivalent becomes an explicit `unsupported` marker, never
  a silent drop. `validate-mwgp.js` rejects any manifest carrying a command key
  outside the vocabulary, so converter and validator cannot drift.
- `npm test` (`tools/test-smoke.mjs`) converts synthetic XP/VX/Ace/MV fixtures
  end to end and asserts the mappings below; the browser harness
  (`tools/test-browser.mjs`) boots every converted project in Chromium.

## 2. Archive extraction (`extract-rgssad.js`)

Unpacks supported `Game.rgssa`/`Game.rgssad`/`Game.rgss2a`/`Game.rgss3a` archives into a plain tree. Follows mkxp's
`src/rgssad.cpp` (pinned tree in downloads).

- Header `RGSSAD\0` + version byte: **v1** (XP/Essentials, also VX `.rgss2a`)
  is a front-to-back stream; **v3** (Ace `.rgss3a`) is an entry table with
  absolute payload offsets, fields XORed with one constant table key
  (`seed*9+3`), names cycling the key bytes, offset 0 ending the table.
- Payload decrypt (both versions): payload XORed against the little-endian
  bytes of the entry key, key advanced `(*7+3)` every 4 bytes.
- Only versions 1 and 3 are supported; anything else fails loudly.

## 3a. MV/MZ web build (`build-web.js`, the default)

MV/MZ games are browser JavaScript; nw.js only adds a few host APIs. The web
build therefore converts nothing: it is the game's own engine, plugins and
files, playable in any browser from any static web host.

- **Web root**: `www/` (MV) or the project root (MZ), the folder holding
  `index.html` next to `data/System.json`. Copied as-is, encrypted
  `.rpgmv*`/`._` assets included (the engine decrypts them itself). A native
  `save/` folder is left out: saves live in the browser.
- **`index.html`**: `<script src="nwjs-host.js">` is inserted first in
  `<head>`; every other `<script src=...>` becomes `data-mwgp-src=...` (other
  attributes kept, inline scripts untouched), which the host loads in order.
- **`nwjs-host.js`** (from `src/web/`): the generic nw.js host layer (player
  spec section 10).
- **`files.json`**: the sorted list of the game's files (paths relative to the
  web root). The host answers `fs.existsSync`/`readdirSync`/`statSync` from it.
- **`mwgp-web.json`**: `{ format: "MWGP-web", version: 1, title, entry:
  "index.html", host: "nwjs-host.js", source: { engine, projectName, builtAt,
  files } }`; the launcher lists folders carrying it.
- **Rebuilds** copy only files whose size or date changed (`index.html` is
  re-patched each time) and delete files the game no longer ships (from the
  previous `files.json`). A previous MWGP conversion in the same folder
  (`mwgp.json` with `format: "MWGP"`, `assets/`) is replaced.
- **Progress**: copying is 90 of the 100 progress points, one tick per file.

## 3. MV/MZ conversion to MWGP (`convert-mv.js`, `convert:auto --mwgp`)

Kept for the MWGP player and its tests; `convert:auto` uses it only with
`--mwgp`.

Input: an MV (`www/`) or MZ project; engine kind detected from the project
files. Output: `mwgp.json` + `assets/` (decoded images/audio).

- **Asset decoding** (`decodeTree`): `.rpgmvp/.rpgmvo/.rpgmvm` (MV) and MZ
  `._` variants are de-obfuscated by XORing the first 16 bytes against the
  project's key from `System.json`, then stripping the 16-byte header; the rest
  is plain PNG/OGG/M4A. Header-only dimension reads (`pngDimensions`) go
  through the same decode path so no second scheme can drift.
- **Copy flags**: `--copy-tilesets`, `--copy-characters`, `--copy-faces`,
  `--copy-pictures`, `--copy-audio`, or `--copy-assets` (all). Without flags
  the manifest references the original `www` tree in place (`assets.kind:
  "source"`); `--copy-pictures/--copy-audio` copy only assets referenced by
  converted events (tracked while converting commands).
- **Maps**: raw MV map `data` kept verbatim (six-layer tile array) in
  `maps[].data`, plus converted `mwgEvents`.
- **Database**: raw MV database JSON lowercased by filename
  (`actors`, `classes`, `skills`, …), used for battles, menus, `playerSprite`.
- **Events** (`convertCommands`/`parseBlock`): rebuilds nesting from MV's flat
  indent-delimited lists — `if`/`else` (111/411/412), loops (112/113/413),
  choices with per-choice/cancel branches (102/402/403/404) — and inlines
  common-event calls (117, depth-limited to 8). Emits only section-4 commands.
- **Compatibility report**: every MV command code seen is classified
  `supported`/`partial`/`unsupported` into `compatibility.commands`, a
  data-driven priority list for what to convert next.
- **Engine + plugin library** (`tools/mv-plugins.mjs`): the project's own
  plugin JS and engine logic files are written as files (`assets/plugins/`,
  `assets/engine/`, listed in `manifest.pluginLibrary`) and fetched at
  startup, keeping them out of `mwgp.json`. A plugin ships when (a) it defines
  a name an event script uses, (b) it handles a plugin-command word the events
  use — it hooks the dispatch (`<any alias>.prototype.pluginCommand =` or
  `PluginManager.registerCommand(`) and names the word as a whole token
  anywhere in its source, which covers words built at run time since plugins
  document their commands in their `@help` header — or (c) an MZ 357 command
  names it; selection then closes over what the chosen plugins reference.
  `pluginLibrary.commandHandlers` maps each command word (lowercased) to the
  plugins that handle it.
- **Plugin commands**: 356 keeps `{ raw, name, args }`; 357 also keeps
  `plugin` and the `params` object. The player runs them through the game's
  own plugin code: MV's `Game_Interpreter#pluginCommand` chain, or the command
  the named MZ plugin registered (`PluginManager.callCommand`).
  `compatibility.plugins` rates each command word `partial` with `handledBy`
  when a shipped plugin handles it (the plugin may still reach the unloaded
  scene/window layer) and `unsupported` otherwise. MV `script` commands run
  through the bounded MV globals shim.
- **Character frames**: from the engine's own rule
  (`ImageManager.isBigCharacter`: `$` prefix = single 3×4 sheet, `!` prefix =
  object/no-shift), cell size = IHDR dimensions ÷ grid. Sheets are not always
  48px cells — the player must slice from this table.
- **Title** (`titleScreen`): stock `title1`/`title2` names, `drawTitle`,
  `commandOffset`, `titleBgm`, per-command flags from
  `System.json`/`titleCommandWindow`. The converter decodes title directories
  when either `img/titles1` or `img/titles2` exists, independently of the
  other asset-copy flags. Plugin-drawn titles are not reproduced, and no
  plugin's parameters are read by name.
- **Screen size** (`display.width/height`): `System.json` (MZ's
  `advanced.screenWidth/Height`), else the engine default 816×624.
- **Audio** (`tools/audio-index.mjs` + section 6): `audio.index` maps each
  kind's track name to the extension that exists; `audio.system` holds engine
  tracks from `System.json` (title/battle BGM, jingles, system sounds,
  vehicles); `audio.soundfont` names the project's own `.sf2` (gitignored
  output only; shared fonts must be vetted — see the player spec).

### Missing asset diagnostics (MV/MZ)

`tools/asset-usage.mjs` checks explicit map, event, common-event and system
asset references against the source files, including encrypted MV/MZ extensions.
The manifest's `compatibility.assets` records each missing path, severity,
reason and reference locations. This check runs independently of asset-copy flags.

References only on maps labelled `test` (case-insensitive, as a separate word,
including `tests` and `testing`) are warnings. Disabled map autoplay/battleback
settings and vehicles without an initial map are also warnings for inactive
references. The configured start map always counts as gameplay. Any gameplay
reference to the same missing asset takes precedence over its test references.
Common-event calls propagate their caller's classification, including nested
calls; autorun/parallel events are checked independently. Uncalled common events
remain potentially used because scripts can invoke them dynamically.

This is static analysis, not proof of reachability: it does not resolve arbitrary
script/plugin asset paths or prove that a non-test map is unreachable. Potential
gameplay uses remain errors. A test label is a documented heuristic, not a reason
to remove a map or supply replacement artwork.

`convert:auto` retains warning lines in its JSON log and reports warning-only
runs as `converted with warnings` (`withWarnings` in the summary), separately
from `converted with errors`. Other existing conversion difficulties retain
their error classification.

## 4. The MWGP event vocabulary (contract)

`say ask inputName inputNumber messageOptions wait setSwitch setVariable
addVariable modifyVariable copyVariable if loop breakLoop exitEvent
commonEvent move transfer picture erasePicture movePicture tintPicture
balloon animation animationAt shop scroll scrollMap mapSettings relocate
saveBgm resumeBgm me menu goto vehicleLocation enemyAppear changeEnemyHp
changeEnemyMp changeEnemyTp changeEnemyState enemyTransform changeState
recoverAll changeSkill changeEquipment changeProfile changeHp changeLevel
changeClass sound turn screenFade screenFlash screenTint screenShake
changeGold changeItem changeWeapon changeArmor changeParty setTransparent
routeThrough routeImage routeOption eraseEvent playBgm fadeoutBgm
playBgs fadeoutBgs stopSound battle weather gameOver script pluginCommand
unsupported`

- `unsupported: { code, kind }` is the loud-fallback marker (unknown branch
  kinds, unmappable operands, unhandled commands): the player warns and
  continues with the next command.
- `if` conditions: `switch`, `variable` (`atLeast` or `operator` + `value` /
  `compareVariable`), `script: { source, js }`, player-state shapes
  (`partyMember actorSkill actorState facing eventFacing gold item weapon
  armor actorName actorClass actorWeapon actorArmor vehicle unsupported`).
  MV/MZ Conditional Branch variable operands pass through in the shipped
  engine's editor order — `params[4]`: 0 `eq`, 1 `gte` (emitted as the
  `atLeast` form), 2 `lte`, 3 `gt`, 4 `lt`, 5 `neq` (verified against
  `rpg_objects.js` v1.6.2 and `rmmz_objects.js`; the VX/RGSS order, `gte`
  first, belongs to the RGSS converter, not here).
- `modifyVariable` operands: `value`, `random`, `variable`, `gameData`
  (`itemCount weaponCount armorCount playerX playerY partyMember mapId
  partySize gold`), `script`.
- `pluginCommand: { raw, name, args, plugin?, params? }` (`plugin`/`params`
  from MZ 357 only).
- Labels (118) split page lists into `{ story: { passages } }`; jumps (119)
  become `{ goto }`. Battle (301) owns its Win/Escape/Lose blocks (601–604).

## 5. XP/VX/Ace conversion (`convert-rgss.js` + `rgss-*.mjs`)

Input: an extracted RGSS tree (`Data/*.rxdata` XP, `*.rvdata` VX,
`*.rvdata2` Ace), a project directory containing `Game.rgssa`/`Game.rgssad`/`Game.rgss2a`/
`Game.rgss3a`, or one of those archive files directly. Raw archives are
decrypted and unpacked into a temporary tree before conversion; `Scripts.rxdata`,
`Scripts.rvdata`, `Scripts.rvdata2`, and `PluginScripts.rxdata` are then read,
inflated, and transpiled into the manifest's Ruby library. Marshal decoding via `@datamoc/mwg/rpg`
(`decodeMarshal`); `{ class, ivars }` objects, `Hash` as `{ $map }`.

- **Engine gates**: `isAce` (`System.rvdata2` exists) / `isVx` (`System.rvdata`)
  / XP otherwise; VX and Ace share event numbering (`isVxLike`), Ace reads its
  own `Tilesets.rvdata2` passage flags. Waits divide by 20 on XP (stock
  `command_106` waits `n*2` frames at 40 fps, so `n` is in 1/20 s; screen
  durations likewise) vs 60 on VX/Ace (stock fps); tile size 32.
- **Maps**: XP 6 tile layers passthrough; VX 3 layers land on MV layers 0/4
  (shadow mask dropped loudly); passage/priority/terrain tables passthrough
  (XP) or empty with a loud warning (VX: no database source).
- **Tilesets**: XP table (names, autotile names, `passages`, `priorities`,
  `terrain_tags`); VX one global sheet set from `Graphics/System`
  (`rgss-vx.mjs`); Ace per-database-tileset entries (`rgss-ace.mjs`).
- **Events**: XP branch types verified against the shipped
  `Interpreter_Commands#command_111` (0 switch, 1 variable with all six
  operators, 2 self-switch via synthesized `self:<map>:<event>:<ch>` keys, 6
  facing, 7 gold, 12 script); movement routes (209/509, XP) execute as player
  movement for targets −1/0; panorama/fog/battleback (204), pictures
  (231/232/234/235), screen tone/flash/shake (223–225, /20 durations), BGM/BGS
  (241/242/245/246, memorize/restore 247/248 as `saveBgm`/`resumeBgm: "both"`),
  ME/SE (249/250/251), gold (125), items/weapons/armor/party (126–129 →
  `changeItem`/`changeWeapon`/`changeArmor`/`changeParty`, same parameter
  layout on every RGSS engine), command_dummy no-ops (313, 315–319). Control
  Variables "Other" (122 kind 7) maps index 0/1/2 to `mapId`/`partySize`/`gold`
  as stock RGSS does. VX divergences (202 vehicles, 205/505 routes, 212–214
  animation/balloon/erase, 230 waits, 236 weather enum, 302/605 shops, 303
  names) convert for real; Ace shares VX numbering.
- **Event scripts** (Ruby 355/655, branch type 12): transpiled per unique
  snippet by `rgss-snippet.mjs` (vendored Ruby2JS self-host) into
  `{ script, js }` (+ `error` staying loud); the game's own library
  (`Data/Scripts.rxdata`, read by `rgss-scripts.mjs`) is unitized by
  `rgss-library.mjs` (one `def`/class/module/const per unit, breadth-first
  from event snippets, `--library-depth` default 8) into
  `manifest.rubyLibrary`; blocking screens are lifted to async by
  `rgss-async.mjs` (functions reaching `Graphics.update/wait` become `async`,
  calls awaited; constructors/getters/callbacks stay sync). The same lowering
  pass repairs Ruby2JS output: a Ruby block's arrow no longer re-declares
  `_implicitBlockYield`, so `yield` inside a block reaches the enclosing
  method's block. `npm test` transpiles 100% of event scripts on the real
  Void builds.
- **Game data**: Marshal files under `Data/` (`.dat`, `.rxdata`, `.rvdata`,
  `.rvdata2`) exported as `assets/ruby-data/*.json` (`manifest.rubyData`),
  except the Ruby script archives already transpiled by the converter. This
  feeds the game's own `load_data` calls and `GameData` registries; `manifest.fileIndex` +
  `textFiles` answer the game's `File`/`Dir` reads case-insensitively.
- **Boot values**: top-level `Const.register(:id)` blocks become
  `rubyLibrary.boot` lambdas; the runtime materializes them (`new_game_value`
  or rebuilt from save) into `rpgExtra.rgss.boot`, snapshotted after every
  script because map changes reload the page. `$player`/`$bag`/`$PokemonGlobal`
  become real objects this way (all 17 Void registrations apply).
- **Database** (`rgss-database.mjs`, XP only): Actors/Classes/Skills/...
  mapped to MV-shaped tables (stats→params, XP damage strings, rank→trait
  rates, troop pages through the event converter); a placeholder database
  (Essentials' blank names/empty troops) is not emitted. VX/Ace ship
  `database: {}` (duel-fallback battles, minimal menu).
- **Title** (`titleScreen`, the same shape as MV's): the engine's stock title
  art — XP `Graphics/Titles/<System title_name>`, VX `Graphics/System/Title`,
  Ace `Graphics/Titles1/<title1_name>` under `Graphics/Titles2/<title2_name>`
  (`drawTitle` from `opt_draw_title`) — copied to `img/titles1`/`img/titles2`.
  Missing art warns and leaves the generic title. A game's own Ruby title scene
  is not run.
- **Game title** (`display.title`): System's `game_title` (VX/Ace), else
  `Game.ini`'s `Title=` (where XP keeps it), else `Untitled <engine> game`.
- **Screen size** (`display.width/height`): the game's own
  `Graphics.resize_screen(w, h)` call when both arguments are numbers or
  constants the scripts assign a number (Void: 512×384 from
  `Settings::SCREEN_WIDTH/HEIGHT`), else the engine default (XP 640×480,
  VX/Ace 544×416).
- **Player start**: `playerSprite` is the start party's first actor's charset
  from the Actors table (`character_index` on VX/Ace), `null` when that sheet
  does not ship with the project (the player then draws a placeholder);
  `initialMapId` from `start_map_id`, falling back to the first map with
  content.

## 6. Audio indexing

`buildAudioIndex` scans `assets/audio/<kind>/` (`bgm bgs me se`,
lowercased kinds) mapping each track name (subpath without extension, as
events reference it) to the best browser-playable coexisting extension
(`chooseExtension`: real audio first, synthesized MIDI next; `.mid`/`.wma`
stay indexed so the player reports them instead of "missing"). MV decodes to
`.ogg/.m4a`; XP mixes `.ogg .mp3 .wav .mid .wma`. `.wma` warns once (no
decoder). MIDI needs a SoundFont: the project's own `.sf2`, else the vetted
shared fallback, else the library synth.

## 7. Manifest contract (`format: "MWGP", version: 1`)

Top-level keys: `source` (engine, projectName, convertedAt), `display`
(title, width, height, tileSize), `initialMapId`, `player` (mapId, x, y),
`tilesetFormat`, `assets` (root, kind `decoded`|`source`, per-category flags,
encryption), `tilesets`, `playerSprite` (may be `null`), `characterFrames`,
`initialParty`, `plugins` (names), `pluginLibrary` (MV/MZ, with
`commandHandlers`), `compatibility` (commands report, scripts stats, plugin
command words with `handledBy`),
`titleScreen`, `maps[]` (`id info data mwgEvents`), `database`,
`commonEvents`, `rubyLibrary rubyData fileIndex textFiles` (XP),
`audio`, `vehicles` (MV/MZ).

## 8. Validation (`validate-mwgp.js`)

Structural gate, no game knowledge: format/version, non-empty maps,
`initialMapId` pointing at a map, decoded asset roots existing on disk,
XP tileset-format arithmetic, `characterFrames` geometry, `pluginLibrary`
file paths (relative `.js`, no `..`), `audio.index` extensions + system track
shapes, six MV layers per map with non-negative layer 0–3 tiles, events in
bounds, and every command key inside the section-4 vocabulary (with shape
checks for `if`, battles, shops, vehicles, enemies, variables, markers).
Prints `{ valid, maps, events, commands }` or the error list.

## 9. Gaps and roadmap

- **2000/2003 (LCF)**: not converted. Path: liblcf tables (pinned tree in
  downloads) + LCF2XML round-trip checks, then an LDB/LMT/LMU→MWGP mapper.
- **VX/Ace database**: flat stats unmapped (`database: {}`); battles and menu
  stay minimal until mapped.
- **Saves are player-side only**: engine save files (`.rpgsave`, `SaveData`)
  are not imported; Continue reads the player's own slots.
- **No game-, framework- or plugin-specific code** in converter or player:
  nothing names a game, a framework (Pokémon Essentials, …) or a third-party
  plugin, or reads a plugin's parameters by name. What a game needs beyond the
  stock engine comes from running its own code (Ruby library, plugin JS) or
  stays a loud gap. The shims removed under this rule, with what they did and
  which game relied on them, are archived in `docs/removed-shims.md`.
- **Gaps that rule leaves open**: plugin- or Ruby-drawn title screens,
  a game's own menu scenes, message windows drawn by the game's own code
  (RGSS `Window`), and plugin commands that need the MV scene/window layer.

## 10. Studio bridge (`tools/mwgp-studio.mjs`)

The converter → editor → player triple on real manifests. `lift <mwgp.json>
<dir>` splits a manifest into a Studio directory (`studio.json`, `maps/`,
`database/`) and stamps every map, event and database row with
`studio.originHash` (hash of its converted content). Editing those files is
the editable form of everything the player shows. `publish <dir> <out.json>`
reassembles a plain manifest (stamps stripped) that the player and
`validate-mwgp.js` read unchanged. `merge <dir> <fresh.json> <outDir>`
folds a later conversion into the Studio directory: entities the editor is
known to have modified (content no longer matching `originHash`) are kept,
never silently overwritten; when the fresh conversion also changed one, the
report (`merge-report.json`: preserved / updated / added / removed /
conflicts) keeps both sides comparable. Untouched entities take the new
conversion. `compare <a.json> <b.json>` lists entity-level differences
between two manifests. `edit <dir> [--port N] [--publish-to <file>]` serves
the real editor over those Studio files (map picker, every player-visible
`say` text editable, database actor names editable, event creation; save
writes the Studio file and the entity reads back as known-as-modified —
editor-created entities have no converted baseline and are likewise kept by
`merge` — publish button) — driven in Chromium against a lifted
Elementals project. Covered by `tools/test-mwgp-studio.mjs` (synthetic)
and verified against a real Elementals manifest (published output passes
`validate-mwgp.js`; the merged, republished manifest was also booted by the
real player in Chromium — the edited event text renders in the dialogue box
with no console errors). Spec: DOC59 rev4 (MWGP Universel 2.0).


### 10.1 Ruby scripts edited in the Studio (`src/studio-code.js`)

An XP/VX/Ace event script is stored as its Ruby (`script`, or `source` in a
conditional branch) next to the JavaScript the player runs (`js`, plus `async`
or `error`). Only the Ruby is the edit; `js`, `async` and `error` are derived.
`recompileScripts(edited, base)` regenerates them with the converter's own
snippet transpiler and async lift for every script whose Ruby differs from the
baseline's at the same path. A `js` the editor changed by hand is kept, a Ruby
that does not transpile keeps its `error` and loses the stale `js` (loud at run
time), and MV/MZ scripts (already JavaScript, no `js`) are untouched. Covered by
`tools/test-studio-code.mjs`. Not covered: the transpiled library units
(`rubyLibrary.units`), which keep no Ruby source in the manifest and can only be
edited as generated JS; a unit edit would also have to re-run the library-wide
async and call-kind passes.

**Decision (2026-10-19): library units stay generated JS.** The transpiled units of
`rubyLibrary.units` are edited in the Studio as JavaScript (full-manifest editor) and are
protected against a later conversion like any other edited field; the original Ruby of a
unit is not kept in the manifest and is not editable from the Studio. Editing the Ruby of a
unit would need the converter to keep each unit's Ruby as an external resource and to rebuild
the library (the async lift and the call-kind passes are library-wide); that was weighed and
not chosen. Event scripts (`{ script, js }`) are different and are recompiled on save (above).
