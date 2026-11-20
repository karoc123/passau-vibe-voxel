#!/usr/bin/env node
// Deterministic screenshots of the viewer, and a numeric diff against an earlier set: the visual check for agents.
//
//   node tools/shoot.mjs --out DIR [--shots a,b|--set NAME] [--compare REFDIR] [options]
//
// Builds web/dist (unless --no-build), serves it with `vite preview` on --port (default 5194, never the user's 5173)
// unless --url is given, shoots each shot in headless Chrome with a software rasterizer (no GPU needed: --gl llvmpipe,
// Mesa through ANGLE's Vulkan, ~5-10x faster frames than SwiftShader; falls back to swiftshader where there is none)
// with what moves held still (shader clock, clouds, street life hidden, the sun's shadow drawn whole), writes
// DIR/<shot>.png and DIR/shots.json (timings, frame time, nodes shown per level, console errors, --eval results).
// With --compare REFDIR: DIR/diff/<shot>.png (ref | new | |diff| x4) and a table of mean |d|, % px > 8, % px > 24;
// exit code 1 if any shot's px>24 exceeds --fail (default 0.5 %). --no-shoot compares DIR's existing PNGs only.
// Compare only sets shot with the same --gl and --size (a renderer change alone moves some pixels).
//
// Shots: a name from SHOTS below, or `name=query` for an ad-hoc one (e.g. `x=cam=1600,40,700,1650,20,720`).
// Every shot gets `ui=0&autores=0&weather=clear&date=7-15&hour=13` unless its query sets them; --q adds to all.
// Tiny scene: `--crop 256` (or a shot query with crop=...) loads only the tiles within that many metres of the
// camera's target (see ?crop= in README "Agent tools"), which is what makes a shot take seconds instead of minutes.
// One object: `--focus bld:<id>` (bld:r<id> for a relation, street:<id>) shoots FOCUS_SHOTS round it (?focus=, the
// object's box from data/objects/) with crop=fit unless --crop is given; with --shots too, those names only.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(WEB, 'package.json'));
const VITE = path.join(WEB, 'node_modules/.bin/vite');
const { chromium } = require('playwright-core');

const STREET = 'cam=2006,22,687,2060,23,696';
// name -> query. Keep these stable: reference sets taken earlier are compared by name.
export const SHOTS = {
  overview: 'view=overview',
  oberhaus: 'view=oberhaus',
  dom: 'view=dom',
  eck: 'view=eck',
  street: STREET,
  // the Schanzlbrücke's deck (ramped as a street, ramps.ts): along it from its south end, and from the side
  'schanzl-deck': 'cam=1210,23,505,1232,19,575',
  'schanzl-side': 'cam=1190,26,548,1226,18,562',
  'street-night': `${STREET}&hour=22`,
  'oberhaus-night': 'view=oberhaus&hour=22',
  'oberhaus-autumn': 'view=oberhaus&date=10-20',
  'oberhaus-winter': 'view=oberhaus&date=1-15',
  'street-winter': `${STREET}&date=1-15`,
  'dom-snow': 'view=dom&date=1-15&weather=snow',
  // tiny scenes (crop=192: the 128 m tiles within 192 m of the camera's target, 3-4 a side), ~15 s a shot
  'tiny-street': `${STREET}&crop=192`,
  'tiny-dom': 'cam=1610,95,560,1700,20,700&crop=192',
};
const SETS = {
  quick: ['tiny-street', 'tiny-dom'],
  default: ['overview', 'oberhaus', 'street', 'street-night'],
  seasons: ['oberhaus', 'oberhaus-autumn', 'oberhaus-winter', 'street-winter'],
  all: Object.keys(SHOTS),
};
const BASE = { ui: '0', autores: '0', weather: 'clear', date: '7-15', hour: '13' };
// --focus: name -> the view's query (az: compass bearing the camera stands at, el: degrees over the horizon)
export const FOCUS_SHOTS = {
  'f-sw': 'az=225', 'f-se': 'az=135', 'f-ne': 'az=45', 'f-nw': 'az=315', 'f-top': 'az=190&el=70',
  'f-night': 'az=225&hour=22',
};

