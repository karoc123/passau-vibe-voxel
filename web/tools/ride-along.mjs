// Riding along in another player's car on a touch screen, in headless Chrome (a page with touch, from a vite dev server
// of its own; the host, src/host/ws.ts on the real data, and the driver's client, Node's WebSocket, in this process).
// D takes the wheel of a car of the traffic standing by the cathedral; P walks up beside it, is offered a seat
// (nav/board.ts) and taps the button to ride along; a finger dragged across the screen turns P's view round the car
// (nav/nav.ts: a passenger has no drive sticks), as dragging does in a craft. The seat switch's button (nav/board.ts
// swap) is not shown in the car; P gets out and takes the speedboat's wheel on the Danube below, where it is shown, and a
// tap on it moves P to the gun, another back to the wheel. Then with mouse and keyboard: C to the gun and back, a click
// at the gun and on foot (out with X) firing shots the host records; the combat plane from the map, the mouse taken;
// the boat's chase view swung by the mouse; every aircraft from the map, its pilot's view not turned by the mouse, X
// low in the air (no canopy fits) leaving P beside it at its height, falling; X high up putting P under a paraglider
// that flies; first of all, on the map, the wheel zooms (orbit mode's alone); the grappling hook's touch button shown there; X under the
// paraglider folding it away and X in the fall opening one again; last, on foot, a tap on the hook button firing a hook.
// usage (in web/): node tools/ride-along.mjs [-v] [--headed]; prints PASS/FAIL lines
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { imp } from './lib.mjs';
import { dataDir, web } from './data-dir.mjs';

if (!fs.existsSync(path.join(dataDir, 'meta.json'))) { console.log(`SKIP ride-along: no ${dataDir}/meta.json`); process.exit(0); }
const verbose = process.argv.includes('-v'), headed = process.argv.includes('--headed');
const { chromium } = createRequire(path.join(web, 'package.json'))('playwright-core');
const log = (...a) => { if (verbose) console.log(' ', ...a); };
const results = [];
const check = (ok, what) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms) => { for (const t = Date.now(); Date.now() - t < ms; await wait(100)) if (await ok()) return true; return false; };

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const { serve } = await imp('src/host/ws.ts');
const { MirrorSimClient } = await imp('src/client/sim-client.ts');
const { SocketLink } = await imp('src/client/sim-worker-link.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { readHostData } = await imp('src/host/node.ts');
const { vehicleOf } = await imp('src/sim/vehicles.ts');
const { AIRCRAFT } = await imp('src/nav/craft.ts');
const { craftMeets, reach } = await imp('src/sim/solids.ts');
const GLIDE = (await imp('src/sim/craft/craft-motion.ts')).CRAFT.paraglider;
const host = serve({ dir: dataDir, host: '127.0.0.1', port: 0, query: 'seed=3', log: (l) => log(`host: ${l}`) });
const hostPort = await host.port, sim = host.server.sim;
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-along-gate-'));
const vitePort = await freePort();
const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: web, env: { ...process.env, VOXEL_PUBLIC: path.dirname(dataDir), VOXEL_VITE_CACHE: cache, VITE_HOST_PORT: String(hostPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
process.on('exit', () => { vite.kill(); fs.rmSync(cache, { recursive: true, force: true }); });
let frames = null;
const done = (code) => { clearInterval(frames); host.close(); process.exit(code); };
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)) break;
  if (i > 300 || vite.exitCode !== null) { console.log(`FAIL ride-along: vite did not start\n${viteLog}`); done(1); }
  await wait(100);
}

const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };

