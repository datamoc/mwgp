// The game's own Marshal data (`Data/*.dat` and RGSS database files) exported as JSON assets for the browser runtime.
// This gives transformed startup code the same `load_data` inputs as the source game, including map and system data.
// Ruby script archives are already transpiled and are excluded. Objects keep their Ruby class name and instance
// variables so the runtime can rebuild instances of the game's own transpiled classes; a Hash becomes
// `{ "$map": [[key, value], ...] }` so integer and string keys stay distinct.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rubySubclass } from './rgss-marshal.mjs';

export function encodeRubyValue(value) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $num: String(value) };
  if (typeof value === 'bigint') return { $num: String(value) };
  if (value?.[rubySubclass]) {
    const base = Array.isArray(value) ? value.map(encodeRubyValue) : value instanceof Map
      ? { $map: [...value].map(([key, item]) => [encodeRubyValue(key), encodeRubyValue(item)]) }
      : null;
    return { $rubySubclass: { ...value[rubySubclass], value: base, ivars: encodeRubyValue(value[rubySubclass].ivars) } };
  }
  if (value?.$rubySubclass) return { $rubySubclass: { ...value.$rubySubclass, value: encodeRubyValue(value.$rubySubclass.value), ivars: encodeRubyValue(value.$rubySubclass.ivars) } };
  if (value instanceof Map) return { $map: [...value].map(([key, item]) => [encodeRubyValue(key), encodeRubyValue(item)]) };
  if (Array.isArray(value)) return value.map(encodeRubyValue);
  if (value instanceof Uint8Array || (value?.type === 'Buffer' && Array.isArray(value.data))) return { $bytes: Buffer.from(value.data || value).toString('base64') };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeRubyValue(item)]));
  return null;
}

// Every Marshal data file that decodes becomes `<outDir>/<file>.json`; returns the file names written.
export async function exportRubyData(dataDir, outDir, decodeMarshal, log = () => {}) {
  const written = [];
  let names;
  try {
    names = (await readdir(dataDir))
      .filter(name => /\.(?:dat|rxdata|rvdata|rvdata2)$/i.test(name))
      .filter(name => !/^(?:Plugin)?Scripts\.(?:rxdata|rvdata|rvdata2)$/i.test(name))
      .sort();
  } catch { return written; }
  await mkdir(outDir, { recursive: true });
  for (const name of names) {
    try {
      const json = JSON.stringify(encodeRubyValue(decodeMarshal(await readFile(join(dataDir, name)))));
      await writeFile(join(outDir, `${name}.json`), json);
      written.push(name);
    } catch (error) { log(`cannot export ${name}: ${error.message}`); }
  }
  return written;
}

// A listing of the project's own files (Graphics/, Audio/, Data/, ...) as forward-slash relative paths, so the runtime can
// answer `File.exist?`, `Dir.exist?`, `Dir.glob` and `Dir.entries` without a file system. Original case is kept;
// lookups are case-insensitive like the Windows file system the game was made on.
export async function buildFileIndex(root, folders = ['Graphics', 'Audio', 'Data', 'PBS', 'Fonts']) {
  const files = [];
  const walk = async (absolute, relative) => {
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(absolute, entry.name), next);
      else files.push(next);
    }
  };
  for (const folder of folders) await walk(join(root, folder), folder);
  return files.sort();
}

// Small text files the game reads with `File.read` (bitmap-font descriptors, CSV/JSON/INI/TXT tables): embedded so the
// runtime can answer synchronously. Bounded per file and in total.
export async function readTextFiles(root, index, { extensions = /[.](xml|fnt|txt|json|csv|ini|cfg)$/i, maxFile = 256 * 1024, maxTotal = 2 * 1024 * 1024 } = {}) {
  const out = {};
  let total = 0;
  for (const path of index) {
    if (!extensions.test(path) || /^Audio[/]/i.test(path)) continue;
    try {
      const text = await readFile(join(root, path), 'utf8');
      if (text.length > maxFile || total + text.length > maxTotal) continue;
      out[path] = text; total += text.length;
    } catch { /* unreadable: skipped */ }
  }
  return out;
}
