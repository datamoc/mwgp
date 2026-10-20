# Manual play checklist

Per-game browser verification for converted projects. Serve with `npm start`
(`http://127.0.0.1:4173`, or `$RPGM_PORT`), open the launcher, pick a game,
and work through its rows. Record pass/fail plus the observed behavior; a fail
goes back to `roadmap.md` as a bug, not into this file as a note.

Status: `[x]` verified in the browser, `[~]` verified only by manifest/source
or data-level checks, `[ ]` not yet verified. A `[~]` is not a substitute for
the corresponding manual playthrough.

## Current automated evidence (2026-10-19)

These samples supplement the historical playthrough rows; they do not verify completion
of a whole game.

| Scope | Result | Evidence and remaining work |
|---|---|---|
| All five installed games | pass, sampled browser checks | `reports/goal-browser-validated/report.md`: all five manifests validate; startup, save/audio gates and two sampled maps per game pass. Progression deliberately disabled for this run. |
| Elementals, fresh conversion | pass, opening comparison | `reports/goal-elementals-current/report.json`: 181 state samples per engine, maps 1 then 2 in both, gold 20 in both, 100% coverage of observed progression categories, no runtime errors. Render similarity 72.6% on map 1 and 98.7% on map 45; message presentation differs. |
| Karryn, fresh conversion | port sample passes; reference diagnostics classified | `reports/goal-karryn-current/report.json`: port has zero runtime errors; both engines reach maps 32/35, gold 2000 and matching observed progression categories. Subsequent URL diagnostics identify the reference 404s as optional cache probes; the shipped cache loader explicitly handles absence with an empty cache. They remain network notes, not required-resource failures. |
| Void 0.1.4, stale versus fresh conversion | script gap removed; visual check open | `reports/goal-ruby-baseline/report.json` fails on skipped `_implicitBlockYield`. Fresh output in `reports/goal-ruby-current/` validates and has no skipped calls or runtime errors in 180 steps, but visits only one cell with eight dialogue-state changes. Its end capture displays sprite sheets; intro rendering and later progression remain unverified. |
| Void 0.1.5, fresh conversion | sampled execution passes; full intro unverified | `reports/goal-ruby015-current/report.json`: manifest validates, two maps boot, 181 progression samples have no skipped calls or runtime errors. Only one cell is visited in 180 input steps; screenshots and longer progression still require review. |
| RGSS zero-scale transitions | regression fixed | `tools/test-rgss-screen.mjs`: Sprite/Plane zero and fractional scales, eight cases. Before: zero scale drew a full-size bitmap. After: hidden at zero, visible at fractional scale. `npm test` after the runtime fix passes (five browser boots, zero console errors); raw log: `notes/goal-smoke-2026-10-19-after-screen.log`. This does not close the separate sprite-sheet issue. |
| Harness failure handling | pass | Disabled browser returns 1 (`reports/goal-skipped-check/`); scratch integration probes reject malformed options, failed reconversion with an older manifest still present, and an invalid existing manifest. Probe retained at `C:/Users/miche/AppData/Local/Temp/mwgp-harness-failure-probes.mjs`. |

Open gameplay issues are tracked in `roadmap.md`, under Gameplay verification follow-up.

## Common steps (every game)

- [x] Move: walk in all four directions; walls block, floors pass, no
  tile-glitch rendering (wrong autotile shapes, offset tiles).
- [x] Dialogue: talk to an NPC (action key); text shows fully, advances cleanly.
- [x] Choice: trigger a Show Choices event; every branch runs, cancel (where
  allowed) takes the cancel branch.
- [x] Transfer: walk through a door/edge transfer; the next map loads with the
  player at the right position and state (switches/variables/gold) intact.
- [x] Save/load: `F5` saves slot 1, `F9` loads it; position and progress survive
  a page reload.
- [x] Banner review: note the compatibility warning shown at launch; every
  `unsupported`/`partial` entry must match the manifest's
  `compatibility.commands` report for that game. (Reset to open after the
  2026-09-20 reconversion: new manifests, new banner check required.)
- [~] MV/MZ web builds (since 2026-09-27, the `convert:auto` default): the game's
  own engine runs, so titles, menus, battles, message windows and plugin
  commands are the game's. The harness checks boot, a new game on a map and a
  save across reload for each. Hand-check per game: a longer play session,
  audio, and the game's own save/load screens. (The MWGP rows below still apply
  to `--mwgp` conversions.)
