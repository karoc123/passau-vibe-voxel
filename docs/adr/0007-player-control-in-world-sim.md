# 0007 Player control in the world sim

Status: proposed. Builds on [ADR 0006](0006-world-sim-seam.md).

The street sim already runs without a renderer, but driving and walking a followed pedestrian still write into its
objects from the viewer. A server-hosted world needs to decide who controls each vehicle or pedestrian and apply the
result of their interactions once. One world sim will own these decisions for all players. The local viewer will use
the same interface with one player.

## Player control

- A **player id** identifies a participant within a world instance and stays the same across changes of vehicle,
  pedestrian or camera mode. A vehicle or pedestrian has its own entity id, retained when it changes between traffic,
  player control and a parked or wrecked state. A vehicle type such as `bus` describes a model shared by many entities.
- The sim accepts commands keyed by player id, including `takeWheel(playerId, entityId)`, control input and release.
  The sim checks eligibility and availability, transfers control at a tick boundary and reports the outcome. If two
  players request the same car in one tick, the first eligible command in the world's recorded order wins. Following a
  vehicle with the camera uses a pose from the snapshot and carries no driving rights.
- The sim owns vehicle type changes, pedestrian control, parking and collision consequences. In the current viewer
  `nav.ts` and `nav/foot.ts` write `person.ctl`, `drive.ts` changes the car type, `DriveSession` publishes poses
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
- Move train routes, dwell times and spacing out of `sim/trains.ts`, and boat routes, timetables and flood limits out
  of `sim/boats.ts`, into plain simulation state advanced from the world clock. Sample the same world time, day and
  water level on a tick. Use the world seed for route choices that need randomness. Train length belongs in the sim
  because it affects spacing. Meshes, paint, lights and boat bobbing stay in presentation. The existing player boat
  core can be stepped from the world clock when player boat control joins it.
- Copy `BOAT`, `PLANE`, `RIDE` and related defaults into read-only tuning for each world instance. Pass that tuning
  to the cores and physics constructors, with vehicle-specific overrides resolved at creation. Tools that vary tuning
  create worlds with different settings. A run can be reproduced from its build, seed, tuning and input history.

## Migration and validation

1. As the first increment of F4, introduce player-keyed commands and snapshot reads for the local player. Use the
   existing models and behavior to move control writes and collision outcomes out of the viewer.
2. Move player cars into the shared physics world. Measure shared collider and stepping costs with
   `web/tools/life-phys*.mjs`, and keep the existing `rapier-car` and `vehicles` gates green.
3. Move boat and train motion into the world tick in F5. Extend `web/tools/core-deps.mjs` to guard the new sim code
   and `web/tools/life-edit.mjs` or a headless scenario to exercise two players. Replay two claims to the same car,
   player and traffic collisions in edited terrain, and releasing control while the second player continues. Compare
   outcomes and snapshots in runs with the same build of Rapier. Cross-machine replay needs separate validation.

Network transport, reconnect policy, area and collider limits for widely separated players, and authoritative aircraft
control are open. The policy for sharing transient edits remains in [ADR 0001](0001-world-layers.md).
