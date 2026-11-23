// A player craft's core, the one contract WorldSim steps (sim/world-sim.ts crafts; docs/adr/0008-server-vision.md:
// every player-controlled thing on the world clock, sim side). Each craft keeps its own fixed step (FixedStep: its step
// size, its most steps a frame), run by WorldSim.update; its motion law stays in its own module (boat-motion.ts,
// craft-motion.ts, fpv-flight.ts, plane-flight.ts), the core wraps it. No three.js, no DOM (tools/core-deps.mjs).
//   reset(spot)               put down at spot, standing still (or at spot.speed)
//   step(input, dt, world)    one fixed step of dt s through the craft's collision; false: not taken (a tile not in) or
//                             held (ended, disarmed): the rest of the frame's time is dropped
//   pose                      where it is now (x, y, z, heading h: 0 +z, pi/2 +x)
//   drawn(alpha)              its pose as drawn, alpha (0..1) of the way past the last step (the shells draw the last
//                             step as before: alpha is there for a drawing between the last two)
// The shells (nav/boat.ts, ...) keep the panel, the camera, the model and the input mapping; they read the core.
import type { FixedStep } from '../../core/fixed-step';
import type { Vec3 } from '../../core/vec';
import type { Pose } from '../types';
import type { CollisionOptions, VoxelCollision } from './voxel-collision';

/** where a craft is put down: x, z, heading h, a height for one that starts in the air or afloat, a speed along h for
 * one that starts moving, water: afloat (the floatplane) */
export interface CraftSpot { x: number; y?: number; z: number; h: number; speed?: number; water?: boolean }

export interface CraftCore<I = unknown, E = unknown, D = unknown> {
  /** its fixed step (step size, most steps a frame, longest frame), run by WorldSim.update */
  readonly clock: FixedStep;
  /** its collision's cube and look-ahead (VoxelCollision, made by WorldSim) */
  readonly reach: CollisionOptions;
  /** the input of hands off the controls: an empty seat, a pilot out of focus */
  readonly neutral: I;
  /** what happened since they were last read (WorldSim.craftEvents, by its pilot) */
  readonly events: E[];
  reset(spot: CraftSpot): void;
  step(input: I, dt: number, world: VoxelCollision): boolean;
  readonly pose: Pose;
  /** m/s, where its collision fetches ahead */
  readonly velocity: Vec3;
  drawn(alpha: number): D;
  /** back to a safe spot nearby (T); false: not now */
  unstick?(world: VoxelCollision): boolean;
}
