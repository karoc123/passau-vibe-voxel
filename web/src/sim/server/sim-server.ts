// The server side of a SimClient (client/sim-client.ts; ADR 0008): the world sim, the game mode made
// (sim/mode.ts; by default the sandbox, sim/modes/sandbox.ts) and given to it, and the connections to it: one Session
// each (docs/adr/0009-layers-and-owners.md). An edit is a player's command like the others, held here until the
// level-1 nodes it touches are in the world's TileCache (EditTiles: core/world-edits.ts ready), then sent on to the
// sim, which applies it in its next tick if the mode allows it (WorldSim.apply, mayEdit). Run in a Web Worker on its
// own clock, or by a Node tool. No three.js, no DOM (tools/core-deps.mjs).
//   SimServer  the world's: hello (what each session is told first: sim/contract/hello.ts; the protocol, the data build
//              the host loaded, the tuning a page runs with); connect(player) a session for a player the host names (or a new id); update (the
//              world sim's update); trackEdits (the world's edits go with every session's snapshots); dispose (its
//              listeners and the host's removed: onDispose)
//   Session    a connection's: its player (the host's, stamped on every command sent through it: a client never names
//              one), and what the connection has read: the events (its last snapshot's tick), the outcomes of its
//              player's commands (each taken once; its edits' its own), the seat events taken (craftEvents,
//              driverNotes), its seat inputs held for their ticks (InputBuffer) and the last taken (ack), the world's
//              edits' ops it was sent (EditFeed), what it was sent
//              (its sight: what is near its player). Two sessions of one
//              player each get everything; leaving the last one of a player frees the player's seat
//              and drops the player from the world sim, unless the host holds the player for their coming back
//              (leave(true): seat, name and view kept, hands off; connect(player) takes them up again, free lets go)
import { liveEdits } from '../../core/live-edits';
import { nodeMetres, ready, touched, type WorldOp } from '../../core/world-edits';
import type { DataBuild } from '../../core/data-contract';
import { hello } from '../hello';
import { cleanName } from '../player-name';
import type { Hello } from '../contract/hello';
import { takeSnapshot } from './snapshot';
import { radii, Sight, type Radii } from './interest';
import { AgentWire } from '../agent-wire';
import { SeatReads } from '../seat-reads';
import type { CommandResult, SimCommand } from '../contract/commands';
import type { CraftEventOf } from '../contract/crafts';
import { EVENT_TICKS, type DriveNote } from '../contract/events';
import type { PlayerId, Role, Seat } from '../contract/ids';
import type { Ack, DriverSnapshot, EditNote, Snapshot } from '../contract/snapshot';
import type { GameMode } from '../mode';
import { sandbox } from '../modes/sandbox';
import type { WorldSim } from '../world-sim';

type Edit = Extract<SimCommand, { kind: 'edit' }>;
type SeatInputCmd = Extract<SimCommand, { kind: 'seatInput' }>;

/** the host's tiles for the edits (the port; by default the world's, core/world-edits.ts touched, ready): the level-1
 * nodes an op touches (throws: none known), and those nodes held in the world's TileCache, resolved once each is in
 * or has failed, to their release */
export interface EditTiles {
  nodes(op: WorldOp): [number, number][];
  ready(nodes: readonly [number, number][]): Promise<() => void>;
}
const WORLD_TILES: EditTiles = { nodes: touched, ready };

export class SimServer {
  private readonly sessions = new Set<Session>();
  // the world's edits go with the snapshots (a client in another thread)
  private tracking = false;
  // the edits held until their nodes are in, in the order sent: each sent on to the sim after the one before
  private held: Promise<unknown> = Promise.resolve();
  // what dispose undoes (the listeners added)
  private readonly disposers: (() => void)[] = [];
  // the player ids connect has made
  private players = 0;
  // the names the players chose; changed counts their changes (a session sends them all again when it differs)
  private readonly names = new Map<PlayerId, string>();
  private changed = 0;
  // the players whose last session dropped while the host holds them for their coming back (Session.leave(true))
  private readonly away = new Set<PlayerId>();

