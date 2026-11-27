// A page whose socket drops comes back as its player, through the real network host (src/host/ws.ts on a free port,
// the page's own client and SocketLink, Node's WebSocket) on a synthetic flat world, the host's ticks stepped here: A
// flies a hovercraft, P rides along, B stands beside it. A's and P's sockets cut: the craft hands off, its pilot's
// and P's seats still theirs, B refused both. Both back within the grace period: the same players, A at the controls
// (steering again, still named), P aboard. A cut for longer than it: the seat free, B takes it, A back as a new player
// on no seat. A's page hidden while flying: hands off, no snapshots, connected; shown, the present at once. P back
// with a token not the host's: a new player, not aboard.
// usage (in web/): node tools/resume.mjs [-v]; prints PASS lines, or FAIL and exit 1
import { imp, synthData } from './lib.mjs';

const verbose = process.argv.includes('-v');
const { serve } = await imp('src/host/ws.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { SocketLink } = await imp('src/client/sim-worker-link.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { craftBox } = await imp('src/sim/solids.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const G = 5, GRACE = 30;
const { dir } = await synthData({ size: [512, 256], ground: () => G, boxes: [] });
let tick = null;
const host = serve({ dir, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => { if (verbose) console.log(`  host: ${l}`); },
  clock: (t) => { tick = t; return () => {}; } });
const port = await host.port, sim = host.server.sim, all = [];
const add = (name) => {
  const link = new SocketLink(`ws://127.0.0.1:${port}`);
  const c = new MirrorSimClient(link, { roads: [], peds: [], ctrls: [] }, null, host.server.hello);
  c.setName(name);
  const p = { c, link, name };
  all.push(p);
  return p;
};
// a tick of the host, the clients' frames, and the sockets' messages let through either way (a tick on the network
// takes a few turns of the event loop; the checks wait for what they look at, a few ticks at most)
const step = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    for (const p of all) p.c.update(STEP);
    tick();
    for (let k = 0; k < 3; k++) await new Promise((r) => setImmediate(r));
  }
};
const until = async (ok, ticks = 60) => { for (let i = 0; i < ticks && !ok(); i++) { await step(); await new Promise((r) => setTimeout(r, 1)); } return ok(); };
// the socket cut (as a phone losing its network), the page not trying again until back() says so
const cut = async (p) => {
  const was = p.c.player;
  p.link.open = () => {};
  p.link.ws.close();
  await until(() => p.link.ws.readyState === 3);
  await step(3);
  return !!host.server.isAway?.(was);
};
const back = async (p, token) => {
  clearTimeout(p.link.timer);
  p.link.timer = null;
  delete p.link.open;
  if (token !== undefined) p.link.token = token;
  const before = p.c.hello;
  p.link.open();
  await until(() => p.link.ws.readyState === 1 && p.c.player);
  return before;
};
const ask = async (p, cmd, kind) => {
  p.c.results(kind);
  p.c.send(cmd);
  // (results() hands each result once)
  const r = [];
  await until(() => r.push(...p.c.results(kind)) > 0);
  return r;
};
const walk = (p, x, z) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: 0, moving: false } } });
};
const beside = (id, side, d) => {
  const b = craftBox(sim.crafts.get(id).type, sim.crafts.get(id).core.pose), a = side * (b.r + d);
  return { x: b.x + a * Math.cos(b.h), z: b.z - a * Math.sin(b.h) };
};
const seat = (player) => sim.seat(player);
const fly = (p, drive) => p.c.send({ kind: 'seatInput', role: 'pilot', input: { drive, turn: 0, lift: 0, side: 0 } });

const A = add('Testpilot A'), P = add('Testgast P'), B = add('Testgast B');
check(await until(() => all.every((p) => p.c.player)) && new Set(all.map((p) => p.c.player)).size === 3, 'three players greeted, each their own');

// A's hovercraft, P aboard, B on foot beside it
walk(A, 85, 100);
await step(3);
A.c.send({ kind: 'request', request: { kind: 'craft', type: 'hovercraft', spot: { x: 100, y: G + SPAWN_HEIGHT.hovercraft, z: 100, h: Math.PI / 2 } } });
await until(() => A.c.craftOf());
const id = A.c.craftOf()?.id, craft = () => sim.crafts.get(id);
let s = beside(id, 1, 1);
walk(P, s.x, s.z);
s = beside(id, -1, 1);
walk(B, s.x, s.z);
await until(() => seat(P.c.player)?.role === 'walker' && seat(B.c.player)?.role === 'walker');
await ask(P, { kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'passenger' }, 'enterSeat');
const pSeat = seat(P.c.player);
check(craft()?.pilot === A.c.player && pSeat?.role === 'passenger', `A flies a hovercraft, P aboard (${JSON.stringify(pSeat)})`);
for (let i = 0; i < 30; i++) { fly(A, 1); await step(); }

