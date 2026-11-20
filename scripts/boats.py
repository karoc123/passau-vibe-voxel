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
On a partial map (a check fixture, scripts/check.py) a part whose feature is off the map is left out with a note:
no quay -> no berths, no pier -> an empty tour, either -> no fairway (boats.ts takes it as optional).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from osm import to_grid  # noqa: E402
import aoi  # noqa: E402

OUT = Path("web/public/data")
z = np.load("data/ground.npz")
water = z["water"]
D, W = water.shape
lab, _ = ndimage.label(water)
# the largest water body (none on a partial map without water: a check fixture)
river = lab == np.argmax(np.bincount(lab.ravel())[1:]) + 1 if lab.max() else np.zeros_like(water, bool)
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
    if not 0 <= r < D - 1:
        raise IndexError(f"the Danube's centre line at column {x} is off the map")
    assert col[r], x
    while col[r + 1]:
        r += 1
    return r + 1.0


x0 = min(p[0] for p in way_pts(next(e["id"] for e in els if e.get("tags", {}).get("seamark:berth:name") == "Passau Zollände")))
x1 = named_pier("Liegestelle 3")[0]
SHIP_L, SHIP_W, GAP = 135.0, 11.4, 12.0


def quay_in_map():
    """whether the old town's Danube quay (x0..x1) lies on this map: a partial map (a check fixture) may miss it"""
    if not river.any() or not len(danube) or x0 - 20 < 0 or x1 + 2 > W:
        return False
    try:  # (its ends: the berths' walk starts and ends there)
        quay_row(x0 + 5)
        quay_row(x1)
    except (IndexError, AssertionError):
        return False
    return True


berths = []
if not quay_in_map():
    print("note: the old town's Danube quay (the cruise ships' berths) is not on this map: no berths, no fairway")
else:
    # the excursion boats' piers, and the quay east of them where the boats come in alongside
    keep_free = [(named_pier("A12")[0] - 30, named_pier("Schiffanlegestelle Wurm")[0] + 160)]
    for e in els:  # and the bridges over the quay's water (Schanzlbrücke): no ship under a deck
        t = e.get("tags", {})
        if e["type"] == "way" and t.get("bridge") not in (None, "no") and ("highway" in t or "railway" in t):
            p = [q for q in way_pts(e["id"]) if x0 - 20 < q[0] < x1 and abs(q[1] - quay_row(q[0])) < 60]
            if p and min(q[1] for q in way_pts(e["id"])) < min(q[1] for q in p) - 60:  # it crosses the river northwards
                keep_free.append((min(q[0] for q in p) - 15, max(q[0] for q in p) + 15))
                print("keep free under", t.get("name"), t.get("highway") or t.get("railway"), [round(v) for v in keep_free[-1]])

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
pier = np.array(named_pier("Schiffanlegestelle Wurm"))
tour_ok = bool(river.any()) and len(loop) >= 2 and 40 < pier[0] < W - 40 and 40 < pier[1] < D - 40
if not tour_ok:
    print("note: the Dreiflüsse tour's pier (Schiffanlegestelle Wurm) or its route is not on this map: no tour")
    pts = []
