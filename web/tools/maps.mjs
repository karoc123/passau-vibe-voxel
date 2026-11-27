// The maps and the waypoint as two players on one host see them, in headless Chrome (the page from a vite dev server
// of its own, the host, src/host/ws.ts, in this process; both on free ports): A walks near the cathedral, B sails a
// boat on the Danube ~150 m off. On A: , opens the full map; a click at its middle sets the waypoint where A stands, a
// click on the minimap a quarter of its width right of the middle sets it 280 m east (the minimap reaches 560 m to each
// edge), the distance at the top says so; the full map dragged, then a click where A's marker went lands on A again,
// zoomed there by the wheel a click on the waypoint clears it; Backspace clears it too. Each page's minimap and full
// map draw the other player, labelled, where they are.
// usage (in web/): node tools/maps.mjs [-v] [--headed]; prints PASS/FAIL lines
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { imp } from './lib.mjs';
import { dataDir, web } from './data-dir.mjs';

if (!fs.existsSync(path.join(dataDir, 'meta.json'))) { console.log(`SKIP maps: no ${dataDir}/meta.json`); process.exit(0); }
const verbose = process.argv.includes('-v'), headed = process.argv.includes('--headed');
const { chromium } = createRequire(path.join(web, 'package.json'))('playwright-core');
const log = (...a) => { if (verbose) console.log(' ', ...a); };
const results = [];
const check = (ok, what) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const { serve } = await imp('src/host/ws.ts');
const host = serve({ dir: dataDir, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => log(`host: ${l}`) });
const hostPort = await host.port;
// (vite's own dep cache: not the one of the dev server running beside it)
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'maps-gate-'));
const vitePort = await freePort();
const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: web, env: { ...process.env, VOXEL_PUBLIC: path.dirname(dataDir), VOXEL_VITE_CACHE: cache }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
// (also when a wait throws: the dev server and its cache not left behind)
process.on('exit', () => { vite.kill(); fs.rmSync(cache, { recursive: true, force: true }); });
const done = (code) => { host.close(); process.exit(code); };
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)) break;
  if (i > 300 || vite.exitCode !== null) { console.log(`FAIL maps: vite did not start\n${viteLog}`); done(1); }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
// grid (?cam=) = world + origin; the cathedral's square and the Danube below it
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const BOAT = { x: 8160.5, z: 2880.5, h: 1.8 };
const camAt = (x, z) => `${x + ox},70,${z + oz + 60},${x + ox},14,${z + oz}`;
const open = async (name, cam) => {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', (e) => console.log(`  ${name} page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?server=ws://127.0.0.1:${hostPort}&cam=${cam}&crop=256&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0&weather=clear&hour=13`);
  await page.waitForFunction(() => window.__map && window.__sim?.player && window.__crafts && window.__life?.group.visible, null, { timeout: 300000 });
  return page;
};
const [A, B] = await Promise.all([open('A', camAt(dom.x - 40, dom.y - 10)), open('B', camAt(BOAT.x, BOAT.z))]);
log('both pages loaded');
await A.evaluate(() => window.__three.nav.toggleWalk(false));
await A.waitForFunction(() => window.__three.nav.onFoot, null, { timeout: 60000 }).catch(async (e) => {
  console.log(await A.evaluate(() => { const n = window.__three.nav; return JSON.stringify({ mode: n.mode, onFoot: n.onFoot, pending: n.walkPending, entering: n.enteringWalk, t: n.controls.target }); }));
  throw e;
});
await B.evaluate((at) => window.__crafts.find((c) => c.id === 'boat').enter(at), BOAT);
await B.waitForFunction(() => window.__sim.craftOf()?.placed, null, { timeout: 60000 });
await A.waitForTimeout(1500);
const [pa, pb] = await Promise.all([A, B].map((p) => p.evaluate(() => window.__sim.player)));
log(`A is ${pa}, B is ${pb}`);

const pose = (page) => page.evaluate(() => { const p = window.__three.nav.mapPose(); return { x: p.x, z: p.z }; });
const wp = (page) => page.evaluate(() => window.__map.waypoint.at);
// two frames drawn from now: the chip and the full map are drawn in the frame after a change, and headless under load
// draws a few frames a second, so no fixed wait covers it (the chip of the waypoint before was read stale)
const drawn = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const chipNow = (page) => page.evaluate(() => { const c = document.querySelector('#waypoint-chip'); return c && !c.hidden ? c.querySelector('.d').textContent : null; });
const chip = async (page) => { await drawn(page); return chipNow(page); };
const metres = (t) => (t?.endsWith(' km') ? parseFloat(t) * 1000 : parseFloat(t));
const off = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity);
const box = (page, sel) => page.locator(sel).boundingBox();

// the full map: , opens it; a click at its middle: the waypoint where A stands
await A.keyboard.press('Comma');
const shown = await A.isVisible('#fullmap');
check(shown, `, opens the full map`);
if (!shown) { await browser.close(); done(1); }
await A.waitForTimeout(300);
const fm = await box(A, '#fullmap .marks'), mid = { x: fm.x + fm.width / 2, y: fm.y + fm.height / 2 };
let me = await pose(A);
await A.mouse.click(mid.x, mid.y);
await A.waitForTimeout(200);
let w = await wp(A);
check(off(w, me) < 3, `a click at the full map's middle sets the waypoint where A stands (${off(w, me).toFixed(1)} m off)`);
let d = await chip(A);
check(d !== null && metres(d) < 5, `the distance shown: ${d}`);

