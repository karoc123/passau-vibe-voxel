// The snapshot gate (ADR 0008, src/sim/server/snapshot.ts): the page draws the sim from its snapshots. A world sim
// (started by the host, src/host/node.ts) from one seed on the real traffic data, ticked by this tool at a viewer that
// stands, then drives along a road, drawn by StreetLife through MirrorSimClient over a CloneLink (the snapshots
// structured-cloned and the commands sent through JSON as to a Web Worker or a socket: the protocol gate); a player
// follows a car, walks on foot and lets go on the way (the walk's seat inputs acked). Agents must be drawn, the
// time of day must be the host's, and the render clock must draw every tick in order, never more than a few ticks
// behind the newest snapshot.
// Then the bodies (below): drawn alike by the sim and from its snapshots at the tick drawn, within what the snapshot's
// rounding leaves (BODY_M, BODY_RAD).
// usage (in web/): node tools/mirror-check.mjs [-v] [--seconds S]; prints PASS with the counts compared, or FAIL
import fs from 'node:fs';
import * as THREE from 'three';
import { DATA, load } from './real-city.mjs';
import { sessionLink } from './lib.mjs';

const args = process.argv.slice(2), verbose = args.includes('-v');
const SECONDS = (() => { const i = args.indexOf('--seconds'); return i >= 0 ? +args[i + 1] : 90; })();
const FPS = 30;
const { StreetLife } = await load('view/life.ts'), { nodeHost } = await load('host/node.ts');
const { MirrorSimClient, CloneLink } = await load('client/sim-client.ts');
const { unpackTraffic } = await load('sim/traffic-pack.ts');
const { hello } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const raw = JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'));
const data = () => unpackTraffic(structuredClone(raw));
const meta = JSON.parse(fs.readFileSync(`${DATA}meta.json`, 'utf8'));
const boats = fs.existsSync(`${DATA}boats.json`) ? JSON.parse(fs.readFileSync(`${DATA}boats.json`, 'utf8')) : null;
const at = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };

// (started as a server starts it: src/host/node.ts, hostSim; no ground, no road physics)
const b = nodeHost(DATA, { seed: 5, world: null, physics: { bodies: false } }, { meta, traffic: data(), boats });
// (the client's own hello: this code, the build read; the host's must match it)
const mine = hello(checkBuild(meta, () => {}));
const P = 'p1', session = sessionLink(b.connect(P)), link = new CloneLink(session);
const mirror = new MirrorSimClient(link, data(), null, mine);
const lifeB = new StreetLife(new THREE.Scene(), mirror);

