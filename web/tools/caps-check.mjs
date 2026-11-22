// The caps (core/surface.ts; the nodes' caps section, scripts/caps.py) as the mesher draws them, on data that has them
// (a fixture's build: VOXEL_DATA=.../data/check/<fixture>/base/web/public/data, tools/data-dir.mjs):
//   1. every top face the mesher draws over a capped column (merged or not) has, at each of the column's four
//      corners, exactly the cap's corner (core/surface.ts cornerQ, 1/64 m, bit for bit);
//   2. neighbouring nodes hold the same caps for the columns they share (a node's apron and its neighbour's own
//      columns): their meshes meet at the border without a crack;
//   2b. likewise the roofs' caps (the nodes' roof section, roofs.ts roofField) at every level: the same corners for the
//      columns two neighbours share;
//   3. the triangles of each node with caps, against the same node meshed without its caps section (plain voxels, as
//      a node without caps is drawn), and the time.
// usage (in web/): node tools/caps-check.mjs [tx_ty ...] [--all] [-v]; default: up to 20 nodes with caps round the
// map's middle; exit code 1 on a mismatch
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { runnerImport } from 'vite';
import { dataDir as dir, web } from './data-dir.mjs';

globalThis.self ??= globalThis;
const imp = async (p) => (await runnerImport(path.join(web, p), { root: web, logLevel: 'error' })).module;
const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts');
const TD = await imp('src/tile-data.ts'), SF = await imp('src/core/surface.ts'), RF = await imp('src/roofs.ts');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const N = meta.tiles.N, S = N + 2, ctx = { N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
const raw = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const load = async (f) => raw(f);
const has = (f) => fs.existsSync(path.join(dir, 'tiles', `${f}.bin`));
const verbose = process.argv.includes('-v'), args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const { nx, ny } = meta.tiles.levels.find((l) => l.s === 1);
const decoded = new Map();
const dec = (tx, ty) => { const k = `${tx}_${ty}`; if (!decoded.has(k)) decoded.set(k, has(`1/${k}`) ? TD.decodeTile(raw(`1/${k}`), N) : null); return decoded.get(k); };
let nodes = args.map((a) => a.split('_').map(Number));
if (!nodes.length) {
  const all = [];
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) if (dec(tx, ty)?.caps) all.push([tx, ty]);
  const mx = nx / 2, my = ny / 2;
  all.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
  nodes = process.argv.includes('--all') ? all : all.slice(0, 20);
}
const bad = [];
const fail = (w) => { if (bad.length < 20) console.log(`  FAIL ${w}`); bad.push(w); };
const field = (d) => d && SF.capField(N, d);

// 1. the up faces over capped columns: their corners at each column of theirs, by the quad's plane
function tops(m, f, x0, y0, what, seen) {
  let checked = 0;
  const P = m.pos, A = m.attr;
  for (let q = 0; q < m.quads; q++) {
    // (an up face: not a roof's slope, lit by its plane -- vattr.w 1..64, roofs.ts: merged where its corners lie in one
    // plane to 1/64 m, not by the caps' rule)
    if (A[q * 16] % 8 !== 5 || (A[q * 16 + 3] >= 1 && A[q * 16 + 3] <= 64)) continue;
    const V = [0, 1, 2, 3].map((k) => { const i = q * 4 + k; return { x: P[i * 3] - x0, z: P[i * 3 + 2] - y0, h: P[i * 3 + 1] * 64 + (A[i * 4 + 1] >> 2) }; });
    const xs = V.map((v) => v.x), zs = V.map((v) => v.z), X0 = Math.min(...xs), X1 = Math.max(...xs), Z0 = Math.min(...zs), Z1 = Math.max(...zs);
    const at = (x, z) => V.find((v) => v.x === x && v.z === z)?.h;
    const h00 = at(X0, Z0), h10 = at(X1, Z0), h01 = at(X0, Z1), h11 = at(X1, Z1);
    if ([h00, h10, h01, h11].some((h) => h === undefined)) continue;
    // (merged only where planar: corner (i, j) of the quad by its plane)
    const w = X1 - X0, hh = Z1 - Z0, dx = (h10 - h00) / w, dz = (h01 - h00) / hh;
    if (h11 !== h00 + dx * w + dz * hh && (w > 1 || hh > 1)) { fail(`${what}: merged top at ${X0},${Z0} not planar`); continue; }
    for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) {
      const c = X0 + i + 1 + S * (Z0 + j + 1);
      const want = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => (w === 1 && hh === 1 ? [h00, h10, h11, h01][[[0, 0], [1, 0], [1, 1], [0, 1]].findIndex(([u, v]) => u === a && v === b)] : h00 + dx * a + dz * b));
      // the cap of this column at this level (either slot): its corners, bit for bit
      const lo = Math.min(...want), hi = Math.max(...want);
      for (let s = 0; s < 2; s++) {
        const z = f.z[2 * c + s];
        if (!z || lo > z * 64 + 60 || hi < z * 64 - 60) continue; // (caps.CLAMP)
        if ([0, 1, 2, 3].every((k) => SF.cornerQ(f, c, s, k) === want[k])) { checked++; seen.add(2 * c + s); }
        else fail(`${what}: top over column (${(c % S) - 1}, ${Math.floor(c / S) - 1}) corners ${want}, its cap's ${[0, 1, 2, 3].map((k) => SF.cornerQ(f, c, s, k))}`);
      }
    }
  }
  return checked;
}

