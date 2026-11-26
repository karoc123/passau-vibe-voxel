// The page's end of the local server (ADR 0008): a SimLink over a Web Worker. The worker ticks on its own clock and
// posts a snapshot after each tick; the page only sends its commands. The worker's first message is its session's
// hello (handed to the client, onHello); closed (the client refused it): the worker is ended.
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
    if (this.closed) return;
    if (m.kind === 'hello') this.onHello(m.hello);
    else if (m.kind === 'snapshot') {
      this.times.push(m.ms);
      if (this.times.length > 600) this.times.splice(0, 300);
      this.onSnapshot(m.snapshot);
    }
  }
}
