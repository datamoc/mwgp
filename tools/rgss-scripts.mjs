// Read the Ruby library an RGSS game ships: Data/Scripts.rxdata (XP), plus the
// Pokémon Essentials-style Data/PluginScripts.rxdata. In pure Node, no Ruby:
// the containers are Ruby Marshal arrays of [id, name, zlib(source)], whose
// strings must stay raw bytes (decodeMarshal in mw_games decodes them as text,
// which corrupts the zlib stream), so this carries its own minimal reader for
// exactly the types these files use.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

function readMarshal(buffer) {
  let pos = 2; // major, minor
  const symbols = [], objects = [];
  const byte = () => buffer[pos++];
  const long = () => {
    const c = (byte() << 24) >> 24;
    if (c === 0) return 0;
    if (c > 4) return c - 5;
    if (c < -4) return c + 5;
    let value = 0;
    if (c > 0) { for (let i = 0; i < c; i++) value |= byte() << (8 * i); return value; }
    value = -1;
    for (let i = 0; i < -c; i++) { value &= ~(0xff << (8 * i)); value |= byte() << (8 * i); }
    return value;
  };
  const bytes = () => { const n = long(); const out = buffer.subarray(pos, pos + n); pos += n; return out; };
  const symbol = () => { const s = bytes().toString('utf8'); symbols.push(s); return s; };
  const value = () => {
    const type = String.fromCharCode(byte());
    switch (type) {
      case '0': return null;
      case 'T': return true;
      case 'F': return false;
      case 'i': return long();
      case ':': return symbol();
      case ';': return symbols[long()];
      case 'I': { const inner = value(); for (let n = long(); n > 0; n--) { value(); value(); } return inner; }
      case '@': return objects[long()];
      case '"': { const out = Buffer.from(bytes()); objects.push(out); return out; }
      case '[': { const n = long(); const out = []; objects.push(out); for (let i = 0; i < n; i++) out.push(value()); return out; }
      case '{': { const n = long(); const out = new Map(); objects.push(out); for (let i = 0; i < n; i++) out.set(value(), value()); return out; }
      default: throw new Error(`unsupported Marshal type "${type}" at byte ${pos - 1}`);
    }
  };
  return value();
}

const inflate = bytes => inflateSync(bytes).toString('utf8');

// Returns [{ name, source }] in load order (Scripts first, then plugin scripts).
export async function readRgssScripts(dataDir) {
  const scripts = [];
  for (const file of ['Scripts.rxdata', 'PluginScripts.rxdata']) {
    let buffer;
    try { buffer = await readFile(join(dataDir, file)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of readMarshal(buffer)) {
      // Scripts.rxdata: [id, name, bytes]. PluginScripts.rxdata: [plugin, meta, [[name, bytes], ...]].
      if (Array.isArray(entry[2])) for (const [name, bytes] of entry[2]) scripts.push({ name: name.toString('utf8'), source: inflate(bytes) });
      else scripts.push({ name: entry[1].toString('utf8'), source: inflate(entry[2]) });
    }
  }
  return scripts;
}
