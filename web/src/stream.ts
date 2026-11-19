import * as THREE from 'three';
import type { ColumnData, Meta, TileLevel } from './types';
import type { MeshOut, MeshRequest, MeshReply } from './mesher.worker';
import type { Columns } from './tile-data';
import { World, type ColumnSource } from './world';
import { MAT } from './voxelMaterial';
import { PAL_ROOF, PAL_WALL } from './chamfer';

// the materials of buildings' walls (voxelize.py)
const WALLS = new Set<number>([MAT.SOLID, MAT.WALL, MAT.GLASS, MAT.FLOODLIT, MAT.CONCRETE, MAT.BRONZE, MAT.RIBBON, MAT.CLASSIC, MAT.WINDOW, MAT.TENEMENT]);

export interface TileNode {
  key: string;
  s: number;
  tx: number;
  ty: number;
  foliage: boolean;
  state: 'queued' | 'loading' | 'ready';
  keep: boolean;
  used: number;
  pinned: number;
  mesh?: THREE.Mesh;
  // a foliage tile: its base tile's mesh without what the grass covers, put in when this one shows (coverBase)
  cover?: THREE.BufferGeometry;
  // a foliage tile whose cover is in its base tile's mesh
  covers?: boolean;
  // meshed again after a lost WebGL context (remeshLost): shown as it was once the new geometry is in
  remesh?: { visible: boolean };
  data?: ColumnData;
  empty?: boolean;
  dataJob?: Job;
  ready: Promise<void>;
  job: Job;
}

interface Job {
  node: TileNode;
  dataOnly: boolean;
  state: 'queued' | 'loading';
  prio: number;
  done: Promise<void>;
  resolve: () => void;
}

interface Pooled { worker: Worker; busy: number; idle: number }

const releaseArray = function (this: THREE.BufferAttribute) { (this as { array: unknown }).array = null; };

// Facing culling. A tile's quads come grouped by the way they face (mesher.worker.ts byFacing, FACE_ORDER: -y, -z,
// +x, +y, -x, +z in three.js axes; geometry.userData.faces their starts); each draw of it, in view or in the sun's
// shadow map, takes only the one run of groups that holds all that can face that camera: what faces away is culled
// by the GPU anyway, but only after its vertices are shaded.
// In view: a group can face the camera if the camera is on its outer side of some face plane in the tile's box.
// In the shadow map (an orthographic sun, the back faces drawn): only the groups facing away from the light.
const FACE_AXIS = [1, 2, 0, 1, 0, 2], FACE_SIGN = [-1, -1, 1, 1, -1, 1];
const _c = new THREE.Vector3(), _l = new THREE.Vector3();
function drawFacing(geo: THREE.BufferGeometry, show: (axis: number, sign: number) => boolean) {
  const f = geo.userData.faces as Uint32Array | undefined;
  if (!f) return;
  let a = -1, b = -1;
  for (let k = 0; k < 6; k++) if (f[k + 1] > f[k] && show(FACE_AXIS[k], FACE_SIGN[k])) { if (a < 0) a = k; b = k; }
  if (a < 0) geo.setDrawRange(0, 0);
  else geo.setDrawRange(f[a] * 6, (f[b + 1] - f[a]) * 6);
}
// the index buffer is shared by every tile: disposing a geometry with it would drop it from the GPU for all of them
const disposeGeometry = (geo: THREE.BufferGeometry) => { geo.setIndex(null); geo.dispose(); };
const drawAll = (geo: THREE.BufferGeometry) => { const f = geo.userData.faces as Uint32Array | undefined; if (f) geo.setDrawRange(0, f[6] * 6); };
function facingInView(this: THREE.Mesh, _r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera, geo: THREE.BufferGeometry, material: THREE.Material) {
  const bb = geo.boundingBox;
  if (!bb || material.side !== THREE.FrontSide || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) { drawAll(geo); return; }
  _c.setFromMatrixPosition(camera.matrixWorld);
  // outside of the box on a face's outer side, by how much (negative: on its inner side)
  const out = (axis: number, sign: number) => (sign > 0 ? _c.getComponent(axis) - bb.min.getComponent(axis) : bb.max.getComponent(axis) - _c.getComponent(axis)) + 0.01;
  // a slanted wall (chamfer) is filed under its nearer side axis but faces up to 45° off it: its group shows wherever
  // a face turned 45° either way could face the camera
  const slant = (geo.userData.faces as Uint32Array)[7] === 1;
  drawFacing(geo, (axis, sign) => out(axis, sign) > 0 || (slant && axis !== 1 && out(axis, sign) + Math.max(out(2 - axis, 1), out(2 - axis, -1)) > 0));
}
function facingInShadow(this: THREE.Mesh, _r: THREE.WebGLRenderer, _o: THREE.Object3D, _c0: THREE.Camera, shadowCamera: THREE.Camera, geo: THREE.BufferGeometry, depth: THREE.Material) {
  if (depth.side === THREE.DoubleSide || !(shadowCamera as THREE.OrthographicCamera).isOrthographicCamera) { drawAll(geo); return; }
  _l.setFromMatrixColumn(shadowCamera.matrixWorld, 2).normalize(); // towards the light
  const back = depth.side === THREE.BackSide ? -1 : 1;
  // roof slopes and slanted walls (faces[7]) face off the axes they are filed under: all of such a tile is drawn
  if ((geo.userData.faces as Uint32Array)[7] === 1) { drawAll(geo); return; }
  drawFacing(geo, (axis, sign) => back * sign * _l.getComponent(axis) > -1e-4);
}

