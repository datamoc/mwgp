import sqlite3, re, hashlib, datetime
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
DB=ROOT/'references/compatibilite.sqlite'
today=datetime.date.today().isoformat()
db=sqlite3.connect(DB)
db.execute('PRAGMA foreign_keys=ON')
db.execute('''CREATE TABLE IF NOT EXISTS assessment_history (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), component TEXT NOT NULL, old_status TEXT NOT NULL, old_detail TEXT NOT NULL, old_source_id INTEGER, old_assessed_at TEXT NOT NULL, changed_at TEXT NOT NULL, reason TEXT NOT NULL)''')
def source(path,description):
    data=(ROOT/path).read_bytes(); h=hashlib.sha256(data).hexdigest()
    db.execute('INSERT INTO sources(path,sha256,description) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,description=excluded.description',(path,h,description))
    return db.execute('SELECT id FROM sources WHERE path=?',(path,)).fetchone()[0]
s={name:source(path,desc) for name,path,desc in [
 ('lcf','tools/convert-lcf.mjs','Convertisseur LCF : traitement réel des commandes et mouvements'),
 ('mv','tools/convert-mv.js','Convertisseur MV/MZ : conversion et rapport'),
 ('rgss','tools/convert-rgss.js','Convertisseur RGSS : conversion et rapport'),
 ('vx','tools/rgss-vx.mjs','Table et classification VX'),
 ('ace','tools/rgss-ace.mjs','Table et classification Ace, dérivées de VX'),
 ('player','src/player/player-core.js','Player MWGP : préparation et exécution des commandes'),
 ('guide','AGENTS.md','Architecture et limitations de MWGP'),
 ('coverage','docs/engine-coverage.md','État documenté de la couverture') ]}
changes=0
def update(item,comp,status,detail,src,reason,replace=False):
    global changes
    old=db.execute('SELECT status,detail,source_id,assessed_at FROM assessments WHERE item_id=? AND component=?',(item,comp)).fetchone()
    if old and not replace and old[0]!='unknown': return
    if old and (old[0],old[1],old[2])==(status,detail,src): return
    if old:
        db.execute('INSERT INTO assessment_history(item_id,component,old_status,old_detail,old_source_id,old_assessed_at,changed_at,reason) VALUES (?,?,?,?,?,?,?,?)',(item,comp,*old,today,reason))
        db.execute('UPDATE assessments SET status=?,detail=?,source_id=?,assessed_at=? WHERE item_id=? AND component=?',(status,detail,src,today,item,comp))
    else: db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?)',(item,comp,status,detail,src,today))
    changes+=1

def item(engine,kind,code):
    row=db.execute('SELECT id FROM items WHERE engine_id=? AND kind=? AND code=?',(engine,kind,str(code))).fetchone(); return row[0] if row else None

# LCF: read only top-level case labels of the real converter, rather than
# attributing an aggregate pipeline rating to both components.
lcf=(ROOT/'tools/convert-lcf.mjs').read_text(encoding='utf8')
codeblock=lcf.split('const CODE = {',1)[1].split('};',1)[0]
constants={}
for name,expr in re.findall(r'(\w+)\s*:\s*([\d\s+]+)(?=,|\n)',codeblock):
    constants[name]=sum(int(x) for x in re.findall(r'\d+',expr))
body=lcf.split('function convertCommandList',1)[1].split('\nfunction ',1)[0]
markers=list(re.finditer(r'^      case (?:CODE\.\w+|\d+):[^\n]*',body,re.M))
branches={}
for idx,m in enumerate(markers):
    segment=body[m.start():markers[idx+1].start() if idx+1<len(markers) else len(body)]
    for val in re.findall(r'case (?:CODE\.(\w+)|(\d+)):',m.group(0)):
        code=constants.get(val[0]) if val[0] else int(val[1])
        if code is not None: branches[code]=segment
