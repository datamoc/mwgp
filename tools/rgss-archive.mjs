import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

function advance(key) { return (Math.imul(key, 7) + 3) >>> 0; }

export function decryptPayload(data, startKey) {
  let entryKey = startKey >>> 0;
  for (let i = 0; i < data.length; i += 4) {
    const chunk = Math.min(4, data.length - i);
    for (let b = 0; b < chunk; b += 1) {
      data[i + b] ^= (entryKey >>> (8 * b)) & 0xff;
    }
    entryKey = advance(entryKey);
  }
}


export async function indexRgssArchive(handle, size, archivePath = "archive") {
  let position = 8; // past "RGSSAD\0" + version byte
  const header = await readAt(8, 0);
  if (header.toString('latin1', 0, 7) !== 'RGSSAD\0') {
    throw new Error(`${archivePath} is not an RGSSAD archive`);
  }
  if (header[7] !== 1 && header[7] !== 3) {
    throw new Error(`Unsupported RGSSAD version ${header[7]} (only versions 1 and 3 are supported)`);
  }

  async function readAt(length, offset) {
    if (offset < 0 || length < 0 || offset + length > size) throw new Error(`${archivePath} is truncated at byte ${offset}`);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new Error(`${archivePath} is truncated at byte ${offset}`);
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
      const buf = await readAt(4, position);
      position += 4;
      return buf.readUInt32LE(0);
    }

    while (position < size) {
      const rawNameLen = await readUInt32();
      const nameLen = (rawNameLen ^ key) >>> 0;
      key = advance(key);
      if (nameLen === 0 || nameLen > 4096) throw new Error(`${archivePath} has an invalid entry name length ${nameLen}`);

      const nameBuf = await readAt(nameLen, position);
      position += nameLen;
      for (let i = 0; i < nameLen; i += 1) {
        nameBuf[i] ^= key & 0xff;
        key = advance(key);
      }
      const name = nameBuf.toString('latin1').replaceAll('\\', '/');

      const rawSize = await readUInt32();
      const fileSize = (rawSize ^ key) >>> 0;
      key = advance(key);
      if (position + fileSize > size) throw new Error(`${archivePath} has a truncated entry: ${name}`);

      entries.push({ name, offset: position, size: fileSize, key });
      position += fileSize;
    }
  }
  return entries;
}

export function archiveEntryPath(root, name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive entry: ${name}`);
  }
  const target = resolve(root, name);
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`Archive entry escapes output: ${name}`);
  return target;
}

export async function extractRgssArchive(archivePath, outputDir) {
  const handle = await open(archivePath, 'r');
  try {
    const { size } = await handle.stat();
    const entries = await indexRgssArchive(handle, size, archivePath);
    await mkdir(outputDir, { recursive: true });
    for (const entry of entries) {
      const target = archiveEntryPath(outputDir, entry.name);
      const data = Buffer.alloc(entry.size);
      const { bytesRead } = await handle.read(data, 0, entry.size, entry.offset);
      if (bytesRead !== entry.size) throw new Error(`Truncated archive entry: ${entry.name}`);
      decryptPayload(data, entry.key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    return entries.length;
  } finally { await handle.close(); }
}
