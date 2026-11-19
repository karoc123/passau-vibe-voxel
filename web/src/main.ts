import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Bar } from './bar';
import { Caption } from './caption';
import { installCity } from './city';
import { Daylight } from './daylight';
import { Flood } from './flood';
import { loadFoliage } from './foliage';
import { loadWindows } from './windows';
import { LampHeads } from './lamps';
import { Fountains } from './fountains';
import { Hud } from './hud';
import { Labels } from './labels';
import type { DrivePrototype } from './nav/drive.prototype';
import type { FpvPrototype } from './nav/fpv.prototype';
import { Nav, type Mode, type Ride } from './nav/nav';
import { Perf } from './perf';
import { makePost } from './post';
import type { SearchItem } from './search';
import { StreetLife } from './sim/life';
import { Boats, type BoatData } from './sim/boats';
import type { Kind, TrafficData } from './sim/types';
import { TileStreamer } from './stream';
import type { Facts, Label, Meta, Place, View } from './types';
import { dateOf, dayOfYear, hourAt, solarNoon } from './sun';
import { $, coarsePointer, ease, el, fetchJson, lerp } from './util';
import { type Climate, Precip, typical, type Weather, WEATHERS } from './weather';
import type { World } from './world';
import { makeUniforms, makeVoxelMaterial, makeVoxelPrepassMaterial } from './voxelMaterial';
import { LampLight } from './lamplight';
import { DepthPrepass } from './prepass';
import { AUTO_KEYS, type Gfx, gpuName, prepassPays, Settings } from './settings';
import { AutoRes } from './autores';
import './style.css';

declare global {
  interface Window { __ready?: boolean; __three?: object; __life?: StreetLife; __streamer?: TileStreamer }
}

// river level, cm relative to the survey day's surface. Not calibrated to the Passau gauges: no gauge readings or flood
// years here; below the surveyed level the bed is schematic (scripts/flood.py)
const RIVER = { lowest: -300, surveyed: 0, highest: 1000 };

const TODAY = dayOfYear(new Date());
const DAYS = { midsummer: 172, midwinter: 355, today: TODAY };

const qs = new URLSearchParams(location.search);
// the graphics settings (settings.ts, the ⚙ panel), the resolution and the detail among them: set by the visitor, else
// chosen once (autores.ts), then fixed for the session
const phone = Math.min(screen.width, screen.height) < 600;
const gpu = gpuName();
const gfx = new Settings(phone, innerWidth >= 600, prepassPays(gpu), gpu);
// The detail, 0 to 1: the triangles the city's tiles may draw (city.ts picks their levels by it, the nearest finest),
// evenly on a log scale from twice the whole map at 8 m (0: 0.5 M, the whole map at 8 m and some 4 m around the
// camera) to all of it at 1 m with its foliage (14.7 M; at 1 no limit at all): 0.45 ~2.3 M (the whole map at 4 m, the
// nearest at 2 and 1 m), 0.75 ~6.3 M. Phones draw 2 M at most whatever it says (the 1 m tiles of the whole map need ~2
// GB of GPU).
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
let fpv: FpvPrototype | null = null;
let drive: DrivePrototype | null = null;
const bar = new Bar({ days: DAYS, weathers: ['typical', ...Object.keys(WEATHERS)], river: RIVER, onDay: (d) => { setDay(d); share(); },
  onDayEnd: () => { if (weatherName === 'typical') setWeather('typical'); },
  onHour: (h) => { setHour(h); share(); },
  onWeather: (w) => { setWeather(w); share(); }, onRiver: (cm) => { flood?.setLevel(cm); } });
