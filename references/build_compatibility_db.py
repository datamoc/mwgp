import sqlite3, re, hashlib, datetime, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = Path(__file__).with_name('compatibilite.sqlite')
if DB.exists():
    sys.exit('La base existe déjà : aucune donnée manuelle ne sera écrasée.')

def read(path): return (ROOT / path).read_text(encoding='utf-8')
def enum(path):
    block = read(path).split('enum class Code {', 1)[1].split('};', 1)[0]
    return [(int(n), name) for name,n in re.findall(r'^\s*(\w+)\s*=\s*(\d+)\s*,?', block, re.M)]
def sets(path, function):
    text = read(path).split('function '+function,1)[1]
    def one(name):
        body = re.search(r'const '+name+r' = new Set\(\[(.*?)\]\)', text, re.S).group(1)
        return {int(x) for x in re.findall(r'\b\d+\b', body)}
    return one('supported'), one('partial')
def status(code, supported, partial):
    return 'supported' if code in supported else 'partial' if code in partial else 'unsupported'

conn = sqlite3.connect(DB)
conn.executescript('''
PRAGMA foreign_keys=ON;
CREATE TABLE engines (id TEXT PRIMARY KEY, name TEXT NOT NULL, caveat TEXT NOT NULL DEFAULT '');
CREATE TABLE sources (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, description TEXT NOT NULL);
CREATE TABLE items (id INTEGER PRIMARY KEY, engine_id TEXT NOT NULL REFERENCES engines(id), kind TEXT NOT NULL CHECK(kind IN ('event_command','move_command','feature','mwgp_command')), code TEXT NOT NULL, name TEXT NOT NULL, applicability TEXT NOT NULL DEFAULT 'documented', UNIQUE(engine_id,kind,code));
CREATE TABLE assessments (item_id INTEGER NOT NULL REFERENCES items(id), component TEXT NOT NULL CHECK(component IN ('converter','player','pipeline')), status TEXT NOT NULL CHECK(status IN ('supported','partial','unsupported','unknown','not_applicable')), detail TEXT NOT NULL DEFAULT '', source_id INTEGER REFERENCES sources(id), assessed_at TEXT NOT NULL, PRIMARY KEY(item_id,component));
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIEW coverage AS SELECT e.name AS engine, i.kind, i.code, i.name, i.applicability, c.status AS converter_status, p.status AS player_status, x.status AS pipeline_status, c.detail AS converter_detail, p.detail AS player_detail, x.detail AS pipeline_detail FROM items i JOIN engines e ON e.id=i.engine_id LEFT JOIN assessments c ON c.item_id=i.id AND c.component='converter' LEFT JOIN assessments p ON p.item_id=i.id AND p.component='player' LEFT JOIN assessments x ON x.item_id=i.id AND x.component='pipeline';
CREATE INDEX items_kind_code ON items(kind,code);
''')
today = datetime.date.today().isoformat()
for key,value in [('schema_version','1'),('created_at',today),('meaning','Snapshot of source evidence, not a proof of gameplay; component unknown unless separately evidenced.'),('maintenance','Update assessments and source hashes after review; do not regenerate over manual edits.')]: conn.execute('INSERT INTO metadata VALUES (?,?)',(key,value))
for id,name,caveat in [('2000','RPG Maker 2000','LCF enumeration shared with 2003; applicability of individual codes requires review.'),('2003','RPG Maker 2003','LCF enumeration includes EasyRPG and Maniac extensions; applicability requires review.'),('xp','RPG Maker XP','Inventory from converter report and VX comparison; labels and completeness require review.'),('vx','RPG Maker VX','Inventory and report from tools/rgss-vx.mjs.'),('ace','RPG Maker VX Ace','Code table reused from VX by converter; see tools/rgss-ace.mjs for assumptions.'),('mv','RPG Maker MV','Event shapes and plugin behavior vary by project.'),('mz','RPG Maker MZ','MV/MZ inventory shared; engine-specific applicability requires review.'),('mwgp','MWGP','Manifest vocabulary, not a source engine.')]: conn.execute('INSERT INTO engines VALUES (?,?,?)',(id,name,caveat))
source_paths={
 'mv':'tools/convert-mv.js','rgss':'tools/convert-rgss.js','vx':'tools/rgss-vx.mjs','ace':'tools/rgss-ace.mjs',
 'lcf':'notes/rpgmaker-docs/downloads/liblcf-eventcommand.h','move':'notes/rpgmaker-docs/downloads/liblcf-movecommand.h',
 'coverage':'docs/engine-coverage.md','spec':'notes/rpgmaker-docs/downloads/dk-doctor-rpgmaker-format-spec.md','validator':'tools/validate-mwgp.js',
 'player':'docs/player-spec.md','converter':'docs/converter-spec.md',
 'player_code':'src/player/player-core.js','lcf_converter':'tools/convert-lcf.mjs'}
