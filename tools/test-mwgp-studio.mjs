// Durable test for tools/mwgp-studio.mjs (DOC59 triple properties):
// visible-in-player => editable-in-Studio, edited => usable-in-Play,
// editor-modified => never overwritten by a later conversion, but comparable.
// Synthetic manifest, temp dirs only. Run: node tools/test-mwgp-studio.mjs
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mwgp-studio.mjs");
const run = (...a) => execFileSync("node", [TOOL, ...a], { encoding: "utf8" });
const tmp = mkdtempSync(join(tmpdir(), "mwgp-studio-test-"));

const manifest = {
  format: "MWGP", version: 1, source: { engine: "synthetic" }, display: { title: "T" },
  initialMapId: 1, player: { mapId: 1, x: 1, y: 1 }, assets: { kind: "source" },
  maps: [{ id: 1, info: { name: "M1" }, data: { width: 2, height: 2, tilesetId: 0, data: new Array(24).fill(0) },
    mwgEvents: [
      { id: 1, name: "Sign", x: 1, y: 1, pages: [{ trigger: "action", commands: [{ say: "hello" }, { wait: 10 }] }] },
      { id: 2, name: "Door", x: 2, y: 1, pages: [{ trigger: "action", commands: [{ say: "door" }] }] },
    ] }],
  database: { actors: [null, { id: 1, name: "Aria" }] },
  commonEvents: { "1": [{ say: "common hello" }] },
};
const srcPath = join(tmp, "mwgp.json");
writeFileSync(srcPath, JSON.stringify(manifest));

// lift, then edit the Sign event and paint nothing: only the text changes
run("lift", srcPath, join(tmp, "studio"));
const mapFile = join(tmp, "studio", "maps", "map-1.json");
const studioMap = JSON.parse(readFileSync(mapFile, "utf8"));
assert.equal(studioMap.mwgEvents[0].pages[0].commands[0].say, "hello", "player-visible text must be editable in Studio");
studioMap.mwgEvents[0].pages[0].commands[0].say = "edited in studio";
writeFileSync(mapFile, JSON.stringify(studioMap, null, 2));

// publish: the edit must be usable in the Play manifest, stamps stripped
run("publish", join(tmp, "studio"), join(tmp, "play.json"));
const play = JSON.parse(readFileSync(join(tmp, "play.json"), "utf8"));
assert.equal(play.maps[0].mwgEvents[0].pages[0].commands[0].say, "edited in studio");
assert.ok(!JSON.stringify(play).includes("originHash"), "studio stamps must not leak into Play");
assert.equal(play.database.actors[1].name, "Aria", "null slot of 1-based tables must survive");

// fresh conversion: Sign changed upstream too, Door and actor changed upstream
const fresh = structuredClone(manifest);
fresh.maps[0].mwgEvents[0].pages[0].commands[0].say = "changed in source";
fresh.maps[0].mwgEvents[1].pages[0].commands[0].say = "door updated";
fresh.database.actors[1].name = "Aria II";
writeFileSync(join(tmp, "fresh.json"), JSON.stringify(fresh));

// merge: edited Sign preserved + conflict reported, others updated, comparable
run("merge", join(tmp, "studio"), join(tmp, "fresh.json"), join(tmp, "merged"));
const report = JSON.parse(readFileSync(join(tmp, "merged", "merge-report.json"), "utf8"));
run("publish", join(tmp, "merged"), join(tmp, "merged-play.json"));
const merged = JSON.parse(readFileSync(join(tmp, "merged-play.json"), "utf8"));
assert.equal(merged.maps[0].mwgEvents[0].pages[0].commands[0].say, "edited in studio", "editor-modified must not be overwritten");
assert.equal(merged.maps[0].mwgEvents[1].pages[0].commands[0].say, "door updated");
assert.equal(merged.database.actors[1].name, "Aria II");
assert.ok(report.preserved.includes("event:1:1") && report.conflicts.some((c) => c.id === "event:1:1"), JSON.stringify(report));
assert.ok(report.updated.includes("event:1:2"), JSON.stringify(report));

// An event created in the editor (no converted baseline) must survive a merge.
{
  const mapPath = join(tmp, "studio", "maps", "map-1.json");
  const m = JSON.parse(readFileSync(mapPath, "utf8"));
  m.mwgEvents.push({ id: 99, name: "Created", x: 3, y: 3, pages: [{ commands: [{ say: "made in editor" }] }] });
  writeFileSync(mapPath, JSON.stringify(m, null, 2));
  run("merge", join(tmp, "studio"), join(tmp, "fresh.json"), join(tmp, "merged2"));
  const report2 = JSON.parse(readFileSync(join(tmp, "merged2", "merge-report.json"), "utf8"));
  run("publish", join(tmp, "merged2"), join(tmp, "merged2-play.json"));
  const merged2 = JSON.parse(readFileSync(join(tmp, "merged2-play.json"), "utf8"));
  assert.ok(merged2.maps[0].mwgEvents.some((e) => String(e.id) === "99" && e.pages[0].commands[0].say === "made in editor"),
    "editor-created event must survive reconversion");
  assert.ok(report2.preserved.includes("event:1:99"), JSON.stringify(report2));
}

