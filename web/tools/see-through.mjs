// Buildings one can see through: holes in the mesh a player notices as a missing wall or roof (Hans-Hösl-Straße 20
// seen from the north). Each level-1 node meshed as the viewer does (src/mesher.worker.ts meshJob, src/tile-request.ts),
// and at every building column of it (bld) rays from the sky aimed into the column, 8 bearings x 2 elevations, each
// jittered (seeded per node): a closed surface seen from outside shows its front first, so a ray whose first hit is the
// back of a face went in through a hole. Rays that come in through the node's sides are left out (what lies beyond is
// not in its mesh). Counts the buildings (per node) with such a ray. An open edge check does not do: chamfers' prisms
// and caps stand on the faces round them, which the mesh never joins.
// Default: a few fixed nodes (Hans-Hösl-Straße's, and one of each kind of hole fixed so far), PASS if the count is at
// most BASELINE (a ratchet: real data, so a data rebuild can move it).
// --all: every level-1 node (in --jobs K processes, default min(16, cpus - 2); ~1.5 min on 20 cores), the count and
// the worst; -v: each node's; --classify [FILE.json]: the holes by cause, the worst of each (and all, to the file).
// usage (in web/): node tools/see-through.mjs [tx_ty ...] [--all] [--jobs K] [-v] [--classify [FILE]]; exit code 1
// above BASELINE
// (VOXEL_DATA: other data, tools/data-dir.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir as dir } from './data-dir.mjs';

const NODES = ['25_19', '61_22', '31_34', '50_24', '12_26', '19_15', '40_37'];
const BASELINE = 0;
const AZ = 8, ELS = [25, 55], SPIKE = 1.5, SLANT = 128; // (chamfer.ts SLANT)

