# Entities, seats, health, items and game modes in the world sim

Status: design, nothing built. Target: [ADR 0008](../adr/0008-server-vision.md) ("A first game, as direction": the
rules of a game are a mode layered on the world sim; the sim offers entities with ids, seats, health and items), on
[ADR 0006](../adr/0006-world-sim-seam.md), [ADR 0007](../adr/0007-player-control-in-world-sim.md) and
[local-server.md](local-server.md) (E9). Assumes E7 (commands queued per tick, one seat per player, `leaveSeat`, seat
table in `WorldSim`) lands first and E8 (a left vehicle stays in the world, can be entered) in whatever shape it takes:
nothing below depends on E8's internals, only on "an entity with no occupied seat stays until the presence rule drops
it". File:line of `web/src/` at main `69d7ad6e`.

## 0. Today, in one table

| Store | Key | What it holds | Where |
|---|---|---|---|
| `Traffic.cars`, `detachedCars` | `Car.id` (`idSeq`; the id picks the type: `trafficType(id)`) | path agents; parked cars and wrecks with `detachedPose` | sim/traffic.ts:111-112, 153, 275, 767 |
| `Traffic.people`, `riders` | `Person.id` (`personSeq`, shared by both) | crowd and bike riders on footways | sim/traffic.ts:113-114, 292, 301 |
| `Traffic.held`, `walked` | car / person id | kept while followed or walked (not trimmed, not dropped) | sim/traffic.ts:100-102 |
| `LifePhysics.bodies`, `drivers`, `players` | car id; player id | Rapier bodies (`track/wreck/rest/player/park/path`), the driver's `PlayerCar` | physics/rapier/life-phys.ts:108-110, 74 |
| `WorldSim.players` | `PlayerId` | `PlayerState { follow, walkingAs, pose, craft }` | sim/world-sim.ts:47, 93 |
| `WorldSim.walkers` | person id | who walks as them | sim/world-sim.ts:95 |
| `WorldSim.crafts` | `CraftId` (`nextCraft`) | `Craft { type, core, collision, pilot, placed }` | sim/world-sim.ts:50-60, 100-101 |
| trains, river boats | index in their sim | scheduled, not interactable | sim/train-traffic.ts, sim/boat-traffic.ts |

`EntityRef` is `{ kind: 'car' | 'person'; id }` (sim/types.ts:107-110); crafts are referenced only inside `Seat`
(`{ kind: 'craft'; id }`, world-sim.ts:42-43). Five places answer "where is entity X": `foci()` (world-sim.ts:245-261),
`seat()` (228-234), `takeSnapshot` (snapshot.ts:70-90), `StreetLife.pose`, the shells. Events are two kinds, both
tick-numbered (`struck`, `dropped`: world-sim.ts:81-83); the crafts' and the driver's events are not (drained per player:
`craftEvents` world-sim.ts:361, `driverNotes` 281).

## 1. Entities

### One id space, keyed by kind

- `EntityRef = { kind: EntityKind; id: number }`, `EntityKind = 'car' | 'person' | 'craft'` now; `'item'` with E14,
  `'npc'` later. Numbering stays per kind: `Car.id` picks the traffic vehicle type (`trafficType`,
  sim/vehicles.ts:216), so one global counter would change every seeded run (not neutral, gates' counts move). A string
  key `entityKey(ref) = kind + ':' + id` for maps. On the wire it stays `{kind, id}`.
- Trains and river boats are not entities (nothing a player does to them yet). A coach a player can board would make
  them one later; their sims keep their own arrays.

### Generic vs. kind-specific

An entity is not one object. It is an id, a **core** owned by the kind's existing sim (unchanged storage, unchanged hot
loops), and a few **sparse component maps** owned by `WorldSim`, present only where something set them:

