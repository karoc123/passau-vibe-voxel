// An enemy plane's pilot (ADR 0027): one small state machine that flies the combat plane with a player's input (the
// stick, the lever) and pulls its trigger, so its gun, fixed in the nose, hits only where the nose is flown. Passes at
// one target at a time, a pause between them. The ground goes before everything. No three.js, no DOM
// (tools/core-deps.mjs).
import type { Vec3 } from '../core/vec';
import type { PlayerId } from './contract/ids';
import type { PlaneInput } from './contract/inputs';
import type { PilotTuning } from './tuning';

/** circle: round its home, looking; setup: away from the target to turn in; attack: the pass, nose on the target;
 * break: pulling up and away after it; leave: off for good (its host takes it away out of sight) */
export type PilotState = 'circle' | 'setup' | 'attack' | 'break' | 'leave';

export interface Pilot {
  /** the place it guards (its camp's): it attacks only players within its leash of it */
  readonly home: { readonly x: number; readonly z: number };
  readonly k: PilotTuning;
  state: PilotState;
  /** when the state began; when it last looked; when it last saw its target (or came, if never) */
  since: number;
  looked: number;
  seenAt: number;
  target: PlayerId | null;
  /** where the target was when last seen (the point it aims at) */
  seen: Vec3 | null;
  /** setup: turning in now; attack: when it first fired (-1: not yet); the side it flies out to, and how far round
   * from the last pass's line (rad) */
  turning: boolean;
  skew: number;
  fired: number;
  side: number;
  /** the passes begun */
  passes: number;
}

/** where its plane is: its place, heading, path angle and bank (rad), airspeed (m/s), where its nose points (its gun
 * with it), its tank (0..1; null: none) */
export interface PilotMe { x: number; y: number; z: number; h: number; gamma: number; v: number; nose: { h: number; pitch: number }; fuel: number | null }

/** what it perceives (its host's): the nearest player it sees for whom ok holds, where a player is if seen now, and
 * the top of what stands at (x, z) (null: not known) */
export interface PilotSenses {
  nearest(ok: (at: Vec3) => boolean): { player: PlayerId; at: Vec3 } | null;
  sees(player: PlayerId): Vec3 | null;
  top(x: number, z: number): number | null;
}

/** the tick's input, and a point to fire at (the gun's swing and the spread are the host's) */
export interface PilotAct { input: PlaneInput; fire?: Vec3 }

// A look every LOOK s (a ray a player). Aim within AIM rad of the target before a shot (the gun swings 2°); a dive no
// steeper than DIVE. The ground's lookahead (s along the path) and its sideways spread (rad).
// In a pass it looks PULL s ahead: what its pull-out needs, the elevator's lag with it.
const LOOK = 0.3, AIM = 2.5 * Math.PI / 180, DIVE = 0.45, AHEAD = [0, 1, 2, 3.5], SIDE = 0.35, PULL = 1.2;

