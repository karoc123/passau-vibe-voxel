import { Vector3 } from 'three';
import { PLANE, PlaneFlight, type PlaneConfig, type PlaneEvent, type PlaneInput, type PlaneWorld } from './plane-flight';
import type { ImpactKind, Sweep } from './voxel-collision';

// Headless checks of the plane's flight (plane-flight.ts; web/tools/plane.mjs). A synthetic world of boxes (ground,
// hills, walls, roofs, a river whose water is the ground's top as in the voxels), swept the way VoxelCollision sweeps
// the fuselage's cube (the box grown by the radius, the first face met, its axis), so the checks cover any map size
// without node files. The limits come from PLANE, not literals, where PLANE sets them. The real data's flights are in
// the tool (they need the node files on disk).

interface Block { x0: number; z0: number; x1: number; z1: number; top: number; kind: ImpactKind; water?: boolean; loading?: boolean }

export class BoxWorld implements PlaneWorld {
  readonly blocks: Block[] = [];
  constructor(readonly W: number, readonly D: number, readonly H: number, readonly ground: number, readonly R = PLANE.RADIUS) {}

  add(b: Block) { this.blocks.push(b); return b; }

  private at(x: number, z: number) {
    let top = this.ground, ground = this.ground, water = -1;
    for (const b of this.blocks) {
      if (x < b.x0 || x >= b.x1 || z < b.z0 || z >= b.z1) continue;
      if (b.water) { ground = b.top; top = b.top; water = b.top; continue; }
      if (b.kind === 'terrain') ground = Math.max(ground, b.top);
      top = Math.max(top, b.top);
    }
    return { ground, top, water };
  }

  surface(x: number, z: number) { const s = this.at(x, z); return { ground: s.ground, top: s.top }; }
  water(x: number, z: number) {
    if (this.blocks.some((b) => b.loading && x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1)) return null;
    return this.at(x, z).water;
  }

  sweep(p: Vector3, d: Vector3): Sweep {
    const R = this.R;
    let fraction = 1, hit: ImpactKind | null = null, axis = 0;
    const all: Block[] = [{ x0: -1e9, z0: -1e9, x1: 1e9, z1: 1e9, top: this.ground, kind: 'terrain' }, ...this.blocks];
    for (const b of all) {
      const lo = [b.x0 - R, -1e9, b.z0 - R], hi = [b.x1 + R, b.top + R, b.z1 + R];
      let enter = 0, leave = 1, ax = 0, miss = false;
      for (let i = 0; i < 3 && !miss; i++) {
        const s = p.getComponent(i), m = d.getComponent(i);
        if (Math.abs(m) < 1e-10) { if (s < lo[i] || s > hi[i]) miss = true; continue; }
        const a = (lo[i] - s) / m, c = (hi[i] - s) / m, e = Math.min(a, c);
        if (e >= enter) { enter = e; ax = -Math.sign(m) * (i + 1); }
        leave = Math.min(leave, Math.max(a, c));
        if (enter > leave) miss = true;
      }
      if (miss || enter > fraction) continue;
      if (b.loading) return 'loading';
      if (ax === 0) ax = 2;
      fraction = enter; hit = b.kind; axis = ax;
    }
    return hit ? { fraction, hit, axis } : { fraction, hit: null };
  }
}

export interface Check { name: string; pass: boolean; detail: Record<string, unknown> }
const r1 = (v: number) => Math.round(v * 10) / 10;
const kmh = (v: number) => Math.round(v * 3.6);
const deg = (v: number) => r1(v * 180 / Math.PI);
const HANDS_OFF = (throttle: number): PlaneInput => ({ turn: 0, pitch: 0, throttle });

// runs `secs` of fixed steps, input from a function of the flight; returns the events and the lowest and highest points
export function fly(f: PlaneFlight, w: PlaneWorld, secs: number, input: (f: PlaneFlight, t: number) => PlaneInput, stop?: (f: PlaneFlight, e: PlaneEvent[]) => boolean) {
  const events: PlaneEvent[] = [];
  let minY = Infinity, maxY = -Infinity, minV = Infinity, maxV = 0, waits = 0;
  for (let t = 0; t < secs; t += f.cfg.STEP) {
    if (!f.step(input(f, t), f.cfg.STEP, w)) waits++;
    events.push(...f.events.splice(0));
    if (f.state !== 'crashed') { minY = Math.min(minY, f.p.y); maxY = Math.max(maxY, f.p.y); minV = Math.min(minV, f.v); maxV = Math.max(maxV, f.v); }
    if (stop?.(f, events)) break;
  }
  return { events, minY, maxY, minV, maxV, waits };
}