| Part | Generic (WorldSim, `sim/entities.ts`) | Kind-specific (the core, where it lives today) |
|---|---|---|
| identity | `ref`, `kind` | car: `Car` in `Traffic`; person: `Person`; craft: `CraftCore` + `VoxelCollision` |
| pose | `pose(ref): Pose \| null` (read through the core: `carPose`/`detachedPose`/body, `personPoint`/walked pose, `core.pose`) | how it moves: path agent, Rapier body, motion law |
| seats | `seats(ref): SeatSpec[]` from the kind's model; occupants in the seat table (E7) | what a role's input does: `CarInput` to `PlayerCar`, `CraftInput` to the core, `WalkPose` to the walked person |
| health | `health: Map<key, { hp, max }>` | what "down" means: person out of the crowd (`removePerson`, traffic.ts:757), car a wreck (`LifePhysics.wreck`, life-phys.ts:818), craft on neutral input |
| items | `items: Map<key, ItemStack[]>` | none |
| keeping | `pinned: Set<key>` (a mode keeps it); else the presence rule (E8's, edit-keeper's radius/after) | the kind's own trimming (traffic: out of sight, `trimParked` traffic.ts:786) for ambient agents |
| origin | `owner?: 'traffic' \| 'mode' \| PlayerId` | |

Ambient traffic (hundreds of cars and people, sim/traffic.ts) gets no component rows: an entity without `health` is
not damageable, without `items` carries nothing. A row is made when a mode or a rule first touches it, and dropped with
the entity (`despawned`). So the 75 KB snapshot (local-server.md section 4) does not grow with the components.

`sim/entities.ts` `Entities` (owned by `WorldSim`):

```ts
type EntityKind = 'car' | 'person' | 'craft';            // + 'item' (E14), 'npc' (later)
interface EntityRef { kind: EntityKind; id: number }
interface SeatSpec { role: Role; index: number }          // index: the n-th seat of that role
type Role = 'driver' | 'pilot' | 'walker';                // + 'gunner' | 'passenger' later
interface EntityView { ref: EntityRef; pose: Pose; seats: readonly SeatSpec[]; occupants: (PlayerId | null)[];
  hp?: { hp: number; max: number }; items?: readonly ItemStack[] }
class Entities {
  get(ref): EntityView | null;                            // through the kind's core; null: gone
  pose(ref): Pose | null;
  near(p: { x: number; z: number }, r: number, kinds?: EntityKind[]): EntityRef[];
  each(kind): Iterable<EntityRef>;
}
```

Each kind registers an adapter (`KindCore { exists(id), pose(id, out), seats(id), down(id, cause) }`): car over
`Traffic` + `LifePhysics`, person over `Traffic` + the walked poses, craft over `WorldSim.crafts`. No storage moves.

### Seats, generalised

- A kind's model lists its seats: car `[driver]` (later `passenger` x n by vehicle type: `VEHICLES` in
  sim/vehicles.ts), person `[walker]`, craft by type (`helicopter: [pilot]`, later `[pilot, gunner, passenger x 2]`),
  npc none (an AI core drives it). `Seat = { entity: EntityRef; role: Role; index: number }` replaces the union of
  world-sim.ts:42-43.
- One seat per player (E7). Commands: `enterSeat(player, ref, role, index?)`, `seatInput(player, input)`,
  `leaveSeat(player)`. The input's type is the role's: `driver: CarInput`, `pilot: CraftInput` (of the craft's
  type), `walker: WalkPose`, `gunner: { yaw, pitch, fire }`. Today's commands become aliases applied by `SimServer`
  (`takeWheel` = `enterSeat(car, driver)` with `choice`; `drive` = `seatInput`; `walkAs`/`walkPose`; `craftInput`), so
  the shells do not change in the same step.
- A seat of role `driver`/`pilot` is the one whose input moves the core; an empty one means neutral input (craft:
  `core.neutral`, world-sim.ts:350; car: parked, life-phys.ts:216-227). A `gunner` seat moves nothing, it aims; firing
  is a rule (a mode's or a weapon component's later).
- Taking a seat checks: entity exists, seat free, player holds none (E7), and a reach rule the mode supplies
  (`mayEnter(player, seat)`, sandbox: always). That is where E8's "enter an empty vehicle" lands without knowing
  how E8 stores it.

### Migration (each behaviour-neutral, gates green)

1. `EntityKind` gains `'craft'`; `Seat.entity` is a plain `EntityRef`; `follow` accepts a craft. `Entities` with the
   three adapters, read only. `foci()` (world-sim.ts:245-261) and `seat()` (228-234) go through it. Neutral: same
   foci, same seats.
