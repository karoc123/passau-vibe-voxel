// The world sim's one host (docs/adr/0006-world-sim-seam.md, 0007, 0008): what a server would create and tick, and
// what the viewer (main.ts) and the tools (life-edit.mjs, life-phys.mjs, popin-check.mjs) create and tick the same
// way. It owns the street traffic (traffic.ts, with the trains and the river boats) and, once loaded, the road physics
// (physics/rapier/life-phys.ts, through the loader it is given: Rapier is loaded only when needed). No three.js, no
// DOM, no fetch (tools/core-deps.mjs).
//   inputs:   update(dt): the frame's time, run as whole world ticks (STEP; the rest carried to the next update:
//             FrameTime's alpha); setTime (the world's hour and day: the host's, or a mode's on a player's request);
//             edited(box, cleared), setBoats, setWorld (ground and
//             water); the players' commands (sim/contract/commands.ts PlayerCommand, sent for a player id: send; the
//             host stamps the id, sim/server/sim-server.ts Session), queued and applied in order at the start of the next tick
//             (apply: the one place a seat is taken or left, and the world's voxels are edited: an edit, if the
//             mode's mayEdit allows it, core/world-edits.ts applyNow, its nodes held in by the host before);
//             the crafts made, put down and taken away (addCraft, placeCraft, removeCraft); the game mode (mode:
//             sim/mode.ts, set by the host: whether a player may take a seat, the players' requests, applied with the
//             commands; without one, every seat may be taken and every request is refused)
//   owns:     the world's time of day (hour, day); each player's view (the active circle round the first player's
//             focus; several circles are interest management, not yet); the seat table (seat: one seat a player, one player a seat; the driver's car's state is the road
//             physics', a craft's pilot field follows the table); the walks' last poses (bounded: Tuning.walk);
//             which of the world's edits are kept (sim/edit-keeper.ts: while a player is near them); the player
//             crafts (sim/craft/craft-core.ts), each stepped in every world tick, STEP worth of its own fixed steps
//             with that tick's input, through its own collision, piloted or not; the vehicles players left (a craft
//             no one pilots, a parked car), kept by the edits' rule (edit-keeper.ts Presence: dropped once no player
//             has been near them for a while)
//   outputs:  the frame's time (time: FrameTime), the traffic's state (drawn by view/life.ts StreetLife between its
//             last two ticks), the crafts' (crafts: their cores, drawn between their last two ticks by their shells in
//             nav/), the players' state (seat, walkedPose, driverSnapshot, craftOf), the outcomes of their commands
//             (resultsSince: by player, each with the tick that produced it) and the events, each with the tick that
//             produced it (eventsSince: struck, impact, dropped, seated, unseated, craft, drive), so several readers can
//             each take theirs; the entities (sim/entities.ts: cars, people, crafts read through their own stores).
//             The world keeps no reader's state (docs/adr/0009-layers-and-owners.md): what a reader has read,
//             the seat events it has taken, its last seat input taken are its session's (sim/server/sim-server.ts Session)
import type { LifePhysics } from '../physics/rapier/life-phys';
import type { BoatData } from './boat-traffic';
import type { WaterColumns } from './river';
import { applyNow as applyEdit, crater, type WorldOp } from '../core/world-edits';
import { EditKeeper, Presence } from './edit-keeper';
import { DEFAULT_SEED, STEP, Traffic, type Focus, type Ground } from './traffic';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import type { TrafficData } from './types';
import { Entities, SEATS } from './entities';
import { vehicleOf } from './vehicles';
import type { Craft, CraftWorld } from './craft/craft-core';
import { CORES, type CoreOf } from './craft/cores';
import { VoxelCollision } from './craft/voxel-collision';
import type { CommandResult, CraftSpot, PlayerCommand, Refusal, View } from './contract/commands';
import type { CraftEventOf } from './contract/crafts';
import type { CraftId, CraftType, EntityRef, PlayerId, Role, Seat, VehicleId, WeaponId } from './contract/ids';
import { MAX_DT, type FrameTime } from './contract/inputs';
import { EVENT_TICKS, type SimEvent } from './contract/events';
import type { DriverSnapshot, TimeOfDay } from './contract/snapshot';
import type { WalkPose } from './contract/pose';
import { besideBox, boundWalk, reaches, type Box } from './walk-bounds';
import { craftBox } from './solids';
import { seatKey } from './seat-reads';
import type { GameMode, ModeWorld } from './mode';
import { weaponIn } from './weapons';
import { aimDir, EYE, REACH, Trigger, type Body, type Projectile, type ShotWorld, type VoxelRay } from './weapons/weapon';

