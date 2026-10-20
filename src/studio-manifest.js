// Shared by Studio and both manifest converters. The baseline lives beside the
// playable manifest: editor metadata never becomes part of the runtime format.
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { protectedStudioAssets, studioAssetRevision } from './studio-assets.js';
import { recompileScripts } from './studio-code.js';
import { CONVERTER_VERSION } from '../tools/converter-version.mjs';

// ---- projects born in the Studio (no RPG Maker source at all) ---------------------------------------------------
// The same shape the converter publishes, so the validator, the player and a later protected
// reconversion all accept a Studio-created project. MV-shaped and deliberately asset-free:
// the player draws its placeholders until the editor attaches decoded images and audio.
export function skeletonMap(id, name = `Carte ${id}`, width = 20, height = 15, tilesetId = 1) {
  return {
    id,
    info: { name, width, height },
    tilesetId,
    data: { width, height, tilesetId, displayName: name, events: [], data: new Array(width * height * 6).fill(0) },
    mwgEvents: [],
  };
}

export function skeletonManifest(title = 'Nouveau projet') {
  const paramCurves = (base, growth) => Array.from({ length: 8 }, (_, param) =>
    Array.from({ length: 99 }, (_, level) => Math.max(1, base[param] + growth[param] * level)));
  return {
    format: 'MWGP',
    converter: { version: CONVERTER_VERSION, engine: 'studio' },
    version: 1,
    source: { engine: 'studio', convertedAt: new Date().toISOString() },
    display: { title, width: 816, height: 624, tileSize: 48 },
    assets: { kind: 'source', root: 'assets', tilesets: false, characters: false, faces: false,
      pictures: false, audio: false, system: false, animations: false, parallaxes: false, windowSkin: false, encryption: 'none' },
    initialMapId: 1,
    initialParty: [1],
    player: { mapId: 1, x: 1, y: 1 },
    playerSprite: { name: '', index: 0 },
    titleScreen: { title1Name: '', title2Name: '', drawTitle: true, commandOffset: { x: 0, y: 0 } },
    audio: { index: { bgm: {}, bgs: {}, me: {}, se: {} }, system: {}, soundfont: null },
    tilesets: [null, { id: 1, mode: 0, name: 'Basique', tilesetNames: ['', '', '', '', '', '', '', '', ''], flags: [] }],
    commonEvents: {},
    maps: [skeletonMap(1, 'Carte 1')],
    database: {
      system: { gameTitle: title, startMapId: 1, startX: 1, startY: 1, partyMembers: [1], currencyUnit: 'G',
        optDrawTitle: true, optDisplayTp: true, optEncounter: true, optSaveCount: true, optUseItems: true,
        sounds: {}, terms: { basic: [], commands: [], messages: {}, params: [] } },
      actors: [null, { id: 1, name: 'Héros', nickname: '', profile: 'Un héros créé dans MWGP Studio.', classId: 1,
        initialLevel: 1, characterName: '', characterIndex: 0, faceName: '', faceIndex: 0, equips: [] }],
      classes: [null, { id: 1, name: 'Aventurier', expParams: [30, 20, 30, 30],
        params: paramCurves([400, 200, 20, 20, 20, 20, 20, 20], [8, 4, 1, 1, 1, 1, 1, 1]), learnings: [], traits: [] }],
      skills: [null], items: [null], weapons: [null], armors: [null], enemies: [null], troops: [null],
      states: [null, { id: 1, name: 'mort', restriction: 4, priority: 100, message1: " s'effondre !",
        message2: ' est vaincu !', removeAtBattleEnd: false, traits: [] }],
    },
  };
}

// Create a brand-new Studio project folder: the playable manifest plus its protected-save
// baseline. saveStudioManifest runs the validator over the manifest before publishing it.
export async function createStudioProject(folder, title = 'Nouveau projet') {
  await mkdir(folder, { recursive: true });
  const manifest = skeletonManifest(title);
  await writeJson(join(folder, 'mwgp.json'), manifest);
  await saveStudioManifest(folder, manifest);
  return manifest;
}

export function withoutStudio(value) {
  if (Array.isArray(value)) return value.map(withoutStudio);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'studio').map(([key, item]) => [key, withoutStudio(item)]));
  return value;
}

