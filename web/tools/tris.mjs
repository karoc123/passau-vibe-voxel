// The triangles of every tile as the viewer meshes it: the mesher itself (src/mesher.worker.ts meshJob) run in Node
// over web/public/data/tiles, each tile with what stream.ts sends with it (src/tile-request.ts). Writes
//   meta.json  tiles.tris: { level: triangles per tile, row-major (ty * nx + tx) }, levels "1", "2", "4", "8" (the
//              node's own mesh: city.ts budget), "1f" (a foliage tile's own mesh) and "1c" (its base tile's mesh once
//              the foliage shows: without the faces the grass covers, stream.ts coverBase; a 1 m tile with its foliage
//              draws 1c + 1f), required by the viewer (city.ts budget)
// Needs the tiles' buildings (they split the mesh's faces: scripts/tile_fields.py bldg): scripts/build_data.sh runs
// it after tile_fields.py.
// usage (in web/): node tools/tris.mjs [data dir, default public/data]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const t0 = performance.now();
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] ?? path.join(web, 'public/data'));
globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
const { module: mesher } = await runnerImport(path.join(web, 'src/mesher.worker.ts'), { root: web, logLevel: 'error' });
const { module: req } = await runnerImport(path.join(web, 'src/tile-request.ts'), { root: web, logLevel: 'error' });

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const { W, D } = meta, N = meta.tiles.N, levels = meta.tiles.levels.map((l) => l.s).sort((a, b) => a - b);
const ctx = { N, W, D, ...req.paletteFlags(meta.palette) };
const load = async (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const tris = {};
for (const s of levels) {
  const { nx, ny } = meta.tiles.levels.find((l) => l.s === s);
  const own = (tris[s] = new Array(nx * ny).fill(0));
  const fol = s === 1 ? (tris['1f'] = new Array(nx * ny).fill(0)) : null, cov = s === 1 ? (tris['1c'] = new Array(nx * ny).fill(0)) : null;
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const i = ty * nx + tx;
    if (!fs.existsSync(path.join(dir, 'tiles', `${s}/${tx}_${ty}.bin`))) continue; // (none written: nothing in it)
    const { out } = await mesher.meshJob(req.tileRequest(ctx, s, tx, ty, false, (k) => k), load);
    own[i] = out.quads * 2;
    if (fol && fs.existsSync(path.join(dir, 'tiles', `1f/${tx}_${ty}.bin`))) {
      const f = await mesher.meshJob(req.tileRequest(ctx, 1, tx, ty, true, (k) => k), load);
      fol[i] = f.out.quads * 2; cov[i] = (f.base?.quads ?? 0) * 2;
    } else if (cov) cov[i] = own[i];
  }
}
meta.tiles.tris = tris;
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
const M = (a) => (a.reduce((x, y) => x + y, 0) / 1e6).toFixed(2);
console.log(Object.entries(tris).map(([k, a]) => `${k}: ${M(a)} M`).join('  '), ` ${((performance.now() - t0) / 1000).toFixed(1)} s`);
