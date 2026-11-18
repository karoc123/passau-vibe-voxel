import * as THREE from 'three';
import type { Meta } from './types';
import { FOLIAGE_CLASSES } from './foliage';
import { dataTexture, hash } from './util';
import { CLOUD_GLSL, cloudUniforms } from './clouds';
import { SLANT, SLANT_STEPS } from './chamfer';
import { WALL_TOP } from './roofs';

// material ids, as in scripts/voxelize.py
// what mirrors marks itself in the scene's alpha at up to this (post.ts Reflections)
export const REFL_MAX = 0.4;
export const MAT = { SOLID: 0, WALL: 1, GLASS: 2, LEAF: 3, WATER: 4, LAMP: 5, METAL: 6, FLOODLIT: 7, GRASS: 8, MARK: 9, SOIL: 10, CAR: 11,
  ROOF: 12, CONCRETE: 13, CLOCK: 14, BRONZE: 15, SIGN: 16, JET: 17, SIGNBAND: 18, RIBBON: 19, CLASSIC: 20, WINDOW: 21, TENEMENT: 22 } as const;

type U<T> = { value: T };
export interface VoxelUniforms {
  [name: string]: THREE.IUniform;
  uPalette: U<THREE.Texture>;
  uLampMap: U<THREE.Texture>;
  uSize: U<THREE.Vector2>;
  uNight: U<number>;
  uTime: U<number>;
  uHorizon: U<THREE.Color>;
  uDrop: U<number>;
  uFlood: U<THREE.Texture>;
  uWet: U<number>;
  uSnow: U<number>;
  uDay: U<number>;
  uFolOn: U<number>;
  uFolMap: U<THREE.Texture>;
  uFolDate: U<THREE.Vector4[]>;
  uFolCol: U<THREE.Color[]>;
  uGrass: U<THREE.Color[]>;
  uLeaf: U<THREE.Color>;
  uWinMap: U<THREE.Texture>;
  uWinMed: U<number[]>;
  uWinShape: U<number[]>;
  uWinFloors: U<number[]>;
  uWinCol: U<THREE.Vector3[]>;
  uAlbedo: U<number>;
  uStage: U<number>;
  uBldOn: U<THREE.Texture>;
  uZOn: U<number>;
  uZBlk: U<THREE.Texture>;
  uZFBlk: U<THREE.Texture>;
  uLitA: U<THREE.Vector4[]>;
  uLitB: U<THREE.Vector4[]>;
  uLitMap: U<THREE.Texture>;
  uNoWin: U<THREE.Vector4>;
  uNoWinR: U<number>;
  uSpillMap: U<THREE.Texture>;
  uSpill: U<THREE.Vector2>;
  uShop: U<number>;
}

const tiny = (format: THREE.PixelFormat, data: Uint8Array | Uint16Array, type?: THREE.TextureDataType) => dataTexture(data, 1, 1, format, type);

export function makeUniforms(meta: Meta): VoxelUniforms {
  return {
    uPalette: { value: makePaletteTexture(meta.palette) },
    uLampMap: { value: makeLampTexture(meta) },
    uSize: { value: new THREE.Vector2(meta.W, meta.D) },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uHorizon: { value: new THREE.Color(0.7, 0.75, 0.8) },
    uDrop: { value: 0 },
    uFlood: { value: tiny(THREE.RGFormat, new Uint8Array(2)) },
    uWet: { value: 0 },
    uSnow: { value: 0 },
    uDay: { value: 200 },
    uFolOn: { value: 0 },
    uFolMap: { value: tiny(THREE.RGFormat, new Uint8Array(2)) },
    uFolDate: { value: Array.from({ length: FOLIAGE_CLASSES }, () => new THREE.Vector4(-1, 0, 0, 0)) },
    uFolCol: { value: Array.from({ length: FOLIAGE_CLASSES }, () => new THREE.Color(0.3, 0.2, 0.05)) },
    uGrass: { value: Array.from({ length: 12 }, () => new THREE.Color(1, 1, 1)) },
    uLeaf: { value: new THREE.Color(1, 1, 1) },
    uWinMap: { value: tiny(THREE.RedFormat, new Uint8Array(1)) },
    uWinMed: { value: new Array(8).fill(0.12) },
    uWinShape: { value: Array.from({ length: 72 }, (_, i) => (i % 9) / 4) },
    uWinFloors: { value: new Array(8).fill(0) },
    uWinCol: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0.7, 0.25, 0.05)) },
    uAlbedo: { value: 0.7 },
    uStage: { value: 0 },
    uBldOn: { value: tiny(THREE.RedFormat, new Uint8Array(1)) },
    uZOn: { value: 0 },
    uZBlk: { value: tiny(THREE.RedIntegerFormat, new Uint16Array(1), THREE.UnsignedShortType) },
    uZFBlk: { value: tiny(THREE.RedFormat, new Uint8Array(1)) },
    uSpillMap: { value: tiny(THREE.RGFormat, new Uint8Array(2)) },
    uSpill: { value: new THREE.Vector2(1, 1) },
    uShop: { value: 1 },
    ...floodlights(meta),
    ...cloudUniforms,
  };
}

function makePaletteTexture(palette: Meta['palette']) {
  const size = 64, data = new Uint8Array(size * size * 4);
  palette.forEach((p, i) => data.set(p, i * 4));
  const tex = dataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return tex;
}

// pools of street light on the ground (2 m texels), and an even wash over floodlit pitches. A pool is bright under its
// lamp and falls off fast, with a faint skirt; the lamps are of three kinds, as in a German town: warm-white lanterns
// (most, the old town's), the last orange sodium lamps, and cold white LEDs (lampColour, by where the lamp stands)
const LAMP_S = 0.5;
export const LAMP_COLOURS: [number, number, number][] = [[255, 196, 132], [255, 156, 70], [212, 226, 255]];
export const lampColour = (x: number, y: number) => {
  const h = hash(Math.floor(x) * 0.1271 + Math.floor(y) * 0.3117);
  return LAMP_COLOURS[h < 0.6 ? 0 : h < 0.82 ? 1 : 2];
};
const lampPool = ([r, g, b]: [number, number, number]): [number, string][] =>
  [[0, 0.8], [0.12, 0.66], [0.3, 0.34], [0.52, 0.11], [0.8, 0.025], [1, 0]].map(([t, a]) => [t, `rgba(${r},${g},${b},${a})`]);
function pool(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [number, string][]) {
  const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [t, c] of stops) gr.addColorStop(t, c);
  ctx.fillStyle = gr;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function makeLampTexture(meta: Meta) {
  const s = LAMP_S, cv = document.createElement('canvas');
  cv.width = meta.W * s; cv.height = meta.D * s;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y] of meta.lamps) pool(ctx, (x + 0.5) * s, (y + 0.5) * s, 18 * s, lampPool(lampColour(x, y)));
  for (const [x, y, r] of meta.floods ?? []) pool(ctx, x * s, y * s, r * 1.35 * s,
    [[0, 'rgba(225,235,255,0.6)'], [0.7, 'rgba(225,235,255,0.52)'], [1, 'rgba(225,235,255,0)']]);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

