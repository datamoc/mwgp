// nw.js host layer for an RPG Maker MV/MZ game running in a plain browser (tools/build-web.js copies this file next
// to the game's index.html and loads it first). MV/MZ games are browser code already; nw.js only adds a few Node/host
// APIs, which this layer provides generically - it knows no game:
//   - `require('fs')`: reads come from the web server (synchronous XHR, like nw's synchronous fs), writes (saves,
//     config) land in an in-memory store persisted to IndexedDB; directory listings answer from `files.json` and
//     `directories.json`, the build's file and directory indexes;
//   - `require('path' | 'process' | 'os' | 'util' | 'events' | 'nw.gui')`, `process`, `nw`;
//   - any other module (child_process, worker_threads, native add-ons such as Steam bindings) is a lenient object
//     whose members do nothing, warned once per module, instead of an exception that stops the page.
// The build turns the game's `<script src>` tags into `data-mwgp-src` placeholders; this layer loads them, in order,
// once the save store and the file list are ready, then runs the page-load handlers the game registered too late to
// see the real `load` event.
(function () {
  'use strict';
  const root = location.pathname.replace(/[^/]*$/, '');
  const warnedModules = new Set();
  const note = message => console.info(`[nw.js host] ${message}`);

  // ---- paths --------------------------------------------------------------------------------------------------
  const parts = p => String(p).replace(/\\/g, '/').replace(/^file:\/\/\/?/, '/').replace(/^[A-Za-z]:/, '').split('/')
    .reduce((out, part) => { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); return out; }, []);
  const rootParts = parts(root);
  // A game path (absolute under the game folder, or relative to it) as the path under the game folder.
  const rel = p => {
    const list = parts(p), lower = list.map(part => part.toLowerCase());
    const underRoot = rootParts.every((part, index) => lower[index] === part.toLowerCase());
    const parentParts = rootParts.slice(0, -1);
    const underParent = parentParts.length > 0 && parentParts.every((part, index) => lower[index] === part.toLowerCase());
    // Games often resolve writable sibling paths from www/ (for example ../logs).
    // The web build flattens www/ into this folder, so confine that parent path to
    // the current game's virtual root rather than letting it escape the build.
    const at = underRoot ? rootParts.length : underParent ? parentParts.length : 0;
    return list.slice(at).join('/');
  };

  // ---- the game's files and the persistent store --------------------------------------------------------------
  let files = [], indexedDirectories = [], fileSet = new Set(), dirSet = new Set();
  const store = new Map();           // lowercased game path -> string contents (saves, config, ...)
  const DB_NAME = `mwgp-web:${root}`;
  let db = null;
  const openDb = () => new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  const persist = (key, value) => {
    if (!db) return;
    try { const tx = db.transaction('files', 'readwrite'); if (value === undefined) tx.objectStore('files').delete(key); else tx.objectStore('files').put(value, key); }
    catch (error) { console.warn('[nw.js host] could not persist', key, error); }
  };
  const loadStore = () => new Promise(resolve => {
    if (!db) return resolve();
    try {
      const request = db.transaction('files', 'readonly').objectStore('files').openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve(); store.set(String(cursor.key), cursor.value); cursor.continue(); };
      request.onerror = () => resolve();
    } catch { resolve(); }
  });
  const indexFiles = (list, directories = []) => {
    files = list; indexedDirectories = directories; fileSet = new Set(list.map(f => f.toLowerCase())); dirSet = new Set();
    for (const f of fileSet) { const segments = f.split('/'); for (let i = 1; i < segments.length; i++) dirSet.add(segments.slice(0, i).join('/')); }
    for (const dir of directories) { const name = parts(dir).join('/').toLowerCase(); if (name) dirSet.add(name); }
  };

  // ---- fs ------------------------------------------------------------------------------------------------------
  const enoent = p => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT', errno: -2, path: String(p) });
  const key = p => rel(p).toLowerCase();
  const isFile = p => store.has(key(p)) || fileSet.has(key(p));
  // Directories the game created (`mkdirSync`), kept in the store as `<path>/` markers so they persist like files.
  const DIR_MARK = '/';
  const isDir = p => { const k = key(p); return k === '' || dirSet.has(k) || store.has(k + DIR_MARK) || [...store.keys()].some(s => s.startsWith(k + '/')); };
  const makeDir = (p, options) => {
    const segments = key(p).split('/').filter(Boolean);
    for (let i = options?.recursive ? 1 : segments.length; i <= segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (!dirSet.has(dir) && !store.has(dir + DIR_MARK)) { store.set(dir + DIR_MARK, ''); persist(dir + DIR_MARK, ''); }
    }
  };
  const readRemote = p => {
    const request = new XMLHttpRequest();
    request.open('GET', root + rel(p).split('/').map(encodeURIComponent).join('/'), false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send();
    if (request.status !== 200) throw enoent(p);
    const raw = request.responseText, bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
    return bytes;
  };
  const toText = bytes => new TextDecoder().decode(bytes);
  const asBuffer = bytes => Object.assign(bytes, { toString: (encoding) => (encoding === 'base64' ? btoa(String.fromCharCode(...bytes)) : toText(bytes)) });
  const encodingOf = options => (typeof options === 'string' ? options : options?.encoding);
  // A shipped/static asset (never written through this host) is immutable for the life of a build: its mtime must
  // stay the same value across every stat call and every reload, or a plugin that caches by modified-time (e.g. a
  // mod comparing a stored timestamp against a fresh stat to decide whether to rebuild) sees a "changed" file on
  // every single check and never treats its own cache as valid. A store-backed file (something the game itself
  // wrote this session) keeps its real write time instead, tracked here since IndexedDB only persists content.
  const writeTimes = new Map();
  const stat = p => {
    if (!isFile(p) && !isDir(p)) throw enoent(p);
    const file = isFile(p), k = key(p);
    const mtimeMs = store.has(k) ? (writeTimes.get(k) ?? 0) : 0;
    return { isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false, size: file && store.has(k) ? String(store.get(k)).length : 0, mtime: new Date(mtimeMs), mtimeMs, ctime: new Date(mtimeMs), birthtime: new Date(mtimeMs) };
  };
  const listDir = (p, options) => {
    const k = key(p); const prefix = k ? `${k}/` : '', prefixLower = prefix.toLowerCase();
    if (k && !isDir(p)) throw enoent(p);
    const names = new Map();
    const add = (entry, kind) => {
      const lower = entry.toLowerCase();
      if (!lower.startsWith(prefixLower)) return;
      const tail = entry.slice(prefix.length).replace(/\/$/, '');
      if (!tail) return;
      const parts = tail.split('/'), name = parts[0];
      if (name) names.set(name.toLowerCase(), { name, directory: kind === 'directory' || parts.length > 1 });
    };
    for (const file of files) add(file, 'file');
    for (const dir of indexedDirectories) add(dir, 'directory');
    for (const stored of store.keys()) add(stored, stored.endsWith('/') ? 'directory' : 'file');
    return [...names.values()].map(({ name, directory }) => options?.withFileTypes ? new Dirent(name, directory) : name);
  };
  const bytesOf = data => {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new TextEncoder().encode(String(data));
  };
  const storedBytes = value => value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  const saveGeneratedCache = (p, bytes) => {
    const k = key(p), data = new Uint8Array(bytes);
    store.set(k, data); persist(k, data);
    // npm start can write generated FastCutIns caches back into the source game and web build.
    // Other static hosts keep the cache in this browser's IndexedDB.
    const webId = rootParts[1];
    if (rootParts[0] === 'web' && webId) fetch(`/api/web-cache/${encodeURIComponent(webId)}?path=${encodeURIComponent(rel(p))}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data
    }).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); })
      .catch(error => console.warn('[nw.js host] generated cache remains in this browser only', error));
  };
  const write = (p, data) => {
    const value = bytesOf(data);
    store.set(key(p), value); persist(key(p), value); writeTimes.set(key(p), Date.now());
    if (/\/\.fast-cut-ins(?:\.lock)?$/i.test(`/${rel(p)}`) || /(?:^|\/)img\/.*_fast(?:\/|$)/i.test(`/${rel(p)}`)) saveGeneratedCache(p, value);
  };
  const remove = p => { store.delete(key(p)); persist(key(p), undefined); writeTimes.delete(key(p)); };
  const callbackify = fn => (...args) => { const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null; let result, error = null; try { result = fn(...args); } catch (e) { error = e; } if (callback) setTimeout(() => callback(error, result)); };
  class Dirent {
    constructor(name, directory) { this.name = name; this._directory = directory; }
    isFile() { return !this._directory; }
    isDirectory() { return this._directory; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }
  const fs = {
    Dirent,
    existsSync: p => isFile(p) || isDir(p),
    readFileSync(p, options) {
      const k = key(p); const encoding = encodingOf(options);
      if (store.has(k)) { const bytes = storedBytes(store.get(k)); return encoding ? toText(bytes) : asBuffer(bytes); }
      if (!fileSet.has(k)) throw enoent(p);
      const bytes = readRemote(p);
      return encoding ? toText(bytes) : asBuffer(bytes);
    },
    writeFileSync: write,
    appendFileSync(p, data) { let before = ''; try { before = fs.readFileSync(p, 'utf8'); } catch { /* a new file */ } write(p, before + String(data)); },
    unlinkSync(p) { if (!store.has(key(p))) throw enoent(p); remove(p); },
    rmSync(p) { for (const k of [...store.keys()]) if (k === key(p) || k.startsWith(key(p) + '/')) { store.delete(k); persist(k, undefined); } },
    renameSync(from, to) { if (!store.has(key(from))) throw enoent(from); write(to, store.get(key(from))); remove(from); },
    copyFileSync(from, to) { write(to, fs.readFileSync(from, 'utf8')); },
    mkdirSync: makeDir,
    rmdirSync(p) { const k = key(p) + DIR_MARK; if (store.has(k)) { store.delete(k); persist(k, undefined); } },
    readdirSync: listDir,
    statSync: stat, lstatSync: stat,
    accessSync(p) { if (!fs.existsSync(p)) throw enoent(p); },
    realpathSync: p => String(p),
    openSync: () => 0, closeSync() {}, writeSync: () => 0, fsyncSync() {},
    watch: () => ({ close() {}, on() {} }),
    createWriteStream(p) {
      const chunks = [];
      let closed = false;
      return {
        write(chunk) { if (closed) throw new Error('write after close'); chunks.push(bytesOf(chunk)); return true; },
        end(chunk) { if (chunk !== undefined) this.write(chunk); this.close(); },
        close() {
          if (closed) return;
          closed = true;
          const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0), result = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
          write(p, result);
        },
        on() { return this; }, once() { return this; }
      };
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }
  };
  for (const name of ['readFile', 'writeFile', 'appendFile', 'unlink', 'rename', 'readdir', 'stat', 'lstat', 'mkdir', 'access', 'copyFile', 'rm'])
    fs[name] = callbackify((...args) => fs[`${name}Sync`](...args));
  fs.exists = (p, callback) => setTimeout(() => callback(fs.existsSync(p)));
  fs.promises = Object.fromEntries(['readFile', 'writeFile', 'appendFile', 'unlink', 'rename', 'readdir', 'stat', 'lstat', 'mkdir', 'access', 'copyFile', 'rm']
    .map(name => [name, (...args) => new Promise((resolve, reject) => fs[name](...args, (error, value) => (error ? reject(error) : resolve(value))))]));

  // ---- path, process, os, util, events --------------------------------------------------------------------------
  const path = {
    sep: '/', delimiter: ':',
    join: (...segments) => path.normalize(segments.filter(s => s !== '').join('/')),
    resolve: (...segments) => { let out = ''; for (const s of segments) out = path.isAbsolute(s) ? String(s) : `${out}/${s}`; return '/' + parts(out).join('/'); },
    // Node keeps a leading and a trailing separator.
    normalize: p => { const s = String(p).replace(/\\/g, '/'); const body = parts(s).join('/'); return ((s.startsWith('/') ? '/' : '') + body + (s.endsWith('/') && body ? '/' : '')) || '.'; },
    dirname: p => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); const at = s.lastIndexOf('/'); return at > 0 ? s.slice(0, at) : at === 0 ? '/' : '.'; },
    basename: (p, ext) => { const base = String(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop(); return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base; },
    extname: p => { const base = path.basename(p); const at = base.lastIndexOf('.'); return at > 0 ? base.slice(at) : ''; },
    isAbsolute: p => /^([A-Za-z]:)?[\\/]/.test(String(p)),
    relative: (from, to) => { const a = parts(from), b = parts(to); let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/'); },
    parse: p => { const s = String(p).replace(/\\/g, '/'); const base = path.basename(s); const ext = path.extname(s); return { root: s.startsWith('/') ? '/' : '', dir: s.includes('/') ? path.dirname(s) : '', base, ext, name: ext ? base.slice(0, -ext.length) : base }; },
    format: o => `${o.dir ? `${o.dir}/` : o.root || ''}${o.base || `${o.name || ''}${o.ext || ''}`}`
  };
  path.posix = path; path.win32 = path;
  const proc = {
    mainModule: { filename: `${root}index.html` }, platform: 'browser', arch: 'wasm', env: {}, versions: {}, argv: [], execPath: '', pid: 1,
    cwd: () => root, on() { return proc; }, once() { return proc; }, off() { return proc; }, emit() { return false; }, exit() {}, memoryUsage: () => ({ heapUsed: 0, rss: 0 }),
    nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)), uptime: () => performance.now() / 1000,
    hrtime: Object.assign(() => { const ms = performance.now(); return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)]; }, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) })
  };
  class EventEmitter {
    constructor() { this._events = {}; }
    on(name, fn) { (this._events[name] ||= []).push(fn); return this; }
    addListener(name, fn) { return this.on(name, fn); }
    prependListener(name, fn) { (this._events[name] ||= []).unshift(fn); return this; }
    once(name, fn) { const wrapped = (...args) => { this.off(name, wrapped); fn.apply(this, args); }; return this.on(name, wrapped); }
    off(name, fn) { this._events[name] = (this._events[name] || []).filter(f => f !== fn); return this; }
    removeListener(name, fn) { return this.off(name, fn); }
    removeAllListeners(name) { if (name) delete this._events[name]; else this._events = {}; return this; }
    emit(name, ...args) { const list = (this._events[name] || []).slice(); list.forEach(fn => fn.apply(this, args)); return list.length > 0; }
    listenerCount(name) { return (this._events[name] || []).length; }
    listeners(name) { return (this._events[name] || []).slice(); }
    setMaxListeners() { return this; }
  }
  const events = Object.assign(EventEmitter, { EventEmitter, once: (emitter, name) => new Promise(resolve => emitter.once(name, (...args) => resolve(args))) });
  const inspect = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value); } catch { return String(value); } };
  const util = {
    inspect, format: (fmt, ...args) => String(fmt).replace(/%[sdifjoO%]/g, m => (m === '%%' ? '%' : inspect(args.shift()))) + (args.length ? ` ${args.map(inspect).join(' ')}` : ''),
    inherits: (ctor, superCtor) => { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); Object.setPrototypeOf(ctor, superCtor); },
    promisify: fn => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value)))),
    deprecate: fn => fn, debuglog: () => () => {}, isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    TextEncoder, TextDecoder, types: { isPromise: v => v instanceof Promise, isDate: v => v instanceof Date, isRegExp: v => v instanceof RegExp }
  };
  const os = { platform: () => 'browser', type: () => 'Browser', release: () => '', arch: () => 'wasm', homedir: () => '/', tmpdir: () => '/tmp', hostname: () => 'browser', EOL: '\n', cpus: () => [], totalmem: () => 0, freemem: () => 0 };

  // ---- nw.js window / app --------------------------------------------------------------------------------------
  const win = {
    on() { return win; }, once() { return win; }, removeAllListeners() { return win; }, show() {}, hide() {}, focus() {}, close() {}, minimize() {}, maximize() {}, restore() {},
    enterFullscreen() { document.documentElement.requestFullscreen?.().catch(() => {}); }, leaveFullscreen() { if (document.fullscreenElement) document.exitFullscreen?.(); },
    toggleFullscreen() { if (document.fullscreenElement) win.leaveFullscreen(); else win.enterFullscreen(); },
    get isFullscreen() { return Boolean(document.fullscreenElement); },
    get title() { return document.title; }, set title(value) { document.title = value; },
    showDevTools() {}, closeDevTools() {}, setMinimumSize() {}, setMaximumSize() {}, resizeTo() {}, moveTo() {}, setPosition() {}, requestAttention() {},
    get width() { return innerWidth; }, get height() { return innerHeight; }
  };
  const nw = {
    Window: { get: () => win, open() {} },
    App: { argv: [], fullArgv: [], dataPath: '/', manifest: {}, quit() {}, closeAllWindows() {}, clearCache() {} },
    Shell: { openExternal: url => window.open(url, '_blank', 'noopener'), openItem() {}, showItemInFolder() {} },
    Screen: { Init() {}, screens: [], on() {} }, Menu: function () { return { append() {}, popup() {} }; }, MenuItem: function () {}, Clipboard: { get: () => ({ get: () => '', set() {} }) }
  };

  const modules = { fs, path, process: proc, os, util, events, 'nw.gui': nw };
  const lenient = label => new Proxy(function () {}, {
    get: (_, prop) => (prop === Symbol.toPrimitive ? () => '' : prop === 'then' || prop === Symbol.iterator ? undefined : lenient(`${label}.${String(prop)}`)),
    apply: () => lenient(`${label}()`), construct: () => lenient(`new ${label}`)
  });
  const require = name => {
    const id = String(name).replace(/^node:/, '');
    if (Object.hasOwn(modules, id)) return modules[id];
    if (!warnedModules.has(id)) { warnedModules.add(id); console.warn(`[nw.js host] require('${name}') has no browser equivalent; its calls do nothing`); }
    return lenient(id);
  };
  window.require = require;
  window.process = proc;
  window.nw = nw;
  window.global = window;

  // ---- boot: store + file list first, then the game's own scripts in document order -----------------------------
  const lateLoadHandlers = [];
  const bootScripts = async () => {
    const [list, directories] = await Promise.all([
      fetch(`${root}files.json`).then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${root}directories.json`).then(r => (r.ok ? r.json() : [])).catch(() => []),
      openDb().then(opened => { db = opened; if (!db) note('IndexedDB unavailable: saves last until the page closes'); return loadStore(); })
    ]);
    indexFiles(Array.isArray(list) ? list : [], Array.isArray(directories) ? directories : []);
    // The window `load` event has fired by the time the game's scripts run: a handler they register for it runs as soon
    // as the scripts are in (MV's main.js sets `window.onload`; others use addEventListener).
    const addEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, handler, options) => (type === 'load' && document.readyState === 'complete' ? lateLoadHandlers.push(handler) : addEventListener(type, handler, options));
    // The browser holds `load` until the scripts a page inserts while loading have run (MV's PluginManager.setup adds
    // every plugin that way): the late handlers wait for those too.
    let pending = 0, settle = null;
    const track = node => {
      if (node.tagName !== 'SCRIPT' || !node.src || node.dataset.mwgpTracked) return;
      node.dataset.mwgpTracked = '1';
      pending++;
      const done = () => { pending--; if (pending === 0) settle?.(); };
      node.addEventListener('load', done, { once: true });
      node.addEventListener('error', done, { once: true });
    };
    const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) track(node); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    for (const placeholder of [...document.querySelectorAll('script[data-mwgp-src]')]) {
      await new Promise(resolve => {
        const script = document.createElement('script');
        for (const attribute of placeholder.attributes) if (attribute.name !== 'data-mwgp-src') script.setAttribute(attribute.name, attribute.value);
        script.src = placeholder.getAttribute('data-mwgp-src');
        script.async = false;
        script.onload = resolve;
        script.onerror = () => { console.error(`[nw.js host] could not load ${script.src}`); resolve(); };
        placeholder.replaceWith(script);
      });
    }
    await new Promise(resolve => setTimeout(resolve));
    while (pending > 0) await new Promise(resolve => { settle = resolve; });
    observer.disconnect();
    window.addEventListener = addEventListener;
    const event = new Event('load');
    if (typeof window.onload === 'function') window.onload(event);
    for (const handler of lateLoadHandlers) (typeof handler === 'function' ? handler : handler?.handleEvent?.bind(handler))?.(event);
  };
  const start = () => bootScripts().catch(error => console.error('[nw.js host] boot failed', error));
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });

  // What the host has done, for tests and debugging.
  window.__mwgpWebHost = { ready: () => files.length > 0, files: () => files.length, stored: () => [...store.keys()], warnedModules: () => [...warnedModules] };
})();
