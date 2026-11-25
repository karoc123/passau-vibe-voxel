// The viewer's one TileCache (core/tile-cache.ts) over data/tiles/, seen through the page's live edits (its client's,
// SimClient.edits: the world's own when the sim runs in the page's thread): the crafts' collisions (nav/, sim/craft/),
// the car's Rapier terrain (physics/rapier/life-phys.ts), the world's edits and the streamer's files again share each
// node's fetch and decode. The page's host gets it as its tile port (app/session.ts, host/browser.ts browserPorts); a
// Web Worker running the sim (host/sim.worker.ts) makes its own (host/browser.ts tileCacheAt, the same over the data's
// base URL).
import type { LiveEdits } from './core/live-edits';
import { TileCache } from './core/tile-cache';
import { dataUrl, HOST_FILES } from './core/data-contract';
import { fetchGzip } from './fetch';

let shared: TileCache | null = null;
/** the viewer's TileCache (a node near the drone's or the car's 3 x 3 kept a while after both let go), over edits (the
 * page's: the same at every call) */
export function viewerTileCache(N: number, edits: LiveEdits) {
  shared ??= new TileCache({ N, load: (p) => fetchGzip(dataUrl(HOST_FILES.tiles + p)), edits, keep: 9 });
  if (shared.edits !== edits) throw new Error('viewerTileCache: the page has one set of live edits');
  return shared;
}
