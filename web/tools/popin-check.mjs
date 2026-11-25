// The street life's pop-in gate (src/view/life.ts), headless on the real traffic data (public/data/traffic.json): a
// viewer drives along the road network (and stands still a while), the world sim (src/sim/world-sim.ts, started by the
// host: src/host/node.ts) is ticked
// through its client (src/client/sim-client.ts, in this thread) and the life drawn every frame as main.ts does (focus: the viewer; the scene only StreetLife's meshes', never rendered),
// and every car, person and rider drawn is followed from frame to frame. Flagged:
//   appear  -- an agent drawn now that was not in the last frame, within R m of the viewer
//   vanish  -- an agent drawn in the last frame, within R m of the viewer, gone now
//   jump    -- an agent drawn in both frames, within R m, moved more than JUMP m in one frame
// (R: CAR_R for cars, PED_R for people and riders.) Agents in front of the viewer (within 60 degrees of its heading)
// are counted apart. The first frame (the street filled for the first time) is not checked. Math.random is seeded:
// the run is the same every time.
// The train and boat sim poses (--transit, on traffic.json's tracks and boats.json) the same way,
// for viewers standing at each track's ends and stations, the fairway's ends, the berths and the pier: the trains
// over TRAIN_S s at 30 ticks/s (one run per viewer: their coming and going depends on where the viewer is), the boats over
// a spring and a summer day at 2 fps (theirs does not: one run a day, all the viewers). R: TRAIN_R, SHIP_R; a jump is more than JUMP m
// beyond what they may move in the frame.
// usage (in web/): node tools/popin-check.mjs [-v] [--street | --transit] [--mirror] [--seconds S] [--seed N] [--jump M]; both
// parts unless one is named; prints one PASS line, or the counts and exit code 1
import fs from 'node:fs';
import * as THREE from 'three';
import { DATA, load } from './real-city.mjs';

const args = process.argv.slice(2), verbose = args.includes('-v');
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const SECONDS = arg('--seconds', 180), SEED = arg('--seed', 7);
const MIRROR = args.includes('--mirror');
const STREET = !args.includes('--transit') || args.includes('--street'), TRANSIT = !args.includes('--street') || args.includes('--transit');
const TRAIN_R = 400, SHIP_R = 800, TRAIN_S = 7200, DAYS = [100, 200];
const CAR_R = 200, PED_R = 100, JUMP = arg('--jump', 1.5), FPS = 60, KMH = 45, STAND = 30;

const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = mulberry(SEED >>> 0);
const rnd = mulberry((SEED * 7919 + 1) >>> 0);

const { StreetLife } = await load('view/life.ts'), { nodeHost } = await load('host/node.ts'), { LocalSimClient, MirrorSimClient, ThreadLink, CloneLink } = await load('client/sim-client.ts');
const { unpackTraffic } = await load('sim/traffic-pack.ts'), { hello } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const loaded = TRANSIT ? { trains: await load('sim/train-traffic.ts'), boats: await load('sim/boat-traffic.ts'), world: await load('sim/traffic.ts') } : null;
const { prepPath, at, pt } = await load('sim/path.ts');
const td = unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'))), pristine = MIRROR ? structuredClone(td) : null;
const meta = JSON.parse(fs.readFileSync(`${DATA}meta.json`, 'utf8'));
const label = (kind, x, y) => meta.labels.find((l) => l.kind === kind) ?? { x, y };
// where the viewer starts, and the hours the run goes through (the density falling: agents to remove; rising: to add)
const RUNS = [
  { name: 'Altstadt', at: label('cathedral', 8085, 2771), h0: 17, h1: 20 },
  { name: 'Hauptbahnhof', at: label('station', 7019, 2871), h0: 6, h1: 9 },
  { name: 'Innstadt', at: label('district', 8196, 3207), h0: 13, h1: 11 },
];

