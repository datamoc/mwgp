# RPGM Player

RPGM Player is the first vertical slice of a converter/player pipeline for RPG Maker games, designed to coexist with `@datamoc/mwg`.

The target format is MWGP (`mwgp.json`). The first converter reads RPG Maker MV JSON data and writes a portable, explicit project manifest. `mwg` is the runtime layer to implement against that manifest; it is not an MV/RGSS emulator.

MWGP is built on [mwg](https://datamoc.github.io/mwg/). If it lets you play or edit your games, you can support the project
through the ♥ link on the pages or on [Stripe](https://buy.stripe.com/bJe8wOeUq4oZ2kXfyeaIM00) (also linked from `.github/FUNDING.yml`).

## Play every game and compare with the original

`npm run play:all [-- <source dir>]` finds every RPG Maker game under `RPGM_versions/` (nested folders included), converts it, then judges it in real Chromium:
boot and a sample of maps (`tools/test-browser.mjs`), a rendering comparison and a progression comparison against the original engine for MV/MZ
(the game's own web build under `MWGP_reference/`), and for XP/VX/Ace (whose Ruby original does not render headless) a port-only run that reports
errors, skipped script calls and whether the intro advances. The comparison is deliberately structural (8x8 block colours; the same seeded input
script driven into both; what each run *reached*, not the state at one instant), because UI chrome, scaling and text speed legitimately differ.
PNGs and `report.md`/`report.json` land in `reports/play-all/`. Options: `--only <name>`, `--maps N`, `--steps N`, `--reconvert`, `--skip-convert`, `--no-parity`.

Use `npm run play:all -- --list` to inspect discovery, or `--help` for all options; neither starts a conversion or a browser.
For a repeatable run against freshly converted games:

```powershell
npm run play:all -- --reconvert --maps 4 --steps 450 --seed 7 --out reports/play-check
```

Existing output is reused by default without checking its freshness. `--skip-convert` explicitly uses it;
`--reconvert` rebuilds it. Use `--port 4391` when the default test ports are occupied; the harness uses that port and the next two.
`--timeout 1800` bounds each converter or browser subprocess in seconds. Each game's `browser.log` preserves the full browser
output, and `report.json` is saved after each game and progression run so completed stages survive interruption.
Conversion and validation logs are stored beside it; `port-trace.jsonl` and `reference-trace.jsonl` preserve each input sample
with its elapsed time, including the part of a run completed before a crash or a page that stops answering.

A missing or disabled browser, a failed conversion (even with older output present), a skipped Ruby call, or an uncaught/runtime
error fails the requested checks. Diagnostics for both engines remain in the JSON report. `--no-parity` runs boot/map checks only.
The report keeps declared compatibility limits and fetch/XHR failures as notes: scripts can handle an absent optional file.
Failed script, image, media, font and stylesheet requests remain failures, along with uncaught exceptions and runtime gaps.
Render thresholds apply to each sampled map, and progression thresholds apply to each category (maps, switches, variables, gold),
so a high average cannot hide a failed map or a missing category.
The render and progression percentages measure a sample: they do not prove that a whole game can be completed. Long runs,
multiple seeds and recorded playthroughs are still needed for story branches, battles and endings.

## Run

### Convert without Node

Open [public/converter.html](public/converter.html) directly in your browser, choose the complete game folder,
then convert. This standalone page works offline, including Ruby transpilation and encrypted RGSS archives;
it sends no game files to a server. It supports MV, MZ, XP, VX and VX Ace, with the CLI converter's compatibility limits.
The default output is a playable HTML file: the player, runtime, manifest and resources are embedded
in a gzip payload. Open that file to play offline, with no extraction or server. Saves use the browser's storage.
ZIP and direct-folder MWGP exports remain available for the local player and Studio;
put their resulting folder under `MWGP_versions/`.

The page is available in English (default), French and German; the choice is remembered across MWGP pages.

Developers regenerate the distributable after converter changes with `npm run export:converter`
(optional output filename: `npm run export:converter -- <file.html>`). Node and the packaging dependencies
are needed only to produce this file. The normal launcher/player still runs without a build step.
See [Browser converter](docs/browser-converter.md) for architecture, limits and checks.

### Edit without a server: standalone Studio

[public/studio-standalone.html](public/studio-standalone.html) is the complete graphical MWGP Studio
in a single offline file. Open it directly in your browser (`file://` works), then:

1. Choose a self-contained game page: the `.html` file produced by the converter above, or a blank project
   from the opening screen.
2. Edit maps, events, dialogues and the database with the same editor as the server Studio.
3. Click **Test (Play MWGP)** to play the edited game in the standalone player, or **Game page (.html)** to download
   the regenerated self-contained game page with your edits. Opening it again in the standalone Studio, or
   recreating the editable folder from it in the converter page (step 3), keeps working.

Edits stay in memory until you download the game page; nothing is written to a folder or sent to a server.
The standalone Studio is available in English (default), French and German. Limits compared with the server Studio are
listed in [Browser converter](docs/browser-converter.md#standalone-studio-full-graphical-editor).

Developers regenerate it with `npm run export:studio` (optional output filename: `npm run export:studio -- <file.html>`).

### Local launcher

```powershell
npm install
npm start
```

Open http://127.0.0.1:4173. The launcher scans `RPGM_versions/` and recognizes:

- RPG Maker MV/MZ folders containing `www/index.html` and `Game.exe`.
- RPG Maker XP/VX/Ace folders containing `Game.ini` and `Game.exe`.

The current sample folders are detected automatically. `npm run scan` prints the detected catalog as JSON.

Convert every game in a source folder at once. The systematic default is the
MWGP conversion for every engine (MV/MZ with decoded assets; extracted or raw
RGSS through the RGSS manifest converter), because only a converted manifest
plays in the MWGP player and can be edited in MWGP Studio; anything else is
skipped with a reason. Add `--web` only when a game must run its own engine
unconverted (a web build is not editable), or `--skip-existing` to leave
existing conversions alone:

```powershell
npm run convert:auto -- "RPGM_versions" "MWGP_versions"
```

For an individual XP/VX/Ace project, `npm run build:web -- <project> <output>`
packages its files in a stored `.mkxpz` archive and adds our mkxp-z player page.
The first build downloads a SHA-256 pinned core into the gitignored cache.
See [RGSS web builds](docs/rgss-web-build.md) for provenance, browser requirements,
controls and verification limits.

For MV/MZ web builds, loose files in a project-level `mods/` folder beside `www/`
are copied into the build's `mods/` directory and indexed for the game's file API.
Files already under `www/mods/` are copied as part of the web root.

Convert a single MV/MZ project:

```powershell
npm run convert:mv -- "RPGM_versions\Way of Corruption 0.33 A" "MWGP_versions\Way of Corruption 0.33 A" --copy-assets
```

Convert a single XP/VX/Ace (Ruby / RGSS) project:

```powershell
npm run convert:rgss -- "RPGM_versions\Pokemon Void 0.1.4" "MWGP_versions\Pokemon Void 0.1.4"
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

## Le Player MWG

After conversion, start the launcher (`npm start`) and choose **Play MWGP** (or navigate to `/player.html?id=<id>`). The player core runs the game through `@datamoc/mwg`:
- Works identically on projects transformed from **RPG Maker JavaScript (MV / MZ)** and **RPG Maker Ruby (XP / VX / Ace)**.
- Renders map layers, generated A1-A4 autotiles, centers camera on the player, handles arrow keys/WASD.
- Event triggers: action button, player touch, autorun, parallel processes.
- Displays text dialogues, portraits, and choices (`say`, `ask`).
- Handles gold, inventory, party, switches, variables, transfers, screen tint/flash/shake.
- Sound effects, BGM/BGS audio (OGG, MP3, WAV and MIDI rendered via SoundFont).
- `F5` saves MWGP slot 1 through `mwg.SaveSystem`; `F9` restores it.
- A button **Éditer dans Studio** in the player header lets you switch to editing the game in real time.

## L'Éditeur : MWGP Studio

MWGP Studio allows inspecting and developing RPG Maker games directly in the browser or via CLI without opening RPG Maker:

1. **Web Studio** : Open http://127.0.0.1:4173 and click **Studio** on any converted game card (or go to `/studio.html?id=<id>`).
   - **Cartes** : Browse all maps of the game, view dimensions, event counts, and layer data.
   - **Canevas interactif** : Visually inspect map tiles, grid, event locations and player start position.
   - **Outils** :
     - *Inspecter* : Click any event to inspect its pages, triggers, and commands.
     - *Peindre* : Select a tile and paint directly on any map layer.
     - *Position Joueur* : Click to reposition the player starting location.
     - *Ajouter Événement* : Click to add a new event with dialogues.
   - **Inspecteur d'événement** : Edit event name, coordinates, triggers, and edit dialogue texts (`say`, `ask`) directly.
   - **Base de données** : Edit actor names, Max HP, and profiles.
   - **Sauvegarde en 1 clic** : Click **Sauvegarder** to persist changes directly to `mwgp.json` on the server and test immediately with **Tester (Play MWGP)**.
   - **Protection contre l'écrasement (DOC59 rev4)** : Any modified entity receives an `originHash` footprint. Re-converting the original RPG Maker source will preserve your edits and log any concurrent upstream changes as comparable conflicts.

2. **Studio autonome** : open [public/studio-standalone.html](public/studio-standalone.html) without a server (see *Edit without a server* above).

3. **CLI Studio** :
   ```powershell
   npm run studio -- lift <mwgp.json> <studioDir>      # Split manifest into editable folder
   npm run studio -- publish <studioDir> <out.json>    # Reassemble into clean Play manifest
   npm run studio -- merge <studioDir> <fresh.json> <outDir> # Merge fresh conversion safely
   npm run studio -- compare <a.json> <b.json>         # List entity-level differences
   npm run studio -- edit <studioDir> [--port 4300]    # Standalone editor server
   ```

The repository ships no game. The local checks run on the games you keep in `RPGM_versions/`: put at least two
RPG Maker games there (one folder each, with `Game.exe`), convert them with `npm run convert:auto -- RPGM_versions MWGP_versions`,
and the checks fail until that is done. Nothing is skipped silently. The checks read whatever games are present;
none is named in the code.

Run `npm test` for the complete smoke test suite: it validates every manifest under `MWGP_versions/`, asserts vocabulary parity, runs synthetic and real-world Studio integration tests (`tools/test-mwgp-studio.mjs`, `tools/test-studio-integration.mjs`), and boots every converted project in Chromium.

## Next milestones

1. Broader MV command support driven by `compatibility.commands` counts (battles and
   remaining high-count codes).
2. A browser smoke-test harness for map loading, movement, events, and saves
   (the Node suite in `tools/test-smoke.mjs` covers conversion/validation/routing).
3. Add RGSS/Ruby import after the JavaScript/MV pipeline is stable.