// OSM maps few of Passau's street lamps (123, most on the bridges), so the lanes and alleys stood dark. Every street and
// footway in the built-up town is lit: a pool every ~26 m along it, unless a lamp (mapped or placed) is already within
// 16 m -- a road mapped both ways, or a pavement beside it, gets one row. Only the light is drawn; there is no lamp post.
// Out of town they stay dark: a footpath through the woods or the grass (the Oberhaus slope, the parks), with next to no
// building beside it and not along a river (the promenades, the Dreiflüsseeck's, stay lit), and a road through the
// woods or the fields.
export type Ground = { buildings: Uint8Array; trees: Uint8Array; terrain: ArrayBuffer } | null;
type Way = { p: [number, number, number][] };
function townMask(meta: Meta, g: Ground) {
  if (!g) return () => ({ built: 99, wild: 0, water: 0 });
  // per 2 m cell: building (windows.bin), and wild ground: under trees (foliage.bin), or grass or bare soil in the
  // terrain's ground colours (city.ts) -- not paving, not water
  const tw = Math.ceil(meta.W / 4), th = Math.ceil(meta.D / 4), cw = meta.W >> 1, ch = meta.D >> 1;
  const rgb = new Uint8Array(g.terrain, tw * th * 2, cw * ch * 3), bld = new Uint8Array(cw * ch), wild = new Uint8Array(cw * ch), water = new Uint8Array(cw * ch);
  for (let y = 0; y < meta.D; y++) for (let x = 0; x < meta.W; x++) if (g.buildings[y * meta.W + x]) bld[(y >> 1) * cw + (x >> 1)] = 1;
  for (let i = 0; i < cw * ch; i++) {
    const r = rgb[3 * i], gr = rgb[3 * i + 1], b = rgb[3 * i + 2];
    const grass = gr > r + 20 && gr > b + 40, soil = Math.abs(r - 168) + Math.abs(gr - 152) + Math.abs(b - 124) < 12;
    water[i] = gr > r + 6 && gr < b + 30 ? 1 : 0; // the rivers' greens (grass is far greener than blue)
    wild[i] = !water[i] && (g.trees[i] || grass || soil) ? 1 : 0;
  }
  const sum = (a: Uint8Array, cx: number, cy: number, R: number) => {
    let s = 0, n = 0;
    for (let y = Math.max(0, cy - R); y < Math.min(ch, cy + R); y++) for (let x = Math.max(0, cx - R); x < Math.min(cw, cx + R); x++) { s += a[y * cw + x]; n++; }
    return [s, n];
  };
  return (x: number, y: number) => {
    const cx = Math.floor(x / 2), cy = Math.floor(y / 2), [b] = sum(bld, cx, cy, 5), [w, n] = sum(wild, cx, cy, 6), [r] = sum(water, cx, cy, 7);
    // m² of building within ~10 m, the share of wild ground within ~12 m, m² of river within ~14 m
    return { built: b * 4, wild: n ? w / n : 0, water: r * 4 };
  };
}
// returns the lamps it placed: x, y, ground (lamps.ts gives them a glowing head)
export function lightStreets(u: VoxelUniforms, meta: Meta, roads: Way[], peds: Way[], ground: Ground) {
  const placed: [number, number, number][] = [];
  const tex = u.uLampMap.value as THREE.CanvasTexture, ctx = (tex.image as HTMLCanvasElement).getContext('2d')!;
  const G = 16, cells = new Map<number, [number, number][]>(), key = (x: number, y: number) => Math.floor(y / G) * 4096 + Math.floor(x / G);
  const near = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const [px, py] of cells.get(key(x + dx * G, y + dy * G)) ?? []) if (Math.hypot(px - x, py - y) < G) return true;
    return false;
  };
  const add = (x: number, y: number) => {
    const c = key(x, y);
    (cells.get(c) ?? cells.set(c, []).get(c)!).push([x, y]);
  };
  for (const [x, y] of meta.lamps) add(x + 0.5, y + 0.5);
  ctx.globalCompositeOperation = 'lighter';
  const town = townMask(meta, ground);
  const lit = (x: number, y: number, ped: boolean) => {
    const { built, wild, water } = town(x, y);
    return built >= 20 || water >= 40 || wild < (ped ? 0.5 : 0.75);
  };
  for (const { p, ped } of [...roads.map((w) => ({ p: w.p, ped: false })), ...peds.map((w) => ({ p: w.p, ped: true }))]) {
    let next = 6;
    for (let i = 0, d = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1], l = Math.hypot(bx - ax, by - ay);
      while (next <= d + l) {
        const t = (next - d) / l, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = p[i][2] + (p[i + 1][2] - p[i][2]) * t;
        next += 26;
        if (x < 0 || y < 0 || x >= meta.W || y >= meta.D || near(x, y) || !lit(x, y, ped)) continue;
        add(x, y); placed.push([x, y, z]);
        pool(ctx, x * LAMP_S, y * LAMP_S, 16 * LAMP_S, lampPool(lampColour(x, y)));
      }
      d += l;
    }
  }
  tex.needsUpdate = true;
  return placed;
}

// Passau floodlights its cathedral, both fortresses, the town hall's tower and the churches above the rivers. Each is
// a capsule in plan (from the label, a and b in metres off it, radius r) whose walls catch a warm wash at night,
// strongest on the faces turned out from it, where the lights stand. w: how white the light falls on it (the lamps'
// warm tint multiplied into red brick burned the Rathaus tower orange; it is lit nearer white, its brick toned down).
// still: not mirrored in the river (St. Michael stands back from the Inn, behind the Innkai's lamps: its capsule, mirrored,
// lay on the water as a soft round patch).
const FLOODLIT: Record<string, { a?: [number, number]; b?: [number, number]; r: number; k?: number; w?: number; still?: boolean }> = {
  'Dom St. Stephan': { a: [4, 22], b: [91, 22], r: 30, k: 1.2 },
  'Veste Oberhaus': { a: [-45, -2], b: [60, 53], r: 48, k: 0.9 },
  'Veste Niederhaus': { r: 30 },
  'Altes Rathaus': { r: 24, k: 0.6, w: 0.75 },
  'Wallfahrtskirche Mariahilf': { r: 30 },
  'St. Michael': { r: 28, k: 0.8, still: true },
  'St. Paul': { r: 28, k: 0.8 },
  Schaiblingsturm: { r: 10 },
};
const LIT_N = 8, LIT_CELL = 8;
function floodlights(meta: Meta) {
  const A = Array.from({ length: LIT_N }, () => new THREE.Vector4()), B = Array.from({ length: LIT_N }, () => new THREE.Vector4());
  let i = 0;
  for (const l of meta.labels) {
    const f = FLOODLIT[l.name];
    if (!f || i >= LIT_N) continue;
    const a = f.a ?? [0, 0], b = f.b ?? a;
    A[i].set(l.x + 0.5 + a[0], l.y + 0.5 + a[1], l.x + 0.5 + b[0], l.y + 0.5 + b[1]);
    B[i++].set(f.r, f.k ?? 1, f.w ?? 0, f.still ? 1 : 0);
  }
  // which capsule (1 + its index, 0: none) reaches each 8 m cell, the nearest relative to its radius: the shader
  // weighs that one alone instead of looping over all eight for every pixel of the city at night (and 4 x 8 for every
  // pixel of the rivers, mirrored)
  const w = Math.ceil(meta.W / LIT_CELL), h = Math.ceil(meta.D / LIT_CELL), map = new Uint8Array(w * h), best = new Float32Array(w * h).fill(Infinity);
  for (let k = 0; k < i; k++) {
    const [ax, ay, bx, by] = A[k].toArray(), r = B[k].x, reach = r + LIT_CELL * 0.75;
    const bax = bx - ax, bay = by - ay, bb = Math.max(bax * bax + bay * bay, 1e-3);
    for (let y = Math.max(0, Math.floor((Math.min(ay, by) - reach) / LIT_CELL)); y <= Math.min(h - 1, Math.floor((Math.max(ay, by) + reach) / LIT_CELL)); y++)
      for (let x = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / LIT_CELL)); x <= Math.min(w - 1, Math.floor((Math.max(ax, bx) + reach) / LIT_CELL)); x++) {
        const px = (x + 0.5) * LIT_CELL - ax, py = (y + 0.5) * LIT_CELL - ay, t = Math.min(1, Math.max(0, (px * bax + py * bay) / bb));
        const d = Math.hypot(px - bax * t, py - bay * t);
        if (d < reach && d / r < best[x + w * y]) { best[x + w * y] = d / r; map[x + w * y] = k + 1; }
      }
  }
  // the cathedral has its windows in voxels (scripts/passau.py): the shader draws none on its walls
  const dom = meta.labels.find((l) => l.name === 'Dom St. Stephan'), da = FLOODLIT['Dom St. Stephan'];
  const noWin = dom ? new THREE.Vector4(dom.x + 0.5 + da.a![0], dom.y + 0.5 + da.a![1], dom.x + 0.5 + da.b![0], dom.y + 0.5 + da.b![1]) : new THREE.Vector4(-1e4, -1e4, -1e4, -1e4);
  return { uLitA: { value: A }, uLitB: { value: B }, uLitMap: { value: dataTexture(map, w, h, THREE.RedFormat) },
    uNoWin: { value: noWin }, uNoWinR: { value: da.r } };
}

