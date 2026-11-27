# Enterable houses: a hollow ground floor (hall) in every building (on hold)

Owner's decision (2026-11-27), replacing the earlier windows-first concept: houses become enterable, gameplay first,
not realism. Step 1: every building gets a hollow ground floor (a hall), the house above stays solid. Later the halls
hold loot. Cost decides: if it measurably costs performance, no halls or only chosen ones. Threshold: seen from outside
at most +5 % triangles, no measurably longer frames on the phone profile.

## Layout by size (as probed)

- A 2 m shell round the hall: the outer metre keeps the facade and its painted windows, the inner metre and floor,
  ceiling, pillars get interior colours (three appended palette entries of the interior material: no windows, no
  night light, no weather inside).
- Hall 4 m high, 5 m from 120 m² (3 m under a low roof); floor at the median street level round the house; at
  least 2 m of house over it.
- Doors 2 m wide (3 m from 120 m²), 4 m high (3 m in a 3 m hall), only through walls facing a street at floor
  level or a metre above it, two free cells deep: 1 door under 60 m², 2 under 120, 3 under 400, else 4, spread apart.
- Cover: 2 x 2 m pillars every 7 m in halls 9 m or more across; from 300 m² a partition with a 3 m gap across.
- Left solid: too low (under 5 m over the floor), no wall facing a street, hall under 9 m². No stairs, corridors or furniture.

## Measured: old town, 3 x 3 nodes round 59_21, 243 buildings, 196 get a hall

Variants: all halls; chosen = only halls of 150 m² or more (57); "doors only" = the doors carved but the hall's faces
absent, standing in for a hall whose inside is drawn only while the camera is in it or at its door.

| | all | chosen | all, doors only | chosen, doors only |
|---|---|---|---|---|
| level-1 bytes (388 kB) | +27.5 % (runs +23 kB, room record +62 kB) | +16.2 % | +3.2 % | +1.7 % |
| triangles of the 9 nodes (325 k) | +47 % | +24 % | +7.7 % | +3.8 % |
| in view from the street, phone, today's occlusion | +117 to +283 % | | | |
| same, occlusion opening rooms only from inside | +15 to +23 % | +8 % | +2.4 to +4.0 % | +1.2 to +1.6 % |
| mesh time per node (mean / max, base 15.6 / 20.8 ms) | 22.4 / 33.8 ms | 19.2 / 27.1 ms | as base | as base |

- In view: the tiles' own triangles from the street 6 m before a door, two spots stable over three runs (110 k and
  305 k triangles at base); a third spot varied ±50 % from run to run and is left out.
- The rise under today's occlusion comes from the culling, not the faces: it treats a room as solid except within a
  tile of the camera, and with every ground floor hollow nothing near the street hides anything. The probe's change
  (rooms open only while the eye is in one) is behind `?halls=1`, default off.
- Frame time (phone profile: 4x CPU throttle, drawing left out as in the fly-stream gate): 16.6-17.4 ms mean,
  p95 21-27 ms, standing and walking, outside and inside, in every variant: no measurable difference. The GPU's share
  cannot be measured here (software GL); the triangles in view stand in for it. Inside a hall the view holds
  370-560 k tile triangles (it sees out through the doors).
- Walking in: 197 of 204 doors of 80 halls (walker 1.9 m, steps up 1.05 m; same voxels as the host's collision);
  the 7 failures start stuck at a spot 1.5 m before the door. Traffic follows the road net and the road cells are
  unchanged; a player's car fits through a 3 m door (not tested).

## Owner's verdict (2026-11-27): on hold

Walked in, not good, "not this way": low halls felt like caves, carved footprints like a mole's tunnels, pillars out
of place, and even tall straight halls with window holes stayed dark and oppressive. Tried after the measurements
(`halls.py` options): only halls over 150 m^2, 10 m ceilings, 6 m doors, no arm under 8 m, the largest rectangle in
the footprint, a one-block wall, window holes, no pillars or partition. What a later try would need first (an analysis,
not built): a face's material by the room beside it (one-block walls: facade outside, plaster inside), light indoors
(the sky's share raised, a block grid; or Minecraft-like light per voxel baked into the mesh), window holes on the
facade's painted axes. Hand-built landmark interiors (interiors.py ROOMS) stay possible on their own.

## How to repeat

The probe's script and tool were taken out with this verdict: `git log -- scripts/halls.py` (the last version has the
options above), restored into a branch to run again.
