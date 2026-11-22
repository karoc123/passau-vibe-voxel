# Road surface defects reported in play

Places where the drawn carriageway is dented or holed (not continuous), as reported while driving.
Coordinates: voxel x (column), y (metres above base), z (row) as the `cam` URL parameter uses them.
Collected first, fixed generally where possible; only what the general fix cannot reach becomes an override.

| # | voxel | view | what | status |
|---|---|---|---|---|
| 1 | 870, 11, 716 | `?cam=932.1,64.3,707.9,870,11.9,716.5` | crater both sides of the B 8 over the Donauradweg underpass (DTM trench) | fixed 6e277cd9, data 5f0f9e70 |
| 2 | 914, 12, 709 | `?cam=909.5,50.1,738.2,914.7,12,709.3` | carriageway slightly dented, ~45 m east of #1 (DGM falls away at the viaduct abutment) | fixed 7a9a5d40 (sag lift), data bddc1b03 |
| 3 | 775, 6, 499 | `?cam=789.9,34.3,607,775.6,6.2,499` | carriageway dented 5 m into a DGM trench (unmapped culvert, B 85) | fixed 7a9a5d40 (sag lift), data bddc1b03 |
| 4 | -882, 16, 667 | `?cam=-806.7,49.5,685.6,-881.7,17,667.6` | hole in the road (junction on a structure over tunnel ramp) | fixed 7a9a5d40 (sag lift), data bddc1b03 |
| 5 | -1641, 19, 599 | `?cam=-1721.6,55.8,644.8,-1640.3,19,599.3` | carriageway dented / holed (St 2125 over service passage) | fixed 7a9a5d40 + ac587a4a, data bddc1b03 |
| 6 | -4741, 13, -1612 | `?cam=-4708,92.7,-1480.6,-4740.4,13,-1611.1` | bridge looks broken (Gaißabrücke deck calmed away over water) | fixed 7a9a5d40 (calm-water rule spares bridges), data bddc1b03 |
| 7 | -3048, 13, -88 | `?cam=-2966.1,109.8,-189.4,-3047.6,13,-87.1` | B 8 cut by water at the Baderbachl mouth, "bridge missing" (road not tagged bridge; water painted over the carriageway, the sag lift skips ground at the river level) | open, see handoff Q2 (after Q1) |
| 8 | -3841, 13, -682 | `?cam=-3791.6,106,-728.3,-3840.6,14,-681.5` | hole with parapet blocks in the B 8's lane: the underpass stair (steps 73518490) is cut inside the drawn carriageway | open, see handoff Q3 |
| 9 | -3868, 16, -659 | `?cam=-3791.6,106,-728.3,-3867.3,16.2,-659` | the same passage under the railway: the stair (steps 73518489) is cut in the track | open, see handoff Q3 |
| 10 | -2009, 23, 1078 | `?cam=-2077,55.1,1078.8,-2008.8,24,1078.8` | Rottalbahn under the B 12 bridge: ground at deck level (28) stands across the track (22–23), the ground under the deck 1–2 m too high | fixed 8bc0774f, data bf9671e3 (3–4 m clearance, deck 2 voxels thick) |
| 11 | -2087, 115, -1658 | `?cam=-2107,138.8,-1709,-2087,115.7,-1658` | Dietzing bridge (way 106617552, service) over the B 85 cutting "almost collapsed": the deck ramps from 115 at its west end to 121 at its east end, while the surface model is level at 121.5. The way runs along the deck's north edge, 3 profile samples mid-span see the B 85 under it, and the 10th percentile within 10 m pulls the whole short deck down | open, see handoff Q8 |
| 12 | -894, 16, 656 | `?cam=-957.8,53.2,614.6,-894,16.8,656.7` | B 85 link tunnel (way 11773610, `tunnel=yes`, `layer=-1`, 37 m) under the junction of #4 is solid earth, and the ramp ends at a wall. Nothing carves a road tunnel under a street (`tunnels.py` bores only under hills, `underpass.py` takes only foot passages), and the tunnel and sag lifts fill its trench to the street (20). This is #4's other half: #4's fix made the street whole over solid ground | open, see handoff Q9 |

Map-wide scan: [road-defects-scan.md](road-defects-scan.md). Still open from it (need a look, no overrides yet):
bridges with no deck over water — Fritz-Abelein-Brücke (deck 1.1 m over water), Triftsperre (0.7 m), paths 163931217 and 1113369109;
131 small dent stretches the sag lift does not take (no rim the DGM agrees with), the larger ones listed in the scan.

## Carriageway clearance: what the general fixes do not reach

From [road-clearance.md](road-clearance.md). This is the lane scan after its general fixes: lanes on the carriageway as
drawn, one cap surface per carriageway, crowns 3 m clear. None of these has an override. Each needs a look.

The first three are data conflicts. The fourth is the follower's error, not the data.

| voxel (x, z) | where | what |
|---|---|---|
| 2333-2358, 1420-1442 | roads 1359 and 1360, way 73518484 (residential, unnamed) | a building (LoD2/ALKIS) spans the whole carriageway for 30 m, and no passage or tunnel is mapped |
| 8559-8581, 2707-2710 | Bräugasse, roads 133 and 134 (way 7864013) | a lane narrower than a car between house walls: 5 m in the wall |
| 6890-6900, 619-681 | Triftsperrstraße, road 1690 (way 122276595) | the carriageway's edge drops 2.3 m under a car's right wheels for about 35 m, with no room to move the lane (a narrow road on an embankment) |
| 6367, 2520 | Schulstraße westbound, road 1342 | a building corner where the street kinks by 43°; the player car's follower cuts the kink and stops there (the lane itself is 1.8 m clear) |
| 803, 116 | road 2510 (way 693917949, primary) | the path's end at a junction 2.5 m over the drawn surface (8 m, both lanes) |
| 3316, 3183 | Steffelmühlweg, road 2094 (way 163930982) | path over a hole at a small bridge's deck (7 m) |

Summed classes (995 m on 382 km of lanes; full map before the voxel fix):

- leaves: 569 m, expected to go with the full rebuild (crown clearance; the Altstadt fixture went from 51 to 0 m);
- buildings: 94 m on 42 roads, mostly short building corners in alleys narrower than a car;
- holes: 84 m;
- steps: 190 m;
- trunks: 41 m;
- stone: 16 m.

The full lists come from `scripts/clearance.py` on a scan dump.
