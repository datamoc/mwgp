// Diagnostic only: PNG forensics for sprite/tileset sheets.
//
// Usage: node tools/diag-sheets.mjs <file.png> [...]
//
// Prints IHDR dimensions, the opaque-pixel bounding box, and seam scores for
// candidate grids (alpha mass lying exactly on grid cut lines; the true grid
// scores far lower than wrong ones). Pure Node, no dependencies.
//
// This is a read-only diagnostic. It never writes manifests or assets: grid
// geometry for conversion must come from the original project's own data
// (MV filename conventions + IHDR dimensions, see tools/convert-mv.js), not
// from pixel scanning.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// Minimal PNG decoder: 8-bit, color types 0/2/3/4/6. Returns { w, h, alpha }
// with alpha as 1 (opaque) / 0 per pixel. Palette images without tRNS treat
// index 0 as transparent (RPG Maker convention for sheet gutters).
export function decodePngAlpha(path) {
  const b = readFileSync(path);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), bd = b[24], ct = b[25];
  if (bd !== 8) throw new Error(`unsupported bit depth ${bd} in ${path}`);
  let pos = 33;
  const idat = [];
  let plte = null, trns = null;
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 6;
  const alpha = new Uint8Array(w * h);
  let p = 0;
  const prev = Buffer.alloc(w * ch), cur = Buffer.alloc(w * ch);
  const paeth = (a, b2, c) => {
    const v = a + b2 - c, pa = Math.abs(v - a), pb = Math.abs(v - b2), pc = Math.abs(v - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < w * ch; x++) {
      const v = raw[p++], a = x >= ch ? cur[x - ch] : 0, b2 = prev[x], c = x >= ch ? prev[x - ch] : 0;
      cur[x] = f === 0 ? v : f === 1 ? (v + a) & 255 : f === 2 ? (v + b2) & 255
        : f === 3 ? (v + ((a + b2) >> 1)) & 255 : (v + paeth(a, b2, c)) & 255;
    }
    for (let x = 0; x < w; x++) {
      let a;
      if (ct === 3) {
        const idx = cur[x];
        a = trns && idx < trns.length ? trns[idx] : 255;
        if (plte && idx === 0 && !trns) a = 0;
      }
      else if (ct === 0) a = cur[x] > 0 ? 255 : 0;
      else if (ct === 2) a = 255;
      else if (ct === 4) a = cur[x * 2 + 1];
      else a = cur[x * 6 + 3];
      alpha[y * w + x] = a > 8 ? 1 : 0;
    }
    prev.set(cur);
  }
  return { w, h, alpha };
}

// Opaque-pixel bounding box ("limits" of the sheet content).
export function contentBox({ w, h, alpha }) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!alpha[y * w + x]) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { opaque: n, x0, y0, x1, y1 };
}

// Total opaque pixels lying exactly on the cut lines of a cols×rows grid.
export function seamScore({ w, h, alpha }, cols, rows) {
  let s = 0;
  for (let c = 1; c < cols; c++) {
    const x = Math.round((c * w) / cols);
    for (let y = 0; y < h; y++) s += alpha[y * w + x];
  }
  for (let r = 1; r < rows; r++) {
    const y = Math.round((r * h) / rows);
    for (let x = 0; x < w; x++) s += alpha[y * w + x];
  }
  return s;
}

const GRIDS = [[12, 8], [3, 4], [16, 16], [8, 16]];
for (const file of process.argv.slice(2)) {
  const img = decodePngAlpha(file);
  const box = contentBox(img);
  console.log(`${file} ${img.w}x${img.h} opaque=${box.opaque} bbox=[${box.x0},${box.y0}..${box.x1},${box.y1}]`);
  for (const [c, r] of GRIDS) {
    if (img.w % c || img.h % r) continue;
    console.log(`  grid ${c}x${r} cell ${img.w / c}x${img.h / r} seam=${seamScore(img, c, r)}`);
  }
}
