// Lazy per-map manifest loading (T119).
//
// The on-disk mwgp.json stays a single file and GET /api/mwgp/:id keeps
// serving it whole, but the browser boots from a lightweight index first and
// fetches one full map entry per visited map (transfer or boot). These pure
// helpers are shared by src/server.js (index + per-map routes) and covered by
// tools/test-smoke.mjs; the browser splice lives in public/player.js.

// A stub keeps just enough for everything that touches unvisited maps:
// transfer-target validation, save-slot map names and the boot fallback chain.
// data/mwgEvents (tile layers, converted events) stay server-side until fetched.
export function mapStub(entry) {
  return { id: entry?.id, info: entry?.info ?? null };
}

export function buildMapIndex(manifest) {
  return { ...manifest, maps: (manifest?.maps || []).map(mapStub) };
}

export function findMapEntry(manifest, mapId) {
  const wanted = Number(mapId);
  if (!Number.isFinite(wanted)) return undefined;
  return (manifest?.maps || []).find(map => Number(map?.id) === wanted);
}

// Replace the index stub with a fetched full entry (or append it when the
// index did not list it, e.g. a map added by a reconvert mid-session).
export function spliceMapEntry(index, full) {
  const maps = [...(index?.maps || [])];
  const at = maps.findIndex(map => Number(map?.id) === Number(full?.id));
  if (at >= 0) maps[at] = full;
  else maps.push(full);
  return { ...index, maps };
}
