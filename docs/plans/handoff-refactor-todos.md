# Handoff: refactor to-dos

These are self-contained work packages for agents started by the owner. Pick one package, read the linked item(s) in
[code-health.md](code-health.md) (file and line references there are of commit `6adf465a`, so re-locate them), do
it on its own branch, and report.

## Rules for every package

- Commit locally on a branch named after the package. **Never push.** Do not touch `.github/` (CI, Pages).
- Open data only. `scripts/palette.json` is append-only. In shaders, add no new and no `flat` varyings.
- Do not create or rewrite `CLAUDE.md` or `IDEAS.md`.
- Keep it simple and do not over-engineer. The long-term goal is a server-hosted, multiplayer-capable world, so keep
  simulation free of three.js and the DOM where you touch it (see [ADR 0006](../adr/0006-world-sim-seam.md)).
- Behaviour-neutral refactors must prove they are neutral: the same check counts, and for the pipeline a byte-exact
  `check.py golden --compare`.
- `npm` is not on PATH. Use `web/node_modules/.bin/…` or `node`. Port 5173 is the owner's dev server, so use another
  port for previews and stop it afterwards.
- A full data rebuild (`sh scripts/build_data.sh`, about 12 min) changes committed tiles. Do not run it unasked. Say
  in the report whether one is needed. Palette entries it appends go in their own commit.

## Gates

- `cd web && node tools/gates.mjs` runs the fast set (14 gates, about 25 s). `--full` runs all 19, and
  `--golden FILE` adds the mesh comparison: record it with `node tools/mesh-golden.mjs write FILE` *before* the change.
- `scripts/check.sh` runs palette, overrides and interiors. `scripts/check.sh --fixture` also runs `check.py verify`
  (minutes). Some verify failures already exist on main, so compare against main and do not expect all-green.
- `node tools/gates.mjs --list` shows which gate guards which files.

## Overview

Everything below is not done yet. "Ready" means it can start now. "Waits" means: start only after the named work is
on `main` (check `git log`). When a package lands, delete its section and its row here, and turn "Waits" rows whose
blockers are gone into "Ready".

| Package | What | Size | Start |
|---|---|---|---|
| R1 | The plane does not start while you are driving (bug) | S | **Ready** |
| R2 | Defect assertions on the fixtures | M | **Ready** |
| R3 | Shared input, chase camera and panels | M | **Ready** |
| R7 | Smaller independent items | M each | **Ready**, except `traffic.build` and the `except` sweep (pipeline files): wait for P1+P3 |
| R8 | Design: sim player API, one world for many players | design | **Ready** |
| F1 | AI motorbikes | S–M | **Ready** |
| F3 | Camera distance per vehicle type | S | **Ready** (or inside R3) |
| F4 | The player car in the same Rapier world as the AI bodies | M–L | **Ready** |
| R4 | Craft interface and `nav.ts` split | L | Waits for R3 |
| R5 | Check harnesses out of `src/` | M | Waits for R3, R4 |
| R6 | Split `voxelize.py` into stages | L | Waits for P1+P3 (see below), R2 |
| F2 | Walk to a vehicle and get in | M | Waits for R1, R4 |
| F5 | Trains and boats into the world sim | M | Waits for F4, R8 |

Not in this list because it is being done right now: **P1+P3**, the pipeline cleanup (shared way helpers in
`scripts/ways.py`, one ordered list of ground-height passes, the bridgehead lift before furniture). It edits
`voxelize.py`, `traffic.py`, `clearance.py`, `tunnels.py`, `underpass.py`, `regions.py`, so do not start pipeline
work on those files until it is on `main`.

## Packages

### R1. The plane does not start while you are driving (bug, S)

- **Waits for:** nothing.
- **Symptom (read from the code, not reproduced):** pressing the plane button while driving parks the car
  (`PlaneEnv.park`), but `startCraft` refuses because the mode is `ride`, not `orbit`. So the car is parked and no
  plane appears.
- **Check:** whether boat and drone have the same problem.
- **Fix:** leave the ride cleanly before starting a craft, for all crafts. Verify in the browser.

### R2. Defect assertions on the fixtures (code-health 14, M)

- **Waits for:** nothing. It touches only `check.py` and `scripts/fixtures/`, not P1+P3's files.
- **Do:** give each fixed road defect one assertion, using the fixtures `b85`, `gaissa`, `haissengasse`, `hals`,
  `kachlet`, `schalding`. Example: "no carriageway cell more than 1 m under its neighbours at this spot". Defect spots
  are in [road-defects.md](road-defects.md).
- **Do:** write counters as JSON beside the notes, instead of `verify` parsing prose by regex.

### R3. Shared input, chase camera and panels (code-health 11, 12 = N2, M)

- **Waits for:** nothing. The shells already hold `FixedStep` clocks and plain vectors from the cores.
- **Do:** one gamepad reader, one typing guard and one focus-loss policy (`nav/input.ts`). Plus `ChaseRig`, `SafeTrail`
  (unstick/T), `ModePanel`, `river.ts`, and one `data-mode` attribute on `body` instead of per-mode body classes and CSS
  hide lists.
- **Do:** make smoothing frame-rate independent (`1 - exp(-k dt)`).
- **Feel:** must stay the same. Check the boat, plane, jet, drone and car by hand in the browser, and keep the gates
  green.

### R4. Craft interface and `nav.ts` split (code-health 10, 19 first point = N3, L)

- **Waits for:** R3.
- **Do:** a `PlayerCraft` interface (`enter`, `leave`, `update`, `hudText`), a registry in `main.ts`, and Nav calling
  `leave()` instead of every craft polling `nav.mode`.
