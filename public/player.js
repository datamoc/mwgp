const id = new URLSearchParams(location.search).get('id');
const canvas = document.querySelector('#game');
const loading = document.createElement('div');
loading.id = 'loading';
loading.className = 'mwgp-loading';
loading.textContent = 'Loading game data…';
loading.setAttribute('role', 'status');
canvas.before(loading);
let bootstrapFailed = false;
try {
  const runtime = document.createElement('script');
  runtime.src = '/mwg.js';
  await new Promise((resolve, reject) => { runtime.onload = resolve; runtime.onerror = () => reject(new Error('mw_games runtime failed to load')); document.head.append(runtime); });
  const { MwgPlayer } = await import('/fallback-core.js');
  const response = await fetch(`/api/mwgp/${encodeURIComponent(id || '')}`);
  if (!response.ok) throw new Error(`MWGP project not found (${response.status})`);
  const project = await response.json();
  const query = new URLSearchParams(location.search);
  if (query.has('map')) project.initialMapId = Number(query.get('map'));
  if (query.has('x') && query.has('y')) project.player = { ...(project.player || {}), mapId: project.initialMapId, x: Number(query.get('x')), y: Number(query.get('y')) };
  if (project.assets?.kind === 'decoded') project.assets.root = `/api/mwgp/${id}/assets`;
  if (project.pluginLibrary?.files) project.pluginLibrary.root = `/api/mwgp/${id}/assets`;
  if (project.titleScreen?.assets?.kind === 'decoded') project.titleScreen.assets.root = `/api/mwgp/${id}/assets`;
  document.querySelector('#title').textContent = project.display?.title || 'MWGP Player';
  showCompatibilityWarning(project);
  if (!query.has('map') && !query.has('skipTitle')) await showTitleScreen(project);
  loading.textContent = 'Loading game assets…';
  try {
    const { startMwgPlayer } = await import(`/player-core.js?v=${Date.now()}`);
    await startMwgPlayer(canvas, project);
  } catch (error) {
    console.warn('MWG player unavailable, using compatibility renderer', error);
    new MwgPlayer(canvas, project);
  }
} catch (error) {
  bootstrapFailed = true;
  console.error('MWGP bootstrap failed', error);
  document.querySelector('#title').textContent = 'MWGP Player — load failed';
  loading.textContent = `Unable to load this game: ${error?.message || 'unknown error'}`;
  loading.setAttribute('role', 'alert');
} finally {
  if (!bootstrapFailed) loading.remove();
}

