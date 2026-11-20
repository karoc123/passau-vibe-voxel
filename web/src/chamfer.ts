// Diagonal walls (1 m tiles). A building wall at an angle to the grid is a staircase of 1 m steps: every step was a
// facade of its own, with its own window or half of one, a dark notch at each inner corner, and a stepped eave. Each
// inner corner of such a staircase is filled with a triangular prism -- from the step's outer corner to the next one's --
// so the steps' outer corners are joined by one flat slanted face: the wall the staircase stands for (a 45° wall is
// exactly flat, steeper or shallower ones a run of near-collinear faces), lit and windowed as that plane
// (voxelMaterial.ts). The two step faces inside each prism are not emitted.
//
// A step is an inner corner whose two legs (along x and along y) end at outer corners, one of them 1 m (a staircase's
// minor step) and the other at most MAX_LEG, next to another such step (sharing an outer corner): a jog in a facade, a
// courtyard's corner or a recess 2 m deep keeps its corner. A tile fills the steps whose inner corner is its own, as
// far as it sees them (its 1-cell apron): a long step across a tile's edge may stay. Prisms go up the wall as far as
// the step does, and into the eave (where the roof overhangs the street, or stands on a filled step), so
// the eave runs straight as well; the roof above it is left as it is.

import { grow, type Box } from './sections';

export const MAX_LEG = 6;
// palette flags (stream.ts): roof material, the walls that are chamfered, paved ground (ramps.ts), and water (a distance
// level's water sunk to its surface, mesher.worker.ts emitMerged)
export const PAL_ROOF = 1, PAL_WALL = 2, PAL_GROUND = 4, PAL_WATER = 8;
// vattr.w of a slanted face: SLANT + its outward direction in plan in SLANT_STEPS steps (atan2(y, x), data axes)
export const SLANT = 128, SLANT_STEPS = 128;

// Meshing a part of a node (sections.ts, mesher.worker.ts meshSections): the steps are looked for in box only (apron
// coordinates; the volume holds what they read, 8 columns round it). A staircase's steps depend on each other (a step
// counts next to another, a prism's light and windows come from its staircase), so the staircases that matter --
// those with a step within 19 columns of hot (an edit's columns: what it can have changed) or within 7 of rel (the
// sections meshed: their prisms and hidden faces) -- are returned with the box of their steps (comps)
export interface ChamferWindow { box: Box; hot: Box | null; rel: Box[] }
export interface Staircase { box: Box; hot: boolean }

export interface Prism {
  px: number; py: number; // the inner corner, a grid point
  sx: number; sy: number; // the side of it the filled cells are on (-sx, -sy: towards the street)
  a: number; b: number; // leg lengths along x and along y
  z0: number; z1: number;
  pal: number; bid: number; gm: number;
  dir: number; // outward direction, 0 .. SLANT_STEPS - 1: its light
  chain: number; // its staircase's, 1 + 24 steps: its windows
  roof: number; // > 0: roof-material layers at the top of the run (the eave)
  capTop: boolean; capBottom: boolean; aoBottom: number;
  cx: number; cy: number; // the cell its material is taken from
}

// The steps found at each height (steps[z]), kept with a node meshed in sections (mesher.worker.ts): a step depends on
// the columns within 7 of its inner corner only, so after an edit only those in redo (apron coordinates: the columns
// changed and 8 round them) are looked for again, the others taken as they were. Then changed: the inner corners of
// the steps whose prisms can have changed -- found, lost, or another light (their staircase's), and those within 10 of
// the edit (hot: what a prism reads round it)
export interface ChamferMemo { steps: Tri[][]; redo: Box }
export interface Tri { ca: number; cb: number; key: number; X: number; Y: number; cx: number; cy: number; sx: number; sy: number; a: number; b: number; pal: number; bid: number; gm: number; roof: boolean; nx: number; ny: number }

const SIDES = [[1, 1], [-1, 1], [1, -1], [-1, -1]];

