// The regression gate of the client-independent stack (docs/adr/0001-world-layers.md, 0002-addressing.md) on the real
// data (public/data), headless, no viewer:
//   1. a 3 x 3 area of level-1 nodes round the Dom (meta.json labels) loaded through src/core (core/tile-cache.ts, the
//      files read from disk) + tile-data.ts only;
//   2. an L1 build (a 6 x 6 x 4 m wall-coloured box on a flat, empty lot) and an L2 crater (a sphere of r 4 m carved at a
//      flat road's surface) as WorldOps (project grid, absolute height), routed (routeOps) and composed per node
//      (layers.ts effectiveColumns), foliage cleared in their shapes as dig.ts does;
//   3. the touched nodes re-meshed from the columns (mesher.worker.ts meshJob cols; their foliage over them): every
//      mesh changes;
//   4. Rapier terrain tiles (physics/rapier/terrain.ts terrainTile, as tools/rapier-car.mjs builds them) from the edited
//      columns, the car (scenarios.ts Sim) dropped from 3 m into the crater and onto the box: it must come to rest
//      upright, in the crater under the road's level, on the box's top;
//   5. L2 dropped: the crater's columns are L0's again, a node L1 does not touch meshes as from its file, and the car
//      dropped there rests on the road.
// The sites are found in the data (the flat road and lot nearest the Dom), the edits are synthetic; nothing is written.
// usage (in web/): node tools/world-smoke.mjs [-v]; prints one PASS line, or the failures and exit code 1
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(web, 'public/data'), verbose = process.argv.includes('-v');
globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
const imp = async (p) => (await runnerImport(path.join(web, p), { root: web, logLevel: 'error' })).module;
const TC = await imp('src/core/tile-cache.ts'), CO = await imp('src/core/columns.ts'), LA = await imp('src/core/layers.ts');

const bad = [];
const check = (ok, what) => { if (!ok) { bad.push(what); console.log(`  FAIL ${what}`); } return ok; };
const log = (...a) => { if (verbose) console.log(...a); };

// --- 1. the area, through core/ and tile-data only ---
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const f = LA.frameOf(meta), N = f.N, S = N + 2, { nx, ny } = meta.tiles.levels[0], BUILD = 'disk';
const raw = (k) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${k}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
// the nodes' files through the cache (no live edits: the edits below are composed here)
const cache = new TC.TileCache({ N, load: async (p) => raw(p.replace(/\.bin$/, '')) });
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const TX = Math.floor(dom.x / N), TY = Math.floor(dom.y / N);
const area = new Map(); // "tx_ty" -> { tx, ty, base: BaseNode (+ planes, bld), fol }
for (let ty = TY - 1; ty <= TY + 1; ty++) for (let tx = TX - 1; tx <= TX + 1; tx++) {
  const k = `${tx}_${ty}`;
  const v = await cache.acquire(tx, ty).catch(() => null);
  if (!v) { check(false, `node 1/${k} or 1f/${k} missing`); continue; }
  const d = v.base, fol = v.foliage;
  area.set(k, { tx, ty, file: d, base: { ...d, buildId: BUILD, node: { s: 1, tx, ty } }, fol: fol && { ...fol, buildId: BUILD, node: { s: 1, tx, ty } } });
}
if (area.size !== 9) { console.log(`FAIL world-smoke: ${area.size}/9 nodes round ${TX}_${TY} on disk`); process.exit(1); }

const offsets = (counts) => { const o = new Uint32Array(counts.length + 1); for (let i = 0; i < counts.length; i++) o[i + 1] = o[i] + counts[i]; return o; };
for (const n of area.values()) { n.boff = offsets(n.base.counts); n.foff = n.fol && offsets(n.fol.counts); }
// a map cell's column: its node and index (inner cells only)
const at = (x, y) => { const n = area.get(`${Math.floor(x / N)}_${Math.floor(y / N)}`); return n && { n, c: (x - n.tx * N) + 1 + S * (y - n.ty * N + 1) }; };
const runsOf = (cols, off, c) => Array.from(cols.runs.subarray(off[c] * 3, off[c + 1] * 3));
const topOf = (r) => (r.length ? r[r.length - 3] + r[r.length - 2] : 0);