const roads = td.roads.map((r) => prepPath({ p: r.p.map((q) => [...q]), a: r.a, b: r.b, w: r.w }));
const at0 = new Map();
const link = (n, i, dir) => { if (!at0.has(n)) at0.set(n, []); at0.get(n).push([i, dir]); };
roads.forEach((r, i) => { if (r.a !== r.b) { link(r.a, i, 1); link(r.b, i, -1); } });
const endDir = (i, d) => (d > 0 ? roads[i].endD : [-roads[i].startD[0], -roads[i].startD[1]]);
const startDir = (i, d) => (d > 0 ? roads[i].startD : [-roads[i].endD[0], -roads[i].endD[1]]);

const counts = {};
for (const k of ['car', 'person', 'rider', 'train', 'ship', 'boat']) counts[k] = { appear: 0, vanish: 0, jump: 0, appearFront: 0, vanishFront: 0, jumpFront: 0 };
const examples = [];

function run({ name, at: start, h0, h1 }) {
  // the viewer's route: from the road nearest the start along the roads (either way along them, as a viewer may),
  // the straightest and least driven on at each node
  let cur = 0, dir = 1, best = Infinity;
  roads.forEach((r, i) => { if (r.L < 40) return; const q = r.p[r.p.length >> 1], d = (q[0] - start.x) ** 2 + (q[1] - start.y) ** 2; if (d < best) { best = d; cur = i; } });
  const visited = new Map();
  function nextRoad() {
    const e = roads[cur], node = dir > 0 ? e.b : e.a, D = endDir(cur, dir);
    let o = (at0.get(node) ?? []).filter(([j]) => j !== cur && roads[j].L > 1);
    if (!o.length) o = [[cur, -dir]];
    // (its own random numbers: the life's draws stay as they are)
    const score = ([j, d]) => { const n = startDir(j, d); return -(D[0] * n[0] + D[1] * n[1]) + 3 * (visited.get(j) ?? 0) + 1.5 * rnd(); };
    [cur, dir] = o.slice().sort((a, b) => score(a) - score(b))[0];
    visited.set(cur, (visited.get(cur) ?? 0) + 1);
  }

  // (--mirror: drawn from the sim's snapshots, sim/server/snapshot.ts, as the page does from a worker)
  // (started as a server starts it: src/host/node.ts, hostSim; the traffic's default seed, no ground, no road physics)
  const server = nodeHost(DATA, { world: null, physics: { bodies: false, at: () => ({ x: start.x, z: start.y }) } }, { meta, traffic: td });
  const session = server.connect('p1');
  const mine = hello(checkBuild(meta, () => {}));
  const sim = MIRROR ? new MirrorSimClient(new CloneLink(new ThreadLink(session)), structuredClone(pristine), null, false, mine) : new LocalSimClient(session, mine);
  const T = sim.traffic, life = new StreetLife(new THREE.Scene(), sim);
  const dt = 1 / FPS, v = KMH / 3.6, P = pt(), F = pt();
  let s = 0;
  const viewer = { x: 0, z: 0, hx: 0, hz: 1 };
  function place() {
    const e = roads[cur], u = dir > 0 ? s : e.L - s;
    at(e, u, 1.5 * dir, P); at(e, u + 2 * dir, 1.5 * dir, F);
    const l = Math.hypot(F.x - P.x, F.y - P.y) || 1;
    Object.assign(viewer, { x: P.x, z: P.y, hx: (F.x - P.x) / l, hz: (F.y - P.y) / l });
  }

  let last = null;
  const frames = Math.round(SECONDS * FPS);
  for (let f = 0; f < frames; f++) {
    const t = f * dt;
    if (t >= STAND) { // standing still first (STAND s), then driving
      s += v * dt;
      while (s > roads[cur].L) { s -= roads[cur].L; nextRoad(); }
    }
    place();
    if (verbose && f % (FPS * 20) === 0) console.log(`  ${name} t=${t.toFixed(0)} viewer on road ${cur} (${viewer.x.toFixed(0)}, ${viewer.z.toFixed(0)})`);
    const focus = { x: viewer.x, z: viewer.z };
    sim.update(dt, { hour: h0 + (h1 - h0) * t / SECONDS, focus });
    life.update(dt, 0, focus);
    const now = new Map();
    for (const c of T.roadVehicles()) { const d = life.drawn('car', c.id); if (d) now.set(c, ['car', d.x, d.z]); }
    for (const p of T.people) { const d = life.drawn('person', p.id); if (d) now.set(p, ['person', d.x, d.z]); }
    for (const p of T.riders) { const d = life.drawn('person', p.id); if (d) now.set(p, ['rider', d.x, d.z]); }
    if (last) {
      const near = (k, x, z) => Math.hypot(x - viewer.x, z - viewer.z) < (k === 'car' ? CAR_R : PED_R);
      const front = (x, z) => { const dx = x - viewer.x, dz = z - viewer.z, l = Math.hypot(dx, dz) || 1; return (dx * viewer.hx + dz * viewer.hz) / l > 0.5; };
      const flag = (what, k, x, z, extra = '') => {
        counts[k][what]++;
        if (front(x, z)) counts[k][what + 'Front']++;
        if (examples.length < 600) examples.push(`${name} t=${t.toFixed(2)} ${k} ${what} at ${Math.hypot(x - viewer.x, z - viewer.z).toFixed(0)} m${front(x, z) ? ' (in front)' : ''}${extra}`);
      };
      for (const [o, [k, x, z]] of now) {
        const was = last.get(o);
        if (!was) { if (near(k, x, z)) flag('appear', k, x, z); continue; }
        const d = Math.hypot(x - was[1], z - was[2]);
        if (d > JUMP && (near(k, x, z) || near(k, was[1], was[2]))) flag("jump", k, x, z, ` by ${d.toFixed(1)} m` + (k === "car" ? ` (road ${o.e} s ${o.s.toFixed(1)} lane ${o.lane} prev ${o.prev} next ${o.next} why ${o.why} v ${o.v.toFixed(1)})` : ""));
      }
      for (const [o, [k, x, z]] of last) if (!now.has(o) && near(k, x, z)) flag('vanish', k, x, z);
    }
    last = now;
  }
  console.log(`  ${name}: ${T.cars.length} cars, ${T.people.length} people, ${T.riders.length} riders at the end (hour ${h0} to ${h1})`);
}

