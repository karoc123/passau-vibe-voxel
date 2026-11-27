import { frozen } from '../../core/frozen';
import { FixedStep } from '../../core/fixed-step';
import { SafeTrail } from '../../core/safe-trail';
import { add, addScaled, copy, cross, dot, length, lengthSq, normalize, scale, set, vec3, type Vec3 } from '../../core/vec';
import type { PlaneEvent, PlaneFlightState, PlaneState } from '../contract/crafts';
import type { PlaneInput } from '../contract/inputs';
import type { Sweep } from './sweep';
import { waterTop, type WaterColumns } from '../river';

// The small floatplane's flight (plane.ts draws it and reads the input; web/tools/plane.mjs checks it headless). No DOM,
// no scene, no three.js (plain { x, y, z }: core/vec.ts; tools/core-deps.mjs): input in, pose out, the world reached through PlaneWorld (the collision's sweep and surface, the rivers'
// water). A point with heading, flight-path angle, bank and airspeed, stepped at a fixed rate. Not a simulator, but its
// speed is energy: thrust (the throttle, a lever the player sets) against drag (parasitic, and induced by the lift it
// pulls) and the path's slope (climbing costs speed, diving gains it). Lift is bounded by speed: the load factor it can
// pull is (v / V_STALL)^2, faded to nothing over the last STALL_FADE below the stall speed, so too slow it sinks and its
// nose drops, and diving or throttle recovers it. Letting go of the stick levels the wings (and, gently, the path);
// nothing else steers for the player: no ground guard, no turning back at the map's edge (a plain wall there).
// On water (the voxels' water runs, VoxelCollision.waterColumn): touched slowly, shallowly and nearly wings-level it floats
// and taxis; past V_TAKEOFF with the stick pulled it flies again. Too fast or steep onto water, or into anything else
// but a shallow skim off a top face, is a crash: CRASH_S later it is back at a safe pose at least SAFE_AGE old.
//
// Conventions: heading 0 flies +z, forward (sin h, 0, cos h); turn +1 is right (bank > 0 right wing down; the heading
// decreases); pitch +1 is nose up (plane.ts maps the flight convention and "Invert pitch" onto it).

