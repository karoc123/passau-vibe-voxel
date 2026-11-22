// The gap between the surface the car drives on (src/physics/rapier/terrain.ts: the wheels' colliders) and the surface
// drawn (core/surface.ts: the caps as the mesher draws them; terrain.ts groundAt), on the real city (public/data on
// disk). The gate for one surface shared by the mesher and the car: run it before, keep the JSON, run it after with
// --check (docs/plans/surface-gap-baseline.json).
// - scan: over the capped columns of a few fixed areas (Altstadt by the Dom: flat; the hillside west of the
//   Schanzlbrücke's south end: ramps; the Schanzlbrücke: deck; Spitzberg: slopes), three points a column, a ray with the
//   wheels' collision groups against the drawn surface there, split by flat / ramp / deck (ramp: the column has a cap;
//   deck: its surface over a bridge, not the ground).
// - drive: the car (scenarios.ts Sim, pure-pursuit follow; slower in a bend than LAT allows) along a few fixed roads
//   (traffic.json, by OSM way and ends) at 30 / 50 / 70 km/h, and parked (handbrake, 3 s) at 30 %
//   and 60 % along them (0 km/h): each touching wheel's contact point against the drawn surface under it, and the drawn wheel's bottom (the ground
//   point life-phys.ts draws the car on: car.ride under the body's origin along its up, at the wheel's x, z) against
//   the drawn surface there; how it rode (scenarios.ts feel: pitchJit rad/s, heave cm, liftPct). The car starts a few
//   metres in where its box is clear of the voxels (scenarios.ts safeStart); a road whose centreline runs within 1.3 m
//   of a wall for 3 m or more is skipped (altstadt_1904: the follower scrapes the house fronts; fewer: walls=N in the
//   table). At most 300 m of each road.
// Gaps in cm (+: over the drawn surface, floating; -: under it, sunk): n, mean, |d| (mean of the absolute), p05, p95,
// and the shares (%) more than 5 cm under (lo5) and over (hi5). Samples more than 1.2 m (scan) / 0.9 m (drive) off
// are something else (a wall, a kerb, a deck over a road) and not counted.
// usage (in web/): node tools/surface-gap.mjs [out.json] [--only scan|drive] [-v] [--check baseline.json [--tol F]] [--set k=v,...]
//   out.json: all numbers, to diff or check against later; -v: the drive's gaps split by flat / ramp / deck too
//   --check: exit code 1 if a gap or the ride got worse than the baseline's by more than the tolerances (TOL below,
//   times F, default 1), a run the baseline had is missing or no longer gets to its road's end; --set: the ride's
//   numbers (car.ts RIDE) changed for the run
// Other data (a fixture's build: VOXEL_DATA, tools/data-dir.mjs): the areas moved to its map by the project grid (as
// the main map's, MAIN_ORIGIN) and clipped to it, the roads found by their OSM way (the longest road of it), those
// off the map skipped.
// ~1 min, one core; no rendering.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { root, load, readMeta, realMap, realTile, roadPath, schanzlPath, trafficRoads, hasData } from './real-city.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const outPath = args.find((a, i) => !a.startsWith('-') && !['--only', '--check', '--tol', '--set'].includes(args[i - 1]));
const only = opt('--only'), checkPath = opt('--check'), tolF = +(opt('--tol') ?? 1), verbose = args.includes('-v');
if (!hasData()) { console.error('no public/data (meta.json, traffic.json)'); process.exit(2); }

const sc = await load('physics/rapier/scenarios.ts');
// --set key=value,...: the ride's numbers (car.ts RIDE) changed for this run (as rapier-car.mjs --set)
for (const kv of opt('--set')?.split(',') ?? []) {
  const [k, v] = kv.split('=');
  if (!(k in sc.RIDE)) throw new Error(`--set: no ${k} in RIDE (${Object.keys(sc.RIDE)})`);
  sc.RIDE[k] = +v;
}
const T = await load('physics/rapier/terrain.ts');
const R = (await import('@dimforge/rapier3d-compat')).default;
await R.init();
const meta = readMeta(), N = meta.tiles.N;

