// Classifies an MV/MZ project's plugins by the engine layer they redefine, so
// the plugins the player already replaces (UI the player draws itself, battle and
// menu screens it runs) can be told apart from the ones whose logic must run.
// `bypassed` means the plugin hooks classes whose job the player does with its own
// runner (battle.js, menu.js, MessageBox): the plugin's behaviour is not applied, so
// each one is a candidate for an equivalent in mwg or a package.
// Detection by capability: it names engine classes (Window_*, Game_*, ...), never
// a game or a plugin.
//
//   node tools/plugin-capabilities.mjs <project> [--json]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// Engine class -> layer, and what the MWGP player does for that layer.
const LAYERS = [
  ['message', /^(Window_(Message|ChoiceList|NameBox|NumberInput|KeyItem|ItemChoice|ScrollText|Gold|EventItem)|Game_Message)$/, 'native: mwg MessageBox / dialogue'],
  ['battle', /^(BattleManager|Scene_Battle|Window_Battle\w*|Window_(Actor|Party)Command|Window_(Enemy|Skill|Item)Select|Sprite_(Battler|Actor|Enemy|Damage|Animation|Weapon|StateIcon|StateOverlay|Battleback)|Spriteset_Battle)$/, 'native: src/player/battle.js (+ stage); skills and items with a note run on the game engine (battle-engine.js)'],
  ['menu', /^(Scene_(Menu|Item|Skill|Equip|Status|Options|File|Save|Load|Gameover|Title|Shop|Name|Debug|MenuBase|ItemBase)|Window_(Menu\w*|Status\w*|Equip\w*|Item\w*|Skill\w*|Options|Save\w*|Shop\w*|Title\w*|Name\w*|Help|Selectable|Command|Base|Scrollable|Gold|Horz\w*)|Sprite_(Button|Gauge)|Spriteset_Base)$/, 'native: src/player/menu.js and window skin'],
  ['render', /^(Sprite|Sprite_\w+|Spriteset_Map|Tilemap|Bitmap|Graphics|ImageManager|Scene_Map|Scene_Boot|Scene_Base|SceneManager|Weather|ScreenSprite|Game_Screen|Game_Picture|Game_Character\w*|Game_Player|Game_Follower\w*|Game_Vehicle|Game_Event|Game_Map|Game_Timer|Game_CharacterBase)$/, 'partial: map scene is mwg Scene2D; sprites are inert in the sandbox'],
  ['input', /^(Input|TouchInput|Window_Selectable)$/, 'native: mwg Input'],
  ['audio', /^(AudioManager|WebAudio|Html5Audio|SoundManager)$/, 'native: src/player/audio-manager.js'],
  ['data', /^(DataManager|StorageManager|JsonEx|Game_(Interpreter|System|Switches|Variables|SelfSwitches|Temp|Troop|Item|Party|Actors|Actor|Enemy|Action|ActionResult|Battler|BattlerBase|Unit)|PluginManager|TextManager|ConfigManager|Utils|Decrypter|ResourceHandler)$/, 'runs: the game logic (Game_* battlers, actions, party) runs in the sandbox; battle skills with a note use it through battle-engine.js'],
];

// What @datamoc/mwg offers for each layer: names are checked against the installed library at run time,
// so a name that is not exported is never reported.
const MWG_CANDIDATES = {
  message: ['MessageBox', 'DialogueStage', 'MessageLog', 'parseDialogueText', 'messageBoxPresenter'],
  menu: ['WindowStack', 'ListView', 'TabbedList', 'StatsScreen', 'StatusVisuals', 'SettingsScreen', 'Tooltip', 'TooltipHost', 'HelpScreen'],
  battle: ['Battle', 'FloatingText', 'FloatingTextStack', 'Meter', 'Bar'],
  render: ['ScreenEffects', 'TiledSprite', 'LayeredSprite', 'ParticleEmitter', 'ClothSprite', 'SkeletalSprite', 'TintedSprite', 'SpriteMotion'],
  input: ['Input', 'PlayerInput', 'RebindScreen', 'OnScreenKeyboard'],
  audio: ['Audio', 'Music'],
  data: ['SaveSystem', 'I18n', 'Achievements']
};
export async function mwgSupport() {
  let exported;
  try { exported = new Set(Object.keys(await import('@datamoc/mwg'))); } catch { return {}; }
  return Object.fromEntries(Object.entries(MWG_CANDIDATES).map(([layer, names]) => [layer, names.filter(name => exported.has(name))]));
}

export function layerOf(className) {
  for (const [layer, pattern, note] of LAYERS) if (pattern.test(className)) return { layer, note };
  return { layer: 'other', note: 'engine-adjacent class the table does not know' };
}

