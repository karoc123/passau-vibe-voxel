// The page's session with the world sim: its client and the link it reaches the sim over. The sim runs in a Web Worker
// on its own clock, or on a host on the network (?server=); the page draws from its snapshots. The world's start
// (its seed, game mode, edits, road physics, time of day) is the host's: the worker reads it from the page's URL,
// which the page hands it, a network host from its own command line; the page learns the world's time and its player
// from its snapshots.
// Each client compares its host's hello with its own (this code, the build of the page's meta.json, the tuning) and
// refuses a host that differs (client.hello rejects: main.ts shows it).
import { MirrorSimClient, type SimClient } from '../client/sim-client';
import { SocketLink, WorkerLink } from '../client/sim-worker-link';
import { checkBuild } from '../core/data-contract';
import type { LiveEdits } from '../core/live-edits';
import { frameOf } from '../core/layers';
import { viewerTileCache } from '../viewer-tiles';
import type { Meta } from '../core/meta';
import type { World } from '../core/world';
import { hostStart, type HostStart } from '../host/start';
import { hello } from '../sim/hello';
import type { TrafficData } from '../sim/types';
import type { SimCommand } from '../sim/contract/commands';
import type { TimeOfDay } from '../sim/contract/snapshot';

export interface SessionOptions {
  /** the page's URL's search (the worker's host reads its start from it) */
  query: string;
  /** ?server=ws://host:port: a host on the network (host/ws.ts) instead of the worker; a bare ?server: this page's
   * machine, the host's default port */
  server: string | null;
  /** the host's start as the page reads it from the same URL: only the time the page shows until the world's comes */
  start: HostStart;
}

export function sessionOptions(qs: URLSearchParams): SessionOptions {
  const server = qs.get('server');
  return { query: qs.toString(), start: hostStart(qs), server: server === '' ? `ws://${location.hostname}:${HOST_PORT}` : server };
}

export interface SessionData {
  meta: Meta;
  /** the page's live edits, filled from the snapshots */
  edits: LiveEdits;
  traffic: TrafficData;
  world: World | null;
}

/** host/ws.ts's default port (tools/serve.mjs) */
const HOST_PORT = 5300;

// the client, and its link (for the tools)
export function openSession(o: SessionOptions, { meta, edits, traffic, world }: SessionData): { client: SimClient; link: WorkerLink | SocketLink } {
  // the page's own hello: this code, the build it loaded (checked and warned of at boot), the default tuning
  const mine = hello(checkBuild(meta, () => {}));
  const link = o.server ? new SocketLink(o.server) : new WorkerLink(o.query);
  // (the edits are sent as ops, applied over the page's own node files)
  const tiles = { cache: viewerTileCache(meta.tiles.N, edits), frame: frameOf(meta) };
  return { client: new MirrorSimClient(link, traffic, world, mine, edits, tiles), link };
}

/** Whether the page's camera is a presence in the world while its player holds no seat (an observer: the orbit, free
 * flight): the world simulated round where it looks (today's behaviour), or only round the players' seats. The owner's
 * open question; one switch so either answer stays cheap. */
const OBSERVER_VIEW = true;

/** the page's view command for this frame: where it looks (focus: the orbit's target or the camera) and sees from (the
 * camera); none (no presence) for an observer while OBSERVER_VIEW is off */
export function pageView(client: SimClient, focus: { x: number; z: number }, viewer: { x: number; y: number; z: number }): SimCommand {
  if (!OBSERVER_VIEW && !client.seat()) return { kind: 'view', view: null };
  return { kind: 'view', view: { focus: { x: focus.x, z: focus.z }, viewer: { x: viewer.x, z: viewer.z, y: viewer.y } } };
}

/** The page's time of day (the host owns it, the same for everyone). The hour bar asks the world for another (ask: a
 * setTime request, which the mode grants or refuses) while the page shows it at once; the page follows the world's
 * time (follow) whenever it changes while none of its requests is open (another player's, the host's), and goes back
 * to it when one is refused. */
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