function makeJob(node: TileNode, dataOnly: boolean, prio: number): Job {
  let resolve = () => {};
  const done = new Promise<void>((r) => { resolve = r; });
  return { node, dataOnly, state: 'queued', prio, done, resolve };
}

// Loads voxel tiles (scripts/tiles.py: N x N cells of s metres) and meshes them in a pool of workers. What to load and
// show is up to city.ts, which sets update().
export class TileStreamer implements ColumnSource {
  readonly N: number;
  readonly levels: number[];
  // the coarsest level: the clay (city.ts), the others the city at 1 m and its distance levels
  readonly clay: number;
  readonly dims: Record<number, TileLevel>;
  readonly nodes = new Map<string, TileNode>();
  readonly group = new THREE.Group();
  readonly world: World;
  version = 0;
  bldMap: { data: Uint16Array; W: number } | null = null;
  update: (camera: THREE.Camera) => void = () => {};
  private queue: Job[] = [];
  private inflight = 0;
  private readonly maxWorkers = Math.min(Math.max(2, (navigator.hardwareConcurrency || 4) - 2), 10);
  private readonly pool: Pooled[] = [];
  private quadIdx: THREE.BufferAttribute | null = null;
  // per palette entry: roof material, its staircases shaded as roof planes; a building's wall, its diagonal staircases
  // chamfered flat (mesher.worker.ts, chamfer.ts)
  private readonly roofPal: Uint8Array;
  private readonly leafPal: Uint8Array;

  constructor(private readonly meta: Meta, private readonly material: THREE.Material, scene: THREE.Scene) {
    this.N = meta.tiles.N;
    this.levels = meta.tiles.levels.map((l) => l.s).sort((a, b) => b - a);
    this.clay = this.levels[0];
    this.dims = Object.fromEntries(meta.tiles.levels.map((l) => [l.s, l]));
    this.roofPal = Uint8Array.from(meta.palette, (p) => (p[3] === MAT.ROOF ? PAL_ROOF : WALLS.has(p[3]) ? PAL_WALL : 0));
    this.leafPal = Uint8Array.from(meta.palette, (p) => (p[3] === MAT.LEAF ? 1 : 0));
    scene.add(this.group);
    this.spawn();
    this.world = new World(this, meta);
  }

  columns(key: string) { return this.nodes.get(key)?.data; }

  // what the tile meshes hold on the GPU (tools/perfbench.mjs): quads and vertex bytes, of all and of the shown ones
  // nothing being meshed or waiting to be
  get idle() { return this.inflight === 0 && this.queue.length === 0; }

  stats() {
    const r = { meshes: 0, quads: 0, bytes: 0, shownMeshes: 0, shownQuads: 0 };
    for (const n of this.nodes.values()) {
      const g = n.mesh?.geometry;
      if (!g) continue;
      const q = g.userData.faces[6] as number;
      let b = 0;
      for (const [k, a] of Object.entries(g.attributes) as [string, THREE.BufferAttribute][]) b += a.count * a.itemSize * (k === 'vattr' ? 1 : 2);
      r.meshes++; r.quads += q; r.bytes += b;
      if (n.mesh!.visible) { r.shownMeshes++; r.shownQuads += q; }
    }
    return r;
  }

