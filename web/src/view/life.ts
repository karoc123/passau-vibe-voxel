import * as THREE from 'three';
import { LifeMeshes, MAX_BIKES, MAX_PEOPLE, OPEN_CARS, setCount } from './meshes';
import { farFrom, pt } from '../sim/path';
import { lerp, wrapAngle } from '../util';
import { ACTIVE_CELL, activeKey, PED_POP_R, STEP, type CarPose } from '../sim/road-net';
import type { SimClient } from '../client/sim-client';
import { Trains } from './trains';
import { Boats } from './boats';
import { Avatars, HIPS, type Seated } from './avatars';
import { driverPlace, pilotPlace, seatPlace, type SeatPlace } from './seats';
import type { Car, Kind, Rideable } from '../sim/types';
import type { Pose, RoadPose } from '../sim/contract/pose';
import { VEHICLE_IDS, vehicleOf } from '../sim/vehicles';
import type { CraftType, EntityRef, VehicleId } from '../sim/contract/ids';
import type { CoachPose } from '../sim/coaches';
import { MAX_CARS, WRECK_COL } from '../sim/contract/agents';
import { wreckSmoke } from './wreck-smoke';
import { AVATAR_SHAPE, carShape, COACH_SHAPE, craftSolids, solidAt, vesselShape, type Solid } from '../sim/solids';

// The street life's presentation: the world sim's traffic (sim/world-sim.ts, headless, on its fixed tick; read through
// its client, client/sim-client.ts TrafficMirror, ticked by main.ts) drawn between its last two ticks with instanced
// meshes, the trains and the boats, the people knocked down or fallen into a hole (its events, drawn as an effect:
// thrown or dropped, no physics), picking an agent on screen. It only draws: nothing here feeds back into the sim,
// and nothing is written into the sim's objects: where an agent is drawn is kept here, by id (Drawn).

// the road traffic drawn as flow out to FAR_R beyond the agents' circle (further out a car is a pixel), and the traffic
// signals as far (further out a pole is a fraction of a pixel wide), placed again once it is HEADS_MOVE m from where
// they were placed
const FAR_R = 1500;
const HEADS_MOVE = 120;
// a far road's cars left out where the camera cannot see them, the view widened by VIEW_SLACK of the distance (~9°:
// the camera is last frame's and turns on before this one is drawn; a car's shadow reaching in at a low sun): on a
// phone the far traffic was most of the street life's time, and most of it behind or beside the view
const VIEW_SLACK = 0.15;
// people knocked down by a driven car (WorldSim's events: struck) are thrown: off at THROW of the car's speed along it and
// LIFT of it upwards, their middle (MID m up the body) on a ballistic arc, turning over backwards to lie flat (their
// middle LIE m up) as they come down, keeping LAND_KEEP of their speed on landing and sliding to a stop at SLIDE m/s^2.
// Roughly a real forward throw: ~6 m at 30 km/h, ~15 m at 50. Their bike slides along the hit (at most FALL_V m/s,
// slowing at FALL_DRAG per s). At most MAX_FALLEN at once, each gone after FALLEN_S s once PED_POP_R from the viewer.
const THROW = 0.85, LIFT = 0.35, MID = 0.9, LIE = 0.12, LAND_KEEP = 0.5, SLIDE = 7;
const FALL_V = 7, FALL_DRAG = 3.5, FALL_S = 0.45, MAX_FALLEN = 8, FALLEN_S = 40;
// fallen into a hole (WorldSim's events: dropped): down at G m/s^2 until the ground (World.support), gone LANDED_S s after
const G = 9.81, LANDED_S = 2;
// the drawn lean of a motorbike tracking its lane
const LEAN_SAMPLE = 2, LEAN_MAX = 0.7, LEAN_S = 0.12;
const SEAT_EULER = new THREE.Euler(0, 0, 0, 'YXZ'), SEAT_BASIS = new THREE.Matrix4(), SEAT_LEFT = new THREE.Vector3();

// a person (and their bike) fallen: where they are (their feet; thrown: their middle), which way they were shoved (unit
// dx, dz) how fast, for how long (vy: vertical speed, thrown or falling into an edited hole; land: when it met the ground)
interface Fallen { col: THREE.Color; bike: boolean; at: THREE.Vector3; h: number; dx: number; dz: number; v: number; t: number; bikeAt: THREE.Vector3 | null; vy?: number; land?: number; thrown?: Thrown }
// a person thrown: turned over backwards by a rad, turning at spin rad/s until flat; their bike's speed; g0: where they
// were hit, the ground without a Ground
interface Thrown { a: number; spin: number; bv: number; g0: number }

