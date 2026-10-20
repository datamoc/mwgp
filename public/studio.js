// MWGP Studio — Universal Web Editor for converted RPG Maker games (DOC59 rev4)
import { setupAssetEditor } from './studio-assets.js';
import { t, setupLangSelect } from './i18n.js';

let projectId = new URLSearchParams(location.search).get('id');
let project = null;
let saveCurrentProject = null;   // setupToolbar exposes its saveProject here (from-scratch creation buttons)
let activeMap = null;
let selectedEvent = null;
let activeTool = 'inspect';
let activeBrush = 1; // Tile ID or preset
let activeLayer = 0;
let zoom = 1.0;
let showGrid = true;
let protectedPaths = [];
let protectedAssets = [];
const modifiedEntities = new Set(); // Set of 'map:id', 'event:mapId:eventId', 'db:actors:id'

// Tile presets for quick painting
const TILE_PRESETS = [
  { id: 2816, nameKey: 'tile_grass', color: '#4a8532' },
  { id: 2048, nameKey: 'tile_water', color: '#2b6cb0' },
  { id: 2912, nameKey: 'tile_dirt', color: '#9c7a44' },
  { id: 3328, nameKey: 'tile_stone', color: '#718096' },
  { id: 4352, nameKey: 'tile_wall', color: '#4a5568' },
  { id: 5120, nameKey: 'tile_roof', color: '#9b2c2c' },
  { id: 1536, nameKey: 'tile_sand', color: '#d69e2e' },
  { id: 6144, nameKey: 'tile_wood', color: '#7b341e' },
  { id: 0,    nameKey: 'tile_empty', color: '#1a202c' }
];

// --- Hashing & DOC59 originHash tracking ---

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k === 'studio') continue;
      out[k] = stable(value[k]);
    }
    return out;
  }
  return value;
}

// Simple synchronous string hash for fast comparison + hex conversion
function hashString(str) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return (hex1 + hex2).slice(0, 16);
}

function hashEntity(entity) {
  return hashString(JSON.stringify(stable(entity)));
}

function stamp(entity, target = entity) {
  if (!entity.studio) entity.studio = {};
  if (!entity.studio.originHash) entity.studio.originHash = hashEntity(target);
  return entity;
}

function isModified(entity) {
  return Boolean(entity?.studio?.protected) || Boolean(entity?.studio?.originHash) && hashEntity(entity) !== entity.studio.originHash;
}

// Same entity boundaries as tools/mwgp-studio.mjs: a map's stamp covers its own
// fields (tiles/info), not its events, so painting and dialogue edits are
// tracked (and protected on reconversion) independently.
function mapOwn(m) { const { mwgEvents, ...own } = m; return own; }
function isMapModified(m) {
  return Boolean(m?.studio?.protected) || Boolean(m?.studio?.originHash) && hashEntity(mapOwn(m)) !== m.studio.originHash;
}

