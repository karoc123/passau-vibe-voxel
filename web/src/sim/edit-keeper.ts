// Which of the world's edits are kept (docs/adr/0008-server-vision.md: edits live on the server, by presence). An
// edited node (core/live-edits.ts) is kept while some player's focus is within `radius` m of it; once none has been
// for `after` s of world time, it goes back to its files (core/world-edits.ts drop). Nodes that share an op (a crater
// over a node's edge) go together, once all of them may: no half crater is left. The renderer decides nothing here:
// freeing a node it no longer draws keeps the edit (stream.ts).
// Owned and ticked by the world sim (sim/world-sim.ts update, the foci its players' positions), on its clock: the
// same ticks and foci drop the same edits. The rule itself (Presence) is the world sim's for the vehicles players left
// as well (ADR 0008: a parked car, a craft no one pilots), with the same keeping. No three.js, no DOM
// (tools/core-deps.mjs).
import type { WorldOp } from '../core/layers';
import { liveEdits } from '../core/live-edits';
import { drop } from '../core/world-edits';
import { TILE_N } from '../core/tile-data';
import { PRESENCE, type PresenceTuning } from './tuning';
// (for the node tools, which load each module graph apart: this graph's world edits)
export * as worldEdits from '../core/world-edits';


type Foci = readonly { x: number; z: number }[];

/** the presence rule by key: the world time a focus was last near each thing (or it was first seen); its time is up
 * once none has been for `after` s */
export class Presence<K> {
  private readonly seen = new Map<K, number>();

  constructor(readonly keeping: PresenceTuning = PRESENCE) {}

  /** a focus within radius of point (x, z) */
  near(foci: Foci, x: number, z: number) { return foci.some((f) => Math.hypot(f.x - x, f.z - z) <= this.keeping.radius); }

  /** key seen at world time now (s), near or not; true: its time is up (dropped, it is to be forgotten) */
  due(key: K, now: number, near: boolean) {
    const t = this.seen.get(key);
    if (near || t === undefined) { this.seen.set(key, now); return false; }
    return now - t >= this.keeping.after;
  }

  forget(key: K) { this.seen.delete(key); }

  /** the keys not in live forgotten */
  retain(live: ReadonlySet<K>) { for (const k of [...this.seen.keys()]) if (!live.has(k)) this.seen.delete(k); }
}

export class EditKeeper {
  // per edited node ("tx_ty")
  private readonly presence: Presence<string>;
  // the ops kept whoever is near (a blast's crater: for good on a host that keeps its world on disk, else until it restarts)
  private readonly lasting = new WeakSet<WorldOp>();

  constructor(keeping: PresenceTuning = PRESENCE, private readonly N = TILE_N) { this.presence = new Presence(keeping); }

  /** op's nodes kept from now on, near or not */
  last(op: WorldOp) { this.lasting.add(op); }

  /** whether op's nodes are kept near or not (last) */
  lasts(op: WorldOp) { return this.lasting.has(op); }

  // at world time `now` (s), the players' foci (map metres: x east, z south); returns the nodes dropped
  update(now: number, foci: Foci): number {
    const P = this.presence, nodes = [...liveEdits.entries()], keys = nodes.map(([tx, ty]) => `${tx}_${ty}`);
    P.retain(new Set(keys));
    if (!keys.length) return 0;
    const { radius } = P.keeping, N = this.N;
    const near = (tx: number, ty: number) => foci.some(({ x, z }) =>
      Math.hypot(Math.max(tx * N - x, 0, x - (tx + 1) * N), Math.max(ty * N - z, 0, z - (ty + 1) * N)) <= radius);
    // the nodes in groups that share ops (union-find over the ops' objects: an op routed to several nodes is one)
    const up = keys.map((_, i) => i), root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
    const byOp = new Map<WorldOp, number>();
    nodes.forEach(([, , n], i) => {
      for (const op of n.ops ?? []) {
        const j = byOp.get(op);
        if (j === undefined) byOp.set(op, i); else up[root(i)] = root(j);
      }
    });
    const keep = new Set<number>();
    nodes.forEach(([tx, ty, n], i) => {
      if (!P.due(keys[i], now, near(tx, ty)) || n.ops?.some((op) => this.lasting.has(op))) keep.add(root(i));
    });
    let dropped = 0;
    nodes.forEach(([tx, ty], i) => { if (!keep.has(root(i))) { drop(tx, ty); P.forget(keys[i]); dropped++; } });
    return dropped;
  }
}
