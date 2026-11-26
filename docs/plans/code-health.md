# Code health: what to clean up, ranked

Status: review and plan, nothing implemented. Reviewed at `6adf465a` (354 commits, 317 of them in the last six days).
Line numbers are of that commit.

## Summary

- **The state is better than the commit rate suggests.** `tsc` is clean, `tools/core-deps.mjs` passes (18 modules), and
  all 14 headless gates run here passed (list under item 1). The world-sim seam of ADR 0006 holds for what it covers.
- **The worst place is the pipeline.** `scripts/voxelize.py` is a 4061-line module-level script with 929 shared names,
  and road height is decided by 13 scattered, order-dependent passes. Every road defect fixed so far added one more.
- **The second worst is the player's crafts.** Drone, boat, plane/jet and car are four hand-copied shells with no common
  interface; input, chase camera, shake, unstick and panels exist three to four times and have drifted.
- **The seam stops short of the player.** ADR 0006 covers the traffic only. The player's own vehicles are not
  server-usable (three.js in two of four motion cores, the fixed step in three different places) and nothing guards them.
- **Nothing runs the gates.** There is no single entry and CI only builds. With many agents committing in parallel,
  this is the cheapest thing to fix and the first to do.

Effort: S = under half a day, M = one to two days, L = several days. "Before features" means: do it before adding
another craft, another road-height fix, or any server work.

## Dringend (do now)

### 1. No single "run all gates" entry; CI runs none of them — S, before features

- **Where:** `web/package.json` scripts are only `dev`, `build`, `preview`, `check`. `.github/workflows/pages.yml` runs
  `pnpm build` and deploys. `scripts/build_data.sh` calls no check. 11 of the 27 files in `web/tools/` are not
  mentioned in the README (`caps-check`, `core-deps`, `edit-roundtrip`, `layers`, `life-edit`, `popin-check`,
  `section-check`, `surface-gap`, `tile-roundtrip`, `vehicles`, `world-smoke` are found only through plan docs).
- **Why:** which gate guards which file is knowledge spread over ADRs and plans. An agent changing `car.ts` has no way
  to know it should run `vehicles.mjs`, `rapier-car.mjs`, `life-edit.mjs` and `surface-gap.mjs`.
- **Measured here** (all pass): `core-deps` 0.1 s, `bld-ids` 0.4, `layers` 0.4, `edit-roundtrip` 0.6, `boat` 1.7,
  `tile-roundtrip` 1.9, `world-smoke` 2.4, `collision` 3.2, `vehicles` 3.2, `rapier-car` 3.3, `caps-check` 6.1,
  `plane` 13, `life-edit` 15, `section-check` 56, `popin-check` 59 s. `tsc` 0.7 s.
- **Fix:** `web/tools/gates.mjs` with a table (name, command, needs real data?, seconds, which paths it guards) and
  two sets: `pnpm gates` (fast, under 60 s, everything but the last two) and `pnpm gates:all`. Run the fast set in CI
  before the Pages build (the data is committed, so the real-data gates can run there). On the Python side one
  `scripts/check.sh` for `check.py verify`, `palette_check.py`, `tile-roundtrip`.
- **Not run in this review:** `mesh-golden`, `surface-gap` (they write files), `shoot`, the benches, `scripts/check.py`.

### 2. Road and ground height is decided by 13 scattered passes — M, before the next road fix