// a wall colour for the box; paved ground (core/semantics.ts RULES.paved) for the road, solid (terrainPalette) for the
// rest (the physics' module only to pick the site: the columns are loaded and edited without it)
const T = await imp('src/physics/rapier/terrain.ts'), pal = T.terrainPalette(meta.palette), SEMx = await imp('src/core/semantics.ts');
const pavedMask = SEMx.paletteMask(SEMx.semanticTable(meta.palette), SEMx.RULES.paved);
const MAT_WALL = 1, wallId = meta.palette.findIndex((p) => p[3] === MAT_WALL);
// a flat stretch: every column within r of (x, y) has its ground at g, nothing over it (base or foliage above g),
// its top voxel accepted by `top`
function flatAt(x, y, r, g, top) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const a = at(x + dx, y + dy);
    if (!a || a.n.base.ground[a.c] !== g) return false;
    const br = runsOf(a.n.base, a.n.boff, a.c);
    if (topOf(br) !== g || !top(br[br.length - 1])) return false;
    if (a.n.fol && topOf(runsOf(a.n.fol, a.n.foff, a.c)) > g) return false;
  }
  return true;
}
const paved = (id) => pavedMask[id] !== 0;
const unpaved = (id) => pal.solid[id] === 1 && !paved(id);
// the site of each kind nearest the Dom, in the middle node, at least 12 m from its edges
function site(r, top, avoid = null) {
  let best = null;
  for (let y = TY * N + 12; y < TY * N + N - 12; y++) for (let x = TX * N + 12; x < TX * N + N - 12; x++) {
    const d2 = (x - dom.x) ** 2 + (y - dom.y) ** 2;
    if (best && d2 >= best.d2) continue;
    if (avoid && Math.hypot(x - avoid.x, y - avoid.y) < 20) continue;
    const a = at(x, y), g = a.n.base.ground[a.c];
    if (g && flatAt(x, y, r, g, top)) best = { x, y, g, d2 };
  }
  return best;
}
const road = site(5, paved);
const lot = road && (site(4, unpaved, road) ?? site(4, (id) => pal.solid[id] === 1, road));
if (!check(!!road && !!lot && wallId > 0, `sites: road ${!!road}, lot ${!!lot}, wall colour ${wallId}`)) { console.log('FAIL world-smoke'); process.exit(1); }
log(`road (${road.x}, ${road.y}) ground ${road.g}; lot (${lot.x}, ${lot.y}) ground ${lot.g}; nodes round ${TX}_${TY}`);

// --- 2. the edits as WorldOps, routed and composed ---
const [rc, rr] = LA.mapToGrid(f, road.x, road.y), [lc, lr] = LA.mapToGrid(f, lot.x - 3, lot.y - 3);
const BOX = { kind: 'box', col: lc, row: lr, z: LA.cellToAbsZ(f, lot.g), w: 6, d: 6, h: 4, colour: wallId };
const CRATER = { kind: 'sphere', col: rc, row: rr, z: LA.cellToAbsZ(f, road.g), r: 4, colour: 0 };
// (the foliage in their shapes cleared, dig.ts)
const clear = (op) => ({ ...op, colour: 0, replace: CO.REPLACE_ALL });
const L1 = LA.routeOps(f, BUILD, [BOX], nx, ny), L2 = LA.routeOps(f, BUILD, [CRATER], nx, ny);
const L1f = LA.routeOps(f, BUILD, [clear(BOX)], nx, ny), L2f = LA.routeOps(f, BUILD, [clear(CRATER)], nx, ny);
const deltas = (m, k) => (m.has(k) ? [m.get(k)] : []);
// the area's columns as shown, with or without L2: base with its ground, planes, bld, caps (kept as stream.ts does); foliage with the base's ground
function compose(withL2) {
  const out = new Map();
  for (const [k, n] of area) {
    const t2 = withL2 ? deltas(L2, k) : [], t2f = withL2 ? deltas(L2f, k) : [];
    const b = LA.effectiveColumns(f, n.base, deltas(L1, k), t2);
    const fo = n.fol && LA.effectiveColumns(f, n.fol, deltas(L1f, k), t2f);
    out.set(k, { base: { ...b, planes: n.base.planes, bld: n.base.bld, caps: n.base.caps }, fol: fo && { ...fo, ground: b.ground }, edited: b.runs !== n.base.runs });
  }
  return out;
}
const touched = new Set([...L1.keys(), ...L2.keys()]);
const world = compose(true);
const colAt = (w, x, y) => { const a = at(x, y), e = w.get(`${a.n.tx}_${a.n.ty}`).base; return { runs: runsOf(e, offsets(e.counts), a.c), ground: e.ground[a.c] }; };
{
  const lc0 = colAt(world, lot.x, lot.y), rc0 = colAt(world, road.x, road.y);
  check(lc0.runs.slice(-3).join() === `${lot.g},4,${wallId}` && lc0.ground === lot.g, `L1 box: lot column ${lc0.runs.slice(-3)} ground ${lc0.ground}, want ${lot.g},4,${wallId} ground ${lot.g}`);
  check(topOf(rc0.runs) === road.g - 4 && rc0.ground === road.g - 4, `L2 crater: road column top ${topOf(rc0.runs)} ground ${rc0.ground}, want ${road.g - 4}`);
  for (const [k, w] of world) check(w.edited === touched.has(k), `node ${k}: edited ${w.edited}, routed ${touched.has(k)}`);
}
// the cache: each node read once while held; seen through live edits (core/live-edits.ts) as the physics see it
{
  const k = [...touched][0], n = area.get(k), again = await cache.acquire(n.tx, n.ty);
  check(cache.loads === 9 && again.base === n.file, `cache: ${cache.loads} loads for 9 nodes, a second acquire shares the first`);
  cache.release(n.tx, n.ty); cache.release(n.tx, n.ty);
  check(cache.view(n.tx, n.ty) === null && cache.size === 8, `cache: a node let go is dropped (size ${cache.size})`);
  const LE = await imp('src/core/live-edits.ts'), edits = new LE.LiveEdits();
  const lc = new TC.TileCache({ N, load: async (p) => raw(p.replace(/\.bin$/, '')), edits }), w = world.get(k);
  const v0 = await lc.acquire(n.tx, n.ty);
  edits.set(n.tx, n.ty, { base: w.base, foliage: null });
  const v1 = lc.view(n.tx, n.ty);
  edits.set(n.tx, n.ty, null);
  const v2 = lc.view(n.tx, n.ty);
  check(!v0.edited && v1.edited && v1.base === w.base && v1.foliage === v0.foliage && !v2.edited && v2.base === v0.base,
    'cache: an edited node seen with its live base and its file\'s foliage, the file again when the edit is dropped');
}

