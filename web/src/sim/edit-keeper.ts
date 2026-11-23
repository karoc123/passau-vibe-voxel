// Which of the world's edits are kept (docs/adr/0008-server-vision.md: edits live on the server, by presence). An
// edited node (core/live-edits.ts) is kept while some player's focus is within `radius` m of it; once none has been
// for `after` s of world time, it goes back to its files (core/world-edits.ts drop). Nodes that share an op (a crater
// over a node's edge) go together, once all of them may: no half crater is left. The renderer decides nothing here:
// freeing a node it no longer draws keeps the edit (stream.ts).
// Owned and ticked by the world sim (sim/world-sim.ts update, the foci its players' positions), on its clock: the
// same ticks and foci drop the same edits. No three.js, no DOM (tools/core-deps.mjs).
import { frozen } from '../core/frozen';
import type { WorldOp } from '../core/layers';
import { liveEdits } from '../core/live-edits';
import { drop } from '../core/world-edits';
import { TILE_N } from '../tile-data';
// (for the node tools, which load each module graph apart: this graph's world edits)
export * as worldEdits from '../core/world-edits';

// radius: m from a focus to the node's square (map metres) within which it is kept; after: s of world time with no
// focus that near before it is dropped
export interface EditKeeping { readonly radius: number; readonly after: number }
export const EDIT_KEEPING: EditKeeping = frozen({ radius: 600, after: 120 });

export class EditKeeper {
  // per edited node ("tx_ty"): the world time a focus was last near it (or it was first seen)
  private readonly seen = new Map<string, number>();

  constructor(private readonly keeping: EditKeeping = EDIT_KEEPING, private readonly N = TILE_N) {}

  // at world time `now` (s), the players' foci (map metres: x east, z south); returns the nodes dropped
  update(now: number, foci: readonly { x: number; z: number }[]): number {
    if (!liveEdits.size) { this.seen.clear(); return 0; }
    const { radius, after } = this.keeping, N = this.N, nodes = [...liveEdits.entries()];
    const near = (tx: number, ty: number) => foci.some(({ x, z }) =>
      Math.hypot(Math.max(tx * N - x, 0, x - (tx + 1) * N), Math.max(ty * N - z, 0, z - (ty + 1) * N)) <= radius);
    const keys = nodes.map(([tx, ty]) => `${tx}_${ty}`);
    for (const k of [...this.seen.keys()]) if (!keys.includes(k)) this.seen.delete(k);
    nodes.forEach(([tx, ty], i) => { if (near(tx, ty) || !this.seen.has(keys[i])) this.seen.set(keys[i], now); });
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
    keys.forEach((k, i) => { if (now - this.seen.get(k)! < after) keep.add(root(i)); });
    let dropped = 0;
    nodes.forEach(([tx, ty], i) => { if (!keep.has(root(i))) { drop(tx, ty); this.seen.delete(keys[i]); dropped++; } });
    return dropped;
  }
}
