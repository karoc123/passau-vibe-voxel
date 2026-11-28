// The page's controls in every situation of play, on a phone and on a desktop, in headless Chrome (a page alone from
// a vite dev server of its own, on the real data): on the map, the full map, on foot, following a car, at the wheel,
// in every craft as its pilot, at a gun, on a bench, under the paraglider, the drone before and while it flies. A
// touch page at each of SIZES.touch, a mouse page at each of SIZES.desktop. In each situation at each size:
//   - every control shown (CONTROLS) lies on the screen and is what a tap at its middle meets (elementFromPoint), and
//     no control or read-out (DISPLAYS) lies over another;
//   - the hovercraft and the military helicopter are got into as a player does, by ☰ and the menu's entry;
//   - a real tap (a click with the mouse) on ☰ opens the menu, whose own controls are checked the same way, and one
//     on Resume closes it;
//   - on the touch page every control of play is at least 44 px either way; a tap on the weapon's name takes the
//     next weapon, a tap on the minimap and the menu's Map open the full map, the menu's entry hides the labels and shows them, a thumb held still at a gun fires on (as on foot), the reset button puts the boat back, the
//     view button swaps a passenger's view;
//   - the touch buttons shown are the situation's, none on the desktop but Get in/out; the help is the situation's:
//     the strip's keys on the desktop and the menu's Help, the keys or what the thumbs do; Esc is
//     the menu's key in every one; H lists all the keys and the strip again.
// usage (in web/): node tools/layout.mjs [-v] [--headed] [--only NAME,NAME]; prints PASS/FAIL lines
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dataDir, web } from './data-dir.mjs';

if (!fs.existsSync(path.join(dataDir, 'meta.json'))) { console.log(`SKIP layout: no ${dataDir}/meta.json`); process.exit(0); }
const verbose = process.argv.includes('-v'), headed = process.argv.includes('--headed');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const { chromium } = createRequire(path.join(web, 'package.json'))('playwright-core');
const log = (...a) => { if (verbose) console.log(' ', ...a); };
const results = [];
const check = (ok, what) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// (a phone held across, a small one, a phone held upright; a desktop window and a small one)
const SIZES = {
  touch: [['phone landscape', 780, 360], ['small phone landscape', 568, 320], ['phone portrait', 360, 740]],
  desktop: [['desktop', 1280, 720], ['small desktop', 1024, 600]],
};
// what a player can press, and what they read: none may lie over another
const CONTROLS = 'button, input, select, summary, a[href], [role=slider], #minimap, #waypoint-chip';
const DISPLAYS = '#health, #arms .slots, #arms .crosshair, #help, #bar .mode-active .mode-detail, #perf';
// the touch buttons there are (a new one is named here, and in the situations it belongs to)
const TOUCH_BUTTONS = ['#jump-button', '#hook-button', '#board-button', '#seat-button', '#handbrake-button',
  '#boat-drift-button', '#plane-throttle', '.plane-fire', '#reset-button', '#view-button'];

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-gate-'));
const vitePort = await freePort();
const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: web, env: { ...process.env, VOXEL_PUBLIC: path.dirname(dataDir), VOXEL_VITE_CACHE: cache }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
process.on('exit', () => { vite.kill(); fs.rmSync(cache, { recursive: true, force: true }); });
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)) break;
  if (i > 300 || vite.exitCode !== null) { console.log(`FAIL layout: vite did not start\n${viteLog}`); process.exit(1); }
  await wait(100);
}

const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')), [ox, oz] = meta.origin ?? [0, 0];
const dom = meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
// (the square before the cathedral, and the Danube below it: tools/ride-along.mjs)
const SQUARE = { x: dom.x - 40, z: dom.y - 10 }, BOAT = { x: 8160.5, z: 2880.5, h: 1.8 };
const cam = `${SQUARE.x + ox},70,${SQUARE.z + oz + 60},${SQUARE.x + ox},14,${SQUARE.z + oz}`;
const Q = `play&cam=${cam}&crop=256&res=0.5&shadow=0&ao=0&bloom=0&taa=0&refl=0&weather=clear&hour=13`;
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });

// ------------------------------------------------------------------ in the page
// every control and read-out shown (within `scope` if given), where it lies and what a tap at its middle meets
const MEASURE = ({ CONTROLS, DISPLAYS, TOUCH_BUTTONS, scope, thumb }) => {
  const W = innerWidth, H = innerHeight, issues = [];
  const name = (e) => (e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`)
    + (e.textContent?.trim() ? ` "${e.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)}"` : e.getAttribute('aria-label') ? ` "${e.getAttribute('aria-label')}"` : '');
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  // what shows of e: its box within the boxes that scroll it (the rest is reached by scrolling, not off the screen)
  const seen = (e) => {
    const b = e.getBoundingClientRect(), r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      const q = p.getBoundingClientRect();
      r.left = Math.max(r.left, q.left); r.top = Math.max(r.top, q.top); r.right = Math.min(r.right, q.right); r.bottom = Math.min(r.bottom, q.bottom);
    }
    return r;
  };
  const root = scope ? [...document.querySelectorAll(scope)] : null, inScope = (e) => !root || root.some((r) => r.contains(e));
  const items = [];
  for (const [sel, control] of [[CONTROLS, true], [DISPLAYS, false]]) {
    for (const e of document.querySelectorAll(sel)) {
      if (!shown(e) || !inScope(e)) continue;
      const r = seen(e), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      // (scrolled out of its box, or all but a sliver)
      if (r.right - r.left < 8 || r.bottom - r.top < 8) continue;
      if (control && getComputedStyle(e).pointerEvents === 'none') continue;
      items.push({ e, r, x, y, control, name: name(e) });
    }
  }
  for (const it of items) {
    const { e, r, x, y } = it;
    if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) issues.push(`${it.name} off the screen (${Math.round(r.left)},${Math.round(r.top)} .. ${Math.round(r.right)},${Math.round(r.bottom)} of ${W}x${H})`);
    else if (it.control) {
      // (what a thumb presses in play is as big as a thumb needs; the menu's fields have their own sizes)
      if (thumb && !e.closest('#menu, #fullmap') && Math.min(r.right - r.left, r.bottom - r.top) < 43.5) issues.push(`${it.name} is ${Math.round(r.right - r.left)}x${Math.round(r.bottom - r.top)} px, under a thumb's 44`);
      const hit = document.elementFromPoint(x, y);
      if (hit !== e && !e.contains(hit)) issues.push(`${it.name} covered at its middle by ${hit ? name(hit) : 'nothing'}`);
    }
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 1 && h > 1) issues.push(`${a.name} and ${b.name} overlap by ${Math.round(w)}x${Math.round(h)} px`);
  }
  const touch = TOUCH_BUTTONS.filter((s) => { const e = document.querySelector(s); return e && shown(e); });
  const at = (sel) => { const e = document.querySelector(sel); if (!e || !shown(e)) return null; const r = e.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; };
  const help = (sel) => { const e = document.querySelector(sel); return e ? { on: e.dataset.situation ?? '', text: e.textContent ?? '', shown: shown(e) } : null; };
  return { issues, touch, n: items.filter((i) => i.control).length, menuButton: at('#menu-button'), resume: at('#menu .menu-entry'),
    help: help('#help'), menuHelp: help('#menu .menu-help') };
};
const frames = (P, n = 3) => P.evaluate((n) => new Promise((done) => { const f = () => (--n > 0 ? requestAnimationFrame(f) : done()); requestAnimationFrame(f); }), n);

