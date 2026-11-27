// Riding along in another player's craft, through the real host (host/node.ts nodeHost, SimServer sessions, a client
// per player over a CloneLink, so commands cross as JSON) on a synthetic flat world: a player on foot beside a
// hovercraft another flies takes a passenger's seat; another page sees their body gone and them aboard; their input
// steers nothing; flown far off, their own page still has the craft where the host has it; out onto foot beside it;
// back in; the pilot gets out and the passenger stays aboard, the pilot's seat free for the next; a helicopter takes
// three passengers and refuses a fourth; a player without a body (orbit mode) is refused; the craft taken away puts its
// passengers on foot beside where it was, on the ground under it. What the players see of it (view/life.ts and
// view/avatars.ts drawing another page's street life, view/seats.ts, three.js in Node, no renderer): a passenger sits
// in their seat in the cabin, legs forward, a place for the name over the head, following the craft as it is flown
// and not standing on foot beside it; three in the helicopter each in a seat of their own under its roof. Getting in
// (nav/board.ts): a craft with a free seat beside another's pilot is offered to ride along in, a full one not. The
// pilot's page draws the craft in every frame after getting out of it (view/crafts/crafts-view.ts).
// usage (in web/): node tools/passengers.mjs; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp, sessionLink, synthData } from './lib.mjs';

// (Boarding listens for its key on the window: none here)
globalThis.addEventListener ??= () => {};

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { fromBox } = await imp('src/sim/walk-bounds.ts');
const { craftBox } = await imp('src/sim/solids.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');
const { StreetLife } = await imp('src/view/life.ts');
const { HIPS } = await imp('src/view/avatars.ts');
const { CraftsView } = await imp('src/view/crafts/crafts-view.ts');
const { Boarding } = await imp('src/nav/board.ts');
const { CRAFT_SCALE } = await imp('src/sim/craft/craft-motion.ts');
const BOARD = DEFAULT_TUNING.walk.board;

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const settle = () => new Promise((r) => setImmediate(r));

const G = 5;
const { dir, data } = await synthData({ size: [512, 256], ground: () => G, boxes: [] });
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 30 }, data);
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const all = [], lives = [];
const add = (name) => {
  const link = sessionLink(host.connect(name)), c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
  const p = { c, link, name };
  all.push(p);
  return p;
};
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    for (const p of all) p.c.update(STEP);
    host.update(STEP);
    for (const p of all) p.link.deliver();
    for (const l of lives) l.update(STEP, 0, { x: 0, z: 0 });
    await settle();
  }
};
// a page's street life drawn as its frames go (in a scene of its own)
const watch = (p) => {
  const scene = new THREE.Scene(), life = new StreetLife(scene, p.c);
  lives.push(life);
  return { scene, life };
};
// player name's figure as page W draws it, sitting: its hips and the top of its head in craft id's frame as W draws
// the craft (metres of its look: s its scale), its legs' angle, its name's place over the hips (m), on foot or not
const sitting = (W, p, name, id, s = 1) => {
  const f = W.life.avatars.figure(name), c = p.c.crafts().find((o) => o.id === id);
  if (!f || !c) return null;
  W.scene.updateMatrixWorld(true);
  const d = c.core.drawn(p.c.time.alpha), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-d.pitch, d.h, d.bank, 'YXZ')).invert();
  const local = (v) => v.sub(new THREE.Vector3(d.x, d.y, d.z)).applyQuaternion(q).divideScalar(s);
  const hips = f.group.localToWorld(new THREE.Vector3(0, HIPS, 0)), label = f.label.getWorldPosition(new THREE.Vector3());
  return { hips: local(hips.clone()), top: local(f.group.localToWorld(new THREE.Vector3(0, HIPS + 0.97, 0))), legs: f.legs[0].rotation.x,
    label: label.y - hips.y, onFoot: W.life.avatarsDrawn().some((a) => a.player === name) };
};
// in the hovercraft's cabin (its look: 4.2 m across, from 2.6 m aft to 4 m forward of the origin, the roof at 2.6 m),
// the head in its window band (1.3 to 2.05 m up), the legs forward, a name's place over the head
const inCabin = (t) => !!t && Math.abs(t.hips.x) < 2 && t.hips.z > -2.6 && t.hips.z < 4 && t.hips.y > 0.5 && t.top.y < 2.6
  && t.top.y - 0.4 > 1.3 && t.top.y - 0.15 < 2.05 && t.legs < -1 && t.label > 1.1 && !t.onFoot;
