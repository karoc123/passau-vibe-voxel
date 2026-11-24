// What the page holds of the world sim (docs/plans/local-server.md, ADR 0008: "the page sends commands and draws
// snapshots"): a SimClient. The page never reaches into the WorldSim; it sends its players' commands (SimCommand:
// plain data, so they can cross to a Web Worker or a server), runs the frame (update: the frame's input; in the page's
// thread the sim's update itself) and reads what the sim publishes: the traffic as drawn (TrafficView), the crafts in
// the world (piloted or left), the players' seats, cars and crafts, the outcomes of their commands, the events since a
// tick.
// LocalSimClient: the sim in the page's thread (the one implementation so far). Commands are queued and applied in the
// order sent at the start of the next update, before its ticks (ADR 0007: commands take effect at the start of a
// tick); every craft shell and the nav run before the update in main.ts's frame, so they reach the tick they reached
// when they called the WorldSim at once.
// No three.js, no DOM (tools/core-deps.mjs).
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import type { WorldOp } from '../core/world-edits';
import { liveEdits } from '../core/live-edits';
import type { BoatView } from './boat-traffic';
import type { Traffic, TrafficBodies, Ground } from './traffic';
import type { TrafficData, WalkPose } from './types';
import type { CraftCore } from './craft/craft-core';
import { CORES, type CraftType } from './craft/cores';
import { loadState } from './craft/core-state';
import { DEFAULT_TUNING } from './tuning';
import { TrafficMirror, type Snapshot } from './snapshot';
import type { SimServer } from './sim-server';
import type { CommandResult, PlayerCommand } from './commands';
import type { Role } from './entities';
import { EVENT_TICKS, type CraftId, type PlayerId, type Seat, type SimEvent, type SimInput } from './world-sim';

/** what the page sends: a player's command to the world sim (sim/commands.ts PlayerCommand: applied at the start of
 * the sim's next update, in order), or an edit, a change to the world's voxels (core/world-edits.ts) */
export type SimCommand = PlayerCommand | { kind: 'edit'; player: PlayerId; op: WorldOp; ref?: number };
export type { CommandResult, PlayerCommand };

/** what the presentation reads of the traffic (view/life.ts, nav/): the agents between their last two ticks and the
 * path maths that place them (the static roads and footways), the signals, trains, boats, the bodies' poses. In the
 * page's thread it is the sim's Traffic itself; a client of a worker or a server fills a Traffic of its own from
 * snapshots (docs/plans/local-server.md). Read only, except the drawn fields (rp, rh, pitch, roll) on its agents. */
export type TrafficView = Readonly<Pick<Traffic, 'heads' | 'peds' | 'cars' | 'detachedCars' | 'people' | 'riders' | 'active' |
  'acc' | 'trains' | 'ground' | 'carPose' | 'pathPoint' | 'personPoint' | 'signal' | 'roadVehicles'>> &
  { readonly bodies: Pick<TrafficBodies, 'owns' | 'pose'> | null; readonly boats: BoatView | null };

/** a player craft as the page sees it: its id and type, its pilot, whether it is put down, its core's state (read
 * only: pose, drawn(alpha), the motion or flight its shell shows). Its collision is the sim's; a shell queries the
 * world through its own (nav/). */
export interface CraftView<C extends CraftCore = CraftCore> {
  readonly id: CraftId;
  readonly type: CraftType;
  readonly pilot: PlayerId | null;
  readonly placed: boolean;
  readonly core: C;
}

