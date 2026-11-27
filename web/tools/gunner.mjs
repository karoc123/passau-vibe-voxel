// The speedboat's gunner, through the real host (host/node.ts nodeHost, a session per player, a client each over a
// CloneLink) on a synthetic world (a long pond, land beside it). What a player notices: from the gun of a boat going
// ~15 m/s, over a link that holds commands and snapshots 2 ticks each way (~150 ms round trip with the drawing behind),
// at least 8 of 10 shots aimed on the page (nav/gunner.ts aimPoint, nav/arms.ts) hit a player standing ~60 m off the
// bow, and that player is hurt; the same shots with a direction alone miss (or the gate would prove nothing); a shot
// aimed astern or straight up leaves within the mount's swing; the pilot's seat fires nothing; a player alone goes
// from the wheel to the gun (C: nav/board.ts swap), fires from the mount, the boat drifting on without its pilot,
// and back to the wheel, which steers it again.
// usage (in web/): node tools/gunner.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

// (Boarding listens for its keys on the window: none here)
globalThis.addEventListener ??= () => {};

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { SEATS, mountOf, mountPoint } = await imp('src/sim/seats.ts');
const { aimDir } = await imp('src/sim/weapons/weapon.ts');
const { aimPoint } = await imp('src/nav/gunner.ts');
const { Arms } = await imp('src/nav/arms.ts');
const { Boarding } = await imp('src/nav/board.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const settle = () => new Promise((r) => setImmediate(r));

const G = 5;
// the pond: z under 60, the land beyond it
const pond = (x, z) => z < 60 && x < 500;
const { dir, data } = await synthData({ size: [512, 128], ground: (x, z) => (pond(x, z) ? G - 1 : G), surface: (x, z) => (pond(x, z) ? 'water' : 'road'), boxes: [] });
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 400 }, data);
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const GUN = mountOf(SEATS.craft.boat, { role: 'passenger', index: 0 });

// a client whose link holds what it sends `up` ticks and what it is sent `down` ticks (snapshots cloned when sent)
let n = 0;
const all = [];
const add = (name, up = 0, down = 0) => {
  const inner = sessionLink(host.connect(name)), out = [], back = [];
  const link = {
    onHello() {}, onSnapshot() {},
    send(cmds) { out.push({ at: n + up, cmds }); },
    close() { inner.close(); },
    flush() { while (out.length && out[0].at <= n) inner.send(out.shift().cmds); },
    deliver() {
      inner.onHello = (h) => link.onHello(h);
      inner.onSnapshot = (s) => back.push({ at: n + down, s: structuredClone(s) });
      inner.deliver();
      while (back.length && back[0].at <= n) link.onSnapshot(back.shift().s);
    },
  };
  const c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
  const p = { c, link, name };
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
const spawnBoat = async (p, x, z) => {
  walk(p, x, z + 4);
  await tick(3);
  p.c.send({ kind: 'request', request: { kind: 'craft', type: 'boat', spot: { x, y: G - 1, z, h: Math.PI / 2 } } });
  await tick(30);
  return p.c.craftOf();
};
const enter = async (p, id, role) => {
  p.c.results('enterSeat');
  p.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id }, role });
  await tick(6);
  return p.c.results('enterSeat');
};
const shotsOf = (name, since) => host.sim.eventsSince(since).filter((e) => e.kind === 'shot' && e.player === name);

// A drives, B is at the gun over a ~150 ms link, T stands on the land ahead and to the left
const A = add('A'), B = add('B', 2, 2), T = add('T');
const T_AT = { x: 300, z: 68 };
walk(T, T_AT.x, T_AT.z);
const boat = await spawnBoat(A, 40, 30);
check(boat?.type === 'boat', 'a speedboat made, its maker at the wheel');
const id = boat.id;
walk(B, 40, 33);
await tick(4);
let r = await enter(B, id, 'passenger');
check(r.some((x) => x.ok) && B.c.seat()?.role === 'passenger', `B takes the seat beside the wheel, the gun's (${JSON.stringify(r)})`);
const tAvatar = () => B.c.traffic.avatars.find((a) => a.player === 'T');
check(!!tAvatar(), 'B\'s page has T standing on the land');

