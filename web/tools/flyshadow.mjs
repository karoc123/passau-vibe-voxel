// How often the city's sun shadow map is redrawn while the view flies and pans: frames, redraws, and the moving
// things' map's draws. usage: URL=... node tools/flyshadow.mjs
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1', args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${process.env.URL || 'http://localhost:5181'}/?view=dom&date=06-21&hour=14&weather=clear`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true && window.__three.city()?.complete, null, { timeout: 300000, polling: 500 });
await page.waitForTimeout(3000);
const run = (what) => page.evaluate(async (what) => {
  const T = window.__three, D = T.daylight, r0 = D.redraws;
  let frames = 0, twin = 0;
  const tw = D.twin.shadow;
  const done = new Promise((res) => {
    const t0 = performance.now();
    const f = () => { frames++; if (tw.needsUpdate) twin++; if (performance.now() - t0 < 2500) requestAnimationFrame(f); else res(); };
    requestAnimationFrame(f);
  });
  if (what === 'fly') T.flyTo({ pos: [2600, 700, 1500], target: [2300, 20, 900], ms: 2000 });
  if (what === 'pan') { let k = 0; const c = T.controls, cam = T.camera; const f = () => { if (k++ > 150) return; c.target.x += 1.5; cam.position.x += 1.5; requestAnimationFrame(f); }; requestAnimationFrame(f); }
  await done;
  return { what, frames, redraws: D.redraws - r0, twinPending: twin };
}, what);
for (const w of ['still', 'pan', 'fly', 'still']) console.log(JSON.stringify(await run(w)));
// the refit logic alone, frame by frame without drawing: a focus sliding at a given speed (m per frame)
for (const speed of [0.5, 3, 10, 40, 'zoom']) console.log(JSON.stringify(await page.evaluate((speed) => {
  const T = window.__three, D = T.daylight, sun = D.sun, f = T.controls.target.clone(), cam = T.camera;
  let refits = 0;
  for (let k = 0; k < 120; k++) {
    if (speed !== 'zoom') f.x += speed;
    sun.shadow.needsUpdate = false;
    D.fitShadow(f, cam, speed === 'zoom' ? 300 * 1.02 ** k : 400, T.map); // zoom: out from 300 m, 2 % a frame
    if (sun.shadow.needsUpdate) refits++;
  }
  return { speed, frames: 120, refits };
}, speed)));
await browser.close();
