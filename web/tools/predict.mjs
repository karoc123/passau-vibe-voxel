// The player's own craft answers its input at once over a slow network (prediction): through the real host (WorldSim,
// SimServer) and a client over a link that holds each message 60 to 75 ms each way (a ping of about 140 ms, seeded
// jitter, in order), on a small synthetic world, the shell's CraftLink flies a hovercraft, a helicopter, a drone and
// a jet. The pose drawn (the shell's core.drawn(alpha)) turns in the frame the stick is moved; it keeps to the path the
// host flies (its distance to the host's line of poses small, though the host is a round trip behind); in steady
// flight it moves on without a jump (each frame's step like the one before). The host's craft put a little aside, the
// drawn one eases over; put far aside, it is shown there at once. Over a jittery link (each message 40 to 200 ms, in
// order, so they bunch) a hovercraft and a helicopter flown by a scripted stick end where the same script ends over the
// steady link (the host takes each tick's input for its tick), and the page's corrections stay few and small. Driven
// at a parked car and at another player's hovercraft, a hovercraft drawn stops at it and is not pulled back out of it a
// round trip later; a floatplane flown low at a parked car is drawn crashing on it, the crash told at once and once.
// usage (in web/): node tools/predict.mjs [--log]; prints PASS lines, or FAIL and exit 1
import { imp } from './lib.mjs';

const { makeWorld } = await imp('checks/world.ts');
const { TileCache } = await imp('src/core/tile-cache.ts');
const { fetchGzip } = await imp('src/fetch.ts');
const { WorldSim } = await imp('src/sim/world-sim.ts');
const { SimServer } = await imp('src/sim/server/sim-server.ts');
const { sandbox } = await imp('src/sim/modes/sandbox.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { hello } = await imp('src/sim/hello.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { CraftLink } = await imp('src/nav/craft.ts');

const log = process.argv.includes('--log');
const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

const G = 10, { meta } = await makeWorld({ size: [256, 256], ground: () => G });
const tiles = () => new TileCache({ N: meta.tiles.N, load: (p) => fetchGzip(`data/tiles/${p}`) });
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const FRAME = 1 / 60, UP = 0.06, DOWN = 0.06, JITTER = 0.015;

// a seeded jitter (the same every run)
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rand = seeded(7);

// one craft flown: spawned at spot, `warm` frames with input a (its tiles in, the lag settled), then the script:
// [frames, input] in turn. The world's time is simulated: frames of 1/60 s, the host's ticks every STEP, each message
// on the link held its delay. Returns what was drawn each frame and the host's poses each tick.
// link0: each message's delay each way (s; default about 60-75 ms); corrections: each one the page's prediction makes
// pushed (the script's frame, its size)
async function fly(type, spot, script, hook = () => {}, link0 = {}) {
  const upDelay = link0.up ?? (() => UP + rand() * JITTER), downDelay = link0.down ?? (() => DOWN + rand() * JITTER);
  const sim = new WorldSim(traffic(), { crafts: { meta, cache: tiles(), now: () => performance.now() } });
  const server = new SimServer(sim, sandbox(), null, { nodes: () => [], ready: async () => () => {} });
  server.interest = 400;
  const session = server.connect('a'), cache = tiles();
  let t = 0, hostT = 0, nextTick = 0, lastUp = 0, lastDown = 0;
  const up = [], down = [];
  const link = {
    onHello() {}, onSnapshot() {},
    send(commands) { lastUp = Math.max(lastUp, t + upDelay()); up.push([lastUp, JSON.parse(JSON.stringify(commands))]); },
    close() {},
  };
  const client = new MirrorSimClient(link, traffic(), null, hello(null), undefined, null, { meta, cache, now: () => performance.now() });
  link.onHello(session.hello);
  const ctx = { sim: Promise.resolve(client), tiles: { meta, cache, now: () => performance.now() }, nav: { stepOut: null } };
  const craft = new CraftLink(ctx, type);
  await null;
  client.send({ kind: 'view', view: { focus: { x: spot.x, z: spot.z } } });
  craft.open();
  craft.spawn(spot);
  const host = [], drawn = [];
  // the host's side up to the time t: commands in as they arrive, a tick each STEP, its snapshot on its way back
  const hostTo = () => {
    while (hostT + 0.001 <= t) {
      hostT += 0.001;
      while (up.length && up[0][0] <= hostT) for (const c of up.shift()[1]) session.send(c);
      if (hostT >= nextTick) {
        nextTick += STEP;
        server.update(STEP);
        const c = [...sim.crafts.values()][0];
        if (c) host.push({ ...c.core.pose });
        lastDown = Math.max(lastDown, hostT + downDelay());
        down.push([lastDown, structuredClone(session.snapshot())]);
      }
      while (down.length && down[0][0] <= hostT) link.onSnapshot(down.shift()[1]);
    }
  };
  const frame = (input) => {
    t += FRAME;
    hostTo();
    if (craft.craft) craft.input(input);
    client.update(FRAME);
    for (const e of client.prediction?.errs ?? []) if (e.since === 0) link0.corrections?.push([drawn.length, most(e.e)]);
    const c = craft.frame();
    if (link0.events) for (const e of craft.events()) link0.events.push([drawn.length, e]);
    return c ? structuredClone(c.core.drawn(craft.alpha)) : null;
  };
  // in, and the tiles round it loaded (real time for their files)
  for (let i = 0; i < 600; i++) {
    const d = frame(script[0][1]);
    if (d && i > 30) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  for (const [n, input] of script) for (let i = 0; i < n; i++) { hook(drawn.length, sim, server); drawn.push(frame(input)); }
  return { drawn, host };
}

// a correction's largest part (m or rad)
const most = (e) => Math.max(0, ...Object.values(e).map((v) => (typeof v === 'number' ? Math.abs(v) : most(v))));

// a drawn pose's position and the angle the stick moves first
const pos = (d) => d.p ?? d.position ?? d;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angleOf = { h: (d) => d.h, bank: (d) => d.bank, att: (d) => d.attitude };
const turned = (a, b, k) => k === 'att' ? Math.hypot(a.attitude.x - b.attitude.x, a.attitude.y - b.attitude.y, a.attitude.z - b.attitude.z, a.attitude.w - b.attitude.w) : Math.abs(angleOf[k](a) - angleOf[k](b));
// a point's distance to the line through the host's poses
function offPath(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, l2 = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2)) : 0;
    best = Math.min(best, dist(p, { x: a.x + ab.x * u, y: a.y + ab.y * u, z: a.z + ab.z * u }));
  }
  return best;
}

