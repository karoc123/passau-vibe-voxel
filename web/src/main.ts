import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Bar } from './bar';
import { Caption } from './caption';
import { installCity } from './city';
import { Daylight } from './daylight';
import { loadFoliage } from './foliage';
import { loadWindows } from './windows';
import { LampHeads } from './lamps';
import { Fountains } from './fountains';
import { Hud } from './hud';
import { Labels } from './labels';
import { Minimap } from './minimap';
import type { CraftContext, PlayerCraft } from './nav/craft';
import { Nav, type Mode, type Ride } from './nav/nav';
import { gameKey, typing } from './nav/input';
import { Perf } from './perf';
import { makePost } from './post';
import type { SearchItem } from './search';
import { StreetLife } from './view/life';
import { LocalSimClient, MirrorSimClient, ThreadLink, type SimClient } from './sim/sim-client';
import { LOCAL_PLAYER } from './sim/world-sim';
import { hostSim } from './sim-host';
import { WorkerLink } from './sim-worker-link';
import { viewerTileCache } from './viewer-tiles';
import type { Kind, TrafficData } from './sim/types';
import { unpackTraffic } from './sim/traffic-pack';
import { TileStreamer } from './stream';
import type { Facts, FloodInfo, Label, Meta, Place, View } from './types';
import { dateOf, dayOfYear, hourAt, solarNoon } from './sun';
import { $, coarsePointer, ease, el, fetchJson, lerp } from './util';
import { type Climate, Precip, typical, type Weather, WEATHERS } from './weather';
import type { World } from './world';
import { makeUniforms, makeVoxelMaterial, makeVoxelPrepassMaterial } from './voxelMaterial';
import { LampLight } from './lamplight';
import { DepthPrepass } from './prepass';
import { AUTO_KEYS, DIST_MAX, DIST_MIN, type Gfx, gpuName, prepassPays, Settings } from './settings';
import { AutoRes } from './autores';
import { focusView } from './focus';
import './style.css';

declare global {
  interface Window { __ready?: boolean; __three?: object; __life?: StreetLife; __sim?: SimClient; __simLink?: WorkerLink; __streamer?: TileStreamer }
}

const TODAY = dayOfYear(new Date());
const DAYS = { midsummer: 172, midwinter: 355, today: TODAY };

const qs = new URLSearchParams(location.search);
// the graphics settings (settings.ts, the ⚙ panel), the resolution and the detail among them: set by the visitor, else
// chosen once (autores.ts), then fixed for the session
const phone = Math.min(screen.width, screen.height) < 600;
const gpu = gpuName();
const gfx = new Settings(phone, innerWidth >= 600, prepassPays(gpu), gpu);
// The detail, 0 to 1: the triangles the city's tiles may draw (city.ts picks their levels by it, the nearest finest),
// evenly on a log scale from twice the whole map at 8 m (0: 3.4 M on today's map, the whole map at 8 m and the nearest
// finer) to all of it at 1 m with its foliage (132 M; at 1 no limit at all): 0.45 ~18 M, 0.75 ~53 M. Phones draw 2 M at
// most whatever it says (the 1 m tiles of the whole map need several GB of GPU), the whole map at 8 m alone ~1.7 M of
// it: their view distance stays within what half of it affords (viewCut).
const ceiling = () => (!phone ? Infinity : 2e6);
const budget = () => {
  const l = gfx.now.detail, [lo, hi] = city?.trisRange ?? [0.5e6, 14.7e6];
  return l >= 1 ? ceiling() : Math.min(ceiling(), lo * (Math.max(hi, lo) / lo) ** l);
};
// (with the TAA the canvas at the screen's resolution, the scene at gfx.renderRes: post.ts)
const pixelRatio = () => Math.min(devicePixelRatio, 2) * (gfx.now.taa ? 1 : gfx.now.res);
const renderer = makeRenderer();
const scene = new THREE.Scene();
const movingActors = new THREE.Group();
scene.add(movingActors);
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.5, 9000); // (the far plane: fitFar, once the map is known)
const controls = makeControls();
const daylight = new Daylight(renderer, scene, gfx.now.shadow || 2048);
const post = makePost(renderer, scene, camera, daylight.sky);
const nav = new Nav(camera, controls, renderer.domElement, scene, (v) => flyTo(v), onMode);
movingActors.add(nav.actors);
// the player's crafts (nav/craft.ts), one line each; their panels in this order. Loaded once the city is shown (boot)
const CRAFTS = () => [
  import('./nav/fpv').then((m) => m.FpvMode),
  import('./nav/drive').then((m) => m.DriveMode),
  import('./nav/boat').then((m) => m.BoatMode),
  import('./nav/plane').then((m) => m.PlaneMode),
  import('./nav/special-craft').then((m) => m.HovercraftMode),
  import('./nav/special-craft').then((m) => m.HelicopterMode),
];
let crafts: PlayerCraft[] = [];
const bar = new Bar({ days: DAYS, weathers: ['typical', ...Object.keys(WEATHERS)], onDay: (d) => { setDay(d); share(); },
  onDayEnd: () => { if (weatherName === 'typical') setWeather('typical'); },
  onHour: (h) => { setHour(h); share(); },
  onWeather: (w) => { setWeather(w); share(); } });