- **Do:** reduce the 83 literal mode comparisons. Then split `class Nav` into a mode machine, orbit input, a foot
  controller and the ride camera.
- **Test:** adding a new craft (e.g. a helicopter) should afterwards need one new file plus one registry line.

### R5. Check harnesses out of `src/` (code-health 16 = T2, M)

- **Waits for:** R3 and R4 (they move the same shells).
- **Do:** move `nav/*-checks.ts`, `plane-real.ts` and `physics/rapier/*scenarios.ts` to `web/checks/`, with one
  synthetic-world fixture and one result type.
- **Do:** create `tools/lib.mjs` for the copied `runnerImport` loader line and the `fetch` stub.
- **Update:** `tools/gates.mjs` if paths change. The check counts must stay identical.

### R6. Split `voxelize.py` into stages (code-health 13 = P4, L)

- **Waits for:** P1+P3 (in progress), and R2 as its guard.
- **Do:** one stage per commit, `def stage(ctx)` over an explicit context. Each commit must be byte-exact under
  `check.py golden --compare` (no data rebuild needed).
- **Cut:** the proposal is in code-health 13.
- **Do:** replace the module globals used as an API (`tunnels.FLOOR/IDS`, `underpass.WALK/SKIP`, `traffic.OPEN_CUT`).
- **Include code-health 18:** a class raster or palette flags instead of finding cells by colour, and one
  `scripts/constants.py`.

### R7. Smaller items from code-health 19 (M each, independent)

- **`traffic.build`:** split it, and tie the 3.0 m lane spacing to `sim/path.ts` with a check.
- **Silent `except Exception`:** around `offset_curve` (rails and lane markings are dropped without a note), log
  what is dropped.
- **`VoxelCollision`:** release instances, so `liveEdits` listeners do not pile up. `plane-real.ts` pokes a private
  field.
- **Build time:** vegetation 21 %, `debris.support_floating` 17 %. See `data/debug/timings.json` and
  [build-speed-2.md](build-speed-2.md).

### R8. Design: presentation writes into the sim; one local player assumed (code-health 15, design only)

- **Waits for:** nothing.
- **Do:** write down the target in ADR 0006 or a new ADR:
  - a sim player API (`takeWheel`, `removePerson`, a player id) instead of `drive.ts` and `nav.ts` writing into
    traffic objects;
  - boats and trains into the world sim;
  - tuning objects that are no longer mutable module globals;
  - the player car in the same Rapier world as the AI bodies.
- **Do not:** implement it beyond small, safe steps. This is the groundwork for splitting off a server later.

## Feature packages

These add behaviour, so they are judged in the browser as well as by the gates. Each comes with a short plan in
`docs/plans/` if it is bigger than S.

### F1. AI motorbikes (S–M)

- **Waits for:** nothing.
- **Today:** the motorbike exists in the catalogue (`sim/vehicles.ts`) for the player only. AI traffic draws cars,
  vans, pickups, buses (see [vehicles.md](vehicles.md)).
- **Do:** add the motorbike to the AI mix, with its own length, lean in curves (presentation only) and a rider.
- **Do:** keep the world sim (`sim/traffic.ts`) free of three.js, and keep the seeded RNG (`core/num.ts`) so `?seed=`
  stays reproducible.
- **Gates:** `vehicles`, `life-edit`.

### F2. Walk to a specific vehicle and get in (M)

- **Waits for:** R1 (leaving a ride cleanly) and R4.
- **Do:** when walking, a key or tap near a parked or moving vehicle (car, bus, motorbike, boat at the bank, plane on
  the water) enters it. Leaving puts the walker beside it, and the vehicle stays where it was left.
- **Do:** go through the sim (a "take the wheel" call) rather than the presentation writing into traffic objects; see
  R8.

### F3. Camera distance per vehicle type (S)

- **Waits for:** nothing. If R3 is running, do it inside R3's `ChaseRig` instead.
- **Do:** the chase camera's distance and height come from the vehicle catalogue (bus further back and higher,
  motorbike closer).

### F4. The player car in the same Rapier world as the AI bodies (M–L)

- **Waits for:** nothing. `physics/rapier/car.ts` is already free of three.js and the drive runs on `FixedStep`.
- **Why:** collisions between the player car and AI cars, and destruction, need one physics world. It is also the
  shape a server needs: one world, many players.
- **Today:** `RapierDrive` (`physics/rapier/drive-world.ts`) owns its own world with one car. AI cars near edits are
  bodies in `physics/rapier/life-phys.ts`.
- **Do:** one shared world with one collider budget. The player car is a body like the others, keyed by a player id.
- **Do:** write a short plan first and measure step cost with `tools/life-phys*.mjs`.
- **Gates:** `rapier-car` 42/42 and `vehicles` 30/30 must stay green (counts may change only with a reason).

### F5. Trains and boats into the world sim (M)

- **Waits for:** F4 and R8.
- **Today:** `sim/trains.ts` and `sim/boats.ts` sit in `sim/` but are three.js presentation with their own motion.
  ADR 0006 notes this.
- **Do:** split each into a plain sim part (positions on their tracks or rivers, fixed 1/30 s tick, seeded RNG, no
  three.js) and a presentation part. Add the sim parts to `tools/core-deps.mjs`.

## Also open (for later)

- **Road spots the general fixes do not reach:** see [road-defects.md](road-defects.md). They are road 1360 under a
  building, Bräugasse, Triftsperrstraße, the Schulstraße kink, road 2510, Steffelmühlweg, and bridges without a deck
  over water (Fritz-Abelein-Brücke, Triftsperre).
- **Aircraft:** wings do not collide. The floatplane's streaming measurement (phase 4 in [plane.md](plane.md)) is
  not done.
