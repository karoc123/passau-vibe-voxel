// The world's edits (docs/adr/0001-world-layers.md, 0008-server-vision.md): the one way to change the world's voxels.
// An op touches level-1 nodes (touched: core/columns.ts touchedNodes, the margins too); a host holds them in the
// world's TileCache (ready) until the world sim's tick that applies the edit (applyNow, synchronous: each node as it
// is now, its files or its live edit; the op applied to its base columns and, where the op carves (air), to its
// foliage's, where it places a block, its foliage cleared there, EditableNode; the result put into the live edits,
// core/live-edits.ts, with the op appended to the node's ops). apply(op) does both for a tool without a world sim. Whatever draws or collides with the world listens there:
// the viewer's streamer meshes the node again (stream.ts), the physics drop what they built of it
// (physics/rapier/terrain.ts), the world sim hears of the box (host/sim-host.ts). drop(tx, ty) gives a node its files
// again. Who keeps an edit and for how long is not decided here (sim/edit-keeper.ts).
// One world per process (ADR 0008): the live edits are the module's (liveEdits), the TileCache the one given to
// initWorldEdits (the host's tile port; a tool: its own over the files on disk). A client's live edits are its own
// (client/sim-client.ts SimClient.edits; in the sim's own thread the app hands it these).
// Later (not built): an edit that expires (damage for a while) or lasts (a built house, ADR 0001 L1) is an op kept
// apart from the others; a node is then made again from its files and the ops left (core/layers.ts effectiveColumns,
// over the TileCache's files), instead of op upon op as here.
// Pure data: no three.js, no DOM.
import { EditableNode, opBounds, touchedNodes, Z_MAX, type CellOp, type NodeColumns } from './columns';
import { cellToAbsZ, mapToGrid, toCellOp, type Frame, type WorldOp } from './layers';
import { liveEdits, type LiveNode, type Region } from './live-edits';
import type { NodeView, TileCache } from './tile-cache';
import type { Columns } from './tile-data';

export type { WorldOp };
export { liveEdits };

// the world's tiles: its level-1 nodes' files (seen through liveEdits), its frame (core/layers.ts frameOf: what turns
// an op into map cells), and its nodes (meta.json tiles.levels[0] nx, ny)
export interface EditWorld { cache: TileCache; frame: Frame; nx: number; ny: number }

let world: EditWorld | null = null;
// the tools' edits in the order they were made (each reads the nodes as the one before left them)
let queue: Promise<unknown> = Promise.resolve();

export function initWorldEdits(w: EditWorld) {
  if (w.cache.edits !== liveEdits) throw new Error('world-edits: the TileCache must see the world\'s live edits');
  if (w.cache.N !== w.frame.N) throw new Error(`world-edits: a TileCache of ${w.cache.N}, nodes of ${w.frame.N}`);
  world = w;
}

const theWorld = () => {
  if (!world) throw new Error('world-edits: initWorldEdits first');
  return world;
};

/** a level-1 node's side in map metres */
export const nodeMetres = () => theWorld().frame.N;

// the box an op may change, in map metres [x0, y0, x1, y1)
export function opRegion(f: Frame, op: WorldOp): [number, number, number, number] {
  const b = opBounds(toCellOp(f, op));
  return [b.x0, b.y0, b.x1, b.y1];
}

// the level-1 nodes op touches (the margins too)
export function touched(op: WorldOp): [number, number][] {
  const w = theWorld();
  return touchedNodes(toCellOp(w.frame, op), w.frame.N, w.nx, w.ny);
}

// Holds nodes in the world's TileCache: resolves, once each is in or has failed (it never rejects), to their release
// (a host holds an edit's nodes until the tick that applies it: sim/server/sim-server.ts EditTiles)
export function ready(nodes: readonly [number, number][]): Promise<() => void> {
  if (!world || !nodes.length) return Promise.resolve(() => {});
  const { cache } = world;
  return Promise.all(nodes.map(([tx, ty]) => cache.acquire(tx, ty).then(() => [tx, ty] as [number, number], () => null))).then((got) => {
    let held = got.filter((t) => t !== null);
    return () => { for (const [tx, ty] of held) cache.release(tx, ty); held = []; };
  });
}

