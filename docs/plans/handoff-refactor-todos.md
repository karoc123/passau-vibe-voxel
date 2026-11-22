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

"Ready" means it can start now. "In progress" names the working branch. "Ready to merge" means the verified
local branch can be merged into `main`. "Waits" means: start only after the named work is on `main` (check
`git log`). When a package lands, delete its section and its row here, and turn "Waits" rows whose blockers are
gone into "Ready". For a partially completed package, remove the landed item and keep the rest of the package open.

| Package | What | Size | Status |
|---|---|---|---|
| R3 | Shared input, chase camera and panels | M | **Ready** |
| R6 | Split `voxelize.py` into stages | L | **Ready** |
| R7 | Smaller independent items | M each | **Ready** |
| F4 | The player car in the same Rapier world as the AI bodies | M–L | **Ready** |
| R4 | Craft interface and `nav.ts` split | L | Waits for R3 |
| R5 | Check harnesses out of `src/` | M | Waits for R3, R4 |
| F2 | Walk to a vehicle and get in | M | Waits for R4 |
| F5 | Trains and boats into the world sim | M | Waits for F4 |

## Packages

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

- **Waits for:** nothing. The defect assertions in `check.py verify` (`scripts/fixtures/road-defects.json`) are
  its guard. The ground-height passes are already in `scripts/ground.py` (`GROUND_PASSES`), the
  way helpers in `scripts/ways.py`.
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
- **Build time:** vegetation 21 %, `debris.support_floating` 17 %. See `data/debug/timings.json` and
  [build-speed-2.md](build-speed-2.md).

## Feature packages

These add behaviour, so they are judged in the browser as well as by the gates. Each comes with a short plan in
`docs/plans/` if it is bigger than S.

### F2. Walk to a specific vehicle and get in (M)

- **Waits for:** R4.
- **Do:** when walking, a key or tap near a parked or moving vehicle (car, bus, motorbike, boat at the bank, plane on
  the water) enters it. Leaving puts the walker beside it, and the vehicle stays where it was left.
- **Do:** go through the sim (a "take the wheel" call) rather than the presentation writing into traffic objects; see
  [ADR 0007](../adr/0007-player-control-in-world-sim.md).

### F4. The player car in the same Rapier world as the AI bodies (M–L)

- **Waits for:** nothing. `physics/rapier/car.ts` is already free of three.js and the drive runs on `FixedStep`.
- **Why:** collisions between the player car and AI cars, and destruction, need one physics world. It is also the
  shape a server needs: one world, many players.
- **Today:** `RapierDrive` (`physics/rapier/drive-world.ts`) owns its own world with one car. AI cars near edits are
  bodies in `physics/rapier/life-phys.ts`.
- **Design:** follow [ADR 0007](../adr/0007-player-control-in-world-sim.md) (player-keyed commands, one shared world).
- **Do:** one shared world with one collider budget. The player car is a body like the others, keyed by a player id.
- **Do:** write a short plan first and measure step cost with `tools/life-phys*.mjs`.
- **Gates:** `rapier-car` 42/42 and `vehicles` 30/30 must stay green (counts may change only with a reason).

### F5. Trains and boats into the world sim (M)

- **Waits for:** F4. The target design is [ADR 0007](../adr/0007-player-control-in-world-sim.md).
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
