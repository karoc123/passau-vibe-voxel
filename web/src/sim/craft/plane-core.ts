// The floatplane and the jet as WorldSim steps them (craft-core.ts): their flight (plane-flight.ts PlaneFlight) at its
// own STEP (two a world tick), through their collision (the fuselage's cube, RADIUS, and the wings'; fetched HORIZON s
// ahead). A solid thing met (sim/solids.ts) is met as a wall: in the air a crash.
// Put down in the air (at spot.speed, else RESPAWN_SPEED; the engine at RESPAWN_THROTTLE) or afloat (spot.water: still,
// the engine idle). Its pilot hears what happened (PlaneEvent: crash, respawn, ...). An empty seat: the stick let go,
// the lever back (it glides down, or floats), and crashed it stays down (no one flies it back to a safe point). No
// three.js, no DOM (tools/core-deps.mjs). Drawn between the world's last two ticks: the position on the line, the
// attitude by quaternion (nlerp: it rolls over), heading, path angle and bank (the chase camera's) the shorter way.
import { FixedStep } from '../../core/fixed-step';
import { copy, lerp, lerpAngle, nlerpQuat, quat, quatFromBasis, rotate, set, vec3, type Vec3 } from '../../core/vec';
import type { CraftSpot } from '../contract/commands';
import type { PlaneCoreState, PlaneEvent } from '../contract/crafts';
import type { PlaneInput } from '../contract/inputs';
import type { CraftCore } from './craft-core';
import { collisionWorld, PLANE, PlaneFlight, type PlaneConfig, type PlaneWorld } from './plane-flight';
import type { VoxelCollision } from './voxel-collision';

/** as drawn: where it is, where its nose points and the cockpit's up; its heading, flight-path angle and bank */
export interface PlaneDrawn { p: Vec3; fwd: Vec3; up: Vec3; heading: number; gamma: number; bank: number }
const drawnState = () => ({ p: vec3(), fwd: vec3(), up: vec3(), heading: 0, gamma: 0, bank: 0 });

export class PlaneCore implements CraftCore<PlaneInput, PlaneEvent, PlaneDrawn, PlaneCoreState> {
  readonly flight: PlaneFlight;
  readonly clock: FixedStep;
  readonly reach: { radius: number; horizon: number };
  readonly events: PlaneEvent[];
  private worlds = new WeakMap<VoxelCollision, PlaneWorld>();
  private readonly v = vec3();
  // drawn: where it was at the world tick's start (and how often it had jumped then), now, and between
  private readonly from = { ...drawnState(), jumps: 0 };
  private readonly now = drawnState();
  private readonly out = drawnState();
  private readonly qa = quat();
  private readonly qb = quat();

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
    this.keep();
  }

  keep() {
    const f = this.from;
    this.state(f);
    f.jumps = this.flight.jumps;
  }

  // its drawn state now into o
  private state(o: PlaneDrawn) {
    const f = this.flight;
    f.attitude(o.fwd, o.up);
    copy(o.p, f.p);
    o.heading = f.heading; o.gamma = f.gamma; o.bank = f.bank;
    return o;
  }

  step(input: PlaneInput, dt: number, col: VoxelCollision) {
    if (input === this.neutral && this.flight.state === 'crashed') return false;
    return this.flight.step(input, dt, this.world(col));
  }

  save(): PlaneCoreState {
    const { p, fwd, up, heading, gamma, bank, jumps } = this.from;
    return { flight: this.flight.save(), from: { p: { ...p }, fwd: { ...fwd }, up: { ...up }, heading, gamma, bank, jumps } };
  }

  load(s: PlaneCoreState) {
    this.flight.restore(s.flight);
    const f = this.from, o = s.from;
    copy(f.p, o.p); copy(f.fwd, o.fwd); copy(f.up, o.up);
    f.heading = o.heading; f.gamma = o.gamma; f.bank = o.bank; f.jumps = o.jumps;
  }

  get pose() { const { p, heading } = this.flight; return { x: p.x, y: p.y, z: p.z, h: heading }; }
  get velocity() { return this.flight.velocity(this.v); }
  // (between the tick's start and now; put somewhere at once since: now)
  drawn(alpha: number): PlaneDrawn {
    const a = this.from, b = this.state(this.now), o = this.out;
    const t = this.flight.jumps !== a.jumps ? 1 : Math.min(1, Math.max(0, alpha));
    lerp(o.p, a.p, b.p, t);
    const q = nlerpQuat(this.qa, quatFromBasis(this.qa, a.fwd, a.up), quatFromBasis(this.qb, b.fwd, b.up), t);
    rotate(set(o.fwd, 0, 0, 1), q);
    rotate(set(o.up, 0, 1, 0), q);
    o.heading = lerpAngle(a.heading, b.heading, t);
    o.gamma = a.gamma + (b.gamma - a.gamma) * t;
    o.bank = lerpAngle(a.bank, b.bank, t);
    return o;
  }

  meet(n: { x: number; z: number }, depth: number, col: VoxelCollision) { this.flight.meet(n, depth, this.world(col)); }

  /** back to the last safe pose (T) */
  unstick(col: VoxelCollision) {
    this.flight.respawn(this.world(col));
    this.keep();
    return true;
  }
}
