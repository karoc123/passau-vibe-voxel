// Sectioned meshing of an edited node (src/sections.ts, mesher.worker.ts meshSections; docs/adr/0003-remesh-cost.md),
// on real Altstadt nodes (round 63_21, up to 20, as tools/remesh-bench.mjs), each with its foliage tile where it has one:
//   1. the node's 16 sections meshed at once (sections: { hot: null }) are the node's mesh;
//   2. after a sphere of 3 m carved (core/columns.ts EditableNode) at a few sites -- the middle on the ground, a
//      section's corner, a roof, the node's edge, each on the column's top -- the sections of before, those the edit
//      can have changed meshed again (sections: { hot, bids }, as stream.ts sends them) in their places, are the edited
//      node's mesh; likewise its foliage tile's mesh and the base's cover (the foliage job);
//   3. the time of an edit's sectioned job (base; foliage + cover), mean and max, against the whole node's.
// "Are the mesh" in the sense that greedy merges may be cut differently: every quad that lies in one of its axis
// planes on a grid rectangle (voxel faces, a ramp's or a sloped roof's merged tops) is split into its unit cells with
// its attributes (per corner AO by the corner's place), the rest is compared as it is; the multisets must be equal. (A
// face out through the node's border has its top edge sunk 1/64 m: where its merge is cut that edge moves, ignored; a
// merged top takes the ground, vattr.z, of the cell it starts at: a top's unit cells are compared without it. A slope's
// top, roofs.ts, whose corners share their attributes is compared as the area each of its triangles covers of each
// unit cell, by the triangle's plane: a merged one is a ladder of quads through points along its sides that depend on
// where the merge is cut.)
// Nothing is written. usage (in web/): node tools/section-check.mjs [tx_ty, default 63_21] [-v]; exit code 1 on a mismatch
// (VOXEL_DATA: other data, tools/data-dir.mjs)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { dataDir } from './data-dir.mjs';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = dataDir, verbose = process.argv.includes('-v');
globalThis.self ??= globalThis; // (the worker module sets self.onmessage when loaded)
const imp = async (p) => (await runnerImport(path.join(web, p), { root: web, logLevel: 'error' })).module;
const mesher = await imp('src/mesher.worker.ts'), req = await imp('src/tile-request.ts');
const TD = await imp('src/tile-data.ts'), CO = await imp('src/core/columns.ts'), SE = await imp('src/sections.ts');

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const N = meta.tiles.N, S = N + 2, ctx = { N, W: meta.W, D: meta.D, ...req.paletteFlags(meta.palette) };
const raw = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tiles', `${f}.bin`))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const has = (f) => fs.existsSync(path.join(dir, 'tiles', `${f}.bin`));
const noLoad = async () => { throw new Error('no file'); };
const file = (k) => k;
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const [mx, my] = (args[0] ?? '63_21').split('_').map(Number);
const noMemo = process.argv.includes('--no-memo');
const nodes = [];
for (let r = 0; nodes.length < 20 && r < 6; r++) for (let ty = my - r; ty <= my + r; ty++) for (let tx = mx - r; tx <= mx + r; tx++) {
  if (Math.max(Math.abs(tx - mx), Math.abs(ty - my)) === r && nodes.length < 20 && has(`1/${tx}_${ty}`)) nodes.push([tx, ty]);
}

