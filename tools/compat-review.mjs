// Compatibility banner review: summarizes each manifest's compatibility report
// (unsupported/partial command codes, RGSS/MV script failures) plus a count of
// loud `unsupported` vocabulary markers in the converted events. Used by the
// weekly reconversion review; see docs/play-checklist.md.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'MWGP_versions';
if (!existsSync(root)) {
  console.error(`usage: node tools/compat-review.mjs [MWGP_versions-dir]`);
  process.exit(2);
}

const summarizeCommands = (commands) => {
  const pick = (status) => Object.entries(commands ?? {})
    .filter(([, v]) => (v?.status ?? v) === status)
    .map(([k, v]) => `${k}(${v?.count ?? '?'})`);
  return { unsupported: pick('unsupported'), partial: pick('partial') };
};

// Generic walk: finds every { unsupported: ... } marker wherever it nests.
const countMarkers = (manifest) => {
  let count = 0;
  const kinds = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'unsupported') {
          count++;
          const key = JSON.stringify(v);
          kinds.set(key, (kinds.get(key) ?? 0) + 1);
        }
        walk(v);
      }
    }
  };
  walk(manifest);
  return { count, kinds: [...kinds.entries()].map(([k, n]) => `${k}x${n}`) };
};

for (const name of readdirSync(root).sort()) {
  const file = join(root, name, 'mwgp.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const cmds = summarizeCommands(manifest.compatibility?.commands);
  const scripts = manifest.compatibility?.scripts ?? {};
  const failed = scripts.libraryFailed ?? scripts.failed ?? [];
  const partial = scripts.libraryPartial ?? scripts.partial ?? [];
  const markers = countMarkers(manifest);
  console.log(`=== ${name} ===`);
  console.log(`  unsupported commands: ${cmds.unsupported.join(' ') || '(none)'}`);
  console.log(`  partial commands: ${cmds.partial.join(' ') || '(none)'}`);
  console.log(`  failed library units: ${(failed.map?.((u) => u.name ?? u) ?? []).join(' ') || '(none)'}`);
  console.log(`  partial library units: ${(partial.map?.((u) => u.name ?? u) ?? []).join(' ') || '(none)'}`);
  console.log(`  unsupported event markers: ${markers.count}${markers.kinds.length ? ` [${markers.kinds.join(', ')}]` : ''}`);
}
