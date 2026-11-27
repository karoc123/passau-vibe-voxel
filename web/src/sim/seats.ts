// (the page offers a free seat and draws who sits where by it; the host, Entities, holds them to it)
import type { Vec3 } from '../core/vec';
import type { Pose } from './contract/pose';
import type { CraftType, Role, VehicleId, WeaponId } from './contract/ids';

/** a weapon fixed to a seat (a mount): its weapon, the point a shot leaves from in the vehicle's frame (x to its left,
 * y up from its origin, z ahead: the gunner's eyes), the middle of its swing off the bow (rad, in the sense of a
 * heading: + to the left), how far it swings either side of that, and its pitch's limits (rad, up). nose: the swing's
 * middle and the point follow the vehicle's nose, its pitch as well as its heading, and the pitch's limits are off the
 * nose (a gun fixed in an aircraft, aimed by flying it) */
export interface Mount { readonly weapon: WeaponId; readonly at: Readonly<Vec3>; readonly yaw: number; readonly arc: number; readonly pitch: readonly [number, number]; readonly nose?: boolean }

/** a seat of an entity's model: its role and which of that role's seats (0: the first); a passenger's may have a mount */
export interface SeatSpec { readonly role: Role; readonly index: number; readonly mount?: Mount }

const one = (role: Role): readonly SeatSpec[] => Object.freeze([Object.freeze({ role, index: 0 })]);
const DRIVER = one('driver'), PILOT = one('pilot'), WALKER = one('walker'), NONE: readonly SeatSpec[] = Object.freeze([]);
// the driver's or pilot's seat and n passengers' after it
const withPassengers = (first: readonly SeatSpec[], n: number): readonly SeatSpec[] =>
  Object.freeze([...first, ...Array.from({ length: n }, (_, index) => Object.freeze({ role: 'passenger' as const, index }))]);
const DEG = Math.PI / 180;
// The speedboat's MG beside its wheel: it covers the bow and both beams, not astern (a boat chased has to turn); from
// the gunner's eyes, so the shot leaves where they look from
const BOAT_GUN: Mount = Object.freeze({ weapon: 'mg', at: Object.freeze({ x: 0.45, y: 1.8, z: -0.04 }), yaw: 0, arc: 100 * DEG, pitch: Object.freeze([-10 * DEG, 35 * DEG]) as readonly [number, number] });
// The combat plane's MG over its cowling, fixed ahead: the pilot aims by flying. It swings a little either way, so the
// host, which has the plane a ping later than the page drew it, can still aim at the page's point without letting the
// pilot aim off the nose
const FIGHTER_GUN: Mount = Object.freeze({ weapon: 'mg', at: Object.freeze({ x: 0, y: 1.1, z: 3.6 }), yaw: 0, arc: 2 * DEG, pitch: Object.freeze([-2 * DEG, 2 * DEG]) as readonly [number, number], nose: true });
// The military helicopter's door guns, one in each open door: each covers its own side wide and far down (a target is
// circled or passed alongside, the pilot giving it to one side), neither the nose, the tail nor the other side. The
// eyes just outside the hull's side, so a steep shot down clears its floor and skids
const doorGun = (side: 1 | -1): Mount => Object.freeze({ weapon: 'mg', at: Object.freeze({ x: 1.2 * side, y: 0.55, z: -0.3 }), yaw: 90 * DEG * side,
  arc: 60 * DEG, pitch: Object.freeze([-70 * DEG, 10 * DEG]) as readonly [number, number] });
const passenger = (index: number, mount?: Mount): SeatSpec => Object.freeze(mount ? { role: 'passenger' as const, index, mount } : { role: 'passenger' as const, index });

/** the seats of each kind's model, by type: a vehicle's driver's or pilot's and its passengers' (the hovercraft's
 * cabin, the helicopter's seat beside its pilot, the military helicopter's two door guns and its bench, the speedboat's
 * seat beside its wheel, a car's front and back seats; a craft flown
 * alone has none), a walker's on a player's
 * avatar (none on a person of the crowd: a player on foot is a body of their own) */
export const SEATS: {
  readonly car: Readonly<Record<VehicleId, readonly SeatSpec[]>>;
  readonly craft: Readonly<Record<CraftType, readonly SeatSpec[]>>;
  readonly person: { readonly foot: readonly SeatSpec[]; readonly bike: readonly SeatSpec[] };
  readonly avatar: readonly SeatSpec[];
} = {
  car: { car: withPassengers(DRIVER, 3), coupe: withPassengers(DRIVER, 1), van: withPassengers(DRIVER, 2), pickup: withPassengers(DRIVER, 1),
    bus: withPassengers(DRIVER, 30), moto: withPassengers(DRIVER, 1), camper: withPassengers(DRIVER, 3) },
  craft: { boat: Object.freeze([PILOT[0], passenger(0, BOAT_GUN)]), hovercraft: withPassengers(PILOT, 20), helicopter: withPassengers(PILOT, 1), paraglider: PILOT, drone: PILOT, floatplane: PILOT, jet: PILOT,
    fighter: Object.freeze([Object.freeze({ role: 'pilot' as const, index: 0, mount: FIGHTER_GUN })]),
    // (the left door's gun first: the first to board takes a gun)
    gunship: Object.freeze([PILOT[0], passenger(0, doorGun(1)), passenger(1, doorGun(-1)), passenger(2)]) },
  person: { foot: NONE, bike: NONE },
  avatar: WALKER,
};

/** the mount at seat (of seats), or null */
export function mountOf(seats: readonly SeatSpec[], seat: { role: Role; index: number }): Mount | null {
  return seats.find((q) => q.role === seat.role && q.index === seat.index)?.mount ?? null;
}

/** where m is in the world on a vehicle at pose p (turned with its heading, and its nose's pitch if given: a hull's
 * pitch and roll are drawn, an aircraft's nose aims its gun) */
export function mountPoint(m: Mount, p: Pose & { pitch?: number }): Vec3 {
  const c = Math.cos(p.h), s = Math.sin(p.h), cp = Math.cos(p.pitch ?? 0), sp = Math.sin(p.pitch ?? 0), a = m.at;
  const y = a.y * cp + a.z * sp, z = a.z * cp - a.y * sp;
  return { x: p.x + a.x * c + z * s, y: p.y + y, z: p.z - a.x * s + z * c };
}

/** heading h and pitch kept within m's swing on a vehicle heading hv (and, for a nose mount, its nose pitched pv): the
 * nearest it reaches, and whether that is at one of its stops */
export function inArc(m: Mount, hv: number, h: number, pitch: number, pv = 0) {
  const mid = hv + m.yaw, off = Math.atan2(Math.sin(h - mid), Math.cos(h - mid)), lo = m.pitch[0] + pv, hi = m.pitch[1] + pv;
  const o = Math.max(-m.arc, Math.min(m.arc, off)), p = Math.max(lo, Math.min(hi, pitch));
  return { h: mid + o, pitch: p, stop: Math.abs(o) >= m.arc - 1e-6 || p <= lo + 1e-6 || p >= hi - 1e-6 };
}
