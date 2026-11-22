// The traffic's cars near player edits as real Rapier bodies (docs/plans/life-physics.md: the A+B hybrid).
//
// Part of the world sim (sim/traffic.ts): no three.js, no DOM, no camera (tools/core-deps.mjs); stepped in the
// traffic's fixed tick (TrafficBodies.tick, SUB physics steps a tick), its colliders built a fixed number of chunks a
// tick, so the same inputs give the same bodies (tools/life-edit.mjs checks two runs bit for bit).
//
// The traffic stays what it is (IDM, lanes, signals, junction boxes, all kinematic). A car within NEAR m of an edited
// box (at most MAX_BODIES, nearest the edits first) also gets a body: the player's car's chassis and raycast wheels
// (vehicle.ts) driven by a lean AI controller that chases the car's simulated place on its path (its "ghost": pure
// pursuit for the steering, the gap along the path for the throttle). The car is drawn where its body is.
//   - Look-ahead: a shape cast a body a tick, lifted LOOK_UP and tilted to the path's grade; the body brakes for what
//     stands across its way (a placed block, a wreck, a body). While it is held up so, its ghost waits for it (the
//     car's speed is the body's): the cars behind queue as for any car.
//   - Losing the ghost (more than LOST_* from it, rolled over, in the water): within RESYNC_R of an edit the car is a
//     wreck (the world's doing: fallen into a dug hole, crashed into a block): out of the traffic (Traffic.takeWheel:
//     parked, blocking the cars behind), its body left to come to rest, then kept as a fixed collider while near an
//     edit. Further from the edits (a junction tighter than a car can steer, the voxels on a path, a push from behind:
//     not the player's doing) its body goes and it is drawn back onto its ghost, blended over FADE_* (no pop), no body
//     for COOL_S.
//   - Leaving NEAR * HYST: the body goes, the drawn pose blends back to the ghost's.
// Nothing edited: nothing done (tick returns at once; no colliders, no bodies).
// The world's colliders: terrain.ts (the player car's streaming), REACH m round every body; live edits
// (core/live-edits.ts) rebuild the chunks they touch.
import RAPIER from '@dimforge/rapier3d-compat';
import { liveEdits } from '../../core/live-edits';
import { pt } from '../../sim/path';
import { STEP as TICK, type CarPose, type Traffic, type TrafficBodies } from '../../sim/traffic';
import type { Car } from '../../sim/types';
import type { Meta } from '../../types';
import { CHUNK, RapierTerrain, WHEEL_GROUPS, type TerrainOptions } from './terrain';
import { createVehicle, REST, WHEEL_R, warmUp, type CarBuild } from './vehicle';
import { buildOf } from '../../sim/vehicles';
export { liveEdits };

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
const AI_STEER = 0.65; // the front wheels' most angle for the AI controller (the player's: 0.55, less at speed)
const LOOK_UP = 0.7; // m: look() sees what stands this much over a body's bottom (not a kerb or a step)

export interface LifePhysOptions {
  near: number; maxBodies: number; chunksPerTick: number;
  look: boolean; // (tools: the look-ahead off)
}
export const DEFAULTS: LifePhysOptions = { near: NEAR, maxBodies: MAX_BODIES, chunksPerTick: CHUNKS_PER_TICK, look: true };

// a pose in physics coordinates (the body's origin, its rotation) and the ground under it along its up (ride)
interface P7 { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; ride: number }
interface Body {
  car: Car;
  body: RAPIER.RigidBody;
  chassis: RAPIER.Collider;
  ctl: RAPIER.DynamicRayCastVehicleController | null; // (none at rest)
  build: CarBuild;
  state: 'track' | 'wreck' | 'rest';
  age: number; still: number;
  prev: P7; cur: P7;
  // the tracking error now (m): across, along the path (> 0: behind its ghost); its speed forward; held up (look)
  lat: number; along: number; vb: number; held: boolean;
  water: boolean;
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

export class LifePhysics implements TrafficBodies {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly origin: { x: number; z: number };
  readonly opts: LifePhysOptions;
  readonly bodies = new Map<Car, Body>();
  private readonly fades = new Map<Car, Fade>();
  private readonly byCollider = new Map<number, Body>();
  private readonly cool = new Map<Car, number>();
  private edits: [number, number, number, number][] = [];
  t = 0;
  readonly stats: LifePhysStats = { bodies: 0, tracking: 0, wrecks: 0, resting: 0, held: 0, spawned: 0, released: 0, lost: 0, resynced: 0, notReady: 0,
    tickMs: 0, stepMs: 0, terrainMs: 0, releasePop: 0 };
  // what happened to whom (tools)
  readonly log: { t: number; kind: LogKind; id: number; why?: string; at?: [number, number, number] }[] = [];
  private readonly A = pt();
  private readonly B = pt();
  private readonly pose0: CarPose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };

  // Rapier initialised (load()). focus: where the action is (the physics' origin, for f32 precision); terrain: where
  // the tiles come from (a cache or a load)
  constructor(meta: { W: number; D: number; tiles: { N: number }; palette: Meta['palette'] }, focus: { x: number; z: number }, opts: Partial<LifePhysOptions> = {}, terrain: TerrainOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.origin = { x: Math.floor(focus.x / CHUNK) * CHUNK, z: Math.floor(focus.z / CHUNK) * CHUNK };
    this.terrain = new RapierTerrain(RAPIER, this.world, meta, this.origin, { reach: REACH, needNow: NEED_NOW, budgetChunks: this.opts.chunksPerTick, ...terrain });
  }

  static async load(meta: Meta, focus: { x: number; z: number }, opts: Partial<LifePhysOptions> = {}, terrain: TerrainOptions = {}) {
    await RAPIER.init();
    warmUp();
    return new LifePhysics(meta, focus, opts, terrain);
  }

  owns(c: Car) { return this.bodies.has(c); }

  // m from world (x, z) to the nearest edited box (0 inside one; Infinity: none)
  editDist(x: number, z: number) {
    let d = Infinity;
    for (const e of this.edits) d = Math.min(d, Math.hypot(Math.max(e[0] - x, 0, x - e[2]), Math.max(e[1] - z, 0, z - e[3])));
    return d;
  }

  // One traffic tick (after the cars moved)
  tick(dt: number, T: Traffic) {
    this.edits = T.edits;
    const st = this.stats;
    if (!this.edits.length && !this.bodies.size && !this.fades.size && !this.terrain.stats.chunks) { st.tickMs = st.stepMs = st.terrainMs = 0; return; }
    const f0 = performance.now(), o = this.opts;
    this.t += dt;
    // the cars wanted: within NEAR of an edit (those with a body: NEAR * HYST), nearest first
    const near: { c: Car; d: number }[] = [];
    for (const c of T.cars) {
      if (c === T.keep) continue;
      const own = this.bodies.has(c), d = this.editDist(c.geo.cx, c.geo.cy);
      if (d >= (own ? o.near * HYST : o.near) || (!own && (this.cool.get(c) ?? -1) > this.t)) continue;
      near.push({ c, d });
    }
    near.sort((a, b) => a.d - b.d || a.c.id - b.c.id);
    const want = new Set(near.slice(0, o.maxBodies).map((n) => n.c));
    // bodies no longer wanted: released (their drawn pose blends back to the ghost's), or gone with their car
    const moving = new Set(T.cars), parked = new Set(T.detachedCars);
    for (const [c, b] of this.bodies) {
      if (b.state === 'track') { if (!moving.has(c)) this.remove(b); else if (!want.has(c)) this.release(b, T); continue; }
      // (a wreck: gone with its car (the oldest parked cars go, the player's drive takes one), or far from the edits)
      if (!parked.has(c) || (b.state === 'rest' && this.editDist(c.rp!.x, c.rp!.z) > o.near * HYST)) this.remove(b);
    }
    for (const [c, until] of this.cool) if (until <= this.t) this.cool.delete(c);
    // the colliders round every body and every car to get one
    const pts: { x: number; z: number; vx?: number; vz?: number }[] = [], who: (Car | null)[] = [];
    for (const b of this.bodies.values()) {
      if (b.state === 'rest') continue;
      const p = b.body.translation(), v = b.body.linvel();
      pts.push({ x: p.x + this.origin.x, z: p.z + this.origin.z, vx: v.x, vz: v.z });
      who.push(null);
    }
    for (const c of want) {
      if (this.bodies.has(c)) continue;
      const h = Math.atan2(c.geo.fx, c.geo.fy);
      pts.push({ x: c.geo.cx, z: c.geo.cy, vx: Math.sin(h) * c.v, vz: Math.cos(h) * c.v });
      who.push(c);
    }
    const t0 = performance.now();
    const ready = this.terrain.update(pts, this.t * 1000);
    st.terrainMs = performance.now() - t0;
    st.notReady = 0;
    for (let i = 0; i < who.length; i++) { const c = who[i]; if (c) { if (ready[i]) this.spawn(c, T); else st.notReady++; } }
    // the steps
    const cmds = new Map<Body, Cmd>();
    for (const b of this.bodies.values()) {
      if (b.state === 'track') cmds.set(b, this.steer(b, T));
      b.prev = b.cur;
    }
    let stp = 0;
    for (let k = 0; k < SUB; k++) {
      for (const b of this.bodies.values()) if (b.ctl) this.drive(b, cmds.get(b) ?? WRECK_CMD);
      const s0 = performance.now();
      this.world.step();
      stp += performance.now() - s0;
      for (const b of this.bodies.values()) if (b.ctl) this.afterStep(b);
    }
    for (const b of this.bodies.values()) b.cur = this.read(b);
    // lost ghosts, held ghosts, wrecks at rest
    st.held = 0;
    for (const b of [...this.bodies.values()]) {
      b.age += dt;
      if (b.state === 'track') {
        if (this.check(b, T)) continue;
        // (held up by what it sees: its ghost waits for it)
        if (b.held) { b.car.v = Math.min(b.car.v, Math.max(0, this.forward(b))); st.held++; }
      } else if (b.state === 'wreck') this.settle(b, dt);
    }
    for (const [c, f] of this.fades) { f.t += dt; if (f.t >= f.dur) this.fades.delete(c); }
    st.bodies = this.bodies.size;
    st.tracking = st.wrecks = st.resting = 0;
    for (const b of this.bodies.values()) { if (b.state === 'track') st.tracking++; else if (b.state === 'wreck') st.wrecks++; else st.resting++; }
    st.stepMs = stp;
    st.tickMs = performance.now() - f0;
  }

