# Smooth motion and lag: the frame, the clocks, prediction

Status: M1 and M3 built (section 4); the rest is research and design. Reference case: the driven car judders ("set back, then jumps forward",
worse with speed), with the sim in the page's thread and with `?worker=1`. Target: [ADR 0008](../adr/0008-server-vision.md)
(an authoritative server, 10–50 players), on [ADR 0006](../adr/0006-world-sim-seam.md),
[ADR 0007](../adr/0007-player-control-in-world-sim.md), local-server.md (E9 plan, deleted; in git at `b5483793`) and
[entities-and-modes.md](entities-and-modes.md) (section 4, E13, E17–E19). File:line of `web/src/` at main `b8f769a7`.

## 1. The reference case

### Cause

**The chase camera is placed from the pose the car was drawn at in the frame before; the car is then drawn at this
frame's pose.** It is not a networking problem and not an interpolation problem.

The frame (main.ts:547-594):

| Order | Line | What |
|---|---|---|
| 1 | main.ts:551 | `DriveMode.update`: the input sent |
| 2 | main.ts:552 | `nav.update(dt)` → `Rider.update` (ride.ts:84-87): `life.pose()` → `RideCamera.frame` → `glide.place`: **the camera placed** |
| 3 | main.ts:580 | `sim.update(dt)`: the ticks due, `acc` advanced (traffic.ts:210-211) |
| 4 | main.ts:582 | `life.update` → `drawCars(acc / STEP)` (life.ts:84, 114, 147): `c.rp`, `c.rh` written for this frame, **the car drawn** |
| 5 | main.ts:594 | render |

`StreetLife.pose` (life.ts:336-339) does not compute a pose: it returns `c.rp`, the field step 4 wrote in the frame
before. So in frame N the camera sits behind `pose(N-1)` and the car is drawn at `pose(N)`. Seen from the camera, the
car is ahead by `v · dt_N`. With even frames that is a constant (harmless: the camera is `v · dt` further back than
its rig says). With uneven frames it changes by `v · (dt_N − dt_{N-1})` from one frame to the next: a frame that takes
two refresh intervals throws the car forward by `v · 16.7 ms`, the next normal frame takes it back. That is the
"set back, jumps forward", it grows with speed, and it is the same code in both modes (ride.ts reads `c.rp` of the
`TrafficView` either way), which is why the drawn clock in the worker client changed nothing.

### Evidence

Measured in headless Chrome on the real map (`?seed=7`, the car taken by "Follow a car", 200 frames of gas, then the
pattern; 80 km/h = 22.2 m/s). Headless renders at ~15 fps, so `requestAnimationFrame` was wrapped to hand the frame
loop synthetic timestamps (the loop takes `dt` from them: main.ts:548); sampled after `life.update` each frame: the
drawn pose (`c.rp`, `c.rh`), the camera's position, `acc`, the tick. "Car vs camera" is the drawn car's position
along its heading relative to the camera, frame to frame; px for a 1080-high screen at the chase rig (9 m back, 3.6 m
up, 55° fov). No source was changed.

