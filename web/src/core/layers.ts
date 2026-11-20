// The world's layers (docs/adr/0001-world-layers.md, 0002-addressing.md):
//   L0  the base build: the node files of one pipeline build (its buildId), never changed
//   L1  persistent edits: players' building, kept by the server, replayed over every load
//   L2  transient edits: destruction, applied over L0 + L1 while a node is loaded and gone when it is loaded again;
//       never in the distance levels (2, 4, 8 m), which show L0 (+ L1 once the server downsamples it)
// An edit (WorldOp) is addressed in the project grid (scripts/map.json: column = easting - grid.x0, row = grid.y0 -
// northing) and absolute height (metres a.s.l. of the cell's bottom), never in a build's map cells or tile-relative z:
// a build that grows the map (meta.json origin) or lowers the floor (meta.json base) keeps every edit in its place.
// The colour is a palette id (meta.json palette), stable across builds: the palette is append-only.
// Pure data: no three.js, no DOM.
import { EditableNode, REPLACE_ALL, touchedNodes, type CellOp, type NodeColumns, type Replace } from './columns';

// A build's frame (meta.json): the map's corner in the project grid, the floor's height, the nodes' size
export interface Frame { N: number; origin: readonly [number, number]; base: number }

export function frameOf(meta: { base: number; origin?: readonly [number, number]; tiles: { N: number } }): Frame {
  return { N: meta.tiles.N, origin: meta.origin ?? [0, 0], base: meta.base };
}

// project grid <-> map cells (x = column - origin[0], y = row - origin[1]); absolute height <-> cell z (z = height -
// base, the cell [z, z + 1) over the floor)
export const gridToMap = (f: Frame, col: number, row: number): [number, number] => [col - f.origin[0], row - f.origin[1]];
export const mapToGrid = (f: Frame, x: number, y: number): [number, number] => [x + f.origin[0], y + f.origin[1]];
export const absToCellZ = (f: Frame, z: number) => z - f.base;
export const cellToAbsZ = (f: Frame, z: number) => z + f.base;

// An edit: (col, row) a project grid cell, z its absolute height (integer metres), colour a palette id (0: air).
// box: w x d x h cells from there; sphere: the cells whose centres lie within r (a multiple of 1/4 m) of that cell's.
export type WorldOp =
  | { kind: 'set'; col: number; row: number; z: number; colour: number }
  | { kind: 'box'; col: number; row: number; z: number; w: number; d: number; h: number; colour: number; replace?: Replace }
  | { kind: 'sphere'; col: number; row: number; z: number; r: number; colour: number; replace?: Replace };

// a node of a build: level s (1 for edits), its place (tx, ty) among that build's nodes (the file s/tx_ty.bin)
export interface NodeAddress { s: number; tx: number; ty: number }

// The ops of one layer that touch one node (margin included: an op on a node's edge is in its neighbours' deltas
// too, so a node is built from its own deltas alone), in the order they were made. buildId: the build whose node
// grid the node address refers to. The ops are absolute, so they apply over any build; the address only routes them.
export interface NodeDelta { buildId: string; node: NodeAddress; ops: WorldOp[] }

// a node of the base build as decodeTile gives it
export interface BaseNode extends NodeColumns { buildId: string; node: NodeAddress }

export function toCellOp(f: Frame, op: WorldOp): CellOp {
  const [x, y] = gridToMap(f, op.col, op.row), z = absToCellZ(f, op.z);
  if (op.kind === 'set') return { kind: 'set', x, y, z, id: op.colour };
  if (op.kind === 'box') return { kind: 'box', x, y, z, w: op.w, d: op.d, h: op.h, id: op.colour, replace: op.replace ?? REPLACE_ALL };
  return { kind: 'sphere', x, y, z, r: op.r, id: op.colour, replace: op.replace ?? REPLACE_ALL };
}

// ops -> one NodeDelta per level-1 node of the frame's build they touch (nx, ny: the build's nodes, meta.json
// tiles.levels[0]), keyed "tx_ty"
export function routeOps(f: Frame, buildId: string, ops: readonly WorldOp[], nx = Infinity, ny = Infinity) {
  const out = new Map<string, NodeDelta>();
  for (const op of ops) {
    for (const [tx, ty] of touchedNodes(toCellOp(f, op), f.N, nx, ny)) {
      const k = `${tx}_${ty}`;
      let d = out.get(k);
      if (!d) out.set(k, d = { buildId, node: { s: 1, tx, ty }, ops: [] });
      d.ops.push(op);
    }
  }
  return out;
}