const HELP = `usage: node tools/shoot.mjs --out DIR [--shots a,b,name=query] [--set ${Object.keys(SETS).join('|')}]
  [--compare REFDIR] [--fail PCT] [--q "extra=query"] [--crop METRES] [--size WxH] [--phone] [--focus bld:ID|street:ID]
  [--url http://host:port/] [--port 5194] [--no-build] [--no-shoot] [--wait MS] [--timeout MS]
  [--gl llvmpipe|swiftshader|gpu] [--eval "JS expression"] [--list]
shots: ${Object.keys(SHOTS).join(', ')}; with --focus: ${Object.keys(FOCUS_SHOTS).join(', ')}`;

function args(argv) {
  const o = { shots: null, set: null, out: null, compare: null, fail: 0.5, q: '', crop: null, size: '1280x800', phone: false,
    url: null, port: 5194, build: true, wait: 1500, timeout: 600000, gl: 'llvmpipe', list: false, shoot: true, eval: null, focus: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--shots') o.shots = v().split(',');
    else if (a === '--set') o.set = v();
    else if (a === '--out') o.out = v();
    else if (a === '--compare') o.compare = v();
    else if (a === '--fail') o.fail = +v();
    else if (a === '--q') o.q = v();
    else if (a === '--crop') o.crop = v();
    else if (a === '--size') o.size = v();
    else if (a === '--phone') { o.phone = true; o.size = '412x860'; }
    else if (a === '--url') o.url = v();
    else if (a === '--port') o.port = +v();
    else if (a === '--no-build') o.build = false;
    else if (a === '--wait') o.wait = +v();
    else if (a === '--timeout') o.timeout = +v();
    else if (a === '--gl') o.gl = v();
    else if (a === '--list') o.list = true;
    else if (a === '--no-shoot') o.shoot = false;
    else if (a === '--eval') o.eval = v();
    else if (a === '--focus') o.focus = v();
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else { console.error('unknown argument', a, '\n' + HELP); process.exit(2); }
  }
  return o;
}

const opt = args(process.argv.slice(2));
if (opt.list) { for (const [k, v] of Object.entries(SHOTS)) console.log(k.padEnd(18), v); for (const [k, v] of Object.entries(SETS)) console.log('set', k.padEnd(14), v.join(',')); process.exit(0); }
if (!opt.out) { console.error(HELP); process.exit(2); }
if (opt.focus) {
  if (!/^(bld|street):[wr]?\d+$/.test(opt.focus)) { console.error('--focus: bld:<id>, bld:r<id> or street:<id>'); process.exit(2); }
  for (const [k, v] of Object.entries(FOCUS_SHOTS)) SHOTS[k] = `focus=${opt.focus}&${v}${opt.crop ? '' : '&crop=fit'}`;
}
const names = opt.shots ?? (opt.focus && opt.shoot ? Object.keys(FOCUS_SHOTS) : null) ?? (opt.shoot ? SETS[opt.set ?? 'default'] : fs.readdirSync(opt.out).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));
if (!names) { console.error('unknown set', opt.set); process.exit(2); }
const shots = names.map((n) => {
  const eq = n.indexOf('=');
  if (eq > 0 && !(n in SHOTS)) return [n.slice(0, eq), n.slice(eq + 1)];
  if (!(n in SHOTS) && opt.shoot) { console.error('unknown shot', n, '(name=query for an ad-hoc one; --list)'); process.exit(2); }
  return [n, SHOTS[n]];
});
fs.mkdirSync(opt.out, { recursive: true });

function query(q) {
  const p = new URLSearchParams(BASE);
  for (const extra of [q, opt.q, opt.crop ? `crop=${opt.crop}` : '']) for (const [k, v] of new URLSearchParams(extra)) p.set(k, v);
  return p.toString();
}

