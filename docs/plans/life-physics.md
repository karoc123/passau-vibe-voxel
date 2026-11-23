# Street life on Rapier: the A+B hybrid

Status: **the hybrid is the default** (branch `hybrid`, after the prototype de357ddf and option A 8a075c34). The section
"Default behaviour" below describes it; the sections after it are the prototype's measurements (`?lifephys=1`, its
options `lpmodel`, `lplost`, `lponly`, ... and `tools/life-phys-browser.mjs` are gone; see de357ddf to rerun them).

## Default behaviour

- **Cars near edits are bodies.** A traffic car within `NEAR` = 60 m of an edited box (at most 60, nearest the edits
  first) gets a body: the player car's chassis and raycast wheels (`physics/rapier/vehicle.ts`) with the lean AI
  controller chasing its ghost, as in the prototype. `main.ts` loads `life-phys.ts` on the first edit, with `?dig=1`,
  or when the drive mode warms up. `?lifephys=0` disables AI body promotion around edits. `?lpnear=` and `?lpmax=`
  are debug knobs.
- **Dug holes**: a car driving into one falls through the real colliders, is a wreck (out of the traffic, parked,
  blocking the cars behind) and comes to rest; then its body stays as a fixed collider while it is near an edit, so
  the bodies coming up see it. Option A's car fall (`life.falling`, kinematic gravity) is gone: the hybrid covers it
  (a car over a hole has a body within ~0.2 s of the edit: its colliders first, 3 chunks a tick).
- **Look-ahead** (one shape cast a body a tick): a body brakes for what stands across its way. When that is a body, a
  wreck or something in an edited box (a placed block, a crater's far wall) it is **held**: its ghost waits for it
  (the car's speed is the body's), so it stays in the traffic and the cars behind queue as for any car. A wall the
  city was built with (the data's defects on the paths, see "Losing the ghost") does not hold it: the ghost goes on.
- **Losing the ghost** (3 m across, 10 m along, 2.5 m in height, rolled over, water): within 12 m of an edit a wreck;
  further away the body goes and the car is drawn back onto its ghost, blended over 0.6-2 s (4 m/s, no pop), with no
  body for 8 s (1 s within 24 m of an edit). This also covers the roads with voxels in the car's envelope until the
  data is fixed (branch `clearance`).
- **People and riders**: option A's simple gravity, unchanged (the traffic reports them in `Traffic.dropped`, the
  presentation draws them falling).
- **The player's car near AI cars**: F4 puts the player and AI bodies in one Rapier world. Path cars near a
  driver have kinematic colliders. A hard collision can turn one into a wreck. See the
  [shared road physics plan](shared-road-physics.md).
- **Server seam**: `docs/adr/0006-world-sim-seam.md`. The world sim (`sim/traffic.ts`, `physics/rapier/life-phys.ts`
  and `core/`) has no three.js, DOM, camera or fetch (`tools/core-deps.mjs` checks it), runs on a fixed tick (1/30 s,
  two Rapier steps a tick), builds its colliders a fixed number of chunks a tick, draws from a seeded generator; the
  presentation (`view/life.ts`) draws it between its last two ticks. Two runs from one seed are bit-identical
  (`tools/life-edit.mjs`).

### Numbers (node 22, WSL2, real data, hour 17)

- **Nothing edited**: 0 ms: no body, no collider, no Rapier step (`life-edit.mjs` checks it every tick of the warm-up).
- **Bench** (`life-phys.mjs`, an 8 m box marked edited in a busy street at (6500, 2600), 521 cars active, 30 s):

  | NEAR | bodies avg / max | bodies' tick avg / p99 / max (ms) | of it Rapier steps / colliders | chunks built | resyncs |
  |---|---|---|---|---|---|
  | 30 m  | 1.1 / 4  | 0.28 / 1.6 / 6.0 | 0.07 / 0.05 | 56  | 0 |
  | 60 m  | 2.6 / 5  | 0.33 / 1.8 / 3.1 | 0.07 / 0.05 | 68  | 6 |
  | 100 m | 7.1 / 12 | 0.67 / 2.3 / 3.6 | 0.16 / 0.16 | 283 | 9 |

  At the bridge (4381, 2697), with NEAR 60: 1.3 bodies, 0.33 / 1.8 ms. The whole traffic tick is 2.0-2.3 ms with
  bodies (1/30 s tick). The p99 is the collider builds (3 chunks a tick, ~0.4 ms each). The resyncs at 60 m all happen
  at two spots, (6449, 2596) and (6502, 2562): along the path, roads with voxels in the car's envelope (the
  `clearance` branch's data fix). They blend over up to 2 s (largest gap 10 m).
- **Gate scenarios** (`life-edit.mjs`): the bodies' tick averages 0.53 ms, p99 2.4 ms, max 7 ms (an edit's first
  collider builds); 6-15 bodies and 54-204 chunks per scenario. A car gets its body 0.23 s after the dig (its
  colliders first). Longest hover over the hole: 0.07 s.
