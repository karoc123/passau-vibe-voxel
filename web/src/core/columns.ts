// An editable node: the column runs of one level-1 node (scripts/tilefile.py, tile-data.ts decodeTile) with edits on
// top, and the edits' geometry in map cells. Pure data: no three.js, no DOM (docs/adr/0001-world-layers.md); the
// viewer, node tools and a future server share it.
//
// A node holds N x N cells and a one-cell apron (its margin) round them: S = N + 2 columns a side, row-major, row =
// south. Local coordinates here: x (east) and y (south) in -1..N, -1 and N being the margin, so local (x, y) is column
// (x + 1) + S * (y + 1); z up in cells from the volume's floor (meta.json base). The margin columns are copies of the
// neighbours' edge columns, so an edit near a node's edge changes up to four nodes' files (touchedNodes).
//
// Canonical runs (scripts/tiles.py column_runs): per column, bottom to top, the maximal runs of one palette id, air (id
// 0) left out: no empty runs, no air runs, no two touching runs of the same id. encode() writes that form, so a node
// rebuilt from its edits holds the same bytes the pipeline would write for the same voxels.
import type { RawColumns } from './tile-data';

// What an edit replaces: every cell in its shape, only the air in it (build without overwriting), only the voxels in
// it (repaint, or carve without touching the air)
export const REPLACE_ALL = 0, REPLACE_AIR = 1, REPLACE_SOLID = 2;
export type Replace = typeof REPLACE_ALL | typeof REPLACE_AIR | typeof REPLACE_SOLID;
// the runs' z and length are uint16
export const Z_MAX = 0xffff;

// An edit in map cells (the node files' frame: x east, y south from the map's corner, z cells over the floor). id: a
// palette id, 0 air. box: w x d x h cells from (x, y, z); sphere: the cells whose centres lie within r of the centre
// cell's centre.
export type CellOp =
  | { kind: 'set'; x: number; y: number; z: number; id: number }
  | { kind: 'box'; x: number; y: number; z: number; w: number; d: number; h: number; id: number; replace?: Replace }
  | { kind: 'sphere'; x: number; y: number; z: number; r: number; id: number; replace?: Replace };

export interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } // [x0, x1) etc.

export interface NodeColumns extends RawColumns { ground: Uint8Array }

// the cells an op may change (exclusive upper bounds; z not clipped to the floor)
export function opBounds(op: CellOp): Box {
  if (op.kind === 'set') return { x0: op.x, y0: op.y, z0: op.z, x1: op.x + 1, y1: op.y + 1, z1: op.z + 1 };
  if (op.kind === 'box') return { x0: op.x, y0: op.y, z0: op.z, x1: op.x + op.w, y1: op.y + op.d, z1: op.z + op.h };
  const k = Math.floor(op.r);
  return { x0: op.x - k, y0: op.y - k, z0: op.z - k, x1: op.x + k + 1, y1: op.y + k + 1, z1: op.z + k + 1 };
}

// The level-1 nodes (tx, ty) whose files an op changes: each node's window is its N x N cells and the margin round them,
// map cells tx * N - 1 .. tx * N + N, so an op on a node's edge column also touches the neighbour that copies it. nx,
// ny (meta.json tiles.levels[0]): only nodes that exist.
export function touchedNodes(op: CellOp, N: number, nx = Infinity, ny = Infinity): [number, number][] {
  const b = opBounds(op), out: [number, number][] = [];
  if (b.x1 <= b.x0 || b.y1 <= b.y0 || b.z1 <= Math.max(b.z0, 0)) return out;
  // window [t * N - 1, t * N + N] meets [a0, a1 - 1] <=> ceil(a0 / N) - 1 <= t <= floor(a1 / N)
  const tx0 = Math.max(0, Math.ceil(b.x0 / N) - 1), tx1 = Math.min(nx - 1, Math.floor(b.x1 / N));
  const ty0 = Math.max(0, Math.ceil(b.y0 / N) - 1), ty1 = Math.min(ny - 1, Math.floor(b.y1 / N));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push([tx, ty]);
  return out;
}