// The columns of a node as shown: L0, then the L1 deltas' ops, then L2's, each in order (an op outside the node does
// nothing). The inputs are not changed: dropping transient gives L0 + L1 again. A distance level (s > 1) shows no
// transient edits, ever; persistent ones need a downsampled L1 (the server's, not yet), so they are refused there.
export function effectiveColumns(f: Frame, base: BaseNode, persistent: readonly NodeDelta[], transient: readonly NodeDelta[]): NodeColumns {
  if (base.node.s !== 1) {
    if (persistent.some((d) => d.ops.length)) throw new Error(`effectiveColumns: persistent edits on a level-${base.node.s} node (not yet)`);
    return { counts: base.counts, runs: base.runs, ground: base.ground };
  }
  if (!persistent.length && !transient.length) return { counts: base.counts, runs: base.runs, ground: base.ground };
  const n = new EditableNode(f.N, base, base.node.tx, base.node.ty);
  for (const layer of [persistent, transient]) for (const d of layer) for (const op of d.ops) n.apply(toCellOp(f, op));
  return n.encode();
}

// --- compact binary form (little-endian varints) ---
// ops:   "VXO1", count, then per op: a byte kind | replace << 2, colour, col, row, z as zigzag differences from the
//        op before (from 0, 0, 0), then box: w, d, h; sphere: r * 4
// delta: "VXD1", buildId (length byte, ASCII [A-Za-z0-9._:-]), s, tx, ty (zigzag), then its ops as above
const KINDS = ['set', 'box', 'sphere'] as const;
const OPS_MAGIC = [0x56, 0x58, 0x4f, 0x31], DELTA_MAGIC = [0x56, 0x58, 0x44, 0x31];

class Out {
  b: number[] = [];
  uint(v: number) {
    if (!(Number.isSafeInteger(v) && v >= 0)) throw new Error(`ops: ${v} is not a whole number`);
    while (v >= 0x80) { this.b.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    this.b.push(v);
  }
  int(v: number) { if (!Number.isSafeInteger(v)) throw new Error(`ops: ${v} is not a whole number`); this.uint(v < 0 ? -2 * v - 1 : 2 * v); }
}

class In {
  at = 0;
  constructor(readonly b: Uint8Array) {}
  byte() { if (this.at >= this.b.length) throw new Error('ops: truncated'); return this.b[this.at++]; }
  uint() {
    let v = 0, m = 1, c;
    do { c = this.byte(); v += (c & 0x7f) * m; m *= 0x80; } while (c & 0x80);
    return v;
  }
  int() { const u = this.uint(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  magic(m: number[], what: string) { for (const x of m) if (this.byte() !== x) throw new Error(`${what}: bad magic`); }
}

function writeOps(o: Out, ops: readonly WorldOp[]) {
  o.b.push(...OPS_MAGIC);
  o.uint(ops.length);
  let pc = 0, pr = 0, pz = 0;
  for (const op of ops) {
    const rep = op.kind === 'set' ? 0 : op.replace ?? REPLACE_ALL;
    o.b.push(KINDS.indexOf(op.kind) | (rep << 2));
    o.uint(op.colour);
    o.int(op.col - pc); o.int(op.row - pr); o.int(op.z - pz);
    pc = op.col; pr = op.row; pz = op.z;
    if (op.kind === 'box') { o.uint(op.w); o.uint(op.d); o.uint(op.h); } else if (op.kind === 'sphere') o.uint(op.r * 4);
  }
}

function readOps(i: In): WorldOp[] {
  i.magic(OPS_MAGIC, 'ops');
  const n = i.uint(), ops: WorldOp[] = [];
  let col = 0, row = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const h = i.byte(), kind = KINDS[h & 3], replace = (h >> 2) as Replace;
    if (!kind || replace > 2) throw new Error(`ops: bad op head ${h}`);
    const colour = i.uint();
    col += i.int(); row += i.int(); z += i.int();
    if (kind === 'set') ops.push({ kind, col, row, z, colour });
    else if (kind === 'box') { const w = i.uint(), d = i.uint(), hh = i.uint(); ops.push({ kind, col, row, z, w, d, h: hh, colour, replace }); }
    else ops.push({ kind, col, row, z, r: i.uint() / 4, colour, replace });
  }
  return ops;
}

export function encodeOps(ops: readonly WorldOp[]) { const o = new Out(); writeOps(o, ops); return Uint8Array.from(o.b); }
export function decodeOps(b: Uint8Array) { const i = new In(b), ops = readOps(i); if (i.at !== b.length) throw new Error('ops: trailing bytes'); return ops; }

export function encodeDelta(d: NodeDelta) {
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(d.buildId)) throw new Error(`delta: build id ${JSON.stringify(d.buildId)}`);
  const o = new Out();
  o.b.push(...DELTA_MAGIC, d.buildId.length);
  for (let k = 0; k < d.buildId.length; k++) o.b.push(d.buildId.charCodeAt(k));
  o.uint(d.node.s); o.int(d.node.tx); o.int(d.node.ty);
  writeOps(o, d.ops);
  return Uint8Array.from(o.b);
}

export function decodeDelta(b: Uint8Array): NodeDelta {
  const i = new In(b);
  i.magic(DELTA_MAGIC, 'delta');
  let buildId = '';
  for (let n = i.byte(); n > 0; n--) buildId += String.fromCharCode(i.byte());
  const s = i.uint(), tx = i.int(), ty = i.int(), ops = readOps(i);
  if (i.at !== b.length) throw new Error('delta: trailing bytes');
  return { buildId, node: { s, tx, ty }, ops };
}