- **Where**, in execution order:

  | Pass | Where | Own magic numbers |
  |---|---|---|
  | terrain walls snapped | `voxelize.py:241-268` | drop 3 m, 0.65, slope 0.25 |
  | tunnel lift | `voxelize.py:370-401` | tunnel ≤ 150 m, depth 1.5–6 m |
  | passage lift | `voxelize.py:402-449` | `PASS_BAND 8`, depth 1–6 m |
  | sag lift | `voxelize.py:450-535` | `SAG_MIN/MAX/SPAN/SIDE 1/7/150/6`, portal 12 m |
  | open cuts | `voxelize.py:536-552` | 2 m, 6–24 m; rewrites OSM tags in place (`:551`) |
  | calm-water bridge rule | `voxelize.py:1051-1065` | `nd_max < 4` |
  | bridge way on the ground | `voxelize.py:3364-3393` | g−3 .. g+2 |
  | `bridgehead_fill` and lift | `voxelize.py:3395-3499` | `BH_GRADE 0.12`, `BH_REACH 40`, ≥ 2 m |
  | stairwell pit fill | `underpass.py:117-125` | p80, −5 |
  | tunnel bore floor | `tunnels.py:196-214` | `COVER 2` |
  | caps | `caps.py:76-94, 165-175, 373` | `SRC_TOL`, `WALL_TOL`, `BLEND`, `ROAD_WALLS`, `CLAMP 60` |
  | lane placement | `traffic.py:214-342, 879-884` | `FOOT ±0.8`, `SHIFT 3.0` |
  | crowns and trunks off carriageways | `voxelize.py:2520-2565, 2781-2784` | `ROAD_CLEAR 3` |

