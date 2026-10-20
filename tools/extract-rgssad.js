#!/usr/bin/env node
// Shared v1/v3 archive reader, also used by the browser converter.
import { resolve } from 'node:path';
import { extractRgssArchive } from './rgss-archive.mjs';
const [, , archiveArg, outputArg] = process.argv;
if (!archiveArg || !outputArg) {
  console.error('Usage: node tools/extract-rgssad.js <Game.rgssad|Game.rgss2a|Game.rgss3a> <output directory>');
  process.exit(1);
}
const count = await extractRgssArchive(resolve(archiveArg), resolve(outputArg));
console.log(`Extracted ${count} files from ${archiveArg} to ${outputArg}`);
