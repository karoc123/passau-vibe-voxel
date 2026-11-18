// GPU time of the scene's render (EXT_disjoint_timer_query_webgl2) with the distance levels' tiles drawn in their own
// material (voxelMaterial.ts far: no moving things' shadow) and, frame by frame in turn, in the 1 m tiles' material as
// before: interleaved in one page, so the GPU's clock drifting between page loads (on the Iris Xe easily +-30 %)
// cancels out. Medians of each, and their ratio.
// usage: URL=... node tools/farshade.mjs [query] [frames]   (headed; GALLIUM_DRIVER=d3d12 on WSL; EXTRA, W, H)
import { chromium } from 'playwright-core';
const [q = 'view=overview&date=06-21&hour=14&weather=clear', frames = '40'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : [])] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1100), height: +(process.env.H || 700) } });
let lost = 0;
page.on('console', (m) => { if (m.text().startsWith('WebGL context lost')) lost++; });
await page.goto(`${process.env.URL || 'http://localhost:5186'}/?${q}`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 150000 });
await page.evaluate(() => window.__three.setLevel(1));
await page.waitForFunction(() => { const c = window.__three.city(), s = window.__streamer; return c && c.complete && c.settled && s.inflight === 0 && ![...s.nodes.values()].some((n) => n.remesh); }, null, { timeout: 400000, polling: 500 });
await page.waitForTimeout(2000);
if (lost) console.log('context lost during the load (recovered): numbers after it');
const r = await page.evaluate(async (N) => {
  const T = window.__three, R = T.renderer, gl = R.getContext(), X = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const nodes = [...window.__streamer.nodes.values()].filter((n) => n.mesh);
  const far = nodes.filter((n) => n.s === 2).map((n) => n.mesh);
  if (!far.length) return { far: 0 };
  const farMat = far[0].material, nearMat = window.__streamer.material; // (the 1 m tiles')
  const set = (m) => { for (const f of far) f.material = m; };
  for (const m of [nearMat, farMat]) { set(m); for (let i = 0; i < 4; i++) await new Promise((res) => requestAnimationFrame(res)); }
  const rp = T.post.composer.passes[0], r0 = rp.render, pend = [];
  let cur = 'far';
  rp.render = function (...a) { const qq = gl.createQuery(); gl.beginQuery(X.TIME_ELAPSED_EXT, qq); r0.apply(this, a); gl.endQuery(X.TIME_ELAPSED_EXT); pend.push([cur, qq]); };
  for (let i = 0; i < 2 * N; i++) { cur = i % 2 ? 'before' : 'far'; set(i % 2 ? nearMat : farMat); await new Promise((res) => requestAnimationFrame(res)); }
  rp.render = r0; set(farMat);
  gl.finish(); await new Promise((res) => setTimeout(res, 500));
  const out = { far: [], before: [] };
  for (const [k, qq] of pend.slice(4)) if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) out[k].push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
  if (!out.far.length || !out.before.length) return { error: 'no timer query results' };
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const lod = window.__three.city().lod.shownBy;
  return { shownBy: lod, n: out.far.length, before: +med(out.before).toFixed(2), far: +med(out.far).toFixed(2), ratio: +(med(out.far) / med(out.before)).toFixed(3) };
}, +frames);
console.log(JSON.stringify(r));
await browser.close();
