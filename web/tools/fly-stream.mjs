#!/usr/bin/env node
// Does the tile streaming keep up with a plane? In the page (its own vite dev server, headless Chrome): the floatplane
// (or the jet) put in the air west of the city at its top speed, flown straight east low over it (a crude autopilot
// holding it ALT m over the highest ground ahead) for SECS s; every frame, along its path from 128 m behind to 1.5 km
// ahead, the level of what is drawn at each point (1, 2, 4, 8 m; 0: no tile, the far ground), and the stream's queue.
// usage (in web/): node tools/fly-stream.mjs [--port 5262] [--phone] [--jet] [--secs 60] [--json out.json]
//   --phone: a phone's screen (the 2 M triangle budget) and the CPU throttled 4x
// The gate (fly-stream, --phone --secs 30) guards what a player notices: before, a phone froze for 0.2 to 0.4 s every
// few seconds at speed (a coarse node's tiles' occluders all built in one update); then a frame over 50 ms about every
// 2.5 s held up by the stream (a coarse node's pages' lamp light painted and its occluders built in the update they
// came); no ground missing ahead; and the full detail popping in close (the 1 m tiles ended ~192 m ahead, 2 m beyond).
// Frames over 50 ms the stream did not cause (the town's life, the throttled CPU shared with the host) are left out:
// they vary with the machine's load. The street life's own work per frame was ~7 ms of a ~16 ms frame (the far
// traffic posed all round, behind the camera too).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { web } from './data-dir.mjs';

const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright-core');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PHONE = args.includes('--phone'), JET = args.includes('--jet'), SECS = +opt('--secs', 60), ALT = +opt('--alt', 50);
const SPEED = JET ? 125 : 68;
// world metres; the page's ?cam= is the project grid: world - (6144, 2048)
const START = { x: +opt('--x', JET ? 1500 : 4400), z: +opt('--z', 2750) };
const grid = (x, y, z) => `${x - 6144},${y},${z - 2048}`;
const Q = `play&cam=${grid(START.x - 60, 120, START.z)},${grid(START.x + 200, 40, START.z)}&ui=0&autores=0&weather=clear&date=7-15&hour=13&seed=7`;

