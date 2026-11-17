// Fetches, unzips and greedy-meshes one tile (scripts/tiles.py), with baked ambient occlusion.
// Data coordinates: x east, y south, z up. Positions go out in three.js axes (x, z, y), metres.
// A tile is N x N cells of s metres plus a 1-cell apron.

export interface RawColumns { counts: Uint16Array; runs: Uint16Array }
export interface Columns extends RawColumns { ground: Uint8Array }

export interface MeshRequest {
  key: string;
  url: string;
  under?: RawColumns | string;
  N: number;
  s: number;
  x0: number;
  y0: number;
  keep: boolean;
  dataOnly: boolean;
  bld: Uint16Array | null;
  // per palette entry, 1 if roof material: its staircases are shaded as the roof plane (1 m tiles only)
  roof: Uint8Array | null;
}

export type MeshReply =
  | { type: 'node'; key: string; dataOnly: boolean; data: Columns | null; pos: Int16Array; attr: Uint8Array; pal: Uint16Array; bld: Uint16Array | null; quads: number }
  | { type: 'error'; key: string; dataOnly: boolean; error: string };

const post = (msg: MeshReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: MeshReply, t: Transferable[]): void }).postMessage(msg, transfer);

async function fetchGzip(url: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function decode(buf: ArrayBuffer, N: number) {
  const n2 = (N + 2) * (N + 2);
  const counts = new Uint16Array(buf, 0, n2), ground = new Uint8Array(buf, n2 * 2, n2);
  let nr = 0;
  for (let i = 0; i < n2; i++) nr += counts[i];
  const end = n2 * 3 + nr * 6, runs = new Uint16Array(buf.slice(n2 * 3, end));
  // (level 1: the roof plane of each column's top face, scripts/tiles.py)
  const planes = buf.byteLength >= end + n2 * 2 ? new Uint16Array(buf.slice(end, end + n2 * 2)) : null;
  return { counts, ground, runs, planes };
}

const copyColumns = (c: Columns): Columns => ({ counts: c.counts.slice(), ground: c.ground.slice(), runs: c.runs });
const columnBuffers = (c: Columns) => [c.counts.buffer, c.ground.buffer, c.runs.buffer];

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const m = e.data;
  try {
    const { counts, ground, runs, planes } = decode(await fetchGzip(m.url), m.N);
    const keep = m.keep || m.dataOnly ? copyColumns({ counts, ground, runs }) : null;
    if (m.dataOnly) {
      post({ type: 'node', key: m.key, dataOnly: true, data: keep, pos: new Int16Array(), attr: new Uint8Array(), pal: new Uint16Array(), bld: null, quads: 0 }, columnBuffers(keep!));
      return;
    }
    const under = typeof m.under === 'string' ? decode(await fetchGzip(m.under), m.N) : m.under ?? null;
    const out = meshTile(m.N, m.s, m.x0, m.y0, { counts, ground, runs }, m.bld, under, m.roof, planes);
    const transfer: Transferable[] = [out.pos.buffer, out.attr.buffer, out.pal.buffer];
    if (out.bld) transfer.push(out.bld.buffer);
    if (keep) transfer.push(...columnBuffers(keep));
    post({ type: 'node', key: m.key, dataOnly: false, data: keep, ...out }, transfer);
  } catch (err) {
    post({ type: 'error', key: m.key, dataOnly: m.dataOnly, error: String(err) });
  }
};

// corner order per quad so that the one shared index pattern (0 1 2, 0 2 3) gives its winding and AO diagonal,
// by [AO diagonal flipped][facing +]
const QUAD_ORDER = [[1, 2, 3, 0], [1, 0, 3, 2], [0, 1, 2, 3], [0, 3, 2, 1]];
const SOLID_BELOW = 65535;
const OCC = 65534; // the base tile under a foliage tile: solid for culling and AO, never meshed

class QuadBuffer {
  private cap = 1 << 14;
  pos = new Int16Array(this.cap * 3);
  attr = new Uint8Array(this.cap * 4);
  pal = new Uint16Array(this.cap);
  bld = new Uint16Array(this.cap);
  count = 0;

