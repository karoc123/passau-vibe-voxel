// Paved ground on a gentle slope as a ramp (1 m tiles). The terrain comes in whole metres, so a street running down a
// slope was a staircase of 1 m steps, a riverside promenade a flight of terraces. Where the ground is paved (RAMP_PAL:
// streets, pavements, squares, their markings) its top faces are drawn with their corners at a smooth height instead,
// and the risers between them go: the mesher (mesher.worker.ts) and everything that stands on the ground (world.ts:
// people, cars, the walking camera) take the height from here, so nothing floats or sinks.
//
// A column is paved ground when its top voxel is the ground's (nothing stands on it: no building, kerb-high wall, car)
// and of a paved material (voxelMaterial.ts pavedGround). A grid point is free where the paved columns of the four
// around it differ by at most a metre and the others are walls, solid to a metre over the highest of them (a building,
// a wall beside a street): it takes the mean of the paved ground around it (within RAMP_R, columns within 1.5 m of
// those), held within a metre of each of them. Every other grid point is pinned: each column keeps its own top there.
// So a step of more than a metre, steps (not paved), lawns, the river's edge and anything standing on the ground keep
// their sharp edges, and along such an edge a ramp comes down (or up) to its voxel's top, where the voxel's own side
// faces meet it. Along a wall the ramp goes on; where it falls below its voxel's top, the mesher closes the gap under
// the wall's face (mesher.worker.ts emitRamps).
//
// A bridge's deck is paved ground too: a column whose top run is of a paved material over the ground's top
// (scripts/voxelize.py builds the deck as a slab over the river or the road, in whole metres, so a deck rising or
// falling along its way had 1 m steps across the carriageway; at its ends it comes down onto the ground, a paved run
// on it). Its top is the column's ground as far as the ramps go (RampField.ground, the tile's own in
// RampField.under): it ramps as a street does, and the points where it meets the street at its ends are free as any.
// (Kerbs are the ground's own top voxel, steps are not paved: neither is a deck.)
//
// The mean's window shrinks towards the tile's border, to the four columns at a point on it: the 1-cell apron is all a
// tile sees of its neighbour, so both tiles must find the same height at the points they share.
import { PAL_GROUND } from './chamfer';
import type { Box } from './sections';

export const RAMP_R = 3;
// heights in 1/64 m (as roofs.ts and vattr.y's top 6 bits); PINNED: the point is pinned
export const PINNED = -1;

export interface RampField {
  S: number; // columns a side, apron included (N + 2)
  ground: Uint8Array; // per column, metres: the top of the ground (tile-data.ts), a deck's top where it is one
  under: Uint8Array; // per column, metres: the tile's ground (under a deck: the ground below it)
  paved: Uint8Array; // per column (S x S): paved ground (see above)
  h: Int32Array; // per grid point ((S + 1)^2, point (X, Y) the corner before column (X, Y)): height in 1/64 m or PINNED
  any: boolean; // any free point
}

