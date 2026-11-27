// The fuel tank as a player meets it: through the real host and a client over a link of a ~140 ms ping (as
// predict.mjs, predict-car.mjs) on a small synthetic world. A hovercraft burns little standing with its engine running
// and a full load's share under drive (the tuning's minutes), a combat plane flown flat out too; a helicopter flown on drains its tank and the page's gauge
// reads the host's tank all along. A helicopter whose tank runs dry while hovering sinks on the host and as its page
// predicts it (the copy run ahead loses its power too: no correction pulling it back down a round trip later), and its
// pilot can still get out. A car driven with the gas held whose tank runs dry rolls out on the host and on the page,
// its gauge at empty as the host's.
// usage (in web/): node tools/fuel.mjs [--log]; prints PASS lines, or FAIL and exit 1
import { imp, synthData } from './lib.mjs';

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
const { nodeHost, nodeTileCache } = await imp('src/host/node.ts');
const { OwnCar } = await imp('src/physics/rapier/own-car.ts');
const { LiveEdits } = await imp('src/core/live-edits.ts');
const { LEVELS, FUEL } = await imp('src/sim/tank.ts');

const log = process.argv.includes('--log');
const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const G = 10, FRAME = 1 / 60, UP = 0.06, DOWN = 0.06, JITTER = 0.015;
const jitter = (k) => ((k * 2654435761) % 1000) / 1000 * JITTER;
const settle = () => new Promise((r) => setImmediate(r));
// a tank's fill, its part of a step burnt counted
const fill = (tank) => (tank.level - tank.burnt) / LEVELS;

// ---------------------------------------------------------------- a craft

const { meta } = await makeWorld({ size: [256, 256], ground: () => G });
let reading = 0;
const tiles = () => new TileCache({ N: meta.tiles.N, load: (p) => (reading++, fetchGzip(`data/tiles/${p}`).finally(() => reading--)) });
const settleTiles = async () => { do await settle(); while (reading); };
const empty = () => ({ roads: [], peds: [], ctrls: [], trains: [] });

// a craft of type spawned at spot, flown with input till its tiles are in and the page runs it ahead; then frame(input)
// runs a frame of the simulated clock (the host's ticks, the link's delays)
async function fly(type, spot, input) {
  let t = 0, n = 0, ticks = 0, hostT = 0, nextTick = 0, lastUp = 0, lastDown = 0;
  const now = () => t * 1000;
  const sim = new WorldSim(empty(), { crafts: { meta, cache: tiles(), now } });
  const server = new SimServer(sim, sandbox(), null, { nodes: () => [], ready: async () => () => {} });
  server.interest = 400;
  const session = server.connect('a'), up = [], down = [];
  const link = {
    onHello() {}, onSnapshot() {},
    send(commands) { lastUp = Math.max(lastUp, t + UP + jitter(n)); up.push([lastUp, JSON.parse(JSON.stringify(commands))]); },
    close() {},
  };
  const client = new MirrorSimClient(link, empty(), null, hello(null), undefined, null, { meta, cache: tiles(), now });
  link.onHello(session.hello);
  const craft = new CraftLink({ sim: Promise.resolve(client), tiles: { meta, cache: tiles(), now }, nav: { stepOut: null } }, type);
  await null;
  client.send({ kind: 'view', view: { focus: { x: spot.x, z: spot.z } } });
  craft.open();
  craft.spawn(spot);
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
  const frame = (input) => {
    t = ++n * FRAME;
    hostTo();
    if (craft.craft) craft.input(input);
    client.update(FRAME);
    const c = craft.frame();
    return c ? structuredClone(c.core.drawn(craft.alpha)) : null;
  };
  for (let i = 0; i < 900; i++) {
    const d = frame(input);
    const host = [...sim.crafts.values()][0];
    if (d && i > 60 && host?.placed && host.collision.surface(host.core.pose.x, host.core.pose.z) !== null && client.prediction?.lag != null) break;
    await settleTiles();
  }
  const host = [...sim.crafts.values()][0];
  if (!host || !client.prediction?.core) throw new Error(`fuel: the ${type} never flew`);
  // (the gauge: the host's word on the craft as the page holds it)
  const gauge = () => client.crafts().find((c) => c.id === host.id)?.core.tank.share;
  return { sim, session, client, host, frame, gauge };
}

const NONE = { turn: 0, drive: 0, lift: 0, side: 0 }, DRIVE = { ...NONE, drive: 1 };

