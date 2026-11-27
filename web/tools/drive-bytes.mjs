// A driver's bytes on a fast drive through the city: one player over a real WebSocket (src/host/ws.ts, deflated as
// for a phone over the internet) takes a car of the traffic by the Hauptbahnhof and is carried along the busiest roads
// at 90 km/h, the host's ticks in lockstep with the snapshots. Each tick the socket's written bytes are taken; the
// mean and the worst second must stay within the owner's 20 and 50 kB/s. The car's body is set along the road each
// tick, not steered: a steering script crashed within 50 m on the narrow streets and stood, which sends nothing new.
// A drive brings a new piece of the traffic circle in every few seconds, the driver's own car, body and reads every
// tick, and the cars hit on the way.
// usage (in web/): node tools/drive-bytes.mjs [-v]; prints PASS with the numbers, or FAIL
import { DATA, hasData, load } from './real-city.mjs';

if (!hasData()) { console.log(`SKIP drive-bytes: no ${DATA}meta.json / traffic.json`); process.exit(0); }
const verbose = process.argv.includes('-v');
const { serve } = await load('host/ws.ts');
const { readHostData } = await load('host/node.ts');
const { STEP } = await load('sim/road-net.ts');
const { default: WebSocket } = await import('ws');

// Measured 2026-11-27 (25 m/s, 3 starts): mean 5-6 kB/s, worst second 10-11 (before the driver's reads and the crafts'
// cores were rounded: 7-8, 13-14)
const MEAN_KB = 20, PEAK_KB = 50, SECS = 20, SPEED = 25;
const data = readHostData(DATA), spot = data.meta.labels.find((l) => /Hauptbahnhof/.test(l.name)) ?? { x: 7230, y: 2725 };
let tick = null;
const host = serve({ dir: DATA, host: '127.0.0.1', port: 0, query: 'seed=3&camps=0', log: () => {}, clock: (t) => { tick = t; return () => {}; } });
const port = await host.port, sim = host.server.sim, T = sim.traffic, fail = [];
const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
let got = 0, cars = new Set();
ws.on('message', (d) => {
  got++;
  for (const m of JSON.parse(d.toString())) if (m.kind === 'snapshot') for (const c of m.snapshot.cars) cars.add(c[0]);
});
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
const send = (commands) => ws.send(JSON.stringify({ kind: 'commands', commands }));
const settle = async (ok) => { for (const t0 = performance.now(); !ok(); await new Promise((r) => setImmediate(r))) if (performance.now() - t0 > 20000) throw new Error('drive-bytes: the host\'s snapshots not within 20 s'); };
// (the host sends a message every second tick)
let n = 0;
const step = async () => { tick(); n++; if (n % 2 === 0) await settle(() => got >= n / 2); };
const ground = (x, z) => T.ground?.support(x, z, 1000) ?? 0;

// the route: from a road, at each end the busiest road not taken yet
const roads = T.roads, outs = new Map(), pts = [];
roads.forEach((e, i) => { if (!outs.has(e.a)) outs.set(e.a, []); outs.get(e.a).push(i); });
const route = (first) => {
  pts.length = 0;
  const used = new Set();
  for (let i = first, len = 0; i != null && len < SPEED * SECS + 300;) {
    const e = roads[i];
    used.add(e.w);
    pts.push(...e.p);
    len += e.L;
    i = (outs.get(e.b) ?? []).filter((j) => !used.has(roads[j].w)).sort((a, b) => roads[b].c - roads[a].c || roads[b].L - roads[a].L)[0];
  }
};
const along = (d) => {
  for (let k = 1; k < pts.length; k++) {
    const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (d <= l) { const f = d / l; return { x: pts[k - 1][0] + f * (pts[k][0] - pts[k - 1][0]), z: pts[k - 1][1] + f * (pts[k][1] - pts[k - 1][1]) }; }
    d -= l;
  }
  const q = pts.at(-1);
  return { x: q[0], z: q[1] };
};