- NEAR stays 60 m: at 14 m/s a car reaches the edit in ~4 s, much more than the 0.2 s its body needs. 100 m triples
  the bodies and resyncs for no gain at the edit.

### Checks

- `node tools/life-edit.mjs [-v] [dig|block|wreck]` (the gate; the world sim alone, headless, `Math.random` off):
  - dig: a sphere of r 4 dug 6 m ahead of a car on the bridge deck (4388, 2679): the car gets a body, falls 11 m to
    the ground, is a wreck at rest there; the cars behind fall in too or stop at the rim; the people there fall;
  - block: a 7x7x3 m block 25 m ahead of a car at (6503, 2556): it stops before it, still in the traffic (its ghost
    held), the car behind it stops behind it, nobody touches it;
  - wreck: a car near an edit wrecked at 8 m/s: it comes to rest on the road, the cars coming up stop behind it;
  - in all: nothing hovers over an edited box (more than 1 m over the ground for more than 0.25 s), no body further
    than 69 m from an edit, nothing done before the edit; the dig twice: bit-identical.
- `node tools/life-phys.mjs [--at X,Z] [--run S] NEAR[:MAX] ...` (the bench: an edit marked round a busy street,
  every car near it a body; the costs, the resyncs).

## The prototype (de357ddf)

Question: how bad does it get if the AI cars near the player are real Rapier bodies instead of kinematic agents?
Short answer: the physics is cheap enough. Keeping the cars on their lanes is not. About 1 body in 150 body-seconds
loses its lane, and most of those losses come from the world's geometry and the traffic paths, not from Rapier. The
destruction case works well. Recommendation: **A+B hybrid**. Cars get bodies only near edits. Elsewhere, a body that
gets stuck is put back on its kinematic ghost.

### What was built

- `web/src/physics/rapier/life-phys.ts` (`LifePhysics`). The traffic simulation stays as it is (`sim/life.ts`: IDM,
  lanes, signals, junction boxes). Every car within `R` of the focus (at most `maxBodies` cars, nearest first) also gets
  a Rapier body, and the car is drawn where its body is. The body chases the car's simulated place on its path (its
  "ghost"):
  - steering: pure pursuit toward a point 2.5 + 0.45 v m ahead on the drawn path;
  - throttle: the gap along the path, closed in about a second;
  - look-ahead (optional): one shape cast per body per frame, lifted 0.7 m and tilted to the path's grade. The body
    brakes for anything in its way, such as a car, a wall or a placed block.
- Body models:
  - `car` (default): the player's RapierCar chassis and raycast wheels, driven by a lean AI controller (no wedges,
    dampers or air assist);
  - `--assists`: the player's full `car.ts` controller instead;
  - `box`: a frictionless round cuboid that can only turn about y. Its horizontal velocity is servoed toward the ghost.
- Hand-off:
  - A car entering R gets a body at its drawn pose and speed. This causes no pop: the body takes the kinematic pose.
  - Leaving R × 1.15, the body is removed and the drawn pose fades back to the ghost over 0.6 s.