const diffs = JSON.parse(run("compare", join(tmp, "play.json"), join(tmp, "merged-play.json")));
assert.ok(diffs.some((d) => d.id === "event:1:2") && diffs.some((d) => d.id === "db:actors:1"), JSON.stringify(diffs));
assert.ok(existsSync(join(tmp, "merged", "maps", "map-1.json")));
// Editor API: save through the real `edit` server must write the Studio file,
// flag the entity known-as-modified, and publish the edit.
import { spawn } from "node:child_process";
const port = 4600 + (process.pid % 300);
const editor = spawn(process.execPath, [TOOL, "edit", join(tmp, "studio"), "--port", String(port),
  "--publish-to", join(tmp, "editor-play.json")], { stdio: "ignore" });
try {
  const base = `http://127.0.0.1:${port}`;
  let studio = null;
  for (let i = 0; i < 50 && !studio; i++) {
    try { studio = await (await fetch(`${base}/api/studio`)).json(); } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  assert.ok(studio?.maps?.length, "editor API did not come up");
  const ev = studio.maps[0].events[0];
  assert.equal(ev.modified, true, "event edited earlier in this test must read as modified in the editor");
  const saved = await (await fetch(`${base}/api/save`, { method: "POST",
    body: JSON.stringify({ mapId: studio.maps[0].id, eventId: ev.id, path: ev.says[0].path, text: "saved through editor" }) })).json();
  assert.equal(saved.ok, true);
  const after = await (await fetch(`${base}/api/studio`)).json();
  assert.equal(after.maps[0].events[0].says[0].text, "saved through editor");
  // database names are player-visible too: listed and editable in the editor
  const actor = after.database.actors.rows.find((r) => r.name);
  assert.ok(actor, "database actors must be listed by the editor");
  const savedDb = await (await fetch(`${base}/api/save-db`, { method: "POST",
    body: JSON.stringify({ table: "actors", id: actor.id, field: "name", value: "Renamed" }) })).json();
  assert.equal(savedDb.ok, true);
  // event creation through the editor API
  const created = await (await fetch(`${base}/api/add-event`, { method: "POST",
    body: JSON.stringify({ mapId: after.maps[0].id, name: "NewGuy", x: 4, y: 4, text: "created in editor" }) })).json();
  assert.ok(created.id, JSON.stringify(created));
  // map itself is not modified until a tile is painted; then it must read modified
  assert.equal(after.maps[0].modified, false, "map with only an event edit must not read as map-modified");
  assert.equal(after.maps[0].tiles[0], 0);
  const tiled = await (await fetch(`${base}/api/save-tile`, { method: "POST",
    body: JSON.stringify({ mapId: after.maps[0].id, layer: 0, x: 0, y: 0, tile: 7 }) })).json();
  assert.equal(tiled.ok, true);
  const afterTile = await (await fetch(`${base}/api/studio`)).json();
  assert.equal(afterTile.maps[0].modified, true, "painted map must read as modified");
  assert.equal(afterTile.maps[0].tiles[0], 7);
  // Every player-visible command is editable, not only say: replace the wait,
  // add a transfer, move/rename the event, rename the map, move the start point.
  const savedCmd = await (await fetch(`${base}/api/save-command`, { method: "POST",
    body: JSON.stringify({ mapId: 1, eventId: ev.id, pageIndex: 0, index: 1, command: { wait: 42 } }) })).json();
  assert.equal(savedCmd.ok, true);
  const addedCmd = await (await fetch(`${base}/api/add-command`, { method: "POST",
    body: JSON.stringify({ mapId: 1, eventId: ev.id, command: { transfer: { mapId: 1, x: 0, y: 0 } } }) })).json();
  assert.equal(addedCmd.ok, true);
  const savedEv = await (await fetch(`${base}/api/save-event`, { method: "POST",
    body: JSON.stringify({ mapId: 1, eventId: ev.id, name: "Renamed sign", x: 0, y: 0 }) })).json();
  assert.equal(savedEv.ok, true);
  const savedMap = await (await fetch(`${base}/api/save-map`, { method: "POST",
    body: JSON.stringify({ mapId: 1, displayName: "Renamed map", tilesetId: 3 }) })).json();
  assert.equal(savedMap.ok, true);
  const savedPlayer = await (await fetch(`${base}/api/save-player`, { method: "POST",
    body: JSON.stringify({ mapId: 1, x: 1, y: 0 }) })).json();
  assert.equal(savedPlayer.ok, true);
  const savedFields = await (await fetch(`${base}/api/save-map-fields`, { method: "POST",
    body: JSON.stringify({ mapId: 1, fields: { encounterStep: 42 } }) })).json();
  assert.equal(savedFields.ok, true);
  const savedCommon = await (await fetch(`${base}/api/save-common`, { method: "POST",
    body: JSON.stringify({ id: "1", commands: [{ say: "common edited" }] }) })).json();
  assert.equal(savedCommon.ok, true);
  const savedIndex = await (await fetch(`${base}/api/save-index`, { method: "POST",
    body: JSON.stringify({ key: "display", value: { title: "Renamed game" } }) })).json();
  assert.equal(savedIndex.ok, true);
  await fetch(`${base}/api/publish`, { method: "POST", body: "{}" });
  assert.ok(readFileSync(join(tmp, "editor-play.json"), "utf8").includes("saved through editor"));
  const editorPlay = JSON.parse(readFileSync(join(tmp, "editor-play.json"), "utf8"));
  assert.equal(editorPlay.maps[0].data.data[0], 7, "painted tile must publish in the nested tile array the player reads");
  assert.deepEqual(editorPlay.maps[0].mwgEvents[0].pages[0].commands[1], { wait: 42 }, "edited non-say command must publish");
  assert.ok(editorPlay.maps[0].mwgEvents[0].pages[0].commands.some((c) => c.transfer), "added command must publish");
  assert.equal(editorPlay.maps[0].mwgEvents[0].name, "Renamed sign");
  assert.equal(editorPlay.maps[0].data.displayName, "Renamed map");
  assert.deepEqual(editorPlay.player, { mapId: 1, x: 1, y: 0 }, "moved player start must publish");
  assert.equal(editorPlay.maps[0].data.encounterStep, 42, "edited map properties must publish");
  assert.deepEqual(editorPlay.commonEvents, { "1": [{ say: "common edited" }] }, "edited common events must publish");
  assert.equal(editorPlay.display.title, "Renamed game", "edited manifest-level keys must publish");
} finally { editor.kill(); }

// Comparability covers every command, not only say: a changed wait must diff.
{
  const { compareManifests } = await import("./mwgp-studio.mjs");
  const changed = structuredClone(manifest);
  changed.maps[0].mwgEvents[0].pages[0].commands[1] = { wait: 99 };
  const diffsC = compareManifests(manifest, changed);
  assert.ok(diffsC.some((d) => d.id === "event:1:1"), JSON.stringify(diffsC));
}

// Generation from zero: the editor creates a converted project without any RPG Maker source.
// init writes the Studio skeleton (starter map, actor, class, tileset); the edit server grows it
// (new map, new database row, new event with its dialogue); publish ships a manifest the validator
// and the player accept. Proven playable in Chromium separately (boot PASS on a born project).
{
  const zero = join(tmp, "studio-zero");
  run("init", zero, "--title", "Né de zéro");
  assert.ok(existsSync(join(zero, "maps", "map-1.json")), "init ships the starter map");
  const zeroPlay = join(tmp, "zero-play.json");
  const port3 = 4700 + (process.pid % 90);
  const editor3 = spawn(process.execPath, [TOOL, "edit", zero, "--port", String(port3), "--publish-to", zeroPlay], { stdio: "ignore" });
  try {
    const base3 = `http://127.0.0.1:${port3}`;
    let up3 = null;
    for (let i = 0; i < 50 && !up3; i++) { try { up3 = await (await fetch(base3 + "/api/studio")).json(); } catch { await new Promise(r => setTimeout(r, 200)); } }
    assert.ok(up3?.maps?.length === 1, "the born project opens with its starter map");
    const post3 = async (path, body) => (await fetch(base3 + path, { method: "POST", body: JSON.stringify(body) })).json();
    assert.equal((await post3("/api/add-map", { name: "Caverne", width: 8, height: 8 })).id, 2, "a map can be created");
    assert.equal((await post3("/api/add-row", { table: "actors", row: { name: "Héroïne", classId: 1, initialLevel: 1, characterName: "", characterIndex: 0 } })).id, 2, "a database row can be created");
    assert.ok((await post3("/api/add-event", { mapId: 2, name: "Gardien", x: 1, y: 1, text: "Qui va là ?" })).id, "an event can be created on the new map");
    await post3("/api/publish", {});
  } finally { editor3.kill(); }
  const zeroManifest = JSON.parse(readFileSync(zeroPlay, "utf8"));
  assert.deepEqual(Object.keys(zeroManifest).slice(0, 2), ["format", "converter"], "a born manifest carries the converter stamp second");
  assert.equal(zeroManifest.maps.length, 2, "the created map joined the project");
  assert.equal(zeroManifest.database.actors[2]?.name, "Héroïne", "the created row keeps its id slot");
  assert.ok(JSON.stringify(zeroManifest.maps[1]).includes("Qui va là ?"), "the created event ships its dialogue");
  const zeroValidation = JSON.parse(execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "validate-mwgp.js"), zeroPlay], { encoding: "utf8" }));
  assert.equal(zeroValidation.valid, true, JSON.stringify(zeroValidation));
}

console.log("mwgp-studio test ok: lift/edit/publish/merge/compare, modified preserved, conflicts comparable, generation from zero");
