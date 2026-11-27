// The driver's own car on their page (client/predict-car.ts runs it ahead of the host): a Rapier world of its own
// with that car alone and the terrain round it, stepped as the host's road physics steps the car (life-phys.ts tick:
// the terrain built round it first, then SUB steps, RapierCar's step and afterStep round each) with the host's code.
// What else the host's car meets (the traffic's bodies, other players' cars, coaches, crafts) is not in it: the
// host's word on those comes a round trip later, as a correction.
import RAPIER from '@dimforge/rapier3d-compat';
import type { LiveEdits } from '../../core/live-edits';
import type { Meta } from '../../core/meta';
import type { TileCache } from '../../core/tile-cache';
import type { CarInput } from '../../sim/contract/inputs';
import type { CarBody } from '../../sim/contract/snapshot';
import { STEP as TICK } from '../../sim/road-net';
import { buildOf } from '../../sim/vehicles';
import { DEFAULT_TUNING } from '../../sim/tuning';
import { RapierCar } from './car';
import { Tank } from '../../sim/tank';
import { mapOrigin, SUB } from './life-phys';
import { RapierTerrain, type TerrainOptions } from './terrain';
import { createVehicle, warmUp } from './vehicle';

// m: the colliders round the car, and how near an unbuilt one keeps it from moving (the host's, life-phys.ts)
const REACH = 24, NEED_NOW = 12;

export class OwnCar {
  private readonly world: RAPIER.World;
  private readonly terrain: RapierTerrain;
  private readonly origin: { x: number; z: number };
  private car: RapierCar | null = null;
  // which build the car's body is of (a type and length)
  private kind = '';
  // the clock the terrain's chunks age by (ms): a tick each step, replays too
  private clock = 0;

  /** Rapier initialised (load). cache: the page's node files; edits: its client's (they rebuild the colliders);
   * terrain: what differs from the page's (a tool's chunks built all at once) */
  constructor(meta: Meta, cache: TileCache, edits: LiveEdits, terrain: TerrainOptions = {}) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = TICK / SUB;
    this.origin = mapOrigin(meta);
    this.terrain = new RapierTerrain(RAPIER, this.world, meta, this.origin, { reach: REACH, needNow: NEED_NOW, budgetMs: 1, ...terrain, cache, edits });
  }

  static async load(meta: Meta, cache: TileCache, edits: LiveEdits, terrain: TerrainOptions = {}) {
    await RAPIER.init();
    warmUp();
    return new OwnCar(meta, cache, edits, terrain);
  }

  /** the car of c's type at body b: a new body when the type differs from the one before */
  put(c: { vt?: string; bus: boolean; len: number }, b: CarBody) {
    const kind = `${c.vt ?? ''}|${c.bus}|${c.len}`;
    if (kind !== this.kind || !this.car) {
      this.drop();
      const build = buildOf(c as Parameters<typeof buildOf>[0]), ride = DEFAULT_TUNING.ride;
      const v = createVehicle(RAPIER, this.world, { x: b.p[0] - this.origin.x, y: b.p[1], z: b.p[2] - this.origin.z }, { x: b.q[0], y: b.q[1], z: b.q[2], w: b.q[3] }, build, true, ride);
      this.car = new RapierCar(RAPIER, this.world, v.body.translation(), v.body.rotation(), this.terrain, undefined, build, v, ride);
      this.car.tank = new Tank(DEFAULT_TUNING.fuel.car);
      this.kind = kind;
    }
    this.load(b);
  }

  save(): CarBody { return this.car!.save(this.origin); }
  load(b: CarBody) { this.car!.load(b, this.origin); }

  /** one host's tick with input; false (not stepped) while the ground round it is not built */
  tick(input: CarInput): boolean {
    const car = this.car!, b = car.body, p = b.translation(), v = b.linvel();
    this.clock += TICK * 1000;
    const [ready] = this.terrain.update([{ x: p.x + this.origin.x, z: p.z + this.origin.z, vx: v.x, vz: v.z }], this.clock);
    if (!ready) return false;
    for (let k = 0; k < SUB; k++) {
      car.step(input, TICK / SUB);
      this.world.step();
      car.afterStep(TICK / SUB);
    }
    return true;
  }

  /** the rear wheels' offset along the car (a wheelie lifts it by it) */
  get wheelZ() { return this.car!.build.wheels[2].z; }

  /** the car gone (its body; the terrain kept for the next) */
  drop() {
    this.car?.dispose(this.world);
    this.car = null;
    this.kind = '';
  }
}
