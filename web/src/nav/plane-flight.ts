import { Vector3 } from 'three';
import type { Sweep } from './voxel-collision';

// The small floatplane's flight (plane.ts draws it and reads the input; web/tools/plane.mjs checks it headless). No DOM,
// no scene: input in, pose out, the world reached through PlaneWorld (the collision's sweep and surface, the rivers'
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
export const PLANE = {
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
  // the collision: the fuselage's cube (half side; the wings do not collide), tiles fetched this far ahead (s)
  RADIUS: 1.5,
  HORIZON: 3.5,
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
};
export type PlaneConfig = typeof PLANE;

export interface PlaneInput {
  turn: number; // -1..1, +1 right
  pitch: number; // -1..1, +1 nose up
  throttle: number; // 0..1, the lever
}

export interface PlaneWorld {
  W: number;
  D: number;
  H: number; // the map's top (meta.H)
  sweep(p: Vector3, d: Vector3): Sweep;
  surface(x: number, z: number): { ground: number; top: number } | null;
  // the water's surface at (x, z); -1: no water; null: not known yet (its tile not in)
  water(x: number, z: number): number | null;
}

export type PlaneState = 'air' | 'water' | 'crashed';
export interface PlanePose { x: number; y: number; z: number; heading: number; speed?: number; water?: boolean }
export type PlaneEvent =
  | { type: 'skim' | 'touchdown' | 'takeoff' | 'bump' }
  | { type: 'crash'; what: string; kmh: number }
  | { type: 'respawn'; throttle: number };
type Safe = Required<PlanePose> & { t: number };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
// the level speed at full throttle (thrust = parasitic drag, roughly)
const levelTop = (c: PlaneConfig) => Math.sqrt(c.THRUST / c.CD0);
const smooth = (t: number) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };

export class PlaneFlight {
  readonly p = new Vector3();
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
  readonly events: PlaneEvent[] = [];
  private crashLeft = 0;
  private crashAt = 0;
  private acc = 0;
  private nextSafe = 0;
  private safe: Safe[] = [];
  private start: Safe = { x: 0, y: 0, z: 0, heading: 0, speed: 0, water: false, t: 0 };
  private readonly d = new Vector3();
  private readonly q = new Vector3();

  constructor(readonly cfg: PlaneConfig = PLANE) {}

  reset(pose: PlanePose) {
    this.start = { x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, speed: pose.speed ?? (pose.water ? 0 : this.cfg.RESPAWN_SPEED), water: !!pose.water, t: 0 };
    this.safe = [];
    this.t = this.nextSafe = this.acc = 0;
    this.place(this.start);
  }

  private place(s: Safe) {
    this.p.set(s.x, s.y, s.z);
    this.heading = s.heading;
    this.gamma = this.bank = this.pitchRate = this.roll = 0;
    this.v = s.speed;
    this.state = s.water ? 'water' : 'air';
    this.crashLeft = 0;
    this.stalled = this.atEdge = false;
    this.load = 1;
    this.aoa = this.alphaWant();
  }

  /** where it moves (m/s), for the collision's prefetch */
  velocity(out = new Vector3()) {
    if (this.state === 'crashed') return out.set(0, 0, 0);
    const c = Math.cos(this.gamma);
    return out.set(Math.sin(this.heading) * c, Math.sin(this.gamma), Math.cos(this.heading) * c).multiplyScalar(this.v);
  }

  /** the nose over the flight path (drawn): the angle of attack the lift asks, followed (ALPHA_FOLLOW, ALPHA_RATE) */
  get alpha() { return this.aoa; }
  private alphaWant() {
    if (this.state !== 'air') return 0;
    return clamp(this.load / Math.max(0.05, (this.v / this.cfg.V_STALL) ** 2), -0.5, 1.2) * this.cfg.ALPHA_STALL;
  }

  /** a frame: as many fixed steps as dt holds (at most MAX_STEPS); false if it waited for a tile */
  advance(input: PlaneInput, dt: number, w: PlaneWorld) {
    const c = this.cfg;
    this.acc = Math.min(this.acc + Math.max(0, dt), c.STEP * c.MAX_STEPS);
    let ok = true;
    while (this.acc >= c.STEP) {
      this.acc -= c.STEP;
      if (!this.step(input, c.STEP, w)) { this.acc = 0; ok = false; break; }
    }
    return ok;
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
    if (this.t >= this.nextSafe) this.record(w);
    return true;
  }