const argv = process.argv.slice(2), V = argv.includes('-v'), SAMPLES = argv.includes('--classify');
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// the buildings of node tx_ty seen through: [bld, rays] each
async function check(mesher, req, TD, RF, ctx, key) {
  const N = ctx.N, S = N + 2, [tx, ty] = key.split('_').map(Number);
  const raw = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const r = req.tileRequest(ctx, 1, tx, ty, false, (k) => k);
  const m = (await mesher.meshJob(r, async (f) => raw(f))).out;
  const cols = TD.decodeTile(raw(`1/${key}`), N), rf = SAMPLES ? RF.roofField(N, cols) : null;
  if (!m.bld || !cols.bld) return [];
  // the triangles in node coordinates (A, e1, e2, normal), and per 1 m cell of the node and its apron those over it
  const nt = m.quads * 2, T = new Float64Array(nt * 12), tb = new Uint16Array(nt), tq = new Int32Array(nt), G = N + 2, cell = Array.from({ length: G * G }, () => []);
  const X = (i) => m.pos[i * 3] - r.x0, Y = (i) => m.pos[i * 3 + 1] + (m.attr[i * 4 + 1] >> 2) / 64, Z = (i) => m.pos[i * 3 + 2] - r.y0;
  let n = 0, hmax = 0;
  for (let q = 0; q < m.quads; q++) for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
    const ia = q * 4 + a, ib = q * 4 + b, ic = q * 4 + c, ax = X(ia), ay = Y(ia), az = Z(ia);
    const e1 = [X(ib) - ax, Y(ib) - ay, Z(ib) - az], e2 = [X(ic) - ax, Y(ic) - ay, Z(ic) - az];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    T.set([ax, ay, az, ...e1, ...e2, nx, ny, nz], n * 12);
    tb[n] = m.bld[ia]; tq[n] = q;
    hmax = Math.max(hmax, ay, ay + e1[1], ay + e2[1]);
    const xs = [ax, ax + e1[0], ax + e2[0]], zs = [az, az + e1[2], az + e2[2]];
    const g = (v, f) => Math.max(0, Math.min(G - 1, Math.floor(f(...v) + 1 + (f === Math.min ? -1e-6 : 1e-6))));
    for (let gz = g(zs, Math.min); gz <= g(zs, Math.max); gz++) for (let gx = g(xs, Math.min); gx <= g(xs, Math.max); gx++) cell[gx + G * gz].push(n);
    n++;
  }
  const stamp = new Int32Array(n);
  let ray = 0;
  // the first triangle along o + t d, t in (0, tmax): the cells it crosses in plan, in order
  const cast = (o, d, tmax) => {
    ray++;
    let best = -1, bt = tmax, gx = Math.floor(o[0] + 1), gz = Math.floor(o[2] + 1);
    const sx = d[0] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1, dx = Math.abs(1 / d[0]), dz = Math.abs(1 / d[2]);
    let tX = ((d[0] > 0 ? gx + 1 : gx) - (o[0] + 1)) / d[0], tZ = ((d[2] > 0 ? gz + 1 : gz) - (o[2] + 1)) / d[2];
    for (let it = 0; it < 4 * G; it++) {
      if (gx >= 0 && gz >= 0 && gx < G && gz < G) for (const i of cell[gx + G * gz]) {
        if (stamp[i] === ray) continue;
        stamp[i] = ray;
        const k = i * 12, e1x = T[k + 3], e1y = T[k + 4], e1z = T[k + 5], e2x = T[k + 6], e2y = T[k + 7], e2z = T[k + 8];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, sx_ = o[0] - T[k], sy_ = o[1] - T[k + 1], sz_ = o[2] - T[k + 2], u = (sx_ * px + sy_ * py + sz_ * pz) * inv;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        const qx = sy_ * e1z - sz_ * e1y, qy = sz_ * e1x - sx_ * e1z, qz = sx_ * e1y - sy_ * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        // (a back face in the plane of a front one is drawn behind it: the front wins a tie)
        const back = T[k + 9] * d[0] + T[k + 10] * d[1] + T[k + 11] * d[2] > 0;
        if (t > 1e-6 && (t < bt - 1e-4 || (t < bt + 1e-4 && !back && (best < 0 || T[best * 12 + 9] * d[0] + T[best * 12 + 10] * d[1] + T[best * 12 + 11] * d[2] > 0)))) { bt = Math.min(bt, t); best = i; }
      }
      if (Math.min(tX, tZ) > bt) break;
      if (tX < tZ) { tX += dx; gx += sx; } else { tZ += dz; gz += sz; }
    }
    return best;
  };
  const off = new Uint32Array(S * S + 1);
  for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + cols.counts[i];
  let h = (tx * 7919 + ty * 104729) >>> 0 || 1;
  const rnd = () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h / 2 ** 32; };
  const bad = new Map();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = (y + 1) * S + x + 1, b = cols.bld[c], g = cols.ground[c];
    if (!b) continue;
    let top = 0;
    for (let k = off[c]; k < off[c + 1]; k++) if (cols.runs[k * 3 + 1] && cols.runs[k * 3 + 2]) top = cols.runs[k * 3] + cols.runs[k * 3 + 1];
    if (top <= g + 1) continue;
    for (let ai = 0; ai < AZ; ai++) for (const el of ELS) {
      const az = (ai + 0.2 + 0.6 * rnd()) / AZ * 2 * Math.PI, e = (el - 4 + 8 * rnd()) * Math.PI / 180;
      const p = [x + 0.15 + 0.7 * rnd(), g + 0.5 + (top - g - 1) * rnd(), y + 0.15 + 0.7 * rnd()];
      const d = [-Math.cos(az) * Math.cos(e), -Math.sin(e), -Math.sin(az) * Math.cos(e)];
      const L = (hmax + 2 - p[1]) / Math.sin(e), o = [p[0] - d[0] * L, p[1] - d[1] * L, p[2] - d[2] * L];
      // (where it comes in over the node: it has to be over everything there)
      let te = 0;
      for (const [a, da] of [[o[0], d[0]], [o[2], d[2]]]) te = Math.max(te, a < 0 ? -a / da : a > N ? (N - a) / da : 0);
      if (o[1] + d[1] * te < hmax + 0.5) continue;
      const i = cast(o, d, L + 0.01);
      if (i < 0 || !tb[i] || T[i * 12 + 9] * d[0] + T[i * 12 + 10] * d[1] + T[i * 12 + 11] * d[2] <= 0) continue;
      const was = bad.get(tb[i]);
      if (was) { was[0]++; continue; }
      bad.set(tb[i], [1, SAMPLES ? sample(o, d, L, i) : null]);
    }
  }
  return [...bad].map(([b, [n, smp]]) => [b, n, smp]).sort((a, b) => b[1] - a[1]);

  // where a hole is: the voxel the ray first goes into solid (node cells, z up), what it then meets
  // where a hole is: the voxel the ray first goes into solid (node cells, z up), what it then meets, and a cause:
  // "steep cap" where a roof cap within 2 cells has corners more than SPIKE m apart (one corner up at a ridge, the
  // others down the slope: a twisted cell, caps.py's), else by the face met from behind
  function sample(o, d, L, i) {
    let e = null;
    for (let t = 0; t < L && !e; t += 0.01) {
      const q = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], cx = Math.floor(q[0]), cy = Math.floor(q[2]), z = Math.floor(q[1]);
      if (cx < -1 || cy < -1 || cx > N || cy > N) continue;
      const c = (cy + 1) * S + cx + 1;
      for (let k = off[c]; k < off[c + 1]; k++) if (cols.runs[k * 3 + 2] && z >= cols.runs[k * 3] && z < cols.runs[k * 3] + cols.runs[k * 3 + 1]) e = [cx, cy, z, ...q.map((v) => +v.toFixed(2))];
    }
    let spread = 0;
    if (e && rf) for (let y = e[1] - 2; y <= e[1] + 2; y++) for (let x = e[0] - 2; x <= e[0] + 2; x++) {
      const c = (y + 1) * S + x + 1;
      if (x < -1 || y < -1 || x > N || y > N || !rf.z[c]) continue;
      const cq = rf.q.subarray(4 * c, 4 * c + 4);
      spread = Math.max(spread, (Math.max(...cq) - Math.min(...cq)) / 64);
    }
    const q = tq[i], g = m.faces.findIndex((f, k) => q >= f && q < m.faces[k + 1]), w = m.attr[q * 16 + 3];
    // (the groups: mesher.worker.ts FACE_ORDER)
    const face = g === 0 || g === 1 ? 'a floor' : g >= 4 && g <= 11 ? (w >= SLANT ? 'a chamfer\'s wall' : 'a slanted wall') : g >= 12 && g <= 20 ? 'a top' : 'a wall';
    return { cause: spread > SPIKE ? 'steep cap' : `${face} from behind`, e, at: Array.from(T.slice(i * 12, i * 12 + 3)).map((v) => +v.toFixed(2)), d: d.map((v) => +v.toFixed(2)) };
  }
}

