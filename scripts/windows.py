"""What every building is, for its lit windows at night: its kind (residential, office, hotel, retail, public,
religious, other) and a per-building number the viewer turns into that building's own habits.

Kind from the OSM building tag, else from what the footprint or the points inside it are (office=*, tourism=hotel, shop,
amenity), else from the landuse around it.

Output web/public/data/windows.bin: gzip of uint8[buildings + 1], per building id of zones.py (the same buildings in
the same order; 0: none), kind in the low 3 bits, the building's number (0-31) in the high 5. The viewer looks it up by
the building each face carries (voxelMaterial.ts building()); tile_fields.py by each column's building, for the light
the windows spill on the street.
"""
import gzip
from collections import Counter
from pathlib import Path

import numpy as np
from shapely.strtree import STRtree

from osm import OSM, lod2_only_ids

OUT = Path(__file__).resolve().parent.parent / "web/public/data/windows.bin"
KINDS = ["none", "residential", "office", "hotel", "retail", "public", "religious", "other"]
BY_TAG = {
    "residential": {"apartments", "residential", "house", "detached", "semidetached_house", "terrace", "dormitory"},
    "office": {"office", "commercial"},
    "hotel": {"hotel"},
    "retail": {"retail", "supermarket", "kiosk", "mall"},
    "public": {"government", "public", "civic", "university", "school", "college", "kindergarten", "hospital", "museum",
               "theatre", "palace", "train_station", "transportation", "library"},
    "religious": {"church", "cathedral", "chapel", "religious", "synagogue", "mosque"},
}
TAG = {v: k for k, vs in BY_TAG.items() for v in vs}
PUBLIC_AMENITY = {"university", "school", "college", "hospital", "townhall", "courthouse", "library", "theatre",
                  "arts_centre", "kindergarten", "police", "embassy"}


def kind_of(t, inside, landuse):
    k = TAG.get(t.get("building"))
    if k:
        return k
    for tags in [t, *inside]:
        if tags.get("tourism") in ("hotel", "hostel", "apartment"):
            return "hotel"
        if tags.get("amenity") == "place_of_worship":
            return "religious"
        if tags.get("amenity") in PUBLIC_AMENITY or tags.get("office") in ("government", "diplomatic"):
            return "public"
    if any("office" in tags for tags in [t, *inside]):
        return "office"
    if t.get("shop") or t.get("building") == "yes" and inside and all("shop" in x for x in inside):
        return "retail"
    return {"residential": "residential", "commercial": "office", "retail": "retail"}.get(landuse, "other")


def main():
    osm = OSM()
    blds = [(g, t, oid) for oid, _, t, g in osm.areas
            if t.get("building") not in (None, "no") and "building:part" not in t and t.get("location") != "underground"]
    blds.sort(key=lambda b: -b[0].area)
    pts = [(t, p) for _, t, p in osm.nodes if any(k in t for k in ("office", "shop", "amenity", "tourism"))]
    ptree = STRtree([p for _, p in pts])
    uses = [(t["landuse"], g) for _, _, t, g in osm.areas if t.get("landuse")]
    utree = STRtree([g for _, g in uses])
    count = Counter()
    vals = {}
    for i, (g, t, oid) in enumerate(blds):
        inside = [pts[j][0] for j in ptree.query(g, predicate="contains")]
        c = g.representative_point()
        lu = next((uses[j][0] for j in utree.query(c, predicate="within")), None)
        k = kind_of(t, inside, lu)
        count[k] += g.area
        habit = (i * 2654435761 >> 7) % 32
        vals[oid] = KINDS.index(k) | habit << 3
    # the buildings as zones.py numbers them: blds in this order, then those from LoD2 alone (footprints.npz)
    n_extra = len(lod2_only_ids())  # (their ids only: no raster of the map)
    table = np.zeros(len(blds) + n_extra + 1, np.uint8)
    for i, (g, t, oid) in enumerate(blds):
        table[i + 1] = vals[oid]
    for k in range(n_extra):
        table[len(blds) + 1 + k] = KINDS.index("other") | ((len(blds) + k) * 2654435761 >> 7) % 32 << 3
    OUT.write_bytes(gzip.compress(table.tobytes(), mtime=0))
    total = sum(count.values())
    print({k: f"{v / total:.0%}" for k, v in count.most_common()}, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