// --- the canonical form: a multiset of unit pieces and other quads ---
function canon(m, into, sign) {
  if (!m) return;
  const P = m.pos, A = m.attr, pal = m.pal, bld = m.bld;
  const add = (k) => { const v = (into.get(k) ?? 0) + sign; if (v) into.set(k, v); else into.delete(k); };
  for (let q = 0; q < m.quads; q++) {
    const V = [];
    for (let v = 0; v < 4; v++) {
      const i = q * 4 + v, f = A[i * 4 + 1] >> 2;
      // (a sunk top edge, INNER: its height as unsunk)
      V.push({ x: P[i * 3], y: P[i * 3 + 1] * 64 + f + (f === 63 && A[i * 4] % 8 < 4 ? 1 : 0), z: P[i * 3 + 2], ao: A[i * 4 + 1] & 3,
        rest: `${A[i * 4]},${A[i * 4] % 8 === 5 && A[i * 4 + 3] >= 1 && A[i * 4 + 3] <= 64 ? "g" : A[i * 4 + 2]},${A[i * 4 + 3]},${pal[i]},${bld ? bld[i] : 0}` });
    }
    const same = V.every((p) => p.rest === V[0].rest);
    const vals = (k) => [...new Set(V.map((p) => p[k]))].sort((a, b) => a - b);
    const xs = vals('x'), ys = vals('y'), zs = vals('z');
    const combos = (a, b, ka, kb) => a.length === 2 && b.length === 2 && a.every((u) => b.every((w) => V.some((p) => p[ka] === u && p[kb] === w)));
    let done = false;
    // a slope's top (roofs.ts: a merged one is drawn as a ladder of quads through the points along its sides, and how
    // its merge is cut moves them): the area each of its triangles covers of each unit cell, by the triangle's plane
    if (same && A[q * 16] % 8 === 5 && V.every((p) => p.ao === V[0].ao)) {
      for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) cover(V[a], V[b], V[c], `${V[0].rest} ${V[0].ao}`, sign, into);
      done = true;
    }
    if (same && !done) {
      // in an axis plane: [plane axis, u axis, v axis, unit along u, along v]
      for (const [pk, ua, va, uu, vu, pv] of [['x', 'z', 'y', 1, 64, xs], ['z', 'x', 'y', 1, 64, zs], ['y', 'x', 'z', 1, 1, ys]]) {
        if (pv.length !== 1) continue;
        const us = vals(ua), ws = vals(va);
        if (!combos(us, ws, ua, va) || (us[1] - us[0]) % uu || (ws[1] - ws[0]) % vu) continue;
        const role = (u, w) => V.find((p) => p[ua] === u && p[va] === w).ao;
        const ao = `${role(us[0], ws[0])}${role(us[1], ws[0])}${role(us[1], ws[1])}${role(us[0], ws[1])}`;
        for (let u = us[0]; u < us[1]; u += uu) for (let w = ws[0]; w < ws[1]; w += vu) add(`A${pk}${pv[0]} ${u} ${w} ${V[0].rest} ${ao}`);
        done = true;
        break;
      }
      // a top over a grid rectangle, its corners at heights in one plane: unit cells with their corners' heights
      if (!done && A[q * 16] % 8 === 5 && combos(xs, zs, 'x', 'z')) {
        const c = (x, z) => V.find((p) => p.x === x && p.z === z);
        const w = xs[1] - xs[0], h = zs[1] - zs[0], q00 = c(xs[0], zs[0]).y, q10 = c(xs[1], zs[0]).y, q01 = c(xs[0], zs[1]).y, q11 = c(xs[1], zs[1]).y;
        if (q11 - q01 === q10 - q00 && (q10 - q00) % w === 0 && (q01 - q00) % h === 0) {
          const dx = (q10 - q00) / w, dz = (q01 - q00) / h;
          const ao = `${c(xs[0], zs[0]).ao}${c(xs[1], zs[0]).ao}${c(xs[1], zs[1]).ao}${c(xs[0], zs[1]).ao}`;
          for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) add(`B ${xs[0] + i} ${zs[0] + j} ${q00 + dx * i + dz * j} ${dx} ${dz} ${V[0].rest} ${ao}`);
          done = true;
        }
      }
    }
    if (!done) add(`C ${V.map((p) => `${p.x} ${p.y} ${p.z} ${p.ao} ${p.rest}`).sort().join('|')}`);
  }
}
// (areas: in into's '~' keys, summed; equal meshes cancel them to 0)
function cover(p0, p1, p2, rest, sign, into) {
  const ux = p1.x - p0.x, uz = p1.z - p0.z, vx = p2.x - p0.x, vz = p2.z - p0.z, det = ux * vz - uz * vx;
  if (!det) return;
  const uy = p1.y - p0.y, vy = p2.y - p0.y, dx = (uy * vz - vy * uz) / det, dz = (ux * vy - vx * uy) / det;
  const xs = [p0.x, p1.x, p2.x], zs = [p0.z, p1.z, p2.z];
  for (let cx = Math.min(...xs); cx < Math.max(...xs); cx++) for (let cz = Math.min(...zs); cz < Math.max(...zs); cz++) {
    let poly = [[p0.x, p0.z], [p1.x, p1.z], [p2.x, p2.z]];
    for (const [ax, lim, keep] of [[0, cx, 1], [0, cx + 1, -1], [1, cz, 1], [1, cz + 1, -1]]) {
      const o = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], r = poly[(i + 1) % poly.length], dp = (p[ax] - lim) * keep, dr = (r[ax] - lim) * keep;
        if (dp >= 0) o.push(p);
        if ((dp >= 0) !== (dr >= 0)) { const t = dp / (dp - dr); o.push([p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t]); }
      }
      poly = o;
    }
    let ar = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], r = poly[(i + 1) % poly.length]; ar += p[0] * r[1] - r[0] * p[1]; }
    if (Math.abs(ar) < 1e-9) continue;
    const h = p0.y + dx * (cx - p0.x) + dz * (cz - p0.z);
    const k = `~T ${cx} ${cz} ${h.toFixed(4)} ${dx.toFixed(6)} ${dz.toFixed(6)} ${Math.sign(det)} ${rest}`;
    const v = (into.get(k) ?? 0) + sign * Math.abs(ar) / 2;
    if (Math.abs(v) > 1e-6) into.set(k, v); else into.delete(k);
  }
}
const bad = [];
const fail = (w) => { if (bad.length < 20) console.log(`  FAIL ${w}`); bad.push(w); };
function compare(name, whole, secs) {
  const m = new Map();
  canon(whole, m, 1);
  for (const s of secs.values()) canon(s, m, -1);
  if (!m.size) return true;
  const ex = [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).filter((e, i, a) => verbose || i < 2).filter((e, i) => i < 4 || e[1] < 0).slice(0, verbose ? 8 : 2).map(([k, v]) => `${v > 0 ? 'only whole' : 'only sections'} x${Math.abs(v)}: ${k.slice(0, 160)}`);
  fail(`${name}: ${m.size} pieces differ\n      ${ex.join('\n      ')}`);
  return false;
}
const put = (map, sec) => { if (sec) sec.ids.forEach((k, i) => map.set(k, sec.meshes[i])); return map; };