const precip = new Precip(scene);
const map = new THREE.Box3();
let world: World | null = null, labels: Labels | null = null, hud: Hud | null = null;
let life: StreetLife | null = null, boats: Boats | null = null, flood: Flood | null = null, fountains: Fountains | null = null;
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
bar.setRiver(RIVER.surveyed);
bar.showRiver(false);
const modeTools = el('div', 'mode-tools', '', bar.el);
const walkButton = el('button', 'mode-button', 'Walk', modeTools);
walkButton.type = 'button';
walkButton.disabled = true;
walkButton.addEventListener('click', e => {
  walkButton.blur();
  drive?.park();
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
  <div>weather <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0), phenology <a href="https://www.dwd.de/" target="_blank" rel="noopener">Deutscher Wetterdienst</a> (DL-DE BY 2.0)</div>`);
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
if (qs.get('ui') === '0') document.body.classList.add('noui');
addEventListener('resize', onResize);
addEventListener('keydown', (e) => {
  if (e.key === '/' && !(e.metaKey || e.ctrlKey || e.altKey) && !(e.target as Element).closest?.('input')) { bar.search.input.focus(); e.preventDefault(); }
});
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
    if (!e.ctrlKey || !e.isTrusted || nav.mode !== 'orbit') return;
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
  document.body.classList.toggle('walking', m !== 'orbit');
  document.body.classList.toggle('fpv', m === 'fpv');
  hud?.set(m, ride);
}

const focus = () => (nav.mode === 'orbit' ? controls.target : camera.position);

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

// frame a place from the current compass direction, ~30° down, with a label on it; at street level, walk there
function goPlace(x: number, y: number, size: number, pin: Facts | null, name = pin?.name ?? '') {
  if (!world) return;
  if (nav.mode === 'fpv') nav.setOrbit();
  const g = world.groundAt(x, y), top = world.top(Math.floor(x), Math.floor(y)), h = Math.max(0, top - g);
  labels?.pin(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
  if (nav.mode !== 'orbit') {
    nav.setWalk({ at: new THREE.Vector3(x + 0.5, g, y + 0.5), deckOK: /^(Most|Kładka|Wiadukt)\b/.test(name), thirdPerson: nav.mode === 'pedestrian' });
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
  if (v && nav.mode === 'orbit') goView(v);
  else goPlace(l.x, l.y, 60, null, l.name);
}

// moving vehicles are hard to click from the air: the nearest one to what you look at
function followNearest(kind: Kind) {
  const ag = life?.nearest(kind, focus(), null);
  if (ag) nav.startRide(ag);
}

function searchItems(meta: Meta): SearchItem[] {
  return [
    ...Object.values(meta.views).map((v) => ({ name: v.label, kind: 'viewpoint', featured: true, go: () => goView(v) })),
    ...meta.labels.map((l) => ({ name: l.name, alt: [l.en, l.alt].join(' '), kind: l.kind, go: () => goPlace(l.x, l.y, Math.max(40, (l.R ?? 20) * 1.4), null, l.name) })),
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
  prepass = new DepthPrepass(streamer.group, scene);
  prepass.add(tileMat, makeVoxelPrepassMaterial(uniforms));
  prepass.enabled = gfx.now.prepass;
  world = nav.world = streamer.world;
  daylight.casters(streamer.group, () => life || nav.mode === 'pedestrian' ? movingActors : null);
  nav.streamer = streamer;
  map.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(meta.W, meta.H, meta.D));
  post.reflections.mapTop = meta.H;
  const v0 = views[qs.get('view') ?? ''] ?? views.overview, cam = qs.get('cam')?.split(',').map(Number);
  camera.position.set(...(cam ? [cam[0], cam[1], cam[2]] as const : v0.pos));
  controls.target.set(...(cam ? [cam[3], cam[4], cam[5]] as const : v0.target));
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
  city = await installCity({ streamer, uniforms, meta, scene, focus, camera, caption, budget, lamps, prepass, lod: { mode: gfx.now.lod, px: gfx.now.lodpx }, occlusion: gfx.now.occl, dist: gfx.now.dist,
    pixelsHigh: () => post.height });
  cutNow = -1; // (the view distance handed to the city on the next frame)
  labels = new Labels(meta.labels, onLabel);
  labels.gate = city.gate;
  hud = new Hud(renderer.domElement, nav.mode);
  bar.search.setItems(searchItems(meta));
  fetchJson<{ places: Place[] }>('data/places.json').then(({ places }) => bar.search.setItems([...searchItems(meta),
    ...places.map(([name, kind, x, y, size, alt]) => ({ name, alt, kind, go: () => goPlace(x, y, size, { name, kind }) }))]));
  fountains = new Fountains(scene, meta.jets ?? []);
  flood = new Flood(scene, uniforms, meta);
  flood.load().then(() => { bar.river.input.disabled = false; flood!.setLevel(RIVER.surveyed); }).catch((e) => console.warn('flood', e));
  fetchJson<TrafficData>('data/traffic.json').then((td) => {
    streetLamps.then((placed) => { lamps.addStreets(placed); lampHeads = new LampHeads(scene, placed); });
    life = nav.life = new StreetLife(scene, td);
    movingActors.add(life.group);
    life.world = world;
    window.__life = life;
    fetchJson<BoatData>('data/boats.json').then((bd) => {
      boats = new Boats(bd, flood?.info?.voxel_top ?? 4);
      life!.group.add(boats.group); // shown, hidden and shadowed with the rest of the moving things
    }).catch((e) => console.warn('boats', e));
  });
  $('#loading').classList.add('hidden');
  window.__streamer = streamer;
  window.__ready = true;
  const [{ FpvPrototype }, { DrivePrototype }] = await Promise.all([
    import('./nav/fpv.prototype'), import('./nav/drive.prototype'),
  ]);
  fpv = new FpvPrototype(nav, camera, controls.target, meta, modeTools, renderer.domElement);
  drive = new DrivePrototype(nav, controls.target, meta, modeTools, renderer.domElement);
}

let lastT = performance.now(), riverT = 0, riverSeen = -1e9;
const t0 = lastT;
renderer.setAnimationLoop((now) => {
  fly?.(now);
  stepWeather(now);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  drive?.update(dt);
  nav.update(dt);
  fpv?.update(dt);
  const walkLabel = nav.enteringWalk ? 'Entering walk…' : nav.mode === 'pedestrian' ? 'Exit walk' : 'Walk';
  if (walkButton.textContent !== walkLabel) walkButton.textContent = walkLabel;
  walkButton.disabled = !world || nav.enteringWalk || nav.mode === 'fpv';
  if (nav.mode === 'orbit') { controls.update(); nav.clamp(); keepInside(); }
  const above = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3;
  post.setHeight(above, gfx.now.tilt && nav.mode !== 'fpv', camera.position.distanceTo(controls.target));
  const viewDist = camera.position.distanceTo(controls.target);
  viewCut(above);
  fitFar();
  daylight.setFogFrom(viewDist, above);
  const t = (performance.now() - t0) / 1000;
  if (uniforms) uniforms.uTime.value = t;
  daylight.clouds.tick(t);
  setWindows?.(daylight.hour, daylight.day);
  fountains?.update(t, daylight.night);
  if (lampHeads) lampHeads.night = daylight.night;
  precip.update(t, camera.position, daylight.weather, daylight.night);
  if (city?.complete) document.body.classList.remove('loading');
  if (life) {
    life.group.visible = !city || city.complete;
    if (life.group.visible) {
      life.day = daylight.day;
      life.update(dt, daylight.hour, daylight.night, focus());
      boats?.update(dt, daylight.hour, daylight.day, daylight.night, flood?.level ?? 0);
    }
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
  if (flood && now - riverT > 250) {
    riverT = now;
    if (flood.inView(camera, 2500) || Math.abs(bar.river.value - RIVER.surveyed) > 20) riverSeen = now;
    bar.showRiver(now - riverSeen < 2000);
  }
  barRect ??= bar.rect;
  labels?.update(camera, world, barRect, [...(hud?.rects ?? []), ...perf.rects]);
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
const VIEW_PER_HEIGHT = 1.2;
let cutNow = -1;
function viewCut(above: number) {
  const d = gfx.now.dist, c = d ? Math.max(d, Math.ceil((above * VIEW_PER_HEIGHT) / 100) * 100) : 0;
  if (c === cutNow) return;
  cutNow = c;
  daylight.setCut(c);
  city?.setDist(c);
}

// The far plane: out to the map's furthest corner from the camera (the far ground stands to the map's edge, faintly
// through the view distance's fog: farground.ts), within FAR_PER_CUT times the view distance where there is one, and
// never inside the sky's sphere (sky.ts, 6000 m). In FAR_STEP steps, so that it seldom changes (the depth's scale with
// it: the TAA's history, the occlusion's horizons).
const SKY_R = 6000, FAR_PER_CUT = 4, FAR_STEP = 500;
function fitFar() {
  if (map.isEmpty()) return;
  const p = camera.position;
  const reach = Math.hypot(Math.max(p.x - map.min.x, map.max.x - p.x), Math.max(p.y - map.min.y, map.max.y - p.y), Math.max(p.z - map.min.z, map.max.z - p.z));
  const want = Math.max(SKY_R + FAR_STEP, cutNow > 0 ? Math.min(reach, cutNow * FAR_PER_CUT) : reach);
  const far = Math.ceil(want / FAR_STEP) * FAR_STEP;
  if (far === camera.far) return;
  camera.far = far;
  camera.updateProjectionMatrix();
}

// busy: this frame changed the settings or redrew the shadow map (autores.ts leaves it out)
let busy = false, stillDue = false, redrawnAt = 0;
