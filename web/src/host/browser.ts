// The host's browser ports (host/sim-host.ts HostPorts): the page's thread (main.ts, over the viewer's TileCache) and
// the Web Worker (host/sim.worker.ts, over its own). The clock is performance.now, the log console.warn, the road
// physics' code its own chunk (a dynamic import; in the page's thread once the page is idle, so its ~1.7 MB gzip do not
// compete with the city's first load: the host asks for it at its start), the data and the node files fetched from a base URL. The page's
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
  physicsLoader: () => pageIdle().then(() => import('../physics/rapier/life-phys')),
});

const PHYSICS_AFTER_MS = 1500;
type Idle = (f: () => void, o?: { timeout: number }) => void;
// (the page's thread: PHYSICS_AFTER_MS on, when it is idle; a worker, which has no document: at once)
function pageIdle() {
  if (typeof document === 'undefined') return Promise.resolve();
  const idle = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback;
  return new Promise<void>((done) => setTimeout(() => (idle ? idle(() => done(), { timeout: 3000 }) : done()), PHYSICS_AFTER_MS));
}
