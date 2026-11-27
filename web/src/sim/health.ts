// Health and damage: one model for players, every vehicle kind and NPCs. The host's alone: a page is told the
// health its player sees (sim/server/snapshot.ts), never asked. No three.js, no DOM (tools/core-deps.mjs).
import { frozen } from '../core/frozen';
import type { CraftType, PlayerId, VehicleId } from './contract/ids';

export type DamageKind = 'bullet' | 'blast' | 'crash' | 'fall';

/** what has health: a player wherever they are (on foot, at a wheel, along for the ride), a car, a craft, an NPC (by
 * its avatar's id) */
export type Life = { kind: 'player'; id: PlayerId } | { kind: 'car' | 'craft'; id: number } | { kind: 'npc'; id: number };
export const lifeKey = (l: Life) => `${l.kind}:${l.id}`;

/** a type's health as data: max, a factor per damage kind, the share of a vehicle's damage that reaches each of those
 * in it (through), the speed (m/s) a crash or a landing is taken at without harm (safe) */
export interface Toughness {
  readonly max: number;
  readonly take: Readonly<Record<DamageKind, number>>;
  readonly through: number;
  readonly safe: number;
}

/** perMs: points per m/s a crash or a fall is past its safe speed; downMs: how long a player at 0 is down before they
 * are back (a game mode may say otherwise) */
export interface HealthTuning {
  readonly player: Toughness;
  readonly npc: Toughness;
  readonly car: Readonly<Record<VehicleId, Toughness>>;
  readonly craft: Readonly<Record<CraftType, Toughness>>;
  readonly perMs: number;
  readonly downMs: number;
}

const tough = (max: number, bullet: number, blast: number, crash: number, through: number, safe: number): Toughness =>
  frozen({ max, take: frozen({ bullet, blast, crash, fall: crash }), through, safe });

// A player dies from ten MG hits or a grenade at their feet, and a fall from ~4 m is free (a jump off a wall is play).
// A car shrugs off bullets and passes little to those in it; a motorbike's rider and a paraglider's pilot sit in the
// open. A drone's pilot is not in it, and its bumps are its play (it bounces off and flies on): only weapons harm it.
// Crafts' safe speeds sit over what their own laws lose in a tick by flying (a helicopter set down on its skids, a
// jet's hardest turn: ~3 m/s), so only a hit counts.
export const HEALTH: HealthTuning = frozen({
  player: tough(100, 1, 1, 1, 0, 9),
  // (as tough as a player: ten MG hits, a grenade at its feet)
  npc: tough(100, 1, 1, 1, 0, 9),
  car: frozen({
    car: tough(150, 0.4, 1, 1, 0.25, 8), coupe: tough(130, 0.4, 1, 1, 0.25, 8), van: tough(180, 0.4, 1, 1, 0.25, 8),
    pickup: tough(180, 0.4, 1, 1, 0.25, 8), bus: tough(300, 0.3, 0.8, 0.8, 0.15, 8), moto: tough(60, 0.8, 1, 1, 0.8, 7),
    camper: tough(200, 0.4, 1, 1, 0.25, 8),
  }),
  craft: frozen({
    boat: tough(120, 0.5, 1, 1, 0.4, 6), hovercraft: tough(150, 0.5, 1, 1, 0.3, 8), helicopter: tough(150, 0.5, 1, 1, 0.3, 7),
    paraglider: tough(40, 1, 1, 1, 1, 6), drone: tough(30, 1, 1, 0, 0, 8), floatplane: tough(100, 0.6, 1, 1, 0.3, 10),
    jet: tough(120, 0.5, 1, 1, 0.25, 10), fighter: tough(130, 0.5, 1, 1, 0.3, 10),
    gunship: tough(200, 0.4, 1, 1, 0.3, 7),
  }),
  perMs: 5,
  downMs: 5000,
});

/** the lives below their max (one at full health is not held), and the players down */
export class Lives {
  private readonly hurt = new Map<string, { life: Life; hp: number; max: number }>();
  /** the players down, by when (s of the sim's clock) they are back; Infinity: not on their own */
  readonly down = new Map<PlayerId, number>();

  /** life's health (key: lifeKey), undefined: full */
  hp(key: string) { return this.hurt.get(key)?.hp; }

  /** d points off life (max: its type's); its health before and after */
  take(life: Life, max: number, d: number) {
    const k = lifeKey(life), h = this.hurt.get(k), was = h?.hp ?? max, hp = Math.max(0, was - d);
    if (h) h.hp = hp; else this.hurt.set(k, { life, hp, max });
    return { was, hp };
  }

  /** life back to full health (or gone from the world) */
  heal(key: string) { this.hurt.delete(key); }

  /** the lives below their max */
  values() { return this.hurt.values(); }
}
