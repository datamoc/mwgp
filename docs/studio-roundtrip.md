# Conversion, Studio et lecture

Le Studio web (`/studio.html?id=…`) sauvegarde un manifeste jouable par le lecteur
MWGP. Le bouton « Tester » sauvegarde avant d’ouvrir le lecteur. Le bouton
« Manifeste complet » donne accès aux champs qui n’ont pas encore de formulaire :
toutes les pages et branches, paramètres des commandes, métadonnées, tables de
base de données et scripts intégrés. Le bouton « Ressources » permet aussi
d’éditer les fichiers texte externes et de remplacer les fichiers binaires
présents dans le dossier converti `assets/`.

Les sauvegardes passent par le validateur MWGP avant de remplacer `mwgp.json`.
Les commandes conservent leur format d’exécution : par exemple
`{ "setSwitch": "self:1:1:A", "value": true }`. Modifier le texte d’un dialogue
conserve son portrait et les autres paramètres.

## Reconversion après une sauvegarde dans le Studio web

Les convertisseurs MV/MZ et RGSS publient désormais via
`src/studio-manifest.js`. La première sauvegarde Studio conserve une base de
comparaison. Chaque reconversion compare la base, le manifeste édité et la
nouvelle sortie convertie :

- Les champs sans édition suivent la nouvelle conversion.
- Les champs édités et les suppressions sont conservés.
- Les cartes et événements sont rapprochés par identifiant. Les tables de base
  de données gardent leurs indices et emplacements `null`.
- Les autres tableaux, notamment les pages et listes de commandes, sont
  protégés ensemble lorsqu’ils ont été édités.
- Un champ identifié comme édité reste protégé même si une conversion produit
  temporairement la même valeur.

Ces fichiers accompagnent le manifeste dans son dossier de sortie :

| Fichier | Usage |
| --- | --- |
| `.mwgp-studio.json` | Base de comparaison et chemins protégés |
| `.mwgp-conversion.json` | Dernière sortie du convertisseur, avant fusion |
| `.mwgp-merge-report.json` | Champs conservés et valeurs divergentes |

Le bouton « Comparer la conversion » affiche la comparaison réelle avec les
valeurs éditées et converties, ainsi que le rapport de la dernière fusion.
Les métadonnées Studio ne sont pas injectées dans le manifeste jouable.
Le chargement de l’éditeur passe par `GET /api/studio/:id`, qui renvoie le
manifeste et les chemins protégés enregistrés. Les badges restent donc visibles
après rechargement, même lorsque la source convertie rejoint temporairement la
valeur éditée.
Une construction web vers ce même dossier est refusée pour conserver les
éditions : utiliser un autre dossier, ou `--mwgp` pour reconvertir le manifeste.

## Publication depuis le Studio CLI

`lift` conserve le manifeste de référence dans `.mwgp-base.json` dans le dossier
Studio. Quand `publish` réécrit le `mwgp.json` du projet d’origine, il rapproche
les éditions CLI du fichier actuellement joué avant de sauvegarder. Un dossier
CLI ouvert avant une édition web ou une reconversion ne rétablit donc pas les
anciens champs restés intacts dans ce dossier. Les différences CLI passent par
la même validation et la même protection que les sauvegardes web. Les
divergences de publication sont conservées dans `publish-report.json`.
Les dossiers créés par `lift` utilisent aussi cette fusion à trois versions
pour la commande `merge` : suppressions conservées, indices de base de données
stables, chemins édités toujours protégés. `merge-comparison.json` conserve les
valeurs comparées et `conflicts/` les divergences individuelles. Les anciens
dossiers dépourvus de `.mwgp-base.json` utilisent encore la fusion historique
par empreinte d’entité.

## Vérification et limites

### Ressources externes

Le navigateur de ressources parcourt un dossier à la fois. Il propose deux
vues : l’édition jouable et, au choix, la référence avant édition ou la dernière
conversion. Les images et fichiers audio/vidéo disposent d’un aperçu ; les
fichiers texte peuvent être édités, dont les JavaScript des plugins et les JSON
des données Ruby. Le remplacement d’un fichier est limité à 64 Mio, et
l’édition dans une zone de texte à 2 Mio. Les JSON et JavaScript sont contrôlés
syntaxiquement avant sauvegarde ; cela ne vérifie pas la logique du programme.

Les versions sont indexées dans `.mwgp-studio-assets.json`, avec leurs contenus
dans `.mwgp-studio-assets/blobs/`. La version éditée reste également publiée
dans `assets/` : copier le dossier jouable conserve donc les modifications,
sans dépendre du serveur Studio. Les projets RPG Maker d’origine sont laissés
intacts.

Les deux convertisseurs produisent leurs ressources dans un dossier temporaire
dans la destination. À la publication, ils conservent les éditions et
enregistrent la sortie brute pour comparaison. Une ressource supprimée de la
source est signalée absente dans la vue conversion, et sa version éditée est
conservée. Cette préparation demande temporairement l’espace disque d’une
nouvelle copie des ressources converties.

`assets.revision` distingue les versions éditées pour le cache audio persistant.
Les sauvegardes et publications des ressources sont sérialisées par dossier.
Les opérations HTTP de modification acceptent uniquement les requêtes du site
local, ainsi que les clients hors navigateur sans en-têtes d’origine.

`node tools/test-studio-reconversion.mjs` crée un projet MV synthétique, le
convertit, sauvegarde via HTTP, reconvertit trois fois et vérifie la conservation
des éditions, des suppressions et des indices de base de données. Il contrôle
aussi la comparaison, le refus d’une sauvegarde invalide et la protection contre
le remplacement par une construction web. Un dossier CLI créé avant les
éditions web publie ensuite un profil d’acteur : le test vérifie que cette
publication conserve les éditions web et les mises à jour converties, et que
le profil reste protégé lors de la conversion suivante.

Avec `MWGP_STUDIO_BROWSER=1`, le même test pilote Chromium pour éditer le
manifeste complet, un dialogue avec portrait, un interrupteur local et une
commande JSON, puis sauvegarder, comparer et recharger le Studio.
Il ouvre ensuite le lecteur réel, déclenche l’événement au clavier et vérifie
le dialogue présenté puis l’exécution de l’interrupteur édité. Les captures du
Studio et du dialogue sont conservées avec les fixtures temporaires du test.
Le même parcours édite un JavaScript externe, remplace une image, reconvertit,
puis vérifie l’effet du JavaScript et la couleur des pixels de l’image rendue
par le lecteur. Les trois versions des ressources, leur convergence temporaire
et la suppression d’une ressource dans la source sont également testées.

Cela ne prouve pas encore que chaque champ de chaque jeu est éditable avec un
formulaire adapté, ni que toutes les éditions sont rendues fidèlement par le
lecteur. La recompilation des scripts Ruby édités, les anciens
dossiers CLI sans manifeste de référence et la concurrence entre plusieurs
sauvegardes/conversions nécessitent encore une vérification commune. L’objectif
global convertisseur–éditeur–lecteur reste ouvert.