/** what the sim keeps of a player: where they look (view: the focus simulated round them, the viewer), the entity
 * followed (kept in the sim wherever it goes, no rights over it), the seat held, and, walking as a person, the walk's
 * poses taken (the walk itself is the client's, sent as poses) */
export interface PlayerState { view?: View; follow?: EntityRef; seat?: Seat; walk?: Walk; trigger?: Trigger }

/** a walk's poses taken: the last (pose, at the sim's clock at), the one an update's poses are bounded against (the
 * last of an earlier update: from, fromAt), the one at the end of the tick before (prev: what is drawn from) and the
 * walk's velocity across (m/s, between the last two ticks a pose was taken in, sent: the last one's place and time:
 * what a tick without one goes on at) */
export interface Walk { pose: WalkPose; at: number; from: WalkPose; fromAt: number; prev: WalkPose; vx: number; vz: number; sent: { x: number; z: number; at: number } }

// A walker's poses reach the host as their page's frames send them, unevenly: a tick none reached would stand still
// and the next jump, which the other players see as a stutter. Moving, such a tick goes on at the walk's velocity, for
// at most GUESS_S after the last pose taken; the next pose taken replaces the guess.
const GUESS_S = 0.1;

// (a player craft, Craft: sim/craft/craft-core.ts)
type CraftState = { -readonly [K in keyof Craft]: Craft[K] } & { input: unknown };

// (what crosses to a client: PlayerId, CraftId, Seat, PilotInput, View, TimeOfDay, FrameTime, MAX_DT, SimEvent,
// EVENT_TICKS: sim/contract/; CraftWorld: sim/craft/craft-core.ts)

// an event yet to be given its tick
type Untimed = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'tick'> : never) : never;

// a command queued: for whom (the host's stamp), and what its sender is told when a seat input of it is taken (the
// tick it is applied in: a session's ack) or an edit of it applied (the tick, its outcome: the sender's own)
type Taken = (tick: number, r?: CommandResult) => void;
// (leave, damage: the host's, not a client's: leave, damage)
interface Queued { player: PlayerId; cmd: PlayerCommand | { kind: 'leave' } | { kind: 'damage'; op: WorldOp }; taken?: Taken }
// a projectile in flight: whose, of which weapon, the body it left (it flies through that one), its time aloft (s)
interface Flying { player: PlayerId; weapon: WeaponId; own: EntityRef; p: Projectile; t: number }

