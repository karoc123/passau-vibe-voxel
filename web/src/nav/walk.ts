import type { World } from '../core/world';

// On foot (nav.ts: the walk and the third-person pedestrian): what is climbed in a stride (a kerb, a stair) and the
// headroom kept over the soles
export const STEP = 1.05, HEAD = 1.9;

// One stride by m (x, z in metres) from P, the soles at feet: taken if the place ahead (0.3 m beyond, on what is there
// to stand within a step up) has the headroom, and the body (its middle and 0.4 m to each side) clears from a step up
// to the head; else along x alone, else along z alone (sliding along a wall). P moves; whether it did. inMap: not off
// the map's edge (the pedestrian).
export function walkStep(w: World, P: { x: number; z: number }, feet: number, m: { x: number; z: number }, inMap = false) {
  const clear = (x: number, z: number, from: number) => !w.blocked(x, z, Math.max(w.support(x, z, feet + STEP), feet + STEP), from);
  for (const [sx, sz] of [[m.x, m.z], [m.x, 0], [0, m.z]]) {
    if (!sx && !sz) continue;
    const nx = P.x + sx, nz = P.z + sz, ax = nx + Math.sign(sx) * 0.3, az = nz + Math.sign(sz) * 0.3;
    if (inMap && (!w.inside(nx, nz) || !w.inside(ax, az))) continue;
    const sup = w.support(ax, az, feet + STEP);
    if (!w.blocked(ax, az, Math.max(sup, feet + STEP), sup + HEAD) && clear(nx, nz, feet + HEAD)
      && clear(nx + 0.4, nz, feet + HEAD) && clear(nx - 0.4, nz, feet + HEAD) && clear(nx, nz + 0.4, feet + HEAD) && clear(nx, nz - 0.4, feet + HEAD)) {
      P.x = nx; P.z = nz;
      return true;
    }
  }
  return false;
}