if (STREET) for (const r of RUNS) run(r);

// ---------------------------------------------------------------- trains and boats
// what is drawn, frame to frame, checked for the viewers vs: { name, x, z }; now: Map(who -> [kind, x, z]); R and the
// jump allowed by kind
const ids = new Map();
function follow(vs, R, allow) {
  let last = null;
  return (now, t) => {
    if (last) for (const v of vs) {
      const near = (k, x, z) => Math.hypot(x - v.x, z - v.z) < R[k];
      const once = new Set(); // (a train once, not each of its cars: who.tr)
      const flag = (what, k, x, z, extra, who) => {
        const id = `${what}:${typeof who === 'object' ? ids.get(who.tr ?? who) ?? ids.set(who.tr ?? who, ids.size).size - 1 : who}`;
        if (once.has(id)) return;
        once.add(id);
        counts[k][what]++;
        if (examples.length < 600) examples.push(`${v.name} t=${t.toFixed(1)} ${k} ${what} at ${Math.hypot(x - v.x, z - v.z).toFixed(0)} m${extra}`);
      };
      for (const [o, [k, x, z]] of now) {
        const was = last.get(o);
        if (!was) { if (near(k, x, z)) flag('appear', k, x, z, '', o); continue; }
        const d = Math.hypot(x - was[1], z - was[2]);
        if (d > allow[k] && (near(k, x, z) || near(k, was[1], was[2]))) flag('jump', k, x, z, ` by ${d.toFixed(1)} m`, o);
      }
      for (const [o, [k, x, z]] of last) if (!now.has(o) && near(k, x, z)) flag('vanish', k, x, z, '', o);
    }
    last = now;
  };
}