const fail = [];
// The cars and people as sent (sim/agent-wire.ts: a sample where the client's reckoning drifts, rounded; gone): read
// back by a client's end and reckoned on to each tick, every field the sim's (lengths within WIRE_M) but for ph and
// wait, which the client works out its own way, and its place on its way within DRIFT (+ the rounding) on the ticks a
// drift is sent, REACH between; each tick, all of the traffic's, so ids coming and going, ways changing and one sent
// whole again are all crossed. The wire is the protocol: a field lost or misread draws a car in the wrong place.
const { AgentWire, AgentRead, AGENT_TICKS, DRIFT, reckon, STILL_M, STILL_Q } = await load('sim/agent-wire.ts');
const { STEP } = await load('sim/road-net.ts');
const WIRE_M = 0.011, REACH = 0.3, wireOut = new AgentWire(), wireIn = new AgentRead((e) => b.sim.traffic.net.roads[e].L);
let wireN = 0, wireSent = 0, wireHeld = 0, wireMax = 0;
const wireCheck = () => {
  const T = b.sim.traffic, tick = b.sim.tick, due = tick % AGENT_TICKS === 0;
  // (a tenth of the cars and people left out each tick, so some leave sight and come back)
  const some = (l) => l.filter((o) => (o.id * 7 + tick) % 10);
  const cars = some(T.cars), walkers = some(T.people), riders = some(T.riders);
  const out = (l, f) => l.map((o) => f(o, tick)).filter((w) => w);
  const sc = out(cars, (c, t) => wireOut.car(c, t)), sp = out(walkers, (p, t) => wireOut.person(p, t)), sr = out(riders, (p, t) => wireOut.person(p, t));
  const [goneC, goneP] = wireOut.done();
  const gotC = wireIn.readCars(sc, goneC, tick), [gotP, gotR] = wireIn.readPeople(sp, sr, goneP, tick);
  wireSent += sc.length + sp.length + sr.length;
  wireHeld += cars.length + walkers.length + riders.length;
  const same = (want, got, keys, what, place) => {
    if (want.length !== got.length) { fail.push(`wire t=${tick}: ${got.length} ${what} held of ${want.length}`); return; }
    const by = new Map(got.map((g) => [g.id, g]));
    for (const w of want) {
      const g = by.get(w.id);
      if (!g) { if (fail.length < 20) fail.push(`wire t=${tick}: ${what} ${w.id} not held`); continue; }
      for (const k of keys) {
        // (none: prev2, next2 -1, prev2Off 0, as sim/road-net.ts reads them)
        const a = w[k] ?? { prev2: -1, next2: -1, prev2Off: 0 }[k], c = g[k];
        const ok = typeof a === 'number' ? Math.abs(a - c) <= WIRE_M : a === c || (k === 'bike' && !a && !c);
        if (!ok && fail.length < 20) fail.push(`wire t=${tick}: ${what} ${w.id} ${k} ${a} read as ${c}`);
        wireN++;
      }
      const d = Math.abs(place(g) - w.s);
      wireMax = Math.max(wireMax, d);
      if (d > (due ? DRIFT + WIRE_M : REACH) && fail.length < 20) fail.push(`wire t=${tick}: ${what} ${w.id} reckoned ${d.toFixed(3)} m off`);
    }
  };
  const ways = ['id', 'e', 'lane', 'prev', 'prevOff', 'prev2', 'prev2Off', 'next', 'next2', 'len', 'bus', 'vt', 'col'];
  same(cars, gotC, due ? [...ways, 'brake', 'off'] : ways, 'car', (g) => reckon(g.s, g.v, g.at, tick));
  const who = ['id', 'e', 'dir', 'v', 'lat', 'wait', 'col', 'bike'], at = (g) => reckon(g.s, g.v, g.at, tick, g.dir, g.wait);
  same(walkers, gotP, who, 'person', at);
  same(riders, gotR, who, 'rider', at);
};
let frames = 0, drawnAgents = 0, acked = true, lastDrawn = -1, maxLead = 0;
const send = (cmd) => mirror.send(cmd);

let followed = null, walk = null, lastStep = new Map();
// The cars are drawn reckoned on from samples sent only when they drift (sim/agent-wire.ts), a correction blended in:
// how much a car's step from one frame to the next changes, at the 99th percentile (m; measured 0.019 at 30 frames a
// second)
const kicks = [], KICK = 0.04;
for (let f = 0; f < SECONDS * FPS; f++) {
  const t = f / FPS, focus = { x: at.x + Math.max(0, t - 20) * 8, z: at.y };
  // (a player follows a car at 10 s, walks on foot by a person followed from 30 s to 50 s, lets go at 60 s)
  if (f === 10 * FPS && mirror.traffic.cars.length) { followed = mirror.traffic.cars[0].id; send({ kind: 'follow', entity: { kind: 'car', id: followed } }); }
  if (f === 30 * FPS) {
    const p = mirror.traffic.people.find((q) => lifeB.drawn('person', q.id)), d = p && lifeB.drawn('person', p.id);
    if (p) {
      walk = { x: d.x, y: d.y, z: d.z, h: d.h ?? 0, moving: false };
      send({ kind: 'follow', entity: { kind: 'person', id: p.id } });
      send({ kind: 'request', request: { kind: 'walk', pose: walk } });
    }
  }
  if (walk && f > 30 * FPS && f < 50 * FPS) {
    walk = { ...walk, x: walk.x + 1.2 / FPS, moving: true };
    send({ kind: 'seatInput', role: 'walker', input: walk });
  }
  if (f === 50 * FPS) send({ kind: 'leaveSeat' });
  if (f === 60 * FPS) send({ kind: 'follow', entity: null });
  // (the world's time: the host's to set; the view: the player's command)
  b.sim.setTime(17 + t / 600, 180);
  send({ kind: 'view', view: { focus, viewer: focus } });
  mirror.update(1 / FPS);
  b.update(1 / FPS);
  session.deliver();
  wireCheck();
  const ta = b.sim.timeOfDay, tb = mirror.timeOfDay;
  if (ta.hour !== tb?.hour || ta.day !== tb?.day) fail.push(`t=${t.toFixed(2)}: the time of day ${JSON.stringify(ta)} vs ${JSON.stringify(tb)} from the snapshot`);
  lifeB.update(1 / FPS, 0, focus);
  frames++;
  // (the tick drawn: never back, never one skipped once the clock runs; a few ticks behind at most)
  const drawn = mirror.time.tick;
  if (f > FPS && (drawn < lastDrawn || drawn > lastDrawn + 2) && fail.length < 20) fail.push(`f=${f}: drew tick ${drawn} after ${lastDrawn}`);
  lastDrawn = drawn;
  if (f > FPS) maxLead = Math.max(maxLead, mirror.lead);
  const T = mirror.traffic;
  for (const o of [...T.roadVehicles(), ...T.people, ...T.riders]) if (lifeB.drawn(o.kind, o.id)) drawnAgents++;
  // (each car of the traffic's drawn step from the frame before, and how much it changed)
  const steps = new Map();
  for (const c of T.cars) {
    const d = lifeB.drawn('car', c.id), l = lastStep.get(c.id);
    if (!d) continue;
    const st = { x: d.x, z: d.z, dx: l ? d.x - l.x : NaN, dz: l ? d.z - l.z : NaN };
    if (f > 5 * FPS && l && !Number.isNaN(l.dx)) kicks.push(Math.hypot(st.dx - l.dx, st.dz - l.dz));
    steps.set(c.id, st);
  }
  lastStep = steps;
  if (walk && f > 31 * FPS && f < 50 * FPS && !(mirror.ack()?.seq > 0)) acked = false;
  if (verbose && f % (FPS * 10) === 0) console.log(`  t=${t} seat ${JSON.stringify(mirror.seat())} lead ${mirror.lead.toFixed(2)}`);
}
if (!drawnAgents) fail.push('nothing drawn');
kicks.sort((a, b) => a - b);
const kick = kicks[Math.floor(0.99 * (kicks.length - 1))] ?? Infinity;
if (!(kick <= KICK)) fail.push(`the cars drawn: a step changes by ${kick.toFixed(3)} m from one frame to the next (99th percentile; at most ${KICK})`);
if (!acked) fail.push('the walk\'s seat inputs not acked (seq)');
if (maxLead > 2) fail.push(`the render clock fell ${maxLead.toFixed(2)} ticks behind the newest snapshot`);

