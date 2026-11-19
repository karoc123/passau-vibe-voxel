// Rapier spike: the P key that loads it (demo.ts and Rapier itself, ~1.7 MB gzip) only when pressed. main.ts imports
// this small module only with ?physics=rapier.
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type * as THREE from 'three';
import type { Meta } from '../../types';
import type { RapierDemo } from './demo';

export function onKeyP(ctx: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; meta: Meta }, ready: (d: RapierDemo) => void) {
  const onP = (e: KeyboardEvent) => {
    if (e.code !== 'KeyP' || (e.target as Element).closest?.('input, textarea')) return;
    removeEventListener('keydown', onP);
    const t0 = performance.now();
    import('./demo').then((m) => m.startRapier(ctx)).then((d) => {
      d.stats.loadMs = performance.now() - t0; // (the chunk's download and compile, and init)
      ready(d);
      d.toggleCar();
    });
  };
  addEventListener('keydown', onP);
}