- Losing the ghost (more than 3 m across, 10 m along or 2.5 m in height from it, rolled over, or in the water):
  - `lost=wreck`: the car leaves the traffic (`life.takeWheel`: parked, blocking the cars behind) and rests where its
    body comes to rest.
  - `lost=resync`: away from edits, the body is put back on its ghost instead (faded), with no body for 8 s.
- `only=edits` (the hybrid): only cars within 60 m of an edited box get bodies.
- Colliders: the player's streaming (`terrain.ts` RapierTerrain), built around every body with a reach of 24 m
  (now an option; the player's default is unchanged). Live edits (`core/live-edits.ts`) invalidate and rebuild the
  chunks they touch, exactly as for the player car.
- Hooks in `life.ts`: an optional `bodies` (null by default), `pathPoint()`, and skipping option A for owned cars.
  `main.ts` wired `?lifephys=1&lpr=&lpmax=&lpmodel=&lpguide=&lplost=&lponly=` (prototype only; of these only
  `?lifephys=0`, `?lpnear=` and `?lpmax=` are left: README, "URL parameters").
- Tools (in `web/`):
  - `tools/life-phys.mjs`: headless benchmark, plus `--dig` and `--block`;
  - `tools/life-phys-scan.mjs`: scans the paths for room for a physical car;
  - `tools/life-phys-browser.mjs`: Chrome via playwright on port 5211.

### Numbers (node 22, WSL2, real data, hour 17, 60 Hz fixed step, 20 s measured after 2 s of start-up)

Physics time per frame, in ms (one 60 Hz step a frame), at map (6500, 2600). The count was capped with `lpmax`
(R = 500, 521 cars active):

| bodies | car (AI) + look: frame avg / p99 | world step | the cars' JS | colliders | µs per body-step | car, no look | box + look (world step) | player controller (assists) |
|---|---|---|---|---|---|---|---|---|
| 10  | 0.75 / 2.2 | 0.16 | 0.34 | 0.08 | 48 | 0.54 | 1.07 (0.53) | 1.02 |
| 30  | 1.39 / 3.6 | 0.28 | 0.80 | 0.13 | 35 | 0.90 | 2.22 (1.06) | 2.16 |
| 60  | 2.40 / 5.0 | 0.44 | 1.47 | 0.26 | 31 | 1.65 | 4.06 (1.97) | 4.05 |
| 100 | 3.92 / 6.5 | 0.67 | 2.59 | 0.34 | 32 | 2.41 | 6.40 (3.22) | 6.48 |

- The cost scales linearly, at about 30 µs per car per step (17 µs without look-ahead).
- Rapier's solver is the small part when using raycast wheels. The JS↔wasm calls of the vehicle controller and the
  cast dominate.
- The box is more expensive: a box sliding on voxels and caps keeps contacts every step, so the world step triples.
- The player's full controller doubles the per-car cost.

By radius (natural counts, car model with look):

| R | at (6500, 2600): bodies, frame avg / p99 | at the bridge (4381, 2697) |
|---|---|---|
| 100 m | 5.8 bodies, 0.48 / 1.7 ms | 7.4 bodies, 0.52 / 1.3 ms |
| 200 m | 30 bodies, 1.32 / 2.9 ms | 24 bodies, 1.07 / 2.2 ms |
| 300 m | 62 bodies, 2.58 / 4.9 ms | 56 bodies, 2.42 / 4.8 ms |

**Colliders for the larger area**:
- At 100 bodies, 794 chunks of 16 m: 348k shell voxels and 152k cap triangles.
- A chunk takes 0.38-0.5 ms to build. After the start, about 17 chunks a second were built within the 2 ms budget, and
  no body ever waited for its colliders (`notReady=0`).
- The initial fill at R = 300 is about 650 chunks, spread over the first ~2 s.
- An edit costs 16-17 ms once, for the touched 128 m node: the tile's collision form is decoded again on the main
  thread, as it already is for the player. The chunks are then rebuilt over the next frames.
- Memory: the process RSS is 170-350 MB with life, the World and the decoded tiles under the radius. The colliders
  themselves could not be separated from that by RSS; use the voxel and triangle counts above as the measure.

**Browser** (`tools/life-phys-browser.mjs`, Chrome headless, software GL, about 7 fps):
- Physics per frame at up to 4 steps a frame:
  - R = 100: 1.7 ms (6 bodies);
  - R = 200: 4.5 ms (34 bodies);
  - R = 300: 8.6 ms (60 bodies), of which the world step is 2.2, the cars 3.7 and the colliders 2.4.
- That is about 2.1 ms per 60 Hz step for 60 bodies, the same order as node. Run on a GPU, R = 300 would cost about
  2-3 ms of a 16.7 ms frame.
- Caveat: at 7 fps the 4-step cap leaves the bodies' clock behind the ghosts' clock, which inflates the losses there
  (51 in 15 s at R = 300). Treat the browser figures as cost only, not quality.

### Behaviour

- **Lanes, curves, slopes and caps in normal driving: good.**
  - The mean lateral error to the ghost is 0.06-0.10 m for the car and 0.04 m for the box. The mean error along the
    path is 0.4-0.8 m.
  - Cars on capped streets and bridge decks ride smoothly. The bridge area at (4381, 2697) had 0 losses in 20 s at
    R = 100 and 2 at R = 200 (8 at R = 300, which reaches into the old town).
  - The bodies are the player car's chassis and wheels, so their ride and jitter are the player car's (its wobble
    metrics in `rapier-car.mjs` apply); jitter was not measured separately. There is no visible pop at hand-off: radius releases moved
    0.3-3 m, and that is faded out over 0.6 s.
- **Losing the ghost: frequent, and that is the real problem.**
  - Car model, R = 300, 60 s: 28 losses in about 4300 body-seconds. With ~70 bodies, one car leaves its lane about
    every 2 s somewhere in the radius.
  - Causes found by tracing individual cars:
    1. Stuck ("along", about 70 % of losses). The traffic path runs through solid voxels: the ghost drives into a
       7-9 m wall at (6835, 2505) and at (6537, 2541), and onto the voxel stairs of uncapped steep streets (road 1341
       and 1342). The scan (`life-phys-scan.mjs`) found:
       - 2.7 km of the 426 km of centreline (0.63 %) has solid voxels 0.6-1.8 m over the path's height, on 601 of
         3160 roads;
       - 0.12 % has the ground more than 1.5 m under the path.

       The lanes are offset from the centreline, so the real number is higher. The player's own car fails there too:
       `rapier-car.mjs --road 1341,30,1` stops 113 m short, and road 1342 nearly rolls over (minUp 0.12). The
       kinematic traffic has simply been driving through these places.
    2. Junctions ("lat", about 30 %). The ghost's blended junction path turns 90° within a few metres at 4.5 m/s,
       tighter than a car can steer (even at 0.65 rad), so the body runs wide by 3 m.
    3. Chains. A body that lags gets rear-ended by the body behind it, which follows its own ghost; the look-ahead cast
       mostly prevents this.
  - What did not help:
    - a bounded guide force of 0.3 g toward the ghost: 26 losses instead of 28;
    - the box: 23 losses, because it snags on the same walls. It tracks better laterally.
  - The look-ahead trades contacts for stops. Without it there are fewer losses at 100 bodies (23 vs 31) but more
    bodies touching (average 1.4 vs 0.2 pairs).
- **Pile-ups**: the look-ahead prevented them: at most 1-4 touching pairs at any time among 100 bodies. A wreck parked
  in the traffic blocks the cars behind it, because the kinematic snapshot already treats detached cars as obstacles.
  So a crash closes the road, plausibly.

### The destruction case (`tools/life-phys.mjs --dig`, real data)

A sphere of radius 4 was dug into the deck at (4388, 2678), deck height 20.6 m, 6 m ahead of a body doing 41 km/h:
- The body drove into the hole and **fell through the real colliders** to the ground at 9.0 m in about 1 s, became a
  wreck, and came to rest.
- Two more cars followed it in, because the ghosts do not know about the hole (as with option A). Three stopped at the
  rim, where the look-ahead saw the crater's far wall, and were left there as wrecks.
- Physics frame: 0.9 ms average, 3.1 ms at most. Edit: 23 ms.
- Hybrid (`--only edits`): 13 bodies were spawned near the edit, all 4 cars that reached the hole fell and came to rest
  at 9-10 m, and the frame cost was 0.48 ms.
- **Box model: the cars did not fall.** A box that cannot tip bridges a 7 m hole along its length. This rules the box
  out for destruction.

Placed block (`--block`, a 7×7×3 m block 15 m ahead of a body doing 41 km/h):
- Without look-ahead the car hits it and stops dead (42 → 0 km/h in under 0.33 s, no bounce or deformation; the
  chassis has the player's zero friction and restitution). It becomes a wreck, and the cars behind queue up behind
  the wreck.
- With look-ahead it brakes and stops in front of the block.
- The traffic simulation itself never sees the block: the ghosts would drive through it. Only the bodies stop.

### Server hosting

- **Determinism**: two runs with the same seed and an unlimited collider budget gave bit-identical body positions in
  the same process. With the default 2 ms wall-clock build budget they differ: which colliders exist depends on timing.
  A server needs a fixed tick, a count-based build budget and a seeded RNG for life.
- Cross-platform determinism needs Rapier's enhanced-determinism build. It was not tried.
- Determinism is not needed for a server-authoritative design that sends body snapshots.
- **Cost per car per tick**: about 25-40 µs in wasm+JS. One core at 60 Hz could carry roughly 400-600 bodies.
  - A player's 300 m bubble holds 55-70 cars, so that is about 6-10 players with non-overlapping bubbles per core.
    At 30 Hz it would be about twice that, but stability at that rate was not tested.
  - Native Rapier on the server would remove most of the JS cost, which is about 2/3 of the total. That is an
    estimate, not measured.
  - Colliders scale with the area of the bubbles. At R = 300 that is about 600 chunks and ~300k voxels per bubble.
- The hybrid's server cost is close to zero away from edits.

### Effort to productionize

| piece | B fully | hybrid (only near edits, resync elsewhere) |
|---|---|---|
| Paths a car can drive: fix the 0.63 % of blocked centreline and the lane offsets (data pipeline: tunnels, uncapped steep streets, walls on the path) | 1-2 weeks, open-ended | not needed: resync hides it, and edits are rare |
| Junction paths a car can follow (curvature-limited arcs, or a ghost that waits for its body) | 2-3 days | 1 day (tolerances) |
| Traffic that sees the bodies and the world (IDM gaps to bodies, wrecks, placed blocks) | 3-5 days | 2 days (blocks near edits) |
| The player's car in the same world (now two worlds: the player hits kinematic boxes, as before) | 1-2 days | 1-2 days |
| Drawing: wheels and roll from the body; browser performance (budget at 60 fps, step cap); tests and gates | 2-3 days | 1-2 days |
| **Total** | **~3-5 weeks, and quality depends on data fixes** | **~1-1.5 weeks** |

### Recommendation

**A+B hybrid, not B fully.**
- B fully is affordable: about 2.5 ms per frame for 60 cars at R = 300, and ~30 µs per car-tick on a server. But a
  physical car exposes every inconsistency between the traffic network and the voxel world. Today that means one car
  leaving its lane every few seconds within 300 m.
- Fixing that is data work with an unclear end, and none of it is needed for ambient traffic, which nobody touches.
- The hybrid gives real physics exactly where destruction happens:
  - cars near an edit drive into real colliders, fall through dug decks, and hit placed blocks;
  - away from edits, a body that loses its ghost is quietly put back;
  - everything else stays kinematic, with option A as the fallback for cars without a body.
- Keep the `car` model with the lean controller. Drop the box: it can't fall into holes and its world step costs
  more.
- Next steps, if pursued:
  - spawn bodies around edits before the cars arrive (already effectively so at 60 m);
  - put the player car into the same world;
  - make the ghost wait for a body that is behind it near an edit, instead of declaring a wreck;
  - let the IDM see placed blocks.

### Reproduce (the prototype's)

The prototype's tools and options are in de357ddf (`git show de357ddf:web/tools/life-phys.mjs`); the default mode's
are under "Checks" above.
