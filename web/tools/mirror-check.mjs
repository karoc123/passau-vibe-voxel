// The snapshot gate (ADR 0008, src/sim/server/snapshot.ts): the page draws the sim from its snapshots. A world sim
// (started by the host, src/host/node.ts) from one seed on the real traffic data, ticked by this tool at a viewer that
// stands, then drives along a road, drawn by StreetLife through MirrorSimClient over a CloneLink (the snapshots
// structured-cloned and the commands sent through JSON as to a Web Worker or a socket: the protocol gate); a player
// follows a car, walks as a person and lets go on the way (the walk's seat inputs acked). Agents must be drawn, the
// time of day must be the host's, and the render clock must draw every tick in order, never more than a few ticks
// behind the newest snapshot.
// Then the bodies (below): drawn alike by the sim and from its snapshots, bit for bit, at the tick drawn.
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
// (the client's own hello: this code, the build read, the default tuning; the host's must match it)
const mine = hello(checkBuild(meta, () => {}));
const P = 'p1', session = sessionLink(b.connect(P)), link = new CloneLink(session);
const mirror = new MirrorSimClient(link, data(), null, mine);
const lifeB = new StreetLife(new THREE.Scene(), mirror);

const fail = [];
let frames = 0, drawnAgents = 0, acked = true, lastDrawn = -1, maxLead = 0;
const send = (cmd) => mirror.send(cmd);

let followed = null, walked = null;
for (let f = 0; f < SECONDS * FPS; f++) {
  const t = f / FPS, focus = { x: at.x + Math.max(0, t - 20) * 8, z: at.y };
  // (a player follows a car at 10 s, walks as a person from 30 s to 50 s, lets go at 60 s)
  if (f === 10 * FPS && mirror.traffic.cars.length) { followed = mirror.traffic.cars[0].id; send({ kind: 'follow', entity: { kind: 'car', id: followed } }); }
  if (f === 30 * FPS) {
    const p = mirror.traffic.people.find((q) => lifeB.drawn('person', q.id)), d = p && lifeB.drawn('person', p.id);
    if (p) {
      walked = p.id;
      send({ kind: 'follow', entity: { kind: 'person', id: walked } });
      send({ kind: 'enterSeat', entity: { kind: 'person', id: walked }, role: 'walker', pose: { x: d.x, y: d.y, z: d.z, h: d.h ?? 0, moving: false } });
    }
  }
  if (walked !== null && f > 30 * FPS && f < 50 * FPS) {
    const w = mirror.walkedPose(walked);
    if (w) send({ kind: 'seatInput', role: 'walker', input: { ...w, x: w.x + 1.2 / FPS, moving: true } });
  }
  if (f === 50 * FPS) send({ kind: 'leaveSeat' });
  if (f === 60 * FPS) send({ kind: 'follow', entity: null });
  // (the world's time: the host's to set; the view: the player's command)
  b.sim.setTime(17 + t / 600, 180);
  send({ kind: 'view', view: { focus, viewer: focus } });
  mirror.update(1 / FPS);
  b.update(1 / FPS);
  session.deliver();
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
  if (walked !== null && f > 31 * FPS && f < 50 * FPS && !(mirror.ack()?.seq > 0)) acked = false;
  if (verbose && f % (FPS * 10) === 0) console.log(`  t=${t} seat ${JSON.stringify(mirror.seat())} lead ${mirror.lead.toFixed(2)}`);
}
if (!drawnAgents) fail.push('nothing drawn');
if (!acked) fail.push('the walk\'s seat inputs not acked (seq)');
if (maxLead > 2) fail.push(`the render clock fell ${maxLead.toFixed(2)} ticks behind the newest snapshot`);

// The bodies (sim/body-pose.ts, contract/agents.ts BodyDraw: a body's poses cross as quaternions): one host with
// the road physics and edits round BRIDGE, the player's session through a CloneLink; the player drives a moto (a
// driven body: lean, wheelie) and digs a hole under a car nearby (bodies falling, wrecks, fades). Every frame every
// car with a body is drawn alike by the sim (LifePhysics.pose, kept per tick) and from the snapshot of the tick the
// client draws (TrafficMirror bodies.pose) at three alphas, bit for bit.
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
          const y = m && num(c.traffic.bodies.pose(m, k, under));
          if ((!y || x[i].some((v, j) => v !== y[j])) && fail.length < 20) fail.push(`bodies f=${f} tick ${c.time.tick} car ${id} a=${k}: ${x[i].map((v) => v.toFixed(4))} vs ${y?.map((v) => v.toFixed(4))}`);
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
console.log(`PASS mirror-check: ${frames} frames (${drawnAgents} agents drawn), seat input acks, the time of day, every tick drawn in order (at most ${maxLead.toFixed(2)} ticks behind; ${link.crossed} messages cloned); bodies: ${bodyCounts.poses} poses of ${bodyCounts.moving} moving, ${bodyCounts.driven} driven, ${bodyCounts.fades} fading in ${bodyCounts.frames} frames alike`);