// D: a client of the host's own (the page's client and link over Node's WebSocket), its frames on a timer
const link = new SocketLink(`ws://127.0.0.1:${hostPort}`);
const D = new MirrorSimClient(link, readHostData(dataDir).traffic, null, host.server.hello);
frames = setInterval(() => D.update(STEP), 1000 * STEP);
D.send({ kind: 'view', view: { focus: { x: dom.x, z: dom.y } } });
await until(() => D.player && sim.physics, 120000);
// (a car standing by the cathedral, with a seat beside the driver's)
let car = null;
await until(() => {
  const far = (c) => { const p = sim.entities.pose({ kind: 'car', id: c.id }); return p ? Math.hypot(p.x - dom.x, p.z - dom.y) : Infinity; };
  car = sim.traffic.cars.filter((c) => !c.bus && vehicleOf(c).id !== 'moto' && c.v < 0.1).sort((a, b) => far(a) - far(b))[0] ?? null;
  return car;
}, 60000);
const ref = car && { kind: 'car', id: car.id }, pose = () => sim.entities.pose(ref);
const side = (d) => { const p = pose(); return { x: p.x + Math.cos(p.h) * (0.9 + d), y: p.y, z: p.z - Math.sin(p.h) * (0.9 + d), h: p.h }; };
// (beside it and asked again until in: on a busy machine the seat was asked for before the host had D beside it, or
// the car had moved on meanwhile, and the one refusal was the end of it)
const refused = [];
for (const t0 = Date.now(); car && D.seat()?.role !== 'driver' && Date.now() - t0 < 60000; ) {
  const s = side(1), beside = () => { const e = D.seat()?.entity, p = e && sim.entities.pose(e); return p && Math.hypot(p.x - s.x, p.z - s.z) < 1; };
  D.send({ kind: 'request', request: { kind: 'walk', pose: { x: s.x, y: s.y, z: s.z, h: 0, moving: false } } });
  await until(() => D.seat()?.role === 'walker' && beside(), 10000);
  D.results('enterSeat');
  D.send({ kind: 'enterSeat', entity: ref, role: 'driver' });
  const n = refused.length;
  await until(() => D.seat()?.role === 'driver' || (refused.push(...D.results('enterSeat').filter((r) => !r.ok)), refused.length > n), 10000);
}
if (refused.length) log(`D refused first: ${JSON.stringify(refused)}`);
check(D.seat()?.role === 'driver', `D at the wheel of a car standing by the cathedral (${car && `${vehicleOf(car).id} ${car.id}`}, ${JSON.stringify(D.seat())})`);

// P: a page on a touch screen near it, on foot 1.5 m off its far side
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const at = pose() ?? { x: dom.x, y: 14, z: dom.y };
const cam = `${at.x + ox},${at.y + 40},${at.z + oz + 40},${at.x + ox},${at.y},${at.z + oz}`;
const Q = `server=ws://127.0.0.1:${hostPort}&cam=${cam}&crop=256&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0&weather=clear&hour=13`;
const ctx = await browser.newContext({ viewport: { width: 960, height: 640 }, hasTouch: true });
const P = await ctx.newPage();
P.on('pageerror', (e) => console.log(`  P page error: ${e.message}`));
await P.goto(`http://127.0.0.1:${vitePort}/?${Q}`);
await P.waitForFunction(() => window.__sim?.player && window.__crafts && window.__life?.group.visible, null, { timeout: 300000 });
// in orbit mode the wheel zooms: turned back, the camera is further from what it looks at
const far = () => P.evaluate(() => { const T = window.__three; return T.camera.position.distanceTo(T.controls.target); });
const far0 = await far();
await P.mouse.move(480, 320);
await P.mouse.wheel(0, 300);
await until(async () => await far() > far0 * 1.05, 5000);
const far1 = await far();
check(far1 > far0 * 1.05, `in orbit mode the wheel zooms out (${far0.toFixed(0)} -> ${far1.toFixed(0)} m from the view's target)`);
const s = side(-2 * 0.9 - 1.5);
await P.evaluate((s) => { const T = window.__three; void T.nav.setWalk({ at: T.camera.position.clone().set(s.x, s.y, s.z), exact: true }); }, s);
const offered = await P.waitForFunction(() => window.__three.nav.onFoot && document.querySelector('#board-button:not([hidden])')?.textContent, null, { timeout: 60000 })
  .then((h) => h.jsonValue()).catch(() => null);
check(/^Ride along in /.test(offered ?? ''), `P on foot beside it is offered a seat beside D: ${JSON.stringify(offered)}`);
await P.tap('#board-button').catch(() => {});
const aboard = await P.waitForFunction(() => window.__sim.seat()?.role === 'passenger' && window.__three.nav.mode === 'ride' && window.__three.nav.ride, null, { timeout: 15000 })
  .then(() => true, () => false);
check(aboard, `a tap on it: P rides along in D's car (${JSON.stringify(await P.evaluate(() => ({ seat: window.__sim.seat(), mode: window.__three.nav.mode })))})`);

