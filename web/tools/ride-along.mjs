// Riding along in another player's car on a touch screen, in headless Chrome (a page with touch, from a vite dev server
// of its own; the host, src/host/ws.ts on the real data, and the driver's client, Node's WebSocket, in this process).
// D takes the wheel of a car of the traffic standing by the cathedral; P walks up beside it, is offered a seat
// (nav/board.ts) and taps the button to ride along; a finger dragged across the screen turns P's view round the car
// (nav/nav.ts: a passenger has no drive sticks), as dragging does in a craft.
// usage (in web/): node tools/ride-along.mjs [-v] [--headed]; prints PASS/FAIL lines
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { imp } from './lib.mjs';
import { dataDir, web } from './data-dir.mjs';

if (!fs.existsSync(path.join(dataDir, 'meta.json'))) { console.log(`SKIP ride-along: no ${dataDir}/meta.json`); process.exit(0); }
const verbose = process.argv.includes('-v'), headed = process.argv.includes('--headed');
const { chromium } = createRequire(path.join(web, 'package.json'))('playwright-core');
const log = (...a) => { if (verbose) console.log(' ', ...a); };
const results = [];
const check = (ok, what) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms) => { for (const t = Date.now(); Date.now() - t < ms; await wait(100)) if (await ok()) return true; return false; };

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const { serve } = await imp('src/host/ws.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { SocketLink } = await imp('src/client/sim-worker-link.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { readHostData } = await imp('src/host/node.ts');
const { vehicleOf } = await imp('src/sim/vehicles.ts');
const host = serve({ dir: dataDir, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => log(`host: ${l}`) });
const hostPort = await host.port, sim = host.server.sim;
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-along-gate-'));
const vitePort = await freePort();
const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: web, env: { ...process.env, VOXEL_PUBLIC: path.dirname(dataDir), VOXEL_VITE_CACHE: cache, VITE_HOST_PORT: String(hostPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
process.on('exit', () => { vite.kill(); fs.rmSync(cache, { recursive: true, force: true }); });
let frames = null;
const done = (code) => { clearInterval(frames); host.close(); process.exit(code); };
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)) break;
  if (i > 300 || vite.exitCode !== null) { console.log(`FAIL ride-along: vite did not start\n${viteLog}`); done(1); }
  await wait(100);
}

const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };

// D: a client of the host's own (the page's client and link over Node's WebSocket), its frames on a timer
const link = new SocketLink(`ws://127.0.0.1:${hostPort}`);
const D = new MirrorSimClient(link, readHostData(dataDir).traffic, null, host.server.hello);
frames = setInterval(() => D.update(STEP), 1000 * STEP);
D.send({ kind: 'view', view: { focus: { x: dom.x, z: dom.y } } });
await until(() => D.player && sim.physics, 120000);
// (a car standing by the cathedral, with a seat beside the driver's)
let car = null;
await until(() => {
  const far = (c) => { const p = sim.entities.pose({ kind: 'car', id: c.id }); return p ? Math.hypot(p.x - dom.x, p.z - dom.y) : Infinity; };
  car = sim.traffic.cars.filter((c) => !c.bus && vehicleOf(c).id !== 'moto' && c.v < 0.1).sort((a, b) => far(a) - far(b))[0] ?? null;
  return car;
}, 60000);
const ref = car && { kind: 'car', id: car.id }, pose = () => sim.entities.pose(ref);
const side = (d) => { const p = pose(); return { x: p.x + Math.cos(p.h) * (0.9 + d), y: p.y, z: p.z - Math.sin(p.h) * (0.9 + d), h: p.h }; };
if (car) {
  const s = side(1);
  D.send({ kind: 'request', request: { kind: 'walk', pose: { x: s.x, y: s.y, z: s.z, h: 0, moving: false } } });
  await until(() => D.seat()?.role === 'walker', 5000);
  D.send({ kind: 'enterSeat', entity: ref, role: 'driver' });
  await until(() => D.seat()?.role === 'driver', 10000);
}
check(D.seat()?.role === 'driver', `D at the wheel of a car standing by the cathedral (${car && `${vehicleOf(car).id} ${car.id}`}, ${JSON.stringify(D.seat())})`);

// P: a page on a touch screen near it, on foot 1.5 m off its far side
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const at = pose() ?? { x: dom.x, y: 14, z: dom.y };
const cam = `${at.x + ox},${at.y + 40},${at.z + oz + 40},${at.x + ox},${at.y},${at.z + oz}`;
const Q = `server=ws://127.0.0.1:${hostPort}&cam=${cam}&crop=256&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0&weather=clear&hour=13`;
const ctx = await browser.newContext({ viewport: { width: 960, height: 640 }, hasTouch: true });
const P = await ctx.newPage();
P.on('pageerror', (e) => console.log(`  P page error: ${e.message}`));
await P.goto(`http://127.0.0.1:${vitePort}/?${Q}`);
await P.waitForFunction(() => window.__sim?.player && window.__crafts && window.__life?.group.visible, null, { timeout: 300000 });
const s = side(-2 * 0.9 - 1.5);
await P.evaluate((s) => { const T = window.__three; void T.nav.setWalk({ at: T.camera.position.clone().set(s.x, s.y, s.z), exact: true }); }, s);
const offered = await P.waitForFunction(() => window.__three.nav.onFoot && document.querySelector('#board-button:not([hidden])')?.textContent, null, { timeout: 60000 })
  .then((h) => h.jsonValue()).catch(() => null);
check(/^Ride along in /.test(offered ?? ''), `P on foot beside it is offered a seat beside D: ${JSON.stringify(offered)}`);
await P.tap('#board-button').catch(() => {});
const aboard = await P.waitForFunction(() => window.__sim.seat()?.role === 'passenger' && window.__three.nav.mode === 'ride' && window.__three.nav.ride, null, { timeout: 15000 })
  .then(() => true, () => false);
check(aboard, `a tap on it: P rides along in D's car (${JSON.stringify(await P.evaluate(() => ({ seat: window.__sim.seat(), mode: window.__three.nav.mode })))})`);

// a finger dragged across the screen: the view turns round the car
const cdp = await ctx.newCDPSession(P);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const before = await P.evaluate(() => window.__three.nav.ride?.dyaw ?? null);
await touch('touchStart', 300, 320);
for (let i = 1; i <= 10; i++) { await touch('touchMove', 300 + i * 30, 320); await wait(30); }
await touch('touchEnd');
const after = await P.evaluate(() => window.__three.nav.ride?.dyaw ?? null);
log(`dyaw ${before} -> ${after}`);
check(before !== null && after !== null && Math.abs(after - before) > 0.3, `a finger dragged across the screen turns P's view round the car (${before?.toFixed(2)} -> ${after?.toFixed(2)} rad)`);

await browser.close();
link.close?.();
const ok = results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} ride-along: ${results.filter(Boolean).length}/${results.length}`);
done(ok ? 0 : 1);
