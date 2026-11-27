// Placed vehicles (sim/stands.ts), through the real host (host/node.ts nodeHost, a client per player over a CloneLink).
// On a synthetic world (a flat field, a river with banks, a cliff over it, a rough far end with no room for anything):
// a player on foot finds a helicopter, speedboat, hovercraft, floatplane, combat plane and paraglider stocked near them, each sent
// once and then not again while it stands; a player 1.35 km off is sent none, and none is stocked near them. The
// helicopter is boarded, flown off and left: it stays, and its stand refills out of the player's sight; a second
// player rides along in the speedboat beside its pilot, a third finds its seat taken; the paraglider's pilot is
// launched off its cliff. With every player gone far, the untouched vehicles go at once and the used ones once the
// keeping has run out. On the real data (when there): cars and crafts stocked round the cathedral, off the roads (no
// car of the traffic stops for one), a car taken from its stand, nothing sent again of what stands; every craft
// type taken from a stand there and round the Veste Oberhaus moves off it, the ones stocked on land clear of the voxels.
// usage (in web/): node tools/stands.mjs [-v]; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';
import { DATA, hasData } from './real-city.mjs';

const { nodeHost, readHostData } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { craftBox, carShape } = await imp('src/sim/solids.ts');
const { SPAWN_HEIGHT, craftWorld } = await imp('src/sim/craft/craft-collision.ts');

const verbose = process.argv.includes('-v');
const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const settle = () => new Promise((r) => setImmediate(r));
const REFILL = 3, UNSEEN = 40, KEEP_S = 5;
const tuning = { ...DEFAULT_TUNING, stands: { ...DEFAULT_TUNING.stands, refill: REFILL, unseen: UNSEEN }, presence: { ...DEFAULT_TUNING.presence, after: KEEP_S } };

