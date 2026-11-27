// The military helicopter's door guns, through the real host (host/node.ts nodeHost, a session per player, a client
// each over a link that can hold what crosses it) on a synthetic world (flat land). What a player notices: from a
// hover 60 m up, with a player standing ~80 m off its left side, the left door's gunner lands at least 10 of 30 shots
// aimed on the page (nav/gunner.ts aimPoint, nav/arms.ts), over a link with no delay and over one of ~150 ms round
// trip; the right door's gunner lands none on them (out of its swing) and its shots leave to its own side; its bench
// has no gun; no shot hits the helicopter itself. The first three aboard beside the pilot take the left gun, the right
// gun and the bench, a fourth is refused. C goes round its seats (nav/board.ts swap): the controls, the left gun, the
// right gun, the bench, the controls. The light helicopter takes one passenger beside its pilot, not two.
// usage (in web/): node tools/gunship.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

// (Boarding listens for its keys on the window: none here)
globalThis.addEventListener ??= () => {};

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { SEATS, mountOf, mountPoint } = await imp('src/sim/seats.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { aimDir } = await imp('src/sim/weapons/weapon.ts');
const { weaponById } = await imp('src/sim/weapons/index.ts');
const { aimPoint } = await imp('src/nav/gunner.ts');
const { Arms } = await imp('src/nav/arms.ts');
const { Boarding } = await imp('src/nav/board.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));
const DEG = 180 / Math.PI;

const G = 5;
const { dir, data } = await synthData({ size: [512, 384], ground: () => G, surface: () => 'grass', boxes: [] });
// (the target stands through every hit: the count is the gate's, not when a player falls)
const H = DEFAULT_TUNING.health, tuning = { ...DEFAULT_TUNING, health: { ...H, player: { ...H.player, max: 1e6 } } };
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 400, tuning, stands: false }, data);
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const LEFT = mountOf(SEATS.craft.gunship, { role: 'passenger', index: 0 }), RIGHT = mountOf(SEATS.craft.gunship, { role: 'passenger', index: 1 });
const SLOT = weaponById(LEFT.weapon).slot;

// a client whose link holds what it sends lag.up ticks and what it is sent lag.down ticks (snapshots cloned when sent)
let n = 0;
const all = [];
const add = (name) => {
  const inner = sessionLink(host.connect(name)), out = [], back = [], lag = { up: 0, down: 0 };
  const link = {
    onHello() {}, onSnapshot() {},
    send(cmds) { out.push({ at: n + lag.up, cmds }); },
    close() { inner.close(); },
    flush() { while (out.length && out[0].at <= n) inner.send(out.shift().cmds); },
    deliver() {
      inner.onHello = (h) => link.onHello(h);
      inner.onSnapshot = (s) => back.push({ at: n + lag.down, s: structuredClone(s) });
      inner.deliver();
      while (back.length && back[0].at <= n) link.onSnapshot(back.shift().s);
    },
  };
  const c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
  const p = { c, link, name, lag };
  all.push(p);
  return p;
};
const tick = async (k = 1, each = () => {}) => {
  for (let i = 0; i < k; i++) {
    each();
    for (const p of all) p.c.update(STEP);
    for (const p of all) p.link.flush();
    host.update(STEP);
    n++;
    for (const p of all) p.link.deliver();
    await settle();
  }
};
const walk = (p, x, z, h = 0) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h, moving: false } } });
};
const craft = (id) => host.sim.crafts.get(id);
const spawn = async (p, type, x, z, h) => {
  walk(p, x, z + 8);
  await tick(3);
  p.c.send({ kind: 'request', request: { kind: 'craft', type, spot: { x, y: G + SPAWN_HEIGHT[type], z, h } } });
  await tick(30);
  return p.c.craftOf();
};
const enter = async (p, id, role, index) => {
  p.c.results('enterSeat');
  p.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id }, role, ...(index === undefined ? {} : { index }) });
  await tick(6);
  return p.c.results('enterSeat');
};
const shotsOf = (name, since) => host.sim.eventsSince(since).filter((e) => e.kind === 'shot' && e.player === name);
const at = (p) => p.c.seat()?.role === 'passenger' ? p.c.seat().index : p.c.seat()?.role ?? null;

