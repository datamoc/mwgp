// Integration test for MWGP Studio: Convert -> Edit in Studio -> Publish -> Play roundtrip
// Verifies:
// 1. Visible in player => editable in Studio
// 2. Edited in Studio => usable in Play manifest
// 3. Known as modified (originHash) => preserved upon reconversion / merge with conflicts reported
// 4. Compatible with both JavaScript (MV/MZ) and Ruby (XP/VX/Ace) MWGP projects.

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lift, publish, merge, compareManifests, isModified, stamp, unstamped, hashEntity } from "./mwgp-studio.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "mwgp-studio-integ-"));

console.log("=== Testing MWGP Studio Integration ===");

try {
  // Test 1: JavaScript (MV/MZ) Project Roundtrip
  const mzManifestPath = join(root, "MWGP_versions", "Elementals", "mwgp.json");
  assert.ok(existsSync(mzManifestPath), "Elementals manifest should exist");

  const mzStudioDir = join(tmp, "elementals-studio");
  await lift(mzManifestPath, mzStudioDir);

  // Edit map 1 Sign event
  const map1Path = join(mzStudioDir, "maps", "map-1.json");
  const map1 = JSON.parse(readFileSync(map1Path, "utf8"));
  assert.ok(map1.mwgEvents && map1.mwgEvents.length > 0, "Map 1 should contain events");

  const ev0 = map1.mwgEvents[0];
  assert.ok(!isModified(ev0), "Initial event should not be marked modified");

  // Modify first command
  const origText = ev0.pages[0]?.commands?.[0]?.say || "hello";
  if (ev0.pages[0]?.commands?.[0]?.say) {
    ev0.pages[0].commands[0].say = "Modified in Studio for Elementals";
  } else {
    ev0.pages[0].commands.unshift({ say: "New dialogue from Studio" });
  }
  assert.ok(isModified(ev0), "Event must be marked as modified after editing");

  // Paint a tile
  map1.data[0] = 2816;
  assert.ok(isModified(map1), "Map must be marked as modified after painting tile");
  writeFileSync(map1Path, JSON.stringify(map1, null, 2));

  // Edit an actor
  const actorsPath = join(mzStudioDir, "database", "actors.json");
  const actors = JSON.parse(readFileSync(actorsPath, "utf8"));
  assert.ok(actors[1], "Actor 1 should exist");
  assert.ok(!isModified(actors[1]), "Actor 1 initially untouched");
  actors[1].name = "Hero Studio";
  assert.ok(isModified(actors[1]), "Actor 1 marked modified after name change");
  writeFileSync(actorsPath, JSON.stringify(actors, null, 2));

  // Publish
  const mzPublishedPath = join(tmp, "elementals-published.json");
  const mzPublished = await publish(mzStudioDir, mzPublishedPath);

  assert.equal(mzPublished.maps[0].mwgEvents[0].pages[0].commands[0].say,
    ev0.pages[0].commands[0].say, "Edited say text must survive publication");
  assert.equal(mzPublished.maps[0].data[0], 2816, "Painted tile must survive publication");
  assert.equal(mzPublished.database.actors[1].name, "Hero Studio", "Edited actor name must survive publication");
  assert.ok(!JSON.stringify(mzPublished).includes("originHash"), "Studio originHash stamps must be stripped on publish");

  console.log("✓ JavaScript (MV/MZ) Studio edit & publish verified");

  // Test 2: Ruby (XP/VX/Ace) Project Roundtrip
  const xpManifestPath = join(root, "MWGP_versions", "Pokemon Void 0.1.4", "mwgp.json");
  assert.ok(existsSync(xpManifestPath), "Pokemon Void manifest should exist");

  const xpStudioDir = join(tmp, "void-studio");
  await lift(xpManifestPath, xpStudioDir);

  // Edit Void map
  const xpMapPath = join(xpStudioDir, "maps", "map-1.json");
  const xpMap = JSON.parse(readFileSync(xpMapPath, "utf8"));
  assert.ok(xpMap.mwgEvents && xpMap.mwgEvents.length > 0, "Void map 1 should contain events");

  const xpEv = xpMap.mwgEvents[0];
  if (xpEv.pages?.[0]?.commands?.[0]?.say) {
    xpEv.pages[0].commands[0].say = "Pokemon Void text edited in Studio";
  } else {
    xpEv.pages[0].commands.unshift({ say: "Void text added in Studio" });
  }
  assert.ok(isModified(xpEv), "Void event marked modified");
  writeFileSync(xpMapPath, JSON.stringify(xpMap, null, 2));

  const xpPublishedPath = join(tmp, "void-published.json");
  const xpPublished = await publish(xpStudioDir, xpPublishedPath);
  assert.equal(xpPublished.maps[0].mwgEvents[0].pages[0].commands[0].say,
    xpEv.pages[0].commands[0].say, "Void edited text must survive publication");
  assert.ok(!JSON.stringify(xpPublished).includes("originHash"), "Stamps stripped on publish");

  console.log("✓ Ruby (XP/VX/Ace) Studio edit & publish verified");

  // Test 3: Merge with fresh reconversion (DOC59 rev4)
  const freshMz = JSON.parse(readFileSync(mzManifestPath, "utf8"));
  if (freshMz.maps[0].mwgEvents[0].pages[0]?.commands?.[0]?.say) {
    freshMz.maps[0].mwgEvents[0].pages[0].commands[0].say = "Source changed this dialogue too";
  } else {
    freshMz.maps[0].mwgEvents[0].pages[0].commands.unshift({ say: "Source changed this dialogue too" });
  }
  const freshPath = join(tmp, "fresh-elem.json");
  writeFileSync(freshPath, JSON.stringify(freshMz));

  const mergedDir = join(tmp, "merged-studio");
  await merge(mzStudioDir, freshPath, mergedDir);
  const mergeReport = JSON.parse(readFileSync(join(mergedDir, "merge-report.json"), "utf8"));

  assert.ok(mergeReport.preserved.includes(`event:${map1.id}:${ev0.id}`), "Modified event must be preserved");
  assert.ok(mergeReport.conflicts.some(c => c.id === `event:${map1.id}:${ev0.id}`), "Conflict must be reported");

  const mergedPublished = await publish(mergedDir, join(tmp, "merged.json"));
  assert.equal(mergedPublished.maps[0].mwgEvents[0].pages[0].commands[0].say,
    ev0.pages[0].commands[0].say, "Studio edit must NOT be overwritten by source change");

  console.log("✓ DOC59 Merge protection verified: modified entities preserved, conflict logged");

  console.log("=== All MWGP Studio Integration checks PASSED ===");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