  // the drawn pose (sim/life.ts drawCars, after the kinematic one is set; a: between the last two ticks): the body's,
  // and a blend back to the kinematic one after a release (or a body put on its ghost again)
  pose(c: Car, a: number) {
    const b = this.bodies.get(c);
    if (b && b.state !== 'rest') this.put(c, b.prev, b.cur, a);
    const f = this.fades.get(c);
    if (f && c.rp) {
      const k = 1 - smooth01((f.t + (a - 1) * TICK) / f.dur);
      c.rp.x += f.dx * k; c.rp.y += f.dy * k; c.rp.z += f.dz * k;
      c.rh = (c.rh ?? 0) + f.dh * k;
      if (!b) c.roll = (c.roll ?? 0) * (1 - k);
    }
  }

  dispose() {
    for (const b of [...this.bodies.values()]) this.remove(b);
    this.terrain.dispose();
    this.world.free();
  }

  // ------------------------------------------------------------------ bodies
  // a body for car c at its kinematic pose, moving at its speed
  private spawn(c: Car, T: Traffic) {
    const K = T.carPose(c, c.s, c.off, this.pose0), build = buildOf(c);
    const sy = Math.sin(K.h / 2), cy = Math.cos(K.h / 2), sx = Math.sin(-K.pitch / 2), cx = Math.cos(-K.pitch / 2);
    const q = { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx }; // (yaw h, then pitch: YXZ)
    const ride = build.ride + 0.05, up = upOf(q.x, q.y, q.z, q.w);
    const at = { x: K.x - this.origin.x + up.x * ride, y: K.y + up.y * ride, z: K.z - this.origin.z + up.z * ride };
    const v = createVehicle(RAPIER, this.world, at, q, build, false);
    v.body.setLinvel({ x: Math.sin(K.h) * c.v, y: 0, z: Math.cos(K.h) * c.v }, true);
    const p0: P7 = { ...at, qx: q.x, qy: q.y, qz: q.z, qw: q.w, ride };
    const b: Body = { car: c, body: v.body, chassis: v.chassis, ctl: v.controller, build, state: 'track', age: 0, still: 0, prev: p0, cur: p0,
      lat: 0, along: 0, vb: c.v, held: false, water: false };
    this.bodies.set(c, b);
    this.byCollider.set(b.chassis.handle, b);
    this.stats.spawned++;
    this.log.push({ t: this.t, kind: 'spawn', id: c.id });
  }

  private remove(b: Body) {
    if (b.ctl) this.world.removeVehicleController(b.ctl);
    this.world.removeRigidBody(b.body);
    this.byCollider.delete(b.chassis.handle);
    this.bodies.delete(b.car);
  }

