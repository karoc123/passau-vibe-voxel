// A car's chassis and raycast wheels on Rapier (DynamicRayCastVehicleController), with no three.js and no DOM: what the
// player's car (car.ts RapierCar: its assists and its mesh on top) and the traffic's bodies (life-phys.ts) are built
// from, so the world sim runs headless (tools/core-deps.mjs).
import RAPIER from '@dimforge/rapier3d-compat';
import { CAR_GROUPS } from './terrain';
import { busBuild, VEHICLES, type CarBuild } from '../../sim/vehicles';

// what is driven (sim/vehicles.ts: the catalog, its CarBuild): the car, a bus of `len` m
export type { CarBuild } from '../../sim/vehicles';
export const CAR: CarBuild = VEHICLES.car.build;
export const bus = busBuild;
export const WHEEL_R = 0.36;
export const REST = 0.35;
export const MAX_SUSPENSION_FORCE = 60000; // N a wheel
// The ride. Rapier's raycast wheels have no mass of their own: each pushes the chassis with
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
//   Rapier), kinkMax: ... where it differs from the facet's by less than this (normals' distance; see dampers())
// tools/rapier-car.mjs --set key=value,... runs the scenarios with others.
export const RIDE = {
  stiffness: 34, compression: 4, relaxation: 5.5, gravity: 1.25, downforce: 0.4, gripFront: 1.6, gripRear: 1.5, side: 1, com: 0.45,
  patch: 0.8, kinkMax: 0.08,
};
// a number of the ride for `build`: its own (CarBuild tune), else RIDE's
export const rideOf = (build: CarBuild, k: 'stiffness' | 'compression' | 'relaxation' | 'downforce' | 'gripFront' | 'gripRear' | 'side' | 'com') => build.tune?.[k] ?? RIDE[k];

// The chassis (a box, its bottom 0.25 m over the wheels' axles; its centre of mass low, under the floor: it rolls
// less) and the wheels of `build` at `at` (physics coordinates), rotated q. walls: no friction or bounce against the
// world (it glances along a wall: car.ts tuning.walls), else a little friction.
export function createVehicle(R: typeof RAPIER, world: RAPIER.World, at: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number },
  build: CarBuild, walls: boolean) {
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q)
    .setCanSleep(false).setCcdEnabled(true).setAngularDamping(0.4).setGravityScale(RIDE.gravity));
  const HALF = build.half, MASS = build.mass;
  const inertia = { x: MASS * (HALF.y ** 2 + HALF.z ** 2) / 3, y: MASS * (HALF.x ** 2 + HALF.z ** 2) / 3, z: MASS * (HALF.x ** 2 + HALF.y ** 2) / 3 };
  // (a plain box: a rounded one (roundCuboid) glances no better and costs 3x the contact time against voxels)
  const desc = R.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setTranslation(0, HALF.y - 0.45, 0);
  desc.setMassProperties(MASS, { x: 0, y: -rideOf(build, 'com') - (HALF.y - 0.45), z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
    .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(CAR_GROUPS);
  if (walls) desc.setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0).setRestitutionCombineRule(R.CoefficientCombineRule.Min);
  else desc.setFriction(0.3);
  const chassis = world.createCollider(desc, body);
  const c = world.createVehicleController(body);
  c.indexUpAxis = 1;
  c.setIndexForwardAxis = 2;
  for (const w of build.wheels) {
    c.addWheel({ x: w.x, y: -0.2, z: w.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_R);
    const i = c.numWheels() - 1;
    c.setWheelSuspensionStiffness(i, rideOf(build, 'stiffness'));
    c.setWheelSuspensionCompression(i, rideOf(build, 'compression'));
    c.setWheelSuspensionRelaxation(i, rideOf(build, 'relaxation'));
    c.setWheelMaxSuspensionTravel(i, 0.35);
    c.setWheelMaxSuspensionForce(i, MAX_SUSPENSION_FORCE);
    c.setWheelFrictionSlip(i, rideOf(build, w.front ? 'gripFront' : 'gripRear'));
    c.setWheelSideFrictionStiffness(i, rideOf(build, 'side'));
  }
  return { body, chassis, controller: c };
}

// The first step of a world with voxels in it costs ~100 ms (and more in a busy page) once, whatever is in it: taken
// here, in a throwaway world, with the load, instead of as a hitch on the first frame a body moves.
export function warmUp() {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const vox: number[] = [];
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) vox.push(x, 0, z, x, x === 7 ? 1 : 0, z);
  w.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(vox), { x: 1, y: 1, z: 1 }));
  w.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([0, 1, 0, 8, 1, 0, 8, 1, 8]), new Uint32Array([0, 2, 1])));
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 1.5, 3));
  const col = w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.45, 2), b);
  const k = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(6, 1.5, 6));
  w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.7, 2), k);
  const c = w.createVehicleController(b);
  c.addWheel({ x: 0, y: -0.2, z: 0 }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.35, 0.36);
  for (let i = 0; i < 3; i++) {
    c.updateVehicle(1 / 60);
    w.castShape(b.translation(), b.rotation(), { x: 1, y: 0, z: 0 }, col.shape, 0.02, 2, false, undefined, undefined, col);
    k.setNextKinematicTranslation({ x: 6, y: 1.5, z: 6 + i * 0.1 });
    w.step();
  }
  w.free();
}
