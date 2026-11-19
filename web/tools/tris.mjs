// The triangles of every tile as the viewer meshes it: the mesher itself (src/mesher.worker.ts meshJob) run in Node
// over web/public/data/tiles, each tile with what stream.ts sends with it (src/tile-request.ts). Writes
//   meta.json  tiles.tris: { level: triangles per tile, row-major (ty * nx + tx) }, levels "1", "2", "4", "8" (the
//              node's own mesh; 8 as the clay is meshed), "1f" (a foliage tile's own mesh) and "1c" (its base tile's
//              mesh once the foliage shows: without the faces the grass covers, stream.ts coverBase; a 1 m tile with
//              its foliage draws 1c + 1f)
//   zones.json each block's triangles at 1 m (blocks[k][7], city.ts budget): level 1's quads by the column under their
//              middle
// Needs zones.bin (the buildings split the mesh's faces): scripts/build_data.sh runs it after zones.py.
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
const zbuf = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'zones.bin')));
const zw = new Uint16Array(zbuf.buffer, zbuf.byteOffset, 2 * W * D), blk = zw.subarray(0, W * D);
const ctx = { N, W, D, clay: levels.at(-1), ...req.paletteFlags(meta.palette), bldMap: { data: zw.slice(W * D), W } };
const load = async (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const zonesFile = path.join(dir, 'zones.json'), zones = JSON.parse(fs.readFileSync(zonesFile, 'utf8'));
const blockTris = new Float64Array(zones.blocks.length);
// a mesh's quads (2 triangles each) to the blocks under their middles
const byBlock = (o) => {
  const p = o.pos;
  for (let q = 0; q < o.quads; q++) {
    let x = 0, z = 0;
    for (let k = 0; k < 4; k++) { x += p[q * 12 + k * 3]; z += p[q * 12 + k * 3 + 2]; }
    const X = Math.min(W - 1, Math.max(0, Math.floor(x / 4))), Y = Math.min(D - 1, Math.max(0, Math.floor(z / 4))), b = blk[Y * W + X];
    if (b) blockTris[b - 1] += 2;
  }
};

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
    if (s === 1) byBlock(out);
    if (fol && fs.existsSync(path.join(dir, 'tiles', `1f/${tx}_${ty}.bin`))) {
      const f = await mesher.meshJob(req.tileRequest(ctx, 1, tx, ty, true, (k) => k), load);
      fol[i] = f.out.quads * 2; cov[i] = (f.base?.quads ?? 0) * 2;
    } else if (cov) cov[i] = own[i];
  }
}
meta.tiles.tris = tris;
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
zones.blocks.forEach((b, k) => { b.length = 7; b.push(blockTris[k]); });
fs.writeFileSync(zonesFile, JSON.stringify(zones));
const M = (a) => (a.reduce((x, y) => x + y, 0) / 1e6).toFixed(2);
console.log(Object.entries(tris).map(([k, a]) => `${k}: ${M(a)} M`).join('  '), ` blocks ${M([...blockTris])} M`, ` ${((performance.now() - t0) / 1000).toFixed(1)} s`);
