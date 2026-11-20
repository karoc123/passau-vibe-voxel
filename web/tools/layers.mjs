// src/core/layers.ts on a synthetic world (no data files): one absolute voxel world (project grid, metres a.s.l.) cut
// into the nodes (N = 8) of two builds whose map corner (meta.json origin) and floor (base) differ; random persistent
// (L1) and transient (L2) edits routed to both builds' nodes (routeOps). Checks:
//   - L0 + L1 + L2 equals a dense reference with L1 then L2 applied, L0 + L1 the one with L1 alone
//   - dropping L2 gives L0 + L1 byte for byte (the inputs unchanged), and L2 did change something
//   - both builds show the same absolute world (voxels and the ground's height) wherever both hold it
//   - the ops and every node delta survive encode/decode, and the decoded deltas build the same nodes
//   - a distance-level node shows no transient edits
// usage: node tools/layers.mjs [SEED]; exit code 1 on a mismatch
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const imp = async (p) => (await runnerImport(`${root}${p}`, { root, logLevel: 'error' })).module;
const L = await imp('src/core/layers.ts'), CO = await imp('src/core/columns.ts');
let seed = Number(process.argv[2] ?? 1) >>> 0 || 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const bad = [];
const fail = (what) => { if (bad.length < 20) console.log(`  FAIL ${what}`); bad.push(what); };

// the absolute world: project grid columns C0..C1, rows R0..R1, heights Z0..Z1 (m a.s.l.)
const C0 = 80, C1 = 140, R0 = -60, R1 = -10, Z0 = 270, Z1 = 340, ZH = Z1 - Z0;
const terrain = (c, r) => 283 + ((c * 7 + r * 3) % 5 + 5) % 5; // the ground's top, exclusive
function voxel(c, r, z) {
  const g = terrain(c, r);
  if (z < g) return z < g - 2 ? 30 : 31; // rock, soil
  if ((c >> 2) % 3 === 0 && (r >> 2) % 2 === 0 && z < g + 6 + ((c + r) & 3)) return 145; // houses on the ground
  if ((c * 13 + r * 5 + z) % 41 === 0 && z < g + 20) return 80; // stray voxels in the air
  return 0;
}
const dense0 = new Uint16Array((C1 - C0) * (R1 - R0) * ZH);
const at = (c, r, z) => ((r - R0) * (C1 - C0) + (c - C0)) * ZH + (z - Z0);
for (let r = R0; r < R1; r++) for (let c = C0; c < C1; c++) for (let z = Z0; z < Z1; z++) dense0[at(c, r, z)] = voxel(c, r, z);

// a build: its frame, nodes nx x ny, each node's columns cut from the world (its margin too), the ground the terrain's
function build(buildId, origin, base, nx, ny) {
  const f = { N: 8, origin, base }, N = f.N, S = N + 2, nodes = new Map();
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const counts = new Uint16Array(S * S), ground = new Uint8Array(S * S), runs = [];
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const [c, r] = L.mapToGrid(f, tx * N + i - 1, ty * N + j - 1), k = i + S * j;
      ground[k] = terrain(c, r) - base;
      for (let z = base; z < Z1;) {
        const v = voxel(c, r, z);
        let e = z + 1;
        while (e < Z1 && voxel(c, r, e) === v) e++;
        if (v) { runs.push(z - base, e - z, v); counts[k]++; }
        z = e;
      }
    }
    nodes.set(`${tx}_${ty}`, { buildId, node: { s: 1, tx, ty }, counts, runs: Uint16Array.from(runs), ground });
  }
  return { buildId, f, nx, ny, nodes };
}
const A = build('passau-a', [96, -40], 280, 3, 2), B = build('passau-b', [93, -45], 276, 4, 3);
const cut = (o) => ({ counts: o.counts, runs: o.runs, ground: o.ground });