else:
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


    def keep_right(pts, sep=22.0, rounds=6):
        """where the loop comes back along itself (out and back up the Danube, round the Eck, up the Inn and back) its two
        runs lay within a few metres: boats meeting there passed through each other. Each run moves to its own starboard
        side, so they pass port to port ~`sep` apart; where the loop crosses itself it still crosses (the timetable keeps
        the boats apart there, checked below). The ends at the pier stay put."""
        pts = pts.copy()
        for _ in range(rounds):
            d = np.gradient(pts, axis=0)
            d /= np.linalg.norm(d, axis=1, keepdims=True)
            right = np.stack([-d[:, 1], d[:, 0]], axis=1)  # grid y points south: (-dy, dx) is starboard
            cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
            push = np.zeros(len(pts))
            for i in range(30, len(pts) - 30):
                far = np.abs(cum - cum[i]) > 300
                gap = np.hypot(*(pts[far] - pts[i]).T)
                j = np.argmin(gap)
                if gap[j] < sep and float(np.dot(d[i], d[far][j])) < -0.7:  # running the other way
                    push[i] = (sep - gap[j]) / 2
            push = ndimage.uniform_filter1d(ndimage.maximum_filter1d(push, 9), 15)
            moved = pts + right * push[:, None]
            ok = clear[moved[:, 1].astype(int), moved[:, 0].astype(int)] >= 9
            pts = np.where(ok[:, None], moved, pts)
        return pts


    pts = resample(keep_right(pts), 4)
    bad = [(round(x), round(y)) for x, y in pts if not river[int(y), int(x)]]
    L = float(np.hypot(*np.diff(pts, axis=0).T).sum())
    print(f"tour loop {L:.0f} m, {len(pts)} points, {len(bad)} on land", bad[:8])

    # the timetable (boats.ts: departures every 30 or 60 min, 2.8 m/s, ramps of 0.06 m/s²): two boats on the loop at once
    # must not come within a boat's length of each other away from the pier
    V, ACC = 2.8, 0.06
    cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    ramp = V / ACC
    T = (L - V * ramp) / V + 2 * ramp
    def s_at(t):
        u = T - t
        return np.clip(np.where(t < ramp, 0.5 * ACC * t * t, np.where(u < ramp, L - 0.5 * ACC * u * u, 0.5 * ACC * ramp * ramp + V * (t - ramp))), 0, L)
    def pos(s):
        return np.stack([np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])], axis=1)
    for gap in (1800, 3600):
        t = np.arange(0, T - gap, 1.0)
        if not len(t):
            continue
        sa, sb = s_at(t + gap), s_at(t)
        dist = np.hypot(*(pos(sa) - pos(sb)).T)
        away = (sb > 150) & (sa < L - 150)
        print(f"boats {gap // 60} min apart: closest {dist[away].min():.0f} m" if away.any() else f"boats {gap // 60} min apart never meet")

# ---------------------------------------------------------------- the cruise ships' fairway
# Two lanes along the Danube, from the grid's west edge to its east edge: `up` (westbound, upstream, on the old town's
# side, clear of the moored ships two abreast and of the excursion boats at their pier) and `down` (eastbound, on the
# far side). A ship bound downstream from the quay turns in the wide reach above the old town (`turn_w`, up -> down);
# one arriving from upstream turns in the Dreiflüsseeck's basin below it (`turn_e`, down -> up) to come in bow upstream.
if not (berths and tour_ok):
    print("note: no berths or no tour pier on this map: no cruise-ship fairway")