export function newPilot(home: { x: number; z: number }, now: number, k: PilotTuning): Pilot {
  return { home: { x: home.x, z: home.z }, k, state: 'circle', since: now, looked: -Infinity, seenAt: now, target: null, seen: null,
    turning: false, skew: 0, fired: -1, side: 1, passes: 0 };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** the pilot's tick at clock now (s) */
export function think(m: Pilot, me: PilotMe, s: PilotSenses, now: number): PilotAct {
  const k = m.k, go = (state: PilotState) => { m.state = state; m.since = now; m.turning = false; m.fired = -1; };
  const leashed = (p: { x: number; z: number }) => Math.hypot(p.x - m.home.x, p.z - m.home.z) <= k.leash;
  if (m.state !== 'leave' && now - m.looked >= LOOK - 1e-9) {
    m.looked = now;
    let at = m.target ? s.sees(m.target) : null;
    if (at && !leashed(at)) at = null;
    if (!at && m.state !== 'attack') {
      const n = s.nearest(leashed);
      if (n) { m.target = n.player; at = n.at; }
    }
    if (at) { m.seen = at; m.seenAt = now; }
  }
  if (m.state !== 'leave' && ((me.fuel !== null && me.fuel < k.fuelLeave) || now - m.seenAt > k.leaveAfter)) go('leave');
  const seen = m.seen, lost = now - m.seenAt;
  const to = seen ? { d: Math.hypot(seen.x - me.x, seen.z - me.z), h: Math.atan2(seen.x - me.x, seen.z - me.z) } : null;
  let want: Want | null = null;
  switch (m.state) {
    case 'circle': {
      if (seen && to && lost < 1) { go('setup'); return think(m, me, s, now); }
      // (round home at its radius, turning right; from afar straight there)
      const dx = me.x - m.home.x, dz = me.z - m.home.z, r = Math.hypot(dx, dz), a = Math.atan2(dx, dz);
      want = { h: r > 2 * k.circle ? a + Math.PI : a - Math.PI / 2 - clamp((r - k.circle) / k.circle, -1, 1) * 0.8, agl: k.cruise, throttle: 0.6 };
      break;
    }
    case 'setup': {
      if (!seen || !to || lost > k.lost) { go('circle'); return think(m, me, s, now); }
      // (out past its run-in, or at its leash's end: turn in, the target ahead before the pass begins)
      if (to.d >= k.setup || Math.hypot(me.x - m.home.x, me.z - m.home.z) > k.leash) m.turning = true;
      if (m.turning && (Math.abs(wrap(to.h - me.h)) < 0.25 || now - m.since > 30)) { go('attack'); m.passes++; return think(m, me, s, now); }
      // (its height over the target's, not the ground's: a target up a slope is dived at as steeply as one below it)
      want = { h: m.turning ? to.h : to.h + Math.PI + m.side * 0.4, alt: seen.y + k.runIn, throttle: 0.9 };
      break;
    }
    case 'attack': {
      if (!seen || !to) { go('circle'); break; }
      const dy = seen.y - me.y, wantP = Math.atan2(dy, to.d), eh = wrap(to.h - me.nose.h), ep = wantP - me.nose.pitch;
      // (pulled out: close, its burst fired, the target gone a while, too steep, or the ground before it)
      const done = to.d < k.breakAt || (m.fired >= 0 && now - m.fired > k.fireFor) || lost > 1 || wantP < -DIVE;
      if (done || ground(me, s, k.attackClear, me.v * PULL) > me.gamma + 0.05) { m.side = -m.side; go('break'); return think(m, me, s, now); }
      const act: PilotAct = { input: { turn: clamp(-eh * 6, -1, 1), pitch: clamp(ep * 8, -1, 1), throttle: 0.8 } };
      // (a shot only at a target seen at the last look: none into the roof it went under)
      if (to.d <= k.fireFrom && Math.abs(eh) < AIM && Math.abs(ep) < AIM && lost < LOOK * 1.5) {
        if (m.fired < 0) m.fired = now;
        act.fire = { x: seen.x, y: seen.y, z: seen.z };
      }
      return act;
    }
    case 'break': {
      if (now - m.since > k.climbFor) { go(seen ? 'setup' : 'circle'); return think(m, me, s, now); }
      // (straight up and away: the turn is the setup's, with the ground ahead in view)
      want = { h: me.h, g: k.climb, throttle: 1 };
      break;
    }
    case 'leave': {
      // (straight away from home, high: its host takes it away once no player is near)
      want = { h: Math.atan2(me.x - m.home.x, me.z - m.home.z), agl: k.cruise, throttle: 0.8 };
      break;
    }
  }
  if (!want) return { input: { turn: 0, pitch: 0, throttle: 0.8 } };
  return { input: steer(me, s, want, k) };
}

/** a heading to fly, and a path angle (g), a height (alt) or one over the ground ahead (agl) */
type Want = { h: number; g?: number; alt?: number; agl?: number; throttle: number };

// the stick towards the heading and path angle wanted, with the ground before all: a climb it needs to keep its
// clearance over the ground ahead overrides, wings near level
function steer(me: PilotMe, s: PilotSenses, w: Want, k: PilotTuning): PlaneInput {
  let g = w.g ?? 0;
  if (w.g === undefined) {
    let top = w.alt ?? -Infinity;
    if (w.alt === undefined) for (const t of AHEAD) {
      const d = me.v * t, q = s.top(me.x + Math.sin(me.h) * d, me.z + Math.cos(me.h) * d);
      if (q !== null) top = Math.max(top, q + (w.agl ?? k.cruise));
    }
    g = Number.isFinite(top) ? clamp((top - me.y) * 0.015, -0.25, 0.3) : 0;
  }
  const floor = ground(me, s, k.clear, Infinity), pull = floor > g;
  g = Math.max(g, floor);
  const eh = wrap(w.h - me.h), most = pull && floor > me.gamma + 0.05 ? 0.3 : 0.9;
  return { turn: clamp(-eh * 2, -most, most), pitch: clamp((g - me.gamma) * 2.5, -1, 1), throttle: pull ? 1 : w.throttle };
}

// whether the ground past target at (heading h) lets a plane pulling out over it climb away: none higher than its
// climb's line from there, its clearance in a pass over it
function exit(at: Vec3, h: number, s: PilotSenses, k: PilotTuning) {
  for (let e = 0; e <= k.breakAt * 3; e += 30) {
    const top = s.top(at.x + Math.sin(h) * e, at.z + Math.cos(h) * e);
    if (top !== null && top + k.attackClear > at.y + k.attackClear + (e + k.breakAt) * Math.tan(k.climb) * 0.5) return false;
  }
  return true;
}

// the least path angle that keeps clear m over the ground along its heading (and a little to either side) up to
// within m ahead: points out to AHEAD s, each one's top cleared at its distance (one under it: a steep climb)
function ground(me: PilotMe, s: PilotSenses, clear: number, within: number) {
  let g = -Infinity;
  for (const t of AHEAD) {
    const d = Math.min(me.v * t, within);
    if (t > 0 && d < me.v * t && d < 30) break;
    for (const a of t ? [0, -SIDE, SIDE] : [0]) {
      const top = s.top(me.x + Math.sin(me.h + a) * d, me.z + Math.cos(me.h + a) * d);
      if (top === null) continue;
      g = Math.max(g, d < 1 ? (me.y < top + clear ? 0.5 : -Infinity) : Math.atan2(top + clear - me.y, d));
    }
  }
  return Math.min(0.5, g);
}
