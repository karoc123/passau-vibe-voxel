// The combat plane as its pilot meets it, through the real host (host/node.ts nodeHost) and the pilot's page (its own
// plane run ahead, the shell's CraftLink, the shots aimed as nav/plane.ts aims them: along the nose as drawn, the page's
// point there sent with each, nav/gunner.ts aimPoint, nav/arms.ts) on a synthetic world (a long pond, flat land
// round it). What a player notices: an attack run from ~300 m at a player standing on the land, the trigger held with
// the nose flown onto them, lands at least 10 of 30 shots, over a link with no delay and over one of ~150 ms round
// trip; the same run with the nose held 10 degrees to the side lands none, and no shot hits the plane itself. Started
// afloat on the pond, full throttle and the stick pulled past its takeoff speed, it lifts off and climbs away.
// usage (in web/): node tools/fighter.mjs [--log]; prints PASS lines, or FAIL and exit 1
import { imp, synthData } from './lib.mjs';

const { nodeHost, nodeTileCache } = await imp('src/host/node.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { LiveEdits } = await imp('src/core/live-edits.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { CraftLink } = await imp('src/nav/craft.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { SEATS, mountOf, mountPoint } = await imp('src/sim/seats.ts');
const { aimPoint } = await imp('src/nav/gunner.ts');
const { Arms } = await imp('src/nav/arms.ts');
const { FIGHTER } = await imp('src/sim/craft/plane-flight.ts');
const { weaponById } = await imp('src/sim/weapons/index.ts');

const log = process.argv.includes('--log');
const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));
const DEG = Math.PI / 180, FRAME = 1 / 60;
const GUN = mountOf(SEATS.craft.fighter, { role: 'pilot', index: 0 }), SLOT = weaponById(GUN.weapon).slot;

const G = 5;
// the pond: a strip along x, flat land beyond it
const pond = (x, z) => x > 40 && x < 700 && z > 30 && z < 130;
const { dir, data } = await synthData({ size: [1280, 384], ground: (x, z) => (pond(x, z) ? G - 2 : G), surface: (x, z) => (pond(x, z) ? 'water' : 'grass'), boxes: [] });
// (the target stands through every hit: the count is the gate's, not when a player falls)
const H = DEFAULT_TUNING.health, tuning = { ...DEFAULT_TUNING, health: { ...H, player: { ...H.player, max: 1e6 } } };
const traffic = () => ({ roads: [], peds: [], ctrls: [] });

// one world: the host, a target T standing on the land, the pilot A's page over a link that holds each message `ping`
// / 2 s each way; frames of 1/60 s, the host's ticks every STEP, all on a simulated clock
async function world(ping) {
  const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 600, tuning, stands: false }, structuredClone(data));
  let t = 0, hostT = 0, nextTick = 0;
  const now = () => t * 1000, ends = [];
  const add = (name, delay) => {
    const session = host.connect(name), up = [], down = [];
    const link = {
      onHello() {}, onSnapshot() {},
      send(commands) { up.push([t + delay, JSON.parse(JSON.stringify(commands))]); },
      close() {},
    };
    const cache = nodeTileCache(dir, data.meta.tiles.N, new LiveEdits());
    const client = new MirrorSimClient(link, traffic(), null, host.hello, undefined, null, { meta: data.meta, cache, now });
    link.onHello(host.hello);
    const end = { session, link, client, up, down, delay };
    ends.push(end);
    return { client, cache };
  };
  const T = add('T', 0), A = add('A', ping / 2);
  const frame = () => {
    t += FRAME;
    while (hostT + 0.001 <= t) {
      hostT += 0.001;
      for (const e of ends) while (e.up.length && e.up[0][0] <= hostT) for (const c of e.up.shift()[1]) e.session.send(c);
      if (hostT >= nextTick) {
        nextTick += STEP;
        host.update(STEP);
        for (const e of ends) e.down.push([hostT + e.delay, structuredClone(e.session.snapshot())]);
      }
      for (const e of ends) while (e.down.length && e.down[0][0] <= hostT) e.link.onSnapshot(e.down.shift()[1]);
    }
    for (const e of ends) e.client.update(FRAME);
  };
  const link = new CraftLink({ sim: Promise.resolve(A.client), tiles: { meta: data.meta, cache: A.cache, now }, nav: { stepOut: null } }, 'fighter');
  await null;
  return { host, T: T.client, A: A.client, link, frame };
}

// the plane put down at spot (in the air, or afloat), flown a while with input till its tiles are in and the page
// runs it ahead
async function start(w, spot, input, focus) {
  w.T.send({ kind: 'view', view: { focus } });
  w.A.send({ kind: 'view', view: { focus } });
  w.link.open();
  w.link.spawn(spot);
  for (let i = 0; i < 2000; i++) {
    if (w.link.craft) w.link.input(input);
    w.frame();
    w.link.frame();
    const c = [...w.host.sim.crafts.values()][0];
    if (i > 60 && c && c.collision.surface(c.core.pose.x, c.core.pose.z) !== null && w.A.prediction?.lag != null) break;
    await new Promise((r) => setTimeout(r, i % 10 ? 0 : 1));
  }
  const c = [...w.host.sim.crafts.values()][0];
  if (!c || !w.link.craft) throw new Error('fighter: the plane never flew');
  return c;
}

