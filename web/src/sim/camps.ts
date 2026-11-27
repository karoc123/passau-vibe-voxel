// Enemy camps: a place a mode lists where a squad of NPCs keeps watch, and a lookout where it has one. Manned only near
// players and never in front of one; stood down (its NPCs taken away, their number kept) once all are far; a squad cut
// down stays so until the refill is due. Its alarm calls its planes, if it has any left. No three.js, no DOM
// (tools/core-deps.mjs).
import type { Duty } from './npc-mind';
import type { CampTuning } from './tuning';

/** a camp's place as a mode lists it: where its guard stands (map x, z) and the way it watches (h); where its lookout
 * stands, on the highest floor there, and the way it watches (none: no lookout) */
export interface CampPlace {
  readonly name: string; readonly x: number; readonly z: number; readonly h: number;
  readonly lookout?: { readonly x: number; readonly z: number; readonly h: number };
}

/** what the camps act through (WorldSim's) */
export interface CampWorld {
  /** an enemy put down on the ground at (x, z), keeping duty, in squad; its id, or null: the ground there not loaded */
  man(x: number, z: number, duty: Duty, squad: number): number | null;
  /** whether NPC id is in the world and alive */
  alive(id: number): boolean;
  /** NPC id taken out of the world */
  remove(id: number): void;
  /** an enemy plane called to guard (x, z), appearing out of every player's sight; its craft id, or null: not now */
  fly(x: number, z: number): number | null;
  /** enemy plane id: flying, shot down or crashed (lost), or flown off and taken away (gone) */
  plane(id: number): 'up' | 'lost' | 'gone';
}

interface Camp {
  readonly place: CampPlace;
  awake: boolean;
  /** its squad's NPCs in the world, alive; its lookout's (null: none now) and whether it was lost (back at the
   * refill) */
  npcs: number[];
  lookout: number | null;
  lookoutLost: boolean;
  /** how many it has (null: not yet woken); when it is full again (Infinity: none lost) */
  strength: number | null;
  due: number;
  /** its planes up; how many it lost (none again till the refill: planeDue); when its alarm's call is answered
   * (Infinity: no call) */
  planes: number[];
  planesLost: number;
  planeDue: number;
  call: number;
}

export class Camps {
  private readonly camps: Camp[];

  constructor(private readonly w: CampWorld, readonly places: readonly CampPlace[], private readonly T: CampTuning) {
    this.camps = places.map((place) => ({ place, awake: false, npcs: [], lookout: null, lookoutLost: false, strength: null, due: Infinity,
      planes: [], planesLost: 0, planeDue: Infinity, call: Infinity }));
  }

  /** the places of the camps awake (the host keeps their voxels in) */
  awake() { return this.camps.filter((c) => c.awake).map((c) => c.place); }

  /** camp squad's alarm at now (s): one of its NPCs noticed a player; it calls a plane if it has one left */
  alarm(squad: number, now: number) {
    const c = this.camps[squad];
    if (c && c.call === Infinity && c.planes.length < this.T.planes - c.planesLost) c.call = now + this.T.call;
  }

  /** a tick at now (s) with the players where they are (one point each) */
  update(now: number, players: readonly { x: number; z: number }[]) {
    const T = this.T;
    this.camps.forEach((c, squad) => {
      // (a plane is not the camp's ground: it goes on, and is let go, whether the camp sleeps or not)
      c.planes = c.planes.filter((id) => {
        const s = this.w.plane(id);
        if (s === 'lost') { c.planesLost++; if (c.planeDue === Infinity) c.planeDue = now + T.refill; }
        return s === 'up';
      });
      if (now >= c.planeDue) { c.planesLost = 0; c.planeDue = Infinity; }
      while (now >= c.call && c.planes.length < T.planes - c.planesLost) {
        const id = this.w.fly(c.place.x, c.place.z);
        if (id === null) break;
        c.planes.push(id);
      }
      if (c.planes.length >= T.planes - c.planesLost) c.call = Infinity;
      const P = c.place, near = (r: number) => players.filter((p) => (p.x - P.x) ** 2 + (p.z - P.z) ** 2 <= r * r).length;
      const lost = c.npcs.filter((id) => !this.w.alive(id)).length;
      if (lost) {
        c.npcs = c.npcs.filter((id) => this.w.alive(id));
        c.strength! -= lost;
      }
      if (c.lookout !== null && !this.w.alive(c.lookout)) { c.lookout = null; c.lookoutLost = true; }
      if ((lost || c.lookoutLost) && c.due === Infinity) c.due = now + T.refill;
      if (!c.awake) {
        if (!near(T.wake)) return;
        c.awake = true;
      } else if (!near(T.sleep)) {
        for (const id of c.npcs) this.w.remove(id);
        if (c.lookout !== null) this.w.remove(c.lookout);
        c.npcs = [];
        c.lookout = null;
        c.awake = false;
        return;
      }
      if (c.strength === null || now >= c.due) { c.strength = T.squad[Math.min(near(T.wake), T.squad.length) - 1] ?? 0; c.lookoutLost = false; c.due = Infinity; }
      if (near(T.unseen)) return;
      // (alive the first of its posts, so one lost and slept over comes back as the guard)
      for (let i = c.npcs.length; i < c.strength; i++) {
        const d = this.duty(P, i), at = d.kind !== 'patrol' ? d : d.loop[0], id = this.w.man(at.x, at.z, d, squad);
        if (id === null) return;
        c.npcs.push(id);
      }
      // (its own place may lie well off the camp's: none may watch it appear there either)
      const L = P.lookout;
      if (L && c.lookout === null && !c.lookoutLost && !players.some((p) => (p.x - L.x) ** 2 + (p.z - L.z) ** 2 <= T.unseen ** 2)) {
        c.lookout = this.w.man(L.x, L.z, { kind: 'lookout', ...L }, squad);
      }
    });
  }

  // the i-th post: a guard on the place, a patrol round its square, then a second guard watching the other way beside
  // the first and a second patrol the other way round
  private duty(P: CampPlace, i: number): Duty {
    const R = this.T.loop, side = (i >> 1) * 3;
    if (i % 2 === 0) return { kind: 'guard', x: P.x + Math.cos(P.h) * side, z: P.z - Math.sin(P.h) * side, h: P.h + (i >> 1) * Math.PI };
    const loop = [[R, R], [R, -R], [-R, -R], [-R, R]].map(([u, v]) => ({ x: P.x + u, z: P.z + v }));
    return { kind: 'patrol', loop: i > 1 ? loop.reverse() : loop };
  }
}
