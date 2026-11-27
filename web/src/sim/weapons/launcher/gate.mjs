// The grenade launcher's gate, on a synthetic world (flat ground, a wall; node files a real host reads: tools/lib.mjs
// synthData, host/node.ts nodeHost, a few seconds): players on foot through the host, each with a client of its
// snapshots. A grenade flies (launch), bursts on the wall (blast) and leaves a crater of the blast's radius: every cell
// within it air, every one beyond it as it was. The crater crosses as its op, to the players near it only (one far
// off is sent it once it looks near), and each client applies it over its own node files: the same columns, cell for
// cell, as the host's, also for a player who joins after and one whose snapshots cross as JSON; kept when
// nobody has been near for longer than the edits' keeping. A grenade bursts on a body, which stays as it was. A held
// trigger fires at most one each 1.5 s; one far off is sent neither flight nor blast; the others are told the slot in a
// player's hand. The view draws the flight and the blast and lets them go, an avatar's gun is its slot's, each weapon
// has a model of its own. Then over a real WebSocket (host/ws.ts): the crater whole in the shooter's and a late
// joiner's live edits.
// usage (in web/): node src/sim/weapons/launcher/gate.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from '../../../../tools/lib.mjs';

const { nodeHost, nodeTileCache, worldEdits } = await imp('src/host/node.ts');
const { LiveEdits } = await imp('src/core/live-edits.ts');
const { frameOf } = await imp('src/core/layers.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { weaponIn } = await imp('src/sim/weapons/index.ts');
const { PRESENCE } = await imp('src/sim/tuning.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));

// the world: ground up to y 5 (cells 0..4 solid), a wall 2 m thick and 10 m high at x 60..62 (map metres, y up)
const G = 5, WALL = 60;
const { dir, data } = await synthData({ size: [384, 256], ground: () => G, surface: () => 'earth',
  boxes: [{ x0: WALL, x1: WALL + 2, z0: 0, z1: 256, y0: G, y1: G + 10, mat: 'wall' }] });
const solid = (x, y, z) => y < G || (x >= WALL && x < WALL + 2 && y < G + 10);
const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 80 }, data);
server.trackEdits();
const N = data.meta.tiles.N, live = worldEdits.liveEdits;

const traffic = () => ({ roads: [], peds: [], ctrls: [] });
// a client applies the edits' ops over its own node files, as the page does over its TileCache
const client = (link, hello) => {
  const edits = new LiveEdits();
  return new MirrorSimClient(link, traffic(), null, hello, edits, { cache: nodeTileCache(dir, N, edits), frame: frameOf(data.meta) });
};
// the edits the snapshots carried: the ops (not the nodes' columns), and their bytes as JSON
let opNotes = 0, opBytes = 0, notOps = 0;

// json: the snapshots cross as the network host sends them (JSON)
const player = (name, x, z, json = false) => {
  const s = server.connect(name), link = sessionLink(s);
  const c = client(json ? jsonLink(link) : new CloneLink(link), server.hello);
  const take = link.onSnapshot;
  link.onSnapshot = (snap) => {
    for (const e of snap.edits) { opNotes++; opBytes += JSON.stringify(e).length; if (e.ops && !e.ops.every((o) => o.kind === 'sphere')) notOps++; }
    take(snap);
  };
  c.send({ kind: 'view', view: { focus: { x, z } } });
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: Math.PI / 2, moving: false, arm: 2 } } });
  return { c, link };
};
const jsonLink = (link) => {
  const trip = (v) => JSON.parse(JSON.stringify(v)), out = { onHello() {}, onSnapshot() {}, send: (c) => link.send(c), close: () => link.close() };
  link.onHello = (h) => out.onHello(trip(h));
  link.onSnapshot = (s) => out.onSnapshot(trip(s));
  return out;
};
const all = [];
// (the nodes and the craters' nodes load between ticks, as on the host's clock)
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    for (const p of all) p.c.update(STEP);
    server.update(STEP);
    for (const p of all) p.link.deliver();
    await new Promise((r) => setImmediate(r));
  }
};
const A = player('a', 40, 128), B = player('b', 48, 134), C = player('c', 300, 128);
all.push(A, B, C);
await tick(5);
check(all.every((p) => p.c.seat()?.role === 'walker'), 'three players on foot');
const armOf = (c, who) => c.traffic.avatars.find((v) => v.player === who)?.pose.arm;
const arm0 = armOf(B.c, 'a');
A.c.send({ kind: 'seatInput', role: 'walker', input: { x: 40, y: G, z: 128, h: Math.PI / 2, moving: false, arm: 1 } });
await tick(2);
const arm1 = armOf(B.c, 'a');
A.c.send({ kind: 'seatInput', role: 'walker', input: { x: 40, y: G, z: 128, h: Math.PI / 2, moving: false, arm: 2 } });
await tick(2);
check(arm0 === 2 && arm1 === 1 && armOf(B.c, 'a') === 2, `B is told the slot in A's hand (${arm0}, ${arm1}, ${armOf(B.c, 'a')}): the gun drawn on A's avatar`);
const of = (c, since, kind) => c.eventsSince(since).filter((e) => e.kind === kind);
const fire = (pitch, h = Math.PI / 2) => A.c.send({ kind: 'fire', slot: 2, h, pitch });

