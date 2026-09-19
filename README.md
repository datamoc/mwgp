# RPGM Player

RPGM Player is the first vertical slice of a converter/player pipeline for RPG Maker games, designed to coexist with `@datamoc/mw_games`.

The target format is MWGP (`mwgp.json`). The first converter reads RPG Maker MV JSON data and writes a portable, explicit project manifest. `mw_games` is the runtime layer to implement against that manifest; it is not an MV/RGSS emulator.

## Run

```powershell
npm install
npm start
```

Open http://127.0.0.1:4173. The launcher scans `RPGM_versions/` and recognizes:

- RPG Maker MV/MZ folders containing `www/index.html` and `Game.exe`.
- RPG Maker XP/VX/Ace folders containing `Game.ini` and `Game.exe`.

The current sample folders are detected automatically. `npm run scan` prints the detected catalog as JSON.

Convert every game in a source folder at once (MV/MZ convert with decoded
assets; extracted or raw RGSS projects convert via `convert-rgss.js`,
extracting `Game.rgssad` to a temp dir first; anything else is skipped with a
reason). Add `--skip-existing` to leave projects that already have an
`mwgp.json` alone:

```powershell
npm run convert:auto -- "RPGM_versions" "MWGP_versions"
```

Convert a single MV project:

```powershell
npm run convert:mv -- "RPGM_versions\Way of Corruption 0.33 A" "MWGP_versions\Way of Corruption 0.33 A"
```

Use `--copy-tilesets` to decode only the tilesets needed by the Pixi player:

```powershell
npm run convert:mv -- "RPGM_versions\Way of Corruption 0.33 A" "MWGP_versions\Way of Corruption 0.33 A" --copy-tilesets
```

Add `--copy-characters` to include the first party actor's MV character sprite.

Add `--copy-faces` to include MV dialogue portraits used by event pages.

Add `--copy-pictures` to decode only the pictures referenced by converted event commands.
This avoids copying an entire large `img/pictures` directory.

Add `--copy-audio` to decode only the referenced sound effects from `audio/se`.

Use `--copy-assets` for a fully self-contained decoded copy. It can be very large for encrypted RPGM resources.

Validate a generated project with `npm run validate:mwgp -- "MWGP_versions\Way of Corruption 0.33 A\mwgp.json"`.

Each generated manifest also contains `compatibility.commands`, with source MV command
counts and `supported`, `partial`, or `unsupported` status. The player reads that report
at launch and shows a warning banner naming any unsupported/partially-supported command
kinds in the project, so the remaining RPG Maker dependence is visible per game.

After conversion, start the launcher and choose **Play MWGP**. The current player core renders the six MV map layers, including generated A1-A4 autotile frames, centers a camera on the player, accepts arrow keys/WASD, applies MV tileset collision flags, draws event and player sprites, handles touch/action/autorun/parallel pages, displays text and choices, expands common-event calls, changes switches/variables, runs player movement routes with cardinal steps, turns, and waits, displays and erases MV pictures, plays MV sound effects and BGM/BGS tracks, handles gold/party/inventory changes, screen tint/shake/fades, player transparency and event erasure, and supports map transfers. Script and plugin commands cannot run without RPG Maker and are skipped with a console warning.

The player loads the published `mw_games` global build, uses `mw_games/rpg`'s `GameState`, `EventRunner`, and `GridMover`, and uses `mw_games/two-d`'s `Game`, `Scene2D`, `SpriteSheet`, `TileMap`, `WindowStack`, and `MessageBox`. Without decoded assets it shows a deterministic placeholder sheet; with `--copy-tilesets` it decodes MV resources and builds MWG-compatible static autotile frames for the real Pixi renderer.

`F5` saves MWGP slot 1 through `mw_games.SaveSystem`; `F9` restores it. The saved state includes the map position, facing, switches, variables, and the player-held gold/party/inventory.

Run `npm test` for the smoke suite: it validates every manifest under `MWGP_versions/`,
asserts the converter/validator/player command vocabulary stays in sync (including a
behavioral routing check of every player scene command), and asserts the server catalog
scan still works.

## Developing a game without RPG Maker

`mwgp.json` is plain JSON and the edit loop needs no RPG Maker install: edit the
manifest (add or change event commands in any map's `mwgEvents`), re-run
`npm run validate:mwgp -- "<project>\mwgp.json"`, and reload the player to play the
change. Work on a copy first — the converter overwrites the manifest on re-conversion.
See `roadmap.md` for the current task list; anything the validator rejects or the
launch warning flags still needs RPG Maker.

## Next milestones

1. Broader MV command support driven by `compatibility.commands` counts (battles and
   remaining high-count codes).
2. A browser smoke-test harness for map loading, movement, events, and saves
   (the Node suite in `tools/test-smoke.mjs` covers conversion/validation/routing).
3. Add RGSS/Ruby import after the JavaScript/MV pipeline is stable.
