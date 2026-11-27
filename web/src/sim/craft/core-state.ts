// The check that a craft core's declared wire state is complete (docs/adr/0009-layers-and-owners.md): each core says
// what crosses (save(), load(): sim/craft/craft-core.ts, contract/crafts.ts); this looks at everything it holds by
// reflection (saveState: its fields and its motion's or flight's, numbers, strings, vectors, its clock; not functions,
// frozen objects such as its tuning, maps and sets, the collision) and finds what differs on a client's copy loaded from
// save(), but for what is listed below as not on the wire on purpose. A field added to a core and neither saved nor
// listed is found here (tools/craft-motion.mjs runs it for every craft type, each field stirred first). Not used at
// run time. No three.js, no DOM (tools/core-deps.mjs).
import type { CraftType } from '../contract/ids';
import type { CraftCore } from './craft-core';
import { VoxelCollision } from './voxel-collision';

const SKIP = new Set(['events', 'worlds', 'col']);

/** what a core holds that is not on the wire, by its paths (a prefix covers what is under it), and why */
const COMMON = [
  'clock', // the steps' (the server's; a client's copy is never stepped)
  'reach', 'neutral', // its collision's cube, its empty seat's input: from its type and tuning (the same on both sides)
  'tank.burnt', // each side's own below a whole step (only whole steps cross: fuel goes down slowly)
];
// (no tank: its level never moves)
const TANKLESS = 'tank.level';
export const NOT_ON_THE_WIRE: Record<CraftType, readonly string[]> = (() => {
  const boat = [...COMMON, 'motion.accel', 'motion.bumpT', // the steps' (the thrust followed, a bump's pause)
    'motion.safe', 'motion.outline']; // unstick's trail (the server's); the hull, from its tuning
  const special = [...COMMON, 'kind', 'motion.kind', // its type (the client makes its copy by type)
    'motion.delta', 'motion.raised']; // the steps' scratch
  const plane = [...COMMON, 'v', 'up', 'now', 'out', 'qa', 'qb', // drawn(), velocity's and nose's scratch
    'flight.crashLeft', 'flight.crashAt', 'flight.safe', 'flight.start', 'flight.clock', // the respawn's (the server's)
    'flight.d', 'flight.q', // the steps' scratch
    'flight.ahead']; // whether this copy runs ahead on a page (the copy's own, not the craft's)
  return {
    boat, hovercraft: special, helicopter: special, gunship: special, paraglider: [...special, TANKLESS], floatplane: plane, jet: plane, fighter: plane,
    drone: [...COMMON, TANKLESS, 'next', 'glide', 'out', // the steps', drawn()'s scratch
      'flight.rotationAxis', 'flight.rotationDelta', 'flight.acceleration', 'flight.displacement', 'flight.impactNormal',
      'flight.priorAttitude', 'flight.priorVelocity', // the steps' scratch
      'flight.impactSpin'], // the spin after a hit, decaying in the steps (the server's)
  };
})();

const kept = (v: unknown): v is object => !!v && typeof v === 'object' && !Object.isFrozen(v) && !(v instanceof Map) &&
  !(v instanceof Set) && !(v instanceof WeakMap) && !(v instanceof WeakSet) && !(v instanceof VoxelCollision);

/** o's state by reflection: plain data (structured-cloneable) */
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

/** state (saveState's) written into o by reflection: objects kept and filled, the rest replaced */
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

const local = (type: CraftType, path: string) => NOT_ON_THE_WIRE[type].some((l) => path === l || path.startsWith(`${l}.`));

/** every leaf of a core's state (saveState's; not what is not on the wire) set to a value of its own (numbers from
 * seed up, booleans flipped, strings marked), so a field the wire leaves out shows on a copy */
export function stir(type: CraftType, core: CraftCore, seed = 1) {
  let n = seed;
  const leaf = (v: unknown, path: string): unknown => {
    if (local(type, path)) return undefined;
    if (typeof v === 'number') return (n += 1.25);
    if (typeof v === 'boolean') return !v;
    if (typeof v === 'string') return `${v}~${n++}`;
    if (Array.isArray(v)) return v.map((x, i) => leaf(x, `${path}.${i}`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, leaf(x, path ? `${path}.${k}` : k)]));
    return v;
  };
  loadState(core, leaf(saveState(core), '') as Record<string, unknown>);
}

/** the paths in state (a core's save()) that are objects of the core's own (the wire state must be a copy) */
export function aliased(core: CraftCore, state: unknown): string[] {
  const mine = new Set<object>(), out: string[] = [];
  const own = (o: unknown) => {
    if (!o || typeof o !== 'object' || mine.has(o) || !kept(o)) return;
    mine.add(o);
    for (const v of Object.values(o)) own(v);
  };
  own(core);
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== 'object') return;
    if (mine.has(v)) out.push(path);
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(state, '');
  return out;
}

/** the paths where copy (a fresh core of type, load()ed from core's save()) differs from core by reflection, but for
 * NOT_ON_THE_WIRE[type] */
export function wireGaps(type: CraftType, core: CraftCore, copy: CraftCore): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (local(type, path)) return;
    if (a && typeof a === 'object' && b && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    } else if (!Object.is(a, b)) out.push(path);
  };
  walk(saveState(core), saveState(copy), '');
  return out;
}
