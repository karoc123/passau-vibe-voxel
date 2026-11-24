// The contract between the world sim and its clients (docs/plans/architecture-review.md section 3, layer 1): the
// messages between the page (client/sim-worker-link.ts WorkerLink) and the sim in a Web Worker (host/sim.worker.ts),
// and the road physics' options the page gives the host (host/sim-host.ts HostOptions). Types only
// (tools/core-deps.mjs R5).
import type { SimCommand } from './commands';
import type { SimInput } from './inputs';
import type { Snapshot } from './snapshot';

/** the road physics: bodies: traffic cars near edits become bodies (?lifephys=0: none; the drive still loads it);
 * near, maxBodies: their reach and number (?lpnear=, ?lpmax=) */
export interface PhysicsOptions { bodies: boolean; near?: number; maxBodies?: number }

export type ToWorker =
  | { kind: 'init'; base: string; seed: number; physics: PhysicsOptions; eager: boolean; mode?: string; edits: boolean }
  | { kind: 'frame'; dt: number; input: SimInput; commands: SimCommand[] }
  | { kind: 'loadPhysics'; id: number; warm?: { x: number; z: number } };
export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'snapshot'; snapshot: Snapshot; ms: number }
  | { kind: 'physics'; id: number; ok: boolean; error?: string };
