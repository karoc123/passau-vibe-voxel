// The cars players park (sim/traffic.ts: kept out of the traffic, a cap per place), on a synthetic world with no
// roads and the players as views: sixteen players a kilometre apart each park a car where they stand; one walks 400 m
// off its car (out of sight, within the edits' keeping) and finds it there on coming back, however many the others
// parked. One player parking twelve in one square keeps the newest eight once out of sight, back in sight none go.
// Sixteen players each parking eight: all their cars kept; sixteen more wrecked by one of them: its place
// gives them up for the host's bound, the others keep theirs.
// usage (in web/): node tools/parked.mjs [-v]; prints PASS lines, or FAIL and exit 1
import { imp } from './lib.mjs';

const { Traffic } = await imp('src/sim/traffic.ts');
const { CAR_POP_R } = await imp('src/sim/road-net.ts');

const verbose = process.argv.includes('-v');
const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(`FAIL ${s}`));
const G = 5, HOUR = 12;
const KIND = { len: 4.5, bus: false, col: '#808080' };

// a host's traffic with the players at spots[i] (their views), frames of a tick each
function world(spots) {
  const T = new Traffic({ roads: [], peds: [], ctrls: [] }), at = spots.map((p) => ({ ...p }));
  const run = (n = 1) => {
    for (let i = 0; i < n; i++) T.tick(T.frame(HOUR, at.map((p, id) => ({ id, focus: { x: p.x, z: p.z }, viewer: { x: p.x, z: p.z, y: G } }))), HOUR);
  };
  const park = (x, z) => T.parkAgain(KIND, { x, y: G, z, h: 0, pitch: 0, roll: 0 });
  const has = (c) => T.detachedCars.includes(c);
  return { T, at, run, park, has };
}
const grid = (n, d) => Array.from({ length: n * n }, (_, i) => ({ x: 500 + (i % n) * d, z: 500 + Math.floor(i / n) * d }));

// sixteen players spread over the city, each a car where they stand; player 0 walks off its own and back
{
  const W = world(grid(4, 1000));
  const mine = W.park(W.at[0].x, W.at[0].z);
  W.run(5);
  W.at[0].x += 400;
  W.run(5);
  for (const p of W.at.slice(1)) W.park(p.x + 5, p.z);
  W.run(30);
  const kept = W.has(mine);
  W.at[0].x -= 400;
  W.run(5);
  if (verbose) console.log(`spread: ${W.T.detachedCars.length} parked, player 0's ${kept ? 'kept' : 'gone'}`);
  check(kept && W.has(mine), `a car parked by one of sixteen players kept 400 m off it while the others park theirs (${W.T.detachedCars.length} parked)`);
  check(W.T.detachedCars.length === 16, `every player's car kept (${W.T.detachedCars.length} of 16)`);
}

// one player parks twelve in one square, walks out of sight and back
{
  const W = world([{ x: 500, z: 500 }]);
  const cars = Array.from({ length: 12 }, (_, i) => W.park(500 + (i % 4) * 6, 500 + Math.floor(i / 4) * 3));
  W.run(10);
  check(cars.every(W.has), `twelve parked in sight all stay (${cars.filter(W.has).length})`);
  W.at[0].x += CAR_POP_R + 100;
  W.run(30);
  const left = cars.filter(W.has);
  if (verbose) console.log(`one square: ${left.length} of 12 kept`);
  check(left.length === 8 && cars.slice(4).every(W.has), `out of sight the newest eight of one square kept (${left.length})`);
}

// sixteen players each park eight where they stand: theirs all kept, the host's bound held
{
  const W = world(grid(4, 1000)), cars = [];
  for (const p of W.at) for (let i = 0; i < 8; i++) cars.push(W.park(p.x + i * 6, p.z));
  W.run(30);
  const kept = cars.filter(W.has).length;
  if (verbose) console.log(`sixteen by eight: ${kept} of ${cars.length} kept, ${W.T.detachedCars.length} out of the traffic`);
  check(kept === cars.length, `sixteen players' eight each all kept (${kept} of ${cars.length})`);
  // (as a crash or a driver leaves one: detachCar takes no refusal) sixteen more where player 0 stands, in its sight
  const proto = W.T.detachedCars[0];
  for (let i = 0; i < 16; i++) W.T.detachedCars.push({ ...proto, id: 90000 + i, detachedPose: { ...proto.detachedPose, z: proto.detachedPose.z + 20 } });
  W.run(30);
  const others = cars.slice(8).filter(W.has).length;
  check(W.T.detachedCars.length <= 128 && others === 120, `over the host's bound the fullest place gives up its own, the others' all kept (${W.T.detachedCars.length} out of the traffic, ${others} of 120 others')`);
}

for (const f of fail) console.log(f);
process.exit(fail.length ? 1 : 0);
