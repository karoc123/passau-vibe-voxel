// What the page holds of the world sim (ADR 0008: "the page sends commands and draws
// snapshots"): a SimClient. The page never reaches into the WorldSim; it holds one session of the server
// (sim/server/sim-server.ts Session: one player, named by the host, client.player), sends its player's commands
// (SimCommand: plain data, so they can cross to a Web Worker or a server; they name no player, the session's is stamped
// on them), runs the frame (update: the frame's input; in the page's thread the sim's update itself) and reads what the sim
// publishes: the traffic as drawn (TrafficView), the crafts in the world (piloted or left), its player's seat, car and
// craft, the outcomes of its commands, the events since a tick.
// LocalSimClient: the sim in the page's thread. Commands are queued and applied in the order sent at the start of the
// next tick (ADR 0007); every craft shell and the nav send theirs before the update in main.ts's frame. A seat input
// sent through a client gets the client's seq and the tick it is meant for (the tick seen + 1); the session answers
// with ack (the last one taken). The frame's time (time: FrameTime) is fixed by the update: what is drawn
// between the last two ticks (the traffic, the crafts' drawn(alpha)) is drawn at its alpha.
// MirrorSimClient: the sim reached through snapshots over a SimLink (ThreadLink, CloneLink here; WorkerLink:
// client/sim-worker-link.ts), drawn from TrafficMirror (below).
// Either one first takes its host's hello (sim/contract/hello.ts: the protocol, the data build, the tuning's hash;
// an in-thread session's at once, a link's before its first snapshot) and compares it with its own (the app's: sim/hello.ts
// hello); a host that differs is refused: client.hello rejects with what differs, the session is left (the link
// closed) and the client sends, runs and takes nothing more.
// No three.js, no DOM (tools/core-deps.mjs). The client never imports the server (docs/plans/architecture-review.md
// section 3, layer 4b): the in-thread client and link are given a session by the app (InThreadSession).
import type { WorldOp } from '../core/world-edits';
import { liveEdits } from '../core/live-edits';
import type { Ground } from '../sim/traffic';
import type { Car, TrafficData } from '../sim/types';
import type { CraftCore } from '../sim/craft/craft-core';
import { CORES } from '../sim/craft/cores';
import { DEFAULT_TUNING } from '../sim/tuning';
import type { CommandResult, SimCommand } from '../sim/contract/commands';
import type { CraftEventOf } from '../sim/contract/crafts';
import type { CraftId, CraftType, PlayerId, Role, Seat } from '../sim/contract/ids';
import type { FrameTime, SimInput } from '../sim/contract/inputs';
import { EVENT_TICKS, type DriveNote, type SimEvent } from '../sim/contract/events';
import type { Ack, DriverSnapshot, Snapshot } from '../sim/contract/snapshot';
import type { RoadPose, WalkPose } from '../sim/contract/pose';
import type { BodyDraw, BoatView, CarState, Person, PersonState } from '../sim/contract/agents';
import { fadeOut, STEP, Traffic, type TrafficBodies } from '../sim/traffic';
import { SeatReads } from '../sim/seat-reads';
import { checkHello } from '../sim/hello';
import type { Hello } from '../sim/contract/hello';

// (what the page sends, SimCommand, and what it reads: sim/contract/; TrafficView, TrafficMirror: below)

/** a player craft as the page sees it: its id and type, its pilot, whether it is put down, its core's state (read
 * only: pose, drawn(alpha) at the frame's alpha (SimClient.time), the motion or flight its shell shows). Its
 * collision is the sim's; a shell queries the world through its own (nav/). */
export interface CraftView<C extends CraftCore = CraftCore> {
  readonly id: CraftId;
  readonly type: CraftType;
  readonly pilot: PlayerId | null;
  readonly placed: boolean;
  readonly core: C;
}