function applyProtection() {
  const covers = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`);
  for (const map of project.maps || []) {
    const prefix = `/maps/${map.id}`;
    // entities created in the editor arrive without a stamp block; protection must mark them, not crash
    (map.studio ??= {}).protected = protectedPaths.some(path => covers(path, prefix) && !path.startsWith(`${prefix}/mwgEvents/`));
    for (const event of map.mwgEvents || []) {
      (event.studio ??= {}).protected = protectedPaths.some(path => covers(path, `${prefix}/mwgEvents/${event.id}`));
    }
  }
  for (const [table, rows] of Object.entries(project.database || {})) {
    if (Array.isArray(rows)) rows.forEach((row, index) => {
      if (row && typeof row === 'object') (row.studio ??= {}).protected = protectedPaths.some(path => covers(path, `/database/${table}/${index}`));
    });
  }
  modifiedEntities.clear();
  protectedPaths.forEach(path => modifiedEntities.add(path));
  protectedAssets.forEach(path => modifiedEntities.add(`assets/${path}`));
  updateModificationBadges();
}
// Real converted maps nest tiles/dimensions in map.data ({width,height,data});
// a flat numeric map.data is accepted for older/synthetic manifests.
function mapDims(m) {
  return { width: Number(m?.data?.width ?? m?.width ?? 0) || 20, height: Number(m?.data?.height ?? m?.height ?? 0) || 15 };
}
function mapTiles(m) {
  if (Array.isArray(m?.data)) return m.data;
  if (Array.isArray(m?.data?.data)) return m.data.data;
  return [];
}

function unstamped(entity) {
  if (Array.isArray(entity)) return entity.map(unstamped);
  if (entity && typeof entity === 'object') return Object.fromEntries(Object.entries(entity)
    .filter(([key]) => key !== 'studio').map(([key, value]) => [key, unstamped(value)]));
  return entity;
}

function notify(text, isError = false) {
  const toast = document.querySelector('#toast');
  toast.textContent = text;
  toast.style.borderColor = isError ? 'var(--danger)' : 'var(--accent)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- Initialization ---

async function init() {
  setupLangSelect(() => {
    if (!project) return;
    populateMapList(document.querySelector('#map-search')?.value || '');
    populateActorList();
    renderGenericDb();
    setupPalette();
    updateEventInspector();
    updateToolHint();
    drawCanvas();
  });
  document.querySelector('#btn-new-project')?.addEventListener('click', async () => {
    const name = prompt(t('new_project_prompt'), t('my_game'));
    if (!name) return;
    const response = await fetch('/api/studio/init', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const result = await response.json();
    if (!response.ok) { alert(t('create_failed', { message: result.error || response.status })); return; }
    location.search = `?id=${encodeURIComponent(result.id)}`;
  });
  if (!projectId) {
    // Attempt to list games and pick first MWGP game
    try {
      const catalog = await fetch('/api/games').then(r => r.json());
      if (catalog.mwgp && catalog.mwgp.length > 0) {
        projectId = catalog.mwgp[0].id;
        history.replaceState(null, '', `?id=${encodeURIComponent(projectId)}`);
      } else {
        alert(t('no_project'));
        return;
      }
    } catch (e) {
      alert(t('catalog_error', { message: e.message }));
      return;
    }
  }

  try {
    notify(t('loading_project'));
    const res = await fetch(`/api/studio/${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error(t('load_failed', { status: res.status }));
    const loaded = await res.json();
    project = loaded.manifest;
    protectedPaths = loaded.protectedPaths;
    protectedAssets = loaded.protectedAssets;
    setupProject();
  } catch (err) {
    notify(t('load_error', { message: err.message }), true);
    console.error(err);
  }
}

function setupProject() {
  document.querySelector('#project-title').textContent = project.display?.title || project.title || t('untitled');
  // The player version belongs to the project: it is saved into mwgp.json and
  // stamped into standalone game pages when they are created.
  const versionInput = document.querySelector('#player-version');
  if (versionInput) {
    versionInput.value = project.playerVersion || '0.0.1';
    versionInput.onchange = () => {
      const value = versionInput.value.trim();
      if (!/^\d+\.\d+\.\d+$/.test(value)) { notify(t('version_invalid'), true); versionInput.value = project.playerVersion || '0.0.1'; return; }
      project.playerVersion = value;
      markModified(project, 'player:version');
      notify(t('version_set', { version: value }));
    };
  }
  const engine = project.source?.engine || (project.tilesetFormat ? 'RPG Maker XP' : 'RPG Maker MV/MZ');
  document.querySelector('#engine-badge').textContent = engine;

  // Stamp all maps, events, database rows with originHash (map stamp excludes events)
  for (const m of project.maps || []) {
    stamp(m, mapOwn(m));
    for (const e of m.mwgEvents || []) stamp(e);
  }
  for (const [table, rows] of Object.entries(project.database || {})) {
    if (Array.isArray(rows)) {
      for (const r of rows) if (r && typeof r === 'object') stamp(r);
    }
  }

  // Setup UI tabs & buttons
  applyProtection();
  setupTabs();
  setupTools();
  setupPalette();
  setupToolbar();
  populateMapList();
  populateActorList();
  renderGenericDb();

  // Pick initial map or first map
  const initId = project.initialMapId ?? project.maps?.[0]?.id;
  selectMap(initId);
}

// --- Tabs & Toolbars ---

function setupTabs() {
  const tabs = document.querySelectorAll('.panel-tab[data-tab]');
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector('#tab-maps').style.display = tab.dataset.tab === 'maps' ? 'flex' : 'none';
      document.querySelector('#tab-database').style.display = tab.dataset.tab === 'database' ? 'flex' : 'none';
      document.querySelector('#tab-tools').style.display = tab.dataset.tab === 'tools' ? 'flex' : 'none';
    };
  });
}

