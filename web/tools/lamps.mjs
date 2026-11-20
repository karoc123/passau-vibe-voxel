// The street lamps along the streets (src/streetlamps.ts placeStreetLamps, run in Node), placed from maps of the whole
// that the viewer no longer loads: which columns are buildings (data/zones.bin, zones.py), the trees' 2 m cells
// (data/foliage.bin, phenology.py), the ground's colours (data/terrain.bin, terrain.py). Writes public/data/streetlamps.json:
// { "lamps": [[x, y, ground], ...] } (metres, down to the centimetre), the viewer draws their light and heads.
// usage (in web/): node tools/lamps.mjs [data dir, default public/data] [pipeline data dir, default ../data]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] ?? path.join(web, 'public/data'));
const tmp = path.resolve(process.argv[3] ?? path.join(web, '../data'));
const { module: lamps } = await runnerImport(path.join(web, 'src/streetlamps.ts'), { root: web, logLevel: 'error' });

const json = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const gz = (f) => { const b = zlib.gunzipSync(fs.readFileSync(f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const { module: TP } = await runnerImport(path.join(web, 'src/sim/traffic-pack.ts'), { root: web, logLevel: 'error' });
const meta = json('meta.json'), traffic = TP.unpackTraffic(json('traffic.json'));
const buildings = new Uint16Array(gz(path.join(tmp, 'zones.bin')), 0, meta.W * meta.D);
const trees = new Uint8Array(gz(path.join(tmp, 'foliage.bin')), 0, (meta.W >> 1) * (meta.D >> 1));
const terrain = gz(path.join(tmp, 'terrain.bin'));
const placed = lamps.placeStreetLamps(meta, traffic.roads, traffic.peds, { buildings, trees, terrain });
const r = (v) => Math.floor(v * 100) / 100; // (down: a lamp keeps its metre, which picks its colour)
fs.writeFileSync(path.join(dir, 'streetlamps.json'), JSON.stringify({ lamps: placed.map(([x, y, z]) => [r(x), r(y), r(z)]) }));
console.log('street lamps placed:', placed.length);