// The field of a 1 m tile's columns (apron included); pal: palette flags (PAL_GROUND); deck: those of a deck's top
// (default: pal)
// covered: the ground under something (a tunnel's floor under its rock, a road under a bridge) counts too where the
// column stands open COVER_CLEAR m over it -- for the car's surface (physics/rapier/terrain.ts) only: a bored tunnel's
// floor rises in 1 m steps, which were risers the car crashed into (the B 85's ramp tunnel at Hacklberg); the drawn
// ramps and the mesher keep the column's top
export const COVER_CLEAR = 3;
// box (apron coordinates): only its columns and the points between them (meshing a part of a node, sections.ts; the
// points within RAMP_R + 1 of its edge come out as if nothing were beyond it)
export function rampField(N: number, counts: Uint16Array, off: Uint32Array, runs: Uint16Array, under: Uint8Array, pal: Uint8Array, deck = pal, covered = false,
  box: Box | null = null): RampField {
  const S = N + 2, V = S + 1, paved = new Uint8Array(S * S), h = new Int32Array(V * V).fill(PINNED);
  let ground = under;
  // (solid: how far each column is solid from the bottom up, in cells)
  const solid = new Int32Array(S * S);
  const bx0 = box ? box.x0 : 0, bx1 = box ? box.x1 : S, by0 = box ? box.y0 : 0, by1 = box ? box.y1 : S;
  for (let Y0 = by0; Y0 < by1; Y0++) for (let c = bx0 + S * Y0, ce = bx1 + S * Y0; c < ce; c++) {
    if (!counts[c]) continue;
    let t = 0;
    for (let k = off[c] * 3, e = (off[c] + counts[c]) * 3; k < e && runs[k] <= t; k += 3) t = Math.max(t, runs[k] + runs[k + 1]);
    solid[c] = t;
    const k = (off[c] + counts[c] - 1) * 3, v = runs[k + 2], top = runs[k] + runs[k + 1];
    if (top === ground[c]) { if (v < pal.length && pal[v] & PAL_GROUND) paved[c] = 1; continue; }
    // (a deck: a paved top run over the ground's top)
    if (top < ground[c] || top > 255 || v >= deck.length || !(deck[v] & PAL_GROUND)) {
      if (!covered || top < ground[c]) continue;
      // (covered ground, no deck over it: the run ending at the ground, the next one's bottom COVER_CLEAR over it)
      let gk = -1;
      for (let k2 = off[c] * 3, e = (off[c] + counts[c]) * 3; k2 < e; k2 += 3) {
        if (runs[k2] + runs[k2 + 1] === ground[c]) gk = k2;
        else if (gk >= 0) { if (runs[k2] < ground[c] + COVER_CLEAR) gk = -1; break; }
      }
      if (gk >= 0 && runs[gk + 2] < pal.length && pal[runs[gk + 2]] & PAL_GROUND) paved[c] = 1;
      continue;
    }
    if (ground === under) ground = Uint8Array.from(under);
    ground[c] = top;
    paved[c] = 1;
  }
  let any = false;
  const four = [0, 1, S, S + 1];
  for (let Y = Math.max(1, by0 + 1); Y < by1; Y++) for (let X = Math.max(1, bx0 + 1); X < bx1; X++) {
    const a = X - 1 + S * (Y - 1);
    let lo = 1e9, hi = -1, sum = 0, n = 0;
    for (const o of four) if (paved[a + o]) { const g = ground[a + o]; lo = Math.min(lo, g); hi = Math.max(hi, g); sum += g; n++; }
    if (!n || hi - lo > 1 || four.some((o) => !paved[a + o] && solid[a + o] < hi + 1)) continue;
    const m = sum / n, rx = Math.min(RAMP_R, X, S - X), ry = Math.min(RAMP_R, Y, S - Y);
    sum = n = 0;
    for (let y = Y - ry; y < Y + ry; y++) for (let x = X - rx, i = x + S * y; x < X + rx; x++, i++) {
      if (!paved[i]) continue;
      const g = ground[i];
      if (Math.abs(g - m) <= 1.5) { sum += g; n++; }
    }
    // (in 1/8 m: an even slope comes out in planes the mesher merges, and a point a hair off its column's top is on it)
    const mean = Math.min(lo + 1, Math.max(hi - 1, sum / n));
    h[X + V * Y] = Math.round(mean * 8) * 8;
    any = true;
  }
  return { S, ground, under, paved, h, any };
}

// the height in 1/64 m of column (cx, cy)'s top (apron coordinates, 0 .. S - 1) at its corner k (0: (0, 0), 1: (1, 0),
// 2: (1, 1), 3: (0, 1))
export function cornerQ(f: RampField, c: number, k: number) {
  const { S } = f, x = (c % S) + (k === 1 || k === 2 ? 1 : 0), y = Math.floor(c / S) + (k >= 2 ? 1 : 0), q = f.h[x + (S + 1) * y];
  return q === PINNED ? f.ground[c] * 64 : q;
}

// is column c's top a ramp (a corner off its voxel's top)?
export function ramped(f: RampField, c: number) {
  if (!f.paved[c]) return false;
  const g = f.ground[c] * 64;
  for (let k = 0; k < 4; k++) if (cornerQ(f, c, k) !== g) return true;
  return false;
}

// the top of paved column c at (fx, fy) within it (0..1), in metres: as its two triangles are drawn (the mesher's
// diagonal: rampDiagonal)
export function rampHeight(f: RampField, c: number, fx: number, fy: number) {
  const q0 = cornerQ(f, c, 0), q1 = cornerQ(f, c, 1), q2 = cornerQ(f, c, 2), q3 = cornerQ(f, c, 3);
  let q;
  if (rampDiagonal02(q0, q1, q2, q3)) q = fx >= fy ? q0 + (q1 - q0) * fx + (q2 - q1) * fy : q0 + (q3 - q0) * fy + (q2 - q3) * fx;
  else q = fx + fy <= 1 ? q0 + (q1 - q0) * fx + (q3 - q0) * fy : q2 + (q3 - q2) * (1 - fx) + (q1 - q2) * (1 - fy);
  return q / 64;
}

// a ramp's quad is split along the diagonal 0-2 (else 1-3): the one whose ends are nearer in height, so a ramp up one
// side bends along its contour
export const rampDiagonal02 = (q0: number, q1: number, q2: number, q3: number) => Math.abs(q0 - q2) <= Math.abs(q1 - q3);