async function showTitleScreen(project) {
  const title = project.titleScreen || {};
  // Title music and menu sounds. The audio context starts on the first key press or click
  // (browser autoplay rules), and the volume sliders below are shared with the game itself.
  let titleAudio = null;
  try {
    if (project.assets?.kind === 'decoded' && project.assets.audio && project.audio) {
      const { AudioManager } = await import('/audio-manager.js');
      titleAudio = new AudioManager({ root: project.assets.root, index: project.audio.index, cacheVersion: project.source?.convertedAt || '', soundfontUrls: [project.audio.soundfont ? `${project.assets.root}/audio/${project.audio.soundfont}` : null, '/soundfont.sf2'].filter(Boolean) });
      titleAudio.unlock();
      if (project.audio.system?.titleBgm) titleAudio.playBgm(project.audio.system.titleBgm);
    }
  } catch (error) { console.warn('MWGP title audio unavailable', error); }
  const menuSound = name => { const sound = project.audio?.system?.sounds?.[name]; if (sound) titleAudio?.playSe(sound); };
  const titleRoot = title.assets?.root || project.assets?.root;
  const titleAssets = title.assets?.kind === 'decoded';
  const commands = { newGame: true, continue: true, options: true, ...(title.commands || {}) };
  const root = document.createElement('section'); root.className = 'mwgp-title';
  const art = document.createElement('div'); art.className = 'mwgp-title-art';
  if (titleAssets && title.title2) art.style.backgroundImage = 'url("' + titleRoot + '/img/titles2/' + encodeURIComponent(title.title2) + '.png")';
  const shade = document.createElement('div'); shade.className = 'mwgp-title-shade';
  const content = document.createElement('div'); content.className = 'mwgp-title-content';
  const kicker = document.createElement('p'); kicker.className = 'mwgp-title-kicker'; kicker.textContent = 'RPG Maker / MWGP';
  const name = document.createElement('h2'); name.className = 'mwgp-title-name'; name.textContent = project.display?.title || project.source?.projectName || 'Untitled game';
  content.append(kicker, name);
  if (titleAssets && title.title1) { const logo = document.createElement('img'); logo.className = 'mwgp-title-logo'; logo.style.cssText = 'display:block;max-width:min(420px,70vw);max-height:150px;object-fit:contain;object-position:left bottom;margin-bottom:18px;'; logo.alt = ''; logo.src = titleRoot + '/img/titles1/' + encodeURIComponent(title.title1) + '.png'; logo.onerror = () => logo.remove(); content.insertBefore(logo, name); }
  const menu = document.createElement('nav'); menu.className = 'mwgp-title-menu';
  const options = document.createElement('div'); options.className = 'mwgp-options'; options.hidden = true;
  if (titleAudio) {
    const heading = document.createElement('p'); heading.textContent = 'Volume'; options.append(heading);
    for (const [kind, label] of [['master', 'Master'], ['bgm', 'Music'], ['bgs', 'Ambience'], ['me', 'Jingles'], ['se', 'Effects']]) {
      const row = document.createElement('label'); row.style.cssText = 'display:flex;gap:10px;align-items:center;margin:4px 0';
      const text = document.createElement('span'); text.textContent = label; text.style.minWidth = '84px';
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(Math.round(titleAudio.volumes[kind] * 100));
      slider.addEventListener('input', () => titleAudio.setVolume(kind, Number(slider.value) / 100));
      slider.addEventListener('change', () => { if (kind === 'se') menuSound('cursor'); });
      row.append(text, slider); options.append(row);
    }
    const mute = document.createElement('label'); mute.style.cssText = 'display:flex;gap:10px;align-items:center;margin:8px 0 0';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = titleAudio.volumes.muted; box.addEventListener('change', () => titleAudio.setMuted(box.checked));
    const muteText = document.createElement('span'); muteText.textContent = 'Mute (M in game)'; mute.append(box, muteText); options.append(mute);
  } else options.textContent = 'This game has no converted audio.';
  const note = document.createElement('p'); note.className = 'mwgp-title-note'; note.textContent = 'Arrow keys / WASD / Enter or Space';
  const buttons = []; const makeButton = (label, primary, action) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (primary) button.dataset.primary = 'true'; button.addEventListener('click', () => { menuSound('ok'); action(); }); buttons.push(button); return button; };
  let finish; const done = new Promise(resolve => { finish = mode => { titleAudio?.fadeOutBgm(0.8); if (mode === 'continue') { const next = new URL(location.href); next.searchParams.set('load', '1'); next.searchParams.set('skipTitle', '1'); history.replaceState(null, '', next); } else if (mode === 'new') { const next = new URL(location.href); next.searchParams.set('newGame', '1'); next.searchParams.set('skipTitle', '1'); history.replaceState(null, '', next); } root.remove(); resolve(); }; });
  if (commands.newGame) menu.append(makeButton('New Game', true, () => finish('new')));
  if (commands.continue) menu.append(makeButton('Continue', false, () => finish('continue')));
  if (commands.options) menu.append(makeButton('Options', false, () => { options.hidden = !options.hidden; }));
  menu.append(note); root.append(art, shade, content, menu, options); document.body.append(root);
  const onKey = event => { if (!root.isConnected) return; if (['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)) { if (!buttons.length) return; event.preventDefault(); const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1; const current = buttons.indexOf(document.activeElement); buttons[(current + delta + buttons.length) % buttons.length].focus(); menuSound('cursor'); } else if ((event.key === 'Enter' || event.key === ' ') && document.activeElement instanceof HTMLButtonElement) { event.preventDefault(); document.activeElement.click(); } else if (event.key === 'Escape') options.hidden = true; };
  window.addEventListener('keydown', onKey); (buttons[0] || root).focus(); await done; window.removeEventListener('keydown', onKey);
}
function showCompatibilityWarning(project) {
  const commands = project.compatibility?.commands || {};
  const plugins = project.compatibility?.plugins || {};
  const scripts = project.compatibility?.scripts || {};
  const byStatus = { unsupported: [], partial: [] };
  for (const [code, entry] of Object.entries(commands)) {
    if (entry?.count > 0 && byStatus[entry.status]) byStatus[entry.status].push(`${code}×${entry.count}`);
  }
  const pluginByStatus = { unsupported: [], partial: [] };
  for (const [name, entry] of Object.entries(plugins)) {
    if (entry?.count > 0 && pluginByStatus[entry.status]) pluginByStatus[entry.status].push(`${name}×${entry.count}`);
  }
  if (!byStatus.unsupported.length && !byStatus.partial.length && !pluginByStatus.unsupported.length && !pluginByStatus.partial.length && !scripts.failed?.length && !scripts.libraryFailed?.length) return;
  const parts = [];
  if (byStatus.unsupported.length) parts.push(`unsupported RPG Maker commands (${byStatus.unsupported.length} kind(s)): ${byStatus.unsupported.join(', ')}`);
  if (byStatus.partial.length) parts.push(`partially supported: ${byStatus.partial.join(', ')}`);
  if (pluginByStatus.unsupported.length) parts.push(`unsupported plugin families: ${pluginByStatus.unsupported.join(', ')}`);
  if (pluginByStatus.partial.length) parts.push(`partially supported plugin families: ${pluginByStatus.partial.join(', ')}`);
  if (scripts.failed?.length) parts.push(`failed RGSS event scripts: ${scripts.failed.length}`);
  if (scripts.libraryFailed?.length) parts.push(`failed RGSS library units: ${scripts.libraryFailed.length}`);
  if (scripts.libraryPartial?.length) parts.push(`partially transpiled RGSS library units: ${scripts.libraryPartial.length}`);
  const message = `This project uses ${parts.join('; ')}. Those scenes may not play as in RPG Maker.`;
  console.warn(`MWGP compatibility: ${message}`);
  const banner = document.createElement('p');
  banner.setAttribute('role', 'note');
  banner.style.cssText = 'background:#3a2a12;border:1px solid #a97b2f;border-radius:6px;padding:8px 12px;color:#f2d9a4';
  banner.textContent = message;
  document.querySelector('#game')?.before(banner);
}