export interface SimClient {
  /** the host's hello once it is taken (it matched the client's own); rejects with what differs if the host is refused
   * (the client is then out of the session: it sends, runs and takes nothing more) */
  readonly hello: Promise<Hello>;
  /** the player whose commands this client sends and whose reads it holds: its session's (the host names it; null
   * until the first snapshot of a session in another thread) */
  readonly player: PlayerId | null;
  /** the world's tick as last seen: the number of ticks run */
  readonly tick: number;
  /** the frame's time after the last update (its dt, the tick, alpha: how far between the last two ticks to draw) */
  readonly time: FrameTime;
  /** the traffic as drawn */
  readonly traffic: TrafficView;
  /** a command of the client's player, applied at the start of the next tick (a seat input given its seq and tick) */
  send(cmd: SimCommand): void;
  /** the frame: the commands sent applied, then the ticks due after dt s (SimInput: the hour, the focus, the viewer) */
  update(dt: number, input: SimInput): void;
  /** the sim's events of the ticks after tick, oldest first */
  eventsSince(tick: number): SimEvent[];
  /** the outcomes of the player's commands of kind (a request's: its kind; and of a seat's role) since the last call
   * for it, oldest first */
  results(kind: CommandResult['kind'], role?: Role): CommandResult[];
  /** the seat the player holds, or null */
  seat(): Seat | null;
  /** the last seat input of this client's the sim took (seq, the tick it was applied in), or null */
  ack(): Ack | null;
  /** where person personId is put by the player walking as them, or null while none does */
  walkedPose(personId: number): WalkPose | null;
  /** the player's car, or null while they drive none */
  driver(): DriverSnapshot | null;
  /** what the driver is to be told since the last call (the drive events of their car) */
  driverNotes(): DriveNote[];
  /** the craft the player pilots, or null */
  craftOf(): CraftView | null;
  /** the crafts put down in the world, piloted or left (any player may enter one left: enterSeat) */
  crafts(): readonly CraftView[];
  /** what happened to the player's craft since the last call, oldest first (the craft events of it) */
  craftEvents(): CraftEventOf[];
  /** the road physics loaded where the sim runs (warm: where the terrain is wanted soon); rejects if it cannot */
  loadPhysics(warm?: { x: number; z: number }): Promise<void>;
  /** an edit command of the player's whose answer is the level-1 nodes it changed, once applied */
  edit(op: WorldOp): Promise<[number, number][]>;
}

/** what the in-thread client and link use of a session of the server in the page's thread (sim/server/sim-server.ts
 * Session, given by the app: the client names the server only through this) */
export interface InThreadSession {
  readonly player: PlayerId;
  /** what the host tells the session first (SimServer.hello) */
  readonly hello: Hello;
  readonly sim: {
    readonly tick: number;
    readonly time: FrameTime;
    readonly traffic: TrafficView;
    readonly crafts: ReadonlyMap<CraftId, CraftView>;
    eventsSince(tick: number): SimEvent[];
    walkedPose(personId: number): WalkPose | null;
    craftOf(player: PlayerId): CraftView | null;
    loadPhysics(warm?: { x: number; z: number }): Promise<unknown>;
  };
  readonly server: { update(dt: number, input: SimInput): void };
  onEdit: ((ref: number, nodes: [number, number][] | null, error?: unknown) => void) | null;
  send(cmd: SimCommand): void;
  results(kind?: CommandResult['kind'], role?: Role): CommandResult[];
  ack(): Ack | null;
  seat(): Seat | null;
  driver(): DriverSnapshot | null;
  driverNotes(): DriveNote[];
  craftEvents(): CraftEventOf[];
  snapshot(): Snapshot;
  leave(): void;
}

/** the sim in the page's thread, read where it is (the page draws the sim's own objects): a session of the SimServer
 * over the WorldSim made by the page (host/sim-host.ts; the app connects it) */
export class LocalSimClient implements SimClient {
  readonly hello: Promise<Hello>;
  private nextRef = 1;
  private readonly seqs = new Seqs();
  private readonly pending = new Map<number, { done: (n: [number, number][]) => void; fail: (e: unknown) => void }>();
  // the host's hello refused (the session left)
  private readonly refused: Error | null;

  /** mine: the client's own hello (sim/hello.ts hello: this code, the build the app loaded) */
  constructor(private readonly session: InThreadSession, mine: Hello) {
    this.refused = checkHello(session.hello, mine);
    if (this.refused) session.leave();
    this.hello = this.refused ? Promise.reject(this.refused) : Promise.resolve(session.hello);
    session.onEdit = (ref, nodes, error) => {
      const p = this.pending.get(ref);
      this.pending.delete(ref);
      if (nodes) p?.done(nodes); else p?.fail(error);
    };
  }