// the areas scanned: [x0, z0, x1, z1] world metres
const AREAS = {
  altstadt: [8064, 2688, 8192, 2816], // by the Dom: flat paved lanes
  ramps: [7168, 2432, 7296, 2560], // west of the Schanzlbrücke's south end: the most ramped paved columns near the centre
  schanzl: [7330, 2500, 7420, 2760], // the Schanzlbrücke's deck and its approaches
  spitzberg: [6860, 3150, 7060, 3380], // Spitzbergstraße and around: 5-10 % slopes
};
// the roads driven: their OSM way and their ends (x, z: from, to), the traffic.json road of that way whose first and
// last points are nearest them (within 20 m each: its index shifts when traffic.json is regenerated), or the
// Schanzlbrücke. The names keep the road's index when the baseline was recorded (data bf9671e3).
const ROADS = [
  { name: 'altstadt_60', w: 7623837, from: [8101, 2880], to: [8176, 3078] }, // flat, 212 m
  { name: 'altstadt_1904', w: 136323330, from: [8151, 2732], to: [8218, 2753] }, // flat, along house fronts: skipped (walls)
  { name: 'donaukai_1630', w: 108322891, from: [8345, 2640], to: [8034, 2601] }, // flat by the Danube
  { name: 'ramps_1948', w: 137551261, from: [7143, 2318], to: [7250, 2324] }, // 5 % up (its first 300 m)
  { name: 'ramps_1949', w: 137551261, from: [7250, 2324], to: [7143, 2318] }, // 5 % down
  { name: 'ramps_1681', w: 121880279, from: [7109, 2545], to: [7355, 2537] }, // up and down 16 m over 250 m
  { name: 'schanzl', schanzl: true }, // over the bridge's deck, south to north
  { name: 'spitzberg_2214', w: 264781335, from: [7089, 3185], to: [6772, 3293] }, // 5.7 % up, 349 m
  { name: 'spitzberg_44', w: 7609622, from: [6928, 3285], to: [6936, 3400] }, // 9.5 % up
  { name: 'spitzberg_445', w: 23653874, from: [6936, 3400], to: [7052, 3314] }, // 7.2 % down
];
const SPEEDS = [30, 50, 70], PARK = [0.3, 0.6], MAX_LEN = 300;
// m/s^2: the most the follower takes a bend with (scenarios.ts bendSpeed): slower in a bend it cannot take at the run's
// speed (road 1948's first bend, ~20 m radius, at 70 km/h: off the road into the yards beside it)
const LAT = 7;
// the map the areas' world coordinates are of (its meta.json origin); other data: moved by the project grid
const MAIN_ORIGIN = [-6144, -2048];
const [shx, shz] = [MAIN_ORIGIN[0] - (meta.origin ?? [0, 0])[0], MAIN_ORIGIN[1] - (meta.origin ?? [0, 0])[1]];
const moved = shx || shz;
for (const [k, [x0, z0, x1, z1]] of Object.entries(AREAS)) {
  const a = [Math.max(0, x0 + shx), Math.max(0, z0 + shz), Math.min(meta.W, x1 + shx), Math.min(meta.D, z1 + shz)];
  if (a[2] - a[0] < 16 || a[3] - a[1] < 16) delete AREAS[k]; else AREAS[k] = a;
}

// tolerances for --check (cm, percentage points, rad/s), scaled by --tol
const TOL = { abs: 0.5, p05: 1, p95: 1, lo5: 2, hi5: 2, pitchJit: 0.02, heave: 0.3, liftPct: 2 };

const r1 = (x) => Math.round(x * 10) / 10;
function stats(v) {
  if (!v.length) return { n: 0 };
  v.sort((a, b) => a - b);
  const q = (p) => r1(100 * v[Math.floor(p * (v.length - 1))]);
  let s = 0, a = 0, lo = 0, hi = 0;
  for (const x of v) { s += x; a += Math.abs(x); if (x < -0.05) lo++; if (x > 0.05) hi++; }
  return { n: v.length, mean: r1(100 * s / v.length), abs: r1(100 * a / v.length), p05: q(0.05), p95: q(0.95), lo5: r1(100 * lo / v.length), hi5: r1(100 * hi / v.length) };
}
const bins = () => ({ all: [], flat: [], ramp: [], deck: [] });
const binStats = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, stats(v)]));
// a column's kind as drawn: deck (its surface a bridge's, over the ground), ramp, flat
const kindOf = (tile, c) => (tile.top[c] !== tile.ground[c] ? 'deck' : tile.caps && (tile.caps.z[2 * c] || tile.caps.z[2 * c + 1]) ? 'ramp' : 'flat');

