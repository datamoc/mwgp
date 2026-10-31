// RPG Maker 2000/2003 chipset geometry, shared by the LCF converter (which
// rewrites map tile ids to atlas frames) and the player (which composes the
// atlas from the chipset image). The chipset is 480x256 px = 30x16 tiles of
// 16 px. Tile ids in a map (EasyRPG/liblcf block layout):
//
//   0-999 / 1000-1999   shallow-water autotiles (blocks A/B, connection-coded)
//   2000-2999           deep-water autotile
//   3000 / 3050 / 3100  animated tiles (waterfall, whirlpool, ice)
//   4000-4599           ground autotiles: 12 blocks of 50 connection variants
//   5000-5143           simple lower tiles
//   10000-10143         simple upper tiles
//
// The atlas keeps the chipset image itself in frames 0-479 (row-major over
// the 30 columns), then one composed frame per autotile id (water first,
// then ground blocks). Each autotile frame splices its four 8x8 quarters
// from the chipset with the engine's own connection tables
// (chipsetTileQuads, after EasyRPG's GenerateAutotileAB/D), at animation
// frame 0: water animation across frames is not composed.

export const CHIPSET_COLS = 30;
export const CHIPSET_ROWS = 16;
export const ATLAS_BASE = CHIPSET_COLS * CHIPSET_ROWS; // 480

const WATER = [0, 1000, 2000];
const ANIMATED = [3000, 3050, 3100];

// The chipset cell (tile coordinates) a simple or animated tile id draws.
export function chipsetCellFor(id) {
  if (id >= 5000 && id < 5144) {
    const index = id - 5000;
    return index < 96 ? { x: 12 + index % 6, y: Math.floor(index / 6) } : { x: 18 + (index - 96) % 6, y: Math.floor((index - 96) / 6) };
  }
  if (id >= 10000 && id < 10144) {
    const index = id - 10000;
    return index < 48 ? { x: 18 + index % 6, y: 8 + Math.floor(index / 6) } : { x: 24 + (index - 48) % 6, y: Math.floor((index - 48) / 6) };
  }
  if (ANIMATED.includes(id)) return { x: 3 + (id - 3000) / 50, y: 4 };
  return null;
}

export function isChipsetAutotile(id) {
  return (id >= 0 && id < 3000) || (id >= 4000 && id < 4600);
}

// Atlas frame for any map tile id (0 stays 0 = empty; frames are 1-based in
// map data the same way the converter writes them: frame+1). The converter
// stores `chipsetFrameFor(id)` directly and the player draws it as-is.
export function chipsetFrameFor(id) {
  if (!id) return 0;
  const cell = chipsetCellFor(id);
  if (cell) return cell.x + cell.y * CHIPSET_COLS + 1;
  if (isChipsetAutotile(id)) return ATLAS_BASE + (id < 3000 ? id : 3000 + (id - 4000)) + 1;
  return 0;
}

// The chipset cell whose texture fills an autotile id in the atlas
// (interior of its block; see the header note).
export function chipsetFillCellFor(id) {
  if (id < 3000) {
    const block = Math.floor(id / 1000);
    return [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 1, y: 5 }][block] || { x: 1, y: 1 };
  }
  const block = Math.floor((id - 4000) / 50);
  const quarterX = block < 4 ? (block % 2) * 3 : 6 + (block % 2) * 3;
  const quarterY = block < 4 ? 8 + Math.floor(block / 2) * 4 : Math.floor((block - 4) / 2) * 4;
  return { x: Math.floor(quarterX / 2) + 1, y: Math.floor(quarterY / 2) + 1 };
}