const CASES = [
  { type: 'hovercraft', spot: { x: 128, y: G + 1, z: 40, h: 0 }, angle: 'h', still: { turn: 0, drive: 1, lift: 0, side: 0 }, stick: { turn: 1, drive: 1, lift: 0, side: 0 }, off: 0.15 },
  { type: 'helicopter', spot: { x: 128, y: G + 30, z: 40, h: 0 }, angle: 'h', still: { turn: 0, drive: 1, lift: 0, side: 0 }, stick: { turn: 1, drive: 1, lift: 0, side: 0 }, off: 0.15 },
  { type: 'drone', spot: { x: 128, y: G + 30, z: 80, h: 0 }, angle: 'att', still: { roll: 0, pitch: 0, yaw: 0, throttle: 0.5 }, stick: { roll: 0, pitch: 0, yaw: 1, throttle: 0.5 }, off: 0.15 },
  { type: 'jet', spot: { x: 128, y: G + 150, z: 20, h: 0, speed: 50 }, angle: 'bank', still: { turn: 0, pitch: 0, throttle: 0.6 }, stick: { turn: 1, pitch: 0, throttle: 0.6 }, off: 0.15 },
];

for (const K of CASES) {
  // (the last TAIL frames drawn ahead of the host's last pose: run, not judged)
  const STILL = 60, TURN = 60, F = STILL, TAIL = 30;
  const { drawn, host } = await fly(K.type, K.spot, [[STILL, K.still], [TURN, K.stick], [60, K.still], [TAIL, K.still]]);
  drawn.length -= TAIL;
  // the stick moved at frame F: the frame-to-frame turn before it, and in the frame of it and the one after
  let before = 0;
  for (let i = F - 20; i < F; i++) before = Math.max(before, turned(drawn[i], drawn[i - 1], K.angle));
  let at = -1;
  for (let i = F; i < F + 30 && at < 0; i++) if (turned(drawn[i], drawn[i - 1], K.angle) > before + 1e-4) at = i - F;
  check(at >= 0 && at <= 1, `${K.type}: the stick moved, the craft drawn turns ${at < 0 ? 'not within 30 frames' : `${at} frame(s) after`} (ping ${Math.round((UP + DOWN) * 1000)} ms)`);
  // the drawn pose on the host's path
  let off = 0, worst = -1;
  for (let i = 0; i < drawn.length; i++) { const o = offPath(pos(drawn[i]), host); if (o > off) { off = o; worst = i; } }
  check(off < K.off, `${K.type}: drawn within ${off.toFixed(3)} m of the host's path (worst at frame ${worst}; under ${K.off})`);
  // steady (the last 40 frames, no stick moved for a second): each frame's step like the one before
  let jump = 0;
  for (let i = drawn.length - 40; i < drawn.length; i++) {
    const a = pos(drawn[i - 2]), b = pos(drawn[i - 1]), c = pos(drawn[i]);
    jump = Math.max(jump, Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z));
  }
  check(jump < 0.01, `${K.type}: steady, no jump (each frame's step within ${(jump * 100).toFixed(2)} cm of the one before)`);
  if (log) for (let i = F - 3; i < F + 12; i++) console.log(i - F, JSON.stringify(pos(drawn[i])), K.angle === 'att' ? JSON.stringify(drawn[i].attitude) : angleOf[K.angle](drawn[i]));
}

