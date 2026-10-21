// Standalone Studio host: supplies the server Studio's /api/studio endpoints
// in memory, from a self-contained game page the user opens locally. The
// graphical editor (public/studio.js) runs unmodified against this host.
// Saving keeps the edited project in memory; the deliverable is a regenerated
// self-contained game page (same player shell, edited manifest and assets).
import { PLAYER_VERSION } from '../standalone-player/player-version.js';
import { t } from '../../public/i18n.js';

// The payload layout of standalone.js (kept in step with it): <script> elements of
// at most PAYLOAD_PART_CHARS base64 characters, read back in order. A page above
// STANDALONE_PAYLOAD_LIMIT bytes cannot be held as one string, so it is refused.
const PAYLOAD_PATTERN = /<script (?:data-mwgp-payload|id="mwgp-payload") type="application\/octet-stream">([\s\S]*?)<\/script>/g;
const PAYLOAD_PART_CHARS = 64 * 1024 * 1024;
const STANDALONE_PAYLOAD_LIMIT = 500 * 1024 * 1024;
const textExtensions = new Set(['.js', '.json', '.txt', '.csv', '.xml', '.ini', '.css', '.rb', '.md', '.fnt']);
const isTextAsset = path => textExtensions.has(path.slice(path.lastIndexOf('.')).toLowerCase());
const stripStudio = value => {
  if (Array.isArray(value)) return value.map(stripStudio);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'studio').map(([key, item]) => [key, stripStudio(item)]));
  return value;
};
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => key !== 'studio').map(key => [key, stable(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// Entity-level changed paths, in the /maps/<id>/... shape the editor's
// protection badges understand (mirrors the merge granularity of
// src/studio-manifest.js without its Node dependencies).
function changedPaths(base, edited) {
  const paths = [];
  const baseMaps = new Map((base.maps || []).map(map => [String(map.id), map]));
  for (const map of edited.maps || []) {
    const before = baseMaps.get(String(map.id));
    const prefix = `/maps/${map.id}`;
    if (!before) { paths.push(prefix); continue; }
    baseMaps.delete(String(map.id));
    const { mwgEvents: beforeEvents, ...beforeOwn } = before;
    const { mwgEvents: editedEvents, ...editedOwn } = map;
    if (!same(beforeOwn, editedOwn)) paths.push(prefix);
    const beforeById = new Map((beforeEvents || []).map(event => [String(event.id), event]));
    for (const event of editedEvents || []) {
      if (!same(beforeById.get(String(event.id)), event)) paths.push(`${prefix}/mwgEvents/${event.id}`);
      beforeById.delete(String(event.id));
    }
    for (const id of beforeById.keys()) paths.push(`${prefix}/mwgEvents/${id}`);
  }
  for (const id of baseMaps.keys()) paths.push(`/maps/${id}`);
  for (const [table, rows] of Object.entries(edited.database || {})) {
    if (!Array.isArray(rows)) { if (!same(base.database?.[table], rows)) paths.push(`/database/${table}`); continue; }
    rows.forEach((row, index) => { if (!same(base.database?.[table]?.[index], row)) paths.push(`/database/${table}/${index}`); });
  }
  for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    if (key !== 'maps' && key !== 'database' && !same(base[key], edited[key])) paths.push(`/${key}`);
  }
  return paths;
}

const allowedCommands = new Set([
  'say', 'ask', 'inputNumber', 'inputName', 'messageOptions', 'battle', 'weather', 'gameOver', 'wait', 'setSwitch', 'setVariable', 'addVariable', 'modifyVariable', 'copyVariable', 'if', 'loop',
  'breakLoop', 'exitEvent', 'commonEvent', 'move', 'transfer', 'picture', 'erasePicture', 'movePicture', 'tintPicture',
  'balloon', 'animation', 'animationAt', 'shop', 'scroll', 'scrollMap', 'mapSettings', 'relocate', 'saveBgm', 'resumeBgm', 'me', 'menu', 'goto',
  'changeHp', 'changeLevel', 'changeClass', 'vehicleLocation', 'enemyAppear', 'changeEnemyHp', 'changeEnemyMp', 'changeEnemyTp', 'changeEnemyState', 'enemyTransform', 'changeState', 'recoverAll', 'changeSkill', 'changeEquipment', 'changeProfile',
  'sound', 'turn', 'screenFade', 'screenFlash', 'changeGold', 'changeItem', 'changeWeapon', 'changeArmor', 'changeParty',
  'setTransparent', 'routeThrough', 'routeImage', 'routeOption', 'eraseEvent', 'screenTint', 'screenShake', 'playBgm', 'fadeoutBgm', 'playBgs', 'fadeoutBgs',
  'stopSound', 'script', 'pluginCommand', 'unsupported', 'systemFlag', 'changeActorStat', 'changeActorText', 'changeActorImages', 'timer', 'vehicleBoard', 'playMovie', 'forceAction', 'returnToTitle',
  'changeTileset', 'changeParallax', 'enemyRecoverAll', 'abortBattle', 'selectItem', 'rotatePicture', 'locationInfo',
]);
// Structural validation before a save is published into a game page. The full
// Node validator (tools/validate-mwgp.js) remains the reference on the server.
function validateManifest(manifest) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(manifest.format === 'MWGP', 'format must be MWGP');
  check(Number.isInteger(manifest.version) && manifest.version >= 1, 'version must be a positive integer');
  check(Array.isArray(manifest.maps) && manifest.maps.length > 0, 'maps must be a non-empty array');
  check(manifest.initialMapId == null || manifest.maps.some(map => map.id === manifest.initialMapId), 'initialMapId must refer to a map');
  check(manifest.assets && typeof manifest.assets === 'object', 'assets metadata is required');
  if (manifest.playerVersion !== undefined) check(typeof manifest.playerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.playerVersion), 'playerVersion must be a version such as "0.0.1"');
  const commands = (list, where) => {
    for (const command of list || []) {
      check(Object.keys(command).some(key => allowedCommands.has(key)), `unsupported command in ${where}`);
      if (command.if) { commands(command.then, where); commands(command.else, where); }
      if (command.loop) commands(command.loop, where);
      if (command.branches) for (const branch of command.branches) commands(branch, where);
      if (command.cancelBranch) commands(command.cancelBranch, where);
      if (command.battle) for (const branch of Object.values(command.battle.branches || {})) commands(branch, where);
    }
  };
  for (const map of manifest.maps || []) {
    const data = map.data;
    check(Number.isInteger(data?.width) && Number.isInteger(data?.height), `map ${map.id} has invalid dimensions`);
    check(Array.isArray(data?.data) && data.data.length >= data.width * data.height * 6, `map ${map.id} must contain at least six MV layers`);
    for (const event of map.mwgEvents || []) {
      check(Array.isArray(event.pages), `event ${event.id} on map ${map.id} has no pages`);
      check(Number.isInteger(event.x) && Number.isInteger(event.y) && event.x >= 0 && event.x < data.width && event.y >= 0 && event.y < data.height,
        `event ${event.id} on map ${map.id} is outside map bounds`);
      for (const page of event.pages || []) commands(page.commands, `event ${event.id} on map ${map.id}`);
    }
  }
  return errors;
}

