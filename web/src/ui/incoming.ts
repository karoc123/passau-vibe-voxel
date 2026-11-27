import { el } from '../util';
import { bearing, type Incoming } from '../client/incoming';

// ms an arc stays: a hit's long enough to turn towards it, a near miss's short (a burst keeps it lit)
const HIT_MS = 2500, NEAR_MS = 900;
// arcs at once: one per shooter, the oldest given up
const ARCS = 6;

interface Arc { e: HTMLElement; by: string; from: { x: number; z: number }; at: number; hit: boolean }

/** where the player is fired on from: an arc on a ring round the screen's middle towards each shooter, red for a hit,
 * pale and thin for a shot passing close; it turns with the view and fades */
export function makeIncomingHud() {
  const box = el('div', '');
  box.id = 'incoming';
  const arcs: Arc[] = [];
  for (let i = 0; i < ARCS; i++) arcs.push({ e: el('i', '', '', box), by: '', from: { x: 0, z: 0 }, at: -1e9, hit: false });
  const ms = (a: Arc) => (a.hit ? HIT_MS : NEAR_MS);
  return {
    /** fire i met or passed the player at now (ms) */
    add(i: Incoming, now: number) {
      let a = arcs.find((a) => a.by === i.by && now - a.at < ms(a));
      // (a near miss does not pale the arc of a hit still shown: it only follows the shooter)
      if (a?.hit && !i.hit) { a.from = i.from; return; }
      a ??= arcs.reduce((o, a) => (a.at < o.at ? a : o));
      Object.assign(a, { by: i.by, from: i.from, at: now, hit: i.hit });
      a.e.classList.toggle('hit', i.hit);
    },
    /** drawn for a view at eye looking along heading h, at now (ms) */
    show(eye: { x: number; z: number }, h: number, now: number) {
      for (const a of arcs) {
        const k = Math.max(0, 1 - (now - a.at) / ms(a)), o = k > 0 ? Math.min(1, 2 * k).toFixed(2) : '0';
        if (a.e.style.opacity !== o) a.e.style.opacity = o;
        if (k > 0) a.e.style.transform = `translate(-50%, -50%) rotate(${bearing(a.from, eye, h).toFixed(3)}rad)`;
      }
    },
  };
}
