// What the page holds of the world sim (ADR 0008: "the page sends commands and draws snapshots"): a SimClient. The
// page never reaches into the WorldSim; it holds one session of the server (one player, named by the host,
// client.player), sends its player's commands (plain data naming no player: the session's is stamped on them) and
// reads what the sim publishes, from its snapshots: the traffic as drawn (TrafficMirror), the crafts in the world
// (piloted or left), its player's seat, car and craft, the outcomes of its commands, the events since a tick.
// The server ticks on its own clock; the page does not drive it. Snapshots wait in a short buffer and are drawn on a
// render clock that runs with the page's frames a little behind the newest snapshot, so snapshots arriving unevenly
// never show as a stop and a jump. What the player must learn at once (seat, results, events, edits, the time of day)
// is read from the newest snapshot as it arrives; what is drawn (agents, bodies, the crafts' poses) from the one the
// render clock is in. A seat input gets its seq and the tick it is meant for (the tick seen + 1); the session answers
// with ack (the last one taken).
// The client first takes its host's hello (the protocol, the data build, the tuning's hash) and refuses a host that
// differs: client.hello rejects with what differs, the link is closed and the client sends and takes nothing more.
// A later hello (the link connected again: a new session, perhaps a new host) starts the client's session reads afresh;
// what the player held is gone with the old session.
// No three.js, no DOM. The client never imports the server.
import { editNode, opRegion, type WorldOp } from '../core/world-edits';
import { LiveEdits, type LiveNode, type Region } from '../core/live-edits';
import type { Frame } from '../core/layers';
import type { NodeView, TileCache } from '../core/tile-cache';
import type { Car, TrafficData } from '../sim/types';
import type { CraftCore } from '../sim/craft/craft-core';
import { CORES } from '../sim/craft/cores';
import { DEFAULT_TUNING } from '../sim/tuning';
import type { CommandResult, SimCommand } from '../sim/contract/commands';
import type { CraftEventOf } from '../sim/contract/crafts';
import type { CraftId, CraftType, PlayerId, Role, Seat } from '../sim/contract/ids';
import type { FrameTime } from '../sim/contract/inputs';
import { EVENT_TICKS, type DriveNote, type SimEvent } from '../sim/contract/events';
import type { Ack, AvatarState, DriverSnapshot, EditNote, PlayerReads, Snapshot, TimeOfDay } from '../sim/contract/snapshot';
import type { Pose, RoadPose, WalkPose } from '../sim/contract/pose';
import type { BodyDraw, BoatView, CarState, Person, PersonState, TrainState } from '../sim/contract/agents';
import { AgentRead, reckon, type Sampled } from '../sim/agent-wire';
import { PH_RIDE, PH_WALK, RoadNet, signalAt, STEP, type Ground } from '../sim/road-net';
import { coachPoses, trainTracks, type CoachPose } from '../sim/coaches';
import { drawnBodyPose } from '../sim/body-pose';
import { SeatReads } from '../sim/seat-reads';
import { checkHello } from '../sim/hello';
import type { Hello } from '../sim/contract/hello';

// (what the page sends, SimCommand, and what it reads: sim/contract/; TrafficMirror: below)

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
   * until the first snapshot) */
  readonly player: PlayerId | null;
  /** the world's tick as last seen: the number of ticks run */
  readonly tick: number;
  /** the frame's time after the last update (its dt, the tick, alpha: how far between the last two ticks to draw) */
  readonly time: FrameTime;
  /** the traffic as drawn */
  readonly traffic: TrafficMirror;
  /** a command of the client's player, applied at the start of the next tick (a seat input given its seq and tick) */
  send(cmd: SimCommand): void;
  /** the frame: the commands sent on, the render clock moved on by dt s and what it is in drawn */
  update(dt: number): void;
  /** the world's time of day and day of the year as last seen (the host's; a player asks for another: a setTime
   * request); null before the first snapshot */
  readonly timeOfDay: TimeOfDay | null;
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
  /** an edit command of the player's whose answer is the level-1 nodes it changed, once applied (in the first tick
   * after the host has its nodes in) */
  edit(op: WorldOp): Promise<[number, number][]>;
  /** the world's edited nodes as this client sees them, filled from the snapshots: what the page's streamer and
   * TileCache read */
  readonly edits: LiveEdits;
}