// what a page on foot at pose is offered to get into (nav/board.ts), as its button says
const offer = (p, pose) => {
  const b = new Boarding({ sim: p.c, life: null, onFoot: true, mapPose: () => pose }, () => [], () => {}, () => ({}));
  b.update();
  return b.label(false);
};
const walk = (p, x, z, h = 0) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h, moving: false } } });
};
const avatarOf = (c, name) => c.traffic.avatars.find((a) => a.player === name);
const seatOf = (p) => p.c.seat();
const aboard = (p, id) => { const s = seatOf(p); return s?.role === 'passenger' && s.entity.kind === 'craft' && s.entity.id === id; };
const board = async (p, id, role = 'passenger') => {
  p.c.results('enterSeat');
  p.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id }, role });
  await tick(2);
  return p.c.results('enterSeat');
};
const craft = (id) => host.sim.crafts.get(id);
const boxOf = (id) => craftBox(craft(id).type, craft(id).core.pose);
// a spot d m off a craft's side (side 1 or -1), along m along it
const beside = (id, side, d, along = 0) => {
  const b = craftBox(craft(id).type, craft(id).core.pose), c = Math.cos(b.h), s = Math.sin(b.h), a = side * (b.r + d);
  return { x: b.x + a * c + along * s, z: b.z - a * s + along * c };
};
const spawn = async (p, type, x, z, h) => {
  walk(p, x - 15, z);
  await tick(3);
  p.c.send({ kind: 'request', request: { kind: 'craft', type, spot: { x, y: G + SPAWN_HEIGHT[type], z, h } } });
  await tick(30);
  return p.c.craftOf();
};

// the hovercraft: A flies, B rides along, C watches
{
  const A = add('A'), B = add('B'), C = add('C'), W = watch(C);
  const hover = await spawn(A, 'hovercraft', 100, 100, Math.PI / 2);
  check(hover?.type === 'hovercraft', 'a hovercraft made, its maker its pilot');
  const id = hover.id;
  let s = beside(id, 1, 1);
  walk(B, s.x, s.z);
  s = beside(id, -1, 4);
  walk(C, s.x, s.z);
  await tick(3);
  check(seatOf(B)?.role === 'walker' && !!avatarOf(C.c, 'B'), 'a player on foot beside it, seen by another page');
  const sb = beside(id, 1, 1), sbOffer = offer(B, { x: sb.x, y: G, z: sb.z, h: 0 });
  check(sbOffer === 'Ride along in hovercraft', `beside it another flies, a seat in it offered (${sbOffer})`);

  let r = await board(B, id, 'pilot');
  check(r.length === 1 && !r[0].ok && r[0].reason === 'taken', `its pilot's seat refused as taken (${JSON.stringify(r)})`);
  r = await board(B, id);
  check(r.some((x) => x.ok) && aboard(B, id), `a passenger's seat taken beside it (${JSON.stringify(r)})`);
  await tick(2);
  check(!avatarOf(C.c, 'B') && C.c.passengers().some(([k, c, p]) => k === 'craft' && c === id && p === 'B'),
    'another page sees the body gone and the player aboard');
  const seen = sitting(W, C, 'B', id);
  check(inCabin(seen), `another page draws the passenger sitting in the cabin, the head in its windows, the legs forward, a name over them (${JSON.stringify(seen)})`);

  const p0 = { ...craft(id).core.pose };
  for (let i = 0; i < 45; i++) {
    B.c.send({ kind: 'seatInput', role: 'pilot', input: { drive: 1, turn: 1, lift: 0, side: 0 } });
    await tick(1);
  }
  const p1 = craft(id).core.pose;
  check(Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.5 && aboard(B, id), `the passenger's input steers nothing (moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)} m)`);

  let away = 0, followed = 0;
  for (let i = 0; i < 150; i++) {
    A.c.send({ kind: 'seatInput', role: 'pilot', input: { drive: 1, turn: 0, lift: 0, side: 0 } });
    // (C keeps it in view, walking along)
    const q = craft(id).core.pose;
    C.c.send({ kind: 'view', view: { focus: { x: q.x, z: q.z } } });
    await tick(1);
    if (inCabin(sitting(W, C, 'B', id))) followed++; else away++;
  }
  check(away === 0 && followed === 150, `the passenger sits in it in every frame as it is flown off (${followed} in, ${away} not)`);
  A.c.send({ kind: 'seatInput', role: 'pilot', input: { drive: -1, turn: 0, lift: 0, side: 0 } });
  await tick(60);
  A.c.send({ kind: 'seatInput', role: 'pilot', input: { drive: 0, turn: 0, lift: 0, side: 0 } });
  await tick(60);
  const p2 = craft(id).core.pose, mine = B.c.crafts().find((c) => c.id === id)?.core.pose;
  const gone = Math.hypot(p2.x - p0.x, p2.z - p0.z), off = mine ? Math.hypot(mine.x - p2.x, mine.z - p2.z) : Infinity;
  check(gone > 50 && aboard(B, id) && off < 1, `flown ${gone.toFixed(0)} m by its pilot, the passenger aboard, their page has it where the host has it (${off.toFixed(2)} m off)`);

  s = beside(id, -1, 3);
  walk(C, s.x, s.z);
  await tick(3);
  B.c.send({ kind: 'leaveSeat', pose: { x: p2.x + 50, y: p2.y, z: p2.z, h: 0, moving: false } });
  await tick(2);
  let a = avatarOf(C.c, 'B'), d = a ? fromBox(a.pose, boxOf(id)) : Infinity;
  check(seatOf(B)?.role === 'walker' && d <= BOARD + 0.01, `out on foot beside it (${d.toFixed(2)} m from its side), not where the page asked`);
  check(craft(id).pilot === 'A', 'its pilot still at the controls');

  r = await board(B, id);
  check(aboard(B, id), `back aboard (${JSON.stringify(r)})`);
  // (A's page: while its shell flies the craft the shell draws it; out of it, from the same frame on, the crafts view)
  const shown = new THREE.Group(), view = new CraftsView(shown), drawn = () => shown.children.some((g) => g.visible);
  view.update(A.c, STEP, 0, true);
  const byShell = !drawn();
  A.c.send({ kind: 'leaveSeat' });
  let gap = 0;
  for (let i = 0; i < 30; i++) {
    view.update(A.c, STEP, 0, false);
    if (!drawn()) gap++;
    await tick(1);
  }
  check(byShell && gap === 0, `the pilot's page draws the craft in every frame after getting out (${gap} frames not; left to the shell while flying ${byShell})`);
  check(craft(id)?.pilot === null && aboard(B, id), 'the pilot out, the passenger stays aboard');
  s = beside(id, -1, 1);
  walk(A, s.x, s.z);
  await tick(3);
  r = await board(A, id, 'pilot');
  check(craft(id).pilot === 'A' && aboard(B, id), `the pilot's seat free for the next (${JSON.stringify(r)})`);

  // a second passenger, then the craft taken away under both
  r = await board(C, id);
  check(aboard(C, id), `a second passenger aboard (${JSON.stringify(r)})`);
  const b = boxOf(id);
  host.sim.removeCraft(id);
  await tick(3);
  const out = ['B', 'C'].map((n) => avatarOf(A.c, n));
  const ds = out.map((x) => (x ? fromBox(x.pose, b) : Infinity));
  check(seatOf(B)?.role === 'walker' && seatOf(C)?.role === 'walker' && ds.every((x) => x <= BOARD + 0.01) && out.every((x) => Math.abs(x.pose.y - G) < 0.6),
    `taken away: its passengers on foot beside where it was, on the ground (${ds.map((x) => x.toFixed(2))} m)`);
}

