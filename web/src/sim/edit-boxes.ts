// Every agent asks of the edited boxes every tick (is it in one, how far is the nearest), and a round of sustained
// fire leaves thousands (a crater's box per node it touches): asked of a list, 16 players firing the launcher by the
// cathedral for two minutes spent 30-40 ms of a 33 ms tick there. A grid over them keeps each answer to the cells
// round the point, each cell holding the boxes cut to it, a cut box inside another left out: where craters crowd, a
// cell holds a few boxes, not hundreds. Both answers ask only of the boxes' union, so they stay exact.

/** a box in map metres [x0, z0, x1, z1) */
export type EditBox = [number, number, number, number];

const CELL = 16;
const key = (cx: number, cz: number) => cx * 100003 + cz;
const inside = (a: EditBox, b: EditBox) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

export class EditBoxes {
  private boxes: EditBox[] = [];
  private cells = new Map<number, EditBox[]>();
  private lo = [Infinity, Infinity];
  private hi = [-Infinity, -Infinity];

  /** the boxes, in the order edited (one edited twice: twice) */
  get all(): readonly EditBox[] { return this.boxes; }

  get length() { return this.boxes.length; }

  /** the box round them all ([Infinity, Infinity, -Infinity, -Infinity]: none) */
  get bounds(): EditBox { return [this.lo[0], this.lo[1], this.hi[0], this.hi[1]]; }

  add(b: EditBox) {
    this.boxes.push(b);
    this.index(b);
  }

  /** the boxes meeting box forgotten */
  clear(box: EditBox) {
    const kept = this.boxes.filter((b) => !(b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]));
    if (kept.length === this.boxes.length) return;
    this.boxes = kept;
    this.cells.clear();
    this.lo = [Infinity, Infinity];
    this.hi = [-Infinity, -Infinity];
    for (const b of kept) this.index(b);
  }

  /** is (x, z) in a box? */
  has(x: number, z: number) {
    const list = this.cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (list) for (const b of list) if (x >= b[0] && z >= b[1] && x < b[2] && z < b[3]) return true;
    return false;
  }

  /** m from (x, z) to the nearest box (0 inside one) where that is at most max; else more than max (Infinity) */
  dist(x: number, z: number, max: number) {
    const [x0, z0] = this.lo, [x1, z1] = this.hi;
    if (!this.boxes.length || Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)) > max) return Infinity;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const r0x = Math.floor(x0 / CELL), r0z = Math.floor(z0 / CELL), r1x = Math.floor(x1 / CELL), r1z = Math.floor(z1 / CELL);
    const last = Math.max(cx - r0x, r1x - cx, cz - r0z, r1z - cz);
    let d = Infinity;
    for (let k = 0; k <= last; k++) {
      // (ring k: the cells k from the point's, none of them nearer than k - 1 cells)
      const near = (k - 1) * CELL;
      if (near > max || near >= d) break;
      for (let qz = Math.max(r0z, cz - k); qz <= Math.min(r1z, cz + k); qz++) {
        const edge = qz === cz - k || qz === cz + k;
        for (let qx = cx - k; qx <= cx + k; qx += edge || k === 0 ? 1 : 2 * k) {
          const list = qx < r0x || qx > r1x ? undefined : this.cells.get(key(qx, qz));
          if (list) for (const b of list) d = Math.min(d, Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3])));
        }
      }
    }
    return d;
  }

  private index(b: EditBox) {
    this.lo = [Math.min(this.lo[0], b[0]), Math.min(this.lo[1], b[1])];
    this.hi = [Math.max(this.hi[0], b[2]), Math.max(this.hi[1], b[3])];
    // (a box's [x1, z1) open: its last cell the one holding just under x1)
    for (let cz = Math.floor(b[1] / CELL); cz <= Math.floor((b[3] - 1e-9) / CELL); cz++) {
      for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor((b[2] - 1e-9) / CELL); cx++) {
        const cut: EditBox = [Math.max(b[0], cx * CELL), Math.max(b[1], cz * CELL), Math.min(b[2], (cx + 1) * CELL), Math.min(b[3], (cz + 1) * CELL)];
        const k = key(cx, cz), list = this.cells.get(k);
        if (!list) { this.cells.set(k, [cut]); continue; }
        if (list.some((o) => inside(cut, o))) continue;
        const kept = list.filter((o) => !inside(o, cut));
        kept.push(cut);
        this.cells.set(k, kept);
      }
    }
  }
}