/** a client's seat inputs' numbers: each one sent gets the next seq and the tick it is meant for */
class Seqs {
  private last = 0;
  stamp(cmd: SimCommand, tick: number): SimCommand {
    if (cmd.kind !== 'seatInput') return cmd;
    return { ...cmd, seq: ++this.last, tick: tick + 1 };
  }
}

/** how a MirrorSimClient reaches its sim: the host's hello first (onHello, before any snapshot), the commands sent,
 * the snapshots back on the host's own clock (onSnapshot); close: the session left (the host refused), nothing more
 * sent or taken */
export interface SimLink {
  send(commands: SimCommand[]): void;
  onHello: (h: Hello) => void;
  onSnapshot: (s: Snapshot) => void;
  close(): void;
}

/** a SimLink whose messages cross as they would to a Web Worker or over a socket (the protocol gate: mirror-check,
 * life-edit's left and events; docs/adr/0009-layers-and-owners.md): each snapshot checked to be plain data and
 * structured-cloned (what postMessage does), the commands checked and sent through JSON (what a socket would). So a
 * snapshot or a command that is not plain data, or that shares an object with the sim or the client, fails the gate
 * that runs through it instead of passing by reference. */
export class CloneLink implements SimLink {
  onHello: (h: Hello) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  /** the messages that crossed (the hello, snapshots, commands) */
  crossed = 0;
  constructor(private readonly link: SimLink) {
    link.onHello = (h) => { this.crossed++; this.onHello(jsonTrip(h, 'hello')); };
    link.onSnapshot = (s) => { this.crossed++; this.onSnapshot(cloned(s, 'snapshot')); };
  }
  send(commands: SimCommand[]) {
    this.crossed++;
    this.link.send(jsonTrip(commands, 'commands'));
  }
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

// The render clock (in ticks) and how far behind the newest snapshot it is held. Each snapshot holds its tick and the
// one before, so the clock may run up to the newest. The least lead seen over the last WINDOW s is kept between
// LEAD_LO and LEAD_HI by running the clock a little faster or slower: per tick out of the band SLOWER when it is about
// to run dry (which would stop what is drawn), FASTER when it lags (which costs only latency), and FAR more per tick
// beyond half a tick out, so a large error goes within a second or two; at most SLEW, a change of pace too small to
// see. Behind by more than RESYNC ticks (the page was hidden, the server stalled), it is set START behind the newest.
const WINDOW = 0.5, LEAD_LO = 0.05, LEAD_HI = 0.3, SLOWER = 0.02, FASTER = 0.005, FAR = 0.02, SLEW = 0.02;
const RESYNC = 6, START = 0.8;
// the snapshots held at most (a page in the background draws none)
const KEEP = 64;

/** the sim reached through snapshots (a worker's; a tool's own session): the page draws a copy of the traffic
 * (TrafficMirror) and of the crafts at its render clock; it holds its session's player's reads from the newest
 * snapshot (player: the snapshots name it) */
export class MirrorSimClient implements SimClient {
  readonly traffic: TrafficMirror;
  readonly hello: Promise<Hello>;
  // the host's hello: taken (it matched), or refused (the link closed); settle: the hello's promise
  private greeted: Hello | null = null;
  private refused: Error | null = null;
  private settle!: { ok: (h: Hello) => void; fail: (e: Error) => void };
  private queue: SimCommand[] = [];
  private readonly seqs = new Seqs();
  private last: Snapshot & { player: PlayerReads } | null = null;
  private dt = 0;
  // the snapshots not yet drawn past, oldest first (one per tick); the one drawn and how far into its tick; the render
  // clock (ticks; null until the first snapshot); the frames' own clock (s) and the leads seen on it
  private readonly buffer: Taken[] = [];
  private drawn: Taken | null = null;
  private alpha = 0;
  private at: number | null = null;
  private clock = 0;
  private readonly leads: [number, number][] = [];
  private events: SimEvent[] = [];
  private reads = new SeatReads();
  private outcomes: CommandResult[] = [];
  // the crafts by id: a core of each one's class, loaded from the snapshots (never stepped)
  private readonly craftList = new Map<CraftId, { -readonly [K in keyof CraftView]: CraftView[K] }>();
  private nextRef = 1;
  private readonly pending = new Map<number, { done: (n: [number, number][]) => void; fail: (e: unknown) => void }>();
  // the nodes whose edits wait for their files, by "tx_ty": each note after the one before
  private readonly editing = new Map<string, Promise<unknown>>();

