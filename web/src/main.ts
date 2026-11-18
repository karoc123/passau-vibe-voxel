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
import { $, coarsePointer, ease, el, fetchGzip, fetchJson, lerp } from './util';
import { type Climate, Precip, typical, type Weather, WEATHERS } from './weather';
import type { World } from './world';
import { lightStreets, makeUniforms, makeVoxelMaterial, makeVoxelPrepassMaterial } from './voxelMaterial';
import { DepthPrepass } from './prepass';
import { type Gfx, Settings } from './settings';
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
// Render size, one level from 0 to 1 (the slider; set by the frames, adapt): how much of the city is 1 m around the focus
// (city.ts; the rest is 8 m clay), from 0.2 M triangles of buildings to all of them, and in its lower part how many
// pixels, down to half of the screen's. Phones hold 0.75 M at most, as the 1 m tiles of the whole map need ~2 GB of GPU.
const phone = Math.min(screen.width, screen.height) < 600;
const ceiling = phone ? 0.75e6 : Infinity;
let level = 0.75;
const budget = () => (level >= 1 ? ceiling : Math.min(ceiling, 0.2e6 * ((city?.cityTris ?? 14e6) / 0.2e6) ** level));
// the graphics settings (settings.ts, the ⚙ panel): the resolution scales the render size's pixels
const gfx = new Settings(phone, innerWidth >= 600);
const pixelsAt = (l: number) => Math.max(0.5, Math.min(1, 0.4 + 0.8 * l)) * Math.min(devicePixelRatio, 2) * gfx.now.res;
const renderer = makeRenderer();
const scene = new THREE.Scene();
const movingActors = new THREE.Group();
scene.add(movingActors);
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.5, 9000);
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
const perf = new Perf(setLevel);
perf.show(level);
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
bar.graphics(gfx, applyGfx, maxShadow);
gfx.writeUrl();
new ResizeObserver(() => { barRect = null; }).observe(bar.el);
el('div', '', `<div>Passau in voxels, derived from <a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">warsaw-vibe-voxel</a> by <a href="https://p.migdal.pl/" target="_blank" rel="noopener">Piotr Migdał</a> & <a href="https://quesma.com/blog/invisible-cities-one-shot/" target="_blank" rel="noopener">Opus 5.5</a> (MIT)</div>
  <div>data: <a href="https://www.geodaten.bayern.de" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a> (CC BY 4.0) and <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> contributors (ODbL)</div>
  <div>weather <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0), phenology <a href="https://www.dwd.de/" target="_blank" rel="noopener">Deutscher Wetterdienst</a> (DL-DE BY 2.0)</div>`).id = 'credits';
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
  r.setPixelRatio(pixelsAt(level));
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
  if ('res' in c) setLevel(level);
  if ('shadow' in c) { daylight.setShadowSize(g.shadow, maxShadow); stillDue = true; }
  if ('ao' in c) post.n8.enabled = g.ao;
  if ('bloom' in c) post.bloomPass.enabled = g.bloom;
  if ('refl' in c) post.reflPass.enabled = g.refl;
  if ('grade' in c) post.film.strength = g.grade;
  if ('lod' in c || 'lodpx' in c) city?.setLod({ mode: g.lod, px: g.lodpx });
  if ('prepass' in c && prepass) prepass.enabled = g.prepass;
  if ('occl' in c) city?.setOcclusion(g.occl);
  busy = true;
}

function onMode(m: Mode, ride: Ride | null) {
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
  const foliage = loadFoliage(meta, uniforms), windows = loadWindows(meta, uniforms);
  foliage.then(({ city }) => bar.setDays({ 'leaves out': city.leaf, 'trees in colour': city.colour, 'leaves down': city.fall, ...DAYS }))
    .catch((e) => console.warn('foliage', e));
  windows.then(({ set }) => { setWindows = set; }).catch((e) => console.warn('windows', e));
  // where the street lights go: the buildings and the woods
  const ground = Promise.all([windows, foliage, fetchGzip('data/terrain.bin')])
    .then(([w, f, terrain]) => ({ buildings: w.cells, trees: f.trees, terrain })).catch(() => null);
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
  daylight.uniforms = uniforms;
  daylight.bloom = post.bloom;
  daylight.grade = post.grade;
  daylight.ao = post.n8.configuration;
  daylight.theta = (meta.theta_deg || 0) * Math.PI / 180;
  const md = qs.get('date')?.split('-').map(Number);
  setDay(md ? dayOfYear(new Date(new Date().getFullYear(), md[0] - 1, md[1])) : TODAY);
  setWeather((qs.get('weather') ?? '') in WEATHERS ? qs.get('weather')! : 'typical', true);
  setHour(qs.get('hour') ? +qs.get('hour')! : timesOf(daylight.day)['golden hour']);
  city = await installCity({ streamer, uniforms, meta, scene, focus, camera, caption, budget, prepass, lod: { mode: gfx.now.lod, px: gfx.now.lodpx }, occlusion: gfx.now.occl });
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
    ground.then((g) => { lampHeads = new LampHeads(scene, lightStreets(uniforms!, meta, td.roads, td.peds, g)); });
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
  fpv = new FpvPrototype(nav, camera, controls.target, meta, modeTools);
  drive = new DrivePrototype(nav, controls.target, meta, modeTools);
}

