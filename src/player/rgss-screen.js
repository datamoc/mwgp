// The RGSS screen: draws the display objects an RGSS script creates (Sprite, Plane, inside Viewports) on a canvas laid over
// the game canvas, so scenes the game's own Ruby builds (character select, menus) are visible. Bitmaps are canvas-backed
// (`CanvasBitmap` in rgss-classes.js); this only composites them.
//
// Drawn: Sprite, Plane and Window (its contents bitmap, cursor rectangle and a
// translucent backing where no windowskin art is available), with opacity,
// tone, colour/flash overlays and blend types. Not drawn: windowskin frames
// (Essentials builds its windows from Sprites), bush depth.

// Canvas filter approximating an RGSS Tone (gray desaturates; the channel
// sum brightens/darkens). Exact per-channel tone needs pixel work; this keeps
// the visible effect (a grey or shifted scene) without a shader.
export function toneFilter(tone) {
  if (!tone) return '';
  const red = Number(tone._red ?? tone.red) || 0, green = Number(tone._green ?? tone.green) || 0, blue = Number(tone._blue ?? tone.blue) || 0, gray = Number(tone._gray ?? tone.gray) || 0;
  if (!red && !green && !blue && !gray) return '';
  const saturate = Math.max(0, 1 - gray / 255);
  const brightness = Math.max(0.2, 1 + (red + green + blue) / 3 / 255);
  return `saturate(${saturate.toFixed(3)}) brightness(${brightness.toFixed(3)})`;
}

// RGSS blend_type: 0 normal, 1 addition, 2 subtraction (canvas has no
// subtract; difference is the closest available composite).
export function blendOperation(blendType) {
  return blendType === 1 ? 'lighter' : blendType === 2 ? 'difference' : 'source-over';
}

