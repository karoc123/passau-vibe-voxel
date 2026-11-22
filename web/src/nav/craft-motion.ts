import { set, vec3, type Vec3 } from '../core/vec';
import type { Sweep } from './sweep';

export type CraftKind = 'hovercraft' | 'helicopter' | 'paraglider';
export interface CraftInput { turn: number; drive: number; lift: number }
export interface CraftMotionWorld {
  surface(x: number, z: number): { height: number; water: boolean } | null;
  sweep(p: Vec3, d: Vec3, fromHeading: number, toHeading: number): Sweep;
  landing(p: Vec3): Sweep;
}
export type CraftStep = 'moving' | 'blocked' | 'loading' | 'landed' | 'splash';

export const HOVER_HEIGHT = 0.68;
export const GLIDER_HEIGHT = 0.48;
const WALKABLE_STEP = 1.15;
const follow = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** The three craft use the same fixed-step pose and voxel contacts, with their own motion laws. */
export class CraftMotion {
  readonly p = vec3();
  readonly velocity = vec3();
  heading = 0;
  bank = 0;
  pitch = 0;
  private readonly delta = vec3();
  private readonly raised = vec3();

  constructor(readonly kind: CraftKind) {}

  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  reset(p: Vec3, heading: number, speed = 0) {
    set(this.p, p.x, p.y, p.z);
    this.heading = heading;
    this.bank = this.pitch = 0;
    set(this.velocity, Math.sin(heading) * speed, 0, Math.cos(heading) * speed);
  }

  step(input: CraftInput, dt: number, world: CraftMotionWorld): CraftStep {
    const hover = this.kind === 'hovercraft', heli = this.kind === 'helicopter';
    const heading = this.heading + input.turn * (hover ? 1.25 : heli ? 1.15 : 0.86) * dt;
    const speed = hover ? input.drive * (input.drive < 0 ? 7 : 22)
      : heli ? input.drive * (input.drive < 0 ? 8 : 37) : 11 + 5 * input.drive;
    const response = hover ? 1.35 : heli ? 1.65 : 2.7;
    const vx = follow(this.velocity.x, Math.sin(heading) * speed, response, dt);
    const vz = follow(this.velocity.z, Math.cos(heading) * speed, response, dt);
    const vy = heli ? follow(this.velocity.y, input.lift * (input.lift > 0 ? 9 : 5), 4, dt)
      : -(2.35 + 2.5 * Math.max(0, input.drive) + 0.65 * Math.abs(input.turn) - 0.8 * Math.max(0, -input.drive));
    set(this.delta, vx * dt, hover ? 0 : vy * dt, vz * dt);

    // The skirt follows land and water. Raise it before crossing a small step, with an upward sweep for headroom.
    let start: Vec3 = this.p, drop = 0;
    if (hover) {
      const reach = Math.sign(vx * Math.sin(heading) + vz * Math.cos(heading)) * 1.9;
      const ahead = world.surface(this.p.x + this.delta.x + Math.sin(heading) * reach, this.p.z + this.delta.z + Math.cos(heading) * reach);
      const under = world.surface(this.p.x + this.delta.x, this.p.z + this.delta.z);
      if (!ahead || !under) return 'loading';
      const floor = Math.min(Math.max(under.height, ahead.height), under.height + WALKABLE_STEP);
      const rise = floor + HOVER_HEIGHT - this.p.y;
      if (rise > 0 && rise <= WALKABLE_STEP) {
        const lift = world.sweep(this.p, set(this.raised, 0, rise, 0), this.heading, this.heading);
        if (lift === 'loading') return lift;
        start = set(this.raised, this.p.x, this.p.y + rise * (lift.hit ? Math.max(0, lift.fraction - 0.01) : 1), this.p.z);
      } else if (rise < 0) drop = Math.max(rise, -5 * dt);
    }

    const hit = world.sweep(start, this.delta, this.heading, heading);
    if (hit === 'loading') return hit;
    let fraction = hit.hit ? Math.max(0, hit.fraction - 0.002) : 1;
    const glider = !heli && !hover;
    // Stop at a wall, but keep descending beside it so a wing brush doesn't pin the player.
    if (glider && hit.hit && hit.axis !== 2) {
      set(this.delta, 0, vy * dt, 0);
      const down = world.sweep(start, this.delta, this.heading, this.heading);
      if (down === 'loading') return down;
      fraction = down.hit ? Math.max(0, down.fraction - 0.002) : 1;
    }

    const x = start.x + this.delta.x * fraction, z = start.z + this.delta.z * fraction;
    let y = start.y + this.delta.y * fraction;
    // The trailing skirt can still overlap the bank when the centre reaches water. Keep the lateral move and
    // lower only as far as the full skirt permits at its new position.
    if (drop < 0) {
      const h = hit.hit ? this.heading : heading;
      const down = world.sweep({ x, y, z }, { x: 0, y: drop, z: 0 }, h, h);
      if (down === 'loading') return down;
      y += drop * (down.hit ? Math.max(0, down.fraction - 0.01) : 1);
    }
    if (glider) {
      const ground = world.surface(x, z);
      if (!ground) return 'loading';
      if (ground.water && y <= ground.height + GLIDER_HEIGHT) {
        set(this.p, x, ground.height + GLIDER_HEIGHT, z);
        return 'splash';
      }
      if ((hit.hit && hit.axis === 2) || (this.delta.x === 0 && this.delta.z === 0 && fraction < 1)) {
        // A cube can touch a ledge before the person is above it. Keep steering until there is support below.
        const below = world.landing({ x, y, z });
        if (below === 'loading') return below;
        if (below.hit && below.axis === 2) {
          set(this.p, x, y, z);
          this.heading = heading;
          return 'landed';
        }
      }
    }

    const verticalSpeed = (y - this.p.y) / dt;
    set(this.p, x, y, z);
    // Keep the hull or rotor outside the wall when a turn would move it into one.
    if (glider || !hit.hit || hit.axis === 2) this.heading = heading;
    set(this.velocity, hit.hit ? 0 : vx, hit.hit ? 0 : verticalSpeed, hit.hit ? 0 : vz);
    this.bank = follow(this.bank, -input.turn * (glider ? 0.4 : heli ? 0.19 : 0.12), 4, dt);
    this.pitch = follow(this.pitch, -input.drive * (glider ? 0.13 : heli ? 0.20 : 0.035), 4, dt);
    return hit.hit && hit.axis !== 2 ? 'blocked' : 'moving';
  }
}