  key(s: number, tx: number, ty: number) { return `${s}/${tx}_${ty}`; }

  bounds(s: number, tx: number, ty: number) {
    const L = this.N * s;
    return [tx * L, ty * L, Math.min((tx + 1) * L, this.meta.W), Math.min((ty + 1) * L, this.meta.D)];
  }

  // keep: its column data stays here too, for collisions and ray casts
  request(s: number, tx: number, ty: number, prio: number, keep = false): Promise<void> {
    const key = this.key(s, tx, ty);
    let n = this.nodes.get(key);
    if (n && keep && n.state === 'ready' && !n.data && !n.empty) {
      n.keep = true;
      if (!n.dataJob) { n.dataJob = makeJob(n, true, prio); this.queue.push(n.dataJob); }
      n.dataJob.prio = prio;
      return n.dataJob.done;
    }
    n ??= this.addNode(key, s, tx, ty, false, keep);
    n.job.prio = prio;
    if (prio >= 1e8) n.pinned = performance.now() + 15000;
    return n.ready;
  }

  // trees and grass of a 1 m tile (tiles/1f), meshed over its base tile
  requestFoliage(tx: number, ty: number, prio: number): Promise<void> {
    const key = `f/${tx}_${ty}`;
    const n = this.nodes.get(key) ?? this.addNode(key, 1, tx, ty, true, false);
    n.job.prio = prio;
    return n.ready;
  }

  private addNode(key: string, s: number, tx: number, ty: number, foliage: boolean, keep: boolean) {
    const n = { key, s, tx, ty, foliage, keep, state: 'queued', used: performance.now(), pinned: 0 } as TileNode;
    n.job = makeJob(n, false, 0);
    n.ready = n.job.done;
    this.nodes.set(key, n);
    this.queue.push(n.job);
    return n;
  }

  reprioritize(prio: (n: TileNode) => number) {
    for (const j of this.queue) if (!j.dataOnly) j.prio = prio(j.node);
  }

  dropQueued(keep: (n: TileNode) => boolean) {
    this.queue = this.queue.filter((j) => {
      if (j.state !== 'queued' || keep(j.node) || j.node.remesh) return true;
      if (j.dataOnly) { j.node.dataJob = undefined; j.resolve(); } else this.nodes.delete(j.node.key);
      return false;
    });
  }

  private spawn() {
    const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
    const p: Pooled = { worker, busy: 0, idle: performance.now() };
    worker.onmessage = (e: MessageEvent<MeshReply>) => this.onReply(e.data, p);
    this.pool.push(p);
  }

  // workers past the first one leave after 4 s idle (each holds ~35 MB)
  retire() {
    const now = performance.now();
    for (const p of [...this.pool]) {
      if (this.pool.length > 1 && p.busy === 0 && now - p.idle > 4000) {
        p.worker.terminate();
        this.pool.splice(this.pool.indexOf(p), 1);
      }
    }
  }

  pump() {
    this.queue.sort((a, b) => b.prio - a.prio);
    while (this.queue.length > this.pool.length * 2 && this.pool.length < this.maxWorkers) this.spawn();
    while (this.queue.length && this.inflight < this.pool.length * 2) {
      const job = this.queue.shift()!;
      if (job.state !== 'queued') continue;
      const p = this.pool.reduce((a, b) => (a.busy <= b.busy ? a : b));
      p.busy++; this.inflight++;
      job.state = 'loading';
      const { msg, transfer } = this.requestFor(job);
      p.worker.postMessage(msg, transfer);
    }
  }

