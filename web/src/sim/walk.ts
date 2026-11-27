import { MAX_LEG } from '../chamfer';
import type { World } from '../core/world';
import { bodyClear, carried, deeper, headroom, pushOut, roofUnder, WALKER_HEAD, WALKER_STEP, type Solid } from './solids';
import { EYE } from './weapons/weapon';

/** what the walk asks of the voxels: what to stand on under a height, whether a span of a column is solid */
export type Ground = Pick<World, 'support' | 'blocked'>;

// On foot: what is climbed in a stride (a kerb, a stair) and the
// headroom kept over the soles (the walker's height among the solids too)
export const STEP = WALKER_STEP, HEAD = WALKER_HEAD;

/** the stride (x, z) of dist m facing yaw: forward and right (-1..1 each; both at once no further than one) */
export function stride(yaw: number, forward: number, right: number, dist: number) {
  const l = Math.max(1, Math.hypot(forward, right)), f = forward / l * dist, r = right / l * dist, s = Math.sin(yaw), c = Math.cos(yaw);
  return { x: s * f - c * r, z: c * f + s * r };
}

// One stride by m (x, z in metres) from P, the soles at feet: taken if the place ahead (0.3 m beyond, on what is there
// to stand within step up: higher than a kerb out of the water) has the headroom, the body (its middle and 0.4 m to
// each side) clears from a step up to the head, and it goes no further into a solid thing; else along x alone, else
// along z alone (sliding along a wall or a car). P moves; whether it did. Ground higher than top (m) is not climbed
// (the terrain's top is otherwise stood on however high: on land a bank is walked up, out of the water only a low one)
export function walkStep(w: Ground, P: { x: number; z: number }, feet: number, m: { x: number; z: number }, solids: readonly Solid[] = [], step = STEP, top = Infinity) {
  let here: number | undefined;
  for (const [sx, sz] of [[m.x, m.z], [m.x, 0], [0, m.z]]) {
    if (!sx && !sz) continue;
    const nx = P.x + sx, nz = P.z + sz, ax = nx + Math.sign(sx) * 0.3, az = nz + Math.sign(sz) * 0.3;
    const sup = w.support(ax, az, feet + step);
    if (sup <= top && !w.blocked(ax, az, Math.max(sup, feet + step), sup + HEAD) && bodyClear(w, nx, nz, feet, step) && !deeper(solids, P.x, P.z, nx, nz, Math.max(feet, sup))) {
      // (eyes already nearer a wall than EYE_R: put there, or shoved by a car; they may go along it or away)
      const room = eyeRoom(w, nx, nz, feet + EYE);
      if (room < EYE_R && room < (here ??= eyeRoom(w, P.x, P.z, feet + EYE)) - 1e-6) continue;
      P.x = nx; P.z = nz;
      return true;
    }
  }
  return false;
}

// The eyes keep EYE_R in plan from the walls drawn at their height (EYE_H either side: the near plane's own half
// height). Nearer, the camera's near plane (nav.ts WALK_NEAR, its corners ~0.33 m out at the walk's field of view)
// cut into the wall, and through the cut the street behind it showed. The body's probes keep 0.4 m along x and z only,
// so the eyes went right up to a corner; and the wall drawn is more than its voxels: a diagonal wall's staircase is
// filled out to its slanted face (chamfer.ts), up to a metre in front of the steps the probes stop at. Its steps are
// found as chamfer.ts finds them, any solid taken for a wall (kept a little further off a few corners it leaves).
const EYE_R = 0.4, EYE_H = 0.15;
const SIDES = [[1, 1], [-1, 1], [1, -1], [-1, -1]];

/** m in plan (at most EYE_R) from eyes at (x, y, z) to the nearest wall drawn round them */
export function eyeRoom(w: Ground, x: number, z: number, y: number) {
  let room = EYE_R;
  for (let k = Math.floor(y - EYE_H); k < y + EYE_H && room > 0; k++) room = Math.min(room, layerRoom(w, x, z, k));
  return room;
}

function layerRoom(w: Ground, x: number, z: number, k: number) {
  const cx = Math.floor(x), cz = Math.floor(z), memo = new Map<number, boolean>();
  const solid = (X: number, Z: number) => {
    const key = (X - cx) * 1024 + Z - cz;
    let s = memo.get(key);
    if (s === undefined) memo.set(key, s = w.blocked(X, Z, k, k + 1));
    return s;
  };
  // (a step's slanted face reaches at most a cell out from the solid it stands for)
  let near = false;
  for (let dz = -2; dz <= 2 && !near; dz++) for (let dx = -2; dx <= 2 && !near; dx++) near = solid(cx + dx, cz + dz);
  if (!near) return EYE_R;
  let room = EYE_R;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!solid(cx + dx, cz + dz)) continue;
    room = Math.min(room, Math.hypot(Math.max(cx + dx - x, 0, x - cx - dx - 1), Math.max(cz + dz - z, 0, z - cz - dz - 1)));
  }
  // the steps whose triangles come within a cell: those along a row (the long leg along x) next to the eyes' cell,
  // and those along a column
  const L = MAX_LEG + 1;
  for (let j = -L; j <= L && room > 0; j++) for (let i = -1; i <= 1; i++) {
    room = Math.min(room, stepRoom(solid, cx + j, cz + i, x, z), stepRoom(solid, cx + i, cz + j, x, z));
  }
  return room;
}

