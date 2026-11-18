// Loads a view in a headed (GPU) browser at full render size, frames unthrottled as in perfbench, and reports page
// errors for a while; a geometry drawn after its dispose() is traced to who disposed it.
// usage: URL=... node tools/errwatch.mjs [query] [seconds]
import { chromium } from 'playwright-core';
const [q = 'view=overview&date=06-21&hour=14&weather=clear', secs = '40'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1',
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
let n = 0;
page.on('console', (m) => { if (m.text().startsWith('CONTEXT')) console.log(m.text()); });
page.on('pageerror', async (e) => {
  if (n++ >= 1) return;
  console.log('[pageerror]', e.stack?.slice(0, 1200));
  console.log(await page.evaluate(() => {
    const out = [];
    window.__three.scene.traverse((o) => { if (o.geometry?.userData?.disposedAt) out.push(`${o.name || o.type} visible=${o.visible} parent=${o.parent?.type} ${o.geometry.userData.disposedAt}`); });
    return out.slice(0, 3).join('\n---\n');
  }).catch((x) => String(x)));
});
await page.goto(`${process.env.URL || 'http://localhost:5181'}/?${q}`, { timeout: 150000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 150000 });
console.log(await page.evaluate(() => { const gl = window.__three.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }));
await page.evaluate(() => {
  let geo = null;
  window.__three.scene.traverse((o) => { geo ??= o.geometry; });
  const P = Object.getPrototypeOf(geo), d = P.dispose;
  P.dispose = function () { this.userData.disposedAt = new Error().stack.split('\n').slice(2, 6).join(' | '); return d.call(this); };
  const c = window.__three.renderer.domElement;
  c.addEventListener('webglcontextlost', () => console.log('CONTEXT LOST', performance.now()));
  c.addEventListener('webglcontextrestored', () => console.log('CONTEXT RESTORED', performance.now()));
  window.__three.setLevel(1);
});
await page.waitForTimeout(+secs * 1000);
console.log('errors', n);
await browser.close();