// a run at ~15 m/s along the pond; B fires 10 shots once T is ~60 m off, aimed on its page as it draws boat and T
const hold = () => {
  const m = craft(id).core.motion;
  A.c.send({ kind: 'seatInput', role: 'pilot', input: { throttle: m.speed < 15 ? 1 : 0.25, steer: 0, drift: false } });
  const q = craft(id).core.pose;
  for (const p of [A, B]) p.c.send({ kind: 'view', view: { focus: { x: q.x, z: q.z } } });
};
// what B's page aims at: from the mount on the boat as drawn, to T's chest as drawn; to: the point under the crosshair
const aim = () => {
  const c = B.c.crafts().find((q) => q.id === id), d = c.core.drawn(B.c.time.alpha), from = mountPoint(GUN, d);
  const a = tAvatar(), t = B.c.traffic.avatarPose(a, B.c.time.alpha, { x: 0, y: 0, z: 0, h: 0 });
  const dx = t.x - from.x, dy = t.y + 1.2 - from.y, dz = t.z - from.z, h = Math.atan2(dx, dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return { from, h, pitch, dist: Math.hypot(dx, dz), bow: Math.atan2(Math.sin(h - d.h), Math.cos(h - d.h)) };
};
const water = { raycast: (o, d, max) => (d.y < 0 ? Math.min(max, (o.y - (G - 1)) / -d.y) : Infinity) };
const probe = async (withTo) => {
  // (each probe a run of its own: the boat put back at the start, at speed by the time T is 60 m off)
  A.c.send({ kind: 'request', request: { kind: 'placeCraft', spot: { x: 40, y: G - 1, z: 30, h: Math.PI / 2 } } });
  await tick(10);
  if (B.c.seat()?.role !== 'passenger') return { sent: 0, shots: 0, hits: 0, speed: 0, dist: 0, bow: 0 };
  for (let i = 0; i < 2000 && aim().dist > 60; i++) await tick(1, hold);
  const arms = new Arms(), t0 = host.sim.tick, speeds = [], at = aim();
  let shots = 0;
  for (let i = 0; i < 60 && shots < 10; i++) {
    await tick(1, () => {
      hold();
      const a = aim();
      const before = arms.wait;
      if (withTo) arms.update(STEP, B.c, a.h, a.pitch, null, true, { slot: 1, to: () => aimPoint(B.c, water, a.from, aimDir(a.h, a.pitch)) });
      else arms.update(STEP, B.c, a.h, a.pitch, null, true, { slot: 1, to: () => undefined });
      if (arms.wait > before) shots++;
      speeds.push(craft(id).core.motion.speed);
    });
  }
  await tick(8, hold);
  const s = shotsOf('B', t0), hits = s.filter((e) => e.hit?.kind === 'avatar' && e.hit.id === tAvatar().id).length;
  return { sent: shots, shots: s.length, hits, speed: Math.min(...speeds), dist: at.dist, bow: (at.bow * 180) / Math.PI };
};
// (the direction alone first: T unhurt, standing for both)
const dirOnly = await probe(false);
const hp = () => T.c.health('player:T')?.hp ?? 'full';
const hp0 = hp();
const withTo = await probe(true);
await tick(2);
const hp1 = hp();
check(withTo.speed > 13.5 && withTo.dist > 55 && withTo.sent === 10 && withTo.hits >= 8,
  `from a boat at ${withTo.speed.toFixed(1)} m/s, T ${withTo.dist.toFixed(0)} m off and ${Math.abs(withTo.bow).toFixed(0)}° off the bow, ~150 ms link: ${withTo.hits} of ${withTo.shots} shots hit (at least 8 of 10)`);
check(hp1 !== hp0, `T is hurt by them (${hp0} -> ${hp1})`);
check(dirOnly.shots === 10 && dirOnly.hits <= 3, `the same shots with a direction alone: ${dirOnly.hits} of ${dirOnly.shots} hit (the aim point is what makes them land)`);

// out of the swing: astern and straight up, within it (the boat brought to a stop first)
await tick(45, () => A.c.send({ kind: 'seatInput', role: 'pilot', input: { throttle: craft(id).core.motion.speed > 0.5 ? -1 : 0, steer: 0, drift: false } }));
const DEG = 180 / Math.PI;
const swing = async (to) => {
  const t0 = host.sim.tick;
  await tick(10);
  const p = craft(id).core.pose, from = mountPoint(GUN, p);
  B.c.send({ kind: 'fire', slot: 1, h: 0, pitch: 0, to: to(p, from) });
  await tick(6);
  const s = shotsOf('B', t0)[0];
  if (!s) return null;
  const dx = s.to.x - s.at.x, dy = s.to.y - s.at.y, dz = s.to.z - s.at.z, h = Math.atan2(dx, dz);
  return { off: Math.atan2(Math.sin(h - p.h), Math.cos(h - p.h)) * DEG, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG, from: Math.hypot(s.at.x - from.x, s.at.z - from.z) };
};
const astern = await swing((p, f) => ({ x: f.x - Math.sin(p.h) * 100, y: f.y, z: f.z - Math.cos(p.h) * 100 }));
const up = await swing((p, f) => ({ x: f.x + Math.sin(p.h) * 5, y: f.y + 100, z: f.z + Math.cos(p.h) * 5 }));
check(!!astern && Math.abs(astern.off) <= GUN.arc * DEG + 1 && Math.abs(astern.off) > 90 && astern.from < 1,
  `a shot aimed astern leaves at the swing's stop, from the mount (${astern && `${astern.off.toFixed(0)}° off the bow, ${astern.from.toFixed(2)} m from it`})`);
check(!!up && up.pitch <= GUN.pitch[1] * DEG + 0.5, `a shot aimed straight up leaves at the pitch's stop (${up?.pitch.toFixed(1)}°)`);
const t1 = host.sim.tick;
A.c.send({ kind: 'fire', slot: 1, h: 0, pitch: 0 });
await tick(6);
check(shotsOf('A', t1).length === 0, 'the wheel fires nothing');

// a player alone: from the wheel to the gun with C (nav/board.ts), fires, the boat drifting on; back to the wheel
const S = add('S');
const solo = await spawnBoat(S, 60, 15);
const sid = solo.id;
for (let i = 0; i < 90; i++) await tick(1, () => S.c.send({ kind: 'seatInput', role: 'pilot', input: { throttle: 1, steer: 0, drift: false } }));
let rode = null, boarded = null;
const shell = { id: 'boat', boards: ['boat'], board: (c, from) => { boarded = { c, from }; return true; } };
const nav = { sim: S.c, craft: shell, onFoot: false };
const swapper = new Boarding(nav, () => [shell], () => {}, () => ({ ride: (ref, type, label, from) => { rode = { ref, type, from }; return true; } }));
const v0 = craft(sid).core.motion.speed;
check(swapper.swap(), 'C at the wheel of a boat asks for its gun');
for (let i = 0; i < 8 && !rode; i++) { await tick(1); swapper.update(); }
check(S.c.seat()?.role === 'passenger' && rode?.ref.id === sid && rode.from === shell && craft(sid).pilot === null,
  `alone, from the wheel to the gun: the gunner's shell takes over from the boat's (${JSON.stringify(S.c.seat())})`);
let t2 = host.sim.tick;
const sp = craft(sid).core.pose, sf = mountPoint(GUN, sp);
S.c.send({ kind: 'fire', slot: 1, h: sp.h, pitch: 0, to: { x: sf.x + Math.sin(sp.h) * 50, y: sf.y, z: sf.z + Math.cos(sp.h) * 50 } });
await tick(20);
const ss = shotsOf('S', t2), v1 = craft(sid).core.motion.speed;
check(ss.length === 1, `the gun fires for the player alone (${ss.length} shot)`);
check(v1 > 0.5 && v1 < v0, `the boat drifts on without its pilot (${v0.toFixed(1)} -> ${v1.toFixed(1)} m/s)`);
nav.craft = { id: 'passenger' };
check(swapper.swap(), 'C at the gun asks for the free wheel');
for (let i = 0; i < 8 && !boarded; i++) { await tick(1); swapper.update(); }
check(S.c.seat()?.role === 'pilot' && boarded?.c.id === sid && boarded.from === nav.craft && craft(sid).pilot === 'S', 'back at the wheel: the boat\'s shell takes over from the gunner\'s');
const p0 = { ...craft(sid).core.pose };
for (let i = 0; i < 30; i++) await tick(1, () => S.c.send({ kind: 'seatInput', role: 'pilot', input: { throttle: 1, steer: 1, drift: false } }));
const p1 = craft(sid).core.pose;
check(Math.abs(p1.h - p0.h) > 0.2, `the wheel steers it again (turned ${(p1.h - p0.h).toFixed(2)} rad)`);

host.dispose?.();
if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
process.exit(0);
