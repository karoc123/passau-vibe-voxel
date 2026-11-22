# Plan: a small sports plane

A new way to move: a small propeller plane, somewhat faster than the FPV drone, flown with four keys or one thumb.
An arcade model, not a simulator: it always flies forward, banks to turn, levels itself when the controls are let go,
and keeps itself off the ground unless the player pushes it down on purpose.

Status: built (phases 0–3 and the water landing; phase 4's streaming measurement not done). Written against `main` at `31d7b594`.

## Revision (after review, overrides the plan below where they differ)

The first draft was found too easy. Changed, in priority over everything below:

1. **Less automation.** No ground guard (no automatic pull-up), no automatic turn back at the map edge, no three
   fixed speeds. The map edge is a plain wall: the plane's position is clamped inside the box (outward movement
   dropped), the HUD says "Map edge". What stays: bank (and, weakly, the flight path) level themselves when the stick
   is let go. Nothing else steers for the player.
2. **Stepless throttle**, 0–100 %, a state the player sets: keyboard Shift / R up, Space / F down (held, gradual; not
   Ctrl: Ctrl+W closes the tab); touch: a vertical slider on the right that stays where it is left, the left stick
   stays turn and pitch; gamepad: RT / LT (or the right stick's Y) move it.
3. **Energy, semi-realistic.** Speed comes from thrust (throttle), drag (parasitic + induced) and the path's slope
   (climbing costs speed, diving gains it). Lift is limited by speed (load factor at most `(v / V_STALL)^2`, faded to
   nothing over the last 30 % below the stall speed): too slow, the plane sinks and its nose drops; diving or throttle
   recovers. No spin, no wind. Level top speed at full throttle ~245 km/h (drone: 158 / 197), stall ~86 km/h. All
   numbers in one `PLANE` object.
4. **Floatplane: water landing and takeoff are in scope** (was phase 5). Touching water (Danube, Inn, Ilz: the voxels'
   water runs, as `physics/rapier/terrain.ts` reads them, plus the river level slider when raised) slowly, shallowly
   and nearly wings-level floats the plane; it taxis on the water (stick turns, throttle moves) and takes off past
   the takeoff speed with the stick pulled. Too fast or too steep onto water is a crash ("Splash"). Land and roofs:
   a crash, except a shallow skim (a bounce, as below). Crash: tint and shake, then back at a safe pose ~3 s old.
5. Pitch: flight convention with an "Invert pitch" toggle (question 2 A, unchanged).
   **Inertia (feedback after phase 2: W/S snapped the drawn nose):** the stick no longer sets the load factor in one
   step. It asks a path pitch rate that the elevator state `pitchRate` follows (`PITCH_FOLLOW` 5 /s, at most
   `PITCH_ACCEL` 60 °/s²); the load factor, the drawn angle of attack and then the path build up over ~0.5 s, the
   path visibly trailing the nose. Hands-off levelling asks at most `PITCH_LEVEL_RATE` 10 °/s (no pushover into
   negative g after a steep climb). The roll rate eases in and out (`ROLL_ACCEL` 300 °/s²); the drawn angle of attack
   follows the lift's (`ALPHA_FOLLOW` 10 /s, at most `ALPHA_RATE` 40 °/s, so takeoff and touchdown do not snap
   either). Check `pitch_smooth`: nose at most 1°/step, its per-step change changing at most 0.1°, the nose 2°+ ahead
   of the path 0.4 s into a pull.
6. Start: in the air from orbit (unchanged), and a second button to start floating on the Danube.

Consequently the checks `speeds`, `guard_*`, `edge` turn-back and `danube` turned back at the east edge are replaced
by `throttle`, `stall`, `climb_costs`, `boundary`, `water_*`, `crash_*` (web/tools/plane.mjs).

## Offene Fragen

Der Plan funktioniert mit den Empfehlungen; bis zu einer Antwort wird jeweils die Empfehlung umgesetzt.

