import { JET, PLANE, PlaneFlight, type PlaneConfig, type PlaneInput } from './plane-flight';
import { BoxWorld, fly, levelSpeed, type Check } from './plane-checks';
import { dot, length, vec3 } from '../core/vec';

// Headless checks of the jet (plane-flight.ts JET: the floatplane's core with the aerobatic law; web/tools/plane.mjs
// --type jet). The synthetic world of plane-checks.ts. Limits from JET where it sets them.

const r1 = (v: number) => Math.round(v * 10) / 10;
const kmh = (v: number) => Math.round(v * 3.6);
const deg = (v: number) => r1(v * 180 / Math.PI);
const deg2 = (v: number) => Math.round(v * 18000 / Math.PI) / 100;
const D1 = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const HANDS_OFF = (throttle: number): PlaneInput => ({ turn: 0, pitch: 0, throttle });

// what a pilot's hands do with the aerobatic law: roll towards a bank, pull what holds the path at `gamma` in that
// bank (n = cos gamma / cos bank, the path's error on top)
export function jetHold(f: PlaneFlight, bank: number, gamma: number, throttle: number): PlaneInput {
  const c = f.cfg, cos = Math.cos(f.bank), cb = Math.sign(cos || 1) * Math.max(0.15, Math.abs(cos));
  const turn = Math.max(-1, Math.min(1, wrap(bank - f.bank) * 3 / c.ROLL_RATE)) || 1e-9;
  const q = (Math.cos(f.gamma) / cb - Math.cos(f.gamma) * Math.cos(f.bank)) * c.G / f.v + (gamma - f.gamma) * 2 / cb;
  return { turn, pitch: Math.max(-1, Math.min(1, q / c.PITCH_RATE)), throttle };
}

const open = (c: PlaneConfig) => new BoxWorld(6000, 3000, 173, 10, c.RADIUS);

