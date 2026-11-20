// The mesher's output, byte for byte, as a golden record: a change to src/mesher.worker.ts meant to make it faster
// (docs/adr/0003-remesh-cost.md) must not change a single byte of what it meshes. Meshes, from the real data
// (public/data), as the viewer does (tile-request.ts, mesher.worker.ts meshJob):
//   - level 1: the nodes round 63_21 (up to 20, as tools/remesh-bench.mjs), each also with a sphere of 3 m carved at its
//     middle (core/columns.ts EditableNode, meshed from the columns as stream.ts replaceColumns sends them);
//   - their foliage tiles (1f) over them, with the base's cover;
//   - levels 2, 4 and 8: the nodes round the same place (up to 12, 8, 6);
// and hashes (sha256) every buffer of every mesh. usage (in web/):
//   node tools/mesh-golden.mjs write <file>   records the hashes
//   node tools/mesh-golden.mjs check <file>   meshes again and compares; exit code 1 on any difference
// Nothing else is written.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const [mode, out] = process.argv.slice(2);
if (!['write', 'check'].includes(mode) || !out) { console.log('usage: node tools/mesh-golden.mjs write|check <file>'); process.exit(2); }
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(web, 'public/data');
globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
const imp = async (p) => (await runnerImport(path.join(web, p), { root: web, logLevel: 'error' })).module;
const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts');
const TD = await imp('src/tile-data.ts'), CO = await imp('src/core/columns.ts');

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const N = meta.tiles.N, S = N + 2, ctx = { N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
const raw = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const load = async (f) => raw(f);
const has = (f) => fs.existsSync(path.join(dir, 'tiles', `${f}.bin`));
const file = (k) => k;

// up to n nodes of level s round (mx, my) (in that level's node coordinates), nearest rings first
function round(s, mx, my, n) {
  const r = [];
  for (let k = 0; r.length < n && k < 8; k++) for (let ty = my - k; ty <= my + k; ty++) for (let tx = mx - k; tx <= mx + k; tx++) {
    if (Math.max(Math.abs(tx - mx), Math.abs(ty - my)) === k && r.length < n && has(`${s}/${tx}_${ty}`)) r.push([tx, ty]);
  }
  return r;
}

const KEYS = ['pos', 'attr', 'pal', 'bld', 'faces', 'normals', 'cuts', 'box'];
function hash(m) {
  if (!m) return 'none';
  const h = crypto.createHash('sha256');
  h.update(`quads ${m.quads};`);
  for (const k of KEYS) {
    const a = m[k];
    h.update(`${k} ${a ? `${a.constructor.name} ${a.length}` : 'null'};`);
    if (a) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  return h.digest('hex');
}

const rec = {};
const t0 = performance.now();
const [mx, my] = [63, 21];
for (const [tx, ty] of round(1, mx, my, 20)) {
  const k = `${tx}_${ty}`;
  const a = await mesher.meshJob(req.tileRequest(ctx, 1, tx, ty, false, file, true), load);
  rec[`1/${k}`] = hash(a.out);
  // carved at the middle, on its ground, meshed from the columns
  const d = TD.decodeTile(raw(`1/${k}`), N), e = new CO.EditableNode(N, d, tx, ty), c = N / 2;
  e.carveSphere([c, c, d.ground[c + 1 + S * (c + 1)]], 3);
  const enc = { ...e.encode(), planes: d.planes, bld: d.bld };
  const b = await mesher.meshJob({ ...req.tileRequest(ctx, 1, tx, ty, false, file, false), url: undefined, cols: enc }, load);
  rec[`1/${k} carved`] = hash(b.out);
  if (!has(`1f/${k}`)) continue;
  const f = await mesher.meshJob(req.tileRequest(ctx, 1, tx, ty, true, file), load);
  rec[`1f/${k}`] = hash(f.out);
  rec[`1c/${k}`] = hash(f.base);
}
for (const s of [2, 4, 8]) {
  for (const [tx, ty] of round(s, Math.floor(mx / s), Math.floor(my / s), { 2: 12, 4: 8, 8: 6 }[s])) {
    const m = await mesher.meshJob(req.tileRequest(ctx, s, tx, ty, false, file), load);
    rec[`${s}/${tx}_${ty}`] = hash(m.out);
  }
}
const n = Object.keys(rec).length, all = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
const ms = (performance.now() - t0).toFixed(0);
if (mode === 'write') {
  fs.writeFileSync(out, JSON.stringify(rec, null, 1));
  console.log(`${n} meshes recorded (${all}) in ${out}, ${ms} ms`);
  process.exit(0);
}
const want = JSON.parse(fs.readFileSync(out, 'utf8'));
const bad = [...new Set([...Object.keys(want), ...Object.keys(rec)])].filter((k) => want[k] !== rec[k]);
for (const k of bad.slice(0, 20)) console.log(`  DIFF ${k}: ${want[k] ?? 'missing'} -> ${rec[k] ?? 'missing'}`);
console.log(bad.length ? `FAIL mesh-golden: ${bad.length} of ${n} meshes differ` : `PASS mesh-golden: ${n} meshes identical (${all}), ${ms} ms`);
process.exit(bad.length ? 1 : 0);
