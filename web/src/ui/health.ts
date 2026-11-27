import { el } from '../util';

/** a health as the HUD shows it: points and max (null: full, or not known) */
type Shown = { hp: number; max: number } | null;

/** the player's own health and the vehicle's they are in, small, over the weapon slots; a hit to either flashes the
 * crash tint (hit() is how hard, 0..1, for the camera's shake) */
export function makeHealthHud() {
  const box = el('div', '');
  box.id = 'health';
  const row = () => {
    const r = el('div', 'row', '<span class="name"></span><span class="bar"><i></i></span><span class="n"></span>', box);
    return { r, name: r.querySelector('.name') as HTMLElement, fill: r.querySelector('i') as HTMLElement, n: r.querySelector('.n') as HTMLElement, f: -1 };
  };
  const me = row(), it = row();
  me.name.textContent = 'You';
  const tint = el('div', '');
  tint.id = 'health-tint';
  let last: [number, number] = [1, 1], lastKey = '', hitAt = -1e9, hard = 0;
  const show = (R: ReturnType<typeof row>, h: Shown) => {
    const f = h ? h.hp / h.max : 1;
    // (written only when it changes: the HUD is set every frame)
    if (f === R.f) return f;
    R.f = f;
    R.fill.style.width = `${Math.round(100 * f)}%`;
    R.r.classList.toggle('low', f < 0.3);
    R.n.textContent = String(Math.round(100 * f));
    return f;
  };
  return {
    /** own: the player's health; vehicle: the one of what they are in (key: which, name: its kind; null: on foot);
     * now: ms */
    set(own: Shown, vehicle: { key: string; name: string; h: Shown } | null, now: number) {
      const a = show(me, own), b = vehicle ? show(it, vehicle.h) : 1;
      if ((vehicle?.key ?? '') !== lastKey) { lastKey = vehicle?.key ?? ''; last[1] = b; }
      it.r.hidden = !vehicle;
      if (vehicle) it.name.textContent = vehicle.name;
      box.classList.toggle('down', !!own && own.hp === 0);
      // (a fall of either is a hit; a new vehicle is not)
      const lost = Math.max(last[0] - a, vehicle ? last[1] - b : 0);
      if (lost > 0.001) { hitAt = now; hard = Math.min(1, 0.3 + 4 * lost); }
      last = [a, vehicle ? b : 1];
      const k = Math.max(0, 1 - (now - hitAt) / HIT_MS);
      const o = String(0.7 * hard * k);
      if (tint.style.opacity !== o) tint.style.opacity = o;
      return hard * k * k;
    },
  };
}
// how long a hit's tint and shake last (ms)
const HIT_MS = 450;
