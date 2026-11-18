// A lost and restored WebGL context (WEBGL_lose_context), once the city is in: page errors after it, whether frames
// are drawn again, how long until every tile is back (stream.ts remeshLost), and a screenshot before and after.
// usage: URL=... node tools/ctxloss.mjs outdir [query] [level]   (headed: GALLIUM_DRIVER=d3d12 on WSL; HEADLESS=1)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const [out = 'ctxloss', q = 'view=dom&date=06-21&hour=14&weather=clear', level = '1'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const headless = process.env.HEADLESS === '1';
const browser = await chromium.launch({ channel: 'chrome', headless,
  args: headless ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    : ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : [])] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1100), height: +(process.env.H || 700) } });
const errors = [];
page.on('pageerror', (e) => { if (errors.length < 1000) errors.push(e.message); });
page.on('console', (m) => { if (/context/i.test(m.text())) console.log('[console]', m.text()); });
await page.goto(`${process.env.URL || 'http://localhost:5186'}/?${q}`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 150000 });
await page.evaluate((l) => {
  window.__lostN = 0; window.__frames = 0;
  const c = window.__three.post.composer, r = c.render.bind(c);
  c.render = (...a) => { r(...a); window.__frames++; }; // frames drawn to the end (an exception stops short of it)
  window.__three.renderer.domElement.addEventListener('webglcontextlost', () => { window.__lostN++; });
  window.__three.setLevel(+l);
}, level);
const settled = () => page.waitForFunction(() => {
  const c = window.__three.city(), s = window.__streamer;
  return c && c.complete && c.settled && s.inflight === 0 && ![...s.nodes.values()].some((n) => n.remesh);
}, null, { timeout: 400000, polling: 250 });
await settled();
await page.waitForTimeout(2500);
const frames = () => page.evaluate(() => window.__frames);
const shown = () => page.evaluate(() => window.__streamer.group.children.filter((m) => m.visible).length);
console.log('before: shown meshes', await shown(), 'context losses so far', await page.evaluate(() => window.__lostN), 'errors', errors.length);
if (await page.evaluate(() => window.__lostN)) console.log('(the context was already lost during the load: an organic loss)');
await page.screenshot({ path: `${out}/before.png` });
const e0 = errors.length;
await page.evaluate(() => { window.__ext = window.__three.renderer.getContext().getExtension('WEBGL_lose_context'); window.__ext.loseContext(); });
await page.waitForTimeout(1500);
const f0 = await frames();
await page.evaluate(() => window.__ext.restoreContext());
const t0 = Date.now();
await page.waitForTimeout(1000);
const f1 = await frames();
console.log('frames drawn in the 1 s after restore', f1 - f0, 'errors since loss', errors.length - e0, errors.slice(e0, e0 + 3));
await settled();
console.log('every tile back in', Date.now() - t0, 'ms; shown meshes', await shown());
await page.waitForTimeout(3000);
const f2 = await frames();
await page.waitForTimeout(1000);
console.log('frames in the last second', (await frames()) - f2, 'errors since loss', errors.length - e0);
await page.screenshot({ path: `${out}/after.png` });
await browser.close();
