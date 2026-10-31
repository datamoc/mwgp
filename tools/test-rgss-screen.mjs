// Compositor regressions: Ruby transitions hide sprites and planes by setting zoom to zero.
import assert from 'node:assert/strict';
import { createRgssScreen } from '../src/player/rgss-screen.js';

const previousFrame = globalThis.requestAnimationFrame;
try {
  for (const kind of ['sprite', 'plane']) {
    for (const [zoomX, zoomY, expectedVisible] of [[0, 1, false], [1, 0, false], [0, 0, false], [0.5, 0.5, true]]) {
      let render;
      globalThis.requestAnimationFrame = callback => { render = callback; return 1; };
      const draws = [];
      const context = new Proxy({ drawImage: (...args) => draws.push(args) }, {
        get: (target, key) => target[key] ?? (() => {}),
      });
      const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }) };
      const document = {
        querySelector: () => anchor,
        body: { appendChild() {} },
        createElement: () => ({ dataset: {}, style: {}, getContext: () => context, remove() {} }),
      };
      const screen = createRgssScreen({ width: 64, height: 64, document });
      screen.add(kind, { bitmap: { canvas: { width: 32, height: 32 } }, zoom_x: zoomX, zoom_y: zoomY });
      render();
      assert.equal(draws.length > 0, expectedVisible, `${kind} zoom ${zoomX},${zoomY} visibility`);
      screen.destroy();
    }
  }
  // src_rect dimensions fall back independently: a game that narrows only the
  // height (a vertical icon strip) or only the width must still crop on the
  // other axis, not draw the whole sheet from the top.
  for (const [rect, expected] of [
    [{ _x: 0, _y: 32, _width: 0, _height: 32 }, [0, 32, 128, 32]],
    [{ _x: 64, _y: 0, _width: 64, _height: 0 }, [64, 0, 64, 128]],
    [{ _x: 16, _y: 48, _width: 32, _height: 16 }, [16, 48, 32, 16]],
  ]) {
    let render;
    globalThis.requestAnimationFrame = callback => { render = callback; return 1; };
    const draws = [];
    const context = new Proxy({ drawImage: (...args) => draws.push(args) }, {
      get: (target, key) => target[key] ?? (() => {}),
    });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }) };
    const document = {
      querySelector: () => anchor,
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, getContext: () => context, remove() {} }),
    };
    const screen = createRgssScreen({ width: 64, height: 64, document });
    screen.add('sprite', { bitmap: { canvas: { width: 128, height: 128 } }, src_rect: rect });
    render();
    assert.equal(draws.length, 1, `one draw for rect ${JSON.stringify(rect)}`);
    assert.deepEqual(draws[0].slice(1, 5), expected, `source crop for rect ${JSON.stringify(rect)}`);
    screen.destroy();
  }
  // A Window is drawn: translucent backing plus its contents bitmap inside
  // the frame, with the cursor rectangle highlighted.
  {
    let render;
    globalThis.requestAnimationFrame = callback => { render = callback; return 1; };
    const draws = [], fills = [];
    const context = new Proxy({ drawImage: (...args) => draws.push(args), fillRect: (...args) => fills.push(args) }, {
      get: (target, key) => target[key] ?? (() => {}),
      set: (target, key, value) => { target[key] = value; return true; },
    });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }) };
    const document = {
      querySelector: () => anchor,
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, getContext: () => context, remove() {} }),
    };
    const screen = createRgssScreen({ width: 64, height: 64, document });
    const contents = { width: 40, height: 20 };
    screen.add('window', { x: 4, y: 6, width: 56, height: 44, contents: { canvas: contents }, cursor_rect: { _x: 0, _y: 0, _width: 40, _height: 18 } });
    render();
    assert.equal(draws.length, 1, 'window contents drawn once');
    assert.equal(draws[0][0], contents, 'window draws its contents bitmap');
    assert.deepEqual(draws[0].slice(1, 3), [16, 18], 'window contents sit inside the frame');
    assert.ok(fills.length >= 2, 'window backing and cursor are filled');
    screen.destroy();
  }
  // With an RGSS windowskin (192x128) the window draws the skin's background,
  // frame corners/edges and cursor pattern instead of the plain backing.
  {
    let render;
    globalThis.requestAnimationFrame = callback => { render = callback; return 1; };
    const draws = [];
    const context = new Proxy({ drawImage: (...args) => draws.push(args), fillRect: () => {} }, {
      get: (target, key) => target[key] ?? (() => {}),
      set: (target, key, value) => { target[key] = value; return true; },
    });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }) };
    const document = {
      querySelector: () => anchor,
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, getContext: () => context, remove() {} }),
    };
    const screen = createRgssScreen({ width: 64, height: 64, document });
    const skin = { width: 192, height: 128 };
    screen.add('window', { x: 0, y: 0, width: 64, height: 48, windowskin: { canvas: skin }, contents: { canvas: { width: 40, height: 20 } }, cursor_rect: { _x: 0, _y: 0, _width: 40, _height: 18 } });
    render();
    assert.ok(draws.length >= 10, `windowskin frame pieces drawn (${draws.length})`);
    assert.equal(draws[0][0], skin, 'first draw is the windowskin background');
    assert.deepEqual(draws[0].slice(1, 5), [0, 0, 128, 128], 'background pattern source');
    screen.destroy();
  }
  console.log('RGSS compositor: zero and fractional zoom pass for sprites and planes (8 checks), src_rect per-dimension crop (3 checks), window contents/cursor (1 check), windowskin frame (1 check)');
} finally {
  if (previousFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousFrame;
}
