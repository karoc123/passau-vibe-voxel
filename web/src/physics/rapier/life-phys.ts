// EXPERIMENT (?lifephys=1, docs/plans/life-physics.md): the street life's cars near the viewer as real Rapier bodies.
//
// The traffic stays what it is (sim/life.ts: IDM, lanes, signals, junction boxes, all kinematic); within `radius` m of
// the viewer each car (at most `maxBodies`, nearest first) also gets a body, the player's car (car.ts RapierCar: a
// raycast-wheel vehicle) by default, or a cheap box ('box'), that chases the car's simulated place on its path (the
// "ghost": pure pursuit for the steering, the gap along the path for the throttle). The car is drawn where its body is.
// Outside radius * HYST its body goes, and its drawn pose blends back to the ghost's over FADE_S (no pop).
// A body that loses its ghost (fallen into a dug hole, stopped by a placed block, rolled over: more than LOST_* from it)
// is a wreck: out of the traffic (life.takeWheel: parked, drawn where it lies, blocking the cars behind), its body left
// to come to rest, then removed.
// The world's colliders: physics/rapier/terrain.ts (the player's streaming), round every body (reach `reach` m), live
// edits (core/live-edits.ts) rebuilding what they touch.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { LifeBodies, StreetLife } from '../../sim/life';
import type { Car } from '../../sim/types';
import { pt } from '../../sim/path';
import type { Meta } from '../../types';
import { bus, CAR, RapierCar, SPIKE, TUNED, type CarInput } from './car';
import { CHUNK, RapierTerrain, WHEEL_GROUPS, type TerrainOptions } from './terrain';
import { warmUp } from './drive-world';
import { liveEdits } from '../../core/live-edits';
export { liveEdits };

export const STEP = 1 / 60;
const MAX_STEPS = 4;
const HYST = 1.15; // a body goes beyond radius * HYST
const FADE_S = 0.6; // its drawn pose back to the ghost's over this
const LOST_LAT = 3, LOST_ALONG = 10, LOST_Y = 2.5; // m off the ghost: a wreck
const LOST_UP = 0.5; // its up's y under this: rolled over, a wreck
const WRECK_REST_S = 1.2, WRECK_MAX_S = 15;

export interface LifePhysOptions {
  radius: number;
  maxBodies: number;
  model: 'car' | 'box';
  // the car model's assists (car.ts TUNED: step wedges, wall glancing, air) or none (SPIKE)
  assists: boolean;
  reach: number; // m of colliders round each body
  // measure the pairs of bodies touching (costs a query a body a step)
  contacts: boolean;
  // look ahead (a shape cast a body a frame) and slow for what is in the way
  look: boolean;
  // a bounded push towards the ghost across the way (at most this many g; 0: none)
  guide: number;
  // a body that loses its ghost: always a wreck, or a wreck only near an edit (elsewhere it is put back: 'resync')
  lost: 'wreck' | 'resync';
  // which cars get bodies: all within the radius, or only those within `near` m of an edit (the hybrid)
  only: 'all' | 'edits';
  near: number;
}
export const DEFAULTS: LifePhysOptions = { radius: 200, maxBodies: 60, model: 'car', assists: false, reach: 24, contacts: false, look: true, guide: 0, lost: 'wreck', only: 'all', near: 60 };

interface Body {
  car: Car;
  rc: RapierCar | null; // the car model
  box: RAPIER.RigidBody | null; // the box model
  collider: RAPIER.Collider;
  lift: number; // the body's origin over the ground point drawn (rp)
  state: 'track' | 'wreck';
  age: number;
  still: number;
  prevP: THREE.Vector3; curP: THREE.Vector3; prevQ: THREE.Quaternion; curQ: THREE.Quaternion;
  // the tracking error now (m): across, along the path
  lat: number; along: number;
  dbg?: string; // (tools: the last steering's numbers)
  saw?: number | string; // (tools: what look() saw last)
}
interface Fade { dx: number; dy: number; dz: number; dh: number; t: number }

