# Building looks: windows that break, houses that differ

A concept to decide before landmark work. Numbers are measured on the committed data unless marked "est.".

## Today, and why broken blocks get windows

A house is a solid block of one palette id from base to roof (21.7 M voxels of the two house materials, wall and
tenement). A voxel carries nothing but its palette id (a run is z0, length, id); a column adds ground, roof plane
and building id. Windows are not data: the fragment shader paints them on every vertical face of those two
materials, from the face's place along the wall, its height over the street and a hash of the building id. A crater
exposes the fill, the fill is the same material, its new faces are vertical, so they get windows, sills and night
light. The cathedral shows the other way already: its windows are voxels of a window material, and a uniform tells
the shader to paint none there.

What a building can differ by today: wall colour, roof colour, three materials, and two hashed numbers (axis 3 or
4 m, storey 3.3-3.7 m). 14 370 buildings; the palette uses 1 026 of 65 535 ids. Open data per building: LoD2 roof
type and heights for all; OSM (12 847 buildings) has a type for 32 %, levels 27 %, wall colour 16 %, roof colour
16 %, material 40, year 6. No year of construction in open data; ALKIS/LoD2 function is not read yet.

Level 1 now: 2 571 nodes, 44.9 MB (runs 10.1 MB of it), 56 M triangles; 5.0 M facade faces. Densest node (59_21, old
town): 22.7 k facade faces, 54 kB; no node has more than 83 k triangles.

## Options

| | A. Paint stays, breaks hidden | B. Painted style per building | C. Windows and doors as voxels |
|---|---|---|---|
| Idea | a crater repaints its rim as masonry; nothing else changes | A, plus a style record per building the shader reads by building id | the pipeline stamps window and door voxels into the shell from the style record; the shader details a pane only inside its own voxel |
| Breaks properly | broken faces yes; a pane is still paint, cut in half at a hole | as A | yes: a pane is a voxel, can be shot out alone |
| Houses differ | no | yes: axes, storeys, ground floor (shop, door, plain), window shape, surround | yes, same record, and visible in the geometry |
| Interiors later | a carved room has painted windows on a wall nobody sees through | as A | fits: rooms (already in the format) get their daylight through the same voxels |
| Pipeline | none | the windows sidecar grows to ~8 B per building (~115 kB raw, loaded once) | B, plus stamping; coarser levels built with windows filled (as rooms are) and painted from the record; full rebuild |
| Tile format | none | none | none (window material exists; 20-30 appended palette ids) |
| Page | crater op, 4 appended masonry ids | A, plus shader reads the record (the fetch exists for night light) | B, plus pane detail per voxel; the cathedral's exception goes |
| Bytes | 0 | +115 kB once | level 1 est. +1.1 M runs, +1-2 MB (2-5 %) |
| Frame time | 0 | ~0 (est.) | est. +7 % triangles on the map, up to +30 % in the densest old-town nodes; the triangle budget holds the frame, fewer fine nodes fit it |
| Landmarks | hand-built voxel windows plus a "paint none here" exception each | style "none" per landmark, voxel windows by parts | ordinary buildings with hand-placed parts; no exception |

Not offered: sub-metre bricks (reserved in the format): finest look, but a new section, mesher and edit path.

Known trap for C: the old town once had 1 m voxel windows and lost them, because they stepped along diagonal walls.
C keeps the shader's filtering and its wall-plane coordinate; only where a window is comes from the voxels.

## Recommendation: B now, C for the houses near the street, in three steps

1. **Week 1, playable, no rebuild (A + the start of B).** A crater paints the wall voxels of its rim with one of four
   masonry ids before carving (derived where the op is applied, so nothing new on the wire). The sidecar gets the
   style record from OSM type, levels, LoD2 height and roof type; the shader takes axis, storey height and ground
   floor from it. Result: a shot house shows brick, and a villa, a block of flats and an old-town house look
   different.
2. **Voxel windows in one region** (old town), built as a region, not the map: measure real bytes, triangles and
   frame time on a phone against the estimates above, and look at diagonal walls. Then the owner decides the rebuild.
3. **Rooms** behind chosen ground floors and in landmarks, with the rooms the pipeline already knows. Landmarks
   start after step 2.

Gates: (1) crater a facade in a fixture, mesh the node: no face within the rim carries a house material, and none
has night light. (2) From step 2: level-1 bytes and triangles of the region within 5 % and 30 % of today's, and the
coarser levels byte-identical to a build without windows.

## Owner's questions

1. Windows snapped to the metre grid (1 x 2 m openings, frames drawn finer inside): good enough, or do you want
   finer than a metre? (Finer means bricks: months, not weeks.)
2. Walkable: every house, or chosen ones (landmarks, shops, a few per street)? Recommend chosen; every house is
   hollowing 21.7 M voxels and is not costed here.
3. Step 2 needs a full data rebuild once it has passed: may that be planned?
