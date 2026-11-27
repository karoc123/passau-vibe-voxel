// An NPC's behaviour: one small state machine (owner 2026-11-27: iterative steps, not too much at once). Hearing,
// cover and NPCs working together come later. No three.js, no DOM (tools/core-deps.mjs).
import type { Vec3 } from '../core/vec';
import type { PlayerId } from './contract/ids';
import { CHEST } from './figure';

/** what an NPC does at its post: a guard stands at (x, z) facing h; a patrol walks its loop's points in turn */
export type Duty = { kind: 'guard'; x: number; z: number; h: number } | { kind: 'patrol'; loop: readonly { x: number; z: number }[] };

/** post: on its duty; attack: a player in sight; search: walking to where it last saw them; back: to its post */
type MindState = 'post' | 'attack' | 'search' | 'back';

export interface Mind {
  readonly duty: Duty;
  state: MindState;
  /** the player it attacks or searches for */
  target: PlayerId | null;
  /** where the target last stood when seen (its feet), and when (s) */
  seen: Vec3 | null;
  seenAt: number;
  /** when the state began; the patrol's point walked to; when it may first fire at the target; the burst's shots
   * left; when it last looked; when a search reached its place (-1: not yet) */
  since: number;
  leg: number;
  ready: number;
  burst: number;
  looked: number;
  there: number;
}

/** what an NPC perceives (its host's: the players on foot and the voxels between) */
export interface Senses {
  /** the nearest player it sees, or null */
  nearest(): { player: PlayerId; at: Vec3 } | null;
  /** where player stands if it sees them now, else null (down or gone: null too) */
  sees(player: PlayerId): Vec3 | null;
}

/** where the NPC is: its feet, and whether it still walks to a goal (false: arrived, or given up) */
export interface Me { x: number; y: number; z: number; walking: boolean }

/** what the mind wants this tick: walk to goal (null: stand; undefined: as before), at speed (m/s); face h while
 * standing; fire at a point (aimed: spread is the shooter's) */
export interface Act { goal?: { x: number; z: number } | null; speed: number; face?: number; fire?: Vec3 }

// A player is noticed within RANGE m, looked for every LOOK s (a ray a player near costs, each NPC each look).
// REACT s pass before the first shot at a target; then bursts of BURST at the weapon's rate, PAUSE s apart. Out of
// sight LOST s it searches; at the place, it looks round for SEARCH s. It walks towards a target further than ENGAGE m.
export const RANGE = 60;
const LOOK = 0.1, REACT = 0.6, BURST = 3, PAUSE = 0.9, LOST = 1, SEARCH = 4, ENGAGE = 20;
// m/s: a patrol's stroll, the pace of an attack or a search
const STROLL = 1.6, RUN = 4;

export function newMind(duty: Duty, now: number): Mind {
  return { duty, state: 'post', target: null, seen: null, seenAt: -Infinity, since: now, leg: 0, ready: Infinity, burst: BURST, looked: -Infinity, there: -1 };
}

/** the mind's tick at clock now (s): rate, the weapon's shots a second */
export function think(m: Mind, me: Me, s: Senses, now: number, rate: number): Act {
  const go = (state: MindState) => { m.state = state; m.since = now; m.there = -1; };
  if (now - m.looked >= LOOK - 1e-9) {
    m.looked = now;
    const at = m.target ? s.sees(m.target) : null;
    if (at) { m.seen = at; m.seenAt = now; }
    if (m.state !== 'attack' || !at) {
      const n = s.nearest();
      if (n && (n.player !== m.target || m.state !== 'attack')) {
        m.target = n.player; m.seen = n.at; m.seenAt = now; m.ready = now + REACT; m.burst = BURST;
        go('attack');
      }
    }
  }
  const seen = m.seen;
  switch (m.state) {
    case 'attack': {
      if (!seen) { go('back'); break; }
      if (now - m.seenAt > LOST) { go('search'); return { goal: { x: seen.x, z: seen.z }, speed: RUN }; }
      const d = Math.hypot(seen.x - me.x, seen.z - me.z), act: Act = { goal: d > ENGAGE ? { x: seen.x, z: seen.z } : null, speed: RUN,
        face: Math.atan2(seen.x - me.x, seen.z - me.z) };
      // (a shot only at a target seen at the last look: none into the wall it went behind)
      if (now - m.seenAt < LOOK * 1.5 && now >= m.ready) {
        act.fire = { x: seen.x, y: seen.y + CHEST, z: seen.z };
        if (--m.burst > 0) m.ready = now + 1 / rate - 1e-9;
        else { m.burst = BURST; m.ready = now + PAUSE; }
      }
      return act;
    }
    case 'search': {
      if (me.walking || !seen) return { speed: RUN };
      // (there: it looks round, then gives up)
      if (m.there < 0) m.there = now;
      if (now - m.there > SEARCH) { m.target = null; go('back'); break; }
      return { speed: RUN, face: Math.atan2(seen.x - me.x, seen.z - me.z) + Math.sin((now - m.there) * 1.5) * 1.5 };
    }
    case 'back': break;
    case 'post': return post(m, me);
  }
  // back: to the post (a patrol: its nearest point, walked on from there)
  const D = m.duty;
  let to: { x: number; z: number } = D.kind === 'guard' ? D : D.loop[m.leg];
  if (D.kind === 'patrol' && m.state === 'back' && now === m.since) {
    m.leg = nearestIndex(D.loop, me);
    to = D.loop[m.leg];
  }
  if (now > m.since && !me.walking) { go('post'); return post(m, me); }
  return { goal: { x: to.x, z: to.z }, speed: RUN };
}

// on its duty: a guard back on its spot and facing its way; a patrol on to its next point when one is reached (or
// given up)
function post(m: Mind, me: Me): Act {
  const D = m.duty;
  if (D.kind === 'guard') {
    const far = Math.hypot(D.x - me.x, D.z - me.z) > 1;
    return far && !me.walking ? { goal: { x: D.x, z: D.z }, speed: STROLL } : { speed: STROLL, face: D.h, ...(far ? {} : { goal: null }) };
  }
  if (!me.walking) m.leg = (m.leg + 1) % D.loop.length;
  return { goal: D.loop[m.leg], speed: STROLL };
}

const nearestIndex = (pts: readonly { x: number; z: number }[], p: { x: number; z: number }) => {
  let best = 0, d = Infinity;
  pts.forEach((q, i) => { const e = Math.hypot(q.x - p.x, q.z - p.z); if (e < d) { d = e; best = i; } });
  return best;
};

/** the unit direction from `from` towards `to`, strayed by a spread that grows with the distance (rnd: 0..1 numbers,
 * seeded by the host so a run repeats): at 20 m about one shot in three meets a body */
export function aimFrom(from: Vec3, to: Vec3, rnd: () => number): Vec3 {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, d = Math.hypot(dx, dy, dz) || 1;
  const spread = SPREAD + SPREAD_PER_M * d, a = rnd() * 2 * Math.PI, r = spread * Math.sqrt(rnd());
  const h = Math.atan2(dx, dz) + r * Math.cos(a), p = Math.asin(dy / d) + r * Math.sin(a);
  return { x: Math.sin(h) * Math.cos(p), y: Math.sin(p), z: Math.cos(h) * Math.cos(p) };
}
// rad: the spread close by, and what each metre adds (a body 0.6 m wide at 20 m is ±0.015 rad)
const SPREAD = 0.01, SPREAD_PER_M = 0.0016;
