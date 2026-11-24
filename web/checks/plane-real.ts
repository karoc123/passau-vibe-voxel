import { Vector3 } from 'three';
import type { Meta } from '../src/core/meta';
import { collisionWorld, PlaneFlight, type PlaneConfig, type PlaneEvent, type PlaneInput, type PlaneWorld } from '../src/sim/craft/plane-flight';
import { waterTop } from '../src/sim/river';
import type { Check } from './check';
import { holdPath } from './plane-checks';
import { jetHold } from './jet-checks';
import { VoxelCollision } from '../src/sim/craft/voxel-collision';
import { fetchedCollision } from './world';
import { TileCache } from '../src/core/tile-cache';
import { liveEdits } from '../src/core/live-edits';
import { fetchGzip } from '../src/fetch';

// The plane on the real data (web/tools/plane.mjs, which serves the node files from public/data/tiles to fetch): the
// real VoxelCollision with the plane's radius and horizon, its water (waterColumn) as the viewer reads it. The Danube's line is
// found in the voxels' water (no other data); a simple follower (what a pilot's hands would do) flies it.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (v: number) => Math.round(v * 10) / 10;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

async function known<T>(col: VoxelCollision, x: number, z: number, read: () => T | null) {
  for (let i = 0; i < 4000; i++) {
    const v = read();
    if (v !== null) return v;
    col.prefetch(new Vector3(x, 0, z), new Vector3(), true);
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
      col.prefetch(f.p, f.velocity(vel), true);
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

// the Danube from the west edge (where it enters at z ~260..550) to the Altstadt's Ort (x ~7900), found once
let danubeLine: ReturnType<typeof riverLine> | null = null;
function danube(col: VoxelCollision) {
  if (!danubeLine) {
    const t0 = performance.now();
    danubeLine = riverLine(col, 100, 7900, 200, 700);
    danubeLine.then((line) => console.log(`(the Danube's line: ${line.length} points in ${Math.round(performance.now() - t0)} ms)`));
  }
  return danubeLine;
}

export async function runRealChecks(meta: Meta, c: PlaneConfig): Promise<Check[]> {
  const out: Check[] = [];
  const col = fetchedCollision(meta, { radius: c.RADIUS, horizon: c.HORIZON });
  try {
    const w = collisionWorld(col, meta.H);
    const line = await danube(col);
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
  } finally {
    col.release();
  }
}

// The jet on the real data: low and fast along the Danube from the west edge to the Altstadt, then over the Altstadt's
// roofs towards the Inn (the follower banks and pulls as a pilot would, at most 70 deg; it keeps EYE m over what lies
// ahead). The collision's prefetch runs as in the viewer (a new wish every 160 ms of flight, loads started every step),
// and every node file arrives LATENCY s of flight after it was asked for (a slow connection; the files on disk would
// come at once), so `waitsUnderWay` counts the steps a tile was not in when the jet got there: with HORIZON long enough
// for the speed, none once under way.
const LATENCY = 1;
export async function runJetRealChecks(meta: Meta, c: PlaneConfig): Promise<Check[]> {
  const out: Check[] = [];
  let t = 0;
  // (each file due LATENCY after it was asked for, in flight time; the flight waits for a due file still being read,
  // so the run does not depend on the machine's speed)
  const due: { at: number; file: ArrayBuffer | null; go: (b: ArrayBuffer) => void }[] = [];
  const slow = new TileCache({ N: meta.tiles.N, edits: liveEdits, load: (path) => new Promise<ArrayBuffer>((go) => {
    const d = { at: t + LATENCY, file: null as ArrayBuffer | null, go };
    due.push(d);
    fetchGzip(`data/tiles/${path}`).then((b) => { d.file = b; });
  }) });
  const col = new VoxelCollision(meta, slow, () => performance.now(), { radius: c.RADIUS, horizon: c.HORIZON });
  try {
    const w = collisionWorld(col, meta.H);
    const riverCollision = fetchedCollision(meta, { radius: c.RADIUS });
    const line = await danube(riverCollision).finally(() => riverCollision.release());
    if (line.length < 40) return [{ name: 'jet_city', pass: false, detail: { points: line.length } }];
    // the route: the river's line, then on east over the Altstadt (x 7900..8700, its middle z ~ the Ort's)
    const end = line[line.length - 1];
    const route = [...line.map((q) => ({ x: q.x, z: q.z })), { x: end.x + 400, z: end.z + 60 }, { x: end.x + 800, z: end.z + 120 }];
    const p0 = line[0], EYE = 70;
    const f = new PlaneFlight(c);
    const release = async () => {
      while (due.some((d) => d.at <= t && !d.file)) await sleep(1);
      for (let i = due.length - 1; i >= 0; i--) if (due[i].at <= t) { const d = due.splice(i, 1)[0]; d.go(d.file!); }
      await sleep(0); // (the released files decoded into tiles)
    };
    for (let i = 0; i < 4000 && !col.surface(p0.x, p0.z); i++) { col.prefetch(new Vector3(p0.x, 0, p0.z), new Vector3(), true); t += 0.01; await release(); }
    f.reset({ x: p0.x, y: p0.water + EYE, z: p0.z, heading: Math.atan2(line[3].x - p0.x, line[3].z - p0.z), speed: 110 });
    f.engine = 0.9;
    const vel = new Vector3();
    t = 0;
    let nextPrefetch = 0, waits = 0, waitsUnderWay = 0, minClear = Infinity, maxKmh = 0, sumKmh = 0, n = 0, maxBank = 0;
    let crash: { what: string; kmh: number } | undefined;
    const ahead = (d: number) => {
      let top = -Infinity;
      for (let s = 0; s <= d; s += 25) {
        const su = w.surface(f.p.x + Math.sin(f.heading) * s, f.p.z + Math.cos(f.heading) * s);
        if (su) top = Math.max(top, su.top);
      }
      return top;
    };
    const xEnd = end.x + 800;
    while (t < 200 && f.p.x < xEnd) {
      // (a new wish every 160 ms of flight, as the viewer's frames make it; loads started every step, as every frame)
      const refresh = t >= nextPrefetch;
      if (refresh) nextPrefetch = t + 0.16;
      col.prefetch(f.p, f.velocity(vel), refresh);
      let k = route.findIndex((q) => q.x > f.p.x + 450);
      if (k < 0) k = route.length - 1;
      const q = route[k], err = wrap(Math.atan2(q.x - f.p.x, q.z - f.p.z) - f.heading);
      const bank = Math.max(-70, Math.min(70, -err * 180 / Math.PI * 2.5)) * Math.PI / 180;
      const want = Math.max(ahead(400), f.p.x < end.x ? line[Math.max(0, line.findIndex((l) => l.x >= f.p.x))].water : 0) + EYE;
      const inp = jetHold(f, bank, Math.max(-0.2, Math.min(0.25, (want - f.p.y) * 0.01)), 0.9);
      if (due.length) await release();
      if (!f.step(inp, c.STEP, w)) {
        // (the flight holds, the clock goes on: as the viewer, which waits frames for the tile)
        waits++;
        if (t > 1) waitsUnderWay++;
        t += c.STEP;
        continue;
      }
      t += c.STEP;
      for (const e of f.events.splice(0)) if (e.type === 'crash') crash ??= e;
      if (crash) break;
      const su = w.surface(f.p.x, f.p.z);
      if (su) minClear = Math.min(minClear, f.p.y - c.RADIUS - su.top);
      maxKmh = Math.max(maxKmh, f.v * 3.6); sumKmh += f.v * 3.6; n++; maxBank = Math.max(maxBank, Math.abs(f.bank));
    }
    out.push({ name: 'jet_city', pass: !crash && f.p.x >= xEnd - 1 && waitsUnderWay === 0,
      detail: { km: r1((f.p.x - p0.x) / 1000), s: Math.round(t), avgKmh: Math.round(sumKmh / Math.max(1, n)), maxKmh: Math.round(maxKmh), maxBank: Math.round(maxBank * 180 / Math.PI),
        minClear: Math.round(minClear), waitsAtStart: waits - waitsUnderWay, waitsUnderWay, horizon: `${c.HORIZON} s`, latency: `${LATENCY} s`, ...(crash ? { crash: crash.what, at: `${Math.round(f.p.x)},${Math.round(f.p.z)}` } : {}) } });
    return out;
  } finally {
    col.release();
  }
}