for engine in ('2000','2003'):
    for code,segment in branches.items():
        i=item(engine,'event_command',code)
        if i is None: continue
        has_fallback=bool(re.search(r'\bunsupported\s*\(',segment))
        detail=('Le code possède un traitement direct ; certaines formes émettent un marqueur unsupported. ' if has_fallback else 'Le code possède un traitement direct dans le convertisseur. ')+'La fidélité de toutes les variantes et l’applicabilité à chaque édition restent à vérifier.'
        update(i,'converter','partial',detail,s['lcf'],'Analyse de la branche de conversion',replace=True)
        if has_fallback:
            row=db.execute("SELECT status FROM assessments WHERE item_id=? AND component='pipeline'",(i,)).fetchone()
            if row and row[0]=='supported':
                update(i,'pipeline','partial','Le convertisseur contient au moins une branche unsupported pour cette commande ; couverture de bout en bout partielle.',s['lcf'],'Correction du statut global contredit par le code',replace=True)
    for n in range(42):
        i=item(engine,'move_command',n)
        if not i: continue
        if 28<=n<=31:
            update(i,'converter','unsupported','Modification relative de vitesse/fréquence : le convertisseur émet un marqueur unsupported.',s['lcf'],'Analyse des étapes de route')
            update(i,'player','unsupported','Le commentaire du convertisseur indique que routeOption ne porte que des valeurs absolues, pas cette modification relative.',s['lcf'],'Analyse des étapes de route')
        else:
            update(i,'converter','partial','Étape reconnue dans Move Event ; sa fidélité dépend notamment de la cible et du regroupement des routes.',s['lcf'],'Analyse des étapes de route')
            update(i,'player','partial','Les primitives MWGP utilisées pour cette étape sont traitées par le player ; les variantes et la fidélité restent à vérifier.',s['player'],'Analyse des étapes de route')

# Independently detected direct command dispatch in MV/MZ; a branch is evidence
# of a conversion path, not evidence that every operand shape is supported.
mv=(ROOT/'tools/convert-mv.js').read_text(encoding='utf8')
mvbody=mv.split('function convertCommands',1)[1].split('function buildCompatibilityReport',1)[0]
mvcodes={int(x) for x in re.findall(r'(?:command|cmd)\.code\s*===?\s*(\d+)',mvbody)}
mvcodes.update(int(x) for x in re.findall(r'case\s+(\d+)\s*:',mvbody))
for engine in ('mv','mz'):
    for code in mvcodes:
        i=item(engine,'event_command',code)
        if i: update(i,'converter','partial','Branche de conversion présente ; cette évaluation atteste une voie de conversion, pas la fidélité de toutes les variantes.',s['mv'],'Analyse des branches MV/MZ')

# RGSS code report plus explicit interpreter cases: only identify conversion
# paths, never promote unsupported report entries on the basis of the report.
rgss=(ROOT/'tools/convert-rgss.js').read_text(encoding='utf8')
rb=rgss.split('function convertCommands',1)[1].split('function classifyCommands',1)[0]
rgsscodes={int(x) for x in re.findall(r'command\.code\s*===?\s*(\d+)',rb)}
rgsscodes.update(int(x) for x in re.findall(r'case\s+(\d+)\s*:',rb))
for engine in ('xp','vx','ace'):
    for code in rgsscodes:
        i=item(engine,'event_command',code)
        if not i: continue
        pipeline=db.execute("SELECT status FROM assessments WHERE item_id=? AND component='pipeline'",(i,)).fetchone()[0]
        if pipeline=='unsupported': continue
        detail='Branche de conversion RGSS présente ; l’exhaustivité des paramètres et le comportement exact de cette version restent à vérifier.'
        update(i,'converter','partial',detail,s['rgss'],'Analyse des branches RGSS')