// A leaf voxel through the year (foliage.ts): x = in leaf (0 bare .. 1), y = turned (0 green .. 1 autumn colour), z = class.
const FOLIAGE = `
  uniform sampler2D uFolMap; uniform vec4 uFolDate[${FOLIAGE_CLASSES}]; uniform vec3 uFolCol[${FOLIAGE_CLASSES}]; uniform float uDay; uniform float uFolOn; uniform vec3 uGrass[12]; uniform vec3 uLeaf;
  vec2 foliageCell(vec3 cell) { return texelFetch(uFolMap, ivec2(cell.xz * 0.5), 0).rg; }
  vec3 foliageOf(vec2 f) {
    int cls = int(f.r * 255.0 + 0.5);
    if (cls == 0) cls = 13;
    vec4 d = uFolDate[cls];
    if (d.x < 0.0) return vec3(1.0, 0.0, float(cls));
    float k = f.g * 255.0;
    float off = (fract(k * 0.618034) + fract(k * 0.414214 + 0.3) - 1.0) * 2.45 * d.w;
    float t = uDay - off;
    float leaf = t < 200.0 ? smoothstep(d.x, d.x + 14.0, t) : 1.0 - smoothstep(d.z - 8.0, d.z + 8.0, t);
    return vec3(leaf, smoothstep(d.y - 10.0, d.y + 10.0, t), float(cls));
  }
  vec3 foliageAt(vec3 cell) { return foliageOf(foliageCell(cell)); }
  vec3 grassTint() {
    float m = mod(uDay / 30.42 - 0.5, 12.0);
    int a = int(m);
    return mix(uGrass[a], uGrass[(a + 1) % 12], fract(m));
  }
  // (f: the cell's foliageCell, fetched once by the caller)
  float litter(vec2 f) {
    int cls = int(f.r * 255.0 + 0.5);
    if (cls == 0 || uFolDate[cls].x < 0.0) return 0.0;
    vec3 fo = foliageOf(f);
    return (1.0 - fo.x) * fo.y * (1.0 - smoothstep(uFolDate[cls].z + 15.0, uFolDate[cls].z + 50.0, uDay));
  }
  // leaves fall in clumps (2 m blocks mixed with single voxels), not as per-voxel noise; a bare crown keeps a
  // clumped twig mass (~45 %) so it still reads as a tree's silhouette instead of scattered crumbs
  bool leafOff(vec3 cell, vec3 fo) { return 0.6 * hash13(floor(cell * 0.5) * 1.3 + 5.1) + 0.4 * hash13(cell * 1.7 + 3.1) > fo.x; }
  bool leafGone(vec3 cell, vec3 fo) { return leafOff(cell, fo) && 0.65 * hash13(floor(cell * 0.5) * 2.1 + 9.3) + 0.35 * hash13(cell * 2.3 + 7.7) > 0.45; }`;

const NORMAL_FROM_IDX = `
  vec3 normalFromIdx(float i) {
    if (i < 0.5) return vec3(-1., 0., 0.);
    if (i < 1.5) return vec3(1., 0., 0.);
    if (i < 2.5) return vec3(0., 0., -1.);
    if (i < 3.5) return vec3(0., 0., 1.);
    if (i < 4.5) return vec3(0., -1., 0.);
    return vec3(0., 1., 0.);
  }`;

// While the city loads (city.ts): a building shows once uBldOn says so; until stage 2 the rest is folded under the
// terrain, after it a hidden building lies flat as a ground-coloured footprint.
const BUILD_PARS = `uniform float uStage; uniform sampler2D uBldOn; attribute float vbld;`;
// (a sloped roof's vertex: the height's part below a metre in vattr.y's top 6 bits, the AO in its low 2; roofs.ts)
const SUB_Y = 'floor(vattr.y / 4.0 + 0.01) / 64.0';
const BUILD_VERTEX = `
  transformed.y += ${SUB_Y};
  float hideB = 0.0;
  {
    int bid = int(vbld + 0.5);
    bool on = bid > 0 ? texelFetch(uBldOn, ivec2(bid % 128, bid / 128), 0).r > 0.5 : uStage > 1.5;
    if (!on) {
      if (uStage < 1.5) transformed.y = vattr.z - 3.0;
      else { hideB = 1.0; transformed.y = vattr.z; }
    }
  }`;

// What is the same at all of a face's corners reaches the fragment shader packed into one interpolated vec4 --
// (palette + 4096 x hidden, its facing + 8 x its wall's direction + 256 x (1 roof, 2 chamfer), building, ground) --
// and is unpacked there (faceDecode), each part rounded: interpolating equal values lands a hair off them. (Not what
// varies over a face: its AO, a gable's wall top, a roof's plane in vattr.x / vattr.w, whose normal is interpolated.)
// No \`flat\` varyings: through ANGLE's D3D11 a program with any costs extra work per triangle. On an Iris Xe (Windows
// Chrome, interleaved A/B in one page) the scene pass at 1/16 of the pixels went from 16-22 to ~5 ms, at full size
// from 25-27 to 12-16 ms; the sun's shadow map, drawn with makeBuildDepthMaterial, ~20 % faster. Integer attributes
// (gpuType IntType) or dropping the per-vertex uBldOn fetch saved nothing measurable there. (tools/vtxcost.mjs:
// the tiles' material against a plain one.)
const FACE_VERTEX = `{
    float kind = vattr.w > ${SLANT - 0.5} ? 2.0 : vattr.w > 0.5 && vattr.w < ${WALL_TOP - 0.5} ? 1.0 : 0.0;
    vFace = vec4(floor(vpal + 0.5), (kind == 1.0 ? mod(vattr.x, 8.0) : vattr.x) + 256.0 * kind, vbld, vattr.z);
  }`;
const FACE_PARS = `
  varying vec3 vVox; varying vec4 vFace;
  vec3 vN; int vPal; float vHide; float vWallAng; float vBid; float vRoof; float vSlant; float vGz;
  ${NORMAL_FROM_IDX}
  void faceDecode() {
    float a = floor(vFace.x + 0.5);
    int b = int(vFace.y + 0.5), kind = b >> 8;
    vHide = step(4096.0, a); vPal = int(a) & 4095;
    vN = normalFromIdx(float(b & 7)); vWallAng = float((b & 255) >> 3);
    vRoof = kind == 1 ? 1.0 : 0.0; vSlant = kind == 2 ? 1.0 : 0.0;
    vBid = floor(vFace.z + 0.5); vGz = vFace.w;
  }`;

// Where the budget leaves the city to the 8 m clay (city.ts, uZOn): a city block is real once uZFBlk says so
const ZONES_PARS = `
  uniform int uZOn; uniform highp usampler2D uZBlk; uniform sampler2D uZFBlk;
  bool zreal(vec3 c) {
    if (uZOn == 0) return true;
    uint id = texelFetch(uZBlk, clamp(ivec2(c.x, c.z), ivec2(0), textureSize(uZBlk, 0) - 1), 0).r;
    int w = textureSize(uZFBlk, 0).x;
    return texelFetch(uZFBlk, ivec2(int(id) % w, int(id) / w), 0).r > 0.5;
  }`;

