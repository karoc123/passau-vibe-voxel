// The player's speedboat (nav/boat.ts), its motion: an arcade model, not a simulator. A hull on the water with a
// heading, a velocity on the water's plane and a yaw rate, advanced at a fixed step; thrust, drag and the hull's grip
// across its length are the whole of it. The hull leans into turns, lifts its nose when it gathers way and bobs when
// it lies still (drawn only: the motion is flat). It stays on the water: a step that would put any of its outline
// points on land, against a quay wall or a bridge pier (anything solid from just under the waterline to its top) is not
// taken; it bounces off along the shore's normal and slides on. Under bridges it passes (what is over its top does not
// count).
//
// Pure: no DOM, no three.js; the world through one query (BoatWorld, which VoxelCollision.waterColumn answers). Runs
// in node (tools/boat.mjs, checks/boat-checks.ts) as in the viewer.

import { FixedStep } from '../../core/fixed-step';
import { frozen } from '../../core/frozen';
import { SafeTrail } from '../../core/safe-trail';
import { lerpAngle } from '../../core/vec';
import type { BoatInput } from '../contract/inputs';
import type { CraftSpot } from '../contract/commands';
import type { CraftCore } from './craft-core';

// (its input, BoatInput: contract/inputs.ts)
export const NO_BOAT_INPUT: BoatInput = { throttle: 0, steer: 0, drift: false };

// a column of the world as the boat sees it: the top of its water (-1: none) and whether anything solid is in it
// between y0 and y1; null: not loaded yet
export interface BoatWorld {
  waterColumn(x: number, z: number, y0: number, y1: number): { water: number; blocked: boolean } | null;
}

export interface BoatPose { x: number; y: number; z: number; h: number }
// as drawn: with the pitch (+: nose up), the roll (+: the right side down) and the heave of the bobbing
export interface BoatDrawn extends BoatPose { pitch: number; roll: number }
export type BoatEvent = { kind: 'bump'; speed: number };

// all the numbers, in one place: read-only (DEFAULT_TUNING.boat, sim/tuning.ts); a boat given others differs
export const BOAT = frozen({
  length: 6.4, beam: 2.3, // m: the hull's outline (what collides)
  draft: 0.5, freeboard: 2.0, // m under and over the waterline that must be clear (a bridge's deck over it does not count)
  step: 1.2, // m: the most the water's top may differ from where the boat floats (a weir's drop is a wall)
  vmax: 18.5, // m/s at full throttle (67 km/h)
  vrev: 5, // m/s backwards
  thrust: 6.5, // m/s² at rest, full throttle
  revThrust: 3,
  brake: 7, // m/s²: throttle back while going forwards
  linDrag: 0.08, // /s
  turn: 0.85, // rad/s: the most yaw rate (at ~6 m/s and up a little less towards top speed)
  turnFull: 6, // m/s: from this speed the full turn
  turnIdle: 0.3, // share of the turn at rest (the outboard turned, idling)
  turnResponse: 5, // /s: the yaw rate follows the wheel
  grip: 2.6, // /s: the speed across the hull decays at this rate
  driftGrip: 0.9,
  driftTurn: 1.35, // the turn while drifting, times
  driftDrag: 0.15, // /s more drag while drifting with the wheel over
  driftCarry: 0.7, // of the speed across the hull lost to its grip while drifting, turned into speed along it
  coastDrag: 0.5, // m/s² more with the throttle let go (it settles and stops)
  restitution: 0.3, // of the speed into a shore
  wallFriction: 0.8, // of the speed along it kept in a bump
});
export type BoatTuning = typeof BOAT;