const copy = (c) => ({ counts: c.counts.slice(), runs: c.runs.slice(), ground: c.ground.slice(), planes: c.planes?.slice() ?? null, bld: c.bld?.slice() ?? null, caps: c.caps ?? null });
const baseReq = (tx, ty, cols, sections) => ({ ...req.tileRequest(ctx, 1, tx, ty, false, file, false), url: undefined, cols, sections });
const folReq = (tx, ty, fol, base, sections) => ({ ...req.tileRequest(ctx, 1, tx, ty, true, file), url: undefined, cols: fol, under: base, sections });
const topOf = (d, c) => { let k = 0; for (let i = 0; i < c; i++) k += d.counts[i]; const n = d.counts[c]; return n ? d.runs[(k + n - 1) * 3] + d.runs[(k + n - 1) * 3 + 1] : 0; };
// the sites carved, node cells, and at which height: the middle on its ground; a section's corner, a roof (the tallest
// column near (96, 40)), the node's edge -- on the column's top
function sites(d) {
  let best = [96, 40], bt = -1;
  for (let y = 34; y < 46; y++) for (let x = 90; x < 102; x++) { const t = topOf(d, x + 1 + S * (y + 1)); if (t > bt) { bt = t; best = [x, y]; } }
  const at = (x, y) => [x, y, Math.max(0, topOf(d, x + 1 + S * (y + 1)) - 1)];
  return [[N / 2, N / 2, d.ground[N / 2 + 1 + S * (N / 2 + 1)]], at(31, 33), at(...best), at(0, 70)];
}