// the host's craft put aside by a little (as a craft met would push it): the page's eased onto the host's path, no
// jump; by a lot (a reset): shown there at once
const H = CASES[0];
for (const [by, small] of [[1, true], [12, false]]) {
  const N = 60;
  const { drawn, host } = await fly(H.type, H.spot, [[2 * N, H.still], [30, H.still]], (i, sim) => {
    if (i === N) [...sim.crafts.values()][0].core.motion.p.x += by;
  });
  drawn.length -= 30;
  let jump = 0, step = 0;
  for (let i = N; i < drawn.length; i++) {
    const a = pos(drawn[i - 2]), b = pos(drawn[i - 1]), c = pos(drawn[i]);
    jump = Math.max(jump, Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z));
    step = Math.max(step, Math.abs(c.x - b.x));
  }
  let off = 0;
  for (let i = drawn.length - 20; i < drawn.length; i++) off = Math.max(off, offPath(pos(drawn[i]), host.slice(N / 2 + 5)));
  if (small) check(jump < 0.04 && off < 0.05, `the host's craft put ${by} m aside: the drawn one eased over (each frame's step within ${(jump * 100).toFixed(1)} cm of the one before), then on the host's path (${off.toFixed(3)} m)`);
  else check(step > by - 1 && off < 0.05, `put ${by} m aside: the drawn one there at once (a frame's step of ${step.toFixed(1)} m), on the host's path (${off.toFixed(3)} m)`);
}


// a scripted stick over a jittery link (40-200 ms each way, in order: they bunch) against the same over a steady one
// (60 ms): the host's craft ends in the same place, the page corrects seldom and little
{
  const r = seeded(Number(process.env.SEED ?? 11));
  const IN = 240;
  const script = (still, stick) => {
    // (hands off while it comes in: the frames that takes hang on the link's delay)
    const off = Object.fromEntries(Object.keys(still).map((k) => [k, 0]));
    const S = [[IN, off]];
    for (let i = 0; i < 12; i++) S.push([8 + Math.floor(r() * 30), i % 2 ? still : { ...stick, turn: r() < 0.5 ? 1 : -1 }]);
    // (then hands off till it stands: where it ends does not hang on when the host's timeline ends)
    return S.concat([[600, off]]);
  };
  for (const K of CASES.slice(0, 2)) {
    const S = script(K.still, K.stick), steady = [], all = [];
    const a = await fly(K.type, K.spot, S, () => {}, { up: () => 0.06, down: () => 0.06, corrections: steady });
    const jr = seeded(Number(process.env.SEED ?? 5));
    const b = await fly(K.type, K.spot, S, () => {}, { up: () => 0.04 + jr() * 0.16, down: () => 0.04 + jr() * 0.16, corrections: all });
    // (those once the stick moves: before, the craft settling where it was put down)
    const jittery = all.filter(([f]) => f >= IN).map(([, e]) => e);
    const lastA = a.host[a.host.length - 1], lastB = b.host[b.host.length - 1];
    // (across: how far a craft sinks before its pilot's first input hangs on the link's delay, not on the steering)
    const off = Math.hypot(lastA.x - lastB.x, lastA.z - lastB.z), dh = Math.abs(Math.atan2(Math.sin(lastA.h - lastB.h), Math.cos(lastA.h - lastB.h)));
    const big = jittery.filter((e) => e > 0.01);
    if (log) console.log(K.type, 'steady corrections', steady.length, 'jittery', jittery.length, Math.max(0, ...jittery).toFixed(3));
    check(off < 0.3 && dh < 0.01, `${K.type} over a jittery link (40-200 ms): the host's craft ends ${off.toFixed(2)} m, ${dh.toFixed(3)} rad across from the steady link's (under 0.3 m, 0.01 rad)`);
    check(big.length <= 2 && Math.max(0, ...jittery) < 0.05, `${K.type} over a jittery link, the stick moving: the page corrected ${jittery.length} times, ${big.length} over 1 cm (at most 2), the largest ${Math.max(0, ...jittery).toFixed(3)} (under 0.05)`);
  }
}