  reserve(n: number) {
    if (this.count + n <= this.cap) return;
    this.cap *= 2;
    const grow = <T extends Int16Array | Uint8Array | Uint16Array>(a: T, k: number) => { const b = new (a.constructor as new (n: number) => T)(this.cap * k); b.set(a); return b; };
    this.pos = grow(this.pos, 3); this.attr = grow(this.attr, 4); this.pal = grow(this.pal, 1); this.bld = grow(this.bld, 1);
  }

  vertex(x: number, y: number, z: number, normal: number, ao: number, ground: number, roof: number, palette: number, building: number) {
    const v = this.count++;
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = z;
    this.attr[v * 4] = normal; this.attr[v * 4 + 1] = ao; this.attr[v * 4 + 2] = ground; this.attr[v * 4 + 3] = roof;
    this.pal[v] = palette; this.bld[v] = building;
  }
}

function offsetsOf(counts: Uint16Array, n: number) {
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + counts[i];
  return off;
}

function topOf(c: RawColumns, off: Uint32Array, n: number) {
  let zmax = 0;
  for (let i = 0; i < n; i++) {
    const k = c.counts[i];
    if (k) { const r = (off[i] + k - 1) * 3; zmax = Math.max(zmax, c.runs[r] + c.runs[r + 1]); }
  }
  return zmax;
}

// bldIds (1 m tiles): the building of each column (scripts/zones.py, 0: none); faces never merge across buildings
function meshTile(N: number, s: number, x0: number, y0: number, cols: Columns, bldIds: Uint16Array | null, under: RawColumns | null,
  roofPal: Uint8Array | null, planes: Uint16Array | null) {
  const S = N + 2, SS = S * S, { ground } = cols;
  const off = offsetsOf(cols.counts, SS), uoff = under && offsetsOf(under.counts, SS);
  const zmax = Math.max(topOf(cols, off, SS), under && uoff ? topOf(under, uoff, SS) : 0);
  const sz = zmax + 2, vol = new Uint16Array(SS * sz);
  const fill = (c: RawColumns, o: Uint32Array, value: (v: number) => number) => {
    for (let i = 0; i < SS; i++) for (let k = o[i], e = o[i] + c.counts[i]; k < e; k++) {
      const z0 = c.runs[k * 3], len = c.runs[k * 3 + 1], v = value(c.runs[k * 3 + 2]);
      for (let z = z0; z < z0 + len; z++) vol[i + SS * (z + 1)] = v;
    }
  };
  if (under && uoff) fill(under, uoff, () => OCC);
  for (let i = 0; i < SS; i++) vol[i] = SOLID_BELOW; // z = -1 is solid, so the slab's bottom is never meshed
  fill(cols, off, (v) => v);
  const bidAt = (x: number, y: number) => (bldIds ? bldIds[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))] : 0);
  const out = new QuadBuffer();
  meshFaces(N, s, x0, y0, vol, sz, ground, bidAt, roofPal, planes, out);
  const n = out.count;
  return { pos: out.pos.slice(0, n * 3), attr: out.attr.slice(0, n * 4), pal: out.pal.slice(0, n), quads: n / 4, bld: bldIds ? out.bld.slice(0, n) : null };
}