export class WorldSim {
  readonly traffic: Traffic;
  // the events of the last EVENT_TICKS ticks, by tick; those of the tick being run (its commands', its crafts')
  private events: SimEvent[] = [];
  private due: Untimed[] = [];
  /** the players, by id (what is followed, the seat held, the walk; a driver's car is the road physics': driverSnapshot) */
  readonly players: ReadonlyMap<PlayerId, Readonly<PlayerState>> = new Map<PlayerId, PlayerState>();
  // the seat table's other side: who holds each seat taken, by seatKey
  private readonly occupants = new Map<string, PlayerId>();
  // the commands sent, applied at the start of the next tick; their outcomes of the last EVENT_TICKS ticks (at: the
  // tick that produced it, as an event's tick)
  private queue: Queued[] = [];
  // the views sent since the last update, by player (the latest: taken at the update's start)
  private views = new Map<PlayerId, View | null>();
  // the world's time of day and day of the year (setTime)
  private hour = 12;
  private outcomes: { at: number; player: PlayerId; r: CommandResult }[] = [];
  // the sim's clock (s: the end of the tick being run), what the walks are bounded on; the last update's dt
  private clock = 0;
  private frameDt = 0;
  private phys: LifePhysics | null = null;
  // what a shot flies through (setWorld)
  private voxels: VoxelRay | null = null;
  private loading: Promise<LifePhysics> | null = null;
  // the last load of the road physics failed (a car's seat refused as 'failed' until one is in)
  private physFailed = false;
  // dispose ran: a road physics still loading is let go once it is in, none loads again
  private disposed = false;
  private readonly keeper: EditKeeper;
  private flying: Flying[] = [];
  // the blasts' craters not yet taken by the host (takeDamage), which holds their nodes in before they are applied
  private damaged: { player: PlayerId; op: WorldOp }[] = [];
  // the vehicles left ("craft:id", "car:id"): when a player was last near them
  private readonly left: Presence<string>;
  /** the player crafts, by craft id */
  readonly crafts: ReadonlyMap<CraftId, Craft> = new Map<CraftId, CraftState>();
  private nextCraft = 1;
  /** the entities (sim/entities.ts): the cars, people and crafts read through their own stores */
  readonly entities: Entities;
  /** the players' own bodies on foot (avatars), by id: their walker */
  readonly avatars: ReadonlyMap<number, PlayerId> = new Map<number, PlayerId>();
  private nextAvatar = 1;

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
    walk: (player, pose) => this.walk(player, pose),
    sit: (player, seat) => this.enterSeat(player, seat) === true,
    setTime: (hour, day) => this.setTime(hour, day),
    resetDriver: (player) => {
      if (this.seat(player)?.role !== 'driver' || !this.phys) return false;
      this.phys.resetDriver(player);
      return true;
    },
  };

  /** the world's tuning (read-only, sim/tuning.ts); the physics loader is given it */
  readonly tuning: Tuning;

  /** loadPhysics: makes the road physics with the world's tuning (Rapier initialised, its tiles from a cache or a
   * load); crafts: what the crafts' collisions read (without it, addCraft throws); activeR: the radius (m) of the
   * street life's circle round each player */
  constructor(data: TrafficData, private readonly opts: {
    seed?: number; tuning?: Tuning; loadPhysics?: (tuning: Tuning) => Promise<LifePhysics>; crafts?: CraftWorld; activeR?: number;
  } = {}) {
    this.traffic = new Traffic(data, opts.seed ?? DEFAULT_SEED, opts.activeR);
    this.tuning = opts.tuning ?? DEFAULT_TUNING;
    this.keeper = new EditKeeper(this.tuning.presence);
    this.left = new Presence(this.tuning.presence);
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
      // (where its walker puts it)
      avatar: {
        exists: (id) => this.avatars.has(id),
        pose: (id) => {
          const by = this.avatars.get(id), w = by === undefined ? null : this.players.get(by)?.walk?.pose;
          return w ? { x: w.x, y: w.y, z: w.z, h: w.h } : null;
        },
        seats: () => SEATS.avatar,
      },
    });
  }

  /** the road physics, once loaded (loadPhysics) */
  get physics() { return this.phys; }
  /** the world's tick: the number of ticks run */
  get tick() { return this.traffic.tickNumber; }
  get ground() { return this.traffic.ground; }

  /** the world the agents stand on and the boats float on (world.ts World) */
  setWorld(ground: Ground | null, water: WaterColumns | null = null, voxels: VoxelRay | null = null) {
    this.voxels = voxels;
    this.traffic.ground = ground;
    this.traffic.water = water;
  }

  setBoats(data: BoatData) { this.traffic.setBoats(data); }

  /** box (map metres [x0, z0, x1, z1)) was edited, or, cleared, is its files' again */
  edited(box: [number, number, number, number], cleared = false) { this.traffic.edited(box, cleared); }

  /** the road physics loaded (once; again after a failure) and attached to the traffic; warm: where the terrain's
   * colliders are wanted soon (a drive about to start). The host's to call (host/sim-host.ts: at its start, on an
   * edit); a car's seat asked for before it is in starts it too (enterSeat) */
  async loadPhysics(warm?: { x: number; z: number }) {
    const load = this.opts.loadPhysics;
    if (!load) throw new Error('WorldSim: no physics loader');
    if (this.disposed) throw new Error('WorldSim: disposed');
    this.loading ??= load(this.tuning).then((p) => {
      if (this.disposed) { p.dispose(); throw new Error('WorldSim: disposed'); }
      this.phys = p;
      this.physFailed = false;
      this.traffic.bodies = p;
      return p;
    }).catch((error) => { this.loading = null; this.physFailed = true; throw error; });
    const p = await this.loading;
    if (warm) await p.warmTerrain(warm);
    return p;
  }

  /** the road physics let go (its Rapier world, its terrain's listener on the world's edits; one still loading once it
   * is in): a host done with its world (host/sim-host.ts hostSim, SimServer.dispose) */
  dispose() {
    this.disposed = true;
    this.phys?.dispose();
    this.phys = null;
    this.loading = null;
    this.traffic.bodies = null;
  }

  /** the frame's time when its update has run: what is drawn between the last two ticks is alpha of the way */
  get time(): FrameTime { return { dt: this.frameDt, tick: this.tick, alpha: this.traffic.acc / STEP }; }

  /** the world's time of day (hour, wrapped to 0..24) and day of the year (1..365; without: kept): the host's to
   * set (at its start; later through a mode, a player's setTime request) */
  setTime(hour: number, day?: number) {
    if (!Number.isFinite(hour)) return;
    this.hour = ((hour % 24) + 24) % 24;
    if (day !== undefined && Number.isFinite(day)) this.traffic.day = Math.min(365, Math.max(1, Math.round(day)));
  }

  /** the world's time of day and day of the year */
  get timeOfDay(): TimeOfDay { return { hour: this.hour, day: this.traffic.day }; }

  /** the world ticks due after dt s (at most MAX_DT of them; the rest under STEP carried: time.alpha), simulated round
   * the players' views (the views sent taken first); what they did: eventsSince */
  update(dt: number) {
    const T = this.traffic, hour = this.hour;
    for (const [player, view] of this.views) {
      if (view) this.player(player).view = view;
      else delete (this.players.get(player) as PlayerState | undefined)?.view;
    }
    this.views.clear();
    dt = Math.min(MAX_DT, Math.max(0, dt));
    this.frameDt = dt;
    // (an active circle round each player's view; with none, where they were)
    const views: Focus[] = [];
    for (const [id, P] of this.players) if (P.view) views.push({ id, focus: P.view.focus, viewer: P.view.viewer });
    const density = T.frame(hour, views);
    T.acc += dt;
    while (T.acc >= STEP) {
      this.runTick(() => T.tick(density, hour));
      T.acc -= STEP;
    }
  }

  // One world tick (ADR 0007's order): the commands due, the edits and the vehicles left no player is near any more
  // dropped (the tick sees it), the crafts' steps with this tick's input, the traffic's tick (the bodies in it), then
  // the tick's events in order
  private runTick(traffic: () => void) {
    const T = this.traffic, t0 = this.tick;
    this.clock = (t0 + 1) * STEP;
    const q = this.queue;
    this.queue = [];
    for (const P of this.players.values()) if (P.walk) P.walk.prev = P.walk.pose;
    for (const cmd of q) this.apply(cmd);
    this.fly();
    for (const P of this.players.values()) {
      const W = P.walk;
      if (W && W.at !== this.clock && W.pose.moving && this.clock - W.at <= GUESS_S + 1e-9)
        W.pose = { ...W.pose, x: W.pose.x + W.vx * STEP, z: W.pose.z + W.vz * STEP };
    }
    const now = t0 * STEP, foci = this.foci();
    this.holdVoxels();
    this.keeper.update(now, foci);
    this.dropLeft(now, foci);
    this.stepCrafts();
    traffic();
    const fresh: SimEvent[] = [];
    if (this.due.length) { for (const e of this.due) fresh.push({ tick: t0 + 1, ...e }); this.due = []; }
    if (T.dropped.length || T.struck.length) {
      fresh.push(...T.dropped.map((d) => ({ kind: 'dropped' as const, ...d })));
      for (const { by, ...s } of T.struck) {
        fresh.push({ kind: 'struck', ...s }, { tick: s.tick, kind: 'impact', entity: { kind: 'person', id: s.person },
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
    if (this.outcomes.length && this.outcomes[0].at <= old) this.outcomes = this.outcomes.filter((o) => o.at > old);
  }

  /** the events of the ticks after tick (a reader keeps the tick it read up to: WorldSim.tick), oldest first */
  eventsSince(tick: number): SimEvent[] {
    const E = this.events;
    let i = E.length;
    while (i > 0 && E[i - 1].tick > tick) i--;
    return E.slice(i);
  }

  /** the events of the last EVENT_TICKS ticks, oldest first (read only; a reader keeps its own place in it) */
  get eventLog(): readonly SimEvent[] { return this.events; }

  /** the outcomes of the player's commands applied in the ticks after tick (a reader keeps the tick it read up to:
   * WorldSim.tick), oldest first; kept EVENT_TICKS ticks, as the events */
  resultsSince(player: PlayerId, tick: number): CommandResult[] {
    const O = this.outcomes, out: CommandResult[] = [];
    let i = O.length;
    while (i > 0 && O[i - 1].at > tick) i--;
    for (; i < O.length; i++) if (O[i].player === player) out.push(O[i].r);
    return out;
  }

  // ------------------------------------------------------------------ the players (ADR 0007), keyed by player id
  // A player holds at most one seat on an entity (ADR 0008: control per seat, Seat; the seats of each entity's model:
  // sim/entities.ts SEATS): the driver's of a car, the walker's of a person on foot, the pilot's of a craft. Taking a
  // seat (enterSeat) checks it first (the entity there, the seat in its model and free, mayEnter) and, if it may be
  // taken, leaves the one held: one command switches seats, with no tick in between where the player holds none;
  // refused, the player keeps theirs. A seat's input (seatInput) is its role's. Following carries no rights. Only
  // players with sim authority come here: a creative camera (orbit, free flight) is the client's and only moves the
  // focus and the viewer (its view; whether it has presence: app/session.ts OBSERVER_VIEW).

  /** what the game mode acts through (SimServer asks it about edits with it) */
  get modeWorld() { return this.face; }

  /** player's command (player: the host's stamp, never a client's word), applied at the start of the next tick
   * (after those sent before it); taken: told the tick a seat input with a seq is applied in, if the seat held takes
   * it (its sender's ack), and the tick an edit is applied in with its outcome (the sender's alone; without taken, the
   * player's outcomes). An edit's nodes are to be in the world's TileCache by then (core/world-edits.ts ready: the
   * host's, sim/server/sim-server.ts): a node not in is left out */
  send(player: PlayerId, cmd: PlayerCommand, taken?: Taken) {
    if (cmd.kind === 'view') this.views.set(player, cmd.view && { focus: { x: cmd.view.focus.x, z: cmd.view.focus.z },
      ...(cmd.view.viewer ? { viewer: { x: cmd.view.viewer.x, z: cmd.view.viewer.z, y: cmd.view.viewer.y } } : {}) });
    else this.queue.push({ player, cmd, taken });
  }

  /** the player gone (their host's last connection left: SimServer.disconnect): in the next tick they leave their seat
   * and their entry in players goes (their view: send a null one) */
  leave(player: PlayerId) { this.queue.push({ player, cmd: { kind: 'leave' } }); }

  /** whether the game mode lets player make an edit with op (its mayEdit; none: no), asked when the edit is applied
   * and by the host before it holds the edit's nodes (sim/server/sim-server.ts holdEdit) */
  mayEdit(player: PlayerId, op: WorldOp) { return !!this.mode?.mayEdit?.(this.face, player, op); }

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
  private apply({ player: p, cmd, taken }: Queued) {
    switch (cmd.kind) {
      case 'view': break; // (taken at the update's start: send)
      case 'follow': this.follow(p, cmd.entity); break;
      case 'enterSeat': {
        const r = this.reaches(p, cmd.entity, cmd.role) ? this.enterSeat(p, cmd) : 'far';
        this.result(p, cmd.kind, r === true, cmd.role ?? this.entities.seat(cmd.entity)?.role, typeof r === 'string' ? r : undefined);
        break;
      }
      case 'seatInput': {
        if (this.seat(p)?.role !== cmd.role) break;
        if (cmd.seq !== undefined) taken?.(this.tick + 1);
        if (cmd.role === 'driver') this.phys?.input(p, cmd.input);
        else if (cmd.role === 'pilot') (this.craftOf(p) as CraftState).input = cmd.input;
        else if (!this.walkPose(p, cmd.input)) this.result(p, cmd.kind, false, 'walker');
        break;
      }
      case 'request': this.result(p, cmd.request.kind, !!this.mode?.request(this.face, p, cmd.request)); break;
      case 'leaveSeat': {
        // (out onto foot: put down beside what was left, in the same tick, so no tick shows neither)
        const s = this.seat(p), box = s && s.role !== 'walker' && cmd.pose && finitePose(cmd.pose) ? this.boxOf(s.entity) : null;
        this.leaveSeat(p);
        if (box) this.walk(p, besideBox({ ...cmd.pose!, moving: false }, box, this.tuning.walk.board));
        break;
      }
      case 'leave': this.leaveSeat(p); (this.players as Map<PlayerId, PlayerState>).delete(p); this.held(); break;
      case 'edit': {
        const r: CommandResult = { tick: this.tick, kind: 'edit', ok: false, ref: cmd.ref ?? 0 };
        if (this.mayEdit(p, cmd.op)) {
          // (the world's voxels changed now: its listeners hear of it in this tick, the sim's edited among them)
          try { r.nodes = applyEdit(cmd.op); r.ok = r.nodes.length > 0; } catch { r.ok = false; }
        }
        if (taken) taken(this.tick + 1, r); else this.outcomes.push({ at: this.tick + 1, player: p, r });
        break;
      }
      case 'fire': this.fire(p, cmd.slot, cmd.h, cmd.pitch); break;
      case 'damage': {
        // (no mode asked: the blast was the weapon's, fired as the rules allowed)
        try { applyEdit(cmd.op); this.keeper.last(cmd.op); } catch { /* (no world to edit) */ }
        taken?.(this.tick + 1);
        break;
      }
    }
  }

  // a shot from the eyes of the player on foot, where this sim has them (never the page's word for them), if their
  // weapon in slot is ready
  private fire(player: PlayerId, slot: number, h: number, pitch: number) {
    const P = this.players.get(player) as PlayerState | undefined, s = P && this.seat(player), w = weaponIn(slot);
    if (!P?.walk || s?.role !== 'walker' || !w || !Number.isFinite(h) || !Number.isFinite(pitch)) return;
    if (!(P.trigger ??= new Trigger()).pull(w, this.clock)) return;
    const f = P.walk.pose, from = { x: f.x, y: f.y + EYE, z: f.z };
    const shot = w.fire(this.shotWorld(s.entity), from, aimDir(h, Math.max(-1.5, Math.min(1.5, pitch))));
    if (!('fly' in shot)) { this.due.push({ kind: 'shot', weapon: w.id, player, ...shot }); return; }
    this.flying.push({ player, weapon: w.id, own: s.entity, p: shot, t: 0 });
    this.due.push({ kind: 'launch', weapon: w.id, player, at: { ...shot.at }, v: { ...shot.v } });
  }

  // the projectiles' flight through this tick; one that bursts: its blast, and its crater for the host to apply
  private fly() {
    if (!this.flying.length) return;
    this.flying = this.flying.filter((f) => {
      const at = f.p.fly(this.shotWorld(f.own), f.t, f.t += STEP);
      if (!at) return true;
      this.due.push({ kind: 'blast', weapon: f.weapon, player: f.player, at: { ...at }, r: f.p.r });
      try { this.damaged.push({ player: f.player, op: crater(at.x, at.y, at.z, f.p.r) }); } catch { /* (no world to edit) */ }
      return false;
    });
  }

  /** the blasts' craters since the last call, for the host to hold their nodes in and hand back (damage) */
  takeDamage() { return this.damaged.splice(0); }

  /** a blast's crater (takeDamage), its nodes in the world's TileCache: applied at the start of the next tick, kept
   * whoever is near (sim/edit-keeper.ts last); done: told once it is */
  damage(player: PlayerId, op: WorldOp, done?: () => void) { this.queue.push({ player, cmd: { kind: 'damage', op }, taken: done }); }

  // the voxels round each player on foot kept loaded (a ray into a node not loaded would fly through its houses)
  private holdVoxels() {
    const V = this.voxels;
    if (!V?.hold) return;
    const at: { x: number; z: number }[] = [];
    for (const P of this.players.values()) if (P.walk && P.seat?.role === 'walker') at.push(P.walk.pose);
    V.hold(at, REACH);
  }

  // whether player may ask for a seat of entity with role from where they are: on foot (their avatar), a vehicle only
  // within Tuning.walk.board of where the host has the walker, not where the page says (a seat the mode gives, a
  // craft made, is the mode's to place)
  private reaches(player: PlayerId, entity: EntityRef, role?: Role) {
    const held = this.seat(player), W = this.players.get(player)?.walk;
    if (held?.entity.kind !== 'avatar' || !W || (role ?? this.entities.seat(entity)?.role) === 'walker' || !this.entities.exists(entity)) return true;
    const box = this.boxOf(entity);
    return !!box && reaches(W.pose, box, this.tuning.walk.board);
  }

  // entity's footprint as a shot meets it, or null: not in the world
  private boxOf(entity: EntityRef): Box | null {
    const none: EntityRef = { kind: entity.kind === 'avatar' ? 'car' : 'avatar', id: -1 };
    for (const b of this.shotWorld(none).bodies()) if (b.entity.kind === entity.kind && b.entity.id === entity.id) return { ...b };
    return null;
  }

  // the voxels and the bodies a shot of the player on `own` meets (their own body left out)
  private shotWorld(own: EntityRef): ShotWorld {
    const T = this.traffic, sim = this;
    return {
      voxels: this.voxels,
      *bodies(): Generator<Body> {
        const at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 }, pt = { x: 0, y: 0, z: 0 };
        const mine = (kind: EntityRef['kind'], id: number) => own.kind === kind && own.id === id;
        for (const list of [T.cars, T.detachedCars]) for (const c of list) {
          if (mine('car', c.id)) continue;
          const d = c.detachedPose;
          if (d) Object.assign(at, d); else T.carPose(c, c.s, c.off, at);
          yield { entity: { kind: 'car', id: c.id }, x: at.x, y: at.y, z: at.z, h: at.h, r: 0.9, l: c.bus ? 6 : 2.2, ht: c.bus ? 3 : 1.5 };
        }
        for (const list of [T.people, T.riders]) for (const p of list) {
          if (mine('person', p.id)) continue;
          const w = sim.walkedPose(p.id), q = w ? null : T.personPoint(p, 0, pt);
          // (personPoint: x, z on the map as x, y; the height as z)
          yield { entity: { kind: 'person', id: p.id }, x: w?.x ?? q!.x, y: w?.y ?? q!.z, z: w?.z ?? q!.y, h: 0, r: 0.3, l: p.bike ? 0.9 : 0.3, ht: 1.8 };
        }
        for (const [id, by] of sim.avatars) {
          const w = sim.players.get(by)?.walk?.pose;
          if (w && !mine('avatar', id)) yield { entity: { kind: 'avatar', id }, x: w.x, y: w.y, z: w.z, h: w.h, r: 0.3, l: 0.3, ht: 1.8 };
        }
        for (const c of sim.crafts.values()) {
          const p = c.core.pose;
          if (c.placed && !mine('craft', c.id)) yield { entity: { kind: 'craft', id: c.id }, ...craftBox(c.type, p) };
        }
      },
    };
  }

  // (produced by the tick being run, as its events)
  private result(player: PlayerId, kind: CommandResult['kind'], ok: boolean, role?: Role, reason?: Refusal) {
    const r: CommandResult = { tick: this.tick, kind, ok };
    if (role) r.role = role;
    if (reason) r.reason = reason;
    this.outcomes.push({ at: this.tick + 1, player, r });
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
      if (s.entity.kind === 'avatar') (this.avatars as Map<number, PlayerId>).delete(s.entity.id);
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
  // was already); false: gone, no such seat, another's, not allowed (the mode's mayEnter, also when the mode seats the
  // player itself: ModeWorld.sit), or the role's own refusal (a car: no road physics, a Refusal while it loads or after
  // its load failed, the load started here with the terrain warmed round the car; a person: not in the crowd on foot).
  // The walker's from pose (where they are drawn: kept within Tuning.walk.take of where the sim has them), the
  // driver's as type choice (the car taken shows in driverSnapshot; the terrain round it warmed)
  private enterSeat(player: PlayerId, cmd: { entity: EntityRef; role?: Role; index?: number; choice?: VehicleId; pose?: WalkPose }): boolean | Refusal {
    const seat = this.entities.seat(cmd.entity, cmd.role, cmd.index);
    if (!seat) return false;
    const by = this.occupants.get(seatKey(seat));
    if (by === player) return true;
    if (by !== undefined) return 'taken';
    if (this.mode?.mayEnter && !this.mode.mayEnter(this.face, player, seat)) return false;
    const id = seat.entity.id;
    if (seat.role === 'walker') {
      let start: WalkPose;
      if (seat.entity.kind === 'avatar') {
        if (!cmd.pose) return false;
        start = { ...cmd.pose };
      } else {
        const person = this.traffic.people.find((p) => p.id === id);
        if (!person) return false;
        const at = this.traffic.personPoint(person, 0, { x: 0, y: 0, z: 0 }), take = this.tuning.walk.take;
        const pose = cmd.pose ?? { x: at.x, y: at.z, z: at.y, h: 0, moving: false };
        const dx = pose.x - at.x, dz = pose.z - at.y, d = Math.hypot(dx, dz), k = d > take ? take / d : 1;
        start = k < 1 ? { ...pose, x: at.x + dx * k, z: at.y + dz * k } : { ...pose };
      }
      const t = this.clock - STEP;
      this.leaveSeat(player);
      this.sit(player, seat);
      this.player(player).walk = { pose: start, at: t, from: start, fromAt: t, prev: start, vx: 0, vz: 0, sent: { x: start.x, z: start.z, at: t } };
      this.held();
    } else if (seat.role === 'driver') {
      const phys = this.phys, at = this.entities.pose(seat.entity), warm = at ? { x: at.x, z: at.z } : undefined;
      if (!phys) {
        if (!this.opts.loadPhysics || this.disposed) return false;
        const failed = this.physFailed;
        this.loadPhysics(warm).catch(() => {});
        return failed ? 'failed' : 'loading';
      }
      if (warm) phys.warmTerrain(warm).catch(() => {});
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
    const taken = boundWalk(W.from, pose, this.clock - W.fromAt, this.tuning.walk), S = W.sent, dt = this.clock - S.at;
    W.pose = { ...taken };
    W.at = this.clock;
    if (dt > 0) { W.vx = (taken.x - S.x) / dt; W.vz = (taken.z - S.z) / dt; W.sent = { x: taken.x, z: taken.z, at: this.clock }; }
    else { S.x = taken.x; S.z = taken.z; }
    return taken === pose;
  }

  // the player on foot (a mode's walk): their avatar put down at pose (one held: there again, nothing drawn between);
  // else a new one, the player its walker (the seat held left first); false: not seated (the mode's mayEnter)
  private walk(player: PlayerId, pose: WalkPose) {
    const s = this.seat(player), W = this.players.get(player)?.walk;
    if (s?.entity.kind === 'avatar' && W) {
      const at = { ...pose }, t = this.clock - STEP;
      Object.assign(W, { pose: at, at: t, from: at, fromAt: t, prev: at, vx: 0, vz: 0, sent: { x: at.x, z: at.z, at: t } });
      return true;
    }
    const id = this.nextAvatar++, avatars = this.avatars as Map<number, PlayerId>;
    avatars.set(id, player);
    if (this.enterSeat(player, { entity: { kind: 'avatar', id }, role: 'walker', pose }) === true) return true;
    avatars.delete(id);
    return false;
  }

  private player(id: PlayerId) {
    const M = this.players as Map<PlayerId, PlayerState>;
    let P = M.get(id);
    if (!P) M.set(id, P = {});
    return P;
  }

  // Where the players are (map metres), for the edits kept (sim/edit-keeper.ts) and the vehicles left: each player's
  // view's focus, seat entity (the person walked, the car driven, the craft piloted) and entity followed
  private foci() {
    const out: { x: number; z: number }[] = [], E = this.entities;
    for (const P of this.players.values()) {
      if (P.view) out.push(P.view.focus);
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
      if (P.follow?.kind === 'car' || P.follow?.kind === 'person') held[P.follow.kind].add(P.follow.id);
      if (P.seat?.role === 'walker' && P.seat.entity.kind === 'person') { held.person.add(P.seat.entity.id); walked.add(P.seat.entity.id); }
    }
  }

  // The driver's car: the road physics' (loadPhysics)
  /** the player's car now, or null while they drive none (what its driver is to be told: the car's drive events) */
  driverSnapshot(player: PlayerId): DriverSnapshot | null { return this.phys?.driverSnapshot(player) ?? null; }

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
      // (a core of its type's events: sim/craft/cores.ts asserts the contract's are the cores')
      if (core.events.length) for (const e of core.events.splice(0)) this.due.push({ kind: 'craft', entity: { kind: 'craft', id: c.id }, ...{ craft: c.type, e } as CraftEventOf });
    }
  }
}

const finitePose = (p: WalkPose) => [p.x, p.y, p.z, p.h].every(Number.isFinite);
