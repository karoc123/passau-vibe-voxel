// The world sim's one host (docs/adr/0006-world-sim-seam.md, 0007, 0008): what a server would create and tick, and
// what the viewer (main.ts) and the tools (life-edit.mjs, life-phys.mjs, popin-check.mjs) create and tick the same
// way. It owns the street traffic (traffic.ts, with the trains and the river boats) and, once loaded, the road physics
// (physics/rapier/life-phys.ts, through the loader it is given: Rapier is loaded only when needed). No three.js, no
// DOM, no fetch (tools/core-deps.mjs).
//   inputs:   update(dt, { hour, day, focus, viewer }), edited(box, cleared), setBoats, setWorld (ground and water);
//             the players' commands (sim/commands.ts PlayerCommand, keyed by player id: send), queued and applied in
//             order at the start of the next update, before its ticks (apply: the one place a seat is taken or left);
//             the crafts made, put down and taken away (addCraft, placeCraft, removeCraft: what a game mode, today the
//             craft's shell, decides)
//   owns:     the seat table (seat: one seat a player, one player a seat; the driver's car's state is the road
//             physics', a craft's pilot field follows the table); the walks' last poses (bounded: Tuning.walk);
//             which of the world's edits are kept (sim/edit-keeper.ts: while a player is near them); the player
//             crafts (sim/craft/craft-core.ts), each stepped at its own fixed step through its own collision, piloted
//             or not; the vehicles players left (a craft no one pilots, a parked car), kept by the edits' rule
//             (edit-keeper.ts Presence: dropped once no player has been near them for a while)
//   outputs:  the traffic's state (drawn by view/life.ts StreetLife between its last two ticks), the crafts' (crafts:
//             their cores, read by their shells in nav/), the players' reads (seat, walkedPose, driverSnapshot,
//             driverNotes, craftOf, craftEvents, results: the outcomes of their commands), and the events, each with
//             the tick that produced it (eventsSince: struck, dropped), so several readers can each take theirs
import type { LifePhysics } from '../physics/rapier/life-phys';
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
import type { CommandResult, PlayerCommand } from './commands';
import { boundWalk } from './walk-bounds';

/** a participant in the world (ADR 0007); the sim numbers none of its own, a host names them (the viewer's own:
 * nav/player.ts LOCAL_PLAYER) */
export type PlayerId = string;

export type CraftId = number;

/** a player's place on an entity (ADR 0008: control per seat): the driver's seat of a car (takeWheel), the one seat
 * of a person walked (walkAs), or the pilot's seat of a craft (enterCraft). A seat holds at most one player, a player
 * at most one seat (the seat table: WorldSim seat); other seats and roles would be added here. */
export type Seat = { entity: EntityRef & { kind: 'car' }; role: 'driver' } | { entity: EntityRef & { kind: 'person' }; role: 'walker' } |
  { entity: { kind: 'craft'; id: CraftId }; role: 'pilot' };

/** what the sim keeps of a player: the entity followed (kept in the sim wherever it goes, no rights over it), the seat
 * held, and, walking as a person, the walk's poses taken (the walk itself is the client's, sent as poses) */
export interface PlayerState { follow?: EntityRef; seat?: Seat; walk?: Walk }

/** a walk's poses taken: the last (pose, at the sim's clock at) and the one an update's poses are bounded against (the
 * last of an earlier update: from, fromAt) */
export interface Walk { pose: WalkPose; at: number; from: WalkPose; fromAt: number }