/** an agent of the street life: a car (Car.id) or a person (Person.id) */
export interface AgentRef extends EntityRef { kind: Kind }
/** an agent picked on screen (or the nearest of a kind): which one, and what it is called */
export interface Picked { ref: AgentRef; label: string }

// where an agent was drawn last (a car's ground point between its axles, a person's feet; heading, nose up, left side
// up), and what its drawing carries from frame to frame: a motorbike's lean (tracking its lane); frame: the frame it was drawn in (one not drawn in the last frame
// has left the traffic: its entry goes)
interface Drawn extends RoadPose { lean?: number; frame: number }

export class StreetLife {
  private readonly trains = new Trains();
  private boats: Boats | null = null;
  private fallen: Fallen[] = [];
  private readonly M: LifeMeshes;
  private readonly heads: [number, number, number, number, number, number][];
  private headGrid: Map<number, number[]> | null = null;
  private headsFor: { x: number; z: number } | null = null;
  // the signal heads drawn (their indices)
  private headAct: number[] = [];
  private viewer: { x: number; z: number; y?: number } = { x: 0, z: 0 };
  private readonly view = new THREE.Frustum();
  private readonly viewMat = new THREE.Matrix4();
  private readonly viewAt = new THREE.Vector3();
  // the far traffic drawn only within view (the camera this frame was given), else all round
  private viewOn = false;
  private readonly cols = new Map<string, THREE.Color>();
  // the agents as drawn, by id: the cars (in the traffic and out of it), the people (on foot and riders)
  private readonly drawnCars = new Map<number, Drawn>();
  private readonly drawnPeople = new Map<number, Drawn>();
  /** the other players on foot, a figure each (never the crowd's) */
  readonly avatars = new Avatars();
  /** the camera at the player's own eyes in their seat (a car's dashcam, a passenger's seat view): their own figure not
   * drawn, the others in the vehicle are; elsewhere (a chase view) the player is drawn in their seat too */
  ownEyes = false;
  private frame = 0;
  // the train coaches drawn this frame (solids)
  private coaches: CoachPose[] = [];
  // how far back from the last tick the trains and boats are drawn this frame (0..1; solids)
  private back = 0;
  // the world tick whose events were drawn last (WorldSim.eventsSince)
  private seen: number;

  constructor(scene: THREE.Scene, private readonly client: SimClient) {
    this.heads = client.traffic.heads;
    this.seen = client.tick;
    this.M = new LifeMeshes(scene, this.heads);
    this.M.group.add(this.trains.group, this.avatars.group);
  }

  get group() { return this.M.group; }
  private get traffic() { return this.client.traffic; }
  private get people() { return this.traffic.people; }
  private get riders() { return this.traffic.riders; }