  /** the radii (m) round its player a session is sent the world's things in, by kind (sim/server/interest.ts Sight;
   * one number: that for all; null: all of them), for the sessions connected after it is set */
  interest: Radii | number | null = null;

  /** what a session is told when it connects (Session.hello): this code's protocol, the build, the sim's tuning */
  readonly hello: Hello;

  /** mode: the game's rules (the sim's from now on: WorldSim.mode; null: none, every seat may be taken, every request
   * and edit refused); build: the data build the host loaded (host/sim-host.ts hostSim: checkBuild; null: none said);
   * tiles: where an edit's nodes are made ready (the world's TileCache) */
  constructor(readonly sim: WorldSim, mode: GameMode | null = sandbox(), build: DataBuild | null = null,
    private readonly tiles: EditTiles = WORLD_TILES) {
    sim.mode = mode;
    this.hello = hello(build, sim.tuning);
    sim.beforeTick = (tick) => { for (const s of this.sessions) s.due(tick); };
    this.disposers.push(() => { sim.beforeTick = null; });
  }

  /** a connection for player (the host names it: a client never does; without, a new id no session holds: p1, p2,
   * ...); its commands are the player's, its client learns it from its snapshots (Snapshot player) */
  connect(player: PlayerId = this.newPlayer()): Session {
    this.away.delete(player);
    const s = new Session(this, player);
    // (one joining late is sent the ops of the edited nodes near it: the craters made before it came)
    if (this.tracking) s.edits = new EditFeed();
    this.sessions.add(s);
    return s;
  }

  private newPlayer(): PlayerId {
    const held = new Set([...this.sessions].map((s) => s.player).concat([...this.away]));
    let id: PlayerId;
    do id = `p${++this.players}`; while (held.has(id));
    return id;
  }

  /** the session gone (Session.leave); the last of its player: the player looks nowhere and is gone from the world
   * sim (WorldSim.leave: their seat left, their entry dropped); hold: kept instead, hands off (WorldSim.handsOff),
   * until connect takes them up again or free lets them go. Their view stays a presence, so the street round the seat
   * they come back to is the one they left */
  disconnect(session: Session, hold = false) {
    if (!this.sessions.delete(session)) return;
    const p = session.player;
    for (const s of this.sessions) if (s.player === p) return;
    if (hold) { this.away.add(p); this.sim.handsOff(p); return; }
    this.drop(p);
  }

  /** whether player is held for their coming back (disconnect with hold), no session of theirs connected */
  isAway(player: PlayerId) { return this.away.has(player); }

  /** a player held for their coming back let go: their seat freed, gone from the world sim (nothing if not held) */
  free(player: PlayerId) { if (this.away.delete(player)) this.drop(player); }

  private drop(player: PlayerId) {
    this.sim.send(player, { kind: 'view', view: null });
    this.sim.leave(player);
    if (this.names.delete(player)) this.changed++;
  }

  /** (Session.send) player's name, cleaned here: a page of other code sends anything */
  setName(player: PlayerId, name: unknown) {
    const n = cleanName(name);
    if ((this.names.get(player) ?? '') === n) return;
    if (n) this.names.set(player, n); else this.names.delete(player);
    this.changed++;
  }

  /** the players' names, when they changed since a session's (seen: the count it last took; null: unchanged) */
  namesSince(seen: number): { names: [PlayerId, string][]; seen: number } | null {
    return seen === this.changed ? null : { names: [...this.names], seen: this.changed };
  }

  /** the world's edits go with every session's snapshots (a client with live edits of its own: another thread) */
  trackEdits() {
    if (this.tracking) return;
    this.tracking = true;
    for (const s of this.sessions) s.edits ??= new EditFeed();
    this.disposers.push(liveEdits.listen((tx, ty, node) => { if (!node) for (const s of this.sessions) s.edits?.dropped(tx, ty); }));
  }

