"""Add the runtime-behaviour inventory (kind 'feature', code 'rt:<id>') to compatibilite.sqlite.

Each row is one behaviour that the reference engines' own players run (MV/MZ Game_*/Scene_* classes,
RGSS Game_* classes, EasyRPG Player's game_*.cpp), with what the converters carry and what the MWGP
player does. Statuses come from reading those players and grepping this repo's player; the script is
re-runnable (INSERT OR REPLACE on assessments, items keyed by engine/kind/code) and never touches rows
outside the 'rt:' namespace. Usage: python references/add_runtime_inventory.py [path-to-db]
"""
import hashlib
import os
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compatibilite.sqlite')
TODAY = '2026-10-31'
ALL = ['mv', 'mz', 'xp', 'vx', 'ace', '2000', '2003']
RGSS = ['xp', 'vx', 'ace']
LCF = ['2000', '2003']
MVMZ = ['mv', 'mz']

# (code, name, engines, (converter status, detail), (player status, detail), where the reference engine runs it)
ROWS = [
    ('rt:event-move-type', 'Autonomous event movement: fixed, random, approach, custom route', MVMZ,
     ('supported', "page.movement {type, route} (tools/convert-mv.js convertMovement)."),
     ('partial', "updateSelfMovement : aléatoire et approche selon Game_Event.updateSelfMovement (event-movement.js, testé), route personnalisée en route de fond ; les événements sautent de case en case. Aléatoire vérifié dans Chromium ; approche et route personnalisée non vérifiées en jeu."),
     'Game_Event.updateSelfMovement (rpg_objects.js)'),
    ('rt:event-move-type', 'Autonomous event movement: fixed, random, approach, custom route', RGSS,
     ('partial', "page.movement depuis move_type / move_route (tools/convert-rgss.js convertMovement) ; non couvert par un projet de test RGSS."),
     ('partial', "Même mécanique que MV/MZ (updateSelfMovement) ; non vérifiée sur un jeu RGSS."),
     'Game_Event#update (Game_Character, RGSS)'),
    ('rt:event-move-type', 'Autonomous event movement: fixed, random, approach, custom route', LCF,
     ('unsupported', "Les blocs de type, vitesse et fréquence de la page LCF ne sont pas lus par convert-lcf.mjs."),
     ('partial', "Le player sait exécuter page.movement, mais le convertisseur LCF n'en émet pas."),
     'game_event.cpp'),
    ('rt:event-move-speed', 'Event movement speed (1-6)', MVMZ + RGSS,
     ('supported', "page.movement.speed."),
     ('partial', "La vitesse règle l'intervalle entre deux pas (256/2^v images par case) ; le déplacement visuel reste un saut de case."),
     'Game_CharacterBase.realMoveSpeed / distancePerFrame'),
    ('rt:event-move-speed', 'Event movement speed (1-6)', LCF,
     ('unsupported', "Blocs de la page LCF non lus (les étapes de route 28-31 sont converties)."),
     ('partial', "Honorée via routeOption speed pour le joueur seulement."),
     'Game_CharacterBase.realMoveSpeed / distancePerFrame'),
    ('rt:event-move-frequency', 'Event movement frequency (1-5)', MVMZ + ['ace'],
     ('supported', "page.movement.frequency."),
     ('supported', "stopFrames = 30 * (5 - fréquence), comme Game_Event.stopCountThreshold (event-movement.js, testé)."),
     'Game_Event.stopCountThreshold = 30 * (5 - moveFrequency)'),
    ('rt:event-move-frequency', 'Event movement frequency (1-5)', ['xp', 'vx'],
     ('partial', "Six niveaux XP/VX ramenés à cinq (niveau - 1) ; l'attente d'origine est (40 - 2f)(6 - f) images, approchée."),
     ('supported', "stopFrames comme MV."),
     'Game_Character#update (RGSS)'),
    ('rt:event-move-frequency', 'Event movement frequency (1-5)', LCF,
     ('unsupported', "Blocs de la page LCF non lus."),
     ('unsupported', "Pas de déplacement spontané pour ce moteur."),
     'game_event.cpp'),
    ('rt:event-walk-step-anime', 'Walking and stepping-in-place animation flags', MVMZ + RGSS,
     ('partial', "page.movement.walkAnime / stepAnime sont stockés."),
     ('unsupported', "Le player ne lit pas ces drapeaux pour animer les événements."),
     'Game_CharacterBase.hasWalkAnime / hasStepAnime / updateAnimation'),
    ('rt:event-walk-step-anime', 'Walking and stepping-in-place animation flags', LCF,
     ('unsupported', "Type d'animation de la page LCF non lu."),
     ('unsupported', "Le player ne lit pas ces drapeaux pour animer les événements."),
     'game_character.cpp (animation_type)'),
    ('rt:event-direction-fix', 'Direction fix flag on the event page', MVMZ + RGSS,
     ('supported', "page.movement.directionFix."),
     ('supported', "Le déplacement spontané ne tourne pas l'événement quand il est posé ; routeOption l'honore aussi."),
     'Game_CharacterBase.setDirectionFix'),
    ('rt:event-direction-fix', 'Direction fix flag on the event page', LCF,
     ('unsupported', "Drapeau de page LCF non lu ; seule la route le fixe (26/27)."),
     ('partial', "routeOption directionFix est honoré une fois posé par une route."),
     'Game_CharacterBase.setDirectionFix'),
    ('rt:event-touch-trigger', 'Event Touch trigger (event walks into the player)', MVMZ + RGSS,
     ('partial', "Les déclencheurs « Player Touch » et « Event Touch » sont fusionnés en « touch »."),
     ('partial', "Seul le joueur qui entre sur la case déclenche ; un événement qui marche sur le joueur ne déclenche rien."),
     'Game_Event.checkEventTriggerTouch / triggerTouchAction'),
    ('rt:event-turn-to-player', 'Event turns toward the player when started by Action', ALL,
     ('not_applicable', "Comportement d'exécution, aucune donnée à convertir."),
     ('unknown', "Non retrouvé dans player-core.js ; à vérifier en jeu."),
     'Game_Event.lock / Game_Player.checkEventTriggerThere'),
    ('rt:damage-floor', 'Damage floor tiles (HP loss when walking, screen flash)', MVMZ,
     ('supported', "Les indicateurs de tuile bruts (bit 0x100) sont dans le manifeste."),
     ('supported', "applyFloorDamage : 10 PV par pas et par membre au combat (1 PV minimum sauf option « mort au sol »), flash rouge. Vérifié dans Chromium (projet de test)."),
     'Game_Player.isOnDamageFloor / Game_Actor.executeFloorDamage'),
    ('rt:damage-floor', 'Damage floor tiles (HP loss when walking, screen flash)', ['vx', 'ace'],
     ('partial', "Indicateurs de tuile repris ; bit de dégâts non vérifié sur un jeu VX/Ace."),
     ('partial', "Même code que MV/MZ ; non vérifié sur un jeu VX/Ace."),
     'Game_Player#check_floor_effect (RGSS)'),
    ('rt:damage-floor', 'Damage floor tiles (HP loss when walking, screen flash)', LCF,
     ('unsupported', "Le terrain de dégâts LCF n'est pas converti (terrainTags vide)."),
     ('partial', "Le player applique les dégâts si le bit est présent ; le convertisseur n'en pose pas."),
     'game_player.cpp (terrain damage)'),
    ('rt:ladder-tiles', 'Ladder tiles (move up/down, no facing change)', MVMZ,
     ('supported', "Les indicateurs de tuile bruts sont dans le manifeste."),
     ('unsupported', "Le flag échelle n'est pas lu."),
     'Game_Map.isLadder / Game_CharacterBase.isOnLadder'),
    ('rt:bush-depth', 'Bush tiles (lower half of the character hidden)', MVMZ + RGSS,
     ('supported', "Les indicateurs de tuile bruts sont dans le manifeste."),
     ('partial', "Le buisson ne sert qu'au calcul des rencontres ; le bas du sprite n'est pas masqué."),
     'Game_CharacterBase.refreshBushDepth / bushDepth'),
    ('rt:counter-tiles', 'Counter tiles (talk to an event across a counter)', MVMZ,
     ('supported', "Les indicateurs de tuile bruts (bit 0x80) sont dans le manifeste."),
     ('supported', "triggerAction : l'événement derrière un comptoir est atteint. Vérifié dans Chromium (projet de test)."),
     'Game_Player.checkEventTriggerThere (isCounter)'),
    ('rt:counter-tiles', 'Counter tiles (talk to an event across a counter)', RGSS + LCF,
     ('partial', "Le bit de comptoir n'est pas vérifié dans les indicateurs convertis de ce moteur."),
     ('partial', "Même code que MV/MZ ; non vérifié sur un jeu de ce moteur."),
     'Game_Player#check_event_trigger_there (RGSS); game_player.cpp'),
    ('rt:map-loop', 'Looping maps (scroll type: horizontal / vertical wrap)', ALL,
     ('partial', "MV/MZ : scrollType brut dans data ; autres moteurs non repris."),
     ('unsupported', "Le player ne boucle ni l'affichage ni les déplacements."),
     'Game_Map.isLoopHorizontal / roundX'),
    ('rt:vehicle-passability', 'Boat, ship and airship passability and landing rules', ALL,
     ('supported', "Les véhicules de départ et leurs cartes sont repris (vehicleLocation)."),
     ('partial', "Le véhicule monté ignore la passabilité (routeThrough) ; les règles d'eau et d'atterrissage ne sont pas appliquées."),
     'Game_Map.isBoatPassable / isShipPassable / isAirshipLandOk'),
    ('rt:airship-flight', 'Airship take-off, altitude and landing animation', MVMZ + RGSS + LCF,
     ('unsupported', "Aucune donnée d'altitude."),
     ('unsupported', "L'aéronef se comporte comme un véhicule au sol."),
     'Game_Vehicle.updateAirship / updateAirshipAltitude'),
    ('rt:vehicle-bgm', 'Vehicle background music on board', ALL,
     ('partial', "La musique de véhicule est stockée dans systemFlag."),
     ('partial', "Stockée ; non jouée à l'embarquement."),
     'Game_Vehicle.playBgm / getOn'),
    ('rt:screen-zoom', 'Screen zoom (Game_Screen.startZoom)', MVMZ,
     ('not_applicable', "Aucune commande d'événement ; utilisé par les plugins."),
     ('unsupported', "Pas de zoom d'écran."),
     'Game_Screen.startZoom / updateZoom'),
    ('rt:picture-blend-mode', 'Picture blend mode (normal / additive / multiply / screen)', MVMZ + RGSS,
     ('unsupported', "Le mode de fusion de Show Picture n'est pas repris."),
     ('unsupported', "Les images sont toujours en mode normal."),
     'Game_Picture.blendMode'),
    ('rt:autosave', 'Autosave on map transfer / game events (MZ)', ['mz'],
     ('not_applicable', "Comportement d'exécution."),
     ('unsupported', "Aucun enregistrement automatique ; sauvegarde manuelle seulement."),
     'Scene_Map autosave (rmmz_scenes.js)'),
    ('rt:new-game-start', 'New game start: initial party, position, vehicles, start events', ALL,
     ('supported', "Groupe, carte et position de départ convertis."),
     ('supported', "Nouvelle partie construite à partir du manifeste (title / continue / restart)."),
     'DataManager.setupNewGame'),
    ('rt:dash', 'Dash (Shift, always-dash option)', ALL,
     ('not_applicable', "Règle d'exécution."),
     ('supported', "Vitesse doublée, option Always Dash (map-rules.js)."),
     'Game_Player.updateDashing'),
    ('rt:followers', 'Followers behind the leader', MVMZ + ['vx', 'ace', '2003'],
     ('not_applicable', "Règle d'exécution."),
     ('supported', "buildFollowers / moveFollowers, commandes de rassemblement."),
     'Game_Followers'),
    ('rt:random-encounters', 'Random encounters with first strike / surprise', ALL,
     ('supported', "Listes de rencontres reprises (MV/MZ, XP) ; autres moteurs selon la base."),
     ('supported', "maybeStartEncounter, rollFirstStrike (map-rules.js)."),
     'Game_Player.updateEncounterCount / BattleManager.onEncounter'),
    ('rt:click-to-move', 'Mouse / touch destination movement and click on events', MVMZ + RGSS,
     ('not_applicable', "Règle d'exécution."),
     ('supported', "routeToCell, finishPointerAction."),
     'Game_Temp.setDestination / Game_Player.moveByInput'),
]