2. Seat specs from the models, `enterSeat`/`seatInput`/`leaveSeat` beside the old commands (aliases in
   `SimServer.apply`, sim-server.ts:325-362). Snapshot `player.seat` gains `index` (0).
3. Craft and driver events become tick-numbered `SimEvent`s keyed by entity (`{ tick, kind: 'craft', entity, e }`,
   `{ tick, kind: 'drive', entity, note }`); `craftEvents`/`driverNotes` become filters over `eventsSince` for the
   player's seat. The craft step is per frame today (see section 4, E13), so until then the tick is the update's.
4. Components (`health`, `items`, `pinned`, `owner`) and their events (section 2); nothing sets them in sandbox.
5. Generic `spawn(kind, spec)` / `despawn(ref)` (crafts: `addCraft` + `placeCraft`; car: a parked car at a pose via
   `Traffic.detachCar`'s path; item: new). E8's presence drop becomes the default for every entity not `pinned` and
   not ambient.

## 2. Health, damage, items

Mechanisms only. No rule says what hurts how much; the mode does (section 3).

```ts
interface Health { hp: number; max: number }
interface ItemStack { type: string; n: number }          // type: an id from a mode's item table; the sim knows none
type Cause = { kind: 'impact'; by?: EntityRef; speed: number } | { kind: 'fall'; h: number } | { kind: 'water' } |
  { kind: 'mode'; why: string }
```

WorldSim operations (sim-internal and on `ModeWorld`, never page commands):

- `setHealth(ref, hp, max)`, `damage(ref, amount, cause)`, `heal(ref, amount)`. hp clamps at 0; reaching 0 calls the
  kind's `down(id, cause)` once and emits `destroyed`. An entity without a `Health` row ignores `damage`.
- `give(ref, stack)`, `take(ref, type, n): boolean`, `transfer(from, to, type, n): boolean`.
- Player-facing commands for items: `pickUp(player, from: EntityRef, type, n)` and `drop(player, type, n)`, checked
  against reach (the player's seat entity within `ITEM_REACH` of `from`) and asked of the mode (`mayTransfer`). Their
  outcome is a `CommandResult` (sim-client.ts:60).

New `SimEvent`s, all `{ tick, ... }`, kept `EVENT_TICKS` (world-sim.ts:86) as now:

| kind | fields | emitted by |
|---|---|---|
| `impact` | `entity, by?, speed, at` | physics facts: car-person (today's `struck`, life-phys.ts:748-750), car-car / car-block (`PlayerCar` crash, `crashUntil`), craft crash (plane `crashed` state, boat `bump`) |
| `damaged` | `entity, amount, hp, cause` | `damage` |
| `destroyed` | `entity, cause` | hp reached 0 |
| `spawned` / `despawned` | `entity, owner?` / `entity, why: 'mode' \| 'presence' \| 'trim' \| 'down'` | spawn, despawn, presence rule |
| `seated` / `unseated` | `player, seat` | E7's seat table |
| `transferred` | `from?, to?, type, n` | items |

`struck` and `dropped` stay as they are (the presentation animates them: view/life.ts); `impact` is emitted beside
`struck` for the same contact. Rule: physics emits facts (`impact`, `dropped`), never hp changes; `damage` is called
by the mode's `event` handler. So sandbox, which handles none, is today's game exactly.

Snapshot: `entities` section, the generic view of every entity in the client's interest that has a component or an
occupied seat (`ref, hp?, occupants`), and the full `items` only of the player's own seat entity and of an entity
they look into (`inspect` command later). Ambient agents stay in `cars`/`people` as now.

Cores with rules inside them (move to the mode when a game needs it; sandbox keeps them where they are): the plane's
crash-and-respawn (`CRASH_S`, sim/craft/plane-flight.ts:88), the driver's automatic recovery (`recoveryDue`,
life-phys.ts:234), `unstick` (craft-core.ts:316). The step: the core reports `crashed`/`stuck`; the mode calls
`reset`. Not in the first packages.

## 3. Game mode layer

### Interface

`sim/mode.ts`. Runs beside `WorldSim` in the host (`SimServer`, sim/sim-server.ts), the same in the page's thread, the
worker and a Node server; never in the page (`core-deps` scans `sim/`, the mode imports no DOM). One mode per
`SimServer`.

```ts
interface GameMode {
  readonly id: string;
  start(w: ModeWorld): void;                                // world made, before the first tick
  join(w: ModeWorld, player: PlayerId, hello: JoinInfo): void;   // place the player, give a seat or none
  leave(w: ModeWorld, player: PlayerId): void;              // seat freed by the host before this
  tick(w: ModeWorld, tick: number): void;                   // after the tick's commands, before its steps
  event(w: ModeWorld, e: SimEvent): void;                   // each event of a tick, after its steps, in order
  request(w: ModeWorld, player: PlayerId, r: ModeRequest): boolean;  // what a player asks of the rules
  mayEnter?(w, player, seat: Seat): boolean;                // default true
  mayTransfer?(w, player, from: EntityRef, to: EntityRef, type: string, n: number): boolean;
  mayEdit?(w, player, op: WorldOp): boolean;                // default false
}
type ModeRequest =
  | { kind: 'craft'; type: CraftType; spot: CraftSpot }      // today's spawnCraft
  | { kind: 'placeCraft'; spot: CraftSpot } | { kind: 'dropCraft' } | { kind: 'resetCraft' } | { kind: 'resetDriver' };
interface ModeWorld {                                       // a narrow face of WorldSim
  readonly tick: number; readonly time: number;
  readonly entities: Entities;
  players(): Iterable<PlayerId>;
  spawn(kind, spec): EntityRef | null; despawn(ref): void; pin(ref, on: boolean): void;
  seat(player, seat: Seat): boolean; unseat(player): void;
  place(player, at: Pose): void;                            // an observer's or an avatar's position (focus)
  population(p: Partial<Population>): void;                 // multipliers 0..1 on today's density
  clock(c: { hour?: number; day?: number; source: 'client' | 'world' }): void;
  damage(ref, n, cause): void; heal(ref, n): void; setHealth(ref, hp, max): void;
  give(ref, s: ItemStack): void; transfer(from, to, type, n): boolean;
  end(result: RoundResult): void;                           // the host stops ticking, tells clients (a `round` event)
  random(): number;                                         // the mode's own rng(seed): replayable
}
interface Population { cars: number; peds: number; bikes: number; trains: boolean; boats: boolean }
```

### Where it runs in the tick

ADR 0007's order, with the mode in it:

1. Commands due (E7: queued, applied in order). Seat, item and edit commands ask the mode's `may*`; mode requests
   call `request`.
2. `mode.tick(w, tick)`: spawn, despawn, population, end.
3. The edit keeper, crafts, traffic, bodies (world-sim.ts:149-164).
4. The tick's events, in order, to `mode.event` (may `damage`: its `damaged`/`destroyed` carry the same tick).
5. Snapshot per client.

Today `WorldSim.update` runs several traffic ticks per call (traffic.ts:194-212) and the crafts per frame
(world-sim.ts:370-378). Steps 2 and 4 per tick need `WorldSim` to own the tick loop (E13); until then the mode is called
once per update with the ticks run, which is exact for sandbox (it does nothing per tick).

### Population

`Traffic.update` derives `density { cars, peds, bikes }` from the hour (traffic.ts:202-208) and `populate` spawns up to
it (494-509); above it cars leave at junctions (`enterNext`, 603) and people are trimmed out of sight. A
`Traffic.population` of multipliers (default 1, read in `update` as `density.x *= population.x`) gives: on (1), off
(0: the city empties out of sight, by today's rules, no pop-in), thinning (a mode lowering it over a round). Trains and
river boats: a flag each, off = no new departures (their sims skip spawning; running ones finish). Multiplier 1 is a
no-op, so neutral.

### Sandbox: today's behaviour as a mode

`sim/modes/sandbox.ts`. Everything the shells decide today, granted as asked:

| Today | Sandbox |
|---|---|
| `spawnCraft` from the shell with a spot found on the shell's own collision (nav/craft.ts:108-111; spots: nav/boat.ts:151-153, nav/special-craft.ts:162, nav/fpv.ts:196, nav/plane.ts:208-230) | the shell sends `request { kind: 'craft', type, spot }`; sandbox spawns at that spot, seats the player as pilot. The spawn search may stay in the shell for sandbox (it reads the page's tiles); a game mode ignores the spot and chooses its own |
| `placeCraft`, `resetCraft`, `resetDriver` | requests, granted |
| `dropCraft` on leave (nav/craft.ts:132-133) | gone with E8 (the craft stays); sandbox may still despawn a player's previous craft when they spawn a new one (one per player), so the map does not fill |
| `takeWheel` with `choice` (drive.ts:144: the car's type changed at claim, life-phys.ts:202-209) | `mayEnter` true; the type change stays a sandbox privilege (`request { kind: 'vehicleType' }` later, or kept as a `takeWheel` option only sandbox grants) |
| `walkAs` a crowd person (nav/ride.ts:94-109) | `mayEnter` true for any person |
| follow, orbit, free flight, first-person walk (`Mode` nav/nav.ts:33: `orbit`, `walk`) | client-only: no seat. The player is an observer; its focus comes in `SimInput` as today |
| hour and day from the page (main.ts:554) | `clock({ source: 'client' })` |
| `edit` from dig (dig.ts) | `mayEdit` true when the host was started with edits on |
| population by the hour | multipliers 1 |
| health, items | none set |

URL flags (main.ts:469-485, 419):

| Flag | Belongs to |
|---|---|
| `?mode=` (new; default `sandbox`) | the host: which `GameMode` it makes |
| `?seed=` | the host (world); a mode gets its own `rng` from it |
| `?dig=1` | sandbox option `edits: true` (and the page installs dig's input); a game mode decides edits itself |
| `?lifephys=0`, `?lpnear=`, `?lpmax=` | host/physics options, not the mode |
| `?worker=1`, `?mirror=1` | transport, not the mode |
| `?hour=`, `?date=`, `?weather=` | the client's clock: honoured only while the mode's clock source is `client` |
| `?cam=`, `?view=`, `?focus=`, `?crop=` | the client's camera (an observer); a game mode places the player and may ignore them |

What leaves the shells: the decision to spawn, to drop, to reset and where (later). What stays: input mapping, camera,
panel, model, the spawn *proposal* (a spot from the shell's collision) for sandbox.

### Later kinds the layer needs, sketched

- `item`: pose + `items`, no physics (put on the ground's surface at spawn, `Ground.surface`). Spawned by a mode
  (loot). Picked up through `pickUp`.
- `npc` (zombie): a person-like core outside the crowd: steering on the ground (`Ground.support`) toward a target,
  no footway graph needed; health; `impact` with cars as today's `struck`. Its brain is the mode's or a small
  behaviour module the mode attaches; the sim only steps it. Budget: in the active circles, like the crowd.
- A player avatar (on foot, first person, ADR 0008): a `person` entity spawned by a game mode outside the crowd, seat
  `walker`, with health and items. Sandbox keeps `walkAs` on crowd people and the client-only walk (question 1).

## 4. Client prediction

Needed before `?worker=1` becomes the default: the page draws the snapshot of the frame before, +1 frame input latency
(local-server.md section 6). Only the player's own seat entity is predicted; everything else is drawn from snapshots as
now.

| What | Predictable | How |
|---|---|---|
| craft cores | yes | pure, fixed step, `{x,y,z}` state (ADR 0006). The client already holds a core of the same class loaded from each snapshot (`MirrorSimClient`, sim-client.ts:231; `loadState`, core-state.ts:350) and a collision of its own over the page's tiles (`CraftLink.col`, nav/craft.ts:77) |
| Rapier car | partly | a one-car Rapier world on the page (Rapier is already bundled there), terrain from the page's tiles, traffic and other players as kinematic proxies from the snapshot. Contacts with them mispredict and are corrected |
| walker | already | the client authors the pose (`walkPose`); E7 bounds it on the sim |
| traffic, other players | no | interpolated between snapshots |

Reconcile, per seat input:

- Every `seatInput` carries `seq` (per player, increasing). The sim applies inputs per tick (E7, E13) and the snapshot
  echoes `ack: { seq, tick }`: the last input applied and the tick whose end state the snapshot carries.
- The client keeps its unacked inputs with the tick they were sent for. On a snapshot: `loadState(core, s.core)` (the
  server's state at `ack.tick`), then re-step the inputs after `ack.seq` through the client's collision, one world tick
  each (STEP worth of the core's own fixed steps). Drawn pose = predicted pose + a correction offset that decays over
  ~100 ms (the offset is presentation, never fed back into the core).
- Requires the craft step to follow the world tick (E13): today `stepCrafts(dt)` runs each core's `FixedStep` on the
  frame's `dt` (world-sim.ts:370-378; clocks 1/60 to 1/120 s: special-core.ts:20, drone-core.ts:22, boat-motion.ts:264,
  plane-flight.ts:26), so the number of steps between two inputs depends on the frame rate and cannot be replayed from
  tick numbers. With E13 each world tick (1/30 s) runs its craft steps with that tick's input.
- Collision differences (the worker's ground is level-1 nodes, `tile-world.ts`; the page's collision what the page
  loaded) show as corrections, not errors. Edits are mirrored (E9 step 3), so a crater is in both.
- Car: same scheme, the state being the chassis' pose, velocities and the controller's (wheel) state from
  `driverSnapshot`, re-stepped with the inputs after `ack`. Rapier's `world.takeSnapshot()` is not needed for one
  body.

## 5. Packages

In the handoff file's style. Each behaviour-neutral (same gate counts) unless it says otherwise. Waits on E7 unless
stated; none waits on E8's internals.

### E10. Entity index (S)

- **Waits for:** nothing (E7 for the seat part only: do it after if E7 is in flight).
- **Do:** `sim/entities.ts`: `EntityKind` with `'craft'`, `EntityRef` for crafts, `entityKey`, `Entities` with the
  kind adapters (`exists`, `pose`, `seats`); `foci()` (world-sim.ts:245-261) and `seat()` (228-234) through it;
  `follow` accepts a craft. Read only; no storage moves.
- **Gates:** tsc, core-deps, life-edit (players scenario), mirror-check, popin-check.

### E11. Seats from the model (S–M)

- **Waits for:** E7, E10.
- **Do:** seat specs per kind and type; `Seat = { entity, role, index }`; `enterSeat`, `seatInput`, `leaveSeat` in
  `SimCommand` with the old commands as aliases in `SimServer.apply`; `seated`/`unseated` events; `mayEnter` hook
  (always true until E14). Snapshot `seat.index`.
- **Gates:** tsc, core-deps, life-edit (players), rapier-car, mirror-check, popin-check.

### E12. Tick-numbered entity events (S)

- **Waits for:** E10.
- **Do:** crafts' core events and the driver's notes as `SimEvent`s with tick and entity (`craft`, `drive`);
  `craftEvents`/`driverNotes` filter `eventsSince` for the player's seat; `impact` beside `struck`. The snapshot drops
  `player.notes`/`craftEvents` (the events carry them).
- **Gates:** tsc, mirror-check, life-edit, craft-motion, plane, boat.

### E13. One tick loop in WorldSim (M, not neutral)

- **Waits for:** E7.
- **Do:** `WorldSim.update(dt)` accumulates and runs whole world ticks itself: per tick commands due, crafts stepped
  STEP worth on their own `FixedStep` with that tick's input, the traffic's one tick (`Traffic.step`, traffic.ts:447),
  events. `drawn(alpha)` interpolates between a craft's last two steps (E4's open point) so a 60 fps page does not see
  the craft move every other frame. `seatInput` carries `seq`; the snapshot `ack`.
- **Not neutral:** a craft's motion no longer depends on the frame rate; its drawn pose lags by up to one tick
  (interpolated), like the traffic's.
- **Gates:** craft-motion, plane, boat, life-edit (determinism at two rendering rates, crafts included now),
  mirror-check, popin-check; the owner flies each craft once.

### E14. Mode layer and sandbox (M)

- **Waits for:** E11 (E13 for a per-tick `tick`; before it, once per update).
- **Do:** `sim/mode.ts` (`GameMode`, `ModeWorld`, `ModeRequest`), `sim/modes/sandbox.ts`; `SimServer` makes the mode
  (`hostSim` option, `?mode=`, default sandbox) and calls it as in section 3; `spawnCraft`, `placeCraft`,
  `resetCraft`, `resetDriver`, `dropCraft` become `request`s; `edit` asks `mayEdit` (`?dig=1`: sandbox `edits`);
  `Traffic.population` multipliers (1). The shells send requests; nothing else in `nav/` changes.
- **Gates:** all fast gates, popin-check, `--transit`; browser check: follow, walk, drive, every craft, dig.

### E15. Health and items (S–M)

- **Waits for:** E10, E12.
- **Do:** `Health`, `ItemStack`, the component maps, `damage`/`heal`/`give`/`transfer`, `down` per kind (person:
  out of the crowd with a `dropped`-like fall event; car: `LifePhysics.wreck`; craft: neutral input), the events of
  section 2, `pickUp`/`drop` commands with `mayTransfer`; snapshot `entities` section. A headless check
  (`tools/entities.mjs`, fast set): a test mode sets health, a scripted car strikes a person, `impact` arrives,
  the mode's `damage` gives `damaged` and `destroyed` at the same tick; two runs bit-equal.
- **Gates:** new `entities`, life-edit, mirror-check; sandbox sets nothing, so the rest neutral.

### E16. Spawn, despawn, keep (S–M)

- **Waits for:** E8, E14.
- **Do:** `spawn(kind, spec)` for craft, parked car (at a pose), item (new kind: pose + items); `despawn`; `pin`.
  E8's presence drop becomes the default for every non-ambient, unpinned entity; `despawned` with `why`.
- **Gates:** life-edit (players), entities, mirror-check, popin-check.

### E21. The player's avatar (S–M, owner decision 1, not neutral)

- **Waits for:** E15, E16.
- **Do:** a `person` entity spawned for each player outside the crowd (health, items, `walker` seat), in every mode;
  the sandbox spawns it where the player starts walking; the client walk (bounded pose, E7) moves it; `walkAs` on
  crowd people goes, following them stays.
- **Gates:** life-edit (players), entities, mirror-check, popin-check; browser check: walk, enter a car, leave it.

### E17. Craft prediction (M, not neutral: less latency)

- **Waits for:** E13.
- **Do:** `MirrorSimClient` steps the player's craft core with its own inputs through `CraftLink.col`, reconciles on
  each snapshot (section 4), drawn pose with a decaying correction. A check: `mirror-check --predict` (the predicted
  pose within a bound of the server's at each acked tick, with a simulated 2-frame delay).
- **Gates:** mirror-check, craft-motion, plane, boat; measured input latency with `?worker=1` back to the in-page one.

### E18. Car prediction (L, not neutral)

- **Waits for:** E17.
- **Do:** a one-car `RapierCar` world on the page, kinematic proxies from the snapshot, reconcile from
  `driverSnapshot` state.
- **Gates:** rapier-car, vehicles, mirror-check --predict (car), latency measured.

### E19. Worker by default (S)

- **Waits for:** E17 (and E18, or the owner accepts +1 frame for the car meanwhile: question 3).
- **Do:** `main.ts`: `qs.get('worker') !== '0'`; local-server.md section 7.
- **Gates:** all fast gates, popin-check, browser check of every mode.

### E20. A probe mode (S)

- **Waits for:** E15, E16.
- **Do:** `sim/modes/probe.ts`, headless only (a tool, not a game): population 0, three players placed apart, an
  item spawned, a round ended after N ticks. Proves the layer carries "an empty city, players placed, loot, an end"
  without code outside `sim/modes/`.
- **Gates:** entities (probe scenario), core-deps.

## 6. Decisions (owner, 2026-11-23)

1. **The player on foot is always an avatar of its own**, in every mode, sandbox included: a `person` entity spawned
   for the player (health, items, `walker` seat), never one of the crowd. `walkAs` on crowd people goes when the
   avatar exists (E16); following a crowd person stays as an observer camera. Not neutral: sandbox changes there.
2. **Who simulates the walk:** left to the engine (owner: no preference). Decided: bounded client pose now (E7); the
   walk moves into a core when the first mode with damage on foot starts (after E15), predicted like a craft.
3. **Worker by default: no hurry.** E17–E19 are not urgent; they come after the entity and mode packages.
4. **Rounds:** none exist yet; when they do, a new `WorldSim` and mode per round is fine.
5. **Entity ids:** per kind (`{ kind, id }`), as recommended; an engine detail.