const precip = new Precip(scene);
const map = new THREE.Box3();
let world: World | null = null, labels: Labels | null = null, hud: Hud | null = null;
let minimap: Minimap | null = null;
// the world sim's client (sim/sim-client.ts: the page reaches the sim only through it) and its presentation, once the
// traffic is loaded (the crafts wait for it: simReady)
let sim: SimClient | null = null, life: StreetLife | null = null, fountains: Fountains | null = null;
// the rivers' points (flood.json `river`, sim/river.ts) for the boat and the floatplane: null until loaded, [] if none
let riverPoints: number[] | null = null;
let simLoaded: (sim: SimClient) => void = () => {};
const simReady = new Promise<SimClient>((resolve) => { simLoaded = resolve; });
let city: Awaited<ReturnType<typeof installCity>> | null = null;
let uniforms: ReturnType<typeof makeUniforms> | null = null, streamer: TileStreamer | null = null, views: Record<string, View> = {};
let fly: ((now: number) => void) | null = null;
let prepass: DepthPrepass | null = null;
let barRect: DOMRect | null = null;
let climate: Climate | null = null;
const caption = new Caption();
const perf = new Perf();
let setWindows: ((hour: number, day: number) => void) | null = null;
let lampHeads: LampHeads | null = null;

nav.cancelFly = () => { fly = null; };
const modeTools = el('div', 'mode-tools', '', bar.el);
const walkButton = el('button', 'mode-button', 'Walk', modeTools);
walkButton.type = 'button';
walkButton.disabled = true;
walkButton.addEventListener('click', e => {
  walkButton.blur();
  nav.leaveCraft(); // (the car driven parks; you step out beside it)
  const touch = e instanceof PointerEvent && (e.pointerType === 'touch' || e.pointerType === 'pen');
  void nav.togglePedestrian(!touch && !coarsePointer());
});
const maxShadow = renderer.capabilities.maxTextureSize;
const gfxPanel = bar.graphics(gfx, applyGfx, maxShadow);
gfx.writeUrl();
// the resolution and the detail measured once if nothing set them (autores.ts). Not under automation (screenshots,
// benchmarks keep theirs) unless autores=1; autores=0 never.
const autoQ = qs.get('autores');
let autoRes: AutoRes | null = null;
if (gfx.toMeasure && !gfx.now.taa && (autoQ === '1' || (autoQ !== '0' && !navigator.webdriver))) {
  const start = { res: gfx.now.res, detail: gfx.now.detail };
  gfx.setAuto(start, true);
  autoRes = new AutoRes(renderer, camera, start, (m, final) => {
    const was = { ...gfx.now };
    gfx.setAuto(m, !final);
    const c = Object.fromEntries(AUTO_KEYS.filter((k) => gfx.now[k] !== was[k]).map((k) => [k, gfx.now[k]]));
    if (Object.keys(c).length) applyGfx(c);
    gfxPanel.show();
  });
  gfxPanel.show();
}
new ResizeObserver(() => { barRect = null; }).observe(bar.el);
const credits = el('div', '', `<div>Passau in voxels, derived from <a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">warsaw-vibe-voxel</a> by <a href="https://p.migdal.pl/" target="_blank" rel="noopener">Piotr Migdał</a> & <a href="https://quesma.com/blog/invisible-cities-one-shot/" target="_blank" rel="noopener">Opus 5.5</a> (MIT)</div>
  <div>data: <a href="https://www.geodaten.bayern.de" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a> (CC BY 4.0) and <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> contributors (ODbL)</div>
  <div>weather <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0), phenology <a href="https://www.dwd.de/" target="_blank" rel="noopener">Deutscher Wetterdienst</a> (DL-DE BY 2.0)</div>
  <div>tree species <a href="https://geoservice.dlr.de/web/maps/eoc:tcde:2022" target="_blank" rel="noopener">Tree Species Germany 2022/2016 – DLR Earth Observation Center (Wegler et al.)</a>, CC BY 4.0</div>`);
