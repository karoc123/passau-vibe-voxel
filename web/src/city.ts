import * as THREE from 'three';
import type { Caption } from './caption';
import type { TileStreamer } from './stream';
import type { ColumnData, Meta, Zones } from './types';
import { dataTexture, fetchGzip, fetchJson } from './util';
import type { DepthPrepass } from './prepass';
import type { Lod } from './settings';
import { MAT, makeBuildDepthMaterial, makeClayDepthMaterial, makeVoxelMaterial, makeVoxelPrepassMaterial, type VoxelUniforms } from './voxelMaterial';
import { Occlusion } from './occlusion';
import { FarGround } from './farground';

const T = 128;
// The view distance (settings.ts dist, setDist): a 128 m tile is wanted (loaded, meshed) while its nearest point lies
// within the distance + LOAD_M of the camera along the ground, kept once in until it is further than + KEEP_M (so a
// camera moving to and fro at the edge doesn't load and free the same tiles over and over), and freed FREE_MS after
// it left. A mesh is drawn while its box's nearest point is within the distance + DRAW_M: the fog (daylight.ts) is full
// at the distance, so a tile comes and goes unseen. Beyond, the coarse far ground (farground.ts) stands in.
const LOAD_M = 150, KEEP_M = 400, DRAW_M = 32, FREE_MS = 8000;
const RINGS: [string, number][] = [['Buildings in view', 0], ['Buildings within 1 km', 1000], ['Buildings within 2 km', 2000], ['Buildings to the edge', Infinity]];

