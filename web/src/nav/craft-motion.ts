import { set, vec3, type Vec3 } from '../core/vec';
import type { Sweep } from './sweep';

export type CraftKind = 'hovercraft' | 'helicopter' | 'paraglider';
// turn +1: right (the heading falls, as the cars' and the boat's); drive +1: forward; lift +1: climb (helicopter);
// side +1: sideways to the right (helicopter)
export interface CraftInput { turn: number; drive: number; lift: number; side: number }
export interface CraftMotionWorld {
  surface(x: number, z: number): { height: number; water: boolean } | null;
  sweep(p: Vec3, d: Vec3, fromHeading: number, toHeading: number): Sweep;
  landing(p: Vec3): Sweep;
}
export type CraftStep = 'moving' | 'blocked' | 'loading' | 'landed' | 'splash';

export const HOVER_HEIGHT = 0.68;
export const GLIDER_HEIGHT = 0.48;
const WALKABLE_STEP = 1.15;
const G = 9.81;

// All the numbers, in one place. Arcade laws, not simulators: each craft has momentum, and what it does when the
// controls are let go is the calm thing (the helicopter hovers, the hovercraft glides on, the glider flies straight).
export const CRAFT = {
  helicopter: {
    yaw: 1.2, yawResponse: 3, // rad/s at full pedal, /s the yaw rate follows it
    accel: 8, backAccel: 4, sideAccel: 6, // m/s² from the stick (forward, back, sideways)
    drag: 0.18, // /s: top speed accel / drag = 44 m/s (160 km/h)
    hoverBrake: 0.9, // /s more with the stick let go: it settles into a hover
    sideDamp: 0.6, // /s: speed across the nose decays (the tail fin), so turns at speed follow the nose
    climb: 8, sink: 6, liftResponse: 1.6, // m/s, /s
    tilt: 0.5, maxTilt: 0.45, // drawn: the disc tilts with the stick's thrust (share of atan(a/g)), at most rad
  },
  hovercraft: {
    yaw: 1.1, yawResponse: 2.5,
    thrust: 5.5, reverse: 4, // m/s² (the fans' louvres turned back)
    drag: 0.22, landDrag: 0.3, // /s: 25 m/s (90 km/h) on water, 18 m/s on land
    grip: 0.8, // /s: the skirt barely holds sideways, it drifts through turns
  },
  paraglider: {
    yaw: 0.7, yawResponse: 2, // rad/s
    trim: 11, bar: 4.5, brake: 4, // m/s: hands up, on the speed bar (W) adds, braked (S) takes off
    sink: 1.4, barSink: 1.3, brakeSink: -0.3, turnSink: 1.0, // m/s: trim glide about 8:1
    response: 1.5, // /s: the speed follows
  },
} as const;

const follow = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const AXIS = ['x', 'y', 'z'] as const;

/** The three craft share the fixed-step pose and the voxel contacts, each with its own motion law. */
export class CraftMotion {
  readonly p = vec3();
  readonly velocity = vec3();
  heading = 0;
  yaw = 0; // rad/s, + turning right (the heading falls)
  bank = 0; // drawn: + the right side down
  pitch = 0; // drawn: + the nose up
  grounded = false; // the helicopter on its skids
  private readonly delta = vec3();
  private readonly raised = vec3();

  constructor(readonly kind: CraftKind) {}

  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  reset(p: Vec3, heading: number, speed = 0) {
    set(this.p, p.x, p.y, p.z);
    this.heading = heading;
    this.yaw = this.bank = this.pitch = 0;
    this.grounded = false;
    set(this.velocity, Math.sin(heading) * speed, 0, Math.cos(heading) * speed);
  }

  step(input: CraftInput, dt: number, world: CraftMotionWorld): CraftStep {
    if (this.kind === 'helicopter') return this.helicopter(input, dt, world);
    if (this.kind === 'hovercraft') return this.hovercraft(input, dt, world);
    return this.paraglider(input, dt, world);
  }

  // Turn in place first: a turn that would swing the hull, rotor or wing into a wall is not taken.
  private turn(target: number, response: number, dt: number, world: CraftMotionWorld): 'loading' | void {
    this.yaw = follow(this.yaw, target, response, dt);
    const h = this.heading - this.yaw * dt;
    if (h === this.heading) return;
    const hit = world.sweep(this.p, set(this.delta, 0, 0, 0), this.heading, h);
    if (hit === 'loading') return hit;
    if (hit.hit) this.yaw = 0;
    else this.heading = h;
  }

