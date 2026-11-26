"""What the pipeline's scripts share by value, in one place.

Material ids: the fourth value of a palette entry (scripts/palette.json, voxelize.Palette), the same numbers as
web/src/core/materials.ts MAT. A palette entry's id is its index in the registry; these are what kind of surface it is.

Ground classes: what a cell's ground is (data/ground.npz cls, the class raster voxelize.py writes from the entries it
painted the ground with, by name; caps.py reads it). No step after voxelize.py reads a meaning from a colour.
"""
(M_SOLID, M_WALL, M_GLASS, M_LEAF, M_WATER, M_LAMP, M_METAL, M_FLOODLIT, M_GRASS, M_MARK, M_SOIL, M_CAR, M_ROOF,
 M_CONCRETE, M_CLOCK, M_BRONZE, M_SIGN, M_JET, M_SIGNBAND, M_RIBBON, M_CLASSIC, M_WINDOW, M_TENEMENT, M_WOOD,
 M_INTERIOR, M_INTERIOR_GLASS) = range(26)
# the wall materials (materials.ts WALL_MATS): a column's run of them is a building's wall (tiles.py, clearance.py)
WALL_MATS = (M_SOLID, M_WALL, M_GLASS, M_FLOODLIT, M_CONCRETE, M_BRONZE, M_RIBBON, M_CLASSIC, M_WINDOW, M_TENEMENT)

# the ground's colours (voxelize.C's; web/src/core/materials.ts GROUND_COLOURS shades the paved ones by them)
SETT, ROAD_PAVING, PAVING, PAVING2, PLATFORM = "#8f8981", "#a49f97", "#c6c2b8", "#b5b4af", "#b7b1a6"
ASPHALT, ASPHALT_L, PARKING, CYCLE, GRAVEL = "#5f636b", "#6e7178", "#6a6d73", "#8a5a52", "#d8ccb5"
BALLAST, CONCRETE = "#8a8178", "#bdbab2"
KERB, STEPS, DECK = "#cfc7b8", "#a8a296", "#a7a49d"  # a kerb (paved), a flight of steps, a bridge's bare deck

# the ground classes (data/ground.npz cls, uint8; 0: none of these). 1-6 are materials.ts GROUND's numbers
(CLS_NONE, CLS_SETT, CLS_SLAB, CLS_ASPHALT, CLS_ROADSETT, CLS_GRAVEL, CLS_CONCRETE, CLS_BALLAST, CLS_KERB, CLS_MARK,
 CLS_STEPS, CLS_DECK) = range(12)
# paved: what is walked and driven on, capped on a slope (caps.py) -- not the railway's ballast, not steps
CLS_PAVED = (CLS_SETT, CLS_SLAB, CLS_ASPHALT, CLS_ROADSETT, CLS_GRAVEL, CLS_CONCRETE, CLS_KERB, CLS_MARK)
# the class of the ground where its top voxel is voxelize.C[key] (each key painted in its colour above, KEY.upper(),
# plain M_SOLID but the deck's M_CONCRETE); every M_MARK entry is CLS_MARK, any other CLS_NONE
GROUND_CLASSES = {"sett": CLS_SETT, "road_paving": CLS_ROADSETT, "paving": CLS_SLAB, "paving2": CLS_SLAB,
                  "platform": CLS_SLAB, "asphalt": CLS_ASPHALT, "asphalt_l": CLS_ASPHALT, "parking": CLS_ASPHALT,
                  "cycle": CLS_ASPHALT, "gravel": CLS_GRAVEL, "concrete": CLS_CONCRETE, "ballast": CLS_BALLAST,
                  "kerb": CLS_KERB, "steps": CLS_STEPS, "deck": CLS_DECK}
