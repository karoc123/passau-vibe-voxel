import { Vector3 } from 'three';
import type { Meta } from '../src/types';
import { BOAT, BoatMotion, findSpawn, type BoatInput, type BoatWorld } from '../src/nav/boat-motion';
import { downstream, nearestRiver } from '../src/nav/river';
import { makeWorld, type CheckOutcome } from './collision-checks';
import type { VoxelCollision } from '../src/nav/voxel-collision';

// Headless checks of the player's boat (boat-motion.ts; web/tools/boat.mjs). On a synthetic world written as real node
// files (collision-checks.ts makeWorld) and read by the real VoxelCollision: a channel of water at 4 m (x 16..240,
// z 40..216) in land at 8 m, a bridge with its deck 6 m over the water (x 170..180) and one only 1 m over it (x 60..64,
// z 40..80, a footbridge too low), a pier in the water (x 120..124, z 150..156). Then on the real data (runRealChecks,
// tools/boat.mjs gives it the tiles): put in near the Altstadt, under the Schanzlbrücke, into the Danube's north bank.

const STEP = 1 / 120;
const r2 = (x: number) => Math.round(x * 100) / 100;
const deg = (a: number) => Math.round(a * 180 / Math.PI);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Run { steps: number; events: number; maxBump: number; offWater: number; loading: number }

// `seconds` of `input` (or input(t)); every step the outline checked on the water
function drive(b: BoatMotion, w: BoatWorld, input: BoatInput | ((t: number) => BoatInput), seconds: number, each?: (b: BoatMotion) => void): Run {
  const run: Run = { steps: 0, events: 0, maxBump: 0, offWater: 0, loading: 0 };
  for (let t = 0; t < seconds; t += STEP) {
    const ev = b.step(typeof input === 'function' ? input(t) : input, STEP, w);
    if (ev === 'loading') { run.loading++; continue; }
    run.steps++;
    for (const e of ev) { run.events++; run.maxBump = Math.max(run.maxBump, e.speed); }
    if (b.fits(w, b.x, b.z, b.h) !== true) run.offWater++;
    each?.(b);
  }
  return run;
}

const GAS: BoatInput = { throttle: 1, steer: 0, drift: false };

