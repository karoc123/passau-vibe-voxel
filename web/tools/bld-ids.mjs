// Building ids through the mesher (src/mesher.worker.ts meshTile), on synthetic tiles only: a flat slab cut into three
// stripes with ids k, k + 16384 and 65535 (16384 apart: the old 14-bit merge key could not tell them apart), otherwise
// identical. Every quad keeps one id, exact, its ground level intact, and faces never merge across ids: the slab's top
// is 3 quads, each wall across the stripes 3 times what it is with one id; the same slab with one id merges into 1
// top, whatever the id.
// Stripes along x and along y (both merge directions).
// usage (in web/): node tools/bld-ids.mjs; exit code 1 on a failure
import { imp } from './lib.mjs';

globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
const M = await imp('src/mesher.worker.ts');

const N = 18, S = N + 2, H = 4, GROUND = 3, K = 5;
const IDS = [K, K + 16384, 65535];
const bad = [];
const fail = (what) => { if (bad.length < 20) console.log(`  FAIL ${what}`); bad.push(what); };

// the slab fills the tile (the apron empty, so its border walls are open faces); idOf(x, y) per cell
function mesh(idOf) {
  const counts = new Uint16Array(S * S), ground = new Uint8Array(S * S).fill(GROUND), bld = new Uint16Array(S * S), runs = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = (y + 1) * S + x + 1;
    counts[c] = 1; runs.push(0, H, 1); bld[c] = idOf(x, y);
  }
  return M.meshTile(N, 1, 0, 0, { counts, ground, runs: Uint16Array.from(runs) }, bld, null, null, null);
}

// quads per face direction (vattr.x % 8: -x, +x, -y, +y, -z, +z as d * 2 + (dir > 0)), each checked
function check(name, out, idOf, want) {
  const per = new Map(), seen = new Set();
  for (let q = 0; q < out.quads; q++) {
    const v = q * 4, b = out.bld[v];
    for (let k = 1; k < 4; k++) if (out.bld[v + k] !== b) fail(`${name}: quad ${q} has ids ${out.bld.slice(v, v + 4)}`);
    for (let k = 0; k < 4; k++) if (out.attr[(v + k) * 4 + 2] !== GROUND) fail(`${name}: quad ${q} ground ${out.attr[(v + k) * 4 + 2]}, not ${GROUND}`);
    // its cells (x, y within the quad) all of the building it carries
    const xs = [0, 1, 2, 3].map((k) => out.pos[(v + k) * 3]), ys = [0, 1, 2, 3].map((k) => out.pos[(v + k) * 3 + 2]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let y = Math.max(0, Math.min(y0, N - 1)); y < Math.max(y1, y0 + 1) && y < N; y++)
      for (let x = Math.max(0, Math.min(x0, N - 1)); x < Math.max(x1, x0 + 1) && x < N; x++)
        if (idOf(x, y) !== b) { fail(`${name}: quad ${q} (${x0}..${x1}, ${y0}..${y1}) id ${b} covers cell ${x},${y} of id ${idOf(x, y)}`); x = N; y = N; }
    seen.add(b);
    const f = out.attr[v * 4] % 8;
    per.set(f, (per.get(f) ?? 0) + 1);
  }
  const ids = [...new Set(Array.from({ length: N * N }, (_, i) => idOf(i % N, Math.floor(i / N))))].sort((a, b) => a - b);
  if ([...seen].sort((a, b) => a - b).join() !== ids.join()) fail(`${name}: ids out ${[...seen]}, in ${ids}`);
  const got = [0, 1, 2, 3, 4, 5].map((f) => per.get(f) ?? 0);
  if (want && got.join() !== want.join()) fail(`${name}: quads per face (-x +x -y +y -z +z) ${got}, want ${want}`);
  console.log(`${name}: ${out.quads * 2} triangles, quads per face ${got}, ids ${[...seen]}`);
  return got;
}

const third = (t) => IDS[Math.min(2, Math.floor((t * 3) / N))];
// one id: a single top quad, and each wall as many quads as it takes alone (its bottom row's AO splits it), whatever
// the id; no bottom (z = -1 is solid)
const one = check(`one id ${K}`, mesh(() => K), () => K, null), wall = one.slice(0, 4);
if (one[4] !== 0 || one[5] !== 1) fail(`one id ${K}: quads per face ${one}, want one top, no bottom`);
for (const id of IDS.slice(1)) check(`one id ${id}`, mesh(() => id), () => id, one);
// stripes across x: the top and the -y / +y walls split in 3, the -x / +x walls of one id each
check('stripes along x', mesh((x) => third(x)), (x) => third(x), [wall[0], wall[1], 3 * wall[2], 3 * wall[3], 0, 3]);
check('stripes along y', mesh((x, y) => third(y)), (x, y) => third(y), [3 * wall[0], 3 * wall[1], wall[2], wall[3], 0, 3]);

if (bad.length) { console.log(`bld-ids: ${bad.length} failures`); process.exit(1); }
console.log('bld-ids: ok');