  private requestFor({ node: n, dataOnly }: Job): { msg: MeshRequest; transfer: Transferable[] } {
    const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
    const file = (k: string) => new URL(`data/tiles/${k}.bin`, location.href).href;
    const base = { key: n.key, N: this.N, s: n.s, x0, y0 };
    if (n.foliage) {
      // the base tile's column data is still here: hand over a copy instead of fetching it again
      const b = this.nodes.get(this.key(1, n.tx, n.ty))?.data;
      const under: Columns | string = b ? { counts: b.counts.slice(), runs: b.runs.slice(), ground: b.ground.slice(), planes: b.planes?.slice() ?? null } : file(`1/${n.tx}_${n.ty}`);
      // ... and the base tile meshed again without what the grass covers (coverBase)
      const bld = this.buildingIds(x0, y0);
      return { msg: { ...base, url: file(`1f/${n.tx}_${n.ty}`), under, keep: false, dataOnly: false, bld: null, roof: null,
        base: { bld, roof: this.roofPal, leaf: this.leafPal } },
      transfer: [...(typeof under === 'string' ? [] : [under.counts.buffer, under.runs.buffer, under.ground.buffer, ...(under.planes ? [under.planes.buffer] : [])]), ...(bld ? [bld.buffer] : [])] };
    }
    // level 1 and the distance levels are meshed with their buildings and roof palette, the clay without
    const city = !dataOnly && n.s !== this.clay;
    const bld = city ? this.buildingIds(x0, y0, n.s) : null;
    return { msg: { ...base, url: file(n.key), keep: n.keep || n.s > 1, dataOnly, bld,
      roof: city ? this.roofPal : null }, transfer: bld ? [bld.buffer] : [] };
  }

  private buildingIds(x0: number, y0: number, s = 1) {
    if (!this.bldMap) return null;
    if (s > 1) return this.buildingIdsCoarse(x0, y0, s);
    // with the 1-cell apron (a chamfer's steps run on into it)
    const { data, W } = this.bldMap, S = this.N + 2, out = new Uint16Array(S * S), xa = Math.max(0, x0 - 1), xb = Math.min(x0 + S - 1, W);
    for (let r = 0; r < S; r++) {
      const y = y0 - 1 + r;
      if (y >= 0 && y < this.meta.D) out.set(data.subarray(y * W + xa, y * W + xb), r * S + xa - (x0 - 1));
    }
    return out;
  }