// at the wall: a grenade in flight, then a blast at the wall's face
let t0 = server.sim.tick;
fire(0.1);
await tick(40);
const launch = of(A.c, t0, 'launch'), blast = of(A.c, t0, 'blast');
check(launch.length === 1 && launch[0].weapon === 'launcher' && launch[0].player === 'a' && Math.abs(Math.hypot(launch[0].v.x, launch[0].v.y, launch[0].v.z) - 30) < 1e-6,
  `a grenade is launched (${JSON.stringify(launch[0]?.v)})`);
const at = blast[0]?.at;
check(blast.length === 1 && Math.abs(at.x - WALL) < 0.05 && at.y > G && at.y < G + 10 && blast[0].r === 3 && blast[0].tick - launch[0].tick > 10,
  `it flies and bursts on the wall's face (${JSON.stringify(at)}, ${blast[0]?.tick - launch[0]?.tick} ticks)`);
check(of(B.c, t0, 'launch').length === 1 && of(B.c, t0, 'blast').length === 1, 'B, near, is sent the flight and the blast');
check(of(C.c, t0, 'launch').length === 0 && of(C.c, t0, 'blast').length === 0, 'C, 250 m off, is sent neither');

// the crater: within r of the blast's cell air, beyond it as it was (in the host's live edits)
// (a run over the cell, whatever its palette id: the test world's soil is id 0)
const cell = (edits, x, y, z) => {
  const tx = Math.floor(x / N), ty = Math.floor(z / N), n = edits.get(tx, ty);
  if (!n) return solid(x, y, z);
  const S = N + 2, c = x - tx * N + 1 + S * (z - ty * N + 1), { counts, runs } = n.base;
  let k = 0;
  for (let i = 0; i < c; i++) k += counts[i];
  for (let j = 0; j < counts[c]; j++) { const r = 3 * (k + j); if (y >= runs[r] && y < runs[r] + runs[r + 1]) return true; }
  return false;
};
const crater = (edits, at) => {
  const cx = Math.floor(at.x), cy = Math.floor(at.y), cz = Math.floor(at.z);
  let carved = 0, wrong = 0, kept = 0;
  for (let y = cy - 6; y <= cy + 6; y++) for (let z = cz - 6; z <= cz + 6; z++) for (let x = cx - 6; x <= cx + 6; x++) {
    if (y < 0) continue;
    const d = Math.hypot(x - cx, y - cy, z - cz), was = solid(x, y, z), now = cell(edits, x, y, z);
    if (d <= 3) { if (now) wrong++; else if (was) carved++; } else if (now !== was) wrong++; else if (was) kept++;
  }
  return { ok: carved > 50 && wrong === 0, text: `${carved} cells within 3 m made air, ${kept} beyond it as they were, ${wrong} wrong` };
};
const hc = crater(live, at);
check(hc.ok, `the crater: ${hc.text}`);

