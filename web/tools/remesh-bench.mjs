// Meshing from columns in memory (src/mesher.worker.ts MeshRequest cols, as stream.ts replaceColumns sends an edited
// node) on real Altstadt nodes: per 1 m node round 63_21 (up to 20), and its foliage tile,
//   1. the node meshed from its file (url) and from the same columns decoded (cols) give identical buffers; its foliage
//      tile likewise, with its base handed over as columns (stream.ts) or from the file, and the base's cover;
//   2. a sphere of 3 m carved (src/core/columns.ts EditableNode) at the node's middle, on its ground, changes the mesh;
//   3. the time of decode + edit (carve, encode) + mesh, mean and max over the nodes (after one pass to warm the JIT).
//   4. that carve meshed in sections, as stream.ts meshes an edited node (below).
// Nothing is written. usage (in web/): node tools/remesh-bench.mjs [tx_ty of the middle, default 63_21]; exit code 1
// on a mismatch
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { imp } from './lib.mjs';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(web, 'public/data');
globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts');
const TD = await imp('src/tile-data.ts'), CO = await imp('src/core/columns.ts');

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const N = meta.tiles.N, ctx = { N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
const raw = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const files = new Map();
const load = async (f) => { if (!files.has(f)) files.set(f, raw(f)); return files.get(f).slice(0); };
const has = (f) => fs.existsSync(path.join(dir, 'tiles', `${f}.bin`));

const [mx, my] = (process.argv[2] ?? '63_21').split('_').map(Number);
const nodes = [];
for (let r = 0; nodes.length < 20 && r < 6; r++) for (let ty = my - r; ty <= my + r; ty++) for (let tx = mx - r; tx <= mx + r; tx++) {
  if (Math.max(Math.abs(tx - mx), Math.abs(ty - my)) === r && nodes.length < 20 && has(`1/${tx}_${ty}`)) nodes.push([tx, ty]);
}

const bad = [];
const fail = (w) => { if (bad.length < 20) console.log(`  FAIL ${w}`); bad.push(w); };
const KEYS = ['pos', 'attr', 'pal', 'bld', 'faces', 'normals', 'cuts', 'box'];
function same(name, a, b) {
  if (!a || !b) { if (!a !== !b) fail(`${name}: one mesh missing`); return; }
  if (a.quads !== b.quads) return fail(`${name}: ${a.quads} quads, not ${b.quads}`);
  for (const k of KEYS) {
    const x = a[k], y = b[k];
    if (!x || !y) { if (!x !== !y) fail(`${name}.${k}: one missing`); continue; }
    if (x.length !== y.length) { fail(`${name}.${k}: ${x.length} values, not ${y.length}`); continue; }
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && !(Number.isNaN(x[i]) && Number.isNaN(y[i]))) { fail(`${name}.${k}[${i}]: ${x[i]} != ${y[i]}`); break; }
  }
}
const copy = (c) => ({ counts: c.counts.slice(), runs: c.runs.slice(), ground: c.ground.slice(), planes: c.planes?.slice() ?? null, bld: c.bld?.slice() ?? null, caps: c.caps ?? null, roofCaps: c.roofCaps ?? null });
const file = (k) => k;

// 1. the same meshes from the file and from the columns
let groundSame = 0, folNodes = 0;
for (const [tx, ty] of nodes) {
  const name = `${tx}_${ty}`;
  const a = await mesher.meshJob(req.tileRequest(ctx, 1, tx, ty, false, file, true), load);
  const b = await mesher.meshJob({ ...req.tileRequest(ctx, 1, tx, ty, false, file, false), url: undefined, cols: copy(a.keep) }, load);
  same(`1/${name}`, a.out, b.out);
  if (!has(`1f/${name}`)) continue;
  folNodes++;
  const fr = req.tileRequest(ctx, 1, tx, ty, true, file);
  const fa = await mesher.meshJob(fr, load); // (foliage and its base from the files)
  const fdec = TD.decodeTile(raw(`1f/${name}`), N);
  const fb = await mesher.meshJob({ ...fr, url: undefined, cols: copy(fdec), under: copy(a.keep) }, load); // (both as columns)
  same(`1f/${name}`, fa.out, fb.out);
  same(`1c/${name}`, fa.base, fb.base);
  if (fdec.ground.every((g, i) => g === a.keep.ground[i])) groundSame++;
}

