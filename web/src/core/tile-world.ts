// The world's ground and water where no streamer is (host/sim.worker.ts: the sim in a Web Worker): a World (world.ts) over
// the level-1 nodes of a TileCache (with its live edits), each asked for when first wanted and in from then on (the
// streamer's World answers with the finest tile it has loaded: near the focus that is level 1 too). Holds the last
// HOLD nodes asked for, and those round the points hold was last given; listens to the cache's live edits until disposed
// (its host's dispose: host/node.ts nodeHost).
// No three.js, no DOM.
import type { TileCache } from './tile-cache';
import { roomOffsets, type Columns } from './tile-data';
import type { ColumnData, Meta } from './meta';
import type { Vec3 } from './vec';
import { World, type ColumnSource } from './world';

const HOLD = 96;

/** the World over cache's level-1 nodes; hold: the nodes within r m of these points (map x, z) loaded and kept, those
 * of the call before let go; dispose: its listener on the cache's live edits removed */
export function tileWorld(meta: Meta, cache: TileCache): World & { hold(around: readonly { x: number; z: number }[], r: number): void;
  ready(o: Vec3, d: Vec3, max: number): boolean; dispose(): void } {
  const N = meta.tiles.N, S = N + 2, data = new WeakMap<Columns, ColumnData>(), held: string[] = [], asked = new Set<string>();
  // (nodes whose files could not be read: nothing to wait for)
  const failed = new Set<string>();
  const colData = (tx: number, ty: number, c: Columns): ColumnData => {
    let d = data.get(c);
    if (!d) {
      const off = new Uint32Array(S * S + 1);
      for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + c.counts[i];
      data.set(c, d = { ...c, s: 1, x0: tx * N, y0: ty * N, S, off, roomOff: c.rooms ? roomOffsets(c.rooms, S * S) : null } as ColumnData);
    }
    return d;
  };
  const src: ColumnSource = {
    N, levels: [1], version: 0,
    columns(key: string) {
      const t = key.slice(2), [tx, ty] = t.split('_').map(Number);
      const v = cache.view(tx, ty);
      if (v) return colData(tx, ty, v.base);
      if (!asked.has(t)) {
        asked.add(t);
        cache.acquire(tx, ty).then(() => {
          held.push(t);
          src.version++;
          while (held.length > HOLD) { const [x, y] = held.shift()!.split('_').map(Number); asked.delete(`${x}_${y}`); cache.release(x, y); }
        }, () => { failed.add(t); }); // (a node with no files: not asked again)
      }
      return undefined;
    },
  };
  const unlisten = cache.edits?.listen(() => { src.version++; });
  // the nodes held round the points (by "tx_ty"): one entry an acquire, in once loaded (a node that fails stays out
  // while wanted: not asked again)
  const near = new Map<string, { in: boolean }>(), nx = Math.ceil(meta.W / N), ny = Math.ceil(meta.D / N);
  const hold = (around: readonly { x: number; z: number }[], r: number) => {
    const want = new Set<string>();
    for (const { x, z } of around) {
      for (let ty = Math.max(0, Math.floor((z - r) / N)); ty <= Math.min(ny - 1, Math.floor((z + r) / N)); ty++)
        for (let tx = Math.max(0, Math.floor((x - r) / N)); tx <= Math.min(nx - 1, Math.floor((x + r) / N)); tx++) want.add(`${tx}_${ty}`);
    }
    for (const k of want) {
      if (near.has(k)) continue;
      const e = { in: false }, [tx, ty] = k.split('_').map(Number);
      near.set(k, e);
      cache.acquire(tx, ty).then(() => {
        if (near.get(k) !== e) { cache.release(tx, ty); return; }
        e.in = true;
        src.version++;
      }, () => { failed.add(k); });
    }
    for (const [k, e] of near) {
      if (want.has(k)) continue;
      near.delete(k);
      if (e.in) { const [tx, ty] = k.split('_').map(Number); cache.release(tx, ty); }
    }
  };
  const world = new World(src, meta);
  // the nodes the ray's track on the map crosses (sampled finer than a node), each in, failed or off the built map;
  // those not yet: asked for
  const ready = (o: Vec3, d: Vec3, max: number) => {
    let all = true;
    const step = N / 4, n = Math.ceil(max / step);
    for (let i = 0; i <= n; i++) {
      const t = Math.min(max, i * step), x = o.x + d.x * t, z = o.z + d.z * t;
      if (!world.inside(x, z)) continue;
      const tx = Math.floor(x / N), ty = Math.floor(z / N), k = `${tx}_${ty}`;
      if (failed.has(k) || cache.view(tx, ty)) continue;
      src.columns(`1/${k}`);
      all = false;
    }
    return all;
  };
  return Object.assign(world, { hold, ready, dispose: () => unlisten?.() });
}
