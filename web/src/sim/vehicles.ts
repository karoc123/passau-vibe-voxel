// The vehicle catalog: what can be driven, as data (no three.js, no DOM, no Rapier: the world sim, the player's car and
// a server share it; tools/core-deps.mjs scans it with the sim). Each type: its body on Rapier's raycast wheels
// (physics/rapier/vehicle.ts createVehicle: the chassis' box, mass, wheels, engine, brakes, top speed, and what it
// tunes differently from the ride, RIDE), its length in the traffic, and its model (boxes in its own frame:
// x left, y up from the ground, z forward; drawn by view/meshes.ts). README "Driving": the mix.
import { frozen } from '../core/frozen';
import type { VehicleId } from './contract/ids';

// The chassis and its drive: half extents of the chassis' box (m; its bottom 0.45 m under the body's origin), mass
// (kg), wheels (chassis space; the front ones steer, the rear ones are driven), the engine's force per driven wheel
// (N), the brakes (Rapier's brake impulse a wheel), the top speed (m/s, the engine cut off over it), ride: the ground's
// height under the body's origin at rest. tune: what differs from RIDE (below) and the steering (car.ts: steer,
// the front wheels' most angle, rad; steerFall, m/s: the angle halved at this speed; latG, g: at speed the angle no
// more than turns it at this sideways acceleration, the whole lock asking that and no more; steerRamp, s: the input
// turns the bars from straight to full lock over this long, back twice as fast, instead of at once). bike: a
// two-wheeler (car.ts: kept upright on its wheels, drawn leaning into its turns; its four wheels hidden, two drawn).
export interface CarBuild {
  half: { x: number; y: number; z: number }; mass: number; wheels: { x: number; z: number; front: boolean }[];
  engine: number; brake: number; top: number; ride: number;
  tune?: Tune; bike?: boolean;
}
export interface Tune {
  stiffness?: number; compression?: number; relaxation?: number; downforce?: number; gripFront?: number; gripRear?: number;
  side?: number; com?: number; steer?: number; steerFall?: number; latG?: number; steerRamp?: number;
}

// The ride (physics/rapier/vehicle.ts, car.ts). Rapier's raycast wheels have no mass of their own: each pushes the chassis with
// mass * (stiffness * compression - damping * its speed) (damping: `compression` while it is pushed in, `relaxation`
// while it extends), never pulls, and leaves the ground once its spring is back at its rest length, so it hangs only
// as far as the car sags on it (g * gravity / (4 stiffness): a stiffer spring loses the ground sooner over a crest).
// - stiffness, compression, relaxation: per wheel (heave ~sqrt(stiffness) / pi Hz, damping ratio ~damping /
//   sqrt(stiffness))
// - gravity: the car's own gravity (a multiple of g): how fast it comes back down over a crest
// - downforce: pressed onto its wheels' ground (along its own down) by this many g at 50 km/h, with the speed squared
//   (at most twice that), while a wheel touches: more grip and a body that stays on the road over crests at speed
// - gripFront, gripRear: the tyres' frictionSlip (the most force per load); side: their lateral stiffness
// - com: the centre of mass' drop under the body's origin (m)
// - patch: the dampers take the ground's slope over this many m either side of a wheel's contact (0: the facet's, as
//   Rapier), kinkMax: ... where it differs from the facet's by less than this (normals' distance; see car.ts dampers())
// Read-only (DEFAULT_TUNING.ride, sim/tuning.ts); tools/rapier-car.mjs --set key=value,... runs the scenarios with a
// copy that differs.
export const RIDE = frozen({
  stiffness: 34, compression: 4, relaxation: 5.5, gravity: 1.25, downforce: 0.4, gripFront: 1.6, gripRear: 1.5, side: 1, com: 0.45,
  patch: 0.8, kinkMax: 0.08,
});
export type RideTuning = typeof RIDE;

// A model part: a box w x h x l (m), its bottom centre at (x, y, z), and its colour: 'paint' (the vehicle's own,
// per instance), 'head' or 'tail' (its lamps: lit at night, the tail lamps brighter when braking), or a colour of
// PALETTE
export type Part = [w: number, h: number, l: number, x: number, y: number, z: number, colour: 'paint' | 'head' | 'tail' | keyof typeof PALETTE];
export const PALETTE = {
  tyre: '#161616', glass: '#1d2329', trim: '#2b2b2b', steel: '#8c8f93', jeans: '#2b3240', jacket: '#26292e', skin: '#e0b48f',
};

export interface VehicleType {
  id: VehicleId;
  name: string;
  build: CarBuild;
  len: number; // m: its length in the traffic (its spacing; the drive's obstacles)
  chase: { back: number; up: number }; // m from the vehicle pose at normal zoom
  paint?: string; // its own colour (a bus's yellow), else the traffic car's
  model: Part[];
}

