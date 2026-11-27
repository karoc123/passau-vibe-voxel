// The solid things the walker and the crafts meet besides the voxels: each kind declares its shape here, an upright
// box on its pose. The walk (nav/walk.ts) is blocked and pushed by all of them alike, a craft with a shape is pushed
// out of them (sim/world-sim.ts stepCrafts) and the river's vessels give way to the crafts. A new kind becomes solid by
// a shape here and a line where its poses are gathered (the page's: view/life.ts solids; the host's: WorldSim
// solidsNear), never by collision code of its own. No three.js, no DOM.
import type { BoatPose } from './contract/agents';
import type { CraftType, VehicleId } from './contract/ids';
import type { Pose } from './contract/pose';
import { COACH_LENGTH, COACH_WIDTH } from './coaches';
import { CRAFT_SCALE, GLIDER_HEIGHT, HOVER_HEIGHT } from './craft/craft-motion';
import { BOAT } from './craft/boat-motion';
import { JET, PLANE } from './craft/plane-flight';
import { VEHICLE_IDS, VEHICLES, vehicleOf } from './vehicles';
import type { CraftCore } from './craft/craft-core';
import type { VoxelCollision } from './craft/voxel-collision';

/** a box upright on a pose: half its width (hx) and length (hz, along the heading; its middle fwd m ahead of the
 * pose), from y0 to top m over the pose's y */
export interface Shape { hx: number; hz: number; fwd?: number; y0?: number; top: number; roof?: false }
/** a shape placed: its middle x, z, heading h, from y to y + top; id: the same thing from frame to frame (what a
 * walker on its roof rides on); roof false: never stood on */
export interface Solid { x: number; y: number; z: number; h: number; hx: number; hz: number; top: number; id?: string; roof?: false }

/** the walker: a circle of WALKER_R from the soles to WALKER_HEAD over them, climbing WALKER_STEP in a stride (a kerb,
 * a stair; a car's roof with a jump) */
export const WALKER_R = 0.3, WALKER_HEAD = 1.9, WALKER_STEP = 1.05;

/** another player on foot: as solid as the walker, so two walkers push each other apart; a head is not stood on (a
 * jump from a car's roof would reach it) */
export const AVATAR_SHAPE: Shape = { hx: WALKER_R, hz: WALKER_R, top: WALKER_HEAD, roof: false };
export const COACH_SHAPE: Shape = { hx: COACH_WIDTH / 2, hz: COACH_LENGTH / 2, y0: -0.1, top: 4 };

// a vehicle type's box: round its model's parts (x across, y up from the ground, z along)
const CAR_SHAPES = Object.fromEntries(VEHICLE_IDS.map((id) => {
  let hx = 0, hz = 0, top = 0;
  for (const [w, h, l, x, y, z] of VEHICLES[id].model) { hx = Math.max(hx, Math.abs(x) + w / 2); hz = Math.max(hz, Math.abs(z) + l / 2); top = Math.max(top, y + h); }
  return [id, { hx, hz, top }];
})) as Record<VehicleId, Shape>;
/** a car of the traffic or out of it (its length is the traffic's: the model is stretched to it, as drawn) */
export function carShape(c: { vt?: VehicleId; bus: boolean; len: number }): Shape {
  const t = vehicleOf(c), s = CAR_SHAPES[t.id];
  return { ...s, hz: s.hz * c.len / t.len };
}