function skeletonManifest(title = 'Nouveau projet') {
  // Mirror of skeletonManifest() in src/studio-manifest.js, kept asset-free.
  const curves = (base, growth) => Array.from({ length: 8 }, (_, param) =>
    Array.from({ length: 99 }, (_, level) => Math.max(1, base[param] + growth[param] * level)));
  return {
    format: 'MWGP', converter: { version: 'standalone-studio', engine: 'studio' }, version: 1,
    source: { engine: 'studio', convertedAt: new Date().toISOString() },
    display: { title, width: 816, height: 624, tileSize: 48 },
    assets: { kind: 'source', root: 'assets', tilesets: false, characters: false, faces: false, pictures: false, audio: false, system: false, animations: false, parallaxes: false, windowSkin: false, encryption: 'none' },
    initialMapId: 1, initialParty: [1], player: { mapId: 1, x: 1, y: 1 }, playerSprite: { name: '', index: 0 },
    titleScreen: { title1Name: '', title2Name: '', drawTitle: true, commandOffset: { x: 0, y: 0 } },
    audio: { index: { bgm: {}, bgs: {}, me: {}, se: {} }, system: {}, soundfont: null },
    tilesets: [null, { id: 1, mode: 0, name: 'Basique', tilesetNames: ['', '', '', '', '', '', '', '', ''], flags: [] }],
    commonEvents: {},
    maps: [{ id: 1, info: { name: 'Carte 1', width: 20, height: 15 }, tilesetId: 1,
      data: { width: 20, height: 15, tilesetId: 1, displayName: 'Carte 1', events: [], data: new Array(20 * 15 * 6).fill(0) }, mwgEvents: [] }],
    database: {
      system: { gameTitle: title, startMapId: 1, startX: 1, startY: 1, partyMembers: [1], currencyUnit: 'G', optDrawTitle: true, optDisplayTp: true, optEncounter: true, optSaveCount: true, optUseItems: true, sounds: {}, terms: { basic: [], commands: [], messages: {}, params: [] } },
      actors: [null, { id: 1, name: 'Héros', nickname: '', profile: 'Un héros créé dans MWGP Studio.', classId: 1, initialLevel: 1, characterName: '', characterIndex: 0, faceName: '', faceIndex: 0, equips: [] }],
      classes: [null, { id: 1, name: 'Aventurier', expParams: [30, 20, 30, 30], params: curves([400, 200, 20, 20, 20, 20, 20, 20], [8, 4, 1, 1, 1, 1, 1, 1]), learnings: [], traits: [] }],
      skills: [null], items: [null], weapons: [null], armors: [null], enemies: [null], troops: [null],
      states: [null, { id: 1, name: 'mort', restriction: 4, priority: 100, message1: " s'effondre !", message2: ' est vaincu !', removeAtBattleEnd: false, traits: [] }],
    },
  };
}

