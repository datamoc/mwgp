// MWGP Studio bridge for real mwgp.json manifests (DOC59 P1, goal triple).
//
//   node tools/mwgp-studio.mjs init    <studioDir> [--title X]
//   node tools/mwgp-studio.mjs lift    <mwgp.json> <studioDir>
//   node tools/mwgp-studio.mjs publish <studioDir> <out.json>
//   node tools/mwgp-studio.mjs compare <a.json> <b.json>
//   node tools/mwgp-studio.mjs merge   <studioDir> <fresh.json> <outDir>
//   node tools/mwgp-studio.mjs edit    <studioDir> [--port N] [--publish-to <file>]
//
// `init` creates a Studio directory for a brand-new project (no RPG Maker source): a
// playable MV-shaped skeleton — one map, one actor, one class, the reference tileset —
// that `publish` turns into a manifest the validator and the player accept. From there
// `edit` (or the web Studio) adds maps, events, commands and database rows, so a whole
// converted project can be generated from zero inside the editor.
// Lift splits a manifest into an editable Studio directory. Every map, event
// and actor is stamped with `studio.originHash`, the hash of its converted
// content. Anything whose content no longer matches that hash is known to be
// editor-modified: a later conversion merged through `merge` can never
// silently overwrite it - the edited version is kept and the divergence is
// reported as a comparable conflict. `publish` reassembles a plain manifest
// the existing player and validator read unchanged (stamps stripped).
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, rename, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeManifest, saveStudioManifest, withoutStudio, skeletonManifest, skeletonMap } from "../src/studio-manifest.js";

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k === "studio") continue;
      out[k] = stable(value[k]);
    }
    return out;
  }
  return value;
}
// One hash algorithm everywhere an originHash is computed or checked (this
// module, the web editor in public/studio.js): stamps must mean the same thing
// in Node and in the browser, or a web-edited entity would not be recognised
// as modified by a merge here. 64-bit imul hash over the stable JSON form;
// change detection only, not a security digest. Stamps written by the former
// SHA-256 form simply read as modified, which fails safe (preserved, compared).
export function hashString(str) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 16);
}
export function hashEntity(entity) {
  return hashString(JSON.stringify(stable(entity)));
}
export function mapOwn(map) { const { mwgEvents, ...own } = map; return own; }
// Real converted maps nest tiles and dimensions: map.data = { width, height,
// data: [tileIds...], tilesetId, ... } (MV and RGSS alike). A flat numeric
// map.data array is also accepted so synthetic/older manifests keep working.
export function mapDims(map) {
  return { width: Number(map?.data?.width ?? map?.width ?? map?.info?.width ?? 0) || 0,
    height: Number(map?.data?.height ?? map?.height ?? map?.info?.height ?? 0) || 0 };
}
export function mapTiles(map) {
  if (Array.isArray(map?.data)) return map.data;
  if (Array.isArray(map?.data?.data)) return map.data.data;
  return [];
}
// A map's stamp covers its own fields (tiles/info), not its events: they are
// tracked as separate entities, so a map only reads modified when IT changed.
export function isMapModified(map) {
  if (map?.studio?.protected) return true;
  if (!map?.studio?.originHash) return true;
  return hashEntity(mapOwn(map)) !== map.studio.originHash;
}
export function stamp(entity) { entity.studio = { originHash: hashEntity(entity) }; return entity; }
export function isModified(entity) {
  if (entity?.studio?.protected) return true;
  if (!entity?.studio?.originHash) return true; // created in the editor: no converted baseline, never dropped
  return hashEntity(entity) !== entity.studio.originHash;
}
export function unstamped(entity) { const c = structuredClone(entity); delete c.studio; return c; }

function entities(manifest) {
  const out = new Map();
  for (const [key, value] of Object.entries(manifest)) {
    if (!["maps", "database", "studio"].includes(key)) out.set(`index:${key}`, { kind: "index", get: () => value });
  }
  for (const m of manifest.maps ?? []) {
    out.set(`map:${m.id}`, { kind: "map", get: () => mapOwn(m) });
    for (const e of m.mwgEvents ?? []) out.set(`event:${m.id}:${e.id}`, { kind: "event", get: () => e });
  }
  for (const [table, rows] of Object.entries(manifest.database ?? {}))
    if (Array.isArray(rows)) rows.forEach((r, i) => out.set(`db:${table}:${r?.id ?? i}`, { kind: "db", get: () => r }));
    else out.set(`db:${table}`, { kind: "db", get: () => rows });
  return out;
}

export function compareManifests(a, b) {
  const ea = entities(a), eb = entities(b), diffs = [];
  for (const id of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(id), y = eb.get(id);
    if (!x || !y || hashEntity(x.get()) !== hashEntity(y.get()))
      diffs.push({ id, kind: (x ?? y).kind, inA: Boolean(x), inB: Boolean(y) });
  }
  return diffs.sort((p, q) => p.id.localeCompare(q.id));
}

const INDEX_SKIP = new Set(["profile", "studioSource", "indexOrigin", "maps", "database", "studio"]);
const indexKeyHash = (value) => hashEntity({ v: value });
const logLine = (opts, text) => { if (!opts?.quiet) console.log(text); };

// A manifest's top-level keys other than maps/database (title, player start,
// titleScreen, audio, tilesets, converter metadata...) are the "index". Each
// key's converted hash is kept in `indexOrigin`, so a key edited in the editor
// reads as modified exactly like a map, event or database row does.
function indexOrigins(index) {
  const out = {};
  for (const [k, v] of Object.entries(index)) if (!INDEX_SKIP.has(k)) out[k] = indexKeyHash(v);
  return out;
}
export function modifiedIndexKeys(index) {
  const origin = index.indexOrigin ?? {};
  const protectedKeys = (index.studio?.protectedPaths ?? []).map(path => path.split('/')[1])
    .filter(key => key && !INDEX_SKIP.has(key));
  return [...new Set([...protectedKeys,
    ...Object.keys(origin).filter((k) => !(k in index) || indexKeyHash(index[k]) !== origin[k]),
    ...Object.keys(index).filter((k) => !INDEX_SKIP.has(k) && !(k in origin))])];
}

export async function lift(manifestPath, outDir, opts) {
  const manifest = typeof manifestPath === "object" ? manifestPath : JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "MWGP") throw new Error("not an MWGP manifest");
  const { maps, database, ...rest } = manifest;
  const stampedMaps = maps.map((m) => {
    const own = stamp(mapOwn(m));
    return { ...own, mwgEvents: (m.mwgEvents ?? []).map((e) => stamp(structuredClone(e))) };
  });
  const stampedDb = {};
  for (const [table, rows] of Object.entries(database ?? {}))
    stampedDb[table] = Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? stamp(structuredClone(r)) : r)) : rows;
  const index = { ...rest, profile: "studio", studioSource: typeof manifestPath === "string" ? basename(manifestPath) : "in-memory",
    indexOrigin: indexOrigins(rest) };
  await writeStudio(outDir, { index, maps: stampedMaps, database: stampedDb });
  await writeFile(join(outDir, ".mwgp-base.json"), JSON.stringify({ manifest: withoutStudio(manifest),
    sourcePath: typeof manifestPath === "string" ? resolve(manifestPath) : null }));
  logLine(opts, `lifted ${stampedMaps.length} maps -> ${outDir}`);
  return outDir;
}

