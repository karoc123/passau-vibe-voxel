# Road surface defects: map-wide scan (branch dent)

Scan of the **current map build** (main 30277d14 data, read-only) for carriageways whose voxel ground lies 1 m or more
under the surface model -- the dents and trenches of docs/plans/road-defects.md #1-#5. Script: the prototype of
voxelize.py's sag lift (commit 012fc97e), run on the map's final ground (data/ground.npz g), so the numbers are those
of the current build, and 'lifted' means the new rule takes the stretch (the build may differ by the rim and the
cells under crowns it adds). JSON beside this file: every stretch with its OSM ways.

Per carriageway cell (OSM highway in ways.ROADS, not tunnel/covered/bridge, layer >= 0, drawn at its width):
lo3 = the DSM's lowest return over 3 x 3 m; a candidate where lo3 - g is 1-7 m, lo3 is smooth (range <= 0.6 m over
3 x 3), the laser saw no ground in the cell (laser.npz n_ground == 0), not under a bridge way or bridge outline,
not in a building (+1 m), not within 1 m of the river level. 8-connected stretches; lifted where the rim meets
carriageway the terrain model agrees with (|lo3 - g| < 1) at a median step <= 1 m and the stretch spans <= 150 m.

## Counts

- candidate stretches: 221 (3291 cells)
- **lifted by the new rule: 90 stretches, 2943 cells**; 48 of 10 cells or more, 61 with a lift of 2 m or more
- not lifted: 131 stretches, 348 cells -- all 'no rim on agreeing carriageway' (mostly 1-6 cells: a carriageway's edge under a wall or a roof edge, the inner part of a structure whose rim is 1 m+ off). The larger ones are listed below for a look
- for comparison, without the laser test (any smooth return 1 m+ over the ground, decks and buildings excepted): 588 stretches, 6357 cells -- most of the rest are forest roads under closed canopy (depth 10-35 m, the laser saw their ground)

## The reported spots

| spot (x, y, z) | what | stretch in the scan |
|---|---|---|
| 914, 12, 709 | B 8 before its viaduct (abutment wedge) | lifted (914, 697): 79 cells, up to 3 m |
| 775, 6, 499 | B 85 by the Danube (culvert/short bridge mapped as road) | lifted (796, 500): 273 cells, up to 7 m; lifted (780, 487): 137 cells, up to 4 m |
| -882, 16, 667 | B 85 junction on a deck over the tunnel ramp 11773610 | lifted (-889, 667): 142 cells, up to 5 m |
| -1641, 19, 599 | St 2125 over the service passage 1205663780 | lifted (-1637, 590): 260 cells, up to 5 m |
| -4741, 13, -1612 | Gaissabruecke deck (separate cause: calm-water rule) | lifted (-4720, -1609): 43 cells, up to 3 m |

The earlier underpass survey's places: (-1966, 1020) lifted (B 12, 187 cells, up to 4 m); (-4922, -1636) lifted (St 2125 over the path tunnel 8606995, 14 cells); (2735, 528), (-2484, 694), (1237, 695), (-3528, -19) show no carriageway dent in the current build (paths, steps and a railway over passages; a covered service road) -- not in this rule's scope.

## Lifted stretches (largest 40)

| col | row | cells | median depth m | lift max m | names | OSM ways |
|---|---|---|---|---|---|---|
| 796 | 500 | 273 | 4.69 | 7 | B 85 | 348870268 |
| -1637 | 590 | 260 | 2.69 | 5 | St 2125, service | 1110246194, 1110246195, 1205663779 |
| -1973 | 1018 | 187 | 3.06 | 4 | B 12, primary_link | 34755060, 34755063, 34755064 |
| -889 | 667 | 142 | 3.29 | 5 | B 85, primary | 96131670, 96131676, 122157776 |
| 780 | 487 | 137 | 2.9 | 4 | B 85 | 96131681 |
| -1744 | 608 | 99 | 2.12 | 3 | B 12, primary, primary_link | 102452253, 137898786, 1110246192 |
| -1949 | 992 | 94 | 2.01 | 4 | B 12 | 34755064 |
| -1933 | 958 | 92 | 3.16 | 7 | B 12 | 7970851 |
| 2034 | 1029 | 83 | 5.08 | 6 | Mariahilfstraße | 9717134 |
| 914 | 697 | 79 | 2.33 | 3 | Regensburger Straße | 73518481, 1185727575 |
| -1752 | 832 | 73 | 2.22 | 3 | B 8 | 1110246191 |
| -5167 | -1919 | 72 | 3.9 | 7 | A 3 | 26703839 |
| -5280 | -900 | 67 | 4.03 | 7 | A 3 | 273258673 |
| -5183 | -1918 | 66 | 4.38 | 6 | A 3 | 273261095 |
| -3042 | -85 | 66 | 1.26 | 1 | Regensburger Straße | 73317832 |
| -1868 | 869 | 66 | 2.34 | 4 | B 12 | 661476398 |
| -5293 | -903 | 63 | 3.91 | 7 | A 3 | 26541489 |
| 2622 | -1811 | 53 | 2.3 | 4 | Salzweger Straße | 30412590 |
| -2117 | 1096 | 50 | 3.48 | 6 | Äußere Spitalhofstraße | 1454635724 |
| 2558 | 1201 | 49 | 1.56 | 3 | Mühltalstraße | 213427176, 1409201536 |
| 2652 | -1808 | 44 | 2.46 | 5 | Salzweger Straße | 37420699 |
| -4720 | -1609 | 43 | 1.76 | 3 | Gaißa | 1110715508 |
| -2115 | 1111 | 43 | 3.34 | 6 | Äußere Spitalhofstraße | 1239394812 |
| -960 | 975 | 42 | 2.81 | 5 | Regensburger Straße | 34912586 |
| -2008 | 453 | 39 | 2.76 | 4 | service | 39884982 |
| -3252 | -16 | 37 | 2.2 | 4 | Neustifter Straße | 1273528469 |
| 2428 | 503 | 36 | 4.43 | 7 | Prinzregent-Luitpold-Brücke | 486773614, 853353533 |
| -3268 | -25 | 34 | 2.2 | 4 | Schaldinger Straße | 73317835 |
| 1954 | 832 | 34 | 2.57 | 5 | Gottfried-Schäffer-Straße | 169070751 |
| 2553 | 317 | 33 | 2.98 | 5 | Halser Straße | 11773615 |
| -5503 | 492 | 31 | 2.06 | 4 | Alte Poststraße | 72928253 |
| -856 | 441 | 30 | 1.77 | 3 | service | 1451756117 |
| -9 | 1050 | 27 | 2.62 | 4 | Haitzinger Brücke, residential | 8099725, 1313119733, 1533358203 |
| 337 | 993 | 26 | 1.05 | 1 | service | 153700398 |
| -5610 | 531 | 25 | 2.66 | 4 | Alte Poststraße | 1534407936 |
| -5345 | -1931 | 19 | 1.72 | 3 | primary | 693917949 |
| -5332 | -1910 | 19 | 1.26 | 1 | primary | 48387599 |
| -3067 | -574 | 19 | 1.16 | 1 | Wörth | 169761629 |
| 1249 | 927 | 16 | 1.27 | 3 | service | 48923954 |
| -1855 | 558 | 15 | 1.89 | 3 | Maierhofbrücke | 661476394 |

## Not lifted, 5 cells or more (manual look)

| col | row | cells | median depth m | lift max m | names | OSM ways |
|---|---|---|---|---|---|---|
| 1416 | 929 | 39 | 4.27 | 5 | service | 28093589 |
| -3250 | -87 | 30 | 6.13 | 6 | service | 296695191 |
| -4775 | -1267 | 20 | 5.17 | 5 | Industriestraße | 125812800 |
| 1266 | 1300 | 14 | 5.54 | 6 | Innstraße | 98905800, 1409160078 |
| -3257 | -27 | 13 | 5.93 | 6 | Hennebergerstraße | 73317824 |
| 3010 | -1360 | 9 | 5.71 | 6 | service | 1454419286 |
| 1997 | -753 | 9 | 2.57 | 3 | Dr.-Mayerhausen-Straße | 71438707 |
| 2174 | -1149 | 7 | 2.4 | 3 | Sieglberg | 30412607 |
| -3262 | -18 | 7 | 5.45 | 6 | Hennebergerstraße | 73317824 |
| -2074 | -1662 | 6 | 3.18 | 5 | Dietzing | 106617551 |
| -3557 | 350 | 6 | 1.95 | 2 | Gärtnerweg | 130279363 |
| -1852 | 922 | 6 | 1.77 | 2 | service | 27252225 |
| 2677 | 1154 | 6 | 1.53 | 2 | service | 1150790751 |
| -1265 | -1269 | 5 | 1.75 | 2 | Tittlinger Straße | 169753037 |
| -3554 | 344 | 5 | 1.69 | 2 | Gärtnerweg | 130279363 |
| -2071 | 1172 | 5 | 5.76 | 6 | Äußere Spitalhofstraße | 1110246188 |
| 645 | 1307 | 5 | 2.42 | 3 | Dr.-Hellge-Straße | 390021507 |
| 2502 | 1335 | 5 | 1.5 | 2 | Mühltalstraße | 24727886 |

## Bridge decks missing over water (the Gaissabruecke's cause, #5)

Bridge ways (OSM bridge=*) whose centreline crosses water with no deck under it in the current build (metres of gap;
nd_max: the DSM's highest return over the terrain model there, median). The calm-water rule (voxelize.py: no surface
under 4 m over the water) had zeroed the surface model under decks lower than 4 m; on branch dent it spares cells
under bridge ways, which brings back the decks at 2-4 m. Under 2 m the deck rule itself (nd_mean > 2) still drops them.

| way | name | gap m | at (col, row) | nd_max m | on branch dent |
|---|---|---|---|---|---|
| 24857080 | Gaissabruecke (St 2125) | 25 | -4748, -1610 | 3.0 | deck back (gaissa fixture) |
| 24857078 | path beside it | 28 | -4749, -1617 | 3.3 | deck back (gaissa fixture) |
| 27663642 | Stockbauersteig | 11 | 1631, -1743 | 3.9 | expected back (not built) |
| 322490296 | Perlfischerweg | 8 | 1671, -957 | 2.3 | expected back (not built) |
| 9666821 | Fritz-Abelein-Bruecke | 13 | 1686, -887 | 1.1 | still missing: deck under 2 m over the water (deck rule) |
| 27663957 | Triftsperre | 28 | 1072, -1840 | 0.7 | still missing: walkway on a weir, 0.7 m over the water |
| 163931217 | path | 50 | -2212, 364 | -5.8 | still missing: the surface model 6 m under the terrain model there (not a deck problem; look) |
| 1113369109 | path | 3 | -2295, 396 | 8.1 | still missing: 3 m, another cause (look) |
