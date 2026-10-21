import { Gzip } from 'fflate';
import { files as runtimeFiles, shell, bootstrap } from 'mwgp:standalone-runtime';
import { outputRoot } from './fs.js';
import { PLAYER_VERSION } from '../standalone-player/player-version.js';

function base64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

// V8 cannot hold a string longer than about 512M characters, and a larger
// <script> text reads back empty in the browser. The payload is therefore
// written as several <script data-mwgp-payload> elements, each capped here.
const PAYLOAD_PART_CHARS = 64 * 1024 * 1024;
// A page this large can time out while the browser loads it: the page is then stopped before the payload (gate.js) and
// offers to unpack the game into a local folder instead.
const LARGE_PAGE_BYTES = 100 * 1024 * 1024;

export async function standaloneOutput(entries, name, project, engine, progress, payloadPartChars = PAYLOAD_PART_CHARS, payloadLimit = LARGE_PAGE_BYTES) {
  const files = runtimeFiles.map(([path, text]) => ({ path, blob: new Blob([text]) }));
  for (const [path, entry] of entries) {
    const relative = path.slice(outputRoot.length + 1);
    // Carry everything the standalone Studio needs to recreate the editable
    // directory from this page alone: the manifest, its conversion baseline
    // and merge report, the assets and the empty resource directories.
    const projectFile = relative === 'mwgp.json' || relative === '.mwgp-conversion.json' ||
      relative === '.mwgp-merge-report.json' || relative.startsWith('assets/');
    if (entry.directory) { if (relative.startsWith('assets/')) files.push({ path: relative, blob: new Blob([]) }); }
    else if (projectFile) files.push({ path: relative, blob: entry.blob });
  }
  // The player version belongs to the project (the Studio edits it in
  // mwgp.json); fall back to the project's current default when unset.
  let playerVersion = PLAYER_VERSION;
  const manifestFile = files.find(file => file.path === 'mwgp.json');
  if (manifestFile) {
    try {
      const declared = JSON.parse(await manifestFile.blob.text()).playerVersion;
      if (typeof declared === 'string' && /^\d+\.\d+\.\d+$/.test(declared)) playerVersion = declared;
    } catch { /* an unreadable manifest fails later, in the player */ }
  }
  const identity = base64(new TextEncoder().encode(`${engine}:${project}`)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const header = new TextEncoder().encode(JSON.stringify({ format: 'MWGP-standalone', version: 1, playerVersion,
    id: 'standalone-' + identity, files: files.map(({ path, blob }) => ({ path, size: blob.size })) }));
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, header.length, true);
  const [before, after] = shell.split('<!-- GAME_PAYLOAD -->');
  const versionedBefore = before
    .replace(/<meta name="mwgp-player-version" content="[^"]*">/, `<meta name="mwgp-player-version" content="${playerVersion}">`)
    .replace(/(id="player-version"[^>]*>Player MWGP )[^<]*/, `$1${playerVersion}`);
  const parts = [];
  let partChars = 0, payloadChars = 0;
  const openPart = () => { parts.push('<script data-mwgp-payload type="application/octet-stream">\n'); partChars = 0; };
  openPart();
  let compressedBytes = 0;
  // Each gzip chunk is its own padded base64 line, so a new element starts only between lines.
  const gzip = new Gzip({ level: 6, mtime: 0 }, chunk => {
    compressedBytes += chunk.length;
    const line = base64(chunk);
    if (partChars > 0 && partChars + line.length > payloadPartChars) { parts.push('</script>\n'); openPart(); }
    parts.push(line, '\n'); partChars += line.length + 1; payloadChars += line.length + 1;
  });
  gzip.push(size); gzip.push(header);
  let done = 0, lastProgress = 0;
  const total = files.reduce((sum, file) => sum + file.blob.size, 0);
  for (const { path, blob } of files) {
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
      gzip.push(bytes); done += bytes.length;
      if (Date.now() - lastProgress > 100) { progress({ done, total, label: `Compression gzip : ${path}`, packaging: true }); lastProgress = Date.now(); }
    }
  }
  gzip.push(new Uint8Array(), true);
  // The size data is in the head, so it is known before the gate (in the body, before the payload) runs.
  const pageId = 'standalone-' + identity;
  const head = versionedBefore.replace('</head>', () => `<meta name="mwgp-payload-bytes" content="${payloadChars}"><meta name="mwgp-payload-limit" content="${payloadLimit}"><meta name="mwgp-payload-id" content="${pageId}"></head>`);
  parts.unshift(head);
  parts.push('</script>\n<script>', bootstrap, '</script>\n', after);
  progress({ done: total, total, label: 'Page HTML prête', packaging: true });
  return { blob: new Blob(parts, { type: 'text/html;charset=utf-8' }), name: `${name}.html`,
    format: 'html', rawBytes: total + header.length + 4, compressedBytes };
}
