import type { World } from '../core/world';
import type { RoofSpot } from './contract/pose';
import { roofSpot, roofUnder, type Solid } from './solids';
import { CLIMB_OUT, FLOAT, SWIM_DEPTH, Wet } from './swim';
import { ride, STEP, walkFrame, withRoofs, type Ground } from './walk';
import { EYE } from './weapons/weapon';

const GRAV = 16;
// A body's free fall (off the paraglider): a skydiver's belly-down terminal speed, under the host's walk bound (80 m/s,
// sim/walk-bounds.ts) so a long fall is not clamped; the air takes the speed across at that rate
const TERMINAL = 55, AIR_DRAG = GRAV / TERMINAL;
/** m over what is under the feet from which a canopy may open again: higher than a jump goes */
export const CANOPY_DROP = 4;
// Afloat the water holds the body at FLOAT (a spring of BUOY per s², damped by DAMP per s) and brakes a fall into it
// as the square of its speed (DRAG per m): from a paraglider's 55 m/s it is down to a swimmer's in about 2 m, the eyes
// a little under, and back up in a second or two
const BUOY = 14, DAMP = 5, DRAG = 1.4;
// m/s afloat (no running in the water), and the most a wade slows to (waist deep) of the walk's
const SWIM = 1.8, WADE = 0.45;

/** what a walker stands on: the voxels, the water read from them where there are any */
export type WalkWorld = Ground & Partial<Pick<World, 'waterColumn'>>;
/** a frame's stride (x, z m) for a walker facing yaw that may go d m, null: none */
export type Want = (yaw: number, d: number) => { x: number; z: number } | null;

// A body on foot, the same for a player (their page runs it, nav/foot.ts) and an NPC (the host runs it): where the
// feet are, the steps (up kerbs and stairs, sliding along walls and round the solid things near), gravity and jumps,
// wading and swimming, riding a solid thing's roof. Its pos is at the eyes (EYE over the feet).
export class Walker<P extends { x: number; y: number; z: number } = { x: number; y: number; z: number }> {
  yaw = 0;
  feet = 0;
  vy = 0;
  /** m/s across, carried through the air (a fall from a craft); gone on landing or a wall */
  readonly carry = { x: 0, z: 0 };
  /** afloat in water too deep to stand in (others see the walker swim: the pose's swim) */
  swimming = false;
  /** the eyes under the water's top */
  under = false;
  /** the voxels as the walk feels them, water in */
  readonly wet: Wet;
  // this frame's step up and the most ground climbed (out of the water: to CLIMB_OUT over it)
  private step = STEP;
  private top = Infinity;
  // the solid things near this frame; the one whose roof the feet stood on at the end of the last frame (as it was
  // then), and how fast it went (m/s across: taken along when the walker leaves it)
  private near: readonly Solid[] = [];
  protected on: Solid | null = null;
  private readonly onV = { x: 0, z: 0 };

  constructor(readonly pos: P, protected readonly world: () => WalkWorld | null) {
    this.wet = new Wet(world);
  }

  /** a jump, at once if standing (afloat there is nothing to push off) */
  jump() {
    if (this.vy === 0 && !this.swimming) this.vy = 5.2;
  }

  /** falling from the feet at (x, y, z) with velocity v, facing yaw (out of a craft in the air; put down: v 0) */
  fallAt(at: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, yaw: number) {
    this.pos.x = at.x; this.pos.y = at.y + EYE; this.pos.z = at.z;
    this.feet = at.y;
    this.on = null;
    this.vy = Math.max(v.y, -TERMINAL);
    this.carry.x = v.x; this.carry.z = v.z;
    this.yaw = yaw;
  }

  /** in the air high enough over what is under the feet for a canopy (CANOPY_DROP) */
  get canOpen() {
    const w = this.world();
    return !!w && this.feet - w.support(this.pos.x, this.pos.z, this.feet) >= CANOPY_DROP;
  }

  /** the spot on the roof of the solid thing the feet stand on (the host puts the walker there on the thing as it has
   * it), or null: on the voxels, in the air, or on something without an id */
  roof(): RoofSpot | null {
    const s = this.on;
    return s && s.id !== undefined ? roofSpot(s as Solid & { id: string }, this.pos, this.feet) : null;
  }

