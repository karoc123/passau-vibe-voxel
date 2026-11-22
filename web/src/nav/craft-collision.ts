import { GLIDER_HEIGHT, HOVER_HEIGHT, type CraftKind, type CraftMotionWorld } from './craft-motion';
import type { Sweep } from './sweep';
import type { VoxelCollision } from './voxel-collision';

export const CRAFT_RADIUS = { hovercraft: 0.53, helicopter: 0.59, paraglider: 0.45 };
export const SPAWN_HEIGHT = { hovercraft: HOVER_HEIGHT, helicopter: 0.87, paraglider: GLIDER_HEIGHT };

// Cubes along the skirt, skids and rotor, and the pilot and canopy. Rotate the probes with the heading.
const PROBES: Record<CraftKind, readonly [number, number, number][]> = {
  hovercraft: [[0, 0, 0], [-0.76, 0, 1.4], [0.76, 0, 1.4], [-0.76, 0, -1.4], [0.76, 0, -1.4], [0, 0.65, -1.45]],
  helicopter: [[0, -0.25, 0], [0, 0, 1.4], [0, 0, -1.35], [0, 0.25, -3.2],
    [-1.5, 1.28, 0], [1.5, 1.28, 0], [-2.9, 1.28, 0], [2.9, 1.28, 0],
    [0, 1.28, -1.5], [0, 1.28, 1.5], [0, 1.28, -2.9], [0, 1.28, 2.9]],
  paraglider: [[0, 0, 0], [0, 2.8, 0], [-2.1, 2.55, -0.1], [2.1, 2.55, -0.1]],
};

export function craftWorld(kind: CraftKind, col: VoxelCollision, level: () => number): CraftMotionWorld {
  return {
    surface(x, z) {
      if (x < 0 || z < 0 || x >= col.width || z >= col.depth) return { height: 0, water: false };
      const ground = col.voxelGround(x, z), wet = col.waterColumn(x, z, 0, 0);
      if (ground === null || !wet) return null;
      const water = wet.water >= 0;
      return { height: water ? Math.max(ground, wet.water + Math.max(0, level())) : ground, water };
    },
    landing: (p) => col.sweep(p, { x: 0, y: -0.25, z: 0 }),
    sweep(p, d, h0, h) {
      const c0 = Math.cos(h0), s0 = Math.sin(h0), c = Math.cos(h), s = Math.sin(h);
      let first: Sweep = { hit: null, fraction: 1 };
      for (const [x, y, z] of PROBES[kind]) {
        const dx = x * c0 + z * s0, dz = z * c0 - x * s0;
        const hit = col.sweep({ x: p.x + dx, y: p.y + y, z: p.z + dz },
          { x: d.x + x * c + z * s - dx, y: d.y, z: d.z + z * c - x * s - dz });
        if (hit === 'loading') return hit;
        if (hit.hit && (!first.hit || hit.fraction < first.fraction)) first = hit;
      }
      return first;
    },
  };
}