// the pilot P, the gunners L and R and the rider B board on the ground; Q, a fourth, is refused
const X = 200, Z = 250, P = add('P'), L = add('L'), R = add('R'), B = add('B'), Q = add('Q'), T = add('T');
const heli = await spawn(P, 'gunship', X, Z, Math.PI / 2);
check(heli?.type === 'gunship' && P.c.seat()?.role === 'pilot', 'a military helicopter made, its maker at the controls');
const id = heli.id;
for (const [p, dz] of [[L, -3], [R, 3], [B, -3], [Q, 3]]) walk(p, X - 1, Z + dz);
await tick(4);
const answers = [];
for (const p of [L, R, B, Q]) answers.push(await enter(p, id, 'passenger'));
check(at(L) === 0 && at(R) === 1 && at(B) === 2 && !answers[3].some((r) => r.ok) && answers[3][0]?.reason === 'taken',
  `the first three aboard take the left gun, the right gun and the bench (${[L, R, B].map(at).join(', ')}); a fourth is refused (${JSON.stringify(answers[3])})`);

// up to a hover 60 m over the ground; T stands ~80 m off its left side (its nose along +x: its left is -z)
const T_AT = { x: X, z: Z - 80 };
walk(T, T_AT.x, T_AT.z);
const fly = (lift) => () => {
  P.c.send({ kind: 'seatInput', role: 'pilot', input: { turn: 0, drive: 0, lift, side: 0 } });
  const q = craft(id).core.pose;
  for (const p of [P, L, R, B]) p.c.send({ kind: 'view', view: { focus: { x: q.x, z: q.z } } });
};
for (let i = 0; i < 600 && craft(id).core.pose.y < G + 60; i++) await tick(1, fly(1));
await tick(60, fly(0));
const hover = craft(id).core.pose;
check(hover.y > G + 55 && craft(id).core.motion.speed < 1, `it hovers ${(hover.y - G).toFixed(0)} m up (${craft(id).core.motion.speed.toFixed(2)} m/s)`);

