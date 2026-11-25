// The host in Node (docs/plans/architecture-review.md A12): host/sim-host.ts hostSim over a data/ directory on disk
// (web/public/data, or a fixture's build), as the Node tools start their sims (tools/host-smoke.mjs, mirror-check.mjs,
// popin-check.mjs, life-phys.mjs) and as a Node server would. The data read from the files at once; the ports: the
// node files read and gunzipped from <dir>/tiles/ through a TileCache over the world's live edits (as the page's and
// the worker's, host/browser.ts), the clock performance.now, the log console.warn, the road physics' code (imported with
// this module: vite's runner, tools/lib.mjs imp, is closed once it has loaded it, so no import() later). node:fs and
// node:zlib through process.getBuiltinModule, so the app's types (no @types/node) cover it.
import { HOST_FILES } from '../core/data-contract';
import { liveEdits } from '../core/live-edits';
import type { Meta } from '../core/meta';
import * as lifePhysics from '../physics/rapier/life-phys';
import { TileCache } from '../core/tile-cache';
import { tileWorld } from '../core/tile-world';
import type { BoatData } from '../sim/boat-traffic';
import { unpackTraffic } from '../sim/traffic-pack';
import type { TrafficData } from '../sim/types';
import { hostSim, type HostData, type HostOptions, type HostPorts } from './sim-host';

interface NodeFs { readFileSync(p: string): Uint8Array; readFileSync(p: string, enc: 'utf8'): string; existsSync(p: string): boolean }
interface NodeZlib { gunzipSync(b: Uint8Array): Uint8Array }
declare const process: { getBuiltinModule(id: string): unknown };
const fs = () => process.getBuiltinModule('node:fs') as NodeFs;
const zlib = () => process.getBuiltinModule('node:zlib') as NodeZlib;
const at = (dir: string, p: string) => `${dir.replace(/\/+$/, '')}/${p}`;
const json = <T>(dir: string, p: string) => JSON.parse(fs().readFileSync(at(dir, p), 'utf8')) as T;

/** a TileCache over <dir>/tiles/ (a node file that is not there: rejected), seen through the world's live edits */
export const nodeTileCache = (dir: string, N: number) => new TileCache({ N, edits: liveEdits, keep: 9, load: async (p) => {
  const b = zlib().gunzipSync(fs().readFileSync(at(dir, `${HOST_FILES.tiles}${p}`)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
} });

/** the Node ports over tiles */
export const nodePorts = (tiles: TileCache): HostPorts => ({
  tiles,
  now: () => performance.now(),
  log: (what, error) => { if (error === undefined) console.warn(what); else console.warn(what, error); },
  physicsLoader: async () => lifePhysics,
});

/** the world's data in <dir>: meta.json, traffic.json (unpacked), boats.json (null if it is not there) */
export function readHostData(dir: string): HostData {
  return {
    meta: json<Meta>(dir, HOST_FILES.meta), traffic: unpackTraffic(json<TrafficData>(dir, HOST_FILES.traffic)),
    boats: fs().existsSync(at(dir, HOST_FILES.boats)) ? json<BoatData>(dir, HOST_FILES.boats) : null,
  };
}

/** the world sim's server over <dir>, as hostSim makes it; world 'tiles': its ground and water the level-1 nodes of its
 * TileCache (core/tile-world.ts, as the worker's); data: the tools' own (e.g. a fresh traffic per sim), by default read
 * from dir */
export function nodeHost(dir: string, opts: Omit<HostOptions, 'world'> & { world: HostOptions['world'] | 'tiles' },
  data: HostData = readHostData(dir)) {
  const tiles = nodeTileCache(dir, data.meta.tiles.N);
  return hostSim(data, nodePorts(tiles), { ...opts, world: opts.world === 'tiles' ? tileWorld(data.meta, tiles) : opts.world });
}