  private fly(input: PlaneInput, dt: number, w: PlaneWorld) {
    const c = this.cfg, g = c.G, v = this.v;
    const lift = smooth((v / c.V_STALL - (1 - c.STALL_FADE)) / c.STALL_FADE);
    const nMax = Math.min(c.N_MAX, (v / c.V_STALL) ** 2) * lift;
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
    // speed: thrust (fading under the ceiling) against drag and the slope
    const ceil = w.H + c.CEILING;
    const thrust = this.engine * c.THRUST * clamp((ceil - this.p.y) / c.CEILING_FADE, 0, 1);
    const drag = c.CD0 * v * v + c.KI * (n * g) ** 2 / (v * v);
    this.v = clamp(v + (thrust - drag - g * Math.sin(this.gamma)) * dt, c.V_MIN, c.V_MAX);
    // the move: inside the map's walls and under the ceiling, onto the water, through the collision
    const d = this.velocity(this.d).multiplyScalar(dt);
    this.edge(d, ceil, w);
    const p = this.p, ny = p.y + d.y;
    let touch = false;
    if (ny - c.FLOAT_H < w.H + 2) {
      const wl = w.water(p.x + d.x, p.z + d.z);
      if (wl === null) return false;
      if (wl >= 0 && ny - c.FLOAT_H <= wl) { d.y = wl + c.FLOAT_H - p.y; touch = true; }
    }
    const s = w.sweep(p, d);
    if (s === 'loading') return false;
    if (!s.hit) {
      p.add(d);
      if (touch) this.touchdown();
      return true;
    }
    const len = d.length();
    p.addScaledVector(d, len > 0 ? Math.max(0, s.fraction - 0.002 / len) : 0);
    if (s.hit === 'city edge') return true;
    if (s.hit === 'ceiling') { this.gamma = Math.min(this.gamma, 0); return true; }
    const sink = -v * Math.sin(this.gamma);
    if (s.axis === 2 && sink < c.SKIM_SINK) {
      this.gamma = Math.max(this.gamma, c.SKIM_PITCH);
      this.v *= c.SKIM_KEEP;
      this.events.push({ type: 'skim' });
      return true;
    }
    this.crash(s.hit);
    return true;
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
      this.events.push({ type: 'takeoff' });
      return this.fly(input, dt, w);
    }
    const p = this.p, d = this.d.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.v * dt);
    this.edge(d, Infinity, w);
    const wl = w.water(p.x + d.x, p.z + d.z);
    if (wl === null) return false;
    if (wl < 0) { this.bump('bank'); return true; }
    d.y = wl + c.FLOAT_H - p.y;
    const s = w.sweep(this.q.copy(p).setY(p.y + c.WATER_LIFT), d);
    if (s === 'loading') return false;
    if (s.hit && s.hit !== 'city edge') { this.bump(s.hit); return true; }
    p.add(d);
    return true;
  }

  private bump(what: string) {
    if (this.v > this.cfg.BUMP_SPEED) { this.crash(what); return; }
    if (this.v > 0.5) this.events.push({ type: 'bump' });
    this.v = 0;
  }

  // the map's walls: no move out past EDGE (the move along them stays), none over the ceiling
  private edge(d: Vector3, ceil: number, w: PlaneWorld) {
    const c = this.cfg, p = this.p, lo = c.EDGE;
    let at = false;
    const fit = (k: 'x' | 'z', hi: number) => {
      const e = p[k] + d[k];
      if (e < lo) { d[k] = Math.max(0, lo - p[k]); at = true; } else if (e > hi) { d[k] = Math.min(0, hi - p[k]); at = true; }
    };
    fit('x', w.W - lo);
    fit('z', w.D - lo);
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
    let k = this.safe.length - 1;
    while (k >= 0 && this.safe[k].t > now - c.SAFE_AGE) k--;
    const s = k >= 0 ? { ...this.safe[k] } : { ...this.start };
    this.safe.length = Math.max(0, k + 1);
    if (!s.water) {
      const top = w.surface(s.x, s.z)?.top ?? s.y - c.RESPAWN_AGL;
      s.y = Math.min(w.H + c.CEILING - 10, Math.max(s.y, top + c.RESPAWN_AGL));
      s.speed = Math.max(c.RESPAWN_SPEED, Math.min(s.speed, levelTop(c) * 0.8));
    } else s.speed = 0;
    this.place(s);
    this.engine = s.water ? 0 : c.RESPAWN_THROTTLE;
    this.nextSafe = this.t + c.SAFE_EVERY;
    this.events.push({ type: 'respawn', throttle: this.engine });
  }

  private record(w: PlaneWorld) {
    const c = this.cfg;
    this.nextSafe = this.t + c.SAFE_EVERY;
    let ok = false;
    if (this.state === 'water') ok = this.v < 15;
    else if (this.state === 'air' && !this.stalled) {
      const s = w.surface(this.p.x, this.p.z);
      ok = !!s && this.p.y - s.top >= c.SAFE_AGL;
    }
    if (!ok) return;
    this.safe.push({ x: this.p.x, y: this.p.y, z: this.p.z, heading: this.heading, speed: this.v, water: this.state === 'water', t: this.t });
    if (this.safe.length > c.SAFE_KEEP) this.safe.shift();
  }
}

// The world as the viewer's collision gives it (voxel-collision.ts, structurally, so this file needs no DOM): its sweep
// and surface, its water (a water run reaching the ground's top) raised with the river level slider (flood.ts, m over the
// survey day; lowered, the voxels' water stays where it is)
export interface CollisionLike {
  width: number;
  depth: number;
  sweep(p: Vector3, d: Vector3): Sweep;
  surface(x: number, z: number): { ground: number; top: number } | null;
  waterColumn(x: number, z: number, y0: number, y1: number): { water: number } | null;
}
/** the top of the water in column (x, z) (VoxelCollision.waterColumn: the river's top voxels are the ground's); -1: none;
 *  null: its tile not in */
export const waterTop = (c: Pick<CollisionLike, 'waterColumn'>, x: number, z: number) => c.waterColumn(x, z, 0, 0)?.water ?? null;
export function collisionWorld(c: CollisionLike, H: number, level: () => number = () => 0): PlaneWorld {
  return {
    W: c.width, D: c.depth, H,
    sweep: (p, d) => c.sweep(p, d),
    surface: (x, z) => c.surface(x, z),
    water: (x, z) => { const w = waterTop(c, x, z); return w === null || w < 0 ? w : w + Math.max(0, level()); },
  };
}
