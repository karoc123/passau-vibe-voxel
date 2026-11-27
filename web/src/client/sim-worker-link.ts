// The page's end of the local server (ADR 0008): a SimLink over a Web Worker. The worker ticks on its own clock and
// posts a snapshot after each tick; the page only sends its commands. The worker's first message is its session's
// hello (handed to the client, onHello); closed (the client refused it): the worker is ended. The same messages reach
// a host on another machine over a WebSocket (SocketLink).
import type { SimLink } from './sim-client';
import type { SimCommand } from '../sim/contract/commands';
import type { Snapshot } from '../sim/contract/snapshot';
import type { FromWorker, ToWorker } from '../sim/contract/worker';
import type { Hello } from '../sim/contract/hello';

export class WorkerLink implements SimLink {
  onHello: (h: Hello) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  private closed = false;
  private readonly worker: Worker;
  /** the worker's time for its last ticks (the tick and the snapshot, ms), for the tools */
  readonly times: number[] = [];

  /** query: the page's URL's search, handed to the host, which reads its start config from it */
  constructor(query: string) {
    this.worker = new Worker(new URL('../host/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.worker.onerror = (e) => console.error('sim worker', e.message);
    this.post({ kind: 'init', base: new URL('.', location.href).href, query });
  }

  private post(m: ToWorker) { if (!this.closed) this.worker.postMessage(m); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
  }

  send(commands: SimCommand[]) { this.post({ kind: 'commands', commands }); }

  /** the page hidden (the world waits) or shown again */
  away(on: boolean) { this.post({ kind: 'away', away: on }); }

  private receive(m: FromWorker) {
    if (!this.closed) receive(this, m);
  }
}

function receive(link: WorkerLink | SocketLink, m: FromWorker) {
  if (m.kind === 'hello') { if (link instanceof SocketLink) link.keep(m.hello.resume?.token ?? null); link.onHello(m.hello); }
  else if (m.kind === 'pong') { if (link instanceof SocketLink) link.pong(m.t); }
  else if (m.kind === 'snapshot') {
    link.times.push(m.ms);
    if (link.times.length > 600) link.times.splice(0, 300);
    link.onSnapshot(m.snapshot);
  }
}

/** how a SocketLink's connection is: up (a host answered), or down (none yet: never reached; or lost) and trying again
 * every RETRY_MS */
export type LinkStatus = { up: true } | { up: false; lost: boolean };

/** how often a SocketLink tries again to reach its host, ms */
export const RETRY_MS = 3000;
// how often it measures the round trip, ms (a ping and its pong: some 60 bytes every PING_MS)
const PING_MS = 2000;
// the round trips the one shown is the median of: one late pong (a long frame, a collection) does not move it
const PINGS = 5;

// where a page keeps its host's token over a reload (a phone's browser reloads a tab it put away): the tab's own store,
// so two tabs are two players
const STORE = 'voxel-resume:';

/** a SimLink to a host over a WebSocket (host/ws.ts): the worker's messages, several to a frame. A host not reached,
 * or lost, is tried again every RETRY_MS: the host's hello then starts a new session (MirrorSimClient), as the same
 * player if the host still holds them (the token of its last hello sent first: ToWorker join) */
export class SocketLink implements SimLink {
  onHello: (h: Hello) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  /** the connection came up or went down (the page says so) */
  onStatus: (s: LinkStatus) => void = () => {};
  private closed = false;
  private ws!: WebSocket;
  private ever = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // (commands sent while the socket opens: a one-off one, e.g. a seat asked for at once, must not be lost; a try
  // that fails drops them, they were the old session's)
  private early: SimCommand[] = [];
  readonly times: number[] = [];
  /** the round trip to the host, ms: the median of the last PINGS (null: none measured on this connection yet) */
  rtt: number | null = null;
  private rtts: number[] = [];
  private pinger: ReturnType<typeof setInterval> | null = null;

  // the token of the host's last hello (never logged: it is the player's seat)
  private token: string | null = null;
  // the page hidden: told to each connection, which then sends no pings
  private hidden = false;

  constructor(readonly url: string) {
    try { this.token = sessionStorage.getItem(STORE + url); } catch { /* (no storage: a tool, a private window) */ }
    this.open();
  }

  /** (receive) the token the host's hello gave: the one to come back with */
  keep(token: string | null) {
    this.token = token;
    try { if (token) sessionStorage.setItem(STORE + this.url, token); else sessionStorage.removeItem(STORE + this.url); } catch { /* (memory only) */ }
  }

  private ping() {
    if (this.ws.readyState === WebSocket.OPEN && !this.hidden) this.ws.send(JSON.stringify({ kind: 'ping', t: performance.now() } satisfies ToWorker));
  }

  /** (receive) a host's answer to a ping */
  pong(t: number) {
    if (!Number.isFinite(t)) return;
    this.rtts.push(Math.max(0, performance.now() - t));
    if (this.rtts.length > PINGS) this.rtts.shift();
    const s = [...this.rtts].sort((a, b) => a - b), h = s.length >> 1;
    this.rtt = s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  private open() {
    const ws = this.ws = new WebSocket(this.url);
    ws.onopen = () => {
      ws.send(JSON.stringify({ kind: 'join', token: this.token } satisfies ToWorker));
      if (this.hidden) ws.send(JSON.stringify({ kind: 'away', away: true } satisfies ToWorker));
      this.ever = true;
      this.onStatus({ up: true });
      this.ping();
      this.pinger ??= setInterval(() => this.ping(), PING_MS);
      if (this.early.length) this.send(this.early.splice(0));
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      if (this.closed) return;
      for (const m of JSON.parse(e.data) as FromWorker[]) receive(this, m);
    };
    ws.onclose = () => {
      if (this.closed || ws !== this.ws) return;
      this.early = [];
      this.rtt = null;
      this.rtts = [];
      this.onStatus({ up: false, lost: this.ever });
      this.timer = setTimeout(() => { this.timer = null; if (!this.closed) this.open(); }, RETRY_MS);
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.ws.close();
  }

  /** the page hidden (its vehicle hands off, no snapshots sent) or shown again (the present sent) */
  away(on: boolean) {
    if (this.hidden === on) return;
    this.hidden = on;
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ kind: 'away', away: on } satisfies ToWorker));
    if (!on) this.ping();
  }

  send(commands: SimCommand[]) {
    if (this.closed) return;
    if (this.ws.readyState === WebSocket.CONNECTING) { this.early.push(...commands); return; }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ kind: 'commands', commands } satisfies ToWorker));
  }
}