  /** the sim's update (the views sent, then the ticks due after dt s, each with the commands due first); the blasts'
   * craters held as the edits are, then applied by the sim */
  update(dt: number) {
    this.sim.update(dt);
    for (const { player, op } of this.sim.takeDamage()) this.hold(op, (release) => this.sim.damage(player, op, release));
  }

  // after the edits and craters held before: op's nodes held in the world's TileCache, then handed their release
  private hold(op: WorldOp, then: (release: () => void) => void) {
    let nodes: [number, number][] = [];
    try { nodes = this.tiles.nodes(op); } catch { /* (no world to edit: the sim refuses or fails it) */ }
    const ready = nodes.length ? this.tiles.ready(nodes).catch(() => () => {}) : Promise.resolve(() => {});
    this.held = this.held.then(() => ready).then(then);
  }

  /** (Session.send) an edit held until its nodes are in (after the edits sent before it), then sent on to the sim for
   * its next tick; its outcome the session's (Session.edited), its nodes let go once it is applied. One the mode
   * refuses now (WorldSim.mayEdit) holds no nodes: the sim refuses it in its tick, its outcome the same way */
  holdEdit(from: Session, cmd: Edit) {
    const send = (release: () => void) => {
      if (!this.sessions.has(from)) { release(); return; }
      this.sim.send(from.player, cmd, (_tick, r) => { release(); if (r) { for (const [tx, ty] of r.nodes ?? []) from.edits?.mine.add(`${tx}_${ty}`); from.edited(r); } });
    };
    if (this.sim.mayEdit(from.player, cmd.op)) this.hold(cmd.op, send);
    else this.held = this.held.then(() => send(() => {}));
  }

  /** f done on dispose (the host's listeners on the world) */
  onDispose(f: () => void) { this.disposers.push(f); }

  /** the server's listeners and those given to onDispose removed (a host done with its world: a tool starting several) */
  dispose() { for (const f of this.disposers.splice(0)) f(); }
}

/** one connection to a SimServer (SimServer.connect): its player, and what it has read */
export class Session {
  // the tick of the last snapshot (its events are those after it; none yet: the world's whole log); the tick the
  // player's outcomes are read up to
  private since = -1;
  private read = -1;
  // the player's outcomes read from the sim, the session's edits' outcomes: not yet taken (results)
  private outcomes: CommandResult[] = [];
  private editOutcomes: CommandResult[] = [];
  // the seat events taken (craftEvents, driverNotes)
  private readonly reads = new SeatReads();
  private acked: Ack | null = null;
  private readonly inputs = new InputBuffer();
  private readonly sight: Sight | null;
  // what it was sent of the traffic's cars and people (a snapshot carries what changed since)
  private readonly wire = new AgentWire();
  /** the world's edits it was sent, when tracked (SimServer.trackEdits) */
  edits: EditFeed | null = null;
  // the server's names count this session's snapshots carried (none yet: a joiner is sent them whatever they are)
  private namesSeen = -1;

  /** (made by SimServer.connect) */
  constructor(readonly server: SimServer, readonly player: PlayerId) {
    const r = server.interest;
    this.sight = r ? new Sight(typeof r === 'number' ? radii(r, r) : r) : null;
  }

  get sim() { return this.server.sim; }
  /** what the host tells this connection first (SimServer.hello): its client compares it with its own */
  get hello(): Hello { return this.server.hello; }

  /** a command, the session's player's: to the world sim (a seat input's ack the session's; a driver's or pilot's
   * stamped with its page tick held for the host's tick that falls on: InputBuffer), an edit once its nodes are in
   * (SimServer.holdEdit; its outcome the session's). Whatever player a command claims (none on the wire), it is this
   * session's that acts */
  send(cmd: SimCommand) {
    if (cmd.kind === 'edit') { this.server.holdEdit(this, cmd); return; }
    if (cmd.kind === 'name') { this.server.setName(this.player, cmd.name); return; }
    // (a walker's pose is where the page has them, not a control to integrate: held, it would only come later)
    if (cmd.kind === 'seatInput' && cmd.role !== 'walker' && cmd.seq !== undefined && Number.isInteger(cmd.tick)) {
      this.inputs.add(cmd, this.sim.tick + 1);
      return;
    }
    this.take(cmd);
  }