const wheels4 = (x: number, zf: number, zr: number) => [
  { x, z: zf, front: true }, { x: -x, z: zf, front: true }, { x, z: zr, front: false }, { x: -x, z: zr, front: false },
];
// a car's four wheels (boxes, as the traffic's): w x d each, at x either side, front zf and rear zr
const tyres = (x: number, zf: number, zr: number, w = 0.3, d = 0.6, l = 0.7): Part[] =>
  [[w, d, l, -x, 0, zf, 'tyre'], [w, d, l, x, 0, zf, 'tyre'], [w, d, l, -x, 0, zr, 'tyre'], [w, d, l, x, 0, zr, 'tyre']];
// a pair of lamps either side of the middle, `x` out, at height y and z
const lamps = (kind: 'head' | 'tail', x: number, y: number, z: number, w = 0.4, h = 0.2): Part[] =>
  [[w, h, 0.1, -x, y, z, kind], [w, h, 0.1, x, y, z, kind]];

// a bus of `len` m (the traffic's: 12): its chassis as high as its body (the traffic's 2.55 m less the wheels)
export const busBuild = (len: number): CarBuild => ({
  half: { x: 1.25, y: 0.95, z: len / 2 - 0.1 }, mass: 11000, wheels: wheels4(1.1, len / 2 - 2.4, -(len / 2 - 3)),
  engine: 14000, brake: 400, top: 17, ride: 0.84,
});

// (VehicleId, the types' names: contract/ids.ts)