  /** data: a TrafficData of the client's own (never the sim's: paths are prepared in place); ground: the page's world;
   * mine: the client's own hello (this code, the build the app loaded); edits: the client's live edits, the snapshots'
   * edits applied into them over the node files of tiles (its TileCache over these edits, the world's frame; none:
   * the edits are not applied) */
  constructor(private readonly link: SimLink, data: TrafficData, ground: Ground | null, private readonly mine: Hello,
    readonly edits: LiveEdits = new LiveEdits(), private readonly tiles: { cache: TileCache; frame: Frame } | null = null) {
    if (tiles && tiles.cache.edits !== edits) throw new Error('sim-client: the TileCache must see the client\'s edits');
    this.traffic = new TrafficMirror(data, ground);
    this.hello = new Promise((ok, fail) => { this.settle = { ok, fail }; });
    link.onHello = (h) => this.greet(h);
    link.onSnapshot = (s) => this.take(s);
  }

  // the host's hello: taken if it matches the client's own, else refused; a later one, a new session: its reads afresh
  private greet(h: Hello) {
    if (this.refused) return;
    const e = checkHello(h, this.mine);
    if (e) { this.refuse(e); return; }
    if (this.greeted) { this.restart(); return; }
    this.greeted = h;
    this.settle.ok(h);
  }

  // a new session (its tick may start anew): nothing of the old one's snapshots, events, outcomes or crafts kept; its
  // edits not yet answered failed
  private restart() {
    this.last = this.drawn = null;
    this.buffer.length = 0;
    this.at = null;
    this.leads.length = 0;
    this.events = [];
    this.outcomes = [];
    this.reads = new SeatReads();
    this.craftList.clear();
    this.traffic.forget();
    for (const p of this.pending.values()) p.fail(new Error('edit lost: the host connection was lost'));
    this.pending.clear();
  }

  private refuse(e: Error) {
    this.refused = e;
    this.queue = [];
    this.link.close();
    this.settle.fail(e);
  }

  get player(): PlayerId | null { return this.last?.player.id ?? null; }
  get tick() { return this.last?.tick ?? 0; }
  /** the frame's time: the tick drawn and how far into it */
  get time(): FrameTime { return { dt: this.dt, tick: this.drawn?.tick ?? 0, alpha: this.alpha }; }
  /** how far the render clock is behind the newest snapshot (ticks), for the tools */
  get lead() { return this.last && this.at !== null ? this.last.tick - this.at : 0; }
  get timeOfDay(): TimeOfDay | null { return this.last && { hour: this.last.hour, day: this.last.day }; }

  send(cmd: SimCommand) { if (!this.refused) this.queue.push(this.seqs.stamp(cmd, this.tick)); }

  edit(op: WorldOp) {
    if (this.refused) return Promise.reject(this.refused);
    const ref = this.nextRef++;
    return new Promise<[number, number][]>((done, fail) => {
      this.pending.set(ref, { done, fail });
      this.send({ kind: 'edit', op, ref });
    });
  }

  update(dt: number) {
    if (this.refused) return;
    const q = this.queue;
    this.queue = [];
    if (q.length) this.link.send(q);
    this.dt = Math.min(dt, 0.1);
    this.advance(this.dt);
  }

