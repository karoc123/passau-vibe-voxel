// The FPV drone's collision (src/nav/voxel-collision.ts) headless: checks/collision-checks.ts (a synthetic world
// served as real node files; sweeps of the drone's cube, surfaces; a hall with a door and its room recorded: the drone
// and a walker go in and stay in, World.inRoom). Then, on the real data (public/data) if it is
// there: the drone flown through a tunnel under a hill (scripts/tunnels.py) 2 m over the road along the traffic road
// with the most points 5 m or more under the voxels over them; skipped without such a road or where the tiles' ground
// still stands over the bore (data from before the bores' floors became the ground).
// usage: node tools/collision.mjs [--json]; exit code 1 if a check fails
import { imp } from './lib.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const m = await imp('checks/collision-checks.ts');
const TD = await imp('src/tile-data.ts');
const out = [...await m.runCollisionChecks(), ...await m.runRoomChecks()];

async function tunnelFlight() {
  const D = `${root}public/data/`;
  if (!fs.existsSync(`${D}traffic.json`) || !fs.existsSync(`${D}meta.json`)) return null;
  const meta = JSON.parse(fs.readFileSync(`${D}meta.json`, 'utf8')), N = meta.tiles.N, S = N + 2;
  const raw = new Map(), dec = new Map();
  const tileOf = (x, z) => {
    const k = `${Math.floor(x / N)}_${Math.floor(z / N)}`;
    if (!dec.has(k)) {
      const f = `${D}tiles/1/${k}.bin`;
      if (!fs.existsSync(f)) { dec.set(k, null); return null; }
      const b = fs.readFileSync(f);
      raw.set(`data/tiles/1/${k}.bin`, new Uint8Array(b));
      const ff = `${D}tiles/1f/${k}.bin`;
      if (fs.existsSync(ff)) raw.set(`data/tiles/1f/${k}.bin`, new Uint8Array(fs.readFileSync(ff)));
      dec.set(k, TD.decodeTile(zlib.gunzipSync(b).buffer, N));
    }
    return dec.get(k);
  };
  const col = (x, z) => {
    const t = tileOf(x, z);
    if (!t) return null;
    const c = (Math.floor(x) % N) + 1 + S * ((Math.floor(z) % N) + 1);
    let k0 = 0;
    for (let i = 0; i < c; i++) k0 += t.counts[i];
    const n = t.counts[c], top = n ? t.runs[(k0 + n - 1) * 3] + t.runs[(k0 + n - 1) * 3 + 1] : 0;
    return { ground: t.ground[c], top };
  };
  const under = (q) => { const c = col(q[0], q[1]); return c && c.top - q[2] >= 5; };
  const TP = await imp('src/sim/traffic-pack.ts');
  const traffic = TP.unpackTraffic(JSON.parse(fs.readFileSync(`${D}traffic.json`, 'utf8')));
  let best = null;
  for (const r of traffic.roads) {
    const n = r.p.filter(under).length;
    if (n >= 4 && (!best || n > best.n)) best = { r, n };
  }
  if (!best) return null;
  const inside = best.r.p.filter(under);
  const blocked = inside.filter((q) => col(q[0], q[1]).ground > q[2] + 1).length;
  if (blocked > inside.length / 2) {
    console.log(`skip  fpv_tunnel             (the tiles' ground still over the bore: ${blocked}/${inside.length} points; data needs regenerating)`);
    return null;
  }
  for (const q of best.r.p) for (const dx of [-130, 0, 130]) for (const dz of [-130, 0, 130]) tileOf(q[0] + dx, q[1] + dz);
  const hit = await m.sweepPath(meta, raw, best.r.p, 2);
  const p0 = best.r.p[0];
  return { name: 'fpv_tunnel', pass: !hit, detail: { x0: p0[0], z0: p0[1], points: best.r.p.length, inside: inside.length, ...(hit ?? { hit: 'none' }) } };
}

const t = await tunnelFlight();
if (t) out.push(t);
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
