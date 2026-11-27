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
// pilot's page draws the craft in every frame after getting out of it (view/crafts/crafts-view.ts). Over a link that
// holds each message 70 ms, the pilot's page (prediction on) keeps the passenger within 3 cm of their seat on the craft
// as it draws it, every frame of a flight, while the snapshot's craft lies metres off. A page beside a parked car sees
// its passenger and its driver through the side windows (a ray meets their figure first), from behind and ahead through
// its rear window and windscreen, an empty car stays closed; a van's and a camper's the same; the driver's own page draws them in it from the chase
// view, not from their own eyes. Another page sees each craft's pilot through its glass (the drone has none); a
// passenger's page draws the pilot and the others, itself only from the chase view; from each seat's eyes no other
// figure is within the camera's near plane.
// Out by key: X out of any vehicle (the helicopter, hovercraft and drone keep E for themselves), E where it is free.
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
const { seatPlace, seatEye, pilotPlace, SEAT_NEAR } = await imp('src/view/seats.ts');
const { TileCache } = await imp('src/core/tile-cache.ts');
const { fetchGzip } = await imp('src/fetch.ts');
const { CRAFT_SCALE } = await imp('src/sim/craft/craft-motion.ts');
const BOARD = DEFAULT_TUNING.walk.board;

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const settle = () => new Promise((r) => setImmediate(r));

const G = 5;
// (a pond in a corner for the boat)
const pond = (x, z) => x >= 420 && z < 60;
const { dir, data } = await synthData({ size: [512, 256], ground: (x, z) => (pond(x, z) ? G - 1 : G), surface: (x, z) => (pond(x, z) ? 'water' : 'road'), boxes: [] });
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 30 }, data);
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const all = [], lives = [], views = [];
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
    for (const [v, c] of views) v.update(c, STEP, 0, false);
    await settle();
  }
};
// a page's street life drawn as its frames go (in a scene of its own), and the crafts other players fly
const watch = (p) => {
  const scene = new THREE.Scene(), life = new StreetLife(scene, p.c), crafts = new THREE.Group();
  scene.add(crafts);
  lives.push(life);
  views.push([new CraftsView(crafts), p.c]);
  return { scene, life };
};
// what a ray from `from` to `to` meets first in page W's scene that is drawn and not glass seen through
const ray = new THREE.Raycaster();
const firstSeen = (W, from, to) => {
  W.scene.updateMatrixWorld(true);
  W.scene.traverse((o) => { if (o.isInstancedMesh) o.boundingSphere = null; });
  ray.set(from, to.clone().sub(from).normalize());
  ray.far = from.distanceTo(to) + 1;
  const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  return ray.intersectObject(W.scene, true).find((h) => shown(h.object) && !h.object.material.transparent)?.object ?? null;
};
// player name's figure as page W draws it, if it does
const shownFigure = (W, name) => {
  const f = W.life.avatars.figure(name);
  for (let o = f?.group; o; o = o.parent) if (!o.visible) return null;
  return f?.group.parent ? f : null;
};
const of = (f, o) => { for (let p = o; p; p = p.parent) if (p === f.group) return true; return false; };
// whether page W sees name's head from m metres off along its own figure's direction (x left, y up, z ahead), or what it
// meets first
const seesHead = (W, name, dir, m = 5) => {
  const f = shownFigure(W, name);
  if (!f) return 'not drawn';
  W.scene.updateMatrixWorld(true);
  const head = f.group.localToWorld(new THREE.Vector3(0, HIPS + 0.75, 0));
  const from = f.group.localToWorld(new THREE.Vector3(0, HIPS + 0.75, 0).addScaledVector(new THREE.Vector3(...dir).normalize(), m));
  const hit = firstSeen(W, from, head);
  return of(f, hit) ? null : `${hit?.name || hit?.type || 'nothing'} met first`;
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
  const P = add('P'), riders = ['R1', 'R2', 'R3', 'R4'].map(add), O = add('O'), W = watch(O), W1 = watch(riders[0]);
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
  // a passenger's own page: the pilot at the front and the two others in their seats; themself too while the camera
  // follows the craft, not from their own seat's eyes
  const others = ['P', 'R2', 'R3'].map((n) => [n, sitting(W1, riders[0], n, id, S)]);
  const chased = !!shownFigure(W1, 'R1');
  W1.life.ownEyes = true;
  await tick(1);
  const fromSeat = { own: !!shownFigure(W1, 'R1'), others: ['P', 'R2', 'R3'].filter((n) => shownFigure(W1, n)).length };
  W1.life.ownEyes = false;
  const pilot = pilotPlace('helicopter'), atWheel = others[0][1]?.hips.distanceTo(new THREE.Vector3(pilot.x, pilot.y, pilot.z).divideScalar(S));
  check(others.every(([, t]) => t && !t.onFoot) && atWheel < 0.05 && chased && !fromSeat.own && fromSeat.others === 3,
    `a passenger's page draws the pilot at the controls (${atWheel?.toFixed(2)} m off its seat) and the others in their seats; itself in the chase view (${chased}), not from its seat's eyes (${fromSeat.own ? 'drawn' : 'not drawn'}, the others ${fromSeat.others} of 3)`);
  // the seat view's eyes (nav/passenger.ts): no one else's figure within the camera's near plane of them
  W.scene.updateMatrixWorld(true);
  const c = O.c.crafts().find((o) => o.id === id), dr = c.core.drawn(O.c.time.alpha);
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(-dr.pitch, dr.h, dr.bank, 'YXZ'));
  const near = O.c.passengers().filter(([k, cid]) => k === 'craft' && cid === id).map(([, , who, i]) => {
    const e = seatEye(seatPlace('craft', 'helicopter', i)), eye = new THREE.Vector3(e.x, e.y, e.z).applyQuaternion(turn).add(new THREE.Vector3(dr.x, dr.y, dr.z));
    let d = Infinity;
    for (const n of ['P', 'R1', 'R2', 'R3']) {
      if (n === who) continue;
      W.life.avatars.figure(n)?.group.traverse((m) => { if (m.isMesh) d = Math.min(d, new THREE.Box3().setFromObject(m).distanceToPoint(eye)); });
    }
    return d;
  });
  check(near.length === 3 && near.every((d) => d > SEAT_NEAR), `from each seat's eyes no other figure nearer than the near plane (${near.map((d) => d.toFixed(2))} m; ${SEAT_NEAR} m)`);
  const r = await board(O, id);
  check(r.length === 1 && !r[0].ok && seatOf(O) === null, `a player without a body (orbit mode) refused (${JSON.stringify(r)})`);
}

