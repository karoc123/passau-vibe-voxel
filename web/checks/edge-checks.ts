import { Vector3 } from 'three';
import { Built } from '../src/core/built';
import { PLANE, PlaneFlight } from '../src/sim/craft/plane-flight';
import type { Check } from './check';
import { worldOf } from './collision-checks';
import { fly } from './plane-checks';
import { cruise, Sim } from './scenarios';
import { BoxWorld, makeWorld, synthMap, STREET } from './world';

// Headless checks of the map's edge at a block not built (scripts/map.json `blocks`, meta.json `built`, core/built.ts;
// web/tools/edge.mjs): what is built, and that nothing that moves gets into a block not built -- the drone's sweep
// (voxel-collision.ts: a wall, 'city edge'), the boat's water there (blocked), the walker's world (World.inside), the
// car (physics/rapier/terrain.ts: a wall of the block's chunks; it stops at the edge, upright, on the map) and the
// plane (plane-flight.ts: no nearer than EDGE).

export async function runEdgeChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, pass: boolean, detail: Record<string, unknown>) => out.push({ name, pass, detail });

  // what is built: a map of 2 x 2 blocks, block (1, 1) missing, block (0, 1) only its first 384 rows
  {
    const b = new Built({ W: 2048, D: 1800, built: [[0, 0, 1024, 1024], [1024, 0, 2048, 384], [0, 1024, 1024, 1800]] });
    const at = [b.at(10, 10), b.at(1500, 383.9), !b.at(1500, 384), !b.at(1500, 1500), b.at(10, 1799), !b.at(10, 1800), !b.at(-1, 5)];
    const box = [b.any(1000, 1000, 1100, 1100), !b.any(1100, 400, 1200, 500), b.all(0, 0, 1024, 1024), !b.all(1000, 300, 1100, 400),
      b.all(1000, 300, 1100, 384), b.node(128, 8, 2), !b.node(128, 8, 3), !b.node(1024, 1, 1)];
    const whole = new Built({ W: 300, D: 200 });
    const w = [whole.at(299, 199), !whole.at(300, 0), whole.all(0, 0, 300, 200), !whole.all(0, 0, 301, 200)];
    add('edge_built', [...at, ...box, ...w].every(Boolean), { at: at.map(Number).join(''), box: box.map(Number).join(''), whole: w.map(Number).join('') });
  }

  // the drone, the boat's water, the walker: a 256 x 256 m world (a road at 10 m) built in its first 128 rows only
  {
    const w = await makeWorld({ size: [256, 256], ground: () => 10, built: [[0, 0, 256, 128]] });
    try {
      for (let i = 0; i < 2000 && !w.collision.surface(64, 64); i++) {
        w.collision.prefetch(new Vector3(64, 12, 64), new Vector3());
        await new Promise((r) => setTimeout(r, 5));
      }
      const s = w.collision.sweep(new Vector3(64, 12, 100), new Vector3(0, 0, 50));
      const end = s === 'loading' ? NaN : 100 + 50 * s.fraction;
      add('edge_drone', s !== 'loading' && s.hit === 'city edge' && Math.abs(end - (128 - w.collision.radius)) < 1e-6,
        { hit: s === 'loading' ? 'loading' : s.hit, end: Math.round(end * 1000) / 1000 });
      // (high over it too: the wall stands to the ceiling)
      const hi = w.collision.sweep(new Vector3(64, 300, 120), new Vector3(0, 0, 50));
      add('edge_drone_high', hi !== 'loading' && hi.hit === 'city edge', { hit: hi === 'loading' ? 'loading' : hi.hit });
      const wc = w.collision.waterColumn(64, 200, 9, 12);
      add('edge_boat', !!wc && wc.blocked && wc.water === -1 && w.collision.surface(64, 200) === null, { blocked: wc?.blocked ?? null });
      const world = await worldOf(w);
      add('edge_walker', world.inside(64, 127.5) && !world.inside(64, 128.5), { inside: world.inside(64, 127.5), beyond: world.inside(64, 128.5) });
    } finally {
      w.collision.release();
    }
  }

  // the car: a street at 10 m over 128 x 128 m, built in its first 64 rows; driven at 40 km/h south (+z) into the
  // block not built: stopped at its edge, on its wheels, on the map
  {
    const map = synthMap(2, () => ({ g: 10, mat: STREET }));
    map.meta = { ...map.meta, built: [[0, 0, 128, 64]] };
    const sim = new Sim(map, { x: 64, z: 20 }, 0, 0);
    try {
      sim.run(6, cruise(40));
      const p = sim.car.body.translation();
      const maxZ = Math.max(...sim.log.map((q) => q.z)), minY = Math.min(...sim.log.map((q) => q.y));
      add('edge_car', maxZ < 64 && maxZ > 55 && minY > 9 && sim.log[sim.log.length - 1].up > 0.9,
        { maxZ: Math.round(maxZ * 10) / 10, minY: Math.round(minY * 10) / 10, z: Math.round(p.z * 10) / 10 });
    } finally {
      sim.dispose();
    }
  }

  // the plane: full throttle south at 300 m towards a block not built (from z = 2000 of a 6000 x 3000 m world): it keeps
  // EDGE from it, slides along, never crashes
  {
    const c = PLANE, w = new BoxWorld(6000, 3000, 173, 10, c.RADIUS);
    const built = new Built({ W: 6000, D: 3000, built: [[0, 0, 1024, 1024], [1024, 0, 2048, 1024], [2048, 0, 3072, 1024], [3072, 0, 4096, 1024],
      [4096, 0, 5120, 1024], [5120, 0, 6000, 1024], [0, 1024, 1024, 2048], [1024, 1024, 2048, 2048], [2048, 1024, 3072, 2048],
      [3072, 1024, 4096, 2048], [4096, 1024, 5120, 2048], [5120, 1024, 6000, 2048], [0, 2048, 1024, 3000], [2048, 2048, 3072, 3000]] });
    const pw = Object.assign(w, { built: (x0: number, z0: number, x1: number, z1: number) => built.all(x0, z0, x1, z1) });
    const f = new PlaneFlight(c);
    f.reset({ x: 1500, y: 300, z: 1500, heading: 0, speed: 60 });
    f.engine = 1;
    let maxZ = 0, edge = false;
    const r = fly(f, pw, 15, () => ({ turn: 0, pitch: 0, throttle: 1 }), (fl) => { maxZ = Math.max(maxZ, fl.p.z); edge ||= fl.atEdge; return false; });
    const crashes = r.events.filter((e) => e.type === 'crash').length;
    add('edge_plane', maxZ <= 2048 - c.EDGE + 1e-6 && edge && !crashes, { maxZ: Math.round(maxZ * 10) / 10, wall: `${c.EDGE} m out`, crashes });
  }
  return out;
}