1. **Start und Landung.** Passau hat auf der Karte keinen Flugplatz (Vilshofen liegt ~20 km westlich, außerhalb).
   - **A (Empfehlung):** Start in der Luft wie die Drohne, keine Landung. Flug beenden mit Esc / „Exit plane“.
   - B: zusätzlich Wasserlandung auf Donau und Inn (Schwimmerflugzeug). Flach, hindernisarm, passt zur
     Dreiflüssestadt. Als spätere Phase 5 vorgesehen (~2 Tage), ändert an Phase 1–4 nichts.
   - C: ein erfundener Grasplatz in den Daten. Braucht die Datenpipeline und einen Neubau der Karte: jetzt nicht.
   - D: überall landen (Straßen, Wiesen). Braucht Fahrwerksphysik am Boden und scheitert an 9 m Spannweite in
     10 m breiten Straßen: nicht empfohlen.
2. **Richtung der Höhensteuerung.** Was ist die Voreinstellung?
   - **A (Empfehlung):** Fliegerkonvention: S / ↓ / Stick nach unten ziehen = Nase hoch. So ist es schon bei der
     Drohne (W = Nase runter) und am Gamepad. Dazu ein Schalter „Invert pitch“ im Panel (wird gemerkt).
   - B: „hoch ist hoch“ als Voreinstellung (W / ↑ / Stick nach oben = steigen), Schalter für die andere Richtung.
3. **Was passiert bei einem Aufprall?**
   - **A (Empfehlung):** Flache Berührung von oben (Dach, Wiese, Wasser gestreift) prallt ab und kostet Tempo. Ein
     echter Aufprall ist ein Absturz: 1,2 s rotes Bild und Wackeln, dann zurück in die Luft an die Stelle von vor
     ~3 s, gerade ausgerichtet. Kein Schaden, kein Zähler.
   - B: immer abprallen wie die Drohne (kein Absturz). Einfacher, fühlt sich aber bei 180 km/h falsch an.
   - C: unzerstörbar mit hartem Bodenschutz (man kann gar nicht in etwas hineinfliegen, auch nicht unter Brücken).
4. **Geschwindigkeit.** Die Drohne schafft waagrecht 158 km/h (Tastatur) bzw. 197 km/h (Vollgas, Touch/Controller).
   - **A (Empfehlung):** langsam 108, Reise 180, schnell 252 km/h. Die Karte ist 9,3 × 3,5 km: bei 252 km/h
     in 50 s von Nord nach Süd, in gut 2 min von West nach Ost.
   - B: gemächlicher: 90 / 150 / 210 km/h (mehr Zeit über der Altstadt, aber kaum schneller als die Drohne).
5. **Touch-Bedienung.**
   - **A (Empfehlung):** ein Stick links (seitlich = Kurve, hoch/runter = Nase), rechts zwei Halteknöpfe „Fast“ und
     „Slow“, Zwei-Finger-Pinch rechts zoomt die Kamera. Loslassen = geradeaus und waagrecht. Wie beim Auto.
   - B: Neigen des Handys (Lagesensor). Braucht auf iOS eine Berechtigungsabfrage und eine Kalibrierung, ist im
     Liegen oder im Bus unbrauchbar: nicht empfohlen, höchstens später als Zusatz.

## What is there today (read before building)

- **Modes** (`web/src/nav/nav.ts`): `Mode = 'orbit' | 'walk' | 'ride' | 'fpv' | 'pedestrian'`. The drone and the car
  are not inside `Nav`: each is its own class with its own panel in the bar's `.mode-tools`, loaded lazily at the end
  of `main.ts` `start()` (`FpvMode` in `nav/fpv.ts`, `DriveMode` in `nav/drive.ts`), updated every frame from the
  animation loop (`drive?.update(dt); nav.update(dt); fpv?.update(dt)`).