const D = Math.PI / 180;
// Read-only (DEFAULT_TUNING.plane, sim/tuning.ts); tools/plane.mjs --set flies a copy that differs.
export const PLANE = frozen({
  STEP: 1 / 60, // s, the fixed step
  MAX_STEPS: 6, // a frame
  G: 9.81,
  // engine: full-throttle thrust (m/s^2); the engine follows the lever at SPOOL /s
  THRUST: 5.2,
  SPOOL: 2.5,
  // drag (m/s^2): CD0 v^2 + KI (n g)^2 / v^2 -- top speed level at full throttle ~68 m/s (245 km/h), half throttle ~47
  CD0: 0.0011,
  KI: 5,
  V_STALL: 24, // m/s (86 km/h): the load factor 1 is the most lift gives here
  STALL_FADE: 0.3, // ... and below it lift fades out over this share of V_STALL (none under 0.7 V_STALL)
  N_MAX: 3.5, // the most load factor ever pulled
  V_MIN: 6,
  V_MAX: 100, // (a dive's limit)
  // bank: towards turn x BANK_MAX at BANK_FOLLOW /s, at most ROLL_RATE; hands off back to level at BANK_LEVEL /s. The
  // roll rate itself builds up and dies down at most ROLL_ACCEL (no snap into or out of a roll)
  BANK_MAX: 65 * D,
  BANK_FOLLOW: 3,
  BANK_LEVEL: 1.5,
  ROLL_RATE: 80 * D,
  ROLL_ACCEL: 300 * D, // rad/s^2
  // pitch: the stick asks the path to turn up or down at PITCH_RATE; hands off it levels at PITCH_LEVEL /s, at most
  // PITCH_LEVEL_RATE (gently). The elevator: the path's turn rate follows what is asked at PITCH_FOLLOW /s, changing
  // at most PITCH_ACCEL, so the load factor, the nose and then the path build up over ~0.5 s, never in a step
  PITCH_RATE: 26 * D,
  PITCH_LEVEL: 0.35,
  PITCH_LEVEL_RATE: 10 * D,
  PITCH_FOLLOW: 5,
  PITCH_ACCEL: 60 * D, // rad/s^2
  GAMMA_MAX: 80 * D,
  ALPHA_STALL: 14 * D, // the nose over the path at the stall (drawn only)
  // the drawn nose over the path follows the lift's at ALPHA_FOLLOW /s (the airframe's inertia), at most ALPHA_RATE
  // (takeoff, touchdown, skim: no snap)
  ALPHA_FOLLOW: 10,
  ALPHA_RATE: 40 * D, // rad/s
  // the ceiling: meta.H + CEILING; thrust fades over the last CEILING_FADE m below it
  CEILING: 450,
  CEILING_FADE: 150,
  EDGE: 20, // m: the map's edge wall stands this far inside
  // the collision: the fuselage's cube (half side), tiles fetched this far ahead (s)
  RADIUS: 1.5,
  HORIZON: 3.5,
  // the wings: cubes of WING_R at WING_AT of the way out to each tip, the tip WING_X across, WING_Y up and WING_Z along
  // from the fuselage's cube's centre; swept with it, so a tip met is met as the fuselage would be (a crash, a skim)
  WING_X: 4.45,
  WING_Y: 1.35,
  WING_Z: 0.9,
  WING_R: 0.3,
  // a top face met sinking slower than SKIM_SINK: a bounce (path at least SKIM_PITCH up, speed x SKIM_KEEP), else a crash
  SKIM_SINK: 4,
  SKIM_PITCH: 6 * D,
  SKIM_KEEP: 0.85,
  // water: the floats' bottom FLOAT_H under the centre. Touched sinking at most WATER_SINK, at most WATER_SPEED fast and
  // banked at most WATER_BANK: it floats (speed x WATER_KEEP), else a crash
  FLOAT_H: 1.6,
  WATER_SINK: 3,
  WATER_SPEED: 36, // m/s (130 km/h)
  WATER_BANK: 15 * D,
  WATER_KEEP: 0.9,
  // afloat: drag WATER_DRAG2 v^2 + WATER_DRAG1 v + WATER_DRAG0 (on top of the air's); top ~32 m/s at full throttle
  WATER_DRAG2: 0.002,
  WATER_DRAG1: 0.06,
  WATER_DRAG0: 0.3,
  TAXI_TURN: 35 * D, // rad/s, at 4..12 m/s
  V_TAKEOFF: 27, // m/s (97 km/h): with the stick pulled (pitch > 0.2) it lifts off
  BUMP_SPEED: 8, // m/s: afloat, into a bank slower than this stops it; faster, a crash
  WATER_LIFT: 1.2, // m: afloat, the sweep is made this much higher (a 1 m step in the river's voxels is no wall)
  // crash and respawn
  CRASH_S: 1.2,
  SAFE_EVERY: 0.5, // s: a safe pose recorded this often while SAFE_AGL over the column's top (or afloat, slow)
  SAFE_AGL: 30,
  SAFE_AGE: 3, // s: the pose respawned at is at least this old
  SAFE_KEEP: 40, // poses kept
  RESPAWN_AGL: 60, // m over the top at the pose, at least
  RESPAWN_SPEED: 45,
  RESPAWN_THROTTLE: 0.6,
  // the flight law. false: the stick asks a bank angle and a climb or dive of the path (held in a turn); true
  // (aerobatic): the stick asks a roll rate and a pitch rate about the wings, the attitude a free frame (loops, rolls,
  // inverted flight), hands off the path and the bank hold (the wings level themselves only within BANK_TRIM of level)
  AEROBATIC: false,
  BANK_TRIM: 0,
});
export type PlaneConfig = typeof PLANE;

