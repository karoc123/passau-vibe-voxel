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
import { MapData, type MapMark, Minimap } from './minimap';
import { FullMap } from './fullmap';
import { Waypoint } from './waypoint';
import type { CraftContext, PlayerCraft } from './nav/craft';
import { Nav, type Mode, type Ride } from './nav/nav';
import { gameKey, pause, typing } from './nav/input';
import { Perf } from './perf';
import { makePost } from './post';
import { StreetLife } from './view/life';
import type { CraftView, SimClient } from './client/sim-client';
import type { CraftsView } from './view/crafts/crafts-view';
import type { ParagliderMode } from './nav/special-craft';
import type { PassengerMode } from './nav/passenger';
import { viewerTileCache } from './viewer-tiles';
import type { Kind, TrafficData } from './sim/types';
import { unpackTraffic } from './sim/traffic-pack';
import { TileStreamer } from './stream';
import { checkBuild, CLIENT_FILES, dataUrl, HOST_FILES } from './core/data-contract';
import type { Meta, View } from './core/meta';
import type { FloodInfo, Place } from './types';
import { dayOfYear } from './sun';
import { $, coarsePointer, el, fetchJson } from './util';
import { type Climate, Precip } from './weather';
import type { World } from './core/world';
import { makeUniforms, makeVoxelMaterial, makeVoxelPrepassMaterial } from './voxelMaterial';
import { LampLight } from './lamplight';
import { DepthPrepass } from './prepass';
import { AUTO_KEYS, DIST_MAX, type Gfx, gpuName, prepassPays, Settings } from './settings';
import { AutoRes } from './autores';
import { focusView } from './focus';
import { ViewDistance } from './view-distance';
import { banner, toast } from './ui/toast';
import { makeCredits } from './ui/credits';
import { loadPrefs, makeMenu, preselect, skipStart, startMenu } from './ui/menu';
import { NameTags } from './ui/name-tags';
import { makeBoardButton, makeCanopyButton, makeJumpButton, makeSeatButton, makeTouchArms } from './touch/buttons';
import { Boarding } from './nav/board';
import { makeArmsHud } from './ui/arms';
import { makeHealthHud } from './ui/health';
import { makeIncomingHud } from './ui/incoming';
import { incoming } from './client/incoming';
import { LEVELS } from './sim/tank';
import { shake } from './nav/chase-rig';
import { WeaponsView } from './view/weapons/weapons-view';
import { wreckSmoke } from './view/wreck-smoke';
import { makeDayWeather } from './ui/day-weather';
import { Graphics } from './ui/graphics';
import { makeGoTo } from './ui/go-to';
import { hook } from './app/debug-hooks';
import { frameLoop } from './app/frame';
import { HOST_PORT, openSession, pageView, PageTime, sessionOptions } from './app/session';
import { RETRY_MS, SocketLink } from './client/sim-worker-link';
import { LiveEdits } from './core/live-edits';
import './style.css';

const TODAY = dayOfYear(new Date());
const DAYS = { midsummer: 172, midwinter: 355, today: TODAY };

