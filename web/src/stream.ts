import * as THREE from 'three';
import type { ColumnData, Meta, TileLevel } from './types';
import type { MeshOut, MeshRequest, MeshReply } from './mesher.worker';
import type { Columns } from './tile-data';
import { World, type ColumnSource } from './world';
import { paletteFlags, tileRequest, type TileContext } from './tile-request';

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
  // meshed again after a lost WebGL context (remeshLost): hidden until the new geometry is in (city.ts shows it again)
  remesh?: boolean;
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

// Facing culling. A tile's quads come grouped by the way they face (mesher.worker.ts byFacing: the six axes, and
// what faces off them in seventeen groups by its normal; geometry.userData.faces where each starts, .normals the bounds of
// each one's normals); each draw of it, in view or in the sun's shadow map, takes only the groups that can face that
// camera: what faces away is culled by the GPU anyway, but only after its vertices are shaded -- on an Iris Xe through
// D3D11 most of the scene pass's time, and nearly all of the shadow map's.
// In view: a group can face the camera if, for some normal n in its bounds and point p in the tile's box,
// (eye - p) . n > 0 (per axis the largest of the products at the bounds' ends: exact for an axis's group).
// In the shadow map (an orthographic sun, the back faces drawn): if some n in its bounds faces away from the light.
// The x and z axes' groups come in the order of their faces' planes (cuts): where the camera is between the tile's
// sides on that axis, of such a group only the faces on its side of the camera are drawn.
// What is drawn comes out as a few runs of the buffer: the first is the geometry's draw range, as three draws it; the
// others are drawn straight after it, from onAfterRender / onAfterShadow, with the program and buffers three just
// bound (drawRest: one multi-draw where there is WEBGL_multi_draw).
const _c = new THREE.Vector3(), _l = new THREE.Vector3();
type MultiDraw = { multiDrawElementsWEBGL(m: number, c: Int32Array, co: number, t: number, o: Int32Array, oo: number, n: number): void };
let _rest: number[] = [], _restOf: THREE.Mesh | null = null, _md: MultiDraw | null | undefined;
const _starts = new Int32Array(32), _counts = new Int32Array(32);
// (eye - p) . n at its largest over p in [min, max], n in [lo, hi], along one axis
const most = (e: number, min: number, max: number, lo: number, hi: number) => Math.max((e - min) * lo, (e - min) * hi, (e - max) * lo, (e - max) * hi);
// cuts' groups by the order of the groups in the buffer: 0 -x, 1 +x, 2 -z, 3 +z, else -1
function cutGroups(cuts: Uint32Array, groups: number) {
  const c = new Int8Array(groups).fill(-1);
  for (let g = 0; g < 4; g++) c[cuts[4 + g]] = g;
  return c;
}
function runs(mesh: THREE.Mesh, geo: THREE.BufferGeometry, show: (n: Float32Array, k: number) => boolean, eye: THREE.Vector3 | null = null) {
  const f = geo.userData.faces as Uint32Array | undefined, nb = geo.userData.normals as Float32Array | undefined;
  _restOf = null;
  if (!f || !nb) return;
  const cuts = geo.userData.cuts as Uint32Array, cg: Int8Array = geo.userData.cutGroups ??= cutGroups(cuts, f.length - 1);
  const out: number[] = [];
  let open = -1, end = 0;
  for (let k = 0; k < f.length - 1; k++) {
    if (f[k + 1] === f[k]) continue; // (an empty group joins the runs either side of it)
    let a = f[k], b = f[k + 1];
    if (eye && cg[k] >= 0 && cuts.length > 8) {
      // only the planes on the camera's side: +x below its x, -x above it (a hundredth of a metre's slack, as above)
      const g = cg[k], N = cuts[3], o = 8 + g * (N + 2), i = ((g < 2 ? eye.x : eye.z) - cuts[g < 2 ? 0 : 1]) / cuts[2];
      if (g & 1) b = a + cuts[o + Math.max(0, Math.min(N + 1, Math.ceil(i + 0.01)))];
      else a += cuts[o + Math.max(0, Math.min(N + 1, Math.floor(i - 0.01) + 1))];
    }
    if (a < b && show(nb, k * 6)) {
      if (open >= 0 && a !== end) { out.push(open, end); open = -1; }
      if (open < 0) open = a;
      end = b;
    } else if (open >= 0) { out.push(open, end); open = -1; }
  }
  if (open >= 0) out.push(open, end);
  if (!out.length) { geo.setDrawRange(0, 0); return; }
  geo.setDrawRange(out[0] * 6, (out[1] - out[0]) * 6);
  if (out.length > 2) { _rest = out; _restOf = mesh; }
}
function drawRest(this: THREE.Mesh, r: THREE.WebGLRenderer, geo: THREE.BufferGeometry) {
  if (_restOf !== this) return;
  _restOf = null;
  const gl = r.getContext() as WebGL2RenderingContext, idx = geo.index;
  if (!idx) return;
  const type = idx.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, bytes = type === gl.UNSIGNED_INT ? 4 : 2;
  const md = _md === undefined ? (_md = r.extensions.has('WEBGL_multi_draw') ? r.extensions.get('WEBGL_multi_draw') as MultiDraw : null) : _md;
  let n = 0;
  for (let i = 2; i < _rest.length && n < 32; i += 2, n++) {
    _starts[n] = _rest[i] * 6 * bytes; _counts[n] = (_rest[i + 1] - _rest[i]) * 6;
    r.info.update(_counts[n], gl.TRIANGLES, 1);
  }
  if (md) md.multiDrawElementsWEBGL(gl.TRIANGLES, _counts, 0, type, _starts, 0, n);
  else for (let i = 0; i < n; i++) gl.drawElements(gl.TRIANGLES, _counts[i], type, _starts[i]);
}
// the index buffer is shared by every tile: disposing a geometry with it would drop it from the GPU for all of them
const disposeGeometry = (geo: THREE.BufferGeometry) => { geo.setIndex(null); geo.dispose(); };
const drawAll = (geo: THREE.BufferGeometry) => { _restOf = null; const f = geo.userData.faces as Uint32Array | undefined; if (f) geo.setDrawRange(0, f[f.length - 1] * 6); };
function facingInView(this: THREE.Mesh, _r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera, geo: THREE.BufferGeometry, material: THREE.Material) {
  const bb = geo.boundingBox;
  if (!bb || material.side !== THREE.FrontSide || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) { drawAll(geo); return; }
  _c.setFromMatrixPosition(camera.matrixWorld);
  // (the box's top a metre up: the shader lifts a sloped roof's vertices by up to that, makeVoxelMaterial)
  runs(this, geo, (n, k) => most(_c.x, bb.min.x, bb.max.x, n[k], n[k + 3]) + most(_c.y, bb.min.y, bb.max.y + 1, n[k + 1], n[k + 4])
    + most(_c.z, bb.min.z, bb.max.z, n[k + 2], n[k + 5]) > -0.01, _c);
}
function facingInShadow(this: THREE.Mesh, _r: THREE.WebGLRenderer, _o: THREE.Object3D, _c0: THREE.Camera, shadowCamera: THREE.Camera, geo: THREE.BufferGeometry, depth: THREE.Material) {
  if (depth.side === THREE.DoubleSide || !(shadowCamera as THREE.OrthographicCamera).isOrthographicCamera) { drawAll(geo); return; }
  _l.setFromMatrixColumn(shadowCamera.matrixWorld, 2).normalize(); // towards the light
  const back = depth.side === THREE.BackSide ? -1 : 1, lx = back * _l.x, ly = back * _l.y, lz = back * _l.z;
  runs(this, geo, (n, k) => Math.max(lx * n[k], lx * n[k + 3]) + Math.max(ly * n[k + 1], ly * n[k + 4]) + Math.max(lz * n[k + 2], lz * n[k + 5]) > -1e-4);
}
function drawRestInView(this: THREE.Mesh, r: THREE.WebGLRenderer, _s: THREE.Scene, _c1: THREE.Camera, geo: THREE.BufferGeometry) { drawRest.call(this, r, geo); }
function drawRestInShadow(this: THREE.Mesh, r: THREE.WebGLRenderer, _o: THREE.Object3D, _c1: THREE.Camera, _sc: THREE.Camera, geo: THREE.BufferGeometry) { drawRest.call(this, r, geo); }

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
  readonly dims: Record<number, TileLevel>;
  readonly nodes = new Map<string, TileNode>();
  readonly group = new THREE.Group();
  readonly world: World;
  version = 0;
  // the building of each 1 m column (zones.bin): city.ts sets it once loaded
  get bldMap() { return this.ctx.bldMap; }
  set bldMap(m: TileContext['bldMap']) { this.ctx.bldMap = m; }
  update: (camera: THREE.Camera) => void = () => {};
  private queue: Job[] = [];
  private inflight = 0;
  private readonly maxWorkers = Math.min(Math.max(2, (navigator.hardwareConcurrency || 4) - 2), 10);
  private readonly pool: Pooled[] = [];
  private quadIdx: THREE.BufferAttribute | null = null;
  // what the tiles are meshed with (tile-request.ts)
  private readonly ctx: TileContext;

  constructor(private readonly meta: Meta, private readonly material: THREE.Material, scene: THREE.Scene) {
    this.N = meta.tiles.N;
    this.levels = meta.tiles.levels.map((l) => l.s).sort((a, b) => b - a);
    this.dims = Object.fromEntries(meta.tiles.levels.map((l) => [l.s, l]));
    this.ctx = { N: this.N, W: meta.W, D: meta.D, ...paletteFlags(meta.palette), bldMap: null };
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
      const f = g.userData.faces as Uint32Array, q = f[f.length - 1];
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
    const file = (k: string) => new URL(`data/tiles/${k}.bin`, location.href).href;
    const msg = tileRequest(this.ctx, n.s, n.tx, n.ty, n.foliage, file, n.keep, dataOnly);
    const transfer: Transferable[] = [...[msg.bld, msg.base?.bld].flatMap((b) => (b ? [b.buffer] : []))];
    if (n.foliage) {
      // the base tile's column data is still here: hand over a copy instead of fetching it again
      const b = this.nodes.get(this.key(1, n.tx, n.ty))?.data;
      if (b) {
        const under: Columns = { counts: b.counts.slice(), runs: b.runs.slice(), ground: b.ground.slice(), planes: b.planes?.slice() ?? null };
        msg.under = under;
        transfer.push(under.counts.buffer, under.runs.buffer, under.ground.buffer, ...(under.planes ? [under.planes.buffer] : []));
      }
    }
    return { msg, transfer };
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
        n.mesh.visible = false; // (city.ts shows it again)
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

  private makeGeometry({ pos, attr, pal, bld, quads, faces, normals, cuts }: MeshOut) {
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
    geo.userData.normals = normals;
    geo.userData.cuts = cuts;
    return geo;
  }

  private makeMesh(out: MeshOut) {
    const mesh = new THREE.Mesh(this.makeGeometry(out), this.material);
    mesh.onBeforeRender = facingInView;
    mesh.onBeforeShadow = facingInShadow;
    mesh.onAfterRender = drawRestInView;
    mesh.onAfterShadow = drawRestInShadow;
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
      t.remesh = true;
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
