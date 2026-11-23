import * as THREE from 'three';
import type { Meta } from './types';
import { FOLIAGE_CLASSES } from './foliage';
import { dataTexture } from './util';
import { CLOUD_GLSL, cloudUniforms } from './clouds';
import { SLANT, SLANT_STEPS } from './chamfer';
import { WALL_TOP } from './roofs';
import { FIELDS_GLSL, fieldUniforms } from './fields';
import { FLOODLIT, floodCapsules, LIT_N } from './lamplight';
import { MAT, GROUND, groundClass, pavedGround } from './core/materials';

// what mirrors marks itself in the scene's alpha at up to this (post.ts Reflections)
export const REFL_MAX = 0.4;
// the material ids and the ground's paved classes (three.js-free, core/materials.ts)
export { MAT, GROUND, groundClass, pavedGround };

type U<T> = { value: T };
export interface VoxelUniforms {
  [name: string]: THREE.IUniform;
  uPalette: U<THREE.Texture>;
  uSize: U<THREE.Vector2>;
  // the map's corner in the project grid (meta.origin, as x, 0, z): what is hashed or patterned by its place (a cell's
  // tone, the leaves' turn, window rhythms, the ground's stones) is so in the project grid's coordinates, so a place
  // looks the same whatever the map's extent (scripts/aoi.py)
  uOrg: U<THREE.Vector3>;
  uNight: U<number>;
  uTime: U<number>;
  uHorizon: U<THREE.Color>;
  uWet: U<number>;
  uSnow: U<number>;
  uDay: U<number>;
  uFolOn: U<number>;
  // 1 while every deciduous tree is in full leaf: wood's faces towards leaves are left out (BUILD_VERTEX)
  uWoodHid: U<number>;
  uFolDate: U<THREE.Vector4[]>;
  uFolCol: U<THREE.Color[]>;
  uGrass: U<THREE.Color[]>;
  uLeaf: U<THREE.Color>;
  // the larch's foliage class (phenology.json: the class of Larix; -1 none): its needles summer-green, not spruce's
  uFolLarch: U<number>;
  // per building (zones.py id): what it is, for its windows (windows.ts, scripts/windows.py)
  uWinB: U<THREE.Texture>;
  uWinMed: U<number[]>;
  uWinShape: U<number[]>;
  uWinFloors: U<number[]>;
  uWinCol: U<THREE.Vector3[]>;
  uAlbedo: U<number>;
  uStage: U<number>;
  uBldOn: U<THREE.Texture>;
  uLitA: U<THREE.Vector4[]>;
  uLitB: U<THREE.Vector4[]>;
  uNoWin: U<THREE.Vector4>;
  uNoWinR: U<number>;
  uSpill: U<THREE.Vector2>;
  // the shown nodes' pages (fields.ts)
  uPageIdx: U<THREE.Texture>;
  uPageF: U<THREE.DataArrayTexture>;
  uPageS: U<THREE.DataArrayTexture>;
  uPageL: U<THREE.DataArrayTexture>;
  uShop: U<number>;
  // indoors (MAT.INTERIOR, INTERIOR_GLASS): the share of the sky's light (the hemisphere, the environment) that reaches in
  uIndoorAmb: U<number>;
}

const tiny = (format: THREE.PixelFormat, data: Uint8Array | Uint16Array, type?: THREE.TextureDataType) => dataTexture(data, 1, 1, format, type);

export function makeUniforms(meta: Meta): VoxelUniforms {
  const U: VoxelUniforms = {
    uPalette: { value: makePaletteTexture(meta.palette) },
    uSize: { value: new THREE.Vector2(meta.W, meta.D) },
    uOrg: { value: new THREE.Vector3(meta.origin?.[0] ?? 0, 0, meta.origin?.[1] ?? 0) },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uHorizon: { value: new THREE.Color(0.7, 0.75, 0.8) },
    uWet: { value: 0 },
    uSnow: { value: 0 },
    uDay: { value: 200 },
    uFolOn: { value: 0 },
    uFolDate: { value: Array.from({ length: FOLIAGE_CLASSES }, () => new THREE.Vector4(-1, 0, 0, 0)) },
    uFolCol: { value: Array.from({ length: FOLIAGE_CLASSES }, () => new THREE.Color(0.3, 0.2, 0.05)) },
    uGrass: { value: Array.from({ length: 12 }, () => new THREE.Color(1, 1, 1)) },
    uLeaf: { value: new THREE.Color(1, 1, 1) },
    uFolLarch: { value: -1 },
    uWinB: { value: tiny(THREE.RedFormat, new Uint8Array(1)) },
    uWinMed: { value: new Array(8).fill(0.12) },
    uWinShape: { value: Array.from({ length: 72 }, (_, i) => (i % 9) / 4) },
    uWinFloors: { value: new Array(8).fill(0) },
    uWinCol: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0.7, 0.25, 0.05)) },
    uAlbedo: { value: 0.7 },
    uStage: { value: 0 },
    uBldOn: { value: tiny(THREE.RedFormat, new Uint8Array(1)) },
    uSpill: { value: new THREE.Vector2(1, 1) },
    uShop: { value: 1 },
    uIndoorAmb: { value: 0.35 },
    ...fieldUniforms(),
    ...floodlights(meta),
    ...cloudUniforms,
    uWoodHid: { value: 0 },
  };
  U.uWoodHid = { get value() { return woodHidden(U); } };
  return U;
}

