// The player crafts WorldSim makes (sim/world-sim.ts addCraft), by type: each core (craft-core.ts) made with its part
// of the world's tuning (sim/tuning.ts). No three.js, no DOM (tools/core-deps.mjs).
import type { Tuning } from '../tuning';
import { BoatCore } from './boat-motion';

export const CORES = {
  boat: (t: Tuning) => new BoatCore(t.boat),
};

export type CraftType = keyof typeof CORES;
/** the core of a craft of type K */
export type CoreOf<K extends CraftType> = ReturnType<(typeof CORES)[K]>;
