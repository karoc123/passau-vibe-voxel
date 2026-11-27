// The traffic's cars near player edits as real Rapier bodies (README "Driving": the body rules).
//
// Part of the world sim (sim/traffic.ts): no three.js, no DOM, no camera (tools/core-deps.mjs); stepped in the
// traffic's fixed tick (TrafficBodies.tick, SUB physics steps a tick), its colliders built a fixed number of chunks a
// tick, so a tick's cost stays bounded.
//
// The traffic stays what it is (IDM, lanes, signals, junction boxes, all kinematic). A car within NEAR m of an edited
// box (at most MAX_BODIES, nearest the edits first) also gets a body: the player's car's chassis and raycast wheels
// (vehicle.ts) driven by a lean AI controller that chases the car's simulated place on its path (its "ghost": pure
// pursuit for the steering, the gap along the path for the throttle). The car is drawn where its body is.
//   - Look-ahead: a shape cast a body a tick, lifted LOOK_UP and tilted to the path's grade; the body brakes for what
//     stands across its way (a placed block, a wreck, a body). While it is held up so, its ghost waits for it (the
//     car's speed is the body's): the cars behind queue as for any car.
//   - Losing the ghost (more than LOST_* from it, rolled over, in the water): within RESYNC_R of an edit the car is a
//     wreck (the world's doing: fallen into a dug hole, crashed into a block): out of the traffic (Traffic.detachCar:
//     parked, blocking the cars behind), its body left to come to rest, then kept as a fixed collider while near an
//     edit. Further from the edits (a junction tighter than a car can steer, the voxels on a path, a push from behind:
//     not the player's doing) its body goes and it is drawn back onto its ghost, blended over FADE_* (no pop), no body
//     for COOL_S.
//   - Leaving NEAR * HYST: the body goes, the drawn pose blends back to the ghost's.
// Without edits or drivers the tick can return without stepping Rapier.
// The world's colliders: terrain.ts (the player car's streaming), REACH m round every body; live edits
// (core/live-edits.ts) rebuild the chunks they touch.
import RAPIER from '@dimforge/rapier3d-compat';
import { wrapAngle } from '../../core/num';
import { axisAngle, quat, quatMul, rotate, vec3, type Vec3 } from '../../core/vec';
import { liveEdits } from '../../core/live-edits';
import { pt } from '../../sim/path';
import { fallen, STEP as TICK, type CarPose, type Traffic, type TrafficBodies, type WallBox } from '../../sim/traffic';
import { EditBoxes } from '../../sim/edit-boxes';
import type { BodyDraw, BodyPose } from '../../sim/contract/agents';
import { bodyPoseAt, drawnBodyPose } from '../../sim/body-pose';
import type { Car } from '../../sim/types';
import { carShape, WALKER_HEAD, WALKER_R } from '../../sim/solids';
import type { RoadPose } from '../../sim/contract/pose';
import type { Meta } from '../../core/meta';
import { CAR_GROUPS, CAR_ONLY_GROUPS, CHUNK, RapierTerrain, WORLD_GROUPS, chunkShapes, type TerrainOptions } from './terrain';
import { createVehicle, createWheels, REST, RIDE, WHEEL_R, warmUp, type CarBuild, type RideTuning } from './vehicle';
import { buildOf, VEHICLES } from '../../sim/vehicles';
import type { VehicleId } from '../../sim/contract/ids';
import { RapierCar, type CarEvent } from './car';
import { type CarInput, NO_INPUT, PARK } from '../../sim/contract/inputs';
import { PlayerCar, type Hit } from './player-car';
import { SINK_MS, type DriverSnapshot } from '../../sim/contract/snapshot';
// (for the node tools, which load each module graph apart: the world's edits of this one, whose colliders hear them)
export { liveEdits };
export * as worldEdits from '../../core/world-edits';

export const SUB = 2; // physics steps a traffic tick
export const STEP = TICK / SUB;
export const NEAR = 60; // m: a car this close to an edited box gets a body
const HYST = 1.15; // ... and keeps it until NEAR * HYST
export const MAX_BODIES = 60;
const REACH = 24; // m: the colliders round a body
const NEED_NOW = 12; // m: a car whose colliders this close are not built yet waits for its body
export const CHUNKS_PER_TICK = 3; // colliders built a tick (a chunk: ~0.4 ms)
const LOST_LAT = 3, LOST_ALONG = 10, LOST_Y = 2.5; // m off the ghost: lost
const LOST_UP = 0.5; // its up's y under this: rolled over, lost
const RESYNC_R = 12; // m: lost further than this from an edit: put back on its ghost (else a wreck)
const COOL_S = 8, COOL_NEAR_S = 1; // ... and no body for this long (within 2 RESYNC_R of an edit: COOL_NEAR_S)
const FADE_MIN = 0.6, FADE_MAX = 2, FADE_V = 4; // s, s, m/s: a body's drawn pose blended back to its ghost's
const WRECK_REST_S = 1.2, WRECK_MAX_S = 15;
// m/s: the most a driven car closes on a player on foot (a walk's pace: it nudges them along)
const PUSH = 1.5;
const DRIVE_RADIUS = 40, KNOCK = 4, HIT_SPEED = 2.5;
const AI_STEER = 0.65; // the front wheels' most angle for the AI controller (the player's: 0.55, less at speed)
const LOOK_UP = 0.7; // m: look() sees what stands this much over a body's bottom (not a kerb or a step)

export interface LifePhysOptions {
  near: number; maxBodies: number; chunksPerTick: number;
  look: boolean; // (tools: the look-ahead off)
}
export const DEFAULTS: LifePhysOptions = { near: NEAR, maxBodies: MAX_BODIES, chunksPerTick: CHUNKS_PER_TICK, look: true };

// a pose in physics coordinates (the body's origin, its rotation) and the ground under it along its up (ride)
interface P7 { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; ride: number; lean?: number; wheelie?: number }
interface Body {
  car: Car;
  body: RAPIER.RigidBody;
  chassis: RAPIER.Collider;
  ctl: RAPIER.DynamicRayCastVehicleController | null; // (none at rest)
  build: CarBuild;
  state: 'track' | 'wreck' | 'rest' | 'player' | 'park' | 'path';
  drive?: RapierCar;
  driver?: PlayerCar;
  age: number; still: number;
  prev: P7; cur: P7;
  // the tracking error now (m): across, along the path (> 0: behind its ghost); its speed forward; held up (look)
  lat: number; along: number; vb: number; held: boolean;
  water: boolean;
}
interface CoachBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  from: WallBox;
  to: WallBox;
}
interface Fade { dx: number; dy: number; dz: number; dh: number; t: number; dur: number }
interface Cmd { want: number; vb: number; ang: number; stopped: boolean }