// a finger dragged across the screen: the view turns round the car
const cdp = await ctx.newCDPSession(P);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const before = await P.evaluate(() => window.__three.nav.ride?.dyaw ?? null);
await touch('touchStart', 300, 320);
for (let i = 1; i <= 10; i++) { await touch('touchMove', 300 + i * 30, 320); await wait(30); }
await touch('touchEnd');
const after = await P.evaluate(() => window.__three.nav.ride?.dyaw ?? null);
log(`dyaw ${before} -> ${after}`);
check(before !== null && after !== null && Math.abs(after - before) > 0.3, `a finger dragged across the screen turns P's view round the car (${before?.toFixed(2)} -> ${after?.toFixed(2)} rad)`);

// the seat switch: none in a car (it has no gun); in the speedboat, from the wheel to the gun and back
const seatButton = () => P.evaluate(() => { const b = document.querySelector('#seat-button'); return b && getComputedStyle(b).display !== 'none' ? b.textContent : null; });
check(aboard && await seatButton() === null, 'riding along in the car: no seat switch shown');
const BOAT = { x: 8160.5, z: 2880.5, h: 1.8 };
await P.tap('#board-button').catch(() => {});
await P.waitForFunction(() => window.__three.nav.onFoot, null, { timeout: 30000 }).catch(() => {});
await P.evaluate((at) => window.__crafts.find((c) => c.id === 'boat').enter(at), BOAT);
// (the page's boat shell on too, not the host's seat alone: under load the page was once left out of it, C and W doing
// nothing)
const piloting = () => P.waitForFunction(() => window.__sim.seat()?.role === 'pilot' && window.__sim.craftOf()?.type === 'boat' && window.__sim.craftOf().placed
  && window.__three.nav.craft?.id === 'boat', null, { timeout: 60000 }).then(() => true, () => false);
const seatNow = () => P.evaluate(() => `${JSON.stringify(window.__sim.seat())}, the page's shell ${window.__three.nav.craft?.id ?? 'none'}`);
const atWheel = await piloting();
const toGun = atWheel && await P.waitForFunction(() => { const b = document.querySelector('#seat-button'); return b && getComputedStyle(b).display !== 'none' && b.textContent; }, null, { timeout: 10000 })
  .then((h) => h.jsonValue(), () => null);
check(toGun === 'To the gun', `at the speedboat's wheel the seat switch is shown: ${JSON.stringify(toGun)} (${JSON.stringify(await P.evaluate(() => window.__sim.seat()))})`);
await P.tap('#seat-button').catch(() => {});
const gunner = await P.waitForFunction(() => window.__sim.seat()?.role === 'passenger' && window.__three.nav.craft?.id === 'passenger', null, { timeout: 15000 }).then(() => true, () => false);
const toWheel = gunner && await until(async () => (await seatButton()) === 'To the wheel', 10000);
check(gunner && toWheel, `a tap on it: P at the gun, the button saying To the wheel (${JSON.stringify(await P.evaluate(() => window.__sim.seat()))}, ${JSON.stringify(await seatButton())})`);
await P.tap('#seat-button').catch(() => {});
check(await piloting(), `another tap: P back at the wheel (${await seatNow()})`);

