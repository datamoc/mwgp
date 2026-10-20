// Small, uncompressed loader. Everything else, including the player and MWG,
// lives in the embedded gzip stream. No service worker or local server needed.
async function openStandaloneGame() {
  const status = document.querySelector('#unpacking');
  if (typeof DecompressionStream !== 'function') throw new Error('Ce navigateur ne prend pas en charge la décompression gzip. Utilisez un navigateur récent.');
  const payload = document.querySelector('#mwgp-payload');
  const lines = payload.textContent.trim().split('\n');
  payload.remove();
  let line = 0;
  const compressed = new ReadableStream({ pull(controller) {
    if (line === lines.length) { controller.close(); return; }
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
        if (next.done) throw new Error('Le contenu du jeu est tronqué.');
        current = next.value; offset = 0;
      }
      const count = Math.min(length, current.length - offset);
      parts.push(current.subarray(offset, offset + count));
      offset += count; length -= count;
    }
    return parts;
  }
  const headerSize = new DataView(await new Blob(await readParts(4)).arrayBuffer()).getUint32(0, true);
  if (!headerSize || headerSize > 32 * 1024 * 1024) throw new Error('Index de jeu invalide.');
  const metadata = JSON.parse(await new Blob(await readParts(headerSize)).text());
  if (metadata.format !== 'MWGP-standalone' || metadata.version !== 1 || !Array.isArray(metadata.files)) throw new Error('Format de jeu inconnu.');
  if (typeof metadata.playerVersion !== 'string' || !metadata.playerVersion) throw new Error('Version du player manquante.');
  const files = new Map();
  for (const entry of metadata.files) {
    if (typeof entry.path !== 'string' || files.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Entrée de jeu invalide.');
    status.textContent = `Ouverture du jeu… ${files.size + 1}/${metadata.files.length}`;
    files.set(entry.path, new Blob(await readParts(entry.size)));
  }
  // Read to EOF so gzip's checksum and truncation errors cannot go unnoticed.
  if (offset !== current.length || !(await reader.read()).done) throw new Error('Contenu inattendu après le jeu.');
  if (!files.has('mwgp.json') || !files.has('.runtime/player.js') || !files.has('.runtime/mwg.js')) throw new Error('Player ou jeu manquant.');
  globalThis.mwgpStandalone = { files, metadata, playerVersion: metadata.playerVersion };
  const licenses = document.querySelector('#standalone-licenses');
  if (licenses && files.has('.runtime/LICENCES.txt')) licenses.textContent = await files.get('.runtime/LICENCES.txt').text();
  const script = document.createElement('script');
  script.src = URL.createObjectURL(new Blob([files.get('.runtime/player.js')], { type: 'application/javascript' }));
  await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('Le player ne peut pas démarrer.')); document.head.append(script); });
}
openStandaloneGame().catch(error => {
  const status = document.querySelector('#unpacking');
  if (status) { status.textContent = `Ouverture impossible : ${error.message}`; status.setAttribute('role', 'alert'); }
  console.error('MWGP standalone bootstrap failed', error);
});
