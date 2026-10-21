// Shared multilingual UI for MWGP Studio (server and standalone builds).
// English is the default; the choice is persisted under the same key the
// converter page uses, so one choice follows the user across MWGP pages.
const KEY = 'mwgp-lang';
let lang = 'en';
try { const saved = localStorage.getItem(KEY); if (['en', 'fr', 'de'].includes(saved)) lang = saved; } catch { /* private window */ }
export const currentLang = () => lang;
const T = {
en: {
  catalogue: '◀ Catalogue', new_project: '✚ New project', play: '▶ Test (Play MWGP)', save: '💾 Save', export: '⬇ Export',
  manifest: 'Full manifest', assets: 'Resources', compare: 'Compare conversion', player_label: 'Player',
  tab_maps: 'Maps', tab_database: 'Actors', tab_tools: 'Tools', new_map: '✚ New map', search_map: 'Search a map…',
  db_actors: 'Database actors', actor_name: "Actor's name", actor_params_note: 'HP and other per-level parameters: "classes" table, "params" field, in the full database.',
  actor_profile: 'Profile', apply_actor: 'Apply to the actor', mode: 'Manipulation mode', tool_inspect: '👆 Inspect', tool_paint: '🖌️ Paint',
  tool_player: '🚩 Player', tool_event: '➕ Event', layer: 'Active layer', layer0: 'Layer 0 (Ground / Terrain)', layer1: 'Layer 1 (Elements / Low)', layer2: 'Layer 2 (Details / High)',
  palette: 'Tile palette', custom_tile: 'Custom tile ID', grid: 'Grid', inspector: 'Event Inspector',
  no_event: 'Select an event on the map, or create one with the ➕ Event tool.', event_name: "Event's name", pos_x: 'Position X', pos_y: 'Position Y',
  trigger: 'Trigger', trig0: 'Action button (Enter/Space)', trig1: 'Player touch', trig2: 'Event touch', trig3: 'Automatic (Autorun)', trig4: 'Parallel process',
  commands: 'Command flow', add_cmd: '➕ Command', apply_event: 'Apply to the event', delete_event: 'Delete the event',
  compare_h: 'Comparison with the conversion', compare_p: 'Entities marked "modified (protected)" by their originHash fingerprint are preserved on a new conversion.',
  manifest_h: 'Full manifest', manifest_p: 'Every converted field is accessible here: pages, choices, images, sounds, maps, database and scripts. The JSON must follow the MWGP format.',
  apply: 'Apply', close: 'Close', assets_h: 'Game resources',
  assets_p: 'Edit text files, or replace images and sounds. Edits are recorded in the playable folder and kept across reconversions.',
  asset_up: 'Parent folder', compare_with: 'Compare with', ref_fresh: 'The last conversion', ref_base: 'The reference before editing',
  edited_playable: 'Playable edit', save_text: 'Save the text', replace_file: 'Replace the file',
  loading: 'Loading…', untitled: 'Untitled game', not_modified: 'Not modified', modifications: '{count} modification(s)',
  map_header: 'Map #{id}: {name} ({w}×{h})', ev_suffix: '{count} ev.', modified: 'modified', original: 'Original', modified_protected: 'Modified (protected)',
  hint_inspect: 'Active tool: Inspect. Click an event to edit it.', hint_paint: 'Active tool: Paint. Click or drag on the map with the selected tile (Layer {layer}).',
  hint_player: 'Active tool: Player. Click the map to set the player start point.', hint_event: 'Active tool: Add Event. Click a cell to create an event.',
  cursor: 'X: {x}, Y: {y} | Tile: {tile}', tile_grass: 'Grass', tile_water: 'Water', tile_dirt: 'Dirt/Path', tile_stone: 'Stone/Paving',
  tile_wall: 'Stone wall', tile_roof: 'Red roof', tile_sand: 'Sand', tile_wood: 'Wood floor', tile_empty: 'Empty (0)',
  loading_project: 'Loading the project…', load_error: 'Load error: {message}', no_project: 'No MWGP project found.', catalog_error: 'Could not load the catalogue: {message}',
  new_project_prompt: 'Project name (created in MWGP_versions, editable without RPG Maker):', my_game: 'My game', create_failed: 'Creation failed: {message}',
  map_name_prompt: 'Name of the new map?', map_default: 'Map {count}', width_prompt: 'Width (cells)?', height_prompt: 'Height (cells)?',
  map_created: 'Map #{id} created and protected', tile_painted: 'Tile painted at ({x}, {y}): {tile}', player_moved: 'Player start moved to ({x}, {y})',
  event_created: 'New event #{id} created at ({x}, {y})', event_updated: 'Event #{id} updated and protected', event_deleted: 'Event deleted (protected against reconversion)',
  new_message: 'New message created in MWGP Studio.', text_to_show: 'Text to show…', actor_updated: 'Actor #{id} updated and protected',
  db_full: 'Full database (all tables)', new_row: '✚ New row', row_name_prompt: 'Name of the row ({table})?', new_name: 'New',
  row_created: '{table} #{id} created and protected', row_updated: '{table} #{id} updated and protected', no_rows: 'No object rows.',
  invalid_json: 'Invalid JSON: {message}', invalid_cmd_json: 'Invalid command JSON: {message}', manifest_applied: 'Manifest applied. Save to test it.',
  manifest_required: 'An MWGP manifest with maps is required', saving: 'Saving…', saved: '✓ Project saved successfully!', save_error: 'Save error: {message}',
  exported: 'Manifest exported', version_invalid: 'Invalid player version: expected the 1.2.3 format', version_set: 'Project player version: {version} (save to publish it)',
  compare_done: '{protected} protected fields · {conflicts} divergences', compare_failed: 'Comparison failed',
  cmd_say: '[say] Text dialogue', cmd_ask: '[ask] Choice', cmd_switch: '[setSwitch] Switch', prompt_label: 'Prompt:', on: 'ON (Active)', off: 'OFF (Inactive)',
  no_commands: 'No command in this page.', asset_select: 'Select a folder or a file…', asset_none: 'No resource copied into this folder.',
  asset_absent: 'Resource absent in this version.', asset_download: 'Download ({size} bytes)', asset_saved: 'Resource saved and protected against reconversions.',
  asset_protected_status: 'Protected edit · {state}\nReference: {base}\nEdit: {edited}\nConversion: {fresh}',
  asset_divergent: 'differs from the conversion', asset_same: 'identical to the conversion', asset_unprotected: 'Converted resource. Saving keeps its reference and protects your edit.',
  asset_edited_label: 'Edited resource', asset_ref_label: 'Comparison resource',
},
fr: {
  catalogue: '◀ Catalogue', new_project: '✚ Nouveau projet', play: '▶ Tester (Play MWGP)', save: '💾 Sauvegarder', export: '⬇ Exporter',
  manifest: 'Manifeste complet', assets: 'Ressources', compare: 'Comparer la conversion', player_label: 'Player',
  tab_maps: 'Cartes', tab_database: 'Acteurs', tab_tools: 'Outils', new_map: '✚ Nouvelle carte', search_map: 'Rechercher une carte…',
  db_actors: 'Acteurs de la base', actor_name: "Nom de l'acteur", actor_params_note: 'PV et autres paramètres par niveau : table « classes », champ « params », dans la base complète.',
  actor_profile: 'Profil', apply_actor: "Appliquer à l'Acteur", mode: 'Mode de manipulation', tool_inspect: '👆 Inspecter', tool_paint: '🖌️ Peindre',
  tool_player: '🚩 Joueur', tool_event: '➕ Événement', layer: 'Couche active', layer0: 'Couche 0 (Sol / Terrain)', layer1: 'Couche 1 (Éléments / Bas)', layer2: 'Couche 2 (Détails / Haut)',
  palette: 'Palette de tuiles', custom_tile: 'ID Tuile personnalisé', grid: 'Grille', inspector: "Inspecteur d'Événement",
  no_event: "Sélectionnez un événement sur la carte ou créez-en un avec l'outil ➕ Événement.", event_name: "Nom de l'événement", pos_x: 'Position X', pos_y: 'Position Y',
  trigger: 'Déclencheur (Trigger)', trig0: 'Touche Action (Enter/Espace)', trig1: 'Contact Joueur (Touch)', trig2: 'Contact Événement', trig3: 'Automatique (Autorun)', trig4: 'Processus Parallèle',
  commands: 'Flux de commandes', add_cmd: '➕ Commande', apply_event: "Appliquer à l'Événement", delete_event: "Supprimer l'événement",
  compare_h: 'Comparaison avec la conversion', compare_p: "Les entités marquées « modifié (protégé) » par leur empreinte originHash sont préservées lors d'une nouvelle conversion.",
  manifest_h: 'Manifeste complet', manifest_p: 'Tous les champs convertis sont accessibles ici : pages, choix, images, sons, cartes, base de données et scripts. Le JSON doit respecter le format MWGP.',
  apply: 'Appliquer', close: 'Fermer', assets_h: 'Ressources du jeu',
  assets_p: 'Modifiez les fichiers texte ou remplacez les images et sons. Les éditions sont enregistrées dans le dossier jouable et conservées après reconversion.',
  asset_up: 'Dossier parent', compare_with: 'Comparer avec', ref_fresh: 'La dernière conversion', ref_base: 'La référence avant édition',
  edited_playable: 'Édition jouable', save_text: 'Enregistrer le texte', replace_file: 'Remplacer le fichier',
  loading: 'Chargement…', untitled: 'Jeu sans titre', not_modified: 'Non modifié', modifications: '{count} modification(s)',
  map_header: 'Carte #{id} : {name} ({w}×{h})', ev_suffix: '{count} év.', modified: 'modifié', original: 'Original', modified_protected: 'Modifié (protégé)',
  hint_inspect: "Outil actif : Inspecter. Cliquez sur un événement pour l'éditer.", hint_paint: 'Outil actif : Peindre. Cliquez ou glissez sur la carte avec la tuile sélectionnée (Couche {layer}).',
  hint_player: 'Outil actif : Joueur. Cliquez sur la carte pour définir le point de départ du joueur.', hint_event: 'Outil actif : Ajouter Événement. Cliquez sur une case pour créer un événement.',
  cursor: 'X: {x}, Y: {y} | Tuile: {tile}', tile_grass: 'Herbe', tile_water: 'Eau', tile_dirt: 'Terre/Chemin', tile_stone: 'Pierre/Pavé',
  tile_wall: 'Mur pierre', tile_roof: 'Toit rouge', tile_sand: 'Sable', tile_wood: 'Parquet bois', tile_empty: 'Vide (0)',
  loading_project: 'Chargement du projet…', load_error: 'Erreur de chargement : {message}', no_project: 'Aucun projet MWGP trouvé.', catalog_error: 'Impossible de charger le catalogue : {message}',
  new_project_prompt: 'Nom du projet (créé dans MWGP_versions, éditable sans RPG Maker) :', my_game: 'Mon jeu', create_failed: 'Création impossible : {message}',
  map_name_prompt: 'Nom de la nouvelle carte ?', map_default: 'Carte {count}', width_prompt: 'Largeur (cases) ?', height_prompt: 'Hauteur (cases) ?',
  map_created: 'Carte #{id} créée et protégée', tile_painted: 'Tuile peinte en ({x}, {y}) : {tile}', player_moved: 'Point de départ du joueur déplacé en ({x}, {y})',
  event_created: 'Nouvel événement #{id} créé en ({x}, {y})', event_updated: 'Événement #{id} mis à jour et protégé', event_deleted: 'Événement supprimé (protégé contre la reconversion)',
  new_message: 'Nouveau message créé dans MWGP Studio.', text_to_show: 'Texte à afficher…', actor_updated: 'Acteur #{id} mis à jour et protégé',
  db_full: 'Base complète (toutes tables)', new_row: '✚ Nouvelle ligne', row_name_prompt: 'Nom de la ligne ({table}) ?', new_name: 'Nouveau',
  row_created: '{table} #{id} créé et protégé', row_updated: '{table} #{id} mis à jour et protégé', no_rows: 'Aucune ligne objet.',
  invalid_json: 'JSON invalide : {message}', invalid_cmd_json: 'JSON de commande invalide : {message}', manifest_applied: 'Manifeste appliqué. Sauvegardez pour le tester.',
  manifest_required: 'Manifeste MWGP avec cartes requis', saving: 'Sauvegarde en cours…', saved: '✓ Projet sauvegardé avec succès !', save_error: 'Erreur de sauvegarde : {message}',
  exported: 'Manifeste exporté', version_invalid: 'Version du player invalide : format attendu 1.2.3', version_set: 'Version du player du projet : {version} (sauvegardez pour la publier)',
  compare_done: '{protected} champs protégés · {conflicts} divergences', compare_failed: 'Comparaison impossible',
  cmd_say: '[say] Dialogue texte', cmd_ask: '[ask] Choix', cmd_switch: '[setSwitch] Interrupteur', prompt_label: 'Prompt :', on: 'ON (Actif)', off: 'OFF (Inactif)',
  no_commands: 'Aucune commande dans cette page.', asset_select: 'Sélectionner un dossier ou un fichier…', asset_none: 'Aucune ressource copiée dans ce dossier.',
  asset_absent: 'Ressource absente dans cette version.', asset_download: 'Télécharger ({size} octets)', asset_saved: 'Ressource enregistrée et protégée contre les reconversions.',
  asset_protected_status: 'Édition protégée · {state}\nRéférence : {base}\nÉdition : {edited}\nConversion : {fresh}',
  asset_divergent: 'diffère de la conversion', asset_same: 'identique à la conversion', asset_unprotected: 'Ressource convertie. Une sauvegarde conservera sa référence et protégera votre édition.',
  asset_edited_label: 'Ressource éditée', asset_ref_label: 'Ressource de comparaison',
},
de: {
  catalogue: '◀ Katalog', new_project: '✚ Neues Projekt', play: '▶ Testen (Play MWGP)', save: '💾 Speichern', export: '⬇ Exportieren',
  manifest: 'Vollständiges Manifest', assets: 'Ressourcen', compare: 'Umwandlung vergleichen', player_label: 'Player',
  tab_maps: 'Karten', tab_database: 'Akteure', tab_tools: 'Werkzeuge', new_map: '✚ Neue Karte', search_map: 'Karte suchen…',
  db_actors: 'Akteure der Datenbank', actor_name: 'Name des Akteurs', actor_params_note: 'HP und andere Parameter pro Stufe: Tabelle „classes“, Feld „params“, in der vollständigen Datenbank.',
  actor_profile: 'Profil', apply_actor: 'Auf den Akteur anwenden', mode: 'Bearbeitungsmodus', tool_inspect: '👆 Untersuchen', tool_paint: '🖌️ Malen',
  tool_player: '🚩 Spieler', tool_event: '➕ Ereignis', layer: 'Aktive Ebene', layer0: 'Ebene 0 (Boden / Terrain)', layer1: 'Ebene 1 (Elemente / unten)', layer2: 'Ebene 2 (Details / oben)',
  palette: 'Kachel-Palette', custom_tile: 'Benutzerdefinierte Kachel-ID', grid: 'Raster', inspector: 'Ereignis-Inspektor',
  no_event: 'Wählen Sie ein Ereignis auf der Karte oder erstellen Sie eines mit dem Werkzeug ➕ Ereignis.', event_name: 'Name des Ereignisses', pos_x: 'Position X', pos_y: 'Position Y',
  trigger: 'Auslöser (Trigger)', trig0: 'Aktionstaste (Enter/Leertaste)', trig1: 'Spieler-Berührung (Touch)', trig2: 'Ereignis-Berührung', trig3: 'Automatisch (Autorun)', trig4: 'Paralleler Prozess',
  commands: 'Befehlsfluss', add_cmd: '➕ Befehl', apply_event: 'Auf das Ereignis anwenden', delete_event: 'Ereignis löschen',
  compare_h: 'Vergleich mit der Umwandlung', compare_p: 'Entitäten, die durch ihren originHash-Fingerabdruck als „geändert (geschützt)“ markiert sind, bleiben bei einer neuen Umwandlung erhalten.',
  manifest_h: 'Vollständiges Manifest', manifest_p: 'Alle umgewandelten Felder sind hier zugänglich: Seiten, Auswahl, Bilder, Töne, Karten, Datenbank und Skripte. Das JSON muss dem MWGP-Format folgen.',
  apply: 'Anwenden', close: 'Schließen', assets_h: 'Ressourcen des Spiels',
  assets_p: 'Bearbeiten Sie Textdateien oder ersetzen Sie Bilder und Töne. Änderungen werden im spielbaren Ordner gespeichert und bleiben nach erneuter Umwandlung erhalten.',
  asset_up: 'Übergeordneter Ordner', compare_with: 'Vergleichen mit', ref_fresh: 'Die letzte Umwandlung', ref_base: 'Die Referenz vor der Bearbeitung',
  edited_playable: 'Spielbare Bearbeitung', save_text: 'Text speichern', replace_file: 'Datei ersetzen',
  loading: 'Lädt…', untitled: 'Spiel ohne Titel', not_modified: 'Nicht geändert', modifications: '{count} Änderung(en)',
  map_header: 'Karte #{id}: {name} ({w}×{h})', ev_suffix: '{count} Er.', modified: 'geändert', original: 'Original', modified_protected: 'Geändert (geschützt)',
  hint_inspect: 'Aktives Werkzeug: Untersuchen. Klicken Sie auf ein Ereignis, um es zu bearbeiten.', hint_paint: 'Aktives Werkzeug: Malen. Klicken oder ziehen Sie mit der gewählten Kachel über die Karte (Ebene {layer}).',
  hint_player: 'Aktives Werkzeug: Spieler. Klicken Sie auf die Karte, um den Startpunkt des Spielers zu setzen.', hint_event: 'Aktives Werkzeug: Ereignis hinzufügen. Klicken Sie auf eine Zelle, um ein Ereignis zu erstellen.',
  cursor: 'X: {x}, Y: {y} | Kachel: {tile}', tile_grass: 'Gras', tile_water: 'Wasser', tile_dirt: 'Erde/Weg', tile_stone: 'Stein/Pflaster',
  tile_wall: 'Steinmauer', tile_roof: 'Rotes Dach', tile_sand: 'Sand', tile_wood: 'Holzboden', tile_empty: 'Leer (0)',
  loading_project: 'Projekt wird geladen…', load_error: 'Ladefehler: {message}', no_project: 'Kein MWGP-Projekt gefunden.', catalog_error: 'Katalog konnte nicht geladen werden: {message}',
  new_project_prompt: 'Projektname (wird in MWGP_versions erstellt, ohne RPG Maker bearbeitbar):', my_game: 'Mein Spiel', create_failed: 'Erstellung nicht möglich: {message}',
  map_name_prompt: 'Name der neuen Karte?', map_default: 'Karte {count}', width_prompt: 'Breite (Zellen)?', height_prompt: 'Höhe (Zellen)?',
  map_created: 'Karte #{id} erstellt und geschützt', tile_painted: 'Kachel gemalt bei ({x}, {y}): {tile}', player_moved: 'Startpunkt des Spielers nach ({x}, {y}) verschoben',
  event_created: 'Neues Ereignis #{id} erstellt bei ({x}, {y})', event_updated: 'Ereignis #{id} aktualisiert und geschützt', event_deleted: 'Ereignis gelöscht (gegen erneute Umwandlung geschützt)',
  new_message: 'Neue Nachricht, in MWGP Studio erstellt.', text_to_show: 'Anzuzeigender Text…', actor_updated: 'Akteur #{id} aktualisiert und geschützt',
  db_full: 'Vollständige Datenbank (alle Tabellen)', new_row: '✚ Neue Zeile', row_name_prompt: 'Name der Zeile ({table})?', new_name: 'Neu',
  row_created: '{table} #{id} erstellt und geschützt', row_updated: '{table} #{id} aktualisiert und geschützt', no_rows: 'Keine Objektzeilen.',
  invalid_json: 'Ungültiges JSON: {message}', invalid_cmd_json: 'Ungültiges Befehls-JSON: {message}', manifest_applied: 'Manifest angewendet. Speichern, um es zu testen.',
  manifest_required: 'MWGP-Manifest mit Karten erforderlich', saving: 'Wird gespeichert…', saved: '✓ Projekt erfolgreich gespeichert!', save_error: 'Speicherfehler: {message}',
  exported: 'Manifest exportiert', version_invalid: 'Ungültige Player-Version: Format 1.2.3 erwartet', version_set: 'Player-Version des Projekts: {version} (speichern, um sie zu veröffentlichen)',
  compare_done: '{protected} geschützte Felder · {conflicts} Abweichungen', compare_failed: 'Vergleich nicht möglich',
  cmd_say: '[say] Textdialog', cmd_ask: '[ask] Auswahl', cmd_switch: '[setSwitch] Schalter', prompt_label: 'Prompt:', on: 'ON (Aktiv)', off: 'OFF (Inaktiv)',
  no_commands: 'Kein Befehl auf dieser Seite.', asset_select: 'Ordner oder Datei auswählen…', asset_none: 'Keine Ressource in diesen Ordner kopiert.',
  asset_absent: 'Ressource in dieser Version nicht vorhanden.', asset_download: 'Herunterladen ({size} Bytes)', asset_saved: 'Ressource gespeichert und gegen erneute Umwandlung geschützt.',
  asset_protected_status: 'Geschützte Bearbeitung · {state}\nReferenz: {base}\nBearbeitung: {edited}\nUmwandlung: {fresh}',
  asset_divergent: 'weicht von der Umwandlung ab', asset_same: 'identisch mit der Umwandlung', asset_unprotected: 'Umgewandelte Ressource. Speichern behält ihre Referenz und schützt Ihre Bearbeitung.',
  asset_edited_label: 'Bearbeitete Ressource', asset_ref_label: 'Vergleichsressource',
},
};
Object.assign(T.en, { event_default_name: 'Event {id}', actor_fallback: 'Actor', apply_row: 'Apply the row', load_failed: 'Error {status} while loading', worker_error: 'Error' });
Object.assign(T.fr, { event_default_name: 'Événement {id}', actor_fallback: 'Acteur', apply_row: 'Appliquer la ligne', load_failed: 'Erreur {status} lors du chargement', worker_error: 'Erreur' });
Object.assign(T.de, { event_default_name: 'Ereignis {id}', actor_fallback: 'Akteur', apply_row: 'Zeile anwenden', load_failed: 'Fehler {status} beim Laden', worker_error: 'Fehler' });
Object.assign(T.en, {
  page_title: 'MWGP Studio — universal editor', asset_fresh_absent: 'absent', sa_title: 'Standalone MWGP Studio',
  sa_intro: 'Open a self-contained game page (.html) to edit it with the full graphical editor, offline. “Save” keeps your edits here; then download the regenerated game page to keep them.',
  sa_open_choose: 'Open a game page…', sa_open_folder: 'Open an unpacked game folder…', sa_open_new: 'New blank project', sa_use_new: 'Use “New blank project” on the standalone opening screen.',
  sa_new_prompt: 'Name of the new project:', sa_new_fallback: 'New project', sa_download_page: '⬇ Game page (.html)',
  sa_download_title: 'Download the self-contained game page with your edits', sa_no_gzip: 'This browser does not support gzip decompression.',
  sa_not_standalone: 'This file is not a self-contained MWGP game page.', sa_truncated: 'The game content is truncated.', sa_too_large: 'This page is too large to open here. Use the standalone player to play it.',
  sa_bad_index: 'Invalid game index.', sa_unknown_format: 'Unknown game format.', sa_bad_entry: 'Invalid game entry.',
  sa_trailing: 'Unexpected content after the game.', sa_no_manifest: 'The game page contains no MWGP manifest.',
});
Object.assign(T.fr, {
  page_title: 'MWGP Studio — Éditeur universel', asset_fresh_absent: 'absente', sa_title: 'MWGP Studio autonome',
  sa_intro: 'Ouvrez une page de jeu autoporteuse (.html) pour l’éditer avec l’éditeur graphique complet, hors connexion. « Sauvegarder » protège vos éditions ici ; téléchargez ensuite la page de jeu régénérée pour les conserver.',
  sa_open_choose: 'Ouvrir une page de jeu…', sa_open_folder: 'Ouvrir un dossier de jeu décompressé…', sa_open_new: 'Nouveau projet vierge', sa_use_new: 'Utilisez « Nouveau projet vierge » de l’écran d’ouverture autonome.',
  sa_new_prompt: 'Nom du nouveau projet :', sa_new_fallback: 'Nouveau projet', sa_download_page: '⬇ Page de jeu (.html)',
  sa_download_title: 'Télécharger la page de jeu autoporteuse avec vos éditions', sa_no_gzip: 'Ce navigateur ne prend pas en charge la décompression gzip.',
  sa_not_standalone: 'Ce fichier n’est pas une page de jeu MWGP autoporteuse.', sa_truncated: 'Le contenu du jeu est tronqué.', sa_too_large: 'Cette page est trop volumineuse pour être ouverte ici. Utilisez le lecteur autonome pour y jouer.',
  sa_bad_index: 'Index de jeu invalide.', sa_unknown_format: 'Format de jeu inconnu.', sa_bad_entry: 'Entrée de jeu invalide.',
  sa_trailing: 'Contenu inattendu après le jeu.', sa_no_manifest: 'La page de jeu ne contient pas de manifeste MWGP.',
});
Object.assign(T.de, {
  page_title: 'MWGP Studio — universeller Editor', asset_fresh_absent: 'fehlt', sa_title: 'Eigenständiges MWGP Studio',
  sa_intro: 'Öffnen Sie eine eigenständige Spielseite (.html), um sie mit dem vollständigen grafischen Editor offline zu bearbeiten. „Speichern“ sichert Ihre Änderungen hier; laden Sie danach die neu erzeugte Spielseite herunter, um sie zu behalten.',
  sa_open_choose: 'Spielseite öffnen…', sa_open_folder: 'Entpackten Spielordner öffnen…', sa_open_new: 'Neues leeres Projekt', sa_use_new: 'Verwenden Sie „Neues leeres Projekt“ auf dem Startbildschirm des eigenständigen Studios.',
  sa_new_prompt: 'Name des neuen Projekts:', sa_new_fallback: 'Neues Projekt', sa_download_page: '⬇ Spielseite (.html)',
  sa_download_title: 'Eigenständige Spielseite mit Ihren Änderungen herunterladen', sa_no_gzip: 'Dieser Browser unterstützt keine gzip-Dekompression.',
  sa_not_standalone: 'Diese Datei ist keine eigenständige MWGP-Spielseite.', sa_truncated: 'Der Spielinhalt ist abgeschnitten.', sa_too_large: 'Diese Seite ist zu groß, um sie hier zu öffnen. Nutzen Sie den eigenständigen Player zum Spielen.',
  sa_bad_index: 'Ungültiger Spielindex.', sa_unknown_format: 'Unbekanntes Spielformat.', sa_bad_entry: 'Ungültiger Spieleintrag.',
  sa_trailing: 'Unerwarteter Inhalt nach dem Spiel.', sa_no_manifest: 'Die Spielseite enthält kein MWGP-Manifest.',
});
Object.assign(T.en, { support: '♥ Support the project' });
Object.assign(T.fr, { support: '♥ Participer au projet' });
Object.assign(T.de, { support: '♥ Projekt unterstützen' });
export function t(key, values = {}) {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), T[lang][key] || T.en[key] || key);
}
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  document.title = t('page_title');
  root.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  const search = root.querySelector('#map-search'); if (search) search.placeholder = t('search_map');
  const select = root.querySelector('#lang'); if (select) select.value = lang;
}
export function setupLangSelect(onChange) {
  applyI18n();
  const select = document.querySelector('#lang');
  if (!select) return;
  select.value = lang;
  select.onchange = () => {
    lang = select.value;
    try { localStorage.setItem(KEY, lang); } catch { /* private window */ }
    applyI18n();
    onChange?.();
  };
}
