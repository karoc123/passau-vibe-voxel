import type { PhysicsWorld } from '../physics/body';
import type { Pose } from '../sim/types';
import type { RoadContact } from './arcade-car';
import type { VoxelCollision } from './voxel-collision';

// What the driven car (arcade-car.ts) meets in the voxels, shared by the drive prototype (drive.prototype.ts) and the
// headless physics scenarios (physics/scenarios.ts), so both run the very same contact.

export const STEP = 1 / 90; // s: the drive's fixed step
const FOOTPRINT = [-1, 0, 1];

// The road under a car at pose p: its centre's surface, blocked if any of the 3 x 3 points over its footprint is
// (a wall, a step over a metre up). No wall at a drop: the car drives off it and flies (arcade-car.ts).
export function carGround(tiles: Pick<VoxelCollision, 'roadSurface'>, p: Pose, length: number, bus: boolean): RoadContact {
  const clearance = bus ? 2.55 : 1.48;
  const center = tiles.roadSurface(p.x, p.z, p.y, clearance);
  if (!center || center.blocked || center.water) return center;
  const from = Math.max(p.y, center.height), sx = Math.sin(p.h), sz = Math.cos(p.h);
  const half = length / 2 - 0.17;
  for (const f of FOOTPRINT) for (const r of FOOTPRINT) {
    if (f === 0 && r === 0) continue;
    const x = p.x + f * sx * half + r * sz * 0.86;
    const z = p.z + f * sz * half - r * sx * 0.86;
    const sample = tiles.roadSurface(x, z, from, clearance);
    if (!sample) return null;
    if (sample.blocked) return { height: center.height, blocked: true };
  }
  return center;
}

// The voxels as a body in the air sees them (physics/body.ts): no foliage, water no wall, what it overlaps no hold
export function airWorld(tiles: Pick<VoxelCollision, 'sweep' | 'support'>): PhysicsWorld {
  return {
    cast(center, half, move, above) {
      const s = tiles.sweep(center, move, { half, above, foliage: false, water: false, escape: true });
      return s === 'loading' ? s : s.hit ? { fraction: s.fraction, axis: s.axis } : null;
    },
    ground: (x, z, top) => tiles.support(x, z, top),
  };
}
