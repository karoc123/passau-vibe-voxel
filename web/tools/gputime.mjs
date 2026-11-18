// GPU time per frame (EXT_disjoint_timer_query_webgl2) of the whole frame, of the scene's render (the city and all
// in it, before the post-processing) and of the tiles' depth pre-pass alone, with the pre-pass on and off.
// usage: URL=... node tools/gputime.mjs [query] [level]   (EXTRA: more Chrome flags)
import { chromium } from 'playwright-core';
const [q = 'cam=1972,90,600,1972,20,680&date=06-21&hour=14&weather=clear', level = '1'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : [])] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1400), height: +(process.env.H || 900) } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.text().startsWith('CONTEXT')) console.log(m.text()); });
await page.goto(`${process.env.URL || 'http://localhost:5181'}/?${q}`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 150000 });
console.log(await page.evaluate(() => { const gl = window.__three.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }));
await page.evaluate((l) => {
  window.__three.renderer.domElement.addEventListener('webglcontextlost', () => console.log('CONTEXT LOST'));
  window.__three.setLevel(+l);
}, level);
await page.waitForFunction(() => { const c = window.__three.city(); return c && c.complete && c.settled && window.__streamer.inflight === 0; }, null, { timeout: 400000, polling: 500 });
await page.waitForTimeout(2000);
const measure = (mode, on) => page.evaluate(async ([mode, on]) => {
  const T = window.__three, R = T.renderer, gl = R.getContext(), X = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const P = T.prepass?.(), group = window.__streamer.group, comp = T.post.composer, scene = T.scene;
  if (P) P.enabled = on;
  const queries = [];
  let open = null;
  const begin = () => { if (open) return; open = gl.createQuery(); gl.beginQuery(X.TIME_ELAPSED_EXT, open); };
  const end = () => { if (!open) return; gl.endQuery(X.TIME_ELAPSED_EXT); queries.push(open); open = null; };
  const render = R.render, cr = comp.render, sb = scene.onBeforeRender;
  if (mode === 'frame') comp.render = function (...a) { begin(); cr.apply(this, a); end(); };
  if (mode === 'prepass') R.render = function (s, c) { if (s === group) begin(); render.call(this, s, c); if (s === group) end(); };
  if (mode === 'scene') {
    // the composer's render of the scene only (n8ao renders it again for its transparent things): the first each frame
    let first = true;
    const tick = () => { first = true; if (!stop) requestAnimationFrame(tick); };
    let stop = false; requestAnimationFrame(tick); setTimeout(() => { stop = true; }, 60000);
    scene.onBeforeRender = function (...a) { sb.apply(this, a); if (first) { first = false; begin(); } };
    R.render = function (s, c) { render.call(this, s, c); if (s === scene) end(); };
  }
  for (let i = 0; i < 25; i++) await new Promise((r) => requestAnimationFrame(r));
  R.render = render; comp.render = cr; scene.onBeforeRender = sb;
  gl.finish();
  await new Promise((r) => setTimeout(r, 300));
  const ms = queries.slice(3).map((qq) => (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(X.GPU_DISJOINT_EXT) ? gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6 : NaN)).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return { mode, on, n: ms.length, median: ms.length ? +ms[ms.length >> 1].toFixed(2) : null };
}, [mode, on]);
for (let rep = 0; rep < 2; rep++) for (const mode of ['frame', 'scene', 'prepass']) for (const on of [false, true]) console.log(JSON.stringify(await measure(mode, on)));
await browser.close();