const SAFE_EVERY = 0.5, SAFE_KEEP = 20;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export class BoatMotion {
  x = 0; z = 0; y = 0; h = 0; // position (y: the waterline), heading (0: +z, pi/2: +x; as the cars)
  vx = 0; vz = 0; yaw = 0; // m/s on the water, rad/s (+: turning left, as h grows)
  pitch = 0; roll = 0; t = 0;
  waiting = false; // a column under it not loaded: the step held
  private accel = 0;
  private bumpT = -1;
  // recent poses on open water (every SAFE_EVERY s of steps, the first at 0.5 s), for unstick()
  private readonly safe = new SafeTrail<BoatPose>(SAFE_EVERY, SAFE_KEEP);
  private readonly outline: [number, number][];

  // cfg: its numbers (Tuning.boat)
  constructor(readonly cfg: BoatTuning = BOAT) {
    this.outline = outline(cfg);
    this.safe.wait(0);
  }

  reset(p: BoatPose) {
    this.place(p);
    this.safe.clear({ ...p }, this.t);
  }

  // standing still at p
  private place(p: BoatPose) {
    Object.assign(this, { x: p.x, y: p.y, z: p.z, h: p.h, vx: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, accel: 0, waiting: false });
  }

  get pose(): BoatPose { return { x: this.x, y: this.y, z: this.z, h: this.h }; }
  // m/s along the hull (-: backwards)
  get speed() { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }
  get kmh() { return this.speed * 3.6; }

  // the hull as drawn: bobbing on the spot, slapping at speed (a function of the clock, not the motion)
  drawn(): BoatDrawn {
    const t = this.t, v = Math.abs(this.speed), calm = 1 - clamp(v / 8, 0, 0.7);
    const heave = calm * (0.06 * Math.sin(t * 1.7) + 0.03 * Math.sin(t * 2.9 + 1)) + (1 - calm) * 0.02 * Math.sin(t * 11);
    return { x: this.x, y: this.y + heave, z: this.z, h: this.h,
      pitch: this.pitch + calm * 0.018 * Math.sin(t * 1.3 + 0.5) + (1 - calm) * 0.006 * Math.sin(t * 9.1),
      roll: this.roll + calm * 0.025 * Math.sin(t * 1.1 + 2) };
  }

  // One fixed step of dt s; 'loading': not taken (a column it needs not in yet)
  step(input: BoatInput, dt: number, world: BoatWorld): BoatEvent[] | 'loading' {
    const B = this.cfg, events: BoatEvent[] = [];
    const sh = Math.sin(this.h), ch = Math.cos(this.h);
    // along the hull and across it (right: -cos h, sin h)
    let u = this.vx * sh + this.vz * ch, s = -this.vx * ch + this.vz * sh;
    const u0 = u, thr = clamp(input.throttle, -1, 1), steer = clamp(input.steer, -1, 1);
    // thrust, drag (the quadratic drag set so that full throttle settles at vmax)
    const quad = (0.6 * B.thrust - B.linDrag * B.vmax) / (B.vmax * B.vmax);
    let a = -B.linDrag * u - quad * u * Math.abs(u);
    if (thr > 0) a += u < -0.3 ? B.brake * thr : B.thrust * thr * (1 - 0.4 * (u / B.vmax) ** 2);
    else if (thr < 0) {
      if (u > 0.5) a += B.brake * thr;
      else a += B.revThrust * thr * clamp(1 + u / B.vrev, 0, 1);
    }
    const drifting = input.drift && Math.abs(u) > 2;
    if (drifting) a -= B.driftDrag * Math.abs(steer) * u;
    if (thr === 0) a -= Math.sign(u) * Math.min(B.coastDrag, Math.abs(u) / dt);
    u += a * dt;
    if (thr === 0 && Math.abs(u) < 0.05) u = 0;
    const lost = s * (1 - Math.exp(-(drifting ? B.driftGrip : B.grip) * dt));
    s -= lost;
    if (drifting) u += Math.sign(u) * B.driftCarry * Math.abs(lost);
    // the turn: works better with way on, reversed going backwards (as a car's), tighter drifting
    const av = Math.abs(u), share = Math.max(B.turnIdle, Math.min(1, av / B.turnFull)) * (1 - 0.2 * clamp((av - B.turnFull) / (B.vmax - B.turnFull), 0, 1));
    const want = -steer * B.turn * share * (u < -0.3 ? -1 : 1) * (input.drift ? B.driftTurn : 1);
    this.yaw += (want - this.yaw) * (1 - Math.exp(-B.turnResponse * dt));
    const h1 = wrap(this.h + this.yaw * dt);
    // the velocity stays where it pointed as the hull turns under it: what is across the new heading slides off (grip)
    this.vx = u * sh - s * ch; this.vz = u * ch + s * sh;

    // the move, kept on the water
    const fit = this.fits(world, this.x + this.vx * dt, this.z + this.vz * dt, h1);
    if (fit === null) { this.waiting = true; return 'loading'; }
    this.waiting = false;
    if (fit) { this.x += this.vx * dt; this.z += this.vz * dt; this.h = h1; }
    else {
      // bounced off the shore along its normal (where the water is round the points that met it), then slid on
      const n = this.normal(world, this.x + this.vx * dt, this.z + this.vz * dt, h1);
      const vn = this.vx * n[0] + this.vz * n[1];
      if (vn < 0) {
        const tx = this.vx - vn * n[0], tz = this.vz - vn * n[1];
        this.vx = tx * B.wallFriction - B.restitution * vn * n[0];
        this.vz = tz * B.wallFriction - B.restitution * vn * n[1];
        if (-vn > 1.2 && this.t - this.bumpT > 0.3) { events.push({ kind: 'bump', speed: -vn }); this.bumpT = this.t; }
      }
      // the hull swung round along the shore (the way it was going along it), so that it slides on rather than pushing in
      const along = -n[1] * Math.sin(this.h) + n[0] * Math.cos(this.h) >= 0 ? 1 : -1;
      const toTangent = wrap(Math.atan2(-n[1] * along, n[0] * along) - this.h);
      this.yaw = vn < -0.3 && Math.abs(toTangent) < 1.4 ? clamp(toTangent * 2.5, -1.2, 1.2) : this.yaw * 0.5;
      const nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
      if (this.fits(world, nx, nz, h1)) { this.x = nx; this.z = nz; this.h = h1; }
      else if (this.fits(world, nx, nz, this.h)) { this.x = nx; this.z = nz; this.yaw = 0; }
      else if (this.fits(world, this.x, this.z, h1)) { this.h = h1; this.vx *= 0.5; this.vz *= 0.5; }
      else {
        // wedged (or put down overlapping): eased out along the normal
        this.yaw = 0;
        const ex = this.x + n[0] * 0.05, ez = this.z + n[1] * 0.05;
        if (vn >= 0 || !this.fits(world, this.x, this.z, this.h)) { this.x = ex; this.z = ez; }
        this.vx *= 0.3; this.vz *= 0.3;
      }
    }
    // the waterline follows the water's top under the middle
    const c = world.waterColumn(this.x, this.z, -1e9, -1e9);
    if (c && c.water >= 0) this.y += (c.water - this.y) * (1 - Math.exp(-4 * dt));

    // drawn: the nose up as it gathers way (most at the hump, before it planes) and by the acceleration; leaning into
    // the turn
    const v = Math.abs(this.speed);
    this.accel += ((this.speed - u0) / dt - this.accel) * (1 - Math.exp(-3 * dt));
    const hump = 0.085 * Math.exp(-(((v - 7) / 5) ** 2)) + 0.035 * Math.min(1, v / 10);
    const pitchTo = clamp(hump * Math.sign(this.speed || 1) + 0.012 * this.accel, -0.08, 0.16);
    this.pitch += (pitchTo - this.pitch) * (1 - Math.exp(-3 * dt));
    const rollTo = clamp(-this.yaw * this.speed * 0.022, -0.22, 0.22);
    this.roll += (rollTo - this.roll) * (1 - Math.exp(-4 * dt));
    this.t += dt;
    if (this.safe.due(this.t) && fit) this.safe.push(this.pose, this.t);
    return events;
  }

  // The outline's points: the bow, the shoulders, the middle and the stern's corners, each in open water at the boat's
  // level with nothing solid from under the hull to over it. null: a column not loaded
  fits(world: BoatWorld, x: number, z: number, h: number, y = this.y): boolean | null {
    const sh = Math.sin(h), ch = Math.cos(h);
    const B = this.cfg;
    for (const [a, b] of this.outline) {
      // (a across, +: left; b along, +: forwards)
      const px = x + a * ch + b * sh, pz = z - a * sh + b * ch;
      const c = world.waterColumn(px, pz, y - B.draft, y + B.freeboard);
      if (!c) return null;
      if (c.blocked || c.water < 0 || Math.abs(c.water - y) > B.step) return false;
    }
    return true;
  }

  // the shore's normal near the outline at (x, z, h): from the points that do not fit, towards the open water round them
  private normal(world: BoatWorld, x: number, z: number, h: number): [number, number] {
    const sh = Math.sin(h), ch = Math.cos(h);
    let nx = 0, nz = 0;
    for (const [a, b] of this.outline) {
      const px = x + a * ch + b * sh, pz = z - a * sh + b * ch;
      if (this.open(world, px, pz)) continue;
      for (let k = 0; k < 12; k++) {
        const t = k * Math.PI / 6, dx = Math.cos(t), dz = Math.sin(t);
        if (this.open(world, px + dx * 1.5, pz + dz * 1.5)) { nx += dx; nz += dz; }
      }
    }
    const l = Math.hypot(nx, nz);
    if (l > 1e-6) return [nx / l, nz / l];
    const v = Math.hypot(this.vx, this.vz);
    return v > 1e-6 ? [-this.vx / v, -this.vz / v] : [-Math.sin(h), -Math.cos(h)];
  }

  private open(world: BoatWorld, x: number, z: number) {
    const B = this.cfg, c = world.waterColumn(x, z, this.y - B.draft, this.y + B.freeboard);
    return !!c && !c.blocked && c.water >= 0 && Math.abs(c.water - this.y) <= B.step;
  }

  // T: back on open water, standing still: where it is if it fits, else the newest recent pose that fits, else the
  // nearest spot found round it. false: nothing loaded there yet
  unstick(world: BoatWorld): boolean {
    const here = findSpawn(world, this.x, this.z, this.h, 0, this.cfg);
    const back = here ?? this.safe.get(this.safe.find((p) => !!this.fits(world, p.x, p.z, p.h, p.y))) ?? findSpawn(world, this.x, this.z, this.h, 60, this.cfg);
    if (!back) return false;
    this.place(back);
    return true;
  }
}

