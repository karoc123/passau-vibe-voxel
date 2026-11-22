import * as THREE from 'three';
import type { World } from '../world';
import { LifeMeshes, MAX_BIKES, MAX_PEOPLE, setCount } from './meshes';
import { farFrom, pt } from './path';
import { ACTIVE_CELL, ACTIVE_R, activeKey, DEFAULT_SEED, PED_POP_R, STEP, Traffic, type CarPose, type TrafficBodies } from './traffic';
import { Trains } from './trains';
import type { Car, Kind, Person, Pose, Rideable, TrafficData, Vec3 } from './types';

// The street life's presentation: the traffic (sim/traffic.ts: the world sim, headless, on its fixed tick) drawn
// between its last two ticks with instanced meshes, the trains, the people knocked down or fallen into a hole (an
// effect: shoved, tipping over, no physics), picking an agent on screen. Nothing here feeds back into the sim but the
// player's own doings (keep, takeWheel, knockDown).

export { CAR_POP_R, PED_POP_R } from './traffic';
// the traffic signals drawn: those within ACTIVE_R + HEADS_OUT of the active circle's centre (further out a pole is a
// fraction of a pixel wide)
const HEADS_OUT = 600;
// people knocked down by the driven car (knockDown): shoved along the hit (at most FALL_V m/s, slowing at FALL_DRAG
// per s), tipping over flat in FALL_S s, then lying there; at most MAX_FALLEN at once, each gone after FALLEN_S s once
// PED_POP_R from the viewer
const FALL_V = 7, FALL_DRAG = 3.5, FALL_S = 0.45, MAX_FALLEN = 8, FALLEN_S = 40;
// fallen into a hole (the traffic's dropped): down at G m/s^2 until the ground (World.support), gone LANDED_S s after
const G = 9.81, LANDED_S = 2;

// a person (and their bike) knocked down: where they are, which way they were shoved (unit dx, dz) how fast, for how long
// (vy: falling into an edited hole, its vertical speed; land: when it met the ground)
interface Fallen { col: THREE.Color; bike: boolean; at: THREE.Vector3; h: number; dx: number; dz: number; v: number; t: number; bikeAt: THREE.Vector3 | null; vy?: number; land?: number }

export interface Picked { kind: Kind; obj: Rideable; label: string }

const setRp = (o: { rp?: Vec3 }, x: number, y: number, z: number) => { const p = (o.rp ??= { x, y, z }); p.x = x; p.y = y; p.z = z; return p; };

export class StreetLife {
  world: World | null = null;
  readonly traffic: Traffic;
  readonly trains: Trains;
  private fallen: Fallen[] = [];
  private readonly M: LifeMeshes;
  private readonly heads: [number, number, number, number, number, number][];
  private headGrid: Map<number, number[]> | null = null;
  private headsFor: { x: number; z: number } | null = null;
  // the signal heads drawn (their indices)
  private headAct: number[] = [];
  private viewer: { x: number; z: number; y?: number } = { x: 0, z: 0 };
  private readonly cols = new Map<string, THREE.Color>();

  constructor(scene: THREE.Scene, data: TrafficData, seed = DEFAULT_SEED) {
    this.traffic = new Traffic(data, seed);
    this.heads = data.heads ?? [];
    this.M = new LifeMeshes(scene, this.heads);
    this.trains = new Trains(data.trains ?? []);
    this.M.group.add(this.trains.group);
  }

  get group() { return this.M.group; }
  // (the sim's, as the drive and the walk see them)
  get cars() { return this.traffic.cars; }
  get people() { return this.traffic.people; }
  get riders() { return this.traffic.riders; }
  get peds() { return this.traffic.peds; }
  get keep() { return this.traffic.keep; }
  set keep(k: Rideable | null) { this.traffic.keep = k; }
  get bodies() { return this.traffic.bodies; }
  set bodies(b: TrafficBodies | null) { this.traffic.bodies = b; }
  get day() { return this.traffic.day; }
  set day(d: number) { this.traffic.day = d; }
  roadVehicles() { return this.traffic.roadVehicles(); }
  takeWheel(car: Car) { return this.traffic.takeWheel(car); }
  edited(box: [number, number, number, number], cleared = false) { this.traffic.edited(box, cleared); }

