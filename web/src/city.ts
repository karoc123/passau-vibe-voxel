import * as THREE from 'three';
import type { Caption } from './caption';
import type { TileNode, TileStreamer } from './stream';
import type { ColumnData, Meta, Zones } from './types';
import { dataTexture, fetchJson, pushTo } from './util';
import type { DepthPrepass } from './prepass';
import type { Lod } from './settings';
import { MAT, makeBuildDepthMaterial, makeVoxelMaterial, makeVoxelPrepassMaterial, type VoxelUniforms } from './voxelMaterial';
import { Occlusion } from './occlusion';
import { FarGround } from './farground';
import { FieldPages } from './fields';
import { loadTerrain } from './terrain';
import type { LampLight } from './lamplight';

const T = 128;
// The view distance (settings.ts dist, setDist): a 128 m tile is wanted (loaded, meshed) while its nearest point lies
// within the distance + LOAD_M of the camera along the ground, kept once in until it is further than + KEEP_M (so a
// camera moving to and fro at the edge doesn't load and free the same tiles over and over), and freed FREE_MS after
// it left. A mesh is drawn while its box's nearest point is within the distance + DRAW_M: the fog (daylight.ts) is full
// at the distance, so a tile comes and goes unseen. Beyond, the coarse far ground (farground.ts) stands in.
const LOAD_M = 150, KEEP_M = 400, DRAW_M = 32, FREE_MS = 8000;
// The first moment's ground (terrain.ts): the 128 m tiles within the view distance + LOAD_M, but no further than
// FIRST_M + LOAD_M (a mesh of 33 x 33 heights each until its tile is in: on a large map at a 5 km distance ~2000 of
// them, 1.4 M vertices, seconds of the start). Beyond, the far ground stands in until the tiles come. (All of the old
// 3.2 x 1.4 km map lay within it from the overview.)
const FIRST_M = 2500;
const RINGS: [string, number][] = [['Buildings in view', 0], ['Buildings within 1 km', 1000], ['Buildings within 2 km', 2000], ['Buildings to the edge', Infinity]];