const channel = (color, key) => Number(color?.[`_${key}`] ?? color?.[key]) || 0;
const hasOverlay = color => Boolean(color) && channel(color, 'alpha') > 0;

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

  let tintCanvas = null;
  const tinted = (source, sx, sy, sw, sh, store) => {
    // Tone / colour / flash need isolation: tint an offscreen copy, then composite it.
    const filter = toneFilter(store.tone);
    const flash = store.__flashFrames > 0 ? store.__flashColor : null;
    const overlay = hasOverlay(store.color) ? store.color : flash;
    if (!filter && !overlay) return null;
    if (!tintCanvas && doc) tintCanvas = doc.createElement('canvas');
    if (!tintCanvas) return null;
    tintCanvas.width = Math.max(1, sw); tintCanvas.height = Math.max(1, sh);
    const tctx = tintCanvas.getContext('2d');
    tctx.clearRect(0, 0, sw, sh);
    if (filter) tctx.filter = filter;
    tctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    tctx.filter = 'none';
    if (overlay) {
      tctx.globalCompositeOperation = 'source-atop';
      tctx.globalAlpha = Math.min(255, channel(overlay, 'alpha')) / 255;
      tctx.fillStyle = `rgb(${channel(overlay, 'red')}, ${channel(overlay, 'green')}, ${channel(overlay, 'blue')})`;
      tctx.fillRect(0, 0, sw, sh);
      tctx.globalAlpha = 1; tctx.globalCompositeOperation = 'source-over';
    }
    return tintCanvas;
  };

  const drawWindow = store => {
    if (store.__selfDrawn) return;   // a game window class that draws itself with Sprites
    const w = Number(store.width) || 0, h = Number(store.height) || 0;
    if (w < 1 || h < 1) return;
    const x = Number(store.x) || 0, y = Number(store.y) || 0;
    context.save();
    context.globalAlpha = Math.max(0, Math.min(255, Number(store.opacity ?? 255))) / 255;
    const skin = store.windowskin?.canvas ?? store.windowskin?.__canvas;
    if (skin && skin.width >= 192 && skin.height >= 128) {
      // The RGSS windowskin (192x128): background pattern at (0,0,128,128)
      // stretched over the window, then the frame's corners and edges from
      // the right-hand strip, and the cursor pattern at (128,64,32,32).
      context.globalAlpha *= Math.max(0, Math.min(255, Number(store.back_opacity ?? 255))) / 255;
      context.drawImage(skin, 0, 0, 128, 128, x, y, w, h);
      context.globalAlpha = Math.max(0, Math.min(255, Number(store.opacity ?? 255))) / 255;
      const c = 16;
      context.drawImage(skin, 128, 0, c, c, x, y, c, c);
      context.drawImage(skin, 176, 0, c, c, x + w - c, y, c, c);
      context.drawImage(skin, 128, 112, c, c, x, y + h - c, c, c);
      context.drawImage(skin, 176, 112, c, c, x + w - c, y + h - c, c, c);
      if (w > 2 * c) { context.drawImage(skin, 144, 0, 32, c, x + c, y, w - 2 * c, c); context.drawImage(skin, 144, 112, 32, c, x + c, y + h - c, w - 2 * c, c); }
      if (h > 2 * c) { context.drawImage(skin, 128, 16, c, 80, x, y + c, c, h - 2 * c); context.drawImage(skin, 176, 16, c, 80, x + w - c, y + c, c, h - 2 * c); }
      const cursor0 = store.cursor_rect ? numbers(store.cursor_rect) : null;
      if (cursor0 && cursor0.width > 0 && cursor0.height > 0) context.drawImage(skin, 128, 64, 32, 32, x + 12 + cursor0.x, y + 12 + cursor0.y, cursor0.width, cursor0.height);
    }
    else if (skin) context.drawImage(skin, 0, 0, skin.width, skin.height, x, y, w, h);
    else { context.fillStyle = 'rgba(8, 12, 24, 0.78)'; context.fillRect(x, y, w, h); context.strokeStyle = 'rgba(255,255,255,0.55)'; context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
    const contents = store.contents?.canvas ?? store.contents?.__canvas;
    if (contents && contents.width > 0) {
      context.globalAlpha = Math.max(0, Math.min(255, Number(store.contents_opacity ?? 255))) / 255 * (Number(store.opacity ?? 255) / 255);
      context.drawImage(contents, x + 12, y + 12);
      const cursor = store.cursor_rect ? numbers(store.cursor_rect) : null;
      if (!(skin && skin.width >= 192 && skin.height >= 128) && cursor && cursor.width > 0 && cursor.height > 0) {
        context.globalAlpha = 0.35; context.fillStyle = '#ffffff';
        context.fillRect(x + 12 + cursor.x, y + 12 + cursor.y, cursor.width, cursor.height);
      }
    }
    context.restore();
  };

  const drawItem = ({ kind, store }, viewport) => {
    if (store.__flashFrames > 0) store.__flashFrames -= 1;
    if (kind === 'window') { drawWindow(store); return; }
    const source = store.bitmap?.canvas ?? store.bitmap?.__canvas;
    if (!source || source.width < 1 || source.height < 1) return;
    const zoomX = Number(store.zoom_x ?? 1), zoomY = Number(store.zoom_y ?? 1);
    // Ruby transitions use zero scale to hide a display object; treating it as
    // the default scale draws the full bitmap during that transition.
    if (!Number.isFinite(zoomX) || !Number.isFinite(zoomY) || zoomX === 0 || zoomY === 0) return;
    context.save();
    if (viewport) { context.beginPath(); context.rect(viewport.x, viewport.y, viewport.width, viewport.height); context.clip(); context.translate(viewport.x - viewport.ox, viewport.y - viewport.oy); }
    context.globalAlpha = Math.max(0, Math.min(255, Number(store.opacity ?? 255))) / 255;
    context.globalCompositeOperation = blendOperation(Number(store.blend_type) || 0);
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
      const tint = tinted(source, sx, sy, sw, sh, store);
      if (tint) context.drawImage(tint, 0, 0, sw, sh, -(Number(store.ox) || 0), -(Number(store.oy) || 0), sw, sh);
      else context.drawImage(source, sx, sy, sw, sh, -(Number(store.ox) || 0), -(Number(store.oy) || 0), sw, sh);
    }
    context.restore();
  };

  const render = () => {
    frame = 0;
    if (!canvas) return;
    if (!items.size) { canvas.remove(); canvas = null; context = null; return; }
    place();
    context.clearRect(0, 0, width, height);
    const visible = [...items].filter(item => item.store.visible !== false && !item.store.__disposed && (item.kind === 'window' || item.store.bitmap));
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
    // Tracks a display object's state bag (`store`); Viewports are only referenced, not drawn.
    add(kind, store) {
      if (kind !== 'sprite' && kind !== 'plane' && kind !== 'window') return;
      const item = { kind, store, order: order++ };
      // Diagnostics only (a page that sets `__mwgpOrigins`): which game function made this object.
      if (globalThis.__mwgpOrigins) store.__origin = (new Error().stack || '').split(String.fromCharCode(10)).slice(2, 14).map(line => (/at (?:new )?([\w.$<>]+) /.exec(line) || [])[1]).filter(name => name && !/^(Object|Proxy|Reflect|new)$/.test(name)).slice(0, 3).join('<');
      items.add(item); store.__screenItem = item;
      ensureCanvas(); schedule();
    },
    remove(store) { if (store.__screenItem) { items.delete(store.__screenItem); store.__screenItem = null; } },
    mark: () => order,
    // Display objects created since `mark` (a script that failed midway must not leave its screen behind).
    disposeSince(mark) { for (const item of [...items]) if (item.order >= mark) { item.store.__disposed = true; items.delete(item); item.store.__screenItem = null; } },
    get count() { return items.size; },
    // What each display object looks like right now, for diagnosing a scene that draws nothing.
    debug: () => [...items].map(({ kind, store }) => { const read = value => (typeof value === 'function' ? value() : value); const bitmap = store.bitmap; const source = bitmap?.canvas ?? bitmap?.__canvas; return { kind, origin: store.__origin ?? null, source: bitmap?.__source ?? null, bitmap: source ? `${source.width}x${source.height}` : null, visible: read(store.visible) !== false, opacity: read(store.opacity) ?? 255, z: read(store.z) ?? 0, x: read(store.x) ?? 0, y: read(store.y) ?? 0, viewport: store.viewport ? read(store.viewport.__store?.visible) !== false : null, disposed: Boolean(store.__disposed) }; }),
    destroy() { items.clear(); canvas?.remove(); canvas = null; }
  };
}
