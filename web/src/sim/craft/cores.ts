// The player crafts WorldSim makes (sim/world-sim.ts addCraft), by type: each core (craft-core.ts) made with its part
// of the world's tuning (sim/tuning.ts). No three.js, no DOM (tools/core-deps.mjs).
import type { Tuning } from '../tuning';
import { BoatCore } from './boat-motion';
import { SpecialCore } from './special-core';
import { DroneCore } from './drone-core';
import { PlaneCore } from './plane-core';

export const CORES = {
  boat: (t: Tuning) => new BoatCore(t.boat),
  hovercraft: (t: Tuning) => new SpecialCore('hovercraft', t.craft),
  helicopter: (t: Tuning) => new SpecialCore('helicopter', t.craft),
  paraglider: (t: Tuning) => new SpecialCore('paraglider', t.craft),
  // (the drone has no tuning of its own yet: fpv-flight.ts's constants)
  drone: (_t: Tuning) => new DroneCore(),
  floatplane: (t: Tuning) => new PlaneCore(t.plane),
  jet: (t: Tuning) => new PlaneCore(t.jet),
};

export type CraftType = keyof typeof CORES;
/** the core of a craft of type K */
export type CoreOf<K extends CraftType> = ReturnType<(typeof CORES)[K]>;
