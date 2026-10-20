// Index encrypted archives once, then decrypt only the requested entry. A
// multi-gigabyte archive is never expanded wholesale into JavaScript memory.
import { archiveEntryPath, decryptPayload, indexRgssArchive } from '../../tools/rgss-archive.mjs';
import { mkdir, open, registerFile, sourceEntry } from './fs.js';

export async function extractRgssArchive(archivePath, outputDir) {
  const handle = await open(archivePath, 'r');
  const archive = sourceEntry(archivePath).blob;
  try {
    const entries = await indexRgssArchive(handle, archive.size, archivePath);
    await mkdir(outputDir);
    for (const entry of entries) {
      registerFile(archiveEntryPath(outputDir, entry.name), {
        blob: archive.slice(entry.offset, entry.offset + entry.size), size: entry.size,
        decrypt: bytes => decryptPayload(bytes, entry.key),
      });
    }
    return entries.length;
  } finally { await handle.close(); }
}
