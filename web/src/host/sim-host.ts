// The one host (docs/plans/architecture-review.md A12): the world sim made and wired as a
// server would, the same for the page's thread (main.ts), the Web Worker (host/sim.worker.ts), the Node tools and a
// Node server (host/node.ts). The WorldSim (sim/world-sim.ts) with its road physics' loader (Rapier, the tiles through
// the host's TileCache), its crafts' world (the same TileCache, the clock), its ground and water, the river boats' timetable,
// and the world's edits: set up here (core/world-edits.ts initWorldEdits), each one told to the sim (its box; the road
// physics loaded on the first unless asked not to), and the game mode (sim/mode.ts: ?mode=, by default the sandbox).
// The host names the page's player (PAGE_PLAYER) and connects its session; the page holds only the client
// (client/sim-client.ts SimClient). The data comes in loaded and everything outside is a port (HostPorts: the node
// files, the clock, the log, the road physics' code): no fetch, no clock, no console here (tools/core-deps.mjs), so the
// wiring that ships is the one host-smoke runs in Node. No three.js, no DOM.
import { checkBuild } from '../core/data-contract';
import { liveEdits } from '../core/live-edits';
import { frameOf } from '../core/layers';
import { initWorldEdits } from '../core/world-edits';
import type { BoatData } from '../sim/boat-traffic';
import type { WaterColumns } from '../sim/river';
import { SimServer } from '../sim/server/sim-server';
import type { GameMode } from '../sim/mode';
import { sandbox } from '../sim/modes/sandbox';
import type { Ground } from '../sim/traffic';
import type { Tuning } from '../sim/tuning';
import type { TrafficData } from '../sim/types';
import { WorldSim } from '../sim/world-sim';
import type { Meta } from '../core/meta';
import type { TileCache } from '../core/tile-cache';
import type { PlayerId } from '../sim/contract/ids';
import type { PhysicsOptions } from '../sim/contract/worker';

/** the world's data, loaded by the platform (the page and the worker: fetched; host/node.ts: read from disk) */
export interface HostData {
  meta: Meta;
  /** traffic.json, unpacked (sim/traffic-pack.ts) */
  traffic: TrafficData;
  /** the river boats' timetable (boats.json): given at once, or as it comes (the page's fetch: set when it is in) */
  boats?: BoatData | Promise<BoatData> | null;
}

/** the road physics' code (physics/rapier/life-phys.ts: Rapier; the page's own chunk, loaded when first wanted) */
export type LifePhysicsModule = typeof import('../physics/rapier/life-phys');

/** what the host reads of the world outside it (host/browser.ts: the page's and the worker's; host/node.ts: files) */
export interface HostPorts {
  /** the world's node files (the tile loader): the page's is shared with its streamer (viewer-tiles.ts); it sees the
   * world's live edits (core/live-edits.ts liveEdits) */
  tiles: TileCache;
  /** the clock, ms (the crafts' collisions' budget) */
  now: () => number;
  /** what went wrong where (a load failed, an unknown mode, a build without its identity) */
  log: (what: string, error?: unknown) => void;
  /** the road physics' code */
  physicsLoader: () => Promise<LifePhysicsModule>;
}

export interface HostOptions {
  /** the traffic's seed (without: the traffic's default, sim/traffic.ts DEFAULT_SEED) */
  seed?: number;
  /** what the agents stand on and the boats float on (the viewer: the streamer's World; the worker: tileWorld) */
  world: (Ground & WaterColumns) | null;
  /** the road physics (sim/contract/worker.ts PhysicsOptions); at: where its terrain starts (the focus) */
  physics: PhysicsOptions & { at: () => { x: number; z: number } };
  /** the road physics loaded at once (?dig=1: edits to come) */
  eager?: boolean;
  /** the game mode, by id (?mode=; MODES; without, or unknown: the sandbox) */
  mode?: string;
  /** the sandbox's edits to the world's voxels allowed (?dig=1) */
  edits?: boolean;
}

/** the one player a page's host connects (SimServer.connect: one page, one session; the page learns it from its
 * session, SimClient.player, and never names it in a command) */
export const PAGE_PLAYER: PlayerId = 'local';

/** the game modes a host can make, by id */
export const MODES: Record<string, (opts: { edits: boolean }) => GameMode> = { sandbox };

/** the world sim and its server (sim/server/sim-server.ts: the commands, the snapshots) */
export function hostSim(data: HostData, ports: HostPorts, opts: HostOptions) {
  // the build: one this code reads, or none said (core/data-contract.ts: a wrong formatVersion throws)
  const build = checkBuild(data.meta, (w) => ports.log(w));
  const { meta } = data, N = meta.tiles.N, cache = ports.tiles, level = meta.tiles.levels.find((l) => l.s === 1)!;
  const sim = new WorldSim(data.traffic, { seed: opts.seed, loadPhysics: (tuning) => loadLifePhysics(meta, tuning, opts.physics, ports),
    crafts: { meta, cache, now: ports.now } });
  sim.setWorld(opts.world, opts.world);
  // (the world's edits: through the one TileCache; the people over a hole in them fall, the cars near them are bodies;
  // a node freed is its file again)
  initWorldEdits({ cache, frame: frameOf(meta), nx: level.nx, ny: level.ny });
  liveEdits.listen((tx, ty, node, region) => {
    sim.edited(node && region ? region : [tx * N, ty * N, tx * N + N, ty * N + N], !node);
    if (node && opts.physics.bodies) sim.loadPhysics().catch(() => {});
  });
  if (opts.eager && opts.physics.bodies) sim.loadPhysics().catch(() => {});
  const boats = data.boats;
  if (boats instanceof Promise) boats.then((bd) => sim.setBoats(bd)).catch((e) => ports.log('boats', e));
  else if (boats) sim.setBoats(boats);
  let make = MODES[opts.mode ?? 'sandbox'];
  if (!make) { ports.log(`no game mode ${opts.mode}; the sandbox`); make = MODES.sandbox; }
  // (the build goes into the hello each session is told: SimServer.hello)
  return new SimServer(sim, make({ edits: !!opts.edits }), build);
}

// The road physics (the shared Rapier world), loaded by WorldSim.loadPhysics: on the first edit or when the drive mode
// warms up
async function loadLifePhysics(meta: Meta, tuning: Tuning, opts: HostOptions['physics'], ports: HostPorts) {
  try {
    const { LifePhysics, DEFAULTS } = await ports.physicsLoader();
    const f = opts.at();
    return await LifePhysics.load(meta, { x: f.x, z: f.z }, {
      near: opts.bodies ? opts.near ?? DEFAULTS.near : 0, maxBodies: opts.maxBodies ?? DEFAULTS.maxBodies,
      ...(opts.look !== undefined ? { look: opts.look } : {}),
    }, { cache: ports.tiles }, tuning.ride);
  } catch (error) { ports.log('road physics', error); throw error; }
}