// a seat's key in the seat table
const seatKey = (s: Seat) => `${s.entity.kind}:${s.entity.id}:${s.role}`;

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
  /** the players, by id (what is followed, the seat held, the walk; a driver's car is the road physics': driverSnapshot) */
  readonly players: ReadonlyMap<PlayerId, Readonly<PlayerState>> = new Map<PlayerId, PlayerState>();
  // the seat table's other side: who holds each seat taken, by seatKey
  private readonly occupants = new Map<string, PlayerId>();
  // the commands sent, applied at the start of the next update; their outcomes, by player
  private queue: PlayerCommand[] = [];
  private readonly outcomes = new Map<PlayerId, CommandResult[]>();
  // the sim's clock (s, the updates' dt summed: at the end of the update being run) and the update's dt; what the
  // walks are bounded on
  private clock = 0;
  private dt = 0;
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
    this.clock += dt;
    this.dt = dt;
    const q = this.queue;
    this.queue = [];
    for (const cmd of q) this.apply(cmd);
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
  // A player holds at most one seat on an entity (ADR 0008: control per seat, Seat): the driver's of a car (takeWheel),
  // the one of a person walked (walkAs) or the pilot's of a craft (enterCraft). Taking a seat checks it first (the
  // entity there, the seat free) and, if it may be taken, leaves the one held: one command switches seats, with no
  // tick in between where the player holds none; refused, the player keeps theirs. Following carries no rights. Only
  // players with sim authority come here: a creative camera (orbit, free flight) is the client's and only moves the
  // focus and the viewer.

  /** a player's command, applied at the start of the next update (after those sent before it) */
  send(cmd: PlayerCommand) { this.queue.push(cmd); }

  /** the player's command outcomes since the last call (of kind; all without), oldest first */
  results(player: PlayerId, kind?: CommandResult['kind']) {
    const r = this.outcomes.get(player);
    if (!r?.length) return [];
    const mine = kind ? r.filter((o) => o.kind === kind) : r;
    if (mine.length) this.outcomes.set(player, kind ? r.filter((o) => o.kind !== kind) : []);
    return mine;
  }

  /** the seat the player holds, or null */
  seat(player: PlayerId): Seat | null { return this.players.get(player)?.seat ?? null; }

  /** where person personId is put by the player walking as them, or null while none does */
  walkedPose(personId: number): WalkPose | null {
    const by = this.occupants.get(`person:${personId}:walker`);
    return by === undefined ? null : this.players.get(by)?.walk?.pose ?? null;
  }

  // the one place a command takes effect
  private apply(cmd: PlayerCommand) {
    const p = cmd.player;
    switch (cmd.kind) {
      case 'follow': this.follow(p, cmd.entity); break;
      case 'walkAs': this.result(cmd, this.walkAs(p, cmd.person, cmd.pose)); break;
      case 'walkPose': if (!this.walkPose(p, cmd.pose)) this.result(cmd, false); break;
      case 'takeWheel': this.result(cmd, this.takeWheel(p, cmd.car, cmd.choice)); break;
      case 'drive': if (this.seat(p)?.role === 'driver') this.phys?.input(p, cmd.input); break;
      case 'resetDriver': if (this.seat(p)?.role === 'driver') this.phys?.resetDriver(p); break;
      case 'spawnCraft': {
        let ok = false;
        try {
          const c = this.addCraft(cmd.type);
          ok = this.enterCraft(p, c.id);
          if (ok) this.placeCraft(c.id, cmd.spot); else this.removeCraft(c.id);
        } catch (e) { console.warn('spawnCraft', e); }
        this.result(cmd, ok);
        break;
      }
      case 'placeCraft': {
        const c = this.craftOf(p);
        if (c) this.placeCraft(c.id, cmd.spot);
        this.result(cmd, !!c);
        break;
      }
      case 'enterCraft': this.result(cmd, this.enterCraft(p, cmd.craft)); break;
      case 'craftInput': { const c = this.craftOf(p) as CraftState | null; if (c) c.input = cmd.input; break; }
      case 'resetCraft': { const c = this.craftOf(p); this.result(cmd, !!c?.placed && !!c.core.unstick?.(c.collision)); break; }
      case 'dropCraft': { const c = this.craftOf(p); if (c) this.removeCraft(c.id); break; }
      case 'leaveSeat': this.leaveSeat(p); break;
    }
  }

  private result(cmd: PlayerCommand, ok: boolean) {
    const r = this.outcomes.get(cmd.player), out = { tick: this.tick, kind: cmd.kind, ok };
    if (r) r.push(out); else this.outcomes.set(cmd.player, [out]);
  }

  // the player follows entity (kept in the sim wherever it goes; no rights over it), or, null, none
  private follow(player: PlayerId, entity: EntityRef | null) {
    const P = this.player(player);
    if (entity) P.follow = { kind: entity.kind, id: entity.id };
    else delete P.follow;
    this.held();
  }

  // the seat taken (the player holds none: leaveSeat first; the seat is free)
  private sit(player: PlayerId, seat: Seat) {
    this.player(player).seat = seat;
    this.occupants.set(seatKey(seat), player);
    if (seat.role === 'pilot') this.craft(seat.entity.id)!.pilot = player;
  }

  // out of the seat held: the person walked back to the crowd's walk from where they are on their way; the car parked
  // where it is (the road physics); the craft goes on with hands off (its core's neutral input)
  private leaveSeat(player: PlayerId) {
    const P = this.players.get(player) as PlayerState | undefined, s = P?.seat;
    if (!P || !s) return;
    this.occupants.delete(seatKey(s));
    delete P.seat;
    if (s.role === 'walker') {
      delete P.walk;
      this.held();
    } else if (s.role === 'driver') this.phys?.releaseWheel(player);
    else {
      const c = this.craft(s.entity.id);
      if (!c) return;
      c.pilot = null;
      c.input = c.core.neutral;
      c.core.events.length = 0;
    }
  }

  // the walker's seat of person personId, from pose (where they are drawn: kept within Tuning.walk.take of where the
  // sim has them); false: no such person in the crowd, or another player walks as them
  private walkAs(player: PlayerId, personId: number, pose: WalkPose) {
    const seat: Seat = { entity: { kind: 'person', id: personId }, role: 'walker' };
    const by = this.occupants.get(seatKey(seat));
    if (by !== undefined && by !== player) return false;
    const person = this.traffic.people.find((p) => p.id === personId);
    if (!person) return false;
    const at = this.traffic.personPoint(person, 0, { x: 0, y: 0, z: 0 }), take = this.tuning.walk.take;
    const dx = pose.x - at.x, dz = pose.z - at.y, d = Math.hypot(dx, dz), k = d > take ? take / d : 1;
    const start = k < 1 ? { ...pose, x: at.x + dx * k, z: at.y + dz * k } : { ...pose }, t = this.clock - this.dt;
    this.leaveSeat(player);
    this.sit(player, seat);
    this.player(player).walk = { pose: start, at: t, from: start, fromAt: t };
    this.held();
    return true;
  }

  // where the walk puts the person walked, bounded (Tuning.walk) against the last pose taken in an earlier update;
  // false: it was out of reach, and was taken clamped (ignored while walking as none)
  private walkPose(player: PlayerId, pose: WalkPose) {
    const W = this.players.get(player)?.walk;
    if (!W) return true;
    if (W.at !== this.clock) { W.from = W.pose; W.fromAt = W.at; }
    const taken = boundWalk(W.from, pose, this.clock - W.fromAt, this.tuning.walk);
    W.pose = { ...taken };
    W.at = this.clock;
    return taken === pose;
  }

  // the driver's seat of car entityId (as type choice; the car taken shows in driverSnapshot); false: no road physics
  // (loadPhysics), no such car, or another player drives it
  private takeWheel(player: PlayerId, entityId: number, choice?: VehicleId) {
    const phys = this.phys, seat: Seat = { entity: { kind: 'car', id: entityId }, role: 'driver' };
    if (!phys || this.occupants.has(seatKey(seat)) || !this.traffic.roadVehicles().some((c) => c.id === entityId)) return false;
    this.leaveSeat(player);
    if (!phys.takeWheel(this.traffic, player, entityId, choice)) return false;
    this.sit(player, seat);
    return true;
  }

  // the pilot's seat of craft id (one in the world, empty, or the player's own); false: no such craft, or another
  // player pilots it
  private enterCraft(player: PlayerId, id: CraftId) {
    const c = this.craft(id);
    if (!c || (c.pilot !== null && c.pilot !== player)) return false;
    if (c.pilot === player) return true;
    this.leaveSeat(player);
    this.sit(player, { entity: { kind: 'craft', id }, role: 'pilot' });
    return true;
  }

  private player(id: PlayerId) {
    const M = this.players as Map<PlayerId, PlayerState>;
    let P = M.get(id);
    if (!P) M.set(id, P = {});
    return P;
  }

  // Where the players are (map metres), for the edits kept (sim/edit-keeper.ts): the focus given, and each player's
  // walked person (their pose), car driven, craft piloted, or entity followed
  private foci(focus: { x: number; z: number }) {
    const out = [focus], T = this.traffic, at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
    for (const c of this.crafts.values()) if (c.pilot !== null && c.placed) out.push({ x: c.core.pose.x, z: c.core.pose.z });
    for (const [id, P] of this.players) {
      if (P.walk) out.push({ x: P.walk.pose.x, z: P.walk.pose.z });
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

  // the traffic's held and walked ids, from the players
  private held() {
    const { held, walked } = this.traffic;
    held.car.clear(); held.person.clear(); walked.clear();
    for (const P of this.players.values()) {
      if (P.follow) held[P.follow.kind].add(P.follow.id);
      if (P.seat?.role === 'walker') { held.person.add(P.seat.entity.id); walked.add(P.seat.entity.id); }
    }
  }

  // The driver's car: the road physics' (loadPhysics)
  /** the player's car now, or null while they drive none */
  driverSnapshot(player: PlayerId): DriverSnapshot | null { return this.phys?.driverSnapshot(player) ?? null; }
  /** what the player is to be told since the last call */
  driverNotes(player: PlayerId): DriveNote[] { return this.phys?.driverNotes(player) ?? []; }

  // ------------------------------------------------------------------ the player crafts (sim/craft/craft-core.ts)
  // A craft is an entity with one seat, its pilot's (ADR 0008: per seat; a gunner's would be another). It is made
  // (addCraft), put down (placeCraft: stepped from then on, whether or not anyone pilots it: an empty seat is its core's
  // neutral input) and taken away (removeCraft; or, left empty, by the presence rule: dropLeft). Left, it stays where
  // it is for any player to enter. Its pilot's seat is the seat table's (enterCraft, leaveSeat); the steps read the
  // pilot's input in the update their commands were applied in.

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
    if (c.pilot !== null) this.leaveSeat(c.pilot);
    c.collision.release();
    (this.crafts as Map<CraftId, CraftState>).delete(id);
  }

  /** the craft the player pilots, or null */
  craftOf(player: PlayerId): Craft | null {
    const s = this.seat(player);
    return s?.role === 'pilot' ? this.crafts.get(s.entity.id) ?? null : null;
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
