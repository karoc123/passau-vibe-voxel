// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): what a
// player craft tells its pilot (its core's events, per craft type: a SimEvent 'craft' carries one) and its core's
// state as a snapshot carries it (save(), load(): sim/craft/craft-core.ts; sim/craft/core-state.ts checks it is
// complete). Each core declares these; sim/craft/cores.ts asserts they are the cores', type by type. Types only
// (tools/core-deps.mjs R5).
import type { Quat, Vec3 } from '../../core/vec';
import type { CraftType } from './ids';

/** what a craft's cube swept through the voxels meets (sim/craft/sweep.ts, VoxelCollision.sweep) */
export type ImpactKind = 'terrain' | 'structure' | 'foliage' | 'city edge' | 'ceiling' | 'vehicle';

// ---------------------------------------------------------------- events

/** the boat's (sim/craft/boat-motion.ts): it met the bank or a wall at speed */
export type BoatEvent = { kind: 'bump'; speed: number };
/** the hovercraft's, the helicopters', the paraglider's (sim/craft/special-core.ts): landed on foot or on the water */
export type SpecialEvent = 'landed' | 'splash';
/** the drone's (sim/craft/drone-core.ts): a hit at speed (m/s into what it met) */
export interface DroneEvent { kind: 'impact'; hit: ImpactKind; speed: number }
/** the floatplane's, the jet's and the combat plane's (sim/craft/plane-flight.ts) */
export type PlaneEvent =
  | { type: 'skim' | 'touchdown' | 'takeoff' | 'bump' }
  | { type: 'crash'; what: string; kmh: number }
  | { type: 'respawn'; throttle: number };

/** a craft's events by its type */
export interface CraftEvents {
  boat: BoatEvent;
  hovercraft: SpecialEvent;
  helicopter: SpecialEvent;
  paraglider: SpecialEvent;
  drone: DroneEvent;
  floatplane: PlaneEvent;
  jet: PlaneEvent;
  fighter: PlaneEvent;
  gunship: SpecialEvent;
}

/** an event of a craft of type K (one of them): its type and its core's event (SimEvent 'craft') */
export type CraftEventOf<K extends CraftType = CraftType> = { [T in K]: { craft: T; e: CraftEvents[T] } }[K];

// ---------------------------------------------------------------- state

/** a vehicle's power as it crosses (sim/tank.ts Tank): its fuel level in steps of a full tank (only with a tank: whole
 * steps, so it changes seldom) and dead once a wreck cut it (absent otherwise) */
export interface PowerState { fuel?: number; dead?: true }

/** what the motion's last step did (sim/craft/craft-motion.ts) */
export type CraftStep = 'moving' | 'blocked' | 'loading' | 'landed' | 'splash';
/** where the plane is (sim/craft/plane-flight.ts) */
export type PlaneState = 'air' | 'water' | 'crashed';

/** the boat's motion (sim/craft/boat-motion.ts BoatMotion): position (y: the waterline), heading, m/s on the water,
 * rad/s, the hull's pitch and roll, its clock (the bobbing), a column under it not loaded */
export interface BoatMotionState {
  x: number; z: number; y: number; h: number;
  vx: number; vz: number; yaw: number;
  pitch: number; roll: number; t: number;
  waiting: boolean;
}
/** the boat's core: its motion and the hull as drawn at the world tick's start */
export interface BoatCoreState extends PowerState {
  motion: BoatMotionState;
  from: { x: number; y: number; z: number; h: number; pitch: number; roll: number };
}

/** the motion of a hovercraft, a helicopter, a paraglider (sim/craft/craft-motion.ts CraftMotion) */
export interface CraftMotionState {
  p: Vec3; velocity: Vec3;
  heading: number; yaw: number; bank: number; pitch: number;
  grounded: boolean;
  throttle: number;
}
/** their core (sim/craft/special-core.ts): the motion, what its last step did, as drawn at the world tick's start */
export interface SpecialCoreState extends PowerState {
  motion: CraftMotionState;
  result: CraftStep;
  from: { x: number; y: number; z: number; h: number; pitch: number; bank: number };
}

/** the drone's flight (sim/craft/fpv-flight.ts FpvFlight) */
export interface FpvFlightState { position: Vec3; attitude: Quat; velocity: Vec3 }
/** the drone's core (sim/craft/drone-core.ts): its flight, the last step waited for a tile, as drawn at the tick's start */
export interface DroneCoreState extends PowerState {
  flight: FpvFlightState;
  waiting: boolean;
  from: { position: Vec3; attitude: Quat };
}

/** the plane's flight (sim/craft/plane-flight.ts PlaneFlight): its pose and attitude (fw, lu: the aerobatic law's path
 * and lift directions), rates, airspeed, engine, state, what its panel shows, its clock, how often it jumped; crashed:
 * the time left till it is put back and its clock at the crash (a page running it ahead counts the same down) */
export interface PlaneFlightState {
  p: Vec3;
  heading: number; gamma: number; bank: number;
  pitchRate: number; roll: number; aoa: number;
  v: number; engine: number;
  state: PlaneState;
  load: number; stalled: boolean; atEdge: boolean; waiting: boolean;
  t: number; jumps: number;
  fw: Vec3; lu: Vec3;
  crashLeft: number; crashAt: number;
}
/** the floatplane's, the jet's and the combat plane's core (sim/craft/plane-core.ts): the flight, as drawn at the world tick's start */
export interface PlaneCoreState extends PowerState {
  flight: PlaneFlightState;
  from: { p: Vec3; fwd: Vec3; up: Vec3; heading: number; gamma: number; bank: number; jumps: number };
}

/** a craft's core state on the wire, by its type */
export interface CraftStates {
  boat: BoatCoreState;
  hovercraft: SpecialCoreState;
  helicopter: SpecialCoreState;
  paraglider: SpecialCoreState;
  drone: DroneCoreState;
  floatplane: PlaneCoreState;
  jet: PlaneCoreState;
  fighter: PlaneCoreState;
  gunship: SpecialCoreState;
}
