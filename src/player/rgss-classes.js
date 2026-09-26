// The RGSS runtime objects event scripts and the game's own Ruby call directly: Input, System,
// Marshal, load_data/save_data, the value classes Color/Tone/Rect/Font, and the display classes
// (Bitmap, Sprite, Viewport, Plane, Window, Tilemap) the headless script runtime cannot draw.
// Built from the coverage report (docs/rgss-shim-coverage.md, `npm run rgss:coverage`): everything
// ranked there is either implemented for real (state, input, files, values) or an inert object whose
// calls warn once, never a silent success. Names follow the RGSS API (tools/rgss-api-dump.mjs);
// Ruby2JS drops `?`/`!`, so `Input.trigger?` arrives as `Input.trigger`.
//
// createRgssClasses({ warnOnce, files, uptime, keys, reopened }) -> { Input, System, Marshal, load_data,
// save_data, Color, Tone, Rect, Font, Bitmap, Sprite, Viewport, Plane, Window, Tilemap, Table }
//   files:    Map-like { get, set } virtual file store behind save_data/load_data
//   uptime:   () => seconds since the runtime started
//   keys:     { down(name), pressed(name), update() } keyboard probe (all false when absent)
//   reopened: (name) => source text of a game unit that re-opens that module, or undefined

const clamp255 = value => Math.max(0, Math.min(255, Number(value) || 0));
const clampTone = value => Math.max(-255, Math.min(255, Number(value) || 0));

// Standard RGSS Input constants (RPG Maker XP help, "Input"), mapped to the default keyboard.
export const INPUT_CONSTANTS = { USE: 13, BACK: 12, ACTION: 11, JUMPUP: 14, JUMPDOWN: 15, SPECIAL: 16, AUX1: 17, AUX2: 18, DOWN: 2, LEFT: 4, RIGHT: 6, UP: 8, A: 11, B: 12, C: 13, X: 14, Y: 15, Z: 16, L: 17, R: 18, SHIFT: 21, CTRL: 22, ALT: 23, F5: 25, F6: 26, F7: 27, F8: 28, F9: 29, MOUSELEFT: 38, MOUSEMIDDLE: 39, MOUSERIGHT: 40, MOUSEX1: 41, MOUSEX2: 42 };
const INPUT_KEYS = {
  2: ['ArrowDown'], 4: ['ArrowLeft'], 6: ['ArrowRight'], 8: ['ArrowUp'],
  11: ['Shift'], 12: ['Escape', 'x', 'X', '0'], 13: ['Enter', ' ', 'z', 'Z'], 14: ['a', 'A'], 15: ['s', 'S'], 16: ['d', 'D'],
  17: ['q', 'Q', 'PageUp'], 18: ['w', 'W', 'PageDown'], 21: ['Shift'], 22: ['Control'], 23: ['Alt'], 25: ['F5'], 26: ['F6'], 27: ['F7'], 28: ['F8'], 29: ['F9']
};

// Keyboard probe over the page's key events: `down` = held now, `pressed` = went down since the last
// update() (RGSS's trigger?). Scripts here run synchronously, so a frame boundary is Input.update.
export function createKeyProbe(target = typeof window !== 'undefined' ? window : null) {
  const held = new Set(), edges = new Set();
  // RGSS: `update` latches the keys that went down since the last update; `trigger?` reads that latch.
  let latched = new Set();
  if (target?.addEventListener) {
    target.addEventListener('keydown', event => { if (!held.has(event.key)) edges.add(event.key); held.add(event.key); });
    target.addEventListener('keyup', event => { held.delete(event.key); });
    target.addEventListener('blur', () => held.clear());
  }
  const any = (set, symbol) => (INPUT_KEYS[symbol] || []).some(key => set.has(key));
  return { down: symbol => any(held, symbol), pressed: symbol => any(latched, symbol) || any(edges, symbol), update: () => { latched = new Set(edges); edges.clear(); } };
}

