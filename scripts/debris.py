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
from constants import M_LEAF


def _owned(vol, occ_of, st, B, K, floor=False):
    """per block of the project grid over the volume (a region's, aoi.R0/C0), the connected pieces of occ_of(sub)
    whose corner lies in the block and that span K cells or less across: yields (zi, ri, ci) (the region's indices,
    z-major order) and, last, the number of bigger pieces left.
    Only the layers that can hold a piece are labelled: none above the box's last voxel; below, none of the leading
    empty layers of occ, and of its leading full layers (the slab) all but the last -- that one is a single sheet,
    joined to the layers under it, so a piece touches it exactly when it is the piece holding the first layer, and
    every other piece is the same. floor: that piece (the ground and what stands on it) is not yielded where the
    slab was cut (the caller skips a piece starting at layer 0 itself where it was not)"""
    H, Dd, Ww = vol.shape
    n_big = 0
    for br in range((aoi.R0 // B) * B - aoi.R0, Dd, B):
        for bc in range((aoi.C0 // B) * B - aoi.C0, Ww, B):
            b0r, b1r, b0c, b1c = max(br, 0), min(br + B, Dd), max(bc, 0), min(bc + B, Ww)
            ra, rb, ca, cb = max(b0r - 1, 0), min(b1r + K + 1, Dd), max(b0c - 1, 0), min(b1c + K + 1, Ww)
            sub = vol[:, ra:rb, ca:cb]
            used = np.flatnonzero(sub.any((1, 2)))
            if not len(used):
                continue
            occ = occ_of(sub[:used[-1] + 1], (ra, rb, ca, cb))
            lay = occ.reshape(occ.shape[0], -1)
            filled = lay.any(1)
            if not filled.any():
                continue
            e = int(np.argmax(filled))  # leading empty layers
            f = 0 if e else int(np.argmin(lay.all(1))) if not lay.all() else occ.shape[0]  # leading full ones
            z0 = e if e else max(f - 1, 0)
            top = len(filled) - int(np.argmax(filled[::-1]))  # (and none of its empty layers on top)
            lab, k = ndimage.label(occ[z0:top], st)
            if k == 0:
                continue
            for lid, sl in enumerate(ndimage.find_objects(lab), 1):
                if sl is None:
                    continue
                zs, rs, cs = sl
                cut_floor = floor and z0 > 0 and e == 0 and zs.start == 0
                zs = slice(zs.start + z0, zs.stop + z0)
                r0_, c0_ = rs.start + ra, cs.start + ca
                if not (b0r <= r0_ < b1r and b0c <= c0_ < b1c):
                    continue  # (its corner in another block: that one judges it)
                if r0_ == ra and ra > 0 or c0_ == ca and ca > 0:
                    continue  # (reaches past the box's first row or column: its corner is further on)
                if rs.stop - rs.start > K + 1 or cs.stop - cs.start > K + 1:
                    n_big += 1
                    continue
                if cut_floor:
                    continue  # (the ground: see floor)
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
        return (sub != 0) & (zz[:sub.shape[0]] >= g[ra:rb, ca:cb][None] - 1) & ~keep[sub]

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


def _piece_stats(comps, vol, g, mat, trunk_ok, trunk_id):
    """support_floating's numbers per piece, all pieces at once (tens of thousands in its first round: a loop of numpy
    calls per piece was a third of the pass): its size, lowest voxel over the ground, its lowest voxel where a trunk may
    stand (low: + 1000 to the height where none may; the first such voxel in the piece's order), leaf and building
    voxels"""
    if not comps:
        return []
    n_ = np.array([len(c[0]) for c in comps], np.int64)
    st0 = np.concatenate([[0], np.cumsum(n_)[:-1]]).astype(np.int64)
    zi, ri, ci = (np.concatenate([c[k] for c in comps]) for k in range(3))
    v = vol[zi, ri, ci]
    m = mat[v]
    hz = zi - g[ri, ci]
    pen = hz + np.where(trunk_ok[ri, ci], 0, 1000) if trunk_ok is not None else hz
    j_ = np.lexsort((pen, np.repeat(np.arange(len(comps)), n_)))[st0]  # (a stable sort: the first lowest, as argmin)
    # building stuff only: walls, glass, roofs, concrete, floodlit stone, cladding, signs -- not plain solids or metal
    # (cable stays, trunks, fences, masts), which must never be propped up
    is_bld = np.zeros(max(int(mat.max()) + 1, 22), bool)
    is_bld[[1, 2, 7, 12, 13, 15, 16, 18, 19, 20, 21]] = True
    hmin_, bld_ = np.minimum.reduceat(hz, st0), np.add.reduceat(is_bld[m].astype(np.int64), st0)
    leaf_ = np.add.reduceat((m == 3).astype(np.int64), st0) + np.add.reduceat((v == trunk_id).astype(np.int64), st0)
    return [dict(n=int(n_[k]), hmin=int(hmin_[k]), low=(int(pen[j_[k]]), int(ri[j_[k]]), int(ci[j_[k]])),
                 leaf=int(leaf_[k]), bld=int(bld_[k])) for k in range(len(comps))]


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
        solid = np.array([e[3] != M_LEAF for e in pal.entries] + [False] * 64)
        solid[0] = False
    st = ndimage.generate_binary_structure(3, 1)

    def occ_of(sub, box):
        # (the second round: every id but 0, as solid says, by a comparison instead of a gather through the table)
        return solid[sub] if _noleaf else sub != 0

    comps, n_big = [], 0
    for item in _owned(vol, occ_of, st, B, K, floor=True):
        if isinstance(item, int):
            n_big = item
            continue
        zi, ri, ci = item
        if zi[0] == 0:  # (zi ascends: np.nonzero in z-major order)
            continue  # the ground (the slab under everything) and what stands on it
        comps.append(item)
    stats = _piece_stats(comps, vol, g, mat, trunk_ok, trunk_id)
    cls = []
    for (_, ri, ci), s in zip(comps, stats):
        if not _noleaf and s["n"] >= 12:
            s["cells"] = len(set((ri[:64] * Ww + ci[:64]).tolist()))
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
        del comps, stats  # (not held through the second round)
        return support_floating(vol, g, pal, bkind, note, trunk_id, post_id, trunk_ok, B, K, _noleaf=False, dbg=dbg)
    note(f"floating: {len(stats)} components; removed {n_drop} voxels; {n_trunk} crowns given a trunk; building pieces: "
         f"{n_fill} columns filled down inside outlines, {n_post} posts; {len(left)} left (listed); pieces over {K} m "
         f"across left: {n_big}")
    dbg.mkdir(parents=True, exist_ok=True)
    json.dump(sorted(left, key=lambda x: -x["n"]), open(dbg / "floating_left.json", "w"))
    json.dump(LOG, open(dbg / "supports.json", "w"))
