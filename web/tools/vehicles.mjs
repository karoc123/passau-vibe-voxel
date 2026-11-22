// The vehicle catalog (src/sim/vehicles.ts) driven headless on synthetic terrain (physics/rapier/scenarios.ts Sim),
// each type as the player drives it (car.ts RapierCar with the type's CarBuild):
//   top     -- full throttle from rest on a 1 km flat street: its top speed within the type's range (TOP), 0-50 km/h
//   curve   -- half lock at 50 km/h (a bus 30) for 4 s: turned, upright
//   fast    -- a third of the lock at 80 % of its top speed (at most 120 km/h) for 4 s: upright, still on the road
//   steep   -- a paved street rising 1 m every 5 m (20 %, voxel stairs under caps) for 40 m from rest: up it, upright
// the motorbike also:
//   bike_rest   -- 5 s standing, no input: upright
//   bike_lean   -- the fast curve both ways: upright (the body), drawn leaning into the turn (car.ts lean) by 0.3 rad
//                  or more, the right way (turning right: left side up)
//   bike_curb   -- a 0.3 m kerb across the way (a street's cap stepping up over a metre) at 40 km/h, square and at 30°;
//                  and a 1 m terrace (car.ts' wedge) at 30 km/h: over it, upright
//   bike_wall   -- into a wall at 50 km/h through the drive (nav/drive-session.ts): the rider comes off (no input,
//                  drawn on its side), then back on the road some way before it, upright, standing
// The default car's own scenarios stay tools/rapier-car.mjs's.
// usage (in web/): node tools/vehicles.mjs [-v] [type ...]; one line a check, exit code 1 if one fails
import { load } from './real-city.mjs';

const args = process.argv.slice(2), verbose = args.includes('-v');
const sc = await load('physics/rapier/scenarios.ts');
const ds = await load('physics/rapier/drive-scenarios.ts');
const { VEHICLES } = await load('sim/vehicles.ts');
const { FALL_MS } = await load('nav/drive-session.ts');
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
    s.run(4, (sim) => { leanL = Math.min(leanL, sim.car.lean); return { ...sc.cruise(k1)(sim), steer: -0.33 }; });
    check('moto bike_lean', lean > 0.3 && leanL < -0.3 && minUp(s.log) > 0.9 && minUp(L) > 0.9, { right: r2(lean), left: r2(leanL), minUp: Math.min(minUp(L), minUp(s.log)) });
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
  const d = ds.takeOver((_x, z) => (z >= 60 && z < 63 ? { g: 10, runs: [[10, 16, sc.WALL]] } : { g: 10 }), 64, 20, 50, [], [], b);
  ds.run(d, 4, ds.cruise(50), (x) => x.session.fallUntil > 0);
  const fell = d.session.fallUntil > 0, note = ds.said(d, 'Crash!'), at = d.now, held = d.session.held(at + 10);
  ds.run(d, 0.6, ds.cruise(50));
  const side = Math.abs(d.car.roll ?? 0);
  ds.run(d, (FALL_MS + 200) / 1000, ds.cruise(50));
  ds.run(d, 1, () => ({ gas: 0, brake: 0, steer: 0, handbrake: true }));
  const p = d.car.rp, rap = d.session.rap;
  const det = { fell, note, held, sideRoll: r2(side), backAfterS: r2((d.now - at) / 1000), zBack: r2(p.z), onWheels: rap.onWheels, kmh: r2(d.session.kmh) };
  d.session.park();
  check('moto bike_wall', fell && note && held && side > 1.2 && rap.car === null && p.z < 50 && Math.abs(p.y - 10) < 0.5, det);
}

for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(18)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (verbose) console.log(JSON.stringify(out, null, 1));
console.log(`${out.filter((o) => o.pass).length}/${out.length} passed`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