const server = await createServer({ root: web, logLevel: 'error', server: { host: '127.0.0.1', port: +opt('--port', 5262) } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
let out, pageErrors = 0;
try {
  const ctx = await browser.newContext(PHONE
    ? { viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2 }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${url}?${Q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.waitForFunction(() => { const c = window.__three.city(); return c?.settled && window.__streamer?.idle; }, null, { timeout: 180000, polling: 500 }).catch(() => console.log('(not settled at the start)'));
  console.log(`city in after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // (only software GL here: drawing a frame takes ~1 s and the page's loop, the stream's updates among it, with it.
  // Not drawn, the loop runs at the pace of its JS, as on a GPU; what is left out is the GPU's upload of the meshes)
  if (!args.includes('--draw')) await page.evaluate(() => { window.__three.renderer.render = () => {}; });
  if (PHONE) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  await page.evaluate(([s, jet]) => {
    const pm = window.__crafts.find((c) => c.id === 'plane');
    pm.enter({ x: s.x, y: 0, z: s.z, h: Math.PI / 2, type: jet ? 'jet' : 'floatplane' });
  }, [START, JET]);
  await page.waitForFunction(() => window.__sim.craftOf()?.placed, null, { timeout: 90000 });
  // at the top speed at once, full throttle
  await page.evaluate((v) => {
    const pm = window.__crafts.find((c) => c.id === 'plane'), f = window.__sim.craftOf().core.flight;
    pm.link.put({ x: f.p.x, y: f.p.y, z: f.p.z, h: Math.PI / 2, speed: v });
    pm.throttle = 1;
  }, SPEED);
  await page.keyboard.down('ShiftLeft');
  // the samples, every frame
  await page.evaluate(() => {
    const S = window.__streamer, city = window.__three.city(), T = 128, out = window.__fly = [];
    const lvl = (x, z) => {
      const tx = Math.floor(x / T), ty = Math.floor(z / T);
      let want = 0;
      for (const s of [1, 2, 4, 8]) {
        const n = S.nodes.get(`${s}/${Math.floor(tx / s)}_${Math.floor(ty / s)}`);
        if (!n) continue;
        if (n.empty) return -1;
        if (n.state === 'ready' && n.mesh?.visible) return want ? s + 0.5 : s; // (+0.5: a finer one is on its way)
        if (n.state !== 'ready' && !want) want = s;
      }
      return 0;
    };
    const D = []; for (let d = -128; d <= 1536; d += 32) D.push(d);
    // the page's time in the stream's update and in taking the workers' meshes, per frame
    // and in the street life's (view/life.ts; it is drawn once the city is complete)
    const acc = { u: 0, r: 0, l: 0, ln: 0 }, u0 = S.update, r0 = S.onReply.bind(S), L = window.__life, l0 = L?.update.bind(L);
    if (L) L.update = (...a) => { const t = performance.now(); l0(...a); acc.l += performance.now() - t; acc.ln++; };
    S.update = (c) => { const t = performance.now(); u0(c); acc.u += performance.now() - t; };
    S.onReply = (m, p) => { const t = performance.now(); r0(m, p); acc.r += performance.now() - t; };
    const loop = () => {
      const c = window.__sim.craftOf();
      if (c?.core?.flight) {
        const f = c.core.flight, p = f.p, h = f.heading ?? Math.PI / 2, dx = Math.sin(h), dz = Math.cos(h);
        out.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, v: f.v, st: f.state, lv: D.map((d) => lvl(p.x + dx * d, p.z + dz * d)),
          q: S.queue.length, inf: S.inflight, pend: city.lod.pending, u: acc.u, r: acc.r, l: acc.ln ? acc.l : -1 });
        acc.u = acc.r = acc.l = acc.ln = 0;
      }
      if (!window.__flyStop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  // the autopilot: ALT m over the highest ground within 400 m ahead (the page's own collision tiles of the plane)
  const end = Date.now() + SECS * 1000;
  let key = null;
  while (Date.now() < end) {
    const s = await page.evaluate(() => {
      const pm = window.__crafts.find((c) => c.id === 'plane'), col = pm.link.col, f = window.__sim.craftOf()?.core?.flight;
      if (!f || !col) return null;
      const h = f.heading, dx = Math.sin(h), dz = Math.cos(h);
      let top = -1, known = 0;
      for (let d = 0; d <= 400; d += 20) for (const w of [-20, 0, 20]) {
        const su = col.surface(f.p.x + dx * d - dz * w, f.p.z + dz * d + dx * w);
        if (su) { known++; top = Math.max(top, su.top); }
      }
      return { y: f.p.y, top, known, gamma: f.gamma, st: f.state };
    });
    let want = null;
    if (s && s.top >= 0) {
      const err = s.top + ALT - s.y;
      want = err > 8 || (err > 0 && s.gamma < -0.02) ? 'KeyS' : err < -15 && s.gamma > -0.08 ? 'KeyW' : null;
      if (Math.abs(s.gamma) > 0.25) want = s.gamma > 0 ? 'KeyW' : 'KeyS';
    }
    if (want !== key) { if (key) await page.keyboard.up(key); if (want) await page.keyboard.down(want); key = want; }
    await page.waitForTimeout(100);
  }
  out = await page.evaluate(() => { window.__flyStop = true; return window.__fly; });
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  pageErrors = errors.length;
} finally {
  await browser.close();
  await server.close();
}
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out));

// the report
const D = []; for (let d = -128; d <= 1536; d += 32) D.push(d);
const at0 = D.indexOf(0), n = out.length, dur = (out.at(-1).t - out[0].t) / 1000;
const dist = Math.hypot(out.at(-1).x - out[0].x, out.at(-1).z - out[0].z);
const crashed = out.filter((s) => s.st === 'crashed').length;
console.log(`${PHONE ? 'phone (4x CPU)' : 'desktop'} ${JET ? 'jet' : 'floatplane'}: ${n} frames in ${dur.toFixed(1)} s (${(n / dur).toFixed(0)} fps), ${dist.toFixed(0)} m flown (${(dist / dur * 3.6).toFixed(0)} km/h), y ${Math.min(...out.map((s) => s.y)).toFixed(0)}..${Math.max(...out.map((s) => s.y)).toFixed(0)}, crashed frames ${crashed}`);
// stalls: the plane drawn still for more than 0.1 s (its tick waiting on collision tiles: 'loading')
let still = 0, worst = 0, run = 0;
for (let i = 1; i < n; i++) {
  const moved = Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z), dt = (out[i].t - out[i - 1].t) / 1000;
  if (moved < 0.2 * SPEED * dt) { run += dt; } else { if (run > 0.1) { still++; worst = Math.max(worst, run); } run = 0; }
}
const long = []; for (let i = 1; i < n; i++) { const dt = out[i].t - out[i - 1].t; if (dt > 50) long.push([dt, out[i].u + out[i].r]); }
const fr = out.slice(1).map((s, i) => s.t - out[i].t).sort((a, b) => a - b), us = out.map((s) => s.u + s.r).sort((a, b) => a - b);
console.log(`frames: median ${fr[n >> 1].toFixed(1)} ms, p99 ${fr[Math.floor(n * 0.99)].toFixed(0)}, max ${fr.at(-1).toFixed(0)}, ${long.length} over 50 ms (${(long.length / dur * 60).toFixed(0)} a minute; of them the stream's work over half: ${long.filter(([a, b]) => b > a / 2).length}); the stream's work per frame median ${us[n >> 1].toFixed(2)} ms, p99 ${us[Math.floor(n * 0.99)].toFixed(1)}, max ${us.at(-1).toFixed(0)}`);
const lifeMs = out.filter((s) => s.l >= 0).map((s) => s.l).sort((a, b) => a - b), lifeMed = lifeMs.length ? lifeMs[lifeMs.length >> 1] : -1;
console.log(`the street life's work per frame it is drawn in (${lifeMs.length}): median ${lifeMed.toFixed(2)} ms, p99 ${(lifeMs[Math.floor(lifeMs.length * 0.99)] ?? -1).toFixed(1)}`);
console.log(`stalls > 0.1 s: ${still}, longest ${worst.toFixed(2)} s`);
const pct = (k) => (100 * k / n).toFixed(1) + '%';
const under = (pred, lo, hi) => out.filter((s) => s.lv.slice(D.indexOf(lo), D.indexOf(hi) + 1).some(pred)).length;
for (const [lo, hi] of [[-128, 0], [0, 128], [0, 256], [0, 512], [0, 1024]]) {
  console.log(`  ${lo}..${hi} m: some point with no tile ${pct(under((l) => l === 0, lo, hi))}, coarser than 2 m ${pct(under((l) => l >= 4, lo, hi))}, coarser than 1 m ${pct(under((l) => l >= 2, lo, hi))}, a finer one pending ${pct(under((l) => l % 1 === 0.5, lo, hi))}`);
}
// how far ahead the 1 m tiles reach unbroken, and the first point not drawn at all
const reach = (pred) => out.map((s) => { let i = at0; while (i < D.length && pred(s.lv[i])) i++; return i >= D.length ? 1536 : D[i]; }).sort((a, b) => a - b);
const q = (a, f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
for (const [name, pred] of [['1 m', (l) => l === 1 || l === -1], ['<= 2 m', (l) => (l >= 1 && l < 3) || l === -1], ['any tile', (l) => l !== 0]]) {
  const r = reach(pred);
  console.log(`  ${name} unbroken ahead: min ${r[0]}, p5 ${q(r, 0.05)}, median ${q(r, 0.5)} m`);
}
const reach1 = reach((l) => l === 1 || l === -1);
const qs = out.map((s) => s.q).sort((a, b) => a - b);
console.log(`  stream queue: median ${q(qs, 0.5)}, p95 ${q(qs, 0.95)}, max ${qs.at(-1)}; chosen not shown: median ${q(out.map((s) => s.pend).sort((a, b) => a - b), 0.5)}`);

// the checks (a player's: the plane never drawn still, no frame held up long by the stream, no ground missing ahead)
const longStream = us.at(-1), holes = under((l) => l === 0, 0, 512);
const byStream = long.filter(([a, b]) => b > a / 2).length, perMin = byStream / dur * 60;
const checks = [
  [`flew at its top speed (${(dist / dur * 3.6).toFixed(0)} km/h, crashed frames ${crashed})`, dist / dur > 0.85 * SPEED && crashed === 0],
  [`no stall over 0.15 s (longest ${worst.toFixed(2)} s)`, worst <= 0.15],
  [`the stream's work in no frame over 150 ms (max ${longStream.toFixed(0)})`, longStream <= 150],
  [`frames over 50 ms with the stream's work over half: at most 12 a minute (${perMin.toFixed(0)})`, perMin <= 12],
  // (against the frame, as the machine's load slows both alike: the far traffic drawn all round was ~45%, in view ~28%)
  [`the street life's work in a frame at most 38% of a frame (median ${lifeMed.toFixed(1)} of ${fr[n >> 1].toFixed(1)} ms)`, lifeMed >= 0 && lifeMed <= 0.38 * fr[n >> 1]],
  [`no ground missing within 512 m ahead (${holes} frames)`, holes === 0],
  // (the full detail popping in close ahead: a phone's budget was spent around the camera, half of it behind, ~192 m)
  [`the 1 m tiles unbroken ahead: median at least 256 m, p5 at least 96 m (${q(reach1, 0.5)}, ${q(reach1, 0.05)})`, q(reach1, 0.5) >= 256 && q(reach1, 0.05) >= 96],
  [`no page errors (${pageErrors})`, pageErrors === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
