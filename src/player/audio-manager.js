// RPG Maker sound and music, on top of mw_games' audio layer (`AudioBus`, `parseMidi`,
// `renderMidiToBuffer`, `parseSoundFont`, mw_games >= 0.18; off-thread MIDI render needs >= 0.20).
//
// The library owns the playback semantics RPG Maker needs: BGM and BGS as independent looping
// streams (replaying the same track only retunes it), ME jingles that suspend and resume the BGM at
// its position, overlapping SE, volume/pitch/pan per play, save/replay with playheads and plain-data
// snapshots. What stays here is what the library deliberately leaves to the game:
//
//   * finding the file: the manifest's audio index (`{ bgm: { name: '.ogg' }, ... }`) resolves each
//     name to the extension that exists (XP/VX/Ace mix .ogg/.mp3/.wav/.mid; MV/MZ decode to
//     .ogg/.m4a); .wma cannot be decoded and warns once;
//   * decoding: `decodeAudioData` for real audio (with the LOOPSTART/LOOPLENGTH Vorbis comments
//     MV/MZ files carry, in samples), and MIDI rendered off the main thread through
//     renderMidiToBufferAsync with the project's SoundFont (or the library's built-in synth),
//     falling back to the sync parseMidi -> renderMidiToBuffer path; the rendered PCM is cached
//     in IndexedDB because the render takes seconds and the page reloads on every map change;
//   * the player's mixer: master, per-kind volumes and mute (persisted), applied on top of each
//     track's own volume;
//   * the browser's autoplay unlock and a small LRU of decoded music.
//
// The environment is injectable (`lib`, `contextFactory`, `fetchImpl`, `storage`), which keeps the
// class testable in Node with a fake AudioContext.

export const PLAYABLE_EXTENSIONS = ['.ogg', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.opus'];
export const MIDI_EXTENSIONS = ['.mid', '.midi', '.rmi'];
export const UNPLAYABLE_EXTENSIONS = ['.wma'];
export const AUDIO_KINDS = ['bgm', 'bgs', 'me', 'se'];

// Best extension among the files sharing a base name: real audio first, synthesized MIDI next.
export function chooseExtension(extensions) {
  const lower = extensions.map(extension => String(extension).toLowerCase());
  for (const candidate of [...PLAYABLE_EXTENSIONS, ...MIDI_EXTENSIONS]) if (lower.includes(candidate)) return candidate;
  return lower[0] || null;
}

// LOOPSTART / LOOPLENGTH (samples) from an Ogg Vorbis comment header; the comments sit in the
// first pages of the file, so scanning the head is enough.
export function parseLoopTags(bytes) {
  const head = new Uint8Array(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.min(bytes.byteLength, 65536)) : bytes.slice(0, 65536));
  let text = '';
  for (let index = 0; index < head.length; index++) text += head[index] >= 32 && head[index] < 127 ? String.fromCharCode(head[index]) : ' ';
  const start = /LOOPSTART=(\d+)/i.exec(text), length = /LOOPLENGTH=(\d+)/i.exec(text);
  if (!start) return null;
  return { loopStart: Number(start[1]), loopLength: length ? Number(length[1]) : null };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Number.isFinite(Number(value)) ? Number(value) : low));

