#!/usr/bin/env node
// A page under a volley of craters: does it hitch? A host on the real data (host/ws.ts) in this process, players over
// real WebSockets from a worker thread (their own clock) on foot round the cathedral firing the launcher at the ground
// between them and a page on foot there (headless Chrome, its own vite dev server; a phone's screen and its CPU
// throttled 4x). Each crater is an edit the page applies over its node files (sim-client.ts applyEdit), its nodes'
// meshes made again (stream.ts), what reads the columns told. First QUIET s with the shooters standing, then FIRE s
// of fire: the frames (over 50 ms: what a player sees as a hitch), the page's main-thread tasks over 50 ms, its time
// applying the edits and taking the workers' meshes, the edits' remeshing queue, and where the main thread's time went
// (a CPU profile of the fire, self time by file).
// usage (in web/): node tools/volley.mjs [--shooters 16] [--quiet 10] [--fire 20] [--desktop] [--headed] [-v]
// The gate (volley, in the full set) guards what a player under fire notices: few frames held up by the edits, none
// long. Measured 2026-11-27 (4x CPU): a node's edit ~4 ms on the page (its columns ~1.5, the new ones to the mesher
// ~1), the meshes taken ~1; 16 shooters ~30 ms/s, the worst frame's edits 14-22 ms, no frame over 50 ms by them; 32
// shooters ~60 ms/s, the worst 26-50 ms. Frames over 50 ms under fire were the machine's (the host and the shooters
// share it), standing as often.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const { WebSocket } = await import('ws');
  const { port, plans } = workerData;
  let firing = false;
  parentPort.on('message', (m) => { if (m === 'fire') firing = true; if (m === 'stop') process.exit(0); });
  const socks = plans.map((p) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
    const s = { ws, p, open: false, t: 0 };
    ws.on('open', () => { s.open = true; });
    ws.on('message', () => {});
    ws.on('error', () => {});
    return s;
  });
  setInterval(() => {
    for (const s of socks) {
      if (!s.open) continue;
      const { p } = s, c = [];
      if (s.t++ === 0) {
        c.push({ kind: 'view', view: { focus: { x: p.x, z: p.z }, viewer: { x: p.x, y: p.y + 2, z: p.z } } });
        c.push({ kind: 'request', request: { kind: 'walk', pose: { x: p.x, y: p.y, z: p.z, h: p.h, moving: false } } });
      } else if (firing) {
        // a held trigger (the host keeps the launcher's rate), swept a little either side of the page
        c.push({ kind: 'fire', slot: 2, h: p.h + 0.35 * Math.sin(s.t / 11 + p.i), pitch: p.pitch });
      }
      if (c.length) s.ws.send(JSON.stringify({ kind: 'commands', commands: c }));
    }
  }, 1000 / 30);
} else {
  const fs = await import('node:fs'), net = await import('node:net'), os = await import('node:os'), path = await import('node:path');
  const { spawn } = await import('node:child_process'), { createRequire } = await import('node:module');
  const { imp } = await import('./lib.mjs'), { dataDir, web } = await import('./data-dir.mjs');
  if (!fs.existsSync(path.join(dataDir, 'meta.json'))) { console.log(`SKIP volley: no ${dataDir}/meta.json`); process.exit(0); }
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
  const verbose = args.includes('-v'), headed = args.includes('--headed'), PHONE = !args.includes('--desktop');
  const SHOOTERS = opt('shooters', 16), QUIET = opt('quiet', 10), FIRE = opt('fire', 20);
  const { chromium } = createRequire(path.join(web, 'package.json'))('playwright-core');
  const log = (...a) => { if (verbose) console.log(' ', ...a); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

  const { serve } = await imp('src/host/ws.ts');
  const host = serve({ dir: dataDir, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => log(`host: ${l}`) });
  const hostPort = await host.port, sim = host.server.sim;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-gate-'));
  const vitePort = await freePort();
  const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    { cwd: web, env: { ...process.env, VOXEL_PUBLIC: path.dirname(dataDir), VOXEL_VITE_CACHE: cache, VITE_HOST_PORT: String(hostPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '', shooters = null, browser = null;
  vite.stdout.on('data', (d) => (viteLog += d));
  vite.stderr.on('data', (d) => (viteLog += d));
  process.on('exit', () => { vite.kill(); fs.rmSync(cache, { recursive: true, force: true }); });
  const done = async (code) => { await browser?.close().catch(() => {}); await shooters?.terminate(); host.close(); process.exit(code); };
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)) break;
    if (i > 300 || vite.exitCode !== null) { console.log(`FAIL volley: vite did not start\n${viteLog}`); await done(1); }
    await wait(100);
  }

  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];
  const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
  const ground = (x, z) => sim.traffic.ground?.support(x, z, 1000) ?? 0;
  for (const t0 = Date.now(); !(ground(dom.x, dom.y) > 0); await wait(50)) if (Date.now() - t0 > 60000) { console.log('FAIL volley: no ground by the cathedral'); await done(1); }
  // the page's spot: on the square beside the cathedral (the label is on its roof)
  const at = { x: dom.x + 30, z: dom.y };
  at.y = ground(at.x, at.z);

  // the page
  browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
  const cam = `${at.x + ox},${at.y + 2},${at.z + oz + 6},${at.x + ox},${at.y + 1},${at.z + oz}`;
  const Q = `server=ws://127.0.0.1:${hostPort}&cam=${cam}&ui=0&autores=0&weather=clear&hour=13`;
  const ctx = await browser.newContext(PHONE
    ? { viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${vitePort}/?${Q}`);
  await page.waitForFunction(() => window.__ready === true && window.__sim?.player, null, { timeout: 300000 });
  await page.evaluate((s) => { const T = window.__three; void T.nav.setWalk({ at: T.camera.position.clone().set(s.x, s.y, s.z), exact: true }); }, at);
  await page.waitForFunction(() => window.__three.nav.onFoot, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__three.city()?.settled && window.__streamer?.idle, null, { timeout: 180000, polling: 500 }).catch(() => console.log('(not settled at the start)'));
  log(`city in after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // (software GL here: a frame drawn takes ~1 s. Not drawn, the loop runs at the pace of its JS, as on a GPU)
  if (!headed) await page.evaluate(() => { window.__three.renderer.render = () => {}; });
  const cdp = await ctx.newCDPSession(page);
  if (PHONE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // the shooters: round the page, 18..28 m off, each at the ground ~10 m short of it
  const plans = [];
  for (let i = 0; i < SHOOTERS; i++) {
    const a = (i / SHOOTERS) * 2 * Math.PI + 0.3, r = 18 + (i % 3) * 5, x = at.x + Math.cos(a) * r, z = at.z + Math.sin(a) * r;
    plans.push({ i, x, y: ground(x, z), z, h: Math.atan2(at.x - x, at.z - z), pitch: -0.25 - 0.05 * (i % 3) });
  }
  shooters = new Worker(new URL(import.meta.url), { workerData: { port: hostPort, plans } });

  // every frame's time, the page's time applying edits (with what they tell: the streamer's columns, the collision's)
  // and taking the workers' meshes, the edits' remesh jobs waiting; the main thread's tasks over 50 ms
  await page.evaluate(() => {
    const S = window.__streamer, C = window.__sim, out = window.__vol = { frames: [], long: [] };
    const acc = { e: 0, en: 0, r: 0, ops: 0, one: 0 };
    const a0 = C.applyEdit.bind(C), r0 = S.onReply.bind(S);
    C.applyEdit = (n) => { const t = performance.now(); try { return a0(n); } finally { const d = performance.now() - t; acc.e += d; acc.en++; acc.ops += n.ops?.length ?? 0; acc.one = Math.max(acc.one, d); } };
    S.onReply = (m, p) => { const t = performance.now(); r0(m, p); acc.r += performance.now() - t; };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) out.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false });
    const loop = (now) => {
      let edits = 0;
      for (const n of S.nodes.values()) if (n.editJob) edits++;
      out.frames.push([now, acc.e, acc.en, acc.r, edits, window.__fire ? 1 : 0, acc.ops, acc.one]);
      acc.e = acc.en = acc.r = acc.ops = acc.one = 0;
      if (!window.__volStop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const edits0 = host.server.sim.worldEdits?.liveEdits?.size;
  await wait(QUIET * 1000);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.evaluate(() => { window.__fire = true; });
  shooters.postMessage('fire');
  await wait(FIRE * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const res = await page.evaluate(() => { window.__volStop = true; return window.__vol; });
  shooters.postMessage('stop');
  log(`edited nodes on the host: ${edits0} -> ${host.server.sim.worldEdits?.liveEdits?.size}`);

  // where the main thread's time went under fire: self time by file (and the top functions)
  const byId = new Map(profile.nodes.map((n) => [n.id, n])), self = new Map();
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  const byFile = new Map(), byFn = new Map();
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame, file = cf.url ? cf.url.replace(/^.*?\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '') : `(${cf.functionName || 'native'})`;
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
    const fn = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
    byFn.set(fn, (byFn.get(fn) ?? 0) + ms);
  }
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, ms]) => `    ${(ms / FIRE).toFixed(1).padStart(6)} ms/s  ${f}`).join('\n');
  console.log(`the main thread under fire, self time a second by file:\n${top(byFile, 14)}\n  by function:\n${top(byFn, 16)}`);
  // (-v: inclusive time of what applying the edits calls, a second)
  if (verbose) {
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const incl = new Map();
    for (const [id, ms] of self) {
      const seen = new Set();
      let inEdit = false;
      for (let x = id; x !== undefined; x = parent.get(x)) if (byId.get(x).callFrame.functionName === 'applyEdit') inEdit = true;
      if (!inEdit) continue;
      for (let x = id; x !== undefined; x = parent.get(x)) {
        const cf = byId.get(x).callFrame, fn = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/src\//, '').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
        if (!seen.has(fn)) { seen.add(fn); incl.set(fn, (incl.get(fn) ?? 0) + ms); }
        if (cf.functionName === 'applyEdit') break;
      }
    }
    console.log(`  inside applyEdit, inclusive:\n${top(incl, 24)}`);
  }

  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
  const phase = (f) => {
    const F = res.frames.filter((r) => r[5] === f), dts = F.slice(1).map((r, i) => r[0] - F[i][0]), dur = (F.at(-1)[0] - F[0][0]) / 1000;
    const t0 = F[0][0], t1 = F.at(-1)[0], long = res.long.filter(([s]) => s >= t0 && s < t1).map(([, d]) => d);
    return {
      n: F.length, dur, med: q(dts, 0.5), p99: q(dts, 0.99), max: Math.max(...dts), over: dts.filter((d) => d > 50).length / dur * 60,
      tasks: long.length / dur * 60, taskMax: Math.max(0, ...long), edits: F.reduce((a, r) => a + r[2], 0), editMs: F.reduce((a, r) => a + r[1], 0) / dur,
      editMax: Math.max(...F.map((r) => r[1])), replyMs: F.reduce((a, r) => a + r[3], 0) / dur, replyMax: Math.max(...F.map((r) => r[3])),
      queue: q(F.map((r) => r[4]), 0.95), queueMax: Math.max(...F.map((r) => r[4])),
      // frames over 50 ms with the edits' work (applying them, taking their meshes) over half of them
      byEdits: F.slice(1).filter((r, i) => r[0] - F[i][0] > 50 && r[1] + r[3] > (r[0] - F[i][0]) / 2).length / dur * 60,
    };
  };
  const quiet = phase(0), fire = phase(1);
  if (verbose) {
    const F = res.frames.filter((r) => r[5] === 1), ops = F.reduce((a, r) => a + r[6], 0), notes = F.reduce((a, r) => a + r[2], 0);
    console.log(`  ${notes} notes, ${ops} ops; the 8 frames with the most edit work: ${[...F].sort((a, b) => b[1] - a[1]).slice(0, 8).map((r) => `${r[1].toFixed(0)} ms (${r[2]} notes, ${r[6]} ops, longest ${r[7].toFixed(0)})`).join(', ')}`);
  }
  for (const [name, p] of [['standing', quiet], ['under fire', fire]]) {
    console.log(`${name} (${p.dur.toFixed(1)} s, ${PHONE ? 'phone, 4x CPU' : 'desktop'}): frames median ${p.med.toFixed(1)} ms, p99 ${p.p99.toFixed(0)}, max ${p.max.toFixed(0)}, ${p.over.toFixed(0)} a minute over 50 ms (the edits' work over half: ${p.byEdits.toFixed(0)}); ` +
      `main-thread tasks over 50 ms ${p.tasks.toFixed(0)} a minute, longest ${p.taskMax.toFixed(0)}; ${p.edits} edits applied, ${p.editMs.toFixed(1)} ms/s (max ${p.editMax.toFixed(0)} in a frame); ` +
      `meshes taken ${p.replyMs.toFixed(1)} ms/s (max ${p.replyMax.toFixed(0)}); edits' remeshing waiting p95 ${p.queue}, max ${p.queueMax}`);
  }

  // what a player under fire notices: frames held up (over 50 ms) by the edits' own work (more than half of such a
  // frame: applying them, taking their meshes), and how long the longest of it is; the edits shown at all. Frames over
  // 50 ms the edits did not cause are left out: on a shared machine the host and the shooters' sockets take the CPU too
  const checks = [
    [`the volley landed by the page (${fire.edits} edits applied)`, fire.edits >= SHOOTERS * FIRE / 1.5 / 4],
    [`frames over 50 ms with the edits' work over half: at most 6 a minute (${fire.byEdits.toFixed(0)})`, fire.byEdits <= 6],
    [`the edits' work in no frame over 100 ms (applying ${fire.editMax.toFixed(0)}, meshes taken ${fire.replyMax.toFixed(0)})`, fire.editMax + fire.replyMax <= 100],
    [`no page errors (${errors.length}${errors.length ? `: ${errors.slice(0, 3).join('; ')}` : ''})`, errors.length === 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  await done(checks.every(([, ok]) => ok) ? 0 : 1);
}