// the pilot's own page over a slow link (its craft run ahead of the host: client/predict.ts): who rides along sits in
// their seat on the craft as it is drawn there, in every frame, never left behind where the snapshot has it
{
  const LAG = 0.07, F = STEP / 2;
  let t = 0;
  // a link to a session holding each message LAG s each way on the tool's clock t
  const lagged = (session) => {
    const up = [], down = [];
    let greeted = false;
    return {
      onHello() {}, onSnapshot() {},
      send(commands) { up.push([t + LAG, JSON.parse(JSON.stringify(commands))]); },
      close() { session.leave(); },
      pass() {
        while (up.length && up[0][0] <= t + 1e-9) for (const c of up.shift()[1]) session.send(c);
        while (down.length && down[0][0] <= t + 1e-9) this.onSnapshot(down.shift()[1]);
      },
      deliver() {
        if (!greeted) { greeted = true; this.onHello(session.hello); }
        down.push([t + LAG, structuredClone(session.snapshot())]);
      },
    };
  };
  const link = lagged(host.connect('P2')), world = { meta: data.meta, cache: new TileCache({ N: data.meta.tiles.N, load: (p) => fetchGzip(`data/tiles/${p}`) }), now: () => performance.now() };
  const P = { c: new MirrorSimClient(link, traffic(), null, host.hello, undefined, null, world), link, name: 'P2' };
  const scene = new THREE.Scene(), life = new StreetLife(scene, P.c), Q = add('Q');
  // a frame of P's page (a host tick every other one), then who rides along as P's page draws them on its craft
  let n = 0;
  const frame = async (input) => {
    t += F;
    if (n++ % 2 === 0) {
      for (const p of all) p.c.update(STEP);
      link.pass();
      host.update(STEP);
      for (const p of all) p.link.deliver();
      link.deliver();
    }
    link.pass();
    if (input && P.c.craftOf()) P.c.send({ kind: 'seatInput', role: 'pilot', input });
    P.c.update(F);
    life.update(F, 0, { x: 100, z: 200 });
    await settle();
  };
  P.c.send({ kind: 'view', view: { focus: { x: 100, z: 200 } } });
  P.c.send({ kind: 'request', request: { kind: 'walk', pose: { x: 90, y: G, z: 200, h: 0, moving: false } } });
  for (let i = 0; i < 10; i++) await frame();
  P.c.send({ kind: 'request', request: { kind: 'craft', type: 'hovercraft', spot: { x: 100, y: G + SPAWN_HEIGHT.hovercraft, z: 200, h: Math.PI / 2 } } });
  for (let i = 0; i < 600 && !P.c.craftOf(); i++) { await frame(); await new Promise((r) => setTimeout(r, 1)); }
  const id = P.c.craftOf()?.id;
  const s = id !== undefined && beside(id, 1, 1);
  if (s) walk(Q, s.x, s.z);
  for (let i = 0; i < 10; i++) await frame();
  Q.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'passenger' });
  for (let i = 0; i < 20; i++) await frame();
  check(aboard(Q, id) && P.c.craftOf()?.core !== P.c.craftOf(true)?.core, `the pilot's page runs its craft ahead over a link of ${LAG * 2000} ms round trip, a passenger aboard`);
  let worst = 0, apart = 0, seen = 0;
  const go = { drive: 1, turn: 0, lift: 0, side: 0 }, turn = { drive: 1, turn: 1, lift: 0, side: 0 };
  for (let i = 0; i < 300; i++) {
    await frame(i < 120 ? go : i < 200 ? turn : i < 240 ? go : { drive: 0, turn: 0, lift: 0, side: 0 });
    const f = life.avatars.figure('Q'), c = P.c.craftOf(), sent = P.c.craftOf(true), seat = P.c.passengers().find(([, , p]) => p === 'Q');
    if (!f || !c || !seat) { worst = Infinity; continue; }
    scene.updateMatrixWorld(true);
    const d = c.core.drawn(P.c.ownAlpha), e = sent.core.drawn(P.c.time.alpha), place = seatPlace('craft', c.type, seat[3]);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-d.pitch, d.h, d.bank, 'YXZ')).invert();
    const hips = f.group.localToWorld(new THREE.Vector3(0, HIPS, 0)).sub(new THREE.Vector3(d.x, d.y, d.z)).applyQuaternion(q);
    worst = Math.max(worst, hips.distanceTo(new THREE.Vector3(place.x, place.y, place.z)));
    apart = Math.max(apart, Math.hypot(d.x - e.x, d.z - e.z));
    seen++;
  }
  check(seen === 300 && worst < 0.03 && apart > 0.5,
    `on the pilot's page the passenger sits in their seat on the craft as drawn in every frame (${seen} frames, at most ${(worst * 100).toFixed(1)} cm off; the snapshot's craft up to ${apart.toFixed(2)} m from it)`);
  link.close();
}

