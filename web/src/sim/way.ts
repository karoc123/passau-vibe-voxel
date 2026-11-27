import { WALKER_HEAD } from './solids';
import { STEP, type Ground } from './walk';

/** m an NPC's way may drop from one cell to the next (a wall or a ledge higher is a way down it never takes) */
const DROP = 3;
// a square window of cells at most this many a side (160 m: 25 600 cells), its margin round the start and the goal
const MAX_SIDE = 160, MARGIN = 16;
// a cell's cost: across, the diagonal, a step up on top, water (slow, wading or swimming)
const DIAG = Math.SQRT2, UP = 0.5, WET = 3;
// the distance left weighted a little over the cost so far: of the many ways of equal cost across open ground the
// search follows one instead of reading them all
const TIE = 1.01;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** the voxels a walkable grid is read from: the walk's ground (water a floor at its made-up bed) and whether a column
 * is loaded (a column not loaded is no floor: waterColumn null) */
export type WayWorld = Ground & { surface(x: number, z: number): number | null; loaded(x: number, z: number): boolean };

// The walkable grid round a walker: a metre a cell, each cell's floor read the first time the search reaches it from a
// neighbour, by the walk's own rules (at most a step up or DROP down, headroom over it), so where a bridge crosses a
// street a cell takes the level the walker comes to it on. A cell inside a wall has no floor: its column is blocked
// at the height it would be stood on. Read as the search goes, not ahead (a search reads a few thousand cells, not
// the window's tens of thousands). Way finding needs no data from the pipeline: any map's voxels do.
export class WalkGrid {
  readonly x0: number;
  readonly z0: number;
  readonly n: number;
  /** each cell's floor (m), NaN: none (a wall, too high, not loaded) or not read */
  readonly floor: Float32Array;
  // 1: read (its floor, NaN or not, is its floor), 2: and in water
  private readonly read: Uint8Array;
  /** an edit touched the window since: the grid no longer says what is walkable */
  stale = false;
  /** a column in the window was not loaded: a way through it may have been missed */
  partial = false;
  /** the cells read */
  cells = 0;

  /** the grid round the walker at (x, z), its soles at feet, wide enough for the goal (gx, gz) within MAX_SIDE */
  constructor(private readonly w: WayWorld, x: number, z: number, feet: number, gx: number, gz: number) {
    const lo = (a: number, b: number) => Math.floor(Math.min(a, b)) - MARGIN, hi = (a: number, b: number) => Math.floor(Math.max(a, b)) + MARGIN;
    const side = Math.min(MAX_SIDE, Math.max(hi(x, gx) - lo(x, gx), hi(z, gz) - lo(z, gz)) + 1);
    // (the window centred between start and goal, the start always in it)
    const cx = Math.floor(Math.max(Math.min((x + gx) / 2, x + side / 2 - MARGIN / 2), x - side / 2 + MARGIN / 2));
    const cz = Math.floor(Math.max(Math.min((z + gz) / 2, z + side / 2 - MARGIN / 2), z - side / 2 + MARGIN / 2));
    this.n = side; this.x0 = cx - (side >> 1); this.z0 = cz - (side >> 1);
    this.floor = new Float32Array(side * side).fill(NaN);
    this.read = new Uint8Array(side * side);
    const s = this.at(x, z);
    this.floor[s] = feet; this.read[s] = 1;
  }

  /** the cell index of map point (x, z), -1 outside the window */
  at(x: number, z: number) {
    const i = Math.floor(x) - this.x0, j = Math.floor(z) - this.z0;
    return i < 0 || j < 0 || i >= this.n || j >= this.n ? -1 : i + j * this.n;
  }

  /** whether the window covers any of box [x0, z0, x1, z1) */
  covers(b: readonly [number, number, number, number]) {
    return b[0] < this.x0 + this.n && b[2] > this.x0 && b[1] < this.z0 + this.n && b[3] > this.z0;
  }

  // the floor of cell k, read from a floor at f if it has not been yet
  private cell(k: number, f: number) {
    if (this.read[k]) return this.floor[k];
    const n = this.n, x = this.x0 + (k % n) + 0.5, z = this.z0 + ((k / n) | 0) + 0.5, w = this.w;
    this.cells++;
    this.read[k] = 1;
    if (!w.loaded(x, z)) { this.partial = true; return NaN; }
    const sup = w.support(x, z, f + STEP);
    if (sup < f - DROP || w.blocked(x, z, Math.max(sup, f + STEP), Math.max(sup, f) + WALKER_HEAD)) return NaN;
    const s = w.surface(x, z);
    if (s !== null && s > sup) this.read[k] = 2;
    return this.floor[k] = sup;
  }

  // whether a walker goes from cell a straight on to its neighbour b (a diagonal: past both cells beside it)
  private passes(a: number, b: number) {
    const fa = this.floor[a], fb = this.cell(b, fa);
    if (Number.isNaN(fb) || fb - fa > STEP || fa - fb > DROP) return false;
    const n = this.n, di = (b % n) - (a % n), dj = ((b / n) | 0) - ((a / n) | 0);
    if (di && dj) {
      const p = this.cell(a + di, fa), q = this.cell(a + dj * n, fa);
      if (Number.isNaN(p) || Number.isNaN(q) || Math.abs(p - fa) > STEP || Math.abs(q - fa) > STEP) return false;
    }
    return true;
  }

