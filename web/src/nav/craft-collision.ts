import { GLIDER_HEIGHT, HOVER_HEIGHT, type CraftKind, type CraftMotionWorld } from './craft-motion';
import type { Sweep } from './sweep';
import type { VoxelCollision } from './voxel-collision';

export const CRAFT_RADIUS = { hovercraft: 0.53, helicopter: 0.59, paraglider: 0.45 };
export const SPAWN_HEIGHT = { hovercraft: HOVER_HEIGHT, helicopter: 1.1, paraglider: GLIDER_HEIGHT };

// Cubes (CRAFT_RADIUS half-size) over each model (craft-models.ts), rotated with the heading: the hovercraft's skirt,
// cabin and fan ducts; the helicopter's skids and cabin, tail, and the rotor disc's rim (10 m) and middle; the pilot
// and the wing's arc.
const rim = (r: number, y: number) => Array.from({ length: 8 }, (_, i): [number, number, number] =>
  [r * Math.sin(i * Math.PI / 4), y, r * Math.cos(i * Math.PI / 4)]);
const PROBES: Record<CraftKind, readonly [number, number, number][]> = {
  hovercraft: [[0, 0, 0], [-0.77, 0, 2.3], [0.77, 0, 2.3], [-0.77, 0, -2.3], [0.77, 0, -2.3], [-0.77, 0, 0], [0.77, 0, 0],
    [0, 0.75, 0.5], [-0.66, 1.0, -2.3], [0.66, 1.0, -2.3]],
  helicopter: [[0, -0.5, 0.3], [-0.5, -0.5, 1.2], [0.5, -0.5, 1.2], [-0.5, -0.5, -0.7], [0.5, -0.5, -0.7],
    [0, 0.5, 1.5], [0, 0.6, -2.4], [0, 0.7, -4.3], [0, 1.0, -5.75],
    ...rim(4.4, 2.0), ...rim(2.2, 2.0)],
  paraglider: [[0, 0, 0], [0, 0.95, 0], [0, 7.1, 0.15], [-2.7, 6.4, 0.15], [2.7, 6.4, 0.15], [-4.6, 4.6, 0.15], [4.6, 4.6, 0.15]],
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