// Applies op to the world now (synchronous: the world sim's tick that applies the edit), to each node it touches that
// is in the TileCache (held: ready); region: the box it changed, for the listeners (default: the op's, opRegion).
// Returns the level-1 nodes changed (a node not in, its files unread, is left out)
export function applyNow(op: WorldOp, region?: Region): [number, number][] {
  const { cache, frame } = theWorld(), box = region ?? opRegion(frame, op);
  const out: [number, number][] = [];
  for (const [tx, ty] of touched(op)) {
    // (as it is now: its files, or its live edit)
    const v = cache.view(tx, ty);
    if (!v) continue;
    liveEdits.set(tx, ty, editNode(frame, tx, ty, v, op, liveEdits.get(tx, ty)?.ops ?? []), box);
    out.push([tx, ty]);
  }
  return out;
}

/** node (tx, ty) as op leaves it, from v (its columns now: its files or its live edit) and ops (the edits that made
 * v). The one code for the host and a client applying the ops it was sent over its own files, so both end with the
 * same columns */
export function editNode(frame: Frame, tx: number, ty: number, v: NodeView, op: WorldOp, ops: readonly WorldOp[]): LiveNode {
  const cell = toCellOp(frame, op), N = frame.N;
  const e = new EditableNode(N, v.base as NodeColumns, tx, ty);
  e.apply(cell);
  // (the columns alone: a file's other sections, decodeTile's fields and extra, are no plain data to send a client,
  // and the mesher reads them from the file)
  const { fields: _f, extra: _x, ...cols } = v.base as Columns & { fields?: unknown; extra?: unknown };
  const enc = e.encode(), base = { ...cols, ...enc };
  // (a foliage tile's ground is its base's, in the files too: tools/remesh-bench.mjs)
  let foliage: LiveNode['foliage'] = { ...v.foliage, ground: enc.ground };
  const f = new EditableNode(N, foliage as NodeColumns, tx, ty);
  // (a block placed takes the trees and grass in its cells with it, or they draw through it; only where the base
  // changed: painting what is solid leaves the leaves round it, and grass stays on ground the block did not touch)
  const changed = cell.id === 0 ? (f.apply(cell), true) : clearUnderBlock(f, new EditableNode(N, v.base as NodeColumns, tx, ty), e, cell);
  if (changed) foliage = { ...f.encode(), ground: enc.ground };
  return { base, foliage, ops: [...ops, op] };
}

// foliage f cleared in op's cells where the base went from before to a new solid id in after; whether any was
function clearUnderBlock(f: EditableNode, before: EditableNode, after: EditableNode, op: CellOp) {
  const b = opBounds(op), ox = f.tx * f.N, oy = f.ty * f.N, z0 = Math.max(0, b.z0), z1 = Math.min(Z_MAX, b.z1);
  let hit = false;
  for (let y = Math.max(-1, b.y0 - oy); y < Math.min(f.N + 1, b.y1 - oy); y++) {
    for (let x = Math.max(-1, b.x0 - ox); x < Math.min(f.N + 1, b.x1 - ox); x++) {
      for (let z = z0; z < z1; z++) {
        const now = after.get(x, y, z);
        if (now && now !== before.get(x, y, z) && f.get(x, y, z)) { f.set(x, y, z, 0); hit = true; }
      }
    }
  }
  return hit;
}

// Applies op to the world (after the edits before it), its nodes read first (ready, then applyNow): a tool's edit
// without a world sim. Resolves to the level-1 nodes changed (a node whose files cannot be read is left out).
export function apply(op: WorldOp, region?: Region): Promise<[number, number][]> {
  if (!world) return Promise.reject(new Error('world-edits: initWorldEdits first'));
  const run = queue.then(() => ready(touched(op))).then((release) => {
    try { return applyNow(op, region); } finally { release(); }
  });
  queue = run.catch(() => {});
  return run;
}

// A crater: the cells within r m (a multiple of 1/4) of the cell at map point (x, y, z) (y up) made air, in the
// world's grid
export function crater(x: number, y: number, z: number, r: number): WorldOp {
  const { frame } = theWorld(), [col, row] = mapToGrid(frame, Math.floor(x), Math.floor(z));
  return { kind: 'sphere', col, row, z: cellToAbsZ(frame, Math.floor(y)), r, colour: 0 };
}

// node (tx, ty) as its files again (its edits gone)
export function drop(tx: number, ty: number) { liveEdits.set(tx, ty, null); }

// every edit gone
export function dropAll() { for (const [tx, ty] of [...liveEdits.entries()]) drop(tx, ty); }
