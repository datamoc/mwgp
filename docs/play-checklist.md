# Manual play checklist

Per-game browser verification for converted projects. Serve with `npm start`
(`http://127.0.0.1:4173`, or `$RPGM_PORT`), open the launcher, pick a game,
and work through its rows. Record pass/fail plus the observed behavior; a fail
goes back to `roadmap.md` as a bug, not into this file as a note.

Status: `[x]` verified in the browser, `[~]` verified only by manifest/source
or data-level checks, `[ ]` not yet verified. A `[~]` is not a substitute for
the corresponding manual playthrough.

## Common steps (every game)

- [ ] Move: walk in all four directions; walls block, floors pass, no
  tile-glitch rendering (wrong autotile shapes, offset tiles).
- [ ] Dialogue: talk to an NPC (action key); text shows fully, advances cleanly.
- [ ] Choice: trigger a Show Choices event; every branch runs, cancel (where
  allowed) takes the cancel branch.
- [ ] Transfer: walk through a door/edge transfer; the next map loads with the
  player at the right position and state (switches/variables/gold) intact.
- [ ] Save/load: `F5` saves slot 1, `F9` loads it; position and progress survive
  a page reload.
- [ ] Banner review: note the compatibility warning shown at launch; every
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
- [ ] Common steps above.

### Way of Corruption 0.33 A (MV)

- [x] Opening map renders.
- [x] Music plays (BGM path resolves); sound effects also play.
- [~] `MessageRows` and `MWL_*` handling is covered by the shared player adapter;
  no matching `ChoiceRect` command was found in this manifest. Manual dialogue
  sizing remains open.
- [ ] Common steps above.

### Pokemon Void 0.1.4 (XP)

- [x] Opening map renders (XP autotiles via the `isXp` path).
- [~] No RGSS library unit fails conversion after the setter-assignment repair;
  four units remain explicitly partial through merged pieces and require
  targeted runtime scenes before being considered fully equivalent.
- [~] Passage data blocks walls and allows door/stair targets; the layered
  passage rule is covered by `npm test` against the shipped `Game_Map#passable?`
  convention (set bit = blocked), but a complete manual walk remains open.
- [ ] Trainer NPC dialogue runs; self-switch pages flip after events.
- [ ] Common steps above.

### Pokemon Void 0.1.5 (encryptionfix) (XP)

- [x] Opening map and dialogue render; inline markup and progressive reveal
  were verified. Door/stair collision and blocked `touch` event handling are
  covered by data-level regression checks.
- [~] No RGSS library unit fails conversion after the setter-assignment repair;
  five units remain explicitly partial through merged pieces and require
  targeted runtime scenes before being considered fully equivalent.
- [ ] Same as 0.1.4 for the remaining manual steps; note differences in the
  result log.

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