// a car another player drives with a passenger: a page beside it sees both through its side windows; a car nobody
// sits in keeps its solid cabin
{
  const X = 300, Z = 200, H = Math.PI / 2;
  const parked = (id, x) => ({ kind: 'car', id, e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
    col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null, geo: { px: 0, py: 0, cx: x, cy: Z, z: G, fx: 0, fy: 1 },
    detachedPose: { x, y: G, z: Z, h: H, pitch: 0, roll: 0 } });
  const car = parked(9001, X), empty = parked(9002, X + 12);
  host.sim.traffic.detachedCars.push(car, empty);
  const D = add('D'), E = add('E'), V = add('V'), W = watch(V), WD = watch(D);
  walk(D, X, Z - 1.6);
  walk(E, X, Z + 1.6);
  walk(V, X + 6, Z - 8);
  await tick(5);
  await host.sim.loadPhysics({ x: X, z: Z });
  D.c.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' });
  await tick(5);
  E.c.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'passenger' });
  await tick(10);
  check(seatOf(D)?.role === 'driver' && seatOf(E)?.role === 'passenger', `one at the wheel of a parked car, another beside them (${JSON.stringify([seatOf(D), seatOf(E)])})`);
  const d = W.life.drawn('car', car.id), side = new THREE.Vector3(Math.cos(H), 0, -Math.sin(H));
  const looks = [['E', -1, 'the passenger'], ['D', 1, 'the driver']].map(([name, s, who]) => {
    const f = W.life.avatars.figure(name);
    if (!f || !d) return `${who}: not drawn`;
    const head = f.group.localToWorld(new THREE.Vector3(0, HIPS + 0.75, 0)), hit = firstSeen(W, head.clone().addScaledVector(side, 4 * s), head);
    return of(f, hit) ? null : `${who}: ${hit?.type ?? 'nothing'} met first`;
  });
  check(looks.every((l) => l === null), `a page beside the car sees the passenger and the driver through its side windows (${looks.filter(Boolean).join('; ') || 'both'})`);
  const at = new THREE.Vector3(X + 12, G + 1.3, Z), hit = firstSeen(W, at.clone().addScaledVector(side, -4), at);
  check(hit?.isInstancedMesh && !hit.material.transparent, `a car nobody sits in keeps its solid cabin (a ray at its windows meets ${hit?.type ?? 'nothing'})`);
  // from behind, through the rear window; from ahead, through the windscreen
  const ends = [['V', 'E', [0, 0, -1]], ['V', 'D', [0, 0, 1]]].map(([, who, dir]) => [who, dir[2] < 0 ? 'behind' : 'ahead', seesHead(W, who, dir, 6)]);
  check(ends.every(([, , l]) => l === null), `a page sees who sits in the car from behind and from ahead, through its rear window and windscreen (${JSON.stringify(ends)})`);
  // the driver's own page: themself in the car from the chase view behind it; from the driver's eyes no own figure,
  // the passenger still beside them
  const chase = seesHead(WD, 'D', [0, 0.1, -1], 8);
  WD.life.ownEyes = true;
  await tick(2);
  const eyes = { own: !!shownFigure(WD, 'D'), passenger: seesHead(WD, 'E', [-1, 0, 0], 4) };
  WD.life.ownEyes = false;
  check(chase === null && !eyes.own && eyes.passenger === null,
    `the driver's own page draws them in the car seen from behind (${chase ?? 'seen'}), not from their own eyes (${eyes.own ? 'drawn' : 'not drawn'}), the passenger there either way (${eyes.passenger ?? 'seen'})`);
}

