// What the page holds of the world sim (docs/plans/local-server.md, ADR 0008: "the page sends commands and draws
// snapshots"): a SimClient. The page never reaches into the WorldSim; it sends its players' commands (SimCommand:
// plain data, so they can cross to a Web Worker or a server), runs the frame (update: the frame's input; in the page's
// thread the sim's update itself) and reads what the sim publishes: the traffic as drawn (TrafficView), the players'
// seats, cars and crafts, the outcomes of their commands, the events since a tick.
// LocalSimClient: the sim in the page's thread (the one implementation so far). Commands are queued and applied in the
// order sent at the start of the next update, before its ticks (ADR 0007: commands take effect at the start of a
// tick); every craft shell and the nav run before the update in main.ts's frame, so they reach the tick they reached
// when they called the WorldSim at once.
// No three.js, no DOM (tools/core-deps.mjs).
import type { CarInput } from '../physics/rapier/car';
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import { apply as applyEdit, type WorldOp } from '../core/world-edits';
import type { Traffic, TrafficBodies } from './traffic';
import type { EntityRef, WalkPose } from './types';
import type { VehicleId } from './vehicles';
import type { CraftCore, CraftSpot } from './craft/craft-core';
import type { CraftType } from './craft/cores';
import type { CraftId, CraftInput, PlayerId, Seat, SimEvent, SimInput, WorldSim } from './world-sim';

/** a player's command (ADR 0007: keyed by player id), applied at the start of the sim's next update, in order:
 *   follow        follow an entity (no rights over it), or none
 *   walkAs        take the seat of a person (from pose: where they are drawn); refused: another walks as them, or gone
 *   walkPose      where the walk (the client's) puts the person walked
 *   release       leave the person walked
 *   takeWheel     the driver's seat of a car (as type choice); the car taken shows in driver()
 *   drive         the car's controls, until the next
 *   releaseWheel, resetDriver
 *   spawnCraft    a craft of type made, the player its pilot, put down at spot (what a game mode decides; today the
 *                 craft's shell)
 *   placeCraft    the player's craft put down again at spot
 *   craftInput    the player's craft's controls (its type's input), until the next
 *   resetCraft    the player's craft back to a safe spot nearby; refused: not now
 *   dropCraft     the player's craft taken out of the world
 *   edit          a change to the world's voxels (core/world-edits.ts) */
export type SimCommand =
  | { kind: 'follow'; player: PlayerId; entity: EntityRef | null }
  | { kind: 'walkAs'; player: PlayerId; person: number; pose: WalkPose }
  | { kind: 'walkPose'; player: PlayerId; pose: WalkPose }
  | { kind: 'release'; player: PlayerId }
  | { kind: 'takeWheel'; player: PlayerId; car: number; choice?: VehicleId }
  | { kind: 'drive'; player: PlayerId; input: CarInput }
  | { kind: 'releaseWheel'; player: PlayerId }
  | { kind: 'resetDriver'; player: PlayerId }
  | { kind: 'spawnCraft'; player: PlayerId; type: CraftType; spot: CraftSpot }
  | { kind: 'placeCraft'; player: PlayerId; spot: CraftSpot }
  | { kind: 'craftInput'; player: PlayerId; input: CraftInput }
  | { kind: 'resetCraft'; player: PlayerId }
  | { kind: 'dropCraft'; player: PlayerId }
  | { kind: 'edit'; player: PlayerId; op: WorldOp };

/** what became of a command that can be refused (walkAs, spawnCraft, placeCraft, resetCraft, edit), at the tick it
 * was applied before */
export interface CommandResult { tick: number; kind: SimCommand['kind']; ok: boolean }

/** what the presentation reads of the traffic (view/life.ts, nav/): the agents between their last two ticks and the
 * path maths that place them (the static roads and footways), the signals, trains, boats, the bodies' poses. In the
 * page's thread it is the sim's Traffic itself; a client of a worker or a server fills a Traffic of its own from
 * snapshots (docs/plans/local-server.md). Read only, except the drawn fields (rp, rh, pitch, roll) on its agents. */
export type TrafficView = Readonly<Pick<Traffic, 'heads' | 'peds' | 'cars' | 'detachedCars' | 'people' | 'riders' | 'active' |
  'acc' | 'trains' | 'boats' | 'ground' | 'carPose' | 'pathPoint' | 'personPoint' | 'signal' | 'roadVehicles'>> &
  { readonly bodies: Pick<TrafficBodies, 'owns' | 'pose'> | null };

/** a player craft as the page sees it: its id and type, its pilot, whether it is put down, its core's state (read
 * only: pose, drawn(alpha), the motion or flight its shell shows). Its collision is the sim's; a shell queries the
 * world through its own (nav/). */
export interface CraftView<C extends CraftCore = CraftCore> {
  readonly id: CraftId;
  readonly type: CraftType;
  readonly pilot: PlayerId | null;
  readonly placed: boolean;
  readonly core: C;
}

