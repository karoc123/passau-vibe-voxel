// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md): the hello, the first
// thing a host tells a client when its session connects, before any snapshot. The client compares it with its own
// (sim/hello.ts checkHello) and refuses a host that differs: a mirror re-runs the sim's path maths on its own data, so
// both ends must speak the same protocol and have loaded the same data build. The tuning the page runs with (the
// crafts' cores, the own car) is the host's, sent in the hello: a host may run with other numbers. Types and constants
// only (tools/core-deps.mjs R5).
import type { DataBuild } from '../../core/data-contract';

/** the wire protocol's number, bumped by hand: when what crosses changes shape or meaning (a field of a snapshot, a
 * command, an event, a worker message or a craft's wire state in sim/contract/ added, renamed, removed or read
 * differently; or the sim's code a mirror re-runs: the path maths behind CarState, a core's load), so that a client
 * and a host of different code refuse each other instead of drawing nonsense. Not for the data (that is build) nor
 * for the tuning's numbers (the hello carries them) */
export const PROTOCOL = 52;

/** what a host says when a session connects (SimServer.hello; the worker's FromWorker 'hello') */
export interface Hello {
  /** the host's PROTOCOL */
  protocol: number;
  /** the data build the host loaded (meta.json world; null: a build older than scripts/world_id.py) */
  build: DataBuild | null;
  /** the parts of its sim's tuning the page runs with (sim/tuning.ts ClientTuning: typed there, as the tuning's types
   * are the sim's, which the contract does not import) */
  tuning: unknown;
  /** a network host's (host/ws.ts): the token this session's page joins with again after its connection drops, to
   * come back as the same player, and whether this session is such a coming back (the player's seat and name kept).
   * The page's own worker gives none: its connection does not drop */
  resume?: { token: string; resumed: boolean };
}
