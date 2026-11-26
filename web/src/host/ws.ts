// The host in Node for players over the network: one world on the worker's clock, each WebSocket connection a session
// with a player of its own. A frame either way is JSON: to the page an array of the worker's messages, from it the
// worker's commands message.
import { WebSocketServer, type WebSocket } from 'ws';
import { nodeHost } from './node';
import { hostStart } from './start';
import { clock, handle } from './sim.worker';
import { STEP } from '../sim/road-net';
import type { FromWorker, ToWorker } from '../sim/contract/worker';
import type { Session } from '../sim/server/sim-server';

// Every tick's snapshot is sent by default, two ticks to a message: the page draws between a snapshot's tick and the
// one before, so a snapshot left out shows as a stop and a jump; the batching only halves the messages. ?every=N sends
// every Nth tick's (fewer bytes, judder until the page draws over the gap), one to a message.
const BATCH = 2;
// A socket that has this much unsent gets no snapshots until it drains: a slow phone must not grow the host's memory.
// The events of the ticks it missed come with its next snapshot.
const BACKLOG = 4 << 20;
// Messages smaller than this go uncompressed: a tick's few small changes deflate well too (ws's default, 1024, left
// the phone's small messages raw).
const DEFLATE_FROM = 64;

export interface ServeOptions {
  /** the data directory (meta.json, traffic.json, tiles/) */
  dir: string;
  host: string;
  port: number;
  /** the world's start, as a page's URL gives it to its worker (seed=, dig=1, mode=, ...) */
  query: string;
  log: (line: string) => void;
  /** what ticks the world (default: the worker's clock, real time); a tool steps it itself, in lockstep with its
   * clients, so a busy machine slows the run instead of starving the clients of snapshots */
  clock?: typeof clock;
}

interface Conn { ws: WebSocket; s: Session; out: FromWorker[]; bytes: number; sock: { bytesWritten: number }; wire: number }

export function serve(o: ServeOptions) {
  const start = hostStart(o.query), every = Math.round(start.every ?? 1), flush = Math.max(BATCH, every);
  const server = nodeHost(o.dir, { ...start, world: 'tiles' });
  server.trackEdits();
  const conns = new Set<Conn>();
  const wss = new WebSocketServer({ host: o.host, port: o.port, perMessageDeflate: { zlibDeflateOptions: { level: 1 }, threshold: DEFLATE_FROM } });
  wss.on('error', (e) => o.log(`ws: ${e.message}`));
  const port = new Promise<number>((ok) => wss.on('listening', () => ok(wss.address().port)));
  wss.on('connection', (ws, req) => {
    const c: Conn = { ws, s: server.connect(), out: [], bytes: 0, sock: req.socket, wire: req.socket.bytesWritten };
    conns.add(c);
    o.log(`${c.s.player} joined from ${req.socket.remoteAddress}`);
    ws.send(JSON.stringify([{ kind: 'hello', hello: c.s.hello }, { kind: 'ready' }] satisfies FromWorker[]));
    ws.on('message', (data) => {
      let m: ToWorker;
      try { m = JSON.parse(data.toString()) as ToWorker; } catch { return; }
      if (m?.kind === 'commands' && Array.isArray(m.commands)) handle(c.s, m);
    });
    ws.on('error', () => {});
    ws.on('close', () => { conns.delete(c); c.s.leave(); o.log(`${c.s.player} left`); });
  });

  let n = 0, ticks = 0, tickMs = 0, sendMs = 0;
  const stop = (o.clock ?? clock)(() => {
    const t0 = performance.now();
    server.update(STEP);
    const ms = performance.now() - t0;
    ticks++;
    if (++n % every === 0) for (const c of conns) if (c.ws.bufferedAmount < BACKLOG) c.out.push({ kind: 'snapshot', snapshot: c.s.snapshot(), ms });
    if (n % flush === 0) {
      for (const c of conns) {
        if (!c.out.length) continue;
        const text = JSON.stringify(c.out);
        c.out = [];
        c.ws.send(text);
        c.bytes += text.length;
      }
    }
    tickMs += ms;
    sendMs += performance.now() - t0 - ms;
  });

  return {
    server,
    /** the port it listens on, once it does (port 0: one the system picked) */
    port,
    /** since the last call: the ms per tick (the sim's, the snapshots' and their sending), the bytes sent per player
     * (before the socket's deflate), the bytes the socket wrote per player (deflated, the frames' headers too) */
    stats() {
      const out = { ticks, tickMs: tickMs / (ticks || 1), sendMs: sendMs / (ticks || 1), bytes: [...conns].map((c) => [c.s.player, c.bytes] as const),
        wire: [...conns].map((c) => [c.s.player, c.sock.bytesWritten - c.wire] as const) };
      ticks = 0; tickMs = 0; sendMs = 0;
      for (const c of conns) { c.bytes = 0; c.wire = c.sock.bytesWritten; }
      return out;
    },
    close() {
      stop();
      for (const c of conns) c.ws.close();
      wss.close();
      server.dispose();
    },
  };
}