// a hovercraft: the engine running at rest, then driven
{
  const { host, frame } = await fly('hovercraft', { x: 128, y: G + 1, z: 40, h: 0 }, NONE);
  const rate = (input, frames) => { const a = fill(host.core.tank); for (let i = 0; i < frames; i++) frame(input); return (a - fill(host.core.tank)) / (frames * FRAME); };
  const idle = rate(NONE, 180), load = rate(DRIVE, 180), full = 1 / FUEL.hovercraft.full;
  check(Math.abs(load / full - 1) < 0.1 && idle < 0.2 * load && idle > 0,
    `a hovercraft burns ${(idle * 6000).toFixed(2)} % a minute idling, ${(load * 6000).toFixed(1)} % driven flat out (a full tank ${(1 / load / 60).toFixed(1)} min under load, the tuning's ${(FUEL.hovercraft.full / 60).toFixed(1)})`);
}

// a combat plane circling at full throttle: its engine spooled up, it burns a full load's share (the tuning's minutes)
{
  const FULL = { turn: 1, pitch: 0, throttle: 1 };
  const { host, frame } = await fly('fighter', { x: 200, y: G + 100, z: 128, h: 0, speed: 50 }, FULL);
  for (let i = 0; i < 90; i++) frame(FULL);
  const a = fill(host.core.tank);
  for (let i = 0; i < 240; i++) frame(FULL);
  const load = (a - fill(host.core.tank)) / (240 * FRAME), full = 1 / FUEL.fighter.full;
  check(Math.abs(load / full - 1) < 0.1 && host.core.flight.state === 'air',
    `a combat plane flown flat out burns ${(load * 6000).toFixed(1)} % a minute (a full tank ${(1 / load / 60).toFixed(1)} min, the tuning's ${(FUEL.fighter.full / 60).toFixed(1)})`);
}

// a helicopter flown on: its tank drains, the gauge reads the host's
{
  const { host, frame, gauge } = await fly('helicopter', { x: 128, y: G + 30, z: 40, h: 0 }, NONE);
  const a = host.core.tank.level;
  let off = 0;
  for (let i = 0; i < 480; i++) {
    frame(i < 420 ? DRIVE : NONE);
    // (the host's word a round trip old: one step behind at most)
    off = Math.max(off, Math.abs(gauge() - host.core.tank.share));
  }
  for (let i = 0; i < 30; i++) frame(NONE);
  const fell = a - host.core.tank.level, end = Math.abs(gauge() - host.core.tank.share);
  check(fell >= 4, `a helicopter flown 7 s drains its tank by ${fell} steps of ${LEVELS} (at least 4)`);
  check(off <= 1 / LEVELS + 1e-9 && end === 0, `the gauge reads the host's tank: ${(off * LEVELS).toFixed(0)} step off at most while it drains (a round trip behind), the same once it rests`);
}

// a helicopter running dry while it hovers: it sinks on the host and as its page predicts it; its pilot gets out
{
  const { sim, session, client, host, frame } = await fly('helicopter', { x: 128, y: G + 40, z: 40, h: 0 }, NONE);
  host.core.tank.level = 1;
  host.core.tank.burnt = 0.95;
  const y0 = host.core.pose.y, P = client.prediction;
  let fix = 0, dry = -1, drawnY = [];
  for (let i = 0; i < 240; i++) {
    const d = frame(NONE);
    if (dry < 0 && !host.core.tank.power) dry = i;
    for (const e of P.errs) if (e.since === 0 && dry >= 0 && i > dry + 30) fix = Math.max(fix, Math.abs(e.e.y ?? 0));
    drawnY.push(d.y);
  }
  const sank = y0 - host.core.pose.y, drew = drawnY[30] - drawnY.at(-1);
  if (log) console.log('dry at', dry, 'sank', sank, 'drew', drew, 'fix', fix);
  check(dry >= 0 && sank > 3, `a helicopter hovering whose tank runs dry sinks on the host (${sank.toFixed(1)} m in ${((240 - dry) * FRAME).toFixed(1)} s)`);
  check(!P.core.tank.power && drew > 3 && fix < 0.3, `and on its page: the copy run ahead has no power (sank ${drew.toFixed(1)} m drawn, corrected by ${fix.toFixed(2)} m at most once the host's word came, under 0.3)`);
  client.send({ kind: 'leaveSeat' });
  for (let i = 0; i < 30; i++) frame(NONE);
  check(sim.seat(session.player)?.role !== 'pilot', 'its pilot gets out of the empty helicopter');
}

