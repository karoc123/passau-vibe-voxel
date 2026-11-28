import type * as THREE from 'three';
import type { CraftView, SimClient } from '../client/sim-client';
import type { CraftSpot as SimSpot } from '../sim/contract/commands';
import type { CraftEvents } from '../sim/contract/crafts';
import type { CraftId, CraftType } from '../sim/contract/ids';
import type { PilotInput } from '../sim/contract/inputs';
import type { CraftWorld } from '../sim/craft/craft-core';
import { CORES, type CoreOf } from '../sim/craft/cores';
import { VoxelCollision } from '../sim/craft/voxel-collision';
import type { Meta } from '../core/meta';
import type { Pose } from '../sim/contract/pose';
import type { Nav } from './nav';
import type { Help } from '../ui/help';
import type { Offer } from './mode-panel';
import type { RiverPoints } from '../sim/river';

// A craft the player gets into: the drone (fpv.ts), the car (drive.ts), the boat
// (boat.ts), the floatplane and the jet (plane.ts). Each is one class made from a CraftContext and listed once in
// main.ts (CRAFTS); Nav knows only this interface. A craft gets in through Nav (nav.enterCraft) and Nav lets it know
// when it is left, whatever leaves it (Esc, the map, a search, a walk, another craft): leave(), once.
//
// Two kinds, by `view`:
//   'own':  it owns the camera and the input (the drone, the boat, the plane); Nav leaves keys, pointer and wheel to it
//           and is in its mode 'craft'. Entered from the map or a ride.
//   'ride': Nav's ride camera follows it and Nav's look and zoom gestures stay on (the car). It takes the ride being
//           followed (Nav's mode stays 'ride').
// Which craft is on is body[data-mode] (its id; main.ts), for its CSS.

/** where to get in: x, z, heading h (0: +z, pi/2: +x), and a height for one that starts in the air */
export interface CraftSpot { x: number; y?: number; z: number; h: number }

export interface PlayerCraft {
  /** body[data-mode] while it is on (its CSS) */
  readonly id: string;
  readonly view: 'own' | 'ride';
  /** simulation position and heading while active (the ride itself supplies a drive's pose) */
  readonly mapPose?: Pose | null;
  /** its camera at the player's eyes in their seat (their own figure not drawn: StreetLife ownEyes) */
  readonly inSeat?: boolean;
  /** it takes the mouse now (Nav takes it, and again after the menu): its moves turn the view (turnView; a 'ride'
   * craft's are Nav's ride look; not an aircraft's pilot's: mouseTurns) or aim a gun. Every craft a player sits in says so (owner 2026-11-27: a vehicle that
   * leaves the mouse free felt broken); not one a player flies from afar */
  readonly mouse: boolean;
  /** the mouse taken moved by dx, dy px (right, down +): the chase or seat view turned, or the gun aimed */
  turnView?(dx: number, dy: number): void;
  /** get in: at a spot (tools; later F2, walking up to it) or, without one, where the view is. false: not now */
  enter(at?: CraftSpot): boolean;
  /** the types of the world's crafts it flies (board) */
  readonly boards?: readonly CraftType[];
  /** into the pilot's seat of a craft in the world no one pilots (one of `boards`; SimClient.crafts()); from: the shell
   * of the seat held before in the same craft (a seat switch). false: not now */
  board?(craft: CraftView, from?: PlayerCraft): boolean;
  /** its help now (ui/help.ts): every craft says, so none is flown without */
  readonly help: Help;
  /** back to a safe spot nearby (T, the touch button); only what can get stuck or lost has it */
  reset?(): void;
  /** it has been left (Nav calls this once, from whatever left it): let go of everything, hide what it showed */
  leave(): void;
  /** every frame, on or not, before the sim's update (main.ts): its input sent, its panel, what happened to it */
  update(dt: number): void;
  /** every frame after the sim's update (main.ts; 'own' only): its model and its camera on the pose it is drawn at in
   * this frame (between the world's last two ticks: CraftLink.alpha) */
  place?(dt: number): void;
}

/** the light and the rivers' points, for the crafts on the water */
export interface CraftEnv {
  /** 0 by day .. 1 by night (daylight.ts) */
  night: () => number;
  /** the river's points (river.ts); null while not loaded */
  river: () => RiverPoints | null;
}

/** what every craft is made from (main.ts) */
export interface CraftContext {
  nav: Nav;
  camera: THREE.PerspectiveCamera;
  /** the map's focus (OrbitControls' target): a craft keeps it ahead of the camera, as the shadows and fog read it */
  target: THREE.Vector3;
  meta: Meta;
  /** the bar's mode tools, where its panel goes */
  host: HTMLElement;
  /** its buttons (in, out), where the page offers the vehicles */
  offer: Offer;
  canvas: HTMLCanvasElement;
  env: CraftEnv;
  /** the world sim's client, once the traffic is loaded: the crafts' commands go to it (its session's player's: the
   * host stamps the player) */
  sim: Promise<SimClient>;
  /** what a shell's own collision reads (sim/craft/voxel-collision.ts: its spawn search, its camera, its panel): the
   * map, the viewer's TileCache, the page's clock */
  tiles: CraftWorld;
}