// An attack run: the plane put down ~450 m short of T, 40 m up, flown by a pilot who keeps the drawn nose on T as the
// page draws them (off: that far to the side of them), the trigger held for 30 shots once T is within ~290 m
async function run(ping, off = 0) {
  const w = await world(ping), T_AT = { x: 1000, z: 250 };
  w.T.send({ kind: 'request', request: { kind: 'walk', pose: { x: T_AT.x, y: G, z: T_AT.z, h: 0, moving: false } } });
  const plane = await start(w, { x: 560, y: G + 40, z: 250, h: Math.PI / 2, speed: 55 }, { turn: 0, pitch: 0, throttle: 0.8 }, T_AT);
  // (put back at the run's start once the tiles are in)
  w.link.place({ x: 560, y: G + 40, z: 250, h: Math.PI / 2, speed: 55 });
  for (let i = 0; i < 20; i++) { w.link.input({ turn: 0, pitch: 0, throttle: 0.8 }); w.frame(); w.link.frame(); await settle(); }
  const target = () => w.A.traffic.avatars.find((a) => a.player === 'T');
  const arms = new Arms(), t0 = w.host.sim.tick, own = plane.id;
  let sent = 0, first = null, last = null, crashed = false;
  for (let i = 0; i < 1200 && sent < 30; i++) {
    const c = w.link.frame();
    if (!c) break;
    const d = c.core.drawn(w.link.alpha), f = d.fwd, a = target();
    if (!a) { w.link.input({ turn: 0, pitch: 0, throttle: 0.8 }); w.frame(); await settle(); continue; }
    const p = w.A.traffic.avatarPose(a, w.A.time.alpha, { x: 0, y: 0, z: 0, h: 0 });
    const h = Math.atan2(f.x, f.z), pitch = Math.asin(f.y), from = mountPoint(GUN, { x: d.p.x, y: d.p.y, z: d.p.z, h, pitch });
    const dx = p.x - from.x, dy = p.y + 1.2 - from.y, dz = p.z - from.z, dist = Math.hypot(dx, dz);
    const wantH = Math.atan2(dx, dz) + off, wantP = Math.atan2(dy, dist);
    const eh = Math.atan2(Math.sin(wantH - h), Math.cos(wantH - h)), ep = wantP - pitch;
    // (the stick: the bank towards the heading's error, the nose towards the pitch's; turn +1 right, the heading down)
    const input = { turn: Math.max(-1, Math.min(1, -eh * 8)), pitch: Math.max(-1, Math.min(1, ep * 10)), throttle: 0.8 };
    w.link.input(input);
    if (dist < 290) {
      const before = arms.wait;
      arms.update(FRAME, w.A, h, pitch, null, true, { slot: SLOT, to: () => aimPoint(w.A, null, from, { x: f.x, y: f.y, z: f.z }) });
      if (arms.wait > before) { sent++; first ??= { dist, eh: eh / DEG, ep: ep / DEG }; last = { dist, eh: eh / DEG, ep: ep / DEG }; }
    }
    w.frame();
    if (c.core.flight.state === 'crashed') crashed = true;
    await settle();
  }
  for (let i = 0; i < 30; i++) { w.link.input({ turn: 0, pitch: 0.5, throttle: 0.8 }); w.frame(); await settle(); }
  const shots = w.host.sim.eventsSince(t0).filter((e) => e.kind === 'shot' && e.player === 'A'), id = target()?.id;
  const hits = shots.filter((e) => e.hit?.kind === 'avatar' && e.hit.id === id).length;
  const self = shots.filter((e) => e.hit?.kind === 'craft' && e.hit.id === own).length;
  if (log) console.log({ ping, off, sent, first, last, crashed, hits, shots: shots.length });
  w.host.dispose?.();
  return { sent, shots: shots.length, hits, self, first, last, crashed };
}

const say = (r) => `${r.hits} of ${r.shots} shots hit (from ${r.first?.dist.toFixed(0)} m to ${r.last?.dist.toFixed(0)} m)`;
for (const ping of [0, 0.15]) {
  const r = await run(ping);
  check(r.sent === 30 && r.shots === 30 && r.hits >= 10 && !r.crashed,
    `an attack run ${ping ? 'over a ~150 ms link' : 'with no delay'}, the nose flown onto a standing player: ${say(r)}; at least 10 of 30`);
  check(r.self === 0, `no shot of the run hits the plane itself (${r.self})`);
}
const wide = await run(0.15, 10 * DEG);
check(wide.shots === 30 && wide.hits === 0, `the same run with the nose 10° to the side: ${say(wide)}; none`);

// afloat on the pond: full throttle, the stick pulled once past its takeoff speed: it lifts off and climbs
{
  const w = await world(0.15), X0 = 80, Z0 = 80;
  const plane = await start(w, { x: X0, y: G - 2 + FIGHTER.FLOAT_H, z: Z0, h: Math.PI / 2, water: true }, { turn: 0, pitch: 0, throttle: 0 }, { x: X0 + 300, z: Z0 });
  const f = plane.core.flight, events = [];
  let off = null;
  for (let i = 0; i < 60 * 30 && !(off !== null && f.p.y > G + 60); i++) {
    w.link.input({ turn: 0, pitch: f.state === 'water' ? (f.v > FIGHTER.V_TAKEOFF - 1 ? 1 : 0) : 0.5, throttle: 1 });
    w.frame();
    w.link.frame();
    for (const e of w.link.events()) events.push(e.type);
    if (off === null && f.state === 'air') off = { x: f.p.x - X0, s: i * FRAME };
    await settle();
  }
  check(!!off && f.state === 'air' && f.p.y > G + 60 && events.includes('takeoff') && !events.includes('crash'),
    `from the water at full throttle it lifts off after ${off?.x.toFixed(0)} m (${off?.s.toFixed(1)} s) and climbs to ${(f.p.y - G).toFixed(0)} m (the page told: ${[...new Set(events)].join(', ')})`);
  w.host.dispose?.();
}

if (fail.length) process.exit(1);
console.log('PASS fighter');
process.exit(0);
