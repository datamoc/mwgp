const $ = selector => document.querySelector(selector);
// Multilingual UI (English by default; choice persisted across MWGP pages).
const I18N = {
  en: { folder_hint_off: 'Direct folder writing is not available in this browser. The ZIP remains usable.',
    selection_none: 'No folder selected.', selection_info: '{project} — {count} files, {size}', ready: 'Ready to convert.',
    select_game_start: "Select a game folder to start.", choose_output: 'Choose where to create the converted game folder.',
    output_folder: 'Output folder: {name}', reading: 'Reading the project…', converting: 'Conversion in progress… You can keep using this page.',
    packaging: 'Conversion done. Preparing the download…', done: 'Conversion complete', done_warnings: 'Conversion complete with {count} warning(s) to check in the log.',
    saved_in: 'Saved in {name}.', instr_html: 'Download the HTML page, then open it to play.', instr_zip: 'Download, then extract the ZIP.',
    result_desc: '{title} — {maps} map(s), {files} files. {instruction}', failed: 'Conversion stopped: {message}',
    failed_label: 'Conversion failed. See the log.', folder_cancelled: 'Folder choice cancelled.',
    cancelled: 'Conversion cancelled. If folder output was chosen, that folder may be incomplete.', cancelled_label: 'Cancelled',
    last_entries: ', last 300 entries', new_folder_error: 'Could not create a new output folder.',
    studio_no_file: 'No file selected.', studio_selection_info: '{name} — self-contained game page, {size}.',
    studio_ready: 'Ready to recreate the editable folder.', studio_start: 'Choose a self-contained game page to recreate its folder.',
    studio_reading: 'Reading the game page… {done}/{total}', studio_recreated_zip: 'Folder recreated: {count} files{version}. Download, then extract the ZIP.',
    studio_recreated_folder: 'Folder recreated in {name}: {count} files{version}.', studio_writing: 'Writing the folder… {path}',
    studio_fail: 'Recreation failed: {message}', studio_version: ', player {version}', studio_version_unknown: ', unknown player version (older page)',
    err_gzip: 'This browser does not support gzip decompression. Use a recent browser.',
    err_not_standalone: 'This file is not a self-contained MWGP game page.', err_truncated: 'The game content is truncated.',
    err_invalid_index: 'Invalid game index.', err_unknown_format: 'Unknown game format.', err_invalid_entry: 'Invalid game entry.',
    err_unexpected: 'Unexpected content after the game.', err_no_manifest: 'The game page contains no MWGP manifest (mwgp.json).',
    err_invalid_path: 'Invalid path in the game page: {path}', err_zip_files: 'The folder exceeds ZIP limits. Use folder writing instead.',
    err_zip_size: 'The folder exceeds ZIP limits. Use folder writing instead.' },
  fr: { folder_hint_off: 'L’écriture directe n’est pas disponible dans ce navigateur. Le ZIP reste utilisable.',
    selection_none: 'Aucun dossier sélectionné.', selection_info: '{project} — {count} fichiers, {size}', ready: 'Prêt à convertir.',
    select_game_start: 'Sélectionnez le dossier d’un jeu pour commencer.', choose_output: 'Choisissez où créer le dossier du jeu converti.',
    output_folder: 'Dossier de sortie : {name}', reading: 'Lecture du projet…', converting: 'Conversion en cours… Vous pouvez continuer à utiliser la page.',
    packaging: 'Conversion effectuée. Préparation du téléchargement…', done: 'Conversion terminée', done_warnings: 'Conversion terminée avec {count} avertissement(s) à consulter dans le journal.',
    saved_in: 'Enregistré dans {name}.', instr_html: 'Téléchargez la page HTML puis ouvrez-la pour jouer.', instr_zip: 'Téléchargez puis extrayez le ZIP.',
    result_desc: '{title} — {maps} carte(s), {files} fichiers. {instruction}', failed: 'Conversion interrompue : {message}',
    failed_label: 'Échec de la conversion. Consultez le journal.', folder_cancelled: 'Choix du dossier annulé.',
    cancelled: 'Conversion annulée. Si une sortie vers un dossier était choisie, ce dossier peut être incomplet.', cancelled_label: 'Annulé',
    last_entries: ', 300 dernières lignes', new_folder_error: 'Impossible de créer un nouveau dossier de sortie.',
    studio_no_file: 'Aucun fichier sélectionné.', studio_selection_info: '{name} — page de jeu autoporteuse, {size}.',
    studio_ready: 'Prêt à recréer le dossier éditable.', studio_start: 'Choisissez une page de jeu autoporteuse pour recréer son dossier.',
    studio_reading: 'Lecture de la page de jeu… {done}/{total}', studio_recreated_zip: 'Dossier recréé : {count} fichiers{version}. Téléchargez puis extrayez le ZIP.',
    studio_recreated_folder: 'Dossier recréé dans {name} : {count} fichiers{version}.', studio_writing: 'Écriture du dossier… {path}',
    studio_fail: 'Recréation impossible : {message}', studio_version: ', player {version}', studio_version_unknown: ', player d’une version inconnue (page ancienne)',
    err_gzip: 'Ce navigateur ne prend pas en charge la décompression gzip. Utilisez un navigateur récent.',
    err_not_standalone: 'Ce fichier n’est pas une page de jeu MWGP autoporteuse.', err_truncated: 'Le contenu du jeu est tronqué.',
    err_invalid_index: 'Index de jeu invalide.', err_unknown_format: 'Format de jeu inconnu.', err_invalid_entry: 'Entrée de jeu invalide.',
    err_unexpected: 'Contenu inattendu après le jeu.', err_no_manifest: 'La page de jeu ne contient pas de manifeste MWGP (mwgp.json).',
    err_invalid_path: 'Chemin invalide dans la page de jeu : {path}', err_zip_files: 'Le dossier dépasse les limites du ZIP. Utilisez l’écriture dans un dossier.',
    err_zip_size: 'Le dossier dépasse les limites du ZIP. Utilisez l’écriture dans un dossier.' },
  de: { folder_hint_off: 'Direktes Schreiben in Ordner ist in diesem Browser nicht verfügbar. Die ZIP-Datei bleibt nutzbar.',
    selection_none: 'Kein Ordner ausgewählt.', selection_info: '{project} — {count} Dateien, {size}', ready: 'Bereit zur Umwandlung.',
    select_game_start: 'Wählen Sie einen Spielordner, um zu beginnen.', choose_output: 'Wählen Sie, wo der Ordner des umgewandelten Spiels erstellt wird.',
    output_folder: 'Ausgabeordner: {name}', reading: 'Projekt wird gelesen…', converting: 'Umwandlung läuft… Sie können diese Seite weiter nutzen.',
    packaging: 'Umwandlung abgeschlossen. Download wird vorbereitet…', done: 'Umwandlung abgeschlossen', done_warnings: 'Umwandlung abgeschlossen, mit {count} Warnung(en) im Protokoll.',
    saved_in: 'Gespeichert in {name}.', instr_html: 'Laden Sie die HTML-Seite herunter und öffnen Sie sie zum Spielen.', instr_zip: 'Herunterladen und dann die ZIP-Datei entpacken.',
    result_desc: '{title} — {maps} Karte(n), {files} Dateien. {instruction}', failed: 'Umwandlung abgebrochen: {message}',
    failed_label: 'Umwandlung fehlgeschlagen. Siehe Protokoll.', folder_cancelled: 'Ordnerauswahl abgebrochen.',
    cancelled: 'Umwandlung abgebrochen. Bei Ordner-Ausgabe kann dieser Ordner unvollständig sein.', cancelled_label: 'Abgebrochen',
    last_entries: ', letzte 300 Einträge', new_folder_error: 'Es konnte kein neuer Ausgabeordner erstellt werden.',
    studio_no_file: 'Keine Datei ausgewählt.', studio_selection_info: '{name} — eigenständige Spielseite, {size}.',
    studio_ready: 'Bereit, den bearbeitbaren Ordner neu zu erstellen.', studio_start: 'Wählen Sie eine eigenständige Spielseite, um ihren Ordner neu zu erstellen.',
    studio_reading: 'Spielseite wird gelesen… {done}/{total}', studio_recreated_zip: 'Ordner neu erstellt: {count} Dateien{version}. Herunterladen und ZIP entpacken.',
    studio_recreated_folder: 'Ordner neu erstellt in {name}: {count} Dateien{version}.', studio_writing: 'Ordner wird geschrieben… {path}',
    studio_fail: 'Neuerstellung fehlgeschlagen: {message}', studio_version: ', Player {version}', studio_version_unknown: ', unbekannte Player-Version (ältere Seite)',
    err_gzip: 'Dieser Browser unterstützt keine gzip-Dekompression. Nutzen Sie einen aktuellen Browser.',
    err_not_standalone: 'Diese Datei ist keine eigenständige MWGP-Spielseite.', err_truncated: 'Die Spieldaten sind abgeschnitten.',
    err_invalid_index: 'Ungültiger Spielindex.', err_unknown_format: 'Unbekanntes Spielformat.', err_invalid_entry: 'Ungültiger Spieleintrag.',
    err_unexpected: 'Unerwarteter Inhalt nach dem Spiel.', err_no_manifest: 'Die Spielseite enthält kein MWGP-Manifest (mwgp.json).',
    err_invalid_path: 'Ungültiger Pfad in der Spielseite: {path}', err_zip_files: 'Der Ordner überschreitet die ZIP-Grenzen. Nutzen Sie stattdessen die Ordner-Ausgabe.',
    err_zip_size: 'Der Ordner überschreitet die ZIP-Grenzen. Nutzen Sie stattdessen die Ordner-Ausgabe.' },
};
Object.assign(I18N.en, { lang_label: 'Language', kicker: 'Converter', h1: 'Your game, in MWGP format.', intro: 'Choose an RPG Maker MV, MZ, XP, VX or VX Ace project. Conversion happens on this computer, in your browser. Your files stay here.', step1: '1. Choose the game', choose_folder: 'Choose a folder', selection_default: 'The complete game folder, with its data, scripts and resources.', step2: '2. Save the result', out_html: 'Playable HTML page', out_html_hint: 'The player and the game in a single file, gzip-compressed. Open it to play offline.', out_zip: 'MWGP archive (ZIP)', out_zip_hint: 'Extract it for the local player or the Studio.', out_folder: 'Write to a folder', out_folder_hint: 'A new subfolder will be created at the chosen location.', run: 'Convert to MWGP', cancel: 'Cancel', hint: 'Images, sounds and other resources are included in the result.', status_start: 'Select a game folder to start.', download: 'Download the converted game', studio_h: '3. Standalone Studio: recreate the editable folder', studio_p: 'From a self-contained game page generated above, recreate the complete MWGP folder (mwgp.json, assets/ and the Studio conversion baseline), with no server. Then place that folder among your converted projects to open it in the Studio or the local player.', studio_choose: 'Choose a game page (.html)', studio_selection: 'The playable HTML page of a converted game, as downloaded in the previous step.', studio_folder: 'Write to a folder', studio_zip: 'Download a ZIP', studio_download: 'Download the recreated folder', studio_status: 'Choose a self-contained game page to recreate its folder.', log_h: 'Conversion log', log_default: 'The steps and any compatibility limits will appear here.', footer: "The HTML page embeds the player and the game's resources. MWGP output as ZIP or folder remains available for the Studio. Conversion keeps the command-line converter's compatibility limits. This page works offline. Cancelling may leave a partial folder; run the conversion again into a new folder.", licences: 'Open-source software and licences' });
Object.assign(I18N.fr, { lang_label: 'Langue', kicker: 'Convertisseur', h1: 'Votre jeu, au format MWGP.', intro: 'Choisissez un projet RPG Maker MV, MZ, XP, VX ou VX Ace. La conversion s’effectue sur cet ordinateur, dans votre navigateur. Vos fichiers restent ici.', step1: '1. Choisir le jeu', choose_folder: 'Choisir un dossier', selection_default: 'Le dossier du jeu complet, avec ses données, ses scripts et ses ressources.', step2: '2. Enregistrer le résultat', out_html: 'Page HTML jouable', out_html_hint: 'Le player et le jeu dans un seul fichier, compressés en gzip. Ouvrez-le pour jouer hors connexion.', out_zip: 'Archive MWGP (ZIP)', out_zip_hint: 'À extraire pour le player local ou le Studio.', out_folder: 'Écrire dans un dossier', out_folder_hint: 'Un nouveau sous-dossier sera créé à l’emplacement choisi.', run: 'Convertir en MWGP', cancel: 'Annuler', hint: 'Les images, sons et autres ressources sont inclus dans le résultat.', status_start: 'Sélectionnez le dossier d’un jeu pour commencer.', download: 'Télécharger le jeu converti', studio_h: '3. Studio autonome : recréer le dossier éditable', studio_p: 'À partir d’une page de jeu autoporteuse générée ci-dessus, recréez le dossier MWGP complet (mwgp.json, assets/ et la base de conversion du Studio), sans serveur. Placez ensuite ce dossier parmi vos projets convertis pour l’ouvrir dans le Studio ou le lecteur local.', studio_choose: 'Choisir une page de jeu (.html)', studio_selection: 'La page HTML jouable d’un jeu converti, telle que téléchargée à l’étape précédente.', studio_folder: 'Écrire dans un dossier', studio_zip: 'Télécharger un ZIP', studio_download: 'Télécharger le dossier recréé', studio_status: 'Choisissez une page de jeu autoporteuse pour recréer son dossier.', log_h: 'Journal de conversion', log_default: 'Les étapes et les éventuelles limites de compatibilité apparaîtront ici.', footer: 'La page HTML embarque le player et les ressources du jeu. La sortie MWGP en ZIP ou en dossier reste disponible pour le Studio. La conversion conserve les limites de compatibilité du convertisseur en ligne de commande. Cette page fonctionne hors connexion. Une annulation peut laisser un dossier partiel ; relancez la conversion dans un nouveau dossier.', licences: 'Logiciels libres et licences' });
Object.assign(I18N.de, { lang_label: 'Sprache', kicker: 'Konverter', h1: 'Ihr Spiel, im MWGP-Format.', intro: 'Wählen Sie ein Projekt aus RPG Maker MV, MZ, XP, VX oder VX Ace. Die Umwandlung läuft auf diesem Computer, in Ihrem Browser. Ihre Dateien bleiben hier.', step1: '1. Spiel wählen', choose_folder: 'Ordner wählen', selection_default: 'Der vollständige Spielordner mit Daten, Skripten und Ressourcen.', step2: '2. Ergebnis speichern', out_html: 'Spielbare HTML-Seite', out_html_hint: 'Player und Spiel in einer Datei, gzip-komprimiert. Öffnen, um offline zu spielen.', out_zip: 'MWGP-Archiv (ZIP)', out_zip_hint: 'Für den lokalen Player oder das Studio entpacken.', out_folder: 'In einen Ordner schreiben', out_folder_hint: 'Am gewählten Ort wird ein neuer Unterordner erstellt.', run: 'In MWGP umwandeln', cancel: 'Abbrechen', hint: 'Bilder, Töne und andere Ressourcen sind im Ergebnis enthalten.', status_start: 'Wählen Sie einen Spielordner, um zu beginnen.', download: 'Umgewandeltes Spiel herunterladen', studio_h: '3. Eigenständiges Studio: den bearbeitbaren Ordner neu erstellen', studio_p: 'Erstellen Sie aus einer oben erzeugten eigenständigen Spielseite den vollständigen MWGP-Ordner neu (mwgp.json, assets/ und die Umwandlungs-Basislinie des Studios), ohne Server. Legen Sie diesen Ordner dann zu Ihren umgewandelten Projekten, um ihn im Studio oder lokalen Player zu öffnen.', studio_choose: 'Spielseite wählen (.html)', studio_selection: 'Die spielbare HTML-Seite eines umgewandelten Spiels, wie im vorherigen Schritt heruntergeladen.', studio_folder: 'In einen Ordner schreiben', studio_zip: 'ZIP herunterladen', studio_download: 'Neu erstellten Ordner herunterladen', studio_status: 'Wählen Sie eine eigenständige Spielseite, um ihren Ordner neu zu erstellen.', log_h: 'Umwandlungsprotokoll', log_default: 'Die Schritte und etwaige Kompatibilitätsgrenzen erscheinen hier.', footer: 'Die HTML-Seite bettet den Player und die Ressourcen des Spiels ein. MWGP-Ausgabe als ZIP oder Ordner bleibt für das Studio verfügbar. Die Umwandlung behält die Kompatibilitätsgrenzen des Befehlszeilen-Konverters. Diese Seite funktioniert offline. Abbrechen kann einen unvollständigen Ordner hinterlassen; führen Sie die Umwandlung erneut in einen neuen Ordner aus.', licences: 'Open-Source-Software und Lizenzen' });
Object.assign(I18N.en, { support: '♥ Support the project' });
Object.assign(I18N.fr, { support: '♥ Participer au projet' });
Object.assign(I18N.de, { support: '♥ Projekt unterstützen' });
let lang = (() => { try { const saved = localStorage.getItem('mwgp-lang'); return ['en', 'fr', 'de'].includes(saved) ? saved : 'en'; } catch { return 'en'; } })();
const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), I18N[lang][key] || I18N.en[key] || key);
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  const select = $('#lang'); if (select) select.value = lang;
  if (!folderSupported) $('#folder-hint').textContent = t('folder_hint_off');
  if (!entries.length) { $('#selection').textContent = t('selection_default'); setStatus(t('select_game_start')); }
  if (!studioFile) { $('#studio-selection').textContent = t('studio_selection'); setStudioStatus(t('studio_start')); }
}

