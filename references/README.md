# Références RPG Maker et EasyRPG

Téléchargées le 31 octobre 2026 pour consultation locale. Les documents restent la propriété de leurs auteurs ; vérifier leurs conditions avant toute redistribution. Les copies HTML sont des captures par liens : elles ne garantissent pas que toutes les ressources chargées dynamiquement soient disponibles hors ligne. Les fichiers `download-errors.txt` consignent les liens qui n'ont pas pu être récupérés.

- **2000 et 2003** — [Manuel français par Udun](2000-2003/manuel-2003-udun-fr.pdf), manuel communautaire ancien consacré à 2003 et également utile pour 2000. Les captures correspondent à la version 2003 1.09 traduite ; attention aux différences avec les éditions officielles récentes. [Source](https://www.rpg-maker.fr/divers/manuel_rm_2003_par_udun.pdf) ; [présentation](https://www.rpg-maker.fr/programmes-type-rpgmaker-rtp.html).
- **XP** — [Aide anglaise et référence RGSS](xp/helpcontents.html), copie du [miroir RPG-Maker.fr](https://www.rpg-maker.fr/dl/monos/aide/xp/helpcontents.html). Quelques liens du site source étaient indisponibles, voir `xp/download-errors.txt`.
- **VX** — [Aide anglaise et référence RGSS2](vx/helpcontents.html), copie du [miroir RPG-Maker.fr](https://www.rpg-maker.fr/dl/monos/aide/vx/helpcontents.html). Quelques liens du site source étaient indisponibles, voir `vx/download-errors.txt`.
- **VX Ace** — [Aide et référence RGSS3 en anglais](xp-vx-vxace/vx-ace-manuel-en.html), texte de la [page miroir PDFCoffee](https://pdfcoffee.com/rpg-maker-vx-ace-help-rgss3-reference-manual-4-pdf-free.html) ; le téléchargement proposé ne fournissait pas de PDF. [Tutoriel officiel 1](xp-vx-vxace/vx-ace-tutorial-1-en.pdf), source [Komodo](https://dl.komodo.jp/rpgmakerweb/tutorials/RPGMakerVXAceTutorial1.pdf).
- **XP, VX et VX Ace** — [Documentation des scripts standard](xp-vx-vxace/scripts-standard-documentation.zip), archive du [projet RPGMakerDefaultScripts](https://github.com/orzFly/RPGMakerDefaultScripts/tree/gh-pages) ; documentation générée, distincte des manuels RGSS. Dans l'archive : `docs/rpgmaker-xp.en/index.html`, `docs/rpgmaker-vx.en/index.html` et `docs/rpgmaker-vxace.en/index.html`.
- **MV** — [Aide officielle anglaise](mv/index.html), copie du [site officiel](https://rpgmakerofficial.com/product/MV_Help/). Les deux erreurs recensées correspondent à des liens non valides dans les pages source.
- **MZ** — [Aide officielle anglaise](mz/index.html), copie du [site officiel](https://rpgmakerofficial.com/product/MZ_help-en/). L'interface utilise JavaScript ; certaines pages ou ressources dynamiques peuvent nécessiter le site en ligne. Voir `mz/download-errors.txt`.
- **EasyRPG** — [Wiki source extrait](easyrpg/wiki-master/pages/), comprenant notamment [structures LCF](easyrpg/wiki-master/pages/development/data-structure-reference.txt) et détails techniques. Archive de [EasyRPG/wiki](https://github.com/EasyRPG/wiki), ainsi que sa [version en ligne](https://wiki.easyrpg.org/). Le wiki indique une licence CC BY-SA 4.0 sauf mention contraire ; voir ses indications de licence. La version de l'archive peut différer du wiki courant.
- **EasyRPG local** — [README Player](easyrpg/player-readme.md), [construction Player](easyrpg/player-building.md) et [README Editor](easyrpg/editor-readme.adoc), copiés des dépôts locaux `C:/Users/miche/dev/EasyRPG/Player` et `Editor` aux révisions respectives `497a87ba8` et `4a83bb0`. Leurs sources complètes restent dans ces dépôts ; leurs propres licences s'appliquent.

- **Forum RPG Maker (versions MV)** — [pages citées par les plugins](forums-rpgmaker/) : fils 66712 (MV 1.3.1), 71400 (MV 1.3.4) et 79677 (MV 1.5.0), téléchargés le 31 octobre 2026, avec la page d'accueil du forum (copies locales, non versionnées). Synthèse et décision dans [docs/mv-engine-versions.md](../docs/mv-engine-versions.md).

Les PDF des manuels complets XP, VX et VX Ace n'ont pas été obtenus lors de cette collecte : les copies HTML ci-dessus sont indiquées comme telles. Les PDF MV et MZ repérés dans les résultats de recherche renvoyaient 404 lors du téléchargement ; les aides officielles HTML ont été conservées à la place.

## Base de compatibilité SQLite

[compatibilite.sqlite](compatibilite.sqlite) est un instantané initial pour la conversion MWGP et le player principal. Elle distingue les commandes d'événement, les étapes de mouvement LCF, les commandes du manifeste MWGP et 23 domaines fonctionnels par moteur. La vue `coverage` réunit les noms, les codes et les trois évaluations : `converter_status`, `player_status` et `pipeline_status`. Les tables `items`, `assessments`, `engines` et `sources` conservent le détail et les empreintes SHA-256 des sources utilisées.

Les statuts sont `supported`, `partial`, `unsupported`, `unknown` et `not_applicable`. `unknown` signifie que l'évaluation distincte reste à faire. Le statut `pipeline` reprend une classification globale du projet : il ne prouve pas séparément la qualité de la conversion et du player. Une ligne « supported » reste une affirmation de la source, pas une preuve de lecture fidèle dans tous les jeux. Les champs `detail`, `applicability` et `engines.caveat` précisent les limites et hypothèses ; notamment, la liste XP est incomplète, l'inventaire LCF regroupe les deux versions et des extensions, et Ace réutilise la table VX dans le convertisseur. Les domaines fonctionnels sont des rubriques à détailler, pas un inventaire exhaustif de leurs sous-fonctions. Les itinéraires de mouvement hors LCF et les paramètres des commandes restent à inventorier.

Exemples de requêtes :

```sql
SELECT engine, code, name, converter_status, player_status, pipeline_status
FROM coverage WHERE kind = 'event_command' AND engine = 'RPG Maker MV'
ORDER BY CAST(code AS INTEGER);

SELECT engine, kind, code, name, converter_status, player_status, pipeline_status
FROM coverage
WHERE converter_status IN ('partial', 'unsupported', 'unknown')
   OR player_status IN ('partial', 'unsupported', 'unknown');

SELECT i.engine_id, i.code, a.component, a.status, a.detail, s.path, a.assessed_at
FROM items i JOIN assessments a ON a.item_id = i.id
LEFT JOIN sources s ON s.id = a.source_id
WHERE i.kind = 'event_command' AND i.engine_id = 'mv' AND i.code = '111';
```

Pour actualiser un constat, modifier `assessments` en précisant le composant, le détail, la source et la date ; conserver `unknown` tant que l'étape n'a pas été examinée. Les empreintes de `sources` permettent de repérer les documents ou fichiers de code modifiés depuis leur examen. Le script [build_compatibility_db.py](build_compatibility_db.py) documente l'import initial et refuse d'écraser une base existante : préserver les évaluations manuelles lors des mises à jour. Les rapports `compatibility` dans les manifestes restent propres à chaque jeu et peuvent différer de cet inventaire général.

### Révision du 31 octobre 2026

La base a été enrichie par examen des branches des convertisseurs, du dispatch du player et de l'architecture. `command_mappings` relie 478 formes courantes de commandes source aux commandes MWGP qu'elles peuvent produire. Cette relation ne décrit pas toutes les variantes. `assessment_history` conserve les évaluations remplacées et la raison du changement.

Les nouvelles évaluations `partial` sont **prudentes** : elles attestent un chemin d'implémentation ou une couverture partielle, mais n'affirment pas qu'une lacune précise a été identifiée pour chaque commande. Les marqueurs structurels absorbés à la conversion sont `not_applicable` pour le player. Les domaines fonctionnels sont évalués à un niveau général, sans remplacer une vérification de leurs sous-fonctions ni un test de jeu. Les 408 statuts convertisseur et 289 statuts player encore `unknown` restent à examiner ; une partie concerne le vocabulaire MWGP, les commandes non reconnues, l'applicabilité aux éditions ou les extensions.

[update_compatibility_db.py](update_compatibility_db.py) consigne les règles de cette révision. Il est reproductible sur l'instantané actuel, mais ses corrections explicites des branches LCF peuvent remplacer des évaluations ultérieures : relire et adapter le script avant toute réexécution après édition manuelle. La base ne se met pas automatiquement à jour lorsque le code change.

```sql
-- Voir les formes courantes et leurs correspondances MWGP.
SELECT e.name, i.code, i.name, m.code AS commande_mwgp, cm.detail
FROM command_mappings cm
JOIN items i ON i.id = cm.item_id
JOIN engines e ON e.id = i.engine_id
JOIN items m ON m.id = cm.mwgp_item_id
WHERE e.id = 'mv' ORDER BY CAST(i.code AS INTEGER);

-- Voir les évaluations antérieures conservées.
SELECT i.engine_id, i.code, h.component, h.old_status, h.old_detail, h.reason
FROM assessment_history h JOIN items i ON i.id = h.item_id
ORDER BY h.id DESC LIMIT 20;
```
