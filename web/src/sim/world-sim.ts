// The world sim's one host (docs/adr/0006-world-sim-seam.md, 0007, 0008): what a server would create and tick, and
// what the viewer (main.ts) and the tools (life-edit.mjs, life-phys.mjs, popin-check.mjs) create and tick the same
// way. It owns the street traffic (traffic.ts, with the trains and the river boats) and, once loaded, the road physics
// (physics/rapier/life-phys.ts, through the loader it is given: Rapier is loaded only when needed). No three.js, no
// DOM, no fetch (tools/core-deps.mjs).
//   inputs:   update(dt, { hour, day, focus, viewer }), edited(box, cleared), setBoats, setWorld (ground and water);
//             the players' commands, keyed by player id: follow; a seat taken and left (the driver's: takeWheel,
//             input, releaseWheel, resetDriver; the walked person's: walkAs, walkPose, release)
//   outputs:  the traffic's state (drawn by view/life.ts StreetLife between its last two ticks), the players' reads
//             (seat, walkedPose, driverSnapshot, driverNotes), and the events of the last update (events: struck,
//             dropped)
import type { LifePhysics } from '../physics/rapier/life-phys';
import type { CarInput } from '../physics/rapier/car';
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import type { BoatData } from './boat-traffic';
import type { WaterColumns } from './river';
import { DEFAULT_SEED, Traffic, type Ground } from './traffic';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import type { EntityRef, Person, TrafficData, WalkPose } from './types';
import type { VehicleId } from './vehicles';

export type PlayerId = string;
/** the viewer's own player (a solo viewer has one; a server would number its clients' players) */
export const LOCAL_PLAYER: PlayerId = 'local';

/** a player's place on an entity (ADR 0008: control per seat): the driver's seat of a car (takeWheel), or the one seat
 * of a person walked (walkAs). A seat holds at most one player; other seats and roles would be added here. */
export type Seat = { entity: EntityRef & { kind: 'car' }; role: 'driver' } | { entity: EntityRef & { kind: 'person' }; role: 'walker' };

/** what the sim keeps of a player: the entity followed (kept in the sim wherever it goes, no rights over it), the
 * person walked as and where the player put them (the walk itself is the client's, sent as a pose) */
export interface PlayerState { follow?: EntityRef; walkingAs?: number; pose?: WalkPose }

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
  /** the players, by id (follow, walkAs; the drivers are the road physics': driverSnapshot) */
  readonly players = new Map<PlayerId, PlayerState>();
  // the person walked, by person id: by whom
  private readonly walkers = new Map<number, PlayerId>();
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
  // A player holds at most one seat on an entity (ADR 0008: control per seat, Seat): the driver's of a car (takeWheel)
  // or the one of a person walked (walkAs); other seats and roles would be commands of their own. Following carries
  // no rights. Only players with sim authority come here: a creative camera (orbit, free flight) is the client's and
  // only moves the focus and the viewer.
  // follow, walkAs, walkPose and release are recorded at once; the traffic reads them in its next tick.

  /** the player follows entity (kept in the sim wherever it goes; no rights over it), or, null, none */
  follow(player: PlayerId, entity: EntityRef | null) {
    const P = this.player(player);
    if (entity) P.follow = { kind: entity.kind, id: entity.id };
    else delete P.follow;
    this.held();
  }

  /** the player takes the seat of person personId (walks as them), from pose (where they are drawn); false: no such
   * person in the crowd, or another player walks as them. A person walked before is let go. */
  walkAs(player: PlayerId, personId: number, pose: WalkPose) {
    const by = this.walkers.get(personId);
    if (by !== undefined && by !== player) return false;
    if (!this.traffic.people.some((p) => p.id === personId)) return false;
    this.release(player);
    const P = this.player(player);
    P.walkingAs = personId;
    P.pose = { ...pose };
    this.walkers.set(personId, player);
    this.held();
    return true;
  }

  /** where the player walking as a person puts them now (their walk is the client's); ignored while walking as none */
  walkPose(player: PlayerId, pose: WalkPose) {
    const P = this.players.get(player);
    if (P?.walkingAs !== undefined) P.pose = { ...pose };
  }

  /** the player leaves the person walked: back to the crowd's own walk from where they are on their way */
  release(player: PlayerId) {
    const P = this.players.get(player);
    if (P?.walkingAs === undefined) return;
    this.walkers.delete(P.walkingAs);
    delete P.walkingAs;
    delete P.pose;
    this.held();
  }

  /** where person personId is put by the player walking as them, or null while none does */
  walkedPose(personId: number): WalkPose | null {
    const by = this.walkers.get(personId);
    return by === undefined ? null : this.players.get(by)?.pose ?? null;
  }

  /** the seat the player holds: the walked person's, else the driver's of the car they drive, else null */
  seat(player: PlayerId): Seat | null {
    const P = this.players.get(player);
    if (P?.walkingAs !== undefined) return { entity: { kind: 'person', id: P.walkingAs }, role: 'walker' };
    const car = this.driverSnapshot(player);
    return car ? { entity: { kind: 'car', id: car.entityId }, role: 'driver' } : null;
  }

  private player(id: PlayerId) {
    let P = this.players.get(id);
    if (!P) this.players.set(id, P = {});
    return P;
  }

  // the traffic's held and walked ids, from the players
  private held() {
    const { held, walked } = this.traffic;
    held.car.clear(); held.person.clear(); walked.clear();
    for (const P of this.players.values()) {
      if (P.follow) held[P.follow.kind].add(P.follow.id);
      if (P.walkingAs !== undefined) { held.person.add(P.walkingAs); walked.add(P.walkingAs); }
    }
  }

  // The driver's seat: these take effect at the start of the next tick; they need the road physics (loadPhysics), and
  // are ignored without it.
  takeWheel(player: PlayerId, entityId: number, choice?: VehicleId) { this.phys?.takeWheel(player, entityId, choice); }
  input(player: PlayerId, input: CarInput) { this.phys?.input(player, input); }
  releaseWheel(player: PlayerId) { this.phys?.releaseWheel(player); }
  resetDriver(player: PlayerId) { this.phys?.resetDriver(player); }
  /** the player's car now, or null while they drive none */
  driverSnapshot(player: PlayerId): DriverSnapshot | null { return this.phys?.driverSnapshot(player) ?? null; }
  /** what the player is to be told since the last call */
  driverNotes(player: PlayerId): DriveNote[] { return this.phys?.driverNotes(player) ?? []; }
}