function setupTools() {
  const toolBtns = document.querySelectorAll('.tool-btn[data-tool]');
  toolBtns.forEach(btn => {
    btn.onclick = () => {
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTool = btn.dataset.tool;
      updateToolHint();
    };
  });

  const layerSel = document.querySelector('#layer-select');
  layerSel.onchange = () => { activeLayer = Number(layerSel.value); };

  const customTile = document.querySelector('#custom-tile-id');
  customTile.oninput = () => { activeBrush = Number(customTile.value) || 0; };

  document.querySelector('#toggle-grid').onchange = (e) => {
    showGrid = e.target.checked;
    drawCanvas();
  };

  document.querySelector('#zoom-in').onclick = () => {
    zoom = Math.min(3.0, zoom + 0.25);
    updateZoom();
  };
  document.querySelector('#zoom-out').onclick = () => {
    zoom = Math.max(0.5, zoom - 0.25);
    updateZoom();
  };
}

function updateZoom() {
  document.querySelector('#zoom-level').textContent = Math.round(zoom * 100) + '%';
  drawCanvas();
}

function updateToolHint() {
  const hints = {
    'inspect': t('hint_inspect'),
    'paint': t('hint_paint', { layer: activeLayer }),
    'player': t('hint_player'),
    'add-event': t('hint_event')
  };
  document.querySelector('#tool-hint').textContent = hints[activeTool] || '';
}

