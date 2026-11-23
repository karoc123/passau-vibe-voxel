// The server side of a SimClient (sim/sim-client.ts; docs/plans/local-server.md): the players' commands queued and
// applied in the order sent at the start of the next update, before its ticks (ADR 0007), their outcomes kept per
// player, and a snapshot per player after an update (sim/snapshot.ts). Run in the page's thread (LocalSimClient,
// MirrorSimClient over a ThreadLink) or in a Web Worker (sim.worker.ts). No three.js, no DOM (tools/core-deps.mjs).
import { liveEdits } from '../core/live-edits';
import { apply as applyEdit } from '../core/world-edits';
import { takeSnapshot, type EditNote, type Snapshot } from './snapshot';
import type { CommandResult, SimCommand } from './sim-client';
import type { PlayerId, SimInput, WorldSim } from './world-sim';

export class SimServer {
  private queue: SimCommand[] = [];
  private readonly outcomes = new Map<PlayerId, CommandResult[]>();
  // per player: the tick of their last snapshot (its events are those after it)
  private readonly since = new Map<PlayerId, number>();
  // the world's edits since the last snapshot, when tracked (a client in another thread)
  private edits: EditNote[] | null = null;
  /** an edit's answer, by its ref: the nodes changed (null: it failed) */
  onEdit: ((ref: number, nodes: [number, number][] | null, error?: unknown) => void) | null = null;

  constructor(readonly sim: WorldSim) {}

  /** the world's edits go with the snapshots (a client with live edits of its own: another thread) */
  trackEdits() {
    if (this.edits) return;
    this.edits = [];
    liveEdits.listen((tx, ty, node, region) => this.edits!.push({ tx, ty, node, region }));
  }

  send(cmd: SimCommand) { this.queue.push(cmd); }

  /** the commands sent applied, then the ticks due after dt s */
  update(dt: number, input: SimInput) {
    this.flush();
    this.sim.update(dt, input);
  }

  /** the commands sent so far applied, in order */
  flush() {
    const q = this.queue;
    this.queue = [];
    for (const cmd of q) this.apply(cmd);
  }

  /** the player's command outcomes since the last call (of kind; all without), oldest first */
  results(player: PlayerId, kind?: SimCommand['kind']) {
    const r = this.outcomes.get(player);
    if (!r?.length) return [];
    const mine = kind ? r.filter((o) => o.kind === kind) : r;
    if (mine.length) this.outcomes.set(player, kind ? r.filter((o) => o.kind !== kind) : []);
    return mine;
  }

  /** the sim's state for player after the last update (their events, outcomes, the edits since the last) */
  snapshot(player: PlayerId): Snapshot {
    const since = this.since.get(player) ?? -1;
    this.since.set(player, this.sim.tick);
    return takeSnapshot(this.sim, player, since, this.results(player), this.edits?.splice(0) ?? []);
  }

  private result(cmd: SimCommand, ok: boolean, tick = this.sim.tick, more: Partial<CommandResult> = {}) {
    const r = this.outcomes.get(cmd.player), out = { tick, kind: cmd.kind, ok, ...more };
    if (r) r.push(out); else this.outcomes.set(cmd.player, [out]);
  }

  private apply(cmd: SimCommand) {
    const S = this.sim, p = cmd.player;
    switch (cmd.kind) {
      case 'follow': S.follow(p, cmd.entity); break;
      case 'walkAs': this.result(cmd, S.walkAs(p, cmd.person, cmd.pose)); break;
      case 'walkPose': S.walkPose(p, cmd.pose); break;
      case 'release': S.release(p); break;
      case 'takeWheel': S.takeWheel(p, cmd.car, cmd.choice); break;
      case 'drive': S.input(p, cmd.input); break;
      case 'releaseWheel': S.releaseWheel(p); break;
      case 'resetDriver': S.resetDriver(p); break;
      case 'spawnCraft': {
        let ok = false;
        try {
          const c = S.addCraft(cmd.type);
          ok = S.enterCraft(p, c.id);
          if (ok) S.placeCraft(c.id, cmd.spot); else S.removeCraft(c.id);
        } catch (e) { console.warn('spawnCraft', e); }
        this.result(cmd, ok);
        break;
      }
      case 'placeCraft': {
        const c = S.craftOf(p);
        if (c) S.placeCraft(c.id, cmd.spot);
        this.result(cmd, !!c);
        break;
      }
      case 'craftInput': S.craftInput(p, cmd.input); break;
      case 'resetCraft': this.result(cmd, S.resetCraft(p)); break;
      case 'dropCraft': { const c = S.craftOf(p); if (c) S.removeCraft(c.id); break; }
      case 'edit': {
        const tick = S.tick, ref = cmd.ref ?? 0;
        applyEdit(cmd.op).then((nodes) => { this.result(cmd, nodes.length > 0, tick, { ref, nodes }); this.onEdit?.(ref, nodes); },
          (e) => { this.result(cmd, false, tick, { ref }); this.onEdit?.(ref, null, e); });
        break;
      }
    }
  }
}