// The city at 1 m and its distance levels (2, 4, 8 m), as fine as the budget allows (triangles drawn by the tiles,
// meta.json tiles.tris; on most computers no limit), shown as it arrives, in one order:
//   1. the ground: the terrain, in chunks of 1 km (terrain.ts), those in range of the view distance (to FIRST_M)
//   2. landmarks: their tiles first, each landmark as soon as all its tiles are in
//   3. everything else, nearest to the view first, each building once all its tiles are in
//   4. foliage: trees and grass, their own tiles (tiles/1f), then traffic
export async function installCity({ streamer: S, uniforms: U, meta, scene, focus, camera, caption, budget, lamps, prepass, lod = { mode: 'auto', px: 1.2 }, occlusion = true, dist = 0, crop = null, pixelsHigh = () => innerHeight * Math.min(devicePixelRatio, 2) }: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms;
  meta: Meta;
  scene: THREE.Scene;
  focus: () => THREE.Vector3;
  camera: THREE.Camera;
  caption: Caption;
  budget: () => number;
  // the light on the ground at night (lamplight.ts), drawn into the nodes' pages
  lamps?: LampLight;
  prepass?: DepthPrepass | null;
  lod?: { mode: Lod; px: number };
  occlusion?: boolean;
  // the view distance in metres, 0: the whole map
  dist?: number;
  // the drawing buffer's height in pixels (the renderer's own: the resolution setting scales it)
  pixelsHigh?: () => number;
  // a tiny scene (?crop=, main.ts): only the 128 m tiles meeting this box of the map (metres x0, z0, x1, z1) are ever
  // in range, whatever the camera does; no far ground. For quick screenshots and checks (web/tools/shoot.mjs)
  crop?: [number, number, number, number] | null;
}) {
  const d = S.dims[1], total = d.nx * d.ny, index = (tx: number, ty: number) => ty * d.nx + tx;
  // the crop in tiles, inclusive
  const ct = crop && [Math.max(0, Math.floor(crop[0] / T)), Math.max(0, Math.floor(crop[1] / T)),
    Math.min(d.nx - 1, Math.ceil(crop[2] / T) - 1), Math.min(d.ny - 1, Math.ceil(crop[3] / T) - 1)];
  const cropList: number[] = [];
  if (ct) for (let ty = ct[1]; ty <= ct[3]; ty++) for (let tx = ct[0]; tx <= ct[2]; tx++) cropList.push(index(tx, ty));
  // (the buildings' boxes: which tiles each one is on; the columns' buildings come with the tiles)
  const zonesIn = fetchJson<Zones>('data/zones.json');
  caption.show('Terrain', 0, 2 * total);
  // (the tiles in range as range() below will find them: the camera's window, or the whole map)
  const terrainTiles: number[] = [];
  {
    camera.updateMatrixWorld();
    const c = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld), R = Math.min(dist || FIRST_M, FIRST_M) + LOAD_M;
    const x0 = Math.max(0, Math.floor((c.x - R) / T)), x1 = Math.min(d.nx - 1, Math.floor((c.x + R) / T));
    const y0 = Math.max(0, Math.floor((c.z - R) / T)), y1 = Math.min(d.ny - 1, Math.floor((c.z + R) / T));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
      if (Math.hypot(Math.max(tx * T - c.x, 0, c.x - (tx + 1) * T), Math.max(ty * T - c.z, 0, c.z - (ty + 1) * T)) <= R) terrainTiles.push(index(tx, ty));
  }
  const terrain = await loadTerrain(meta, scene, d.nx, ct ? cropList : terrainTiles);
  const zones = await zonesIn;
  document.querySelector('#loading')?.classList.add('hidden');
  // (each building's box x0, y0, x1, y1)
  const boxes: [number, number, number, number][] = zones.boxes
    ? Array.from({ length: zones.boxes.length / 4 }, (_, i) => { const b = zones.boxes!; return [b[4 * i], b[4 * i + 1], b[4 * i] + b[4 * i + 2], b[4 * i + 1] + b[4 * i + 3]]; })
    : zones.buildings!.map((b) => [b[3], b[4], b[5], b[6]]);
  const nb = boxes.length, shown = new Uint8Array(128 * Math.ceil((nb + 1) / 128));
  const shownTex = dataTexture(shown, 128, shown.length / 128, THREE.RedFormat);
  U.uBldOn.value = shownTex;
  U.uStage.value = 1;
  const tilesIn = (x0: number, y0: number, x1: number, y1: number) => {
    const t = [];
    for (let ty = Math.floor(y0 / T); ty <= Math.min(d.ny - 1, Math.floor((y1 - 1) / T)); ty++)
      for (let tx = Math.floor(x0 / T); tx <= Math.min(d.nx - 1, Math.floor((x1 - 1) / T)); tx++) t.push(index(tx, ty));
    return t;
  };
  // (by building: as many as there are, at most 16 k with 14-bit ids; by tile only where there are any)
  const tilesOf = boxes.map((b) => tilesIn(b[0], b[1], b[2], b[3]));
  const onTile = new Map<number, number[]>(), none: number[] = [], bldsOn = (i: number) => onTile.get(i) ?? none;
  tilesOf.forEach((t, i) => t.forEach((k) => pushTo(onTile, k, i)));

  // the view distance: which tiles are in range of the camera (along the ground), with the hysteresis above. Only the
  // tiles of a window around the camera are looked at (the distance + KEEP_M: none further can be in range), and those
  // of the last one, which may leave it; the whole map only where the distance is (0, everything in range).
  // wanted, tilesNow, folNow: the tiles in range, of them those shown (inTile), and those with their foliage (folTile)
  let cut = dist, cutWas = -1, rangeList: number[] = [], wanted = 0, tilesNow = 0, folNow = 0, rangeGen = 0;
  const inRange = new Uint8Array(total), rangeAt = new Uint32Array(total), camAt = new THREE.Vector3();
  const flat = (x0: number, z0: number, x1: number, z1: number) =>
    Math.hypot(Math.max(x0 - camAt.x, 0, camAt.x - x1), Math.max(z0 - camAt.z, 0, camAt.z - z1));
  const enter = (i: number) => { inRange[i] = 1; wanted++; tilesNow += inTile[i]; folNow += folTile[i]; };
  const leave = (i: number) => {
    inRange[i] = 0; wanted--; tilesNow -= inTile[i]; folNow -= folTile[i];
    if (stage >= 2) dropPiece(i);
  };
  const range = () => {
    camera.updateMatrixWorld();
    camAt.setFromMatrixPosition(camera.matrixWorld);
    if (ct) {
      if (cutWas !== -2) { for (const i of cropList) enter(i); rangeList = cropList; }
      cutWas = -2;
      return;
    }
    if (!cut) {
      if (cutWas !== 0) { for (let i = 0; i < total; i++) if (!inRange[i]) enter(i); rangeList = Array.from({ length: total }, (_, i) => i); }
      cutWas = 0;
      return;
    }
    cutWas = cut;
    const R = cut + KEEP_M, g = ++rangeGen, next: number[] = [];
    const x0 = Math.max(0, Math.floor((camAt.x - R) / T)), x1 = Math.min(d.nx - 1, Math.floor((camAt.x + R) / T));
    const y0 = Math.max(0, Math.floor((camAt.z - R) / T)), y1 = Math.min(d.ny - 1, Math.floor((camAt.z + R) / T));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const i = index(tx, ty);
      if (flat(tx * T, ty * T, (tx + 1) * T, (ty + 1) * T) <= cut + (inTile[i] ? KEEP_M : LOAD_M)) { next.push(i); rangeAt[i] = g; }
    }
    for (const i of rangeList) if (rangeAt[i] !== g && inRange[i]) leave(i);
    for (const i of next) if (!inRange[i]) enter(i);
    rangeList = next;
  };
  // a mesh drawn at this distance
  const drawn = (m: THREE.Mesh) => {
    const b = m.geometry.boundingBox;
    return !cut || !b || flat(b.min.x, b.min.z, b.max.x, b.max.z) <= cut + DRAW_M;
  };
  // The far ground gives way (farground.ts mask) where some tile mesh is drawn or the first moment's terrain stands: per
  // tile how many of those, changed as they come and go
  const far = new FarGround(meta, d.nx, d.ny), farN = new Uint16Array(total);
  scene.add(far.group);
  const farAdd = (i: number, k: number) => { const was = farN[i]; farN[i] += k; if (!was !== !farN[i]) far.mark(i, farN[i] > 0); };
  const farNode = (n: { s: number; tx: number; ty: number }, k: number) => {
    for (let y = n.ty * n.s; y < Math.min(d.ny, (n.ty + 1) * n.s); y++) for (let x = n.tx * n.s; x < Math.min(d.nx, (n.tx + 1) * n.s); x++) farAdd(index(x, y), k);
  };
  terrain.each((i) => farAdd(i, 1));
  const dropPiece = (i: number) => { if (terrain.drop(i)) farAdd(i, -1); };
  // the building under each label (zones.json labels)
  const labelBld = meta.labels.map((_, i) => (zones.labels?.[i] ?? 0) - 1);
  const landmarks = [...new Set(labelBld.filter((b) => b >= 0))], isLandmark = new Set(landmarks);
  const lmPrio = new Map<number, number>();
  landmarks.forEach((b, j) => tilesOf[b].forEach((k) => { if (!lmPrio.has(k)) lmPrio.set(k, 1e6 - j); }));

  // in the view's frustum: a tile tested when first asked after look() (seenAt: the look it was tested in), a node by
  // its box first (out of it, so is every tile of it)
  const seenAt = new Uint32Array(total), seenV = new Uint8Array(total), frustum = new THREE.Frustum(), box = new THREE.Box3(), pm = new THREE.Matrix4();
  // (a tile's box: the ground to the map's top, meta.H, as the occlusion's; not a fixed height)
  const boxTop = meta.H + 3;
  let lookN = 0;
  const look = () => {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    lookN++;
  };
  const seen = (i: number) => {
    if (seenAt[i] !== lookN) {
      const tx = i % d.nx, ty = Math.floor(i / d.nx);
      box.min.set(tx * T, 0, ty * T); box.max.set((tx + 1) * T, boxTop, (ty + 1) * T);
      seenV[i] = frustum.intersectsBox(box) ? 1 : 0;
      seenAt[i] = lookN;
    }
    return seenV[i];
  };
  const away = (i: number, f: THREE.Vector3) => Math.hypot((i % d.nx + 0.5) * T - f.x, (Math.floor(i / d.nx) + 0.5) * T - f.z);
  const prio = (i: number, f: THREE.Vector3) => lmPrio.get(i) ?? (seen(i) ? 1e5 : 0) - away(i, f);

  // Distance levels (scripts/tiles.py LOD_LEVELS): far from the camera, where a metre is a pixel or less, the city is
  // drawn from its 2 m tiles instead of the 1 m ones, trees included, and further out (where a 2 m cell is under
  // pxCoarse: beyond ~3 km at the default 1.2 px and a 28° view) from its 4 m ones; from the 8 m ones only where the
  // budget runs out. The levels nest: a node of level s holds s x s tiles of 128 m. Each update picks the levels as a
  // quadtree from the coarsest down: a node is drawn as it is while a cell of the next finer level would come out under
  // pxCoarse pixels at its nearest point (back to the finer one above pxFine, so a camera at the switch doesn't flip it
  // to and fro); an 8 m node always splits, budget permitting. The budget (triangles drawn, budget(): meta.json
  // tiles.tris, a 1 m tile with its foliage) goes to the splits first of 8 m nodes (the whole map at 4 m: 1.1 M), then
  // in the order of that pixel size, largest first, so the nearest first, a node out of view as if twice as far: a
  // split that would take the sum over it ends the splitting (one made last time may go 10 % over, again against
  // flipping). What is drawn (shown) only changes once all of it is in: a coarse node goes once every finer
  // node chosen under it (a 1 m tile with its foliage, after the first load) is ready, so nothing is ever missing; the
  // nodes shown never overlap. Each tile's own faces close it at its edges, so a 1 m tile next to a 2 m one (or any
  // two levels) leaves no crack. Around the camera (any node within FLOOR_M of it, the volume's height included: a
  // street, Oberhaus, not the overview high above) the city is never coarser than 2 m, whatever the budget, so a
  // camera in the street never stands inside a 4 or 8 m block: those splits come first and are paid first from the
  // budget. lod (settings.ts, ?lod= ?lodpx=): 'off' 1 m only (no budget), 'far' never finer than
  // 2 m, 'far4' than 4 m, 'far8' than 8 m (to look at them close up); px: pxCoarse, in the drawing buffer's pixels (a
  // lower resolution draws the city coarser; the next update picks again with it). setLod changes them live: the next
  // update picks anew, and what shows changes over as the newly chosen nodes come in, as for a camera move.
  const lods = [...S.levels].sort((a, b) => a - b);
  // (levels coarser than this are chosen only for the budget)
  const PX_TOP = 4, FLOOR_M = 100, FLOOR_S = 2;
  let lodOn = false, pxCoarse = 1.2, pxFine = 1.5, lodMin = 1;
  const setLod = (l: { mode: Lod; px: number }) => {
    lodOn = lods.length > 1 && l.mode !== 'off';
    pxCoarse = l.px; pxFine = l.px * 1.25; lodMin = l.mode === 'far' ? 2 : l.mode === 'far4' ? 4 : l.mode === 'far8' ? 8 : 1;
    last = 0;
  };
  interface LNode { s: number; tx: number; ty: number; key: string; x0: number; y0: number; x1: number; y1: number }
  const lnode = (s: number, tx: number, ty: number): LNode =>
    ({ s, tx, ty, key: S.key(s, tx, ty), x0: tx * s, y0: ty * s, x1: Math.min((tx + 1) * s, d.nx), y1: Math.min((ty + 1) * s, d.ny) });
  const tilesOfNode = (n: LNode) => { const t = []; for (let y = n.y0; y < n.y1; y++) for (let x = n.x0; x < n.x1; x++) t.push(index(x, y)); return t; };
  // Nodes of a set (chosen, shownN: never two of one overlapping) looked up by place, not by going over the set: the
  // one at a tile, the one holding a node (coarser), those within a node (finer or itself)
  const at = (m: Map<string, LNode>, x: number, y: number) => {
    for (const s of lods) { const n = m.get(S.key(s, Math.floor(x / s), Math.floor(y / s))); if (n) return n; }
    return undefined;
  };
  const holding = (m: Map<string, LNode>, n: LNode) => {
    for (const s of lods) if (s > n.s) { const p = m.get(S.key(s, Math.floor(n.x0 / s), Math.floor(n.y0 / s))); if (p) return p; }
    return undefined;
  };
  const inside = (m: Map<string, LNode>, n: LNode) => {
    const out: LNode[] = [];
    for (const s of lods) if (s <= n.s) {
      const r = n.s / s;
      for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) { const q = m.get(S.key(s, n.tx * r + dx, n.ty * r + dy)); if (q) out.push(q); }
    }
    return out;
  };
  // a node's triangles as drawn (a 1 m tile with its foliage: meta.json tiles.tris)
  const tc = meta.tiles.tris;
  const cost = (n: LNode) => {
    if (n.s === 1) { const i = index(n.tx, n.ty); return tc['1c'][i] + tc['1f'][i]; }
    return tc[String(n.s) as '2' | '4' | '8']?.[n.ty * S.dims[n.s].nx + n.tx] ?? 0;
  };
  const sumOf = (k: '1' | '1f' | '1c' | '2' | '4' | '8') => tc[k]?.reduce((a, b) => a + b, 0) ?? 0;
  const chosen = new Map<string, LNode>(), shownN = new Map<string, LNode>();
  let finer = new Set<string>(), pickTris = 0;
  const eye = new THREE.Vector3();
  // some tile of it in range (none can be where its nearest point is beyond the distance + KEEP_M)
  const nodeIn = (n: LNode) => {
    if (n.x0 >= d.nx || n.y0 >= d.ny) return false;
    if (ct) return n.x0 <= ct[2] && n.x1 > ct[0] && n.y0 <= ct[3] && n.y1 > ct[1];
    if (!cut) return true;
    if (flat(n.x0 * T, n.y0 * T, n.x1 * T, n.y1 * T) > cut + KEEP_M) return false;
    for (let y = n.y0; y < n.y1; y++) for (let x = n.x0; x < n.x1; x++) if (inRange[index(x, y)]) return true;
    return false;
  };
  const nodeSeen = (n: LNode) => {
    box.min.set(n.x0 * T, 0, n.y0 * T); box.max.set(n.x1 * T, boxTop, n.y1 * T);
    if (!frustum.intersectsBox(box)) return false;
    for (let y = n.y0; y < n.y1; y++) for (let x = n.x0; x < n.x1; x++) if (seen(index(x, y))) return true;
    return false;
  };
  // the splits to make, a binary max-heap by w
  type Open = { n: LNode; k: number; w: number; floor: boolean };
  const heapUp = (h: Open[], o: Open) => {
    let i = h.push(o) - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].w >= o.w) break; h[i] = h[p]; i = p; }
    h[i] = o;
  };
  const heapTake = (h: Open[]) => {
    const top = h[0], o = h.pop()!, n = h.length;
    if (!n) return top;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && h[c + 1].w > h[c].w) c++;
      if (h[c].w <= o.w) break;
      h[i] = h[c]; i = c;
    }
    h[i] = o;
    return top;
  };
  // The pick goes down the quadtree only where it splits: from the coarsest level's nodes in range (those in the window
  // around the camera, as range()), each split taking the next in the order, a heap's first
  const pick = () => {
    chosen.clear(); pickTris = 0;
    const add = (n: LNode) => { chosen.set(n.key, n); };
    if (!lodOn) { for (const i of rangeList) add(lnode(1, i % d.nx, Math.floor(i / d.nx))); return; }
    eye.setFromMatrixPosition(camera.matrixWorld);
    const cam = camera as THREE.PerspectiveCamera;
    const focal = pixelsHigh() / 2 / Math.tan((cam.fov * Math.PI) / 360) * (cam.zoom || 1);
    const next = new Set<string>(), B = budget();
    // the nodes to split, with the finer level's cell in pixels (w: the order of the splits); sum: the triangles chosen
    const open: Open[] = [];
    let sum = 0;
    const visit = (k: number, n: LNode) => {
      if (!nodeIn(n)) return;
      sum += cost(n);
      if (k === 0 || n.s <= lodMin) { add(n); return; }
      const dist = Math.hypot(Math.max(n.x0 * T - eye.x, 0, eye.x - n.x1 * T), Math.max(-eye.y, 0, eye.y - meta.H), Math.max(n.y0 * T - eye.z, 0, eye.z - n.y1 * T));
      const was = finer.has(n.key), px = (focal * lods[k - 1]) / Math.max(dist, 1);
      const w = px * (was ? 1.25 : 1) * (nodeSeen(n) ? 1 : 0.5);
      const floor = n.s > FLOOR_S && dist <= FLOOR_M;
      if (floor || n.s > PX_TOP || px > (was ? pxCoarse : pxFine)) heapUp(open, { n, k, w: (floor ? 2e9 : n.s > PX_TOP ? 1e9 : 0) + w, floor });
      else add(n);
    };
    const kids = (k: number, n: LNode) => {
      const sf = lods[k - 1], r = n.s / sf, out: LNode[] = [];
      for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) out.push(lnode(sf, n.tx * r + dx, n.ty * r + dy));
      return out;
    };
    const top = lods.length - 1, st = lods[top], dt = S.dims[st], R = cut + KEEP_M, L = st * T;
    const x0 = cut ? Math.max(0, Math.floor((camAt.x - R) / L)) : 0, x1 = cut ? Math.min(dt.nx - 1, Math.floor((camAt.x + R) / L)) : dt.nx - 1;
    const y0 = cut ? Math.max(0, Math.floor((camAt.z - R) / L)) : 0, y1 = cut ? Math.min(dt.ny - 1, Math.floor((camAt.z + R) / L)) : dt.ny - 1;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) visit(top, lnode(st, tx, ty));
    while (open.length) {
      const { n, k, floor } = heapTake(open), sub = kids(k, n).filter(nodeIn);
      const more = sub.reduce((a, c) => a + cost(c), -cost(n));
      // (the first split over the budget ends them all: a cheaper one further down the order would take the
      // budget from a dear one before it, a meadow at 1 m before the castle)
      // (the floor's splits come before any other, and always happen)
      if (!floor && sum + more > B * (finer.has(n.key) ? 1.1 : 1)) { add(n); for (const o of open) add(o.n); break; }
      next.add(n.key);
      sum -= cost(n);
      for (const c of sub) visit(k - 1, c);
    }
    finer = next;
    pickTris = sum;
  };
  // A coarser node's priority, as its tiles' best, without going over them: a landmark's on it (once per node, kept),
  // else in view or not as the node, less the distance to its nearest tile's middle
  const lmNode = new Map<string, number | undefined>();
  const nodePrio = (n: LNode, f: THREE.Vector3) => {
    if (n.s === 1) return prio(index(n.tx, n.ty), f);
    if (!lmNode.has(n.key)) {
      let m: number | undefined;
      for (const i of tilesOfNode(n)) { const p = lmPrio.get(i); if (p !== undefined && !(m! >= p)) m = p; }
      lmNode.set(n.key, m);
    }
    const lm = lmNode.get(n.key);
    if (lm !== undefined) return lm;
    const cx = Math.min(Math.max(f.x / T - 0.5, n.x0), n.x1 - 1), cy = Math.min(Math.max(f.z / T - 0.5, n.y0), n.y1 - 1);
    return (nodeSeen(n) ? 1e5 : 0) - Math.hypot((Math.round(cx) + 0.5) * T - f.x, (Math.round(cy) + 0.5) * T - f.z);
  };
  const request = (f: THREE.Vector3) => {
    for (const n of chosen.values()) S.request(n.s, n.tx, n.ty, nodePrio(n, f), n.s === 1);
  };

  // what the shader reads of the nodes shown (fields.ts): their pages, given and taken back with shownN
  const pages = new FieldPages(U, d.nx, d.ny, lamps);
  const depthMat = makeBuildDepthMaterial(U), folMat = makeVoxelMaterial(U), farMat = makeVoxelMaterial(U, { far: true });
  prepass?.add(farMat, makeVoxelPrepassMaterial(U));
  folMat.polygonOffset = true; folMat.polygonOffsetFactor = -1; folMat.polygonOffsetUnits = -2; // grass wins over the base's bare earth
  prepass?.add(folMat, makeVoxelPrepassMaterial(U));
  // Per tile: shown (inTile: some node shown over it), with its foliage (folTile). Kept up to date where something
  // changed (dirty: the tiles of a node shown or hidden, of a foliage tile counted or freed), not over the map
  const inTile = new Uint8Array(total), folTile = new Uint8Array(total), complete = new Uint8Array(nb), counted = new Set<string>();
  const dirty = new Set<number>(), touched: LNode[] = [];
  let lmShown = 0, stage = 1, last = 0, settled = false;
  // the occluders (occlusion.ts) of a tile again where its sources may have changed: shown or hidden, a building on it
  // shown, a node's column data in or out (occSig: what each node had at the last look)
  const occDirty = new Set<number>(), occSig = new Map<string, ColumnData | 'remesh'>();
  const occNode = (n: { s: number; tx: number; ty: number }) => {
    for (let y = n.ty * n.s; y < Math.min(d.ny, (n.ty + 1) * n.s); y++) for (let x = n.tx * n.s; x < Math.min(d.nx, (n.tx + 1) * n.s); x++) occDirty.add(index(x, y));
  };
  const show = (b: number) => {
    if (shown[b + 1]) return;
    shown[b + 1] = 255;
    if (isLandmark.has(b)) lmShown++;
    for (const k of tilesOf[b]) occDirty.add(k);
  };
  const setTile = (i: number, inT: number, fol: number) => {
    if (inRange[i]) { tilesNow += inT - inTile[i]; folNow += fol - folTile[i]; }
    inTile[i] = inT; folTile[i] = fol;
  };
  function toStage2() {
    stage = U.uStage.value = 2;
    for (let b = 0; b < nb; b++) if (complete[b]) show(b);
    shownTex.needsUpdate = true;
    // (once: the first moment's terrain goes under the tiles in, and beyond the view distance, where the far ground is;
    // later as tiles come in or leave the range. The occluders count from now on)
    terrain.each((i) => { if (inTile[i] || ((cut || ct) && !inRange[i])) dropPiece(i); });
    for (let i = 0; i < total; i++) if (inTile[i]) occDirty.add(i);
  }

  setLod(lod);
  range();
  look();
  pick();
  request(focus());
  S.pump();

  // the caption's parts of the long building stage: what you see, then rings around you
  const progress = (f: THREE.Vector3) => {
    const all = 2 * wanted;
    if (stage === 4) { caption.finish('Foliage', all); return; }
    if (stage >= 3) { caption.show('Foliage', wanted + folNow, all); return; }
    if (stage === 1) { caption.show('Landmarks', tilesNow, all); return; }
    // (while loading only: the tiles in range)
    const size = [0, 0, 0, 0];
    let ends = 0;
    for (const i of rangeList) {
      if (lmPrio.has(i)) { ends++; continue; }
      const r = away(i, f);
      size[seen(i) ? 0 : r < 1000 ? 1 : r < 2000 ? 2 : 3]++;
    }
    let part = 0;
    for (ends += size[0]; part < 3 && tilesNow >= ends; ends += size[++part]);
    caption.show(RINGS[part][0], tilesNow, all);
  };

  // the tile meshes drawn last time (not foliage): the far ground gives way under them
  let masking = new Map<string, TileNode>();
  S.update = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    S.retire();
    const f = focus();
    range();
    look();
    pick();
    request(f);
    S.reprioritize((n) => (n.foliage ? prio(index(n.tx, n.ty), f) : nodePrio(lnode(n.s, n.tx, n.ty), f)));
    // what is shown: a node chosen and ready replaces what it covers (finer nodes, or nothing yet); one finer than what
    // shows there waits until everything chosen under that is ready
    const ready = (n: LNode) => {
      if (S.nodes.get(n.key)?.state !== 'ready') return false;
      if (n.s !== 1 || stage < 3) return true;
      return S.nodes.get(`f/${n.tx}_${n.ty}`)?.state === 'ready';
    };
    const showN = (n: LNode) => { shownN.set(n.key, n); touched.push(n); pages.show(n.key, n.s, n.tx, n.ty, S.nodes.get(n.key)?.fields); };
    const hideN = (p: LNode) => { if (shownN.delete(p.key)) { touched.push(p); pages.hide(p.key); } };
    for (const [k, p] of shownN) {
      // gone (freed elsewhere), or none of it in range of the view distance any more
      if (S.nodes.get(k)?.state !== 'ready' || ((cut || ct) && !nodeIn(p))) hideN(p);
    }
    for (const n of chosen.values()) {
      if (shownN.has(n.key) || !ready(n)) continue;
      // (shown nodes never overlap: one holds n, or any number lie within it)
      const big = holding(shownN, n);
      if (!big) {
        for (const p of inside(shownN, n)) hideN(p);
        showN(n);
        continue;
      }
      const sub = inside(chosen, big);
      if (sub.every((q) => shownN.has(q.key) || ready(q))) {
        hideN(big);
        for (const q of sub) showN(q);
      }
    }
    for (const p of touched) for (const i of tilesOfNode(p)) dirty.add(i);
    touched.length = 0;
    const masks = new Map<string, TileNode>();
    for (const n of S.nodes.values()) {
      if (!n.foliage) {
        const sig = n.remesh ? 'remesh' : n.data;
        if (occSig.get(n.key) !== sig) { occNode(n); if (sig) occSig.set(n.key, sig); else occSig.delete(n.key); }
      }
      if (n.state !== 'ready') continue;
      const on = shownN.has(n.foliage ? S.key(1, n.tx, n.ty) : n.key);
      if (on && !counted.has(n.key)) {
        counted.add(n.key);
        if (n.foliage) { if (n.mesh) n.mesh.material = folMat; S.coverBase(n); dirty.add(index(n.tx, n.ty)); } else if (n.mesh) {
          n.mesh.customDepthMaterial = depthMat;
          if (n.s > 1) n.mesh.material = farMat; // a distance level's
        }
      }
      if (n.mesh) {
        n.mesh.visible = on && drawn(n.mesh);
        if (n.mesh.visible && !n.foliage) masks.set(n.key, n);
      }
    }
    for (const [k, n] of masking) if (!masks.has(k)) farNode(n, -1);
    for (const [k, n] of masks) if (!masking.has(k)) farNode(n, 1);
    masking = masks;
    let changed = false;
    for (const i of dirty) {
      const tx = i % d.nx, ty = Math.floor(i / d.nx), c = at(shownN, tx, ty)?.s ?? 0, was = inTile[i];
      setTile(i, c ? 1 : 0, c > 1 || (c === 1 && counted.has(`f/${tx}_${ty}`)) ? 1 : 0);
      if (inTile[i] === was) continue;
      occDirty.add(i);
      if (!inTile[i]) continue;
      if (stage >= 2) dropPiece(i);
      for (const b of bldsOn(i)) if (!complete[b] && tilesOf[b].every((k) => inTile[k])) {
        complete[b] = 1;
        if (isLandmark.has(b) || stage >= 2) { show(b); changed = true; }
      }
    }
    dirty.clear();
    // what is neither shown nor chosen goes after a while (the foliage with its base: the base's mesh lacks what the
    // grass covers, stream.ts coverBase)
    for (const n of [...S.nodes.values()]) {
      if (n.foliage || n.state !== 'ready') continue;
      if (shownN.has(n.key) || chosen.has(n.key)) { n.used = now; continue; }
      // (out of range: none of its tiles in range of the view distance)
      const gone = (!!cut || !!ct) && !nodeIn(lnode(n.s, n.tx, n.ty));
      const fol = n.s === 1 ? S.nodes.get(`f/${n.tx}_${n.ty}`) : undefined;
      if (now - n.used > (gone ? FREE_MS : 15000) && !(n.pinned > now) && !((fol?.pinned ?? 0) > now)) {
        if (fol) { if (counted.delete(fol.key)) dirty.add(index(fol.tx, fol.ty)); S.free(fol); }
        counted.delete(n.key);
        if (occSig.delete(n.key)) occNode(n);
        S.free(n);
      }
    }
    occluders();
    let pending = 0;
    for (const k of chosen.keys()) if (!shownN.has(k)) pending++;
    settled = tilesNow === wanted && pending === 0;
    // (the landmarks wanted: those beyond the view distance never come)
    if (stage === 1 && (lmShown === landmarks.length || landmarks.every((b) => shown[b + 1] || tilesOf[b].some((k) => !inRange[k])))) toStage2();
    if (stage === 2 && tilesNow === wanted) stage = U.uStage.value = 3;
    if (stage >= 3) for (const n of chosen.values()) {
      if (n.s === 1 && S.nodes.get(n.key)?.state === 'ready') S.requestFoliage(n.tx, n.ty, prio(index(n.tx, n.ty), f));
    }
    if (stage === 3 && folNow === wanted) stage = 4;
    far.on = !!cut && !ct;
    far.flush(camAt);
    pages.flush();
    if (changed) shownTex.needsUpdate = true;
    // queued jobs no longer chosen (with the distance levels)
    if (lodOn) S.dropQueued((n) => n.pinned > now || chosen.has(n.foliage ? S.key(1, n.tx, n.ty) : n.key));
    progress(f);
    S.pump();
  };

  // Occlusion culling (occlusion.ts): a tile's columns block the view once it is in and all its buildings show --
  // drawn by whichever level (the least of the levels' heights where two are in)
  const occ = new Occlusion(d.nx, Uint8Array.from(meta.palette, (p) => (p[3] === MAT.LEAF || p[3] === MAT.WATER || p[3] === MAT.JET ? 0 : 1)), meta.H + 3);
  let occOn = occlusion, occAt = 0, occN = -1;
  const occSrc = new Map<number, ColumnData[]>(), occStats = { ms: 0, meshes: 0, hidden: 0 };
  // A hidden mesh moves to layer HIDDEN alone: the camera (layer 0) passes it over before anything else; the
  // shadow passes still draw it (daylight.ts gives the view's camera all layers during them, as three tests those). Updated on the scene's onBeforeRender (before the
  // depth pre-pass's, prepass.ts), for the main camera only, again whenever it moved.
  const HIDDEN = 5, cam0 = camera as THREE.PerspectiveCamera, before = scene.onBeforeRender.bind(scene);
  const cull = (cam: THREE.Camera) => {
    if (cam !== camera) return;
    const now = performance.now(), on = occOn;
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
      const h = !!box && occ.hidden(box);
      m.layers.mask = h ? 1 << HIDDEN : 1;
      hidden += +h;
    }
    occStats.ms = performance.now() - t0; occStats.meshes = kids.length; occStats.hidden = hidden;
  };
  scene.onBeforeRender = (...a) => { cull(a[2]); before(...a); };
  // (the tiles marked since the last time only, occDirty)
  function occluders() {
    for (const i of occDirty) {
      const tx = i % d.nx, ty = Math.floor(i / d.nx), src: ColumnData[] = [];
      if (stage >= 2 && inTile[i] && bldsOn(i).every((b) => shown[b + 1])) for (const s of lods) {
        const nd = S.nodes.get(S.key(s, Math.floor(tx / s), Math.floor(ty / s)));
        // (a node meshed again after a lost context is not drawn until then: it hides nothing meanwhile)
        if (nd?.remesh) { src.length = 0; break; }
        if (nd?.data) src.push(nd.data);
      }
      const was = occSrc.get(i) ?? [];
      if (was.length === src.length && was.every((c, k) => c === src[k])) continue;
      if (src.length) occSrc.set(i, src); else occSrc.delete(i);
      occ.setTile(tx, ty, src);
    }
    occDirty.clear();
  }

  const labelled = new Map(meta.labels.map((l, i) => [`${l.x + 0.5},${l.y + 0.5}`, labelBld[i]]));
  return {
    // a building's label once it shows; the others (parks, the river) with the foliage
    gate: (x: number, z: number) => { const b = labelled.get(`${x},${z}`) ?? -1; return b >= 0 ? shown[b + 1] > 0 : stage >= 4; },
    get complete() { return stage >= 4; },
    // the triangles the last pick chose (tiles.tris)
    get pickTris() { return pickTris; },
    // main.ts budget, at detail 0 and 1: twice the triangles of the whole map at the coarsest level, and those at 1 m
    // with its foliage (tiles.tris)
    trisRange: [2 * sumOf(String(lods.at(-1)) as '8'), sumOf('1c') + sumOf('1f')] as [number, number],
    // the distance levels now (tools): nodes shown per level, chosen ones not shown yet, wanted tiles shown by nothing
    get lod() {
      const shownBy: Record<number, number> = {};
      for (const p of shownN.values()) shownBy[p.s] = (shownBy[p.s] ?? 0) + 1;
      let pending = 0, gaps = 0;
      for (const k of chosen.keys()) if (!shownN.has(k)) pending++;
      for (const i of rangeList) if (!inTile[i]) gaps++;
      return { on: lodOn, shownBy, pending, gaps };
    },
    // every tile the budget asks for is in
    get settled() { return settled; },
    setLod,
    // the view distance (0: the whole map): the next update loads, shows and frees by it
    setDist(m: number) { cut = m; },
    setOcclusion(on: boolean) { occOn = on; },
    // occlusion culling now (tools): on, the last update's cost (ms), tile meshes, of them hidden
    get occlusion() { return { on: occOn, ...occStats }; },
    // the tiny scene's box in metres (?crop=), null: the whole map
    crop: ct && [ct[0] * T, ct[1] * T, (ct[2] + 1) * T, (ct[3] + 1) * T],
    occluder: occ,
    // what the structures that follow the camera hold now (tools)
    get held() { return { occlusion: occ.stats, farground: far.stats, pages: pages.stats, terrain: terrain.bytes }; },
  };
}
