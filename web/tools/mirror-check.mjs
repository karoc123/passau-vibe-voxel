// The snapshot gate (ADR 0008, src/sim/server/snapshot.ts): what the page draws from the sim's snapshots is
// what it draws from the sim itself. Two world sims (each started by the host, src/host/node.ts) from one seed on the real traffic data, ticked alike at a viewer
// that stands, then drives along a road: one drawn by StreetLife through LocalSimClient (the sim's own objects), the
// other through MirrorSimClient over a CloneLink of a ThreadLink (a TrafficMirror set from each snapshot, the snapshots
// structured-cloned and the commands sent through JSON as to a Web Worker or a socket: the protocol gate). Every
// frame the drawn poses of every car, person and rider (by id), the signal heads, the trains' coaches, the boats and
// the walked person must agree bit for bit; a player follows a car, walks as a person and lets go on the way (the
// commands through both clients; the walk's seat inputs acked alike).
// usage (in web/): node tools/mirror-check.mjs [-v] [--seconds S]; prints PASS with the counts compared, or FAIL
import fs from 'node:fs';
import * as THREE from 'three';
import { DATA, load } from './real-city.mjs';

const args = process.argv.slice(2), verbose = args.includes('-v');
const SECONDS = (() => { const i = args.indexOf('--seconds'); return i >= 0 ? +args[i + 1] : 90; })();
const FPS = 30;
const { StreetLife } = await load('view/life.ts'), { nodeHost } = await load('host/node.ts');
const { LocalSimClient, MirrorSimClient, ThreadLink, CloneLink } = await load('client/sim-client.ts');
const { unpackTraffic } = await load('sim/traffic-pack.ts');
const { hello } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const raw = JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'));
const data = () => unpackTraffic(structuredClone(raw));
const meta = JSON.parse(fs.readFileSync(`${DATA}meta.json`, 'utf8'));
const boats = fs.existsSync(`${DATA}boats.json`) ? JSON.parse(fs.readFileSync(`${DATA}boats.json`, 'utf8')) : null;
const at = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };

// (both started as a server starts them: src/host/node.ts, hostSim; no ground, no road physics)
const host = () => nodeHost(DATA, { seed: 5, world: null, physics: { bodies: false } }, { meta, traffic: data(), boats });
const a = host(), b = host();
// (the clients' own hello: this code, the build read, the default tuning; the hosts' must match it)
const mine = hello(checkBuild(meta, () => {}));
const P = 'p1', direct = new LocalSimClient(a.connect(P), mine), link = new CloneLink(new ThreadLink(b.connect(P)));
const mirror = new MirrorSimClient(link, data(), null, mine);
const lifeA = new StreetLife(new THREE.Scene(), direct), lifeB = new StreetLife(new THREE.Scene(), mirror);

const fail = [];
let compared = 0, frames = 0, acked = true;
const key = (o) => `${o.kind}:${o.bike ? 'r' : ''}${o.id}`;
const drawn = (T, life) => {
  const m = new Map();
  for (const o of [...T.roadVehicles(), ...T.people, ...T.riders]) {
    const d = life.drawn(o.kind, o.id);
    if (d) m.set(key(o), [d.x, d.y, d.z, d.h ?? 0, d.pitch ?? 0, d.roll ?? 0]);
  }
  return m;
};
const matrices = (life) => { const out = []; life.group.traverse((c) => { if (c.isInstancedMesh) out.push([c.count, ...c.instanceMatrix.array.slice(0, c.count * 16), ...(c.instanceColor?.array.slice(0, c.count * 3) ?? [])]); }); return out; };
const send = (cmd) => { direct.send(cmd); mirror.send(cmd); };