// 2, 3. carve at the middle, on the ground; timed
const t = { decode: [], edit: [], mesh: [], all: [] };
let changed = 0;
for (let pass = 0; pass < 2; pass++) {
  for (const k of Object.keys(t)) t[k].length = 0;
  for (const [tx, ty] of nodes) {
    const buf = raw(`1/${tx}_${ty}`), S = N + 2;
    const t0 = performance.now();
    const d = TD.decodeTile(buf, N);
    const t1 = performance.now();
    const e = new CO.EditableNode(N, d, tx, ty), c = N / 2;
    e.carveSphere([c, c, d.ground[c + 1 + S * (c + 1)]], 3);
    const enc = { ...e.encode(), planes: d.planes, bld: d.bld, caps: d.caps, roofCaps: d.roofCaps };
    const t2 = performance.now();
    const m = await mesher.meshJob({ ...req.tileRequest(ctx, 1, tx, ty, false, file, false), url: undefined, cols: enc }, load);
    const t3 = performance.now();
    t.decode.push(t1 - t0); t.edit.push(t2 - t1); t.mesh.push(t3 - t2); t.all.push(t3 - t0);
    if (pass) {
      const before = await mesher.meshJob({ ...req.tileRequest(ctx, 1, tx, ty, false, file, false), url: undefined, cols: copy(d) }, load);
      if (m.out.quads !== before.out.quads || m.out.pos.some((v, i) => v !== before.out.pos[i])) changed++;
      else fail(`${tx}_${ty}: the carve changed nothing`);
    }
  }
}
// 4. the same carve meshed as stream.ts meshes an edited node (docs/adr/0003-remesh-cost.md): in sections, after the
// node's first sectioned job (all of them, which leaves the worker its memo), only those the carve can have changed --
// the node's own job where it has no foliage tile, else its foliage job (the foliage's sections and the base's cover's);
// timed is that second job (tools/section-check.mjs checks that the sections are the node's mesh)
const sec = { base: [], fol: [], n: [] };
for (let pass = 0; pass < 3; pass++) {
  for (const k of Object.keys(sec)) sec[k].length = 0;
  for (const [tx, ty] of nodes) {
    const name = `${tx}_${ty}`, d = TD.decodeTile(raw(`1/${name}`), N), S = N + 2, c = N / 2;
    const e = new CO.EditableNode(N, d, tx, ty);
    e.carveSphere([c, c, d.ground[c + 1 + S * (c + 1)]], 3);
    const enc = { ...e.encode(), planes: d.planes, bld: d.bld, caps: d.caps, roofCaps: d.roofCaps };
    const hot = { x0: c - 3 + 1, y0: c - 3 + 1, x1: c + 4 + 1, y1: c + 4 + 1 };
    const job = { hot, id: `${name} ${pass} carved`, from: `${name} ${pass} all` };
    if (!has(`1f/${name}`)) {
      const r = { ...req.tileRequest(ctx, 1, tx, ty, false, file, false), url: undefined };
      await mesher.meshJob({ ...r, cols: copy(d), sections: { hot: null, id: job.from } }, load);
      const t0 = performance.now();
      const m = await mesher.meshJob({ ...r, cols: copy(enc), sections: job }, load);
      sec.base.push(performance.now() - t0); sec.n.push(m.sec.ids.length);
      continue;
    }
    const fd = TD.decodeTile(raw(`1f/${name}`), N), f = new CO.EditableNode(N, fd, tx, ty);
    f.carveSphere([c, c, d.ground[c + 1 + S * (c + 1)]], 3);
    const r = { ...req.tileRequest(ctx, 1, tx, ty, true, file), url: undefined };
    await mesher.meshJob({ ...r, cols: copy(fd), under: copy(d), sections: { hot: null, id: job.from } }, load);
    const t0 = performance.now();
    const m = await mesher.meshJob({ ...r, cols: { ...f.encode(), ground: enc.ground }, under: copy(enc), sections: job }, load);
    sec.fol.push(performance.now() - t0); sec.n.push(m.sec.ids.length + m.baseSec.ids.length);
  }
}
const stat = (a) => (a.length ? `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} / ${Math.max(...a).toFixed(1)}` : '-');
console.log(`${nodes.length} nodes round ${mx}_${my} (${folNodes} with foliage): file and columns mesh alike${bad.length ? ' -- NOT' : ''}; foliage ground = base ground in ${groundSame}/${folNodes}`);
console.log(`carve r 3 m at the middle: mesh changed in ${changed}/${nodes.length}`);
console.log(`ms mean / max  decode ${stat(t.decode)}  edit ${stat(t.edit)}  mesh ${stat(t.mesh)}  total ${stat(t.all)}`);
console.log(`  meshed in sections (stream.ts): the node's job ${stat(sec.base)}, its foliage job (with the cover) ${stat(sec.fol)}; sections meshed ${stat(sec.n)}`);
if (bad.length) { console.log(`${bad.length} mismatches`); process.exit(1); }
