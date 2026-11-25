# 0006 The world sim and its presentation

Status: accepted. World sim: `web/src/sim/world-sim.ts` (`WorldSim`, its host), `web/src/sim/traffic.ts`, `web/src/sim/train-traffic.ts`,
`web/src/sim/boat-traffic.ts` and `web/src/physics/rapier/life-phys.ts` (`LifePhysics`). Presentation: `web/src/view/life.ts` (`StreetLife`). Checks:
`web/tools/core-deps.mjs` (imports), `web/tools/life-edit.mjs` (headless run, determinism).

## Context

The world is to be hosted by a server, with destruction as a real part of it (ADR 0001: L2 edits). Physics that
players see (a car falling into a dug hole, stopping at a placed block) has to be decided in one place, and later
that place should be a server. Until now the street traffic (`sim/life.ts`) was one class that simulated, drew
instanced meshes (three.js), read the camera for picking, drew from `Math.random`, and computed the cars' poses while
drawing them; the prototype's bodies (`?lifephys=1`) stepped on the frame clock with a wall-clock collider budget, so
two runs differed.

## Decision

- **One host**: `sim/world-sim.ts` `WorldSim` owns the `Traffic` and loads the road physics (`LifePhysics`) through a
  loader it is given (the viewer: a lazy import of Rapier on the first edit or drive; the tools: tiles from disk). The
  viewer (`main.ts`), the tools (`life-edit.mjs`, `life-phys.mjs`, `popin-check.mjs`) and later a server create it and
  call `update(dt, { hour, day, focus, viewer })` the same way. In the viewer it is ticked every frame once the traffic is
  loaded, whether or not the street life is drawn yet (`main.ts`; ADR 0008).
- **World sim**: `sim/traffic.ts` (cars, people, riders, signals, edits, the people over a hole) and
  `physics/rapier/life-phys.ts` (the cars near edits as Rapier bodies, their colliders: `terrain.ts`, `vehicle.ts`),
  on `core/`. It imports no three.js, no `util.ts`, no DOM and no `fetch`: `tools/core-deps.mjs` scans all of
  `core/`, `sim/` and `physics/` (presentation lives in `view/` and `nav/`). Positions are plain `{ x, y, z }`
  (`sim/types.ts` `Vec3`), colours are strings.
- **Fixed tick**: `Traffic.update(dt)` runs whole ticks of `STEP` (1/30 s); the bodies step inside the tick
  (`TrafficBodies.tick`, 2 Rapier steps of 1/60 s). Trains and river traffic advance in those same ticks. The train
  sim owns routes, coach spacing and station stops. The boat sim samples the timetable with the tick's hour and day,
  and floats each vessel on the world's water top there (`sim/river.ts`). Both derive their schedules from the world seed.
- **Deterministic budgets**: colliders are built a number of chunks per tick (`terrain.ts` `budgetChunks`), never
  within a number of milliseconds; chunks age by the sim's clock. Wall-clock time is measured for stats only.
- **Seeded randomness**: road traffic draws from `core/num.ts` `rng(seed)`. Rail and river schedules use seeded
  hashes. `tools/life-edit.mjs`
  makes `Math.random` throw while the sim runs and checks two runs from one seed bit for bit (same process, same
  build of Rapier; across machines would need Rapier's enhanced-determinism build, not tried).
- **Inputs** (all through `WorldSim`): the hour and day, the focus (what is simulated) and the viewer (where agents may
  come and go unseen), the edited boxes (`WorldSim.edited`, from `core/live-edits.ts` in `main.ts`), the ground and
  water (`WorldSim.setWorld`: `core/world.ts` World), the tiles (injected loader or cache), and the players' commands
  keyed by player id (`WorldSim.send`, `sim/contract/commands.ts`: `follow`; a seat on an entity, one a player: the
  driver's with `takeWheel`, `drive`, `resetDriver`, the walked person's with `walkAs`, `walkPose`, a craft's with
  `enterCraft`, `craftInput`; `leaveSeat`; the host names the page's player, `PAGE_PLAYER` in `host/sim-host.ts`, and
  the server's `Session` (`sim/server/sim-server.ts`) stamps it on every command). The traffic keeps what players
  follow or walk as by entity id (`Traffic.held`, `Traffic.walked`).
  For a server, "the viewer" becomes the set of players' positions.
- **The world's edits** (`core/world-edits.ts`, ADR 0001) are kept by the world sim: `update` drops an edited node no
  player's focus has been near for a while (`sim/edit-keeper.ts`, `Tuning.edits`), before its ticks.
- **Outputs**: the agents' state per tick (cars on their paths, bodies' poses at the last two ticks, parked cars and
  wrecks with their pose), the players' reads (`seat`, `walkedPose`, `driverSnapshot`, `driverNotes`), and the events,
  each with the tick that produced it (`WorldSim.eventsSince(tick)`, kept `EVENT_TICKS`: `struck`, people knocked down
  by a driven car; `dropped`, people fallen into a hole), so several readers each take theirs.
- **The player's vehicles' cores** (`sim/craft/boat-motion.ts`, `sim/craft/plane-flight.ts`, `sim/craft/fpv-flight.ts`,
  `physics/rapier/car.ts`) keep the same rule, so a server can step or check each player's vehicle: plain `{ x, y, z }`
  state and maths (`core/vec.ts`, three.js's arithmetic in its order), stepped by one fixed-step runner
  (`core/fixed-step.ts`), scanned by `tools/core-deps.mjs`. Their shells (`boat.ts`, `plane.ts`, `fpv.ts`, `drive.ts`)
  read the input and draw them. Road vehicles share the world tick and Rapier terrain, as described in [ADR 0007](0007-player-control-in-world-sim.md).
- **Presentation** (`view/life.ts` `StreetLife(scene, sim)`, three.js): only draws: the sim between its last two ticks
  (`Traffic.carPose`, `personPoint`, `TrafficBodies.pose`, train and boat poses), the effects that change nothing in the sim
  (people knocked down or falling: shoved, tipping, no physics), picking on screen. It never decides anything the sim
  depends on.

## Consequences

- The sim runs headless in node as it would on a server (`life-edit.mjs` and `life-phys.mjs` create a `WorldSim`: no
  three.js, no StreetLife).
- A client of a server would replace the sim by snapshots of its outputs and keep the presentation as it is; nothing
  here is networked yet.
