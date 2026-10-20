// The converter's own version, stamped into every MWGP manifest so a manifest made by an older converter can be told
// apart from a current one without parsing it (they run to tens of megabytes).
//
// The version is the package version. It is written as the second key of mwgp.json, right after "format", so
// `readManifestConverterVersion` needs only the first few hundred bytes of the file. A manifest without the stamp was
// made before 0.2.0, which is also when converter bugs changed the output (command 322 stored as a profile, 333/334
// read as enemy TP / state), so "no stamp" counts as stale.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

export const CONVERTER_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const parts = version => String(version).split('.').map(part => Number.parseInt(part, 10) || 0);

// -1 / 0 / 1 like a comparator, on dotted numeric versions ("0.2.0" < "0.10.0").
export function compareVersions(left, right) {
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// The stamped converter version of a manifest file, or null when it carries none (or is not readable).
export function readManifestConverterVersion(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const buffer = Buffer.alloc(1024);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytes).match(/"converter"\s*:\s*\{\s*"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  } catch { return null; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

// The release that last changed what the converter writes. Bump this (not just the package version) whenever a
// conversion fix or a new command changes existing manifests' meaning; a manifest stamped older is stale.
export const LAST_OUTPUT_CHANGE = '0.2.2';

export const isStaleConverterVersion = version => version === null || version === undefined || compareVersions(version, LAST_OUTPUT_CHANGE) < 0;
