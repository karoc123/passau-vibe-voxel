// The driver's own car answers at once over a slow network (client/predict-car.ts): through the real host (host/node.ts,
// its road physics) on a small synthetic world and a client over a link that holds each message 60 to 75 ms each way
// (a ping of about 140 ms, seeded jitter, in order), a player drives a parked car. The car drawn answers the steering,
// the gas and the brake in the frame they are given (against the same drive without them, frame by frame; the host's
// car a round trip later); after a drive, a turn and a brake to a stop it stands where the host's stands, drawn near
// the host's path all along with few small corrections; driven into a bus parked across its way (in the host's world
// only: the page's has the terrain alone) it is drawn eased back to where the host has it, no frame's step a jump.
// The world's time is simulated (frames of 1/60 s, the host's ticks every STEP, each message held its delay) and
// every wait is for a state, so it runs alike on a busy machine.
// usage (in web/): node tools/predict-car.mjs [--log]; prints PASS lines, or FAIL and exit 1
import { imp, synthData } from './lib.mjs';

const { nodeHost, nodeTileCache } = await imp('src/host/node.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { OwnCar } = await imp('src/physics/rapier/own-car.ts');
const { LiveEdits } = await imp('src/core/live-edits.ts');
const { STEP } = await imp('src/sim/road-net.ts');

const log = process.argv.includes('--log');
const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const G = 10, FRAME = 1 / 60, UP = 0.06, DOWN = 0.06, JITTER = 0.015;
const { dir, data } = await synthData({ size: [256, 256], ground: () => G });
// each message's jitter by the frame or tick it is sent in: the same in every drive however long its start took
const jitter = (k) => ((k * 2654435761) % 1000) / 1000 * JITTER;
const settle = () => new Promise((r) => setImmediate(r));

// a car parked at (x, z) heading h (0: +z)
const PARKED = { kind: 'car', e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
  col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null };
const parked = (id, x, z, h) => ({ ...structuredClone(PARKED), id, geo: { px: x, py: z, cx: x, cy: z, z: G, fx: Math.sin(h), fy: Math.cos(h) }, detachedPose: { x, y: G, z, h, pitch: 0, roll: 0 } });

// one drive: a car parked at (128, 40) heading +z taken, the host's ticks and the link's delays run on the simulated
// clock till the page runs it ahead, then the script ([frames, input] in turn). Returns the pose drawn each frame,
// the host's car's each frame, the page's corrections (frame, size) and its prediction. more: other cars parked
async function drive(script, more = []) {
  const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 400 }, structuredClone(data));
  const sim = server.sim, T = sim.traffic, car = parked(9001, 128, 40, 0);
  T.detachedCars.push(car, ...more);
  const session = server.connect('a');
  let t = 0, n = 0, ticks = 0, hostT = 0, nextTick = 0, lastUp = 0, lastDown = 0;
  const up = [], down = [];
  const link = {
    onHello() {}, onSnapshot() {},
    send(commands) { lastUp = Math.max(lastUp, t + UP + jitter(n)); up.push([lastUp, JSON.parse(JSON.stringify(commands))]); },
    close() {},
  };
  const edits = new LiveEdits(), cache = nodeTileCache(dir, data.meta.tiles.N, edits);
  // (the chunks round the car built at once: the same ones whatever the machine's speed)
  const client = new MirrorSimClient(link, structuredClone(data.traffic), null, server.hello, undefined, null, undefined,
    () => OwnCar.load(data.meta, cache, edits, { budgetChunks: 1000 }));
  link.onHello(server.hello);
  const P = client.carPrediction;
  const hostTo = () => {
    while (hostT + 0.001 <= t) {
      hostT += 0.001;
      while (up.length && up[0][0] <= hostT) for (const c of up.shift()[1]) session.send(c);
      if (hostT >= nextTick) {
        nextTick += STEP;
        server.update(STEP);
        lastDown = Math.max(lastDown, hostT + DOWN + jitter(++ticks));
        down.push([lastDown, structuredClone(session.snapshot())]);
      }
      while (down.length && down[0][0] <= hostT) link.onSnapshot(down.shift()[1]);
    }
  };
  const drawn = [], host = [], fixes = [];
  const frame = (input) => {
    t = ++n * FRAME;
    hostTo();
    if (input) client.send({ kind: 'seatInput', role: 'driver', input });
    client.update(FRAME);
    for (const e of P.errs) if (e.since === 0) fixes.push([drawn.length, Math.hypot(e.e.x, e.e.z)]);
    const c = client.traffic.detachedCars.find((c) => c.id === car.id);
    return c ? { ...client.traffic.bodies.pose(c, client.time.alpha, c.detachedPose) } : null;
  };
  client.send({ kind: 'view', view: { focus: { x: 128, z: 40 } } });
  client.send({ kind: 'request', request: { kind: 'walk', pose: { x: 126, y: G, z: 40, h: 0, moving: false } } });
  for (let i = 0; i < 20; i++) frame(null);
  const NONE = { gas: 0, brake: 0, steer: 0, handbrake: false };
  // the wheel asked for till taken (refused while the road physics loads), then hands off till the page runs it ahead
  // with the lag known (its tiles and Rapier in)
  // (then come to rest, and on to a whole second of frames: the drives that follow start alike)
  let ready = 0;
  for (let i = 0; i < 3000 && (ready < 60 || n % 60); i++) {
    if (i % 30 === 0 && sim.seat(session.player)?.role !== 'driver') client.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' });
    frame(sim.seat(session.player)?.role === 'driver' ? NONE : null);
    ready = P.id === car.id && P.lag !== null && P.ticks.length > 3 && !P.still ? ready + 1 : 0;
    await settle();
  }
  if (ready < 60) throw new Error('predict-car: the page never ran the car ahead');
  for (const [n, input] of script) for (let i = 0; i < n; i++) {
    drawn.push(frame(input));
    host.push({ ...car.detachedPose });
  }
  server.dispose?.();
  return { drawn, host, fixes, P };
}

