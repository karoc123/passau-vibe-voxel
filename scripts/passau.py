"""Passau's curated set pieces, on top of what DOM20 + OSM give (called from landmarks.details).

Grid columns below are for the cut of scripts/aoi.py (Dom at I0 = 1980); centres are read off the DOM20 surface model,
which stands ~3 m south-east of the OSM outlines here.
"""
import math

import numpy as np

CLASSIC, WINDOW, ROOF, METAL = 20, 21, 12, 6  # landmarks.MAT_IDS


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _cupola(vol, g, cy, cx, z0, R, drum, rise, mats, lantern=3, clear=None, fill_from=None):
    """An octagonal drum of half-width R from z0 (m over the ground at the centre) up `drum` m with a tall window in
    each main face, a copper dome over it rising `rise` m, a lantern and a gold cross. Everything the surface model
    left above z0 within `clear` m of the centre goes first (its dome was a stepped pyramid in the wall's colour)."""
    wall, win, copper, gold = mats
    g0 = int(g[int(cy), int(cx)])
    zb, zd = g0 + z0, g0 + z0 + drum
    clear = clear or R + 3
    n = 0
    for r in range(int(cy - clear) - 1, int(cy + clear) + 2):
        for c in range(int(cx - clear) - 1, int(cx + clear) + 2):
            dy, dx = r + 0.5 - cy, c + 0.5 - cx
            d = math.hypot(dx, dy)
            if d > clear:
                continue
            col = vol[:, r, c]
            col[zb:] = 0
            a, b = max(abs(dx), abs(dy)), min(abs(dx), abs(dy))
            if a <= R and a + b <= 1.42 * R:  # the octagon
                if fill_from is not None:  # no gap under the drum where the model's own drum was narrower
                    nz = np.nonzero(col[:zb])[0]
                    lo = max(int(nz[-1]) + 1 if len(nz) else g0 + fill_from, g0 + fill_from)
                    col[lo:zb] = wall
                col[zb:zd] = wall
                if a > R - 1 and b < 1.0 and drum >= 6:
                    col[zb + 2:zd - 2] = win
                n += 1
            for k in range(rise):
                if d <= R * math.sqrt(max(0.0, 1 - ((k + 0.3) / rise) ** 2)) + 0.3:
                    col[zd + k] = copper
            zl = zd + rise
            if d <= 1.5:
                col[zl - 1:zl + lantern] = wall
            if d <= 1.2:
                col[zl + lantern] = copper
            if d < 0.75:
                col[zl + lantern + 1] = copper
                col[zl + lantern + 2:zl + lantern + 4] = gold
    return g0, n


def dom(vol, g, pal, note):
    """Dom St. Stephan (Wikipedia; DOP20 2024; DOM20): white baroque, two west towers of 68 m -- square shafts to 45 m,
    an octagonal belfry and a green copper dome with a lantern each (1896) -- and the 69 m crossing dome on its octagonal
    drum over the gothic east end. The surface model has their masses, 6 m short and without the lanterns; OSM gives one
    wall and one roof colour for the whole church."""
    from aoi import I0
    dx = I0 - 1980
    mats = (pal(_hex("#ece7da"), CLASSIC), pal((44, 46, 50), WINDOW), pal(_hex("#7fa595"), ROOF, q=12), pal(_hex("#c9a24a"), METAL))
    for cy, cx in ((723.5, 1941.5), (764.5, 1938.5)):
        _cupola(vol, g, cy, cx + dx, z0=45, R=4.8, drum=10, rise=7, mats=mats, clear=8.5)
    _cupola(vol, g, 747.5, 2004.5 + dx, z0=48, R=7.5, drum=8, rise=9, mats=mats, lantern=4, clear=11.5, fill_from=36)
    note("Dom St. Stephan: two tower cupolas and the crossing dome rebuilt (copper, lanterns, crosses)")


def build(vol, g, pal, note):
    dom(vol, g, pal, note)