export const VEHICLES: Record<VehicleId, VehicleType> = {
  // the traffic's car, as the player's has always driven (its numbers are tools/rapier-car.mjs's: keep them)
  car: {
    id: 'car', name: 'Car', len: 4.6,
    chase: { back: 9, up: 3.6 },
    build: { half: { x: 0.9, y: 0.45, z: 2.1 }, mass: 1200, wheels: wheels4(0.82, 1.35, -1.3), engine: 2600, brake: 45, top: 22, ride: 0.84 },
    model: [
      [1.8, 0.75, 4.4, 0, 0.3, 0, 'paint'], [1.62, 0.62, 2.3, 0, 1.05, -0.25, 'paint'],
      [1.66, 0.5, 2.2, 0, 1.1, -0.25, 'glass'], [0.3, 0.6, 0.7, -0.8, 0, 1.3, 'tyre'], [0.3, 0.6, 0.7, 0.8, 0, 1.3, 'tyre'],
      [0.3, 0.6, 0.7, -0.8, 0, -1.35, 'tyre'], [0.3, 0.6, 0.7, 0.8, 0, -1.35, 'tyre'],
      ...lamps('head', 0.6, 0.65, 2.2), ...lamps('tail', 0.6, 0.7, -2.2),
    ],
  },
  // fast, low and grippy: twice the car's pull, stiffer and lower, more downforce
  coupe: {
    id: 'coupe', name: 'Coupé', len: 4.6,
    chase: { back: 8.5, up: 3.4 },
    build: {
      half: { x: 0.92, y: 0.36, z: 2.2 }, mass: 1250, wheels: wheels4(0.84, 1.42, -1.38), engine: 4600, brake: 62, top: 50, ride: 0.84,
      tune: { stiffness: 44, compression: 4.6, relaxation: 6.2, downforce: 0.6, gripFront: 2.0, gripRear: 1.95, com: 0.5 },
    },
    model: [
      [1.86, 0.55, 4.5, 0, 0.28, 0, 'paint'], [1.56, 0.42, 1.9, 0, 0.83, -0.4, 'paint'],
      [1.6, 0.34, 1.78, 0, 0.86, -0.38, 'glass'], [1.74, 0.06, 0.4, 0, 1.0, -2.02, 'paint'],
      [0.08, 0.2, 0.08, -0.6, 0.82, -2.02, 'trim'], [0.08, 0.2, 0.08, 0.6, 0.82, -2.02, 'trim'],
      ...tyres(0.82, 1.42, -1.38, 0.32, 0.62, 0.72),
      ...lamps('head', 0.62, 0.58, 2.22, 0.44, 0.12), ...lamps('tail', 0.62, 0.62, -2.22, 0.5, 0.12),
    ],
  },
  // a transporter: heavy, slow, soft
  van: {
    id: 'van', name: 'Van', len: 5.4,
    chase: { back: 10.5, up: 4.2 },
    build: {
      half: { x: 1.0, y: 0.9, z: 2.55 }, mass: 2400, wheels: wheels4(0.88, 1.75, -1.7), engine: 3400, brake: 85, top: 26, ride: 0.84,
      tune: { stiffness: 24, compression: 3.0, relaxation: 4.2, downforce: 0.25, gripFront: 1.4, gripRear: 1.35, steer: 0.5 },
    },
    model: [
      [1.96, 1.8, 5.2, 0, 0.3, 0, 'paint'], [1.98, 0.55, 1.2, 0, 1.3, 1.55, 'glass'], [1.8, 0.6, 0.06, 0, 1.25, 2.6, 'glass'],
      [1.8, 0.55, 0.06, 0, 1.3, -2.6, 'glass'], [1.98, 0.08, 5.22, 0, 0.55, 0, 'trim'],
      ...tyres(0.86, 1.75, -1.7, 0.3, 0.66, 0.72),
      ...lamps('head', 0.68, 0.75, 2.58, 0.36, 0.2), ...lamps('tail', 0.86, 0.9, -2.58, 0.18, 0.38),
    ],
  },
  camper: {
    id: 'camper', name: 'Camper van', len: 6.6, paint: '#e7ddc4',
    chase: { back: 12.5, up: 5 },
    build: {
      half: { x: 1.1, y: 1.17, z: 3.15 }, mass: 3700, wheels: wheels4(0.94, 2.0, -1.83),
      engine: 4600, brake: 125, top: 20, ride: 0.84,
      tune: { stiffness: 29, compression: 3.8, relaxation: 5.2, gripFront: 1.5, gripRear: 1.42, steer: 0.48 },
    },
    model: [
      [2.17, 0.75, 6.4, 0, 0.34, 0, 'paint'], [2.07, 1.35, 1.9, 0, 1.06, 2.15, 'paint'],
      [2.18, 2.36, 4.45, 0, 0.54, -0.96, 'paint'], [2.13, 0.44, 1.55, 0, 2.45, 1.85, 'paint'],
      [1.86, 0.53, 0.06, 0, 1.64, 3.11, 'glass'], [2.09, 0.54, 0.7, 0, 1.64, 2.47, 'glass'],
      [2.2, 0.53, 1.45, 0, 1.78, -1.6, 'glass'], [2.21, 0.11, 4.4, 0, 1.32, -0.96, 'steel'],
      [1.86, 0.53, 0.06, 0, 1.78, -3.2, 'glass'], [0.78, 0.12, 0.67, 0, 2.9, -0.7, 'trim'],
      ...tyres(0.94, 2.0, -1.83, 0.34, 0.72, 0.76),
      ...lamps('head', 0.71, 0.72, 3.2), ...lamps('tail', 0.89, 0.86, -3.2, 0.2, 0.35),
    ],
  },
  // a pickup: between the car and the van, a load bed behind its cab
  pickup: {
    id: 'pickup', name: 'Pickup', len: 5.4,
    chase: { back: 10, up: 4 },
    build: {
      half: { x: 0.95, y: 0.55, z: 2.6 }, mass: 1900, wheels: wheels4(0.86, 1.7, -1.6), engine: 3800, brake: 70, top: 30, ride: 0.84,
      tune: { stiffness: 30, compression: 3.6, relaxation: 5, gripFront: 1.55, gripRear: 1.45 },
    },
    model: [
      [1.9, 0.8, 5.3, 0, 0.35, 0, 'paint'], [1.8, 0.75, 1.9, 0, 1.15, 0.6, 'paint'], [1.84, 0.5, 1.7, 0, 1.2, 0.6, 'glass'],
      [0.1, 0.42, 2.1, -0.9, 1.15, -1.55, 'paint'], [0.1, 0.42, 2.1, 0.9, 1.15, -1.55, 'paint'], [1.9, 0.42, 0.1, 0, 1.15, -2.6, 'paint'],
      [1.7, 0.02, 2.1, 0, 1.15, -1.55, 'trim'],
      ...tyres(0.86, 1.7, -1.6, 0.32, 0.7, 0.76),
      ...lamps('head', 0.66, 0.85, 2.62, 0.4, 0.18), ...lamps('tail', 0.86, 1.1, -2.62, 0.16, 0.36),
    ],
  },
  // the traffic's bus (12 m)
  bus: {
    id: 'bus', name: 'Bus', len: 12, paint: '#f2c230',
    chase: { back: 17, up: 6.8 },
    build: busBuild(12),
    model: [
      [2.5, 1.0, 12, 0, 0.3, 0, 'paint'], [2.52, 1.05, 11.62, 0, 1.3, 0.2, 'glass'], [2.5, 0.55, 12, 0, 2.35, 0, 'paint'],
      [2.52, 0.12, 12.02, 0, 0.6, 0, 'trim'],
      ...tyres(1.06, 3.6, -3, 0.34, 0.9, 1.0),
      ...lamps('head', 0.85, 0.6, 6.0, 0.4, 0.22), ...lamps('tail', 1.0, 0.75, -6.0, 0.3, 0.35),
    ],
  },
  // a motorbike: four wheels under it (hidden, a narrow track: car.ts keeps it upright), two drawn; nimble, quick,
  // leaning into its turns (drawn: car.ts lean). Its steering: a ~2.7 m circle at walking pace (a real bike's ~2.5-3),
  // at speed well inside the car's circle (latG 3.5, the grip to hold it: at a real bike's 1 g it drew full lean on a
  // circle wider than a car's from 25 km/h on), the turn within a quarter second (tools/vehicles.mjs bike_turn)
  moto: {
    id: 'moto', name: 'Motorbike', len: 2.2,
    chase: { back: 6.5, up: 2.6 },
    build: {
      half: { x: 0.32, y: 0.5, z: 1.0 }, mass: 260, wheels: wheels4(0.3, 0.72, -0.72), engine: 1100, brake: 13, top: 39, ride: 0.84,
      tune: { gripFront: 2.4, gripRear: 2.3, com: 0.62, steer: 0.6, steerFall: 22, latG: 3.5, steerRamp: 0.25, downforce: 0.3 },
      bike: true,
    },
    model: [
      [0.14, 0.64, 0.64, 0, 0, 0.72, 'tyre'], [0.16, 0.64, 0.64, 0, 0, -0.72, 'tyre'],
      [0.32, 0.34, 0.62, 0, 0.3, 0, 'trim'], [0.06, 0.06, 1.3, 0, 0.32, 0, 'steel'],
      [0.36, 0.26, 0.62, 0, 0.62, 0.2, 'paint'], [0.3, 0.12, 0.66, 0, 0.74, -0.36, 'trim'], [0.26, 0.14, 0.4, 0, 0.62, -0.72, 'paint'],
      [0.06, 0.62, 0.06, -0.1, 0.32, 0.66, 'steel'], [0.06, 0.62, 0.06, 0.1, 0.32, 0.66, 'steel'],
      [0.4, 0.32, 0.22, 0, 0.78, 0.6, 'paint'], [0.72, 0.05, 0.05, 0, 1.0, 0.46, 'trim'],
      [0.18, 0.12, 0.06, 0, 0.86, 0.72, 'head'], [0.16, 0.08, 0.06, 0, 0.78, -0.93, 'tail'],
      // the rider: legs along the tank, torso leaning on the bars, arms to the grips, a helmet in the bike's colour
      [0.38, 0.2, 0.62, 0, 0.84, -0.12, 'jeans'], [0.12, 0.42, 0.18, -0.21, 0.42, 0.06, 'jeans'], [0.12, 0.42, 0.18, 0.21, 0.42, 0.06, 'jeans'],
      [0.44, 0.56, 0.3, 0, 1.0, -0.22, 'jacket'], [0.1, 0.1, 0.62, -0.25, 1.24, 0.12, 'jacket'], [0.1, 0.1, 0.62, 0.25, 1.24, 0.12, 'jacket'],
      [0.3, 0.3, 0.32, 0, 1.56, -0.12, 'paint'], [0.26, 0.1, 0.06, 0, 1.64, 0.05, 'glass'],
    ],
  },
};
export const VEHICLE_IDS = Object.keys(VEHICLES) as VehicleId[];

