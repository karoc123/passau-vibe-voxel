// The hello (sim/contract/hello.ts; docs/adr/0009-layers-and-owners.md): made by the host (sim/server/sim-server.ts
// SimServer.hello, from the data build hostSim checked and the sim's tuning), compared by the client with its own
// (client/sim-client.ts MirrorSimClient). Shared by both ends: no three.js, no DOM.
//   tuningHash  the tuning a client must share with its host, hashed: of sim/tuning.ts Tuning the parts a client runs
//               (CLIENT_TUNING: the crafts' motion laws, a mirror's cores are made with them, client/sim-client.ts) and
//               the crafts' scale (CRAFT_SCALE: their collision); not the host's own (the cars' ride: the road physics;
//               the edits' keeping; the walk's bounds: the host checks them). Its JSON with the keys sorted, through a
//               53-bit string hash (cyrb53); kept per value. A craft's numbers that are code, not tuning (the drone's,
//               sim/craft/fpv-flight.ts), are the protocol's: PROTOCOL bumped when they change
//   hello       a hello of this code: PROTOCOL, the build, the tuning's hash
//   helloMismatch, checkHello  what differs (null: nothing); the error a client refuses with
import type { DataBuild } from '../core/data-contract';
import { PROTOCOL, type Hello } from './contract/hello';
import { CRAFT_SCALE } from './craft/craft-motion';
import { DEFAULT_TUNING, type Tuning } from './tuning';

/** the parts of the tuning a client runs as the host does (sim/craft/cores.ts: the cores a mirror loads) */
export const CLIENT_TUNING = ['boat', 'plane', 'jet', 'craft'] as const satisfies readonly (keyof Tuning)[];

const hashes = new WeakMap<Tuning, string>();

/** the hash of the tuning's client parts (with the crafts' scale): the same numbers give the same string, in any process */
export function tuningHash(tuning: Tuning = DEFAULT_TUNING): string {
  let h = hashes.get(tuning);
  if (h === undefined) {
    const shared = Object.fromEntries(CLIENT_TUNING.map((k) => [k, tuning[k]]));
    hashes.set(tuning, h = cyrb53(stableJson({ tuning: shared, craftScale: CRAFT_SCALE })));
  }
  return h;
}

/** a hello of this code: its protocol, the build given (core/data-contract.ts checkBuild), the tuning's hash */
export function hello(build: DataBuild | null, tuning: Tuning = DEFAULT_TUNING): Hello {
  return { protocol: PROTOCOL, build: build && { formatVersion: build.formatVersion, buildId: build.buildId }, tuning: tuningHash(tuning) };
}

/** what differs between the host's hello and the client's own, said; null if they match */
export function helloMismatch(host: Hello, mine: Hello): string | null {
  const out: string[] = [];
  if (host.protocol !== mine.protocol) out.push(`protocol ${host.protocol}, this client speaks ${mine.protocol}`);
  const b = (x: DataBuild | null) => (x ? `${x.buildId} (format ${x.formatVersion})` : 'none');
  if (b(host.build) !== b(mine.build)) out.push(`data build ${b(host.build)}, this client loaded ${b(mine.build)}`);
  if (host.tuning !== mine.tuning) out.push(`tuning ${host.tuning}, this client's ${mine.tuning}`);
  return out.length ? `the host's ${out.join('; ')}` : null;
}

/** the host's hello if it matches the client's own; else the error the client refuses it with */
export function checkHello(host: Hello, mine: Hello): Error | null {
  const m = helloMismatch(host, mine);
  return m ? new Error(`sim: host refused: ${m}. Reload the page (or run the tool) against a host of the same code and data`) : null;
}

// JSON with every object's keys sorted (numbers as JSON writes them: the same in every engine)
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// cyrb53 (public domain): a fast 53-bit string hash, as 14 hex digits
function cyrb53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