const p0 = { x: spot.x, z: spot.y };
send([{ kind: 'view', view: { focus: p0, viewer: { ...p0, y: 300 } } }]);
for (let i = 0; i < 600 && !(ground(p0.x, p0.z) > 0 && sim.physics); i++) { await step(); await new Promise((r) => setTimeout(r, 10)); }
if (!sim.physics) fail.push('the road physics not loaded within 20 s');
// a moving car on a main road near the station, the route from its road
const at = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };
let car = null;
for (let i = 0; i < 300 && !car && sim.physics; i++) {
  await step();
  car = T.cars.filter((c) => !c.bus && c.v > 3 && roads[c.e].c >= 2).map((c) => (T.carPose(c, c.s, c.off, at), [c, Math.hypot(at.x - p0.x, at.z - p0.z)]))
    .filter(([, d]) => d < 150).sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
}
if (!car) fail.push('no moving car on a main road within 150 m of the station');
const player = [...sim.players.keys()][0], driving = () => sim.seat(player)?.role === 'driver';
if (car) {
  route(car.e);
  for (let i = 0; i < 90 && !driving(); i++) { if (i % 15 === 0) send([{ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' }]); await step(); }
  if (!driving()) fail.push(`the car ${car.id} not taken`);
}
let start = 0, moved = 0;
const per = [];
if (car && driving()) {
  const q = sim.entities.pose({ kind: 'car', id: car.id });
  let bd = Infinity;
  for (let d = 0; d < 300; d += 2) { const a = along(d), dd = Math.hypot(a.x - q.x, a.z - q.z); if (dd < bd) { bd = dd; start = d; } }
  for (let i = 0; i < 60; i++) { send([{ kind: 'seatInput', role: 'driver', input: { gas: 0, brake: 0, steer: 0, handbrake: true } }]); await step(); }
  host.stats();
  cars = new Set();
  const L = sim.physics, from = sim.entities.pose({ kind: 'car', id: car.id });
  for (let t = 0; t < SECS / STEP; t++) {
    const d = start + t * STEP * SPEED, a = along(d), a2 = along(d + 3), h = Math.atan2(a2.x - a.x, a2.z - a.z), b = L.bodies.get(car.id);
    if (b) {
      b.body.setTranslation({ x: a.x - L.origin.x, y: ground(a.x, a.z) + b.build.ride + 0.1, z: a.z - L.origin.z }, true);
      b.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      b.body.setLinvel({ x: Math.sin(h) * SPEED, y: 0, z: Math.cos(h) * SPEED }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    const fx = Math.sin(h), fz = Math.cos(h);
    send([{ kind: 'seatInput', role: 'driver', input: { gas: 1, brake: 0, steer: 0, handbrake: false } },
      { kind: 'view', view: { focus: a, viewer: { x: a.x - fx * 6, z: a.z - fz * 6, y: ground(a.x, a.z) + 3 } } }]);
    await step();
    per.push((host.stats().wire.find(([p]) => p === player)?.[1] ?? 0) / 1024);
  }
  const to = sim.entities.pose({ kind: 'car', id: car.id });
  moved = Math.hypot(to.x - from.x, to.z - from.z);
}
host.close();
ws.close();

const ticks = 1 / STEP, secs = [];
for (let i = 0; i + ticks <= per.length; i++) { let s = 0; for (let k = i; k < i + ticks; k++) s += per[k]; secs.push(s); }
const mean = per.reduce((a, b) => a + b, 0) / SECS, peak = Math.max(0, ...secs);
// (the drive must have gone through the city: else nothing new came in to be sent)
if (per.length && moved < 0.5 * SPEED * SECS) fail.push(`the car moved ${moved.toFixed(0)} m in ${SECS} s, not along its route`);
if (per.length && cars.size < 30) fail.push(`${cars.size} cars of the traffic sent on the drive`);
if (mean > MEAN_KB) fail.push(`mean ${mean.toFixed(1)} kB/s, over ${MEAN_KB}`);
if (peak > PEAK_KB) fail.push(`worst second ${peak.toFixed(1)} kB/s, over ${PEAK_KB}`);
const line = `a driver at ${SPEED * 3.6} km/h through the city for ${SECS} s (${moved.toFixed(0)} m, ${cars.size} cars sent): ${mean.toFixed(1)} kB/s mean, worst second ${peak.toFixed(1)} (deflated; ${MEAN_KB} / ${PEAK_KB} the limit)`;
if (verbose) { const s = []; for (let i = 0; i < per.length; i += ticks) s.push(per.slice(i, i + ticks).reduce((a, b) => a + b, 0).toFixed(1)); console.log(`  kB each second: ${s.join(' ')}`); }
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL drive-bytes: ${line}`); process.exit(1); }
console.log(`PASS drive-bytes: ${line}`);
process.exit(0);
