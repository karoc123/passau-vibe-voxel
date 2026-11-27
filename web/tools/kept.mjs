// The network host keeps what players left over a restart (src/host/world-store.ts), on a synthetic flat world with
// a fresh world directory: a player blasts a crater with the launcher, flies a hovercraft and walks off it, a parked
// car stands by; the host closes. A host started again (tools/serve.mjs, as ./voxel serve starts it) shows a new
// page the crater, the hovercraft and the car where they were; a second crater, then SIGTERM (as ./voxel stop): the
// next host has both. Craters made until a kill -9 at any moment: the next host reads every cell. A cell file of
// another format is set aside, a node whose files changed (a data rebuild) has its edits dropped, the rest read.
// usage (in web/): node tools/kept.mjs [-v]; prints PASS lines, or FAIL and exit 1
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imp, synthData } from './lib.mjs';

const verbose = process.argv.includes('-v');
const { serve } = await imp('src/host/ws.ts');
const { nodeTileCache } = await imp('src/host/node.ts');
const { LiveEdits } = await imp('src/core/live-edits.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { SocketLink } = await imp('src/client/sim-worker-link.ts');
const { hello } = await imp('src/sim/hello.ts'), { checkBuild } = await imp('src/core/data-contract.ts');
const { frameOf } = await imp('src/core/layers.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(`FAIL ${s}`));
const G = 5;
const { dir, data } = await synthData({ size: [512, 256], ground: () => G, boxes: [] });
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-world-'));
process.on('exit', () => fs.rmSync(world, { recursive: true, force: true }));
const mine = hello(checkBuild(data.meta, () => {})), frame = frameOf(data.meta);
const done = () => {
  for (const f of fail) console.log(f);
  process.exit(fail.length ? 1 : 0);
};

// a page on the host at port: its own edits over its own node files, its frames on the wall clock
const clients = [];
const page = (port) => {
  const link = new SocketLink(`ws://127.0.0.1:${port}`), edits = new LiveEdits();
  const c = new MirrorSimClient(link, structuredClone(data.traffic), null, mine, edits, { cache: nodeTileCache(dir, data.meta.tiles.N, edits), frame });
  c.link = link;
  clients.push(c);
  return c;
};
setInterval(() => { for (const c of clients) c.update(1 / 30); }, 1000 / 30).unref();
const until = async (ok, seconds = 10) => {
  for (const t0 = Date.now(); Date.now() - t0 < seconds * 1000; await new Promise((r) => setTimeout(r, 30))) if (ok()) return true;
  return ok();
};
const leave = (c) => { c.link.open = () => {}; c.link.ws.close(); clients.splice(clients.indexOf(c), 1); };
const walk = (c, x, z) => {
  c.send({ kind: 'view', view: { focus: { x, z } } });
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: 0, moving: false } } });
};
const nodes = (c) => [...c.edits.entries()].filter(([, , n]) => n?.ops?.length).map(([tx, ty, n]) => [`${tx}_${ty}`, n.ops.length]);
// a launcher shot (slot 2) from on foot at x, z into the ground ahead: the nodes the page then has edited
const blast = async (c, x, z) => {
  walk(c, x, z);
  await until(() => c.seat()?.role === 'walker', 5);
  const before = JSON.stringify(nodes(c));
  for (let i = 0; i < 90 && JSON.stringify(nodes(c)) === before; i++) {
    if (i % 30 === 0) c.send({ kind: 'fire', slot: 2, h: 0, pitch: -0.6 });
    await new Promise((r) => setTimeout(r, 33));
  }
  return JSON.stringify(nodes(c)) !== before;
};
const cells = () => fs.readdirSync(world).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(world, f), 'utf8')));
const near = (a, b, d = 0.5) => a && b && Math.hypot(a.x - b.x, a.z - b.z) < d;

