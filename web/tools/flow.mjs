// The flow gate (target architecture step 5): what a page draws without being sent it. On the real traffic data, one
// host and two pages (one by the cathedral, one by the station that then jumps to the university):
// - trains: every page's coaches at a tick are the host's at that tick, no train in a snapshot, and a page reckoning
//   900 ticks ahead with no snapshot draws them where the host has them 900 ticks later (no drift);
// - far traffic: beyond the agents' circle a page draws many cars, none inside it, (the roads the host sends cars of are left to them);
// - promotion: every car the host spawns where the flow has cars is put on a flow car (same road and lane, within
//   NEAR m), so a road coming into the circle gets its agents where the page drew its flow.
// usage (in web/): node tools/flow.mjs [-v]; prints PASS with the counts, or FAIL
import fs from 'node:fs';
import { DATA, load } from './real-city.mjs';
import { sessionLink } from './lib.mjs';

const verbose = process.argv.includes('-v');
const FPS = 30, SECONDS = 50, AHEAD = 900, NEAR = 2, FAR = 1500, HOUR = 8;
const { nodeHost } = await load('host/node.ts');
const { MirrorSimClient, CloneLink } = await load('client/sim-client.ts');
const { unpackTraffic } = await load('sim/traffic-pack.ts');
const { hello } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const { ACTIVE_R } = await load('sim/road-net.ts');
const { Flow, carsAt } = await load('sim/flow.ts');
const raw = JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'));
const data = () => unpackTraffic(structuredClone(raw));
const meta = JSON.parse(fs.readFileSync(`${DATA}meta.json`, 'utf8'));
const label = (kind, x, y) => meta.labels.find((l) => l.kind === kind) ?? { x, y };
const dom = label('cathedral', 8085, 2771), station = label('station', 7019, 2871), uni = label('university', 7553, 3236);

const b = nodeHost(DATA, { seed: 3, world: null, physics: { bodies: false } }, { meta, traffic: data(), boats: null });
const mine = hello(checkBuild(meta, () => {}));
const fail = [], note = (s) => { if (fail.length < 20) fail.push(s); };
let sentTrains = 0;
const page = (P) => {
  const s = b.connect(P), snap = s.snapshot.bind(s);
  s.snapshot = () => { const w = snap(); if ('trains' in w) sentTrains++; return w; };
  const session = sessionLink(s);
  return { session, mirror: new MirrorSimClient(new CloneLink(session), data(), null, mine) };
};
const pages = [page('p1'), page('p2')];
const T = b.sim.traffic, flow = new Flow(T.net.roads);

const key = (c) => `${c.id} ${c.x.toFixed(3)} ${c.y.toFixed(3)} ${c.z.toFixed(3)} ${c.heading.toFixed(4)}`;
const coachesOf = (it) => [...it].map(key).sort().join('\n');
const hostAt = new Map();
let compared = 0, coachesSeen = 0, ahead = null, aheadOk = false;

// (each car's first state, and the flow cars of its road and lane at that tick)
const known = new Set(), fc = { lane: 0, s: 0, bus: false, col: '' };
let spawned = 0, onFlow = 0, noFlow = 0, worst = 0;
const promoted = () => {
  const d = carsAt(b.sim.timeOfDay.hour);
  for (const c of T.cars) {
    if (known.has(c.id)) continue;
    known.add(c.id);
    const e = T.net.roads[c.e], n = flow.count(c.e, d);
    if (!n) { noFlow++; continue; }
    spawned++;
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      flow.car(c.e, j, n, T.t, fc);
      if (fc.lane !== c.lane) continue;
      const ds = Math.abs(fc.s - c.s);
      best = Math.min(best, ds, e.L - ds);
    }
    if (best <= NEAR) onFlow++;
    else worst = Math.max(worst, best);
  }
};

let farN = 0, farIn = 0, farSent = 0, farMin = Infinity;
for (let f = 0; f < SECONDS * FPS; f++) {
  const t = f / FPS;
  b.sim.setTime(HOUR, 180);
  const views = [dom, t < 20 ? station : uni];
  pages.forEach(({ mirror }, i) => {
    const v = { x: views[i].x, z: views[i].y };
    mirror.send({ kind: 'view', view: { focus: v, viewer: v } });
    mirror.update(1 / FPS);
  });
  b.update(1 / FPS);
  hostAt.set(b.sim.tick, coachesOf(T.trains.coaches()));
  for (const p of pages) p.session.deliver();
  if (f > 2) promoted();
  for (const { mirror } of pages) {
    const M = mirror.traffic, tick = M.tick;
    if (!tick) continue;
    if (!ahead) {
      M.reckon(tick + AHEAD);
      ahead = { tick: tick + AHEAD, coaches: coachesOf(M.trains.coaches()) };
    }
    M.reckon(tick);
    const want = hostAt.get(tick), got = coachesOf(M.trains.coaches());
    if (want === undefined) continue;
    compared++;
    coachesSeen += got ? got.split('\n').length : 0;
    if (got !== want) note(`tick ${tick}: a page's coaches are not the host's (${got.split('\n').length} vs ${want.split('\n').length})`);
  }
  if (ahead && b.sim.tick === ahead.tick) {
    aheadOk = hostAt.get(ahead.tick) === ahead.coaches;
    if (!aheadOk) note(`the coaches reckoned ${AHEAD} ticks ahead are not the host's then`);
  }
  if (f === 15 * FPS) {
    const M = pages[0].mirror.traffic;
    farSent = new Set(M.cars.map((c) => c.e)).size;
    M.farCars(dom.x, dom.y, FAR, (p) => {
      const r = Math.hypot(p.x - dom.x, p.z - dom.y);
      farN++; farMin = Math.min(farMin, r);
      if (r <= ACTIVE_R) farIn++;
    });
  }
}
if (sentTrains) note(`${sentTrains} snapshots carry trains`);
if (!compared || !coachesSeen) note(`no coaches compared (${compared} ticks, ${coachesSeen} coaches)`);
if (!ahead || !hostAt.has(ahead.tick)) note('the tick reckoned ahead never came');
if (farN < 100) note(`only ${farN} far cars drawn by the cathedral`);
if (farIn) note(`${farIn} far cars drawn inside the agents' circle (${ACTIVE_R} m)`);
if (spawned < 50) note(`only ${spawned} cars spawned on roads with flow`);
if (onFlow < spawned) note(`${spawned - onFlow} of ${spawned} spawned cars off the flow (worst ${worst.toFixed(1)} m)`);
const summary = `coaches alike on 2 pages and the host over ${compared} page ticks (${coachesSeen} coaches), ${AHEAD} ticks ahead alike, no train sent; ${farN} far cars by the cathedral from ${farMin.toFixed(0)} m (circle ${ACTIVE_R} m, ${farSent} roads sent); ${onFlow}/${spawned} spawned cars on a flow car (${noFlow} on roads without flow)`;
if (verbose || fail.length) console.log(`  ${summary}`);
for (const s of fail) console.log(`  ${s}`);
console.log(fail.length ? 'FAIL flow' : `PASS flow: ${summary}`);
process.exit(fail.length ? 1 : 0);