// ---- scan
async function scan(name, [x0, z0, x1, z1]) {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  const terr = new T.RapierTerrain(R, world, meta, { x: 0, z: 0 }, { budgetMs: 1e9, load: () => Promise.reject(null) });
  const tiles = new Map();
  for (let tz = Math.floor((z0 - 40) / N); tz <= Math.floor((z1 + 40) / N); tz++) for (let tx = Math.floor((x0 - 40) / N); tx <= Math.floor((x1 + 40) / N); tx++) {
    const t = await realTile(tx, tz);
    if (t) { terr.setTile(tx, tz, t); tiles.set(`${tx}_${tz}`, t); }
  }
  const pts = [];
  for (let z = z0; z < z1; z += 16) for (let x = x0; x < x1; x += 16) pts.push({ x: x + 8, z: z + 8 });
  for (let i = 0; i < 3; i++) terr.update(pts, i * 10);
  world.step();
  const b = { flat: [], ramp: [], deck: [] };
  let off = 0, miss = 0;
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    const t = tiles.get(`${Math.floor(x / N)}_${Math.floor(z / N)}`);
    if (!t || !t.caps) continue;
    const c = (x - Math.floor(x / N) * N) + 1 + t.S * ((z - Math.floor(z / N) * N) + 1);
    if (!(t.caps.z[2 * c] || t.caps.z[2 * c + 1])) continue; // (a cap there: core/surface.ts)
    for (const [fx, fz] of [[0.25, 0.25], [0.75, 0.6], [0.5, 0.9]]) {
      const X = x + fx, Z = z + fz, top = t.top[c];
      const drawn = terr.groundAt(X, Z, top + 0.01);
      const hit = world.castRay(new R.Ray({ x: X, y: top + 1.5, z: Z }, { x: 0, y: -1, z: 0 }), 4, true, undefined, T.WHEEL_GROUPS);
      if (drawn === null || !hit) { miss++; continue; }
      const d = top + 1.5 - hit.timeOfImpact - drawn;
      if (Math.abs(d) > 1.2) { off++; continue; }
      b[kindOf(t, c)].push(d);
    }
  }
  world.free();
  return { ...binStats(b), off, miss };
}

// ---- drive
const traffic = await trafficRoads();
async function roadOf(r) {
  if (r.schanzl) return { path: await schanzlPath(), y: 20 };
  let i = -1;
  if (moved) { // (another map: the longest road of the way)
    traffic.forEach((q, k) => { if (q.w === r.w && (i < 0 || q.p.length > traffic[i].p.length)) i = k; });
    if (i < 0) return null;
  } else { // the road of the way from r.from to r.to
    const off = (q) => Math.max(Math.hypot(q.p[0][0] - r.from[0], q.p[0][1] - r.from[1]), Math.hypot(q.p.at(-1)[0] - r.to[0], q.p.at(-1)[1] - r.to[1]));
    traffic.forEach((q, k) => { if (q.w === r.w && (i < 0 || off(q) < off(traffic[i]))) i = k; });
    if (i < 0 || off(traffic[i]) > 20) throw new Error(`${r.name}: no traffic.json road of way ${r.w} from (${r.from}) to (${r.to}) (regenerated? update ROADS)`);
  }
  const path = await roadPath(i);
  return { path, y: path.map((q) => q[2]) };
}

