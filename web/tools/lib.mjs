// Not a tool: what the node tools share. imp: a module of web/ (src/..., checks/...) loaded through vite's runner, as
// the viewer's build resolves it; serveTiles: fetch() answering the node files from disk, at the paths VoxelCollision
// fetches (data/tiles/...); sessionLink: a client's link to a host the tool ticks itself; synthData: a synthetic world
// as a data directory a real host (host/node.ts nodeHost) runs on; wallTick: a tick of wall time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerImport } from 'vite';
import { web } from './data-dir.mjs';

// p relative to web/, e.g. imp('src/core/tile-data.ts'), imp('checks/plane-checks.ts')
export const imp = async (p) => (await runnerImport(path.join(web, p), { root: web, logLevel: 'error' })).module;

// A client's link (SimLink) to a session of a host the tool ticks itself (server.update): the commands go to the
// session at once; deliver() hands the client the session's snapshot after the tool's update (the hello before the
// first), as the worker posts one after each tick.
export function sessionLink(session) {
  let greeted = false, closed = false;
  return {
    onHello() {}, onSnapshot() {},
    send(commands) { if (!closed) for (const c of commands) session.send(c); },
    close() { if (!closed) { closed = true; session.leave(); } },
    deliver() {
      if (!greeted) { greeted = true; this.onHello(session.hello); }
      if (!closed) this.onSnapshot(session.snapshot());
    },
  };
}

// a host's tick of wall time (33 ms): what a host whose node files are read off the thread (host/node.ts offThread)
// needs between ticks for them to come in, as on its clock
export const wallTick = () => new Promise((r) => setTimeout(r, 1000 / 30));

// fetch() of .../data/tiles/<p> reads <dir>/tiles/<p> (404 if it is not there), anything else as before
export function serveTiles(dir) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input), m = /data\/(tiles\/.*)$/.exec(url);
    if (!m) return realFetch(input, init);
    const f = path.join(dir, m[1]);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 });
  };
}

// A synthetic world (checks/world.ts WorldSpec) written as a data directory (its node files under tiles/, in a fresh
// directory of the system's temp, removed at exit, with its meta.json and an empty traffic.json): { dir, data } for
// nodeHost(dir, opts, data) or the network host (host/ws.ts serve), no traffic
export async function synthData(spec) {
  const { makeWorld } = await imp('checks/world.ts'), { FORMAT_VERSION } = await imp('src/core/data-contract.ts');
  const { meta, files } = await makeWorld(spec), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-world-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [p, b] of files) {
    const f = path.join(dir, p.replace(/^data\//, ''));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, b);
  }
  const N = meta.tiles.N;
  meta.tiles.levels = [{ s: 1, nx: Math.ceil(meta.W / N), ny: Math.ceil(meta.D / N) }];
  meta.world = { formatVersion: FORMAT_VERSION, buildId: 'synthetic' };
  const traffic = { roads: [], peds: [], ctrls: [] };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'traffic.json'), JSON.stringify(traffic));
  return { dir, data: { meta, traffic, boats: null } };
}