const FRAG_PARS = `
  uniform sampler2D uPalette; uniform sampler2D uLampMap; uniform sampler2D uSpillMap; uniform vec2 uSpill; uniform float uShop;
  uniform vec2 uSize; uniform float uNight; uniform float uTime; uniform vec3 uHorizon;
  uniform float uDrop; uniform sampler2D uFlood; uniform float uWet; uniform float uSnow; uniform float uAlbedo;
  ${FACE_PARS}
  // (AO and the wall's top do vary over a face)
  varying vec2 vShade;
  #define vAO vShade.x
  #define vWTop vShade.y
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 gEmissive; float gRough; float gMetal; float gRefl;
  // Window glass: a dark, faintly blue-grey dielectric (not metal: a metal's reflection is tinted by its colour, and
  // the facade's warm plaster in the panes read as brass), only a hint of the wall's colour in it (the room behind,
  // the frame's shade). Smooth, so the sky (scene.environment) shows in it, by Fresnel: little head-on, more at a glance.
  const float GLASS_ROUGH = 0.1;
  vec3 glassCol(vec3 base, float h) { return mix(vec3(0.026, 0.032, 0.04), base * 0.12, 0.25) * (0.85 + 0.3 * h); }
  // ... and the sky in it, by day: the environment's reflection off a dielectric is a few per cent and the panes read as
  // holes; a sheen of the sky's colour (the ground's, darker, looking down into it) by Fresnel, stronger at a glance
  vec3 glassSky(vec3 n) {
    vec3 V = normalize(cameraPosition - vVox), R = reflect(-V, n);
    float f = 0.07 + 0.45 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
    vec3 sky = R.y > 0.0 ? mix(uHorizon, uHorizon * vec3(0.6, 0.75, 1.0), clamp(R.y * 1.5, 0.0, 1.0)) : uHorizon * vec3(0.3, 0.29, 0.27);
    return sky * f * (1.0 - uNight);
  }
  // how much of a pixel (x +- w/2) falls in [a, b), alone (span) or repeated every p (band): box-filtered, so facade
  // detail smaller than a pixel fades to its average instead of shimmering
  float span(float x, float w, float a, float b) { return (clamp(x + 0.5 * w, a, b) - clamp(x - 0.5 * w, a, b)) / w; }
  float bandInt(float x, float p, float a, float b) { float k = floor(x / p); return k * (b - a) + clamp(x - k * p - a, 0.0, b - a); }
  float band(float x, float w, float p, float a, float b) { return (bandInt(x + 0.5 * w, p, a, b) - bandInt(x - 0.5 * w, p, a, b)) / w; }
  // An old-town facade at x along the wall (from the building's first window axis) and lv above the street, box-filtered
  // over w (metres along, up): axes every P m, storeys of SH m over a ground floor of G m. Out: x = the opening, y = its
  // light surround, z = the window's frame and glazing bars inside it, w = the sill. Close up a window is a frame with a
  // cross of bars; the bars and the sill are faded in (det) only where they are a few pixels wide, so from afar the
  // facade is what it was: plain openings in a surround
  vec4 facadeTap(float x, float lv, vec2 w, float P, float SH, float G, float det) {
    float up = lv - G;
    float cu = band(x, w.x, P, 0.0, 1.0), fu = band(x, w.x, P, -0.15, 1.15);
    bool gf = up < 0.0;
    float cv = gf ? span(lv, w.y, 0.35, 2.9) : band(up, w.y, SH, 0.9, 2.7);
    float fv = gf ? cv : band(up, w.y, SH, 0.75, 2.8);
    float win = cu * cv, bar = 0.0, sill = 0.0;
    if (det > 0.0) {
      // the glass inside a 7 cm frame, less a mullion and (upstairs) a transom at two thirds of the height
      float iu = band(x, w.x, P, 0.07, 0.93);
      float iv = gf ? span(lv, w.y, 0.42, 2.83) : band(up, w.y, SH, 0.97, 2.63);
      float mu = band(x, w.x, P, 0.475, 0.525);
      float tv = gf ? span(lv, w.y, 2.25, 2.3) : band(up, w.y, SH, 2.1, 2.15);
      float glass = max(iu * iv - mu * iv - iu * tv + mu * tv, 0.0);
      bar = det * max(win - glass, 0.0);
      sill = gf ? 0.0 : det * fu * band(up, w.y, SH, 0.78, 0.9);
    }
    return vec4(win, clamp(fu * fv - win, 0.0, 1.0), bar, sill);
  }
  // ... sampled along the longer side of the pixel's footprint: at a glancing angle a pixel is long along the wall and
  // short up it, and one box over both (fwidth) smeared each row of windows into a grey band from storey to storey
  vec4 facade(float x, float lv, vec2 dx, vec2 dy, float P, float SH, float G) {
    bool xm = dot(dx, dx) > dot(dy, dy);
    vec2 maj = xm ? dx : dy, mnr = xm ? dy : dx;
    float n = clamp(ceil(length(maj) / max(length(mnr), 1e-4)), 1.0, 4.0);
    vec2 w = max(abs(mnr) + abs(maj) / n, vec2(1e-3));
    float det = 1.0 - smoothstep(0.035, 0.09, max(w.x, w.y));
    vec4 s = vec4(0.0);
    for (int i = 0; i < 4; i++) {
      if (float(i) >= n) break;
      vec2 o = maj * ((float(i) + 0.5) / n - 0.5);
      s += facadeTap(x + o.x, lv + o.y, w, P, SH, G, det);
    }
    return s / n;
  }
  ${FOLIAGE}
  uniform vec4 uLitA[${LIT_N}]; uniform vec4 uLitB[${LIT_N}]; uniform sampler2D uLitMap; uniform vec4 uNoWin; uniform float uNoWinR;
  // how much a floodlit landmark (uLitA/B) lights a point; out: the direction from its axis, and how white its light
  float floodAt(vec2 p, bool mirror, out vec2 out_, out float w_) {
    out_ = vec2(0.0); w_ = 0.0;
    ivec2 c = ivec2(floor(p / ${LIT_CELL}.0)), sz = textureSize(uLitMap, 0);
    if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, sz))) return 0.0;
    int i = int(texelFetch(uLitMap, c, 0).r * 255.0 + 0.5) - 1;
    if (i < 0) return 0.0;
    vec4 ab = uLitA[i], lb = uLitB[i];
    vec2 pa = p - ab.xy, ba = ab.zw - ab.xy;
    vec2 d = pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);
    float k = (1.0 - smoothstep(lb.x * 0.6, lb.x, length(d))) * lb.y * (mirror ? 1.0 - lb.w : 1.0);
    if (k > 0.0) { out_ = d / max(length(d), 1.0); w_ = lb.z; }
    return k;
  }
  uniform sampler2D uWinMap; uniform float uWinMed[8]; uniform float uWinShape[72]; uniform float uWinFloors[8]; uniform vec3 uWinCol[8];
  // a building's share of lit windows now: its type's measured median times the building's own habit, a point on the
  // type's measured spread (scripts/window_stats.py)
  vec3 building(vec3 cell) {
    int v = int(texelFetch(uWinMap, ivec2(cell.xz), 0).r * 255.0 + 0.5);
    int kind = v & 7;
    float habit = (float(v >> 3) + 0.5) / 32.0;
    if (kind == 0) { kind = 1; habit = hash12(floor(cell.xz / 24.0)); }
    float q = habit * 7.999; int i = int(q);
    float s = mix(uWinShape[kind * 9 + i], uWinShape[kind * 9 + i + 1], fract(q));
    return vec3(clamp(uWinMed[kind] * s, 0.0, 1.0), float(kind), habit);
  }
  vec3 roomLight(float r, int kind) {
    vec3 c = uWinCol[kind];
    if (r < c.x) return mix(vec3(1.0, 0.66, 0.34), vec3(1.0, 0.82, 0.58), r / max(c.x, 1e-3));
    if (r < c.x + c.y) return vec3(0.95, 0.96, 0.92);
    return vec3(0.8, 0.9, 1.0);
  }
  // a window or a run of windows (room), on floor fl: lit or not, and its light
  vec3 windowLight(vec3 cell, vec2 room, float fl) {
    if (uNight <= 0.0) return vec3(0.0); // by day every caller scales it to nothing: skip the fetch and the hashes
    vec3 b = building(cell);
    int kind = int(b.y);
    bool floors = hash12(vec2(b.z * 91.7, 3.1)) < uWinFloors[kind];
    bool lit = floors ? hash12(vec2(fl, b.z * 57.3)) < b.x && hash12(room) < 0.92 : hash12(room) < b.x;
    return lit ? roomLight(hash12(room + 7.1), kind) * (0.55 + 0.35 * hash12(room + 3.3)) : vec3(0.0);
  }`;

// What the depth pre-pass (makeVoxelPrepassMaterial) has to compute just as SURFACE does: a fragment's cell, its hash,
// and whether a fountain's jet is off there now (with wa, lvl and vert as in SURFACE)
const CELL = 'vSlant > 0.5 ? floor(vec3(vVox.x - cos(wa), vVox.y + 1e-3, vVox.z - sin(wa))) : floor(vVox - vN * 0.5 + 1e-3)';
const CELL_HASH = 'hash13(vRoof > 0.5 && !vert ? vec3(cell.x, 0.0, cell.z) : cell)';
const JET_GONE = 'sin(uTime * 2.4 + h * 6.28) < -0.2 + lvl * 0.6';