// the helicopter: three passengers, not four; one without a body is refused
{
  const P = add('P'), riders = ['R1', 'R2', 'R3', 'R4'].map(add), O = add('O'), W = watch(O);
  const heli = await spawn(P, 'helicopter', 350, 120, 0);
  check(heli?.type === 'helicopter', 'a helicopter made');
  const id = heli.id;
  riders.forEach((p, i) => { const s = beside(id, i % 2 ? -1 : 1, 1, i < 2 ? -1 : 1); walk(p, s.x, s.z); });
  O.c.send({ kind: 'view', view: { focus: { x: 350, z: 120 } } });
  await tick(3);
  const spot = (i) => { const s = beside(id, i % 2 ? -1 : 1, 1, i < 2 ? -1 : 1); return { x: s.x, y: G, z: s.z, h: 0 }; };
  const before = offer(riders[3], spot(3));
  const answers = [];
  for (const p of riders) answers.push(await board(p, id));
  const ok = riders.filter((p) => aboard(p, id)).length, last = answers[3];
  check(ok === 3 && last.length === 1 && !last[0].ok && last[0].reason === 'taken' && seatOf(riders[3])?.role === 'walker',
    `three passengers aboard, the fourth refused as taken (${JSON.stringify(last)})`);
  const full = offer(riders[3], spot(3));
  check(before === 'Ride along in helicopter' && full === null, `beside it the seat offered while one is free (${before}), not once it is full (${full})`);
  await tick(2);
  const S = CRAFT_SCALE.helicopter, three = riders.slice(0, 3).map((p) => sitting(W, O, p.name, id, S));
  // (inside its body: 1.5 m across, 1.35 m aft and 1.25 m forward of the origin, the roof 0.875 m up, before the scale)
  const inside = three.every((t) => t && Math.abs(t.hips.x) < 0.75 && t.hips.z > -1.35 && t.hips.z < 1.25 && t.top.y < 0.875 && t.legs < -1 && !t.onFoot);
  const apart = three.every((t, i) => three.every((u, j) => i === j || (t && u && t.hips.distanceTo(u.hips) > 0.35)));
  check(inside && apart, `another page draws the three sitting in its cabin under its roof, each in a seat of their own (hips, head's top: ${three.map((t) => t && `${[t.hips.x, t.hips.y, t.hips.z].map((v) => v.toFixed(2))} ${t.top.y.toFixed(2)}`).join('; ')})`);
  const r = await board(O, id);
  check(r.length === 1 && !r[0].ok && seatOf(O) === null, `a player without a body (orbit mode) refused (${JSON.stringify(r)})`);
}

host.dispose();
if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS passengers');
