// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): the
// inputs, per seat's role (a driver's CarInput, a pilot's their craft's type's, a walker's WalkPose: contract/pose.ts)
// and the frame's time (FrameTime). Types and constants only (tools/core-deps.mjs R5).

/** a driver's controls (physics/rapier/car.ts RapierCar) */
export interface CarInput { gas: number; brake: number; steer: number; handbrake: boolean }
/** hands off */
export const NO_INPUT: Readonly<CarInput> = { gas: 0, brake: 0, steer: 0, handbrake: false };
/** a car parked: hands off, the handbrake on */
export const PARK: Readonly<CarInput> = { ...NO_INPUT, handbrake: true };

/** the boat's (sim/craft/boat-motion.ts) */
export interface BoatInput {
  throttle: number; // -1..1: forwards, backwards (braking first while still going forwards)
  steer: number; // -1..1: +1 right
  drift: boolean; // the handbrake's key: less grip across, a tighter turn, more drag
}

/** the hovercraft's, the helicopter's, the paraglider's (sim/craft/craft-motion.ts): turn +1: right (the heading falls,
 * as the cars' and the boat's); drive +1: forward; lift +1: climb (helicopter); side +1: sideways to the right
 * (helicopter) */
export interface CraftInput { turn: number; drive: number; lift: number; side: number;
  /** the paraglider's: the point its grappling hook holds, which it is reeled to while this is sent (sim/hook.ts) */
  hook?: { x: number; y: number; z: number } }

/** the FPV drone's sticks (sim/craft/fpv-flight.ts) */
export interface FlightInput {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}
/** the drone's: the sticks, or null: disarmed (it holds still) */
export type DroneInput = FlightInput | null;

/** the floatplane's and the jet's (sim/craft/plane-flight.ts) */
export interface PlaneInput {
  turn: number; // -1..1, +1 right
  pitch: number; // -1..1, +1 nose up
  throttle: number; // 0..1, the lever
}

/** what a pilot sends (seatInput): the input of their craft's type (sim/craft/cores.ts checks it is every core's) */
export type PilotInput = BoatInput | CraftInput | DroneInput | PlaneInput;

/** the frame's time once the sim's update has run (fixed once a frame, every
 * reader the same): dt the frame's (s, at most MAX_DT), tick the ticks run, alpha how far past the last tick
 * what is drawn is (0..1: the traffic, the bodies and the crafts drawn between their last two ticks) */
export interface FrameTime { dt: number; tick: number; alpha: number }

/** the most one update counts for (s): a longer frame (a stall, a tab in the background) runs this much */
export const MAX_DT = 0.1;
