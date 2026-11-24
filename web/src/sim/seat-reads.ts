// A reader's reads of the events of the seat its player holds (docs/plans/architecture-review.md A7: connection state,
// not the world's): a session's on the world sim's event log (sim/server/sim-server.ts Session), a client's on its copy of
// it (client/sim-client.ts MirrorSimClient). Each reader keeps its own, so two readers of one player each get every
// event. No three.js, no DOM (tools/core-deps.mjs).
import type { SimEvent } from './contract/events';
import type { EntityRef, PlayerId, Seat } from './contract/ids';

/** a seat's key (the seat table's: sim/world-sim.ts) */
export const seatKey = (s: Seat) => `${s.entity.kind}:${s.entity.id}:${s.role}:${s.index}`;

const same = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;

/** a reader's reads of the events of the seat its player holds (craftEvents, driverNotes), each since the last call:
 * from the tick they took it (its seated event; not yet in the log: from now), the entity's events of a kind */
export class SeatReads {
  // by kind: the seat read and the tick read up to
  private readonly read = new Map<string, { seat: string; tick: number }>();

  take<K extends 'craft' | 'drive'>(log: readonly SimEvent[], player: PlayerId, seat: Seat | null, kind: K, now: number) {
    const out: Extract<SimEvent, { kind: K }>[] = [];
    if (!seat) { this.read.delete(kind); return out; }
    const key = seatKey(seat);
    let r = this.read.get(kind);
    if (!r || r.seat !== key) {
      let from = now;
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (e.kind === 'seated' && e.player === player && seatKey(e.seat) === key) { from = e.tick - 1; break; }
      }
      this.read.set(kind, r = { seat: key, tick: from });
    }
    for (const e of log) if (e.tick > r.tick && e.kind === kind && same((e as { entity: EntityRef }).entity, seat.entity)) out.push(e as Extract<SimEvent, { kind: K }>);
    r.tick = now;
    return out;
  }
}
