// The start menu, the Esc menu and the player's settings as two players on one host see them, in headless Chrome (the
// page from a vite dev server of its own, built as `./voxel start` builds it: VITE_HOST_PORT, the host's port; the
// host, src/host/ws.ts, in this process). A opens the page bare: the start menu shows, the server preselected; A gives
// a name there and plays on the server. B comes with ?server= (no start menu). A walks by the cathedral: Esc opens the
// menu and A stays on foot; B sees A's name on both maps and over A, not through a building; B, whose link holds each
// message LAG ms each way, shows a ping of that round trip, A one near none, a page alone none at all; B's frame cap at
// 30 holds the frames near 30; A's menu's Back to orbit mode takes A up to orbit mode. A page alone, hidden (its tab
// in the background, emulated: headless Chrome keeps every page shown), holds its world still and goes on from there
// when shown again.
// usage (in web/): node tools/menu.mjs [-v] [--headed]; prints PASS/FAIL lines
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { imp } from './lib.mjs';
import { dataDir, web } from './data-dir.mjs';

if (!fs.existsSync(path.join(dataDir, 'meta.json'))) { console.log(`SKIP menu: no ${dataDir}/meta.json`); process.exit(0); }
const verbose = process.argv.includes('-v'), headed = process.argv.includes('--headed');
const { chromium } = createRequire(path.join(web, 'package.json'))('playwright-core');
const log = (...a) => { if (verbose) console.log(' ', ...a); };
const results = [];
const check = (ok, what) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
// (a made-up name: no one's)
const NAME = 'Testerin 7';

// each way, ms: B's round trip 2 LAG more than A's
const LAG = 60;

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const { serve } = await imp('src/host/ws.ts');
const host = serve({ dir: dataDir, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => log(`host: ${l}`) });
const hostPort = await host.port;
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-gate-'));
const vitePort = await freePort();
const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: web, env: { ...process.env, VOXEL_PUBLIC: path.dirname(dataDir), VOXEL_VITE_CACHE: cache, VITE_HOST_PORT: String(hostPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
process.on('exit', () => { vite.kill(); fs.rmSync(cache, { recursive: true, force: true }); });
let lagged = null;
const done = (code) => { host.close(); lagged?.close(); process.exit(code); };
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)) break;
  if (i > 300 || vite.exitCode !== null) { console.log(`FAIL menu: vite did not start\n${viteLog}`); done(1); }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const cam = `${dom.x - 40 + ox},70,${dom.y - 10 + oz + 60},${dom.x - 40 + ox},14,${dom.y - 10 + oz}`;
const Q = `cam=${cam}&crop=256&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0&weather=clear&hour=13`;
const server = `ws://127.0.0.1:${hostPort}`;
// B's link: each message held LAG ms, in order, both ways
const { WebSocketServer, WebSocket } = createRequire(path.join(web, 'package.json'))('ws');
lagged = new WebSocketServer({ host: '127.0.0.1', port: 0 });
lagged.on('connection', (down) => {
  const up = new WebSocket(server), early = [];
  const later = (to, d) => setTimeout(() => { if (to.readyState === WebSocket.OPEN) to.send(d.toString()); else if (to === up) early.push(d); }, LAG);
  up.on('open', () => { for (const d of early.splice(0)) up.send(d.toString()); });
  up.on('message', (d) => later(down, d));
  down.on('message', (d) => later(up, d));
  up.on('close', () => setTimeout(() => down.close(), LAG));
  down.on('close', () => setTimeout(() => up.close(), LAG));
  up.on('error', () => {});
  down.on('error', () => {});
});
await new Promise((ok) => lagged.on('listening', ok));
const bServer = `ws://127.0.0.1:${lagged.address().port}`;
// (the page's side of a hidden tab: document.hidden and visibilitychange, no frames)
const HIDE = () => {
  let hidden = false;
  const raf = window.requestAnimationFrame.bind(window), held = [];
  window.requestAnimationFrame = (f) => (hidden ? (held.push(f), 0) : raf(f));
  window.__hide = (on) => {
    hidden = on;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => on });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (on ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
    if (!on) for (const f of held.splice(0)) raf(f);
  };
};
const page = async (name, q, hide = false) => {
  // (each its own context: its own storage, as two people's browsers)
  const p = await (await browser.newContext({ viewport: { width: 960, height: 640 } })).newPage();
  if (hide) await p.addInitScript(HIDE);
  p.on('pageerror', (e) => console.log(`  ${name} page error: ${e.message}`));
  // (the dev server's modules, served to pages of every gate at once, can take longer than playwright's 30 s)
  await p.goto(`http://127.0.0.1:${vitePort}/?${q}`, { timeout: 300000 });
  return p;
};
const loaded = (p) => p.waitForFunction(() => window.__map && window.__sim?.player && window.__crafts && window.__life?.group.visible, null, { timeout: 300000 });

