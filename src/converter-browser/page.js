const $ = selector => document.querySelector(selector);
const source = $('#source'), run = $('#run'), status = $('#status');
let entries = [], project = '', worker = null, workerUrl = null, downloadUrl = null;
let running = false, preparing = false, logs = [], logCount = 0, warnings = 0;
const folderSupported = typeof window.showDirectoryPicker === 'function';
$('#folder-option').disabled = !folderSupported;
if (!folderSupported) $('#folder-hint').textContent = 'L’écriture directe n’est pas disponible dans ce navigateur. Le ZIP reste utilisable.';

function setStatus(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}
function log(message, level = 'log') {
  if (level === 'warn') warnings++;
  logs.push(`${level === 'warn' ? '⚠ ' : ''}${message}`);
  if (logs.length > 300) logs.shift();
  logCount++;
  $('#log').textContent = logs.join('\n');
  $('#log-count').textContent = `(${logCount}${logCount > 300 ? ', 300 dernières lignes' : ''})`;
}
function clearResult() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  $('#download').removeAttribute('href');
  $('#download').hidden = true;
  $('#result').hidden = true;
}
function setRunning(value) {
  running = value;
  run.disabled = value || !entries.length;
  $('#choose').disabled = value;
  source.disabled = value;
  $('#output-options').disabled = value;
  $('#cancel').hidden = !value;
  $('#cancel').disabled = preparing;
}
function disposeWorker() {
  worker?.terminate(); worker = null;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}
$('#choose').onclick = () => source.click();
source.onchange = () => {
  clearResult();
  entries = [...source.files].map(file => ({ file, path: file.webkitRelativePath }));
  project = entries[0]?.path.split('/')[0] || '';
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0);
  const size = total >= 1024 ** 3 ? `${(total / 1024 ** 3).toFixed(2)} Go` : `${(total / 1024 ** 2).toFixed(1)} Mo`;
  $('#selection').textContent = project ? `${project} — ${entries.length.toLocaleString('fr-FR')} fichiers, ${size}` : 'Aucun dossier sélectionné.';
  $('#progress-area').hidden = true;
  run.disabled = !entries.length;
  setStatus(project ? 'Prêt à convertir.' : 'Sélectionnez le dossier d’un jeu pour commencer.');
};

async function newOutputFolder(parent, name) {
  for (let suffix = 0; suffix < 10000; suffix++) {
    const candidate = name + (suffix ? `-${suffix + 1}` : '');
    try { await parent.getDirectoryHandle(candidate); }
    catch (error) {
      // An existing file with this name is occupied too.
      if (error.name === 'TypeMismatchError') continue;
      if (error.name !== 'NotFoundError') throw error;
      return { handle: await parent.getDirectoryHandle(candidate, { create: true }), name: candidate };
    }
  }
  throw new Error('Impossible de créer un nouveau dossier de sortie.');
}