// The small aerobatic jet (a two-seat trainer, ~9 m, single engine): the floatplane's core with its own numbers and the
// aerobatic flight law. Fast (level top ~450 km/h, dives to ~630), it bleeds speed in hard pulls (induced drag at up
// to 7 g), stalls at ~190 km/h and sharper than the floatplane, rolls at 200 deg/s. No floats: any water is a splash.
export const JET: PlaneConfig = frozen({
  ...PLANE,
  THRUST: 5.6, // ~0.57 g at full throttle (the last 15 % drawn as the afterburner)
  SPOOL: 1.2, // a turbine spools up slower than a propeller
  CD0: 0.000358, // level top at full throttle sqrt(THRUST / CD0) = 125 m/s (450 km/h)
  KI: 12,
  V_STALL: 46, // m/s (166 km/h)
  STALL_FADE: 0.2,
  N_MAX: 7,
  V_MAX: 175, // m/s (630 km/h, a dive's limit)
  ROLL_RATE: 200 * D,
  ROLL_ACCEL: 520 * D,
  BANK_LEVEL: 1.2,
  BANK_TRIM: 35 * D,
  PITCH_RATE: 34 * D, // about the wings: a full pull at ~400 km/h is a loop ~400 m high
  PITCH_FOLLOW: 5,
  PITCH_ACCEL: 70 * D, // (~10 g/s of onset at 400 km/h)
  ALPHA_STALL: 12 * D,
  CEILING: 560, // (VoxelCollision's ceiling is meta.H + 600): room for a loop over the city
  CEILING_FADE: 200,
  RADIUS: 1.2,
  WING_X: 3.4, // (the tip tanks)
  WING_Y: -0.25,
  WING_Z: -0.9, // (swept back)
  WING_R: 0.35,
  HORIZON: 3, // s; VoxelCollision fetches along the path, so ~375 m ahead at the top speed leaves no gap
  SKIM_SINK: 3,
  FLOAT_H: 1.3, // (no floats: the belly; over RADIUS, so that water is met before the ground under it)
  WATER_SPEED: 0, // any touch of water is a crash
  RESPAWN_AGL: 120,
  RESPAWN_SPEED: 100,
  RESPAWN_THROTTLE: 0.8,
  AEROBATIC: true,
});

// (its input, PlaneInput: contract/inputs.ts)

export interface PlaneWorld {
  W: number;
  D: number;
  H: number; // the map's top (meta.H)
  // a cube of half side r (absent: the fuselage's) from p moved by d
  sweep(p: Vec3, d: Vec3, r?: number): Sweep;
  surface(x: number, z: number): { ground: number; top: number } | null;
  // the water's surface at (x, z); -1: no water; null: not known yet (its tile not in)
  water(x: number, z: number): number | null;
  // is all of [x0, x1) x [z0, z1) built (core/built.ts all: a block not built is walled as the map's edge)? absent: the
  // whole rectangle is
  built?(x0: number, z0: number, x1: number, z1: number): boolean;
}

// (where it is, PlaneState, and what it tells its pilot, PlaneEvent: contract/crafts.ts)
export interface PlanePose { x: number; y: number; z: number; heading: number; speed?: number; water?: boolean }
type Safe = Required<PlanePose>;

// the wings' cubes, as shares of the way out to the tip (no voxel's room between them and the fuselage's)
const WING_AT = [0.4, 0.7, 1];
// the wings' sweeps' scratch (not the plane's state: nothing of it outlives a sweep): the nose, the cockpit's up, the
// left wing (+x as drawn), a cube's place
const WF = vec3(), WU = vec3(), WL = vec3(), WQ = vec3();
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
// the level speed at full throttle (thrust = parasitic drag, roughly)
const levelTop = (c: PlaneConfig) => Math.sqrt(c.THRUST / c.CD0);
const smooth = (t: number) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };

export class PlaneFlight {
  readonly p = vec3();
  heading = 0;
  gamma = 0; // flight-path angle, + up
  bank = 0;
  pitchRate = 0; // the path's pitch rate the elevator holds (rad/s), following the stick
  roll = 0; // the bank's rate (rad/s)
  aoa = 0; // the nose over the path, drawn (alpha)
  v = 0; // airspeed (afloat: over the water)
  engine = 0; // 0..1, follows the lever
  state: PlaneState = 'air';
  load = 1; // the load factor pulled
  stalled = false;
  atEdge = false;
  waiting = false; // the last step waited for a collision tile
  t = 0;
  /** how often it was put somewhere at once (reset, respawn): not drawn moving there (plane-core.ts drawn) */
  jumps = 0;
  readonly events: PlaneEvent[] = [];
  private crashLeft = 0;
  private crashAt = 0;
  private readonly clock: FixedStep;
  private readonly safe: SafeTrail<Safe>;
  private start: Safe = { x: 0, y: 0, z: 0, heading: 0, speed: 0, water: false };
  private readonly d = vec3();
  private readonly q = vec3();
  // the aerobatic law's attitude: the path's direction and the lift's (across it); heading, gamma, bank derived
  private readonly fw = vec3(0, 0, 1);
  private readonly lu = vec3(0, 1, 0);

