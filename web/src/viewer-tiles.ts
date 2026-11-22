// The viewer's one TileCache (core/tile-cache.ts) over data/tiles/, seen through its live edits: the FPV drone's
// collision (nav/fpv.ts) and the car's Rapier terrain (physics/rapier/life-phys.ts) share each node's fetch and decode.
import { liveEdits } from './core/live-edits';
import { TileCache } from './core/tile-cache';
import { fetchGzip } from './fetch';

let shared: TileCache | null = null;
// (a node near the drone's or the car's 3 x 3 kept a while after both let go of it)
export const viewerTileCache = (N: number) => shared ??= new TileCache({ N, load: (p) => fetchGzip(`data/tiles/${p}`), edits: liveEdits, keep: 9 });
