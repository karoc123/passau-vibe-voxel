// Not a tool: what the node tools share. imp: a module of web/ (src/..., checks/...) loaded through vite's runner, as
// the viewer's build resolves it; serveTiles: fetch() answering the node files from disk, at the paths VoxelCollision
// fetches (data/tiles/...); sessionLink: a client's link to a host the tool ticks itself.
import fs from 'node:fs';
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
