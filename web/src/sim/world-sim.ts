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
//             nav/), the players' state (seat, driverSnapshot, craftOf), the outcomes of their commands
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
import { DEFAULT_SEED, STEP, Traffic, type Focus, type Ground, type WallBox } from './traffic';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import type { TrafficData } from './types';
import { Entities } from './entities';
import { inArc, mountOf, mountPoint, SEATS } from './seats';
import { vehicleOf, VEHICLES } from './vehicles';
import { Stands } from './stands';
import type { Craft, CraftWorld } from './craft/craft-core';
import { CORES, type CoreOf } from './craft/cores';
import { CEILING, VoxelCollision } from './craft/voxel-collision';
import type { CommandResult, CraftSpot, PlayerCommand, Refusal, View } from './contract/commands';
import type { CraftEventOf } from './contract/crafts';
import type { CraftId, CraftType, EntityRef, PlayerId, Role, Seat, VehicleId, WeaponId } from './contract/ids';
import { MAX_DT, PARK, type FrameTime } from './contract/inputs';
import { EVENT_TICKS, type SimEvent } from './contract/events';
import type { DriverSnapshot, TimeOfDay } from './contract/snapshot';
import type { WalkPose } from './contract/pose';
import { besideBox, boundWalk, reaches, type Box } from './walk-bounds';
import { craftBox } from './solids';
import { seatKey } from './seat-reads';
import type { GameMode, ModeWorld } from './mode';
import { weaponById, weaponIn } from './weapons';
import { Npcs } from './npcs';
import { aimFrom, CHEST, newMind, RANGE, think, type Duty, type Senses } from './npc-mind';
import type { Vec3 } from '../core/vec';
import { lifeKey, Lives, type DamageKind, type Life, type Toughness } from './health';
import { bodyClear, carried, carShape, COACH_SHAPE, craftSolids, headroom, lightSolids, meetShapes, meetSolids, onRoof, overlap, pushOut, roofSpot, roofUnder, solidAt, vesselShape, WALKER_STEP, type Shape, type Solid, type Walls } from './solids';
import { WRECK_COL, type BoatPose } from './contract/agents';
import { aimDir, EYE, REACH, Trigger, type Body, type MapBox, type Projectile, type ShotWorld, type VoxelRay, type Weapon } from './weapons/weapon';

/** what the sim keeps of a player: where they look (view: the focus simulated round them, the viewer), the entity
 * followed (kept in the sim wherever it goes, no rights over it), the seat held, and, walking as a person, the walk's
 * poses taken (the walk itself is the client's, sent as poses) */
export interface PlayerState { view?: View; follow?: EntityRef; seat?: Seat; walk?: Walk; trigger?: Trigger }

/** a walk's poses taken: the last (pose, at the sim's clock at), the one an update's poses are bounded against (the
 * last of an earlier update: from, fromAt), the one at the end of the tick before (prev: what is drawn from) and the
 * walk's velocity across (m/s, between the last two ticks a pose was taken in, sent: the last one's place and time:
 * what a tick without one goes on at) */
export interface Walk { pose: WalkPose; at: number; from: WalkPose; fromAt: number; prev: WalkPose; vx: number; vz: number; sent: { x: number; z: number; at: number };
  /** the solid whose roof pose (from) stands on, as it was then */
  on?: Solid | null; fromOn?: Solid | null;
  /** a descent under way: the height it began at, its ticks so far, the ticks since the walker last went down */
  fall?: { top: number; ticks: number; quiet: number } }

// A walker's poses reach the host as their page's frames send them, unevenly: a tick none reached would stand still
// and the next jump, which the other players see as a stutter. Moving, such a tick goes on at the walk's velocity, for
// at most GUESS_S after the last pose taken; the next pose taken replaces the guess.
const GUESS_S = 0.1;

// (a player craft, Craft: sim/craft/craft-core.ts)
// (asleep: a stand's, untouched: not stepped, its collision let go, until a seat is taken or it is harmed)
type CraftState = { -readonly [K in keyof Craft]: Craft[K] } & { input: unknown; asleep?: boolean };

// (what crosses to a client: PlayerId, CraftId, Seat, PilotInput, View, TimeOfDay, FrameTime, MAX_DT, SimEvent,
// EVENT_TICKS: sim/contract/; CraftWorld: sim/craft/craft-core.ts)

// an event yet to be given its tick
type Untimed = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'tick'> : never) : never;