credits.id = 'credits';
credits.setAttribute('popover', 'auto');
const creditsButton = el('button', '', '<span aria-hidden="true">?</span>');
creditsButton.id = 'credits-button';
creditsButton.type = 'button';
creditsButton.setAttribute('aria-label', 'Credits and licenses');
creditsButton.setAttribute('popovertarget', credits.id);
document.addEventListener('keydown', (e) => {
  // Let the browser close the popover before Escape can exit the current navigation mode.
  if (e.key === 'Escape' && credits.matches(':popover-open')) e.stopPropagation();
}, { capture: true });
// on foot on a touch screen: Jump (Space), over the right thumb's look area (the sticks: nav.ts footSticks)
const jumpButton = el('button', '', '<span aria-hidden="true">⤒</span>');
jumpButton.id = 'jump-button';
jumpButton.type = 'button';
jumpButton.setAttribute('aria-label', 'Jump');
jumpButton.addEventListener('pointerdown', (e) => { e.preventDefault(); nav.jump(); });
jumpButton.addEventListener('click', (e) => { if (e.detail === 0) nav.jump(); }); // (the keyboard)
if (qs.get('ui') === '0') document.body.classList.add('noui');
// which mode is on, for style.css (set each frame below): data-mode, nav.ts Mode or the craft's id while in one
// (craft.ts); data-nav, nav.ts Mode (craft: a craft owns the camera and the input)
document.body.dataset.mode = document.body.dataset.nav = nav.mode;
addEventListener('resize', onResize);
// N shows and hides the map's labels (a searched place's stays), in every mode; remembered (localStorage LABELS_KEY)
const LABELS_KEY = 'labels';
let labelsOn = true;
try { labelsOn = localStorage.getItem(LABELS_KEY) !== '0'; } catch { /* storage blocked: shown */ }
addEventListener('keydown', (e) => {
  if (e.key === '/' && gameKey(e)) { bar.fold(false); bar.search.input.focus(); e.preventDefault(); }
  if (e.code === 'KeyN' && gameKey(e) && !e.repeat) {
    labelsOn = !labelsOn;
    if (labels) labels.visible = labelsOn;
    try { localStorage.setItem(LABELS_KEY, labelsOn ? '1' : '0'); } catch { /* not remembered */ }
    toast(labelsOn ? 'Labels on' : 'Labels off (N shows them)');
    e.preventDefault();
  }
  if (e.code === 'KeyM' && gameKey(e) && !e.repeat && minimap) {
    minimap.toggle();
    e.preventDefault();
  }
  // Ctrl+C with nothing selected: the spot under the mouse and a link to look at it (nav.spotText), to report a fault
  if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !typing(e)
      && !getSelection()?.toString()) {
    const text = nav.spotText();
    if (!text) return;
    e.preventDefault();
    navigator.clipboard.writeText(text).then(() => toast('Copied: ' + text.split('  ')[0]), () => toast('Copy failed'));
  }
});
function toast(msg: string) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);padding:6px 12px;border-radius:6px;'
    + 'background:rgba(20,24,30,.85);color:#fff;font:13px system-ui,sans-serif;z-index:1000;pointer-events:none';
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}
tamePinch(renderer.domElement);
// A lost WebGL context (a GPU reset; on WSL also under load) is restored by three, but what lived only on the GPU is
// gone: the tiles are meshed again (stream.ts remeshLost), the sky's light and the shadows drawn again
renderer.domElement.addEventListener('webglcontextlost', () => { console.warn('WebGL context lost'); streamer?.remeshLost(); });
renderer.domElement.addEventListener('webglcontextrestored', () => { console.warn('WebGL context restored'); daylight.restore(); });
boot();

function makeRenderer() {
  // (no preserveDrawingBuffer: it costs a full-screen copy every frame; screenshots go through the browser)
  const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  r.info.autoReset = false;
  r.setPixelRatio(pixelRatio());
  r.setSize(innerWidth, innerHeight);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  $('#app').appendChild(r.domElement);
  return r;
}

function makeControls() {
  const c = new OrbitControls(camera, renderer.domElement);
  Object.assign(c, { enableDamping: true, dampingFactor: 0.16, rotateSpeed: 0.3, minDistance: 4, maxDistance: 7000, screenSpacePanning: false, zoomToCursor: true, zoomSpeed: 2.0 });
  if (coarsePointer()) Object.assign(c, { panSpeed: 1.6, zoomSpeed: 1 }); // the map moves and scales with the fingers
  return c;
}

// a trackpad pinch arrives as Ctrl+wheel, which OrbitControls amplifies 10x: re-sent as a plain wheel at ~3x
function tamePinch(dom: HTMLElement) {
  dom.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !e.isTrusted || !nav.onMap) return;
    e.stopImmediatePropagation(); e.preventDefault();
    dom.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY * 3, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }));
  }, { capture: true, passive: false });
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.composer.setSize(innerWidth, innerHeight);
  barRect = null;
}

// a change of the graphics settings, or all of them at the start; the city's distance levels and the pre-pass once
// they exist (boot)
function applyGfx(c: Partial<Gfx>) {
  const g = gfx.now;
  // the TAA turned on while measuring: the measuring left off, nothing remembered (it timed frames without it)
  if (g.taa && autoRes) { gfx.setAuto({ res: g.res, detail: g.detail }, false, false); autoRes = null; gfxPanel.show(); }
  if ('res' in c || 'taa' in c) {
    if (Math.abs(pixelRatio() - renderer.getPixelRatio()) > 0.001) renderer.setPixelRatio(pixelRatio());
    post.setTaa(g.taa, gfx.renderRes);
    onResize();
  }
  // the detail: city.ts asks the budget on its next update
  if ('shadow' in c) { daylight.setShadowSize(g.shadow, maxShadow); stillDue = true; }
  if ('ao' in c || 'bloom' in c || 'refl' in c) post.enable({ ao: g.ao, bloom: g.bloom, refl: g.refl });
  if ('grade' in c) post.film.strength = g.grade;
  if ('lod' in c || 'lodpx' in c) city?.setLod({ mode: g.lod, px: g.lodpx });
  if ('prepass' in c && prepass) prepass.enabled = g.prepass;
  if ('occl' in c) city?.setOcclusion(g.occl);
  if ('dist' in c) stillDue = true; // (the view distance: the loop, viewCut)
  busy = true;
}

