// A network host's kept things on disk (docs/plans/target-architecture.md step 6), so a restart of the box keeps what
// players left: the world's edits (each edited node's ops), the cars out of the traffic (parked, wrecks) and the crafts
// put down. One JSON file per 256 m cell (<dir>/<cx>_<cz>.json), written whole to a temp file and renamed over the old
// one, so a kill at any moment leaves each cell as it was or as it became. Read back at the host's start; from then
// on the presence rule keeps or drops them as if the host had never stopped (each one seen anew at the start).
// Edits are stored per node (the unit they are made and sent in) with a hash of the node's files: after a data
// rebuild changed a node, its ops would carve the new voxels at old addresses, so that node's edits are dropped.
// A file of another VERSION is moved to <dir>/aside/, not read. Node only (node:fs, node:crypto as host/node.ts takes
// them); the world's edits through core/world-edits.ts as the host's tick makes them.
import { liveEdits } from '../core/live-edits';
import { ready, restoreNow, type WorldOp } from '../core/world-edits';
import { HOST_FILES } from '../core/data-contract';
import type { RoadPose } from '../sim/contract/pose';
import type { CraftType, VehicleId } from '../sim/contract/ids';
import type { WorldSim } from '../sim/world-sim';

/** the files' format; another is set aside at the start */
export const WORLD_VERSION = 1;
// the cell's side (m)
const CELL = 256;

interface Fs {
  readFileSync(p: string): Uint8Array; readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, s: string): void; renameSync(a: string, b: string): void; rmSync(p: string, o?: { force?: boolean }): void;
  existsSync(p: string): boolean; mkdirSync(p: string, o: { recursive: boolean }): void; readdirSync(p: string): string[];
  openSync(p: string, f: string): number; fsyncSync(fd: number): void; closeSync(fd: number): void;
}
interface Hash { update(b: Uint8Array): Hash; digest(e: 'hex'): string }
interface Crypto { createHash(a: string): Hash }
declare const process: { getBuiltinModule(id: string): unknown };
const fs = () => process.getBuiltinModule('node:fs') as Fs;
const crypto = () => process.getBuiltinModule('node:crypto') as Crypto;

type KeptOp = WorldOp & { last?: 1 };
interface KeptCar { len: number; bus: boolean; vt?: VehicleId; col: string; pose: RoadPose }
interface KeptCraft { type: CraftType; x: number; y: number; z: number; h: number; speed: number }
/** a cell's kept things: its edited nodes ("tx_ty": the hash of their files, their ops as indices into ops, in order) */
interface Cell { nodes: Record<string, { hash: string; ops: number[] }>; ops: KeptOp[]; cars: KeptCar[]; crafts: KeptCraft[] }
interface CellFile extends Cell { v: number; at: number }

export interface WorldStoreOptions {
  /** where the cells' files live */
  dir: string;
  /** the data directory (its level-1 node files hashed) */
  data: string;
  sim: WorldSim;
  /** a level-1 node's side (m) */
  N: number;
  log: (line: string) => void;
  /** the most bytes on disk; over it the cells changed longest ago are not kept (a warning) */
  max: number;
  /** the wall clock, ms */
  now?: () => number;
}

const cm = (v: number) => Math.round(v * 100) / 100;
const cellOf = (x: number, z: number) => `${Math.floor(x / CELL)}_${Math.floor(z / CELL)}`;