async function loadAll(c: VoxelCollision, meta: Meta) {
  const p = new Vector3(meta.W / 2, 0, meta.D / 2);
  for (let i = 0; i < 2000; i++) {
    c.prefetch(p, new Vector3());
    if ([[64, 64], [192, 64], [64, 192], [192, 192]].every(([x, z]) => c.surface(x, z))) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('collision tiles never loaded');
}

export async function runBoatChecks(): Promise<CheckOutcome[]> {
  const inChannel = (x: number, z: number) => x >= 16 && x < 240 && z >= 40 && z < 216;
  const w = await makeWorld({
    size: [256, 256], ground: (x, z) => (inChannel(x, z) ? 4 : 8), surface: (x, z) => (inChannel(x, z) ? 'water' : 'road'),
    boxes: [
      { x0: 170, x1: 180, z0: 0, z1: 256, y0: 10, y1: 11, mat: 'deck' }, // a bridge, 6 m over the water
      { x0: 60, x1: 64, z0: 40, z1: 80, y0: 5, y1: 6, mat: 'deck' }, // a footbridge 1 m over it: too low
      { x0: 120, x1: 124, z0: 150, z1: 156, y0: 4, y1: 10, mat: 'wall' }, // a pier
    ],
  });
  try {
    const out: CheckOutcome[] = [];
    const c = w.collision;
    // (before its tiles are in, the boat waits)
    const fresh = new BoatMotion();
    fresh.reset({ x: 40, y: 4, z: 128, h: Math.PI / 2 });
    const held = fresh.step(GAS, STEP, c);
    out.push({ name: 'boat_loading', pass: held === 'loading' && fresh.x === 40, detail: { step: held === 'loading' ? 'loading' : 'moved' } });
    await loadAll(c, w.meta);

    // full throttle along the channel: ~95 % of the top speed in ~5 s, settling at vmax (60-70 km/h)
    {
      const b = new BoatMotion();
      b.reset({ x: 24, y: 4, z: 110, h: Math.PI / 2 });
      let t95 = -1, t = 0;
      const run = drive(b, c, GAS, 9, (q) => { t += STEP; if (t95 < 0 && q.speed >= 0.95 * BOAT.vmax) t95 = t; });
      const kmh = b.kmh;
      out.push({ name: 'boat_top_speed', pass: kmh > 60 && kmh < 70 && b.speed <= BOAT.vmax + 0.01 && t95 > 3 && t95 < 7 && run.offWater === 0 && Math.abs(b.z - 110) < 0.01,
        detail: { kmh: r2(kmh), t95: r2(t95), x: r2(b.x), pitch_deg: r2(b.pitch * 57.3) } });
    }
    {
      // let go at top speed: it slows down by itself (quickly at first), never backwards
      const b = new BoatMotion();
      b.reset({ x: 24, y: 4, z: 110, h: Math.PI / 2 });
      b.vx = BOAT.vmax;
      drive(b, c, { throttle: 0, steer: 0, drift: false }, 1);
      const after1 = b.speed;
      drive(b, c, { throttle: 0, steer: 0, drift: false }, 9);
      out.push({ name: 'boat_coast', pass: after1 < BOAT.vmax - 3 && b.speed >= 0 && b.speed < 3, detail: { kmh_after_1s: r2(after1 * 3.6), kmh_after_10s: r2(b.kmh), x: r2(b.x) } });
    }

    // a full right turn at speed: the heading goes clockwise (h falls), the circle a few boat lengths; tighter drifting
    {
      const turn = (drift: boolean) => {
        const b = new BoatMotion();
        b.reset({ x: 60, y: 4, z: 128, h: Math.PI / 2 });
        drive(b, c, GAS, 3);
        const h0 = b.h, v0 = b.speed;
        let slip = 0;
        const run = drive(b, c, { throttle: 1, steer: 1, drift }, 2, (q) => {
          const vh = Math.atan2(q.vx, q.vz);
          if (Math.hypot(q.vx, q.vz) > 1) slip = Math.max(slip, Math.abs(wrap(vh - q.h)));
        });
        const dh = wrap(b.h - h0);
        return { dh, v0, v: b.speed, radius: Math.abs(b.speed / (b.yaw || 1e-9)), slip, run };
      };
      const n = turn(false), d = turn(true);
      out.push({ name: 'boat_turn', pass: n.dh < -1.2 && n.radius > 10 && n.radius < 45 && n.run.offWater === 0,
        detail: { turned_deg: deg(n.dh), radius: r2(n.radius), kmh_in: r2(n.v0 * 3.6), kmh_out: r2(n.v * 3.6), slip_deg: deg(n.slip) } });
      out.push({ name: 'boat_drift', pass: d.dh < n.dh && d.slip > n.slip && d.run.offWater === 0,
        detail: { turned_deg: deg(d.dh), slip_deg: deg(d.slip), kmh_out: r2(d.v * 3.6) } });
      // at rest it hardly turns
      const b = new BoatMotion();
      b.reset({ x: 60, y: 4, z: 128, h: 0 });
      drive(b, c, { throttle: 0, steer: 1, drift: false }, 1);
      out.push({ name: 'boat_turn_at_rest', pass: Math.abs(b.h) < 0.4 && Math.abs(b.h) > 0.05, detail: { turned_deg: deg(b.h) } });
    }

    // backwards: slowly
    {
      const b = new BoatMotion();
      b.reset({ x: 128, y: 4, z: 100, h: Math.PI / 2 });
      drive(b, c, { throttle: -1, steer: 0, drift: false }, 6);
      out.push({ name: 'boat_reverse', pass: b.speed < -3 && b.speed >= -BOAT.vrev - 0.01, detail: { kmh: r2(b.kmh), x: r2(b.x) } });
    }

    // straight at the bank (land 4 m over the water at z 216): it bounces and never gets onto the land; a pier alike
    {
      const b = new BoatMotion();
      b.reset({ x: 100, y: 4, z: 150, h: 0 });
      let maxZ = 0;
      const run = drive(b, c, GAS, 8, (q) => { maxZ = Math.max(maxZ, q.z); });
      out.push({ name: 'boat_shore', pass: run.offWater === 0 && run.events > 0 && maxZ < 216 - 1 && b.y === 4,
        detail: { bumps: run.events, hardest_kmh: r2(run.maxBump * 3.6), max_z: r2(maxZ), y: b.y } });
      // at a slant: it slides along the bank, keeping some way on
      const s = new BoatMotion();
      s.reset({ x: 30, y: 4, z: 190, h: 0.9 });
      const sr = drive(s, c, GAS, 6);
      out.push({ name: 'boat_slide', pass: sr.offWater === 0 && s.x > 70 && s.z < 216, detail: { x: r2(s.x), z: r2(s.z), kmh: r2(s.kmh) } });
      const p = new BoatMotion();
      p.reset({ x: 100, y: 4, z: 153, h: Math.PI / 2 });
      let maxX = 0;
      const pr = drive(p, c, GAS, 4, (q) => { maxX = Math.max(maxX, q.x); });
      out.push({ name: 'boat_pier', pass: pr.offWater === 0 && pr.events > 0 && maxX < 120, detail: { bumps: pr.events, max_x: r2(maxX) } });
    }

    // under the bridge (deck 6 m over the water): through; under the footbridge (1 m over it): stopped
    {
      const b = new BoatMotion();
      b.reset({ x: 130, y: 4, z: 100, h: Math.PI / 2 });
      const run = drive(b, c, GAS, 5);
      out.push({ name: 'boat_under_bridge', pass: b.x > 185 && run.events === 0 && run.offWater === 0, detail: { x: r2(b.x), bumps: run.events } });
      const f = new BoatMotion();
      f.reset({ x: 30, y: 4, z: 60, h: Math.PI / 2 });
      let maxX = 0;
      const fr = drive(f, c, GAS, 4, (q) => { maxX = Math.max(maxX, q.x); });
      out.push({ name: 'boat_low_bridge', pass: maxX < 60 && fr.events > 0, detail: { max_x: r2(maxX), bumps: fr.events } });
    }

    // put in from the land: the nearest open water, the hull's whole outline on it; and unstuck after running aground
    {
      const at = findSpawn(c, 128, 236, Math.PI / 2, 48);
      const probe = new BoatMotion();
      const ok = !!at && at.y === 4 && probe.fits(c, at.x, at.z, at.h, at.y) === true && at.z < 216;
      out.push({ name: 'boat_spawn', pass: ok, detail: at ? { x: at.x, z: at.z, h_deg: deg(at.h), y: at.y } : { found: false } });
      const none = findSpawn(c, 128, 250, 0, 10);
      out.push({ name: 'boat_spawn_none', pass: none === null, detail: { found: !!none } });
      const b = new BoatMotion();
      b.reset({ x: 100, y: 4, z: 200, h: 0 });
      drive(b, c, GAS, 3);
      const un = b.unstick(c);
      out.push({ name: 'boat_reset', pass: un && b.speed === 0 && b.vx === 0 && b.fits(c, b.x, b.z, b.h) === true, detail: { x: r2(b.x), z: r2(b.z), h_deg: deg(b.h) } });
    }

    // downstream from the river's points: along them, towards the eck, east beyond it
    {
      const river = Array.from({ length: 20 }, (_, k) => [k * 24, 100 + k * 6]).flat();
      const h = downstream(river, 200, 150, { x: 1000, z: 300 });
      const e = downstream(river, 200, 150, { x: 100, z: 300 });
      const near = nearestRiver(river, 205, 170);
      out.push({ name: 'boat_downstream', pass: Math.abs(wrap(h - Math.atan2(24, 6))) < 0.05 && Math.abs(wrap(e - Math.atan2(24, 6))) < 0.05 && near?.x === 216.5,
        detail: { h_deg: deg(h), east_deg: deg(e), near_x: near?.x ?? null } });
    }
    return out;
  } finally {
    w.collision.release();
  }
}

// On the real data (a VoxelCollision over the tiles on disk, all of the run's nodes loaded): river = flood.json's
export async function runRealChecks(c: VoxelCollision, meta: Meta, river: number[], need: (x: number, z: number) => Promise<void>): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  const ov = meta.views?.overview?.target, eckT = meta.views?.eck?.target;
  // put in from the overview's focus (over the Altstadt): on the Danube or the Inn, facing roughly downstream (east)
  if (ov) {
    const r = nearestRiver(river, ov[0], ov[2]);
    if (r) {
      await need(r.x, r.z);
      const h = downstream(river, r.x, r.z, eckT && { x: eckT[0], z: eckT[2] });
      const at = findSpawn(c, r.x, r.z, h, 48);
      const probe = new BoatMotion();
      const ok = !!at && probe.fits(c, at.x, at.z, at.h, at.y) === true && Math.sin(at.h) > 0.3;
      out.push({ name: 'real_spawn', pass: ok, detail: at ? { x: at.x, z: at.z, y: at.y, h_deg: deg(at.h) } : { found: false } });
      if (at) {
        // a lap: a minute of full throttle with the wheel swinging, never off the water
        const b = new BoatMotion();
        b.reset(at);
        const run = await driveReal(b, c, need, (t) => ({ throttle: 1, steer: Math.sin(t * 0.7), drift: t % 10 > 8 }), 60);
        out.push({ name: 'real_lap', pass: run.offWater === 0 && Number.isFinite(b.x), detail: { bumps: run.events, end_x: r2(b.x), end_z: r2(b.z) } });
      }
    }
  }
  // east along the Danube under the Schanzlbrücke (its deck ~30 m wide, no pier in this lane): through, untouched
  {
    const [ox, oz] = meta.origin ?? [0, 0];
    const x0 = 1136 - ox, z = 547 - oz; // (the project grid: as tools/real-city.mjs SCHANZL)
    await need(x0, z);
    const under = c.waterColumn(x0 + 85, z, 5, 12);
    const b = new BoatMotion();
    const at = findSpawn(c, x0, z, Math.PI / 2, 4);
    if (!at || !under || under.water < 0) out.push({ name: 'real_bridge', pass: false, detail: { start: !!at, water_under: under?.water ?? null } });
    else {
      b.reset(at);
      let deck = 0;
      const run = await driveReal(b, c, need, GAS, 14, (q) => {
        const col = c.waterColumn(q.x, q.z, q.y + BOAT.freeboard, q.y + 40);
        if (col?.blocked) deck++;
      });
      out.push({ name: 'real_bridge', pass: b.x > x0 + 150 && deck > 0 && run.events === 0 && run.offWater === 0,
        detail: { x0: r2(at.x), x: r2(b.x), steps_under_deck: deck, bumps: run.events } });
    }
    // and north into the bank: bounced, never on the land
    await need(x0, z - 25);
    const s = findSpawn(c, x0, z - 25, Math.PI, 6);
    if (s) {
      const q = new BoatMotion();
      q.reset(s);
      const run = await driveReal(q, c, need, GAS, 8);
      out.push({ name: 'real_bank', pass: run.offWater === 0 && run.events > 0, detail: { bumps: run.events, hardest_kmh: r2(run.maxBump * 3.6), z: r2(q.z) } });
    } else out.push({ name: 'real_bank', pass: false, detail: { start: false } });
  }
  return out;
}

async function driveReal(b: BoatMotion, c: VoxelCollision, need: (x: number, z: number) => Promise<void>, input: BoatInput | ((t: number) => BoatInput), seconds: number, each?: (b: BoatMotion) => void) {
  let run: Run = { steps: 0, events: 0, maxBump: 0, offWater: 0, loading: 0 };
  for (let t = 0; t < seconds; t += 1) {
    await need(b.x, b.z);
    const t0 = t;
    const part = drive(b, c, typeof input === 'function' ? (s: number) => input(t0 + s) : input, 1, each);
    if (part.loading) throw new Error('collision tiles not in');
    run = { steps: run.steps + part.steps, events: run.events + part.events, maxBump: Math.max(run.maxBump, part.maxBump), offWater: run.offWater + part.offWater, loading: 0 };
  }
  return run;
}