const source = $('#source'), run = $('#run'), status = $('#status');
let entries = [], project = '', worker = null, workerUrl = null, downloadUrl = null;
let running = false, preparing = false, logs = [], logCount = 0, warnings = 0;
const folderSupported = typeof window.showDirectoryPicker === 'function';
$('#folder-option').disabled = !folderSupported;
if (!folderSupported) $('#folder-hint').textContent = t('folder_hint_off');

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
  $('#log-count').textContent = `(${logCount}${logCount > 300 ? t('last_entries') : ''})`;
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
  const size = total >= 1024 ** 3 ? `${(total / 1024 ** 3).toFixed(2)} GB` : `${(total / 1024 ** 2).toFixed(1)} MB`;
  $('#selection').textContent = project ? t('selection_info', { project, count: entries.length.toLocaleString(lang), size }) : t('selection_none');
  $('#progress-area').hidden = true;
  run.disabled = !entries.length;
  setStatus(project ? t('ready') : t('select_game_start'));
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
  throw new Error(t('new_folder_error'));
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
      setStatus(t('choose_output'));
      // Invoke the picker directly from the click, preserving user activation.
      const parent = await window.showDirectoryPicker({ mode: 'readwrite' });
      const output = await newOutputFolder(parent, outputName);
      destination = output.handle; folderName = output.name;
      log(t('output_folder', { name: folderName }));
    }
    preparing = false; setRunning(true);
    $('#progress-area').hidden = false;
    $('#progress').value = 0;
    $('#progress-label').textContent = t('reading');
    setStatus(t('converting'));
    const bytes = Uint8Array.from(atob($('#worker-source').textContent.trim()), c => c.charCodeAt(0));
    workerUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/javascript' }));
    worker = new Worker(workerUrl);
    worker.onerror = event => fail(event.message || t('worker_stopped'));
    worker.onmessageerror = () => fail(t('worker_transfer'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'log') log(data.message, data.level);
      if (data.type === 'progress') {
        $('#progress').value = Math.max(0, Math.min(100, data.done / (data.total || 100) * 100));
        $('#progress-label').textContent = data.label;
        if (data.packaging) setStatus(t('packaging'));
      }
      if (data.type === 'failure') {
        log(data.stack || data.message, 'error'); fail(data.message);
      }
      if (data.type === 'complete') {
        disposeWorker(); setRunning(false);
        $('#progress').value = 100; $('#progress-label').textContent = t('done');
        const summary = data.summary;
        setStatus(warnings ? t('done_warnings', { count: warnings }) : `${t('done')}.`, 'success');
        let instruction = t('saved_in', { name: folderName });
        if (data.archive) instruction = data.archive.format === 'html' ? t('instr_html') : t('instr_zip');
        $('#result-description').textContent = t('result_desc', { title: summary.title, maps: summary.maps, files: summary.files, instruction });
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
    if (error.name === 'AbortError') { preparing = false; setRunning(false); setStatus(t('folder_cancelled')); }
    else fail(error.message);
  }
};
function fail(message) {
  disposeWorker(); preparing = false; setRunning(false);
  setStatus(t('failed', { message }), 'error');
  $('#progress-label').textContent = t('failed_label');
}
// ---- Studio autonome : recréer le dossier éditable depuis une page de jeu ----
let studioFile = null, studioBusy = false, studioDownloadUrl = null;
const studioFolderSupported = typeof window.showDirectoryPicker === 'function';
if (!studioFolderSupported) $('#studio-folder').title = t('folder_hint_off');
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
  const size = studioFile ? `${(studioFile.size / 1024 / 1024).toFixed(1)} MB` : '';
  $('#studio-selection').textContent = studioFile ? t('studio_selection_info', { name: studioFile.name, size }) : t('studio_no_file');
  setStudioStatus(studioFile ? t('studio_ready') : t('studio_start'));
  studioBusyState();
};
async function readStandaloneGame(file) {
  if (typeof DecompressionStream !== 'function') throw new Error(t('err_gzip'));
  const payload = (await file.text()).match(/<script id="mwgp-payload" type="application\/octet-stream">([\s\S]*?)<\/script>/)?.[1];
  if (!payload) throw new Error(t('err_not_standalone'));
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
        if (next.done) throw new Error(t('err_truncated'));
        current = next.value; offset = 0;
      }
      const count = Math.min(length, current.length - offset);
      parts.push(current.subarray(offset, offset + count));
      offset += count; length -= count;
    }
    return parts;
  }
  const headerSize = new DataView(await new Blob(await readParts(4)).arrayBuffer()).getUint32(0, true);
  if (!headerSize || headerSize > 32 * 1024 * 1024) throw new Error(t('err_invalid_index'));
  const metadata = JSON.parse(await new Blob(await readParts(headerSize)).text());
  if (metadata.format !== 'MWGP-standalone' || metadata.version !== 1 || !Array.isArray(metadata.files)) throw new Error(t('err_unknown_format'));
  const files = new Map();
  for (const entry of metadata.files) {
    if (typeof entry.path !== 'string' || files.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(t('err_invalid_entry'));
    setStudioStatus(t('studio_reading', { done: files.size + 1, total: metadata.files.length }));
    files.set(entry.path, new Blob(await readParts(entry.size)));
  }
  if (offset !== current.length || !(await reader.read()).done) throw new Error(t('err_unexpected'));
  return { metadata, files };
}
function recreatedEntries({ files }) {
  const entries = [];
  for (const [path, blob] of files) {
    if (path.startsWith('.runtime/')) continue;
    if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-z]:/i.test(path) ||
        path.split('/').some(part => part === '..' || part === '.')) throw new Error(t('err_invalid_path', { path }));
    entries.push({ path, blob: path.endsWith('/') ? null : blob });
  }
  if (!files.has('mwgp.json')) throw new Error(t('err_no_manifest'));
  // Pages made before the payload carried Studio files: rebuild the baseline
  // from the manifest, as the Studio does on its first save.
  if (!files.has('.mwgp-conversion.json')) entries.push({ path: '.mwgp-conversion.json', blob: files.get('mwgp.json') });
  if (!files.has('.mwgp-merge-report.json')) entries.push({ path: '.mwgp-merge-report.json', blob: new Blob(['{"preserved":[],"conflicts":[]}']) });
  return entries;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
