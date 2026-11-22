// Where the traffic's paths (traffic.json) leave no room for a car on the drawn surface (docs/plans/road-clearance.md,
// docs/plans/life-physics.md): every metre of every road's centreline -- or, --lanes, of every lane's path as the
// traffic drives it (o0 + lane * 3 m right of the road's line, mitred: sim/path.ts at) --, across a car's footprint
// (+-0.8 m), the surface the car stands on (the highest solid top, a cap as drawn, at most 1.2 m over the path's whole-
// level height) and what is over it (the Rapier terrain's solids: terrainTile, the foliage tile's included):
//   body  solid less than 1.8 m over the surface (a car's body), or no surface at all (the path in a wall)
//   step  the surface 0.6 m or more off a metre on, or across the footprint (a riser a wheel hits or drops off)
//   hole  the surface 1.5 m or more under the path
// usage (in web/): node tools/life-phys-scan.mjs [--lanes] [--dump FILE] [--near X,Z,R]
//   prints the length of each and the worst roads; --dump writes each flagged metre as a JSON line {i, lane (-1: the
//   centreline), x, z, y (the path's), k, s (the surface), g (the column's ground top), cap (1: its ground run capped),
//   across and ss (a step: across the footprint, the footprint's surfaces), prev (the surface a metre before), b, mat,
//   fol, side (a body: the lowest solid voxel's level, palette id, 1 if the foliage tile's, the footprint's offset)}:
//   scripts/clearance.py sorts them into classes; --near: only the roads with a point within R m of (X, Z)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DATA, realTile, readMeta, trafficRoads, load } from './real-city.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LANES = process.argv.includes('--lanes'), DUMP = arg('--dump'), NEAR = arg('--near')?.split(',').map(Number);
const N = readMeta().tiles.N, roads = await trafficRoads(), { prepPath, at } = await load('sim/path.ts');
const TD = await load('tile-data.ts'), { semanticTable, RULES } = await load('core/semantics.ts'), { surfaceAt } = await load('core/surface.ts');
const sem = semanticTable(readMeta().palette), solid = (m) => RULES.solidForCar(sem[m] ?? 1);
// the tiles' own columns (materials), beside terrainTile's merged intervals
const raw = new Map();
const rawTile = (tx, tz) => {
  const k = `${tx}_${tz}`;
  if (!raw.has(k)) {
    const f = `${DATA}tiles/1/${k}.bin`;
    if (!fs.existsSync(f)) raw.set(k, null);
    else {
      const dec = (p) => { const t = TD.decodeTile(zlib.gunzipSync(fs.readFileSync(`${DATA}tiles/${p}`)).buffer, N); const o = new Uint32Array(t.counts.length + 1); for (let i = 0; i < t.counts.length; i++) o[i + 1] = o[i] + t.counts[i]; t.off = o; return t; };
      raw.set(k, { b: dec(`1/${k}.bin`), f: dec(`1f/${k}.bin`) });
    }
  }
  return raw.get(k);
};
const col = async (x, z) => {
  const tx = Math.floor(x / N), tz = Math.floor(z / N), t = await realTile(tx, tz);
  if (!t) return null;
  return { t, r: rawTile(tx, tz), c: (Math.floor(x) - tx * N) + 1 + t.S * ((Math.floor(z) - tz * N) + 1) };
};
// the lowest solid voxel at level >= lo, < hi in the column: [level, mat, foliage?]
const blocker = (r, c, lo, hi) => {
  let best = null;
  for (const [t, fol] of [[r.b, 0], [r.f, 1]]) {
    for (let k = t.off[c]; k < t.off[c + 1]; k++) {
      const z0 = t.runs[3 * k], z1 = z0 + t.runs[3 * k + 1], m = t.runs[3 * k + 2];
      if (!solid(m) || z1 <= lo || z0 >= hi) continue;
      const v = Math.max(z0, Math.ceil(lo));
      if (!best || v < best[0]) best = [v, m, fol];
    }
  }
  return best;
};
const out = DUMP ? fs.openSync(DUMP, 'w') : null;
// the drawn surface at (x, z) a car on the path at height y stands on: the top (its cap as drawn) of the highest solid
// interval whose top is at most 1.2 m over y (the path's heights are whole levels, a ramp's cap up to 60/64 m off its
// voxel's top: caps.CLAMP); and the bottom of the next solid interval over it (what the car's body meets). s null: in a wall
async function surface(x, z, y) {
  const q = await col(x, z);
  if (!q) return null;
  const { iv, off: o } = q.t, fx = x - Math.floor(x), fz = z - Math.floor(z);
  let s = null, over = Infinity;
  for (let m = o[q.c]; m < o[q.c + 1]; m += 2) {
    const top = surfaceAt(q.t.caps, q.c, iv[m + 1], fx, fz);
    if (top <= y + 1.2) { s = top; over = Infinity; } else if (over === Infinity) over = iv[m];
  }
  return { q, s, over };
}
// lateral samples of a car's footprint (m right of its path; a car is ~1.8 m wide)
const SIDES = [0, -0.8, 0.8];
let total = 0, nBody = 0, nStep = 0, nHole = 0;
const worst = [], P = { x: 0, y: 0, z: 0 };
for (const [i, r] of roads.entries()) {
  if (NEAR && !r.p.some((q) => Math.hypot(q[0] - NEAR[0], q[1] - NEAR[1]) < NEAR[2])) continue;
  const e = prepPath({ p: r.p.map((q) => [q[0], q[1], q[2]]) });
  let L = 0, b = 0;
  for (const lane of LANES ? Array.from({ length: r.lanes }, (_, k) => k) : [-1]) {
    const off = lane < 0 ? 0 : r.o0 + lane * 3;
    let prev = null;
    for (let d = 0; d < e.L; d += 1) {
      const S = [];
      for (const w of SIDES) { at(e, d, off + w, P); S.push({ x: P.x, z: P.y, y: P.z, ...(await surface(P.x, P.y, P.z)) }); }
      const c = S[0];
      if (!c.q) continue;
      L++;
      // body: in a wall, or solid less than 1.8 m over the surface, under any of the footprint's samples; step: the
      // surface a metre on (or across the footprint) 0.6 m or more off; hole: the surface 1.5 m or more under the path
      let k = null, at_ = c, across = 0;
      for (const t of S) if (t.q && (t.s === null || t.over < t.s + 1.8)) { k = 'body'; at_ = t; break; }
      if (!k && c.s !== null) {
        const ds = [prev, ...S.slice(1).map((t) => t.s)].map((v) => (v === null || v === undefined ? 0 : Math.abs(v - c.s)));
        if (ds.some((v) => v >= 0.6)) { k = 'step'; across = ds[0] < 0.6 ? 1 : 0; }
        else if (c.y - c.s > 1.5) k = 'hole';
      }
      const prev0 = prev;
      prev = c.s;
      if (k === 'body') b++;
      if (k) {
        if (k === 'body') nBody++; else if (k === 'step') nStep++; else nHole++;
        if (out) {
          const q = at_.q, lo = at_.s === null ? Math.floor(at_.y) : Math.floor(at_.s), bl = k === 'body' ? blocker(q.r, q.c, lo, lo + 2.8) : null;
          const r2 = (v) => (v === null || v === undefined ? null : +v.toFixed(2));
          fs.writeSync(out, JSON.stringify({
            i, lane, x: +c.x.toFixed(1), z: +c.z.toFixed(1), y: r2(c.y), k, s: r2(c.s), g: q.r.b.ground[q.c], cap: q.t.caps?.z[2 * q.c] ? 1 : 0,
            ...(k === 'step' ? { across, ss: S.map((t) => r2(t.s)), prev: r2(prev0) } : {}),
            ...(bl ? { b: bl[0], mat: bl[1], fol: bl[2], side: SIDES[S.indexOf(at_)] } : {}),
          }) + '\n');
        }
      }
    }
  }
  total += L;
  if (b) worst.push([i, b, L]);
}
if (out) fs.closeSync(out);
worst.sort((a, b) => b[1] - a[1]);
const what = LANES ? 'lane path' : 'centreline', pc = (v) => `${v} m (${(100 * v / total).toFixed(2)} %)`;
console.log(`roads ${roads.length}, ${(total / 1000).toFixed(1)} km of ${what} sampled every metre, a car's footprint (+-0.8 m) on the drawn surface`);
console.log(`body: solid less than 1.8 m over the surface, or in a wall: ${pc(nBody)} on ${worst.length} roads`);
console.log(`step: the surface 0.6 m or more off a metre on or across the car: ${pc(nStep)}`);
console.log(`hole: the surface 1.5 m or more under the path: ${pc(nHole)}`);
console.log(`worst roads (index: body m / length m): ${worst.slice(0, 15).map(([i, b, L]) => `${i}:${b}/${L}`).join(' ')}`);
