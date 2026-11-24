// The world sim's one host (docs/adr/0006-world-sim-seam.md, 0007, 0008): what a server would create and tick, and
// what the viewer (main.ts) and the tools (life-edit.mjs, life-phys.mjs, popin-check.mjs) create and tick the same
// way. It owns the street traffic (traffic.ts, with the trains and the river boats) and, once loaded, the road physics
// (physics/rapier/life-phys.ts, through the loader it is given: Rapier is loaded only when needed). No three.js, no
// DOM, no fetch (tools/core-deps.mjs).
//   inputs:   update(dt, { hour, day, focus, viewer }): the frame's time, run as whole world ticks (STEP; the rest
//             carried to the next update: FrameTime's alpha); edited(box, cleared), setBoats, setWorld (ground and
//             water); the players' commands (sim/commands.ts PlayerCommand, keyed by player id: send), queued and
//             applied in order at the start of the next tick (apply: the one place a seat is taken or left);
//             the crafts made, put down and taken away (addCraft, placeCraft, removeCraft); the game mode (mode:
//             sim/mode.ts, set by the host: whether a player may take a seat, the players' requests, applied with the
//             commands; without one, every seat may be taken and every request is refused)
//   owns:     the seat table (seat: one seat a player, one player a seat; the driver's car's state is the road
//             physics', a craft's pilot field follows the table); the walks' last poses (bounded: Tuning.walk);
//             which of the world's edits are kept (sim/edit-keeper.ts: while a player is near them); the player
//             crafts (sim/craft/craft-core.ts), each stepped in every world tick, STEP worth of its own fixed steps
//             with that tick's input, through its own collision, piloted or not; the vehicles players left (a craft
//             no one pilots, a parked car), kept by the edits' rule (edit-keeper.ts Presence: dropped once no player
//             has been near them for a while)
//   outputs:  the frame's time (time: FrameTime), the traffic's state (drawn by view/life.ts StreetLife between its
//             last two ticks), the crafts' (crafts: their cores, drawn between their last two ticks by their shells in
//             nav/), the players' last seat input taken (ack), the players' reads (seat, walkedPose, driverSnapshot,
//             craftOf, results: the outcomes of their commands), and the events, each with the tick that produced it
//             (eventsSince: struck, impact, dropped, seated, unseated, craft, drive), so several readers can each take
//             theirs (a player's seat's: craftEvents, driverNotes); the entities (sim/entities.ts: cars, people, crafts
//             read through their own stores)
import type { LifePhysics } from '../physics/rapier/life-phys';
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import type { BoatData } from './boat-traffic';
import type { WaterColumns } from './river';
import { EditKeeper, Presence } from './edit-keeper';
import { DEFAULT_SEED, STEP, Traffic, type Ground } from './traffic';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import type { Person, RoadPose, TrafficData, Vec3, WalkPose } from './types';
import { Entities, SEATS, sameEntity, type EntityRef, type Role, type Seat } from './entities';
import { vehicleOf } from './vehicles';
import type { VehicleId } from './vehicles';
import type { Meta } from '../types';
import type { TileCache } from '../core/tile-cache';
import type { CraftCore, CraftSpot } from './craft/craft-core';
import { CORES, type CoreOf, type CraftType } from './craft/cores';
import { VoxelCollision } from './craft/voxel-collision';
import type { CommandResult, PlayerCommand } from './commands';
import { boundWalk } from './walk-bounds';
import type { GameMode, ModeWorld } from './mode';

/** a participant in the world (ADR 0007); the sim numbers none of its own, a host names them (the viewer's own:
 * nav/player.ts LOCAL_PLAYER) */
export type PlayerId = string;

export type CraftId = number;

export type { Seat };

/** what the sim keeps of a player: the entity followed (kept in the sim wherever it goes, no rights over it), the seat
 * held, and, walking as a person, the walk's poses taken (the walk itself is the client's, sent as poses) */
export interface PlayerState { follow?: EntityRef; seat?: Seat; walk?: Walk }

/** a walk's poses taken: the last (pose, at the sim's clock at) and the one an update's poses are bounded against (the
 * last of an earlier update: from, fromAt) */