  /** a frame of dt s among the solid things near: carried by what it stands on, the stride want asks for at speed
   * (m/s on land; in water slower), the speed carried through the air, then stood on what is under the feet */
  move(dt: number, near: readonly Solid[], speed: number, want: Want) {
    this.near = near;
    this.ride(dt);
    const pace = this.wade(speed) * dt;
    this.stepBy(want(this.yaw, pace));
    this.drift(dt);
    this.stand(dt);
    this.landed();
  }

  // pushed out of what moved into the walker, then one collision-checked horizontal step (none: null), sliding along
  // walls and cars; true if it stepped
  private stepBy(m: { x: number; z: number } | null) {
    return walkFrame(this.wet, this.pos, this.feet, m, this.near, this.step, this.top);
  }

  // on a roof: carried along with what it is on (a car driving off with the walker on top), turned with it
  private ride(dt: number) {
    const a = this.on, to = a && ride(this.wet, this.pos, this.feet, a, this.near);
    this.onV.x = this.onV.z = 0;
    if (!to) return;
    this.onV.x = (to.x - this.pos.x) / dt; this.onV.z = (to.z - this.pos.z) / dt;
    this.pos.x = to.x; this.pos.z = to.z;
    this.feet += to.dy;
    this.yaw += to.dh;
  }

  // what the feet stand on now among the solids (null: the voxels, or the air); leaving it, its speed is kept as a jump
  // off a moving car's would be
  private landed() {
    const was = this.on, r = this.vy === 0 && !this.swimming ? roofUnder(this.near, this.pos.x, this.pos.z, this.feet + 0.02) : null;
    this.on = r && r.y + r.top > this.feet - 0.02 ? r : null;
    if (was && !this.on) { this.carry.x += this.onV.x; this.carry.z += this.onV.z; }
  }

  // in water (its top over the soles): a bank up to CLIMB_OUT over it climbed out onto, no higher; the pace's share
  // of the walk's (afloat: SWIM m/s whatever the walk's pace), and whether running is out
  private wade(pace: number) {
    const water = this.wet.surface(this.pos.x, this.pos.z), d = water === null ? 0 : water - this.feet;
    this.step = d > 0 ? Math.max(STEP, d + CLIMB_OUT) : STEP;
    this.top = d > 0 ? water! + CLIMB_OUT : Infinity;
    if (this.swimming) return SWIM;
    return d > 0 ? pace * (1 - (1 - WADE) * Math.min(1, d / SWIM_DEPTH)) : pace;
  }

  // on whatever is underfoot: up kerbs and stairs (and out of the water), off ledges, jumps; afloat in deep water
  private stand(dt: number) {
    const P = this.pos, sup = withRoofs(this.wet, this.near).support(P.x, P.z, this.feet + this.step), top = this.wet.surface(P.x, P.z);
    const water = top !== null && top > sup ? top : null, was = this.swimming;
    this.swimming = water !== null && water - sup > SWIM_DEPTH && this.feet < water;
    // (out of the deep water the float's bob is no jump: up a bank it climbs)
    if (was && !this.swimming) this.vy = Math.min(this.vy, 0);
    if (this.swimming) {
      // (no landing in the water, never under its bed)
      this.vy /= 1 + (DAMP + DRAG * Math.abs(this.vy)) * dt;
      this.vy += BUOY * (water! - FLOAT - this.feet) * dt;
      this.feet += this.vy * dt;
      if (this.feet <= sup) { this.feet = sup; this.vy = Math.max(0, this.vy); }
    } else if (this.feet < sup - 0.01 && this.vy <= 0.5) {
      this.vy = 0;
      this.feet = Math.min(sup, this.feet + 6 * dt);
    } else if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy = Math.max(this.vy - GRAV * dt, -TERMINAL);
      this.feet += this.vy * dt;
      // a hard landing is only a landing: there is no health to take yet
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; this.carry.x = this.carry.z = 0; }
    } else this.feet = sup;
    P.y = this.feet + EYE;
    this.under = water !== null && P.y < water;
  }

  // the speed across carried through the air, slowing; a wall or a solid thing stops it
  private drift(dt: number) {
    const C = this.carry;
    if (!C.x && !C.z) return;
    // (the water stops it within a metre or two)
    const k = Math.exp(-(this.swimming ? 3 : AIR_DRAG) * dt);
    C.x *= k; C.z *= k;
    if (!this.stepBy({ x: C.x * dt, z: C.z * dt }) || Math.hypot(C.x, C.z) < 0.05) C.x = C.z = 0;
  }
}