export interface SimClient {
  /** the world's tick as last seen: the number of ticks run */
  readonly tick: number;
  /** the traffic as drawn */
  readonly traffic: TrafficView;
  /** a player's command, applied at the start of the next update */
  send(cmd: SimCommand): void;
  /** the frame: the commands sent applied, then the ticks due after dt s (SimInput: the hour, the focus, the viewer) */
  update(dt: number, input: SimInput): void;
  /** the sim's events of the ticks after tick, oldest first */
  eventsSince(tick: number): SimEvent[];
  /** the outcomes of the player's commands of kind since the last call for it, oldest first */
  results(player: PlayerId, kind: SimCommand['kind']): CommandResult[];
  /** the seat the player holds, or null */
  seat(player: PlayerId): Seat | null;
  /** where person personId is put by the player walking as them, or null while none does */
  walkedPose(personId: number): WalkPose | null;
  /** the player's car, or null while they drive none */
  driver(player: PlayerId): DriverSnapshot | null;
  /** what the driver is to be told since the last call */
  driverNotes(player: PlayerId): DriveNote[];
  /** the craft the player pilots, or null */
  craftOf(player: PlayerId): CraftView | null;
  /** what happened to the player's craft since the last call, oldest first */
  craftEvents(player: PlayerId): unknown[];
  /** the road physics loaded where the sim runs (warm: where the terrain is wanted soon); rejects if it cannot */
  loadPhysics(warm?: { x: number; z: number }): Promise<void>;
  /** an edit command whose answer is the level-1 nodes it changed, once applied */
  edit(player: PlayerId, op: WorldOp): Promise<[number, number][]>;
}

type Queued = { cmd: SimCommand; done?: (nodes: [number, number][]) => void; fail?: (e: unknown) => void };

/** the sim in the page's thread: a WorldSim made by the page (sim-host.ts) */
export class LocalSimClient implements SimClient {
  private queue: Queued[] = [];
  private readonly outcomes = new Map<PlayerId, CommandResult[]>();

  constructor(private readonly sim: WorldSim) {}

  get tick() { return this.sim.tick; }
  get traffic(): TrafficView { return this.sim.traffic; }

  send(cmd: SimCommand) { this.queue.push({ cmd }); }

  edit(player: PlayerId, op: WorldOp) {
    return new Promise<[number, number][]>((done, fail) => this.queue.push({ cmd: { kind: 'edit', player, op }, done, fail }));
  }

  update(dt: number, input: SimInput) {
    this.flush();
    this.sim.update(dt, input);
  }

  /** the commands sent so far applied (update does it first) */
  flush() {
    const q = this.queue;
    this.queue = [];
    for (const item of q) this.apply(item);
  }

  eventsSince(tick: number) { return this.sim.eventsSince(tick); }

  results(player: PlayerId, kind: SimCommand['kind']) {
    const r = this.outcomes.get(player);
    if (!r?.some((o) => o.kind === kind)) return [];
    this.outcomes.set(player, r.filter((o) => o.kind !== kind));
    return r.filter((o) => o.kind === kind);
  }

  seat(player: PlayerId) { return this.sim.seat(player); }
  walkedPose(personId: number) { return this.sim.walkedPose(personId); }
  driver(player: PlayerId) { return this.sim.driverSnapshot(player); }
  driverNotes(player: PlayerId) { return this.sim.driverNotes(player); }
  craftOf(player: PlayerId): CraftView | null { return this.sim.craftOf(player); }
  craftEvents(player: PlayerId) { return this.sim.craftEvents(player); }

  loadPhysics(warm?: { x: number; z: number }) { return this.sim.loadPhysics(warm).then(() => {}); }

  private result(cmd: SimCommand, ok: boolean, tick = this.sim.tick) {
    const r = this.outcomes.get(cmd.player), out = { tick, kind: cmd.kind, ok };
    if (r) r.push(out); else this.outcomes.set(cmd.player, [out]);
  }

  private apply({ cmd, done, fail }: Queued) {
    const S = this.sim, p = cmd.player;
    switch (cmd.kind) {
      case 'follow': S.follow(p, cmd.entity); break;
      case 'walkAs': this.result(cmd, S.walkAs(p, cmd.person, cmd.pose)); break;
      case 'walkPose': S.walkPose(p, cmd.pose); break;
      case 'release': S.release(p); break;
      case 'takeWheel': S.takeWheel(p, cmd.car, cmd.choice); break;
      case 'drive': S.input(p, cmd.input); break;
      case 'releaseWheel': S.releaseWheel(p); break;
      case 'resetDriver': S.resetDriver(p); break;
      case 'spawnCraft': {
        let ok = false;
        try {
          const c = S.addCraft(cmd.type);
          ok = S.enterCraft(p, c.id);
          if (ok) S.placeCraft(c.id, cmd.spot); else S.removeCraft(c.id);
        } catch (e) { console.warn('spawnCraft', e); }
        this.result(cmd, ok);
        break;
      }
      case 'placeCraft': {
        const c = S.craftOf(p);
        if (c) S.placeCraft(c.id, cmd.spot);
        this.result(cmd, !!c);
        break;
      }
      case 'craftInput': S.craftInput(p, cmd.input); break;
      case 'resetCraft': this.result(cmd, S.resetCraft(p)); break;
      case 'dropCraft': { const c = S.craftOf(p); if (c) S.removeCraft(c.id); break; }
      case 'edit': {
        const tick = S.tick;
        applyEdit(cmd.op).then((nodes) => { this.result(cmd, nodes.length > 0, tick); done?.(nodes); },
          (e) => { this.result(cmd, false, tick); fail?.(e); });
        break;
      }
    }
  }
}
