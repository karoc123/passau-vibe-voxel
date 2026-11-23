// The world sim's one host (docs/adr/0006-world-sim-seam.md, 0007, 0008): what a server would create and tick, and
// what the viewer (main.ts) and the tools (life-edit.mjs, life-phys.mjs, popin-check.mjs) create and tick the same
// way. It owns the street traffic (traffic.ts, with the trains and the river boats) and, once loaded, the road physics
// (physics/rapier/life-phys.ts, through the loader it is given: Rapier is loaded only when needed). No three.js, no
// DOM, no fetch (tools/core-deps.mjs).
//   inputs:   update(dt, { hour, day, focus, viewer }), edited(box, cleared), setBoats, setWorld (ground and water);
//             the players' commands, keyed by player id: follow; a seat taken and left (the driver's: takeWheel,
//             input, releaseWheel, resetDriver; the walked person's: walkAs, walkPose, release; a craft's pilot's:
//             enterCraft, craftInput, resetCraft, leaveCraft); the crafts made, put down and taken away (addCraft,
//             placeCraft, removeCraft: what a game mode, today the craft's shell, decides)
//   owns:     which of the world's edits are kept (sim/edit-keeper.ts: while a player is near them); the player
//             crafts (sim/craft/craft-core.ts), each stepped at its own fixed step through its own collision, piloted
//             or not; the vehicles players left (a craft no one pilots, a parked car), kept by the edits' rule
//             (edit-keeper.ts Presence: dropped once no player has been near them for a while)
//   outputs:  the traffic's state (drawn by view/life.ts StreetLife between its last two ticks), the crafts' (crafts:
//             their cores, read by their shells in nav/), the players' reads (seat, walkedPose, driverSnapshot,
//             driverNotes, craftOf, craftEvents), and the events, each with the tick that produced it
//             (eventsSince: struck, dropped), so several readers can each take theirs
import type { LifePhysics } from '../physics/rapier/life-phys';
import type { CarInput } from '../physics/rapier/car';
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import type { BoatData } from './boat-traffic';
import type { WaterColumns } from './river';
import { EditKeeper, Presence } from './edit-keeper';
import { DEFAULT_SEED, STEP, Traffic, type Ground } from './traffic';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import type { EntityRef, Person, RoadPose, TrafficData, WalkPose } from './types';
import type { VehicleId } from './vehicles';
import type { Meta } from '../types';
import type { TileCache } from '../core/tile-cache';
import type { CraftCore, CraftSpot } from './craft/craft-core';
import { CORES, type CoreOf, type CraftType } from './craft/cores';
import { VoxelCollision } from './craft/voxel-collision';

export type PlayerId = string;
/** the viewer's own player (a solo viewer has one; a server would number its clients' players) */
export const LOCAL_PLAYER: PlayerId = 'local';

export type CraftId = number;

/** a player's place on an entity (ADR 0008: control per seat): the driver's seat of a car (takeWheel), the one seat
 * of a person walked (walkAs), or the pilot's seat of a craft (enterCraft). A seat holds at most one player; other
 * seats and roles would be added here. */
export type Seat = { entity: EntityRef & { kind: 'car' }; role: 'driver' } | { entity: EntityRef & { kind: 'person' }; role: 'walker' } |
  { entity: { kind: 'craft'; id: CraftId }; role: 'pilot' };

/** what the sim keeps of a player: the entity followed (kept in the sim wherever it goes, no rights over it), the
 * person walked as and where the player put them (the walk itself is the client's, sent as a pose), the craft piloted */
export interface PlayerState { follow?: EntityRef; walkingAs?: number; pose?: WalkPose; craft?: CraftId }

