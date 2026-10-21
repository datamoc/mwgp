// Loaded in the body of every standalone game page, after the page's own markup and before its payload.
//
// 1. Size gate. A page over the payload limit (meta mwgp-payload-bytes > mwgp-payload-limit) is stopped before the browser
//    parses the payload, since such a page can time out. Its markup is already there, so the gate replaces the content
//    with a panel: unpack the game once into a folder the user chooses (or the browser's private storage where there is no
//    folder picker), then play from there. A folder unpacked earlier is remembered per game and offered on the next visit.
//    "Open the page anyway" reloads with ?force=1.
// 2. Archive reader. The gzip index and file reader that bootstrap.js uses lives here too, so the format is read in one place.
//
// Plain script: no imports, and no closing script tag or comment opener in it, since it is inlined in the page.
(function () {
  const DEFAULT_LIMIT = 100 * 1024 * 1024;
  const DB_NAME = 'mwgp-standalone';
  const STORE = 'folders';
  const FOLDER_FILE = '.mwgp-standalone.json';

  const meta = name => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
  const statusText = text => { const element = document.getElementById('gate-status'); if (element) element.textContent = text; };

  // ---- the archive ------------------------------------------------------------------------------------------------
  // Reads the gzip archive whose base64 blocks come from nextBlock() (a string, or null at the end). Returns the index
  // and the files, each as the list of parts that make it (Uint8Array or Blob).
  async function readArchive(nextBlock, report = () => {}) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression. Use a recent browser.');
    let lines = [], line = 0, ended = false;
    const compressed = new ReadableStream({ pull(controller) {
      while (line === lines.length) {
        const block = ended ? null : nextBlock();
        if (block === null) { ended = true; controller.close(); return; }
        lines = block.trim().split('\n'); line = 0;
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
      report(files.size + 1, metadata.files.length);
      files.set(entry.path, await readParts(entry.size));
    }
    // Read to EOF so gzip's checksum and truncation errors cannot go unnoticed.
    if (offset !== current.length || !(await reader.read()).done) throw new Error('Unexpected content after the game.');
    if (!files.has('mwgp.json') || !files.has('.runtime/player.js') || !files.has('.runtime/mwg.js')) throw new Error('The player or the game is missing.');
    return { metadata, files };
  }

  // Starts the game from its files: the player script and the licence text come from the archive, as the bootstrap always did.
  async function start(files, metadata) {
    globalThis.mwgpStandalone = { files, metadata, playerVersion: metadata.playerVersion };
    const licenses = document.getElementById('standalone-licenses');
    if (licenses && files.has('.runtime/LICENCES.txt')) licenses.textContent = await new Blob(files.get('.runtime/LICENCES.txt')).text();
    const script = document.createElement('script');
    script.src = URL.createObjectURL(new Blob(files.get('.runtime/player.js'), { type: 'application/javascript' }));
    await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('The player cannot start.')); document.head.append(script); });
  }

  // ---- storage: a folder the user chose, or the browser's private storage ---------------------------------------
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function saveRecord(id, record) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(record, id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }
  async function loadRecord(id) {
    const db = await openDatabase();
    const record = await new Promise((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).get(id); request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); });
    db.close();
    return record;
  }
  // A record is { kind: 'folder', handle } (a directory the user granted) or { kind: 'opfs' } (private storage).
  async function rootOf(record) {
    if (!record) return null;
    if (record.kind === 'opfs') return navigator.storage.getDirectory();
    if (record.kind === 'folder' && record.handle) {
      const permission = { mode: 'readwrite' };
      if ((await record.handle.queryPermission?.(permission)) === 'granted') return record.handle;
      return (await record.handle.requestPermission?.(permission)) === 'granted' ? record.handle : null;
    }
    return null;
  }
  async function chooseRoot() {
    if (typeof window.showDirectoryPicker === 'function') {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      return { record: { kind: 'folder', handle }, root: handle };
    }
    const root = await navigator.storage.getDirectory();
    return { record: { kind: 'opfs' }, root };
  }

  async function writeArchive(root, { metadata, files }, report) {
    // A directory placeholder (an empty entry whose path is a prefix of other paths) cannot also be a file on disk.
    const paths = [...files.keys()];
    let index = 0;
    for (const [path, parts] of files) {
      if (parts.every(part => part.byteLength === 0 || part.size === 0) && paths.some(other => other.startsWith(`${path}/`))) continue;
      const segments = path.split('/').filter(Boolean);
      let directory = root;
      for (const name of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(name, { create: true });
      const handle = await directory.getFileHandle(segments[segments.length - 1], { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Blob(parts));
      await writable.close();
      report(++index, paths.length);
    }
    const header = await root.getFileHandle(FOLDER_FILE, { create: true });
    const writable = await header.createWritable();
    await writable.write(JSON.stringify(metadata));
    await writable.close();
  }

  async function readFolder(root) {
    const files = new Map();
    async function walk(directory, prefix) {
      for await (const [name, handle] of directory.entries()) {
        const path = prefix + name;
        if (handle.kind === 'directory') await walk(handle, `${path}/`);
        else if (path !== FOLDER_FILE) files.set(path, [await handle.getFile()]);
      }
    }
    await walk(root, '');
    const metadata = JSON.parse(await (await (await root.getFileHandle(FOLDER_FILE)).getFile()).text());
    return { metadata, files };
  }

  // ---- the panel --------------------------------------------------------------------------------------------------
  // The shell's own markup is kept (the player needs it): it is hidden while the panel is shown, and shown again to play.
  function showPanel() {
    for (const child of document.body.children) child.hidden = true;
    const panel = document.createElement('section');
    panel.id = 'gate-panel';
    panel.style.cssText = 'font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#e8eef7';
    document.body.append(panel);
    return panel;
  }
  function hidePanel() {
    document.getElementById('gate-panel')?.remove();
    for (const child of document.body.children) child.hidden = false;
  }
  function button(label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.cssText = 'font:inherit;padding:8px 14px;margin:4px 6px 4px 0;border-radius:6px;border:1px solid #48627e;background:#1e2d3d;color:inherit;cursor:pointer';
    element.addEventListener('click', onClick);
    return element;
  }

  function renderPanel(info, record) {
    const panel = showPanel();
    const megabytes = Math.round(info.bytes / (1024 * 1024));
    const title = document.createElement('h1');
    title.textContent = `This game page is ${megabytes} MB`;
    const text = document.createElement('p');
    text.textContent = 'A page this size can time out while the browser loads it, so it was stopped before the game was read. Unpack the game once into a local folder, or into the browser\'s private storage, and play from there.';
    const actions = document.createElement('p');
    const status = document.createElement('p');
    status.id = 'gate-status';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.html,text/html';
    file.hidden = true;
    panel.append(title, text, actions, status, file);

    if (record) {
      actions.append(button('Open the unpacked copy', async () => {
        const root = await rootOf(record);
        if (!root) { statusText('Access to the unpacked copy was not granted.'); return; }
        const { metadata, files } = await readFolder(root);
        hidePanel();
        await start(files, metadata);
      }));
    }
    actions.append(button('Unpack this game…', async () => {
      try {
        const { record: chosen, root } = await chooseRoot();
        statusText('Now select this page file (the same HTML file you opened).');
        status.append(button('Select this page file…', () => file.click()));
        file.onchange = () => { if (file.files[0]) unpack(file.files[0], info, chosen, root); };
      } catch (error) {
        statusText(`Unpacking was cancelled: ${error.message}`);
      }
    }));
    actions.append(button('Open the page anyway', () => {
      const url = new URL(location.href);
      url.searchParams.set('force', '1');
      location.replace(url.href);
    }));
    actions.append(button('Stop', () => statusText('Loading stopped. Reload the page to try again.')));
  }

  async function unpack(file, info, record, root) {
    try {
      if (file.size > 500 * 1024 * 1024) throw new Error('the page is larger than 500 MB, which a browser cannot read as text');
      statusText('Reading the page…');
      const text = await file.text();
      // The payload blocks are matched by their exact type: this file's own source contains the tag name.
      const blockPattern = /<script data-mwgp-payload type="application\/octet-stream">\n?([\s\S]*?)<\/script>/g;
      const blocks = [...text.matchAll(blockPattern)].map(match => match[1]);
      const archive = await readArchive(() => (blocks.length ? blocks.shift() : null), (done, total) => statusText(`Unpacking the game… ${done}/${total}`));
      if (archive.metadata.id !== info.id) throw new Error('this page is a different game');
      await writeArchive(root, archive, (done, total) => statusText(`Writing the game… ${done}/${total}`));
      await saveRecord(info.id, record);
      hidePanel();
      await start(archive.files, archive.metadata);
    } catch (error) {
      statusText(`Unpacking failed: ${error.message}`);
      console.error('MWGP unpack failed', error);
    }
  }

  // ---- wiring -------------------------------------------------------------------------------------------------------
  window.mwgpArchive = { readArchive, start };

  const bytes = Number(meta('mwgp-payload-bytes')) || 0;
  const limit = Number(meta('mwgp-payload-limit')) || DEFAULT_LIMIT;
  const id = meta('mwgp-payload-id');
  if (bytes > limit && id && !new URLSearchParams(location.search).has('force')) {
    window.stop();
    loadRecord(id).catch(() => null).then(record => renderPanel({ id, bytes }, record));
  }
})();