sids={}
for name,path in source_paths.items():
    data=(ROOT/path).read_bytes(); cur=conn.execute('INSERT INTO sources(path,sha256,description) VALUES (?,?,?)',(path,hashlib.sha256(data).hexdigest(),name)); sids[name]=cur.lastrowid

def add(engine,kind,code,name,app='documented'):
    cur=conn.execute('INSERT OR IGNORE INTO items(engine_id,kind,code,name,applicability) VALUES (?,?,?,?,?)',(engine,kind,str(code),name,app))
    return conn.execute('SELECT id FROM items WHERE engine_id=? AND kind=? AND code=?',(engine,kind,str(code))).fetchone()[0]
def assess(item,component,state,detail='',source=None):
    conn.execute('INSERT OR REPLACE INTO assessments VALUES (?,?,?,?,?,?)',(item,component,state,detail,sids.get(source),today))
def unknowns(item):
    assess(item,'converter','unknown','À vérifier séparément.'); assess(item,'player','unknown','À vérifier séparément.'); assess(item,'pipeline','unknown','Aucune évaluation de bout en bout dans cet inventaire.')

# MV/MZ codes from the event-command table only, not operand or database tables.
spec=read(source_paths['spec']).split('## 1. THE EVENT-COMMAND',1)[1].split('## 2.',1)[0]
name_by_code={}
for line in spec.splitlines():
    m=re.match(r'^\|\s*((?:\d+\s*(?:/\s*\d+\s*)*))\|\s*([^|]+)\|',line)
    if m:
        for code in re.findall(r'\d+',m.group(1)):
            if int(code) >= 100: name_by_code.setdefault(int(code),m.group(2).strip().replace('**',''))
mv_sup,mv_part=sets(source_paths['mv'],'buildCompatibilityReport')
for engine in ['mv','mz']:
    for code in sorted(set(name_by_code)|mv_sup|mv_part):
        item=add(engine,'event_command',code,name_by_code.get(code,f'Commande {code}'),'shared inventory; engine applicability needs review')
        unknowns(item)
        assess(item,'pipeline',status(code,mv_sup,mv_part),'Classification initiale du rapport du convertisseur ; certaines formes et les plugins sont reclassés selon le projet. Ne sépare pas conversion et exécution.','mv')

vxtext=read(source_paths['vx'])
vxnames=dict((int(n),s) for n,s in re.findall(r"(\d+):\s*'([^']+)'",vxtext.split('export const VX_COMMAND_NAMES = {',1)[1].split('};',1)[0]))
def exportset(name): return {int(x) for x in re.findall(r'\b\d+\b',re.search(r'export const '+name+r' = new Set\(\[(.*?)\]\)',vxtext,re.S).group(1))}
vxs,vxp=exportset('VX_SUPPORTED'),exportset('VX_PARTIAL')
for engine in ['vx','ace']:
    for code,name in sorted(vxnames.items()):
        item=add(engine,'event_command',code,name,'VX table reused for Ace; applicability needs review' if engine=='ace' else 'documented')
        unknowns(item); assess(item,'pipeline',status(code,vxs,vxp),'Classification initiale du rapport RGSS ; 111/122 peuvent être reclassées selon le projet.','ace' if engine=='ace' else 'vx')
xs,xp=sets(source_paths['rgss'],'buildCompatibilityReport')
for code in sorted(xs|xp|{205,233,236}):
    item=add('xp','event_command',code,f'Commande XP {code}','inventory incomplete; names require XP-specific verification')
    unknowns(item); assess(item,'pipeline',status(code,xs,xp),'Classification initiale XP du rapport RGSS ; certaines formes sont reclassées selon le projet.','rgss')

coverage=read(source_paths['coverage']).split('### Event commands',1)[1].split('### Database, maps and audio',1)[0]
lcfnotes={}
for line in coverage.splitlines():
    fields=[x.strip() for x in line.split('|')]
    if len(fields)<5 or fields[2] not in ('converted','partial','loud'): continue
    first=fields[1].split(' ',1)[0]
    for n in re.findall(r'(?<!\d)\d{4,5}(?!\d)',first): lcfnotes[int(n)]=(fields[2],fields[3])