const missing = Symbol('missing');
const object = value => value !== missing && value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => {
  if (a === missing || b === missing) return a === b;
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (object(a) && object(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
};

export function mergeManifest(base, edited, fresh, protectedPaths = []) {
  const report = { preserved: [], conflicts: [] };
  function merge(b, e, f, path) {
    const protectedHere = protectedPaths.includes(path);
    const protectedBelow = protectedPaths.some(item => item.startsWith(`${path}/`));
    if (!protectedHere && !protectedBelow && equal(b, e)) return f;
    if (equal(e, f)) return e;
    const keyed = path === '/maps' || /^\/maps\/[^/]+\/mwgEvents$/.test(path);
    if (!protectedHere && keyed && [b, e, f].every(Array.isArray) && [b, e, f].every(rows => rows.every(row => object(row) && row.id != null))) {
      const indexes = [b, e, f].map(rows => new Map(rows.map(row => [String(row.id), row])));
      const ids = new Set([...indexes[2].keys(), ...indexes[1].keys(), ...indexes[0].keys()]);
      return [...ids].map(id => merge(...indexes.map(index => index.has(id) ? index.get(id) : missing), `${path}/${id}`))
        .filter(row => row !== missing);
    }
    // RPG Maker database tables are indexed by ID. Keep null slots and indexes
    // when a row is deleted; compacting them changes what every event refers to.
    if (!protectedHere && /^\/database\/[^/]+$/.test(path) && [b, e, f].every(Array.isArray)) {
      return Array.from({ length: Math.max(e.length, f.length) }, (_, i) => {
        const value = merge(...[b, e, f].map(rows => i < rows.length ? rows[i] : missing), `${path}/${i}`);
        return value === missing ? null : value;
      });
    }
    if (!protectedHere && [b, e, f].every(object)) {
      return Object.fromEntries([...new Set([...Object.keys(f), ...Object.keys(e), ...Object.keys(b)])].flatMap(key => {
        const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
        const value = merge(...[b, e, f].map(o => Object.hasOwn(o, key) ? o[key] : missing), `${path}/${escaped}`);
        return value === missing ? [] : [[key, value]];
      }));
    }
    report.preserved.push(path);
    if (protectedHere || !equal(b, f)) report.conflicts.push({ path, kind: equal(b, f) ? 'protected-divergence' : 'both-changed',
      base: b === missing ? null : b, edited: e === missing ? null : e, fresh: f === missing ? null : f,
      absent: { base: b === missing, edited: e === missing, fresh: f === missing }, kept: 'edited' });
    return e;
  }
  return { manifest: merge(withoutStudio(base), withoutStudio(edited), withoutStudio(fresh), ''), report };
}

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

export async function saveStudioManifest(folder, manifest, options = {}) {
  const clean = withoutStudio(manifest);
  // An edited Ruby script runs through its generated JS: regenerate it against what was published before this save.
  await recompileScripts(clean, await optionalJson(join(folder, 'mwgp.json')));
  const revision = await studioAssetRevision(folder);
  if (revision) clean.assets = { ...clean.assets, revision };
  const candidate = join(folder, `.mwgp-validation-${randomUUID()}.json`);
  await writeFile(candidate, JSON.stringify(clean));
  try {
    await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../tools/validate-mwgp.js', import.meta.url)), candidate]);
  } catch (error) {
    throw new Error(`Invalid Studio manifest: ${error.stderr || error.message}`);
  } finally { await unlink(candidate); }
  const stateFile = join(folder, '.mwgp-studio.json');
  let state = await optionalJson(stateFile);
  if (!state) {
    const current = withoutStudio(JSON.parse(await readFile(join(folder, 'mwgp.json'), 'utf8')));
    state = { version: 1, base: current, protectedPaths: [] };
    await writeJson(join(folder, '.mwgp-conversion.json'), current);
  }
  const changes = mergeManifest(state.base, clean, state.base).report.preserved;
  state.protectedPaths = [...new Set([...(state.protectedPaths ?? []), ...(options.protectedPaths ?? []), ...changes])];
  // Record known edits before publication, so a later source value matching an
  // editor value does not make the edit appear untouched.
  await writeJson(stateFile, state);
  await writeJson(join(folder, 'mwgp.json'), clean);
  return { protectedPaths: state.protectedPaths };
}

export async function loadStudioManifest(folder) {
  const manifest = JSON.parse(await readFile(join(folder, 'mwgp.json'), 'utf8'));
  const state = await optionalJson(join(folder, '.mwgp-studio.json'));
  const changes = state ? mergeManifest(state.base, manifest, state.base).report.preserved : [];
  return { manifest, protectedPaths: [...new Set([...(state?.protectedPaths ?? []), ...changes])], protectedAssets: await protectedStudioAssets(folder) };
}

export async function compareStudioManifest(folder, edited) {
  const state = await optionalJson(join(folder, '.mwgp-studio.json'));
  const fresh = await optionalJson(join(folder, '.mwgp-conversion.json'));
  const base = state?.base ?? JSON.parse(await readFile(join(folder, 'mwgp.json'), 'utf8'));
  const changes = mergeManifest(base, edited, base).report.preserved;
  const protectedPaths = [...new Set([...(state?.protectedPaths ?? []), ...changes])];
  const comparison = mergeManifest(base, edited, fresh ?? base, protectedPaths);
  return { hasConversion: Boolean(fresh), protectedPaths, ...comparison.report,
    lastMerge: await optionalJson(join(folder, '.mwgp-merge-report.json')),
    edited: withoutStudio(edited), fresh: fresh ?? base };
}

export async function writeConvertedManifest(folder, fresh) {
  const revision = await studioAssetRevision(folder);
  if (revision) fresh.assets = { ...fresh.assets, revision };
  const stateFile = join(folder, '.mwgp-studio.json');
  const state = await optionalJson(stateFile);
  let result = { manifest: fresh, report: { preserved: [], conflicts: [] } };
  let protectedPaths = state?.protectedPaths ?? [];
  if (state) {
    let edited;
    try {
      edited = JSON.parse(await readFile(join(folder, 'mwgp.json'), 'utf8'));
    } catch (error) {
      // A crashed earlier conversion can leave the state without its published output.
      // Reconvert from the baseline, keeping the recorded protected paths rather than dying here.
      console.warn(`MWGP Studio: the previous output is unreadable (${error.code || error.message}); treating it as unedited, protected paths still honoured`);
      edited = structuredClone(state.base);
    }
    const changes = mergeManifest(state.base, edited, state.base).report.preserved;
    protectedPaths = [...new Set([...protectedPaths, ...changes])];
    result = mergeManifest(state.base, edited, fresh, protectedPaths);
  }
  await writeJson(join(folder, '.mwgp-conversion.json'), fresh);
  await writeJson(join(folder, '.mwgp-merge-report.json'), result.report);
  await writeJson(join(folder, 'mwgp.json'), result.manifest);
  // Advance only after publication: an interrupted write errs on the side of
  // preserving content. Repeated conversions still accept untouched changes.
  if (state) await writeJson(stateFile, { version: 1, base: fresh, protectedPaths });
  return result.report;
}
