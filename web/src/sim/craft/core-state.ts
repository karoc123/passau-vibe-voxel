// A craft core's state as a snapshot carries it (sim/server/snapshot.ts): saveState copies what its fields hold (numbers,
// strings, vectors, its motion's or flight's fields, its clock), loadState writes that into a core of the same class
// on the client, which is never stepped: its pose, drawn(alpha), motion and flight read as on the sim's. Left out:
// functions, frozen objects (its tuning, the same on both sides), maps and sets (caches), the collision it steps
// through, the events (sent apart). No three.js, no DOM (tools/core-deps.mjs).
import { VoxelCollision } from './voxel-collision';

const SKIP = new Set(['events', 'worlds', 'col']);

const kept = (v: unknown): v is object => !!v && typeof v === 'object' && !Object.isFrozen(v) && !(v instanceof Map) &&
  !(v instanceof Set) && !(v instanceof WeakMap) && !(v instanceof WeakSet) && !(v instanceof VoxelCollision);

/** o's state: plain data (structured-cloneable) */
export function saveState(o: object, seen = new Set<object>()): Record<string, unknown> {
  seen.add(o);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k) || typeof v === 'function') continue;
    out[k] = saveValue(v, seen);
  }
  return out;
}

function saveValue(v: unknown, seen: Set<object>): unknown {
  if (!v || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): unknown }).slice();
  if (!kept(v) || seen.has(v)) return undefined;
  if (Array.isArray(v)) return v.map((x) => saveValue(x, seen));
  return saveState(v, seen);
}

/** state (saveState's) written into o, a core of the same class: objects kept and filled, the rest replaced */
export function loadState(o: object, state: Record<string, unknown>) {
  const t = o as Record<string, unknown>;
  for (const [k, v] of Object.entries(state)) {
    if (v === undefined) continue;
    const cur = t[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && kept(cur) && !Array.isArray(cur)) {
      loadState(cur, v as Record<string, unknown>);
    } else if (ArrayBuffer.isView(cur) && ArrayBuffer.isView(v)) (cur as unknown as { set(a: unknown): void }).set(v);
    else if (!(cur && typeof cur === 'object' && Object.isFrozen(cur))) t[k] = v;
  }
}
