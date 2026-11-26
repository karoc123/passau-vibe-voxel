// The player crafts WorldSim makes (sim/world-sim.ts addCraft), by type: each core (craft-core.ts) made with its part
// of the world's tuning (sim/tuning.ts). No three.js, no DOM (tools/core-deps.mjs).
import type { Tuning } from '../tuning';
import type { CraftEvents, CraftStates } from '../contract/crafts';
import type { CraftType } from '../contract/ids';
import type { PilotInput } from '../contract/inputs';
import type { CraftCore } from './craft-core';
import { BoatCore } from './boat-motion';
import { SpecialCore } from './special-core';
import { DroneCore } from './drone-core';
import { PlaneCore } from './plane-core';

export const CORES = {
  boat: (t: Tuning) => new BoatCore(t.boat),
  hovercraft: (t: Tuning) => new SpecialCore('hovercraft', t.craft),
  helicopter: (t: Tuning) => new SpecialCore('helicopter', t.craft),
  paraglider: (t: Tuning) => new SpecialCore('paraglider', t.craft),
  drone: (t: Tuning) => new DroneCore(t.drone),
  floatplane: (t: Tuning) => new PlaneCore(t.plane),
  jet: (t: Tuning) => new PlaneCore(t.jet),
} satisfies Record<CraftType, (t: Tuning) => CraftCore>;

/** the core of a craft of type K */
export type CoreOf<K extends CraftType> = ReturnType<(typeof CORES)[K]>;

// the contract's PilotInput (contract/inputs.ts) is the cores' inputs, all of them and no other
type InputOf<C> = C extends CraftCore<infer I> ? I : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type PilotInputIsTheCores = Assert<Same<PilotInput, InputOf<CoreOf<CraftType>>>>;
// the contract's craft events and wire states (contract/crafts.ts) are the cores', type by type
type EventOf<C> = C extends CraftCore<unknown, infer E> ? E : never;
type StateOf<C> = C extends CraftCore<unknown, unknown, unknown, infer S> ? S : never;
export type CraftEventsAreTheCores = Assert<Same<CraftEvents, { [K in CraftType]: EventOf<CoreOf<K>> }>>;
export type CraftStatesAreTheCores = Assert<Same<CraftStates, { [K in CraftType]: StateOf<CoreOf<K>> }>>;