// Whether a craft of each type is in the air with the player in one of its seats: X there opens a paraglider over
// them (Nav.getOut). Every type says, so a new one cannot forget it. null: no seat in it is ever in the air (on the
// water or the ground; the drone is flown from afar; the paraglider is the canopy itself)
const ALOFT: { [K in CraftType]: ((core: CoreOf<K>) => boolean) | null } = {
  boat: null, hovercraft: null, paraglider: null, drone: null,
  helicopter: (c) => !c.motion.grounded, gunship: (c) => !c.motion.grounded,
  floatplane: (c) => c.flight.state === 'air',
  jet: (c) => c.flight.state === 'air',
  fighter: (c) => c.flight.state === 'air',
};
/** the types a player sits in in the air (a gate takes each) */
export const AIRCRAFT = (Object.keys(ALOFT) as CraftType[]).filter((t) => ALOFT[t] !== null);
/** the mouse taken turns this shell's view (Nav alone asks). Not a pilot's of an aircraft: the view stays behind
 * what they steer by (owner 2026-11-28: a chase view swung round a banking aircraft read as broken); the mouse is
 * still taken there, for the trigger */
export const mouseTurns = (shell: PlayerCraft) => !shell.boards?.some((t) => AIRCRAFT.includes(t));
/** craft c in the air (ALOFT) */
export const aloft = (c: CraftView) => (ALOFT[c.type] as ((core: CraftView['core']) => boolean) | null)?.(c.core) ?? false;

/** A shell's hold on its craft in the world sim, the local player its pilot, through the sim's client: the commands
 * (spawn: made and put down at a spot; board: the seat of one in the world; place: put down again; input; reset; close:
 * left where it is, or taken away), the craft once the sim has seated the player (its core's state, read only), and a
 * collision of the shell's own over the viewer's tiles (the world's voxels as the page reads them: the spawn search,
 * the camera's sweep, the panel's heights; the sim steps the craft through its own). */
export class CraftLink<K extends CraftType> {
  /** the world sim's client, once loaded */
  sim: SimClient | null = null;
  /** the shell's own collision, while it is in the craft (open .. close) */
  col: VoxelCollision | null = null;
  // a craft spawned or boarded, until close
  private held = false;

  constructor(private readonly ctx: CraftContext, public type: K) {
    void ctx.sim.then((s) => { this.sim = s; });
  }

  /** in (the sim loaded): the shell's collision made, for a craft of type (default: the link's) */
  open(type: K = this.type) {
    this.close();
    this.type = type;
    const t = this.ctx.tiles;
    this.col = new VoxelCollision(t.meta, t.cache, t.now, CORES[type](this.sim!.tuning).reach);
    return this.col;
  }

  /** the craft piloted, once the sim has made it (null before, and after close) */
  get craft(): CraftView<CoreOf<K>> | null {
    const c = this.held ? this.sim?.craftOf() : null;
    return c && c.type === this.type ? c as CraftView<CoreOf<K>> : null;
  }

  /** how far into its tick the craft is drawn this frame (its drawn(alpha)) */
  get alpha() { return this.sim?.ownAlpha ?? 1; }

  /** the craft this frame (null: not made yet), the shell's collision fetched round it */
  frame() {
    const c = this.craft;
    if (c && this.col) this.col.prefetch(c.core.pose, c.core.velocity);
    return c;
  }

  /** a craft of the link's type made, the local player its pilot, put down at spot (from the next tick) */
  spawn(spot: SimSpot) {
    this.sim!.send({ kind: 'request', request: { kind: 'craft', type: this.type, spot } });
    this.held = true;
  }

  /** the local player into the pilot's seat of craft id (in the world, of the link's type); refused: refused() */
  board(id: CraftId) {
    this.sim!.send({ kind: 'enterSeat', entity: { kind: 'craft', id }, role: 'pilot' });
    this.held = true;
  }

  /** a board refused since the last call (another player took the seat first, or the craft is gone) */
  refused() { return !!this.sim?.results('enterSeat', 'pilot').some((r) => !r.ok); }

  /** the craft put down again at spot */
  place(spot: SimSpot) { this.sim?.send({ kind: 'request', request: { kind: 'placeCraft', spot } }); }

  /** put down at spot: made the first time (spawn), else again (place) */
  put(spot: SimSpot) { if (this.held) this.place(spot); else this.spawn(spot); }

  /** the pilot's hands on the controls, until the next */
  input(input: PilotInput) { this.sim?.send({ kind: 'seatInput', role: 'pilot', input }); }

  /** what happened to the craft since the last call */
  events(): CraftEvents[K][] {
    const out: CraftEvents[K][] = [];
    // (the seat's craft is of the link's type: craft; its events are its type's)
    if (this.craft) for (const x of this.sim!.craftEvents()) if (x.craft === this.type) out.push(x.e as CraftEvents[K]);
    return out;
  }

  /** back to a safe spot nearby (T); whether it was, in results('resetCraft') */
  reset() { this.sim?.send({ kind: 'request', request: { kind: 'resetCraft' } }); }

  /** the outcomes of the resets asked for since the last call: true where one was done */
  resets() { return this.sim?.results('resetCraft').map((r) => r.ok) ?? []; }

  /** out: the craft left where it is (for anyone to enter; the sim drops it once no player is near), or, drop, taken
   * out of the world; the shell's collision let go */
  close(drop = false) {
    // (moved to a passenger's seat of it already: the seat switch, which a leaveSeat would undo)
    if (this.held && this.sim?.seat()?.role !== 'passenger') this.sim?.send(drop ? { kind: 'request', request: { kind: 'dropCraft' } } : { kind: 'leaveSeat', pose: this.ctx.nav.stepOut ?? undefined });
    this.held = false;
    this.col?.release();
    this.col = null;
  }
}