  private get sim() { return this.session.sim; }
  get player() { return this.session.player; }
  get tick() { return this.sim.tick; }
  get time() { return this.sim.time; }
  get traffic(): TrafficView { return this.sim.traffic; }

  send(cmd: SimCommand) { if (!this.refused) this.session.send(this.seqs.stamp(cmd, this.tick)); }

  edit(op: WorldOp) {
    if (this.refused) return Promise.reject(this.refused);
    const ref = this.nextRef++;
    return new Promise<[number, number][]>((done, fail) => {
      this.pending.set(ref, { done, fail });
      this.session.send({ kind: 'edit', op, ref });
    });
  }

  update(dt: number, input: SimInput) { if (!this.refused) this.session.server.update(dt, input); }

  eventsSince(tick: number) { return this.sim.eventsSince(tick); }
  results(kind: CommandResult['kind'], role?: Role) { return this.session.results(kind, role); }
  seat() { return this.session.seat(); }
  ack() { return this.session.ack(); }
  walkedPose(personId: number) { return this.sim.walkedPose(personId); }
  driver() { return this.session.driver(); }
  driverNotes() { return this.session.driverNotes(); }
  craftOf(): CraftView | null { return this.sim.craftOf(this.session.player); }
  crafts(): readonly CraftView[] { return [...this.sim.crafts.values()].filter((c) => c.placed); }
  craftEvents() { return this.session.craftEvents(); }
  loadPhysics(warm?: { x: number; z: number }) { return this.sim.loadPhysics(warm).then(() => {}); }
}

/** a client's seat inputs' numbers: each one sent gets the next seq and the tick it is meant for */
class Seqs {
  private last = 0;
  stamp(cmd: SimCommand, tick: number): SimCommand {
    if (cmd.kind !== 'seatInput') return cmd;
    return { ...cmd, seq: ++this.last, tick: tick + 1 };
  }
}

/** how a MirrorSimClient reaches its sim: the host's hello first (onHello, before any snapshot), the frame's commands
 * and input sent, the snapshots back (onSnapshot), the road physics loaded there; close: the session left (the host
 * refused), nothing more sent or taken */
export interface SimLink {
  frame(dt: number, input: SimInput, commands: SimCommand[]): void;
  loadPhysics(warm?: { x: number; z: number }): Promise<void>;
  onHello: (h: Hello) => void;
  onSnapshot: (s: Snapshot) => void;
  close(): void;
}

/** a session of a SimServer in the page's thread: the frame's commands sent through it, the server's update, the
 * session's snapshot at once after it (the snapshot format checked without a worker: ?mirror=1) */
export class ThreadLink implements SimLink {
  onHello: (h: Hello) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  private greeted = false;
  private closed = false;
  constructor(private readonly session: InThreadSession) {}
  frame(dt: number, input: SimInput, commands: SimCommand[]) {
    // (the session's hello before its first frame, as a host's first message)
    if (!this.greeted) { this.greeted = true; this.onHello(this.session.hello); }
    if (this.closed) return;
    for (const c of commands) this.session.send(c);
    this.session.server.update(dt, input);
    this.onSnapshot(this.session.snapshot());
  }
  loadPhysics(warm?: { x: number; z: number }) { return this.session.sim.loadPhysics(warm).then(() => {}); }
  close() { if (!this.closed) { this.closed = true; this.session.leave(); } }
}

/** a SimLink whose messages cross as they would to a Web Worker or over a socket (the protocol gate: mirror-check,
 * life-edit's left and events; docs/plans/architecture-review.md F4, A5): each snapshot checked to be plain data and
 * structured-cloned (what postMessage does), the frame's commands and input and loadPhysics' warm checked and sent
 * through JSON (what a socket would). So a snapshot or a command that is not plain data, or that shares an object
 * with the sim or the client, fails the gate that runs through it instead of passing by reference (ThreadLink). */
export class CloneLink implements SimLink {
  onHello: (h: Hello) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  /** the messages that crossed (the hello, snapshots, frames) */
  crossed = 0;
  constructor(private readonly link: SimLink) {
    link.onHello = (h) => { this.crossed++; this.onHello(jsonTrip(h, 'hello')); };
    link.onSnapshot = (s) => { this.crossed++; this.onSnapshot(cloned(s, 'snapshot')); };
  }
  frame(dt: number, input: SimInput, commands: SimCommand[]) {
    const m = jsonTrip({ dt, input, commands }, 'frame');
    this.crossed++;
    this.link.frame(m.dt, m.input, m.commands);
  }
  loadPhysics(warm?: { x: number; z: number }) { return this.link.loadPhysics(warm && jsonTrip(warm, 'loadPhysics')); }
  close() { this.link.close(); }
}

