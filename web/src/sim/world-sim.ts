// The world sim's one host (docs/adr/0006-world-sim-seam.md, 0007, 0008): what a server would create and tick, and
// what the viewer (main.ts) and the tools (life-edit.mjs, life-phys.mjs, popin-check.mjs) create and tick the same
// way. It owns the street traffic (traffic.ts, with the trains and the river boats) and, once loaded, the road physics
// (physics/rapier/life-phys.ts, through the loader it is given: Rapier is loaded only when needed). No three.js, no
// DOM, no fetch (tools/core-deps.mjs).
//   inputs:   update(dt, { hour, day, focus, viewer }), edited(box, cleared), setBoats, setWorld (ground and water);
//             the players' commands, keyed by player id (takeWheel, input, releaseWheel, resetDriver)
//   outputs:  the traffic's state (drawn by view/life.ts StreetLife between its last two ticks), the players' reads
//             (driverSnapshot, driverNotes), and the events of the last update (events: struck, dropped)
import type { LifePhysics } from '../physics/rapier/life-phys';
import type { CarInput } from '../physics/rapier/car';
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import type { BoatData } from './boat-traffic';
import type { WaterColumns } from './river';
import { DEFAULT_SEED, Traffic, type Ground } from './traffic';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import type { Person, TrafficData } from './types';
import type { VehicleId } from './vehicles';

export type PlayerId = string;

/** what one update is given: the world's hour and day of the year, the focus (the middle of what is simulated) and
 * the viewer (where agents may come and go unseen far from; by default the focus) */
export interface SimInput {
  hour: number;
  day?: number;
  focus: { x: number; z: number };
  viewer?: { x: number; z: number; y?: number };
}

/** what happened in the ticks of the last update: people knocked down by a driven car, people fallen into a hole */
export interface SimEvents {
  struck: Traffic['struck'];
  dropped: Person[];
}

export class WorldSim {
  readonly traffic: Traffic;
  /** the events of the last update (a new object each update) */
  events: SimEvents = { struck: [], dropped: [] };
  private phys: LifePhysics | null = null;
  private loading: Promise<LifePhysics> | null = null;

  /** the world's tuning (read-only, sim/tuning.ts); the physics loader is given it */
  readonly tuning: Tuning;

  /** loadPhysics: makes the road physics with the world's tuning (Rapier initialised, its tiles from a cache or a
   * load) */
  constructor(data: TrafficData, private readonly opts: {
    seed?: number; tuning?: Tuning; loadPhysics?: (tuning: Tuning) => Promise<LifePhysics>;
  } = {}) {
    this.traffic = new Traffic(data, opts.seed ?? DEFAULT_SEED);
    this.tuning = opts.tuning ?? DEFAULT_TUNING;
  }

  /** the road physics, once loaded (loadPhysics) */
  get physics() { return this.phys; }
  /** the world's tick: the number of ticks run */
  get tick() { return this.traffic.tickNumber; }
  get ground() { return this.traffic.ground; }

  /** the world the agents stand on and the boats float on (world.ts World) */
  setWorld(ground: Ground | null, water: WaterColumns | null = null) {
    this.traffic.ground = ground;
    this.traffic.water = water;
  }

  setBoats(data: BoatData) { this.traffic.setBoats(data); }

  /** box (map metres [x0, z0, x1, z1)) was edited, or, cleared, is its files' again */
  edited(box: [number, number, number, number], cleared = false) { this.traffic.edited(box, cleared); }

  /** the road physics loaded (once; again after a failure) and attached to the traffic; warm: where the terrain's
   * colliders are wanted soon (a drive about to start) */
  async loadPhysics(warm?: { x: number; z: number }) {
    const load = this.opts.loadPhysics;
    if (!load) throw new Error('WorldSim: no physics loader');
    this.loading ??= load(this.tuning).then((p) => {
      this.phys = p;
      this.traffic.bodies = p;
      return p;
    }).catch((error) => { this.loading = null; throw error; });
    const p = await this.loading;
    if (warm) await p.warmTerrain(warm);
    return p;
  }

  /** the ticks due after dt s (Traffic.update); events: what they did */
  update(dt: number, { hour, day, focus, viewer }: SimInput) {
    const T = this.traffic;
    if (day !== undefined) T.day = day;
    T.update(dt, hour, focus, viewer);
    this.events = { struck: T.struck, dropped: T.dropped };
    T.struck = [];
    T.dropped = [];
  }

  // ------------------------------------------------------------------ the players (ADR 0007), keyed by player id
  // The commands take effect at the start of the next tick; they need the road physics (loadPhysics), and are ignored
  // without it. takeWheel and its reads are the driver's seat of a vehicle (ADR 0008: control per seat; other seats
  // would be commands of their own). Only players with sim authority come here: a creative camera (orbit, free flight)
  // is the client's and only moves the focus and the viewer.
  takeWheel(player: PlayerId, entityId: number, choice?: VehicleId) { this.phys?.takeWheel(player, entityId, choice); }
  input(player: PlayerId, input: CarInput) { this.phys?.input(player, input); }
  releaseWheel(player: PlayerId) { this.phys?.releaseWheel(player); }
  resetDriver(player: PlayerId) { this.phys?.resetDriver(player); }
  /** the player's car now, or null while they drive none */
  driverSnapshot(player: PlayerId): DriverSnapshot | null { return this.phys?.driverSnapshot(player) ?? null; }
  /** what the player is to be told since the last call */
  driverNotes(player: PlayerId): DriveNote[] { return this.phys?.driverNotes(player) ?? []; }
}