const tAvatar = (p) => p.c.traffic.avatars.find((a) => a.player === 'T');
// what p's page aims at from its gun: from the mount on the helicopter as drawn, to T's chest as drawn
const aim = (p, gun) => {
  const c = p.c.crafts().find((q) => q.id === id), d = c.core.drawn(p.c.time.alpha), from = mountPoint(gun, d);
  const t = p.c.traffic.avatarPose(tAvatar(p), p.c.time.alpha, { x: 0, y: 0, z: 0, h: 0 });
  const dx = t.x - from.x, dy = t.y + 1.2 - from.y, dz = t.z - from.z;
  return { from, h: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), dist: Math.hypot(dx, dz) };
};
const ground = { raycast: (o, d, max) => (d.y < 0 ? Math.min(max, (o.y - G) / -d.y) : Infinity) };
// 30 shots of p's from gun at T, the trigger held
const volley = async (p, gun) => {
  const arms = new Arms(), t0 = host.sim.tick;
  let sent = 0;
  for (let i = 0; i < 300 && sent < 30; i++) {
    await tick(1, () => {
      fly(0)();
      if (!tAvatar(p)) return;
      const a = aim(p, gun), before = arms.wait;
      arms.update(STEP, p.c, a.h, a.pitch, null, true, { slot: SLOT, to: () => aimPoint(p.c, ground, a.from, aimDir(a.h, a.pitch)) });
      if (arms.wait > before) sent++;
    });
  }
  await tick(8, fly(0));
  const s = shotsOf(p.name, t0), tid = tAvatar(p)?.id;
  return { sent, s, hits: s.filter((e) => e.hit?.kind === 'avatar' && e.hit.id === tid).length, self: s.filter((e) => e.hit?.kind === 'craft' && e.hit.id === id).length };
};
await tick(10, fly(0));
check(!!tAvatar(L) && !!tAvatar(R), 'the gunners\' pages have T standing off the left side');
for (const lag of [0, 2]) {
  L.lag.up = L.lag.down = lag;
  await tick(10, fly(0));
  const v = await volley(L, LEFT);
  check(v.sent === 30 && v.s.length === 30 && v.hits >= 10 && v.self === 0,
    `from the hover, ${lag ? 'over a ~150 ms link' : 'with no delay'}, the left gunner lands ${v.hits} of ${v.s.length} shots on T ~80 m off (at least 10 of 30), none on the helicopter (${v.self})`);
}
{
  const v = await volley(R, RIGHT), p = craft(id).core.pose;
  const side = v.s.map((e) => Math.atan2(Math.sin(Math.atan2(e.to.x - e.at.x, e.to.z - e.at.z) - p.h), Math.cos(Math.atan2(e.to.x - e.at.x, e.to.z - e.at.z) - p.h)) * DEG);
  check(v.s.length === 30 && v.hits === 0 && v.self === 0 && side.every((a) => a < -29),
    `the right gunner, T on the other side, lands none of ${v.s.length} (its shots leave at its swing's stop, ${Math.max(...side).toFixed(0)}° off the bow, to its right)`);
}
{
  const t0 = host.sim.tick, p = craft(id).core.pose;
  B.c.send({ kind: 'fire', slot: SLOT, h: p.h + Math.PI / 2, pitch: -0.5, to: { x: T_AT.x, y: G + 1, z: T_AT.z } });
  await tick(6, fly(0));
  check(shotsOf('B', t0).length === 0 && mountOf(SEATS.craft.gunship, { role: 'passenger', index: 2 }) === null, 'the bench has no gun: its rider fires nothing');
}

// a player alone on the ground: C goes round the seats, the controls, the left gun, the right gun, the bench, back
{
  const S = add('S'), solo = await spawn(S, 'gunship', 380, 120, 0), sid = solo.id, went = [at(S)];
  const shell = { id: 'gunship', boards: ['gunship'], board: () => true };
  const rider = { ride: () => true };
  const nav = { sim: S.c, craft: shell, onFoot: false };
  const swapper = new Boarding(nav, () => [shell], () => {}, () => rider);
  const labels = [];
  for (let k = 0; k < 4; k++) {
    labels.push(swapper.swapLabel());
    if (!swapper.swap()) break;
    const before = JSON.stringify(S.c.seat());
    for (let i = 0; i < 10 && JSON.stringify(S.c.seat()) === before; i++) { await tick(1); swapper.update(); }
    await tick(2); swapper.update();
    nav.craft = S.c.seat()?.role === 'pilot' ? shell : { id: 'passenger' };
    went.push(at(S));
  }
  check(JSON.stringify(went) === JSON.stringify(['pilot', 0, 1, 2, 'pilot']) && craft(sid)?.pilot === 'S',
    `alone, C goes round the seats: ${went.join(' -> ')} (${labels.join(', ')})`);
  host.sim.removeCraft(sid);
}

// the light helicopter: its pilot and one passenger
{
  const H1 = add('H1'), a = add('H2'), b = add('H3');
  const light = await spawn(H1, 'helicopter', 380, 300, 0);
  walk(a, 383, 300); walk(b, 377, 300);
  await tick(4);
  const ra = await enter(a, light.id, 'passenger'), rb = await enter(b, light.id, 'passenger');
  check(SEATS.craft.helicopter.length === 2 && ra.some((r) => r.ok) && !rb.some((r) => r.ok) && rb[0]?.reason === 'taken',
    `the light helicopter seats its pilot and one passenger, a second refused (${JSON.stringify(rb)})`);
}

host.dispose?.();
if (fail.length) process.exit(1);
process.exit(0);
