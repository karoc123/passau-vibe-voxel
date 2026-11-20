"""Large features decided whole: a lawn, a car park or an untagged path that spans region.FMAX metres or more was
decided block by block (region.feature_parts: a long forest track went gravel, earth, gravel along its length as the
orthophoto under each 128 m block had it). Now it is decided once, over its whole outline, the same in every region,
however far it reaches: a feature pass (scripts/regions.py) has every region count, over the cells of its core, what decides each
large feature it holds; the counts are added up over the regions (an exact sum: the cores partition the map) and each
feature's decision is made from its totals (data/cache/features.json), which the regions then look up.

A decision over a whole outline is made from counts, not medians (a median does not add up over regions): "the
median of x over the cells is above t" becomes "more than half of the cells have x above t". Features under FMAX keep
voxelize.py's medians over their own cells, as before.

KINDS: per kind, the counts over cells (rows, cols, the rasters voxelize.py has at the decision: exg, lum, nd_mean)
and the decision from their totals.
"""
import numpy as np


def _lawn_counts(r, c, exg, lum, nd_mean):
    return [len(r), int((exg[r, c] < 0).sum()), int((lum[r, c] > 120).sum())]


def _lawn(n, dark, bright):  # (voxelize._lawn: a lawn the ortho sees paved over is paving)
    return "paving2" if n >= 30 and 2 * dark > n and 2 * bright > n else "grass"


def _car_park_counts(r, c, exg, lum, nd_mean):
    return [len(r), int((lum[r, c] > 150).sum())]


def _car_park(n, pale):  # (voxelize._car_park: the 60th percentile of the luminance over 150)
    return "paving2" if n >= 20 and 10 * pale > 4 * n else "parking"


def _way_counts(r, c, exg, lum, nd_mean):
    return [len(r), int((exg[r, c] > 0.03).sum()), int((nd_mean[r, c] > 2.5).sum()), int((lum[r, c] > 150).sum())]


def _way(n, green, canopy, pale):  # (voxelize: an untagged path or track: earth where green, gravel or paving)
    if n and (2 * green > n or 2 * canopy > n):
        return "dirt"
    return "paving" if n and 2 * pale > n else "gravel"


KINDS = {"lawn": (_lawn_counts, _lawn), "car_park": (_car_park_counts, _car_park), "way": (_way_counts, _way)}


def counts(kind, r, c, exg, lum, nd_mean):
    return KINDS[kind][0](np.asarray(r), np.asarray(c), exg, lum, nd_mean)


def merge(per_region):
    """[{fid: [kind, counts]}] of the regions -> {fid: decision}"""
    tot = {}
    for st in per_region:
        for fid, (kind, cnt) in st.items():
            k, a = tot.setdefault(fid, [kind, [0] * len(cnt)])
            assert k == kind, fid
            for i, v in enumerate(cnt):
                a[i] += v
    return {fid: KINDS[kind][1](*cnt) for fid, (kind, cnt) in sorted(tot.items())}