// a pitch input that holds the flight path at `gamma` (rad): what a pilot's hand does, for the checks
export const holdPath = (f: PlaneFlight, gamma: number, k = 4) => Math.max(-1, Math.min(1, (gamma - f.gamma) * k / f.cfg.PITCH_RATE));

// the level speed at a throttle: where thrust meets drag (n = 1), the faster root
export function levelSpeed(c: PlaneConfig, throttle: number) {
  let best = 0;
  for (let v = c.V_STALL; v < c.V_MAX; v += 0.01) {
    const drag = c.CD0 * v * v + c.KI * c.G * c.G / (v * v);
    if (drag <= throttle * c.THRUST) best = v;
  }
  return best;
}

function open(c = PLANE) {
  return new BoxWorld(6000, 3000, 173, 10, c.RADIUS);
}

export function runPlaneChecks(c: PlaneConfig = PLANE): Check[] {
  const out: Check[] = [];
  const add = (name: string, pass: boolean, detail: Record<string, unknown>) => out.push({ name, pass, detail });

  // level: hands off at 60 % for 30 s: height and heading held, the speed settles at thrust = drag
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 500, y: 200, z: 1500, heading: Math.PI / 2, speed: 45 });
    f.engine = 0.6;
    const r = fly(f, w, 40, () => HANDS_OFF(0.6));
    const want = levelSpeed(c, 0.6);
    add('level', Math.abs(f.p.y - 200) < 0.5 && Math.abs(f.heading - Math.PI / 2) < 0.1 * Math.PI / 180 && Math.abs(f.v - want) < 1 && !r.events.length,
      { dy: r1(f.p.y - 200), dheading: deg(f.heading - Math.PI / 2), kmh: kmh(f.v), want: kmh(want) });
  }

  // throttle: level at 100 %, 50 %, 25 %: the top speed 230..260 km/h, above the drone's 197; less throttle, slower
  {
    const speeds: number[] = [];
    for (const t of [1, 0.5, 0.25]) {
      const w = open(c), f = new PlaneFlight(c);
      f.reset({ x: 300, y: 300, z: 1500, heading: Math.PI / 2, speed: 50 });
      f.engine = t;
      fly(f, w, 90, () => HANDS_OFF(t));
      speeds.push(f.v);
    }
    const [top, half, quarter] = speeds.map(kmh);
    add('throttle', top >= 230 && top <= 260 && half < top - 40 && quarter < half, { full: top, half, quarter, drone: 197 });
  }

  // throttle_lever: the engine follows the lever stepless; the lever is the input's (plane.ts moves it gradually)
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 300, z: 1500, heading: Math.PI / 2, speed: 50 });
    f.engine = 0;
    fly(f, w, 0.5, () => HANDS_OFF(0.37));
    const mid = f.engine;
    fly(f, w, 4, () => HANDS_OFF(0.37));
    add('throttle_lever', mid > 0.1 && mid < 0.37 && Math.abs(f.engine - 0.37) < 0.01, { after05s: r1(mid * 100) + '%', after45s: r1(f.engine * 100) + '%' });
  }

  // stall: throttle off, hands off at 300 m: it slows past the stall, sinks and drops its nose; full throttle and the
  // nose down, then eased back to level, recovers it (fast again, level) within 20 s
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 300, z: 1500, heading: Math.PI / 2, speed: 40 });
    f.engine = 0;
    let stalled = false, minGamma = 0, sink = 0, minV = Infinity;
    for (let t = 0; t < 40; t += c.STEP) {
      f.step({ turn: 0, pitch: 0.3, throttle: 0 }, c.STEP, w); // (the pilot holding the nose up as it slows)
      stalled ||= f.stalled; minGamma = Math.min(minGamma, f.gamma); minV = Math.min(minV, f.v);
      sink = Math.max(sink, -f.velocity().y);
    }
    const lost = 300 - f.p.y, y0 = f.p.y;
    let recovered = -1;
    for (let t = 0; t < 20; t += c.STEP) {
      f.step({ turn: 0, pitch: t < 1.5 ? -0.6 : holdPath(f, 0, 1.5), throttle: 1 }, c.STEP, w);
      if (recovered < 0 && t > 2 && f.v > c.V_STALL * 1.25 && f.velocity().y >= -0.5) recovered = t;
    }
    add('stall', stalled && minV < c.V_STALL && sink > 3 && minGamma < -10 * Math.PI / 180 && lost > 30 && recovered > 0 && f.state === 'air',
      { minKmh: kmh(minV), stallKmh: kmh(c.V_STALL), maxSink: r1(sink), noseDown: deg(minGamma), lost: Math.round(lost), recoveredAfter: r1(recovered), lostInRecovery: Math.round(y0 - f.p.y) });
  }

  // climb_costs: at 70 % a 15° climb loses speed, a 15° dive gains it
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 250, z: 1500, heading: Math.PI / 2, speed: levelSpeed(c, 0.7) });
    f.engine = 0.7;
    const v0 = f.v;
    fly(f, w, 8, (g) => ({ turn: 0, pitch: holdPath(g, 15 * Math.PI / 180), throttle: 0.7 }));
    const vc = f.v, yc = f.p.y;
    fly(f, w, 8, (g) => ({ turn: 0, pitch: holdPath(g, -15 * Math.PI / 180), throttle: 0.7 }));
    const vd = f.v;
    add('climb_costs', vc < v0 - 8 && vd > vc + 15 && yc > 250 + 40, { startKmh: kmh(v0), afterClimbKmh: kmh(vc), climbed: Math.round(yc - 250), afterDiveKmh: kmh(vd) });
  }

  // turn: full stick at cruise: banked to BANK_MAX within 1.5 s, holding height (lift suffices); a full circle's radius
  {
    const w = open(c), f = new PlaneFlight(c);
    const v0 = levelSpeed(c, 0.6);
    f.reset({ x: 3000, y: 300, z: 1500, heading: 0, speed: v0 });
    f.engine = 0.6;
    let tBank = -1, turned = 0, last = f.heading, t = 0;
    const r = fly(f, w, 40, (g, tt) => { t = tt; if (tBank < 0 && g.bank > c.BANK_MAX * 0.95) tBank = tt; turned += last - g.heading; last = g.heading; return { turn: 1, pitch: 0, throttle: 0.6 }; },
      () => turned >= 2 * Math.PI);
    const rate = turned / t, radius = f.v / rate;
    add('turn', tBank > 0 && tBank < 1.5 && Math.abs(f.p.y - 300) < 15 && turned >= 2 * Math.PI,
      { bankAfter: r1(tBank), degPerS: deg(rate), radius: Math.round(radius), dy: r1(f.p.y - 300), lapS: r1(t), kmhEnd: kmh(f.v), maxBank: deg(r.maxV ? f.bank : 0) });
  }

  // hands_off_bank: let go in a bank: wings level within 2.5 s
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 3000, y: 300, z: 1500, heading: 0, speed: 45 });
    f.engine = 0.6;
    fly(f, w, 2, () => ({ turn: -1, pitch: 0, throttle: 0.6 }));
    const b0 = f.bank;
    fly(f, w, 2.5, () => HANDS_OFF(0.6));
    add('hands_off_bank', Math.abs(f.bank) < 3 * Math.PI / 180, { from: deg(b0), after25s: deg(f.bank) });
  }

  // boundary: full throttle at the east edge, then the north edge and the corner: never out, never a crash
  {
    const w = open(c), f = new PlaneFlight(c);
    const lim = { maxX: 0, maxZ: 0, minX: Infinity, edge: false };
    let crashes = 0;
    for (const [x, z, h] of [[5800, 1500, Math.PI / 2], [3000, 2800, 0], [5900, 2900, Math.PI / 4], [200, 200, -3 * Math.PI / 4]] as const) {
      f.reset({ x, y: 300, z, heading: h, speed: 60 });
      f.engine = 1;
      const r = fly(f, w, 12, () => HANDS_OFF(1));
      crashes += r.events.filter((e) => e.type === 'crash').length;
      lim.maxX = Math.max(lim.maxX, f.p.x); lim.maxZ = Math.max(lim.maxZ, f.p.z); lim.minX = Math.min(lim.minX, f.p.x); lim.edge ||= f.atEdge;
    }
    add('boundary', lim.maxX <= w.W - c.EDGE + 1e-6 && lim.maxZ <= w.D - c.EDGE + 1e-6 && lim.minX >= c.EDGE - 1e-6 && lim.edge && !crashes,
      { maxX: r1(lim.maxX), maxZ: r1(lim.maxZ), minX: r1(lim.minX), wall: `${c.EDGE} m in`, crashes });
  }

  // ceiling: full throttle, holding 20° up for 150 s: stays under meta.H + CEILING
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 300, z: 1500, heading: Math.PI / 2, speed: 50 });
    let maxY = 0;
    for (let t = 0; t < 150; t += c.STEP) {
      f.step({ turn: Math.sin(t * 0.05) * 0.4, pitch: holdPath(f, 20 * Math.PI / 180), throttle: 1 }, c.STEP, w);
      maxY = Math.max(maxY, f.p.y);
    }
    add('ceiling', maxY <= w.H + c.CEILING + 1e-6 && f.state === 'air', { maxY: Math.round(maxY), ceiling: w.H + c.CEILING });
  }

  // a river along x (z 1300..1700, water at 5, banks at 12)
  const riverWorld = () => {
    const w = new BoxWorld(6000, 3000, 173, 5, c.RADIUS);
    w.add({ x0: 0, z0: 0, x1: 6000, z1: 1300, top: 12, kind: 'terrain' });
    w.add({ x0: 0, z0: 1700, x1: 6000, z1: 3000, top: 12, kind: 'terrain' });
    w.add({ x0: 0, z0: 1300, x1: 6000, z1: 1700, top: 5, kind: 'terrain', water: true });
    return w;
  };
  const approach = (sink: number, throttle: number) => (g: PlaneFlight): PlaneInput =>
    ({ turn: 0, pitch: holdPath(g, Math.asin(-Math.min(sink, g.v * 0.5) / g.v)), throttle });

  // water_landing: a 1.5 m/s descent at ~110 km/h onto the river: it floats; then it taxis (turns on the spot's
  // water, slowly); then full throttle and the stick pulled past the takeoff speed: it flies again and climbs
  {
    const w = riverWorld(), f = new PlaneFlight(c);
    f.reset({ x: 500, y: 40, z: 1500, heading: Math.PI / 2, speed: 32 });
    f.engine = 0.2;
    const land = fly(f, w, 60, approach(1.5, 0.2), (g) => g.state !== 'air');
    const landed = f.state === 'water' && land.events.some((e) => e.type === 'touchdown');
    const touchKmh = kmh(f.v);
    const h0 = f.heading;
    fly(f, w, 12, (_g, t) => ({ turn: t < 6 ? 1 : 0, pitch: 0, throttle: 0.08 }));
    const turned = deg(Math.abs(f.heading - h0)), taxiKmh = kmh(f.v);
    const afloat = f.state === 'water' && Math.abs(f.p.y - (5 + c.FLOAT_H)) < 1e-6;
    // back along the river (heading +x), then away
    f.heading = Math.PI / 2;
    let tOff = -1;
    const off = fly(f, w, 40, (g, t) => { if (tOff < 0 && g.state === 'air') tOff = t; return { turn: 0, pitch: g.v > c.V_TAKEOFF ? 0.6 : 0, throttle: 1 }; },
      (g) => g.state === 'air' && g.p.y > 5 + 30);
    add('water_landing', landed && afloat && turned > 30 && f.state === 'air' && f.p.y > 35 && !off.events.some((e) => e.type === 'crash'),
      { touchdownKmh: touchKmh, taxiTurned: turned, taxiEndKmh: taxiKmh, takeoffAfter: r1(tOff), takeoffKmh: kmh(c.V_TAKEOFF), climbedTo: Math.round(f.p.y) });
  }

  // water_stop: afloat, throttle off: it slows to a stop; into the bank slowly: it stops there, no crash
  {
    const w = riverWorld(), f = new PlaneFlight(c);
    f.reset({ x: 500, y: 5 + c.FLOAT_H, z: 1500, heading: Math.PI / 2, speed: 20, water: true });
    fly(f, w, 40, () => HANDS_OFF(0));
    const stopped = f.v < 1;
    f.heading = 0; // towards the north bank, 200 m off
    const r = fly(f, w, 120, () => HANDS_OFF(0.1));
    add('water_stop', stopped && f.state === 'water' && !r.events.some((e) => e.type === 'crash') && f.p.z > 1690 && f.p.z < 1700,
      { stoppedKmh: kmh(stopped ? 0 : f.v), atBankZ: r1(f.p.z), bumps: r.events.filter((e) => e.type === 'bump').length });
  }

  // crash_water: onto the water at 200 km/h, 10° down: a crash ('water'), then back in the air at a safe pose >= 3 s
  // old, >= RESPAWN_AGL over the top, level
  {
    const w = riverWorld(), f = new PlaneFlight(c);
    f.reset({ x: 500, y: 120, z: 1500, heading: Math.PI / 2, speed: 55 });
    f.engine = 0.8;
    const trail: [number, number, number, number][] = [];
    const r = fly(f, w, 30, (g, t) => { trail.push([t, g.p.x, g.p.y, g.p.z]); return { turn: 0, pitch: t < 4 ? 0 : holdPath(g, -10 * Math.PI / 180), throttle: 0.8 }; },
      (_g, e) => e.some((x) => x.type === 'crash'));
    const crash = r.events.find((e) => e.type === 'crash') as { what: string; kmh: number } | undefined;
    const tCrash = trail[trail.length - 1]?.[0] ?? 0;
    fly(f, w, c.CRASH_S + 0.05, () => HANDS_OFF(0.8));
    const back = trail.findLast(([, x]) => x <= f.p.x + 1e-6);
    const age = back ? tCrash - back[0] : -1;
    add('crash_water', crash?.what === 'water' && f.state === 'air' && f.p.y >= w.surface(f.p.x, f.p.z).top + c.RESPAWN_AGL - 1e-6 && age >= c.SAFE_AGE && f.gamma === 0 && f.bank === 0,
      { what: crash?.what, kmh: crash?.kmh, respawnY: Math.round(f.p.y), poseAge: r1(age), respawnKmh: kmh(f.v) });
  }

  // crash_water_steep: slow but steep (sinking 6 m/s) onto the water: a crash too
  {
    const w = riverWorld(), f = new PlaneFlight(c);
    f.reset({ x: 500, y: 60, z: 1500, heading: Math.PI / 2, speed: 30 });
    f.engine = 0;
    const r = fly(f, w, 30, approach(6, 0), (_g, e) => e.some((x) => x.type === 'crash' || x.type === 'touchdown'));
    const e = r.events.find((x) => x.type === 'crash' || x.type === 'touchdown') as PlaneEvent & { what?: string };
    add('crash_water_steep', e?.type === 'crash' && e.what === 'water', { event: e?.type, what: e?.what });
  }

  // crash_land: into a 60 m wall at cruise: a crash ('structure'); respawned >= 3 s back, >= RESPAWN_AGL over the top
  {
    const w = open(c), f = new PlaneFlight(c);
    w.add({ x0: 1500, z0: 1000, x1: 1520, z1: 2000, top: 70, kind: 'structure' });
    f.reset({ x: 300, y: 50, z: 1500, heading: Math.PI / 2, speed: 50 });
    f.engine = 0.6;
    const r = fly(f, w, 40, () => HANDS_OFF(0.6), (_g, e) => e.some((x) => x.type === 'crash'));
    const crash = r.events.find((x) => x.type === 'crash') as { what: string } | undefined;
    const xCrash = f.p.x;
    const resp = fly(f, w, c.CRASH_S + 0.05, () => HANDS_OFF(0.6));
    const top = w.surface(f.p.x, f.p.z).top;
    add('crash_land', crash?.what === 'structure' && f.state === 'air' && f.p.y - top >= c.RESPAWN_AGL - 1e-6 && xCrash - f.p.x >= c.SAFE_AGE * 45 &&
      resp.events.some((e) => e.type === 'respawn'), { what: crash?.what, atX: Math.round(xCrash), respawnX: Math.round(f.p.x), respawnAgl: Math.round(f.p.y - top) });
  }

  // crash_ground: hands off, nose held down into flat ground: a crash ('terrain')
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 150, z: 1500, heading: Math.PI / 2, speed: 50 });
    f.engine = 0.6;
    const r = fly(f, w, 30, (g) => ({ turn: 0, pitch: holdPath(g, -25 * Math.PI / 180), throttle: 0.6 }), (_g, e) => e.some((x) => x.type === 'crash'));
    const crash = r.events.find((x) => x.type === 'crash') as { what: string } | undefined;
    add('crash_ground', crash?.what === 'terrain', { what: crash?.what });
  }

  // skim: a 3° descent onto a wide flat roof: a bounce ("Careful!"), not a crash
  {
    const w = open(c), f = new PlaneFlight(c);
    w.add({ x0: 1000, z0: 1300, x1: 2500, z1: 1700, top: 40, kind: 'structure' });
    f.reset({ x: 900, y: 40 + c.RADIUS + 8, z: 1500, heading: Math.PI / 2, speed: 45 });
    f.engine = 0.5;
    const r = fly(f, w, 12, (g) => ({ turn: 0, pitch: holdPath(g, -3 * Math.PI / 180), throttle: 0.5 }), (_g, e) => e.some((x) => x.type === 'crash' || x.type === 'skim'));
    const e = r.events.find((x) => x.type === 'crash' || x.type === 'skim');
    add('skim', e?.type === 'skim' && f.state === 'air', { event: e?.type, kmh: kmh(f.v) });
  }

  // loading: a block not loaded ahead: the step is not taken (nothing moves) until it arrives
  {
    const w = open(c), f = new PlaneFlight(c);
    const b = w.add({ x0: 600, z0: 1400, x1: 700, z1: 1600, top: 30, kind: 'structure', loading: true });
    f.reset({ x: 500, y: 31.5 + c.RADIUS, z: 1500, heading: Math.PI / 2, speed: 50 });
    f.engine = 0.6;
    const r = fly(f, w, 3, () => HANDS_OFF(0.6));
    const held = f.p.x;
    b.loading = false;
    fly(f, w, 1, () => HANDS_OFF(0.6));
    add('loading', r.waits > 0 && held <= 600 && f.p.x > held + 20 && f.waiting === false, { waits: r.waits, heldAtX: r1(held), afterX: r1(f.p.x) });
  }

  // fuzz: 10 min of seeded random input over hills, walls and a river: no NaN, always inside the map and under the
  // ceiling, every crash followed by a respawn. Crashes per minute are printed (no gate)
  {
    const w = riverWorld(), f = new PlaneFlight(c);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 60; i++) {
      const x = rnd() * 5800, z = rnd() * 2800;
      if (z > 1250 && z < 1750) continue;
      w.add({ x0: x, z0: z, x1: x + 20 + rnd() * 200, z1: z + 20 + rnd() * 200, top: 20 + rnd() * 150, kind: rnd() < 0.5 ? 'terrain' : 'structure' });
    }
    f.reset({ x: 500, y: 200, z: 1500, heading: Math.PI / 2, speed: 45 });
    let inp: PlaneInput = HANDS_OFF(0.6), bad = '', crashes = 0, respawns = 0;
    for (let t = 0; t < 600 && !bad; t += c.STEP) {
      if (rnd() < 0.02) inp = { turn: Math.round(rnd() * 2 - 1), pitch: Math.round(rnd() * 2 - 1) * (rnd() < 0.5 ? 1 : 0), throttle: rnd() };
      f.step(inp, c.STEP, w);
      for (const e of f.events.splice(0)) { if (e.type === 'crash') crashes++; if (e.type === 'respawn') respawns++; }
      const p = f.p;
      if (![p.x, p.y, p.z, f.v, f.heading, f.gamma, f.bank].every(Number.isFinite)) bad = `NaN at ${r1(t)}`;
      else if (p.x < c.EDGE - 1e-6 || p.x > w.W - c.EDGE + 1e-6 || p.z < c.EDGE - 1e-6 || p.z > w.D - c.EDGE + 1e-6) bad = `outside at ${r1(t)}`;
      else if (p.y > w.H + c.CEILING + 1e-6) bad = `over the ceiling at ${r1(t)}`;
    }
    const pending = f.state === 'crashed' ? 1 : 0;
    add('fuzz', !bad && crashes === respawns + pending, { minutes: 10, crashes, respawns, perMinute: r1(crashes / 10), ...(bad ? { bad } : {}) });
  }
  return out;
}