// random ops round both maps (some reaching past them; none under 280 m, A's floor: what A cannot hold differs)
function randomOps(n, colours) {
  const ops = [];
  for (let k = 0; k < n; k++) {
    const col = ri(C0 + 8, C1 - 10), row = ri(R0 + 8, R1 - 10), z = ri(284, 312), colour = colours[ri(0, colours.length - 1)], u = rnd();
    ops.push(u < 0.6 ? { kind: 'set', col, row, z, colour }
      : u < 0.8 ? { kind: 'box', col, row, z, w: ri(1, 5), d: ri(1, 5), h: ri(1, 6), colour, replace: ri(0, 2) }
      : { kind: 'sphere', col, row, z, r: ri(0, 16) / 4, colour, replace: ri(0, 2) });
  }
  return ops;
}
const persistent = randomOps(600, [0, 145, 200, 201, 30]), transient = randomOps(300, [0, 0, 0, 31]);

// the dense reference: ops on the absolute world
function refApply(d, op) {
  const put = (c, r, z) => {
    if (c < C0 || c >= C1 || r < R0 || r >= R1 || z < Z0 || z >= Z1) return;
    const i = at(c, r, z), cur = d[i], rep = op.kind === 'set' ? 0 : op.replace;
    if ((rep === CO.REPLACE_AIR && cur) || (rep === CO.REPLACE_SOLID && !cur)) return;
    d[i] = op.colour;
  };
  if (op.kind === 'set') return put(op.col, op.row, op.z);
  if (op.kind === 'box') { for (let z = op.z; z < op.z + op.h; z++) for (let r = op.row; r < op.row + op.d; r++) for (let c = op.col; c < op.col + op.w; c++) put(c, r, z); return; }
  const k = Math.floor(op.r);
  for (let dz = -k; dz <= k; dz++) for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (dc * dc + dr * dr + dz * dz <= op.r * op.r) put(op.col + dc, op.row + dr, op.z + dz);
}
const dense1 = dense0.slice(), dense12 = dense0.slice();
for (const op of persistent) { refApply(dense1, op); refApply(dense12, op); }
for (const op of transient) refApply(dense12, op);

// each build's effective nodes: L0 + L1, L0 + L1 + L2, L0 + L1 again after
function effective(w, l1, l2) {
  const out = new Map();
  for (const [k, base] of w.nodes) out.set(k, L.effectiveColumns(w.f, base, l1.has(k) ? [l1.get(k)] : [], l2.has(k) ? [l2.get(k)] : []));
  return out;
}
const sameCols = (a, b) => isDeepStrictEqual(Array.from(a.counts), Array.from(b.counts)) && isDeepStrictEqual(Array.from(a.runs), Array.from(b.runs)) && isDeepStrictEqual(Array.from(a.ground), Array.from(b.ground));
// a build's voxel at (col, row, z a.s.l.) and the ground's height there, read from the node holding that cell
function sample(w, eff, c, r, z) {
  const [x, y] = L.gridToMap(w.f, c, r), N = w.f.N, S = N + 2, tx = Math.floor(x / N), ty = Math.floor(y / N);
  const n = eff.get(`${tx}_${ty}`);
  if (!n) return null;
  const col = (x - tx * N) + 1 + S * ((y - ty * N) + 1), cz = L.absToCellZ(w.f, z);
  let k = 0;
  for (let i = 0; i < col; i++) k += n.counts[i];
  let v = 0;
  for (let q = 0; q < n.counts[col]; q++, k++) if (cz >= n.runs[3 * k] && cz < n.runs[3 * k] + n.runs[3 * k + 1]) v = n.runs[3 * k + 2];
  return { v, ground: L.cellToAbsZ(w.f, n.ground[col]) };
}
// the reference ground: the stack from the floor up, never over the base's ground
function refGround(d, w, c, r) {
  let z = w.f.base;
  while (z < Z1 && d[at(c, r, z)]) z++;
  return Math.min(z, terrain(c, r));
}