/** a player craft (sim/craft/craft-core.ts): an entity with one seat, its pilot's; stepped once put down */
export interface Craft<C extends CraftCore = CraftCore> {
  readonly id: CraftId;
  readonly type: CraftType;
  readonly core: C;
  /** its own: the tiles round it (the shell reads it too: its camera's sweep, its panel) */
  readonly collision: VoxelCollision;
  /** the player in the pilot's seat */
  readonly pilot: PlayerId | null;
  /** put down (placeCraft): stepped from then on */
  readonly placed: boolean;
}
type InputOf<C> = C extends CraftCore<infer I> ? I : never;
/** what a pilot sends (craftInput): the input of their craft's type */
export type CraftInput = InputOf<CoreOf<CraftType>>;
type CraftState = { -readonly [K in keyof Craft]: Craft[K] } & { input: unknown };

/** what the crafts' collisions read: the map, the node files (the viewer's shared TileCache) and the clock (ms) their
 * fetch pacing reads */
export interface CraftWorld { meta: Meta; cache: TileCache; now: () => number }

/** what one update is given: the world's hour and day of the year, the focus (the middle of what is simulated) and
 * the viewer (where agents may come and go unseen far from; by default the focus) */
export interface SimInput {
  hour: number;
  day?: number;
  focus: { x: number; z: number };
  viewer?: { x: number; z: number; y?: number };
}

/** what happened in a tick: a person knocked down by a driven car (where, how fast it went), a person fallen into a
 * hole; tick: the tick that produced it (WorldSim.tick after it) */
export type SimEvent =
  | { tick: number; kind: 'struck'; person: Person; pose: RoadPose; vx: number; vz: number }
  | { tick: number; kind: 'dropped'; person: Person };

/** the events kept for readers (ticks: 10 s); a reader further behind misses the older ones */
export const EVENT_TICKS = 300;

export class WorldSim {
  readonly traffic: Traffic;
  // the events of the last EVENT_TICKS ticks, by tick
  private events: SimEvent[] = [];
  /** the players, by id (follow, walkAs; the drivers are the road physics': driverSnapshot) */
  readonly players = new Map<PlayerId, PlayerState>();
  // the person walked, by person id: by whom
  private readonly walkers = new Map<number, PlayerId>();
  private phys: LifePhysics | null = null;
  private loading: Promise<LifePhysics> | null = null;
  private readonly keeper: EditKeeper;
  // the vehicles left ("craft:id", "car:id"): when a player was last near them
  private readonly left: Presence<string>;
  /** the player crafts, by craft id */
  readonly crafts: ReadonlyMap<CraftId, Craft> = new Map<CraftId, CraftState>();
  private nextCraft = 1;

  /** the world's tuning (read-only, sim/tuning.ts); the physics loader is given it */
  readonly tuning: Tuning;