// dragged by (-220, -130) px: A's marker there; a click on it: the waypoint on A again (first cleared: it is there)
await A.keyboard.press('Backspace');
await drawn(A);
check(!(await wp(A)) && (await chipNow(A)) === null, 'Backspace clears the waypoint (and its distance)');
await A.mouse.move(mid.x, mid.y);
await A.mouse.down();
await A.mouse.move(mid.x - 110, mid.y - 65, { steps: 5 });
await A.mouse.move(mid.x - 220, mid.y - 130, { steps: 5 });
await A.mouse.up();
await A.waitForTimeout(200);
check(!(await wp(A)), 'a drag sets no waypoint');
me = await pose(A);
const at = { x: mid.x - 220, y: mid.y - 130 };
await A.mouse.click(at.x, at.y);
await A.waitForTimeout(200);
w = await wp(A);
check(off(w, me) < 3, `dragged, a click on A's marker sets the waypoint on A (${off(w, me).toFixed(1)} m off)`);
// zoomed in there by the wheel (the point under the cursor stays): a click on it clears it
for (let i = 0; i < 4; i++) { await A.mouse.wheel(0, -300); await A.waitForTimeout(50); }
await A.waitForTimeout(200);
await A.mouse.click(at.x, at.y);
await A.waitForTimeout(200);
check(!(await wp(A)), 'zoomed in, a click on the waypoint clears it');
await A.mouse.click(at.x + 40, at.y);
await A.waitForTimeout(200);
w = await wp(A);
const s = await A.evaluate(() => { const f = window.__map.full; return f.toScreen(1, 0).sx - f.toScreen(0, 0).sx; });
check(w && Math.abs(w.x - me.x - 40 / s) < 3 && Math.abs(w.z - me.z) < 3, `zoomed in (${s.toFixed(2)} px/m), a click 40 px right of A: ${(w ? w.x - me.x : NaN).toFixed(1)} m east (${(40 / s).toFixed(1)} expected)`);
await A.keyboard.press('Escape');
check(!(await A.isVisible('#fullmap')) && (await A.evaluate(() => window.__three.nav.onFoot)), 'Esc closes the full map (A still on foot)');

// the minimap (M): a click a quarter of its width right of its middle: 280 m east of A
await A.keyboard.press('KeyM');
await A.waitForFunction(() => window.__map.minimap.last, null, { timeout: 30000 });
const mm = await box(A, '#minimap canvas');
me = await pose(A);
// (at whole pixels, the event's; the minimap's pixel is ~5 m: the metres expected from the pixel clicked)
const cx = Math.round(mm.x + mm.width * 0.75), cy = Math.round(mm.y + mm.height / 2), mPerPx = 560 / (mm.width / 2);
const east = (cx - mm.x - mm.width / 2) * mPerPx, south = (cy - mm.y - mm.height / 2) * mPerPx;
await A.mouse.click(cx, cy);
await A.waitForTimeout(300);
w = await wp(A);
check(w && Math.abs(w.x - me.x - east) < 3 && Math.abs(w.z - me.z - south) < 3, `a click on the minimap a quarter of its width right of A sets the waypoint ${east.toFixed(1)} m east, ${south.toFixed(1)} m south: ${w ? `${(w.x - me.x).toFixed(1)} m east, ${(w.z - me.z).toFixed(1)} m south` : 'none'}`);
d = await chip(A);
check(d !== null && Math.abs(metres(d) - off(w, me)) < 4, `the distance shown: ${d} (${off(w, me).toFixed(0)} m)`);
// (the full map, opened again, marks it too)
await A.click('#minimap .map-expand');
await drawn(A);
const pin = await A.evaluate(() => { const { full, waypoint } = window.__map; return full.toScreen(waypoint.at.x, waypoint.at.z); });
const pinPx = await A.evaluate(({ sx, sy }) => {
  const c = document.querySelector('#fullmap .marks'), k = c.width / c.clientWidth;
  return [...c.getContext('2d').getImageData(Math.round(sx * k), Math.round((sy - 18) * k), 1, 1).data];
}, pin);
check(pinPx[0] > 200 && pinPx[1] < 120 && pinPx[2] > 160, `the minimap's expand button opens the full map, the waypoint's pin on it (rgb ${pinPx.slice(0, 3)})`);

// the other player on both maps of both pages, labelled, where they are
const sees = async (page, name, other, otherPage) => {
  await page.waitForFunction((who) => [window.__map.minimap, window.__map.full].every((m) => m.drawnOthers.some((o) => o.player === who)), other, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  const there = await pose(otherPage);
  const r = await page.evaluate((who) => {
    const { minimap, full } = window.__map, c = document.querySelector('#fullmap .marks'), k = c.width / c.clientWidth;
    const f = full.drawnOthers.find((o) => o.player === who), m = minimap.drawnOthers.find((o) => o.player === who);
    const px = f ? [...c.getContext('2d').getImageData(Math.round(f.sx * k), Math.round(f.sy * k), 1, 1).data] : null;
    return { f, m, px, me: window.__sim.player };
  }, other);
  const want = await page.evaluate(({ x, z }) => window.__map.full.toScreen(x, z), there);
  const offPx = r.f ? Math.hypot(r.f.sx - want.sx, r.f.sy - want.sy) : Infinity;
  check(!!r.m, `${name}'s minimap marks ${other}`);
  check(!!r.f && offPx < 12 && r.px[2] > 200 && r.px[0] < 150, `${name}'s full map marks ${other} where they are (${offPx.toFixed(1)} px off, rgb ${r.px?.slice(0, 3)})`);
};
await sees(A, 'A', pb, B);
await B.keyboard.press('KeyM');
await B.keyboard.press('Comma');
await sees(B, 'B', pa, A);
check(!(await wp(B)), 'the waypoint is the page\'s own: B has none');

await browser.close();
const ok = results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} maps: ${results.filter(Boolean).length}/${results.length}`);
done(ok ? 0 : 1);
