// The floatplane and the jet as WorldSim steps them (craft-core.ts): their flight (plane-flight.ts PlaneFlight) at its
// own STEP, at most MAX_STEPS a frame, through their collision (the fuselage's cube, RADIUS; fetched HORIZON s ahead).
// Put down in the air (at spot.speed, else RESPAWN_SPEED; the engine at RESPAWN_THROTTLE) or afloat (spot.water: still,
// the engine idle). Its pilot hears what happened (PlaneEvent: crash, respawn, ...). An empty seat: the stick let go,
// the lever back (it glides down, or floats), and crashed it stays down (no one flies it back to a safe point). No
// three.js, no DOM (tools/core-deps.mjs).
import { FixedStep } from '../../core/fixed-step';
import { vec3, type Vec3 } from '../../core/vec';
import type { CraftCore, CraftSpot } from './craft-core';
import { collisionWorld, PLANE, PlaneFlight, type PlaneConfig, type PlaneEvent, type PlaneInput, type PlaneWorld } from './plane-flight';
import type { VoxelCollision } from './voxel-collision';

export interface PlaneDrawn { p: Vec3; fwd: Vec3; up: Vec3 }

export class PlaneCore implements CraftCore<PlaneInput, PlaneEvent, PlaneDrawn> {
  readonly flight: PlaneFlight;
  readonly clock: FixedStep;
  readonly reach: { radius: number; horizon: number };
  readonly events: PlaneEvent[];
  private worlds = new WeakMap<VoxelCollision, PlaneWorld>();
  private readonly v = vec3();
  private readonly fwd = vec3();
  private readonly up = vec3();

  constructor(readonly cfg: PlaneConfig = PLANE) {
    this.flight = new PlaneFlight(cfg);
    this.clock = new FixedStep(cfg.STEP, cfg.MAX_STEPS);
    this.reach = { radius: cfg.RADIUS, horizon: cfg.HORIZON };
    this.events = this.flight.events;
  }

  /** an empty seat: the stick let go, the lever back */
  readonly neutral: PlaneInput = Object.freeze({ turn: 0, pitch: 0, throttle: 0 });

  /** the plane's view of the collision (its sweep, the surface, the water) */
  world(col: VoxelCollision) {
    let w = this.worlds.get(col);
    if (!w) this.worlds.set(col, w = collisionWorld(col, col.height));
    return w;
  }

  reset(spot: CraftSpot) {
    const f = this.flight, water = !!spot.water;
    f.reset({ x: spot.x, y: spot.y ?? 0, z: spot.z, heading: spot.h, speed: spot.speed, water });
    f.engine = water ? 0 : this.cfg.RESPAWN_THROTTLE;
    f.events.length = 0;
  }

  step(input: PlaneInput, dt: number, col: VoxelCollision) {
    if (input === this.neutral && this.flight.state === 'crashed') return false;
    return this.flight.step(input, dt, this.world(col));
  }

  get pose() { const { p, heading } = this.flight; return { x: p.x, y: p.y, z: p.z, h: heading }; }
  get velocity() { return this.flight.velocity(this.v); }
  // (as drawn at the last step: where it is, where its nose points and the cockpit's up)
  drawn(_alpha: number): PlaneDrawn {
    this.flight.attitude(this.fwd, this.up);
    return { p: this.flight.p, fwd: this.fwd, up: this.up };
  }

  /** back to the last safe pose (T) */
  unstick(col: VoxelCollision) {
    this.flight.respawn(this.world(col));
    return true;
  }
}
