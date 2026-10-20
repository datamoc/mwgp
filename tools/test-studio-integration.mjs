// Integration test for MWGP Studio: Convert -> Edit in Studio -> Publish -> Play roundtrip.
// It runs on the first two converted games in RPGM_versions/ (see tools/test-games.mjs), whatever
// their engine. For each game it checks:
// 1. Visible in player => editable in Studio; the edits survive publication, without Studio stamps.
// And for the first game:
// 2. Known as modified (originHash) => preserved upon reconversion, with the conflict reported.

import assert from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lift, publish, merge, isModified } from "./mwgp-studio.mjs";
import { requireConvertedGames } from "./test-games.mjs";

const tmp = mkdtempSync(join(tmpdir(), "mwgp-studio-integ-"));
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const fileSafe = name => name.replace(/[^\w.-]+/g, "_");

// The first map of a studio folder that has events, with its file.
function firstEventMap(studioDir) {
  const mapsDir = join(studioDir, "maps");
  for (const file of readdirSync(mapsDir).sort()) {
    const map = readJson(join(mapsDir, file));
    if (map.mwgEvents?.length > 0) return { file: join(mapsDir, file), map };
  }
  throw new Error(`${studioDir}: no map with events to edit`);
}

// Makes the first command of the event's first page say `text`, as an edit in the Studio does.
function setFirstSay(event, text) {
  const page = event.pages?.[0];
  assert.ok(page, "the event must have a first page");
  if (page.commands?.[0]?.say) page.commands[0].say = text;
  else (page.commands ??= []).unshift({ say: text });
}

async function studioRoundtrip(game) {
  const name = game.name;
  const studioDir = join(tmp, `${fileSafe(name)}-studio`);
  await lift(game.manifestPath, studioDir);

  const { file: mapFile, map } = firstEventMap(studioDir);
  const event = map.mwgEvents[0];
  assert.ok(!isModified(event), `${name}: initial event must not be marked modified`);
  const edited = `Modified in Studio for ${name}`;
  setFirstSay(event, edited);
  assert.ok(isModified(event), `${name}: event must be marked modified after editing`);

  map.data[0] = 2816;
  assert.ok(isModified(map), `${name}: map must be marked modified after painting a tile`);
  writeJson(mapFile, map);

  const actorsPath = join(studioDir, "database", "actors.json");
  const actors = existsSync(actorsPath) ? readJson(actorsPath) : [];
  const editActor = Boolean(actors[1]);
  if (editActor) {
    assert.ok(!isModified(actors[1]), `${name}: actor 1 initially untouched`);
    actors[1].name = "Hero Studio";
    assert.ok(isModified(actors[1]), `${name}: actor 1 marked modified after a name change`);
    writeJson(actorsPath, actors);
  } else {
    console.log(`  ${name}: no actor 1 in the database, actor edit not checked`);
  }

  const published = await publish(studioDir, join(tmp, `${fileSafe(name)}-published.json`));
  const publishedMap = published.maps.find(entry => entry.id === map.id);
  assert.equal(publishedMap.mwgEvents[0].pages[0].commands[0].say, edited, `${name}: edited say text must survive publication`);
  assert.equal(publishedMap.data[0], 2816, `${name}: painted tile must survive publication`);
  if (editActor) {
    assert.equal(published.database.actors[1].name, "Hero Studio", `${name}: edited actor name must survive publication`);
  }
  assert.ok(!JSON.stringify(published).includes("originHash"), `${name}: Studio originHash stamps must be stripped on publish`);
  console.log(`✓ ${name}: Studio edit & publish verified`);
  return { studioDir, map, event, edited };
}

async function mergeProtection(game, { studioDir, map, event, edited }) {
  const name = game.name;
  const fresh = readJson(game.manifestPath);
  const freshEvent = fresh.maps.find(entry => entry.id === map.id).mwgEvents.find(entry => entry.id === event.id);
  setFirstSay(freshEvent, "Source changed this dialogue too");
  const freshPath = join(tmp, `${fileSafe(name)}-fresh.json`);
  writeJson(freshPath, fresh);

  const mergedDir = join(tmp, `${fileSafe(name)}-merged-studio`);
  await merge(studioDir, freshPath, mergedDir);
  const report = readJson(join(mergedDir, "merge-report.json"));
  const id = `event:${map.id}:${event.id}`;
  assert.ok(report.preserved.includes(id), `${name}: modified event must be preserved`);
  assert.ok(report.conflicts.some(conflict => conflict.id === id), `${name}: conflict must be reported`);

  const mergedPublished = await publish(mergedDir, join(tmp, `${fileSafe(name)}-merged.json`));
  const mergedMap = mergedPublished.maps.find(entry => entry.id === map.id);
  assert.equal(mergedMap.mwgEvents[0].pages[0].commands[0].say, edited, `${name}: Studio edit must NOT be overwritten by a source change`);
  console.log(`✓ ${name}: DOC59 merge protection verified: modified entities preserved, conflict logged`);
}

try {
  const games = requireConvertedGames(undefined, { manifest: true }).slice(0, 2);
  console.log(`=== Testing MWGP Studio Integration on ${games.map(game => game.name).join(" and ")} ===`);
  const roundtrips = [];
  for (const game of games) roundtrips.push(await studioRoundtrip(game));
  await mergeProtection(games[0], roundtrips[0]);
  console.log("=== All MWGP Studio Integration checks PASSED ===");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
