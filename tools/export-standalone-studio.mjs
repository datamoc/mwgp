// Developer-only packaging of the standalone Studio: a single HTML file with
// the full graphical editor, usable offline from file://. It opens a
// self-contained game page, edits it in memory and downloads a regenerated
// game page. Generated on the developer's machine; no server at run time.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { standaloneRuntime, thirdPartyNotices } from './export-browser-converter.mjs';
import { PLAYER_VERSION } from '../src/standalone-player/player-version.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function exportStandaloneStudio(destination = join(root, 'public', 'studio-standalone.html')) {
  const notices = await thirdPartyNotices();
  const runtime = await standaloneRuntime(notices);
  const result = await build({
    entryPoints: [join(root, 'src/studio-standalone/main.js')], bundle: true, write: false,
    platform: 'browser', format: 'esm', target: 'es2022', minify: true, keepNames: true,
    legalComments: 'inline',
    plugins: [{ name: 'studio-runtime', setup(build) {
      build.onResolve({ filter: /^mwgp:studio-runtime$/ }, () => ({ path: 'runtime', namespace: 'studio-runtime' }));
      build.onLoad({ filter: /.*/, namespace: 'studio-runtime' }, () => ({ contents: Object.entries(runtime)
        .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n') }));
    } }],
  });
  let shell = await readFile(join(root, 'public', 'studio.html'), 'utf8');
  shell = shell.replace('<script type="module" src="/studio.js"></script>',
      () => `<script type="module">\n${result.outputFiles[0].text}\n</script>`)
    .replace('</style>', '#btn-new-project, .header-left + .toolbar a[href="/"] { display:none; }\n</style>')
    .replace('</head>', `<meta name="mwgp-player-version" content="${PLAYER_VERSION}"></head>`)
    .replace('<span id="project-title" class="badge">Chargement…</span>',
      '<span id="project-title" class="badge">Choisissez une page de jeu…</span>');
  if (shell.includes('src="/studio.js"')) throw new Error('Standalone studio shell still references the server editor script.');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, shell);
  return { destination, bytes: Buffer.byteLength(shell) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await exportStandaloneStudio(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`Standalone studio: ${result.destination} (${(result.bytes / 1024 / 1024).toFixed(1)} MiB)`);
}