const tm = { base: [], fol: [], wholeBase: [], wholeFol: [] }, dirty = [];
let checked = 0, folChecked = 0;
for (let pass = 0; pass < 2; pass++) {
  for (const k of Object.keys(tm)) tm[k].length = 0;
  dirty.length = 0;
  for (const [tx, ty] of nodes) {
    const name = `${tx}_${ty}`, d = TD.decodeTile(raw(`1/${name}`), N);
    const fd = has(`1f/${name}`) ? TD.decodeTile(raw(`1f/${name}`), N) : null;
    // 1. all sections at once
    const id0 = `${name} ${pass} all`;
    const allB = await mesher.meshJob(baseReq(tx, ty, copy(d), { hot: null, id: id0, from: null }), noLoad);
    const allF = fd ? await mesher.meshJob(folReq(tx, ty, copy(fd), copy(d), { hot: null, id: id0, from: null }), noLoad) : null;
    if (pass) {
      const w = await mesher.meshJob(baseReq(tx, ty, copy(d), null), noLoad);
      compare(`1/${name}`, w.out, put(new Map(), allB.sec));
      if (fd) {
        const wf = await mesher.meshJob(folReq(tx, ty, copy(fd), copy(d), null), noLoad);
        compare(`1f/${name}`, wf.out, put(new Map(), allF.sec));
        compare(`1c/${name}`, wf.base, put(new Map(), allF.baseSec));
      }
    }
    // 2, 3. carved, one site after the other; the sections each carve can have changed meshed again
    const shownB = put(new Map(), allB.sec), shownF = put(new Map(), allF?.sec), shownC = put(new Map(), allF?.baseSec);
    let cur = d, curF = fd, from = id0, i = 0;
    for (const [cx, cy, cz] of sites(d)) {
      const e = new CO.EditableNode(N, cur, tx, ty);
      e.carveSphere([cx, cy, cz], 3);
      const enc = { ...e.encode(), planes: d.planes, bld: d.bld, caps: d.caps };
      let fenc = null;
      if (curF) { const f = new CO.EditableNode(N, curF, tx, ty); f.carveSphere([cx, cy, cz], 3); fenc = { ...f.encode(), ground: enc.ground }; }
      const gx = tx * N + cx, gy = ty * N + cy, hot = SE.hotBox(N, tx, ty, [gx - 3, gy - 3, gx + 4, gy + 4]);
      const id = `${name} ${pass} ${i++}`;
      const job = { hot, bids: SE.roofsChanged(N, cur, enc, d.bld, hot), id, from: noMemo ? null : from };
      from = id;
      let t0 = performance.now();
      const incB = await mesher.meshJob(baseReq(tx, ty, copy(enc), job), noLoad);
      tm.base.push(performance.now() - t0);
      t0 = performance.now();
      const w = await mesher.meshJob(baseReq(tx, ty, copy(enc), null), noLoad);
      tm.wholeBase.push(performance.now() - t0);
      dirty.push(incB.sec.ids.length);
      put(shownB, incB.sec);
      if (pass) { checked++; compare(`1/${name} carved at ${cx},${cy},${cz} (${incB.sec.ids.length} sections)`, w.out, shownB); }
      cur = enc;
      if (!curF) continue;
      t0 = performance.now();
      const incF = await mesher.meshJob(folReq(tx, ty, copy(fenc), copy(enc), job), noLoad);
      tm.fol.push(performance.now() - t0);
      t0 = performance.now();
      const wf = await mesher.meshJob(folReq(tx, ty, copy(fenc), copy(enc), null), noLoad);
      tm.wholeFol.push(performance.now() - t0);
      put(shownF, incF.sec); put(shownC, incF.baseSec);
      curF = fenc;
      if (pass) {
        folChecked++;
        compare(`1f/${name} carved at ${cx},${cy},${cz}`, wf.out, shownF);
        compare(`1c/${name} carved at ${cx},${cy},${cz} (${incF.baseSec.ids.length} sections)`, wf.base, shownC);
      }
    }
  }
}
const stat = (a) => `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} / ${Math.max(...a).toFixed(1)}`;
const st = mesher.sectionStats, per = (v) => (v / st.passes).toFixed(2);
console.log(`sectioned jobs: ${st.jobs} (${st.memo} with their node's memo), ${(st.passes / st.jobs).toFixed(2)} passes each; per pass the part of the node read ${per(st.read)}, its chamfers looked for in ${per(st.rch)}, slopes in ${per(st.rs)}`);
console.log(`${nodes.length} nodes round ${mx}_${my}${noMemo ? ', no memo' : ''}: ${checked} carves (${folChecked} with foliage), sections (${SE.SEC} x ${SE.SEC}) meshed again per carve ${stat(dirty)} (mean / max)`);
console.log(`ms mean / max  edit, sectioned: base ${stat(tm.base)}, foliage + cover ${stat(tm.fol)}  --  whole node: base ${stat(tm.wholeBase)}, foliage + cover ${stat(tm.wholeFol)}`);
console.log(bad.length ? `FAIL section-check: ${bad.length} mismatches` : 'PASS section-check: the sections are the node\'s mesh, before and after each carve');
process.exit(bad.length ? 1 : 0);
