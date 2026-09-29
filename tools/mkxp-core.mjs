// Pinned web build of the unmerged mkxp-z libretro port (white-axe/mkxp-z-libretro-emscripten).
// GitHub Pages may move; hashes pin the actual bytes and refuse a changed upstream build.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_SOURCE = 'https://white-axe.github.io/mkxp-z-libretro-emscripten/nostalgist-aetherion/';
export const CORE_REVISION = 'f0a1ff80f05dd0d1f8ca711485a5b0a601bc7502';
export const CORE_FILES = {
  'mkxp-z_libretro.js': '32cc06deabe4a37426245142067379e262e9efcc3289be918e42ceb3759138a1',
  'mkxp-z_libretro.wasm': '9eb318ba1e8691fbf155d879c0f63df4a85cf295342a2ec93ad653b1636a8f7a'
};
export const CORE_CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'mkxp-z');

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function ensureCore(cache = CORE_CACHE) {
  await mkdir(cache, { recursive: true });
  for (const [name, expected] of Object.entries(CORE_FILES)) {
    const target = join(cache, name);
    if (existsSync(target) && await sha256(target) === expected) continue;
    const response = await fetch(CORE_SOURCE + name);
    if (!response.ok) throw new Error(`mkxp-z core download ${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`mkxp-z core hash mismatch for ${name}: expected ${expected}, got ${actual}`);
    const temp = `${target}.${process.pid}.tmp`;
    try { await writeFile(temp, bytes); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
  }
  return cache;
}
