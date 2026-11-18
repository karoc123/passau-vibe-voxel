// What the tiles' material costs on the GPU beside a plain one: the scene pass's GPU time (EXT_disjoint_timer_query)
// with every tile in its own material and, frame by frame in turn, in a MeshBasicMaterial (same geometry, same draws),
// at full and at 1/16 of the pixels (what stays at 1/16 is the vertex side: attributes, vertex shader, varyings).
// Shadow maps are not redrawn while it measures. Interleaved in one page: the GPU's clock drifting (+-30 % on an Iris
// Xe) cancels out. Medians.
// usage: URL=... node tools/vtxcost.mjs [query] [frames]   (headed; on Windows: EXE=path\to\chrome.exe; EXTRA, W, H)
import { chromium } from 'playwright-core';
const [q = 'view=overview&date=06-21&hour=14&weather=clear', frames = '24'] = process.argv.slice(2);
const args = ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : [])];
const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE, headless: false, args } : { channel: 'chrome', headless: false, args });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1400), height: +(process.env.H || 900) } });
await page.goto(`${process.env.URL || 'http://localhost:5173'}/?${q}`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.evaluate(() => window.__three.setLevel(1));
await page.waitForFunction(() => { const c = window.__three.city(), s = window.__streamer; return c && c.complete && c.settled && s.inflight === 0; }, null, { timeout: 400000, polling: 500 });
await page.waitForTimeout(2000);
for (const px of [1, 1 / 4]) {
  const r = await page.evaluate(async ([N, px]) => {
    const T = window.__three, R = T.renderer, gl = R.getContext(), X = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pr = R.getPixelRatio();
    if (px !== 1) { R.setPixelRatio(pr * px); dispatchEvent(new Event('resize')); }
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    const meshes = window.__streamer.group.children.filter((m) => m.isMesh), mats = meshes.map((m) => m.material);
    const THREE = await import('/node_modules/.vite/deps/three.js'), plain = new THREE.MeshBasicMaterial({ color: 0x888888 });
    const set = (v) => meshes.forEach((m, i) => { m.material = v === 'plain' ? plain : mats[i]; });
    for (const v of ['plain', 'own', 'plain', 'own']) { set(v); await raf(); }
    const rp = T.post.composer.passes[0], r0 = rp.render, pend = [], auto = R.shadowMap.autoUpdate;
    let cur = 'own';
    rp.render = function (...a) { set(cur); const qq = gl.createQuery(); gl.beginQuery(X.TIME_ELAPSED_EXT, qq); r0.apply(this, a); gl.endQuery(X.TIME_ELAPSED_EXT); pend.push([cur, qq]); };
    R.shadowMap.autoUpdate = false;
    for (let i = 0; i < 2 * N; i++) { cur = i % 2 ? 'plain' : 'own'; await raf(); }
    rp.render = r0; set('own'); R.shadowMap.autoUpdate = auto;
    if (px !== 1) { R.setPixelRatio(pr); dispatchEvent(new Event('resize')); }
    gl.finish(); await new Promise((res) => setTimeout(res, 500));
    const o = { own: [], plain: [] };
    for (const [k, qq] of pend.slice(4)) if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) o[k].push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
    const med = (a) => (a.length ? +a.sort((x, y) => x - y)[a.length >> 1].toFixed(2) : null);
    return { own: med(o.own), plain: med(o.plain), n: o.own.length };
  }, [+frames, px]);
  console.log(px === 1 ? 'full' : '1/16 px', JSON.stringify(r));
}
await browser.close();