  constructor(readonly cfg: PlaneConfig = PLANE) {
    this.clock = new FixedStep(cfg.STEP, cfg.MAX_STEPS);
    this.safe = new SafeTrail(cfg.SAFE_EVERY, cfg.SAFE_KEEP);
  }

  /** its state on the wire (contract/crafts.ts); not: the crash's countdown, the safe trail and the start (respawn),
   * the clock (the steps), the steps' scratch */
  save(): PlaneFlightState {
    const { heading, gamma, bank, pitchRate, roll, aoa, v, engine, state, load, stalled, atEdge, waiting, t, jumps } = this;
    return { p: { ...this.p }, heading, gamma, bank, pitchRate, roll, aoa, v, engine, state, load, stalled, atEdge, waiting, t, jumps,
      fw: { ...this.fw }, lu: { ...this.lu } };
  }

  restore(s: PlaneFlightState) {
    copy(this.p, s.p);
    this.heading = s.heading; this.gamma = s.gamma; this.bank = s.bank; this.pitchRate = s.pitchRate; this.roll = s.roll;
    this.aoa = s.aoa; this.v = s.v; this.engine = s.engine; this.state = s.state; this.load = s.load; this.stalled = s.stalled;
    this.atEdge = s.atEdge; this.waiting = s.waiting; this.t = s.t; this.jumps = s.jumps;
    copy(this.fw, s.fw); copy(this.lu, s.lu);
  }

  reset(pose: PlanePose) {
    this.start = { x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, speed: pose.speed ?? (pose.water ? 0 : this.cfg.RESPAWN_SPEED), water: !!pose.water };
    this.safe.reset();
    this.t = this.clock.acc = 0;
    this.place(this.start);
  }

  private place(s: Safe) {
    this.jumps++;
    set(this.p, s.x, s.y, s.z);
    this.heading = s.heading;
    this.gamma = this.bank = this.pitchRate = this.roll = 0;
    this.v = s.speed;
    this.state = s.water ? 'water' : 'air';
    this.crashLeft = 0;
    this.stalled = this.atEdge = false;
    this.load = 1;
    this.aoa = this.alphaWant();
    this.syncFrame(true);
  }

  // the aerobatic frame after heading or gamma were set: the path's direction from them, the lift kept across it (or,
  // `level`, wings level)
  private syncFrame(level = false) {
    if (!this.cfg.AEROBATIC) return;
    const f = this.fw, u = this.lu, cg = Math.cos(this.gamma);
    set(f, Math.sin(this.heading) * cg, Math.sin(this.gamma), Math.cos(this.heading) * cg);
    if (level) set(u, 0, 1, 0);
    addScaled(u, f, -dot(u, f));
    if (lengthSq(u) < 1e-6) addScaled(set(u, 0, 1, 0), f, -f.y);
    normalize(u);
  }

  /** the drawn attitude: where the nose points and the cockpit's up (the path's frame turned up by alpha) */
  attitude<T extends Vec3>(fwd: T, up: Vec3): T {
    if (this.cfg.AEROBATIC && this.state === 'air') { copy(fwd, this.fw); copy(up, this.lu); }
    else {
      const sh = Math.sin(this.heading), ch = Math.cos(this.heading), sg = Math.sin(this.gamma), cg = Math.cos(this.gamma);
      const sb = Math.sin(this.bank), cb = Math.cos(this.bank);
      set(fwd, sh * cg, sg, ch * cg);
      // the level up across the path (r) and the right wing (f x r), the lift tilted by the bank towards the right
      set(up, -sg * sh * cb - ch * sb, cg * cb, -sg * ch * cb + sh * sb);
    }
    const ca = Math.cos(this.aoa), sa = Math.sin(this.aoa), fx = fwd.x, fy = fwd.y, fz = fwd.z;
    addScaled(scale(fwd, ca), up, sa);
    add(scale(up, ca), scale(set(this.q, fx, fy, fz), -sa));
    return fwd;
  }

  /** where it moves (m/s), for the collision's prefetch */
  velocity<T extends Vec3 = Vec3>(out: T = vec3() as T): T {
    if (this.state === 'crashed') return set(out, 0, 0, 0);
    if (this.cfg.AEROBATIC && this.state === 'air') return scale(copy(out, this.fw), this.v);
    const c = Math.cos(this.gamma);
    return scale(set(out, Math.sin(this.heading) * c, Math.sin(this.gamma), Math.cos(this.heading) * c), this.v);
  }

