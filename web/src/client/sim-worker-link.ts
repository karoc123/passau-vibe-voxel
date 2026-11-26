// The page's end of the local server (host/sim.worker.ts; ADR 0008): a SimLink
// (client/sim-client.ts) over a Web Worker; the messages: sim/contract/worker.ts. One frame in flight at a time: while
// the worker works on one, the page's frames add their time and commands to the next, sent when its snapshot is back
// (so a slow sim slows the sim, never the page). The page draws the latest snapshot: one update behind the frame that
// sent the input. The worker's first message is its session's hello (handed to the client, onHello); closed (the
// client refused it): the worker is ended.
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
  private busy = false;
  private dt = 0;
  private commands: SimCommand[] = [];
  /** the worker's time for the last frames (update and snapshot, ms), for the tools */
  readonly times: number[] = [];

  /** query: the page's URL's search, handed to the host, which reads its start config from it (host/start.ts) */
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

  frame(dt: number, commands: SimCommand[]) {
    this.dt += dt;
    this.commands.push(...commands);
    if (!this.busy) this.flush();
  }

  private flush() {
    this.busy = true;
    this.post({ kind: 'frame', dt: this.dt, commands: this.commands });
    this.dt = 0;
    this.commands = [];
  }

  private receive(m: FromWorker) {
    if (this.closed) return;
    if (m.kind === 'hello') this.onHello(m.hello);
    else if (m.kind === 'snapshot') {
      this.busy = false;
      this.times.push(m.ms);
      if (this.times.length > 600) this.times.splice(0, 300);
      this.onSnapshot(m.snapshot);
      // (the frames sent meanwhile go at once: the next snapshot is not a page frame late)
      if (this.dt > 0) this.flush();
    }
  }
}
