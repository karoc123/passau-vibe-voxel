import type { CraftType, VehicleId } from '../sim/contract/ids';
import { CRAFT_SCALE, GLIDER_HEIGHT } from '../sim/craft/craft-motion';
import { SEATS } from '../sim/seats';

// Where a passenger sits in each vehicle's look: the hips' point in its frame (x to its left, y up from its origin, z
// ahead, metres as drawn: a scaled look's numbers times its scale) and how far forward the legs reach from hanging
// (rad). Read off the looks (sim/vehicles.ts models, view/crafts/): rows across the cabin from the front, the
// driver's place left free. A seat index past a table's end sits on its last row's place. A car's seats are under
// its side windows (view/meshes.ts opens the cabin of a car someone sits in), so the heads show in them.

/** a passenger's seat in a vehicle's frame */
export interface SeatPlace { x: number; y: number; z: number; legs: number }

const SIT = 1.35;
// rows of seats at heights y, across at xs, from z0 back by dz
const rows = (n: number, xs: readonly number[], y: number, z0: number, dz: number, legs = SIT): SeatPlace[] =>
  Array.from({ length: n }, (_, i) => ({ x: xs[i % xs.length], y, z: z0 - Math.floor(i / xs.length) * dz, legs }));
const at = (x: number, y: number, z: number, legs = SIT): SeatPlace => ({ x, y, z, legs });
const scaled = (s: number, p: SeatPlace[]) => p.map((q) => ({ ...q, x: q.x * s, y: q.y * s, z: q.z * s }));

const CARS: Record<VehicleId, SeatPlace[]> = {
  car: [at(-0.4, 0.55, 0.15), at(0.4, 0.55, -0.85), at(-0.4, 0.55, -0.85)],
  coupe: [at(-0.38, 0.25, -0.5)],
  van: [at(0, 0.9, 1.4), at(-0.55, 0.9, 1.4)],
  pickup: [at(-0.4, 0.6, 0.6)],
  // (four across behind the driver, the rows over a 12 m bus: one of another length stretches them with it)
  bus: rows(SEATS.car.bus.length - 1, [0.85, 0.4, -0.4, -0.85], 1.0, 3.6, 1.15),
  camper: [at(-0.45, 1.05, 2.35), at(0.45, 1.2, -1.4), at(-0.45, 1.2, -1.4)],
  // (the pillion behind the bike's own rider, the legs down its sides)
  moto: [at(0, 0.88, -0.6, 0.45)],
};

// the hovercraft's cabin: five rows of four between its window pillars, the hips under the window band so that the
// chest and head are in it and under its roof; the helicopter's three behind its door windows, low enough for the head
// to stay under the cabin's roof, the middle one a little back so that the shoulders do not meet
const CRAFTS: Partial<Record<CraftType, SeatPlace[]>> = {
  hovercraft: rows(20, [1.55, 0.85, -0.85, -1.55], 1.0, 3.55, 0.82),
  helicopter: scaled(CRAFT_SCALE.helicopter, [at(0.45, 0.05, 0.3), at(-0.45, 0.05, 0.3), at(0, 0.05, -0.1)]),
};

// The pilots: the helicopter's front right under its front glass; the hovercraft's in the wheelhouse on the cabin's
// roof, starboard of its middle mullion, the legs bent level so that the shoes stay over the cabin's ceiling; the
// speedboat's at its wheel; the floatplane's in the left seat, the shoulders inside the cabin's sides; the jet's in
// the front seat, low enough for the head alone to be in the canopy and the shoes over the belly; the paraglider's in
// its harness (the motion's point is the pilot's middle, GLIDER_HEIGHT over the feet). A drone is flown from afar.
const PILOTS: Partial<Record<CraftType, SeatPlace>> = {
  helicopter: scaled(CRAFT_SCALE.helicopter, [at(-0.4, 0.03, 1.4)])[0],
  hovercraft: at(-0.5, 2.3, 3.0, 1.45),
  boat: at(-0.45, 1.05, -0.2, 1.1),
  floatplane: at(0.2, 0.2, 1.2),
  jet: at(0, -0.3, 1.9, 1.5),
  paraglider: at(0, 0.87 - GLIDER_HEIGHT, -0.05),
};

// the driver's beside the front passenger's (left-hand drive); a motorbike's rider is part of its model
const DRIVERS: Partial<Record<VehicleId, SeatPlace>> = {
  car: at(0.4, 0.55, 0.15), coupe: at(0.38, 0.25, -0.5), van: at(0.55, 0.9, 1.4), pickup: at(0.4, 0.6, 0.6),
  bus: at(0.75, 1.0, 5.0), camper: at(0.45, 1.05, 2.35),
};

/** the driver's seat in a car of type id, or null: its look has its own rider */
export function driverPlace(id: VehicleId): SeatPlace | null { return DRIVERS[id] ?? null; }

/** the pilot's seat in a craft of type, or null: none sits in it */
export function pilotPlace(type: CraftType): SeatPlace | null { return PILOTS[type] ?? null; }

// The seat view's eyes: a little over the middle of the head and ahead of its face, so that the own head (not drawn
// then) would not be in the way; the near plane there short enough that a neighbour's shoulder (~0.4 m off) is not cut
/** where a player sitting at p looks from (the same frame as p) */
export const seatEye = (p: SeatPlace) => ({ x: p.x, y: p.y + 0.75, z: p.z + 0.16 });
/** the camera's near plane (m) at the seat view's eyes */
export const SEAT_NEAR = 0.15;

/** passenger seat index's place in a car of type id or a craft of type, or null: its look has none */
export function seatPlace(kind: 'car' | 'craft', type: string, index: number): SeatPlace | null {
  const t = kind === 'car' ? CARS[type as VehicleId] : CRAFTS[type as CraftType];
  return t?.length ? t[Math.min(index, t.length - 1)] : null;
}
