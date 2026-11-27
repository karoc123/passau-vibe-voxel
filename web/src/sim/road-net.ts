// The street network (scripts/traffic.py: roads, footways, signal controllers and heads) and where on it things are:
// a car's blended path and pose, a person's point, a signal's light. Shared (docs/adr/0009-layers-and-owners.md): the
// sim's traffic (sim/traffic.ts Traffic) and the client's copy of it (client/sim-client.ts TrafficMirror) each hold
// one over their own TrafficData, so both place what they draw with the same code.
import { clamp, hash, smooth } from '../core/num';
import { at, landingLane, prepPath, pt, turnOf, type Pt } from './path';
import type { Car, Controller, PedEdge, Road, TrafficData } from './types';
import type { Person, Shift } from './contract/agents';

// the tick (s): the traffic's, and the bodies' (two physics steps of it); what the drawn agents interpolate over
export const STEP = 1 / 30;
/** the cars' driving (the intelligent driver model): their acceleration, comfortable braking (m/s²), least gap (m)
 * and time gap (s) */
export const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };
/** a car's acceleration (m/s²) at speed v wanting v0, gap m behind what it follows (Infinity: none) going lv */
export function carAcc(v: number, v0: number, gap: number, lv: number) {
  const ss = IDM.s0 + Math.max(0, v * IDM.T + (v * (v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
  return Math.max(-9, IDM.a * (1 - (v / Math.max(v0, 0.1)) ** 4 - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2)));
}
// A car moves across (out beside something, back into its lane) as it rolls on, over SHIFT_K m of road a metre
// across (about 30 degrees at the steepest), at least SHIFT_MIN m: a driver's lane change, never a slide while
// standing. So it stops that much further short of something standing, with room to pull out.
const SHIFT_K = 1.9;
export const SHIFT_MIN = 3;
export const shiftLen = (d: number) => Math.max(SHIFT_MIN, SHIFT_K * Math.abs(d));
/** where a car stops for something standing d0 m ahead of its front that needs need m across to get past: short of it
 * by the road it takes to pull out beside it */
export const stopShort = (d0: number, need: number) => d0 - shiftLen(need) - 0.5;
// the signals' fixed-time cycle (s): green, amber, the walkers' green, from each controller's offset
export const CYCLE = 64, GREEN = 26, AMBER = 3, PED_GREEN = 18;
const LANE_W = 3.0; // m between lane centres: scripts/traffic.py LANE, the lanes it checks and places (scripts/check.sh lanes)
// how far (m) either side of a junction node a car's path is blended into the next road's
export const BLEND = 7;
// the active circles (sim/traffic.ts setActive): by default ACTIVE_R m round each player's focus (a host may set
// another), their roads found by ACTIVE_CELL m cell (activeKey); the page draws the signal heads by the same cells
// round its own viewer (view/life.ts)
export const ACTIVE_R = 350, ACTIVE_CELL = 300;
export const activeKey = (cx: number, cy: number) => cy * 65536 + cx;
// Agents come and go only this far from the viewer (the focus) or further: spawned there, removed there (over the
// hour's number, off the network, a dead end, the parked cars, the people knocked down), never in plain view. Closer
// in a car at a dead end waits there, a rider turns back; the number over the hour's waits until enough are far.
// Only the first fill (or a jump of the focus) puts them anywhere at once. (A car 300 m away is a few pixels tall, a
// person 150 m away about as much: tools/popin-check.mjs checks 200 and 100 m.)
export const CAR_POP_R = 300, PED_POP_R = 150;
// how far a person's step phase (ph) turns per metre walked, ridden: the sim's and a client's working it out alike
export const PH_WALK = 4.2, PH_RIDE = 1.6;

// the ground the agents stand on (world.ts World: the edited columns too)
export interface Ground {
  // the drawn surface at (x, z) near height y (a ramp's, a cap's)
  surface(x: number, z: number, y: number): number;
  // the top of what is solid under height `top` at (x, z)
  support(x: number, z: number, top: number): number;
}

// a car's kinematic pose: the ground point between its axles on its path, its heading, nose up
export interface CarPose { x: number; y: number; z: number; h: number; pitch: number }

function phase(ctrl: Controller, t: number, axis: number) {
  const u = ((t + ctrl.off) % CYCLE + CYCLE) % CYCLE;
  return ((u - (axis === 0 ? 0 : CYCLE / 2)) % CYCLE + CYCLE) % CYCLE;
}
/** a signal's state at time t: green, amber, red */
export const signalAt = (ctrl: Controller, t: number, axis: number) => { const k = phase(ctrl, t, axis); return k < GREEN ? 'G' : k < GREEN + AMBER ? 'Y' : 'R'; };
export const pedGreen = (ctrl: Controller, t: number, axis: number) => phase(ctrl, t, axis) < PED_GREEN;

/** the offset (m, right of the road's line) of a lane's centre */
export const laneOffset = (e: Road, lane: number) => e.o0 + lane * LANE_W;

/** a car's offset at s while it moves across (contract/agents.ts Shift) */
export const shiftOff = (h: Shift, s: number) => h[2] + (h[3] - h[2]) * smooth(h[0], h[1], s);

// A turn round (contract/agents.ts CarTurn) is worked on the rear axle, in the frame of its start (u along the road,
// w = -v so that turning left turns the heading th up from PI, facing back along the road): strokes of
// [forward 1 or back -1, arc 1 or straight 0, the arc's angle or the straight's length], after x m straight on (out of
// the way of those queued behind it: its reversing never reaches back past its rear). Those one way are driven as
// one leg, eased from standing to standing: at most TURN_V m/s on average, at least TURN_LEG s.
const TURN_V = 3.5, TURN_LEG = 0.9;
type Stroke = [dir: number, arc: number, amount: number];
const strokes = (r: number, d: number, x: number): Stroke[] => {
  if (d >= 2 * r) return [[1, 0, x], [1, 1, Math.PI / 2], [1, 0, d - 2 * r], [1, 1, Math.PI / 2]];
  const a = Math.acos(clamp((1 - d / (2 * r)) / 2, -1, 1));
  return [[1, 0, x], [1, 1, a], [-1, 1, Math.PI - 2 * a], [1, 1, a]];
};
const legs = (r: number, d: number, x: number) => {
  const out: { strokes: Stroke[]; L: number; T: number }[] = [];
  for (const k of strokes(r, d, x)) {
    const L = k[1] ? r * k[2] : k[2], last = out.at(-1);
    if (last && last.strokes[0][0] === k[0]) { last.strokes.push(k); last.L += L; } else out.push({ strokes: [k], L, T: 0 });
  }
  for (const l of out) l.T = Math.max(TURN_LEG, l.L / TURN_V);
  return out;
};
/** how long (s) a turn round (x m on, of radius r across d m) takes */
export const turnTime = (r: number, d: number, x: number) => legs(r, d, x).reduce((t, l) => t + l.T, 0);
/** the rear axle of a turn round (x m on, of radius r across d m) tau s into it, in the frame of its start (out: u, w,
 * th) */
export function turnRear(r: number, d: number, x: number, tau: number, out: { u: number; w: number; th: number }) {
  let u = 0, w = 0, th = Math.PI, t = tau;
  for (const leg of legs(r, d, x)) {
    let left = leg.L * smooth(0, leg.T, t);
    t -= leg.T;
    for (const [dir, arc, amount] of leg.strokes) {
      if (left <= 0) break;
      const g = Math.min(left, arc ? r * amount : amount);
      left -= g;
      if (arc) { const th1 = th + g / r; u += dir * r * (Math.sin(th1) - Math.sin(th)); w -= dir * r * (Math.cos(th1) - Math.cos(th)); th = th1; }
      else { u += dir * g * Math.cos(th); w += dir * g * Math.sin(th); }
    }
  }
  out.u = u; out.w = w; out.th = th;
  return out;
}

export class RoadNet {
  ground: Ground | null = null;
  readonly roads: Road[];
  readonly peds: PedEdge[];
  readonly ctrls: Controller[];
  // the signal heads ([x, z, ground, rotation, controller, axis]: drawn by view/life.ts, their lights from signalAt)
  readonly heads: NonNullable<TrafficData['heads']>;
  // scratch points
  private readonly tmp = pt();
  private readonly tmp2 = pt();
  private readonly pA = pt();
  private readonly pB = pt();
  private readonly rear = { u: 0, w: 0, th: 0 };
  /** the world's clock (s) the turns round are drawn at (the traffic's time; the client's render clock) */
  clock = 0;

  /** data: prepared in place (its paths: prepPath), so never another RoadNet's */
  constructor(data: TrafficData) {
    this.roads = data.roads.map((r, i) => Object.assign(prepPath(r), { i, lists: Array.from({ length: r.lanes }, () => []) }));
    this.peds = data.peds.map((e, i) => Object.assign(prepPath(e), { i }));
    this.ctrls = data.ctrls.map((c, i) => ({ ...c, off: hash(i + 1) * CYCLE }));
    this.heads = data.heads ?? [];
  }

  // A car's path at arc length s, blended across the junction nodes into smooth arcs: the roads before and after
  // weighted by how far the car is from each node (smooth over BLEND either side of it), each pull added on, so
  // that on a road shorter than 2 BLEND the car is drawn between both, and across a road shorter than BLEND the road
  // beyond it pulls too (prev2, next2). Where the car moves onto the next road the sum is the same on either side.
  // One moving across (a shift) is so on the roads either side too, by as much as it is out of its lane, so that its
  // way out beside something and back may run on over a junction (the traffic carries the shift onto the next road).
  carPoint(car: Car, s: number, out: Pt, off = car.off) {
    if (car.turn) return this.turnPoint(car, s, out);
    const e = this.roads[car.e];
    let dev = 0, moved = 0;
    if (car.shift) {
      off = shiftOff(car.shift, s);
      dev = off - laneOffset(e, car.lane);
      moved = off - shiftOff(car.shift, 0);
    }
    const P = at(e, s, off, out), x = P.x, y = P.y, z = P.z, Q = this.tmp, R = this.tmp2;
    // (P moved by w times the way from (ax, ay, az) to B)
    const pull = (ax: number, ay: number, az: number, B: Pt, w: number) => { P.x += (B.x - ax) * w; P.y += (B.y - ay) * w; P.z += (B.z - az) * w; };
    if (s < BLEND && car.prev >= 0) {
      const pe = this.roads[car.prev];
      at(pe, pe.L + s, car.prevOff + moved, Q);
      pull(x, y, z, Q, 1 - smooth(-BLEND, BLEND, s));
      const p2 = car.prev2 ?? -1;
      if (p2 >= 0 && s + pe.L < BLEND) { const pp = this.roads[p2]; pull(Q.x, Q.y, Q.z, at(pp, pp.L + pe.L + s, car.prev2Off ?? 0, R), 1 - smooth(-BLEND, BLEND, s + pe.L)); }
    }
    if (s > e.L - BLEND && car.next >= 0) {
      const n = this.roads[car.next], lane = landingLane(turnOf(e, n), car.lane, n.lanes);
      at(n, s - e.L, laneOffset(n, lane) + dev, Q);
      pull(x, y, z, Q, smooth(-BLEND, BLEND, s - e.L));
      const n2 = car.next2 ?? -1;
      if (n2 >= 0 && s - e.L - n.L > -BLEND) {
        const nn = this.roads[n2], lane2 = landingLane(turnOf(n, nn), lane, nn.lanes);
        pull(Q.x, Q.y, Q.z, at(nn, s - e.L - n.L, laneOffset(nn, lane2) + dev, R), smooth(-BLEND, BLEND, s - e.L - n.L));
      }
    }
    return P;
  }

  // A car turning round: its line through its front and rear axles where the turn has them now, s on it as on its
  // road (its front at car.s)
  private turnPoint(car: Car, s: number, out: Pt) {
    const [t0, r, d, x, u0, v0, ax, ay, bx, by] = car.turn!, e = this.roads[car.e], T = turnTime(r, d, x), tau = clamp(this.clock - t0, 0, T);
    const q = turnRear(r, d, x, tau, this.rear), wb = car.len - 1.2, k = 1 - smooth(0, T * 0.35, tau);
    const B = at(e, u0 + q.u, v0 - q.w, this.tmp2), bX = B.x + bx * k, bY = B.y + by * k, bZ = B.z;
    const A = at(e, u0 + q.u + wb * Math.cos(q.th), v0 - q.w - wb * Math.sin(q.th), out);
    A.x += ax * k; A.y += ay * k;
    const f = (s - car.s) / wb;
    A.x += (A.x - bX) * f; A.y += (A.y - bY) * f; A.z += (A.z - bZ) * f;
    return A;
  }

  // A car's kinematic pose with its front at arc length s, lane offset off: both axles on the blended path, the body
  // following the curve; on a ramp (world.ts surface: the paths' heights are whole metres) both axles on it, the body
  // pitched between them; flat: the paths' heights alone (where it is on the map, without reading the ground's voxels)
  carPose(c: Car, s: number, off: number, out: CarPose, flat = false) {
    const A = this.carPoint(c, s, this.pA, off), B = this.carPoint(c, s - (c.len - 1.2), this.pB, off), G = flat ? null : this.ground;
    out.h = Math.atan2(A.x - B.x, A.y - B.y);
    out.x = (A.x + B.x) / 2; out.z = (A.y + B.y) / 2;
    out.pitch = 0; out.y = Math.max(A.z, B.z);
    if (G) {
      const za = G.surface(A.x, A.y, A.z), zb = G.surface(B.x, B.y, B.z);
      if (za !== A.z || zb !== B.z) { out.pitch = Math.atan2(za - zb, Math.hypot(A.x - B.x, A.y - B.y) || 1); out.y = (za + zb) / 2; }
    }
    return out;
  }

  // Where a person walking or riding is, ds m on along their way (out: x, z on the map as x, y; their height as z):
  // a walker off the way's line by their lat (on its side, if it has one), a rider right of it
  personPoint(p: Person, ds: number, out: Pt, flat = false) {
    const e = this.peds[p.e], A = at(e, p.s + ds * p.dir, 0, out), B = at(e, p.s + (ds + 0.5) * p.dir, 0, this.tmp2);
    const l = Math.hypot(B.x - A.x, B.y - A.y) || 1, dx = (B.x - A.x) / l, dy = (B.y - A.y) / l;
    const lat = p.bike || e.side === undefined ? p.lat : p.lat * e.side * p.dir;
    const x = A.x - dy * lat, y = A.y + dx * lat;
    out.z = this.ground && !flat ? this.ground.surface(x, y, A.z) : A.z;
    out.x = x; out.y = y;
    return out;
  }
}