// The city at 1 m, as much of it as the budget allows (triangles of 1 m buildings, city blocks nearest to the focus
// first; on most computers all of it), shown as it arrives, in one order:
//   1. the ground: the terrain, one small file; where the budget leaves some city out, the whole map at 8 m as clay
//   2. landmarks: their tiles first, each landmark as soon as all its tiles are in (not over clay)
//   3. everything else, nearest to the view first, each building once all its tiles are in; over clay a city block
//      turns real once every tile under it is in, and back to clay when the budget moves on
//   4. foliage: trees and grass, their own tiles (tiles/1f), then traffic
export async function installCity({ streamer: S, uniforms: U, meta, scene, focus, camera, caption, budget, prepass, lod = { mode: 'auto', px: 1.2 }, occlusion = true, dist = 0, pixelsHigh = () => innerHeight * Math.min(devicePixelRatio, 2) }: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms;
  meta: Meta;
  scene: THREE.Scene;
  focus: () => THREE.Vector3;
  camera: THREE.Camera;
  caption: Caption;
  budget: () => number;
  prepass?: DepthPrepass | null;
  lod?: { mode: Lod; px: number };
  occlusion?: boolean;
  // the view distance in metres, 0: the whole map
  dist?: number;
  // the drawing buffer's height in pixels (the renderer's own: the resolution setting scales it)
  pixelsHigh?: () => number;
}) {
  const d = S.dims[1], total = d.nx * d.ny, { W, D } = meta, index = (tx: number, ty: number) => ty * d.nx + tx;
  const zonesIn = Promise.all([fetchGzip('data/zones.bin'), fetchJson<Zones>('data/zones.json')]);
  let terrain: Awaited<ReturnType<typeof loadTerrain>> | null = null;
  const d8 = S.dims[8], n8 = d8.nx * d8.ny, clayIn: Promise<void>[] = [];
  let claysIn = 0;
  if (Number.isFinite(budget())) {
    for (let ty = 0; ty < d8.ny; ty++) for (let tx = 0; tx < d8.nx; tx++) clayIn.push(S.request(8, tx, ty, 1e9).then(() => { claysIn++; }));
    S.pump();
  } else {
    caption.show('Terrain', 0, 2 * total);
    terrain = await loadTerrain(meta, scene, d.nx, d.ny);
  }
  const [zbuf, zones] = await zonesIn;
  document.querySelector('#loading')?.classList.add('hidden');
  const bld = new Uint16Array(zbuf, W * D * 2, W * D);
  S.bldMap = { data: bld, W };
  const nb = zones.buildings.length, shown = new Uint8Array(128 * Math.ceil((nb + 1) / 128));
  const shownTex = dataTexture(shown, 128, shown.length / 128, THREE.RedFormat);
  U.uBldOn.value = shownTex;
  U.uStage.value = 1;
  const tilesIn = (x0: number, y0: number, x1: number, y1: number) => {
    const t = [];
    for (let ty = Math.floor(y0 / T); ty <= Math.min(d.ny - 1, Math.floor((y1 - 1) / T)); ty++)
      for (let tx = Math.floor(x0 / T); tx <= Math.min(d.nx - 1, Math.floor((x1 - 1) / T)); tx++) t.push(index(tx, ty));
    return t;
  };
  const tilesOf = zones.buildings.map((b) => tilesIn(b[3], b[4], b[5], b[6]));
  const onTile = Array.from({ length: total }, () => [] as number[]);
  tilesOf.forEach((t, i) => t.forEach((k) => onTile[k].push(i)));

  // city blocks [cx, cy, n, x0, y0, x1, y1, triangles] (scripts/zones.py), each real or clay as a whole
  const blocks = zones.blocks, nk = blocks.length, tris = blockTris(blocks, zones.buildings, new Uint16Array(zbuf, 0, W * D), W, D);
  const cityTris = tris.reduce((a, b) => a + b, 0);
  const blockTiles = blocks.map((b) => tilesIn(b[3], b[4], b[5], b[6]));
  const blkWant = new Uint8Array(nk + 1).fill(1), want = new Uint8Array(total).fill(1);
  const flags = new Uint8Array(64 * Math.ceil((nk + 1) / 64)), flagTex = dataTexture(flags, 64, flags.length / 64, THREE.RedFormat);
  U.uZFBlk.value = flagTex;
  const blkIds = dataTexture(new Uint16Array(zbuf, 0, W * D), W, D, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  blkIds.internalFormat = 'R16UI';
  U.uZBlk.value = blkIds;
  // the view distance: which tiles are in range of the camera (along the ground), with the hysteresis above
  let cut = dist;
  const inRange = new Uint8Array(total).fill(1), camAt = new THREE.Vector3();
  const flat = (x0: number, z0: number, x1: number, z1: number) =>
    Math.hypot(Math.max(x0 - camAt.x, 0, camAt.x - x1), Math.max(z0 - camAt.z, 0, camAt.z - z1));
  const range = () => {
    camera.updateMatrixWorld();
    camAt.setFromMatrixPosition(camera.matrixWorld);
    if (!cut) { inRange.fill(1); return; }
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) {
      const i = index(tx, ty), r = flat(tx * T, ty * T, (tx + 1) * T, (ty + 1) * T);
      inRange[i] = r <= cut + (inTile[i] ? KEEP_M : LOAD_M) ? 1 : 0;
    }
  };
  // a mesh drawn at this distance
  const drawn = (m: THREE.Mesh) => {
    const b = m.geometry.boundingBox;
    return !cut || !b || flat(b.min.x, b.min.z, b.max.x, b.max.z) <= cut + DRAW_M;
  };
  const far = new FarGround(meta, d.nx, d.ny), farMask = new Uint8Array(total);
  scene.add(far.group);
  const bdist = (b: number[], f: THREE.Vector3) => Math.hypot(Math.max(b[3] - f.x, 0, f.x - b[5]), Math.max(b[4] - f.z, 0, f.z - b[6]));
  const order = blocks.map((_, k) => k);
  let whole = true;
  const choose = (f: THREE.Vector3) => {
    const B = budget();
    whole = B >= cityTris;
    if (whole) { blkWant.fill(1); want.set(inRange); return; }
    order.sort((a, b) => bdist(blocks[a], f) - bdist(blocks[b], f));
    let sum = 0;
    const next = new Uint8Array(nk + 1);
    for (const k of order) {
      sum += tris[k];
      if (sum > B * (blkWant[k + 1] ? 1.1 : 1)) break;
      next[k + 1] = 1;
    }
    blkWant.set(next);
    want.fill(0);
    for (let k = 0; k < nk; k++) if (blkWant[k + 1]) for (const i of blockTiles[k]) want[i] = inRange[i];
  };

  const bldAt = (x: number, y: number) => bld[Math.min(D - 1, Math.round(y)) * W + Math.min(W - 1, Math.round(x))] - 1;
  const landmarks = [...new Set(meta.labels.map((l) => bldAt(l.x, l.y)).filter((b) => b >= 0))], isLandmark = new Set(landmarks);
  const lmPrio = new Map<number, number>();
  landmarks.forEach((b, j) => tilesOf[b].forEach((k) => { if (!lmPrio.has(k)) lmPrio.set(k, 1e6 - j); }));

  const seen = new Uint8Array(total), frustum = new THREE.Frustum(), box = new THREE.Box3(), pm = new THREE.Matrix4();
  const look = () => {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) {
      box.min.set(tx * T, 0, ty * T); box.max.set((tx + 1) * T, 330, (ty + 1) * T);
      seen[index(tx, ty)] = frustum.intersectsBox(box) ? 1 : 0;
    }
  };
  const away = (i: number, f: THREE.Vector3) => Math.hypot((i % d.nx + 0.5) * T - f.x, (Math.floor(i / d.nx) + 0.5) * T - f.z);
  const prio = (i: number, f: THREE.Vector3) => (clay === 'none' ? lmPrio.get(i) : undefined) ?? (seen[i] ? 1e5 : 0) - away(i, f);

  // Distance levels (scripts/tiles.py LOD_LEVELS): far from the camera, where a metre is a pixel or less, the city is
  // drawn from its 2 m tiles instead of the 1 m ones, trees included, and further out (where a 2 m cell is under
  // pxCoarse: beyond ~3 km at the default 1.2 px and a 28° view) from its 4 m ones. The levels nest: a node of level s
  // holds s x s tiles of 128 m. Each update picks the levels as a quadtree from the coarsest down: a node is drawn as it is
  // while a cell of the next finer level would come out under pxCoarse pixels at its nearest point (back to the finer
  // one above pxFine, so a camera at the switch doesn't flip it to and fro). What is drawn (shown) only changes once
  // all of it is in: a coarse node goes once every finer node chosen under it (a 1 m tile with its foliage, after the
  // first load) is ready, so nothing is ever missing; the nodes shown never overlap. Each tile's own faces close it
  // at its edges, so a 1 m tile next to a 2 m one (or a 2 m next to a 4 m) leaves no crack. lod (settings.ts, ?lod=
  // ?lodpx=): 'off' 1 m only, 'far' never finer than 2 m, 'far4' never finer than 4 m (to look at them close up); px:
  // pxCoarse, in the drawing buffer's pixels (a lower resolution draws the city coarser; the next update picks again
  // with it). setLod changes them live: the next update picks
  // anew, and what shows changes over as the newly chosen nodes come in, as for a camera move.
  const lods = S.levels.filter((s) => s !== S.clay).sort((a, b) => a - b);
  let lodOn = false, pxCoarse = 1.2, pxFine = 1.5, lodMin = 1;
  const setLod = (l: { mode: Lod; px: number }) => {
    lodOn = lods.length > 1 && l.mode !== 'off';
    pxCoarse = l.px; pxFine = l.px * 1.25; lodMin = l.mode === 'far' ? 2 : l.mode === 'far4' ? 4 : 1;
    last = 0;
  };
  interface LNode { s: number; tx: number; ty: number; key: string; x0: number; y0: number; x1: number; y1: number }
  const lnode = (s: number, tx: number, ty: number): LNode =>
    ({ s, tx, ty, key: S.key(s, tx, ty), x0: tx * s, y0: ty * s, x1: Math.min((tx + 1) * s, d.nx), y1: Math.min((ty + 1) * s, d.ny) });
  const tilesOfNode = (n: LNode) => { const t = []; for (let y = n.y0; y < n.y1; y++) for (let x = n.x0; x < n.x1; x++) t.push(index(x, y)); return t; };
  const within = (a: LNode, b: LNode) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
  const overlap = (a: LNode, b: LNode) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const chosen = new Map<string, LNode>(), shownN = new Map<string, LNode>(), level = new Uint8Array(total);
  let finer = new Set<string>();
  const eye = new THREE.Vector3();
  const pick = () => {
    chosen.clear(); level.fill(0);
    const add = (n: LNode) => { chosen.set(n.key, n); for (const i of tilesOfNode(n)) level[i] = n.s; };
    if (!lodOn) { for (let i = 0; i < total; i++) if (want[i]) add(lnode(1, i % d.nx, Math.floor(i / d.nx))); return; }
    eye.setFromMatrixPosition(camera.matrixWorld);
    const cam = camera as THREE.PerspectiveCamera;
    const focal = pixelsHigh() / 2 / Math.tan((cam.fov * Math.PI) / 360) * (cam.zoom || 1);
    const next = new Set<string>();
    const visit = (k: number, tx: number, ty: number) => {
      const s = lods[k], n = lnode(s, tx, ty);
      if (n.x0 >= d.nx || n.y0 >= d.ny || !tilesOfNode(n).some((i) => want[i])) return;
      if (k === 0 || s <= lodMin) { add(n); return; }
      const dist = Math.hypot(Math.max(n.x0 * T - eye.x, 0, eye.x - n.x1 * T), Math.max(-eye.y, 0, eye.y - meta.H), Math.max(n.y0 * T - eye.z, 0, eye.z - n.y1 * T));
      const sf = lods[k - 1], px = (focal * sf) / Math.max(dist, 1);
      if (px > (finer.has(n.key) ? pxCoarse : pxFine)) {
        next.add(n.key);
        const r = s / sf;
        for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) visit(k - 1, tx * r + dx, ty * r + dy);
      } else add(n);
    };
    const top = lods.length - 1, dt = S.dims[lods[top]];
    for (let ty = 0; ty < dt.ny; ty++) for (let tx = 0; tx < dt.nx; tx++) visit(top, tx, ty);
    finer = next;
  };
  const nodePrio = (n: LNode, f: THREE.Vector3) => (n.s === 1 ? prio(index(n.tx, n.ty), f) : Math.max(...tilesOfNode(n).map((i) => prio(i, f))));
  const request = (f: THREE.Vector3) => {
    for (const n of chosen.values()) S.request(n.s, n.tx, n.ty, nodePrio(n, f), n.s === 1);
  };

  // clay: the whole map at 8 m, fetched the first time the budget leaves some city out; the terrain goes then
  let clay: 'none' | 'loading' | 'ready' = 'none';
  const clayMat = makeVoxelMaterial(U, { clay: true }), clayDepth = makeClayDepthMaterial(U);
  const startClay = () => {
    clay = 'loading';
    if (stage === 1) toStage2();
    if (!clayIn.length) {
      for (let ty = 0; ty < d8.ny; ty++) for (let tx = 0; tx < d8.nx; tx++) clayIn.push(S.request(8, tx, ty, 1e9).then(() => { claysIn++; }));
      S.pump();
    }
    Promise.all(clayIn).then(() => {
      for (const n of S.nodes.values()) if (n.s === 8 && n.mesh) { n.mesh.material = clayMat; n.mesh.customDepthMaterial = clayDepth; n.mesh.visible = true; }
      terrain?.dropUnder(new Uint8Array(total).fill(1));
      U.uZOn.value = 1;
      clay = 'ready';
    });
  };

  const depthMat = makeBuildDepthMaterial(U), folMat = makeVoxelMaterial(U), farMat = makeVoxelMaterial(U, { far: true });
  prepass?.add(farMat, makeVoxelPrepassMaterial(U));
  folMat.polygonOffset = true; folMat.polygonOffsetFactor = -1; folMat.polygonOffsetUnits = -2; // grass wins over the base's bare earth
  prepass?.add(folMat, makeVoxelPrepassMaterial(U));
  const inTile = new Uint8Array(total), cover = new Uint8Array(total), folTile = new Uint8Array(total), complete = new Uint8Array(nb), counted = new Set<string>();
  let lmShown = 0, stage = 1, last = 0, flagKey = '', realTris = 0, settled = false;
  const show = (b: number) => { if (!shown[b + 1]) { shown[b + 1] = 255; if (isLandmark.has(b)) lmShown++; } };
  function toStage2() {
    stage = U.uStage.value = 2;
    for (let b = 0; b < nb; b++) if (complete[b]) show(b);
    shownTex.needsUpdate = true;
  }

  setLod(lod);
  range();
  look();
  choose(focus());
  if (!whole) startClay();
  pick();
  request(focus());
  S.pump();

  // the caption's parts of the long building stage: what you see, then rings around you
  const progress = (f: THREE.Vector3, wanted: number, tilesNow: number, folNow: number) => {
    const base = clay === 'none' ? 0 : n8, all = base + 2 * wanted;
    if (stage === 4 && clay !== 'loading') { caption.finish('Foliage', all); return; }
    if (clay === 'loading' && claysIn < n8) { caption.show('Ground', claysIn, all); return; }
    if (stage >= 3) { caption.show('Foliage', base + wanted + folNow, all); return; }
    if (stage === 1) { caption.show('Landmarks', tilesNow, all); return; }
    const size = [0, 0, 0, 0];
    let ends = base;
    for (let i = 0; i < total; i++) {
      if (!want[i]) continue;
      if (clay === 'none' && lmPrio.has(i)) { ends++; continue; }
      const r = away(i, f);
      size[seen[i] ? 0 : r < 1000 ? 1 : r < 2000 ? 2 : 3]++;
    }
    let part = 0;
    for (ends += size[0]; part < 3 && base + tilesNow >= ends; ends += size[++part]);
    caption.show(RINGS[part][0], base + tilesNow, all);
  };

  S.update = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    S.retire();
    const f = focus();
    range();
    look();
    choose(f);
    if (!whole && clay === 'none') startClay();
    pick();
    request(f);
    S.reprioritize((n) => (n.s === 8 ? 1e9 : n.foliage ? prio(index(n.tx, n.ty), f) : nodePrio(lnode(n.s, n.tx, n.ty), f)));
    // what is shown: a node chosen and ready replaces what it covers (finer nodes, or nothing yet); one finer than what
    // shows there waits until everything chosen under that is ready
    const ready = (n: LNode) => {
      if (S.nodes.get(n.key)?.state !== 'ready') return false;
      if (n.s !== 1 || stage < 3) return true;
      return S.nodes.get(`f/${n.tx}_${n.ty}`)?.state === 'ready';
    };
    for (const [k, p] of shownN) {
      // gone (freed elsewhere), or none of it wanted any more once the clay stands in for it
      if (S.nodes.get(k)?.state !== 'ready' || ((clay === 'ready' || cut) && !tilesOfNode(p).some((i) => want[i]))) shownN.delete(k);
    }
    for (const n of chosen.values()) {
      if (shownN.has(n.key) || !ready(n)) continue;
      const under = [...shownN.values()].filter((p) => overlap(p, n));
      if (under.every((p) => within(p, n))) {
        for (const p of under) shownN.delete(p.key);
        shownN.set(n.key, n);
        continue;
      }
      for (const p of under) {
        if (!shownN.has(p.key)) continue;
        const sub = [...chosen.values()].filter((q) => within(q, p));
        if (sub.every((q) => shownN.has(q.key) || ready(q))) {
          shownN.delete(p.key);
          for (const q of sub) shownN.set(q.key, q);
        }
      }
    }
    for (const p of shownN.values()) for (const i of tilesOfNode(p)) cover[i] = p.s;
    let changed = false;
    farMask.fill(0);
    const masks = (n: { s: number; tx: number; ty: number }) => {
      for (let y = n.ty * n.s; y < Math.min(d.ny, (n.ty + 1) * n.s); y++) for (let x = n.tx * n.s; x < Math.min(d.nx, (n.tx + 1) * n.s); x++) farMask[index(x, y)] = 1;
    };
    for (const n of S.nodes.values()) {
      if (n.s === 8 && clay === 'ready' && n.mesh) { n.mesh.visible = drawn(n.mesh); if (n.mesh.visible) masks(n); }
      if (n.s === 8 || n.state !== 'ready') continue;
      const on = shownN.has(n.foliage ? S.key(1, n.tx, n.ty) : n.key);
      if (on && !counted.has(n.key)) {
        counted.add(n.key);
        if (n.foliage) { if (n.mesh) n.mesh.material = folMat; S.coverBase(n); } else if (n.mesh) {
          n.mesh.customDepthMaterial = depthMat;
          if (n.s > 1) n.mesh.material = farMat; // a distance level's
        }
      }
      if (n.mesh) {
        n.mesh.visible = on && drawn(n.mesh);
        if (n.mesh.visible && !n.foliage) masks(n);
      }
    }
    for (let i = 0; i < total; i++) {
      const was = inTile[i];
      inTile[i] = cover[i] ? 1 : 0;
      folTile[i] = cover[i] > 1 || (cover[i] === 1 && counted.has(`f/${i % d.nx}_${Math.floor(i / d.nx)}`)) ? 1 : 0;
      cover[i] = 0;
      if (inTile[i] && !was) for (const b of onTile[i]) if (!complete[b] && tilesOf[b].every((k) => inTile[k])) {
        complete[b] = 1;
        if (isLandmark.has(b) || stage >= 2) { show(b); changed = true; }
      }
    }
    // what is neither shown nor chosen goes after a while (the foliage with its base: the base's mesh lacks what the
    // grass covers, stream.ts coverBase); a 1 m tile the budget left out only once the clay is in, as before
    for (const n of [...S.nodes.values()]) {
      if (n.s === 8 || n.foliage || n.state !== 'ready') continue;
      if (shownN.has(n.key) || chosen.has(n.key)) { n.used = now; continue; }
      // (out of range: none of its tiles in range of the view distance)
      const gone = !!cut && !tilesOfNode(lnode(n.s, n.tx, n.ty)).some((i) => inRange[i]);
      const out = n.s === 1 && !want[index(n.tx, n.ty)] && !gone;
      if (out && clay !== 'ready') continue;
      const fol = n.s === 1 ? S.nodes.get(`f/${n.tx}_${n.ty}`) : undefined;
      if (now - n.used > (gone ? FREE_MS : out ? 4000 : 15000) && !(n.pinned > now) && !((fol?.pinned ?? 0) > now)) {
        if (fol) { counted.delete(fol.key); S.free(fol); }
        counted.delete(n.key);
        S.free(n);
      }
    }
    occluders();
    let wanted = 0, tilesNow = 0, folNow = 0, pending = 0;
    for (let i = 0; i < total; i++) if (want[i]) { wanted++; tilesNow += inTile[i]; folNow += folTile[i]; }
    for (const k of chosen.keys()) if (!shownN.has(k)) pending++;
    settled = tilesNow === wanted && pending === 0;
    // (the landmarks wanted: those beyond the view distance never come)
    if (stage === 1 && (lmShown === landmarks.length || landmarks.every((b) => shown[b + 1] || tilesOf[b].some((k) => !want[k])))) toStage2();
    if (stage === 2 && tilesNow === wanted) stage = U.uStage.value = 3;
    if (stage >= 3) for (const n of chosen.values()) {
      if (n.s === 1 && S.nodes.get(n.key)?.state === 'ready') S.requestFoliage(n.tx, n.ty, prio(index(n.tx, n.ty), f));
    }
    if (stage === 3 && folNow === wanted) stage = 4;
    // (the first moment's terrain: under the tiles in, and beyond the view distance, where the far ground is)
    if (terrain && stage >= 2) terrain.dropUnder(cut ? inTile.map((v, i) => v | (inRange[i] ^ 1)) : inTile);
    if (terrain && stage >= 3 && whole) terrain.dispose();
    terrain?.cover(farMask);
    far.on = !!cut;
    if (cut) far.setMask(farMask);
    if (changed) shownTex.needsUpdate = true;
    realTris = 0;
    for (let k = 0; k < nk; k++) {
      const real = blkWant[k + 1] > 0 && blockTiles[k].every((i) => inTile[i]);
      flags[k + 1] = real ? 255 : 0;
      if (real) realTris += tris[k];
    }
    if (clay === 'ready') {
      const key = flags.join('');
      if (key !== flagKey) { flagKey = key; flagTex.needsUpdate = true; }
    }
    // queued jobs no longer chosen (with the distance levels at any time; else once the clay is in, as before)
    if (clay === 'ready' || lodOn) S.dropQueued((n) => n.s === 8 || n.pinned > now || (n.foliage ? level[index(n.tx, n.ty)] === 1 : chosen.has(n.key)));
    progress(f, wanted, tilesNow, folNow);
    S.pump();
  };

  // Occlusion culling (occlusion.ts): a tile's columns block the view once it is in and all its buildings show --
  // drawn by whichever level (the least of the levels' heights where two are in), never while the clay stands in
  // for some of the city (its blocks are cut out of the tiles' meshes then)
  const occ = new Occlusion(W, D, Uint8Array.from(meta.palette, (p) => (p[3] === MAT.LEAF || p[3] === MAT.WATER || p[3] === MAT.JET ? 0 : 1)), meta.H + 3);
  let occOn = occlusion, occAt = 0, occN = -1;
  const occSrc = Array.from({ length: total }, () => [] as ColumnData[]), occStats = { ms: 0, meshes: 0, hidden: 0 };
  // A hidden mesh moves to layer HIDDEN alone: the camera (layer 0) passes it over before anything else; the
  // shadow passes still draw it (daylight.ts gives the view's camera all layers during them, as three tests those). Updated on the scene's onBeforeRender (before the
  // depth pre-pass's, prepass.ts), for the main camera only, again whenever it moved.
  const HIDDEN = 5, cam0 = camera as THREE.PerspectiveCamera, before = scene.onBeforeRender.bind(scene);
  const cull = (cam: THREE.Camera) => {
    if (cam !== camera) return;
    const now = performance.now(), on = occOn && clay === 'none';
    const kids = S.group.children;
    if (!on) {
      if (occN !== -1) { for (const m of kids) m.layers.mask = 1; occN = -1; occStats.hidden = 0; }
      return;
    }
    // again when the camera moved, the tiles changed, or now and then
    const t0 = performance.now(), moved = occ.prepare(cam0);
    if (!moved && kids.length === occN && now - occAt < 250) return;
    if (!moved) occ.prepare(cam0, true);
    occAt = now; occN = kids.length;
    // (not by o.visible: n8ao renders the scene again with this camera for its transparent things, every opaque mesh
    // made invisible for it -- judged then, every tile came out unhidden until the next update, by turns with the
    // main pass's. Visibility is three's own test anyway; this one is by the box alone)
    let hidden = 0;
    for (const o of kids) {
      const m = o as THREE.Mesh, box = m.geometry?.boundingBox;
      const h = !!box && m.material !== clayMat && occ.hidden(box);
      m.layers.mask = h ? 1 << HIDDEN : 1;
      hidden += +h;
    }
    occStats.ms = performance.now() - t0; occStats.meshes = kids.length; occStats.hidden = hidden;
  };
  scene.onBeforeRender = (...a) => { cull(a[2]); before(...a); };
  function occluders() {
    for (let i = 0; i < total; i++) {
      const tx = i % d.nx, ty = Math.floor(i / d.nx), src: ColumnData[] = [];
      if (stage >= 2 && inTile[i] && onTile[i].every((b) => shown[b + 1])) for (const s of lods) {
        const nd = S.nodes.get(S.key(s, Math.floor(tx / s), Math.floor(ty / s)));
        // (a node meshed again after a lost context is not drawn until then: it hides nothing meanwhile)
        if (nd?.remesh) { src.length = 0; break; }
        if (nd?.data) src.push(nd.data);
      }
      const was = occSrc[i];
      if (was.length === src.length && was.every((c, k) => c === src[k])) continue;
      occSrc[i] = src;
      occ.setTile(tx, ty, src);
    }
  }

  const labelled = new Map(meta.labels.map((l) => [`${l.x + 0.5},${l.y + 0.5}`, bldAt(l.x, l.y)]));
  return {
    // a building's label once it shows; the others (parks, the river) with the foliage; over clay, all of them
    gate: (x: number, z: number) => { const b = labelled.get(`${x},${z}`) ?? -1; return clay !== 'none' || (b >= 0 ? shown[b + 1] > 0 : stage >= 4); },
    get complete() { return stage >= 4 && clay !== 'loading'; },
    get realTris() { return realTris; },
    // the distance levels now (tools): nodes shown per level, chosen ones not shown yet, wanted tiles shown by nothing
    get lod() {
      const shownBy: Record<number, number> = {};
      for (const p of shownN.values()) shownBy[p.s] = (shownBy[p.s] ?? 0) + 1;
      let pending = 0, gaps = 0;
      for (const k of chosen.keys()) if (!shownN.has(k)) pending++;
      for (let i = 0; i < total; i++) if (want[i] && !inTile[i]) gaps++;
      return { on: lodOn, shownBy, pending, gaps };
    },
    // every tile the budget asks for is in
    get settled() { return settled; },
    setLod,
    // the view distance (0: the whole map): the next update loads, shows and frees by it
    setDist(m: number) { cut = m; },
    setOcclusion(on: boolean) { occOn = on; },
    // occlusion culling now (tools): on, the last update's cost (ms), tile meshes, of them hidden
    get occlusion() { return { on: occOn && clay === 'none', ...occStats }; },
    occluder: occ,
    cityTris,
  };
}