// --- the server -------------------------------------------------------------------------------------------------
let server = null;
async function serve() {
  if (opt.url) return opt.url;
  const t = Date.now();
  if (opt.build) {
    execFileSync(VITE, ['build', '--logLevel', 'error'], { cwd: WEB, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`built dist in ${Date.now() - t} ms`);
  } else if (!fs.existsSync(path.join(WEB, 'dist/index.html'))) { console.error('no web/dist: drop --no-build'); process.exit(2); }
  const url = `http://127.0.0.1:${opt.port}/`;
  server = spawn(VITE, ['preview', '--port', String(opt.port), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) { console.error('vite preview exited:\n' + log); process.exit(2); }
    try { if ((await fetch(url)).ok) return url; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('vite preview did not answer on', url, '\n' + log);
  stop();
  process.exit(2);
}
function stop() {
  if (server && server.exitCode === null) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } }
}
process.on('SIGINT', () => { stop(); process.exit(130); });

// --- shooting ---------------------------------------------------------------------------------------------------
const GL = {
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  // Mesa's llvmpipe through ANGLE's Vulkan (Linux/WSL with Mesa): a multithreaded software rasterizer
  llvmpipe: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  gpu: ['--enable-gpu', '--ignore-gpu-blocklist'],
};
if (!GL[opt.gl]) { console.error('--gl: llvmpipe, swiftshader or gpu'); process.exit(2); }
async function launch(gl) {
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: GL[gl] });
  const p = await b.newPage();
  const renderer = await p.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2'), e = c?.getExtension('WEBGL_debug_renderer_info');
    return c ? String(e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)) : null;
  });
  await p.close();
  return { browser: b, renderer };
}
let browser = null, renderer = null;
if (opt.shoot) {
  ({ browser, renderer } = await launch(opt.gl));
  if (!renderer && opt.gl !== 'swiftshader') {
    console.log(`no WebGL2 with --gl ${opt.gl}: falling back to swiftshader`);
    await browser.close();
    opt.gl = 'swiftshader';
    ({ browser, renderer } = await launch(opt.gl));
  }
  console.log(`renderer: ${renderer}`);
} else browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = opt.shoot ? await serve() : null;
const [w, h] = opt.size.split('x').map(Number);
const report = { url: base, size: [w, h], gl: opt.gl, renderer, shots: {} };
const NOISE = /GPU stall due to ReadPixels/;
try {
  if (opt.shoot) for (const [name, q] of shots) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: opt.phone, hasTouch: opt.phone });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !NOISE.test(m.text())) errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`); });
    let tiles = 0;
    page.on('requestfinished', (r) => { if (r.url().includes('/data/tiles/')) tiles++; });
    const full = `${base}?${query(q)}`;
    const t0 = Date.now();
    await page.goto(full, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: opt.timeout });
    const ready = Date.now() - t0;
    let settled = true;
    await page.waitForFunction(() => { const c = window.__three.city(); return c?.complete && c?.settled && window.__streamer?.idle; }, null, { timeout: opt.timeout, polling: 100 })
      .catch(() => { settled = false; });
    const loaded = Date.now() - t0;
    // what moves held still: comparable between runs
    await page.evaluate(() => {
      const T = window.__three, u = T.daylight.uniforms.uTime;
      Object.defineProperty(u, 'value', { get: () => 100, set() {} });
      T.daylight.clouds.tick(100); T.daylight.clouds.tick = () => {};
      if (window.__life) { window.__life.group.visible = false; window.__life.update = () => {}; }
      T.daylight.redrawShadow(true);
    });
    const frozen = Date.now() - t0;
    await page.waitForTimeout(opt.wait);
    // a frame's time now (median of 3 animation frames: in SwiftShader this, not the loading, often dominates)
    const frameMs = await page.evaluate(() => new Promise((res) => {
      const t = []; const f = (now) => { t.push(now); if (t.length < 4) requestAnimationFrame(f); else res(Math.round([t[1] - t[0], t[2] - t[1], t[3] - t[2]].sort((x, y) => x - y)[1])); };
      requestAnimationFrame(f);
    }));
    const file = path.join(opt.out, `${name}.png`);
    const before = Date.now() - t0;
    await page.screenshot({ path: file });
    const shotMs = Date.now() - t0 - before;
    const info = await page.evaluate(() => {
      const c = window.__three.city();
      return { nodes: c?.lod?.shownBy ?? null, crop: c?.crop ?? null };
    }).catch(() => ({}));
    if (opt.eval) {
      info.eval = await page.evaluate((e) => { try { return JSON.parse(JSON.stringify((0, eval)(e)) ?? 'null'); } catch (err) { return 'error: ' + err.message; } }, opt.eval);
      console.log(`${name} eval:`, JSON.stringify(info.eval));
    }
    const total = Date.now() - t0;
    report.shots[name] = { query: query(q), readyMs: ready, loadedMs: loaded, totalMs: total, frozenMs: frozen, screenshotMs: shotMs, frameMs, settled, tileFiles: tiles, ...info, errors };
    console.log(`${name.padEnd(18)} ${String(total).padStart(6)} ms (ready ${ready}, loaded ${loaded}, frame ${frameMs}${settled ? '' : ', NOT settled'}) tiles ${tiles} nodes ${JSON.stringify(info.nodes)}${errors.length ? `  ${errors.length} errors/warnings (shots.json)` : ''}`);
    await ctx.close();
  }

  // --- comparing -------------------------------------------------------------------------------------------------
  if (opt.compare) {
    const page = await browser.newPage();
    fs.mkdirSync(path.join(opt.out, 'diff'), { recursive: true });
    let worst = 0;
    report.diff = {};
    try {
      const ref = JSON.parse(fs.readFileSync(path.join(opt.compare, 'shots.json'), 'utf8'));
      const was = JSON.parse(opt.shoot ? 'null' : fs.readFileSync(path.join(opt.out, 'shots.json'), 'utf8'));
      const gl = opt.shoot ? opt.gl : was?.gl;
      if (ref.gl !== gl || String(ref.size) !== String(opt.shoot ? [w, h] : was?.size)) console.log(`WARNING: reference shot with --gl ${ref.gl} at ${ref.size}, these with ${gl} at ${opt.shoot ? [w, h] : was?.size}`);
    } catch { /* no shots.json there */ }
    console.log(`\n${'shot'.padEnd(18)} mean|d|   px>8 %  px>24 %   vs ${opt.compare}`);
    for (const [name] of shots) {
      const a = path.join(opt.compare, `${name}.png`), b = path.join(opt.out, `${name}.png`);
      if (!fs.existsSync(a)) { console.log(`${name.padEnd(18)} (no reference)`); continue; }
      const r = await page.evaluate(diffInPage, [fs.readFileSync(a).toString('base64'), fs.readFileSync(b).toString('base64')]);
      if (r.error) { console.log(`${name.padEnd(18)} ${r.error}`); worst = Infinity; continue; }
      fs.writeFileSync(path.join(opt.out, 'diff', `${name}.png`), Buffer.from(r.png, 'base64'));
      delete r.png;
      report.diff[name] = r;
      worst = Math.max(worst, r.px24);
      console.log(`${name.padEnd(18)} ${r.mean.toFixed(2).padStart(7)} ${r.px8.toFixed(2).padStart(8)} ${r.px24.toFixed(2).padStart(8)}`);
    }
    report.worstPx24 = worst;
    if (worst > opt.fail) { console.log(`\nFAIL: px>24 ${worst.toFixed(2)} % > ${opt.fail} % (images in ${path.join(opt.out, 'diff')})`); process.exitCode = 1; }
    else console.log(`\nok: px>24 at most ${worst.toFixed(2)} % (<= ${opt.fail} %)`);
  }
} finally {
  if (opt.shoot) fs.writeFileSync(path.join(opt.out, 'shots.json'), JSON.stringify(report, null, 1));
  await browser.close();
  stop();
}

// runs in the page: two PNGs (base64) -> the numbers and a side-by-side image
async function diffInPage([a64, b64]) {
  const load = async (s) => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); return im; };
  const [A, B] = await Promise.all([load(a64), load(b64)]);
  if (A.width !== B.width || A.height !== B.height) return { error: `size differs: ${A.width}x${A.height} vs ${B.width}x${B.height}` };
  const W = A.width, H = A.height, c = document.createElement('canvas');
  c.width = W * 3; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(A, 0, 0); g.drawImage(B, W, 0);
  const a = g.getImageData(0, 0, W, H).data, b = g.getImageData(W, 0, W, H).data, d = g.createImageData(W, H);
  let sum = 0, n8 = 0, n24 = 0;
  for (let i = 0; i < a.length; i += 4) {
    const r = Math.abs(a[i] - b[i]), gg = Math.abs(a[i + 1] - b[i + 1]), bb = Math.abs(a[i + 2] - b[i + 2]), m = Math.max(r, gg, bb);
    sum += r + gg + bb;
    if (m > 8) n8++;
    if (m > 24) n24++;
    const v = Math.min(255, m * 4);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
  }
  g.putImageData(d, 2 * W, 0);
  const px = W * H;
  return { mean: sum / (px * 3), px8: (100 * n8) / px, px24: (100 * n24) / px, png: c.toDataURL('image/png').split(',')[1] };
}