/** v as structuredClone gives it (a worker's postMessage), once it is checked to be plain data (plainData) */
function cloned<T>(v: T, what: string): T {
  plainData(v, what, true);
  return structuredClone(v);
}

/** v sent through JSON (a socket's text), once it is checked to be plain data JSON keeps as it is */
function jsonTrip<T>(v: T, what: string): T {
  plainData(v, what, false);
  return JSON.parse(JSON.stringify(v)) as T;
}

/** throws unless v is plain data: null, booleans, numbers, strings, arrays and objects whose prototype is Object's
 * (or none), no cycle; with typed: typed arrays too (structured clone keeps them), and NaN, Infinity, undefined in an
 * array (only JSON loses those). No function, class instance, Map, Set, Date, symbol or bigint. */
export function plainData(v: unknown, at: string, typed: boolean, path = new Set<object>()): void {
  const t = typeof v;
  if (v === null || t === 'boolean' || t === 'string') return;
  if (t === 'number') { if (!typed && !Number.isFinite(v)) throw new Error(`not plain data: ${at} is ${v}`); return; }
  if (t === 'undefined') return; // (an object's field: left out by JSON, kept by clone; in an array: below)
  if (t !== 'object') throw new Error(`not plain data: ${at} is a ${t}`);
  const o = v as object;
  if (ArrayBuffer.isView(o)) { if (typed) return; throw new Error(`not plain data for JSON: ${at} is a ${o.constructor.name}`); }
  if (path.has(o)) throw new Error(`not plain data: ${at} is a cycle`);
  path.add(o);
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      if (!typed && o[i] === undefined) throw new Error(`not plain data for JSON: ${at}[${i}] is undefined`);
      plainData(o[i], `${at}[${i}]`, typed, path);
    }
  } else {
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) throw new Error(`not plain data: ${at} is a ${proto?.constructor?.name ?? 'class instance'}`);
    for (const k in o) plainData((o as Record<string, unknown>)[k], `${at}.${k}`, typed, path);
  }
  path.delete(o);
}

/** the sim reached through snapshots (a worker's, or a ThreadLink's): the page draws a copy of the traffic
 * (TrafficMirror) and of the crafts, set from the latest snapshot; it holds its session's player's reads (player: the
 * snapshots name it) */
export class MirrorSimClient implements SimClient {
  readonly traffic: TrafficMirror;
  readonly hello: Promise<Hello>;
  // the host's hello: taken (it matched), or refused (the link closed); settle: the hello's promise
  private greeted: Hello | null = null;
  private refused: Error | null = null;
  private settle!: { ok: (h: Hello) => void; fail: (e: Error) => void };
  private queue: SimCommand[] = [];
  private readonly seqs = new Seqs();
  private last: Snapshot | null = null;
  private dt = 0;
  private events: SimEvent[] = [];
  private readonly reads = new SeatReads();
  private outcomes: CommandResult[] = [];
  // the crafts by id: a core of each one's class, loaded from the snapshots (never stepped)
  private readonly craftList = new Map<CraftId, { -readonly [K in keyof CraftView]: CraftView[K] }>();
  private nextRef = 1;
  private readonly pending = new Map<number, { done: (n: [number, number][]) => void; fail: (e: unknown) => void }>();

  /** data: a TrafficData of the client's own (never the sim's: paths are prepared in place); ground: the page's world;
   * edits: the snapshots' edits put into the page's live edits (a worker's; not in the sim's own thread); mine: the
   * client's own hello (sim/hello.ts hello: this code, the build the app loaded) */
  constructor(private readonly link: SimLink, data: TrafficData, ground: Ground | null, private readonly edits: boolean,
    private readonly mine: Hello) {
    this.traffic = new TrafficMirror(data, ground);
    this.hello = new Promise((ok, fail) => { this.settle = { ok, fail }; });
    link.onHello = (h) => this.greet(h);
    link.onSnapshot = (s) => this.take(s);
  }

