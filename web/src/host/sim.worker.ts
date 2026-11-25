// The local server (ADR 0008): the world sim in a Web Worker. It loads the map and the
// traffic itself, owns the world's TileCache, its live edits (core/live-edits.ts: this thread's module is the
// world's), its ground and water (core/tile-world.ts) and the road physics (Rapier, loaded here), and runs a
// SimServer (sim/server/sim-server.ts) as host/sim-host.ts wires it (its browser ports: host/browser.ts), with one
// session per init: the page's player (host/sim-host.ts PAGE_PLAYER; the worker names it, the page's commands name
// none). The page (client/sim-worker-link.ts) sends a frame (dt, the input, the commands) and gets its session's snapshot after it
// (sim/server/snapshot.ts: its player's id among its reads), with the edits since the last for its own live edits.
// The messages (sim/contract/worker.ts ToWorker, FromWorker):
//   in:  init { base, seed, physics, eager, mode, edits }; frame { dt, input, commands }; loadPhysics { id, warm }
//   out: hello (the session's: sim/contract/hello.ts, before anything else; the page refuses a host that differs); ready; snapshot { snapshot, ms: the update's and the snapshot's time here }; physics { id, ok, error }
// greet (a session's first message) and handle (one message to a session, its answers to a post given) are exported:
// tools/host-smoke.mjs drives them in Node.
import { browserPorts, fetchJson, tileCacheAt } from './browser';
import { hostSim, PAGE_PLAYER } from './sim-host';
import type { FromWorker, ToWorker } from '../sim/contract/worker';
import type { Session } from '../sim/server/sim-server';
import type { BoatData } from '../sim/boat-traffic';
import { unpackTraffic } from '../sim/traffic-pack';
import type { TrafficData } from '../sim/types';
import { tileWorld } from '../core/tile-world';
import { dataUrl, HOST_FILES } from '../core/data-contract';
import type { Meta } from '../core/meta';

/** how the worker answers (a Web Worker: its postMessage; host-smoke: a list) */
export type Post = (m: FromWorker) => void;

// (only as a Web Worker: in Node, tools/host-smoke.mjs imports handle alone)
const scope = typeof self !== 'undefined' && typeof (self as { importScripts?: unknown }).importScripts === 'function'
  ? self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null } : null;
let session: Session | null = null, focus = { x: 0, z: 0 };
const early: ToWorker[] = [];

if (scope) {
  const post: Post = (m) => scope.postMessage(m);
  scope.onmessage = (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    if (m.kind === 'init') { void init(m, post); return; }
    if (!session) { early.push(m); return; }
    handle(session, m, post, (f) => { focus = f; });
  };
}

async function init(m: Extract<ToWorker, { kind: 'init' }>, post: Post) {
  const [meta, raw] = await Promise.all([fetchJson<Meta>(dataUrl(HOST_FILES.meta, m.base)), fetchJson<TrafficData>(dataUrl(HOST_FILES.traffic, m.base))]);
  const cache = tileCacheAt(meta.tiles.N, m.base), world = tileWorld(meta, cache);
  const boats = fetchJson<BoatData>(dataUrl(HOST_FILES.boats, m.base));
  const server = hostSim({ meta, traffic: unpackTraffic(raw), boats }, browserPorts(cache),
    { seed: m.seed, world, eager: m.eager, mode: m.mode, edits: m.edits, physics: { ...m.physics, at: () => focus } });
  server.trackEdits();
  const s = session = server.connect(PAGE_PLAYER);
  greet(s, post);
  post({ kind: 'ready' });
  for (const q of early.splice(0)) handle(s, q, post, (f) => { focus = f; });
}

/** what the page is told first when its session connects: the session's hello (the page compares it with its own) */
export function greet(s: Session, post: Post) { post({ kind: 'hello', hello: s.hello }); }

/** one message from the page to session s: a frame (its commands sent, the world updated, the session's snapshot
 * posted with the time it took by now) or a road physics' load (posted when done); setFocus: the frame's focus, where
 * the road physics' terrain starts */
export function handle(s: Session, m: ToWorker, post: Post, setFocus: (f: { x: number; z: number }) => void = () => {}) {
  if (m.kind === 'frame') {
    const t0 = performance.now();
    setFocus(m.input.focus);
    for (const c of m.commands) s.send(c);
    s.server.update(m.dt, m.input);
    const snapshot = s.snapshot();
    post({ kind: 'snapshot', snapshot, ms: performance.now() - t0 });
  } else if (m.kind === 'loadPhysics') {
    s.sim.loadPhysics(m.warm).then(() => post({ kind: 'physics', id: m.id, ok: true }),
      (error) => post({ kind: 'physics', id: m.id, ok: false, error: String(error) }));
  }
}
