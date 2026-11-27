import type { WalkPose } from './contract/pose';
import type { Solid } from './solids';
import { Wet } from './swim';
import { stride } from './walk';
import { Walker, type WalkWorld } from './walker';
import { WalkGrid, type WayWorld } from './way';

// An NPC gives up on a way when it got no nearer the point it walks to by NEAR m in STUCK s, and finds it again; after
// TRIES such searches in a row it gives up the goal. A search with columns not yet loaded is made again after RETRY s.
const STUCK = 1.5, NEAR = 0.2, TRIES = 3, RETRY = 1;
// searches a tick at most (a search round a block costs a few ms): the others wait for the next tick, walking on
const SEARCHES = 2;
// m from a point of the way at which the next is walked to; from the goal at which it is reached
const PASS = 0.5, ARRIVE = 0.35;

/** an NPC on foot: its body (the walk the players' pages run), the goal it walks to and the way found there */
export interface Npc {
  readonly id: number;
  readonly body: Walker;
  /** m/s on land */
  speed: number;
  goal: { x: number; z: number } | null;
  way: { x: number; z: number }[];
  next: number;
  grid: WalkGrid | null;
  pose: WalkPose;
  prev: WalkPose;
  /** the searches made for the goal, and those in a row that got it nowhere */
  searches: number;
  tries: number;
  // the nearest it got to the point walked to, and when it last got nearer; when the last search was
  best: number;
  since: number;
  searched: number;
}

/** the world an NPC walks in: the walk's (its water read from it) */
export type NpcWorld = WalkWorld & { waterColumn(x: number, z: number): { water: number } | null };

// The host's NPCs on foot, by id (an avatar's: the same numbers as the players' bodies). Each tick each is stepped by
// the players' walk with the stride towards the next point of its way; a way is found on a walkable grid made round it
// when it is given a goal, when an edit touches the grid, and when it gets stuck.
export class Npcs {
  readonly all = new Map<number, Npc>();
  world: NpcWorld | null = null;
  // the grids' view of world (its water a floor at the walk's made-up bed), made once per world
  private way: WayWorld | null = null;
  private wayOf: NpcWorld | null = null;
  private clock = 0;

  /** an NPC put down standing at (x, y, z) (y: its soles) */
  add(id: number, at: { x: number; y: number; z: number }, speed = 4) {
    const body = new Walker({ x: 0, y: 0, z: 0 }, () => this.world);
    body.fallAt(at, { x: 0, y: 0, z: 0 }, 0);
    const pose: WalkPose = { x: at.x, y: at.y, z: at.z, h: 0, moving: false };
    this.all.set(id, { id, body, speed, goal: null, way: [], next: 0, grid: null, pose, prev: pose, searches: 0, tries: 0, best: Infinity, since: 0, searched: -Infinity });
  }

  /** npc to walk to goal (null: stand); false: no such NPC */
  goTo(id: number, goal: { x: number; z: number } | null) {
    const n = this.all.get(id);
    if (!n) return false;
    Object.assign(n, { goal, way: [], next: 0, grid: null, searches: 0, tries: 0 });
    return true;
  }

  /** box [x0, z0, x1, z1) of the voxels was edited: the grids over it are stale */
  edited(box: readonly [number, number, number, number]) {
    for (const n of this.all.values()) if (n.grid?.touches(box)) n.grid.stale = true;
  }

  /** a world tick of dt s: each NPC stepped among the solid things near it (solids) */
  tick(dt: number, solids: (x: number, z: number) => readonly Solid[]) {
    this.clock += dt;
    const w = this.world;
    let budget = SEARCHES;
    const search = (n: Npc) => { if (budget > 0) { budget--; this.search(n); } };
    for (const n of this.all.values()) {
      n.prev = n.pose;
      const B = n.body, P = B.pos;
      // (on voxels not yet loaded it would fall through the map)
      if (!w || !w.waterColumn(P.x, P.z)) continue;
      if (n.goal && (!n.grid || n.grid.stale || (n.grid.partial && this.clock - n.searched > RETRY && n.next >= n.way.length))) search(n);
      const to = n.goal ? n.way[n.next] : undefined;
      let want = 0;
      if (to) {
        const d = Math.hypot(to.x - P.x, to.z - P.z);
        if (d < n.best - NEAR) { n.best = d; n.since = this.clock; }
        const last = n.next === n.way.length - 1;
        if (d < (last ? ARRIVE : PASS)) {
          n.next++; n.tries = 0; n.best = Infinity; n.since = this.clock;
          if (last && n.grid && n.goal && Math.hypot(n.goal.x - to.x, n.goal.z - to.z) < 1) { n.goal = null; n.grid = null; }
        } else {
          B.yaw = Math.atan2(to.x - P.x, to.z - P.z);
          want = d;
          if (this.clock - n.since > STUCK && budget > 0) { n.tries++; search(n); }
        }
      }
      B.move(dt, solids(P.x, P.z), n.speed, (yaw, d) => (want ? stride(yaw, 1, 0, Math.min(d, want)) : null));
      n.pose = { x: P.x, y: B.feet, z: P.z, h: B.yaw, moving: want > 0, ...(B.swimming ? { swim: true } : {}) };
    }
  }

  // a way to the goal on a new grid round the NPC; given up after TRIES in a row that got it nowhere
  private search(n: Npc) {
    const B = n.body, P = B.pos, g = n.goal!;
    if (n.tries >= TRIES) { Object.assign(n, { goal: null, way: [], next: 0, grid: null }); return; }
    n.grid = new WalkGrid(this.ground(), P.x, P.z, B.feet, g.x, g.z);
    n.way = n.grid.way(P.x, P.z, g.x, g.z) ?? [];
    Object.assign(n, { next: 0, best: Infinity, since: this.clock, searched: this.clock });
    n.searches++;
  }

  private ground(): WayWorld {
    const w = this.world!;
    if (this.way && this.wayOf === w) return this.way;
    const wet = new Wet(() => w);
    this.wayOf = w;
    return this.way = {
      support: (x, z, top) => wet.support(x, z, top), blocked: (x, z, y0, y1) => wet.blocked(x, z, y0, y1),
      surface: (x, z) => wet.surface(x, z), loaded: (x, z) => w.waterColumn(x, z) !== null,
    };
  }
}
