// The level-1 nodes whose columns differ from their files in this viewer now (an edit session: stream.ts
// replaceColumns, ?dig=1), for whatever reads the node files on its own (physics/rapier/terrain.ts,
// nav/voxel-collision.ts): they read a node's columns here before its file, and drop what they built of it when it
// changes. Transient (docs/adr/0001-world-layers.md L2): nothing is kept beyond the page; a node freed by the streamer
// goes back to its file (set(.., null)). Empty unless something edits, so nothing changes by default.
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

// the viewer's (one per page)
export const liveEdits = new LiveEdits();
