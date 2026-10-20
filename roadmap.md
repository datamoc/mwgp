# Roadmap

Objective: a converter and a player that let us **play RPG Maker games without
RPG Maker**, then **develop and improve those games without RPG Maker's
limitations**. The portable `mwgp.json` manifest is the hinge for both halves:
faithful enough to run the original game, plain JSON enough to edit by hand.

Framework proposals live in `4MWG/MWG_IMPROVEMENT_PROPOSALS.md` and
summarized at the end of Phase 2 (item M): upstream `mwg@0.15.0`
already shipped every ask, so item M is adoption work in this repo's
player, not new upstream API.

## Open tasks (Phase 1)

- [ ] **T124 - RPG Maker 2000/2003.** Foundation landed (2026-10-19): `tools/lcf.mjs`
  reads the LCF container (BER integers, chunk streams, keyed record lists) and parses
  `MapXXXX.lmu` (dimensions, chipset, both tile layers, event ids) and `RPG_RT.lmt`
  (map tree), proven on synthetic fixtures by `tools/test-lcf.mjs` (`npm run test:lcf`;
  no 2000/2003 project is installed locally). `convert:auto` now detects an `RPG_RT`
  project and reports it as its own skipped case instead of a generic one. Still open:
  an LDB database reader, a 2000/2003 event-command converter, and chipset rendering
  in the player (the manifest tile model is MV-shaped), so no manifest is written yet.

### Gameplay verification follow-up (2026-10-19)

- [x] Make `play:all` fail on a skipped browser, failed conversion with stale output,
  invalid manifests, logged runtime gaps and skipped Ruby calls; retain per-game logs,
  incremental reports and input traces. Thresholds apply per map and progression category.
- [x] Preserve RGSS Sprite/Plane zero scale during transitions. Previously `zoom_x` or
  `zoom_y` equal to zero fell back to 1. Eight compositor regression cases reproduce
  the failure before the fix and pass afterwards (`npm run test:rgss-screen`, also in `npm test`).
- [ ] Verify the complete RGSS intro visually: freshly converted Void 0.1.4 has zero
  skipped calls in the 180-step sample, but the end capture shows whole sprite sheets
  (`reports/goal-ruby-current/Pokemon Void 0.1.4/end.png`). Source-rectangle setup and
  asynchronous bitmap loading still need investigation; no console error proves this correct.
  One root cause found and fixed (2026-10-19): the compositor gated `src_rect.y` on the
  rect's *width*, so a sprite narrowed by height only (a vertical icon strip, a common
  Essentials pattern) drew from the top of the sheet. Dimensions now fall back per axis
  in `src/player/rgss-screen.js`, with regression cases in `tools/test-rgss-screen.mjs`
  (`npm test`). The visual re-check itself (fresh capture vs the sheet symptom) stays open.
- [ ] Preserve nested RGSS event labels. Fresh conversion still reports dropping labels
  inside blocks (maps 27-29 and 47-49 in Void 0.1.4); exercise their jumps after fixing
  conversion. Reported to the session owning `tools/convert-rgss.js`.
- [x] Identify the HTTP 404s in the Karryn reference: its own cache loader deliberately
  fetches optional cache files and falls back to an empty cache when absent. Preserve
  fetch/XHR failures as network notes, while failed script/image/media/font/stylesheet
  loads remain failures. The 180-step port sample has no runtime errors and reaches
  maps 32/35 with matching progression coverage. Declared compatibility limits remain
  separate notes rather than being counted as newly encountered runtime errors.

The five installed games pass manifest validation, startup and two sampled maps each
(`reports/goal-browser-validated/report.md`). These checks and the successful Elementals
opening comparison are samples; story branches, long sessions and endings remain open.

- [x] 1. Converter→player vocabulary parity. `tools/convert-mv.js` already
  emits an extended vocabulary (`changeGold`, `changeItem`, `changeWeapon`,
  `changeArmor`, `changeParty`, `setTransparent`, `eraseEvent`, `screenTint`,
  `screenShake`, `playBgm`, `fadeoutBgm`, `playBgs`, `fadeoutBgs`,
  `stopSound`, `script`, `pluginCommand`) and `tools/validate-mwgp.js`
  accepts it, but `src/player/pixi-core.js` (`prepareEventCommands`) does not
  execute it yet — the four-file vocabulary contract is broken. Player must
  run every command the validator accepts, so converted games play without
  RPGM. `mwg` `GameState` only models switches/variables, so party,
  inventory and gold live in player-held state that survives transfers and
  saves; `script`/`pluginCommand` have no RPGM-free execution and must
  degrade to a loud warning, never silent success.