  /** the nose over the flight path (drawn): the angle of attack the lift asks, followed (ALPHA_FOLLOW, ALPHA_RATE) */
  get alpha() { return this.aoa; }
  private alphaWant() {
    if (this.state !== 'air') return 0;
    return clamp(this.load / Math.max(0.05, (this.v / this.cfg.V_STALL) ** 2), -0.5, 1.2) * this.cfg.ALPHA_STALL;
  }

  /** a frame: as many fixed steps as dt holds (at most MAX_STEPS: core/fixed-step.ts); false if it waited for a tile */
  advance(input: PlaneInput, dt: number, w: PlaneWorld) {
    return this.clock.run(dt, (step) => this.step(input, step, w));
  }

  /** one step; false if it waited for a collision tile (nothing changed) */
  step(input: PlaneInput, dt: number, w: PlaneWorld) {
    const c = this.cfg;
    if (this.state === 'crashed') {
      this.crashLeft -= dt;
      if (this.crashLeft <= 0) this.respawn(w);
      this.t += dt;
      return true;
    }
    const snapshot = [this.p.x, this.p.y, this.p.z, this.heading, this.gamma, this.bank, this.v, this.engine, this.pitchRate, this.roll];
    this.engine += (clamp(input.throttle, 0, 1) - this.engine) * (1 - Math.exp(-c.SPOOL * dt));
    const ok = this.state === 'air' ? this.fly(input, dt, w) : this.float(input, dt, w);
    this.waiting = !ok;
    if (!ok) {
      [this.p.x, this.p.y, this.p.z, this.heading, this.gamma, this.bank, this.v, this.engine, this.pitchRate, this.roll] = snapshot;
      return false;
    }
    const da = c.ALPHA_RATE * dt;
    this.aoa += clamp((this.alphaWant() - this.aoa) * Math.min(1, c.ALPHA_FOLLOW * dt), -da, da);
    this.t += dt;
    if (this.safe.due(this.t)) this.record(w);
    return true;
  }

  private fly(input: PlaneInput, dt: number, w: PlaneWorld) {
    const c = this.cfg, g = c.G, v = this.v;
    const lift = smooth((v / c.V_STALL - (1 - c.STALL_FADE)) / c.STALL_FADE);
    const nMax = Math.min(c.N_MAX, (v / c.V_STALL) ** 2) * lift;
    const n = c.AEROBATIC ? this.aerobatic(input, dt, lift, nMax) : this.banked(input, dt, lift, nMax);
    // speed: thrust (fading under the ceiling) against drag and the slope
    const ceil = w.H + c.CEILING;
    const thrust = this.engine * c.THRUST * clamp((ceil - this.p.y) / c.CEILING_FADE, 0, 1);
    const drag = c.CD0 * v * v + c.KI * (n * g) ** 2 / (v * v);
    this.v = clamp(v + (thrust - drag - g * Math.sin(this.gamma)) * dt, c.V_MIN, c.V_MAX);
    // the move: inside the map's walls and under the ceiling, onto the water, through the collision
    const d = scale(this.velocity(this.d), dt);
    this.edge(d, ceil, w);
    const p = this.p, ny = p.y + d.y;
    let touch = false;
    if (ny - c.FLOAT_H < w.H + 2) {
      const wl = w.water(p.x + d.x, p.z + d.z);
      if (wl === null) return false;
      if (wl >= 0 && ny - c.FLOAT_H <= wl) { d.y = wl + c.FLOAT_H - p.y; touch = true; }
    }
    const s = this.sweepWings(w.sweep(p, d), d, w);
    if (s === 'loading') return false;
    if (!s.hit) {
      add(p, d);
      if (touch) this.touchdown();
      return true;
    }
    const len = length(d);
    addScaled(p, d, len > 0 ? Math.max(0, s.fraction - 0.002 / len) : 0);
    if (s.hit === 'city edge') return true;
    if (s.hit === 'ceiling') { this.gamma = Math.min(this.gamma, 0); this.syncFrame(); return true; }
    const sink = -v * Math.sin(this.gamma);
    if (s.axis === 2 && sink < c.SKIM_SINK) {
      this.gamma = Math.max(this.gamma, c.SKIM_PITCH);
      this.syncFrame();
      this.v *= c.SKIM_KEEP;
      this.events.push({ type: 'skim' });
      return true;
    }
    this.crash(s.hit);
    return true;
  }

