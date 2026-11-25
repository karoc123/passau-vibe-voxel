// The server side of a SimClient (client/sim-client.ts; ADR 0008): the world sim, the game mode made
// (sim/mode.ts; by default the sandbox, sim/modes/sandbox.ts) and given to it, and the connections to it: one Session
// each (docs/adr/0009-layers-and-owners.md). An edit is a player's command like the others, held here until the
// level-1 nodes it touches are in the world's TileCache (EditTiles: core/world-edits.ts ready), then sent on to the
// sim, which applies it in its next tick if the mode allows it (WorldSim.apply, mayEdit). Run in the page's
// thread (MirrorSimClient over a ThreadLink) or in a Web Worker (host/sim.worker.ts). No three.js, no
// DOM (tools/core-deps.mjs).
//   SimServer  the world's: hello (what each session is told first: sim/contract/hello.ts; the protocol, the data build
//              the host loaded, the tuning's hash); connect(player) a session for a player the host names; update (the
//              world sim's update); trackEdits (the world's edits go with every session's snapshots); dispose (its
//              listeners and the host's removed: onDispose)
//   Session    a connection's: its player (the host's, stamped on every command sent through it: a client never names
//              one), and what the connection has read: the events (its last snapshot's tick), the outcomes of its
//              player's commands (each taken once; its edits' its own), the seat events taken (craftEvents,
//              driverNotes), its last seat input taken (ack), the world's edits not yet sent. Two sessions of one
//              player each get everything; leaving the last one of a player frees the player's seat
//              and drops the player from the world sim
import { liveEdits } from '../../core/live-edits';
import { ready, touched, type WorldOp } from '../../core/world-edits';
import type { DataBuild } from '../../core/data-contract';
import { hello } from '../hello';
import type { Hello } from '../contract/hello';
import { takeSnapshot } from './snapshot';
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

  /** what a session is told when it connects (Session.hello): this code's protocol, the build, the sim's tuning */
  readonly hello: Hello;

  /** mode: the game's rules (the sim's from now on: WorldSim.mode; null: none, every seat may be taken, every request
   * and edit refused); build: the data build the host loaded (host/sim-host.ts hostSim: checkBuild; null: none said);
   * tiles: where an edit's nodes are made ready (the world's TileCache) */
  constructor(readonly sim: WorldSim, mode: GameMode | null = sandbox(), build: DataBuild | null = null,
    private readonly tiles: EditTiles = WORLD_TILES) {
    sim.mode = mode;
    this.hello = hello(build, sim.tuning);
  }

  /** a connection for player (the host names it: a client never does); its commands are the player's */
  connect(player: PlayerId): Session {
    const s = new Session(this, player);
    if (this.tracking) s.edits = [];
    this.sessions.add(s);
    return s;
  }

  /** the session gone (Session.leave); the last of its player: the player looks nowhere and is gone from the world
   * sim (WorldSim.leave: their seat left, their entry dropped) */
  disconnect(session: Session) {
    if (!this.sessions.delete(session)) return;
    for (const s of this.sessions) if (s.player === session.player) return;
    this.sim.send(session.player, { kind: 'view', view: null });
    this.sim.leave(session.player);
  }

  /** the world's edits go with every session's snapshots (a client with live edits of its own: another thread) */
  trackEdits() {
    if (this.tracking) return;
    this.tracking = true;
    for (const s of this.sessions) s.edits ??= [];
    this.disposers.push(liveEdits.listen((tx, ty, node, region) => { for (const s of this.sessions) s.edits?.push({ tx, ty, node, region }); }));
  }

  /** the sim's update (the views sent, then the ticks due after dt s, each with the commands due first) */
  update(dt: number) { this.sim.update(dt); }

  /** (Session.send) an edit held until its nodes are in (after the edits sent before it), then sent on to the sim for
   * its next tick; its outcome the session's (Session.edited), its nodes let go once it is applied. One the mode
   * refuses now (WorldSim.mayEdit) holds no nodes: the sim refuses it in its tick, its outcome the same way */
  holdEdit(from: Session, cmd: Edit) {
    let nodes: [number, number][] = [];
    if (this.sim.mayEdit(from.player, cmd.op)) {
      try { nodes = this.tiles.nodes(cmd.op); } catch { /* (no world to edit: the sim refuses or fails it) */ }
    }
    const ready = nodes.length ? this.tiles.ready(nodes).catch(() => () => {}) : Promise.resolve(() => {});
    this.held = this.held.then(() => ready).then((release) => {
      if (!this.sessions.has(from)) { release(); return; }
      this.sim.send(from.player, cmd, (_tick, r) => { release(); if (r) from.edited(r); });
    });
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
  /** the world's edits since the last snapshot, when tracked (SimServer.trackEdits) */
  edits: EditNote[] | null = null;

  /** (made by SimServer.connect) */
  constructor(readonly server: SimServer, readonly player: PlayerId) {}

  get sim() { return this.server.sim; }
  /** what the host tells this connection first (SimServer.hello): its client compares it with its own */
  get hello(): Hello { return this.server.hello; }

  /** a command, the session's player's: to the world sim (a seat input's ack the session's), an edit once its nodes
   * are in (SimServer.holdEdit; its outcome the session's). Whatever player a command claims (none on the wire), it
   * is this session's that acts */
  send(cmd: SimCommand) {
    if (cmd.kind === 'edit') { this.server.holdEdit(this, cmd); return; }
    const seq = cmd.kind === 'seatInput' ? cmd.seq : undefined;
    this.sim.send(this.player, cmd, seq === undefined ? undefined : (tick) => { this.acked = { seq, tick }; });
  }

  /** out: no more commands or reads (SimServer.disconnect) */
  leave() { this.server.disconnect(this); }

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
   * outcomes, the edits since the last) */
  snapshot(): Snapshot {
    const since = this.since;
    this.since = this.sim.tick;
    return takeSnapshot(this.sim, this.player, since, this.results(), this.edits?.splice(0) ?? [], this.acked);
  }
}
