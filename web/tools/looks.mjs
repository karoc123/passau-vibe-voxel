// The looks of what moves in the street, from their meshes alone (no page, no GPU): the traffic's vehicles closed and
// opened (view/meshes.ts), the river's ships (view/boats.ts), the crafts (view/crafts/), the passers-by and the riders.
// - No two faces of different colours lie in one plane over each other facing the same way (they flicker: the depth
//   test cannot tell them apart), and no see-through face lies on another face at all (drawn both sides, it is on top
//   of the solid one at the same depth from one of them).
// - Every vehicle type of the traffic shows its glass from each side as much as the one a player sits in (opened):
//   rays from ahead, behind and both sides meet glass first about as often.
// - The passers-by and the riders are as tall as sim/figure.ts says (the players' and the NPCs' figure).
// - Every figure drawn as part of a look is the figure's size: a vehicle's rider (its clothes, sim/vehicles.ts WEAR) no
//   longer and no wider than the passer-by's torso and no taller than its shoulders, a craft's own pilot (a group named
//   'figure') no taller than the figure.
// Prints the traffic's triangles and meshes a type (its draw cost).
// usage (in web/): node tools/looks.mjs [-v]; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp } from './lib.mjs';

const { LifeMeshes } = await imp('src/view/meshes.ts');
const { Boats } = await imp('src/view/boats.ts');
const { craftLook } = await imp('src/view/crafts/index.ts');
const { VEHICLE_IDS, VEHICLES, PALETTE, WEAR } = await imp('src/sim/vehicles.ts');
const { SEATS } = await imp('src/sim/seats.ts');
const CRAFT_TYPES = Object.keys(SEATS.craft);
const { FIGURE_TOP, RIDE_SIT, RIDE_UP, RIDER_TOP } = await imp('src/sim/figure.ts');

const verbose = process.argv.includes('-v');
const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(`FAIL ${s}`));
// m: one plane; m²: over each other
const PLANE = 1e-3, AREA = 1e-4;

// the axis-aligned faces of meshes as drawn in one frame: their plane, which way they face, their extent in it, and
// what they look like (the material and the colour: a per-instance colour is a look of its own)
function faces(meshes) {
  const out = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  meshes.forEach((mesh, mi) => {
    const g = mesh.geometry, P = g.attributes.position, C = g.attributes.color, I = g.index, M = mesh.matrixWorld;
    if (!P) return;
    const count = I ? I.count : P.count, at = (k) => (I ? I.getX(k) : k);
    // (see-through: drawn both sides or only the front)
    const mat = mesh.material, see = !!mat.transparent, two = see && mat.side === THREE.DoubleSide;
    const base = `${mat.uuid}:${mat.color?.getHexString() ?? ''}:${mesh.instanceColor ? `each${mi}` : ''}`;
    for (let t = 0; t < count; t += 3) {
      const i0 = at(t), i1 = at(t + 1), i2 = at(t + 2);
      a.fromBufferAttribute(P, i0).applyMatrix4(M); b.fromBufferAttribute(P, i1).applyMatrix4(M); c.fromBufferAttribute(P, i2).applyMatrix4(M);
      n.subVectors(b, a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      const ax = [0, 1, 2].find((k) => Math.abs(n.getComponent(k)) > 0.9999);
      if (ax === undefined) continue;
      const [u, v] = [0, 1, 2].filter((k) => k !== ax), xs = [a, b, c];
      // (half of a rectangle along the axes, whose box is the rectangle; a part turned in its plane is left out)
      const along = (k) => xs.some((p, i) => { const q = xs[(i + 1) % 3]; return Math.abs(p.getComponent(k) - q.getComponent(k)) < 1e-6; });
      if (!along(u) || !along(v)) continue;
      const key = C ? `${base}:${C.getX(i0).toFixed(3)},${C.getY(i0).toFixed(3)},${C.getZ(i0).toFixed(3)}` : base;
      out.push({ ax, s: Math.sign(n.getComponent(ax)), c: a.getComponent(ax), key, see, two, mesh: mesh.name || `mesh${mi}`,
        u0: Math.min(...xs.map((p) => p.getComponent(u))), u1: Math.max(...xs.map((p) => p.getComponent(u))),
        v0: Math.min(...xs.map((p) => p.getComponent(v))), v1: Math.max(...xs.map((p) => p.getComponent(v))) });
    }
  });
  return out;
}

// the faces that flicker against each other where they can be seen: [what, where] once per pair of looks and plane
function fights(meshes) {
  const F = faces(meshes).sort((p, q) => p.ax - q.ax || p.c - q.c), found = new Map();
  const solid = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const occ = meshes.filter((m) => !m.material.transparent).map((m) => {
    const o = new THREE.Mesh(m.geometry, solid);
    o.matrixAutoUpdate = false;
    o.matrix.copy(m.matrixWorld);
    o.matrixWorld.copy(m.matrixWorld);
    return o;
  });
  for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length && F[j].ax === F[i].ax && F[j].c - F[i].c < PLANE; j++) {
    const p = F[i], q = F[j];
    if (p.see && q.see) continue;
    const u0 = Math.max(p.u0, q.u0), u1 = Math.min(p.u1, q.u1), v0 = Math.max(p.v0, q.v0), v1 = Math.min(p.v1, q.v1);
    if (u1 <= u0 || v1 <= v0 || (u1 - u0) * (v1 - v0) < AREA) continue;
    const bad = p.see || q.see ? p.s === q.s || p.two || q.two : p.s === q.s && p.key !== q.key;
    const where = `${p.mesh}/${q.mesh} ${'xyz'[p.ax]}=${p.c.toFixed(3)}`;
    if (!bad || found.has(where)) continue;
    // (seen from the side the solid one faces)
    if (!exposed(occ, p.ax, p.see ? q.s : p.s, p.c, u0, u1, v0, v1)) continue;
    found.set(where, `${where} (${p.see || q.see ? 'see-through on solid' : 'two colours'})`);
  }
  return [...found.values()];
}