  private take(cmd: SimCommand) {
    const seq = cmd.kind === 'seatInput' ? cmd.seq : undefined;
    this.sim.send(this.player, cmd, seq === undefined ? undefined : (tick) => { this.acked = { seq, tick }; });
  }

  /** (SimServer, at the start of tick, before its commands) the seat input held for tick sent on */
  due(tick: number) {
    const c = this.inputs.due(tick);
    if (c) this.take(c);
  }

  /** the page hidden (ToWorker away): hands off, as a held player (WorldSim.handsOff), and its inputs held for the
   * ticks to come dropped, else one due after would take up the key it held again */
  handsOff() {
    this.inputs.clear();
    this.sim.handsOff(this.player);
  }

  /** out: no more commands or reads (SimServer.disconnect; hold: the player kept for their coming back) */
  leave(hold = false) { this.server.disconnect(this, hold); }

  /** the player's command outcomes since this session last took them (of kind, and of a seat's role; all without),
   * oldest first: the sim's, then the session's edits'. Kept EVENT_TICKS ticks, as the events */
  results(kind?: CommandResult['kind'], role?: Role): CommandResult[] {
    const sim = this.sim, old = sim.tick - EVENT_TICKS;
    // (unread ones older than the log's window dropped, as the log drops them)
    let O = this.outcomes;
    if (O.length && O[0].tick < old) O = O.filter((o) => o.tick >= old);
    O = O.concat(sim.resultsSince(this.player, this.read));
    this.read = sim.tick;
    const of = (o: CommandResult) => (!kind || o.kind === kind) && (!role || o.role === role);
    const mine = O.filter(of);
    this.outcomes = mine.length ? O.filter((o) => !of(o)) : O;
    if ((kind && kind !== 'edit') || role || !this.editOutcomes.length) return mine;
    const edits = this.editOutcomes;
    this.editOutcomes = [];
    return mine.concat(edits);
  }

  /** (SimServer) an edit's outcome, the session's own (its nodes: none, it was not made: refused by the mode, or no
   * world to edit) */
  edited(r: CommandResult) {
    this.editOutcomes.push(r);
  }

  /** the last seat input sent through this session that the player's seat took (seq, the tick it was applied in) */
  ack(): Ack | null { return this.acked; }
  /** the seat the player holds, or null */
  seat(): Seat | null { return this.sim.seat(this.player); }
  /** the player's car, or null while they drive none */
  driver(): DriverSnapshot | null { return this.sim.driverSnapshot(this.player); }
  /** what the player driving is to be told since this session last asked (the drive events of their car since they took it) */
  driverNotes(): DriveNote[] { return this.reads.take(this.sim.eventLog, this.player, this.seat(), 'drive', this.sim.tick).map((e) => e.note); }
  /** what happened to the player's craft since this session last asked (its craft events since they took it), oldest first */
  craftEvents(): CraftEventOf[] { return this.reads.crafts(this.sim.eventLog, this.player, this.seat(), this.sim.tick); }

  /** the sim's state for this session after the last update (the events since its last snapshot, its player's
   * outcomes, the edits since the last). Each one taken must reach the session's client: its cars and people are
   * what changed since the one before */
  snapshot(): Snapshot {
    const since = this.since;
    this.since = this.sim.tick;
    const s = takeSnapshot(this.sim, this.player, since, this.results(), [], this.acked, this.sight, this.wire);
    const S = this.sight;
    if (this.edits) s.edits = this.edits.take(S?.somewhere ? (x, z, d) => S.near(x, z, S.r.other + d) : null);
    const n = this.server.namesSince(this.namesSeen);
    if (n) { s.names = n.names; this.namesSeen = n.seen; }
    return s;
  }
}

// the ticks the latest arrival is watched over before the buffer is shortened (a second); the most inputs held
const SHORTEN_TICKS = 30, HOLD_MAX = 120;

