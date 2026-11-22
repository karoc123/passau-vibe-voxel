// (docs/plans/life-physics.md) Where the traffic's paths (traffic.json, heights baked) leave no room for a
// physical car: every metre of every road's centreline, solid voxels (the Rapier terrain's: terrainTile) between 0.6 and
// 1.8 m over the path's height (a car's body), or the ground more than 0.5 m over / 1.5 m under it (a step, a hole).
// usage (in web/): node tools/life-phys-scan.mjs [-v]   prints the share of road length blocked, and the worst roads
import { realTile, readMeta, trafficRoads } from './real-city.mjs';

const N = readMeta().tiles.N, roads = await trafficRoads();
const col = async (x, z) => {
  const t = await realTile(Math.floor(x / N), Math.floor(z / N));
  if (!t) return null;
  return { t, c: (Math.floor(x) % N) + 1 + t.S * ((Math.floor(z) % N) + 1) };
};
let total = 0, body = 0, step = 0;
const worst = [];
for (const [i, r] of roads.entries()) {
  let L = 0, b = 0, s = 0;
  for (let k = 0; k < r.p.length - 1; k++) {
    const [ax, az, ay] = r.p[k], [bx, bz, by] = r.p[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
    for (let j = 0; j < n; j++) {
      const f = j / n, x = ax + (bx - ax) * f, z = az + (bz - az) * f, y = ay + (by - ay) * f;
      const q = await col(x, z);
      if (!q) continue;
      L++;
      const { iv, off } = q.t;
      let solid = false, g = 0;
      for (let m = off[q.c]; m < off[q.c + 1]; m += 2) {
        if (iv[m] < y + 1.8 && iv[m + 1] > y + 0.6) solid = true;
        if (iv[m + 1] <= y + 0.6) g = iv[m + 1];
      }
      if (solid) b++;
      else if (y - g > 1.5) s++;
    }
  }
  total += L; body += b; step += s;
  if (b) worst.push([i, b, L]);
}
worst.sort((a, b) => b[1] - a[1]);
console.log(`roads ${roads.length}, ${(total / 1000).toFixed(1)} km of centreline sampled every metre`);
console.log(`solid in the car's body space (0.6-1.8 m over the path): ${body} m (${(100 * body / total).toFixed(2)} %) on ${worst.length} roads`);
console.log(`ground more than 1.5 m under the path (no solid in the body space): ${step} m (${(100 * step / total).toFixed(2)} %)`);
console.log(`worst roads (index: blocked m / length m): ${worst.slice(0, 15).map(([i, b, L]) => `${i}:${b}/${L}`).join(' ')}`);