const qs = new URLSearchParams(location.search);
// the graphics settings (settings.ts, the menu's Graphics), the resolution and the detail among them: set by the visitor, else
// chosen once (autores.ts), then fixed for the session
const phone = Math.min(screen.width, screen.height) < 600;
const gpu = gpuName();
const gfx = new Settings(phone, innerWidth >= 600, prepassPays(gpu), gpu);
// the player's own settings (ui/menu.ts: the name, the frame cap)
const prefs = loadPrefs(phone);
// the host chosen in the start menu (null: alone), the city loading behind it; a URL that names one skips it
const serverChoice: Promise<string | null> = skipStart(qs) ? Promise.resolve(sessionOptions(qs).server) : (() => {
  pause(true);
  return startMenu(prefs, preselect(HOST_PORT), () => {}).finally(() => pause(false));
})();
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
const nav = new Nav(camera, controls, renderer.domElement, (v) => goTo.flyTo(v), onMode);
movingActors.add(nav.actors);
// the player's crafts (nav/craft.ts), one line each; their panels in this order. Loaded once the city is shown (boot)
const CRAFTS = () => [
  import('./nav/fpv').then((m) => m.FpvMode),
  import('./nav/drive').then((m) => m.DriveMode),
  import('./nav/boat').then((m) => m.BoatMode),
  import('./nav/plane').then((m) => m.PlaneMode),
  import('./nav/special-craft').then((m) => m.HovercraftMode),
  import('./nav/special-craft').then((m) => m.HelicopterMode),
  import('./nav/special-craft').then((m) => m.GunshipMode),
  import('./nav/passenger').then((m) => m.PassengerMode),
];
let crafts: PlayerCraft[] = [];
// the world's crafts the local player does not fly (left by their pilots, or other players')
let craftsView: CraftsView | null = null;
let glider: ParagliderMode | null = null;
const bar = new Bar();
const menu = makeMenu(prefs, {
  paused: pause,
  resumed: (mouse) => { if (mouse) nav.resumeMouse(); },
  canOrbit: () => !nav.onMap,
  toOrbit: () => nav.flyUp(),
  changed: (p) => sim?.setName(p.name),
});
const gfxSection = menu.section('Graphics');
// the menu's day, hour and weather (ui/day-weather.ts); the day and hour asked of the world through the client (PageTime)
const dayWeather = makeDayWeather({ box: menu.section('Time &amp; weather').box, days: DAYS, daylight, ask: (h, d) => pageTime?.ask(h, d) });
void serverChoice.then((s) => { dayWeather.online = s !== null; });
// the menu's Debug: what the sandbox grants for trying things out; an NPC enemy goes a few metres ahead of the walker
const debugBox = menu.section('Debug').box;
for (const duty of ['guard', 'patrol', 'lookout'] as const) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-entry';
  b.textContent = `NPC here: ${duty}`;
  b.addEventListener('click', () => {
    if (sim?.seat()?.role === 'walker') { sim.send({ kind: 'request', request: { kind: 'npc', duty } }); toast(`NPC put down (${duty})`); }
    else toast('NPCs are put down on foot only');
  });
  debugBox.append(b);
}
{
  // (an enemy plane comes from out of sight, ~20 s off: from wherever the player is, flying too)
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-entry';
  b.textContent = 'Enemy plane here';
  b.addEventListener('click', () => {
    if (!sim) return;
    sim.send({ kind: 'request', request: { kind: 'npc', duty: 'pilot' } });
    toast('Enemy plane called: it comes from out of sight');
  });
  debugBox.append(b);
}
const precip = new Precip(scene);
const map = new THREE.Box3();
let world: World | null = null, labels: Labels | null = null, hud: Hud | null = null;
let minimap: Minimap | null = null, fullmap: FullMap | null = null;
// the page's own waypoint (waypoint.ts), set from the maps
const waypoint = new Waypoint(scene);
// the world sim's client (client/sim-client.ts: the page reaches the sim only through it) and its presentation, once the
// traffic is loaded (the crafts wait for it and for the host's hello, whose tuning their cores are made with: simReady)
let weapons: WeaponsView | null = null;
let sim: SimClient | null = null, pageTime: PageTime | null = null, life: StreetLife | null = null, fountains: Fountains | null = null;
// the rivers' points (flood.json `river`, sim/river.ts) for the boat and the floatplane: null until loaded, [] if none
let riverPoints: number[] | null = null;
let simLoaded: (sim: SimClient) => void = () => {};
const simReady = new Promise<SimClient>((resolve) => { simLoaded = resolve; });
let city: Awaited<ReturnType<typeof installCity>> | null = null;
// the view distance and the far plane (view-distance.ts), each frame
const viewDistance = new ViewDistance({ camera, scene, map, daylight, gfx, city: () => city, budget });
let uniforms: ReturnType<typeof makeUniforms> | null = null, streamer: TileStreamer | null = null, views: Record<string, View> = {};
let prepass: DepthPrepass | null = null;
let barRect: DOMRect | null = null;
const caption = new Caption();
const perf = new Perf();
let setWindows: ((hour: number, day: number) => void) | null = null;
let lampHeads: LampHeads | null = null;

// the fly-to, the search's places and the labels clicked (ui/go-to.ts)
const goTo = makeGoTo({ camera, target: controls.target, nav, world: () => world, labels: () => labels, views: () => views,
  follow: followNearest });