con = sqlite3.connect(DB)
cur = con.cursor()


def source_id(path, description):
    full = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), path)
    if not os.path.exists(full):
        return None
    sha = hashlib.sha256(open(full, 'rb').read()).hexdigest()
    row = cur.execute('select id from sources where path=?', (path,)).fetchone()
    if row:
        cur.execute('update sources set sha256=? where id=?', (sha, row[0]))
        return row[0]
    cur.execute('insert into sources(path,sha256,description) values(?,?,?)', (path, sha, description))
    return cur.lastrowid


player_src = source_id('src/player/player-core.js', 'MWGP player examined for the runtime inventory')
converter_src = source_id('tools/convert-mv.js', 'MWGP MV/MZ converter examined for the runtime inventory')

written = 0
for code, name, engines, conv, play, where in ROWS:
    for engine in engines:
        if cur.execute('select 1 from engines where id=?', (engine,)).fetchone() is None:
            continue
        cur.execute('insert or ignore into items(engine_id,kind,code,name,applicability) values(?,?,?,?,?)',
                    (engine, 'feature', code, name, f'runtime: {where}'))
        item = cur.execute("select id from items where engine_id=? and kind='feature' and code=?", (engine, code)).fetchone()[0]
        for component, (status, detail) in (('converter', conv), ('player', play)):
            src = converter_src if component == 'converter' else player_src
            cur.execute('insert or replace into assessments(item_id,component,status,detail,source_id,assessed_at) values(?,?,?,?,?,?)',
                        (item, component, status, detail, src, TODAY))
        cur.execute('insert or ignore into assessments(item_id,component,status,detail,assessed_at) values(?,?,?,?,?)',
                    (item, 'pipeline', 'unknown', 'Aucune évaluation de bout en bout dans cet inventaire.', TODAY))
        written += 1
con.commit()
print('runtime inventory rows written:', written)