export interface SimClient {
  /** the world's tick as last seen: the number of ticks run */
  readonly tick: number;
  /** the traffic as drawn */
  readonly traffic: TrafficView;
  /** a player's command, applied at the start of the next update */
  send(cmd: SimCommand): void;
  /** the frame: the commands sent applied, then the ticks due after dt s (SimInput: the hour, the focus, the viewer) */
  update(dt: number, input: SimInput): void;
  /** the sim's events of the ticks after tick, oldest first */
  eventsSince(tick: number): SimEvent[];
  /** the outcomes of the player's commands of kind (and of a seat's role) since the last call for it, oldest first */
  results(player: PlayerId, kind: SimCommand['kind'], role?: Role): CommandResult[];
  /** the seat the player holds, or null */
  seat(player: PlayerId): Seat | null;
  /** where person personId is put by the player walking as them, or null while none does */
  walkedPose(personId: number): WalkPose | null;
  /** the player's car, or null while they drive none */
  driver(player: PlayerId): DriverSnapshot | null;
  /** what the driver is to be told since the last call */
  driverNotes(player: PlayerId): DriveNote[];
  /** the craft the player pilots, or null */
  craftOf(player: PlayerId): CraftView | null;
  /** the crafts put down in the world, piloted or left (any player may enter one left: enterSeat) */
  crafts(): readonly CraftView[];
  /** what happened to the player's craft since the last call, oldest first */
  craftEvents(player: PlayerId): unknown[];
  /** the road physics loaded where the sim runs (warm: where the terrain is wanted soon); rejects if it cannot */
  loadPhysics(warm?: { x: number; z: number }): Promise<void>;
  /** an edit command whose answer is the level-1 nodes it changed, once applied */
  edit(player: PlayerId, op: WorldOp): Promise<[number, number][]>;
}

/** the sim in the page's thread, read where it is (the page draws the sim's own objects): a SimServer over the
 * WorldSim made by the page (sim-host.ts) */
export class LocalSimClient implements SimClient {
  private nextRef = 1;
  private readonly pending = new Map<number, { done: (n: [number, number][]) => void; fail: (e: unknown) => void }>();

  constructor(private readonly server: SimServer) {
    server.onEdit = (ref, nodes, error) => {
      const p = this.pending.get(ref);
      this.pending.delete(ref);
      if (nodes) p?.done(nodes); else p?.fail(error);
    };
  }

  private get sim() { return this.server.sim; }
  get tick() { return this.sim.tick; }
  get traffic(): TrafficView { return this.sim.traffic; }

  send(cmd: SimCommand) { this.server.send(cmd); }

  edit(player: PlayerId, op: WorldOp) {
    const ref = this.nextRef++;
    return new Promise<[number, number][]>((done, fail) => {
      this.pending.set(ref, { done, fail });
      this.server.send({ kind: 'edit', player, op, ref });
    });
  }

  update(dt: number, input: SimInput) { this.server.update(dt, input); }

  eventsSince(tick: number) { return this.sim.eventsSince(tick); }
  results(player: PlayerId, kind: SimCommand['kind'], role?: Role) { return this.server.results(player, kind, role); }
  seat(player: PlayerId) { return this.sim.seat(player); }
  walkedPose(personId: number) { return this.sim.walkedPose(personId); }
  driver(player: PlayerId) { return this.sim.driverSnapshot(player); }
  driverNotes(player: PlayerId) { return this.sim.driverNotes(player); }
  craftOf(player: PlayerId): CraftView | null { return this.sim.craftOf(player); }
  crafts(): readonly CraftView[] { return [...this.sim.crafts.values()].filter((c) => c.placed); }
  craftEvents(player: PlayerId) { return this.sim.craftEvents(player); }
  loadPhysics(warm?: { x: number; z: number }) { return this.sim.loadPhysics(warm).then(() => {}); }
}

/** how a MirrorSimClient reaches its sim: the frame's commands and input sent, the snapshots back (onSnapshot), the
 * road physics loaded there */
export interface SimLink {
  frame(dt: number, input: SimInput, commands: SimCommand[]): void;
  loadPhysics(warm?: { x: number; z: number }): Promise<void>;
  onSnapshot: (s: Snapshot) => void;
}

/** a SimServer in the page's thread: its snapshot at once after each frame (the snapshot format checked without a
 * worker: ?mirror=1) */
export class ThreadLink implements SimLink {
  onSnapshot: (s: Snapshot) => void = () => {};
  constructor(private readonly server: SimServer, private readonly player: PlayerId) {}
  frame(dt: number, input: SimInput, commands: SimCommand[]) {
    for (const c of commands) this.server.send(c);
    this.server.update(dt, input);
    this.onSnapshot(this.server.snapshot(this.player));
  }
  loadPhysics(warm?: { x: number; z: number }) { return this.server.sim.loadPhysics(warm).then(() => {}); }
}

/** the sim reached through snapshots (a worker's, or a ThreadLink's): the page draws a copy of the traffic
 * (TrafficMirror) and of the crafts, set from the latest snapshot; it holds one player's reads (player) */
