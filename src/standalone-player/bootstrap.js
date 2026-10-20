// Small, uncompressed loader. Everything else, including the player and MWG,
// lives in the embedded gzip stream. No service worker or local server needed.
async function openStandaloneGame() {
  const status = document.querySelector('#unpacking');
  if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression. Use a recent browser.');
  // The payload is split over several elements (a single script's text cannot
  // exceed the engine's string limit). Each is read, decoded and removed in turn.
  const elements = [...document.querySelectorAll('script[data-mwgp-payload], script#mwgp-payload')];
  if (!elements.length) throw new Error('The game content is missing.');
  let element = 0, lines = [], line = 0;
  const compressed = new ReadableStream({ pull(controller) {
    while (line === lines.length) {
      if (element === elements.length) { controller.close(); return; }
      lines = elements[element].textContent.trim().split('\n'); line = 0;
      elements[element++].remove();
    }
    const text = lines[line]; lines[line++] = null;
    controller.enqueue(Uint8Array.from(atob(text), c => c.charCodeAt(0)));
  } });
  const reader = compressed.pipeThrough(new DecompressionStream('gzip')).getReader();
  let current = new Uint8Array(), offset = 0;
  async function readParts(length) {
    const parts = [];
    while (length > 0) {
      if (offset === current.length) {
        const next = await reader.read();
        if (next.done) throw new Error('The game content is truncated.');
        current = next.value; offset = 0;
      }
      const count = Math.min(length, current.length - offset);
      parts.push(current.subarray(offset, offset + count));
      offset += count; length -= count;
    }
    return parts;
  }
  const headerSize = new DataView(await new Blob(await readParts(4)).arrayBuffer()).getUint32(0, true);
  if (!headerSize || headerSize > 32 * 1024 * 1024) throw new Error('Invalid game index.');
  const metadata = JSON.parse(await new Blob(await readParts(headerSize)).text());
  if (metadata.format !== 'MWGP-standalone' || metadata.version !== 1 || !Array.isArray(metadata.files)) throw new Error('Unknown game format.');
  if (typeof metadata.playerVersion !== 'string' || !metadata.playerVersion) throw new Error('The player version is missing.');
  const files = new Map();
  for (const entry of metadata.files) {
    if (typeof entry.path !== 'string' || files.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid game entry.');
    status.textContent = `Opening the game… ${files.size + 1}/${metadata.files.length}`;
    files.set(entry.path, await readParts(entry.size));
  }
  // Read to EOF so gzip's checksum and truncation errors cannot go unnoticed.
  if (offset !== current.length || !(await reader.read()).done) throw new Error('Unexpected content after the game.');
  if (!files.has('mwgp.json') || !files.has('.runtime/player.js') || !files.has('.runtime/mwg.js')) throw new Error('The player or the game is missing.');
  globalThis.mwgpStandalone = { files, metadata, playerVersion: metadata.playerVersion };
  const licenses = document.querySelector('#standalone-licenses');
  if (licenses && files.has('.runtime/LICENCES.txt')) licenses.textContent = await new Blob(files.get('.runtime/LICENCES.txt')).text();
  const script = document.createElement('script');
  script.src = URL.createObjectURL(new Blob(files.get('.runtime/player.js'), { type: 'application/javascript' }));
  await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('The player cannot start.')); document.head.append(script); });
}
openStandaloneGame().catch(error => {
  const status = document.querySelector('#unpacking');
  if (status) { status.textContent = `Could not open the game: ${error.message}`; status.setAttribute('role', 'alert'); }
  console.error('MWGP standalone bootstrap failed', error);
});