// --- 3. re-meshed from the columns ---
const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts');
const ctx = { N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) }, file = (k) => k;
const load = async (k) => raw(k);
const meshCols = async (k, w) => {
  const n = area.get(k);
  const a = await mesher.meshJob({ ...req.tileRequest(ctx, 1, n.tx, n.ty, false, file), url: undefined, cols: w.base }, load);
  const fr = n.fol ? req.tileRequest(ctx, 1, n.tx, n.ty, true, file) : null;
  const b = fr && await mesher.meshJob({ ...fr, url: undefined, cols: w.fol, under: w.base }, load);
  return { out: a.out, fol: b?.out ?? null, cover: b?.base ?? null };
};
const meshFile = async (k) => {
  const n = area.get(k);
  const a = await mesher.meshJob(req.tileRequest(ctx, 1, n.tx, n.ty, false, file), load);
  const b = n.fol ? await mesher.meshJob(req.tileRequest(ctx, 1, n.tx, n.ty, true, file), load) : null;
  return { out: a.out, fol: b?.out ?? null, cover: b?.base ?? null };
};
const sameMesh = (a, b) => !!a === !!b && (!a || (a.quads === b.quads && a.pos.length === b.pos.length && a.pos.every((v, i) => v === b.pos[i]) && a.attr.every((v, i) => v === b.attr[i])));
const t0 = performance.now();
const meshes = new Map();
for (const k of touched) meshes.set(k, await meshCols(k, world.get(k)));
const meshMs = performance.now() - t0;
for (const k of touched) {
  const m = meshes.get(k), o = await meshFile(k);
  check(!sameMesh(m.out, o.out), `node ${k}: the edit did not change its mesh`);
}

