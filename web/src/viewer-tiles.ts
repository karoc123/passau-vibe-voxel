// The viewer's one TileCache (core/tile-cache.ts) over data/tiles/, seen through the page's live edits (its client's,
// SimClient.edits): the crafts' collisions and the streamer's files share each node's fetch and decode. The Web Worker
// running the sim makes its own.
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