  // Move p by v dt, sliding along what it meets (a pass per axis met). The velocity loses what went into a face.
  // Returns the signed axes met, or 'loading'.
  private slide(world: CraftMotionWorld, dt: number, from: Vec3 = this.p): number[] | 'loading' {
    const v = this.velocity, d = set(this.delta, v.x * dt, v.y * dt, v.z * dt), met: number[] = [];
    if (from !== this.p) set(this.p, from.x, from.y, from.z);
    for (let pass = 0; pass < 3 && (d.x || d.y || d.z); pass++) {
      const hit = world.sweep(this.p, d, this.heading, this.heading);
      if (hit === 'loading') return hit;
      const f = hit.hit ? Math.max(0, hit.fraction - 0.002) : 1;
      set(this.p, this.p.x + d.x * f, this.p.y + d.y * f, this.p.z + d.z * f);
      if (!hit.hit) break;
      met.push(hit.axis);
      const k = AXIS[Math.abs(hit.axis) - 1];
      set(d, d.x * (1 - f), d.y * (1 - f), d.z * (1 - f));
      d[k] = 0;
      v[k] = 0;
    }
    return met;
  }

  private helicopter(input: CraftInput, dt: number, world: CraftMotionWorld): CraftStep {
    const H = CRAFT.helicopter, v = this.velocity;
    const onSkids = this.grounded && input.lift <= 0;
    if (this.turn(onSkids ? 0 : input.turn * H.yaw, H.yawResponse, dt, world) === 'loading') return 'loading';
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    // the speed along the nose and across it (to the right: -cos, +sin)
    let vf = v.x * s + v.z * c, vr = -v.x * c + v.z * s;
    const idle = Math.abs(input.drive) < 0.05 && Math.abs(input.side) < 0.05;
    let tf = 0, tr = 0;
    if (onSkids) vf = vr = 0;
    else {
      tf = input.drive * (input.drive < 0 ? H.backAccel : H.accel) - (idle ? H.hoverBrake * vf : 0);
      tr = input.side * H.sideAccel - (idle ? H.hoverBrake * vr : 0);
      vf += (tf - H.drag * vf) * dt;
      vr += (tr - (H.drag + H.sideDamp) * vr) * dt;
    }
    set(v, vf * s - vr * c, v.y, vf * c + vr * s);
    // the collective: climb and sink at set rates, hold the height with it let go; on the skids it presses down
    v.y = onSkids ? -1 : follow(v.y, input.lift * (input.lift > 0 ? H.climb : H.sink), H.liftResponse, dt);
    const met = this.slide(world, dt);
    if (met === 'loading') return met;
    this.grounded = met.includes(2);
    if (this.grounded) v.y = 0;
    // drawn: the disc leans with the thrust the stick asks for (nose down to speed up, up to flare), and banks into
    // a turn as much as the turn at this speed needs
    const lean = (a: number) => Math.max(-H.maxTilt, Math.min(H.maxTilt, H.tilt * Math.atan(a / G)));
    this.pitch = follow(this.pitch, onSkids ? 0 : -lean(tf), 3, dt);
    this.bank = follow(this.bank, onSkids ? 0 : lean(tr + this.yaw * vf), 3, dt);
    return met.some((a) => Math.abs(a) !== 2) ? 'blocked' : 'moving';
  }