// vol: the tile's voxels as in mesher.worker.ts (1-cell apron, z = -1 below); returns the prisms and, per voxel, the
// faces that are inside one (bit d * 2 + (dir > 0) per horizontal face)
export function chamferWalls(N: number, vol: Uint16Array, sz: number, ground: Uint8Array, colTop: Uint16Array, pal: Uint8Array,
  bidAt: (x: number, y: number) => number, win: ChamferWindow | null = null, memo: ChamferMemo | null = null) {
  const S = N + 2, SS = S * S;
  // (the steps' cells looked at: all, or the window's box; node cells)
  const look = memo ? memo.redo : win ? win.box : null;
  const X0 = look ? Math.max(0, look.x0 - 1) : 0, X1 = look ? Math.min(N, look.x1 - 1) : N;
  const Y0 = look ? Math.max(0, look.y0 - 1) : 0, Y1 = look ? Math.min(N, look.y1 - 1) : N;
  const steps: Tri[][] = [];
  const hotB = win?.hot ? grow(win.hot, 19, S) : null, relB = win ? win.rel.map((b) => grow(b, 7, S)) : [];
  const comps: Staircase[] = [], changed: { X: number; Y: number }[] = [];
  const hot10 = memo && win?.hot ? grow(win.hot, 10, S) : null;
  const hidden = new Uint8Array(SS * sz);
  const at = (X: number, Y: number, z: number) => (X + 1) + S * (Y + 1) + SS * (z + 1);
  const inb = (X: number, Y: number) => X >= -1 && X <= N && Y >= -1 && Y <= N;
  // 0: empty, 1: wall, 2: roof, 3: anything else (blocks a step)
  const kind = (X: number, Y: number, z: number) => {
    const v = vol[at(X, Y, z)];
    if (v === 0) return 0;
    if (v >= pal.length || bidAt(X, Y) === 0) return 3;
    return pal[v] & PAL_WALL ? 1 : pal[v] & PAL_ROOF ? 2 : 3;
  };
  // walk a leg from the inner corner of empty cell (X, Y): along (ux, uy) away from it, the solid side at (ox, oy)
  const leg = (X: number, Y: number, z: number, ux: number, uy: number, ox: number, oy: number, roofs: { n: number; up: number }) => {
    for (let k = 0; k <= MAX_LEG; k++) {
      const ex = X + ux * k, ey = Y + uy * k;
      if (!inb(ex, ey) || !inb(ex + ox, ey + oy)) return 0;
      if (vol[at(ex, ey, z)] !== 0) return 0; // the street side is blocked: not a step
      const o = kind(ex + ox, ey + oy, z);
      if (o === 0) return k; // the outer corner
      if (o === 3) return 0;
      if (o === 2) { roofs.n++; if (z > 0 && vol[at(ex + ox, ey + oy, z - 1)] !== 0) roofs.up++; }
    }
    return 0;
  };

  let zTop = 0;
  for (let c = 0; c < SS; c++) zTop = Math.max(zTop, colTop[c]);
  if (memo) zTop = Math.max(zTop, memo.steps.length);
  // grid points, as numbers
  const pk = (x: number, y: number) => (y + 8) * 4096 + x + 8;
  // the rows with anything at a height, and the ones beside them
  const rowTop = new Uint16Array(S);
  for (let c = 0; c < SS; c++) { const r = Math.floor(c / S); rowTop[r] = Math.max(rowTop[r], colTop[c]); }
  // the columns beside a building: the only ones a step can be in
  const near = new Uint8Array(SS);
  for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++)
    near[(X + 1) + S * (Y + 1)] = bidAt(X - 1, Y) || bidAt(X + 1, Y) || bidAt(X, Y - 1) || bidAt(X, Y + 1) ? 1 : 0;
  const prisms: Prism[] = [];
  let open = new Map<number, Prism>();
  for (let z = 0; z < zTop; z++) {
    const tris: Tri[] = [];
    // (the steps kept: in the order they are found in, by key)
    if (memo) for (const t of memo.steps[z] ?? []) if (t.X < X0 || t.X >= X1 || t.Y < Y0 || t.Y >= Y1) tris.push(t);
    const kept = tris.length;
    for (let Y = Y0; Y < Y1; Y++) {
      if (Math.max(rowTop[Y], rowTop[Y + 1], rowTop[Y + 2]) <= z) continue;
      for (let X = X0; X < X1; X++) {
        if (!near[(X + 1) + S * (Y + 1)]) continue;
        const e = at(X, Y, z);
        if (vol[e] !== 0) continue;
        // a quick test: two solid neighbours at right angles
        const l = vol[e - 1] !== 0, r = vol[e + 1] !== 0, u = vol[e - S] !== 0, d = vol[e + S] !== 0;
        if (!((l || r) && (u || d))) continue;
        for (let o = 0; o < 4; o++) {
          const [sx, sy] = SIDES[o];
          if (!(sx > 0 ? r : l) || !(sy > 0 ? d : u)) continue;
          if (kind(X + sx, Y + sy, z) === 0) continue; // the cell in the corner
          const roofs = { n: 0, up: 0 };
          const a = leg(X, Y, z, -sx, 0, 0, sy, roofs); // along x, solid on the +sy side
          if (!a) continue;
          const b = leg(X, Y, z, 0, -sy, sx, 0, roofs);
          if (!b || Math.min(a, b) !== 1 || Math.max(a, b) > MAX_LEG) continue;
          const key = ((Y * S + X) * 4 + o) * 64 + a * 8 + b;
          // of the roof only the eave's steps: where it overhangs the street, or stands on a filled step (every layer
          // of a roof is a staircase in plan too, but it stands on the house)
          if (roofs.up && !open.has(key)) continue;
          // the material of the long leg's first cell
          const cx = a >= b ? X : X + sx, cy = a >= b ? Y + sy : Y;
          const v = vol[at(cx, cy, z)];
          const px = X + (sx > 0 ? 1 : 0), py = Y + (sy > 0 ? 1 : 0);
          tris.push({ ca: pk(px - a * sx, py), cb: pk(px, py - b * sy),
            key, X, Y, cx, cy, sx, sy, a, b, pal: v, bid: bidAt(cx, cy),
            gm: ground[(cx + 1) + S * (cy + 1)], roof: roofs.n > 0, nx: -b * sx, ny: -a * sy });
        }
      }
    }
    if (memo && kept && kept < tris.length) tris.sort((a, b) => a.key - b.key);
    steps[z] = tris;
    // steps of the same staircase share their outer corners
    const ends = new Map<number, Tri[]>();
    for (const t of tris) for (const c of [t.ca, t.cb]) (ends.get(c) ?? ends.set(c, []).get(c)!).push(t);
    const along = (t: Tri, c: number) => ends.get(c)!.find((n) => n !== t && n.sx === t.sx && n.sy === t.sy);
    if (win && !memo) staircases(tris, ends, hotB, relB, comps);
    if (memo) {
      const old = memo.steps[z] ?? [], near = (t: Tri) => hot10 !== null && t.X + 1 >= hot10.x0 && t.X + 1 < hot10.x1 && t.Y + 1 >= hot10.y0 && t.Y + 1 < hot10.y1;
      // (the same steps as before at this height: none changed but those near the edit)
      if (old.length === tris.length && old.every((o, i) => o === tris[i] || sameStep(o, tris[i]))) { for (const t of tris) if (near(t)) changed.push(t); }
      else {
        const was = stepLight(old), now = stepLight(tris);
        for (const [k, v] of now) if (was.get(k)?.sig !== v.sig || near(v.t)) changed.push(v.t);
        for (const [k, v] of was) if (!now.has(k)) changed.push(v.t);
      }
    }
    // a lone inner corner is a facade's jog, not a staircase
    const acc = tris.filter((t) => along(t, t.ca) || along(t, t.cb));
    // lit as the wall: a new prism's direction is its staircase's over two steps either side (SLANT_STEPS)
    const direction = (t: Tri) => {
      let nx = 2 * t.nx, ny = 2 * t.ny;
      for (const c0 of [t.ca, t.cb]) {
        let cur = t, c = c0;
        for (let k = 0; k < 2; k++) {
          const n = along(cur, c);
          if (!n) break;
          nx += n.nx; ny += n.ny;
          c = n.ca === c ? n.cb : n.ca; cur = n;
        }
      }
      return ((Math.round(Math.atan2(ny, nx) / (2 * Math.PI / SLANT_STEPS)) % SLANT_STEPS) + SLANT_STEPS) % SLANT_STEPS;
    };
    // ... and its windows are laid out along the whole staircase's direction (24 steps, as wallAngle in the mesher): the
    // facade's coordinate along it is one linear function of position for every face of it, so the windows run on
    // across its faces (each face's own direction made that jump from face to face, and cut windows into slivers)
    const chainDir = new Map<Tri, number>();
    const chain = (t: Tri) => {
      let d = chainDir.get(t);
      if (d !== undefined) return d;
      const seen: Tri[] = [t], todo = [t];
      let nx = 0, ny = 0;
      chainDir.set(t, 0);
      while (todo.length) {
        const f = todo.pop()!;
        nx += f.nx; ny += f.ny;
        for (const c of [f.ca, f.cb]) for (const n of ends.get(c)!) {
          if (n.sx !== f.sx || n.sy !== f.sy || chainDir.has(n)) continue;
          chainDir.set(n, 0); seen.push(n); todo.push(n);
        }
      }
      d = 1 + (Math.round(Math.atan2(ny, nx) / (Math.PI / 12)) + 24) % 24;
      for (const f of seen) chainDir.set(f, d);
      return d;
    };
    const next = new Map<number, Prism>();
    for (const t of acc) {
      const prev = open.get(t.key);
      if (prev && prev.pal === t.pal && prev.z1 === z) { prev.z1 = z + 1; if (t.roof) prev.roof++; next.set(t.key, prev); open.delete(t.key); }
      else {
        if (prev) { prev.capTop = false; prisms.push(prev); open.delete(t.key); }
        let aoBottom = 3, capBottom = !prev;
        if (!prev) {
          // standing on something: no floor under it, and its foot is shaded like a wall's
          let solid = 0, cells = 0;
          for (let k = 0; k < Math.max(t.a, t.b); k++) {
            const X = t.a > 1 ? t.X - k * t.sx : t.X, Y = t.b > 1 ? t.Y - k * t.sy : t.Y;
            cells++; if (z === 0 || vol[at(X, Y, z - 1)] !== 0) solid++;
          }
          if (solid === cells) { capBottom = false; aoBottom = 2; }
        }
        next.set(t.key, { px: t.X + (t.sx > 0 ? 1 : 0), py: t.Y + (t.sy > 0 ? 1 : 0), sx: t.sx, sy: t.sy, a: t.a, b: t.b, z0: z, z1: z + 1,
          pal: t.pal, bid: t.bid, gm: t.gm, dir: direction(t), chain: chain(t), roof: t.roof ? 1 : 0, capTop: true, capBottom, aoBottom, cx: t.cx, cy: t.cy });
      }
      // the step's own faces are inside the prism
      for (let k = 0; k < t.a; k++) { const X = t.X - k * t.sx, Y = t.Y + t.sy; if (X >= 0 && X < N && Y >= 0 && Y < N) hidden[at(X, Y, z)] |= 1 << (2 + (t.sy < 0 ? 1 : 0)); }
      for (let k = 0; k < t.b; k++) { const X = t.X + t.sx, Y = t.Y - k * t.sy; if (X >= 0 && X < N && Y >= 0 && Y < N) hidden[at(X, Y, z)] |= 1 << (t.sx < 0 ? 1 : 0); }
    }
    for (const p of open.values()) prisms.push(p);
    open = next;
  }
  for (const p of open.values()) prisms.push(p);
  // no lid where the cells above it are solid
  for (const p of prisms) {
    if (!p.capTop) continue;
    const X0 = p.px - (p.sx > 0 ? 1 : 0), Y0 = p.py - (p.sy > 0 ? 1 : 0);
    let all = true;
    for (let k = 0; k < Math.max(p.a, p.b) && all; k++) {
      const X = p.a > 1 ? X0 - k * p.sx : X0, Y = p.b > 1 ? Y0 - k * p.sy : Y0;
      if (p.z1 >= sz - 1 || vol[at(X, Y, p.z1)] === 0) all = false;
    }
    if (all) p.capTop = false;
  }
  return { prisms, hidden, comps, steps, changed };
}

