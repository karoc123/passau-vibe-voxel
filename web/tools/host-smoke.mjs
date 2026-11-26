// The one host in Node (docs/adr/0009-layers-and-owners.md): the world sim started through
// src/host/node.ts (host/sim-host.ts hostSim with the file ports: the node files from disk, its ground and water from
// them as the worker's) on the real data, two sessions on it (the page's player and a second), FRAMES frames at 30 fps
// at a viewer by the cathedral, the first following a car, the second a person; a snapshot per session per frame.
// Run three times: twice driven directly (session.send, server.update, session.snapshot) and once through the Web
// Worker's message handler and its tick (src/host/sim.worker.ts handle, step: no clock here; its post a list), and every snapshot of every session must
// be the same in all three (the worker's minus its time). Then the road physics, the host's to load (no client asks
// for it): a car's seat asked for through the handler before it is in is refused as loading and starts its load (the
// physics port, the tiles port); asked again once it is in, taken (the player's driver in the snapshot), and a few
// frames run with it. A host started eager has it in without anyone asking.
// Then the hello (docs/adr/0009-layers-and-owners.md; sim/hello.ts): a MirrorSimClient over each transport (a
// CloneLink of a session this tool ticks; WorkerLink, its Worker a stand-in whose messages go
// through sim.worker.ts greet, handle and step) takes the host's hello when it matches its own, and refuses it (client.hello
// rejects naming what differs; the session left, no snapshot taken) when the protocol, the data build or the tuning
// differ; the tuning's hash is the same for a copy of the tuning with its keys in another order or another host-only
// number (the edits' keeping), another for one craft number. Then the host's own: the players it names
// (SimServer.connect: new ids), its start config read from a page's query (host/start.ts hostStart: the parameters,
// the defaults), and the worker's init carrying nothing but the page's query.
// usage (in web/): node tools/host-smoke.mjs [-v]; prints PASS with the counts, or FAIL
import crypto from 'node:crypto';
import { DATA, hasData, load } from './real-city.mjs';
import { sessionLink } from './lib.mjs';

if (!hasData()) { console.log(`SKIP host-smoke: no ${DATA}meta.json / traffic.json`); process.exit(0); }
const verbose = process.argv.includes('-v');
const FRAMES = 240, FPS = 30, P2 = 'p2';
const { nodeHost, readHostData, worldEdits: WE } = await load('host/node.ts');
const { handle, greet, step } = await load('host/sim.worker.ts');
const data = readHostData(DATA), raw = structuredClone(data.traffic);
const spot = data.meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const focus = { x: spot.x, z: spot.y };
const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
const tick = () => new Promise((r) => setImmediate(r)); // (the node files' loads come in between frames)

function start() {
  const server = nodeHost(DATA, { seed: 3, world: 'tiles', physics: { bodies: true } },
    { ...data, traffic: structuredClone(raw) });
  return { server, a: server.connect(), b: server.connect(P2) };
}
// the frame f's commands for each session (the first follows a car at 1 s, the second a person at 2 s)
function commands(server, f) {
  const T = server.sim.traffic;
  return {
    a: [VIEW, ...f === FPS && T.cars.length ? [{ kind: 'follow', entity: { kind: 'car', id: T.cars[0].id } }] : []],
    b: f === 2 * FPS && T.people.length ? [{ kind: 'follow', entity: { kind: 'person', id: T.people[0].id } }] : [],
  };
}
// the page's view (a command of the first session's player) and the world's time of frame f (the host's to set)
const VIEW = { kind: 'view', view: { focus, viewer: focus } };
const setTime = (server, f) => server.sim.setTime(17 + f / FPS / 600, 180);

async function direct() {
  const { server, a, b } = start(), out = [];
  for (let f = 0; f < FRAMES; f++) {
    const c = commands(server, f);
    for (const x of c.a) a.send(x);
    for (const x of c.b) b.send(x);
    setTime(server, f);
    server.update(1 / FPS);
    out.push(hash(a.snapshot()), hash(b.snapshot()));
    await tick();
  }
  return { out, server };
}