// ---------------------------------------------------------------- a car

const { dir, data } = await synthData({ size: [256, 256], ground: () => G });
const PARKED = { kind: 'car', e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
  col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null };
{
  const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 400 }, structuredClone(data));
  const sim = server.sim, x = 128, z = 30;
  const car = { ...structuredClone(PARKED), id: 9001, geo: { px: x, py: z, cx: x, cy: z, z: G, fx: 0, fy: 1 }, detachedPose: { x, y: G, z, h: 0, pitch: 0, roll: 0 } };
  sim.traffic.detachedCars.push(car);
  const session = server.connect('a');
  let t = 0, n = 0, ticks = 0, hostT = 0, nextTick = 0, lastUp = 0, lastDown = 0;
  const up = [], down = [];
  const link = {
    onHello() {}, onSnapshot() {},
    send(commands) { lastUp = Math.max(lastUp, t + UP + jitter(n)); up.push([lastUp, JSON.parse(JSON.stringify(commands))]); },
    close() {},
  };
  const edits = new LiveEdits(), cache = nodeTileCache(dir, data.meta.tiles.N, edits);
  const client = new MirrorSimClient(link, structuredClone(data.traffic), null, server.hello, undefined, null, undefined,
    () => OwnCar.load(data.meta, cache, edits, { budgetChunks: 1000 }));
  link.onHello(server.hello);
  const P = client.carPrediction;
  const frame = (input) => {
    t = ++n * FRAME;
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
    if (input) client.send({ kind: 'seatInput', role: 'driver', input });
    client.update(FRAME);
    const c = client.traffic.detachedCars.find((c) => c.id === car.id);
    return c ? { ...client.traffic.bodies.pose(c, client.time.alpha, c.detachedPose) } : null;
  };
  client.send({ kind: 'view', view: { focus: { x, z } } });
  client.send({ kind: 'request', request: { kind: 'walk', pose: { x: x - 2, y: G, z, h: 0, moving: false } } });
  for (let i = 0; i < 20; i++) frame(null);
  const NO = { gas: 0, brake: 0, steer: 0, handbrake: false }, GAS = { ...NO, gas: 1 };
  let ready = 0;
  for (let i = 0; i < 3000 && ready < 60; i++) {
    if (i % 30 === 0 && sim.seat(session.player)?.role !== 'driver') client.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' });
    frame(sim.seat(session.player)?.role === 'driver' ? NO : null);
    ready = P.id === car.id && P.lag !== null && P.ticks.length > 3 && !P.still ? ready + 1 : 0;
    await settle();
  }
  if (ready < 60 || !car.tank) throw new Error('fuel: the page never ran the car ahead');
  const kmh = () => sim.driverSnapshot(session.player)?.kmh ?? 0;
  for (let i = 0; i < 90; i++) frame(GAS);
  car.tank.level = 1;
  car.tank.burnt = 0.9;
  const drawn = [], host = [];
  let top = 0, dry = -1;
  for (let i = 0; i < 300; i++) {
    drawn.push(frame(GAS));
    host.push({ ...car.detachedPose });
    top = Math.max(top, kmh());
    if (dry < 0 && !car.tank.power) dry = i;
  }
  const end = kmh(), step = (k) => Math.hypot(drawn[k].x - drawn[k - 1].x, drawn[k].z - drawn[k - 1].z) / FRAME * 3.6;
  const gauge = client.driver()?.body?.fuel;
  if (log) console.log('dry', dry, 'top', top, 'end', end, 'drawn', step(dry + 20), step(299));
  check(dry >= 0 && end < top - 3, `a car driven with the gas held whose tank runs dry rolls out on the host (${top.toFixed(0)} km/h, ${end.toFixed(0)} km/h ${((300 - dry) * FRAME).toFixed(1)} s later)`);
  check(step(299) < step(dry + 20) - 3 && Math.abs(step(299) - end) < 3 && gauge === 0 && car.tank.level === 0, `and as its page predicts it (drawn going ${step(dry + 20).toFixed(0)} then ${step(299).toFixed(0)} km/h, the host's ${end.toFixed(0)}), its gauge at empty (${gauge}) as the host's (${car.tank.level})`);
  server.dispose?.();
}

if (fail.length) process.exit(1);
process.exit(0);