// A: the start menu, the server preselected; a name given there
const A = await page('A', Q);
await A.waitForSelector('#start-menu', { timeout: 60000 });
const start = await A.evaluate(() => ({
  pre: document.querySelector('#start-menu [data-preselected]')?.textContent,
  addr: document.querySelector('#start-menu input[name=server]')?.value,
}));
check(start.pre === 'Play on the server' && start.addr === server, `the start menu shows, the server preselected: ${JSON.stringify(start)}`);
await A.fill('#start-menu input[name=name]', `  ${NAME}‮  `);
await A.locator('#start-menu input[name=name]').dispatchEvent('change');
await A.click('#start-menu [data-preselected]');
const B = await page('B', `server=${bServer}&${Q}`);
check(!(await B.$('#start-menu')), 'with ?server= the start menu is skipped');
await Promise.all([loaded(A), loaded(B)]);
const [pa, pb] = await Promise.all([A, B].map((p) => p.evaluate(() => window.__sim.player)));
check(pa && pb && pa !== pb, `A (${pa}) and B (${pb}) on the server`);

// Esc on foot: the menu, still on foot
await A.evaluate(() => window.__three.nav.toggleWalk(false));
await A.waitForFunction(() => window.__three.nav.onFoot, null, { timeout: 60000 });
await A.keyboard.press('Escape');
await A.waitForTimeout(800);
const esc = await A.evaluate(() => ({ open: window.__menu.menu.isOpen(), mode: window.__three.nav.mode }));
check(esc.open && esc.mode === 'walk', `Esc on foot opens the menu and does not fly up: ${JSON.stringify(esc)}`);
await A.click('#menu >> text=Resume');
check(!(await A.evaluate(() => window.__menu.menu.isOpen())), 'Resume closes the menu');

