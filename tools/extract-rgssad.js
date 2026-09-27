#!/usr/bin/env node
// Unpack an RPG Maker "RGSSAD" archive (Game.rgssad / Game.rgss3a) into a
// plain directory tree (Data/, Graphics/, Audio/, ...), so tools/convert-rgss.js
// and tools/transpile-rgss-scripts.mjs can operate on it like an extracted
// project. Version 1 (RGSSAD\0\x01: XP / Essentials, also VX's .rgss2a) is a
// front-to-back stream; version 3 (RGSSAD\0\x03: VX Ace's .rgss3a) is an entry
// table with absolute payload offsets. Both layouts below follow mkxp's
// src/rgssad.cpp (which ships real XP/VX/Ace games), not the v1-only path this
// tool used to implement alone.
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const [, , archiveArg, outputArg] = process.argv;
if (!archiveArg || !outputArg) {
  console.error('Usage: node tools/extract-rgssad.js <Game.rgssad|Game.rgss3a> <output directory>');
  process.exit(1);
}

const archivePath = resolve(archiveArg);
const outputDir = resolve(outputArg);

function advance(key) {
  return (Math.imul(key, 7) + 3) >>> 0;
}

const handle = await open(archivePath, 'r');
const { size } = await handle.stat();

let position = 8; // past "RGSSAD\0" + version byte
const header = Buffer.alloc(8);
await handle.read(header, 0, 8, 0);
if (header.toString('latin1', 0, 7) !== 'RGSSAD\0') {
  throw new Error(`${archivePath} is not an RGSSAD archive`);
}
if (header[7] !== 1 && header[7] !== 3) {
  throw new Error(`Unsupported RGSSAD version ${header[7]} (only versions 1 and 3 are supported)`);
}

// Payload decrypt shared by both versions: the payload is XORed against the
// little-endian bytes of the entry key, advancing it (*7+3) every 4 bytes.
function decryptPayload(data, startKey) {
  let entryKey = startKey >>> 0;
  for (let i = 0; i < data.length; i += 4) {
    const chunk = Math.min(4, data.length - i);
    for (let b = 0; b < chunk; b += 1) {
      data[i + b] ^= (entryKey >>> (8 * b)) & 0xff;
    }
    entryKey = advance(entryKey);
  }
}

async function readAt(length, offset) {
  const buf = Buffer.alloc(length);
  await handle.read(buf, 0, length, offset);
  return buf;
}

const entries = [];
if (header[7] === 3) {
  // Version 3 (VX Ace): an entry table with absolute payload offsets. The seed
  // at byte 8 derives one constant table key (seed*9+3); every u32 field is
  // XORed with it (no per-field advance, unlike v1) and the name cycles the
  // key's four bytes. A decrypted offset of 0 ends the table.
  const seed = (await readAt(4, 8)).readUInt32LE(0);
  const tableKey = (Math.imul(seed, 9) + 3) >>> 0;
  position = 12;
  for (;;) {
    const offset = ((await readAt(4, position)).readUInt32LE(0) ^ tableKey) >>> 0;
    position += 4;
    if (offset === 0) break;
    const fileSize = ((await readAt(4, position)).readUInt32LE(0) ^ tableKey) >>> 0;
    const entryKey = ((await readAt(4, position + 4)).readUInt32LE(0) ^ tableKey) >>> 0;
    const nameLen = ((await readAt(4, position + 8)).readUInt32LE(0) ^ tableKey) >>> 0;
    position += 12;
    if (nameLen === 0 || nameLen > 4096 || offset + fileSize > size) {
      throw new Error(`${archivePath} has a corrupt v3 entry (offset ${offset}, size ${fileSize}, name length ${nameLen})`);
    }
    const nameBuf = await readAt(nameLen, position);
    position += nameLen;
    for (let i = 0; i < nameLen; i += 1) nameBuf[i] ^= (tableKey >>> (8 * (i % 4))) & 0xff;
    entries.push({ name: nameBuf.toString('latin1').replaceAll('\\', '/'), offset, size: fileSize, key: entryKey });
  }
} else {
  let key = 0xDEADCAFE >>> 0;

  async function readUInt32() {
    const buf = Buffer.alloc(4);
    await handle.read(buf, 0, 4, position);
    position += 4;
    return buf.readUInt32LE(0);
  }

  while (position < size) {
    const rawNameLen = await readUInt32();
    const nameLen = (rawNameLen ^ key) >>> 0;
    key = advance(key);
    if (nameLen === 0 || nameLen > 4096) break;

    const nameBuf = Buffer.alloc(nameLen);
    await handle.read(nameBuf, 0, nameLen, position);
    position += nameLen;
    for (let i = 0; i < nameLen; i += 1) {
      nameBuf[i] ^= key & 0xff;
      key = advance(key);
    }
    const name = nameBuf.toString('latin1').replaceAll('\\', '/');

    const rawSize = await readUInt32();
    const fileSize = (rawSize ^ key) >>> 0;
    key = advance(key);

    entries.push({ name, offset: position, size: fileSize, key });
    position += fileSize;
  }
}

await mkdir(outputDir, { recursive: true });
for (const entry of entries) {
  const data = Buffer.alloc(entry.size);
  await handle.read(data, 0, entry.size, entry.offset);
  decryptPayload(data, entry.key);
  const target = join(outputDir, entry.name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

await handle.close();
console.log(`Extracted ${entries.length} files from ${archivePath} to ${outputDir}`);