async function worker() {
  const { server, a, b } = start(), out = [], posted = [], post = (m) => posted.push(m);
  for (let f = 0; f < FRAMES; f++) {
    const c = commands(server, f);
    for (const x of c.b) b.send(x);
    setTime(server, f);
    handle(a, { kind: 'commands', commands: c.a });
    step(a, post);
    const m = posted.pop();
    if (m?.kind !== 'snapshot' || posted.length) throw new Error(`frame ${f}: posted ${JSON.stringify(m?.kind)} (${posted.length} more)`);
    const seen = server.sim.players.get(a.player)?.view?.focus;
    if (seen?.x !== focus.x || seen?.z !== focus.z) throw new Error(`frame ${f}: the view not taken`);
    out.push(hash(m.snapshot), hash(b.snapshot()));
    await tick();
  }
  // a car's seat before the road physics is in: refused as loading, its load started by the host (the physics port,
  // Rapier; its terrain warmed round the car through the tiles port); once in, the seat asked again is taken
  const car = server.sim.traffic.cars.find((c) => c.v > 1) ?? server.sim.traffic.cars[0];
  const seat = { kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' };
  const frame = (f, commands) => { setTime(server, f); handle(a, { kind: 'commands', commands: [VIEW, ...commands] }); step(a, post); };
  const t0 = performance.now();
  let f = FRAMES;
  frame(f++, [seat]);
  const early = [];
  for (let i = 0; i < 3; i++) { frame(f++, []); early.push(...posted.splice(0).flatMap((m) => m.snapshot.player?.results ?? [])); }
  if (early.length !== 1 || early[0].ok || early[0].reason !== 'loading' || server.sim.physics) throw new Error(`a car's seat while the road physics loads: ${JSON.stringify(early)}`);
  for (let i = 0; i < 6000 && !server.sim.physics; i++) await tick();
  if (!server.sim.physics) throw new Error('the road physics not loaded after a car\'s seat was asked for');
  const loadMs = performance.now() - t0;
  posted.length = 0;
  frame(f++, [seat]);
  for (let i = 1; i < FPS; i++) { frame(f++, []); await tick(); }
  if (posted.length !== FPS || posted.some((m) => m.kind !== 'snapshot')) throw new Error(`after the physics: ${posted.length} posts`);
  // (the player's reads come when they change: the last of them)
  const taken = posted.flatMap((m) => m.snapshot.player?.results ?? []), last = { ...posted.at(-1).snapshot, player: posted.findLast((m) => m.snapshot.player).snapshot.player };
  if (taken.length !== 1 || !taken[0].ok || last.player.seat?.role !== 'driver' || last.player.driver?.entityId !== car.id) throw new Error(`a car's seat once the road physics is in: ${JSON.stringify(taken)}, seat ${JSON.stringify(last.player.seat)}`);
  return { out, server, loadMs, last };
}

// a host started eager (the page's: host/start.ts) has the road physics in without a seat asked for
async function eager() {
  const server = nodeHost(DATA, { seed: 3, world: null, eager: true, physics: { bodies: false } }, { ...data, traffic: structuredClone(raw) });
  for (let i = 0; i < 6000 && !server.sim.physics; i++) await tick();
  const ok = !!server.sim.physics;
  server.dispose();
  return ok;
}

// An edit through the command path (A9), on a host of its own with edits allowed (no bodies: nothing loads the road
// physics): held until its nodes are in (not in the update right after it is sent), applied in the sim's next tick,
// its outcome to the sending session alone, carrying that tick; refused by a mode without mayEdit; after dispose, the
// host's listeners are gone (dropping the edit is no longer told to the sim; its tile world's too)
async function edits() {
  const { frameOf, mapToGrid, cellToAbsZ } = await load('core/layers.ts'), listened = WE.liveEdits['listeners'].size;
  const server = nodeHost(DATA, { seed: 3, world: 'tiles', edits: true, physics: { bodies: false } },
    { ...data, traffic: structuredClone(raw) });
  const a = server.connect(), b = server.connect(P2), sim = server.sim, T = sim.traffic, frame = frameOf(data.meta);
  let f = 0;
  const update = () => { a.send(VIEW); setTime(server, f++); server.update(1 / FPS); };
  const run = async (n) => { for (let i = 0; i < n; i++) { update(); await tick(); } };
  await run(FPS);
  T.ground.support(focus.x, focus.z, 1000); // (the node asked for: in by the next frame)
  await tick();
  const h = T.ground.support(focus.x, focus.z, 1000), [col, row] = mapToGrid(frame, Math.floor(focus.x), Math.floor(focus.z));
  const op = { kind: 'sphere', col, row, z: cellToAbsZ(frame, Math.floor(h)), r: 4, colour: 0 };
  const boxes = T.edits.length, sent = sim.tick;
  a.send({ kind: 'edit', op, ref: 1 });
  update();
  const early = T.edits.length !== boxes || a.results('edit').length;
  await tick();
  const before = sim.tick;
  await run(2);
  const ra = a.results('edit'), rb = b.results('edit'), out = [];
  if (early) out.push('the edit applied before its nodes were in');
  if (ra.length !== 1 || !ra[0].ok || ra[0].ref !== 1 || !ra[0].nodes?.length || ra[0].tick !== before) out.push(`the edit's outcome: ${JSON.stringify(ra)} (sent at tick ${sent}, the next tick run after its nodes were in: ${before})`);
  if (rb.length) out.push(`the other session read the edit's outcome: ${JSON.stringify(rb)}`);
  if (T.edits.length <= boxes) out.push('the sim not told of the edit');
  sim.mode = { id: 'test', request: () => false };
  a.send({ kind: 'edit', op, ref: 2 });
  await tick();
  await run(2);
  const no = a.results('edit');
  if (no.length !== 1 || no[0].ok || no[0].ref !== 2 || no[0].nodes) out.push(`a mode without mayEdit: ${JSON.stringify(no)}`);
  const n = T.edits.length;
  server.dispose();
  WE.dropAll();
  if (T.edits.length !== n || WE.liveEdits.size) out.push(`after dispose: the sim told of the edit dropped (${n} -> ${T.edits.length}), ${WE.liveEdits.size} left`);
  // (this host's listeners on the world's edits gone with it, its tile world's among them)
  const listening = WE.liveEdits['listeners'].size;
  if (listening !== listened) out.push(`after dispose: ${listening - listened} listener(s) of this host's on the world's edits left`);
  if (verbose) console.log(`  edit at ground ${h.toFixed(1)} m: ${ra[0]?.nodes?.length} node(s), applied in tick ${ra[0]?.tick} (sent at ${sent})`);
  return { out, nodes: ra[0]?.nodes?.length ?? 0, ticks: (ra[0]?.tick ?? sent) - sent };
}

const fail = [];
// (the hosts' listeners on the world's edits: each host's, its tile world's and, once loaded, its road physics'
// terrain's; all gone with dispose)
const listening = () => WE.liveEdits['listeners'].size, before = listening();
const r1 = await direct(), r2 = await direct(), w = await worker();
const T = r1.server.sim.traffic, sim = w.server.sim;
if (!sim.physics) fail.push('the road physics not attached');
for (const r of [r1, r2, w]) r.server.dispose();
if (listening() !== before) fail.push(`after dispose: ${listening() - before} listener(s) of the 3 hosts' on the world's edits left`);
if (sim.physics) fail.push('after dispose: the road physics still attached');
const ed = await edits();
fail.push(...ed.out);
if (!(await eager())) fail.push('an eager host: the road physics not loaded at its start');
const diff = (x, y, what) => {
  const i = x.out.findIndex((h, k) => h !== y.out[k]);
  if (i >= 0) fail.push(`${what}: frame ${i >> 1} session ${i & 1 ? P2 : 'p1'} differs`);
};
diff(r1, r2, 'run twice');
diff(r1, w, 'through the worker\'s handle');
if (!T.cars.length || !T.people.length) fail.push(`no traffic (${T.cars.length} cars, ${T.people.length} people)`);
if (w.last.player.id !== 'p1') fail.push(`the worker's snapshot names ${w.last.player.id}, not the host's first id p1`);
// the host names its players (SimServer.connect without an id: a new one no session holds)
{
  const ids = [r1.server.connect(), r1.server.connect()].map((s) => (s.leave(), s.player));
  if (ids.includes('p1') || ids.includes(P2) || ids[0] === ids[1]) fail.push(`connect: the host's new ids ${ids} (held: p1, ${P2})`);
}
// the host's start config from the page's URL (host/start.ts): the parameters as the page had them, the defaults
const { hostStart } = await load('host/start.ts'), { goldenHour, dayOfDate } = await load('sim/sun.ts');
{
  const now = new Date(2026, 10, 26, 9), s = hostStart('seed=7&mode=x&dig=1&lifephys=0&lpnear=50&lpmax=9&date=06-21&hour=13.5&active=600&every=2', now);
  const want = { seed: 7, mode: 'x', edits: true, eager: true, physics: { bodies: false, near: 50, maxBodies: 9 }, time: { day: 172, hour: 13.5 }, activeR: 600, every: 2 };
  if (JSON.stringify(s) !== JSON.stringify(want)) fail.push(`hostStart: ${JSON.stringify(s)}`);
  const d = hostStart('', now, () => 0.5), today = dayOfDate(2026, 10, 26);
  if (d.seed !== 2 ** 31 || d.mode !== undefined || d.edits || !d.eager || !d.physics.bodies || d.time.day !== today || d.time.hour !== goldenHour(today, 2026)) fail.push(`hostStart defaults: ${JSON.stringify(d)}`);
}

// the hello, through every transport
const { hello, tuningHash } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const { DEFAULT_TUNING } = await load('sim/tuning.ts');
const { MirrorSimClient, CloneLink } = await load('client/sim-client.ts');
const { WorkerLink } = await load('client/sim-worker-link.ts');
const host = r1.server, build = checkBuild(data.meta, () => {}), mine = hello(build);
if (!build) fail.push('hello: the data has no build (meta.json world)');
if (JSON.stringify(host.hello) !== JSON.stringify(mine)) fail.push(`hello: the host's ${JSON.stringify(host.hello)}, the client's ${JSON.stringify(mine)}`);
const reversed = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reversed(v)])) : o);
if (tuningHash(reversed(DEFAULT_TUNING)) !== mine.tuning) fail.push('hello: the tuning\'s hash depends on its keys\' order');
const heli = { ...DEFAULT_TUNING.craft.helicopter, accel: DEFAULT_TUNING.craft.helicopter.accel + 1 }, craft = { ...DEFAULT_TUNING.craft, helicopter: heli };
if (tuningHash({ ...DEFAULT_TUNING, craft }) === mine.tuning) fail.push('hello: the tuning\'s hash misses craft.helicopter.accel');
if (tuningHash({ ...DEFAULT_TUNING, edits: { ...DEFAULT_TUNING.edits, after: 1 } }) !== mine.tuning) fail.push('hello: the tuning\'s hash has the host\'s own edits keeping');
// (a stand-in for the Web Worker: its messages cloned and answered a turn later, through greet and handle)
globalThis.location ??= { href: 'http://localhost/' };
// (its clock: tick(), once a frame here)
let workerSession = null, workerTick = () => {}, terminated = 0;
globalThis.Worker = class {
  onmessage = null; onerror = null;
  postMessage(m) {
    const post = (x) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(x) }));
    m = structuredClone(m);
    if (m.kind === 'init' && (typeof m.query !== 'string' || Object.keys(m).length !== 3)) fail.push(`the worker's init carries more than the page's query: ${JSON.stringify(m)}`);
    if (m.kind === 'init') {
      const s = workerSession = host.connect('w');
      greet(s, post); post({ kind: 'ready' });
      workerTick = () => { if (!s.left) step(s, post); };
    } else handle(workerSession, m);
  }
  terminate() { terminated++; workerSession.left = true; workerSession?.leave(); }
};
// (each with the host's tick once a frame: the tool's own for the mirror, the stand-in worker's clock)
const transports = {
  mirror: (h) => { const s = host.connect('m'), l = sessionLink(s);
    return { client: new MirrorSimClient(new CloneLink(l), structuredClone(raw), null, h), session: s, run: () => { host.update(1 / FPS); l.deliver(); } }; },
  worker: (h) => { const client = new MirrorSimClient(new WorkerLink('seed=3'), structuredClone(raw), null, h);
    return { client, get session() { return workerSession; }, run: () => workerTick() }; },
};
const cases = [['matching', mine, null], ['protocol', { ...mine, protocol: mine.protocol + 1 }, 'protocol'],
  ['build', { ...mine, build: { ...build, buildId: `${build?.buildId}-other` } }, 'data build'], ['no build', { ...mine, build: null }, 'data build'],
  ['tuning', { ...mine, tuning: tuningHash({ ...DEFAULT_TUNING, craft }) }, 'tuning']];
