// (the page offers a free seat and draws who sits where by it; the host, Entities, holds them to it)
import type { Vec3 } from '../core/vec';
import type { Pose } from './contract/pose';
import type { CraftType, Role, VehicleId, WeaponId } from './contract/ids';

/** a weapon fixed to a seat (a mount): its weapon, the point a shot leaves from in the vehicle's frame (x to its left,
 * y up from its origin, z ahead: the gunner's eyes), the middle of its swing off the bow (rad, in the sense of a
 * heading: + to the left), how far it swings either side of that, and its pitch's limits (rad, up) */
export interface Mount { readonly weapon: WeaponId; readonly at: Readonly<Vec3>; readonly yaw: number; readonly arc: number; readonly pitch: readonly [number, number] }

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

/** the seats of each kind's model, by type: a vehicle's driver's or pilot's and its passengers' (the hovercraft's
 * cabin, the helicopter's bench, the speedboat's seat beside its wheel, a car's front and back seats; a craft flown
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
  craft: { boat: Object.freeze([PILOT[0], Object.freeze({ role: 'passenger' as const, index: 0, mount: BOAT_GUN })]), hovercraft: withPassengers(PILOT, 20), helicopter: withPassengers(PILOT, 3), paraglider: PILOT, drone: PILOT, floatplane: PILOT, jet: PILOT },
  person: { foot: NONE, bike: NONE },
  avatar: WALKER,
};

/** the mount at seat (a passenger's of seats), or null */
export function mountOf(seats: readonly SeatSpec[], seat: { role: Role; index: number }): Mount | null {
  return seats.find((q) => q.role === seat.role && q.index === seat.index)?.mount ?? null;
}

/** where m is in the world on a vehicle at pose p (turned with its heading only: the hull's pitch and roll are drawn) */
export function mountPoint(m: Mount, p: Pose): Vec3 {
  const c = Math.cos(p.h), s = Math.sin(p.h), a = m.at;
  return { x: p.x + a.x * c + a.z * s, y: p.y + a.y, z: p.z - a.x * s + a.z * c };
}

/** heading h and pitch kept within m's swing on a vehicle heading hv: the nearest it reaches, and whether that is at
 * one of its stops */
export function inArc(m: Mount, hv: number, h: number, pitch: number) {
  const mid = hv + m.yaw, off = Math.atan2(Math.sin(h - mid), Math.cos(h - mid));
  const o = Math.max(-m.arc, Math.min(m.arc, off)), p = Math.max(m.pitch[0], Math.min(m.pitch[1], pitch));
  return { h: mid + o, pitch: p, stop: Math.abs(o) >= m.arc - 1e-6 || p <= m.pitch[0] + 1e-6 || p >= m.pitch[1] - 1e-6 };
}
