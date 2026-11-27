// The world's entities, one index over the kinds' own stores: a car
// (Traffic, the road physics), a person (Traffic's crowd and riders, a walked one where its walker puts it), a craft
// (WorldSim.crafts), an avatar (a player's own body: WorldSim, where its walker puts it). Each kind keeps its storage and its numbering (Car.id picks the traffic vehicle's type); this
// reads them through one adapter per kind. Read only. No three.js, no DOM (tools/core-deps.mjs).
//   exists(ref)   the entity is in the world
//   pose(ref)     where it is (map metres, heading h: 0 +z, pi/2 +x), or null: gone, or not put down
//   seats(ref)    the seats its model has, by its kind and type (SEATS; the seat table, WorldSim, says who holds them)
// (EntityRef, Role, Seat: contract/ids.ts)
import type { CraftType, EntityKind, EntityRef, Role, Seat, VehicleId } from './contract/ids';
import type { Pose } from './contract/pose';

/** a seat of an entity's model: its role and which of that role's seats (0: the first) */
export interface SeatSpec { readonly role: Role; readonly index: number }

const one = (role: Role): readonly SeatSpec[] => Object.freeze([Object.freeze({ role, index: 0 })]);
const DRIVER = one('driver'), PILOT = one('pilot'), WALKER = one('walker'), NONE: readonly SeatSpec[] = Object.freeze([]);
// the driver's or pilot's seat and n passengers' after it
const withPassengers = (first: readonly SeatSpec[], n: number): readonly SeatSpec[] =>
  Object.freeze([...first, ...Array.from({ length: n }, (_, index) => Object.freeze({ role: 'passenger' as const, index }))]);
/** the seats of each kind's model, by type: a vehicle's driver's or pilot's and its passengers' (the hovercraft's
 * cabin, the helicopter's bench, a car's front and back seats; a craft flown alone has none), a walker's on a person
 * on foot (none on a bike) */
export const SEATS: {
  readonly car: Readonly<Record<VehicleId, readonly SeatSpec[]>>;
  readonly craft: Readonly<Record<CraftType, readonly SeatSpec[]>>;
  readonly person: { readonly foot: readonly SeatSpec[]; readonly bike: readonly SeatSpec[] };
  readonly avatar: readonly SeatSpec[];
} = {
  car: { car: withPassengers(DRIVER, 3), coupe: withPassengers(DRIVER, 1), van: withPassengers(DRIVER, 2), pickup: withPassengers(DRIVER, 1),
    bus: withPassengers(DRIVER, 30), moto: withPassengers(DRIVER, 1), camper: withPassengers(DRIVER, 3) },
  craft: { boat: PILOT, hovercraft: withPassengers(PILOT, 20), helicopter: withPassengers(PILOT, 3), paraglider: PILOT, drone: PILOT, floatplane: PILOT, jet: PILOT },
  person: { foot: WALKER, bike: NONE },
  avatar: WALKER,
};

/** a kind's store, read: what Entities asks of it */
export interface KindCore {
  exists(id: number): boolean;
  pose(id: number): Pose | null;
  seats(id: number): readonly SeatSpec[];
}

export class Entities {
  constructor(private readonly kinds: Readonly<Record<EntityKind, KindCore>>) {}

  exists(ref: EntityRef) { return this.kinds[ref.kind].exists(ref.id); }
  pose(ref: EntityRef): Pose | null { return this.kinds[ref.kind].pose(ref.id); }
  /** its seats ([] once gone) */
  seats(ref: EntityRef): readonly SeatSpec[] { return this.exists(ref) ? this.kinds[ref.kind].seats(ref.id) : NONE; }
  /** the seat of entity ref with role (any: its first) and index (any: the first of the role), or null: none such */
  seat(ref: EntityRef, role?: Role, index?: number): Seat | null {
    const s = this.seats(ref).find((q) => (role === undefined || q.role === role) && (index === undefined || q.index === index));
    return s ? { entity: { kind: ref.kind, id: ref.id }, role: s.role, index: s.index } : null;
  }
}
