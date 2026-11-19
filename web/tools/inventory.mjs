// Triangles shown, by kind (buildings and ground per level 1, 2, 4, 8 m; foliage; traffic), at the whole city and at a few details (settings.ts).
// usage: node tools/inventory.mjs http://localhost:5188
import { chromium } from 'playwright-core';
const [base] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/?date=06-21&hour=16&weather=clear`);
await page.waitForFunction(() => window.__three && window.__ready && !document.body.classList.contains('loading'), null, { timeout: 900000, polling: 500 });
for (const p of [1, 0.75, 0.5, 0.25, 0]) {
  await page.evaluate((p) => window.__three.setLevel(p), p);
  await page.waitForFunction(() => { const s = window.__streamer, c = window.__three.city(); return s.inflight === 0 && s.queue.length === 0 && c.settled; }, null, { timeout: 900000, polling: 500 });
  await page.waitForTimeout(5000);
  console.log(JSON.stringify(await page.evaluate(() => {
    const tri = (m) => Math.min(m.geometry.drawRange.count, m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    const acc = { budgetM: +(window.__three.budget() / 1e6).toFixed(2), pickM: +(window.__three.city().pickTris / 1e6).toFixed(2) };
    for (const n of window.__streamer.nodes.values()) {
      if (!n.mesh || !n.mesh.visible) continue;
      const k = n.foliage ? 'foliage' : `level${n.s}`;
      acc[k] = (acc[k] ?? 0) + tri(n.mesh);
      acc[k + 'Tiles'] = (acc[k + 'Tiles'] ?? 0) + 1;
    }
    let life = 0; window.__life?.group.traverse((o) => { if (o.isMesh) life += tri(o) * (o.isInstancedMesh ? o.count : 1); });
    acc.life = life;
    for (const k of ['level1', 'level2', 'level4', 'level8', 'foliage', 'life']) acc[k] = +((acc[k] ?? 0) / 1e6).toFixed(2);
    return acc;
  })));
}
await browser.close();
