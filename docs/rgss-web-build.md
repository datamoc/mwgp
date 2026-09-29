# RGSS web builds

`npm run build:web -- <XP/VX/Ace project> <output>` now creates a static browser build. `convert:auto` uses it for RGSS projects by default. Pass `--mwgp` to keep the manifest conversion path. Raw `Game.rgssad`, `Game.rgss2a`, and `Game.rgss3a` stay inside the archive; they are not extracted for this build.

The build contains `game.mkxpz` (a ZIP64 archive with stored, uncompressed entries), `index.html` and `rgss-player.js` (our small page), Nostalgist 0.20.2, the mkxp-z libretro JavaScript and WebAssembly core, and `mwgp-web.json`. It includes the game's original files except Windows executables, DLLs, native saves and GPU caches. On first play, the page downloads the archive and core with progress into browser persistent storage. Later starts reuse those files from OPFS. Saves live there too; IDBFS in IndexedDB is the fallback where OPFS is unavailable. The page maps Enter/Space/Z to confirm, Esc/X to cancel, Shift to dash, and arrows to movement. WebAssembly initialization still takes time after downloading.

The core is from [white-axe's unmerged mkxp-z libretro pull request 255](https://github.com/mkxp-z/mkxp-z/pull/255), built by [white-axe/mkxp-z-libretro-emscripten](https://github.com/white-axe/mkxp-z-libretro-emscripten) at commit `f0a1ff80f05dd0d1f8ca711485a5b0a601bc7502` (mkxp-z submodule `5cd3203660d16ab8cfb8dd962e04216662f8f8e9`). Its [published demonstration](https://white-axe.github.io/mkxp-z-libretro-emscripten/) supplies the two core files. `tools/mkxp-core.mjs` downloads them once into gitignored `.cache/mkxp-z/` and checks SHA-256 before each build. A changed upstream deployment fails the build instead of silently changing the core:

| File | SHA-256 |
| --- | --- |
| `mkxp-z_libretro.js` | `32cc06deabe4a37426245142067379e262e9efcc3289be918e42ceb3759138a1` |
| `mkxp-z_libretro.wasm` | `9eb318ba1e8691fbf155d879c0f63df4a85cf295342a2ec93ad653b1636a8f7a` |

mkxp-z is [GPL-2.0-or-later](https://github.com/mkxp-z/mkxp-z/blob/master/COPYING); the web port is still unmerged. Nostalgist is MIT licensed. Distributing a build that contains the core requires complying with its license and with the game's own distribution rights.

`mkxp-z_syntaxTransform` is set to `2` for classic RGSS. A project that ships a Ruby 2.x/3.x runtime DLL uses `0`, so its modern syntax is left alone. The detected setting is recorded in `mwgp-web.json`. `npm start` serves `/web/<id>/` with COOP and COEP headers for threaded WebAssembly; a separate static host needs equivalent headers.

`npm test` checks a synthetic RGSS build's archive bytes, exclusions, player assets and syntax selection. `node tools/test-browser.mjs --only <project>` checks that the core prepares in Chromium. The browser harness cannot see the core's rendered frames or verify game input, so gameplay, audio and saving need a manual play check.
