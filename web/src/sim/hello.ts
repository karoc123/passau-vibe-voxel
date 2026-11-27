// The hello (sim/contract/hello.ts; docs/adr/0009-layers-and-owners.md): made by the host (sim/server/sim-server.ts
// SimServer.hello, from the data build hostSim checked and the sim's tuning), compared by the client with its own
// (client/sim-client.ts MirrorSimClient). Shared by both ends: no three.js, no DOM.
//   hello       a hello of this code: PROTOCOL, the build, the tuning's client parts (sim/tuning.ts ClientTuning). A
//               craft's numbers that are code, not tuning (its step, its laws' shape, its scale), are the protocol's:
//               PROTOCOL bumped when they change
//   helloMismatch, checkHello  what differs (null: nothing); the error a client refuses with
import type { DataBuild } from '../core/data-contract';
import { PROTOCOL, type Hello } from './contract/hello';
import { DEFAULT_TUNING, type ClientTuning, type Tuning } from './tuning';

/** a hello of this code: its protocol, the build given (core/data-contract.ts checkBuild), the tuning's client parts */
export function hello(build: DataBuild | null, t: Tuning = DEFAULT_TUNING): Hello & { tuning: ClientTuning } {
  const tuning: ClientTuning = { ride: t.ride, boat: t.boat, plane: t.plane, jet: t.jet, craft: t.craft, drone: t.drone, fuel: t.fuel };
  return { protocol: PROTOCOL, build: build && { formatVersion: build.formatVersion, buildId: build.buildId }, tuning };
}

/** what differs between the host's hello and the client's own, said; null if they match (the tuning is the host's) */
export function helloMismatch(host: Hello, mine: Pick<Hello, 'protocol' | 'build'>): string | null {
  const out: string[] = [];
  if (host.protocol !== mine.protocol) out.push(`protocol ${host.protocol}, this client speaks ${mine.protocol}`);
  const b = (x: DataBuild | null) => (x ? `${x.buildId} (format ${x.formatVersion})` : 'none');
  if (b(host.build) !== b(mine.build)) out.push(`data build ${b(host.build)}, this client loaded ${b(mine.build)}`);
  return out.length ? `the host's ${out.join('; ')}` : null;
}

/** the host's hello if it matches the client's own; else the error the client refuses it with */
export function checkHello(host: Hello, mine: Pick<Hello, 'protocol' | 'build'>): Error | null {
  const m = helloMismatch(host, mine);
  return m ? new Error(`sim: host refused: ${m}. Reload the page (or run the tool) against a host of the same code and data`) : null;
}
