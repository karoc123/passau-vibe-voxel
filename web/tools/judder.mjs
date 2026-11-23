// The judder of the driven car against its chase camera under emulated frame pacing (docs/plans/smooth-motion-and-lag.md
// M1): rAF is wrapped (synthetic timestamps), Nav.place is wrapped (the sample point: car and camera final for the frame).
// J: the largest per-frame change of the car's position seen from the camera; E: the largest |drawn step - v*dt|.
// Needs a running dev server and Chrome. node tools/judder.mjs [port=5173] [extra query] [scenarios: 0,2,...]
import { chromium } from 'playwright-core';
const PORT = process.argv[2] ?? '5173', extra = process.argv[3] ?? '';
const LIMIT = 0.005; // m
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const errors = [];
// one fresh page per scenario (seed 7: the same car on the same straight), 200 frames of gas at a steady 60 Hz, then the pattern
const results = [];
const run = async (name, dts, frames) => {
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  const real = window.requestAnimationFrame.bind(window);
  const R = window.__raf = { dts: null, i: 0, t: 0, lastReal: -1 };
  window.requestAnimationFrame = (cb) => real((now) => {
    if (!R.dts) { R.t = now; return cb(now); }
    if (now !== R.lastReal) { R.lastReal = now; R.t += R.dts[R.i++ % R.dts.length]; }
    cb(R.t);
  });
});
await page.goto(`http://127.0.0.1:${PORT}/?cam=1400,60,350,1460,10,420&crop=600&seed=7&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0${extra ? '&' + extra : ''}`);
await page.waitForFunction(() => window.__life?.group.visible, null, { timeout: 240000 });
await page.waitForTimeout(3000);
await page.keyboard.press('/'); await page.keyboard.type('Follow a car'); await page.waitForTimeout(300); await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement?.blur?.());
await page.waitForTimeout(2000);
await page.waitForFunction(() => !document.querySelector('.drive-mode button')?.disabled, null, { timeout: 60000 }).catch(() => {});
await page.locator('.drive-mode button').first().click();
await page.waitForFunction(() => window.__sim.seat('local')?.role === 'driver' && window.__sim.driver('local') && !window.__sim.driver('local').waiting, null, { timeout: 90000 }).catch(() => {});
await page.evaluate(() => document.activeElement?.blur?.());

// the sampler
await page.evaluate(() => {
  const S = window.__sim, cam = window.__three.camera, nav = window.__three.nav;
  const M = window.__m = { log: null };
  const orig = nav.place.bind(nav);
  nav.place = (dt) => {
    orig(dt);
    if (!M.log) return;
    const id = S.driver('local')?.entityId, T = S.traffic;
    const c = [...T.cars, ...T.detachedCars].find((q) => q.id === id);
    if (!c?.rp) return;
    const d = c.detachedPose;
    M.log.push([window.__raf.t, Math.min(dt, 0.1), S.tick, T.acc, c.rp.x, c.rp.y, c.rp.z, c.rh, cam.position.x, cam.position.y, cam.position.z, S.driver('local').kmh, d.x, d.z]);
  };
});


  const key = (type, code) => page.evaluate(([t, c]) => window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true })), [type, code]);
  await key('keydown', 'KeyW');
  await page.evaluate(() => { window.__raf.dts = [1000 / 60]; window.__m.log = []; });
  await page.waitForFunction(() => window.__m.log.length >= 200, null, { timeout: 600000, polling: 250 });
  await page.evaluate((dts) => { window.__raf.dts = dts; window.__raf.i = 0; window.__m.log = []; }, dts);
  await page.waitForFunction((n) => window.__m.log.length >= n, frames, { timeout: 600000, polling: 250 });
  const log = await page.evaluate(() => { const l = window.__m.log; window.__m.log = null; return l; });
  report(name, log.slice(0, frames));
  await page.close();
};