// Quarter tables of the engine's autotile splicing (EasyRPG
// BlockA_Subtiles_IDS / BlockD_Subtiles_IDS; -1 = take the other block).
const BLOCK_A = [[[-1,-1],[-1,-1]],[[3,-1],[-1,-1]],[[-1,3],[-1,-1]],[[3,3],[-1,-1]],[[-1,-1],[-1,3]],[[3,-1],[-1,3]],[[-1,3],[-1,3]],[[3,3],[-1,3]],[[-1,-1],[3,-1]],[[3,-1],[3,-1]],[[-1,3],[3,-1]],[[3,3],[3,-1]],[[-1,-1],[3,3]],[[3,-1],[3,3]],[[-1,3],[3,3]],[[3,3],[3,3]],[[1,-1],[1,-1]],[[1,3],[1,-1]],[[1,-1],[1,3]],[[1,3],[1,3]],[[2,2],[-1,-1]],[[2,2],[-1,3]],[[2,2],[3,-1]],[[2,2],[3,3]],[[-1,1],[-1,1]],[[-1,1],[3,1]],[[3,1],[-1,1]],[[3,1],[3,1]],[[-1,-1],[2,2]],[[3,-1],[2,2]],[[-1,3],[2,2]],[[3,3],[2,2]],[[1,1],[1,1]],[[2,2],[2,2]],[[0,2],[1,-1]],[[0,2],[1,3]],[[2,0],[-1,1]],[[2,0],[3,1]],[[-1,1],[2,0]],[[3,1],[2,0]],[[1,-1],[0,2]],[[1,3],[0,2]],[[0,0],[1,1]],[[0,2],[0,2]],[[1,1],[0,0]],[[2,0],[2,0]],[[0,0],[0,0]]];
const BLOCK_D = [[[[1,2],[1,2]],[[1,2],[1,2]]],[[[2,0],[1,2]],[[1,2],[1,2]]],[[[1,2],[2,0]],[[1,2],[1,2]]],[[[2,0],[2,0]],[[1,2],[1,2]]],[[[1,2],[1,2]],[[1,2],[2,0]]],[[[2,0],[1,2]],[[1,2],[2,0]]],[[[1,2],[2,0]],[[1,2],[2,0]]],[[[2,0],[2,0]],[[1,2],[2,0]]],[[[1,2],[1,2]],[[2,0],[1,2]]],[[[2,0],[1,2]],[[2,0],[1,2]]],[[[1,2],[2,0]],[[2,0],[1,2]]],[[[2,0],[2,0]],[[2,0],[1,2]]],[[[1,2],[1,2]],[[2,0],[2,0]]],[[[2,0],[1,2]],[[2,0],[2,0]]],[[[1,2],[2,0]],[[2,0],[2,0]]],[[[2,0],[2,0]],[[2,0],[2,0]]],[[[0,2],[0,2]],[[0,2],[0,2]]],[[[0,2],[2,0]],[[0,2],[0,2]]],[[[0,2],[0,2]],[[0,2],[2,0]]],[[[0,2],[2,0]],[[0,2],[2,0]]],[[[1,1],[1,1]],[[1,1],[1,1]]],[[[1,1],[1,1]],[[1,1],[2,0]]],[[[1,1],[1,1]],[[2,0],[1,1]]],[[[1,1],[1,1]],[[2,0],[2,0]]],[[[2,2],[2,2]],[[2,2],[2,2]]],[[[2,2],[2,2]],[[2,0],[2,2]]],[[[2,0],[2,2]],[[2,2],[2,2]]],[[[2,0],[2,2]],[[2,0],[2,2]]],[[[1,3],[1,3]],[[1,3],[1,3]]],[[[2,0],[1,3]],[[1,3],[1,3]]],[[[1,3],[2,0]],[[1,3],[1,3]]],[[[2,0],[2,0]],[[1,3],[1,3]]],[[[0,2],[2,2]],[[0,2],[2,2]]],[[[1,1],[1,1]],[[1,3],[1,3]]],[[[0,1],[0,1]],[[0,1],[0,1]]],[[[0,1],[0,1]],[[0,1],[2,0]]],[[[2,1],[2,1]],[[2,1],[2,1]]],[[[2,1],[2,1]],[[2,0],[2,1]]],[[[2,3],[2,3]],[[2,3],[2,3]]],[[[2,0],[2,3]],[[2,3],[2,3]]],[[[0,3],[0,3]],[[0,3],[0,3]]],[[[0,3],[2,0]],[[0,3],[0,3]]],[[[0,1],[2,1]],[[0,1],[2,1]]],[[[0,1],[0,1]],[[0,3],[0,3]]],[[[0,3],[2,3]],[[0,3],[2,3]]],[[[2,1],[2,1]],[[2,3],[2,3]]],[[[0,1],[2,1]],[[0,3],[2,3]]],[[[1,2],[1,2]],[[1,2],[1,2]]],[[[1,2],[1,2]],[[1,2],[1,2]]],[[[0,0],[0,0]],[[0,0],[0,0]]]];

// The four 8x8 source quarters (chipset pixels, TL/TR/BL/BR) an autotile
// id is composed of at animation frame 0, or null when the id is not a
// composable autotile (the player then falls back to the interior fill).
export function chipsetTileQuads(id) {
  const quarter = (qx, qy, i, j) => ({ x: (qx * 2 + i) * 8, y: (qy * 2 + j) * 8 });
  if (id >= 4000 && id < 4600) {
    const block = Math.floor((id - 4000) / 50);
    const sub = (id - 4000) % 50;
    const bx = block < 4 ? (block % 2) * 3 : 6 + (block % 2) * 3;
    const by = block < 4 ? 8 + Math.floor(block / 2) * 4 : Math.floor((block - 4) / 2) * 4;
    const quads = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) quads.push(quarter(bx + BLOCK_D[sub][j][i][0], by + BLOCK_D[sub][j][i][1], i, j));
    return quads;
  }
  if (id >= 0 && id < 3000) {
    const block = Math.floor(id / 1000);
    const bSub = Math.floor((id - block * 1000) / 50);
    const aSub = id - block * 1000 - bSub * 50;
    if (bSub >= 20 || aSub >= 47) return null;
    const quads = [null, null, null, null];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      if (BLOCK_A[aSub][j][i] === -1) {
        let t = (bSub >> (j * 2 + i)) & 1;
        if (block === 2) t ^= 3;
        quads[j * 2 + i] = quarter(0, 4 + t, i, j);
      } else {
        quads[j * 2 + i] = quarter(block === 1 ? 3 : 0, BLOCK_A[aSub][j][i], i, j);
      }
    }
    if (bSub !== 0 && aSub !== 0) {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        let t = (bSub >> (j * 2 + i)) & 1;
        if (block === 2) t *= 2;
        if (t !== 0) quads[j * 2 + i] = quarter(0, 4 + t, i, j);
      }
    }
    return quads;
  }
  return null;
}

// Every autotile id in atlas order (water ascending, then ground blocks).
export function chipsetAutotileIds() {
  const ids = [];
  for (let id = 0; id < 3000; id++) ids.push(id);
  for (let id = 4000; id < 4600; id++) ids.push(id);
  return ids;
}