// the pilot runs the craft into a solid thing the page knows from its snapshots, AHEAD m before it (a car parked
// across its way, another player's hovercraft): the craft drawn stops at it (its bow into it no further than MEET_IN m),
// is not pulled back out of it a round trip later (no frame's step back over BACK m), and a crash shows within a few
// frames of the craft drawn reaching it
const PARKED = { kind: 'car', id: 9001, e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
  col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null, geo: { px: 0, py: 0, cx: 0, cy: 0, z: G, fx: 0, fy: 1 } };
const MEET_IN = 0.3, BACK = 0.05, FIX = 0.1, TELL = 3;
const MEETS = [
  { what: 'a hovercraft driven at a parked car', type: 'hovercraft', spot: { x: 128, y: G + 1, z: 40, h: 0 }, input: { turn: 0, drive: 1, lift: 0, side: 0 }, ahead: 25, thing: 'car' },
  { what: 'a hovercraft driven at another player\'s hovercraft', type: 'hovercraft', spot: { x: 128, y: G + 1, z: 40, h: 0 }, input: { turn: 0, drive: 1, lift: 0, side: 0 }, ahead: 25, thing: 'hovercraft' },
  { what: 'a floatplane flown low at a parked car', type: 'floatplane', spot: { x: 128, y: G + 1.7, z: 20, h: 0, speed: 45 }, input: { turn: 0, pitch: 0, throttle: 0.6 }, ahead: 60, thing: 'car', crash: true },
];
const { CRAFT_SHAPES, carShape } = await imp('src/sim/solids.ts');
for (const K of MEETS) {
  let side = Infinity;
  const events = [], fixes = [];
  const { drawn } = await fly(K.type, K.spot, [[K.crash ? 150 : 240, K.input]], (i, sim, server) => {
    if (i !== 0) return;
    const p = [...sim.crafts.values()][0].core.pose, z = p.z + K.ahead;
    if (K.thing === 'car') {
      sim.traffic.detachedCars.push({ ...structuredClone(PARKED), geo: { ...PARKED.geo, cx: p.x, cy: z }, detachedPose: { x: p.x, y: G, z, h: Math.PI / 2, pitch: 0, roll: 0 } });
      side = z - carShape(PARKED).hx;
    } else {
      const b = server.connect('b');
      b.send({ kind: 'request', request: { kind: 'craft', type: K.thing, spot: { x: p.x, y: G + 1, z, h: Math.PI / 2 } } });
      side = z - CRAFT_SHAPES[K.thing].hx;
    }
  }, { events, corrections: fixes });
  const nose = CRAFT_SHAPES[K.type].hz + (CRAFT_SHAPES[K.type].fwd ?? 0);
  // (judged till the crashed plane is put back elsewhere)
  let runIn = -Infinity, back = 0, reached = -1;
  for (let i = 1; i < drawn.length; i++) {
    const z = pos(drawn[i]).z + nose - side, step = pos(drawn[i - 1]).z - pos(drawn[i]).z;
    if (K.crash && step > 4) break;
    runIn = Math.max(runIn, z);
    if (reached < 0 && z > -0.05) reached = i;
    back = Math.max(back, step);
  }
  const told = events.filter(([, e]) => e.type === 'crash'), crash = told[0]?.[0] ?? -1;
  const fix = Math.max(0, ...fixes.filter(([f]) => f >= reached - 30).map(([, e]) => e));
  if (log) console.log(K.what, 'run-in', runIn.toFixed(2), 'back', back.toFixed(2), 'fix', fix.toFixed(2), 'reached', reached, events.map(([f, e]) => `${f}:${e.type ?? e.kind ?? e}`).join(' '));
  check(reached >= 0 && runIn < MEET_IN, `${K.what}: drawn into it ${Math.max(0, runIn).toFixed(2)} m at most (under ${MEET_IN}; ${reached < 0 ? 'never reached it' : `reached at frame ${reached}`})`);
  check(back < BACK && fix < FIX, `${K.what}: not pulled back out of it a round trip later (the page's largest correction ${fix.toFixed(2)} m, under ${FIX}; the largest step back in a frame ${back.toFixed(2)} m, under ${BACK})`);
  if (K.crash) check(crash >= 0 && Math.abs(crash - reached) <= TELL && told.length === 1,
    `${K.what}: the crash told ${crash < 0 ? 'never' : `${crash - reached} frame(s)`} from the frame it is drawn reaching the car (at most ${TELL}), once (${told.length})`);
}

if (fail.length) process.exit(1);
