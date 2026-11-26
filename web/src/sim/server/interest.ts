// What a session is sent of the world (target step 4): what lies within a radius of its kind (Radii) of where its player is (their view's focus
// and viewer, their seat's entity, the entity they follow), their own seat's entity always. A thing sent stays sent
// until it is HOLD m further out, so one going back and forth along the edge does not blink. A session whose player is
// nowhere (a tool's, a page's before its first view) is sent everything: one that is somewhere a moment later only
// loses what is far from it. No three.js, no DOM (tools/core-deps.mjs).
import { at } from '../path';
import type { SimEvent } from '../contract/events';
import type { CraftType, EntityKind, EntityRef, PlayerId } from '../contract/ids';
import type { WorldSim } from '../world-sim';

/** how far (m) past the radius a thing already sent is still sent */
const HOLD = 50;
/** the default radius beyond the street life's (sim/road-net.ts ACTIVE_R): a long way is simulated wholly when one of
 * its ends or its middle is in a circle, so its agents reach a little out */
const SEND_MARGIN = 150;

/** the radius (m) each kind is sent in: cars (air: while the player pilots an aircraft), people, the rest (bodies go
 * with their cars, walked people with theirs) */
export interface Radii { car: number; air: number; person: number; other: number }
// Cars and people are most of the bytes, so they get the least radius the page cannot tell from the sim's own: the
// street life spawns and drops them no nearer than CAR_POP_R (300 m) and PED_POP_R (150 m) from the viewer anyway
// (sim/road-net.ts), so one coming into sight at 350 m, 200 m is no new pop. From the air the streets are seen far
// off; the street life ends at ACTIVE_R (900 m) besides.
const CAR_R = 350, AIR_CAR_R = 1000, PERSON_R = 200;
const AIRCRAFT = new Set<CraftType>(['helicopter', 'paraglider', 'drone', 'floatplane', 'jet']);

/** the radii of a host whose street life reaches activeR m; one number (a tool's, ?interest=): that for everything */
export function radii(activeR: number, one?: number): Radii {
  if (one) return { car: one, air: one, person: one, other: one };
  return { car: CAR_R, air: Math.max(CAR_R, Math.min(AIR_CAR_R, activeR + SEND_MARGIN)), person: PERSON_R, other: activeR + SEND_MARGIN };
}

interface Places { tick: number; n: number; cars: Float64Array; people: Float64Array }
// the agents' places (x, z by index: the cars, then the detached; the people, then the riders) at a tick, shared by
// the sessions of one sim
const placed = new WeakMap<WorldSim, Places>();

function places(sim: WorldSim): Places {
  const T = sim.traffic, n = T.cars.length + T.detachedCars.length + T.people.length + T.riders.length;
  let P = placed.get(sim);
  if (P && P.tick === sim.tick && P.n === n) return P;
  const cars = new Float64Array(2 * (T.cars.length + T.detachedCars.length));
  const people = new Float64Array(2 * (T.people.length + T.riders.length));
  const pt = { x: 0, y: 0, z: 0 }, { roads, peds } = T.net;
  let i = 0;
  for (const c of T.cars) { at(roads[c.e], c.s, 0, pt); cars[i++] = pt.x; cars[i++] = pt.y; }
  for (const c of T.detachedCars) { const p = c.detachedPose; cars[i++] = p?.x ?? NaN; cars[i++] = p?.z ?? NaN; }
  i = 0;
  for (const list of [T.people, T.riders]) for (const p of list) { at(peds[p.e], p.s, 0, pt); people[i++] = pt.x; people[i++] = pt.y; }
  placed.set(sim, P = { tick: sim.tick, n, cars, people });
  return P;
}

type Ids = Record<EntityKind, Set<number>>;
const ids = (): Ids => ({ car: new Set(), person: new Set(), craft: new Set(), avatar: new Set() });

/** one session's sight: look (where its player is), then sees for each thing, then done */
export class Sight {
  private xs: number[] = [];
  private zs: number[] = [];
  private own: EntityRef | null = null;
  // what the last snapshot held, and what this one does
  private was = ids();
  private now = ids();
  private where: Places | null = null;
  // the cars' radius now (the player's seat: in an aircraft or not)
  private carR = 0;

  constructor(readonly r: Radii) {}

  /** where player is in sim (false: nowhere, so everything is seen); a new snapshot's start */
  look(sim: WorldSim, player: PlayerId): boolean {
    const P = sim.players.get(player), xs = this.xs, zs = this.zs;
    xs.length = zs.length = 0;
    this.own = P?.seat?.entity ?? null;
    const craft = this.own?.kind === 'craft' ? sim.crafts.get(this.own.id) : null;
    this.carR = craft && AIRCRAFT.has(craft.type) ? this.r.air : this.r.car;
    if (P?.view) {
      xs.push(P.view.focus.x); zs.push(P.view.focus.z);
      if (P.view.viewer) { xs.push(P.view.viewer.x); zs.push(P.view.viewer.z); }
    }
    for (const ref of [this.own, P?.follow]) {
      const p = ref && sim.entities.pose(ref);
      if (p) { xs.push(p.x); zs.push(p.z); }
    }
    this.where = xs.length ? places(sim) : null;
    return xs.length > 0;
  }

  /** whether the last look found the player somewhere */
  get somewhere() { return this.xs.length > 0; }

  /** whether (x, z) is within d m of where the player is */
  near(x: number, z: number, d = this.r.other) {
    const xs = this.xs, zs = this.zs, d2 = d * d;
    for (let i = 0; i < xs.length; i++) if ((x - xs[i]) ** 2 + (z - zs[i]) ** 2 <= d2) return true;
    return false;
  }

  /** whether the thing of kind and id at (x, z) is sent (and noted as sent) */
  sees(kind: EntityKind, id: number, x: number, z: number) {
    const own = this.own?.kind === kind && this.own.id === id;
    const r = kind === 'car' ? this.carR : kind === 'person' ? this.r.person : this.r.other;
    if (!own && !this.near(x, z, this.was[kind].has(id) ? r + HOLD : r)) return false;
    this.now[kind].add(id);
    return true;
  }
  /** sees for the i-th car of the traffic's cars then detached cars, person of its people then riders */
  car(id: number, i: number) { const C = this.where!.cars; return this.sees('car', id, C[2 * i], C[2 * i + 1]); }
  person(id: number, i: number) { const C = this.where!.people; return this.sees('person', id, C[2 * i], C[2 * i + 1]); }

  /** whether a thing of kind and id is sent now or was in the last snapshot (an event about it is then sent) */
  has(kind: EntityKind, id: number) { return this.now[kind].has(id) || this.was[kind].has(id); }

  /** whether event e is sent: one that happened somewhere (its at, or pose) if it is near; one about an entity (or a
   * person of the crowd) if that entity is sent or was; one about a player only (a seat taken) always */
  event(e: SimEvent) {
    const place = 'at' in e ? e.at : 'pose' in e ? e.pose : null;
    if (place) return this.near(place.x, place.z, this.r.other + HOLD);
    if ('entity' in e) return this.has(e.entity.kind, e.entity.id);
    if ('person' in e) return this.has('person', e.person);
    return true;
  }

  /** the snapshot's end: what it held is what the next one keeps a while */
  done() {
    const was = this.was;
    this.was = this.now;
    for (const s of Object.values(was)) s.clear();
    this.now = was;
  }
}