// Whether every deciduous class is in full leaf today, its trees' stagger included (FOLIAGE foliageOf: leaf = 1 from
// d.x + 14 to d.z - 8 days, each tree up to 2.45 d.w days off its class), a day to spare; or foliage is off (leaves
// always on). Then no branch can show, and the faces of wood towards leaves are left out (BUILD_VERTEX).
function woodHidden(U: VoxelUniforms) {
  if (U.uFolOn.value < 0.5) return 1;
  const day = U.uDay.value;
  for (const d of U.uFolDate.value) {
    if (d.x < 0) continue;
    const m = 2.45 * d.w + 1;
    if (day - m < d.x + 14 || day + m > d.z - 8) return 0;
  }
  return 1;
}

function makePaletteTexture(palette: Meta['palette']) {
  const size = 64, data = new Uint8Array(size * size * 4);
  palette.forEach((p, i) => data.set([p[0], p[1], p[2], p[3] | (groundClass(p) << 5)], i * 4));
  const tex = dataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return tex;
}

// Passau's floodlit landmarks (lamplight.ts FLOODLIT): capsules in plan, uLitA (a and b) and uLitB (radius, strength,
// how white, not mirrored); which reaches a point is in the lamp pages (fields.ts litAt)
function floodlights(meta: Meta) {
  const A = Array.from({ length: LIT_N }, () => new THREE.Vector4()), B = Array.from({ length: LIT_N }, () => new THREE.Vector4());
  const caps = floodCapsules(meta);
  caps.forEach((c, i) => { A[i].set(c.ax, c.ay, c.bx, c.by); B[i].set(c.r, c.k, c.w, c.still ? 1 : 0); });
  // the cathedral has its windows in voxels (scripts/passau.py): the shader draws none on its walls
  const dom = meta.labels.find((l) => l.name === 'Dom St. Stephan'), da = FLOODLIT['Dom St. Stephan'];
  const noWin = dom ? new THREE.Vector4(dom.x + 0.5 + da.a![0], dom.y + 0.5 + da.a![1], dom.x + 0.5 + da.b![0], dom.y + 0.5 + da.b![1]) : new THREE.Vector4(-1e4, -1e4, -1e4, -1e4);
  return { uLitA: { value: A }, uLitB: { value: B }, uNoWin: { value: noWin }, uNoWinR: { value: da.r } };
}

