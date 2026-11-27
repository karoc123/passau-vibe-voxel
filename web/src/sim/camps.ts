// Enemy camps: a place a mode lists where a squad of NPCs keeps watch. Manned only near players and never in front of
// one; stood down (its NPCs taken away, their number kept) once all are far; a squad cut down stays so until the refill
// is due. No three.js, no DOM (tools/core-deps.mjs).
import type { Duty } from './npc-mind';
import type { CampTuning } from './tuning';

/** a camp's place as a mode lists it: where its guard stands (map x, z) and the way it watches (h) */
export interface CampPlace { readonly name: string; readonly x: number; readonly z: number; readonly h: number }

/** what the camps act through (WorldSim's) */
export interface CampWorld {
  /** an enemy put down on the ground at (x, z), keeping duty, in squad; its id, or null: the ground there not loaded */
  man(x: number, z: number, duty: Duty, squad: number): number | null;
  /** whether NPC id is in the world and alive */
  alive(id: number): boolean;
  /** NPC id taken out of the world */
  remove(id: number): void;
}

interface Camp {
  readonly place: CampPlace;
  awake: boolean;
  /** its NPCs in the world, alive */
  npcs: number[];
  /** how many it has (null: not yet woken); when it is full again (Infinity: none lost) */
  strength: number | null;
  due: number;
}

export class Camps {
  private readonly camps: Camp[];

  constructor(private readonly w: CampWorld, readonly places: readonly CampPlace[], private readonly T: CampTuning) {
    this.camps = places.map((place) => ({ place, awake: false, npcs: [], strength: null, due: Infinity }));
  }

  /** the places of the camps awake (the host keeps their voxels in) */
  awake() { return this.camps.filter((c) => c.awake).map((c) => c.place); }

  /** a tick at now (s) with the players where they are (one point each) */
  update(now: number, players: readonly { x: number; z: number }[]) {
    const T = this.T;
    this.camps.forEach((c, squad) => {
      const P = c.place, near = (r: number) => players.filter((p) => (p.x - P.x) ** 2 + (p.z - P.z) ** 2 <= r * r).length;
      const lost = c.npcs.filter((id) => !this.w.alive(id)).length;
      if (lost) {
        c.npcs = c.npcs.filter((id) => this.w.alive(id));
        c.strength! -= lost;
        if (c.due === Infinity) c.due = now + T.refill;
      }
      if (!c.awake) {
        if (!near(T.wake)) return;
        c.awake = true;
      } else if (!near(T.sleep)) {
        for (const id of c.npcs) this.w.remove(id);
        c.npcs = [];
        c.awake = false;
        return;
      }
      if (c.strength === null || now >= c.due) { c.strength = T.squad[Math.min(near(T.wake), T.squad.length) - 1] ?? 0; c.due = Infinity; }
      if (c.npcs.length >= c.strength || near(T.unseen)) return;
      // (alive the first of its posts, so one lost and slept over comes back as the guard)
      for (let i = c.npcs.length; i < c.strength; i++) {
        const d = this.duty(P, i), at = d.kind === 'guard' ? d : d.loop[0], id = this.w.man(at.x, at.z, d, squad);
        if (id === null) return;
        c.npcs.push(id);
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
