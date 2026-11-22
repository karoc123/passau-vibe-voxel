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

## Status of the code-health list

Done on main: items 1 (gate runner, without CI), 6, 7, 8 (web part), 9 (C1: plane, drone and car cores are plain,
`core/vec.ts`, one `core/fixed-step.ts`, scanned by `core-deps`) and 17 (web part).

In progress, do not start anything that touches the same files:

- **P1+P3:** items 2, 3, 4, 5, and the Python parts of 8 and 17. Files: `scripts/ways.py`, `voxelize.py`, `traffic.py`,
  `clearance.py`, `tunnels.py`, `underpass.py`, `regions.py`.

Check `git log` for whether they have landed before you start a package that waits for them.

## Packages

Ordered roughly by value. "Waits for" means: start only after that work is on main.

### R1. The plane does not start while you are driving (bug, S)

- **Waits for:** nothing.
- **Symptom (read from the code, not reproduced):** pressing the plane button while driving parks the car
  (`PlaneEnv.park`), but `startCraft` refuses because the mode is `ride`, not `orbit`. So the car is parked and no
  plane appears.
- **Check:** whether boat and drone have the same problem.
- **Fix:** leave the ride cleanly before starting a craft, for all crafts. Verify in the browser.

### R2. Defect assertions on the fixtures (code-health 14, M)

- **Waits for:** nothing, but coordinate with P1+P3 if it is still open: it touches `check.py` and
  `scripts/fixtures/` only.
- **Do:** give each fixed road defect one assertion, using the fixtures `b85`, `gaissa`, `haissengasse`, `hals`,
  `kachlet`, `schalding`. Example: "no carriageway cell more than 1 m under its neighbours at this spot". Defect spots
  are in [road-defects.md](road-defects.md).
- **Do:** write counters as JSON beside the notes, instead of `verify` parsing prose by regex.

### R3. Shared input, chase camera and panels (code-health 11, 12 = N2, M)

- **Waits for:** nothing (C1 has landed). The shells already hold `FixedStep` clocks and plain vectors from the cores.
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

- **Waits for:** preferably R3 and R4, to avoid conflicts.
- **Do:** move `nav/*-checks.ts`, `plane-real.ts` and `physics/rapier/*scenarios.ts` to `web/checks/`, with one
  synthetic-world fixture and one result type.
- **Do:** create `tools/lib.mjs` for the copied `runnerImport` loader line and the `fetch` stub.
- **Update:** `tools/gates.mjs` if paths change. The check counts must stay identical.

### R6. Split `voxelize.py` into stages (code-health 13 = P4, L)

- **Waits for:** P1+P3, and R2 as its guard.
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

## Not refactoring, but open (for later feature work)

- **Road spots the general fixes do not reach:** see [road-defects.md](road-defects.md). They are road 1360 under a
  building, Bräugasse, Triftsperrstraße, the Schulstraße kink, road 2510, Steffelmühlweg, and bridges without a deck
  over water (Fritz-Abelein-Brücke, Triftsperre).
- **No AI motorbikes,** and no camera distance per vehicle type.
- **Aircraft:** wings do not collide. The floatplane's streaming measurement (phase 4 in [plane.md](plane.md)) is
  not done.