// a command queued: for whom (the host's stamp), and what its sender is told when a seat input of it is taken (the
// tick it is applied in: a session's ack) or an edit of it applied (the tick, its outcome: the sender's own)
type Taken = (tick: number, r?: CommandResult) => void;
// (leave, handsOff, damage: the host's, not a client's: leave, handsOff, damage)
interface Queued { player: PlayerId; cmd: PlayerCommand | { kind: 'leave' } | { kind: 'handsOff' } | { kind: 'damage'; op: WorldOp }; taken?: Taken; waited?: number }
// a projectile in flight: whose, of which weapon, the body it left (it flies through that one), its time aloft (s)
interface Flying { player: PlayerId; weapon: WeaponId; damage: Weapon['damage']; own: EntityRef; p: Projectile; t: number }

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
  /** called at each tick's start with that tick, before its commands are taken: the host sends then what it held
   * for it (sim/server/sim-server.ts, the seat inputs by tick) */
  beforeTick: ((tick: number) => void) | null = null;
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
  // what a walker carried on a roof is kept out of (setWorld; none: carried anywhere)
  private walls: (Walls & Ground) | null = null;
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
  private readonly carAt = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
  /** the entities (sim/entities.ts): the cars, people and crafts read through their own stores */
  readonly entities: Entities;
  /** the players' own bodies on foot (avatars), by id: their walker */
  readonly avatars: ReadonlyMap<number, PlayerId> = new Map<number, PlayerId>();
  private nextAvatar = 1;
  /** the lives below full health and the players down (sim/health.ts) */
  readonly lives = new Lives();
  // the vehicles at 0 the mode let be wrecks ("car:12", "craft:3"); the last place each player stood on the ground
  private readonly wrecks = new Set<string>();
  private readonly safe = new Map<PlayerId, WalkPose>();
  // the stands' cars' ids: far past any the traffic reaches, so stocking a car never shifts the traffic's own
  private nextStandCar = STAND_CARS;
  /** the stands of placed vehicles (sim/stands.ts), when the host asked for them */
  readonly stands: Stands | null = null;
  /** the NPCs on foot (sim/npcs.ts), drawn as avatars */
  readonly npcs = new Npcs();

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
    addNpc: (player, patrol) => {
      const W = this.players.get(player)?.walk;
      if (this.seat(player)?.role !== 'walker' || !W) return false;
      const p = W.pose, x = p.x + Math.sin(p.h) * NPC_AHEAD, z = p.z + Math.cos(p.h) * NPC_AHEAD;
      const y = this.ground?.support(x, z, p.y + 2) ?? p.y;
      const R = NPC_LOOP, duty: Duty = patrol ? { kind: 'patrol', loop: [[R, R], [R, -R], [-R, -R], [-R, R]].map(([u, v]) => ({ x: x + u, z: z + v })) }
        : { kind: 'guard', x, z, h: p.h + Math.PI };
      this.addNpc({ x, y, z }, undefined, duty);
      return true;
    },
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
   * street life's circle round each player; stands: vehicles placed for the taking round the players (needs crafts) */
  constructor(data: TrafficData, private readonly opts: {
    seed?: number; tuning?: Tuning; loadPhysics?: (tuning: Tuning) => Promise<LifePhysics>; crafts?: CraftWorld; activeR?: number; stands?: boolean;
  } = {}) {
    this.traffic = new Traffic(data, opts.seed ?? DEFAULT_SEED, opts.activeR);
    this.seed = (opts.seed ?? DEFAULT_SEED) >>> 0;
    this.tuning = opts.tuning ?? DEFAULT_TUNING;
    this.keeper = new EditKeeper(this.tuning.presence);
    this.left = new Presence(this.tuning.presence);
    const T = this.traffic, at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 }, ahead = { x: 0, y: 0, z: 0 };
    T.inTheWay = (p, before) => this.inTheWay(p, before);
    T.walls = () => this.craftWalls();
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
      // (on their way: personPoint's x, z on the map as x, y)
      person: {
        exists: (id) => !!person(id),
        pose: (id) => {
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
    if (opts.stands && opts.crafts) this.stands = this.makeStands(opts.crafts);
  }

  /** the road physics, once loaded (loadPhysics) */
  get physics() { return this.phys; }
  /** the world's tick: the number of ticks run */
  get tick() { return this.traffic.tickNumber; }
  get ground() { return this.traffic.ground; }

  /** the world the agents stand on and the boats float on (world.ts World) */
  setWorld(ground: (Ground & Partial<Walls>) | null, water: WaterColumns | null = null, voxels: VoxelRay | null = null) {
    this.voxels = voxels;
    this.walls = ground?.blocked ? ground as Walls & Ground : null;
    this.traffic.ground = ground;
    this.traffic.water = water;
    const walls = this.walls;
    this.npcs.world = walls && water ? { support: (x, z, top) => walls.support(x, z, top), blocked: (x, z, y0, y1) => walls.blocked(x, z, y0, y1),
      waterColumn: (x, z) => water.waterColumn(x, z, 0, 0) } : null;
  }

  setBoats(data: BoatData) {
    this.traffic.setBoats(data);
    if (this.stands) this.stands.berths = data.berths;
  }

  /** box (map metres [x0, z0, x1, z1)) was edited, or, cleared, is its files' again */
  edited(box: [number, number, number, number], cleared = false) { this.traffic.edited(box, cleared); this.npcs.edited(box); }

  /** an NPC on foot put down standing at (x, y, z) (y: its soles), walking at speed m/s; with a duty, an enemy that
   * keeps it (sim/npc-mind.ts), else one that only walks where it is sent; its avatar's id */
  addNpc(at: { x: number; y: number; z: number }, speed?: number, duty?: Duty) {
    const id = this.nextAvatar++;
    this.npcs.add(id, at, speed, duty ? newMind(duty, this.clock) : null);
    return id;
  }

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
    this.stands?.dispose();
    for (const c of this.crafts.values()) c.collision.release();
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
    this.beforeTick?.(t0 + 1);
    const q = this.queue;
    this.queue = [];
    for (const P of this.players.values()) if (P.walk) P.walk.prev = P.walk.pose;
    for (const cmd of q) this.apply(cmd);
    this.fly();
    for (const P of this.players.values()) {
      const W = P.walk;
      // (one on a roof is carried with it after the step instead)
      if (W && !W.on && W.at !== this.clock && W.pose.moving && this.clock - W.at <= GUESS_S + 1e-9) this.guess(W);
    }
    const now = t0 * STEP, foci = this.foci();
    this.holdVoxels();
    this.keeper.update(now, foci);
    this.dropLeft(now, foci);
    this.stands?.update(now, foci);
    this.stepCrafts();
    T.walkers = [...this.players.values()].flatMap((P) => (P.walk ? [P.walk.pose] : []));
    const crafts: Solid[] = [];
    for (const c of this.crafts.values()) if (c.placed) craftSolids(c.type, c.core.pose, crafts);
    T.crafts = crafts;
    traffic();
    for (const P of this.players.values()) if (P.walk?.on) this.carryOn(P.walk);
    if (this.npcs.all.size) { this.minds(); this.npcs.tick(STEP, (x, z) => this.walkSolids(x, z)); }
    this.harm();
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
  // sim/seats.ts SEATS): the driver's of a car, the walker's of the player's avatar, the pilot's of a craft. Taking a
  // seat (enterSeat) checks it first (the entity there, the seat in its model and free, mayEnter) and, if it may be
  // taken, leaves the one held: one command switches seats, with no tick in between where the player holds none;
  // refused, the player keeps theirs. A seat's input (seatInput) is its role's. Following carries no rights. Only
  // players with sim authority come here: a creative camera (orbit, free flight) is the client's and only moves the
  // focus and the viewer (its view: a presence, unseen by the others).

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

  /** the player's connection lost for now (SimServer.disconnect, held): in the next tick their seat is kept but let go
   * of, as a driver who stepped away briefly would (the car parked, the craft's controls neutral, the body standing),
   * so a vehicle does not go on with the last input sent */
  handsOff(player: PlayerId) { this.queue.push({ player, cmd: { kind: 'handsOff' } }); }

  /** whether the game mode lets player make an edit with op (its mayEdit; none: no), asked when the edit is applied
   * and by the host before it holds the edit's nodes (sim/server/sim-server.ts holdEdit) */
  mayEdit(player: PlayerId, op: WorldOp) { return !!this.mode?.mayEdit?.(this.face, player, op); }

  /** the seat the player holds (its entity in the world), or null */
  seat(player: PlayerId): Seat | null {
    const s = this.players.get(player)?.seat;
    return s && this.entities.exists(s.entity) ? s : null;
  }

  // the one place a command takes effect
  private apply(q: Queued) {
    const { player: p, cmd, taken } = q;
    switch (cmd.kind) {
      case 'view': break; // (taken at the update's start: send)
      case 'follow': this.follow(p, cmd.entity); break;
      case 'enterSeat': {
        const why = this.mayBoard(p, cmd.entity, cmd.role), r = why === true ? this.enterSeat(p, cmd) : why;
        this.result(p, cmd.kind, r === true, cmd.role ?? this.entities.seat(cmd.entity)?.role, typeof r === 'string' ? r : undefined);
        break;
      }
      case 'seatInput': {
        const s = this.seat(p);
        if (s?.role !== cmd.role) break;
        if (cmd.seq !== undefined) taken?.(this.tick + 1);
        // (one down, or at the wheel of a wreck, steers nothing: handsOff and wreck let go of the controls once)
        if (this.lives.down.has(p) || (s.role !== 'walker' && this.wrecks.has(lifeKey(s.entity as Life)))) break;
        if (cmd.role === 'driver') this.phys?.input(p, cmd.input);
        else if (cmd.role === 'pilot') (this.craftOf(p) as CraftState).input = cmd.input;
        else if (!this.walkPose(p, cmd.input)) this.result(p, cmd.kind, false, 'walker');
        break;
      }
      case 'request': this.result(p, cmd.request.kind, !this.lives.down.has(p) && !!this.mode?.request(this.face, p, cmd.request)); break;
      case 'leaveSeat': {
        if (this.lives.down.has(p)) break;
        // (out onto foot: put down beside what was left, in the same tick, so no tick shows neither)
        const s = this.seat(p), box = s && s.role !== 'walker' && cmd.pose && finitePose(cmd.pose) ? this.boxOf(s.entity) : null;
        this.leaveSeat(p);
        if (box) this.walk(p, besideBox({ ...cmd.pose!, moving: false }, box, this.tuning.walk.board));
        break;
      }
      case 'leave': {
        this.leaveSeat(p);
        (this.players as Map<PlayerId, PlayerState>).delete(p);
        this.held();
        this.lives.heal(lifeKey({ kind: 'player', id: p }));
        this.lives.down.delete(p);
        this.safe.delete(p);
        break;
      }
      case 'handsOff': {
        const role = this.seat(p)?.role, W = this.players.get(p)?.walk;
        if (role === 'driver') this.phys?.input(p, PARK);
        else if (role === 'pilot') { const c = this.craftOf(p) as CraftState | null; if (c) c.input = c.core.neutral; }
        else if (role === 'walker' && W) { W.pose = { ...W.pose, moving: false }; W.vx = W.vz = 0; }
        break;
      }
      case 'edit': {
        const r: CommandResult = { tick: this.tick, kind: 'edit', ok: false, ref: cmd.ref ?? 0 };
        if (this.mayEdit(p, cmd.op)) {
          // (the world's voxels changed now: its listeners hear of it in this tick, the sim's edited among them)
          try { r.nodes = applyEdit(cmd.op); r.ok = r.nodes.length > 0; } catch { r.ok = false; }
        }
        if (taken) taken(this.tick + 1, r); else this.outcomes.push({ at: this.tick + 1, player: p, r });
        break;
      }
      case 'fire': {
        // (a ray into a node not loaded meets nothing: the shot waits for its nodes, a few ticks at most)
        const a = this.aim(p, cmd), V = this.voxels;
        if (!a) break;
        if ((q.waited ?? 0) >= FIRE_WAIT || !V?.ready || V.ready(a.from, a.dir, REACH)) this.fire(p, a);
        else this.queue.push({ ...q, waited: (q.waited ?? 0) + 1 });
        break;
      }
      case 'damage': {
        // (no mode asked: the blast was the weapon's, fired as the rules allowed)
        try { applyEdit(cmd.op); this.keeper.last(cmd.op); } catch { /* (no world to edit) */ }
        taken?.(this.tick + 1);
        break;
      }
    }
  }

  // a shot of the player's as this sim has them (never the page's word for where they are), or null: none. On foot:
  // the weapon in slot, from the eyes along h and pitch. In a seat with a mount: its weapon, from the mount on the
  // vehicle towards the page's aim point (the page saw the vehicle a ping back: a direction alone would be off by that
  // much), kept within the mount's swing
  private aim(player: PlayerId, cmd: { slot: number; h: number; pitch: number; to?: Vec3 }) {
    const P = this.players.get(player), s = this.seat(player);
    if (!P || !s || !Number.isFinite(cmd.h) || !Number.isFinite(cmd.pitch) || this.lives.down.has(player)) return null;
    if (s.role === 'walker') {
      const w = weaponIn(cmd.slot), f = P.walk?.pose;
      return w && f ? { w, own: s.entity, from: { x: f.x, y: f.y + EYE, z: f.z }, dir: aimDir(cmd.h, Math.max(-1.5, Math.min(1.5, cmd.pitch))) } : null;
    }
    const c = s.entity.kind === 'craft' ? this.crafts.get(s.entity.id) : undefined, m = c && mountOf(SEATS.craft[c.type], s);
    const w = m && weaponById(m.weapon);
    if (!c || !m || !w) return null;
    const from = mountPoint(m, c.core.pose), t = cmd.to;
    let { h, pitch } = cmd;
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z) && Math.hypot(t.x - from.x, t.z - from.z) > 1) {
      h = Math.atan2(t.x - from.x, t.z - from.z);
      pitch = Math.atan2(t.y - from.y, Math.hypot(t.x - from.x, t.z - from.z));
    }
    const k = inArc(m, c.core.pose.h, h, pitch);
    return { w, own: s.entity, from, dir: aimDir(k.h, k.pitch) };
  }

  // a shot aimed (aim), if its weapon is ready
  private fire(player: PlayerId, a: { w: Weapon; own: EntityRef; from: Vec3; dir: Vec3 }) {
    const P = this.players.get(player) as PlayerState;
    if ((P.trigger ??= new Trigger()).pull(a.w, this.clock)) this.shoot(player, a.own, a.w, a.from, a.dir);
  }

  // w fired by `by` (a player, or an NPC: the same shot), from its body own's eyes along unit dir; what it hits harmed.
  // (a shot's points to the cm: their digits were most of its bytes, ten a second a gun)
  private shoot(by: PlayerId, own: EntityRef, w: Weapon, from: Vec3, dir: Vec3) {
    const shot = w.fire(this.shotWorld(own), from, dir);
    if (!('fly' in shot)) {
      this.due.push({ kind: 'shot', weapon: w.id, player: by, at: to(shot.at, 100), to: to(shot.to, 100), hit: shot.hit });
      const life = shot.hit && shot.hit !== 'world' ? this.lifeOf(shot.hit) : null;
      if (life) this.hurt(life, w.damage.kind, w.damage.points);
      return;
    }
    this.flying.push({ player: by, weapon: w.id, damage: w.damage, own, p: shot, t: 0 });
    this.due.push({ kind: 'launch', weapon: w.id, player: by, at: { ...shot.at }, v: { ...shot.v } });
  }

  // the projectiles' flight through this tick; one that bursts: its blast, and its crater for the host to apply
  private fly() {
    if (!this.flying.length) return;
    this.flying = this.flying.filter((f) => {
      const at = f.p.fly(this.shotWorld(f.own), f.t, f.t += STEP);
      if (!at) return true;
      this.due.push({ kind: 'blast', weapon: f.weapon, player: f.player, at: { ...at }, r: f.p.r });
      this.blast(at, f.damage);
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
    for (const n of this.npcs.all.values()) at.push(n.pose);
    V.hold(at, REACH);
  }

  // whether player may ask for a seat of entity with role from where they are (true), else why not: on foot (their
  // avatar), a vehicle only within Tuning.walk.board of where the host has the walker, not where the page says (a seat
  // the mode gives, a craft made, is the mode's to place), and a car only while it goes no faster than
  // Tuning.walk.boardSpeed; a passenger's only from foot or from another seat of the same vehicle (a player alone
  // goes from the wheel to its gun), not from the map
  private mayBoard(player: PlayerId, entity: EntityRef, role?: Role): boolean | Refusal {
    const held = this.seat(player), W = this.players.get(player)?.walk;
    if (role === 'passenger' && held && held.entity.kind === entity.kind && held.entity.id === entity.id) return true;
    if (role === 'passenger' && (held?.entity.kind !== 'avatar' || !W)) return false;
    if (held?.entity.kind !== 'avatar' || !W || (role ?? this.entities.seat(entity)?.role) === 'walker' || !this.entities.exists(entity)) return true;
    const box = this.boxOf(entity);
    if (!box || !reaches(W.pose, box, this.tuning.walk.board)) return 'far';
    const car = entity.kind === 'car' ? this.carById(entity.id) : null;
    return car && Math.abs(car.v) > this.tuning.walk.boardSpeed ? 'moving' : true;
  }

  private carById(id: number) { return this.traffic.cars.find((c) => c.id === id) ?? this.traffic.detachedCars.find((c) => c.id === id); }

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
      *bodies(near?: MapBox): Generator<Body> {
        const at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 }, pt = { x: 0, y: 0, z: 0 };
        const mine = (kind: EntityRef['kind'], id: number) => own.kind === kind && own.id === id;
        const out = (x: number, z: number) => !!near && (x < near[0] || z < near[1] || x > near[2] || z > near[3]);
        for (const list of [T.cars, T.detachedCars]) for (const c of list) {
          if (mine('car', c.id)) continue;
          const d = c.detachedPose;
          // (where it is on the map first: its height reads the ground's voxels)
          if (d) Object.assign(at, d); else T.carPose(c, c.s, c.off, at, true);
          if (out(at.x, at.z)) continue;
          if (!d) T.carPose(c, c.s, c.off, at);
          const s = carShape(c);
          yield { entity: { kind: 'car', id: c.id }, x: at.x, y: at.y, z: at.z, h: at.h, r: s.hx, l: s.hz, ht: s.top };
        }
        for (const list of [T.people, T.riders]) for (const p of list) {
          if (mine('person', p.id)) continue;
          if (out(T.personPoint(p, 0, pt, true).x, pt.y)) continue;
          const q = T.personPoint(p, 0, pt);
          // (personPoint: x, z on the map as x, y; the height as z)
          yield { entity: { kind: 'person', id: p.id }, x: q.x, y: q.z, z: q.y, h: 0, r: 0.3, l: p.bike ? 0.9 : 0.3, ht: 1.8 };
        }
        for (const [id, by] of sim.avatars) {
          const w = sim.players.get(by)?.walk?.pose;
          if (w && !mine('avatar', id)) yield { entity: { kind: 'avatar', id }, x: w.x, y: w.y, z: w.z, h: w.h, r: 0.3, l: 0.3, ht: 1.8 };
        }
        // (a dead NPC is no body: shots and blasts pass over it)
        for (const [id, n] of sim.npcs.all) {
          const w = n.pose;
          if (n.dead === null && !mine('avatar', id) && !out(w.x, w.z)) yield { entity: { kind: 'avatar', id }, x: w.x, y: w.y, z: w.z, h: w.h, r: 0.3, l: 0.3, ht: 1.8 };
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
    if (seat.role === 'passenger') this.held();
    this.stands?.seated(seat.entity, seat.role);
    this.due.push({ kind: 'seated', player, seat });
  }

  // out of the seat held: the avatar gone (orbit mode has no body); the car parked where it is (the road physics); the
  // craft goes on with hands off (its core's neutral input); a passenger's leaves the vehicle as it was (its
  // passengers stay when its driver or pilot gets out: it comes to rest under them)
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
    else if (s.role === 'passenger') this.held();
    else if (s.role === 'pilot') {
      const c = this.craft(s.entity.id);
      if (!c) return;
      c.pilot = null;
      c.input = c.core.neutral;
    }
  }

  // a seat of entity (role, index: without, its first) taken, the one held left first; true: held now (also when it
  // was already); false: gone, no such seat, another's, not allowed (the mode's mayEnter, also when the mode seats the
  // player itself: ModeWorld.sit), or the role's own refusal (a car: no road physics, a Refusal while it loads or after
  // its load failed, the load started here with the terrain warmed round the car).
  // The walker's from pose (an avatar's: where the mode's walk puts it down), the
  // driver's as type choice (the car taken shows in driverSnapshot; the terrain round it warmed)
  private enterSeat(player: PlayerId, cmd: { entity: EntityRef; role?: Role; index?: number; choice?: VehicleId; pose?: WalkPose }): boolean | Refusal {
    const seat = cmd.role === 'passenger' && cmd.index === undefined ? this.freePassengerSeat(player, cmd.entity) : this.entities.seat(cmd.entity, cmd.role, cmd.index);
    if (!seat) return false;
    const by = this.occupants.get(seatKey(seat));
    if (by === player) return true;
    if (by !== undefined) return 'taken';
    if (this.lives.down.has(player)) return false;
    if ((seat.role === 'driver' || seat.role === 'pilot') && this.wrecks.has(lifeKey(seat.entity as Life))) return false;
    if (this.mode?.mayEnter && !this.mode.mayEnter(this.face, player, seat)) return false;
    const id = seat.entity.id;
    if (seat.role === 'walker') {
      if (!cmd.pose) return false;
      const start = { ...cmd.pose }, t = this.clock - STEP;
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

  // a passenger's seat of entity: the one player holds, else the first free (all taken: the last, so 'taken'), or null:
  // it has none
  private freePassengerSeat(player: PlayerId, entity: EntityRef): Seat | null {
    let last: Seat | null = null;
    for (const q of this.entities.seats(entity)) {
      if (q.role !== 'passenger') continue;
      last = { entity: { kind: entity.kind, id: entity.id }, role: q.role, index: q.index };
      const by = this.occupants.get(seatKey(last));
      if (by === undefined || by === player) return last;
    }
    return last;
  }

  // where the walk puts the avatar, bounded (Tuning.walk) against the last pose taken in an earlier tick;
  // false: it was out of reach, and was taken clamped (ignored while walking as none)
  private walkPose(player: PlayerId, asked: WalkPose) {
    const W = this.players.get(player)?.walk;
    if (!W) return true;
    if (W.at !== this.clock) { W.from = W.pose; W.fromAt = W.at; W.fromOn = W.on; }
    const near = this.walkSolids(asked.x, asked.z), { roof: spot, ...pose } = asked;
    // (on a roof: its page saw the thing a round trip late; the spot put on it as it is now, so others see the walker
    // where its page has it on the roof, not that far back along it)
    const r = spot && typeof spot.id === 'string' ? near.find((q) => q.id === spot.id) : undefined, at = r && onRoof(r, spot!);
    if (at && this.clear(at.x, at.z, at.y)) Object.assign(pose, at);
    // (on a car's roof: bounded from where the car has carried the last pose since, so a ride is not taken for a run)
    const a = W.fromOn, b = a && near.find((q) => q.id === a.id);
    const to = a && b ? carried(a, b, W.from) : null, gone = to && this.clear(to.x, to.z, W.from.y + to.dy) ? to : null;
    const from = gone ? { ...W.from, x: gone.x, z: gone.z, y: W.from.y + gone.dy } : W.from;
    const bound = boundWalk(from, pose, this.clock - W.fromAt, this.tuning.walk), S = W.sent, dt = this.clock - S.at;
    // Kept out of the solid things as the host has them (a page walking through a parked car is seen beside it, shoots
    // and boards from there); not told: a fair page is only ever in one by the tick or two it sees a moving car late,
    // and its own walk pushes it out in its next frame. A roof within a step is stood on, or being climbed
    const roof = roofUnder(near, bound.x, bound.z, bound.y + WALKER_STEP), P = { x: bound.x, z: bound.z };
    const taken = pushOut(near, P, roof ? Math.max(bound.y, roof.y + roof.top) : bound.y, () => true) ? { ...bound, x: P.x, z: P.z } : bound;
    // (a moving car is a tick or two ahead of where the page saw it: met further out)
    const on = roofUnder(near, taken.x, taken.z, taken.y + 0.5, 4);
    W.on = on && on.y + on.top > taken.y - 0.5 ? on : null;
    W.pose = { ...taken };
    W.at = this.clock;
    if (dt > 0) { W.vx = (taken.x - S.x) / dt; W.vz = (taken.z - S.z) / dt; W.sent = { x: taken.x, z: taken.z, at: this.clock }; }
    else { S.x = taken.x; S.z = taken.z; }
    return bound === pose;
  }

  // a walker on a roof taken along by the thing's step this tick (its pose was put on the thing as it was before it):
  // else the snapshot, which has the thing after its step, shows it a tick back along the roof
  private carryOn(W: Walk) {
    const a = W.on!, b = a.id === undefined ? undefined : this.walkSolids(W.pose.x, W.pose.z).find((q) => q.id === a.id);
    const at = b && onRoof(b, roofSpot(a as Solid & { id: string }, W.pose, W.pose.y));
    if (!at) return;
    // (a wall where the roof takes it: left standing there, as its page is, till its next pose)
    if (!this.clear(at.x, at.z, at.y)) { W.on = null; return; }
    W.pose = { ...W.pose, ...at, h: W.pose.h + Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)) };
    W.on = b;
  }

  // a tick of the walk's velocity, stopped at a wall or slid along it as its page's walk is (sim/walk.ts walkStep):
  // else the others see a walker running at one inside or beyond it, shoot it and board from there, till its next pose
  private guess(W: Walk) {
    const p = W.pose, dx = W.vx * STEP, dz = W.vz * STEP;
    for (const [sx, sz] of [[dx, dz], [dx, 0], [0, dz]]) {
      if ((!sx && !sz) || (this.walls && !bodyClear(this.walls, p.x + sx, p.z + sz, p.y))) continue;
      W.pose = { ...p, x: p.x + sx, z: p.z + sz };
      return;
    }
  }

  private clear(x: number, z: number, feet: number) { return !this.walls || headroom(this.walls, x, z, feet); }

  // the solid things a walker at x, z may be in or on, as the host has them now: the cars, the crafts with a shape, the
  // river's vessels, the coaches (not the other walkers)
  private walkSolids(x: number, z: number): Solid[] {
    const T = this.traffic, out: Solid[] = [], near = (px: number, pz: number, R: number) => Math.abs(px - x) < R && Math.abs(pz - z) < R;
    for (const list of [T.cars, T.detachedCars]) for (const c of list) {
      const d = c.detachedPose;
      if (near(d?.x ?? c.geo.cx, d?.z ?? c.geo.cy, CAR_REACH)) out.push(solidAt(carShape(c), d ?? T.carPose(c, c.s, c.off, this.carAt), `car${c.id}`));
    }
    for (const c of this.crafts.values()) {
      const q = c.core.pose;
      if (c.placed && near(q.x, q.z, CRAFT_REACH)) craftSolids(c.type, q, out, `craft${c.id}`);
    }
    for (const b of T.boats?.poses ?? []) if (near(b.x, b.z, b.len / 2 + 6)) out.push(solidAt(vesselShape(b), { x: b.x, y: b.y, z: b.z, h: b.heading }, `${b.kind}${b.id}`));
    for (const k of T.trains.coaches()) if (near(k.x, k.z, COACH_REACH)) out.push(solidAt(COACH_SHAPE, { x: k.x, y: k.y, z: k.z, h: k.heading }, `coach${k.id}`));
    return out;
  }

  // the player on foot (a mode's walk): their avatar put down at pose (one held: there again, nothing drawn between);
  // else a new one, the player its walker (the seat held left first); false: not seated (the mode's mayEnter)
  private walk(player: PlayerId, asked: WalkPose) {
    const s = this.seat(player), W = this.players.get(player)?.walk;
    if (!finitePose(asked)) return false;
    const pose = this.inHeight(asked);
    if (s?.entity.kind === 'avatar' && W) {
      const at = { ...pose }, t = this.clock - STEP;
      Object.assign(W, { pose: at, at: t, from: at, fromAt: t, prev: at, vx: 0, vz: 0, sent: { x: at.x, z: at.z, at: t }, fall: undefined });
      return true;
    }
    const id = this.nextAvatar++, avatars = this.avatars as Map<number, PlayerId>;
    avatars.set(id, player);
    if (this.enterSeat(player, { entity: { kind: 'avatar', id }, role: 'walker', pose }) === true) return true;
    avatars.delete(id);
    return false;
  }

  // pose's height kept within the world's: not under the ground of its column (a walk's start is the page's word, and
  // the walk's bound goes on from it), nor over the crafts' ceiling (getting out of one anywhere it flies)
  private inHeight(pose: WalkPose): WalkPose {
    const meta = this.opts.crafts?.meta, under = this.ground?.support(pose.x, pose.z, pose.y);
    const y = Math.min(meta ? meta.H + CEILING : Infinity, Math.max(under ?? -Infinity, pose.y));
    return y === pose.y ? pose : { ...pose, y };
  }

  private player(id: PlayerId) {
    const M = this.players as Map<PlayerId, PlayerState>;
    let P = M.get(id);
    if (!P) M.set(id, P = {});
    return P;
  }

  // Where the players are (map metres), for the edits kept (sim/edit-keeper.ts) and the vehicles left: each player's
  // view's focus, seat entity (the avatar walked, the car driven, the craft piloted) and entity followed
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

  // the traffic's held ids, from the players (a car ridden along in is held as one followed)
  private held() {
    const { held } = this.traffic;
    held.car.clear(); held.person.clear();
    for (const P of this.players.values()) {
      if (P.follow?.kind === 'car' || P.follow?.kind === 'person') held[P.follow.kind].add(P.follow.id);
      if (P.seat?.role === 'passenger' && P.seat.entity.kind === 'car') held.car.add(P.seat.entity.id);
    }
  }

  // ------------------------------------------------------------------ health (sim/health.ts)
  // One model for every life: damage of a kind times the type's factor; a vehicle passes its share on to those in it.
  // The host alone decides it, from what it has itself (a shot's ray, a blast, the road physics' contacts, a craft's
  // velocity, a walker's poses): a page's word on its own harm would be a cheat's.

  /** whether player is down (their health at 0, not yet back) */
  isDown(player: PlayerId) { return this.lives.down.has(player); }

  /** whether a car or craft is a wreck (its health at 0: its driver's or pilot's input no more taken) */
  wrecked(e: EntityRef) { return this.wrecks.has(lifeKey(e as Life)); }

  // the life an entity is (an avatar: its walker), or null: none (a person of the crowd)
  private lifeOf(e: EntityRef): Life | null {
    if (e.kind === 'avatar') {
      const p = this.avatars.get(e.id);
      return p !== undefined ? { kind: 'player', id: p } : this.npcs.all.has(e.id) ? { kind: 'npc', id: e.id } : null;
    }
    return e.kind === 'person' ? null : { kind: e.kind, id: e.id };
  }

  // life's type's toughness (Tuning.health), or null: not in the world
  private toughness(life: Life): Toughness | null {
    const H = this.tuning.health;
    if (life.kind === 'player') return this.players.has(life.id) ? H.player : null;
    if (life.kind === 'npc') return this.npcs.all.get(life.id)?.dead === null ? H.npc : null;
    if (life.kind === 'car') { const c = this.carById(life.id); return c ? H.car[vehicleOf(c).id] : null; }
    const c = this.crafts.get(life.id);
    return c ? H.craft[c.type] : null;
  }

  // points of a kind off life; at 0 a vehicle is wrecked, a player down (one down takes no more)
  private hurt(life: Life, kind: DamageKind, points: number) {
    if (life.kind === 'player' && this.lives.down.has(life.id)) return;
    const t = this.toughness(life), d = t ? points * t.take[kind] : 0;
    if (!t || !(d > 0)) return;
    const { was, hp } = this.lives.take(life, t.max, d);
    if (life.kind !== 'player' && t.through > 0) {
      for (const [p, P] of this.players) {
        const e = P.seat?.entity;
        if (e?.kind === life.kind && e.id === life.id) this.hurt({ kind: 'player', id: p }, kind, d * t.through);
      }
    }
    if (was > 0 && hp === 0) {
      if (life.kind === 'player') this.goDown(life.id);
      else if (life.kind === 'npc') this.npcs.kill(life.id);
      else this.wreck(life);
    }
  }

  // a crash or a fall at speed (m/s) into life: harmless up to its type's safe speed
  private crash(life: Life, kind: DamageKind, speed: number) {
    const t = this.toughness(life);
    if (t && speed > t.safe) this.hurt(life, kind, (speed - t.safe) * this.tuning.health.perMs);
  }

  // a blast at `at`: every body within its reach hurt, less the further its box is from it
  private blast(at: { x: number; y: number; z: number }, damage: Weapon['damage']) {
    const R = damage.reach ?? 0, m = R + BODY_FAR;
    if (!(R > 0)) return;
    for (const b of this.shotWorld({ kind: 'person', id: -1 }).bodies([at.x - m, at.z - m, at.x + m, at.z + m])) {
      const life = this.lifeOf(b.entity);
      if (!life) continue;
      const s = Math.sin(b.h), c = Math.cos(b.h), px = at.x - b.x, pz = at.z - b.z;
      const du = Math.max(0, Math.abs(px * s + pz * c) - b.l), dv = Math.max(0, Math.abs(px * c - pz * s) - b.r);
      const d = Math.hypot(du, dv, Math.max(0, b.y - at.y, at.y - b.y - b.ht));
      if (d < R) this.hurt(life, damage.kind, damage.points * (1 - d / R));
    }
  }

  // a vehicle at 0 a wreck, unless the mode keeps it going: its controls let go, nobody takes them again; a car of
  // the traffic put out of it where it is, charred. Those in it stay: only what reaches them harms them
  private wreck(v: Life & { kind: 'car' | 'craft' }) {
    if (this.mode?.wrecks && !this.mode.wrecks(this.face, v)) return;
    this.wrecks.add(lifeKey(v));
    if (v.kind === 'craft') { const c = this.craft(v.id); if (c) c.input = c.core.neutral; return; }
    const c = this.carById(v.id), T = this.traffic;
    if (!c) return;
    c.col = WRECK_COL;
    for (const [p, P] of this.players) if (P.seat?.role === 'driver' && P.seat.entity.id === v.id) this.phys?.input(p, PARK);
    if (c.detachedPose || this.phys?.wreckCar(c, T)) return;
    const at = T.carPose(c, c.s, c.off, { x: 0, y: 0, z: 0, h: 0, pitch: 0 });
    if (T.detachCar(c, { x: at.x, y: at.y, z: at.z, h: at.h, pitch: at.pitch, roll: 0 })) { c.v = 0; c.brake = 1; }
  }

  // a player down: their controls let go (as a connection lost), back after the mode's time
  private goDown(player: PlayerId) {
    const ms = this.mode?.downFor ? this.mode.downFor(this.face, player) : this.tuning.health.downMs;
    this.lives.down.set(player, ms === null ? Infinity : this.clock + ms / 1000);
    this.apply({ player, cmd: { kind: 'handsOff' } });
  }

  // a player down back at full health, on foot where they last stood (or the mode says); out of a seat held first
  private comeBack(player: PlayerId) {
    this.lives.down.delete(player);
    this.lives.heal(lifeKey({ kind: 'player', id: player }));
    const P = this.players.get(player), s = this.seat(player), e = s && this.entities.pose(s.entity);
    let at: WalkPose | null = this.safe.get(player) ?? P?.walk?.pose ?? (e ? { ...e, moving: false } : null);
    if (!at) return;
    if (this.mode?.backAt) at = this.mode.backAt(this.face, player, at);
    at = { x: at.x, y: at.y, z: at.z, h: at.h, moving: false };
    if (s && s.role !== 'walker') this.leaveSeat(player);
    if (this.walk(player, at)) this.due.push({ kind: 'back', player, to: { ...this.players.get(player)!.walk!.pose } });
  }

  // the tick's harm the host finds itself (the drivers' contacts, the walkers' falls), the players due back, the
  // lives of what left the world forgotten
  private harm() {
    for (const [p, P] of this.players) {
      const s = P.seat;
      if (s?.role === 'driver' && this.phys) { const v = this.phys.driverHit(p); if (v) this.crash({ kind: 'car', id: s.entity.id }, 'crash', v); }
      if (s?.role === 'walker' && P.walk) this.fall(p, P.walk);
    }
    for (const [p, at] of this.lives.down) if (at <= this.clock + 1e-9) this.comeBack(p);
    if (this.tick % FORGET_TICKS) return;
    for (const { life } of [...this.lives.values()]) {
      const gone = life.kind === 'player' ? !this.players.has(life.id) : life.kind === 'npc' ? !this.npcs.all.has(life.id) : !this.entities.exists(life);
      if (gone) { this.lives.heal(lifeKey(life)); this.wrecks.delete(lifeKey(life)); }
    }
    for (const k of this.wrecks) if (this.lives.hp(k) === undefined) this.wrecks.delete(k);
  }

  // A fall on foot, from the walk's poses (the walk is the page's: its own landing is never its word on harm): a
  // descent ends once the walker has gone no lower for FALL_QUIET ticks (a page's poses come unevenly), and hurts by
  // the speed of a drop from its height if it went faster than a walk down steps can. None into the water, or riding
  // a roof. Standing on the ground, the walker's pose is the place they come back to
  private fall(player: PlayerId, W: Walk) {
    const F = W.fall, y = W.pose.y;
    if (W.pose.swim || W.on) W.fall = undefined;
    else if (y < W.prev.y - 0.01) {
      if (F) { F.ticks += F.quiet + 1; F.quiet = 0; } else W.fall = { top: W.prev.y, ticks: 1, quiet: 0 };
    } else if (F && ++F.quiet >= FALL_QUIET) {
      W.fall = undefined;
      const h = F.top - y;
      if (h / (F.ticks * STEP) > FALL_PACE) this.crash({ kind: 'player', id: player }, 'fall', Math.sqrt(2 * GRAVITY * h));
    }
    const p = W.pose, under = this.ground?.support(p.x, p.z, p.y + 0.5);
    if (!W.fall && !p.swim && !W.on && !this.lives.down.has(player) && (under === undefined || Math.abs(p.y - under) < 0.5)) this.safe.set(player, p);
  }

  // ------------------------------------------------------------------ the NPCs' minds (sim/npc-mind.ts)
  // Each NPC with a duty thinks once a tick, before the walk steps it: what it sees is the host's (the players on foot
  // as this sim has them, the voxels between), what it fires is a player's MG fired as theirs is.

  private minds() {
    const MG = weaponById('mg'), N = this.npcs, V = this.voxels;
    // (the players it may attack: on foot, not down)
    const prey: { player: PlayerId; at: WalkPose }[] = [];
    for (const [p, P] of this.players) if (P.walk && P.seat?.role === 'walker' && !this.lives.down.has(p)) prey.push({ player: p, at: P.walk.pose });
    for (const n of N.all.values()) {
      const m = n.mind;
      if (!m || n.dead !== null) continue;
      const me = n.pose, eyes = { x: me.x, y: me.y + EYE, z: me.z };
      // (a clear line from its eyes to their chest within RANGE: the weapons' voxel ray)
      const clear = (at: WalkPose) => {
        const d = { x: at.x - eyes.x, y: at.y + CHEST - eyes.y, z: at.z - eyes.z }, L = Math.hypot(d.x, d.y, d.z);
        if (L > RANGE) return false;
        if (!V || L < 1e-6) return true;
        d.x /= L; d.y /= L; d.z /= L;
        // (voxels not yet loaded are no clear line: a ray through them meets nothing)
        return (!V.ready || V.ready(eyes, d, L)) && V.raycast(eyes, d, L) >= L - 0.3;
      };
      const where = (at: WalkPose) => ({ x: at.x, y: at.y, z: at.z });
      const senses: Senses = {
        nearest: () => {
          let best: { player: PlayerId; at: Vec3 } | null = null, bd = Infinity;
          for (const q of prey) {
            const d = Math.hypot(q.at.x - me.x, q.at.z - me.z);
            if (d < bd && clear(q.at)) { bd = d; best = { player: q.player, at: where(q.at) }; }
          }
          return best;
        },
        sees: (player) => { const q = prey.find((r) => r.player === player); return q && clear(q.at) ? where(q.at) : null; },
      };
      const act = think(m, { x: me.x, y: me.y, z: me.z, walking: n.goal !== null }, senses, this.clock, MG?.rate ?? 10);
      n.speed = act.speed;
      n.face = act.face ?? null;
      const g = act.goal;
      if (g === null && n.goal) N.goTo(n.id, null);
      else if (g && (!n.goal || Math.hypot(g.x - n.goal.x, g.z - n.goal.z) > REGOAL)) N.goTo(n.id, g);
      if (act.fire && MG && n.trigger.pull(MG, this.clock)) this.shoot(`npc${n.id}`, { kind: 'avatar', id: n.id }, MG, eyes, aimFrom(eyes, act.fire, this.rnd));
    }
  }

  // the NPCs' aim's stray: seeded, so a run repeats (mulberry32)
  private seed = 0;
  private readonly rnd = () => {
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // The driver's car: the road physics' (loadPhysics)
  /** the player's car now, or null while they drive none (what its driver is to be told: the car's drive events) */
  driverSnapshot(player: PlayerId): DriverSnapshot | null { return this.phys?.driverSnapshot(player) ?? null; }

  // ------------------------------------------------------------------ the player crafts (sim/craft/craft-core.ts)
  // A craft is an entity with its pilot's seat and, the hovercraft and the helicopter, passengers' (ADR 0008: per
  // seat; a gunner's would be another). It is made (addCraft), put down (placeCraft: stepped from then on, whether or
  // not anyone pilots it: an empty seat is its core's neutral input) and taken away (removeCraft; or, left empty, by the presence rule: dropLeft). Left, it stays where
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

  /** craft id taken out of the world (its pilot leaves it first; its passengers are put on foot beside where it was,
   * on the ground under it) */
  removeCraft(id: CraftId) {
    const c = this.craft(id);
    if (!c) return;
    if (c.pilot !== null) this.leaveSeat(c.pilot);
    const box = c.placed ? craftBox(c.type, c.core.pose) : null;
    let n = 0;
    for (const [p, P] of this.players) {
      if (P.seat?.role !== 'passenger' || P.seat.entity.kind !== 'craft' || P.seat.entity.id !== id) continue;
      this.leaveSeat(p);
      // (to either side in turn, a step apart along it)
      const side = n % 2 ? -1 : 1, along = (Math.floor(n++ / 2) % 4) - 1.5;
      if (!box) continue;
      // (a craft in the air: down on what is under it, where its tiles are in)
      const out = outBeside(box, side, along, this.tuning.walk.board / 2), under = c.collision.surface(out.x, out.z);
      this.walk(p, under ? { ...out, y: under.top } : out);
    }
    c.collision.release();
    (this.crafts as Map<CraftId, CraftState>).delete(id);
  }

  /** the craft the player pilots, or null */
  craftOf(player: PlayerId): Craft | null {
    const s = this.seat(player);
    return s?.role === 'pilot' ? this.crafts.get(s.entity.id) ?? null : null;
  }

  private craft(id: CraftId) { return (this.crafts as Map<CraftId, CraftState>).get(id); }

  // what the stands act through: their crafts made asleep, their cars parked, both let go as any left vehicle
  private makeStands(env: CraftWorld) {
    const T = this.traffic, key = (v: EntityRef) => lifeKey(v as Life);
    return new Stands({
      meta: env.meta, cache: env.cache, now: env.now, tuning: this.tuning, roads: T.net.roads,
      stockCraft: (type, spot) => {
        const c = this.addCraft(type) as unknown as CraftState;
        this.placeCraft(c.id, spot);
        c.asleep = true;
        c.collision.release();
        return c.id;
      },
      stockCar: (type, col, spot) => T.parkAgain({ len: VEHICLES[type].len, bus: false, vt: type, col }, { ...spot, pitch: 0, roll: 0 }, this.nextStandCar++)?.id ?? null,
      pose: (v) => this.entities.pose(v),
      harmed: (v) => this.lives.hp(key(v)) !== undefined || this.wrecks.has(key(v)),
      remove: (v) => {
        if (v.kind === 'craft') this.removeCraft(v.id);
        else { const c = this.carById(v.id); if (c) T.dropParked(c); }
      },
      wake: (v) => { const c = this.craft(v.id); if (c) c.asleep = false; },
      place: (id, spot) => this.placeCraft(id, spot),
      clear: (x, z, r) => {
        const near = (p: { x: number; z: number }, R: number) => (p.x - x) ** 2 + (p.z - z) ** 2 < (r + R) ** 2;
        for (const c of this.crafts.values()) if (c.placed && near(c.core.pose, CRAFT_REACH)) return false;
        for (const c of T.detachedCars) if (near(c.detachedPose!, CAR_REACH / 2)) return false;
        for (const P of this.players.values()) if (P.walk && near(P.walk.pose, 1)) return false;
        return true;
      },
    });
  }

  // The solid things (sim/solids.ts, ADR 0010) a craft meets in this tick: those whose boxes may come within its own
  // as they stand at the tick's start: the cars (out of the traffic where they are, else on their paths), the other
  // crafts with a shape (the light ones only to a light one: sim/solids.ts lightSolids), the river's vessels, the train
  // coaches. Not the walkers: their walk is their page's, and a craft shoves them as a car does.
  private solidsNear(own: Craft, shapes: readonly Shape[]): Solid[] {
    const T = this.traffic, p = own.core.pose, v = own.core.velocity, out: Solid[] = [];
    let r = 0;
    for (const s of shapes) r = Math.max(r, Math.hypot(s.hx, s.hz) + Math.abs(s.fwd ?? 0));
    r += Math.hypot(v.x, v.z) * STEP + 1;
    const near = (x: number, z: number, R: number) => Math.abs(x - p.x) < r + R && Math.abs(z - p.z) < r + R;
    for (const list of [T.cars, T.detachedCars]) for (const c of list) {
      const d = c.detachedPose;
      if (near(d?.x ?? c.geo.cx, d?.z ?? c.geo.cy, CAR_REACH)) out.push(solidAt(carShape(c), d ?? T.carPose(c, c.s, c.off, this.carAt)));
    }
    for (const c of this.crafts.values()) {
      const q = c.core.pose;
      if (c !== own && c.placed && near(q.x, q.z, CRAFT_REACH)) lightSolids(own.type, c.type, q, craftSolids(c.type, q, out));
    }
    for (const b of T.boats?.poses ?? []) if (near(b.x, b.z, b.len / 2 + 6)) out.push(vesselAt(b));
    for (const k of T.trains.coaches()) if (near(k.x, k.z, COACH_REACH)) out.push(solidAt(COACH_SHAPE, { x: k.x, y: k.y, z: k.z, h: k.heading }));
    return out;
  }

  // the crafts with a shape where they are now, as walls to the road physics' cars (ADR 0012): a driven car stops at a
  // parked hovercraft as at a train's coach; the craft does not feel it (its own step pushes it out of the cars)
  private *craftWalls(): Generator<WallBox> {
    for (const c of this.crafts.values()) {
      if (!c.placed) continue;
      let k = 0;
      for (const s of craftSolids(c.type, c.core.pose)) {
        yield { id: `craft:${c.id}${k++ ? `:${k}` : ''}`, x: s.x, y: s.y, z: s.z, heading: s.h, size: { x: 2 * s.hx, y: s.top, z: 2 * s.hz } };
      }
    }
  }

  // whether a craft with a shape is in the way of vessel p: in its box, out by the beside m to either side and before m
  // ahead of its bow
  private inTheWay(p: BoatPose, before: number) {
    const s = vesselShape(p), zone = solidAt({ ...s, hx: s.hx + BESIDE, hz: s.hz + before / 2, fwd: before / 2 }, { x: p.x, y: p.y, z: p.z, h: p.heading });
    for (const c of this.crafts.values()) {
      if (c.placed && craftSolids(c.type, c.core.pose).some((s) => overlap(zone, s) > 0)) return true;
    }
    return false;
  }

  // each craft put down: drawn from where it is now (keep), its collision's tiles fetched round it and ahead, then the
  // tick's steps (STEP worth) at its own fixed step with its pilot's input (or the neutral); a step not taken (a tile
  // not in) drops the rest of the tick. Its core's events become the world's (craft), this tick's
  private stepCrafts() {
    for (const c of (this.crafts as Map<CraftId, CraftState>).values()) {
      if (!c.placed || c.asleep) continue;
      const core = c.core;
      core.keep();
      c.collision.prefetch(core.pose, core.velocity);
      const shapes = meetShapes(c.type), near = shapes.length && core.meet ? this.solidsNear(c, shapes) : null;
      const v0 = core.velocity, vx = v0.x, vy = v0.y, vz = v0.z;
      core.clock.run(STEP, (step) => {
        if (!core.step(c.input, step, c.collision)) return false;
        if (near?.length) meetSolids(c.type, core, near, c.collision);
        return true;
      });
      // A crash is the velocity a tick lost or turned, the same rule for every craft; a plane's crash freezes its
      // velocity (its own speed counts) and its putting back moves it at once (no crash)
      const v1 = core.velocity;
      let hit = Math.hypot(v1.x - vx, v1.y - vy, v1.z - vz);
      for (const e of core.events as { type?: string; kmh?: number }[]) {
        if (e?.type === 'crash') hit = Math.max(hit, (e.kmh ?? 0) / 3.6);
        else if (e?.type === 'respawn') hit = 0;
      }
      this.crash({ kind: 'craft', id: c.id }, 'crash', hit);
      // (a core of its type's events: sim/craft/cores.ts asserts the contract's are the cores'; only its pilot reads
      // them, so an empty craft's are not sent)
      if (core.events.length) for (const e of core.events.splice(0)) if (c.pilot !== null) this.due.push({ kind: 'craft', entity: { kind: 'craft', id: c.id }, ...{ craft: c.type, e } as CraftEventOf });
    }
  }
}

const finitePose = (p: WalkPose) => [p.x, p.y, p.z, p.h].every(Number.isFinite);

// a spot on foot out from box's side (+1 its right, -1 its left) by out m, along it by along m from its middle,
// facing as it did
function outBeside(b: Box, side: number, along: number, out: number): WalkPose {
  const c = Math.cos(b.h), s = Math.sin(b.h), a = side * (b.r + out);
  return { x: b.x + a * c + along * s, y: b.y, z: b.z - a * s + along * c, h: b.h, moving: false };
}

// how far a solid thing may be from a craft and still be met in a tick (m, from its pose, past the craft's reach): a
// car's (a bus's half length, the tick its gathered place lags), a craft's (the helicopter's tail and rotor), a coach's
const CAR_REACH = 12, CRAFT_REACH = 8, COACH_REACH = 12;
// the ticks a shot waits at most for the nodes along its aim (a node read off the thread is in within a tick or two)
const FIRE_WAIT = 15;
// a vessel gives way to a craft this far (m) beside its hull too: it slows to a stop before it would scrape past
const BESIDE = 2;
// how far (m) past a blast's reach a body's foot may be and its box still be in reach (a bus's half length)
const BODY_FAR = 7;
// the first id of the stands' cars (the traffic numbers its cars from 0, a few thousand an hour)
const STAND_CARS = 1 << 28;
// a fall: the ticks without going lower that end it, the pace (m/s) a walk down steps never makes; m/s²
const FALL_QUIET = 6, FALL_PACE = 3, GRAVITY = 9.81;
// the ticks between forgetting the lives of what left the world
const FORGET_TICKS = 30;
// m ahead of the player an NPC asked for is put down; the half side of its patrol's square
const NPC_AHEAD = 4, NPC_LOOP = 8;
// m a goal may move before an NPC walking to it finds its way again (a search each time)
const REGOAL = 2;
const to = (v: Vec3, k: number) => ({ x: Math.round(v.x * k) / k, y: Math.round(v.y * k) / k, z: Math.round(v.z * k) / k });
const vesselAt = (b: BoatPose) => solidAt(vesselShape(b), { x: b.x, y: b.y, z: b.z, h: b.heading });