- **Drone** (`nav/fpv.ts`, `nav/fpv-flight.ts`): entered only from orbit (`nav.startFpv()`), first person (the camera
  *is* the drone), physics at a fixed 1/120 s step in `FpvFlight.step(input, dt, move)` with a `move` callback that
  does the collision. `FpvFlight` has no DOM and no scene: the model to copy. Arming step, controller calibration UI
  (`fpv-input.ts`), keyboard W/S pitch, A/D yaw, Q/E roll, R/F throttle, T reset, Esc exit. Leaves by `nav.flyUp()`.
- **Drone speed, from the code** (`thrust = g (throttle / 0.39)^1.35`, `drag = 0.12 + 0.009 v`): level top speed
  43.8 m/s = **158 km/h** on the keyboard (throttle 0.77), 54.8 m/s = **197 km/h** at full throttle (touch,
  controller); more in a dive.
- **Collision** (`nav/voxel-collision.ts`): `VoxelCollision` keeps the 1 m node files of the 3 × 3 nodes round the
  craft and round the point 2.2 s ahead, through the viewer's shared `TileCache`, independent of what is drawn.
  `sweep(p, d)` moves a 0.7 m cube (`RADIUS = 0.35`, a module constant) and returns the fraction, what it hit
  (`terrain | structure | foliage | city edge | ceiling`) and the normal's axis, or `'loading'` (the drone then
  waits). Above `meta.H` (173 m, the map's top) it returns before looking at any tile. `surface(x, z)` gives the
  ground and the highest solid top of a column (trees included). The map's edges and a ceiling at `meta.H + 600`
  are walls. Headless gate: `web/tools/collision.mjs` (`nav/collision-checks.ts`).
- **Car** (`nav/drive.ts`, `nav/drive-session.ts`, `physics/rapier/*`): a traffic car taken over, Rapier body,
  session without DOM, chase camera through `nav.ride` and `ride.ts`, crash shake (`nav.rideShake`), river: splash,
  then back on the road (a ring of "safe" poses). Touch: `TouchSticks(canvas, { onPinch, camera: 'right' })`, one
  left stick, `#handbrake-button` under the right thumb, pinch on the right zooms. Gamepad: standard mapping only,
  axis 0 and the triggers, no setup UI.
- **Streaming and levels** (`city.ts`, `stream.ts`): every 100 ms the tiles in range of the camera are picked as a
  quadtree of 1/2/4/8 m nodes by projected cell size (1 m where a cell is over ~1.2–1.5 px), within the triangle
  budget, never coarser than 2 m within 100 m of the camera. A coarse node only goes once everything finer under it
  is ready, so nothing is ever missing; beyond the view distance (600 m–5 km, widened with height) the far ground
  stands. Requests are ordered: in view first, then nearest to `focus()` (the camera, outside orbit). Workers:
  cores − 2, at least 2. Meshing an Altstadt node with foliage: ~75 ms (ADR 0003).
- **Street life** (`sim/life.ts`): simulated in a 900 m circle round `focus()`, re-centred every 120 m. Agents come
  and go only ≥ 300 m (cars) / 150 m (people) from the viewer, measured in 3D from the camera.
- **No audio** anywhere in the project. No mode in the URL (`?view= ?cam= ?focus= ?crop= ?dig= ?ui=` only).
- **Map**: 9344 × 3456 m, `meta.H` 173 m. The Altstadt (x ≈ 8000) lies 1.3 km from the east edge, the
  Dreiflüsseeck 350 m from it: the edge handling must not need a wide margin.

## Decisions

1. **Kinematic arcade model, no Rapier.** The plane is a point with heading, pitch, bank and speed, advanced at a
   fixed step; nothing is integrated from forces. Rapier (1.7 MB, loaded for the car) is not needed.
2. **`PlaneFlight` is pure** (`nav/plane-flight.ts`): no DOM, no three scene, input in, pose out, the world reached
   through two callbacks (`sweep`, `surface`). It runs in node as `FpvFlight` and `DriveSession` do, so it is
   testable headless now and can run on a server later unchanged. `PlaneMode` (`nav/plane.ts`) is the glue:
   panel, input, camera, model.
3. **A new mode `'plane'`**, not a flag on `'fpv'`. A helper `flying(mode)` (`'fpv' | 'plane'`) replaces the twelve
   `=== 'fpv'` checks outside `fpv.ts` that mean "a craft owns the camera and the input"; `nav.startFpv()` becomes
   `nav.startCraft(mode)`.
4. **Reuse `VoxelCollision`**, with two options instead of constants: `radius` (drone 0.35, plane 1.5 m: the
   fuselage; the wings do not collide) and the prefetch `horizon` (drone 2.2 s, plane 3.5 s).
5. **Third person only.** The drone already is the first-person craft. The plane is drawn and followed by a chase
   camera.
6. **Air start, no arming step.** One click on "Plane" and it flies; the touch stick is live at once.
7. **Three speeds instead of a throttle lever**: cruise by itself, hold for fast, hold for slow. No throttle state
   to manage, and the touch layout needs two buttons instead of a slider.

## Flight model

State: position `p`, heading `ψ`, flight-path pitch `θ`, bank `φ`, speed `v`. Input: `turn` −1..1, `pitch` −1..1
(+1 = nose up), `speed` −1 | 0 | +1. Fixed step 1/60 s, at most 6 steps a frame.

| | value | note |
|---|---|---|
| slow / cruise / fast | 30 / 50 / 70 m/s (108 / 180 / 252 km/h) | drone: 158 keyboard, 197 full |
| speed response | towards the target at 0.7 /s | ~1.5 s to settle |
| pitch couples to speed | −10 m/s at full climb, +12 m/s at full dive | limits 28..82 m/s, never slower |
| bank | target `turn × 55°`, approached at 4 /s | ~0.4 s to roll in |
| turn rate | `30°/s × sin φ / sin 55° × sqrt(50 / v)` | radius 44 m slow, 95 m cruise, 160 m fast |
| climb / dive angle | +22° / −30°, approached at 2.5 /s | 19 m/s up, 25 m/s down at cruise |
| ceiling | climb angle fades to 0 over the last 80 m below `meta.H + 450` | ~600 m over the rivers |

`p += v (sin ψ cos θ, sin θ, cos ψ cos θ) dt`, moved through `sweep`.

No stall, no trim, no rudder, no wind, no fuel. "Feels like a plane" comes from four things: it never stops, it
banks before it turns, it loses speed uphill and gains it downhill, and it turns tighter when slow.

### Assists

- **Auto-level.** With `turn` and `pitch` at 0 the targets are bank 0 and pitch 0: the plane flies straight and holds
  its height. Letting go is always safe.
- **Ground guard.** Every step, the path of the next 3.5 s is sampled every 10 m (along the current turn's arc;
  8–25 calls of `surface()`), and where the plane would pass less than 12 m over a column's top the pitch target is
  raised to clear it, up to +45° (steeper than the manual climb). At cruise that sees 175 m ahead and clears any rise
  on the map (173 m). Columns not loaded are skipped. Its weight is `1 − (nose-down input)`: holding the nose fully
  down switches it off, so low passes, flying under a bridge and crashing stay possible, but only on purpose. The
  panel says "Pull up" while it acts.
- **Map edge.** Within `v / turn rate + 60 m` of an edge (104 / 155 / 220 m) and heading outwards, a turn towards
  the inside is commanded, the nearer side first, full at half the margin; it overrides the player's turn where
  stronger. The collision's edge wall stays as the backstop and is slid along, never a crash.

### Collisions

The fuselage's 3 m cube is swept. By what it meets:

- `city edge`, `ceiling`: slide.
- A top face (`axis = +y`) met at less than 8 m/s along the normal (a roof, a meadow, the river skimmed): a bounce.
  Vertical speed +3 m/s, pitch at least +8°, speed × 0.85, note "Careful!".
- Anything else: a crash. The plane is hidden, the camera stays and shakes, the drone's red tint
  (`.fpv-impact-tint`) for 1.2 s, the input ignored, note "Crash! Back in the air…". Then back at the newest "safe"
  pose at least 3 s old (recorded every 0.5 s while ≥ 30 m over the column's top, 10 s kept), at least 60 m over the
  top there, level, at cruise. With none, the start pose. T does the same by hand.
- Cars, people, trains, boats: not met at all (see Interaction).
- `'loading'`: the step is not taken (as the drone: "Waiting for the next collision tile…"). With the 3.5 s horizon
  and 19 KB node files this should not show; phase 4 measures it.

Water is ground in `VoxelCollision` (the river's top voxel is the ground's), so in v1 a river is a surface like any
other. Telling it apart is phase 5.

### Start, end

- Entered from orbit only, as the drone (the button is disabled elsewhere). The plane starts at the camera's place
  (clamped 250 m inside the map), heading where the camera looks, at `clamp(camera height, top + 60, top + 300)`
  over the highest column of the 3 × 3 there, level, at cruise. The camera glides to the chase position in 0.6 s.
- Esc or "Exit plane": `nav.flyUp()`, the plane is removed. Search and place links leave it as they leave the drone
  (`goPlace`).
- Window blur, hidden tab: the flight pauses (no steps), resumes on return.

## Controls

**Keyboard** (arrows as WASD, as everywhere in the viewer):

| key | does | same as |
|---|---|---|
| A / D | turn (banks by itself) | car steer, drone yaw, orbit turn |
| W / S | nose down / nose up (question 2; "Invert pitch" swaps) | drone pitch |
| Shift (held) | fast | "Shift faster" in orbit and on foot |
| Space (held) | slow | the car's handbrake key |
| T | back to the last safe point | drone reset |
| Esc | exit | all modes |

Keys are digital; the model's roll rate, elevator (`pitchRate`) and drawn angle of attack do the smoothing. Wheel: camera distance.

**Touch**: `TouchSticks(canvas, { onPinch, camera: 'right' })` exactly as the drive mode. Left stick: sideways turn
(`|x|^1.5`, gentle near the middle), up/down pitch. Thumb off: level flight. Right: two hold buttons `Fast` above
`Slow` where the handbrake sits (72 px, same style and safe-area rules), and a pinch zooms the chase camera. No tilt
control (question 5).

**Gamepad**: as the car, standard mapping only and no setup UI: left stick turn and pitch (dead zone 0.12), RT fast,
LT slow. The drone's RC-radio calibration (`fpv-input.ts`) is not used.

## Camera and HUD

- **Chase camera**: 14 m behind and 4 m above the plane, along a heading and pitch that follow the plane's with a
  lag (4 /s and 3 /s), so a turn shows the plane a little from the side; world up, rolled by a quarter of the bank;
  looking at a point 30 m ahead of the plane. Distance × 0.6..2.2 by wheel and pinch (as `zoomRide`).
- **Clear of buildings**: `collision.sweep(plane, cameraOffset)`; where it hits, the camera comes in to the hit less
  0.5 m (the collision tiles round the plane are in anyway; no dependency on what is drawn).
- **Field of view** by speed, smoothed: 58° slow, 62° cruise, 72° fast. Near plane unchanged (0.5 m).
- `controls.target` 150 m ahead of the plane (the shadow fit and the fog read it; the drone uses 180 m). Tilt-shift
  off as for the drone. Place labels stay on (useful from the air), unlike the drone.
- **Panel** in `.mode-tools`, as the drone's and the car's: button "Plane" / "Exit plane"; a telemetry line
  `180 km/h · 140 m AGL` (tabular figures; over the ground under the plane, from `surface().ground`); a status line
  for the notes ("Pull up", "Map edge", "Careful!", "Crash! Back in the air…", "Waiting for the next collision
  tile…"); a help line in a keys and a touch variant chosen by `@media (pointer: coarse)` as `drive.css` does; the
  "Invert pitch" checkbox (`localStorage`, key `plane-invert-v1`). `body.plane-flying` hides `#hud` and the other
  modes' panels.

## Model

Drawn in code from boxes, as the cars (`sim/meshes.ts` `box()`, `mergeGeometries`) and the walker
(`nav/pedestrian.ts`): no asset files, no new dependency. A low-wing two-seater, 7 m long, 9 m span, ~16 boxes
merged into one geometry with vertex colours (white, a blue stripe, dark canopy glass): fuselage in three tapering
boxes, cowling, canopy, wing with a slight dihedral in two halves, tailplane, fin, three wheels on legs.
`MeshStandardMaterial`, casts a shadow (`daylight.casters` gets `|| nav.mode === 'plane'`).

- **Propeller**: its own mesh, two blades and a spinner, turning about the nose at 20–45 rad/s by speed, plus a
  faint disc (opacity 0.15) so it reads as spinning at any frame rate.
- **Lights**: red (left tip), green (right tip), white (tail) as small `MeshBasicMaterial` boxes brightened with
  `daylight.night` as the cars' lamps are (the bloom picks them up); a white strobe on the fin, 80 ms every second;
  a landing light at the nose at night. No real light source (the ground's lamp light is baked into the fields).
- The mesh rolls by the full bank and pitches with the flight path. Three draw calls. Added to `nav.actors`.

## Streaming and levels

At the plane's speed nothing breaks by construction: a coarse node is shown until the finer ones are ready, and the
far ground stands beyond the view distance. What can lag is detail. The numbers at 120 m over the ground, 62° field
of view, 1080 px high: 1 m nodes are wanted out to ~600 m, so at 60 m/s about 3 new 1 m nodes a second enter the
view, each with its foliage tile. Two workers at ~75 ms a node mesh ~26 a second. A node entering at 600 m is
reached in 10 s. On a phone the 2 M triangle ceiling decides the level, not the speed. The drone already flies at
44–55 m/s on the same path with no special handling.

Changes:

- **None required** in `stream.ts` or `city.ts`.
- **One optional line**, only if phase 4's measurement asks for it: in `'plane'`, `focus()` in `main.ts` returns
  the point 2 s ahead of the plane instead of the camera, so that among the tiles in view those ahead are asked for
  first (and the street life's circle sits a little ahead).
- `VoxelCollision`'s horizon 3.5 s for the plane (decision 4): up to 18 nodes of collision columns held, ~70 KB of
  offsets each on top of the shared cache.

## Interaction with the rest

- **Street life**: untouched. Its viewer is the camera with its height, so the pop-in rule holds from the air. The
  circle re-centres every 120 m, every 2 s at cruise (the drone does the same). Risk: streets ahead fill from the
  circle's edge and may look thin from a fast plane; phase 4 measures it with `popin-check.mjs` at plane speed. If
  thin, the lookahead `focus()` above helps first; `life.ts` itself is not to be changed for the plane.
- **Traffic, people, trains, boats**: no collisions with the plane. It flies through them (at 12 m and more over
  the roofs it never meets them unless forced down).
- **Car**: `DriveMode.activate()` refuses in `flying(mode)` and hides its panel, as today for the drone. Entering
  the plane from a drive parks the car first (`drive.park()`, as the Walk button does).
- **Drone**: mutually exclusive through the mode; `FpvMode` keeps testing `=== 'fpv'`.
- **Digging** (`?dig=1`): craters reach the plane's collision through `liveEdits`, as the drone's.
- **Audio**: none exists; an engine sound would be the project's first audio and wants its own small foundation
  (unlock on a gesture, a mute setting). Left out.

## Steps

Each phase ends with `pnpm check` (tsc) and its gates green. No new dependency in any phase. Tools serve on their
own port, never 5173.

### Phase 0: make room (0.5 day)

- `nav.ts`: `Mode` gets `'plane'`; `export const flying = (m: Mode) => m === 'fpv' || m === 'plane'`;
  `startFpv()` → `startCraft(mode)`. The checks in `nav.ts` (6), `main.ts` (3: `goPlace`, the Walk button, the
  tilt-shift), `drive.ts` (2), `hud.ts` (1) use `flying()`. `body.fpv` stays the drone's.
- `voxel-collision.ts`: `constructor(meta, cache?, { radius = 0.35, horizon = 2.2 } = {})`.
- Gates: `node tools/collision.mjs` passes unchanged (same numbers); `node tools/core-deps.mjs`; the drone and the
  car smoke-tested by hand (enter, fly/drive, Esc).

### Phase 1: the flight, headless (1.5 days)

- `nav/plane-flight.ts`: `PlaneFlight` (`reset(pose)`, `step(input, dt, world)`, `pose`, `events`), the three
  assists, bounce / crash / respawn with the safe-pose ring. All numbers in one exported `PLANE` object (as the
  car's `RIDE`), so a tool can change them (`--set`).
- `nav/plane-checks.ts` + `web/tools/plane.mjs` (the pattern of `collision-checks.ts` / `collision.mjs`), on a
  synthetic world:
  - `level`: 20 s hands off: height within ±0.5 m, heading within 0.1°.
  - `speeds`: slow / cruise / fast settle at 30 / 50 / 70 m/s ±1; never under 28.
  - `turn`: full turn at each speed: rate and radius within 5 % of the table; bank reaches 55° in < 1 s.
  - `climb_dive`: +19 / −25 m/s ±1.5 at cruise; hands off returns to level in < 2.5 s.
  - `guard_hill`, `guard_wall`: hands off towards a 100 m ridge and an 80 m wall 400 m ahead: cleared by ≥ 8 m,
    no contact.
  - `guard_off`: nose held down into flat ground: a crash; then the respawn pose is ≥ 60 m up, level, at cruise,
    ≥ 3 s back along the path.
  - `skim`: a 3° descent onto a flat roof: a bounce, not a crash.
  - `edge`: hands off at each edge and into a corner at 70 m/s: never nearer than 16 m, turned back within the
    margin.
  - `ceiling`: nose held up for 120 s: stays under `meta.H + 450`.
  - `loading`: a sweep into a missing tile holds the step and resumes when it arrives.
- On the real data (skipped without `public/data`, as `collision.mjs`):
  - `danube`: hands off at fast from the west edge to the east at 60 m over the river: no crash, ≥ 8 m clear of
    every bridge and bank, turned back at the east edge.
  - `oberhaus`: hands off at cruise from the Danube at 40 m straight at the Veste: cleared.
  - `fuzz`: 10 min of seeded random input at 60 Hz: no NaN, always inside the map and under the ceiling, every
    crash followed by a valid respawn. Prints crashes per minute hands-on (a number to watch, no gate).
- Gate: `node tools/plane.mjs` exits 0, in under ~10 s.

### Phase 2: flying it on the desktop (1.5 days)

- `nav/plane.ts` `PlaneMode` (lazily imported beside the other two in `main.ts`), `nav/plane-model.ts`,
  `nav/plane.css`: panel and button, keyboard, the chase camera, the model with its propeller, telemetry, the crash
  presentation, pause on blur. `window.__plane` for tools (as `__drive`): `start({ x, y, z, h })`, `pose()`,
  `script(inputs)`.
- `main.ts`: construct it, `plane?.update(dt)` in the loop, `onMode` toggles `body.plane`, the shadow casters'
  condition.
- Gates: `tools/shoot.mjs` with an ad-hoc shot that starts the plane through `--eval` at a fixed pose over the
  Altstadt (`--crop 384`): the plane is in the picture, no console errors; added to no reference set yet. By hand:
  enter from the overview and from a close orbit, a lap round the Dom, a deliberate crash, Esc, re-enter, then the
  drone and the car once each.

### Phase 3: touch, gamepad, night (1 day)

- The left stick and the `Fast` / `Slow` buttons, pinch zoom; the gamepad; the lights; the help line's touch
  variant; safe-area and landscape rules copied from `#handbrake-button`.
- Gates: `shoot.mjs` at 412 × 860 with touch (its phone shot) with the plane started: the buttons are shown, clear
  of the bar and the "?"; a night shot (`hour=23`) shows the lights. By hand on a phone, portrait and landscape:
  one-thumb lap, both buttons, pinch, exit. A line for this goes into `FRAGEN.md`'s mobile test when built.

### Phase 4: does the world keep up (0.5–1 day)

- `web/tools/plane-flight.mjs` (playwright through the helpers `shoot.mjs` uses, its own port): the real page, the
  plane scripted through `window.__plane` west to east at fast and at 120 m, then a slalom over the Altstadt.
  Sampled every 0.5 s: the level of the node shown under the plane and 300 m ahead, the streamer's queue length,
  frames spent in `'loading'`, console errors.
  - Gate: no console error, no hole (a shown node under every sample), no `'loading'` stretch over 0.5 s.
  - Reported, not gated (software GL meshes and draws far slower than a real GPU): the share of samples at 1 m under
    the plane, the worst queue length.
- `popin-check.mjs` gets `--kmh` and `--alt` (today a constant 45 km/h on the roads): run at 250 km/h and 120 m on
  straight lines. Gate: its existing appear / vanish / jump counts stay 0. Reported: agents within 300 m under the
  plane against a standing viewer.
- Only if the reports ask for it: the lookahead `focus()`. Then the README's section "Plane" (controls, the
  tools), beside "FPV Acro prototype" and the drive section.

### Phase 5, optional: water landing (2 days; question 1 B)

`VoxelCollision.waterAt` (the rule of `physics/rapier/terrain.ts`: a water run reaching the ground's top); a state
`afloat` in `PlaneFlight` (touching water under 4 m/s of sink and 15° of bank: skims, slows, floats and steers at
up to 15 m/s; fast held: takes off at 30 m/s); floats on the model; "Splash!" instead of a crash on water otherwise;
the river level slider (`flood.ts`) read for the height. Its own checks in `plane.mjs`.

**Total without phase 5: about 5 days.**

## Risks

- **Feel.** The numbers above are a first guess; turn rate, lag and field of view decide whether it reads as a
  plane or as a fast camera. They sit in one `PLANE` object and phase 2 ends with a tuning pass by hand. The tests
  in phase 1 take their limits from that object, not from literals.
- **The ground guard feels like the plane fighting the player**, or hides the map's best flying (the river under
  the bridges). The nose-down weight is the answer; if it still annoys, a checkbox turns it off (not planned).
- **The east edge**: the Altstadt and the Eck lie within 350 m to 1.3 km of it. The margin is speed-dependent for
  that reason; `edge` and `danube` test it. A fast pass over the Eck will still be turned back early.
- **Collision stalls** at 70 m/s on a slow connection (hosted later): the plane would hang in the air. Measured in
  phase 4; the fix if needed is a longer horizon (a number), not a new mechanism.
- **Wings pass through things** (only the fuselage collides). Seen in close passes; accepted.
- **Phones**: 2 M triangles from 120 m up means the city at 2–4 m. It is what the overview already shows there.
- **`Mode` gets a sixth value**: every `switch` and record over `Mode` (`hud.ts` `MOUSE`) needs its entry; tsc
  finds them.

## Deliberately left out

Cockpit view and free look; a throttle lever; stall, wind, trim, rudder, flaps; landing on land and taxiing
(question 1 D); runways (question 1 C); damage, fuel, scores, missions; collisions with cars, people, boats and
trains; wing collision; tilt control; controller setup UI; engine sound; a minimap or compass; several planes or
planes parked in the world to walk up to and enter (the server-world step: a plane becomes an entity with a pose
and an owner, `PlaneFlight` stepping it on whichever side is authoritative); a `?plane=` URL parameter; any change to
the data pipeline or to `data/`.
