// Where meshing a 1 m node's time goes (docs/adr/0003-remesh-cost.md), on real Altstadt nodes (round 63_21, up to 20,
// as tools/remesh-bench.mjs): src/mesher.worker.ts meshJob from decoded columns (cols, stream.ts replaceColumns' way),
// unchanged, under the V8 sampling profiler (node:inspector), after two passes to warm the JIT. Prints
//   - per node: the dense volume (S x S x sz cells), the mean and max ms;
//   - self and inclusive time per mesher function (inlined callees fold into their caller where V8 inlined them);
//   - what-ifs on the same nodes, meshed by the same meshJob: a sub-node of n x n cells round the middle (n = 16, 32, 48,
//     64: re-meshing only the dirty part of a node), and the columns clipped to a z band (the dense array only over an
//     edit's z-range +- margin; the faces at the band's ends come out wrong, the time is what counts).
// Nothing is written. usage (in web/): node tools/mesh-profile.mjs [tx_ty, default 63_21]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import inspector from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(web, 'public/data');
globalThis.self ??= globalThis;
const imp = async (p) => (await runnerImport(path.join(web, p), { root: web, logLevel: 'error' })).module;
const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts'), TD = await imp('src/tile-data.ts');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const N = meta.tiles.N, S = N + 2, ctx = { N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
const raw = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const has = (f) => fs.existsSync(path.join(dir, 'tiles', `${f}.bin`));
const [mx, my] = (process.argv[2] ?? '63_21').split('_').map(Number);
const nodes = [];
for (let r = 0; nodes.length < 20 && r < 6; r++) for (let ty = my - r; ty <= my + r; ty++) for (let tx = mx - r; tx <= mx + r; tx++) {
  if (Math.max(Math.abs(tx - mx), Math.abs(ty - my)) === r && nodes.length < 20 && has(`1/${tx}_${ty}`)) nodes.push({ tx, ty, d: TD.decodeTile(raw(`1/${tx}_${ty}`), N) });
}
const cols = (d) => ({ counts: d.counts, runs: d.runs, ground: d.ground, planes: d.planes, bld: d.bld });
const job = (n, c = cols(n.d), NN = N) => mesher.meshJob({ ...req.tileRequest({ ...ctx, N: NN }, 1, n.tx, n.ty, false, (k) => k), N: NN, url: undefined, cols: c }, async () => { throw new Error('no file'); });
const stat = (a) => `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} / ${Math.max(...a).toFixed(1)}`;
async function timeAll(f, passes = 3) {
  const t = [];
  for (let p = 0; p < passes; p++) for (const n of nodes) { const t0 = performance.now(); await f(n); t.push(performance.now() - t0); }
  return t;
}

// the dense volume per node (meshTile: S x S x (zmax + 2) uint16)
const zmaxOf = (d) => { let z = 0; for (let c = 0, k = 0; c < d.counts.length; k += 3 * d.counts[c++]) if (d.counts[c]) z = Math.max(z, d.runs[k + 3 * (d.counts[c] - 1)] + d.runs[k + 3 * (d.counts[c] - 1) + 1]); return z; };
const zs = nodes.map((n) => zmaxOf(n.d));
console.log(`${nodes.length} nodes round ${mx}_${my}: zmax mean ${(zs.reduce((a, b) => a + b) / zs.length).toFixed(0)} max ${Math.max(...zs)} -> dense volume ${(S * S * (Math.max(...zs) + 2) * 2 / 1e6).toFixed(1)} MB at most`);
for (let w = 0; w < 2; w++) await timeAll(job, 1);
const whole = await timeAll(job);
console.log(`meshJob (cols) whole node  ms mean / max  ${stat(whole)}`);
// an edit re-meshes the node's foliage tile too, and with it the base again without what the grass covers (dig.ts)
const fols = nodes.filter((n) => has(`1f/${n.tx}_${n.ty}`));
for (const n of fols) n.f = TD.decodeTile(raw(`1f/${n.tx}_${n.ty}`), N);
const fjob = (n) => mesher.meshJob({ ...req.tileRequest(ctx, 1, n.tx, n.ty, true, (k) => k), url: undefined, cols: { ...n.f, ground: n.d.ground }, under: cols(n.d) }, async () => { throw new Error('no file'); });
if (fols.length) {
  const save = nodes.splice(0, nodes.length, ...fols);
  for (let w = 0; w < 2; w++) await timeAll(fjob, 1);
  const ft = await timeAll(fjob);
  console.log(`  + its foliage tile and the base's cover (${fols.length} nodes)  ms mean / max  ${stat(ft)}`);
  // an edited node with foliage (stream.ts replaceColumns): the foliage job alone (its cover is the base's mesh); were
  // the base meshed plain too, that node's whole-node time on top (per pass, the same nodes)
  const wt = new Map(nodes.map((n, i) => [n, whole.filter((_, k) => k % nodes.length === i)]));
  const plus = ft.map((t, k) => t + wt.get(fols[k % fols.length])[Math.floor(k / fols.length)]);
  console.log(`  an edited node with foliage: foliage job (cover) ${stat(ft)}; with the base meshed plain too ${stat(plus)}`);
  const fonly = (n) => mesher.meshJob({ ...req.tileRequest(ctx, 1, n.tx, n.ty, true, (k) => k), url: undefined, cols: { ...n.f, ground: n.d.ground }, under: cols(n.d), base: null }, null);
  for (let w = 0; w < 2; w++) await timeAll(fonly, 1);
  console.log(`    of which the foliage tile alone  ms mean / max  ${stat(await timeAll(fonly))}`);
  nodes.splice(0, nodes.length, ...save);
}

