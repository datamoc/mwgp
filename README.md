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

Convert an MV project:

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
counts and `supported`, `partial`, or `unsupported` status. This report is the basis for
future player warnings and MWG adapter work.

After conversion, start the launcher and choose **Play MWGP**. The current player core renders the six MV map layers, including generated A1-A4 autotile frames, centers a camera on the player, accepts arrow keys/WASD, applies MV tileset collision flags, draws event and player sprites, handles touch/action/autorun/parallel pages, displays text and choices, expands common-event calls, changes switches/variables, runs player movement routes with cardinal steps, turns, and waits, displays and erases MV pictures, plays MV sound effects, and supports map transfers.

The player loads the published `mw_games` global build, uses `mw_games/rpg`'s `GameState`, `EventRunner`, and `GridMover`, and uses `mw_games/two-d`'s `Game`, `Scene2D`, `SpriteSheet`, `TileMap`, `WindowStack`, and `MessageBox`. Without decoded assets it shows a deterministic placeholder sheet; with `--copy-tilesets` it decodes MV resources and builds MWG-compatible static autotile frames for the real Pixi renderer.

`F5` saves MWGP slot 1 through `mw_games.SaveSystem`; `F9` restores it. The saved state includes the map position, facing, switches, and variables.

## Next milestones

1. Add broader MV command support: inventory, common events, scripts, pictures, battles, and plugin commands.
2. Add runtime diagnostics and a browser smoke-test harness for map loading, movement, events, and saves.
3. Add RGSS/Ruby import after the JavaScript/MV pipeline is stable.