async function sha256(blob) {
  if (!blob) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

// The size gate (gate.js) reads its data from the head: a page over its limit stops before its payload. A regenerated page
// carries the current payload size (the limit it was made with is kept), and a page that has no gate gets the gate's
// element in front of its payload.
const LARGE_PAGE_LIMIT = 100 * 1024 * 1024;
function withSizeData(head, bytes, id, gate) {
  const limit = head.match(/<meta name="mwgp-payload-limit" content="(\d+)"/)?.[1] ?? String(LARGE_PAGE_LIMIT);
  let result = head.replace(/<meta name="mwgp-payload-(?:bytes|limit|id)" content="[^"]*">/g, '');
  result = result.replace('</head>', () => `<meta name="mwgp-payload-bytes" content="${bytes}"><meta name="mwgp-payload-limit" content="${limit}"><meta name="mwgp-payload-id" content="${id}"></head>`);
  if (gate && !result.includes('<script id="mwgp-gate">')) result += gate;
  return result;
}

export function installStudioHost(runtime) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const nativeOpen = globalThis.open.bind(globalThis);
  const state = {
    ready: null, id: 'standalone', manifest: null, base: null,
    files: new Map(), original: new Map(), pageText: null, outputName: 'jeu',
    protectedPaths: [], assets: new Map(), revision: 0,
  };

  async function unpack(file) {
    if (typeof DecompressionStream !== 'function') throw new Error(t('sa_no_gzip'));
    if (file.size > STANDALONE_PAYLOAD_LIMIT) throw new Error(t('sa_too_large'));
    const pageText = await file.text();
    const payloads = [...pageText.matchAll(PAYLOAD_PATTERN)];
    if (!payloads.length) throw new Error(t('sa_not_standalone'));
    const lines = payloads.flatMap(match => match[1].trim().split('\n'));
    let line = 0;
    const compressed = new ReadableStream({ pull(controller) {
      if (line === lines.length) { controller.close(); return; }
      const text = lines[line]; lines[line++] = null;
      controller.enqueue(Uint8Array.from(atob(text), c => c.charCodeAt(0)));
    } });
    const reader = compressed.pipeThrough(new DecompressionStream('gzip')).getReader();
    let current = new Uint8Array(), offset = 0;
    async function readParts(length) {
      const parts = [];
      while (length > 0) {
        if (offset === current.length) {
          const next = await reader.read();
          if (next.done) throw new Error(t('sa_truncated'));
          current = next.value; offset = 0;
        }
        const count = Math.min(length, current.length - offset);
        parts.push(current.subarray(offset, offset + count));
        offset += count; length -= count;
      }
      return parts;
    }
    const headerSize = new DataView(await new Blob(await readParts(4)).arrayBuffer()).getUint32(0, true);
    if (!headerSize || headerSize > 32 * 1024 * 1024) throw new Error(t('sa_bad_index'));
    const metadata = JSON.parse(await new Blob(await readParts(headerSize)).text());
    if (metadata.format !== 'MWGP-standalone' || metadata.version !== 1 || !Array.isArray(metadata.files)) throw new Error(t('sa_unknown_format'));
    const files = new Map();
    for (const entry of metadata.files) {
      if (typeof entry.path !== 'string' || files.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(t('sa_bad_entry'));
      files.set(entry.path, new Blob(await readParts(entry.size)));
    }
    if (offset !== current.length || !(await reader.read()).done) throw new Error(t('sa_trailing'));
    if (!files.has('mwgp.json')) throw new Error(t('sa_no_manifest'));
    return { metadata, files, pageText };
  }

  // An unpacked game folder: the index file the unpacking wrote, and the game's files next to it.
  async function unpackFolder(root) {
    const header = await root.getFileHandle('.mwgp-standalone.json').catch(() => null);
    if (!header) throw new Error(t('sa_not_standalone'));
    const metadata = JSON.parse(await (await header.getFile()).text());
    if (metadata.format !== 'MWGP-standalone' || metadata.version !== 1) throw new Error(t('sa_unknown_format'));
    const files = new Map();
    async function walk(directory, prefix) {
      for await (const [name, handle] of directory.entries()) {
        const path = prefix + name;
        if (handle.kind === 'directory') await walk(handle, `${path}/`);
        else if (path !== '.mwgp-standalone.json') files.set(path, await handle.getFile());
      }
    }
    await walk(root, '');
    if (!files.has('mwgp.json')) throw new Error(t('sa_no_manifest'));
    return { metadata, files, pageText: null };
  }
  async function loadProject(game, fileName) {
    state.files = new Map(game.files);
    state.original = new Map(game.files);
    state.pageText = game.pageText;
    state.id = game.metadata.id || 'standalone';
    state.manifest = JSON.parse(await game.files.get('mwgp.json').text());
    // Older pages carry no baseline: rebuild it from the manifest, as the
    // server Studio does on its first save.
    state.base = game.files.has('.mwgp-conversion.json')
      ? JSON.parse(await game.files.get('.mwgp-conversion.json').text()) : stripStudio(structuredClone(state.manifest));
    state.protectedPaths = [];
    state.assets = new Map();
    state.revision = 0;
    state.outputName = (fileName || 'jeu').replace(/\.html?$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'jeu';
  }
  function loadNewProject(title) {
    state.manifest = skeletonManifest(title || t('sa_new_fallback'));
    state.base = stripStudio(structuredClone(state.manifest));
    state.files = new Map(); state.original = new Map(); state.pageText = null;
    state.id = 'standalone'; state.protectedPaths = []; state.assets = new Map(); state.revision = 0;
    state.outputName = (title || 'nouveau-projet').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  }

  // The editor asks for a project before anything is open: gate its first
  // /api/studio fetch on the user's choice (a game page, or a blank project).
  let resolveReady;
  state.ready = new Promise(resolve => { resolveReady = resolve; });
  function ensureProject() { return state.manifest ? Promise.resolve() : state.ready; }
  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'studio-open-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(4,8,14,.92);display:grid;place-items:center;padding:20px;';
    overlay.innerHTML = `<div style="max-width:520px;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:28px;color:#f0f6fc;font:14px system-ui;">
      <h1 style="font-size:20px;color:#d2a35b;margin:0 0 12px;">${t('sa_title')}</h1>
      <p style="color:#8b949e;line-height:1.6;">${t('sa_intro')}</p>
      <p id="studio-open-error" style="color:#ff9d97;min-height:20px;"></p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;">
        <button id="studio-open-choose" style="background:#d2a35b;color:#0d1117;border:1px solid #b78343;padding:9px 16px;border-radius:6px;font-weight:700;cursor:pointer;">${t('sa_open_choose')}</button>
        ${typeof window.showDirectoryPicker === 'function' ? `<button id="studio-open-folder" style="background:#21262d;color:#f0f6fc;border:1px solid #30363d;padding:9px 16px;border-radius:6px;font-weight:600;cursor:pointer;">${t('sa_open_folder')}</button>` : ''}
        <button id="studio-open-new" style="background:#21262d;color:#f0f6fc;border:1px solid #30363d;padding:9px 16px;border-radius:6px;font-weight:600;cursor:pointer;">${t('sa_open_new')}</button>
      </div>
      <input id="studio-open-file" type="file" accept=".html,text/html" hidden>
    </div>`;
    document.body.append(overlay);
    const input = overlay.querySelector('#studio-open-file');
    overlay.querySelector('#studio-open-choose').onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await loadProject(await unpack(file), file.name);
        overlay.remove(); resolveReady();
      } catch (error) { overlay.querySelector('#studio-open-error').textContent = error.message; }
    };
    // A game folder unpacked by a large page (gate.js): the folder itself is the game.
    overlay.querySelector('#studio-open-folder')?.addEventListener('click', async () => {
      try {
        const root = await window.showDirectoryPicker({ mode: 'read' });
        await loadProject(await unpackFolder(root), root.name);
        overlay.remove(); resolveReady();
      } catch (error) { overlay.querySelector('#studio-open-error').textContent = error.message; }
    });
    overlay.querySelector('#studio-open-new').onclick = () => {
      const title = prompt(t('sa_new_prompt'), t('my_game'));
      if (title === null) return;
      loadNewProject(title);
      overlay.remove(); resolveReady();
    };
  }

  async function repackBlob() {
    await ensureProject();
    const clean = stripStudio(state.manifest);
    // The player version set in the Studio wins; the fixed default applies
    // when the project does not declare one.
    const playerVersion = typeof clean.playerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(clean.playerVersion)
      ? clean.playerVersion : PLAYER_VERSION;
    const files = [];
    const runtimeFiles = [...state.original].filter(([path]) => path.startsWith('.runtime/'));
    const embedded = runtime.files.map(([path, text]) => [path, new Blob([text])]);
    for (const [path, blob] of (runtimeFiles.length ? runtimeFiles : embedded)) files.push({ path, blob });
    const project = new Map();
    for (const [path, blob] of state.files) if (!path.startsWith('.runtime/')) project.set(path, blob);
    project.set('mwgp.json', new Blob([JSON.stringify(clean)]));
    project.set('.mwgp-conversion.json', new Blob([JSON.stringify(state.base)]));
    if (!project.has('.mwgp-merge-report.json')) project.set('.mwgp-merge-report.json', new Blob(['{"preserved":[],"conflicts":[]}']));
    for (const [path, blob] of project) files.push({ path, blob });
    const header = new TextEncoder().encode(JSON.stringify({ format: 'MWGP-standalone', version: 1,
      playerVersion, id: state.id, files: files.map(({ path, blob }) => ({ path, size: blob.size })) }));
    const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, header.length, true);
    const raw = new Blob([size, header, ...files.map(file => file.blob)]);
    const compressed = await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const bytes = new Uint8Array(await compressed.arrayBuffer());
    // The payload goes out as several <script> elements, each under the engine's
    // string limit (see standalone.js). Only the page's head and tail are
    // strings; the payload is spliced in as Blob parts, never as one string.
    const elements = [];
    let lines = [], lineChars = 0, payloadChars = 0;
    const closeElement = () => { elements.push(`<script data-mwgp-payload type="application/octet-stream">\n${lines.join('')}</script>\n`); lines = []; lineChars = 0; };
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
      const line = base64(bytes.subarray(offset, offset + 512 * 1024)) + '\n';
      if (lineChars > 0 && lineChars + line.length > PAYLOAD_PART_CHARS) closeElement();
      lines.push(line); lineChars += line.length; payloadChars += line.length;
    }
    closeElement();
    let head, tail;
    if (state.pageText) {
      const matches = [...state.pageText.matchAll(PAYLOAD_PATTERN)];
      const last = matches.at(-1);
      head = state.pageText.slice(0, matches[0].index);
      tail = state.pageText.slice(last.index + last[0].length);
    } else {
      const [before, after] = runtime.shell.split('<!-- GAME_PAYLOAD -->');
      head = before;
      tail = '\n<script>' + runtime.bootstrap + '</script>\n' + after;
    }
    // The shell carries its own copy of the version (head meta + visible
    // line, both before the payload): restamp it so the page agrees with its payload.
    head = head.replace(/<meta name="mwgp-player-version" content="[^"]*">/, `<meta name="mwgp-player-version" content="${playerVersion}">`)
      .replace(/(id="player-version"[^>]*>Player MWGP )[^<]*/, `$1${playerVersion}`);
    const gate = runtime.shell.match(/<script id="mwgp-gate">[\s\S]*?<\/script>/)?.[0] || '';
    return new Blob([withSizeData(head, payloadChars, state.id, gate), ...elements, tail], { type: 'text/html;charset=utf-8' });
  }

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const pathname = url => new URL(String(url), location.href).pathname.replace(/^\/[a-z]:/i, '');

  globalThis.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (/^(?:blob|data):/.test(url)) return nativeFetch(input, options);
    const path = pathname(url);
    if (!path.startsWith('/api/')) return nativeFetch(input, options);
    const method = (options.method || input.method || 'GET').toUpperCase();
    try {
      if (path === '/api/games' && method === 'GET') return json({ mwgp: [{ id: state.id }] });
      if (path === '/api/studio/init' && method === 'POST') return json({ error: t('sa_use_new') }, 400);
      const projectMatch = /^\/api\/studio\/([A-Za-z0-9_-]+)$/.exec(path);
      if (projectMatch && method === 'GET') {
        await ensureProject();
        return json({ manifest: state.manifest, protectedPaths: state.protectedPaths,
          protectedAssets: [...state.assets.keys()] });
      }
      if (path === '/api/studio/save' && method === 'POST') {
        await ensureProject();
        const { manifest } = JSON.parse(await new Response(input.body || options.body).text().catch(async () => options.body || '{}'));
        const body = manifest || JSON.parse(options.body || '{}').manifest;
        const errors = validateManifest(stripStudio(body));
        if (errors.length) return json({ error: `Manifeste invalide : ${errors[0]}` }, 400);
        state.manifest = body;
        state.files.set('mwgp.json', new Blob([JSON.stringify(stripStudio(body))]));
        state.protectedPaths = [...new Set([...state.protectedPaths, ...changedPaths(state.base, stripStudio(body))])];
        return json({ ok: true, protectedPaths: state.protectedPaths });
      }
      if (path === '/api/studio/compare' && method === 'POST') {
        await ensureProject();
        const body = JSON.parse(options.body || '{}').manifest || state.manifest;
        const edited = stripStudio(body);
        const preserved = changedPaths(state.base, edited);
        return json({ hasConversion: true, protectedPaths: [...new Set([...state.protectedPaths, ...preserved])],
          preserved, conflicts: [], lastMerge: { preserved: [], conflicts: [] }, edited, fresh: state.base });
      }
      const assetsMatch = /^\/api\/studio\/assets\/([A-Za-z0-9_-]+)$/.exec(path);
      if (assetsMatch) {
        await ensureProject();
        const params = new URL(String(url), location.href).searchParams;
        const assetPath = params.get('path');
        if (method === 'GET' && assetPath === null) {
          const prefix = params.get('prefix') || '';
          const entries = new Map();
          for (const pathKey of state.files.keys()) {
            if (!pathKey.startsWith('assets/') || pathKey.endsWith('/')) continue;
            const relative = pathKey.slice('assets/'.length);
            if (prefix && !relative.startsWith(prefix + '/')) continue;
            const rest = prefix ? relative.slice(prefix.length + 1) : relative;
            const [name, ...more] = rest.split('/');
            if (more.length) { if (!entries.has(name)) entries.set(name, { name, path: prefix ? `${prefix}/${name}` : name, directory: true, text: false }); }
            else {
              const tracked = state.assets.get(relative);
              entries.set(name, { name, path: relative, directory: false, text: isTextAsset(relative),
                ...(tracked ? { protected: true, divergent: tracked.editedHash !== tracked.freshHash,
                  baseHash: tracked.baseHash, editedHash: tracked.editedHash, freshHash: tracked.freshHash } : {}) });
            }
          }
          return json({ revision: state.revision, prefix, entries: [...entries.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) });
        }
        if (assetPath !== null) {
          const key = 'assets/' + assetPath;
          if (method === 'GET') {
            const version = params.get('version') || 'edited';
            const tracked = state.assets.get(assetPath);
            const blob = version === 'edited' ? state.files.get(key)
              : version === 'base' ? (tracked?.base ?? state.original.get(key)) : state.original.get(key);
            return blob ? new Response(blob) : new Response(null, { status: 404 });
          }
          if (method === 'POST') {
            const bytes = new Uint8Array(await (options.body instanceof Blob ? options.body : new Blob([options.body])).arrayBuffer());
            if (assetPath.toLowerCase().endsWith('.json')) JSON.parse(new TextDecoder().decode(bytes));
            if (assetPath.toLowerCase().endsWith('.js')) new Function(new TextDecoder().decode(bytes));
            let tracked = state.assets.get(assetPath);
            if (!tracked) {
              const original = state.original.get(key) || state.files.get(key) || new Blob([]);
              tracked = { base: original, fresh: original, baseHash: await sha256(original), freshHash: await sha256(original) };
              state.assets.set(assetPath, tracked);
            }
            const blob = new Blob([bytes]);
            tracked.editedHash = await sha256(blob);
            state.files.set(key, blob);
            state.revision++;
            if (state.manifest.assets) state.manifest.assets.revision = state.revision;
            return json({ revision: state.revision, path: assetPath, protected: true,
              baseHash: tracked.baseHash, editedHash: tracked.editedHash, freshHash: tracked.freshHash });
          }
        }
      }
      return json({ error: `Route autonome non disponible : ${path}` }, 404);
    } catch (error) { return json({ error: error.message }, 400); }
  };

  globalThis.open = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('/player.html')) {
      const win = nativeOpen('', '_blank');
      repackBlob().then(blob => { if (win) win.location = URL.createObjectURL(blob); });
      return win;
    }
    return nativeOpen(url, ...rest);
  };

  buildOverlay();
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) {
    const download = document.createElement('button');
    download.id = 'studio-download-game';
    download.className = 'btn';
    download.textContent = t('sa_download_page');
    download.title = t('sa_download_title');
    download.onclick = async () => {
      const blob = await repackBlob();
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `${state.outputName}.html`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
    };
    toolbar.append(download);
  }
}