export interface Walk { pose: WalkPose; at: number; from: WalkPose; fromAt: number }

// a seat's key in the seat table
const seatKey = (s: Seat) => `${s.entity.kind}:${s.entity.id}:${s.role}:${s.index}`;

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
/** what a pilot sends (seatInput): the input of their craft's type */
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

/** the frame's time once the sim's update has run (docs/plans/smooth-motion-and-lag.md section 3: fixed once a frame,
 * every reader the same): dt the frame's (s, at most MAX_DT), tick the ticks run, alpha how far past the last tick
 * what is drawn is (0..1: the traffic, the bodies and the crafts drawn between their last two ticks) */
export interface FrameTime { dt: number; tick: number; alpha: number }

/** the most one update counts for (s): a longer frame (a stall, a tab in the background) runs this much */
export const MAX_DT = 0.1;

/** the last seat input a player's seat took: its seq (the client's number), the tick it was first applied in */
export interface Ack { seq: number; tick: number }

/** what happened in a tick, to an entity or a player; tick: the tick that produced it (WorldSim.tick after it):
 *   struck            a person knocked down by a driven car (where, how fast it went: drawn falling, view/life.ts)
 *   impact            the same contact as a fact about the entity hit: by whom, how fast (m/s), where
 *   dropped           a person fallen into a hole
 *   seated, unseated  a player into a seat or out of it (the tick the command was applied in)
 *   craft             what happened to a craft (its core's event, e: its type's, as the shell reads it)
 *   drive             what the driver of a car is to be told (life-phys.ts PlayerCar's note) */
export type SimEvent =
  | { tick: number; kind: 'struck'; person: Person; pose: RoadPose; vx: number; vz: number }
  | { tick: number; kind: 'impact'; entity: EntityRef; by?: EntityRef; speed: number; at: Vec3 }
  | { tick: number; kind: 'dropped'; person: Person }
  | { tick: number; kind: 'seated' | 'unseated'; player: PlayerId; seat: Seat }
  | { tick: number; kind: 'craft'; entity: EntityRef; e: unknown }
  | { tick: number; kind: 'drive'; entity: EntityRef; note: DriveNote };
// an event yet to be given its tick
type Untimed = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'tick'> : never) : never;

/** the events kept for readers (ticks: 10 s); a reader further behind misses the older ones */
export const EVENT_TICKS = 300;

export class WorldSim {
  readonly traffic: Traffic;
  // the events of the last EVENT_TICKS ticks, by tick; those of the tick being run (its commands', its crafts')
  private events: SimEvent[] = [];
  private due: Untimed[] = [];
  // the players' reads of their seat's events (craftEvents, driverNotes)
  private readonly reads = new SeatReads();
  /** the players, by id (what is followed, the seat held, the walk; a driver's car is the road physics': driverSnapshot) */
  readonly players: ReadonlyMap<PlayerId, Readonly<PlayerState>> = new Map<PlayerId, PlayerState>();
  // the seat table's other side: who holds each seat taken, by seatKey
  private readonly occupants = new Map<string, PlayerId>();
  // the commands sent, applied at the start of the next tick; their outcomes, by player; the last seat input taken
  private queue: PlayerCommand[] = [];
  private readonly outcomes = new Map<PlayerId, CommandResult[]>();
  private readonly acks = new Map<PlayerId, Ack>();
  // the sim's clock (s: the end of the tick being run), what the walks are bounded on; the last update's dt
  private clock = 0;
  private frameDt = 0;
  private phys: LifePhysics | null = null;
  private loading: Promise<LifePhysics> | null = null;
  private readonly keeper: EditKeeper;
  // the vehicles left ("craft:id", "car:id"): when a player was last near them
  private readonly left: Presence<string>;
  /** the player crafts, by craft id */
  readonly crafts: ReadonlyMap<CraftId, Craft> = new Map<CraftId, CraftState>();
  private nextCraft = 1;
  /** the entities (sim/entities.ts): the cars, people and crafts read through their own stores */
  readonly entities: Entities;