function onMode(m: Mode, ride: Ride | null) {
  post.taa.restart(); // (the camera jumps)
  hud?.set(m, ride);
}

const focus = () => (nav.onMap ? controls.target : camera.position);

function setHour(h: number) {
  daylight.apply(h);
  bar.setHour(h);
}

const timesOf = (d: number) => ({ morning: Math.max(7.5, hourAt(d, 6, false)), midday: solarNoon(d), 'golden hour': hourAt(d, 5, true),
  'blue hour': hourAt(d, -7, true), night: Math.min(23.5, Math.max(23, hourAt(d, -14, true))) });

function setDay(d: number) {
  const times = timesOf(daylight.day), was = Object.entries(times).find(([, h]) => Math.abs(h - daylight.hour) < 1 / 3)?.[0] as keyof typeof times | undefined;
  daylight.day = d;
  const now = timesOf(d);
  bar.setDay(d, now);
  offerWeathers(d);
  setHour(was ? now[was] : daylight.hour);
}

function offerWeathers(d: number) {
  const snow = climate?.snowy[d - 1] ?? true;
  bar.offer('snow', snow);
  if (!snow && weatherName === 'snow') setWeather('typical');
}

let weatherName = 'typical';
let fade: { from: Weather; to: Weather; t0: number } | null = null;
function setWeather(name: string, now = false) {
  weatherName = name;
  const t = name === 'typical' && climate ? typical(climate, daylight.day) : null;
  const to = t?.w ?? WEATHERS[name] ?? WEATHERS.clear;
  bar.setWeather(name, t?.said ?? '');
  fade = now ? null : { from: { ...daylight.weather }, to, t0: performance.now() };
  if (now) { daylight.weather = to; daylight.apply(daylight.hour); }
}

function stepWeather(now: number) {
  if (!fade) return;
  const k = Math.min(1, (now - fade.t0) / 1500), e = ease(k), { from, to } = fade;
  daylight.weather = { cloud: lerp(from.cloud, to.cloud, e), rain: lerp(from.rain, to.rain, e), snow: lerp(from.snow, to.snow, e), cover: lerp(from.cover, to.cover, e) };
  daylight.apply(daylight.hour);
  if (k >= 1) fade = null;
}