nav.cancelFly = goTo.cancel;
const modeTools = el('div', 'mode-tools', '', bar.el);
const walkButton = el('button', 'mode-button walk-button', 'Walk', modeTools);
walkButton.type = 'button';
walkButton.disabled = true;
walkButton.addEventListener('click', e => {
  walkButton.blur();
  nav.leaveCraft(); // (the car driven parks; you step out beside it)
  const touch = e instanceof PointerEvent && (e.pointerType === 'touch' || e.pointerType === 'pen');
  void nav.toggleWalk(!touch && !coarsePointer());
});
// on a phone the bar open over play hides half the view: leaving the map folds it (style.css: then only the mode's
// own buttons and status beside the fold button), back on the map it opens again if it was open
const smallScreen = matchMedia('(max-width: 600px), (max-height: 500px)');
let openOnMap = false;
function foldForPlay(fromMap: boolean, toMap: boolean) {
  if (fromMap && !toMap) {
    openOnMap = !bar.folded;
    if (smallScreen.matches) bar.fold(true);
  } else if (toMap && openOnMap) bar.fold(false);
}
const maxShadow = renderer.capabilities.maxTextureSize;
const gfxPanel = new Graphics(gfxSection.box, gfxSection.mark, gfx, applyGfx, maxShadow);
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
makeCredits();
nav.onLockLost = () => menu.open();
const nameTags = new NameTags();
makeJumpButton(() => nav.jump());
const canopyButton = makeCanopyButton(() => glider?.press());
const armsHud = makeArmsHud(), healthHud = makeHealthHud(), incomingHud = makeIncomingHud();
const boarding = new Boarding(nav, () => crafts, (s) => toast(s), () => crafts.find((c): c is PassengerMode => c.id === 'passenger') ?? null);
const boardButton = makeBoardButton(() => boarding.press());
const seatButton = makeSeatButton(() => boarding.swap());
makeTouchArms(() => nav.arms.cycle(1), () => { if (nav.onFoot) nav.hookShot(); else glider?.hookShot(); });
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
  // F: into the nearest craft no one pilots (left in the world), from the map or a ride
  if (e.code === 'KeyF' && gameKey(e) && !e.repeat && nav.canStartCraft) {
    if (!boardNearest()) toast('No empty craft near here');
    e.preventDefault();
  }
  if (e.code === 'KeyM' && gameKey(e) && !e.repeat && minimap) {
    minimap.toggle();
    e.preventDefault();
  }
  // , the full map; Backspace or Delete clears the waypoint
  if (e.code === 'Comma' && gameKey(e) && !e.repeat && fullmap) {
    fullmap.toggle();
    e.preventDefault();
  }
  if ((e.code === 'Backspace' || e.code === 'Delete') && gameKey(e) && !e.repeat && waypoint.at) {
    waypoint.clear();
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
  // a pinch or Ctrl+wheel over the HUD, on foot or in a craft would zoom the whole page; the game's handlers still get it
  addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  addEventListener('gesturestart', (e) => e.preventDefault());
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
  hud?.set(m, ride, ride ? life?.agent(ride.ref) ?? null : null);
}

const focus = () => (nav.onMap ? controls.target : camera.position);

