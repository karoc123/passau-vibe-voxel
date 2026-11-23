// The player's boat (src/sim/craft/boat-motion.ts) headless: checks/boat-checks.ts. On a synthetic world served as real node
// files (a channel, a bridge, a footbridge too low, a pier): top speed, coasting, turning and drifting, reverse, the
// bank and the pier bounced off, under the bridge, put in from the land, unstuck. Then, on the real data (public/data)
// if it is there: put in near the Altstadt facing downstream and a minute's lap there, east under the Schanzlbrücke,
// north into the Danube's bank.
// usage: node tools/boat.mjs [--json]; exit code 1 if a check fails
import fs from 'node:fs';
import zlib from 'node:zlib';
import { load, DATA, hasData, readMeta } from './real-city.mjs';
import { imp } from './lib.mjs';

const m = await imp('checks/boat-checks.ts');
const out = await m.runBoatChecks();

if (hasData() && fs.existsSync(`${DATA}flood.json`)) {
  const { VoxelCollision } = await load('nav/voxel-collision.ts');
  const { TileCache } = await load('core/tile-cache.ts');
  const { Vector3 } = await import('three');
  const meta = readMeta(), N = meta.tiles.N;
  const cache = new TileCache({ N, load: async (p) => { const b = zlib.gunzipSync(fs.readFileSync(`${DATA}tiles/${p}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
  const c = new VoxelCollision(meta, cache);
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
  } finally {
    c.release();
  }
} else console.log('skip  real data             (no public/data)');

if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