  /** the game mode (sim/mode.ts; the host's: SimServer), asked while the commands are applied; null: none (every
   * seat may be taken, every request refused) */
  mode: GameMode | null = null;
  // what the mode acts through
  private readonly face: ModeWorld = {
    seat: (player) => this.seat(player),
    craftOf: (player) => this.craftOf(player),
    addCraft: (type) => this.addCraft(type),
    placeCraft: (id, spot) => this.placeCraft(id, spot),
    removeCraft: (id) => this.removeCraft(id),
    sit: (player, seat) => this.enterSeat(player, seat, false),
    resetDriver: (player) => {
      if (this.seat(player)?.role !== 'driver' || !this.phys) return false;
      this.phys.resetDriver(player);
      return true;
    },
  };

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
    const T = this.traffic, at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 }, ahead = { x: 0, y: 0, z: 0 };
    const car = (id: number) => T.cars.find((c) => c.id === id) ?? T.detachedCars.find((c) => c.id === id);
    const person = (id: number) => T.people.find((p) => p.id === id) ?? T.riders.find((p) => p.id === id);
    this.entities = new Entities({
      // (a car out of the traffic, parked, wrecked or driven, where it is; else on its path)
      car: {
        exists: (id) => !!car(id),
        pose: (id) => {
          const c = car(id);
          if (!c) return null;
          const d = c.detachedPose;
          if (d) return { x: d.x, y: d.y, z: d.z, h: d.h };
          T.carPose(c, c.s, c.off, at);
          return { x: at.x, y: at.y, z: at.z, h: at.h };
        },
        seats: (id) => SEATS.car[vehicleOf(car(id)!).id],
      },
      // (a person walked where their walker puts them; else on their way: personPoint's x, z on the map as x, y)
      person: {
        exists: (id) => !!person(id),
        pose: (id) => {
          const w = this.walkedPose(id);
          if (w) return { x: w.x, y: w.y, z: w.z, h: w.h };
          const p = person(id);
          if (!p) return null;
          const P = T.personPoint(p, 0, at), x = P.x, z = P.y, y = P.z, A = T.personPoint(p, 0.4, ahead);
          return { x, y, z, h: Math.atan2(A.x - x, A.y - z) };
        },
        seats: (id) => SEATS.person[person(id)!.bike ? 'bike' : 'foot'],
      },
      // (a craft not yet put down is nowhere)
      craft: {
        exists: (id) => this.crafts.has(id),
        pose: (id) => {
          const c = this.crafts.get(id);
          return c?.placed ? { x: c.core.pose.x, y: c.core.pose.y, z: c.core.pose.z, h: c.core.pose.h } : null;
        },
        seats: (id) => SEATS.craft[this.crafts.get(id)!.type],
      },
    });
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

  /** the frame's time when its update has run: what is drawn between the last two ticks is alpha of the way */
  get time(): FrameTime { return { dt: this.frameDt, tick: this.tick, alpha: this.traffic.acc / STEP }; }

  /** the world ticks due after dt s (at most MAX_DT of them; the rest under STEP carried: time.alpha); what they did:
   * eventsSince */
  update(dt: number, { hour, day, focus, viewer }: SimInput) {
    const T = this.traffic;
    if (day !== undefined) T.day = day;
    dt = Math.min(MAX_DT, Math.max(0, dt));
    this.frameDt = dt;
    const density = T.frame(hour, focus, viewer);
    T.acc += dt;
    while (T.acc >= STEP) {
      this.runTick(focus, () => T.tick(density, hour));
      T.acc -= STEP;
    }
  }

  // One world tick (ADR 0007's order): the commands due, the edits and the vehicles left no player is near any more
  // dropped (the tick sees it), the crafts' steps with this tick's input, the traffic's tick (the bodies in it), then
  // the tick's events in order
  private runTick(focus: { x: number; z: number }, traffic: () => void) {
    const T = this.traffic, t0 = this.tick;
    this.clock = (t0 + 1) * STEP;
    const q = this.queue;
    this.queue = [];
    for (const cmd of q) this.apply(cmd);
    const now = t0 * STEP, foci = this.foci(focus);
    this.keeper.update(now, foci);
    this.dropLeft(now, foci);
    this.stepCrafts();
    traffic();
    const fresh: SimEvent[] = [];
    if (this.due.length) { for (const e of this.due) fresh.push({ tick: t0 + 1, ...e }); this.due = []; }
    if (T.dropped.length || T.struck.length) {
      fresh.push(...T.dropped.map((d) => ({ kind: 'dropped' as const, ...d })));
      for (const { by, ...s } of T.struck) {
        fresh.push({ kind: 'struck', ...s }, { tick: s.tick, kind: 'impact', entity: { kind: 'person', id: s.person.id },
          by: { kind: 'car', id: by }, speed: Math.hypot(s.vx, s.vz), at: { x: s.pose.x, y: s.pose.y, z: s.pose.z } });
      }
      T.struck = [];
      T.dropped = [];
    }
    for (const [player, P] of this.players) {
      if (P.seat?.role !== 'driver') continue;
      for (const note of this.phys?.driverNotes(player) ?? []) fresh.push({ tick: note.tick, kind: 'drive', entity: P.seat.entity, note });
    }
    // (a stable sort: the seats and crafts before the tick's own)
    if (fresh.length) this.events.push(...fresh.sort((a, b) => a.tick - b.tick));
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
  // A player holds at most one seat on an entity (ADR 0008: control per seat, Seat; the seats of each entity's model:
  // sim/entities.ts SEATS): the driver's of a car, the walker's of a person on foot, the pilot's of a craft. Taking a
  // seat (enterSeat) checks it first (the entity there, the seat in its model and free, mayEnter) and, if it may be
  // taken, leaves the one held: one command switches seats, with no tick in between where the player holds none;
  // refused, the player keeps theirs. A seat's input (seatInput) is its role's. Following carries no rights. Only
  // players with sim authority come here: a creative camera (orbit, free flight) is the client's and only moves the
  // focus and the viewer.

  /** what the game mode acts through (SimServer asks it about edits with it) */
  get modeWorld() { return this.face; }

  /** a player's command, applied at the start of the next tick (after those sent before it) */
  send(cmd: PlayerCommand) { this.queue.push(cmd); }

  /** the player's command outcomes since the last call (of kind, and of a seat's role; all without), oldest first */
  results(player: PlayerId, kind?: CommandResult['kind'], role?: Role) {
    const r = this.outcomes.get(player);
    if (!r?.length) return [];
    const of = (o: CommandResult) => (!kind || o.kind === kind) && (!role || o.role === role);
    const mine = r.filter(of);
    if (mine.length) this.outcomes.set(player, r.filter((o) => !of(o)));
    return mine;
  }

  /** the last seat input the player's seat took (of those sent with a seq), or null */
  ack(player: PlayerId): Ack | null { return this.acks.get(player) ?? null; }

  /** the seat the player holds (its entity in the world), or null */
  seat(player: PlayerId): Seat | null {
    const s = this.players.get(player)?.seat;
    return s && this.entities.exists(s.entity) ? s : null;
  }

  /** where person personId is put by the player walking as them, or null while none does */
  walkedPose(personId: number): WalkPose | null {
    const by = this.occupants.get(`person:${personId}:walker:0`);
    return by === undefined ? null : this.players.get(by)?.walk?.pose ?? null;
  }

  // the one place a command takes effect
  private apply(cmd: PlayerCommand) {
    const p = cmd.player;
    switch (cmd.kind) {
      case 'follow': this.follow(p, cmd.entity); break;
      case 'enterSeat': this.result(cmd, this.enterSeat(p, cmd), cmd.role ?? this.entities.seat(cmd.entity)?.role); break;
      case 'seatInput': {
        if (this.seat(p)?.role !== cmd.role) break;
        if (cmd.seq !== undefined) this.acks.set(p, { seq: cmd.seq, tick: this.tick + 1 });
        if (cmd.role === 'driver') this.phys?.input(p, cmd.input);
        else if (cmd.role === 'pilot') (this.craftOf(p) as CraftState).input = cmd.input;
        else if (!this.walkPose(p, cmd.input)) this.result(cmd, false, 'walker');
        break;
      }
      case 'request': this.result({ player: p, kind: cmd.request.kind }, !!this.mode?.request(this.face, p, cmd.request)); break;
      case 'leaveSeat': this.leaveSeat(p); break;
    }
  }

  private result(cmd: { player: PlayerId; kind: CommandResult['kind'] }, ok: boolean, role?: Role) {
    const r = this.outcomes.get(cmd.player), out: CommandResult = { tick: this.tick, kind: cmd.kind, ok };
    if (role) out.role = role;
    if (r) r.push(out); else this.outcomes.set(cmd.player, [out]);
  }

  // the player follows entity (a car or a person kept in the traffic wherever it goes, a craft kept by the presence
  // rule while followed; no rights over it), or, null, none
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
    this.due.push({ kind: 'seated', player, seat });
  }

  // out of the seat held: the person walked back to the crowd's walk from where they are on their way; the car parked
  // where it is (the road physics); the craft goes on with hands off (its core's neutral input)
  private leaveSeat(player: PlayerId) {
    const P = this.players.get(player) as PlayerState | undefined, s = P?.seat;
    if (!P || !s) return;
    this.occupants.delete(seatKey(s));
    delete P.seat;
    this.due.push({ kind: 'unseated', player, seat: s });
    if (s.role === 'walker') {
      delete P.walk;
      this.held();
    } else if (s.role === 'driver') this.phys?.releaseWheel(player);
    else {
      const c = this.craft(s.entity.id);
      if (!c) return;
      c.pilot = null;
      c.input = c.core.neutral;
    }
  }

  // a seat of entity (role, index: without, its first) taken, the one held left first; true: held now (also when it
  // was already); false: gone, no such seat, another's, not allowed (the mode's mayEnter; not asked with ask false: the
  // mode seating the player itself), or the role's own refusal (a car: no road physics; a person: not in the crowd on
  // foot). The walker's from pose (where they are drawn: kept within Tuning.walk.take of where the sim has them), the
  // driver's as type choice (the car taken shows in driverSnapshot)
  private enterSeat(player: PlayerId, cmd: { entity: EntityRef; role?: Role; index?: number; choice?: VehicleId; pose?: WalkPose }, ask = true) {
    const seat = this.entities.seat(cmd.entity, cmd.role, cmd.index);
    if (!seat) return false;
    const by = this.occupants.get(seatKey(seat));
    if (by === player) return true;
    if (by !== undefined || (ask && this.mode?.mayEnter && !this.mode.mayEnter(this.face, player, seat))) return false;
    const id = seat.entity.id;
    if (seat.role === 'walker') {
      const person = this.traffic.people.find((p) => p.id === id);
      if (!person) return false;
      const at = this.traffic.personPoint(person, 0, { x: 0, y: 0, z: 0 }), take = this.tuning.walk.take;
      const pose = cmd.pose ?? { x: at.x, y: at.z, z: at.y, h: 0, moving: false };
      const dx = pose.x - at.x, dz = pose.z - at.y, d = Math.hypot(dx, dz), k = d > take ? take / d : 1;
      const start = k < 1 ? { ...pose, x: at.x + dx * k, z: at.y + dz * k } : { ...pose }, t = this.clock - STEP;
      this.leaveSeat(player);
      this.sit(player, seat);
      this.player(player).walk = { pose: start, at: t, from: start, fromAt: t };
      this.held();
    } else if (seat.role === 'driver') {
      const phys = this.phys;
      if (!phys) return false;
      this.leaveSeat(player);
      if (!phys.takeWheel(this.traffic, player, id, cmd.choice)) return false;
      this.sit(player, seat);
    } else {
      this.leaveSeat(player);
      this.sit(player, seat);
    }
    return true;
  }

  // where the walk puts the person walked, bounded (Tuning.walk) against the last pose taken in an earlier tick;
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

  private player(id: PlayerId) {
    const M = this.players as Map<PlayerId, PlayerState>;
    let P = M.get(id);
    if (!P) M.set(id, P = {});
    return P;
  }

  // Where the players are (map metres), for the edits kept (sim/edit-keeper.ts) and the vehicles left: the focus given,
  // and each player's seat entity (the person walked, the car driven, the craft piloted) and entity followed
  private foci(focus: { x: number; z: number }) {
    const out = [focus], E = this.entities;
    for (const P of this.players.values()) {
      for (const ref of [P.seat?.entity, P.follow]) {
        const p = ref && E.pose(ref);
        if (p) out.push({ x: p.x, z: p.z });
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
      if (P.follow && P.follow.kind !== 'craft') held[P.follow.kind].add(P.follow.id);
      if (P.seat?.role === 'walker') { held.person.add(P.seat.entity.id); walked.add(P.seat.entity.id); }
    }
  }

  // The driver's car: the road physics' (loadPhysics)
  /** the player's car now, or null while they drive none */
  driverSnapshot(player: PlayerId): DriverSnapshot | null { return this.phys?.driverSnapshot(player) ?? null; }
  /** what the player driving is to be told since the last call (the drive events of their car since they took it) */
  driverNotes(player: PlayerId): DriveNote[] {
    return this.reads.take(this.events, player, this.seat(player), 'drive', this.tick).map((e) => e.note);
  }

  // ------------------------------------------------------------------ the player crafts (sim/craft/craft-core.ts)
  // A craft is an entity with one seat, its pilot's (ADR 0008: per seat; a gunner's would be another). It is made
  // (addCraft), put down (placeCraft: stepped from then on, whether or not anyone pilots it: an empty seat is its core's
  // neutral input) and taken away (removeCraft; or, left empty, by the presence rule: dropLeft). Left, it stays where
  // it is for any player to enter. Its pilot's seat is the seat table's (enterSeat, leaveSeat); a tick's steps read
  // the pilot's input as the tick's commands left it.

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

  /** craft id put down at spot, standing still (or at spot.speed), drawn there: stepped from the next tick */
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

  /** what happened to the player's craft since the last call (the craft events of it since they took it), oldest
   * first */
  craftEvents(player: PlayerId): unknown[] {
    return this.reads.take(this.events, player, this.seat(player), 'craft', this.tick).map((e) => e.e);
  }

  private craft(id: CraftId) { return (this.crafts as Map<CraftId, CraftState>).get(id); }

  // each craft put down: drawn from where it is now (keep), its collision's tiles fetched round it and ahead, then the
  // tick's steps (STEP worth) at its own fixed step with its pilot's input (or the neutral); a step not taken (a tile
  // not in) drops the rest of the tick. Its core's events become the world's (craft), this tick's
  private stepCrafts() {
    for (const c of (this.crafts as Map<CraftId, CraftState>).values()) {
      if (!c.placed) continue;
      const core = c.core;
      core.keep();
      c.collision.prefetch(core.pose, core.velocity);
      core.clock.run(STEP, (step) => core.step(c.input, step, c.collision));
      if (core.events.length) for (const e of core.events.splice(0)) this.due.push({ kind: 'craft', entity: { kind: 'craft', id: c.id }, e });
    }
  }
}