  // the render clock moved on by the frame's dt, and the snapshot it is in drawn
  private advance(dt: number) {
    const B = this.buffer;
    if (!B.length) return;
    const newest = B[B.length - 1].tick;
    this.clock += dt;
    if (this.at === null || newest - this.at > RESYNC) { this.at = newest - START; this.leads.length = 0; }
    else {
      const L = this.leads;
      while (L.length && L[0][0] < this.clock - WINDOW) L.shift();
      let least = Infinity;
      for (const [, l] of L) least = Math.min(least, l);
      const off = least === Infinity ? 0 : least < LEAD_LO ? least - LEAD_LO : least > LEAD_HI ? least - LEAD_HI : 0;
      const pace = off * (off < 0 ? SLOWER : FASTER) + Math.sign(off) * Math.max(0, Math.abs(off) - 0.5) * FAR;
      this.at += (dt / STEP) * (1 + Math.max(-SLEW, Math.min(SLEW, pace)));
    }
    this.leads.push([this.clock, newest - this.at]);
    // (nothing newer to draw: held at the newest)
    if (this.at > newest) this.at = newest;
    let i = 0;
    while (B[i].tick < this.at) i++;
    if (i) B.splice(0, i);
    const s = B[0];
    this.alpha = Math.max(0, Math.min(1, this.at - (s.tick - 1)));
    if (s !== this.drawn) this.draw(s);
    this.traffic.acc = this.alpha * STEP;
    this.traffic.reckon(s.tick - 1 + this.alpha);
  }

  // the snapshot drawn from now on: the traffic and the crafts' poses as they were in it
  private draw(s: Taken) {
    this.drawn = s;
    this.traffic.apply(s);
    for (const c of s.crafts) this.craftList.get(c.id)?.core.load(c.core);
  }

  private take(w: Snapshot) {
    if (this.refused) return;
    if (!this.greeted) { this.refuse(new Error('sim: host refused: a snapshot came before its hello')); return; }
    // (the player's reads left out: those before, without their results)
    const held = this.last?.player;
    if (!w.player && !held) { this.refuse(new Error('sim: host sent no player reads')); return; }
    const s = this.last = { ...w, player: w.player ?? { ...held!, results: [] } };
    const B = this.buffer;
    // (a snapshot of a tick already held is the newer word on it)
    if (B.length && B[B.length - 1].tick >= s.tick) B.pop();
    B.push(this.traffic.read(s));
    if (B.length > KEEP) B.splice(0, B.length - KEEP);
    for (const e of s.edits) this.takeEdit(e);
    this.events.push(...s.events);
    const old = s.tick - EVENT_TICKS;
    if (this.events.length && this.events[0].tick <= old) this.events = this.events.filter((e) => e.tick > old);
    const P = s.player;
    for (const r of P.results) {
      const p = r.kind === 'edit' && r.ref !== undefined ? this.pending.get(r.ref) : undefined;
      if (p) {
        this.pending.delete(r.ref!);
        const nodes = r.nodes;
        // (answered once the page's own nodes show it)
        if (nodes) void Promise.all(nodes.map(([tx, ty]) => this.editing.get(`${tx}_${ty}`))).then(() => p.done(nodes));
        else p.fail(new Error('edit failed'));
      }
      this.outcomes.push(r);
    }
    // (which crafts there are and who pilots them: at once; a new one's pose from here until a snapshot with it is drawn)
    const L = this.craftList, seen = new Set<CraftId>();
    for (const c of s.crafts) {
      let m = L.get(c.id);
      if (!m) { L.set(c.id, m = { id: c.id, type: c.type, pilot: c.pilot, placed: c.placed, core: CORES[c.type](DEFAULT_TUNING) }); m.core.load(c.core); }
      m.pilot = c.pilot;
      m.placed = c.placed;
      seen.add(c.id);
    }
    for (const id of L.keys()) if (!seen.has(id)) L.delete(id);
  }

  // an edit note applied now, or once its node's files are in (after the notes on the node before it)
  private takeEdit(n: EditNote) {
    const T = this.tiles;
    if (!T) return;
    const k = `${n.tx}_${n.ty}`, before = this.editing.get(k);
    if (!before && this.applyEdit(n)) return;
    const { cache } = T;
    const run = (before ?? Promise.resolve()).then(() => cache.acquire(n.tx, n.ty).then(() => {
      try { if (!this.applyEdit(n)) console.warn(`sim-client: node ${k} not in for its edit`); } finally { cache.release(n.tx, n.ty); }
    }, () => console.warn(`sim-client: node ${k}'s files for its edit failed`)));
    this.editing.set(k, run);
    void run.then(() => { if (this.editing.get(k) === run) this.editing.delete(k); });
  }

