import { Vector3 } from 'three';
import type { Meta } from '../types';
import { collisionWorld, PlaneFlight, waterTop, type PlaneConfig, type PlaneEvent, type PlaneInput, type PlaneWorld } from './plane-flight';
import { holdPath, type Check } from './plane-checks';
import { VoxelCollision } from './voxel-collision';

// The plane on the real data (web/tools/plane.mjs, which serves the node files from public/data/tiles to fetch): the
// real VoxelCollision with the plane's radius and horizon, its water (waterColumn) as the viewer reads it. The Danube's line is
// found in the voxels' water (no other data); a simple follower (what a pilot's hands would do) flies it.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (v: number) => Math.round(v * 10) / 10;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// the collision's prefetch, not held to its 160 ms between new wishes (in the viewer a frame's worth of flight; here
// the steps run far faster than real time)
const prefetch = (col: VoxelCollision, p: Vector3, v: Vector3) => { (col as unknown as { nextPrefetch: number }).nextPrefetch = 0; col.prefetch(p, v); };

async function known<T>(col: VoxelCollision, x: number, z: number, read: () => T | null) {
  for (let i = 0; i < 4000; i++) {
    const v = read();
    if (v !== null) return v;
    prefetch(col, new Vector3(x, 0, z), new Vector3());
    await sleep(2);
  }
  throw new Error(`collision tiles never loaded at ${x}, ${z}`);
}

// the river's middle across x (every `step` m): per x the run of water columns along z nearest the last one (at least
// `minWidth` wide), its middle and its water's top; from x0 (searching z0..z1 there) while it goes on
export async function riverLine(col: VoxelCollision, x0: number, x1: number, z0: number, z1: number, step = 48, minWidth = 60) {
  const line: { x: number; z: number; water: number; width: number }[] = [];
  let lo = z0, hi = z1, last = (z0 + z1) / 2;
  for (let x = x0; x <= x1; x += step) {
    const runs: { a: number; b: number; w: number }[] = [];
    let a = -1, w = -1;
    for (let z = Math.max(0, lo); z <= Math.min(col.depth - 1, hi); z += 3) {
      const wl = await known(col, x, z, () => waterTop(col, x, z));
      if (wl >= 0) { if (a < 0) { a = z; w = wl; } } else if (a >= 0) { runs.push({ a, b: z - 3, w }); a = -1; }
    }
    if (a >= 0) runs.push({ a, b: Math.min(col.depth - 1, hi), w });
    const wide = runs.filter((r) => r.b - r.a >= minWidth);
    if (!wide.length) break;
    const r = wide.reduce((p, q) => (Math.abs((q.a + q.b) / 2 - last) < Math.abs((p.a + p.b) / 2 - last) ? q : p));
    last = (r.a + r.b) / 2;
    line.push({ x, z: last, water: r.w, width: r.b - r.a });
    lo = last - 300; hi = last + 300;
  }
  return line;
}

// steps the flight in real time's stead: waits (prefetching) where a tile is not in
async function run(f: PlaneFlight, w: PlaneWorld, col: VoxelCollision, secs: number, input: (f: PlaneFlight, t: number) => PlaneInput,
  stop: (f: PlaneFlight, e: PlaneEvent[]) => boolean) {
  const events: PlaneEvent[] = [];
  let waits = 0, t = 0, minClear = Infinity;
  const vel = new Vector3();
  while (t < secs) {
    if (!f.step(input(f, t), f.cfg.STEP, w)) {
      prefetch(col, f.p, f.velocity(vel));
      if (++waits > 20000) throw new Error('collision tiles never loaded');
      await sleep(1);
      continue;
    }
    t += f.cfg.STEP;
    events.push(...f.events.splice(0));
    const s = f.state === 'air' ? w.surface(f.p.x, f.p.z) : null;
    if (s) minClear = Math.min(minClear, f.p.y - f.cfg.RADIUS - s.top);
    if (stop(f, events)) break;
  }
  return { events, waits, t, minClear };
}

// steer at the line's point `ahead` m on; the line given as [x, z]
function follow(line: { x: number; z: number }[], f: PlaneFlight, ahead: number) {
  let k = line.findIndex((q) => q.x > f.p.x + ahead);
  if (k < 0) k = line.length - 1;
  const q = line[k], want = Math.atan2(q.x - f.p.x, q.z - f.p.z);
  return Math.max(-1, Math.min(1, -wrap(want - f.heading) * 2.5));
}