function meshFaces(N: number, s: number, x0: number, y0: number, vol: Uint16Array, sz: number, ground: Uint8Array,
  bidAt: (x: number, y: number) => number, roofPal: Uint8Array | null, planes: Uint16Array | null, out: QuadBuffer) {
  const S = N + 2, sx = S, sy = S;
  const dims = [N, N, sz - 2];
  // the tallest column in each row and each column of the slab: slices are scanned only up to it
  const ST = [1, sx, sx * sy], colTop = new Uint16Array(S * S);
  for (let c = 0; c < S * S; c++) { let z = sz - 1; while (z > 0 && vol[c + sx * sy * z] === 0) z--; colTop[c] = z; }
  const topX = new Uint16Array(S), topY = new Uint16Array(S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const t = colTop[x + S * y]; if (t > topX[x]) topX[x] = t; if (t > topY[y]) topY[y] = t; }
  const cell = (X: number, Y: number, z: number) => vol[(X + 1) + sx * ((Y + 1) + sy * (z + 1))];
  const roofs = roofPal ? roofPlanes(N, vol, colTop, roofPal, bidAt, planes) : null;
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3, nu = dims[u], nv = dims[v];
    const mask = new Float64Array(nu * nv);
    const sd = ST[d], su = ST[u], sv = ST[v];
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      for (let sl = 0; sl < dims[d]; sl++) {
        let any = false;
        // faces out through the tile's border are always emitted: the neighbour may not be loaded yet
        const border = d < 2 && ((dir < 0 && sl === 0) || (dir > 0 && sl === N - 1));
        const zt = d === 0 ? Math.max(topX[sl + 1], topX[sl + 1 + dir]) : d === 1 ? Math.max(topY[sl + 1], topY[sl + 1 + dir]) : nv;
        const jn = v === 2 ? Math.min(nv, zt) : nv, in_ = u === 2 ? Math.min(nu, zt) : nu;
        if (d === 2) mask.fill(0);
        else for (let j = 0; j < nv; j++) for (let i = j < jn ? in_ : 0; i < nu; i++) mask[i + j * nu] = 0;
        for (let j = 0; j < jn; j++) {
          if (d === 2 && topY[j + 1] <= sl) continue;
          for (let i = 0; i < in_; i++) {
            const idx = (sl + 1) * sd + (i + 1) * su + (j + 1) * sv, a = vol[idx];
            let key = 0;
            if (a !== 0 && a !== SOLID_BELOW && a !== OCC) {
              const ni = idx + dir * sd, nb = vol[ni];
              if (nb === 0 || (border && nb !== SOLID_BELOW && nb !== OCC)) {
                const px = d === 0 ? sl : u === 0 ? i : j, py = d === 1 ? sl : u === 1 ? i : j;
                const gm = ground[(px + 1) + S * (py + 1)];
                const pz = d === 2 ? sl : d === 0 ? j : i;
                const rc = roofs && nb === 0 && roofPal![a] ? roofs.code(px, py, pz, d, dir) : 0;
                const ang = rc ? 24 + rc : d < 2 && nb === 0 ? wallAngle(N, px, py, pz, d, dir, cell) : 0;
                const aob = nb === 0 ? faceAO(vol, ni, su, sv, rc ? -1 : ang ? d : -1, rc ? roofPal : null) : 255;
                // < 2^53: ang < 25 (a wall's direction) or 25 + a roof's plane < 2009, palette < 4096, ids < 16384
                key = (((ang * 4096 + a) * 256 + aob) * 256 + gm) * 16384 + bidAt(px, py) + 1;
                any = true;
              }
            }
            mask[i + j * nu] = key;
          }
        }
        if (any) emitMerged(mask, nu, nv, d, u, v, dir, normalIdx, sl, s, x0, y0, out);
      }
    }
  }
}

// A wall at an angle to the grid is a staircase of x- and y-facing faces; it is lit as the plane it stands for. Its
// direction in plan comes from the occupied cells around it (24 steps of 15°; 0 = the face's own).
function wallAngle(N: number, px: number, py: number, cz: number, d: number, dir: number, cell: (x: number, y: number, z: number) => number) {
  let gx = 0, gy = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const Y = py + dy;
    if (Y < -1 || Y > N) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const X = px + dx;
      if (X < -1 || X > N || (dx === 0 && dy === 0)) continue;
      const o = cell(X, Y, cz);
      if (o !== 0 && o !== OCC) { gx -= dx; gy -= dy; }
    }
  }
  const ax = d === 0 ? dir : 0, ay = d === 1 ? dir : 0;
  // a step of a staircase is short both ways along the wall; beside the corner of a straight wall there is a long run
  for (const sgn of [-1, 1]) {
    let k = 1;
    for (; k <= 4; k++) {
      const X = px + (d === 1 ? sgn * k : 0), Y = py + (d === 0 ? sgn * k : 0);
      if (X < -1 || X > N || Y < -1 || Y > N) break;
      const o = cell(X, Y, cz);
      if (o === 0 || o === OCC || cell(X + ax, Y + ay, cz) !== 0) break;
    }
    if (k > 4) return 0;
  }
  const gl = Math.hypot(gx, gy);
  return gl >= 3 && (gx * ax + gy * ay) / gl > 0.05 ? 1 + (Math.round(Math.atan2(gy, gx) / (Math.PI / 12)) + 24) % 24 : 0;
}

