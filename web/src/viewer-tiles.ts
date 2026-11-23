// The viewer's one TileCache (core/tile-cache.ts) over data/tiles/, seen through its live edits: the crafts'
// collisions (nav/, sim/craft/), the car's Rapier terrain (physics/rapier/life-phys.ts), the world's edits and the
// streamer's files again share each node's fetch and decode. A Web Worker running the sim (sim.worker.ts) makes its
// own (tileCacheAt: the data's base URL, its own live edits).
import { liveEdits } from './core/live-edits';
import { TileCache } from './core/tile-cache';
import { fetchGzip } from './fetch';

let shared: TileCache | null = null;
/** a TileCache over base's data/tiles/ (a node near the drone's or the car's 3 x 3 kept a while after both let go) */
export const tileCacheAt = (N: number, base = '') => new TileCache({ N, load: (p) => fetchGzip(`${base}data/tiles/${p}`), edits: liveEdits, keep: 9 });
export const viewerTileCache = (N: number) => shared ??= tileCacheAt(N);