export interface LifePhysStats {
  bodies: number; tracking: number; wrecks: number; resting: number; held: number;
  spawned: number; released: number; lost: number; resynced: number; notReady: number;
  tickMs: number; stepMs: number; terrainMs: number; // (wall clock: cost only, never decisions)
  releasePop: number; // the largest blend a release started (m)
}
export type LogKind = 'spawn' | 'release' | 'lost' | 'rest' | 'resync';

/** the road physics' origin on a map of W x D m: the chunk at its middle (no point of it farther than half its
 * diagonal: f32 keeps 0.5 mm there on a 9 km map) */
export const mapOrigin = (meta: { W: number; D: number }) =>
  ({ x: Math.floor(meta.W / 2 / CHUNK) * CHUNK, z: Math.floor(meta.D / 2 / CHUNK) * CHUNK });

export class LifePhysics implements TrafficBodies {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly origin: { x: number; z: number };
  readonly opts: LifePhysOptions;
  readonly bodies = new Map<number, Body>();
  private readonly players = new Map<string, PlayerCar>();
  private readonly drivers = new Map<number, PlayerCar>();
  private readonly inputs = new Map<string, CarInput>();
  private readonly fades = new Map<Car, Fade>();
  private readonly byCollider = new Map<number, Body>();
  private readonly coachBodies = new Map<string, CoachBody>();
  private readonly coachColliders = new Set<number>();
  private readonly cool = new Map<Car, number>();
  private edits = new EditBoxes();
  t = 0;
  readonly stats: LifePhysStats = { bodies: 0, tracking: 0, wrecks: 0, resting: 0, held: 0, spawned: 0, released: 0, lost: 0, resynced: 0, notReady: 0,
    tickMs: 0, stepMs: 0, terrainMs: 0, releasePop: 0 };
  // what happened to whom (tools)
  readonly log: { t: number; kind: LogKind; id: number; why?: string; at?: [number, number, number] }[] = [];
  private readonly A = pt();
  private readonly B = pt();
  private readonly pose0: CarPose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };

  // Rapier initialised (load()). The physics' origin (f32 precision) is the map's middle (mapOrigin), whoever looks
  // where; terrain: where the tiles come from (a cache or a load); rideTuning: the cars' ride (read-only, Tuning.ride:
  // sim/tuning.ts)
  constructor(meta: { W: number; D: number; tiles: { N: number }; palette: Meta['palette'] }, opts: Partial<LifePhysOptions> = {}, terrain: TerrainOptions = {},
    readonly rideTuning: RideTuning = RIDE) {
    this.opts = { ...DEFAULTS, ...opts };
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.origin = mapOrigin(meta);
    this.terrain = new RapierTerrain(RAPIER, this.world, meta, this.origin, { reach: REACH, needNow: NEED_NOW, budgetChunks: this.opts.chunksPerTick, ...terrain });
  }

  static async load(meta: Meta, opts: Partial<LifePhysOptions> = {}, terrain: TerrainOptions = {}, rideTuning: RideTuning = RIDE) {
    await RAPIER.init();
    warmUp();
    return new LifePhysics(meta, opts, terrain, rideTuning);
  }

  owns(c: Car) { const b = this.bodies.get(c.id); return !!b && b.state !== 'path'; }
  controlled(c: Car) { return this.drivers.has(c.id); }

  async warmTerrain(focus: { x: number; z: number }) {
    const tile = await this.terrain.prefetch(focus.x, focus.z);
    if (tile) chunkShapes(tile, this.terrain.N, Math.floor(focus.x / CHUNK), Math.floor(focus.z / CHUNK));
  }

  // The drivers' seats (the world sim's seat table decides who may take one: sim/world-sim.ts): these apply at once,
  // between ticks (WorldSim applies its commands at the start of an update); the car is controlled from the next tick.

  /** player takes the wheel of car entityId (as type choice); false: no such car in T, or another driver has it */
  takeWheel(T: Traffic, player: string, entityId: number, choiceId?: VehicleId) {
    if (this.players.has(player) || this.drivers.has(entityId)) return false;
    const c = T.roadVehicles().find((c) => c.id === entityId);
    if (!c) return false;
    // (the next tick's time: when the driver's clocks start)
    const now = (T.tickNumber + 1) * TICK * 1000;
    const body = this.bodies.get(c.id);
    const pose = body && body.state !== 'path' ? this.poseAt(body, 1) : c.detachedPose ?? this.pathPose(c, T);
    const driver = new PlayerCar(c, pose, now);
    if (!T.detachCar(c, pose)) return false;
    this.drivers.set(c.id, driver);
    this.players.set(player, driver);
    const choice = choiceId && VEHICLES[choiceId];
    const same = !choice || choice.id === (c.vt ?? (c.bus ? 'bus' : 'car'));
    if (!same && choice) {
      c.vt = choice.id === 'car' || choice.id === 'bus' ? undefined : choice.id;
      c.bus = choice.id === 'bus';
      c.len = choice.len;
      if (choice.paint) c.col = choice.paint;
    }
    this.fades.delete(c);
    if (body && (body.state === 'path' || !same)) this.remove(body);
    else if (body) this.control(body, driver);
    return true;
  }

  input(player: string, input: CarInput) {
    this.inputs.set(player, { ...input });
  }

  /** the player's car parks where it is (back on the road first if sunk or fallen) */
  releaseWheel(player: string) {
    const driver = this.players.get(player);
    if (!driver) return;
    const body = this.bodies.get(driver.car.id);
    if (driver.sinkUntil || driver.fallUntil || body?.drive?.status === 'water') this.recover(driver);
    else if (body) {
      body.state = 'park';
      body.driver = undefined;
      body.age = body.still = 0;
    }
    driver.car.brake = 1;
    driver.car.v = 0;
    this.players.delete(player);
    this.drivers.delete(driver.car.id);
    this.inputs.delete(player);
  }

  /** the player's car back on the road */
  resetDriver(player: string) {
    const driver = this.players.get(player);
    if (driver) this.recover(driver);
  }

  driverSnapshot(player: string): DriverSnapshot | null {
    const driver = this.players.get(player);
    if (!driver) return null;
    const car = this.bodies.get(driver.car.id)?.drive;
    const now = this.tickNumber * TICK * 1000;
    return {
      tick: this.tickNumber, entityId: driver.car.id, pose: { ...driver.car.detachedPose! }, kmh: car?.kmh ?? 0,
      waiting: driver.waiting, status: car?.status ?? 'ok',
      onWheels: !!car && car.wheelsInContact() >= 3 && upright(car, 0.9),
      sinkMs: Math.max(0, driver.sinkUntil - now),
      crashMs: Math.max(0, driver.crashUntil - now),
      fallMs: Math.max(0, driver.fallUntil - now),
      ...(car && !driver.waiting ? { body: car.save(this.origin) } : {}),
    };
  }

  driverNotes(player: string) { return this.players.get(player)?.notes.splice(0) ?? []; }

  private tickNumber = 0;
  get lastTick() { return this.tickNumber; }

  beforeTick(T: Traffic) {
    this.tickNumber = T.tickNumber;
    const now = T.tickNumber * TICK * 1000;
    for (const player of this.inputs.keys()) if (!this.players.has(player)) this.inputs.delete(player);
    for (const [player, driver] of this.players) {
      if (driver.recoveryDue(now)) this.recover(driver);
      driver.input = this.inputs.get(player) ?? NO_INPUT;
    }
  }

  private recover(driver: PlayerCar) {
    const c = driver.car, body = this.bodies.get(c.id);
    if (body) this.remove(body);
    c.detachedPose = driver.recoveryPose();
    c.v = 0;
    driver.waiting = true;
  }

  private pathPose(c: Car, T: Traffic): RoadPose {
    return { ...T.carPose(c, c.s, c.off, this.pose0), roll: 0 };
  }

  private control(body: Body, driver: PlayerCar) {
    body.state = 'player';
    body.driver = driver;
    if (!body.ctl) {
      body.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      body.ctl = createWheels(this.world, body.body, body.build, this.rideTuning);
    }
    body.drive ??= new RapierCar(RAPIER, this.world, body.body.translation(), body.body.rotation(), this.terrain,
      undefined, body.build, { body: body.body, chassis: body.chassis, controller: body.ctl! }, this.rideTuning);
    body.chassis.setCollisionGroups(CAR_GROUPS);
    body.chassis.setFriction(0);
    body.chassis.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    body.chassis.setRestitution(0);
    body.chassis.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
    body.drive.ride = body.cur.ride;
  }

  // m from world (x, z) to the nearest edited box (0 inside one) where that is at most max; else more than max
  editDist(x: number, z: number, max: number) { return this.edits.dist(x, z, max); }

  // One traffic tick (after the cars and trains moved)
  tick(dt: number, T: Traffic) {
    this.edits = T.editBoxes;
    const st = this.stats;
    if (!this.edits.length && !this.drivers.size && !this.bodies.size && !this.coachBodies.size &&
        !this.fades.size && !this.terrain.stats.chunks) {
      st.tickMs = st.stepMs = st.terrainMs = 0;
      return;
    }
    const f0 = performance.now(), o = this.opts;
    this.t += dt;
    const active = [...this.drivers.values()].map((driver) => driver.car.detachedPose!);
    const driveDist = (x: number, z: number) => active.reduce((d, p) => Math.min(d, Math.hypot(x - p.x, z - p.z)), Infinity);
    const near: { c: Car; d: number }[] = [];
    const paths = new Map<Car, RoadPose>();
    for (const c of T.cars) {
      const b = this.bodies.get(c.id), d = this.editDist(c.geo.cx, c.geo.cy, o.near * HYST);
      if (o.near > 0 && d < (b?.state === 'track' ? o.near * HYST : o.near) && (this.cool.get(c) ?? -1) <= this.t) {
        near.push({ c, d });
      }
      if (active.length && driveDist(c.geo.cx, c.geo.cy) < DRIVE_RADIUS) paths.set(c, this.pathPose(c, T));
    }
    for (const c of T.detachedCars) {
      const p = c.detachedPose!;
      if (!this.drivers.has(c.id) && driveDist(p.x, p.z) < DRIVE_RADIUS) paths.set(c, p);
    }
    near.sort((a, b) => a.d - b.d || a.c.id - b.c.id);
    const want = new Set(near.slice(0, o.maxBodies).map((n) => n.c));
    const moving = new Set(T.cars), parked = new Set(T.detachedCars);
    for (const b of this.bodies.values()) {
      const c = b.car;
      if (b.state === 'player') continue;
      if (b.state === 'track') {
        if (!moving.has(c)) this.remove(b);
        else if (!want.has(c)) this.release(b, T);
      } else if (b.state === 'path') {
        if (!paths.has(c) || want.has(c)) this.remove(b);
      } else if (!parked.has(c) || (b.state === 'rest' && !paths.has(c) && this.editDist(c.detachedPose!.x, c.detachedPose!.z, o.near * HYST) > o.near * HYST)) {
        this.remove(b);
      }
    }
    for (const [c, until] of this.cool) if (until <= this.t) this.cool.delete(c);

    const pts: { x: number; z: number; vx?: number; vz?: number }[] = [];
    const requests: ((ready: boolean) => void)[] = [];
    const requestBody = (b: Body) => {
      const p = b.body.translation(), v = b.body.linvel();
      pts.push({ x: p.x + this.origin.x, z: p.z + this.origin.z, vx: v.x, vz: v.z });
      requests.push((ready) => {
        if (b.body.isEnabled() !== ready) b.body.setEnabled(ready);
        if (b.driver) b.driver.waiting = !ready;
      });
    };
    for (const driver of this.drivers.values()) {
      const c = driver.car, b = this.bodies.get(c.id);
      if (b) requestBody(b);
      else {
        const p = c.detachedPose!;
        pts.push({ x: p.x, z: p.z, vx: Math.sin(p.h) * c.v, vz: Math.cos(p.h) * c.v });
        requests.push((ready) => {
          if (ready) {
            this.control(this.place(c, p, c.v, 'player'), driver);
            driver.waiting = false;
          }
        });
      }
    }
    for (const b of this.bodies.values()) {
      if (b.ctl && b.state !== 'player') requestBody(b);
    }
    for (const c of want) {
      if (this.bodies.has(c.id)) continue;
      const h = Math.atan2(c.geo.fx, c.geo.fy);
      pts.push({ x: c.geo.cx, z: c.geo.cy, vx: Math.sin(h) * c.v, vz: Math.cos(h) * c.v });
      requests.push((ready) => {
        if (ready) this.spawn(c, T);
        else st.notReady++;
      });
    }
    const t0 = performance.now(), ready = this.terrain.update(pts, this.t * 1000);
    st.terrainMs = performance.now() - t0;
    st.notReady = 0;
    for (let i = 0; i < requests.length; i++) requests[i](ready[i]);
    for (const [c, p] of paths) if (!this.bodies.has(c.id) && !want.has(c)) this.pathBody(c, p);
    this.syncCoaches(T, driveDist);

    const now = T.tickNumber * TICK * 1000;
    const cmds = new Map<Body, Cmd>();
    const driving: Body[] = [];
    for (const b of this.bodies.values()) {
      if (b.state === 'track' && b.body.isEnabled()) cmds.set(b, this.steer(b, T));
      if (b.state === 'player' && !b.driver!.waiting) driving.push(b);
      b.prev = b.cur;
    }
    let stp = 0;
    for (let k = 0; k < SUB; k++) {
      this.moveCoaches((k + 1) / SUB);
      for (const [c, p] of paths) {
        const b = this.bodies.get(c.id);
        if (b?.state === 'path') this.movePathBody(b, p, (k + 1) / SUB);
      }
      const velocities = new Map<Body, Vec3>();
      for (const b of this.bodies.values()) {
        if (!b.ctl || !b.body.isEnabled()) continue;
        if (b.drive) {
          const driver = b.driver;
          const input = driver ? (driver.held(now) ? NO_INPUT : driver.input) : PARK;
          b.drive.step(input, STEP);
          if (driver) {
            b.car.brake = input.brake > 0 || input.handbrake ? 1 : 0;
            this.hitPeople(b, T);
            this.feelWalkers(b, T);
          }
        } else this.drive(b, cmds.get(b) ?? WRECK_CMD);
        if (driving.length) velocities.set(b, b.body.linvel());
      }
      const s0 = performance.now();
      this.world.step();
      stp += performance.now() - s0;
      for (const b of this.bodies.values()) {
        if (!b.ctl || !b.body.isEnabled()) continue;
        if (b.drive) {
          const before = velocities.get(b);
          const speed = before && b.driver ? this.coachImpact(b, before) : 0;
          let event: CarEvent | Hit | null = b.drive.afterStep(STEP);
          if (speed > 2 && (event?.kind !== 'impact' || speed > event.speed)) event = { kind: 'coach', speed, ...hitOf(b.drive, before!, b.body.linvel()) };
          if (b.state === 'park' && b.drive.status === 'water') b.water = true;
          if (event) b.driver?.contact(T.tickNumber, now, event, !!b.build.bike, b.drive.lean);
        } else this.afterStep(b);
      }
      for (const b of driving) this.hitTraffic(b, velocities, T, now);
    }
    for (const b of this.bodies.values()) {
      b.cur = this.read(b);
      if (b.state !== 'track' && b.state !== 'path') this.publish(b, now);
    }
    st.held = 0;
    for (const b of [...this.bodies.values()]) {
      if (!b.body.isEnabled()) continue;
      b.age += dt;
      if (b.state === 'track') {
        if (this.check(b, T)) continue;
        if (b.held) { b.car.v = Math.min(b.car.v, Math.max(0, this.forward(b))); st.held++; }
      } else if (b.state === 'wreck' || b.state === 'park') this.settle(b, dt);
    }
    for (const [c, f] of this.fades) { f.t += dt; if (f.t >= f.dur) this.fades.delete(c); }
    st.bodies = this.bodies.size;
    st.tracking = st.wrecks = st.resting = 0;
    for (const b of this.bodies.values()) {
      if (b.state === 'track') st.tracking++;
      if (b.state === 'wreck') st.wrecks++;
      if (b.state === 'rest') st.resting++;
    }
    st.stepMs = stp;
    st.tickMs = performance.now() - f0;
  }

  // the drawn pose (view/life.ts drawCars; a: between the last two ticks; under: the kinematic one for a car in the
  // traffic, the last drawn otherwise): a parked car or a wreck where it is, the body's, and a blend back to the
  // kinematic one after a release (or a body put on its ghost again)
  pose(c: Car, a: number, under: RoadPose): RoadPose {
    return drawnBodyPose(this.drawState(c), a, c.detachedPose ?? under, TICK);
  }

  drawState(c: Car): BodyDraw | null {
    const b = this.bodies.get(c.id), f = this.fades.get(c);
    if (!b && !f) return null;
    const moving = !!b && b.state !== 'rest' && b.state !== 'path';
    const fall = b?.driver?.fallUntil ? { side: b.driver.fallSide, until: b.driver.fallUntil, tick: this.tickNumber } : null;
    return { owns: !!b && b.state !== 'path', body: !!b, p0: moving ? this.mapPose(b.prev) : null, p1: moving ? this.mapPose(b.cur) : null,
      drive: moving && b.drive ? { wheelZ: b.build.wheels[2].z, fall } : null, fade: f ? { ...f } : null };
  }

  // a body pose in map metres (the physics world's origin added)
  private mapPose(p: P7): BodyPose {
    const o: BodyPose = { x: p.x + this.origin.x, y: p.y, z: p.z + this.origin.z, qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw, ride: p.ride };
    if (p.lean !== undefined) o.lean = p.lean;
    if (p.wheelie !== undefined) o.wheelie = p.wheelie;
    return o;
  }

  dispose() {
    for (const b of [...this.bodies.values()]) this.remove(b);
    this.coachBodies.clear();
    this.coachColliders.clear();
    this.terrain.dispose();
    this.world.free();
  }

  // Coaches, and the walls the world puts in the traffic (the crafts: Traffic.walls), interact with player chassis as
  // kinematic walls. They never enter the road vehicle wreck path. A coach's hit is a train's (coachImpact); a wall's
  // is the car core's, as at a voxel wall.
  private syncCoaches(T: Traffic, driveDist: (x: number, z: number) => number) {
    const nearby = new Set<string>();
    if (this.drivers.size) {
      for (const [boxes, coach] of [[T.trains.coachBoxes(), true], [T.walls(), false]] as const) for (const box of boxes) {
        const { x, y, z, size } = box;
        if (driveDist(x, z) > DRIVE_RADIUS + size.z / 2) continue;
        nearby.add(box.id);
        const existing = this.coachBodies.get(box.id);
        if (existing) {
          existing.from = existing.to;
          existing.to = box;
          continue;
        }
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(x - this.origin.x, y + size.y / 2, z - this.origin.z)
          .setRotation(axisAngle(quat(), vec3(0, 1, 0), box.heading)));
        const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
          .setCollisionGroups(CAR_ONLY_GROUPS), body);
        this.coachBodies.set(box.id, { body, collider, from: box, to: box });
        if (coach) this.coachColliders.add(collider.handle);
      }
    }
    for (const [id, coach] of this.coachBodies) {
      if (nearby.has(id)) continue;
      this.coachColliders.delete(coach.collider.handle);
      this.world.removeRigidBody(coach.body);
      this.coachBodies.delete(id);
    }
  }

  private moveCoaches(a: number) {
    for (const { body, from, to } of this.coachBodies.values()) {
      body.setNextKinematicTranslation({ x: mix(from.x, to.x, a) - this.origin.x,
        y: mix(from.y, to.y, a) + to.size.y / 2, z: mix(from.z, to.z, a) - this.origin.z });
      const heading = from.heading + wrapAngle(to.heading - from.heading) * a;
      body.setNextKinematicRotation(axisAngle(quat(), vec3(0, 1, 0), heading));
    }
  }

  // The car core detects lost speed against walls. Relative speed also covers a moving train hitting a stopped car.
  private coachImpact(player: Body, velocity: Vec3) {
    let speed = 0;
    if (!this.coachColliders.size) return speed;
    this.world.contactPairsWith(player.chassis, (collider) => {
      if (!this.coachColliders.has(collider.handle)) return;
      const train = collider.parent()!.linvel();
      this.world.contactPair(player.chassis, collider, (contact, flipped) => {
        const n = contact.normal(), sign = flipped ? -1 : 1;
        if (Math.abs(n.y) > 0.5) return;
        for (let i = 0; i < contact.numContacts(); i++) {
          if (contact.contactImpulse(i) <= 0) continue;
          const closing = sign * ((velocity.x - train.x) * n.x + (velocity.z - train.z) * n.z);
          speed = Math.max(speed, closing);
          break;
        }
      });
    });
    return speed;
  }

  // ------------------------------------------------------------------ bodies
  // a body for car c at its kinematic pose, moving at its speed
  private spawn(c: Car, T: Traffic) {
    this.place(c, this.pathPose(c, T), c.v, 'track');
    this.stats.spawned++;
    this.log.push({ t: this.t, kind: 'spawn', id: c.id });
  }

  private place(c: Car, pose: RoadPose, speed: number, state: Body['state']): Body {
    const build = buildOf(c);
    const q = poseRotation(pose);
    const ride = build.ride + (state === 'player' ? 0.1 : 0.05);
    const up = upOf(q.x, q.y, q.z, q.w);
    const at = { x: pose.x - this.origin.x + up.x * ride, y: pose.y + up.y * ride, z: pose.z - this.origin.z + up.z * ride };
    const v = createVehicle(RAPIER, this.world, at, q, build, false, this.rideTuning);
    if (state !== 'player') v.chassis.setCollisionGroups(WORLD_GROUPS);
    const f = fwdOf(q.x, q.y, q.z, q.w);
    v.body.setLinvel({ x: f.x * speed, y: 0, z: f.z * speed }, true);
    const p0: P7 = { ...at, qx: q.x, qy: q.y, qz: q.z, qw: q.w, ride };
    const b: Body = { car: c, body: v.body, chassis: v.chassis, ctl: v.controller, build, state, age: 0, still: 0, prev: p0, cur: p0,
      lat: 0, along: 0, vb: speed, held: false, water: false };
    this.bodies.set(c.id, b);
    this.byCollider.set(b.chassis.handle, b);
    return b;
  }

  // Traffic outside the edit radius stays on its path. Put a box in the shared world only near a driver.
  private pathBody(c: Car, p: RoadPose) {
    const build = buildOf(c), half = build.half, ride = half.y + 0.15;
    const at = { x: p.x - this.origin.x, y: p.y + ride, z: p.z - this.origin.z }, q = poseRotation(p);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z).setRotation(q));
    const chassis = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.3).setCollisionGroups(WORLD_GROUPS), body);
    const cur = { ...at, qx: q.x, qy: q.y, qz: q.z, qw: q.w, ride };
    const b: Body = { car: c, body, chassis, ctl: null, build, state: 'path', age: 0, still: 0, prev: cur, cur, lat: 0, along: 0, vb: c.v, held: false, water: false };
    this.bodies.set(c.id, b);
    this.byCollider.set(chassis.handle, b);
  }

  private movePathBody(b: Body, p: RoadPose, a: number) {
    const x = p.x - this.origin.x, y = p.y + b.cur.ride, z = p.z - this.origin.z;
    b.body.setNextKinematicTranslation({ x: mix(b.prev.x, x, a), y: mix(b.prev.y, y, a), z: mix(b.prev.z, z, a) });
    const from = Math.atan2(2 * (b.prev.qx * b.prev.qz + b.prev.qw * b.prev.qy), 1 - 2 * (b.prev.qx * b.prev.qx + b.prev.qy * b.prev.qy));
    const delta = p.h - from;
    const h = from + Math.atan2(Math.sin(delta), Math.cos(delta)) * a;
    b.body.setNextKinematicRotation(poseRotation({ h, pitch: p.pitch, roll: p.roll }));
  }

  private remove(b: Body) {
    b.drive?.clearWedges();
    if (b.ctl) this.world.removeVehicleController(b.ctl);
    this.world.removeRigidBody(b.body);
    this.byCollider.delete(b.chassis.handle);
    this.bodies.delete(b.car.id);
  }

  // the body goes, the car drawn from its ghost again: the difference blended out (longer the further)
  private release(b: Body, T: Traffic, why: LogKind = 'release') {
    const c = b.car, K = T.carPose(c, c.s, c.off, this.pose0), r = this.poseAt(b, 1);
    this.remove(b);
    if (why === 'release') this.stats.released++;
    this.log.push({ t: this.t, kind: why, id: c.id });
    let dh = r.h - K.h;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const old = this.fades.get(c), dist = Math.hypot(r.x - K.x, r.y - K.y, r.z - K.z);
    const f: Fade = { dx: r.x - K.x, dy: r.y - K.y, dz: r.z - K.z, dh, t: 0, dur: Math.min(FADE_MAX, Math.max(FADE_MIN, dist / FADE_V, old ? old.dur - old.t : 0)) };
    this.stats.releasePop = Math.max(this.stats.releasePop, dist);
    this.fades.set(c, f);
  }

  // What chases the ghost (the car's kinematic pose, between its axles, and its path ahead): the speed wanted (closing
  // the gap along the path in about a second; less if something stands in the way: look()) and the front wheels'
  // angle (pure pursuit)
  private steer(b: Body, T: Traffic): Cmd {
    const c = b.car, K = T.carPose(c, c.s, c.off, this.pose0), B = this.B, A = this.A;
    const p = b.body.translation(), r = b.body.rotation();
    const px = p.x + this.origin.x, pz = p.z + this.origin.z;
    const tx = Math.sin(K.h), tz = Math.cos(K.h), dx = K.x - px, dz = K.z - pz;
    b.along = dx * tx + dz * tz;
    b.lat = dx * tz - dz * tx;
    const f = fwdOf(r.x, r.y, r.z, r.w), fl = Math.hypot(f.x, f.z) || 1;
    const vb = b.vb = this.forward(b);
    const sMid = c.s - (c.len - 1.2) / 2, Ld = 2.5 + Math.abs(vb) * 0.45;
    T.pathPoint(c, sMid - b.along + Ld, B);
    let a = Math.atan2(B.x - px, B.y - pz) - Math.atan2(f.x, f.z);
    a = Math.atan2(Math.sin(a), Math.cos(a));
    // (pure pursuit: the arc through the point Ld ahead, the wheels' angle for it)
    const W = b.build.wheels, wb = W[0].z - W[2].z;
    const ang = Math.max(-AI_STEER, Math.min(AI_STEER, Math.atan(wb * 2 * Math.sin(a) / Ld)));
    let want = Math.max(0, Math.min(c.v + 6, c.v + b.along));
    // (along the path's grade: the road rising ahead is not in the way)
    T.pathPoint(c, sMid, A);
    const grade = (B.z - A.z) / Math.max(1, Math.hypot(B.x - A.x, B.y - A.y));
    const clear = this.look(b, f.x / fl, f.z / fl, grade, Math.abs(vb));
    if (clear < Infinity) want = Math.min(want, Math.sqrt(Math.max(0, 2 * 4 * (clear - 1.5))));
    return { want, vb, ang, stopped: want < 0.3 && c.v < 0.05 };
  }

  // the free way ahead of a body (m; Infinity: none within its stopping distance and a bit): its box swept forward, a
  // little up (not the road rising ahead); what it meets with a face across the way (a body, a wall, a placed block).
  // Held (its ghost waits for it) when that is a body or a wreck, or in an edited box (a placed block, a crater's far
  // wall); not for the city as it was built (a wall on the path: the data's, not the player's; the body brakes, its
  // ghost goes on, and away from the edits the body is put back on it)
  private look(b: Body, fx: number, fz: number, grade: number, v: number) {
    b.held = false;
    if (!this.opts.look) return Infinity;
    const p = b.body.translation(), reach = 2 + v + v * v / 8, n = Math.hypot(1, grade);
    const hit = this.world.castShape({ x: p.x, y: p.y + LOOK_UP, z: p.z }, b.body.rotation(), { x: fx / n, y: grade / n, z: fz / n }, b.chassis.shape, 0.05, reach, true,
      undefined, WORLD_GROUPS, b.chassis, b.body);
    if (!hit || Math.abs(hit.normal1.y) > 0.6) return Infinity;
    const d = hit.time_of_impact + b.build.half.z;
    b.held = this.byCollider.has(hit.collider.handle) || this.editDist(p.x + this.origin.x + fx * d, p.z + this.origin.z + fz * d, 2) < 2;
    return hit.time_of_impact;
  }

  // The AI controller on the chassis and wheels: the wheels' angle, the engine or the brakes for the speed wanted
  private drive(b: Body, m: Cmd) {
    const c = b.ctl!, B = b.build, dv = m.want - m.vb;
    const engine = m.stopped ? 0 : dv > 0 ? Math.min(1, dv * 0.8) * B.engine : 0;
    const brake = m.stopped ? B.brake * 2 : dv < -0.3 ? Math.min(1, -dv * 0.4) * B.brake : B.brake * 0.02;
    for (let i = 0; i < c.numWheels(); i++) {
      const front = B.wheels[i].front;
      c.setWheelSteering(i, front ? m.ang : 0);
      c.setWheelEngineForce(i, front ? 0 : engine);
      c.setWheelBrake(i, brake);
    }
    c.updateVehicle(STEP, undefined, WORLD_GROUPS);
  }

  // after a step: the ride height (the touching wheels' suspension, eased), the water, out of the ground if pushed
  // through its shell (as car.ts afterStep)
  private afterStep(b: Body) {
    const c = b.ctl!, body = b.body, p = body.translation(), o = this.origin;
    let n = 0, len = 0;
    for (let i = 0; i < c.numWheels(); i++) if (c.wheelIsInContact(i)) { n++; len += c.wheelSuspensionLength(i) ?? REST; }
    const target = n ? 0.2 + len / n + WHEEL_R : b.build.ride;
    b.cur = { ...b.cur, ride: b.cur.ride + (target - b.cur.ride) * (1 - Math.exp(-STEP / 0.05)) };
    const w = this.terrain.waterAt(p.x + o.x, p.z + o.z);
    if (w >= 0 && p.y < w + 1.2) b.water = true;
    const top = this.terrain.solidTop(p.x + o.x, p.y, p.z + o.z);
    if (top >= 0) {
      const v = body.linvel();
      body.setTranslation({ x: p.x, y: top + 1, z: p.z }, true);
      body.setLinvel({ x: v.x, y: Math.max(0, v.y), z: v.z }, true);
    }
  }

  private read(b: Body): P7 {
    const p = b.body.translation(), r = b.body.rotation();
    return { x: p.x, y: p.y, z: p.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w, ride: b.drive?.ride ?? b.cur.ride, lean: b.drive?.lean, wheelie: b.drive?.wheelie };
  }

  private forward(b: Body) {
    const r = b.body.rotation(), v = b.body.linvel(), f = fwdOf(r.x, r.y, r.z, r.w);
    return (v.x * f.x + v.z * f.z) / (Math.hypot(f.x, f.z) || 1);
  }

  // car c's pose (the ground under the body's origin; its heading, pitch, roll) between two body poses (as the sim
  // reads it: no lean, wheelie or fall; drawn: drawState)
  private poseAt(b: Body, a: number): RoadPose {
    return bodyPoseAt(b.prev, b.cur, a, null, TICK, this.origin.x, this.origin.z);
  }

  private publish(b: Body, now: number) {
    const c = b.car, pose = c.detachedPose = this.poseAt(b, 1);
    const drive = b.drive, driver = b.driver;
    if (!drive || !driver || driver.waiting) return;
    c.v = drive.kmh / 3.6;
    if (b.build.bike && !driver.fallUntil && drive.airTime === 0 && !upright(drive, 0.5)) driver.fall(this.tickNumber, now, drive.lean, { kind: 'side', speed: 0 });
    if (drive.status === 'water' && !driver.sinkUntil) {
      driver.sinkUntil = now + SINK_MS;
      driver.note(this.tickNumber, 'Splash! Back on the road in a moment…', SINK_MS);
    }
    if (driver.safe.due(now) && drive.status === 'ok' && drive.wheelsInContact() >= 3 && upright(drive, 0.9)) {
      const g = this.terrain.groundAt(pose.x, pose.z, pose.y + 0.5);
      if (g !== null && Math.abs(g - pose.y) < 1 && this.terrain.waterAt(pose.x, pose.z) < 0)
        driver.safe.push({ ...pose, pitch: 0, roll: 0 }, now);
    }
  }

  // A player on foot ahead of or behind the driven car, at its height: the car's speed towards them held to PUSH, so it
  // stops as at a wall and then nudges them along (their page shoves its walker out of the car). It does not run them
  // over as it does the crowd (hitPeople): the walk is their page's, the host cannot throw them, and a car seen driving
  // through a player is worse than one stopped. Their pose is a tick or so old: the reach ahead covers this substep's.
  private feelWalkers(b: Body, T: Traffic) {
    const c = b.car, at = c.detachedPose;
    if (!T.walkers.length || !at) return;
    const s = carShape(c), p = b.body.translation(), r = b.body.rotation(), inv = quat(-r.x, -r.y, -r.z, r.w);
    const v = b.body.linvel(), l = rotate(vec3(v.x, v.y, v.z), inv), reach = Math.abs(l.z) * STEP + 0.3;
    let cut = 0;
    for (const w of T.walkers) {
      // (one on the roof rides along)
      
      if (w.y > at.y + s.top - 0.5 || w.y + WALKER_HEAD < at.y) continue;
      const q = rotate(vec3(w.x - this.origin.x - p.x, 0, w.z - this.origin.z - p.z), inv);
      if (Math.abs(q.x) > s.hx + WALKER_R || Math.abs(q.z) > s.hz + WALKER_R + reach || Math.abs(q.z) < s.hz / 2) continue;
      const lim = q.z > 0 ? PUSH : -PUSH;
      if ((q.z > 0 && l.z > lim) || (q.z < 0 && l.z < lim)) { cut = Math.max(cut, Math.abs(l.z - lim)); l.z = lim; }
    }
    if (!cut) return;
    b.body.setLinvel(rotate(l, r), true);
    if (cut > 3) b.driver!.note(T.tickNumber, 'Ouch!', 600);
  }

  private hitPeople(b: Body, T: Traffic) {
    const v = b.body.linvel(), speed = Math.hypot(v.x, v.y, v.z);
    if (speed < HIT_SPEED) return;
    const p = b.body.translation(), r = b.body.rotation(), inv = quat(-r.x, -r.y, -r.z, r.w);
    const x = p.x + this.origin.x, z = p.z + this.origin.z;
    const half = b.build.half, reach = speed * STEP + 0.3, fwd = rotate({ ...v }, inv).z >= 0;
    const zlo = -half.z - (fwd ? 0.3 : reach), zhi = half.z + (fwd ? reach : 0.3);
    const hit = (person: Traffic['people'][number]) => {
      if (T.held.person.has(person.id)) return;
      const q = T.peds[person.e];
      if (!q || (Math.abs(q.p[0][0] - x) > q.L + 15 || Math.abs(q.p[0][1] - z) > q.L + 15)) return;
      const w = T.personPoint(person, 0, this.A);
      if (Math.abs(w.x - x) > 12 || Math.abs(w.y - z) > 12) return;
      const l = rotate(vec3(w.x - x, w.z + 0.9 - p.y, w.y - z), inv);
      if (Math.abs(l.x) > half.x + 0.35 || l.z < zlo || l.z > zhi || l.y < -1.6 || l.y > 2 * half.y + 0.5) return;
      const ahead = T.personPoint(person, 0.4, this.B);
      const pose = { x: w.x, y: w.z, z: w.y, h: Math.atan2(ahead.x - w.x, ahead.y - w.y), pitch: 0, roll: 0 };
      if (!T.removePerson(person)) return;
      b.body.setLinvel({ x: v.x * 0.95, y: v.y, z: v.z * 0.95 }, true);
      T.struck.push({ tick: T.tickNumber, ...fallen(person), pose, vx: v.x, vz: v.z, by: b.car.id });
      b.driver!.note(T.tickNumber, 'Ouch!', 600);
    };
    // A hit removes an agent from the lists.
    for (const list of [T.people, T.riders]) for (let i = list.length - 1; i >= 0; i--) hit(list[i]);
  }

  private hitTraffic(player: Body, velocities: Map<Body, Vec3>, T: Traffic, now: number) {
    const v = velocities.get(player)!;
    const hits: Body[] = [];
    this.world.contactPairsWith(player.chassis, (collider) => {
      const b = this.byCollider.get(collider.handle);
      if (b && (b.state === 'track' || b.state === 'path')) hits.push(b);
    });
    hits.sort((a, b) => a.car.id - b.car.id);
    for (const b of hits) {
      let contact = false;
      this.world.contactPair(player.chassis, b.chassis, (m) => { if (m.numContacts()) contact = true; });
      if (!contact) continue;
      const u = velocities.get(b) ?? b.body.linvel(), speed = Math.hypot(v.x - u.x, v.y - u.y, v.z - u.z);
      if (speed < KNOCK) continue;
      // (what the hit did to the player's car: before the path branch sets its velocity back)
      const hit = hitOf(player.drive!, v, player.body.linvel());
      if (b.state === 'path') {
        b.cur = this.read(b);
        const p = this.poseAt(b, 1), c = b.car;
        this.remove(b);
        if (!T.detachCar(c, p)) continue;
        const wreck = this.place(c, p, 0, 'wreck');
        wreck.body.setLinvel(u, true);
        // Let the two dynamic masses meet in the next substep.
        player.body.setLinvel(v, true);
        c.v = 0;
        c.brake = 1;
      } else {
        b.cur = this.read(b);
        this.wreck(b.car, T, 'player contact');
      }
      player.driver!.contact(T.tickNumber, now, { kind: 'knock', speed, ...hit }, !!player.build.bike, player.drive!.lean);
    }
  }

  // a body too far from its ghost (or rolled over, or in the water): near an edit a wreck, out of the traffic;
  // elsewhere put back on its ghost. Returns whether it was lost.
  private check(b: Body, T: Traffic) {
    const c = b.car, r = b.body.rotation(), up = upOf(r.x, r.y, r.z, r.w).y;
    const K = T.carPose(c, c.s, c.off, this.pose0), p = b.body.translation();
    const dy = K.y - (p.y - b.cur.ride * up);
    let why = '';
    if (Math.abs(b.lat) > LOST_LAT) why = `lat ${b.lat.toFixed(1)}`;
    else if (Math.abs(b.along) > LOST_ALONG) why = `along ${b.along.toFixed(1)}`;
    else if (Math.abs(dy) > LOST_Y) why = `dy ${dy.toFixed(1)}`;
    else if (up < LOST_UP) why = `up ${up.toFixed(2)}`;
    else if (b.water) why = 'water';
    if (!why) return false;
    const x = p.x + this.origin.x, z = p.z + this.origin.z, at: [number, number, number] = [x, p.y, z], d = this.editDist(x, z, 2 * RESYNC_R);
    if (d > RESYNC_R) {
      this.release(b, T, 'resync');
      this.cool.set(c, this.t + (d > 2 * RESYNC_R ? COOL_S : COOL_NEAR_S));
      this.stats.resynced++;
      this.log[this.log.length - 1].why = why;
      this.log[this.log.length - 1].at = at;
      return true;
    }
    this.wreck(c, T, why, at);
    return true;
  }

  // Car c's body a wreck (lost near an edit; or anything else that wrecks a car): out of the traffic (parked where it
  // is, the cars behind wait for it), its body braked, drawn where it is until it rests. Whether c had a body.
  wreck(c: Car, T: Traffic, why = 'wrecked', at?: [number, number, number]) {
    const b = this.bodies.get(c.id);
    if (!b || b.state !== 'track') return false;
    b.state = 'wreck';
    b.age = 0;
    T.detachCar(b.car, this.poseAt(b, 1));
    b.car.v = 0;
    b.car.brake = 1;
    this.stats.lost++;
    const p = b.car.detachedPose!;
    this.log.push({ t: this.t, kind: 'lost', id: b.car.id, why, at: at ?? [p.x, p.y, p.z] });
    return true;
  }

  // a wreck come to rest (or in the water, or too long about it): its pose kept on the car (a parked car); its body
  // fixed where it lies (still met by the bodies near it), or gone in the water
  private settle(b: Body, dt: number) {
    const v = b.body.linvel(), a = b.body.angvel(), p = b.body.translation();
    b.still = Math.hypot(v.x, v.y, v.z) < 0.25 && Math.hypot(a.x, a.y, a.z) < 0.25 ? b.still + dt : 0;
    if (b.still <= WRECK_REST_S && b.age <= WRECK_MAX_S && !b.water) return;
    b.car.detachedPose = this.poseAt(b, 1);
    this.log.push({ t: this.t, kind: 'rest', id: b.car.id, at: [p.x + this.origin.x, p.y, p.z + this.origin.z] });
    if (b.water) { this.remove(b); return; }
    b.drive?.clearWedges();
    b.drive = undefined;
    this.world.removeVehicleController(b.ctl!);
    b.ctl = null;
    b.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    b.chassis.setCollisionGroups(WORLD_GROUPS);
    b.state = 'rest';
  }
}

// a wreck: no engine, the brakes on
const WRECK_CMD: Cmd = { want: 0, vb: 0, ang: 0, stopped: true };
// a rotation's up (its y axis) and forward (its z axis)
const upOf = (x: number, y: number, z: number, w: number) => ({ x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) });
const fwdOf = (x: number, y: number, z: number, w: number) => ({ x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) });

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
// what a hit from something moving did to a car in a step, from its velocity before (a) to after (b): the speed lost
// along its heading, the change of its horizontal velocity (player-car.ts Hit)
const hitOf = (car: RapierCar, a: Vec3, b: Vec3) => ({ head: car.headLost(a, b), shove: Math.hypot(b.x - a.x, b.z - a.z) });
const upright = (car: RapierCar, min: number) => {
  const q = car.body.rotation();
  return upOf(q.x, q.y, q.z, q.w).y > min;
};
function poseRotation(p: Pick<RoadPose, 'h' | 'pitch' | 'roll'>) {
  const q = axisAngle(quat(), vec3(0, 1, 0), p.h);
  quatMul(q, q, axisAngle(quat(), vec3(1, 0, 0), -p.pitch));
  return quatMul(q, q, axisAngle(quat(), vec3(0, 0, 1), p.roll));
}
