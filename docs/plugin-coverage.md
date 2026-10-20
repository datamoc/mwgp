# Plugin capabilities: Karryn's Prison

171 plugins: logic-runs 84, mixed 69, bypassed 8, standalone 10

| Engine layer | Plugins touching it | Members redefined | What the player does | mwg offers |
|---|---:|---:|---|---|
| data | 127 | 6527 | runs: the game logic (Game_* battlers, actions, party) runs in the sandbox; battle skills with a note use it through battle-engine.js | SaveSystem, I18n, Achievements |
| private | 103 | 2287 | plugin-private state and namespaces (parameter tables, helpers): nothing for the player to replace | (nothing mapped) |
| other | 116 | 1812 | engine-adjacent class the table does not know | (nothing mapped) |
| menu | 60 | 1090 | native: src/player/menu.js and window skin | WindowStack, ListView, TabbedList, StatsScreen, StatusVisuals, SettingsScreen, Tooltip, TooltipHost, HelpScreen |
| battle | 52 | 940 | native: src/player/battle.js (+ stage); skills and items with a note run on the game engine (battle-engine.js) | Battle, FloatingText, FloatingTextStack, Meter, Bar |
| render | 52 | 877 | partial: map scene is mwg Scene2D; sprites are inert in the sandbox | ScreenEffects, TiledSprite, LayeredSprite, ParticleEmitter, ClothSprite, SkeletalSprite, TintedSprite, SpriteMotion |
| message | 16 | 164 | native: mwg MessageBox / dialogue | MessageBox, DialogueStage, MessageLog, parseDialogueText, messageBoxPresenter |
| audio | 5 | 56 | native: src/player/audio-manager.js | Audio, Music |
| input | 8 | 33 | native: mwg Input | Input, PlayerInput, RebindScreen, OnScreenKeyboard |

`bypassed` plugins hook layers the player runs with its own code; their behaviour is not applied. Each is a candidate for an
equivalent built on the mwg exports above or on a package; decide per plugin from its redefined members (`--json`).

# Plugin capabilities: MV game C

14 plugins: mixed 7, logic-runs 6, bypassed 1

| Engine layer | Plugins touching it | Members redefined | What the player does | mwg offers |
|---|---:|---:|---|---|
| private | 11 | 459 | plugin-private state and namespaces (parameter tables, helpers): nothing for the player to replace | (nothing mapped) |
| other | 13 | 269 | engine-adjacent class the table does not know | (nothing mapped) |
| menu | 9 | 227 | native: src/player/menu.js and window skin | WindowStack, ListView, TabbedList, StatsScreen, StatusVisuals, SettingsScreen, Tooltip, TooltipHost, HelpScreen |
| data | 12 | 177 | runs: the game logic (Game_* battlers, actions, party) runs in the sandbox; battle skills with a note use it through battle-engine.js | SaveSystem, I18n, Achievements |
| render | 6 | 97 | partial: map scene is mwg Scene2D; sprites are inert in the sandbox | ScreenEffects, TiledSprite, LayeredSprite, ParticleEmitter, ClothSprite, SkeletalSprite, TintedSprite, SpriteMotion |
| message | 2 | 48 | native: mwg MessageBox / dialogue | MessageBox, DialogueStage, MessageLog, parseDialogueText, messageBoxPresenter |
| battle | 3 | 28 | native: src/player/battle.js (+ stage); skills and items with a note run on the game engine (battle-engine.js) | Battle, FloatingText, FloatingTextStack, Meter, Bar |
| audio | 1 | 3 | native: src/player/audio-manager.js | Audio, Music |
| input | 2 | 2 | native: mwg Input | Input, PlayerInput, RebindScreen, OnScreenKeyboard |

`bypassed` plugins hook layers the player runs with its own code; their behaviour is not applied. Each is a candidate for an
equivalent built on the mwg exports above or on a package; decide per plugin from its redefined members (`--json`).