export function worldStore(o: WorldStoreOptions) {
  const F = fs(), now = o.now ?? (() => Date.now()), aside = `${o.dir}/aside`;
  F.mkdirSync(o.dir, { recursive: true });
  // what each cell's file holds now (its body without `at`), when it last changed; the cells left off the disk by the
  // cap (not written again while they stay so)
  const written = new Map<string, { body: string; at: number }>(), trimmed = new Map<string, string>();
  const hashes = new Map<string, string>();
  const nodeHash = (k: string): string => {
    let h = hashes.get(k);
    if (h === undefined) {
      const c = crypto().createHash('sha1');
      for (const s of ['1', '1f']) {
        const p = `${o.data.replace(/\/+$/, '')}/${HOST_FILES.tiles}${s}/${k}.bin`;
        c.update(F.existsSync(p) ? F.readFileSync(p) : new Uint8Array(0));
      }
      h = c.digest('hex').slice(0, 16);
      hashes.set(k, h);
    }
    return h;
  };

  // the kept things as they are, by cell
  function collect() {
    const cells = new Map<string, Cell>(), S = o.sim;
    const cell = (k: string) => { let c = cells.get(k); if (!c) cells.set(k, c = { nodes: {}, ops: [], cars: [], crafts: [] }); return c; };
    const index = new Map<Cell, Map<WorldOp, number>>();
    for (const [tx, ty, node] of liveEdits.entries()) {
      if (!node.ops?.length) continue;
      const c = cell(cellOf((tx + 0.5) * o.N, (ty + 0.5) * o.N)), at = index.get(c) ?? new Map<WorldOp, number>();
      index.set(c, at);
      const ops = node.ops.map((op) => {
        let i = at.get(op);
        if (i === undefined) { at.set(op, i = c.ops.length); c.ops.push(S.lasts(op) ? { ...op, last: 1 } : { ...op }); }
        return i;
      });
      c.nodes[`${tx}_${ty}`] = { hash: nodeHash(`${tx}_${ty}`), ops };
    }
    for (const car of S.traffic.detachedCars) {
      const p = car.detachedPose;
      if (!p) continue;
      const pose = { x: cm(p.x), y: cm(p.y), z: cm(p.z), h: cm(p.h), pitch: cm(p.pitch), roll: cm(p.roll) };
      cell(cellOf(p.x, p.z)).cars.push({ len: car.len, bus: car.bus, ...(car.vt ? { vt: car.vt } : {}), col: car.col, pose });
    }
    for (const c of S.crafts.values()) {
      if (!c.placed) continue;
      const p = c.core.pose, v = c.core.velocity;
      cell(cellOf(p.x, p.z)).crafts.push({ type: c.type, x: cm(p.x), y: cm(p.y), z: cm(p.z), h: cm(p.h), speed: cm(Math.hypot(v.x, v.y, v.z)) });
    }
    return cells;
  }

  // file written whole, then renamed over the old: a kill leaves the old or the new, never a torn one
  const put = (name: string, text: string) => {
    const tmp = `${o.dir}/${name}.tmp`;
    F.writeFileSync(tmp, text);
    const fd = F.openSync(tmp, 'r');
    try { F.fsyncSync(fd); } finally { F.closeSync(fd); }
    F.renameSync(tmp, `${o.dir}/${name}`);
  };

  /** the cells that changed written, those emptied removed, the disk kept under max (oldest changes first off) */
  function save() {
    const cells = collect(), t = now();
    const bodies = new Map<string, string>();
    for (const [k, c] of cells) bodies.set(k, JSON.stringify(c));
    for (const k of [...written.keys()]) if (!bodies.has(k)) { F.rmSync(`${o.dir}/${k}.json`, { force: true }); written.delete(k); }
    for (const k of [...trimmed.keys()]) if (bodies.get(k) !== trimmed.get(k)) trimmed.delete(k);
    const order = [...bodies].map(([k, body]) => ({ k, body, at: written.get(k)?.body === body ? written.get(k)!.at : t }))
      .filter((c) => !trimmed.has(c.k));
    let total = order.reduce((s, c) => s + c.body.length, 0), cut = 0;
    if (total > o.max) {
      order.sort((a, b) => a.at - b.at);
      while (total > o.max && order.length) {
        const c = order.shift()!;
        total -= c.body.length;
        trimmed.set(c.k, c.body);
        if (written.delete(c.k)) F.rmSync(`${o.dir}/${c.k}.json`, { force: true });
        cut++;
      }
      o.log(`world: over ${(o.max / 1048576).toFixed(0)} MB on disk; ${cut} cell(s) changed longest ago not kept (they stay until the host stops)`);
    }
    let wrote = 0;
    for (const c of order) {
      if (written.get(c.k)?.body === c.body) continue;
      put(`${c.k}.json`, `{"v":${WORLD_VERSION},"at":${c.at},${c.body.slice(1)}`);
      written.set(c.k, { body: c.body, at: c.at });
      wrote++;
    }
    return wrote;
  }

  const setAside = (name: string, why: string) => {
    F.mkdirSync(aside, { recursive: true });
    F.renameSync(`${o.dir}/${name}`, `${aside}/${now()}-${name}`);
    o.log(`world: ${name} set aside (${why}) in ${aside}`);
  };

  /** the cells read back into the world: their edits (a node whose files changed dropped), cars and crafts */
  async function load() {
    const S = o.sim, ops = new Map<string, WorldOp>(), nodes: [number, number, WorldOp[]][] = [];
    let cars = 0, crafts = 0, dropped = 0;
    for (const name of F.readdirSync(o.dir)) {
      // (a temp file a kill left before its rename: the cell's file is the one before it)
      if (name.endsWith('.tmp')) { F.rmSync(`${o.dir}/${name}`, { force: true }); continue; }
      const m = /^(-?\d+_-?\d+)\.json$/.exec(name);
      if (!m) continue;
      let f: CellFile;
      try { f = JSON.parse(F.readFileSync(`${o.dir}/${name}`, 'utf8')) as CellFile; } catch (e) { setAside(name, `unreadable: ${(e as Error).message}`); continue; }
      if (f?.v !== WORLD_VERSION) { setAside(name, `format ${f?.v}, this host reads ${WORLD_VERSION}`); continue; }
      const { v: _v, at, ...cell } = f;
      written.set(m[1], { body: JSON.stringify(cell), at });
      // (an op shared by nodes, in two cells' files too, made one object again: the keeper drops such nodes together)
      const own = cell.ops.map((op) => {
        const { last, ...plain } = op, key = JSON.stringify(plain);
        let one = ops.get(key);
        if (!one) ops.set(key, one = plain as WorldOp);
        if (last) S.lasts(one, true);
        return one;
      });
      for (const [k, n] of Object.entries(cell.nodes)) {
        if (n.hash !== nodeHash(k)) { o.log(`world: node ${k}'s files changed (a data rebuild): its ${n.ops.length} edit(s) dropped`); dropped++; continue; }
        const [tx, ty] = k.split('_').map(Number);
        nodes.push([tx, ty, n.ops.map((i) => own[i])]);
      }
      for (const c of cell.cars) if (S.traffic.parkAgain(c, c.pose)) cars++;
      for (const c of cell.crafts) {
        try {
          const craft = S.addCraft(c.type);
          S.placeCraft(craft.id, { x: c.x, y: c.y, z: c.z, h: c.h, speed: c.speed, water: c.speed < 2 });
          crafts++;
        } catch (e) { o.log(`world: a ${c.type} not put back: ${(e as Error).message}`); }
      }
    }
    for (const [tx, ty, list] of nodes) {
      const release = await ready([[tx, ty]]);
      try { if (!restoreNow(tx, ty, list)) o.log(`world: node ${tx}_${ty} not in the data: its edits dropped`); } finally { release(); }
    }
    o.log(`world: ${nodes.length} edited node(s), ${cars} car(s), ${crafts} craft(s) read back from ${o.dir}${dropped ? `; ${dropped} node(s) dropped` : ''}`);
  }

  return { load, save };
}
