import type { World } from '../core/world';
import { EYE } from './weapons/weapon';
import type { Ground } from './walk';

/** water deeper than this (m) is swum, shallower waded */
export const SWIM_DEPTH = 1.2;
/** m the soles hang under the water's top afloat: the eyes 0.3 m over it */
export const FLOAT = EYE - 0.3;
/** how far up a bank or a step (m over the water) a swimmer climbs out: a low quay's edge, not a high one */
export const CLIMB_OUT = 1.05;
// The data's water is one voxel over the soil everywhere (scripts/voxelize.py lays each body flat at its level and
// knows no bed): read as it is, every river would be a puddle to wade. So the walk makes a bed up, shelving from a low
// bank (one to climb out onto, SHELVE m deeper per m out) to DEEP; a fountain's basin stays shallow, a river is swum a
// step from its bank, and along a quay's wall it is deep.
const SHELVE = 0.8, DEEP = 4, EDGE = Math.ceil(DEEP / SHELVE);

/** the voxels as the walk feels them with water in: its surface no floor, the walker in it down to the made-up bed */
export class Wet implements Ground {
  private depths = new Map<number, number>();
  private of: World | null = null;

  constructor(private readonly world: () => (Ground & Partial<Pick<World, 'waterColumn'>>) | null) {}

  /** the water's top in the column at (x, z), null: none (or not loaded) */
  surface(x: number, z: number) {
    const c = this.world()?.waterColumn?.(x, z);
    return c && c.water >= 0 ? c.water : null;
  }

  // m from the water's top (water) down to the bed in the column at (x, z); a column not loaded counts as a low bank
  private depth(x: number, z: number, water: number) {
    const ix = Math.floor(x), iz = Math.floor(z), k = ix + iz * 65536, w = this.world() as World;
    if (w !== this.of || this.depths.size > 50000) { this.depths.clear(); this.of = w; }
    let d = this.depths.get(k);
    if (d === undefined) {
      let near = EDGE;
      for (let dz = -EDGE; dz <= EDGE; dz++) for (let dx = -EDGE; dx <= EDGE; dx++) {
        const r = Math.hypot(dx, dz) - 0.5, X = ix + dx + 0.5, Z = iz + dz + 0.5;
        if (r < near && this.surface(X, Z) === null && w.support(X, Z, water + CLIMB_OUT) <= water + CLIMB_OUT) near = r;
      }
      d = Math.min(DEEP, Math.max(0.3, near * SHELVE));
      this.depths.set(k, d);
    }
    return d;
  }

  support(x: number, z: number, top: number) {
    const w = this.world();
    if (!w) return 0;
    const s = w.support(x, z, top), water = this.surface(x, z);
    // (a deck or a boat's landing over the water stays a floor)
    return water === null || s > water + 0.01 ? s : water - this.depth(x, z, water);
  }

  blocked(x: number, z: number, z0: number, z1: number) {
    const w = this.world();
    if (!w) return false;
    const water = this.surface(x, z);
    return w.blocked(x, z, water === null ? z0 : Math.max(z0, water), z1);
  }
}