const SURFACE = `
  vec4 pe = texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0);
  vec3 base = pow(pe.rgb, vec3(2.2));
  int m = int(pe.a * 255.0 + 0.5);
  float wa = (vWallAng - 1.0) * 0.261799;
  // (a chamfer's face stands up to ~1 m out of the cells it belongs to: they are a metre in from it)
  vec3 cell = ${CELL};
  // the ground is the same at every corner of a quad, but interpolated it can land a hair either side of the integer:
  // lvl 2.9999 or 3.0001 flipped whole window rows pixel by pixel into a hatched pattern
  float gz = floor(vGz + 0.5);
  float lvl = cell.y - gz;
  bool vert = abs(vN.y) < 0.5;
  float u = abs(vN.x) > 0.5 ? cell.z : cell.x;
  float wpos = abs(vN.x) > 0.5 ? cell.x : cell.z;
  // a wall at an angle to the grid is a staircase of x- and z-facing faces (mesher.worker.ts); each face counting
  // windows along its own axis aliased them into 1 m light/dark columns from street to eaves. Its windows are laid out
  // along the plane the staircase stands for instead, in metres from the fragment (wN: that plane's normal)
  vec3 wN = vN;
  if (vWallAng > 0.5) {
    wN = vec3(cos(wa), 0.0, sin(wa));
    u = floor(dot(vVox.xz, vec2(-wN.z, wN.x)) + 1e-3);
    wpos = floor(dot(vVox.xz, wN.xz) / 3.0);
  }
  // in metres, not cells: along the wall (its plane on a staircase) and above the street
  float uc = vWallAng > 0.5 ? dot(vVox.xz, vec2(-wN.z, wN.x)) : (abs(vN.x) > 0.5 ? vVox.z : vVox.x);
  float lv = vVox.y - gz;
  float fwU = max(fwidth(uc), 1e-3), fwV = max(fwidth(lv), 1e-3);
  vec2 dUVx = vec2(dFdx(uc), dFdx(lv)), dUVy = vec2(dFdy(uc), dFdy(lv));
  // (a roof's top by its column alone: on a slope cell.y steps along the contours, and stepped its shade in stripes)
  float h = ${CELL_HASH};
  gEmissive = vec3(0.); gRough = 0.88; gMetal = 0.0; gRefl = 0.0;
  vec3 col = base * (0.97 + 0.06 * h);
  bool shopLvl = lvl > 0.5 && lvl < 3.5;
  float r = 0.5, fres2 = 1.0; // the water's ripple and its glancing reflectance, for its reflections at night
  if (m == ${MAT.WALL} || m == ${MAT.TENEMENT}) {
    // An old-town facade: window axes 3 m apart (4 m on some), ~1 x 1.8 m windows in a light surround on storeys of
    // 3.3-3.7 m, plain plaster between; a ground floor of doors and shop windows on the same axes, over a darker plinth
    // and under a string course. Each building keeps its own rhythm (vBid). The historic core (TENEMENT) is the same
    // street of houses: it had a grid of 1 m voxel windows of its own, unfiltered, stepping along every staircase wall.
    if (vert) {
      float P = hash12(vec2(vBid * 0.618, 1.7)) < 0.75 ? 3.0 : 4.0;
      float x = uc - floor(hash12(vec2(vBid * 0.37, 5.3)) * P);
      float SH = 3.3 + 0.4 * hash12(vec2(vBid * 0.71, 2.9)), G = 4.2, up = lv - G, st = floor(up / SH);
      vec4 fc = facade(x, lv, dUVx, dUVy, P, SH, G);
      // no window whose top would run past the wall's end here (an eave, a gable's slope: vWTop, metres over the ground)
      if (vWTop < 900.0 && (up < 0.0 ? 2.9 : G + st * SH + 2.8) > vWTop - 0.1) fc = vec4(0.0);
      float win = fc.x;
      col *= 1.0 - 0.16 * span(lv, fwV, -1.0, 0.6) - 0.12 * span(lv, fwV, G - 0.3, G - 0.05);
      col = mix(col, min(col * 1.15 + 0.02, vec3(1.0)), fc.y + fc.w * 0.6);
      // glass, and white-painted frames and bars (fc.z) in the opening
      float gw = win - fc.z;
      col = col * (1.0 - win) + glassCol(base, h) * gw + vec3(0.62, 0.6, 0.56) * fc.z;
      gRough = mix(gRough, GLASS_ROUGH, gw) - 0.3 * fc.z;
      gEmissive = glassSky(wN) * gw;
      if (gw > 0.0 && uNight > 0.0) {
        float k = floor(x / P);
        if (up < 0.0) { if (hash12(vec2(k, wpos * 3.7)) < 0.75 * uShop) gEmissive += vec3(1.0, 0.8, 0.55) * 1.5 * uNight * gw; }
        else gEmissive += windowLight(cell, vec2(k + wpos * 17.31 + wN.x * 3.1, st + wN.z * 5.7), st) * uNight * gw;
      }
    }
  } else if (m == ${MAT.CONCRETE}) {
    if (vert && lvl < 4.0 && lvl >= 1.0 && mod(u, 4.0) > 0.5) {
      col = glassCol(base, h);
      gRough = GLASS_ROUGH; gEmissive = glassSky(wN);
      if (hash12(vec2(floor(u / 6.0), wpos * 3.7)) < 0.8 * uShop) gEmissive += vec3(1.0, 0.8, 0.55) * 1.5 * uNight;
    }
  } else if (m == ${MAT.GLASS}) {
    if (vert) {
      if (mod(lvl, 4.0) < 0.5) { col = base * 0.55 + 0.04; gRough = 0.5; }
      else {
        col = mix(glassCol(base, h), base * 0.5, 0.35) * (0.9 + 0.12 * step(0.5, mod(u, 2.0)));
        gRough = 0.08; gMetal = 0.1;
        vec2 zone = vec2(floor(u / 6.0) + wpos * 13.7 + wN.x * 2.3, floor(lvl / 4.0) + wN.z * 4.1);
        gEmissive = glassSky(wN);
        if (shopLvl && lvl < 4.0) gEmissive += vec3(1.0, 0.86, 0.66) * 1.3 * uNight * step(hash12(vec2(floor(u / 6.0), wpos * 5.1)), 0.15 + 0.85 * uShop);
        else gEmissive += windowLight(cell, zone, floor(lvl / 4.0)) * 1.2 * uNight;
      }
    } else { gRough = 0.3; gMetal = 0.4; }
  } else if (m == ${MAT.CLASSIC}) {
    gRough = 0.8;
    if (vert && lvl < 7.5) col *= mod(lvl, 2.0) < 1.0 ? 0.9 : 1.0;
    // A church (stone or brick, windows.bin's religious kind): tall round-headed windows, ~1.8 m wide every 5-7 m, from
    // 3.5 m up to 2 m under the eave (vWTop; 11.5 m where that is not known). Its walls were blank: not the town's
    // storeys of windows, and the voxels had none (but the cathedral's, scripts/passau.py: none drawn over those)
    if (vert && vWTop > 6.5 && (int(texelFetch(uWinMap, ivec2(cell.xz), 0).r * 255.0 + 0.5) & 7) == 6) {
      vec2 pa = vVox.xz - uNoWin.xy, ba = uNoWin.zw - uNoWin.xy;
      if (length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0)) > uNoWinR) {
        float P = 5.0 + 2.0 * hash12(vec2(vBid * 0.41, 8.3)), x = uc - floor(hash12(vec2(vBid * 0.29, 1.9)) * P);
        float top = min(vWTop - 2.0, 11.5), wd = 1.8, r = 0.5 * wd;
        float cu = band(x, fwU, P, 0.0, wd), cv = span(lv, fwV, 3.5, top - r + 0.3); // (into the arch: no seam where the two meet)
        float dx = mod(x, P) - r, dy = lv - (top - r);
        float arch = dy > 0.0 ? clamp((r - length(vec2(dx, dy))) / max(fwU, 1e-3) + 0.5, 0.0, 1.0) * step(abs(dx), r) : 0.0;
        float win = top - 3.5 > 3.0 ? max(cu * cv, arch) : 0.0;
        if (win > 0.0) {
          col = mix(col, glassCol(base, h) * vec3(1.0, 1.05, 1.1), win);
          gRough = mix(gRough, GLASS_ROUGH, win);
          gEmissive = (glassSky(wN) + vec3(1.0, 0.78, 0.5) * 0.12 * uNight * step(0.4, hash12(vec2(vBid, 2.2)))) * win;
        }
      }
    }
  } else if (m == ${MAT.RIBBON}) {
    if (vert && mod(lvl, 4.0) > 1.5) {
      col = glassCol(base, h); gRough = GLASS_ROUGH; gEmissive = glassSky(wN);
      vec2 zone = vec2(floor(u / 12.0) + wpos * 13.7 + wN.x * 2.3, floor(lvl / 4.0) + wN.z * 4.1);
      gEmissive += windowLight(cell, zone, floor(lvl / 4.0)) * uNight;
    } else { gRough = 0.4; gMetal = 0.3; }
  } else if (m == ${MAT.FLOODLIT}) { // floodlit stone: a landmark washed in warm light at night
    float tower = smoothstep(20.0, 28.0, lvl), wash = 1.0 - 0.3 * smoothstep(28.0, 190.0, lvl);
    vec3 light = mix(vec3(1.0, 0.78, 0.5) * 0.6 * (1.0 - 0.6 * smoothstep(4.0, 18.0, lvl)), vec3(0.95, 0.74, 0.4) * wash * 2.4, tower);
    gEmissive = vert ? col * light * uNight : vec3(0.0);
  } else if (m == ${MAT.WINDOW}) {
    gRough = GLASS_ROUGH;
    col = glassCol(base, h);
    gEmissive = (vert ? glassSky(wN) : vec3(0.0)) + windowLight(cell, floor(cell.xz / 2.0) + floor(cell.y / 2.0) * 7.3, floor(cell.y / 3.0)) * uNight;
  } else if (m == ${MAT.LEAF}) {
    col = base * uLeaf * (0.8 + 0.35 * h); gRough = 0.95;
    if (uFolOn > 0.5) {
      vec3 fo = foliageAt(cell);
      if (leafOff(cell, fo)) {
        #if !defined(CLAY) && !defined(PREPASSED)
        if (leafGone(cell, fo)) discard;
        #endif
        col = mix(vec3(0.16, 0.13, 0.11), vec3(0.25, 0.21, 0.18), hash13(floor(cell * 0.5) + 2.7)) * (0.8 + 0.4 * h);
      } else {
        col = mix(col, uFolCol[int(fo.z)] * (0.75 + 0.45 * h), smoothstep(0.0, 0.3, fo.y - 0.85 * hash13(cell * 0.9 + 1.3)));
      }
    }
  } else if (m == ${MAT.GRASS}) {
    col = base * mix(vec3(1.0), grassTint(), smoothstep(0.02, 0.08, base.g - max(base.r, base.b))) * (0.88 + 0.2 * h); gRough = 1.0;
  } else if (m == ${MAT.WATER}) {
    r = sin(cell.x * 0.9 + uTime * 1.3) * sin(cell.z * 1.1 - uTime) * 0.5 + 0.5;
    float rip = 1.0 - 0.75 * smoothstep(0.25, 0.7, fwU); // per-cell ripples under a few pixels a cell beat into a checkerboard
    col = base * (0.92 + rip * (mix(0.72, 1.12, r * r) - 0.92)) * (0.94 + 0.12 * h * rip); gRough = 0.04; gMetal = 0.3; // each river's own colour (voxelize.py, from the ortho)
    vec3 V = normalize(cameraPosition - vVox);
    float fres = 1.0 - clamp(dot(vN, V), 0.0, 1.0); fres *= fres; fres2 = 0.35 + 0.65 * fres; fres *= fres;
    col = mix(col, uHorizon * 0.8, clamp(0.08 + 0.55 * fres, 0.0, 0.55));
    if (vN.y > 0.5 && hash12(cell.xz * 0.37 + floor(uTime * 1.7 + h * 9.0)) < 0.006) col += vec3(0.35, 0.4, 0.38) * (1.0 - uNight) * (1.0 - uNight);
    if (vN.y > 0.5) gRefl = 1.0; // the open river mirrors (post.ts Reflections)
    if (uDrop > 0.0) { // low water: where the estimated bed is shallower than the drop, a sandbank
      float bed = texelFetch(uFlood, ivec2(cell.x, cell.z), 0).g * 25.5;
      if (bed < uDrop) {
        col = mix(vec3(0.3, 0.24, 0.15), vec3(0.62, 0.52, 0.36), smoothstep(0.05, 0.35, uDrop - bed)) * (0.92 + 0.12 * h);
        gRough = 0.95; gMetal = 0.0; gRefl = 0.0;
      }
    }
  } else if (m == ${MAT.LAMP}) {
    col = base; gEmissive = vec3(1.0, 0.82, 0.55) * (0.15 + 3.2 * uNight);
  } else if (m == ${MAT.METAL}) {
    gRough = 0.4; gMetal = 0.5;
    if (base.r > 0.3 && base.r > base.b * 2.0) gEmissive = base * 1.2 * uNight;
  } else if (m == ${MAT.SOIL}) {
    col = base * (mod(cell.y, 5.0) < 1.0 ? 0.82 : 1.0) * (0.9 + 0.2 * h); gRough = 1.0;
  } else if (m == ${MAT.CAR}) {
    gRough = 0.25; gMetal = 0.3;
    if (uNight > 0.0 && vert && lvl < 1.0) gEmissive = mix(vec3(1.0, 0.12, 0.08), vec3(1.0, 0.95, 0.85), step(0.5, h)) * 1.4 * uNight * step(0.55, fract(h * 7.0));
  } else if (m == ${MAT.BRONZE}) {
    if (vert) {
      if (mod(lvl, 4.0) < 0.5) { col = vec3(0.025, 0.024, 0.022); gRough = 0.5; }
      else if (mod(u, 3.0) < 0.5) {
        col = vec3(0.16, 0.12, 0.065); gRough = 0.55; gMetal = 0.25;
        gEmissive = vec3(1.0, 0.75, 0.4) * 0.35 * uNight;
      } else {
        col = mix(glassCol(base, h), base * 0.4, 0.4); gRough = 0.06; gMetal = 0.15;
        if (hash12(vec2(floor(u / 2.0) + cell.x * 0.17, floor(lvl / 4.0))) > 0.6) gEmissive = vec3(1.0, 0.85, 0.6) * 0.5 * uNight;
      }
    }
  } else if (m == ${MAT.SIGNBAND}) {
    col = base; gRough = 0.35; gMetal = 0.7;
  } else if (m == ${MAT.SIGN}) {
    col = base; gRough = 0.3; gMetal = 0.6;
    gEmissive = base * (0.15 + 2.2 * uNight);
  } else if (m == ${MAT.JET}) {
    #ifndef PREPASSED
    if (${JET_GONE}) discard;
    #endif
    col = base; gRough = 0.05; gMetal = 0.2;
    gEmissive = vec3(0.7, 0.85, 1.0) * 0.8 * uNight;
  } else if (m == ${MAT.CLOCK}) {
    gRough = 0.3; gEmissive = vec3(1.0, 0.95, 0.8) * 1.4 * uNight;
  } else if (m == ${MAT.MARK}) {
    col = base * (0.95 + 0.05 * h);
  }
  // The map's edge, below the ground: cut like a diorama's block, not a slab of soil. Dark topsoil and loam follow the
  // surface; under them beds of gravel, sand and clay lie level, gently wavy; then the gneiss Passau stands on, in
  // courses; at the bottom a dark plinth under a pale trim line
  bool cut = vert && lv < 0.0 && m != ${MAT.WATER} && (min(vVox.x, vVox.z) < 0.01 || vVox.x > uSize.x - 0.01 || vVox.z > uSize.y - 0.01);
  if (cut) {
    float along = abs(vN.x) > 0.5 ? vVox.z : vVox.x, dep = -lv, y = vVox.y, fy = fwV + 0.02;
    float wob = 0.9 * sin(along * 0.043) + 0.5 * sin(along * 0.117 + 1.3);
    float yb = y + wob + 0.8 * sin(y * 0.37 + 0.4), bed = floor(yb / 2.6), hb = hash12(vec2(bed, 7.3));
    vec3 beds = hb < 0.3 ? vec3(0.33, 0.24, 0.14) : hb < 0.65 ? vec3(0.25, 0.17, 0.11) : vec3(0.29, 0.20, 0.12);
    beds *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.25 + fy, yb - bed * 2.6)); // each bed's foot a little darker
    float rockTop = 9.0 + 2.5 * sin(along * 0.021 + 0.7) + wob;
    // gneiss in rough beds: joints wander, and the cracks across them come every few metres, not as bricks
    float ry = y + 0.5 * sin(along * 0.07 + y * 0.3), course = floor(ry / 2.3), hc = hash12(vec2(course, 3.1));
    float cx = along + 7.0 * hc, cp = 4.0 + 5.0 * hc, blk = hash12(vec2(floor(cx / cp), course));
    float joint = max(band(cx, fwU + 0.02, cp, 0.0, 0.07) * step(0.35, blk), band(ry, fy, 2.3, 0.0, 0.06));
    vec3 rock = vec3(0.15, 0.15, 0.145) * (0.85 + 0.25 * blk) * (1.0 - 0.45 * joint);
    vec3 earth = mix(vec3(0.045, 0.028, 0.017), vec3(0.2, 0.13, 0.07), smoothstep(0.35 - fy, 0.35 + fy, dep));
    earth = mix(earth, beds, smoothstep(2.4 - fy, 2.4 + fy, dep + 0.3 * wob));
    col = mix(earth, rock, (1.0 - smoothstep(rockTop - fy, rockTop + fy, y)) * smoothstep(2.4 - fy, 2.4 + fy, dep + 0.3 * wob));
    col = mix(col, vec3(0.42, 0.40, 0.37), span(y, fy, 2.0, 2.2));
    col = mix(col, vec3(0.025, 0.024, 0.024), span(y, fy, -10.0, 2.0));
    col *= 0.97 + 0.06 * h;
    gRough = 1.0; gMetal = 0.0; gEmissive = vec3(0.0);
  }
  if (uFolOn > 0.5 && vN.y > 0.5 && lvl < 0.5 && m != ${MAT.WATER} && m != ${MAT.LEAF} && m != ${MAT.MARK}) {
    vec2 ff = foliageCell(cell);
    float lit = litter(ff) * (m == ${MAT.GRASS} || m == ${MAT.SOIL} ? 0.9 : 0.35);
    if (hash13(cell * 3.1 + 0.7) < lit) {
      int cls = int(ff.r * 255.0 + 0.5);
      col = mix(uFolCol[cls], vec3(0.32, 0.22, 0.12), 0.45 * hash13(cell * 1.3)) * (0.7 + 0.3 * h);
      gRough = 1.0; gMetal = 0.0;
    }
  }
  if (uSnow > 0.0 && (vN.y > 0.5 || vRoof > 0.5) && m != ${MAT.WATER} && m != ${MAT.LAMP} && m != ${MAT.JET} && m != ${MAT.SIGN}) {
    float lum = dot(base, vec3(0.3, 0.59, 0.11));
    float street = lvl < 0.5 && m != ${MAT.GRASS} && m != ${MAT.SOIL} && m != ${MAT.LEAF} ? 1.0 : 0.0;
    float cover = smoothstep(0.0, 0.6, uSnow - 0.35 * hash13(cell + 0.5)) * mix(1.0, 0.35 + 0.4 * step(0.5, hash12(floor(cell.xz / 3.0))), street);
    vec3 snowCol = mix(vec3(0.86, 0.88, 0.92), vec3(0.42, 0.42, 0.43), street * smoothstep(0.25, 0.05, lum)) * (0.96 + 0.06 * h);
    col = mix(col, snowCol, cover);
    gRough = mix(gRough, 0.8, cover); gMetal *= 1.0 - cover; gEmissive *= 1.0 - cover;
  } else if (uWet > 0.0 && m != ${MAT.WATER} && m != ${MAT.LEAF} && m != ${MAT.GLASS}) {
    float flat_ = vN.y > 0.5 && vRoof < 0.5 ? 1.0 : 0.0;
    float pud = flat_ * smoothstep(0.6, 0.7, hash12(floor(cell.xz / 2.0)) * 0.5 + hash12(floor(cell.xz / 7.0)) * 0.5);
    col *= mix(1.0, mix(0.82, mix(0.5, 0.3, pud), flat_), uWet);
    gRough = mix(gRough, mix(0.5, 0.03, pud), uWet * mix(0.5, 1.0, flat_));
    if (m != ${MAT.GRASS}) gRefl = flat_ * uWet * mix(0.1, 0.65, pud); // a puddle mirrors, a wet street a little (post.ts Reflections)
  }
  if (uNight > 0.0) { // street lamps light what is near the ground; water reflects them instead
    vec3 lm = texture2D(uLampMap, vVox.xz / uSize).rgb;
    float fall = cut ? 0.0 : clamp(1.0 - (vVox.y - gz) / 16.0, 0.0, 1.0);
    float up = m == ${MAT.LEAF} ? (vN.y < -0.5 ? 2.6 : 1.7) : m == ${MAT.GRASS} ? 0.55 : 1.0;
    if (m == ${MAT.WATER}) {
      // the lights on the banks, mirrored: a light at height y is seen in the water y * (distance / height of the eye)
      // beyond the point, away from the eye -- sampled at a few heights, so each light draws a streak towards the viewer
      vec2 away = vVox.xz - cameraPosition.xz;
      float dc = length(away), k = dc / max(cameraPosition.y - vVox.y, 2.0);
      away /= max(dc, 1e-3);
      // broken by the ripples across the line of sight, into bands that drift
      vec2 side = vec2(-away.y, away.x);
      float a = dot(vVox.xz, away), b = dot(vVox.xz, side);
      float sw = sin(a * 2.1 + 1.7 * sin(b * 0.31 + uTime * 0.5) - uTime * 1.9) * 0.6 + sin(a * 0.93 - b * 0.27 + uTime * 1.1) * 0.4;
      float shim = (0.45 + 0.9 * smoothstep(-0.2, 0.9, sw)) * (0.8 + 0.4 * hash12(cell.xz + floor(uTime * 3.0)));
      vec3 refl = vec3(0.0); vec2 o; float ow;
      // the heights slide with the ripples' bands: four fixed ones mirrored each light as four separate dashes
      float jit = fract(0.65 * sw + 0.5);
      for (int i = 0; i < 4; i++) {
        float y = 3.0 + 4.0 * (float(i) + jit);
        vec3 l = texture2D(uLampMap, (vVox.xz + away * min(y * k, 400.0)) / uSize).rgb;
        refl += smoothstep(0.22, 0.6, l) * (1.0 - 0.15 * float(i)); // only a lamp's core: a point of light mirrors as a thin streak
      }
      float fl = 0.0;
      // a floodlit front mirrors only where the mirrored point is on land: sampled over the water (a capsule reaches
      // out over the river) it laid a soft round patch on the Inn
      for (int i = 0; i < 4; i++) {
        vec2 q = vVox.xz + away * min((14.0 + 14.0 * float(i)) * k, 600.0);
        float f = floodAt(q, true, o, ow);
        ivec2 fs = textureSize(uFlood, 0); // 1 x 1 until the river mask is in: no mirrored floodlight till then
        if (f > 0.0) f *= fs.x < 2 ? 0.0 : 1.0 - step(0.5, texelFetch(uFlood, clamp(ivec2(q), ivec2(0), fs - 1), 0).g * 255.0);
        fl += f;
      }
      gEmissive += (refl * 0.45 * vec3(1.0, 0.8, 0.6) + fl * 0.08 * vec3(1.0, 0.76, 0.46)) * shim * fres2 * uNight
        + lm * vec3(1.0, 0.72, 0.42) * fall * uNight * 0.25;
      // the night sky on open water: a faint sheen, stronger at a glance and broken into the same drifting bands, and a
      // scatter of glints; without it the rivers away from the banks were a flat black
      if (vN.y > 0.5) {
        float fine = 1.0 - smoothstep(0.25, 0.7, fwU); // glints smaller than a pixel would only twinkle
        float glint = step(hash12(cell.xz * 0.53 + floor(uTime * 1.3 + h * 7.0)), 0.0025) * fine;
        gEmissive += (uHorizon * (0.9 + 0.4 * fres2) * (0.4 + 0.6 * smoothstep(-0.6, 1.0, sw)) + vec3(0.1, 0.12, 0.16) * glint) * uNight;
      }
    }
    else {
      // and the lit windows light the street before them, and the fronts across it, softly (windows.ts spillMap): a
      // wall reads the street in front of it, a metre out. (NO_SPILL: without it, to time it: one fetch at night, no
      // measurable cost on an Iris Xe, interleaved A/B in one page)
      #ifdef NO_SPILL
      float spill = 0.0;
      #else
      vec2 sp = texture2D(uSpillMap, (vVox.xz + (vert ? wN.xz * 1.5 : vec2(0.0))) / uSize).rg;
      float spill = dot(sp, uSpill) * (cut ? 0.0 : clamp(1.0 - lv / 14.0, 0.0, 1.0)) * (vert ? 0.5 : 1.0);
      #endif
      gEmissive += col * (lm * fall * 2.2 * up + vec3(1.0, 0.7, 0.42) * spill * 0.75) * uNight * (1.0 + 0.8 * uWet * (1.0 - gRough)); // a wet street glistens
    }
    // floodlit landmarks: walls turned out from the axis catch most, roofs a glimmer; the pavement is the lamps'
    if (m != ${MAT.LEAF} && m != ${MAT.WATER} && m != ${MAT.LAMP} && m != ${MAT.GRASS} && m != ${MAT.SOIL}) {
      vec2 out_; float fw;
      float fk = floodAt(vVox.xz, false, out_, fw);
      if (fk > 0.0) {
        float face = vert ? clamp(0.4 + 0.7 * dot(wN.xz, out_), 0.08, 1.0) : 0.06;
        gEmissive += mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))), 0.3 + 0.55 * fw) * mix(vec3(1.0, 0.76, 0.46), vec3(1.0, 0.92, 0.8), fw) * fk * face * smoothstep(0.5, 6.0, lvl) * (1.0 - 0.35 * smoothstep(10.0, 60.0, lvl)) * uNight * 0.7;
      }
    }
  }
  if (m != ${MAT.LAMP} && m != ${MAT.JET} && m != ${MAT.SIGN}) col *= mix(1.0, uAlbedo, smoothstep(0.2, 0.6, dot(col, vec3(0.2126, 0.7152, 0.0722))));
  diffuseColor.rgb = col * mix(0.62, 1.0, vAO);
  if (vHide > 0.5) { diffuseColor.rgb = vec3(0.42, 0.41, 0.39); gEmissive = vec3(0.0); }
  #ifdef CLAY
  if (zreal(cell)) discard;
  #elif !defined(PREPASSED)
  if (!zreal(cell)) discard;
  #endif
  #ifdef CLAY
  if (!cut) { gEmissive = vec3(0.0); gRough = 0.95; gMetal = 0.0; diffuseColor.rgb = vec3(0.62, 0.61, 0.59) * mix(0.75, 1.0, vAO); }
  #endif`;

