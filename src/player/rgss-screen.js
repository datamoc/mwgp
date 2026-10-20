// The RGSS screen: draws the display objects an RGSS script creates (Sprite, Plane, inside Viewports) on a canvas laid over
// the game canvas, so scenes the game's own Ruby builds (character select, menus) are visible. Bitmaps are canvas-backed
// (`CanvasBitmap` in rgss-classes.js); this only composites them.
//
// Not drawn: Window (Essentials builds its windows from Sprites), tone/color/flash effects, blend types, bush depth.

export function createRgssScreen({ width = 640, height = 480, document: doc = typeof document !== 'undefined' ? document : null, anchorSelector = '#game' } = {}) {
  const items = new Set();     // { kind, store, order }
  let order = 0;
  let canvas = null, context = null, frame = 0;

  const ensureCanvas = () => {
    if (canvas || !doc) return;
    canvas = doc.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.dataset.rgssScreen = '1';
    canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:50;image-rendering:pixelated;';
    (doc.querySelector(anchorSelector)?.parentElement || doc.body).appendChild(canvas);
    context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
  };

  const place = () => {
    const anchor = doc?.querySelector(anchorSelector);
    if (!anchor || !canvas) return;
    const box = anchor.getBoundingClientRect(), parent = canvas.offsetParent?.getBoundingClientRect?.() || { left: 0, top: 0 };
    // Letterboxed: the RGSS screen keeps its own aspect ratio inside the game canvas.
    const scale = Math.min(box.width / width, box.height / height) || 1;
    const shownWidth = width * scale, shownHeight = height * scale;
    canvas.style.left = `${box.left - parent.left + (box.width - shownWidth) / 2}px`; canvas.style.top = `${box.top - parent.top + (box.height - shownHeight) / 2}px`;
    canvas.style.width = `${shownWidth}px`; canvas.style.height = `${shownHeight}px`;
  };

  const numbers = rect => ({ x: rect._x ?? rect.x, y: rect._y ?? rect.y, width: rect._width ?? rect.width, height: rect._height ?? rect.height });
  const rectOf = viewport => {
    const store = viewport?.__store;
    const rect = store?.rect;
    if (rect && typeof numbers(rect).width === 'number') return { ...numbers(rect), ox: store.ox || 0, oy: store.oy || 0, z: store.z || 0, visible: store.visible !== false };
    const [x, y, w, h] = store?.__args ?? [];
    if (typeof x === 'object' && x) return { ...numbers(x), ox: store.ox || 0, oy: store.oy || 0, z: store.z || 0, visible: store.visible !== false };
    return { x: Number(x) || 0, y: Number(y) || 0, width: Number(w) || width, height: Number(h) || height, ox: store?.ox || 0, oy: store?.oy || 0, z: store?.z || 0, visible: store?.visible !== false };
  };

  const drawItem = ({ kind, store }, viewport) => {
    const source = store.bitmap?.canvas ?? store.bitmap?.__canvas;
    if (!source || source.width < 1 || source.height < 1) return;
    const zoomX = Number(store.zoom_x ?? 1), zoomY = Number(store.zoom_y ?? 1);
    // Ruby transitions use zero scale to hide a display object; treating it as
    // the default scale draws the full bitmap during that transition.
    if (!Number.isFinite(zoomX) || !Number.isFinite(zoomY) || zoomX === 0 || zoomY === 0) return;
    context.save();
    if (viewport) { context.beginPath(); context.rect(viewport.x, viewport.y, viewport.width, viewport.height); context.clip(); context.translate(viewport.x - viewport.ox, viewport.y - viewport.oy); }
    context.globalAlpha = Math.max(0, Math.min(255, Number(store.opacity ?? 255))) / 255;
    if (kind === 'plane') {
      const tileW = source.width * zoomX, tileH = source.height * zoomY;
      const originX = -(Number(store.ox) || 0), originY = -(Number(store.oy) || 0);
      const area = viewport || { x: 0, y: 0, width, height };
      const startX = area.x + (((originX % tileW) + tileW) % tileW) - tileW, startY = area.y + (((originY % tileH) + tileH) % tileH) - tileH;
      for (let y = startY; y < area.y + area.height; y += tileH) for (let x = startX; x < area.x + area.width; x += tileW) context.drawImage(source, x, y, tileW, tileH);
    } else {
      const rect = store.src_rect;
      const source_rect = rect ? numbers(rect) : null;
      // Each dimension falls back on its own: a game often narrows one axis
      // only (src_rect.height for a vertical icon strip, .width for a
      // horizontal one). Gating y on the width drew the sheet from the top.
      const sx = source_rect && source_rect.width > 0 ? source_rect.x : 0, sy = source_rect && source_rect.height > 0 ? source_rect.y : 0;
      const sw = source_rect && source_rect.width > 0 ? source_rect.width : source.width, sh = source_rect && source_rect.height > 0 ? source_rect.height : source.height;
      context.translate(Number(store.x) || 0, Number(store.y) || 0);
      if (store.angle) context.rotate(-Number(store.angle) * Math.PI / 180);
      context.scale(zoomX * (store.mirror ? -1 : 1), zoomY);
      context.drawImage(source, sx, sy, sw, sh, -(Number(store.ox) || 0), -(Number(store.oy) || 0), sw, sh);
    }
    context.restore();
  };

  const render = () => {
    frame = 0;
    if (!canvas) return;
    if (!items.size) { canvas.remove(); canvas = null; context = null; return; }
    place();
    context.clearRect(0, 0, width, height);
    const visible = [...items].filter(item => item.store.visible !== false && !item.store.__disposed && item.store.bitmap);
    const keyed = visible.map(item => {
      const viewport = item.store.viewport ? rectOf(item.store.viewport) : null;
      return { item, viewport, top: viewport ? viewport.z : Number(item.store.z) || 0, inner: viewport ? Number(item.store.z) || 0 : 0 };
    }).filter(entry => !entry.viewport || entry.viewport.visible);
    keyed.sort((a, b) => a.top - b.top || (a.viewport ? 1 : 0) - (b.viewport ? 1 : 0) || a.inner - b.inner || a.item.order - b.item.order);
    for (const entry of keyed) drawItem(entry.item, entry.viewport);
    schedule();
  };
  const schedule = () => { if (!frame && items.size && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(render); };

  return {
    // Tracks a display object's state bag (`store`); Viewports and Windows are only referenced, not drawn.
    add(kind, store) {
      if (kind !== 'sprite' && kind !== 'plane') return;
      const item = { kind, store, order: order++ };
      items.add(item); store.__screenItem = item;
      ensureCanvas(); schedule();
    },
    remove(store) { if (store.__screenItem) { items.delete(store.__screenItem); store.__screenItem = null; } },
    mark: () => order,
    // Display objects created since `mark` (a script that failed midway must not leave its screen behind).
    disposeSince(mark) { for (const item of [...items]) if (item.order >= mark) { item.store.__disposed = true; items.delete(item); item.store.__screenItem = null; } },
    get count() { return items.size; },
    // What each display object looks like right now, for diagnosing a scene that draws nothing.
    debug: () => [...items].map(({ kind, store }) => { const read = value => (typeof value === 'function' ? value() : value); const bitmap = store.bitmap; const source = bitmap?.canvas ?? bitmap?.__canvas; return { kind, bitmap: source ? `${source.width}x${source.height}` : null, visible: read(store.visible) !== false, opacity: read(store.opacity) ?? 255, z: read(store.z) ?? 0, x: read(store.x) ?? 0, y: read(store.y) ?? 0, viewport: store.viewport ? read(store.viewport.__store?.visible) !== false : null, disposed: Boolean(store.__disposed) }; }),
    destroy() { items.clear(); canvas?.remove(); canvas = null; }
  };
}