  // focus: the middle of what is simulated (the active circle: what is looked at); viewer: where it is seen from (the
  // camera; by default the focus, on the ground), what agents come and go far from
  update(dt: number, hour: number, night: number, focus: { x: number; z: number }, viewer: { x: number; z: number; y?: number } = focus) {
    const T = this.traffic;
    T.ground = this.world;
    this.viewer = { x: viewer.x, z: viewer.z, y: viewer.y };
    T.update(dt, hour, focus, viewer);
    if (T.active && T.active !== this.headsFor) this.placeHeads(T.active);
    this.trains.update(Math.min(dt, 0.1), ((hour % 24) + 24) % 24, this.viewer);
    for (const p of T.dropped) if (p.rp) this.addFallen(p, 0, 1, 0, 0);
    T.dropped = [];
    this.render(Math.min(dt, 0.1), night, T.acc);
  }

  // the signal heads near the active circle (and their poles)
  private placeHeads(A: { x: number; z: number }) {
    const C = ACTIVE_CELL, HR = ACTIVE_R + HEADS_OUT, { x, z } = A;
    if (!this.headGrid) {
      this.headGrid = new Map();
      this.heads.forEach(([hx, hy], i) => { const k = activeKey(Math.floor(hx / C), Math.floor(hy / C)); const l = this.headGrid!.get(k); if (l) l.push(i); else this.headGrid!.set(k, [i]); });
    }
    this.headAct = [];
    for (let cy = Math.floor((z - HR) / C); cy <= Math.floor((z + HR) / C); cy++)
      for (let cx = Math.floor((x - HR) / C); cx <= Math.floor((x + HR) / C); cx++)
        for (const i of this.headGrid.get(activeKey(cx, cy)) ?? []) if ((this.heads[i][0] - x) ** 2 + (this.heads[i][1] - z) ** 2 < HR * HR) this.headAct.push(i);
    this.headAct.sort((a, b) => a - b);
    this.M.poles(this.heads, this.headAct);
    this.headsFor = A;
  }

  private far(x: number, y: number, z: number, r: number) { return farFrom(this.viewer, x, y, z, r); }

  private col(hex: string) {
    let c = this.cols.get(hex);
    if (!c) this.cols.set(hex, c = new THREE.Color(hex));
    return c;
  }

  // ------------------------------------------------------------------ drawing
  // positions between the last two ticks (lead: time since the last one), so motion is smooth at any frame rate
  private render(dt: number, night: number, lead: number) {
    this.drawCars(lead / STEP, night);
    this.trains.render(0, night);
    const n = this.drawPeople(dt, lead) + this.drawRiders(dt, lead, this.people.length);
    setCount(n + this.drawFallen(dt, n), this.M.legs, this.M.torso);
    this.drawSignals();
  }

  // a: how far from the last but one tick to the last (0..1)
  private drawCars(a: number, night: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const tailOff = new THREE.Color(0.55, 0.06, 0.05), tailOn = new THREE.Color(2.2, 0.15, 0.1), tail = new THREE.Color();
    const eu = new THREE.Euler(0, 0, 0, 'YXZ'), meshes = [M.body, M.dark, M.head, M.tail], T = this.traffic, back = 1 - a, B = this.traffic.bodies;
    const pose: CarPose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
    const draw = (c: Car, i: number) => {
      B?.pose(c, a);
      m.compose(pos.set(c.rp!.x, c.rp!.y, c.rp!.z), q.setFromEuler(eu.set(-(c.pitch ?? 0), c.rh ?? 0, c.roll ?? 0)), sc.set(1, c.bus ? 1.75 : 1, c.bus ? c.len / 4.4 : 1));
      for (const mesh of meshes) mesh.setMatrixAt(i, m);
      M.body.setColorAt(i, this.col(c.col));
      M.tail.setColorAt(i, tail.copy(c.brake ? tailOn : tailOff).multiplyScalar(c.brake ? 1 : 0.4 + 1.2 * night));
    };
    T.cars.forEach((c, i) => {
      T.carPose(c, c.s - c.ds * back, c.off - c.dOff * back, pose);
      setRp(c, pose.x, pose.y, pose.z);
      c.rh = pose.h; c.pitch = pose.pitch; c.roll = 0;
      draw(c, i);
    });
    T.detachedCars.forEach((c, i) => draw(c, T.cars.length + i));
    setCount(T.cars.length + T.detachedCars.length, M.body, M.dark, M.head, M.tail);
    M.headMat.color.setRGB(0.85 + 2.2 * night, 0.82 + 2.0 * night, 0.72 + 1.6 * night);
  }