export function createRgssClasses({ warnOnce, files, uptime = () => 0, keys = null, reopened = () => undefined, shipped = () => undefined, imageUrl = () => null, screen = null, callableNames = null, rawFile = () => undefined }) {
  const loud = (owner, method) => () => { warnOnce(`${owner}.${method}`, 'needs the RGSS display layer, which the headless script runtime does not have'); };

  // Value objects (Color, Tone, Rect, Font) answer a name the game `def`s anywhere as a callable reader (`clr.red()`): the game
  // reads every such name as a call. Their own methods use `_fields`, so the wrapper is transparent to them.
  const callable = instance => (callableNames?.size ? new Proxy(instance, {
    get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver);
      return typeof key === 'string' && typeof value !== 'function' && value !== undefined && !key.startsWith('_') && callableNames.has(key) ? () => value : value;
    }
  }) : instance);

  // ---- value classes --------------------------------------------------------------------
  class Color {
    constructor(red = 0, green = 0, blue = 0, alpha = 255) { Color.prototype.set.call(this, red, green, blue, alpha); return callable(this); }   // not this.set(): a subclass override must not run mid-construction
    set(red = 0, green = 0, blue = 0, alpha = 255) {
      if (red && typeof red === 'object') ({ red, green, blue, alpha = 255 } = red);
      this._red = clamp255(red); this._green = clamp255(green); this._blue = clamp255(blue); this._alpha = clamp255(alpha);
      return this;
    }
    get red() { return this._red; } set red(value) { this._red = clamp255(value); }
    get green() { return this._green; } set green(value) { this._green = clamp255(value); }
    get blue() { return this._blue; } set blue(value) { this._blue = clamp255(value); }
    get alpha() { return this._alpha; } set alpha(value) { this._alpha = clamp255(value); }
    equals(other) { return other && other._red === this._red && other._green === this._green && other._blue === this._blue && other._alpha === this._alpha; }
    to_s() { return `(${this._red}, ${this._green}, ${this._blue}, ${this._alpha})`; }
    toString() { return this.to_s(); }
    _dump() { return `${this._red},${this._green},${this._blue},${this._alpha}`; }
    static _load(text) { return new Color(...String(text).split(',').map(Number)); }
  }
  class Tone {
    constructor(red = 0, green = 0, blue = 0, gray = 0) { Tone.prototype.set.call(this, red, green, blue, gray); return callable(this); }   // not this.set(): a subclass override must not run mid-construction
    set(red = 0, green = 0, blue = 0, gray = 0) {
      if (red && typeof red === 'object') ({ red, green, blue, gray = 0 } = red);
      this._red = clampTone(red); this._green = clampTone(green); this._blue = clampTone(blue); this._gray = clamp255(gray);
      return this;
    }
    get red() { return this._red; } set red(value) { this._red = clampTone(value); }
    get green() { return this._green; } set green(value) { this._green = clampTone(value); }
    get blue() { return this._blue; } set blue(value) { this._blue = clampTone(value); }
    get gray() { return this._gray; } set gray(value) { this._gray = clamp255(value); }
    equals(other) { return other && other._red === this._red && other._green === this._green && other._blue === this._blue && other._gray === this._gray; }
    to_s() { return `(${this._red}, ${this._green}, ${this._blue}, ${this._gray})`; }
    toString() { return this.to_s(); }
  }
  class Rect {
    constructor(x = 0, y = 0, width = 0, height = 0) { Rect.prototype.set.call(this, x, y, width, height); return callable(this); }   // not this.set(): a subclass override must not run mid-construction
    set(x = 0, y = 0, width = 0, height = 0) {
      if (x && typeof x === 'object') ({ x, y, width, height } = x);
      this._x = Number(x) || 0; this._y = Number(y) || 0; this._width = Number(width) || 0; this._height = Number(height) || 0;
      return this;
    }
    // Accessors on the prototype (not own fields), so a game subclass can override a setter and reach the base through `super`.
    get x() { return this._x; } set x(value) { this._x = Number(value) || 0; }
    get y() { return this._y; } set y(value) { this._y = Number(value) || 0; }
    get width() { return this._width; } set width(value) { this._width = Number(value) || 0; }
    get height() { return this._height; } set height(value) { this._height = Number(value) || 0; }
    empty() { return this.set(0, 0, 0, 0); }
    equals(other) { return Boolean(other) && other._x === this._x && other._y === this._y && other._width === this._width && other._height === this._height; }
    to_s() { return `(${this._x}, ${this._y}, ${this._width}, ${this._height})`; }
    toString() { return this.to_s(); }
  }
  class Font {
    constructor(name, size) {
      this.name = name ?? Font.default_name; this.size = size ?? Font.default_size;
      this.bold = Font.default_bold; this.italic = Font.default_italic;
      this.color = new Color(255, 255, 255, 255); this.shadow = Font.default_shadow; this.outline = Font.default_outline; this.out_color = new Color(0, 0, 0, 128);
    }
    static exist(name) { return typeof name === 'string' && name.length > 0; }
  }
  Object.assign(Font, { default_name: 'Arial', default_size: 22, default_bold: false, default_italic: false, default_shadow: false, default_outline: true, default_color: new Color(255, 255, 255, 255), default_out_color: new Color(0, 0, 0, 128) });

  // ---- display classes: state is kept, drawing and pixel access are loud no-ops -----------
  const receiverOf = target => target;
  const display = (owner, methods, extra = {}) => {
    const known = new Set(methods);
    return class {
      constructor(...args) {
        const store = { ...extra, __args: args };
        const self = new Proxy(this, {
          get: (target, key) => {
            if (typeof key === 'symbol') return Reflect.get(target, key);
            if (Object.hasOwn(store, key)) {   // own only: Object.prototype carries Ruby fallbacks (`disposed`)
              const value = store[key];
              // A name the game `def`s anywhere is read as a call (`this.opacity()`), including while a subclass is still constructing.
              // Never for an underscore-prefixed key: that's always a plain ivar field (`@x` -> `this._x`), never a method call,
              // even when some unrelated class in the game happens to define a method of that literal (underscored) name.
              return callableNames?.has(key) && !key.startsWith('_') && typeof value !== 'function' && value !== undefined ? () => value : value;
            }
            if (key === 'dispose') return () => { store.__disposed = true; screen?.remove(store); };
            if (key === 'disposed') return () => Boolean(store.__disposed);
            // update / flash / effects: nothing to advance or show (the screen draws bitmaps only).
            if (key === 'update' || key === 'flash') return () => undefined;
            if (known.has(key)) return (...callArgs) => { loud(owner, key)(); return undefined; };
            // Accessors a game subclass defines (`columns`, ...) are read as calls too.
            const inherited = Reflect.get(target, key, receiverOf(target, key));
            return callableNames?.has(key) && typeof inherited !== 'function' && inherited !== undefined && !key.startsWith('_') ? () => inherited : inherited;
          },
          set: (target, key, value) => { store[key] = value; return true; },
          has: (target, key) => key in store || known.has(key) || key in target
        });
        if (owner === 'Bitmap' || owner === 'Sprite' || owner === 'Viewport' || owner === 'Window' || owner === 'Plane' || owner === 'Tilemap') store.__disposed = false;
        this.__store = store;
        // Sprite.new(viewport) / Plane.new(viewport): the first argument is the viewport; Viewport.new(x, y, w, h) or (rect).
        // Per-instance defaults that are objects (a shared default would be shared by every sprite).
        if (owner === 'Sprite') store.src_rect = new Rect(0, 0, 0, 0);
        if (owner === 'Window') { store.cursor_rect = new Rect(0, 0, 0, 0); store.contents = store.contents ?? null; }
        if ((owner === 'Sprite' || owner === 'Plane') && args[0] && typeof args[0] === 'object') store.viewport = args[0];
        if (owner === 'Viewport') store.rect = args[0] && typeof args[0] === 'object' ? args[0] : new Rect(args[0] || 0, args[1] || 0, args[2] || 640, args[3] || 480);
        if (owner === 'Sprite') screen?.add('sprite', store); else if (owner === 'Plane') screen?.add('plane', store);
        return self;
      }
    };
  };
  class BitmapBase {
    constructor(widthOrFile, height) {
      this.width = typeof widthOrFile === 'number' ? widthOrFile : 0;
      this.height = typeof widthOrFile === 'number' ? Number(height) || 0 : 0;
      this.font = new Font();
      this.__disposed = false;
      this.__file = typeof widthOrFile === 'string' ? widthOrFile : null;
    }
    get rect() { return new Rect(0, 0, this.width, this.height); }
    dispose() { this.__disposed = true; }
    disposed() { return this.__disposed; }
    static max_size() { return 4096; }
    // Pixel work has no surface to act on: loud, and reads return transparent black.
    blt() { loud('Bitmap', 'blt')(); } stretch_blt() { loud('Bitmap', 'stretch_blt')(); } fill_rect() { loud('Bitmap', 'fill_rect')(); }
    clear() { loud('Bitmap', 'clear')(); } clear_rect() { loud('Bitmap', 'clear_rect')(); } draw_text() { loud('Bitmap', 'draw_text')(); }
    gradient_fill_rect() { loud('Bitmap', 'gradient_fill_rect')(); } hue_change() { loud('Bitmap', 'hue_change')(); } blur() { loud('Bitmap', 'blur')(); }
    set_pixel() { loud('Bitmap', 'set_pixel')(); }
    get_pixel() { loud('Bitmap', 'get_pixel')(); return new Color(0, 0, 0, 0); }
    text_size(text) { loud('Bitmap', 'text_size')(); return new Rect(0, 0, String(text ?? '').length * Math.round((this.font?.size || 22) / 2), this.font?.size || 22); }
  }
  // A real Bitmap where a canvas exists (the browser): pixels live in a 2D canvas, so `blt`, `fill_rect`, `draw_text`,
  // `get_pixel` and friends do what RGSS's do and drawing code runs to completion. A bitmap made from a file
  // loads the image asynchronously (`width`/`height` read 0 until it is in) — RGSS loads synchronously, which a
  // browser cannot. Without a DOM (Node tests) the loud no-op class above stands in.
  const makeCanvas = (width, height) => {
    const w = Math.max(1, Math.floor(width) || 1), h = Math.max(1, Math.floor(height) || 1);
    if (typeof document !== 'undefined' && document.createElement) { const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; return canvas; }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    return null;
  };
  const css = color => `rgba(${color?.red ?? color?._red ?? 0}, ${color?.green ?? color?._green ?? 0}, ${color?.blue ?? color?._blue ?? 0}, ${(color?.alpha ?? color?._alpha ?? 255) / 255})`;
  // A Rect's numbers (the fields, not the callable readers the game-facing object exposes).
  const rectValues = rect => [rect._x ?? rect.x, rect._y ?? rect.y, rect._width ?? rect.width, rect._height ?? rect.height];
  const rectArgs = (args, count) => (args[0] && typeof args[0] === 'object' ? [...rectValues(args[0]), ...args.slice(1)] : args).slice(0, count + 4);
  class CanvasBitmap extends BitmapBase {
    constructor(widthOrFile, height) {
      super(widthOrFile, height);
      const fromFile = typeof widthOrFile === 'string';
      this.__canvas = makeCanvas(fromFile ? 1 : widthOrFile, fromFile ? 1 : height);
      this.__ctx = this.__canvas?.getContext?.('2d', { willReadFrequently: true }) ?? null;
      if (fromFile) { this.width = 0; this.height = 0; this.__load(widthOrFile); }
    }
    __load(name) {
      const url = imageUrl(name);
      if (!url || typeof Image === 'undefined') { warnOnce(`Bitmap.new(${name})`, 'has no image to load'); return; }
      const image = new Image();
      image.onload = () => {
        this.__canvas.width = image.naturalWidth; this.__canvas.height = image.naturalHeight;
        this.__ctx = this.__canvas.getContext('2d', { willReadFrequently: true });
        this.__ctx.drawImage(image, 0, 0);
        this.width = image.naturalWidth; this.height = image.naturalHeight;
      };
      image.onerror = () => warnOnce(`Bitmap.new(${name})`, 'could not be loaded');
      image.src = url;
    }
    get canvas() { return this.__canvas; }
    dispose() { this.__disposed = true; this.__ctx = null; }
    fill_rect(...args) { const [x, y, w, h, color] = rectArgs(args, 1); if (!this.__ctx) return; this.__ctx.fillStyle = css(color); this.__ctx.fillRect(x, y, w, h); }
    clear() { this.__ctx?.clearRect(0, 0, this.__canvas.width, this.__canvas.height); }
    clear_rect(...args) { const [x, y, w, h] = rectArgs(args, 0); this.__ctx?.clearRect(x, y, w, h); }
    blt(x, y, source, rect, opacity = 255) {
      if (!this.__ctx || !source?.canvas || source.canvas.width < 1) return;
      const [sx, sy, sw, sh] = rectValues(rect);
      if (sw <= 0 || sh <= 0) return;
      this.__ctx.globalAlpha = Math.max(0, Math.min(255, opacity)) / 255;
      this.__ctx.drawImage(source.canvas, sx, sy, sw, sh, x, y, sw, sh);
      this.__ctx.globalAlpha = 1;
    }
    stretch_blt(destRect, source, rect, opacity = 255) {
      if (!this.__ctx || !source?.canvas || source.canvas.width < 1) return;
      this.__ctx.globalAlpha = Math.max(0, Math.min(255, opacity)) / 255;
      const [rx, ry, rw, rh] = rectValues(rect), [dx, dy, dw, dh] = rectValues(destRect);
      this.__ctx.drawImage(source.canvas, rx, ry, rw, rh, dx, dy, dw, dh);
      this.__ctx.globalAlpha = 1;
    }
    gradient_fill_rect(...args) {
      const [x, y, w, h, color1, color2, vertical] = args[0] && typeof args[0] === 'object' ? [...rectValues(args[0]), ...args.slice(1)] : args;
      if (!this.__ctx) return;
      const gradient = vertical ? this.__ctx.createLinearGradient(0, y, 0, y + h) : this.__ctx.createLinearGradient(x, 0, x + w, 0);
      gradient.addColorStop(0, css(color1)); gradient.addColorStop(1, css(color2));
      this.__ctx.fillStyle = gradient; this.__ctx.fillRect(x, y, w, h);
    }
    get_pixel(x, y) {
      if (!this.__ctx || x < 0 || y < 0 || x >= this.__canvas.width || y >= this.__canvas.height) return new Color(0, 0, 0, 0);
      const [r, g, b, a] = this.__ctx.getImageData(x, y, 1, 1).data;
      return new Color(r, g, b, a);
    }
    set_pixel(x, y, color) { if (!this.__ctx) return; this.__ctx.fillStyle = css(color); this.__ctx.clearRect(x, y, 1, 1); this.__ctx.fillRect(x, y, 1, 1); }
    __applyFont() {
      const font = this.font || {};
      const name = Array.isArray(font.name) ? font.name[0] : font.name;
      this.__ctx.font = `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${Math.max(1, Number(font.size) || 22)}px ${name ? `"${name}", ` : ''}sans-serif`;
    }
    text_size(text) {
      if (!this.__ctx) return super.text_size(text);
      this.__applyFont();
      return new Rect(0, 0, Math.ceil(this.__ctx.measureText(String(text ?? '')).width), Math.max(1, Number(this.font?.size) || 22));
    }
    draw_text(...args) {
      const [x, y, w, h, text, align = 0] = args[0] && typeof args[0] === 'object' ? [...rectValues(args[0]), args[1], args[2]] : args;
      if (!this.__ctx || text === undefined || text === null) return;
      this.__applyFont();
      const ctx = this.__ctx, string = String(text);
      ctx.textBaseline = 'middle';
      ctx.textAlign = align === 1 ? 'center' : align === 2 ? 'right' : 'left';
      const px = align === 1 ? x + w / 2 : align === 2 ? x + w : x, py = y + h / 2;
      const maxWidth = w > 0 ? w : undefined;
      if (this.font?.shadow) { ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillText(string, px + 1, py + 1, maxWidth); }
      if (this.font?.outline !== false && this.font?.out_color) { ctx.strokeStyle = css(this.font.out_color); ctx.lineWidth = 2; ctx.strokeText(string, px, py, maxWidth); }
      ctx.fillStyle = css(this.font?.color ?? { red: 255, green: 255, blue: 255, alpha: 255 });
      ctx.fillText(string, px, py, maxWidth);
    }
  }
  const drawable = typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined';
  const displayDefaults = { visible: true, x: 0, y: 0, z: 0, ox: 0, oy: 0, opacity: 255, color: undefined, tone: undefined };
  const Sprite = display('Sprite', ['dispose', 'disposed', 'flash', 'update'], { ...displayDefaults, zoom_x: 1, zoom_y: 1, angle: 0, mirror: false, blend_type: 0, bush_depth: 0 });
  const Viewport = display('Viewport', ['dispose', 'disposed', 'flash', 'update'], { ...displayDefaults });
  const Plane = display('Plane', ['dispose', 'disposed'], { ...displayDefaults, zoom_x: 1, zoom_y: 1, blend_type: 0 });
  const Window = display('Window', ['dispose', 'disposed', 'update'], { ...displayDefaults, active: true, pause: false, opacity: 255, back_opacity: 255, contents_opacity: 255, stretch: true });
  const Tilemap = display('Tilemap', ['dispose', 'disposed', 'update'], { ...displayDefaults });

  // Table: RGSS's compact 1-3 dimensional integer array.
  class Table {
    constructor(xsize = 1, ysize = 1, zsize = 1) { this.resize(xsize, ysize, zsize); }
    resize(xsize = 1, ysize = 1, zsize = 1) { this.xsize = xsize; this.ysize = ysize; this.zsize = zsize; this.data = new Array(xsize * ysize * zsize).fill(0); }
    at(x, y = 0, z = 0) { return x >= 0 && x < this.xsize && y >= 0 && y < this.ysize && z >= 0 && z < this.zsize ? this.data[x + this.xsize * (y + this.ysize * z)] : null; }
    put(x, y, z, value) { if (value === undefined) { if (z === undefined) { value = y; y = 0; z = 0; } else { value = z; z = 0; } } if (x >= 0 && x < this.xsize && y >= 0 && y < this.ysize && z >= 0 && z < this.zsize) this.data[x + this.xsize * (y + this.ysize * z)] = value; }
  }

  // ---- Input ------------------------------------------------------------------------------
  const input = {
    ...INPUT_CONSTANTS,
    update() { keys?.update(); },
    press: symbol => Boolean(keys?.down(Number(symbol))),
    trigger: symbol => Boolean(keys?.pressed(Number(symbol))),
    repeat: symbol => Boolean(keys?.pressed(Number(symbol)) || keys?.down(Number(symbol))),
    release: () => false,
    // Extended-key queries (raw key names) share the probe where the name is a known key.
    pressex: () => false, triggerex: () => false, repeatex: () => false, releaseex: () => false,
    dir4() { return keys?.down(INPUT_CONSTANTS.DOWN) ? 2 : keys?.down(INPUT_CONSTANTS.LEFT) ? 4 : keys?.down(INPUT_CONSTANTS.RIGHT) ? 6 : keys?.down(INPUT_CONSTANTS.UP) ? 8 : 0; },
    dir8() { const x = (keys?.down(6) ? 1 : 0) - (keys?.down(4) ? 1 : 0), y = (keys?.down(2) ? 1 : 0) - (keys?.down(8) ? 1 : 0); return x === 0 && y === 0 ? 0 : { '-1,1': 1, '0,1': 2, '1,1': 3, '-1,0': 4, '1,0': 6, '-1,-1': 7, '0,-1': 8, '1,-1': 9 }[`${x},${y}`]; },
    mouse_x: () => 0, mouse_y: () => 0, scroll_v: () => 0, mouse_in_window: () => false, count: () => 0, time: () => 0, repeatcount: () => 0, timeex: () => 0,
    raw_key_states: () => [], delta: () => 0, text_input: false, clipboard: ''
  };

  // A shim reader that Ruby2JS may emit either as a property read (`System.user_language.slice(0, 2)`) or as a call
  // (`System.user_language()`): a function that also forwards property access, and string/number conversion, to its result.
  const callableValue = produce => new Proxy(produce, {
    get: (target, key) => {
      if (key === 'call' || key === 'apply' || key === 'bind') return Reflect.get(target, key);
      if (key === Symbol.toPrimitive) return () => produce();
      const result = produce();
      const value = result?.[key];
      return typeof value === 'function' ? value.bind(result) : value;
    }
  });

  // ---- System ------------------------------------------------------------------------------
  const system = {
    uptime, delta: () => 0, data_directory: () => '', window_title: 'MWGP', set_window_title() {}, show_settings() {}, puts: (...args) => console.log('MWGP RGSS System.puts', ...args),
    platform: () => 'Browser', is_mac: () => false, is_rosetta: () => false, is_linux: () => false, is_windows: () => false, is_wine: () => false,
    is_really_mac: () => false, is_really_linux: () => false, is_really_windows: () => false,
    user_language: callableValue(() => (typeof navigator !== 'undefined' ? navigator.language : 'en')), user_name: () => 'Player', game_title: () => 'MWGP',
    power_state: () => ({ seconds: -1, percent: -1, powered: true }), nproc: () => (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1), memory: () => 0,
    reload_cache() {}, mount() {}, unmount() {}, launch() {}, to_utf8: text => String(text ?? ''), default_font_family() {}
  };

  // ---- Marshal / files -----------------------------------------------------------------------
  const deepClone = (value, seen = new Map()) => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Date) return new Date(value);
    const copy = Array.isArray(value) ? [] : value instanceof Map ? new Map() : value instanceof Set ? new Set() : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    if (value instanceof Map) for (const [key, entry] of value) copy.set(deepClone(key, seen), deepClone(entry, seen));
    else if (value instanceof Set) for (const entry of value) copy.add(deepClone(entry, seen));
    else for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if ('value' in descriptor) copy[key] = deepClone(descriptor.value, seen); else Object.defineProperty(copy, key, descriptor); }
    return copy;
  };
  const MARSHAL = Symbol.for('mwgp.marshal');
  const marshal = {
    // `Marshal.load(Marshal.dump(x))` is Ruby's deep copy; the dump is an opaque in-memory token.
    dump: value => ({ [MARSHAL]: true, value: deepClone(value) }),
    load: token => {
      if (token && token[MARSHAL]) return deepClone(token.value);
      throw new Error('Marshal.load: only data dumped by Marshal.dump in this session can be loaded');
    }
  };
  // Ruby's Errno classes (the game rescues them by class) and the engine's own error classes.
  class SystemCallError extends Error {}
  const Errno = Object.fromEntries(['ENOENT', 'EINVAL', 'EACCES', 'EISDIR', 'EEXIST', 'ENOTDIR'].map(code => [code, class extends SystemCallError { constructor(message) { super(message); this.name = `Errno::${code}`; this.code = code; } }]));
  class RGSSError extends Error {}
  class MKXPError extends Error {}
  const enoent = path => new Errno.ENOENT(`No such file or directory - ${path}`);
  const normalizePath = path => String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  // save_data/load_data: a virtual file store (kept in the saved rpgExtra); files the game ships in
  // Data/ are not converted, so reading one that was never written raises ENOENT like a missing file.
  const load_data = (path, raw = false) => {
    const stored = files.get(normalizePath(path));
    if (stored !== undefined) return deepClone(stored);
    // A Data file the game ships (exported by the converter): the same decoded value every time.
    // `load_data(path, true)` (MKXP): the file's raw contents, here a file the project lists (its text when embedded).
    if (raw === true) { const content = rawFile(String(path)); if (content !== undefined) return content; }
    const bundled = shipped(normalizePath(path));
    if (bundled === undefined) throw enoent(path);
    return bundled;
  };
  const save_data = (object, path) => { files.set(normalizePath(path), deepClone(object)); return true; };

  // Game-defined constants of a module the game re-opens (`module Input; USE = C; end`): read from the
  // top of the transpiled unit without evaluating it, resolving identifiers against the module itself.
  const withGameConstants = (name, base) => {
    let table = null;
    const constants = () => {
      if (table) return table;
      table = {};
      const source = reopened(name);
      if (!source) return table;
      for (const match of source.matchAll(/^\s{2}const\s+([A-Z][A-Z0-9_]*)\s*=\s*([A-Za-z0-9_$.'"-]+)\s*;/gm)) {
        const [, constant, raw] = match;
        table[constant] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : /^['"].*['"]$/.test(raw) ? raw.slice(1, -1) : raw;
      }
      return table;
    };
    return new Proxy(base, {
      get: (target, key) => {
        if (typeof key === 'symbol' || key in target) return Reflect.get(target, key);
        const value = constants()[key];
        if (value === undefined) return undefined;
        return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value) && (value in target || value in constants()) ? (value in target ? target[value] : constants()[value]) : value;
      },
      has: (target, key) => key in target || (typeof key === 'string' && key in constants()),
      // Listed too, so introspection (tools/rgss-coverage.mjs) sees the game's constants.
      ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...Object.keys(constants())])],
      getOwnPropertyDescriptor: (target, key) => key in target ? Reflect.getOwnPropertyDescriptor(target, key)
        : (typeof key === 'string' && key in constants() ? { configurable: true, enumerable: true, writable: false, value: undefined } : undefined)
    });
  };

  return {
    Input: withGameConstants('Input', input), System: withGameConstants('System', system), Marshal: marshal, load_data, save_data,
    Errno, RGSSError, MKXPError, Color, Tone, Rect, Font, Table, Bitmap: drawable ? CanvasBitmap : BitmapBase, Sprite, Viewport, Plane, Window, Tilemap
  };
}