// --- the profile ---
const session = new inspector.Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 100 });
await session.post('Profiler.start');
await timeAll(job, 5);
const { profile } = await session.post('Profiler.stop');
session.disconnect();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const dt = new Map();
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
const label = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${path.basename(f.url.split('?')[0])}:${f.lineNumber + 1}`; };
const self = new Map(), incl = new Map();
let total = 0;
for (const [id, us] of dt) {
  const n = byId.get(id), l = label(n);
  if (n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)') continue;
  total += us;
  self.set(l, (self.get(l) ?? 0) + us);
  const seen = new Set();
  for (let p = id; p !== undefined; p = parent.get(p)) { const pl = label(byId.get(p)); if (!seen.has(pl)) { seen.add(pl); incl.set(pl, (incl.get(pl) ?? 0) + us); } }
}
const runs = 5 * nodes.length, ms = (us) => (us / 1000 / runs).toFixed(2).padStart(6);
console.log(`\nprofile: ${(total / 1000 / runs).toFixed(1)} ms per node sampled; self / inclusive ms per node`);
const rows = [...incl.keys()].filter((l) => /mesher\.worker|chamfer|roofs|ramps|tile-data/.test(l) || /^(fill|meshTile|meshFaces)/.test(l))
  .sort((a, b) => incl.get(b) - incl.get(a)).slice(0, 24);
for (const l of rows) console.log(`  ${ms(self.get(l) ?? 0)} ${ms(incl.get(l))}  ${l}`);
const other = [...self.entries()].filter(([l]) => !rows.includes(l)).sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log('  other self:', other.map(([l, us]) => `${l.split(' ')[0]} ${ms(us).trim()}`).join(', '));

// --- what-ifs ---
// a sub-node of n x n cells round the node's middle, its apron the cells round it, as a node of N = n
function subNode(d, n) {
  const s = n + 2, o = (N - n) / 2, off = new Uint32Array(S * S + 1);
  for (let c = 0; c < S * S; c++) off[c + 1] = off[c] + d.counts[c];
  const counts = new Uint16Array(s * s), ground = new Uint8Array(s * s), planes = d.planes && new Uint16Array(s * s), bld = d.bld && new Uint16Array(s * s), r = [];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const c = (x + o) + S * (y + o), k = x + s * y;
    counts[k] = d.counts[c]; ground[k] = d.ground[c];
    if (planes) planes[k] = d.planes[c];
    if (bld) bld[k] = d.bld[c];
    for (let i = off[c] * 3; i < off[c + 1] * 3; i++) r.push(d.runs[i]);
  }
  return { counts, runs: Uint16Array.from(r), ground, planes, bld };
}
// the columns clipped to cells [z0, z0 + h) and moved down by z0 (the dense array over that band only)
function zBand(d, z0, h) {
  const counts = new Uint16Array(d.counts.length), ground = new Uint8Array(d.ground.length), r = [];
  for (let c = 0, k = 0; c < d.counts.length; c++) {
    for (let i = 0; i < d.counts[c]; i++, k += 3) {
      const a = Math.max(d.runs[k], z0), b = Math.min(d.runs[k] + d.runs[k + 1], z0 + h);
      if (a < b) { r.push(a - z0, b - a, d.runs[k + 2]); counts[c]++; }
    }
    ground[c] = Math.max(0, Math.min(h, d.ground[c] - z0));
  }
  return { counts, runs: Uint16Array.from(r), ground, planes: d.planes, bld: d.bld };
}
const subs = new Map(nodes.map((n) => [n, [16, 32, 48, 64].map((k) => subNode(n.d, k))]));
for (const [i, k] of [16, 32, 48, 64].entries()) {
  for (let w = 0; w < 2; w++) await timeAll((n) => job(n, subs.get(n)[i], k), 1);
  console.log(`sub-node ${String(k).padStart(2)} x ${k} round the middle  ms mean / max  ${stat(await timeAll((n) => job(n, subs.get(n)[i], k)))}`);
}
// a crater's band: from 8 m under the middle column's ground to 8 m over it (r 4 m +- 4 m margin)
const bands = new Map(nodes.map((n) => { const g = n.d.ground[N / 2 + 1 + S * (N / 2 + 1)]; return [n, zBand(n.d, Math.max(0, g - 8), 16)]; }));
for (let w = 0; w < 2; w++) await timeAll((n) => job(n, bands.get(n)), 1);
console.log(`whole node, z band ground +- 8 m (16 cells)  ms mean / max  ${stat(await timeAll((n) => job(n, bands.get(n))))}`);
const both = new Map(nodes.map((n) => [n, subNode(bands.get(n), 32)]));
for (let w = 0; w < 2; w++) await timeAll((n) => job(n, both.get(n), 32), 1);
console.log(`sub-node 32 x 32, z band 16 cells  ms mean / max  ${stat(await timeAll((n) => job(n, both.get(n), 32)))}`);
process.exit(0);