// whether a ray from a point of the rectangle (a hair in front of it along axis ax, way s) gets out past occ: one
// covered by another part is never seen
const caster = new THREE.Raycaster();
function exposed(occ, ax, s, c, u0, u1, v0, v1) {
  const [u, v] = [0, 1, 2].filter((k) => k !== ax), o = new THREE.Vector3(), d = new THREE.Vector3();
  for (const [fu, fv] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
    o.setComponent(ax, c + s * 0.002).setComponent(u, u0 + (u1 - u0) * fu).setComponent(v, v0 + (v1 - v0) * fv);
    for (const [tu, tv] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
      d.set(0, 0, 0).setComponent(ax, s).setComponent(u, tu).setComponent(v, tv).normalize();
      caster.set(o, d);
      if (caster.intersectObjects(occ, false).length === 0) return true;
    }
  }
  return false;
}

const scene = new THREE.Scene(), M = new LifeMeshes(scene, []);
scene.updateMatrixWorld(true);
const parts = (V, open) => [V.body, V.dark, V.head, V.tail, ...(open ? [V.pane] : [])];
const named = (list, names) => list.map((m, i) => Object.assign(m, { name: names[i] }));

// the vehicles, the ships, the crafts, the figures and the bike: nothing flickers
const looks = [];
for (const id of VEHICLE_IDS) {
  looks.push([`${id} (traffic)`, named(parts(M.vehicles[id]), ['paint', 'fixed', 'head', 'tail'])]);
  looks.push([`${id} (opened)`, named(parts(M.open[id], true), ['paint', 'fixed', 'head', 'tail', 'pane'])]);
}
looks.push(['passer-by', named([M.legs, M.torso], ['legs', 'torso'])], ['bike', [M.bike]]);
// a ship's meshes in their order: hull, accent, lit windows, dark windows (boats.ts kind()), four a ship; a window
// is drawn lit or dark, never both
const ships = new Boats().group.children;
for (const [s, name] of [[0, 'cruise ship'], [4, 'excursion boat']]) {
  looks.push([`${name} (windows lit)`, named([ships[s], ships[s + 1], ships[s + 2]], ['hull', 'accent', 'windows'])]);
  looks.push([`${name} (windows dark)`, named([ships[s], ships[s + 1], ships[s + 3]], ['hull', 'accent', 'windows'])]);
}
for (const type of CRAFT_TYPES) {
  const look = craftLook(type), g = look.group;
  g.visible = true;
  g.updateMatrixWorld(true);
  const meshes = [];
  g.traverse((o) => { if (o.isMesh) meshes.push(o); });
  looks.push([type, meshes]);
}
for (const [name, meshes] of looks) {
  const f = fights(meshes);
  check(f.length === 0, `${name}: no faces flicker against each other${f.length ? `: ${(verbose ? f : f.slice(0, 6)).join('; ')}${!verbose && f.length > 6 ? ` and ${f.length - 6} more` : ''}` : ''}`);
}

