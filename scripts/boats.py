"""Boats on the rivers (viewer: web/src/sim/boats.ts) -> web/public/data/boats.json.

From OSM (data/raw/osm.json) and the river mask (data/ground.npz `water`):
- berths: where the Danube river-cruise ships moor, parallel to the old town's Danube quay (the south bank of the
  Danube, Zollände/Lindau to the Rathaus). OSM marks the berths there: "Passau Zollände" (seamark:berth), the pier
  "A14 Kreuzfahrtschiffe" and Liegestelle 3..8 (man_made=pier). The quay line is the edge of the water mask; slots of
  one ship length are laid along it from the west end of the Zollände berth to Liegestelle 3, leaving the excursion
  boats' piers (A12, Schiffanlegestelle Wurm+Noé) free. Each slot: centre, heading (bow upstream, west), and the
  unit normal pointing from the quay into the river (a second ship rafts alongside there, as in Passau's high season).
- tour: the Dreiflüsse-Stadtrundfahrt (OSM route=ferry, three ways), stitched into one loop that starts and ends at
  the Wurm+Noé pier: west up the Danube, back east past the old town, round the Dreiflüsseeck, up the Inn and back to
  the pier. Points outside the grid are dropped, points too near a bank are pushed out into the river, the loop is
  smoothed and resampled every 4 m.
Grid coordinates: x = column (east), y = row (south), as in traffic.json.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from osm import to_grid  # noqa: E402

OUT = Path("web/public/data")
z = np.load("data/ground.npz")
water = z["water"]
D, W = water.shape
lab, _ = ndimage.label(water)
river = lab == np.argmax(np.bincount(lab.ravel())[1:]) + 1
clear = ndimage.distance_transform_edt(river)  # metres to the nearest bank (0 on land)

els = json.load(open("data/raw/osm.json"))["elements"]
ways = {e["id"]: e for e in els if e["type"] == "way"}


def way_pts(i):
    return [to_grid(p["lon"], p["lat"]) for p in ways[i]["geometry"] if p]


def named_pier(name):
    for e in els:
        t = e.get("tags", {})
        if t.get("man_made") == "pier" and t.get("name", "").startswith(name):
            if e["type"] == "node":
                return to_grid(e["lon"], e["lat"])
            p = np.array(way_pts(e["id"]))
            return tuple(p.mean(axis=0))
    raise KeyError(name)


# ---------------------------------------------------------------- the quay and the cruise ships' berths
danube = np.array(sorted(p for e in els if e["type"] == "way" and e.get("tags", {}).get("name") == "Donau"
                         and e["tags"].get("waterway") == "river" for p in way_pts(e["id"])))
def quay_row(x):
    """the old town's Danube quay at column x: the south edge of the Danube channel"""
    col = river[:, int(x)]
    r = int(np.interp(x, danube[:, 0], danube[:, 1]))  # the Danube's OSM centre line
    assert col[r], x
    while col[r + 1]:
        r += 1
    return r + 1.0


x0 = min(p[0] for p in way_pts(next(e["id"] for e in els if e.get("tags", {}).get("seamark:berth:name") == "Passau Zollände")))
x1 = named_pier("Liegestelle 3")[0]
# the excursion boats' piers, and the quay east of them where the boats come in alongside
keep_free = [(named_pier("A12")[0] - 30, named_pier("Schiffanlegestelle Wurm")[0] + 160)]
for e in els:  # and the bridges over the quay's water (Schanzlbrücke): no ship under a deck
    t = e.get("tags", {})
    if e["type"] == "way" and t.get("bridge") not in (None, "no") and ("highway" in t or "railway" in t):
        p = [q for q in way_pts(e["id"]) if x0 - 20 < q[0] < x1 and abs(q[1] - quay_row(q[0])) < 60]
        if p and min(q[1] for q in way_pts(e["id"])) < min(q[1] for q in p) - 60:  # it crosses the river northwards
            keep_free.append((min(q[0] for q in p) - 15, max(q[0] for q in p) + 15))
            print("keep free under", t.get("name"), t.get("highway") or t.get("railway"), [round(v) for v in keep_free[-1]])
SHIP_L, SHIP_W, GAP = 135.0, 11.4, 12.0

