// How the main roads drive (traffic.json roads of class 2 and 3, or 13 m/s and faster) on the drawn surface, at the
// road's speed: each road's middle lane as the traffic drives it (its outer lanes can run past the drawn carriageway),
// on through a junction into the road that goes straight on, the line averaged over SMOOTH m as a car drives it; a car
// of 2.7 m wheelbase and 1.6 m track on the surface it stands on (core/surface.ts: the highest solid top at most a
// metre over where its wheel stood a step before). Every 0.5 m:
//   bump   the body's vertical acceleration (its height: the four wheels' mean; the second difference over 2 m) past
//          BUMP: a dip or a crest a player feels, or one the car leaves the ground on
//   edge   a wheel's track bends by EDGE or more within a metre (a riser, a kerb or a pit under the carriageway, a seam)
//   steep  the grade over 10 m past STEEP
//   tight  the line's curve over 10 m past TIGHT lateral acceleration
// A spot: flagged samples of one kind within 15 m of each other; printed worst first with voxel x, z as ?cam= takes
// them, the road (index, OSM way) and its speed.
// usage (in web/): node tools/road-drive.mjs [--top N] [--near X,Z,R] [--json FILE] [--trace X,Z] [--check]
//   --check: PASS/FAIL against BUDGET; --near: only the roads with a point within R m of (X, Z) (a cut-out); --json:
//   every spot; --trace: each sample within 6 m of (X, Z), the body's height and the wheels'
import fs from 'node:fs';
import { DATA, realTile, readMeta, trafficRoads, load } from './real-city.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const TOP = +(arg('--top') ?? 15), NEAR = arg('--near')?.split(',').map(Number), JSON_OUT = arg('--json');
const TRACE = arg('--trace')?.split(',').map(Number);
const CHECK = process.argv.includes('--check');
// m/s^2: 0.4 g up or down at the body (a car on its springs takes ~0.2 g without a jolt; 1 g down at a crest and it
// leaves the ground)
const BUMP = 4;
const EDGE = 0.12; // m
const STEEP = 0.12;
// m/s^2 sideways at the road's speed: 0.5 g, where a car on the road's speed limit starts to slide
const TIGHT = 5;
// spots of each kind on the map as built, a few over (the committed tiles; a rebuild with the caps of this code takes
// some of each away: then lower them)
const BUDGET = { bump: 96, edge: 116, steep: 103, tight: 300 };
const KINDS = Object.keys(BUDGET);

const N = readMeta().tiles.N, roads = await trafficRoads(), { prepPath, at } = await load('sim/path.ts');
const { surfaceAt } = await load('core/surface.ts');

// the surface under (x, z) highest at most `lim` (cells), null: none (off the map)
const held = new Map();
async function surface(x, z, lim) {
  const tx = Math.floor(x / N), tz = Math.floor(z / N), key = tx * 4096 + tz;
  // (an await per sample was most of the run)
  let t = held.get(key);
  if (t === undefined) { t = await realTile(tx, tz); held.set(key, t); }
  if (!t) return null;
  const c = (Math.floor(x) - tx * N) + 1 + t.S * ((Math.floor(z) - tz * N) + 1), fx = x - Math.floor(x), fz = z - Math.floor(z);
  let s = null;
  for (let m = t.off[c]; m < t.off[c + 1]; m += 2) {
    const top = surfaceAt(t.caps, c, t.iv[m + 1], fx, fz);
    if (top <= lim) s = top;
  }
  return s;
}

