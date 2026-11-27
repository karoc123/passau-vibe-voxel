// src/core/columns.ts on real node files: an unedited node (the Altstadt's, round the Dom) re-encodes to the same
// counts, runs and ground; then thousands of random edits (set, box, sphere; random replace modes and palette ids)
// round it, applied to the node and its east neighbour as touchedNodes routes them and to a dense voxel array of the
// node's window as the reference: get() agrees along the way, encode() equals the dense array's canonical runs (a port
// of scripts/tiles.py column_runs) and ground (min of the base's and the stack from z = 0), re-encoding the encoded node
// changes nothing, and the two nodes' shared margin columns agree; blocks placed in its trees take their foliage. The
// edits are synthetic; nothing is written. A bunch of a node's ops in one pass (editNodeOps) ends as each in turn.
// usage: node tools/edit-roundtrip.mjs [SEED] [OPS]; exit code 1 on a mismatch
import { imp } from './lib.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const TD = await imp('src/core/tile-data.ts'), CO = await imp('src/core/columns.ts');
const D = `${root}public/data/`;
const meta = JSON.parse(fs.readFileSync(`${D}meta.json`, 'utf8')), N = meta.tiles.N, S = N + 2;
let seed = Number(process.argv[2] ?? 1) >>> 0 || 1;
const NOPS = Number(process.argv[3] ?? 4000);
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// the node round the Dom (meta.json labels), and its east neighbour
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const TX = Math.floor(dom.x / N), TY = Math.floor(dom.y / N);
const load = (tx, ty) => {
  const b = zlib.gunzipSync(fs.readFileSync(`${D}tiles/1/${tx}_${ty}.bin`));
  const t = TD.decodeTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), N);
  return { counts: t.counts, runs: t.runs, ground: t.ground };
};
const A = load(TX, TY), B = load(TX + 1, TY);
const bad = [];
const fail = (what) => { if (bad.length < 20) console.log(`  FAIL ${what}`); bad.push(what); };
const eqArr = (name, got, want) => {
  if (got.length !== want.length) return fail(`${name}: ${got.length} values, not ${want.length}`);
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) return fail(`${name}[${i}]: ${got[i]} != ${want[i]}`);
};

// 1. unedited: the same bytes
{
  const e = new CO.EditableNode(N, A, TX, TY).encode();
  eqArr('unedited counts', e.counts, A.counts); eqArr('unedited runs', e.runs, A.runs); eqArr('unedited ground', e.ground, A.ground);
  eqArr('recomputeGround capped by the base', CO.recomputeGround(A, A.ground), A.ground);
}

// the dense reference: the node's window (S x S columns) up to H cells
const H = 256;
const dense = new Uint16Array(S * S * H);
const di = (x, y, z) => ((y + 1) * S + (x + 1)) * H + z;
for (let c = 0, k = 0; c < S * S; c++) for (let q = 0; q < A.counts[c]; q++, k += 3) dense.fill(A.runs[k + 2], c * H + A.runs[k], c * H + A.runs[k] + A.runs[k + 1]);
// scripts/tiles.py column_runs on the dense window
function columnRuns() {
  const counts = new Uint16Array(S * S), runs = [];
  for (let c = 0; c < S * S; c++) {
    for (let z = 0; z < H;) {
      const v = dense[c * H + z];
      let e = z + 1;
      while (e < H && dense[c * H + e] === v) e++;
      if (v) { runs.push(z, e - z, v); counts[c]++; }
      z = e;
    }
  }
  return { counts, runs: Uint16Array.from(runs) };
}
const refPut = (x, y, z, id, rep) => {
  if (x < -1 || y < -1 || x > N || y > N || z < 0 || z >= H) return;
  const i = di(x, y, z), cur = dense[i];
  if ((rep === CO.REPLACE_AIR && cur) || (rep === CO.REPLACE_SOLID && !cur)) return;
  dense[i] = id;
};
function refApply(op) {
  const x = op.x - TX * N, y = op.y - TY * N;
  if (op.kind === 'set') return refPut(x, y, op.z, op.id, CO.REPLACE_ALL);
  if (op.kind === 'box') {
    for (let zz = op.z; zz < op.z + op.h; zz++) for (let yy = y; yy < y + op.d; yy++) for (let xx = x; xx < x + op.w; xx++) refPut(xx, yy, zz, op.id, op.replace);
    return;
  }
  const k = Math.floor(op.r);
  for (let dz = -k; dz <= k; dz++) for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
    if (dx * dx + dy * dy + dz * dz <= op.r * op.r) refPut(x + dx, y + dy, op.z + dz, op.id, op.replace);
  }
}

