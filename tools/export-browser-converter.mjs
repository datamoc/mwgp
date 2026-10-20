// Developer-only packaging. The resulting single HTML file needs neither
// Node, a server, a CDN nor a network connection on the user's machine.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYER_VERSION } from '../src/standalone-player/player-version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const browser = join(root, 'src', 'converter-browser');
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

export async function thirdPartyNotices() {
  const packages = [
    ['@datamoc/mwg', 'node_modules/@datamoc/mwg/LICENSE'],
    ['acorn', 'node_modules/acorn/LICENSE'], ['acorn-walk', 'node_modules/acorn-walk/LICENSE'],
    ['buffer', 'node_modules/buffer/LICENSE'], ['base64-js', 'node_modules/base64-js/LICENSE'],
    ['ieee754', 'node_modules/ieee754/LICENSE'], ['fflate', 'node_modules/fflate/LICENSE'],
    ['browser_wasi_shim (MIT option)', 'node_modules/@bjorn3/browser_wasi_shim/LICENSE-MIT'],
    ['Ruby2JS', 'transpilers/ruby2js-master/LICENSE'], ['Prism 1.9.0', 'src/converter-browser/prism-LICENSE.txt'],
  ];
  const notices = await Promise.all(packages.map(async ([name, path]) => `${name}\n${await readFile(join(root, path), 'utf8')}`));
  // Keep the sole MPL-covered library file available in source form even when
  // this page is copied offline. The decoder is bundled without modifications.
  notices.push('Source @datamoc/mwg / dist/rpg/Marshal.js (MPL-2.0)\n' + await readFile(join(root, 'node_modules/@datamoc/mwg/dist/rpg/Marshal.js'), 'utf8'));
  notices.push('MWG runtime source (MPL-2.0): https://github.com/datamoc/mwg\nThe standalone player embeds the installed, unmodified mwg.global.js bundle.');
  return notices.join('\n\n────────────────────────────────────────\n\n');
}

export async function standaloneRuntime(notices) {
  const player = await build({
    entryPoints: [join(root, 'src/standalone-player/player.js')], bundle: true, write: false,
    platform: 'browser', format: 'esm', target: 'es2022', minify: true, keepNames: true,
    legalComments: 'inline',
    plugins: [{ name: 'player-server-module-paths', setup(build) {
      build.onResolve({ filter: /^\/[a-z-]+\.js$/ }, ({ path }) => ({ path: join(root, 'src/player', path.slice(1)) }));
    } }],
  });
  const code = `;(async () => {\n${player.outputFiles[0].text}\n})().catch(error => { console.error('MWGP standalone player failed', error); const status = document.querySelector('#unpacking') || document.querySelector('#title'); if (status) status.textContent = 'Ouverture impossible : ' + error.message; });`;
  const runtime = await readFile(join(root, 'node_modules/@datamoc/mwg/dist/mwg.global.js'), 'utf8');
  let shell = await readFile(join(root, 'public/player.html'), 'utf8');
  shell = shell.replace('<script type="module" src="/player.js"></script>', '')
    .replace('</head>', `<meta name="mwgp-player-version" content="${PLAYER_VERSION}"></head>`)
    .replace('<p>Arrow keys / WASD to move. Enter or Space advances dialogue.</p>', `<p>Arrow keys / WASD to move. Enter or Space advances dialogue.</p><p id="player-version" style="color:#8998aa;font-size:11px;margin:4px 0 0">Player MWGP ${PLAYER_VERSION}</p>`)
    .replace('<div id="stage">', '<p id="unpacking" role="status" class="mwgp-loading">Ouverture du jeu…</p><div id="stage">')
    .replace('</main>', '<details style="margin-top:16px"><summary>Logiciels libres et licences</summary><pre id="standalone-licenses" style="white-space:pre-wrap;max-height:300px;overflow:auto"></pre></details></main>')
    .replace('</body>', '<!-- GAME_PAYLOAD --></body>');
  const bootstrap = await readFile(join(root, 'src/standalone-player/bootstrap.js'), 'utf8');
  return { files: [['.runtime/mwg.js', runtime], ['.runtime/player.js', code], ['.runtime/LICENCES.txt', notices]], shell, bootstrap };
}

