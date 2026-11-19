import { fetchJson } from './util';
import type { VoxelUniforms } from './voxelMaterial';

interface Phase { day: number; sd: number; n: number }
interface Class { species: string; leaf: Phase | null; colour: Phase | null; fall: Phase | null; autumn?: string }
interface Phenology { classes: Record<string, Class>; city: { leaf: number; colour: number; fall: number }; grass: [number, number, number][]; leaf: [number, number, number] }

export const FOLIAGE_CLASSES = 16;

// The classes' dates and colours (phenology.json); which tree each 2 m cell's leaves belong to comes with the tiles
// (scripts/tile_fields.py fols, fields.ts)
export async function loadFoliage(U: VoxelUniforms) {
  const ph = await fetchJson<Phenology>('data/phenology.json');
  for (const [k, c] of Object.entries(ph.classes)) {
    const i = +k;
    if (c.leaf && c.colour && c.fall) U.uFolDate.value[i].set(c.leaf.day, c.colour.day, c.fall.day, (c.leaf.sd + c.colour.sd + c.fall.sd) / 3);
    else U.uFolDate.value[i].set(-1, 0, 0, 0);
    if (c.autumn) U.uFolCol.value[i].set(c.autumn).convertSRGBToLinear();
  }
  ph.grass.forEach((t, m) => U.uGrass.value[m].setRGB(...t));
  U.uLeaf.value.setRGB(...ph.leaf);
  U.uFolOn.value = 1;
  return { city: ph.city };
}
