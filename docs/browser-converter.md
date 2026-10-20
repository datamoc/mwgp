# Browser converter

`public/converter.html` is the complete distributable: a single HTML file that can be copied to another
computer, opened by double-click, or served by any static HTTPS host. It needs no Node installation,
backend, CDN or network connection. `npm start` also serves it at `/converter.html`.

Choose a complete source game directory, including `www/` when present, and convert. The page detects
MV/MZ from their web root and JSON database, and XP/VX/Ace from loose data or a `Game.rgssa`,
`Game.rgssad`, `Game.rgss2a` or `Game.rgss3a` archive. It uses the CLI's default RGSS library depth
and the equivalent of MV/MZ's `--copy-assets`.

The default output is a single playable HTML file with the player and game compressed in gzip.
ZIP and directory exports contain an editable MWGP conversion, with `mwgp.json`, `assets/` and the
initial conversion baseline used by Studio. All outputs retain the CLI's gameplay/command/script
compatibility limits. They are not web builds of the original engine. Conversion does not verify gameplay.

## Playable HTML

Choose **Page HTML jouable**, download the file and open it directly. A small loader uses the browser's
`DecompressionStream('gzip')` to unpack the embedded bytes locally. The gzip stream contains a
length-prefixed JSON index followed by the exact bytes of each file: the normal player bundle,
the installed MWG global runtime, notices, `mwgp.json` and the game's decoded `assets/` tree.
There is no ZIP layer, backend, service worker, external script or CDN request.

Base64 blocks carry the compressed stream inside the HTML. Each block is decoded separately;
decompression and file reconstruction run as streams rather than one enormous JSON/base64 object.
The gzip checksum is checked before starting the game. The HTML file itself is ordinary HTML,
so neither a `.gz` extension nor HTTP `Content-Encoding` headers are needed.

Alongside `mwgp.json` and the game's decoded `assets/` tree, the payload also carries the Studio
files (`.mwgp-conversion.json`, `.mwgp-merge-report.json`) and the empty resource directories,
so the editable MWGP directory can be recreated from the game page alone (see below). The
`.runtime/` files (player, MWG, licences) are part of the page, not of the recreated directory.

## Standalone Studio (full graphical editor)

`npm run export:studio` generates `public/studio-standalone.html`: the complete graphical Studio
editor (map canvas, tile painting, event/command inspector, database and resource editors) in a
single offline file, produced on the developer's machine like the converter. Open it from
`file://`, choose a self-contained game page, and edit. `src/studio-standalone/host.js` supplies
the server Studio's `/api/studio/*` endpoints in memory (load, protected save, conversion
comparison, resource versions), so `public/studio.js` runs unmodified; saves are validated
structurally before anything is published. **Tester** opens the edited game in the standalone
player, and **Page de jeu (.html)** downloads the regenerated self-contained game page (same
player shell and version, edited manifest and assets, original conversion baseline kept).
A blank project can be created from the opening screen and likewise exported as a game page.
Known limits versus the server Studio: edits live in memory until the game page is downloaded
(no writing back into a folder), resource previews by URL (images, audio, video) cannot load
through the in-memory API while text resources edit normally, and the full Node manifest
validator remains the reference check.

## Standalone Studio (recreate a directory)

The same single HTML file also works as a standalone Studio front door, with no server: its
**Studio autonome** section takes a playable game page, unpacks its gzip payload locally and
recreates every file of the editable MWGP directory — `mwgp.json`, `assets/` (including empty
directories), `.mwgp-conversion.json` and `.mwgp-merge-report.json` — either written into a new
folder through the directory picker (an existing folder is never overwritten; a numeric suffix
is appended), or downloaded as a ZIP to extract. Paths inside the payload are validated before
writing, and the player version embedded in the page is reported. Game pages made before the
payload carried the Studio files still work: the baseline is rebuilt from `mwgp.json`, as the
Studio does on its first save. Place the recreated folder among the converted projects to open
it in the server Studio or the local player; the graphical editor itself remains server-hosted.

Every playable HTML page carries the version of the player embedded in it. The version belongs to
the project: the Studio edits it (the **Player** field in the toolbar) and it is saved into
`mwgp.json` as `playerVersion`, for a folder project as for a standalone one; the manifest
validator requires the `1.2.3` shape when it is present. When a standalone game page is created —
by this converter, or by the standalone Studio's regenerated page — the project's version is
stamped into the payload, the head meta and the visible line. Projects that declare no version
use the current default, `0.0.1`, from the single `PLAYER_VERSION` constant in
`src/standalone-player/player-version.js`. It is stamped in three places of the generated page: the
`<meta name="mwgp-player-version">` tag and the visible `Player MWGP <version>` line in the page, the
`playerVersion` field of the compressed payload's index, and at runtime as
`globalThis.mwgpStandalone.playerVersion` (also mirrored on `document.documentElement.dataset`).
The bootstrap refuses a payload without a player version. Bump that one constant to change the
version of newly generated pages; pages already generated keep the version they were made with.