- [~] RGSS runtime compatibility: Ruby hash iteration, native array properties,
  Ruby `gsub`/`File.extname`, `yield` inside blocks, and the game's own
  `self.inline` text filters (Void's rival tokens) are covered by regression
  smoke checks; framework helpers are the game's own code, never stand-ins.
  Verify additional scenes manually.

## Per-game rows

### Karryn's Prison (MV)

- [x] Opening map renders without the tile glitch.
- [~] The manifest now has no `unsupported` command codes; command `351` is
  partial because only Save/Close are implemented in the compact menu.
- [~] All 20 plugin-command words are handled by the game's own plugins
  (`compatibility.plugins[*].handledBy`: `Tachie` → Saba_Tachie,
  `TE_CALL_MAP_EVENT` → TemplateEvent, `MWL_*` → FTKR_MessageWindowLines,
  `MapScrollDisable` → AKUNOU_MapScrollDisable, …). Open: check in the browser
  that `TE_CALL_MAP_EVENT` (229 uses) still runs the called page (it was a
  native adapter before 2026-09-27), and note which commands now fail loudly.
- [x] Web build: the native title (the game's own MOG/Remtairy picture-command
  menu at 1280×720 art, all six entries) renders identically; New Game shows the
  opening disclaimer scene; harness: new game on map 32, save/reload/load OK.
  Steam/Discord entries and the file logger are desktop-only (no-op / logged).
- [~] MV command `351` now opens a compact Save/Close menu and is reported
  partial instead of unsupported; verify the menu during play.
- [x] Common steps above.

### Way of Corruption 0.33 A (MV)

- [x] Opening map renders.
- [x] Music plays (BGM path resolves); sound effects also play.
- [~] Web build: boots to its own title, harness new game on map 24,
  save/reload/load OK; its `Quest` commands run in its own YEP_QuestJournal.
  Check a quest-log update by hand.
- [x] Common steps above.

### Pokemon Void 0.1.4 (XP)

- [x] Opening map renders (XP autotiles via the `isXp` path).
- [x] The current Ruby transpiler has no failed or partial library units in
  this game's regenerated manifest (3,487 reachable units); runtime equivalence
  still depends on the open human-paced rewalk below.
- [~] Passage data blocks walls and allows door/stair targets; the layered
  passage rule is covered by `npm test` against the shipped `Game_Map#passable?`
  convention (set bit = blocked), but a complete manual walk remains open.
- [x] Trainer NPC dialogue runs; self-switch pages flip after events.
- [x] 2026-10-19 fresh encrypted-archive conversion: 513 Ruby sources, 3,487
  reachable library units (0 failed or partial), and 1,455/1,455 event scripts.
  The manifest validates. After fixing Ruby zero-argument calls,
  `const_defined`, `$gameSystem=`, Hash `keys`, and block `yield` semantics, the
  fresh 90-second soak reaches two maps and 11 dialogues with zero console
  errors, skipped Ruby calls, or failed scripts; the browser map sweep boots
  all 55 maps. Human-paced rewalk remains open.
- [ ] After the 2026-09-27 shim removal: stock title (`Graphics/Titles/title`)
  instead of the recreated splash/Load menu; the player is a placeholder tile
  (the start actor's charset does not ship; the game sets its look in its own
  code); script messages go through the game's own `pbMessage` windows; party
  size reads 0 (no RPG Maker party). Re-walk the intro and note what changed.
- [x] Common steps above.

### Pokemon Void 0.1.5 (encryptionfix) (XP)

- [x] Opening map and dialogue render; inline markup and progressive reveal
  were verified. Door/stair collision and blocked `touch` event handling are
  covered by data-level regression checks.
- [x] The current Ruby transpiler has no failed or partial library units in
  this game's regenerated manifest (3,525 reachable units); runtime equivalence
  still depends on the open human-paced rewalk below.
- [x] 2026-10-19 encrypted-archive conversion: `Game.rgssad` yielded 531 Ruby
  sources; the full converter produced a valid 57-map manifest, transpiled all
  3,525 reachable library units with 0 failed/partial units, and converted
  all 1,699 event scripts. The output is installed under `MWGP_versions`;
  browser startup, save/load, title, and audio passed with zero console errors,
  all 57 maps booted. After fixing Ruby zero-argument calls, `const_defined`,
  `$gameSystem=`, Hash `keys`, and block `yield` semantics, the fresh 90-second
  soak reaches two maps and 12 dialogues with zero console errors, skipped Ruby
  calls, or failed scripts; the browser map sweep boots all 57 maps. Human-paced
  rewalk remains open.
- [x] Same as 0.1.4 for the remaining manual steps (including the 2026-09-27
  shim-removal row); note differences in the result log.

### Elementals (MZ)

- [x] Opening map renders; the real mwg scene starts (no fallback renderer), 0 console errors.
- [x] Move: keyboard input moves/turns the player on map 1, and on map 2 after the transfer
  (ArrowDown walked 11,3 -> 11,6).
- [x] Dialogue: the full opening sequence advances line by line (progressive reveal): controls
  pages, tutorial text, element intro, closing confirmation.
- [x] Choice: three choice scenes run with different branches sampled — `List other Controls` /
  `Continue`, `Elements` / `Character Stats`, and the 5-option element picker. These choices
  disallow cancel (`cancel: -1`), so no cancel branch exists to test here.
- [x] Transfer: map 1 -> map 2 lands at exactly (11, 3) with state intact — gold 5 -> 20,
  party [1] -> [3] (the chosen element's dedicated character), through the SaveSystem reload.
- [x] Save/load: F5/F9 round trip passes in the harness; slots 2 and 4 keep independent
  save summaries.
- [x] Banner review: 57/57 command codes `supported`, 0 plugin families, no `unsupported`
  markers anywhere in the events — there is nothing for the compatibility banner to warn about.
- [x] Battle: the weakest troop (50, a 10 HP Crab) resolves as `win` through the real dialogue
  UI with the enemy sprite drawn; `npm test`'s sweep additionally fights all 58 Elementals
  troops (323 across the MV/MZ corpus).
- [x] MZ data shapes: the new `npm test` MZ fixture asserts six width-major normalized layers
  per map (sentinel values stripped), the battle-runner database tables, and 357 never filed
  `unsupported`.
- [x] MZ plugin commands (357): Elementals ships an empty `js/plugins.js` (0 plugins) and uses
  no 357 commands — the real-project path is "no uses". Conversion of real 357 calls stays
  covered by the synthetic MZ probe in `npm test`.
- [~] Common steps' breadth: all 89 maps boot in the harness map sweep and 60 s / 180 s soaks
  run clean, but nobody has hand-walked all 89 maps end to end.

## Result log

| Date | Game | Pass/fail | Notes |
| --- | --- | --- | --- |
| 2026-09-19 | Karryn's Prison | partial | Banner OK; movement OK; earlier run showed tile/sprite misalignment (head at feet, general across tiles). Rechecked 2026-09-20: opening map and character feet now visually align; a down input moved the camera/player; full dialogue/transfer/save checklist remains open. |
| 2026-09-20 | Way of Corruption 0.33 A | partial | Player boots and compatibility banner is visible; manifest validation and command-routing smoke tests pass. Music, dialogue, choices, transfers, and save/load still need a manual run. |
| 2026-09-20 | Pokemon Void 0.1.4 | partial | Opening XP player and name-entry flow verified; manifest validation and XP metadata/autotile checks pass. Trainer dialogue, stairs/doors, choices, transfers, and save/load still need a manual run. |
| 2026-09-20 | Pokemon Void 0.1.5 (encryptionfix) | partial | Direct map-14 dialogue verified: progressive text, inline emphasis, clean advance; final confirm no longer retriggers the same action event. Collision fix now resolves map-14 door/stair data as door=true, wall=false, stair=true and triggers blocked player-touch events. Full browser transfer/save checklist remains open. |
| 2026-09-20 | Browser launch sweep (all 4 MWGP games) | pass | `npm start` launcher listed all four converted projects. Karryn's Prison, Pokemon Void 0.1.4, Pokemon Void 0.1.5 (encryptionfix), and Way of Corruption each opened the player page and showed the compatibility banner with manifest-specific command counts. Karryn's opening map visibly rendered and remained rendered after an ArrowDown input. Music and sound were observed only in Way of Corruption; full per-game interaction rows remain open. |
| 2026-09-20 | Full reconversion | pass | `npm run convert:auto -- RPGM_versions MWGP_versions` regenerated all 4 projects (0 skipped, 0 failed), including MV assets and RGSS script output. `npm test` then validated all regenerated manifests, compatibility reports, runtime routing, XP metadata/autotiles, and the server catalog. Manual playthrough rows remain unchanged. |
| 2026-09-20 | Automated regression suite | pass | `npm test` validates all 4 manifests, compatibility reports, command routing, character geometry, layered passage resolution, the server catalog, player-state condition branches, game-data variable operands, battle-fallback outcomes, and loud-fallback marker handling. It does not replace the manual playthrough rows above. |
| 2026-09-20 | Reconverted manifests audit (all 4) | pass | All four `mwgp.json` revalidated after reconversion with the current converters. Karryn now carries 350 converted common-event definitions and 3,978 runtime references with zero `117` truncation markers; WoC carries 4 definitions with zero markers. XP 0.1.4: facing 6, gold 18, gameData 10, zero markers. XP 0.1.5: facing 10, gold 31, gameData 10, zero markers. Banner review reset to open (new manifests). |
| 2026-09-20 | Browser banner after final RGSS reconversion | pass (source + browser) | Cache-busted Pokemon Void 0.1.4 reload now reports only its six partially supported MV/XP command groups plus `partially transpiled RGSS library units: 4`; the former `failed RGSS library units: 1` text is gone. Browser error log remained empty. |
| 2026-09-20 | Common-event runtime references | pass (source/data) | MV code 117 no longer expands recursively to a depth-8 cutoff. Converted common events live in `commonEvents`, execute synchronously through the same player runner, and stop only after a 32-level recursion guard. |
| 2026-09-20 | RGSS library failure visibility | pass (source/data) | XP manifests expose `compatibility.scripts.libraryFailed` and independently usable merged pieces in `compatibility.scripts.libraryPartial`; `npm test` checks the failure field and the browser banner reports both counts. After the setter-assignment repair, both XP manifests report 0 failed units, with 4 partial units in 0.1.4 and 5 in 0.1.5. |
| 2026-09-20 | RGSS library transpiler repair | pass (source/data) | Fixed receiver-less Ruby `respond_to?(:helper)` lowering, Ruby exception inheritance, block-bearing getters, splatted returns, `super.[]=`, parallel attribute assignment, safe-navigation assignment, mutable zero-argument setter targets, and per-piece class/module merging when a plugin reopening cannot be merged as one unit. Full reconversion now produces zero hard RGSS library failures in all four manifests. |
| 2026-09-20 | Remaining Essentials library triage | open, explicit | `BattleCreationHelperMethods`, `Battle`, `PokemonSummary_Scene`, `PokemonSprite`, and (only in 0.1.5) `PBEffects` remain explicitly partial through merged pieces. `SelfGymGauntlet` now transpiles successfully; the remaining work is targeted runtime verification of the partial units, not a hidden hard failure. |
| 2026-09-20 | RGSS runtime bridge regression | pass (source + browser) | Added iterable Ruby hash adaptation without eager getter execution, including a frozen-hash `.keys` snapshot required by Essentials token tables; protected native JS properties from Ruby zero-argument call rewriting; and added Ruby `String#tr`, `String#capitalize`, regex `gsub`, `File.extname`, and a filesystem-safe RTP fallback. `npm test` now covers 19 RGSS runtime checks; the XP browser scene reloaded without new RGSS errors. |
| 2026-09-20 | Essentials lazy-library initialization / dialogue tokens | pass (source + browser) | Hoisted literal constants referenced before their Ruby script definition (including `Settings::MECHANICS_GENERATION`), made missing known library methods loud callable stubs, and fixed Ruby2JS Hash `.keys` access used by `VoidRivals.inline`, so `{d}`/`{c}` tokens no longer remain literal or throw during browser rendering. |
| 2026-09-20 | Karryn plugin-command census | improved (source/data) | `FD_START_SITE`, `RefreshMiniLabel`, and `STS` now persist safe portable state instead of warning and being skipped; the reconverted manifest reports these specialized UI commands as partial. Unknown plugin families still remain loud. |
| 2026-09-20 | House stairs / dialogue input lock | pass (source + browser) | A short-expiring `confirmLock` prevents the closing key from retriggering an event without freezing input when a browser loses `keyup`. In Pokemon Void map 14, the player descended from the stair-side position, moved through the room, and transferred to map 3. |
| 2026-09-20 | Dialogue/plugin handling | pass (source/data) | `MessageRows`, `MWL_CHANGE_LINES`, `MWL_RESET_LINES`, and `ChoiceRect` are now classified as partial and routed through tested adapters. The 3 Karryn `指定位置にアニメーション表示` calls now convert to native `animationAt`; browser scenes still need manual confirmation. |
| 2026-09-20 | MV menu command 351 | pass (source/data) | Karryn's only previously unsupported MV command now opens a blocking Save/Close menu; its report is partial because the full RPG Maker inventory/status menu is not reproduced. |
| 2026-09-20 | Transfer/save hardening | pass (source/data) | `transfer()` validates the target (unknown map or non-numeric coords stay put with a warning) and clamps into the map; boot transition and `loadGame` ignore corrupt saves with a loud message instead of throwing. `npm test` covers 8 transfer/save validation checks; both MV manifests still validate. |
| 2026-09-20 | MZ 357 plugin commands | pass (source/data) | MZ code 357 (`[plugin, command, label, args]`) converts to the existing `pluginCommand` vocabulary, tallies under the command name, and reports partial; a synthetic MZ fixture converts with zero loud markers and validates. `npm test` covers 5 MZ probe checks + manifest validation. No real MZ project on disk yet — full playthrough remains open. |
| 2026-09-20 | Elementals tile-shape validation | pass (source/data) | New MZ project Elementals (89 maps) failed validation: layer-4 shadow bitflags (e.g. `0x80000000`-based) and overlong map arrays, both copied verbatim from source. Validator now checks tile ids on layers 0-3 only and requires at least six layers' worth of data. Manifest validates; `npm test` green over all 5 projects including 4 malformed-event input checks. |
| 2026-09-26 | Full reconversion | pass | `npm run convert:auto -- RPGM_versions MWGP_versions` regenerated all 5 projects (5 converted, 0 skipped, 0 failed). `npm test` green afterwards: all 5 manifests validate, 323-troop battle sweep, command routing, server catalog. Banner review reset to open (new manifests). |
| 2026-09-26 | Compatibility banner review (all 5) | open, explicit | New vs 2026-09-20: Karryn's Prison carries 2 loud `unsupported` markers, both MV code 339 kind 0 in troop events 68 and 91 (no `compatibility.commands` entry for 339); command 351 is now `supported` (was partial), 355 (466) and 356 (4178) stay partial. Both Pokemon Void manifests report 6 failed RGSS library units (`BootStatement_435`, `RandomDungeon`, `EventIndicator`, `SpriteWindow_DebugVariables`, `PBAnimations`, `Game_FollowerFactory`) where the 2026-09-20 audit had 0, and `PokemonSystem` is newly partial in both (0.1.4: 5 partial; 0.1.5: 6 partial incl. `PBEffects`). Elementals is clean (no unsupported/partial). Way of Corruption unchanged (356/Quest partial, 989). |
| 2026-09-26 | T152 map-sweep shapes (Void/Karryn/WoC) | pass (source + browser) | `pbExclaim` failed to load (duplicate top-level function across merged pieces vs the runtime's `with(scope)` compile) and `event.at_coordinate` degraded (manifest `methods` kept raw `?` names the runtime looks up stripped): both fixed in `tools/rgss-library.mjs` with smoke regression checks, manifests reconverted, `npm test` green. `pbExclaim`/`pbWalkCharacterTo`/`pbCameraFollowEvent` run end to end in Node; Void maps 3/14 and WoC 32/332/426/446 boot PASS in Chromium with no console errors. Karryn map 31's `setWardenMapPoseExtensions` log is the game's own guard on unset pose (`-1`) under mid-game `skipTitle` boots and recovers by design. |
| 2026-09-26 | Elementals (MZ) playthrough — T121 | pass (browser) | Full opening played through in Chromium: three choice scenes with both branches sampled, tutorial text with progressive reveal, and the map 1 → map 2 transfer landing at exactly (11, 3) with state intact (gold 5 → 20, party [1] → [3]) after the SaveSystem page reload; movement works on the new map. Battle: weakest troop 50 (Crab 10 HP) resolves `win` through the dialogue UI with the enemy sprite drawn. Harness: boot PASS with 0 console errors, 89/89 maps boot, 60 s and 180 s soaks clean (1 dialogue, no errors), F5/F9 save/load and slots 2/4 independent, menu Item/Status walked. Banner: 57/57 command codes `supported`, 0 plugins, no `unsupported` markers. |
| 2026-09-26 | MZ fixture in `npm test` — T121 | pass (source/data) | New `rpg-maker-mz` branch in the per-project smoke loop asserts what only a real MZ project can: every map carries exactly `width*height*6` normalized tiles (MZ signed sentinel values stripped by `normalizeMZMapData`), the battle-runner database tables exist when a party is configured, code 357 is never reported `unsupported`, and plugin census statuses are well-formed. Elementals passes all 4 checks. Finding: Elementals ships an empty `js/plugins.js` (0 plugins, 0 uses of 357), so "357 against a real MZ plugin set" is honestly *no uses* in this corpus; the synthetic MZ probe keeps covering conversion of real 357 calls. |
| 2026-09-26 | T121 observations (open, explicit) | open, explicit | Two follow-ups seen only under bot input, not in paced play or any harness run: (1) hammering Enter (~90 confirms) on the "List other Controls" loop raises repeated `TypeError: Cannot read properties of null (reading '_getFinalPadding')` console errors from `mwg`' `_updateGpuText` (Pixi text path) — non-fatal, game keeps running, 0 occurrences in paced play/soaks; worth an upstream note. (2) 2 of 5 scripted opening runs stalled mid-sequence (dialogue open, confirm ignored, gold stuck at 5) — intermittent, never reproduced at harness pacing; needs a human-eye check on the tutorial text pages. Also noted for T126: the harness prints only `notes.slice(0, 2)`, so the battle/audio notes are truncated from PASS output. |
| 2026-09-26 | Karryn door teleport (map 35) | pass (browser) | Two stacked bugs, both fixed in `src/player/player-core.js` with smoke rows: autorun events ran only at map boot, never after a page finished, so ev7 never fired after the door choice (`refreshAutorunEvents` on page completion, skipped during cross-map transfer); and ev7's forced-save loop gates on `$gameSystem._saveCount`, which no save ever incremented (`noteEngineSave` in `saveGame`, snapshotted synchronously so it rides saves/transfers). `menu:save` (code 352) now prompts for a slot (`promptSaveGame`) instead of silently overwriting the last slot. Played end to end in Chromium: choice → door scene → save prompt → slot picker → count 0→1 → prologue ask → transfer to map 17 (18,20). |
| 2026-09-26 | Karryn dialogue text codes | pass (browser) | Converter now resolves sidecar `loc` tables inside `pluginCommand` args/raw (split first so multi-word entries don't shatter positionals): all 440 leftover `\REM_MAP` keys resolve (Tachie portrait names are real text), reconverted manifest validates, shipped manifest transplanted with its asset/audio sections preserved. Player runs the game's own `TextManager.convertExtraEscapeCharacters`/`convertEscapeCharacters` before the built-in escapes (quiet probe, one loud warning then self-disable): dynamic `\REM_AVR`/`\REM_FR` resolve live (`2`, `25%`). `if` without `else` now converts with `else: []` (both converters) and prepares quietly (613 sites in Karryn were warning per evaluation). |
| 2026-09-26 | Elementals black tiles (maps 46/76) | authored, faithful | The map-46 blobs are wall-of-fire A2 autotiles (kind 20, shapes 44-46): the source sheet block holds exactly that black-with-orange-fringe art and the engine samples the same block for the same tile id, so the original shows the same pits. Map 76 screenshots clean (sand/castle render, no black cells). No renderer change; layer-4 shadows stay unrendered (known gap, floors read brighter, opposite symptom). |
| 2026-09-26 | Karryn foreground mist (33 maps) | pass (browser) | The prison's haze is Foreground.js `<fgName:Mist_1/Mist_3>` (plus `!Clouds`, loop/scroll speeds, A/B switch layers) drawn over characters. Converter parses the tags into `data.settings` and decodes referenced `img/parallaxes` art (`assets.parallaxes`); player renders a screen-space tiling layer with the plugin's switch gates and zero/loop scroll rates. Map 35 boots with the layer visible and drifting, no console errors; `npm test` pins the parse, the pick and the origin math. The shipped mist art is faint by authorship (mean alpha ~26/255), so the veil stays subtle, as in the engine. |
| 2026-09-26 | Karryn dev-badge tiles (map 35) | pass (browser) | The green "TE ✗ Edicts" boxes are E-sheet tiles (814/822/834/835) sampling Karryn's `BBgradation2` dev-marker sheet. Root cause is ours: `tileToFrame` addressed B-E sheets row-major-16 while the engine (`rpg_core` `_drawNormalTile`, both renderers) uses 8-column halves (`col = (floor(id/128)%2)*8 + id%8`, `row = floor((id%256)/8)%16`), so we landed on badge art where the engine samples empty cells. Fixed via exported `normalTileFrame` (pinned in `npm test` incl. a tileToFrame routing check); map 35 now shows clean wall with 0 green pixels where ~7,500 rendered before, suite green. |
| 2026-09-26 | Karryn's Prison playthrough — T113 | pass (browser) | Harness full run PASS (0 console errors; launch banner `355×466, 356×4178` plus Tachie/MapScrollDisable/MWL_* plugin families, 2 loud `unsupported` = MV `339` kind 0 in troop events 68/91) and 90 s soak PASS (maps 32→35 through the autorun transfer, 2 dialogues, a battle ran with the skill-formula fallback note). Probes: with the harness key-hold recipe movement walks map 1 (3,7)→(3,6)→(5,6), a wall blocks further down (turn-in-place) and left walks back; the story event at (4,10) opens its full text from a neighbour, advances and closes; the map-2 door action event transfers to map 1 exactly (3,7) with gold/party intact; the map-35 Secretary Mode ask shows its 2-option list and the `No` pick flips switch 106 false→true with the box closing, 0 page errors. Audio probe green (BGM/BGS/ME/SE playing, context running, no warnings); by-ear listening is the only residual. |
| 2026-09-26 | Way of Corruption 0.33 A playthrough — T113 | pass (browser) | Harness full run PASS (0 errors; banner `356×989`, 356/Quest partial) + 90 s soak PASS (maps 24→14 autorun transfer, 4 dialogues). Probes: hold-recipe movement from the map-1 arrival (25,7) steps, and an edge touch puts the player back on map 1 at (1,17) where left walks to (0,17); the "Serious Vendor" dialogue opens with its speaker text and advances 14 pages; the map-1 touch transfer (2,17) lands exactly map 2 (25,7) with state delta 0; the hair-choice ask shows ["Nora with hair", "Nora without hair"], the pick registers (switch 5 flips false→true) and its 6-question chain was still mid-run when observation stopped. Audio probe green incl. boot autoplay (map BGM reaches position 1.02 s). |
| 2026-09-26 | Pokemon Void 0.1.4 playthrough — T113 | pass (browser) | Harness full run PASS (0 errors; banner `111×258, 122×117, 123×105, 125×19, 202×100, 204×2; failed RGSS units 6, partial 5`) + 90 s soak PASS (2 maps, 11 dialogues). Probes: movement on map 3 walks (14,48)→(16,48) with a wall blocking further east; the map-2 NPC dialogue opens ("Route 1!"); the trainer touch event (25,32) opens its own 3-line dialogue and advances cleanly (its battle branch throws — see the findings row); self-switch `self:2:7:A` flips true from its action event; the blocked touch tile (2,50,7) fires on bump into it and, after screenTint+wait, lands map 10 exactly (36,43); the Lillia Yes/No ask shows its list, the pick runs branch 0 (both says appear verbatim) and the event closes, 0 page errors. Audio probe green: MIDI "Battle Champion" renders via the shipped SoundFont (~0.8–1.0 s) and plays (game ships no BGS tracks). |
| 2026-09-26 | Pokemon Void 0.1.5 (encryptionfix) playthrough — T113 | pass (browser) | The same checklist with its own runs: harness full run PASS (0 errors; banner `111×339, 122×129, 123×123, 125×32, 202×100, 204×2; failed units 6, partial 6 incl. `PBEffects` — the only diff vs 0.1.4) and 90 s soak PASS (2 maps, 11 dialogues). Movement (3,25)→(2,25); the trainer dialogue opens and advances; `self:2:7:A` flips true; the bump transfer lands map 10 (36,43) exact with gold/party intact; the Lillia Yes/No branch 0 runs and closes clean; MIDI + SoundFont audio probe green. |
| 2026-09-26 | Audio programmatic check (4 remaining games) — T113 | pass (programmatic) | Against the live player: BGM, BGS, ME and SE all start (active node sets observed per kind), boot autoplay verified (Way of Corruption's map BGM at position 1.02 s), both Pokemon Voids load and play MIDI "Battle Champion" through the shipped SoundFont (~0.8–1.0 s render), audio context `running`, zero load/format/missing warnings, 0 page errors; every manifest carries `assets.audio=true` (Voids ship no BGS; only Voids ship MIDI). The harness's per-game BGM/format gates passed (they would fail the run), but its `notes.slice(0, 2)` truncation (T158) hides those lines. Listening by ear stays residual for michel. |
| 2026-09-26 | Compatibility banner review completed (all 5) — T113 | pass (browser + source) | Launch banners captured in the harness run match each manifest's `compatibility.commands`, with every entry justified at its classification source: Karryn 355/356 partial (bounded MV shim / unknown plugin APIs, comment at `buildCompatibilityReport` in `convert-mv.js`), its 2 loud `339`s are battle-only Transform Enemy with no commands entry by design; WoC 356/Quest partial (989); the Voids' partial codes are documented inline in `convert-rgss.js` (111 non-switch conditions, 122 operand kinds, 123 map/event context, 125 variable gold, 202 event-exchange, 204 battleback metadata) and the banner's failed/partial unit lists match `compatibility.scripts` (`BootStatement_435`, `RandomDungeon`, `EventIndicator`, `SpriteWindow_DebugVariables`, `PBAnimations`, `Game_FollowerFactory`); Elementals clean (57/57 supported, 0 plugins). Closes the review the 2026-09-26 reconversion reset. |
| 2026-09-26 | T113 findings (gap list) | open, explicit | (1) Pokemon Void's trainer *battle* branch throws after its dialogue: `TypeError: GameData.TrainerType.exists is not a function` then an `is not iterable` follow-on — the battle half belongs to the battle-gate task; the dialogue half runs. (2) An `ask` with an empty prompt consumes one confirm before its choice list appears (`advance()` → `showChoices()`), a small flow difference from RPG Maker seen in all four choice probes. (3) No `cancelBranch` exists in any of the 5 manifests (MV cancelType never maps to one), so "cancel where allowed" is corpus-wide N/A as with Elementals; branch coverage here is sampled (one branch per game plus Elementals' both). (4) Instant `keyboard.press` is unreliable under swiftshader — probes must use the harness's 300 ms key-hold (already documented in `test-browser.mjs`); start-map cutscenes likewise block early input, so movement is verified on real maps. |
| 2026-09-26 | Elementals tutorial hand-check — T157 | pass (human) | michel played the opening at human pace: every tutorial text advanced on a single Enter/Space, no stall across the +5G step, the "List other Controls" loop and the map 1 → map 2 transfer; a chest applied +40G to state. Gold is not shown on the map (engine-faithful — MV shows it only in Menu/Shop) and reads correctly in the menu (Esc) next to party HP. Verdict: the 2/5 scripted-run stalls were bot-pacing artifacts, not an input-lock bug. |
| 2026-09-26 | Elementals pond walkable (map 2) — T172 | faithful, no change | Human report: the hero walks onto the south pond. Data check: the whole pond is flagged passable+bush (0xE40) in the project's own tileset, so the shipped engine's `checkPassage` walks it too — our `passageAllowsStep` agrees cell for cell (probed all maps: 2229 passable / 1510 blocked A1 cells). Ruled authoring, not a collision or render bug. |
| 2026-09-27 | Game-specific shims removed (all 5) | pass (automated), manual re-walk open | Converters and player no longer name any game, framework or plugin (archive: `docs/removed-shims.md`). All 5 projects reconverted; `npm test` green (5/5 boot, 0 console errors; one Karryn run showed a Pixi `_getFinalPadding` text error that did not reproduce in two reruns); 90 s soaks PASS for all 5 with 0 runtime errors: Karryn 2 maps / 2 dialogues, WoC 2 / 4, Elementals 1 / 1, both Voids 1 map / 4 dialogues (down from 2 / 11-12 before: the intro now runs through the game's own message windows). Known regressions, accepted: Void stock title and placeholder player sprite, party size 0; Karryn stock 816×624 title and no `\REM_*` text codes. |
| 2026-09-27 | Generic fixes found by the removal | pass (automated) | XP 126–129 now change items/weapons/armor/party (they were dropped as Essentials dummies for every XP game); Ruby `yield` inside a block reaches the method's block (Void `RTP.eachPathFor` crashed without the removed RTP stand-in); plugins that handle plugin commands ship (Karryn: all 20 words matched to the game's own plugins, WoC `Quest` → YEP_QuestJournal); MZ 357 runs `PluginManager.callCommand`; the MV sandbox has an inert current scene; RGSS game title from `Game.ini`, screen size from the game's own `Graphics.resize_screen`. |
| 2026-10-19 | Pokemon Void 0.1.4 + 0.1.5 installed outputs | pass (automated browser) | Reconverted from encrypted Ruby script archives: 0.1.4 extracts 513 script sources and transpiles 1,455/1,455 event scripts; 0.1.5 extracts 531 and transpiles 1,699/1,699. Both manifests validate (55/57 maps); library transpilation has 0 failed and 0 partial units. Chromium startup/save/audio checks pass with 0 console errors; MIDI + SoundFont renders after reload. Earlier map sweeps passed 55/55 and 57/57; the latest fresh outputs passed the full 5/5 browser harness. Human-paced rewalk after this reconversion remains open. |
| 2026-10-19 | Void Ruby interoperability fixes | pass (automated browser) | Updated zero-argument method resolution, `const_defined`, `$gameSystem` aliasing, Hash `keys`, and Ruby `yield` inside nested blocks; regenerated both manifests from the encrypted archives. Boot probe builds `$player` with no warnings/errors; both manifests validate; Ruby regression tests pass. Fresh 90 s soaks: Void 0.1.4 2 maps / 11 dialogues and Void 0.1.5 2 maps / 12 dialogues, with 0 console errors, skipped Ruby calls, or failed Ruby scripts. Browser map sweeps boot all 55/55 and 57/57 maps. |
| 2026-10-19 | Full MWGP reconversion + compatibility banner review (R17) | pass (automated) | `npm run convert:auto -- RPGM_versions MWGP_versions --jobs 2 --mwgp`: 5 converted, 0 skipped, 0 failed. `npm run compat:review` agrees with the launch banners: Elementals clean; Karryn 355×466 and 356×4,178 partial; Way of Corruption 356×989 partial; Void 0.1.4 123×105, 125×19, 202×100, 204×2 partial; Void 0.1.5 123×123, 125×32, 202×100, 204×2 partial. All five have 0 failed/partial RGSS library units and 0 loud unsupported event markers. `npm test` passes: 5/5 Chromium boots, 0 console errors; each game's save gate and audio checks pass. A synthetic RGSSAD fixture verifies `convert:auto` detects and extracts `Game.rgssa`. Ruby nested labels inside blocks remain explicitly dropped by the converter warning; human rewalk remains open. |
| 2026-09-27 | Parallel `convert:auto` | pass | `npm run convert:auto -- RPGM_versions MWGP_versions` converts the 5 projects in parallel (one process each, `--jobs` defaults to the core count) with a progress bar per game: 103 s instead of about 10 minutes sequentially, 5 converted, 0 failed. |
| 2026-09-27 | MV/MZ web builds (Karryn, WoC, Elementals) | pass (browser harness) | `convert:auto` now builds MV/MZ games as web builds: the game's own engine and files plus the generic nw.js host layer (`src/web/nwjs-host.js`), served at `/web/<id>/` by `npm start` or any static host. Harness per game: boots to its own `Scene_Title`, a new game reaches a map (Karryn 32, WoC 24, Elementals 1), a save made there survives a page reload and loads (IndexedDB). Karryn's native title (MOG/Remtairy picture menu) renders identically to RPG Maker. Notes: Karryn's file logger logs a recoverable `ENOENT` for its `logs` folder; `assert` and the Steam binding are no-op host modules. |
| 2026-10-19 | T117 MV 111/122: operator order + Other counters | pass (automated browser) | The MV/MZ converter's variable-comparison table was in VX editor order (0 gte, 1 lte, 2 eq) while the shipped engines order it 0 eq, 1 gte, 2 lte (verified in `rpg_objects.js` v1.6.2 and `rmmz_objects.js`): every `==` branch converted to the native `atLeast` form (always true for non-negative values) and `>=`/`<=` swapped — a silent mis-evaluation of 230 of the 231 corpus comparisons (Karryn 95 of 96, WoC 18 of 18, Elementals 117 of 117), none of which was flagged `unsupported`. Fixed in `tools/convert-mv.js`; the player already evaluated all six operator names, so no routing change. Same pass gives Control Variables "Other" operands a player model: `steps` (counted at every landed player tile, walk and route), `playtime` (seconds while the map runs), `saveCount` (every successful save, rides saves), `battleCount`/`winCount`/`escapeCount` (troop runner) and `timer` (shares the Control Timer state); validator whitelists the new kinds and the MZ probe fixture + `npm test` now pin the operator order and all seven operands. `LAST_OUTPUT_CHANGE` and the converter stamp go to 0.2.1 (the three MV manifests read stale until reconverted); a page-condition `comparison 1` (`<=`) now warns instead of silently emitting `>=` (no corpus pages use it). All three projects reconverted with `--copy-assets`: manifests validate, 231/231 raw comparisons re-verified against the new shapes, and Chromium boots pass with 0 console errors (Karryn battle troop 32 win, WoC troop 3 lose, Elementals battle/menu/audio/save gates green). Human-paced branch rewalk at the corrected semantics stays open. The RGSS converters keep their own tables — the XP-side partials are `convert-rgss.js` territory (codex). |
| 2026-10-19 | `npm run play:all` (convert + boot + render/progression vs the original engine, MV/MZ; port-only for RGSS) | pass (automated browser) | Elementals/Karryn/Way of Corruption: render 83-99% of 8x8 colour blocks equal to the game's own web build on maps without dialogue (72% on Elementals' intro map, whose message window differs), progression 95-100% (maps, switches, variables reached). Fixed on the way: one `say` per Show Text window (401 lines merged, speaker, background/position), the stage keeps the game's screen size (plugin `Screen Width/Height` pairs read without naming a plugin: Karryn 1440x810, Way of Corruption 942x720), dim only for background type 1. Report: `reports/play-all/report.md`.
| 2026-10-19 | Pokemon Void 0.1.4 + 0.1.5 played past the intro (Ruby) | pass (automated browser), gaps explicit | New game -> character select -> customization -> map 14, player drawn (composed sheet written through `Bitmap#save_to_png` into an in-memory file system, kept across maps), walking, object dialogues, 45-90 s soaks 0 errors, saves in slots 2/4. Generic converter/runtime fixes found by playing: global `alias`+`def` chains in `module Kernel`, a Ruby block passed to a method with optional parameters, `yield` inside blocks of a method naming `&block`, `scan` answering `[]`, `a |= b` on arrays, conditional (`if method_defined?`) method and setter redefinitions, nested constants shadowed by a global class (`Player::Pokedex`), reader vs setter in alias resolution, reopened built-ins (`Numeric#to_s_formatted`), `sprintf`/`Kernel`, `Graphics.frame_count`, async awaiting of `this._scene.f()`. Covered by `tools/test-rgss-fixes.mjs` (12 checks, part of `npm test`).
| 2026-10-19 | Void gaps still open (Ruby) | open, explicit | (1) A wild battle started from a script (`WildBattle.start`) runs and returns but draws nothing: the RGSS overlay holds only hidden sprites without bitmaps. (2) The Essentials pause menu opens and navigates (index moves) but shows round buttons without labels or icons. (3) The Ruby original cannot be rendered headless (mkxp-z core draws black without a GPU), so Ruby rendering is not compared; Ruby runs are port-only. (4) No VX/Ace game is available locally, only synthetic fixtures. (5) Not played beyond the starting room.
| 2026-10-19 | Karryn's Prison escape codes (REM_*) + crash recovery | pass (source + browser) | Live-computed `\REM_*` codes the converter leaves literal now resolve at display through the game's own TextManager chain (`rgss.convertDisplayText`, the 149 shipped plugins evaluated 149/149); the converter's `no text-table entry` report is deferred to shipped-plugin mentions (KP: 10 noisy warnings -> 0). A crashed conversion (dead lock + orphan staging + missing output) no longer locks the folder: takeover, sweep and re-publish are regression-tested in `tools/test-studio-reconversion.mjs`; web-build guards distinguish stale from live locks. KP reconverted (79 maps, validates), browser harness + soak 70 s clean, 0 console errors. |
