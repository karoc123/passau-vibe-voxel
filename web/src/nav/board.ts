import type { CraftView } from '../client/sim-client';
import type { CommandResult } from '../sim/contract/commands';
import type { EntityRef, Role } from '../sim/contract/ids';
import { craftBox } from '../sim/solids';
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
// keys leave E free.

// m from its sides: a step inside the host's Tuning.walk.board, so a walk the host has not yet taken is no refusal
const REACH = 3;
// the shells whose own keys have E (fpv.ts, special-craft.ts)
const E_TAKEN = new Set(['fpv', 'helicopter', 'hovercraft', 'paraglider']);
const NOT_BOARDED = 'paraglider';
// the crafts with passengers' seats (the host's SEATS)
const ALONG = new Set(['hovercraft', 'helicopter']);

/** what is within reach: its entity, the seat's role, what to call it, and what its shell takes over from */
export interface Target { ref: EntityRef; role: Role; label: string; picked?: Picked; craft?: CraftView }

export class Boarding {
  /** what E gets into now (on foot), or null */
  target: Target | null = null;
  // the seat asked for and when (performance.now): its answer awaited
  private pending: { t: Target; at: number } | null = null;

  constructor(private readonly nav: Nav, private readonly shells: () => readonly PlayerCraft[], private readonly say: (s: string) => void,
    private readonly passenger: () => PassengerMode | null) {
    // (before Nav's own: on foot E is also a look key, and a craft's keys must not see the E that left it)
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyE' || !gameKey(e) || e.repeat || !this.press(true)) return;
      e.preventDefault();
      e.stopPropagation();
    }, { capture: true });
  }

  /** what the button says, or null: hidden. key: on a keyboard */
  label(key: boolean) {
    const t = this.target, along = t?.role === 'passenger';
    if (this.nav.onFoot) return t ? `${key ? 'E: ' : ''}${along ? (key ? 'ride' : 'Ride') + ' along in' : (key ? 'get' : 'Get') + ' in'} ${t.label}` : this.pending ? 'Getting in…' : null;
    return !this.canGetOut(false) ? null : key && this.canGetOut(true) ? 'E: get out' : 'Get out';
  }

  /** E or the button: in (on foot), or out; false: neither */
  press(key = false) {
    const nav = this.nav, sim = nav.sim;
    if (!nav.onFoot) return this.canGetOut(key) && nav.getOut();
    const t = this.target;
    if (!t || !sim || this.pending) return false;
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
      if (r.length) { this.pending = null; this.answered(P.t, r); }
      else if (performance.now() - P.at > 3000) this.pending = null;
    }
    this.target = nav.onFoot && !this.pending ? this.find() : null;
  }

  private canGetOut(key: boolean) {
    const c = this.nav.craft;
    return !!c && (this.nav.craftView || this.nav.mode === 'ride') && c.id !== NOT_BOARDED && !(key && E_TAKEN.has(c.id));
  }

  // the seat taken: the vehicle's shell takes over (Nav off foot without leaving the body: the host moved the player
  // already). Not taken: said why, still on foot
  private answered(t: Target, r: CommandResult[]) {
    const nav = this.nav, no = r.find((x) => !x.ok);
    if (!r.some((x) => x.ok)) {
      this.say(no?.reason === 'taken' ? (t.role === 'passenger' ? `No free seat in that ${t.label}` : `Someone is in that ${t.label}`) : no?.reason === 'far' ? `Too far from the ${t.label}`
        : no?.reason === 'loading' ? 'Road physics still loading' : `Cannot get into that ${t.label}`);
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
    const driven = new Map(sim.drivers());
    for (const { picked, pose, agent } of life?.near('car', me, 20) ?? []) {
      if (agent.kind !== 'car') continue;
      const id = picked.ref.id, by = driven.get(id);
      // (a car another player drives: beside them; the host says whether a seat is free)
      if (by === sim.player) continue;
      consider({ ...pose, r: 0.9, l: agent.len / 2 }, { ref: { kind: 'car', id }, role: by ? 'passenger' : 'driver', label: picked.label, picked });
    }
    for (const c of sim.crafts()) {
      const p = c.core.pose, flown = c.pilot !== null && c.pilot !== sim.player;
      if (c.type === NOT_BOARDED) continue;
      // (one another flies: beside them, where the host says whether a seat is free)
      if (flown ? !this.passenger() || !ALONG.has(c.type) : c.pilot !== null || !this.shells().some((s) => s.boards?.includes(c.type))) continue;
      consider(craftBox(c.type, p), { ref: { kind: 'craft', id: c.id }, role: flown ? 'passenger' : 'pilot', label: c.type, craft: c });
    }
    return best;
  }
}