// Writes a Studio directory, removing map/database files that are no longer part of it.
export async function writeStudio(dir, { index, maps, database }) {
  await mkdir(join(dir, "maps"), { recursive: true });
  await mkdir(join(dir, "database"), { recursive: true });
  const keepMaps = new Set(maps.map((m) => `map-${m.id}.json`));
  for (const f of await readdir(join(dir, "maps"))) if (f.endsWith(".json") && !keepMaps.has(f)) await rm(join(dir, "maps", f));
  const keepTables = new Set(Object.keys(database).map((t) => `${t}.json`));
  for (const f of await readdir(join(dir, "database"))) if (f.endsWith(".json") && !keepTables.has(f)) await rm(join(dir, "database", f));
  for (const m of maps) await writeFile(join(dir, "maps", `map-${m.id}.json`), JSON.stringify(m, null, 2));
  for (const [t, rows] of Object.entries(database)) await writeFile(join(dir, "database", `${t}.json`), JSON.stringify(rows, null, 2));
  await writeFile(join(dir, "studio.json"), JSON.stringify(index, null, 2));
}

export async function readStudio(dir) {
  const index = JSON.parse(await readFile(join(dir, "studio.json"), "utf8"));
  const maps = [];
  for (const f of (await readdir(join(dir, "maps"))).sort())
    if (f.endsWith(".json")) maps.push(JSON.parse(await readFile(join(dir, "maps", f), "utf8")));
  const database = {};
  for (const f of await readdir(join(dir, "database")))
    if (f.endsWith(".json")) database[f.slice(0, -5)] = JSON.parse(await readFile(join(dir, "database", f), "utf8"));
  return { index, maps, database };
}

export function toManifest({ index, maps, database }) {
  const rest = Object.fromEntries(Object.entries(index).filter(([k]) => !INDEX_SKIP.has(k)));
  return { ...rest,
    maps: maps.map((m) => { const own = unstamped(m); own.mwgEvents = (m.mwgEvents ?? []).map(unstamped); return own; }),
    database: Object.fromEntries(Object.entries(database).map(([t, rows]) =>
      [t, Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? unstamped(r) : r)) : rows])) };
}

