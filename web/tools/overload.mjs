// The network host giving way over its tick in the owner's order (host/overload.ts, host/ws.ts): a host by the
// cathedral with a player driving a car of the traffic and one on foot, over real WebSockets, its ticks stepped here
// as fast as they run (each second of the world judged on its own ticks). Forced over (a tick's budget near nothing):
// the crowd thins first, the cars only once the crowd is at its floor, the snapshots of the one on foot every second
// tick only once the cars are too; the driver gets every tick's snapshot, its car in each, and the world's clock moves
// a STEP a tick throughout (never slow motion). The load ended (an ample budget): given back in reverse, the send rate,
// then the cars, then the crowd, all the way. The street life round the players thins and fills with it.
// usage (in web/): node tools/overload.mjs [-v]; prints PASS with the numbers, or FAIL and what failed
import { WebSocket } from 'ws';
import { DATA, hasData, load } from './real-city.mjs';

if (!hasData()) { console.log(`SKIP overload: no ${DATA}meta.json / traffic.json`); process.exit(0); }
const verbose = process.argv.includes('-v');
const { serve } = await load('host/ws.ts'), { readHostData } = await load('host/node.ts'), { STEP } = await load('sim/road-net.ts');
const meta = readHostData(DATA).meta, spot = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const focus = { x: spot.x, z: spot.y }, FLOOR = 0.2, PER = Math.round(1 / STEP), fail = [];

let tick = null;
const host = serve({ dir: DATA, host: '127.0.0.1', port: 0, query: 'seed=3&camps=0', log: (l) => { if (verbose) console.log(`  host: ${l}`); },
  clock: (t) => { tick = t; return () => {}; } });
const port = await host.port, sim = host.server.sim, T = sim.traffic;

// a client: the snapshots it got (tick, world time, its seat, the detached cars' ids it holds after each: a snapshot
// carries those that changed and the player's reads when they did, the page keeps the rest)
const client = () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, got: [], open: false }, held = new Set();
  let seat = null;
  ws.on('open', () => { c.open = true; });
  ws.on('message', (data) => {
    for (const m of JSON.parse(data.toString())) if (m.kind === 'snapshot') {
      const s = m.snapshot;
      for (const id of s.gone[3]) held.delete(id);
      for (const d of s.detached) held.add(d.id);
      if (s.player) seat = s.player.seat;
      c.got.push({ tick: s.tick, t: s.t, seat, detached: [...held] });
    }
  });
  c.send = (...commands) => { if (c.open) ws.send(JSON.stringify({ kind: 'commands', commands })); };
  return c;
};
const D = client(), W = client(), view = { kind: 'view', view: { focus, viewer: { ...focus, y: 30 } } };
const settle = () => new Promise((r) => setImmediate(r));
let ticks = 0;
const step = async (each) => { each?.(); await settle(); tick(); ticks++; await settle(); };
const until = async (what, ok, seconds, each) => {
  for (let i = 0; i < seconds * PER; i++) { if (ok()) return true; await step(each); }
  fail.push(`${what}: not within ${seconds} s of the world's`);
  return false;
};

const ground = () => T.ground?.support(focus.x, focus.z, 1000) ?? 0;
await until('both clients connected', () => D.open && W.open, 5);
await until('the ground by the cathedral and the road physics', () => ground() > 0 && sim.physics, 30, () => { D.send(view); W.send(view); });
W.send({ kind: 'request', request: { kind: 'walk', pose: { x: focus.x, y: ground(), z: focus.z, h: 0, moving: false } } });
const at = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };
const near = (c) => (T.carPose(c, c.s, c.off, at), Math.hypot(at.x - focus.x, at.z - focus.z) < 300);
let car = null;
await until('a moving car near the cathedral', () => (car = T.cars.find((c) => c.v > 1 && !c.bus && near(c))), 10, () => { D.send(view); W.send(view); });
if (!car) { console.log(fail.join('\n')); console.log('FAIL overload'); host.close(); process.exit(1); }
const mine = () => D.got.at(-1)?.seat?.entity?.id === car.id && D.got.at(-1)?.seat?.role === 'driver';
const drive = () => { D.send({ kind: 'seatInput', role: 'driver', input: { gas: 0.5, brake: 0, steer: 0, handbrake: false } }); };
D.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' });
await until('D drives the car', mine, 5, drive);
// the street life round them filled in at the hour's want
await until('street life round them', () => T.cars.length > 20 && T.people.length > 50, 10, drive);
for (let i = 0; i < 3 * PER; i++) await step(drive);