// The ground per column: the end of the run of voxels from z = 0 up, whatever their ids, capped by cap (the base
// build's ground) where given.
// - The pipeline's ground (grnd, scripts/tiles.py: the first free voxel over the terrain) is not derivable from the
//   runs: a building stands on the ground in one stack with it, so the stack ends at its roof. Capped by the base's
//   ground, an edit lowers the ground where it digs below it and never raises it (a player's wall or a pile on a field
//   is not ground); a column whose stack is untouched keeps its ground (the stack reaches at least the ground in the
//   files: the tunnels' bores, scripts/tunnels.py, make the ground their floor and leave air over it).
// - Water counts like any voxel: in the files the river's top voxel is the ground's (ground = the water's surface), and
//   physics/rapier/terrain.ts lowers the solid ground to the water's bottom when it builds a tile (water not solid).
//   Kept that way here, so terrain.ts reads edited columns as it reads the base. Carving the water itself lowers the
//   ground with it; nothing flows in (no water simulation).
// - uint8: at most 255.
export function recomputeGround(cols: RawColumns, cap?: Uint8Array, out = new Uint8Array(cols.counts.length)) {
  const { counts, runs } = cols;
  for (let c = 0, k = 0; c < counts.length; c++) {
    let e = 0;
    for (let i = 0; i < counts[c]; i++, k += 3) if (runs[k] === e) e += runs[k + 1];
    out[c] = Math.min(e, cap ? cap[c] : 255, 255);
  }
  return out;
}

// One column's runs after setting [z0, z1) to id (as replace says), canonical if runs was
function spanColumn(runs: number[], z0: number, z1: number, id: number, replace: Replace): number[] {
  const pieces: number[] = [];
  let cover = z0; // the bottom of the window's part not yet seen, for its gaps
  const gap = (a: number, b: number) => { if (a < b && id && replace !== REPLACE_SOLID) pieces.push(a, b - a, id); };
  for (let k = 0; k < runs.length; k += 3) {
    const a = runs[k], b = a + runs[k + 1], p = runs[k + 2];
    if (a < z0) pieces.push(a, Math.min(b, z0) - a, p);
    const lo = Math.max(a, z0), hi = Math.min(b, z1);
    if (lo < hi) {
      gap(cover, lo);
      cover = hi;
      const q = replace === REPLACE_AIR ? p : id;
      if (q) pieces.push(lo, hi - lo, q);
    }
    if (b > z1) pieces.push(Math.max(a, z1), b - Math.max(a, z1), p);
  }
  gap(Math.max(cover, z0), z1);
  // sorted by bottom (a few runs: insertion), then touching runs of one id merged
  for (let i = 3; i < pieces.length; i += 3) {
    const a = pieces[i], l = pieces[i + 1], p = pieces[i + 2];
    let j = i - 3;
    for (; j >= 0 && pieces[j] > a; j -= 3) { pieces[j + 3] = pieces[j]; pieces[j + 4] = pieces[j + 1]; pieces[j + 5] = pieces[j + 2]; }
    pieces[j + 3] = a; pieces[j + 4] = l; pieces[j + 5] = p;
  }
  const out: number[] = [];
  for (let i = 0; i < pieces.length; i += 3) {
    const n = out.length;
    if (n && out[n - 1] === pieces[i + 2] && out[n - 3] + out[n - 2] === pieces[i]) out[n - 2] += pieces[i + 1];
    else out.push(pieces[i], pieces[i + 1], pieces[i + 2]);
  }
  return out;
}

export class EditableNode {
  readonly S: number;
  private readonly off: Uint32Array;
  // the edited columns' runs (flat z0, len, id); the rest read from base
  private readonly edited = new Map<number, number[]>();

  // base: the node's decoded columns (decodeTile: counts, runs, ground; not copied, never written). (tx, ty): the
  // node's place among the level-1 nodes, for apply's map cells.
  constructor(readonly N: number, readonly base: NodeColumns, readonly tx = 0, readonly ty = 0) {
    this.S = N + 2;
    const C = this.S * this.S;
    if (base.counts.length !== C || base.ground.length !== C) throw new Error(`EditableNode: ${base.counts.length} columns, not ${C}`);
    this.off = new Uint32Array(C + 1);
    for (let c = 0; c < C; c++) this.off[c + 1] = this.off[c] + base.counts[c];
    if (this.off[C] * 3 !== base.runs.length) throw new Error(`EditableNode: ${base.runs.length / 3} runs, the counts say ${this.off[C]}`);
  }

  get editedColumns() { return this.edited.size; }

  private col(x: number, y: number) {
    if (!(x >= -1 && y >= -1 && x <= this.N && y <= this.N) || x !== Math.floor(x) || y !== Math.floor(y)) throw new Error(`EditableNode: (${x}, ${y}) not in the node`);
    return x + 1 + this.S * (y + 1);
  }

  private runsOf(c: number): ArrayLike<number> {
    const e = this.edited.get(c);
    return e ?? this.base.runs.subarray(this.off[c] * 3, this.off[c + 1] * 3);
  }

