// The snapshot gate (docs/plans/local-server.md, src/sim/snapshot.ts): what the page draws from the sim's snapshots is
// what it draws from the sim itself. Two world sims from one seed on the real traffic data, ticked alike at a viewer
// that stands, then drives along a road: one drawn by StreetLife through LocalSimClient (the sim's own objects), the
// other through MirrorSimClient over a ThreadLink (a TrafficMirror set from each snapshot, as from a Web Worker). Every
// frame the drawn poses of every car, person and rider (by id), the signal heads, the trains' coaches, the boats and
// the walked person must agree bit for bit; a player follows a car, walks as a person and lets go on the way (the
// commands through both clients).
// usage (in web/): node tools/mirror-check.mjs [-v] [--seconds S]; prints PASS with the counts compared, or FAIL
import fs from 'node:fs';
import * as THREE from 'three';
import { DATA, load } from './real-city.mjs';

const args = process.argv.slice(2), verbose = args.includes('-v');
const SECONDS = (() => { const i = args.indexOf('--seconds'); return i >= 0 ? +args[i + 1] : 90; })();
const FPS = 30;
const { StreetLife } = await load('view/life.ts'), { WorldSim } = await load('sim/world-sim.ts'), { LOCAL_PLAYER } = await load('nav/player.ts');
const { LocalSimClient, MirrorSimClient, ThreadLink } = await load('sim/sim-client.ts'), { SimServer } = await load('sim/sim-server.ts');
const { unpackTraffic } = await load('sim/traffic-pack.ts');
const raw = JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'));
const data = () => unpackTraffic(structuredClone(raw));
const meta = JSON.parse(fs.readFileSync(`${DATA}meta.json`, 'utf8'));
const boats = fs.existsSync(`${DATA}boats.json`) ? JSON.parse(fs.readFileSync(`${DATA}boats.json`, 'utf8')) : null;
const at = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };

const a = new SimServer(new WorldSim(data(), { seed: 5 })), b = new SimServer(new WorldSim(data(), { seed: 5 }));
if (boats) { a.sim.setBoats(boats); b.sim.setBoats(boats); }
const direct = new LocalSimClient(a), mirror = new MirrorSimClient(new ThreadLink(b, LOCAL_PLAYER), data(), null, LOCAL_PLAYER);
const lifeA = new StreetLife(new THREE.Scene(), direct), lifeB = new StreetLife(new THREE.Scene(), mirror);

const fail = [];
let compared = 0, frames = 0;
const key = (o) => `${o.kind}:${o.bike ? 'r' : ''}${o.id}`;
const drawn = (T) => {
  const m = new Map();
  for (const o of [...T.roadVehicles(), ...T.people, ...T.riders]) if (o.rp) m.set(key(o), [o.rp.x, o.rp.y, o.rp.z, o.rh ?? 0, o.pitch ?? 0, o.roll ?? 0]);
  return m;
};
const matrices = (life) => { const out = []; life.group.traverse((c) => { if (c.isInstancedMesh) out.push([c.count, ...c.instanceMatrix.array.slice(0, c.count * 16), ...(c.instanceColor?.array.slice(0, c.count * 3) ?? [])]); }); return out; };
const send = (cmd) => { direct.send(cmd); mirror.send(cmd); };

let followed = null, walked = null;
for (let f = 0; f < SECONDS * FPS; f++) {
  const t = f / FPS, focus = { x: at.x + Math.max(0, t - 20) * 8, z: at.y };
  // (a player follows a car at 10 s, walks as a person from 30 s to 50 s, lets go at 60 s)
  if (f === 10 * FPS && direct.traffic.cars.length) { followed = direct.traffic.cars[0].id; send({ kind: 'follow', player: LOCAL_PLAYER, entity: { kind: 'car', id: followed } }); }
  if (f === 30 * FPS) {
    const p = direct.traffic.people.find((q) => q.rp);
    if (p) {
      walked = p.id;
      send({ kind: 'follow', player: LOCAL_PLAYER, entity: { kind: 'person', id: walked } });
      send({ kind: 'enterSeat', player: LOCAL_PLAYER, entity: { kind: 'person', id: walked }, role: 'walker', pose: { x: p.rp.x, y: p.rp.y, z: p.rp.z, h: p.rh ?? 0, moving: false } });
    }
  }
  if (walked !== null && f > 30 * FPS && f < 50 * FPS) {
    const w = direct.walkedPose(walked);
    if (w) send({ kind: 'seatInput', player: LOCAL_PLAYER, role: 'walker', input: { ...w, x: w.x + 1.2 / FPS, moving: true } });
  }
  if (f === 50 * FPS) send({ kind: 'leaveSeat', player: LOCAL_PLAYER });
  if (f === 60 * FPS) send({ kind: 'follow', player: LOCAL_PLAYER, entity: null });
  const input = { hour: 17 + t / 600, day: 180, focus, viewer: focus };
  direct.update(1 / FPS, input);
  mirror.update(1 / FPS, input);
  lifeA.update(1 / FPS, 0, focus);
  lifeB.update(1 / FPS, 0, focus);
  frames++;
  const A = drawn(direct.traffic), B = drawn(mirror.traffic);
  if (A.size !== B.size) fail.push(`t=${t.toFixed(2)}: ${A.size} agents drawn, ${B.size} from the snapshot`);
  for (const [k, v] of A) {
    const w = B.get(k);
    compared++;
    if (!w || v.some((x, i) => x !== w[i])) { if (fail.length < 20) fail.push(`t=${t.toFixed(2)} ${k}: ${v.map((x) => x.toFixed(3))} vs ${w?.map((x) => x.toFixed(3))}`); }
  }
  const ma = matrices(lifeA), mb = matrices(lifeB);
  if (JSON.stringify(ma) !== JSON.stringify(mb) && fail.length < 20) fail.push(`t=${t.toFixed(2)}: instance matrices differ`);
  if (JSON.stringify(direct.seat(LOCAL_PLAYER)) !== JSON.stringify(mirror.seat(LOCAL_PLAYER)) && fail.length < 20) fail.push(`t=${t.toFixed(2)}: seats differ`);
  if (verbose && f % (FPS * 10) === 0) console.log(`  t=${t} ${A.size} agents, seat ${JSON.stringify(mirror.seat(LOCAL_PLAYER))}`);
}
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL mirror-check: ${fail.length} difference(s) in ${frames} frames`); process.exit(1); }
console.log(`PASS mirror-check: ${frames} frames, ${compared} agent poses, the instance matrices, seats and walked poses alike (direct and from snapshots)`);
