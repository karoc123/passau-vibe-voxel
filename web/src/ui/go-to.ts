import * as THREE from 'three';
import type { Facts, Label, Meta, View } from '../core/meta';
import type { World } from '../core/world';
import type { Labels } from '../labels';
import type { Nav } from '../nav/nav';
import type { SearchItem } from '../search';
import type { Kind } from '../sim/types';
import type { Place } from '../types';
import { ease } from '../util';

// a bridge searched or clicked: walked to on its deck, not under it (a label of kind bridge/footbridge, a place of kind
// bridge, or a street over one: Passau's are named …brücke / …steg); nav's setWalk lands on a deck only if there is one
const onBridge = (kind: string, name: string) => /^(foot)?bridge$/.test(kind) || (kind === 'street' && /(brücke|steg)$/i.test(name));

// Go-to: the map's fly-to (stepped each frame), a place or view searched or a label clicked framed (or walked to at
// street level), and the search's items
export function makeGoTo({ camera, target, nav, world, labels, views, follow }: {
  camera: THREE.PerspectiveCamera; target: THREE.Vector3; nav: Nav;
  world: () => World | null; labels: () => Labels | null; views: () => Record<string, View>;
  follow: (kind: Kind) => void; // (the nearest moving one ridden)
}) {
  let fly: ((now: number) => void) | null = null;

  function flyTo(v: Pick<View, 'pos' | 'target' | 'ms'>) {
    const p0 = camera.position.clone(), q0 = target.clone(), t0 = performance.now();
    const p1 = new THREE.Vector3(...v.pos), q1 = new THREE.Vector3(...v.target);
    fly = (now) => {
      const t = Math.min(1, (now - t0) / (v.ms ?? 1600)), e = ease(t);
      camera.position.lerpVectors(p0, p1, e);
      target.lerpVectors(q0, q1, e);
      if (t >= 1) fly = null;
    };
  }

  // frame a place from the current compass direction, ~30° down, with a label on it; at street level, walk there
  function goPlace(x: number, y: number, size: number, pin: Facts | null, name = pin?.name ?? '', kind = pin?.kind ?? '') {
    const w = world();
    if (!w) return;
    if (nav.craftView) nav.setOrbit();
    const g = w.groundAt(x, y), top = w.top(Math.floor(x), Math.floor(y)), h = Math.max(0, top - g);
    labels()?.pin(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
    if (!nav.onMap) {
      nav.setWalk({ at: new THREE.Vector3(x + 0.5, g, y + 0.5), deckOK: onBridge(kind, name) });
      return;
    }
    const t = new THREE.Vector3(x + 0.5, g + Math.min(h * 0.5, 60), y + 0.5);
    const dist = Math.min(800, Math.max(170, size * 1.6 + h * 1.8));
    const az = Math.atan2(camera.position.x - target.x, camera.position.z - target.z), el = 0.52;
    const pos = t.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
    flyTo({ pos: pos.toArray(), target: t.toArray() });
  }

  function goView(v: View) {
    nav.setOrbit();
    labels()?.pin(null);
    flyTo(v);
  }

  // the search's items: the views, the map's labels, the follow actions, then the places (places.json) once loaded
  function searchItems(meta: Meta, places: Place[] = []): SearchItem[] {
    return [
      ...Object.values(meta.views).map((v) => ({ name: v.label, kind: 'viewpoint', featured: true, go: () => goView(v) })),
      ...meta.labels.map((l) => ({ name: l.name, alt: [l.en, l.alt].join(' '), kind: l.kind, go: () => goPlace(l.x, l.y, Math.max(40, (l.R ?? 20) * 1.4), null, l.name, l.kind) })),
      { name: 'Follow a car', alt: 'car bus Auto ride follow', kind: 'action', go: () => follow('car') },
      { name: 'Follow someone', alt: 'person people pedestrian Fußgänger walk with follow', kind: 'action', go: () => follow('person') },
      ...places.map(([name, kind, x, y, size, alt]) => ({ name, alt, kind, go: () => goPlace(x, y, size, { name, kind }) })),
    ];
  }

  return {
    flyTo, goPlace, goView, searchItems,
    step: (now: number) => fly?.(now),
    cancel: () => { fly = null; },
    // a label clicked: its view from the map, else the place
    onLabel(l: Label) {
      const v = Object.values(views()).find((w) => w.label === l.name);
      if (v && nav.onMap) goView(v);
      else goPlace(l.x, l.y, 60, null, l.name, l.kind);
    },
  };
}