// the same edit for everyone: every client's nodes as the host's
const nodesOf = () => [...live.entries()].map(([tx, ty]) => [tx, ty]);
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const eq = (a, b) => !!a && !!b && a.constructor === b.constructor && bytes(a).equals(bytes(b));
// (cell for cell: the columns and the ground, the foliage's too)
const same = (c) => nodesOf().length > 0 && nodesOf().every(([tx, ty]) => {
  const h = live.get(tx, ty), e = c.edits.get(tx, ty);
  return e && ['counts', 'runs', 'ground'].every((k) => eq(e.base[k], h.base[k]) && eq(e.foliage[k], h.foliage[k]));
});
// (a client loads a node's files before it applies the ops: a few ticks)
const settle = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await tick(); };
await settle(() => same(A.c) && same(B.c));
check(same(A.c) && same(B.c), `A and B have the crater's ${nodesOf().length} node(s) as the host has them, cell for cell`);
check(opNotes > 0 && notOps === 0 && opBytes / opNotes < 200, `the crater crosses as its op: ${opNotes} note(s) of ${(opBytes / opNotes).toFixed(0)} bytes`);
check(C.c.edits.size === 0, 'C, 250 m off, is sent none of it');
const D = player('d', 44, 120), E = player('e', 46, 122, true);
all.push(D, E);
await settle(() => same(D.c) && same(E.c));
check(same(D.c), 'a player who joins after has them');
check(same(E.c), "one whose snapshots cross as JSON (the network host's) has them too");
C.c.send({ kind: 'view', view: { focus: { x: 70, z: 128 } } });
await settle(() => same(C.c));
check(same(C.c), 'C has them once it looks near');

// at B's body: it bursts there, B is still on foot where it was
await tick(50);
t0 = server.sim.tick;
fire(0, Math.atan2(8, 6));
await tick(30);
const hitB = of(A.c, t0, 'blast')[0]?.at;
check(hitB && Math.hypot(hitB.x - 48, hitB.z - 134) < 0.6 && hitB.y > G + 0.2 && hitB.y < G + 1.9,
  `a grenade at B bursts on B's body (${JSON.stringify(hitB)})`);
const bw = server.sim.players.get('b')?.walk?.pose;
check(B.c.seat()?.role === 'walker' && Math.hypot(bw.x - 48, bw.z - 134) < 1e-9, 'B is still on foot where it stood: nobody reacts to a hit');

// held for 9 s, a command every tick: at most one each 1.5 s
await tick(50);
t0 = server.sim.tick;
for (let i = 0; i < 9 / STEP; i++) { fire(0.6, 0); await tick(); }
const n = of(A.c, t0, 'launch').length, most = Math.floor(9 / 1.5) + 1;
check(n >= most - 2 && n <= most, `a held trigger launches ${n} grenades in 9 s (at most ${most})`);
check(weaponIn(2)?.id === 'launcher', 'the launcher is in slot 2');

// (many ops on the same nodes: each client applies them in the order the host did)
const opsOn = () => Math.max(...nodesOf().map(([tx, ty]) => live.get(tx, ty).ops.length));
await settle(() => all.every((p) => same(p.c)));
check(opsOn() > 3 && all.every((p) => same(p.c)), `after ${opsOn()} ops on a node every client has the craters' nodes as the host has them`);

// kept: everyone gone far off, for longer than the edits' keeping
await tick(Math.ceil(6 / STEP));
const before = nodesOf().length;
for (const p of all) { p.c.send({ kind: 'leaveSeat' }); p.c.send({ kind: 'view', view: { focus: { x: 50000, z: 50000 } } }); }
await tick(Math.ceil((PRESENCE.after + 5) / STEP));
check(before > 0 && nodesOf().length === before, `the craters' ${before} node(s) kept with nobody near for ${PRESENCE.after + 5} s`);