else:
    def channel(x):
        """the Danube at column x: OSM centre row, north and south bank rows"""
        col = river[:, int(x)]
        r = int(np.interp(x, danube[:, 0], danube[:, 1]))
        a = b = r
        while a > 0 and col[a - 1]:
            a -= 1
        while b < D - 1 and col[b + 1]:
            b += 1
        return r, a, b


    # the obstacles on the south side: moored cruise ships (two abreast) and the excursion pier's raft of three
    south_ob = []
    for b in berths:
        c, d, n = np.array([b["x"], b["y"]]), np.array([b["dx"], b["dy"]]), np.array([b["nx"], b["ny"]])
        for k in np.linspace(-SHIP_L / 2, SHIP_L / 2, 28):
            south_ob.append(c + d * k + n * (SHIP_W * 1.5 + 1.2))  # the outer ship's river side
    for k in np.linspace(-25, 25, 11):
        south_ob.append(dock + [k, -3 * 9.0 + 4])
    south_ob = np.array(south_ob)
    xs = np.arange(4.0, W - 4.0, 8.0)
    up, down = [], []
    for x in xs:
        r, a, b = channel(x)
        mid = (a + b) / 2 if b - a < 200 else r  # the confluence below the Eck: the Danube's own line, not the Inn's mouth
        half = min(24.0, (b - a) * 0.17)
        yu, yd = mid + half, mid - half
        up.append((x, yu))
        down.append((x, yd))
    up, down = np.array(up), np.array(down)
    north = np.array([channel(x)[1] + SHIP_W / 2 + 10 for x in xs])  # the down lane's own bank
    # a ship on the up lane passes the moored ones along its whole length: the lane stays clear of anything within half a
    # ship's length either side
    cap = np.array([min([y - SHIP_W / 2 - 10 for x0, y in south_ob if abs(x0 - x) < SHIP_L / 2 + 30], default=1e9) for x in xs])
    for k in range(30):
        up[:, 1] = np.minimum(up[:, 1], cap)
        down[:, 1] = np.maximum(np.minimum(down[:, 1], up[:, 1] - 34), np.minimum(north, up[:, 1] - 14))
        if k < 29:
            up[1:-1, 1] = (up[:-2, 1] + 2 * up[1:-1, 1] + up[2:, 1]) / 4
            down[1:-1, 1] = (down[:-2, 1] + 2 * down[1:-1, 1] + down[2:, 1]) / 4
    up = up[::-1]  # westbound: from the east edge


    def u_turn(frm, to, centre, cw):
        """a half turn about `centre` from the lane point `frm` to `to` (its radius easing from one to the other)"""
        a0 = math.atan2(frm[1] - centre[1], frm[0] - centre[0])
        a1 = math.atan2(to[1] - centre[1], to[0] - centre[0])
        if cw:
            a1 = a1 if a1 > a0 else a1 + 2 * math.pi
        else:
            a1 = a1 if a1 < a0 else a1 - 2 * math.pi
        rr = np.hypot(*(np.array(frm) - centre)), np.hypot(*(np.array(to) - centre))
        k = np.linspace(0, 1, 40)
        rad = rr[0] + (rr[1] - rr[0]) * k
        ang = a0 + (a1 - a0) * k
        return np.stack([centre[0] + rad * np.cos(ang), centre[1] + rad * np.sin(ang)], axis=1)


    def lane_at(lane, x):
        return int(np.argmin(np.abs(lane[:, 0] - x)))


    # turn_e: eastbound (north lane) into the basin, round clockwise (grid y south: east -> south -> west), back west on
    # the up lane; turn_w: westbound, round clockwise (west -> north -> east)
    # (the turns' places are project grid columns, X(): the map's columns)
    X = lambda c: c - aoi.MAP_C0  # noqa: E731
    ie_d, ie_u = lane_at(down, X(2860)), lane_at(up, X(2860))
    turn_e = u_turn(down[ie_d], up[ie_u], np.array([X(2905.0), (down[ie_d][1] + up[ie_u][1]) / 2 + 30]), True)
    iw_u, iw_d = lane_at(up, X(900)), lane_at(down, X(900))
    turn_w = u_turn(up[iw_u], down[iw_d], np.array([X(860.0), (up[iw_u][1] + down[iw_d][1]) / 2]), True)
    for name, p in (("up", up), ("down", down), ("turn_e", turn_e), ("turn_w", turn_w)):
        cl = clear[np.clip(p[:, 1].astype(int), 0, D - 1), np.clip(p[:, 0].astype(int), 0, W - 1)]
        print(f"fairway {name}: {len(p)} points, closest to a bank {cl.min():.0f} m, {int((cl == 0).sum())} on land")
r2 = lambda p: [[round(float(x), 1), round(float(y), 1)] for x, y in p]

boats = {"berths": berths, "tour": r2(pts)}
if berths and tour_ok:
    boats["fairway"] = {"up": r2(up), "down": r2(down), "turnE": [ie_d, ie_u, r2(turn_e)], "turnW": [iw_u, iw_d, r2(turn_w)]}
json.dump(boats, open(OUT / "boats.json", "w"), separators=(",", ":"))
print("wrote", OUT / "boats.json")
