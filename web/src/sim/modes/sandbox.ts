// The sandbox: the viewer's behaviour as a mode. Every request granted as
// asked (a craft made where the client's shell found a spot, the player its pilot; put down again, reset, dropped; a
// car reset; the world's time of day set: the hour bar), every seat may be taken, edits to the world's voxels only
// when the host was started with them (?dig=1). No three.js, no DOM (tools/core-deps.mjs).
import type { ModeRequest } from '../contract/commands';
import type { PlayerId } from '../contract/ids';
import type { GameMode, ModeWorld } from '../mode';

export function sandbox(opts: { edits?: boolean } = {}): GameMode {
  const edits = !!opts.edits;
  return {
    id: 'sandbox',
    mayEnter: () => true,
    mayEdit: () => edits,
    request(w: ModeWorld, player: PlayerId, r: ModeRequest) {
      switch (r.kind) {
        case 'craft': {
          try {
            const c = w.addCraft(r.type);
            const ok = w.sit(player, { entity: { kind: 'craft', id: c.id }, role: 'pilot', index: 0 });
            if (ok) w.placeCraft(c.id, r.spot); else w.removeCraft(c.id);
            return ok;
          } catch (e) { console.warn('craft', e); return false; }
        }
        case 'placeCraft': {
          const c = w.craftOf(player);
          if (c) w.placeCraft(c.id, r.spot);
          return !!c;
        }
        case 'resetCraft': { const c = w.craftOf(player); return !!c?.placed && !!c.core.unstick?.(c.collision); }
        case 'resetDriver': return w.resetDriver(player);
        case 'dropCraft': { const c = w.craftOf(player); if (c) w.removeCraft(c.id); return !!c; }
        case 'setTime': w.setTime(r.hour, r.day); return true;
      }
    },
  };
}
