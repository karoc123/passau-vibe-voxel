// Placed vehicles (sim/stands.ts), through the real host (host/node.ts nodeHost, a client per player over a CloneLink).
// On a synthetic world (a flat field, a river with banks, a cliff over it, a rough far end with no room for anything):
// a player on foot finds a helicopter, speedboat, hovercraft, floatplane and paraglider stocked near them, each sent
// once and then not again while it stands; a player 1.35 km off is sent none, and none is stocked near them. The
// helicopter is boarded, flown off and left: it stays, and its stand refills out of the player's sight; a second
// player rides along in the speedboat beside its pilot, a third finds its seat taken; the paraglider's pilot is
// launched off its cliff. With every player gone far, the untouched vehicles go at once and the used ones once the
// keeping has run out. On the real data (when there): cars and crafts stocked round the cathedral, a car taken from
// its stand, nothing sent again of what stands.
// usage (in web/): node tools/stands.mjs [-v]; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';
import { DATA, hasData } from './real-city.mjs';

const { nodeHost, readHostData } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { craftBox, carShape } = await imp('src/sim/solids.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');

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
  const types = ['helicopter', 'boat', 'hovercraft', 'floatplane', 'paraglider'];
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
  await P.tick(60);
  const stands = [...sim.stands.all()], near = stands.filter((s) => s.vehicle !== null);
  const cars = near.filter((s) => s.kind === 'car'), crafts = near.filter((s) => s.kind === 'craft');
  if (verbose) for (const s of near) console.log(s.type, s.spot.x.toFixed(0), s.spot.z.toFixed(0), s.spot.y.toFixed(1));
  check(cars.length > 0 && crafts.length > 0, `round the cathedral: ${cars.length} cars by the road and ${crafts.length} crafts (${[...new Set(crafts.map((s) => s.type))].join(', ')})`);
  A.sent.length = 0;
  await P.tick(30);
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
  host.dispose();
}

if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS stands');