// moving vehicles are hard to click from the air: the nearest one to what you look at
function followNearest(kind: Kind) {
  const ag = life?.nearest(kind, focus(), null);
  if (ag) nav.startRide(ag);
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
  const [meta, climate] = await Promise.all([fetchJson<Meta>(dataUrl(HOST_FILES.meta)), fetchJson<Climate>(dataUrl(CLIENT_FILES.climate))]);
  // a build this code does not read stops here, said (core/data-contract.ts; the host checks it again, hostSim)
  try { checkBuild(meta, (w) => console.warn(w)); } catch (e) { toast((e as Error).message); throw e; }
  views = meta.views;
  applyGfx(gfx.now);
  uniforms = makeUniforms(meta);
  const foliage = loadFoliage(uniforms), windows = loadWindows(uniforms);
  foliage.then(({ city }) => dayWeather.setDays({ 'leaves out': city.leaf, 'trees in colour': city.colour, 'leaves down': city.fall }))
    .catch((e) => console.warn('foliage', e));
  windows.then(({ set }) => { setWindows = set; }).catch((e) => console.warn('windows', e));
  // the light on the ground at night, drawn into the pages of the nodes shown (lamplight.ts, fields.ts)
  const lamps = new LampLight(meta);
  // the street lamps placed along the streets (streetlamps.ts, web/tools/lamps.mjs)
  const streetLamps = fetchJson<{ lamps: [number, number, number][] }>(dataUrl(CLIENT_FILES.streetlamps)).then((j) => j.lamps).catch((e) => { console.warn('street lamps', e); return []; });
  const tileMat = makeVoxelMaterial(uniforms);
  // (the session's options, its edits: the page's, its client's, read by the streamer and the page's TileCache)
  const session = sessionOptions(qs), edits = new LiveEdits();
  streamer = new TileStreamer(meta, tileMat, scene, edits);
  // ?dig=1: a click carves a hole in the city, until the page is loaded again (dig.ts; a developer's switch)
  if (qs.get('dig') === '1') { const S = streamer; import('./dig').then(({ installDig }) => installDig(S, camera, renderer.domElement, simReady)); }
  prepass = new DepthPrepass(streamer.group, scene);
  prepass.add(tileMat, makeVoxelPrepassMaterial(uniforms));
  prepass.enabled = gfx.now.prepass;
  world = nav.world = streamer.world;
  // the moving casters: street life (the cars and the motorbike driven are its own), and nav.actors' boat,
  // floatplane and jet (the FPV drone has no model)
  daylight.casters(streamer.group, () => life || nav.craftView ? movingActors : null);
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
  dayWeather.start(climate, qs, session.start.time);
  city = await installCity({ streamer, uniforms, meta, scene, focus, camera, caption, budget, lamps, prepass, lod: { mode: gfx.now.lod, px: gfx.now.lodpx }, occlusion: gfx.now.occl, dist: gfx.now.dist || DIST_MAX,
    crop: cropOf(qs.get('crop') === 'fit' && fo ? String(Math.ceil(fo.reach + 128)) : qs.get('crop'), controls.target, meta.origin), pixelsHigh: () => post.height });
  viewDistance.reset(); // (the view distance handed to the city on the next frame)
  labels = new Labels(meta.labels, goTo.onLabel);
  labels.gate = city.gate;
  labels.visible = labelsOn;
  const mapView = new MapData(meta), marks = { pose: nav.mapPose, waypoint, others: otherPlayers };
  const full = fullmap = new FullMap(mapView, marks);
  minimap = new Minimap(mapView, marks, () => full.open());
  hook('__map', { minimap, full, waypoint });
  hud = new Hud(renderer.domElement, nav.mode);
  bar.search.setItems(goTo.searchItems(meta));
  fetchJson<{ places: Place[] }>(dataUrl(CLIENT_FILES.places)).then(({ places }) => {
    bar.search.setItems(goTo.searchItems(meta, places));
    mapView.setPlaces(places);
  });
  fountains = new Fountains(scene, meta.jets ?? []);
  fetchJson<FloodInfo>(dataUrl(CLIENT_FILES.flood)).then((info) => {
    riverPoints = info.river ?? [];
    mapView.setRiver(riverPoints);
  })
    .catch((e) => { riverPoints = []; console.warn('river points', e); });
  fetchJson<TrafficData>(dataUrl(HOST_FILES.traffic)).then(unpackTraffic).then(async (td) => {
    mapView.setRoads(td.roads);
    streetLamps.then((placed) => { lamps.addStreets(placed); lampHeads = new LampHeads(scene, placed, meta.origin); });
    // the world sim's client, the sim in a Web Worker on its own clock
    const { client, link } = openSession({ ...session, server: await serverChoice }, { meta, edits, traffic: td, world });
    client.setName(prefs.name);
    perf.ping = link instanceof SocketLink ? () => link.rtt : null;
    // a host of other code, data or tuning is refused (sim/hello.ts): said on the page, the city stays without life
    client.hello.catch((e: Error) => {
      console.error(e.message);
      const text = $('#loading-text');
      text.textContent = e.message;
      $('#loading').classList.remove('hidden');
    });
    if (link instanceof SocketLink) {
      const retry = `trying again every ${RETRY_MS / 1000} s`;
      link.onStatus = (s) => banner(s.up ? null : s.lost
        ? `Lost the server at ${link.url}: ${retry} (start it with tools/wt.sh serve)`
        : `No server at ${link.url}: start it with tools/wt.sh serve (${retry})`);
    }
    hook('__simLink', link);
    sim = client;
    pageTime = new PageTime(client);
    life = nav.life = new StreetLife(scene, client);
    nav.arms.view = weapons = new WeaponsView(scene, client);
    nav.sim = client;
    movingActors.add(life.group);
    scene.add(wreckSmoke.mesh);
    hook('__life', life);
    hook('__sim', client);
    void client.hello.then(() => simLoaded(client), () => {});
  });
  $('#loading').classList.add('hidden');
  hook('__streamer', streamer);
  hook('__ready', true);
  const [{ ParagliderMode }, modes, { CraftsView }] = await Promise.all([import('./nav/special-craft'), Promise.all(CRAFTS()),
    import('./view/crafts/crafts-view')]);
  const ctx: CraftContext = { nav, camera, target: controls.target, meta, host: modeTools, canvas: renderer.domElement,
    env: { night: () => daylight.night, river: () => riverPoints },
    sim: simReady,
    tiles: { meta, cache: viewerTileCache(meta.tiles.N, edits), now: () => performance.now() },
  };
  const wing = glider = new ParagliderMode(ctx);
  nav.bailOut = (source, at) => wing.deploy(source, at);
  crafts = [...modes.map((C) => new C(ctx)), wing];
  hook('__crafts', crafts); // (the shells, for the tools: judder.mjs enters one at a spot)
  craftsView = new CraftsView(nav.actors);
}

