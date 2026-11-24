# 0007 Player control in the world sim

F4 implemented [shared road physics](../plans/shared-road-physics.md). F5 added train and boat motion to the world
clock. Both build on [ADR 0006](0006-world-sim-seam.md).

The street sim already runs without a renderer, but driving and walking a followed pedestrian still write into its
objects from the viewer. A server-hosted world needs to decide who controls each vehicle or pedestrian and apply the
result of their interactions once. One world sim will own these decisions for all players. The local viewer will use
the same interface with one player.

## Player control

- A **player id** identifies a participant within a world instance and stays the same across changes of vehicle,
  pedestrian or camera mode. A vehicle or pedestrian has its own entity id, retained when it changes between traffic,
  player control and a parked or wrecked state. A vehicle type such as `bus` describes a model shared by many entities.
- The sim accepts commands keyed by player id, including `takeWheel(playerId, entityId)`, control input and release
  (`sim/commands.ts` `PlayerCommand`, sent with `WorldSim.send` and applied in order at the start of the next update:
  `takeWheel`, `drive`, `resetDriver`, `leaveSeat`, read back with `driverSnapshot`, `driverNotes` and `results`; the
  seat table in `WorldSim` holds one seat a player; `nav/drive.ts` reaches it through its `SimClient`).
  The sim checks eligibility and availability, transfers control at a tick boundary and reports the outcome. If two
  players request the same car in one tick, the first eligible command in the world's recorded order wins. Following a
  vehicle with the camera uses a pose from the snapshot and carries no driving rights.
- The sim owns vehicle type changes, pedestrian control, parking and collision consequences. In the current viewer
  walking as a person is a seat taken through the sim (`WorldSim.walkAs`, the walk sent as poses by `nav/ride.ts`;
  E2), but `drive.ts` changes the car type, `DriveSession` publishes poses
  back into cars, and `StreetLife.knockDown` calls `Traffic.removePerson`. Move those writes behind the sim
  interface. Keep `removePerson` as an internal operation on an entity id when the sim confirms a collision or other removal, and
  publish the event for the renderer to animate.
- Publish tick-numbered snapshots of entity poses and control state, with events tied to the tick that produced them.
  The renderer interpolates for drawing and picking. It can retain a local selection by id. The sim derives active
  areas from world positions of participants and their controlled entities. A solo map viewer can supply an explicit
  local focus input to preserve its camera-driven traffic.

## World and clock

- The world sim owns one Rapier world, one terrain collider cache and one budget for player cars and nearby traffic
  bodies. Today `RapierDrive` steps a separate world around one player car and copies traffic into kinematic proxies,
  while `LifePhysics` steps traffic bodies near edits. In the shared world, taking the wheel changes the controller
  for an existing body or promotes its path pose to a body. Bodies are keyed by entity id and the player record
  identifies which body receives that player's input. Release stops player input and lets the same car settle on
  subsequent world ticks. Parked cars and wrecks keep their final pose and can participate in collisions near players.
  The shared step resolves mutual contacts where mirrored bodies can only approximate them. It also puts all nearby
  bodies and terrain requests under one per-tick cost that F4 needs to measure.
- Use a 1/30 s world tick and two 1/60 s Rapier steps per tick as in `LifePhysics`. Commands take effect at the start
  of the tick, then the world updates traffic, builds a fixed number of terrain chunks in a stable order, steps physics
  once per substep and publishes the result. With multiple active areas, merge requests for the same chunk and use a
  stable tie-break at equal priority. The host controls when inputs and terrain edits become visible to a tick. Replay
  uses those tick assignments and the same terrain build and readiness schedule, so arrival times and rendering frames
  cannot silently change the result.
- `sim/train-traffic.ts` owns train routes, dwell times and spacing. `sim/boat-traffic.ts` owns boat routes and
  timetables, and floats each vessel on the world's water where it is (`sim/river.ts`). Both run in the traffic tick
  using world time, day and seed.
  They publish plain coach and vessel poses. Meshes, paint, lights and boat bobbing stay in presentation.
  The player boat joins the world clock when its control moves there.
- Train coaches publish 2.9 × 4 × 20 m boxes. Near a player driver the shared Rapier world moves kinematic colliders
  to the coach poses over the two physics substeps. Player cars and bikes register impacts and trains keep their
  scheduled movement. Collisions with walkers, boats and aircraft and trains stopping for track obstructions are open.
- Tuning is read-only and passed in. `Tuning` (`sim/tuning.ts`) is `{ ride, boat, plane, jet, craft, edits }`;
  `DEFAULT_TUNING` gathers the frozen defaults, which stay next to the code they tune (`RIDE` in `sim/vehicles.ts`,
  `BOAT`, `PLANE`, `JET`, `CRAFT` in `sim/craft/`, `EDIT_KEEPING` in `sim/edit-keeper.ts`). Each part goes to its consumer's constructor, with the default as
  fallback: `ride` to `createVehicle`/`createWheels`, `RapierCar` and `LifePhysics`; `boat` to `BoatMotion` and
  `findSpawn`; `plane` or `jet` to `PlaneFlight`; `craft` to `CraftMotion`. Vehicle-specific overrides (`CarBuild.tune`
  in the catalog) are resolved at creation (`rideOf`). One world per server (ADR 0008), so the point is no mutation
  and explicit passing, not several instances. Tools that vary tuning build a modified copy and pass it
  (`rapier-car.mjs --set`, `surface-gap.mjs --set`, `plane.mjs --set`). A run can be reproduced from its build, seed,
  tuning and input history.

## Migration and validation

1. As the first increment of F4, introduce player-keyed commands and snapshot reads for the local player. Use the
   existing models and behavior to move control writes and collision outcomes out of the viewer.
2. Move player cars into the shared physics world. Measure shared collider and stepping costs with
   `web/tools/life-phys*.mjs`, and keep the existing `rapier-car` and `vehicles` gates green. The Rapier scenarios
   replay two claims to one car, collisions with traffic and one player releasing while another continues.
3. F5 moved boat and train motion into the world tick. `web/tools/core-deps.mjs` guards the transit sim and
   `web/tools/life-edit.mjs` checks determinism at two rendering rates. `web/tools/popin-check.mjs --transit`
   checks the real map for visible arrivals, removals and jumps. Cross-machine replay needs separate validation.

Network transport, reconnect policy, area and collider limits for widely separated players, and authoritative aircraft
control are open. The policy for sharing transient edits remains in [ADR 0001](0001-world-layers.md).
