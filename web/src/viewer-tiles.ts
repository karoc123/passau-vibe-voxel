// The viewer's one TileCache (core/tile-cache.ts) over data/tiles/, seen through its live edits: the crafts'
// collisions (nav/, sim/craft/), the car's Rapier terrain (physics/rapier/life-phys.ts), the world's edits and the
// streamer's files again share each node's fetch and decode. The page's host gets it as its tile port (main.ts,
// host/browser.ts browserPorts); a Web Worker running the sim (host/sim.worker.ts) makes its own (host/browser.ts
// tileCacheAt, the same over the data's base URL).
import { liveEdits } from './core/live-edits';
import { TileCache } from './core/tile-cache';
import { fetchGzip } from './fetch';

let shared: TileCache | null = null;
/** the viewer's TileCache (a node near the drone's or the car's 3 x 3 kept a while after both let go) */
export const viewerTileCache = (N: number) => shared ??= new TileCache({ N, load: (p) => fetchGzip(`data/tiles/${p}`), edits: liveEdits, keep: 9 });