// the glass seen from ahead, behind and either side, closed (the traffic's) and opened (a player in it)
const glass = new THREE.Color(PALETTE.glass), ray = new THREE.Raycaster(), hex = glass.getHexString();
function glassSeen(meshes, dir) {
  const plain = meshes.map((m) => Object.assign(new THREE.Mesh(m.geometry, m.material), { userData: { from: m } }));
  const box = new THREE.Box3();
  for (const m of plain) { m.geometry.computeBoundingBox(); if (m.geometry.boundingBox) box.union(m.geometry.boundingBox); }
  const across = dir.x ? 'z' : 'x', D = 0.04;
  let n = 0;
  for (let y = box.min.y; y <= box.max.y; y += D) for (let w = box.min[across]; w <= box.max[across]; w += D) {
    const o = new THREE.Vector3().copy(dir).multiplyScalar(-50);
    o.y = y; o[across] = w;
    ray.set(o, dir);
    const hit = ray.intersectObjects(plain, false)[0];
    if (!hit) continue;
    const from = hit.object.userData.from, C = hit.object.geometry.attributes.color;
    if (from.material.transparent) n++;
    else if (C && new THREE.Color(C.getX(hit.face.a), C.getY(hit.face.a), C.getZ(hit.face.a)).getHexString() === hex) n++;
  }
  return n;
}
const DIRS = { ahead: new THREE.Vector3(0, 0, -1), behind: new THREE.Vector3(0, 0, 1), left: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(1, 0, 0) };
for (const id of VEHICLE_IDS) {
  const seen = Object.entries(DIRS).map(([side, d]) => [side, glassSeen(parts(M.vehicles[id]), d), glassSeen(parts(M.open[id], true), d)]);
  const short = seen.filter(([, closed, open]) => closed < 0.8 * open);
  check(short.length === 0, `a ${id} of the traffic shows its glass from each side as one a player sits in (rays meeting glass first, closed/opened: ${seen.map(([s, c, o]) => `${s} ${c}/${o}`).join(', ')})`);
}

// the figures' size
const top = (m) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox.max.y; };
const crowd = Math.max(top(M.legs), top(M.torso));
check(Math.abs(crowd - FIGURE_TOP) < 0.03, `a passer-by drawn ${crowd.toFixed(3)} m tall (the figure's ${FIGURE_TOP.toFixed(3)})`);
const rider = RIDE_UP + crowd * RIDE_SIT;
check(Math.abs(rider - RIDER_TOP) < 0.03, `a rider's head ${rider.toFixed(3)} m up (a shot meets it to ${RIDER_TOP.toFixed(3)})`);
// a figure in a model: a grown-up's (the motorbike's rider before 2026-11-27) was a third bigger than these allow
const torso = (M.torso.geometry.computeBoundingBox(), M.torso.geometry.boundingBox), torsoW = torso.max.x - torso.min.x, torsoH = torso.max.y - torso.min.y;
const SLACK = 1.03;
for (const id of VEHICLE_IDS) {
  const worn = VEHICLES[id].model.filter((p) => WEAR.includes(p[6]));
  if (!worn.length) continue;
  const big = worn.filter(([w, h]) => w > torsoW * SLACK || h > torsoH * SLACK);
  const span = Math.max(...worn.map((p) => p[4] + p[1])) - Math.min(...worn.map((p) => p[4]));
  check(!big.length && span < torso.max.y * SLACK, `a ${id}'s rider at the figure's size: its clothes ${span.toFixed(3)} m from the soles up (a passer-by's shoulders ${torso.max.y.toFixed(3)}), none wider or longer than its torso (${torsoW.toFixed(3)} x ${torsoH.toFixed(3)} m)${big.length ? `: ${big.map((p) => `${p[0]} x ${p[1]}`).join(', ')}` : ''}`);
}
for (const type of CRAFT_TYPES) {
  const figures = [];
  craftLook(type).group.traverse((o) => { if (o.name === 'figure') figures.push(o); });
  for (const f of figures) {
    f.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(f), tall = b.max.y - b.min.y;
    check(tall < FIGURE_TOP * SLACK, `a ${type}'s own pilot ${tall.toFixed(3)} m from the soles up (the figure ${FIGURE_TOP.toFixed(3)})`);
  }
}

// the draw cost: the traffic's triangles and meshes a type, closed (as most of it is drawn) and opened
const tris = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position?.count ?? 0) / 3;
for (const id of VEHICLE_IDS) {
  const closed = parts(M.vehicles[id]), open = parts(M.open[id], true), model = VEHICLES[id].model.length * 12;
  const line = `${id}: traffic ${closed.reduce((s, m) => s + tris(m), 0)} triangles in ${closed.length} meshes (the model's boxes: ${model}), opened ${open.reduce((s, m) => s + tris(m), 0)} in ${open.length}`;
  if (verbose) console.log(line);
  else console.log(`  ${line}`);
}

if (fail.length) { for (const f of fail) console.log(f); process.exit(1); }
console.log('PASS looks');