// the clay's shadow: none where the city is real (it casts its own)
export function makeClayDepthMaterial(uniforms: VoxelUniforms) {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 vattr; varying vec3 vVox; varying vec3 vN; ${NORMAL_FROM_IDX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvVox = position; vN = normalFromIdx(mod(vattr.x, 8.0));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ZONES_PARS}\nvarying vec3 vVox; varying vec3 vN;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif (zreal(floor(vVox - vN * 0.5 + 1e-3))) discard;`);
  };
  m.customProgramCacheKey = () => 'voxel-clay-depth';
  return m;
}

export function makeBuildDepthMaterial(uniforms: VoxelUniforms) {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 vattr; attribute float vpal; ${BUILD_PARS}
        varying vec3 vVox; varying vec4 vFace;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${BUILD_VERTEX}
        vVox = position + vec3(0.0, ${SUB_Y}, 0.0); ${FACE_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette; ${FACE_PARS}
        float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        ${FOLIAGE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        faceDecode();
        if (uFolOn > 0.5 && int(texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0).a * 255.0 + 0.5) == ${MAT.LEAF}) {
          vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
          vec3 fo = foliageAt(cell);
          if (leafGone(cell, fo)) discard;
        }`);
  };
  m.customProgramCacheKey = () => 'voxel-build-depth';
  return m;
}