run.onclick = async () => {
  if (running || !entries.length) return;
  clearResult(); disposeWorker();
  logs = []; logCount = 0; warnings = 0;
  $('#log').textContent = ''; $('#log-count').textContent = '';
  const outputName = `${project.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'jeu'}-mwgp`;
  let destination = null, folderName = '';
  const outputFormat = $('input[name=output]:checked').value;
  preparing = true; setRunning(true);
  try {
    if (outputFormat === 'folder') {
      setStatus('Choisissez où créer le dossier du jeu converti.');
      // Invoke the picker directly from the click, preserving user activation.
      const parent = await window.showDirectoryPicker({ mode: 'readwrite' });
      const output = await newOutputFolder(parent, outputName);
      destination = output.handle; folderName = output.name;
      log(`Dossier de sortie : ${folderName}`);
    }
    preparing = false; setRunning(true);
    $('#progress-area').hidden = false;
    $('#progress').value = 0;
    $('#progress-label').textContent = 'Lecture du projet…';
    setStatus('Conversion en cours… Vous pouvez continuer à utiliser la page.');
    const bytes = Uint8Array.from(atob($('#worker-source').textContent.trim()), c => c.charCodeAt(0));
    workerUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/javascript' }));
    worker = new Worker(workerUrl);
    worker.onerror = event => fail(event.message || 'Le Worker de conversion s’est arrêté.');
    worker.onmessageerror = () => fail('Le navigateur n’a pas pu transmettre les fichiers au convertisseur.');
    worker.onmessage = ({ data }) => {
      if (data.type === 'log') log(data.message, data.level);
      if (data.type === 'progress') {
        $('#progress').value = Math.max(0, Math.min(100, data.done / (data.total || 100) * 100));
        $('#progress-label').textContent = data.label;
        if (data.packaging) setStatus('Conversion effectuée. Préparation du téléchargement…');
      }
      if (data.type === 'failure') {
        log(data.stack || data.message, 'error'); fail(data.message);
      }
      if (data.type === 'complete') {
        disposeWorker(); setRunning(false);
        $('#progress').value = 100; $('#progress-label').textContent = 'Terminé';
        const summary = data.summary;
        setStatus(`Conversion terminée${warnings ? ` avec ${warnings} avertissement(s) à consulter dans le journal` : ''}.`, 'success');
        let instruction = `Enregistré dans ${folderName}.`;
        if (data.archive) instruction = data.archive.format === 'html' ? 'Téléchargez la page HTML puis ouvrez-la pour jouer.' : 'Téléchargez puis extrayez le ZIP.';
        $('#result-description').textContent = `${summary.title} — ${summary.maps} carte(s), ${summary.files} fichiers. ${instruction}`;
        $('#result').hidden = false;
        if (data.archive) {
          downloadUrl = URL.createObjectURL(data.archive.blob);
          $('#download').href = downloadUrl;
          $('#download').download = data.archive.name;
          $('#download').hidden = false;
          $('#download').focus();
        }
      }
    };
    worker.postMessage({ entries, project, outputName, destination, output: outputFormat });
  } catch (error) {
    if (error.name === 'AbortError') { preparing = false; setRunning(false); setStatus('Choix du dossier annulé.'); }
    else fail(error.message);
  }
};
function fail(message) {
  disposeWorker(); preparing = false; setRunning(false);
  setStatus(`Conversion interrompue : ${message}`, 'error');
  $('#progress-label').textContent = 'Échec de la conversion. Consultez le journal.';
}
// ---- Studio autonome : recréer le dossier éditable depuis une page de jeu ----
let studioFile = null, studioBusy = false, studioDownloadUrl = null;
const studioFolderSupported = typeof window.showDirectoryPicker === 'function';
if (!studioFolderSupported) $('#studio-folder').title = 'L’écriture directe dans un dossier n’est pas disponible dans ce navigateur. Le ZIP reste utilisable.';
function setStudioStatus(message) { $('#studio-status').textContent = message; }
function studioBusyState() {
  $('#studio-folder').disabled = studioBusy || !studioFile || !studioFolderSupported;
  $('#studio-zip').disabled = studioBusy || !studioFile;
  $('#studio-choose').disabled = studioBusy;
  $('#studio-source').disabled = studioBusy;
}
$('#studio-choose').onclick = () => $('#studio-source').click();
$('#studio-source').onchange = () => {
  studioFile = $('#studio-source').files[0] || null;
  if (studioDownloadUrl) URL.revokeObjectURL(studioDownloadUrl);
  studioDownloadUrl = null; $('#studio-download').hidden = true;
  const size = studioFile ? `${(studioFile.size / 1024 / 1024).toFixed(1)} Mo` : '';
  $('#studio-selection').textContent = studioFile ? `${studioFile.name} — page de jeu autoporteuse, ${size}.` : 'Aucun fichier sélectionné.';
  setStudioStatus(studioFile ? 'Prêt à recréer le dossier éditable.' : 'Choisissez une page de jeu autoporteuse pour recréer son dossier.');
  studioBusyState();
};
async function readStandaloneGame(file) {
  if (typeof DecompressionStream !== 'function') throw new Error('Ce navigateur ne prend pas en charge la décompression gzip. Utilisez un navigateur récent.');
  const payload = (await file.text()).match(/<script id="mwgp-payload" type="application\/octet-stream">([\s\S]*?)<\/script>/)?.[1];
  if (!payload) throw new Error('Ce fichier n’est pas une page de jeu MWGP autoporteuse.');
  const lines = payload.trim().split('\n');
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
  const files = new Map();
  for (const entry of metadata.files) {
    if (typeof entry.path !== 'string' || files.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Entrée de jeu invalide.');
    setStudioStatus(`Lecture de la page de jeu… ${files.size + 1}/${metadata.files.length}`);
    files.set(entry.path, new Blob(await readParts(entry.size)));
  }
  if (offset !== current.length || !(await reader.read()).done) throw new Error('Contenu inattendu après le jeu.');
  return { metadata, files };
}
function recreatedEntries({ files }) {
  const entries = [];
  for (const [path, blob] of files) {
    if (path.startsWith('.runtime/')) continue;
    if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-z]:/i.test(path) ||
        path.split('/').some(part => part === '..' || part === '.')) throw new Error(`Chemin invalide dans la page de jeu : ${path}`);
    entries.push({ path, blob: path.endsWith('/') ? null : blob });
  }
  if (!files.has('mwgp.json')) throw new Error('La page de jeu ne contient pas de manifeste MWGP (mwgp.json).');
  // Pages made before the payload carried Studio files: rebuild the baseline
  // from the manifest, as the Studio does on its first save.
  if (!files.has('.mwgp-conversion.json')) entries.push({ path: '.mwgp-conversion.json', blob: files.get('mwgp.json') });
  if (!files.has('.mwgp-merge-report.json')) entries.push({ path: '.mwgp-merge-report.json', blob: new Blob(['{"preserved":[],"conflicts":[]}']) });
  return entries;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
