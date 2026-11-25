// The one host in Node (docs/plans/architecture-review.md A12, gate G2): the world sim started through
// src/host/node.ts (host/sim-host.ts hostSim with the file ports: the node files from disk, its ground and water from
// them as the worker's) on the real data, two sessions on it (the page's player and a second), FRAMES frames at 30 fps
// at a viewer by the cathedral, the first following a car, the second a person; a snapshot per session per frame.
// Run three times: twice driven directly (session.send, server.update, session.snapshot) and once through the Web
// Worker's message handler (src/host/sim.worker.ts handle, its post a list), and every snapshot of every session must
// be the same in all three (the worker's minus its time). Then the road physics loaded through the handler
// (loadPhysics: the physics port, the tiles port; answered ok) and a few frames run with it.
// Then the hello (docs/plans/architecture-review.md A6; sim/hello.ts): a client of each transport (in-thread
// LocalSimClient; MirrorSimClient over CloneLink(ThreadLink); over WorkerLink, its Worker a stand-in whose messages go
// through sim.worker.ts greet and handle) takes the host's hello when it matches its own, and refuses it (client.hello
// rejects naming what differs; the session left, no snapshot taken) when the protocol, the data build or the tuning
// differ; the tuning's hash is the same for a copy of the tuning with its keys in another order or another host-only
// number (the edits' keeping), another for one craft number.
// usage (in web/): node tools/host-smoke.mjs [-v]; prints PASS with the counts, or FAIL
import crypto from 'node:crypto';
import { DATA, hasData, load } from './real-city.mjs';

if (!hasData()) { console.log(`SKIP host-smoke: no ${DATA}meta.json / traffic.json`); process.exit(0); }
const verbose = process.argv.includes('-v');
const FRAMES = 240, FPS = 30, P2 = 'p2';
const { nodeHost, readHostData, worldEdits: WE } = await load('host/node.ts'), { PAGE_PLAYER } = await load('host/sim-host.ts');
const { handle, greet } = await load('host/sim.worker.ts');
const data = readHostData(DATA), raw = structuredClone(data.traffic);
const spot = data.meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const focus = { x: spot.x, z: spot.y };
const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
const tick = () => new Promise((r) => setImmediate(r)); // (the node files' loads come in between frames)

function start() {
  const server = nodeHost(DATA, { seed: 3, world: 'tiles', physics: { bodies: true, at: () => focus } },
    { ...data, traffic: structuredClone(raw) });
  return { server, a: server.connect(PAGE_PLAYER), b: server.connect(P2) };
}
// the frame f's commands for each session (the first follows a car at 1 s, the second a person at 2 s)
function commands(server, f) {
  const T = server.sim.traffic;
  return {
    a: f === FPS && T.cars.length ? [{ kind: 'follow', entity: { kind: 'car', id: T.cars[0].id } }] : [],
    b: f === 2 * FPS && T.people.length ? [{ kind: 'follow', entity: { kind: 'person', id: T.people[0].id } }] : [],
  };
}
const input = (f) => ({ hour: 17 + f / FPS / 600, day: 180, focus, viewer: focus });

async function direct() {
  const { server, a, b } = start(), out = [];
  for (let f = 0; f < FRAMES; f++) {
    const c = commands(server, f);
    for (const x of c.a) a.send(x);
    for (const x of c.b) b.send(x);
    server.update(1 / FPS, input(f));
    out.push(hash(a.snapshot()), hash(b.snapshot()));
    await tick();
  }
  return { out, server };
}

async function worker() {
  const { server, a, b } = start(), out = [], posted = [], post = (m) => posted.push(m);
  let at = null;
  for (let f = 0; f < FRAMES; f++) {
    const c = commands(server, f);
    for (const x of c.b) b.send(x);
    handle(a, { kind: 'frame', dt: 1 / FPS, input: input(f), commands: c.a }, post, (p) => { at = p; });
    const m = posted.pop();
    if (m?.kind !== 'snapshot' || posted.length) throw new Error(`frame ${f}: posted ${JSON.stringify(m?.kind)} (${posted.length} more)`);
    if (at !== input(f).focus) throw new Error(`frame ${f}: the focus not handed on`);
    out.push(hash(m.snapshot), hash(b.snapshot()));
    await tick();
  }
  // the road physics through the handler: the physics port (Rapier), its terrain through the tiles port
  const t0 = performance.now();
  handle(a, { kind: 'loadPhysics', id: 7, warm: focus }, post);
  for (let i = 0; i < 6000 && !posted.length; i++) await tick();
  const ph = posted.pop();
  if (ph?.kind !== 'physics' || ph.id !== 7 || !ph.ok) throw new Error(`loadPhysics: ${JSON.stringify(ph)}`);
  const loadMs = performance.now() - t0;
  for (let f = FRAMES; f < FRAMES + FPS; f++) { handle(a, { kind: 'frame', dt: 1 / FPS, input: input(f), commands: [] }, post); await tick(); }
  if (posted.length !== FPS || posted.some((m) => m.kind !== 'snapshot')) throw new Error(`after the physics: ${posted.length} posts`);
  return { out, server, loadMs, last: posted.at(-1).snapshot };
}