// A pitched roof at 1 m is a staircase of tops and risers, each lit by its own axis: grey and red roofs read as dark
// stripes. Its faces are lit as the plane instead, estimated from the roof's height field: central differences between
// columns of the same roof (roof material on top, the same building, within a riser's 4 m), smoothed over 3 x 3. A
// face's plane code: 1 + slope (2.5° steps, 10° to 75°) x 64 + downhill direction (64 steps); 0 where flat or no roof.
// Where the tile ships the plane itself (planes: LoD2's, or a fitted roof's, per column; scripts/voxelize.py) it is
// taken as it is: estimated from steps of whole metres a plane came out a mottle of light and dark voxels.
function roofPlanes(N: number, vol: Uint16Array, colTop: Uint16Array, roofPal: Uint8Array, bidAt: (x: number, y: number) => number,
  planes: Uint16Array | null) {
  const S = N + 2, SS = S * S;
  const H = new Int16Array(SS).fill(-1000), bid = new Int32Array(SS);
  for (let c = 0; c < SS; c++) {
    const v = vol[c + SS * colTop[c]];
    if (colTop[c] > 0 && v < roofPal.length && roofPal[v]) H[c] = colTop[c] - 1;
    bid[c] = bidAt((c % S) - 1, Math.floor(c / S) - 1);
  }
  const same = (a: number, b: number) => H[b] > -1000 && bid[a] === bid[b] && Math.abs(H[a] - H[b]) <= 4;
  const rx = new Float32Array(SS), ry = new Float32Array(SS), ok = new Uint8Array(SS);
  // (the apron too, from what of it is there: a riser out of the tile is lit like its neighbours inside)
  const diff = (c: number, st: number, lo: boolean, hi: boolean) => {
    const a = lo && same(c, c - st), b = hi && same(c, c + st);
    return a && b ? (H[c + st] - H[c - st]) / 2 : a ? H[c] - H[c - st] : b ? H[c + st] - H[c] : 0;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = x + S * y;
    if (H[c] === -1000) continue;
    rx[c] = diff(c, 1, x > 0, x < S - 1); ry[c] = diff(c, S, y > 0, y < S - 1); ok[c] = 1;
  }
  const gx = new Float32Array(SS), gy = new Float32Array(SS);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = x + S * y;
    if (!ok[c]) continue;
    let sx = 0, sy = 0, n = 0;
    for (let dy = Math.max(-1, -y); dy <= Math.min(1, S - 1 - y); dy++) for (let dx = Math.max(-1, -x); dx <= Math.min(1, S - 1 - x); dx++) {
      const k = c + dx + S * dy;
      if (ok[k] && (k === c || same(c, k))) { sx += rx[k]; sy += ry[k]; n++; }
    }
    gx[c] = sx / n; gy[c] = sy / n;
  }
  const encode = (x: number, y: number) => {
    const g = Math.hypot(x, y), k = Math.min(30, Math.round(Math.atan(g) / (Math.PI / 72)));
    return k < 4 ? 0 : 1 + k * 64 + ((Math.round(Math.atan2(-y, -x) / (Math.PI / 32)) + 64) % 64);
  };
  // a shipped plane falling along (ox, oy): a step down on it faces that way
  const faces = (p: number, ox: number, oy: number) => {
    const a = ((p - 1) & 63) * (Math.PI / 32);
    return p > 0 && Math.cos(a) * ox + Math.sin(a) * oy > 0.05;
  };
  return {
    // the face of cell (px, py, pz) along axis d (2: up), outwards dir
    code(px: number, py: number, pz: number, d: number, dir: number) {
      const c = (px + 1) + S * (py + 1);
      if (!ok[c]) return 0;
      if (d === 2) return dir > 0 && pz === H[c] ? (planes && planes[c]) || encode(gx[c], gy[c]) : 0;
      // a riser: the step down to a lower column of the same roof, lit as the plane between the two
      const n = c + (d === 0 ? dir : dir * S);
      if (!ok[n] || !same(c, n) || H[n] >= pz) return 0;
      if (planes && (planes[c] || planes[n])) {
        // the plane the step is part of: the upper column's, or the lower one's (the step up from a valley's floor)
        const ox = d === 0 ? dir : 0, oy = d === 0 ? 0 : dir;
        if (faces(planes[c], ox, oy)) return planes[c];
        if (faces(planes[n], ox, oy)) return planes[n];
      }
      const x = (gx[c] + gx[n]) / 2, y = (gy[c] + gy[n]) / 2;
      // ... facing downhill; or a 1 m notch in it (a pit, a bump) either way
      if (H[c] - H[n] > 1 && -(d === 0 ? x : y) * dir < 0.3 * Math.hypot(x, y)) return 0;
      return encode(x, y);
    },
  };
}