- [x] 2. Compatibility report surfaced at launch (`showCompatibilityWarning` in `public/player.js`). The manifest already
  carries `compatibility.commands`; nothing reads it. The launcher/player
  must warn before play when a project uses unsupported/partial MV commands,
  so the remaining RPGM dependence is visible per game instead of silent.
- [x] 3. Working smoke test (`tools/test-smoke.mjs`, run by `npm test`). `npm test` points at `tools/test-smoke.mjs`,
  which does not exist. Provide it: validate every manifest under
  `MWGP_versions/`, assert the converter/validator/player vocabulary
  contract is in sync, and assert `npm run scan` still produces a catalog.
- [x] 4. Documented edit loop (develop without RPGM's limits; section in `README.md`, proven by a scratch manifest validating 27 commands). Prove the
  second half of the objective: hand-edit a manifest (new event command on a
  scratch copy), re-run `validate:mwgp`, and play it back. Document the loop
  in `README.md` so improving a game no longer requires opening RPG Maker.

## Open tasks (Phase 2)

Goal: close the gaps Phase 1 made visible — every high-count MV command
executes in the browser player, XP maps convert with event logic (not just
tiles), and the remaining RPGM dependence per game is a short, honest list
instead of a banner of 28 kinds. Full plan: `.agents/plans/2026-09-19-phase2.md`.

Success criteria: reconverted MV manifests show zero unsupported codes above
100 uses except battles (`301`/`601–604`) and `356` plugin commands; `npm test`
covers each newly supported command; XP projects convert maps + events and
render without the tile glitch from the Pokémon Essentials screenshot.

- [x] A. Reconvert + re-baseline (622 + 79 maps reconverted, validated,
  smoke green; 15 codes flipped to supported).
- [x] B. Comment bodies (`408`) → supported no-op (1681/1681 verified
  under `108`; manifests reconverted, banner shrunk).
- [x] C. Movement routes (`205` stays partial): diagonals, random/forward/
  backward, jumps, turn variants, switch/transparent/opacity/SE/script steps
  (codes decoded against the engine's own `ROUTE_*` constants); speed/anim/
  through/image steps and non-player targets remain dropped.
- [x] D. Pictures full (`231`/`232`/`234` supported): `movePicture`/
  `tintPicture` tweened in the scene loop with wait semantics; `233` Rotate
  has zero corpus uses and stays unsupported.
- [x] E. Balloon (`213`) + Animation (`212`) overlays (sheet measured on
  real data; wait semantics; animation timings skipped and noted).
- [x] F. Scrolling text (`204`/`405` supported): `scroll` via auto-advancing
  MessageBox; orphan `405` plugin-data lines stay dropped; added a report
  guard so translated codes can never file as unsupported (caught `231`).
- [x] G. Labels (`118`/`119` supported): pages split into `story.passages`,
  jumps become `goto` → `JumpSignal`, driven by `runStoryLoop` (fixed a
  `context.depth` default bug and a `commands`-vs-`story` page-shape bug
  found by real-data verification).
- [x] H. Small codes batch (`203` relocate, `135` no-op, `243`/`244` BGM
  save/resume, `249` ME jingles, `351`/`352` menu/save warns; `105`
  identified as the real scroll-text opener — `204` corrected to map
  scroll — all verified against the shipped engine).
- [x] I. Actor commands (`313`/`314`/`318`/`319`/`322` supported):
  `rpgExtra.actors` records (states/skills/equips/profile; HP/MP half of
  Recover All has no model and is noted).
- [x] J. Battles spike — decision: DEFER. `mwg battle/` is a
  creature-battle toolkit (`Species`/`TypeMatrix`/`StatStages`/`Evolution`),
  with no MV-style troop runner (turn loop, party commands, damage pipeline,
  win/lose/escape flow for `601–604`). Building one is Phase-3-scale, not an
  adoption. `301`/`601–604` stay honestly unsupported.
- [x] K. XP maps parity: every `111`/`122`/`123`/`202`/`231`/`232` parameter
  shape verified against the shipped `Interpreter` scripts (not MV numbering)
  — fixing real misreads (`116` is Erase Event, `203` is Scroll Map, `204` is
  fog/panorama settings, durations divide by 20, passages need no inversion);
  conditions, branches, choices, loops, labels, common events, routes, plus a
  real compatibility report (only `103`/`104`/`204` unsupported in the
  corpus) guarded by a new smoke check. Tile mapping verified hole-free over
  420k tiles except ~3% referencing frames beyond their tileset PNG — a
  source-data defect the engine renders as holes too.
- [x] L. Manual play checklist doc per game (`docs/play-checklist.md`: move,
  dialogue, choice, transfer, save/load, banner review). Browser playthrough
  itself is still to be done by hand; results go in the doc's log.
- [x] M. `4MWG` adoption (upstream `mwg@0.15.0` already shipped every
  ask — verified against `dist/**/*.d.ts`, tracked in
  `4MWG/MWG_IMPROVEMENT_PROPOSALS.md`): adopt `TileMap.addAutotileLayer`
  (item 370, shipped in 0.16.0: `AutotileSet` with animation, floor/wall
  modes, XP formats) for `buildAutotileSheet` and the `isXp` fallback;
  route portrait dialogue through `present` (`DialogueRequest.portrait`);
  drive routes via `MoveRouteRunner`/`jumpBy`; pass volume/pitch to
  `Sound.play` (pan stays out — deliberately excluded upstream); swap maps
  via `world.World.enter` instead of the `SaveSystem` + page-reload
  round-trip. Diagnostics already done repo-side. No open framework API
  remains; everything left is port integration work.

Non-goals: reproducing native plugin APIs that the game does not ship, or
adding a second engine implementation beside `mwg`; the converter runs shipped
RGSS Ruby through the transpiled-library bridge and reports unresolved calls
loudly. New test frameworks remain out of scope.

## Recent (coord-tracked)

- **0.2.1 — T117 MV/MZ branch-operand parity (done for the MV half, 2026-10-19).** `convert-mv.js` read the Conditional
  Branch variable operators in VX editor order (0 gte, 1 lte, 2 eq) while the shipped MV/MZ engines order them 0 eq,
  1 gte, 2 lte (verified in `rpg_objects.js` v1.6.2 and `rmmz_objects.js`): 230 of the 231 corpus variable comparisons
  silently mis-evaluated (`==` became the tautological `>= 0`-style `atLeast`, `>=`/`<=` swapped) with no `unsupported`
  marker anywhere. Fixed with the engine-order table; the player already evaluated all six operator names, so the
  four-file contract needed only converter + validator + smoke changes. Same pass: Control Variables "Other" operands
  (`steps`, `playtime`, `timer`, `saveCount`, `battleCount`/`winCount`/`escapeCount`) now have an `rpgExtra` model and
  convert; the MZ probe fixture pins the operator order and all seven operands; a page condition with `comparison 1`
  (`<=`) warns instead of silently emitting `>=` (zero such pages in the corpus). All three MV/MZ projects reconverted:
  manifests validate, raw-vs-manifest cross-check finds every comparison with its engine semantics, Chromium boots
  pass with 0 console errors (Karryn, WoC, Elementals, incl. battles through the fixed branches). `LAST_OUTPUT_CHANGE`
  moves to 0.2.1, so the pre-fix manifests (incl. both Void stamps) show "reconvert" until regenerated — the RGSS
  converters have their own tables (XP-side audit stays with `convert-rgss.js`). Checklist row logged.
- **0.2.0 — Engine command parity pass (done, 2026-09-28).** Compared `convertCommand` with every
  `Game_Interpreter.commandNNN` of the real MV (`rpg_objects.js`) and MZ (`rmmz_objects.js`) engines: both define the same
  112 codes plus 357. 25 of the 33 unconverted ones are now converted (134-140, 216, 217, 124 + the timer condition, 132/133/139,
  206, 261, 281, 312/315/317/320/323/324/325/326, 339, 354); 104, 233, 282-285, 337, 340, 342 remain loud unsupported markers.
  Usage across the installed games (maps + common events + troops) found two used codes: 339 Force Action (2x, Karryn's
  Prison) and 135 Change Menu Access (8x, same game), which the converter had dropped as a no-op on a stale premise.
  Also fixed a real bug: 322 is Change Actor Images, but was stored as the actor's profile. Battles now play the battle BGM and
  victory/defeat ME. Covered by the routing table, an 18-check MZ probe and a Force Action battle test in `npm test`; the
  MWGP player was booted, saved, menu-walked and fought in Chromium on a fresh Elementals conversion. Manifests made before
  0.2.0 need reconversion to pick up the new codes.
  Second pass, same release: 104 select item, 233 rotate picture, 285 location info, 283 battleback, 340 abort battle, 334 enemy
  recover all and 342 enemy TP; fixed the enemy-command numbering (333 was read as TP, 334 as a state change: Karryn's Prison uses 333
  12x). Only 282 and 284 stay unsupported (no MV parallax renderer, no run-time tileset swap; no installed game uses them). Karryn's
  Prison, converted with assets, boots, saves, walks the menu and wins a battle in Chromium with no console errors.
  Battle engine, same release: TP (initial roll, Preserve TP, damage charge, TRG, tpCost/tpGain), counter attacks, magic reflection
  and the Substitute flag, in `BattleManager.invokeAction` order; 6 new checks in `npm test`. Still open: battle animations and
  motion, a Formation scene, MV parallax and run-time tileset swap (282/284), the graphical menu windows.
  Follow-up, same release: closed the Formation scene (order + nine layouts with row modifiers), damage popups / hit motion /
  database battle animations, MV parallax and 284. Verified by 30 battle+menu checks and a real-browser screenshot (popup "10"
  over the enemy, attacker stepping forward). Also closed (0.2.0): the game's own font, engine-coloured HP/MP/TP gauges in a battle status panel, animated actor poses (18 motions) and stale-manifest handling
  (stamp, launcher badge, player banner, convert:auto --stale). Closed the same day: run-time tileset swap (282, live-checked: state and position carried, parallax showing through the new
  tileset's empty tiles) and Window.png skinned windows (screenshot-checked). Every command code is converted or documented partial;
  remaining differences are visual polish (fonts, gauges, battle side-view poses) rather than missing features.
- **T126 — Browser smoke harness wired into npm test (done).** `tools/test-smoke.mjs` spawns
  `tools/test-browser.mjs` as its last section (30-minute cap, output streamed, summary pinned as a
  `browser harness ok (...)` note), so regressions are caught without a manual run. `MWGP_BROWSER=0`
  skips it loudly, and a machine with no playable browser (no playwright/chromium) now skips loudly
  with exit 0 instead of failing — only a harness that runs and finds failures fails the suite.
  Verified with a full `npm test`: 5/5 projects PASS in real Chromium with 0 console errors, unblocking
  T120. `AGENTS.md` commands section updated to match.

- **T117 — Converter half done (RGSS 111/122 upgrade).** `tools/convert-rgss.js` now tracks branch/
  operand fallback sites and promotes 111/122 to `supported` when empty, mirroring MV. Verified by
  two full Void reconversions to `/tmp` (111 supported ×339, 122 supported ×129, counts match the
  shipped manifests) plus `npm test` green. Shipped manifests still read partial until the next
  reconversion; the committed smoke guard waits for the tile-fix WIP in `test-smoke.mjs` to land.
- **RGSS Ruby archive extraction and compatibility (in progress toward RC1, 2026-10-19).** The XP
  converter extracts scripts from encrypted `Game.rgssa` inputs before indexing the library. Generic
  Ruby2JS/runtime fixes cover implicit `super`, Marshal-backed registry hashes, receiver-aware
  `respond_to?`, module readers, and direct singleton aliases without rewriting conditional aliases
  as static fields. Both Void manifests now validate with every event script transpiled and 0 failed
  or partial library units; fresh Chromium startup/save/audio checks pass. Nested labels inside event
  blocks are still reported as dropped, and a human-paced rewalk after reconversion remains open.
  R17 reconverted all 5 MWGP projects (0 failed); `npm test` passed 5/5 browser boots with 0 console
  errors. Current per-project command gaps are logged in `docs/play-checklist.md`; RC1 remains open.
- **T116 — Script/plugin depth (closed as designedly-partial).** Ruling (michel, option a): 355/356
  stay partial by nature — game JS runs in the plugin sandbox, unknown calls warn loudly, and the
  old per-family adapter plan is superseded since T143. No code change; future runtime script
  failures get their own tasks from playthrough evidence. Ruling recorded in the task description.
- **T172 — Walkable pond (human report, faithful).** No code change: the map-2 pond is flagged
  passable+bush in the project's own tileset, so the shipped `checkPassage` walks it too — verified
  cell-for-cell against our `passageAllowsStep`. Logged in `docs/play-checklist.md`.
- **T157 — Elementals tutorial hand-check (done).** Human playthrough at human pace: no stall
  anywhere in the opening (tutorial texts, +5G step, "List other Controls" loop, map 1 → map 2
  transfer); chest +40G applied; gold reads correctly in the menu (Esc), absent from the map as in
  MV. The scripted-run stalls were bot-pacing artifacts. Logged in `docs/play-checklist.md`.
- **T170 — MWG improvement bilan (done, refreshed for 0.20.0).** `4MWG/` refreshed against 0.20.0: §18 still open
  (null-texture `_updateGpuText`, deterministic confirm-spam repro stands), new §19 asks for a loud
  unknown-command hook in `EventRunner.step()` (found via T127: unknown keys fall through silent),
  §20 refreshes the adoption backlog (portrait seam, MoveRouteRunner, World swap, per-kind bus
  volume — all still adapter-side, verified in `player-core.js`), §21 proposes adopting 0.19.0's
  SoundFont subsetting at convert time, §22 adopts 0.20.0's worker MIDI render (`renderMidiToBufferAsync`
  in `audio-manager.js` with sync fallback, pinned in `npm test`; threads/chess/compress deliberately
  not adopted).
- **T158 — Browser harness prints every note (done).** One-line fix in `tools/test-browser.mjs`: the
  PASS summary loop no longer truncates `result.notes` to the first 2, so battle/audio lines are visible
  again (the per-note 160-char cap stays). Verified live (`--only Elementals`, audio/battle/menu probes
  off: PASS, both notes printed) plus `node --check`.
- **T128 — Per-feature compatibility report (done).** New pure module `src/player/compat-features.js`
  rolls `compatibility.commands`/`.plugins`/`.scripts` into named areas (battles, menus, messages,
  scripts, plugins, pictures, audio, movement, party/inventory/actors, screen, switches/variables/flow,
  RGSS units, plus an honest "other" catch-all); the launch banner in `public/player.js` now prints
  one line per gapped area, most-used first, and stays silent for fully supported projects (Elementals:
  0 lines; Karryn: plugins + scripts; Voids: state + movement + party + RGSS units). Pinned in
  `tools/test-smoke.mjs` (2d: every supported/partial code of both converters sits in an area; roll-up
  and silence checks) and probed against all 5 shipped manifests; `npm test` green, `/compat-features.js`
  served by the existing generic route (verified over HTTP), and a real Chromium Karryn boot logs the new
  banner verbatim (`Plugins: partial (356×4178, Tachie×3103, …); Event scripts: partial (355×466)`) with PASS.
- **T156 — mwg `_getFinalPadding` confirm-spam errors (done).** Upstream repro note added to
  `4MWG/` §18: ~90 rapid confirms on Elementals' "List other Controls" choice loop fills the console
  with the null-texture `_updateGpuText` TypeError (non-fatal, 0 occurrences at harness/soak pacing).
- **T127 — Reconcile fallback-core.js with the command vocabulary (done).** Took the "route it through
  the vocabulary" option instead of deleting it: the canvas fallback now consumes `mwgEvents` only —
  the native `EventRunner` subset (`say`/`ask`/`wait`/`setSwitch`/`setVariable`/`addVariable`/`if`/`goto`)
  runs unchanged, `transfer` (direct and variable forms) and choice `branches`/`cancelBranch` are
  rewritten into `call` closures, story pages run through `runStory`, and anything else (pictures,
  audio, menus, scripts, move routes) warns once per page instead of silently dropping. Touch-trigger
  parity kept (no autorun/parallel frame driver — residual gap). Raw-code paths (`toMwgCommands`,
  `interpret`, `pageMatches`, the `map.events` scans) are gone; verified with a Node probe against
  the real `GameState`/`activePage`/`EventRunner` (dialogue, choice pick → branch, conditional
  transfer, story order, once-only gap warning, blocking tiles) plus an import check and a stale-
  reference search. `AGENTS.md` fallback paragraphs updated to match.
- **T113 — Play all 5 converted games through the manual checklist and log results (done).** The four
  remaining games (Karryn's Prison, Way of Corruption 0.33 A, Pokemon Void 0.1.4 and 0.1.5) were played
  in Chromium against `docs/play-checklist.md` and logged as dated rows, together with the common steps:
  movement (harness key-hold recipe — instant `keyboard.press` falls between frames under swiftshader;
  walls block, floors pass, turn-in-place counts), NPC dialogue with real text advancing and closing,
  Show Choices events with a branch proven by a switch flip or its verbatim branch says, door/touch/bump
  transfers landing at exact coordinates with gold/party/switch state intact (Void's blocked touch tile
  fires on bump after screenTint+wait), F5/F9 + reload survival through the harness, and a completed
  compatibility-banner review — every `unsupported`/`partial` entry matched to its classification comment
  in `convert-mv.js`/`convert-rgss.js`. Audio verified programmatically per kind (BGM/BGS/ME/SE active
  nodes, boot autoplay, MIDI+SoundFont render for the Voids); by-ear listening stays residual for michel.
  Full harness runs (0 console errors) and 90 s soaks back every row. Gap list logged explicitly: Void's
  trainer battle branch throws on `GameData.TrainerType.exists` (battle-gate scope), empty-prompt asks
  consume one confirm before their choice list shows, no `cancelBranch` exists anywhere in the corpus, and
  the harness's `notes.slice(0, 2)` still hides per-game detail (T158). Closes the manual-playthrough gate
  T114/T115/T116/T117/T125/T127/T128 were waiting on.
- **T121 — MZ playthrough + MZ-specific command coverage (done).** Elementals (MZ, 89 maps) played
  through in the browser: opening sequence with three choice scenes (both branches sampled), the
  map 1 → map 2 transfer landing at (11, 3) with gold/party carried through the SaveSystem reload,
  movement on the new map, weakest-troop battle won through the dialogue UI with the enemy sprite
  drawn, 89/89 maps booting, 60 s/180 s soaks and F5/F9 + menu checks clean, banner fully clean
  (57/57 command codes supported, 0 plugins). `npm test` gained the real-project MZ fixture
  (`rpg-maker-mz` branch: six normalized tile layers per map, battle-runner database, 357 never
  filed unsupported); Elementals passes all 4 checks and the sweep now fights its 58 troops
  (323 total). Finding recorded honestly: Elementals ships no plugins at all, so the corpus has **zero
  real 357 uses** — conversion of real 357 calls stays covered by the synthetic MZ probe.
  Two bot-only observations logged in `docs/play-checklist.md` (Enter-spam GPU text errors upstream,
  an intermittent dialogue-advance stall in scripted runs) and the harness's `notes.slice(0, 2)`
  truncation was reported for T126.
- **T152 — Essentials map-sweep script shapes (done).** Two converter fixes in `tools/rgss-library.mjs`, both regression-covered in `tools/test-smoke.mjs`: the manifest's `methods` list now strips Ruby `?`/`!` suffixes like the transpiled output (so `event.at_coordinate(x, y)` and other predicate calls resolve on shim characters instead of degrading), and merged multi-piece units drop shadowed top-level `function` redefinitions, keeping Ruby's last-wins (so the patched `pbExclaim` loads instead of failing the runtime's `with(scope)` compile). Verified in Node against the real Void library (`pbExclaim`/`pbWalkCharacterTo`/`pbCameraFollowEvent` run end to end) and in Chromium (Void maps 3/14, WoC 32/332/426/446 boot PASS). Karryn map 31's `setWardenMapPoseExtensions` log is the game's own recovery path on unset pose state under mid-game `skipTitle` boots, not a player defect. Manifests reconverted; `npm test` green.
- **T141 — RGSS API surface -> shim coverage report (done).** `tools/rgss-api-dump.mjs` extracts the RGSS
  class/method surface from a runtime binary's strings (`docs/rgss-api-xp.json`, from Pokemon Void's
  `Game.exe`; its `RGSS104E.dll` is packed and exposes no names), `tools/rgss-coverage.mjs` compares it with
  what the transpiled Ruby calls and what the shim implements (`docs/rgss-shim-coverage.md`). Feeds T125 and
  T123. VX Ace (RGSS3) binaries were not available locally, so the tool is unverified on them.