export async function runRealChecks(meta: Meta, c: PlaneConfig): Promise<Check[]> {
  const out: Check[] = [];
  const col = new VoxelCollision(meta, undefined, { radius: c.RADIUS, horizon: c.HORIZON });
  const w = collisionWorld(col, meta.H);
  // the Danube from the west edge (where it enters at z ~260..550) to the Altstadt's Ort (x ~7900)
  const t0 = performance.now();
  const line = await riverLine(col, 100, 7900, 200, 700);
  console.log(`(the Danube's line: ${line.length} points in ${Math.round(performance.now() - t0)} ms)`);
  const end = line[line.length - 1];
  if (line.length < 40) {
    out.push({ name: 'danube_line', pass: false, detail: { points: line.length, endX: end?.x } });
    return out;
  }

  // danube_flight: 60 m over the water, the follower steering, 60 % throttle: no crash, the whole way
  {
    const f = new PlaneFlight(c), p0 = line[0];
    f.reset({ x: p0.x, y: p0.water + 60, z: p0.z, heading: Math.atan2(line[3].x - p0.x, line[3].z - p0.z), speed: 45 });
    f.engine = 0.6;
    let off = 0;
    const r = await run(f, w, col, 600, (g) => {
      const k = line.findIndex((q) => q.x >= g.p.x), q = line[Math.max(0, k)];
      off = Math.max(off, Math.abs(g.p.z - q.z));
      const gt = Math.max(-0.12, Math.min(0.12, (q.water + 60 - g.p.y) * 0.02));
      return { turn: follow(line, g, 250), pitch: holdPath(g, gt), throttle: 0.6 };
    }, (g, e) => g.p.x >= end.x - 50 || e.some((x) => x.type === 'crash'));
    const crash = r.events.find((x) => x.type === 'crash') as { what: string; kmh: number } | undefined;
    out.push({ name: 'danube_flight', pass: !crash && f.p.x >= end.x - 50, detail: { fromX: p0.x, toX: Math.round(f.p.x), km: r1((f.p.x - p0.x) / 1000), s: Math.round(r.t),
      maxOffMiddle: Math.round(off), minClear: Math.round(r.minClear), waits: r.waits, ...(crash ? { crash: crash.what, at: `${Math.round(f.p.x)},${Math.round(f.p.z)}` } : {}) } });
  }

  // danube_water: on the straightest wide 1.5 km of the line (not over a weir: one water level), a 1.5 m/s descent
  // at ~110 km/h onto the river, a taxi turn and back, a takeoff run with the stick pulled past the takeoff speed
  {
    let best = -1, bestTurn = Infinity;
    for (let i = 0; i + 32 < line.length; i++) {
      const seg = line.slice(i, i + 32);
      if (seg.some((q) => q.width < 150 || q.water !== seg[0].water)) continue;
      let turn = 0;
      for (let k = 2; k < seg.length; k++) {
        const a = Math.atan2(seg[k - 1].x - seg[k - 2].x, seg[k - 1].z - seg[k - 2].z), b = Math.atan2(seg[k].x - seg[k - 1].x, seg[k].z - seg[k - 1].z);
        turn += Math.abs(wrap(b - a));
      }
      if (turn < bestTurn) { bestTurn = turn; best = i; }
    }
    if (best < 0) { out.push({ name: 'danube_water', pass: false, detail: { why: 'no wide straight stretch found' } }); return out; }
    const seg = line.slice(best, best + 32), s0 = seg[0], wl = s0.water;
    const f = new PlaneFlight(c);
    f.reset({ x: s0.x, y: wl + 30, z: s0.z, heading: Math.atan2(seg[4].x - s0.x, seg[4].z - s0.z), speed: 32 });
    f.engine = 0.2;
    const land = await run(f, w, col, 60, (g) => ({ turn: follow(seg, g, 150), pitch: holdPath(g, Math.asin(-1.5 / g.v)), throttle: 0.2 }),
      (g) => g.state !== 'air');
    const landed = f.state === 'water' && land.events.some((e) => e.type === 'touchdown');
    const touchX = f.p.x, h0 = f.heading;
    // taxi: stop, turn a while, then back along the river (the follower's heading)
    let turned = 0;
    const taxi = await run(f, w, col, 20, (g, t) => {
      turned = Math.max(turned, Math.round(Math.abs(wrap(g.heading - h0)) * 180 / Math.PI));
      return { turn: t < 8 ? 0 : t < 13 ? 1 : follow(seg, g, 150), pitch: 0, throttle: t < 8 ? 0 : 0.1 };
    }, () => false);
    const afloat = f.state === 'water';
    const off = await run(f, w, col, 60, (g) => ({ turn: follow(seg, g, 200), pitch: g.state === 'water' ? (g.v > c.V_TAKEOFF ? 0.6 : 0) : holdPath(g, 0.12), throttle: 1 }),
      (g, e) => (g.state === 'air' && g.p.y > wl + 40) || e.some((x) => x.type === 'crash'));
    const crash = [...land.events, ...taxi.events, ...off.events].find((x) => x.type === 'crash') as { what: string; kmh: number } | undefined;
    out.push({ name: 'danube_water', pass: landed && afloat && !crash && f.state === 'air' && f.p.y > wl + 40,
      detail: { at: `${Math.round(s0.x)},${Math.round(s0.z)}`, water: wl, touchdownX: Math.round(touchX), taxiTurned: turned, tookOffAndClimbedTo: Math.round(f.p.y - wl),
        bumps: taxi.events.filter((e) => e.type === 'bump').length, ...(crash ? { crash: crash.what, kmh: crash.kmh } : {}) } });
  }
  return out;
}