// a host as ./voxel serve starts it, over the synthetic data; its log kept
const host = async () => {
  const p = spawn(process.execPath, ['tools/serve.mjs', '--port', '0', '--host', '127.0.0.1', '--world', world, 'seed=3'],
    { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, VOXEL_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const h = { p, log: '', exited: new Promise((r) => p.on('exit', (code, sig) => r(sig ?? code))) };
  const take = (b) => { h.log += b; if (verbose) process.stdout.write(String(b).replace(/^/gm, '  host: ')); };
  p.stdout.on('data', take);
  p.stderr.on('data', take);
  process.on('exit', () => p.kill('SIGKILL'));
  await until(() => /host on ws:\/\/[^:]+:(\d+)/.test(h.log) || p.exitCode !== null, 60);
  h.port = +(/host on ws:\/\/[^:]+:(\d+)/.exec(h.log)?.[1] ?? 0);
  return h;
};

// 1. the first host: a crater, a hovercraft left, a car parked; closed
const h1 = serve({ dir, host: '127.0.0.1', port: 0, query: 'seed=3', world: { dir: world }, log: (l) => { if (verbose) console.log(`  host: ${l}`); } });
const A = page(await h1.port);
await until(() => A.player, 10);
const crater1 = await blast(A, 100, 100) && nodes(A);
check(!!crater1, `a crater blasted (${JSON.stringify(crater1)})`);
const spot = { x: 160, y: G + SPAWN_HEIGHT.hovercraft, z: 100, h: 1 };
A.send({ kind: 'request', request: { kind: 'craft', type: 'hovercraft', spot } });
await until(() => A.craftOf(), 10);
walk(A, 150, 110);
await until(() => A.seat()?.role === 'walker' && A.crafts().some((c) => c.pilot === null), 10);
const car = { kind: 'car', id: 9001, e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
  col: '#3366aa', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null, geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 1 },
  detachedPose: { x: 120, y: G, z: 90, h: 0.5, pitch: 0, roll: 0 } };
h1.server.sim.traffic.detachedCars.push(car);
await until(() => A.traffic.detachedCars.length, 5);
leave(A);
await new Promise((r) => setTimeout(r, 300));
h1.close();
const kept = cells(), craft = kept.flatMap((c) => c.crafts ?? [])[0];
check(kept.length > 0 && craft?.type === 'hovercraft' && kept.some((c) => c.cars?.length) && kept.some((c) => Object.keys(c.nodes ?? {}).length),
  `the host's kept things on disk at close (${kept.length} cell file(s))`);
if (fail.length) done();

// 2. started again: a new page sees the crater, the hovercraft and the car where they were; a second crater; SIGTERM
let h = await host();
check(h.port > 0, 'a host started again on the world directory');
if (!h.port) { console.log(h.log); done(); }
let B = page(h.port);
walk(B, 100, 100);
// (a node may have more ops by then: shots after the ones counted)
const same = (c, want) => want.every(([k, n]) => nodes(c).some(([k2, n2]) => k2 === k && n2 >= n));
check(await until(() => same(B, crater1), 15), `a new page sees the crater's ${crater1.length} node(s) after the restart (${JSON.stringify(nodes(B))})`);
walk(B, 140, 100);
const seenCraft = () => B.crafts().find((c) => c.type === 'hovercraft' && c.pilot === null && c.placed);
check(await until(() => near(seenCraft()?.core.pose, craft), 10), `the hovercraft where it was left (${JSON.stringify(seenCraft()?.core.pose)} vs ${JSON.stringify(craft)})`);
const seenCar = () => B.traffic.detachedCars.find((c) => c.detachedPose && near(c.detachedPose, car.detachedPose, 0.1));
check(await until(() => seenCar(), 10) && seenCar().col === car.col, `the parked car where it stood (${JSON.stringify(B.traffic.detachedCars.map((c) => c.detachedPose))})`);
check(await blast(B, 300, 100), 'a second crater after the restart');
const crater2 = nodes(B);
h.p.kill('SIGTERM');
check(await h.exited === 0 && /stopped \(SIGTERM\)/.test(h.log), `the host stopped by SIGTERM writes before it exits (${await h.exited})`);
leave(B);

// 3. after SIGTERM: both craters; then craters until a kill -9
h = await host();
B = page(h.port);
walk(B, 300, 100);
check(await until(() => same(B, crater2), 15), `both craters after the SIGTERM (${crater2.length} node(s))`);
const keep = nodes(B);
let shots = 0;
for (const t0 = Date.now(); Date.now() - t0 < 6500;) if (await blast(B, 200 + 40 * (shots % 6), 60 + 60 * (shots++ % 2))) { /* (each a cell written) */ }
h.p.kill('SIGKILL');
await h.exited;
leave(B);
// (as if the kill had come between a cell's write and its rename)
fs.writeFileSync(path.join(world, '0_0.json.tmp'), '{"v":1,"at":1,"nodes":{"0_0":{"ha');
const parsed = fs.readdirSync(world).filter((f) => f.endsWith('.json')).every((f) => { try { JSON.parse(fs.readFileSync(path.join(world, f), 'utf8')); return true; } catch { return false; } });
check(parsed, `every cell file whole after a kill -9 among ${shots} shots`);

// 4. a cell of another format set aside; one node's files changed: its edits dropped, the rest read back
fs.writeFileSync(path.join(world, '7_7.json'), JSON.stringify({ v: 0, at: 1, nodes: {}, ops: [], cars: [], crafts: [] }));
const victim = crater1[0][0], file = fs.readdirSync(world).find((f) => f.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(world, f), 'utf8')).nodes?.[victim]);
const cell = JSON.parse(fs.readFileSync(path.join(world, file), 'utf8'));
cell.nodes[victim].hash = '0000000000000000';
fs.writeFileSync(path.join(world, file), JSON.stringify(cell));
h = await host();
check(h.port > 0 && !/set aside \(unreadable/.test(h.log), 'the host after the kill -9 starts and reads every cell');
check(/7_7\.json set aside \(format 0/.test(h.log) && fs.readdirSync(path.join(world, 'aside')).some((f) => f.endsWith('-7_7.json')) && !fs.existsSync(path.join(world, '7_7.json')),
  'a cell file of another format set aside, the host started');
check(new RegExp(`node ${victim}'s files changed`).test(h.log), `node ${victim} with changed files: its edits dropped with a log line`);
B = page(h.port);
walk(B, 100, 100);
const rest = keep.filter(([k]) => k !== victim);
check(await until(() => same(B, rest), 15) && !nodes(B).some(([k]) => k === victim),
  `the other ${rest.length} edited node(s) read back, ${victim} not (${JSON.stringify(nodes(B))})`);
walk(B, 140, 100);
check(await until(() => seenCraft() && seenCar(), 10), 'the hovercraft and the car still there');
h.p.kill('SIGTERM');
await h.exited;
done();