  // the host's hello: taken if it matches the client's own, else refused
  private greet(h: Hello) {
    if (this.greeted || this.refused) return;
    const e = checkHello(h, this.mine);
    if (e) { this.refuse(e); return; }
    this.greeted = h;
    this.settle.ok(h);
  }

  private refuse(e: Error) {
    this.refused = e;
    this.queue = [];
    this.link.close();
    this.settle.fail(e);
  }

  get player(): PlayerId | null { return this.last?.player.id ?? null; }
  get tick() { return this.last?.tick ?? 0; }
  /** (the latest snapshot's tick and alpha: one update behind the frame with a worker, M4) */
  get time(): FrameTime { return { dt: this.dt, tick: this.tick, alpha: (this.last?.acc ?? 0) / STEP }; }

  send(cmd: SimCommand) { if (!this.refused) this.queue.push(this.seqs.stamp(cmd, this.tick)); }

  edit(op: WorldOp) {
    if (this.refused) return Promise.reject(this.refused);
    const ref = this.nextRef++;
    return new Promise<[number, number][]>((done, fail) => {
      this.pending.set(ref, { done, fail });
      this.send({ kind: 'edit', op, ref });
    });
  }

  update(dt: number, input: SimInput) {
    if (this.refused) return;
    const q = this.queue;
    this.queue = [];
    this.dt = Math.min(dt, 0.1);
    this.link.frame(dt, input, q);
  }

  private take(s: Snapshot) {
    if (this.refused) return;
    if (!this.greeted) { this.refuse(new Error('sim: host refused: a snapshot came before its hello')); return; }
    this.last = s;
    if (this.edits) for (const e of s.edits) liveEdits.set(e.tx, e.ty, e.node, e.region);
    this.traffic.apply(s);
    this.events.push(...s.events);
    const old = s.tick - EVENT_TICKS;
    if (this.events.length && this.events[0].tick <= old) this.events = this.events.filter((e) => e.tick > old);
    const P = s.player;
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
      m.core.load(c.core);
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

  results(kind: CommandResult['kind'], role?: Role) {
    const of = (o: CommandResult) => o.kind === kind && (!role || o.role === role);
    const mine = this.outcomes.filter(of);
    if (mine.length) this.outcomes = this.outcomes.filter((o) => !of(o));
    return mine;
  }

  seat() { return this.last?.player.seat ?? null; }
  ack() { return this.last?.player.ack ?? null; }
  walkedPose(personId: number) { return this.traffic.walked.get(personId) ?? null; }
  driver() { return this.last?.player.driver ?? null; }
  driverNotes() { return this.last ? this.reads.take(this.events, this.last.player.id, this.seat(), 'drive', this.tick).map((e) => e.note) : []; }
  craftOf(): CraftView | null {
    const seat = this.seat();
    return seat?.role === 'pilot' ? this.craftList.get(seat.entity.id) ?? null : null;
  }
  crafts(): readonly CraftView[] { return [...this.craftList.values()]; }
  craftEvents() { return this.last ? this.reads.crafts(this.events, this.last.player.id, this.seat(), this.tick) : []; }
  loadPhysics(warm?: { x: number; z: number }) { return this.link.loadPhysics(warm); }
}

/** what the presentation reads of the traffic (view/life.ts, nav/): the agents between their last two ticks and the
 * path maths that place them (the static roads and footways), the signals, trains, boats, the bodies' poses. In the
 * page's thread it is the sim's Traffic itself; a client of a worker or a server fills a Traffic of its own from
 * snapshots (ADR 0008). Read only: what is drawn where is the view's (view/life.ts). */
export type TrafficView = Readonly<Pick<Traffic, 'heads' | 'peds' | 'cars' | 'detachedCars' | 'people' | 'riders' | 'active' |
  'acc' | 'trains' | 'ground' | 'carPose' | 'pathPoint' | 'personPoint' | 'signal' | 'roadVehicles'>> &
  { readonly bodies: Pick<TrafficBodies, 'owns' | 'pose'> | null; readonly boats: BoatView | null };

const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const lerpAngle = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

/** the client's copy of the traffic, set from snapshots: what view/life.ts and the nav read (TrafficView) */
export class TrafficMirror implements TrafficView {
  private readonly T: Traffic;
  private readonly carsById = new Map<number, Car>();
  private readonly peopleById = new Map<number, Person>();
  private readonly draws = new Map<number, BodyDraw>();
  boats: BoatView | null = null;
  /** the people walked by players, by person id */
  readonly walked = new Map<number, WalkPose>();
  readonly bodies = {
    owns: (c: Car) => !!this.draws.get(c.id)?.owns,
    pose: (c: Car, a: number, under: RoadPose) => this.bodyPose(c, a, under),
  };

