// The page's end of the local server (sim.worker.ts; docs/plans/local-server.md): a SimLink (sim/sim-client.ts) over
// a Web Worker. One frame in flight at a time: while the worker works on one, the page's frames add their time and
// commands to the next, sent when its snapshot is back (so a slow sim slows the sim, never the page). The page draws
// the latest snapshot: one update behind the frame that sent the input.
import type { SimCommand, SimLink } from './sim/sim-client';
import type { Snapshot } from './sim/snapshot';
import type { PlayerId, SimInput } from './sim/world-sim';
import type { FromWorker, ToWorker } from './sim.worker';
import type { HostOptions } from './sim-host';

export class WorkerLink implements SimLink {
  onSnapshot: (s: Snapshot) => void = () => {};
  private readonly worker: Worker;
  private busy = false;
  private dt = 0;
  private input: SimInput | null = null;
  private commands: SimCommand[] = [];
  private nextId = 1;
  private readonly physics = new Map<number, { done: () => void; fail: (e: unknown) => void }>();
  /** the worker's time for the last frames (update and snapshot, ms), for the tools */
  readonly times: number[] = [];

  constructor(opts: { seed: number; physics: Omit<HostOptions['physics'], 'at'>; eager: boolean; mode?: string; edits: boolean; player: PlayerId }) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.worker.onerror = (e) => console.error('sim worker', e.message);
    this.post({ kind: 'init', base: new URL('.', location.href).href, ...opts });
  }

  private post(m: ToWorker) { this.worker.postMessage(m); }

  frame(dt: number, input: SimInput, commands: SimCommand[]) {
    this.dt += dt;
    this.input = input;
    this.commands.push(...commands);
    if (!this.busy) this.flush();
  }

  private flush() {
    if (!this.input) return;
    this.busy = true;
    this.post({ kind: 'frame', dt: this.dt, input: this.input, commands: this.commands });
    this.dt = 0;
    this.commands = [];
  }

  loadPhysics(warm?: { x: number; z: number }) {
    const id = this.nextId++;
    return new Promise<void>((done, fail) => {
      this.physics.set(id, { done, fail });
      this.post({ kind: 'loadPhysics', id, warm });
    });
  }

  private receive(m: FromWorker) {
    if (m.kind === 'snapshot') {
      this.busy = false;
      this.times.push(m.ms);
      if (this.times.length > 600) this.times.splice(0, 300);
      this.onSnapshot(m.snapshot);
      // (the frames sent meanwhile go at once: the next snapshot is not a page frame late)
      if (this.dt > 0) this.flush();
    } else if (m.kind === 'physics') {
      const p = this.physics.get(m.id);
      this.physics.delete(m.id);
      if (m.ok) p?.done(); else p?.fail(new Error(m.error));
    }
  }
}