  // note n applied over the client's copy of its node; false: its columns are not at hand (its files to load first)
  private applyEdit(n: EditNote): boolean {
    const { cache, frame } = this.tiles!, E = this.edits, live = E.get(n.tx, n.ty);
    if (!n.ops) { E.set(n.tx, n.ty, null); return true; }
    const have = live?.ops ?? [];
    let ops = n.ops;
    if (n.from !== have.length) {
      // (a new session sends a node's ops from its first again: those applied already skipped, unless the history
      // differs: then from the files)
      const k = have.length - n.from, same = (a: WorldOp, b: WorldOp) => JSON.stringify(a) === JSON.stringify(b);
      if (n.from === 0 && k > 0 && ops.length >= k && ops.slice(0, k).every((op, i) => same(op, have[i]))) ops = ops.slice(k);
      else if (n.from === 0) E.set(n.tx, n.ty, null);
      else console.warn(`sim-client: node ${n.tx}_${n.ty} sent ops from ${n.from}, ${have.length} applied`);
    }
    if (!ops.length) return true;
    const v = cache.view(n.tx, n.ty);
    if (!v) return false;
    let node: LiveNode = { base: v.base, foliage: v.foliage, ops: E.get(n.tx, n.ty)?.ops ?? [] }, region: Region = null;
    for (const op of ops) {
      node = editNode(frame, n.tx, n.ty, { base: node.base, foliage: node.foliage as NodeView['foliage'], edited: true }, op, node.ops ?? []);
      const r = opRegion(frame, op);
      region = region ? [Math.min(region[0], r[0]), Math.min(region[1], r[1]), Math.max(region[2], r[2]), Math.max(region[3], r[3])] : r;
    }
    E.set(n.tx, n.ty, node, region);
    return true;
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
}

/** a snapshot as the client holds it: all its cars and people, each as last sampled, and all the cars out of the
 * traffic, bodies and avatars it holds (TrafficMirror read) */
export type Taken = Omit<Snapshot, 'cars' | 'people' | 'riders' | 'trains' | 'boats' | 'avatars' | 'bodies'> & { cars: Sampled<CarState>[]; people: Sampled<PersonState>[];
  riders: Sampled<PersonState>[]; trains: Sampled<TrainState>[]; boats: BoatView | null; avatars: AvatarState[]; bodies: [number, BodyDraw][] };

// A correction (a new sample of a car where the one before was reckoned elsewhere) is blended out over BLEND_S s, eased
// in and out (an exponential's first frame would be a kick); one over SNAP m (a car put elsewhere) is not
const BLEND_S = 0.3, SNAP = 4;
const left = (t: number, from: number) => { const u = Math.min(1, (t - from) * STEP / BLEND_S); return 1 - u * u * (3 - 2 * u); };
interface Reckoned<T> { st: Sampled<T>; old: Sampled<T> | null; es: number; eo: number; from: number }
// the samples of a list in place of the last (a new one's correction worked out when it is next reckoned)
function resample<T extends { id: number }>(R: Map<number, Reckoned<T>>, list: readonly Sampled<T>[], seen: { has(id: number): boolean }) {
  for (const st of list) {
    const r = R.get(st.id);
    if (!r) R.set(st.id, { st, old: null, es: 0, eo: 0, from: 0 });
    else if (r.st !== st) { r.old = r.st; r.st = st; }
  }
  if (R.size > list.length) for (const id of R.keys()) if (!seen.has(id)) R.delete(id);
}

/** the client's copy of the traffic, set from snapshots: what the presentation reads of the traffic (view/life.ts,
 * nav/): the agents between their last two ticks and the path maths that place them (the static roads and footways,
 * re-run on the client's own TrafficData), the signals, trains, boats, the bodies' poses. Read only: what is drawn
 * where is the view's (view/life.ts) */
export class TrafficMirror {
  // the roads, footways and signals, and where on them things are drawn: the sim's own code (sim/road-net.ts)
  private readonly net: RoadNet;
  private readonly carsById = new Map<number, Car>();
  private readonly peopleById = new Map<number, Person>();
  private readonly draws = new Map<number, BodyDraw>();
  // the cars and people as last sent (a snapshot carries what changed since: sim/agent-wire.ts); the samples the cars
  // and people drawn are reckoned on from, and the corrections being blended out
  private readonly wire: AgentRead;
  private readonly sampled = new Map<number, Reckoned<CarState>>();
  private readonly trainSamples = new Map<number, Reckoned<TrainState>>();
  private readonly walking = new Map<number, Sampled<PersonState>>();
  readonly cars: Car[] = [];
  readonly detachedCars: Car[] = [];
  people: Person[] = [];
  riders: Person[] = [];
  /** how far into the tick drawn the render clock is (s, under STEP) */
  acc = 0;
  private t = 0;
  boats: BoatView | null = null;
  /** the trains' coaches as drawn (sim/coaches.ts: the sim's own code), from the trains reckoned (back: none) */
  readonly trains: { coaches(back?: number): IterableIterator<CoachPose> };
  // the trains as drawn now (reckoned), by id
  private readonly trainsById = new Map<number, TrainState>();
  private trainList: TrainState[] = [];
  /** the people walked by players, by person id */
  readonly walked = new Map<number, WalkPose>();
  /** the players' own bodies on foot (avatarPose: where one is drawn) */
  avatars: AvatarState[] = [];
  readonly bodies = {
    owns: (c: Car) => !!this.draws.get(c.id)?.owns,
    pose: (c: Car, a: number, under: RoadPose) => this.bodyPose(c, a, under),
  };