| Frame pattern (page thread) | Car vs camera, per frame: mean / max | on screen | Drawn car in the world: step − v·dt, max |
|---|---|---|---|
| 60 Hz even | 0.0 / 0.0 cm (camera 9.37 m back, rig: 9.00) | 0 | 0.02 cm |
| 60 Hz, every 6th frame takes 33.3 ms | 12.2 / **36.9 cm** | 4.8 / 14.7 px | 0.05 cm |
| 60 Hz, 20 % of frames take 33.3 ms (random) | 8.4 / 36.9 cm | 3.3 / 14.7 px | 0.04 cm |
| 60 Hz, timestamps ±2 ms | 2.9 / 8.4 cm | 1.2 / 3.4 px | 0.02 cm |
| 120 Hz even, 144 Hz even | 0.0 / 0.0 cm | 0 | 0.01 cm |
| 144 Hz, 20 % of frames take 13.9 ms | 5.4 / 15.4 cm | 2.2 / 6.4 px | 0.02 cm |
| **Control**: the camera placed again after `life.update` (same frame's pose), 60 Hz every 6th missed | **0.0 / 0.0 cm** (9.00 m back) | 0 | 0.05 cm |
| Control, 60 Hz 20 % missed; 144 Hz 20 % missed | 0.0 / 0.0 cm | 0 | 0.04; 0.02 cm |

- The model `v · (dt_N − dt_{N-1})` explains every frame: residual mean 0.00–0.01 cm in all page-thread rows.
  One missed frame at 60 Hz, 80 km/h: +36.5 cm, then −36.0 cm (22.2 m/s × 16.7 ms = 37 cm).
- The control (the sampler calls `Rider.update(0, …)` once more after `life.update`; nothing else differs) removes
  it entirely. So the order alone is the cause.
- Ruled out, by the last column: the interpolation itself. The drawn car's step per frame equals `v · dt` within
  0.05 cm at every pattern and rate, across tick boundaries: `prev`/`cur` (life-phys.ts:367, 407), the two SUB steps
  inside a tick (life-phys.ts:370-405), `poseAt` (life-phys.ts:682) and `alpha = acc / STEP` are right; 30 Hz ticks
  against 60/120/144 Hz frames are not a problem; `detachedPose` (life-phys.ts:435) is overwritten by the body's pose
  for a driven car (436) in the same call; no jump from a recovery or a nudge shows in the runs. `glide.place` (glide.ts:31-33) copies
  the pose outside a transition: no filter in x/z, no fight. The only filter is the height's
  (ride.ts:129, `1 − exp(−9 dt)`), frame-rate independent.
- Not measured: the owner's real frame times. The defect needs uneven frames; how uneven theirs are (a tick's cost
  landing in every second 60 Hz frame, tile streaming, GC) is unknown. M1's tool records it.

### The fix (M1; described, not built)

Per the engines' own rule (section 2, P3): the camera is placed once per frame, after the sim's update, from the pose
the followed thing is drawn at in that same frame.

- Frame order: input → `sim.update` → the drawn poses for this frame's alpha → **camera** → what depends on the camera
  (view cut, fog, far plane, streamer, shadows, precipitation, labels) → instance matrices → render.
- `Nav.update` splits: the controls (walk, input: before the sim, as now) and the camera of a ride (after the poses).
  The walk on foot is unaffected: it moves and places its camera in one call.
- `StreetLife.pose(kind, obj)` must mean "the pose drawn this frame". Either the pose pass runs before the camera and
  the matrices after, or `pose` samples at the frame's alpha itself instead of reading a field. The second is the
  design of section 3 (a pure sampler); the first is enough for M1.
- `sim.update` still gets `viewer: camera.position` from the frame before (pop-in radii of hundreds of metres:
  harmless).
- Side effect, wanted: the chase camera sits at its rig's 9.00 m at every speed, not `9 + v · dt`.

### Other findings (not the reference case)

| What | Where | Effect | Package |
|---|---|---|---|
| Crafts are not interpolated: `drawn(_alpha)` ignores alpha | plane-core.ts:57, drone-core.ts:54, special-core.ts:61, boat-motion.ts:283 | a 1/60 s core on a 144 Hz display moves in 2 of 5 frames; the shell's camera reads the same state, so the world judders, not the craft | M3 (E13) |
| Crafts step on the frame's `dt`, not on the world tick | world-sim.ts:161, 401 | cannot be replayed from tick numbers (entities-and-modes.md section 4) | M3 (E13) |
| The mirror client interpolates heading, pitch, roll as Euler angles | snapshot.ts:185 | fine upright; wrong through a roll-over | M4 |
| The chase camera's yaw is the body's yaw, unfiltered | ride.ts:145-151 | a body's yaw wobble swings the whole view; taste, after M1 | – |

## 2. Principles from the research

Sources read on 2026-11-23. Three caveats: the Valve wiki was read from its archive copy; the Overwatch facts are from
a secondary summary of the talk; the Rocket League talk's content could not be read, it is cited as the reference to
watch, no fact below rests on it.

