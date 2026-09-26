// Builds the manifest's `audio` section from a converted project's assets/audio tree:
//   { root, index: { bgm: { "Name": ".ogg" }, bgs: {...}, me: {...}, se: {...} }, system: {...} }
// so the player resolves each track to the file that really exists, whatever its format
// (MV/MZ decode to .ogg/.m4a; XP/VX/Ace ship any of .ogg/.mp3/.wav/.mid/.wma). Names use the
// path relative to the kind directory without extension ("Sub/Name" for nested files), as
// events reference them. When one name exists in several formats the best browser-playable
// one wins (see chooseExtension); files browsers cannot decode (.mid/.wma) stay indexed so the
// player can say so instead of reporting a missing file.
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { AUDIO_KINDS, chooseExtension } from '../src/player/audio-manager.js';

function scan(directory, prefix = '', found = new Map()) {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) { scan(join(directory, entry.name), `${prefix}${entry.name}/`, found); continue; }
    const extension = extname(entry.name);
    if (!extension) continue;
    const name = `${prefix}${entry.name.slice(0, -extension.length)}`;
    if (!found.has(name)) found.set(name, []);
    found.get(name).push(extension);
  }
  return found;
}

export function buildAudioIndex(audioRoot) {
  const index = {};
  for (const kind of AUDIO_KINDS) {
    const found = scan(join(audioRoot, kind));
    index[kind] = Object.fromEntries([...found].map(([name, extensions]) => [name, chooseExtension(extensions)]));
  }
  return index;
}

// Every name the index cannot resolve, for a conversion-time warning.
export function missingAudio(index, references) {
  const missing = [];
  for (const { kind, name } of references) if (name && index[kind] && !(name in index[kind])) missing.push(`${kind}/${name}`);
  return [...new Set(missing)];
}