// 2. random edits round the node's east edge (some outside both nodes' windows: they must change nothing)
const ids = [0, ...new Set(Array.from({ length: A.runs.length / 3 }, (_, k) => A.runs[3 * k + 2]))];
const na = new CO.EditableNode(N, A, TX, TY), nb = new CO.EditableNode(N, B, TX + 1, TY);
const counts = { set: 0, box: 0, sphere: 0, a: 0, b: 0 };
for (let n = 0; n < NOPS; n++) {
  const x = TX * N + ri(-8, N + 8), y = TY * N + ri(-8, N + 8), z = ri(-3, 70);
  const id = rnd() < 0.3 ? 0 : ids[ri(0, ids.length - 1)], replace = ri(0, 2), u = rnd();
  const op = u < 0.7 ? { kind: 'set', x, y, z, id }
    : u < 0.85 ? { kind: 'box', x, y, z, w: ri(1, 6), d: ri(1, 6), h: ri(1, 8), id, replace }
    : { kind: 'sphere', x, y, z, r: ri(0, 24) / 4, id, replace };
  counts[op.kind]++;
  refApply(op);
  for (const [tx, ty] of CO.touchedNodes(op, N, meta.tiles.levels[0].nx, meta.tiles.levels[0].ny)) {
    if (tx === TX && ty === TY) { na.apply(op); counts.a++; }
    if (tx === TX + 1 && ty === TY) { nb.apply(op); counts.b++; }
  }
  if (n % 97 === 0) for (let q = 0; q < 50; q++) {
    const px = ri(-1, N), py = ri(-1, N), pz = ri(0, 90), got = na.get(px, py, pz), want = dense[di(px, py, pz)];
    if (got !== want) { fail(`after op ${n}: get(${px}, ${py}, ${pz}) ${got} != ${want}`); break; }
  }
}
const e = na.encode(), ref = columnRuns();
eqArr('edited counts', e.counts, ref.counts);
eqArr('edited runs', e.runs, ref.runs);
const capped = CO.recomputeGround(ref, A.ground);
eqArr('edited ground', e.ground, capped);
const again = new CO.EditableNode(N, e, TX, TY);
for (let c = 0; c < 64; c++) again.set(ri(-1, N), ri(-1, N), 200, 0); // air to air: no change
const e2 = again.encode();
eqArr('re-encoded counts', e2.counts, e.counts); eqArr('re-encoded runs', e2.runs, e.runs); eqArr('re-encoded ground', e2.ground, e.ground);

// 3. the shared margin: A's column x = N is B's x = 0, A's x = N - 1 is B's x = -1
const eb = nb.encode();
const colRuns = (t, c) => { let k = 0; for (let i = 0; i < c; i++) k += t.counts[i]; return Array.from(t.runs.subarray(3 * k, 3 * (k + t.counts[c]))).join(); };
for (let y = -1; y <= N; y++) {
  for (const [xa, xb] of [[N, 0], [N - 1, -1]]) {
    const ca = xa + 1 + S * (y + 1), cb = xb + 1 + S * (y + 1);
    if (colRuns(e, ca) !== colRuns(eb, cb) || e.ground[ca] !== eb.ground[cb]) fail(`margin: ${TX}_${TY} column (${xa}, ${y}) != ${TX + 1}_${TY} (${xb}, ${y})`);
  }
}

