import type { CraftView } from '../client/sim-client';
import type { CommandResult } from '../sim/contract/commands';
import type { EntityRef, Role } from '../sim/contract/ids';
import { SEATS } from '../sim/seats';
import { carShape, craftBox } from '../sim/solids';
import { vehicleOf } from '../sim/vehicles';
import { fromBox, type Box } from '../sim/walk-bounds';
import type { Picked } from '../view/life';
import type { PlayerCraft } from './craft';
import type { PassengerMode } from './passenger';
import { gameKey } from './input';
import type { Nav } from './nav';

// On foot, getting into what is within reach: a car of the street (moving or not: the host goes by its reach, a step
// more than offered here), a craft left in the world, or a free seat beside another player at the wheel or the
// controls (riding along: passenger.ts). The seat is asked of the host from foot first (it checks the reach from where it has the
// walker, and that the seat is free); only once it is taken does the vehicle's shell take over, asking again for the
// seat it now holds (a no-op). E gets in, and gets out of a vehicle onto foot beside it (Nav.getOut) where its own
// keys leave E free; X gets out of any (the one key no vehicle's own keys have, so a craft flying on E is left too).
// C switches seats in a craft with a gun (from the controls to the gun and back), so one player alone can man both;
// on a touch screen a button does (touch/buttons.ts), shown only while there is a seat to switch to.

// m from its sides: a step inside the host's Tuning.walk.board, so a walk the host has not yet taken is no refusal
const REACH = 3;
// the shells whose own keys have E (fpv.ts, special-craft.ts)
const E_TAKEN = new Set(['fpv', 'helicopter', 'hovercraft', 'paraglider']);
// (no getting out of a wing in the air; one is got into only where the host placed it, before its flight)
const NOT_BOARDED = 'paraglider';
/** the keys that get in (E) and out (E where free, X anywhere) */
export type BoardKey = 'KeyE' | 'KeyX';

/** what is within reach: its entity, the seat's role, what to call it, and what its shell takes over from */
export interface Target { ref: EntityRef; role: Role; label: string; picked?: Picked; craft?: CraftView }

export class Boarding {
  /** what E gets into now (on foot), or null */
  target: Target | null = null;
  // the seat asked for and when (performance.now): its answer awaited
  private pending: { t: Target; at: number; swap?: boolean } | null = null;

  constructor(private readonly nav: Nav, private readonly shells: () => readonly PlayerCraft[], private readonly say: (s: string) => void,
    private readonly passenger: () => PassengerMode | null) {
    // (before Nav's own: on foot E is also a look key, and a craft's keys must not see the E that left it)
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyC' && gameKey(e) && !e.repeat && this.swap()) { e.preventDefault(); return; }
      if ((e.code !== 'KeyE' && e.code !== 'KeyX') || !gameKey(e) || e.repeat || !this.press(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
    }, { capture: true });
  }

  /** what the button says, or null: hidden. key: on a keyboard */
  label(key: boolean) {
    const t = this.target, along = t?.role === 'passenger';
    if (this.nav.onFoot) return t ? `${key ? 'E: ' : ''}${along ? (key ? 'ride' : 'Ride') + ' along in' : (key ? 'get' : 'Get') + ' in'} ${t.label}` : this.pending ? 'Getting in…' : null;
    return !this.canGetOut() ? null : !key ? 'Get out' : this.canGetOut('KeyE') ? 'E: get out' : 'X: get out';
  }

  /** a key or (none) the button: in (on foot: E), or out; false: neither */
  press(key?: BoardKey) {
    const nav = this.nav, sim = nav.sim;
    if (!nav.onFoot) return this.canGetOut(key) && nav.getOut();
    const t = this.target;
    if (key === 'KeyX' || !t || !sim || this.pending) return false;
    sim.results('enterSeat', t.role);
    sim.send({ kind: 'enterSeat', entity: t.ref, role: t.role });
    this.pending = { t, at: performance.now() };
    this.target = null;
    return true;
  }

  /** every frame before Nav's update (main.ts): the answer to the seat asked for, and what is within reach */
  update() {
    const nav = this.nav, sim = nav.sim, P = this.pending;
    if (P && sim) {
      const r = sim.results('enterSeat', P.t.role);
      if (r.length) { this.pending = null; if (P.swap) this.swapped(P.t, r); else this.answered(P.t, r); }
      else if (performance.now() - P.at > 3000) this.pending = null;
    }
    this.target = nav.onFoot && !this.pending ? this.find() : null;
  }

  /** what the seat switch's button says, or null: hidden (not in a craft with a gun, or its other seat taken) */
  swapLabel() {
    const to = this.swapTo();
    return to && (to.role === 'passenger' ? 'To the gun' : 'To the wheel');
  }

  /** from the controls of the craft the player is in to its gun, or from the gun back to its free controls (C, the
   * seat switch's button); false: not in such a craft. The host decides; the shell of the seat taken takes over
   * (answered) */
  swap() {
    const to = this.swapTo();
    if (!to) return false;
    const { sim, c, role } = to;
    sim.results('enterSeat', role);
    sim.send({ kind: 'enterSeat', entity: { kind: 'craft', id: c.id }, role });
    this.pending = { t: { ref: { kind: 'craft', id: c.id }, role, label: c.type, craft: c }, at: performance.now(), swap: true };
    return true;
  }