// The crafts standing in the world, as others meet them: the hovercraft's skirt and the helicopter's cabin and tail
// (their collision's probes and cube, sim/craft/craft-collision.ts), the boat's hull, the planes' fuselages from the
// floats' or the belly's bottom (the box a walker boards and a shot hits) and their wings, a flat box at their tips'
// height (their flight's own wing cubes, plane-flight.ts WING_*; view/crafts/*/ draws them so)
const CS = CRAFT_SCALE.helicopter;
export const CRAFT_SHAPES: Partial<Record<CraftType, Shape>> = {
  hovercraft: { hx: 2.9, hz: 6.4, y0: -HOVER_HEIGHT, top: 3.1 },
  helicopter: { hx: 1.09 * CS, hz: 4.22 * CS, fwd: -2.12 * CS, y0: -1.09 * CS, top: 1.6 * CS },
  boat: { hx: BOAT.beam / 2, hz: BOAT.length / 2, y0: -0.5, top: 1.5 },
  floatplane: { hx: 1.4, hz: 3.6, y0: -PLANE.FLOAT_H, top: 1.3 },
  jet: { hx: 0.8, hz: 4.5, fwd: 0.1, y0: -JET.FLOAT_H, top: 0.9 },
};
const WINGS: Partial<Record<CraftType, Shape>> = {
  floatplane: { hx: PLANE.WING_X + 0.25, hz: 0.75, fwd: PLANE.WING_Z, y0: PLANE.WING_Y - 0.25, top: PLANE.WING_Y + 0.25 },
  jet: { hx: JET.WING_X + 0.2, hz: 1.35, fwd: -0.9, y0: JET.WING_Y - 0.25, top: JET.WING_Y + 0.25 },
};
// The light crafts: they meet the solid things as the others do, but are none themselves (a car, the walker, another
// craft, a vessel would take a drone for a wall): what meets them pushes them aside. The drone's frame and props; the
// paraglider's pilot in the harness and its canopy (an arc boxed whole, as its probes reach it)
const LIGHT: Partial<Record<CraftType, readonly Shape[]>> = {
  drone: [{ hx: 0.18, hz: 0.18, y0: -0.06, top: 0.06 }],
  paraglider: [{ hx: 0.45, hz: 0.6, y0: -GLIDER_HEIGHT, top: 0.9 }, { hx: 5, hz: 1.3, fwd: 0.15, y0: 4.2, top: 7.5 }],
};
const MEETS: Partial<Record<CraftType, readonly Shape[]>> = {};
/** the boxes a craft of type meets the solid things with (none: it meets none), level */
export function meetShapes(type: CraftType): readonly Shape[] {
  return MEETS[type] ??= LIGHT[type] ?? [CRAFT_SHAPES[type], WINGS[type]].filter((s): s is Shape => !!s);
}
/** meetShapes placed on pose p (a plane's wings banked as it is), onto out */
export function craftMeets(type: CraftType, p: CraftPose, out: Solid[] = []) {
  const l = LIGHT[type];
  if (!l) return craftSolids(type, p, out);
  for (const s of l) out.push(solidAt(s, p));
  return out;
}
/** a light craft of type at pose p as another light craft (own) meets it, onto out: a paraglider is solid to a drone
 * and to another paraglider, a drone only to another drone (it would stop a paraglider dead in the air; it is the one
 * shoved aside) */
export function lightSolids(own: CraftType, type: CraftType, p: Pose, out: Solid[]) {
  const l = LIGHT[own] && LIGHT[type];
  if (l && (type === 'paraglider' || own === 'drone')) for (const s of l) out.push(solidAt(s, p));
  return out;
}

/** after each of a craft's steps (the host's and the page's run ahead alike, so both meet the same): pushed out of
 * each of near that one of its boxes reaches into */
export function meetSolids(type: CraftType, core: CraftCore, near: readonly Solid[], col: VoxelCollision) {
  MINE.length = 0;
  for (const a of craftMeets(type, core.pose, MINE)) for (const s of near) {
    const d = overlap(a, s, OUT);
    if (d > 0) core.meet!(OUT, d, col);
  }
}
const OUT = { x: 0, z: 0 }, MINE: Solid[] = [];

/** a craft's pose; bank (rad, > 0 its right wing down): a plane's, what its wings are to the solid things */
export type CraftPose = Pose & { bank?: number };
/** the solid things a craft of type is to others at pose p, pushed onto out (none for a light craft); id: the body's
 * (its wings' id + 'w', banked + the box's number), so a walker on it is carried by the same one the next tick */
export function craftSolids(type: CraftType, p: CraftPose, out: Solid[] = [], id?: string) {
  const s = CRAFT_SHAPES[type], w = WINGS[type];
  if (s) out.push(solidAt(s, p, id));
  if (w) wingSolids(w, p, out, id === undefined ? undefined : `${id}w`);
  return out;
}

// Banked, a wing is a stair of ROLLED boxes a side, each round its stretch of the rolled span: the boxes stay upright
// as every solid thing does, and a step (a metre at full bank) is little more than a wing's thickness to a car under
// it. Within a few degrees of level (or upside down) one box spans both wings.
const ROLLED = 4;
function wingSolids(w: Shape, p: CraftPose, out: Solid[], id?: string) {
  const b = p.bank ?? 0, cb = Math.cos(b), sb = Math.sin(b), n = Math.abs(sb) < 0.05 ? 1 : 2 * ROLLED;
  const y0 = w.y0 ?? 0, u = (y0 + w.top) / 2, t = (w.top - y0) / 2, half = w.hx / n;
  const ch = Math.cos(p.h), sh = Math.sin(p.h), f = w.fwd ?? 0;
  const hx = half * Math.abs(cb) + t * Math.abs(sb), hy = half * Math.abs(sb) + t * Math.abs(cb);
  for (let k = 0; k < n; k++) {
    // (a: along the span towards the left wing, the one a bank > 0 lifts)
    const a = -w.hx + (2 * k + 1) * half, x = a * cb - u * sb, y = a * sb + u * cb;
    const o: Solid = { x: p.x + ch * x + sh * f, y: p.y + y - hy, z: p.z - sh * x + ch * f, h: p.h, hx, hz: w.hz, top: 2 * hy };
    if (id !== undefined) o.id = n === 1 ? id : `${id}${k}`;
    out.push(o);
  }
}