// The player's health and the vehicle's they are in, a hit felt (the crash tint, a short shake of the camera: taken
// off again at the next frame's start, as the walk's camera is not set anew while the player is down); down, the walk
// is held; back, the walk is put where the host has them
const shaken = new THREE.Vector3();
let backSeen = 0;
function feelHealth(now: number) {
  const S = sim, me = S?.player;
  if (!S || !me) return;
  const s = S.seat(), e = s && s.role !== 'walker' ? s.entity : null, key = e ? `${e.kind}:${e.id}` : '';
  const craft = e?.kind === 'craft' ? S.crafts().find((c) => c.id === e.id) : undefined, type = craft?.type ?? (e?.kind === 'craft' ? 'craft' : 'car');
  const own = S.health(`player:${me}`);
  // (the host's word, not the copy run ahead: the gauge reads as the host's tank)
  const body = s?.role === 'driver' ? S.driver()?.body : null, tank = s?.role === 'pilot' ? craft?.core.tank.share ?? null
    : body ? (body.fuel ?? LEVELS) / LEVELS : null;
  const k = healthHud.set(own, e ? { key, name: type[0].toUpperCase() + type.slice(1), h: S.health(key) } : null, tank, now);
  if (k > 0 && !nav.onMap) {
    shaken.copy(camera.position);
    shake(camera.position, 0.12 * k, now);
    shaken.subVectors(camera.position, shaken);
  }
  nav.held = own?.hp === 0;
  // (a page's first look: the events held from before it came are not its)
  if (!backSeen) { backSeen = S.tick; return; }
  for (const ev of S.eventsSince(backSeen)) {
    if (ev.kind !== 'back' || ev.player !== me) continue;
    const t = ev.to;
    void nav.setWalk({ at: new THREE.Vector3(t.x, t.y, t.z), exact: true, facing: new THREE.Vector3(Math.sin(t.h), 0, Math.cos(t.h)) });
  }
  backSeen = S.tick;
}

// Fire at the player shown by where it comes from, against the view's heading (the camera's, not the body's: a chase
// view and a gunner look elsewhere than the vehicle points)
const lookDir = new THREE.Vector3();
let fireSeen = 0;
function showIncoming(now: number) {
  const S = sim, me = S?.player;
  if (!S || !me) return;
  if (fireSeen) {
    const body = S.seat()?.entity ?? null, at = nav.mapPose();
    for (const ev of S.eventsSince(fireSeen)) { const i = incoming(ev, { player: me, body, at }); if (i) incomingHud.add(i, now); }
  }
  fireSeen = S.tick;
  camera.getWorldDirection(lookDir);
  incomingHud.show(camera.position, Math.atan2(lookDir.x, lookDir.z), now);
}

