// The triangles of every tile as the viewer meshes it: the mesher itself (src/mesher.worker.ts meshJob) run in Node
// over web/public/data/tiles, each tile with what stream.ts sends with it (src/tile-request.ts). Writes
//   meta.json  tiles.tris: { level: triangles per tile, row-major (ty * nx + tx) }, levels "1", "2", "4", "8" (the
//              node's own mesh: city.ts budget), "1f" (a foliage tile's own mesh) and "1c" (its base tile's mesh once
//              the foliage shows: without the faces the grass covers, stream.ts coverBase; a 1 m tile with its foliage
//              draws 1c + 1f), required by the viewer (city.ts budget)
// Needs the tiles' buildings (they split the mesh's faces: scripts/tile_fields.py bldg): scripts/build_data.sh runs
// it after tile_fields.py.
//
// A job is one node (level, tx, ty) or, at level 1, the foliage over it. Jobs run in --jobs K worker processes (default
// min(8, cpus / 2); each imports the mesher itself) and are cached per job in data/cache/tris.json (the repo's data/,
// not under public/): a job's key is a hash of its id, the node files it read (names and the sha256 of their bytes),
// the tile context (N, W, D, the palette's flags) and the mesher's code (the import closure of src/mesher.worker.ts and
// src/tile-request.ts, this file, package.json, pnpm-lock.yaml; every file under src/ if the closure cannot be
// followed). An entry is valid when its key, made again over the files it read last time, is the same: only the nodes
// whose files (or the code) changed are meshed again. --no-cache ignores the cache (and writes it afresh).
// usage (in web/): node tools/tris.mjs [data dir, default public/data] [--jobs K] [--no-cache]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const t0 = performance.now();
const self_ = fileURLToPath(import.meta.url);
const web = path.join(path.dirname(self_), '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const posArgs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--jobs');
const dir = path.resolve(posArgs[0] ?? path.join(web, 'public/data'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- the worker: meshes the jobs it is sent

async function worker() {
  globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
  const { runnerImport } = await import('vite');
  const { module: mesher } = await runnerImport(path.join(web, 'src/mesher.worker.ts'), { root: web, logLevel: 'error' });
  const { module: req } = await runnerImport(path.join(web, 'src/tile-request.ts'), { root: web, logLevel: 'error' });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const ctx = { N: meta.tiles.N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
  process.on('message', async (jobs) => {
    const out = [];
    for (const [id, s, tx, ty, fol] of jobs) {
      const read = [];
      // every file the job reads, and the hash of its bytes (the cache's key)
      const load = async (f) => {
        let raw;
        try { raw = fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`)); } catch (e) { read.push([f, null]); throw e; }
        read.push([f, sha(raw)]);
        const b = zlib.gunzipSync(raw);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      };
      const r = await mesher.meshJob(req.tileRequest(ctx, s, tx, ty, fol, (k) => k), load);
      out.push([id, read, fol ? [r.out.quads * 2, (r.base?.quads ?? 0) * 2] : [r.out.quads * 2]]);
    }
    process.send(out, () => {});
  });
  process.on('disconnect', () => process.exit(0));
  process.send('ready');
}

if (argv.includes('--worker')) {
  await worker();
} else {
  await main();
}

// ---------------------------------------------------------------- the code's hash

function codeHash() {
  const src = path.join(web, 'src'), files = new Set(), todo = [path.join(src, 'mesher.worker.ts'), path.join(src, 'tile-request.ts')];
  let ok = true;
  const resolve = (from, spec) => {
    const b = path.resolve(path.dirname(from), spec);
    for (const c of [b, `${b}.ts`, `${b}.tsx`, b.replace(/\.js$/, '.ts'), path.join(b, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  };
  while (todo.length) {
    const f = todo.pop();
    if (files.has(f)) continue;
    files.add(f);
    const text = fs.readFileSync(f, 'utf8');
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
    for (let m; (m = re.exec(text));) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // (a package: pnpm-lock.yaml below)
      const r = resolve(f, spec);
      if (r) todo.push(r); else ok = false;
    }
  }
  let list = [...files];
  if (!ok) {
    list = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else list.push(p); } };
    walk(src);
  }
  list.push(self_, path.join(web, 'package.json'), path.join(web, 'pnpm-lock.yaml'), path.join(web, 'package-lock.json'));
  const h = crypto.createHash('sha256');
  for (const f of list.sort()) h.update(`${path.relative(web, f)}\n`).update(fs.existsSync(f) ? fs.readFileSync(f) : 'missing').update('\n');
  return h.digest('hex');
}

// ---------------------------------------------------------------- the parent: which jobs, the cache, the workers

async function main() {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const N = meta.tiles.N, levels = meta.tiles.levels.map((l) => l.s).sort((a, b) => a - b);
  const has = (f) => fs.existsSync(path.join(dir, 'tiles', `${f}.bin`));
  // the jobs, in the order the counts are put together
  const jobs = [];
  for (const s of levels) {
    const { nx, ny } = meta.tiles.levels.find((l) => l.s === s);
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      if (!has(`${s}/${tx}_${ty}`)) continue; // (none written: nothing in it)
      jobs.push([`${s}/${tx}_${ty}`, s, tx, ty, false]);
      if (s === 1 && has(`1f/${tx}_${ty}`)) jobs.push([`1f/${tx}_${ty}`, 1, tx, ty, true]);
    }
  }
  // the context's hash: what tileRequest takes besides the node (the palette's flags follow from meta.palette)
  const ctxH = sha(JSON.stringify([N, meta.W, meta.D, meta.palette]));
  const code = codeHash();
  const cacheF = path.join(web, '..', 'data', 'cache', 'tris.json');
  const noCache = argv.includes('--no-cache');
  let cache = { jobs: {} };
  if (!noCache) try { cache = JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch { cache = { jobs: {} }; }
  const fileH = new Map();
  const hashOf = (f) => {
    if (!fileH.has(f)) { let h = null; try { h = sha(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); } catch { h = null; } fileH.set(f, h); }
    return fileH.get(f);
  };
  const keyOf = (id, read) => sha(JSON.stringify([id, read, ctxH, code]));
  const res = new Map(), stale = [];
  for (const j of jobs) {
    const e = cache.jobs?.[j[0]];
    if (e && e.key === keyOf(j[0], e.files.map((f) => [f, hashOf(f)]))) res.set(j[0], e.out);
    else stale.push(j);
  }
  const fresh = {};
  if (stale.length) {
    const K = Math.max(1, Math.min(stale.length, Number(opt('--jobs')) || Math.min(8, Math.floor(os.cpus().length / 2))));
    // jobs handed out in small batches as workers come free (big and empty nodes mixed: no shard waits for the others)
    let next = 0;
    const B = 8;
    await Promise.all(Array.from({ length: K }, () => new Promise((ok, fail) => {
      const ch = fork(self_, [dir, '--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const give = () => {
        if (next >= stale.length) { ch.disconnect(); return; }
        ch.send(stale.slice(next, next + B)); next += B;
      };
      ch.on('message', (m) => {
        if (m !== 'ready') for (const [id, read, out] of m) { res.set(id, out); fresh[id] = { files: read.map((r) => r[0]), key: keyOf(id, read), out }; }
        give();
      });
      ch.on('exit', (c) => (c ? fail(new Error(`tris worker exited with ${c}`)) : ok()));
      ch.on('error', fail);
    })));
  }
  // the counts, built as before (the same key order: JSON.stringify(meta) gives the same bytes)
  const tris = {};
  for (const s of levels) {
    const { nx, ny } = meta.tiles.levels.find((l) => l.s === s);
    const own = (tris[s] = new Array(nx * ny).fill(0));
    const fol = s === 1 ? (tris['1f'] = new Array(nx * ny).fill(0)) : null, cov = s === 1 ? (tris['1c'] = new Array(nx * ny).fill(0)) : null;
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const i = ty * nx + tx, r = res.get(`${s}/${tx}_${ty}`);
      if (!r) continue;
      own[i] = r[0];
      const f = fol ? res.get(`1f/${tx}_${ty}`) : null;
      if (f) { fol[i] = f[0]; cov[i] = f[1]; } else if (cov) cov[i] = own[i];
    }
  }
  meta.tiles.tris = tris;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  // the cache: the entries of this run's jobs (the others' nodes are gone), written whole, atomically
  const keep = { code, jobs: {} };
  for (const [id] of jobs) keep.jobs[id] = fresh[id] ?? cache.jobs[id];
  fs.mkdirSync(path.dirname(cacheF), { recursive: true });
  const tmp = `${cacheF}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keep));
  fs.renameSync(tmp, cacheF);
  const M = (a) => (a.reduce((x, y) => x + y, 0) / 1e6).toFixed(2);
  console.log(Object.entries(tris).map(([k, a]) => `${k}: ${M(a)} M`).join('  '),
    ` ${stale.length} of ${jobs.length} jobs meshed, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