async function load() {
  globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
  const { imp } = await import('./lib.mjs');
  const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts'), TD = await imp('src/core/tile-data.ts'), RF = await imp('src/roofs.ts');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const ctx = { N: meta.tiles.N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
  return (key) => check(mesher, req, TD, RF, ctx, key);
}

if (argv.includes('--worker')) {
  const run = await load();
  process.on('message', async (keys) => {
    const out = [];
    for (const k of keys) out.push([k, await run(k)]);
    process.send(out, () => {});
  });
  process.on('disconnect', () => process.exit(0));
  process.send('ready');
} else {
  const t0 = performance.now();
  if (!fs.existsSync(path.join(dir, 'meta.json'))) { console.log(`SKIP see-through: no data (${dir})`); process.exit(0); }
  const all = argv.includes('--all');
  const named = argv.filter((a, i) => /^\d+_\d+$/.test(a) && argv[i - 1] !== '--jobs');
  const keys = all ? fs.readdirSync(path.join(dir, 'tiles/1')).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4))
    : (named.length ? named : NODES).filter((k) => fs.existsSync(path.join(dir, 'tiles/1', `${k}.bin`)));
  let res = [];
  if (all) {
    const jobs = Math.max(1, +(opt('--jobs') ?? Math.min(16, os.availableParallelism() - 2)));
    const shards = Array.from({ length: jobs }, (_, j) => keys.filter((_, i) => i % jobs === j)).filter((s) => s.length);
    const self_ = fileURLToPath(import.meta.url);
    res = (await Promise.all(shards.map((s) => new Promise((ok, fail) => {
      const w = fork(self_, ['--worker', ...(SAMPLES ? ['--classify'] : [])], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      w.on('message', (msg) => { if (msg === 'ready') w.send(s); else { ok(msg); w.disconnect(); } });
      w.on('exit', (code) => { if (code) fail(new Error(`worker exited ${code}`)); });
    })))).flat();
  } else {
    const run = await load();
    for (const k of keys) res.push([k, await run(k)]);
  }
  let count = 0;
  const worst = [];
  for (const [k, bl] of res.sort((a, b) => a[0].localeCompare(b[0]))) {
    count += bl.length;
    for (const [b, n] of bl) worst.push([n, k, b]);
    if (V && bl.length) console.log(`  ${k}: ${bl.map(([b, n]) => `${b}:${n}`).join(' ')}`);
  }
  worst.sort((a, b) => b[0] - a[0]);
  if (SAMPLES) {
    const all = res.flatMap(([k, bl]) => bl.map(([b, n, smp]) => ({ node: k, bld: b, rays: n, ...smp }))), by = new Map();
    for (const h of all) (by.get(h.cause) ?? by.set(h.cause, []).get(h.cause)).push(h);
    for (const [c, hs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`${String(hs.length).padStart(5)} ${c}`);
      for (const h of hs.sort((a, b) => b.rays - a.rays).slice(0, 5)) console.log(`        ${h.node} bld ${h.bld}: ${h.rays} rays, in at cell ${h.e?.slice(0, 3).join(',') ?? '?'}, face at ${h.at.join(',')}, ray ${h.d.join(',')}`);
    }
    if (opt('--classify')?.endsWith('.json')) fs.writeFileSync(opt('--classify'), JSON.stringify(all));
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`${count} buildings seen through in ${keys.length} nodes (${secs} s); worst (rays, node, bld): ${worst.slice(0, 5).map((w) => w.join(' ')).join(', ') || 'none'}`);
  if (all || named.length) process.exit(0);
  const ok = count <= BASELINE;
  console.log(`${ok ? 'PASS' : 'FAIL'} see-through: ${count} buildings seen through in ${NODES.join(' ')}, baseline ${BASELINE}`);
  process.exit(ok ? 0 : 1);
}