const sameStep = (a: Tri, b: Tri) => a.key === b.key && a.pal === b.pal && a.bid === b.bid && a.gm === b.gm && a.roof === b.roof && a.cx === b.cx && a.cy === b.cy;

// Per step (by key) what its prism is made of: whether it is one (a step next to it), its light over two steps either
// side, its staircase's direction, and its own -- as chamferWalls has them (sig)
function stepLight(tris: Tri[]) {
  const ends = new Map<number, Tri[]>();
  for (const t of tris) for (const c of [t.ca, t.cb]) (ends.get(c) ?? ends.set(c, []).get(c)!).push(t);
  const along = (t: Tri, c: number) => ends.get(c)!.find((n) => n !== t && n.sx === t.sx && n.sy === t.sy);
  const sum = new Map<Tri, number[]>(), out = new Map<number, { t: Tri; sig: string }>();
  for (const t of tris) {
    if (!sum.has(t)) {
      const seen: Tri[] = [t], todo = [t], v = [0, 0];
      sum.set(t, v);
      while (todo.length) {
        const f = todo.pop()!;
        v[0] += f.nx; v[1] += f.ny;
        for (const c of [f.ca, f.cb]) for (const n of ends.get(c)!) {
          if (n.sx !== f.sx || n.sy !== f.sy || sum.has(n)) continue;
          sum.set(n, v); seen.push(n); todo.push(n);
        }
      }
    }
    let nx = 2 * t.nx, ny = 2 * t.ny;
    for (const c0 of [t.ca, t.cb]) {
      let cur = t, c = c0;
      for (let k = 0; k < 2; k++) {
        const n = along(cur, c);
        if (!n) break;
        nx += n.nx; ny += n.ny;
        c = n.ca === c ? n.cb : n.ca; cur = n;
      }
    }
    const v = sum.get(t)!, acc = !!(along(t, t.ca) || along(t, t.cb));
    const dir = ((Math.round(Math.atan2(ny, nx) / (2 * Math.PI / SLANT_STEPS)) % SLANT_STEPS) + SLANT_STEPS) % SLANT_STEPS;
    const chain = 1 + (Math.round(Math.atan2(v[1], v[0]) / (Math.PI / 12)) + 24) % 24;
    out.set(t.key, { t, sig: `${acc} ${dir} ${chain} ${t.pal} ${t.bid} ${t.gm} ${t.roof} ${t.cx} ${t.cy}` });
  }
  return out;
}