const main = (r) => r.c >= 2 || r.v >= 13;
const STEP = 0.5, EXT = 8, WB = 1.35, TR = 0.8, SMOOTH = 3;
// the mean over +-h samples (fewer at the ends)
const mean = (a, h) => a.map((_, k) => {
  let s = 0, m = 0;
  for (let j = Math.max(0, k - h); j <= Math.min(a.length - 1, k + h); j++) { s += a[j]; m++; }
  return s / m;
});
const hits = { bump: [], edge: [], steep: [], tight: [] };
let km = 0;
const acc = []; // the body's |vertical acceleration| at every sample
const P = { x: 0, y: 0, z: 0 }, Q = { x: 0, y: 0, z: 0 };
// the road a car goes on to at a junction (or came from): the one whose first (last) segment turns least from this
// one's last (first), by 35 degrees at most, not the way back
const into = new Map(), from = new Map();
for (const [i, r] of roads.entries()) {
  if (!into.has(r.a)) into.set(r.a, []);
  into.get(r.a).push(i);
  if (!from.has(r.b)) from.set(r.b, []);
  from.get(r.b).push(i);
}
const heading = (p, k0, k1) => Math.atan2(p[k1][1] - p[k0][1], p[k1][0] - p[k0][0]);
// the points within len m of the start (end: of the end), in path order
const piece = (p, len, end) => {
  const out = [end ? p[p.length - 1] : p[0]];
  let L = 0;
  for (let k = 1; k < p.length && L < len; k++) {
    const a = end ? p[p.length - k] : p[k - 1], b = end ? p[p.length - 1 - k] : p[k];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
    out.push(b);
  }
  return end ? out.reverse() : out;
};
function neighbour(r, ahead) {
  const p = r.p, h0 = ahead ? heading(p, p.length - 2, p.length - 1) : heading(p, 0, 1);
  let best = null, bt = 35 * Math.PI / 180;
  for (const j of (ahead ? into.get(r.b) : from.get(r.a)) ?? []) {
    const o = roads[j];
    if (o.b === r.a && o.a === r.b) continue;
    const h = ahead ? heading(o.p, 0, 1) : heading(o.p, o.p.length - 2, o.p.length - 1);
    const t = Math.abs(Math.atan2(Math.sin(h - h0), Math.cos(h - h0)));
    if (t < bt) { bt = t; best = o; }
  }
  return best;
}
for (const [i, r] of roads.entries()) {
  if (!main(r)) continue;
  if (NEAR && !r.p.some((q) => Math.hypot(q[0] - NEAR[0], q[1] - NEAR[1]) < NEAR[2])) continue;
  const v = r.v, pre = neighbour(r, false), post = neighbour(r, true);
  const lane = r.o0 + (r.lanes - 1) * 1.5;
  const head = pre ? piece(pre.p, EXT + 1, true).slice(0, -1) : [], tail = post ? piece(post.p, EXT + 1, false).slice(1) : [];
  const own = prepPath({ p: r.p.map((q) => [q[0], q[1], q[2]]) });
  const e = prepPath({ p: [...head, ...r.p, ...tail].map((q) => [q[0], q[1], q[2]]) });
  const d0 = e.cum[head.length]; // (this road's start along the joined path)
  const n = Math.floor((own.L + 2 * EXT) / STEP) + 1;
  // per sample: the lane's point, the four wheels' surfaces (front left, front right, rear left, rear right)
  let X = new Float64Array(n), Z = new Float64Array(n);
  const Y = new Float64Array(n), W = Array.from({ length: 4 }, () => new Float64Array(n).fill(NaN));
  for (let k = 0; k < n; k++) {
    at(e, d0 - EXT + k * STEP, lane, P);
    X[k] = P.x; Z[k] = P.y; Y[k] = P.z;
  }
  // the line a car drives: the lane's polyline averaged over SMOOTH m, twice (its corners, and the mitred offset
  // swinging round a kink, are no line a wheel follows: on the raw polyline the heading flipped back and forth)
  for (let pass = 0; pass < 2; pass++) [X, Z] = [X, Z].map((a) => mean(a, SMOOTH / STEP));
  const prev = [null, null, null, null];
  for (let k = 0; k < n; k++) {
    const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
    let hx = X[k1] - X[k0], hz = Z[k1] - Z[k0];
    const l = Math.hypot(hx, hz) || 1;
    hx /= l; hz /= l;
    for (let w = 0; w < 4; w++) {
      const fw = w < 2 ? WB : -WB, sd = w % 2 ? TR : -TR;
      const wx = X[k] + hx * fw - hz * sd, wz = Z[k] + hz * fw + hx * sd;
      const lim = (prev[w] ?? Y[k]) + 1;
      const s = await surface(wx, wz, lim);
      if (s !== null && Math.abs(s - Y[k]) < 4) { W[w][k] = s; prev[w] = s; }
    }
  }
  km += own.L / 1000;
  const H = new Float64Array(n);
  for (let k = 0; k < n; k++) H[k] = (W[0][k] + W[1][k] + W[2][k] + W[3][k]) / 4;
  if (TRACE) {
    for (let k = 0; k < n; k++) {
      if (Math.hypot(X[k] - TRACE[0], Z[k] - TRACE[1]) >= 6) continue;
      console.log(`road ${i} d ${(-EXT + k * STEP).toFixed(1)} at ${X[k].toFixed(1)}, ${Z[k].toFixed(1)}: body ${H[k].toFixed(2)}, wheels ${W.map((w) => w[k].toFixed(2)).join(' ')}`);
    }
  }
  const flag = (kind, k, val) => hits[kind].push({ kind, x: X[k], z: Z[k], val, road: i, way: r.w, v });
  const g = 2 / STEP, s5 = 5 / STEP, e1 = 1 / STEP;
  for (let k = s5; k < n - s5; k++) {
    // (this road, and at an end where it goes straight on into another, the junction to 4 m into that one; where it
    // turns, what lies straight on past its end is no road: no window reaches past such an end)
    const d = -EXT + k * STEP;
    if (d < (pre ? -EXT / 2 : 0) || d > own.L + (post ? EXT / 2 : 0)) continue;
    const lo = pre ? -EXT : 0, hi = post ? own.L + EXT : own.L, within = (m) => d - m >= lo && d + m <= hi;
    const a = v * v * (H[k + g] - 2 * H[k] + H[k - g]) / 4;
    if (within(2 + WB) && Number.isFinite(a)) acc.push(Math.abs(a));
    if (within(2 + WB) && Math.abs(a) > BUMP) flag('bump', k, +a.toFixed(1));
    let ed = 0;
    for (const w of W) ed = Math.max(ed, Math.abs(w[k + e1] - 2 * w[k] + w[k - e1]));
    if (within(1 + WB) && ed >= EDGE) flag('edge', k, +ed.toFixed(2));
    const gr = (H[k + s5] - H[k - s5]) / 10;
    if (within(5 + WB) && Math.abs(gr) > STEEP) flag('steep', k, +gr.toFixed(3));
    if (d >= 5 && d <= own.L - 5) {
      // curvature: the heading's turn over 10 m along the lane
      const h1 = Math.atan2(Z[k] - Z[k - s5], X[k] - X[k - s5]), h2 = Math.atan2(Z[k + s5] - Z[k], X[k + s5] - X[k]);
      let dh = h2 - h1;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const lat = v * v * Math.abs(dh) / 5;
      if (lat > TIGHT) flag('tight', k, +lat.toFixed(1));
    }
  }
}