// both cut: hands off, the seats kept, B refused them
const a0 = A.c.player, p0 = P.c.player;
check(await cut(A) && await cut(P), 'A\'s and P\'s sockets cut, both held by the host');
await step(5);
const c = craft();
check(c?.pilot === a0 && JSON.stringify(c.input) === JSON.stringify(c.core.neutral), `the craft hands off, its pilot's seat still A's (input ${JSON.stringify(c?.input)})`);
// (beside it again: refused as taken, not as too far)
s = beside(id, -1, 1);
walk(B, s.x, s.z);
await step(3);
let r = await ask(B, { kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'pilot' }, 'enterSeat');
check(r.length === 1 && !r[0].ok && r[0].reason === 'taken' && craft().pilot === a0, `B refused A's seat meanwhile (${JSON.stringify(r)})`);
r = await ask(B, { kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'passenger', index: pSeat?.index }, 'enterSeat');
check(r.length === 1 && !r[0].ok && r[0].reason === 'taken' && seat(p0)?.role === 'passenger', `B refused P's seat meanwhile (${JSON.stringify(r)})`);
for (let i = 0; i < 10; i++) await step(30);
check(!!host.server.isAway?.(a0) && craft().pilot === a0, 'A still held after 10 s');

// both back within the grace period: the same players, the same seats
await back(A);
await back(P);
await until(() => A.c.player && P.c.player && A.c.driver?.() !== undefined);
check(A.c.player === a0 && seat(a0)?.role === 'pilot' && craft().pilot === a0 && A.c.craftOf()?.id === id, `A back as ${A.c.player}, at the controls of its hovercraft`);
check(P.c.player === p0 && JSON.stringify(seat(p0)) === JSON.stringify(pSeat), `P back as ${P.c.player}, still aboard (${JSON.stringify(seat(p0))})`);
await until(() => B.c.nameOf(a0) === 'Testpilot A');
check(B.c.nameOf(a0) === 'Testpilot A', `A still named for B ('${B.c.nameOf(a0)}')`);
const x0 = { ...craft().core.pose };
for (let i = 0; i < 45; i++) { fly(A, 1); await step(); }
const moved = Math.hypot(craft().core.pose.x - x0.x, craft().core.pose.z - x0.z);
check(moved > 2, `A steers it again (${moved.toFixed(1)} m)`);

// A's page hidden with the throttle held (its frames, which send the input, stop with it): the craft hands off at
// once, A gets no snapshots but stays connected and aboard; shown again, the next snapshot is the present's
fly(A, 1);
await step();
A.link.away(true);
await step(3);
const h = craft(), neutral = (x) => JSON.stringify(x?.input) === JSON.stringify(x?.core.neutral);
check(h?.pilot === a0 && neutral(h), `A's page hidden: the craft hands off at once (input ${JSON.stringify(h?.input)})`);
// the snapshots counted by the host tick they were made in, not by when they came: the host hands off in the first
// tick after it took the away, and sends A none from that tick on, but those made before it may still be on their
// way (with the machine busy the page reads its socket ticks behind the host: up to 19 such seen)
await until(() => neutral(craft()));
const hid = sim.tick, onSnap = A.link.onSnapshot;
let after = 0;
A.link.onSnapshot = (sn) => { if (sn.tick >= hid) after++; onSnap(sn); };
await step(60);
A.link.onSnapshot = onSnap;
check(after === 0 && A.c.tick < hid && A.link.ws.readyState === 1 && !host.server.isAway?.(a0) && craft().pilot === a0,
  `and A is sent no snapshots for 2 s (${after} made after the hand-off at tick ${hid}), still connected, still the pilot`);
A.link.away(false);
await until(() => sim.tick - A.c.tick <= 2, 10);
check(sim.tick - A.c.tick <= 2, `shown again, A's next snapshot is the present's (A at ${A.c.tick}, the host at ${sim.tick})`);
fly(A, 0);

// A cut past the grace period: the seat free, B takes it; A back a new player
await cut(A);
await step(GRACE * Math.round(1 / STEP) + 30);
check(!host.server.isAway?.(a0) && craft()?.pilot === null && !seat(a0), `after ${GRACE} s the seat let go (pilot ${craft()?.pilot})`);
// (flown on since B stood beside it)
s = beside(id, -1, 1);
walk(B, s.x, s.z);
await step(3);
r = await ask(B, { kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'pilot' }, 'enterSeat');
check(r.some((x) => x.ok) && craft().pilot === B.c.player, `B takes the seat then (${JSON.stringify(r)})`);
await back(A);
await until(() => A.c.player && A.c.player !== a0);
check(A.c.player !== a0 && !seat(A.c.player), `A back late as a new player (${A.c.player}), on no seat`);

// P back with a token not the host's: a new player
await cut(P);
await back(P, 'not-a-token-of-this-host');
await until(() => P.c.player && P.c.player !== p0);
check(P.c.player !== p0 && !seat(P.c.player) && seat(p0)?.role === 'passenger', `a wrong token starts fresh (${P.c.player}, not aboard; ${p0} held)`);

for (const p of all) p.link.close();
host.close();
if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS resume');
process.exit(0);
