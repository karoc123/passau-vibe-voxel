// GPU time per post-processing pass (EXT_disjoint_timer_query_webgl2): each pass of the composer timed on its own
// (the scene's RenderPass, n8ao, bloom, the depth blur, the grade/tone/SMAA pass) and the whole frame, medians over
// a few rounds, the whole city at the given level. Needs a real GPU: headed Chrome (GALLIUM_DRIVER=d3d12 on WSL).
// usage: URL=... node tools/passtime.mjs [query] [level] [rounds]   (EXTRA: more Chrome flags; W, H: viewport)
import { chromium } from 'playwright-core';
const [q = 'view=overview&date=06-21&hour=14&weather=clear', level = '1', rounds = '3'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : [])] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1400), height: +(process.env.H || 900) } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.text().startsWith('CONTEXT')) console.log(m.text()); });
await page.goto(`${process.env.URL || 'http://localhost:5184'}/?${q}`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 150000 });
console.log(await page.evaluate(() => { const gl = window.__three.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }));
await page.evaluate((l) => {
  window.__three.renderer.domElement.addEventListener('webglcontextlost', () => console.log('CONTEXT LOST'));
  window.__three.setLevel(+l);
}, level);
await page.waitForFunction(() => { const c = window.__three.city(); return c && c.complete && c.settled && window.__streamer.inflight === 0; }, null, { timeout: 400000, polling: 500 });
await page.waitForTimeout(2000);
const measure = () => page.evaluate(async () => {
  const T = window.__three, R = T.renderer, gl = R.getContext(), X = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const comp = T.post.composer, passes = comp.passes;
  const names = passes.map((p, i) => `${i}:${p.name}${p.effects ? `(${p.effects.map((e) => e.name).join('+')})` : ''}${p.enabled ? '' : ' [off]'}`);
  const out = Object.fromEntries([...names, 'frame'].map((n) => [n, []]));
  // one pass timed per frame, round robin (queries cannot nest), and the whole frame every other frame
  let k = 0;
  const saved = passes.map((p) => p.render), cr = comp.render;
  const pending = [];
  const timed = (fn, name) => function (...a) { const qq = gl.createQuery(); gl.beginQuery(X.TIME_ELAPSED_EXT, qq); fn.apply(this, a); gl.endQuery(X.TIME_ELAPSED_EXT); pending.push([name, qq]); };
  comp.render = function (...a) {
    const slot = k++ % (passes.length + 1);
    passes.forEach((p, i) => { p.render = i === slot ? timed(saved[i], names[i]) : saved[i]; });
    if (slot === passes.length) timed(cr, 'frame').apply(this, a); else cr.apply(this, a);
  };
  for (let i = 0; i < 12 * (passes.length + 1); i++) await new Promise((r) => requestAnimationFrame(r));
  comp.render = cr; passes.forEach((p, i) => { p.render = saved[i]; });
  gl.finish();
  await new Promise((r) => setTimeout(r, 500));
  const disjoint = gl.getParameter(X.GPU_DISJOINT_EXT);
  for (const [n, qq] of pending.slice(passes.length + 1)) if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) out[n].push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
  const med = (a) => (a.length ? +a.sort((x, y) => x - y)[a.length >> 1].toFixed(2) : null);
  return { disjoint, size: [R.domElement.width, R.domElement.height], ms: Object.fromEntries(Object.entries(out).map(([n, a]) => [n, med(a)])) };
});
let lost = 0;
page.on("console", (m) => { if (m.text().startsWith("CONTEXT LOST")) lost++; });
for (let r = 0; r < +rounds; r++) { if (lost) { console.log("context lost: no numbers"); break; } console.log(JSON.stringify(await measure())); }
await browser.close();
