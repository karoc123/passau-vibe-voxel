# 0006 The world sim and its presentation

Status: accepted (no server yet; the seam only). Code: `web/src/sim/traffic.ts` (`Traffic`),
`web/src/physics/rapier/life-phys.ts` (`LifePhysics`), presentation `web/src/sim/life.ts` (`StreetLife`); checks:
`web/tools/core-deps.mjs` (imports), `web/tools/life-edit.mjs` (headless run, determinism). Plan and measurements:
`docs/plans/life-physics.md`.

## Context

The world is to be hosted by a server, with destruction as a real part of it (ADR 0001: L2 edits). Physics that
players see (a car falling into a dug hole, stopping at a placed block) has to be decided in one place, and later
that place should be a server. Until now the street traffic (`sim/life.ts`) was one class that simulated, drew
instanced meshes (three.js), read the camera for picking, drew from `Math.random`, and computed the cars' poses while
drawing them; the prototype's bodies (`?lifephys=1`) stepped on the frame clock with a wall-clock collider budget, so
two runs differed.

## Decision

- **World sim**: `sim/traffic.ts` (cars, people, riders, signals, edits, the people over a hole) and
  `physics/rapier/life-phys.ts` (the cars near edits as Rapier bodies, their colliders: `terrain.ts`, `vehicle.ts`),
  on `core/`. It imports no three.js, no `util.ts`, no DOM and no `fetch`: `tools/core-deps.mjs` scans it with
  `core/`. Positions are plain `{ x, y, z }` (`sim/types.ts` `Vec3`), colours are strings.
- **Fixed tick**: `Traffic.update(dt)` runs whole ticks of `STEP` (1/30 s); the bodies step inside the tick
  (`TrafficBodies.tick`, 2 Rapier steps of 1/60 s). Nothing in the sim reads the frame's dt beyond counting ticks.
- **Deterministic budgets**: colliders are built a number of chunks per tick (`terrain.ts` `budgetChunks`), never
  within a number of milliseconds; chunks age by the sim's clock. Wall-clock time is measured for stats only.
- **Seeded randomness**: the sim draws from `core/num.ts` `rng(seed)`; `Traffic` takes a seed. `tools/life-edit.mjs`
  makes `Math.random` throw while the sim runs and checks two runs from one seed bit for bit (same process, same
  build of Rapier; across machines would need Rapier's enhanced-determinism build, not tried).
- **Inputs**: the hour and day, the focus (what is simulated) and the viewer (where agents may come and go unseen),
  the edited boxes (`Traffic.edited`, from `core/live-edits.ts`), the ground (`Traffic.ground`: `world.ts` World), the
  tiles (injected loader or cache), and the player's own doings (`keep`, `takeWheel`, `removePerson`). For a server,
  "the viewer" becomes the set of players' positions.
- **Outputs**: the agents' state per tick (cars on their paths, bodies' poses at the last two ticks, parked cars and
  wrecks with their pose), and events (`Traffic.dropped`: people fallen into a hole).
- **The player's vehicles' cores** (`nav/boat-motion.ts`, `nav/plane-flight.ts`, `nav/fpv-flight.ts`,
  `physics/rapier/car.ts`) keep the same rule, so a server can step or check each player's vehicle: plain `{ x, y, z }`
  state and maths (`core/vec.ts`, three.js's arithmetic in its order), stepped by one fixed-step runner
  (`core/fixed-step.ts`), scanned by `tools/core-deps.mjs`. Their shells (`boat.ts`, `plane.ts`, `fpv.ts`, `drive.ts`)
  read the input and draw them. They are not in the world sim yet (see below).
- **Presentation** (`sim/life.ts` `StreetLife`, three.js): draws the sim between its last two ticks
  (`Traffic.carPose`, `personPoint`, `TrafficBodies.pose`), the trains, the effects that change nothing in the sim
  (people knocked down or falling: shoved, tipping, no physics), picking on screen. It never decides anything the sim
  depends on.

## Consequences

- The sim runs headless in node as it would on a server (`life-edit.mjs` does: no three.js, no StreetLife).
- A client of a server would replace the sim by snapshots of its outputs and keep the presentation as it is; nothing
  here is networked yet.
- Not in the world sim yet: the trains (`sim/trains.ts`, scenery on their own tracks, three.js), the boats, the
  player's car (`drive-world.ts`: its own Rapier world, client side, the traffic as kinematic boxes in it).
