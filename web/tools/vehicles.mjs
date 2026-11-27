// The vehicle catalog (src/sim/vehicles.ts) driven headless on synthetic terrain (checks/scenarios.ts Sim),
// each type as the player drives it (car.ts RapierCar with the type's CarBuild):
//   top     -- full throttle from rest on a 1 km flat street: its top speed within the type's range (TOP), 0-50 km/h
//   curve   -- half lock at 50 km/h (a bus 30) for 4 s: turned, upright
//   fast    -- a third of the lock at 80 % of its top speed (at most 120 km/h) for 4 s: upright, still on the road
//   steep   -- a paved street rising 1 m every 5 m (20 %, voxel stairs under caps) for 40 m from rest: up it, upright
// the motorbike also:
//   bike_rest   -- 5 s standing, no input: upright
//   bike_lean   -- the fast curve both ways at half lock: upright (the body), drawn leaning into the turn (car.ts lean)
//                  by 0.3 rad or more, the right way (turning right: left side up)
//   bike_keys   -- a key (steer 1) held from straight at 60 km/h: the bars turned in over a fraction of a second (0.1 s
//                  in, under half the angle held), the turn held at no more than the type's latG sideways with a
//                  steady yaw rate (no slide, no wobble), straight again within 0.6 s of letting go; and a 0.15 s
//                  tap: short of full lean
//   bike_turn   -- full lock held at 10, 30 and 60 km/h: a bike's circle at walking pace (2.3-3.5 m), at every speed
//                  under 0.8 of the car's (the player turns a bike far tighter than a car, also at speed), the turn
//                  within 0.35 s, upright; 0-50 km/h quicker than the car; from 50 km/h stopped within 10 m, upright
//   bike_curb   -- a 0.3 m kerb across the way (a street's cap stepping up over a metre) at 40 km/h, square and at 30°;
//                  and a 1 m terrace (car.ts' wedge) at 30 km/h: over it, upright
//   bike_wall   -- into a wall at 50 km/h through the drive (physics/rapier/player-car.ts): the rider comes off (no input,
//                  drawn on its side; the note says why: a wall), then back on the road some way before it, upright,
//                  standing
//   bike_scrape -- glancing hits through the drive: a wall at 10° at 50 km/h, a voxel staircase wall at 10° met at
//                  20° at 50 km/h, a parked car's corner (1.2 m off the line) at 30 km/h: met, the rider stays on
// The default car's own scenarios stay tools/rapier-car.mjs's.
// usage (in web/): node tools/vehicles.mjs [-v] [type ...]; one line a check, exit code 1 if one fails
import { load } from './real-city.mjs';
import { imp } from './lib.mjs';

const args = process.argv.slice(2), verbose = args.includes('-v');
const sc = await imp('checks/scenarios.ts');
const ds = await imp('checks/drive-scenarios.ts');
const { VEHICLES } = await load('sim/vehicles.ts');
const { FALL_MS } = await load('sim/contract/snapshot.ts');
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();

// km/h: the top speed each type should reach on the flat
const TOP = { car: [70, 85], coupe: [160, 185], van: [85, 100], camper: [65, 78], pickup: [95, 115], bus: [55, 65], moto: [130, 150] };
const r2 = (x) => Math.round(x * 100) / 100;
const out = [];
const check = (name, pass, detail) => out.push({ name, pass, detail });
const minUp = (L) => r2(Math.min(...L.map((l) => l.up)));

const flat = sc.synthMap(16, () => ({ g: 10, mat: sc.STREET }));
const steep = sc.synthMap(2, (x, z) => {
  const g = 10 + Math.max(0, Math.min(8, Math.floor((z - 30) / 5)));
  return x >= 56 && x < 72 ? { g, mat: sc.STREET } : { g: g + 3 };
}, (_x, z) => sc.stairs(z, 10, 30, 5, 8));
const GAS = { gas: 1, brake: 0, steer: 0, handbrake: false };