# Player vocabulary: direct references in prepareEventCommands establish a
# dispatch path, while native primitives are handled by mwg EventRunner.
player=(ROOT/'src/player/player-core.js').read_text(encoding='utf8')
prep=player.split('export function prepareEventCommands',1)[1].split('\nconst FLOOR_AUTOTILE_TABLE',1)[0]
keys=set(re.findall(r'command\.([A-Za-z][A-Za-z0-9_]*)',prep))
native={'say','ask','wait','setSwitch','setVariable','addVariable','move','if'}
for name in keys|native:
    i=item('mwgp','mwgp_command',name)
    if not i or name=='unsupported': continue
    detail=('Commande native déléguée à mwg EventRunner ; ' if name in native else 'Branche de dispatch vers une méthode du player présente ; ')+'les variantes et la fidélité n’ont pas toutes été validées.'
    update(i,'player','partial',detail,s['player'],'Analyse du dispatch MWGP')
i=item('mwgp','mwgp_command','unsupported')
update(i,'player','not_applicable','Marqueur de diagnostic : le player émet un avertissement ; ce n’est pas une fonctionnalité de jeu.',s['player'],'Analyse du marqueur',replace=True)

# Explicit links from source codes to the manifest command used by their common
# form. These links establish a player dispatch path, not full RPGM fidelity.
db.execute('''CREATE TABLE IF NOT EXISTS command_mappings (
    item_id INTEGER NOT NULL REFERENCES items(id), mwgp_item_id INTEGER NOT NULL REFERENCES items(id),
    detail TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources(id),
    PRIMARY KEY(item_id,mwgp_item_id))''')
mvmap={101:'say',102:'ask',103:'inputNumber',104:'selectItem',105:'scroll',111:'if',112:'loop',113:'breakLoop',115:'exitEvent',121:'setSwitch',122:'modifyVariable',123:'setSwitch',124:'timer',125:'changeGold',126:'changeItem',127:'changeWeapon',128:'changeArmor',129:'changeParty',201:'transfer',202:'vehicleLocation',203:'relocate',204:'scrollMap',205:'move',206:'vehicleBoard',211:'setTransparent',212:'animation',213:'balloon',214:'eraseEvent',221:'screenFade',222:'screenFade',223:'screenTint',224:'screenFlash',225:'screenShake',230:'wait',231:'picture',232:'movePicture',233:'rotatePicture',234:'tintPicture',235:'erasePicture',236:'weather',241:'playBgm',242:'fadeoutBgm',243:'saveBgm',244:'resumeBgm',245:'playBgs',246:'fadeoutBgs',249:'me',250:'sound',251:'stopSound',261:'playMovie',282:'changeTileset',284:'changeParallax',285:'locationInfo',301:'battle',302:'shop',303:'inputName',311:'changeHp',313:'changeState',314:'recoverAll',318:'changeSkill',319:'changeEquipment',322:'changeActorImages',331:'changeEnemyHp',332:'changeEnemyMp',333:'changeEnemyState',334:'enemyRecoverAll',335:'enemyAppear',336:'enemyTransform',339:'forceAction',340:'abortBattle',342:'changeEnemyTp',354:'returnToTitle',355:'script',356:'pluginCommand',357:'pluginCommand'}
lcfmap={10110:'say',20110:'say',10120:'messageOptions',10140:'ask',10150:'inputNumber',10210:'setSwitch',10220:'modifyVariable',10230:'timer',10310:'changeGold',10320:'changeItem',10330:'changeParty',10410:'changeActorStat',10420:'changeLevel',10430:'changeActorStat',10440:'changeSkill',10450:'changeEquipment',10460:'changeHp',10470:'changeActorStat',10480:'changeState',10490:'recoverAll',10610:'changeActorText',10620:'changeActorText',10630:'changeActorImages',10640:'changeActorImages',10710:'battle',10720:'shop',10740:'inputName',10810:'transfer',10830:'transfer',10840:'vehicleBoard',10850:'vehicleLocation',10860:'relocate',11010:'screenFade',11020:'screenFade',11030:'screenTint',11040:'screenFlash',11050:'screenShake',11060:'scrollMap',11070:'weather',11110:'picture',11120:'movePicture',11130:'erasePicture',11210:'animation',11310:'setTransparent',11330:'move',11410:'wait',11510:'playBgm',11520:'fadeoutBgm',11530:'saveBgm',11540:'resumeBgm',11550:'sound',11560:'playMovie',11710:'changeTileset',11720:'changeParallax',12010:'if',12120:'goto',12210:'loop',12220:'breakLoop',12310:'exitEvent',12320:'eraseEvent',12420:'gameOver',12510:'returnToTitle',13110:'changeEnemyHp',13120:'changeEnemyMp',13130:'changeEnemyState',13150:'enemyAppear',13410:'abortBattle'}
mvmap.update({119:'goto',132:'systemFlag',133:'systemFlag',134:'systemFlag',135:'systemFlag',136:'systemFlag',137:'systemFlag',138:'systemFlag',139:'systemFlag',140:'systemFlag',216:'systemFlag',217:'gatherFollowers',281:'systemFlag',283:'systemFlag',312:'changeActorStat',315:'changeActorStat',316:'changeLevel',317:'changeActorStat',320:'changeActorText',321:'changeClass',323:'systemFlag',324:'changeActorText',325:'changeProfile',326:'changeActorStat',351:'menu',352:'menu',353:'gameOver',401:'say'})
for engine,mappings,src in [('mv',mvmap,'mv'),('mz',mvmap,'mv'),('2000',lcfmap,'lcf'),('2003',lcfmap,'lcf')]:
    for code,name in mappings.items():
        i=item(engine,'event_command',code); target=item('mwgp','mwgp_command',name)
        if not i or not target: continue
        db.execute('INSERT OR IGNORE INTO command_mappings VALUES (?,?,?,?)',(i,target,'Correspondance pour une forme courante ; certaines variantes utilisent d’autres commandes ou un marqueur unsupported.',s[src]))
        update(i,'player','partial',f'Une forme courante utilise la commande MWGP {name}, traitée par le player ; toutes les variantes source ne sont pas vérifiées.',s['player'],'Correspondance source vers dispatch MWGP')