const NONE = { gas: 0, brake: 0, steer: 0, handbrake: false }, GAS = { ...NONE, gas: 1 }, HOLD = { ...NONE, handbrake: true };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const apart = (a, b) => Math.max(dist(a, b), Math.abs(a.h - b.h));
// a point's distance to the line through the host's poses
function offPath(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], abx = b.x - a.x, abz = b.z - a.z, l2 = abx ** 2 + abz ** 2;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - abx * u, p.z - a.z - abz * u));
  }
  return best;
}

// the same drive with and without the steering, the brake, or the gas let go at frame F: the frame the drawn car
// first differs, and the host's
const F = 90, ROLL = 60;
const base = await drive([[F, GAS], [ROLL, GAS]]);
for (const [what, input] of [['steering', { ...GAS, steer: 1 }], ['brake', { ...NONE, brake: 1 }], ['gas let go', NONE]]) {
  const run = await drive([[F, GAS], [ROLL, input]]);
  const first = (a, b) => { for (let i = 0; i < a.length; i++) if (apart(a[i], b[i]) > 1e-5) return i; return Infinity; };
  const page = first(run.drawn, base.drawn), host = first(run.host, base.host);
  if (log) console.log(what, "first", page, JSON.stringify(run.drawn[page]), JSON.stringify(base.drawn[page]));
  if (log) for (let i = F - 2; i < F + 4; i++) console.log(what, i - F, apart(run.drawn[i], base.drawn[i]).toExponential(2));
  check(page >= F && page <= F + 1, `${what}: the car drawn answers ${page - F} frame(s) after (the host's ${host === Infinity ? 'never' : host - F} frames after, at a ping of ~${Math.round((UP + DOWN) * 1000)} ms)`);
}

// gas, a turn, the brake to a stop: drawn near the host's path, few small corrections, standing where the host's stands
{
  const { drawn, host, fixes, P } = await drive([[90, GAS], [60, { ...GAS, steer: 1 }], [40, GAS], [90, { ...NONE, brake: 1 }], [90, HOLD]]);
  let off = 0;
  for (let i = 30; i < drawn.length; i++) off = Math.max(off, offPath(drawn[i], host));
  const end = dist(drawn.at(-1), host.at(-1)), dh = Math.abs(drawn.at(-1).h - host.at(-1).h), big = fixes.filter(([, e]) => e > 0.05);
  if (log) console.log('fixes', JSON.stringify(fixes.map(([f, e]) => [f, +e.toFixed(3)])), P.stats);
  check(end < 0.05 && dh < 0.01, `after a drive, a turn and a brake to a stop the car drawn stands ${end.toFixed(3)} m, ${dh.toFixed(4)} rad from the host's (under 0.05 m, 0.01 rad)`);
  check(off < 0.15 && big.length <= 2, `and was drawn within ${off.toFixed(3)} m of the host's path (under 0.15), corrected ${fixes.length} times, ${big.length} over 5 cm (at most 2; ${P.stats.same} snapshots as the page had it, ${P.stats.replays} stepped again from)`);
}

// driven into a bus parked across its way 20 m ahead (the host's world has it, the page's not): eased back, no jump
{
  const wall = { ...parked(9002, 128, 60, Math.PI / 2), bus: true, len: 12 };
  const { drawn, host, fixes } = await drive([[180, GAS], [120, HOLD]], [wall]);
  let ahead = 0, jerk = 0, back = 0;
  for (let i = 1; i < drawn.length; i++) {
    const step = drawn[i].z - drawn[i - 1].z;
    ahead = Math.max(ahead, step);
    jerk = Math.max(jerk, -step);
  }
  const met = Math.min(...host.map((p) => 60 - p.z));
  for (const [, e] of fixes) back = Math.max(back, e);
  const end = dist(drawn.at(-1), host.at(-1));
  if (log) for (let i = 0; i < drawn.length; i += 10) console.log(i, drawn[i].z.toFixed(3), host[i].z.toFixed(3), host[i].x.toFixed(3), host[i].y.toFixed(3), host[i].h.toFixed(3));
  if (log) console.log('met', met.toFixed(2), 'back', back.toFixed(2), 'jerk', jerk.toFixed(3), 'end', end.toFixed(3));
  check(met < 4 && back > 0.1, `driven into a bus parked across its way, the host's car stops at it (${met.toFixed(2)} m from its middle) and the page's is corrected (by ${back.toFixed(2)} m at most)`);
  check(jerk < ahead && end < 0.05, `the correction eased in (the car drawn back by ${(jerk * 100).toFixed(1)} cm in a frame at most: slower than it came, ${(ahead * 100).toFixed(1)} cm a frame at its fastest), ending ${end.toFixed(3)} m from the host's (under 0.05)`);
}

if (fail.length) process.exit(1);
process.exit(0);
