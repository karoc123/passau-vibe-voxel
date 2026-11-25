// The surface of the ground as it is drawn and stood on: a 1 m column's top run whose top face is a quad with four
// corner heights (a "cap") instead of the flat top of its voxel. One field per level-1 node (CapField), read by the
// mesher (mesher.worker.ts), the walkers' World (world.ts), the car's terrain (physics/rapier/terrain.ts) and the
// drone's surface (sim/craft/voxel-collision.ts) through the accessors below -- nobody else reads the corners -- so what is
// drawn is what is stood and driven on. docs/adr/0005-surface-caps.md.
//
// The node's `caps` section (scripts/caps.py, written by tile_fields.py) fills it: capField below decodes it and keeps
// only the records that are live in the columns given (an edit kills a cap by itself, nothing is recomputed). A node
// without the section (levels 2, 4, 8; a level-1 node with no sloped ground), or a column without a live record, is
// plain voxels for every reader: drawn, walked, driven and flown on as its voxels' tops (docs/adr/0005-surface-caps.md).
// Per column at most two caps: slot 0 on the run ending at the ground (a street, a road under a bridge), slot 1 on the
// column's last run above the ground (a bridge's deck). Heights in 1/64 of a cell (m at level 1) above the volume's
// floor, as QuadBuffer.vertexQ carries them: drawn and collided numbers are the same integers.

export interface CapField {
  S: number; // columns a side, apron included (N + 2)
  // per column 2 slots: the cap's run top (cells; 0: no cap in that slot)
  z: Uint16Array;
  // per column 2 slots x 4 corners (0: (x, y), 1: (x + 1, y), 2: (x + 1, y + 1), 3: (x, y + 1)), 1/64 cell
  q: Int32Array;
  // per column: the node's ground (grnd)
  under: Uint8Array;
  // per column: the top of its highest cap (a deck's top where it has one), else the ground
  top: Uint8Array;
  // per grid point ((S + 1)^2; point (X, Y) the corner before column (X, Y)): the lowest corner of a cap there that is
  // off its run's top, else NONE (how far a wall's or a trunk's face goes down to meet the surface beside it)
  low: Int32Array;
  any: boolean;
}

export const NONE = -1;

const emptyCapField = (S: number, under: Uint8Array): CapField =>
  ({ S, z: new Uint16Array(S * S * 2), q: new Int32Array(S * S * 8), under, top: under, low: new Int32Array((S + 1) * (S + 1)).fill(NONE), any: false });

// the slot of column c's cap on the run ending at ztop, -1: none
export function capSlot(f: CapField, c: number, ztop: number): -1 | 0 | 1 {
  if (ztop <= 0) return -1;
  return f.z[2 * c] === ztop ? 0 : f.z[2 * c + 1] === ztop ? 1 : -1;
}

// corner k of column c's cap in slot (1/64 cell)
export const cornerQ = (f: CapField, c: number, slot: number, k: number) => f.q[8 * c + 4 * slot + k];

// is the cap in slot off its run's flat top (a corner not at ztop)?
export function capRamped(f: CapField, c: number, slot: number) {
  const g = f.z[2 * c + slot] * 64, o = 8 * c + 4 * slot;
  return f.z[2 * c + slot] > 0 && (f.q[o] !== g || f.q[o + 1] !== g || f.q[o + 2] !== g || f.q[o + 3] !== g);
}

// a cap's quad is split along the diagonal 0-2 (else 1-3): the one whose ends are nearer in height, so a slope up one
// side bends along its contour
export const diagonal02 = (q0: number, q1: number, q2: number, q3: number) => Math.abs(q0 - q2) <= Math.abs(q1 - q3);

// the height (cells) at (fx, fy) (0..1) in a quad of corners q0..q3 (1/64 cell), as its two triangles are drawn
export function quadHeight(q0: number, q1: number, q2: number, q3: number, fx: number, fy: number) {
  let q;
  if (diagonal02(q0, q1, q2, q3)) q = fx >= fy ? q0 + (q1 - q0) * fx + (q2 - q1) * fy : q0 + (q3 - q0) * fy + (q2 - q3) * fx;
  else q = fx + fy <= 1 ? q0 + (q1 - q0) * fx + (q3 - q0) * fy : q2 + (q3 - q2) * (1 - fx) + (q1 - q2) * (1 - fy);
  return q / 64;
}

// THE surface: column c's run ending at ztop, at (fx, fy) within the column, in cells: its cap as drawn, else ztop
export function surfaceAt(f: CapField | null, c: number, ztop: number, fx: number, fy: number) {
  const s = f ? capSlot(f, c, ztop) : -1;
  if (s < 0) return ztop;
  const o = 8 * c + 4 * s;
  return quadHeight(f!.q[o], f!.q[o + 1], f!.q[o + 2], f!.q[o + 3], fx, fy);
}

// the corners (of column c and of its neighbour across the edge) on column c's edge facing along axis d (0 x, 1 y),
// dir: [c's corner at the edge's first end, at its second, the neighbour's at the first, at the second] -- the ends as
// edgePoints (mesher.worker.ts) orders them
export function edgeCorners(d: number, dir: number): [number, number, number, number] {
  if (d === 0) return dir < 0 ? [0, 3, 1, 2] : [1, 2, 0, 3];
  return dir < 0 ? [0, 1, 3, 2] : [3, 2, 0, 1];
}