// An edit through the command path (A9), on a host of its own with edits allowed (no bodies: nothing loads the road
// physics): held until its nodes are in (not in the update right after it is sent), applied in the sim's next tick,
// its outcome to the sending session alone, carrying that tick; refused by a mode without mayEdit; after dispose, the
// host's listener is gone (dropping the edit is no longer told to the sim)
async function edits() {
  const { frameOf, mapToGrid, cellToAbsZ } = await load('core/layers.ts');
  const server = nodeHost(DATA, { seed: 3, world: 'tiles', edits: true, physics: { bodies: false, at: () => focus } },
    { ...data, traffic: structuredClone(raw) });
  const a = server.connect(PAGE_PLAYER), b = server.connect(P2), sim = server.sim, T = sim.traffic, frame = frameOf(data.meta);
  let f = 0;
  const run = async (n) => { for (let i = 0; i < n; i++) { server.update(1 / FPS, input(f++)); await tick(); } };
  await run(FPS);
  T.ground.support(focus.x, focus.z, 1000); // (the node asked for: in by the next frame)
  await tick();
  const h = T.ground.support(focus.x, focus.z, 1000), [col, row] = mapToGrid(frame, Math.floor(focus.x), Math.floor(focus.z));
  const op = { kind: 'sphere', col, row, z: cellToAbsZ(frame, Math.floor(h)), r: 4, colour: 0 };
  const boxes = T.edits.length, sent = sim.tick;
  a.send({ kind: 'edit', op, ref: 1 });
  server.update(1 / FPS, input(f++));
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
  if (verbose) console.log(`  edit at ground ${h.toFixed(1)} m: ${ra[0]?.nodes?.length} node(s), applied in tick ${ra[0]?.tick} (sent at ${sent})`);
  return { out, nodes: ra[0]?.nodes?.length ?? 0, ticks: (ra[0]?.tick ?? sent) - sent };
}

const fail = [];
const r1 = await direct(), r2 = await direct(), w = await worker();
for (const r of [r1, r2, w]) r.server.dispose();
const ed = await edits();
fail.push(...ed.out);
const diff = (x, y, what) => {
  const i = x.out.findIndex((h, k) => h !== y.out[k]);
  if (i >= 0) fail.push(`${what}: frame ${i >> 1} session ${i & 1 ? P2 : PAGE_PLAYER} differs`);
};
diff(r1, r2, 'run twice');
diff(r1, w, 'through the worker\'s handle');
const T = r1.server.sim.traffic, sim = w.server.sim;
if (!T.cars.length || !T.people.length) fail.push(`no traffic (${T.cars.length} cars, ${T.people.length} people)`);
if (!sim.physics) fail.push('the road physics not attached');
if (w.last.player.id !== PAGE_PLAYER) fail.push(`the worker's snapshot names ${w.last.player.id}`);

// the hello, through every transport
const { hello, tuningHash } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const { DEFAULT_TUNING } = await load('sim/tuning.ts');
const { LocalSimClient, MirrorSimClient, ThreadLink, CloneLink } = await load('client/sim-client.ts');
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
let workerSession = null, terminated = 0;
globalThis.Worker = class {
  onmessage = null; onerror = null;
  postMessage(m) {
    const post = (x) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(x) }));
    m = structuredClone(m);
    if (m.kind === 'init') { workerSession = host.connect('w'); greet(workerSession, post); post({ kind: 'ready' }); } else handle(workerSession, m, post);
  }
  terminate() { terminated++; workerSession?.leave(); }
};
const transports = {
  local: (h) => { const s = host.connect('l'); return { client: new LocalSimClient(s, h), session: s }; },
  mirror: (h) => { const s = host.connect('m'); return { client: new MirrorSimClient(new CloneLink(new ThreadLink(s)), structuredClone(raw), null, h), session: s }; },
  worker: (h) => { const client = new MirrorSimClient(new WorkerLink({ seed: 3, physics: { bodies: false }, eager: false, edits: false }), structuredClone(raw), null, h);
    return { client, get session() { return workerSession; } }; },
};
const cases = [['matching', mine, null], ['protocol', { ...mine, protocol: mine.protocol + 1 }, 'protocol'],
  ['build', { ...mine, build: { ...build, buildId: `${build?.buildId}-other` } }, 'data build'], ['no build', { ...mine, build: null }, 'data build'],
  ['tuning', { ...mine, tuning: tuningHash({ ...DEFAULT_TUNING, craft }) }, 'tuning']];
let helloChecks = 0;
for (const [tn, make] of Object.entries(transports)) {
  for (const [cn, h, word] of cases) {
    const { client, session } = make(h), what = `hello ${tn} ${cn}`, before = terminated;
    let got = null;
    client.hello.then((x) => { got = { ok: x }; }, (e) => { got = { error: e }; });
    for (let f = 0; f < 3; f++) { client.update(1 / FPS, input(f)); for (let i = 0; i < 4; i++) await tick(); }
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
      if (tn !== 'local' && client.tick !== 0) fail.push(`${what}: a snapshot taken after the refusal`);
      if (tn === 'worker' && terminated !== before + 1) fail.push(`${what}: the worker not ended`);
      if (verbose && cn === 'protocol' && tn === 'worker') console.log(`  ${got.error?.message}`);
    }
  }
}
if (verbose) console.log(`  ${T.cars.length} cars, ${T.people.length} people, tick ${r1.server.sim.tick}; road physics loaded in ${w.loadMs.toFixed(0)} ms`);
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL host-smoke: ${fail.length} problem(s)`); process.exit(1); }
console.log(`PASS host-smoke: hostSim through host/node.ts, 2 sessions x ${FRAMES} frames, every snapshot alike run twice and through sim.worker.ts handle; the road physics loaded through it (${(w.loadMs / 1000).toFixed(1)} s); the hello taken or refused through 3 transports (${helloChecks} cases); an edit as a command: ${ed.nodes} node(s), applied ${ed.ticks} tick(s) after it was sent, its outcome its session's alone, refused by a mode without mayEdit, the host's listener gone with dispose`);
process.exit(0);