rgssmap={101:'say',102:'ask',103:'inputNumber',111:'if',112:'loop',113:'breakLoop',115:'exitEvent',121:'setSwitch',122:'modifyVariable',123:'setSwitch',125:'changeGold',126:'changeItem',127:'changeWeapon',128:'changeArmor',129:'changeParty',201:'transfer',221:'screenFade',222:'screenFade',223:'screenTint',224:'screenFlash',225:'screenShake',231:'picture',232:'movePicture',234:'tintPicture',235:'erasePicture',241:'playBgm',242:'fadeoutBgm',245:'playBgs',246:'fadeoutBgs',249:'me',250:'sound',251:'stopSound',301:'battle',314:'recoverAll',355:'script',401:'say'}
for engine in ('xp','vx','ace'):
    mapping=dict(rgssmap)
    mapping.update({104:'messageOptions',106:'wait',116:'eraseEvent',202:'relocate',203:'scrollMap',209:'move',247:'saveBgm',248:'resumeBgm'} if engine=='xp' else {202:'vehicleLocation',203:'relocate',204:'scrollMap',205:'move',212:'animation',213:'balloon',214:'eraseEvent',230:'wait',236:'weather',302:'shop',303:'inputName'})
    for code,name in mapping.items():
        i=item(engine,'event_command',code); target=item('mwgp','mwgp_command',name)
        if not i or not target: continue
        pipeline=db.execute("SELECT status FROM assessments WHERE item_id=? AND component='pipeline'",(i,)).fetchone()[0]
        if pipeline=='unsupported': continue
        db.execute('INSERT OR IGNORE INTO command_mappings VALUES (?,?,?,?)',(i,target,'Forme courante RGSS ; paramètres et variantes propres à chaque version à vérifier.',s['rgss']))
        update(i,'player','partial',f'Une forme courante RGSS utilise {name}, traité par le player ; toutes les variantes ne sont pas vérifiées.',s['player'],'Correspondance RGSS vers dispatch MWGP')

