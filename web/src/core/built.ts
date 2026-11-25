// What of the map is built (meta.json `built`, scripts/aoi.py built_boxes): the map is its rectangle's 1024 m blocks
// of the project grid that scripts/map.json lists; a block not listed is empty, as beyond the map: no node file, no
// terrain, a wall for whatever moves. Without `built` the whole rectangle is. Plain data, no three.js, no DOM.

// the blocks' size (scripts/window.py ALIGN): a built box lies in one block, from its north-west corner
export const BLOCK = 1024;

export interface BuiltMeta { W: number; D: number; built?: [number, number, number, number][] }

export class Built {
  readonly W: number;
  readonly D: number;
  // every cell of the rectangle built
  readonly whole: boolean;
  private readonly nbx: number;
  // per block (row-major, BLOCK m): its built box [x0, z0, x1, z1], null: none
  private readonly boxes: ([number, number, number, number] | null)[];

  constructor(meta: BuiltMeta) {
    this.W = meta.W;
    this.D = meta.D;
    this.whole = !meta.built;
    this.nbx = Math.ceil(meta.W / BLOCK);
    this.boxes = new Array(this.nbx * Math.ceil(meta.D / BLOCK)).fill(null);
    for (const b of meta.built ?? []) this.boxes[Math.floor(b[1] / BLOCK) * this.nbx + Math.floor(b[0] / BLOCK)] = b;
  }

  // is map cell (x, z) (x east, z the row south; any number) on the map and built?
  at(x: number, z: number) {
    if (!(x >= 0 && z >= 0 && x < this.W && z < this.D)) return false;
    if (this.whole) return true;
    const b = this.boxes[Math.floor(z / BLOCK) * this.nbx + Math.floor(x / BLOCK)];
    return !!b && x >= b[0] && z >= b[1] && x < b[2] && z < b[3];
  }

  // does the box [x0, x1) x [z0, z1) (map cells) hold a built cell? (a node: its node file exists)
  any(x0: number, z0: number, x1: number, z1: number) {
    x0 = Math.max(x0, 0); z0 = Math.max(z0, 0); x1 = Math.min(x1, this.W); z1 = Math.min(z1, this.D);
    if (x0 >= x1 || z0 >= z1) return false;
    if (this.whole) return true;
    for (let bz = Math.floor(z0 / BLOCK); bz <= Math.floor((z1 - 1) / BLOCK); bz++) {
      for (let bx = Math.floor(x0 / BLOCK); bx <= Math.floor((x1 - 1) / BLOCK); bx++) {
        const b = this.boxes[bz * this.nbx + bx];
        if (b && b[0] < x1 && b[2] > x0 && b[1] < z1 && b[3] > z0) return true;
      }
    }
    return false;
  }

  // node (tx, ty) of n m (a node of the tiles: tiles.N * s; a chunk) holds a built cell
  node(n: number, tx: number, ty: number) { return this.any(tx * n, ty * n, (tx + 1) * n, (ty + 1) * n); }

  // is all of [x0, x1) x [z0, z1) built? (every corner's block's box holds the whole box: boxes are whole blocks
  // or their first rows, so a box within one block row and two block columns is checked at its corners)
  all(x0: number, z0: number, x1: number, z1: number) {
    if (this.whole) return x0 >= 0 && z0 >= 0 && x1 <= this.W && z1 <= this.D;
    for (let bz = Math.floor(z0 / BLOCK); bz <= Math.floor((z1 - 1e-9) / BLOCK); bz++) {
      for (let bx = Math.floor(x0 / BLOCK); bx <= Math.floor((x1 - 1e-9) / BLOCK); bx++) {
        if (bx < 0 || bz < 0 || bx >= this.nbx) return false;
        const b = this.boxes[bz * this.nbx + bx];
        if (!b || Math.max(x0, bx * BLOCK) < b[0] || Math.max(z0, bz * BLOCK) < b[1]
          || Math.min(x1, (bx + 1) * BLOCK) > b[2] || Math.min(z1, (bz + 1) * BLOCK) > b[3]) return false;
      }
    }
    return true;
  }
}