let lastT = performance.now(), riverT = 0, riverSeen = -1e9;
const frames: number[] = [];
const t0 = lastT;
renderer.setAnimationLoop((now) => {
  fly?.(now);
  stepWeather(now);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  adapt(dt, now);
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
  const redraws = daylight.redraws;
  if (stillChanged()) stillDue = true;
  if (stillDue && now - redrawnAt > 300) { stillDue = false; redrawnAt = now; daylight.redrawShadow(); }
  renderer.info.reset();
  post.composer.render();
  if (daylight.redraws !== redraws) busy = true;
  perf.frame(now, document.hidden, renderer.info.render.triangles);
  if (flood && now - riverT > 250) {
    riverT = now;
    if (flood.inView(camera, 2500) || Math.abs(bar.river.value - RIVER.surveyed) > 20) riverSeen = now;
    bar.showRiver(now - riverSeen < 2000);
  }
  barRect ??= bar.rect;
  labels?.update(camera, world, barRect, [...(hud?.rects ?? []), ...perf.rects]);
});

window.__three = { camera, controls, nav, bar, scene, renderer, flyTo, setHour, setDay, setWeather, map, daylight, post, budget, level: () => level, setLevel: (l: number) => { perf.manual = true; setLevel(l); }, city: () => city, prepass: () => prepass, gfx };

// what the city's shadow map shows: which tiles are drawn, and what folds, hides or thins them in its depth pass
let stillKey = '';
function stillChanged() {
  if (!streamer || !uniforms) return false;
  let n = 0, ids = 0;
  for (const m of streamer.group.children) if (m.visible) { n++; ids += m.id; }
  const U = uniforms, key = `${n},${ids},${U.uStage.value},${U.uBldOn.value.version},${U.uZOn.value},${U.uZFBlk.value.version},${U.uFolOn.value},${U.uDay.value},${U.uFolMap.value.id}`;
  if (key === stillKey) return false;
  stillKey = key;
  return true;
}

// The level from steady frames: frames that redrew the city's shadow or changed the pixels are left out. In windows of
// 30 frames (or 1 s): slow twice running (median under 27 fps), a step down, bigger the slower, and no growing past it
// for a minute; smooth twice running (the slowest tenth over 30 fps) with all the city asked for in, a step up, bigger
// at the screen's own rate.
let busy = false, stillDue = false, redrawnAt = 0, slow = 0, calm = 0, cap = 1, capAt = 0, windowAt = 0;
function setLevel(l: number) {
  level = Math.max(0, Math.min(1, l));
  const px = pixelsAt(level);
  if (Math.abs(px - renderer.getPixelRatio()) > 0.01) { renderer.setPixelRatio(px); onResize(); busy = true; }
  perf.show(level);
}
function adapt(dt: number, now: number) {
  const skip = busy;
  busy = false;
  if (!city || document.hidden || dt > 0.5) { frames.length = 0; return; }
  if (skip) return;
  if (!frames.length) windowAt = now;
  frames.push(dt);
  if (frames.length < 30 && (frames.length < 6 || now - windowAt < 1000)) return;
  frames.sort((a, b) => a - b);
  const median = frames[frames.length >> 1], p90 = frames[Math.floor(frames.length * 0.9)];
  frames.length = 0;
  if (perf.manual) return;
  if (now - capAt > 60000) cap = 1;
  if (median > 1 / 27) {
    calm = 0;
    if (++slow < 2) return;
    slow = 0;
    setLevel(level - 0.08 * Math.min(3, median * 27));
    cap = level; capAt = now;
  } else if (p90 < 1 / 30 && city.settled && level < cap) {
    slow = 0;
    if (++calm < 2) return;
    calm = 0;
    setLevel(Math.min(cap, level + (p90 < 1 / 50 ? 0.1 : 0.04)));
  } else { slow = 0; calm = 0; }
}

