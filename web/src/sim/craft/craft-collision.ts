import { CRAFT_SCALE, GLIDER_HEIGHT, HOVER_HEIGHT, type CraftKind, type CraftMotionWorld } from './craft-motion';
import { waterTop } from '../river';
import type { Sweep } from './sweep';
import type { VoxelCollision } from './voxel-collision';

// (the helicopter's measures below are its model's before its CRAFT_SCALE, and scaled by it)
const S = CRAFT_SCALE;
export const CRAFT_RADIUS = { hovercraft: 0.8, helicopter: 0.59 * S.helicopter, paraglider: 0.45 };
export const SPAWN_HEIGHT = { hovercraft: HOVER_HEIGHT, helicopter: 1.1 * S.helicopter, paraglider: GLIDER_HEIGHT };

// Cubes (CRAFT_RADIUS half-size) over each model, rotated with the heading. The hovercraft's skirt: rows close enough
// that no metre of wall slips between two cubes, and a middle column for what it is lowered onto; its cabin and its
// fan ducts higher up. The helicopter's skids and cabin, tail, and the rotor disc's rim (10 m before the scale) and
// middle. The pilot and the wing's arc.
const rim = (r: number, y: number) => Array.from({ length: 8 }, (_, i): [number, number, number] =>
  [r * Math.sin(i * Math.PI / 4), y, r * Math.cos(i * Math.PI / 4)]);
const scaled = (k: number, ps: [number, number, number][]) => ps.map(([x, y, z]): [number, number, number] => [x * k, y * k, z * k]);
const SKIRT_ROWS = [-5.6, -3.73, -1.87, 0, 1.87, 3.73, 5.6];
const PROBES: Record<CraftKind, readonly [number, number, number][]> = {
  hovercraft: [...SKIRT_ROWS.flatMap((z): [number, number, number][] => [[-2, 0, z], [2, 0, z]]),
    [0, 0, -5.6], [0, 0, -2.8], [0, 0, 0], [0, 0, 2.8], [0, 0, 5.6],
    [0, 1.5, 3], [-1.3, 1.5, 0.6], [1.3, 1.5, 0.6], [0, 1.5, -1.8], [-1.4, 2.3, -5.1], [1.4, 2.3, -5.1]],
  helicopter: scaled(S.helicopter, [[0, -0.5, 0.3], [-0.5, -0.5, 1.2], [0.5, -0.5, 1.2], [-0.5, -0.5, -0.7], [0.5, -0.5, -0.7],
    [0, 0.5, 1.5], [0, 0.6, -2.4], [0, 0.7, -4.3], [0, 1.0, -5.75],
    ...rim(4.4, 2.0), ...rim(2.2, 2.0)]),
  paraglider: [[0, 0, 0], [0, 0.95, 0], [0, 7.1, 0.15], [-2.7, 6.4, 0.15], [2.7, 6.4, 0.15], [-4.6, 4.6, 0.15], [4.6, 4.6, 0.15]],
};

// (the probes' size given, not the collision's: a stand's finder reads through one collision for every kind)
export function craftWorld(kind: CraftKind, col: VoxelCollision): CraftMotionWorld {
  const R = CRAFT_RADIUS[kind];
  return {
    surface(x, z) {
      if (x < 0 || z < 0 || x >= col.width || z >= col.depth) return { height: 0, water: false };
      const ground = col.voxelGround(x, z), wet = waterTop(col, x, z);
      if (ground === null || wet === null) return null;
      const water = wet >= 0;
      return { height: water ? Math.max(ground, wet) : ground, water };
    },
    landing: (p) => col.sweep(p, { x: 0, y: -0.25, z: 0 }, R),
    sweep(p, d, h0, h) {
      const c0 = Math.cos(h0), s0 = Math.sin(h0), c = Math.cos(h), s = Math.sin(h);
      let first: Sweep = { hit: null, fraction: 1 };
      for (const [x, y, z] of PROBES[kind]) {
        const dx = x * c0 + z * s0, dz = z * c0 - x * s0;
        const hit = col.sweep({ x: p.x + dx, y: p.y + y, z: p.z + dz },
          { x: d.x + x * c + z * s - dx, y: d.y, z: d.z + z * c - x * s - dz }, R);
        if (hit === 'loading') return hit;
        if (hit.hit && (!first.hit || hit.fraction < first.fraction)) first = hit;
      }
      return first;
    },
  };
}
