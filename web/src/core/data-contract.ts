// The data build's contract (docs/plans/architecture-review.md F11, A14): the files under data/ (web/public/data, written
// by the pipeline, scripts/build_data.sh) a host and a client load, and the formatVersion of meta.json `world`
// (scripts/world_id.py FORMAT_VERSION: the layout of the node files and of the edits' addresses) this code reads.
// checkBuild is called where meta.json comes in: the page (main.ts) and the host (host/sim-host.ts hostSim, so the
// page's thread, the worker and host/node.ts alike). A build without `world` (older than world_id.py) warns and loads;
// one of another formatVersion throws. DataBuild is what a later hello (A6: protocol, build, tuning) carries of it.
import type { Meta } from './meta';

/** the formatVersion of meta.json world this code reads (scripts/world_id.py FORMAT_VERSION) */
export const FORMAT_VERSION = 1;

/** what a host loads, relative to data/ (host/node.ts readHostData, host/sim.worker.ts; tiles/: the node files) */
export const HOST_FILES = { meta: 'meta.json', traffic: 'traffic.json', boats: 'boats.json', tiles: 'tiles/' } as const;

/** what a client (the page) loads besides the host's, relative to data/ (main.ts, city.ts and the render modules) */
export const CLIENT_FILES = ['climate.json', 'streetlamps.json', 'places.json', 'flood.json', 'zones.json',
  'phenology.json', 'windows.json', 'windows.bin', 'terrain.bin', 'terrain/', 'objects/'] as const;

/** a data build's identity: what host and client must share (meta.json world) */
export interface DataBuild { formatVersion: number; buildId: string }

/** meta's build, checked: null (warned) if it has no `world`; throws if its formatVersion is not FORMAT_VERSION */
export function checkBuild(meta: Pick<Meta, 'world'>, warn: (what: string) => void): DataBuild | null {
  const w = meta.world;
  if (!w) { warn('data: meta.json has no world (a build older than scripts/world_id.py): its build is not checked'); return null; }
  if (w.formatVersion !== FORMAT_VERSION) {
    throw new Error(`data: meta.json world.formatVersion ${w.formatVersion} (build ${w.buildId}), this code reads ` +
      `${FORMAT_VERSION}: rebuild the data (scripts/build_data.sh) or load it with the app of its version`);
  }
  return { formatVersion: w.formatVersion, buildId: w.buildId };
}
