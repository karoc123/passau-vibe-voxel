// Drives the spike page (index.html) in a headed Chrome on the GPU: page loads interleaved across the variants, each
// load timing every cell (facing culling off/on x shadow map static/redrawn every frame) in two interleaved rounds.
// usage (Windows node, playwright-core): node bench.mjs [reps=4] [views=overview,fromoberhaus] [variants=gl,gpu,gpuc]
//   URL (default http://localhost:5232), FRAMES (default 40), OUT (default bench.jsonl), SHOTS=1: a screenshot per load
import { createRequire } from 'module';
import { appendFileSync } from 'fs';
const require = createRequire(process.env.WINMODS ? process.env.WINMODS + '\\x.js' : import.meta.url);
const { chromium } = require('playwright-core');
const [reps = '4', views = 'overview,fromoberhaus', variants = 'gl,gpu,gpuc'] = process.argv.slice(2);
const URL = process.env.URL || 'http://localhost:5232', FRAMES = +(process.env.FRAMES || 40), OUT = process.env.OUT || 'bench.jsonl';
const cells = [[false, 'static'], [true, 'static'], [false, 'every'], [true, 'every']];
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu'] });
for (let rep = 0; rep < +reps; rep++) for (const view of views.split(',')) {
  // the variants' order turns each rep, so none is always first after a cold start
  const vs = variants.split(','), order = vs.map((_, i) => vs[(i + rep) % vs.length]);
  for (const r of order) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
    const t0 = Date.now();
    await page.goto(`${URL}/experiments/webgpu/?r=${r}&view=${view}`, { timeout: 120000 });
    await page.waitForFunction(() => window.__spike && (window.__spike.ready || window.__spike.error), null, { timeout: 600000, polling: 500 });
    const err = await page.evaluate(() => window.__spike.error);
    if (err) { console.log('ERROR', r, view, err); appendFileSync(OUT, JSON.stringify({ rep, view, r, error: err }) + '\n'); await page.close(); continue; }
    const info = await page.evaluate(() => window.__spike.info);
    console.log(`rep ${rep} ${view} ${r} loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(info));
    for (let round = 0; round < 2; round++) for (const [cull, shadow] of round ? [...cells].reverse() : cells) {
      const m = await page.evaluate((a) => window.__spike.measure(a), { cull, shadow, frames: FRAMES });
      const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(2) : null; };
      console.log(`  ${cull ? 'cull' : 'all '} ${shadow.padEnd(6)} gpu ${med(m.gpu)} cpu ${med(m.cpu)} interval ${med(m.interval)} quads ${m.drawnQuads} tris ${m.tris}`);
      appendFileSync(OUT, JSON.stringify({ rep, round, view, r, info, ...m }) + '\n');
    }
    if (process.env.SHOTS) {
      await page.evaluate((a) => window.__spike.measure(a), { cull: true, shadow: 'static', frames: 3, warm: 3 });
      await page.screenshot({ path: `shot-${view}-${r}-${rep}.png` });
    }
    await page.close();
  }
}
await browser.close();