// ------------------------------------------------------------------ the situations
const centre = (P, sel) => P.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; }, sel);
const T = (P, f, arg, ms = 60000) => P.waitForFunction(f, arg, { timeout: ms }).then(() => true, () => false);
const toMap = async (P) => {
  await P.evaluate(() => { window.__map.full.isOpen && window.__map.full.close?.(); window.__three.nav.setOrbit(); });
  await T(P, () => window.__three.nav.mode === 'orbit' && !window.__three.nav.craft, null, 20000);
  await P.evaluate((s) => { const T = window.__three; T.controls.target.set(s.x, 14, s.z); T.camera.position.set(s.x, 70, s.z + 60); T.camera.lookAt(T.controls.target); }, SQUARE);
  await wait(600);
};
const inCraft = (P, shell, type) => T(P, ([shell, type]) => window.__three.nav.craft?.id === shell && window.__sim.craftOf()?.type === type && window.__sim.craftOf().placed, [shell, type]);
const enter = (shell, type, at) => async (P) => {
  await toMap(P);
  await P.evaluate(([shell, at]) => window.__crafts.find((c) => c.id === shell).enter(at ?? undefined), [shell, at ?? null]);
  return inCraft(P, shell, type ?? shell);
};
// (as a player gets one: ☰, then its entry among the menu's vehicles, by a real tap or click)
const fromMenu = (label, shell, type) => async (P, touch) => {
  await toMap(P);
  const b = await centre(P, '#menu-button'), entry = P.locator('#menu button.menu-entry', { hasText: new RegExp(`^${label}$`) });
  await (touch ? P.touchscreen.tap(b.x, b.y) : P.mouse.click(b.x, b.y));
  await (touch ? entry.tap({ timeout: 10000 }) : entry.click({ timeout: 10000 }));
  return (await inCraft(P, shell, type ?? shell)) && !(await P.evaluate(() => window.__menu.menu.isOpen()));
};
// (C: the next seat of the craft the player is in)
const nextSeat = async (P) => {
  const was = await P.evaluate(() => JSON.stringify(window.__sim.seat()));
  // (pressed again if nothing came of it: a switch still being answered takes no other)
  for (let i = 0; i < 5; i++) {
    await P.keyboard.press('KeyC');
    if (await T(P, (was) => JSON.stringify(window.__sim.seat()) !== was && window.__sim.seat()?.role === 'passenger' && window.__three.nav.craft?.id === 'passenger', was, 4000)) return true;
  }
  return false;
};
// (heading west, the long way across the map: it flies on while it is measured; each on a track of its own, as the
// one before flies on empty and the next would run into it)
const plane = (type, track) => enter('plane', type, { x: SQUARE.x, y: 200 + 40 * track, z: SQUARE.z + 150 * track, h: -Math.PI / 2, type });
const afoot = (P) => T(P, () => window.__three.nav.onFoot && !window.__three.nav.enteringWalk && window.__sim.seat()?.role === 'walker');

