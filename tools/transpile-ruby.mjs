#!/usr/bin/env node
// Convert Ruby source with the vendored Ruby2JS self-host compiler.
// Ruby is not invoked for individual conversions.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { convert } from '../transpilers/ruby2js-master/demo/selfhost/ruby2js.js';
import Functions from '../transpilers/ruby2js-master/demo/selfhost/filters/functions.js';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error('Usage: node tools/transpile-ruby.mjs <input.rb> [output.js]');
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg || join(dirname(input), `${basename(input, extname(input))}.js`));
const source = await readFile(input, 'utf8');
const javascript = convert(source, { preset: true, eslevel: 2022, loose_break: true, filters: [Functions.prototype], file: input }).toString();
await writeFile(output, `${javascript}\n`);
console.log(`Transpiled ${input} -> ${output}`);