// --- 4. the car on the edited world ---
const sc = await imp('src/physics/rapier/scenarios.ts');
const R = (await import('@dimforge/rapier3d-compat')).default;
await R.init();
const physMap = (w) => ({ meta, tiles: [...area.values()].map((n) => {
  const e = w.get(`${n.tx}_${n.ty}`), fol = e.fol ?? { counts: new Uint16Array(S * S), runs: new Uint16Array(0) };
  return { tx: n.tx, tz: n.ty, tile: T.terrainTile(N, e.base, fol, pal) };
}) });
// the car set down at (x, y) on what is there, lifted 3 m, let fall and settle (handbrake) for 4 s
function drop(map, x, y) {
  const s = new sc.Sim(map, { x, z: y }, 0, 0), b = s.car.body, p = b.translation();
  b.setTranslation({ x: p.x, y: p.y + 3, z: p.z }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  s.run(4, { gas: 0, brake: 0, steer: 0, handbrake: true }); // (brake at rest is reverse: car.ts)
  const q = b.rotation(), e = b.translation(), v = b.linvel();
  const r = { x: e.x, y: e.y, z: e.z, up: 1 - 2 * (q.x * q.x + q.z * q.z), v: Math.hypot(v.x, v.y, v.z), status: s.car.status };
  s.dispose();
  return r;
}
const fmt = (r) => `(${r.x.toFixed(1)}, ${r.y.toFixed(2)}, ${r.z.toFixed(1)}) up ${r.up.toFixed(2)} v ${r.v.toFixed(2)}`;
const edited = physMap(world);
const inCrater = drop(edited, road.x + 0.5, road.y + 0.5);
const onBox = drop(edited, lot.x + 0.5, lot.y + 0.5);
log(`crater: ${fmt(inCrater)} (road ${road.g}); box: ${fmt(onBox)} (top ${lot.g + 4})`);
const settled = (r) => r.up > 0.7 && r.v < 0.5 && r.status === 'ok';
check(settled(inCrater) && r2(inCrater, road) < 4 && inCrater.y < road.g - 0.5, `car in the crater: ${fmt(inCrater)}, road at ${road.g} (want under ${road.g - 0.5}, within 4 m of its middle)`);
check(settled(onBox) && Math.abs(onBox.x - lot.x) < 3 && Math.abs(onBox.z - lot.y) < 3 && onBox.y > lot.g + 4 && onBox.y < lot.g + 6,
  `car on the box: ${fmt(onBox)}, box top ${lot.g + 4}`);
function r2(r, p) { return Math.hypot(r.x - p.x - 0.5, r.z - p.y - 0.5); }

// --- 5. L2 dropped ---
const restored = compose(false);
{
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
    const a = at(road.x + dx, road.y + dy), e = colAt(restored, road.x + dx, road.y + dy);
    const b = runsOf(a.n.base, a.n.boff, a.c);
    if (e.runs.join() !== b.join() || e.ground !== a.n.base.ground[a.c]) { check(false, `L2 dropped: column (${road.x + dx}, ${road.y + dy}) not L0's`); break; }
  }
  // a node without L1 meshes as its file; one with L1 as the box alone applied to L0 (EditableNode, not routed)
  for (const k of touched) {
    const n = area.get(k), m = await meshCols(k, restored.get(k));
    let o, what = 'its file';
    if (!L1.has(k)) o = await meshFile(k);
    else {
      const e = new CO.EditableNode(N, n.base, n.tx, n.ty), ef = n.fol && new CO.EditableNode(N, n.fol, n.tx, n.ty);
      e.apply(LA.toCellOp(f, BOX)); ef?.apply(LA.toCellOp(f, clear(BOX)));
      const b = { ...e.encode(), planes: n.base.planes, bld: n.base.bld, caps: n.base.caps };
      o = await meshCols(k, { base: b, fol: ef && { ...ef.encode(), ground: b.ground } });
      what = 'L0 + the box';
    }
    check(sameMesh(m.out, o.out) && sameMesh(m.fol, o.fol) && sameMesh(m.cover, o.cover), `L2 dropped: node ${k} does not mesh as ${what}`);
    check(!sameMesh(m.out, meshes.get(k).out) || !L2.has(k), `L2 dropped: node ${k} meshes as with the crater`);
  }
}
const onRoad = drop(physMap(restored), road.x + 0.5, road.y + 0.5);
log(`road again: ${fmt(onRoad)}`);
check(settled(onRoad) && r2(onRoad, road) < 1 && onRoad.y > road.g && onRoad.y < road.g + 1.5, `car on the road again: ${fmt(onRoad)}, road at ${road.g}`);

if (bad.length) { console.log(`FAIL world-smoke: ${bad.length} check(s) failed`); process.exit(1); }
console.log(`PASS world-smoke: 3x3 nodes round ${TX}_${TY}; L1 box 6x6x4 on (${lot.x}, ${lot.y}), L2 crater r 4 on road (${road.x}, ${road.y}): ` +
  `${touched.size} node(s) re-meshed (+ foliage, cold JIT) in ${meshMs.toFixed(0)} ms; car in crater y ${inCrater.y.toFixed(2)} (road ${road.g}), on box y ${onBox.y.toFixed(2)} (top ${lot.g + 4}); ` +
  `L2 dropped: road restored, car y ${onRoad.y.toFixed(2)}`);
process.exit(0);