  // the fuselage's sweep s, or the first of the wings' cubes' along d that meets something sooner (the map's edge and
  // the ceiling are the fuselage's: the wings stay well inside them)
  private sweepWings(s: Sweep, d: Vec3, w: PlaneWorld): Sweep {
    if (s === 'loading') return s;
    const c = this.cfg, p = this.p, f = this.attitude(WF, WU), l = cross(WL, WU, f);
    for (const side of [-1, 1]) for (const k of WING_AT) {
      const q = addScaled(addScaled(addScaled(copy(WQ, p), l, side * k * c.WING_X), WU, c.WING_Y), f, c.WING_Z);
      const t = w.sweep(q, d, c.WING_R);
      if (t === 'loading') return t;
      if (t.hit && t.hit !== 'city edge' && t.hit !== 'ceiling' && (!s.hit || t.fraction < s.fraction)) s = t;
    }
    return s;
  }

  /** met a solid thing (sim/solids.ts: a car, a craft, a vessel, a coach) depth m deep, n (a unit x, z) the way out:
   * pushed out as far as its sweep lets it, and met as a wall: in the air a crash, afloat a bump */
  meet(n: { x: number; z: number }, depth: number, w: PlaneWorld) {
    if (this.state === 'crashed') return;
    const p = this.p, d = set(this.d, n.x * (depth + 1e-3), 0, n.z * (depth + 1e-3));
    const s = w.sweep(p, d);
    if (s === 'loading') return;
    addScaled(p, d, s.hit ? Math.max(0, s.fraction - 0.002 / length(d)) : 1);
    if (this.state === 'air') this.crash('vehicle'); else this.bump('vehicle');
  }

  // the stick asks a bank and the path's climb or dive (the load factor holding it in a turn); returns the load factor
  private banked(input: PlaneInput, dt: number, lift: number, nMax: number) {
    const c = this.cfg, g = c.G, v = this.v;
    // bank: the stick sets the target, let go it levels; mushy near the stall; the roll rate eases in and out
    const turn = clamp(input.turn, -1, 1), auth = (0.35 + 0.65 * lift) * c.ROLL_RATE;
    const roll = clamp((turn * c.BANK_MAX - this.bank) * (turn ? c.BANK_FOLLOW : c.BANK_LEVEL), -auth, auth);
    this.roll += clamp(roll - this.roll, -c.ROLL_ACCEL * dt, c.ROLL_ACCEL * dt);
    this.bank += this.roll * dt;
    // pitch: the path's turn rate the stick asks (the elevator following it), as a load factor (wings' lift tilted by
    // the bank), bounded by speed
    const pitch = clamp(input.pitch, -1, 1);
    const qWant = pitch ? pitch * c.PITCH_RATE : clamp(-this.gamma * c.PITCH_LEVEL, -c.PITCH_LEVEL_RATE, c.PITCH_LEVEL_RATE);
    this.pitchRate += clamp((qWant - this.pitchRate) * c.PITCH_FOLLOW, -c.PITCH_ACCEL, c.PITCH_ACCEL) * dt;
    const q = this.pitchRate;
    const cb = Math.max(0.2, Math.cos(this.bank)), cg = Math.cos(this.gamma);
    const nCmd = (cg + q * v / g) / cb;
    const n = clamp(nCmd, -0.5 * nMax, nMax);
    this.load = n;
    this.stalled = nCmd > nMax + 0.05 && v < c.V_STALL * 1.3;
    this.gamma = clamp(this.gamma + (n * cb - cg) * g / v * dt, -c.GAMMA_MAX, c.GAMMA_MAX);
    this.heading -= n * Math.sin(this.bank) * g / (v * Math.max(0.2, cg)) * dt;
    return n;
  }

