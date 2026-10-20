#!/usr/bin/env node
// MWGP command line, as installed from npm. Every command forwards to the
// project's own scripts, with the caller's working directory and arguments.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const commands = {
  serve: 'src/server.js',
  start: 'src/server.js',
  scan: 'src/server.js',
  'convert-mv': 'tools/convert-mv.js',
  'convert-rgss': 'tools/convert-rgss.js',
  'convert-auto': 'tools/convert-auto.js',
  studio: 'tools/mwgp-studio.mjs',
  validate: 'tools/validate-mwgp.js',
};
const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h' || !commands[command]) {
  console.log(`MWGP — RPG Maker games in the browser

Usage:
  mwgp serve                        Local launcher and Studio server
  mwgp convert-mv <project> <out>   Convert an MV/MZ project to MWGP
  mwgp convert-rgss <project> <out> Convert an XP/VX/Ace project to MWGP
  mwgp convert-auto <src> <dst>     Convert every game in a folder
  mwgp studio lift|publish|merge|compare|edit …
  mwgp validate <mwgp.json>         Validate a converted manifest`);
  process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0);
}
const args = command === 'scan' ? [join(root, commands[command]), '--scan'] : [join(root, commands[command]), ...rest];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