  // the sim as it is after its update this frame (WorldSim.update; its events since the last drawn), drawn; viewer:
  // where it is seen from (the camera), what the people knocked down are gone far from; camera: what it sees (the far
  // traffic only drawn there), none: all round
  update(dt: number, night: number, viewer: { x: number; z: number; y?: number }, camera?: THREE.Camera) {
    const T = this.traffic, events = this.client.eventsSince(this.seen);
    this.seen = this.client.tick;
    if (T.boats && !this.boats) {
      this.boats = new Boats();
      this.group.add(this.boats.group);
    }
    this.viewer = { x: viewer.x, z: viewer.z, y: viewer.y };
    this.viewOn = !!camera;
    if (camera) {
      camera.updateMatrixWorld();
      this.view.setFromProjectionMatrix(this.viewMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      this.viewAt.setFromMatrixPosition(camera.matrixWorld);
    }
    const H = this.headsFor;
    if (!H || (H.x - viewer.x) ** 2 + (H.z - viewer.z) ** 2 > HEADS_MOVE * HEADS_MOVE) this.placeHeads({ x: viewer.x, z: viewer.z });
    for (const e of events) {
      const d = e.kind === 'dropped' && this.drawnPeople.get(e.person);
      if (d) this.addFallen(e.col, e.bike, d, d.h, 0, 1, 0, 0);
    }
    for (const e of events) {
      if (e.kind !== 'struck') continue;
      const { col, bike, pose, vx, vz } = e, v = Math.hypot(vx, vz) || 1;
      this.addFallen(col, bike, pose, pose.h, vx / v, vz / v, 0);
      const f = this.fallen.at(-1)!, vy = LIFT * v;
      f.at.y += MID; f.v = THROW * v; f.vy = vy;
      // (flat when the middle is down at LIE: the time to there from MID at vy)
      f.thrown = { a: 0, spin: Math.PI / 2 * G / (vy + Math.sqrt(vy * vy + 2 * G * (MID - LIE))), bv: Math.min(FALL_V, v * 0.6), g0: pose.y };
    }
    this.render(Math.min(dt, 0.1), night, T.acc);
  }

  // the signal heads near the viewer (and their poles)
  private placeHeads(A: { x: number; z: number }) {
    const C = ACTIVE_CELL, HR = FAR_R, { x, z } = A;
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

  // whether a sphere (centre x, y, z, radius r) is within the view widened by VIEW_SLACK
  private readonly inView = (x: number, y: number, z: number, r: number) => {
    const c = this.viewPt.set(x, y, z), s = -(r + VIEW_SLACK * c.distanceTo(this.viewAt));
    for (const p of this.view.planes) if (p.distanceToPoint(c) < s) return false;
    return true;
  };
  private readonly viewPt = new THREE.Vector3();

  private far(x: number, y: number, z: number, r: number) { return farFrom(this.viewer, x, y, z, r); }

  private col(hex: string) {
    let c = this.cols.get(hex);
    if (!c) this.cols.set(hex, c = new THREE.Color(hex));
    return c;
  }

  // ------------------------------------------------------------------ drawing
  // trains, boats and avatars between their last two ticks (lead: time since the last one), the cars and people where
  // the mirror reckons them now, so motion is smooth at any frame rate
  private render(dt: number, night: number, lead: number) {
    this.frame++;
    this.openCars();
    this.drawCars(lead / STEP, night, dt);
    const back = this.back = 1 - lead / STEP;
    this.coaches = [...this.traffic.trains.coaches()];
    this.trains.render(this.coaches, night);
    if (this.traffic.boats) this.boats?.render(this.traffic.boats, back, night);
    const n = this.drawPeople(dt) + this.drawRiders(dt, this.people.length);
    const C = this.client, seated = new Set<string>(C.drivers().map(([, p]) => p));
    for (const c of C.crafts()) if (c.pilot !== null) seated.add(c.pilot);
    for (const [, , p] of C.passengers()) seated.add(p);
    this.avatars.update(this.traffic.avatars, C.player, seated, lead / STEP, dt, (av, a, out) => this.traffic.avatarPose(av, a, out), this.sitting());
    setCount(n + this.drawFallen(dt, n), this.M.legs, this.M.torso);
    this.drawSignals();
    for (const m of [this.drawnCars, this.drawnPeople]) for (const [id, d] of m) if (d.frame !== this.frame) m.delete(id);
  }

  // agent id's entry in m, marked drawn this frame (a new one at x, y, z if it has none)
  private entry(m: Map<number, Drawn>, id: number, x: number, y: number, z: number) {
    let d = m.get(id);
    if (!d) m.set(id, d = { x, y, z, h: 0, pitch: 0, roll: 0, frame: this.frame });
    d.frame = this.frame;
    return d;
  }

  // a: how far from the last but one tick to the last (0..1)
  private drawCars(a: number, night: number, dt: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const tailOff = new THREE.Color(0.55, 0.06, 0.05), tailOn = new THREE.Color(2.2, 0.15, 0.1), tail = new THREE.Color();
    const eu = new THREE.Euler(0, 0, 0, 'YXZ'), T = this.traffic, B = this.traffic.bodies;
    const pose: CarPose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
    const before = pt(), middle = pt(), after = pt(), ease = 1 - Math.exp(-dt / LEAN_S);
    const laneLean = (c: Car, s: number, off: number) => {
      if (B?.owns(c)) return 0;
      const centre = s - (c.len - 1.2) / 2;
      T.pathPoint(c, centre - LEAN_SAMPLE, before, off);
      T.pathPoint(c, centre, middle, off);
      T.pathPoint(c, centre + LEAN_SAMPLE, after, off);
      const ax = middle.x - before.x, az = middle.y - before.y;
      const bx = after.x - middle.x, bz = after.y - middle.y;
      // Signed heading change over the distance between the centres of the two chords.
      const turn = Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
      const distance = Math.max(1, (Math.hypot(ax, az) + Math.hypot(bx, bz)) / 2);
      return THREE.MathUtils.clamp(Math.atan(c.v * c.v * turn / (G * distance)), -LEAN_MAX, LEAN_MAX);
    };
    // (each type its own meshes, its instances counted)
    const n = {} as Record<VehicleId, number>, no = {} as Record<VehicleId, number>;
    for (const id of VEHICLE_IDS) n[id] = no[id] = 0;
    const draw = (c: Car, d: Drawn, lean = 0) => {
      const p = B?.pose(c, a, d);
      if (p && p !== d) { d.x = p.x; d.y = p.y; d.z = p.z; d.h = p.h; d.pitch = p.pitch; d.roll = p.roll; }
      const t = vehicleOf(c), open = this.opened.has(c.id) && no[t.id] < OPEN_CARS;
      const V = open ? M.open[t.id] : M.vehicles[t.id], i = open ? no[t.id]++ : n[t.id]++;
      m.compose(pos.set(d.x, d.y, d.z), q.setFromEuler(eu.set(-(d.pitch ?? 0), d.h ?? 0, (d.roll ?? 0) + lean)), sc.set(1, 1, c.len / t.len));
      V.body.setMatrixAt(i, m); V.dark.setMatrixAt(i, m); V.head.setMatrixAt(i, m); V.tail.setMatrixAt(i, m);
      if (open) M.open[t.id].pane.setMatrixAt(i, m);
      V.body.setColorAt(i, this.col(c.col));
      V.tail.setColorAt(i, tail.copy(c.brake ? tailOn : tailOff).multiplyScalar(c.brake ? 1 : 0.4 + 1.2 * night));
    };
    for (const c of T.cars) {
      // (where the mirror reckons it now)
      const s = c.s, off = c.off;
      T.carPose(c, s, off, pose);
      const d = this.entry(this.drawnCars, c.id, pose.x, pose.y, pose.z);
      d.x = pose.x; d.y = pose.y; d.z = pose.z;
      d.h = pose.h; d.pitch = pose.pitch; d.roll = 0;
      let lean = 0;
      if (c.vt === 'moto') {
        const previous = d.lean ?? 0;
        lean = previous + (laneLean(c, s, off) - previous) * ease;
        d.lean = lean;
      }
      draw(c, d, lean);
    }
    // (out of the traffic: from where it was drawn last; never drawn, from where it was parked, heading 0 until its
    // bodies' pose says otherwise)
    // (a wreck, charred by the host, smokes)
    for (const c of T.detachedCars) {
      const at = c.detachedPose ?? { x: 0, y: 0, z: 0 }, d = this.entry(this.drawnCars, c.id, at.x, at.y, at.z);
      draw(c, d);
      if (c.col === WRECK_COL) wreckSmoke.at(`car:${c.id}`, d.x, d.y + 1, d.z, 0.8);
    }
    T.farCars(this.viewer.x, this.viewer.z, FAR_R, (p, f, len) => {
      const t = vehicleOf(f), V = M.vehicles[t.id];
      if (n[t.id] >= MAX_CARS) return;
      const i = n[t.id]++;
      m.compose(pos.set(p.x, p.y, p.z), q.setFromEuler(eu.set(-p.pitch, p.h, 0)), sc.set(1, 1, len / t.len));
      V.body.setMatrixAt(i, m); V.dark.setMatrixAt(i, m); V.head.setMatrixAt(i, m); V.tail.setMatrixAt(i, m);
      V.body.setColorAt(i, this.col(f.col));
      V.tail.setColorAt(i, tail.copy(tailOff).multiplyScalar(0.4 + 1.2 * night));
    }, this.viewOn ? this.inView : undefined);
    for (const id of VEHICLE_IDS) {
      const V = M.vehicles[id], O = M.open[id];
      setCount(n[id], V.body, V.dark, V.head, V.tail);
      V.body.visible = V.dark.visible = V.head.visible = V.tail.visible = n[id] > 0;
      setCount(no[id], O.body, O.dark, O.head, O.tail, O.pane);
      O.body.visible = O.dark.visible = O.head.visible = O.tail.visible = O.pane.visible = no[id] > 0;
    }
    M.headMat.color.setRGB(0.85 + 2.2 * night, 0.82 + 2.0 * night, 0.72 + 1.6 * night);
  }

  private drawPeople(dt: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), pos = new THREE.Vector3(), k = 1 - Math.exp(-dt * 10), T = this.traffic;
    this.people.forEach((p, i) => {
      let bob = 0;
      // (where the mirror reckons them now)
      T.personPoint(p, 0, A);
      T.personPoint(p, 0.5, B);
      const r = this.follow(p.id, A, Math.atan2(B.x - A.x, B.y - A.y), 6, k);
      if (!p.wait) bob = Math.sin(p.ph);
      pos.set(r.x, r.y, r.z);
      pos.y += 0.05 * Math.abs(bob);
      m.compose(pos, q.setFromAxisAngle(up, r.h), one);
      M.legs.setMatrixAt(i, m); M.torso.setMatrixAt(i, m);
      M.torso.setColorAt(i, this.col(p.col));
    });
    return this.people.length;
  }

  // a rider on a bike: the person sits 0.45 m up, keeping right of the way's line; the bike under them
  private drawRiders(dt: number, i0: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), pos = new THREE.Vector3(), k = 1 - Math.exp(-dt * 10), sit = new THREE.Vector3(1, 0.82, 1);
    const one = new THREE.Vector3(1, 1, 1), T = this.traffic;
    this.riders.forEach((p, i) => {
      T.personPoint(p, 0, A);
      T.personPoint(p, 1, B);
      const r = this.follow(p.id, A, Math.atan2(B.x - A.x, B.y - A.y), 8, k);
      q.setFromAxisAngle(up, r.h);
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

  // whether player is drawn in their seat: another always, the player themself unless the camera is at their eyes
  private drawnSeated(player: string) { return player !== this.client.player || !this.ownEyes; }

  // the cars a player is drawn sitting in (their cabins opened: meshes.ts)
  private openCars() {
    const C = this.client, O = this.opened;
    O.clear();
    for (const [car, player] of C.drivers()) if (this.drawnSeated(player)) O.add(car);
    for (const [kind, id, player] of C.passengers()) if (kind === 'car' && this.drawnSeated(player)) O.add(id);
  }
  private readonly opened = new Set<number>();

  // the players riding along, at the wheel of a car or flying a craft, each in their seat in the car or craft as drawn
  // this frame (a car after drawCars; the craft the player pilots as its shell draws it, run ahead of the snapshots)
  private sitting(): readonly Seated[] {
    const C = this.client, out = this.seatedNow, own = C.craftOf();
    out.length = 0;
    const sit = (kind: 'car' | 'craft', id: number, player: string, place: (type: string) => SeatPlace | null) => {
      if (!this.drawnSeated(player)) return;
      const e = SEAT_EULER, pos = new THREE.Vector3(), q = new THREE.Quaternion();
      let p, along = 1;
      if (kind === 'car') {
        const c = this.agent({ kind: 'car', id }) as Car | null, d = this.drawnCars.get(id);
        if (!c || !d || d.frame !== this.frame) return;
        const t = vehicleOf(c);
        p = place(t.id);
        along = c.len / t.len;
        pos.set(d.x, d.y, d.z);
        e.set(-(d.pitch ?? 0), d.h ?? 0, (d.roll ?? 0) + (d.lean ?? 0));
      } else {
        const mine = own?.id === id, c = mine ? own : C.crafts().find((o) => o.id === id);
        // (a crashed plane's look is hidden until it is put back)
        if (!c || (c.core as { flight?: { state: string } }).flight?.state === 'crashed') return;
        p = place(c.type);
        // (a plane's is its nose and its up; the others' a heading, a pitch and a bank, a boat's roll)
        type Drawn = { x: number; y: number; z: number; h: number; pitch?: number; bank?: number; roll?: number; p?: THREE.Vector3; fwd?: THREE.Vector3; up?: THREE.Vector3 };
        const d = c.core.drawn(mine ? C.ownAlpha : C.time.alpha) as Drawn;
        if (d.p && d.fwd && d.up) {
          pos.copy(d.p);
          q.setFromRotationMatrix(SEAT_BASIS.makeBasis(SEAT_LEFT.crossVectors(d.up, d.fwd), d.up, d.fwd));
        } else {
          pos.set(d.x, d.y, d.z);
          q.setFromEuler(e.set(-(d.pitch ?? 0), d.h, d.bank ?? d.roll ?? 0));
        }
      }
      if (!p) return;
      if (kind === 'car') q.setFromEuler(e);
      out.push({ player, q, legs: p.legs, at: new THREE.Vector3(p.x, p.y - HIPS, p.z * along).applyQuaternion(q).add(pos) });
    };
    for (const [kind, id, player, index] of C.passengers()) sit(kind, id, player, (type) => seatPlace(kind, type, index));
    for (const [car, player] of C.drivers()) sit('car', car, player, (type) => driverPlace(type as VehicleId));
    for (const c of C.crafts()) if (c.pilot !== null) sit('craft', c.id, c.pilot, (type) => pilotPlace(type as CraftType));
    return out;
  }
  private readonly seatedNow: Seated[] = [];

  /** the other players riding along or driving as drawn in their seats this frame (their feet's point as if standing), for the
   * name tags and the maps */
  seatedDrawn(): readonly Seated[] { return this.seatedNow; }

  /** where the other players on foot are drawn (their avatars, by player; arm: the slot in their hand), for their guns
   * (view/weapons/weapons-view.ts) and the maps */
  avatarsDrawn() { return this.avatars.drawn(); }

  // person id drawn on their way's point A (x, z across, ground y: sim/path.ts pt), heading h, eased in by k this
  // frame; put on it when further than jump m (or not drawn before)
  private follow(id: number, A: { x: number; y: number; z: number }, h: number, jump: number, k: number) {
    let r = this.drawnPeople.get(id);
    if (!r || Math.hypot(r.x - A.x, r.z - A.y) > jump) { r = this.entry(this.drawnPeople, id, A.x, A.z, A.y); r.x = A.x; r.y = A.z; r.z = A.y; r.h = h; }
    r.frame = this.frame;
    r.x += (A.x - r.x) * k; r.y += (A.z - r.y) * k; r.z += (A.y - r.z) * k;
    r.h = r.h + Math.atan2(Math.sin(h - r.h), Math.cos(h - r.h)) * k;
    return r;
  }

  // a person (shirt col; bike: on one) drawn at p heading h falls over, shoved along (dx, dz) at v m/s; vy: falling
  // into a hole too, at vy m/s
  private addFallen(col: string, bike: boolean, p: { x: number; y: number; z: number }, h: number | undefined, dx: number, dz: number, v: number, vy?: number) {
    if (this.fallen.length >= MAX_FALLEN) { // the oldest out of sight (else the oldest)
      const i = this.fallen.findIndex((f) => this.far(f.at.x, f.at.z, f.at.y, PED_POP_R));
      this.fallen.splice(Math.max(0, i), 1);
    }
    const at = new THREE.Vector3(p.x, p.y, p.z);
    this.fallen.push({ col: this.col(col), bike, at, h: h ?? 0, dx, dz, v, t: 0, bikeAt: bike ? at.clone() : null, vy });
  }

  // the people knocked down further than r m from (x, z) gone (left behind; never in sight of the viewer)
  clearFallen(x: number, z: number, r: number) {
    this.fallen = this.fallen.filter((f) => Math.hypot(f.at.x - x, f.at.z - z) <= r || !this.far(f.at.x, f.at.z, f.at.y, PED_POP_R));
  }

  // the people fallen, drawn from instance i0 on (thrown: drawThrown): sliding along the shove, tipping over towards it (about the
  // horizontal axis across it, at their feet) until flat on the ground, a little hop as they go; a bike on its side
  // where it was hit, sliding half as far
  private drawFallen(dt: number, i0: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), tip = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(), pos = new THREE.Vector3(), ground = this.traffic.ground;
    this.fallen = this.fallen.filter((f) => (f.thrown || f.land === undefined || f.t - f.land <= LANDED_S) && (f.t < FALLEN_S || !this.far(f.at.x, f.at.z, f.at.y, PED_POP_R)));
    const n = Math.min(this.fallen.length, MAX_PEOPLE + MAX_BIKES - i0);
    let bikes = 0;
    for (let i = 0; i < n; i++) {
      const f = this.fallen[i];
      f.t += dt;
      if (f.thrown) { bikes = this.drawThrown(f, f.thrown, dt, i0 + i, bikes); continue; }
      const step = f.v * dt;
      f.at.x += f.dx * step; f.at.z += f.dz * step;
      if (f.bikeAt) { f.bikeAt.x += f.dx * step * 0.5; f.bikeAt.z += f.dz * step * 0.5; }
      f.v *= Math.exp(-FALL_DRAG * dt);
      if (f.vy !== undefined) { // (into a hole: down until the ground)
        if (f.land === undefined && ground) {
          const g = ground.support(f.at.x, f.at.z, f.at.y);
          f.vy -= G * dt;
          f.at.y += f.vy * dt;
          if (f.at.y <= g) { f.at.y = g; f.land = f.t; }
          if (f.bikeAt) f.bikeAt.y = f.at.y;
        }
      } else if (ground) f.at.y = ground.surface(f.at.x, f.at.z, f.at.y);
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

  // a person thrown (f, its middle at f.at), drawn as instance i, its bike as the bikes-th of the fallen: along the arc
  // until their middle is down, then sliding to a stop; returns the fallen bikes drawn
  private drawThrown(f: Fallen, w: Thrown, dt: number, i: number, bikes: number) {
    const M = this.M, ground = this.traffic.ground, at = f.at, m = new THREE.Matrix4(), q = new THREE.Quaternion(), tip = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    if (f.land === undefined) {
      f.vy! -= G * dt;
      at.y += f.vy! * dt;
      w.a = Math.min(Math.PI / 2, w.a + w.spin * dt);
    } else f.v = Math.max(0, f.v - SLIDE * dt);
    at.x += f.dx * f.v * dt; at.z += f.dz * f.v * dt;
    const g = ground ? (f.land === undefined ? ground.support(at.x, at.z, at.y) : ground.surface(at.x, at.z, at.y - LIE)) : w.g0;
    // (the middle's lowest as the body turns: MID up standing, LIE lying)
    const low = g + LIE + (MID - LIE) * Math.cos(w.a);
    if (f.land === undefined && f.vy! < 0 && at.y <= low) { f.land = f.t; w.a = Math.PI / 2; f.v *= LAND_KEEP; }
    if (f.land !== undefined) at.y = g + LIE;
    // (over backwards: about shove x up, the feet swept ahead)
    tip.setFromAxisAngle(axis.set(-f.dz, 0, f.dx), w.a);
    q.setFromAxisAngle(up, f.h).premultiply(tip);
    const feet = axis.set(0, -MID, 0).applyQuaternion(tip).add(at);
    m.compose(feet, q, one);
    M.legs.setMatrixAt(i, m); M.torso.setMatrixAt(i, m);
    M.torso.setColorAt(i, f.col);
    if (f.bikeAt) {
      const step = w.bv * dt;
      f.bikeAt.x += f.dx * step; f.bikeAt.z += f.dz * step;
      w.bv *= Math.exp(-FALL_DRAG * dt);
      if (ground) f.bikeAt.y = ground.surface(f.bikeAt.x, f.bikeAt.z, f.bikeAt.y);
      if (this.riders.length + bikes < MAX_BIKES) {
        const k = Math.min(1, f.t / FALL_S);
        q.setFromAxisAngle(up, f.h).multiply(tip.setFromAxisAngle(axis.set(0, 0, 1), k * k * Math.PI / 2));
        M.bike.setMatrixAt(this.riders.length + bikes++, m.compose(f.bikeAt, q, one));
      }
    }
    return bikes;
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

  private listOf(kind: Kind): Rideable[] { return kind === 'car' ? this.traffic.roadVehicles() : kind === 'person' ? this.people : []; }
  private drawnOf(kind: Kind) { return kind === 'car' ? this.drawnCars : this.drawnPeople; }
  private static label(o: Rideable) { return o.kind === 'car' ? (o.bus ? 'bus' : 'car') : 'person'; }

  /** where agent id of kind was drawn last (its pose, heading, pitch, roll; tools/), or undefined if it was not */
  drawn(kind: Kind, id: number): Readonly<RoadPose> | undefined { return this.drawnOf(kind).get(id); }

  /** agent ref as the sim has it now (read only: what it is, a car's type, length), or null once it has left */
  agent(ref: AgentRef): Readonly<Rideable> | null { return this.listOf(ref.kind).find((o) => o.id === ref.id) ?? null; }

  // the agent nearest to screen point (cx, cy) within px, at least minPx tall on screen, and visible
  pick(camera: THREE.PerspectiveCamera, cx: number, cy: number, px: number, minPx: number, visible: (to: THREE.Vector3) => boolean, skip: AgentRef | null): Picked | null {
    const v = new THREE.Vector3(), cand: (Picked & { score: number; at: THREE.Vector3 })[] = [];
    const f = (innerHeight / 2) / Math.tan(camera.fov * Math.PI / 360);
    const scr = (x: number, y: number, z: number) => { v.set(x, y, z).project(camera); return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; };
    const test = (kind: Kind, obj: Rideable, x: number, y: number, z: number, size: number, label: string, h = 0, len = 0) => {
      if (skip && skip.kind === kind && skip.id === obj.id) return;
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
      if (d < r) cand.push({ ref: { kind, id: obj.id }, label, score: d / r + dist / 3000, at: new THREE.Vector3(x, y + size * 0.3, z) });
    };
    for (const c of this.traffic.roadVehicles()) {
      const d = this.drawnCars.get(c.id);
      if (d) test('car', c, d.x, d.y + 0.8, d.z, c.bus ? 6 : 3.5, c.bus ? 'bus' : 'car', d.h, c.len);
    }
    for (const p of this.people) {
      const d = this.drawnPeople.get(p.id);
      if (d) test('person', p, d.x, d.y + 0.9, d.z, 1.6, 'person');
    }
    cand.sort((a, b) => a.score - b.score);
    const best = cand.slice(0, 6).find((c) => visible(c.at.clone().sub(camera.position)));
    return best ? { ref: best.ref, label: best.label } : null;
  }

  /** where agent ref is drawn now (a pose of its own), or null once it has left */
  pose(ref: AgentRef): Pose | null {
    const d = this.drawnOf(ref.kind).get(ref.id);
    if (!d || !this.agent(ref)) return null;
    return { x: d.x, y: d.y, z: d.z, h: d.h ?? 0 };
  }

  /** the solid things within r m of near as drawn this frame (the walker meets what it sees; sim/solids.ts): the
   * cars, the train coaches, the other players on foot, the crafts standing about but the local player's own. The
   * crowd is not solid: people walk the footways in thousands and step round nobody, so they would wall the walker in */
  solids(near: { x: number; z: number }, r = 25): Solid[] {
    const out: Solid[] = [], by = (x: number, z: number) => Math.abs(x - near.x) < r && Math.abs(z - near.z) < r;
    for (const c of this.traffic.roadVehicles()) {
      const d = this.drawnCars.get(c.id);
      if (d && d.frame === this.frame && by(d.x, d.z)) out.push(solidAt(carShape(c), d, `car${c.id}`));
    }
    // (one lying dead is stepped over)
    for (const { pose: d } of this.avatars.drawn()) if (!d.down && by(d.x, d.z)) out.push(solidAt(AVATAR_SHAPE, d));
    for (const c of this.coaches) if (by(c.x, c.z)) out.push(solidAt(COACH_SHAPE, { x: c.x, y: c.y, z: c.z, h: c.heading }, `coach${c.id}`));
    // (the river's vessels where view/boats.ts draws them: a walker on a jetty meets the boat alongside)
    const B = this.traffic.boats, back = this.back;
    for (const p of B?.poses ?? []) {
      if (Math.abs(p.x - near.x) > r + p.len / 2 || Math.abs(p.z - near.z) > r + p.len / 2) continue;
      const q = B!.previous.find((o) => o.kind === p.kind && o.id === p.id) ?? p;
      out.push(solidAt(vesselShape(p), { x: lerp(p.x, q.x, back), y: lerp(p.y, q.y, back), z: lerp(p.z, q.z, back), h: p.heading + wrapAngle(q.heading - p.heading) * back }, `${p.kind}${p.id}`));
    }
    const me = this.client.player;
    for (const c of this.client.crafts()) {
      const p = c.core.pose;
      if (c.placed && (c.pilot === null || c.pilot !== me) && by(p.x, p.z)) craftSolids(c.type, p, out, `craft${c.id}`);
    }
    return out;
  }

  /** the first one of a kind drawn, or null */
  first(kind: Kind): Picked | null {
    const D = this.drawnOf(kind), o = this.listOf(kind).find((q) => D.has(q.id));
    return o ? { ref: { kind, id: o.id }, label: StreetLife.label(o) } : null;
  }

  /** the ones of a kind drawn within r m of from (across), with where they are drawn */
  near(kind: Kind, from: { x: number; z: number }, r: number) {
    const D = this.drawnOf(kind), out: { picked: Picked; pose: Pose; agent: Readonly<Rideable> }[] = [];
    for (const o of this.listOf(kind)) {
      const d = D.get(o.id);
      if (d && Math.hypot(d.x - from.x, d.z - from.z) < r) out.push({ picked: { ref: { kind, id: o.id }, label: StreetLife.label(o) }, pose: { x: d.x, y: d.y, z: d.z, h: d.h ?? 0 }, agent: o });
    }
    return out;
  }

  /** the nearest one of a kind, preferring one that moves */
  nearest(kind: Kind, from: { x: number; z: number }, skip: AgentRef | null): Picked | null {
    let best: Rideable | null = null, bd = Infinity;
    const D = this.drawnOf(kind);
    for (const o of this.listOf(kind)) {
      const p = D.get(o.id);
      if ((skip && skip.kind === kind && skip.id === o.id) || !p) continue;
      const d = Math.hypot(p.x - from.x, p.z - from.z), dd = d + (kind === 'person' || o.v > 1.5 ? 0 : 400);
      if (dd < bd && d > (kind === 'person' ? 3 : 8)) { bd = dd; best = o; }
    }
    if (!best) return null;
    return { ref: { kind, id: best.id }, label: StreetLife.label(best) };
  }
}