export interface LifePhysStats {
  bodies: number; tracking: number; wrecks: number; spawned: number; released: number; lost: number;
  frameMs: number; stepMs: number; ctlMs: number; terrainMs: number; steps: number;
  // per frame, the most and the sum of the tracking errors (for means): across and along
  latMax: number; latSum: number; alongSum: number; samples: number;
  contactPairs: number; // pairs of bodies touching at the last step
  looks: number; // shape casts looking ahead
  resynced: number; // bodies put back on their ghosts (opts.lost 'resync')
  releasePop: number; // the largest drawn jump a release would have made (m), had it not faded
  notReady: number; // cars within the radius held kinematic: their colliders not built yet
}

export class LifePhysics implements LifeBodies {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly origin: { x: number; z: number };
  readonly opts: LifePhysOptions;
  readonly bodies = new Map<Car, Body>();
  private readonly fades = new Map<Car, Fade>();
  private readonly byCollider = new Map<number, Body>();
  private acc = 0;
  viewer: { x: number; z: number } = { x: 0, z: 0 };
  readonly stats: LifePhysStats = { bodies: 0, tracking: 0, wrecks: 0, spawned: 0, released: 0, lost: 0, frameMs: 0, stepMs: 0, ctlMs: 0, terrainMs: 0, steps: 0,
    latMax: 0, latSum: 0, alongSum: 0, samples: 0, contactPairs: 0, looks: 0, resynced: 0, releasePop: 0, notReady: 0 };
  // what happened to whom (tools: the destruction case)
  readonly log: { t: number; kind: 'spawn' | 'release' | 'lost' | 'rest' | 'resync'; id: number; why?: string; at?: [number, number, number] }[] = [];
  private t = 0;
  // the boxes edited (map metres [x0, z0, x1, z1)), and the cars put back on their ghosts (until when)
  readonly edits: [number, number, number, number][] = [];
  private readonly cool = new Map<Car, number>();
  private readonly unlisten: () => void;
  private readonly tmpA = pt();
  private readonly tmpB = pt();

  constructor(meta: { W: number; D: number; tiles: { N: number }; palette: Meta['palette'] }, focus: { x: number; z: number }, opts: Partial<LifePhysOptions> = {}, terrain: TerrainOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.origin = { x: Math.floor(focus.x / CHUNK) * CHUNK, z: Math.floor(focus.z / CHUNK) * CHUNK };
    this.terrain = new RapierTerrain(RAPIER, this.world, meta, this.origin, { reach: this.opts.reach, needNow: Math.min(12, this.opts.reach), ...terrain });
    const N = meta.tiles.N;
    this.unlisten = liveEdits.listen((tx, tz, node, region) => {
      const box: [number, number, number, number] = region ?? [tx * N, tz * N, tx * N + N, tz * N + N];
      if (node) this.edits.push(box);
      else this.edits.splice(0, this.edits.length, ...this.edits.filter((e) => !(e[0] < box[2] && box[0] < e[2] && e[1] < box[3] && box[1] < e[3])));
    });
  }

  // is world (x, z) within m of an edited box?
  nearEdit(x: number, z: number, m: number) {
    return this.edits.some((e) => x >= e[0] - m && z >= e[1] - m && x < e[2] + m && z < e[3] + m);
  }

  static async load(meta: Meta, focus: { x: number; z: number }, opts: Partial<LifePhysOptions> = {}, terrain: TerrainOptions = {}) {
    await RAPIER.init();
    warmUp();
    return new LifePhysics(meta, focus, opts, terrain);
  }

  owns(c: Car) { return this.bodies.has(c); }

