// Party formations for multi-unit battles (an extension of RPG Maker's Formation scene, which only reorders members).
//
// A formation is a geometric arrangement of the party on the battle stage: line, column, triangle, inverted
// triangle, square, diamond, chevron, circle, or MV's own staggered default. Slot 0 is the party leader and takes the
// most exposed position of the shape. Rows run front (facing the enemy) to back; a formation with three or more
// rows also gives the front row more attention from enemies and the back row some cover:
//
//   front row   TGR x1.5 (targeted more often)   physical damage taken x1.10
//   back row    TGR x0.6                          physical damage taken x0.85
//   other rows  neutral
//
// A single row (line) or two rows are neutral except front/back as above when there are at least two distinct rows.
// These multipliers are this player's own rule, not RPG Maker behaviour; the RPG Maker part is only the
// party order and the "default" shape. Pure ESM, no DOM: tools/test-smoke.mjs imports it in Node.

// Offsets are in slot units: +x is deeper into the party's own side (away from the enemy), y is across.
const SHAPES = {
  // MV's own layout (Sprite_Actor home positions): a diagonal stagger.
  default: n => Array.from({ length: n }, (_, index) => ({ x: index * 0.6, y: index * 0.9 })),
  // Side by side across the screen, all at the same depth.
  line: n => Array.from({ length: n }, (_, index) => ({ x: 0, y: index - (n - 1) / 2 })),
  // Single file into the depth of the stage, the leader in front.
  column: n => Array.from({ length: n }, (_, index) => ({ x: index, y: (index % 2) * 0.35 })),
  // A wedge pointing at the enemy: 1, 2, 3, ... members per row.
  triangle: n => rowsOf(n, r => r + 1, (r, c, size) => ({ x: r, y: c - (size - 1) / 2 })),
  // The reverse wedge: the widest row leads and the party narrows behind it.
  inverted: n => {
    const sizes = triangleSizes(n).reverse();
    return sizes.flatMap((size, r) => Array.from({ length: size }, (_, c) => ({ x: r, y: c - (size - 1) / 2 })));
  },
  // A block, two or three wide.
  square: n => {
    const width = n <= 4 ? 2 : 3;
    return Array.from({ length: n }, (_, index) => ({ x: Math.floor(index / width), y: (index % width) - (Math.min(width, n) - 1) / 2 }));
  },
  // Front, a pair, a middle piece and a back point; extra members fill the centre line behind.
  diamond: n => [{ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 2, y: -1.6 }, { x: 2, y: 1.6 }].slice(0, n),
  // A chevron "<": the leader at the point, the rest sweeping back on both sides.
  chevron: n => Array.from({ length: n }, (_, index) => {
    if (index === 0) return { x: 0, y: 0 };
    const side = index % 2 ? -1 : 1, step = Math.ceil(index / 2);
    return { x: step, y: side * step };
  }),
  // A ring around a centre, the leader facing the enemy.
  circle: n => n === 1 ? [{ x: 0, y: 0 }] : Array.from({ length: n }, (_, index) => {
    const angle = Math.PI + (index / n) * Math.PI * 2, radius = 0.55 + n * 0.12;
    return { x: 1 + Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  })
};

function triangleSizes(n) {
  const sizes = [];
  for (let row = 0, left = n; left > 0; row++) { const size = Math.min(row + 1, left); sizes.push(size); left -= size; }
  return sizes;
}
function rowsOf(n, sizeFor, place) {
  const out = [];
  for (let row = 0, left = n; left > 0; row++) {
    const size = Math.min(sizeFor(row), left);
    for (let column = 0; column < size; column++) out.push(place(row, column, size));
    left -= size;
  }
  return out;
}

export const FORMATION_NAMES = Object.keys(SHAPES);
export const FORMATION_LABELS = {
  default: 'Default (staggered)', line: 'Line', column: 'Column', triangle: 'Triangle', inverted: 'Inverted triangle',
  square: 'Square', diamond: 'Diamond', chevron: 'Chevron', circle: 'Circle'
};

// The slots for `count` members: [{ x, y, row, rows }] with row 0 the front (smallest x). An unknown name is the default.
export function layoutFormation(name, count) {
  const n = Math.max(0, Math.floor(count));
  const slots = (SHAPES[name] || SHAPES.default)(n).slice(0, n);
  const depths = [...new Set(slots.map(slot => Math.round(slot.x * 100) / 100))].sort((a, b) => a - b);
  return slots.map(slot => ({ ...slot, row: depths.indexOf(Math.round(slot.x * 100) / 100), rows: depths.length }));
}

// TGR / physical-damage multipliers for a slot; neutral unless the formation has at least two distinct rows.
export function rowModifiers(row, rows) {
  if (!(rows >= 2)) return { tgr: 1, pdr: 1 };
  if (row === 0) return { tgr: 1.5, pdr: 1.1 };
  if (row === rows - 1) return { tgr: 0.6, pdr: 0.85 };
  return { tgr: 1, pdr: 1 };
}

// Pixel positions on the battle stage (MV's 816x624 space, party on the right) for `count` members.
export function stagePositions(name, count, { x = 620, y = 300, spacing = 58 } = {}) {
  const slots = layoutFormation(name, count);
  const centreY = slots.length ? slots.reduce((sum, slot) => sum + slot.y, 0) / slots.length : 0;
  return slots.map(slot => ({ x: x + slot.x * spacing, y: y + (slot.y - centreY) * spacing }));
}
