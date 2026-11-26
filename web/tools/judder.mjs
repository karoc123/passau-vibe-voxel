// The judder of what the player rides against its camera under emulated frame pacing:
// rAF is wrapped (synthetic timestamps), the sample is taken once the frame's camera is placed (the car: after
// Nav.place; a craft: just before the render). J: the largest per-frame change of its position seen from the camera; E:
// the largest |drawn step - v*dt| (the car: v its speed; a craft: v from its drawn path over +-0.1 s round the frame).
// Subjects: the driven car (default), and the crafts a player flies with their own camera: the floatplane in the air,
// hands off; the boat at full throttle; the drone climbing at full throttle (each entered by its shell at a spot:
// window.__crafts).
// Needs a running dev server and Chrome.
// node tools/judder.mjs [port=5173] [extra query] [scenarios: 0,2,...] [--what car,plane,boat,drone]
import { chromium } from 'playwright-core';
const argv = process.argv.slice(2), wi = argv.indexOf('--what');
const WHAT = (wi >= 0 ? argv.splice(wi, 2)[1] : 'car').split(',');
const PORT = argv[0] ?? '5173', extra = argv[1] ?? '';
const LIMIT = 0.005; // m
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const errors = [];
// the crafts (world metres = ?cam= grid + (6144, 2048)): the shell's id, where it is put in, its camera's start, the
// keys held, whether it is measured on the ground plane only (the boat's hull bobs as drawn: left out of J and E), the
// slowest it must go
const CRAFTS = {
  plane: { shell: 'plane', at: { x: 6500, y: 160, z: 2600, h: 0 }, cam: '356,200,452,356,100,552', keys: [], flat: false, vmin: 30 },
  boat: { shell: 'boat', at: { x: 8160.5, z: 2880.5, h: 1.8 }, cam: '2016,60,782,2016,0,832', keys: ['KeyW'], flat: true, vmin: 8 },
  drone: { shell: 'fpv', at: { x: 6500, y: 40, z: 2600, h: 0 }, cam: '356,60,532,356,20,552', keys: ['KeyR'], arm: 'keyboard', flat: false, vmin: 10 },
};
// one fresh page per scenario (seed 7: the same car on the same straight), 200 frames of gas at a steady 60 Hz, then the pattern
const results = [];
const run = async (what, name, dts, frames) => {
const craft = CRAFTS[what];
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  const real = window.requestAnimationFrame.bind(window);
  const R = window.__raf = { dts: null, i: 0, t: 0, lastReal: -1 };
  const clock = new BroadcastChannel('judder-clock');
  window.requestAnimationFrame = (cb) => real((now) => {
    if (!R.dts) { R.t = now; clock.postMessage(now + 1000 / 60 - 2); return cb(now); }
    if (now !== R.lastReal) {
      R.lastReal = now; R.t += R.dts[R.i++ % R.dts.length];
      clock.postMessage(R.t + R.dts[R.i % R.dts.length] - 2);
    }
    cb(R.t);
  });
});
// the sim worker's clock made to follow the synthetic one (the software renderer here draws far slower than the
// timestamps say; the worker's own clock would run ahead of the frames): set to 2 ms before the next frame's time, as
// a worker ticking in real time would have ticked by then
page.on('worker', (w) => w.evaluate(() => {
  const real = performance.now.bind(performance), clock = new BroadcastChannel('judder-clock');
  let base = 0, first = null, t = null;
  clock.onmessage = (e) => { if (first === null) { first = e.data; base = real(); } t = e.data; };
  performance.now = () => (t === null ? real() : base + (t - first));
  // (its timers short, so it ticks within a few real ms of each jump of the frames' clock, however fast they come)
  const timeout = setTimeout.bind(self);
  self.setTimeout = (f, d) => timeout(f, Math.min(d ?? 0, 2));
}).catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/?cam=${craft?.cam ?? '1400,60,350,1460,10,420'}&crop=600&seed=7&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0${extra ? '&' + extra : ''}`);
await page.waitForFunction(() => window.__life?.group.visible, null, { timeout: 240000 });
await page.waitForTimeout(3000);
const key = (type, code) => page.evaluate(([t, c]) => window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true })), [type, code]);
if (!craft) {
await page.keyboard.press('/'); await page.keyboard.type('Follow a car'); await page.waitForTimeout(300); await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement?.blur?.());
await page.waitForTimeout(2000);
await page.waitForFunction(() => !document.querySelector('.drive-mode button')?.disabled, null, { timeout: 60000 }).catch(() => {});
await page.locator('.drive-mode button').first().click();
await page.waitForFunction(() => window.__sim.seat()?.role === 'driver' && window.__sim.driver() && !window.__sim.driver().waiting, null, { timeout: 90000 }).catch(() => {});
await page.evaluate(() => document.activeElement?.blur?.());

// the sampler
await page.evaluate(() => {
  const S = window.__sim, cam = window.__three.camera, nav = window.__three.nav;
  const M = window.__m = { log: null };
  const orig = nav.place.bind(nav);
  nav.place = (dt) => {
    orig(dt);
    if (!M.log) return;
    const id = S.driver()?.entityId, T = S.traffic;
    const c = [...T.cars, ...T.detachedCars].find((q) => q.id === id), r = c && window.__life.drawn('car', id);
    if (!r) return;
    const d = c.detachedPose;
    M.log.push([window.__raf.t, Math.min(dt, 0.1), S.tick, T.acc, r.x, r.y, r.z, r.h, cam.position.x, cam.position.y, cam.position.z, S.driver().kmh, d.x, d.z, S.lead]);
  };
});
} else {
  // in at the spot (the shell's own search for a start), then (the drone) armed; the sampler just before the render: the
  // craft as drawn (its model: the boat's hull; the drone's camera: it is the drone) and the camera, final for the frame
  await page.evaluate(([shell, at]) => window.__crafts.find((c) => c.id === shell).enter(at), [craft.shell, craft.at]);
  await page.waitForFunction(() => window.__sim.craftOf()?.placed, null, { timeout: 90000 });
  await page.waitForTimeout(500);
  // (the drone armed on the keyboard, as its panel's button does)
  if (craft.arm) await page.evaluate(([shell, how]) => window.__crafts.find((c) => c.id === shell).arm(how), [craft.shell, craft.arm]);
  await page.evaluate(() => {
    const cam = window.__three.camera, post = window.__three.post, nav = window.__three.nav, S = window.__sim;
    const M = window.__m = { log: null };
    const orig = post.composer.render.bind(post.composer);
    post.composer.render = (...a) => {
      if (M.log) {
        const m = nav.craft?.model, o = m?.hull ?? m?.group ?? cam, p = o.position, q = cam.quaternion;
        M.log.push([window.__raf.t, 0, S.tick, S.traffic.acc, p.x, p.y, p.z, q.x, q.y, q.z, q.w, cam.position.x, cam.position.y, cam.position.z]);
      }
      return orig(...a);
    };
  });
}

  await page.evaluate(() => { window.__raf.dts = [1000 / 60]; window.__raf.i = 0; });
  // (the render clock settled first after the load's slow frames: steady pacing is measured, not its start)
  await page.waitForFunction(() => window.__raf.i >= 1000 || (window.__raf.i >= 60 && window.__sim.lead < 0.8), null, { timeout: 600000, polling: 100 });
  for (const k of craft?.keys ?? ['KeyW']) await key('keydown', k);
  await page.evaluate(() => { window.__m.log = []; });
  await page.waitForFunction(() => window.__m.log.length >= 200, null, { timeout: 600000, polling: 250 });
  await page.evaluate((dts) => { window.__raf.dts = dts; window.__raf.i = 0; window.__m.log = []; }, dts);
  // (a craft's speed is taken over +-0.1 s round each frame: that much more on each side)
  const more = craft ? Math.ceil(0.1 * 1000 / Math.min(...dts)) + 2 : 0;
  await page.waitForFunction((n) => window.__m.log.length >= n, frames + 2 * more, { timeout: 600000, polling: 250 });
  const log = await page.evaluate(() => { const l = window.__m.log; window.__m.log = null; return l; });
  if (craft) reportCraft(what, name, log.slice(0, frames + 2 * more)); else report(name, log.slice(0, frames));
  await page.close();
};

// a craft: its position in the camera's frame (the camera's rotation undone), frame to frame (J); its drawn step against
// its speed times the frame's dt, the speed from its drawn path over +-0.1 s round the frame (E: exact for a steady
// speed or acceleration; a craft drawn at its last step, not between two, shows its steps here)
function reportCraft(what, name, log) {
  const flat = CRAFTS[what].flat;
  const rel = log.map(([, , , , x, y, z, qx, qy, qz, qw, cx, cy, cz]) => {
    // (x - c turned by the inverse of q)
    const vx = x - cx, vy = flat ? 0 : y - cy, vz = z - cz, ix = -qx, iy = -qy, iz = -qz;
    const tx = 2 * (iy * vz - iz * vy), ty = 2 * (iz * vx - ix * vz), tz = 2 * (ix * vy - iy * vx);
    return [vx + qw * tx + iy * tz - iz * ty, vy + qw * ty + iz * tx - ix * tz, vz + qw * tz + ix * ty - iy * tx];
  });
  const dist = (a, b) => Math.hypot(a[4] - b[4], flat ? 0 : a[5] - b[5], a[6] - b[6]);
  let J = 0, E = 0, sumJ = 0, sumE = 0, n = 0, vsum = 0, worst = 0;
  const rows = [];
  for (let i = 1; i < log.length; i++) {
    const t0 = log[i - 1][0], t1 = log[i][0], mid = (t0 + t1) / 2;
    let a = i - 1, b = i;
    while (a > 0 && log[a][0] > mid - 100) a--;
    while (b < log.length - 1 && log[b][0] < mid + 100) b++;
    if (log[a][0] > mid - 100 || log[b][0] < mid + 100) continue;
    // (along the drawn path, not the chord: a turn is not slower)
    let path = 0;
    for (let k = a + 1; k <= b; k++) path += dist(log[k], log[k - 1]);
    const v = path / ((log[b][0] - log[a][0]) / 1000), dt = (t1 - t0) / 1000;
    const d = dist(log[i], log[i - 1]), e = d - v * dt;
    const dJ = Math.hypot(rel[i][0] - rel[i - 1][0], rel[i][1] - rel[i - 1][1], rel[i][2] - rel[i - 1][2]);
    if (Math.abs(e) > E) { E = Math.abs(e); worst = rows.length; }
    J = Math.max(J, dJ); sumJ += dJ; sumE += Math.abs(e); vsum += v; n++;
    rows.push({ i, dt: dt * 1000, tick: log[i][2], a: log[i][3] * 30, v, d, e, dJ });
  }
  const v = vsum / n, back = Math.hypot(...rel.reduce((s, r) => s.map((q, k) => q + r[k] / rel.length), [0, 0, 0]));
  console.log(`\n== ${what}, ${name}: ${n} frames, v ${(v * 3.6).toFixed(0)} km/h, camera ${back.toFixed(2)} m from it`);
  console.log(`   ${what} vs camera, per frame: mean ${(100 * sumJ / n).toFixed(2)} cm, max ${(100 * J).toFixed(2)} cm`);
  console.log(`   drawn ${what} in the world, step - v*dt: mean ${(100 * sumE / n).toFixed(2)} cm, max ${(100 * E).toFixed(2)} cm`);
  const k = Math.max(0, worst - 3);
  console.log(rows.slice(k, k + 7).map((r) => `   f${r.i} dt ${r.dt.toFixed(1)} tick ${r.tick} a ${r.a.toFixed(2)} step ${(100 * r.d).toFixed(1)}cm v*dt ${(100 * r.v * r.dt / 1000).toFixed(1)}cm e ${(100 * r.e).toFixed(2)}cm cam ${(100 * r.dJ).toFixed(2)}cm`).join('\n'));
  results.push({ what, name, J, E, v, vmin: CRAFTS[what].vmin });
}

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
    rows.push({ i, dt: log[i][1] * 1000, tick: log[i][2], a: log[i][3] * 30, lead: log[i][14], v, along: rel[i].along, dA, d, w, pred });
  }
  const v = vsum / n, back = rel.reduce((a, r) => a + r.along, 0) / rel.length;
  // on screen: the car's ground point shifts by dA along the road, seen from `back` behind and `up` above
  const upv = -rel.reduce((a, r) => a + r.up, 0) / rel.length, D = Math.hypot(back, upv), px1080 = (m) => m * (upv / D) / D / (55 * Math.PI / 180) * 1080;
  const vs = log.map((l) => l[11]);
  console.log(`\n== ${name}: ${n} frames, v ${(v * 3.6).toFixed(0)} km/h (${Math.min(...vs).toFixed(0)}..${Math.max(...vs).toFixed(0)}), camera ${back.toFixed(2)} m behind, ${upv.toFixed(2)} m above`);
  console.log(`   car vs camera, along the heading: mean |d| per frame ${(100 * sum / n).toFixed(1)} cm, max ${(100 * max).toFixed(1)} cm  (~${px1080(sum / n).toFixed(1)} / ${px1080(max).toFixed(1)} px of 1080)`);
  console.log(`   minus v*(dt_i - dt_i-1) [one-frame-late camera model]: residual mean ${(100 * sumPred / n).toFixed(2)} cm`);
  console.log(`   drawn car in the world, step - v*dt: mean ${(100 * sumW / n).toFixed(2)} cm, max ${(100 * maxW).toFixed(2)} cm`);
  results.push({ what: 'car', name, J: max, E: maxW, v, vmin: 60 / 3.6 });
  // (round the frame drawn least evenly)
  const worst = rows.reduce((b, r, j) => (Math.abs(r.w) > Math.abs(rows[b].w) ? j : b), 0), k = Math.max(0, worst - 4);
  console.log(rows.slice(k, k + 9).map((r) => `   f${r.i} dt ${r.dt.toFixed(1)} tick ${r.tick} a ${r.a.toFixed(2)} lead ${r.lead?.toFixed(2)} along ${r.along.toFixed(3)} d ${(100 * r.dA).toFixed(1)}cm pred ${(100 * r.pred).toFixed(1)}cm step ${r.d.toFixed(3)} (v*dt ${(r.v * r.dt / 1000).toFixed(3)})`).join('\n'));
}

// patterns (ms)
const steady = (hz) => [1000 / hz];
const drops = (hz, every) => Array.from({ length: every }, (_, i) => (i === every - 1 ? 2 : 1) * 1000 / hz);
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const jitter = (hz, ms) => Array.from({ length: 997 }, () => 1000 / hz + (rnd() * 2 - 1) * ms);
const mixed = (hz) => Array.from({ length: 997 }, () => (rnd() < 0.2 ? 2 : 1) * 1000 / hz);

const N = 90, only = argv[2];
const S = [
  ['60 Hz steady', steady(60), N],
  ['60 Hz, every 6th frame missed (16.7/33.3)', drops(60, 6), N],
  ['60 Hz, 20 % of frames missed at random', mixed(60), N],
  ['60 Hz +-2 ms timestamp jitter', jitter(60, 2), N],
  ['144 Hz steady', steady(144), 216],
  ['144 Hz, 20 % of frames missed at random', mixed(144), 216],
  ['120 Hz steady', steady(120), 180],
];
for (const what of WHAT) for (const [i, s] of S.entries()) if (!only || only.split(',').includes(String(i))) await run(what, ...s);
if (errors.length) console.log('errors', errors.slice(0, 3));
await browser.close();
const bad = results.filter((r) => r.J > LIMIT || r.E > LIMIT || r.v < r.vmin);
for (const what of WHAT) {
  const R = results.filter((r) => r.what === what), B = bad.filter((r) => r.what === what);
  console.log(`\njudder ${what}: ${R.length - B.length}/${R.length} within ${LIMIT * 100} cm at >= ${(R[0]?.vmin * 3.6).toFixed(0)} km/h` + (B.length ? `; over: ${B.map((r) => `${r.name} (J ${(100 * r.J).toFixed(1)}, E ${(100 * r.E).toFixed(2)} cm, ${(r.v * 3.6).toFixed(0)} km/h)`).join('; ')}` : ''));
}
process.exit(bad.length || errors.length ? 1 : 0);