  // One frame (life.update, after the traffic's ticks)
  step(dt: number, life: StreetLife) {
    const f0 = performance.now(), o = this.opts, v = this.viewer, R = o.radius, st = this.stats;
    this.t += dt;
    this.lastLife = life;
    // the cars wanted: within the radius, nearest first (those with a body already: within radius * HYST)
    const near: { c: Car; d: number }[] = [];
    for (const c of life.cars) {
      if (!c.rp || c === life.keep || (this.cool.get(c) ?? 0) > this.t) continue;
      if (o.only === 'edits' && !this.nearEdit(c.rp.x, c.rp.z, this.bodies.has(c) ? o.near * HYST : o.near)) continue;
      const d = Math.hypot(c.rp.x - v.x, c.rp.z - v.z);
      if (d < (this.bodies.has(c) ? R * HYST : R)) near.push({ c, d });
    }
    near.sort((a, b) => a.d - b.d);
    const want = new Set(near.slice(0, o.maxBodies).map((n) => n.c));
    // bodies no longer wanted: released (a tracking one: its drawn pose fades back to its ghost's), or gone with their car
    const alive = new Set(life.cars);
    for (const [c, b] of this.bodies) {
      if (b.state === 'wreck') continue;
      if (!alive.has(c)) { this.remove(b); continue; }
      if (!want.has(c)) this.release(b);
    }
    // the colliders round every body and every car to get one
    const pts: { x: number; z: number; vx?: number; vz?: number }[] = [];
    const who: (Car | null)[] = [];
    for (const b of this.bodies.values()) {
      const p = this.pos(b), lv = (b.rc?.body ?? b.box!).linvel();
      pts.push({ x: p.x, z: p.z, vx: lv.x, vz: lv.z });
      who.push(null);
    }
    for (const c of want) if (!this.bodies.has(c)) { pts.push({ x: c.rp!.x, z: c.rp!.z, vx: Math.sin(c.rh ?? 0) * c.v, vz: Math.cos(c.rh ?? 0) * c.v }); who.push(c); }
    const t0 = performance.now();
    const ready = this.terrain.update(pts);
    st.terrainMs = performance.now() - t0;
    st.notReady = 0;
    for (let i = 0; i < who.length; i++) {
      const c = who[i];
      if (!c) continue;
      if (ready[i]) this.spawn(c); else st.notReady++;
    }
    // the fixed steps
    this.acc += Math.min(dt, 0.25);
    const n = Math.min(MAX_STEPS, Math.floor(this.acc / STEP));
    this.acc = n === MAX_STEPS ? 0 : this.acc - n * STEP;
    let ctl = 0, stp = 0;
    const cmds = new Map<Body, Cmd | null>();
    const c0 = performance.now();
    for (const b of this.bodies.values()) cmds.set(b, b.state === 'track' ? this.steer(b, life) : null);
    ctl += performance.now() - c0;
    for (let i = 0; i < n; i++) {
      for (const b of this.bodies.values()) { b.prevP.copy(b.curP); b.prevQ.copy(b.curQ); }
      const s0 = performance.now();
      for (const b of this.bodies.values()) {
        const m = cmds.get(b)!;
        if (!b.rc) this.boxStep(b, m);
        else if (!m) this.carStep(b, WRECK_CMD);
        else if (o.assists) { b.rc.step(m.input, STEP); this.guide(b, m); } else this.carStep(b, m);
      }
      const s1 = performance.now();
      this.world.step();
      const s2 = performance.now();
      for (const b of this.bodies.values()) {
        b.rc?.afterStep(STEP);
        const body = b.rc?.body ?? b.box!, p = body.translation(), r = body.rotation();
        b.curP.set(p.x + this.origin.x, p.y, p.z + this.origin.z);
        b.curQ.set(r.x, r.y, r.z, r.w);
      }
      const s3 = performance.now();
      ctl += (s1 - s0) + (s3 - s2);
      stp += s2 - s1;
    }
    st.steps = n;
    st.stepMs = stp;
    st.ctlMs = ctl;
    // lost ghosts, wrecks at rest
    for (const b of [...this.bodies.values()]) {
      b.age += dt;
      if (b.state === 'track') this.check(b, life);
      else this.settle(b, dt);
    }
    if (o.contacts && n) this.countContacts();
    for (const [c, f] of this.fades) { f.t += dt; if (f.t >= FADE_S) this.fades.delete(c); }
    st.bodies = this.bodies.size;
    st.tracking = 0;
    for (const b of this.bodies.values()) if (b.state === 'track') st.tracking++;
    st.wrecks = st.bodies - st.tracking;
    st.frameMs = performance.now() - f0;
  }