/** a player's reads of the events of the seat they hold (craftEvents, driverNotes), each since the last call: from
 * the tick they took it (its seated event; not yet in the log: from now), the entity's events of a kind. The world
 * sim's own log, or a client's copy of it (sim-client.ts MirrorSimClient) */
export class SeatReads {
  // by player and kind: the seat read and the tick read up to
  private readonly read = new Map<string, { seat: string; tick: number }>();

  take<K extends 'craft' | 'drive'>(log: readonly SimEvent[], player: PlayerId, seat: Seat | null, kind: K, now: number) {
    const k = `${player}\n${kind}`, out: Extract<SimEvent, { kind: K }>[] = [];
    if (!seat) { this.read.delete(k); return out; }
    const key = seatKey(seat);
    let r = this.read.get(k);
    if (!r || r.seat !== key) {
      let from = now;
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (e.kind === 'seated' && e.player === player && seatKey(e.seat) === key) { from = e.tick - 1; break; }
      }
      this.read.set(k, r = { seat: key, tick: from });
    }
    for (const e of log) if (e.tick > r.tick && e.kind === kind && sameEntity((e as { entity: EntityRef }).entity, seat.entity)) out.push(e as Extract<SimEvent, { kind: K }>);
    r.tick = now;
    return out;
  }
}