// Each block's triangles at 1 m, as meshed (tools/tris.mjs: level 1's quads by the column under their middle; without
// the foliage). Data built without that step has none: then the footprints of the buildings whose middle lies in the
// block, scaled to ~14 M triangles for the whole city, so the detail still spends its budget on the blocks nearest the
// focus (without it any detail under 1 would leave the whole city as clay).
function blockTris(blocks: number[][], buildings: number[][], blk: Uint16Array, W: number, D: number) {
  if (blocks.every((b) => b[7] !== undefined)) return blocks.map((b) => b[7] || 0);
  const t = new Float64Array(blocks.length);
  for (const [cx, cy, n] of buildings) {
    const k = blk[Math.min(D - 1, Math.max(0, Math.round(cy))) * W + Math.min(W - 1, Math.max(0, Math.round(cx)))] - 1;
    if (k >= 0 && k < t.length) t[k] += n;
  }
  const sum = t.reduce((a, b) => a + b, 0) || 1;
  return [...t].map((x) => (x * 14e6) / sum);
}

// one terrain piece per 128 m tile (heights every 4 m, ground colours every 2 m), each dropped once its tile is in:
// under the real ground it would flicker through
async function loadTerrain(meta: Meta, scene: THREE.Scene, nx: number, ny: number) {
  const { W, D } = meta, buf = await fetchGzip('data/terrain.bin');
  const tw = Math.ceil(W / 4), th = Math.ceil(D / 4), hd = new Uint16Array(buf, 0, tw * th), C = T / 4;
  const cw = Math.floor(W / 2), ch = Math.floor(D / 2), rgb = new Uint8Array(buf, tw * th * 2, cw * ch * 3), rgba = new Uint8Array(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) { rgba.set(rgb.subarray(3 * i, 3 * i + 3), 4 * i); rgba[4 * i + 3] = 255; }
  const tex = dataTexture(rgba, cw, ch, THREE.RGBAFormat);
  Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.NearestFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, anisotropy: 8 });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
  const pieces: (THREE.Mesh | null)[] = new Array(nx * ny).fill(null);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const c0 = tx * C, r0 = ty * C, nc = Math.min(C, tw - 1 - c0) + 1, nr = Math.min(C, th - 1 - r0) + 1;
    if (nc < 2 || nr < 2) continue;
    const pos = new Float32Array(nc * nr * 3), uv = new Float32Array(nc * nr * 2), idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const k = r * nc + c;
      pos.set([(c0 + c) * 4, hd[(r0 + r) * tw + c0 + c] / 10, (r0 + r) * 4], k * 3);
      uv.set([(c0 + c) * 2 / cw, (r0 + r) * 2 / ch], k * 2);
    }
    for (let r = 0, k = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++, k += 6) { const i = r * nc + c; idx.set([i, i + nc, i + 1, i + 1, i + nc, i + nc + 1], k); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    scene.add(m);
    pieces[ty * nx + tx] = m;
  }
  return {
    dropUnder(inTile: Uint8Array) {
      pieces.forEach((m, i) => { if (m && inTile[i]) { scene.remove(m); m.geometry.dispose(); pieces[i] = null; } });
    },
    // where a piece still stands (the far ground gives way to it)
    cover(mask: Uint8Array) { pieces.forEach((m, i) => { if (m) mask[i] = 1; }); },
    // (once every piece is gone)
    dispose() { if (tex.image.data && pieces.every((m) => !m)) { tex.dispose(); tex.image.data = null as unknown as Uint8Array; } },
  };
}