// the car along `path` from its point i0 (kmh 0: parked on the handbrake for 3 s)
function drive(map, path, st, kmh) {
  const col = sc.mapColumns(map);
  let pts = path.slice(st.i), L = 0, cut = pts.length;
  for (let k = 1; k < pts.length; k++) { L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); if (L > MAX_LEN && cut === pts.length) cut = k + 1; }
  pts = pts.slice(0, cut);
  L = Math.min(L, MAX_LEN);
  // (a driver's speed in the bends, from the start: LAT)
  const s = new sc.Sim(map, st.at, st.heading, kmh ? sc.bendSpeed(pts, LAT)(0, kmh / 3.6) : 0);
  const terr = s.terrain, c = s.car.controller, wh = s.car.build.wheels, end = pts[pts.length - 1];
  const contact = bins(), wheel = bins();
  let off = 0;
  const f = kmh ? sc.follow(pts, kmh, LAT) : () => ({ gas: 0, brake: 0, steer: 0, handbrake: true });
  const steps = Math.round((kmh ? L / (kmh / 3.6) * 1.6 + 2 : 3) * 60), log = [];
  const near = (p) => Math.hypot(p.x - end[0], p.z - end[1]);
  for (let i = 0; i < steps; i++) {
    s.step(f(s));
    if (s.car.status !== 'ok') break;
    const p = s.car.body.translation();
    if (p.x < 0 || p.z < 0 || p.x > meta.W || p.z > meta.D) break;
    if (kmh && near(p) < 6) break;
    if (s.t < 0.5 || (kmh && near(p) < 8)) continue; // (settling; braking at the end)
    log.push(s.log[s.log.length - 1]);
    const q = s.car.body.rotation();
    const rot = (v) => { // v rotated by q
      const { x, y, z, w } = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
      return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
    };
    const add = (b, x, y, z, lim) => {
      const d = terr.groundAt(x, z, y + 0.6), cc = col(x, z);
      if (d === null || !cc || Math.abs(y - d) > lim) { off++; return; }
      b.all.push(y - d);
      b[kindOf(cc.tile, cc.c)].push(y - d);
    };
    for (let k = 0; k < wh.length; k++) {
      if (c.wheelIsInContact(k)) { const cp = c.wheelContactPoint(k); add(contact, cp.x, cp.y, cp.z, 0.9); }
      const r = rot([wh[k].x, -s.car.ride, wh[k].z]);
      add(wheel, p.x + r[0], p.y + r[1], p.z + r[2], 0.9);
    }
  }
  const last = s.log[s.log.length - 1], w = sc.feel(log);
  const impacts = s.events.filter((e) => e.kind === 'impact' && e.speed > 2);
  const out = {
    contact: binStats(contact), wheel: binStats(wheel), off,
    ride: { pitchJit: w.pitchJit, rollJit: w.rollJit, heave: w.heave, liftPct: w.liftPct, vyErr: w.vyErr },
    length: Math.round(L), impacts: impacts.length, crash: impacts.some((e) => e.crash), status: s.car.status,
  };
  // (how far from the road's end it stopped: driven only)
  if (kmh) { out.left = Math.round(Math.hypot(last.x - end[0], last.z - end[1])); out.reached = out.left < 10; }
  s.dispose();
  return out;
}

const result = { tool: 'surface-gap', version: 1, commit: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { return null; } })(), scan: {}, drive: {}, skipped: {} };
const t0 = Date.now();
if (only !== 'drive') for (const [name, a] of Object.entries(AREAS)) result.scan[name] = await scan(name, a);
if (only !== 'scan') {
  for (const r of ROADS) {
    const rd = await roadOf(r);
    if (!rd || rd.path.some(([x, z]) => x < 0 || z < 0 || x >= meta.W || z >= meta.D)) { result.skipped[r.name] = 'not on this map'; continue; }
    const { path, y } = rd;
    const map = await realMap(path.slice(0, MAX_LEN + 20), 48);
    const st = sc.safeStart(map, path, y);
    if (!st) { result.skipped[r.name] = 'no clear start'; continue; }
    // (a pole or a corner by the way is not a wall to scrape along: 3 m of it is)
    if (st.walls >= 3) { result.skipped[r.name] = `${st.walls} points within 1.3 m of a wall`; continue; }
    for (const fr of PARK) {
      const i0 = Math.floor(path.length * fr), sub = path.slice(i0);
      const p = sc.safeStart(map, sub, typeof y === 'number' ? y : y.slice(i0), { ahead: 0 });
      if (p) result.drive[`${r.name}@0/${fr}`] = drive(map, sub, p, 0);
    }
    for (const kmh of SPEEDS) result.drive[`${r.name}@${kmh}`] = { ...drive(map, path, st, kmh), walls: st.walls };
  }
}