async function studioZip(entries, name) {
  if (entries.length >= 65535) throw new Error('Le dossier dépasse les limites du ZIP. Utilisez l’écriture dans un dossier.');
  const encoder = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const u16 = value => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value, true); return b; };
  const u32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value >>> 0, true); return b; };
  const push = bytes => { chunks.push(bytes); offset += bytes.length; };
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = entry.blob ? new Uint8Array(await entry.blob.arrayBuffer()) : new Uint8Array();
    if (data.length >= 0xffffffff) throw new Error('Le dossier dépasse les limites du ZIP. Utilisez l’écriture dans un dossier.');
    const crc = crc32(data), localOffset = offset;
    push(new Uint8Array([0x50, 0x4b, 0x03, 0x04])); push(u16(20)); push(u16(0x800)); push(u16(0)); push(u16(0)); push(u16(0x21));
    push(u32(crc)); push(u32(data.length)); push(u32(data.length)); push(u16(nameBytes.length)); push(u16(0)); push(nameBytes); push(data);
    central.push({ nameBytes, crc, size: data.length, localOffset });
  }
  const centralStart = offset;
  for (const item of central) {
    push(new Uint8Array([0x50, 0x4b, 0x01, 0x02])); push(u16(20)); push(u16(20)); push(u16(0x800)); push(u16(0)); push(u16(0)); push(u16(0x21));
    push(u32(item.crc)); push(u32(item.size)); push(u32(item.size)); push(u16(item.nameBytes.length));
    push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0)); push(u32(item.nameBytes.length && item.nameBytes[item.nameBytes.length - 1] === 47 ? 16 : 0)); push(u32(item.localOffset)); push(item.nameBytes);
  }
  push(new Uint8Array([0x50, 0x4b, 0x05, 0x06])); push(u16(0)); push(u16(0)); push(u16(central.length)); push(u16(central.length));
  push(u32(offset - centralStart)); push(u32(centralStart)); push(u16(0));
  return new Blob(chunks, { type: 'application/zip' });
}
function studioOutputName() {
  return studioFile.name.replace(/\.html?$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'jeu';
}
async function studioEntries() {
  studioBusy = true; studioBusyState();
  try {
    const game = await readStandaloneGame(studioFile);
    const version = game.metadata.playerVersion ? `, player ${game.metadata.playerVersion}` : ', player d’une version inconnue (page ancienne)';
    return { entries: recreatedEntries(game), version };
  } finally { studioBusy = false; studioBusyState(); }
}
$('#studio-zip').onclick = async () => {
  if (!studioFile || studioBusy) return;
  try {
    const { entries, version } = await studioEntries();
    const blob = await studioZip(entries, studioOutputName());
    if (studioDownloadUrl) URL.revokeObjectURL(studioDownloadUrl);
    studioDownloadUrl = URL.createObjectURL(blob);
    const link = $('#studio-download');
    link.href = studioDownloadUrl; link.download = `${studioOutputName()}.zip`; link.hidden = false;
    const count = entries.filter(entry => entry.blob).length;
    setStudioStatus(`Dossier recréé : ${count} fichiers${version}. Téléchargez puis extrayez le ZIP.`);
    link.click();
  } catch (error) { setStudioStatus(`Recréation impossible : ${error.message}`); }
};
$('#studio-folder').onclick = async () => {
  if (!studioFile || studioBusy) return;
  try {
    const parent = await window.showDirectoryPicker({ mode: 'readwrite' });
    const { entries, version } = await studioEntries();
    const output = await newOutputFolder(parent, studioOutputName());
    for (const entry of entries) {
      const parts = entry.path.split('/').filter(Boolean);
      let directory = output.handle;
      const folders = entry.blob ? parts.slice(0, -1) : parts;
      for (const part of folders) directory = await directory.getDirectoryHandle(part, { create: true });
      if (!entry.blob) continue;
      const handle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(entry.blob); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
      setStudioStatus(`Écriture du dossier… ${entry.path}`);
    }
    const count = entries.filter(entry => entry.blob).length;
    setStudioStatus(`Dossier recréé dans ${output.name} : ${count} fichiers${version}.`);
  } catch (error) {
    if (error.name === 'AbortError') setStudioStatus('Choix du dossier annulé.');
    else setStudioStatus(`Recréation impossible : ${error.message}`);
  }
};
studioBusyState();
$('#cancel').onclick = () => {
  if (preparing) return;
  disposeWorker(); setRunning(false);
  setStatus('Conversion annulée. Si une sortie vers un dossier était choisie, ce dossier peut être incomplet.');
  $('#progress-label').textContent = 'Annulé';
};
window.addEventListener('beforeunload', event => {
  if (running) { event.preventDefault(); event.returnValue = ''; }
});