// The bodies (sim/body-pose.ts, contract/agents.ts BodyDraw: a body's poses cross as quaternions): one host with
// the road physics and edits round BRIDGE, the player's session through a CloneLink; the player drives a moto (a
// driven body: lean, wheelie) and digs a hole under a car nearby (bodies falling, wrecks, fades). Every frame every
// car with a body is drawn alike by the sim (LifePhysics.pose, kept per tick) and from the snapshot of the tick the
// client draws (TrafficMirror bodies.pose) at three alphas, alike within BODY_M m and BODY_RAD rad: a snapshot carries
// positions to the mm and a body's rotation to 1e-4 (sim/agent-wire.ts wireBody), so its x, y, z may be a mm or two off
// (the ride too), its angles far less; the same code drawing both is what is checked, not the bits. A body sent at
// rest (its p0 its p1) is drawn where it was sent until it strays by STILL_M, a quaternion's part by STILL_Q: so much
// more (its origin also swung by the rotation's error over its ride).
// A heading and a roll are read off the quaternion: with the nose near straight up or down (a motorbike on its tail)
// the quaternion's rounding turns them by up to its 1e-4 over the pitch's cosine, though the body drawn is the same
// within that rounding: their leeway grows so.
const BODY_M = 0.002, BODY_RAD = 0.0005;
const alike = (x, y, rest) => x.every((v, j) => Math.abs(j < 3 ? v - y[j] : Math.atan2(Math.sin(v - y[j]), Math.cos(v - y[j])))
  <= (j < 3 ? BODY_M + (rest ? 2 * STILL_M : 0) : (BODY_RAD + (rest ? 4 * STILL_Q : 0)) / (j === 3 || j === 5 ? Math.max(Math.abs(Math.cos(x[4])), 0.01) : 1)));