export class AudioManager {
  constructor({ root = '', index = null, lib = null, contextFactory = null, fetchImpl = null, storage = null, log = console, soundfontUrls = [], renderCache = undefined, cacheVersion = '' } = {}) {
    this.root = String(root).replace(/\/$/, '');
    this.index = index;
    this.lib = lib || globalThis.mw_games?.Audio || null;
    this.contextFactory = contextFactory || (() => (typeof AudioContext !== 'undefined' ? new AudioContext() : typeof webkitAudioContext !== 'undefined' ? new webkitAudioContext() : null));
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? (...args) => fetch(...args) : null);
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.log = log;
    this.soundfontUrls = soundfontUrls;
    this.soundfontUrl = null;
    this.soundfontBytes = null;   // raw SoundFont 2 bytes for the worker render path
    this.soundfontPromise = null;
    this.renderCache = renderCache === undefined ? indexedDbRenderCache() : renderCache;
    this.cacheVersion = String(cacheVersion);
    this.context = null;
    this.master = null;
    this.bus = null;
    this.buffers = new Map();     // "kind/name" -> Promise<{ buffer, loop }>
    this.bufferOrder = [];        // LRU of music buffers
    this.warned = new Set();
    this.requested = { bgm: null, bgs: null };   // last BGM/BGS as the game asked for it (before the mixer scaling)
    this.volumes = { master: 1, bgm: 1, bgs: 1, me: 1, se: 1, muted: false };
    this.loadVolumes();
  }

  // ---- environment --------------------------------------------------------------------
  ensureContext() {
    if (this.context) return this.context;
    if (!this.lib?.AudioBus) { this.warnOnce('lib', 'MWGP audio: mw_games audio (AudioBus) is unavailable; audio disabled'); return null; }
    try { this.context = this.contextFactory(); } catch (error) { this.warnOnce('context', `MWGP audio: no AudioContext (${error?.message || error}); audio disabled`); }
    if (!this.context) return null;
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
    this.applyMaster();
    this.bus = new this.lib.AudioBus(this.context, { destination: this.master, load: (kind, name) => this.load(kind, name) });
    return this.context;
  }

  // Browsers keep an AudioContext suspended until a user gesture. Sources are scheduled
  // regardless (they start when the context resumes), and the first key/click/touch resumes it.
  unlock(target = typeof window !== 'undefined' ? window : null) {
    const resume = () => { try { this.ensureContext()?.resume?.(); } catch { /* ignore */ } };
    resume();
    if (!target?.addEventListener || this.unlockInstalled) return;
    this.unlockInstalled = true;
    const once = () => { resume(); for (const type of ['keydown', 'pointerdown', 'touchstart']) target.removeEventListener(type, once); };
    for (const type of ['keydown', 'pointerdown', 'touchstart']) target.addEventListener(type, once);
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(message);
  }

  // ---- files --------------------------------------------------------------------------
  extensionOf(kind, name) {
    const entry = this.index?.[kind]?.[name];
    if (entry === undefined) return this.index ? null : '.ogg';   // no index (older manifests): MV default
    return Array.isArray(entry) ? chooseExtension(entry) : entry;
  }

  urlFor(kind, name) {
    const extension = this.extensionOf(kind, name);
    if (!extension) { this.warnOnce(`missing:${kind}/${name}`, `MWGP audio: ${kind} "${name}" is not in the converted audio; skipping`); return null; }
    if (UNPLAYABLE_EXTENSIONS.includes(extension.toLowerCase())) {
      this.warnOnce(`format:${extension}`, `MWGP audio: ${extension} files (${kind} "${name}") cannot be decoded by browsers; skipping`);
      return null;
    }
    return `${this.root}/audio/${kind}/${encodeURIComponent(name)}${extension}`;
  }

  // Decoded track for the bus: { buffer, loop }, or null when it cannot be had (already warned).
  load(kind, name) {
    const key = `${kind}/${name}`;
    if (this.buffers.has(key)) { this.touch(key); return this.buffers.get(key); }
    const url = this.urlFor(kind, name);
    const context = this.ensureContext();
    if (!url || !context || !this.fetchImpl) return Promise.resolve(null);
    const promise = this.decode(kind, name, url, context).catch(error => {
      this.buffers.delete(key);
      this.warnOnce(`load:${key}`, `MWGP audio: could not load ${kind} "${name}" (${error?.message || error}); skipping`);
      return null;
    });
    this.buffers.set(key, promise);
    if (kind === 'bgm' || kind === 'bgs') { this.bufferOrder.push(key); this.evict(); }
    return promise;
  }

  async decode(kind, name, url, context) {
    const isMidi = MIDI_EXTENSIONS.includes(String(this.extensionOf(kind, name)).toLowerCase());
    // Synthesizing a MIDI track takes seconds and the page reloads on every map change, so the
    // rendered PCM is cached (keyed by file, SoundFont and conversion) and reused across reloads.
    const font = isMidi ? await this.soundfont() : null;
    const cacheKey = isMidi ? `${url}|${this.soundfontUrl || 'synth'}|${this.cacheVersion}|lib1` : null;
    if (cacheKey && this.renderCache) {
      const cached = await Promise.resolve(this.renderCache.get(cacheKey)).catch(() => null);
      if (cached?.channels?.length) return { buffer: this.bufferFromFrames(context, cached.channels, cached.rate), loop: cached.loop };
    }
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (isMidi) {
      const rendered = await this.renderMidi(bytes, font);
      const loop = { start: rendered.loopStart, end: rendered.loopEnd };
      const channels = [rendered.left, rendered.right];
      if (cacheKey && this.renderCache) Promise.resolve(this.renderCache.set(cacheKey, { rate: rendered.sampleRate, channels, loop })).catch(() => {});
      return { buffer: this.bufferFromFrames(context, channels, rendered.sampleRate), loop };
    }
    const tags = kind === 'bgm' || kind === 'bgs' ? parseLoopTags(new Uint8Array(bytes)) : null;
    const buffer = await context.decodeAudioData(bytes.slice(0));
    let loop = null;
    if (tags && buffer.sampleRate) {
      const start = tags.loopStart / buffer.sampleRate;
      const end = tags.loopLength ? (tags.loopStart + tags.loopLength) / buffer.sampleRate : buffer.duration;
      if (end > start) loop = { start, end: Math.min(end, buffer.duration) };
    }
    return { buffer, loop };
  }

  // MIDI bytes -> stereo PCM frames. Prefers the library's worker render (mw_games 0.20+):
  // synthesising a real track costs seconds and would freeze the scene's frames on the main
  // thread. Bit-identical to the sync path, so the IndexedDB render cache stays valid across
  // the switch; a worker failure (or an older library) falls back loudly to the sync render.
  async renderMidi(bytes, font) {
    if (typeof this.lib.renderMidiToBufferAsync === 'function') {
      try {
        return await this.lib.renderMidiToBufferAsync(bytes, { soundFontBytes: this.soundfontBytes ?? undefined, sampleRate: 22050 });
      } catch (error) {
        this.warnOnce('midi-worker', `MWGP audio: worker MIDI render failed (${error?.message || error}); rendering on the main thread`);
      }
    }
    return this.lib.renderMidiToBuffer(this.lib.parseMidi(new Uint8Array(bytes)), { soundfont: font, sampleRate: 22050 });
  }

  bufferFromFrames(context, channels, rate) {
    const buffer = context.createBuffer(channels.length, channels[0].length, rate);
    channels.forEach((data, channel) => (buffer.copyToChannel ? buffer.copyToChannel(data, channel) : buffer.getChannelData(channel).set(data)));
    return buffer;
  }

  // The first SoundFont that loads (the project's own, then a shared vetted one) voices every MIDI
  // track; without one the library's built-in synth plays.
  soundfont() {
    if (!this.soundfontPromise) {
      this.soundfontPromise = (async () => {
        for (const url of this.soundfontUrls) {
          try {
            const response = await this.fetchImpl(url);
            if (!response.ok) continue;
            const bytes = await response.arrayBuffer();
            const font = this.lib.parseSoundFont(bytes);
            this.log.info?.(`MWGP audio: MIDI voiced by SoundFont ${url}`);
            this.soundfontUrl = url;
            this.soundfontBytes = bytes;
            return font;
          } catch (error) { this.warnOnce(`soundfont:${url}`, `MWGP audio: SoundFont ${url} unusable (${error?.message || error}); trying the next`); }
        }
        return null;
      })();
    }
    return this.soundfontPromise;
  }

  touch(key) {
    const at = this.bufferOrder.indexOf(key);
    if (at >= 0) { this.bufferOrder.splice(at, 1); this.bufferOrder.push(key); }
  }

  // Decoded music is large; keep only the few tracks a map can switch between.
  evict(limit = 4) {
    while (this.bufferOrder.length > limit) this.buffers.delete(this.bufferOrder.shift());
  }

  preload(entries) {
    return Promise.all((entries || []).filter(entry => entry?.name).map(entry => this.load(entry.kind || entry.dir, entry.name)));
  }

  // ---- mixer --------------------------------------------------------------------------
  categoryVolume(kind) { return this.volumes[kind] ?? 1; }

  applyMaster() {
    if (this.master) this.master.gain.value = this.volumes.muted ? 0 : this.volumes.master;
  }

  // The track as the bus should play it: the game's 0-100 volume times the player's per-kind mix.
  scaled(kind, track) {
    return { ...track, volume: clamp(track?.volume ?? 90, 0, 100) * this.categoryVolume(kind) };
  }

  setVolume(kind, value) {
    this.volumes[kind] = clamp(value, 0, 1);
    this.applyMaster();
    // Retune what is playing (same track: the bus only changes its level).
    for (const loopKind of ['bgm', 'bgs']) {
      const requested = this.requested[loopKind];
      if (kind === loopKind && requested?.name && this.bus?.currentTrack(loopKind)) this.bus[loopKind === 'bgm' ? 'playBgm' : 'playBgs'](this.scaled(loopKind, { ...requested, pos: undefined }));
    }
    this.saveVolumes();
  }

  setMuted(muted) { this.volumes.muted = Boolean(muted); this.applyMaster(); this.saveVolumes(); }
  toggleMute() { this.setMuted(!this.volumes.muted); return this.volumes.muted; }

  loadVolumes() {
    try {
      const saved = JSON.parse(this.storage?.getItem?.('mwgp.audio.volumes') || 'null');
      if (saved && typeof saved === 'object') for (const key of Object.keys(this.volumes)) if (key in saved) this.volumes[key] = key === 'muted' ? Boolean(saved[key]) : clamp(saved[key], 0, 1);
    } catch { /* storage unavailable or corrupt: defaults */ }
  }

  saveVolumes() {
    try { this.storage?.setItem?.('mwgp.audio.volumes', JSON.stringify(this.volumes)); } catch { /* ignore */ }
  }

  // ---- playback (delegated to the bus) ------------------------------------------------
  loopRequest(track) { return { name: String(track?.name || ''), volume: clamp(track?.volume ?? 90, 0, 100), pitch: clamp(track?.pitch ?? 100, 10, 400), pan: clamp(track?.pan ?? 0, -100, 100), pos: Number(track?.pos) > 0 ? Number(track.pos) : undefined }; }

  playBgm(track) {
    this.ensureContext();
    const request = this.loopRequest(track);
    this.requested.bgm = request.name ? request : null;
    return this.bus?.playBgm(this.scaled('bgm', request));
  }

  playBgs(track) {
    this.ensureContext();
    const request = this.loopRequest(track);
    this.requested.bgs = request.name ? request : null;
    return this.bus?.playBgs(this.scaled('bgs', request));
  }

  playMe(track) { this.ensureContext(); return this.bus?.playMe(this.scaled('me', track)); }
  playSe(track) { this.ensureContext(); return this.bus?.playSe(this.scaled('se', track)); }
  stopBgm() { this.requested.bgm = null; this.bus?.stopBgm(); }
  stopBgs() { this.requested.bgs = null; this.bus?.stopBgs(); }
  stopMe(resume = true) { this.bus?.stopMe(resume); }
  stopSe() { this.bus?.stopSe(); }
  fadeOutBgm(seconds) { this.requested.bgm = null; this.bus?.fadeOutBgm(seconds); }
  fadeOutBgs(seconds) { this.requested.bgs = null; this.bus?.fadeOutBgs(seconds); }
  stopAll() { this.requested = { bgm: null, bgs: null }; this.bus?.stopAll(); }

  // The bus reports tracks at their mixed level; state and the game see the level the game asked for.
  unmixed(kind, track) {
    if (!track) return null;
    const requested = this.requested[kind];
    return { ...track, volume: requested?.name === track.name ? requested.volume : track.volume / (this.categoryVolume(kind) || 1) };
  }

  currentTrack(kind) { return this.unmixed(kind, this.bus?.currentTrack(kind) ?? null); }
  isPlaying(kind) { return Boolean(this.bus?.[`${kind}Channel`]?.isPlaying); }

  // Save BGM / Save BGS memorize the playing track; Replay restores it from where it was saved.
  saveBgm() { return this.unmixed('bgm', this.bus?.saveBgm() ?? null); }
  saveBgs() { return this.unmixed('bgs', this.bus?.saveBgs() ?? null); }
  replayBgm() { return this.bus ? this.bus.replayBgm() : Promise.resolve(); }
  replayBgs() { return this.bus ? this.bus.replayBgs() : Promise.resolve(); }

  // ---- state --------------------------------------------------------------------------
  snapshot() {
    const state = this.bus?.snapshot();
    if (!state) return { bgm: null, bgs: null, savedBgm: null, savedBgs: null };
    return { bgm: this.unmixed('bgm', state.bgm), bgs: this.unmixed('bgs', state.bgs), savedBgm: this.unmixed('bgm', state.savedBgm), savedBgs: this.unmixed('bgs', state.savedBgs) };
  }

  restore(state) {
    if (!state || typeof state !== 'object') return;
    this.ensureContext();
    const mix = (kind, track) => (track ? this.scaled(kind, track) : null);
    if (state.bgm?.name) this.requested.bgm = this.loopRequest(state.bgm);
    if (state.bgs?.name) this.requested.bgs = this.loopRequest(state.bgs);
    this.bus?.restore({ bgm: mix('bgm', state.bgm), bgs: mix('bgs', state.bgs), savedBgm: mix('bgm', state.savedBgm), savedBgs: mix('bgs', state.savedBgs) });
  }
}

// IndexedDB store for rendered MIDI buffers (plain typed arrays, structured-cloned), or null where
// IndexedDB is unavailable (Node, private windows): rendering then simply happens every time.
export function indexedDbRenderCache(name = 'mwgp-audio-cache') {
  if (typeof indexedDB === 'undefined') return null;
  let opened = null;
  const open = () => opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('renders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = (mode, action) => open().then(database => new Promise((resolve, reject) => {
    const store = database.transaction('renders', mode).objectStore('renders');
    const request = action(store);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  }));
  return { get: key => run('readonly', store => store.get(key)), set: (key, value) => run('readwrite', store => store.put(value, key)) };
}