  /** data: a TrafficData of its own (its paths are prepared in place: never the sim's); ground: the page's */
  constructor(data: TrafficData, ground: Ground | null) {
    this.net = new RoadNet(data);
    this.net.ground = ground;
    this.wire = new AgentRead((e) => this.net.roads[e].L);
    const tracks = trainTracks(data.trains ?? []);
    this.trains = { coaches: (back = 0) => coachPoses(tracks, this.trainList, back) };
  }

  get heads() { return this.net.heads; }
  get peds() { return this.net.peds; }
  get ground() { return this.net.ground; }
  carPose: RoadNet['carPose'] = (c, s, off, out) => this.net.carPose(c, s, off, out);
  pathPoint: RoadNet['carPoint'] = (c, s, out, off) => this.net.carPoint(c, s, out, off);
  personPoint: RoadNet['personPoint'] = (p, ds, out) => this.net.personPoint(p, ds, out);
  /** a signal's state now: green, amber, red */
  signal = (ctrl: number, axis: number) => signalAt(this.net.ctrls[ctrl], this.t, axis);
  roadVehicles = (): Car[] => this.detachedCars.length ? [...this.cars, ...this.detachedCars] : this.cars;

  /** snapshot s with all the cars and people held after it, read in the order the session sent them (each one, as it
   * arrives) */
  read(s: Snapshot): Taken {
    const [people, riders] = this.wire.readPeople(s.people, s.riders, s.gone[1], s.tick);
    return { ...s, cars: this.wire.readCars(s.cars, s.gone[0], s.tick), people, riders, trains: this.wire.readTrains(s.trains, s.gone[2], s.tick),
      boats: this.wire.readBoats(s.boats, s.gone[3]), ...this.wire.readHeld(s) };
  }

  /** a new session: what the last one sent of the cars and people forgotten */
  forget() { this.wire.clear(); }

