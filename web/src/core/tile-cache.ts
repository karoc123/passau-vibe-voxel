// The level-1 nodes' files for whatever reads voxels outside the mesher (nav/voxel-collision.ts, physics/rapier/
// terrain.ts, node tools): each node's tiles/1 and tiles/1f fetched and decoded once while anyone holds it, and seen
// through the live edits (core/live-edits.ts: an edited node's columns in place of its files'). Pure: the bytes come
// from an injected `load` (the viewer: fetch + gunzip; a Node tool: a file reader).
//
// Reference-counted: acquire() a node (its load starts or is shared), release() it when done; a node nobody holds is
// dropped, the last `keep` of them kept (most recently released last) for a reader coming back to it.
import { decodeTile, type Columns, type RawColumns } from '../tile-data';
import type { LiveEdits } from './live-edits';

// a node's tiles/1 columns (with the ground, planes, bld, rooms) and its tiles/1f columns
export interface NodeColumns { base: Columns; foliage: RawColumns }
// ... as seen now: edited (a live edit's base, or foliage, in place of the file's)
export interface NodeView extends NodeColumns { edited: boolean }

export interface TileCacheOptions {
  N: number;
  // a node file's bytes (ungzipped) by its path under data/tiles/ ('1/3_4.bin', '1f/3_4.bin'); rejects if missing
  load: (path: string) => Promise<ArrayBuffer>;
  // the edits to see the files through (none: the files alone)
  edits?: LiveEdits | null;
  // unheld nodes kept (default 0)
  keep?: number;
}

interface Entry { refs: number; files: NodeColumns | null; ready: Promise<NodeColumns> }

export class TileCache {
  readonly N: number;
  readonly edits: LiveEdits | null;
  private readonly load: (path: string) => Promise<ArrayBuffer>;
  private readonly keep: number;
  private readonly entries = new Map<string, Entry>();
  // unheld entries kept, oldest first
  private readonly idle: string[] = [];
  // files fetched and decoded (each node's pair counts once)
  loads = 0;

  constructor(opts: TileCacheOptions) {
    this.N = opts.N;
    this.load = opts.load;
    this.edits = opts.edits ?? null;
    this.keep = opts.keep ?? 0;
  }

  // Holds node (tx, ty): resolves to its view when its files are in (rejects, and holds nothing, if one fails)
  acquire(tx: number, ty: number): Promise<NodeView> {
    const k = `${tx}_${ty}`;
    let e = this.entries.get(k);
    if (e) {
      e.refs++;
      const i = this.idle.indexOf(k);
      if (i >= 0) this.idle.splice(i, 1);
    } else {
      const ready = Promise.all(['1', '1f'].map((s) => this.load(`${s}/${k}.bin`))).then(([b, f]) => {
        this.loads++;
        const files = { base: decodeTile(b, this.N), foliage: decodeTile(f, this.N) };
        if (this.entries.get(k) === entry) entry.files = files;
        return files;
      });
      const entry: Entry = e = { refs: 1, files: null, ready };
      this.entries.set(k, entry);
      // (a failed load is forgotten: the next acquire tries again)
      ready.catch(() => { if (this.entries.get(k) === entry) { this.entries.delete(k); const i = this.idle.indexOf(k); if (i >= 0) this.idle.splice(i, 1); } });
    }
    const held = e;
    return held.ready.then((files) => this.merge(tx, ty, files), (err) => { held.refs = Math.max(0, held.refs - 1); throw err; });
  }

  // Lets go of node (tx, ty) (as many times as it was acquired; more is ignored)
  release(tx: number, ty: number) {
    const k = `${tx}_${ty}`, e = this.entries.get(k);
    if (!e || e.refs <= 0 || --e.refs > 0) return;
    if (this.keep > 0 && e.files) {
      this.idle.push(k);
      while (this.idle.length > this.keep) this.entries.delete(this.idle.shift()!);
    } else this.entries.delete(k);
  }

  // Node (tx, ty) as seen now, if that needs no load: its files are in (held or kept), or a live edit gives both its
  // base and foliage; else null
  view(tx: number, ty: number): NodeView | null {
    const files = this.entries.get(`${tx}_${ty}`)?.files;
    if (files) return this.merge(tx, ty, files);
    const live = this.edits?.get(tx, ty);
    return live?.foliage ? { base: live.base, foliage: live.foliage, edited: true } : null;
  }

  // the nodes held or kept
  get size() { return this.entries.size; }

  private merge(tx: number, ty: number, files: NodeColumns): NodeView {
    const live = this.edits?.get(tx, ty);
    if (!live) return { ...files, edited: false };
    return { base: live.base, foliage: live.foliage ?? files.foliage, edited: true };
  }
}