// A leaf voxel through the year (foliage.ts): x = in leaf (0 bare .. 1), y = turned (0 green .. 1 autumn colour), z = class.
const FOLIAGE = `${FIELDS_GLSL}
  uniform vec4 uFolDate[${FOLIAGE_CLASSES}]; uniform vec3 uFolCol[${FOLIAGE_CLASSES}]; uniform float uDay; uniform float uFolOn; uniform vec3 uGrass[12]; uniform vec3 uLeaf; uniform float uFolLarch;
  // (cell: in the project grid's coordinates, the map's + uOrg: CELL)
  uniform vec3 uOrg;
  vec2 foliageCell(vec3 cell) { return foliageAtP(cell.xz - uOrg.xz + 0.5); }
  // fine: the node shown here is a 1 m one -- its leaves are a foliage tile's, with the crown's branches under them
  // (scripts/voxelize.py, mesher.worker.ts); else they are 2, 4 or 8 m blocks, with no branches in them
  bool leafFine(vec3 cell) { return pageAt(cell.xz - uOrg.xz + 0.5).y == 1; }
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
  // A leaf's turn to fall (0 first .. 1 last), against fo.x (in leaf, 1 .. 0): partly by 2 m clumps, mostly voxel by
  // voxel. Fine (1 m, branches under the leaves): every leaf goes, so a bare crown is its trunk and branches.
  // Coarse (2-8 m blocks, no branches): a bare crown keeps most of its blocks as a muted grey-brown mass of twigs
  // (leafTwig), a fifth or so gone, the ground showing through, in the 1 m crowns' bark brown, so that from afar a wood in winter is a soft grey-brown, not crumbs.
  float leafRank(vec3 cell) { return 0.35 * hash13(floor(cell * 0.5) * 1.3 + 5.1) + 0.65 * hash13(cell * 1.7 + 3.1); }
  bool leafOff(vec3 cell, vec3 fo) { return leafRank(cell) >= fo.x; }
  bool leafGone(vec3 cell, vec3 fo, bool fine) {
    return leafOff(cell, fo) && (fine || 0.6 * hash13(floor(cell * 0.5) * 2.1 + 9.3) + 0.4 * hash13(cell * 2.3 + 7.7) > 0.72);
  }
  // a coarse bare crown's twigs: brown as the 1 m trees' bark beside it, a little paler on top where the sky lights them
  vec3 leafTwig(vec3 cell, float h, float up) {
    return mix(vec3(0.13, 0.085, 0.055), vec3(0.2, 0.14, 0.1), hash13(floor(cell * 0.5) + 2.7)) * (0.85 + 0.25 * h) * (0.92 + 0.1 * up);
  }`;

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
const BUILD_PARS = `uniform float uStage; uniform sampler2D uBldOn; attribute float vbld; uniform float uWoodHid; uniform sampler2D uPalette;`;
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
  }
  // wood seen only through leaves (mesher.worker.ts THRU), while every tree is in full leaf: left out, all four corners
  // alike (a quad of no area)
  if (uWoodHid > 0.5 && vattr.w > 126.5 && vattr.w < 127.5) {
    int wp = int(vpal + 0.5);
    if ((int(texelFetch(uPalette, ivec2(wp % 64, wp / 64), 0).a * 255.0 + 0.5) & 31) == ${MAT.WOOD}) transformed = vec3(0.0);
  }`;

// What is the same at all of a face's corners reaches the fragment shader packed into one interpolated vec4 --
// (palette + 4096 x hidden, its facing + 8 x its wall's direction + 256 x (1 roof, 2 chamfer), building, ground) --
// and is unpacked there (faceDecode), each part rounded: interpolating equal values lands a hair off them. (Not what
// varies over a face: its AO, a gable's wall top, a roof's plane in vattr.x / vattr.w, whose normal is interpolated.)
// No \`flat\` varyings: through ANGLE's D3D11 a program with any costs extra work per triangle. On an Iris Xe (Windows
// Chrome, interleaved A/B in one page) the scene pass at 1/16 of the pixels went from 16-22 to ~5 ms, at full size
// from 25-27 to 12-16 ms; the sun's shadow map, drawn with makeBuildDepthMaterial, ~20 % faster. Integer attributes
// (gpuType IntType) or dropping the per-vertex uBldOn fetch saved nothing measurable there (measured
// with the tiles' material against a plain one).
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

const FRAG_PARS = `
  uniform sampler2D uPalette; uniform vec2 uSpill; uniform float uShop; uniform float uIndoorAmb;
  uniform vec2 uSize; uniform float uNight; uniform float uTime; uniform vec3 uHorizon;
  uniform float uWet; uniform float uSnow; uniform float uAlbedo;
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
  // The ground close up (GROUND, by its palette entry): cobbles, slabs, asphalt's grain -- what a 1 m voxel cannot hold,
  // drawn from the fragment's place (p, metres) and box-filtered over its footprint w (metres along x and z): a joint
  // narrower than a pixel fades to its share of the pixel, and each stone's tone and dome fade out (det) before they
  // could shimmer. The joints darken against their mean, so from afar the ground keeps its colour. Out: gBump, the
  // normal's tilt (a cobble's dome); gJoint, how much more of a joint than the mean is here (rain fills them, snow lies
  // in them first)
  vec3 gBump; float gJoint;
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // joints j wide every P, centred on its multiples: how much of a pixel w wide they cover (the box filter of a line
  // whose edges ramp over the pixel; past j it caps at j / w, the mean over the pixel)
  float joints(float x, float w, float P, float j) {
    float d = abs(fract(x / P + 0.5) - 0.5) * P;
    return clamp((0.5 * (j + w) - d) / w, 0.0, min(1.0, j / w));
  }
  // stones of s.x by s.y in rows along x (row: the row's index), each row shifted by a random part of a stone, joints jw
  // wide; out: tone, a random 0..1 per stone, and f, the place in it (-0.5..0.5)
  float stones(vec2 q, vec2 w, vec2 s, float jw, float stagger, out float tone, out vec2 f) {
    float row = floor(q.y / s.y), x = q.x + s.x * (stagger < 0.0 ? 0.5 * mod(row, 2.0) : stagger * fract(row * 0.618034));
    float jx = joints(x, w.x, s.x, jw), jz = joints(q.y, w.y, s.y, jw);
    tone = hash12(vec2(floor(x / s.x), row));
    f = vec2(fract(x / s.x), fract(q.y / s.y)) - 0.5;
    return jx + jz - jx * jz;
  }
  void groundDetail(int cls, vec2 p, vec2 w, inout vec3 col) {
    float fw = max(w.x, w.y);
    if (cls == ${GROUND.SETT} || cls == ${GROUND.ROADSETT} || cls == ${GROUND.SLAB}) {
      bool sett = cls == ${GROUND.SETT}, slab = cls == ${GROUND.SLAB};
      vec2 s = sett ? vec2(0.14, 0.13) : slab ? vec2(0.5, 0.35) : vec2(0.2, 0.16);
      if (fw > 2.0 * s.y) return;
      float jw = slab ? 0.012 : sett ? 0.02 : 0.025;
      vec2 q = p, wq = w;
      if (sett) { // laid in segmental arcs, 2 m across, each sagging 0.35 m
        float xa = (fract(p.x * 0.5) - 0.5) * 2.0;
        q.y -= 0.35 * xa * xa; wq.y += 0.7 * abs(xa) * w.x;
      }
      float tone; vec2 f;
      float j = stones(q, wq, s, jw, slab ? -1.0 : 1.0, tone, f);
      float mean = 1.0 - (1.0 - jw / s.x) * (1.0 - jw / s.y);
      float fwq = max(wq.x, wq.y);
      float c = 1.0 - smoothstep(0.5 * s.y, 2.0 * s.y, fwq), det = 1.0 - smoothstep(0.15 * s.y, 0.5 * s.y, fwq);
      float k = slab ? 0.35 : 0.6; // how dark a joint
      col *= mix(1.0, (1.0 - k * j) / (1.0 - k * mean), c);
      if (slab) {
        col *= 1.0 + det * 0.1 * (tone - 0.5);
        gBump = vec3(tone - 0.5, 0.0, fract(tone * 7.3) - 0.5) * 0.05 * det; // slabs a little out of true
      } else {
        // granite setts: grey, some warmer, some bluer, each domed
        float t2 = fract(tone * 13.7);
        col *= (1.0 + det * 0.45 * (tone - 0.5)) * mix(vec3(1.0), t2 < 0.3 ? vec3(1.07, 1.0, 0.9) : t2 > 0.8 ? vec3(0.93, 0.97, 1.05) : vec3(1.0), det);
        gBump = vec3(f.x, 0.0, f.y) * (sett ? 0.9 : 0.6) * det;
      }
      gJoint = c * (j - mean);
    } else if (cls == ${GROUND.CONCRETE}) {
      if (fw > 1.5) return;
      float tone; vec2 f;
      float j = stones(p, w, vec2(3.0), 0.02, 0.0, tone, f), mean = 1.0 - (1.0 - 0.02 / 3.0) * (1.0 - 0.02 / 3.0);
      float c = 1.0 - smoothstep(0.1, 1.5, fw), det = 1.0 - smoothstep(0.05, 0.2, fw);
      col *= mix(1.0, (1.0 - 0.4 * j) / (1.0 - 0.4 * mean), c) * (1.0 + c * 0.08 * (tone - 0.5) + det * 0.1 * (vnoise(p * 2.3) - 0.5));
      gJoint = c * (j - mean);
    } else if (cls == ${GROUND.ASPHALT} || cls == ${GROUND.GRAVEL}) {
      // asphalt: worn patches over metres, a mottle over a hand's width, the grit; gravel: the same, coarser and stronger
      if (fw > 1.2) return;
      bool grav = cls == ${GROUND.GRAVEL};
      float g = (vnoise(p * 0.35) - 0.5) * (grav ? 0.08 : 0.12) * (1.0 - smoothstep(0.4, 1.2, fw));
      if (fw < 0.15) g += (vnoise(p * (grav ? 4.0 : 6.0)) - 0.5) * (grav ? 0.16 : 0.1) * (1.0 - smoothstep(0.05, 0.15, fw));
      if (fw < 0.03) {
        float gr = hash12(floor(p * (grav ? 28.0 : 40.0))), fine = 1.0 - smoothstep(0.008, 0.03, fw);
        g += (gr - 0.5) * (grav ? 0.4 : 0.2) * fine;
        gBump = vec3(gr - 0.5, 0.0, fract(gr * 9.1) - 0.5) * (grav ? 0.5 : 0.25) * fine;
      }
      col *= 1.0 + g;
    }
  }
  ${FOLIAGE}
  uniform vec4 uLitA[${LIT_N}]; uniform vec4 uLitB[${LIT_N}]; uniform vec4 uNoWin; uniform float uNoWinR;
  // how much a floodlit landmark (uLitA/B) lights a point; out: the direction from its axis, and how white its light
  float floodAt(vec2 p, bool mirror, out vec2 out_, out float w_) {
    out_ = vec2(0.0); w_ = 0.0;
    int i = litAt(p) - 1;
    if (i < 0) return 0.0;
    vec4 ab = uLitA[i], lb = uLitB[i];
    vec2 pa = p - ab.xy, ba = ab.zw - ab.xy;
    vec2 d = pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);
    float k = (1.0 - smoothstep(lb.x * 0.6, lb.x, length(d))) * lb.y * (mirror ? 1.0 - lb.w : 1.0);
    if (k > 0.0) { out_ = d / max(length(d), 1.0); w_ = lb.z; }
    return k;
  }
  uniform sampler2D uWinB; uniform float uWinMed[8]; uniform float uWinShape[72]; uniform float uWinFloors[8]; uniform vec3 uWinCol[8];
  // what the face's building is (scripts/windows.py: kind | habit << 3; 0: none)
  int winOf() {
    int b = int(vBid + 0.5);
    return b > 0 ? int(texelFetch(uWinB, ivec2(b & 127, b >> 7), 0).r * 255.0 + 0.5) : 0;
  }
  // a building's share of lit windows now: its type's measured median times the building's own habit, a point on the
  // type's measured spread (scripts/window_stats.py)
  vec3 building(vec3 cell) {
    int v = winOf();
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
// (a cap's top, core/surface.ts, rises and falls up to a metre about the ground's: its cell is the ground's top voxel, so that
// what is hashed by the cell doesn't change along its contours)
// (in the project grid's coordinates: the map's cell + uOrg)
const CELL = '(vSlant > 0.5 ? floor(vec3(vVox.x - cos(wa), vVox.y + 1e-3, vVox.z - sin(wa))) : vN.y > 0.5 && abs(vVox.y - floor(vGz + 0.5)) < 0.999 '
  + '? vec3(floor(vVox.x + 1e-3), floor(vGz + 0.5) - 1.0, floor(vVox.z + 1e-3)) : floor(vVox - vN * 0.5 + 1e-3)) + uOrg';
const CELL_HASH = 'hash13(vRoof > 0.5 && !vert ? vec3(cell.x, 0.0, cell.z) : cell)';
const JET_GONE = 'sin(uTime * 2.4 + h * 6.28) < -0.2 + lvl * 0.6';

const SURFACE = `
  vec4 pe = texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0);
  vec3 base = pow(pe.rgb, vec3(2.2));
  int pa = int(pe.a * 255.0 + 0.5), m = pa & 31; // (bits 5-7: the ground's class, GROUND)
  float wa = (vWallAng - 1.0) * 0.261799;
  // (a chamfer's face stands up to ~1 m out of the cells it belongs to: they are a metre in from it; the project grid's
  // cell: vP its place, vVox's)
  vec3 cell = ${CELL};
  vec3 vP = vVox + uOrg;
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
    u = floor(dot(vP.xz, vec2(-wN.z, wN.x)) + 1e-3);
    wpos = floor(dot(vP.xz, wN.xz) / 3.0);
  }
  // in metres, not cells: along the wall (its plane on a staircase) and above the street
  float uc = vWallAng > 0.5 ? dot(vP.xz, vec2(-wN.z, wN.x)) : (abs(vN.x) > 0.5 ? vP.z : vP.x);
  float lv = vVox.y - gz;
  // Indoors: a room's faces (scripts/interiors.py), told by their material alone (no attribute, no varying): no facade
  // windows on them (their own branch below), no weather (snow, puddles, leaf litter), no street lamps, window spill or
  // floodlight -- all of those are the street's, found by place in plan, and would reach through the roof -- and the
  // sky's light damped (uIndoorAmb, after the lights). The sun still comes in by the shadow map, where it can.
  bool indoor = m == ${MAT.INTERIOR} || m == ${MAT.INTERIOR_GLASS};
  float fwU = max(fwidth(uc), 1e-3), fwV = max(fwidth(lv), 1e-3);
  vec2 dUVx = vec2(dFdx(uc), dFdx(lv)), dUVy = vec2(dFdy(uc), dFdy(lv));
  // (a roof's top by its column alone: on a slope cell.y steps along the contours, and stepped its shade in stripes)
  float h = ${CELL_HASH};
  gEmissive = vec3(0.); gRough = 0.88; gMetal = 0.0; gRefl = 0.0; gBump = vec3(0.0); gJoint = 0.0;
  vec3 col = base * (0.97 + 0.06 * h);
  bool shopLvl = lvl > 0.5 && lvl < 3.5;
  float r = 0.5, fres2 = 1.0; // the water's ripple and its glancing reflectance, for its reflections at night
  // (CONCRETE is plain: on this map it is the civil works' -- bridge decks and piers, the lock's walls, the benches'
  // kerbs, no building's -- and the ground floor of shop windows it had put glass bands 1-4 m up the bridge piers,
  // lit as shopfronts at night)
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
    if (vert && vWTop > 6.5 && (winOf() & 7) == 6) {
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
  } else if (m == ${MAT.WOOD}) { // bark: a trunk, a crown's limbs and branches (scripts/voxelize.py)
    col = base * (0.82 + 0.3 * h); gRough = 0.92;
  } else if (m == ${MAT.LEAF}) {
    col = base * uLeaf * (0.8 + 0.35 * h); gRough = 0.95;
    if (uFolOn > 0.5) {
      vec3 fo = foliageAt(cell);
      bool fine = leafFine(cell);
      // a larch's needles (voxelize.py NEEDLES, blue-green: more blue than red, unlike any leaf green): the soft,
      // light yellow-green of a larch in leaf instead of a spruce's dark one, the needle tones' steps kept (0.145:
      // the middle tone #456a4f's green, linear). Its autumn gold and winter skeleton are its class's (phenology.json)
      // and its branches' (voxelize.py) as for the broadleaves
      if (fo.z == uFolLarch && base.b > base.r) col = vec3(0.16, 0.37, 0.085) * mix(1.0, base.g / 0.145, 0.6) * uLeaf * (0.8 + 0.35 * h);
      if (leafOff(cell, fo)) {
        #ifndef PREPASSED
        if (leafGone(cell, fo, fine)) discard;
        #endif
        col = leafTwig(cell, h, vN.y);
      } else {
        col = mix(col, uFolCol[int(fo.z)] * (0.75 + 0.45 * h), smoothstep(0.0, 0.3, fo.y - 0.85 * hash13(cell * 0.9 + 1.3)));
        // the last leaves to go, dry: browner as their turn comes
        col = mix(col, vec3(0.42, 0.3, 0.17) * (0.8 + 0.3 * h), fo.y * smoothstep(fo.x - 0.3, fo.x, leafRank(cell)) * step(fo.x, 0.999));
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
  } else if (m == ${MAT.INTERIOR}) { // plaster, stone, wood: as its colour says
    gRough = 0.9;
  } else if (m == ${MAT.INTERIOR_GLASS}) { // a window seen from inside: the day outside shines through it, at night dark
    col = glassCol(base, h); gRough = GLASS_ROUGH;
    gEmissive = uHorizon * 0.6 * (1.0 - uNight);
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
  // (not on the far tiles, NO_MOVING_SHADOW, where a metre is a pixel or less: all of it faded there. NO_GROUND_DETAIL:
  // without it, to time it)
  #if !defined(NO_MOVING_SHADOW) && !defined(NO_GROUND_DETAIL)
  vec2 gw = fwidth(vVox.xz); // (out here, where every fragment takes it)
  if ((pa >> 5) > 0 && vN.y > 0.5 && vRoof < 0.5) groundDetail(pa >> 5, vP.xz, gw, col);
  #endif
  if (uFolOn > 0.5 && !indoor && vN.y > 0.5 && lvl < 0.5 && m != ${MAT.WATER} && m != ${MAT.LEAF} && m != ${MAT.MARK}) {
    vec2 ff = foliageCell(cell);
    float lit = litter(ff) * (m == ${MAT.GRASS} || m == ${MAT.SOIL} ? 0.9 : 0.35);
    if (hash13(cell * 3.1 + 0.7) < lit) {
      int cls = int(ff.r * 255.0 + 0.5);
      col = mix(uFolCol[cls], vec3(0.32, 0.22, 0.12), 0.45 * hash13(cell * 1.3)) * (0.7 + 0.3 * h);
      gRough = 1.0; gMetal = 0.0;
    }
  }
  if (uSnow > 0.0 && !indoor && (vN.y > 0.5 || vRoof > 0.5) && m != ${MAT.WATER} && m != ${MAT.LAMP} && m != ${MAT.JET} && m != ${MAT.SIGN}) {
    float lum = dot(base, vec3(0.3, 0.59, 0.11));
    float street = lvl < 0.5 && m != ${MAT.GRASS} && m != ${MAT.SOIL} && m != ${MAT.LEAF} ? 1.0 : 0.0;
    float cover = smoothstep(0.0, 0.6, uSnow - 0.35 * hash13(cell + 0.5)) * mix(1.0, 0.35 + 0.4 * step(0.5, hash12(floor(cell.xz / 3.0))), street);
    vec3 snowCol = mix(vec3(0.86, 0.88, 0.92), vec3(0.42, 0.42, 0.43), street * smoothstep(0.25, 0.05, lum)) * (0.96 + 0.06 * h);
    cover = clamp(cover + street * 1.5 * gJoint * smoothstep(0.0, 0.5, uSnow), 0.0, 1.0); // (in the joints first)
    col = mix(col, snowCol, cover);
    gBump *= 1.0 - cover;
    gRough = mix(gRough, 0.8, cover); gMetal *= 1.0 - cover; gEmissive *= 1.0 - cover;
  } else if (uWet > 0.0 && !indoor && m != ${MAT.WATER} && m != ${MAT.LEAF} && m != ${MAT.GLASS}) {
    float flat_ = vN.y > 0.5 && vRoof < 0.5 ? 1.0 : 0.0;
    float pud = flat_ * smoothstep(0.6, 0.7, hash12(floor(cell.xz / 2.0)) * 0.5 + hash12(floor(cell.xz / 7.0)) * 0.5);
    col *= mix(1.0, mix(0.82, mix(0.5, 0.3, pud), flat_), uWet) * (1.0 - 0.5 * uWet * max(gJoint, 0.0)); // (the joints full of water)
    gBump *= 1.0 - pud * uWet; // a puddle's face is level
    gRough = mix(gRough, mix(0.5, 0.03, pud), uWet * mix(0.5, 1.0, flat_));
    if (m != ${MAT.GRASS}) gRefl = flat_ * uWet * mix(0.1, 0.65, pud); // a puddle mirrors, a wet street a little (post.ts Reflections)
  }
  if (uNight > 0.0 && !indoor) { // street lamps light what is near the ground; water reflects them instead
    vec3 lm = lampAt(vVox.xz);
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
      float a = dot(vP.xz, away), b = dot(vP.xz, side);
      float sw = sin(a * 2.1 + 1.7 * sin(b * 0.31 + uTime * 0.5) - uTime * 1.9) * 0.6 + sin(a * 0.93 - b * 0.27 + uTime * 1.1) * 0.4;
      float shim = (0.45 + 0.9 * smoothstep(-0.2, 0.9, sw)) * (0.8 + 0.4 * hash12(cell.xz + floor(uTime * 3.0)));
      vec3 refl = vec3(0.0); vec2 o; float ow;
      // the heights slide with the ripples' bands: four fixed ones mirrored each light as four separate dashes
      float jit = fract(0.65 * sw + 0.5);
      for (int i = 0; i < 4; i++) {
        float y = 3.0 + 4.0 * (float(i) + jit);
        vec3 l = lampAt(vVox.xz + away * min(y * k, 400.0));
        refl += smoothstep(0.22, 0.6, l) * (1.0 - 0.15 * float(i)); // only a lamp's core: a point of light mirrors as a thin streak
      }
      float fl = 0.0;
      // a floodlit front mirrors only where the mirrored point is on land: sampled over the water (a capsule reaches
      // out over the river) it laid a soft round patch on the Inn
      for (int i = 0; i < 4; i++) {
        vec2 q = vVox.xz + away * min((14.0 + 14.0 * float(i)) * k, 600.0);
        float f = floodAt(q, true, o, ow);
        // (none where no node shows: as before the river was known)
        if (f > 0.0) { float bq = riverAt(floor(q) + 0.5).y; f *= bq < 0.0 ? 0.0 : 1.0 - step(0.05, bq); }
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
      // and the lit windows light the street before them, and the fronts across it, softly (tile_fields.py spill_map): a
      // wall reads the street in front of it, a metre out. (NO_SPILL: without it, to time it: one fetch at night, no
      // measurable cost on an Iris Xe, interleaved A/B in one page)
      #ifdef NO_SPILL
      float spill = 0.0;
      #else
      vec2 sp = spillAt(vVox.xz + (vert ? wN.xz * 1.5 : vec2(0.0)));
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
`;

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
        if (uFolOn > 0.5 && (int(texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0).a * 255.0 + 0.5) & 31) == ${MAT.LEAF}) {
          vec3 cell = floor(vVox - vN * 0.5 + 1e-3) + uOrg;
          vec3 fo = foliageAt(cell);
          if (leafGone(cell, fo, leafFine(cell))) discard;
        }`);
  };
  m.customProgramCacheKey = () => 'voxel-build-depth';
  return m;
}

const SHADOW_NORMAL_FALLBACK = 'vec3 shadowWorldNormal = vec3( 0.0 );'; // three's fallback without a normal attribute
if (!THREE.ShaderChunk.shadowmap_vertex.includes(SHADOW_NORMAL_FALLBACK)) throw new Error('three: shadowmap_vertex changed');

// far: the distance levels' tiles (city.ts), where a
// metre is a pixel or less: without the moving things' shadow map (daylight.ts NO_MOVING_SHADOW) -- a car there is two
// pixels and its shadow less, and traffic is only simulated within ~900 m of the focus anyway. What it costs is in the
// program, not in the lookup: on an Iris Xe skipping it beyond 1 km, or taking one tap instead of five, saved nothing,
// while a program without it drew the scene ~20 % faster at the overview, ~40 % over the whole map
export function makeVoxelMaterial(uniforms: VoxelUniforms, { far = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const defs = far ? '#define NO_MOVING_SHADOW\n' : '';
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
      // (tilted by the ground's detail, gBump: a cobble's dome)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vLitN + (viewMatrix * vec4(gBump, 0.0)).xyz); nonPerturbedNormal = normal;`)
      .replace('#include <color_fragment>', SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += gEmissive;')
      // a staircase wall or roof tells the screen-space AO to go easy on it (post.ts)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if ((vWallAng > 0.5 && vert && m != ${MAT.LEAF}) || vRoof > 0.5) gl_FragColor.a = 0.5;
        // and what mirrors tells the reflections how much (post.ts Reflections)
        if (gRefl > 0.004) gl_FragColor.a = ${REFL_MAX.toFixed(2)} * gRefl;`)
      // the clouds' shadows (clouds.ts) dim the sun's light alone, not the sky's: one bilinear lookup. Iris Xe, 1400 x 900,
      // with and without (NO_CLOUD_SHADOW) frame by frame in one page: ~0.1-0.2 ms (overview, from Oberhaus, the streets)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
        #ifndef NO_CLOUD_SHADOW
        { float cs = cloudShade(vVox); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }
        #endif`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float aoF = mix(0.55, 1.0, vAO) * (indoor ? uIndoorAmb : 1.0);
        reflectedLight.indirectDiffuse *= aoF; reflectedLight.indirectSpecular *= aoF;`);
  };
  mat.customProgramCacheKey = () => `voxel${far ? '-far' : ''}`;
  return mat;
}

// The depth pre-pass (prepass.ts): a tile's depth alone, before the real pass draws it with the depth test Equal and
// no depth write. Each vertex lands where makeVoxelMaterial puts it (the same lines, gl_Position invariant in both),
// and what the real pass would discard -- bare twigs' leaves, a jet between spurts -- is
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
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette; uniform float uTime; ${FACE_PARS}
        float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        ${FOLIAGE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        faceDecode();
        {
          int m = int(texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0).a * 255.0 + 0.5) & 31;
          float wa = (vWallAng - 1.0) * 0.261799;
          vec3 cell = ${CELL};
          if (m == ${MAT.LEAF} && uFolOn > 0.5 && leafGone(cell, foliageAt(cell), leafFine(cell))) discard;
          if (m == ${MAT.JET}) {
            float lvl = cell.y - floor(vGz + 0.5);
            bool vert = abs(vN.y) < 0.5;
            float h = ${CELL_HASH};
            if (${JET_GONE}) discard;
          }
        }`);
  };
  m.customProgramCacheKey = () => 'voxel-prepass';
  return m;
}

export type VoxelMaterial = ReturnType<typeof makeVoxelMaterial>;
