#!/usr/bin/env node
// Extract Ruby scripts from an XP/Essentials project and transpile them with
// the JavaScript Ruby2JS self-host compiler.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { convert } from '../transpilers/ruby2js-master/demo/selfhost/ruby2js.js';
import Functions from '../transpilers/ruby2js-master/demo/selfhost/filters/functions.js';

const [, , projectArg, outputArg] = process.argv;
if (!projectArg || !outputArg) {
  console.error('Usage: node tools/transpile-rgss-scripts.mjs <extracted RGSS project> <output directory>');
  process.exit(1);
}

const project = resolve(projectArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });

function decodeScripts(file) {
  const result = spawnSync('ruby', ['tools/read-rgss-scripts.rb', file], {
    cwd: resolve('.'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || `Ruby exited with ${result.status}`);
  return result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
}

const files = ['Scripts.rxdata', 'PluginScripts.rxdata'];
const index = [];
for (const fileName of files) {
  const file = join(project, 'Data', fileName);
  let entries;
  try { await readFile(file); entries = decodeScripts(file); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const group = basename(fileName, '.rxdata').toLowerCase();
  for (const entry of entries) {
    const safe = String(entry.name || `script-${entry.id}`).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || `script-${entry.id}`;
    const relative = join(group, `${String(entry.id).padStart(4, '0')}-${safe}.js`).replaceAll('\\', '/');
    const target = join(output, relative);
    const sourceRelative = relative.replace(/\.js$/i, '.rb');
    await mkdir(resolve(target, '..'), { recursive: true });
    let javascript, error = null;
    const source = Buffer.from(entry.source, 'base64').toString('utf8');
    try {
      javascript = convert(source, { preset: true, eslevel: 2022, loose_break: true, filters: [Functions.prototype], file: entry.name }).toString();
      try {
        // Ruby2JS output is normally a script fragment, so Function is an
        // appropriate syntax-only check without executing game code.
        new Function(javascript);
      } catch (syntaxError) {
        error = `generated JavaScript syntax: ${syntaxError.message}`;
        javascript = `// Ruby2JS generated invalid JavaScript for ${entry.name}\n// ${error}\n`;
      }
    } catch (cause) {
      javascript = `// Ruby2JS conversion failed for ${entry.name}\n// ${cause.message}\n`;
      error = cause.message;
    }
    await writeFile(target, `${javascript}\n`);
    await writeFile(join(output, sourceRelative), source);
    index.push({
      container: fileName,
      id: entry.id,
      name: entry.name,
      output: relative,
      source: sourceRelative,
      warnings: source.includes('break') ? ['Ruby break may be lowered to return outside a JavaScript loop'] : [],
      error
    });
  }
}
await writeFile(join(output, 'index.json'), JSON.stringify({
  format: 'MWGP-RubyJS',
  compiler: 'ruby2js-selfhost',
  options: { preset: true, eslevel: 2022, looseBreak: true, filter: 'Functions.prototype' },
  scripts: index
}, null, 2));
const failed = index.filter(entry => entry.error).length;
console.log(`Transpiled ${index.length} RGSS scripts (${failed} conversion failures) to ${output}`);