function setupPalette() {
  const grid = document.querySelector('#palette-grid');
  grid.innerHTML = TILE_PRESETS.map((p, idx) => `
    <button class="tile-btn ${idx === 0 ? 'active' : ''}" data-tile-id="${p.id}">
      <span class="tile-swatch" style="background:${p.color}"></span>
      <span>${t(p.nameKey)}</span>
    </button>
  `).join('');

  grid.querySelectorAll('.tile-btn').forEach(b => {
    b.onclick = () => {
      grid.querySelectorAll('.tile-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      activeBrush = Number(b.dataset.tileId);
      document.querySelector('#custom-tile-id').value = activeBrush;
      // switch to paint tool
      document.querySelector('.tool-btn[data-tool="paint"]').click();
    };
  });
}

function setupToolbar() {
  saveCurrentProject = saveProject;   // expose save for creation buttons wired outside this closure
  // From-scratch creation: the editor can grow a project it owns (maps and database rows),
  // then everything goes through the same protected save as any edit.
  document.querySelector('#btn-add-map')?.addEventListener('click', async () => {
    const name = prompt(t('map_name_prompt'), t('map_default', { count: (project.maps?.length || 0) + 1 }));
    if (name === null) return;
    const width = Math.max(1, Number(prompt(t('width_prompt'), '20')) || 20);
    const height = Math.max(1, Number(prompt(t('height_prompt'), '15')) || 15);
    const id = Math.max(0, ...(project.maps || []).map(m => Number(m.id) || 0)) + 1;
    const tilesetId = (project.tilesets || []).findIndex(Boolean) || 1;
    // mirror of skeletonMap() in src/studio-manifest.js: same shape the converter publishes
    const map = { id, info: { name, width, height }, tilesetId,
      data: { width, height, tilesetId, displayName: name, events: [], data: new Array(width * height * 6).fill(0) },
      mwgEvents: [] };
    (project.maps ??= []).push(map);
    if (await saveProject()) { populateMapList(); selectMap(id); notify(t('map_created', { id })); }
  });
  setupAssetEditor({ projectId, notify, onSaved: data => {
    project.assets.revision = data.revision;
    protectedAssets = [...new Set([...protectedAssets, data.path])];
    applyProtection();
  } });
  // Play
  document.querySelector('#btn-play').onclick = async () => {
    if (!await saveProject()) return;
    const mapParam = activeMap ? `&map=${activeMap.id}` : '';
    window.open(`/player.html?id=${encodeURIComponent(projectId)}${mapParam}`, '_blank');
  };

  // Save
  async function saveProject() {
    try {
      notify(t('saving'));
      const res = await fetch('/api/studio/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, manifest: project })
      });
      const data = await res.json();
      if (data.ok) {
        protectedPaths = data.protectedPaths;
        applyProtection();
        populateMapList();
        populateActorList();
        updateEventInspector();
        notify(t('saved'));
        updateModificationBadges();
        return true;
      } else {
        throw new Error(data.error || t('worker_error'));
      }
    } catch (e) {
      notify(t('save_error', { message: e.message }), true);
      return false;
    }
  }
  document.querySelector('#btn-save').onclick = saveProject;
  document.querySelector('#btn-manifest').onclick = () => {
    document.querySelector('#manifest-json').value = JSON.stringify(unstamped(project), null, 2);
    document.querySelector('#manifest-dialog').showModal();
  };
  document.querySelector('#btn-apply-manifest').onclick = () => {
    try {
      const next = JSON.parse(document.querySelector('#manifest-json').value);
      if (next.format !== 'MWGP' || !Array.isArray(next.maps) || !next.maps.length) throw new Error(t('manifest_required'));
      project = next;
      setupProject();
      document.querySelector('#mod-badge').textContent = t('modifications', { count: 1 });
      document.querySelector('#manifest-dialog').close();
      notify(t('manifest_applied'));
    } catch (error) { notify(error.message, true); }
  };

  // Export JSON
  document.querySelector('#btn-export').onclick = () => {
    // Publish: clone and strip stamps
    const playManifest = unstamped(project);
    const blob = new Blob([JSON.stringify(playManifest, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.display?.title || 'mwgp'}.play.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify(t('exported'));
  };

  // Compare the current editor content with the last actual conversion.
  document.querySelector('#btn-reconvert').onclick = () => {
    compareConversion();
  };
}

// --- Map List & Selection ---

function populateMapList(filter = '') {
  const container = document.querySelector('#map-list');
  const searchLower = filter.toLowerCase();
  const maps = (project.maps || []).filter(m => {
    const name = (m.info?.name || m.name || t('map_default', { count: m.id })).toLowerCase();
    return name.includes(searchLower) || String(m.id).includes(searchLower);
  });

  container.innerHTML = maps.map(m => {
    const name = m.info?.name || m.name || t('map_default', { count: m.id });
    const evCount = m.mwgEvents ? m.mwgEvents.length : 0;
    const { width: w, height: h } = mapDims(m);
    const mod = isMapModified(m) || (m.mwgEvents || []).some(isModified);
    const active = activeMap && activeMap.id === m.id;
    return `
      <div class="item-row ${active ? 'active' : ''}" data-map-id="${escapeHtml(m.id)}">
        <div class="item-info">
          <span class="item-title">${escapeHtml(name)}</span>
          <span class="item-sub">#${escapeHtml(m.id)} · ${w}×${h} · ${t('ev_suffix', { count: evCount })}</span>
        </div>
        ${mod ? `<span class="badge modified">${t('modified')}</span>` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.item-row').forEach(row => {
    row.onclick = () => selectMap(Number(row.dataset.mapId));
  });

  document.querySelector('#map-search').oninput = (e) => {
    populateMapList(e.target.value);
  };
}

function selectMap(mapId) {
  const m = project.maps?.find(x => x.id === mapId);
  if (!m) return;
  activeMap = m;
  selectedEvent = null;

  // Dimensions come from the nested map.data of converted manifests
  const dims = mapDims(activeMap);

  // Update header info
  const name = activeMap.info?.name || activeMap.name || t('map_default', { count: activeMap.id });
  document.querySelector('#map-header-info').textContent =
    t('map_header', { id: activeMap.id, name, w: dims.width, h: dims.height });

  populateMapList(document.querySelector('#map-search').value);
  updateEventInspector();
  drawCanvas();
}

// --- Canvas Rendering & Interaction ---

const canvas = document.querySelector('#map-canvas');
const ctx = canvas.getContext('2d');
const TILE_SIZE = 32;

function drawCanvas() {
  if (!activeMap) return;
  const { width: w, height: h } = mapDims(activeMap);
  const ts = Math.round(TILE_SIZE * zoom);

  canvas.width = w * ts;
  canvas.height = h * ts;

  // 1. Draw Tiles
  const data = mapTiles(activeMap);
  const layerSize = w * h;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const tile0 = data[idx] || 0;
      const tile1 = data[layerSize + idx] || 0;

      // Determine background color based on tile
      ctx.fillStyle = tileColor(tile0, tile1);
      ctx.fillRect(x * ts, y * ts, ts, ts);
    }
  }

  // 2. Draw Grid
  if (showGrid && ts >= 12) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x++) {
      ctx.beginPath();
      ctx.moveTo(x * ts, 0);
      ctx.lineTo(x * ts, h * ts);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * ts);
      ctx.lineTo(w * ts, y * ts);
      ctx.stroke();
    }
  }

  // 3. Draw Events
  for (const ev of activeMap.mwgEvents || []) {
    const ex = ev.x * ts;
    const ey = ev.y * ts;
    const isSel = selectedEvent && selectedEvent.id === ev.id;
    const mod = isModified(ev);

    ctx.fillStyle = mod ? '#b7791f' : '#2b6cb0';
    ctx.fillRect(ex + 4, ey + 4, ts - 8, ts - 8);

    ctx.strokeStyle = isSel ? '#f6e05e' : (mod ? '#ecc94b' : '#63b3ed');
    ctx.lineWidth = isSel ? 3 : 1;
    ctx.strokeRect(ex + 4, ey + 4, ts - 8, ts - 8);

    // Event text
    if (ts >= 20) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(9, Math.round(11 * zoom))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = (ev.name || `E${ev.id}`).slice(0, 4);
      ctx.fillText(label, ex + ts / 2, ey + ts / 2);
    }
  }

  // 4. Draw Player Start Position
  if (project.player && (project.player.mapId === activeMap.id || project.initialMapId === activeMap.id)) {
    const px = (project.player.x ?? 0) * ts;
    const py = (project.player.y ?? 0) * ts;

    ctx.fillStyle = '#e53e3e';
    ctx.beginPath();
    ctx.arc(px + ts / 2, py + ts / 2, ts / 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(9, Math.round(12 * zoom))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', px + ts / 2, py + ts / 2);
  }
}

function tileColor(t0, t1) {
  // Preset match or procedural palette
  if (t0 === 0 && t1 === 0) return '#1a202c';
  // Water range in RPG Maker
  if ((t0 >= 2048 && t0 < 2816) || t0 === 2048) return '#2b6cb0';
  // Grass range
  if ((t0 >= 2816 && t0 < 3328) || t0 === 2816) return '#38a169';
  // Dirt / Path range
  if ((t0 >= 3328 && t0 < 4352) || t0 === 2912) return '#975a16';
  // Stone / Walls range
  if (t0 >= 4352 && t0 < 5888) return '#4a5568';
  // Upper layer decoration hint
  if (t1 > 0) return '#2f855a';
  return '#2d3748';
}

// Canvas mouse events
canvas.addEventListener('mousemove', (e) => {
  if (!activeMap) return;
  const rect = canvas.getBoundingClientRect();
  const ts = Math.round(TILE_SIZE * zoom);
  const x = Math.floor((e.clientX - rect.left) / ts);
  const y = Math.floor((e.clientY - rect.top) / ts);

  const { width, height } = mapDims(activeMap);
  if (x >= 0 && x < width && y >= 0 && y < height) {
    const idx = y * width + x;
    const tileVal = mapTiles(activeMap)[idx] || 0;
    document.querySelector('#cursor-pos').textContent = t('cursor', { x, y, tile: tileVal });
  }
});

canvas.addEventListener('click', (e) => {
  if (!activeMap) return;
  const rect = canvas.getBoundingClientRect();
  const ts = Math.round(TILE_SIZE * zoom);
  const x = Math.floor((e.clientX - rect.left) / ts);
  const y = Math.floor((e.clientY - rect.top) / ts);

  const { width, height } = mapDims(activeMap);
  if (x < 0 || x >= width || y < 0 || y >= height) return;

  if (activeTool === 'inspect') {
    // Check if event clicked
    const ev = (activeMap.mwgEvents || []).find(it => it.x === x && it.y === y);
    selectedEvent = ev || null;
    updateEventInspector();
    drawCanvas();
  } else if (activeTool === 'paint') {
    paintTile(x, y);
  } else if (activeTool === 'player') {
    setPlayerPos(x, y);
  } else if (activeTool === 'add-event') {
    addNewEvent(x, y);
  }
});

function paintTile(x, y) {
  const { width: w, height: h } = mapDims(activeMap);
  let tiles = mapTiles(activeMap);
  if (!tiles.length) {
    const flat = new Array(w * h * 6).fill(0);
    if (activeMap.data && !Array.isArray(activeMap.data)) activeMap.data.data = flat; else activeMap.data = flat;
    tiles = flat;
  }
  const layerSize = w * h;
  const idx = activeLayer * layerSize + (y * w + x);

  tiles[idx] = activeBrush;
  markModified(activeMap, `map:${activeMap.id}`);
  drawCanvas();
  populateMapList(document.querySelector('#map-search').value);
  notify(t('tile_painted', { x, y, tile: activeBrush }));
}

function setPlayerPos(x, y) {
  if (!project.player) project.player = {};
  project.player.mapId = activeMap.id;
  project.player.x = x;
  project.player.y = y;
  project.initialMapId = activeMap.id;
  stamp(project.player);
  markModified(project.player, 'player:start');
  drawCanvas();
  notify(t('player_moved', { x, y }));
}

function addNewEvent(x, y) {
  if (!activeMap.mwgEvents) activeMap.mwgEvents = [];
  const nextId = (Math.max(0, ...activeMap.mwgEvents.map(e => e.id)) || 0) + 1;
  const newEv = {
    id: nextId,
    name: t('event_default_name', { id: nextId }),
    x,
    y,
    pages: [{
      trigger: 'action',
      commands: [
        { say: t('new_message') }
      ]
    }]
  };
  stamp(newEv);
  activeMap.mwgEvents.push(newEv);
  selectedEvent = newEv;
  markModified(newEv, `event:${activeMap.id}:${newEv.id}`);
  markModified(activeMap, `map:${activeMap.id}`);
  updateEventInspector();
  drawCanvas();
  populateMapList(document.querySelector('#map-search').value);
  notify(t('event_created', { id: nextId, x, y }));
}

function markModified(entity, idString) {
  if (idString) modifiedEntities.add(idString);
  updateModificationBadges();
}

function updateModificationBadges() {
  const modCount = modifiedEntities.size;
  const badge = document.querySelector('#mod-badge');
  if (modCount > 0) {
    badge.className = 'badge modified';
    badge.textContent = t('modifications', { count: modCount });
  } else {
    badge.className = 'badge ok';
    badge.textContent = t('not_modified');
  }
}

// --- Event Inspector & Commands ---

function updateEventInspector() {
  const noSel = document.querySelector('#no-event-selected');
  const editor = document.querySelector('#event-editor');

  if (!selectedEvent) {
    noSel.style.display = 'block';
    editor.style.display = 'none';
    return;
  }

  noSel.style.display = 'none';
  editor.style.display = 'flex';

  document.querySelector('#evt-id-badge').textContent = `ID #${selectedEvent.id}`;
  const mod = isModified(selectedEvent);
  const modBadge = document.querySelector('#evt-mod-badge');
  modBadge.className = mod ? 'badge modified' : 'badge ok';
  modBadge.textContent = mod ? t('modified_protected') : t('original');

  document.querySelector('#evt-name').value = selectedEvent.name || '';
  document.querySelector('#evt-x').value = selectedEvent.x;
  document.querySelector('#evt-y').value = selectedEvent.y;

  const page = selectedEvent.pages?.[0] || { commands: [] };
  const triggerMap = { 'action': 0, 'touch': 1, 'autorun': 3, 'parallel': 4 };
  document.querySelector('#evt-trigger').value = triggerMap[page.trigger] ?? 0;

  renderCommandList(page.commands || []);
  wireDeleteEvent();

  // Wire Add Command button
  document.querySelector('#btn-add-cmd').onclick = () => {
    (selectedEvent.pages ??= [])[0] = page;
    if (!page.commands) page.commands = [];
    page.commands.push({ say: t('text_to_show') });
    renderCommandList(page.commands);
  };

  // Wire Apply button
  document.querySelector('#btn-apply-event').onclick = () => {
    (selectedEvent.pages ??= [])[0] = page;
    selectedEvent.name = document.querySelector('#evt-name').value;
    selectedEvent.x = Number(document.querySelector('#evt-x').value);
    selectedEvent.y = Number(document.querySelector('#evt-y').value);

    const triggers = ['action', 'touch', 'touch', 'autorun', 'parallel'];
    page.trigger = triggers[Number(document.querySelector('#evt-trigger').value)] || 'action';

    // Commit commands from inputs
    const cmdList = document.querySelector('#cmd-list');
    cmdList.querySelectorAll('.cmd-box').forEach((box, i) => {
      const type = box.dataset.type;
      if (type === 'say') {
        const txt = box.querySelector('textarea').value;
        page.commands[i] = { ...page.commands[i], say: txt };
      } else if (type === 'setSwitch') {
        const swId = box.querySelector('.sw-id').value;
        const swVal = box.querySelector('.sw-val').value === 'true';
        page.commands[i] = { ...page.commands[i], setSwitch: swId, value: swVal };
      } else if (type === 'other' || type === 'ask') {
        try { page.commands[i] = JSON.parse(box.querySelector('.cmd-json, textarea').value); }
        catch (err) { notify(t('invalid_cmd_json', { message: err.message }), true); throw err; }
      }
    });

    markModified(selectedEvent, `event:${activeMap.id}:${selectedEvent.id}`);
    updateEventInspector();
    drawCanvas();
    populateMapList(document.querySelector('#map-search').value);
    notify(t('event_updated', { id: selectedEvent.id }));
  };
}

function renderCommandList(commands) {
  const container = document.querySelector('#cmd-list');
  if (!commands || commands.length === 0) {
    container.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">${t('no_commands')}</span>`;
    return;
  }

  container.innerHTML = commands.map((c, i) => {
    if (typeof c.say === 'string') {
      return `
        <div class="cmd-box" data-type="say" data-idx="${i}">
          <div class="cmd-header">
            <span>${t('cmd_say')}</span>
            <button class="btn-del-cmd" style="padding:0 4px; font-size:10px; background:transparent; border:none; color:var(--danger);">✕</button>
          </div>
          <textarea rows="2">${escapeHtml(c.say)}</textarea>
        </div>
      `;
    }
    if (c.ask) {
      const prompt = c.ask.prompt || c.ask;
      return `
        <div class="cmd-box" data-type="ask" data-idx="${i}">
          <div class="cmd-header">
            <span>${t('cmd_ask')}</span>
            <button class="btn-del-cmd" style="padding:0 4px; font-size:10px; background:transparent; border:none; color:var(--danger);">✕</button>
          </div>
          <span style="font-size:12px;">${t('prompt_label')} ${escapeHtml(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))}</span>
          <textarea rows="3" class="cmd-json">${escapeHtml(JSON.stringify(c))}</textarea>
        </div>
      `;
    }
    if (c.setSwitch != null) {
      const sw = { id: c.setSwitch, value: c.value };
      return `
        <div class="cmd-box" data-type="setSwitch" data-idx="${i}">
          <div class="cmd-header">
            <span>${t('cmd_switch')}</span>
            <button class="btn-del-cmd" style="padding:0 4px; font-size:10px; background:transparent; border:none; color:var(--danger);">✕</button>
          </div>
          <div style="display:flex; gap:6px;">
            <input type="text" class="sw-id" value="${escapeHtml(sw.id)}" style="width:100px;">
            <select class="sw-val">
              <option value="true" ${sw.value ? 'selected' : ''}>${t('on')}</option>
              <option value="false" ${!sw.value ? 'selected' : ''}>${t('off')}</option>
            </select>
          </div>
        </div>
      `;
    }
    // Every other MWGP command the player can execute stays editable as JSON
    const key = Object.keys(c)[0] || 'unknown';
    return `
      <div class="cmd-box" data-type="other" data-idx="${i}">
        <div class="cmd-header">
          <span>[${escapeHtml(key)}]</span>
          <button class="btn-del-cmd" style="padding:0 4px; font-size:10px; background:transparent; border:none; color:var(--danger);">✕</button>
        </div>
        <textarea rows="3" class="cmd-json">${escapeHtml(JSON.stringify(c))}</textarea>
      </div>
    `;
  }).join('');

  // Wire delete buttons
  container.querySelectorAll('.btn-del-cmd').forEach(btn => {
    btn.onclick = (e) => {
      const box = e.target.closest('.cmd-box');
      const idx = Number(box.dataset.idx);
      commands.splice(idx, 1);
      renderCommandList(commands);
    };
  });
}

// --- Database Actors ---

function populateActorList() {
  const container = document.querySelector('#actor-list');
  const actors = project.database?.actors || [];
  // MV/MZ actors array is 1-based, filter nulls
  const validActors = actors.filter(a => a && typeof a === 'object');

  container.innerHTML = validActors.map(a => {
    const mod = isModified(a);
    return `
      <div class="item-row" data-actor-id="${escapeHtml(a.id)}">
        <div class="item-info">
          <span class="item-title">${escapeHtml(a.name || 'Sans nom')}</span>
          <span class="item-sub">ID #${escapeHtml(a.id)} · ${escapeHtml(a.profile || a.description || t('actor_fallback'))}</span>
        </div>
        ${mod ? `<span class="badge modified">${t('modified')}</span>` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.item-row').forEach(row => {
    row.onclick = () => selectActor(Number(row.dataset.actorId));
  });
}

function selectActor(actorId) {
  const actor = (project.database?.actors || []).find(a => a && a.id === actorId);
  if (!actor) return;

  const editor = document.querySelector('#actor-editor');
  editor.style.display = 'flex';

  document.querySelector('#act-name').value = actor.name || '';
  document.querySelector('#act-profile').value = actor.profile || actor.description || '';

  document.querySelector('#btn-apply-actor').onclick = () => {
    actor.name = document.querySelector('#act-name').value;
    actor.profile = document.querySelector('#act-profile').value;

    markModified(actor, `db:actors:${actor.id}`);
    populateActorList();
    notify(t('actor_updated', { id: actor.id }));
  };
}

// --- Generic database editor: every table the player reads (actors, classes,
// skills, items, weapons, armors, enemies, troops, states, ...) is editable.
// Rows are edited as JSON, so no player-visible field is out of reach.
function renderGenericDb() {
  const tab = document.querySelector('#tab-database');
  if (!tab) return;
  document.querySelector('#generic-db')?.remove();
  const box = document.createElement('div');
  box.id = 'generic-db';
  box.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;border-top:1px solid var(--border);padding-top:8px;';
  const tables = Object.keys(project.database || {}).filter(t => Array.isArray(project.database[t]));
  box.innerHTML = `<h3 style="font-size:13px;color:var(--accent);">${t('db_full')}</h3>
    <select id="gdb-table">${tables.map(t => `<option>${escapeHtml(t)}</option>`).join('')}</select>
    <button id="gdb-add-row" class="btn" style="margin:6px 0;">${t('new_row')}</button>
    <div id="gdb-rows" style="display:flex;flex-direction:column;gap:6px;"></div>`;
  tab.appendChild(box);
  box.querySelector('#gdb-table').onchange = renderGenericDbRows;
  // Rows of every kind (actors, items, weapons, …) can be created, not only edited.
  box.querySelector('#gdb-add-row').onclick = async () => {
    const table = box.querySelector('#gdb-table').value;
    if (!table) return;
    const rows = (project.database[table] ||= []);
    const name = prompt(t('row_name_prompt', { table }), t('new_name'));
    if (name === null) return;
    const id = Math.max(0, ...rows.map((r, i) => Number(r?.id) || i)) + 1;
    while (rows.length <= id) rows.push(null);
    rows[id] = { id, name };
    if (saveCurrentProject && await saveCurrentProject()) notify(t('row_created', { table, id }));
    renderGenericDbRows();
    populateActorList();
  };
  renderGenericDbRows();
}

function renderGenericDbRows() {
  const table = document.querySelector('#gdb-table')?.value;
  const host = document.querySelector('#gdb-rows');
  if (!table || !host) return;
  const rows = (project.database[table] || []).map((r, i) => [r, i]).filter(([r]) => r && typeof r === 'object');
  host.innerHTML = rows.slice(0, 40).map(([r]) => `
    <div class="cmd-box"><div class="cmd-header"><span>${escapeHtml(table)} #${escapeHtml(r.id ?? '')} ${escapeHtml(r.name || '')}</span>${isModified(r) ? `<span class="badge modified">${t('modified')}</span>` : ''}</div>
    <textarea rows="4" class="gdb-json" data-id="${escapeHtml(r.id)}">${escapeHtml(JSON.stringify(unstamped(r)))}</textarea>
    <button class="gdb-apply" data-id="${escapeHtml(r.id)}">${t('apply_row')}</button></div>`).join('') || `<span style="font-size:12px;">${t('no_rows')}</span>`;
  host.querySelectorAll('.gdb-apply').forEach(btn => {
    btn.onclick = () => {
      const row = (project.database[table] || []).find(r => r && String(r.id) === btn.dataset.id);
      try {
        const parsed = JSON.parse(btn.parentElement.querySelector('.gdb-json').value);
        const studio = row.studio;
        for (const k of Object.keys(row)) if (k !== 'studio') delete row[k];
        Object.assign(row, parsed);
        if (studio) row.studio = studio;
        markModified(row, `db:${table}:${row.id}`);
        renderGenericDbRows();
        populateActorList();
        notify(t('row_updated', { table, id: row.id }));
      } catch (err) { notify(t('invalid_json', { message: err.message }), true); }
    };
  });
}

// Event deletion (player-visible: a removed event must stay removed and protected)
function wireDeleteEvent() {
  const editor = document.querySelector('#event-editor');
  if (!editor || document.querySelector('#btn-delete-event')) return;
  const btn = document.createElement('button');
  btn.id = 'btn-delete-event';
  btn.textContent = t('delete_event');
  btn.style.cssText = 'background:var(--danger);color:#fff;';
  editor.appendChild(btn);
  btn.onclick = () => {
    if (!selectedEvent || !activeMap) return;
    activeMap.mwgEvents = (activeMap.mwgEvents || []).filter(e => e !== selectedEvent);
    markModified(activeMap, `map:${activeMap.id}`);
    modifiedEntities.add(`event:${activeMap.id}:${selectedEvent.id}`);
    selectedEvent = null;
    updateEventInspector();
    drawCanvas();
    populateMapList(document.querySelector('#map-search').value);
    notify(t('event_deleted'));
  };
}

// --- Comparison with the converter's persisted output ---

async function compareConversion() {
  const box = document.querySelector('#reconvert-box');
  const reportEl = document.querySelector('#reconvert-report');
  box.style.display = 'flex';

  try {
    const response = await fetch('/api/studio/compare', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: projectId, manifest: project }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t('compare_failed'));
    reportEl.textContent = JSON.stringify(data, null, 2);
    reportEl.style.whiteSpace = 'pre-wrap';
    notify(t('compare_done', { protected: data.protectedPaths.length, conflicts: data.conflicts.length }));
  } catch (error) {
    reportEl.textContent = error.message;
    notify(error.message, true);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('DOMContentLoaded', init);
