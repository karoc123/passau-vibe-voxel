import type { World } from '../core/world';
import { deeper, pushOut, WALKER_HEAD, type Solid } from '../sim/solids';
import type { MoveKeys } from './move-keys';

/** what the walk asks of the voxels: what to stand on under a height, whether a span of a column is solid */
export type Ground = Pick<World, 'support' | 'blocked'>;

// On foot (nav.ts: the walk): what is climbed in a stride (a kerb, a stair) and the
// headroom kept over the soles (the walker's height among the solids too)
export const STEP = 1.05, HEAD = WALKER_HEAD;

/** the keys on foot: W/S forward and back, A/D a step sideways (right +1), the arrows left and right turn (the mouse
 * turns too, but a keyboard alone still can) */
export const footKeys = (K: MoveKeys) => ({ go: K.axis('f', 'b'), side: K.axis('sr', 'sl'), turn: K.axis('tr', 'tl') });

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
  for (const [sx, sz] of [[m.x, m.z], [m.x, 0], [0, m.z]]) {
    if (!sx && !sz) continue;
    const nx = P.x + sx, nz = P.z + sz, ax = nx + Math.sign(sx) * 0.3, az = nz + Math.sign(sz) * 0.3;
    const sup = w.support(ax, az, feet + step);
    if (sup <= top && !w.blocked(ax, az, Math.max(sup, feet + step), sup + HEAD) && bodyClear(w, nx, nz, feet, step) && !deeper(solids, P.x, P.z, nx, nz, feet)) {
      P.x = nx; P.z = nz;
      return true;
    }
  }
  return false;
}

function bodyClear(w: Ground, x: number, z: number, feet: number, step = STEP) {
  const clear = (x: number, z: number) => !w.blocked(x, z, Math.max(w.support(x, z, feet + step), feet + step), feet + HEAD);
  return clear(x, z) && clear(x + 0.4, z) && clear(x - 0.4, z) && clear(x, z + 0.4) && clear(x, z - 0.4);
}

/** a frame of the walk: P first pushed out of what solid moved into it (a car driven into the walker shoves it; never
 * into a wall), then the stride m taken; whether the stride was */
export function walkFrame(w: Ground, P: { x: number; z: number }, feet: number, m: { x: number; z: number } | null, solids: readonly Solid[], step = STEP, top = Infinity) {
  if (solids.length) pushOut(solids, P, feet, (x, z) => bodyClear(w, x, z, feet, step));
  return !!m && walkStep(w, P, feet, m, solids, step, top);
}