- **Why:** tunnel, passage, sag and bridgehead lift are four versions of one idea ("the terrain model dropped under a
  structure: lift to the surface model or the street"). Each has its own "low DSM" estimate (`:419`, `:471`, `:3406`),
  its own depth window and its own way buffer. They depend on each other through comments: the sag lift exists because
  the passage lift misses ways (`:453-454`); `bridgehead_fill` ORs in the sag lift's cells so it does not undo them
  (`:3430-3432`). The sag lift silently does not run without `data/laser.npz` (`:468-469`).
- **Fix:** one ordered `GROUND_PASSES` list of `(name, fn(ctx) -> new ground, mask)` with shared `dsm_low()`,
  `carriageway_mask()`, `portal_nodes()`, a per-pass cell count in `report.json`, all thresholds in one table. Then
  test on the `b85`, `haissengasse`, `gaissa` fixtures whether the sag lift subsumes the tunnel and passage lifts
  (not verified). Guard: `check.py golden --compare` is byte-exact.

### 3. The bridgehead lift runs after furniture and moves only 7 voxels — S–M (falls out of 2)

- **Where:** `voxelize.py:3482-3486` copies `range(7)` voxels per column up, after buildings, trees and lamps are in
  the volume. A roadside lamp is 10 voxels tall, and its recorded head (`lamps`, exported at `:4053`) and procedural
  trees' `t["z"]` (`:2551`) are never corrected after the ground is replaced (`:3497`).
- **Why:** a lamp or tree on a lifted cell is cut and its light floats at the old height. Confirmed in the code;
  whether today's data has such a cell is not verified.
- **Fix:** run the lift before furniture (item 2 does that), or shift whole columns and patch `lamps` and tree `z`.

### 4. One malformed OSM `layer` tag crashes a region — S

- **Where:** `parse_len` returns `None` for a non-numeric string (`voxelize.py:164-168`). It is compared directly at
  `:371-372`, `:417`, `:477`, `:544` and in `tunnelish` (`:567`). `layer=yes` raises `TypeError`; the default only
  covers a missing tag.
- **Fix:** `ways.layer_of(tags) -> int`. Do it with item 5.

### 5. "Is this way underground?" has four answers — S

- **Where:** `voxelize.tunnelish` (`:566-569`), a hand copy in `regions.py:603-613`, `traffic.underground`
  (`traffic.py:41-43`: no culvert, no `covered`), `clearance.underground` (`clearance.py:25-27`: bare `float()`, no
  `indoor`). Also four number parsers (`voxelize.py:164`, `ways.py:12`, `tunnels.py:31`, `traffic.py:32`,
  `trees.py:23`), three way rasterisers with different rounding (`voxelize.cells_of :319`, `tunnels._cells :74`,
  `underpass._cells :67`), and the road-class tuple as a literal at `voxelize.py:379, 424, 541` beside `ways.ROADS`.
- **Why:** the same way can be a tunnel for the volume and a surface road for the traffic or the clearance scan. That
  is exactly the class of bug the road-defect list keeps collecting.
- **Fix:** all of it into `ways.py`, one predicate with explicit variants where a difference is meant.

### 6. Latent bug: a person once walked by the player stays possessed — S

- **Where:** `web/src/nav/nav.ts:80, 812-816`: `possessed` and `person.ctl` are set and never cleared anywhere in
  `src`.
- **Why:** following the same person again takes the `possessed === R.obj` branch (`nav.ts:788`), skips the init, and
  writes the shared `walkPos` into the person: they jump to where the player last walked. Every possessed person is
  also pinned in the sim for good (`sim/traffic.ts:214, 432, 589` skip `p.ctl`). Read from the code, not reproduced.
- **Fix:** clear both on leaving the ride (`setOrbit`, `setWalk`, `startRide`).

### 7. The physics core of the car builds a three.js mesh nobody draws — S

- **Where:** `web/src/physics/rapier/car.ts:58-59, 85-100` creates materials, geometries and meshes on every start;
  `syncWheels()` (`:454`) has no caller in `src` or `tools`; `mesh` is otherwise only touched in `dispose` (`:485`).
  Wheel loops are hard-coded `i < 4` (`:123, 289, 456, 469, 476`) while `life-phys.ts:316, 329` uses `numWheels()`.
- **Why:** this dead mesh is the main reason the car core imports three.js, which blocks item 9.
- **Fix:** delete the mesh and `syncWheels`, use `numWheels()`, replace the remaining quaternion maths by a helper.

### 8. Stale comments and leftovers that mislead — S

- **`CLAMP` is 60, comments say 56/64 or 0.875 m:** `voxelize.py:2778`, `web/src/nav/voxel-collision.ts:16`,
  `docs/plans/road-clearance.md:19`, several lines of `docs/plans/surface-caps.md`. The value itself agrees
  everywhere (`caps.py:94`, `caps-check.mjs:67` as a literal 60).
- **`caps.REACH`:** `tile_fields.py:47` says 65 m, it is 71 (`caps.py:101`); the assert still holds.
- **Warsaw leftovers:** `web/src/main.ts:328` `deckOK: /^(Most|Kładka|Wiadukt)\b/` (Polish bridge names: never true in
  Passau, so walking onto a searched bridge puts the walker under it); `underpass.py:3, 60`; `M_TENEMENT`.
- **`voxel-collision.ts:59, 101`:** "the FPV drone's collision, one per page" — there are four instances now.
- **Docs of removed flags:** `?caps=0` in `surface-caps.md:357, 441`; `?lifephys=1&lpr=…` in `life-physics.md:107`.
- **Small real bug:** `main.ts:397` lists `pedestrian` and `plane` for the shadow casters but not `boat`.
- **Fix:** one sweep; fix `deckOK` with Passau's names (`Brücke`, `Steg`) or the object's kind.

## Bald (soon)

### 9. The player's vehicles are outside the server seam — M, before server work

- **Where:**

  | Core | three.js at runtime | State | Fixed step lives in |
  |---|---|---|---|
  | `nav/boat-motion.ts` | no | plain numbers | the shell (`boat.ts:140-144`) |
  | `nav/plane-flight.ts` | yes (`:1`) | `Vector3`, also in `PlaneWorld` | the core (`:257-263`) |
  | `nav/fpv-flight.ts` | yes (`:1`) | `Vector3`, `Quaternion` | the shell (`fpv.ts:205-216`) |
  | `physics/rapier/car.ts` | yes (`:18`) | Rapier body + meshes | `RapierDrive` (`drive-world.ts:135`) |

  `plane-flight.ts` says "no DOM, no scene" and `plane.ts:31` "the same on a server", yet it needs three.js.
  `tools/core-deps.mjs:86` scans only `core/`, `sim/traffic.ts` and `life-phys.ts`. Only the car interpolates its
  drawn pose between steps.
- **Why:** for multiplayer the server must simulate or at least validate each player's vehicle. Every new craft copies
  one of the impure cores.
- **Fix:** plain `{x, y, z}` state and one contract `step(input, STEP, world)` (`boat-motion.ts` is the model), one
  shared accumulator-plus-interpolation runner, and the four cores added to `core-deps.mjs`. Do item 7 first.

### 10. No craft abstraction: four hand-copied shells — L, before the next craft

- **Where:** `nav/nav.ts:24-27` is a string union and `flying()`. `FpvMode`, `BoatMode`, `PlaneMode`, `DriveMode` share
  no interface and have four constructor signatures (`main.ts:457-461`); each polls `nav.mode` every frame to notice it
  was left. Driving is a second architecture (`mode === 'ride'` plus `nav.controlledRide`). There are 83 literal
  mode comparisons (`nav.ts` 44, `main.ts` 13) and 13 `flying()` calls.
- **Why:** a helicopter would touch `nav.ts`, `hud.ts`, `main.ts` in five places, two CSS files of other modes, and
  need a 250–400 line shell re-copying keys, pad, touch, camera, shake and panel.
- **Fix:** a `PlayerCraft` interface (`enter`, `leave`, `update`, `hudText`), Nav calling `leave()`, a registry in
  `main.ts`. Do items 11 and 12 first; they shrink the shells to what really differs.

### 11. Input handling three times, drifted — M

- **Gamepad:** "first standard pad, deadzone 0.12" copied in `drive.ts:204-223`, `boat.ts:220-237`,
  `plane.ts:334-357`; the drone has its own system with device choice and calibration (`fpv-input.ts`), so crafts can
  read different pads. `FpvInput.update()` polls pads and redraws its DOM in every mode (`fpv.ts:118`).
- **Typing guard on keydown, seven variants:** `nav.ts:165`, `fpv.ts:301`, `boat.ts:94`, `drive.ts:86`,
  `plane.ts:146` (no `button`), `hud.ts:42`, `main.ts:161, 163`.
- **Focus loss, four behaviours:** drone pauses and wants re-arming, plane freezes, car skips its step, the boat keeps
  going with no input (`boat.ts:139`).
- **Fix:** `nav/input.ts`: one pad reader, one typing guard, one focus policy, a normalised intent per craft.

### 12. Chase camera, shake, intro, unstick and panels three to four times — M

- **Chase camera:** `ride.ts:12-42` + `nav.ts:795-805`, `pedestrian.ts:113-124`, `boat.ts:241-276`,
  `plane.ts:362-407`, each with its own obstruction probe, minimum and margin.
- **Frame-rate dependent smoothing:** `nav.ts:781` (`fov += … * 0.1` per frame), `ride.ts:16` (`*= 0.98` per frame);
  boat and plane use `1 - exp(-k dt)`.
- **fov restore:** boat and plane keep their own `savedFov` on top of Nav's `orbitFov`; the drone relies on Nav for
  fov but restores `near` itself.
- **Unstick (T):** three ring buffers with different periods and sizes (`drive-session.ts:97-101`,
  `boat-motion.ts:165-169`, `plane-flight.ts:460-477`); the drone restarts at its spawn.
- **Panels:** `say()` three times, hold-button block copied (`drive.ts:63-75`, `boat.ts:73-85`), five body classes set
  in five places, other modes' panels hidden by CSS lists in each mode's file, by JS, or not at all. `walking`
  (`main.ts:248`) is used by nothing.
- **Put in at the river:** two `nearestRiver` (`boat-motion.ts:250`, `plane.ts:211`); the boat fetches `flood.json`
  itself (`boat.ts:160-164`) while the plane gets the river from `Flood`.
- **Fix:** `ChaseRig`, `SafeTrail`, `ModePanel`, `river.ts`; one `data-mode` attribute on `body`.

### 13. `voxelize.py` is one script with 929 module-level names — L

- **Where:** 2436 lines of module-level statements, 66 functions. 250 names are assigned more than once, 113 more than
  1000 lines apart (`g` at `:268, 528, 3497`; `_lift` is an int array at `:3476` and a mask at `:2782`). The file is
  driver, library and per-region worker at once (`:42-45`, `regions.py:135-192` re-executes it per region through env
  vars). The feature pass runs the first 845 lines of every region a second time (`:840-845`). Decks and bridgeheads
  (`:3225-3500`) sit under the "street furniture" stage.
- **Why:** nothing in it can be run or tested alone, a reorder is silently wrong, and it is the most-changed code
  file (53 commits in three weeks). Parallel agents collide here.
- **Fix:** each `stage()` becomes `def stage(ctx)` over an explicit context, one stage per commit under the golden
  check. Proposed cut: context and palette (1–217), rasters (219–367), ground passes (368–552), surface classes
  (555–1143), buildings (1144–2000), natural ground (2001–2361), vegetation (2362–3013), furniture (3014–3224),
  bridges (3225–3770), export (3857–4061). Also replaces the module globals used as an API (`tunnels.FLOOR/IDS`,
  `underpass.WALK/SKIP`, `traffic.OPEN_CUT`, set at `:3842-3848` and again in `regions.py:525-527`). After item 2.

### 14. The pipeline's checks know two fixtures and parse prose — M

- **Where:** `check.py:64-65` knows `altstadt` and `altstadt_wide`. The defect fixtures (`b85`, `gaissa`,
  `haissengasse`, `hals`, `kachlet`, `schalding`) have no assertion. `verify` reads the build's free-text notes by
  regex (`check.py:359-377`). `region_check.py` and `window_check.py` are shims.
- **Why:** each road defect was fixed by eye on a fixture; nothing stops the next lift from breaking the last one.
- **Fix:** per defect one assertion ("no carriageway cell more than 1 m under its neighbours at this spot"), counters
  as JSON beside the notes. Needed as the guard for items 2 and 13.

### 15. Presentation writes into sim objects; one local player assumed — L, with the server work

- **Where:** `nav.ts:816, 831` (`person.ctl`), `drive.ts:153-159` (rewrites the traffic car's type, length, colour),
  `drive-session.ts:22, 121-131, 168-169` (the car's pose and speed), `RapierDrive` holds one car and publishes
  `globalThis.__rapierDrive` (`drive-world.ts:94`), `sim/life.ts:209` `knockDown` decides in the presentation that a
  person leaves the crowd. `sim/boats.ts` and `sim/trains.ts` sit in `sim/` but are three.js (ADR 0006 says so).
  `BOAT`, `PLANE`, `RIDE` are mutable module-level tuning objects (since E5 read-only and passed in: `sim/tuning.ts`). 83 `addEventListener`, no `removeEventListener` in
  the modes.
- **Fix:** route through the sim's player API (`takeWheel`, `removePerson`), key player state by a player id. Record
  the target in ADR 0006 now; implement with the server.

## Später / nice

### 16. Check harnesses live in `src/`, three parallel fixtures — M

- **Where:** `nav/boat-checks.ts`, `plane-checks.ts`, `jet-checks.ts`, `collision-checks.ts`, `plane-real.ts`,
  `physics/rapier/scenarios.ts`, `drive-scenarios.ts` (about 2300 lines) are imported only by `web/tools/*.mjs`. Three
  synthetic worlds (`collision-checks.ts:87`, `plane-checks.ts:13`, `scenarios.ts:34`), three result types. In the
  tools, the `runnerImport` loader line is copied into 17 files and the stubbed `fetch` into several.
- **Fix:** `web/checks/` with one fixture module and one result type; `tools/lib.mjs` for the loader and the data
  fetch stub (`real-city.mjs` is already half of it).

### 17. Dead code, flags and debug globals — S

- **Python:** `region_check.py`, `window_check.py`, `osm_pbf.py` (referenced by nothing), `tiles.export` (only its own
  test), `interiors.py` running in every region with `ROOMS = []`, unused `M_FLOODLIT/M_BRONZE/M_SIGN`, `_bh`
  (`:3463`), `pier_mask` (`:3702`). Env switches without a fixture: `NO_LASER`, `NO_SPECIES_MAP`, `TRAFFICDUMP`,
  `PASSAU_SNAP` (only `NO_LOD2`, `FINALDUMP` are documented).
- **Web:** `?lpnear`, `?lpmax` (debug knobs of a finished experiment), `?lifephys=0`, `?seed`, `?autores`
  undocumented in the README; `?dig=1` gates a whole feature. `PlaneEnv.park` has no effect. Debug globals
  `__boat`, `__drive`, `__plane`, `__rapierLoadMs`, `__rapierLoad`, `__rapierDrive`, `__lifephys` are read by no tool.
- **Fix:** delete; keep one documented `?debug=` table in the README.

### 19. `nav.ts`, `traffic.build`, silent excepts, build time — M each

- **`class Nav`** is 782 lines (`nav.ts:52-833`): mode machine, gestures, orbit helpers, walk physics, ride camera,
  possession. Split after item 10 into mode machine, orbit input, foot controller, ride camera.
- **`traffic.build`** is 563 lines with 9 closures (`traffic.py:373-935`); the lane spacing 3.0 m there must match
  `sim/path.ts` (not tied by a check).
- **`except Exception`** round `offset_curve` drops rails and lane markings without a note (`voxelize.py:922, 929,
  1109`).
- **Build time** (`data/debug/timings.json`): `drop_debris` 7 % (vegetation and `support_floating` roughly halved:
  [build-speed-2.md](build-speed-2.md) 8.3).
- **`VoxelCollision`:** four instances, each a `liveEdits` listener for the page's life, no release
  (`voxel-collision.ts:101-102`); `plane-real.ts:20` pokes a private field through a cast.

## Not a problem (checked)

- `main.ts` is 630 lines and mostly wiring; `boot()` is 88 lines. It is the most-changed file, but not a god-file.
- No OSM way ids or coordinates are hard-coded in the road-height passes (ids appear in comments only).
- Cross-language constants agree today: `CLAMP`, paved colours, material ids, wall materials.
- The world sim draws no `Math.random` and reads no wall clock except for statistics.

## Work packages

Packages in different lanes touch different files and can run in parallel. Within a lane they are serial.

| Lane | Package | Items | Files |
|---|---|---|---|
| T (tooling) | T1 gate runner and CI | 1 | new `web/tools/gates.mjs`, `web/package.json`, `.github/workflows/pages.yml`, new `scripts/check.sh`, README |
| T | T2 checks out of `src/` | 16 | `web/src/nav/*-checks.ts`, `plane-real.ts`, `physics/rapier/*scenarios.ts` → `web/checks/`, all `web/tools/*.mjs`; after C1 |
| P (pipeline) | P1 small fixes | 4, 5, 8 (Python part), 17 (Python part) | `ways.py`, call sites in `voxelize.py`, `traffic.py`, `clearance.py`, `tunnels.py`, `underpass.py`, `regions.py`, `tile_fields.py` |
| P | P2 defect assertions | 14 | `check.py`, `scripts/fixtures/` |
| P | P3 ground passes | 2, 3 | `voxelize.py` 219–552 and 3225–3500 |
| P | P4 stage split | 13 | `voxelize.py`, `regions.py`, `tunnels.py`, `underpass.py` |
| N (nav shells) | N1 quick fixes | 6, 8 (web part), 17 (web part) | `nav.ts`, `main.ts`, `voxel-collision.ts` comments, docs |
| N | N2 shared pieces | 11, 12 | new `nav/input.ts`, `chase-rig.ts`, `safe-trail.ts`, `mode-panel.ts`, `river.ts`; `drive.ts`, `boat.ts`, `plane.ts`, `fpv.ts`, `ride.ts`, the mode CSS |
| N | N3 craft interface, `nav.ts` split | 10, 19 | `nav.ts`, `main.ts`, `hud.ts`, the four shells |
| C (cores) | C1 pure cores | 7, 9 | `physics/rapier/car.ts`, `nav/plane-flight.ts`, `nav/fpv-flight.ts`, their callers' pose conversion, `tools/core-deps.mjs` |

Notes on conflicts:

- **P is one serial lane**: every package edits `voxelize.py`. A full data rebuild (about 12 min of build, plus
  commit of the tiles) belongs at the end of P3, not to every package; P1 and P4 must be byte-neutral.
- **N2 and C1** both touch the shells (`plane.ts`, `fpv.ts`, `boat.ts`): C1 only where the core's state is read
  (`Vector3` to plain), N2 the input and camera code. Run C1 first or give both to one agent.
- **N1 before N2/N3** (it is small and edits `nav.ts`, `main.ts`).
- **T1 first of all**: every other package is then verified by `pnpm gates`. The CI change needs the owner's consent.
- **Item 15** is design work for the server plan, not a package here.
