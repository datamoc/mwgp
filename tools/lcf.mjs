// LCF reader foundation for RPG Maker 2000/2003 support (T124).
//
// LCF is the binary container of RPG_RT projects: RPG_RT.ldb (database),
// RPG_RT.lmt (map tree) and MapXXXX.lmu (one map each). Every file starts
// with a BER-varint length-prefixed magic string ("LcfDataBase",
// "LcfMapTree", "LcfMapUnit"), then a sequence of chunks:
//   chunk := id:BER length:BER content[length], terminated by id 0.
// Integers inside chunk content are BER varints; strings are a BER length
// followed by raw bytes (Shift-JIS in Japanese projects, kept raw here and
// decoded as latin1 so no byte is ever lost); map tile layers are raw
// little-endian int16 arrays.
//
// This module only reads. Converting a parsed project into a playable MWGP
// manifest still needs a chipset renderer in the player; until then
// convert-auto reports 2000/2003 projects distinctly instead of mistaking
// them for something else.

export function readBer(buffer, offset) {
  let value = 0, cursor = offset;
  for (;;) {
    if (cursor >= buffer.length) throw new Error("LCF: truncated BER integer");
    const byte = buffer[cursor++];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { value, next: cursor };
}

export function writeBer(value) {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

function readChunks(buffer, start, end) {
  const chunks = [];
  let cursor = start;
  while (cursor < end) {
    const id = readBer(buffer, cursor); cursor = id.next;
    if (id.value === 0) break;
    const length = readBer(buffer, cursor); cursor = length.next;
    if (cursor + length.value > end) throw new Error(`LCF: chunk ${id.value} overruns its parent`);
    chunks.push({ id: id.value, data: buffer.subarray(cursor, cursor + length.value) });
    cursor += length.value;
  }
  return chunks;
}

export function parseLcf(buffer) {
  const magicLength = readBer(buffer, 0);
  const magic = buffer.subarray(magicLength.next, magicLength.next + magicLength.value).toString("latin1");
  return { magic, chunks: readChunks(buffer, magicLength.next + magicLength.value, buffer.length) };
}

export const chunkInt = (chunk) => (chunk ? readBer(chunk.data, 0).value : 0);
export const chunkString = (chunk) => {
  if (!chunk) return "";
  const length = readBer(chunk.data, 0);
  return chunk.data.subarray(length.next, length.next + length.value).toString("latin1");
};
export const findChunk = (chunks, id) => chunks.find((chunk) => chunk.id === id);

// Keyed record lists (map events, map-tree entries): per record, its id
// (BER), then its chunks, closed by a zero chunk id. No length wrapper.
export function readKeyedEntries(data) {
  const entries = [];
  let cursor = 0;
  while (cursor < data.length) {
    const id = readBer(data, cursor); cursor = id.next;
    const chunks = [];
    while (cursor < data.length) {
      const chunkId = readBer(data, cursor); cursor = chunkId.next;
      if (chunkId.value === 0) break;
      const length = readBer(data, cursor); cursor = length.next;
      chunks.push({ id: chunkId.value, data: data.subarray(cursor, cursor + length.value) });
      cursor += length.value;
    }
    entries.push({ id: id.value, chunks });
  }
  return entries;
}

// One MapXXXX.lmu: dimensions, chipset, the two tile layers and event ids.
export function parseMap(buffer) {
  const { magic, chunks } = parseLcf(buffer);
  if (magic !== "LcfMapUnit") throw new Error(`LCF: expected LcfMapUnit, got ${magic}`);
  const width = chunkInt(findChunk(chunks, 0x02)), height = chunkInt(findChunk(chunks, 0x03));
  const layer = (id) => {
    const chunk = findChunk(chunks, id);
    if (!chunk) return [];
    const tiles = [];
    for (let i = 0; i + 1 < chunk.data.length; i += 2) tiles.push(chunk.data.readInt16LE(i));
    return tiles;
  };
  const eventsChunk = findChunk(chunks, 0x51);
  const eventIds = eventsChunk ? readKeyedEntries(eventsChunk.data).map((entry) => entry.id) : [];
  return { width, height, chipsetId: chunkInt(findChunk(chunks, 0x01)), lower: layer(0x47), upper: layer(0x48), eventIds };
}

// RPG_RT.lmt: the map tree (names and parentage shown in the editor).
export function parseMapTree(buffer) {
  const { magic, chunks } = parseLcf(buffer);
  if (magic !== "LcfMapTree") throw new Error(`LCF: expected LcfMapTree, got ${magic}`);
  const mapsChunk = findChunk(chunks, 0x01);
  const maps = mapsChunk ? readKeyedEntries(mapsChunk.data).map((entry) => ({
    id: entry.id, name: chunkString(findChunk(entry.chunks, 0x01)), parentId: chunkInt(findChunk(entry.chunks, 0x02)),
  })) : [];
  const orderChunk = findChunk(chunks, 0x02);
  const order = [];
  if (orderChunk) for (let cursor = readBer(orderChunk.data, 0).next; cursor < orderChunk.data.length;) { const item = readBer(orderChunk.data, cursor); order.push(item.value); cursor = item.next; }
  return { maps, order };
}

export const isLcfProject = (names) => names.includes("RPG_RT.ldb") && names.includes("RPG_RT.exe");