// spots: a kind's samples within 15 m of the spot's worst
const spots = {};
for (const kind of KINDS) {
  const list = hits[kind].sort((a, b) => Math.abs(b.val) - Math.abs(a.val)), out = [];
  for (const h of list) {
    const s = out.find((o) => Math.hypot(o.x - h.x, o.z - h.z) < 15);
    if (s) s.n++; else out.push({ ...h, x: +h.x.toFixed(0), z: +h.z.toFixed(0), n: 1 });
  }
  spots[kind] = out;
}
console.log(`main roads: ${km.toFixed(1)} km of lane driven at their speed (0.5 m steps), ${DATA}`);
acc.sort((a, b) => a - b);
const pct = (p) => acc[Math.min(acc.length - 1, Math.floor(p * acc.length))]?.toFixed(2);
console.log(`body's vertical acceleration (m/s^2): p50 ${pct(0.5)}, p99 ${pct(0.99)}, p99.9 ${pct(0.999)}; over 2: ${acc.filter((a) => a > 2).length * STEP} m`);
const what = { bump: `body over ${BUMP} m/s^2 up or down`, edge: `a wheel's track bent ${EDGE} m or more`, steep: `grade over ${STEEP * 100} %`, tight: `over ${TIGHT} m/s^2 sideways` };
for (const kind of KINDS) {
  const s = spots[kind];
  console.log(`${kind}: ${s.length} spots, ${(hits[kind].length * STEP).toFixed(0)} m (${what[kind]})`);
  for (const p of s.slice(0, TOP)) console.log(`  ${String(p.val).padStart(6)} at ${p.x}, ${p.z}  road ${p.road} way ${p.way} ${Math.round(p.v * 3.6)} km/h, ${p.n * STEP} m`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(spots));
if (CHECK) {
  let ok = true;
  for (const kind of KINDS) {
    const n = spots[kind].length, pass = n <= BUDGET[kind];
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} road-drive ${kind}: ${n} spots (budget ${BUDGET[kind]})`);
  }
  process.exit(ok ? 0 : 1);
}