  /** the snapshot's agents in place of the last (one object per id) */
  apply(s: Taken) {
    const T = this;
    T.t = s.t;
    // (a car the session took out of the traffic is a detached one from that tick: the traffic's sample of it is
    // dropped once its gone comes)
    const out = s.detached.length ? new Set(s.detached.map((c) => c.id)) : null;
    const cars = (list: CarState[], into: Car[], seen: Set<number>, skip: Set<number> | null) => {
      into.length = 0;
      for (const st of list) {
        if (skip?.has(st.id)) continue;
        let c = this.carsById.get(st.id);
        if (!c) this.carsById.set(st.id, c = { kind: 'car' } as Car);
        Object.assign(c, st);
        into.push(c);
        seen.add(st.id);
      }
    };
    const seenCars = new Set<number>();
    cars(s.cars, T.cars, seenCars, out);
    cars(s.detached, T.detachedCars, seenCars, null);
    for (const id of this.carsById.keys()) if (!seenCars.has(id)) this.carsById.delete(id);
    resample(this.sampled, s.cars, seenCars);
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
    const W = this.walking;
    W.clear();
    for (const l of [s.people, s.riders]) for (const st of l) W.set(st.id, st);
    this.draws.clear();
    for (const [id, d] of s.bodies) this.draws.set(id, d);
    const trains = new Set<number>(), TB = this.trainsById;
    this.trainList = s.trains.map((st) => {
      let t = TB.get(st.id);
      if (!t) TB.set(st.id, t = { ...st, ds: 0 });
      trains.add(st.id);
      return t;
    });
    for (const id of TB.keys()) if (!trains.has(id)) TB.delete(id);
    resample(this.trainSamples, s.trains, trains);
    this.boats = s.boats;
    this.walked.clear();
    for (const [id, w] of s.walked) this.walked.set(id, w);
    this.avatars = s.avatars;
  }

  /** the cars, people and trains where they are at render time t (ticks, as a snapshot's tick: its state is that at
   * t = tick), each reckoned on along its way from its last sample at the speed sent; a car's or train's correction
   * (where the sample before had it now, less where this one has it) blended out */
  reckon(t: number) {
    for (const tr of this.trainList) {
      const r = this.trainSamples.get(tr.id)!, st = r.st, s = reckon(st.s, st.ds / STEP, st.at, t);
      if (r.old) {
        const o = r.old, es = reckon(o.s, o.ds / STEP, o.at, t) + r.es * left(t, r.from) - s;
        r.es = Math.abs(es) < SNAP ? es : 0;
        r.from = t;
        r.old = null;
      }
      tr.s = s + r.es * left(t, r.from);
    }
    const R = this.sampled, roads = this.net.roads;
    for (const c of this.cars) {
      const r = R.get(c.id);
      if (!r) continue;
      const st = r.st, s = reckon(st.s, st.v, st.at, t);
      if (r.old) {
        const o = r.old, k = left(t, r.from);
        // (the sample before on the road before this one's: its way less that road's length)
        const shift = st.e === o.e ? 0 : st.prev === o.e ? -roads[o.e].L : NaN, es = reckon(o.s, o.v, o.at, t) + r.es * k + shift - s;
        r.es = Math.abs(es) < SNAP ? es : 0;
        r.eo = st.e === o.e ? o.off + r.eo * k - st.off : 0;
        r.from = t;
        r.old = null;
      }
      const k = left(t, r.from);
      c.s = s + r.es * k;
      c.off = st.off + r.eo * k;
    }
    for (const list of [this.people, this.riders]) for (const p of list) {
      const st = this.walking.get(p.id);
      if (!st || st.wait) continue;
      const ds = st.v * (t - st.at) * STEP;
      p.s = st.s + ds * st.dir;
      p.ph = st.ph + ds * (st.bike ? PH_RIDE : PH_WALK);
    }
  }

  /** where avatar a is drawn a (0..1) of the way from its tick before to its tick */
  avatarPose(a: AvatarState, alpha: number, out: Pose): Pose {
    const p = a.prev, q = a.pose, dh = Math.atan2(Math.sin(q.h - p.h), Math.cos(q.h - p.h));
    out.x = p.x + (q.x - p.x) * alpha; out.y = p.y + (q.y - p.y) * alpha; out.z = p.z + (q.z - p.z) * alpha;
    out.h = p.h + dh * alpha;
    return out;
  }

  // as LifePhysics.pose (sim/body-pose.ts drawnBodyPose, the same code): a parked car or a wreck where it is, a body
  // between its last two poses, the fade back onto its path blended out
  private bodyPose(c: Car, a: number, under: RoadPose): RoadPose {
    return drawnBodyPose(this.draws.get(c.id), a, c.detachedPose ?? under, STEP);
  }
}