// a second at a time: the levels at its end
const seconds = async (n, each) => { const out = []; for (let s = 0; s < n; s++) { for (let i = 0; i < PER; i++) await step(drive); out.push({ ...host.load.levels, cars0: T.cars.length, people: T.people.length + T.riders.length }); each?.(out.at(-1)); } return out; };
const before = { cars: T.cars.length, people: T.people.length + T.riders.length };
const from = ticks, d0 = D.got.length, w0 = W.got.length;
host.load.budget = 1e-6;
const over = await seconds(1);
while (over.length < 40 && over.filter((l) => l.every > 1).length < 3) over.push(...await seconds(1));
const thin = { cars: T.cars.length, people: T.people.length + T.riders.length };
host.load.budget = 1e6;
const under = [];
while (under.length < 40 && !(under.at(-1)?.crowd === 1 && under.at(-1)?.cars === 1 && under.at(-1)?.every === 1)) under.push(...await seconds(1));
for (let i = 0; i < 4; i++) await step(drive);
const to = ticks;
if (verbose) for (const [k, ls] of [['over', over], ['under', under]]) console.log(`  ${k}: ${ls.map((l) => `${l.crowd.toFixed(2)}/${l.cars.toFixed(2)}/${l.every} (${l.cars0} cars, ${l.people} people)`).join(', ')}`);

// the order: the cars only with the crowd at its floor, the send rate only with the cars at theirs, either way
const fmt = (l) => `crowd ${l.crowd.toFixed(2)} cars ${l.cars.toFixed(2)} send 1/${l.every}`;
for (const [k, ls] of [['over', over], ['under', under]]) for (const l of ls) {
  if (l.cars < 1 && l.crowd > FLOOR) { fail.push(`${k}: the cars thinned with the crowd not at its floor (${fmt(l)})`); break; }
  if (l.every > 1 && (l.cars > FLOOR || l.crowd > FLOOR)) { fail.push(`${k}: the send rate cut before the crowd and the cars were at their floor (${fmt(l)})`); break; }
}
if (!(over[0].crowd < 1 && over[0].cars === 1 && over[0].every === 1)) fail.push(`over: the first second gave way to the crowd first: ${fmt(over[0])}`);
if (!over.some((l) => l.every > 1)) fail.push(`over: the send rate never cut (last ${fmt(over.at(-1))})`);
const back = under.findIndex((l) => l.every === 1);
if (back !== 0) fail.push(`under: the send rate not given back first (${back < 0 ? 'never' : `second ${back + 1}`})`);
const ul = under.at(-1);
if (!(ul.crowd === 1 && ul.cars === 1 && ul.every === 1)) fail.push(`under: not all given back in 40 s (${fmt(ul)})`);
// the street life thinned with the levels
if (!(thin.people < 0.6 * before.people)) fail.push(`the crowd ${before.people} -> ${thin.people}: not thinned`);
if (!(thin.cars < 0.8 * before.cars)) fail.push(`the cars ${before.cars} -> ${thin.cars}: not thinned`);
// the driver: every tick's snapshot with its car, the world's clock a STEP a tick
const dg = D.got.slice(d0), wg = W.got.slice(w0);
let gaps = 0, slow = 0, without = 0;
for (let i = 1; i < dg.length; i++) {
  if (dg[i].tick !== dg[i - 1].tick + 1) gaps++;
  if (Math.abs(dg[i].t - dg[i - 1].t - STEP * (dg[i].tick - dg[i - 1].tick)) > 1e-3) slow++;
}
for (const s of dg) if (!s.detached.includes(car.id) || s.seat?.entity?.id !== car.id) without++;
if (dg.length < to - from - 4) fail.push(`the driver got ${dg.length} snapshots in ${to - from} ticks`);
if (gaps) fail.push(`the driver's snapshots skipped ${gaps} time(s): its own car not drawn from every tick's`);
if (without) fail.push(`${without} of the driver's snapshots without its car`);
if (slow) fail.push(`${slow} tick(s) where the world's clock moved by other than a STEP: slow motion`);
if (to - from !== (over.length + under.length) * PER + 4) fail.push('the host skipped ticks');
// the one on foot: every second tick while the send rate is cut
const wGaps = wg.filter((s, i) => i > 0 && s.tick === wg[i - 1].tick + 2).length;
if (wGaps < PER) fail.push(`the one on foot got every tick's snapshot through the cut send rate (${wGaps} every second tick)`);

host.close();
D.ws.terminate(); W.ws.terminate();
const sum = `crowd to ${FLOOR} in ${over.findIndex((l) => l.crowd === FLOOR) + 1} s, cars in ${over.findIndex((l) => l.cars === FLOOR) + 1} s, send rate cut in ${over.findIndex((l) => l.every > 1) + 1} s; ` +
  `all back in ${under.length} s; street life ${before.cars} cars ${before.people} people -> ${thin.cars} and ${thin.people}; the driver ${dg.length} snapshots in ${to - from} ticks, the one on foot ${wg.length}`;
if (fail.length) { console.log(fail.map((f) => `  ${f}`).join('\n')); console.log(`FAIL overload: ${sum}`); process.exit(1); }
console.log(`PASS overload: ${sum}`);
process.exit(0);