  /** loadPhysics: makes the road physics with the world's tuning (Rapier initialised, its tiles from a cache or a
   * load); crafts: what the crafts' collisions read (without it, addCraft throws) */
  constructor(data: TrafficData, private readonly opts: {
    seed?: number; tuning?: Tuning; loadPhysics?: (tuning: Tuning) => Promise<LifePhysics>; crafts?: CraftWorld;
  } = {}) {
    this.traffic = new Traffic(data, opts.seed ?? DEFAULT_SEED);
    this.tuning = opts.tuning ?? DEFAULT_TUNING;
    this.keeper = new EditKeeper(this.tuning.edits);
    this.left = new Presence(this.tuning.edits);
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

  /** the ticks due after dt s (Traffic.update); what they did: eventsSince */
  update(dt: number, { hour, day, focus, viewer }: SimInput) {
    const T = this.traffic;
    if (day !== undefined) T.day = day;
    // (the edits and the vehicles left no player is near any more dropped before the ticks, which see it)
    const now = this.tick * STEP, foci = this.foci(focus);
    this.keeper.update(now, foci);
    this.dropLeft(now, foci);
    this.stepCrafts(dt);
    T.update(dt, hour, focus, viewer);
    if (T.dropped.length || T.struck.length) {
      const fresh: SimEvent[] = [...T.dropped.map((d) => ({ kind: 'dropped' as const, ...d })), ...T.struck.map((s) => ({ kind: 'struck' as const, ...s }))];
      this.events.push(...fresh.sort((a, b) => a.tick - b.tick));
      T.struck = [];
      T.dropped = [];
    }
    const old = this.tick - EVENT_TICKS;
    if (this.events.length && this.events[0].tick <= old) this.events = this.events.filter((e) => e.tick > old);
  }

  /** the events of the ticks after tick (a reader keeps the tick it read up to: WorldSim.tick), oldest first */
  eventsSince(tick: number): SimEvent[] {
    const E = this.events;
    let i = E.length;
    while (i > 0 && E[i - 1].tick > tick) i--;
    return E.slice(i);
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

  /** the seat the player holds: the walked person's, else the pilot's of their craft, else the driver's of the car they
   * drive, else null */
  seat(player: PlayerId): Seat | null {
    const P = this.players.get(player);
    if (P?.walkingAs !== undefined) return { entity: { kind: 'person', id: P.walkingAs }, role: 'walker' };
    if (P?.craft !== undefined) return { entity: { kind: 'craft', id: P.craft }, role: 'pilot' };
    const car = this.driverSnapshot(player);
    return car ? { entity: { kind: 'car', id: car.entityId }, role: 'driver' } : null;
  }

  private player(id: PlayerId) {
    let P = this.players.get(id);
    if (!P) this.players.set(id, P = {});
    return P;
  }

  // the traffic's held and walked ids, from the players
  // Where the players are (map metres), for the edits kept (sim/edit-keeper.ts): the focus given, and each player's
  // walked person (their pose), car driven, craft piloted, or entity followed
  private foci(focus: { x: number; z: number }) {
    const out = [focus], T = this.traffic, at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
    for (const c of this.crafts.values()) if (c.pilot !== null && c.placed) out.push({ x: c.core.pose.x, z: c.core.pose.z });
    for (const [id, P] of this.players) {
      if (P.pose) out.push({ x: P.pose.x, z: P.pose.z });
      const car = this.driverSnapshot(id);
      if (car) out.push({ x: car.pose.x, z: car.pose.z });
      if (P.follow?.kind === 'car') {
        const c = T.roadVehicles().find((q) => q.id === P.follow!.id);
        if (c) { T.carPose(c, c.s, c.off, at); out.push({ x: at.x, z: at.z }); }
      } else if (P.follow) {
        const p = T.people.find((q) => q.id === P.follow!.id) ?? T.riders.find((q) => q.id === P.follow!.id);
        if (p) { T.personPoint(p, 0, at); out.push({ x: at.x, z: at.y }); }
      }
    }
    return out;
  }

  // the crafts no one pilots and the cars parked (or wrecked) no one drives or follows, dropped once no focus has been
  // near them for the edits' keeping (ADR 0008: a vehicle stays in the world when left, while players are near)
  private dropLeft(now: number, foci: { x: number; z: number }[]) {
    const L = this.left, T = this.traffic, live = new Set<string>();
    for (const c of [...this.crafts.values()]) {
      if (c.pilot !== null) continue;
      const k = `craft:${c.id}`, p = c.core.pose;
      live.add(k);
      if (L.due(k, now, c.placed && L.near(foci, p.x, p.z))) { this.removeCraft(c.id); L.forget(k); }
    }
    for (const c of [...T.detachedCars]) {
      if (T.held.car.has(c.id) || T.bodies?.controlled?.(c)) continue;
      const k = `car:${c.id}`, p = c.detachedPose!;
      live.add(k);
      if (L.due(k, now, L.near(foci, p.x, p.z))) { T.dropParked(c); L.forget(k); }
    }
    L.retain(live);
  }

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

  // ------------------------------------------------------------------ the player crafts (sim/craft/craft-core.ts)
  // A craft is an entity with one seat, its pilot's (ADR 0008: per seat; a gunner's would be another). It is made
  // (addCraft), put down (placeCraft: stepped from then on, whether or not anyone pilots it: an empty seat is its core's
  // neutral input) and taken away (removeCraft; or, left empty, by the presence rule: dropLeft). Left, it stays where
  // it is for any player to enter. The pilot's commands apply at once; the steps read the input in the next update.

  /** a new craft of type (its core given its part of the world's tuning), not yet put down: what its shell searches a
   * spot with (craft.collision) before placeCraft */
  addCraft<K extends CraftType>(type: K): Craft<CoreOf<K>> {
    const env = this.opts.crafts;
    if (!env) throw new Error('WorldSim: no craft world');
    const core = CORES[type](this.tuning) as CoreOf<K>;
    const c: CraftState = { id: this.nextCraft++, type, core, collision: new VoxelCollision(env.meta, env.cache, env.now, core.reach),
      pilot: null, placed: false, input: core.neutral };
    (this.crafts as Map<CraftId, CraftState>).set(c.id, c);
    return c as unknown as Craft<CoreOf<K>>;
  }

  /** craft id put down at spot, standing still (or at spot.speed): stepped from the next update */
  placeCraft(id: CraftId, spot: CraftSpot) {
    const c = this.craft(id);
    if (!c) return;
    c.core.reset(spot);
    c.core.clock.acc = 0;
    c.placed = true;
  }

  /** craft id taken out of the world (its pilot leaves it first) */
  removeCraft(id: CraftId) {
    const c = this.craft(id);
    if (!c) return;
    if (c.pilot !== null) this.leaveCraft(c.pilot);
    c.collision.release();
    (this.crafts as Map<CraftId, CraftState>).delete(id);
  }

  /** the player takes the pilot's seat of craft id (leaving another craft's); false: no such craft, or another
   * player pilots it */
  enterCraft(player: PlayerId, id: CraftId) {
    const c = this.craft(id);
    if (!c || (c.pilot !== null && c.pilot !== player)) return false;
    const P = this.player(player);
    if (P.craft !== undefined && P.craft !== id) this.leaveCraft(player);
    P.craft = id;
    c.pilot = player;
    return true;
  }

  /** what the player's hands do on their craft's controls (its type's input), until the next; ignored while they pilot
   * none */
  craftInput(player: PlayerId, input: CraftInput) {
    const c = this.craftOf(player) as CraftState | null;
    if (c) c.input = input;
  }

  /** the player's craft back to a safe spot nearby (T); false: none, or not now */
  resetCraft(player: PlayerId) {
    const c = this.craftOf(player);
    return !!c?.placed && !!c.core.unstick?.(c.collision);
  }

  /** the player leaves the pilot's seat: the craft goes on with hands off (its neutral input) */
  leaveCraft(player: PlayerId) {
    const P = this.players.get(player), c = P?.craft !== undefined ? this.craft(P.craft) : null;
    if (P) delete P.craft;
    if (!c) return;
    c.pilot = null;
    c.input = c.core.neutral;
    c.core.events.length = 0;
  }

  /** the craft the player pilots, or null */
  craftOf(player: PlayerId): Craft | null {
    const id = this.players.get(player)?.craft;
    return id === undefined ? null : this.crafts.get(id) ?? null;
  }

  /** what happened to the player's craft since the last call (its core's events), oldest first */
  craftEvents(player: PlayerId): unknown[] {
    const c = this.craftOf(player);
    return c ? c.core.events.splice(0) : [];
  }

  private craft(id: CraftId) { return (this.crafts as Map<CraftId, CraftState>).get(id); }

  // each craft put down: its collision's tiles fetched round it and ahead, then the frame's steps at its own fixed
  // step with its pilot's input (or the neutral); a step not taken (a tile not in) drops the rest of the frame
  private stepCrafts(dt: number) {
    for (const c of (this.crafts as Map<CraftId, CraftState>).values()) {
      if (!c.placed) continue;
      const core = c.core;
      c.collision.prefetch(core.pose, core.velocity);
      core.clock.run(dt, (step) => core.step(c.input, step, c.collision));
      if (c.pilot === null) core.events.length = 0;
    }
  }
}
