// Getting into a vehicle from foot, through the real host (host/node.ts nodeHost, SimServer sessions, a client per
// player over a CloneLink, so commands cross as JSON): on a synthetic flat world a helicopter left by its pilot is got
// into by a player on foot beside it; one 30 m off is refused as far; one beside it once it is taken is refused as taken; another player sees the
// walker's body gone while it pilots, and back beside the helicopter after it gets out, however far off the page asked
// to be put down. A paraglider let go of in the air glides down empty and lands with nothing told (only a pilot reads a
// craft's events). A walk asked for far over the crafts' ceiling, under the ground or at no number starts within the
// world's height or not at all. A parked camper is reached from off its nose by its real length, a motorbike not from
// as far. Then on the real data (when there): the same as the helicopter's for a car of the traffic, its seat taken
// with the road physics, and the car left parked with the walker beside it; a car going faster than a walk is refused
// as moving.
// usage (in web/): node tools/board.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';
import { DATA, hasData } from './real-city.mjs';

const { nodeHost, readHostData } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const BOARD = DEFAULT_TUNING.walk.board;

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const settle = () => new Promise((r) => setImmediate(r));

// a host's players: a client each, ticked together (each tick after one frame of commands)
function players(host, traffic) {
  const all = [];
  const add = (name) => {
    const link = sessionLink(host.connect(name)), c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
    const p = { c, link, name };
    all.push(p);
    return p;
  };
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) { for (const p of all) p.c.update(STEP); host.update(STEP); for (const p of all) p.link.deliver(); await settle(); }
  };
  return { add, tick };
}
const walk = (p, x, y, z, h = 0) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y, z, h, moving: false } } });
};
const avatarOf = (c, name) => c.traffic.avatars.find((a) => a.player === name);
// how far (m, across) a pose is from a footprint's sides (sim/walk-bounds.ts)
const { fromBox } = await imp('src/sim/walk-bounds.ts');
const { craftBox, carShape } = await imp('src/sim/solids.ts');
const { CEILING } = await imp('src/sim/craft/voxel-collision.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');
const { VEHICLES } = await imp('src/sim/vehicles.ts');

// the scenario on one vehicle: ref, its footprint now (box()), the seat's role; wait: ticks for a seat's answer
async function scenario(what, host, P, ref, role, box, wait = 2) {
  const { add, tick } = P;
  const near = add(`${what}-near`), far = add(`${what}-far`), late = add(`${what}-late`);
  const b0 = box();
  // (near: 1 m off its left side; far: 30 m; late: 1 m off its right side)
  const side = (d) => ({ x: b0.x + Math.cos(b0.h) * (b0.r + d), z: b0.z - Math.sin(b0.h) * (b0.r + d) });
  const n = side(1), f = side(30), l = side(-2 * b0.r - 1);
  walk(near, n.x, b0.y, n.z); walk(far, f.x, b0.y, f.z); walk(late, l.x, b0.y, l.z);
  await tick(3);
  check([near, far, late].every((p) => p.c.seat()?.role === 'walker'), `${what}: three players on foot round it`);

  far.c.send({ kind: 'enterSeat', entity: ref, role });
  await tick(wait);
  let r = far.c.results('enterSeat');
  check(r.length === 1 && !r[0].ok && r[0].reason === 'far' && far.c.seat()?.role === 'walker', `${what}: a player 30 m off is refused as far, still on foot (${JSON.stringify(r)})`);

  near.c.send({ kind: 'enterSeat', entity: ref, role });
  await tick(wait);
  r = near.c.results('enterSeat');
  const s = near.c.seat();
  check(r.some((x) => x.ok) && s?.role === role && s.entity.kind === ref.kind && s.entity.id === ref.id, `${what}: a player beside it gets the ${role}'s seat (${JSON.stringify(r)})`);
  check(!avatarOf(late.c, near.name) && !!avatarOf(late.c, far.name), `${what}: another page sees the walker gone into it`);

  late.c.send({ kind: 'enterSeat', entity: ref, role });
  await tick(wait);
  r = late.c.results('enterSeat');
  check(r.length === 1 && !r[0].ok && r[0].reason === 'taken' && late.c.seat()?.role === 'walker', `${what}: a player beside it once taken is refused as taken (${JSON.stringify(r)})`);

  await tick(10);
  const b1 = box();
  // (out onto foot asked 50 m away: the host puts the body down beside the vehicle)
  near.c.send({ kind: 'leaveSeat', pose: { x: b1.x + 50, y: b1.y, z: b1.z, h: 0, moving: false } });
  await tick(2);
  const a = avatarOf(late.c, near.name), b2 = box();
  const d = a ? fromBox(a.pose, b2) : Infinity;
  check(near.c.seat()?.role === 'walker' && near.c.seat()?.entity.kind === 'avatar' && d <= BOARD + 0.01 && d > BOARD - 0.5,
    `${what}: out on foot beside it (${d.toFixed(2)} m from its side, seen by another page), not where the page asked`);
  late.c.send({ kind: 'enterSeat', entity: ref, role });
  await tick(wait);
  check(host.sim.entities.exists(ref) && late.c.seat()?.role === role, `${what}: left in the world, its seat taken by the next player beside it`);
}

