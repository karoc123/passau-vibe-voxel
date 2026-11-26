# Roads: open spots on the carriageways

Places where a car cannot drive the drawn carriageway, left after the general pipeline fixes. Coordinates are voxel
x (column), z (row) as `?cam=` uses them. Fix generally where possible; prefer correcting OpenStreetMap itself, else an
override in `scripts/overrides/`. A fixed spot gets a patch in `scripts/fixtures/road-defects.json` so it cannot come
back unnoticed, and its row goes.

## Spots

| voxel (x, z) | where | what |
|---|---|---|
| 2333-2358, 1420-1442 | roads 1359/1360, way 73518484 | a building (LoD2/ALKIS) spans the carriageway for 30 m; no passage or tunnel mapped |
| 8559-8581, 2707-2710 | Bräugasse, way 7864013 | a lane narrower than a car between house walls: 5 m in the wall |
| 6890-6900, 619-681 | Triftsperrstraße, way 122276595 | the edge drops 2.3 m under a car's right wheels for 35 m (narrow road on an embankment) |
| 6367, 2520 | Schulstraße westbound, road 1342 | the street kinks 43° at a building corner; the follower cuts the kink and stops (the lane itself is clear: a follower error) |
| 803, 116 | road 2510, way 693917949 | the path's end at a junction 2.5 m over the drawn surface |
| 3316, 3183 | Steffelmühlweg, way 163930982 | path over a hole at a small bridge's deck (7 m) |
| 1686, -887 | Fritz-Abelein-Brücke, way 9666821 | no deck over the water: deck 1.1 m over it, under the deck rule's 2 m |
| 1072, -1840 | Triftsperre, way 27663957 | no deck: a walkway on a weir 0.7 m over the water |
| -2212, 364 | path 163931217 | no deck: the surface model 6 m under the terrain model there |
| -2295, 396 | path 1113369109 | 3 m gap over water, cause unknown |
| 1998, 681 | building passage (owner, 2026-11-23) | house built solid where a way runs through; check `tunnel=building_passage` / `covered=yes` in OSM and whether `clearance.py` reads it |
| 2613, 477 | Anton-Niederleuthner-Brücke's end, way 8027919, footway 853342668 | no `bridge` tag, 6 m over the Ilz, so left on water |
| -3841, -682 | passages under the B 8 (way 73518491) and the railway (73518482) | mapped shorter than road and tracks are wide; steps 73518490/89 start inside them |
| -2009, 1078 | B 12 bridge over the Rottalbahn, way 34755059 | 25 m long; the deck is wider than three lanes |
| -1282, 1156 | Stelzhamerstraße tunnel, way 8022045 | blocked: the railway embankment over it is high only in its middle third (tracks 27355998, 593528918 0–1 m over the floor) |
| 1285, 993 | rail tunnels 24153461, 101216178 under the ZOB | north portal blocked for 3 m by building 96488064's walls carried into the trench |

The B 8 over the Baderbachl mouth (way 73317832) is carried as a culvert; a `bridge=culvert` tag in OSM is still right.

Dents the sag lift does not take (no rim on carriageway the terrain model agrees with): 131 stretches, mostly 1–6
cells. The larger ones: service 28093589 (1416, 929; 39 cells, 4 m), service 296695191 (-3250, -87; 30 cells, 6 m),
Industriestraße 125812800 (-4775, -1267; 20 cells), Innstraße 98905800 (1266, 1300; 14 cells), Hennebergerstraße
73317824 (-3257, -27; 13 cells).

## The lane scan

`web/tools/life-phys-scan.mjs --lanes --dump FILE` samples every metre of every lane's path as the traffic drives it,
at three points across a car's footprint, against the drawn surface (a cap as drawn, at most 1.2 m over the path).
Flags: body (solid under 1.8 m over the surface, or in a wall), step (0.6 m or more along or across), hole (1.5 m or
more under the path). `uv run python scripts/clearance.py FILE` sorts the dump into classes; for a fixture, build it
with `check.py build --fixture F`, scan with `VOXEL_DATA=data/check/<name>/base/web/public/data` and run
`clearance.py --data` inside the workspace.

Map after the general fixes (lanes moved onto the drawn carriageway, one cap surface per carriageway, crowns 3 m
clear): 995 m flagged on 382 km of lanes (0.26 %), before the full rebuild: leaves 569 m (expected to go with the
rebuild), buildings 94, holes 84, steps 190, trunks 41, stone 16. Re-measure on current data before working from
these numbers.
