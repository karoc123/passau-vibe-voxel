// Not a tool: what the tools driving the Rapier car in the real city (public/data on disk) share -- rapier-car.mjs,
// surface-gap.mjs. The src modules (through vite's runner), the tiles as the car's terrain, the traffic roads.
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { dataDir } from './data-dir.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const DATA = `${dataDir}/`; // (VOXEL_DATA: a fixture's build, tools/data-dir.mjs)
export const load = (p) => runnerImport(`${root}src/${p}`, { root, logLevel: 'error' }).then((m) => m.module);
export const hasData = () => fs.existsSync(`${DATA}meta.json`) && fs.existsSync(`${DATA}traffic.json`);

let meta = null;
export const readMeta = () => (meta ??= JSON.parse(fs.readFileSync(`${DATA}meta.json`, 'utf8')));

// the tiles as terrainTile builds them (cached), with the decoded columns' ground
const tiles = new Map();
export async function realTile(tx, tz) {
  const k = `${tx}_${tz}`;
  if (!tiles.has(k)) {
    if (!fs.existsSync(`${DATA}tiles/1/${k}.bin`)) { tiles.set(k, null); return null; }
    const T = await load('physics/rapier/terrain.ts'), TD = await load('tile-data.ts');
    const N = readMeta().tiles.N, pal = T.terrainPalette(readMeta().palette);
    const read = (p) => zlib.gunzipSync(fs.readFileSync(`${DATA}tiles/${p}`)).buffer;
    tiles.set(k, T.terrainTile(N, TD.decodeTile(read(`1/${k}.bin`), N), TD.decodeTile(read(`1f/${k}.bin`), N), pal));
  }
  return tiles.get(k);
}

// the real city's tiles within `reach` m of the points (x, z), as scenarios.ts Sim takes them (Rapier initialised)
export async function realMap(points, reach) {
  const R = (await import('@dimforge/rapier3d-compat')).default;
  await R.init();
  const N = readMeta().tiles.N, want = new Set();
  for (const [x, z] of points) for (let tz = Math.floor((z - reach) / N); tz <= Math.floor((z + reach) / N); tz++) for (let tx = Math.floor((x - reach) / N); tx <= Math.floor((x + reach) / N); tx++) want.add(`${tx}_${tz}`);
  const out = [];
  for (const k of want) {
    const [tx, tz] = k.split('_').map(Number), tile = await realTile(tx, tz);
    if (tile) out.push({ tx, tz, tile });
  }
  return { meta: readMeta(), tiles: out };
}

// traffic.json's roads (p: [x, z, y] points)
let traffic = null;
export async function trafficRoads() {
  if (!traffic) traffic = (await load('sim/traffic-pack.ts')).unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'))).roads;
  return traffic;
}

// Road i of traffic.json as a path to follow: points every metre (x, z, y), from its far end if rev
// (lane: on its first lane's path as the traffic drives it, o0 m to the right of the road's line: sim/path.ts at)
export async function roadPath(i, rev = false, lane = false) {
  const sc = await load('physics/rapier/scenarios.ts'), r = (await trafficRoads())[i];
  let p = r.p.map((q) => [q[0], q[1], q[2]]);
  if (lane) {
    const { prepPath, at } = await load('sim/path.ts'), e = prepPath({ p }), P = { x: 0, y: 0, z: 0 }, q = [];
    for (let d = 0; d < e.L; d += 1) { at(e, d, r.o0, P); q.push([P.x, P.y, P.z]); }
    at(e, e.L, r.o0, P); q.push([P.x, P.y, P.z]);
    p = q;
  }
  if (rev) p.reverse();
  return sc.densify(p);
}

// Across the Schanzlbrücke, south to north along its carriageway (traffic roads 186, 570, 149, 660, 111 when it was
// drawn): the points in the project grid (map cells + meta.origin), so it holds whatever the map's extent; schanzlPath:
// in world metres, every metre
export const SCHANZL = [[1202, 459], [1205, 471], [1211, 489], [1215, 503], [1218, 515], [1223, 535], [1226, 549], [1229, 561], [1232, 576],
  [1235, 590], [1238, 602], [1242, 620], [1246, 634], [1247, 642], [1249, 651], [1252, 666], [1254, 678], [1257, 692], [1259, 702]];
export async function schanzlPath() {
  const sc = await load('physics/rapier/scenarios.ts');
  const [ox, oz] = readMeta().origin ?? [0, 0];
  return sc.densify(SCHANZL.map(([x, z]) => [x - ox, z - oz]));
}

// a tile's bytes (ungzipped) by its path under data/ tiles ('1/3_4.bin')
export const rawTile = (p) => { const b = zlib.gunzipSync(fs.readFileSync(`${DATA}tiles/${p}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// The World (src/world.ts) over the level-1 node files, read when first asked for, as the streamer holds them
// (stream.ts setData): W; its source (src.nodes: the nodes by '1/tx_ty', to put edited ones in, then src.version++);
// colData(tx, ty, columns): a node's columns as the source holds them (tools/life-edit.mjs, life-phys.mjs)
export async function nodeWorld() {
  const { World } = await load('world.ts'), TD = await load('tile-data.ts'), meta = readMeta(), N = meta.tiles.N, S = N + 2;
  const colData = (tx, ty, c) => {
    const off = new Uint32Array(S * S + 1);
    for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + c.counts[i];
    return { ...c, s: 1, x0: tx * N, y0: ty * N, S, off, roomOff: c.rooms ? TD.roomOffsets(c.rooms, S * S) : null };
  };
  const nodes = new Map();
  const src = { N, levels: [1], version: 0, nodes, columns(key) {
    if (!nodes.has(key)) {
      const t = key.split('/')[1], [tx, ty] = t.split('_').map(Number);
      nodes.set(key, fs.existsSync(`${DATA}tiles/1/${t}.bin`) ? colData(tx, ty, TD.decodeTile(rawTile(`1/${t}.bin`), N)) : undefined);
    }
    return nodes.get(key);
  } };
  return { W: new World(src, meta), src, colData };
}
