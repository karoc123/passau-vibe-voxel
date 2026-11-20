"""The rivers' water level per stretch, measured, for scripts/map.json's `rivers.stretches` (a map that spans the rivers'
fall: the Danube falls ~0.2-0.4 m per km round Passau, the Inn and the Ilz more; voxelize.py takes the rivers from the
terrain model within 0.8 m of the level, so a 30 km map needs a level per stretch).

Along each named river's OSM centre line (waterway=river) every STEP metres: the median of the terrain model (DGM1,
data/prep.npz) over the flat water cells within 20 m of the line (the laser sees the water surface on the survey
day), then the median per stretch of SPAN metres along the line. Prints each stretch's box (EPSG:25832, the box of
its part of the line grown by 150 m) and level, as JSON for map.json, and how far the stretches' levels lie from
rivers.level. Reads only; changes nothing.

usage: uv run python scripts/river_levels.py [--span METRES] [NAME ...]   (default: every named river on the map)
"""
import json
import sys

import numpy as np
from scipy import ndimage

import aoi
from osm import OSM

STEP, NEAR, GROW = 10.0, 20, 150


def main(argv):
    span = float(argv[argv.index("--span") + 1]) if "--span" in argv else 1000.0
    names = [a for i, a in enumerate(argv) if not a.startswith("-") and (i == 0 or argv[i - 1] != "--span")]
    osm = OSM(f"{aoi.RAW}/osm.json")
    lines = {}
    for _, t, ln in osm.lines_with("waterway", ("river",)):
        if t.get("name") and (not names or t["name"] in names):
            lines.setdefault(t["name"], []).append(ln)
    dtm = np.load("data/prep.npz")["dtm"]  # (the map's: 4 bytes a cell; a 30 km map would read it in row bands)
    out = []
    for name, lns in sorted(lines.items()):
        samples = []  # (distance along the river's pieces, x, y, level)
        at = 0.0
        for ln in sorted(lns, key=lambda l: l.coords[0]):
            for d in np.arange(0, ln.length, STEP):
                p = ln.interpolate(d)
                c, r = int(p.x), int(p.y)
                if not (NEAR <= r < aoi.MAP_D - NEAR and NEAR <= c < aoi.MAP_W - NEAR):
                    continue
                box = dtm[r - NEAR:r + NEAR, c - NEAR:c + NEAR]
                flat = (ndimage.maximum_filter(box, 5) - ndimage.minimum_filter(box, 5)) < 0.3
                if flat.sum() >= 50:
                    samples.append((at + d, p.x, p.y, float(np.median(box[flat]))))
            at += ln.length
        if not samples:
            continue
        s = np.array(samples)
        for k in range(int(s[:, 0].max() // span) + 1):
            m = (s[:, 0] >= k * span) & (s[:, 0] < (k + 1) * span)
            if m.sum() < 5:
                continue
            x0, y0 = aoi.to_world(s[m, 1].min() - GROW, s[m, 2].max() + GROW)
            x1, y1 = aoi.to_world(s[m, 1].max() + GROW, s[m, 2].min() - GROW)
            lv = round(float(np.median(s[m, 3])), 3)
            out.append(dict(river=name, box=[round(float(x0)), round(float(y0)), round(float(x1)), round(float(y1))], level=lv))
            print(f"{name} km {k * span / 1000:.1f}-{(k + 1) * span / 1000:.1f}: level {lv:.3f} m "
                  f"({lv - aoi.RIVER_LEVEL:+.2f} m from rivers.level {aoi.RIVER_LEVEL}), {int(m.sum())} samples", file=sys.stderr)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
