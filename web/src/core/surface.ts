// The surface of the ground as it is drawn and stood on: a 1 m column's top run whose top face is a quad with four
// corner heights (a "cap") instead of the flat top of its voxel. One field per level-1 node (CapField), read by the
// mesher (mesher.worker.ts), the walkers' World (world.ts), the car's terrain (physics/rapier/terrain.ts) and the
// drone's surface (nav/voxel-collision.ts) through the accessors below -- nobody else reads the corners -- so what is
// drawn is what is stood and driven on. docs/plans/surface-caps.md.
//
// Two sources fill the same field:
// - the node's `caps` section (scripts/caps.py, written by tile_fields.py): capField below, which decodes it and keeps
//   only the records that are live in the columns given (an edit kills a cap by itself, nothing is recomputed);
// - the legacy inference from the voxels (core/caps-legacy.ts rampField: the mesher's ramps of paved ground, the car's
//   own surface), for data without the section. To be deleted once the data has caps everywhere.
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
  // legacy only (ramps.ts' grid of free points, NONE: pinned): which edges between two paved columns are filled
  pin: Int32Array | null;
  any: boolean;
  // from the caps section (else: legacy)
  caps: boolean;
}

export const NONE = -1;

// the switch between the caps section and the legacy inference where a node has caps (default: caps; the viewer's
// ?caps=0, the node tools' CAPS=0 force the legacy path, for measuring the one against the other)
export const CAPS = { use: true };

export function emptyCapField(S: number, under: Uint8Array, caps: boolean): CapField {
  return { S, z: new Uint16Array(S * S * 2), q: new Int32Array(S * S * 8), under, top: under, low: new Int32Array((S + 1) * (S + 1)).fill(NONE), pin: null, any: false, caps };
}

// the slot of column c's cap on the run ending at ztop, -1: none
export function capSlot(f: CapField, c: number, ztop: number): -1 | 0 | 1 {
  if (ztop <= 0) return -1;
  return f.z[2 * c] === ztop ? 0 : f.z[2 * c + 1] === ztop ? 1 : -1;
}

// any cap of column c: its slot (the top one first), -1: none
export const capOf = (f: CapField, c: number): -1 | 0 | 1 => (f.z[2 * c + 1] ? 1 : f.z[2 * c] ? 0 : -1);

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