/** a session's driver's or pilot's inputs held for the host tick each is meant for: its page tick + lead, lead being
 * how far the host's ticks run ahead of the page's at the latest arrival. So each tick takes its own input whatever
 * the network bunched: one that arrives after its tick moves the timeline (lead raised: it and those after on time);
 * a tick none is held for keeps the last (the seat holds it); several for one tick, the newest. Arriving early by two
 * ticks or more for a whole second, the lead is shortened by half that (some page ticks' inputs folded into one), so
 * one spike's delay does not stay */
class InputBuffer {
  private held: { p: number; cmd: SeatInputCmd }[] = [];
  private lead: number | null = null;
  // the latest arrival this second (the largest next tick - page tick seen), the page tick last taken
  private latest = -Infinity;
  private taken = -Infinity;

  /** cmd (stamped with its page tick) arrived before the host's tick next */
  add(cmd: SeatInputCmd, next: number) {
    const p = cmd.tick!, a = next - p;
    this.latest = Math.max(this.latest, a);
    if (this.lead === null || a > this.lead) this.lead = a;
    // (one for a page tick before the one last taken comes too late; one for that same tick, after it, is taken in
    // the next tick: the page stepped that tick again with it)
    if (p < this.taken) return;
    const H = this.held;
    let i = H.length;
    while (i > 0 && H[i - 1].p > p) i--;
    if (i > 0 && H[i - 1].p === p) H[i - 1] = { p, cmd };
    else H.splice(i, 0, { p, cmd });
    if (H.length > HOLD_MAX) H.shift();
  }

  clear() { this.held = []; }

  /** the input for the host's tick (the newest held for its page tick or before), or null: the last one stays */
  due(tick: number): SeatInputCmd | null {
    if (this.lead === null) return null;
    if (tick % SHORTEN_TICKS === 0) {
      const early = this.lead - this.latest;
      if (early >= 2 && Number.isFinite(early)) this.lead -= Math.floor(early / 2);
      this.latest = -Infinity;
    }
    const H = this.held, p = tick - this.lead;
    let out: { p: number; cmd: SeatInputCmd } | null = null;
    while (H.length && H[0].p <= p) out = H.shift()!;
    if (!out) return null;
    this.taken = out.p;
    return out.cmd;
  }
}

/** what a session was sent of the world's edits: each edited node's ops, the new ones each snapshot, once it is near
 * the player (an op is ~70 bytes where the node's columns are ~1 MB; the client applies them over its own files) */
export class EditFeed {
  // the ops sent by node ("tx_ty"); the nodes given their files again since (sent as such, then from their first op)
  private readonly sent = new Map<string, number>();
  private readonly reset = new Set<string>();
  /** the nodes the session's own edits changed: sent wherever the player is (a dig at the far end of the view) */
  readonly mine = new Set<string>();

  dropped(tx: number, ty: number) { if (this.sent.has(`${tx}_${ty}`)) this.reset.add(`${tx}_${ty}`); }

  /** the notes since the last call; near(x, z, d): whether map point (x, z) is within the sight's radius + d of the
   * player (null: everything is near). A node once sent stays sent, near or not: its ops after must follow */
  take(near: ((x: number, z: number, d: number) => boolean) | null): EditNote[] {
    const out: EditNote[] = [];
    for (const k of this.reset) {
      const [tx, ty] = k.split('_').map(Number);
      out.push({ tx, ty, from: 0, ops: null });
      this.sent.delete(k);
    }
    this.reset.clear();
    // (no node edited: no world to edit perhaps)
    const N = liveEdits.size ? nodeMetres() : 0;
    for (const [tx, ty, node] of liveEdits.entries()) {
      const k = `${tx}_${ty}`, n = this.sent.get(k) ?? 0, ops = node.ops ?? [];
      if (ops.length <= n) continue;
      if (!n && near && !this.mine.has(k) && !near((tx + 0.5) * N, (ty + 0.5) * N, N * Math.SQRT1_2)) continue;
      out.push({ tx, ty, from: n, ops: ops.slice(n) });
      this.sent.set(k, ops.length);
    }
    return out;
  }
}
