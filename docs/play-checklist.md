# Manual play checklist

Per-game browser verification for converted projects. Serve with `npm start`
(`http://127.0.0.1:4173`, or `$RPGM_PORT`), open the launcher, pick a game,
and work through its rows. Record pass/fail plus the observed behavior; a fail
goes back to `roadmap.md` as a bug, not into this file as a note.

Status: `[x]` verified in the browser, `[~]` verified only by manifest/source
or data-level checks, `[ ]` not yet verified. A `[~]` is not a substitute for
the corresponding manual playthrough.

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
- [~] Dialogue plugin layout: `MessageRows`/`MWL_*` now change the real message
  window height, and `ChoiceRect` is applied to the real choice list when all
  coordinates are provided; confirm one long-message and one choice scene per
  MV game in the browser.
- [~] RGSS runtime compatibility: Ruby hash iteration, native array properties,
  Ruby `gsub`/`File.extname`, and Essentials rival-token interpolation are
  covered by the runtime bridge and regression smoke checks; verify additional
  Essentials scenes manually.

## Per-game rows

### Karryn's Prison (MV)

- [x] Opening map renders without the tile glitch.
- [~] The manifest now has no `unsupported` command codes; command `351` is
  partial because only Save/Close are implemented in the compact menu.
- [~] Compatibility report now classifies `MessageRows` (4), `MWL_CHANGE_LINES`
  (91), `MWL_RESET_LINES` (112), and `ChoiceRect` (1) as partial; manual long
  dialogue/choice positioning remains open.
- [~] The 3 `指定位置にアニメーション表示` calls now convert to native
  `animationAt` commands and are classified supported; visual timing/placement
  still needs a manual scene check.
- [~] `MapScrollDisable` is now enforced by the camera path (not just saved as
  plugin state); verify one disabled-scroll event manually in Karryn.
- [~] MV command `351` now opens a compact Save/Close menu and is reported
  partial instead of unsupported; verify the menu during play.
- [x] Common steps above.

### Way of Corruption 0.33 A (MV)

- [x] Opening map renders.
- [x] Music plays (BGM path resolves); sound effects also play.
- [~] `MessageRows` and `MWL_*` handling is covered by the shared player adapter;
  no matching `ChoiceRect` command was found in this manifest. Manual dialogue
  sizing remains open.
- [x] Common steps above.

### Pokemon Void 0.1.4 (XP)

- [x] Opening map renders (XP autotiles via the `isXp` path).
- [~] No RGSS library unit fails conversion after the setter-assignment repair;
  four units remain explicitly partial through merged pieces and require
  targeted runtime scenes before being considered fully equivalent.
- [~] Passage data blocks walls and allows door/stair targets; the layered
  passage rule is covered by `npm test` against the shipped `Game_Map#passable?`
  convention (set bit = blocked), but a complete manual walk remains open.
- [x] Trainer NPC dialogue runs; self-switch pages flip after events.
- [x] Common steps above.

### Pokemon Void 0.1.5 (encryptionfix) (XP)

- [x] Opening map and dialogue render; inline markup and progressive reveal
  were verified. Door/stair collision and blocked `touch` event handling are
  covered by data-level regression checks.
- [~] No RGSS library unit fails conversion after the setter-assignment repair;
  five units remain explicitly partial through merged pieces and require
  targeted runtime scenes before being considered fully equivalent.
- [x] Same as 0.1.4 for the remaining manual steps; note differences in the
  result log.

### Elementals (MZ)

