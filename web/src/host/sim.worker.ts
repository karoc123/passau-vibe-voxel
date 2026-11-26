// The local server (ADR 0008): the world sim in a Web Worker, on its own clock. It loads the map and the traffic
// itself, owns the world's TileCache, its live edits (this thread's module is the world's), its ground and water and
// the road physics, and runs a SimServer with the start config it reads from the page's URL, with one session: the
// page's player. It ticks every STEP whether or not the page draws, and posts the session's snapshot after each tick
// (with the edits since the last, for the page's own live edits); the page's commands are taken as they come and
// applied at the start of the next tick.
// The messages:
//   in:  init { base, query }; commands { commands }
//   out: hello (before anything else; the page refuses a host that differs); ready; snapshot { snapshot, ms }
// greet, handle and step are exported: the Node tools drive them without a clock.
import { browserPorts, fetchJson, tileCacheAt } from './browser';
import { hostSim } from './sim-host';
import { hostStart } from './start';
import type { FromWorker, ToWorker } from '../sim/contract/worker';
import type { Session } from '../sim/server/sim-server';
import type { BoatData } from '../sim/boat-traffic';
import { STEP } from '../sim/road-net';
import { unpackTraffic } from '../sim/traffic-pack';
import type { TrafficData } from '../sim/types';
import { tileWorld } from '../core/tile-world';
import { dataUrl, HOST_FILES } from '../core/data-contract';
import type { Meta } from '../core/meta';

/** how the worker answers (a Web Worker: its postMessage; a tool: a list) */
export type Post = (m: FromWorker) => void;

// at most this many ticks caught up at once; further behind, the time is dropped (the world slows, it never races to
// catch up and starves the page of snapshots)
const CATCH_UP = 3;

// (only as a Web Worker: in Node, the tools import the functions alone)
const scope = typeof self !== 'undefined' && typeof (self as { importScripts?: unknown }).importScripts === 'function'
  ? self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null } : null;
let session: Session | null = null;
const early: ToWorker[] = [];

if (scope) {
  const post: Post = (m) => scope.postMessage(m);
  scope.onmessage = (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    if (m.kind === 'init') { void init(m, post); return; }
    if (!session) { early.push(m); return; }
    handle(session, m);
  };
}

async function init(m: Extract<ToWorker, { kind: 'init' }>, post: Post) {
  const [meta, raw] = await Promise.all([fetchJson<Meta>(dataUrl(HOST_FILES.meta, m.base)), fetchJson<TrafficData>(dataUrl(HOST_FILES.traffic, m.base))]);
  const cache = tileCacheAt(meta.tiles.N, m.base), world = tileWorld(meta, cache);
  const boats = fetchJson<BoatData>(dataUrl(HOST_FILES.boats, m.base));
  const server = hostSim({ meta, traffic: unpackTraffic(raw), boats }, browserPorts(cache), { ...hostStart(m.query), world });
  server.trackEdits();
  server.onDispose(world.dispose);
  const s = session = server.connect();
  greet(s, post);
  post({ kind: 'ready' });
  for (const q of early.splice(0)) handle(s, q);
  run(s, post);
}

// the clock: each tick when it is due (a timer to the next one), each followed by its snapshot
function run(s: Session, post: Post) {
  const ms = STEP * 1000;
  let next = performance.now() + ms;
  const due = () => {
    const now = performance.now();
    for (let n = 0; next <= now && n < CATCH_UP; n++, next += ms) step(s, post);
    if (next <= now) next = now + ms;
    setTimeout(due, next - performance.now());
  };
  setTimeout(due, ms);
}

/** what the page is told first when its session connects: the session's hello (the page compares it with its own) */
export function greet(s: Session, post: Post) { post({ kind: 'hello', hello: s.hello }); }

/** one message from the page to session s: its commands, for the next tick */
export function handle(s: Session, m: ToWorker) {
  if (m.kind === 'commands') for (const c of m.commands) s.send(c);
}

/** one tick of the world, then the session's snapshot posted with the time both took */
export function step(s: Session, post: Post) {
  const t0 = performance.now();
  s.server.update(STEP);
  const snapshot = s.snapshot();
  post({ kind: 'snapshot', snapshot, ms: performance.now() - t0 });
}