// per-corner occlusion, 2 bits each; on a staircase wall (stairAxis >= 0) only what is above or below darkens it, on a
// roof's staircase (roofPal) only what isn't roof -- a chimney, a dormer's wall
function faceAO(vol: Uint16Array, ni: number, su: number, sv: number, stairAxis: number, roofPal: Uint8Array | null) {
  const o = roofPal ? (k: number) => (vol[k] !== 0 && !(vol[k] < roofPal.length && roofPal[vol[k]]) ? 1 : 0) : (k: number) => (vol[k] !== 0 ? 1 : 0);
  let s10 = o(ni - su), s12 = o(ni + su), s01 = o(ni - sv), s21 = o(ni + sv);
  let c00 = o(ni - su - sv), c20 = o(ni + su - sv), c22 = o(ni + su + sv), c02 = o(ni - su + sv);
  if (stairAxis === 0) { s10 = s12 = 0; c00 = c20 = c22 = c02 = 0; }
  else if (stairAxis === 1) { s01 = s21 = 0; c00 = c20 = c22 = c02 = 0; }
  const ao = (a1: number, a2: number, c: number) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
  return ao(s10, s01, c00) | (ao(s12, s01, c20) << 2) | (ao(s12, s21, c22) << 4) | (ao(s10, s21, c02) << 6);
}

function emitMerged(mask: Float64Array, nu: number, nv: number, d: number, u: number, v: number, dir: number, normalIdx: number,
  sl: number, s: number, x0: number, y0: number, out: QuadBuffer) {
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu;) {
      const key = mask[i + j * nu];
      if (!key) { i++; continue; }
      let w = 1;
      while (i + w < nu && mask[i + w + j * nu] === key) w++;
      let h = 1;
      outer: while (j + h < nv) {
        for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * nu] !== key) break outer;
        h++;
      }
      for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[i + ii + (j + jj) * nu] = 0;
      const k0 = key - 1, bid = k0 % 16384, k1 = Math.floor(k0 / 16384);
      const gm = k1 % 256, aoBits = Math.floor(k1 / 256) % 256, palIdx = Math.floor(k1 / 65536) % 4096, ang = Math.floor(k1 / (65536 * 4096));
      // vattr.x: face axis + 8 x (a wall's direction, or a roof plane's slope in 2.5° steps); vattr.w: 1 + the roof
      // plane's downhill direction in 64 steps, 0 for anything else
      const roof = ang > 24 ? ang - 25 : -1, nrm = normalIdx + 8 * (roof >= 0 ? roof >> 6 : ang), rw = roof >= 0 ? 1 + (roof & 63) : 0;
      const aos = aoBits === 255 ? [3, 3, 3, 3] : [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
      const base = [0, 0, 0];
      base[d] = sl + (dir > 0 ? 1 : 0); base[u] = i; base[v] = j;
      const corners = [base, [...base], [...base], [...base]];
      corners[1][u] += w; corners[2][u] += w; corners[2][v] += h; corners[3][v] += h;
      out.reserve(4);
      const ord = QUAD_ORDER[(aos[0] + aos[2] < aos[1] + aos[3] ? 2 : 0) + (dir > 0 ? 1 : 0)];
      for (const c of ord) {
        const p = corners[c];
        out.vertex(p[0] * s + x0, p[2] * s, p[1] * s + y0, nrm, aos[c], gm, rw, palIdx, bid);
      }
      i += w;
    }
  }
}
