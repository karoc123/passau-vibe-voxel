#!/usr/bin/env node
// Standing close to a wall the view must not go through it. In the page (its own vite dev server, headless Chrome, a
// tiny scene by the Innstadt's curved facade): the walker walks on foot into a diagonal wall (its slanted face drawn up
// to a metre in front of the voxels, chamfer.ts), into a flat one, and diagonally into a building's outer corner, then
// stands; the scene is drawn once more as the distance from the camera, and every sample of the view's middle must be
// a wall within WALL m -- not the sky, nor the street beyond. And a car backed up against the wall: its chase camera
// (nav/ride.ts) on the car's side of the wall, out of it.
// usage (in web/): node tools/wall-view.mjs [--port 5250] [--keep] (--keep: the browser window's PNGs under /tmp)
import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'vite';
import { web } from './data-dir.mjs';

const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright-core');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WALL = 2.5;
// the scene (?cam= in the project grid) and, in world metres, a spot in the street before the curved facade
const Q = 'play&cam=2006,22,687,2060,23,696&crop=192&ui=0&autores=0&weather=clear&date=7-15&hour=13&taa=0';
const SPOT = { x: 8244.5, z: 2760.5 };

const server = await createServer({ root: web, logLevel: 'error', server: { host: '127.0.0.1', port: +opt('--port', 5250) } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const results = [];
const check = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`); };
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}?${Q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.waitForFunction(() => { const c = window.__three.city(); return c?.complete && c?.settled && window.__streamer?.idle; }, null, { timeout: 300000, polling: 200 });
  await page.evaluate(() => {
    if (window.__life) { window.__life.group.visible = false; window.__life.update = () => {}; }
    const T = window.__three, SM = T.scene.children.find((o) => o.material?.isShaderMaterial).material.constructor;
    // the distance from the camera, front faces only (as the tiles are drawn): 1 where nothing is
    const depth = new SM({
      vertexShader: 'varying vec3 wp; void main() { wp = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0); }',
      fragmentShader: 'varying vec3 wp; void main() { gl_FragColor = vec4(min(distance(wp, cameraPosition) / 64.0, 1.0), 0.0, 0.0, 1.0); }',
    });
    // the view's middle (the middle third each way) as distances, the camera as it is now
    window.__wallView = () => {
      const R = T.renderer, gl = R.getContext(), sc = T.scene, was = sc.overrideMaterial, sky = sc.children.filter((o) => o.material?.isShaderMaterial);
      for (const o of sky) o.visible = false;
      sc.overrideMaterial = depth;
      R.setRenderTarget(null); R.setClearColor(0xffffff, 1); R.clear(); R.render(sc, T.camera);
      sc.overrideMaterial = was;
      for (const o of sky) o.visible = true;
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(4), out = [];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
        gl.readPixels(Math.round(W * (1 / 3 + i / 12)), Math.round(H * (1 / 3 + j / 12)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push(+(px[0] / 255 * 64).toFixed(2));
      }
      return out;
    };
    // W held for ms of the game's own clock: the frames' dt as the frame loop counts it (app/frame.ts, at most 0.1 s a
    // frame), so a loaded machine drawing a few frames a second walks as far as an idle one; pressed and let go here,
    // in a frame, not a round trip from the tool later. With `to`, let go once the walker stops nearing it for 0.2 s:
    // walked diagonally into an outer corner it either stops there or slides on along a face, as the frames fall
    const key = (type) => dispatchEvent(new KeyboardEvent(type, { code: 'KeyW', key: 'w' }));
    const frames = (ms, each) => new Promise((done) => {
      let t = 0, last = null;
      const tick = (now) => {
        if (last !== null) t += Math.min(0.1, (now - last) / 1000);
        last = now;
        if (t * 1000 >= ms || each?.(t)) done(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    window.__walk = async (ms, to) => {
      const f = window.__three.nav.foot, far = () => Math.hypot(f.pos.x - to.x, f.pos.z - to.z);
      let best = Infinity, since = 0;
      await frames(300);
      key('keydown');
      await frames(ms, to && ((t) => { const d = far(); if (d < best - 0.01) { best = d; since = t; } return t - since > 0.2; }));
      key('keyup');
      await frames(300);
    };
  });
  const world = (fn, a) => page.evaluate(fn, a);
  // on foot at (x, z) facing yaw, then W held for ms of game time (or until it stops nearing `to`); the walker's eyes
  // and the view's distances
  const walkInto = async (at, yaw, ms, to) => {
    await world(async ([at, yaw]) => {
      const nav = window.__three.nav, V = window.__three.camera.position.constructor;
      if (!nav.onFoot) await nav.setWalk({ at: new V(at.x, nav.world.support(at.x, at.z, 60), at.z), exact: true, ms: 1 });
      const f = nav.foot;
      f.pos.x = at.x; f.pos.z = at.z; f.feet = nav.world.support(at.x, at.z, f.feet + 3); f.yaw = yaw; f.pitch = 0;
    }, [at, yaw]);
    await world(([ms, to]) => window.__walk(ms, to), [ms, to]);
    return world(() => ({ eye: window.__three.camera.position.toArray().map((v) => +v.toFixed(2)), view: window.__wallView() }));
  };
  const blocked = (v) => Math.max(...v.view) <= WALL;

  // the curved facade south of the spot: a staircase of 1 m steps drawn as one slanted wall
  const diag = await walkInto(SPOT, Math.PI, 2500);
  check('diagonal_wall', blocked(diag), diag);
  // the nearest flat wall (a run of 4 m along x or z at eye height) and an outer corner, looked for round the spot
  const found = await world((at) => {
    const w = window.__three.nav.world, y = Math.floor(w.support(at.x, at.z, 60)) + 1;
    const solid = (x, z) => w.blocked(x, z, y, y + 1);
    let flat = null, corner = null;
    for (let r = 2; r < 40 && !(flat && corner); r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const X = Math.floor(at.x) + dx, Z = Math.floor(at.z) + dz;
      if (!solid(X, Z)) continue;
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        // (a face towards (sx, sz): 4 m of it, open for 4 m before it, standing ground there level with the spot's)
        if (flat) break;
        let ok = true;
        for (let k = -2; k <= 2 && ok; k++) {
          const ax = X + (sz ? k : 0), az = Z + (sx ? k : 0);
          ok = solid(ax, az) && w.blocked(ax, az, y + 1, y + 2);
          for (let d = 1; d <= 4 && ok; d++) ok = !solid(ax + sx * d, az + sz * d) && !w.blocked(ax + sx * d, az + sz * d, y - 1 + 0.5, y + 2);
        }
        if (ok) flat = { x: X + 0.5 + sx * 3.5, z: Z + 0.5 + sz * 3.5, yaw: Math.atan2(-sx, -sz) };
      }
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        // (a cell solid two storeys up whose neighbours towards (sx, sz) are all open, 4 m out)
        if (corner) break;
        let ok = w.blocked(X, Z, y + 1, y + 5) && solid(X - sx, Z) && solid(X, Z - sz);
        for (let a = 0; a <= 4 && ok; a++) for (let b = 0; b <= 4 && ok; b++) if (a || b) ok = !w.blocked(X + sx * a, Z + sz * b, y - 1 + 0.5, y + 2);
        if (ok) corner = { x: X + 0.5 + sx * 3, z: Z + 0.5 + sz * 3, yaw: Math.atan2(-sx, -sz), at: { x: X + 0.5 + sx * 0.5, z: Z + 0.5 + sz * 0.5 } };
      }
    }
    return { flat, corner };
  }, SPOT);
  if (!found.flat || !found.corner) check('spots', false, { found, want: 'a flat wall and an outer corner near the spot (the data changed: pick another SPOT)' });
  else {
    const f = await walkInto(found.flat, found.flat.yaw, 2000);
    check('flat_wall', blocked(f), { ...f, from: found.flat });
    const c = await walkInto(found.corner, found.corner.yaw, 2500, found.corner.at);
    check('outer_corner', blocked(c), { ...c, from: found.corner });
    // a car backed up to the flat wall (its tail 0.3 m off it), the chase camera as the ride puts it
    const car = await world((at) => {
      const nav = window.__three.nav, w = nav.world, V = window.__three.camera.position.constructor;
      // (the face 3 m ahead of the spot, the car's middle 2.6 m off it, facing away)
      const d = 3 - 2.6, pose = { x: at.x + Math.sin(at.yaw) * d, y: w.support(at.x, at.z, 60), z: at.z + Math.cos(at.yaw) * d, h: at.yaw + Math.PI };
      const R = { ref: { kind: 'car' }, view: 'behind', dyaw: 0, dpitch: 0, idle: performance.now(), zoom: 1 };
      const { pos } = nav.rider.camera.frame(R, { kind: 'car', bus: false }, { ...pose }, w, true, 1 / 60);
      // from the car's roof to the camera: nothing in between, and the camera out of the voxels
      const eye = new V(pose.x, pose.y + 1.5, pose.z), dir = pos.clone().sub(eye), L = dir.length();
      const hit = w.raycast(eye, dir.normalize(), L + 1);
      return { pose, cam: pos.toArray().map((v) => +v.toFixed(2)), free: hit >= L + 0.5, inside: w.blocked(Math.floor(pos.x), Math.floor(pos.z), Math.floor(pos.y), pos.y + 0.01) };
    }, found.flat);
    check('car_chase_backed_up', car.free && !car.inside, car);
  }
  if (errors.length) check('page_errors', false, errors.slice(0, 5));
  if (args.includes('--keep')) await page.screenshot({ path: '/tmp/wall-view.png' });
} finally {
  await browser.close();
  await server.close();
}
process.exit(results.length && results.every(Boolean) ? 0 : 1);