function transit() {
  const { TrainTraffic } = loaded.trains, { BoatTraffic } = loaded.boats, { STEP } = loaded.world;
  const tp = (td.trains ?? []).map((d) => prepPath({ p: d.p.map((q) => [...q]) })), P = pt();
  const tv = [];
  tp.forEach((p, i) => {
    tv.push({ name: `track ${i} start`, x: p.p[0][0], z: p.p[0][1] }, { name: `track ${i} end`, x: p.p.at(-1)[0], z: p.p.at(-1)[1] });
    for (const s of new Set(td.trains[i].svc.flatMap((v) => v.stops))) { at(p, s, 0, P); tv.push({ name: `track ${i} stop ${s}`, x: P.x, z: P.y }); }
  });
  // (one viewer for the places closer than 50 m)
  const uniq = (vs) => vs.filter((v, i) => !vs.slice(0, i).some((u) => Math.hypot(u.x - v.x, u.z - v.z) < 50));
  const dt = STEP, H0 = 7;
  for (const v of uniq(tv)) {
    const trains = new TrainTraffic(td.trains ?? []), check = follow([v], { train: TRAIN_R }, { train: JUMP + 17 * dt });
    for (let f = 1, F = Math.round(TRAIN_S / dt); f <= F; f++) {
      const t = f * dt;
      trains.tick(t, dt, H0 + t / 3600, v);
      check(new Map(Array.from(trains.coaches(), ({ id, x, z }) => [id, ['train', x, z]])), t);
    }
  }
  const bd = JSON.parse(fs.readFileSync(`${DATA}boats.json`, 'utf8')), fw = bd.fairway;
  const bv = [];
  if (fw) for (const [lane, l] of [['up', fw.up], ['down', fw.down]]) {
    bv.push({ name: `${lane} lane start`, x: l[0][0], z: l[0][1] }, { name: `${lane} lane end`, x: l.at(-1)[0], z: l.at(-1)[1] });
    for (let k = 100; k < l.length - 100; k += 150) bv.push({ name: `${lane} lane ${k}`, x: l[k][0], z: l[k][1] });
  }
  bd.berths.forEach((b, i) => bv.push({ name: `berth ${i}`, x: b.x, z: b.y }));
  if (bd.tour?.length) bv.push({ name: 'pier', x: bd.tour[0][0], z: bd.tour[0][1] });
  const bdt = 0.5;
  for (const day of DAYS) {
    const boats = new BoatTraffic(bd), check = follow(uniq(bv), { ship: SHIP_R, boat: SHIP_R }, { ship: JUMP + 4 * bdt, boat: JUMP + 4 * bdt });
    for (let f = 0, F = Math.round(24 * 3600 / bdt); f < F; f++) {
      boats.tick(f * bdt, 0, day);
      check(new Map(boats.poses.map(({ id, kind, x, z }) => [`${kind}:${id}`, [kind, x, z]])), f * bdt);
    }
  }
  console.log(`  transit: ${uniq(tv).length} viewers by the tracks for ${TRAIN_S} s, ${uniq(bv).length} by the river for days ${DAYS.join(', ')}`);
}
if (TRANSIT) transit();

const total = Object.values(counts).reduce((a, c) => a + c.appear + c.vanish + c.jump, 0);
const line = Object.entries(counts).filter(([k]) => (STREET || !['car', 'person', 'rider'].includes(k)) && (TRANSIT || ['car', 'person', 'rider'].includes(k))).map(([k, c]) => `${k}: appear ${c.appear} (front ${c.appearFront}) vanish ${c.vanish} (front ${c.vanishFront}) jump ${c.jump} (front ${c.jumpFront})`).join('; ');
if (verbose) for (const e of examples) console.log('  ' + e);
if (total) { console.log(`FAIL popin-check: ${line}`); process.exit(1); }
console.log(`PASS popin-check: nothing appeared, vanished or jumped within ${CAR_R} m (cars) / ${PED_R} m (people, riders) / ${TRAIN_R} m (trains) / ${SHIP_R} m (boats)` + (STREET ? `; street: ${RUNS.length} runs of ${SECONDS} s (${STAND} s standing, then ${KMH} km/h)` : '') + (TRANSIT ? '; trains and boats' : ''));