// the van and the camper van the same: their load space and living box no wall in the way from behind, the van's
// windscreen none from ahead (the camper's front passenger sits in its cab, the whole box behind them)
for (const [vt, len, X] of [['van', 5.4, 340], ['camper', 6.6, 380]]) {
  const Z = 200, H = Math.PI / 2, id = vt === 'van' ? 9003 : 9004;
  const car = { kind: 'car', id, vt, e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len, bus: false,
    col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null, geo: { px: 0, py: 0, cx: X, cy: Z, z: G, fx: 0, fy: 1 },
    detachedPose: { x: X, y: G, z: Z, h: H, pitch: 0, roll: 0 } };
  host.sim.traffic.detachedCars.push(car);
  const [d, e] = [`D-${vt}`, `E-${vt}`], D = add(d), E = add(e), V = add(`V-${vt}`), W = watch(V);
  walk(D, X, Z - 1.6);
  walk(E, X, Z + 1.6);
  walk(V, X + 6, Z - 8);
  await tick(5);
  await host.sim.loadPhysics({ x: X, z: Z });
  D.c.send({ kind: 'enterSeat', entity: { kind: 'car', id }, role: 'driver' });
  await tick(5);
  E.c.send({ kind: 'enterSeat', entity: { kind: 'car', id }, role: 'passenger' });
  await tick(10);
  const seen = { seated: seatOf(D)?.role === 'driver' && seatOf(E)?.role === 'passenger' ? null : 'not seated',
    side: [seesHead(W, e, [-1, 0, 0], 4), seesHead(W, d, [1, 0, 0], 4)].find(Boolean) ?? null,
    behind: seesHead(W, e, [0, 0, -1], 9), ahead: seesHead(W, d, [0, 0, 1], 9) };
  check(Object.values(seen).every((l) => l === null), `a page sees who sits in a ${vt} through its side windows, from behind through its rear window and from ahead through its windscreen (${JSON.stringify(seen)})`);
}