const SHADOW_NORMAL_FALLBACK = 'vec3 shadowWorldNormal = vec3( 0.0 );'; // three's fallback without a normal attribute
if (!THREE.ShaderChunk.shadowmap_vertex.includes(SHADOW_NORMAL_FALLBACK)) throw new Error('three: shadowmap_vertex changed');

// clay: the 8 m stand-in for the city outside the budget (city.ts). far: the distance levels' tiles (city.ts), where a
// metre is a pixel or less: without the moving things' shadow map (daylight.ts NO_MOVING_SHADOW) -- a car there is two
// pixels and its shadow less, and traffic is only simulated within ~900 m of the focus anyway. What it costs is in the
// program, not in the lookup: on an Iris Xe skipping it beyond 1 km, or taking one tap instead of five, saved nothing,
// while a program without it drew the scene ~20 % faster at the overview, ~40 % over the whole map (tools/farshade.mjs)
export function makeVoxelMaterial(uniforms: VoxelUniforms, { clay = false, far = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const defs = `${ZONES_PARS}\n` + (clay ? '#define CLAY\n' : '') + (far ? '#define NO_MOVING_SHADOW\n' : '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        #ifdef PREPASSED
        invariant gl_Position; // as in the depth pre-pass (makeVoxelPrepassMaterial): the same depth to the bit
        #endif
        attribute vec4 vattr; attribute float vpal; ${BUILD_PARS}
        varying vec3 vVox; varying vec4 vFace; varying vec2 vShade; varying vec3 vLitN; ${NORMAL_FROM_IDX}`)
      // vattr.x = face axis (0-5) + 8 x the wall's direction in plan (mesher.worker.ts): a staircase wall is lit as its
      // plane. On a roof's staircase (vattr.w > 0: 1 + its downhill direction in 64 steps) the 8s are the plane's slope
      // in 2.5° steps, and it is lit as that plane
      // A chamfer's slanted face (vattr.w >= ${SLANT}, chamfer.ts) is the wall's plane itself: lit by its own direction,
      // finer, in vattr.w; the 8s of vattr.x are its staircase's, along which its windows go
      .replace('#include <beginnormal_vertex>', `float nAx = mod(vattr.x, 8.0), nAng = floor(vattr.x / 8.0 + 0.01), nRoof = vattr.w, nSlant = 0.0;
        float litAng = nAng;
        if (nRoof > ${SLANT - 0.5}) { nSlant = 1.0; litAng = 1.0 + (nRoof - ${SLANT}.0) * ${(24 / SLANT_STEPS).toFixed(6)}; nRoof = 0.0; }
        // (a wall's face: where the wall ends above it, mesher.worker.ts wallTopCode -- in metres over the ground)
        float nTop = 999.0;
        if (nRoof > ${WALL_TOP - 0.5}) { nTop = nRoof > 126.5 ? 999.0 : nRoof - ${WALL_TOP}.0; nRoof = 0.0; }
        float rSl = nAng * 0.0436332, rAz = (nRoof - 1.0) * 0.0981748;
        vec3 objectNormal = nRoof > 0.5 ? vec3(sin(rSl) * cos(rAz), cos(rSl), sin(rSl) * sin(rAz))
          : litAng > 0.5 ? vec3(cos((litAng - 1.0) * 0.261799), 0., sin((litAng - 1.0) * 0.261799)) : normalFromIdx(nAx);
        if (nRoof > 0.5) nAng = 0.0;`)
      // and its 1 m steps don't shade each other: shadow lookups step out of the staircase, 1.4 m along the wall's (or
      // roof's) true direction. (The tiles carry no normal attribute, so three's own normal bias is always zero here,
      // and stays so elsewhere: the depth bias alone is what the rest of the city is tuned for.)
      .replace('#include <shadowmap_vertex>', THREE.ShaderChunk.shadowmap_vertex
        .replace(SHADOW_NORMAL_FALLBACK, 'vec3 shadowWorldNormal = nAng > 0.5 || nRoof > 0.5 ? objectNormal : vec3( 0.0 );')
        .replace('directionalLightShadows[ i ].shadowNormalBias', '1.4'))
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vVox = position + vec3(0.0, ${SUB_Y}, 0.0); ${FACE_VERTEX} vShade = vec2(mod(vattr.y, 4.0) / 3.0, nTop); vLitN = transformedNormal;
        ${BUILD_VERTEX} vFace.x += 4096.0 * hideB;`);
    shader.fragmentShader = defs + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}\n${CLOUD_GLSL}\nvarying vec3 vLitN;`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfaceDecode();')
      // the tiles carry no normal attribute, so three flat-shades them from screen derivatives (WebGLPrograms:
      // flatShading) and the staircase's plane normal above went unused -- every 1 m step of a diagonal facade was lit
      // by its own x- or z-facing side, sunlit and shaded columns from street to eaves. Lit by the vertex normal instead
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vLitN); nonPerturbedNormal = normal;`)
      .replace('#include <color_fragment>', SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += gEmissive;')
      // a staircase wall or roof tells the screen-space AO to go easy on it (post.ts)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if ((vWallAng > 0.5 && vert && m != ${MAT.LEAF}) || vRoof > 0.5) gl_FragColor.a = 0.5;
        #ifndef CLAY
        // and what mirrors tells the reflections how much (post.ts Reflections)
        if (gRefl > 0.004) gl_FragColor.a = ${REFL_MAX.toFixed(2)} * gRefl;
        #endif`)
      // the clouds' shadows (clouds.ts) dim the sun's light alone, not the sky's: one bilinear lookup. Iris Xe, 1400 x 900,
      // with and without (NO_CLOUD_SHADOW) frame by frame in one page: ~0.1-0.2 ms (overview, from Oberhaus, the streets)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
        #ifndef NO_CLOUD_SHADOW
        { float cs = cloudShade(vVox); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }
        #endif`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float aoF = mix(0.55, 1.0, vAO);
        reflectedLight.indirectDiffuse *= aoF; reflectedLight.indirectSpecular *= aoF;`);
  };
  mat.customProgramCacheKey = () => `voxel${clay ? '-clay' : ''}${far ? '-far' : ''}`;
  return mat;
}

// The depth pre-pass (prepass.ts): a tile's depth alone, before the real pass draws it with the depth test Equal and
// no depth write. Each vertex lands where makeVoxelMaterial puts it (the same lines, gl_Position invariant in both),
// and what the real pass would discard -- bare twigs' leaves, a jet between spurts, a block left to the clay -- is
// discarded here instead: such a fragment writes no depth, so the real pass fails the test there, and is compiled
// without its discards (PREPASSED). A shader that never discards keeps the GPU's early depth test.
export function makeVoxelPrepassMaterial(uniforms: VoxelUniforms) {
  const m = new THREE.MeshBasicMaterial({ colorWrite: false, fog: false });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        invariant gl_Position;
        attribute vec4 vattr; attribute float vpal; ${BUILD_PARS}
        varying vec3 vVox; varying vec4 vFace;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vVox = position + vec3(0.0, ${SUB_Y}, 0.0); ${FACE_VERTEX}
        ${BUILD_VERTEX}`);
    shader.fragmentShader = `${ZONES_PARS}\n` + shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette; uniform float uTime; ${FACE_PARS}
        float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        ${FOLIAGE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        faceDecode();
        {
          int m = int(texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0).a * 255.0 + 0.5);
          float wa = (vWallAng - 1.0) * 0.261799;
          vec3 cell = ${CELL};
          if (m == ${MAT.LEAF} && uFolOn > 0.5 && leafGone(cell, foliageAt(cell))) discard;
          if (m == ${MAT.JET}) {
            float lvl = cell.y - floor(vGz + 0.5);
            bool vert = abs(vN.y) < 0.5;
            float h = ${CELL_HASH};
            if (${JET_GONE}) discard;
          }
          if (!zreal(cell)) discard;
        }`);
  };
  m.customProgramCacheKey = () => 'voxel-prepass';
  return m;
}

export type VoxelMaterial = ReturnType<typeof makeVoxelMaterial>;
