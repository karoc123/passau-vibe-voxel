// The world's ground and water where no streamer is (host/sim.worker.ts: the sim in a Web Worker): a World (world.ts) over
// the level-1 nodes of a TileCache (with its live edits), each asked for when first wanted and in from then on (the
// streamer's World answers with the finest tile it has loaded: near the focus that is level 1 too). Holds the last
// HOLD nodes asked for. No three.js, no DOM.
import type { TileCache } from './tile-cache';
import { roomOffsets, type Columns } from './tile-data';
import type { ColumnData, Meta } from './meta';
import { World, type ColumnSource } from './world';

const HOLD = 96;

export function tileWorld(meta: Meta, cache: TileCache): World {
  const N = meta.tiles.N, S = N + 2, data = new WeakMap<Columns, ColumnData>(), held: string[] = [], asked = new Set<string>();
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
        }, () => {}); // (a node with no files: not asked again)
      }
      return undefined;
    },
  };
  cache.edits?.listen(() => { src.version++; });
  return new World(src, meta);
}