  // the body goes, the car drawn from its ghost again: the difference blended out (longer the further)
  private release(b: Body, T: Traffic, why: LogKind = 'release') {
    const c = b.car, K = T.carPose(c, c.s, c.off, this.pose0);
    this.put(c, b.cur, b.cur, 1);
    this.remove(b);
    if (why === 'release') this.stats.released++;
    this.log.push({ t: this.t, kind: why, id: c.id });
    const r = c.rp!;
    let dh = (c.rh ?? K.h) - K.h;
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
      undefined, undefined, b.chassis, b.body);
    if (!hit || Math.abs(hit.normal1.y) > 0.6) return Infinity;
    const d = hit.time_of_impact + b.build.half.z;
    b.held = this.byCollider.has(hit.collider.handle) || this.editDist(p.x + this.origin.x + fx * d, p.z + this.origin.z + fz * d) < 2;
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
    c.updateVehicle(STEP, undefined, WHEEL_GROUPS);
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
    return { x: p.x, y: p.y, z: p.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w, ride: b.cur.ride };
  }

  private forward(b: Body) {
    const r = b.body.rotation(), v = b.body.linvel(), f = fwdOf(r.x, r.y, r.z, r.w);
    return (v.x * f.x + v.z * f.z) / (Math.hypot(f.x, f.z) || 1);
  }

  // car c's pose (rp: the ground under the body's origin; rh, pitch, roll) between two body poses
  private put(c: Car, p0: P7, p1: P7, a: number) {
    const l = (u: number, v: number) => u + (v - u) * a;
    const d = p0.qx * p1.qx + p0.qy * p1.qy + p0.qz * p1.qz + p0.qw * p1.qw, s = d < 0 ? -1 : 1;
    let qx = l(p0.qx, p1.qx * s), qy = l(p0.qy, p1.qy * s), qz = l(p0.qz, p1.qz * s), qw = l(p0.qw, p1.qw * s);
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= n; qy /= n; qz /= n; qw /= n;
    const ride = l(p0.ride, p1.ride), up = upOf(qx, qy, qz, qw);
    const x = l(p0.x, p1.x) + this.origin.x - up.x * ride, y = l(p0.y, p1.y) - up.y * ride, z = l(p0.z, p1.z) + this.origin.z - up.z * ride;
    const rp = (c.rp ??= { x, y, z });
    rp.x = x; rp.y = y; rp.z = z;
    // (Euler YXZ, as three.js': heading, then nose down, then roll)
    const m13 = 2 * (qx * qz + qw * qy), m23 = 2 * (qy * qz - qw * qx), m33 = 1 - 2 * (qx * qx + qy * qy);
    const m21 = 2 * (qx * qy + qw * qz), m22 = 1 - 2 * (qx * qx + qz * qz), m31 = 2 * (qx * qz - qw * qy), m11 = 1 - 2 * (qy * qy + qz * qz);
    const ex = Math.asin(-Math.max(-1, Math.min(1, m23)));
    if (Math.abs(m23) < 0.9999999) { c.rh = Math.atan2(m13, m33); c.roll = Math.atan2(m21, m22); } else { c.rh = Math.atan2(-m31, m11); c.roll = 0; }
    c.pitch = -ex;
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
    const x = p.x + this.origin.x, z = p.z + this.origin.z, at: [number, number, number] = [x, p.y, z], d = this.editDist(x, z);
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
    const b = this.bodies.get(c);
    if (!b || b.state !== 'track') return false;
    b.state = 'wreck';
    b.age = 0;
    this.put(b.car, b.cur, b.cur, 1);
    T.takeWheel(b.car);
    b.car.v = 0;
    b.car.brake = 1;
    this.stats.lost++;
    this.log.push({ t: this.t, kind: 'lost', id: b.car.id, why, at: at ?? [b.car.rp!.x, b.car.rp!.y, b.car.rp!.z] });
    return true;
  }

  // a wreck come to rest (or in the water, or too long about it): its pose kept on the car (a parked car); its body
  // fixed where it lies (still met by the bodies near it), or gone in the water
  private settle(b: Body, dt: number) {
    const v = b.body.linvel(), a = b.body.angvel(), p = b.body.translation();
    b.still = Math.hypot(v.x, v.y, v.z) < 0.25 && Math.hypot(a.x, a.y, a.z) < 0.25 ? b.still + dt : 0;
    if (b.still <= WRECK_REST_S && b.age <= WRECK_MAX_S && !b.water) return;
    this.put(b.car, b.cur, b.cur, 1);
    this.log.push({ t: this.t, kind: 'rest', id: b.car.id, at: [p.x + this.origin.x, p.y, p.z + this.origin.z] });
    if (b.water) { this.remove(b); return; }
    this.world.removeVehicleController(b.ctl!);
    b.ctl = null;
    b.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    b.state = 'rest';
  }
}

// a wreck: no engine, the brakes on
const WRECK_CMD: Cmd = { want: 0, vb: 0, ang: 0, stopped: true };
const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// a rotation's up (its y axis) and forward (its z axis)
const upOf = (x: number, y: number, z: number, w: number) => ({ x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) });
const fwdOf = (x: number, y: number, z: number, w: number) => ({ x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) });
