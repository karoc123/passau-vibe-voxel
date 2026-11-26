#!/usr/bin/env node
// What lies at a place: its project-grid and map coordinates, its 1024 m block and whether that is built, its tile
// node, and the nearest OSM names. Answers an owner's "here is a hole at x,y,z" or "is the Tierheim on the map".
//   node tools/where.mjs 25,1713          # project grid (?cam= and the HUD's voxel), x,z or x,y,z
//   node tools/where.mjs Tierheim         # OSM names containing the text (case-insensitive), up to 8
// Reads public/data/meta.json (VOXEL_DATA) and data/raw/osm.json (the main checkout's when a worktree has none).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { web, dataDir } from './data-dir.mjs';

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) { console.error('usage: node tools/where.mjs X,Z | X,Y,Z | NAME'); process.exit(2); }
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8'));
const [ox, oz] = meta.origin;
const { x0, y0 } = meta.world.grid;
const BLOCK = 1024, NODE = meta.tiles.N;

// a worktree has no data/raw (not in git): the main checkout's is the same
function osmFile() {
  const own = path.join(web, '../data/raw/osm.json');
  if (fs.existsSync(own)) return own;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: web, encoding: 'utf8' }).trim();
  return path.join(path.dirname(common), 'data/raw/osm.json');
}

// WGS84 to UTM zone 32 (EPSG:25832; ETRS89 and WGS84 agree well under a metre here), Snyder's series
function utm32(lon, lat) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const φ = lat * Math.PI / 180, λ = (lon - 9) * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(φ) ** 2), T = Math.tan(φ) ** 2, C = ep2 * Math.cos(φ) ** 2, A = Math.cos(φ) * λ;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * φ - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * φ)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * φ) - (35 * e2 ** 3 / 3072) * Math.sin(6 * φ));
  const E = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const Nn = k0 * (M + N * Math.tan(φ) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [E, Nn];
}
const toGrid = (lon, lat) => { const [E, N] = utm32(lon, lat); return [E - x0, y0 - N]; };

// every named OSM element at its points' mean, in project grid
function named() {
  const els = JSON.parse(fs.readFileSync(osmFile(), 'utf8')).elements;
  const out = [];
  for (const e of els) {
    const name = e.tags?.name;
    if (!name || e.tags.type === 'route') continue; // a bus line's middle lies nowhere
    const pts = (e.type === 'node' ? [e] : e.geometry ?? e.members?.flatMap((m) => m.geometry ?? []) ?? []).filter(Boolean);
    if (!pts.length) continue;
    let sx = 0, sz = 0;
    for (const p of pts) { const [x, z] = toGrid(p.lon, p.lat); sx += x; sz += z; }
    out.push({ name, kind: `${e.type} ${e.id}`, x: sx / pts.length, z: sz / pts.length });
  }
  return out;
}

function describe(gx, gz) {
  const mx = gx - ox, mz = gz - oz;
  const onMap = mx >= 0 && mz >= 0 && mx < meta.W && mz < meta.D;
  const box = (meta.built ?? []).find((b) => Math.floor(b[0] / BLOCK) === Math.floor(mx / BLOCK) && Math.floor(b[1] / BLOCK) === Math.floor(mz / BLOCK));
  const built = onMap && (!meta.built || (!!box && mx >= box[0] && mz >= box[1] && mx < box[2] && mz < box[3]));
  console.log(`  project grid ${gx.toFixed(0)},${gz.toFixed(0)}  map ${mx.toFixed(0)},${mz.toFixed(0)}  block col ${Math.floor(gx / BLOCK)} row ${Math.floor(gz / BLOCK)}`
    + `  ${!onMap ? 'OFF the map' : built ? 'built' : `NOT built${box ? ` (block built only to map row ${box[3]})` : ''}`}`
    + (onMap ? `  node tiles/1/${Math.floor(mx / NODE)}_${Math.floor(mz / NODE)}.bin` : ''));
}

const nums = arg.split(/[ ,]+/).map(Number);
if (nums.length >= 2 && nums.every(Number.isFinite)) {
  const [gx, gz] = nums.length === 2 ? nums : [nums[0], nums[2]];
  describe(gx, gz);
  const near = named().map((o) => ({ ...o, d: Math.hypot(o.x - gx, o.z - gz) })).sort((a, b) => a.d - b.d).slice(0, 5);
  for (const o of near) console.log(`  ${o.d.toFixed(0).padStart(5)} m  ${o.name} (${o.kind})`);
} else {
  const q = arg.toLowerCase();
  const hits = named().filter((o) => o.name.toLowerCase().includes(q));
  if (!hits.length) { console.log(`no OSM name contains "${arg}"`); process.exit(1); }
  for (const o of hits.slice(0, 8)) { console.log(`${o.name} (${o.kind})`); describe(o.x, o.z); }
  if (hits.length > 8) console.log(`(${hits.length - 8} more)`);
}