// the view (three.js in Node, no renderer): B sees A's grenade fly and burst, then nothing left of it
for (const p of [A, B]) p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x: p === A ? 40 : 48, y: G, z: p === A ? 128 : 134, h: 0, moving: false } } });
for (const p of all) p.c.send({ kind: 'view', view: { focus: { x: 44, z: 128 } } });
await tick(40);
const THREE = await imp('node_modules/three/build/three.module.js');
const { WeaponsView } = await imp('src/view/weapons/weapons-view.ts');
const { WEAPON_VIEWS } = await imp('src/view/weapons/index.ts');
const scene = new THREE.Scene(), v = new WeaponsView(scene, B.c);
const shown = () => { let k = 0; scene.traverse((o) => { if (o.visible && o.isMesh) k++; }); return k; };
v.update(1 / 30);
const idle = shown();
fire(0.3);
await tick(3); v.update(3 / 30);
const flying = shown();
let burst = 0;
for (let i = 0; i < 60; i++) { await tick(); v.update(1 / 30); burst = Math.max(burst, shown()); }
for (let i = 0; i < 60; i++) v.update(1 / 30);
check(flying > idle && burst > idle && shown() === idle, `the view draws the grenade in flight and its blast (${flying - idle}, ${burst - idle} things shown) and lets them go`);
// (a figure's hand: a gun is drawn only in one)
const hand = new THREE.Group(); scene.add(hand);
const guns = (arm) => { const before = shown(); v.update(0, arm === null ? [] : [{ player: 'x', pose: { x: 0, y: G, z: 0, h: 0 }, arm, hand }]); return shown() - before; };
const held = () => v.carried.get('x')?.weapon ?? null;
const g2 = guns(2), w2 = held(), g1 = guns(1), w1 = held(), g0 = guns(null);
check(g2 > 0 && w2 === 'launcher' && w1 === 'mg' && g0 === -g2 - g1 && held() === null,
  `an avatar carries the gun of the slot in its hand (${w2}: ${g2} parts, then ${w1}; none once it is gone)`);
const models = WEAPON_VIEWS.map((make) => make().model());
const shape = (m) => { const b = new THREE.Box3().setFromObject(m), s = b.getSize(new THREE.Vector3()); return `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}`; };
check(models.length >= 2 && models.every((m) => m.children.length > 0) && new Set(models.map(shape)).size === models.length,
  `each weapon has a model of its own (${models.map(shape).join(' / ')})`);

server.dispose();

// over a real WebSocket (host/ws.ts, client/sim-worker-link.ts SocketLink): A's crater in A's live edits and in those
// of a player who joins after it, cell for cell
{
  const { serve } = await imp('src/host/ws.ts');
  const { SocketLink } = await imp('src/client/sim-worker-link.ts');
  let step = null;
  const host = serve({ dir, host: '127.0.0.1', port: 0, query: 'interest=80', log: () => {}, clock: (t) => { step = t; return () => {}; } });
  const port = await host.port;
  const join = (x, z) => {
    const link = new SocketLink(`ws://127.0.0.1:${port}`), c = client(link, host.server.hello);
    c.send({ kind: 'view', view: { focus: { x, z } } });
    c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: Math.PI / 2, moving: false } } });
    return c;
  };
  const wait = () => new Promise((r) => setImmediate(r));
  const run = async (cs, n) => { for (let i = 0; i < n; i++) { for (const c of cs) c.update(STEP); step(); await wait(); } };
  const P = join(40, 128);
  await run([P], 20);
  const t = P.tick;
  P.send({ kind: 'fire', slot: 2, h: Math.PI / 2, pitch: 0.1 });
  let b = null;
  for (let i = 0; i < 120 && !b; i++) { await run([P], 1); b = P.eventsSince(t).find((e) => e.kind === 'blast'); }
  // (the client loads the node files before it applies the ops: ticks until they are in)
  const until = async (cs, ok) => { for (let i = 0; i < 3000 && !ok(); i++) await run(cs, 1); };
  await until([P], () => P.edits.size > 0);
  const L = join(44, 120);
  await until([P, L], () => L.edits.size >= P.edits.size);
  const a = b ? crater(P.edits, b.at) : { ok: false, text: 'no blast' }, l = b ? crater(L.edits, b.at) : a;
  const typed = (c) => [...c.edits.entries()].every(([, , n]) => n.base.runs instanceof Uint16Array && n.base.counts instanceof Uint16Array && n.base.ground instanceof Uint8Array);
  check(a.ok && l.ok && P.edits.size > 0 && L.edits.size === P.edits.size && typed(P) && typed(L), `over a WebSocket the shooter's crater (${a.text}) and a late joiner's (${l.text}) are whole`);
  host.close();
}

if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS weapon launcher');
process.exit(0);