// on the touch page: what a thumb does there (null: as it should; else what went wrong)
const shots = (P, since) => P.evaluate((since) => window.__sim.eventsSince(since).filter((e) => e.kind === 'shot' && e.player === window.__sim.player).length, since);
const holdFires = async (P) => {
  const cdp = await P.context().newCDPSession(P), t0 = await P.evaluate(() => window.__sim.tick), at = { x: 300, y: 200 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  const on = await T(P, (t0) => window.__sim.eventsSince(t0).filter((e) => e.kind === 'shot' && e.player === window.__sim.player).length >= 3, t0, 15000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  return on ? null : `a thumb held still at the gun fired ${await shots(P, t0)} shots, not on and on`;
};
const resetPuts = async (P) => {
  const p = await centre(P, '#reset-button');
  await P.touchscreen.tap(p.x, p.y);
  return (await T(P, () => /Back on open water/.test(document.querySelector('.boat-status')?.textContent ?? ''), null, 10000)) ? null : 'a tap on the reset button does not put the boat back on open water';
};
// (the phone has no comma key: the minimap tapped, and the menu's Map)
const mapsOpen = async (P) => {
  const open = () => T(P, () => window.__map.full.isOpen, null, 3000), shut = () => P.evaluate(() => window.__map.full.close());
  const p = await centre(P, '#minimap');
  await P.touchscreen.tap(p.x, p.y);
  if (!(await open())) return 'a tap on the minimap does not open the full map';
  await shut();
  await P.evaluate(() => window.__menu.menu.open());
  await P.tap('#menu .menu-entry:text-is("Map")');
  if (!(await open()) || await P.evaluate(() => window.__menu.menu.isOpen())) return 'the menu\'s Map does not open the full map';
  await shut();
  return null;
};
// (the phone has no N key: the menu's entry hides the map's labels and shows them again; the map is cropped here, so
// the labels' own switch is looked at, not their pins)
const labelsToggle = async (P) => {
  const shown = (n) => T(P, (n) => window.__map.labels.visible === n, n, 5000);
  const tap = async (label) => { await P.evaluate(() => window.__menu.menu.open()); await P.tap(`#menu .menu-entry:text-is("${label}")`); };
  if (!(await shown(true))) return 'the labels are off to begin with';
  await tap('Hide the labels');
  if (!(await shown(false))) return 'the menu\'s Hide the labels leaves the labels on';
  await tap('Show the labels');
  return (await shown(true)) ? null : 'the menu\'s Show the labels does not turn them on again';
};
const weaponSwaps = async (P) => {
  const slot = () => P.evaluate(() => window.__three.nav.arms.slot), was = await slot(), p = await centre(P, '#arms .slots');
  await P.touchscreen.tap(p.x, p.y);
  await frames(P, 3);
  const now = await slot(), name = await P.evaluate(() => document.querySelector('#arms .slots .on')?.textContent);
  return now !== was && new RegExp(`^${now} `).test(name ?? '') ? null : `a tap on the weapon's name does not take the next one (slot ${was} to ${now}, shown ${JSON.stringify(name)})`;
};
const viewSwaps = async (P) => {
  const seat = () => P.evaluate(() => window.__crafts.find((c) => c.id === 'passenger').seatView), was = await seat(), p = await centre(P, '#view-button');
  await P.touchscreen.tap(p.x, p.y);
  return (await seat()) !== was ? null : 'a tap on the view button does not swap the passenger\'s view';
};

// name; into it (false: not reached); thumb: a check of what a thumb does there (above); touch: the touch buttons it shows; help: what its help says (on the desktop,
// on touch); menu: its menu checked too
const FOOT_HELP = [/walk.*jump/i, /thumb/i];
const SITUATIONS = [
  { name: 'the map', into: async (P) => { await toMap(P); return true; }, thumb: labelsToggle, touch: [], menu: true, help: ['map', /drag|move/i, /drag|finger/i] },
  { name: 'the full map', scope: '#fullmap, #waypoint-chip', into: async (P) => { await toMap(P); await P.evaluate(() => window.__map.full.open()); return T(P, () => window.__map.full.isOpen); },
    touch: null, out: (P) => P.evaluate(() => window.__map.full.toggle()) },
  { name: 'on foot', into: async (P) => { await toMap(P); await P.evaluate(() => void window.__three.nav.toggleWalk(false)); return afoot(P); }, thumb: mapsOpen,
    touch: ['#jump-button', '#hook-button'], menu: true, help: ['walk', ...FOOT_HELP] },
  { name: 'following a car', into: async (P) => {
    await toMap(P);
    await P.evaluate(() => { const T = window.__three, c = window.__life.nearest('car', T.controls.target, null); if (c) T.nav.startRide(c); });
    return T(P, () => window.__three.nav.mode === 'ride');
  }, touch: [], help: ['ride', /look/i, /look/i] },
  { name: 'at the wheel of a car', into: async (P) => {
    await toMap(P);
    await P.evaluate(() => window.__crafts.find((c) => c.id === 'drive').enter());
    return T(P, () => window.__sim.seat()?.role === 'driver' && window.__sim.driver() && !window.__sim.driver().waiting && window.__three.nav.craft?.id === 'drive', null, 120000);
  }, touch: ['#handbrake-button', '#board-button', '#reset-button'], help: ['drive', /steer.*handbrake/i, /stick|thumb/i] },
  { name: 'the hovercraft', into: fromMenu('Hovercraft', 'hovercraft'), touch: ['#board-button'], help: ['hovercraft', /thrust/i, /stick/i] },
  { name: 'the helicopter', into: enter('helicopter'), touch: ['#board-button'], help: ['helicopter', /climb/i, /stick/i] },
  { name: 'on foot beside the helicopter', into: async (P) => { await P.keyboard.press('KeyX'); return (await afoot(P)) && T(P, () => document.querySelector('#board-button:not([hidden])'), null, 20000); }, thumb: weaponSwaps,
    touch: ['#jump-button', '#hook-button', '#board-button'], help: ['walk', ...FOOT_HELP] },
  { name: 'the military helicopter', into: fromMenu('Military helicopter', 'gunship'), touch: ['#board-button', '#seat-button'], help: ['gunship', /climb/i, /stick/i] },
  { name: 'at the military helicopter\'s gun', into: nextSeat, touch: ['#board-button', '#seat-button'], help: ['gunner', /aim.*fire/i, /aim.*fire/i] },
  { name: 'on the military helicopter\'s bench', into: async (P) => (await nextSeat(P)) && nextSeat(P), thumb: viewSwaps, touch: ['#board-button', '#seat-button', '#view-button'], help: ['passenger', /look/i, /look/i] },
  { name: 'at the boat\'s wheel', into: enter('boat', 'boat', BOAT), thumb: resetPuts, touch: ['#boat-drift-button', '#board-button', '#seat-button', '#reset-button'], help: ['boat', /steer.*drift/i, /stick|thumb/i] },
  { name: 'at the boat\'s gun', into: nextSeat, thumb: holdFires, touch: ['#board-button', '#seat-button'], help: ['gunner', /aim.*fire/i, /aim.*fire/i] },
  { name: 'the floatplane', into: plane('floatplane', 0), touch: ['#plane-throttle', '#board-button', '#reset-button'], help: ['floatplane', /throttle/i, /throttle/i] },
  { name: 'the jet', into: plane('jet', 1), touch: ['#plane-throttle', '#board-button', '#reset-button'], help: ['jet', /throttle/i, /throttle/i] },
  { name: 'the combat plane', into: plane('fighter', 2), touch: ['#plane-throttle', '.plane-fire', '#board-button', '#reset-button'], help: ['fighter', /fire/i, /fire/i] },
  // (X high up: beside the plane falling, then the paraglider open over the player)
  { name: 'under the paraglider', into: async (P) => {
    await P.keyboard.press('KeyX');
    for (let i = 0; i < 8 && !(await T(P, () => window.__three.nav.craft?.id === 'paraglider', null, 2500)); i++) await P.keyboard.press('KeyX');
    return inCraft(P, 'paraglider', 'paraglider');
  }, touch: ['#hook-button', '#board-button'], help: ['paraglider', /steer.*hook/i, /hook/i] },
  { name: 'the drone before it flies', into: enter('fpv', 'drone', { x: SQUARE.x, y: 40, z: SQUARE.z, h: 0 }), touch: ['#board-button'], help: ['fpv', /throttle/i, /throttle/i] },
  { name: 'the drone flying', into: async (P, touch) => { await P.evaluate((how) => window.__crafts.find((c) => c.id === 'fpv').arm(how), touch ? 'touch' : 'keyboard'); return T(P, () => document.querySelector('.fpv-mode.flying'), null, 20000); },
    touch: ['#board-button'], help: ['fpv', /throttle/i, /throttle/i] },
];

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
async function run(kind) {
  const touch = kind === 'touch', sizes = SIZES[kind], [, w0, h0] = sizes[0];
  const ctx = await browser.newContext({ viewport: { width: w0, height: h0 }, hasTouch: touch });
  const P = await ctx.newPage();
  P.on('pageerror', (e) => console.log(`  ${kind} page error: ${e.message}`));
  await P.goto(`http://127.0.0.1:${vitePort}/?${Q}`, { timeout: 300000 });
  const up = await T(P, () => window.__map && window.__sim?.player && window.__crafts && window.__life?.group.visible && !document.body.classList.contains('loading'), null, 300000);
  check(up, `${kind}: the page loaded, alone`);
  if (!up) return;
  // (the mouse taken again by a click on Resume is refused by a headless browser now and then, and a lock lost opens
  // the menu, at any moment: not this gate's matter, tools/menu.mjs has the menu)
  await P.evaluate(() => { window.__three.nav.onLockLost = () => {}; });
  // (a waypoint set: its chip is one more thing on the screen)
  await P.evaluate((s) => window.__map.waypoint.toggleAt(s.x + 300, s.z, 1), SQUARE);
  const press = (p) => (touch ? P.touchscreen.tap(p.x, p.y) : P.mouse.click(p.x, p.y));
  const measure = (scope) => P.evaluate(MEASURE, { CONTROLS, DISPLAYS, TOUCH_BUTTONS, scope: scope ?? null, thumb: touch });
  for (const S of SITUATIONS) {
    if (only && !only.split(',').includes(S.name)) continue;
    const reached = await S.into(P, touch).catch((e) => { log(`${S.name}: ${e.message}`); return false; });
    const bad = [];
    if (!reached) bad.push(`not reached (${JSON.stringify(await P.evaluate(() => ({ mode: window.__three.nav.mode, craft: window.__three.nav.craft?.id ?? null, seat: window.__sim.seat() })))})`);
    if (reached && touch && S.thumb) {
      await P.setViewportSize({ width: w0, height: h0 });
      await frames(P, 4);
      const wrong = await S.thumb(P).catch((e) => e.message);
      if (wrong) bad.push(wrong);
    }
    for (const [size, w, h] of reached ? sizes : []) {
      await P.setViewportSize({ width: w, height: h });
      await frames(P, 4);
      const m = await measure(S.scope);
      log(`${kind} ${S.name} at ${size}: ${m.n} controls, touch buttons ${m.touch.join(' ') || 'none'}, help ${JSON.stringify(m.help)}`);
      bad.push(...m.issues.map((i) => `${size}: ${i}`));
      // (on the desktop none of the thumbs' buttons, but Get in/out, which a click presses too)
      const want = S.touch && (touch ? S.touch : S.touch.filter((b) => b === '#board-button'));
      if (want && !same(want, m.touch)) bad.push(`${size}: the touch buttons shown are ${m.touch.join(' ') || 'none'}, not ${want.join(' ') || 'none'}`);
      // the strip on the desktop: the situation's first keys
      const [on, keys, thumbs] = S.help ?? [];
      if (S.help && !touch && (!m.help?.shown || m.help.on !== on || !keys.test(m.help.text) || !/Esc menu/.test(m.help.text)))
        bad.push(`${size}: the help's strip is ${JSON.stringify(m.help)}, not the one of '${on}' (${keys}, Esc menu)`);
      if (S.scope) continue;
      // ☰ by a real tap, the menu's own controls, Resume by a real tap
      if (!m.menuButton) { bad.push(`${size}: no ☰ button`); continue; }
      // (with the mouse taken there is no pointer to click with: Esc lets it go and opens the menu)
      if (await P.evaluate(() => !!document.pointerLockElement)) await P.keyboard.press('Escape'); else await press(m.menuButton);
      const open = await T(P, () => window.__menu.menu.isOpen(), null, 3000);
      if (!open) { bad.push(`${size}: ☰ (a ${touch ? 'tap' : 'click, or Esc with the mouse taken'}) does not open the menu`); continue; }
      const inMenu = await measure('#menu');
      if (S.menu) bad.push(...inMenu.issues.map((i) => `${size}, the menu: ${i}`));
      // the menu's Help: the situation's, the keys or what the thumbs do
      const mh = inMenu.menuHelp;
      if (S.help && (!mh || mh.on !== on || !(touch ? thumbs : keys).test(mh.text) || !(touch || /Esc menu/.test(mh.text))))
        bad.push(`${size}: the menu's help is ${JSON.stringify(mh)}, not the one of '${on}' (${touch ? thumbs : `${keys}, Esc menu`})`);
      if (inMenu.resume) await press(inMenu.resume);
      if (!(await T(P, () => !window.__menu.menu.isOpen(), null, 3000))) { bad.push(`${size}: a ${touch ? 'tap' : 'click'} on Resume does not close the menu`); await P.evaluate(() => window.__menu.menu.close()); }
    }
    await S.out?.(P);
    check(!bad.length, `${kind}, ${S.name}: every control on the screen and free at ${sizes.map((s) => s[0]).join(', ')}, ☰ opens the menu, the buttons and the help are the situation's${bad.length ? `\n    ${[...new Set(bad)].join('\n    ')}` : ''}`);
  }
  if (!touch && !only) {
    await toMap(P);
    const strip = () => P.evaluate(() => { const h = document.querySelector('#help'); return { all: h.classList.contains('all'), n: h.querySelectorAll('span').length }; });
    const a = await strip();
    await P.keyboard.press('KeyH'); await frames(P, 3);
    const b = await strip();
    await P.keyboard.press('KeyH'); await frames(P, 3);
    const c = await strip();
    check(!a.all && b.all && b.n > a.n && !c.all && c.n === a.n, `desktop: H lists all the keys (${a.n} to ${b.n}), H again the strip (${c.n})`);
  }
  await ctx.close();
}
await Promise.all([run('touch'), run('desktop')]);
await browser.close();
const ok = results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} layout: ${results.filter(Boolean).length}/${results.length}`);
process.exit(ok ? 0 : 1);