for engine in ('mv','mz','xp','vx','ace'):
    for code in (0,108,408,402,403,404,411,412,413,505,509,601,602,603,604,605,655):
        i=item(engine,'event_command',code)
        if not i: continue
        pipeline=db.execute("SELECT status FROM assessments WHERE item_id=? AND component='pipeline'",(i,)).fetchone()[0]
        if pipeline not in ('supported','partial'): continue
        update(i,'player','not_applicable','Marqueur structurel, commentaire ou continuation absorbé lors de la conversion ; aucun traitement autonome par le player.',s['mv'] if engine in ('mv','mz') else s['rgss'],'Marqueur structurel')
for engine in ('mv','mz'):
    for code in (117,118,405):
        i=item(engine,'event_command',code)
        if i: update(i,'player','not_applicable','Contenu intégré ou marqueur absorbé à la conversion ; les commandes produites sont exécutées séparément.',s['mv'],'Structure de conversion')
    i=item(engine,'event_command',337)
    if i: update(i,'player','unsupported','La commande d’animation de combat ne produit pas d’animation dans le runner actuel.',s['mv'],'Limite explicite de la conversion et du player')

# Coarse functional areas: conservative partial means a real path exists but
# is not an assertion that the complete feature is faithful for every game.
areas={
 'project':('Détection et conversion des formats de projet par convert:auto.','Le player consomme le manifeste MWGP produit, et non les projets source.'),
 'database':('Les tables de base de données sont converties ou adaptées selon le moteur.','Les menus et combats exploitent les données converties ; toutes les règles ne sont pas garanties.'),
 'maps':('Les cartes et leurs couches sont enregistrées dans le manifeste.','Le player construit et affiche les scènes et couches des cartes.'),
 'tilesets':('Les tilesets et données de passage sont convertis ; des limites varient selon le moteur.','Le player rend les tilesets et applique les règles de passage disponibles.'),
 'events':('Les pages, conditions et commandes sont converties dans le vocabulaire MWGP.','Le player sélectionne et exécute les pages et leurs commandes converties.'),
 'movement':('Les routes et mouvements sont traduits avec des limites selon le moteur et les étapes.','Le player exécute les mouvements et routes convertis ; certaines options sont partielles.'),
 'messages':('Les messages, choix et leurs branches sont convertis.','Le player affiche les messages et choix ; certains paramètres peuvent différer.'),
 'flow':('Les commandes de progression et de contrôle sont converties ; certaines conditions et opérandes restent lacunaires.','Le player exécute les branches, variables, interrupteurs et boucles convertis.'),
 'pictures':('Images et effets d’écran sont représentés dans le manifeste et les commandes.','Le player affiche les images et exécute les effets pris en charge.'),
 'parallax':('Les propriétés de panorama et parallaxe connues sont reprises selon le moteur.','Le player affiche les couches de panorama et parallaxe prises en charge.'),
 'audio':('Les ressources audio sont indexées et copiées selon les options de conversion.','Le player lit les pistes via le gestionnaire audio ; les formats non décodables restent une limite.'),
 'video':('Les commandes et ressources vidéo sont traitées sous réserve du format source.','Le player lit les vidéos au format pris en charge par le navigateur.'),
 'battle':('Les données de combat et commandes reconnues sont converties.','Le player dispose d’un moteur de combat ; certaines règles, présentations et scripts de jeu restent partiels.'),
 'menu':('Les données nécessaires aux menus sont transportées dans le manifeste.','Le player fournit ses menus ; les menus personnalisés du jeu peuvent ne pas être reproduits.'),
 'save':('Les données initiales et états de carte sont préparés pour le player.','Le player gère sauvegardes, chargements et transitions ; la compatibilité avec les sauvegardes natives n’est pas établie.'),
 'title':('Les réglages et images du titre stock sont copiés quand disponibles.','Le titre stock est affiché ; les titres personnalisés peuvent différer.'),
 'assets':('Les ressources identifiées sont copiées ou décodées suivant les options et le moteur.','Le player charge les ressources du manifeste ; les ressources absentes peuvent entraîner un remplacement.'),
 'encounters':('Les données de rencontres et réglages associés sont conservés selon le moteur.','Le player gère des rencontres aléatoires avec les données disponibles.'),
 'weather':('Les commandes météorologiques reconnues sont converties ; certains types restent incomplets.','Le player prend en charge certains effets météorologiques.'),
 'localization':('Le texte et l’encodage des projets sont importés selon le format.','Le player affiche les textes et polices disponibles ; la fidélité typographique dépend des ressources.')}
