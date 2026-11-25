# Carriageways a car can drive: clearance scan, classes, general fixes

Branch `clearance`. Follows life-physics.md (deleted; in git at `b5483793`; its rules are in README "Driving"). Its scan found solid voxels in a car's body space on
0.63 % of the road centreline. Kinematic traffic drives through such places; a Rapier car, physical traffic or the
player gets stuck there.

Goal: every carriageway a car can drive. The fixes are general, in the data pipeline. A spot the general fixes cannot
reach goes on the list in [road-defects.md](road-defects.md); none gets an override.

## The scan

`web/tools/life-phys-scan.mjs [--lanes] [--dump FILE]`. `scripts/clearance.py DUMP` sorts the dump into the classes
below.

### Why the old measure was replaced

The old measure looked for solid voxels 0.6-1.8 m over the path's height. It went wrong in three ways:

- **It ignored caps.** A capped street's top voxel stands up to 56/64 m over the drawn ramp, and the car never touches
  it. That voxel counted as a wall: most of its 0.63 % were such voxels.
- **It sampled only the centreline.** A two-way street has no traffic on its centreline. The lanes run 1.5 m to the
  right of it.
- **It saw only a car's middle.** A car is 1.8 m wide.

### What it measures now

Every metre of every lane's path is sampled, as `sim/traffic.ts` drives it (`o0 + 3 m × lane`, mitred). At each
sample the scan takes three points across the car's footprint: the middle and ±0.8 m. At each point it finds the
**drawn surface**: the highest solid top (a cap as drawn) at most 1.2 m over the path's whole-level height. It flags:

| flag | meaning |
|---|---|
| body | solid less than 1.8 m over the surface, or no surface at all ("in a wall") |
| step | the surface 0.6 m or more off one metre on (along), or across the footprint (across) |
| hole | the surface 1.5 m or more under the path |

## Classes on the map as built (main a36b3109 data), lanes, 382 km