  /** the way from map point (x, z) to (gx, gz): the points to walk to in turn (each a cell's middle, the straight
   * stretches between them shortened to their ends), the goal's cell last, or the reached cell nearest the goal when
   * the goal is out of reach or outside the window; null: the start is no floor */
  way(x: number, z: number, gx: number, gz: number): { x: number; z: number }[] | null {
    const n = this.n, F = this.floor, s = this.at(x, z);
    if (s < 0 || Number.isNaN(F[s])) return null;
    const ti = Math.max(0, Math.min(n - 1, Math.floor(gx) - this.x0)), tj = Math.max(0, Math.min(n - 1, Math.floor(gz) - this.z0));
    const h = (c: number) => { const dx = Math.abs(c % n - ti), dz = Math.abs(((c / n) | 0) - tj); return (Math.max(dx, dz) + (DIAG - 1) * Math.min(dx, dz)) * TIE; };
    const g = new Float32Array(n * n).fill(Infinity), from = new Int32Array(n * n).fill(-1), done = new Uint8Array(n * n);
    const heap = new Heap();
    g[s] = 0;
    heap.push(s, h(s));
    let best = s, bestH = h(s);
    while (heap.size) {
      const c = heap.pop();
      if (done[c]) continue;
      done[c] = 1;
      const hc = h(c);
      if (hc < bestH) { best = c; bestH = hc; }
      if (hc === 0) break;
      const i = c % n, j = (c / n) | 0;
      for (const [di, dj] of DIRS) {
        const a = i + di, b = j + dj, k = a + b * n;
        if (a < 0 || b < 0 || a >= n || b >= n || done[k] || !this.passes(c, k)) continue;
        const cost = g[c] + ((di && dj ? DIAG : 1) + Math.max(0, F[k] - F[c]) * UP) * (this.read[k] === 2 ? WET : 1);
        if (cost < g[k]) { g[k] = cost; from[k] = c; heap.push(k, cost + h(k)); }
      }
    }
    // the cells where the way turns (a straight run's ends), then straight on past those the walk can go straight
    // past: a corner turned at the corner, a slope not walked as a staircase of cells
    const cells: number[] = [];
    for (let c = best, d = 0; c >= 0; c = from[c]) {
      const p = from[c], e = p < 0 ? 0 : c - p;
      if (!cells.length || p < 0 || e !== d) cells.push(c);
      d = e;
    }
    cells.reverse();
    const out: { x: number; z: number }[] = [];
    let k = 0;
    while (k < cells.length - 1) {
      let m = k + 1;
      while (m + 1 < cells.length && this.straight(cells[k], cells[m + 1])) m++;
      out.push(this.mid(cells[m]));
      k = m;
    }
    return out;
  }

  private mid(c: number) { return { x: this.x0 + (c % this.n) + 0.5, z: this.z0 + ((c / this.n) | 0) + 0.5 }; }

  // whether the line between the middles of cells a and b crosses only cells the walk passes from one to the next,
  // with the body's width (0.35 m to each side) on floor too
  private straight(a: number, b: number) {
    const A = this.mid(a), B = this.mid(b), L = Math.hypot(B.x - A.x, B.z - A.z), steps = Math.ceil(L / 0.25);
    let prev = a;
    for (let t = 1; t <= steps; t++) {
      const x = A.x + (B.x - A.x) * t / steps, z = A.z + (B.z - A.z) * t / steps;
      for (const [ox, oz] of BODY) {
        const c = this.at(x + ox, z + oz);
        if (c < 0 || (c !== prev && !this.near(prev, c))) return false;
      }
      const c = this.at(x, z);
      if (c !== prev) { if (!this.passes(prev, c)) return false; prev = c; }
    }
    return true;
  }

  // whether cell c is a floor a walker on cell p could stand beside (within a step of it)
  private near(p: number, c: number) {
    const f = this.cell(c, this.floor[p]);
    return !Number.isNaN(f) && Math.abs(f - this.floor[p]) <= STEP;
  }
}

const BODY = [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]];

// a binary heap of cells by their key (the A* search's open set; a cell pushed again with a lower key, the old entry
// skipped when popped)
class Heap {
  private readonly id: number[] = [];
  private readonly key: number[] = [];
  size = 0;
  push(c: number, k: number) {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key[p] <= k) break;
      this.id[i] = this.id[p]; this.key[i] = this.key[p]; i = p;
    }
    this.id[i] = c; this.key[i] = k;
  }
  pop() {
    const top = this.id[0], last = --this.size, c = this.id[last], k = this.key[last];
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= last) break;
      if (m + 1 < last && this.key[m + 1] < this.key[m]) m++;
      if (this.key[m] >= k) break;
      this.id[i] = this.id[m]; this.key[i] = this.key[m]; i = m;
    }
    this.id[i] = c; this.key[i] = k;
    return top;
  }
}
