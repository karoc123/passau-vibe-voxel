"""What the pipeline's scripts share by value, in one place (docs/plans/code-health.md item 18).

Material ids: the fourth value of a palette entry (scripts/palette.json, voxelize.Palette), the same numbers as
web/src/core/materials.ts MAT. A palette entry's id is its index in the registry; these are what kind of surface it is.

Ground colours with a meaning: voxelize.py paints them (its palette C), caps.py finds paved ground, steps and a bare
deck by them (as web/src/core/materials.ts GROUND_COLOURS does). Both read them from here, so a colour changed in the
one is changed in the other.
"""
(M_SOLID, M_WALL, M_GLASS, M_LEAF, M_WATER, M_LAMP, M_METAL, M_FLOODLIT, M_GRASS, M_MARK, M_SOIL, M_CAR, M_ROOF,
 M_CONCRETE, M_CLOCK, M_BRONZE, M_SIGN, M_JET, M_SIGNBAND, M_RIBBON, M_CLASSIC, M_WINDOW, M_TENEMENT, M_WOOD,
 M_INTERIOR, M_INTERIOR_GLASS) = range(26)
# the wall materials (materials.ts WALL_MATS): a column's run of them is a building's wall (tiles.py, clearance.py)
WALL_MATS = (M_SOLID, M_WALL, M_GLASS, M_FLOODLIT, M_CONCRETE, M_BRONZE, M_RIBBON, M_CLASSIC, M_WINDOW, M_TENEMENT)

# the paved ground's colours (voxelize.C's keys; materials.ts GROUND_COLOURS: ballast among them, not paved)
SETT, ROAD_PAVING, PAVING, PAVING2, PLATFORM = "#8f8981", "#a49f97", "#c6c2b8", "#b5b4af", "#b7b1a6"
ASPHALT, ASPHALT_L, PARKING, CYCLE, GRAVEL = "#5f636b", "#6e7178", "#6a6d73", "#8a5a52", "#d8ccb5"
BALLAST, CONCRETE = "#8a8178", "#bdbab2"
GROUND_HEX = (SETT, ROAD_PAVING, PAVING, PAVING2, PLATFORM, ASPHALT, ASPHALT_L, PARKING, CYCLE, GRAVEL, BALLAST,
              CONCRETE)
KERB, STEPS, DECK = "#cfc7b8", "#a8a296", "#a7a49d"  # a kerb (paved), a flight of steps, a bridge's bare deck