/** the river's vessels' measures (m): a cruise ship's longest length and its beam, an excursion boat's */
export const CRUISE_L = 135, CRUISE_B = 11.4, TOUR_L = 38, TOUR_B = 8;
// the river's vessels, as view/boats.ts draws them: the hull from under the waterline to the sun deck (a cruise ship)
// or the open top deck (an excursion boat)
const VESSEL = { ship: { hx: CRUISE_B / 2, y0: -1.4, top: 7.4 }, boat: { hx: TOUR_B / 2, y0: -1, top: 3.7 } };
/** a vessel of the river traffic (its length is its pose's) */
export const vesselShape = (p: Pick<BoatPose, 'kind' | 'len'>): Shape => ({ ...VESSEL[p.kind], hz: p.len / 2 });

// what a craft of no shape here is to a shot and to a boarding walker: a box round its pilot
const SMALL_CRAFT: Shape = { hx: 1.5, hz: 3, y0: -1, top: 1 };
/** a craft's box (y its foot, ht its height; r, l half its width and length) as a shot and a boarding walker meet it:
 * its shape where it has one, so both agree with what the walker bumps into */
export function craftBox(type: CraftType, p: Pose) {
  const s = solidAt(CRAFT_SHAPES[type] ?? SMALL_CRAFT, p);
  return { x: s.x, y: s.y, z: s.z, h: s.h, r: s.hx, l: s.hz, ht: s.top };
}

/** shape s placed on pose p (id: see Solid) */
export function solidAt(s: Shape, p: Pose, id?: string): Solid {
  const f = s.fwd ?? 0;
  const o: Solid = { x: p.x + Math.sin(p.h) * f, y: p.y + (s.y0 ?? 0), z: p.z + Math.cos(p.h) * f, h: p.h, hx: s.hx, hz: s.hz, top: s.top - (s.y0 ?? 0) };
  if (id !== undefined) o.id = id;
  if (s.roof === false) o.roof = false;
  return o;
}

/** the highest roof of solids no higher than below that the walker at x, z stands on (its circle over the roof, out
 * by margin), and the solid; null: none */
export function roofUnder(solids: readonly Solid[], x: number, z: number, below: number, margin = WALKER_R): Solid | null {
  let best: Solid | null = null;
  for (const s of solids) {
    const t = s.y + s.top;
    if (s.roof === false || t > below || (best && t <= best.y + best.top)) continue;
    const c = Math.cos(s.h), n = Math.sin(s.h), dx = x - s.x, dz = z - s.z;
    if (Math.abs(dx * c - dz * n) <= s.hx + margin && Math.abs(dx * n + dz * c) <= s.hz + margin) best = s;
  }
  return best;
}

/** where P, on the roof of a as it was, is on b (the same thing moved and turned since): x, z, and the rise dy and the
 * turn dh to add */
export function carried(a: Solid, b: Solid, P: { x: number; z: number }) {
  const ca = Math.cos(a.h), na = Math.sin(a.h), dx = P.x - a.x, dz = P.z - a.z;
  const v = dx * ca - dz * na, u = dx * na + dz * ca, cb = Math.cos(b.h), nb = Math.sin(b.h);
  return { x: b.x + v * cb + u * nb, z: b.z - v * nb + u * cb, dy: b.y + b.top - a.y - a.top, dh: Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)) };
}

/** how far the walker at x, z (its soles at feet) reaches into s (m; 0 or less: clear of it), and which way out (a
 * unit x, z) */
