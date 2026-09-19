#!/usr/bin/env node
// Unpack an RPG Maker XP/VX "RGSSAD" version-1 archive (Game.rgssad) into a
// plain directory tree (Data/, Graphics/, Audio/, ...), so tools/convert-rgss.js
// and tools/transpile-rgss-scripts.mjs can operate on it like an extracted
// project. Only version 1 (RGSSAD\0\x01, used by RPG Maker XP / Essentials) is
// supported; VX/VX Ace's version-3 RGSS3AD/.rvdata2 layout is out of scope.
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const [, , archiveArg, outputArg] = process.argv;
if (!archiveArg || !outputArg) {
  console.error('Usage: node tools/extract-rgssad.js <Game.rgssad> <output directory>');
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
if (header[7] !== 1) {
  throw new Error(`Unsupported RGSSAD version ${header[7]} (only version 1 is supported)`);
}

let key = 0xDEADCAFE >>> 0;
const entries = [];

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

await mkdir(outputDir, { recursive: true });
for (const entry of entries) {
  const data = Buffer.alloc(entry.size);
  await handle.read(data, 0, entry.size, entry.offset);
  let entryKey = entry.key;
  for (let i = 0; i < entry.size; i += 4) {
    const chunk = Math.min(4, entry.size - i);
    for (let b = 0; b < chunk; b += 1) {
      data[i + b] ^= (entryKey >>> (8 * b)) & 0xff;
    }
    entryKey = advance(entryKey);
  }
  const target = join(outputDir, entry.name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

await handle.close();
console.log(`Extracted ${entries.length} files from ${archivePath} to ${outputDir}`);