export async function exportBrowserConverter(destination = join(root, 'public', 'converter.html')) {
  const notices = await thirdPartyNotices();
  const standalone = await standaloneRuntime(notices);
  const result = await build({
    entryPoints: [join(browser, 'worker.js')], bundle: true, write: false,
    platform: 'browser', format: 'esm', target: 'es2022', minify: true, keepNames: true,
    inject: [join(browser, 'globals.js')], loader: { '.wasm': 'binary' },
    legalComments: 'inline',
    plugins: [{ name: 'browser-conversion-platform', setup(build) {
      build.onResolve({ filter: /^mwgp:standalone-runtime$/ }, () => ({ path: 'runtime', namespace: 'standalone-runtime' }));
      build.onLoad({ filter: /.*/, namespace: 'standalone-runtime' }, () => ({ contents: Object.entries(standalone)
        .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n') }));
      build.onResolve({ filter: /^node:/ }, ({ path }) => {
        const adapters = { 'node:fs': 'fs.js', 'node:fs/promises': 'fs.js', 'node:path': 'path.js', 'node:zlib': 'zlib.js' };
        if (adapters[path]) return { path: join(browser, adapters[path]) };
        if (path === 'node:os') return { path, namespace: 'browser-stubs' };
        return { errors: [{ text: `No browser adapter for ${path}` }] };
      });
      build.onLoad({ filter: /.*/, namespace: 'browser-stubs' }, () => ({ contents: "export const tmpdir = () => '/tmp';" }));
      build.onResolve({ filter: /studio-(?:manifest|assets)\.js$/ }, () => ({ path: join(browser, 'output.js') }));
      build.onResolve({ filter: /converter-version\.mjs$/ }, () => ({ path: 'version', namespace: 'converter-version' }));
      build.onLoad({ filter: /.*/, namespace: 'converter-version' }, () => ({ contents: `export const CONVERTER_VERSION = ${JSON.stringify(packageInfo.version)};` }));
      build.onResolve({ filter: /rgss-archive\.mjs$/ }, ({ importer }) => {
        if (importer.endsWith('convert-rgss.js')) return { path: join(browser, 'archive.js') };
      });
      build.onResolve({ filter: /^@datamoc\/mwg\/rpg$/ }, () => ({ path: join(root, 'node_modules/@datamoc/mwg/dist/rpg/Marshal.js') }));
      // Ruby2JS has a Node/Window branch; Workers need the browser Prism host.
      // Resolve both branches so no unavailable module survives packaging.
      build.onResolve({ filter: /^(?:@ruby\/prism|\.\/prism_browser\.js)$/ }, () => ({ path: join(browser, 'prism.js') }));
    } }],
  });
  // Classic Blob Workers also work from file://. The async envelope preserves
  // the bundled Ruby parser's asynchronous module initialization.
  const workerCode = `;(async () => {\n${result.outputFiles[0].text}\n})().catch(error => self.postMessage({ type: 'failure', message: error.message, stack: error.stack }));`;
  const worker = Buffer.from(workerCode).toString('base64');
  const template = await readFile(join(browser, 'page.html'), 'utf8');
  const controller = await readFile(join(browser, 'page.js'), 'utf8');
  const escapedNotices = notices.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const html = template.replace('/* CONTROLLER */', () => controller).replace('WORKER_BASE64', () => worker)
    .replaceAll('CONVERTER_VERSION', packageInfo.version).replace('THIRD_PARTY_NOTICES', () => escapedNotices);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, html);
  return { destination, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await exportBrowserConverter(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`Browser converter: ${result.destination} (${(result.bytes / 1024 / 1024).toFixed(1)} MiB)`);
}
