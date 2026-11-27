#!/usr/bin/env node
// What hollow ground floors cost in the page (docs/plans/building-looks.md), on a data dir scripts/halls.py wrote (or
// the committed one, as the baseline). In the page (its own vite dev server over that dir, headless Chrome; the street
// life hidden, it varies from run to run): on foot at spots by the halls of halls.json (the street before a door facing
// it, and inside), for each the triangles and draw calls of one render of the scene, then the frame time with the
// drawing left out (software GL here: the page's own work per frame, as fly-stream.mjs measures it) standing and
// walking; and whether the walker walks in through each door of the first --walk halls (W held from the street
// before it: in the room after, world inRoom).
// usage (in web/): node tools/halls-probe.mjs --public DIR/ (the dir holding data/) --halls DIR/halls.json [--phone]
//                  [--port 5264] [--spots 3] [--walk 20] [--secs 8] [--occ] [--json FILE]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { web } from './data-dir.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PHONE = args.includes('--phone'), SECS = +opt('--secs', 8), SPOTS = +opt('--spots', 3), WALK = +opt('--walk', 20);
// (vite.config.js reads it when the server is made: the page's data/ is this dir's)
if (opt('--public')) process.env.VOXEL_PUBLIC = path.resolve(opt('--public'));
const { createServer } = await import('vite');
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright-core');
const halls = JSON.parse(fs.readFileSync(opt('--halls'), 'utf8'));
// the spots: the largest hall, one of the median size, a small one
const bySize = [...halls].sort((a, b) => b.area - a.area);
const spots = [bySize[0], bySize[bySize.length >> 1], bySize[bySize.length - 1]].slice(0, SPOTS);
const yawOf = ([ix, iz]) => Math.atan2(ix, iz); // (forward is (sin yaw, cos yaw): nav/foot.ts)
const grid = (x, y, z) => `${x - 6144},${y},${z - 2048}`;
const d0 = bySize[0].doors[0].street;
// --occ: ?halls=1, the occlusion leaves the rooms open only while the camera is in one (occlusion.ts roomsFromInside)
const Q = `play&cam=${grid(d0[0], 60, d0[1] + 40)},${grid(d0[0], 10, d0[1])}&ui=0&autores=0&weather=clear&date=7-15&hour=13&seed=7${args.includes('--occ') ? '&halls=1' : ''}`;

const server = await createServer({ root: web, logLevel: 'error', server: { host: '127.0.0.1', port: +opt('--port', 5264) } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const out = { phone: PHONE, views: [], walks: [] };
try {
  const ctx = await browser.newContext(PHONE
    ? { viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2 }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}?${Q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.evaluate(() => {
    const T = window.__three, R = T.renderer, render = R.render.bind(R);
    if (window.__life) { window.__life.group.visible = false; window.__life.update = () => {}; }
    R.render = () => {};
    window.__count = () => {
      R.info.reset(); render(T.scene, T.camera);
      const all = { tris: R.info.render.triangles, calls: R.info.render.calls };
      // the city's tiles alone (the rest -- trees, sky, lamps -- comes and goes from run to run)
      const S = window.__streamer, tiles = new Set();
      for (const n of S.nodes.values()) for (const m of [n.mesh, ...(n.sec ?? [])]) if (m) tiles.add(m);
      const hid = [];
      T.scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !tiles.has(o) && !tiles.has(o.parent)) { o.visible = false; hid.push(o); } });
      R.info.reset(); render(T.scene, T.camera);
      const tile = { tris: R.info.render.triangles, calls: R.info.render.calls };
      for (const o of hid) o.visible = true;
      return { tileTris: tile.tris, tileCalls: tile.calls, allTris: all.tris, shownQuads: S.stats().shownQuads, settled: !!T.city()?.settled };
    };
    window.__dts = [];
    let last = performance.now();
    const loop = () => { const t = performance.now(); window.__dts.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  const settle = () => page.waitForFunction(() => { const c = window.__three.city(); return c?.settled && window.__streamer?.idle; }, null, { timeout: 180000, polling: 300 }).catch(() => console.log('(not settled)'));
  const stand = (at, yaw) => page.evaluate(async ([at, yaw]) => {
    const nav = window.__three.nav, V = window.__three.camera.position.constructor;
    if (!nav.onFoot) await nav.setWalk({ at: new V(at[0], nav.world.support(at[0], at[1], 60), at[1]), exact: true, ms: 1 });
    const f = nav.foot;
    f.pos.x = at[0]; f.pos.z = at[1]; f.feet = nav.world.support(at[0], at[1], f.feet + 3); f.yaw = yaw; f.pitch = 0;
  }, [at, yaw]);
  const frames = async (walk) => {
    if (walk) await page.keyboard.down('KeyW');
    await page.evaluate(() => { window.__dts.length = 0; });
    await page.waitForTimeout(SECS * 1000);
    const d = await page.evaluate(() => window.__dts.slice(1));
    if (d.length < 2) return { n: d.length, dbg: await page.evaluate(() => ({ len: window.__dts.length, hidden: document.hidden, vis: document.visibilityState })) };
    if (walk) await page.keyboard.up('KeyW');
    d.sort((a, b) => a - b);
    return { n: d.length, mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1) };
  };
  await stand(d0, 0);
  await settle();
  if (PHONE) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  for (const h of spots) {
    const door = h.doors[0], yaw = yawOf(door.inward);
    // the street 6 m before the door, facing it; then inside the hall, facing the way back out
    const before = [door.street[0] - door.inward[0] * 6, door.street[1] - door.inward[1] * 6];
    for (const [where, at, y] of [['outside', before, yaw], ['inside', h.inside, yaw + Math.PI]]) {
      await stand(at, y);
      await page.waitForTimeout(500);
      await settle();
      const c = await page.evaluate(() => window.__count());
      const st = await frames(false);
      await stand(at, y);
      const wk = await frames(true);
      const v = { hall: h.building, area: h.area, where, ...c, stand: st, walk: wk };
      out.views.push(v);
      console.log(JSON.stringify(v));
    }
  }
  if (PHONE) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
  for (const h of halls.slice(0, WALK)) {
    for (const door of h.doors) {
      await stand([door.street[0] - door.inward[0] * 1.5, door.street[1] - door.inward[1] * 1.5], yawOf(door.inward));
      await page.waitForTimeout(300);
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(2500);
      await page.keyboard.up('KeyW');
      const r = await page.evaluate(() => {
        const nav = window.__three.nav, f = nav.foot;
        return { x: +f.pos.x.toFixed(1), z: +f.pos.z.toFixed(1), feet: +f.feet.toFixed(2), in: !!nav.world.inRoom(f.pos.x, f.pos.z, f.feet + 1) };
      });
      out.walks.push({ hall: h.building, floor: h.floor, ...r });
    }
  }
  const ok = out.walks.filter((w) => w.in).length;
  console.log(`walked in: ${ok} of ${out.walks.length} doors (${WALK} halls)`);
  if (ok < out.walks.length) console.log('not in:', JSON.stringify(out.walks.filter((w) => !w.in).slice(0, 8)));
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
  await server.close();
}
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out));
