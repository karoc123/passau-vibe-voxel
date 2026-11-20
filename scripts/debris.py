"""Floating debris: small clumps of voxels hanging in the air (voxelize.py, patch.py).

Both passes judge a clump as a whole and only a clump spanning K metres or less across (debris pieces, wires, crown
fragments, a roof resting on crowns): such a clump is found in the box of the block of the project grid (B x B) that
holds its corner (its smallest row and column), the block grown by K (and a cell back), labelled there -- so it is
judged the same wherever the region it is built in starts (scripts/region.py). A bigger one is left as it is."""
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

import aoi


def _owned(vol, occ_of, st, B, K):
    """per block of the project grid over the volume (a region's, aoi.R0/C0), the connected pieces of occ_of(sub)
    whose corner lies in the block and that span K cells or less across: yields (zi, ri, ci) (the region's indices,
    z-major order) and, last, the number of bigger pieces left"""
    H, Dd, Ww = vol.shape
    n_big = 0
    for br in range((aoi.R0 // B) * B - aoi.R0, Dd, B):
        for bc in range((aoi.C0 // B) * B - aoi.C0, Ww, B):
            b0r, b1r, b0c, b1c = max(br, 0), min(br + B, Dd), max(bc, 0), min(bc + B, Ww)
            ra, rb, ca, cb = max(b0r - 1, 0), min(b1r + K + 1, Dd), max(b0c - 1, 0), min(b1c + K + 1, Ww)
            occ = occ_of(vol[:, ra:rb, ca:cb], (ra, rb, ca, cb))
            lab, k = ndimage.label(occ, st)
            if k == 0:
                continue
            for lid, sl in enumerate(ndimage.find_objects(lab), 1):
                if sl is None:
                    continue
                zs, rs, cs = sl
                r0_, c0_ = rs.start + ra, cs.start + ca
                if not (b0r <= r0_ < b1r and b0c <= c0_ < b1c):
                    continue  # (its corner in another block: that one judges it)
                if r0_ == ra and ra > 0 or c0_ == ca and ca > 0:
                    continue  # (reaches past the box's first row or column: its corner is further on)
                if rs.stop - rs.start > K + 1 or cs.stop - cs.start > K + 1:
                    n_big += 1
                    continue
                zi, ri, ci = np.nonzero(lab[sl] == lid)
                yield zi + zs.start, ri + r0_, ci + c0_
    yield n_big


def drop_debris(vol, g, keep_ids, note, max_size=100, B=128, K=64, dbg=Path("data/debug")):  # the stadium hub (135) stays
    """Delete small clumps of voxels that touch neither the ground nor anything that does (LiDAR returns off cranes,
    wires and canopy frames, leftovers of part cuts): 3D components (26-connected) spanning K m or less (see above); a
    clump is debris if it is smaller than max_size voxels and its lowest voxel is 2 m or more above the ground there."""
    n = nv = 0
    big, grounded = [], []
    st = ndimage.generate_binary_structure(3, 3)  # 26-connected: diagonal cables and wires are chains of corner-touching voxels
    keep = np.zeros(65536, bool)
    keep[np.asarray(keep_ids, np.int64)] = True
    zz = np.arange(vol.shape[0])[:, None, None]

    def occ_of(sub, box):
        ra, rb, ca, cb = box
        # the ground itself is one big component (leave it out); trees: crowns hang on trunks drawn apart, small
        # crowns are real
        return (sub != 0) & (zz >= g[ra:rb, ca:cb][None] - 1) & ~keep[sub]

    n_big = 0
    for item in _owned(vol, occ_of, st, B, K):
        if isinstance(item, int):
            n_big = item
            continue
        zi, ri, ci = item
        if len(zi) >= 4000:
            continue
        hz = zi - g[ri, ci]
        if hz.min() < 2:
            continue  # stands on the ground (bollards, benches, lamps)
        hmin = int(hz.min())
        if max_size <= len(zi) < 600 and zi.max() - zi.min() <= 8 and hmin >= 4:
            # a short footbridge's deck high in the canopy (a path over a forest brook at the map's edge: its
            # height profile took the crowns over it for the deck): set down as one piece until its lowest
            # voxel stands on the highest ground under it (a bank), spanning the dip (the brook) beside it
            drop = int(zi.min() - g[ri, ci].max())
            drop = drop if drop >= 1 else hmin  # (its low end already under the high bank: down onto the ground)
            v_ = vol[zi, ri, ci].copy()
            vol[zi, ri, ci] = 0
            vol[zi - drop, ri, ci] = v_
            grounded.append((int(ci.mean() + aoi.C0), int(ri.mean() + aoi.R0), drop, int(len(zi))))
            continue
        if len(zi) >= max_size:  # bigger floating clumps: listed for review (data/debug/floating.json)
            big.append(dict(x=int(ci.mean() + aoi.C0), y=int(ri.mean() + aoi.R0), z=hmin, n=int(len(zi)),
                            h=int(zi.max() - zi.min() + 1)))
            continue
        vol[zi, ri, ci] = 0
        n += 1; nv += len(zi)
    note(f"floating debris removed: {n} clumps, {nv} voxels; {len(big)} bigger floating clumps listed; flat clumps set "
         f"down onto the ground (x, y, drop, voxels): {grounded}; clumps over {K} m across left: {n_big}")
    dbg.mkdir(parents=True, exist_ok=True)
    json.dump(sorted(big, key=lambda b: -b["n"]), open(dbg / "floating.json", "w"))


LOG = []  # every fill and set of posts the support pass made (data/debug/supports.json)


def support_floating(vol, g, pal, bkind, note, trunk_id, post_id, trunk_ok=None, B=128, K=64, _noleaf=True,
                     dbg=Path("data/debug")):
    """Everything still hanging in the air at the end of the build (6-connected: walking and falling need face contact;
    pieces spanning K m or less, see above; `scripts/check.py verify` fails on any left) gets put on the ground or removed:
    - a piece under 12 voxels: removed (a LiDAR return off a wire, a lone sign voxel); a spike (<= 4 cells across,
      not leaves): removed
    - a crown fragment (leaves): under 60 voxels removed (an overhanging twig the LiDAR caught), bigger ones get a
      trunk from their lowest leaf straight down to the ground
    - a building piece: under its footprint, inside an OSM building outline (bkind 1), the walls carry on down to the
      ground in the colour of its lowest voxel; under a roof-only structure (bkind 2: building=roof, carport, canopy) or
      outside any outline, posts every 6 m (of the project grid) and at its four extreme cells
    - anything else (cable stays, cranes, the stadium's suspended hub): left, listed in data/debug/floating_left.json
    bkind: (D, W) uint8, 1 = inside a building outline, 2 = under a roof-only structure."""
    H, Dd, Ww = vol.shape
    mat = np.array([e[3] for e in pal.entries] + [0] * 64)
    solid = np.ones(len(pal.entries) + 64, bool)
    solid[0] = False
    if _noleaf:
        # first round: leaves hold nothing up -- a roof, a footbridge or a deck end that only touches a tree crown gets
        # its own walls or posts; only building pieces 2 m or more up are handled here, the rest in the second round
        # (a lamp on a hedge voxel or a trunk on scrub ground floats in this view but stands)
        solid = np.array([e[3] != 3 for e in pal.entries] + [False] * 64)
        solid[0] = False
    st = ndimage.generate_binary_structure(3, 1)

    def occ_of(sub, box):
        o = solid[sub]
        return o

    comps, n_big = [], 0
    for item in _owned(vol, occ_of, st, B, K):
        if isinstance(item, int):
            n_big = item
            continue
        zi, ri, ci = item
        if zi.min() == 0:
            continue  # the ground (the slab under everything) and what stands on it
        comps.append(item)
    stats = []
    for zi, ri, ci in comps:
        v = vol[zi, ri, ci]
        m = mat[v]
        hz = zi - g[ri, ci]
        okv = trunk_ok[ri, ci] if trunk_ok is not None else np.ones(len(zi), bool)
        pen = hz + np.where(okv, 0, 1000)
        j = int(np.argmin(pen))
        stats.append(dict(n=len(zi), hmin=int(hz.min()), low=(int(pen[j]), int(ri[j]), int(ci[j])),
                          cells=len(set((ri[:64] * Ww + ci[:64]).tolist())),
                          leaf=int(np.isin(m, (3,)).sum() + (v == trunk_id).sum()),
                          # building stuff only: walls, glass, roofs, concrete, floodlit stone, cladding, signs -- not
                          # plain solids or metal (cable stays, trunks, fences, masts), which must never be propped up
                          bld=int(np.isin(m, (1, 2, 7, 12, 13, 15, 16, 18, 19, 20, 21)).sum())))
    cls = []
    for s in stats:
        if _noleaf:
            hmin = min(s["low"][0] % 1000, s["hmin"])
            cls.append("build" if (s["bld"] >= 0.5 * s["n"] and s["n"] >= 12 and hmin >= 2) else "skip")
        elif s["n"] < 12:
            cls.append("drop")
        elif s["cells"] <= 4 and s["leaf"] < 0.5 * s["n"]:
            cls.append("drop")  # a spike: a column or two of LiDAR wall-edge returns standing over a lower roof"
        elif s["leaf"] >= 0.5 * s["n"]:
            cls.append("drop" if s["n"] < 60 or (s["low"][0] >= 1000 and s["n"] < 400) else "trunk")
        elif s["bld"] >= 0.5 * s["n"]:
            cls.append("build")
        else:
            cls.append("left")
    n_drop = n_fill = n_post = 0
    for (zi, ri, ci), c_ in zip(comps, cls):
        if c_ == "drop":
            vol[zi, ri, ci] = 0
            n_drop += len(zi)
    for (zi, ri, ci), c_ in zip(comps, cls):
        if c_ != "build":
            continue
        # lowest voxel of the piece in each column
        key = ri.astype(np.int64) * Ww + ci
        o = np.lexsort((zi, key))
        first = o[np.r_[True, np.diff(key[o]) != 0]]
        rows, cols, zs, vs = ri[first], ci[first], zi[first], vol[zi[first], ri[first], ci[first]]
        inside = bkind[rows, cols] == 1
        for r_, c_2, z_, v_ in zip(rows[inside], cols[inside], zs[inside], vs[inside]):
            col = vol[int(g[r_, c_2]):z_, r_, c_2]
            col[col == 0] = v_
            n_fill += 1
        if inside.any():
            LOG.append(dict(kind="fill", r=int(rows[inside].mean()) + aoi.R0, c=int(cols[inside].mean()) + aoi.C0,
                            n=int(inside.sum()), z=int(zs[inside].min())))
        out = ~inside
        if out.any():
            ro, co, zo = rows[out], cols[out], zs[out]
            pick = (((ro + aoi.R0) % 6) == 0) & (((co + aoi.C0) % 6) == 0)
            for e in (np.argmin(ro), np.argmax(ro), np.argmin(co), np.argmax(co)):
                pick[e] = True
            for r_, c_2, z_ in zip(ro[pick], co[pick], zo[pick]):
                col = vol[int(g[r_, c_2]):z_, r_, c_2]
                col[col == 0] = post_id
                n_post += 1
            LOG.append(dict(kind="posts", r=int(ro.mean()) + aoi.R0, c=int(co.mean()) + aoi.C0, n=int(pick.sum()),
                            z=int(zo.min()), cells=int(len(ro))))
    n_trunk = 0
    for s, c_ in zip(stats, cls):
        if c_ == "trunk":
            h, r_, c_2 = s["low"]
            h %= 1000
            gz = int(g[r_, c_2])
            col = vol[gz:gz + h, r_, c_2]
            col[col == 0] = trunk_id
            n_trunk += 1
    left = [dict(r=s["low"][1] + aoi.R0, c=s["low"][2] + aoi.C0, n=s["n"], leaf=s["leaf"], bld=s["bld"], low=s["low"][0])
            for s, c_ in zip(stats, cls) if c_ == "left"]
    if _noleaf:
        note(f"floating, leaves not holding: {cls.count('build')} building pieces resting only on crowns: {n_fill} "
             f"columns filled down, {n_post} posts; pieces over {K} m across left: {n_big}")
        return support_floating(vol, g, pal, bkind, note, trunk_id, post_id, trunk_ok, B, K, _noleaf=False, dbg=dbg)
    note(f"floating: {len(stats)} components; removed {n_drop} voxels; {n_trunk} crowns given a trunk; building pieces: "
         f"{n_fill} columns filled down inside outlines, {n_post} posts; {len(left)} left (listed); pieces over {K} m "
         f"across left: {n_big}")
    dbg.mkdir(parents=True, exist_ok=True)
    json.dump(sorted(left, key=lambda x: -x["n"]), open(dbg / "floating_left.json", "w"))
    json.dump(LOG, open(dbg / "supports.json", "w"))
