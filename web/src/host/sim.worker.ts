// The local server (docs/plans/local-server.md, ADR 0008): the world sim in a Web Worker. It loads the map and the
// traffic itself, owns the world's TileCache, its live edits (core/live-edits.ts: this thread's module is the
// world's), its ground and water (core/tile-world.ts) and the road physics (Rapier, loaded here), and runs a
// SimServer (sim/server/sim-server.ts) as host/sim-host.ts wires it, with one session per init: the page's player
// (host/sim-host.ts PAGE_PLAYER; the worker names it, the page's commands name none). The page
// (client/sim-worker-link.ts) sends a frame (dt, the input, the commands) and gets its session's snapshot after it
// (sim/server/snapshot.ts: its player's id among its reads), with the edits since the last for its own live edits.
// The messages (sim/contract/worker.ts ToWorker, FromWorker):
//   in:  init { base, seed, physics, eager, mode, edits }; frame { dt, input, commands }; loadPhysics { id, warm }
//   out: ready; snapshot { snapshot, ms: the update's and the snapshot's time here }; physics { id, ok, error }
import { fetchJson } from './fetch';
import { hostSim, PAGE_PLAYER } from './sim-host';
import type { FromWorker, ToWorker } from '../sim/contract/worker';
import type { Session } from '../sim/server/sim-server';
import { unpackTraffic } from '../sim/traffic-pack';
import type { TrafficData } from '../sim/types';
import { tileWorld } from '../core/tile-world';
import type { Meta } from '../core/meta';
import { tileCacheAt } from './viewer-tiles';

const post = (m: FromWorker) => (self as unknown as { postMessage(m: FromWorker): void }).postMessage(m);
let session: Session | null = null, focus = { x: 0, z: 0 };
const early: ToWorker[] = [];

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.kind === 'init') { void init(m); return; }
  if (!session) { early.push(m); return; }
  handle(session, m);
};

async function init(m: Extract<ToWorker, { kind: 'init' }>) {
  const [meta, raw] = await Promise.all([fetchJson<Meta>(`${m.base}data/meta.json`), fetchJson<TrafficData>(`${m.base}data/traffic.json`)]);
  const cache = tileCacheAt(meta.tiles.N, m.base), world = tileWorld(meta, cache);
  const server = hostSim(meta, unpackTraffic(raw), { seed: m.seed, world, cache, base: m.base, eager: m.eager, mode: m.mode, edits: m.edits, physics: { ...m.physics, at: () => focus } });
  server.trackEdits();
  const s = session = server.connect(PAGE_PLAYER);
  post({ kind: 'ready' });
  for (const q of early.splice(0)) handle(s, q);
}

function handle(s: Session, m: ToWorker) {
  if (m.kind === 'frame') {
    const t0 = performance.now();
    focus = m.input.focus;
    for (const c of m.commands) s.send(c);
    s.server.update(m.dt, m.input);
    const snapshot = s.snapshot();
    post({ kind: 'snapshot', snapshot, ms: performance.now() - t0 });
  } else if (m.kind === 'loadPhysics') {
    s.sim.loadPhysics(m.warm).then(() => post({ kind: 'physics', id: m.id, ok: true }),
      (error) => post({ kind: 'physics', id: m.id, ok: false, error: String(error) }));
  }
}