  private hovercraft(input: CraftInput, dt: number, world: CraftMotionWorld): CraftStep {
    const V = CRAFT.hovercraft, v = this.velocity;
    if (this.turn(input.turn * V.yaw, V.yawResponse, dt, world) === 'loading') return 'loading';
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const under = world.surface(this.p.x, this.p.z);
    if (!under) return 'loading';
    const drag = under.water ? V.drag : V.landDrag;
    let vf = v.x * s + v.z * c, vr = -v.x * c + v.z * s;
    // backwards: the louvres brake hard while it still goes forward, then back it slowly (7 m/s)
    const tf = input.drive * (input.drive >= 0 ? V.thrust : vf > 1 ? V.reverse : 0.4 * V.reverse);
    vf += (tf - drag * vf) * dt;
    vr -= (drag + V.grip) * vr * dt;
    set(v, vf * s - vr * c, 0, vf * c + vr * s);

    // The skirt follows land and water. Raise it before crossing a small step, with an upward sweep for headroom.
    const dx = v.x * dt, dz = v.z * dt;
    const reach = Math.sign(vf) * 3.0; // the skirt's end (probes at 2.3 m, 0.53 half-size) and a little
    const ahead = world.surface(this.p.x + dx + s * reach, this.p.z + dz + c * reach);
    const next = world.surface(this.p.x + dx, this.p.z + dz);
    if (!ahead || !next) return 'loading';
    const floor = Math.min(Math.max(next.height, ahead.height), next.height + WALKABLE_STEP);
    const rise = floor + HOVER_HEIGHT - this.p.y;
    let start: Vec3 = this.p, drop = 0;
    if (rise > 0 && rise <= WALKABLE_STEP) {
      const lift = world.sweep(this.p, set(this.raised, 0, rise, 0), this.heading, this.heading);
      if (lift === 'loading') return lift;
      start = set(this.raised, this.p.x, this.p.y + rise * (lift.hit ? Math.max(0, lift.fraction - 0.01) : 1), this.p.z);
    } else if (rise < 0) drop = Math.max(rise, -5 * dt);
    const met = this.slide(world, dt, start);
    if (met === 'loading') return met;
    // The trailing skirt can still overlap the bank when the centre reaches water. Lower only as far as the full
    // skirt permits at its new position.
    if (drop < 0) {
      const down = world.sweep(this.p, set(this.delta, 0, drop, 0), this.heading, this.heading);
      if (down === 'loading') return down;
      this.p.y += drop * (down.hit ? Math.max(0, down.fraction - 0.01) : 1);
    }
    // drawn: the bow lifts under thrust, the hull leans out of a turn
    this.pitch = follow(this.pitch, 0.035 * Math.max(0, tf / V.thrust) - 0.02 * Math.max(0, -input.drive), 3, dt);
    this.bank = follow(this.bank, -0.12 * Math.max(-1, Math.min(1, this.yaw * vf / 20)), 3, dt);
    return met.some((a) => Math.abs(a) !== 2) ? 'blocked' : 'moving';
  }

  private paraglider(input: CraftInput, dt: number, world: CraftMotionWorld): CraftStep {
    const P = CRAFT.paraglider, v = this.velocity;
    if (this.turn(input.turn * P.yaw, P.yawResponse, dt, world) === 'loading') return 'loading';
    const bar = Math.max(0, input.drive), brake = Math.max(0, -input.drive);
    const speed = P.trim + P.bar * bar - P.brake * brake;
    const sink = P.sink + P.barSink * bar + P.brakeSink * brake + P.turnSink * Math.abs(input.turn);
    // the wing flies where it points: the speed turns with the heading, its size follows the bar and the brakes
    const now = Math.max(0, follow(Math.hypot(v.x, v.z), speed, P.response, dt));
    set(v, Math.sin(this.heading) * now, follow(v.y, -sink, P.response, dt), Math.cos(this.heading) * now);
    const met = this.slide(world, dt);
    if (met === 'loading') return met;
    const { x, y, z } = this.p;
    const ground = world.surface(x, z);
    if (!ground) return 'loading';
    if (ground.water && y <= ground.height + GLIDER_HEIGHT) {
      set(this.p, x, ground.height + GLIDER_HEIGHT, z);
      return 'splash';
    }
    if (met.includes(2)) {
      // A wing or boot can touch a ledge before the pilot is over it: land only with support under the pilot.
      const below = world.landing(this.p);
      if (below === 'loading') return below;
      if (below.hit && below.axis === 2) return 'landed';
    }
    // drawn: the pilot swings into a turn, forward on the bar and back on the brakes
    this.bank = follow(this.bank, 0.4 * input.turn, 3, dt);
    this.pitch = follow(this.pitch, -0.13 * bar + 0.13 * brake, 3, dt);
    return met.some((a) => Math.abs(a) !== 2) ? 'blocked' : 'moving';
  }
}