| class | m | stretches | roads |
|---|---|---|---|
| step across, capped (the cap keeps a riser where the terrain model shows a wall, or a lane runs onto the kerb or the pavement's edge) | 2868 | 1202 | 335 |
| body: building (the lane in a house's wall: the mapped line along a facade, narrow lanes where the lane 1.5 m right of the line is in the wall) | 1069 | 413 | 190 |
| in a wall: building | 764 | 188 | 92 |
| body: leaves (crowns 2 m over the voxel ground; a cap over its voxel brings the street up to them) | 596 | 279 | 193 |
| step along, capped (a riser across the street: the terrain model's scar or kerb, a cap clamped at its voxel) | 581 | 458 | 166 |
| body / in a wall: stone, concrete (retaining walls, kerbs the lane runs over) | 409 | 225 | 78 |
| step, uncapped (voxel stairs: ground no cap reaches, such as unpaved strips) | 146 | 110 | 74 |
| body / in a wall: trunk, branch (trees mapped on the carriageway) | 160 | 134 | 97 |
| body / in a wall: soil (material 10) | 74 | 42 | 18 |
| hole: path over a drop / near a junction / at a bridge's deck | 147 | 79 | 57 |
| parked car, deck | 10 | 4 | 3 |
| tunnel, building passage (mapped) | 0 | 0 | 0 |
| **all** | **6824** (1.8 %) | | |

By flag: body 3082 m (0.81 %), step 3595 m (0.94 %), hole 147 m (0.04 %).

On the centreline (352 km) the numbers are body 1596, step 1455 and hole 414 m. The lanes are worse than the
centreline, as life-physics.md suspected: a lane 1.5 m right of a street's line is where the house walls and the kerbs
are.

None of this happens in mapped tunnels, and the voxel stairs of uncapped steep streets are small (39 m). Roads 1341
and 1342 (Schulstraße) were blocked by a building corner on the line and a cap riser, not by stairs.

## General fixes

1. **Lanes on the carriageway as drawn** (`scripts/traffic.py` `place_lanes`, before `fit`).
   - Every metre, each lane's footprint (5 points over ±0.8 m) needs room:
     - a free level near the path's height: a floor, and 2 m clear of anything a car hits. The new `csolid` counts
       leaves, poles and lamps, as `solidForCar` does; the traffic's `solid` does not;
     - the levels across the footprint within a metre of each other;
     - on the carriageway mask.
   - Where the path as mapped has no room, it is moved sideways by the nearest step that has room: 0.5 m steps, up to
     3 m, first on the mask and then off it. Each move is held 4 m either side and eased over 9 m.
   - The path's ends move with it. `sim/traffic.ts` blends junction ends, so this costs nothing there.
   - Map: 27.0 km of lanes moved, on 902 of 3160 roads (median of the largest moves 1.0 m, p90 2.6 m). 245 m found no
     room. Opposite lanes nearer than 2 m: 0.37 % → 0.45 % of the two-way length. traffic.json −1 %. `traffic.build`
     +20 s.
   - A first version also kept the footprint off the terrain model's walls. Once the caps link across such walls (2),
     that changed nothing, so it was dropped.
2. **One surface per carriageway** (`scripts/caps.py` `ROAD_WALLS`, `CLAMP`).
   - Two neighbouring carriageway cells whose voxel tops differ by a metre at most are linked, even where the terrain
     model shows a wall (|Δdtm| > 0.6 m) between them.
   - Such a cell takes the voxels' top as its source (a fallback node). Linked to the far side of the wall while still
     on the terrain model's level, its corners were clamped apart.
   - `CLAMP` goes from 56 to 60/64 m. The cap stays 1/16 m above the voxel under its top voxel. On the Hals fixture's
     steep streets, more links had pushed the clamped edges to 1.1 % (the limit is 1 %): 0.75 % at 60.
   - `web/tools/caps-check.mjs` takes ±60.
   - Two comments in `web/src/physics/rapier` (`car.ts:155`, `scenarios.ts:32`) still say 56/64. They were not touched
     because that directory is the life-physics agent's. Neither is code.
3. **Crowns clear of the carriageway; no trees on it** (`scripts/voxelize.py`).
   - A crown over a carriageway cell keeps 3 m over its ground (`ROAD_CLEAR`; it was 2 m). Street trees are pruned for
     the traffic, and a cap can lift the street up to 60/64 m.
   - A database tree mapped more than 3 m into the carriageway is not drawn (it was left standing in the road). Within
     3 m it still moves to the kerb, as before.
   - A tree without a crown in the surface model (drawn procedurally) is not planted on a carriageway.

## Results

### Full map

- Lanes: body 3082 → 721 m, step 3595 → 190 m, hole 147 → 84 m. All three: 6824 → 995 m (1.79 % → 0.26 %).
- Centreline: body 1596 → 988, step 1455 → 276, hole 414 → 274 m.
- Old measure: 0.63 % → 0.58 %. It counts the capped voxels under the ramps (see "The scan" above).

How it was measured:

- Fixes 1 and 2: `traffic.py` over main's built regions (read only), and `tile_fields.py` on a copy of the tiles.
- Fix 3 needs the regions rebuilt, so it is not in these numbers. Its effect is in the fixture numbers.
- Expected after the full rebuild: leaves (569 m) mostly gone, as on the fixtures.

What is left, lanes (995 m):

| class | m |
|---|---|
| body: leaves | 569 |
| step across | 134 |
| building / in a wall | 94 |
| hole | 84 |
| step along | 56 |
| trunk | 41 |
| stone | 16 |

### Fixtures (lanes, built with the tiles' caps: `check.py build`)

| fixture | km | body before → after | step before → after | hole before → after |
|---|---|---|---|---|
| altstadt | 37.1 | 775 → 25 | 384 → 9 | 28 → 10 |
| hals | 7.3 | 280 → 7 | 517 → 11 | 10 → 3 |
| kachlet | 34.9 | 110 → 0 | 115 → 10 | 20 → 18 |
| schalding | 21.7 | 185 → 5 | 192 → 15 | 13 → 25 (one junction end, road 2510 on the map, in road-defects.md) |
| haissengasse | 21.4 | 156 → 7 | 230 → 0 | 6 → 1 |
| b85 | 19.4 | 79 → 2 | 166 → 2 | 2 → 0 |
| gaissa (no caps: its `build` fails in phenology.py, on main too) | 6.1 | 1 → 0 | 435 → 426 | 7 → 7 |

Without gaissa, body went 1585 → 46 m, step 1604 → 47 m and hole 79 → 57 m. On the Altstadt fixture, buildings went
534 → 21 m, leaves 51 → 0 m and caps' risers 381 → 9 m.

`check.py verify` against main, pre-existing failures as on main:

- haissengasse ped sunk and hover;
- hals ped hover and caps roughness. Roughness p99 went 20.6 → 14.5 cm, still over 12. The road sunk failure (2.75 %)
  is gone: 0.21 %;
- kachlet and gaissa LoD2 outline matching.

Nothing new fails:

- road sunk and hover are lower or equal on every fixture: Altstadt sunk 0.89 → 0.10 %;
- caps roughness p99 is lower or equal everywhere;
- caps edge mismatches are lower on all seven: hals 0.0087 → 0.0075, against a limit of 0.01.

### The player's car on Schulstraße (roads 1341 and 1342)

Command: `rapier-car.mjs --road I,30,REV[,LANE]`. `LANE 1` is new: the car drives the lane's path, not the road's line.

| run | before | after |
|---|---|---|
| 1341 lane | stops 312 m short | through (1 m) |
| 1342 lane | stops 144 m short | stops 94 m short |
| 1341 line, from its far end | stops 113 m short | through (2 m), pitchJit 0.036 → 0.023 |
| 1342 line | stops 132 m short, minUp 0.12 (nearly rolls) | stops 120 m short, minUp 0.94 |
| 1341 line, 1342 line from its far end | through | through |

What still stops 1342 westbound: a building corner at (6367, 2520), where the street kinks by 43°. The pure-pursuit
follower cuts the kink by 1.9 m and hits the corner. The lane's own footprint is 1.8 m clear of it. This is the
junction and curvature class of life-physics.md (a follower's error), not the data.

## Reproduce

In `web/`:

```
node tools/life-phys-scan.mjs --lanes --dump /tmp/lanes.jsonl
```

At the repo root:

```
uv run python scripts/clearance.py /tmp/lanes.jsonl
```

For a fixture:

1. `uv run python scripts/check.py build --fixture F` builds it with the steps after voxelize, which write the caps.
   `verify` builds without them.
2. Run the scan with `VOXEL_DATA=data/check/<name>/base/web/public/data`.
3. Run `clearance.py --data` from inside the workspace.