for engine in ('2000','2003','xp','vx','ace','mv','mz'):
    for code,(c,p) in areas.items():
        i=item(engine,'feature',code)
        update(i,'converter','partial',c,s['guide'],'Synthèse de l’architecture')
        update(i,'player','partial',p,s['guide'],'Synthèse de l’architecture')
    i=item(engine,'feature','archives')
    update(i,'player','not_applicable','Les archives source sont extraites avant la lecture du manifeste par le player.',s['guide'],'Répartition du pipeline')
    if engine in ('xp','vx','ace'):
        update(i,'converter','partial','Extraction des archives RGSS prises en charge ; couverture des variantes non garantie.',s['guide'],'Synthèse de l’architecture')
    if engine in ('mv','mz'):
        update(i,'converter','not_applicable','Ce moteur utilise des ressources web, sans archive RGSS à extraire.',s['guide'],'Répartition du pipeline')
    i=item(engine,'feature','scripts')
    if engine in ('mv','mz'):
        c='Les scripts JavaScript et bibliothèques du projet sont préservés.'; p='Le sandbox exécute les scripts avec un ensemble borné d’API ; appels non pris en charge possibles.'
    elif engine in ('xp','vx','ace'):
        c='Les scripts Ruby sont transpilés ; des échecs ou fonctionnalités partielles restent possibles.'; p='Le runtime RGSS exécute le JavaScript transpilé avec une surface d’API incomplète.'
    else:
        c=None; p=None
    if c: update(i,'converter','partial',c,s['guide'],'Synthèse scripts'); update(i,'player','partial',p,s['guide'],'Synthèse scripts')
    i=item(engine,'feature','plugins')
    if engine in ('mv','mz'):
        update(i,'converter','partial','Les bibliothèques et commandes de plugins sont conservées ; la couverture dépend des plugins du jeu.',s['guide'],'Synthèse plugins')
        update(i,'player','partial','Les plugins sont exécutés dans le sandbox avec des API et interfaces partiellement prises en charge.',s['guide'],'Synthèse plugins')
    else:
        update(i,'converter','not_applicable','La fonctionnalité désigne les plugins JavaScript MV/MZ ; voir scripts pour les autres moteurs.',s['guide'],'Périmètre de la rubrique')
        update(i,'player','not_applicable','La fonctionnalité désigne les plugins JavaScript MV/MZ ; voir scripts pour les autres moteurs.',s['guide'],'Périmètre de la rubrique')

db.execute("INSERT OR REPLACE INTO metadata VALUES ('last_reviewed',?)",(today,))
db.commit()
print('assessments updated:',changes)
print('integrity:',db.execute('PRAGMA integrity_check').fetchone()[0],'foreign keys:',len(db.execute('PRAGMA foreign_key_check').fetchall()))
print('status counts:',db.execute('SELECT component,status,count(*) FROM assessments GROUP BY component,status ORDER BY component,status').fetchall())
db.close()