  // aerobatic: the stick asks a roll rate and a pitch rate about the wings; the path turns by the lift (along lu) and the
  // part of gravity across it, in a free frame (no limit at the vertical: loops, rolls, inverted). Hands off, the
  // pitch rate dies away (the path holds: n = lu.y) and the bank holds, or levels within BANK_TRIM of level
  private aerobatic(input: PlaneInput, dt: number, lift: number, nMax: number) {
    const c = this.cfg, g = c.G, v = this.v, f = this.fw, u = this.lu;
    const turn = clamp(input.turn, -1, 1), auth = (0.35 + 0.65 * lift) * c.ROLL_RATE;
    const trim = Math.abs(this.bank) < c.BANK_TRIM && Math.abs(f.y) < 0.9;
    const roll = turn ? turn * auth : trim ? clamp(-this.bank * c.BANK_LEVEL, -auth, auth) : 0;
    this.roll += clamp(roll - this.roll, -c.ROLL_ACCEL * dt, c.ROLL_ACCEL * dt);
    const pitch = clamp(input.pitch, -1, 1);
    this.pitchRate += clamp((pitch * c.PITCH_RATE - this.pitchRate) * c.PITCH_FOLLOW, -c.PITCH_ACCEL, c.PITCH_ACCEL) * dt;
    const nCmd = this.pitchRate * v / g + u.y;
    const n = clamp(nCmd, -0.5 * nMax, nMax);
    this.load = n;
    this.stalled = nCmd > nMax + 0.05 && v < c.V_STALL * 1.3;
    // f' = (n g lu + gravity across the path) / v; the lift re-squared to the path, then rolled about it
    const k = g * dt / v;
    normalize(set(f, f.x + (n * u.x + f.y * f.x) * k, f.y + (n * u.y - 1 + f.y * f.y) * k, f.z + (n * u.z + f.y * f.z) * k));
    normalize(addScaled(u, f, -dot(u, f)));
    const a = this.roll * dt, w = cross(this.q, f, u);
    normalize(addScaled(scale(u, Math.cos(a)), w, Math.sin(a)));
    // heading, gamma, bank: read off the frame (the bank against the level up across the path; kept at the vertical)
    this.gamma = Math.asin(clamp(f.y, -1, 1));
    if (Math.abs(f.y) < 0.999) {
      this.heading = Math.atan2(f.x, f.z);
      const r = normalize(set(this.d, -f.y * f.x, 1 - f.y * f.y, -f.y * f.z));
      this.bank = Math.atan2(dot(u, cross(w, f, r)), dot(u, r));
    }
    return n;
  }

  // on the water: as gentle as WATER_* asks, it floats; else a crash
  private touchdown() {
    const c = this.cfg, sink = -this.v * Math.sin(this.gamma);
    if (sink > c.WATER_SINK || this.v > c.WATER_SPEED || Math.abs(this.bank) > c.WATER_BANK) { this.crash('water'); return; }
    this.state = 'water';
    this.gamma = this.pitchRate = this.roll = 0;
    this.v *= c.WATER_KEEP;
    this.stalled = false;
    this.load = 1;
    this.events.push({ type: 'touchdown' });
  }

  private float(input: PlaneInput, dt: number, w: PlaneWorld) {
    const c = this.cfg, v = this.v;
    this.bank *= Math.exp(-4 * dt);
    this.gamma = this.pitchRate = this.roll = 0;
    this.load = 1;
    this.stalled = false;
    this.heading -= clamp(input.turn, -1, 1) * c.TAXI_TURN * Math.min(1, (v + 1) / 5) * Math.min(1, 12 / Math.max(v, 1)) * dt;
    const a = this.engine * c.THRUST - (c.WATER_DRAG2 + c.CD0) * v * v - c.WATER_DRAG1 * v - (v > 0 ? c.WATER_DRAG0 : 0);
    this.v = Math.max(0, v + a * dt);
    if (this.v >= c.V_TAKEOFF && input.pitch > 0.2) {
      this.state = 'air';
      this.gamma = 2 * D;
      this.syncFrame();
      this.events.push({ type: 'takeoff' });
      return this.fly(input, dt, w);
    }
    const p = this.p, d = scale(set(this.d, Math.sin(this.heading), 0, Math.cos(this.heading)), this.v * dt);
    this.edge(d, Infinity, w);
    const wl = w.water(p.x + d.x, p.z + d.z);
    if (wl === null) return false;
    if (wl < 0) { this.bump('bank'); return true; }
    d.y = wl + c.FLOAT_H - p.y;
    const s = w.sweep(set(this.q, p.x, p.y + c.WATER_LIFT, p.z), d);
    if (s === 'loading') return false;
    if (s.hit && s.hit !== 'city edge') { this.bump(s.hit); return true; }
    add(p, d);
    return true;
  }