let followed = null, walked = null;
for (let f = 0; f < SECONDS * FPS; f++) {
  const t = f / FPS, focus = { x: at.x + Math.max(0, t - 20) * 8, z: at.y };
  // (a player follows a car at 10 s, walks as a person from 30 s to 50 s, lets go at 60 s)
  if (f === 10 * FPS && direct.traffic.cars.length) { followed = direct.traffic.cars[0].id; send({ kind: 'follow', entity: { kind: 'car', id: followed } }); }
  if (f === 30 * FPS) {
    const p = direct.traffic.people.find((q) => lifeA.drawn('person', q.id)), d = p && lifeA.drawn('person', p.id);
    if (p) {
      walked = p.id;
      send({ kind: 'follow', entity: { kind: 'person', id: walked } });
      send({ kind: 'enterSeat', entity: { kind: 'person', id: walked }, role: 'walker', pose: { x: d.x, y: d.y, z: d.z, h: d.h ?? 0, moving: false } });
    }
  }
  if (walked !== null && f > 30 * FPS && f < 50 * FPS) {
    const w = direct.walkedPose(walked);
    if (w) send({ kind: 'seatInput', role: 'walker', input: { ...w, x: w.x + 1.2 / FPS, moving: true } });
  }
  if (f === 50 * FPS) send({ kind: 'leaveSeat' });
  if (f === 60 * FPS) send({ kind: 'follow', entity: null });
  // (the world's time: the hosts' to set; the view: the player's command)
  for (const h of [a, b]) h.sim.setTime(17 + t / 600, 180);
  send({ kind: 'view', view: { focus, viewer: focus } });
  direct.update(1 / FPS);
  mirror.update(1 / FPS);
  const ta = direct.timeOfDay, tb = mirror.timeOfDay;
  if (ta.hour !== tb?.hour || ta.day !== tb?.day) fail.push(`t=${t.toFixed(2)}: the time of day ${JSON.stringify(ta)} vs ${JSON.stringify(tb)} from the snapshot`);
  lifeA.update(1 / FPS, 0, focus);
  lifeB.update(1 / FPS, 0, focus);
  frames++;
  const A = drawn(direct.traffic, lifeA), B = drawn(mirror.traffic, lifeB);
  if (A.size !== B.size) fail.push(`t=${t.toFixed(2)}: ${A.size} agents drawn, ${B.size} from the snapshot`);
  for (const [k, v] of A) {
    const w = B.get(k);
    compared++;
    if (!w || v.some((x, i) => x !== w[i])) { if (fail.length < 20) fail.push(`t=${t.toFixed(2)} ${k}: ${v.map((x) => x.toFixed(3))} vs ${w?.map((x) => x.toFixed(3))}`); }
  }
  const ma = matrices(lifeA), mb = matrices(lifeB);
  if (JSON.stringify(ma) !== JSON.stringify(mb) && fail.length < 20) fail.push(`t=${t.toFixed(2)}: instance matrices differ`);
  if (JSON.stringify(direct.seat()) !== JSON.stringify(mirror.seat()) && fail.length < 20) fail.push(`t=${t.toFixed(2)}: seats differ`);
  // (the seat inputs' acks and the frame's time: seq, tick, alpha)
  if (JSON.stringify([direct.ack(), direct.time]) !== JSON.stringify([mirror.ack(), mirror.time]) && fail.length < 20) fail.push(`t=${t.toFixed(2)}: ack or frame time differ`);
  if (walked !== null && f > 31 * FPS && f < 50 * FPS && !(direct.ack()?.seq > 0)) acked = false;
  if (verbose && f % (FPS * 10) === 0) console.log(`  t=${t} ${A.size} agents, seat ${JSON.stringify(mirror.seat())}`);
}
if (!acked) fail.push('the walk\'s seat inputs not acked (seq)');

// The bodies (sim/body-pose.ts, contract/agents.ts BodyDraw: a body's poses cross as quaternions): one host with
// the road physics and edits round BRIDGE, the player's session through a CloneLink; the player drives a moto (a
// driven body: lean, wheelie) and digs a hole under a car nearby (bodies falling, wrecks, fades). Every frame every
// car with a body is drawn alike by the sim (LifePhysics.pose) and from the snapshot (TrafficMirror bodies.pose) at
// three alphas, bit for bit.
const bodyCounts = await bodies();
async function bodies() {
  const { frameOf, mapToGrid, cellToAbsZ } = await load('core/layers.ts'), { worldEdits: WE } = await load('host/node.ts');
  const BRIDGE = { x: 4381, z: 2703 }, wait = () => new Promise((r) => setImmediate(r));
  const h = nodeHost(DATA, { seed: 5, world: 'tiles', edits: true, physics: { bodies: true } }, { meta, traffic: data(), boats });
  const lk = new CloneLink(new ThreadLink(h.connect(P))), c = new MirrorSimClient(lk, data(), null, mine), sim = h.sim, T = sim.traffic;
  const n = { frames: 0, poses: 0, moving: 0, driven: 0, fades: 0 };
  let loaded = false, driven = null, dug = false;
  c.loadPhysics(BRIDGE).then(() => { loaded = true; }, (e) => fail.push(`bodies: the road physics: ${e.message}`));
  const under = { x: 1, y: 2, z: 3, h: 0.5, pitch: 0.1, roll: 0.2 }, num = (q) => [q.x, q.y, q.z, q.h, q.pitch, q.roll];
  for (let f = 0; f < 24 * FPS; f++) {
    c.send({ kind: 'view', view: { focus: BRIDGE, viewer: BRIDGE } });
    if (loaded && driven === null && f > 5 * FPS) {
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
    await wait();
    n.frames++;
    const mine = new Map(c.traffic.roadVehicles().map((q) => [q.id, q])), a = c.time.alpha;
    for (const car of T.roadVehicles()) {
      const d = T.bodies?.drawState?.(car);
      if (!d) continue;
      const m = mine.get(car.id);
      if (d.p0) n.moving++;
      if (d.drive) n.driven++;
      if (d.fade) n.fades++;
      for (const k of [0, a, 1]) {
        n.poses++;
        const x = num(T.bodies.pose(car, k, under)), y = m && num(c.traffic.bodies.pose(m, k, under));
        if ((!y || x.some((v, i) => v !== y[i])) && fail.length < 20) fail.push(`bodies f=${f} car ${car.id} a=${k.toFixed(3)}: ${x.map((v) => v.toFixed(4))} vs ${y?.map((v) => v.toFixed(4))}`);
      }
    }
  }
  if (!n.moving || !n.driven) fail.push(`bodies: too few compared (${JSON.stringify(n)}; driving ${driven}, dug ${dug})`);
  h.dispose();
  WE.dropAll();
  return n;
}
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL mirror-check: ${fail.length} difference(s) in ${frames} frames`); process.exit(1); }
console.log(`PASS mirror-check: ${frames} frames, ${compared} agent poses, the instance matrices, seats, walked poses, seat input acks and frame times alike (direct and from snapshots; ${link.crossed} messages cloned); bodies: ${bodyCounts.poses} poses of ${bodyCounts.moving} moving, ${bodyCounts.driven} driven, ${bodyCounts.fades} fading in ${bodyCounts.frames} frames alike`);
