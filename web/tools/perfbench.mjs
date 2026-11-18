// Frame-time benchmark over fixed views, with ablations to split the cost (post, AO, moving-things shadow, life), and a
// pan that keeps refitting the shadow. Needs a real GPU: on WSL the headed Chrome (WSLg) gets the D3D12 adapter, the
// headless one only llvmpipe/SwiftShader (HEADLESS=1). Each frame ends in a 1-pixel readback, so its interval is the
// whole frame's CPU + GPU time, not how far ahead the browser queues. The whole city at 1 m (level 1) by default.
// usage: URL=http://localhost:5183 node tools/perfbench.mjs out.json [views] [level]
//   views: ';'-separated named views (overview, dom, city, ...) or name=x,y,z,tx,ty,tz; level: render size 0..1 (default 1)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [out = 'perfbench.json', viewArg = 'overview;dom;city;low=2127,40,790,2127,22,700', levelArg = '1'] = process.argv.slice(2);
const URL = process.env.URL || 'http://localhost:5183';
const N = +(process.env.FRAMES || 30);
const W = +(process.env.W || 1400), H = +(process.env.H || 900);
const ABL = (process.env.ABL ?? 'base,shadowEvery,noPost,noAO,noTwin,noLife,pan').split(',');
const headless = process.env.HEADLESS === '1';
const browser = await chromium.launch({ channel: 'chrome', headless,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[pageerror]', e.stack?.slice(0, 300)));
const t0 = Date.now(), log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', ...a);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

const res = { gpu: null, level: +levelArg, size: [W, H], frames: N, views: {} };
for (const spec of viewArg.split(';').map((s) => s.trim()).filter(Boolean)) {
  const [name, cam] = spec.split('=');
  const q = `${cam ? `cam=${cam}` : `view=${name}`}&date=06-21&hour=14&weather=clear`;
  log(spec, 'load');
  await page.goto(`${URL}/?${q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 500 });
  log(spec, 'ready');
  res.gpu ??= await page.evaluate(() => { const gl = window.__three.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
  // a lost WebGL context (the GPU reset: on WSL, e.g. under another GPU load) leaves frames that draw nothing: flagged
  await page.evaluate(() => { window.__lost = 0; window.__three.renderer.domElement.addEventListener('webglcontextlost', () => { window.__lost++; }); });
  await page.evaluate((l) => window.__three.setLevel(l), +levelArg);
  const settle = async () => {
    await page.waitForFunction(() => { const c = window.__three.city(); return c && c.complete && c.settled && window.__streamer.inflight === 0; }, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(1500);
  };
  await settle();
  log(spec, 'settled');
  const r = res.views[spec] = {};
  for (const abl of ABL) {
    await page.evaluate((abl) => {
      const T = window.__three, D = T.daylight, L = window.__life;
      window.__undo = [];
      const set = (o, k, v) => { const was = o[k]; o[k] = v; window.__undo.push(() => { o[k] = was; }); };
      if (abl === 'noAO') set(T.post.n8, 'enabled', false);
      if (abl === 'noPre' && T.prepass?.()) set(T.prepass(), 'enabled', false);
      if (abl === 'noPost') set(T.post.composer, 'render', () => T.renderer.render(T.scene, T.camera));
      if (abl === 'noTwin') set(D.twin, 'castShadow', false);
      if (abl === 'noLife' && L) { set(L, 'update', () => {}); for (const c of L.group.children) set(c, 'visible', false); }
      if (abl === 'shadowEvery') { const f = () => { D.redrawShadow(); if (window.__undo.length) requestAnimationFrame(f); }; window.__undo.push(() => {}); requestAnimationFrame(f); }
      if (abl === 'pan') {
        let k = 0; const c = T.controls, cam = T.camera;
        const f = () => { if (!window.__panning) return; const d = Math.sin(k++ / 40) * 1.5; c.target.x += d; cam.position.x += d; requestAnimationFrame(f); };
        window.__panning = true; window.__undo.push(() => { window.__panning = false; }); requestAnimationFrame(f);
      }
    }, abl);
    await page.waitForTimeout(600);
    const m0 = await met();
    const fr = await page.evaluate(async (N) => {
      const T = window.__three, R = T.renderer, comp = T.post.composer, D = T.daylight;
      let cpu = 0;
      const orig = comp.render, wrapped = function (...a) { const t = performance.now(); orig.apply(this, a); cpu += performance.now() - t; };
      comp.render = wrapped;
      const red0 = D.redraws, ts = [], gl = R.getContext(), px = new Uint8Array(4);
      let calls = 0, tris = 0;
      await new Promise((res) => { const f = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now()); calls += R.info.render.calls; tris += R.info.render.triangles; if (ts.length <= N) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      comp.render = orig;
      const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b), q = (p) => +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(2);
      return { p50: q(0.5), p90: q(0.9), mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), renderCpu: +(cpu / N).toFixed(2),
        calls: Math.round(calls / (N + 1)), tris: Math.round(tris / (N + 1)), shadowRedraws: D.redraws - red0, ...(window.__lost ? { contextLost: window.__lost } : {}) };
    }, N);
    const m1 = await met();
    fr.scriptMsPerFrame = +((m1.ScriptDuration - m0.ScriptDuration) * 1000 / N).toFixed(2);
    await page.evaluate(() => { for (const u of window.__undo.reverse()) u(); window.__undo = []; });
    r[abl] = fr;
    log(spec, abl, JSON.stringify(fr));
  }
  r.mem = await page.evaluate(() => ({ ...window.__streamer.stats(), gl: { ...window.__three.renderer.info.memory } }));
  console.log(spec, 'mem', JSON.stringify(r.mem));
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, timeout: 120000 }).catch((e) => console.log('shot failed', e.message.slice(0, 80)));
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
await browser.close();