const ids = args.filter((a) => !a.startsWith('-'));
for (const [id, t] of Object.entries(VEHICLES)) {
  if (ids.length && !ids.includes(id)) continue;
  const b = t.build;
  // top speed
  let s = new sc.Sim(flat, { x: 20, z: 20 }, 0, 0, b), t50 = null;
  s.run(40, (sim) => { if (t50 === null && sim.car.kmh >= 50) t50 = sim.t; return GAS; });
  const G = s.log.filter((l) => l.wheels >= 2 && l.z < 1000), top = Math.max(...G.map((l) => l.kmh));
  check(`${id} top`, top >= TOP[id][0] && top <= TOP[id][1] && minUp(G) > 0.95, { kmh: r2(top), range: TOP[id].join('-'), t0to50: r2(t50 ?? NaN), minUp: minUp(G) });
  s.dispose();
  // curve
  const k0 = id === 'bus' ? 30 : 50;
  s = new sc.Sim(flat, { x: 256, z: 100 }, 0, k0 / 3.6, b);
  s.run(4, (sim) => ({ ...sc.cruise(k0)(sim), steer: 0.5 }));
  let L = s.log, turn = Math.abs(L[L.length - 1].heading) * 180 / Math.PI;
  check(`${id} curve`, turn > 45 && minUp(L) > 0.9, { kmh: k0, turnedDeg: r2(turn), minUp: minUp(L) });
  s.dispose();
  // fast
  const k1 = Math.min(120, b.top * 3.6 * 0.8);
  s = new sc.Sim(flat, { x: 256, z: 100 }, 0, k1 / 3.6, b);
  let lean = 0;
  s.run(4, (sim) => { lean = Math.max(lean, sim.car.lean); return { ...sc.cruise(k1)(sim), steer: 0.33 }; });
  L = s.log;
  check(`${id} fast`, minUp(L) > 0.9 && L.every((l) => l.wheels >= 2), { kmh: r2(k1), minUp: minUp(L), kmhEnd: r2(L[L.length - 1].kmh), minWheels: Math.min(...L.map((l) => l.wheels)) });
  if (b.bike) {
    s.dispose();
    s = new sc.Sim(flat, { x: 256, z: 100 }, 0, k1 / 3.6, b);
    let leanL = 0;
    s.run(4, (sim) => { leanL = Math.min(leanL, sim.car.lean); return { ...sc.cruise(k1)(sim), steer: -0.5 }; });
    const sL = s.log;
    s.dispose();
    s = new sc.Sim(flat, { x: 256, z: 100 }, 0, k1 / 3.6, b);
    lean = 0;
    s.run(4, (sim) => { lean = Math.max(lean, sim.car.lean); return { ...sc.cruise(k1)(sim), steer: 0.5 }; });
    check('moto bike_lean', lean > 0.3 && leanL < -0.3 && minUp(s.log) > 0.9 && minUp(sL) > 0.9, { right: r2(lean), left: r2(leanL), minUp: Math.min(minUp(sL), minUp(s.log)) });
    s.dispose();
    // a key held at 60 km/h from 0.5 s to 2 s, then let go; and a tap
    s = new sc.Sim(flat, { x: 256, z: 50 }, 0, 60 / 3.6, b);
    s.run(3, (sim) => ({ ...sc.cruise(60)(sim), steer: sim.t >= 0.5 && sim.t < 2 ? 1 : 0 }));
    const at = (t) => s.log.find((l) => l.t >= t - 1e-6), held = s.log.filter((l) => l.t > 1.5 && l.t < 2);
    const angle = Math.abs(at(1.95).steer), in01 = Math.abs(at(0.6).steer) / angle;
    const latG = Math.max(...held.map((l) => Math.abs(l.yr) * Math.hypot(l.vx, l.vz) / 9.81));
    const mean = held.reduce((q, l) => q + l.yr, 0) / held.length, wobble = Math.max(...held.map((l) => Math.abs(l.yr - mean)));
    const after = Math.abs(at(2.6).yr);
    s.dispose();
    s = new sc.Sim(flat, { x: 256, z: 50 }, 0, 60 / 3.6, b);
    let tap = 0;
    s.run(2, (sim) => { tap = Math.max(tap, Math.abs(sim.car.lean)); return { ...sc.cruise(60)(sim), steer: sim.t >= 0.5 && sim.t < 0.65 ? 1 : 0 }; });
    check('moto bike_keys', in01 < 0.45 && latG < b.tune.latG * 1.05 && wobble < 0.03 && after < 0.05 && tap < 0.65 && minUp(s.log) > 0.99,
      { in01: r2(in01), angle: Math.round(angle * 1000) / 1000, latG: r2(latG), wobble: Math.round(wobble * 1000) / 1000, yawAfter: r2(after), tapLean: r2(tap) });
  }
  s.dispose();
  // steep
  const k2 = id === 'bus' ? 25 : 40;
  s = new sc.Sim(steep, { x: 64, z: 15 }, 0, 0, b);
  s.run(14, sc.cruise(k2));
  // (up to the top's flat, 18 m past the climb: further on it runs off the map)
  const top_ = s.log.findIndex((l) => l.z > 88);
  L = s.log.slice(0, top_ < 0 ? s.log.length : top_ + 1);
  const end = L[L.length - 1], climb = L.filter((l) => l.z > 40 && l.z < 70);
  check(`${id} steep`, top_ >= 0 && end.y > 18 && minUp(L) > 0.8, { kmh: k2, reachedTop: top_ >= 0, yTop: r2(end.y), sTop: r2(end.t), minKmhClimbing: r2(Math.min(...climb.map((l) => l.kmh))), minUp: minUp(L) });
  s.dispose();
  if (!b.bike) continue;
  // full lock held at 10, 30, 60 km/h: the circle's radius (speed over yaw rate, its last 2 s), the yaw rate's 90 %
  // reached (s after the key), upright; 0-50 km/h against the car's; stopping from 50 km/h
  const lock = {}, carR = {};
  const circle = (build, k) => {
    const q = new sc.Sim(flat, { x: 512, z: 512 }, 0, k / 3.6, build);
    q.run(6, (sim) => ({ ...sc.cruise(k)(sim), steer: sim.t > 0.5 ? 1 : 0 }));
    const H = q.log.filter((l) => l.t > 4);
    const v = H.reduce((o, l) => o + Math.hypot(l.vx, l.vz), 0) / H.length, w = Math.abs(H.reduce((o, l) => o + l.yr, 0) / H.length);
    const o = { r: v / w, lat: v * w / 9.81, t90: q.log.find((l) => Math.abs(l.yr) >= 0.9 * w).t - 0.5, up: minUp(q.log) };
    q.dispose();
    return o;
  };
  for (const k of [10, 30, 60]) { lock[k] = circle(b, k); carR[k] = circle(VEHICLES.car.build, k).r; }
  const zeroTo50 = (build) => {
    const q = new sc.Sim(flat, { x: 512, z: 100 }, 0, 0, build);
    let t = NaN;
    q.run(10, (sim) => { if (Number.isNaN(t) && sim.car.kmh >= 50) t = sim.t; return GAS; });
    q.dispose();
    return t;
  };
  s = new sc.Sim(flat, { x: 512, z: 100 }, 0, 50 / 3.6, b);
  let stopAt = null;
  s.run(6, (sim) => { if (stopAt === null && sim.car.kmh < 0.5) stopAt = sim.log.at(-1).z; return { gas: 0, brake: 1, steer: 0, handbrake: stopAt !== null }; });
  const stop = (stopAt ?? Infinity) - s.log[0].z, stopUp = minUp(s.log);
  s.dispose();
  const own50 = zeroTo50(b), car50 = zeroTo50(VEHICLES.car.build);
  check('moto bike_turn', lock[10].r > 2.3 && lock[10].r < 3.5 && [10, 30, 60].every((k) => lock[k].r < 0.8 * carR[k]) && Object.values(lock).every((o) => o.t90 < 0.35 && o.up > 0.99)
    && own50 < car50 && stop < 10 && stopUp > 0.99,
  { r10: r2(lock[10].r), r30: r2(lock[30].r), r60: r2(lock[60].r), car: [10, 30, 60].map((k) => r2(carR[k])).join('/'), g60: r2(lock[60].lat), t90: r2(Math.max(...Object.values(lock).map((o) => o.t90))),
    up30: lock[30].up, t0to50: r2(own50), car0to50: r2(car50), stop50m: r2(stop), stopUp });
  // the bike at rest
  s = new sc.Sim(flat, { x: 64, z: 64 }, 0, 0, b);
  s.run(5, { gas: 0, brake: 0, steer: 0, handbrake: false });
  check('moto bike_rest', minUp(s.log) > 0.99, { minUp: minUp(s.log), drift: r2(Math.hypot(s.log.at(-1).x - 64, s.log.at(-1).z - 64)) });
  s.dispose();
  // kerbs: a street whose cap steps up 0.3 m over the metre at z 50 (its voxels level)
  const kerb = sc.synthMap(2, () => ({ g: 10, mat: sc.STREET }), (x, z) => 10 - 0.5 + (z >= 51 ? 0.3 : z <= 50 ? 0 : 0.3 * (z - 50)));
  for (const deg of [0, 30]) {
    const a = deg * Math.PI / 180;
    s = new sc.Sim(kerb, { x: 64 - 25 * Math.tan(a), z: 25 }, a, 40 / 3.6, b);
    s.run(3, sc.cruise(40));
    const e = s.log.at(-1);
    check(`moto bike_curb_${deg}`, e.z > 58 && minUp(s.log) > 0.9 && e.y > 10, { zEnd: r2(e.z), yEnd: r2(e.y), minUp: minUp(s.log), kmhEnd: r2(e.kmh) });
    s.dispose();
  }
  const terrace = sc.synthMap(2, (_x, z) => ({ g: z >= 50 ? 11 : 10 }));
  s = new sc.Sim(terrace, { x: 64, z: 30 }, 0, 30 / 3.6, b);
  s.run(5, sc.cruise(30));
  const e = s.log.at(-1);
  check('moto bike_terrace', e.z > 58 && e.y > 11 && minUp(s.log) > 0.8, { zEnd: r2(e.z), yEnd: r2(e.y), minUp: minUp(s.log), steps: s.events.filter((v) => v.kind === 'step').length });
  s.dispose();
  // into a wall through the drive: the rider comes off, then back on the road
  const d = ds.takeOver((_x, z) => (z >= 60 && z < 63 ? { g: 10, runs: [[10, 16, sc.WALL]] } : { g: 10 }), 64, 20, 50, [], false, 'moto');
  ds.run(d, 4, ds.cruise(50), (x) => !!x.snapshot?.fallMs);
  const fell = !!d.snapshot?.fallMs, note = ds.said(d, 'Crash!'), cause = d.notes.find((n) => n.fall)?.fall.kind, at = d.traffic.t, held = (d.snapshot?.fallMs ?? 0) > FALL_MS - 1;
  ds.run(d, 0.6, ds.cruise(50));
  const side = Math.abs(d.pose(d.car).roll ?? 0);
  ds.run(d, (FALL_MS + 200) / 1000, ds.cruise(50));
  ds.run(d, 1, () => ({ gas: 0, brake: 0, steer: 0, handbrake: true }));
  const p = d.pose(d.car), snapshot = d.snapshot;
  const det = { fell, note, held, sideRoll: r2(side), backAfterS: r2(d.traffic.t - at), zBack: r2(p.z), onWheels: snapshot.onWheels, kmh: r2(d.kmh) };
  d.park();
  d.physics.dispose();
  check('moto bike_wall', fell && note && held && side > 1.2 && !d.snapshot && p.z < 50 && Math.abs(p.y - 10) < 0.5 && cause === 'wall', { ...det, cause });
  // glancing: a wall at 10° at 50 km/h, a voxel staircase wall at 10° met at 10° more, a parked car's corner at 30 km/h
  const wall = (x0) => (x) => (x >= x0 && x < x0 + 3 ? { g: 10, runs: [[10, 16, sc.WALL]] } : { g: 10 });
  const T10 = Math.tan(10 * Math.PI / 180);
  const stairs = (x, z) => { const w = 66 + Math.floor((z - 20) * T10); return x >= w && x < w + 3 ? { g: 10, runs: [[10, 16, sc.WALL]] } : { g: 10 }; };
  const glance = {};
  for (const [name, col, x, kmh, deg, others] of [['wall', wall(67), 64, 50, 10, []], ['stairs', stairs, 64.5, 50, 20, []],
    ['corner', () => ({ g: 10 }), 64, 30, 0, [Object.assign(ds.carAt(65.2, 10, 45), { len: 4.4 })]]]) {
    const g = ds.takeOver(col, x, 20, kmh, others, false, 'moto', undefined, deg * Math.PI / 180);
    ds.run(g, 4, ds.cruise(kmh));
    // (met: a wall turns it along itself; the car knocks)
    const turned = Math.abs(g.snapshot.pose.h * 180 / Math.PI - deg) > 5, touched = name === 'corner' ? ds.said(g, 'Crash!') : turned;
    glance[name] = { off: !!g.notes.find((n) => n.fall) || !!g.snapshot.fallMs, touched, kmh: r2(g.kmh) };
    g.physics.dispose();
  }
  check('moto bike_scrape', Object.values(glance).every((o) => !o.off && o.touched && o.kmh > 0.7 * 30),
    Object.fromEntries(Object.entries(glance).map(([k, o]) => [k, `${o.off ? 'off' : 'on'}/${o.touched ? 'met' : 'missed'}/${o.kmh}kmh`])));
}

for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(18)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (verbose) console.log(JSON.stringify(out, null, 1));
console.log(`${out.filter((o) => o.pass).length}/${out.length} passed`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
