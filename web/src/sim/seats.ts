// (the page offers a free seat and draws who sits where by it; the host, Entities, holds them to it)
import type { CraftType, Role, VehicleId } from './contract/ids';

/** a seat of an entity's model: its role and which of that role's seats (0: the first) */
export interface SeatSpec { readonly role: Role; readonly index: number }

const one = (role: Role): readonly SeatSpec[] => Object.freeze([Object.freeze({ role, index: 0 })]);
const DRIVER = one('driver'), PILOT = one('pilot'), WALKER = one('walker'), NONE: readonly SeatSpec[] = Object.freeze([]);
// the driver's or pilot's seat and n passengers' after it
const withPassengers = (first: readonly SeatSpec[], n: number): readonly SeatSpec[] =>
  Object.freeze([...first, ...Array.from({ length: n }, (_, index) => Object.freeze({ role: 'passenger' as const, index }))]);
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
  craft: { boat: withPassengers(PILOT, 1), hovercraft: withPassengers(PILOT, 20), helicopter: withPassengers(PILOT, 3), paraglider: PILOT, drone: PILOT, floatplane: PILOT, jet: PILOT },
  person: { foot: NONE, bike: NONE },
  avatar: WALKER,
};