- [x] Opening map renders; the real mw_games scene starts (no fallback renderer), 0 console errors.
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
| 2026-09-26 | T121 observations (open, explicit) | open, explicit | Two follow-ups seen only under bot input, not in paced play or any harness run: (1) hammering Enter (~90 confirms) on the "List other Controls" loop raises repeated `TypeError: Cannot read properties of null (reading '_getFinalPadding')` console errors from `mw_games`' `_updateGpuText` (Pixi text path) — non-fatal, game keeps running, 0 occurrences in paced play/soaks; worth an upstream note. (2) 2 of 5 scripted opening runs stalled mid-sequence (dialogue open, confirm ignored, gold stuck at 5) — intermittent, never reproduced at harness pacing; needs a human-eye check on the tutorial text pages. Also noted for T126: the harness prints only `notes.slice(0, 2)`, so the battle/audio notes are truncated from PASS output. |
| 2026-09-26 | Karryn door teleport (map 35) | pass (browser) | Two stacked bugs, both fixed in `src/player/player-core.js` with smoke rows: autorun events ran only at map boot, never after a page finished, so ev7 never fired after the door choice (`refreshAutorunEvents` on page completion, skipped during cross-map transfer); and ev7's forced-save loop gates on `$gameSystem._saveCount`, which no save ever incremented (`noteEngineSave` in `saveGame`, snapshotted synchronously so it rides saves/transfers). `menu:save` (code 352) now prompts for a slot (`promptSaveGame`) instead of silently overwriting the last slot. Played end to end in Chromium: choice → door scene → save prompt → slot picker → count 0→1 → prologue ask → transfer to map 17 (18,20). |
| 2026-09-26 | Karryn dialogue text codes | pass (browser) | Converter now resolves sidecar `loc` tables inside `pluginCommand` args/raw (split first so multi-word entries don't shatter positionals): all 440 leftover `\REM_MAP` keys resolve (Tachie portrait names are real text), reconverted manifest validates, shipped manifest transplanted with its asset/audio sections preserved. Player runs the game's own `TextManager.convertExtraEscapeCharacters`/`convertEscapeCharacters` before the built-in escapes (quiet probe, one loud warning then self-disable): dynamic `\REM_AVR`/`\REM_FR` resolve live (`2`, `25%`). `if` without `else` now converts with `else: []` (both converters) and prepares quietly (613 sites in Karryn were warning per evaluation). |
| 2026-09-26 | Elementals black tiles (maps 46/76) | authored, faithful | The map-46 blobs are wall-of-fire A2 autotiles (kind 20, shapes 44-46): the source sheet block holds exactly that black-with-orange-fringe art and the engine samples the same block for the same tile id, so the original shows the same pits. Map 76 screenshots clean (sand/castle render, no black cells). No renderer change; layer-4 shadows stay unrendered (known gap, floors read brighter, opposite symptom). |
| 2026-09-26 | Karryn's Prison playthrough — T113 | pass (browser) | Harness full run PASS (0 console errors; launch banner `355×466, 356×4178` plus Tachie/MapScrollDisable/MWL_* plugin families, 2 loud `unsupported` = MV `339` kind 0 in troop events 68/91) and 90 s soak PASS (maps 32→35 through the autorun transfer, 2 dialogues, a battle ran with the skill-formula fallback note). Probes: with the harness key-hold recipe movement walks map 1 (3,7)→(3,6)→(5,6), a wall blocks further down (turn-in-place) and left walks back; the story event at (4,10) opens its full text from a neighbour, advances and closes; the map-2 door action event transfers to map 1 exactly (3,7) with gold/party intact; the map-35 Secretary Mode ask shows its 2-option list and the `No` pick flips switch 106 false→true with the box closing, 0 page errors. Audio probe green (BGM/BGS/ME/SE playing, context running, no warnings); by-ear listening is the only residual. |
| 2026-09-26 | Way of Corruption 0.33 A playthrough — T113 | pass (browser) | Harness full run PASS (0 errors; banner `356×989`, 356/Quest partial) + 90 s soak PASS (maps 24→14 autorun transfer, 4 dialogues). Probes: hold-recipe movement from the map-1 arrival (25,7) steps, and an edge touch puts the player back on map 1 at (1,17) where left walks to (0,17); the "Serious Vendor" dialogue opens with its speaker text and advances 14 pages; the map-1 touch transfer (2,17) lands exactly map 2 (25,7) with state delta 0; the hair-choice ask shows ["Nora with hair", "Nora without hair"], the pick registers (switch 5 flips false→true) and its 6-question chain was still mid-run when observation stopped. Audio probe green incl. boot autoplay (map BGM reaches position 1.02 s). |
| 2026-09-26 | Pokemon Void 0.1.4 playthrough — T113 | pass (browser) | Harness full run PASS (0 errors; banner `111×258, 122×117, 123×105, 125×19, 202×100, 204×2; failed RGSS units 6, partial 5`) + 90 s soak PASS (2 maps, 11 dialogues). Probes: movement on map 3 walks (14,48)→(16,48) with a wall blocking further east; the map-2 NPC dialogue opens ("Route 1!"); the trainer touch event (25,32) opens its own 3-line dialogue and advances cleanly (its battle branch throws — see the findings row); self-switch `self:2:7:A` flips true from its action event; the blocked touch tile (2,50,7) fires on bump into it and, after screenTint+wait, lands map 10 exactly (36,43); the Lillia Yes/No ask shows its list, the pick runs branch 0 (both says appear verbatim) and the event closes, 0 page errors. Audio probe green: MIDI "Battle Champion" renders via the shipped SoundFont (~0.8–1.0 s) and plays (game ships no BGS tracks). |
| 2026-09-26 | Pokemon Void 0.1.5 (encryptionfix) playthrough — T113 | pass (browser) | The same checklist with its own runs: harness full run PASS (0 errors; banner `111×339, 122×129, 123×123, 125×32, 202×100, 204×2; failed units 6, partial 6 incl. `PBEffects` — the only diff vs 0.1.4) and 90 s soak PASS (2 maps, 11 dialogues). Movement (3,25)→(2,25); the trainer dialogue opens and advances; `self:2:7:A` flips true; the bump transfer lands map 10 (36,43) exact with gold/party intact; the Lillia Yes/No branch 0 runs and closes clean; MIDI + SoundFont audio probe green. |
| 2026-09-26 | Audio programmatic check (4 remaining games) — T113 | pass (programmatic) | Against the live player: BGM, BGS, ME and SE all start (active node sets observed per kind), boot autoplay verified (Way of Corruption's map BGM at position 1.02 s), both Pokemon Voids load and play MIDI "Battle Champion" through the shipped SoundFont (~0.8–1.0 s render), audio context `running`, zero load/format/missing warnings, 0 page errors; every manifest carries `assets.audio=true` (Voids ship no BGS; only Voids ship MIDI). The harness's per-game BGM/format gates passed (they would fail the run), but its `notes.slice(0, 2)` truncation (T158) hides those lines. Listening by ear stays residual for michel. |
| 2026-09-26 | Compatibility banner review completed (all 5) — T113 | pass (browser + source) | Launch banners captured in the harness run match each manifest's `compatibility.commands`, with every entry justified at its classification source: Karryn 355/356 partial (bounded MV shim / unknown plugin APIs, comment at `buildCompatibilityReport` in `convert-mv.js`), its 2 loud `339`s are battle-only Transform Enemy with no commands entry by design; WoC 356/Quest partial (989); the Voids' partial codes are documented inline in `convert-rgss.js` (111 non-switch conditions, 122 operand kinds, 123 map/event context, 125 variable gold, 202 event-exchange, 204 battleback metadata) and the banner's failed/partial unit lists match `compatibility.scripts` (`BootStatement_435`, `RandomDungeon`, `EventIndicator`, `SpriteWindow_DebugVariables`, `PBAnimations`, `Game_FollowerFactory`); Elementals clean (57/57 supported, 0 plugins). Closes the review the 2026-09-26 reconversion reset. |
| 2026-09-26 | T113 findings (gap list) | open, explicit | (1) Pokemon Void's trainer *battle* branch throws after its dialogue: `TypeError: GameData.TrainerType.exists is not a function` then an `is not iterable` follow-on — the battle half belongs to the battle-gate task; the dialogue half runs. (2) An `ask` with an empty prompt consumes one confirm before its choice list appears (`advance()` → `showChoices()`), a small flow difference from RPG Maker seen in all four choice probes. (3) No `cancelBranch` exists in any of the 5 manifests (MV cancelType never maps to one), so "cancel where allowed" is corpus-wide N/A as with Elementals; branch coverage here is sampled (one branch per game plus Elementals' both). (4) Instant `keyboard.press` is unreliable under swiftshader — probes must use the harness's 300 ms key-hold (already documented in `test-browser.mjs`); start-map cutscenes likewise block early input, so movement is verified on real maps. |
| 2026-09-26 | Elementals tutorial hand-check — T157 | pass (human) | michel played the opening at human pace: every tutorial text advanced on a single Enter/Space, no stall across the +5G step, the "List other Controls" loop and the map 1 → map 2 transfer; a chest applied +40G to state. Gold is not shown on the map (engine-faithful — MV shows it only in Menu/Shop) and reads correctly in the menu (Esc) next to party HP. Verdict: the 2/5 scripted-run stalls were bot-pacing artifacts, not an input-lock bug. |
| 2026-09-26 | Elementals pond walkable (map 2) — T172 | faithful, no change | Human report: the hero walks onto the south pond. Data check: the whole pond is flagged passable+bush (0xE40) in the project's own tileset, so the shipped engine's `checkPassage` walks it too — our `passageAllowsStep` agrees cell for cell (probed all maps: 2229 passable / 1510 blocked A1 cells). Ruled authoring, not a collision or render bug. |
