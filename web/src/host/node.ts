// The host in Node (docs/adr/0009-layers-and-owners.md): host/sim-host.ts hostSim over a data/ directory on disk
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
// (for the Node tools, which load each module graph apart: this graph's world edits, e.g. dropAll between hosts)
export * as worldEdits from '../core/world-edits';

type Done<T> = (e: Error | null, v: T) => void;
interface NodeFs {
  readFileSync(p: string): Uint8Array; readFileSync(p: string, enc: 'utf8'): string; readFile(p: string, cb: Done<Uint8Array>): void;
  existsSync(p: string): boolean;
}
interface NodeZlib { gunzipSync(b: Uint8Array): Uint8Array; gunzip(b: Uint8Array, cb: Done<Uint8Array>): void }
declare const process: { getBuiltinModule(id: string): unknown };
const fs = () => process.getBuiltinModule('node:fs') as NodeFs;
const zlib = () => process.getBuiltinModule('node:zlib') as NodeZlib;
const at = (dir: string, p: string) => `${dir.replace(/\/+$/, '')}/${p}`;
const json = <T>(dir: string, p: string) => JSON.parse(fs().readFileSync(at(dir, p), 'utf8')) as T;

// The host's nodes nobody holds kept for a reader coming back, ~0.55 MB each decoded: the crowd's ground is asked for round
// each player out to the street life's radius (~200 nodes at one spot), and a node dropped and asked again is decoded
// again on the tick (with 9 kept, 10 players firing by the cathedral decoded ~12 nodes a tick).
const HOST_KEEP = 256;

const bytes = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** a TileCache over <dir>/tiles/ (a node file that is not there: rejected), seen through edits (default: the world's live
 * edits; a tool's client: its own), keep nodes nobody holds kept. offThread: the files read and gunzipped on Node's
 * pool, only their decoding the caller's (a network host's tick); else at once, as the tools' ticks expect a node asked
 * for to be in by the next turn of the event loop */
export const nodeTileCache = (dir: string, N: number, edits = liveEdits, keep = 9, offThread = false) => new TileCache({ N, edits, keep,
  load: offThread
    ? (p) => new Promise((ok, no) => fs().readFile(at(dir, `${HOST_FILES.tiles}${p}`), (e, z) => {
      if (e) no(e); else zlib().gunzip(z, (e2, b) => (e2 ? no(e2) : ok(bytes(b))));
    }))
    : async (p) => bytes(zlib().gunzipSync(fs().readFileSync(at(dir, `${HOST_FILES.tiles}${p}`)))),
});

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

/** the world sim's server over <dir>, as hostSim makes it (offThread: its node files read so, nodeTileCache); world 'tiles': its ground and water the level-1 nodes of its
 * TileCache (core/tile-world.ts, as the worker's; let go with the server's dispose); data: the tools' own (e.g. a fresh traffic per sim), by default read
 * from dir */
export function nodeHost(dir: string, opts: Omit<HostOptions, 'world'> & { world: HostOptions['world'] | 'tiles'; offThread?: boolean },
  data: HostData = readHostData(dir)) {
  const tiles = nodeTileCache(dir, data.meta.tiles.N, liveEdits, HOST_KEEP, opts.offThread), own = opts.world === 'tiles' ? tileWorld(data.meta, tiles) : null;
  const server = hostSim(data, nodePorts(tiles), { ...opts, world: opts.world === 'tiles' ? own : opts.world });
  if (own) server.onDispose(own.dispose);
  return Object.assign(server, { cache: tiles });
}