// the staircases (steps of one side sharing outer corners) with a step in hot or in one of rel, and their boxes
function staircases(tris: Tri[], ends: Map<number, Tri[]>, hot: Box | null, rel: Box[], out: Staircase[]) {
  const seen = new Set<Tri>(), todo: Tri[] = [];
  const at = (b: Box, t: Tri) => t.X + 1 >= b.x0 && t.X + 1 < b.x1 && t.Y + 1 >= b.y0 && t.Y + 1 < b.y1;
  for (const t0 of tris) {
    if (seen.has(t0)) continue;
    seen.add(t0); todo.push(t0);
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let h = false, r = false;
    while (todo.length) {
      const f = todo.pop()!;
      box.x0 = Math.min(box.x0, f.X + 1); box.y0 = Math.min(box.y0, f.Y + 1); box.x1 = Math.max(box.x1, f.X + 2); box.y1 = Math.max(box.y1, f.Y + 2);
      if (hot && !h && at(hot, f)) h = true;
      if (!r) for (const b of rel) if (at(b, f)) { r = true; break; }
      for (const c of [f.ca, f.cb]) for (const n of ends.get(c)!) {
        if (n.sx !== f.sx || n.sy !== f.sy || seen.has(n)) continue;
        seen.add(n); todo.push(n);
      }
    }
    if (h || r) out.push({ box, hot: h });
  }
}
