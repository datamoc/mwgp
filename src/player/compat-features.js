// Per-feature compatibility report (T128): rolls the manifest's
// compatibility.commands / .plugins / .scripts into feature areas (battles,
// menus, scripts, plugins, pictures, audio, RGSS units, ...) so the launch
// banner names the concrete remaining gap instead of raw command counts.
// Pure ESM with no DOM access: the browser banner and tools/test-smoke.mjs
// share it. Any counted command code with no area lands in "other events" —
// never silently dropped.
export const FEATURE_AREAS = [
  { key: 'battles', label: 'Battles', codes: [301, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 342, 283, 601, 602, 603, 604] },
  { key: 'menus', label: 'Menus', codes: [302, 303, 351, 352, 353, 354, 134, 135, 136, 137, 138] },
  { key: 'messages', label: 'Messages & choices', codes: [101, 102, 103, 104, 105, 401, 402, 403, 404, 405] },
  { key: 'scripts', label: 'Event scripts', codes: [355] },
  { key: 'plugins', label: 'Plugins', codes: [356, 357] },
  { key: 'pictures', label: 'Pictures', codes: [231, 232, 233, 234, 235, 236] },
  { key: 'audio', label: 'Audio', codes: [241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 132, 133, 139, 140] },
  { key: 'movement', label: 'Movement & map', codes: [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 215, 216, 217, 281, 282, 284, 285, 509] },
  { key: 'screen', label: 'Screen effects', codes: [212, 213, 221, 222, 223, 224, 225, 226, 236, 261] },
  { key: 'party', label: 'Party, inventory & actors', codes: [125, 126, 127, 128, 129, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326] },
  { key: 'state', label: 'Switches, variables & flow', codes: [0, 106, 108, 111, 112, 113, 115, 116, 117, 118, 119, 121, 122, 123, 124, 211, 214, 230, 408, 411, 412, 413, 505, 605, 655] },
];

const areaOf = new Map();
for (const area of FEATURE_AREAS) for (const code of area.codes) areaOf.set(String(code), area.key);

// Names are capped per bucket so one game's library cannot flood the banner;
// the counts stay exact.
const nameList = (names, cap = 3) => names.length <= cap ? names.join(', ') : `${names.slice(0, cap).join(', ')} +${names.length - cap} more`;

// compatibility: the manifest's compatibility object ({ commands, plugins, scripts }).
// Returns one entry per area with uses, or [] when the area is fully supported
// (or unused): the banner only names areas with a concrete remaining gap.
export function featureReport(compatibility = {}) {
  const commands = compatibility.commands || {};
  const plugins = compatibility.plugins || {};
  const scripts = compatibility.scripts || {};
  const buckets = new Map();
  const bucket = key => buckets.get(key) || buckets.set(key, { gaps: [], uses: 0, status: 'supported' }).get(key);
  const worse = (area, status) => { if (status === 'unsupported') area.status = 'unsupported'; else if (status === 'partial' && area.status === 'supported') area.status = 'partial'; };
  for (const [code, entry] of Object.entries(commands)) {
    if (!entry || !(entry.count > 0)) continue;
    const area = bucket(areaOf.get(String(code)) || 'other');
    area.uses += entry.count;
    worse(area, entry.status);
    if (entry.status === 'partial' || entry.status === 'unsupported') area.gaps.push(`${code}×${entry.count}`);
  }
  const pluginArea = bucket('plugins');
  for (const [name, entry] of Object.entries(plugins)) {
    if (!entry || !(entry.count > 0)) continue;
    pluginArea.uses += entry.count;
    worse(pluginArea, entry.status);
    if (entry.status === 'partial' || entry.status === 'unsupported') pluginArea.gaps.push(`${name}×${entry.count}`);
  }
  const scriptArea = bucket('scripts');
  for (const failure of scripts.failed || []) {
    const source = typeof failure === 'string' ? failure : failure.ruby || failure.error || 'unknown';
    scriptArea.uses += 1;
    scriptArea.status = 'unsupported';
    scriptArea.gaps.push(`script: ${String(source).slice(0, 60)}`);
  }
  const rgssArea = bucket('rgss');
  for (const failure of scripts.libraryFailed || []) {
    rgssArea.uses += 1;
    rgssArea.status = 'unsupported';
    rgssArea.gaps.push(`unit ${failure.name || 'unknown'}`);
  }
  for (const partial of scripts.libraryPartial || []) {
    rgssArea.uses += 1;
    if (rgssArea.status === 'supported') rgssArea.status = 'partial';
    rgssArea.gaps.push(`unit ${partial.name || 'unknown'} (partial)`);
  }
  const labels = new Map([['other', 'Other events'], ['plugins', 'Plugins'], ['scripts', 'Event scripts'], ['rgss', 'RGSS library units']]);
  const report = [];
  for (const [key, area] of buckets) {
    if (area.status === 'supported' || area.uses === 0) continue;
    const label = FEATURE_AREAS.find(candidate => candidate.key === key)?.label || labels.get(key) || key;
    report.push({ area: key, label, status: area.status, uses: area.uses, gaps: area.gaps });
  }
  report.sort((a, b) => b.uses - a.uses);
  return report;
}

// One honest line per gapped area, most-used first.
export function featureLines(report) {
  return report.map(entry => `${entry.label}: ${entry.status} (${nameList(entry.gaps, 4)})`);
}