export function reach(s: Solid, x: number, z: number, feet: number, out?: { x: number; z: number }): number {
  if (feet >= s.y + s.top - 0.05 || feet + WALKER_HEAD <= s.y) return -1;
  const c = Math.cos(s.h), n = Math.sin(s.h), dx = x - s.x, dz = z - s.z;
  const v = dx * c - dz * n, u = dx * n + dz * c;
  const cv = Math.max(-s.hx, Math.min(s.hx, v)), cu = Math.max(-s.hz, Math.min(s.hz, u)), d = Math.hypot(v - cv, u - cu);
  let ov: number, ou: number, depth: number;
  if (d > 1e-9) { depth = WALKER_R - d; ov = (v - cv) / d; ou = (u - cu) / d; }
  else {
    // (inside: out of the nearer side)
    const mv = s.hx - Math.abs(v), mu = s.hz - Math.abs(u);
    if (mv < mu) { depth = WALKER_R + mv; ov = v < 0 ? -1 : 1; ou = 0; } else { depth = WALKER_R + mu; ov = 0; ou = u < 0 ? -1 : 1; }
  }
  if (out) { out.x = c * ov + n * ou; out.z = -n * ov + c * ou; }
  return depth;
}

/** how far box a reaches into box b across (m; 0 or less: clear of it, or above or below it), and which way a gets out
 * of it soonest (out: a unit x, z) */
export function overlap(a: Solid, b: Solid, out?: { x: number; z: number }): number {
  if (a.y >= b.y + b.top || b.y >= a.y + a.top) return -1;
  const dx = a.x - b.x, dz = a.z - b.z;
  let depth = Infinity, nx = 0, nz = 0;
  // (the four sides' directions: each box's across (cos h, -sin h) and along (sin h, cos h))
  for (const s of [a, b]) {
    const c = Math.cos(s.h), n = Math.sin(s.h);
    for (const [lx, lz] of [[c, -n], [n, c]]) {
      const ra = a.hx * Math.abs(Math.cos(a.h) * lx - Math.sin(a.h) * lz) + a.hz * Math.abs(Math.sin(a.h) * lx + Math.cos(a.h) * lz);
      const rb = b.hx * Math.abs(Math.cos(b.h) * lx - Math.sin(b.h) * lz) + b.hz * Math.abs(Math.sin(b.h) * lx + Math.cos(b.h) * lz);
      const d = dx * lx + dz * lz, o = ra + rb - Math.abs(d);
      if (o <= 0) return o;
      if (o < depth) { depth = o; nx = d < 0 ? -lx : lx; nz = d < 0 ? -lz : lz; }
    }
  }
  if (out) { out.x = nx; out.z = nz; }
  return depth;
}

/** whether the walker at x, z (soles at feet) reaches further into any of solids than from x0, z0: a stride may
 * only leave a solid it is in (a car parked onto it), never go further in */
export function deeper(solids: readonly Solid[], x0: number, z0: number, x: number, z: number, feet: number) {
  for (const s of solids) {
    const d = reach(s, x, z, feet);
    if (d > 0 && d > reach(s, x0, z0, feet) + 1e-6) return true;
  }
  return false;
}

/** P pushed out of what of solids it is in (a car driven into the walker pushes it along), where clear(x, z) lets it
 * stand (no wall): out the nearest way, else (squeezed against a wall) out past the nearest other side it is clear
 * at; whether it moved */
export function pushOut(solids: readonly Solid[], P: { x: number; z: number }, feet: number, clear: (x: number, z: number) => boolean) {
  const dir = { x: 0, z: 0 };
  let moved = false;
  for (let k = 0; k < 3; k++) {
    let any = false;
    for (const s of solids) {
      const d = reach(s, P.x, P.z, feet, dir);
      if (d <= 0) continue;
      const nx = P.x + dir.x * (d + 1e-3), nz = P.z + dir.z * (d + 1e-3);
      if (clear(nx, nz)) { P.x = nx; P.z = nz; any = moved = true; continue; }
      const o = sideOut(s, P, clear);
      if (o) { P.x = o.x; P.z = o.z; any = moved = true; }
    }
    if (!any) break;
  }
  return moved;
}

// the nearest place just past one of the sides of s (across or along it) from P where clear lets the walker stand
function sideOut(s: Solid, P: { x: number; z: number }, clear: (x: number, z: number) => boolean) {
  const c = Math.cos(s.h), n = Math.sin(s.h), dx = P.x - s.x, dz = P.z - s.z;
  const v = dx * c - dz * n, u = dx * n + dz * c, ev = s.hx + WALKER_R + 1e-3, eu = s.hz + WALKER_R + 1e-3;
  const ways = [[-ev, u], [ev, u], [v, -eu], [v, eu]].sort((a, b) => Math.hypot(a[0] - v, a[1] - u) - Math.hypot(b[0] - v, b[1] - u));
  for (const [wv, wu] of ways) {
    const x = s.x + c * wv + n * wu, z = s.z - n * wv + c * wu;
    if (clear(x, z)) return { x, z };
  }
  return null;
}
