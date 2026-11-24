// The server side of a SimClient (sim/sim-client.ts; docs/plans/local-server.md): the world sim, the game mode made
// (sim/mode.ts; by default the sandbox, sim/modes/sandbox.ts) and given to it, the world's edits applied at the start of
// the next update if the mode allows them (mayEdit), and the connections to it: one Session each
// (docs/plans/architecture-review.md F2, A7). Run in the page's thread (LocalSimClient, MirrorSimClient over a
// ThreadLink) or in a Web Worker (sim.worker.ts). No three.js, no DOM (tools/core-deps.mjs).
//   SimServer  the world's: connect(player) a session for a player the host names; update (the edits sent, then the
//              world sim's update); trackEdits (the world's edits go with every session's snapshots)
//   Session    a connection's: its player (the host's, stamped on every command sent through it: a client never names
//              one), and what the connection has read: the events (its last snapshot's tick), the outcomes of its
//              player's commands (each taken once; its edits' its own), the seat events taken (craftEvents,
//              driverNotes), its last seat input taken (ack), the world's edits not yet sent. Two sessions of one
//              player each get everything; leaving the last one of a player frees the player's seat
import { liveEdits } from '../../core/live-edits';
import { apply as applyEdit } from '../../core/world-edits';
import { takeSnapshot } from './snapshot';
import { SeatReads } from '../seat-reads';
import type { CommandResult, SimCommand } from '../contract/commands';
import { EVENT_TICKS, type DriveNote } from '../contract/events';
import type { PlayerId, Role, Seat } from '../contract/ids';
import type { SimInput } from '../contract/inputs';
import type { Ack, DriverSnapshot, EditNote, Snapshot } from '../contract/snapshot';
import type { GameMode } from '../mode';
import { sandbox } from '../modes/sandbox';
import type { WorldSim } from '../world-sim';

type Edit = Extract<SimCommand, { kind: 'edit' }>;

export class SimServer {
  // the edits sent, applied at the start of the next update, with the session each came through
  private queue: { from: Session; cmd: Edit }[] = [];
  private readonly sessions = new Set<Session>();
  // the world's edits go with the snapshots (a client in another thread)
  private tracking = false;

  /** mode: the game's rules (the sim's from now on: WorldSim.mode; null: none, every seat may be taken, every request
   * and edit refused) */
  constructor(readonly sim: WorldSim, mode: GameMode | null = sandbox()) { sim.mode = mode; }

  /** a connection for player (the host names it: a client never does); its commands are the player's */
  connect(player: PlayerId): Session {
    const s = new Session(this, player);
    if (this.tracking) s.edits = [];
    this.sessions.add(s);
    return s;
  }

  /** the session gone (Session.leave); the last of its player: the player leaves their seat and follows nothing */
  disconnect(session: Session) {
    if (!this.sessions.delete(session)) return;
    this.queue = this.queue.filter((q) => q.from !== session);
    for (const s of this.sessions) if (s.player === session.player) return;
    this.sim.send(session.player, { kind: 'leaveSeat' });
    this.sim.send(session.player, { kind: 'follow', entity: null });
  }

  /** the world's edits go with every session's snapshots (a client with live edits of its own: another thread) */
  trackEdits() {
    if (this.tracking) return;
    this.tracking = true;
    for (const s of this.sessions) s.edits ??= [];
    liveEdits.listen((tx, ty, node, region) => { for (const s of this.sessions) s.edits?.push({ tx, ty, node, region }); });
  }

  /** the edits sent applied, then the sim's update (its commands first, then the ticks due after dt s) */
  update(dt: number, input: SimInput) {
    const q = this.queue;
    this.queue = [];
    for (const { from, cmd } of q) this.edit(from, cmd);
    this.sim.update(dt, input);
  }

  /** (Session.send) an edit kept for the next update */
  queueEdit(from: Session, cmd: Edit) { this.queue.push({ from, cmd }); }

  // an edit applied to the world's voxels (core/world-edits.ts) if the mode allows it for the session's player; its
  // outcome the session's once done
  private edit(from: Session, cmd: Edit) {
    const tick = this.sim.tick, ref = cmd.ref ?? 0, mode = this.sim.mode;
    if (!mode?.mayEdit?.(this.sim.modeWorld, from.player, cmd.op)) {
      from.edited({ tick, kind: 'edit', ok: false, ref }, null, new Error('edit not allowed'));
      return;
    }
    applyEdit(cmd.op).then((nodes) => from.edited({ tick, kind: 'edit', ok: nodes.length > 0, ref, nodes }, nodes),
      (e) => from.edited({ tick, kind: 'edit', ok: false, ref }, null, e));
  }
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
  /** an edit's answer, by its ref: the nodes changed (null: it failed) */
  onEdit: ((ref: number, nodes: [number, number][] | null, error?: unknown) => void) | null = null;

  /** (made by SimServer.connect) */
  constructor(readonly server: SimServer, readonly player: PlayerId) {}

  get sim() { return this.server.sim; }

  /** a command, the session's player's: to the world sim (a seat input's ack the session's), an edit kept for the
   * next update. Whatever player a command claims (none on the wire), it is this session's that acts */
  send(cmd: SimCommand) {
    if (cmd.kind === 'edit') { this.server.queueEdit(this, cmd); return; }
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

  /** (SimServer) an edit's outcome, the session's own */
  edited(r: CommandResult, nodes: [number, number][] | null, error?: unknown) {
    this.editOutcomes.push(r);
    this.onEdit?.(r.ref ?? 0, nodes, error);
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
  craftEvents(): unknown[] { return this.reads.take(this.sim.eventLog, this.player, this.seat(), 'craft', this.sim.tick).map((e) => e.e); }

  /** the sim's state for this session after the last update (the events since its last snapshot, its player's
   * outcomes, the edits since the last) */
  snapshot(): Snapshot {
    const since = this.since;
    this.since = this.sim.tick;
    return takeSnapshot(this.sim, this.player, since, this.results(), this.edits?.splice(0) ?? [], this.acked);
  }
}
