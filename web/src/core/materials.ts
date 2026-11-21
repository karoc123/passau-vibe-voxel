// The palette's materials (meta.json palette: [r, g, b, material id] per entry), three.js-free: the material ids and
// the ground's paved classes by colour. voxelMaterial.ts re-exports them for the shaders; core/semantics.ts derives the
// per-entry flags the physics, collision and walkers read.

// a palette entry: colour and material id
export type PaletteEntry = [number, number, number, number];

// material ids, as in scripts/voxelize.py
export const MAT = { SOLID: 0, WALL: 1, GLASS: 2, LEAF: 3, WATER: 4, LAMP: 5, METAL: 6, FLOODLIT: 7, GRASS: 8, MARK: 9, SOIL: 10, CAR: 11,
  ROOF: 12, CONCRETE: 13, CLOCK: 14, BRONZE: 15, SIGN: 16, JET: 17, SIGNBAND: 18, RIBBON: 19, CLASSIC: 20, WINDOW: 21, TENEMENT: 22, WOOD: 23,
  // a room's inside and the inside of its windows (scripts/interiors.py M_INTERIOR, M_INTERIOR_GLASS): indoors, see voxelMaterial.ts SURFACE
  INTERIOR: 24, INTERIOR_GLASS: 25 } as const;

// The ground's paved surfaces, detailed close up in the fragment shader (groundDetail): their palette entries by the
// colours scripts/voxelize.py gives them (C: quantised to 4, as its Palette does), plain SOLID. The class rides in the
// palette texture's alpha over the material id (bits 5-7; material ids stay under 32: `& 31` wherever it is read).
export const GROUND = { SETT: 1, SLAB: 2, ASPHALT: 3, ROADSETT: 4, GRAVEL: 5, CONCRETE: 6 } as const;
const GROUND_COLOURS: [string, number][] = [
  ['#8f8981', GROUND.SETT], // sett, cobblestone: the old town's lanes and squares
  ['#a49f97', GROUND.ROADSETT], // a carriageway paved in stone
  ['#c6c2b8', GROUND.SLAB], ['#b5b4af', GROUND.SLAB], ['#b7b1a6', GROUND.SLAB], // paving (also the default), platforms
  ['#5f636b', GROUND.ASPHALT], ['#6e7178', GROUND.ASPHALT], ['#6a6d73', GROUND.ASPHALT], ['#8a5a52', GROUND.ASPHALT], // roads, car parks, cycle lanes
  ['#d8ccb5', GROUND.GRAVEL], ['#8a8178', GROUND.GRAVEL], // gravel paths, the railway's ballast
  ['#bdbab2', GROUND.CONCRETE],
];
// a palette entry of colour hex (as voxelize.py's Palette quantises it: to 4, Python's round, halves to even)
const isColour = (p: PaletteEntry, hex: string) => [1, 3, 5].every((i, k) => {
  const v = parseInt(hex.slice(i, i + 2), 16) / 4, f = Math.floor(v);
  return Math.min(255, (v - f > 0.5 || (v - f === 0.5 && f % 2) ? f + 1 : f) * 4) === p[k];
});
export function groundClass(p: PaletteEntry) {
  if (p[3] !== MAT.SOLID) return 0;
  for (const [hex, c] of GROUND_COLOURS) if (isColour(p, hex)) return c;
  return 0;
}

// Paved ground, capped on a slope (scripts/caps.py: the same ids, tools/tile-roundtrip.mjs): what is walked and driven on -- the paved classes above (not the
// railway's ballast), kerbs (level with the street in the voxels) and the markings on them. Not steps (#a8a296), the
// quays' and retaining walls' stone, lawns (their grass is the foliage tile's) or earth.
const BALLAST = '#8a8178', KERB = '#cfc7b8';
export const pavedGround = (p: PaletteEntry) =>
  p[3] === MAT.MARK || (p[3] === MAT.SOLID && (isColour(p, KERB) || (groundClass(p) > 0 && !isColour(p, BALLAST))));

// the materials of buildings' walls (voxelize.py)
export const WALL_MATS: readonly number[] = [MAT.SOLID, MAT.WALL, MAT.GLASS, MAT.FLOODLIT, MAT.CONCRETE, MAT.BRONZE, MAT.RIBBON, MAT.CLASSIC, MAT.WINDOW, MAT.TENEMENT];
