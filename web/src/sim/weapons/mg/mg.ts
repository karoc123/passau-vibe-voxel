import { trace, type Weapon } from '../weapon';

// far enough for a street and a square; further, a tracer is a dot nobody can aim with
const RANGE = 300;

/** the machine gun: a ray, ten a second, that breaks nothing */
export const mg: Weapon = {
  id: 'mg', slot: 1, name: 'MG', rate: 10,
  fire: (world, from, dir) => trace(world, from, dir, RANGE),
};