berths = []
s = x0 + 5
while True:
    # walk along the quay one ship length (the bank runs ENE: measure along it)
    xs = [s]
    while True:
        a, b = xs[-1], xs[-1] + 1
        if math.hypot(b - xs[0], quay_row(b) - quay_row(xs[0])) >= SHIP_L or b > x1:
            break
        xs.append(b)
    e = xs[-1]
    if e > x1:
        break
    if any(e > lo and s < hi for lo, hi in keep_free):
        s = max(hi for lo, hi in keep_free if e > lo and s < hi) + 1
        continue
    q = np.array([(x, quay_row(x)) for x in np.arange(s, e + 1)])
    d = q[-1] - q[0]
    d /= np.linalg.norm(d)
    n = np.array([d[1], -d[0]])  # into the river (north of an eastward bank)
    # far enough out that no quay cell under the ship's length is within the half beam (+0.5 m fenders)
    off = max(float(np.dot(p - q[0], n)) for p in q) + SHIP_W / 2 + 0.5
    c = (q[0] + q[-1]) / 2 + n * off
    berths.append({"x": round(float(c[0]), 1), "y": round(float(c[1]), 1),
                   "dx": round(float(-d[0]), 4), "dy": round(float(-d[1]), 4),  # bow upstream (west)
                   "nx": round(float(n[0]), 4), "ny": round(float(n[1]), 4)})
    s = e + GAP
print(len(berths), "cruise-ship berths between columns", round(x0), "and", round(x1))

# ---------------------------------------------------------------- the excursion boats' loop
tour_ids = [1447820240, 1447820238, 1447820239]  # pier -> west; west -> east and up the Inn; Inn -> eck -> pier
loop = []
for i in tour_ids:
    p = way_pts(i)
    if loop and math.dist(loop[-1], p[0]) > math.dist(loop[-1], p[-1]):
        p = p[::-1]
    loop += p[1:] if loop else p
loop = [p for p in loop if 40 < p[0] < W - 40 and 40 < p[1] < D - 40]


def resample(pts, step):
    pts = np.array(pts)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    t = np.append(np.arange(0, cum[-1] - step / 2, step), cum[-1])
    return np.stack([np.interp(t, cum, pts[:, 0]), np.interp(t, cum, pts[:, 1])], axis=1)


def push_out(pts, need=14.0):
    """move points nearer than `need` metres to a bank out to the nearest cell that clear of the banks"""
    ok = np.argwhere(clear >= need)
    out = []
    for x, y in pts:
        if clear[int(y), int(x)] >= need:
            out.append((x, y))
            continue
        r, c = int(y), int(x)
        win = ok[(abs(ok[:, 0] - r) < 60) & (abs(ok[:, 1] - c) < 60)]
        j = np.argmin((win[:, 0] - r) ** 2 + (win[:, 1] - c) ** 2)
        out.append((win[j, 1] + 0.5, win[j, 0] + 0.5))
    return np.array(out)


pier = np.array(named_pier("Schiffanlegestelle Wurm"))
dock = pier + [0, -12.5]  # the boat lies along the pier's river side (north), bow west
pts = resample(loop, 4)
pts = push_out(pts)
for _ in range(3):  # smooth (the ends stay put)
    pts[1:-1] = (pts[:-2] + 2 * pts[1:-1] + pts[2:]) / 4
# the OSM ways end on the pier itself: drop their ends near it and come alongside straight, from the east
near = np.hypot(*(pts - pier).T) < 75
a, b = np.argmin(near), len(pts) - np.argmin(near[::-1])
pts = np.concatenate([[dock, dock - [25, 1]], pts[a:b], [dock + [70, 0], dock + [40, 0], dock]])
pts = resample(pts, 4)


def round_berths(pts, margin=9.0):
    """keep the loop off the moored ships (two abreast at most): points beside a berth move out into the river"""
    out = pts.copy()
    for b in berths:
        c, d, n = np.array([b["x"], b["y"]]), np.array([b["dx"], b["dy"]]), np.array([b["nx"], b["ny"]])
        rel = out - c
        along, across = rel @ d, rel @ n
        need = 2 * SHIP_W + 1.2 + SHIP_W / 2 + margin  # past the outer ship's side, from the inner ship's centre
        # full clearance beside the ship, easing in over 60 m before and after it
        w = np.clip((SHIP_L / 2 + 60 - np.abs(along)) / 60, 0, 1)
        lift = np.where((across > -SHIP_W) & (across < need), (need - across) * w, 0)
        out += lift[:, None] * n
    return out


for _ in range(3):
    pts[2:-2] = round_berths(pts[2:-2])
    for _ in range(4):
        pts[2:-6] = (pts[1:-7] + 2 * pts[2:-6] + pts[3:-5]) / 4  # the straight run in to the pier stays straight
pts = resample(pts, 4)
bad = [(round(x), round(y)) for x, y in pts if not river[int(y), int(x)]]
L = float(np.hypot(*np.diff(pts, axis=0).T).sum())
print(f"tour loop {L:.0f} m, {len(pts)} points, {len(bad)} on land", bad[:8])

json.dump({"berths": berths, "tour": [[round(float(x), 1), round(float(y), 1)] for x, y in pts]},
          open(OUT / "boats.json", "w"), separators=(",", ":"))
print("wrote", OUT / "boats.json")