// the other players near this one as the maps mark them: on foot, at the wheel, flying (the array reused)
const others: MapMark[] = [];
function otherPlayers(): readonly MapMark[] {
  others.length = 0;
  const me = sim?.player;
  if (!sim || !life) return others;
  const S = sim, label = (p: string) => S.nameOf(p) || p;
  for (const a of life.avatarsDrawn()) if (a.player !== me) others.push({ player: a.player, label: label(a.player), ...xyz(a.pose) });
  // (one in a seat its look has no place for is marked at the vehicle)
  const sat = life.seatedDrawn();
  for (const s of sat) if (s.player !== me) others.push({ player: s.player, label: label(s.player), ...xyz(s.at) });
  for (const c of sim.crafts()) {
    if (c.pilot && c.pilot !== me && !sat.some((s) => s.player === c.pilot)) others.push({ player: c.pilot, label: label(c.pilot), ...xyz(c.core.pose) });
  }
  for (const [car, player] of sim.drivers()) {
    const d = player !== me && !sat.some((s) => s.player === player) && life.drawn('car', car);
    if (d) others.push({ player, label: label(player), ...xyz(d) });
  }
  for (const [kind, id, player] of sim.passengers()) {
    if (player === me || sat.some((s) => s.player === player)) continue;
    const d = kind === 'car' ? life.drawn('car', id) : sim.crafts().find((c) => c.id === id)?.core.pose;
    if (d) others.push({ player, label: label(player), ...xyz(d) });
  }
  return others;
}

const xyz = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y, z: p.z });

// the shell that flies the nearest craft no one pilots within BOARD_R m of the map's focus, put in it; false: none
const BOARD_R = 150;
function boardNearest() {
  const f = controls.target;
  let best: { c: CraftView; d: number } | null = null;
  for (const c of sim?.crafts() ?? []) {
    const p = c.core.pose, d = Math.hypot(p.x - f.x, p.z - f.z);
    if (c.pilot === null && d < BOARD_R && (!best || d < best.d)) best = { c, d };
  }
  const shell = best && crafts.find((s) => s.boards?.includes(best.c.type));
  return !!(best && shell?.board?.(best.c));
}
hook('__board', boardNearest);

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

