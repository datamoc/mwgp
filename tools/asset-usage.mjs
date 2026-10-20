import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WARNING_PREFIX } from './conversion-diagnostics.mjs';

const TEST_NAME = /(^|[^a-z])test(?:s|ing)?([^a-z]|$)/i;
const IMAGE_EXTENSIONS = ['.png', '.rpgmvp', '.png_', '.jpg', '.jpeg', '.webp'];
const AUDIO_EXTENSIONS = ['.ogg', '.m4a', '.rpgmvo', '.rpgmvm', '.ogg_', '.m4a_', '.wav', '.mp3', '.mid', '.midi', '.wma'];

// Inspect source references, independently of --copy-assets. A missing source
// asset is different from a category the caller chose not to copy. This is a
// static audit: scripts/plugin parameters can construct paths we cannot infer.
export function auditMvAssetUsage({ gameRoot, maps, system, database, commonEvents = [] }) {
  const missing = new Map();
  const existence = new Map();
  const commonScopes = new Map();
  const referencedCommonEvents = new Set();
  const queue = [];
  let nextCommon = 0;

  function reference(folder, name, context, unused = false) {
    if (typeof name !== 'string' || !name) return;
    const asset = `${folder}/${name}`;
    if (!existence.has(asset)) {
      const extensions = folder.startsWith('audio/') ? AUDIO_EXTENSIONS : folder === 'movies' ? ['.webm', '.mp4'] : IMAGE_EXTENSIONS;
      existence.set(asset, [name, ...extensions.map(ext => `${name}${ext}`)].some(file => existsSync(join(gameRoot, folder, file))));
    }
    if (existence.get(asset)) return;
    if (!missing.has(asset)) missing.set(asset, []);
    missing.get(asset).push({ ...context, ...(unused ? { usage: 'unused' } : {}) });
  }

  function common(id, context) {
    if (!commonEvents[id]?.list) return;
    const key = `${id}:${context.usage}`;
    if (commonScopes.has(key)) return;
    commonScopes.set(key, true);
    referencedCommonEvents.add(id);
    queue.push({ id, context: { ...context, location: `${context.location} -> CommonEvents.json event ${id}` } });
  }

  function commands(list, context) {
    for (const command of list || []) {
      const p = command.parameters || [];
      switch (command.code) {
        case 101: reference('img/faces', p[0], context); break;
        case 117: common(Number(p[0]), context); break;
        case 129: actor(database.actors?.[p[0]], context); break;
        case 205:
          for (const move of p[1]?.list || []) {
            if (move.code === 41) reference('img/characters', move.parameters?.[0], context);
            if (move.code === 44) reference('audio/se', move.parameters?.[0]?.name, context);
          }
          break;
        case 231: reference('img/pictures', p[1], context); break;
        case 132: case 241: reference('audio/bgm', p[0]?.name, context); break;
        case 140: reference('audio/bgm', p[1]?.name, context); break;
        case 245: reference('audio/bgs', p[0]?.name, context); break;
        case 133: case 139: case 249: reference('audio/me', p[0]?.name, context); break;
        case 250: reference('audio/se', typeof p[0] === 'string' ? p[0] : p[0]?.name, context); break;
        case 261: reference('movies', p[0], context); break;
        case 282: tileset(p[0], context); break;
        case 283:
          reference('img/battlebacks1', p[0], context);
          reference('img/battlebacks2', p[1], context);
          break;
        case 284: reference('img/parallaxes', p[0], context); break;
        case 322:
          reference('img/characters', p[1], context);
          reference('img/faces', p[3], context);
          if (system.optSideView) reference('img/sv_actors', p[5], context);
          break;
        case 323: reference('img/characters', p[1], context); break;
      }
    }
  }

  function actor(entry, context) {
    reference('img/characters', entry?.characterName, context);
    reference('img/faces', entry?.faceName, context);
    if (system.optSideView) reference('img/sv_actors', entry?.battlerName, context);
  }

  function tileset(id, context) {
    for (const name of database.tilesets?.[id]?.tilesetNames || []) reference('img/tilesets', name, context);
  }

  function drainCommonEvents() {
    while (nextCommon < queue.length) {
      const { id, context } = queue[nextCommon++];
      commands(commonEvents[id].list, context);
    }
  }

  const global = { location: 'System.json', usage: 'gameplay' };
  for (const id of system.partyMembers || []) actor(database.actors?.[id], global);
  for (const key of ['title1Name', 'title2Name']) reference(`img/${key === 'title1Name' ? 'titles1' : 'titles2'}`, system[key], global);
  for (const key of ['titleBgm', 'battleBgm']) reference('audio/bgm', system[key]?.name, global);
  for (const key of ['victoryMe', 'defeatMe', 'gameoverMe']) reference('audio/me', system[key]?.name, global);
  for (const sound of system.sounds || []) reference('audio/se', sound?.name, global);
  for (const key of ['boat', 'ship', 'airship']) {
    const vehicle = system[key];
    reference('img/characters', vehicle?.characterName, global, !vehicle?.startMapId);
    reference('audio/bgm', vehicle?.bgm?.name, global, !vehicle?.startMapId);
  }

  for (const map of maps) {
    const file = `Map${String(map.id).padStart(3, '0')}.json`;
    const name = map.info?.name || '';
    const context = {
      location: `${file}${name ? ` (${name})` : ''}`,
      mapId: map.id,
      mapName: name,
      usage: map.id !== Number(system.startMapId) && TEST_NAME.test(`${file} ${name}`) ? 'test' : 'gameplay'
    };
    const data = map.data;
    tileset(data.tilesetId, context);
    reference('img/parallaxes', data.parallaxName, context);
    for (const layer of [data.settings?.foreground, data.settings?.foregroundB]) reference('img/parallaxes', layer?.name, context);
    reference('audio/bgm', data.bgm?.name, context, !data.autoplayBgm);
    reference('audio/bgs', data.bgs?.name, context, !data.autoplayBgs);
    reference('img/battlebacks1', data.battleback1Name, context, !data.specifyBattleback);
    reference('img/battlebacks2', data.battleback2Name, context, !data.specifyBattleback);
    for (const event of data.events || []) {
      if (!event) continue;
      for (const [index, page] of (event.pages || []).entries()) {
        const pageContext = { ...context, location: `${context.location} event ${event.id} page ${index + 1}` };
        reference('img/characters', page.image?.characterName, pageContext);
        commands(page.list, pageContext);
        commands([{ code: 205, parameters: [0, page.moveRoute] }], pageContext);
      }
    }
  }

  // Autorun and parallel common events may run without a map's explicit call.
  // A common event's own test label never hides a gameplay caller's use.
  for (const event of commonEvents.filter(Boolean)) {
    if (event.trigger > 0) common(event.id, { location: `CommonEvents.json event ${event.id}`, usage: TEST_NAME.test(event.name || '') ? 'test' : 'gameplay' });
  }
  drainCommonEvents();
  // No static caller does not prove that a plugin never invokes this event.
  // Keep uncalled events as unknown (potential defects), rather than claiming
  // that arbitrary JavaScript has been proven dead.
  for (const event of commonEvents.filter(Boolean)) {
    if (!referencedCommonEvents.has(event.id)) {
      common(event.id, { location: `CommonEvents.json event ${event.id}`, usage: TEST_NAME.test(event.name || '') ? 'test' : 'unknown' });
      drainCommonEvents();
    }
  }
  const findings = [...missing].map(([asset, references]) => {
    const unique = [...new Map(references.map(ref => [`${ref.location}:${ref.usage}`, ref])).values()];
    const error = unique.some(ref => ref.usage === 'gameplay' || ref.usage === 'unknown');
    let reason = 'test-only';
    if (error) reason = 'potential-gameplay-use';
    else if (unique.every(ref => ref.usage === 'unused')) reason = 'unused';
    return { asset, severity: error ? 'error' : 'warning', reason, references: unique };
  });
  return {
    method: 'static MV/MZ references; test map names are a heuristic; dynamic script/plugin paths are not resolved',
    errors: findings.filter(finding => finding.severity === 'error').length,
    warnings: findings.filter(finding => finding.severity === 'warning').length,
    missing: findings
  };
}

export function logAssetUsage(report) {
  for (const finding of report.missing) {
    const locations = finding.references.map(ref => ref.location).join('; ');
    const message = `missing asset ${finding.asset} [${finding.reason}]: ${locations}`;
    console.warn(finding.severity === 'warning' ? `${WARNING_PREFIX}${message}` : `MWGP convert: ${message}`);
  }
}
