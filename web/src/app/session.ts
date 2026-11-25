// The page's session with the world sim: its client and the link it reaches the sim over (the one thing multiplayer
// adds to: a network link). The page draws from the sim's snapshots in every mode (sim/server/snapshot.ts,
// client/sim-client.ts MirrorSimClient). From the page's options (the query string):
//   thread (default): the world sim in this thread (host/sim-host.ts, made as a host would), over a ThreadLink;
//   ?worker=1: in a Web Worker (host/sim.worker.ts), over a WorkerLink.
// ?seed=: the traffic's seed (else a new one each load); ?mode=: the game mode the host makes (host/sim-host.ts MODES; by
// default the sandbox, its edits allowed with ?dig=1). The road physics (the shared Rapier world) loaded on the first
// edit, with ?dig=1, or when the drive mode warms up. ?lifephys=0: no traffic bodies near edits (the drive still loads
// it), ?lpnear=, ?lpmax=.
// Each client compares its host's hello with its own (sim/hello.ts hello: this code, the build of the page's meta.json,
// the tuning) and refuses a host that differs (client.hello rejects: main.ts shows it).
import { MirrorSimClient, ThreadLink, type SimClient } from '../client/sim-client';
import { WorkerLink } from '../client/sim-worker-link';
import { checkBuild, dataUrl, HOST_FILES } from '../core/data-contract';
import { LiveEdits, liveEdits } from '../core/live-edits';
import type { Meta } from '../core/meta';
import type { World } from '../core/world';
import { browserPorts } from '../host/browser';
import { hostSim, PAGE_PLAYER } from '../host/sim-host';
import type { BoatData } from '../sim/boat-traffic';
import { hello } from '../sim/hello';
import type { TrafficData } from '../sim/types';
import type { SimCommand } from '../sim/contract/commands';
import type { TimeOfDay } from '../sim/contract/snapshot';
import { fetchJson } from '../util';
import { viewerTileCache } from '../viewer-tiles';

export type Transport = 'thread' | 'worker';

export interface SessionOptions {
  transport: Transport;
  seed: number;
  eager: boolean;
  edits: boolean;
  mode: string | undefined;
  physics: { bodies: boolean; near: number | undefined; maxBodies: number | undefined };
}

export function sessionOptions(qs: URLSearchParams): SessionOptions {
  const n = (k: string) => (qs.get(k) !== null ? +qs.get(k)! : undefined), eager = qs.get('dig') === '1';
  return {
    transport: qs.get('worker') === '1' ? 'worker' : 'thread',
    seed: qs.get('seed') !== null ? +qs.get('seed')! : (Math.random() * 2 ** 32) >>> 0,
    eager, edits: eager,
    mode: qs.get('mode') ?? undefined,
    physics: { bodies: qs.get('lifephys') !== '0', near: n('lpnear'), maxBodies: n('lpmax') },
  };
}

/** the page's live edits, its client's (SimClient.edits; the streamer and the page's TileCache read them): the world's
 * own when the sim runs in this thread (one world per process, ADR 0008), else an empty set the client fills from its
 * snapshots */
export const pageEdits = (o: SessionOptions): LiveEdits => (o.transport === 'worker' ? new LiveEdits() : liveEdits);

export interface SessionData {
  meta: Meta;
  /** the page's live edits (pageEdits) */
  edits: LiveEdits;
  traffic: TrafficData;
  world: World | null;
  /** the world's time of day at the start (the page's ?hour=, ?date=: the host sets it; later a setTime request) */
  time: TimeOfDay;
}

// the client, and the worker's link with ?worker=1 (for the tools)
export function openSession(o: SessionOptions, { meta, edits: live, traffic, world, time }: SessionData): { client: SimClient; link: WorkerLink | null } {
  const { seed, physics, eager, mode, edits } = o;
  // the page's own hello: this code, the build it loaded (checked and warned of at boot), the default tuning
  const mine = hello(checkBuild(meta, () => {}));
  if (o.transport === 'worker') {
    const link = new WorkerLink({ seed, physics, eager, mode, edits, time });
    return { client: new MirrorSimClient(link, traffic, world, mine, live), link };
  }
  // (the client's traffic data its own copy, taken before the host's sim prepares its paths in place)
  const own = structuredClone(traffic), boats = fetchJson<BoatData>(dataUrl(HOST_FILES.boats));
  const server = hostSim({ meta, traffic, boats }, browserPorts(viewerTileCache(meta.tiles.N, live)), { seed, world, eager, mode, edits, physics, time });
  // (one session, the page's player: the host names it, the page's commands name none; the client handed the world's
  // live edits, the host's own: the server in this thread sends none in its snapshots)
  const session = server.connect(PAGE_PLAYER);
  return { client: new MirrorSimClient(new ThreadLink(session), own, world, mine, live), link: null };
}

/** Whether the page's camera is a presence in the world while its player holds no seat (an observer: the orbit, free
 * flight): the world simulated round where it looks (today's behaviour), or only round the players' seats. The owner's
 * open question (docs/plans/architecture-review.md, "Left over"); one switch so either answer stays cheap. */
export const OBSERVER_VIEW = true;

/** the page's view command for this frame: where it looks (focus: the orbit's target or the camera) and sees from (the
 * camera); none (no presence) for an observer while OBSERVER_VIEW is off */
export function pageView(client: SimClient, focus: { x: number; z: number }, viewer: { x: number; y: number; z: number }): SimCommand {
  if (!OBSERVER_VIEW && !client.seat()) return { kind: 'view', view: null };
  return { kind: 'view', view: { focus: { x: focus.x, z: focus.z }, viewer: { x: viewer.x, z: viewer.z, y: viewer.y } } };
}

/** The page's time of day (docs/adr/0009-layers-and-owners.md: the host owns it, the same for everyone). The hour bar
 * asks the world for another (ask: a setTime request, which the mode grants or refuses) while the page shows it at
 * once; the page follows the world's time (follow) whenever it changes while none of its requests is open (another
 * player's, the host's), and goes back to it when one is refused. */
export class PageTime {
  private open = 0;
  private seen: TimeOfDay | null = null;
  constructor(private readonly client: SimClient) {}

  /** the world asked for hour on day */
  ask(hour: number, day: number) {
    this.client.send({ kind: 'request', request: { kind: 'setTime', hour, day } });
    this.open++;
  }

  /** after the sim's update: the world's time for the page to show, or null (keep what it shows) */
  follow(): TimeOfDay | null {
    let refused = false;
    for (const r of this.client.results('setTime')) { this.open = Math.max(0, this.open - 1); if (!r.ok) refused = true; }
    const w = this.client.timeOfDay, s = this.seen;
    if (!w) return null;
    const changed = !s || s.hour !== w.hour || s.day !== w.day;
    this.seen = w;
    return refused || (changed && this.open === 0) ? w : null;
  }
}
