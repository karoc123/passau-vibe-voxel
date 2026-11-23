// The world's edited level-1 nodes: those whose columns differ from their files now (core/world-edits.ts writes them:
// apply, drop), for whatever draws or collides with the world: the viewer's streamer (stream.ts onLive) and whatever
// reads the node files on its own (physics/rapier/terrain.ts, sim/craft/voxel-collision.ts) read a node's columns here
// before its file, and drop what they built of it when it changes. Transient (docs/adr/0001-world-layers.md L2):
// nothing is kept beyond the process. Empty unless something edits, so nothing changes by default. One world per
// process (docs/adr/0008-server-vision.md): the module's liveEdits.
import type { Columns, RawColumns } from '../tile-data';
import type { WorldOp } from './layers';

// base: the node's tiles/1 columns (with the ground); foliage: its tiles/1f columns, null: as in the file; ops: the
// edits that made them from the files, in order (core/world-edits.ts: its L2 delta, docs/adr/0001-world-layers.md)
export interface LiveNode { base: Columns; foliage: (RawColumns & { ground?: Uint8Array }) | null; ops?: readonly WorldOp[] }
// the box changed, in map metres [x0, y0, x1, y1) (null: anywhere in the node)
export type Region = [number, number, number, number] | null;
type Listener = (tx: number, ty: number, node: LiveNode | null, region: Region) => void;

export class LiveEdits {
  private readonly nodes = new Map<string, LiveNode>();
  private readonly listeners = new Set<Listener>();

  get(tx: number, ty: number) { return this.nodes.get(`${tx}_${ty}`); }

  get size() { return this.nodes.size; }

  // the edited nodes: [tx, ty, node]
  *entries(): IterableIterator<[number, number, LiveNode]> {
    for (const [k, n] of this.nodes) { const [tx, ty] = k.split('_').map(Number); yield [tx, ty, n]; }
  }

  // node (tx, ty) holds these columns now (null: its files again)
  set(tx: number, ty: number, node: LiveNode | null, region: Region = null) {
    const k = `${tx}_${ty}`;
    if (!node && !this.nodes.has(k)) return;
    if (node) this.nodes.set(k, node); else this.nodes.delete(k);
    for (const l of this.listeners) l(tx, ty, node, node ? region : null);
  }

  // returns the unsubscribe
  listen(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
}

// the world's (one per process)
export const liveEdits = new LiveEdits();