  /** data: a TrafficData of its own (its paths are prepared in place: never the sim's); ground: the page's */
  constructor(data: TrafficData, ground: Ground | null) {
    this.T = new Traffic(data);
    this.T.ground = ground;
  }

  get heads() { return this.T.heads; }
  get peds() { return this.T.peds; }
  get cars() { return this.T.cars; }
  get detachedCars() { return this.T.detachedCars; }
  get people() { return this.T.people; }
  get riders() { return this.T.riders; }
  get active() { return this.T.active; }
  get acc() { return this.T.acc; }
  get trains() { return this.T.trains; }
  get ground() { return this.T.ground; }
  carPose: Traffic['carPose'] = (c, s, off, out) => this.T.carPose(c, s, off, out);
  pathPoint: Traffic['pathPoint'] = (c, s, out, off) => this.T.pathPoint(c, s, out, off);
  personPoint: Traffic['personPoint'] = (p, ds, out) => this.T.personPoint(p, ds, out);
  signal: Traffic['signal'] = (ctrl, axis) => this.T.signal(ctrl, axis);
  roadVehicles = () => this.T.roadVehicles();

  /** the snapshot's agents in place of the last (one object per id) */
  apply(s: Snapshot) {
    const T = this.T;
    T.acc = s.acc; T.t = s.t; T.day = s.day;
    // (a new object only when it moves: the signal heads are placed again then)
    if (!s.active) T.active = null;
    else if (!T.active || T.active.x !== s.active.x || T.active.z !== s.active.z) T.active = s.active;
    const cars = (list: CarState[], into: Car[], seen: Set<number>) => {
      into.length = 0;
      for (const st of list) {
        let c = this.carsById.get(st.id);
        if (!c) this.carsById.set(st.id, c = { kind: 'car' } as Car);
        Object.assign(c, st);
        into.push(c);
        seen.add(st.id);
      }
    };
    const seenCars = new Set<number>();
    cars(s.cars, T.cars, seenCars);
    cars(s.detached, T.detachedCars, seenCars);
    for (const id of this.carsById.keys()) if (!seenCars.has(id)) this.carsById.delete(id);
    const seenPeople = new Set<number>();
    const people = (list: PersonState[]) => list.map((st) => {
      let p = this.peopleById.get(st.id);
      if (!p) this.peopleById.set(st.id, p = { kind: 'person' } as Person);
      Object.assign(p, st);
      seenPeople.add(st.id);
      return p;
    });
    T.people = people(s.people);
    T.riders = people(s.riders);
    for (const id of this.peopleById.keys()) if (!seenPeople.has(id)) this.peopleById.delete(id);
    this.draws.clear();
    for (const [id, d] of s.bodies) this.draws.set(id, d);
    T.trains.load(s.trains);
    this.boats = s.boats;
    this.walked.clear();
    for (const [id, w] of s.walked) this.walked.set(id, w);
  }

  // as LifePhysics.pose: a parked car or a wreck where it is, a body between its last two drawn poses, the fade back
  // onto its path blended out
  private bodyPose(c: Car, a: number, under: RoadPose): RoadPose {
    const d = this.draws.get(c.id);
    let p = c.detachedPose ?? under;
    if (!d) return p;
    if (d.p0 && d.p1) {
      const p0 = d.p0, q = d.p1, l = (u: number, v: number) => u + (v - u) * a;
      p = { x: l(p0.x, q.x), y: l(p0.y, q.y), z: l(p0.z, q.z), h: lerpAngle(p0.h, q.h, a), pitch: lerpAngle(p0.pitch, q.pitch, a), roll: lerpAngle(p0.roll, q.roll, a) };
    }
    const f = d.fade;
    return f ? fadeOut(p, f, 1 - smooth01((f.t + (a - 1) * STEP) / f.dur), d.body) : p;
  }
}