  // the palette id at local (x, y, z), 0: air
  get(x: number, y: number, z: number) {
    const r = this.runsOf(this.col(x, y));
    for (let k = 0; k < r.length; k += 3) if (z < r[k]) break; else if (z < r[k] + r[k + 1]) return r[k + 2];
    return 0;
  }

  // cells [z0, z1) of local column (x, y) set to id, as replace says (clipped to 0..Z_MAX)
  span(x: number, y: number, z0: number, z1: number, id: number, replace: Replace = REPLACE_ALL) {
    z0 = Math.max(0, z0); z1 = Math.min(Z_MAX, z1);
    if (z0 >= z1) return;
    if (!(id >= 0 && id <= 0xffff && id === Math.floor(id))) throw new Error(`EditableNode: palette id ${id}`);
    const c = this.col(x, y), r = this.runsOf(c);
    this.edited.set(c, spanColumn(Array.from(r), z0, z1, id, replace));
  }

  set(x: number, y: number, z: number, id: number) { this.span(x, y, z, z + 1, id); }

  // the box [min, max) (local cells) clipped to the node and its margin
  fillBox(min: readonly [number, number, number], max: readonly [number, number, number], id: number, replace: Replace = REPLACE_ALL) {
    const x0 = Math.max(-1, min[0]), x1 = Math.min(this.N + 1, max[0]), y0 = Math.max(-1, min[1]), y1 = Math.min(this.N + 1, max[1]);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.span(x, y, min[2], max[2], id, replace);
  }

  // the cells whose centres lie within r of the centre cell's (local) centre, clipped to the node and its margin; by
  // default to air (opts.id: another id; opts.replace: REPLACE_SOLID leaves the air as it is, REPLACE_AIR fills only it)
  carveSphere(center: readonly [number, number, number], r: number, opts: { id?: number; replace?: Replace } = {}) {
    const [cx, cy, cz] = center, k = Math.floor(r), r2 = r * r, id = opts.id ?? 0;
    for (let y = Math.max(-1, cy - k); y <= Math.min(this.N, cy + k); y++) {
      for (let x = Math.max(-1, cx - k); x <= Math.min(this.N, cx + k); x++) {
        const rest = r2 - (x - cx) ** 2 - (y - cy) ** 2;
        if (rest < 0) continue;
        let h = Math.floor(Math.sqrt(rest));
        while ((h + 1) * (h + 1) <= rest) h++;
        while (h * h > rest) h--;
        this.span(x, y, cz - h, cz + h + 1, id, opts.replace ?? REPLACE_ALL);
      }
    }
  }

  // an op in map cells, clipped to this node's window (nothing outside it changes)
  apply(op: CellOp) {
    const ox = this.tx * this.N, oy = this.ty * this.N, x = op.x - ox, y = op.y - oy;
    if (op.kind === 'set') {
      if (x >= -1 && y >= -1 && x <= this.N && y <= this.N) this.span(x, y, op.z, op.z + 1, op.id);
    } else if (op.kind === 'box') this.fillBox([x, y, op.z], [x + op.w, y + op.d, op.z + op.h], op.id, op.replace);
    else this.carveSphere([x, y, op.z], op.r, { id: op.id, replace: op.replace });
  }

  // The node's columns in canonical runs (unedited columns as they came; edited ones canonical by construction) and
  // the ground: the base's where a column is unedited, else recomputeGround's capped by the base's.
  encode(): NodeColumns {
    const C = this.S * this.S, counts = new Uint16Array(C);
    let n = this.base.runs.length;
    for (const [c, r] of this.edited) n += r.length - (this.off[c + 1] - this.off[c]) * 3;
    const runs = new Uint16Array(n), ground = new Uint8Array(this.base.ground);
    for (let c = 0, at = 0; c < C; c++) {
      const e = this.edited.get(c);
      if (e) {
        if (e.length / 3 > 0xffff) throw new Error(`EditableNode: column ${c} has ${e.length / 3} runs`);
        runs.set(e, at);
        counts[c] = e.length / 3;
        let top = 0;
        for (let k = 0; k < e.length; k += 3) if (e[k] === top) top += e[k + 1];
        ground[c] = Math.min(top, this.base.ground[c]);
      } else {
        runs.set(this.base.runs.subarray(this.off[c] * 3, this.off[c + 1] * 3), at);
        counts[c] = this.base.counts[c];
      }
      at += counts[c] * 3;
    }
    return { counts, runs, ground };
  }
}