let nodesChanged = 0, compared = 0, bytesL1 = 0;
const results = {};
for (const w of [A, B]) {
  const l1 = L.routeOps(w.f, w.buildId, persistent, w.nx, w.ny), l2 = L.routeOps(w.f, w.buildId, transient, w.nx, w.ny);
  const snapshot = [...w.nodes.values()].map((n) => [n.counts.slice(), n.runs.slice(), n.ground.slice()]);
  const e1 = effective(w, l1, new Map()), e12 = effective(w, l1, l2), e1b = effective(w, l1, new Map());
  [...w.nodes.values()].forEach((n, i) => { if (!sameCols(cut(n), { counts: snapshot[i][0], runs: snapshot[i][1], ground: snapshot[i][2] })) fail(`${w.buildId}: base node ${n.node.tx}_${n.node.ty} changed`); });
  for (const [k, n] of e1) {
    if (!sameCols(n, e1b.get(k))) fail(`${w.buildId} ${k}: L0 + L1 after L2 dropped != before`);
    if (!sameCols(n, e12.get(k))) nodesChanged++;
  }
  // against the dense reference, every cell each node holds (its margin too)
  for (const [eff, d, name] of [[e1, dense1, 'L0+L1'], [e12, dense12, 'L0+L1+L2']]) {
    for (const [k, n] of eff) {
      const ed = new CO.EditableNode(w.f.N, n, ...k.split('_').map(Number)), N = w.f.N;
      for (let y = -1; y <= N; y++) for (let x = -1; x <= N; x++) {
        const [c, r] = L.mapToGrid(w.f, ed.tx * N + x, ed.ty * N + y), S = N + 2;
        for (let z = w.f.base; z < Z1; z++) {
          const got = ed.get(x, y, L.absToCellZ(w.f, z)), want = d[at(c, r, z)];
          if (got !== want) { fail(`${w.buildId} ${name} node ${k} (${x}, ${y}) at ${z} m: ${got} != ${want}`); break; }
        }
        const g = L.cellToAbsZ(w.f, n.ground[x + 1 + S * (y + 1)]), gw = refGround(d, w, c, r);
        if (g !== gw) fail(`${w.buildId} ${name} node ${k} (${x}, ${y}): ground ${g} != ${gw}`);
      }
    }
  }
  // serialization: each delta round trips and builds the same nodes
  const dec = (m) => new Map([...m].map(([k, d]) => { const b = L.encodeDelta(d); if (w === A && m === l1) bytesL1 += b.length; return [k, L.decodeDelta(b)]; }));
  const l1d = dec(l1), l2d = dec(l2);
  for (const [m, md] of [[l1, l1d], [l2, l2d]]) for (const [k, d] of m) if (!isDeepStrictEqual(d, md.get(k))) fail(`${w.buildId} ${k}: delta changed in encode/decode`);
  const e12d = effective(w, l1d, l2d);
  for (const [k, n] of e12) if (!sameCols(n, e12d.get(k))) fail(`${w.buildId} ${k}: decoded deltas build another node`);
  results[w.buildId] = e12;
}
if (!nodesChanged) fail('L2 changed nothing');

// both builds, the same absolute world: every cell A holds (B's map covers A's)
for (let r = -40; r < -40 + 2 * 8; r++) for (let c = 96; c < 96 + 3 * 8; c++) for (let z = 280; z < Z1; z++, compared++) {
  const a = sample(A, results['passau-a'], c, r, z), b = sample(B, results['passau-b'], c, r, z);
  if (!a || !b || a.v !== b.v || a.ground !== b.ground) { fail(`(${c}, ${r}, ${z} m): ${JSON.stringify(a)} != ${JSON.stringify(b)}`); break; }
}

// the ops' own form
const all = [...persistent, ...transient], enc = L.encodeOps(all);
if (!isDeepStrictEqual(L.decodeOps(enc), all)) fail('ops changed in encode/decode');
let threw = false;
try { L.decodeOps(enc.subarray(0, enc.length - 1)); } catch { threw = true; }
if (!threw) fail('a truncated op stream decoded');

// a distance level: transient edits never show
const n0 = A.nodes.get('0_0'), lod = { ...n0, node: { s: 2, tx: 0, ty: 0 } };
if (L.effectiveColumns(A.f, lod, [], [{ buildId: 'passau-a', node: lod.node, ops: transient }]).runs !== n0.runs) fail('a level-2 node shows transient edits');

if (bad.length) { console.log(`layers: ${bad.length} mismatches`); process.exit(1); }
console.log(`layers: ok (${persistent.length} L1 + ${transient.length} L2 ops on two builds (origin/base shifted by (-3, -5)/-4 m): ` +
  `equal to the dense reference, ${nodesChanged} node(s) changed by L2 and restored without it, ${compared} cells equal across builds; ` +
  `${all.length} ops in ${enc.length} bytes (${(enc.length / all.length).toFixed(1)}/op), build A's L1 deltas ${bytesL1} bytes)`);
