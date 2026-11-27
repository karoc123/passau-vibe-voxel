// What a node held by a TileCache costs, and a crater seen alike by the host and a client over their own caches.
// The page's sim worker holds ~40 level-1 nodes round a player on foot (~1 MB each before: the whole file and the
// shader's fields kept beside the columns), a network host up to its keep of 256; a phone's tab and a Pi pay it.
// 1. The nodes within R m of the cathedral acquired from a fresh cache: the array buffers they keep, per node, under
//    BOUND.
// 2. A host (host/node.ts, its world the cache's nodes) and a client (MirrorSimClient over its own cache and edits, as
//    the page): the client's crater by the cathedral is in both live edits, the same columns, air where the files had
//    ground, and gone from neither cache's view.
// usage (in web/): node tools/tile-memory.mjs; prints PASS with the numbers, or FAIL
import v8 from 'node:v8';
import vm from 'node:vm';
import { DATA, hasData, load } from './real-city.mjs';
import { sessionLink } from './lib.mjs';

if (!hasData()) { console.log(`SKIP tile-memory: no ${DATA}meta.json / traffic.json`); process.exit(0); }
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const R = 300, BOUND = 650e3; // (measured 1090 kB before, ~560 kB after)
const { nodeHost, readHostData, nodeTileCache } = await load('host/node.ts');
const { LiveEdits } = await load('core/live-edits.ts');
const { MirrorSimClient } = await load('client/sim-client.ts');
const { hello } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const { frameOf, mapToGrid, cellToAbsZ } = await load('core/layers.ts');
const { STEP } = await load('sim/road-net.ts');
const data = readHostData(DATA), N = data.meta.tiles.N, spot = data.meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const fail = [];

// 1.
const nodes = [];
for (let ty = Math.floor((spot.y - R) / N); ty <= Math.floor((spot.y + R) / N); ty++)
  for (let tx = Math.floor((spot.x - R) / N); tx <= Math.floor((spot.x + R) / N); tx++) nodes.push([tx, ty]);
gc();
const before = process.memoryUsage().arrayBuffers, cache = nodeTileCache(DATA, N, new LiveEdits(), 0);
const got = (await Promise.all(nodes.map(([tx, ty]) => cache.acquire(tx, ty).then(() => 1, () => 0)))).reduce((a, b) => a + b, 0);
gc();
const perNode = (process.memoryUsage().arrayBuffers - before) / got;
if (!(got > 20)) fail.push(`only ${got} nodes read round the cathedral`);
if (!(perNode <= BOUND)) fail.push(`${(perNode / 1e3).toFixed(0)} kB held per node, over ${BOUND / 1e3}`);

// 2.
const server = nodeHost(DATA, { seed: 3, world: 'tiles', physics: { bodies: false }, edits: true }, data);
server.trackEdits();
const link = sessionLink(server.connect()), edits = new LiveEdits(), frame = frameOf(data.meta);
const mine = nodeTileCache(DATA, N, edits);
const client = new MirrorSimClient(link, structuredClone(data.traffic), null, hello(checkBuild(data.meta, () => {})), edits, { cache: mine, frame });
const files = nodeTileCache(DATA, N, new LiveEdits());
const frame0 = async () => { client.update(STEP); server.update(STEP); link.deliver(); await new Promise((r) => setImmediate(r)); };
client.send({ kind: 'view', view: { focus: { x: spot.x, z: spot.y }, viewer: { x: spot.x, z: spot.y, y: 30 } } });
await frame0();
const x = Math.floor(spot.x), z = Math.floor(spot.y), tx = Math.floor(x / N), ty = Math.floor(z / N);
const file = await files.acquire(tx, ty), S = N + 2, col = (z - ty * N + 1) * S + (x - tx * N + 1);
const groundZ = file.base.ground[col]; // (the column's ground, in the node's cells)
const [gc0, gr0] = mapToGrid(frame, x, z);
let hit = null;
client.edit({ kind: 'sphere', col: gc0, row: gr0, z: cellToAbsZ(frame, groundZ), r: 4, colour: 0 }).then((n) => { hit = n; }, (e) => fail.push(`the edit: ${e.message}`));
for (let f = 0; f < 300 && !(hit && hit.every(([a, b]) => edits.get(a, b))); f++) await frame0();
let same = 0;
if (!hit?.length) fail.push('the crater not made');
else for (const [a, b] of hit) {
  const h = server.cache.edits.get(a, b), c = edits.get(a, b), hv = server.cache.view(a, b), cv = mine.view(a, b);
  if (!h || !c) { fail.push(`node ${a}_${b}: in the host's edits ${!!h}, the client's ${!!c}`); continue; }
  const eq = (p, q) => p.length === q.length && p.every((v, i) => v === q[i]);
  if (!eq(h.base.counts, c.base.counts) || !eq(h.base.runs, c.base.runs)) fail.push(`node ${a}_${b}: the host's and the client's columns differ`);
  else same++;
  if (!hv?.edited) fail.push(`node ${a}_${b}: the host's cache does not see it`);
  if (!cv?.edited) fail.push(`node ${a}_${b}: the client's cache does not see it`);
}
const h = hit?.length ? server.cache.edits.get(tx, ty) : null;
if (h && !(h.base.ground[col] < groundZ || h.base.counts[col] !== file.base.counts[col])) fail.push(`the crater's middle as in the file: ground ${groundZ}, ${file.base.counts[col]} runs`);
server.dispose?.();

const line = `${got} nodes round the cathedral, ${(perNode / 1e3).toFixed(0)} kB held per node (bound ${BOUND / 1e3}; ~40 on foot: ${(perNode * 40 / 1e6).toFixed(0)} MB); a client's crater in ${same}/${hit?.length ?? 0} node(s), the same columns on both sides`;
console.log(fail.length ? `FAIL tile-memory: ${fail.join('; ')}\n  (${line})` : `PASS tile-memory: ${line}`);
process.exit(fail.length ? 1 : 0);