function report(name, log) {
  // camera-relative position of the drawn car: along its heading and across
  const rel = log.map(([, , , , x, y, z, h, cx, cy, cz]) => {
    const dx = x - cx, dz = z - cz;
    return { along: dx * Math.sin(h) + dz * Math.cos(h), across: dx * Math.cos(h) - dz * Math.sin(h), up: y - cy };
  });
  let sum = 0, max = 0, n = 0, sumW = 0, maxW = 0, vsum = 0, sumPred = 0;
  const rows = [];
  for (let i = 2; i < log.length; i++) {
    const dA = rel[i].along - rel[i - 1].along;
    const v = log[i][11] / 3.6;
    // world-space evenness of the drawn car: its step this frame against v * dt
    const d = Math.hypot(log[i][4] - log[i - 1][4], log[i][6] - log[i - 1][6]);
    const w = d - v * log[i][1];
    // what a camera placed from the previous frame's drawn pose predicts: v * (dt_i - dt_{i-1})
    const pred = v * (log[i][1] - log[i - 1][1]);
    sum += Math.abs(dA); max = Math.max(max, Math.abs(dA)); sumW += Math.abs(w); maxW = Math.max(maxW, Math.abs(w)); vsum += v; n++;
    sumPred += Math.abs(dA - pred);
    rows.push({ i, dt: log[i][1] * 1000, tick: log[i][2], a: log[i][3] * 30, v, along: rel[i].along, dA, d, w, pred });
  }
  const v = vsum / n, back = rel.reduce((a, r) => a + r.along, 0) / rel.length;
  // on screen: the car's ground point shifts by dA along the road, seen from `back` behind and `up` above
  const upv = -rel.reduce((a, r) => a + r.up, 0) / rel.length, D = Math.hypot(back, upv), px1080 = (m) => m * (upv / D) / D / (55 * Math.PI / 180) * 1080;
  const vs = log.map((l) => l[11]);
  console.log(`\n== ${name}: ${n} frames, v ${(v * 3.6).toFixed(0)} km/h (${Math.min(...vs).toFixed(0)}..${Math.max(...vs).toFixed(0)}), camera ${back.toFixed(2)} m behind, ${upv.toFixed(2)} m above`);
  console.log(`   car vs camera, along the heading: mean |d| per frame ${(100 * sum / n).toFixed(1)} cm, max ${(100 * max).toFixed(1)} cm  (~${px1080(sum / n).toFixed(1)} / ${px1080(max).toFixed(1)} px of 1080)`);
  console.log(`   minus v*(dt_i - dt_i-1) [one-frame-late camera model]: residual mean ${(100 * sumPred / n).toFixed(2)} cm`);
  console.log(`   drawn car in the world, step - v*dt: mean ${(100 * sumW / n).toFixed(2)} cm, max ${(100 * maxW).toFixed(2)} cm`);
  results.push({ name, J: max, E: maxW, v });
  const k = Math.max(0, rows.findIndex((r, j) => j > 20 && r.dt > 1.5 * rows[j - 1].dt) - 3);
  console.log(rows.slice(k, k + 9).map((r) => `   f${r.i} dt ${r.dt.toFixed(1)} tick ${r.tick} a ${r.a.toFixed(2)} along ${r.along.toFixed(3)} d ${(100 * r.dA).toFixed(1)}cm pred ${(100 * r.pred).toFixed(1)}cm step ${r.d.toFixed(3)} (v*dt ${(r.v * r.dt / 1000).toFixed(3)})`).join('\n'));
}

// patterns (ms)
const steady = (hz) => [1000 / hz];
const drops = (hz, every) => Array.from({ length: every }, (_, i) => (i === every - 1 ? 2 : 1) * 1000 / hz);
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const jitter = (hz, ms) => Array.from({ length: 997 }, () => 1000 / hz + (rnd() * 2 - 1) * ms);
const mixed = (hz) => Array.from({ length: 997 }, () => (rnd() < 0.2 ? 2 : 1) * 1000 / hz);

const N = 90, only = process.argv[4];
const S = [
  ['60 Hz steady', steady(60), N],
  ['60 Hz, every 6th frame missed (16.7/33.3)', drops(60, 6), N],
  ['60 Hz, 20 % of frames missed at random', mixed(60), N],
  ['60 Hz +-2 ms timestamp jitter', jitter(60, 2), N],
  ['144 Hz steady', steady(144), 216],
  ['144 Hz, 20 % of frames missed at random', mixed(144), 216],
  ['120 Hz steady', steady(120), 180],
];
for (const [i, s] of S.entries()) if (!only || only.split(',').includes(String(i))) await run(...s);
if (errors.length) console.log('errors', errors.slice(0, 3));
await browser.close();
const bad = results.filter((r) => r.J > LIMIT || r.E > LIMIT || r.v < 60 / 3.6);
console.log(`\njudder: ${results.length - bad.length}/${results.length} within ${LIMIT * 100} cm at >= 60 km/h` + (bad.length ? `; over: ${bad.map((r) => `${r.name} (J ${(100 * r.J).toFixed(1)}, E ${(100 * r.E).toFixed(2)} cm, ${(r.v * 3.6).toFixed(0)} km/h)`).join('; ')}` : ''));
process.exit(bad.length || errors.length ? 1 : 0);
