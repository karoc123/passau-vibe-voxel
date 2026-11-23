// The local server's side (docs/plans/local-server.md): the world sim made and wired as a host would, for the viewer.
// The WorldSim (sim/world-sim.ts) with its road physics' loader (Rapier, the tiles through the viewer's TileCache), its
// crafts' world (the same TileCache, the page's clock), its ground and water, the river boats' timetable, and the
// world's edits: set up here (core/world-edits.ts initWorldEdits), each one told to the sim (its box; the road physics
// loaded on the first unless asked not to). The page holds only the client (sim/sim-client.ts SimClient).
// No three.js, no DOM but fetch: what a Web Worker could run.
import { liveEdits } from './core/live-edits';
import { frameOf } from './core/layers';
import { initWorldEdits } from './core/world-edits';
import { fetchJson } from './fetch';
import type { BoatData } from './sim/boat-traffic';
import type { WaterColumns } from './sim/river';
import { SimServer } from './sim/sim-server';
import type { Ground } from './sim/traffic';
import type { Tuning } from './sim/tuning';
import type { TrafficData } from './sim/types';
import { WorldSim } from './sim/world-sim';
import type { Meta } from './types';
import { viewerTileCache } from './viewer-tiles';

export interface HostOptions {
  /** the traffic's seed */
  seed: number;
  /** what the agents stand on and the boats float on (the viewer: the streamer's World) */
  world: (Ground & WaterColumns) | null;
  /** the road physics: bodies: traffic cars near edits become bodies (?lifephys=0: none; the drive still loads it);
   * near, maxBodies: their reach and number (?lpnear=, ?lpmax=); at: where its terrain starts (the focus) */
  physics: { bodies: boolean; near?: number; maxBodies?: number; at: () => { x: number; z: number } };
  /** the road physics loaded at once (?dig=1: edits to come) */
  eager?: boolean;
}

/** the viewer's world sim, in the page's thread, and its server (sim/sim-server.ts: the commands, the snapshots) */
export function hostLocalSim(meta: Meta, td: TrafficData, opts: HostOptions) {
  const N = meta.tiles.N, cache = viewerTileCache(N), level = meta.tiles.levels.find((l) => l.s === 1)!;
  const sim = new WorldSim(td, { seed: opts.seed, loadPhysics: (tuning) => loadLifePhysics(meta, tuning, opts.physics),
    crafts: { meta, cache, now: () => performance.now() } });
  sim.setWorld(opts.world, opts.world);
  // (the world's edits: through the one TileCache; the people over a hole in them fall, the cars near them are bodies;
  // a node freed is its file again)
  initWorldEdits({ cache, frame: frameOf(meta), nx: level.nx, ny: level.ny });
  liveEdits.listen((tx, ty, node, region) => {
    sim.edited(node && region ? region : [tx * N, ty * N, tx * N + N, ty * N + N], !node);
    if (node && opts.physics.bodies) sim.loadPhysics().catch(() => {});
  });
  if (opts.eager && opts.physics.bodies) sim.loadPhysics().catch(() => {});
  fetchJson<BoatData>('data/boats.json').then((bd) => sim.setBoats(bd)).catch((e) => console.warn('boats', e));
  return new SimServer(sim);
}

// The road physics (the shared Rapier world), loaded by WorldSim.loadPhysics: on the first edit or when the drive mode
// warms up
async function loadLifePhysics(meta: Meta, tuning: Tuning, opts: HostOptions['physics']) {
  try {
    const { LifePhysics, DEFAULTS } = await import('./physics/rapier/life-phys');
    const f = opts.at();
    return await LifePhysics.load(meta, { x: f.x, z: f.z }, {
      near: opts.bodies ? opts.near ?? DEFAULTS.near : 0, maxBodies: opts.maxBodies ?? DEFAULTS.maxBodies,
    }, { cache: viewerTileCache(meta.tiles.N) }, tuning.ride);
  } catch (error) { console.warn('road physics', error); throw error; }
}
