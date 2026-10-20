// Synthetic LCF fixtures for tools/lcf.mjs (T124 foundation): build minimal
// LcfMapUnit / LcfMapTree binaries in memory and read them back.
import assert from "node:assert/strict";
import { parseLcf, parseMap, parseMapTree, readBer, writeBer } from "./lcf.mjs";

for (const value of [0, 1, 127, 128, 300, 16384, 200000]) {
  const encoded = writeBer(value);
  assert.equal(readBer(encoded, 0).value, value, `BER round-trip ${value}`);
}

const ber = writeBer;
const chunk = (id, data) => Buffer.concat([ber(id), ber(data.length), data]);
const intChunk = (id, value) => chunk(id, ber(value));
const stringChunk = (id, text) => chunk(id, Buffer.concat([ber(text.length), Buffer.from(text, "latin1")]));
const header = (magic) => Buffer.concat([ber(magic.length), Buffer.from(magic, "latin1")]);

// MapXXXX.lmu: 3x2 map, chipset 2, distinct lower/upper tiles, one event (id 5).
const lower = Buffer.alloc(12); [1, 2, 3, 4, 5, 6].forEach((tile, i) => lower.writeInt16LE(tile, i * 2));
const upper = Buffer.alloc(12); [0, 0, 7, 0, 0, 0].forEach((tile, i) => upper.writeInt16LE(tile, i * 2));
const event = Buffer.concat([ber(5), stringChunk(0x01, "NPC"), ber(0)]);
const mapBuffer = Buffer.concat([
  header("LcfMapUnit"),
  intChunk(0x01, 2), intChunk(0x02, 3), intChunk(0x03, 2),
  chunk(0x47, lower), chunk(0x48, upper), chunk(0x51, event), ber(0),
]);
const map = parseMap(mapBuffer);
assert.deepEqual({ width: map.width, height: map.height, chipsetId: map.chipsetId }, { width: 3, height: 2, chipsetId: 2 });
assert.deepEqual(map.lower, [1, 2, 3, 4, 5, 6]);
assert.deepEqual(map.upper, [0, 0, 7, 0, 0, 0]);
assert.deepEqual(map.eventIds, [5]);

// RPG_RT.lmt: two maps in the tree plus their display order.
const entry = (id, name, parentId) => Buffer.concat([ber(id), stringChunk(0x01, name), intChunk(0x02, parentId), ber(0)]);
const treeBuffer = Buffer.concat([
  header("LcfMapTree"),
  chunk(0x01, Buffer.concat([entry(1, "Town", 0), entry(2, "House", 1)])),
  chunk(0x02, Buffer.concat([ber(2), ber(0), ber(1), ber(2)])),
  ber(0),
]);
const tree = parseMapTree(treeBuffer);
assert.deepEqual(tree.maps, [{ id: 1, name: "Town", parentId: 0 }, { id: 2, name: "House", parentId: 1 }]);
assert.deepEqual(tree.order, [0, 1, 2]);
assert.equal(parseLcf(treeBuffer).magic, "LcfMapTree");

console.log("LCF reader: BER, map unit (tiles/events) and map tree parse on synthetic fixtures (ok)");