let helloChecks = 0;
for (const [tn, make] of Object.entries(transports)) {
  for (const [cn, h, word] of cases) {
    const { client, session, run } = make(h), what = `hello ${tn} ${cn}`, before = terminated;
    let got = null;
    client.hello.then((x) => { got = { ok: x }; }, (e) => { got = { error: e }; });
    for (let f = 0; f < 3; f++) { client.update(1 / FPS); run(); for (let i = 0; i < 4; i++) await tick(); }
    helloChecks++;
    if (!got) { fail.push(`${what}: no hello taken`); continue; }
    if (!word) {
      if (got.error) fail.push(`${what}: refused: ${got.error.message}`);
      else if (JSON.stringify(got.ok) !== JSON.stringify(host.hello)) fail.push(`${what}: took ${JSON.stringify(got.ok)}`);
      else if (client.tick <= 0) fail.push(`${what}: no snapshot taken`);
      session.leave();
    } else {
      if (!got.error) fail.push(`${what}: taken, not refused`);
      else if (!got.error.message.includes(word)) fail.push(`${what}: refused for ${got.error.message}`);
      if (client.tick !== 0) fail.push(`${what}: a snapshot taken after the refusal`);
      if (tn === 'worker' && terminated !== before + 1) fail.push(`${what}: the worker not ended`);
      if (verbose && cn === 'protocol' && tn === 'worker') console.log(`  ${got.error?.message}`);
    }
  }
}
if (verbose) console.log(`  ${T.cars.length} cars, ${T.people.length} people, tick ${r1.server.sim.tick}; road physics loaded in ${w.loadMs.toFixed(0)} ms`);
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL host-smoke: ${fail.length} problem(s)`); process.exit(1); }
console.log(`PASS host-smoke: hostSim through host/node.ts, 2 sessions x ${FRAMES} frames, every snapshot alike run twice and through sim.worker.ts handle; a car's seat refused while the host loads the road physics, taken once it is in (${(w.loadMs / 1000).toFixed(1)} s), an eager host's loaded at its start; the hello taken or refused through 2 transports (${helloChecks} cases); an edit as a command: ${ed.nodes} node(s), applied ${ed.ticks} tick(s) after it was sent, its outcome its session's alone, refused by a mode without mayEdit, the host's listeners gone with dispose (its tile world's too; the road physics' too)`);
process.exit(0);