// the crafts' pilots seen by another page through the glass round them: the helicopter's front glass, the hovercraft's
// wheelhouse, the boat's, the floatplane's, the jet's and the combat plane's cockpits, the paraglider's harness; none in a drone
{
  const V = add('PV'), W = watch(V), seen = [];
  const flights = [
    ['helicopter', 60, 220, G + SPAWN_HEIGHT.helicopter, 0, [[0, 0, 1]]],
    ['hovercraft', 120, 220, G + SPAWN_HEIGHT.hovercraft, 0, [[0, 0, 1], [1, 0, 0]]],
    ['boat', 470, 30, G - 1, 0, [[1, 0.3, 0]]],
    ['floatplane', 200, 230, G + 20, 0, [[1, 0, 0]]],
    ['jet', 260, 230, G + 20, 0, [[1, 0.3, 0]]],
    ['fighter', 380, 230, G + 20, 0, [[1, 0.3, 0], [0, 1, 0]]],
    ['paraglider', 320, 230, G + 60, 0, [[0, 0, 1]]],
  ];
  for (const [type, x, z, y, h, dirs] of flights) {
    const P = add(`F${seen.length}`);
    walk(P, x - 15, z);
    await tick(3);
    P.c.send({ kind: 'request', request: { kind: 'craft', type, spot: { x, y, z, h } } });
    V.c.send({ kind: 'view', view: { focus: { x, z } } });
    await tick(30);
    const c = P.c.craftOf();
    if (c) { const q = c.core.pose; V.c.send({ kind: 'view', view: { focus: { x: q.x, z: q.z } } }); }
    await tick(3);
    seen.push([type, c ? dirs.map((d) => seesHead(W, P.name, d)).find((l) => l === null) ?? seesHead(W, P.name, dirs[0]) : 'no craft']);
    if (c) host.sim.removeCraft(c.id);
  }
  check(seen.every(([, l]) => l === null) && pilotPlace('drone') === null,
    `another page sees each craft's pilot through its glass, none in a drone (${seen.map(([t, l]) => `${t}: ${l ?? 'seen'}`).join('; ')})`);
}

// getting out by key (nav/board.ts): X out of any vehicle, E only out of one whose own keys leave it free
{
  const keys = (id) => {
    let outs = 0;
    const b = new Boarding({ sim: null, onFoot: false, craft: { id }, craftView: true, mode: 'craft', getOut: () => ++outs > 0 }, () => [], () => {}, () => null);
    return { label: b.label(true), e: b.press('KeyE'), eOuts: outs, x: b.press('KeyX'), outs };
  };
  const shown = ['helicopter', 'hovercraft', 'fpv', 'drive'].map((id) => ({ id, ...keys(id) }));
  check(shown.every((k) => k.x && k.outs === k.eOuts + 1 && k.label === (k.id === 'drive' ? 'E: get out' : 'X: get out') && k.e === (k.id === 'drive') && k.eOuts === (k.id === 'drive' ? 1 : 0)),
    `X gets out of the helicopter, the hovercraft, the drone and a car, E only out of the car, the button saying which (${JSON.stringify(shown)})`);
}

host.dispose();
if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS passengers');