// the outline's points (across, along) in metres
const outline = (B: BoatTuning): [number, number][] => {
  const a = B.beam / 2, b = B.length / 2;
  return [[0, b], [a * 0.75, b * 0.55], [-a * 0.75, b * 0.55], [a, 0], [-a, 0], [a, -b * 0.6], [-a, -b * 0.6], [a * 0.9, -b], [-a * 0.9, -b]];
};

// Where the boat can be put down near (x, z): the nearest spot within `radius` m where its outline fits on open water,
// facing `h` if it can (else turned up to a half turn either way), for a boat of `cfg`. null: none (or not loaded there)
export function findSpawn(world: BoatWorld, x: number, z: number, h: number, radius: number, cfg: BoatTuning = BOAT): BoatPose | null {
  const probe = new BoatMotion(cfg);
  const turns = [0, 0.5, -0.5, 1, -1, 1.57, -1.57, 2.4, -2.4, Math.PI];
  for (let r = 0; r <= radius; r += 2) {
    const n = r === 0 ? 1 : Math.max(8, Math.round(2 * Math.PI * r / 2));
    for (let k = 0; k < n; k++) {
      const t = (k / n) * 2 * Math.PI, px = Math.floor(x + r * Math.cos(t)) + 0.5, pz = Math.floor(z + r * Math.sin(t)) + 0.5;
      const c = world.waterColumn(px, pz, -1e9, -1e9);
      if (!c || c.water < 0) continue;
      for (const dh of turns) {
        if (probe.fits(world, px, pz, h + dh, c.water)) return { x: px, y: c.water, z: pz, h: wrap(h + dh) };
      }
    }
  }
  return null;
}