// a host's players, each a client whose snapshots' crafts are counted (sent: the crafts each carried)
function players(host, traffic) {
  const all = [];
  const add = (name) => {
    const link = sessionLink(host.connect(name)), c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
    const p = { c, link, name, sent: [] };
    const take = link.onSnapshot;
    link.onSnapshot = (s) => { p.sent.push(s.crafts.length); take.call(link, s); };
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
// 1 m off the left side of a footprint
const beside = (b, d = 1) => ({ x: b.x + Math.cos(b.h) * (b.r + d), z: b.z - Math.sin(b.h) * (b.r + d) });
const sum = (a) => a.reduce((s, n) => s + n, 0);
// the craft types a stand stocks, and each one's input to be off (full ahead, climbing)
const STAND_CRAFTS = ['helicopter', 'boat', 'hovercraft', 'floatplane', 'fighter', 'paraglider'];
const GO = { helicopter: { turn: 0, drive: 0, lift: 1, side: 0 }, hovercraft: { turn: 0, drive: 1, lift: 0, side: 0 }, paraglider: { turn: 0, drive: 0, lift: 0, side: 0 },
  boat: { throttle: 1, steer: 0, drift: false }, floatplane: { turn: 0, pitch: 0, throttle: 1 }, fighter: { turn: 0, pitch: 0, throttle: 1 } };

{
  const G = 6, rough = (x) => x >= 768, river = (x, z) => !rough(x) && z >= 200 && z < 290, cliff = (x, z) => x >= 400 && x < 520 && z >= 300;
  const { dir, data } = await synthData({ size: [2048, 384],
    ground: (x, z) => rough(x) ? G + ((x * 7 + z * 13) % 3) : river(x, z) ? G - 1 : cliff(x, z) ? 60 : G,
    surface: (x, z) => river(x, z) ? 'water' : 'earth' });
  const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, tuning }, data), sim = host.sim;
  const P = players(host, () => ({ roads: [], peds: [], ctrls: [] }));
  const A = P.add('a'), B = P.add('b');
  walk(A, 200, G, 150);
  walk(B, 1950, G, 200);
  await P.tick(90);
  const stands = [...sim.stands.all()], stocked = (type) => stands.find((s) => s.type === type && s.vehicle !== null);
  if (verbose) for (const s of stands) console.log(s.type, s.spot.x.toFixed(1), s.spot.z.toFixed(1), s.vehicle);
  const types = STAND_CRAFTS;
  check(types.every(stocked), `stocked near a player on foot: ${types.map((t) => `${t} ${stocked(t) ? 'yes' : 'no'}`).join(', ')}`);
  const seen = new Set(A.c.crafts().map((c) => c.type));
  check(types.every((t) => seen.has(t)), `the player's page has them (${[...seen].join(', ')})`);
  check(stands.every((s) => s.spot.x < 768) && B.c.crafts().length === 0 && sum(B.sent) === 0,
    `a player 1.35 km off is sent none and none is stocked near them (${sum(B.sent)} craft states sent)`);
  const first = sum(A.sent);
  A.sent.length = 0;
  await P.tick(30);
  check(first >= types.length && sum(A.sent) === 0, `standing, each was sent once (${first} at first, ${sum(A.sent)} in the next second)`);

  // the helicopter boarded, flown 60 m off and left there
  const hs = stocked('helicopter'), heli = hs.vehicle, hp = sim.crafts.get(heli).core.pose, at = beside(craftBox('helicopter', hp));
  walk(A, at.x, G, at.z);
  await P.tick(3);
  A.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id: heli }, role: 'pilot' });
  await P.tick(2);
  check(A.c.seat()?.role === 'pilot' && A.c.seat()?.entity.id === heli && hs.vehicle === null, `a player beside it takes the helicopter (its stand let go of it)`);
  A.c.send({ kind: 'request', request: { kind: 'placeCraft', spot: { x: hp.x + 60, y: G + SPAWN_HEIGHT.helicopter, z: hp.z, h: hp.h } } });
  await P.tick(10);
  A.c.send({ kind: 'leaveSeat', pose: { x: hp.x + 64, y: G, z: hp.z, h: 0, moving: false } });
  A.c.send({ kind: 'view', view: { focus: { x: hp.x + 64, z: hp.z } } });
  await P.tick(10);
  const before = hs.vehicle;
  await P.tick(Math.ceil((REFILL + 1) / STEP));
  const left = sim.crafts.get(heli);
  check(!!left && left.pilot === null && Math.abs(left.core.pose.x - hp.x - 60) < 2, `left 60 m off, it stays (${left ? `${(left.core.pose.x - hp.x).toFixed(1)} m off its stand` : 'gone'})`);
  check(before === null && hs.vehicle !== null && hs.vehicle !== heli && sim.crafts.get(hs.vehicle)?.type === 'helicopter',
    `its stand refills ${REFILL} s later, the player ${UNSEEN}+ m off (a new helicopter ${hs.vehicle})`);

  // the speedboat: a pilot and a passenger beside them; a third finds the seat taken
  const bs = stocked('boat'), boat = bs.vehicle, bb = craftBox('boat', sim.crafts.get(boat).core.pose);
  const C = P.add('c'), D = P.add('d');
  for (const [p, d] of [[A, 0.5], [C, 1], [D, 1.5]]) { const q = beside(bb, d); walk(p, q.x, G, q.z); }
  await P.tick(5);
  A.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id: boat }, role: 'pilot' });
  await P.tick(2);
  C.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id: boat }, role: 'passenger' });
  await P.tick(2);
  D.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id: boat }, role: 'passenger' });
  await P.tick(2);
  const r = D.c.results('enterSeat');
  check(A.c.seat()?.role === 'pilot' && A.c.seat()?.entity.id === boat && C.c.seat()?.role === 'passenger' && C.c.seat()?.entity.id === boat
    && A.c.passengers().some(([k, id, who]) => k === 'craft' && id === boat && who === 'c'),
    `the speedboat takes a pilot and a passenger beside them (${A.c.seat()?.role}, ${C.c.seat()?.role})`);
  check(r.length === 1 && !r[0].ok && r[0].reason === 'taken', `a second passenger finds its seat taken (${JSON.stringify(r)})`);

  // the paraglider's pilot launched off the cliff
  const gs = stocked('paraglider'), glider = gs.vehicle, gp = { ...gs.spot }, E = P.add('e');
  const ge = beside(craftBox('paraglider', sim.crafts.get(glider).core.pose));
  walk(E, ge.x, 60, ge.z);
  await P.tick(3);
  E.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id: glider }, role: 'pilot' });
  await P.tick(45);
  const g = sim.crafts.get(glider), gq = g?.core.pose;
  check(E.c.seat()?.role === 'pilot' && !!gq && !g.core.ended && Math.hypot(gq.x - gp.x, gq.z - gp.z) > 10 && gq.y > 30,
    `a paraglider's pilot is launched off its cliff (${gq ? `${Math.hypot(gq.x - gp.x, gq.z - gp.z).toFixed(0)} m out, ${gq.y.toFixed(0)} m up` : 'gone'})`);

  // everyone far off: the untouched go at once, the used ones once kept long enough
  for (const p of [A, B, C, D, E]) walk(p, 1950, G, 100);
  await P.tick(10);
  const used = new Set([heli, boat, glider]), still = [...sim.crafts.values()].filter((c) => !used.has(c.id));
  check(still.length === 0 && stands.every((s) => s.vehicle === null), `with every player far off, the untouched are gone at once (${still.length} left)`);
  await P.tick(Math.ceil((KEEP_S + 2) / STEP));
  check(sim.crafts.size === 0, `the used ones are gone once nobody was near for ${KEEP_S} s (${sim.crafts.size} left)`);
  host.dispose();
}

