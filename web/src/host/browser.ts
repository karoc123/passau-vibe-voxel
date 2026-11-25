// The host's browser ports (host/sim-host.ts HostPorts): the page's thread (main.ts, over the viewer's TileCache) and
// the Web Worker (host/sim.worker.ts, over its own). The clock is performance.now, the log console.warn, the road
// physics' code its own chunk (a dynamic import), the data and the node files fetched from a base URL. The page's
// render side loads its files through its own loaders (fetch.ts, viewer-tiles.ts: presentation, which may not import
// the host); the two fetches below are theirs, kept apart by the layers.
import { dataUrl, HOST_FILES } from '../core/data-contract';
import { liveEdits } from '../core/live-edits';
import { TileCache } from '../core/tile-cache';
import type { HostPorts } from './sim-host';

export async function fetchGzip(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export const fetchJson = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);

/** a TileCache over base's data/tiles/, seen through the world's live edits (as the viewer's, viewer-tiles.ts) */
export const tileCacheAt = (N: number, base = '') => new TileCache({ N, load: (p) => fetchGzip(dataUrl(HOST_FILES.tiles + p, base)), edits: liveEdits, keep: 9 });

/** the browser's ports over tiles (the page: the viewer's TileCache; the worker: tileCacheAt) */
export const browserPorts = (tiles: TileCache): HostPorts => ({
  tiles,
  now: () => performance.now(),
  log: (what, error) => { if (error === undefined) console.warn(what); else console.warn(what, error); },
  physicsLoader: () => import('../physics/rapier/life-phys'),
});
