// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): the
// messages between the page (client/sim-worker-link.ts WorkerLink) and the sim in a Web Worker (host/sim.worker.ts),
// and the road physics' options a host starts with (host/start.ts HostStart). Types only (tools/core-deps.mjs R5).
import type { SimCommand } from './commands';
import type { Hello } from './hello';
import type { Snapshot } from './snapshot';

/** the road physics: bodies: traffic cars near edits become bodies (?lifephys=0: none; the drive still loads it);
 * near, maxBodies: their reach and number (?lpnear=, ?lpmax=); look: the bodies look ahead (default: yes;
 * tools/life-phys.mjs --no-look) */
export interface PhysicsOptions { bodies: boolean; near?: number; maxBodies?: number; look?: boolean }

export type ToWorker =
  // (base: where the data is; query: the page's URL's search, which the host reads its start config from:
  // host/start.ts hostStart)
  | { kind: 'init'; base: string; query: string }
  | { kind: 'frame'; dt: number; commands: SimCommand[] };
export type FromWorker =
  | { kind: 'hello'; hello: Hello } // (first, once the session is connected: before ready and any snapshot)
  | { kind: 'ready' }
  | { kind: 'snapshot'; snapshot: Snapshot; ms: number };