**P1. Fixed step, accumulator, clamp.** The sim advances in steps of one fixed dt; the frame's time is accumulated
and whole steps are taken from it; a long frame is clamped so the sim cannot spiral.
[Fiedler, Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/);
[Box2D](https://box2d.org/documentation/md_simulation.html) ("you should use a fixed time step", 30 Hz or smaller).
Rapier leaves the loop to the user ([integration parameters](https://rapier.rs/docs/user_guides/javascript/integration_parameters);
bevy_rapier's [`TimestepMode::Interpolated`](https://docs.rs/bevy_rapier3d/latest/bevy_rapier3d/plugin/configuration/enum.TimestepMode.html)
is the same pattern). Here: done (traffic.ts:210-211, `FixedStep`).

**P2. Draw between the last two steps.** `alpha = accumulator / dt` blends previous and current state (Fiedler, same
article). The price is a delay of up to one step ("we are effectively introducing a delay": 
[Godot, physics interpolation](https://docs.godotengine.org/en/stable/tutorials/physics/interpolation/physics_interpolation_introduction.html));
a higher tick rate shrinks it. Everything that moves must move in the tick, or the blend is wrong
([Godot, using it](https://docs.godotengine.org/en/stable/tutorials/physics/interpolation/using_physics_interpolation.html)).
A teleport resets previous = current, else one frame of streak (same page, `reset_physics_interpolation`).
Rotations: blend quaternions (nlerp or slerp, shortest arc), not Euler angles.

**P3. The camera reads the interpolated pose, in the frame, after the targets.** "Viewers are very sensitive to
camera movement"; move the camera every frame from the target's *interpolated* transform; following the tick's
transform makes it "jump about on each physics tick"
([Godot, advanced](https://docs.godotengine.org/en/stable/tutorials/physics/interpolation/advanced_physics_interpolation.html)).
Unity: interpolation is "particularly useful for … any other GameObject that the camera follows"
([Rigidbody.interpolation](https://docs.unity.com/en-us/engine/current/script-reference/unityengine/rigidbody/interpolation));
the camera updates after its targets were animated
([Cinemachine update method](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.0/api/Unity.Cinemachine.CinemachineBrain.UpdateMethod.html)).
A camera filter must be frame-rate independent, `1 − exp(−k · dt)`
([Godot, interpolation](https://docs.godotengine.org/en/stable/tutorials/math/interpolation.html)); a filter hides a
stepped target, it does not fix one, and it adds lag.

**P4. The browser's frame.** `requestAnimationFrame` fires at the display's rate (60, 75, 120, 144 Hz); its timestamp
is the same for every callback of a frame and is not `performance.now()`; it stops in background tabs
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)). So: one clock per frame (the
rAF timestamp), every time-dependent thing in the frame fed from it, nothing stepped "per frame".

**P5. The server is the authority; clients send inputs.**
[Gambetta I](https://www.gabrielgambetta.com/client-server-game-architecture.html);
[Valve, Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
([archive](https://web.archive.org/web/2025/https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)).

**P6. Predict the local player, reconcile by replay.** The client applies its own input at once; every input has a
sequence number; the server's state carries the last input it processed; the client sets that state and re-applies
the inputs after it ([Gambetta II](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html);
[Fiedler, Networked Physics 2004](https://gafferongames.com/post/networked_physics_2004/): a circular buffer of moves,
rewind and replay). Valve: prediction is "only possible for the local player and entities affected only by him".
For physics the client keeps its state per tick for at least one round trip and resimulates on a mismatch
([Unreal, Networked Physics](https://dev.epicgames.com/documentation/en-us/unreal-engine/networked-physics-overview):
the client runs half a round trip ahead; [Photon Fusion](https://doc.photonengine.com/fusion/current/concepts-and-patterns/networked-controller-code)).

**P7. Corrections are smoothed in the drawing, never in the state.** The state snaps to the truth; the drawn pose
keeps an error offset that decays ([Fiedler, State Synchronization](https://gafferongames.com/post/state_synchronization/):
factor 0.95 per 60 Hz frame for errors under 25 cm, 0.85 over 1 m, blended between; 2004 article: over 2 m snap).
Valve: `cl_smooth`, `cl_smoothtime`.

**P8. Remote entities are drawn in the past, from a buffer.** Interpolate between two received snapshots at
`now − delay` ([Gambetta III](https://www.gabrielgambetta.com/entity-interpolation.html)). Delay: Valve 100 ms at
20 snapshots/s, so one lost snapshot is survived;
[Fiedler, Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/): 3 × the send interval at
2–5 % loss (150 ms at 30/s, 85 ms at 60/s), Hermite instead of linear at low rates. The render time advances with
the frame's clock, not with the arrival of packets (a jitter buffer: Fiedler, State Synchronization, 4–5 frames at
60 Hz).

**P9. Extrapolate little.** Valve: at most 0.25 s (`cl_extrapolate_amount`), "prediction errors would become too big
after that". Fiedler: "extrapolation doesn't work very well for rigid bodies". Dead reckoning works where the motion
is constrained (here: traffic on its paths).

**P10. Inputs: stamped, buffered, redundant.** The client runs ahead so its input for tick T reaches the server
before T; the server buffers a little and tells a client to run faster or slower to keep the buffer just filled; a
missing input repeats the last; each packet repeats the inputs not yet acknowledged (Overwatch, GDC 2017,
[talk](https://www.youtube.com/watch?v=W3aieHjyNvw), facts via
[this summary](https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback);
[Fiedler, Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/): "redundantly include all
inputs in each UDP packet").

**P11. Lag compensation for hits.** The server keeps about 1 s of poses; a shot is evaluated against the world as
the shooter saw it: `command time = server time − latency − interpolation delay` (Valve, same page;
[Gambetta IV](https://www.gabrielgambetta.com/lag-compensation.html);
[Fusion](https://doc.photonengine.com/fusion/current/manual/lag-compensation): hitbox history, sub-tick).

**P12. Rapier and determinism.** The WASM build is "fully cross-platform deterministic" given the same initial
state, version and order of insertions ([determinism](https://rapier.rs/docs/user_guides/javascript/determinism));
`world.takeSnapshot()` / `restoreSnapshot` exist ([serialization](https://rapier.rs/docs/user_guides/javascript/serialization)).
A client that holds a different set of bodies and terrain chunks than the server is not in that case: design for
corrections (P6, P7), not for lockstep.

**P13. Predicting vehicles.** Three models. Full local physics of everything that can touch the car (the Rocket
League model: [GDC 2018 talk](https://www.youtube.com/watch?v=ueEmiDM94IE), to be watched before M7; few bodies,
one ball). A one-body world: the own car dynamic, everything else kinematic at its interpolated pose (Unreal's
"resimulation" for the pawn, "predictive interpolation" for the rest). No prediction: the own car from snapshots
(input lag = round trip + interpolation delay; Unreal: "higher latency and / or higher velocity will degrade the
quality"). With 1400 traffic cars and 10–50 players only the second scales.

## 3. The architecture

### Clocks

| Clock | Is | Advances by |
|---|---|---|
| frame time | the rAF timestamp; `dt` clamped (0.1 s) | the display |
| sim tick | `n`, at `n · STEP` (STEP = 1/30 s); the server's is the truth | whole ticks |
| render time, local sim | `(n − 1 + alpha) · STEP`, `alpha = acc / STEP`: between the last two ticks | `dt` |
| render time, remote | `estimated server time − interpolation delay`, in ticks with a fraction | `dt`, slewed ±2 % towards the estimate; never by a snapshot's arrival |
| predicted tick (own seat) | `server tick + round trip / 2 + input buffer` | `dt`, slewed by the server's hint |

A frame fixes these once (`FrameTime { dt, alpha, renderTick, predictedTick }`) and every reader gets the same
values. With the sim in the page's thread remote = local and the delay is 0; the code path is the same.

### The one loop

`WorldSim.update(dt)` owns the accumulator (E13): per tick the commands due, the crafts' steps (STEP worth on their
own `FixedStep`), the traffic's tick (the bodies in it), the events. `Traffic.acc` and the cores' clocks stop being
separate accumulators. A core with a finer step keeps `prev`/`cur` at world-tick boundaries.

The frame on the page, in this order:

1. Frame time from the rAF timestamp.
2. Input sampled → commands (`seq`, `tick`); the walk on foot (client-authored) moves here.
3. The sim advances: locally its ticks; behind a link the snapshots that arrived are put in the buffer, the own
   seat is reconciled and predicted up to the predicted tick.
4. `FrameTime` fixed.
5. Pose pass: every drawn thing sampled at its render time. Pure, no three.js.
6. Camera: reads poses of step 5 only; its filters (`1 − exp(−k dt)`) run here and only here.
7. What depends on the camera, the instance matrices, render.

### What every drawn thing provides

One contract: `sample(renderTick) → pose`, from `prev`/`cur` at tick boundaries (local) or from a history of
snapshots (remote). Samplers live in `sim/` (plain numbers; `core-deps.mjs` holds); `view/` and `nav/` only turn
poses into matrices and cameras.

| Thing | Local state | Has it today | Over a link |
|---|---|---|---|
| Traffic car on its path | `s`, `ds`, `off`, `dOff` | yes (life.ts:155) | `(edge, lane, s, v)` per snapshot; between and beyond them along the path (P9: safe to extrapolate, it is on rails) |
| Rapier body (traffic near edits, wrecks, parked, other players' cars) | `prev`, `cur`: position, quaternion, ride | yes (life-phys.ts:367, 407, 682) | pose history; quaternion nlerp; a `teleport` count so a reset is not interpolated across |
| Own car | the same | yes | predicted (below) |
| Craft | `prev`, `cur` of its drawn state | **no**: `drawn(alpha)` ignores alpha | as a body; the own one predicted |
| Walker (own) | client-authored, per frame | yes (drawn at frame time) | the same until the walk is a core (entities-and-modes.md decision 2), then as a craft |
| Walker (other players) | – | – | pose history |
| People, riders | `s`, `v` on their path | yes, extrapolated `v · lead` (life.ts:186) | as traffic cars |
| Trains | `coaches(back)` | yes | schedule-driven: from the world clock |
| Boats | `previous`, `poses`, `elapsed` | yes | the same fields at their own cadence |

A thing put somewhere at once (recover, claim, spawn, `placeCraft`) sets `prev = cur` (P2) and bumps `teleport`.

### The camera

Step 6. It takes the followed entity's sampled pose of this frame and the frame's `dt`, nothing from the sim's
objects directly, never a drawn field of the frame before. Chase rig, height lag, clearance (`clearOf`) and shake are
presentation and stay in `nav/`. A craft's shell camera obeys the same rule (it reads `drawn(alpha)` of step 5).

### The local player: prediction and reconciliation

Only where the sim is behind a link (worker, server). In the page's thread there is nothing to predict.

- **Input command**: `{ seq, tick, input }`: `seq` increasing per player, `tick` the world tick it is meant for (the
  predicted tick). Each message carries the last K unacknowledged commands (K = 8 at 30 Hz: 250 ms of loss covered).
- **Server**: a buffer per player of commands by tick (target depth 2 ticks). At tick T it applies the command for T;
  none there: the last one repeated (and counted). Each snapshot tells the client `ack { seq, tick }` and how full
  its buffer is; the client slews its predicted clock by up to ±5 % to hold the target (P10).
- **Client**: a ring of 1 s: per predicted tick the input used and the own entity's state after it. On a snapshot:
  compare the server's state at `ack.tick` with the ring's. Within tolerance (position 5 cm, yaw 1°, speed 0.2 m/s):
  nothing. Else: set the state, re-step the inputs after `ack.seq` up to the predicted tick, and add
  `drawn pose before − drawn pose after` to the error offset.
- **Error offset** (position and quaternion; presentation only, P7): decays with a time constant of 0.1 s for
  offsets over 1 m and 0.33 s under 25 cm, blended between (Fiedler's 0.85 and 0.95 per 60 Hz frame as rates); over
  3 m or a `teleport`: zeroed, the pose snaps. The camera follows the pose with the offset, so a correction never
  moves the car on screen against the camera.
- **Craft** (E17): the client steps a core of the same class through its own collision; the state is the core's
  (`saveState`/`loadState`). Deterministic apart from collision differences.
- **Car** (E18): a one-body Rapier world on the page (P13): the own chassis and its wheels dynamic, terrain from the
  page's tiles, every other body a kinematic proxy at its interpolated pose. State per tick: chassis position,
  quaternion, linear and angular velocity, steering, the eased ride height; the wheel controller's inner state is
  rebuilt by the first replayed step. A replay is `(round trip + buffer) / STEP × SUB` one-body steps: 8–12 at
  100 ms; only on a mismatch. Contacts with other cars are the server's: the client mispredicts them and is
  corrected (P6: only what the player alone affects is predictable). Not lockstep (P12).

### Remote entities: the interpolation buffer

- The client keeps 1 s of snapshots by tick (32 at 30/s). Render time as in the table of clocks.
- Send rate: every tick (30/s) for the entities near a player, bodies and players first; path traffic farther out
  every 3rd tick (it extrapolates along its path).
- Interpolation delay: `max(2 send intervals, 1 interval + p95 of the arrival jitter)`, clamped to 66–250 ms, start
  value 100 ms; changed only by slewing the render clock. To a worker: 1 interval (33 ms), no jitter to speak of.
- Between two snapshots: linear position, quaternion nlerp. Hermite (with velocities) only if a class is sent under
  10/s.
- Buffer empty (render time past the newest snapshot): bodies and players extrapolate at their last velocity for at
  most 250 ms, then hold (P9); path traffic keeps going along its path for up to 1 s. When snapshots return, the
  render clock slews back; the pose difference goes through the same error offset as a correction.
- Own car in the present, others 100 ms + half a round trip in the past: accepted (P6); it is what makes car-to-car
  contacts between players look late by that much.

### Lag compensation for hits (later)

When the first weapon exists (after E15). The server keeps the last 1 s of every hittable entity's pose per tick
(the ring the snapshots are made from). A fire command carries its `tick` and the `renderTick` the shooter saw the
others at; the server evaluates the ray against the others' poses at that render tick (interpolated between two
ticks), capped at 300 ms back, the shooter at its own tick; then the result is an event like any other (P11).
Projectiles that fly are simulated forward, not rewound. Ramming is physics on the server, never compensated.

### Mapped to the existing plan

| Package | Change |
|---|---|
| E13 (one tick loop) | Unchanged in aim; add: `FrameTime` and the frame order above; `prev`/`cur` in every core and `drawn(alpha)` that uses it; `prev = cur` and `teleport` on placement; commands carry `tick` besides `seq`; the snapshot `ack { seq, tick }`. Becomes M3. |
| E17 (craft prediction) | Add: the state ring, the tolerance, the error offset as specified here, the predicted clock and the server's buffer hint (M5). "Decays over ~100 ms" becomes the two-rate rule. Becomes M6. |
| E18 (car prediction) | As planned (one-body world, kinematic proxies, no `takeSnapshot`); add: the state list, proxies at their interpolated pose, P12's caveat, the judder gate with injected lag. Becomes M7. |
| E19 (worker by default) | Waits for M4 too (not only E17); gate adds the judder tool with `?worker=1`. Becomes M8. |

Order: M1 now, independent of everything. M2 with it. M3 where E13 stands (after E7). M4 after M3. M5–M8 where
E17–E19 stand (owner's decision 3: no hurry). M9, M10 with the server and the first weapon.

## 4. Packages

### M1. The camera after the poses (S)

- **Do:** first the tool, red: `web/tools/judder.mjs` (playwright; prototype: the run of section 1). It wraps rAF
  with synthetic timestamps, takes the wheel, and per frame records the drawn pose of the followed entity, the
  camera's pose, `dt`, tick, alpha. Patterns: 60, 120, 144 Hz even; every 6th frame doubled; 20 % doubled at random;
  ±2 ms. Two numbers at ≥ 60 km/h: **J** = max per-frame change of the entity's position in the camera's frame (cm,
  and px at 1080); **E** = max |drawn step − v · dt| (cm). Then the fix of section 1: the frame order, `Nav.update`
  split, `StreetLife.pose` = this frame's.
- **Gates:** judder: J ≤ 0.5 cm and E ≤ 0.5 cm in every pattern (today J = 36.9 cm, E = 0.05 cm; the control
  reached J = 0.0); camera 9.00 m behind at 80 km/h; the fast gates; the owner drives once at speed.

### M2. The real frame, shown (S)

- **Do:** `?pace=1`: a small readout fed by the frame loop: the last 300 `dt` as a histogram (how many frames took
  1, 2, 3+ refresh intervals), the sim's ms per frame with and without a tick, J and E live for what is followed.
  The numbers of the owner's machine, which the headless run cannot give.
- **Gates:** none new; the owner reads it while driving. If frames with a tick are the long ones: the case for M8.

### M3. One tick loop, crafts interpolated (M, not neutral) = E13

- **Landed** (what: [entities-and-modes.md](entities-and-modes.md) E13): the frame is input (car, Nav's controls,
  own-camera crafts' `update`: input, events, panel) → `sim.update` (whole ticks; `FrameTime` from `sim.time`) →
  `life.update` → `CraftsView` (crafts not flown here, at the frame's alpha) → `Nav.place` → the own-camera crafts'
  `place` (model and camera on `drawn(alpha)` of this frame). Cores keep the tick's start (`keep()`) and blend to now;
  no samplers moved (the cores' `drawn` is the sampler); no `teleport` count yet (placement and the plane's respawn
  are not blended: enough locally, M4 needs the count). `tools/judder.mjs --what car,plane,boat,drone` (crafts:
  sampled just before the render, E's speed from the drawn path over ±0.1 s; the boat's bobbing left out). Measured
  (headless, synthetic rAF), max J / E in cm over the 7 patterns: before, plane 0.00 / 88.7 (38.2 at 120 Hz steady:
  a 1/60 s core moving in every other frame), boat 0.7 / 31.0, drone 0.00 / 59.5 (the shells drew the state before
  the sim's update, a frame late, and between no steps); after, plane 0.00 / 0.01, boat 0.00 / 0.10, drone 0.00 /
  0.09, car unchanged 0.0 / 0.04 (7/7 each, 28/28). J of the plane and the drone is 0 by construction in these runs
  (straight flight; the drone's camera is the drone).
- **Do:** E13 as amended in section 3: `WorldSim` owns the accumulator; cores keep `prev`/`cur`, `drawn(alpha)`
  blends (quaternion nlerp for attitude); `FrameTime`; samplers in `sim/`; `teleport`; commands with `seq` and
  `tick`, snapshot `ack`.
- **Gates:** E13's; judder with a craft followed (plane, boat, drone): J and E ≤ 0.5 cm at 60/120/144 Hz and the
  uneven patterns; determinism at two rendering rates, crafts included.

### M5. Input commands: tick, ack, buffer (S–M)

- **Do:** the command window (last K unacked), the server's per-player buffer by tick, repeat-last on a gap, the
  buffer hint in the snapshot, the client's predicted clock and its slew. No prediction yet: the own entity still
  from snapshots.
- **Gates:** a headless check over `LagLink`: with 2 % loss and ±20 ms no tick without the player's input after
  warm-up, buffer depth within 1–3 ticks; command order and determinism gates unchanged.

### M6. Craft prediction (M, not neutral) = E17

- **Do:** E17 with the state ring, tolerance and error offset of section 3.
- **Gates:** E17's (`mirror-check --predict`); judder over `LagLink` at 100 ms: J ≤ 0.5 cm without collisions; a
  forced misprediction of 1 m is gone in under 0.5 s with no frame-to-frame jump over 5 cm; input latency back to the
  in-page one.

### M7. Car prediction (L, not neutral) = E18

- **Do:** E18 as amended in section 3. Before it: watch the Rocket League talk (P13) and note what differs.
- **Gates:** E18's; judder as M6 with the car at 80 km/h; a scripted contact with a traffic body: the correction's
  size and decay measured, no snap under 3 m.

### M8. Worker by default (S) = E19

- **Waits for:** M4, M6 (and M7, or the owner accepts the car unpredicted for one frame meanwhile).
- **Gates:** E19's; judder in the default mode; `?pace=1`: no long frames from ticks.

### M9. The wire (M–L, with the server)

- **Do:** the snapshot quantised and per client (interest by distance, the send rates of section 3), the transport
  (question 3), the clock estimate (round trip from `ack`), the adaptive delay.
- **Gates:** `LagLink` profiles as recorded from the real transport; bandwidth per client measured at 50 players.

### M10. Lag compensation for hits (M, with the first weapon; after E15)

- **Do:** the pose ring on the server, `fire { tick, renderTick, ray }`, the capped rewind.
- **Gates:** a headless check: a target crossing at 10 m/s, shooter at 100 ms: hit where the shooter saw it, miss
  where it is now; the cap holds.

## 5. Questions for the owner

1. **The world tick stays at 30 Hz?** Interpolation shows the world up to 33 ms late and input waits for the next
   tick: on average 17 ms to the tick and up to 33 ms more until its result is fully shown, half of both at 60 Hz
   (P2). 60 Hz doubles the traffic's and the
   server's CPU and the snapshots. *Recommendation: keep 30 Hz. Judge the feel after M1; if driving feels late, tick
   only the player-controlled bodies and crafts at 60 Hz inside the 30 Hz world tick (the bodies already take two
   physics steps per tick), not the whole world.*
2. **The car over a link: predicted in a one-body world (E18), with contacts between players resolved by the server
   and shown as smoothed corrections?** The alternative without prediction is simpler and never mispredicts, but the
   wheel answers one round trip plus the interpolation delay late (150 ms and up over the internet); predicting
   every car near the player is the third, and does not scale to the traffic. *Recommendation: the one-body world,
   as planned.*
3. **Transport for the first server: WebSocket?** One lost packet stalls everything behind it (TCP), which the
   interpolation delay must cover (start 100 ms; it grows on bad links). WebTransport datagrams avoid that but are
   not in every browser and need more server work. *Recommendation: WebSocket first; snapshots self-contained and
   inputs redundant from the start (M5, M9), so datagrams are a transport swap later, not a redesign.*
