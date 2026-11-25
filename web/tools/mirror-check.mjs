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
const host = () => nodeHost(DATA, { seed: 5, world: null, physics: { bodies: false, at: () => ({ x: at.x, z: at.y }) } }, { meta, traffic: data(), boats });
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
  const input = { hour: 17 + t / 600, day: 180, focus, viewer: focus };
  direct.update(1 / FPS, input);
  mirror.update(1 / FPS, input);
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
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL mirror-check: ${fail.length} difference(s) in ${frames} frames`); process.exit(1); }
console.log(`PASS mirror-check: ${frames} frames, ${compared} agent poses, the instance matrices, seats, walked poses, seat input acks and frame times alike (direct and from snapshots; ${link.crossed} messages cloned)`);