async function studioZip(entries, name) {
  if (entries.length >= 65535) throw new Error(t('err_zip_files'));
  const encoder = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const u16 = value => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value, true); return b; };
  const u32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value >>> 0, true); return b; };
  const push = bytes => { chunks.push(bytes); offset += bytes.length; };
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = entry.blob ? new Uint8Array(await entry.blob.arrayBuffer()) : new Uint8Array();
    if (data.length >= 0xffffffff) throw new Error(t('err_zip_size'));
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
    const version = game.metadata.playerVersion ? t('studio_version', { version: game.metadata.playerVersion }) : t('studio_version_unknown');
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
    setStudioStatus(t('studio_recreated_zip', { count, version }));
    link.click();
  } catch (error) { setStudioStatus(t('studio_fail', { message: error.message })); }
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
      setStudioStatus(t('studio_writing', { path: entry.path }));
    }
    const count = entries.filter(entry => entry.blob).length;
    setStudioStatus(t('studio_recreated_folder', { name: output.name, count, version }));
  } catch (error) {
    if (error.name === 'AbortError') setStudioStatus(t('folder_cancelled'));
    else setStudioStatus(t('studio_fail', { message: error.message }));
  }
};
studioBusyState();
$('#cancel').onclick = () => {
  if (preparing) return;
  disposeWorker(); setRunning(false);
  setStatus(t('cancelled'));
  $('#progress-label').textContent = t('cancelled_label');
};
Object.assign(I18N.en, { worker_stopped: 'The conversion worker stopped.', worker_transfer: 'The browser could not send the files to the converter.' });
Object.assign(I18N.fr, { worker_stopped: 'Le Worker de conversion s’est arrêté.', worker_transfer: 'Le navigateur n’a pas pu transmettre les fichiers au convertisseur.' });
Object.assign(I18N.de, { worker_stopped: 'Der Umwandlungs-Worker wurde beendet.', worker_transfer: 'Der Browser konnte die Dateien nicht an den Konverter senden.' });
$('#lang').onchange = () => {
  lang = $('#lang').value;
  try { localStorage.setItem('mwgp-lang', lang); } catch { /* private window */ }
  applyLang();
};
applyLang();
window.addEventListener('beforeunload', event => {
  if (running) { event.preventDefault(); event.returnValue = ''; }
});