  // the seat a switch would take in the craft the player is in, or null: none
  private swapTo() {
    const nav = this.nav, sim = nav.sim, s = sim?.seat();
    if (!sim || !s || s.entity.kind !== 'craft' || this.pending || !nav.craft) return null;
    const c = sim.crafts().find((q) => q.id === s.entity.id), seats = c && SEATS.craft[c.type];
    if (!c || !seats?.some((q) => q.mount)) return null;
    const role = s.role === 'pilot' ? 'passenger' : s.role === 'passenger' && c.pilot === null ? 'pilot' : null;
    return role && { sim, c, role } as const;
  }

  private canGetOut(key?: BoardKey) {
    const c = this.nav.craft;
    return !!c && (this.nav.craftView || this.nav.mode === 'ride') && c.id !== NOT_BOARDED && !(key === 'KeyE' && E_TAKEN.has(c.id));
  }

  // the seat taken: the vehicle's shell takes over (Nav off foot without leaving the body: the host moved the player
  // already). Not taken: said why, still on foot
  private answered(t: Target, r: CommandResult[]) {
    const nav = this.nav, no = r.find((x) => !x.ok);
    if (!r.some((x) => x.ok)) {
      this.say(no?.reason === 'taken' ? (t.role === 'passenger' ? `No free seat in that ${t.label}` : `Someone is in that ${t.label}`) : no?.reason === 'far' ? `Too far from the ${t.label}`
        : no?.reason === 'moving' ? `That ${t.label} is moving: wait till it stops` : no?.reason === 'loading' ? 'Road physics still loading' : `Cannot get into that ${t.label}`);
      return;
    }
    if (!nav.onFoot) return;
    nav.tookSeat();
    if (t.role === 'passenger') {
      if (t.picked) nav.startRide(t.picked);
      if (!this.passenger()?.ride(t.ref as Target['ref'] & { kind: 'car' | 'craft' }, t.craft?.type ?? 'car', t.label)) nav.flyUp();
    } else if (t.picked) {
      nav.startRide(t.picked);
      this.shells().find((s) => s.id === 'drive')?.enter();
    } else if (t.craft) {
      const c = nav.sim?.crafts().find((q) => q.id === t.craft!.id);
      const shell = c && this.shells().find((s) => s.boards?.includes(c.type));
      if (c && shell) shell.board?.(c);
    }
  }

  // the seat switched to (swap): its shell takes over from the one now on, which leaves no seat (the host moved the
  // player already)
  private swapped(t: Target, r: CommandResult[]) {
    const nav = this.nav, from = nav.craft, c = t.craft;
    if (!r.some((x) => x.ok) || !from || !c) { this.say(t.role === 'passenger' ? 'The gun is taken' : 'Someone is at the controls'); return; }
    if (t.role === 'passenger') this.passenger()?.ride({ kind: 'craft', id: c.id }, c.type, t.label, from);
    else this.shells().find((s) => s.boards?.includes(c.type))?.board?.(c, from);
  }

  // the nearest within reach, the one looked at first
  private find(): Target | null {
    const nav = this.nav, sim = nav.sim, life = nav.life, me = nav.mapPose();
    if (!sim) return null;
    let best: Target | null = null, bs = Infinity;
    const consider = (box: Box, t: Target) => {
      const d = fromBox(me, box);
      if (d > REACH || Math.abs(me.y - box.y) > REACH) return;
      const look = Math.atan2(box.x - me.x, box.z - me.z) - me.h, s = d + 2 * (1 - Math.cos(look));
      if (s < bs) { bs = s; best = t; }
    };
    const driven = new Map(sim.drivers()), aboard = new Map<string, number>();
    for (const [kind, id] of sim.passengers()) aboard.set(`${kind} ${id}`, (aboard.get(`${kind} ${id}`) ?? 0) + 1);
    // (a seat beside another player only while one is free: the snapshot says who holds them, so a full one is not
    // offered to be refused; the host still decides)
    const free = (kind: 'car' | 'craft', id: number, seats: readonly { role: string }[]) =>
      seats.filter((s) => s.role === 'passenger').length > (aboard.get(`${kind} ${id}`) ?? 0);
    for (const { picked, pose, agent } of life?.near('car', me, 20) ?? []) {
      if (agent.kind !== 'car') continue;
      const id = picked.ref.id, by = driven.get(id);
      // (a car another player drives: beside them)
      if (by === sim.player || (by && !free('car', id, SEATS.car[vehicleOf(agent).id]))) continue;
      const shape = carShape(agent);
      consider({ ...pose, r: shape.hx, l: shape.hz }, { ref: { kind: 'car', id }, role: by ? 'passenger' : 'driver', label: picked.label, picked });
    }
    for (const c of sim.crafts()) {
      const p = c.core.pose, flown = c.pilot !== null && c.pilot !== sim.player;
      if (c.type === NOT_BOARDED && (c.pilot !== null || (c.core as { ended?: boolean }).ended)) continue;
      // (one another flies: beside them)
      if (flown ? !this.passenger() || !free('craft', c.id, SEATS.craft[c.type]) : c.pilot !== null || !this.shells().some((s) => s.boards?.includes(c.type))) continue;
      consider(craftBox(c.type, p), { ref: { kind: 'craft', id: c.id }, role: flown ? 'passenger' : 'pilot', label: c.type, craft: c });
    }
    return best;
  }
}
