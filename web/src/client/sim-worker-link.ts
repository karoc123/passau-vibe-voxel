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

  private receive(m: FromWorker) {
    if (!this.closed) receive(this, m);
  }
}

function receive(link: WorkerLink | SocketLink, m: FromWorker) {
  if (m.kind === 'hello') link.onHello(m.hello);
  else if (m.kind === 'snapshot') {
    link.times.push(m.ms);
    if (link.times.length > 600) link.times.splice(0, 300);
    link.onSnapshot(m.snapshot);
  }
}

/** a SimLink to a host over a WebSocket (host/ws.ts): the worker's messages, several to a frame */
export class SocketLink implements SimLink {
  onHello: (h: Hello) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  private closed = false;
  private readonly ws: WebSocket;
  // (commands sent before the socket is open: a one-off one, e.g. a seat asked for at once, must not be lost)
  private early: SimCommand[] = [];
  readonly times: number[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => { if (this.early.length) this.send(this.early.splice(0)); };
    this.ws.onmessage = (e: MessageEvent<string>) => {
      if (this.closed) return;
      for (const m of JSON.parse(e.data) as FromWorker[]) receive(this, m);
    };
    this.ws.onclose = () => { if (!this.closed) console.error(`sim host ${url}: connection closed`); };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }

  send(commands: SimCommand[]) {
    if (this.closed) return;
    if (this.ws.readyState === WebSocket.CONNECTING) { this.early.push(...commands); return; }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ kind: 'commands', commands } satisfies ToWorker));
  }
}