// m from (x, z) to the slanted faces' triangles filling the inner corners of empty cell (X, Z) (chamfer.ts
// chamferWalls: two solid neighbours at right angles and the one between them, legs to the outer corners, one 1 m)
function stepRoom(solid: (X: number, Z: number) => boolean, X: number, Z: number, x: number, z: number) {
  let room = EYE_R;
  if (solid(X, Z)) return room;
  for (const [sx, sz] of SIDES) {
    if (!solid(X + sx, Z) || !solid(X, Z + sz) || !solid(X + sx, Z + sz)) continue;
    const a = leg(solid, X, Z, -sx, 0, 0, sz), b = a && leg(solid, X, Z, 0, -sz, sx, 0);
    if (!b || Math.min(a, b) !== 1 || Math.max(a, b) > MAX_LEG) continue;
    const px = X + (sx > 0 ? 1 : 0), pz = Z + (sz > 0 ? 1 : 0);
    room = Math.min(room, triRoom(x, z, px, pz, px - a * sx, pz, px, pz - b * sz));
  }
  return room;
}

// from empty cell (X, Z) along (ux, uz), the solid side at (ox, oz): cells to the outer corner, 0 if the street side
// is blocked first or it is further than MAX_LEG
function leg(solid: (X: number, Z: number) => boolean, X: number, Z: number, ux: number, uz: number, ox: number, oz: number) {
  for (let k = 0; k <= MAX_LEG; k++) {
    const ex = X + ux * k, ez = Z + uz * k;
    if (solid(ex, ez)) return 0;
    if (!solid(ex + ox, ez + oz)) return k;
  }
  return 0;
}

// distance from (x, z) to triangle p q r (0 inside)
function triRoom(x: number, z: number, px: number, pz: number, qx: number, qz: number, rx: number, rz: number) {
  const s1 = (qx - px) * (z - pz) - (qz - pz) * (x - px), s2 = (rx - qx) * (z - qz) - (rz - qz) * (x - qx), s3 = (px - rx) * (z - rz) - (pz - rz) * (x - rx);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return 0;
  return Math.min(segRoom(x, z, px, pz, qx, qz), segRoom(x, z, qx, qz, rx, rz), segRoom(x, z, rx, rz, px, pz));
}

function segRoom(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

/** the voxels with the roofs of solids to stand on (a car's is a step up from a jump) */
export function withRoofs(w: Ground, solids: readonly Solid[]): Ground {
  if (!solids.length) return w;
  return {
    support: (x, z, top) => { const r = roofUnder(solids, x, z, top), s = w.support(x, z, top); return r ? Math.max(s, r.y + r.top) : s; },
    blocked: (x, z, y0, y1) => w.blocked(x, z, y0, y1),
  };
}

/** a frame of the walk: P first pushed out of what solid moved into it (a car driven into the walker shoves it; never
 * into a wall), then the stride m taken, the roofs of solids stood on as ground; whether the stride was */
export function walkFrame(w: Ground, P: { x: number; z: number }, feet: number, m: { x: number; z: number } | null, solids: readonly Solid[], step = STEP, top = Infinity) {
  const g = withRoofs(w, solids);
  // (on a roof or stepping up onto it: not pushed off what it stands on)
  const on = roofUnder(solids, P.x, P.z, feet + step), f = on ? Math.max(feet, on.y + on.top) : feet;
  if (solids.length) pushOut(solids, P, f, (x, z) => bodyClear(g, x, z, feet, step));
  return !!m && walkStep(g, P, feet, m, solids, step, top);
}

/** P on the roof of a as it was last frame, carried with it to where solids have it now (moved, turned) unless a wall
 * is in the way (a bridge's deck sweeps it off); the move (x, z, dy, dh), or null: not carried */
export function ride(w: Ground, P: { x: number; z: number }, feet: number, a: Solid, solids: readonly Solid[]) {
  const b = a.id === undefined ? undefined : solids.find((s) => s.id === a.id);
  if (!b) return null;
  const to = carried(a, b, P);
  return headroom(w, to.x, to.z, feet + to.dy) ? to : null;
}