// a synthetic flat world, ground at y 5
{
  const G = 5;
  const { dir, data } = await synthData({ size: [384, 256], ground: () => G, boxes: [] });
  const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false } }, data);
  const traffic = () => ({ roads: [], peds: [], ctrls: [] }), P = players(host, traffic);
  const pilot = P.add('pilot');
  walk(pilot, 100, G, 100);
  await P.tick(3);
  pilot.c.send({ kind: 'request', request: { kind: 'craft', type: 'helicopter', spot: { x: 100, y: G + SPAWN_HEIGHT.helicopter, z: 100, h: 0.3 } } });
  await P.tick(30);
  const heli = pilot.c.craftOf();
  check(!!heli && heli.type === 'helicopter', 'a helicopter made, its maker its pilot');
  pilot.c.send({ kind: 'leaveSeat' });
  await P.tick(30);
  const id = heli.id, ref = { kind: 'craft', id };
  const box = () => craftBox('helicopter', host.sim.crafts.get(id).core.pose);
  await scenario('helicopter', host, P, ref, 'pilot', box);

  // (each tick's events gathered: the log keeps a few seconds)
  const glider = P.add('glider');
  walk(glider, 200, G, 60);
  await P.tick(3);
  glider.c.send({ kind: 'request', request: { kind: 'craft', type: 'paraglider', spot: { x: 200, y: G + 40, z: 60, h: 0 } } });
  await P.tick(10);
  const pg = glider.c.craftOf(), told = [];
  glider.c.send({ kind: 'leaveSeat' });
  let landed = false;
  // (on till a few ticks after it ended: its 'landed' comes the step it touches)
  for (let i = 0, after = 0; i < 1200 && after < 10; i++) {
    await P.tick(1);
    told.push(...host.sim.eventsSince(host.sim.tick - 1).filter((e) => e.kind === 'craft' && e.entity.id === pg?.id));
    landed = !!pg && !!host.sim.crafts.get(pg.id)?.core.ended;
    if (landed) after++;
  }
  check(!!pg && landed && told.length === 0, `a paraglider let go of in the air lands empty, nothing told (${JSON.stringify(told.map((e) => e.e))})`);

  // (asked by a player's own page: the start is its word)
  const top = data.meta.H + CEILING, jumper = P.add('jumper');
  // (straight to the host's session: a client checks its own commands are plain numbers, JSON turns NaN into null)
  const startAt = async (y) => {
    jumper.c.results('walk');
    jumper.link.send([{ kind: 'request', request: { kind: 'walk', pose: { x: 220, y, z: 60, h: 0, moving: false } } }]);
    await P.tick(2);
    return { ok: jumper.c.results('walk').some((r) => r.ok), y: avatarOf(jumper.c, 'jumper')?.pose.y };
  };
  let a = await startAt(1e7);
  check(a.ok && a.y <= top + 0.01 && a.y > top - 1, `a walk asked 10000 km up starts at the crafts' ceiling (${a.y})`);
  a = await startAt(-500);
  check(a.ok && Math.abs(a.y - G) < 0.01, `a walk asked 500 m under the ground starts on it (${a.y})`);
  a = await startAt(null);
  check(!a.ok && Math.abs(a.y - G) < 0.01, `a walk asked at no height is refused, the body where it was (${a.y})`);

  // (parked side by side, nose to +z; a walker that far off its nose, in its line)
  const park = (vt, x) => host.sim.traffic.parkAgain({ len: VEHICLES[vt].len, bus: false, vt, col: '#808080' }, { x, y: G, z: 160, h: 0, pitch: 0 });
  const camper = park('camper', 260), moto = park('moto', 280);
  const offNose = async (car, d, name) => {
    const p = P.add(name), hz = carShape(car).hz;
    walk(p, car.detachedPose.x, G, 160 + hz + d);
    await P.tick(3);
    p.c.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' });
    await P.tick(2);
    return p.c.results('enterSeat');
  };
  let r = await offNose(camper, BOARD - 0.4, 'camper');
  check(r.length === 1 && r[0].reason !== 'far', `a camper reached from ${(BOARD - 0.4).toFixed(1)} m off its nose (${carShape(camper).hz.toFixed(2)} m from its middle: ${JSON.stringify(r)})`);
  r = await offNose(moto, BOARD + 0.4, 'moto');
  check(r.length === 1 && r[0].reason === 'far', `a motorbike not reached from ${(BOARD + 0.4).toFixed(1)} m off its nose (${JSON.stringify(r)})`);
  // (a car's seat asked for starts the road physics loading: not disposed under it)
  for (let i = 0; i < 6000 && !host.sim.physics && !host.sim.physFailed; i++) await settle();
  host.dispose();
}