export async function publish(dir, outPath, opts) {
  let manifest = toManifest(await readStudio(dir));
  let baseline;
  try { baseline = JSON.parse(await readFile(join(dir, ".mwgp-base.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Publishing back to the source project shares the web Studio's protected
  // save. A stale CLI directory must not undo untouched source or web changes.
  if (outPath && basename(outPath) === "mwgp.json" && existsSync(outPath)) {
    const current = JSON.parse(await readFile(outPath, "utf8"));
    const changes = baseline ? mergeManifest(baseline.manifest, manifest, baseline.manifest).report.preserved : [];
    const protectedPaths = [...new Set([...(baseline?.protectedPaths ?? []), ...changes])];
    const result = baseline?.sourcePath === resolve(outPath)
      ? mergeManifest(baseline.manifest, manifest, current, protectedPaths)
      : { manifest, report: { preserved: [], conflicts: [] } };
    manifest = result.manifest;
    await saveStudioManifest(dirname(resolve(outPath)), manifest, { protectedPaths });
    await writeFile(join(dir, "publish-report.json"), JSON.stringify(result.report, null, 2));
  } else if (outPath) await writeFile(outPath, JSON.stringify(manifest));
  logLine(opts, `published ${outPath || "in-memory"} (${manifest.maps.length} maps)`);
  return manifest;
}

// Folds a later conversion (`fresh`: a path or a manifest object) into the Studio
// directory `dir`, writing the result to `outDir` (may equal `dir`).
// Rule for every entity (map, event, database row, index key): content still
// equal to its converted baseline (`originHash`) takes the new conversion;
// anything else is editor-modified (or editor-created) and is kept. When the
// new conversion also changed a kept entity, both versions are written to
// `<outDir>/conflicts/` and listed in `merge-report.json`, so they can be compared.
export async function merge(dir, fresh, outDir, opts) {
  const edited = await readStudio(dir);
  const freshRaw = typeof fresh === "object" ? fresh : JSON.parse(await readFile(fresh, "utf8"));
  let baseline;
  try { baseline = JSON.parse(await readFile(join(dir, ".mwgp-base.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (baseline) return mergeTrackedStudio(edited, baseline, freshRaw, outDir, opts);
  const freshStudio = await mkdtemp(join(tmpdir(), "mwgp-fresh-"));
  let freshRead;
  try { await lift(freshRaw, freshStudio, { quiet: true }); freshRead = await readStudio(freshStudio); }
  finally { await rm(freshStudio, { recursive: true, force: true }); }
  const report = { preserved: [], updated: [], added: [], removed: [], conflicts: [] };
  const conflictBodies = new Map();
  const freshMaps = new Map(freshRead.maps.map((m) => [String(m.id), m]));

  function pick(ed, fr, id) {
    if (ed && !fr) {
      if (isModified(ed)) { report.preserved.push(id); report.conflicts.push({ id, kind: "deleted-in-source", kept: "edited" }); conflictBodies.set(id, { edited: ed, fresh: null }); return ed; }
      report.removed.push(id); return null;
    }
    if (!ed) { report.added.push(id); return fr; }
    if (isModified(ed)) {
      report.preserved.push(id);
      if (ed.studio?.originHash && hashEntity(fr) !== ed.studio.originHash) {
        report.conflicts.push({ id, kind: "both-changed", kept: "edited", editedHash: hashEntity(ed), freshHash: hashEntity(fr) });
        conflictBodies.set(id, { edited: ed, fresh: fr });
      }
      return ed;
    }
    if (hashEntity(ed) !== hashEntity(fr)) report.updated.push(id);
    return fr;
  }

  const mergedMaps = [];
  for (const em of edited.maps) {
    const fm = freshMaps.get(String(em.id));
    const keptOwn = pick(mapOwn(em), fm ? mapOwn(fm) : null, `map:${em.id}`);
    if (!keptOwn) continue;
    const freshEvents = new Map((fm?.mwgEvents ?? []).map((e) => [String(e.id), e]));
    const events = [];
    for (const ee of em.mwgEvents ?? []) {
      const kept = pick(ee, freshEvents.get(String(ee.id)) ?? null, `event:${em.id}:${ee.id}`);
      if (kept) events.push(kept);
      freshEvents.delete(String(ee.id));
    }
    for (const fe of freshEvents.values()) { report.added.push(`event:${em.id}:${fe.id}`); events.push(fe); }
    mergedMaps.push({ ...keptOwn, mwgEvents: events });
    freshMaps.delete(String(em.id));
  }
  for (const fm of freshMaps.values()) { report.added.push(`map:${fm.id}`); mergedMaps.push(fm); }

  const mergedDb = {};
  for (const [table, rows] of Object.entries(edited.database)) {
    if (!Array.isArray(rows)) { mergedDb[table] = rows; continue; }
    const freshRows = new Map((freshRead.database[table] ?? []).map((r, i) => [String(r?.id ?? i), r]));
    const outRows = [];
    rows.forEach((er, i) => {
      const key = String(er?.id ?? i);
      const fr = freshRows.get(key) ?? null;
      freshRows.delete(key);
      if (er === null && fr === null) { outRows.push(null); return; } // MV tables are 1-based: keep the null slot
      const kept = pick(er, fr, `db:${table}:${key}`);
      if (kept !== null) outRows.push(kept);
    });
    mergedDb[table] = outRows;
    for (const fr of freshRows.values()) { report.added.push(`db:${table}:${fr?.id}`); mergedDb[table].push(fr); }
  }
  for (const [table, rows] of Object.entries(freshRead.database))
    if (!(table in mergedDb)) mergedDb[table] = rows;

  // Index keys (title, player start, titleScreen, audio, converter metadata...).
  const origin = edited.index.indexOrigin ?? {};
  const mergedIndex = {};
  const mergedOrigin = {};
  const freshIndex = freshRead.index;
  for (const key of new Set([...Object.keys(edited.index), ...Object.keys(freshIndex)])) {
    if (INDEX_SKIP.has(key)) continue;
    const hasEd = key in edited.index, hasFr = key in freshIndex;
    const id = `index:${key}`;
    const frHash = hasFr ? indexKeyHash(freshIndex[key]) : null;
    const known = key in origin;
    const modified = hasEd && (known ? indexKeyHash(edited.index[key]) !== origin[key] : hasFr === false);
    if (!modified) {
      if (!hasFr) { report.removed.push(id); continue; }
      if (!hasEd) report.added.push(id);
      else if (indexKeyHash(edited.index[key]) !== frHash) report.updated.push(id);
      mergedIndex[key] = freshIndex[key]; mergedOrigin[key] = frHash; continue;
    }
    report.preserved.push(id);
    if (hasFr && frHash !== origin[key]) {
      report.conflicts.push({ id, kind: "both-changed", kept: "edited", editedHash: indexKeyHash(edited.index[key]), freshHash: frHash });
      conflictBodies.set(id, { edited: edited.index[key], fresh: freshIndex[key] });
    } else if (!hasFr && known) {
      report.conflicts.push({ id, kind: "deleted-in-source", kept: "edited" });
      conflictBodies.set(id, { edited: edited.index[key], fresh: null });
    }
    mergedIndex[key] = edited.index[key];
    if (known) mergedOrigin[key] = origin[key];
  }
  mergedIndex.profile = "studio";
  mergedIndex.studioSource = edited.index.studioSource ?? freshIndex.studioSource;
  mergedIndex.indexOrigin = mergedOrigin;

  await writeStudio(outDir, { index: mergedIndex, maps: mergedMaps, database: mergedDb });
  let previousBaseline;
  try { previousBaseline = JSON.parse(await readFile(join(dir, ".mwgp-base.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(join(outDir, ".mwgp-base.json"), JSON.stringify({ manifest: withoutStudio(freshRaw),
    sourcePath: previousBaseline?.sourcePath ?? null }));
  const conflictDir = join(outDir, "conflicts");
  await rm(conflictDir, { recursive: true, force: true });
  if (conflictBodies.size) await mkdir(conflictDir, { recursive: true });
  for (const [id, body] of conflictBodies)
    await writeFile(join(conflictDir, `${id.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify({ id, ...body }, null, 2));
  await writeFile(join(outDir, "merge-report.json"), JSON.stringify(report, null, 2));
  logLine(opts, JSON.stringify(report, null, 2));
  logLine(opts, `merged -> ${outDir} (report: merge-report.json)`);
  return report;
}

// Modern directories carry a complete baseline, so the CLI can share the
// web/converter merge, including deletions and stable database array slots.
async function mergeTrackedStudio(edited, baseline, fresh, outDir, opts) {
  const current = toManifest(edited);
  const changes = mergeManifest(baseline.manifest, current, baseline.manifest).report.preserved;
  const protectedPaths = [...new Set([...(baseline.protectedPaths ?? []), ...changes])];
  const result = mergeManifest(baseline.manifest, current, fresh, protectedPaths);
  const idForPath = (path) => {
    const parts = path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts[0] === 'maps') return parts[2] === 'mwgEvents' ? `event:${parts[1]}:${parts[3]}` : `map:${parts[1]}`;
    if (parts[0] === 'database') return `db:${parts[1]}${parts[2] == null ? '' : `:${parts[2]}`}`;
    return `index:${parts[0]}`;
  };
  const preserved = [...new Set(protectedPaths.map(idForPath))];
  const differences = compareManifests(current, result.manifest);
  const report = { preserved,
    updated: differences.filter(diff => diff.inA && diff.inB && !preserved.includes(diff.id)).map(diff => diff.id),
    added: differences.filter(diff => !diff.inA).map(diff => diff.id),
    removed: differences.filter(diff => !diff.inB).map(diff => diff.id),
    conflicts: result.report.conflicts.map(conflict => ({ ...conflict, id: idForPath(conflict.path) })) };
  // Stamps remain compatible with the CLI inspector, but the complete baseline
  // and protected paths are authoritative for the next merge.
  const covers = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`);
  const origin = (entity, source, paths, prefix) => ({ ...entity,
    studio: { originHash: source ? hashEntity(source) : null, protected: paths.some(path => covers(path, prefix)) } });
  const freshMaps = new Map((fresh.maps ?? []).map(map => [String(map.id), map]));
  const maps = result.manifest.maps.map(map => {
    const source = freshMaps.get(String(map.id));
    const prefix = `/maps/${map.id}`;
    const events = new Map((source?.mwgEvents ?? []).map(event => [String(event.id), event]));
    const ownPaths = protectedPaths.filter(path => !path.startsWith(`${prefix}/mwgEvents`));
    return { ...origin(mapOwn(map), source && mapOwn(source), ownPaths, prefix),
      mwgEvents: (map.mwgEvents ?? []).map(event => origin(event, events.get(String(event.id)), protectedPaths, `${prefix}/mwgEvents/${event.id}`)) };
  });
  const database = Object.fromEntries(Object.entries(result.manifest.database ?? {}).map(([table, rows]) => [table,
    Array.isArray(rows) ? rows.map((row, index) => row && typeof row === 'object'
      ? origin(row, fresh.database?.[table]?.[index], protectedPaths, `/database/${table}/${index}`) : row) : rows]));
  const { maps: _maps, database: _database, ...rest } = result.manifest;
  const { maps: _freshMaps, database: _freshDatabase, ...freshRest } = fresh;
  await writeStudio(outDir, { maps, database, index: { ...rest, profile: 'studio',
    studioSource: edited.index.studioSource, indexOrigin: indexOrigins(freshRest), studio: { protectedPaths } } });
  await writeFile(join(outDir, '.mwgp-base.json'), JSON.stringify({ manifest: fresh, sourcePath: baseline.sourcePath, protectedPaths }));
  await writeFile(join(outDir, 'merge-report.json'), JSON.stringify(report, null, 2));
  // Keep every divergence in one file; paths can share an entity ID.
  await writeFile(join(outDir, 'merge-comparison.json'), JSON.stringify(result.report, null, 2));
  if (report.conflicts.length) {
    await mkdir(join(outDir, 'conflicts'), { recursive: true });
    for (const conflict of report.conflicts) {
      const name = `${conflict.id.replace(/[^\w.-]+/g, '_')}-${hashEntity(conflict.path)}.json`;
      await writeFile(join(outDir, 'conflicts', name), JSON.stringify(conflict, null, 2));
    }
  }
  logLine(opts, JSON.stringify(report, null, 2));
  return report;
}

// --- A converted project folder: <project>/mwgp.json (what the player reads),
// <project>/studio/ (the editable truth, stamped), <project>/mwgp.converted.json
// (the latest raw conversion, for comparison with what the editor published).

export const studioDirOf = (project) => join(project, "studio");

export async function ensureStudio(project) {
  const dir = studioDirOf(project);
  if (existsSync(join(dir, "studio.json"))) return dir;
  const manifestPath = join(project, "mwgp.json");
  await lift(manifestPath, dir, { quiet: true });
  await copyFile(manifestPath, join(project, "mwgp.converted.json"));
  return dir;
}

// The manifest the editor works on: the Studio content with its stamps, each
// entity's `studio.modified` computed here (the one place that hashes) and
// `studio.conflicts` listing what the last reconversion could not merge silently.
export async function loadStamped(project) {
  const dir = await ensureStudio(project);
  const { index, maps, database } = await readStudio(dir);
  let conflicts = [];
  try { conflicts = JSON.parse(await readFile(join(dir, "merge-report.json"), "utf8")).conflicts.map((c) => c.id); } catch { /* no merge yet */ }
  const flag = (e, modified) => ({ ...e, studio: { ...e.studio, modified } });
  const rest = Object.fromEntries(Object.entries(index).filter(([k]) => !INDEX_SKIP.has(k)));
  return { ...rest,
    studio: { indexOrigin: index.indexOrigin ?? {}, modifiedKeys: modifiedIndexKeys(index), conflicts },
    maps: maps.map((m) => ({ ...flag(m, isMapModified(m)), mwgEvents: (m.mwgEvents ?? []).map((e) => flag(e, isModified(e))) })),
    database: Object.fromEntries(Object.entries(database).map(([t, rows]) =>
      [t, Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? flag(r, isModified(r)) : r)) : rows])) };
}

// Saves what the editor sends back (the stamped manifest from `loadStamped`,
// edited) into the Studio directory and republishes `mwgp.json` for the player.
export async function saveStamped(project, manifest) {
  const dir = await ensureStudio(project);
  const { index: current } = await readStudio(dir);
  const { maps, database, studio: _studio, ...rest } = manifest;
  const strip = (e) => { if (e?.studio) { const { modified: _m, ...kept } = e.studio; e.studio = kept; } return e; };
  const cleanMaps = maps.map((m) => { strip(m); (m.mwgEvents ?? []).forEach(strip); return m; });
  const cleanDb = Object.fromEntries(Object.entries(database ?? {}).map(([t, rows]) =>
    [t, Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? strip(r) : r)) : rows]));
  const index = { ...rest, profile: "studio", studioSource: current.studioSource, indexOrigin: current.indexOrigin ?? {} };
  await writeStudio(dir, { index, maps: cleanMaps, database: cleanDb });
  await publish(dir, join(project, "mwgp.json"), { quiet: true });
  return { maps: cleanMaps.length };
}

// Run by the converters right after they wrote `<project>/mwgp.json`: when the
// project has a Studio directory, the fresh conversion is merged into it (edited
// entities kept, the rest renewed) and `mwgp.json` becomes the merged result.
export async function reconvertProject(project) {
  const dir = studioDirOf(project);
  if (!existsSync(join(dir, "studio.json"))) return null;
  const manifestPath = join(project, "mwgp.json");
  await copyFile(manifestPath, join(project, "mwgp.converted.json"));
  const next = `${dir}.next`, prev = `${dir}.prev`;
  await rm(next, { recursive: true, force: true });
  const report = await merge(dir, manifestPath, next, { quiet: true });
  await rm(prev, { recursive: true, force: true });
  await rename(dir, prev);
  await rename(next, dir);
  await rm(prev, { recursive: true, force: true });
  await publish(dir, manifestPath, { quiet: true });
  console.log(`MWGP Studio: merged the new conversion into ${dir} — ${report.preserved.length} kept, ${report.updated.length} updated, ${report.added.length} added, ${report.removed.length} removed, ${report.conflicts.length} conflict(s) (see merge-report.json, conflicts/)`);
  return report;
}

// --- Real editor: `edit <studioDir> [--port N] [--publish-to <file>]` -------
// Serves a small editor over the Studio files themselves (not a copy): pick a
// map, edit any `say` text the player can show, save (written back to the map
// file, where the originHash stamp makes the change known-as-modified), and
// publish a Play manifest. Nothing here knows a game or an engine.

function sayPaths(node, path = [], out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => sayPaths(v, [...path, i], out));
  else if (node && typeof node === "object") {
    if (typeof node.say === "string") out.push({ path, text: node.say });
    for (const [k, v] of Object.entries(node)) if (k !== "studio") sayPaths(v, [...path, k], out);
  }
  return out;
}
const getAt = (obj, path) => path.reduce((o, k) => o[k], obj);

const EDITOR_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>MWGP Studio — éditeur</title><link rel="icon" href="data:,"><style>
body{font-family:Georgia,serif;margin:0;background:#dfe3d8;color:#1c2420}
header{background:#243129;color:#f2f0e6;padding:10px 16px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
h1{font-size:19px;margin:0} button{font:inherit;font-size:13px;padding:5px 10px;cursor:pointer}
main{display:grid;grid-template-columns:280px 1fr;gap:10px;padding:10px}
section{background:#eef0ea;border:1px solid #b9beb2;padding:10px}
.evt{border:1px solid #b9beb2;background:#fff;padding:6px;margin:6px 0;font-size:13px}
textarea{width:100%;font:inherit;font-size:13px} .mod{color:#9a5b12;font-weight:bold}
.mono{font-family:Consolas,monospace;font-size:11px} select{font:inherit;width:100%}
</style></head><body>
<header><h1>MWGP Studio — éditeur réel</h1><span id="title" class="mono"></span>
<button id="pub">Publier (Play)</button><span id="out" class="mono"></span></header>
<main>
<section><h2>Carte <button onclick="addMapUI()" style="font-size:11px;padding:2px 8px">+ Nouvelle carte</button></h2><select id="maps"></select><div id="evts"></div>
<h2>Nouvel événement</h2>
<input id="nvName" placeholder="Nom" style="width:100%">
<input id="nvText" placeholder="Texte say" style="width:100%">
<button id="nvBtn">Créer sur la carte</button>
<h2>Base de données — acteurs</h2><div id="db"></div></section>
<section><h2>Textes visibles (say)</h2><div id="says"></div>
<p class="mono">Enregistrer écrit dans le fichier Studio de la carte ; l'entité devient « modifié (protégé) » et une reconversion ne l'écrasera pas (voir merge).</p></section>
</main>
<script>
var DATA = null, cur = null;
function esc(s){ return String(s).replace(/[&<>"']/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function load(){ fetch("/api/studio").then(function(r){ return r.json(); }).then(function(d){
  DATA = d; document.getElementById("title").textContent = d.title + " · " + d.maps.length + " cartes";
  var sel = document.getElementById("maps");
  sel.innerHTML = d.maps.map(function(m){ return '<option value="' + m.id + '">' + esc(String(m.id)) + " — " + esc(m.name || "") + " (" + m.events.length + " év.)</option>"; }).join("");
  sel.onchange = function(){ show(sel.value); }; show(sel.value);
  var rows = (d.database.actors && d.database.actors.rows) || [];
  document.getElementById("db").innerHTML = rows.slice(0, 20).map(function(r){
    return '<div class="evt"><span class="mono">actor ' + r.id + "</span>" + (r.modified ? ' <span class="mod">modifié (protégé)</span>' : "") +
      '<input id="db-' + r.id + '" value="' + esc(r.name) + '" style="width:100%">' +
      '<button onclick="saveDb(' + r.id + ')">Renommer</button></div>'; }).join("");
});}
function saveDb(id){
  fetch("/api/save-db", { method: "POST", body: JSON.stringify({ table: "actors", id: id, field: "name", value: document.getElementById("db-" + id).value }) })
    .then(function(){ load(); });
}
function show(mapId){
  cur = DATA.maps.find(function(m){ return String(m.id) === String(mapId); });
  document.getElementById("evts").innerHTML = cur.events.map(function(e){
    return '<div class="evt"><b>' + esc(e.name || e.id) + "</b> <span class='mono'>" + e.id + " (" + e.x + "," + e.y + ")</span>" +
      (e.modified ? ' <span class="mod">modifié (protégé)</span>' : "") + "</div>"; }).join("");
  document.getElementById("says").innerHTML = cur.events.map(function(e){
    return e.says.map(function(s, i){
      return '<div class="evt"><span class="mono">' + e.id + " · " + s.path.join(".") + '</span>' +
        (e.modified ? ' <span class="mod">modifié (protégé)</span>' : "") +
        '<textarea rows="3" id="say-' + e.id + "-" + i + '">' + esc(s.text) + "</textarea>" +
        '<button onclick="save(\\'' + e.id + "\\'," + i + ')">Enregistrer</button></div>'; }).join("");
  }).join("") || "<p class='mono'>Aucun texte say sur cette carte.</p>";
}
function save(eventId, idx){
  var e = cur.events.find(function(x){ return String(x.id) === String(eventId); });
  var text = document.getElementById("say-" + eventId + "-" + idx).value;
  fetch("/api/save", { method: "POST", body: JSON.stringify({ mapId: cur.id, eventId: eventId, path: e.says[idx].path, text: text }) })
    .then(function(r){ return r.json(); }).then(function(){ load(); });
}
document.getElementById("nvBtn").onclick = function(){
  fetch("/api/add-event", { method: "POST", body: JSON.stringify({ mapId: cur.id, name: document.getElementById("nvName").value, x: 1, y: 1, text: document.getElementById("nvText").value }) })
    .then(function(){ load(); });
};
document.getElementById("pub").onclick = function(){
  fetch("/api/publish", { method: "POST", body: "{}" }).then(function(r){ return r.json(); })
    .then(function(d){ document.getElementById("out").textContent = "publié : " + d.out; });
};
function post(url, body){ return fetch(url, { method: "POST", body: JSON.stringify(body) }).then(function(r){ return r.json(); }).then(function(d){ if(d.error) alert(d.error); load(); }); }
var _show = show;
show = function(mapId){ _show(mapId); renderCmds(); renderMapPlayer(); renderDb(); renderCommon(); renderIndex(); };
function renderCommon(){
  var sec = document.querySelectorAll("main section")[1];
  var box = document.getElementById("common") || sec.appendChild(document.createElement("div"));
  box.id = "common";
  var ce = DATA.commonEvents || {};
  var ids = Object.keys(ce);
  box.innerHTML = "<h2>Événements communs (joués par le player)</h2>" + (ids.length ? ids.map(function(id){
    return '<div class="evt"><span class="mono">common ' + esc(id) + '</span><textarea rows="4" id="ce-' + esc(id) + '">' + esc(JSON.stringify(ce[id])) + '</textarea><button onclick="saveCommon(\'' + esc(id) + '\')">Enregistrer</button></div>';
  }).join("") : "<p class='mono'>Aucun événement commun.</p>");
}
function saveCommon(id){ var v; try { v = JSON.parse(document.getElementById("ce-" + id).value); } catch(err){ alert(err); return; } post("/api/save-common", { id: id, commands: v }); }
function renderIndex(){
  var sec = document.querySelectorAll("main section")[1];
  var box = document.getElementById("indexKeys") || sec.appendChild(document.createElement("div"));
  box.id = "indexKeys";
  var keys = Object.keys(DATA.indexKeys || {});
  box.innerHTML = "<h2>Manifeste (titre, titleScreen, tilesets, audio...)</h2>" + keys.map(function(k){
    return '<div class="evt"><span class="mono">' + esc(k) + '</span><textarea rows="4" id="ik-' + esc(k) + '">' + esc(JSON.stringify(DATA.indexKeys[k])) + '</textarea><button onclick="saveIndex(\'' + esc(k) + '\')">Enregistrer</button></div>';
  }).join("");
}
function saveIndex(key){ var v; try { v = JSON.parse(document.getElementById("ik-" + key).value); } catch(err){ alert(err); return; } post("/api/save-index", { key: key, value: v }); }
function renderMapPlayer(){
  var sec = document.querySelectorAll("main section")[1];
  var box = document.getElementById("mapPlayer") || sec.appendChild(document.createElement("div"));
  box.id = "mapPlayer";
  box.innerHTML = "<h2>Carte et départ joueur (visibles dans le player)</h2>" +
    '<label>Nom affiché <input id="mpName" value="' + esc(cur.name || "") + '"></label> ' +
    '<label>Tileset <input id="mpTileset" type="number" value="' + (cur.tilesetId ?? "") + '"></label> ' +
    '<button onclick="saveMap()">Enregistrer la carte</button>' +
    '<p class="mono">Tuiles: ' + cur.width + "x" + cur.height + ", " + cur.tileLayers + ' couche(s). Peinture: couche <input id="tileLayer" type="number" value="0" style="width:50px"> x <input id="tileX" type="number" value="0" style="width:50px"> y <input id="tileY" type="number" value="0" style="width:50px"> id <input id="tileId" type="number" value="0" style="width:70px"> <button onclick="saveTile()">Peindre</button></p>' +
    '<label>Départ: carte <input id="plMap" type="number" value="' + ((DATA.player && DATA.player.mapId) ?? DATA.initialMapId ?? cur.id) + '" style="width:60px"></label> ' +
    '<label>x <input id="plX" type="number" value="' + ((DATA.player && DATA.player.x) ?? 0) + '" style="width:50px"></label> ' +
    '<label>y <input id="plY" type="number" value="' + ((DATA.player && DATA.player.y) ?? 0) + '" style="width:50px"></label> ' +
    '<button onclick="savePlayer()">Enregistrer le départ</button>' +
    '<h3>Propriétés de la carte (BGM, parallaxe, rencontres...)</h3><textarea rows="6" id="mpProps">' + esc(JSON.stringify(cur.props || {})) + '</textarea> ' +
    '<button onclick="saveMapFields()">Enregistrer les propriétés</button>';
}
function saveMapFields(){ var v; try { v = JSON.parse(document.getElementById("mpProps").value); } catch(err){ alert(err); return; } post("/api/save-map-fields", { mapId: cur.id, fields: v }); }
function saveMap(){ post("/api/save-map", { mapId: cur.id, displayName: document.getElementById("mpName").value, tilesetId: Number(document.getElementById("mpTileset").value) }); }
function saveTile(){ post("/api/save-tile", { mapId: cur.id, layer: Number(document.getElementById("tileLayer").value), x: Number(document.getElementById("tileX").value), y: Number(document.getElementById("tileY").value), tile: Number(document.getElementById("tileId").value) }); }
function savePlayer(){ post("/api/save-player", { mapId: Number(document.getElementById("plMap").value), x: Number(document.getElementById("plX").value), y: Number(document.getElementById("plY").value) }); }
function renderCmds(){
  var sec = document.querySelectorAll("main section")[1];
  var box = document.getElementById("cmds") || sec.appendChild(document.createElement("div"));
  box.id = "cmds";
  var html = "<h2>Toutes les commandes (éditables en JSON)</h2>";
  cur.events.forEach(function(e){
    html += '<div class="evt"><b>' + esc(e.name || String(e.id)) + '</b> <span class="mono">' + e.id + " (" + e.x + "," + e.y + ")</span> " +
      '<label>Nom <input id="evn-' + e.id + '" value="' + esc(e.name || "") + '"></label> <label>x <input id="evx-' + e.id + '" type="number" value="' + e.x + '" style="width:50px"></label> <label>y <input id="evy-' + e.id + '" type="number" value="' + e.y + '" style="width:50px"></label> ' +
      '<button onclick="saveEv(' + e.id + ')">Enregistrer événement</button> ' +
      '<button onclick="delEvent(' + e.id + ')">Supprimer événement</button>';
    (e.pages || []).forEach(function(p, pi){
      html += '<div class="mono">page ' + pi + " · trigger: " + esc(String(p.trigger)) + "</div>";
      (p.commands || []).forEach(function(c, ci){
        html += '<textarea rows="3" id="cmd-' + e.id + "-" + pi + "-" + ci + '">' + esc(JSON.stringify(c)) + "</textarea>" +
          '<button onclick="saveCmd(' + e.id + "," + pi + "," + ci + ')">Enregistrer commande</button> ' +
          '<button onclick="delCmd(' + e.id + "," + pi + "," + ci + ')">Supprimer</button>';
      });
      html += '<textarea rows="2" id="newcmd-' + e.id + "-" + pi + '" placeholder=\'{"say":"..."}\'></textarea>' +
        '<button onclick="addCmd(' + e.id + "," + pi + ')">Ajouter commande</button>';
    });
    html += "</div>";
  });
  box.innerHTML = html || "<p class='mono'>Aucun événement.</p>";
}
function saveCmd(eid, pi, ci){ var v; try { v = JSON.parse(document.getElementById("cmd-" + eid + "-" + pi + "-" + ci).value); } catch(err){ alert(err); return; } post("/api/save-command", { mapId: cur.id, eventId: eid, pageIndex: pi, index: ci, command: v }); }
function addCmd(eid, pi){ var v; try { v = JSON.parse(document.getElementById("newcmd-" + eid + "-" + pi).value); } catch(err){ alert(err); return; } post("/api/add-command", { mapId: cur.id, eventId: eid, pageIndex: pi, command: v }); }
function delCmd(eid, pi, ci){ post("/api/delete-command", { mapId: cur.id, eventId: eid, pageIndex: pi, index: ci }); }
function delEvent(eid){ post("/api/delete-event", { mapId: cur.id, eventId: eid }); }
function saveEv(eid){ post("/api/save-event", { mapId: cur.id, eventId: eid, name: document.getElementById("evn-" + eid).value, x: Number(document.getElementById("evx-" + eid).value), y: Number(document.getElementById("evy-" + eid).value) }); }
function renderDb(){
  var host = document.getElementById("db");
  var tables = Object.keys(DATA.database || {});
  var html = '<h3>Base de données — toutes tables</h3><select id="dbTable" onchange="renderDbRows()">' + tables.map(function(t){ return '<option>' + esc(t) + "</option>"; }).join("") + '</select> <button onclick="addRowUI()" style="font-size:11px;padding:2px 8px">+ Nouvelle ligne</button><div id="dbRows"></div>';
  host.innerHTML = html;
  renderDbRows();
}
function renderDbRows(){
  var t = document.getElementById("dbTable").value;
  var rows = ((DATA.database[t] || {}).rows || []).slice(0, 30);
  document.getElementById("dbRows").innerHTML = rows.map(function(r){
    return '<div class="evt"><span class="mono">' + esc(t) + " " + r.id + "</span>" + (r.modified ? ' <span class="mod">modifié (protégé)</span>' : "") +
      Object.entries(r.fields || {}).map(function(kv){
        return '<label>' + esc(kv[0]) + ' <input id="dbf-' + t + "-" + r.id + "-" + kv[0] + '" value="' + esc(String(kv[1] ?? "")) + '"></label> <button onclick="saveDbField(\'' + t + "'," + r.id + ",'" + kv[0] + "')\">OK</button>";
      }).join("<br>") + "</div>";
  }).join("");
}
function addMapUI(){
  var name = prompt("Nom de la carte ?", "Carte"); if (name === null) return;
  var w = Number(prompt("Largeur (cases) ?", "20")) || 20, h = Number(prompt("Hauteur (cases) ?", "15")) || 15;
  post("/api/add-map", { name: name, width: w, height: h }).then(function(d){ if (d && d.id) load(); });
}
function addRowUI(){
  var t = document.getElementById("dbTable").value;
  var name = prompt("Nom de la ligne (" + t + ") ?", "Nouveau"); if (name === null) return;
  post("/api/add-row", { table: t, row: { name: name } }).then(load);
}
function saveDbField(table, id, field){
  var raw = document.getElementById("dbf-" + table + "-" + id + "-" + field).value;
  var value = raw === "" ? "" : (isNaN(Number(raw)) ? raw : Number(raw));
  fetch("/api/save-db", { method: "POST", body: JSON.stringify({ table: table, id: id, field: field, value: value }) }).then(function(){ load(); });
}
load();

// Add tabs for Audio and Tilesets
function addTabs() {
  const header = document.querySelector("header");
  const tabs = document.createElement("div");
  tabs.innerHTML = "" +
    "<button onclick='showSection("maps")'>Cartes</button> " +
    "<button onclick='showSection("audio")'>Audio</button> " +
    "<button onclick='showSection("tilesets")'>Tilesets</button>";
  header.appendChild(tabs);
}

function showSection(section) {
  document.querySelectorAll("main section").forEach(s => s.style.display = "none");
  if (section === "maps") {
    document.querySelectorAll("main section")[0].style.display = "block";
    document.querySelectorAll("main section")[1].style.display = "block";
  } else if (section === "audio") {
    document.getElementById("audioSection").style.display = "block";
    renderAudio();
  } else if (section === "tilesets") {
    document.getElementById("tilesetsSection").style.display = "block";
    renderTilesets();
  }
}

// Audio Section
function renderAudio() {
  const box = document.getElementById("audioFiles");
  fetch("/api/studio").then(r => r.json()).then(d => {
    const audio = d.audio || {};
    let html = "";
    for (const [kind, files] of Object.entries(audio.index || {})) {
      html += "<h3>" + esc(kind) + "</h3><ul>";
      for (const [name, ext] of Object.entries(files)) {
        html += "<li class='mono'>" + esc(name) + "." + esc(ext) +
          " <button onclick=\"editAudio('" + kind + "', '" + name + "', '" + ext + "')\">Modifier</button></li>";
      }
      html += "</ul>";
    }
    box.innerHTML = html || "<p class='mono'>Aucun fichier audio.</p>";
  });
}

function editAudio(kind, name, ext) {
  const newName = prompt("Nouveau nom (sans extension):", name);
  if (newName === null) return;
  
  fetch("/api/save-audio", {
    method: "POST",
    body: JSON.stringify({ kind, oldName: name, newName, ext })
  }).then(r => r.json()).then(d => {
    if (d.error) alert(d.error);
    load();
  });
}

// Tilesets Section
function renderTilesets() {
  const box = document.getElementById("tilesetsList");
  fetch("/api/studio").then(r => r.json()).then(d => {
    const tilesets = d.tilesets || [];
    let html = "";
    tilesets.forEach(ts => {
      html += "<div class='evt'>" +
        "<span class='mono'>Tileset " + ts.id + "</span>" +
        (ts.modified ? ' <span class="mod">modifié (protégé)</span>' : "") +
        "<br><label>Nom <input id='ts-name-" + ts.id + "' value='" + esc(ts.name || "") + "'></label>" +
        "<button onclick=\"saveTileset(" + ts.id + ")\">Enregistrer</button>" +
        "</div>";
    });
    box.innerHTML = html || "<p class='mono'>Aucun tileset.</p>";
  });
}

function saveTileset(id) {
  const name = document.getElementById("ts-name-" + id).value;
  fetch("/api/save-tileset", {
    method: "POST",
    body: JSON.stringify({ id, name })
  }).then(r => r.json()).then(d => {
    if (d.error) alert(d.error);
    load();
  });
}

// Initialize tabs and sections
addTabs();
const main = document.querySelector("main");
main.innerHTML += '<section id="audioSection" style="display: none;"><h2>Audio</h2><div id="audioFiles"><p class="mono">Chargement...</p></div></section>' +
  '<section id="tilesetsSection" style="display: none;"><h2>Tilesets</h2><div id="tilesetsList"><p class="mono">Chargement...</p></div></section>';
showSection("maps");
</script></body></html>`;

// Map files are addressed by a numeric id only: no path component can come from a request.
function mapFile(dir, mapId) {
  if (!/^\d+$/.test(String(mapId))) throw new Error("bad mapId");
  return join(dir, "maps", `map-${mapId}.json`);
}

export async function edit(dir, port, publishTo) {
  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
    // Local-only editor: refuse DNS-rebinding (foreign Host) and cross-site (foreign Origin) requests.
    const local = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!local.has(req.headers.host ?? "") || (req.headers.origin && !local.has(new URL(req.headers.origin).host)))
      return send(403, JSON.stringify({ error: "forbidden origin" }));
    try {
      if (req.url === "/") return send(200, EDITOR_HTML, "text/html");
      if (req.url === "/api/studio") {
        const studio = await readStudio(dir);
        const maps = studio.maps.map((m) => {
          const { width: w, height: h } = mapDims(m);
          const tiles = mapTiles(m);
          return {
          id: m.id, name: m.data?.displayName ?? m.info?.name ?? m.name ?? "", modified: isMapModified(m),
          width: w, height: h, tiles: w && h ? tiles.slice(0, w * h) : [],
          tileLayers: w && h ? Math.floor(tiles.length / (w * h)) : 0,
          tilesetId: m.data?.tilesetId ?? m.tilesetId ?? null,
          props: (m.data && !Array.isArray(m.data)) ? Object.fromEntries(Object.entries(m.data).filter(([k]) => k !== "data" && k !== "events")) : {},
          events: (m.mwgEvents ?? []).map((e) => ({
            id: e.id, name: e.name, x: e.x, y: e.y, modified: isModified(e), says: sayPaths(e),
            pages: (e.pages ?? []).map((p) => ({ trigger: p.trigger ?? null, commands: p.commands ?? [] })) })),
          };
        });
        const database = {};
        for (const [table, rows] of Object.entries(studio.database))
          if (Array.isArray(rows)) database[table] = { rows: rows.map((r, i) => (r && typeof r === "object"
            ? { id: r.id ?? i, name: r.name ?? "", modified: isModified(r),
                fields: Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== "studio" && (v === null || ["string", "number", "boolean"].includes(typeof v)))) } : null)).filter(Boolean) };
        return send(200, JSON.stringify({ title: studio.index.display?.title ?? studio.index.title ?? "",
          player: studio.index.player ?? null, initialMapId: studio.index.initialMapId ?? null,
          indexKeys: Object.fromEntries(Object.entries(studio.index).filter(([k]) => !["maps", "database", "profile", "studioSource", "commonEvents", "player", "initialMapId"].includes(k))),
          commonEvents: studio.index.commonEvents ?? null, maps, database, 
          tilesets: studio.index.tilesets || [],
          audio: studio.index.audio || {} }));
      }
      if (req.url === "/api/save" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, eventId, path, text } = JSON.parse(body);
        const file = mapFile(dir, mapId);
        const map = JSON.parse(await readFile(file, "utf8"));
        const event = (map.mwgEvents ?? []).find((e) => String(e.id) === String(eventId));
        if (!event) throw new Error(`event ${eventId} not found on map ${mapId}`);
        getAt(event, path).say = text;
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-db" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { table, id, field, value } = JSON.parse(body);
        if (!/^\w+$/.test(table) || !/^\w+$/.test(field)) throw new Error("bad table/field");
        const file = join(dir, "database", `${table}.json`);
        const rows = JSON.parse(await readFile(file, "utf8"));
        const row = rows.find((r, i) => r && String(r.id ?? i) === String(id));
        if (!row) throw new Error(`row ${id} not found in ${table}`);
        row[field] = value;
        await writeFile(file, JSON.stringify(rows, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-audio" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { kind, oldName, newName, ext } = JSON.parse(body);
        if (!/^\w+$/.test(kind) || !/^\w+$/.test(newName)) throw new Error("bad kind/name");
        const studio = await readStudio(dir);
        if (!studio.index.audio?.index?.[kind]) throw new Error(`audio kind ${kind} not found`);
        const files = studio.index.audio.index[kind];
        if (!files[oldName]) throw new Error(`audio file ${oldName} not found`);
        files[newName] = files[oldName];
        delete files[oldName];
        await writeFile(join(dir, "studio.json"), JSON.stringify(studio.index, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-tileset" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { id, name } = JSON.parse(body);
        const file = join(dir, "studio.json");
        const studio = JSON.parse(await readFile(file, "utf8"));
        if (!studio.tilesets) throw new Error("tilesets not found");
        const tileset = studio.tilesets.find(ts => ts.id === id);
        if (!tileset) throw new Error(`tileset ${id} not found`);
        tileset.name = name;
        await writeFile(file, JSON.stringify(studio, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/add-event" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, name, x, y, text } = JSON.parse(body);
        const file = mapFile(dir, mapId);
        const map = JSON.parse(await readFile(file, "utf8"));
        const nextId = Math.max(0, ...(map.mwgEvents ?? []).map((e) => Number(e.id) || 0)) + 1;
        const event = { id: nextId, name: String(name || "Event"), x: Number(x) || 0, y: Number(y) || 0,
          pages: [{ commands: [{ say: String(text || "") }] }] }; // no stamp: editor-created, merge keeps it
        (map.mwgEvents ??= []).push(event);
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ id: nextId }));
      }
      if (req.url === "/api/save-tile" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, layer, x, y, tile } = JSON.parse(body);
        const file = mapFile(dir, mapId);
        const map = JSON.parse(await readFile(file, "utf8"));
        const { width: w, height: h } = mapDims(map);
        const tiles = mapTiles(map);
        if (!w || !h || !tiles.length) throw new Error(`map ${mapId} has no tile data grid`);
        const index = (Number(layer) * h + Number(y)) * w + Number(x); // MV layout: (z*h + y)*w + x
        if (index < 0 || index >= tiles.length) throw new Error("tile out of bounds");
        tiles[index] = Number(tile);
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true, index }));
      }
      const readMapFile = async (mapId) => {
        const file = mapFile(dir, mapId);
        return { file, map: JSON.parse(await readFile(file, "utf8")) };
      };
      const findEvent = (map, eventId) => {
        const event = (map.mwgEvents ?? []).find((e) => String(e.id) === String(eventId));
        if (!event) throw new Error(`event ${eventId} not found`);
        return event;
      };
      // Every command the player can execute is editable as JSON, not only `say`.
      if (req.url === "/api/save-command" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, eventId, pageIndex = 0, index, command } = JSON.parse(body);
        if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("command must be an object");
        const { file, map } = await readMapFile(mapId);
        const page = findEvent(map, eventId).pages?.[Number(pageIndex)];
        if (!page || !Array.isArray(page.commands) || !page.commands[Number(index)]) throw new Error("command not found");
        page.commands[Number(index)] = command;
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/add-command" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, eventId, pageIndex = 0, command } = JSON.parse(body);
        if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("command must be an object");
        const { file, map } = await readMapFile(mapId);
        const event = findEvent(map, eventId);
        (event.pages ??= [{ commands: [] }]);
        const page = event.pages[Number(pageIndex)] ?? (event.pages[Number(pageIndex)] = { commands: [] });
        (page.commands ??= []).push(command);
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true, index: page.commands.length - 1 }));
      }
      if (req.url === "/api/delete-command" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, eventId, pageIndex = 0, index } = JSON.parse(body);
        const { file, map } = await readMapFile(mapId);
        const page = findEvent(map, eventId).pages?.[Number(pageIndex)];
        if (!page?.commands?.[Number(index)]) throw new Error("command not found");
        page.commands.splice(Number(index), 1);
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-event" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, eventId, name, x, y, pageIndex, trigger } = JSON.parse(body);
        const { file, map } = await readMapFile(mapId);
        const event = findEvent(map, eventId);
        if (name !== undefined) event.name = String(name);
        if (x !== undefined) event.x = Number(x);
        if (y !== undefined) event.y = Number(y);
        if (trigger !== undefined && event.pages?.[Number(pageIndex ?? 0)]) event.pages[Number(pageIndex ?? 0)].trigger = trigger;
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/delete-event" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, eventId } = JSON.parse(body);
        const { file, map } = await readMapFile(mapId);
        const before = (map.mwgEvents ?? []).length;
        map.mwgEvents = (map.mwgEvents ?? []).filter((e) => String(e.id) !== String(eventId));
        if (map.mwgEvents.length === before) throw new Error(`event ${eventId} not found`);
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      // Creation from zero: a Studio project can grow maps and database rows, not only edit lifted ones.
      if (req.url === "/api/add-map" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { name, width = 20, height = 15, tilesetId = 1 } = JSON.parse(body);
        const studio = await readStudio(dir);
        const id = Math.max(0, ...studio.maps.map((m) => Number(m.id) || 0)) + 1;
        const map = skeletonMap(id, String(name || `Carte ${id}`), Number(width) || 20, Number(height) || 15, Number(tilesetId) || 1);
        await writeFile(mapFile(dir, id), JSON.stringify({ ...stamp(mapOwn(map)), mwgEvents: [] }, null, 2));
        return send(200, JSON.stringify({ id }));
      }
      if (req.url === "/api/delete-map" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId } = JSON.parse(body);
        const studio = await readStudio(dir);
        if (!studio.maps.some((m) => String(m.id) === String(mapId))) throw new Error(`map ${mapId} not found`);
        if (String(studio.index.initialMapId) === String(mapId)) throw new Error(`map ${mapId} is the initial map: move the player start first`);
        if (studio.maps.length <= 1) throw new Error("cannot delete the only map");
        await rm(mapFile(dir, mapId));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/add-row" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { table, row } = JSON.parse(body);
        if (!/^\w+$/.test(String(table))) throw new Error("bad table");
        const file = join(dir, "database", `${table}.json`);
        const rows = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : [];
        if (!Array.isArray(rows)) throw new Error(`database/${table} is not a row table`);
        const id = Number(row?.id) || Math.max(0, ...rows.map((r, i) => Number(r?.id) || i)) + 1;
        if (rows[id]) throw new Error(`row ${id} already exists in ${table}`);
        while (rows.length <= id) rows.push(null);
        rows[id] = stamp({ name: `Nouveau ${id}`, ...(row && typeof row === "object" ? row : {}), id });
        await writeFile(file, JSON.stringify(rows, null, 2));
        return send(200, JSON.stringify({ id }));
      }
      if (req.url === "/api/delete-row" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { table, id } = JSON.parse(body);
        if (!/^\w+$/.test(String(table))) throw new Error("bad table");
        const file = join(dir, "database", `${table}.json`);
        const rows = JSON.parse(await readFile(file, "utf8"));
        if (!Array.isArray(rows) || !rows[Number(id)]) throw new Error(`row ${id} not found in ${table}`);
        rows[Number(id)] = null; // id-based tables keep their slots: null, never a splice
        await writeFile(file, JSON.stringify(rows, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-map" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, displayName, tilesetId } = JSON.parse(body);
        const { file, map } = await readMapFile(mapId);
        if (map.data && !Array.isArray(map.data)) {
          if (displayName !== undefined) map.data.displayName = String(displayName);
          if (tilesetId !== undefined) map.data.tilesetId = Number(tilesetId);
        } else {
          if (displayName !== undefined) map.name = String(displayName);
          if (tilesetId !== undefined) map.tilesetId = Number(tilesetId);
        }
        if (map.info && displayName !== undefined) map.info.name = String(displayName);
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-map-fields" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, fields } = JSON.parse(body);
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be an object");
        const { file, map } = await readMapFile(mapId);
        if (!map.data || Array.isArray(map.data)) throw new Error(`map ${mapId} has no property object`);
        for (const [k, v] of Object.entries(fields)) if (k !== "data" && k !== "events") map.data[k] = v;
        await writeFile(file, JSON.stringify(map, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-index" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { key, value } = JSON.parse(body);
        if (!/^\w+$/.test(String(key)) || ["maps", "database", "profile", "studioSource"].includes(key)) throw new Error("bad index key");
        const studio = await readStudio(dir);
        studio.index[key] = value;
        await writeFile(join(dir, "studio.json"), JSON.stringify(studio.index, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-common" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { id, commands } = JSON.parse(body);
        if (!Array.isArray(commands)) throw new Error("commands must be an array");
        const studio = await readStudio(dir);
        (studio.index.commonEvents ??= {})[String(id)] = commands;
        await writeFile(join(dir, "studio.json"), JSON.stringify(studio.index, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/save-player" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const { mapId, x, y } = JSON.parse(body);
        const studio = await readStudio(dir);
        studio.index.player = { ...(studio.index.player ?? {}), mapId: Number(mapId), x: Number(x), y: Number(y) };
        studio.index.initialMapId = Number(mapId);
        await writeFile(join(dir, "studio.json"), JSON.stringify(studio.index, null, 2));
        return send(200, JSON.stringify({ ok: true }));
      }
      if (req.url === "/api/publish" && req.method === "POST") {
        const out = publishTo ?? join(dir, "..", "mwgp.play.json");
        await publish(dir, out);
        return send(200, JSON.stringify({ out }));
      }
      return send(404, JSON.stringify({ error: "not found" }));
    } catch (error) { return send(500, JSON.stringify({ error: String(error.message || error) })); }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`MWGP Studio editor: http://127.0.0.1:${port}/  (studio: ${dir})`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "edit") {
    const port = Number(args[args.indexOf("--port") + 1]) || 4300;
    const publishTo = args.includes("--publish-to") ? args[args.indexOf("--publish-to") + 1] : undefined;
    await edit(args[0], port, publishTo);
  }
  else if (cmd === "lift") await lift(args[0], args[1]);
  else if (cmd === "init") {
    const title = args.includes("--title") ? String(args[args.indexOf("--title") + 1]) : "Nouveau projet";
    await lift(skeletonManifest(title), args[0]);
  }
  else if (cmd === "publish") await publish(args[0], args[1]);
  else if (cmd === "merge") await merge(args[0], args[1], args[2]);
  else if (cmd === "compare") {
    const [a, b] = await Promise.all(args.slice(0, 2).map(async (p) => JSON.parse(await readFile(p, "utf8"))));
    console.log(JSON.stringify(compareManifests(a, b), null, 2));
  } else {
    console.error("usage: mwgp-studio.mjs lift|publish|merge|compare|edit ...");
    process.exit(cmd ? 1 : 0);
  }
}
