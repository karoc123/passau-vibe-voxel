// What a palette entry is, for whatever reads voxels without drawing them (physics, collision, walkers, the mesher's
// palette tables): one flag word per palette id (meta.json palette), from its material and colour (core/materials.ts).
// The rules that differ between readers stay distinct and named (solidForCar, solidForDrone, solidForRay, ...), each
// exactly what its reader tested before, so one table answers them all and a new material is classified in one place.
import { MAT, WALL_MATS, pavedGround, type PaletteEntry } from './materials';

export const SEM = {
  // a body cannot pass it: not grass (the foliage tile's blades), not water
  SOLID: 1 << 0,
  // its top can be ground to stand or drive on: anything but water
  WALKABLE: 1 << 1,
  WATER: 1 << 2,
  LEAF: 1 << 3,
  GRASS: 1 << 4,
  // paved ground: capped on a slope (materials.ts pavedGround; scripts/caps.py's paved ids, tools/tile-roundtrip.mjs)
  PAVED: 1 << 5,
  // a building's wall material (materials.ts WALL_MATS; plain SOLID among them)
  WALL: 1 << 6,
  ROOF: 1 << 7,
  // a tree's trunk and branches
  WOOD: 1 << 8,
  // a room's inside or its windows' (scripts/interiors.py)
  INTERIOR: 1 << 9,
} as const;

export function semanticFlags(p: PaletteEntry) {
  const m = p[3];
  let f = 0;
  if (m !== MAT.GRASS && m !== MAT.WATER) f |= SEM.SOLID;
  if (m !== MAT.WATER) f |= SEM.WALKABLE;
  if (m === MAT.WATER) f |= SEM.WATER;
  if (m === MAT.LEAF) f |= SEM.LEAF;
  if (m === MAT.GRASS) f |= SEM.GRASS;
  if (pavedGround(p)) f |= SEM.PAVED;
  if (WALL_MATS.includes(m)) f |= SEM.WALL;
  if (m === MAT.ROOF) f |= SEM.ROOF;
  if (m === MAT.WOOD) f |= SEM.WOOD;
  if (m === MAT.INTERIOR || m === MAT.INTERIOR_GLASS) f |= SEM.INTERIOR;
  return f;
}

// the flag word per palette id
export const semanticTable = (palette: readonly PaletteEntry[]) => Uint16Array.from(palette, semanticFlags);

// A reader's rule on one flag word
export type Rule = (flags: number) => boolean;

export const RULES = {
  // the car and Rapier's bodies (physics/rapier/terrain.ts): grass and water are not solid
  solidForCar: (f: number) => (f & SEM.SOLID) !== 0,
  // the FPV drone (nav/voxel-collision.ts): the foliage tile's voxels but grass, and the top it settles on (base and
  // foliage) the highest voxel not grass; water is solid to it (the base tile's voxels all are, its sweep tests none)
  solidForDrone: (f: number) => (f & SEM.GRASS) === 0,
  // the walkers' World (world.ts solid, raycast): every voxel
  solidForRay: (_f: number) => true,
  // ... and its topSolid: the highest voxel not a leaf
  standOnForWalker: (f: number) => (f & SEM.LEAF) === 0,
  water: (f: number) => (f & SEM.WATER) !== 0,
  leaf: (f: number) => (f & SEM.LEAF) !== 0,
  paved: (f: number) => (f & SEM.PAVED) !== 0,
  wall: (f: number) => (f & SEM.WALL) !== 0,
  roof: (f: number) => (f & SEM.ROOF) !== 0,
  wood: (f: number) => (f & SEM.WOOD) !== 0,
} satisfies Record<string, Rule>;

// A per-palette-id lookup table: `value` where the rule holds, else 0 (length: the palette's, or `size` if larger:
// ids beyond the palette read 0)
export function paletteMask(table: Uint16Array, rule: Rule, value = 1, size = table.length) {
  const out = new Uint8Array(Math.max(size, table.length));
  for (let i = 0; i < table.length; i++) if (rule(table[i])) out[i] = value;
  return out;
}
