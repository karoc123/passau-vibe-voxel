// The network host under a round's players at one spot: a real host (src/host/ws.ts) on its own clock in this thread,
// the players over real WebSockets from a worker thread (their own clock, so the host's thread is the host's alone),
// all by the cathedral: a third walking, a third driving cars of the traffic, a third firing the MG or the launcher
// into the houses round them (craters, bodies near them). What a player would notice: ticks over their 33 ms (the
// world stutters for everyone), fewer ticks than 30 a second (slow motion), and the bytes their socket is sent
// (deflated, as over the internet; a phone's line). A shared machine makes one run's tail noisy, so a run over the tick
// budget is run again (--runs, default 3) and the best judged; the bytes hardly depend on the machine. First one player
// alone fires at a road a while: its bytes must not grow with the craters (firing, below).
// usage (in web/): node tools/load.mjs [--players 16] [--seconds 10] [--runs 3] [--warm 5] [-v]; prints PASS with the
// numbers, or FAIL and what failed
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const { WebSocket } = await import('ws');
  const { port, plans, seconds } = workerData, STEP = 1 / 30;
  const socks = plans.map((p) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
    const s = { ws, p, open: false, t: 0 };
    ws.on('open', () => { s.open = true; });
    ws.on('error', () => {});
    return s;
  });
  const send = (s, commands) => { if (s.open) s.ws.send(JSON.stringify({ kind: 'commands', commands })); };
  // (the cars to drive come once the traffic has filled in round the players)
  parentPort.on('message', (cars) => { let i = 0; for (const s of socks) if (s.p.role === 'drive') s.p.car = cars[i++ % cars.length]; });
  let n = 0;
  const loop = setInterval(() => {
    n++;
    for (const s of socks) {
      if (!s.open) continue;
      const { p } = s, c = [];
      if (s.t++ === 0) {
        c.push({ kind: 'view', view: { focus: { x: p.x, z: p.z }, viewer: { x: p.x, y: p.y + 2, z: p.z } } });
        if (p.role !== 'drive') c.push({ kind: 'request', request: { kind: 'walk', pose: { x: p.x, y: p.y, z: p.z, h: p.h, moving: false } } });
      } else if (p.role === 'walk') {
        // back and forth along its path, 1.5 m/s
        const k = Math.floor(s.t / 20) % (2 * p.path.length - 2), i = k < p.path.length ? k : 2 * p.path.length - 2 - k;
        const q = p.path[i];
        c.push({ kind: 'seatInput', role: 'walker', input: { x: q.x, y: q.y, z: q.z, h: p.h, moving: true } });
        if (s.t % 30 === 0) c.push({ kind: 'view', view: { focus: { x: q.x, z: q.z }, viewer: { x: q.x, y: q.y + 2, z: q.z } } });
      } else if (p.role === 'drive') {
        if (p.car === undefined) continue;
        if (s.t % 30 === 0) c.push({ kind: 'enterSeat', entity: { kind: 'car', id: p.car }, role: 'driver' });
        c.push({ kind: 'seatInput', role: 'driver', input: { gas: 0.6, brake: 0, steer: Math.sin(s.t / 60) * 0.4, handbrake: false } });
      } else {
        // a held trigger: one each tick, the host keeps the weapon's rate; round the square, a little down
        const a = p.h + s.t * 0.05;
        c.push({ kind: 'fire', slot: p.slot, h: a, pitch: -0.05 - 0.05 * Math.sin(s.t / 7) });
      }
      send(s, c);
    }
    if (n * STEP > seconds) {
      clearInterval(loop);
      for (const s of socks) s.ws.close();
      parentPort.postMessage('done');
    }
  }, STEP * 1000);
} else {
  const { DATA, hasData, load } = await import('./real-city.mjs');
  if (!hasData()) { console.log(`SKIP load: no ${DATA}meta.json / traffic.json`); process.exit(0); }
  const args = process.argv.slice(2), verbose = args.includes('-v');
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
  const players = opt('players', 16), seconds = opt('seconds', 10), runs = opt('runs', 3), warm = opt('warm', 5);
  const { serve } = await load('host/ws.ts'), { clock } = await load('host/sim.worker.ts');
  const { readHostData } = await load('host/node.ts');
  const meta = readHostData(DATA).meta, spot = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };

  // The budgets. Ticks: p95 of the best run under the 33 ms tick (alone here ~15-19 at 16 players: a loaded machine has
  // margin), p99 under two ticks, at least RATE of the world's 30 ticks a second. Bytes per player, deflated: 50 kB/s
  // in any second, 20 on the mean (measured 2026-11-27 at 13-16 with 16 players; 23-26 while the bodies, the avatars
  // and the cars let go were sent whole every tick).
  const P95 = 33, P99 = 66, RATE = 0.9, MEAN_KB = 20, PEAK_KB = 50;

  async function run() {
    // (each tick's time: the sim's and the snapshots' with their sending, as the clock runs it)
    const ticks = [], sims = [];
    let measuring = false;
    const host = serve({ dir: DATA, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => { if (verbose) console.log(`  host: ${l}`); },
      clock: (tick) => clock(() => { const t0 = performance.now(); tick(); if (measuring) ticks.push(performance.now() - t0); }) });
    const update = host.server.update.bind(host.server);
    host.server.update = (dt) => { const t0 = performance.now(); update(dt); if (measuring) sims.push(performance.now() - t0); };
    const port = await host.port, sim = host.server.sim;
    const tiles = host.tiles;
    // wait for the ground by the cathedral and the road physics
    const ground = (x, z) => sim.traffic.ground?.support(x, z, 1000) ?? 0;
    for (const t0 = performance.now(); !(ground(spot.x, spot.y) > 0 && sim.physics); await new Promise((r) => setTimeout(r, 50)))
      if (performance.now() - t0 > 30000) throw new Error('no ground or road physics by the cathedral within 30 s');
    // a third walk, a third drive, a third fire (MG and launcher in turn)
    const plans = [];
    for (let i = 0; i < players; i++) {
      const a = (i / players) * 2 * Math.PI, x = spot.x + Math.cos(a) * 25, z = spot.y + Math.sin(a) * 25, h = a + Math.PI;
      const role = i % 3 === 0 ? 'walk' : i % 3 === 1 ? 'drive' : 'fire';
      const path = [];
      if (role === 'walk') for (let k = 0; k < 20; k++) { const px = x + Math.sin(h) * k, pz = z + Math.cos(h) * k; path.push({ x: px, y: ground(px, pz), z: pz }); }
      plans.push({ role, x, y: ground(x, z), z, h, path, slot: (i >> 1) % 2 ? 2 : 1 });
    }
    const w = new Worker(new URL(import.meta.url), { workerData: { port, plans, seconds: warm + seconds + 1 } });
    const done = new Promise((r) => w.on('message', r));
    await new Promise((r) => setTimeout(r, warm * 500));
    const at = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };
    const cars = sim.traffic.cars.filter((c) => !c.bus && c.v > 1 && (sim.traffic.carPose(c, c.s, c.off, at), Math.hypot(at.x - spot.x, at.z - spot.y) < 300));
    w.postMessage(cars.map((c) => c.id));
    await new Promise((r) => setTimeout(r, warm * 500));
    host.stats();
    const loads0 = tiles?.loads ?? 0, perSec = [];
    measuring = true;
    for (let s = 0; s < seconds; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = host.stats();
      perSec.push(st.wire.map(([, b]) => b / 1024 / Math.max(1, st.ticks * (1 / 30))));
    }
    measuring = false;
    const seats = host.stats().bytes.map(([p]) => sim.seat(p)?.role), crowd = sim.traffic.crowd ?? 1;
    const loads = (tiles?.loads ?? 0) - loads0, rss = process.memoryUsage().rss / 2 ** 20;
    await done;
    await w.terminate();
    host.close();
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
    const kb = perSec.flat(), mean = kb.reduce((a, b) => a + b, 0) / (kb.length || 1);
    return {
      crowd, ticks: ticks.length, p50: q(ticks, 0.5), p95: q(ticks, 0.95), p99: q(ticks, 0.99), over: ticks.filter((t) => t > 33.3).length,
      sim95: q(sims, 0.95), mean, peak: Math.max(0, ...kb), loads, rss, tilesHeld: tiles?.size ?? 0, seats: ['walker', 'driver'].map((r) => seats.filter((x) => x === r).length),
      roles: ['walk', 'drive', 'fire'].map((r) => plans.filter((p) => p.role === r).length),
    };
  }

  // One player alone by the cathedral firing the launcher and the MG in turn at a road FIRE s (craters; the traffic
  // near them gets bodies, queues before them): the bytes (before deflate) its socket was sent a second over the last
  // LAST s. A body at rest, a fade, a standing avatar, unchanged reads cost nothing: what a snapshot may carry is the
  // world round it (BASE) and the bodies moving (PER_MOVING each; before they were sent whole every tick, at rest or
  // not, the bytes climbed with every crater: 33 to 77 kB/s).
  const FIRE = 24, LAST = 8, BASE = 18, PER_MOVING = 6;
  async function firing() {
    const { default: WebSocket } = await import('ws');
    const host = serve({ dir: DATA, host: '127.0.0.1', port: 0, query: 'seed=3', log: () => {} });
    const port = await host.port, sim = host.server.sim, T = sim.traffic;
    const ground = (x, z) => T.ground?.support(x, z, 1000) ?? 0;
    for (const t0 = performance.now(); !(ground(spot.x, spot.y) > 0 && sim.physics); await new Promise((r) => setTimeout(r, 50)))
      if (performance.now() - t0 > 30000) throw new Error('no ground or road physics by the cathedral within 30 s');
    const x = spot.x + 25, z = spot.y, y = ground(x, z), at = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
    ws.on('error', () => {});
    await new Promise((r) => ws.on('open', r));
    const send = (commands) => ws.send(JSON.stringify({ kind: 'commands', commands }));
    send([{ kind: 'view', view: { focus: { x, z }, viewer: { x, y: y + 2, z } } }, { kind: 'request', request: { kind: 'walk', pose: { x, y, z, h: 0, moving: false } } }]);
    // (the road: where a car of the traffic 25..45 m off is, once the traffic has filled in round the player)
    await new Promise((r) => setTimeout(r, 2000));
    const road = T.cars.filter((c) => !c.bus).map((c) => (T.carPose(c, c.s, c.off, at), { ...at })).find((p) => Math.hypot(p.x - x, p.z - z) > 25 && Math.hypot(p.x - x, p.z - z) < 45);
    if (!road) throw new Error('no car of the traffic 25..45 m from the cathedral');
    const h = Math.atan2(road.x - x, road.z - z), pitch = Math.atan2(road.y - y - 1.7, Math.hypot(road.x - x, road.z - z));
    let t = 0;
    const loop = setInterval(() => { t++; send([{ kind: 'fire', slot: Math.floor(t / 60) % 2 ? 2 : 1, h: h + 0.05 * Math.sin(t / 5), pitch }]); }, 1000 / 30);
    const kb = [], moving = [];
    host.stats();
    for (let s = 0; s < FIRE; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = host.stats();
      kb.push((st.bytes[0]?.[1] ?? 0) / 1024 / Math.max(1, st.ticks / 30));
      let n = 0;
      for (const c of T.roadVehicles()) { const d = T.bodies?.drawState?.(c); if (d?.p0 && d.p1 && Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y, d.p1.z - d.p0.z) > 0.005) n++; }
      moving.push(n);
    }
    clearInterval(loop);
    ws.close();
    host.close();
    const mean = (a) => a.slice(-LAST).reduce((u, v) => u + v, 0) / LAST, m = mean(kb), n = mean(moving);
    return { kb: m, moving: n, budget: BASE + PER_MOVING * n, first: kb.slice(0, 3).map((v) => v.toFixed(1)).join(' '), shots: t };
  }
  const fired = await firing();
  console.log(`firing: one player ${fired.shots} ticks firing by the cathedral, ${fired.kb.toFixed(1)} kB/s (before deflate) over the last ${LAST} s with ${fired.moving.toFixed(1)} bodies moving (budget ${fired.budget.toFixed(1)}; the first seconds ${fired.first})`);

  const out = [];
  for (let i = 0; i < runs; i++) {
    const r = await run();
    out.push(r);
    const line = `run ${i + 1}: ${players} players (${r.roles[0]} walking, ${r.roles[1]} driving, ${r.roles[2]} firing; ${r.seats[0]} on foot and ${r.seats[1]} driving at the end), ticks p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)} p99 ${r.p99.toFixed(1)} ms (${r.over} of ${r.ticks} over 33; sim p95 ${r.sim95.toFixed(1)}), ` +
      `${r.mean.toFixed(1)} kB/s mean, ${r.peak.toFixed(1)} peak per player, ${r.loads} node loads in the window, ${r.tilesHeld} nodes in the cache, RSS ${r.rss.toFixed(0)} MB, crowd ${r.crowd.toFixed(2)}`;
    console.log(line);
    if (r.p95 < P95 && r.p99 < P99) break;
  }
  const best = out.reduce((a, b) => (b.p95 < a.p95 ? b : a)), fail = [];
  const want = out[0].roles, got = best.seats;
  if (got[0] < want[0] + want[2] || got[1] < want[1]) fail.push(`${got[0]} of ${want[0] + want[2]} players on foot, ${got[1]} of ${want[1]} driving at the end: the load is not the one meant`);
  if (best.ticks < RATE * 30 * seconds) fail.push(`${best.ticks} ticks in ${seconds} s, under ${RATE * 30} a second: the world in slow motion`);
  if (best.p95 >= P95) fail.push(`tick p95 ${best.p95.toFixed(1)} ms in the best of ${out.length} run(s), budget ${P95}: the world stutters for every player`);
  if (best.p99 >= P99) fail.push(`tick p99 ${best.p99.toFixed(1)} ms in the best of ${out.length} run(s), budget ${P99}`);
  const kbMean = Math.min(...out.map((r) => r.mean)), kbPeak = Math.min(...out.map((r) => r.peak));
  if (kbMean > MEAN_KB) fail.push(`${kbMean.toFixed(1)} kB/s mean per player, budget ${MEAN_KB}`);
  if (kbPeak > PEAK_KB) fail.push(`${kbPeak.toFixed(1)} kB/s peak per player in a second, budget ${PEAK_KB}`);
  if (fired.kb > fired.budget) fail.push(`one player firing: ${fired.kb.toFixed(1)} kB/s over the last ${LAST} s, budget ${fired.budget.toFixed(1)} (${BASE} and ${PER_MOVING} a body moving): what the client holds is sent again`);
  const sum = `${players} players by the cathedral: tick p95 ${best.p95.toFixed(1)} ms (budget ${P95}), p99 ${best.p99.toFixed(1)} (${P99}); ${kbMean.toFixed(1)} kB/s mean (${MEAN_KB}), ${kbPeak.toFixed(1)} peak (${PEAK_KB}) per player`;
  if (fail.length) { console.log(fail.map((f) => `  ${f}`).join('\n')); console.log(`FAIL load: ${sum}`); process.exit(1); }
  console.log(`PASS load: ${sum}`);
  process.exit(0);
}
