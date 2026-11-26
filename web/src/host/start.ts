// The host's start config (docs/adr/0009-layers-and-owners.md: host/ is the only place that reads a URL or a clock):
// what a host starts its world with (host/sim-host.ts hostSim), read from a query string (the page's URL: the page's
// thread reads its own, the worker the one the page hands it in its init) and the host's clock. A client learns what
// came of it from its session (the time of day and its player: its snapshots), never sends it.
//   ?seed=        the traffic's seed (else a new one each start)
//   ?mode=        the game mode (host/sim-host.ts MODES; else the sandbox)
//   ?dig=1        the sandbox's edits allowed, the road physics loaded at once
//   ?lifephys=0   no traffic bodies near edits (the drive still loads the road physics); ?lpnear=, ?lpmax=: their
//                 reach and number
//   ?date=MM-DD, ?hour=   the world's day and hour at the start (else today, at its golden hour: sim/sun.ts)
import type { PhysicsOptions } from '../sim/contract/worker';
import type { TimeOfDay } from '../sim/contract/snapshot';
import { dayOfDate, goldenHour } from '../sim/sun';

export interface HostStart {
  seed: number;
  /** the game mode's id (without: the sandbox) */
  mode?: string;
  /** the sandbox's edits to the world's voxels allowed */
  edits: boolean;
  /** the road physics loaded at once */
  eager: boolean;
  physics: PhysicsOptions;
  time: TimeOfDay;
}

/** the start config of query (a URL's search) at now */
export function hostStart(query: string | URLSearchParams, now = new Date(), random = Math.random): HostStart {
  const qs = typeof query === 'string' ? new URLSearchParams(query) : query;
  const n = (k: string) => (qs.get(k) !== null ? +qs.get(k)! : undefined), dig = qs.get('dig') === '1';
  const year = now.getFullYear(), md = qs.get('date')?.split('-').map(Number);
  const day = md ? dayOfDate(year, md[0] - 1, md[1]) : dayOfDate(year, now.getMonth(), now.getDate());
  return {
    seed: n('seed') ?? (random() * 2 ** 32) >>> 0,
    mode: qs.get('mode') ?? undefined,
    edits: dig, eager: dig,
    physics: { bodies: qs.get('lifephys') !== '0', near: n('lpnear'), maxBodies: n('lpmax') },
    time: { day, hour: qs.get('hour') ? +qs.get('hour')! : goldenHour(day, year) },
  };
}
