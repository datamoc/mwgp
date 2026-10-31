// Importing a save made by RPG Maker itself (MV `.rpgsave`, MZ `.rmmzsave`)
// into an MWGP slot: the engine's Continue function, for a save the MWGP
// player did not write. MV saves are LZString-base64 JSON; MZ saves are
// zlib-deflated JSON (base64 on the web, a UTF-8-mangled binary string in a
// local file). Decoded, both are the same object
// (`{ system, switches, variables, selfSwitches, actors, party, map, player }`),
// which `convertEngineSave` maps onto the player's own save state
// (`{ mapId, x, y, facing, rpg, extra }`, the shape `loadGame` reads).
// Anything the player does not model (screen, timer, plugin state inside
// the engine objects) is dropped loudly by omission, never invented.

const LZ_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

// LZString.decompressFromBase64 (the codec MV's StorageManager writes with),
// reimplemented from the format: a bit stream over the base64 alphabet, a
// dictionary of phrases, 8/16-bit literal markers for fresh characters.
export function lzDecompressFromBase64(input) {
  if (!input) return null;
  const text = String(input).replace(/[^A-Za-z0-9+/=]/g, '');
  const length = text.length;
  const dict = [0, 1, 2];
  let dictSize = 4, numBits = 3, enlargeIn = 4;
  let position = 0, value = LZ_ALPHABET.indexOf(text[0]);
  let bit = 32;
  const readBit = () => {
    const out = (value & bit) === 0 ? 0 : 1;
    bit >>= 1;
    if (bit === 0) { bit = 32; position += 1; value = position < length ? LZ_ALPHABET.indexOf(text[position]) : 0; }
    return out;
  };
  const readBits = count => { let bits = 0, power = 1; for (let i = 0; i < count; i++) { bits += readBit() * power; power *= 2; } return bits; };
  let character;
  switch (readBits(2)) {
    case 0: character = String.fromCharCode(readBits(8)); break;
    case 1: character = String.fromCharCode(readBits(16)); break;
    case 2: return '';
    default: return null;
  }
  dict[3] = character;
  let result = character, entry = character;
  for (;;) {
    if (position >= length) return null;
    let code = readBits(numBits);
    if (code === 0) { character = String.fromCharCode(readBits(8)); dict[dictSize++] = character; code = dictSize - 1; enlargeIn -= 1; }
    else if (code === 1) { character = String.fromCharCode(readBits(16)); dict[dictSize++] = character; code = dictSize - 1; enlargeIn -= 1; }
    else if (code === 2) return result;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
    let phrase;
    if (dict[code]) phrase = dict[code];
    else if (code === dictSize) phrase = entry + entry.charAt(0);
    else return null;
    result += phrase;
    dict[dictSize++] = entry + phrase.charAt(0);
    enlargeIn -= 1;
    entry = phrase;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
  }
}

const defaultInflate = async bytes => {
  if (typeof DecompressionStream === 'undefined') throw new Error('no zlib inflater in this browser');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// Decodes an engine save file (text or bytes, as read from the picked file)
// to its save object. `inflate` is injectable for tests (Node's zlib).
export async function decodeEngineSave(data, { inflate = defaultInflate } = {}) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const asText = new TextDecoder('utf-8').decode(bytes).trim();
  const attempts = [];
  if (asText.startsWith('{')) attempts.push(() => JSON.parse(asText));
  attempts.push(() => { const out = lzDecompressFromBase64(asText); if (!out) throw new Error('not LZ'); return JSON.parse(out); });
  // MZ local file: the deflated bytes were written as a binary string and
  // UTF-8-encoded on disk; reading the text back and taking each character
  // as one byte recovers them. A web save is plain base64 of the same bytes.
  attempts.push(async () => JSON.parse(new TextDecoder('utf-8').decode(await inflate(Uint8Array.from(asText, c => c.charCodeAt(0) & 0xff)))));
  attempts.push(async () => JSON.parse(new TextDecoder('utf-8').decode(await inflate(bytes))));
  attempts.push(async () => { const raw = Uint8Array.from(atob(asText.replace(/\s/g, '')), c => c.charCodeAt(0)); return JSON.parse(new TextDecoder('utf-8').decode(await inflate(raw))); });
  let lastError;
  for (const attempt of attempts) {
    try { const save = await attempt(); if (save && typeof save === 'object' && (save.party || save.player || save.switches)) return save; } catch (error) { lastError = error; }
  }
  throw new Error(`not a readable RPG Maker save (${lastError?.message || 'unknown format'})`);
}

const FACING = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' };
const counts = table => Object.fromEntries(Object.entries(table || {}).filter(([, n]) => Number(n) > 0).map(([id, n]) => [String(id), Number(n)]));

// The engine save object -> the MWGP player's save state (see loadGame).
export function convertEngineSave(save) {
  if (!save || typeof save !== 'object') throw new Error('empty save');
  const mapId = Number(save.map?._mapId ?? save.player?._mapId);
  const x = Number(save.player?._x), y = Number(save.player?._y);
  if (!Number.isInteger(mapId) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('save has no map position');
  const switches = [], variables = [];
  (save.switches?._data || []).forEach((value, id) => { if (id > 0 && value !== null && value !== undefined) switches.push([String(id), Boolean(value)]); });
  (save.variables?._data || []).forEach((value, id) => { if (id > 0 && value !== null && value !== undefined) variables.push([String(id), value]); });
  for (const [key, value] of Object.entries(save.selfSwitches?._data || {})) {
    const parts = String(key).split(',');
    if (parts.length === 3) switches.push([`self:${parts[0]}:${parts[1]}:${parts[2]}`, Boolean(value)]);
  }
  const actors = {};
  for (const actor of save.actors?._data || []) {
    if (!actor || !actor._actorId) continue;
    const equips = {};
    (actor._equips || []).forEach((item, index) => { if (item?._itemId > 0) equips[String(index + 1)] = { id: Number(item._itemId), kind: item._dataClass === 'weapon' ? 'weapon' : 'armor' }; });
    const expTable = actor._exp && typeof actor._exp === 'object' ? actor._exp : {};
    actors[String(actor._actorId)] = {
      name: String(actor._name || ''), level: Math.max(1, Number(actor._level || 1)), classId: Number(actor._classId || 0),
      hp: Number(actor._hp || 0), mp: Number(actor._mp || 0),
      exp: Number(expTable[actor._classId] ?? Object.values(expTable)[0] ?? 0),
      skills: (actor._skills || []).map(Number).filter(id => id > 0), states: (actor._states || []).map(Number).filter(id => id > 0), equips,
      profile: String(actor._profile || ''),
    };
  }
  const party = (save.party?._actors || []).map(Number).filter(id => id > 0);
  return {
    mapId, x, y, facing: FACING[Number(save.player?._direction)] || 'down',
    rpg: { switches, variables },
    extra: {
      gold: Number(save.party?._gold || 0), items: counts(save.party?._items), weapons: counts(save.party?._weapons), armors: counts(save.party?._armors),
      party, actors, playerName: String(actors[String(party[0])]?.name || ''), system: {},
      steps: Number(save.party?._steps || 0), saveCount: Number(save.system?._saveCount || 0),
      playtime: 0, battleCount: 0, winCount: 0, escapeCount: 0, timer: null,
    },
  };
}