// the frame's phases, in the order of app/frame.ts PHASES
const t0 = performance.now();
let viewDist = 0, redraws = 0; // (this frame's: the camera's distance to the target; the shadow's redraws before the draw)
renderer.setAnimationLoop(frameLoop({
  // the players' input (the car's, Nav's, the crafts that own the camera); first the map's fly-to and the weather's fade
  input: (now, dt) => {
    camera.position.sub(shaken);
    shaken.set(0, 0, 0);
    goTo.step(now);
    dayWeather.step(now);
    boarding.update();
    for (const c of crafts) if (c.view === 'ride') c.update(dt);
    nav.update(dt);
    for (const c of crafts) if (c.view === 'own') c.update(dt);
  },
  // the frame's commands to the world sim, which ticks on its own clock round what the page's player looks at (its
  // view: the focus; agents come and go far from the camera, which sees them), and the snapshot this frame draws; the
  // light follows the world's time
  sim: (_now, dt) => {
    if (!sim || !life) return;
    sim.send(pageView(focus(), camera.position));
    sim.update(dt);
    const t = pageTime?.follow();
    if (t) dayWeather.show(t);
    life.group.visible = !city || city.complete;
  },
  // this frame's poses drawn
  poses: (_now, dt) => {
    if (sim && life && life.group.visible) {
      life.ownEyes = nav.ride?.view === 'eyes' || !!nav.craft?.inSeat;
      life.update(dt, daylight.night, camera.position, camera); // (the viewer: last frame's camera)
    }
    craftsView?.update(sim, dt, daylight.night, nav.craftView);
    weapons?.update(dt, life?.group.visible ? life.avatarsDrawn() : [], camera.position);
  },
  // the cameras on them (the ride's, a craft's own; the map's controls), and the mode shown
  cameras: (now, dt) => {
    nav.place(dt);
    for (const c of crafts) c.place?.(dt);
    const bodyMode = nav.craft?.id ?? nav.mode;
    if (document.body.dataset.mode !== bodyMode) document.body.dataset.mode = bodyMode;
    if (document.body.dataset.nav !== nav.mode) {
      foldForPlay(document.body.dataset.nav === 'orbit', nav.mode === 'orbit');
      document.body.dataset.nav = nav.mode;
    }
    const walkLabel = nav.enteringWalk ? 'Entering walk…' : nav.onFoot ? 'Exit walk' : 'Walk';
    if (walkButton.textContent !== walkLabel) walkButton.textContent = walkLabel;
    armsHud.set(nav.arms.slot);
    feelHealth(now);
    showIncoming(now);
    boardButton.set((key) => boarding.label(key));
    seatButton.show(boarding.swapLabel());
    canopyButton.show(glider?.canopyAction ?? null);
    walkButton.disabled = !world || nav.enteringWalk || nav.craftView;
    if (nav.onMap) { controls.update(); nav.clamp(); keepInside(); }
  },
  // what reads the camera: the view distance, the fog, the far plane, the animated uniforms, the tiles streamed, the
  // shadow's fit and its redraw
  cameraReaders: (now, dt) => {
    const above = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3;
    post.setHeight(above, gfx.now.tilt && !nav.craftView, camera.position.distanceTo(controls.target));
    viewDist = camera.position.distanceTo(controls.target);
    viewDistance.update(above);
    daylight.setFogFrom(viewDist, above);
    viewDistance.fitFar(); // (within the fog's far end)
    const t = (performance.now() - t0) / 1000;
    if (uniforms) uniforms.uTime.value = t;
    daylight.clouds.tick(t);
    setWindows?.(daylight.hour, daylight.day);
    fountains?.update(t, daylight.night);
    if (lampHeads) { lampHeads.night = daylight.night; lampHeads.update(camera); }
    waypoint.update(camera, nav.mapPose(), world);
    const cp = camera.position;
    wreckSmoke.update(dt, cp);
    precip.update(t, cp, daylight.weather, daylight.night, world?.inRoom(cp.x, cp.z, cp.y) ?? false);
    if (city?.complete) document.body.classList.remove('loading');
    daylight.sky.mesh.position.copy(camera.position);
    streamer?.update(camera);
    daylight.fitShadow(focus(), camera, viewDist, map);
    redraws = daylight.redraws + daylight.patches;
    if (stillChanged()) stillDue = true;
    if (stillDue && now - redrawnAt > 300) { stillDue = false; redrawnAt = now; daylight.redrawShadow(); }
  },
  // the draw (timed by autores.ts while it measures), then the overlays placed by it: the map, the labels
  render: (now) => {
    renderer.info.reset();
    if (autoRes && !(gfx.isAuto('res') && gfx.isAuto('detail'))) autoRes.stop(); // the visitor set one of them
    if (autoRes?.done) autoRes = null;
    autoRes?.begin();
    post.composer.render();
    if (nav.onFoot) weapons?.drawHeld(renderer, camera, nav.arms.slot, daylight.night);
    if (daylight.redraws + daylight.patches !== redraws) busy = true;
    autoRes?.end(now, { ready: !!city?.complete && city.settled && !!streamer?.idle && !stillDue && !document.hidden, disturbed: busy });
    busy = false;
    perf.frame(now, document.hidden, renderer.info.render.triangles);
    barRect ??= bar.rect;
    minimap?.update(now, barRect.bottom);
    fullmap?.update(now);
    labels?.update(camera, world, barRect, [...(hud?.rects ?? []), ...perf.rects, ...(minimap?.rects ?? [])]);
    nameTags.update(camera, life?.group.visible ? otherPlayers() : [], world);
  },
}, t0, () => prefs.fps));
hook('__menu', { menu, prefs, fps: () => perf.fps, tags: nameTags });

hook('__three', { camera, controls, nav, bar, scene, renderer, flyTo: goTo.flyTo, setHour: dayWeather.setHour, setDay: dayWeather.setDay, setWeather: dayWeather.setWeather, map, daylight, post, budget,
  // the detail, as the visitor would set it (tools)
  level: () => gfx.now.detail, setLevel: (l: number) => { const c = { detail: Math.max(0, Math.min(1, l)) }; gfx.set(c); applyGfx(c); gfxPanel.show(); }, city: () => city, prepass: () => prepass, gfx,
  // any graphics setting, as the visitor would set it (tools)
  setGfx: (c: Partial<Gfx>) => { gfx.set(c); applyGfx(c); gfxPanel.show(); } });

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

// busy: this frame changed the settings or redrew the shadow map (autores.ts leaves it out)
let busy = false, stillDue = false, redrawnAt = 0;
