const runtime = document.createElement('script');
runtime.src = '/mwg.js';
await new Promise((resolve, reject) => { runtime.onload = resolve; runtime.onerror = reject; document.head.append(runtime); });
const { MwgPlayer } = await import('/player-core.js');
const id = new URLSearchParams(location.search).get('id');
const canvas = document.querySelector('#game');
const loading = document.createElement('p');
loading.id = 'loading';
loading.textContent = 'Loading game assets…';
loading.setAttribute('role', 'status');
canvas.before(loading);
const response = await fetch(`/api/mwgp/${encodeURIComponent(id || '')}`);
if (!response.ok) throw new Error('MWGP project not found');
const project = await response.json();
const query = new URLSearchParams(location.search);
if (query.has('map')) project.initialMapId = Number(query.get('map'));
if (query.has('x') && query.has('y')) project.player = { ...(project.player || {}), mapId: project.initialMapId, x: Number(query.get('x')), y: Number(query.get('y')) };
if (project.assets?.kind === 'decoded') project.assets.root = `/api/mwgp/${id}/assets`;
document.querySelector('#title').textContent = project.display?.title || 'MWGP Player';
showCompatibilityWarning(project);
try {
  const { startMwgPixi } = await import(`/pixi-core.js?v=${Date.now()}`);
  await startMwgPixi(canvas, project);
} catch (error) {
  console.warn('Pixi player unavailable, using compatibility renderer', error);
  new MwgPlayer(canvas, project);
} finally {
  loading.remove();
}

function showCompatibilityWarning(project) {
  const commands = project.compatibility?.commands || {};
  const byStatus = { unsupported: [], partial: [] };
  for (const [code, entry] of Object.entries(commands)) {
    if (entry?.count > 0 && byStatus[entry.status]) byStatus[entry.status].push(`${code}×${entry.count}`);
  }
  if (!byStatus.unsupported.length && !byStatus.partial.length) return;
  const parts = [];
  if (byStatus.unsupported.length) parts.push(`unsupported RPG Maker commands (${byStatus.unsupported.length} kind(s)): ${byStatus.unsupported.join(', ')}`);
  if (byStatus.partial.length) parts.push(`partially supported: ${byStatus.partial.join(', ')}`);
  const message = `This project uses ${parts.join('; ')}. Those scenes may not play as in RPG Maker.`;
  console.warn(`MWGP compatibility: ${message}`);
  const banner = document.createElement('p');
  banner.setAttribute('role', 'note');
  banner.style.cssText = 'background:#3a2a12;border:1px solid #a97b2f;border-radius:6px;padding:8px 12px;color:#f2d9a4';
  banner.textContent = message;
  document.querySelector('#game')?.before(banner);
}