// 4. a block placed in a tree (core/world-edits.ts editNode, the one code of host and client): the tree's foliage
// (tiles/1f: leaves, trunk, grass) in the cells the block fills is gone, outside it as it was; a box painting only
// what is solid leaves the foliage in the air be. Each box of BW x BW x BH cells round a tree's foliage, from its ground up.
const WE = await imp('src/core/world-edits.ts'), LA = await imp('src/core/layers.ts');
const frame = LA.frameOf(meta);
const loadF = (tx, ty) => {
  const b = zlib.gunzipSync(fs.readFileSync(`${D}tiles/1f/${tx}_${ty}.bin`));
  const t = TD.decodeTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), N);
  return { counts: t.counts, runs: t.runs, ground: A.ground };
};
const F = loadF(TX, TY), BW = 3, BH = 6;
const fol = new CO.EditableNode(N, F, TX, TY), base0 = new CO.EditableNode(N, A, TX, TY);
// trees: columns whose foliage stands 2 cells over their ground (not grass alone), 3 cells apart or more
const trees = [];
for (let y = 2; y < N - BW - 2 && trees.length < 40; y++) for (let x = 2; x < N - BW - 2 && trees.length < 40; x++) {
  const g = A.ground[(y + 1) * S + x + 1];
  if (fol.get(x, y, g + 2) && !base0.get(x, y, g + 2) && trees.every(([a, b]) => Math.abs(a - x) + Math.abs(b - y) >= 3)) trees.push([x, y, g]);
}
if (trees.length < 10) fail(`trees: ${trees.length} found round ${TX}_${TY}, 10 wanted`);
let cleared = 0, kept = 0;
for (const [x, y, g] of trees) {
  for (const [replace, colour, clears] of [[CO.REPLACE_ALL, ids[1], true], [CO.REPLACE_AIR, ids[1], true], [CO.REPLACE_SOLID, ids[1], false], [CO.REPLACE_ALL, 0, true]]) {
    const [col, row] = LA.mapToGrid(frame, TX * N + x - 1, TY * N + y - 1);
    const op = { kind: 'box', col, row, z: LA.cellToAbsZ(frame, g), w: BW, d: BW, h: BH, colour, replace };
    const got = WE.editNode(frame, TX, TY, { base: A, foliage: F, edited: false }, op, []);
    const after = new CO.EditableNode(N, { ...got.foliage, ground: got.foliage.ground }, TX, TY);
    for (let yy = y - 3; yy < y + BW + 2; yy++) for (let xx = x - 3; xx < x + BW + 2; xx++) for (let z = g - 2; z < g + BH + 3; z++) {
      const inside = xx >= x - 1 && xx < x - 1 + BW && yy >= y - 1 && yy < y - 1 + BW && z >= g && z < g + BH;
      const was = fol.get(xx, yy, z), now = after.get(xx, yy, z);
      // (the base's own solid cells in the block, the grass on its top: either way, the block hides or repaints them)
      if (inside && base0.get(xx, yy, z)) continue;
      if (inside && clears) { if (now) fail(`foliage ${now} at (${xx}, ${yy}, ${z}) inside a block (replace ${replace}, colour ${colour})`); else if (was) cleared++; }
      else if (now !== was) fail(`foliage at (${xx}, ${yy}, ${z}) ${was} -> ${now} (replace ${replace}, colour ${colour}, ${inside ? 'painted' : 'outside'})`);
      else if (was) kept++;
    }
  }
}

// 5. a bunch of a node's ops in one pass (editNodeOps, a page's notes) ends as each op in turn (editNode, the host's):
// craters (spheres and boxes of air) crossing each other and the trees, then craters with a block among them
const sameNode = (name, got, want) => {
  for (const k of ['counts', 'runs', 'ground']) eqArr(`${name} base ${k}`, got.base[k], want.base[k]);
  for (const k of ['counts', 'runs']) eqArr(`${name} foliage ${k}`, got.foliage[k], want.foliage[k]);
  eqArr(`${name} foliage ground`, got.foliage.ground, want.foliage.ground);
  if (got.ops.length !== want.ops.length) fail(`${name}: ${got.ops.length} ops, not ${want.ops.length}`);
};
const crater = () => {
  const [x, y] = trees[ri(0, trees.length - 1)], [col, row] = LA.mapToGrid(frame, TX * N + x + ri(-4, 4), TY * N + y + ri(-4, 4));
  const z = LA.cellToAbsZ(frame, A.ground[(y + 1) * S + x + 1] + ri(-2, 3));
  return rnd() < 0.8 ? { kind: 'sphere', col, row, z, r: 1.5 + rnd() * 3, colour: 0 } : { kind: 'box', col, row, z, w: ri(1, 4), d: ri(1, 4), h: ri(1, 5), colour: 0, replace: CO.REPLACE_SOLID };
};
for (let round = 0; round < 6; round++) {
  const ops = Array.from({ length: ri(2, 12) }, crater);
  if (round >= 4) ops.splice(ri(0, ops.length), 0, { ...crater(), kind: 'box', w: 2, d: 2, h: 3, colour: ids[1], replace: CO.REPLACE_ALL });
  const before = [crater()], v0 = WE.editNode(frame, TX, TY, { base: A, foliage: F, edited: false }, before[0], []);
  let want = v0;
  for (const op of ops) want = WE.editNode(frame, TX, TY, { base: want.base, foliage: want.foliage, edited: true }, op, want.ops);
  sameNode(`${ops.length} ops in one pass (round ${round})`, WE.editNodeOps(frame, TX, TY, { base: v0.base, foliage: v0.foliage, edited: true }, ops, v0.ops), want);
}

let changed = 0;
for (let c = 0; c < S * S; c++) if (colRuns(e, c) !== colRuns(A, c)) changed++;
if (bad.length) { console.log(`edit round trip: ${bad.length} mismatches`); process.exit(1); }
console.log(`edit round trip: ok (node ${TX}_${TY}: ${A.runs.length / 3} runs unedited, re-encoded byte-identical; ${NOPS} ops ` +
  `(${counts.set} set, ${counts.box} box, ${counts.sphere} sphere; ${counts.a} on it, ${counts.b} on ${TX + 1}_${TY}), ` +
  `${changed} columns changed, ${e.runs.length / 3} runs, equal to the dense reference; margins shared; blocks in ${trees.length} ` +
  `trees: ${cleared} foliage cells cleared, ${kept} kept)`);