// the name: over A, and by A's dot on B's full map (B in orbit mode: no minimap)
const tag = await B.waitForFunction((who) => window.__menu.tags.shown()[who], pa, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
check(tag === NAME, `B sees A's name, cleaned, over A: ${JSON.stringify(tag)}`);
await B.keyboard.press('Comma');
const full = await B.waitForFunction((who) => window.__map.full.drawnOthers.find((o) => o.player === who)?.label, pa, { timeout: 10000 })
  .then((h) => h.jsonValue()).catch(() => null);
check(full === NAME, `and by A's dot on the full map: ${full}`);
// (Esc closes the full map first, not opening the menu)
await B.keyboard.press('Escape');
await B.waitForTimeout(400);
check(!(await B.evaluate(() => window.__map.full.isOpen || window.__menu.menu.isOpen())), 'Esc closes the full map, the menu stays shut');

// A's name behind a building: B's camera put 70 m from A, once where the voxels stand between it and A's tag (the
// first more than 5 m before it), once where nothing does; the name shown only in the open
const spots = await B.evaluate((who) => {
  const w = window.__three.nav.world, a = window.__life.avatarsDrawn().find((o) => o.player === who)?.pose;
  if (!w || !a) return null;
  const out = { hidden: null, open: null };
  for (let k = 0; k < 64 && !(out.hidden && out.open); k++) {
    const t = (k / 64) * 2 * Math.PI, x = a.x + 70 * Math.sin(t), z = a.z + 70 * Math.cos(t), c = { x, y: w.groundAt(x, z) + 12, z };
    const d = { x: a.x - c.x, y: a.y + 2.4 - c.y, z: a.z - c.z }, L = Math.hypot(d.x, d.y, d.z);
    const hit = w.raycast(c, { x: d.x / L, y: d.y / L, z: d.z / L }, L);
    if (w.solid(Math.floor(c.x), Math.floor(c.z), Math.floor(c.y))) continue;
    if (!out.hidden && hit < L - 20 && hit > 10) out.hidden = c;
    if (!out.open && hit >= L) out.open = c;
  }
  return { ...out, a: { x: a.x, y: a.y, z: a.z } };
}, pa);
const lookFrom = async (c) => {
  await B.evaluate(({ c, a }) => {
    const T = window.__three;
    T.camera.position.set(c.x, c.y, c.z);
    T.controls.target.set(a.x, a.y + 1.5, a.z);
    T.controls.update();
  }, { c, a: spots.a });
  // the camera at rest after the map's own clamps, then a frame drawn there (the tags are set in the frame: headless
  // under load draws a few a second, and a fixed wait read them from where the camera was before)
  await B.evaluate(() => new Promise((done) => {
    const c = window.__three.camera.position, was = c.clone();
    let still = 0, n = 0;
    const frame = () => {
      still = c.distanceTo(was) < 1e-3 ? still + 1 : 0;
      was.copy(c);
      if (still >= 3 || ++n > 90) done(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  // (where the camera is after the map's own clamps, and what lies between it and the tag from there)
  return B.evaluate(({ who, a }) => {
    const T = window.__three, w = T.nav.world, c = T.camera.position;
    const d = { x: a.x - c.x, y: a.y + 2.4 - c.y, z: a.z - c.z }, L = Math.hypot(d.x, d.y, d.z);
    return { shown: !!window.__menu.tags.shown()[who], hit: w.raycast(c, { x: d.x / L, y: d.y / L, z: d.z / L }, L), L, at: [c.x, c.y, c.z].map(Math.round) };
  }, { who: pa, a: spots.a });
};
const behind = spots?.hidden && await lookFrom(spots.hidden), open = spots?.open && await lookFrom(spots.open);
log(`tag behind ${JSON.stringify(behind)}, in the open ${JSON.stringify(open)}`);
check(behind && open && behind.hit < behind.L - 5 && !behind.shown && open.hit >= open.L - 1 && open.shown,
  `A's name hidden behind a building (${behind && `a voxel ${(behind.L - behind.hit).toFixed(0)} m before the tag, shown ${behind.shown}`}), shown in the open (${open?.shown})`);

// the pings shown: B's the round trip its link holds the messages (and A's), A's near none; read after 5 pings each
// (the median shown) and some seconds of play
const shown = (p) => p.waitForFunction(() => /^\d+ ms ping$/.test(document.querySelector('#perf .ping')?.textContent ?? '') && document.querySelector('#perf .ping').textContent, null, { timeout: 15000 })
  .then((h) => h.jsonValue()).then((t) => +t.split(' ')[0]).catch(() => null);
await B.waitForTimeout(10000);
const [pingA, pingB] = await Promise.all([shown(A), shown(B)]);
// (B's lower bound its own link's, not A's plus it: each page's ping carries its own busy frames, A's under load ~30 ms
// one run and B's ~10, and a difference of the two failed a ping that held the whole link)
check(pingA !== null && pingB !== null && pingA < 40 && pingB >= 2 * LAG - 5 && pingB - pingA <= 2 * LAG + 30,
  `the ping shown is the socket's round trip: B over a link of ${2 * LAG} ms more shows ${pingB} ms, A ${pingA} ms`);
const C = await page('C', `play&${Q}`, true);
const alone = await C.waitForFunction(() => document.querySelector('#perf .ping')?.textContent, null, { timeout: 60000 }).then((h) => h.jsonValue()).catch(() => null);
check(alone === 'alone, no ping', `a page alone shows no number: ${alone}`);
// hidden 2 s: the world's ticks (30 a second) stop; shown 1 s: about 30 more from there (how far behind the page
// draws them is its frame rate's: a few frames a second under the other gates)
await C.waitForFunction(() => window.__sim?.tick > 30, null, { timeout: 60000 }).catch(() => {});
const ticks = () => C.evaluate(() => ({ tick: window.__sim.tick }));
await C.evaluate(() => window.__hide(true));
await C.waitForTimeout(300);
const h0 = await ticks();
await C.waitForTimeout(2000);
const h1 = await ticks();
await C.evaluate(() => window.__hide(false));
await C.waitForTimeout(1000);
const h2 = await ticks();
log(`C hidden: ${JSON.stringify([h0, h1, h2])}`);
check(h1.tick - h0.tick <= 1 && h2.tick - h1.tick >= 15 && h2.tick - h1.tick <= 45,
  `a page alone, hidden 2 s, holds its world (${h1.tick - h0.tick} ticks) and goes on when shown (${h2.tick - h1.tick} ticks in 1 s)`);
await C.context().close();

// the frame cap in the loop itself (app/frame.ts), with a display's frames made up: a headless GPU draws too few
// frames to show it on the page
const { frameLoop } = await imp('src/app/frame.ts');
const drawn = (hz, cap) => {
  let n = 0;
  const step = () => {}, loop = frameLoop({ input: () => n++, sim: step, poses: step, cameras: step, cameraReaders: step, render: step }, 0, () => cap);
  for (let i = 0; i < hz * 10; i++) loop(i * 1000 / hz + Math.sin(i) * 0.6);
  return n / 10;
};
const rates = [[60, 30], [60, 60], [144, 60], [144, 30], [120, 0]].map(([hz, cap]) => [hz, cap, drawn(hz, cap)]);
check(rates.every(([hz, cap, r]) => Math.abs(r - (cap || hz)) <= 1.5), `the frame cap drops frames by their time to near the cap (display Hz, cap, frames a second): ${JSON.stringify(rates)}`);

// B's frame cap, set in the menu's settings
const fps = () => B.waitForTimeout(3000).then(() => B.evaluate(() => window.__menu.fps()));
// (Esc a moment after the menu opened is taken as the one that opened it: menu.ts)
const setCap = async (v) => {
  await B.keyboard.press('Escape');
  await B.waitForSelector('#menu:not([hidden])');
  if (!(await B.evaluate(() => document.querySelector('#menu details').open))) await B.click('#menu summary');
  await B.selectOption('#menu select[name=fps]', v);
  await B.waitForTimeout(400);
  await B.keyboard.press('Escape');
};
await setCap('0');
const free = await fps();
await setCap('30');
const capped = await fps();
const kept = await B.evaluate(() => JSON.parse(localStorage.getItem('passau.player')).fps);
log(`B: ${free} fps without a cap, ${capped} with 30`);
check(capped <= 33 && (free < 36 || capped >= 25) && kept === 30, `a frame cap of 30 holds the frames near 30 (${capped} fps; ${free} without), remembered`);

// Back to orbit mode
await A.keyboard.press('Escape');
await A.click('#menu >> text=Back to orbit mode');
await A.waitForTimeout(500);
const back = await A.evaluate(() => ({ mode: window.__three.nav.mode, open: window.__menu.menu.isOpen() }));
check(back.mode === 'orbit' && !back.open, `the menu's Back to orbit mode: ${JSON.stringify(back)}`);

await browser.close();
const ok = results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} menu: ${results.filter(Boolean).length}/${results.length}`);
done(ok ? 0 : 1);
