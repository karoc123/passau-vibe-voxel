// EXPERIMENT (docs/plans/life-physics.md): ?lifephys=1 in the page, headless Chrome (software GL, as tools/shoot.mjs).
// Builds web/dist (unless --no-build), serves it with `vite preview` on --port (default 5211, never the user's 5173),
// opens the city at --at X,Z (map metres; the camera 120 m up south of it, crop 700 m), the hour 17, and for each
// configuration (lifephys off, then R:MAX ...) samples RUN s of frames: the physics' ms per frame (LifePhysics.stats),
// the frame's ms (rAF deltas), the bodies.
// usage (in web/): node tools/life-phys-browser.mjs [--no-build] [--port P] [--at X,Z] [--run S] [--model car|box] [R:MAX ...]
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), VITE = path.join(WEB, 'node_modules/.bin/vite');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const build = !flag('--no-build'), port = +opt('--port', 5211), RUN = +opt('--run', 15), model = opt('--model', 'car');
const [AX, AZ] = opt('--at', '6500,2600').split(',').map(Number);
const configs = [null, ...(argv.length ? argv : ['100:100', '200:100', '300:100']).map((a) => a.split(':').map(Number))];
const meta = JSON.parse(fs.readFileSync(path.join(WEB, 'public/data/meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];

if (build) execFileSync(VITE, ['build', '--logLevel', 'error'], { cwd: WEB, stdio: ['ignore', 'ignore', 'inherit'] });
const url = `http://127.0.0.1:${port}/`;
const server = spawn(VITE, ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); }

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const px = AX + ox, pz = AZ + oz;
const cam = `${px},130,${pz + 140},${px},15,${pz}`;
for (const c of configs) {
  const q = new URLSearchParams({ cam, crop: '700', hour: '17', date: '7-15', weather: 'clear', ui: '0', autores: '0' });
  if (c) { q.set('lifephys', '1'); q.set('lpr', String(c[0])); q.set('lpmax', String(c[1])); q.set('lpmodel', model); }
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}?${q}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 600000, polling: 200 });
  await page.waitForFunction(() => { const c = window.__three.city(); return c?.complete && window.__streamer?.idle; }, null, { timeout: 600000, polling: 200 }).catch(() => {});
  if (c) await page.waitForFunction(() => window.__lifephys && window.__lifephys.stats.bodies > 0, null, { timeout: 120000, polling: 200 }).catch(() => errors.push('no bodies'));
  await page.waitForTimeout(3000);
  const r = await page.evaluate((secs) => new Promise((res) => {
    const P = window.__lifephys, fr = [], ph = [], st = [], ct = [], te = [], nb = [];
    let last = performance.now();
    const t0 = last;
    const f = (now) => {
      fr.push(now - last); last = now;
      if (P) { ph.push(P.stats.frameMs); st.push(P.stats.stepMs); ct.push(P.stats.ctlMs); te.push(P.stats.terrainMs); nb.push(P.stats.bodies); }
      if (now - t0 < secs * 1000) requestAnimationFrame(f);
      else {
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0), p99 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.99)] ?? 0; };
        res({ frames: fr.length, frameAvg: avg(fr), frameP99: p99(fr), physAvg: avg(ph), physP99: p99(ph), step: avg(st), ctl: avg(ct), terrain: avg(te), bodies: avg(nb),
          cars: window.__life.cars.length, chunks: P?.terrain.stats.chunks ?? 0, lost: P?.stats.lost ?? 0, heap: performance.memory?.usedJSHeapSize ?? 0 });
      }
    };
    requestAnimationFrame(f);
  }), RUN);
  const fx = (x) => x.toFixed(2);
  console.log(`${c ? `R=${c[0]} MAX=${c[1]} model=${model}` : 'lifephys off'}: frames ${r.frames} frame avg ${fx(r.frameAvg)} p99 ${fx(r.frameP99)} ms | physics avg ${fx(r.physAvg)} p99 ${fx(r.physP99)} ms (world step ${fx(r.step)}, cars ${fx(r.ctl)}, colliders ${fx(r.terrain)}) bodies ${fx(r.bodies)} of ${r.cars} cars, chunks ${r.chunks}, lost ${r.lost}, JS heap ${(r.heap / 1048576).toFixed(0)} MB${errors.length ? ` errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.context().close();
}
await browser.close();
stop();
process.exit(0);
