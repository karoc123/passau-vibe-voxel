// The world's edits (docs/adr/0001-world-layers.md, 0008-server-vision.md): the one way to change the world's voxels.
// apply(op) reads each level-1 node the op touches (core/columns.ts touchedNodes: the margins too) through the world's
// TileCache, as it is now (its files, or its live edit), applies the op to its base columns and, where the op carves
// (air), to its foliage's (EditableNode), and puts the result into the live edits (core/live-edits.ts) with the op
// appended to the node's ops. Whatever draws or collides with the world listens there: the viewer's streamer meshes
// the node again (stream.ts), the physics drop what they built of it (physics/rapier/terrain.ts), the world sim hears
// of the box (main.ts). drop(tx, ty) gives a node its files again. Who keeps an edit and for how long is not decided
// here (sim/edit-keeper.ts).
// One world per process (ADR 0008): the live edits are the module's (liveEdits), the TileCache the one given to
// initWorldEdits (the viewer: viewer-tiles.ts; a tool: its own over the files on disk).
// Later (not built): an edit that expires (damage for a while) or lasts (a built house, ADR 0001 L1) is an op kept
// apart from the others; a node is then made again from its files and the ops left (core/layers.ts effectiveColumns,
// over the TileCache's files), instead of op upon op as here.
// Pure data: no three.js, no DOM.
import { EditableNode, opBounds, touchedNodes, type NodeColumns } from './columns';
import { toCellOp, type Frame, type WorldOp } from './layers';
import { liveEdits, type LiveNode, type Region } from './live-edits';
import type { TileCache } from './tile-cache';

export type { WorldOp };

// the world's tiles: its level-1 nodes' files (seen through liveEdits), its frame (core/layers.ts frameOf: what turns
// an op into map cells), and its nodes (meta.json tiles.levels[0] nx, ny)
export interface EditWorld { cache: TileCache; frame: Frame; nx: number; ny: number }

let world: EditWorld | null = null;
// the edits in the order they were made (each reads the nodes as the one before left them)
let queue: Promise<unknown> = Promise.resolve();

export function initWorldEdits(w: EditWorld) {
  if (w.cache.edits !== liveEdits) throw new Error('world-edits: the TileCache must see the world\'s live edits');
  if (w.cache.N !== w.frame.N) throw new Error(`world-edits: a TileCache of ${w.cache.N}, nodes of ${w.frame.N}`);
  world = w;
}

// the box an op may change, in map metres [x0, y0, x1, y1)
export function opRegion(f: Frame, op: WorldOp): [number, number, number, number] {
  const b = opBounds(toCellOp(f, op));
  return [b.x0, b.y0, b.x1, b.y1];
}

// Applies op to the world (after the edits before it); region: the box it changed, for the listeners (default: the
// op's, opRegion). Resolves to the level-1 nodes changed (a node whose files cannot be read is left out).
export function apply(op: WorldOp, region?: Region): Promise<[number, number][]> {
  const w = world;
  if (!w) return Promise.reject(new Error('world-edits: initWorldEdits first'));
  const run = queue.then(() => applyNow(w, op, region ?? opRegion(w.frame, op)));
  queue = run.catch(() => {});
  return run;
}

async function applyNow({ cache, frame, nx, ny }: EditWorld, op: WorldOp, region: Region) {
  const cell = toCellOp(frame, op), N = frame.N;
  const held = (await Promise.all(touchedNodes(cell, N, nx, ny).map(([tx, ty]) =>
    cache.acquire(tx, ty).then(() => [tx, ty] as [number, number], () => null)))).filter((t) => t !== null);
  try {
    for (const [tx, ty] of held) {
      // (as it is now: held, so its files are in)
      const v = cache.view(tx, ty)!, e = new EditableNode(N, v.base as NodeColumns, tx, ty);
      e.apply(cell);
      const enc = e.encode(), base = { ...v.base, ...enc };
      // (a foliage tile's ground is its base's, in the files too: tools/remesh-bench.mjs; only what carves takes trees
      // and grass with it)
      let foliage: LiveNode['foliage'] = { ...v.foliage, ground: enc.ground };
      if (cell.id === 0) {
        const f = new EditableNode(N, foliage as NodeColumns, tx, ty);
        f.apply(cell);
        foliage = { ...f.encode(), ground: enc.ground };
      }
      liveEdits.set(tx, ty, { base, foliage, ops: [...(liveEdits.get(tx, ty)?.ops ?? []), op] }, region);
    }
  } finally {
    for (const [tx, ty] of held) cache.release(tx, ty);
  }
  return held;
}

// node (tx, ty) as its files again (its edits gone)
export function drop(tx: number, ty: number) { liveEdits.set(tx, ty, null); }

// every edit gone
export function dropAll() { for (const [tx, ty] of [...liveEdits.entries()]) drop(tx, ty); }