for engine in ['2000','2003']:
    for code,name in enum(source_paths['lcf']):
        ext=name.startswith(('EasyRpg_','Maniac_'))
        item=add(engine,'event_command',code,name,'extension; applicability needs review' if ext else 'shared LCF enumeration; version applicability needs review')
        unknowns(item)
        if code in lcfnotes:
            state,detail=lcfnotes[code]
            # Documentation mixes conversion and playback: retain it as pipeline evidence only.
            state='unsupported' if state=='loud' else 'partial' if state=='partial' or re.search(r'partial|\bloud\b|stored only|not (?:shown|replayed|reproduced)|ignored',detail,re.I) else 'supported'
            assess(item,'pipeline',state,detail,'coverage')
        elif ext:
            assess(item,'pipeline','unsupported','Extensions signalées comme non prises en charge par la documentation de couverture.','coverage')
    for code,name in enum(source_paths['move']):
        item=add(engine,'move_command',code,name,'shared LCF enumeration; version applicability needs review'); unknowns(item)

allowed=re.search(r'const allowed = new Set\(\[(.*?)\]\)',read(source_paths['validator']),re.S).group(1)
for name in re.findall(r"'([^']+)'",allowed):
    item=add('mwgp','mwgp_command',name,name); unknowns(item)
    assess(item,'converter','unknown','Vocabulaire accepté par le validateur ; production par chaque convertisseur à vérifier.','validator')
    assess(item,'player','unknown','Vocabulaire accepté par le validateur ; comportement et fidélité à vérifier.','validator')

features=[('project','Project detection and source formats'),('archives','Encrypted archive extraction'),('database','Database tables and attributes'),('maps','Maps and tile layers'),('tilesets','Tilesets, autotiles, chipset and passage flags'),('events','Event pages, conditions and triggers'),('movement','Movement routes, collision and vehicles'),('messages','Messages, choices and text controls'),('flow','Switches, variables, branches and loops'),('pictures','Pictures, animations and screen effects'),('parallax','Parallax, panorama and fog'),('audio','Music, effects, MIDI and loop tags'),('video','Video playback'),('battle','Battles and troop events'),('menu','Menus, inventory and equipment'),('save','Save, load and map transitions'),('scripts','Game scripts and engine API'),('plugins','Plugin code and plugin commands'),('title','Title screen'),('assets','Asset decoding and copying'),('encounters','Random encounters'),('weather','Weather effects'),('localization','Text encoding and fonts')]
for engine in ['2000','2003','xp','vx','ace','mv','mz']:
    for code,name in features:
        item=add(engine,'feature',code,name,'feature area; split into subfeatures for precise assessment'); unknowns(item)
        if engine in ('2000','2003') and code in ('database','maps','tilesets','audio'):
            assess(item,'pipeline','partial','Couverture partielle et limites documentées ; consulter la source pour les détails.','coverage')
        if engine=='vx' and code=='tilesets':
            assess(item,'converter','partial','Le convertisseur documente des indicateurs de passage absents ; vérifier avec un projet VX.','vx')

# Narrow, independently evidenced assessments, rather than copying the pipeline
# rating into both components. These cover the ordinary shapes only.
for engine in ('mv','mz'):
    for code in (101,102,121,123,201):
        item=conn.execute("SELECT id FROM items WHERE engine_id=? AND kind='event_command' AND code=?",(engine,str(code))).fetchone()[0]
        assess(item,'converter','supported','Formes standard converties en vocabulaire MWGP ; variantes et plugins restent dépendants du projet.','mv')
        assess(item,'player','partial','Exécution des formes courantes dans le player ; fidélité de toutes les variantes non établie ici.','player_code')
    for code in (111,122,205):
        item=conn.execute("SELECT id FROM items WHERE engine_id=? AND kind='event_command' AND code=?",(engine,str(code))).fetchone()[0]
        assess(item,'converter','partial','Certaines formes produisent un marqueur unsupported ; le rapport peut être reclassé selon les formes rencontrées.','mv')
for engine in ('2000','2003'):
    for code in (10110,10140,10210,10310,10810,11410):
        item=conn.execute("SELECT id FROM items WHERE engine_id=? AND kind='event_command' AND code=?",(engine,str(code))).fetchone()[0]
        assess(item,'converter','partial','Formes courantes converties ; toutes les variantes et différences entre éditions ne sont pas vérifiées ici.','lcf_converter')
for name in ('say','ask','wait','setSwitch','setVariable','addVariable','move','if'):
    item=conn.execute("SELECT id FROM items WHERE engine_id='mwgp' AND kind='mwgp_command' AND code=?",(name,)).fetchone()[0]
    assess(item,'player','partial','Commande prise en charge par EventRunner ; toutes les variantes et la fidélité inter-moteurs ne sont pas évaluées ici.','player_code')
conn.commit()
result=conn.execute('PRAGMA integrity_check').fetchone()[0]
print('integrity:',result,'items:',conn.execute('select count(*) from items').fetchone()[0],'assessments:',conn.execute('select count(*) from assessments').fetchone()[0])
conn.close()