// a car of the traffic or the player's (Car: its vt, else a bus or the car)
export function vehicleOf(c: { vt?: VehicleId; bus: boolean }): VehicleType { return VEHICLES[c.vt ?? (c.bus ? 'bus' : 'car')]; }
// what drives it: a bus of its own length, the catalog's otherwise
export function buildOf(c: { vt?: VehicleId; bus: boolean; len: number }): CarBuild {
  const t = vehicleOf(c);
  return t.id === 'bus' ? busBuild(c.len) : t.build;
}

// the box a type's model fills (m): half its width, height and length (its bottom on the ground)
export function modelHalf(t: VehicleType) {
  let x = 0, y = 0, z = 0;
  for (const [w, h, l, px, py, pz] of t.model) { x = Math.max(x, Math.abs(px) + w / 2); y = Math.max(y, py + h); z = Math.max(z, Math.abs(pz) + l / 2); }
  return { x, y: y / 2, z };
}

// Vehicle types are chosen by id without a random draw: about 1 in 14 a coupé, 1 in 12 a van, 1 in 16 a pickup,
// 1 in 20 a motorbike and 1 in 56 a camper van among vehicles other than buses. The rest are cars.
export function trafficType(id: number): VehicleId {
  const k = (Math.imul(id + 1, 2654435761) >>> 0) % 336;
  if (k < 24) return 'coupe';
  if (k < 52) return 'van';
  if (k < 73) return 'pickup';
  if (k < 90) return 'moto';
  if (k < 96) return 'camper';
  return 'car';
}
