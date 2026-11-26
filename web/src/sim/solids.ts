// The solid things a walker meets besides the voxels: each kind declares its shape here, an upright box on its pose,
// and the walk (nav/walk.ts) is blocked and pushed by all of them alike. A new kind becomes solid by a shape here and
// a line where its drawn poses are gathered (view/life.ts solids), never by walk code of its own. No three.js, no DOM.
import type { CraftType, VehicleId } from './contract/ids';
import type { Pose } from './contract/pose';
import { COACH_LENGTH, COACH_WIDTH } from './coaches';
import { CRAFT_SCALE, HOVER_HEIGHT } from './craft/craft-motion';
import { BOAT } from './craft/boat-motion';
import { VEHICLE_IDS, VEHICLES, vehicleOf } from './vehicles';

/** a box upright on a pose: half its width (hx) and length (hz, along the heading; its middle fwd m ahead of the
 * pose), from y0 to top m over the pose's y */
export interface Shape { hx: number; hz: number; fwd?: number; y0?: number; top: number }
/** a shape placed: its middle x, z, heading h, from y to y + top */
export interface Solid { x: number; y: number; z: number; h: number; hx: number; hz: number; top: number }

/** the walker: a circle of WALKER_R from the soles to WALKER_HEAD over them */
export const WALKER_R = 0.3, WALKER_HEAD = 1.9;

/** another player on foot: as solid as the walker, so two walkers push each other apart */
export const AVATAR_SHAPE: Shape = { hx: WALKER_R, hz: WALKER_R, top: WALKER_HEAD };
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

// The crafts standing in the world: the hovercraft's skirt and the helicopter's cabin and tail (their collision's
// probes and cube, sim/craft/craft-collision.ts), the boat's hull. Not solid: the paraglider and the drone (small,
// and dropped or flown), the planes (on the water or in the air)
const CS = CRAFT_SCALE.helicopter;
export const CRAFT_SHAPES: Partial<Record<CraftType, Shape>> = {
  hovercraft: { hx: 2.9, hz: 6.4, y0: -HOVER_HEIGHT, top: 3.1 },
  helicopter: { hx: 1.09 * CS, hz: 4.22 * CS, fwd: -2.12 * CS, y0: -1.09 * CS, top: 1.6 * CS },
  boat: { hx: BOAT.beam / 2, hz: BOAT.length / 2, y0: -0.5, top: 1.5 },
};

// what a craft of no shape here is to a shot and to a boarding walker: a box round its pilot
const SMALL_CRAFT: Shape = { hx: 1.5, hz: 3, y0: -1, top: 1 };
/** a craft's box (y its foot, ht its height; r, l half its width and length) as a shot and a boarding walker meet it:
 * its shape where it has one, so both agree with what the walker bumps into */
export function craftBox(type: CraftType, p: Pose) {
  const s = solidAt(CRAFT_SHAPES[type] ?? SMALL_CRAFT, p);
  return { x: s.x, y: s.y, z: s.z, h: s.h, r: s.hx, l: s.hz, ht: s.top };
}

/** shape s placed on pose p */
export function solidAt(s: Shape, p: Pose): Solid {
  const f = s.fwd ?? 0;
  return { x: p.x + Math.sin(p.h) * f, y: p.y + (s.y0 ?? 0), z: p.z + Math.cos(p.h) * f, h: p.h, hx: s.hx, hz: s.hz, top: s.top - (s.y0 ?? 0) };
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
 * stand (no wall); whether it moved */
export function pushOut(solids: readonly Solid[], P: { x: number; z: number }, feet: number, clear: (x: number, z: number) => boolean) {
  const dir = { x: 0, z: 0 };
  let moved = false;
  for (let k = 0; k < 3; k++) {
    let any = false;
    for (const s of solids) {
      const d = reach(s, P.x, P.z, feet, dir);
      if (d <= 0) continue;
      const nx = P.x + dir.x * (d + 1e-3), nz = P.z + dir.z * (d + 1e-3);
      if (!clear(nx, nz)) continue;
      P.x = nx; P.z = nz; any = moved = true;
    }
    if (!any) break;
  }
  return moved;
}