export function classify(source) {
  // Names the plugin introduces itself (namespaces, parameter tables): `var X = X || {}`, `const X = ...`, `function X`, `class X`.
  const declared = new Set([...source.matchAll(/^(?:var|let|const|function\*?|class)\s+([A-Z][\w$]*)/gm)].map(match => match[1]));
  for (const match of source.matchAll(/\bwindow\.([A-Z][\w$]*)\s*=(?!=)/g)) declared.add(match[1]);
  const classes = new Map();
  for (const m of source.matchAll(/\b([A-Z][\w$]*)\.(?:prototype\.)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]{0,80})/g)) {
    // `Alias.x = Game_Actor.prototype.y` only saves the original before wrapping it: not behaviour of its own.
    if (/^[A-Z][\w$.]*\.[\w$]+\s*;?$/.test(m[3].trim())) continue;
    if (!classes.has(m[1])) classes.set(m[1], new Set());
    classes.get(m[1]).add(m[2]);
  }
  const byLayer = {};
  for (const [name, members] of classes) {
    let { layer } = layerOf(name);
    if (layer === 'other' && declared.has(name)) layer = 'private';
    (byLayer[layer] ??= { classes: [], members: 0 });
    byLayer[layer].classes.push(name);
    byLayer[layer].members += members.size;
  }
  const commands = /Game_Interpreter\.prototype\.pluginCommand|PluginManager\.registerCommand/.test(source);
  const total = Object.values(byLayer).reduce((n, l) => n + l.members, 0);
  const share = layer => (byLayer[layer]?.members ?? 0) / (total || 1);
  const replaced = ['message', 'battle', 'menu', 'input', 'audio'].reduce((n, l) => n + share(l), 0);
  const verdict = total === 0 ? (commands ? 'commands-only' : 'standalone')
    : replaced >= 0.8 ? 'bypassed'
    : share('data') + share('other') + share('private') >= 0.8 ? 'logic-runs'
    : 'mixed';
  return { byLayer, commands, members: total, verdict };
}

export function pluginDir(project) {
  for (const dir of [join(project, 'www', 'js', 'plugins'), join(project, 'js', 'plugins')]) if (existsSync(dir)) return dir;
  throw new Error(`no js/plugins folder under ${project}`);
}

// The plugins the game really loads: `status: true` entries of js/plugins.js, in load order. A file that sits in the
// folder without being enabled (an old version, a spare) never runs, so it is left out; `null` when the list is unreadable.
export function enabledPlugins(project) {
  const dir = pluginDir(project);
  const list = join(dir, '..', 'plugins.js');
  if (!existsSync(list)) return null;
  const text = readFileSync(list, 'utf8');
  const match = [text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)];
  try { return JSON.parse(match[0]).filter(entry => entry.status !== false).map(entry => entry.name); } catch { return null; }
}

export function analyseProject(project) {
  const dir = pluginDir(project);
  const enabled = enabledPlugins(project);
  const files = readdirSync(dir).filter(file => file.endsWith('.js')).map(file => basename(file, '.js'));
  const names = enabled ? enabled.filter(name => files.includes(name)) : files.sort();
  return names.map(name => ({ plugin: name, ...classify(readFileSync(join(dir, `${name}.js`), 'utf8')) }));
}

export async function report(project) {
  const rows = analyseProject(project);
  const support = await mwgSupport();
  const perLayer = {};
  for (const row of rows) for (const [layer, info] of Object.entries(row.byLayer)) {
    const entry = perLayer[layer] ??= { plugins: 0, members: 0 };
    entry.plugins++; entry.members += info.members;
  }
  const counts = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  const lines = [`# Plugin capabilities: ${basename(project)}`, '', `${rows.length} plugins: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`, '',
    '| Engine layer | Plugins touching it | Members redefined | What the player does | mwg offers |', '|---|---:|---:|---|---|'];
  for (const [layer, entry] of Object.entries(perLayer).sort((a, b) => b[1].members - a[1].members)) {
    const note = layer === 'private' ? 'plugin-private state and namespaces (parameter tables, helpers): nothing for the player to replace' : (LAYERS.find(([name]) => name === layer)?.[2] ?? 'engine-adjacent class the table does not know');
    lines.push(`| ${layer} | ${entry.plugins} | ${entry.members} | ${note} | ${(support[layer] || []).join(', ') || '(nothing mapped)'} |`);
  }
  lines.push('', '`bypassed` plugins hook layers the player runs with its own code; their behaviour is not applied. Each is a candidate for an', 'equivalent built on the mwg exports above or on a package; decide per plugin from its redefined members (`--json`).');
  return lines.join(String.fromCharCode(10));
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').slice(-2).join('/'));
if (isMain) {
  const [project, flag] = process.argv.slice(2);
  if (!project) { console.error('usage: node tools/plugin-capabilities.mjs <project> [--json]'); process.exit(1); }
  const rows = analyseProject(project);
  if (flag === '--md') console.log(await report(project));
  else if (flag === '--json') console.log(JSON.stringify(rows, null, 2));
  else {
    const counts = {};
    for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    console.log(`${rows.length} plugins:`, Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
    for (const verdict of Object.keys(counts))
      console.log(`\n[${verdict}]\n  ` + rows.filter(r => r.verdict === verdict).map(r => r.plugin).join(', '));
  }
}
