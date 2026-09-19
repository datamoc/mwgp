# Roadmap

Objective: a converter and a player that let us **play RPG Maker games without
RPG Maker**, then **develop and improve those games without RPG Maker's
limitations**. The portable `mwgp.json` manifest is the hinge for both halves:
faithful enough to run the original game, plain JSON enough to edit by hand.

Framework proposals live in `4MWG/MWG_IMPROVEMENT_PROPOSALS.md` and
summarized at the end of Phase 2 (item M): upstream `mw_games@0.15.0`
already shipped every ask, so item M is adoption work in this repo's
player, not new upstream API.

## Open tasks (Phase 1)

- [x] 1. Converter→player vocabulary parity. `tools/convert-mv.js` already
  emits an extended vocabulary (`changeGold`, `changeItem`, `changeWeapon`,
  `changeArmor`, `changeParty`, `setTransparent`, `eraseEvent`, `screenTint`,
  `screenShake`, `playBgm`, `fadeoutBgm`, `playBgs`, `fadeoutBgs`,
  `stopSound`, `script`, `pluginCommand`) and `tools/validate-mwgp.js`
  accepts it, but `src/player/pixi-core.js` (`prepareEventCommands`) does not
  execute it yet — the four-file vocabulary contract is broken. Player must
  run every command the validator accepts, so converted games play without
  RPGM. `mw_games` `GameState` only models switches/variables, so party,
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
- [x] J. Battles spike — decision: DEFER. `mw_games battle/` is a
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
- [x] M. `4MWG` adoption (upstream `mw_games@0.15.0` already shipped every
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

Non-goals: RGSS script *execution* (own plan later), plugin emulation
(`script`/`pluginCommand` stay loud warnings), new test frameworks.
