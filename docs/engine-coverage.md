# Engine coverage: documented RPG Maker features vs what mwgp converts

Per-engine validation of the documented RPG Maker feature surface against what the
converters produce and the player runs. Sources live in `notes/rpgmaker-docs/`
(`sources.md` lists the originals); the 2000/2003 layouts are pinned against the
EasyRPG sources (`liblcf-eventcommand.h`, `liblcf-movecommand.h`,
`lcf-command-params.md` extracts from the local reference checkout
`C:/Users/miche/dev/EasyRPG/Player/src`) and against the real command streams of
the two installed LCF projects.

Status words: **converted** = emits a vocabulary command the player implements;
**partial** = the command goes through but a sub-feature does not (listed);
**loud** = an explicit `{ unsupported }` marker that warns and takes the
else-branch — never a silent drop.

## RPG Maker 2000/2003 (`tools/convert-lcf.mjs`)

Measured on the installed corpus (2026-10-31): **1 529 029 commands in Shadow's
Penance, 0.26 % markers; 5 579 863 in Theia, 0.7 % markers.** Everything below is
checked against `liblcf`'s `rpg::EventCommand` enum (~128 core codes; the
Maniac_*/EasyRpg_* patch codes 3000+/2000+ stay loud by policy).

### Event commands

| Documented code | Status | Notes |
| --- | --- | --- |
| 10110/20110 Show Message | converted | lines 10110+20110 merge into one `say`; carries the pending portrait (10130) |
| 10120 Message Options | converted | transparent→frame 2, position; position-fixed/continue-events are stored only by the player's message box |
| 10130 Change Face Graphic | converted | face persists across the page's messages like the engine's message system; right-position/flip not reproduced (partial) |
| 10140 Show Choice (+20140/20141) | converted | per-option branches, like MV |
| 10150 Input Number | converted | digits = p[0], variable = p[1] (was reversed before this pass) |
| 10210 Control Switches | converted | on/off; toggle (2) is loud |
| 10220 Control Variables | converted | fixed this pass: the real layout is [targetMode, first, last, op, operandType, val1, val2] — the previous converter read op/type/value from p[2]/p[3]/p[4] and silently wrote wrong values into wrong variables. Now: set/add/sub/mult/div/mod; operands constant, variable, random, item/weapon/armor count, and the "Other" counters (gold, timer, party size, saves, battles, wins, escapes) and the player's map position. Indirect targets/values and actor-stat reads are loud |
| 10230 Timer Operation | converted | start/stop; the 2003 second timer (p[5]) is loud — the player runs one timer |
| 10310 Change Gold | converted | |
| 10320 Change Items | converted | fixed: id is p[2] (not p[0]); unified-id classification picks `changeItem`/`changeWeapon`/`changeArmor` |
| 10330 Change Party Member | converted | fixed: actor id is p[2]; add/remove from p[0] |
| 10410 Change Exp | converted | via `changeActorStat` exp; level-up messages not shown (partial) |
| 10420 Change Level | converted | |
| 10430 Change Parameters | converted | via `changeActorStat` param (bonus) |
| 10440 Change Skills | converted | learn/forget; variable skill id is loud |
| 10450 Change Equipment | converted | specific item (classified) and remove-from-slot; optimal equip (2/3) and party-wide scope are loud |
| 10460 Change HP | converted | with allow-death flag |
| 10470 Change SP | converted | via `changeActorStat` mp |
| 10480 Change Condition | converted | add/remove state |
| 10490 Full Heal | converted | |
| 10500 Simulated Attack | loud | no engine-free formula; the runner's battle commands cover real battles |
| 10610/10620 Change Hero Name/Title | converted | via `changeActorText` |
| 10630 Change Sprite Association | converted | via `changeActorImages`; the transparent flag is partial |
| 10640 Change Actor Face | converted | via `changeActorImages` (full record re-emitted) |
| 10650 Change Vehicle Graphic | converted | `systemFlag vehicleImage:<n>` (stored, like MV 323) |
| 10660 Change System BGM | converted | title/battle/victory/defeat/gameover/vehicle contexts map to the player's system tracks; others loud |
| 10670 Change System SFX | converted | `systemFlag systemSfx:<n>` (stored only) |
| 10710 Enemy Encounter (+20710-20713) | converted | `battle` with win/escape/defeat branches; variable troop id and the 2003 formation/condition extras are partial |
| 10720 Open Shop (+20720-20722) | converted | goods from p[4] on, classified through the unified item table; the transaction branches are not replayed (the player's shop returns to the event) |
| 10730 Show Inn | loud | no inn vocabulary |
| 10740 Enter Hero Name | converted | `inputName`; the 6-character cap is the 2k3 name-entry limit |
| 10810 Teleport | converted | direct map/x/y; the 2003 facing suffix is ignored by `transfer` (partial) |
| 10820 Memorize Location | converted | three `modifyVariable` sets (mapId, playerX, playerY) |
| 10830 Recall to Location | converted | `transfer` with mapVar/xVar/yVar |
| 10840 Enter/Exit Vehicle | converted | `vehicleBoard` (boards or leaves at the player's cell, like MV 206) |
| 10850 Set Vehicle Location | converted | direct coordinates only |
| 10860 Change Event Location | converted | via `relocate` (player, self or event:<id>); the 2003 facing rides only for the player |
| 10870 Trade Event Locations | loud | no swap vocabulary |
| 10910/10920 Store Terrain ID / Event ID | loud | `locationInfo` has terrain/tile/region, not these (rare) |
| 11010/11020 Erase/Show Screen | converted | `screenFade` out/in; the 20 transition shapes render as the standard fade (same as MV 221/222) |
| 11030 Tint Screen | converted | tenths → seconds |
| 11040 Flash Screen | converted | power 0-31 → peak /31 |
| 11050 Shake Screen | converted | |
| 11060 Pan Screen | converted | pan → `scrollMap` (the 2k3 wait flag rides on the awaited tween); camera lock/unlock is loud |
| 11070 Weather | converted | none/rain/snow; fog (2003) is loud |
| 11110 Show Picture | converted | origin from p[1] upper bits, magnify, transparency; the tone at show time emits a `tintPicture`; variable x/y (2k3) is loud; effect power/blend are partial |
| 11120 Move Picture | converted | duration in tenths, wait flag; same tone/variable partials |
| 11130 Erase Picture | converted | single id |
| 11210 Show Battle Animation | converted | hero (10001) → the player, this event (10005) → the running event, plain ids → event:<id>; vehicles are loud |
| 11310 Player Visibility | converted | `setTransparent` |
| 11320 Flash Sprite (2003) | loud | no sprite-flash vocabulary |
| 11330 Move Event | converted | routes: RM2k3 codes (liblcf `MoveCommand`, 0-based) → MWGP step descriptors; begin/end jump folds the inner moves' net displacement into one `jump` step (the engine also ignores passability for the jump); switch on/off, change graphic, play SE, through, animation, transparency steps map to their commands. Speed/frequency increase/decrease (28-31) are loud — `routeOption` carries absolute values; Maniac route codes (74+) stay loud |
| 11340 Proceed With Movement | converted | folds into the preceding route as `wait: true` |
| 11350 Halt All Movement | loud | rare; no stop-all vocabulary |
| 11410 Wait | converted | |
| 11510 Play BGM / 11550 Play Sound | converted | volume/tempo at p[1]/p[2] (BGM) and p[0]/p[1] (SE) |
| 11520 Fade Out BGM | converted | 2k3 stores milliseconds → seconds |
| 11530/11540 Memorize/Play BGM | converted | `saveBgm`/`resumeBgm` |
| 11560 Play Movie | converted | `playMovie`; 2k3 .avi files are not decoded (the player expects `assets/movies/<name>.webm`) — partial |
| 11610 Key Input Processing | loud | no key-state vocabulary |
| 11710 Change Map Tileset | converted | `changeTileset` (the player rebuilds the map) |
| 11720 Change Parallax BG | converted | loop/auto-scroll flags and signed speeds |
| 11740 Change Encounter Steps | converted | `systemFlag encounterSteps` (stored; the map's own step count drives encounters) |
| 11810/11830 Teleport/Escape Targets | loud | no destination-memory vocabulary |
| 11820/11840/11930/11960 Access Flags | converted | `systemFlag` saveAccess/menuAccess (honoured) and teleportAccess/escapeAccess (stored) |
| 11910 Open Save Menu | converted | `menu: 'save'` |
| 11950 Open Main Menu | converted | `menu: 'menu'` |
| 12010 Conditional Branch | converted | corrected this pass (the old table had timer/gold/item on the wrong codes): 0 switch, 1 variable (6 operators), 2 timer, 3 gold, 4 item (negation swaps the branches), 5 actor (in party, name, skill learned, state; level/hp comparisons and "is equipped" are loud), 6 facing (hero/this event), 7 vehicle in use; BGM-looped and decision-key triggers are loud |
| 12110 Label / 12120 Jump to Label | converted | top-level labels split the page into story passages; gotos follow them; nested labels and gotos inside inlined common events are loud |
| 12210/12220/22210 Loop, Break | converted | |
| 12310/12320/12420/12510 End Event, Erase Event, Game Over, Return to Title | converted | |
| 12330 Call Event | partial | common-event calls inline (like 1005); map-event-page calls and indirect ids are loud — no "run another event's page" vocabulary |
| 13110-13130 Change Monster HP/MP/Condition | converted | battle-only, via changeEnemyHp/Mp/State |
| 13150 Show Hidden Monster | converted | `enemyAppear` |
| 13210 Change Battle BG | converted | `systemFlag battleback` |
| 13410 Terminate Battle | converted | `abortBattle` |
| 1008 Change Class (2003) | converted | single actor; keep-exp from the stat mode; party-wide/variable actors are loud |
| 1006 Force Flee, 1007 Enable Combo, 1009 Change Battle Commands (2003) | loud | battle-internal commands with no runner equivalent |
| 20000s/Maniac_*/EasyRpg_* (patches) | loud | patch extensions stay explicit markers by policy |

### Database, maps and audio

- **Database**: actors (params per level, exp curve, equipment, classes with
  learnings), classes, skills (XP-era power/rate factors → damage formulas),
  items/weapons/armors (one unified RM2k id space, split by the type field),
  enemies, troops, states, system (start party, title). 2003's attribute-rate
  table and ATB-specific fields are not carried (partial).
- **Maps**: both tile layers → chipset-atlas frames; chipset passage flags
  (autotile-aware); events with pages, conditions and triggers; the map tree.
  Water animation across chipset animation frames is not composed (partial,
  `docs/converter-spec.md` §9).
- **Audio**: Music/Sound folders copied and indexed; `.wma` and audio formats
  the browser cannot decode degrade loudly through the audio index.

## RPG Maker XP / VX / VX Ace (`tools/convert-rgss.js`)

- Event commands: the XP command set converts through the same vocabulary; the
  Ace (`.rvdata2`) and VX (`.rvdata`) databases map to MV-shaped tables, so
  battles and menus use the real runner (`convertAceDatabase`/`convertVxDatabase`).
- Call Script (355/655) and script conditions transpile per snippet (Ruby2JS);
  the game's own Ruby library transpiles unit-by-unit (`rubyLibrary`); the async
  lift makes frame-waiting scripts work. Coverage for the installed Essentials
  game: 100 % of event snippets, ~96 % of library units.
- Known gaps: the game's own menus/battles run only through the game's own code
  (see the Essentials notes in `AGENTS.md`); VX ships empty passage flags (no
  database source) so movement is unclamped there; Ace shares VX's event
  numbering (assumed, unverified against a real Ace project).

## RPG Maker MV / MZ (`tools/convert-mv.js`)

- Every MV/MZ command code is classified by `buildCompatibilityReport` into
  `compatibility.commands` (supported/partial with the handler named); the
  report is data-driven and ships in each manifest, so a game's own gaps are
  visible per project rather than asserted here. Engine code (plugins, the MV
  interpreter) runs for real in the sandbox — the game's own rules, not
  reimplementations, carry what the vocabulary cannot.

## RPG Maker Unite

- Documented in the archive (`mz-manifest.json` sibling work) but not targeted
  by a converter: Unite projects are Unity assets, not the JSON/database shape
  the other engines share. Out of scope until a game needs it.