// with mouse and keyboard: C to the gun shows the crosshair and takes the mouse (a key press is the gesture Chrome
// wants), a click fires (the host's shot), C back steers; the lock refused (a browser wanting a click), the crosshair
// still shown and the first click both takes the mouse and fires; out of the boat with X, on foot the crosshair again,
// the mouse taken and a click fires
const crosshair = () => P.evaluate(() => !!document.querySelector('#arms .crosshair')?.checkVisibility());
const locked = () => P.evaluate(() => document.pointerLockElement === document.querySelector('canvas'));
// (the button held over two of the page's frames at least: the trigger is read once a frame, and with the machine busy
// a frame took longer than the 120 ms click, which then fired nothing)
const frames2 = () => P.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const firesOnClick = async () => {
  const me = await P.evaluate(() => window.__sim.player), t0 = sim.tick;
  await P.mouse.move(480, 320);
  await P.mouse.down(); await Promise.all([wait(120), frames2()]); await P.mouse.up();
  const ok = await until(() => sim.eventsSince(t0).some((e) => e.kind === 'shot' && e.player === me), 10000);
  if (!ok) log('no shot', JSON.stringify(await P.evaluate(() => { const n = window.__three.nav; return { held: n.held, mode: n.mode, slot: n.arms.slot, lock: !!document.pointerLockElement, seat: window.__sim.seat() }; })), JSON.stringify(sim.eventsSince(t0).map((e) => e.kind)));
  return ok;
};
const gunCycle = async (refuse) => {
  // (the mouse given back, as by a lock lost, and the next asked for refused once, as by a browser without a click)
  if (refuse) {
    await P.evaluate(() => {
      window.__three.nav.releaseMouse();
      const c = document.querySelector('canvas'), own = c.requestPointerLock;
      c.requestPointerLock = () => { c.requestPointerLock = own; document.dispatchEvent(new Event('pointerlockerror')); return Promise.reject(new Error('refused')); };
    });
  }
  await P.keyboard.press('KeyC');
  const atGun = await P.waitForFunction(() => window.__sim.seat()?.role === 'passenger' && window.__three.nav.craft?.id === 'passenger', null, { timeout: 15000 }).then(() => true, () => false);
  await until(async () => atGun && await crosshair() && await locked() === !refuse, 10000);
  const seen = atGun && await crosshair(), mouse = await locked();
  check(seen && mouse === !refuse, `C at the wheel${refuse ? ', the lock refused' : ''}: P at the gun, the crosshair shown, the mouse ${mouse ? 'taken' : 'not taken'}`);
  const fired = atGun && await firesOnClick(), after = await locked();
  check(fired && after, `${refuse ? 'the first' : 'a'} click at the gun fires a shot the host records (the mouse taken: ${after})`);
  await P.keyboard.press('KeyC');
  const back = await piloting(), boatId = await P.evaluate(() => window.__sim.craftOf()?.id);
  const v0 = sim.crafts.get(boatId)?.core.motion.speed ?? 0, w0 = sim.tick;
  // (held until the boat is 1 m/s faster, ~10 host ticks alone, not for a fixed 1.5 s: the keys go with the page's
  // frames, fewer on a busy machine)
  await P.keyboard.down('KeyW'); await until(() => (sim.crafts.get(boatId)?.core.motion.speed ?? 0) > v0 + 1, 15000); await P.keyboard.up('KeyW');
  const v1 = sim.crafts.get(boatId)?.core.motion.speed ?? 0, kept = await locked();
  check(back && kept && v1 > v0 + 1, `C again: P back at the wheel, the mouse kept (${kept}: the boat's view turns with it), W drives the boat (${v0.toFixed(1)} -> ${v1.toFixed(1)} m/s in ${sim.tick - w0} host ticks)`);
};
// how far a mouse move of 250 px turns the chase view round the craft piloted (the view's bearing against the craft's
// heading, so its own turning does not count), rad
const yaw = () => P.evaluate(() => { const d = window.__three.camera.getWorldDirection(window.__three.camera.position.clone()); return Math.atan2(d.x, d.z) - (window.__sim.craftOf()?.core.pose.h ?? 0); });
const swung = async () => {
  const y0 = await yaw();
  for (let i = 1; i <= 10; i++) { await P.mouse.move(480 + i * 25, 320); await wait(20); }
  await wait(200);
  const y1 = await yaw();
  await P.mouse.move(480, 320);
  return Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0)));
};
await gunCycle(false);
const boatTurn = await locked() ? await swung() : -1;
check(boatTurn > 0.3, `at the speedboat's wheel the mouse moved swings the chase view (${boatTurn.toFixed(2)} rad)`);
await gunCycle(true);
await P.keyboard.press('KeyX');
const onFoot = await P.waitForFunction(() => window.__three.nav.onFoot && window.__sim.seat()?.role === 'walker', null, { timeout: 30000 }).then(() => true, () => false);
await until(async () => onFoot && await crosshair() && await locked(), 10000);
const footMouse = await locked();
check(onFoot && await crosshair() && footMouse, `X: P out of the boat on foot, the crosshair shown, the mouse taken (${footMouse})`);
check(onFoot && await firesOnClick(), 'a click on foot fires a shot the host records');