// The boat as WorldSim steps it (craft-core.ts): its motion at 1/120 s (four a world tick); the bumps of the steps
// since its pilot last read them. Its collision: the drone's cube and look-ahead (VoxelCollision's). Drawn between the
// world's last two ticks (the hull as drawn at each, its heading, pitch and roll the shorter way).
export class BoatCore implements CraftCore<BoatInput, BoatEvent, BoatDrawn> {
  readonly motion: BoatMotion;
  readonly clock = new FixedStep(1 / 120, 12, 0.1);
  readonly reach = {};
  readonly neutral = NO_BOAT_INPUT;
  readonly events: BoatEvent[] = [];

  // drawn: the hull as drawn at the world tick's start
  private from: BoatDrawn = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };

  constructor(cfg: BoatTuning = BOAT) { this.motion = new BoatMotion(cfg); }

  reset(spot: CraftSpot) {
    this.motion.reset({ x: spot.x, y: spot.y ?? 0, z: spot.z, h: spot.h });
    this.keep();
  }

  keep() { this.from = this.motion.drawn(); }

  step(input: BoatInput, dt: number, world: BoatWorld) {
    const ev = this.motion.step(input, dt, world);
    if (ev === 'loading') return false;
    this.events.push(...ev);
    return true;
  }

  get pose() { return this.motion.pose; }
  get velocity() { return { x: this.motion.vx, y: 0, z: this.motion.vz }; }
  drawn(alpha: number): BoatDrawn {
    const a = this.from, b = this.motion.drawn(), t = Math.min(1, Math.max(0, alpha)), l = (u: number, v: number) => u + (v - u) * t;
    return { x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z), h: lerpAngle(a.h, b.h, t), pitch: lerpAngle(a.pitch, b.pitch, t), roll: lerpAngle(a.roll, b.roll, t) };
  }

  unstick(world: BoatWorld) {
    if (!this.motion.unstick(world)) return false;
    this.keep();
    return true;
  }
}