`src/standalone-player/host.js` supplies the normal player's manifest/map/resource API in memory.
It registers MWG's compiled resource map, using typed data URLs for Pixi textures and Blob URLs for
other DOM consumers. `src/player/asset-url.js` lets titles, fonts, videos and Ruby bitmaps use that
same resource map. Server-hosted games keep their original URLs. The normal player, battle/menu
code and Ruby shim are bundled without a second gameplay implementation. Reloads and map transfers
continue to use the same HTML file; save slots use a stable per-project namespace in browser storage.
Save data is not written back into the HTML file.

PNG, OGG, MP3 and similar files are already compressed, so gzip mainly reduces scripts and JSON.
Base64 adds about one third to the compressed payload size. HTML output has no classic ZIP
file-count/4-GiB restriction, but browser memory and maximum document/string sizes still limit large
games. At startup all files are decompressed, and texture data URLs consume additional memory.
Use directory output for projects that do not fit comfortably in a browser. A game's own SoundFont
is embedded when present; the server-only shared SoundFont is absent, so MIDI uses MWG's synth
when the game supplies none.

## Output and memory

- ZIP works without direct filesystem access. Extract it into a folder before using it. The generated
  ZIP uses classic ZIP limits: less than 4 GiB including overhead, and fewer than 65,535 files. The
  exporter rejects larger results rather than producing an invalid archive. Browser memory limits
  can be lower; prefer direct folder output for large projects.
- Direct folder output is enabled when `showDirectoryPicker` is available. The page creates a new
  child directory, appending a numeric suffix when the name already exists. It does not reconvert
  into an existing Studio project. Use the Node converter for protected reconversion/merge.
- Input files stay as browser `File`/`Blob` objects. RGSS archives are indexed, with their entries
  exposed as lazy slices. Each entry is decrypted when read. Loose graphics/audio overlay archive
  contents in the same way as the CLI. Direct folder output releases each resource after writing;
  ZIP output retains output Blobs and then creates the archive in chunks. Individual files and the
  manifest still have to fit in memory, as do the Ruby parser and the selected script library.
- Source lookups are case-insensitive, matching the Windows projects the converters read. The
  original filename spelling is retained when files are copied.
- Directory uploads omit empty source directories. The output adapter recreates the resource
  directories declared by the manifest; ZIPs preserve empty directories too, so extraction does not
  invalidate the resource metadata.
- Cancellation terminates the Worker immediately. A folder output may remain incomplete; the next
  attempt creates another directory. The source directory is read-only to the converter.

## Shared code and browser adapters

`tools/convert-mv.js` exports `convertMv(source, destination, flags)`; `tools/convert-rgss.js` exports
`convertRgss(source, destination, flags)`. Their CLI entry points still invoke those same functions.
Both functions return the manifest. The existing conversion rules, plugin selection, Ruby transpilation,
asset decoding and compatibility reports are shared without a second browser implementation.

`tools/rgss-archive.mjs` owns the shared RGSSAD v1/v3 index reader and payload decryption, used by the
CLI extractor and both conversion hosts. It validates truncation and prevents archive entry paths from
escaping their destination. Browser extraction registers lazy entries instead of expanding the archive.

`src/converter-browser/` holds the page, Worker and platform adapters. `fs.js` implements only the
filesystem operations actually needed by the converters. `FileReaderSync` handles synchronous source
reads inside the Worker; asynchronous output uses real writable directory handles or output Blobs.
The output adapter publishes a fresh manifest and baseline; Studio locks and merge state remain in the
Node host. Unsupported platform imports fail packaging explicitly.

The developer-only exporter uses esbuild to resolve Node imports to these adapters and bundle the
converter, Acorn, Buffer, fflate, Ruby2JS and Prism/WebAssembly into an embedded Blob Worker. It also
prepares the shared player bundle and MWG runtime that HTML output will embed in gzip. A classic
Worker with an async envelope supports `file://` in Chromium; module Blob Workers do not work there.
Function/class names are preserved because the Ruby transpiler uses names for dispatch. A fresh Worker
is used for every conversion, keeping library state isolated and cancellation immediate.

## Build and verification

```powershell
npm install
npm run export:converter
npm run test:converter-browser
```

The exporter can write elsewhere with `npm run export:converter -- <output.html>`. Regenerate the
HTML after changes to either converter or their dependencies. No build is needed for the rest of the app.
Ruby2JS currently emits esbuild warnings about existing generated constructs; packaging does not modify
that vendored source. Converter parity is checked in a real browser, including Ruby library/snippet output.

The test needs Playwright and Chromium (the same local/global installation discovery as the game harness).
It opens the generated file offline, converts synthetic MV/MZ/XP/VX/Ace games and RGSSAD v1/v3 archives,
compares every exported file against the CLI, checks encrypted-image bytes, plugins, Ruby snippets and
libraries, and validates extracted manifests. Each engine also exports a gzip HTML game; its payload
is decoded independently in Node and compared against the original assets, then booted offline in the
full player. MV/MZ fixtures additionally check title art, Pixi textures, audio, movement, map transfer
and save/load across a reload. It also checks errors, cancellation/retry, mobile overflow and the
absence of HTTP requests for offline conversions. Real writable directory handles are tested using
Chromium OPFS on localhost, replacing only the native directory picker; an existing output directory
must be preserved. OS picker interaction itself remains a manual check.

Fixtures, ZIPs and desktop/mobile screenshots remain in the reported OS temporary directory. Synthetic
parity does not establish that all installed games convert or play successfully, or that every browser
supports the same filesystem features.