// up to the map and into the combat plane by its button: flying, the mouse taken as at the gun (Nav follows any craft
// that aims with the mouse; the plane was missed once), else the first click takes it; a click fires its MG
await P.evaluate(() => window.__three.nav.setOrbit());
await wait(800);
await P.evaluate(() => document.querySelector('#bar')?.classList.remove('folded'));
await P.locator('button', { hasText: /^Combat plane$/ }).click({ timeout: 10000 }).catch((e) => log(`combat plane button: ${e.message}`));
const flying = await P.waitForFunction(() => window.__three.nav.craft?.mouse === true, null, { timeout: 30000 }).then(() => true, () => false);
let planeMouse = flying && await until(locked, 5000);
if (flying && !planeMouse) { await P.mouse.click(480, 320); planeMouse = await until(locked, 5000); }
check(flying && planeMouse, `the combat plane flying: the mouse taken (${planeMouse})`);
check(flying && await firesOnClick(), 'a click in the combat plane fires a shot the host records');

// Every aircraft (nav/craft.ts AIRCRAFT: each type a player sits in in the air) from the map: X high up puts P under
// an open paraglider. Each takes the mouse (the combat plane fires with it), and the mouse moved leaves its pilot's
// chase view behind it (nav/craft.ts mouseTurns).
const ENTER = { helicopter: /^Helicopter$/, gunship: /^Military helicopter$/, floatplane: /^Plane$/, jet: /^Jet$/, fighter: /^Combat plane$/ };
// (the helicopters start on the ground and climb first)
const CLIMB = new Set(['helicopter', 'gunship']);
// (a new aircraft without a button here would only show as 'not in it': named instead)
const unknown = AIRCRAFT.filter((t) => !ENTER[t]);
if (unknown.length) check(false, `every aircraft has its button in this gate (missing: ${unknown.join(', ')})`);
const underCanopy = () => P.waitForFunction(() => window.__three.nav.craft?.id === 'paraglider' && window.__sim.seat()?.role === 'pilot' && window.__sim.craftOf()?.type === 'paraglider',
  null, { timeout: 10000 }).then(() => true, () => false);