export function runJetChecks(c: PlaneConfig = JET): Check[] {
  const out: Check[] = [];
  const add = (name: string, pass: boolean, detail: Record<string, unknown>) => out.push({ name, pass, detail });

  // jet_top: full throttle, hands off, level for 90 s: the level top speed 430..470 km/h, height held (the path holds
  // hands off); half throttle clearly slower
  {
    const speeds: number[] = [];
    let dy = 0;
    for (const t of [1, 0.5]) {
      const w = open(c), f = new PlaneFlight(c);
      f.reset({ x: 300, y: 300, z: 1500, heading: Math.PI / 2, speed: 100 });
      f.engine = t;
      fly(f, w, 90, () => HANDS_OFF(t));
      speeds.push(f.v);
      if (t === 1) dy = f.p.y - 300;
    }
    const [top, half] = speeds.map(kmh);
    add('jet_top', top >= 430 && top <= 470 && half < top - 100 && Math.abs(dy) < 3 && Math.abs(top - kmh(levelSpeed(c, 1))) < 5,
      { full: top, half, dy: r1(dy), floatplane: kmh(levelSpeed(PLANE, 1)) });
  }

  // jet_stall: throttle off, the nose held up: past the stall (~twice the floatplane's) it sinks and the nose drops;
  // full throttle and the nose down recovers it
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 500, z: 1500, heading: Math.PI / 2, speed: 90 });
    f.engine = 0;
    let stalled = false, minGamma = 0, sink = 0, minV = Infinity, maxGamma = 0;
    for (let t = 0; t < 40; t += c.STEP) {
      // the nose up to 15 deg, then held up
      f.step({ turn: 0, pitch: f.gamma < 15 * D1 && !stalled ? 0.4 : 0.3, throttle: 0 }, c.STEP, w);
      stalled ||= f.stalled; minGamma = Math.min(minGamma, f.gamma); maxGamma = Math.max(maxGamma, f.gamma); minV = Math.min(minV, f.v);
      sink = Math.max(sink, -f.velocity().y);
    }
    const lost = 500 - f.p.y;
    let recovered = -1;
    const y0 = f.p.y;
    for (let t = 0; t < 25; t += c.STEP) {
      f.step(t < 2 ? { turn: 0, pitch: -0.5, throttle: 1 } : jetHold(f, 0, 0, 1), c.STEP, w);
      if (recovered < 0 && t > 2 && f.v > c.V_STALL * 1.25 && f.velocity().y >= -0.5) recovered = t;
    }
    add('jet_stall', stalled && c.V_STALL >= 1.8 * PLANE.V_STALL && minV < c.V_STALL && sink > 5 && minGamma < -15 * D1 && lost > 50 && recovered > 0 && f.state === 'air',
      { minKmh: kmh(minV), stallKmh: kmh(c.V_STALL), floatplaneStall: kmh(PLANE.V_STALL), maxSink: r1(sink), noseDown: deg(minGamma), lost: Math.round(lost),
        recoveredAfter: r1(recovered), lostInRecovery: Math.round(y0 - f.p.y) });
  }

  // jet_roll: full stick sideways at 400 km/h: a full roll (360 deg) within 2.4 s, the peak rate ROLL_RATE; let go,
  // the roll stops (no snap) and, within BANK_TRIM of level, the wings level themselves; past it the bank holds
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 400, z: 1500, heading: Math.PI / 2, speed: 111 });
    f.engine = 0.8;
    let rolled = 0, last = f.bank, tFull = -1, peak = 0;
    fly(f, w, 4, (g, t) => {
      rolled += Math.abs(wrap(g.bank - last)); last = g.bank; peak = Math.max(peak, Math.abs(g.roll));
      if (tFull < 0 && rolled >= 2 * Math.PI) tFull = t;
      return { turn: tFull < 0 ? 1 : 0, pitch: 0, throttle: 0.8 };
    });
    const afterLet = Math.abs(f.bank);
    // a 60 deg bank, let go: it holds there 3 s (no levelling), then 20 deg: levelled
    fly(f, w, 3, (g) => jetHold(g, 60 * D1, g.gamma, 0.8));
    fly(f, w, 0.6, (g) => ({ ...jetHold(g, 60 * D1, g.gamma, 0.8), turn: 0 }));
    const b60 = f.bank;
    fly(f, w, 3, () => HANDS_OFF(0.8));
    const held = f.bank;
    fly(f, w, 3, (g) => jetHold(g, 20 * D1, 0, 0.8));
    fly(f, w, 4, () => HANDS_OFF(0.8));
    add('jet_roll', tFull > 0 && tFull < 2.4 && Math.abs(peak - c.ROLL_RATE) < 2 * D1 && Math.abs(held - b60) < 4 * D1 && Math.abs(f.bank) < 2 * D1 && f.state === 'air',
      { fullRollS: r1(tFull), peakDegPerS: deg(peak), floatplaneDegPerS: deg(PLANE.ROLL_RATE), bankAfterLetGo: deg(afterLet), heldBank: `${deg(b60)}->${deg(held)}`, levelledFrom20: deg(f.bank) });
  }

  // jet_loop: at 420 km/h, 250 m, full pull and held: the path turns through 360 deg in its vertical plane (over the
  // top inverted), back level on the same heading, no stall, under the ceiling
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 250, z: 1500, heading: Math.PI / 2, speed: 117 });
    f.engine = 1;
    let turned = 0, lastG = 0, top = 0, topKmh = 0, maxN = 0, stalled = false, inverted = false, t = 0;
    const fwd = { x: 1, y: 0 };
    fly(f, w, 30, (g, tt) => {
      t = tt;
      const v = g.velocity(), a = Math.atan2(v.y, v.x * fwd.x);
      turned += Math.max(0, wrap(a - lastG)); lastG = a;
      if (g.p.y > top) { top = g.p.y; topKmh = kmh(g.v); }
      maxN = Math.max(maxN, g.load); stalled ||= g.stalled; inverted ||= Math.abs(g.bank) > 170 * D1 && Math.abs(g.gamma) < 10 * D1;
      return { turn: 0, pitch: 1, throttle: 1 };
    }, () => turned >= 2 * Math.PI - 0.02);
    add('jet_loop', turned >= 2 * Math.PI - 0.02 && inverted && !stalled && f.state === 'air' && Math.abs(wrap(f.heading - Math.PI / 2)) < 3 * D1 && top < w.H + c.CEILING,
      { s: r1(t), inverted, stalled, height: Math.round(top - 250), topKmh, endKmh: kmh(f.v), maxG: r1(maxN), dHeading: deg(wrap(f.heading - Math.PI / 2)), dyEnd: Math.round(f.p.y - 250) });
  }

  // jet_inverted: a half roll, let go: it flies on inverted (the path held, the bank kept at 180)
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 400, z: 1500, heading: Math.PI / 2, speed: 111 });
    f.engine = 0.8;
    fly(f, w, 3, (g) => jetHold(g, Math.PI, 0, 0.8));
    fly(f, w, 6, () => HANDS_OFF(0.8));
    add('jet_inverted', Math.abs(Math.abs(f.bank) - Math.PI) < 5 * D1 && Math.abs(f.gamma) < 4 * D1 && f.load < -0.9 && f.state === 'air',
      { bank: deg(f.bank), gamma: deg(f.gamma), g: r1(f.load), dy: Math.round(f.p.y - 400) });
  }

  // jet_turn: a level 75 deg turn (~4 g) at 400 km/h held 360 deg: g and radius; it bleeds speed even at full throttle (energy)
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 3000, y: 300, z: 1500, heading: 0, speed: 111 });
    f.engine = 1;
    let turned = 0, last = f.heading, t = 0, maxDy = 0;
    fly(f, w, 60, (g, tt) => { t = tt; turned += Math.abs(wrap(g.heading - last)); last = g.heading; maxDy = Math.max(maxDy, Math.abs(g.p.y - 300)); return jetHold(g, 75 * D1, 0, 1); },
      () => turned >= 2 * Math.PI);
    add('jet_turn', turned >= 2 * Math.PI && maxDy < 25 && f.v < 111 && f.state === 'air',
      { lapS: r1(t), radius: Math.round(f.v * t / (2 * Math.PI)), g: r1(f.load), kmhEnd: kmh(f.v), maxDy: r1(maxDy) });
  }

  // jet_pitch_smooth: the floatplane's criteria (pitch_smooth): at 400 km/h W held 1 s and let go 3 s, S held 1 s and
  // let go 3 s, then a roll in and out: the nose moves at most 1 deg a step, its per-step change changes at most 0.1
  // deg, 0.4 s into the pull the nose leads the path by 2 deg+, which follows; the bank at most ROLL_RATE a step and
  // its change at most ROLL_ACCEL (no snap)
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 600, z: 1500, heading: Math.PI / 2, speed: 111 });
    f.engine = 0.8;
    const at = (t: number): PlaneInput => ({ turn: t >= 8 && t < 9 ? 1 : 0, pitch: t < 1 ? -1 : t >= 4 && t < 5 ? 1 : 0, throttle: 0.8 });
    let nose = f.gamma + f.alpha, bank = f.bank, dn0 = 0, db0 = 0, maxStep = 0, maxJerk = 0, maxRoll = 0, maxRollJerk = 0;
    let lead = 0, pathRise = 0, nose4 = 0, gamma4 = 0, alphaEnd = 0;
    for (let k = 0; k < 12 * 60; k++) {
      const t = k * c.STEP;
      if (k === 4 * 60) { nose4 = nose; gamma4 = f.gamma; }
      f.step(at(t), c.STEP, w);
      const n = f.gamma + f.alpha, dn = n - nose, db = wrap(f.bank - bank);
      if (k > 0) { maxJerk = Math.max(maxJerk, Math.abs(dn - dn0)); maxRollJerk = Math.max(maxRollJerk, Math.abs(db - db0)); }
      maxStep = Math.max(maxStep, Math.abs(dn)); maxRoll = Math.max(maxRoll, Math.abs(db));
      if (k === Math.round(4.4 * 60)) lead = (n - nose4) - (f.gamma - gamma4);
      if (k === Math.round(5.4 * 60)) pathRise = f.gamma - gamma4;
      nose = n; bank = f.bank; dn0 = dn; db0 = db;
      if (k === 8 * 60 - 1) alphaEnd = f.alpha;
    }
    const s = c.STEP * 1.01;
    add('jet_pitch_smooth', f.state === 'air' && maxStep < 1 * D1 && maxJerk < 0.1 * D1 && maxRoll < c.ROLL_RATE * s && maxRollJerk < c.ROLL_ACCEL * s * s &&
      lead > 2 * D1 && pathRise > 5 * D1 && alphaEnd < 6 * D1,
      { maxNosePerStep: deg2(maxStep), maxNoseJerk: deg2(maxJerk), maxBankPerStep: deg2(maxRoll), maxBankJerk: deg2(maxRollJerk),
        noseLeads04s: deg(lead), pathUp14s: deg(pathRise), alphaSettled: deg(alphaEnd) });
  }

  // jet_boundary: full throttle into each edge and a corner: never out, never a crash
  {
    const w = open(c), f = new PlaneFlight(c);
    const lim = { maxX: 0, maxZ: 0, minX: Infinity, minZ: Infinity, edge: false };
    let crashes = 0;
    for (const [x, z, h] of [[5500, 1500, Math.PI / 2], [3000, 2500, 0], [5500, 2500, Math.PI / 4], [500, 500, -3 * Math.PI / 4]] as const) {
      f.reset({ x, y: 300, z, heading: h, speed: 125 });
      f.engine = 1;
      const r = fly(f, w, 10, () => HANDS_OFF(1));
      crashes += r.events.filter((e) => e.type === 'crash').length;
      lim.maxX = Math.max(lim.maxX, f.p.x); lim.maxZ = Math.max(lim.maxZ, f.p.z); lim.minX = Math.min(lim.minX, f.p.x); lim.minZ = Math.min(lim.minZ, f.p.z); lim.edge ||= f.atEdge;
    }
    add('jet_boundary', lim.maxX <= w.W - c.EDGE + 1e-6 && lim.maxZ <= w.D - c.EDGE + 1e-6 && lim.minX >= c.EDGE - 1e-6 && lim.minZ >= c.EDGE - 1e-6 && lim.edge && !crashes,
      { maxX: r1(lim.maxX), maxZ: r1(lim.maxZ), minX: r1(lim.minX), minZ: r1(lim.minZ), crashes });
  }

  // jet_crash: nose down into flat ground: a crash ('terrain'); back CRASH_S later >= SAFE_AGE back along the path,
  // >= RESPAWN_AGL over the top, level, at >= RESPAWN_SPEED. A gentle touch of water: a splash too (no floats)
  {
    const w = open(c), f = new PlaneFlight(c);
    f.reset({ x: 300, y: 300, z: 1500, heading: Math.PI / 2, speed: 110 });
    f.engine = 0.8;
    const r = fly(f, w, 30, (g) => jetHold(g, 0, -20 * D1, 0.8), (_g, e) => e.some((x) => x.type === 'crash'));
    const crash = r.events.find((x) => x.type === 'crash') as { what: string; kmh: number } | undefined;
    const xCrash = f.p.x;
    const resp = fly(f, w, c.CRASH_S + 0.05, () => HANDS_OFF(0.8));
    const top = w.surface(f.p.x, f.p.z).top;
    const ww = new BoxWorld(6000, 3000, 173, 5, c.RADIUS);
    ww.add({ x0: 0, z0: 1300, x1: 6000, z1: 1700, top: 5, kind: 'terrain', water: true });
    const g = new PlaneFlight(c);
    g.reset({ x: 300, y: 5 + c.FLOAT_H + 6, z: 1500, heading: Math.PI / 2, speed: 70 });
    g.engine = 0.3;
    const rw = fly(g, ww, 30, (h) => jetHold(h, 0, Math.asin(-1 / h.v), 0.3), (_h, e) => e.some((x) => x.type === 'crash' || x.type === 'touchdown'));
    const splash = rw.events.find((x) => x.type === 'crash' || x.type === 'touchdown') as { type: string; what?: string } | undefined;
    add('jet_crash', crash?.what === 'terrain' && f.state === 'air' && f.p.y - top >= c.RESPAWN_AGL - 1e-6 && xCrash - f.p.x >= c.SAFE_AGE * c.RESPAWN_SPEED * 0.8 &&
      f.bank === 0 && f.gamma === 0 && f.v >= c.RESPAWN_SPEED && resp.events.some((e) => e.type === 'respawn') && splash?.what === 'water',
      { what: crash?.what, kmh: crash?.kmh, respawnBack: Math.round(xCrash - f.p.x), respawnAgl: Math.round(f.p.y - top), respawnKmh: kmh(f.v), gentleWater: splash?.what ?? splash?.type });
  }

  // jet_fuzz: 10 min of seeded random input (rolls, loops, throttle) over boxes: no NaN, inside the map, under the
  // ceiling, every crash respawned, the frame stays orthonormal
  {
    const w = open(c), f = new PlaneFlight(c);
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 60; i++) {
      const x = rnd() * 5800, z = rnd() * 2800;
      w.add({ x0: x, z0: z, x1: x + 20 + rnd() * 200, z1: z + 20 + rnd() * 200, top: 20 + rnd() * 150, kind: rnd() < 0.5 ? 'terrain' : 'structure' });
    }
    f.reset({ x: 500, y: 400, z: 1500, heading: Math.PI / 2, speed: 110 });
    let inp: PlaneInput = HANDS_OFF(0.8), bad = '', crashes = 0, respawns = 0;
    const fw = vec3(), up = vec3();
    for (let t = 0; t < 600 && !bad; t += c.STEP) {
      if (rnd() < 0.02) inp = { turn: Math.round(rnd() * 2 - 1) * (rnd() < 0.6 ? 1 : 0), pitch: Math.round(rnd() * 2 - 1) * (rnd() < 0.5 ? 1 : 0), throttle: rnd() };
      f.step(inp, c.STEP, w);
      for (const e of f.events.splice(0)) { if (e.type === 'crash') crashes++; if (e.type === 'respawn') respawns++; }
      const p = f.p;
      f.attitude(fw, up);
      if (![p.x, p.y, p.z, f.v, f.heading, f.gamma, f.bank, fw.x, up.y].every(Number.isFinite)) bad = `NaN at ${r1(t)}`;
      else if (Math.abs(length(fw) - 1) > 1e-6 || Math.abs(length(up) - 1) > 1e-6 || Math.abs(dot(fw, up)) > 1e-6) bad = `frame at ${r1(t)}`;
      else if (p.x < c.EDGE - 1e-6 || p.x > w.W - c.EDGE + 1e-6 || p.z < c.EDGE - 1e-6 || p.z > w.D - c.EDGE + 1e-6) bad = `outside at ${r1(t)}`;
      else if (p.y > w.H + c.CEILING + 1e-6) bad = `over the ceiling at ${r1(t)}`;
    }
    const pending = f.state === 'crashed' ? 1 : 0;
    add('jet_fuzz', !bad && crashes === respawns + pending, { minutes: 10, crashes, respawns, perMinute: r1(crashes / 10), ...(bad ? { bad } : {}) });
  }
  return out;
}