export class MirrorSimClient implements SimClient {
  readonly traffic: TrafficMirror;
  private queue: SimCommand[] = [];
  private last: Snapshot | null = null;
  private events: SimEvent[] = [];
  private notes: Snapshot['player']['notes'] = [];
  private craftEventList: unknown[] = [];
  private outcomes: CommandResult[] = [];
  // the crafts by id: a core of each one's class, loaded from the snapshots (never stepped)
  private readonly craftList = new Map<CraftId, { -readonly [K in keyof CraftView]: CraftView[K] }>();
  private nextRef = 1;
  private readonly pending = new Map<number, { done: (n: [number, number][]) => void; fail: (e: unknown) => void }>();

  /** data: a TrafficData of the client's own (never the sim's: paths are prepared in place); ground: the page's world;
   * edits: the snapshots' edits put into the page's live edits (a worker's; not in the sim's own thread) */
  constructor(private readonly link: SimLink, data: TrafficData, ground: Ground | null, private readonly player: PlayerId,
    private readonly edits = false) {
    this.traffic = new TrafficMirror(data, ground);
    link.onSnapshot = (s) => this.take(s);
  }

  get tick() { return this.last?.tick ?? 0; }

  send(cmd: SimCommand) { this.queue.push(cmd); }

  edit(player: PlayerId, op: WorldOp) {
    const ref = this.nextRef++;
    return new Promise<[number, number][]>((done, fail) => {
      this.pending.set(ref, { done, fail });
      this.send({ kind: 'edit', player, op, ref });
    });
  }

  update(dt: number, input: SimInput) {
    const q = this.queue;
    this.queue = [];
    this.link.frame(dt, input, q);
  }

  private take(s: Snapshot) {
    this.last = s;
    if (this.edits) for (const e of s.edits) liveEdits.set(e.tx, e.ty, e.node, e.region);
    this.events.push(...this.traffic.apply(s));
    const old = s.tick - EVENT_TICKS;
    if (this.events.length && this.events[0].tick <= old) this.events = this.events.filter((e) => e.tick > old);
    const P = s.player;
    this.notes.push(...P.notes);
    this.craftEventList.push(...P.craftEvents);
    for (const r of P.results) {
      const p = r.kind === 'edit' && r.ref !== undefined ? this.pending.get(r.ref) : undefined;
      if (p) { this.pending.delete(r.ref!); if (r.nodes) p.done(r.nodes); else p.fail(new Error('edit failed')); }
      this.outcomes.push(r);
    }
    const L = this.craftList, seen = new Set<CraftId>();
    for (const c of s.crafts) {
      let m = L.get(c.id);
      if (!m) L.set(c.id, m = { id: c.id, type: c.type, pilot: c.pilot, placed: c.placed, core: CORES[c.type](DEFAULT_TUNING) });
      m.pilot = c.pilot;
      m.placed = c.placed;
      loadState(m.core, c.core);
      seen.add(c.id);
    }
    for (const id of L.keys()) if (!seen.has(id)) L.delete(id);
  }

  eventsSince(tick: number) {
    const E = this.events;
    let i = E.length;
    while (i > 0 && E[i - 1].tick > tick) i--;
    return E.slice(i);
  }

  results(player: PlayerId, kind: SimCommand['kind'], role?: Role) {
    if (player !== this.player) return [];
    const of = (o: CommandResult) => o.kind === kind && (!role || o.role === role);
    const mine = this.outcomes.filter(of);
    if (mine.length) this.outcomes = this.outcomes.filter((o) => !of(o));
    return mine;
  }

  seat(player: PlayerId) { return player === this.player ? this.last?.player.seat ?? null : null; }
  walkedPose(personId: number) { return this.traffic.walked.get(personId) ?? null; }
  driver(player: PlayerId) { return player === this.player ? this.last?.player.driver ?? null : null; }
  driverNotes(player: PlayerId) { return player === this.player ? this.notes.splice(0) : []; }
  craftOf(player: PlayerId): CraftView | null {
    const seat = this.seat(player);
    return seat?.role === 'pilot' ? this.craftList.get(seat.entity.id) ?? null : null;
  }
  crafts(): readonly CraftView[] { return [...this.craftList.values()]; }
  craftEvents(player: PlayerId) { return player === this.player ? this.craftEventList.splice(0) : []; }
  loadPhysics(warm?: { x: number; z: number }) { return this.link.loadPhysics(warm); }
}