if (!hasData()) console.log(`SKIP stands on the real data: no ${DATA}meta.json / traffic.json`);
else {
  const data = readHostData(DATA), raw = structuredClone(data.traffic);
  const host = nodeHost(DATA, { seed: 3, world: 'tiles', eager: true, physics: { bodies: true } }, { ...data, traffic: structuredClone(raw) }), sim = host.sim;
  const spot = data.meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
  const P = players(host, () => structuredClone(raw)), A = P.add('a');
  walk(A, spot.x, 0, spot.y);
  for (let i = 0; i < 40 && !sim.physics; i++) await P.tick(10);
  // (a block's finder starts again when a node it reads is not in yet: until none is stocked any more)
  for (let i = 0, n = -1; i < 20; i++) {
    await P.tick(30);
    const m = [...sim.stands.all()].filter((s) => s.vehicle !== null).length;
    if (m === n) break;
    n = m;
  }
  const stands = [...sim.stands.all()], near = stands.filter((s) => s.vehicle !== null);
  const cars = near.filter((s) => s.kind === 'car'), crafts = near.filter((s) => s.kind === 'craft');
  if (verbose) for (const s of near) console.log(s.type, s.spot.x.toFixed(0), s.spot.z.toFixed(0), s.spot.y.toFixed(1));
  check(cars.length > 0 && crafts.length > 0, `round the cathedral: ${cars.length} cars by the road and ${crafts.length} crafts (${[...new Set(crafts.map((s) => s.type))].join(', ')})`);
  // (the traffic's cars stopped for something standing in their way: none for a stand's vehicle)
  let blocked = 0;
  A.sent.length = 0;
  for (let i = 0; i < 30; i++) {
    await P.tick(1);
    blocked += sim.traffic.cars.filter((c) => c.stand && near.some((s) => Math.hypot(c.stand.x - s.spot.x, c.stand.z - s.spot.z) < 3)).length;
  }
  check(blocked === 0, `no car of the traffic stops for a stand's vehicle (${blocked} car-ticks)`);
  check(sum(A.sent) === 0, `nothing standing is sent again (${sum(A.sent)} craft states in a second)`);
  // (the nearest car stand)
  const cs = cars.sort((a, b) => Math.hypot(a.spot.x - spot.x, a.spot.z - spot.y) - Math.hypot(b.spot.x - spot.x, b.spot.z - spot.y))[0];
  const id = cs.vehicle, car = sim.traffic.detachedCars.find((c) => c.id === id), p = sim.entities.pose({ kind: 'car', id });
  const q = beside({ ...p, r: carShape(car).hx });
  walk(A, q.x, p.y, q.z);
  await P.tick(10);
  A.c.send({ kind: 'enterSeat', entity: { kind: 'car', id }, role: 'driver' });
  await P.tick(30);
  check(A.c.seat()?.role === 'driver' && A.c.seat()?.entity.id === id && cs.vehicle === null,
    `a ${cs.type} taken from its stand ${Math.hypot(cs.spot.x - spot.x, cs.spot.z - spot.y).toFixed(0)} m from the cathedral (${JSON.stringify(A.c.results('enterSeat'))})`);

  // Every craft type a stand stocks, taken on the real data (round the cathedral and the Veste Oberhaus, whose yard
  // slopes: the caps drawn lie under the voxels a craft collides with) and given its go: each moves off its stand,
  // and every one stocked on land stands clear of the voxels (a sweep up from it is free)
  const ober = data.meta.labels.find((l) => l.name === 'Veste Oberhaus') ?? { x: 8509, y: 2365 };
  const B = P.add('b');
  walk(B, spot.x, 0, spot.y);
  A.c.send({ kind: 'leaveSeat' });
  walk(A, ober.x, 110, ober.y);
  await P.tick(150);
  const sweepUp = (s) => {
    const c = sim.crafts.get(s.vehicle), p = c.core.pose;
    c.collision.prefetch(p, { x: 0, y: 0, z: 0 });
    return craftWorld(s.type, c.collision).sweep(p, { x: 0, y: 0.3, z: 0 }, p.h, p.h);
  };
  const stocked = [...sim.stands.all()].filter((s) => s.kind === 'craft' && s.vehicle !== null);
  const landed = stocked.filter((s) => s.type in SPAWN_HEIGHT);
  // (an asleep craft's collision let go: its nodes fetched again for the look)
  for (let i = 0; i < 40 && landed.some((s) => sweepUp(s) === 'loading'); i++) await P.tick(5);
  const stuck = landed.filter((s) => { const up = sweepUp(s); return up === 'loading' || up.hit; });
  check(landed.length > 0 && stuck.length === 0, `${landed.length} helicopters, hovercraft and paragliders stocked stand clear of the voxels (${stuck.map((s) => `${s.type} at ${s.spot.x}, ${s.spot.z}`).join('; ') || 'none stuck'})`);
  const moved = [];
  for (const type of STAND_CRAFTS) {
    const s = stocked.filter((t) => t.type === type && sim.crafts.get(t.vehicle))
      .sort((a, b) => Math.hypot(a.spot.x - ober.x, a.spot.z - ober.y) - Math.hypot(b.spot.x - ober.x, b.spot.z - ober.y))[0];
    if (!s) { moved.push(`${type} none stocked`); continue; }
    const id = s.vehicle, p0 = { ...sim.crafts.get(id).core.pose }, q = beside(craftBox(type, p0));
    A.c.send({ kind: 'leaveSeat' });
    walk(A, q.x, p0.y, q.z);
    await P.tick(5);
    A.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'pilot' });
    await P.tick(3);
    for (let i = 0; i < 90; i++) { A.c.send({ kind: 'seatInput', role: 'pilot', input: GO[type] }); await P.tick(1); }
    const p1 = sim.crafts.get(id)?.core.pose, d = p1 ? Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) : 0;
    moved.push(`${type} ${A.c.seat()?.entity.id === id && d > 8 ? '' : 'NOT '}off, ${d.toFixed(0)} m`); if (verbose) console.log(type, JSON.stringify(s.spot), JSON.stringify(p1), JSON.stringify(A.c.seat()), JSON.stringify(sim.crafts.get(id)?.core.save?.()).slice(0, 600));
  }
  check(moved.every((m) => !m.includes('NOT') && !m.includes('none')), `every craft type taken from its stand moves off it in 3 s (${moved.join(', ')})`);
  host.dispose();
}

if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS stands');