let shareT = 0;
function share() {
  clearTimeout(shareT);
  shareT = setTimeout(() => {
    const d = dateOf(daylight.day), qs = new URLSearchParams(location.search); // as it is now: the settings write to it too
    qs.set('date', `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    qs.set('hour', daylight.hour.toFixed(2));
    if (weatherName !== 'typical') qs.set('weather', weatherName); else qs.delete('weather');
    history.replaceState(null, '', `?${qs}`);
  }, 400);
}

function flyTo(v: Pick<View, 'pos' | 'target' | 'ms'>) {
  const p0 = camera.position.clone(), q0 = controls.target.clone(), t0 = performance.now();
  const p1 = new THREE.Vector3(...v.pos), q1 = new THREE.Vector3(...v.target);
  fly = (now) => {
    const t = Math.min(1, (now - t0) / (v.ms ?? 1600)), e = ease(t);
    camera.position.lerpVectors(p0, p1, e);
    controls.target.lerpVectors(q0, q1, e);
    if (t >= 1) fly = null;
  };
}

// a bridge searched or clicked: walked to on its deck, not under it (a label of kind bridge/footbridge, a place of kind
// bridge, or a street over one: Passau's are named …brücke / …steg); nav's setWalk lands on a deck only if there is one
const onBridge = (kind: string, name: string) => /^(foot)?bridge$/.test(kind) || (kind === 'street' && /(brücke|steg)$/i.test(name));

// frame a place from the current compass direction, ~30° down, with a label on it; at street level, walk there
function goPlace(x: number, y: number, size: number, pin: Facts | null, name = pin?.name ?? '', kind = pin?.kind ?? '') {
  if (!world) return;
  if (nav.craftView) nav.setOrbit();
  const g = world.groundAt(x, y), top = world.top(Math.floor(x), Math.floor(y)), h = Math.max(0, top - g);
  labels?.pin(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
  if (!nav.onMap) {
    nav.setWalk({ at: new THREE.Vector3(x + 0.5, g, y + 0.5), deckOK: onBridge(kind, name), thirdPerson: nav.third });
    return;
  }
  const t = new THREE.Vector3(x + 0.5, g + Math.min(h * 0.5, 60), y + 0.5);
  const dist = Math.min(800, Math.max(170, size * 1.6 + h * 1.8));
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z), el = 0.52;
  const pos = t.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
  flyTo({ pos: pos.toArray(), target: t.toArray() });
}

function goView(v: View) {
  nav.setOrbit();
  labels?.pin(null);
  flyTo(v);
}

function onLabel(l: Label) {
  const v = Object.values(views).find((w) => w.label === l.name);
  if (v && nav.onMap) goView(v);
  else goPlace(l.x, l.y, 60, null, l.name, l.kind);
}

// moving vehicles are hard to click from the air: the nearest one to what you look at
function followNearest(kind: Kind) {
  const ag = life?.nearest(kind, focus(), null);
  if (ag) nav.startRide(ag);
}

function searchItems(meta: Meta): SearchItem[] {
  return [
    ...Object.values(meta.views).map((v) => ({ name: v.label, kind: 'viewpoint', featured: true, go: () => goView(v) })),
    ...meta.labels.map((l) => ({ name: l.name, alt: [l.en, l.alt].join(' '), kind: l.kind, go: () => goPlace(l.x, l.y, Math.max(40, (l.R ?? 20) * 1.4), null, l.name, l.kind) })),
    { name: 'Follow a car', alt: 'car bus Auto ride follow', kind: 'action', go: () => followNearest('car') },
    { name: 'Follow someone', alt: 'person people pedestrian Fußgänger walk with follow', kind: 'action', go: () => followNearest('person') },
  ];
}

// keep the focus over the city and the camera within 1.5 km of it
function keepInside() {
  if (map.isEmpty() || nav.turning) return;
  const t = controls.target, p = camera.position, m = 60, M = 1500;
  const cx = THREE.MathUtils.clamp(t.x, map.min.x + m, map.max.x - m), cz = THREE.MathUtils.clamp(t.z, map.min.z + m, map.max.z - m);
  if (cx !== t.x || cz !== t.z) { const d = new THREE.Vector3(cx - t.x, 0, cz - t.z); t.add(d); p.add(d); }
  p.x = THREE.MathUtils.clamp(p.x, map.min.x - M, map.max.x + M);
  p.z = THREE.MathUtils.clamp(p.z, map.min.z - M, map.max.z + M);
}

async function boot() {
  let meta: Meta;
  [meta, climate] = await Promise.all([fetchJson<Meta>('data/meta.json'), fetchJson<Climate>('data/climate.json')]);
  views = meta.views;
  applyGfx(gfx.now);
  uniforms = makeUniforms(meta);
  const foliage = loadFoliage(uniforms), windows = loadWindows(uniforms);
  foliage.then(({ city }) => bar.setDays({ 'leaves out': city.leaf, 'trees in colour': city.colour, 'leaves down': city.fall, ...DAYS }))
    .catch((e) => console.warn('foliage', e));
  windows.then(({ set }) => { setWindows = set; }).catch((e) => console.warn('windows', e));
  // the light on the ground at night, drawn into the pages of the nodes shown (lamplight.ts, fields.ts)
  const lamps = new LampLight(meta);
  // the street lamps placed along the streets (streetlamps.ts, web/tools/lamps.mjs)
  const streetLamps = fetchJson<{ lamps: [number, number, number][] }>('data/streetlamps.json').then((j) => j.lamps).catch((e) => { console.warn('street lamps', e); return []; });
  const tileMat = makeVoxelMaterial(uniforms);
  streamer = new TileStreamer(meta, tileMat, scene);
  // ?dig=1: a click carves a hole in the city, until the page is loaded again (dig.ts; a developer's switch)
  if (qs.get('dig') === '1') { const S = streamer; import('./dig').then(({ installDig }) => installDig(S, camera, renderer.domElement, simReady)); }
  prepass = new DepthPrepass(streamer.group, scene);
  prepass.add(tileMat, makeVoxelPrepassMaterial(uniforms));
  prepass.enabled = gfx.now.prepass;
  world = nav.world = streamer.world;
  // the moving casters: street life (the cars and the motorbike driven are its own), and nav.actors' walker, boat,
  // floatplane and jet (the FPV drone has no model)
  daylight.casters(streamer.group, () => life || nav.third || nav.craftView ? movingActors : null);
  nav.streamer = streamer;
  nav.origin = meta.origin ?? [0, 0];
  map.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(meta.W, meta.H, meta.D));
  post.reflections.mapTop = meta.H;
  // (?cam= in the project grid's coordinates: meta.origin)
  const [ox, oz] = meta.origin ?? [0, 0];
  const v0 = views[qs.get('view') ?? ''] ?? views.overview, cam = qs.get('cam')?.split(',').map(Number).map((v, i) => v - (i % 3 === 0 ? ox : i % 3 === 2 ? oz : 0));
  // ?focus=bld:<id> | street:<id>: one object framed (focus.ts)
  const fo = qs.get('focus') ? await focusView(qs.get('focus')!, qs, camera.fov, camera.aspect) : null;
  camera.position.set(...(fo ? fo.pos : cam ? [cam[0], cam[1], cam[2]] as const : v0.pos));
  controls.target.set(...(fo ? fo.target : cam ? [cam[3], cam[4], cam[5]] as const : v0.target));
  post.taa.restart();
  daylight.uniforms = uniforms;
  daylight.bloom = post.bloom;
  daylight.grade = post.grade;
  daylight.ao = post.n8.configuration;
  daylight.theta = (meta.theta_deg || 0) * Math.PI / 180;
  const md = qs.get('date')?.split('-').map(Number);
  setDay(md ? dayOfYear(new Date(new Date().getFullYear(), md[0] - 1, md[1])) : TODAY);
  setWeather((qs.get('weather') ?? '') in WEATHERS ? qs.get('weather')! : 'typical', true);
  setHour(qs.get('hour') ? +qs.get('hour')! : timesOf(daylight.day)['golden hour']);
  city = await installCity({ streamer, uniforms, meta, scene, focus, camera, caption, budget, lamps, prepass, lod: { mode: gfx.now.lod, px: gfx.now.lodpx }, occlusion: gfx.now.occl, dist: gfx.now.dist || DIST_MAX,
    crop: cropOf(qs.get('crop') === 'fit' && fo ? String(Math.ceil(fo.reach + 128)) : qs.get('crop'), controls.target, meta.origin), pixelsHigh: () => post.height });
  cutNow = -1; // (the view distance handed to the city on the next frame)
  labels = new Labels(meta.labels, onLabel);
  labels.gate = city.gate;
  labels.visible = labelsOn;
  const mapView = minimap = new Minimap(meta);
  hud = new Hud(renderer.domElement, nav.mode);
  bar.search.setItems(searchItems(meta));
  fetchJson<{ places: Place[] }>('data/places.json').then(({ places }) => bar.search.setItems([...searchItems(meta),
    ...places.map(([name, kind, x, y, size, alt]) => ({ name, alt, kind, go: () => goPlace(x, y, size, { name, kind }) }))]));
  fountains = new Fountains(scene, meta.jets ?? []);
  fetchJson<FloodInfo>('data/flood.json').then((info) => {
    riverPoints = info.river ?? [];
    mapView.setRiver(riverPoints);
  })
    .catch((e) => { riverPoints = []; console.warn('river points', e); });
  fetchJson<TrafficData>('data/traffic.json').then(unpackTraffic).then((td) => {
    mapView.setRoads(td.roads);
    streetLamps.then((placed) => { lamps.addStreets(placed); lampHeads = new LampHeads(scene, placed, meta.origin); });
    // (the traffic's seed: a new one each load, or ?seed= to see the same traffic again)
    const seed = qs.get('seed') !== null ? +qs.get('seed')! : (Math.random() * 2 ** 32) >>> 0;
    // (the world sim made as a host would, sim-host.ts; its road physics (the shared Rapier world) loaded on the first
    // edit, with ?dig=1, or when the drive mode warms up. ?lifephys=0: no traffic bodies near edits (the drive still
    // loads it), ?lpnear=, ?lpmax=)
    // ?worker=1: in a Web Worker (sim.worker.ts), drawn from its snapshots (sim/snapshot.ts); ?mirror=1: in this
    // thread, drawn from its snapshots all the same
    const n = (k: string) => (qs.get(k) !== null ? +qs.get(k)! : undefined), eager = qs.get('dig') === '1';
    const physics = { bodies: qs.get('lifephys') !== '0', near: n('lpnear'), maxBodies: n('lpmax') };
    let client: SimClient;
    if (qs.get('worker') === '1') {
      const link = window.__simLink = new WorkerLink({ seed, physics, eager, player: LOCAL_PLAYER });
      client = new MirrorSimClient(link, td, world, LOCAL_PLAYER, true);
    } else {
      const own = qs.get('mirror') === '1' ? structuredClone(td) : null;
      const server = hostSim(meta, td, { seed, world, cache: viewerTileCache(meta.tiles.N), eager, physics: { ...physics, at: focus } });
      client = own ? new MirrorSimClient(new ThreadLink(server, LOCAL_PLAYER), own, world, LOCAL_PLAYER) : new LocalSimClient(server);
    }
    sim = client;
    life = nav.life = new StreetLife(scene, client);
    movingActors.add(life.group);
    window.__life = life;
    window.__sim = client;
    simLoaded(client);
  });
  $('#loading').classList.add('hidden');
  window.__streamer = streamer;
  window.__ready = true;
  const [{ ParagliderMode }, modes] = await Promise.all([import('./nav/special-craft'), Promise.all(CRAFTS())]);
  const ctx: CraftContext = { nav, camera, target: controls.target, meta, host: modeTools, canvas: renderer.domElement,
    env: { night: () => daylight.night, river: () => riverPoints },
    deployGlider: (source, at) => glider.deploy(source, at),
    sim: simReady,
    tiles: { meta, cache: viewerTileCache(meta.tiles.N), now: () => performance.now() },
  };
  const glider = new ParagliderMode(ctx);
  crafts = [...modes.map((C) => new C(ctx)), glider];
}

// ?crop=R: a tiny scene, only the 128 m tiles within R metres (along x and z) of the camera's first target;
// ?crop=x0,z0,x1,z1: those meeting that box (metres, the project grid's x and z as ?cam=); with ?focus=, crop=fit: the
// object and 128 m round it. For quick screenshots and checks (web/tools/shoot.mjs)
function cropOf(q: string | null, t: THREE.Vector3, origin: [number, number] = [0, 0]): [number, number, number, number] | null {
  const v = q?.split(',').map(Number);
  if (!v || v.some((x) => !Number.isFinite(x))) return null;
  if (v.length === 1 && v[0] > 0) return [t.x - v[0], t.z - v[0], t.x + v[0], t.z + v[0]];
  const [ox, oz] = origin;
  return v.length === 4 ? [v[0] - ox, v[1] - oz, v[2] - ox, v[3] - oz] : null;
}

let lastT = performance.now();
const t0 = lastT;
renderer.setAnimationLoop((now) => {
  fly?.(now);
  stepWeather(now);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  // (the car before Nav: it moves, then the ride camera follows it; the crafts that own the camera after Nav)
  for (const c of crafts) if (c.view === 'ride') c.update(dt);
  nav.update(dt);
  for (const c of crafts) if (c.view === 'own') c.update(dt);
  const bodyMode = nav.craft?.id ?? nav.mode;
  if (document.body.dataset.mode !== bodyMode) document.body.dataset.mode = bodyMode;
  if (document.body.dataset.nav !== nav.mode) document.body.dataset.nav = nav.mode;
  const walkLabel = nav.enteringWalk ? 'Entering walk…' : nav.third ? 'Exit walk' : 'Walk';
  if (walkButton.textContent !== walkLabel) walkButton.textContent = walkLabel;
  walkButton.disabled = !world || nav.enteringWalk || nav.craftView;
  if (nav.onMap) { controls.update(); nav.clamp(); keepInside(); }
  const above = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3;
  post.setHeight(above, gfx.now.tilt && !nav.craftView, camera.position.distanceTo(controls.target));
  const viewDist = camera.position.distanceTo(controls.target);
  viewCut(above);
  daylight.setFogFrom(viewDist, above);
  fitFar(); // (within the fog's far end)
  const t = (performance.now() - t0) / 1000;
  if (uniforms) uniforms.uTime.value = t;
  daylight.clouds.tick(t);
  setWindows?.(daylight.hour, daylight.day);
  fountains?.update(t, daylight.night);
  if (lampHeads) { lampHeads.night = daylight.night; lampHeads.update(camera); }
  const cp = camera.position;
  precip.update(t, cp, daylight.weather, daylight.night, world?.inRoom(cp.x, cp.z, cp.y) ?? false);
  if (city?.complete) document.body.classList.remove('loading');
  if (sim && life) {
    // the world sim ticks whether or not it is drawn (ADR 0008), simulated round what is looked at; agents come and go
    // far from the camera, which sees them
    sim.update(dt, { hour: daylight.hour, day: daylight.day, focus: focus(), viewer: camera.position });
    life.group.visible = !city || city.complete;
    if (life.group.visible) life.update(dt, daylight.night, camera.position);
  }
  daylight.sky.mesh.position.copy(camera.position);
  streamer?.update(camera);
  daylight.fitShadow(focus(), camera, viewDist, map);
  const redraws = daylight.redraws + daylight.patches;
  if (stillChanged()) stillDue = true;
  if (stillDue && now - redrawnAt > 300) { stillDue = false; redrawnAt = now; daylight.redrawShadow(); }
  renderer.info.reset();
  if (autoRes && !(gfx.isAuto('res') && gfx.isAuto('detail'))) autoRes.stop(); // the visitor set one of them
  if (autoRes?.done) autoRes = null;
  autoRes?.begin();
  post.composer.render();
  if (daylight.redraws + daylight.patches !== redraws) busy = true;
  autoRes?.end(now, { ready: !!city?.complete && city.settled && !!streamer?.idle && !stillDue && !document.hidden, disturbed: busy });
  busy = false;
  perf.frame(now, document.hidden, renderer.info.render.triangles);
  barRect ??= bar.rect;
  minimap?.update(now, nav.mapPose, barRect.bottom);
  labels?.update(camera, world, barRect, [...(hud?.rects ?? []), ...perf.rects, ...(minimap?.rects ?? [])]);
});

window.__three = { camera, controls, nav, bar, scene, renderer, flyTo, setHour, setDay, setWeather, map, daylight, post, budget,
  // the detail, as the visitor would set it (tools)
  level: () => gfx.now.detail, setLevel: (l: number) => { const c = { detail: Math.max(0, Math.min(1, l)) }; gfx.set(c); applyGfx(c); gfxPanel.show(); }, city: () => city, prepass: () => prepass, gfx,
  // any graphics setting, as the visitor would set it (tools)
  setGfx: (c: Partial<Gfx>) => { gfx.set(c); applyGfx(c); gfxPanel.show(); } };

// what the city's shadow map shows: which tiles are drawn (a tile in or out, or one distance level for another, is
// drawn again into the map where it casts: daylight.changed), and what folds, hides or thins them in its depth pass
// (the whole map drawn again)
let stillKey = '';
const casting = new Map<THREE.Object3D, THREE.BufferGeometry>();
function stillChanged() {
  if (!streamer || !uniforms) return false;
  const boxes: THREE.Box3[] = [], add = (g: THREE.BufferGeometry) => { if (g.boundingBox) boxes.push(g.boundingBox); };
  let n = 0;
  for (const m of streamer.group.children) {
    if (!m.visible) continue;
    n++;
    const g = (m as THREE.Mesh).geometry, was = casting.get(m);
    if (was === g) continue;
    if (was) add(was);
    add(g);
    casting.set(m, g);
  }
  if (n !== casting.size) for (const [m, g] of casting) if (!m.visible || m.parent !== streamer.group) { add(g); casting.delete(m); }
  daylight.changed(boxes);
  // (and once the city is complete: its foliage, which the leaves' shadows depend on, came with the last tiles)
  const U = uniforms, key = `${U.uStage.value},${U.uBldOn.value.version},${U.uFolOn.value},${U.uDay.value},${city?.complete}`;
  if (key === stillKey) return false;
  stillKey = key;
  return true;
}

// The view distance now: the setting, but no less than VIEW_PER_HEIGHT times the camera's height over the ground (in
// 100 m steps), so that from high up (the whole map's view, 2.5 km over it) the city below is not all haze. A street,
// Oberhaus, the overview (~560 m up) keep the setting.
const VIEW_PER_HEIGHT = 1.2, WHOLE_START = 0.75;
let cutNow = -1, affordNow = Infinity;
// 'Whole map' (dist 0) is DIST_MAX (5 km), so that on a large map it no longer loads all of it; its fog starts late.
// Within what the budget affords (city.ts affordable): the coarsest level's nodes in range at most half the budget (as
// detail 0 is twice the whole map's), the rest for the splits nearest and in view. Only a phone's ceiling ever makes it
// bite (on a desktop the budget is at least twice the whole map at 8 m); the camera's height still widens it (the
// overview: the whole map at 8 m). It shrinks at once and grows again only by AFFORD_STEP, not to and fro as the
// camera moves; never under DIST_MIN.
const AFFORD_STEP = 300;
function viewCut(above: number) {
  const a = Math.max(DIST_MIN, city?.affordable(budget() / 2) ?? Infinity);
  if (a < affordNow || a >= affordNow + AFFORD_STEP) affordNow = a;
  const want = gfx.now.dist || DIST_MAX, d = Math.min(want, affordNow), c = Math.max(d, Math.ceil((above * VIEW_PER_HEIGHT) / 100) * 100);
  if (c === cutNow) return;
  cutNow = c;
  daylight.setCut(c, gfx.now.dist || d < want ? undefined : WHOLE_START);
  city?.setDist(c);
}

// The far plane: out to the map's furthest corner from the camera (the far ground stands to the map's edge, faintly
// through the view distance's fog: farground.ts), within FAR_PER_CUT times the view distance where there is one, and
// within the weather fog's far end (daylight.setFogFrom: past it all is the fog's colour; in clear weather it lies
// beyond Passau's map from anywhere in it, so on a larger map the far plane, with 'whole map', no longer grows with
// the map), and never inside the sky's sphere (sky.ts, 6000 m). In FAR_STEP steps, so that it seldom changes (the depth's scale with
// it: the TAA's history, the occlusion's horizons).
const SKY_R = 6000, FAR_PER_CUT = 4, FAR_STEP = 500;
function fitFar() {
  if (map.isEmpty()) return;
  const p = camera.position;
  const reach = Math.hypot(Math.max(p.x - map.min.x, map.max.x - p.x), Math.max(p.y - map.min.y, map.max.y - p.y), Math.max(p.z - map.min.z, map.max.z - p.z));
  const fogFar = (scene.fog as THREE.Fog | null)?.far ?? Infinity;
  const want = Math.max(SKY_R + FAR_STEP, Math.min(reach, cutNow > 0 ? cutNow * FAR_PER_CUT : Infinity, fogFar));
  const far = Math.ceil(want / FAR_STEP) * FAR_STEP;
  if (far === camera.far) return;
  camera.far = far;
  camera.updateProjectionMatrix();
}

// busy: this frame changed the settings or redrew the shadow map (autores.ts leaves it out)
let busy = false, stillDue = false, redrawnAt = 0;
