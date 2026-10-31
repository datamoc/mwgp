# RPG Maker MV engine versions and plugin version checks

Some plugins (Yanfly's `YEP_*`, `YEP_QuestJournal`, FPS Synch Options, Grid-Free Doodads, ...) check
`Utils.RPGMAKER_VERSION` when they load. Below their minimum they print an error that sends the user to a
RPG Maker forum thread and stop. Those threads are the official release notes of the MV updates; the copies
read for this page were saved locally under `references/forums-rpgmaker/` (third-party pages, not committed).

MWGP never asks you to update project files: the page loads the game's own `rpg_core.js` logic (or, in the
title screen's plugin sandbox, the version the converter read from it, `source.engineVersion` in `mwgp.json`).
If you still see one of these errors, the game's own core script is older than the plugin needs: copy the
newer `rpg_*.js` files into the game's `www/js` folder (never `plugins.js`) and convert again.

## <a id="mv-131"></a>MV 1.3.1 (thread 66712, "RPG Maker MV v1.3.1 fixes")

Needed by `YEP_GridFreeDoodads` (1.3.0 and later). Fixes WebGL flicker and `INVALID_VALUE`, the change-tileset
issue, looping sound, encryption errors, the transfer-fade and flash colours, and adds `FpsSyncOption.js`.
Update method: copy the new `js` files (and `libs`) and `index.html` from the `NewData` folder of an MV install
into the project, never `plugins.js`.

## <a id="mv-134"></a>MV 1.3.4 (thread 71400, "RPG Maker MV v1.3.4 update")

Needed by `YEP_FpsSynchOption` (1.1.0 and later) and the plugins that follow the 1.3.x core. Fixes escape-type
skills, variable names resetting, skills removed after learning, and memory handling (`bitmap.snap()`).
Same update method as above.

## <a id="mv-150"></a>MV 1.5.0 (thread 79677, "RPG Maker MV 1.5.0 update")

Needed by `YEP_OptionsCore` and `YEP_QuestJournal` (1.5.0 and later). Adds the retry on failed resource
loads, the master volume API, the new Plugin Manager (typed plugin parameters), the Community CoreScript and
Pixi 4.4, and improves memory management. Same update method as above (and refresh `gamefont.css`).

## What MWGP does about it

- The converter reads the game's `Utils.RPGMAKER_VERSION` (MZ: `rmmz_core.js`) into `source.engineVersion`.
- The title-screen sandbox declares that version (1.6.2 for MV and 1.8.0 for MZ when a manifest predates it),
  so a plugin that only checks the version loads instead of refusing.
- `require('nw.gui')` answers an inert object there, so a plugin's `Window.get().showDevTools()` after such an
  error no longer throws a second error.
- Forum links printed by plugins are rewritten in the console to this page.
