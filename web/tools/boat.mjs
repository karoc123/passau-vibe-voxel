// The player's boat (src/sim/craft/boat-motion.ts) headless: checks/boat-checks.ts. On a synthetic world served as real node
// files (a channel, a bridge, a footbridge too low, a pier): top speed, coasting, turning and drifting, reverse, the
// bank and the pier bounced off, under the bridge, put in from the land, unstuck. Then, on the real data (public/data)
// if it is there: put in near the Altstadt facing downstream and a minute's lap there, east under the Schanzlbrücke,
// north into the Danube's bank.
// usage: node tools/boat.mjs [--json]; exit code 1 if a check fails
import fs from 'node:fs';
import zlib from 'node:zlib';
import { load, DATA, hasData, readMeta, rawTile } from './real-city.mjs';
import { imp } from './lib.mjs';

const m = await imp('checks/boat-checks.ts');
const out = await m.runBoatChecks();

if (hasData() && fs.existsSync(`${DATA}flood.json`)) {
  const { VoxelCollision } = await load('sim/craft/voxel-collision.ts');
  const { TileCache } = await load('core/tile-cache.ts');
  const { Vector3 } = await import('three');
  const meta = readMeta(), N = meta.tiles.N;
  const cache = new TileCache({ N, load: async (p) => { const b = zlib.gunzipSync(fs.readFileSync(`${DATA}tiles/${p}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
  const c = new VoxelCollision(meta, cache, () => performance.now());
  // the 3 x 3 nodes round (x, z) in
  const need = async (x, z) => {
    const p = new Vector3(x, 0, z), zero = new Vector3();
    for (let i = 0; i < 4000; i++) {
      c.prefetch(p, zero);
      let all = true;
      for (const dx of [-N, 0, N]) for (const dz of [-N, 0, N]) {
        const qx = x + dx, qz = z + dz;
        if (qx >= 0 && qz >= 0 && qx < meta.W && qz < meta.D && !c.surface(qx, qz)) all = false;
      }
      if (all) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`collision tiles never loaded at ${x}, ${z}`);
  };
  const river = JSON.parse(fs.readFileSync(`${DATA}flood.json`, 'utf8')).river ?? [];
  try {
    out.push(...await m.runRealChecks(c, meta, river, need));
    if (fs.existsSync(`${DATA}boats.json`)) out.push(await shipTops(c, meta, need));
  } finally {
    c.release();
  }
} else console.log('skip  real data             (no public/data)');

// The river traffic's water top (sim/boat-traffic.ts over core/world.ts World.waterColumn) along boats.json's routes
// (every 4 m: the tour, the fairway's lanes and turns, the berths) from the nodes of each level alone, as the viewer's
// streamer swaps them: the same top as from level 1 (a ship's height does not jump when its node is replaced); every
// 64th point also as the player's crafts see it (VoxelCollision.waterColumn, sim/river.ts waterTop)
async function shipTops(c, meta, need) {
  const { World } = await load('core/world.ts'), TD = await load('core/tile-data.ts'), { waterTop } = await load('sim/river.ts');
  const N = meta.tiles.N, S = N + 2, nodes = new Map(), levels = meta.tiles.levels.map((l) => l.s);
  const columns = (key) => {
    if (!nodes.has(key)) {
      const [s, t] = key.split('/'), [tx, ty] = t.split('_').map(Number);
      let d;
      if (fs.existsSync(`${DATA}tiles/${key}.bin`)) {
        const cl = TD.decodeTile(rawTile(`${key}.bin`), N), off = new Uint32Array(S * S + 1);
        for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + cl.counts[i];
        d = { ...cl, s: +s, x0: tx * N * s, y0: ty * N * s, S, off, roomOff: null };
      }
      nodes.set(key, d);
    }
    return nodes.get(key);
  };
  const worlds = levels.map((s) => [s, new World({ N, levels: [s], version: 0, columns }, meta)]);
  const b = JSON.parse(fs.readFileSync(`${DATA}boats.json`, 'utf8')), f = b.fairway;
  const routes = [b.tour, ...(f ? [f.up, f.down, f.turnE[2], f.turnW[2]] : []), b.berths.map((q) => [q.x, q.y])];
  const pts = [];
  for (const p of routes) for (let k = 0; k < p.length; k++) {
    const a = p[k], e = p[k + 1] ?? a, n = Math.max(1, Math.ceil(Math.hypot(e[0] - a[0], e[1] - a[1]) / 4));
    for (let j = 0; j < n; j++) pts.push([a[0] + (e[0] - a[0]) * j / n, a[1] + (e[1] - a[1]) * j / n]);
  }
  const jump = Object.fromEntries(levels.map((s) => [s, 0]));
  let n = 0, crafts = 0, craftOff = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x, z] = pts[k], t1 = worlds.find(([s]) => s === 1)[1].waterColumn(x, z)?.water;
    if (t1 === undefined || t1 < 0) continue;
    n++;
    for (const [s, w] of worlds) {
      const t = w.waterColumn(x, z)?.water;
      if (t !== undefined && t >= 0) jump[s] = Math.max(jump[s], Math.abs(t - t1));
    }
    if (k % 512 === 0) { await need(x, z); crafts++; if (waterTop(c, x, z) !== t1) craftOff++; }
  }
  const worst = Math.max(...Object.values(jump));
  return { name: 'ship_top_levels', pass: n > 100 && worst === 0 && craftOff === 0,
    detail: { points: n, ...Object.fromEntries(levels.map((s) => [`jump_L${s}`, jump[s]])), crafts, craftOff } };
}

if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