// ---- the caps section (scripts/caps.py writes it; core/tile-sections.ts): uint16[6 * n], planar -- per record the
// column (apron included, as cnts counts them) less the previous record's, the zigzag of its run top less the previous
// record's, and the zigzag of each corner less ztop * 64. Sorted by column, then ztop.
const unzig = (u: number) => (u >>> 1) ^ -(u & 1);

// the section's bytes (as uint16) from records [column, ztop, q0, q1, q2, q3] (q absolute; scripts/caps.py encode)
export function encodeCaps(recs: number[][]): Uint16Array {
  const r = [...recs].sort((a, b) => a[0] - b[0] || a[1] - b[1]), n = r.length, out = new Uint16Array(6 * n);
  const zz = (v: number) => ((v << 1) ^ (v >> 15)) & 0xffff;
  r.forEach((x, i) => {
    out[i] = x[0] - (i ? r[i - 1][0] : 0);
    out[n + i] = zz(x[1] - (i ? r[i - 1][1] : 0));
    for (let k = 0; k < 4; k++) out[(2 + k) * n + i] = zz(x[2 + k] - x[1] * 64);
  });
  return out;
}

// the section's records as they are: [column, ztop, q0, q1, q2, q3] per record (q absolute, 1/64 cell)
export function decodeCaps(caps: Uint16Array): Int32Array {
  const n = Math.floor(caps.length / 6), out = new Int32Array(n * 6);
  let c = 0, z = 0;
  for (let i = 0; i < n; i++) {
    c += caps[i];
    z += unzig(caps[n + i]);
    out[6 * i] = c; out[6 * i + 1] = z;
    for (let k = 0; k < 4; k++) out[6 * i + 2 + k] = z * 64 + unzig(caps[(2 + k) * n + i]);
  }
  return out;
}

// The field of a level-1 node's caps section over its columns (as they are now: the file's, or edited), null: no caps
// section. A record is kept only where it is live in these columns (the edit rule, docs/adr/0005-surface-caps.md): a
// run ends exactly at its ztop, no run starts there (the cell above is air) and the column is solid from the cell its
// lowest corner is in up to ztop. Slot 0 if ztop is the column's ground, else 1 (a deck: the column's last run); a
// record that breaks the writer's rules (a column past the node, a slot taken twice) is ignored.
export function capField(N: number, cols: { counts: Uint16Array; runs: Uint16Array; ground: Uint8Array; caps?: Uint16Array | null }, off?: Uint32Array): CapField | null {
  if (!cols.caps) return null;
  const S = N + 2, SS = S * S, V = S + 1, { counts, runs, ground } = cols;
  if (!off) { off = new Uint32Array(SS + 1); for (let i = 0; i < SS; i++) off[i + 1] = off[i] + counts[i]; }
  const f = emptyCapField(S, ground), recs = decodeCaps(cols.caps);
  let top: Uint8Array | null = null;
  for (let r = 0; r < recs.length; r += 6) {
    const c = recs[r], z = recs[r + 1];
    if (c < 0 || c >= SS || z <= 0) continue;
    const q0 = recs[r + 2], q1 = recs[r + 3], q2 = recs[r + 4], q3 = recs[r + 5], lo = Math.floor(Math.min(q0, q1, q2, q3) / 64);
    // (the run ending at z, with nothing on it; solid down to lo through touching runs)
    let k = -1;
    for (let j = off[c], e = off[c] + counts[c]; j < e; j++) {
      const z0 = runs[3 * j], z1 = z0 + runs[3 * j + 1];
      if (z1 === z) { k = j; if (j + 1 < e && runs[3 * (j + 1)] === z) k = -1; break; }
      if (z0 >= z) break;
    }
    if (k < 0) continue;
    let bot = runs[3 * k];
    for (let j = k - 1; j >= off[c] && bot > lo && runs[3 * j] + runs[3 * j + 1] === bot; j--) bot = runs[3 * j];
    if (bot > lo) continue;
    const sl = z === ground[c] ? 0 : 1;
    if (f.z[2 * c + sl]) continue;
    f.z[2 * c + sl] = z;
    const o = 8 * c + 4 * sl;
    f.q[o] = q0; f.q[o + 1] = q1; f.q[o + 2] = q2; f.q[o + 3] = q3;
    f.any = true;
    if (sl === 1) { top ??= Uint8Array.from(ground); top[c] = Math.min(255, z); }
    // (the lowest corner at each grid point)
    const X = c % S, Y = (c - X) / S;
    for (let kk = 0; kk < 4; kk++) {
      const p = X + (kk === 1 || kk === 2 ? 1 : 0) + V * (Y + (kk >= 2 ? 1 : 0)), q = f.q[o + kk];
      if (f.low[p] === NONE || q < f.low[p]) f.low[p] = q;
    }
  }
  if (top) f.top = top;
  return f;
}