  // a distance level's cells (s x s m): the building of the cell's middle column, else of any column in it
  private buildingIdsCoarse(x0: number, y0: number, s: number) {
    const { data, W } = this.bldMap!, D = this.meta.D, S = this.N + 2, out = new Uint16Array(S * S), h = s >> 1;
    const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < D ? data[y * W + x] : 0);
    for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
      const X = x0 + (c - 1) * s, Y = y0 + (r - 1) * s;
      let b = at(X + h, Y + h);
      for (let k = 0; !b && k < s * s; k++) b = at(X + (k % s), Y + Math.floor(k / s));
      out[r * S + c] = b;
    }
    return out;
  }

  private onReply(m: MeshReply, p: Pooled) {
    p.busy--; this.inflight--; p.idle = performance.now();
    const n = this.nodes.get(m.key);
    if (n && m.dataOnly) {
      const job = n.dataJob;
      n.dataJob = undefined;
      if (m.type === 'error') console.warn(m.error);
      else if (m.data && !n.data) this.setData(n, m.data);
      job?.resolve();
    } else if (n && m.type === 'error') {
      console.warn(m.error);
      if (n.remesh && n.mesh) { this.group.remove(n.mesh); n.mesh = undefined; }
      n.remesh = undefined;
      n.state = 'ready'; n.empty = true;
      n.job.resolve();
    } else if (n && m.type === 'node') {
      const re = n.remesh;
      n.remesh = undefined;
      if (re && n.mesh && m.quads) {
        // (the old geometry is not disposed: what it had on the GPU went with the lost context, and three would only
        // complain that its buffers belong to no context)
        n.mesh.geometry = this.makeGeometry(m);
        n.mesh.visible = n.s === this.clay && re.visible; // (city.ts shows the others again)
      } else if (m.quads) n.mesh = this.makeMesh(m);
      if (n.cover) disposeGeometry(n.cover);
      n.cover = m.base?.quads ? this.makeGeometry(m.base) : undefined;
      if (m.data) this.setData(n, m.data);
      n.state = 'ready';
      if (re) this.recover(n);
      n.job.resolve();
    }
    this.pump();
  }

  private makeGeometry({ pos, attr, pal, bld, quads, faces }: MeshOut) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('vattr', new THREE.BufferAttribute(attr, 4));
    geo.setAttribute('vpal', new THREE.BufferAttribute(pal, 1));
    if (bld) geo.setAttribute('vbld', new THREE.BufferAttribute(bld, 1));
    geo.setIndex(this.quadIndex(quads));
    geo.setDrawRange(0, quads * 6);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    for (const a of Object.values(geo.attributes)) (a as THREE.BufferAttribute).onUpload(releaseArray); // culling only needs the bounding sphere
    geo.userData.faces = faces;
    return geo;
  }

  private makeMesh(out: MeshOut) {
    const mesh = new THREE.Mesh(this.makeGeometry(out), this.material);
    mesh.onBeforeRender = facingInView;
    mesh.onBeforeShadow = facingInShadow;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  // one index buffer for every tile: 0 1 2, 0 2 3 quad after quad (the mesher orders each quad's corners to fit it)
  private quadIndex(quads: number) {
    if (this.quadIdx && this.quadIdx.count >= quads * 6) return this.quadIdx;
    const n = Math.max(quads, 2 * (this.quadIdx ? this.quadIdx.count / 6 : 65536)), a = new Uint32Array(n * 6);
    for (let q = 0, b = 0; q < n; q++, b += 4) a.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    const old = this.quadIdx;
    this.quadIdx = new THREE.BufferAttribute(a, 1);
    if (old) for (const v of this.nodes.values()) for (const g of [v.mesh?.geometry, v.cover]) if (g?.index === old) g.setIndex(this.quadIdx);
    return this.quadIdx;
  }

  private setData(n: TileNode, { counts, ground, runs, planes }: { counts: Uint16Array; ground: Uint8Array; runs: Uint16Array; planes?: Uint16Array | null }) {
    const S = this.N + 2, off = new Uint32Array(S * S + 1);
    for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + counts[i];
    const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
    n.data = { s: n.s, x0, y0, S, counts, ground, runs, off, planes: planes ?? null };
    this.version++;
  }

  // a foliage tile shows: its base tile's mesh loses the faces under its grass (only ever both, or the base alone)
  coverBase(f: TileNode) {
    const geo = f.cover, b = this.nodes.get(this.key(1, f.tx, f.ty));
    f.cover = undefined;
    if (!geo) return;
    if (b?.mesh && !b.mesh.geometry.userData.covered) {
      disposeGeometry(b.mesh.geometry);
      b.mesh.geometry = geo;
      geo.userData.covered = true;
      f.covers = true;
    } else disposeGeometry(geo);
  }

  // A lost WebGL context takes every buffer on the GPU with it, and the tiles' vertex arrays went once they were
  // uploaded (releaseArray): three could not upload them again ("byteLength of null" every frame, nothing drawn). Each
  // such tile is meshed again instead, in place -- its mesh keeps its material and is hidden until the new geometry
  // is in -- nearest first as city.ts prioritizes them; keeping the arrays would hold ~200-300 MB more in memory.
  remeshLost() {
    let n = 0;
    for (const t of this.nodes.values()) {
      const pos = t.mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || pos.array || t.remesh) continue;
      t.remesh = { visible: t.mesh!.visible };
      t.mesh!.visible = false;
      if (t.state === 'ready') {
        t.state = 'queued';
        t.job = makeJob(t, false, t.job.prio);
        this.queue.push(t.job);
      }
      n++;
    }
    this.pump();
    return n;
  }

  // a re-meshed tile: a foliage tile's cover goes back into its base tile once that has its own new geometry
  private recover(n: TileNode) {
    if (n.foliage) {
      const b = this.nodes.get(this.key(1, n.tx, n.ty));
      if (n.covers && b && !b.remesh) { n.covers = false; this.coverBase(n); }
    } else if (n.s === 1) {
      const f = this.nodes.get(`f/${n.tx}_${n.ty}`);
      if (f?.covers && f.cover && !f.remesh) { f.covers = false; this.coverBase(f); }
    }
  }

  free(n: TileNode) {
    if (n.cover) disposeGeometry(n.cover);
    n.dataJob?.resolve();
    n.dataJob = undefined;
    if (n.mesh) { disposeGeometry(n.mesh.geometry); this.group.remove(n.mesh); }
    this.nodes.delete(n.key);
    if (n.data) this.version++;
  }

  // full detail around (x, z) with its column data, e.g. before landing there
  ensure(x: number, z: number, r = 120) {
    const fine = this.levels[this.levels.length - 1], L = this.N * fine, d = this.dims[fine], ps = [];
    for (let ty = Math.max(0, Math.floor((z - r) / L)); ty <= Math.min(d.ny - 1, Math.floor((z + r) / L)); ty++)
      for (let tx = Math.max(0, Math.floor((x - r) / L)); tx <= Math.min(d.nx - 1, Math.floor((x + r) / L)); tx++)
        ps.push(this.request(fine, tx, ty, 1e8, true));
    this.pump();
    return Promise.all(ps);
  }
}
