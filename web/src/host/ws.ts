// The host in Node for players over the network: one world on the worker's clock, each WebSocket connection a session
// with a player of its own. A frame either way is JSON: to the page an array of the worker's messages, from it the
// worker's commands message.
import { WebSocketServer, type WebSocket } from 'ws';
import { nodeHost } from './node';
import { hostStart } from './start';
import { clock, handle } from './sim.worker';
import { STEP } from '../sim/road-net';
import { Overload } from './overload';
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

// At the third step of giving way (host/overload.ts) a session gets every second tick's snapshot, the sessions in turn
// so each tick builds half of them, unless its player sits in a vehicle (the snapshot carries it: drawn from every
// tick's) or fired within the last second (what the shots strike near them). Sent whole, the wire unchanged: the
// events and the agents' drift of the tick left out come with the next.
const FIRED = 1;

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

interface Conn { ws: WebSocket; s: Session; out: FromWorker[]; bytes: number; sock: { bytesWritten: number }; wire: number; turn: number; fired: number }

export function serve(o: ServeOptions) {
  const start = hostStart(o.query), every = Math.round(start.every ?? 1), flush = Math.max(BATCH, every);
  const server = nodeHost(o.dir, { ...start, world: 'tiles', offThread: true });
  server.trackEdits();
  const conns = new Set<Conn>();
  let joined = 0, n = 0;
  const wss = new WebSocketServer({ host: o.host, port: o.port, perMessageDeflate: { zlibDeflateOptions: { level: 1 }, threshold: DEFLATE_FROM } });
  wss.on('error', (e) => o.log(`ws: ${e.message}`));
  const port = new Promise<number>((ok) => wss.on('listening', () => ok(wss.address().port)));
  wss.on('connection', (ws, req) => {
    const c: Conn = { ws, s: server.connect(), out: [], bytes: 0, sock: req.socket, wire: req.socket.bytesWritten, turn: joined++, fired: -Infinity };
    conns.add(c);
    o.log(`${c.s.player} joined from ${req.socket.remoteAddress}`);
    ws.send(JSON.stringify([{ kind: 'hello', hello: c.s.hello }, { kind: 'ready' }] satisfies FromWorker[]));
    ws.on('message', (data) => {
      let m: ToWorker;
      try { m = JSON.parse(data.toString()) as ToWorker; } catch { return; }
      // (answered at once, outside the tick's batch: the round trip the page shows is the network's, not the tick's)
      if (m?.kind === 'ping') { if (Number.isFinite(m.t)) ws.send(JSON.stringify([{ kind: 'pong', t: m.t }] satisfies FromWorker[])); return; }
      if (m?.kind !== 'commands' || !Array.isArray(m.commands)) return;
      if (m.commands.some((x) => x?.kind === 'fire')) c.fired = n;
      handle(c.s, m);
    });
    ws.on('error', () => {});
    ws.on('close', () => { conns.delete(c); c.s.leave(); o.log(`${c.s.player} left`); });
  });

  let ticks = 0, tickMs = 0, sendMs = 0;
  const per = Math.round(1 / STEP), load = new Overload(server.sim.traffic, 3, per, STEP * 1000);
  // (a vehicle's seat: any but on foot)
  // (n / every: the ticks sent at all under ?every=)
  const full = (c: Conn) => load.every === 1 || (n / every + c.turn) % load.every === 0 || n - c.fired < FIRED * per
    || (server.sim.seat(c.s.player)?.role ?? 'walker') !== 'walker';
  const stop = (o.clock ?? clock)(() => {
    const t0 = performance.now();
    server.update(STEP);
    const ms = performance.now() - t0;
    ticks++;
    // (ms to 0.1: its 15 digits were ~0.7 kB/s a player)
    const ms10 = Math.round(ms * 10) / 10;
    if (++n % every === 0) for (const c of conns) if (c.ws.bufferedAmount < BACKLOG && full(c)) c.out.push({ kind: 'snapshot', snapshot: c.s.snapshot(), ms: ms10 });
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
    load.tick(performance.now() - t0);
  });

  return {
    server,
    /** the world's node files (TileCache): its loads and size, for the tools */
    tiles: server.cache,
    /** the port it listens on, once it does (port 0: one the system picked) */
    port,
    /** how it gives way over its tick (its levels; a tool sets its budget to force or end an overload) */
    load,
    /** since the last call: the ms per tick (the sim's, the snapshots' and their sending), the bytes sent per player
     * (before the socket's deflate), the bytes the socket wrote per player (deflated, the frames' headers too); now:
     * the levels given way to (Overload levels) */
    stats() {
      const out = { ticks, tickMs: tickMs / (ticks || 1), sendMs: sendMs / (ticks || 1), ...load.levels, bytes: [...conns].map((c) => [c.s.player, c.bytes] as const),
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
