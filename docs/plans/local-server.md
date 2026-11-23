# A local server: the world sim behind a client interface, then in a Web Worker (E9)

Status: steps 1-4 done on branch `e9` (section 6); the worker is behind `?worker=1`, not yet the default. Target: [ADR 0008](../adr/0008-server-vision.md) ("Next proof of the
seam: a local server in the browser"), on [ADR 0006](../adr/0006-world-sim-seam.md) and
[ADR 0007](../adr/0007-player-control-in-world-sim.md). The page may only talk to the sim through `SimClient`:
commands in, snapshots and events out. First in the page's thread (neutral), then in a Web Worker behind `?worker=1`,
then by default.

## 1. Where the page touches the sim today (main 86e0ef88)

"R" read, "W" write (a command or a field written into a sim object). File:line of `web/src/`.

### Creation and the frame (`main.ts`)

| Where | What | R/W |
|---|---|---|
| main.ts:21, 96, 99-100 | `WorldSim` imported, held (`sim`), handed out as a promise (`simReady`) | – |
| main.ts:470-471 | `new WorldSim(td, { seed, loadPhysics, crafts: { meta, cache: viewerTileCache, now } })` | creation |
| main.ts:472 | `ws.setWorld(world, world)`: the sim's ground and water are the **streamer's** `World` (stream.ts) | W |
| main.ts:473 | `new StreetLife(scene, ws)`; `nav.life = life` (the nav reaches the sim through it) | – |
| main.ts:478-481 | `liveEdits.listen` → `ws.edited(box, cleared)`, `ws.loadPhysics()` | W |
| main.ts:483, 43 | `window.__sim = ws` (tools in the browser) | – |
| main.ts:484 | `?dig=1`: `ws.loadPhysics()` | W |
| main.ts:485 | `fetch boats.json` → `ws.setBoats(bd)` | W |
| main.ts:495 | `CraftContext.sim: simReady` (every craft shell gets the `WorldSim`) | – |
| main.ts:501-511 | `loadLifePhysics`: `LifePhysics.load(meta, focus, opts, { cache: viewerTileCache }, tuning.ride)` | creation |
| main.ts:560 | `sim.update(dt, { hour, day, focus, viewer: camera.position })` every frame | W |
| main.ts:562 | `life.update(dt, night, camera.position)` (draws the sim) | R |

### The presentation (`view/life.ts` `StreetLife`)

| Where | What | R/W |
|---|---|---|
| life.ts:55-57 | `sim.traffic.heads` (static), `sim.tick` | R |
| life.ts:63-65 | `sim.traffic`, `.people`, `.riders` (live arrays of the sim's objects) | R |
| life.ts:70-71 | `sim.eventsSince(seen)`, `sim.tick` | R |
| life.ts:72-77 | `T.boats` (BoatTraffic), `T.active` (the active circle) | R |
| life.ts:84 | `T.acc` (time since the last tick: interpolation) | R |
| life.ts:116-117 | `T.trains.coaches(back)`, `T.boats` (`poses`, `previous`, `elapsed`, `day`) | R |
| life.ts:127, 131, 147 | `T.bodies` (`LifePhysics`): `owns(c)`, `pose(c, a)` (writes `c.rp/rh/pitch/roll`, plays fades) | R (+W drawn fields) |
| life.ts:133-135, 156 | `T.pathPoint`, `T.carPose` (path maths over the static roads and `T.ground`) | R |
| life.ts:154-167 | `T.cars` (`s, ds, off, dOff, e, prev*, next*, lane, len, vt, col, brake, v`), `T.detachedCars` | R |
| life.ts:157-158, 183, 190-193, 215-218 | writes the **drawn** pose into the sim's objects: `c.rp, c.rh, c.pitch, c.roll`, `p.rp, p.rh` | W (drawn only) |
| life.ts:181 | `sim.walkedPose(p.id)` | R |
| life.ts:187-188, 212-213 | `T.personPoint` (people: `e, s, dir, lat, v, wait, ph, bike, col`) | R |
| life.ts:251 | `sim.ground` (`support`, `surface`: the people falling) | R |
| life.ts:296 | `T.signal(ctrl, axis)` (reads `T.t`) | R |
| life.ts:304, 329-352 | `T.roadVehicles()`, `people`: picking, `pose`, `nearest` hand out the **sim's objects** (`Rideable`) | R |

The sim reads none of the drawn fields for a decision except `LifePhysics.release` (life-phys.ts:571-583), which first
writes them itself (`put`). So the drawn fields are presentation state that happens to live on the sim's objects.

### The nav and the craft shells (`nav/`)

| Where | What | R/W |
|---|---|---|
| nav.ts:61, 154-155 | `nav.life` (StreetLife: the way to the sim) | – |
| nav.ts:142, 528 | `life.pose(kind, obj)`: where the followed agent is drawn | R |
| nav.ts:358-360 | `life.pick(...)`: a `Picked` holds the sim's `Car`/`Person` object | R |
| nav.ts:574 | `life.sim.traffic.peds` (static footways: the walk net) | R |
| ride.ts:3, 42 | `LOCAL_PLAYER`; `host.life().sim` | – |
| ride.ts:48, 57 | `sim.follow(LOCAL_PLAYER, ref / null)` | W |
| ride.ts:63 | `sim.release(LOCAL_PLAYER)` | W |
| ride.ts:69, 81-82, 95 | `life.pose`, `life.nearest` | R |
| ride.ts:98 | `sim.walkAs(LOCAL_PLAYER, id, pose)`: **synchronous result** (false: refused) | W+R |
| ride.ts:106 | `sim.walkPose(LOCAL_PLAYER, pose)` every frame | W |
| drive.ts:53, 57, 167-168 | `ctx.sim` → `sim.loadPhysics(warm)` (a request with a reply) | W |
| drive.ts:76 | `resetDriver` | W |
| drive.ts:86-87 | `driverSnapshot(LOCAL_PLAYER)`, `world.tick` (the claim's tick) | R |
| drive.ts:90-91 | `input(LOCAL_PLAYER, input)`, `driverNotes` (drained) | W, R |
| drive.ts:95 | `life.clearFallen` (presentation only) | – |
| drive.ts:126, 208 | `life.sim.traffic.roadVehicles()` | R |
| drive.ts:143-144 | `takeWheel(LOCAL_PLAYER, car.id, choice)`, `world.tick` | W |
| drive.ts:155 | `releaseWheel` | W |
| craft.ts:57 | `CraftContext.sim: Promise<WorldSim>` | – |
| boat.ts:63, 99-100 | `addCraft('boat')` (**synchronous**: the `Craft` with its core and collision), `enterCraft` | W+R |
| boat.ts:87 | `craft.core.pose` (map pose) | R |
| boat.ts:113-114 | `craftInput`, `craftEvents` (drained) | W, R |
| boat.ts:119-120 | `core.motion` (`speed, t`), `core.drawn(core.clock.alpha)` | R |
| boat.ts:127-147 | `craft.collision` (prefetch, `surface`, `findSpawn`), `core.motion.cfg`: the spawn search | R |
| boat.ts:149, 161, 172 | `placeCraft`, `removeCraft`, `resetCraft` (**synchronous result**: "Back on open water") | W(+R) |
| boat.ts:193-216 | `core.motion` (camera, panel: `kmh, waiting`), `collision.sweep` (camera) | R |
| plane.ts:100, 189-190 | `addCraft('floatplane' / 'jet')`, `enterCraft` | W+R |
| plane.ts:208-230 | `collision` (prefetch, `surface`, `openWater`), `placeCraft`, then **at once** `core.flight.heading`, `attitude()` | W+R |
| plane.ts:237-238, 264-270 | `core.pose`, `core.flight` (`state, p, heading`), `core.world(collision).water` | R |
| plane.ts:282, 286 | `resetCraft`, `removeCraft` | W |
| plane.ts:311-324, 355-371, 387-412 | `craftInput`, `craftEvents`; `core.flight` (camera, panel), `core.drawn`, `collision.sweep/surface` | W, R |
| fpv.ts:65, 143-147 | `addCraft('drone')`, `enterCraft`; `collision.width/depth` | W+R |
| fpv.ts:111, 186-194 | `collision.prefetch/surface`; `placeCraft` (also "Reset flight": placed again) | W |
| fpv.ts:114-115 | `craftInput`, `craftEvents` | W, R |
| fpv.ts:160 | `removeCraft` | W |
| fpv.ts:216 | **`core.waiting = false`** (the page writes into the core) | W |
| fpv.ts:221-222, 239-240, 286-297 | `core.pose`, `core.drawn`, `core.waiting`, `core.flight`, `collision.surface` | R |
| special-craft.ts:55, 104-106 | `addCraft(kind)`, `enterCraft` | W+R |
| special-craft.ts:116 | `removeCraft` | W |
| special-craft.ts:125-126 | `craftInput`, `craftEvents` | W, R |
| special-craft.ts:140-154 | `core.world(collision)` (`surface`, `sweep`): the spawn search | R |
| special-craft.ts:165, 169, 184 | `core.pose`; `placeCraft`; `core.motion` (`p, heading`: land on foot) | R, W |
| special-craft.ts:210-221, 237-247 | `core.drawn`, `core.motion` (`grounded, p, speed`), `core.result`, `collision.sweep/surface` | R |

### Edits and tiles

| Where | What | R/W |
|---|---|---|
| dig.ts:9, 18 | `initWorldEdits({ cache: viewerTileCache, frame, nx, ny })`: the page sets up the world's edits | W |
| dig.ts:37 | `apply(op)` (core/world-edits.ts): the page edits the world directly | W |
| stream.ts:7, 209, 445, 456-480 | `liveEdits` listened to and read: the streamer meshes edited nodes | R |
| stream.ts:461-463 | `viewerTileCache` (a node's files again) | R |
| viewer-tiles.ts:9 | one `TileCache` (over `liveEdits`) shared by: the edits (dig), the road physics' terrain (main.ts:509), the crafts' collisions (main.ts:471), the streamer (stream.ts:461) | – |
| stream.ts (World) | `world` = `streamer.world`: the sim's ground and water (main.ts:472), and the page's raycasts | R |

### Tools

`tools/life-edit.mjs`, `life-phys.mjs` drive a `WorldSim` directly: they are the server side and stay so.
`tools/popin-check.mjs:39, 80` draws a `WorldSim` with `StreetLife`: it becomes a client of it.

## 2. What crosses the boundary

- **Page → sim: commands** (`sim/sim-client.ts` `SimCommand`), plain JSON, each keyed by player: `follow`, `walkAs`,
  `walkPose`, `release`, `takeWheel`, `drive` (the car input), `releaseWheel`, `resetDriver`, `spawnCraft`
  (`addCraft` + `enterCraft` + `placeCraft` in one: the sim numbers the craft, the client never needs its id),
  `placeCraft` (the player's craft put down again), `craftInput`, `resetCraft`, `dropCraft` (the player's craft taken
  away: what the shells do on leave today; E8 changes it), `edit` (a `WorldOp`). They are queued and applied in the
  order sent at the start of the sim's next update, before the edit keeper and the ticks (ADR 0007: "commands take
  effect at the start of the tick"). Their outcome, where one can be refused (`walkAs`, `takeWheel` is already
  reported by `driverSnapshot`, `spawnCraft`, `resetCraft`, `edit`), comes back as a `CommandResult { tick, kind, ok }`
  per player.
- **Page → sim: the frame's input**: `{ hour, day, focus, viewer }` (`SimInput`) and `dt`. On a server this becomes
  each player's focus and viewer; the hour is the world's.
- **Page → sim: requests with a reply**: `loadPhysics(warm)` (Rapier loaded where the sim runs), `edit(op)` (the nodes
  changed, for dig's timing log).
- **Sim → page: snapshots** (section 4) after each update: tick, the traffic's drawn state, the players' reads (seat,
  walked poses, the driver's snapshot and notes, the crafts' state and events), the outcomes.
- **Sim → page: events since a tick** (`SimEvent`: `struck`, `dropped`), as now (`eventsSince`), carried in the
  snapshot from the client's last tick.
- **Sim → page: edits**: a node changed or dropped (its columns: `LiveNode` base and foliage, typed arrays,
  transferable) so the page's streamer meshes it and the page's `World` (raycasts, the camera's clearance) sees it.
- **Static data on both sides**: `meta.json`, `traffic.json` (the roads, footways, signals: the path maths of
  `carPose`/`personPoint` are a pure function of it and an agent's state), `boats.json`, the tuning.

## 3. Who owns what

| | In the page's thread (step 1) | With the worker (step 5) |
|---|---|---|
| `WorldSim` | the client (`LocalSimClient`) | the worker |
| `liveEdits` (core/live-edits.ts) | the module, one per page (as today) | the worker's module instance is the world's; the page keeps a **mirror** `LiveEdits` filled from the edit messages, for the streamer and the page's `World` |
| `initWorldEdits`, `apply` | called by the client (an `edit` command), no longer by dig.ts | the worker |
| the TileCache of the edits, the road physics' terrain, the crafts' collisions | `viewerTileCache` (shared with the streamer) | the worker's own `TileCache` (fetchGzip works in a worker); the page's `viewerTileCache` stays for the streamer and the shells' own collisions |
| the sim's ground and water | the streamer's `World` (as today) | a `World` over the worker's TileCache (level-1 nodes; a `ColumnSource` adapter). **Differs**: today the ground answers with the finest tile loaded by the streamer; level 1 is what is loaded near the focus anyway |
| the road physics (Rapier) | loaded in the page's thread | loaded in the worker |
| the crafts' collisions | the sim's (stepping), the shell's own (spawn search, camera sweep, panel heights) | the same, in their threads |
| drawn state (`rp`, `rh`, falling people, leans) | on the sim's objects (as today) | on the page's mirror objects only |

## 4. The snapshot

One per sim update, for one client; in the worker a message of plain arrays (structured clone; the numeric parts in
`Float64Array`s, transferred). Its parts:

- `tick`, `acc` (s since the last tick: what the drawing interpolates by), `t` (the world clock: the signals), `day`.
- **cars** (ids in the interest circle): `id, e, lane, s, ds, off, dOff, prev, prevOff, prev2, prev2Off, next,
  next2, len, bus, vt, col, brake, v, wait` — enough for the client's own `Traffic.carPose` / `pathPoint` over the
  static roads (the same maths, so drawing is the same as now); `detachedPose` for a parked car or a wreck.
- **bodies** (the cars that are Rapier bodies): per car its drawn pose at the last two ticks (`poseAt(b, 0)`,
  `poseAt(b, 1)`) and its fade, so `bodies.pose(c, a)` is answered on the client.
- **people, riders**: `id, e, dir, s, v, lat, ph, wait, col, bike`; the walked ones' pose (`walkedPose`).
- **trains**: the coach poses at the last two ticks; **boats**: `poses`, `previous`, `elapsed`, `day` (already
  plain).
- `active` (the active circle's middle: which signal heads are drawn).
- **players** (this client's): `seat`, the driver's snapshot and notes, the craft piloted (`id, type, placed`, its
  core's state: `save()` per core, loaded into a client-side core of the same class: `drawn(alpha)`, `motion`,
  `flight` read as now; later the base of prediction), its events, the command outcomes.
- **events** since the client's last tick.
- **edits**: the nodes changed since the last snapshot.

The client keeps a **mirror**: a `Traffic` made from the same `TrafficData`, never ticked, whose `cars`, `people`,
`riders`, `detachedCars` are set from each snapshot, keeping one object per id (so drawn fields, leans and the
nav's ride, which holds an object, carry over); `ground` is the page's `World`. The presentation then reads the
mirror exactly as it reads the `Traffic` today (`TrafficView` in sim-client.ts is that surface).

**Interest by focus**: a client gets the agents within its viewer's pop radii (cars, people and riders within the
active circle round its focus, `ACTIVE_R`; trains within 400 m, boats within 800 m: the radii popin-check holds),
every player's craft within 2 km, events where they happen within those radii. Today one focus drives the active
circle; with several players the sim's circles follow every focus (`WorldSim.foci`) and each client's snapshot is
filtered by its own. Sizes (Hauptbahnhof at rush hour, 355 cars, 224 people): about 355 x 20 + 233 x 10 numbers,
some 75 KB a snapshot as float64; for a network later, quantised and delta-coded.

## 5. Steps (each its own commit, gates green)

1. **`SimClient` and an in-thread `LocalSimClient` over `WorldSim`.** The page holds a `SimClient` only:
   `main.ts` makes it (`sim-host.ts`: the `WorldSim` with its loaders, its ground, its boats, the edits wired),
   `StreetLife(scene, client)`, `CraftContext.sim: Promise<SimClient>`, the nav and shells send commands. The
   client's `traffic` is the live `Traffic` (typed as `TrafficView`, read only). Commands are serialisable and queued,
   applied at the start of `update`: since every shell runs before `sim.update` in main.ts's frame, they reach the
   same tick as today. The shells search spawns on their own `VoxelCollision` and send `spawnCraft`. dig.ts sends
   `edit`. Neutral: same gate counts; `popin-check` draws through the client.
2. **The snapshot in the page's thread** (`?mirror=1`): the `LocalSimClient` encodes a snapshot after each update and
   the presentation draws a mirror `Traffic` decoded from it. popin-check runs over the mirror too: proves the format
   draws what the sim holds, with no worker in the way. Craft cores get `save()`/`load()`.
3. **Edits across**: the client mirrors `liveEdits` from edit messages (the in-thread client: the same module, so a
   no-op), the streamer reads the mirror.
4. **The worker** (`sim/sim.worker.ts`, `WorkerSimClient`) behind `?worker=1`: the host (`sim-host.ts`) in the
   worker with its own TileCache, ground (`World` over it) and Rapier; the page posts `{ dt, input, commands }` per
   frame and draws the latest snapshot (one frame behind: the worker updates while the page renders).
5. **Measure** frame time and input latency (key down to the first frame drawing its effect) with and without the
   worker; **default** if solid.

## 6. As built (branch `e9`)

- `sim/sim-client.ts`: `SimClient`, `SimCommand`, `CommandResult`, `TrafficView`, `CraftView`; `LocalSimClient` (the
  sim's own objects read in place), `MirrorSimClient` over a `SimLink` (`ThreadLink`: the server in the page's
  thread, `?mirror=1`; `WorkerLink` in `sim-worker-link.ts`: `?worker=1`).
- `sim/sim-server.ts` `SimServer`: the queue, the outcomes, a snapshot per player, the edits tracked for a client in
  another thread. `sim/snapshot.ts`: `Snapshot`, `takeSnapshot`, `TrafficMirror`. `sim/craft/core-state.ts`: a craft
  core's fields saved and loaded into a core of the same class on the client (no per-core code).
- `sim-host.ts` `hostSim`: the WorldSim wired (physics loader, crafts' world, ground, boats, `initWorldEdits`, the
  edits told to the sim), for the page's thread and the worker alike. `sim.worker.ts`: its own TileCache
  (`viewer-tiles.ts` `tileCacheAt`), live edits, ground (`tile-world.ts`), Rapier.
- The craft shells go through `nav/craft.ts` `CraftLink` (spawn, place, input, events, reset, close; a
  `VoxelCollision` of their own). `fpv.ts` no longer writes `core.waiting`; `plane.ts` sets its chase camera from the
  plane the first frame the sim has put it down (one frame later than before).
- Gates: `tools/mirror-check.mjs` (fast set): two sims from one seed, one drawn directly, one through snapshots,
  agree bit for bit every frame (agents' poses, instance matrices, seats, a walked person). `popin-check --mirror`
  passes. Not bit for bit: a Rapier body's drawn pose (the mirror blends its two drawn poses linearly, the sim its
  quaternions); not covered by a gate.
- Measured (headless Chrome, software GL, 480 x 300, `seed=7`, Ludwigsplatz; ms per frame):

  | | frame (avg / p95) | sim on the page | sim in the worker | snapshot applied on the page | input latency |
  |---|---|---|---|---|---|
  | map view, in the page | 27.8 / 49.9 | 1.05 | – | – | |
  | map view, worker | 28.0 / 50.0 | 0.04 | 1.51 | 0.22 | |
  | following a car, in the page | 86.1 / 116.6 | 2.90 | – | – | |
  | following a car, worker | 86.8 / 116.7 | 0.04 | 3.52 | 0.25 | |
  | driving, in the page | 66.2 / 83.4 | 3.83 | – | – | 1 frame (~63 ms) |
  | driving, worker | 65.8 / 83.4 | 0.05 | 4.89 | 0.27 | 2 frames (~123 ms) |

  The frames are the software renderer's; the sim's share of the page's thread drops from 1-4 ms to about 0.3 ms
  (plus the message's structured clone, not measured). The worker takes 0.5-1 ms more than the update alone (the
  snapshot). Input latency is one frame more with the worker (the page draws the snapshot of the frame before).

## 7. Left

- **Default**: the worker is solid in the browser checks (follow, walk, drive, every craft, dig) but costs a frame
  of input latency until the client predicts its own vehicle (ADR 0008). Flip in `main.ts` (`qs.get('worker') !== '0'`).
- **Interest by focus** (section 4): the snapshot carries the whole active circle; no filter per client yet.
- **Compact encoding**: the snapshot is plain objects (about 900 agents at the Altstadt); typed arrays and deltas
  come with a network.
- The worker fetches and decodes the level-1 nodes the page's streamer and shells also fetch (the browser's cache
  saves the second download, not the decode); the build has Rapier twice (the page's and the worker's chunk; a page
  loads one).
- Tools that reach `window.__sim` get the client (`seat`, `driver`, `craftOf`, `traffic`); `players`, `crafts`,
  `physics` of the WorldSim are gone from the page.

## 8. Open, for the owner

- The worker's ground is level 1 only (the streamer's is whatever is loaded). Near the focus that is the same.
- With the worker the page draws one update behind (the snapshot of the frame before): one frame of input latency
  (measured, section 6), against a main thread freed of the sim (1-4 ms a frame here, more with Rapier bodies).
- The shells still decide where a craft is put and remove it on leave (`spawnCraft`, `dropCraft`): a mode's job later;
  E8 keeps a left craft in the world.
- `LOCAL_PLAYER` stays in sim/world-sim.ts until E7 moves it to the client.