// ---- the table
const f1 = (x, w = 6) => (x === undefined ? '-' : String(x)).padStart(w);
const gapCols = (o) => (o && o.n ? `${f1(o.n, 6)}${f1(o.abs)}${f1(o.p05)}${f1(o.p95)}${f1(o.lo5)}${f1(o.hi5)}` : `${f1(0, 6)}${' '.repeat(30)}`);
const GAPH = `${'n'.padStart(6)}${'|d|'.padStart(6)}${'p05'.padStart(6)}${'p95'.padStart(6)}${'lo5%'.padStart(6)}${'hi5%'.padStart(6)}`;
if (Object.keys(result.scan).length) {
  console.log('scan: wheel ray - drawn surface over paved columns (cm)');
  console.log(`${'area'.padEnd(11)}${'kind'.padEnd(6)}${GAPH}`);
  for (const [a, o] of Object.entries(result.scan)) for (const k of ['flat', 'ramp', 'deck']) if (o[k].n) console.log(`${a.padEnd(11)}${k.padEnd(6)}${gapCols(o[k])}`);
}
if (Object.keys(result.drive).length) {
  console.log('\ndrive: wheel contact - drawn surface | drawn wheel bottom - drawn surface (cm) | ride');
  console.log(`${'run'.padEnd(22)}${GAPH} |${GAPH} |${'pJit'.padStart(6)}${'heave'.padStart(6)}${'lift%'.padStart(6)}${'left'.padStart(5)}`);
  for (const [k, o] of Object.entries(result.drive)) {
    const kinds = verbose ? ['all', 'flat', 'ramp', 'deck'] : ['all'];
    for (const kind of kinds) {
      if (kind !== 'all' && !o.contact[kind].n && !o.wheel[kind].n) continue;
      const head = kind === 'all' ? k : `  ${kind}`;
      const ride = kind === 'all' ? `${f1(o.ride.pitchJit)}${f1(o.ride.heave)}${f1(o.ride.liftPct)}${f1(o.left, 5)}${o.reached === false ? ' NOT REACHED' : ''}${o.impacts ? ` impacts=${o.impacts}${o.crash ? '!' : ''}` : ''}${o.status !== 'ok' ? ' ' + o.status : ''}${o.walls ? ` walls=${o.walls}` : ''}` : '';
      console.log(`${head.padEnd(22)}${gapCols(o.contact[kind])} |${gapCols(o.wheel[kind])} |${ride}`);
    }
  }
}
for (const [k, v] of Object.entries(result.skipped)) console.log(`skipped ${k}: ${v}`);
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
if (outPath) { fs.writeFileSync(outPath, JSON.stringify(result, null, 1)); console.log(`wrote ${outPath}`); }

// ---- --check
if (checkPath) {
  const base = JSON.parse(fs.readFileSync(checkPath, 'utf8')), bad = [];
  const gap = (where, b, c) => {
    if (!b || b.n < 20) return;
    if (!c || !c.n) { bad.push(`${where}: no samples (baseline ${b.n})`); return; }
    const t = (k) => TOL[k] * tolF;
    if (c.abs > b.abs + t('abs')) bad.push(`${where}: |d| ${b.abs} -> ${c.abs} cm`);
    if (c.p05 < b.p05 - t('p05')) bad.push(`${where}: p05 ${b.p05} -> ${c.p05} cm`);
    if (c.p95 > b.p95 + t('p95')) bad.push(`${where}: p95 ${b.p95} -> ${c.p95} cm`);
    if (c.lo5 > b.lo5 + t('lo5')) bad.push(`${where}: lo5 ${b.lo5} -> ${c.lo5} %`);
    if (c.hi5 > b.hi5 + t('hi5')) bad.push(`${where}: hi5 ${b.hi5} -> ${c.hi5} %`);
  };
  for (const [a, o] of Object.entries(base.scan ?? {})) {
    if (only === 'drive') break;
    for (const k of ['flat', 'ramp', 'deck']) gap(`scan ${a} ${k}`, o[k], result.scan[a]?.[k]);
  }
  for (const [k, o] of Object.entries(base.drive ?? {})) {
    if (only === 'scan') break;
    const c = result.drive[k];
    if (!c) { bad.push(`drive ${k}: not run (${result.skipped[k.split('@')[0]] ?? 'missing'})`); continue; }
    for (const kind of ['all', 'flat', 'ramp', 'deck']) { gap(`drive ${k} contact ${kind}`, o.contact[kind], c.contact[kind]); gap(`drive ${k} wheel ${kind}`, o.wheel[kind], c.wheel[kind]); }
    for (const m of ['pitchJit', 'heave', 'liftPct']) if (c.ride[m] > o.ride[m] + TOL[m] * tolF) bad.push(`drive ${k}: ${m} ${o.ride[m]} -> ${c.ride[m]}`);
    if (o.reached && !c.reached) bad.push(`drive ${k}: no longer reaches the end (left ${c.left} m)`);
    if (o.status === 'ok' && c.status !== 'ok') bad.push(`drive ${k}: status ${c.status}`);
    if (!o.crash && c.crash) bad.push(`drive ${k}: crashes`);
  }
  console.log(`\ncheck against ${checkPath} (baseline ${base.commit ?? '?'}, tolerances x${tolF}): ${bad.length ? `${bad.length} worse` : 'none worse'}`);
  for (const b of bad) console.log(`  WORSE ${b}`);
  process.exit(bad.length ? 1 : 0);
}
process.exit(0);