  // the drawn pose (life.ts drawCars, after the kinematic one is set): the body's, between its last two steps; or
  // fading back to the kinematic one after a release
  pose(c: Car) {
    const b = this.bodies.get(c);
    if (b) {
      const a = Math.min(1, this.acc / STEP);
      const p = b.prevP.clone().lerp(b.curP, a), q = b.prevQ.clone().slerp(b.curQ, a);
      p.add(new THREE.Vector3(0, -this.lift(b), 0).applyQuaternion(q));
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      (c.rp ??= new THREE.Vector3()).copy(p);
      c.rh = e.y; c.pitch = -e.x; c.roll = e.z;
      return;
    }
    const f = this.fades.get(c);
    if (f && c.rp) {
      const k = 1 - smooth01(f.t / FADE_S);
      c.rp.x += f.dx * k; c.rp.y += f.dy * k; c.rp.z += f.dz * k;
      c.rh = (c.rh ?? 0) + f.dh * k;
      c.roll = 0;
    }
  }

  dispose() {
    this.unlisten();
    for (const b of [...this.bodies.values()]) this.remove(b);
    this.terrain.dispose();
    this.world.free();
  }

  // ------------------------------------------------------------------ bodies
  private spawn(c: Car) {
    const o = this.opts, rp = c.rp!, h = c.rh ?? 0, pitch = c.pitch ?? 0;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, h, 0, 'YXZ'));
    const build = c.bus ? bus(c.len) : CAR;
    let b: Body;
    const base = { car: c, state: 'track' as const, age: 0, still: 0, lat: 0, along: 0,
      prevP: new THREE.Vector3(), curP: new THREE.Vector3(), prevQ: q.clone(), curQ: q.clone() };
    if (o.model === 'car') {
      const lift = build.ride + 0.05;
      const at = new THREE.Vector3(0, lift, 0).applyQuaternion(q).add(new THREE.Vector3(rp.x - this.origin.x, rp.y, rp.z - this.origin.z));
      const rc = new RapierCar(RAPIER, this.world, at, { x: q.x, y: q.y, z: q.z, w: q.w }, this.terrain, o.assists ? TUNED : SPIKE, build);
      rc.body.setLinvel({ x: Math.sin(h) * c.v, y: 0, z: Math.cos(h) * c.v }, true);
      b = { ...base, rc, box: null, collider: rc.chassis, lift };
    } else {
      // a box on the ground, its rotation free about y only (no tipping: cheap and calm), sliding without friction,
      // moved by its velocity
      const half = c.bus ? { x: 1.25, y: 1.3, z: c.len / 2 } : { x: 0.85, y: 0.7, z: c.len / 2 - 0.1 };
      const lift = half.y + 0.02;
      const at = new THREE.Vector3(0, lift, 0).applyQuaternion(q).add(new THREE.Vector3(rp.x - this.origin.x, rp.y, rp.z - this.origin.z));
      const box = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q)
        .setLinvel(Math.sin(h) * c.v, 0, Math.cos(h) * c.v).setCanSleep(false).enabledRotations(false, true, false));
      const collider = this.world.createCollider(RAPIER.ColliderDesc.roundCuboid(half.x - 0.2, half.y - 0.2, half.z - 0.2, 0.2)
        .setMass(c.bus ? 11000 : 1200).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min), box);
      b = { ...base, rc: null, box, collider, lift };
    }
    const body = b.rc?.body ?? b.box!, p = body.translation();
    b.curP.set(p.x + this.origin.x, p.y, p.z + this.origin.z);
    b.prevP.copy(b.curP);
    this.bodies.set(c, b);
    this.byCollider.set(b.collider.handle, b);
    this.fades.delete(c);
    this.stats.spawned++;
    this.log.push({ t: this.t, kind: 'spawn', id: c.id });
  }

  private remove(b: Body) {
    if (b.rc) b.rc.dispose(this.world);
    else this.world.removeRigidBody(b.box!);
    this.byCollider.delete(b.collider.handle);
    this.bodies.delete(b.car);
  }

  // out of the radius: the body goes, the car drawn from its ghost again, the difference faded out
  private release(b: Body) {
    const c = b.car, A = this.tmpA, B = this.tmpB, life = this.lastLife;
    this.remove(b);
    this.stats.released++;
    this.log.push({ t: this.t, kind: 'release', id: c.id });
    if (!life || !c.rp) return;
    // (the kinematic pose now, as drawCars will compute it: both axles on the path)
    life.pathPoint(c, c.s, A);
    life.pathPoint(c, c.s - (c.len - 1.2), B);
    const kx = (A.x + B.x) / 2, kz = (A.y + B.y) / 2, ky = Math.max(A.z, B.z), kh = Math.atan2(A.x - B.x, A.y - B.y);
    let dh = (c.rh ?? kh) - kh;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const f: Fade = { dx: c.rp.x - kx, dy: c.rp.y - ky, dz: c.rp.z - kz, dh, t: 0 };
    this.stats.releasePop = Math.max(this.stats.releasePop, Math.hypot(f.dx, f.dy, f.dz));
    this.fades.set(c, f);
  }

  private lastLife: StreetLife | null = null;

  // What chases the ghost (its place on the path: the middle between the axles, as drawn, and the path ahead): the speed
  // wanted (closing the gap along the path in about a second; less if something is in the way: look()) and the front
  // wheels' angle (pure pursuit), as a command for the AI controller and an input for the player's (opts.assists)
  private steer(b: Body, life: StreetLife): Cmd {
    const c = b.car, A = this.tmpA, B = this.tmpB, body = b.rc?.body ?? b.box!;
    const p = body.translation(), r = body.rotation(), lv = body.linvel();
    const px = p.x + this.origin.x, pz = p.z + this.origin.z;
    const sMid = c.s - (c.len - 1.2) / 2;
    life.pathPoint(c, sMid, A);
    life.pathPoint(c, sMid + 1, B);
    const l = Math.hypot(B.x - A.x, B.y - A.y) || 1, tx = (B.x - A.x) / l, tz = (B.y - A.y) / l;
    const gx = A.x, gz = A.y, dx = A.x - px, dz = A.y - pz;
    b.along = dx * tx + dz * tz; // > 0: the body behind its ghost
    b.lat = dx * tz - dz * tx;
    const st = this.stats;
    st.latMax = Math.max(st.latMax, Math.abs(b.lat));
    st.latSum += Math.abs(b.lat); st.alongSum += Math.abs(b.along); st.samples++;
    const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y), fl = Math.hypot(fx, fz) || 1;
    const vb = (lv.x * fx + lv.z * fz) / fl;
    const Ld = 2.5 + Math.abs(vb) * 0.45;
    life.pathPoint(c, sMid - b.along + Ld, B);
    let a = Math.atan2(B.x - px, B.y - pz) - Math.atan2(fx, fz);
    a = Math.atan2(Math.sin(a), Math.cos(a));
    // (pure pursuit: the arc through the point Ld ahead, the wheels' angle for it)
    const wb = c.bus ? c.len - 5.4 : 2.65;
    const ang = Math.max(-AI_STEER, Math.min(AI_STEER, Math.atan(wb * 2 * Math.sin(a) / Ld)));
    let want = Math.max(0, Math.min(c.v + 6, c.v + b.along * 1.0));
    // (along the path's grade: the road rising ahead is not in the way)
    const grade = (B.z - A.z) / Math.max(1, Math.hypot(B.x - A.x, B.y - A.y));
    const clear = this.look(b, fx / fl, fz / fl, grade, Math.abs(vb));
    if (clear < Infinity) want = Math.min(want, Math.sqrt(Math.max(0, 2 * 4 * (clear - 1.5))));
    const dv = want - vb;
    const stopped = want < 0.3 && c.v < 0.05;
    b.dbg = `hb ${(Math.atan2(fx, fz) * 57.3).toFixed(0)} ht ${(Math.atan2(tx, tz) * 57.3).toFixed(0)} a ${(a * 57.3).toFixed(0)} ws ${(ang * 57.3).toFixed(0)} vb ${vb.toFixed(1)} want ${want.toFixed(1)} clear ${clear.toFixed(1)} saw ${clear < Infinity ? b.saw : '-'}`;
    return {
      want, vb, ang, stopped, gx, gz, tx, tz, gv: c.v,
      input: { gas: stopped ? 0 : Math.max(0, Math.min(1, dv * 0.6)), brake: stopped ? 1 : Math.max(0, Math.min(1, -dv * 0.4)),
        steer: Math.max(-1, Math.min(1, -a * 2.5)), handbrake: stopped && Math.abs(vb) < 0.3 },
    };
  }

  // the free way ahead of a body (m; Infinity: none within its stopping distance and a bit): its box swept forward, a
  // little up (not the road rising ahead); what it meets with a face across the way (a car, a wall, a placed block)
  private look(b: Body, fx: number, fz: number, grade: number, v: number) {
    if (!this.opts.look) return Infinity;
    const body = b.rc?.body ?? b.box!, p = body.translation();
    const reach = 2 + v * 1.0 + v * v / 8, n = Math.hypot(1, grade);
    // (lifted LOOK_UP: a kerb, a terrace's step or the voxels' stairs of a street without caps are not in the way)
    const hit = this.world.castShape({ x: p.x, y: p.y + LOOK_UP, z: p.z }, body.rotation(), { x: fx / n, y: grade / n, z: fz / n }, b.collider.shape, 0.05, reach, true,
      undefined, undefined, b.collider, body);
    this.stats.looks++;
    if (!hit || Math.abs(hit.normal1.y) > 0.6) return Infinity;
    b.saw = this.byCollider.get(hit.collider.handle)?.car.id ?? `T${hit.collider.shape.type}`;
    return hit.time_of_impact;
  }

  // The AI controller on the car model's chassis and wheels (no assists): the wheels' angle, the engine or the brakes
  // for the speed wanted; the guide (opts.guide: a bounded push towards the ghost across the way, at most that many g)
  private carStep(b: Body, m: Cmd) {
    const rc = b.rc!, c = rc.controller, B = rc.build, dv = m.want - m.vb;
    const engine = m.stopped ? 0 : dv > 0 ? Math.min(1, dv * 0.8) * B.engine : 0;
    const brake = m.stopped ? B.brake * 2 : dv < -0.3 ? Math.min(1, -dv * 0.4) * B.brake : B.brake * 0.02;
    for (let i = 0; i < c.numWheels(); i++) {
      const front = B.wheels[i].front;
      c.setWheelSteering(i, front ? m.ang : 0);
      c.setWheelEngineForce(i, front ? 0 : engine);
      c.setWheelBrake(i, brake);
    }
    c.updateVehicle(STEP, undefined, WHEEL_GROUPS);
    this.guide(b, m);
  }

  private guide(b: Body, m: Cmd) {
    const g = this.opts.guide;
    if (!g || b.state !== 'track') return;
    const body = b.rc?.body ?? b.box!, v = body.linvel(), mass = body.mass();
    // (across the way only: the ghost's lateral offset, damped by the body's lateral speed relative to the path)
    const vl = v.x * m.tz - v.z * m.tx;
    let f = mass * (4 * b.lat - 3 * vl);
    const lim = mass * 9.81 * g;
    f = Math.max(-lim, Math.min(lim, f)) * STEP;
    body.applyImpulse({ x: m.tz * f, y: 0, z: -m.tx * f }, true);
  }

  // the box: on the ground, its horizontal velocity eased towards the ghost's (plus the gap to it, both ways: it slides
  // sideways as no car would), its yaw towards the path's; in the air gravity only (and its contacts always)
  private boxStep(b: Body, m: Cmd | null) {
    const body = b.box!, v = body.linvel(), r = body.rotation();
    if (!m) { body.setLinvel({ x: v.x * 0.98, y: v.y, z: v.z * 0.98 }, true); return; }
    const p = body.translation();
    const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }), b.lift + 0.3, true, undefined, undefined, b.collider);
    if (!hit) return;
    const gap = Math.max(0, Math.min(1, (m.want + 0.01) / (m.gv + Math.max(0, b.along) + 0.01)));
    const tvx = (m.tx * m.gv + (m.gx - (p.x + this.origin.x)) * 2) * gap, tvz = (m.tz * m.gv + (m.gz - (p.z + this.origin.z)) * 2) * gap;
    const k = Math.min(1, STEP * 6);
    body.setLinvel({ x: v.x + (tvx - v.x) * k, y: v.y, z: v.z + (tvz - v.z) * k }, true);
    const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    let dh = Math.atan2(m.tx, m.tz) - Math.atan2(fx, fz);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    body.setAngvel({ x: 0, y: Math.max(-1.5, Math.min(1.5, dh * 4)), z: 0 }, true);
  }

  private pos(b: Body) { const p = (b.rc?.body ?? b.box!).translation(); return { x: p.x + this.origin.x, y: p.y, z: p.z + this.origin.z }; }

  private lift(b: Body) { return b.rc ? b.rc.ride : b.lift; }

  // a body too far from its ghost (or rolled over): a wreck, out of the traffic
  private check(b: Body, life: StreetLife) {
    const c = b.car, body = b.rc?.body ?? b.box!, r = body.rotation(), up = 1 - 2 * (r.x * r.x + r.z * r.z);
    const p = this.pos(b);
    life.pathPoint(c, c.s - (c.len - 1.2) / 2, this.tmpA);
    const dy = this.tmpA.z - (p.y - this.lift(b));
    let why = '';
    if (Math.abs(b.lat) > LOST_LAT) why = `lat ${b.lat.toFixed(1)}`;
    else if (Math.abs(b.along) > LOST_ALONG) why = `along ${b.along.toFixed(1)}`;
    else if (Math.abs(dy) > LOST_Y) why = `dy ${dy.toFixed(1)}`;
    else if (up < LOST_UP) why = `up ${up.toFixed(2)}`;
    else if (b.rc?.status === 'water') why = 'water';
    if (!why) return;
    if (this.opts.lost === 'resync' && !this.nearEdit(p.x, p.z, RESYNC_R)) {
      // (not the world's doing: a junction tighter than it can steer, a snag on the voxels, a push from behind; put back)
      this.release(b);
      this.cool.set(c, this.t + RESYNC_COOL_S);
      this.stats.resynced++;
      this.log.push({ t: this.t, kind: 'resync', id: c.id, why, at: [p.x, p.y, p.z] });
      return;
    }
    b.state = 'wreck';
    b.age = 0;
    // (out of the traffic: parked where it is drawn, the cars behind wait for it; its pose ours until it rests)
    life.takeWheel(c);
    c.v = 0;
    c.brake = 1;
    this.stats.lost++;
    this.log.push({ t: this.t, kind: 'lost', id: c.id, why, at: [p.x, p.y, p.z] });
  }

  private settle(b: Body, dt: number) {
    const body = b.rc?.body ?? b.box!, v = body.linvel(), a = body.angvel(), p = this.pos(b);
    b.still = Math.hypot(v.x, v.y, v.z) < 0.25 && Math.hypot(a.x, a.y, a.z) < 0.25 ? b.still + dt : 0;
    const far = Math.hypot(p.x - this.viewer.x, p.z - this.viewer.z) > this.opts.radius * 1.5;
    if (b.still > WRECK_REST_S || b.age > WRECK_MAX_S || far || b.rc?.status === 'water') {
      this.pose(b.car); // (drawn where it lies from now on: a parked car)
      this.remove(b);
      this.log.push({ t: this.t, kind: 'rest', id: b.car.id, at: [p.x, p.y, p.z] });
    }
  }

  private countContacts() {
    let n = 0;
    for (const b of this.bodies.values()) {
      this.world.contactPairsWith(b.collider, (other) => {
        const o = this.byCollider.get(other.handle);
        if (!o || o.collider.handle < b.collider.handle) return;
        this.world.contactPair(b.collider, other, (m) => { if (m.numContacts() > 0) n++; });
      });
    }
    this.stats.contactPairs = n;
  }
}

// the front wheels' most angle for the AI controller (the player's: 0.55, less at speed)
const AI_STEER = 0.65;
const LOOK_UP = 0.7; // m: look() sees what stands this much over a body's bottom
const RESYNC_R = 12; // m: a body lost further than this from any edit is put back on its ghost (opts.lost 'resync')
const RESYNC_COOL_S = 8; // ... and gets no body again for this long
interface Cmd { want: number; vb: number; ang: number; stopped: boolean; gx: number; gz: number; tx: number; tz: number; gv: number; input: CarInput }
// a wreck: no engine, the brakes on (not car.ts step's brake: reverse when slow)
const WRECK_CMD: Cmd = { want: 0, vb: 0, ang: 0, stopped: true, gx: 0, gz: 0, tx: 0, tz: 1, gv: 0, input: { gas: 0, brake: 1, steer: 0, handbrake: true } };
const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
