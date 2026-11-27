// The player's avatar as another player sees it, on a synthetic world (flat ground, no roads: tools/lib.mjs synthData,
// a real host in Node, host/node.ts nodeHost, a few seconds): B's street life (view/life.ts, view/avatars.ts, three.js
// in Node, no renderer) of the host's world as its snapshots bring it. A walking in is a figure of its own at A's
// pose, not one of the crowd (the crowd's meshes and the crowd as many as before); its legs still standing, swinging
// at a walk and further and faster at a run; another player in another outfit; a place over its head for a name. A
// back in orbit mode is not seen at all; A in a craft is the craft alone, in no frame a figure beside it, and getting
// out A is a figure again beside it.
// usage (in web/): node tools/avatar.mjs; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { StreetLife } = await imp('src/view/life.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const G = 5;
const { dir, data } = await synthData({ size: [256, 256], ground: () => G, surface: () => 'earth' });
const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 120 }, data);

// players as the host names them (p1, p2, ...: their outfits are theirs by that name)
const player = (x, z, walk) => {
  const s = server.connect(), link = sessionLink(s);
  const c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, server.hello);
  c.send({ kind: 'view', view: { focus: { x, z } } });
  if (walk) c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: 0, moving: false } } });
  return { c, link, s };
};
const B = player(100, 128, false), all = [B];
const scene = new THREE.Scene(), life = new StreetLife(scene, B.c);
const frame = () => {
  for (const p of all) p.c.update(STEP);
  server.update(STEP);
  for (const p of all) p.link.deliver();
  life.update(STEP, 0, { x: 100, z: 128 });
};
const run = (s, each) => { for (let i = 0; i < s / STEP; i++) { each?.(i); frame(); } };
const crowd = () => ({ people: B.c.traffic.people.length + B.c.traffic.riders.length, legs: life.M.legs.count, torso: life.M.torso.count });
// A's figure as B draws it: its group in B's scene, where it stands
const figureOf = (p) => {
  const f = life.avatars?.figure?.(p.c.player);
  let inScene = false;
  f?.group.traverseAncestors((o) => { if (o === scene) inScene = true; });
  return f && inScene ? f : null;
};
const drawnOf = (p) => life.avatarsDrawn().find((a) => a.player === p.c.player);

run(0.5);
const before = crowd();
// A walks in by B
let ax = 90, az = 128;
const A = player(ax, az, true);
all.push(A);
const step = (v, moving = v > 0) => { ax += v * STEP; A.c.send({ kind: 'seatInput', role: 'walker', input: { x: ax, y: G, z: az, h: Math.PI / 2, moving } }); };
run(1, () => step(0));
const fA = figureOf(A), dA = drawnOf(A), after = crowd();
check(B.c.traffic.avatars.some((a) => a.player === A.c.player) && fA && dA && Math.hypot(dA.pose.x - ax, dA.pose.z - az) < 0.05 && Math.abs(dA.pose.h - Math.PI / 2) < 0.05
  && Math.hypot(fA.group.position.x - ax, fA.group.position.z - az) < 0.05,
  `B sees A on foot as a figure of its own at A's pose (drawn at ${dA?.pose.x.toFixed(2)}, ${dA?.pose.z.toFixed(2)}; A at ${ax}, ${az})`);
check(after.people === before.people && after.legs === before.legs && after.torso === before.torso && after.legs === after.people,
  `A is not one of the crowd: the crowd ${before.people} -> ${after.people}, its meshes' people ${before.legs} -> ${after.legs}`);
check(!!fA?.label && fA.label.parent === fA.group && fA.label.position.y > 1.8, `a place over A's head for a name (${fA?.label?.position.y.toFixed(2)} m up)`);

// the gait: the legs' swing (rad, most either way) and its cycles a second over s, at v m/s
const gait = (v, s) => {
  run(1, () => step(v));
  let most = 0, flips = 0, last = 0;
  run(s, () => {
    const f = figureOf(A), x = f ? f.legs[0].rotation.x : 0;
    most = Math.max(most, Math.abs(x));
    if (Math.sign(x) !== Math.sign(last) && x !== 0) flips++;
    last = x;
    step(v);
  });
  return { most, hz: flips / 2 / s };
};
const still = gait(0, 1), walk = gait(2.2, 3), sprint = gait(6.5, 3);
check(still.most < 0.02 && walk.most > 0.3 && sprint.most > walk.most + 0.2 && sprint.hz > walk.hz * 1.3 && walk.hz > 0.8,
  `A's legs follow A's speed: still ${still.most.toFixed(2)} rad, walking ${walk.most.toFixed(2)} rad at ${walk.hz.toFixed(2)} Hz, running ${sprint.most.toFixed(2)} rad at ${sprint.hz.toFixed(2)} Hz`);

// another player on foot: another outfit
const C = player(95, 135, true);
all.push(C);
run(1, () => step(0));
const fC = figureOf(C), shirt = (f) => f?.body.children.find((o) => o.isMesh)?.material.color.getHexString();
check(fA && fC && fA !== fC && shirt(fA) !== shirt(fC),
  `two players are told apart: A's shirt #${shirt(fA)}, C's #${shirt(fC)}`);

// A back in orbit mode (nav.ts: off foot the body is left): no body at all
A.c.send({ kind: 'leaveSeat' });
run(1);
check(!figureOf(A) && !drawnOf(A) && !B.c.traffic.avatars.some((a) => a.player === A.c.player) && figureOf(C),
  `A in orbit mode is not seen (figure ${!!figureOf(A)}, avatar sent ${B.c.traffic.avatars.some((a) => a.player === A.c.player)}); C still is`);

// A on foot again, then into a craft at its feet: the craft only, in every frame; out again: a figure beside it
A.c.send({ kind: 'request', request: { kind: 'walk', pose: { x: ax, y: G, z: az, h: 0, moving: false } } });
run(1, () => step(0));
const back = !!figureOf(A);
A.c.send({ kind: 'request', request: { kind: 'craft', type: 'hovercraft', spot: { x: ax, y: G + 1, z: az, h: 0 } } });
let both = 0, crafted = 0;
run(2, () => {
  const craft = B.c.crafts().some((c) => c.pilot === A.c.player);
  if (craft) crafted++;
  if (craft && (figureOf(A) || drawnOf(A))) both++;
});
const hc = B.c.crafts().find((c) => c.pilot === A.c.player);
check(back && hc && crafted > 0 && both === 0 && !figureOf(A), `A in a craft: B sees the craft and no figure (${crafted} frames with A's craft, ${both} with a figure too)`);
const at = hc?.core.pose ?? { x: ax, z: az };
A.c.send({ kind: 'leaveSeat', pose: { x: at.x + 5, y: G, z: at.z, h: 0, moving: false } });
run(1);
const out = drawnOf(A);
check(figureOf(A) && out && Math.hypot(out.pose.x - at.x, out.pose.z - at.z) > 1 && Math.hypot(out.pose.x - at.x, out.pose.z - at.z) < 6 && B.c.crafts().some((c) => c.type === 'hovercraft' && c.pilot === null),
  `A out of the craft: a figure beside it again (${out && Math.hypot(out.pose.x - at.x, out.pose.z - at.z).toFixed(1)} m off), the craft left standing`);

server.dispose?.();
for (const f of fail) console.log(`FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
