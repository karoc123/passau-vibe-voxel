// The server side of a SimClient (sim/sim-client.ts; docs/plans/local-server.md): the players' commands handed to the
// world sim (WorldSim.send: queued there and applied in the order sent at the start of its next tick; ADR 0007), the
// game mode made (sim/mode.ts; by default the sandbox, sim/modes/sandbox.ts) and given to the sim, the world's edits
// applied at the start of the next update if the mode allows them (mayEdit), their outcomes kept per player, and a
// snapshot per player after an update (sim/snapshot.ts). Run in the page's thread (LocalSimClient, MirrorSimClient over
// a ThreadLink) or in a Web Worker (sim.worker.ts). No three.js, no DOM (tools/core-deps.mjs).
import { liveEdits } from '../core/live-edits';
import { apply as applyEdit } from '../core/world-edits';
import { takeSnapshot, type EditNote, type Snapshot } from './snapshot';
import type { CommandResult } from './commands';
import type { GameMode } from './mode';
import { sandbox } from './modes/sandbox';
import type { Role } from './entities';
import type { SimCommand } from './sim-client';
import type { PlayerId, SimInput, WorldSim } from './world-sim';

export class SimServer {
  // the edits sent, applied at the start of the next update; their outcomes, by player
  private queue: Extract<SimCommand, { kind: 'edit' }>[] = [];
  private readonly outcomes = new Map<PlayerId, CommandResult[]>();
  // per player: the tick of their last snapshot (its events are those after it)
  private readonly since = new Map<PlayerId, number>();
  // the world's edits since the last snapshot, when tracked (a client in another thread)
  private edits: EditNote[] | null = null;
  /** an edit's answer, by its ref: the nodes changed (null: it failed) */
  onEdit: ((ref: number, nodes: [number, number][] | null, error?: unknown) => void) | null = null;

  /** mode: the game's rules (the sim's from now on: WorldSim.mode) */
  constructor(readonly sim: WorldSim, mode: GameMode = sandbox()) { sim.mode = mode; }

  /** the world's edits go with the snapshots (a client with live edits of its own: another thread) */
  trackEdits() {
    if (this.edits) return;
    this.edits = [];
    liveEdits.listen((tx, ty, node, region) => this.edits!.push({ tx, ty, node, region }));
  }

  /** a command: a player's to the world sim, an edit kept for the next update */
  send(cmd: SimCommand) {
    if (cmd.kind === 'edit') this.queue.push(cmd); else this.sim.send(cmd);
  }

  /** the edits sent applied, then the sim's update (its commands first, then the ticks due after dt s) */
  update(dt: number, input: SimInput) {
    const q = this.queue;
    this.queue = [];
    for (const cmd of q) this.edit(cmd);
    this.sim.update(dt, input);
  }

  /** the player's command outcomes since the last call (of kind, and of a seat's role; all without), oldest first:
   * the sim's, then the edits' */
  results(player: PlayerId, kind?: CommandResult['kind'], role?: Role) {
    const mine = this.sim.results(player, kind, role), r = this.outcomes.get(player);
    if (!r?.length) return mine;
    const edits = (kind && kind !== 'edit') || role ? [] : r;
    if (edits.length) this.outcomes.set(player, []);
    return mine.concat(edits);
  }

  /** the sim's state for player after the last update (their events, outcomes, the edits since the last) */
  snapshot(player: PlayerId): Snapshot {
    const since = this.since.get(player) ?? -1;
    this.since.set(player, this.sim.tick);
    return takeSnapshot(this.sim, player, since, this.results(player), this.edits?.splice(0) ?? []);
  }

  private result(cmd: Extract<SimCommand, { kind: 'edit' }>, ok: boolean, tick: number, more: Partial<CommandResult> = {}) {
    const r = this.outcomes.get(cmd.player), out = { tick, kind: cmd.kind, ok, ...more };
    if (r) r.push(out); else this.outcomes.set(cmd.player, [out]);
  }

  // an edit applied to the world's voxels (core/world-edits.ts) if the mode allows it; its outcome once done
  private edit(cmd: Extract<SimCommand, { kind: 'edit' }>) {
    const tick = this.sim.tick, ref = cmd.ref ?? 0, mode = this.sim.mode;
    if (!mode?.mayEdit?.(this.sim.modeWorld, cmd.player, cmd.op)) {
      this.result(cmd, false, tick, { ref });
      this.onEdit?.(ref, null, new Error('edit not allowed'));
      return;
    }
    applyEdit(cmd.op).then((nodes) => { this.result(cmd, nodes.length > 0, tick, { ref, nodes }); this.onEdit?.(ref, nodes); },
      (e) => { this.result(cmd, false, tick, { ref }); this.onEdit?.(ref, null, e); });
  }
}
