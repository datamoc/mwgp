const runtime = document.createElement('script');
runtime.src = '/mwg.js';
await new Promise((resolve, reject) => { runtime.onload = resolve; runtime.onerror = reject; document.head.append(runtime); });
const { MwgPlayer } = await import('/player-core.js');
const id = new URLSearchParams(location.search).get('id');
const response = await fetch(`/api/mwgp/${encodeURIComponent(id || '')}`);
if (!response.ok) throw new Error('MWGP project not found');
const project = await response.json();
const query = new URLSearchParams(location.search);
if (query.has('map')) project.initialMapId = Number(query.get('map'));
if (query.has('x') && query.has('y')) project.player = { ...(project.player || {}), mapId: project.initialMapId, x: Number(query.get('x')), y: Number(query.get('y')) };
if (project.assets?.kind === 'decoded') project.assets.root = `/api/mwgp/${id}/assets`;
document.querySelector('#title').textContent = project.display?.title || 'MWGP Player';
try {
  const { startMwgPixi } = await import(`/pixi-core.js?v=${Date.now()}`);
  await startMwgPixi(document.querySelector('#game'), project);
} catch (error) {
  console.warn('Pixi player unavailable, using compatibility renderer', error);
  new MwgPlayer(document.querySelector('#game'), project);
}