// a car of the traffic on the real data
if (!hasData()) console.log(`SKIP board car: no ${DATA}meta.json / traffic.json`);
else {
  const data = readHostData(DATA), raw = structuredClone(data.traffic);
  const host = nodeHost(DATA, { seed: 3, world: 'tiles', eager: true, physics: { bodies: true } }, { ...data, traffic: structuredClone(raw) });
  const spot = data.meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
  const traffic = () => structuredClone(raw), P = players(host, traffic);
  const watcher = P.add('watch');
  watcher.c.send({ kind: 'view', view: { focus: { x: spot.x, z: spot.y } } });
  await P.tick(30);
  for (let i = 0; i < 6000 && !host.sim.physics; i++) await settle();
  const T = host.sim.traffic;
  // (one standing, at a light or in a queue: the street life spawns its cars on the move)
  for (let i = 0; i < 60 && !T.cars.some((c) => !c.bus && c.v < 0.1); i++) await P.tick(10);
  const car = T.cars.filter((c) => !c.bus).sort((a, b) => a.v - b.v)[0];
  check(!!host.sim.physics && !!car, `the road physics in, a car to get into (${car?.v.toFixed(1)} m/s)`);
  const ref = { kind: 'car', id: car.id };
  const box = () => { const p = host.sim.entities.pose(ref), s = carShape(car); return { ...p, r: s.hx, l: s.hz }; };
  await scenario('car', host, P, ref, 'driver', box, 30);

  // (beside one going faster than a walk, 1 m off its side as the host has it; the walk and the seat asked together)
  const runner = P.add('runner');
  walk(runner, spot.x + 30, 0, spot.y);
  await P.tick(3);
  for (let i = 0; i < 60 && !T.cars.some((c) => !c.bus && c.v > 6); i++) await P.tick(5);
  const fast = T.cars.filter((c) => !c.bus).sort((a, b) => b.v - a.v)[0], p = host.sim.entities.pose({ kind: 'car', id: fast.id });
  const side = carShape(fast).hx + 1, v = fast.v;
  runner.c.send({ kind: 'request', request: { kind: 'walk', pose: { x: p.x + Math.cos(p.h) * side, y: p.y, z: p.z - Math.sin(p.h) * side, h: 0, moving: false } } });
  runner.c.send({ kind: 'enterSeat', entity: { kind: 'car', id: fast.id }, role: 'driver' });
  await P.tick(30);
  const r = runner.c.results('enterSeat');
  check(r.length === 1 && !r[0].ok && r[0].reason === 'moving' && runner.c.seat()?.role === 'walker',
    `a car going ${v.toFixed(1)} m/s is refused as moving, the walker beside it still on foot (${JSON.stringify(r)})`);
  host.dispose();
}

if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS board');