const bodyCounts = await bodies();
async function bodies() {
  const { frameOf, mapToGrid, cellToAbsZ } = await load('core/layers.ts'), { worldEdits: WE } = await load('host/node.ts');
  const BRIDGE = { x: 4381, z: 2703 }, wait = () => new Promise((r) => setImmediate(r));
  const h = nodeHost(DATA, { seed: 5, world: 'tiles', edits: true, eager: true, physics: { bodies: true } }, { meta, traffic: data(), boats });
  const sl = sessionLink(h.connect(P)), lk = new CloneLink(sl), c = new MirrorSimClient(lk, data(), null, mine), sim = h.sim, T = sim.traffic;
  const n = { frames: 0, poses: 0, moving: 0, driven: 0, fades: 0 };
  const under = { x: 1, y: 2, z: 3, h: 0.5, pitch: 0.1, roll: 0.2 }, num = (q) => [q.x, q.y, q.z, q.h, q.pitch, q.roll], K = [0, 0.5, 1];
  // the sim's own drawing of each car with a body, by tick
  const sims = new Map();
  let driven = null, dug = false;
  for (let f = 0; f < 24 * FPS; f++) {
    c.send({ kind: 'view', view: { focus: BRIDGE, viewer: BRIDGE } });
    if (sim.physics && driven === null && f > 5 * FPS) {
      const car = T.cars.find((q) => q.vt === 'moto' && q.v > 1) ?? T.cars.find((q) => q.v > 1 && !q.bus);
      if (car) { driven = car.id; c.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' }); }
    }
    if (driven !== null) c.send({ kind: 'seatInput', role: 'driver', input: { gas: f % 90 < 60 ? 1 : 0, brake: 0, steer: Math.sin(f / 20) * 0.6, handbrake: false } });
    const me = c.driver();
    if (me && !dug && f > 8 * FPS) {
      // (a hole under a moving car 15..60 m from the driven one)
      const o = T.cars.find((q) => { const p = T.carPose(q, q.s, q.off, { x: 0, y: 0, z: 0, h: 0, pitch: 0 }); const d = Math.hypot(p.x - me.pose.x, p.z - me.pose.z); return q.v > 2 && d > 15 && d < 60; });
      if (o) {
        const p = T.carPose(o, o.s, o.off, { x: 0, y: 0, z: 0, h: 0, pitch: 0 }), fr = frameOf(meta), [col, row] = mapToGrid(fr, Math.floor(p.x), Math.floor(p.z));
        const g = T.ground.support(p.x, p.z, p.y + 3) ?? p.y;
        dug = true;
        c.edit({ kind: 'sphere', col, row, z: cellToAbsZ(fr, Math.floor(g)), r: 4, colour: 0 }).catch((e) => fail.push(`bodies: the edit: ${e.message}`));
      }
    }
    sim.setTime(17, 180);
    c.update(1 / FPS);
    // (what the client draws now: a tick the sim drew before)
    const want = sims.get(c.time.tick), mine = new Map(c.traffic.roadVehicles().map((q) => [q.id, q]));
    if (want) {
      n.frames++;
      for (const [id, x] of want) {
        const m = mine.get(id);
        K.forEach((k, i) => {
          n.poses++;
          const y = m && num(c.traffic.bodies.pose(m, k, under)), d = c.traffic.draws.get(id);
          if ((!y || !alike(x[i], y, d?.p0 && d.p1 && JSON.stringify(d.p0) === JSON.stringify(d.p1))) && fail.length < 20) fail.push(`bodies f=${f} tick ${c.time.tick} car ${id} a=${k}: ${x[i].map((v) => v.toFixed(4))} vs ${y?.map((v) => v.toFixed(4))}`);
        });
      }
    }
    h.update(1 / FPS);
    sl.deliver();
    const now = new Map();
    for (const car of T.roadVehicles()) {
      const d = T.bodies?.drawState?.(car);
      if (!d) continue;
      if (d.p0) n.moving++;
      if (d.drive) n.driven++;
      if (d.fade) n.fades++;
      now.set(car.id, K.map((k) => num(T.bodies.pose(car, k, under))));
    }
    sims.set(sim.tick, now);
    sims.delete(sim.tick - 10);
    await wait();
  }
  if (!n.moving || !n.driven) fail.push(`bodies: too few compared (${JSON.stringify(n)}; driving ${driven}, dug ${dug})`);
  h.dispose();
  WE.dropAll();
  return n;
}
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL mirror-check: ${fail.length} difference(s) in ${frames} frames`); process.exit(1); }
console.log(`PASS mirror-check: ${frames} frames (${drawnAgents} agents drawn), ${wireN} agents' fields read back from the wire alike (${(100 * wireSent / wireHeld).toFixed(1)} % of them sent a tick, reckoned within ${wireMax.toFixed(2)} m), the cars drawn smoothly (a step changes by ${kick.toFixed(3)} m at the 99th percentile), seat input acks, the time of day, every tick drawn in order (at most ${maxLead.toFixed(2)} ticks behind; ${link.crossed} messages cloned); bodies: ${bodyCounts.poses} poses of ${bodyCounts.moving} moving, ${bodyCounts.driven} driven, ${bodyCounts.fades} fading in ${bodyCounts.frames} frames alike (${BODY_M * 1000} mm, ${BODY_RAD} rad)`);
