// The local server (docs/plans/local-server.md, ADR 0008): the world sim in a Web Worker. It loads the map and the
// traffic itself, owns the world's TileCache, its live edits (core/live-edits.ts: this thread's module is the
// world's), its ground and water (tile-world.ts) and the road physics (Rapier, loaded here), and runs a SimServer
// (sim/sim-server.ts) as sim-host.ts wires it. The page (sim-worker-link.ts) sends a frame (dt, the input, the
// commands) and gets the snapshot after it (sim/snapshot.ts), with the edits since the last for its own live edits.
//   in:  init { base, seed, physics, eager, mode, edits, player }; frame { dt, input, commands }; loadPhysics { id, warm }
//   out: ready; snapshot { snapshot, ms: the update's and the snapshot's time here }; physics { id, ok, error }
import { fetchJson } from './fetch';
import { hostSim, type HostOptions } from './sim-host';
import type { SimCommand } from './sim/sim-client';
import type { SimServer } from './sim/sim-server';
import { unpackTraffic } from './sim/traffic-pack';
import type { TrafficData } from './sim/types';
import type { PlayerId, SimInput } from './sim/world-sim';
import { tileWorld } from './tile-world';
import type { Meta } from './core/meta';
import { tileCacheAt } from './viewer-tiles';

export type ToWorker =
  | { kind: 'init'; base: string; seed: number; physics: Omit<HostOptions['physics'], 'at'>; eager: boolean; mode?: string; edits: boolean; player: PlayerId }
  | { kind: 'frame'; dt: number; input: SimInput; commands: SimCommand[] }
  | { kind: 'loadPhysics'; id: number; warm?: { x: number; z: number } };
export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'snapshot'; snapshot: ReturnType<SimServer['snapshot']>; ms: number }
  | { kind: 'physics'; id: number; ok: boolean; error?: string };

const post = (m: FromWorker) => (self as unknown as { postMessage(m: FromWorker): void }).postMessage(m);
let server: SimServer | null = null, player: PlayerId = 'local', focus = { x: 0, z: 0 };
const early: ToWorker[] = [];

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.kind === 'init') { void init(m); return; }
  if (!server) { early.push(m); return; }
  handle(server, m);
};

async function init(m: Extract<ToWorker, { kind: 'init' }>) {
  const [meta, raw] = await Promise.all([fetchJson<Meta>(`${m.base}data/meta.json`), fetchJson<TrafficData>(`${m.base}data/traffic.json`)]);
  const cache = tileCacheAt(meta.tiles.N, m.base), world = tileWorld(meta, cache);
  player = m.player;
  const s = hostSim(meta, unpackTraffic(raw), { seed: m.seed, world, cache, base: m.base, eager: m.eager, mode: m.mode, edits: m.edits, physics: { ...m.physics, at: () => focus } });
  s.trackEdits();
  server = s;
  post({ kind: 'ready' });
  for (const q of early.splice(0)) handle(s, q);
}

function handle(s: SimServer, m: ToWorker) {
  if (m.kind === 'frame') {
    const t0 = performance.now();
    focus = m.input.focus;
    for (const c of m.commands) s.send(c);
    s.update(m.dt, m.input);
    const snapshot = s.snapshot(player);
    post({ kind: 'snapshot', snapshot, ms: performance.now() - t0 });
  } else if (m.kind === 'loadPhysics') {
    s.sim.loadPhysics(m.warm).then(() => post({ kind: 'physics', id: m.id, ok: true }),
      (error) => post({ kind: 'physics', id: m.id, ok: false, error: String(error) }));
  }
}