  private bump(what: string) {
    if (this.v > this.cfg.BUMP_SPEED) { this.crash(what); return; }
    if (this.v > 0.5) this.events.push({ type: 'bump' });
    this.v = 0;
  }

  // the map's walls: no move out past EDGE (the move along them stays), none over the ceiling
  private edge(d: Vec3, ceil: number, w: PlaneWorld) {
    const c = this.cfg, p = this.p, lo = c.EDGE;
    let at = false;
    const fit = (k: 'x' | 'z', hi: number) => {
      const e = p[k] + d[k];
      if (e < lo) { d[k] = Math.max(0, lo - p[k]); at = true; } else if (e > hi) { d[k] = Math.min(0, hi - p[k]); at = true; }
    };
    fit('x', w.W - lo);
    fit('z', w.D - lo);
    // a block not built: no move to within EDGE of it, the move along its edge kept (along x, else along z); one
    // already that near (put there) moves freely
    const free = (dx: number, dz: number) => w.built!(p.x + dx - lo, p.z + dz - lo, p.x + dx + lo, p.z + dz + lo);
    if (w.built && !free(d.x, d.z) && free(0, 0)) {
      at = true;
      if (free(d.x, 0)) d.z = 0; else if (free(0, d.z)) d.x = 0; else { d.x = 0; d.z = 0; }
    }
    if (p.y + d.y > ceil) d.y = Math.min(0, ceil - p.y);
    this.atEdge = at;
  }

  private crash(what: string) {
    this.events.push({ type: 'crash', what, kmh: Math.round(this.v * 3.6) });
    this.state = 'crashed';
    this.crashLeft = this.cfg.CRASH_S;
    this.crashAt = this.t;
    this.stalled = false;
  }

  // the newest safe pose at least SAFE_AGE old (else the start), SAFE: level, at least RESPAWN_AGL over the top there
  respawn(w: PlaneWorld) {
    const c = this.cfg, now = this.state === 'crashed' ? this.crashAt : this.t;
    const k = this.safe.find((_, t) => t <= now - c.SAFE_AGE);
    const s = { ...(this.safe.get(k) ?? this.start) };
    this.safe.cut(k + 1);
    if (!s.water) {
      const top = w.surface(s.x, s.z)?.top ?? s.y - c.RESPAWN_AGL;
      s.y = Math.min(w.H + c.CEILING - 10, Math.max(s.y, top + c.RESPAWN_AGL));
      s.speed = Math.max(c.RESPAWN_SPEED, Math.min(s.speed, levelTop(c) * 0.8));
    } else s.speed = 0;
    this.place(s);
    this.engine = s.water ? 0 : c.RESPAWN_THROTTLE;
    this.safe.wait(this.t);
    this.events.push({ type: 'respawn', throttle: this.engine });
  }

  private record(w: PlaneWorld) {
    const c = this.cfg;
    this.safe.wait(this.t);
    let ok = false;
    if (this.state === 'water') ok = this.v < 15;
    else if (this.state === 'air' && !this.stalled) {
      const s = w.surface(this.p.x, this.p.z);
      ok = !!s && this.p.y - s.top >= c.SAFE_AGL;
    }
    if (!ok) return;
    this.safe.push({ x: this.p.x, y: this.p.y, z: this.p.z, heading: this.heading, speed: this.v, water: this.state === 'water' }, this.t);
  }
}

// The world as the viewer's collision gives it (voxel-collision.ts, structurally, so this file needs no DOM): its sweep
// and surface, and its water where the voxels have it (sim/river.ts waterTop)
export interface CollisionLike extends WaterColumns {
  width: number;
  depth: number;
  built?: { all(x0: number, z0: number, x1: number, z1: number): boolean };
  sweep(p: Vec3, d: Vec3, r?: number): Sweep;
  surface(x: number, z: number): { ground: number; top: number } | null;
}
export function collisionWorld(c: CollisionLike, H: number): PlaneWorld {
  return {
    W: c.width, D: c.depth, H,
    sweep: (p, d, r) => c.sweep(p, d, r),
    surface: (x, z) => c.surface(x, z),
    water: (x, z) => waterTop(c, x, z),
    ...(c.built ? { built: (x0: number, z0: number, x1: number, z1: number) => c.built!.all(x0, z0, x1, z1) } : {}),
  };
}
