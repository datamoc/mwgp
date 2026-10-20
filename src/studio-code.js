// Keeps the JavaScript the player runs in step with the Ruby an XP/VX/Ace event
// script was written in. The manifest stores both for every Call Script
// (`{ script, js, async?, error? }`) and Conditional Branch script
// (`{ source, js, error? }`); the player runs `js`, so a Studio edit of the Ruby
// does nothing until `js` is regenerated from it. `js`, `async` and `error` are
// derived from the Ruby; only the Ruby is the edit.
//
// Rule: a snippet is recompiled when its Ruby differs from the baseline's at the
// same path and its `js` is still the baseline's (a hand-edited `js` is kept, the
// editor wrote it on purpose). MV/MZ scripts carry no `js` and are not touched.
//
// The transpiler (the vendored Ruby2JS build) loads only when a Ruby text changed.
const isRubyNode = node => node && typeof node === 'object' && !Array.isArray(node) && node.mv !== true
  && (typeof node.script === 'string' || typeof node.source === 'string')
  && (typeof node.js === 'string' || typeof node.error === 'string');
const rubyOf = node => typeof node.script === 'string' ? node.script : node.source;
const kindOf = node => typeof node.script === 'string' ? 'call' : 'cond';

function collect(value, path, out) {
  if (Array.isArray(value)) value.forEach((item, index) => collect(item, `${path}/${index}`, out));
  else if (value && typeof value === 'object') {
    if (isRubyNode(value)) out.push({ node: value, path });
    for (const key of Object.keys(value)) if (value[key] && typeof value[key] === 'object') collect(value[key], `${path}/${key}`, out);
  }
}

const at = (root, path) => path.split('/').slice(1).reduce((value, key) => value?.[key], root);

// Regenerates the derived fields of every Ruby script whose source changed
// against `base`. Mutates and returns `manifest`; `report` lists what happened.
export async function recompileScripts(manifest, base) {
  const report = { recompiled: [], failed: [], keptHandEdit: [] };
  const found = [];
  collect(manifest.maps, '/maps', found);
  collect(manifest.database, '/database', found);
  const stale = [];
  for (const entry of found) {
    const before = base ? at(base, entry.path) : null;
    if (before && isRubyNode(before) && rubyOf(before) === rubyOf(entry.node)) continue;
    if (before && isRubyNode(before) && typeof entry.node.js === 'string' && before.js !== entry.node.js) { report.keptHandEdit.push(entry.path); continue; }
    stale.push(entry);
  }
  if (!stale.length) return { manifest, report };

  const library = manifest.rubyLibrary ?? {};
  const toolsUrl = new URL('../tools/', import.meta.url).href;
  const { transpileSnippet, setInterpreterMethods } = await import(`${toolsUrl}rgss-snippet.mjs`);
  const { setKnownMethods } = await import(`${toolsUrl}rgss-call-filter.mjs`);
  setInterpreterMethods(library.interpreterMethods);
  // The manifest lists def names without their `?`/`!` suffix; the call filter compares the raw
  // names, so both forms are offered (measured: all 1699 Void scripts then recompile to their stored js).
  if (library.methods) setKnownMethods([...library.methods, ...library.methods.map(name => `${name}?`), ...library.methods.map(name => `${name}!`)]);

  const compiled = stale.map(entry => ({ entry, result: transpileSnippet(rubyOf(entry.node), kindOf(entry.node)) }));
  // Statement scripts that wait on frames become async, like at conversion; conditions stay synchronous.
  const toLift = compiled.filter(item => !item.result.error && kindOf(item.entry.node) === 'call');
  let lifted = [];
  if (toLift.length) {
    const { liftBlocking } = await import(`${toolsUrl}rgss-async.mjs`);
    lifted = liftBlocking(library.units ?? {}, toLift.map(item => ({ js: item.result.js })), { knownMethods: library.methods }).snippets;
  }
  for (const item of compiled) {
    const { node } = item.entry;
    delete node.async;
    if (item.result.error) {
      node.error = item.result.error;
      delete node.js;
      report.failed.push({ path: item.entry.path, error: item.result.error });
      continue;
    }
    delete node.error;
    const index = toLift.indexOf(item);
    node.js = index >= 0 ? lifted[index].js : item.result.js;
    if (index >= 0 && lifted[index].async) node.async = true;
    report.recompiled.push(item.entry.path);
  }
  return { manifest, report };
}