// The paraglider P hangs under flies: on the host over a second and a half it goes forward at about its trim speed and
// sinks at about its glide's rate, the page draws it where the host has it (not left hanging where it opened), and D
// held turns it.
const pid = await P.evaluate(() => window.__sim.player);
const wing = () => { const me = [...sim.crafts.values()].find((c) => c.type === 'paraglider' && c.pilot === pid); return me ? { ...me.core.pose, tick: sim.tick } : null; };
const flies = async () => {
  const from = wing(), at = (p) => p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : 'none';
  // (measured once it has flown 10 m: opening, it waits for its tiles and takes up its sink from none, more of the
  // window on a busy machine; one that hangs never gets there)
  const away = from && await until(() => { const w = wing(); return w && Math.hypot(w.x - from.x, w.z - from.z) > 10; }, 15000);
  if (from && !away) {
    const me = [...sim.crafts.values()].find((c) => c.type === 'paraglider' && c.pilot === pid);
    return { ok: false, why: `it hangs where it opened (host ${at(from)} -> ${at(wing())}; ${me ? `${me.core.result}, velocity ${JSON.stringify(me.core.velocity)}, input ${JSON.stringify(me.input)}` : 'gone'})` };
  }
  const a = wing();
  await until(() => a && sim.tick - a.tick >= 1.5 / STEP, 20000);
  const b = wing(), seen = await P.evaluate(() => window.__sim.craftOf()?.core.pose ?? null), c = wing();
  if (!a || !b || !c || !seen) return { ok: false, why: `no paraglider (host ${at(b)}, page ${at(seen)})` };
  const s = (b.tick - a.tick) * STEP, fwd = ((b.x - a.x) * Math.sin(a.h) + (b.z - a.z) * Math.cos(a.h)) / s, sink = (a.y - b.y) / s;
  const off = Math.hypot(seen.x - c.x, seen.y - c.y, seen.z - c.z);
  await P.keyboard.down('KeyD'); await until(() => { const w = wing(); return !w || Math.abs(w.h - b.h) > 0.3; }, 15000); await P.keyboard.up('KeyD');
  const d = wing(), turned = d ? Math.abs(d.h - b.h) : 0;
  const T = GLIDE.trim, S = GLIDE.sink;
  // (the page's within 20 m: it runs ahead of the host, and on a busy machine the two are read a second apart; left
  // where it opened it would be 27 m behind by now)
  return { ok: fwd > T * 0.7 && fwd < T * 1.6 && sink > S * 0.4 && sink < S * 2 && off < 20 && turned > 0.3,
    why: `${fwd.toFixed(1)} m/s forward, sinking ${sink.toFixed(2)} m/s, the page's ${off.toFixed(1)} m off the host's, D turns it ${turned.toFixed(2)} rad` };
};
const enter = async (type) => {
  await P.evaluate(() => window.__three.nav.setOrbit());
  await wait(800);
  // (the map's view back over the cathedral's square, where a helicopter finds land to start on, wherever the last
  // aircraft flew)
  await P.evaluate((d) => { const T = window.__three; T.controls.target.set(d.x, d.y, d.z); T.camera.position.set(d.x, d.y + 60, d.z + 60); T.camera.lookAt(T.controls.target); }, { x: dom.x, y: dom.z ?? 20, z: dom.y });
  await P.evaluate(() => document.querySelector('#bar')?.classList.remove('folded'));
  if (ENTER[type]) await P.locator('button', { hasText: ENTER[type] }).click({ timeout: 10000 }).catch((e) => log(`${type} button: ${e.message}`));
  const inIt = await P.waitForFunction((t) => window.__sim.craftOf()?.type === t && window.__sim.craftOf().placed && window.__three.nav.craft?.mouse === true, type, { timeout: 30000 }).then(() => true, () => false);
  // (the glide in from the map's view over)
  await wait(1200);
  return inIt;
};
// m over the street the aircraft is put for the low way out: under it no canopy has its 4 m to open in
const LOW = 7;
for (const type of AIRCRAFT) {
  // X low in the air, where no canopy fits: P is beside the aircraft's boxes at its height in that frame (read in the
  // frame X is taken, against the aircraft as the page has it), not on the street under it, and falls onto it
  const lowIn = await enter(type), lc = lowIn && sim.crafts.get(sim.seat(pid)?.entity.id);
  if (lc) sim.placeCraft(lc.id, { ...lc.core.pose, x: s.x, z: s.z, y: s.y + LOW });
  // (X in the frame the page first has it there: a plane is 40 m on within half a second, over other ground)
  const out = !!lc && await P.waitForFunction(([x, y, z]) => {
    const n = window.__three.nav, c = window.__sim.craftOf(), p = c?.core.pose;
    if (!p || Math.hypot(p.x - x, p.z - z) > 15 || Math.abs(p.y - y) > 3) return false;
    const pose = { ...p }, ok = n.getOut(), f = n.foot;
    return { ok, pose, onFoot: n.onFoot, shell: n.craft?.id ?? null, x: f.pos.x, z: f.pos.z, feet: f.feet, ground: n.world.support(f.pos.x, f.pos.z, f.feet) };
  }, [s.x, s.y + LOW, s.z], { timeout: 10000, polling: 'raf' }).then((h) => h.jsonValue(), () => null);
  const boxes = out ? craftMeets(type, out.pose) : [], clearOf = !!out && boxes.every((b) => reach(b, out.x, out.z, out.feet) <= 0);
  const landed = !!out && out.onFoot && await P.waitForFunction(() => { const n = window.__three.nav, f = n.foot; return n.onFoot && window.__sim.seat()?.role === 'walker' && f.feet - n.world.support(f.pos.x, f.pos.z, f.feet + 0.5) < 0.1; }, null, { timeout: 20000 }).then(() => true, () => false);
  check(!!out && out.ok && out.onFoot && clearOf && Math.abs(out.feet - boxes[0].y) < 1.1 && out.feet - out.ground > 2 && landed,
    `X ${LOW} m up in the ${type}: P beside it at its height, outside its boxes (${clearOf}), falling, then landed (${landed}): ${out ? `feet ${out.feet.toFixed(1)}, the ${type}'s foot ${boxes[0]?.y.toFixed(1)}, the ground ${out.ground.toFixed(1)}, on foot ${out.onFoot}, shell ${out.shell}` : `not in it low (in ${lowIn})`}`);
  const inIt = await enter(type);
  let m = await locked();
  if (inIt && !m) { await P.mouse.click(480, 320); await wait(300); m = await locked(); }
  const turned = await swung();
  check(inIt && m && turned < 0.1, `the ${type}'s pilot: the mouse taken (${m}), the mouse moved leaves the chase view behind it (${turned.toFixed(2)} rad)`);
  // (off its skids, then put by the host 150 m up, where the planes fly: beside the cathedral the military helicopter
  // climbs no higher than its towers' ledges, ~50 m, and a paraglider opened under it there scraped the roofs or, on
  // a busy machine, found no room to open)
  if (CLIMB.has(type)) {
    await P.keyboard.down('Space'); await wait(4000); await P.keyboard.up('Space');
    const c = sim.crafts.get(sim.seat(pid)?.entity.id), q = c?.core.pose;
    if (q) { sim.placeCraft(c.id, { ...q, y: 150 }); await P.waitForFunction(() => window.__sim.craftOf()?.core.pose.y > 120, null, { timeout: 10000 }).catch(() => {}); }
  }
  const id = await P.evaluate(() => window.__sim.craftOf()?.id), p = id != null && sim.crafts.get(id)?.core.pose;
  await P.keyboard.press('KeyX');
  const glides = inIt && await underCanopy(), left = id != null && sim.crafts.get(id);
  const flight = glides ? await flies() : { ok: false, why: 'not under one' };
  check(flight.ok, `the paraglider out of the ${type} flies: ${flight.why}`);
  check(glides && !!left && left.pilot === null, `X high in the ${type} (${p ? `${p.y.toFixed(0)} m` : 'not in it'}): P under an open paraglider, the ${type} flying on empty (${JSON.stringify(await P.evaluate(() => [window.__three.nav.craft?.id, window.__sim.seat()?.role]))})`);
}

// the grappling hook's touch button: shown under the paraglider (P is under one now); on foot a tap on it fires a
// hook at what the view's middle meets (here the ground a few metres ahead)
const hookButton = () => P.evaluate(() => { const b = document.querySelector('#hook-button'); return !!b && getComputedStyle(b).display !== 'none'; });
check(await hookButton(), 'under the paraglider the grappling hook\'s touch button is shown');
// X is the paraglider's one key: under it (out of the last aircraft) X folds it away into a fall on foot, the button
// saying so; falling, X opens one again, and that one flies as well.
const button = () => P.evaluate(() => { const b = document.querySelector('#board-button'); return b && !b.hidden ? b.textContent : null; });
const fold = await button();
await P.keyboard.press('KeyX');
const falling = await P.waitForFunction(() => window.__three.nav.onFoot && window.__three.nav.canOpen && window.__sim.seat()?.role === 'walker', null, { timeout: 10000 }).then(() => true, () => false);
// (the page's seat is the host's word: the paraglider is gone there by now; X again at once, as the fall from here
// lasts a few seconds only)
const gone = falling && !wing(), open = await button();
await P.keyboard.press('KeyX');
check(falling && gone && /fold paraglider/i.test(fold ?? '') && /open paraglider/i.test(open ?? ''),
  `X under the paraglider folds it away: P falls on foot, no paraglider left (the button: ${JSON.stringify(fold)}, then ${JSON.stringify(open)})`);
const reopened = falling && await underCanopy(), second = reopened ? await flies() : { ok: false, why: 'not under one' };
check(second.ok, `X falling on foot opens a paraglider that flies: ${second.why}`);

await P.evaluate((s) => { const T = window.__three; void T.nav.setWalk({ at: T.camera.position.clone().set(s.x, s.y, s.z), exact: true }); }, s);
const afoot = await P.waitForFunction(() => window.__three.nav.onFoot && !window.__three.nav.enteringWalk && window.__sim.seat()?.role === 'walker', null, { timeout: 30000 }).then(() => true, () => false);
await wait(800);
// (as on a phone: the bar folded, where the aircraft's buttons unfolded it over the thumbs' corner, and no mouse
// taken, which would get the tap in the button's place)
await P.evaluate(() => { const f = window.__three.nav.foot; f.pitch = -0.5; f.anchor = null; document.querySelector('#bar')?.classList.add('folded'); window.__three.nav.releaseMouse(); });
await frames2();
const shownAfoot = await hookButton();
await P.tap('#hook-button').catch((e) => log(`hook button: ${e.message}`));
const anchor = await P.waitForFunction(() => window.__three.nav.foot.anchor, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => null);
check(afoot && shownAfoot && !!anchor, `on foot the button is shown (${shownAfoot}), a tap on it fires a hook that holds (${anchor ? `at ${anchor.x.toFixed(1)}, ${anchor.y.toFixed(1)}, ${anchor.z.toFixed(1)}` : 'none'})`);

await browser.close();
link.close?.();
const ok = results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} ride-along: ${results.filter(Boolean).length}/${results.length}`);
done(ok ? 0 : 1);
