# Road surface defects reported in play

Places where the drawn carriageway is dented or holed (not continuous), as reported while driving.
Coordinates: voxel x (column), y (metres above base), z (row) as the `cam` URL parameter uses them.
Collected first, fixed generally where possible; only what the general fix cannot reach becomes an override.

| # | voxel | view | what | status |
|---|---|---|---|---|
| 1 | 870, 11, 716 | `?cam=932.1,64.3,707.9,870,11.9,716.5` | crater both sides of the B 8 over the Donauradweg underpass (DTM trench) | fixed 6e277cd9, data 5f0f9e70 |
| 2 | 914, 12, 709 | `?cam=909.5,50.1,738.2,914.7,12,709.3` | carriageway slightly dented, ~45 m east of #1 (DGM falls away at the viaduct abutment) | fixed 7a9a5d40 (sag lift), data pending |
| 3 | 775, 6, 499 | `?cam=789.9,34.3,607,775.6,6.2,499` | carriageway dented 5 m into a DGM trench (unmapped culvert, B 85) | fixed 7a9a5d40 (sag lift), data pending |
| 4 | -882, 16, 667 | `?cam=-806.7,49.5,685.6,-881.7,17,667.6` | hole in the road (junction on a structure over tunnel ramp) | fixed 7a9a5d40 (sag lift), data pending |
| 5 | -1641, 19, 599 | `?cam=-1721.6,55.8,644.8,-1640.3,19,599.3` | carriageway dented / holed (St 2125 over service passage) | fixed 7a9a5d40 + ac587a4a, data pending |
| 6 | -4741, 13, -1612 | `?cam=-4708,92.7,-1480.6,-4740.4,13,-1611.1` | bridge looks broken (Gaißabrücke deck calmed away over water) | fixed 7a9a5d40 (calm-water rule spares bridges), data pending |

Map-wide scan: [road-defects-scan.md](road-defects-scan.md). Still open from it (need a look, no overrides yet):
bridges with no deck over water — Fritz-Abelein-Brücke (deck 1.1 m over water), Triftsperre (0.7 m), paths 163931217 and 1113369109;
131 small dent stretches the sag lift does not take (no rim the DGM agrees with), the larger ones listed in the scan.