let tCaps = 0, tVox = 0, msCaps = 0, msVox = 0, ncols = 0, ncheck = 0;
const rows = [];
for (const [tx, ty] of nodes) {
  const d = dec(tx, ty), f = field(d);
  if (!f) { fail(`${tx}_${ty}: no caps`); continue; }
  for (let c = 0; c < S * S; c++) { const X = c % S, Y = (c - X) / S; if (X && Y && X < S - 1 && Y < S - 1) ncols += (f.z[2 * c] ? 1 : 0) + (f.z[2 * c + 1] ? 1 : 0); }
  const r = req.tileRequest(ctx, 1, tx, ty, false, (k) => k);
  let t0 = performance.now();
  const a = (await mesher.meshJob(r, load)).out;
  msCaps += performance.now() - t0;
  t0 = performance.now();
  const b = (await mesher.meshJob({ ...r, url: undefined, cols: { ...d, caps: null } }, load)).out;
  msVox += performance.now() - t0;
  tCaps += a.quads * 2; tVox += b.quads * 2;
  const [x0, y0] = req.tileOrigin(ctx, 1, tx, ty);
  const seen = new Set();
  ncheck += tops(a, f, x0, y0, `${tx}_${ty}`, seen);
  // (every live cap of the node's own columns drawn)
  for (let c = 0; c < S * S; c++) {
    const X = c % S, Y = (c - X) / S;
    if (X && Y && X < S - 1 && Y < S - 1) for (let s = 0; s < 2; s++) if (f.z[2 * c + s] && SF.capRamped(f, c, s) && !seen.has(2 * c + s)) fail(`${tx}_${ty}: the cap of column (${X - 1}, ${Y - 1}) slot ${s} not drawn`);
  }
  rows.push(`${tx}_${ty}`.padEnd(8) + `${String(b.quads * 2).padStart(8)} ${String(a.quads * 2).padStart(8)} ${((a.quads / b.quads - 1) * 100).toFixed(1).padStart(6)} %`);
  // 2. its east and south neighbours: the columns both hold, the same caps
  for (const [ex, ey] of [[1, 0], [0, 1]]) {
    const e = field(dec(tx + ex, ty + ey));
    if (!e) continue;
    for (let k = 0; k < S; k++) for (const [ia, ib] of [[N, 0], [N + 1, 1]]) {
      // (a's column ia across the shared border is b's column ib)
      const ca = ex ? ia + S * k : k + S * ia, cb = ex ? ib + S * k : k + S * ib;
      for (let s = 0; s < 2; s++) {
        if (f.z[2 * ca + s] !== e.z[2 * cb + s]) { fail(`${tx}_${ty} / +${ex},${ey}: column ${k} slot ${s}: z ${f.z[2 * ca + s]} != ${e.z[2 * cb + s]}`); continue; }
        if (f.z[2 * ca + s]) for (let q = 0; q < 4; q++) if (SF.cornerQ(f, ca, s, q) !== SF.cornerQ(e, cb, s, q)) fail(`${tx}_${ty} / +${ex},${ey}: column ${k} corner ${q} differs`);
      }
    }
  }
}
// 2b. the roofs' caps across every border, every level
let roofCols = 0;
for (const lv of meta.tiles.levels) {
  const s = lv.s, dl = (tx, ty) => has(`${s}/${tx}_${ty}`) ? TD.decodeTile(raw(`${s}/${tx}_${ty}`), N) : null;
  const rows = new Map();
  const get = (tx, ty) => { const k = `${tx}_${ty}`; if (!rows.has(k)) { const d = dl(tx, ty); rows.set(k, d && RF.roofField(N, d)); } return rows.get(k); };
  for (let ty = 0; ty < lv.ny; ty++) for (let tx = 0; tx < lv.nx; tx++) {
    const f = get(tx, ty);
    if (!f) continue;
    for (let c = 0; c < S * S; c++) if (f.z[c]) roofCols++;
    for (const [ex, ey] of [[1, 0], [0, 1]]) {
      const e = get(tx + ex, ty + ey);
      if (!e) continue;
      for (let k = 0; k < S; k++) for (const [ia, ib] of [[N, 0], [N + 1, 1]]) {
        const ca = ex ? ia + S * k : k + S * ia, cb = ex ? ib + S * k : k + S * ib;
        if (f.z[ca] !== e.z[cb]) { fail(`roof ${s}/${tx}_${ty} / +${ex},${ey}: column ${k}: z ${f.z[ca]} != ${e.z[cb]}`); continue; }
        if (f.z[ca]) for (let q = 0; q < 4; q++) if (f.q[4 * ca + q] !== e.q[4 * cb + q]) fail(`roof ${s}/${tx}_${ty} / +${ex},${ey}: column ${k} corner ${q} differs`);
      }
    }
  }
  rows.clear();
}
console.log(`roofs: ${roofCols} capped columns (all levels), their nodes' shared columns compared`);
if (verbose) { console.log('node     voxels     caps   more'); for (const r of rows) console.log(r); }
console.log(`caps-check: ${nodes.length} nodes, ${ncols} capped columns, ${ncheck} capped tops checked bit for bit; triangles ${tVox} voxels -> ${tCaps} caps (${((tCaps / tVox - 1) * 100).toFixed(1)} %), meshing ${(msVox / nodes.length).toFixed(0)} -> ${(msCaps / nodes.length).toFixed(0)} ms a node`);
console.log(bad.length ? `FAIL caps-check: ${bad.length} mismatches` : 'PASS caps-check');
process.exit(bad.length ? 1 : 0);