  private drawPeople(dt: number, lead: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), pos = new THREE.Vector3(), k = 1 - Math.exp(-dt * 10), T = this.traffic;
    this.people.forEach((p, i) => {
      let bob = 0;
      if (p.ctl) { // walked by the player (nav): where they put them
        const C = p.ctl;
        setRp(p, C.x, C.y, C.z); p.rh = C.h;
        if (C.moving) { p.ph += dt * 9; bob = Math.sin(p.ph); }
      } else {
        const ds = p.wait ? 0 : p.v * lead;
        T.personPoint(p, ds, A);
        T.personPoint(p, ds + 0.5, B);
        const h = Math.atan2(B.x - A.x, B.y - A.y);
        if (!p.rp || Math.hypot(p.rp.x - A.x, p.rp.z - A.y) > 6) { setRp(p, A.x, A.z, A.y); p.rh = h; }
        const r = p.rp!;
        r.x += (A.x - r.x) * k; r.y += (A.z - r.y) * k; r.z += (A.y - r.z) * k;
        p.rh = (p.rh ?? h) + Math.atan2(Math.sin(h - (p.rh ?? h)), Math.cos(h - (p.rh ?? h))) * k;
        if (!p.wait) bob = Math.sin(p.ph + ds * 4.2);
      }
      pos.set(p.rp!.x, p.rp!.y, p.rp!.z);
      pos.y += 0.05 * Math.abs(bob);
      m.compose(pos, q.setFromAxisAngle(up, p.rh!), one);
      M.legs.setMatrixAt(i, m); M.torso.setMatrixAt(i, m);
      M.torso.setColorAt(i, this.col(p.col));
    });
    return this.people.length;
  }

  // a rider on a bike: the person sits 0.45 m up, keeping right of the way's line; the bike under them
  private drawRiders(dt: number, lead: number, i0: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), pos = new THREE.Vector3(), k = 1 - Math.exp(-dt * 10), sit = new THREE.Vector3(1, 0.82, 1);
    const one = new THREE.Vector3(1, 1, 1), T = this.traffic;
    this.riders.forEach((p, i) => {
      const ds = p.wait ? 0 : p.v * lead;
      T.personPoint(p, ds, A);
      T.personPoint(p, ds + 1, B);
      const h = Math.atan2(B.x - A.x, B.y - A.y);
      if (!p.rp || Math.hypot(p.rp.x - A.x, p.rp.z - A.y) > 8) { setRp(p, A.x, A.z, A.y); p.rh = h; }
      const r = p.rp!;
      r.x += (A.x - r.x) * k; r.y += (A.z - r.y) * k; r.z += (A.y - r.z) * k;
      p.rh = (p.rh ?? h) + Math.atan2(Math.sin(h - (p.rh ?? h)), Math.cos(h - (p.rh ?? h))) * k;
      q.setFromAxisAngle(up, p.rh!);
      pos.set(r.x, r.y, r.z);
      M.bike.setMatrixAt(i, m.compose(pos, q, one));
      pos.y += 0.45;
      m.compose(pos, q, sit);
      M.legs.setMatrixAt(i0 + i, m); M.torso.setMatrixAt(i0 + i, m);
      M.torso.setColorAt(i0 + i, this.col(p.col));
    });
    setCount(this.riders.length, M.bike);
    return this.riders.length;
  }

  // A person walking or cycling hit by the driven car at (vx, vz) m/s: out of the crowd, shoved away along the hit and
  // falling over (drawFallen), no physics. Returns whether they were there.
  knockDown(p: Person, vx: number, vz: number) {
    if (!p.rp || !this.traffic.removePerson(p)) return false;
    const v = Math.hypot(vx, vz) || 1;
    this.addFallen(p, vx / v, vz / v, Math.min(FALL_V, v * 0.6));
    return true;
  }

  // a person (drawn: rp) falls over, shoved along (dx, dz) at v m/s; vy: falling into a hole too, at vy m/s
  private addFallen(p: Person, dx: number, dz: number, v: number, vy?: number) {
    if (this.fallen.length >= MAX_FALLEN) { // the oldest out of sight (else the oldest)
      const i = this.fallen.findIndex((f) => this.far(f.at.x, f.at.z, f.at.y, PED_POP_R));
      this.fallen.splice(Math.max(0, i), 1);
    }
    const at = new THREE.Vector3(p.rp!.x, p.rp!.y, p.rp!.z);
    this.fallen.push({ col: this.col(p.col), bike: !!p.bike, at, h: p.rh ?? 0, dx, dz, v, t: 0, bikeAt: p.bike ? at.clone() : null, vy });
  }

  // the people knocked down further than r m from (x, z) gone (left behind; never in sight of the viewer)
  clearFallen(x: number, z: number, r: number) {
    this.fallen = this.fallen.filter((f) => Math.hypot(f.at.x - x, f.at.z - z) <= r || !this.far(f.at.x, f.at.z, f.at.y, PED_POP_R));
  }

  // the people knocked down, drawn from instance i0 on: sliding along the shove, tipping over towards it (about the
  // horizontal axis across it, at their feet) until flat on the ground, a little hop as they go; a bike on its side
  // where it was hit, sliding half as far
  private drawFallen(dt: number, i0: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), tip = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(), pos = new THREE.Vector3();
    this.fallen = this.fallen.filter((f) => (f.land === undefined || f.t - f.land <= LANDED_S) && (f.t < FALLEN_S || !this.far(f.at.x, f.at.z, f.at.y, PED_POP_R)));
    const n = Math.min(this.fallen.length, MAX_PEOPLE + MAX_BIKES - i0);
    let bikes = 0;
    for (let i = 0; i < n; i++) {
      const f = this.fallen[i];
      f.t += dt;
      const step = f.v * dt;
      f.at.x += f.dx * step; f.at.z += f.dz * step;
      if (f.bikeAt) { f.bikeAt.x += f.dx * step * 0.5; f.bikeAt.z += f.dz * step * 0.5; }
      f.v *= Math.exp(-FALL_DRAG * dt);
      if (f.vy !== undefined) { // (into a hole: down until the ground)
        if (f.land === undefined && this.world) {
          const g = this.world.support(f.at.x, f.at.z, f.at.y);
          f.vy -= G * dt;
          f.at.y += f.vy * dt;
          if (f.at.y <= g) { f.at.y = g; f.land = f.t; }
          if (f.bikeAt) f.bikeAt.y = f.at.y;
        }
      } else if (this.world) f.at.y = this.world.surface(f.at.x, f.at.z, f.at.y);
      const k = Math.min(1, f.t / FALL_S), a = k * k * Math.PI / 2;
      // (up turned towards the shove: about up x shove)
      tip.setFromAxisAngle(axis.set(f.dz, 0, -f.dx), a);
      q.setFromAxisAngle(up, f.h).premultiply(tip);
      pos.copy(f.at);
      pos.y += Math.sin(Math.PI * k) * 0.3 + 0.12 * Math.sin(a);
      m.compose(pos, q, one);
      M.legs.setMatrixAt(i0 + i, m); M.torso.setMatrixAt(i0 + i, m);
      M.torso.setColorAt(i0 + i, f.col);
      if (f.bikeAt && this.riders.length + bikes < MAX_BIKES) {
        // (on its side: about its own length)
        q.setFromAxisAngle(up, f.h).multiply(tip.setFromAxisAngle(axis.set(0, 0, 1), a));
        M.bike.setMatrixAt(this.riders.length + bikes++, m.compose(f.bikeAt, q, one));
      }
    }
    if (bikes) setCount(this.riders.length + bikes, M.bike);
    return n;
  }

  private drawSignals() {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3(), col = new THREE.Color();
    const LAMP = { R: [2.2, 0.12, 0.08, 3.95], Y: [2.2, 1.3, 0.1, 3.6], G: [0.1, 2.0, 0.6, 3.25] };
    this.headAct.forEach((h, i) => {
      const [x, row, gz, rot, ctrl, axis] = this.heads[h];
      const [r, g, b, hy] = LAMP[this.traffic.signal(ctrl, axis)], a = rot + Math.PI;
      m.compose(pos.set(x + Math.sin(a) * 0.19, gz + hy, row + Math.cos(a) * 0.19), q.setFromAxisAngle(up, a), one);
      M.lamp.setMatrixAt(i, m);
      M.lamp.setColorAt(i, col.setRGB(r, g, b));
    });
    setCount(this.headAct.length, M.lamp);
  }

  private listOf(kind: Kind): Rideable[] { return kind === 'car' ? this.roadVehicles() : kind === 'person' ? this.people : []; }

  // the agent nearest to screen point (cx, cy) within px, at least minPx tall on screen, and visible
  pick(camera: THREE.PerspectiveCamera, cx: number, cy: number, px: number, minPx: number, visible: (to: THREE.Vector3) => boolean, skip: Rideable | null): Picked | null {
    const v = new THREE.Vector3(), cand: (Picked & { score: number; at: THREE.Vector3 })[] = [];
    const f = (innerHeight / 2) / Math.tan(camera.fov * Math.PI / 360);
    const scr = (x: number, y: number, z: number) => { v.set(x, y, z).project(camera); return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; };
    const test = (kind: Kind, obj: Rideable, x: number, y: number, z: number, size: number, label: string, h = 0, len = 0) => {
      if (obj === skip) return;
      const c = scr(x, y, z);
      if (!c) return;
      const dist = camera.position.distanceTo(v.set(x, y, z)), onScreen = size * f / dist;
      if (onScreen < minPx) return;
      let d = Math.hypot(c[0] - cx, c[1] - cy);
      if (len) { // the distance to its body, back to front, plus half a second behind: you tap where you saw it
        const back = len / 2 + ('v' in obj ? obj.v : 0) * 0.5, hx = Math.sin(h), hz = Math.cos(h);
        const a = scr(x - hx * back, y, z - hz * back), b = scr(x + hx * len / 2, y, z + hz * len / 2);
        if (a && b) {
          const ex = b[0] - a[0], ey = b[1] - a[1], t = Math.max(0, Math.min(1, ((cx - a[0]) * ex + (cy - a[1]) * ey) / (ex * ex + ey * ey || 1)));
          d = Math.hypot(a[0] + ex * t - cx, a[1] + ey * t - cy);
        }
      }
      const r = Math.max(px, onScreen * 0.55);
      if (d < r) cand.push({ kind, obj, label, score: d / r + dist / 3000, at: new THREE.Vector3(x, y + size * 0.3, z) });
    };
    for (const c of this.roadVehicles()) if (c.rp) test('car', c, c.rp.x, c.rp.y + 0.8, c.rp.z, c.bus ? 6 : 3.5, c.bus ? 'bus' : 'car', c.rh, c.len);
    for (const p of this.people) if (p.rp) test('person', p, p.rp.x, p.rp.y + 0.9, p.rp.z, 1.6, 'person');
    cand.sort((a, b) => a.score - b.score);
    return cand.slice(0, 6).find((c) => visible(c.at.clone().sub(camera.position))) ?? null;
  }

  // where an agent is now, or null once it has left
  pose(kind: Kind, obj: Rideable): Pose | null {
    if (!obj.rp || !this.listOf(kind).includes(obj)) return null;
    return { x: obj.rp.x, y: obj.rp.y, z: obj.rp.z, h: obj.rh ?? 0 };
  }

  // the nearest one of a kind, preferring one that moves
  nearest(kind: Kind, from: { x: number; z: number }, skip: Rideable | null): Picked | null {
    let best: Rideable | null = null, bd = Infinity;
    for (const o of this.listOf(kind)) {
      if (o === skip || !o.rp) continue;
      const d = Math.hypot(o.rp.x - from.x, o.rp.z - from.z), dd = d + (kind === 'person' || o.v > 1.5 ? 0 : 400);
      if (dd < bd && d > (kind === 'person' ? 3 : 8)) { bd = dd; best = o; }
    }
    if (!best) return null;
    const label = best.kind === 'car' ? (best.bus ? 'bus' : 'car') : 'person';
    return { kind, obj: best, label };
  }
}
